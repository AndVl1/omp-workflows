/**
 * Workflow type definitions.
 *
 * Mirrors workflows/_schema.json. Kept in TypeScript so the engine gets static
 * guarantees; the JSON files on disk are loaded and validated against these shapes.
 */

import type { AgentMappingState } from "./agent-mapping.js";
import type { ObservabilityPointer } from "../observability/events.js";

export type TaskType = "FEATURE" | "REFACTOR" | "OPS" | "BUG_FIX" | "SPEC" | "REGRESS" | "INVESTIGATION" | "REVIEW" | "HOTFIX" | "PRODUCT_DISCOVERY";
export type Complexity = "QUICK" | "MEDIUM" | "COMPLEX" | "CRITICAL";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type WorkflowName =
  | "full-feature"
  | "standard"
  | "lightweight"
  | "debug-cycle"
  | "bug-fix"
  | "emergency"
  | "research"
  | "review"
  | "spec-preparation"
  | "feature-regression"
  | "product-discovery"
  | "cto"
  | (string & {});

export type StageType = "orchestrator" | "single" | "consilium" | "document" | "bash" | "none" | "team";

export type StageStatus = "pending" | "in_progress" | "done" | "skipped" | "failed";

export type PauseKind =
  | "none"
  | "background_wait"
  | "user_checkpoint"
  | "needs_human"
  | "failed"
  | "done";
export type CompletionIntentMode = "complete_outcome" | "handoff_only";
export type CompletionAcceptance = "dod_and_artifacts" | "explicit_human_acceptance";
export type CompletionIntentSource = "user" | "workflow_policy" | "migration";

/**
 * Desired terminal product. This is deliberately independent from checkpoint
 * permission: completing an outcome never grants permission to skip consent.
 */
export interface CompletionIntent {
  mode: CompletionIntentMode;
  acceptance: CompletionAcceptance;
  source: CompletionIntentSource;
  rationale: string;
}

export type CheckpointPolicyDefault = "required_human" | "autonomous_allowed";
export type CheckpointPolicyScope = "decision";
export type CheckpointPolicyPhase = "before_dispatch" | "before_advance";
export type CheckpointRuleKind =
  | "product_approval"
  | "clarification"
  | "architecture_choice"
  | "implementation_approval"
  | "review_fix"
  | "regression_plan"
  | "integration_acceptance"
  | "security"
  | "destructive_side_effect"
  | "production"
  | "bundle_activation"
  | "migration_cutover"
  | "custom";
export type HardHumanCheckpointKind = Exclude<CheckpointRuleKind, "custom"> | "custom";

export interface CheckpointRule {
  kind: CheckpointRuleKind;
  default: CheckpointPolicyDefault;
  /** Empty only for migration-generated rules whose decisions are not known yet. */
  allowed_decisions: string[];
  phase: CheckpointPolicyPhase;
  rationale: string;
}

export interface CheckpointPolicy {
  default: CheckpointPolicyDefault;
  scope: CheckpointPolicyScope;
  hard_human: HardHumanCheckpointKind[];
  rules: Record<string, CheckpointRule>;
  source: "profile" | "user" | "migration";
  policy_version: number;
  rationale: string;
}

export type CheckpointActorKind = "user" | "orchestrator" | "system";
export type CheckpointAnswerChannel = "terminal" | "escalation";

/**
 * Proof presented by a checkpoint caller.  The proof is only a reference into
 * the engine-owned durable answer ledger; none of these values are trusted
 * until the matching immutable record is found and its binding is recomputed.
 */
export interface CheckpointAnswerProof {
  answer_id: string;
  nonce: string;
  channel: CheckpointAnswerChannel;
  reference: string;
  binding: string;
}

/**
 * Immutable answer identity issued by a trusted terminal/escalation ingest
 * path.  `consumed_at` is an audit marker: exact idempotent replay remains
 * valid, while a different decision/context can never reuse the answer.
 */
export interface TrustedCheckpointAnswer {
  answer_id: string;
  nonce: string;
  channel: CheckpointAnswerChannel;
  reference: string;
  run_id: string;
  stage_id: string;
  checkpoint_id: string;
  work_identity_hash: string;
  capability_id: string;
  capability_epoch: string;
  policy_hash: string;
  decision: string;
  binding: string;
  issued_at: string;
  consumed_at?: string;
}

