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
  schema: 2;
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
  // ── schema-2 additions (all optional, default-filled by migrateCtoState) ──
  budget?: BudgetState;                                    // br-zps.2 (cto-operations)
  leases?: Record<string, TeamLease>;                      // br-zps.3 (cto-core)
  decisions?: DecisionMemoryEntry[];                       // br-zps.11 (cto-core)
  inbox_quarantine?: Record<string, QuarantineRecord>;     // br-zps.4 (cto-safety)
  health?: RunHealth;                                      // br-zps.7 (cto-operations)
  scheduler?: SchedulerState;                              // br-zps.8 (cto-operations)
}

// ── Schema-2 shared typed interfaces (cto-core defines; all teams consume) ──

/** Budget limits — declared policy, not enforcement (D3). br-zps.2. */
export interface BudgetPolicy {
  /** null = unlimited (DEFAULT, D3). */
  token_limit: number | null;
  /** null = unlimited (DEFAULT, D3). */
  dollar_limit: number | null;
  /** null = unlimited (DEFAULT, D3). */
  time_limit_ms: number | null;
}

/** Accumulated spend — chars/4 heuristic until a BudgetRecorder is wired (C1). br-zps.2. */
export interface BudgetAccounting {
  /** chars/4 heuristic (C1) — 0 until a recorder is wired. */
  tokens_estimated: number;
  /** 0 until a recorder is wired. */
  dollars_estimated: number;
  elapsed_ms: number;
  per_team: Record<string, { tokens: number; dollars: number; ms: number }>;
}

export interface BudgetState {
  policy: BudgetPolicy;
  accounting: BudgetAccounting;
}

export type BudgetStatus = "unlimited" | "ok" | "approaching" | "exceeded";

/**
 * Team lease — fencing token guarding one team against duplicate spawns.
 * Restarts-safe: a lease with `heartbeat_at` older than `ttl_ms` OR a dead
 * `pid` is reclaimable. Mirrors the dispatcher's DispatcherLeaseRecord.
 * br-zps.3.
 */
export interface TeamLease {
  /** Opaque fence token (crypto.randomUUID). */
  token: string;
  /** ISO. */
  acquired_at: string;
  /** ISO — refreshed by the holding process. */
  heartbeat_at: string;
  /** 0 = until released (no expiry); else heartbeat age > ttl → reclaimable. */
  ttl_ms: number;
  /** Holder PID for liveness (process.kill(pid, 0)). */
  pid: number;
  /** Which team this lease guards. */
  team_id: string;
}

/** Project decision memory entry — tag-based recall only (D6). br-zps.11. */
export interface DecisionMemoryEntry {
  /** ULID-ish or crypto.randomUUID. */
  id: string;
  /** ISO. */
  at: string;
  /** What was decided. */
  decision: string;
  /** Rationale (mandatory, non-empty). */
  why: string;
  /** Exact-match recall keys (project-scoped, D6). */
  tags: string[];
  /** Team id or "cto". */
  by: string;
  /** Escalation ids, issue numbers. */
  refs?: string[];
}

/** Inbox quarantine record — untrusted inbox text is data, never a policy override. br-zps.4. */
export interface QuarantineRecord {
  id: string;
  /** SHA-256 of normalized text. */
  hash: string;
  /** ISO. */
  received_at: string;
  /** Source channel. */
  by: string;
  status: "quarantined" | "admitted" | "rejected";
  /** Rejection reason. */
  reason?: string;
}

/** Deterministic redaction config — replaces the internals of sanitizeEscalation. br-zps.6. */
export interface RedactionConfig {
  /** Regex source strings; default: existing SECRET_LINE. */
  secret_line_patterns: string[];
  /** Regex for inline values (e.g. Bearer tokens in non-key lines). */
  inline_value_patterns: string[];
  /** Default: "[redacted]". */
  replacement: string;
  /** Default: 120. */
  max_title: number;
  /** Default: 2000. */
  max_body: number;
}

/** Run health snapshot derived from CtoState (not events). br-zps.7. */
export interface RunHealth {
  run_id: string;
  healthy: boolean;
  active_teams: number;
  parked_teams: number;
  failed_teams: number;
  pending_escalations: number;
  budget_status: BudgetStatus;
  last_heartbeat_at: string;
  /** Human-readable health issues. */
  issues: string[];
}

/** Wave/digest scheduling state — setInterval while a session is alive (C2). br-zps.8. */
export interface SchedulerState {
  /** Default: 0 (disabled). */
  wave_interval_ms: number;
  /** ISO. */
  last_wave_at?: string;
  /** ISO. */
  next_wave_at?: string;
  /** Mock target (D4: no real channel). */
  digest_recipient?: string;
  last_digest_at?: string;
}

export interface ScheduledDigest {
  run_id: string;
  at: string;
  health: RunHealth;
  recent_decisions: DecisionMemoryEntry[];
  open_escalations: number;
  budget_status: BudgetStatus;
}

/** Task refinement — five-whys output, validated/structured by the engine. br-zps.9. */
export interface RefinementResult {
  original_task: string;
  /** The 5th "why" or convergence point. */
  root_cause: string;
  /** The actionable restatement. */
  refined_task: string;
  /** The chain (1-5, may converge early). */
  whys: string[];
  /** True if root cause reached before 5. */
  converged: boolean;
}

export type DissentTrigger = "high_stakes" | "irreversible" | "contradicts_decision" | "budget_exceeded";

/** Conditional dissent gate evaluation. br-zps.10. */
export interface DissentEvaluation {
  /** null = no dissent needed. */
  trigger: DissentTrigger | null;
  severity: "none" | "advisory" | "blocking";
  reason: string;
  escalate_to: "lead" | "cto" | "user" | null;
}
