import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createWorkflowSessionController, registerTeamWorkflow } from "../src/index.js";
import type { RoleConfig, TeamState, TrustedExecutionContext } from "../src/engine/types.js";

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

function registerGate(root: string, selected = true): (event: unknown, ctx: unknown) => unknown {
  const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const pi = {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      if (name === "tool_call") handlers.push(handler);
    },
  };
  const controller = selected
    ? createWorkflowSessionController({ cwd: root, context: trustedContext(root) })
    : undefined;
  if (controller) controller.bind(RUN_ID);
  registerTeamWorkflow(pi as never, {
    roles: genericRoles,
    getSessionController: () => controller,
  });
  assert.equal(handlers.length, 1);
  return handlers[0]!;
}

test("history without a selected run does not gate task compatibility", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-gate-history-"));
  try {
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify(minimalState()));
    const handler = registerGate(root, false);
    const result = handler({ toolName: "task", input: { task: "ordinary task" } }, { cwd: root });
    assert.equal(result, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected canonical run rejects malformed classification before dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-gate-malformed-"));
  try {
    const armed = {
      ...minimalState(),
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false },
    } as TeamState;
    writeCanonicalState(root, armed);
    const handler = registerGate(root);
    const result = handler({ toolName: "task", input: { task: "prompt-only" } }, { cwd: root }) as { block?: boolean; reason?: string } | undefined;
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /malformed classification|workflow/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