export interface CheckpointActor {
  kind: CheckpointActorKind;
  /** Display/reference value; human authorization never trusts this alone. */
  ref: string;
  /** Durable terminal/escalation answer proof required for human authorization. */
  proof?: CheckpointAnswerProof;
}
export type CheckpointAuthorization = "human" | "policy_auto";

export interface RosterMultiplicity {
  min: number;
  max: number;
}

export interface RosterTriggers {
  complexity: Complexity[];
  confidence: Confidence[];
  scope_flags: string[];
  evidence: string[];
}

export interface RosterBudget {
  token_limit: number | null;
  dollar_limit: number | null;
}

export type RosterSelectionMode = "pre_dispatch_minimum_valid";
export type RosterSelectionStopReason =
  | "minimum_valid_set"
  | "risk_trigger_satisfied"
  | "max_workers"
  | "budget_limit";

/**
 * Allowed semantic worker pool. Concrete agents are resolved by the active
 * mapping and never become caller-supplied authority.
 */
export interface RosterPolicy {
  allowed_roles: string[];
  required_roles: string[];
  required_facets: string[];
  min_workers: number;
  max_workers: number;
  multiplicity: Record<string, RosterMultiplicity>;
  prefer_distinct_agents: boolean;
  selection_mode: RosterSelectionMode;
  triggers: RosterTriggers;
  /** Null means no bound for that metric; this is not a liveness timeout. */
  budget: RosterBudget;
}

export interface RosterSelectionEntry {
  slot_id: string;
  role: string;
  occurrence: number;
  facet: string | null;
  agent: string;
  reason: string;
}

export interface RosterOmittedEntry {
  role: string;
  reason: string;
}

/**
 * Atomic, immutable selection snapshot. It is a dispatch input, never a
 * user-approval record.
 */
export interface RosterSelection {
  snapshot_id: string;
  run_key: string;
  wave_id: string;
  slice_id: string;
  session_id: string;
  workflow: WorkflowName;
  stage_id: string;
  profile_hash: string;
  policy_hash: string;
  scope_hash: string;
  mapping_hash: string;
  capability_epoch: string;
  selected: RosterSelectionEntry[];
  omitted: RosterOmittedEntry[];
  triggers: string[];
  stop_reason: RosterSelectionStopReason;
  selected_at: string;
  frozen_at: string;
}

/**
 * Stable identity carried by dispatch, native results, child joins,
 * completion envelopes and observability. `dispatch_id` identifies an
 * attempt; `task_id` remains stable for the same slot assignment.
 */
export interface WorkIdentity {
  run_id: string;
  wave_id: string;
  slice_id: string;
  session_id: string;
  workflow: WorkflowName;
  stage_id: string;
  stage_cursor: string;
  capability_id: string;
  capability_epoch: string;
  slot_id: string;
  task_id: string;
  dispatch_id: string;
  attempt: number;
  worker_id: string;
}

export type PendingReason = "provider_running" | "awaiting_result" | "transport_reconnect";
export interface PendingLease {
  token: string;
  observed_at: string;
  revoked_at: string | null;
}

/**
 * Pending is a durable lifecycle state, not a failure or a replacement
 * signal. Terminal transitions retain the same work identity.
 */
export interface PendingState {
  identity: WorkIdentity;
  status: "authorized" | "running" | "pending" | "succeeded" | "failed" | "cancelled";
  pending_reason?: PendingReason;
  provider_ref?: string;
  lease?: PendingLease;
  terminal_signal?: string | null;
  retry_of?: string | null;
  updated_at: string;
}
export type PendingDispatchState = PendingState;

export type ChildJoinStatus = "planned" | "authorized" | "pending" | "succeeded" | "failed" | "cancelled" | "conflict";
export interface ChildJoin {
  parent: WorkIdentity;
  child: WorkIdentity;
  state: ChildJoinStatus;
  expected_artifact_ids: string[];
  completion_envelope_ref: string | null;
  attempt: number;
  created_at: string;
  joined_at: string;
}

export type CompletionOutcome = "pending" | "succeeded" | "failed" | "cancelled";
export type CompletionTerminalSignal = "workflow_complete" | "native_tool_result" | "provider_terminal" | "contract_failure";
export type CompletionSchemaStatus = "met" | "failed";
export type CompletionDodStatus = "met" | "pending" | "failed";

export interface CompletionArtifactRef {
  artifact_id: string;
  path: string;
  sha256: string;
  schema_status: CompletionSchemaStatus;
  dod_status: CompletionDodStatus;
}

/**
 * Unified terminal/pending result envelope consumed by workflow_complete,
 * trusted native reconciliation and child joins.
 */
