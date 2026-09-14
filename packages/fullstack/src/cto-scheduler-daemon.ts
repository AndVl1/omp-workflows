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
 * The daemon requires a marker-authenticated main-session runtime facade;
 * it never reads or mutates CTO state through raw root helpers.
 */

import { fileURLToPath } from "node:url";
import type { CtoRuntimeAccessFacade } from "@andvl1/omp-workflows-core/cto-runtime";

export interface CtoSchedulerDaemonOpts {
  /** CTO run id (`.work-state/cto/<runId>/`). */
  runId: string;
  /** Workspace root that contains `.work-state/`. */
  root: string;
  /** Wave interval in ms; <= 0 disables scheduling. */
  intervalMs: number;
  /** Invoked on each due wave (defaults to a no-op). */
  onWave?: () => void;
  /** Authenticated main-session CTO capability. */
  runtimeAccess: CtoRuntimeAccessFacade;
}

/**
 * Start the scheduler through the authenticated runtime facade. Returns
 * `{ stop() }`; `stop` is idempotent.
 */
export function startCtoSchedulerDaemon(opts: CtoSchedulerDaemonOpts): { stop(): void } {
  // A finite non-positive interval is an explicit disabled mode. Return
  // before touching the runtime facade so disabling a daemon cannot require
  // state, credentials, or an otherwise-live session.
  if (Number.isFinite(opts.intervalMs) && opts.intervalMs <= 0) return { stop: () => undefined };
  const stop = opts.runtimeAccess.startScheduler(opts.runId, opts.intervalMs, opts.onWave ?? (() => {}));
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
  // A standalone process has no marker-authenticated owner context. It must
  // be launched by an already-authorized main session, never with raw root
  // state access or a fabricated facade.
  console.error(`[cto-scheduler-daemon] runtime access required for run=${runId} root=${root} intervalMs=${intervalMs}`);
  process.exitCode = 1;
}

// Direct-run guard (ESM equivalent of `import.meta.main`): the first argv
// path must be THIS file's resolved path. Under the test runner argv[1] is
// the test file, so main() never fires in tests.
const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) main();
