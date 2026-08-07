/**
 * Run health assessment (architecture §4.8, br-zps.7).
 *
 * Health is DERIVED from `CtoState` (team statuses, pending escalations,
 * budget status, lease heartbeats) — never from OMP events — so it is
 * deterministic and unit-testable without a live session. The snapshot is
 * stored on `CtoState.health` by consumers (e.g. the scheduler digest) and
 * surfaced by `healthToMarkdown` for the /pulse projection.
 *
 * Heartbeat source: the freshest `heartbeat_at` across all team leases
 * (`state.leases`); when no leases exist, `state.updated_at` is the best
 * available heartbeat proxy (state.ts stamps it on every write). No other
 * heartbeat source exists in schema 2.
 *
 * Healthy = no failed teams AND budget not exceeded. (Documented decision:
 * a stale heartbeat alone does NOT mark the run unhealthy — leases have
 * their own TTL-based reclaim path (br-zps.3) and the health view should
 * not duplicate liveness enforcement. Revisit if a heartbeat-based
 * liveness signal is required.)
 */

import type { CtoState, EscalationStatus, RunHealth, TeamRunStatus } from "./types.js";
import { checkBudget } from "./budget.js";

/** Team statuses that count as "active" (working or queued to start). */
const ACTIVE: Partial<Record<TeamRunStatus, true>> = { pending: true, in_progress: true };
/** "parked" = waiting on an escalation answer / external input. */
const PARKED: Partial<Record<TeamRunStatus, true>> = { parked: true };
/** "failed" = the team hit an unrecoverable error. */
const FAILED: Partial<Record<TeamRunStatus, true>> = { failed: true };

/**
 * Escalation statuses still "open" — not resolved/answered. `answered`,
 * `expired` and `cancelled` are terminal; `pending` is awaiting an answer
 * and `undelivered` (adapter send failed) still needs attention.
 *
 * NOTE: state.ts `pendingEscalations` counts ONLY `pending` across ACTIVE
 * teams (that helper drives adapter re-send on session start). Health
 * counts open escalations across ALL teams, matching the digest's
 * `open_escalations` — a failed or parked team's open escalation is still
 * an open escalation.
 */
const OPEN_ESCALATION: Partial<Record<EscalationStatus, true>> = { pending: true, undelivered: true };

function countOpenEscalations(state: CtoState): number {
  let n = 0;
  for (const team of state.teams) {
    for (const record of Object.values(team.escalations)) {
      if (OPEN_ESCALATION[record.status]) n += 1;
    }
  }
  return n;
}

/** Freshest lease heartbeat across all teams; undefined when no leases exist. */
function freshestLeaseHeartbeat(state: CtoState): string | undefined {
  let latest: string | undefined;
  for (const lease of Object.values(state.leases ?? {})) {
    const ms = Date.parse(lease.heartbeat_at);
    if (Number.isNaN(ms)) continue;
    if (latest === undefined || ms > Date.parse(latest)) latest = lease.heartbeat_at;
  }
  return latest;
}

/**
 * Assess run health from state. Deterministic given `now` (passed through
 * to `checkBudget`). `issues` carries one human-readable string per failed
 * team, one per budget warning (approaching/exceeded), and one summarizing
 * open escalations — empty when everything is fine.
 */
export function assessRunHealth(state: CtoState, now?: number): RunHealth {
  let active = 0;
  let parked = 0;
  let failed = 0;
  const failedTeams: string[] = [];
  for (const team of state.teams) {
    if (ACTIVE[team.status]) active += 1;
    else if (PARKED[team.status]) parked += 1;
    else if (FAILED[team.status]) {
      failed += 1;
      failedTeams.push(team.id);
    }
  }

  const budget = checkBudget(state, now);
  const pendingEscalations = countOpenEscalations(state);

  const issues: string[] = [];
  for (const teamId of failedTeams) issues.push(`team "${teamId}" failed`);
  if (budget.status === "exceeded") {
    issues.push(budget.detail ? `budget exceeded: ${budget.detail}` : "budget exceeded");
  } else if (budget.status === "approaching") {
    issues.push(budget.detail ? `budget approaching: ${budget.detail}` : "budget approaching limit");
  }
  if (pendingEscalations > 0) {
    issues.push(`${pendingEscalations} open escalation${pendingEscalations === 1 ? "" : "s"}`);
  }

  return {
    run_id: state.id,
    healthy: failed === 0 && budget.status !== "exceeded",
    active_teams: active,
    parked_teams: parked,
    failed_teams: failed,
    pending_escalations: pendingEscalations,
    budget_status: budget.status,
    last_heartbeat_at: freshestLeaseHeartbeat(state) ?? state.updated_at,
    issues,
  };
}

/**
 * Compact, deterministic markdown projection for the /pulse digest: one
 * line per field plus a bullet list of issues ("- none" when empty). Same
 * input → same output.
 */
export function healthToMarkdown(health: RunHealth): string {
  const lines = [
    `## Run health: ${health.run_id}`,
    `- healthy: ${health.healthy ? "yes" : "no"}`,
    `- active teams: ${health.active_teams}`,
    `- parked teams: ${health.parked_teams}`,
    `- failed teams: ${health.failed_teams}`,
    `- pending escalations: ${health.pending_escalations}`,
    `- budget: ${health.budget_status}`,
    `- last heartbeat: ${health.last_heartbeat_at}`,
    "Issues:",
  ];
  if (health.issues.length === 0) {
    lines.push("- none");
  } else {
    for (const issue of health.issues) lines.push(`- ${issue}`);
  }
  return lines.join("\n");
}