export interface CompletionEnvelope {
  schema_version: 1;
  identity: WorkIdentity;
  outcome: CompletionOutcome;
  terminal_signal: CompletionTerminalSignal | null;
  artifact_refs: CompletionArtifactRef[];
  evidence_ref: string | null;
  conflict_ref: string | null;
  completed_by: "workflow_complete" | "synchronous_tool_result" | "engine_task_caller";
  emitted_at: string;
}

export type WorkflowLifecycleStatus = "ready" | "pending" | "paused" | "complete" | "skipped" | "failed" | "blocked" | "invalid";
export interface WorkflowContractStatus {
  stage: StageStatus;
  lifecycle: WorkflowLifecycleStatus;
  pause: PauseKind;
  reason: string;
}

export type ControlPlaneFieldSource = "typed" | "profile" | "state" | "migration" | "legacy" | "none";
export type ControlPlaneMigrationStatus = "typed" | "migrated" | "conflict" | "invalid";
export interface ControlPlaneProvenance {
  completion_intent: ControlPlaneFieldSource;
  checkpoint_policy: ControlPlaneFieldSource;
  roster_policy: ControlPlaneFieldSource;
  roster_selection: ControlPlaneFieldSource;
  work_identity: ControlPlaneFieldSource;
  pending: ControlPlaneFieldSource;
  child_join: ControlPlaneFieldSource;
  completion_envelope: ControlPlaneFieldSource;
  legacy_inputs: string[];
  warnings: string[];
  status: ControlPlaneMigrationStatus;
}

export interface MigrationReceipt {
  id: string;
  from_schema: number;
  to_schema: number;
  source_profile_hash: string;
  target_profile_hash: string;
  source_policy_hash: string | null;
  target_policy_hash: string;
  legacy_inputs: string[];
  warnings: string[];
  status: "complete" | "blocked";
  migrated_at: string;
}

export interface Classification {
  type: TaskType;
  complexity: Complexity;
  confidence: Confidence;
  workflow: WorkflowName;
  /**
   * Legacy/model routing autonomy input retained during migration. It may
   * influence profile routing in legacy callers, but it is never checkpoint
   * permission and cannot authorize a typed decision.
   */
  autonomous: boolean;
  /**
   * Optional orthogonal terminal-outcome intent. This is not checkpoint
   * permission and is retained separately from the routing autonomy input.
   */
  completion_intent?: CompletionIntent;
  /** Model's one-sentence justification for the autonomy decision. */
  autonomous_reason?: string;
}

export interface ProfileMatch {
  type: TaskType[];
  complexity?: Complexity[];
}

export interface StageDef {
  id: string;
  title: string;
  type: StageType;
  /** Role-specific instructions supplied to the executor. */
  prompt?: string;
  description?: string;
  /** For consilium: parallel roles. */
  roles?: string[];
  /** For single: the role. */
  role?: string;
  /** For team: teams to run as sub-workflows (ids from teams.json). */
  teams?: string[];
  /** For team: sub-workflow profile name each team executes. */
  profile?: string;
  /** For team: integration contract after teams return. */
  integration?: {
    /** Stage id that reviews the merged team output. */
    stage: string;
    /** Action when a team failed: re-spawn | drop scope | escalate_user. */
    on_failure: string;
  };
  /** Consilium parallel flag (always true for consilium in practice). */
  parallel?: boolean;
  /** Artifact ids this stage reads from `.work-state/artifacts/<id>.json`. */
  consumes?: string[];
  /** Artifact ids this stage writes to `.work-state/artifacts/<id>.json`. */
  produces?: string | string[];
  /** Human checkpoint label. */
  checkpoint?: string;
  /**
   * Typed checkpoint permission. `autonomous` remains a display/migration
   * input only and never authorizes a decision.
   */
  checkpoint_policy?: CheckpointPolicy;
  /** Optional profile/stage completion target; never permission. */
  completion_intent?: CompletionIntent;
  /** Typed allowed semantic-role pool; legacy roles/role stay exact-manifest. */
  roster_policy?: RosterPolicy;
  /** Legacy autonomous prose: display/migration input only, never authorization. */
  autonomous?: string;
  /** Bash stages: the deterministic shell command to execute. */
  command?: string;
  /**
   * For document stages: the executable document contract. The engine —
   * not an agent — renders the declared document (see engine/product-prd.ts
   * for the shipped product-prd renderer).
   */
  document?: {
    /** Output format; only "markdown" is shipped. */
    format: string;
    /** Renderer selector; only "product-prd" is shipped. */
    renderer: string;
    /** Safe relative path of the document inside the state dir. */
    path: string;
  };
  /**
   * Explicit consilium fan-in resolutions: documented, deliberate handling
   * of schema-required scalar disagreements for this stage's produces. A
   * resolution applies only to exactly `(artifact, field)` and every applied
   * resolution is recorded in the synthesis provenance (`conflicts`) with
   * the winning slot and losing values — never a silent choice.
   */
  fan_in?: { resolutions?: StageFanInResolution[] };
  /** Gate condition; gate must hold for stage to be marked `done`. */
  gate?: string;
  /** Conditional roster adjustments. */
  conditional?: Array<{ if: string; add?: string; remove?: string }>;
  /** Skip-if expression. */
  skip_if?: string;
  /** Loop back to a previous stage. */
  loop?: {
    back_to: string;
    until: string;
    max_iterations: number;
    on_exhausted: string;
  };
}

