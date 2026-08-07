/**
 * CTO scheduler daemon — standalone entry for idle-session wave scheduling
 * (architecture §4.9, C2 constraint).
 *
 * OMP has no scheduler/cron API: `setInterval` runs only while a session is
 * alive. When no CTO session is running, a standalone process must drive
 * the waves — this module is that entry, mirroring the telegram-bridge
 * pattern (pure exported API + optional direct-run main(), no network, no
 * credentials, nothing wired into package.json bin — same as
 * telegram-bridge.ts).
 *
 * For this epic it is a STUB that tests can drive directly:
 * `startCtoSchedulerDaemon` constructs a minimal `CtoState` (via the core
 * state helpers — existing run state when present, else a fresh empty run)
 * and delegates to `startWaveScheduler`. `main()` parses argv
 * (`<runId> <root> <intervalMs>`) and starts the scheduler with graceful
 * SIGINT/SIGTERM shutdown.
 */

import { fileURLToPath } from "node:url";
import { newCtoState, readCtoState, startWaveScheduler, type TeamPlan } from "@andvl1/omp-workflows-core";

export interface CtoSchedulerDaemonOpts {
  /** CTO run id (`.work-state/cto/<runId>/`). */
  runId: string;
  /** Workspace root that contains `.work-state/`. */
  root: string;
  /** Wave interval in ms; <= 0 disables scheduling. */
  intervalMs: number;
  /** Invoked on each due wave (defaults to a no-op). */
  onWave?: () => void;
}

/**
 * Start the scheduler daemon. Constructs a minimal `CtoState` — the
 * existing run state when one is readable on disk, otherwise a fresh empty
 * run — then delegates to `startWaveScheduler`, which persists
 * `scheduler.wave_interval_ms` on start and `last_wave_at`/`next_wave_at`
 * on each wave. Returns `{ stop() }`; `stop` is idempotent.
 */
export function startCtoSchedulerDaemon(opts: CtoSchedulerDaemonOpts): { stop(): void } {
  const plan: TeamPlan = { id: opts.runId, task: "", teams: [], created_at: new Date().toISOString() };
  const state =
    readCtoState(opts.runId, opts.root) ??
    newCtoState({ id: opts.runId, task: "", branch: "", autonomous: false, plan });
  const stop = startWaveScheduler(state, opts.root, opts.intervalMs, opts.onWave ?? (() => {}));
  return { stop };
}

/**
 * Direct-run entry: `node dist/cto-scheduler-daemon.js <runId> <root> <intervalMs>`.
 * Guarded so importing the module (tests, consumers) never starts a
 * scheduler; only a direct `node <this-file>` invocation reaches it.
 */
export function main(): void {
  const [, , runId, root, intervalMsArg] = process.argv;
  if (!runId || !root) {
    console.error("usage: cto-scheduler-daemon <runId> <root> <intervalMs>");
    process.exitCode = 1;
    return;
  }
  const intervalMs = Number(intervalMsArg ?? 60_000);
  const { stop } = startCtoSchedulerDaemon({ runId, root, intervalMs });
  console.error(`[cto-scheduler-daemon] started run=${runId} root=${root} intervalMs=${intervalMs}`);
  const shutdown = (): void => {
    stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Direct-run guard (ESM equivalent of `import.meta.main`): the first argv
// path must be THIS file's resolved path. Under the test runner argv[1] is
// the test file, so main() never fires in tests.
const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) main();
