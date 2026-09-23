import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createWorkflowSessionController } from "../src/engine/host-controller.js";
import { LifecycleError } from "../src/engine/run-lifecycle.js";
import { run, prepareWorkflowState } from "../src/engine/run.js";
import { listRuns, readRunControl, runTarget, updateCanonicalRun } from "../src/engine/run-store.js";
import { discoverLegacySources } from "../src/engine/run-migration.js";
import { buildAgentMapping, writeAgentMapping } from "../src/engine/agent-mapping.js";
import { resolveConfig } from "../src/engine/config.js";
import { beginCapability as rawBeginCapability } from "../src/engine/durable.js";
import { resolveWorkflowContract, WorkflowContractError } from "../src/engine/workflow-contract.js";
import { registerWorkflowProfiles } from "../src/engine/profile.js";
import type { Profile, TaskType, TeamState, TrustedExecutionContext } from "../src/engine/types.js";
import type { TaskCaller, TaskResult } from "../src/engine/stage.js";


const PROFILE_NAME = "run-lifecycle-regression";
const BRANCH = "feature/run-lifecycle";
const CLASSIFICATION = {
  type: "FEATURE" as const,
  complexity: "QUICK" as const,
  confidence: "HIGH" as const,
  autonomous: false,
  workflow: PROFILE_NAME,
};

const profile: Profile = {
  name: PROFILE_NAME,
  title: "Lifecycle regression",
  description: "Minimal canonical profile for new/resume/rework tests",
  match: { type: ["FEATURE"] },
  stages: [
    { id: "upstream", title: "Upstream", type: "single", role: "worker" },
    { id: "reopened", title: "Reopened", type: "single", role: "worker", consumes: ["upstream"], produces: ["reopened"] },
    { id: "downstream", title: "Downstream", type: "single", role: "worker", consumes: ["reopened"], produces: ["downstream"] },
  ],
};

registerWorkflowProfiles([profile]);

function initGit(root: string, branch = BRANCH): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function publishLifecycleMapping(root: string): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), JSON.stringify({ roles: { worker: "worker" } }) + "\n");
  const config = resolveConfig(root);
  writeAgentMapping(root, buildAgentMapping({
    roles: config.roles,
    availableAgents: ["worker"],
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    genericFallbackRoles: ["worker"],
  }));
}

function trustedContext(root: string, branch = BRANCH, sessionId = "run-lifecycle-session"): TrustedExecutionContext {
  return {
    session_id: sessionId,
    caller: "host",
    process_id: process.pid,
    worktree: root,
    branch,
    authority: "coordinator",
  };
}

function taskResult(id: string, stage: string): TaskResult {
  const artifacts: Record<string, string> = {};
  if (stage === "reopened" || stage === "downstream") {
    artifacts[stage] = JSON.stringify({ stage, result: "new" });
  }
  return { id, output: `${stage} completed`, artifacts, exitCode: 0 };
}

