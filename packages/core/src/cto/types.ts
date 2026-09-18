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

import type {
  ChildJoin,
  CheckpointPolicy,
  CompletionEnvelope,
  CompletionIntent,
  ControlPlaneProvenance,
  MigrationReceipt,
  PendingState,
  RosterPolicy,
  RosterSelection,
  WorkflowContractStatus,
  WorkIdentity,
} from "../engine/types.js";
import type { PauseKind, WorkflowName } from "../engine/types.js";
import type { ModelClassification } from "../engine/run.js";
import type { CtoHandoffBinding } from "../specification/types.js";
import type { PinnedProjectRoot } from "../specification/pinned-root.js";

/** Git strategy for a team — decided by the CTO at plan time (interview Q3). */
export type WorktreeStrategy = "same_branch" | "separate_worktree";

/** Hard caps enforced by the engine (interview Q5). */
export const MAX_TEAMS = 8;
export const MAX_DECOMPOSITION_DEPTH = 2;

/** Shared bounds for mounted CTO specification preparation payloads. */
export const MAX_CTO_SPECIFICATION_REQUESTS = 64;
export const MAX_CTO_SPECIFICATION_DECISIONS = 64;
export const MAX_CTO_SPECIFICATION_FACETS = 8;
export const MAX_PREPARATION_QUEUE_ITEMS = MAX_CTO_SPECIFICATION_REQUESTS * MAX_CTO_SPECIFICATION_FACETS;
export const MAX_CTO_SPECIFICATION_TEXT_BYTES = 16 * 1024;
export const MAX_CTO_SPECIFICATION_ID_BYTES = 128;
export const MAX_CTO_SPECIFICATION_TEAMS = MAX_TEAMS;
export const MAX_CTO_SPECIFICATION_SCOPE_ENTRIES = 32;
export const MAX_CTO_SPECIFICATION_DEPENDENCIES = MAX_TEAMS;
export const MAX_CTO_SPECIFICATION_DOD_ITEMS = 64;
export const MAX_CTO_SPECIFICATION_AGGREGATE_BYTES = 1024 * 1024;
export const MAX_CTO_SPECIFICATION_DECISION_BATCH_BYTES = 1024 * 1024;
export const MAX_CTO_SPECIFICATION_PROOF_BYTES = 256 * 1024;
/** Shared inbound task/answer text bound. CR/LF/TAB are preserved; all other
 * C0/C1, bidi, and line-separator controls are rejected. */
export const MAX_CTO_INBOUND_TEXT_BYTES = 4000;
export function isSafeCtoInboundText(value: unknown, maxBytes = MAX_CTO_INBOUND_TEXT_BYTES): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

const CTO_SPECIFICATION_CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CTO_SPECIFICATION_SAFE_ID = /^[A-Za-z0-9._-]+$/u;

/** Bounded, line-inert text accepted by the CTO preparation boundary. */
export function isCtoSpecificationText(value: unknown, maxBytes = MAX_CTO_SPECIFICATION_TEXT_BYTES, allowEmpty = false): value is string {
  return typeof value === "string"
    && (allowEmpty ? value.length <= maxBytes : value.length > 0)
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !CTO_SPECIFICATION_CONTROL_OR_FORMAT.test(value);
}

/** Durable-safe CTO preparation identifiers, including a UTF-8 byte bound. */
export function isCtoSpecificationSafeId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_CTO_SPECIFICATION_ID_BYTES
    && CTO_SPECIFICATION_SAFE_ID.test(value)
    && !CTO_SPECIFICATION_CONTROL_OR_FORMAT.test(value);
}

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
  /** Unique execution team instance id. */
  team: string;
  /** Pinned consumer TeamDef id used for role/model metadata. */
  team_def_id?: string;
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

