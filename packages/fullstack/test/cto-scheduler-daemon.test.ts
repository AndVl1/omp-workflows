/**
 * CTO scheduler daemon (br-zps.8, C2): start/stop round-trip driven without
 * a real session — the stub must construct state via the core helpers,
 * delegate to startWaveScheduler, and require no network/credentials.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startCtoSchedulerDaemon } from "../src/cto-scheduler-daemon.js";
import { openFullstackRuntimeTest } from "./runtime-access-fixture.js";
import { newCtoState, writeCtoState } from "../../core/src/cto/state.js";

/** Wall-clock delay; see the real-timer exception note in the first test. */
function delay(ms: number): Promise<void> {
  const { promise, resolve } = deferred<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Node 20-compatible `Promise.withResolvers` (Node 22+ / ES2024);
 * mirrors the repo convention in packages/e2e/src/util.ts and
 * src/adapters/telegram.ts.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// EXCEPTION to the fake-timer rule (ts-no-test-timers): the daemon delegates
// to core startWaveScheduler, which creates its own real setInterval with no
// injection point; node:test ships no fake-timer facility. Real timers with
// generous margins (30ms interval vs 200ms observation) are the honest way to
// verify the timer fires and that stop() clears it.
test("cto-scheduler-daemon: start + stop round-trip fires onWave and stops", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-"));
  let runtime: ReturnType<typeof openFullstackRuntimeTest> | undefined;
  try {
    runtime = openFullstackRuntimeTest(root, "scheduler-session");
    writeCtoState(newCtoState({
      id: "daemon-run-1",
      task: "scheduler test",
      branch: "main",
      autonomous: false,
      plan: { id: "daemon-run-1", task: "scheduler test", teams: [], created_at: new Date().toISOString() },
    }), root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    let waves = 0;
    const { stop } = startCtoSchedulerDaemon({
      runId: "daemon-run-1",
      root,
      intervalMs: 30,
      runtimeAccess: runtime!.access,
      onWave: () => {
        waves += 1;
      },
    });
    try {
      await delay(200);
      assert.ok(waves >= 1, `onWave should fire at least once (got ${waves})`);
    } finally {
      stop();
    }
    const afterStop = waves;
    await delay(150);
    assert.equal(waves, afterStop, "no waves after stop()");
  } finally {
    runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-scheduler-daemon: interval <= 0 returns a no-op stop and writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-off-"));
  const runtimeAccess = {
    startScheduler(): never {
      throw new Error("disabled scheduler must not access runtime");
    },
  } as unknown as Parameters<typeof startCtoSchedulerDaemon>[0]["runtimeAccess"];
  try {
    const { stop } = startCtoSchedulerDaemon({
      runId: "daemon-off-1",
      root,
      intervalMs: 0,
      runtimeAccess,
      onWave: () => {
        throw new Error("must never fire");
      },
    });
    stop();
    stop(); // idempotent
    assert.equal(existsSync(join(root, ".work-state")), false, "disabled scheduler does not write state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
