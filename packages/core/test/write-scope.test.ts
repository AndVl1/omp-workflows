/**
 * Bounded write_scope experiment (scope 7):
 *   - worker writes outside the declared scope are blocked;
 *   - the gate is OFF by default (shipped single-writer model unchanged);
 *   - orchestrator/lead actors and non-write tools are unaffected;
 *   - the gate only adds blocks and never weakens orchestratorWriteGate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerWriteScopeGate, orchestratorWriteGate } from "../src/gates/orchestrator-write.js";

const SCOPE = { enabled: true, allow: ["src/**", "test/**"], deny: ["src/secret/**"] };

test("write_scope: disabled by default and never blocks", () => {
  const event = { toolName: "write", input: { path: "src/whatever.ts" } };
  const result = workerWriteScopeGate(event, { cwd: "/tmp/proj", actor: "worker", hasUI: false, writeScope: { enabled: false, allow: [] } });
  assert.equal(result, undefined, "disabled scope is inert");
  const absent = workerWriteScopeGate(event, { cwd: "/tmp/proj", actor: "worker", hasUI: false });
  assert.equal(absent, undefined, "no scope config is inert");
});

test("write_scope: worker writes outside the declared scope are blocked", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wscope-"));
  try {
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, "src", "secret"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "a");

    const outside = workerWriteScopeGate({ toolName: "write", input: { path: "lib/other.ts" } }, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE });
    assert.equal(outside?.block, true);
    assert.match(outside?.reason ?? "", /outside the declared write scope/);

    const denied = workerWriteScopeGate({ toolName: "write", input: { path: "src/secret/key.ts" } }, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE });
    assert.equal(denied?.block, true, "deny wins over allow");
    assert.match(denied?.reason ?? "", /denied by write_scope/);

    const escaping = workerWriteScopeGate({ toolName: "edit", input: { path: "../outside.ts" } }, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE });
    assert.equal(escaping?.block, true, "paths escaping the project root are blocked");

    const allowed = workerWriteScopeGate({ toolName: "write", input: { path: "src/a.ts" } }, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE });
    assert.equal(allowed, undefined, "worker write inside the scope is allowed");

    const mountedTool = workerWriteScopeGate(
      { toolName: "write", input: { path: "xd://workflow_instructions" } },
      { cwd, actor: "worker", hasUI: false, writeScope: SCOPE },
    );
    assert.equal(mountedTool, undefined, "mounted xd tools bypass project write scope");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("write_scope: non-worker actors and non-write tools are unaffected", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wscope-actor-"));
  try {
    const orchestrator = workerWriteScopeGate({ toolName: "write", input: { path: "lib/other.ts" } }, { cwd, actor: "orchestrator", hasUI: true, writeScope: SCOPE });
    assert.equal(orchestrator, undefined, "orchestrator writes are not narrowed");
    const unknownActor = workerWriteScopeGate({ toolName: "write", input: { path: "lib/other.ts" } }, { cwd, hasUI: true, writeScope: SCOPE });
    assert.equal(unknownActor, undefined, "orchestrator-context (hasUI) writes are not narrowed");
    const bash = workerWriteScopeGate({ toolName: "bash", input: { command: "npm install" } }, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE });
    assert.equal(bash, undefined, "commands without mutation targets are not narrowed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("write_scope: composed after orchestratorWriteGate — the orchestrator gate remains authoritative", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wscope-gate-"));
  try {
    // A strict workflow state activates the orchestrator gate.
    const stateDir = join(cwd, ".work-state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "team-state.json"), JSON.stringify({
      schema: 1,
      branch: "feat/x",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "t",
      workflow_override: false,
      issue: null,
      stage_cursor: "s",
      stages: [{ id: "s", status: "in_progress" }],
      artifacts: {},
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      updated_at: new Date().toISOString(),
    }));
    // Canonical state writes are blocked by the orchestrator gate regardless
    // of write_scope (write_scope can only add blocks, never lift them).
    const stateWrite = { toolName: "write", input: { path: join(cwd, ".work-state", "team-state.json") } };
    const gateResult = orchestratorWriteGate(stateWrite, { cwd, actor: "worker", hasUI: false });
    assert.equal(gateResult?.block, true, "orchestrator gate still blocks canonical state writes");
    const scopeResult = workerWriteScopeGate(stateWrite, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE });
    assert.ok(scopeResult === undefined || scopeResult.block === true, "write_scope never weakens the orchestrator boundary");
    // Worker source writes that the orchestrator gate permits are narrowed
    // further by write_scope; a write inside scope stays allowed end-to-end.
    const sourceWrite = { toolName: "write", input: { path: "src/a.ts" } };
    const throughOrchestrator = orchestratorWriteGate(sourceWrite, { cwd, actor: "worker", hasUI: false });
    assert.equal(throughOrchestrator, undefined, "orchestrator gate permits worker source writes");
    assert.equal(workerWriteScopeGate(sourceWrite, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE }), undefined, "in-scope write passes both gates");
    const outOfScope = { toolName: "write", input: { path: "lib/other.ts" } };
    assert.equal(orchestratorWriteGate(outOfScope, { cwd, actor: "worker", hasUI: false }), undefined);
    assert.equal(workerWriteScopeGate(outOfScope, { cwd, actor: "worker", hasUI: false, writeScope: SCOPE })?.block, true, "out-of-scope write is narrowed after the orchestrator gate");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
