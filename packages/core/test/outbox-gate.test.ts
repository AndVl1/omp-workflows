/**
 * CTO-safety outbox gate (br-zps.5): `ask` is blocked when a bidirectional
 * messenger channel is configured in `.omp/escalation.json`; every other
 * tool and every non-bidirectional/missing config passes through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

test("malformed escalation.json is blocked fail-closed with a typed configuration reason", () => {
  const cwd = mkdtempSync(join(tmpdir(), "outbox-gate-"));
  try {
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "escalation.json"), "{ not json !!");
    const result = outboxEnforcementGate(ask, { cwd });
    assert.ok(result, "malformed present config must not fall through to interactive ask");
    assert.equal(result.block, true);
    assert.match(result.reason, /configuration is blocked/);
  } finally {
    cleanup(cwd);
  }
});


test("missing cwd path blocks fail-closed without leaking a path", () => {
  const cwd = join(tmpdir(), "outbox-gate-does-not-exist-" + Date.now());
  const result = outboxEnforcementGate(ask, { cwd });
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /configuration is blocked/);
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

test("ask is blocked with a typed configuration reason for an invalid marked RW primary", () => {
  const cwd = makeCwd({
    channels: [{ id: "broken", adapter: "http", direction: "read-write", primary: true }],
  });
  try {
    const result = outboxEnforcementGate(ask, { cwd });
    assert.ok(result, "invalid marked primary must not fall through to interactive ask");
    assert.equal(result.block, true);
    assert.match(result.reason, /configuration is blocked/);
  } finally {
    cleanup(cwd);
  }
});

test("ask blocks unsafe escalation config files without exposing filesystem details", () => {
  const symlinkRoot = makeCwd();
  const outside = mkdtempSync(join(tmpdir(), "outbox-config-outside-"));
  try {
    mkdirSync(join(symlinkRoot, ".omp"), { recursive: true });
    writeFileSync(join(outside, "config.json"), JSON.stringify({ adapter: "telegram" }));
    symlinkSync(join(outside, "config.json"), join(symlinkRoot, ".omp", "escalation.json"));
    const result = outboxEnforcementGate(ask, { cwd: symlinkRoot });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /configuration is blocked/);
    assert.doesNotMatch(result?.reason ?? "", /outbox-config-outside/);
  } finally {
    cleanup(symlinkRoot);
    cleanup(outside);
  }

  const fifoRoot = makeCwd();
  try {
    mkdirSync(join(fifoRoot, ".omp"), { recursive: true });
    const fifo = join(fifoRoot, ".omp", "escalation.json");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    const result = outboxEnforcementGate(ask, { cwd: fifoRoot });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /configuration is blocked/);
  } finally {
    cleanup(fifoRoot);
  }

  const largeRoot = makeCwd();
  try {
    mkdirSync(join(largeRoot, ".omp"), { recursive: true });
    writeFileSync(join(largeRoot, ".omp", "escalation.json"), "x".repeat(256 * 1024 + 1));
    const result = outboxEnforcementGate(ask, { cwd: largeRoot });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /configuration is blocked/);
  } finally {
    cleanup(largeRoot);
  }
});