function taskTool(
  calls: string[],
  requests: Array<{ agent: string; task: string }> = [],
  onCall?: (stage: string) => void,
): TaskCaller {
  return {
    async call(args) {
      const stage = args.task.match(/## Stage: ([^\s]+)/)?.[1] ?? "unknown";
      calls.push(stage);
      requests.push({ agent: args.agent, task: args.task });
      onCall?.(stage);
      return taskResult(`call-${calls.length}`, stage);
    },
    async batch(args) {
      const stages = args.tasks.map((task) => task.task.match(/## Stage: ([^\s]+)/)?.[1] ?? "unknown");
      calls.push(...stages);
      requests.push(...args.tasks.map((task) => ({ agent: task.agent, task: task.task })));
      for (const stage of stages) onCall?.(stage);
      return stages.map((stage, index) => taskResult(`batch-${index}`, stage));
    },
  };
}

function prepareNew(root: string, task = "Original task", sessionId = "run-lifecycle-session") {
  const context = trustedContext(root, BRANCH, sessionId);
  const controller = createWorkflowSessionController({ cwd: root, context });
  const prepared = controller.prepare({ mode: "new", task, classification: CLASSIFICATION });
  assert.ok(prepared.state.run_id, "new lifecycle transition must issue a canonical run id");
  assert.equal(prepared.state.run_key, prepared.state.run_id);
  assert.equal(controller.selectedRunId(), prepared.state.run_id, "trusted controller selects the newly committed run");
  return { context, controller, prepared, runId: prepared.state.run_id };
}

function seedResumableState(root: string, runId: string): void {
  const target = runTarget(root, runId);
  assert.ok(target.artifactsDir);
  mkdirSync(target.artifactsDir, { recursive: true });
  writeFileSync(join(target.artifactsDir, "upstream.json"), JSON.stringify({ source: "upstream", decision: "preserve" }));
  writeFileSync(join(target.artifactsDir, "preserved.json"), JSON.stringify({ source: "prior-result" }));
  updateCanonicalRun(root, runId, (state) => ({
    ...state,
    stage_cursor: "reopened",
    stages: profile.stages.map((stage) => ({
      id: stage.id,
      status: stage.id === "upstream" ? "done" as const : "pending" as const,
    })),
    artifacts: {
      upstream: "artifacts/upstream.json",
      preserved: "artifacts/preserved.json",
      reopened: "artifacts/reopened.json",
      downstream: "artifacts/downstream.json",
    },
    required_inputs: {
      ...(state.required_inputs ?? {}),
      reopened: [{ artifact_id: "upstream", path: "upstream.json" }],
    },
    required_input_receipts: {},
    lifecycle_status: "active",
    pause: { kind: "none", reason: "" },
  }));
}

function seedCompletedState(root: string, runId: string): void {
  const target = runTarget(root, runId);
  assert.ok(target.artifactsDir);
  mkdirSync(target.artifactsDir, { recursive: true });
  for (const id of ["upstream", "reopened", "downstream", "preserved"]) {
    writeFileSync(join(target.artifactsDir, `${id}.json`), JSON.stringify({ source: "previous", id }));
  }
  updateCanonicalRun(root, runId, (state) => ({
    ...state,
    stage_cursor: "downstream",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: "done" as const })),
    artifacts: {
      upstream: "artifacts/upstream.json",
      reopened: "artifacts/reopened.json",
      downstream: "artifacts/downstream.json",
      preserved: "artifacts/preserved.json",
    },
    required_inputs: {
      ...(state.required_inputs ?? {}),
      reopened: [{ artifact_id: "upstream", path: "upstream.json" }],
      downstream: [{ artifact_id: "reopened", path: "reopened.json" }],
    },
    required_input_receipts: {},
    lifecycle_status: "complete",
    pause: { kind: "done", reason: "" },
  }));
}

function writeLegacySource(
  root: string,
  source: { kind: "root" } | { kind: "feature"; slug: string },
  task: string,
  artifactName: string,
): void {
  const stateDir = source.kind === "root"
    ? join(root, ".work-state")
    : join(root, ".work-state", "features", source.slug);
  const artifactsDir = join(stateDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, artifactName), JSON.stringify({ task, preserved: true }));
  writeFileSync(join(stateDir, source.kind === "root" ? "team-state.json" : "state.json"), JSON.stringify({
    schema: 1,
    branch: BRANCH,
    run_key: `${BRANCH}:${source.kind === "root" ? "root" : source.slug}`,
    classification: CLASSIFICATION,
    task,
    stage_cursor: "upstream",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "upstream" ? "done" : "pending" })),
    artifacts: { history: `artifacts/${artifactName}` },
    scope: { scope: ["worker"], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "worker" },
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
  }));
}

function migrationReceipts(root: string): Array<Record<string, unknown>> {
  const runsDir = join(root, ".work-state", "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const receiptPath = join(runsDir, entry.name, "migration-receipt.json");
    if (!existsSync(receiptPath)) return [];
    return [JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>];
  });
}