export interface Profile {
  name: WorkflowName;
  title: string;
  description: string;
  match: ProfileMatch;
  stages: StageDef[];
  /** Optional run default; completion intent is never checkpoint permission. */
  completion_intent?: CompletionIntent;
  /** Optional default inherited by stages with declared checkpoints. */
  checkpoint_policy?: CheckpointPolicy;
  /** Custom profiles are explicit-only unless registered as auto-selectable. */
  autoSelect?: boolean;
}

export interface DispatchCompletion {
  dispatch_id: string;
  cursor_epoch: string;
  outcome: "succeeded" | "failed" | "cancelled";
  artifact_ids: string[];
  evidence: string;
  completed_by: "workflow_complete" | "synchronous_tool_result" | "engine_task_caller";
  completed_at: string;
  /** Additive identity binding; legacy completion records may omit it. */
  work_identity?: WorkIdentity;
}

export interface DispatchRecord {
  id: string;
  role: string;
  agent: string;
  tool_call_id?: string;
  /**
   * `pending` is resumable background work, never an elapsed-time failure.
   * Legacy records remain readable during migration.
   */
  status: "authorized" | "running" | "pending" | "succeeded" | "failed" | "cancelled";
  attempt: number;
  created_at: string;
  completed_at?: string;
  completion?: DispatchCompletion;
  work_identity?: WorkIdentity;
  pending?: PendingState;
  completion_envelope?: CompletionEnvelope;
}


/**
 * A resolved dispatch occurrence for a stage. `slot` is the stable unique
 * identity used by capability rosters, dispatch markers, authorization and
 * join/reconciliation; `role` is the semantic profile role it derives from.
 * Repeated semantic roles normalize to distinct deterministic slots (e.g.
 * `analyst#1`, `analyst#2`) that all resolve to the same concrete agent, so
 * multiplicity is never collapsed by Set/object-key deduplication.
 */
export interface DispatchSlot {
  /** Legacy slot spelling retained for existing callers. */
  slot: string;
  /** Canonical persisted spelling; equivalent to `slot` when present. */
  slot_id?: string;
  /** Semantic role from which this occurrence was resolved. */
  role: string;
  occurrence?: number;
  facet?: string | null;
}

export interface CapabilityRosterEntry {
  /**
   * Dispatch slot identity. For unique semantic roles this equals the role
   * name; repeated roles normalize to stable numbered slots (`analyst#1`,
   * `analyst#2`) so every occurrence is independently dispatchable while
   * `agent` stays the configured concrete agent for the semantic role.
   */
  role: string;
  agent: string;
  slot_id?: string;
  semantic_role?: string;
  occurrence?: number;
  facet?: string | null;
}

export interface DispatchCapabilityState {
  /** Legacy aliases retained for schema-1 readers; strict armed dispatch ignores them. */
  run?: string;
  workflow?: WorkflowName;
  profile_hash?: string;
  stage?: string;
  roles?: string[];
  capability_id?: string;
  dispatch_token_hash?: string;
  advance_token_hash?: string;
  issued_for?: { run_key: string; branch: string; workflow: WorkflowName; profile_hash: string; stage_cursor: string; cursor_epoch: string };
  kind: "none" | "single" | "consilium";
  expected_roles?: string[];
  expected_count?: number;
  expected_roster?: CapabilityRosterEntry[];
  /** Frozen adaptive selection bound to this capability epoch. */
  roster_selection?: RosterSelection;
  work_identity?: WorkIdentity;
  pending?: PendingState[];
  status?: "ready" | "dispatched" | "joining" | "complete" | "invalidated";
  dispatches?: DispatchRecord[];
}

