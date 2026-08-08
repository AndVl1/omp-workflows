/**
 * CtoState persistence + transitions.
 *
 * State lives in files (`.work-state/cto/<id>/state.json`) so parked teams
 * and pending escalations survive restarts, machine sleep, and compaction
 * (R7). The engine is the only writer; agents read through it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordStageTransition } from "../observability/hooks.js";
import type { ModelClassification } from "../engine/run.js";
import {
  type CtoState,
  type BudgetState,
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

export function newCtoState(opts: {
  id: string;
  task: string;
  branch: string;
  autonomous: boolean;
  /**
   * Model-first PHASE-0 classification (authority for `autonomous`). When
   * present, `classification.autonomous` is the decision and the top-level
   * `autonomous` field is mirrored from it for legacy readers — the two can
   * never disagree by construction. Legacy callers and engine-created
   * standby runs omit it and keep the explicit top-level flag verbatim.
   */
  classification?: ModelClassification;
  plan: TeamPlan;
  /** Standby runs are adoptable cross-session (inbox continuity). */
  standby?: boolean;
  /** Session that owns this interactive task run (foreign sessions do not amend it). */
  owner_session?: string;
}): CtoState {
  // Model-first: a well-formed classification carries ALL four PHASE-0
  // fields — string `type`/`complexity`/`confidence` and boolean
  // `autonomous` — and is the AUTHORITY, mirrored into the top-level field.
  // A malformed/partial runtime classification object — e.g. loosely typed
  // JSON parse missing any of the four or with a non-boolean `autonomous` —
  // must NOT hijack the flag: the explicit caller fallback (opts.autonomous)
  // applies and the malformed classification is not persisted (mirrors
  // isStructuredClassification on the markdown path).
  const classification =
    opts.classification &&
    typeof opts.classification.type === "string" &&
    typeof opts.classification.complexity === "string" &&
    typeof opts.classification.confidence === "string" &&
    typeof opts.classification.autonomous === "boolean"
      ? opts.classification
      : undefined;
  return {
    schema: 2,
    id: opts.id,
    task: opts.task,
    branch: opts.branch,
    autonomous: classification ? classification.autonomous : opts.autonomous,
    ...(classification ? { classification } : {}),
    plan: opts.plan,
    teams: opts.plan.teams.map((t) => ({ id: t.team, status: "pending", escalations: {} })),
    integration: { status: "pending" },
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
    ...(opts.standby === true ? { standby: true } : {}),
    ...(opts.owner_session ? { owner_session: opts.owner_session } : {}),
    // ── schema-2 defaults (br-zps.1): health/scheduler stay undefined until their owning teams write them ──
    budget: defaultBudgetShape(),
    leases: {},
    decisions: [],
    inbox_quarantine: {},
  };
}

/** Default schema-2 budget shape (D3): all limits null, all accounting zero, no per-team spend. */
function defaultBudgetShape(): BudgetState {
  return {
    policy: { token_limit: null, dollar_limit: null, time_limit_ms: null },
    accounting: { tokens_estimated: 0, dollars_estimated: 0, elapsed_ms: 0, per_team: {} },
  };
}

/** Schema-2 fields a canonical state must carry (default-filled by migrateCtoState). */
const SCHEMA2_CANONICAL_FIELDS = ["budget", "leases", "decisions", "inbox_quarantine"] as const;

/**
 * Additive, backward-compatible schema migration (br-zps.1, architecture 3.3):
 * ANY input — schema 1, missing schema, or a partial schema-2 state written
 * directly by a standby/legacy writer — becomes schema 2 with the schema-2
 * fields (`budget`, `leases`, `decisions`, `inbox_quarantine`) default-filled
 * when absent. Present values are preserved untouched, so a complete
 * canonical state passes through unchanged. `health`/`scheduler` stay
 * undefined until their owning teams write them.
 */
