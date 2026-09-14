import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PinnedProjectRoot } from "../../core/src/specification/pinned-root.js";
import { ctoRuntimeRunInitialIdentityDigest, newCtoState } from "../../core/src/cto/state.js";
import { openFullstackRuntimeTest } from "./runtime-access-fixture.js";
import { createChannelSet, startChannelDispatcher } from "../src/adapters/registry.js";

/**
 * Darwin's descriptor-relative backend is synchronous at its public API
 * boundary. This is intentionally an integration probe: a due dispatcher tick
 * must leave enough event-loop time for a sub-5s receipt deadline, even when
 * two inbound tasks are deferred behind one active wave.
 */
test("Darwin dispatcher keeps the event loop responsive with two deferred tasks", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "dispatcher-darwin-performance-"));
  const runtime = openFullstackRuntimeTest(root, "darwin-performance-session");
  try {
    const runId = "run-darwin-performance";
    const now = new Date().toISOString();
    const plan = { id: runId, task: "active", teams: [], created_at: now };
    const state = newCtoState({ id: runId, task: "active", branch: "", autonomous: false, plan });
    mkdirSync(join(root, ".omp"), { recursive: true });
    assert.ok(runtime.access.createRun(state, { source_id: `darwin-performance:${runId}`, initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(state) }));
    assert.equal(runtime.access.markDeliveryPending(runId, state.state_revision, "outbox"), true);
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({
      channels: [{ id: "mock", adapter: "mock", direction: "read-write", primary: true, mock: { persisted: true, dir: "rw" } }],
    }));
    mkdirSync(join(root, "rw", "inbound"), { recursive: true });
    for (const id of ["task-a", "task-b"]) {
      writeFileSync(join(root, "rw", "inbound", `${id}.json`), JSON.stringify({ id, text: `deferred ${id}`, at: now, by: "darwin-probe" }));
    }

    const channelSet = createChannelSet(root, undefined, undefined, runtime.access, runtime.proofAuthority);
    const delays: number[] = [];
    let callbackCount = 0;
    let resolveReceipt: (() => void) | undefined;
    const receipt = new Promise<void>((resolve) => { resolveReceipt = resolve; });
    let last = performance.now();
    const timer = setInterval(() => {
      const current = performance.now();
      delays.push(current - last - 10);
      last = current;
    }, 10);
    const started = performance.now();
    const stop = startChannelDispatcher(root, channelSet, 10_000, {
      runtimeAccess: runtime.access,
      proofAuthority: runtime.proofAuthority,
      session_id: runtime.sessionId,
      liveGuard: runtime.liveGuard,
      serviceAuthority: runtime.serviceAuthority,
      onTask: () => {
        callbackCount += 1;
        if (callbackCount === 1) resolveReceipt?.();
      },
    });
    try {
      await Promise.race([
        receipt,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dispatcher task callback receipt exceeded 5000ms")), 5_000)),
      ]);
    } finally {
      await new Promise<void>((resolve) => setImmediate(resolve));
      clearInterval(timer);
      await stop();
    }

    assert.ok(delays.length > 0, "the event loop must service a timer during the representative tick");
    assert.ok(Math.max(...delays) < 5_000, `event-loop delay exceeded the 5s receipt deadline: ${Math.max(...delays)}ms`);
    assert.ok(performance.now() - started < 5_000, "the representative tick must complete before the receipt deadline");
    assert.equal(callbackCount, 1, "the first task reaches the actual dispatcher callback");
    assert.equal(existsSync(join(root, "rw", "inbound", "processed", "task-a.json")), true);
    assert.equal(existsSync(join(root, "rw", "inbound", "processed", "task-b.json")), true);
    const deferredInbox = join(root, ".work-state", "cto", runId, "inbox");
    const deferredTasks = readdirSync(deferredInbox)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(deferredInbox, name), "utf8")) as { id?: string });
    assert.deepEqual(deferredTasks.map((task) => task.id).sort(), ["task-a", "task-b"], "both tasks remain durable in the run inbox while the second waits behind the active wave");
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("Darwin dispatcher helper watchdog is bounded below the receipt deadline", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "dispatcher-darwin-watchdog-"));
  const pinned = PinnedProjectRoot.open(root, { helperSleepMs: 60_000 });
  assert.ok(pinned);
  const started = performance.now();
  try {
    assert.throws(() => pinned.pathEntryExists("missing.txt"), /timed out/u);
  } finally {
    await pinned.closeAsync();
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(performance.now() - started < 5_000, "blocked helper must fail below the five-second receipt deadline");
});
