import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { run } from "../src/engine/run.js";
import { writeState } from "../src/engine/state.js";
import type { Profile, TaskType, TeamState } from "../src/engine/types.js";
import type { TaskCaller, TaskResult } from "../src/engine/stage.js";
import { qualifiedRoster, workIdentityFixture, workIdentityScopeFixture, workflowV2Fixture } from "./workflow-v2-fixtures.js";

const PROFILE_NAME = "run-continuation-regression";

const profile: Profile = {
  name: PROFILE_NAME,
  title: "Continuation regression",
  description: "Minimal profile for run continuation tests",
  match: { type: ["FEATURE"] },
  stages: [
    { id: "upstream", title: "Upstream", type: "single", role: "worker" },
    { id: "reopened", title: "Reopened", type: "single", role: "worker", consumes: ["upstream"] },
    { id: "downstream", title: "Downstream", type: "single", role: "worker" },
  ],
};

const fixture = workflowV2Fixture(profile, { agentNames: ["worker"] });
function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function taskResult(id: string): TaskResult {
  return { id, output: "ok", artifacts: {}, exitCode: 0 };
}

function fixtureState(branch: string, statuses: TeamState["stages"][number]["status"][]): TeamState {
  const work_identity = workIdentityFixture(fixture, {
    workflow: PROFILE_NAME,
    stage_id: "reopened",
    slot_id: "worker",
    task_id: "reopened-worker",
  });
  const dispatch_capability = {
    capability_id: work_identity.capability_id,
    dispatch_token_hash: "a".repeat(64),
    advance_token_hash: "b".repeat(64),
    issued_for: {
      run_key: branch,
      branch,
      workflow: PROFILE_NAME,
      profile_hash: fixture.profile_identity.fingerprint,
      stage_cursor: work_identity.stage_cursor,
      cursor_epoch: work_identity.capability_epoch,
      project_identity: fixture.project_identity,
      run_identity: fixture.run_identity,
    },
    kind: "single" as const,
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    expected_roles: ["worker"],
    expected_count: 1,
    expected_roster: qualifiedRoster(fixture, [{ role: "worker", agent: "worker" }]),
    work_identity,
    status: "complete" as const,
    dispatches: [],
  } satisfies NonNullable<TeamState["dispatch_capability"]>;
  return {
    schema: 1,
    branch,
    run_key: branch,
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    profile_hash: fixture.profile_identity.fingerprint,
    cursor_epoch: work_identity.capability_epoch,
    work_identity,
    dispatch_capability,
    classification: {
      type: "FEATURE",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: false,
      workflow: PROFILE_NAME,
    },
    workflow: PROFILE_NAME,
    task: "Original task",
    history: [{ task: "Earlier task", feedback: "Earlier feedback", at: "2026-01-01T00:00:00.000Z" }],
    workflow_override: true,
    issue: null,
    stage_cursor: "reopened",
    stages: profile.stages.map((stage, index) => ({ id: stage.id, status: statuses[index]! })),
    artifacts: { upstream: "artifacts/upstream.json", preserved: "artifacts/preserved.json" },
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null },
    policy: { strict_orchestrator: true },
    pause: { kind: "user_checkpoint", reason: "waiting for feedback" },
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}
function options(root: string, branch: string, taskTool: TaskCaller, continuation?: { feedback: string; stageId: string }) {
  const initialStage = continuation?.stageId ?? profile.stages[0]?.id;
  if (!initialStage) throw new Error("continuation fixture profile must have an initial stage");
  return {
    task: "New conflicting task classification",
    cwd: root,
    branch,
    autonomous: true,
    classification: {
      type: "BUG_FIX" as TaskType,
      complexity: "COMPLEX" as const,
      confidence: "LOW" as const,
      autonomous: true,
      workflow: "debug-cycle" as const,
    },
    taskTool,
    continuation,
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    catalog: fixture.catalog,
    effective_policy: fixture.effective_policy,
    agent_inventory: fixture.agent_inventory,
    work_identity_scope: workIdentityScopeFixture(fixture, {
      workflow: PROFILE_NAME,
      stage_id: initialStage,
      slot_id: "worker",
    }),
  };
}

