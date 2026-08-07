/**
 * CTO scheduler daemon (br-zps.8, C2): start/stop round-trip driven without
 * a real session — the stub must construct state via the core helpers,
 * delegate to startWaveScheduler, and require no network/credentials.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startCtoSchedulerDaemon } from "../src/cto-scheduler-daemon.js";

/** Wall-clock delay; see the real-timer exception note in the first test. */
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// EXCEPTION to the fake-timer rule (ts-no-test-timers): the daemon delegates
// to core startWaveScheduler, which creates its own real setInterval with no
// injection point; node:test ships no fake-timer facility. Real timers with
// generous margins (30ms interval vs 200ms observation) are the honest way to
// verify the timer fires and that stop() clears it.
test("cto-scheduler-daemon: start + stop round-trip fires onWave and stops", async () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-"));
  try {
    let waves = 0;
    const { stop } = startCtoSchedulerDaemon({
      runId: "daemon-run-1",
      root,
      intervalMs: 30,
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-scheduler-daemon: interval <= 0 returns a no-op stop and writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-daemon-off-"));
  try {
    const { stop } = startCtoSchedulerDaemon({
      runId: "daemon-off-1",
      root,
      intervalMs: 0,
      onWave: () => {
        throw new Error("must never fire");
      },
    });
    stop();
    stop(); // idempotent
    assert.throws(() =>
      readFileSync(join(root, ".work-state", "cto", "daemon-off-1", "state.json"), "utf8"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
