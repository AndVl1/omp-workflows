/**
 * CTO-safety outbox gate (br-zps.5): `ask` is blocked when a bidirectional
 * messenger channel is configured in `.omp/escalation.json`; every other
 * tool and every non-bidirectional/missing config passes through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { outboxEnforcementGate } from "@andvl1/omp-workflows-core";

function makeCwd(config: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), "outbox-gate-"));
  if (config !== undefined) {
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "escalation.json"), JSON.stringify(config));
  }
  return cwd;
}

function cleanup(cwd: string): void {
  rmSync(cwd, { recursive: true, force: true });
}

const ask = { toolName: "ask", input: { question: "Which option?" } };

test("ask is blocked when escalation.json has bidirectional: true (reason returned, block true)", () => {
  const cwd = makeCwd({ adapter: "mock", bidirectional: true });
  try {
    const result = outboxEnforcementGate(ask, { cwd });
    assert.ok(result, "expected a block");
    assert.equal(result.block, true);
    assert.match(result.reason, /cto-safety outbox gate/);
    assert.match(result.reason, /outbox\/<escId>\.json/);
  } finally {
    cleanup(cwd);
  }
});

test("ask is blocked when adapter is telegram (bidirectional by definition)", () => {
  const cwd = makeCwd({ adapter: "telegram" });
  try {
    const result = outboxEnforcementGate(ask, { cwd });
    assert.ok(result, "expected a block");
    assert.equal(result.block, true);
  } finally {
    cleanup(cwd);
  }
});

test("ask passes when no .omp/escalation.json exists", () => {
  const cwd = makeCwd(undefined);
  try {
    assert.equal(outboxEnforcementGate(ask, { cwd }), undefined);
  } finally {
    cleanup(cwd);
  }
});

test("ask passes when adapter is http (push-only, no bidirectional flag)", () => {
  const cwd = makeCwd({ adapter: "http" });
  try {
    assert.equal(outboxEnforcementGate(ask, { cwd }), undefined);
  } finally {
    cleanup(cwd);
  }
});

test("non-ask tools pass even when bidirectional", () => {
  const cwd = makeCwd({ adapter: "mock", bidirectional: true });
  try {
    for (const toolName of ["write", "bash", "task"]) {
      assert.equal(outboxEnforcementGate({ toolName }, { cwd }), undefined, `${toolName} should pass`);
    }
  } finally {
    cleanup(cwd);
  }
});

test("malformed escalation.json passes, never throws", () => {
  const cwd = mkdtempSync(join(tmpdir(), "outbox-gate-"));
  try {
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "escalation.json"), "{ not json !!");
    assert.equal(outboxEnforcementGate(ask, { cwd }), undefined);
  } finally {
    cleanup(cwd);
  }
});

test("missing cwd path passes, never throws", () => {
  const cwd = join(tmpdir(), "outbox-gate-does-not-exist-" + Date.now());
  assert.equal(outboxEnforcementGate(ask, { cwd }), undefined);
});

// ── Explicit channels[] (architecture-4): hasBidirectionalChannel now
// resolves through the shared normalizer (cto/channels.ts), so a
// capability-validated RW primary blocks ask and a declared-rw incapable
// kind (http, no inbound) downgrades to ro and passes. Guards against
// reverting hasBidirectionalChannel to the legacy direct-read, which would
// silently drop explicit-channels support at this boundary while leaving
// every other test green.
test("ask is blocked for an explicit validated RW primary channel (explicit channels[])", () => {
  const cwd = makeCwd({ channels: [{ id: "control", adapter: "mock", direction: "read-write", primary: true }] });
  try {
    const result = outboxEnforcementGate(ask, { cwd });
    assert.ok(result, "expected a block for a validated RW primary");
    assert.equal(result.block, true);
  } finally {
    cleanup(cwd);
  }
});

test("ask passes for an explicit declared-rw incapable kind (http downgrades to ro)", () => {
  const cwd = makeCwd({ channels: [{ id: "sink", adapter: "http", direction: "read-write" }] });
  try {
    assert.equal(outboxEnforcementGate(ask, { cwd }), undefined, "http has no inbound -> ro -> ask passes");
  } finally {
    cleanup(cwd);
  }
});