export type PlainTextSendOutcome =
  | { sent: true; status: "sent"; channelRef?: string }
  | { sent: false; status: "retryable" | "permanent"; channelRef?: string; reason?: string; httpStatus?: number };

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
  send(esc: Escalation, pinnedRoot?: PinnedProjectRoot): Promise<EscalationReceipt>;
  cancel(id: string, pinnedRoot?: PinnedProjectRoot): Promise<void>;
  /**
   * Durable receiver-side delivery keyed by the dispatcher delivery id.
   * Resident channel registrations must expose this method and claim
   * `canSendWithIdempotency: true`; the dispatcher never falls back to send()
   * when idempotency is required.
   */
  sendWithIdempotency?(esc: Escalation, idempotencyKey: string, pinnedRoot?: PinnedProjectRoot): Promise<EscalationReceipt>;
  /** One inbound poll round: writes answer files, returns the new answers. */
  pollOnce?(pinnedRoot?: PinnedProjectRoot): Promise<EscalationAnswer[]>;
  /** Route plain (non-answer) inbound messages — new tasks for the CTO. */
  setPlainMessageHandler?(handler: (msg: EscalationInboundMessage, pinnedRoot?: PinnedProjectRoot) => void | Promise<void>): void;
  /** Observe each provider-authenticated answer before the poll cursor advances. */
  setAnswerHandler?(handler: (answer: EscalationAnswer, pinnedRoot?: PinnedProjectRoot) => void | Promise<void>): void;
  /** Send a plain text (not an escalation) back to a user target. */
  sendPlainText?(target: string, text: string, pinnedRoot?: PinnedProjectRoot): Promise<PlainTextSendOutcome>;
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
  /** Canonical CTO run owning this answer envelope. */
  run_id: string;
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

// ── Resident control-plane (schema-2 additive; cto-core defines, dispatcher/resolver owners write) ──

/** Declared channel direction in `.omp/escalation.json` (explicit channels[]). */
export type ChannelDirection = "read-write" | "read-only";

/**
 * One admitted work wave (schema-2 additive). Transport source_id admission
 * idempotency: `appendWave` dedupes on `source_id`, so a duplicate inbound
 * task (same transport message id) never starts a second wave.
 */
export const CTO_CONFORMANCE_RECEIPT_REF_RE = /^cto-conformance-receipt-[a-f0-9]{64}$/u;

/** One exact feature postimage bound into a run-level conformance receipt. */
export interface CtoSpecificationConformanceReceiptFeature {
  feature_id: string;
  run_key: string;
  conformance_id: string;
  artifact_sha256: string;
  matrix_digest: string;
  claim_id: string;
}

/** Immutable engine-owned conformance authority consumed by wave close. */
export interface CtoSpecificationConformanceReceipt {
  schema_version: 1;
  receipt_ref: string;
  cto_run_id: string;
  wave_id: string;
  mapping_id: string;
  mapping_record_digest: string;
  conformance_capability_id: string;
  active_claims_digest: string;
  terminal_teams_digest: string;
  features: CtoSpecificationConformanceReceiptFeature[];
}

export interface WaveRecord {
  /** Local wave id (ULID-ish / run-scoped). */
  id: string;
  /** Transport source kind (telegram|http|mock|inbox|cli|...). */
  source: string;
  /** Transport message id — the dedup key (idempotent admission). */
  source_id: string;
  /** The task text that started the wave. */
  task: string;
  /** Slice ids this wave dispatches (leads/workers per slice). */
  slice_ids: string[];
  status: "active" | "done" | "failed";
  /** Terminal aggregate for specification-execution waves. */
  outcome?: "pass" | "blocked";
  /** Selected features whose terminal conformance matrix was blocked. */
  blocked_feature_ids?: string[];
  /** Bounded terminal conformance findings for the wave. */
  findings?: string[];
  /** ISO. */
  started_at: string;
  /** ISO — set by finishWave. */
  finished_at?: string;
  /** Stable identity of the wave's parent work item when admitted by the engine. */
  work_identity?: WorkIdentity;
  /** Content-addressed engine conformance receipt required before terminal replay. */
  conformance_receipt_ref?: string;
}

/**
 * Resolved channel profile (one and only one — architecture-4). `direction`
 * "none" means no channel at all (terminal ask fallback stays available).
 */