export interface JoinSummary {
  stage_id: string;
  cursor_epoch: string;
  dispatch_ids: string[];
  roles: string[];
  evidence?: string;
  joined_at: string;
  work_identity?: WorkIdentity;
}

/**
 * Durable checkpoint decision. The original fields are migration-compatible
 * read inputs. Typed authorization requires the additive provenance fields;
 * callers MUST NOT treat `mode: "autonomous"` or a string actor as proof.
 */
export interface CheckpointDecision {
  stage_id: string;
  checkpoint: string;
  mode: "interactive" | "autonomous";
  decision: string;
  /** Legacy actor spelling; typed callers use `actor_provenance`. */
  actor: string;
  rationale: string;
  decided_at: string;
  run_id?: string;
  checkpoint_id?: string;
  checkpoint_kind?: CheckpointRuleKind;
  authorization?: CheckpointAuthorization;
  actor_provenance?: CheckpointActor;
  capability_id?: string;
  capability_epoch?: string;
  policy_hash?: string;
  work_identity?: WorkIdentity;
}

/**
 * Canonical decision envelope for new callers. `CheckpointDecision` above is
 * retained as the schema-1 migration record with string actor/mode fields.
 */
export interface TypedCheckpointDecision {
  run_id: string;
  stage_id: string;
  checkpoint_id: string;
  checkpoint_kind: CheckpointRuleKind;
  decision: string;
  authorization: CheckpointAuthorization;
  actor: CheckpointActor;
  capability_id: string;
  capability_epoch: string;
  policy_hash: string;
  rationale: string;
  decided_at: string;
}
/** Durable provenance of one slot's artifact contribution to a consilium stage. */
export interface SlotArtifactRecord {
  /** Absolute path of the namespaced per-slot snapshot (`<id>-<slot>.json`). */
  path: string;
  /** SHA-256 of the normalized artifact JSON captured at completion. */
  hash: string;
}

/**
 * Explicit fan-in resolution declared on a consilium stage. Declaring a
 * resolution is the ONLY way a schema-required scalar disagreement may be
 * resolved without blocking handoff; every applied resolution is recorded
 * durably in the synthesis provenance (see {@link FanInConflictRecord}) so
 * no disagreement is ever discarded silently.
 */
export interface StageFanInResolution {
  /** Artifact id the resolution applies to (exact match). */
  artifact: string;
  /** Top-level field path within the artifact (e.g. `chosen`, `summary`). */
  field: string;
  /** Deterministic resolution strategy. */
  strategy: "first_slot";
  /** Why this disagreement is deliberately resolved (persisted verbatim). */
  rationale: string;
}

/** Durable provenance of a resolved required-scalar disagreement. */
export interface FanInConflictRecord {
  artifact: string;
  /** Field path the disagreement occurred at (e.g. `summary`). */
  field: string;
  /** How the disagreement was resolved: declared resolution or lenient policy. */
  strategy: "first_slot" | "lenient";
  /** The winning scalar value (deterministic first-slot-wins). */
  resolved_value: unknown;
  /** Slot whose value won (first roster-order contributor of the field). */
  winner_slot: string;
  /** Every slot that disagreed and the value it offered. */
  losing_values: Array<{ slot: string; value: unknown }>;
  /** Rationale of the declared resolution (or the lenient-policy explanation). */
  rationale: string;
  resolved_at: string;
}

/** Per-stage slot artifact provenance plus deterministic synthesis evidence. */
export interface StageSlotRecords {
  /** slot -> artifactId -> record */
  slots: Record<string, Record<string, SlotArtifactRecord>>;
  /**
   * Deterministic synthesis provenance: artifactId -> contributing slots
   * plus any resolved required-scalar disagreements (never silent).
   */
  shared?: Record<string, { slots: string[]; synthesized_at: string; conflicts?: FanInConflictRecord[] }>;
}

export interface LoopIterationRecord {
  /** 1-based re-entry number (1 = first loop-back). */
  iteration: number;
  /** Cursor epoch that authorized the loop stage completion. */
  from_epoch: string;
  /** Fresh cursor epoch issued for the re-entered stage. */
  to_epoch: string;
  until_satisfied: boolean;
  at: string;
}

/**
 * Durable bounded-loop state. `reentries` counts the loop-backs actually
 * performed; when the `until` expression still fails and `reentries` has
 * reached `max_iterations`, the loop is exhausted and maps to
 * `needs_human` or `failed` via `on_exhausted`.
 */
