/**
 * Wave scheduling + digest (architecture §4.9, br-zps.8).
 *
 * C2 constraint: OMP has no scheduler/cron API — waves run on `setInterval`
 * while a session is alive. The standalone daemon entry
 * (`packages/fullstack/src/cto-scheduler-daemon.ts`) mirrors the
 * telegram-bridge pattern for idle-session scheduling; this module is the
 * engine-side pure logic + the session-scoped timer, consumed by both.
 *
 * All scheduler fields live on `CtoState.scheduler` (schema 2, default
 * `wave_interval_ms: 0` = disabled). `state.json` stays canonical; the
 * scheduler re-reads it on every tick so disk truth wins over the
 * in-memory snapshot passed at start.
 */

import type { CtoState, ScheduledDigest } from "./types.js";
import { readCtoState, validateCtoRunIdentity, writeCtoState } from "./state.js";
import { recallDecisions } from "./decisions.js";
import { assessRunHealth } from "./health.js";
import { checkBudget } from "./budget.js";

/**
 * True when a wave is due.
 *
 * - Disabled when `wave_interval_ms` is missing, 0, negative, or NaN
 *   (default 0 = disabled — a scheduler that was never configured must not
 *   fire).
 * - Due when `last_wave_at` is absent (never ran).
 * - Otherwise due when `now - last_wave_at >= wave_interval_ms`.
 * - An unparseable `last_wave_at` is treated as DUE (documented decision: a
 *   corrupt timestamp must not wedge the scheduler forever — the tick that
 *   fires overwrites it with a valid ISO stamp).
 */
export function shouldRunWave(state: CtoState, now?: number): boolean {
  const intervalMs = state.scheduler?.wave_interval_ms;
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) return false;
  const lastWaveAt = state.scheduler?.last_wave_at;
  if (lastWaveAt === undefined) return true;
  const lastMs = Date.parse(lastWaveAt);
  if (Number.isNaN(lastMs)) return true;
  const nowMs = now ?? Date.now();
  return nowMs - lastMs >= intervalMs;
}

/**
 * Build a scheduled digest. The `root` parameter lets callers prefer the
 * run-identity-bound canonical state on disk (`readCtoState(state.id, root,
 * state.run_identity)`) — the scheduler runs on a live session whose
 * in-memory snapshot may lag what other writers have persisted. A missing,
 * unreadable, or mismatched file leaves the already validated state as the
 * observational fallback; it is never treated as an unbound state.
 */
export function buildDigest(state: CtoState, root: string): ScheduledDigest {
  const checkedIdentity = validateCtoRunIdentity(state.run_identity);
  if (!checkedIdentity.ok) throw new Error(checkedIdentity.diagnostics.map((diagnostic) => diagnostic.code).join(","));
  const runIdentity = checkedIdentity.value;
  const diskState = readCtoState(state.id, root, runIdentity);
  const digestState = diskState ?? state;
  const health = assessRunHealth(digestState);
  return {
    run_id: digestState.id,
    run_identity: digestState.run_identity,
    at: new Date().toISOString(),
    health,
    recent_decisions: recallDecisions(digestState, { limit: 10 }),
    open_escalations: health.pending_escalations,
    budget_status: checkBudget(digestState).status,
  };
}

/**
 * Start a session-scoped wave scheduler (C2). Returns a stop function.
 *
 * - `intervalMs <= 0` (or NaN) → returns a no-op stop; nothing is scheduled
 *   and nothing is persisted.
 * - On start: validates the in-memory identity, then reads the canonical
 *   identity-bound state from disk before stamping
 *   `scheduler.wave_interval_ms = intervalMs` and persisting it.
 * - Each tick: re-reads fresh state from disk under the original identity;
 *   when a wave is due calls `onWave()` and persists
 *   `last_wave_at` / `next_wave_at` (both ISO). Missing or mismatched state
 *   fails that tick closed rather than falling back to a raw legacy state.
 * - The timer is `unref()`'d so a process whose only work is the scheduler
 *   exits cleanly.
 * - A tick NEVER throws: `onWave` errors are logged to `console.error` and
 *   the scheduler keeps running — a scheduler must not kill the process.
 */
export function startWaveScheduler(state: CtoState, root: string, intervalMs: number, onWave: () => void): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};

  const checkedRunIdentity = validateCtoRunIdentity(state.run_identity);
  if (!checkedRunIdentity.ok) {
    throw new Error(checkedRunIdentity.diagnostics.map((diagnostic) => diagnostic.code).join(","));
  }
  const runIdentity = checkedRunIdentity.value;
  const initial = readCtoState(state.id, root, runIdentity);
  if (!initial) throw new Error("MIGRATION_REQUIRED: identity-bound CTO state is unavailable");

  initial.scheduler = initial.scheduler ?? { wave_interval_ms: 0 };
  initial.scheduler.wave_interval_ms = intervalMs;
  writeCtoState(initial, root, runIdentity);

  const timer = setInterval(() => {
    try {
      const fresh = readCtoState(state.id, root, runIdentity);
      if (!fresh) throw new Error("MIGRATION_REQUIRED: identity-bound CTO state is unavailable");
      if (!shouldRunWave(fresh, Date.now())) return;
      onWave();
      const updated = readCtoState(state.id, root, runIdentity);
      if (!updated) throw new Error("MIGRATION_REQUIRED: identity-bound CTO state is unavailable");
      updated.scheduler = updated.scheduler ?? { wave_interval_ms: 0 };
      updated.scheduler.wave_interval_ms = intervalMs;
      updated.scheduler.last_wave_at = new Date().toISOString();
      updated.scheduler.next_wave_at = new Date(Date.now() + intervalMs).toISOString();
      writeCtoState(updated, root, runIdentity);
    } catch (err) {
      console.error("[cto-scheduler] wave tick failed:", err);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