export function migrateCtoState(raw: Record<string, unknown>): CtoState {
  const schema = typeof raw.schema === "number" ? raw.schema : 1;
  const state: Record<string, unknown> = { ...raw };
  if (schema < 2) state.schema = 2;
  if (state.budget === undefined) state.budget = defaultBudgetShape();
  if (state.leases === undefined) state.leases = {};
  if (state.decisions === undefined) state.decisions = [];
  if (state.inbox_quarantine === undefined) state.inbox_quarantine = {};
  return state as unknown as CtoState;
}

/**
 * Canonicalize a run's state on disk (architecture 3.1/3.3): read →
 * migrate → re-write via writeCtoState ONLY when the stored state is not
 * yet canonical — schema below 2, or any schema-2 field missing (a partial
 * schema-2 state written directly by a standby writer). Idempotent: a
 * second call on an already-canonical state performs no write.
 */
export function canonicalizeState(runId: string, root: string): CtoState {
  const state = readCtoState(runId, root);
  if (!state) {
    throw new Error(`canonicalizeState: no readable CtoState at ${ctoStatePath(runId, root)}`);
  }
  let needsWrite = true;
  try {
    const raw = JSON.parse(readFileSync(ctoStatePath(runId, root), "utf8")) as Record<string, unknown>;
    const schema = typeof raw.schema === "number" ? raw.schema : 1;
    needsWrite = schema < 2 || SCHEMA2_CANONICAL_FIELDS.some((field) => raw[field] === undefined);
  } catch {
    // unreadable file — persist the migrated in-memory state
  }
  if (needsWrite) writeCtoState(state, root);
  return state;
}

export function readCtoState(runId: string, root: string): CtoState | null {
  try {
    const raw = JSON.parse(readFileSync(ctoStatePath(runId, root), "utf8")) as Record<string, unknown>;
    return migrateCtoState(raw);
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

/**
 * Resolve the authoritative autonomous flag for a CTO run, model-first:
 * - `classification.autonomous` (the model's PHASE-0 decision) is the
 *   AUTHORITY whenever a classification is present — the top-level field
 *   can never override it (new state mirrors the classification, so the two
 *   agree by construction; a legacy file with both must honor the model).
 * - The top-level `autonomous` field is the fallback ONLY when the
 *   classification is absent: legacy runs and the engine-created standby
 *   exception (no user task, nothing to classify).
 */
export function resolveCtoAutonomous(state: Pick<CtoState, "classification" | "autonomous">): boolean {
  const model = state.classification?.autonomous;
  if (model !== undefined) return model;
  return state.autonomous;
}

function teamOf(state: CtoState, teamId: string): CtoState["teams"][number] | undefined {
  return state.teams.find((t) => t.id === teamId);
}

/** Transition one team's run status; persists when a root is given. */
export function setTeamStatus(state: CtoState, teamId: string, status: TeamRunStatus, root: string | null = null): CtoState {
  const team = teamOf(state, teamId);
  if (team) team.status = status;
  if (root) {
    writeCtoState(state, root);
    try {
      recordStageTransition(root, { stageId: teamId, stageStatus: status, runId: state.id });
    } catch {
      // best-effort telemetry — never blocks the state write
    }
  }
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

/**
 * True when the run is finished and must not be selected as active (RC5).
 * A run is terminal when its pause is done/failed, or when ALL teams are
 * done/failed AND integration is done — even when the pause was never
 * stamped done/failed (e.g. runs whose wave completed through the engine
 * without a pause transition).
 *
 * Legacy/non-canonical state may lack `pause` entirely (pre-pause writers;
 * migrateCtoState does not default it). Missing pause is NOT terminal by
 * itself — only the integration/team conditions below can prove terminality.
 */
export function isCtoRunTerminal(state: CtoState): boolean {
  const pauseKind = state.pause?.kind;
  if (pauseKind === "done" || pauseKind === "failed") return true;
  if (state.integration?.status === "done") {
    return state.teams.every((t) => t.status === "done" || t.status === "failed");
  }
  return false;
}
