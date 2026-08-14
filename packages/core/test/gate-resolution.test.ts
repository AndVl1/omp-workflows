import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { registerTeamWorkflow, defaultFullstackRoles } from "../src/index.js";

function minimalState(branch = "feature/gates") {
  return {
    schema: 1,
    branch,
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    task: "gate regression",
    issue: null,
    workflow_override: false,
    stage_cursor: "implementation",
    stages: [{ id: "implementation", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date(0).toISOString(),
  };
}

test("runtime registers the canonical tool-call gate chain in order", () => {
  const registrations: string[] = [];
  const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const pi = {
    setLabel() {},
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      registrations.push(name);
      if (name === "tool_call") handlers.push(handler);
    },
  };
  registerTeamWorkflow(pi as never, { roles: defaultFullstackRoles });
  assert.deepEqual(registrations.slice(0, 3), ["before_agent_start", "session_stop", "tool_call"]);
  assert.ok(handlers.length >= 1);
  // An unarmed workspace must retain normal task compatibility: all gates allow.
  const root = mkdtempSync(join(tmpdir(), "omp-gate-order-"));
  try {
    const result = handlers[0]!({ toolName: "task", input: { task: "ordinary task" } }, { cwd: root });
    assert.equal(result, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("armed malformed state is rejected before dispatch can be authorized", () => {
  const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const pi = { setLabel() {}, on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { if (name === "tool_call") handlers.push(handler); } };
  registerTeamWorkflow(pi as never);
  const root = mkdtempSync(join(tmpdir(), "omp-gate-armed-"));
  try {
    mkdirSync(join(root, ".work-state"), { recursive: true });
    const armed = { ...minimalState(), policy: { strict_orchestrator: true } };
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify(armed));
    const result = handlers[0]!({ toolName: "task", input: { task: "prompt-only" } }, { cwd: root }) as { block?: boolean; reason?: string } | undefined;
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /classification|capability|dispatch/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