export interface LoopState {
  /** Stage id that owns the loop. */
  stage_id: string;
  back_to: string;
  until: string;
  max_iterations: number;
  on_exhausted: string;
  reentries: number;
  /** Cursor epoch of the most recent re-entry capability. */
  epoch: string;
  status: "running" | "complete" | "exhausted";
  outcome?: "needs_human" | "failed";
  /** Durable history of loop re-entries. */
  history: LoopIterationRecord[];
  ended_at?: string;
}

export interface TeamState {
  schema: 1;
  branch: string;
  classification: Classification;
  task: string;
  /** User feedback and prior task text retained across continuations. */
  history?: Array<{ task: string; feedback?: string; at: string }>;
  /** Legacy read-compat input; never overrides typed completion/checkpoint policy. */
  autonomous?: boolean;
  workflow_override: boolean;
  /** Persisted terminal-outcome intent; never checkpoint permission. */
  completion_intent?: CompletionIntent;
  /** Persisted typed checkpoint policy; malformed values fail closed. */
  checkpoint_policy?: CheckpointPolicy;
  issue: { number: number; url?: string } | null;
  stage_cursor: string;
  stages: Array<{ id: string; status: StageStatus }>;
  artifacts: Record<string, string>;
  pause: { kind: PauseKind; reason: string };
  updated_at: string;
  policy?: { strict_orchestrator?: boolean };
  /** Scope snapshot used to resolve conditional rosters across durable handoffs. */
  scope?: {
    scope: string[];
    has_security: boolean;
    has_infra: boolean;
    has_ui: boolean;
    has_runtime: boolean;
    dev_agent: string | null;
  };
  profile_hash?: string;
  cursor_epoch?: string;
  run_key?: string;
  dispatch_capability?: DispatchCapabilityState;
  /** Stable identity for the current work item, when migrated/issued. */
  work_identity?: WorkIdentity;
  /** Legacy schema-1 decisions retained only as migration input. */
  checkpoint_decisions?: CheckpointDecision[];
  /** Immutable trusted terminal/escalation answers referenced by human decisions. */
  trusted_checkpoint_answers?: TrustedCheckpointAnswer[];
  /** Canonical policy-bound decisions with trusted actor provenance. */
  typed_checkpoint_decisions?: TypedCheckpointDecision[];
  roster_selection?: RosterSelection;
  /** Optional per-stage snapshots for callers retaining historical selections. */
  roster_selections?: Record<string, RosterSelection>;
  /** Resumable provider/background lifecycle for the current work item. */
  pending?: PendingState;
  /** Durable orchestrator child ledger entry for the current parent stage. */
  child_join?: ChildJoin;
  child_joins?: ChildJoin[];
  /** Canonical output/result envelope for the current work item. */
  completion_envelope?: CompletionEnvelope;
  /** Explicit receipt for schema/profile legacy migration. */
  migration?: MigrationReceipt;
  join_summary?: JoinSummary;
  /** Durable bounded-loop state (additive). */
  loop_state?: LoopState;
  /** Per-slot consilium artifact provenance + synthesis evidence (additive). */
  slot_artifacts?: Record<string, StageSlotRecords>;
  observability?: ObservabilityPointer;
}

export interface RoleConfig {
  /** role -> agent name (passed verbatim to `task` tool) */
  roles: Record<string, string>;
  /** stage -> { replace | add | remove } of roles */
  roster_overrides: Record<string, { replace?: string[]; add?: string[]; remove?: string[] }>;
  /** glob list -> scope id + dev agent */
  scope_map: Array<{ glob: string[]; scope: string; dev_agent: string }>;
  /** glob list -> flag (e.g. has_security, has_infra) */
  flags: Record<string, string[]>;
  /** design system hint (UI work) */
  design_system: string | null;
  /** Live role -> agent resolution generated from OMP discovery. */
  agent_mapping?: AgentMappingState;
}


/**
 * Definition-of-Done item. Featured by workflow stage, with non-empty evidence
 * required to flip `status` to `met`.
 */
export interface DoDItem {
  id: string;
  source: string;
  criterion: string;
  verify_method: string;
  status: "pending" | "met";
  evidence: string;
}

export interface DoD {
  items: DoDItem[];
  type_requirements_met: boolean;
  updated_at: string;
  contributions?: Record<string, { added: string[]; closed: string[]; by: string }>;
}