test("run continuation rejects stale branch before task calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-stale-"));
  try {
    writeState(root, fixtureState("feature/original", ["done", "done", "done"]));
    let calls = 0;
    const taskTool: TaskCaller = {
      async call() { calls += 1; return taskResult("call"); },
      async batch() { calls += 1; return [taskResult("batch")]; },
    };

    await assert.rejects(
      run(options(root, "feature/other", taskTool, { feedback: "Please revisit it", stageId: "reopened" })),
      /cannot continue workflow: no non-stale state for branch feature\/other/,
    );
    assert.equal(calls, 0, "stale continuation must reject before task.call or batch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run continuation preserves persisted classification, upstream state, artifacts, and history", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-valid-"));
  const branch = "feature/continuation";
  try {
    initGit(root, branch);
    const persisted = fixtureState(branch, ["done", "done", "done"]);
    const persistedStatePath = writeState(root, persisted).statePath;
    const generatedIdentities: NonNullable<TeamState["work_identity"]>[] = [];
    const calls: string[] = [];
    const taskTool: TaskCaller = {
      async call(args) {
        const current = JSON.parse(readFileSync(persistedStatePath, "utf8")) as TeamState;
        assert.ok(current.work_identity);
        generatedIdentities.push(current.work_identity);
        calls.push(args.task.match(/## Stage: ([^ ]+)/)?.[1] ?? "unknown");
        return taskResult(`call-${calls.length}`);
      },
      async batch(args) {
        const current = JSON.parse(readFileSync(persistedStatePath, "utf8")) as TeamState;
        assert.ok(current.work_identity);
        generatedIdentities.push(current.work_identity);
        calls.push(...args.tasks.map(() => "batch"));
        return args.tasks.map((_, index) => taskResult(`batch-${index}`));
      },
    };

    const result = await run(options(root, branch, taskTool, {
      feedback: "Rework the reopened stage",
      stageId: "reopened",
    }));

    assert.deepEqual(result.classification, {
      type: "FEATURE",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: false,
      workflow: PROFILE_NAME,
    }, "continuation must use persisted classification over new input");
    assert.equal(result.profile.name, PROFILE_NAME, "continuation must use persisted profile");
    assert.deepEqual(calls, ["reopened", "downstream"], "only reopened and downstream stages run");
    assert.equal(generatedIdentities.length, 2, "each resumed stage must be armed with a generated work identity");
    const persistedIdentity = persisted.work_identity;
    assert.ok(persistedIdentity);
    const [reopenedIdentity, downstreamIdentity] = generatedIdentities;
    assert.ok(reopenedIdentity);
    assert.ok(downstreamIdentity);
    for (const identity of [reopenedIdentity, downstreamIdentity]) {
      assert.equal(identity.run_id, fixture.run_identity.run_id);
      assert.equal(identity.session_id, fixture.project_identity.session.session_id);
      assert.equal(identity.workflow, PROFILE_NAME);
    }
    assert.equal(reopenedIdentity.stage_id, "reopened");
    assert.equal(reopenedIdentity.stage_cursor, "reopened");
    assert.notEqual(reopenedIdentity.capability_id, persistedIdentity.capability_id);
    assert.notEqual(reopenedIdentity.capability_epoch, persistedIdentity.capability_epoch);
    assert.equal(downstreamIdentity.stage_id, "downstream");
    assert.equal(downstreamIdentity.stage_cursor, "downstream");
    assert.notEqual(downstreamIdentity.capability_id, reopenedIdentity.capability_id);
    assert.notEqual(downstreamIdentity.capability_epoch, reopenedIdentity.capability_epoch);

    const statePath = result.statePath!;
    const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    assert.ok(state.work_identity);
    assert.equal(state.work_identity.stage_id, "downstream");
    assert.equal(state.work_identity.stage_cursor, "downstream");
    assert.equal(state.work_identity.capability_id, downstreamIdentity.capability_id);
    assert.equal(state.work_identity.capability_epoch, downstreamIdentity.capability_epoch);
    assert.equal(state.work_identity.run_id, fixture.run_identity.run_id);
    assert.equal(state.work_identity.session_id, fixture.project_identity.session.session_id);
    assert.equal(state.work_identity.workflow, PROFILE_NAME);
    assert.deepEqual(state.stages, [
      { id: "upstream", status: "done" },
      { id: "reopened", status: "done" },
      { id: "downstream", status: "done" },
    ]);
    assert.deepEqual(state.artifacts, fixtureState(branch, ["done", "done", "done"]).artifacts);
    assert.equal(state.history?.length, 2);
    assert.equal(state.history?.[1]?.feedback, "Rework the reopened stage");
    assert.match(state.task, /User feedback: Rework the reopened stage/);
    assert.equal(state.dispatch_capability?.status, "complete", "successful continuation must durably join and advance every stage");
    assert.doesNotMatch(readFileSync(statePath, "utf8"), /"(?:dispatch_token|advance_token)"\s*:/, "plaintext handoff secrets must never be persisted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run continuation keeps explicit custom feature state and artifacts layout", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-custom-"));
  const branch = "feature/x";
  try {
    initGit(root, branch);
    const customDir = join(root, ".work-state", "features", "custom");
    mkdirSync(join(customDir, "artifacts"), { recursive: true });
    writeFileSync(join(root, ".work-state", ".active-feature"), "custom\n");
    writeFileSync(join(customDir, "artifacts", "upstream.json"), JSON.stringify({ source: "custom" }));
    writeState(root, fixtureState(branch, ["done", "done", "done"]), { featureSlug: "custom" });
    writeFileSync(join(customDir, "artifacts", "upstream.json"), JSON.stringify({ source: "custom" }));
    const prompts: string[] = [];
    const taskTool: TaskCaller = {
      async call(args) { prompts.push(args.task); return taskResult("call"); },
      async batch(args) { prompts.push(...args.tasks.map((task) => task.task)); return args.tasks.map(() => taskResult("batch")); },
    };
    const result = await run(options(root, branch, taskTool, { feedback: "custom feedback", stageId: "reopened" }));
    assert.equal(result.statePath, join(customDir, "state.json"));
    assert.ok(prompts.some((prompt) => prompt.includes('"source": "custom"')));
    const state = JSON.parse(readFileSync(result.statePath!, "utf8")) as TeamState;
    assert.equal(state.pause.kind, "done");
    assert.match(state.task, /custom feedback/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run continuation rejects legacy root state before task calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-run-legacy-"));
  const branch = "feature/x";
  try {
    initGit(root, branch);
    const state = fixtureState(branch, ["done", "done", "done"]);
    const legacyDir = join(root, ".work-state");
    mkdirSync(join(legacyDir, "artifacts"), { recursive: true });
    writeFileSync(join(legacyDir, "team-state.json"), JSON.stringify(state));
    writeFileSync(join(legacyDir, "artifacts", "upstream.json"), JSON.stringify({ source: "legacy" }));
    const persisted = readFileSync(join(legacyDir, "team-state.json"), "utf8");
    let calls = 0;
    const taskTool: TaskCaller = {
      async call() { calls += 1; return taskResult("call"); },
      async batch() { calls += 1; return [taskResult("batch")]; },
    };
    await assert.rejects(
      run(options(root, branch, taskTool, { feedback: "legacy feedback", stageId: "reopened" })),
      /MIGRATION_REQUIRED: workflow state cannot be used by this lifecycle/,
    );
    assert.equal(calls, 0, "legacy state must reject before task.call or batch");
    assert.equal(readFileSync(join(legacyDir, "team-state.json"), "utf8"), persisted);
    assert.equal(existsSync(join(root, ".work-state", "features", "feature-x", "state.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
