/**
 * Workflow type definitions.
 *
 * Mirrors workflows/_schema.json. Kept in TypeScript so the engine gets static
 * guarantees; the JSON files on disk are loaded and validated against these shapes.
 */

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

export interface CapabilityRosterEntry {
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
  observability?: import("../observability/events.js").ObservabilityPointer;
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
