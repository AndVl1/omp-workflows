/**
 * CTO sub-orchestration type definitions — pure engine, no domain opinions.
 *
 * The CTO/Head mode sits ON TOP of the existing profile interpreter: a task
 * is decomposed into a {@link TeamPlan}; each team executes a sub-workflow
 * profile (lightweight/standard/...) with its own lead + roster; escalations
 * to the user are asynchronous through an {@link EscalationAdapter} (the
 * interface lives here, implementations are consumer-side).
 *
 * Consumers build their own teams/agents on top of these types without
 * touching the engine. Full design + interview decisions:
 * `vibe-report/sub-orchestration-2026-08-04.md`.
 */

import type { PauseKind } from "../engine/types.js";

/** Git strategy for a team — decided by the CTO at plan time (interview Q3). */
export type WorktreeStrategy = "same_branch" | "separate_worktree";

/** Hard caps enforced by the engine (interview Q5). */
export const MAX_TEAMS = 8;
export const MAX_DECOMPOSITION_DEPTH = 2;

/** Declarative team definition — consumer-owned (teams.json or config). */
export interface TeamDef {
  /** Stable team id; referenced by `type: team` stages via `teams[]`. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Scope ids (from team.config.json `scope_map`) this team owns. */
  scope: string[];
  /** Sub-workflow profile this team executes by default. */
  profile: string;
  /** Lead agent name (3-level model: CTO -> lead -> workers). */
  lead: string;
  /** Worker roles (from team.config.json `roles`) the lead may spawn. */
  roster: string[];
}

/** One team in a concrete run plan. */
export interface TeamPlanEntry {
  /** TeamDef id. */
  team: string;
  /** Scope ids assigned to this team for this run. */
  scope: string[];
  /** Task slice this team owns (CTO decomposition). */
  slice: string;
  /** Resolved sub-workflow profile name for this slice. */
  profile: string;
  /** Git strategy for this team (Q3: CTO decides per task). */
  worktree: WorktreeStrategy;
  /** Team ids this team must wait for before starting. */
  depends_on: string[];
}

/** Full decomposition plan for one CTO run. */
export interface TeamPlan {
  /** CTO run id (slug); matches `.work-state/cto/<id>/`. */
  id: string;
  task: string;
  teams: TeamPlanEntry[];
  created_at: string;
}

// ── Escalation ──────────────────────────────────────────────────────────────

export type EscalationLevel = "question" | "decision" | "needs_human" | "blocker";

export interface EscalationOption {
  id: string;
  label: string;
  /** `now` = apply immediately; `on_next_checkpoint` = apply at next team checkpoint. */
  apply: "now" | "on_next_checkpoint";
}

/**
 * An escalation to the user. Sanitized by the engine before any adapter
 * send (R4): title/body carry no secrets, no full file contents.
 */
export interface Escalation {
  /** Correlation id: `<cto-run>/<team>/<checkpoint>/<attempt>`. */
  id: string;
  level: EscalationLevel;
  /** Short title, no secrets. */
  title: string;
  /** Sanitized context + question. */
  body: string;
  options?: EscalationOption[];
  /** Applied on timeout. */
  default?: string;
  /** 0 = wait forever (default for `blocker`, interview Q4). */
  timeoutMs?: number;
  /** Parent escalation id (follow-up chains). */
  replyTo?: string;
}

export interface EscalationReceipt {
  sent: boolean;
  channelRef?: string;
}

/**
 * Escalation channel — consumer-implemented interface.
 *
 * Answers are NOT delivered back through the adapter: the consumer writes
 * them to `.work-state/cto/<runId>/answers/<esc-id>.json` and the engine /
 * parked agent picks them up at the next checkpoint (durable across
 * restarts and compaction). See `escalation.ts` for the file helpers.
 *
 * The inbound surface (`pollOnce` / `setPlainMessageHandler` /
 * `sendPlainText`) is OPTIONAL — bidirectional channels (telegram today,
 * any consumer transport) implement it; push-only channels (http) skip it.
 * The in-session dispatcher and the standalone bridge duck-type on these
 * methods, so a new transport works the same the moment its adapter
 * implements them (register it via `registerEscalationAdapter`).
 */
export interface EscalationInboundMessage {
  id: string;
  text: string;
  at: string;
}

export interface EscalationAdapter {
  readonly kind: string;
  send(esc: Escalation): Promise<EscalationReceipt>;
  cancel(id: string): Promise<void>;
  /** One inbound poll round: writes answer files, returns the new answers. */
  pollOnce?(): Promise<EscalationAnswer[]>;
  /** Route plain (non-answer) inbound messages — new tasks for the CTO. */
  setPlainMessageHandler?(handler: (msg: EscalationInboundMessage) => void): void;
  /** Send a plain text (not an escalation) back to a user target. */
  sendPlainText?(target: string, text: string): Promise<{ sent: boolean; channelRef?: string }>;
}

export type EscalationStatus = "pending" | "answered" | "expired" | "cancelled" | "undelivered";

/** Per-escalation record inside CtoState — enough for timeout/expiry decisions. */
export interface EscalationRecord {
  status: EscalationStatus;
  /** ISO timestamp of the adapter send (set by the agent/engine on send). */
  sent_at?: string;
  /** Copied from the Escalation; 0/absent = wait forever (blocker default). */
  timeout_ms?: number;
}

export interface EscalationAnswer {
  /** Escalation id this answers. */
  id: string;
  answer: string;
  /** ISO timestamp. */
  at: string;
  /** Channel / user id (telegram|http|cli|...). */
  by: string;
  /** Set when the answer arrived after cancel/expiry (R5). */
  stale?: boolean;
}

// ── Run state ───────────────────────────────────────────────────────────────

export type TeamRunStatus = "pending" | "in_progress" | "parked" | "done" | "failed";

/** Per-CTO-run persistent state under `.work-state/cto/<id>/state.json`. */
export interface CtoState {
  schema: 1;
  id: string;
  task: string;
  branch: string;
  autonomous: boolean;
  plan: TeamPlan;
  teams: Array<{
    id: string;
    status: TeamRunStatus;
    escalations: Record<string, EscalationRecord>;
    dod_path?: string;
  }>;
  integration: {
    status: "pending" | "in_progress" | "done" | "failed";
    note?: string;
  };
  /** Set when a mid-run task was folded into this run (br-k19 amend protocol). */
  amended_at?: string;
  pause: {
    /**
     * Reuses the existing PauseKind vocabulary: `background_wait` for a
     * parked team waiting on an escalation answer, `needs_human` for a
     * hard blocker. No new pause kind — the DoD backstop gate already
     * allows stopping during `background_wait` (gates/dod-backstop.ts).
     */
    kind: PauseKind;
    reason: string;
  };
  updated_at: string;
}
