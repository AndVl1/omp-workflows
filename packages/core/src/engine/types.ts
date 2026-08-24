/**
 * Workflow type definitions.
 *
 * Mirrors workflows/_schema.json. Kept in TypeScript so the engine gets static
 * guarantees; the JSON files on disk are loaded and validated against these shapes.
 */

import type { AgentMappingState } from "./agent-mapping.js";
import type { ObservabilityPointer } from "../observability/events.js";

export type TaskType = "FEATURE" | "REFACTOR" | "OPS" | "BUG_FIX" | "SPEC" | "REGRESS" | "INVESTIGATION" | "REVIEW" | "HOTFIX";
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
  | "cto"
  | (string & {});

export type StageType = "orchestrator" | "single" | "consilium" | "bash" | "none" | "team";

export type StageStatus = "pending" | "in_progress" | "done" | "skipped" | "failed";

export type PauseKind =
  | "none"
  | "background_wait"
  | "user_checkpoint"
  | "needs_human"
  | "failed"
  | "done";

export interface Classification {
  type: TaskType;
  complexity: Complexity;
  confidence: Confidence;
  workflow: WorkflowName;
  /**
   * Model-decided autonomy (PHASE-0). The ONLY authority for the autonomous
   * flag: `resolveWorkflow` and the P5 gate read this field, never the
   * mechanical parser hint (`autonomyHint`) and never the legacy top-level
   * `TeamState.autonomous` (read-compat only).
   */
  autonomous: boolean;
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
  /** Autonomous branch decision text. */
  autonomous?: string;
  /** Bash stages: the deterministic shell command to execute. */
  command?: string;
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
}

export interface DispatchRecord {
  id: string;
  role: string;
  agent: string;
  tool_call_id?: string;
  status: "authorized" | "running" | "succeeded" | "failed" | "cancelled";
  attempt: number;
  created_at: string;
  completed_at?: string;
  completion?: DispatchCompletion;
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
  slot: string;
  role: string;
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
}

/**
 * Durable checkpoint decision. Declared checkpoints (`stage.checkpoint`) are
 * prompt/display metadata only until a decision is recorded here; advance
 * refuses to leave a stage whose checkpoint is unresolved. `mode` records
 * whether the decision came from an interactive user or the autonomous path,
 * and `actor`/`rationale` preserve who decided and why.
 */
export interface CheckpointDecision {
  stage_id: string;
  checkpoint: string;
  mode: "interactive" | "autonomous";
  decision: string;
  actor: string;
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
  history: LoopIterationRecord[];
  ended_at?: string;
}

/**
 * Route semantics: what kind of transfer this is. Stable, engine-owned
 * labels surfaced in the safe tool result and the audit trail.
 */
export type HandoffRouteKind =
  /** Approved implementation-ready spec -> feature discovery. */
  | "feature-intake"
  /** Post-feature regression intake (full-feature|standard|lightweight summary). */
  | "regression"
  /** Regression report -> confirmed actionable/obvious bug fix. */
  | "bug-fix-diagnostic"
  /** Regression report -> uncertain/iterative debug cycle. */
  | "debug-diagnostic"
  /** Post-fix feedback/reopen regression (bug-fix|debug-cycle|emergency summary). */
  | "feedback-regression"
  /** Explicitly documented direct pair that must never complete. */
  | "unsupported";

/**
 * Route lifecycle state. `enabled` routes may complete; `conditional`
 * routes are catalogue-only until their required evidence/materialization
 * adapter exists and reject deterministically; `unsupported` pairs are
 * documented default-deny entries with a human-readable reason.
 */
export type HandoffRouteDisposition = "enabled" | "conditional" | "unsupported";

/**
 * Engine-owned handoff route: a registered source workflow stage that may
 * transfer an approved completed run into a target workflow's entry stage.
 * Route metadata lives in the engine (never in shipped profile JSON) so
 * `profileHash` stays stable for in-flight runs and no profile edit can
 * invalidate active states. Entries are catalogue-typed: stable ids, an
 * explicit disposition/semantics, source/target stages, prerequisites, and
 * UX metadata. Unknown and unsupported routes fail closed.
 */
