/**
 * Workflow type definitions.
 *
 * Mirrors workflows/_schema.json. Kept in TypeScript so the engine gets static
 * guarantees; the JSON files on disk are loaded and validated against these shapes.
 */

export type TaskType = "FEATURE" | "REFACTOR" | "OPS" | "BUG_FIX" | "INVESTIGATION" | "REVIEW" | "HOTFIX";
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
  | "review";

export type StageType = "orchestrator" | "single" | "consilium" | "bash" | "none";

export type StageStatus = "pending" | "in_progress" | "done" | "skipped";

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
}

export interface ProfileMatch {
  type: TaskType[];
  complexity?: Complexity[];
}

export interface StageDef {
  id: string;
  title: string;
  type: StageType;
  description?: string;
  /** For consilium: parallel roles. */
  roles?: string[];
  /** For single: the role. */
  role?: string;
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
}

export interface TeamState {
  schema: 1;
  branch: string;
  classification: Classification;
  task: string;
  autonomous: boolean;
  workflow_override: boolean;
  issue: { number: number; url?: string } | null;
  stage_cursor: string;
  stages: Array<{ id: string; status: StageStatus }>;
  artifacts: Record<string, string>;
  pause: { kind: PauseKind; reason: string };
  updated_at: string;
}

export interface RoleConfig {
  /** role -> agent name (passed verbatim to `task` tool) */
  roles: Record<string, string>;
  /** agent -> model spec */
  models: Record<string, string>;
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

export const DEFAULT_MODELS: RoleConfig["models"] = {
  architect: "opus",
  "code-reviewer": "opus",
  "security-tester": "opus",
  "tech-researcher": "haiku",
  "*": "sonnet",
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
