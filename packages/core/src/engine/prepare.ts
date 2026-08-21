import { resolveActiveBranch, resolveState, writeState, reopenFromFeedback, NO_GIT_BRANCH, DETACHED_BRANCH } from "./state.js";
import { loadProfile, profileHash, resolveWorkflow } from "./profile.js";
import { resolveConfig } from "./config.js";
import { resolveScope } from "./scope.js";
import { resolveClassification, type ModelClassification } from "./run.js";
import type { Classification, Complexity, Confidence, Profile, TaskType, TeamState, WorkflowName } from "./types.js";

export interface WorkflowPreparationContinuation {
  feedback: string;
  stageId: string;
}

export interface WorkflowPreparationInput {
  task: string;
  branch: string;
  classification: ModelClassification;
  issue?: TeamState["issue"];
  files?: string[];
  continuation?: WorkflowPreparationContinuation;
}

export interface PreparedWorkflow {
  state: TeamState;
  profile: Profile;
  statePath: string;
  artifactsDir: string;
  featureSlug: string;
  continuation: boolean;
}

export type WorkflowPreparationResult =
  | ({ ok: true } & PreparedWorkflow)
  | { ok: false; code: string; error: string; state?: TeamState };

const TASK_TYPES: Record<TaskType, true> = {
  FEATURE: true,
  REFACTOR: true,
  OPS: true,
  BUG_FIX: true,
  SPEC: true,
  REGRESS: true,
  INVESTIGATION: true,
  LECTURE_RESEARCH: true,
  REVIEW: true,
  HOTFIX: true,
};
const COMPLEXITIES: Record<Complexity, true> = { QUICK: true, MEDIUM: true, COMPLEX: true, CRITICAL: true };
const CONFIDENCES: Record<Confidence, true> = { HIGH: true, MEDIUM: true, LOW: true };

