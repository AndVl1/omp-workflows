import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ompWorkflowsFullstack, { isMainSessionContext, resolveSessionCwd } from "../src/index.js";

test("dispatcher lifecycle: task subagent contexts do not own the messenger", () => {
  assert.equal(isMainSessionContext({ hasUI: false }), false);
  assert.equal(isMainSessionContext({ hasUI: true }), true);
  assert.equal(isMainSessionContext({}), true, "older runtimes without hasUI stay compatible");
  assert.equal(isMainSessionContext(undefined), true, "unknown hook context stays compatible");
});

test("dispatcher lifecycle: session cwd resolves from context only, never process.cwd", () => {
  // Explicit non-empty context cwd always wins.
  assert.equal(resolveSessionCwd({ cwd: "/tmp/project" }), "/tmp/project");
  assert.equal(resolveSessionCwd({ cwd: "/tmp/project", hasUI: true }), "/tmp/project");
  // OMP 17.2.10 emits session_start without a cwd field — no hidden
  // process.cwd fallback: resolution fails closed instead.
  assert.equal(resolveSessionCwd({}), undefined);
  assert.equal(resolveSessionCwd({ hasUI: true }), undefined);
  // Empty / non-string cwd is unusable — same fail-closed result.
  assert.equal(resolveSessionCwd({ cwd: "" }), undefined);
  assert.equal(resolveSessionCwd({ cwd: 42 }), undefined);
  // Unknown (non-object) contexts stay unresolved.
  assert.equal(resolveSessionCwd(undefined), undefined);
  assert.equal(resolveSessionCwd(null), undefined);
});
test("dispatcher lifecycle: canonical session manager cwd wins over a stale context cwd", () => {
  const sessionManager = { getCwd: () => "/canonical/project" };
  assert.equal(resolveSessionCwd({ cwd: "/stale/project", sessionManager }), "/canonical/project");
});

test("dispatcher lifecycle: session_start without context cwd starts nothing and leaves no lock", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    setLabel() {},
    sendUserMessage() {},
  };

  const root = mkdtempSync(join(tmpdir(), "omp-wo-cwd-"));
  const lock = join(root, ".omp", "cto-dispatcher.lock");
  const originalCwd = process.cwd();
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "mock" }));
    // Register the extension from the tmpdir so runtime-config writes (if any)
    // land in the scratch dir, never in the repo.
    process.chdir(root);
    ompWorkflowsFullstack(pi as never);

    const sessionStart = handlers.get("session_start");
    assert.ok(sessionStart, "session_start handler registered");
    // 17.2.10-shaped context: interactive main session, no cwd field.
    sessionStart({ type: "session_start" }, { hasUI: true });
    // Fail-closed: no context cwd -> no dispatcher, no command copy, no lock.
    assert.ok(!existsSync(lock), "no dispatcher lock without a resolvable session cwd");
    assert.ok(!existsSync(join(root, ".omp", "commands")), "no command copy without a resolvable session cwd");

    const sessionShutdown = handlers.get("session_shutdown");
    assert.ok(sessionShutdown, "session_shutdown handler registered");
    sessionShutdown({ type: "session_shutdown" }, { hasUI: true });
    assert.ok(!existsSync(lock), "dispatcher lock released on shutdown");
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