export interface ChannelProfile {
  direction: "rw" | "ro" | "none";
  /** Transport kind (telegram|http|mock|...). */
  transport?: string;
  /**
   * Explicit channels[] entry id — present for explicit entries that carry
   * one (the unique per-entry handle createChannelSet binds an adapter to
   * its own entry config); ABSENT for legacy single-adapter profiles and
   * for id-less explicit entries.
   */
  id?: string;
  /** Adapter kind (telegram|http|mock|...). */
  adapter?: string;
  /** Where to route answers / commands (e.g. telegram chatId). */
  ackTarget?: string;
  /** True for the preferred primary channel. */
  primary?: boolean;
  /** Topics this channel is subscribed to (explicit channels[] only). */
  subscriptions?: string[];
}

/** Typed control-plane projection carried alongside legacy CTO fields. */
export type CtoDeliveryIntent = "ack" | "question" | "progress" | "summary";

/** Engine-owned canonical envelope retained until its authenticated send is acknowledged. */
export interface CtoPendingDeliveryObligation {
  entry_name: string;
  envelope_id: string;
  run_id: string;
  intent: CtoDeliveryIntent;
  source: "cto";
  source_ref: string;
  created_revision: number;
  envelope: string;
}

/** Immutable source evidence for a terminal wave summary replay. */
export interface CtoTerminalSummaryEvidence {
  wave_id: string;
  source_revision: number;
  envelope_sha256: string;
  /** Full immutable envelope while delivery remains pending; omitted once settled. */
  envelope?: string;
}

export interface CtoControlPlaneFields {
  completion_intent?: CompletionIntent;
  checkpoint_policy?: CheckpointPolicy;
  roster_policy?: RosterPolicy;
  roster_selection?: RosterSelection;
  roster_selections?: Record<string, RosterSelection>;
  work_identity?: WorkIdentity;
  pending?: PendingState;
  child_join?: ChildJoin;
  child_joins?: ChildJoin[];
  completion_envelope?: CompletionEnvelope;
  migration?: MigrationReceipt;
  control_plane_provenance?: ControlPlaneProvenance;
  control_plane_status?: WorkflowContractStatus;
  pending_delivery_obligations?: CtoPendingDeliveryObligation[];
  terminal_summary_evidence?: CtoTerminalSummaryEvidence[];
}



/** Exact durable file image captured by CTO specification preparation WAL. */
export interface CtoSpecificationPreparationFileImage {
  path: string;
  exists: boolean;
  sha256: string;
  /** Exact byte count of the captured regular file. */
  byte_count?: number;
  dev?: number;
  ino?: number;
  /** Content-addressed preimage stored under the owning CTO run. */
  preimage_ref?: string;
  /** Legacy inline preimage; read-only migration compatibility. */
  bytes_base64?: string;
}

/** Cross-tree preparation intent and terminal marker. */
export interface CtoSpecificationPreparationTransaction {
  /** Identifies the owner of this shared transaction field. */
  kind?: "execution" | "bootstrap";
  schema_version: 1;
  id: string;
  status: "prepared" | "committing" | "committed" | "rolled_back";
  request_digest: string;
  /** Exact engine-issued source/wave selectors required for rollback retry. */
  source_id?: string;
  wave_id?: string;
  root_identity: { canonical_path: string; dev: number; ino: number };
  expected_state_revision: number;
  feature_state: {
    path: string;
    before: CtoSpecificationPreparationFileImage;
    after?: CtoSpecificationPreparationFileImage;
  };
  dod_files: Array<{
    path: string;
    before: CtoSpecificationPreparationFileImage;
    after?: CtoSpecificationPreparationFileImage;
  }>;
  updated_at: string;
  error?: string;
}