function featureSlugFromBranch(branch: string): string {
  return branch.replace(/\//g, "-").replace(/[^a-z0-9._-]/gi, "-").toLowerCase() || "default";
}

function fail(code: string, error: string, state?: TeamState): WorkflowPreparationResult {
  return state ? { ok: false, code, error, state } : { ok: false, code, error };
}

function validateClassificationInput(input: WorkflowPreparationInput): WorkflowPreparationResult | null {
  const classification = input.classification;
  if (!classification || typeof classification !== "object") return fail("CLASSIFICATION_INVALID", "workflow classification is required");
  if (TASK_TYPES[classification.type] !== true) return fail("CLASSIFICATION_INVALID", `unsupported task type '${String(classification.type)}'`);
  if (COMPLEXITIES[classification.complexity] !== true) return fail("CLASSIFICATION_INVALID", `unsupported complexity '${String(classification.complexity)}'`);
  if (CONFIDENCES[classification.confidence] !== true) return fail("CLASSIFICATION_INVALID", `unsupported confidence '${String(classification.confidence)}'`);
  if (typeof classification.autonomous !== "boolean") return fail("CLASSIFICATION_INVALID", "classification.autonomous must be a boolean");
  if (classification.autonomous_reason !== undefined && (typeof classification.autonomous_reason !== "string" || !classification.autonomous_reason.trim())) {
    return fail("CLASSIFICATION_INVALID", "classification.autonomous_reason must be a non-empty string when provided");
  }
  return null;
}

function validateBranch(cwd: string, branch: string): { activeBranch: string } | { error: string; code: string } {
  if (typeof branch !== "string" || !branch.trim()) return { code: "BRANCH_INVALID", error: "workflow branch is required" };
  const activeBranch = resolveActiveBranch(cwd);
  if (activeBranch === NO_GIT_BRANCH || activeBranch === DETACHED_BRANCH) {
    return { code: "BRANCH_INVALID", error: "workflow preparation requires an active git branch" };
  }
  if (branch !== activeBranch) {
    return { code: "BRANCH_STALE", error: `workflow branch '${branch}' is stale for the active branch '${activeBranch}'` };
  }
  return { activeBranch };
}

function validateIssue(issue: TeamState["issue"] | undefined): WorkflowPreparationResult | null {
  if (issue === undefined || issue === null) return null;
  if (!Number.isInteger(issue.number) || issue.number <= 0) return fail("INPUT_INVALID", "issue.number must be a positive integer");
  if (issue.url !== undefined && typeof issue.url !== "string") return fail("INPUT_INVALID", "issue.url must be a string when provided");
  return null;
}

function validateStageShape(profile: Profile): string | null {
  if (!Array.isArray(profile.stages) || profile.stages.length === 0) return "workflow profile has no stages";
  const ids = profile.stages.map((stage) => stage.id);
  if (ids.some((id) => typeof id !== "string" || !id.trim())) return "workflow profile contains an empty stage id";
  if (new Set(ids).size !== ids.length) return "workflow profile contains duplicate stage ids";
  return null;
}

function resolveFreshClassification(input: WorkflowPreparationInput): { classification: Classification; profile: Profile } | WorkflowPreparationResult {
  const invalid = validateClassificationInput(input);
  if (invalid) return invalid;
  const classification = resolveClassification({
    task: input.task,
    autonomous: input.classification.autonomous,
    classification: input.classification,
  });
  const expectedWorkflow = resolveWorkflow(classification.type, classification.complexity, classification.autonomous);
  if (classification.workflow !== expectedWorkflow) {
    return fail("CLASSIFICATION_INVALID", `workflow '${classification.workflow}' does not match the classification matrix; expected '${expectedWorkflow}'`);
  }
  const profile = loadProfile(classification.workflow);
  if (!profile) return fail("PROFILE_UNAVAILABLE", `workflow profile '${classification.workflow}' is unavailable`);
  const malformed = validateStageShape(profile);
  if (malformed) return fail("PROFILE_INVALID", malformed);
  return { classification, profile };
}

function resolvePersistedClassification(state: TeamState): { classification: Classification; profile: Profile } | WorkflowPreparationResult {
  if (!state.classification || typeof state.classification !== "object") return fail("STATE_INVALID", "persisted workflow classification is missing", state);
  const raw = state.classification as unknown as ModelClassification;
  const input: WorkflowPreparationInput = {
    task: state.task,
    branch: state.branch,
    classification: raw,
  };
  const invalid = validateClassificationInput(input);
  if (invalid) return invalid;
  const classification = resolveClassification({ task: state.task, autonomous: raw.autonomous, classification: raw });
  const expectedWorkflow = resolveWorkflow(classification.type, classification.complexity, classification.autonomous);
  if (classification.workflow !== expectedWorkflow && state.workflow_override !== true) {
    return fail("STATE_INVALID", `persisted workflow '${classification.workflow}' does not match the classification matrix; expected '${expectedWorkflow}'`, state);
  }
  const profile = loadProfile(classification.workflow);
  if (!profile) return fail("PROFILE_UNAVAILABLE", `workflow profile '${classification.workflow}' is unavailable`, state);
  const malformed = validateStageShape(profile);
  if (malformed) return fail("PROFILE_INVALID", malformed, state);
  if (state.profile_hash && state.profile_hash !== profileHash(profile)) return fail("PROFILE_STALE", "persisted workflow profile hash is stale", state);
  return { classification, profile };
}

function validatePersistedStages(state: TeamState, profile: Profile): string | null {
  if (!Array.isArray(state.stages)) return "persisted workflow stages are missing";
  const expectedIds = profile.stages.map((stage) => stage.id);
  if (state.stages.length !== expectedIds.length || state.stages.some((stage, index) => stage?.id !== expectedIds[index])) {
    return "persisted workflow stages do not match the active profile";
  }
  if (state.stages.some((stage) => !["pending", "in_progress", "done", "skipped", "failed"].includes(stage.status))) {
    return "persisted workflow contains an invalid stage status";
  }
  if (typeof state.stage_cursor !== "string" || !expectedIds.includes(state.stage_cursor)) return "persisted workflow stage cursor is invalid";
  if (!state.artifacts || typeof state.artifacts !== "object" || Array.isArray(state.artifacts)) return "persisted workflow artifacts are invalid";
  return null;
}

function rejectPlaintextSecrets(state: TeamState): string | null {
  const raw = state as unknown as Record<string, unknown>;
  const candidate = state.dispatch_capability as (TeamState["dispatch_capability"] & { dispatch_token?: unknown; advance_token?: unknown }) | undefined;
  if ("dispatch_token" in raw || "advance_token" in raw) return "persisted workflow contains plaintext capability secrets";
  if (candidate && typeof candidate === "object" && ("dispatch_token" in candidate || "advance_token" in candidate)) return "persisted workflow contains plaintext capability secrets";
  return null;
}

function hasMeaningfulScope(scope: TeamState["scope"] | undefined): scope is NonNullable<TeamState["scope"]> {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
  return Boolean(
    (Array.isArray(scope.scope) && scope.scope.length > 0) ||
      scope.has_security === true ||
      scope.has_infra === true ||
      scope.has_ui === true ||
      scope.has_runtime === true ||
      (typeof scope.dev_agent === "string" && scope.dev_agent.trim().length > 0),
  );
}

function resultFromWrite(
  written: { statePath: string; artifactsDir: string },
  state: TeamState,
  profile: Profile,
  featureSlug: string,
  continuation: boolean,
): WorkflowPreparationResult {
  return { ok: true, state, profile, statePath: written.statePath, artifactsDir: written.artifactsDir, featureSlug, continuation };
}

/**
 * Atomically create or reopen a feature-scoped workflow state before any
 * capability is issued. The returned state intentionally carries no plaintext
 * capability secrets; `beginCapability` remains the only issuer of handoffs.
 */
export function prepareWorkflow(cwd: string, input: WorkflowPreparationInput): WorkflowPreparationResult {
  try {
    if (typeof input?.task !== "string" || (!input.continuation && !input.task.trim())) return fail("INPUT_INVALID", "workflow task is required");
    const branch = validateBranch(cwd, input?.branch);
    if ("error" in branch) return fail(branch.code, branch.error);
    const issueError = validateIssue(input.issue);
    if (issueError) return issueError;

    const existing = resolveState(cwd, branch.activeBranch);
    if (existing.invalid) return fail("STATE_INVALID", "workflow state is malformed or unsafe");

    if (input.continuation) {
      if (!existing.state || !existing.statePath || existing.isStale) {
        return fail("CONTINUATION_REJECTED", `cannot continue workflow: no non-stale state for branch ${branch.activeBranch}`);
      }
      if (existing.state.schema !== 1) return fail("STATE_INVALID", "persisted workflow state schema is unsupported", existing.state);
      if (typeof existing.state.branch !== "string" || existing.state.branch !== branch.activeBranch) {
        return fail("BRANCH_STALE", "persisted workflow state has a malformed or stale branch", existing.state);
      }
      if (typeof existing.state.task !== "string" || !existing.state.task.trim()) return fail("STATE_INVALID", "persisted workflow task is missing", existing.state);
      if (typeof input.continuation.feedback !== "string" || !input.continuation.feedback.trim()) return fail("CONTINUATION_INVALID", "continuation feedback is required", existing.state);
      if (typeof input.continuation.stageId !== "string" || !input.continuation.stageId.trim()) return fail("CONTINUATION_INVALID", "continuation stageId is required", existing.state);
      const persisted = resolvePersistedClassification(existing.state);
      if (!("classification" in persisted)) return persisted;
      const stageError = validatePersistedStages(existing.state, persisted.profile);
      if (stageError) return fail("STATE_INVALID", stageError, existing.state);
      const secretError = rejectPlaintextSecrets(existing.state);
      if (secretError) return fail("STATE_INVALID", secretError, existing.state);
      const reopened = reopenFromFeedback(existing.state, input.continuation.feedback, input.continuation.stageId);
      const flags = hasMeaningfulScope(existing.state.scope)
        ? existing.state.scope
        : resolveScope(input.files ?? [], resolveConfig(cwd));
      const next: TeamState = {
        ...reopened,
        branch: branch.activeBranch,
        classification: persisted.classification,
        workflow_override: existing.state.workflow_override === true,
        issue: existing.state.issue ?? null,
        scope: flags,
        policy: { ...(existing.state.policy ?? {}), strict_orchestrator: true },
        profile_hash: profileHash(persisted.profile),
        run_key: existing.state.run_key ?? branch.activeBranch,
      };
      const written = writeState(cwd, next, { target: existing });
      return resultFromWrite(written, next, persisted.profile, featureSlugFromBranch(branch.activeBranch), true);
    }

    const resolved = resolveFreshClassification(input);
    if (!("classification" in resolved)) return resolved;
    if (existing.state && !existing.isStale) return fail("STATE_EXISTS", "an active workflow state already exists; use continuation feedback and stageId", existing.state);
    const flags = resolveScope(input.files ?? [], resolveConfig(cwd));
    const profileHashValue = profileHash(resolved.profile);
    const state: TeamState = {
      schema: 1,
      branch: branch.activeBranch,
      classification: resolved.classification,
      task: input.task.trim(),
      workflow_override: false,
      issue: input.issue ?? null,
      stage_cursor: resolved.profile.stages[0]!.id,
      stages: resolved.profile.stages.map((stage) => ({ id: stage.id, status: "pending" as const })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      scope: flags,
      policy: { strict_orchestrator: true },
      profile_hash: profileHashValue,
      run_key: branch.activeBranch,
      updated_at: new Date().toISOString(),
    };
    const featureSlug = featureSlugFromBranch(branch.activeBranch);
    const written = writeState(cwd, state, { featureSlug });
    return resultFromWrite(written, state, resolved.profile, featureSlug, false);
  } catch (error) {
    return fail("WORKFLOW_PREPARE_FAILED", String(error));
  }
}

export type { Complexity, Confidence, TaskType, WorkflowName };
