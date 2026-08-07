/**
 * Team lease fencing (architecture §4.1, br-zps.3).
 *
 * A lease guards one team against duplicate spawns across restarts and
 * crashes. Restarts-safe: a lease with `heartbeat_at` older than `ttl_ms`
 * OR a dead `pid` is reclaimable. Mirrors the dispatcher's
 * `DispatcherLeaseRecord` / `claimDispatcher` pattern in
 * `packages/fullstack/src/adapters/registry.ts`.
 *
 * No automatic duplicate completion: a team with a live lease blocks
 * re-spawn (`acquireLease` returns a conflict); a dead lease is
 * force-reclaimed with a NEW token.
 */

import { randomUUID } from "node:crypto";
import type { CtoState, TeamLease } from "./types.js";
import { writeCtoState } from "./state.js";

/**
 * Lease liveness. `ttl_ms === 0` → alive iff the holder PID is alive
 * (until released). `ttl_ms > 0` → alive iff the PID is alive AND the
 * heartbeat age is within the TTL. `now` injects the clock for tests.
 *
 * PID probe is `process.kill(pid, 0)`: only ESRCH means dead — EPERM
 * means the process exists (other user) and a PID equal to the current
 * process reports alive.
 */
export function isLeaseAlive(lease: TeamLease, now: number = Date.now()): boolean {
  let pidAlive = true;
  try {
    process.kill(lease.pid, 0);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      pidAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  if (!pidAlive) return false;
  if (lease.ttl_ms === 0) return true;
  const heartbeatAt = Date.parse(lease.heartbeat_at);
  if (!Number.isFinite(heartbeatAt)) return false;
  return now - heartbeatAt <= lease.ttl_ms;
}

/**
 * Acquire the fence for one team. If a live lease already exists for
 * `teamId` → `{ state, conflict }` with NO mutation (no duplicate
 * completion). If the existing lease is dead → force-reclaimed with a new
 * token and returned as the fresh lease. Persists via `writeCtoState`
 * when `root` is provided.
 */
export function acquireLease(
  state: CtoState,
  teamId: string,
  pid: number,
  ttlMs: number = 0,
  root: string | null = null,
): { state: CtoState; lease: TeamLease } | { state: CtoState; conflict: string } {
  const existing = state.leases?.[teamId];
  if (existing && isLeaseAlive(existing)) {
    return {
      state,
      conflict: `team "${teamId}" already has a live lease (pid ${existing.pid}) — duplicate spawn blocked`,
    };
  }
  const now = new Date().toISOString();
  const lease: TeamLease = {
    token: randomUUID(),
    acquired_at: now,
    heartbeat_at: now,
    ttl_ms: ttlMs,
    pid,
    team_id: teamId,
  };
  if (!state.leases) state.leases = {};
  state.leases[teamId] = lease;
  if (root) writeCtoState(state, root);
  return { state, lease };
}

/**
 * Refresh `heartbeat_at` — only when `token` matches the current lease.
 * Stale/wrong token → no-op, state unchanged (and no write).
 */
export function heartbeatLease(state: CtoState, teamId: string, token: string, root: string | null = null): CtoState {
  const lease = state.leases?.[teamId];
  if (lease && lease.token === token) {
    lease.heartbeat_at = new Date().toISOString();
    if (root) writeCtoState(state, root);
  }
  return state;
}

/**
 * Remove the lease for `teamId` — only when `token` matches. Wrong token
 * → no-op, state unchanged.
 */
export function releaseLease(state: CtoState, teamId: string, token: string, root: string | null = null): CtoState {
  const lease = state.leases?.[teamId];
  if (lease && lease.token === token) {
    delete state.leases![teamId];
    if (root) writeCtoState(state, root);
  }
  return state;
}

/**
 * Remove every dead lease (TTL expired and/or PID gone); returns the
 * reclaimed teamIds. Persists when `root` is provided AND at least one
 * lease was reclaimed (no write on a no-op).
 */
export function reclaimDeadLeases(
  state: CtoState,
  now: number = Date.now(),
  root: string | null = null,
): { state: CtoState; reclaimed: string[] } {
  const reclaimed: string[] = [];
  const leases = state.leases;
  if (!leases) return { state, reclaimed };
  for (const [teamId, lease] of Object.entries(leases)) {
    if (!isLeaseAlive(lease, now)) {
      delete leases[teamId];
      reclaimed.push(teamId);
    }
  }
  if (root && reclaimed.length > 0) writeCtoState(state, root);
  return { state, reclaimed };
}
