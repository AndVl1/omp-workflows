import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createWorkflowSessionController, registerTeamWorkflow } from "../src/index.js";
import { dispatchGate } from "../src/gates/dispatch.js";
import type { RoleConfig, TeamState, TrustedExecutionContext } from "../src/engine/types.js";
import type { WorkflowSessionController } from "../src/engine/host-controller.js";

const genericRoles: RoleConfig["roles"] = { worker: "worker" };
const RUN_ID = "11111111-1111-4111-8111-111111111111";

function minimalState(): TeamState {
  return {
    schema: 2,
    run_id: RUN_ID,
    run_key: RUN_ID,
    lifecycle_status: "active",
    title: "gate regression",
    branch: "feature/gates",
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    task: "gate regression",
    issue: null,
    workflow_override: false,
    stage_cursor: "implementation",
    stages: [{ id: "implementation", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    updated_at: new Date(0).toISOString(),
  };
}

function writeCanonicalState(root: string, state: TeamState): void {
  const runDir = join(root, ".work-state", "runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
}

function trustedContext(root: string): TrustedExecutionContext {
  return {
    session_id: "gate-regression-session",
    caller: "host",
    process_id: process.pid,
    worktree: root,
    branch: "feature/gates",
    authority: "coordinator",
  };
}

function registerGate(
  root: string,
  selected = true,
  existingController?: WorkflowSessionController,
): (event: unknown, ctx: unknown) => unknown {
  const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const pi = {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (name === "tool_call") handlers.push(handler);
    },
  };
  const controller = existingController ?? (selected
    ? createWorkflowSessionController({ cwd: root, context: trustedContext(root) })
    : undefined);
  if (controller) {
    if (!existingController) {
      const prepared = controller.prepare({ mode: "resume", run_id: RUN_ID });
      assert.equal(prepared.state.run_id, RUN_ID);
    }
    assert.equal(controller.activeClaimRunId(), RUN_ID);
  }
  registerTeamWorkflow(pi as never, {
    roles: genericRoles,
    ...(controller ? { getSessionController: () => controller } : {}),
  });
  return handlers[0]!;
}

test("history without a selected run ignores forged namespace identifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-gate-history-"));
  try {
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify(minimalState()));
    const handler = registerGate(root, false);
    const result = handler(
      { toolName: "task", input: { task: "ordinary task" } },
      {
        cwd: root,
        run_id: "not-a-canonical-run-id",
        cto_run_id: "foreign-cto-run",
        cto_ownership_epoch: "forged-epoch",
      },
    );
    assert.equal(result, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected canonical run rejects malformed classification before dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-gate-malformed-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "feature/gates"], { stdio: "ignore" });
    writeCanonicalState(root, minimalState());
    const controller = createWorkflowSessionController({ cwd: root, context: trustedContext(root) });
    const prepared = controller.prepare({ mode: "resume", run_id: RUN_ID });
    assert.equal(prepared.state.run_id, RUN_ID);
    assert.equal(controller.activeClaimRunId(), RUN_ID);
    const armed = {
      ...prepared.state,
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false },
    } as TeamState;
    writeCanonicalState(root, armed);
    const handler = registerGate(root, true, controller);
    const result = handler({ toolName: "task", input: { task: "prompt-only" } }, { cwd: root }) as { block?: boolean; reason?: string } | undefined;
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /malformed classification|workflow/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("explicit corrupt or missing canonical markers fail closed while no marker stays compatible", () => {
  const markerFor = (run: string) => `<!-- omp-dispatch run=${run} stage=implementation kind=single cursor=epoch roles=worker -->`;

  const corruptRoot = mkdtempSync(join(tmpdir(), "omp-gate-corrupt-marker-"));
  try {
    const runDir = join(corruptRoot, ".work-state", "runs", RUN_ID);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "state.json"), "{not json");
    const blocked = dispatchGate({ toolName: "task", input: { task: markerFor(RUN_ID) } }, { cwd: corruptRoot });
    assert.equal(blocked?.block, true, "an explicit corrupt canonical marker must fail closed");
    assert.match(blocked?.reason ?? "", /workflow state path is invalid/);
  } finally {
    rmSync(corruptRoot, { recursive: true, force: true });
  }

  const missingRoot = mkdtempSync(join(tmpdir(), "omp-gate-missing-marker-"));
  try {
    const blocked = dispatchGate({ toolName: "task", input: { task: markerFor("22222222-2222-4222-8222-222222222222") } }, { cwd: missingRoot });
    assert.equal(blocked?.block, true, "an explicit marker for a missing canonical run must fail closed");
    assert.match(blocked?.reason ?? "", /workflow state is unavailable/);
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }

  const absentRoot = mkdtempSync(join(tmpdir(), "omp-gate-absent-marker-"));
  try {
    const allowed = dispatchGate({ toolName: "task", input: { task: "ordinary task" } }, { cwd: absentRoot });
    assert.equal(allowed, undefined, "a task without a canonical marker keeps the compatibility behavior");
  } finally {
    rmSync(absentRoot, { recursive: true, force: true });
  }
});


test("an explicit old-run marker rejects a branch-mismatched state without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-gate-branch-mismatch-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "branch-a"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "checkout", "--quiet", "-b", "branch-b"], { stdio: "ignore" });
    writeCanonicalState(root, { ...minimalState(), branch: "branch-a" });
    const runsDir = join(root, ".work-state", "runs");
    const statePath = join(runsDir, RUN_ID, "state.json");
    const beforeState = readFileSync(statePath, "utf8");
    const beforeRuns = readdirSync(runsDir);
    const marker = `<!-- omp-dispatch run=${RUN_ID} stage=implementation kind=single cursor=epoch roles=worker -->`;

    const blocked = dispatchGate({ toolName: "task", input: { task: marker } }, { cwd: root });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /branch \x27branch-a\x27 does not match active branch \x27branch-b\x27/);
    assert.equal(readFileSync(statePath, "utf8"), beforeState, "the old branch state remains byte-identical");
    assert.deepEqual(readdirSync(runsDir), beforeRuns, "no current-branch run is created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