test("prepareWorkflowState rejects an omitted trusted execution context before canonical mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-prepare-missing-execution-"));
  try {
    initGit(root);
    publishLifecycleMapping(root);
    assert.throws(
      () => prepareWorkflowState({
        task: "missing execution context",
        cwd: root,
        branch: BRANCH,
        autonomous: false,
        classification: CLASSIFICATION,
        files: [],
        issue: null,
        mode: "new",
        request_id: "missing-execution-prepare",
      } as never),
      (error: unknown) => error instanceof LifecycleError && error.code === "lifecycle_request_conflict",
    );
    assert.deepEqual(listRuns(root, { branch: BRANCH }), []);
    assert.equal(readRunControl(root).execution_claim, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run rejects an omitted trusted execution context before canonical mutation or task dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-missing-execution-"));
  try {
    initGit(root);
    publishLifecycleMapping(root);
    const calls: string[] = [];
    await assert.rejects(
      run({
        task: "missing execution context",
        cwd: root,
        branch: BRANCH,
        autonomous: false,
        classification: CLASSIFICATION,
        taskTool: taskTool(calls),
        mode: "new",
        request_id: "missing-execution-run",
      } as never),
      (error: unknown) => error instanceof LifecycleError && error.code === "lifecycle_request_conflict",
    );
    assert.deepEqual(calls, [], "missing trusted execution context must reject before task.call or batch");
    assert.deepEqual(listRuns(root, { branch: BRANCH }), []);
    assert.equal(readRunControl(root).execution_claim, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run resume rejects a selected run from the wrong branch before task calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-resume-context-"));
  try {
    initGit(root, BRANCH);
    const original = prepareNew(root, "Original task", "original-session");
    original.controller.release("test-release-before-branch-switch");
    execFileSync("git", ["-C", root, "checkout", "--quiet", "-b", "feature/other"], { stdio: "ignore" });
    const calls: string[] = [];

    await assert.rejects(
      run({
        task: "conflicting task must not replace the selected run",
        cwd: root,
        branch: "feature/other",
        autonomous: true,
        classification: { type: "BUG_FIX" as TaskType, complexity: "COMPLEX", confidence: "LOW", autonomous: true, workflow: "debug-cycle" },
        taskTool: taskTool(calls),
        mode: "resume",
        run_id: original.runId,
        request_id: "resume-wrong-branch",
        execution: trustedContext(root, "feature/other", "other-session"),
      }),
      (error: unknown) => error instanceof LifecycleError && error.code === "run_context_mismatch",
    );
    assert.deepEqual(calls, [], "wrong-branch resume must reject before task.call or batch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run resume preserves canonical classification, upstream inputs, and completed stage identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-resume-canonical-"));
  try {
    initGit(root);
    publishLifecycleMapping(root);
    const seeded = prepareNew(root, "Original task", "resume-session");
    seedResumableState(root, seeded.runId);
    const calls: string[] = [];
    const requests: Array<{ agent: string; task: string }> = [];

    const result = await run({
      task: "New conflicting task classification",
      cwd: root,
      branch: BRANCH,
      autonomous: true,
      classification: { type: "BUG_FIX", complexity: "COMPLEX", confidence: "LOW", autonomous: true, workflow: "debug-cycle" },
      taskTool: taskTool(calls, requests),
      mode: "resume",
      run_id: seeded.runId,
      request_id: "resume-canonical",
      execution: seeded.context,
    });

    assert.deepEqual(result.classification, CLASSIFICATION, "resume must use persisted classification over new input");
    assert.equal(result.profile.name, PROFILE_NAME, "resume must use the persisted profile");
    assert.deepEqual(
      calls,
      ["reopened", "downstream"],
      `resume dispatch diagnostic: ${JSON.stringify({
        calls,
        outcomes: result.outcomes,
        state: (() => {
          const current = JSON.parse(readFileSync(result.statePath!, "utf8")) as TeamState;
          return {
            stage_cursor: current.stage_cursor,
            stages: current.stages,
            artifacts: current.artifacts,
            required_inputs: current.required_inputs,
            required_input_receipts: current.required_input_receipts,
            lifecycle_status: current.lifecycle_status,
            pause: current.pause,
          };
        })(),
        requests: requests.map(({ agent, task }) => ({ agent, stage: task.match(/## Stage: ([^\s]+)/)?.[1] ?? "unknown", task_length: task.length })),
      })}`,
    );
    assert.equal(result.statePath, runTarget(root, seeded.runId).statePath);

    const state = JSON.parse(readFileSync(result.statePath!, "utf8")) as TeamState;
    assert.equal(state.schema, 2);
    assert.equal(state.run_id, seeded.runId);
    assert.equal(state.run_key, seeded.runId);
    assert.deepEqual(state.stages, profile.stages.map((stage) => ({ id: stage.id, status: "done" })));
    assert.equal(state.required_input_receipts?.reopened?.inputs?.[0]?.artifact_id, "upstream", `resume records real required-input evidence: ${JSON.stringify(state.required_input_receipts)}`);
    assert.equal(JSON.parse(readFileSync(join(runTarget(root, seeded.runId).artifactsDir!, "upstream.json"), "utf8")).decision, "preserve");
    assert.equal(state.lifecycle_status, "complete");
    assert.doesNotMatch(readFileSync(result.statePath!, "utf8"), /"(?:dispatch_token|advance_token)"\s*:/, "handoff secrets are not persisted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run rework snapshots the previous result and reruns only the affected stage and downstream work", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-rework-canonical-"));
  try {
    initGit(root);
    publishLifecycleMapping(root);
    const seeded = prepareNew(root, "Original task", "rework-session");
    seedCompletedState(root, seeded.runId);
    const preRunState = JSON.parse(readFileSync(runTarget(root, seeded.runId).statePath!, "utf8")) as TeamState;
    assert.equal(preRunState.run_id, seeded.runId);
    assert.equal(preRunState.stage_cursor, "downstream");
    assert.equal(preRunState.stages.find((stage) => stage.id === "upstream")?.status, "done");
    assert.equal(preRunState.artifacts?.upstream, "artifacts/upstream.json");
    assert.deepEqual(
      JSON.parse(readFileSync(join(runTarget(root, seeded.runId).artifactsDir!, "upstream.json"), "utf8")),
      { source: "previous", id: "upstream" },
    );
    let firstTaskCallState: TeamState | undefined;
    const summarizeState = (state: TeamState | undefined) => state
      ? {
          run_id: state.run_id,
          stage_cursor: state.stage_cursor,
          stages: state.stages,
          artifacts: state.artifacts,
          required_inputs: state.required_inputs,
          required_input_receipts: state.required_input_receipts,
          lifecycle_status: state.lifecycle_status,
          pause: state.pause,
        }
      : null;
    const captureFirstTaskCall = () => {
      if (!firstTaskCallState) firstTaskCallState = JSON.parse(readFileSync(runTarget(root, seeded.runId).statePath!, "utf8")) as TeamState;
    };
    const calls: string[] = [];
    const requests: Array<{ agent: string; task: string }> = [];

    const result = await run({
      task: "ignored for explicit rework",
      cwd: root,
      branch: BRANCH,
      autonomous: true,
      classification: { type: "BUG_FIX", complexity: "COMPLEX", confidence: "LOW", autonomous: true, workflow: "debug-cycle" },
      taskTool: taskTool(calls, requests, captureFirstTaskCall),
      mode: "rework",
      run_id: seeded.runId,
      request_id: "rework-canonical",
      feedback: "Fix the reopened implementation result",
      affected_stage: "reopened",
      execution: seeded.context,
    });

    assert.deepEqual(result.classification, CLASSIFICATION, "rework keeps the canonical classification");
    assert.deepEqual(
      calls,
      ["reopened", "downstream"],
      `rework dispatch diagnostic: ${JSON.stringify({
        calls,
        outcomes: result.outcomes,
        pre_run_state: summarizeState(preRunState),
        first_task_call_state: summarizeState(firstTaskCallState),
        state: summarizeState(JSON.parse(readFileSync(result.statePath!, "utf8")) as TeamState),
        requests: requests.map(({ agent, task }) => ({ agent, stage: task.match(/## Stage: ([^\s]+)/)?.[1] ?? "unknown", task_length: task.length })),
      })}`,
    );
    const state = JSON.parse(readFileSync(result.statePath!, "utf8")) as TeamState;
    assert.equal(state.run_id, seeded.runId);
    assert.equal(state.rework_generation, 1);
    assert.equal(state.history?.at(-1)?.feedback, "Fix the reopened implementation result");
    assert.match(state.task, /User feedback: Fix the reopened implementation result/);
    assert.equal(state.lifecycle_status, "complete");
    const artifactsDir = runTarget(root, seeded.runId).artifactsDir!;
    assert.deepEqual(
      JSON.parse(readFileSync(join(artifactsDir, "reopened.json"), "utf8")),
      { stage: "reopened", result: "new" },
      "rework task output is persisted under the canonical run artifact directory",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(artifactsDir, "downstream.json"), "utf8")),
      { stage: "downstream", result: "new" },
      "downstream task output is persisted under the same canonical run artifact directory",
    );

    const revisionsDir = join(runTarget(root, seeded.runId).stateDir!, "revisions");
    const revisionEntry = readdirSync(revisionsDir, { withFileTypes: true }).find((entry) => entry.isDirectory());
    assert.ok(revisionEntry, "rework must preserve an immutable revision");
    const revision = join(revisionsDir, revisionEntry!.name);
    assert.ok(revision, "rework must preserve an immutable revision");
    const manifest = JSON.parse(readFileSync(join(revision, "manifest.json"), "utf8")) as { run_id?: string; artifact_sha256?: Record<string, string> };
    assert.equal(manifest.run_id, seeded.runId);
    assert.ok(manifest.artifact_sha256?.["upstream.json"], "revision manifest preserves upstream evidence");
    assert.ok(manifest.artifact_sha256?.["reopened.json"], "revision manifest preserves the old affected result");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("QA rework invalidates only downstream DoD evidence and rebinds a fresh summary receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-rework-qa-dod-"));
  try {
    initGit(root);
    const workflow = "qa-rework-evidence";
    const qaProfile: Profile = {
      name: workflow,
      title: "QA rework evidence",
      description: "QA shared DoD re-entry regression",
      match: { type: ["FEATURE"] },
      stages: [
        { id: "implementation", title: "Implementation", type: "orchestrator", produces: "implementation" },
        { id: "review", title: "Review", type: "orchestrator", produces: "review" },
        { id: "qa_tests", title: "QA", type: "orchestrator", consumes: ["implementation", "review", "dod"], produces: "qa_tests" },
        { id: "summary", title: "Summary", type: "orchestrator", consumes: ["implementation", "review", "dod"], produces: "summary" },
      ],
    };
    registerWorkflowProfiles([qaProfile]);
    const execution = trustedContext(root, BRANCH, "qa-rework-session");
    const created = prepareWorkflowState({
      task: "QA rework evidence",
      cwd: root,
      branch: BRANCH,
      autonomous: false,
      classification: { ...CLASSIFICATION, workflow },
      files: [],
      issue: null,
      mode: "new",
      request_id: "qa-rework-new",
      execution,
    });
    const runId = created.state.run_id!;
    const target = runTarget(root, runId);
    const artifactsDir = target.artifactsDir!;
    mkdirSync(artifactsDir, { recursive: true });
    const implementation = JSON.stringify({ source: "implementation-v1" });
    const review = JSON.stringify({ source: "review-v1" });
    const dod = JSON.stringify({
      items: [{
        id: "criterion-1",
        criterion: "Shared DoD evidence is current",
        verify_method: "QA mutation",
        status: "pending",
        evidence: "",
      }],
    });
    const implementationHash = createHash("sha256").update(implementation, "utf8").digest("hex");
    const reviewHash = createHash("sha256").update(review, "utf8").digest("hex");
    const dodHash = createHash("sha256").update(dod, "utf8").digest("hex");
    writeFileSync(join(artifactsDir, "implementation.json"), implementation);
    writeFileSync(join(artifactsDir, "review.json"), review);
    writeFileSync(join(artifactsDir, "dod.json"), dod);
    const implementationInput = { artifact_id: "implementation", path: "implementation.json", sha256: implementationHash };
    const reviewInput = { artifact_id: "review", path: "review.json", sha256: reviewHash };
    const dodInput = { artifact_id: "dod", path: "dod.json", sha256: dodHash };
    const summaryInputs = [implementationInput, reviewInput, dodInput];
    updateCanonicalRun(root, runId, (state) => ({
      ...state,
      stage_cursor: "summary",
      stages: qaProfile.stages.map((stage) => ({ id: stage.id, status: "done" as const })),
      lifecycle_status: "complete",
      pause: { kind: "done", reason: "" },
      artifacts: {
        implementation: "artifacts/implementation.json",
        review: "artifacts/review.json",
        dod: "artifacts/dod.json",
        qa_tests: "artifacts/qa_tests.json",
        summary: "artifacts/summary.json",
      },
      required_inputs: {
        implementation: [implementationInput],
        review: [reviewInput],
        qa_tests: summaryInputs,
        summary: summaryInputs,
      },
      required_input_receipts: {
        summary: {
          stage_id: "summary",
          capability_id: "old-capability",
          cursor_epoch: "old-epoch",
          rework_generation: 0,
          read_at: "2026-09-20T00:00:00.000Z",
          inputs: summaryInputs,
        },
      },
    }));

    const reopened = prepareWorkflowState({
      task: "ignored for explicit rework",
      cwd: root,
      branch: BRANCH,
      autonomous: true,
      classification: { type: "BUG_FIX", complexity: "COMPLEX", confidence: "LOW", autonomous: true, workflow: "debug-cycle" },
      mode: "rework",
      run_id: runId,
      request_id: "qa-rework",
      feedback: "QA must refresh shared DoD evidence",
      affected_stage: "qa_tests",
      execution,
    });
    assert.equal(reopened.state.rework_generation, 1);

    const refreshedDod = JSON.stringify({
      items: [{
        id: "criterion-1",
        criterion: "Shared DoD evidence is current",
        verify_method: "QA mutation",
        status: "met",
        evidence: "QA refreshed the criterion",
      }],
    });
    const refreshedDodHash = createHash("sha256").update(refreshedDod, "utf8").digest("hex");
    writeFileSync(join(artifactsDir, "dod.json"), refreshedDod);
    updateCanonicalRun(root, runId, (state) => ({
      ...state,
      stage_cursor: "summary",
      stages: qaProfile.stages.map((stage) => ({ id: stage.id, status: stage.id === "summary" ? "pending" as const : "done" as const })),
    }));

    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ source: "implementation-tampered" }));
    assert.throws(
      () => resolveWorkflowContract(root, { runId, branch: BRANCH }),
      (error: unknown) => error instanceof WorkflowContractError && error.code === "RECOVERY_REQUIRED",
      "mutating a preserved implementation input remains fail-closed",
    );
    writeFileSync(join(artifactsDir, "implementation.json"), implementation);

    const instructions = resolveWorkflowContract(root, { runId, branch: BRANCH });
    assert.equal(instructions.stage.id, "summary");
    assert.equal(instructions.stage.required_input_contents.find((input) => input.artifact_id === "dod")?.sha256, refreshedDodHash);
    const began = rawBeginCapability(root, undefined, { runId });
    assert.equal(began.ok, true, began.ok ? "summary begin reads the refreshed DoD" : began.error);
    if (!began.ok) return;
    const afterBeginInstructions = resolveWorkflowContract(root, { runId, branch: BRANCH });
    assert.equal(afterBeginInstructions.stage.input_read_receipt?.inputs.find((input) => input.artifact_id === "dod")?.sha256, refreshedDodHash);
    assert.equal(afterBeginInstructions.stage.input_read_receipt?.inputs.find((input) => input.artifact_id === "implementation")?.sha256, implementationHash);
    assert.equal(afterBeginInstructions.stage.input_read_receipt?.inputs.find((input) => input.artifact_id === "review")?.sha256, reviewHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy continuation payloads are rejected instead of selecting a branch-scoped state", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-legacy-continuation-"));
  try {
    initGit(root);
    assert.throws(
      () => prepareWorkflowState({
        task: "legacy continuation payload",
        cwd: root,
        branch: BRANCH,
        autonomous: false,
        classification: CLASSIFICATION,
        mode: "new",
        request_id: "legacy-continuation-rejection",
        execution: trustedContext(root),
        continuation: { feedback: "old payload", stageId: "reopened" },
      } as never),
      (error: unknown) => error instanceof LifecycleError && error.code === "migration_required",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare ingress migrates independent root and customslug sources on one branch", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-migration-ingress-both-"));
  try {
    initGit(root);
    writeLegacySource(root, { kind: "root" }, "root historical task", "root-history.json");
    writeLegacySource(root, { kind: "feature", slug: "customslug" }, "customslug historical task", "customslug-history.json");
    assert.deepEqual(
      discoverLegacySources(root).sources.map((source) => source.source_id),
      ["feature:customslug", "legacy"],
    );

    const prepared = prepareWorkflowState({
      task: "new task after legacy import",
      cwd: root,
      branch: BRANCH,
      autonomous: false,
      classification: CLASSIFICATION,
      mode: "new",
      request_id: "migration-ingress-both",
      execution: trustedContext(root),
    });
    const receipts = migrationReceipts(root);
    assert.equal(receipts.length, 2, "each same-branch legacy source gets its own migration mapping");
    const bySource = new Map(receipts.map((receipt) => [String(receipt.source_id), receipt]));
    assert.equal(bySource.size, 2);
    const rootReceipt = bySource.get("legacy");
    const featureReceipt = bySource.get("feature:customslug");
    assert.ok(rootReceipt && featureReceipt);
    assert.notEqual(rootReceipt.run_id, featureReceipt.run_id, "root and customslug histories remain independent runs");
    for (const receipt of [rootReceipt, featureReceipt]) {
      const runId = String(receipt.run_id);
      const state = JSON.parse(readFileSync(runTarget(root, runId).statePath!, "utf8")) as TeamState;
      assert.equal(state.schema, 2);
      assert.equal(state.run_id, runId);
      assert.equal(state.branch, BRANCH);
      assert.ok(state.migration);
    }
    assert.notEqual(prepared.state.run_id, rootReceipt.run_id, "new ingress must not select an imported root run");
    assert.notEqual(prepared.state.run_id, featureReceipt.run_id, "new ingress must not select an imported customslug run");
    assert.match(readFileSync(join(runTarget(root, String(rootReceipt.run_id)).artifactsDir!, "root-history.json"), "utf8"), /root historical task/);
    assert.match(readFileSync(join(runTarget(root, String(featureReceipt.run_id)).artifactsDir!, "customslug-history.json"), "utf8"), /customslug historical task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated new ingress does not duplicate an existing legacy mapping or resume it", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-migration-ingress-repeat-"));
  try {
    initGit(root);
    writeLegacySource(root, { kind: "feature", slug: "customslug" }, "repeatable historical task", "history.json");
    const context = trustedContext(root);
    const controller = createWorkflowSessionController({ cwd: root, context });
    const first = controller.prepare({
      task: "first new task",
      mode: "new",
      autonomous: false,
      classification: CLASSIFICATION,
      request_id: "migration-ingress-first",
      issue: null,
    });
    const firstReceipts = migrationReceipts(root);
    controller.release("first-new-released");
    const second = controller.prepare({
      task: "second new task",
      mode: "new",
      autonomous: false,
      classification: CLASSIFICATION,
      request_id: "migration-ingress-second",
      issue: null,
    });
    const secondReceipts = migrationReceipts(root);
    assert.equal(firstReceipts.length, 1);
    assert.equal(secondReceipts.length, 1, "repeat ingress must not create a second migration receipt");
    assert.equal(secondReceipts[0]?.source_id, "feature:customslug");
    assert.equal(secondReceipts[0]?.run_id, firstReceipts[0]?.run_id);
    assert.notEqual(first.state.run_id, second.state.run_id, "explicit new ingress must create a fresh run, not resume history");
    assert.equal(discoverLegacySources(root).sources.length, 0, "the imported source is no longer an implicit selector");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed legacy ingress cannot bypass migration and create a new run", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-migration-ingress-failure-"));
  try {
    initGit(root);
    const statePath = join(root, ".work-state", "team-state.json");
    mkdirSync(join(root, ".work-state"), { recursive: true });
    const raw = JSON.stringify({ schema: 99, branch: BRANCH, task: "unsupported legacy state" });
    writeFileSync(statePath, raw);
    assert.throws(
      () => prepareWorkflowState({
        task: "must not bypass failed migration",
        cwd: root,
        branch: BRANCH,
        autonomous: false,
        classification: CLASSIFICATION,
        mode: "new",
        request_id: "migration-ingress-failure",
        execution: trustedContext(root),
      }),
      (error: unknown) => error instanceof LifecycleError && error.code === "migration_required",
    );
    assert.equal(readFileSync(statePath, "utf8"), raw, "failed migration leaves the legacy source unchanged");
    assert.equal(existsSync(join(root, ".work-state", "runs")), false, "failed migration cannot publish a new canonical run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