export interface HandoffRoute {
  /** Stable, unique catalogue id (e.g. `spec-handoff->full-feature`). */
  id: string;
  source_workflow: string;
  source_stage: string;
  target_workflow: string;
  target_stage: string;
  /** Route semantics: what kind of transfer this is. */
  kind: HandoffRouteKind;
  /** `enabled` | `conditional` | `unsupported`. */
  disposition: HandoffRouteDisposition;
  /** Human-readable meaning shown in the safe tool result. */
  description: string;
  /** What the target stage materializes from the carried context. */
  preparation?: string;
  /** Prerequisites that must hold before the route may be used. */
  prerequisites?: string[];
  /** Why a conditional route cannot complete yet (adapter/evidence gaps). */
  blocked_by?: string[];
  /** UX hint: when the orchestrator may select this route. */
  when?: string;
}

/** Bounded references carried across a handoff; never a state clone. */
export interface HandoffContext {
  artifact_ids?: string[];
  decision_refs?: string[];
  summary?: string;
}

/** Durable audit record appended once per successful handoff. */
export interface HandoffRecord {
  id: string;
  route: HandoffRoute;
  source: {
    workflow: string;
    profile_hash: string;
    stage: string;
    cursor_epoch: string;
    run_key: string;
    branch: string;
  };
  target: {
    workflow: string;
    profile_hash: string;
    stage: string;
    cursor_epoch: string;
    capability_id: string;
  };
  approval: {
    kind: "checkpoint" | "artifact";
    ref: string;
    decision: string;
    actor: string;
    decided_at: string;
  };
  context: { artifact_ids: string[]; decision_refs: string[]; summary: string };
  at: string;
}

export interface TeamState {
  schema: 1;
  branch: string;
  classification: Classification;
  task: string;
  /** User feedback and prior task text retained across continuations. */
  history?: Array<{ task: string; feedback?: string; at: string }>;
  autonomous?: boolean;
  workflow_override: boolean;
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
  join_summary?: JoinSummary;
  /** Durable checkpoint decisions (additive, schema:1 compatible). */
  checkpoint_decisions?: CheckpointDecision[];
  /** Durable bounded-loop state (additive). */
  loop_state?: LoopState;
  /** Per-slot consilium artifact provenance + synthesis evidence (additive). */
  slot_artifacts?: Record<string, StageSlotRecords>;
  /** Durable cross-profile handoff audit trail (additive, append-only). */
  handoffs?: HandoffRecord[];
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

export const DEFAULT_ROLES: RoleConfig["roles"] = {
  analyst: "analyst",
  "tech-researcher": "tech-researcher",
  diagnostics: "diagnostics",
  architect: "architect",
  architect_minimal: "architect",
  architect_clean: "architect",
  architect_pragmatic: "architect",
  "backend-kotlin": "developer-kotlin",
  go: "developer-go",
  frontend: "frontend-developer",
  mobile: "developer-mobile",
  qa: "qa",
  "manual-qa": "manual-qa",
  "code-reviewer": "code-reviewer",
  "security-tester": "security-tester",
  devops: "devops",
};

export const DEFAULT_SCOPE_MAP: RoleConfig["scope_map"] = [
  {
    glob: ["**/iosApp/**", "**/composeApp/**", "**/commonMain/**", "**/androidMain/**"],
    scope: "mobile",
    dev_agent: "developer-mobile",
  },
  {
    glob: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.ts", "**/src/jsMain/**", "**/miniapp/**", "**/frontend/**"],
    scope: "frontend",
    dev_agent: "frontend-developer",
  },
  {
    glob: ["**/*.go", "**/go.mod", "**/go.sum"],
    scope: "go",
    dev_agent: "developer-go",
  },
  {
    glob: ["**/Dockerfile", "**/*.yaml", "**/*.yml", "**/helm/**", "**/.github/**", "**/k8s/**"],
    scope: "devops",
    dev_agent: "devops",
  },
  {
    glob: ["**/*.kt", "**/*.java", "**/src/main/**"],
    scope: "backend-kotlin",
    dev_agent: "developer-kotlin",
  },
];

export const DEFAULT_FLAGS: RoleConfig["flags"] = {
  has_security: ["**/auth/**", "**/security/**", "**/*crypto*", "**/*Secret*", "**/*Token*"],
  has_infra: ["**/Dockerfile", "**/helm/**", "**/k8s/**", "**/.github/workflows/**"],
};

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