/** Per-CTO-run persistent state under `.work-state/cto/<id>/state.json`. */
export interface CtoState extends CtoControlPlaneFields {
  schema: 2;
  id: string;
  task: string;
  branch: string;
  /**
   * LEGACY / engine-created autonomy flag. For task runs this is read-compat
   * only: new state mirrors `classification.autonomous` here so old readers
   * keep working, and the top-level flag NEVER overrides a present
   * classification. Standby runs are the documented engine-created exception
   * (no user task to classify): they carry `autonomous: true` and NO
   * `classification` field.
   */
  autonomous: boolean;
  /**
   * Model-first PHASE-0 classification (schema-2 optional). Persisted for NEW
   * task runs: `classification.autonomous` is the AUTHORITY for the run's
   * autonomy; the top-level `autonomous` field is mirrored (never
   * independent) when a classification is present. Absent on legacy runs and
   * on engine-created standby runs (nothing to classify).
   */
  classification?: ModelClassification;
  plan: TeamPlan;
  teams: Array<{
    id: string;
    status: TeamRunStatus;
    escalations: Record<string, EscalationRecord>;
    /**
     * Where this team's dod.json lives, relative to the run root — accepted
     * as EITHER the directory containing dod.json OR the dod.json file
     * itself. Every consumer resolves it through the canonical resolver
     * (engine/dod.ts resolveDodPath); unsafe paths (traversal, absolute,
     * symlinks) fail closed.
     */
    dod_path?: string;
    /**
     * Slice this team owns in a resident wave (schema-2 additive; set by the
     * CTO at plan time). The slice gate keys off it (see cto/slice-gate.ts).
     */
    slice_id?: string;
    /** Explicit specification selector bound to this execution slice. */
    feature_id?: string;
    /** Explicit handoff run key bound to this execution slice. */
    run_key?: string;
    /** Explicit handoff task id bound to this execution slice. */
    task_id?: string;
    /** Canonical DoD digest used to reject replay with changed plan input. */
    dod_digest?: string;
    /** Consumer TeamDef id used to build the concrete plan entry. */
    team_def_id?: string;
    /**
     * Per-slice model classification (schema-2 additive; PHASE-0 contract).
     * Required before lead/worker dispatch (architecture-3).
     */
    classification?: ModelClassification;
    /**
     * Matrix-resolved workflow for this slice (schema-2 additive). Must equal
     * resolveWorkflow(type, complexity, autonomous) — validated by the gate.
     */
    workflow?: WorkflowName;
    completion_intent?: CompletionIntent;
    checkpoint_policy?: CheckpointPolicy;
    roster_policy?: RosterPolicy;
    roster_selection?: RosterSelection;
    work_identity?: WorkIdentity;
    pending?: PendingState;
    child_join?: ChildJoin;
    completion_envelope?: CompletionEnvelope;
    control_plane_provenance?: ControlPlaneProvenance;
    control_plane_status?: WorkflowContractStatus;
  }>;
  integration: {
    status: "pending" | "in_progress" | "done" | "failed";
    note?: string;
  };
  /** Exact full selector request retained when readiness excludes rows. */
  /** Canonical digest for CTO specification-execution preparation replay; distinct from native preparation_digest. */
  specification_execution_preparation_digest?: string;
  specification_execution_requested_selections?: Array<{ feature_id: string; run_key: string }>;
  /** Readiness findings retained alongside a mixed execution wave. */
  specification_execution_exclusions?: Array<{ feature_id: string; run_key: string; findings: string[] }>;
  /** Exact feature/run state bound to the mounted CTO confirmation proof. */
  specification_execution_anchor?: { feature_id: string; run_key: string };
  amended_at?: string;
  /**
   * Standby run marker (schema-2 optional). Set by the inbox bootstrap and
   * the standby prompt; standby runs are adoptable cross-session so queued
   * inbox tasks are never lost when a new session starts.
   */
  standby?: boolean;
  /**
   * OMP session id that owns an interactive task run (schema-2 optional).
   * Foreign sessions must not amend an owned run (fresh contract instead);
   * standby runs have no owner. Absent on legacy runs — they remain
   * amendable (status quo).
   */
  /** Canonical fresh-preparation request digest for idempotent replay checks. */
  preparation_digest?: string;
  /** Durable cross-tree intent for CTO specification preparation/recovery. */
  specification_preparation_transaction?: CtoSpecificationPreparationTransaction;
  owner_session?: string;
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
  /** Monotonic CAS revision; legacy documents are read as revision 0. */
  state_revision?: number;
  // ── schema-2 additions (all optional, default-filled by migrateCtoState) ──
  budget?: BudgetState;                                    // br-zps.2 (cto-operations)
  leases?: Record<string, TeamLease>;                      // br-zps.3 (cto-core)
  decisions?: DecisionMemoryEntry[];                       // br-zps.11 (cto-core)
  inbox_quarantine?: Record<string, QuarantineRecord>;     // br-zps.4 (cto-safety)
  health?: RunHealth;                                      // br-zps.7 (cto-operations)
  scheduler?: SchedulerState;                              // br-zps.8 (cto-operations)
  // ── resident control-plane (schema-2 additive; default-filled by migrateCtoState, written by cto-core) ──
  /**
   * Append-only wave records (state_contract.wave_history). Idempotent on
   * transport `source_id`; a standby/resident run accumulates waves across
   * sessions and stays active (isCtoRunTerminal honors the standby carve-out).
   */
  wave_history?: WaveRecord[];
  /** Set only while a wave is running; cleared by finishWave (state_contract.resident). */
  active_wave_id?: string;
  /**
   * Resolved channel profile (state_contract.channel). Written by the
   * dispatcher/resolver owners; prompt rendering derives from it.
   */
  channel_profile?: ChannelProfile;
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
  /** Durable wake delivery phase for admitted tasks (at-least-once). */
  wake_status?: "pending" | "delivered";
  /** Claim fencing concurrent wake callbacks without losing crash recovery. */
  wake_claim?: {
    pid: number;
    /** OS process start identity, preventing PID-reuse ownership theft. */
    start_identity: string;
    token: string;
    started_at: string;
  };
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

// ── Specification mapping (T095) ────────────────────────────────────────────

/** Lifecycle of the durable CTO specification mapping record. */
export type CtoMappingStatus =
  | "candidate"
  | "awaiting_confirmation"
  | "confirmed"
  | "revision_required"
  | "stopped"
  | "stale"
  | "blocked";

/** One task's ownership in the mapping: feature, team, slice, and closure set. */
export interface CtoTaskOwnership {
  feature_id: string;
  task_id: string;
  team_id: string;
  slice_id: string;
  requirement_ids: string[];
  verification_ids: string[];
  evidence_refs: string[];
  /** Predecessor task ids; acyclic. */
  depends_on: string[];
}

/** Shared resource that forces ordering between otherwise parallel tasks. */
export interface CtoSharedContractConstraint {
  contract_id: string;
  /** What the contract protects (path, interface, resource). */
  contract: string;
  /** Owning team id. */
  owner: string;
  task_ids: string[];
  /** Serialization order across the listed tasks. */
  order: number;
  reason: string;
  requires_serialization: boolean;
}

/** Parallel/serial verdict for one slice, with its worktree strategy. */
export interface CtoParallelizationDecision {
  slice_id: string;
  decision: "parallel" | "serial";
  reason: string;
  worktree: WorktreeStrategy;
  /** Slices that must complete first. */
  depends_on_slice_ids: string[];
  /** Shared contracts constraining this slice. */
  shared_contract_ids: string[];
}

/**
 * Durable, versioned mapping from a readable specification to the CTO
 * execution plan. `mapping_hash` is content-addressed over the mapping body;
 * handoff bindings carry the exact frozen digests and artifact versions.
 */
export interface CtoSpecificationMapping {
  schema_version: 1;
  mapping_id: string;
  /** Monotonic per-mapping revision. */
  mapping_version: number;
  /** SHA-256 over the canonicalized mapping body. */
  mapping_hash: string;
  feature_ids: string[];
  /** ISO timestamp. */
  created_at: string;
  updated_at?: string;
  /** Immutable bindings to the frozen handoff versions in scope. */
  handoff_bindings: CtoHandoffBinding[];
  task_to_slice: CtoTaskOwnership[];
  shared_contracts: CtoSharedContractConstraint[];
  parallelization: CtoParallelizationDecision[];
  /** Checkpoint artifact ref, when the mapping awaits or recorded one. */
  checkpoint_ref: string | null;
  status: CtoMappingStatus;
}
