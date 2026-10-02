/**
 * Validation gate tests (P6).
 *
 * Covers: implementation/review_fixes artifact with full validation
 * (PASS), missing validation_run (REJECT), validation_run: false
 * (REJECT), empty validation_evidence (REJECT), not-ready artifact
 * (REJECT), non-validation-required stage (PASS by default).
 *
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  checkArtifact,
  validationGate,
} from "../src/gates/validation.js";
import { run, type RunResult } from "../src/engine/run.js";
import type { OrchestratorResult, TaskResult } from "../src/engine/stage.js";
import type { Profile, StageDef, TeamState } from "../src/engine/types.js";
import { registerWorkflowProfiles } from "../src/engine/profile.js";
import {
  BRANCH,
  createInterpreterTaskCaller,
  details,
  ordinaryHarness,
  RELIABLE_PROFILE,
  requireTool,
  submission,
  type Harness,
  type InterpreterTaskRequest,
  type WorkerFixture,
} from "./reliable-stage-execution-fixture.js";

type OrchestrateArgs = {
  stage: StageDef;
  prompt: string;
  cwd: string;
  artifactsDir: string;
  state: TeamState;
};
type InterpreterOrchestrate = (harness: Harness, args: OrchestrateArgs) => Promise<OrchestratorResult | void> | OrchestratorResult | void;

function withTempDir(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "omp-val-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

let profileSequence = 0;

function stageProfile(stage: StageDef): Profile {
  return {
    name: `validation-gate-${stage.id}-${profileSequence++}`,
    title: RELIABLE_PROFILE.title,
    description: RELIABLE_PROFILE.description,
    match: RELIABLE_PROFILE.match,
    stages: [stage],
  };
}

async function runRegisteredStage(
  stage: StageDef,
  execute: (harness: Harness, worker: WorkerFixture, request: InterpreterTaskRequest) => Promise<TaskResult>,
  orchestrate?: InterpreterOrchestrate,
): Promise<{ harness: Harness; result: RunResult }> {
  const profile = stageProfile(stage);
  registerWorkflowProfiles([profile]);
  const harness = ordinaryHarness({ workflowProfiles: [profile] });
  try {
    const classification = {
      type: "FEATURE" as const,
      complexity: "QUICK" as const,
      confidence: "HIGH" as const,
      autonomous: false,
      workflow: profile.name,
    };
    const prepared = harness.controller.prepare({
      mode: "new",
      task: "validation gate fixture",
      classification,
      files: [],
      issue: null,
      request_id: `validation-gate-${profileSequence}`,
    });
    const runId = prepared.state.run_id;
    assert.ok(runId, "registered workflow preparation must persist a run identity");
    const taskTool = createInterpreterTaskCaller(harness, (worker, request) => execute(harness, worker, request));
    const execution = harness.controller.context();
    const result = await run({
      cwd: harness.root,
      branch: BRANCH,
      task: "validation gate fixture",
      autonomous: false,
      classification,
      files: [],
      issue: null,
      mode: "resume",
      run_id: runId,
      request_id: `validation-gate-resume-${profileSequence}`,
      execution,
      sessionController: harness.controller,
      taskTool,
      ...(orchestrate ? { orchestrate: (args: OrchestrateArgs) => orchestrate(harness, args) } : {}),
    });
    return { harness, result };
  } catch (error) {
    await harness.close();
    throw error;
  }
}


async function submitWorkerOutput(
  harness: Harness,
  worker: WorkerFixture,
  callId: string,
  outputs: Record<string, unknown>,
): Promise<TaskResult> {
  const result = await requireTool(harness, "workflow_submit_result").execute(
    callId,
    submission(outputs),
    undefined,
    undefined,
    worker.childContext,
  );
  const submitted = details(result.details);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.ok(submitted.receipt && typeof submitted.receipt === "object", "accepted worker output must return its receipt");
  return { id: `${worker.toolCallId}-result`, output: "worker submitted", exitCode: 0 };
}


test("validationGate: PASS when implementation artifact has validation_run=true and non-empty evidence", () => {
  const result = checkArtifact("implementation", {
    ready: "true",
    validation_run: "true",
    validation_evidence: "go build ./...: PASS\ngo test ./...: PASS",
  });
  assert.deepEqual(result, { ok: true });
});

test("validationGate: REJECTS when ready is missing", () => {
  const result = checkArtifact("implementation", {
    validation_run: "true",
    validation_evidence: "go build ./...: PASS",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /ready/);
});

test("validationGate: REJECTS when validation_run is the string 'false' (escape hatch)", () => {
  const result = checkArtifact("implementation", {
    ready: "true",
    validation_run: "false",
    validation_evidence: "Per assignment, orchestrator owns validation",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /validation_run: true/);
});

test("validationGate: REJECTS when validation_evidence is empty", () => {
  const result = checkArtifact("implementation", {
    ready: "true",
    validation_run: "true",
    validation_evidence: "   ",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /validation_evidence/);
});

test("validationGate: REJECTS when validation_evidence is missing entirely", () => {
  const result = checkArtifact("implementation", {
    ready: "true",
    validation_run: "true",
  });
  assert.equal(result.ok, false);
});

test("validationGate: accepts boolean true (not just string 'true')", () => {
  const result = checkArtifact("implementation", {
    ready: true,
    validation_run: true,
    validation_evidence: "build: pass; test: pass",
  });
  assert.deepEqual(result, { ok: true });
});

test("validationGate: non-validation-required stage passes by default", () => {
  const result = checkArtifact("discovery", { anything: "goes" });
  assert.deepEqual(result, { ok: true });
});

test("validationGate: review_fixes is also validation-required", () => {
  const result = checkArtifact("review_fixes", {
    ready: "true",
    validation_run: "true",
    validation_evidence: "go test ./...: PASS",
  });
  assert.deepEqual(result, { ok: true });
});

test("validationGate: file-based — reads from artifactsDir and reports missing", () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const artifactsDir = join(cwd, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    // No file written
    const result = validationGate({ cwd, stageId: "implementation", artifactsDir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not found/);
  } finally {
    cleanup();
  }
});

test("validationGate: file-based — reads the artifact and validates", () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const artifactsDir = join(cwd, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      join(artifactsDir, "implementation.json"),
      JSON.stringify({
        ready: "true",
        validation_run: "true",
        validation_evidence: "go test ./...: ok",
      }),
    );
    const result = validationGate({ cwd, stageId: "implementation", artifactsDir });
    assert.deepEqual(result, { ok: true });
  } finally {
    cleanup();
  }
});

test("validationGate: file-based — malformed JSON is reported", () => {
  const { cwd, cleanup } = withTempDir();
  try {
    const artifactsDir = join(cwd, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "implementation.json"), "{not json");
    const result = validationGate({ cwd, stageId: "implementation", artifactsDir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /not valid JSON/);
  } finally {
    cleanup();
  }
});
test("run: implementation stage with unvalidated registered artifact returns failed", async () => {
  const stage: StageDef = {
    id: "implementation",
    title: "Implementation",
    type: "single",
    role: "dev",
    produces: "implementation",
  };
  const registered = await runRegisteredStage(stage, async (harness, worker) => submitWorkerOutput(
    harness,
    worker,
    "validation-unvalidated-submit",
    {
      implementation: {
        files_touched: ["packages/core/src/engine/stage.ts"],
        ready: "true",
        validation_run: "false",
        validation_note: "Per assignment, orchestrator owns validation",
      },
    },
  ));
  try {
    assert.equal(registered.result.outcomes[0]?.status, "failed");
    assert.match(registered.result.outcomes[0]?.note ?? "", /validation_run: true/);
  } finally {
    await registered.harness.close();
  }
});

test("run: implementation stage with validated registered artifact returns done", async () => {
  const stage: StageDef = {
    id: "implementation",
    title: "Implementation",
    type: "single",
    role: "dev",
    produces: "implementation",
  };
  const registered = await runRegisteredStage(stage, async (harness, worker) => submitWorkerOutput(
    harness,
    worker,
    "validation-valid-submit",
    {
      implementation: {
        files_touched: ["packages/core/src/engine/stage.ts"],
        ready: "true",
        validation_run: "true",
        validation_evidence: "go build ./...: PASS\ngo test ./...: PASS",
      },
    },
  ));
  try {
    assert.equal(registered.result.outcomes[0]?.status, "done");
  } finally {
    await registered.harness.close();
  }
});

test("run: non-validation-required stage (discovery) passes after registered output submission", async () => {
  const stage: StageDef = {
    id: "discovery",
    title: "Discovery",
    type: "single",
    role: "dev",
    produces: "discovery",
  };
  const registered = await runRegisteredStage(stage, async (harness, worker) => submitWorkerOutput(
    harness,
    worker,
    "validation-discovery-submit",
    { discovery: { task: "synthetic", branch: BRANCH } },
  ));
  try {
    assert.equal(registered.result.outcomes[0]?.status, "done");
  } finally {
    await registered.harness.close();
  }
});

test("run: implementation stage without a registered result receipt returns failed", async () => {
  const stage: StageDef = {
    id: "implementation",
    title: "Implementation",
    type: "single",
    role: "dev",
    produces: "implementation",
  };
  const registered = await runRegisteredStage(stage, async (_harness, worker) => ({
    id: `${worker.toolCallId}-result`,
    output: "worker completed without a registered output",
    exitCode: 0,
  }));
  try {
    assert.equal(registered.result.outcomes[0]?.status, "failed");
    assert.match(registered.result.outcomes[0]?.note ?? "", /accepted workflow_submit_result receipt/);
  } finally {
    await registered.harness.close();
  }
});

test("run: orchestrator with declared artifact fails when output is missing", async () => {
  const stage: StageDef = { id: "planning", title: "Planning", type: "orchestrator", produces: "team_plan" };
  const registered = await runRegisteredStage(stage, async (_harness, worker) => ({
    id: `${worker.toolCallId}-result`,
    output: "",
    exitCode: 0,
  }));
  try {
    assert.equal(registered.result.outcomes[0]?.status, "failed");
    assert.match(registered.result.outcomes[0]?.note ?? "", /orchestrate callback is configured/);
  } finally {
    await registered.harness.close();
  }
});

test("run: inline orchestrator with no outputs remains done", async () => {
  const stage: StageDef = { id: "summary", title: "Summary", type: "orchestrator" };
  const registered = await runRegisteredStage(stage, async (_harness, worker) => ({
    id: `${worker.toolCallId}-result`,
    output: "",
    exitCode: 0,
  }));
  try {
    assert.equal(registered.result.outcomes[0]?.status, "done");
  } finally {
    await registered.harness.close();
  }
});

test("run: orchestrator publishes callback outputs before validating them", async () => {
  const stage: StageDef = {
    id: "planning",
    title: "Planning",
    type: "orchestrator",
    produces: "team_plan",
  };
  const registered = await runRegisteredStage(
    stage,
    async (_harness, worker) => ({
      id: `${worker.toolCallId}-result`,
      output: "",
      exitCode: 0,
    }),
    async () => ({
      output: "plan ready",
      outputs: {
        team_plan: {
          teams: [{ team: "team-a", slice: "slice-a", profile: "lightweight" }],
        },
      },
    }),
  );
  try {
    assert.equal(registered.result.outcomes[0]?.status, "done");
    assert.ok(registered.result.statePath);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dirname(registered.result.statePath!), "artifacts", "team_plan.json"), "utf8")),
      { teams: [{ team: "team-a", slice: "slice-a", profile: "lightweight" }] },
    );
  } finally {
    await registered.harness.close();
  }
});



