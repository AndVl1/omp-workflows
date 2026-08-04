/**
 * CtoState persistence + transitions.
 *
 * State lives in files (`.work-state/cto/<id>/state.json`) so parked teams
 * and pending escalations survive restarts, machine sleep, and compaction
 * (R7). The engine is the only writer; agents read through it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CtoState,
  type EscalationRecord,
  type EscalationStatus,
  type TeamRunStatus,
  type TeamPlan,
} from "./types.js";

export function ctoStateDir(runId: string, root: string): string {
  return join(root, ".work-state", "cto", runId);
}

export function ctoStatePath(runId: string, root: string): string {
  return join(ctoStateDir(runId, root), "state.json");
}

export function newCtoState(opts: { id: string; task: string; branch: string; autonomous: boolean; plan: TeamPlan }): CtoState {
  return {
    schema: 1,
    id: opts.id,
    task: opts.task,
    branch: opts.branch,
    autonomous: opts.autonomous,
    plan: opts.plan,
    teams: opts.plan.teams.map((t) => ({ id: t.team, status: "pending", escalations: {} })),
    integration: { status: "pending" },
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
  };
}

export function readCtoState(runId: string, root: string): CtoState | null {
  try {
    const raw = JSON.parse(readFileSync(ctoStatePath(runId, root), "utf8")) as CtoState;
    return raw.schema === 1 ? raw : null;
  } catch {
    return null;
  }
}

export function writeCtoState(state: CtoState, root: string): string {
  const path = ctoStatePath(state.id, root);
  mkdirSync(ctoStateDir(state.id, root), { recursive: true });
  state.updated_at = new Date().toISOString();
  writeFileSync(path, JSON.stringify(state, null, 2));
  return path;
}

function teamOf(state: CtoState, teamId: string): CtoState["teams"][number] | undefined {
  return state.teams.find((t) => t.id === teamId);
}

/** Transition one team's run status; persists when a root is given. */
export function setTeamStatus(state: CtoState, teamId: string, status: TeamRunStatus, root: string | null = null): CtoState {
  const team = teamOf(state, teamId);
  if (team) team.status = status;
  if (root) writeCtoState(state, root);
  return state;
}

/** Record an escalation for a team; persists when a root is given. */
export function setEscalation(
  state: CtoState,
  teamId: string,
  escId: string,
  record: EscalationRecord,
  root: string | null = null,
): CtoState {
  const team = teamOf(state, teamId);
  if (team) team.escalations[escId] = record;
  if (root) writeCtoState(state, root);
  return state;
}

export function setEscalationStatus(
  state: CtoState,
  teamId: string,
  escId: string,
  status: EscalationStatus,
  root: string | null = null,
): CtoState {
  const team = teamOf(state, teamId);
  const record = team?.escalations[escId];
  if (team && record) record.status = status;
  if (root) writeCtoState(state, root);
  return state;
}

/** Mark the integration phase; persists when a root is given. */
export function setIntegration(
  state: CtoState,
  status: CtoState["integration"]["status"],
  note: string | undefined,
  root: string | null = null,
): CtoState {
  state.integration = { status, note };
  if (root) writeCtoState(state, root);
  return state;
}

export function setCtoPause(
  state: CtoState,
  kind: CtoState["pause"]["kind"],
  reason: string,
  root: string | null = null,
): CtoState {
  state.pause = { kind, reason };
  if (root) writeCtoState(state, root);
  return state;
}

/** Stamp a mid-run amendment (br-k19); persists when a root is given. */
export function markAmended(state: CtoState, root: string | null = null): CtoState {
  state.amended_at = new Date().toISOString();
  if (root) writeCtoState(state, root);
  return state;
}

/**
 * Expire pending escalations whose timeout elapsed. `timeout_ms: 0`/absent
 * (blocker default) never expires — the team stays parked and the rest of
 * the run continues (interview Q4). Returns the expired escalation ids.
 */
export function expireEscalations(state: CtoState, now: number): string[] {
  const expired: string[] = [];
  for (const team of state.teams) {
    for (const [escId, record] of Object.entries(team.escalations)) {
      const timeoutMs = record.timeout_ms ?? 0;
      if (record.status !== "pending" || timeoutMs <= 0 || !record.sent_at) continue;
      if (now - Date.parse(record.sent_at) >= timeoutMs) {
        record.status = "expired";
        expired.push(escId);
      }
    }
  }
  return expired;
}

/** All pending escalations across ACTIVE teams (for adapter re-send on session start, R7). */
export function pendingEscalations(state: CtoState): Array<{ teamId: string; escId: string; record: EscalationRecord }> {
  const out: Array<{ teamId: string; escId: string; record: EscalationRecord }> = [];
  for (const team of state.teams) {
    if (team.status !== "pending" && team.status !== "in_progress" && team.status !== "parked") continue;
    for (const [escId, record] of Object.entries(team.escalations)) {
      if (record.status === "pending") out.push({ teamId: team.id, escId, record });
    }
  }
  return out;
}

/** Teams not yet finished (pending | in_progress | parked). */
export function activeTeams(state: CtoState): string[] {
  return state.teams.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "parked").map((t) => t.id);
}
