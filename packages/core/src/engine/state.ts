/**
 * State machine: read/write `.work-state/team-state.json` with monotonic
 * progress, branch detection, and the per-feature subdir layout.
 *
 * Layout (preserved from claude-plugin):
 *   .work-state/
 *     .active-feature                  (file: slug)
 *     team-state.json                  (legacy root state)
 *     team-state.md                    (human mirror)
 *     artifacts/
 *       <id>.json
 *     features/
 *       <slug>/
 *         state.json
 *         team-state.md
 *         artifacts/<id>.json
 *
 * Resolution order on read:
 *   1. .work-state/.active-feature -> features/<slug>/state.json
 *   2. .work-state/team-state.json (legacy)
 *   3. exact current-branch derived state when currentBranch is supplied
 *   4. undefined (no state yet)
 */
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readObservabilityPointer } from "../observability/recorder.js";
import { recordStageTransition } from "../observability/hooks.js";
import {
  beginArtifactJournal,
  commitArtifactJournal,
  endArtifactJournal,
  publishAfterStateCommit,
  rollbackArtifactJournal,
} from "./artifacts.js";
import { activeWave, readCtoState } from "../cto/state.js";
import {
  loadProfile,
  profileHash,
  resolveProfileControlPlane,
  validateProfileControlPlane,
} from "./profile.js";
import {
  validateActiveDispatchCapabilityValue,
  validateCheckpointDecisionValue,
  validateCheckpointPolicyValue,
  validateTypedCheckpointDecisionValue,
  validateDispatchCapabilityValue,
  validatePendingStateValue,
  validateTrustedCheckpointAnswerValue,
  validateWorkIdentityValue,
} from "./control-plane-contract.js";
import type {
  CheckpointPolicy,
  CheckpointPolicyBinding,
  CompletionEnvelope,
  CompletionIntent,
  ControlPlaneProvenance,
  MigrationReceipt,
  PauseKind,
  PendingState,
  StageStatus,
  TeamState,
  WorkIdentity,
} from "./types.js";

export const DETACHED_BRANCH = "__omp_detached_head__";
export const NO_GIT_BRANCH = "__omp_no_git__";

/**
 * Resolve the branch binding used by strict workflow transitions.
 * Detached HEAD and non-git directories are explicit invalid bindings;
 * returning a sentinel makes every strict state comparison fail closed.
 */
export function resolveActiveBranch(cwd: string): string {
  try {
    const branch = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch) return branch;
    const inside = execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return inside === "true" ? DETACHED_BRANCH : NO_GIT_BRANCH;
  } catch {
    return NO_GIT_BRANCH;
  }
}

const WORK_STATE_DIR = ".work-state";
const ACTIVE_FEATURE = ".active-feature";
const LEGACY_STATE = "team-state.json";
const STATE_MD = "team-state.md";
export function isSafeStateSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.includes("/") && !rel.includes("\\"));
}
function isWithinTree(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Normalize state written by pre-durable workflow commands. Those states keep
 * `workflow` at the root and track progress as `pending_stages`; the durable
 * engine needs the classification nested and a cursor-shaped state.
 *
 * Typed control-plane values are validated before migration. Legacy autonomy,
 * roles, and checkpoint records remain display/migration inputs and never
 * become permission merely because a typed field is absent.
 */
type StateRecord = Record<string, unknown>;

function isStateRecord(value: unknown): value is StateRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strictStateKeys(value: StateRecord, allowed: readonly string[], path: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key} unknown field`);
  }
}

function nonEmptyStateString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateStateIdentity(value: unknown, path: string, issues: string[]): void {
  const result = validateWorkIdentityValue(value, path);
  if (!result.ok) issues.push(...result.issues.map((issue) => `${issue.path} ${issue.message}`));
}

function validateStateSelection(value: unknown, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  const keys = [
    "snapshot_id", "run_key", "wave_id", "slice_id", "session_id", "workflow", "stage_id",
    "profile_hash", "policy_hash", "scope_hash", "mapping_hash", "capability_epoch",
    "selected", "omitted", "triggers", "stop_reason", "selected_at", "frozen_at",
  ] as const;
  strictStateKeys(value, keys, path, issues);
  for (const key of ["snapshot_id", "run_key", "wave_id", "slice_id", "session_id", "workflow", "stage_id", "profile_hash", "policy_hash", "scope_hash", "mapping_hash", "capability_epoch", "selected_at", "frozen_at"]) {
    if (!nonEmptyStateString(value[key])) issues.push(`${path}.${key} must be a non-empty string`);
  }
  if (!["minimum_valid_set", "risk_trigger_satisfied", "max_workers", "budget_limit"].includes(String(value.stop_reason))) {
    issues.push(`${path}.stop_reason has an unknown value`);
  }
  if (!Array.isArray(value.triggers) || value.triggers.some((entry) => !nonEmptyStateString(entry))) issues.push(`${path}.triggers must be an array of non-empty strings`);
  if (!Array.isArray(value.selected)) {
    issues.push(`${path}.selected must be an array`);
  } else {
    const slots = new Set<string>();
    value.selected.forEach((entry, index) => {
      const entryPath = `${path}.selected[${index}]`;
      if (!isStateRecord(entry)) {
        issues.push(`${entryPath} must be an object`);
        return;
      }
      strictStateKeys(entry, ["slot_id", "role", "occurrence", "facet", "agent", "reason"], entryPath, issues);
      for (const key of ["slot_id", "role", "agent", "reason"]) if (!nonEmptyStateString(entry[key])) issues.push(`${entryPath}.${key} must be a non-empty string`);
      if (!Number.isInteger(entry.occurrence) || (entry.occurrence as number) < 1) issues.push(`${entryPath}.occurrence must be an integer >= 1`);
      if (!Object.prototype.hasOwnProperty.call(entry, "facet") || (entry.facet !== null && !nonEmptyStateString(entry.facet))) issues.push(`${entryPath}.facet must be a non-empty string or null`);
      if (typeof entry.slot_id === "string") {
        if (slots.has(entry.slot_id)) issues.push(`${entryPath}.slot_id is duplicated`);
        slots.add(entry.slot_id);
      }
    });
  }
  if (!Array.isArray(value.omitted)) {
    issues.push(`${path}.omitted must be an array`);
  } else {
    value.omitted.forEach((entry, index) => {
      const entryPath = `${path}.omitted[${index}]`;
      if (!isStateRecord(entry)) {
        issues.push(`${entryPath} must be an object`);
        return;
      }
      strictStateKeys(entry, ["role", "reason"], entryPath, issues);
      if (!nonEmptyStateString(entry.role)) issues.push(`${entryPath}.role must be a non-empty string`);
      if (!nonEmptyStateString(entry.reason)) issues.push(`${entryPath}.reason must be a non-empty string`);
    });
  }
}

function validateStatePending(value: unknown, path: string, issues: string[]): void {
  const result = validatePendingStateValue(value, path, "single");
  if (!result.ok) issues.push(...result.issues.map((issue) => `${issue.path} ${issue.message}`));
}

function validateStateChildJoin(value: unknown, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, ["parent", "child", "state", "expected_artifact_ids", "completion_envelope_ref", "attempt", "created_at", "joined_at"], path, issues);
  validateStateIdentity(value.parent, `${path}.parent`, issues);
  validateStateIdentity(value.child, `${path}.child`, issues);
  if (!["planned", "authorized", "pending", "succeeded", "failed", "cancelled", "conflict"].includes(String(value.state))) issues.push(`${path}.state has an unknown value`);
  if (!Array.isArray(value.expected_artifact_ids) || value.expected_artifact_ids.some((entry) => !nonEmptyStateString(entry))) issues.push(`${path}.expected_artifact_ids must be an array of non-empty strings`);
  if (!Object.prototype.hasOwnProperty.call(value, "completion_envelope_ref") || (value.completion_envelope_ref !== null && !nonEmptyStateString(value.completion_envelope_ref))) issues.push(`${path}.completion_envelope_ref must be a non-empty string or null`);
  if (!Number.isInteger(value.attempt) || (value.attempt as number) < 1) issues.push(`${path}.attempt must be an integer >= 1`);
  for (const key of ["created_at", "joined_at"]) if (!nonEmptyStateString(value[key])) issues.push(`${path}.${key} must be a non-empty string`);
}

function validateStateCompletion(value: unknown, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, ["schema_version", "identity", "outcome", "terminal_signal", "artifact_refs", "evidence_ref", "conflict_ref", "completed_by", "emitted_at"], path, issues);
  if (value.schema_version !== 1) issues.push(`${path}.schema_version must be 1`);
  validateStateIdentity(value.identity, `${path}.identity`, issues);
  if (!["pending", "succeeded", "failed", "cancelled"].includes(String(value.outcome))) issues.push(`${path}.outcome has an unknown value`);
  if (value.terminal_signal !== null && value.terminal_signal !== undefined && !["workflow_complete", "native_tool_result", "provider_terminal", "contract_failure"].includes(String(value.terminal_signal))) issues.push(`${path}.terminal_signal has an unknown value`);
  if (!Array.isArray(value.artifact_refs)) {
    issues.push(`${path}.artifact_refs must be an array`);
  } else {
    value.artifact_refs.forEach((entry, index) => {
      const entryPath = `${path}.artifact_refs[${index}]`;
      if (!isStateRecord(entry)) {
        issues.push(`${entryPath} must be an object`);
        return;
      }
      strictStateKeys(entry, ["artifact_id", "path", "sha256", "schema_status", "dod_status"], entryPath, issues);
      for (const key of ["artifact_id", "path", "sha256"]) if (!nonEmptyStateString(entry[key]) || (key === "path" && (String(entry[key]).startsWith("/") || String(entry[key]).startsWith("\\") || String(entry[key]).includes("..") || String(entry[key]).includes("\\")))) issues.push(`${entryPath}.${key} must be a safe non-empty relative value`);
      if (!["met", "failed"].includes(String(entry.schema_status))) issues.push(`${entryPath}.schema_status has an unknown value`);
      if (!["met", "pending", "failed"].includes(String(entry.dod_status))) issues.push(`${entryPath}.dod_status has an unknown value`);
    });
  }
  if (!Object.prototype.hasOwnProperty.call(value, "evidence_ref") || (value.evidence_ref !== null && !nonEmptyStateString(value.evidence_ref))) issues.push(`${path}.evidence_ref must be a non-empty string or null`);
  if (!Object.prototype.hasOwnProperty.call(value, "conflict_ref") || (value.conflict_ref !== null && !nonEmptyStateString(value.conflict_ref))) issues.push(`${path}.conflict_ref must be a non-empty string or null`);
  if (!["workflow_complete", "synchronous_tool_result", "engine_task_caller"].includes(String(value.completed_by))) issues.push(`${path}.completed_by has an unknown value`);
  if (!nonEmptyStateString(value.emitted_at)) issues.push(`${path}.emitted_at must be a non-empty string`);
  if (value.outcome === "pending" && (value.terminal_signal !== null && value.terminal_signal !== undefined || Array.isArray(value.artifact_refs) && value.artifact_refs.length > 0)) issues.push(`${path} pending envelope cannot claim terminal data`);
  if (value.outcome !== "pending" && value.terminal_signal === null) issues.push(`${path}.terminal_signal is required for terminal outcomes`);
}

function validateStateTrustedCheckpointAnswers(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return;
  }
  value.forEach((entry, index) => {
    const result = validateTrustedCheckpointAnswerValue(entry, `${path}[${index}]`);
    if (!result.ok) issues.push(...result.issues.map((issue) => `${issue.path} ${issue.message}`));
  });
}

function validateStateMigration(value: unknown, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, ["id", "from_schema", "to_schema", "source_profile_hash", "target_profile_hash", "source_policy_hash", "target_policy_hash", "legacy_inputs", "warnings", "status", "migrated_at"], path, issues);
  for (const key of ["id", "source_profile_hash", "target_profile_hash", "target_policy_hash", "migrated_at"]) if (!nonEmptyStateString(value[key])) issues.push(`${path}.${key} must be a non-empty string`);
  for (const key of ["from_schema", "to_schema"]) if (!Number.isInteger(value[key]) || (value[key] as number) < 1) issues.push(`${path}.${key} must be an integer >= 1`);
  if (value.source_policy_hash !== null && value.source_policy_hash !== undefined && !nonEmptyStateString(value.source_policy_hash)) issues.push(`${path}.source_policy_hash must be a non-empty string or null`);
  for (const key of ["legacy_inputs", "warnings"]) if (!Array.isArray(value[key]) || value[key].some((entry) => !nonEmptyStateString(entry))) issues.push(`${path}.${key} must be an array of non-empty strings`);
  if (!["complete", "blocked"].includes(String(value.status))) issues.push(`${path}.status has an unknown value`);
}

/**
 * Active-stage policy binding: shape plus consistency with the mirrored
 * `checkpoint_policy`. A binding for a stage other than the cursor is a
 * prior-stage projection — normalization drops it instead of rejecting.
 */
function validatePolicyBinding(value: unknown, state: StateRecord, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, ["stage_id", "profile_hash", "policy_hash"], path, issues);
  for (const key of ["stage_id", "profile_hash", "policy_hash"]) {
    if (!nonEmptyStateString(value[key])) issues.push(`${path}.${key} must be a non-empty string`);
  }
  const currentStage = state.stage_cursor;
  if (value.stage_id !== currentStage) return; // prior-stage projection: dropped by normalization
  if (nonEmptyStateString(value.policy_hash)
    && isStateRecord(state.checkpoint_policy)
    && Object.prototype.hasOwnProperty.call(state, "checkpoint_policy")
    && stableStateHash(state.checkpoint_policy) !== value.policy_hash) {
    issues.push(`${path}.policy_hash does not match the persisted checkpoint_policy`);
  }
}

function validateTypedStateFields(state: StateRecord): string[] {
  const issues: string[] = [];
  const profileFields: StateRecord = {};
  for (const key of ["completion_intent", "roster_policy"]) {
    if (Object.prototype.hasOwnProperty.call(state, key)) profileFields[key] = state[key];
  }
  const profileValidation = validateProfileControlPlane(profileFields);
  if (!profileValidation.ok) issues.push(...profileValidation.issues.map((entry) => `state${entry.slice(1)}`));
  if (Object.prototype.hasOwnProperty.call(state, "checkpoint_policy")) {
    const policyIssues = validateCheckpointPolicyValue(state.checkpoint_policy, "$.checkpoint_policy");
    if (!policyIssues.ok) issues.push(...policyIssues.issues.map((issue) => `${issue.path} ${issue.message}`));
  }
  if (Object.prototype.hasOwnProperty.call(state, "state_revision")
    && (!Number.isInteger(state.state_revision) || (state.state_revision as number) < 0)) {
    issues.push("$.state_revision must be an integer >= 0");
  }
  if (Object.prototype.hasOwnProperty.call(state, "checkpoint_policy_binding")) {
    validatePolicyBinding(state.checkpoint_policy_binding, state, "$.checkpoint_policy_binding", issues);
  }
  if (Object.prototype.hasOwnProperty.call(state, "typed_checkpoint_decisions")) {
    if (!Array.isArray(state.typed_checkpoint_decisions)) issues.push("$.typed_checkpoint_decisions must be an array");
    else state.typed_checkpoint_decisions.forEach((entry, index) => {
      // Persisted decisions from before the loop-scoped ledger keep their
      // audit readability: loop_iteration may be absent at the state-field
      // boundary. Authorizing with such a record still requires it — the
      // ledger boundary enforces the scope.
      const result = validateTypedCheckpointDecisionValue(entry, `$.typed_checkpoint_decisions[${index}]`, { allowLegacyLoopScope: true });
      if (!result.ok) issues.push(...result.issues.map((issue) => `${issue.path} ${issue.message}`));
    });
  }
  if (Object.prototype.hasOwnProperty.call(state, "dispatch_capability")) {
    const capabilityIssues = validateDispatchCapabilityValue(state.dispatch_capability, "$.dispatch_capability");
    if (!capabilityIssues.ok) issues.push(...capabilityIssues.issues.map((issue) => `${issue.path} ${issue.message}`));
  }
  if (Object.prototype.hasOwnProperty.call(state, "roster_selection")) validateStateSelection(state.roster_selection, "$.roster_selection", issues);
  if (Object.prototype.hasOwnProperty.call(state, "roster_selections")) {
    if (!isStateRecord(state.roster_selections)) issues.push("$.roster_selections must be an object");
    else for (const [stage, selection] of Object.entries(state.roster_selections)) validateStateSelection(selection, `$.roster_selections.${stage}`, issues);
  }
  if (Object.prototype.hasOwnProperty.call(state, "work_identity")) validateStateIdentity(state.work_identity, "$.work_identity", issues);
  if (Object.prototype.hasOwnProperty.call(state, "pending")) validateStatePending(state.pending, "$.pending", issues);
  if (Object.prototype.hasOwnProperty.call(state, "child_join")) validateStateChildJoin(state.child_join, "$.child_join", issues);
  if (Object.prototype.hasOwnProperty.call(state, "child_joins")) {
    if (!Array.isArray(state.child_joins)) issues.push("$.child_joins must be an array");
    else state.child_joins.forEach((entry, index) => validateStateChildJoin(entry, `$.child_joins[${index}]`, issues));
  }
  if (Object.prototype.hasOwnProperty.call(state, "trusted_checkpoint_answers")) {
    validateStateTrustedCheckpointAnswers(state.trusted_checkpoint_answers, "$.trusted_checkpoint_answers", issues);
  }
  if (Object.prototype.hasOwnProperty.call(state, "completion_envelope")) validateStateCompletion(state.completion_envelope, "$.completion_envelope", issues);
  if (Object.prototype.hasOwnProperty.call(state, "migration")) validateStateMigration(state.migration, "$.migration", issues);
  const classification = isStateRecord(state.classification) ? state.classification : null;
  if (classification) {
    const classificationFields: StateRecord = {};
    for (const key of ["completion_intent", "checkpoint_policy"]) if (Object.prototype.hasOwnProperty.call(classification, key)) classificationFields[key] = classification[key];
    const classificationValidation = validateProfileControlPlane(classificationFields);
    if (!classificationValidation.ok) issues.push(...classificationValidation.issues.map((entry) => `classification${entry.slice(1)}`));
  }
  return issues;
}

function stableStateHash(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input as StateRecord).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function migrationIntent(): CompletionIntent {
  return {
    mode: "complete_outcome",
    acceptance: "dod_and_artifacts",
    source: "migration",
    rationale: "Legacy workflow runs requested a completed outcome; this default grants no checkpoint permission.",
  };
}

function migrationPolicy(checkpoint: string): CheckpointPolicy {
  const product = checkpoint === "product_approval";
  return {
    default: "required_human",
    scope: "decision",
    hard_human: product ? ["product_approval"] : [],
    rules: {
      [checkpoint]: {
        kind: product ? "product_approval" : "custom",
        default: "required_human",
        allowed_decisions: product ? ["proceed", "needs_more_validation", "defer", "reject"] : [],
        phase: "before_advance",
        rationale: "Legacy checkpoint declaration is migration input only; no autonomous decision is inferred.",
      },
    },
    source: "migration",
    policy_version: 1,
    rationale: "No typed checkpoint policy was persisted; unresolved consent remains human-required.",
  };
}

function legacyIdentity(state: StateRecord, workflow: string, stageId: string, capability: StateRecord | null): WorkIdentity {
  const seed = `${String(state.run_key ?? state.branch)}|${String(state.branch)}|${workflow}|${stageId}`;
  const digest = stableStateHash(seed).slice(0, 24);
  const capabilityId = capability && nonEmptyStateString(capability.capability_id) ? capability.capability_id : `legacy-capability-${digest}`;
  const epoch = nonEmptyStateString(state.cursor_epoch) ? state.cursor_epoch : `legacy-epoch-${digest}`;
  return {
    run_id: nonEmptyStateString(state.run_key) ? state.run_key : String(state.branch),
    wave_id: `legacy-wave-${digest}`,
    slice_id: `legacy-slice-${stageId}`,
    session_id: `legacy-session-${digest}`,
    workflow: workflow as TeamState["classification"]["workflow"],
    stage_id: stageId,
    stage_cursor: stageId,
    capability_id: capabilityId,
    capability_epoch: epoch,
    slot_id: "orchestrator",
    task_id: `legacy-task-${digest}`,
    dispatch_id: `legacy-dispatch-${digest}`,
    attempt: 1,
    worker_id: "engine",
  };
}

export function normalizePersistedState(raw: unknown, rejectionIssues?: string[]): TeamState | null {
  if (!isStateRecord(raw)) return null;
  const state: StateRecord = { ...raw };
  const rawClassification = state.classification;
  const classification = isStateRecord(rawClassification) ? { ...rawClassification } : null;
  const legacyWorkflow = nonEmptyStateString(state.workflow) ? state.workflow : null;
  if (classification && !nonEmptyStateString(classification.workflow) && legacyWorkflow) {
    classification.workflow = legacyWorkflow;
    state.classification = classification;
  }

  // A policy binding naming another cursor is a prior-stage projection. Drop
  // the mirror WITH the binding: retaining the old policy would let the
  // current stage inherit it as if it were typed for this declaration.
  // Current-stage projection below may then re-materialize only the profile
  // declaration that actually belongs to the live cursor.
  const staleBinding = isStateRecord(state.checkpoint_policy_binding)
    && state.checkpoint_policy_binding.stage_id !== state.stage_cursor;
  if (staleBinding) {
    delete state.checkpoint_policy_binding;
    delete state.checkpoint_policy;
  }

  const initialIssues = validateTypedStateFields(state);
  if (initialIssues.length > 0) {
    rejectionIssues?.push(...initialIssues);
    return null;
  }

  const hasLegacyCursor = Array.isArray(state.pending_stages) || typeof state.status === "string";
  const hasDurableCursor = Array.isArray(state.stages) && typeof state.stage_cursor === "string";
  if (classification && legacyWorkflow && hasLegacyCursor && !hasDurableCursor) {
    state.schema = 1;
    state.run_key = nonEmptyStateString(state.run_key) ? state.run_key : typeof state.branch === "string" ? state.branch : undefined;
    state.stage_cursor = "";
    state.stages = [];
    const rawArtifacts = state.artifacts;
    state.artifacts = isStateRecord(rawArtifacts) ? rawArtifacts : {};
    state.workflow_override = typeof state.workflow_override === "boolean" ? state.workflow_override : false;
    state.issue = "issue" in state ? state.issue : null;
    const rawPause = state.pause;
    state.pause = isStateRecord(rawPause) ? rawPause : { kind: "none", reason: "" };
    state.updated_at = nonEmptyStateString(state.updated_at) ? state.updated_at : new Date().toISOString();
  }

  if (!classification || !nonEmptyStateString(classification.workflow)) return state as unknown as TeamState;
  const workflow = classification.workflow;
  const stageId = nonEmptyStateString(state.stage_cursor) ? state.stage_cursor : "";
  const profile = loadProfile(workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === stageId);
  const projection = profile && stageId ? resolveProfileControlPlane(profile, stageId) : null;
  const legacyInputs: string[] = [];
  if (typeof classification.autonomous === "boolean") legacyInputs.push("classification.autonomous");
  if (typeof state.autonomous === "boolean") legacyInputs.push("TeamState.autonomous");
  if (stage?.autonomous) legacyInputs.push("stage.autonomous");
  const typedCompletion = state.completion_intent;
  const completion_intent = typedCompletion ?? projection?.completion_intent ?? migrationIntent();
  if (classification.completion_intent && stableStateHash(classification.completion_intent) !== stableStateHash(completion_intent)) {
    rejectionIssues?.push("$.classification.completion_intent conflicts with the resolved completion intent");
    return null;
  }
  state.completion_intent = completion_intent;
  // The policy mirror describes the ACTIVE stage's declaration only: a
  // stage without a checkpoint carries no checkpoint policy at all, so the
  // profile-level projection must never pin a mirror onto it (transitions
  // delete the mirror by key there — normalization must not resurrect it).
  const typedPolicy = state.checkpoint_policy;
  const checkpoint_policy = typedPolicy
    ?? (stage?.checkpoint ? projection?.checkpoint_policy ?? migrationPolicy(stage.checkpoint) : undefined);
  if (checkpoint_policy) state.checkpoint_policy = checkpoint_policy;
  else delete state.checkpoint_policy;
  if (stage?.roster_policy && state.roster_policy === undefined) state.roster_policy = stage.roster_policy;

  const capability = isStateRecord(state.dispatch_capability) ? state.dispatch_capability : null;
  const capabilityIdentity = capability?.work_identity;
  if (state.work_identity === undefined && capabilityIdentity !== undefined && !validateActiveDispatchCapabilityValue(capability).ok) {
    state.work_identity = capabilityIdentity;
  }
  else if (state.work_identity !== undefined && capabilityIdentity !== undefined && stableStateHash(state.work_identity) !== stableStateHash(capabilityIdentity)) {
    rejectionIssues?.push("$.work_identity conflicts with dispatch_capability.work_identity");
    return null;
  }
  // Legacy identity synthesis is migration-only: once a durable capability
  // exists, a cleared top-level identity must stay cleared — the next
  // dispatch re-binds it, and a synthesized stale-stage identity could
  // silently bind new proofs to a prior stage.
  if (state.work_identity === undefined && !capability && stageId && nonEmptyStateString(state.run_key ?? state.branch)) state.work_identity = legacyIdentity(state, workflow, stageId, capability);
  const identity = isStateRecord(state.work_identity) ? state.work_identity : null;
  for (const candidate of [state.pending, state.completion_envelope]) {
    if (!candidate || !isStateRecord(candidate) || !identity || !isStateRecord(candidate.identity)) continue;
    if (stableStateHash(candidate.identity) !== stableStateHash(identity)) {
      rejectionIssues?.push("$.pending.identity or $.completion_envelope.identity conflicts with work_identity");
      return null;
    }
  }
  if (state.pending && state.completion_envelope && isStateRecord(state.pending) && isStateRecord(state.completion_envelope)) {
    if ((state.pending.status === "pending") !== (state.completion_envelope.outcome === "pending")) {
      rejectionIssues?.push("$.pending.status and $.completion_envelope.outcome disagree about pending");
      return null;
    }
  }

  const targetProfileHash = profile ? profileHash(profile) : (nonEmptyStateString(state.profile_hash) ? state.profile_hash : "unresolved-profile");
  if (!state.profile_hash && profile) state.profile_hash = targetProfileHash;
  const targetPolicyHash = stableStateHash(checkpoint_policy ?? { default: "required_human", scope: "decision", rules: {} });
  const migration = state.migration as StateRecord | undefined;
  if (!migration) {
    const receipt: MigrationReceipt = {
      id: `migration-${stableStateHash(`${String(state.run_key ?? state.branch)}|${workflow}`).slice(0, 24)}`,
      from_schema: 1,
      to_schema: 3,
      source_profile_hash: nonEmptyStateString(state.profile_hash) ? state.profile_hash : "unresolved-profile",
      target_profile_hash: targetProfileHash,
      source_policy_hash: null,
      target_policy_hash: targetPolicyHash,
      legacy_inputs: [...new Set(legacyInputs)],
      warnings: [
        !typedCompletion ? "completion_intent projected from typed profile or conservative migration default" : null,
        !typedPolicy && stage?.checkpoint ? "checkpoint_policy projected from typed profile or conservative human-required migration policy" : null,
        stage?.autonomous ? "stage.autonomous is display/migration input only" : null,
      ].filter((warning): warning is string => warning !== null),
      status: "complete",
      migrated_at: new Date().toISOString(),
    };
    state.migration = receipt;
  }
  const provenance: ControlPlaneProvenance = {
    completion_intent: typedCompletion ? "state" : projection?.completion_intent ? "profile" : "migration",
    checkpoint_policy: typedPolicy ? "state" : stage?.checkpoint ? (projection?.checkpoint_policy ? "profile" : "migration") : "none",
    roster_policy: stage?.roster_policy || state.roster_policy ? "profile" : "legacy",
    roster_selection: state.roster_selection ? "state" : "none",
    work_identity: state.work_identity ? (capabilityIdentity ? "typed" : "migration") : "none",
    pending: state.pending ? "state" : "none",
    child_join: state.child_join ? "state" : "none",
    completion_envelope: state.completion_envelope ? "state" : "none",
    legacy_inputs: [...new Set(legacyInputs)],
    warnings: stage?.autonomous ? ["stage.autonomous is display/migration input only"] : [],
    status: legacyInputs.length > 0 || !typedCompletion || !typedPolicy ? "migrated" : "typed",
  };
  state.control_plane_provenance = provenance;

  const finalIssues = validateTypedStateFields(state);
  if (finalIssues.length > 0) {
    rejectionIssues?.push(...finalIssues);
    return null;
  }
  return (state as unknown as TeamState);
}



export interface ResolvedState {
  state: TeamState | null;
  statePath: string | null;
  stateDir: string | null;
  artifactsDir: string | null;
  isLegacy: boolean;
  isStale: boolean;
  invalid?: boolean;
}

/**
 * A stale `.active-feature` pointer can survive an upgrade while the
 * orchestrator writes the current classification to the legacy root state.
 * Use that root only when the pointed feature state is incomplete and the
 * root state is a complete, branch-compatible workflow state. A complete
 * feature state remains authoritative; malformed or foreign root state never
 * becomes a fallback.
 */
function resolveLegacyWorkflowFallback(cwd: string, wsDir: string, currentBranch?: string): ResolvedState | null {
  const legacyPath = join(wsDir, LEGACY_STATE);
  if (!existsSync(legacyPath)) return null;
  try {
    const realWorkState = realpathSync(wsDir);
    if (!isWithin(realpathSync(cwd), realWorkState) || !isWithin(realWorkState, realpathSync(legacyPath))) return null;
    const artifactsPath = join(wsDir, "artifacts");
    if (existsSync(artifactsPath) && !isWithin(realWorkState, realpathSync(artifactsPath))) return null;
    const state = normalizePersistedState(JSON.parse(readFileSync(legacyPath, "utf8")));
    if (!state || !state.classification || typeof state.classification.workflow !== "string" || !state.classification.workflow || typeof state.branch !== "string" || !state.branch) return null;
    if (currentBranch && state.branch !== currentBranch) return null;
    return { state, statePath: legacyPath, stateDir: wsDir, artifactsDir: artifactsPath, isLegacy: true, isStale: false };
  } catch {
    return null;
  }
}

/**
 * Probe the current branch's own derived feature state. A stale slot must
 * never hide it: when this state exists, parses and belongs to the current
 * branch, it is the authoritative resolution (branch-owned state outranks a
 * stale .active-feature pointer or legacy root). Malformed, foreign-branch
 * or containment-violating files are never adopted — the stale slot stands
 * and the transaction-level fail-closed checks still apply.
 */
function resolveBranchOwnedFeatureState(wsDir: string, currentBranch: string): ResolvedState | null {
  const slug = deriveFeatureSlugFromBranch(currentBranch);
  if (!slug || !isSafeStateSegment(slug)) return null;
  const featuresDir = join(wsDir, "features");
  const featureDir = join(featuresDir, slug);
  const statePath = join(featureDir, "state.json");
  const artifactsPath = join(featureDir, "artifacts");
  const invalid = (): ResolvedState => ({ state: null, statePath, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: false, invalid: true });
  try {
    lstatSync(featuresDir);
    lstatSync(featureDir);
    lstatSync(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return invalid();
  }
  try {
    const realWorkState = realpathSync(wsDir);
    const realFeatures = realpathSync(featuresDir);
    const realFeature = realpathSync(featureDir);
    if (!isWithin(realWorkState, realFeatures) || !isWithin(realFeatures, realFeature)) return invalid();
    if (!isWithin(realFeature, realpathSync(statePath))) return invalid();
    if (existsSync(artifactsPath) && !isWithin(realFeature, realpathSync(artifactsPath))) return invalid();
    const state = normalizePersistedState(JSON.parse(readFileSync(statePath, "utf8")));
    if (!state) return invalid();
    if (state.branch !== currentBranch) return null;
    return { state, statePath, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: false };
  } catch {
    return invalid();
  }
}

export type StateSelector = { kind?: "auto" | "team" | "cto-slice"; runId?: string; sliceId?: string; capabilityId?: string };
export interface ResolvedActiveRun extends ResolvedState {
  kind: "legacy-root" | "feature" | "cto-slice";
  runKey: string;
  branch: string;
  workflow: string;
  profileHash: string;
  stageCursor: string;
  cursorEpoch: string;
  dispatch: unknown;
  staleReason: string | null;
  selectedTeam?: unknown;
}

/** Resolve the one authoritative persisted run. Explicit CTO selectors fail closed.
 * A stale active-feature pointer may use a complete, branch-compatible legacy
 * root only when the pointed feature state is incomplete. */
export function resolveCanonicalRun(cwd: string, selector: StateSelector = {}, currentBranch?: string): ResolvedActiveRun | null {
  const branch = currentBranch;
  if (selector.kind === "cto-slice" || selector.runId || selector.sliceId) {
    if (!selector.runId || !selector.sliceId) throw new Error("cto-slice selector requires runId and sliceId");
    const runId = selector.runId, sliceId = selector.sliceId;
    if (!isSafeStateSegment(runId) || !isSafeStateSegment(sliceId)) throw new Error("cto-slice selector contains an unsafe path segment");
    const cto = readCtoState(runId, cwd);
    if (!cto) throw new Error(`CTO run '${runId}' is missing or unreadable`);
    const wave = activeWave(cto);
    if (!wave) throw new Error(`CTO run '${runId}' has no active wave`);
    const matches = cto.teams.filter((team) => team.slice_id === sliceId);
    if (matches.length !== 1) throw new Error(`CTO slice '${sliceId}' must map to exactly one active team`);
    const team = matches[0]!;
    const execution = (team as unknown as { execution?: unknown }).execution;
    if (!execution) throw new Error(`CTO slice '${sliceId}' has no shared execution capability`);
    const staleReason = branch && cto.branch !== branch ? `branch mismatch: persisted '${cto.branch}', current '${branch}'` : null;
    return { state: cto as any, statePath: join(cwd, WORK_STATE_DIR, "cto", cto.id, "state.json"), stateDir: join(cwd, WORK_STATE_DIR, "cto", cto.id), artifactsDir: join(cwd, WORK_STATE_DIR, "cto", cto.id, "artifacts"), isLegacy: false, isStale: Boolean(staleReason), kind: "cto-slice", runKey: `cto:${cto.id}:${sliceId}`, branch: cto.branch, workflow: team.workflow ?? "cto", profileHash: String((execution as any).profile_hash ?? ""), stageCursor: String((execution as any).stage_cursor ?? ""), cursorEpoch: String((execution as any).cursor_epoch ?? ""), dispatch: execution, staleReason, selectedTeam: team };
  }
  const resolved = resolveState(cwd, branch);
  if (resolved.invalid) throw new Error("workflow state is invalid or unsafe");
  if (!resolved.state || !resolved.statePath) return null;
  const state = resolved.state;
  const kind = resolved.isLegacy ? "legacy-root" : "feature";
  return { ...resolved, kind, runKey: resolved.isLegacy ? `team:${state.branch}:root` : `team:${state.branch}:${basename(resolved.stateDir ?? "")}`, branch: state.branch, workflow: state.classification.workflow, profileHash: state.profile_hash ?? "", stageCursor: state.stage_cursor, cursorEpoch: state.cursor_epoch ?? "", dispatch: state.dispatch_capability ?? null, staleReason: resolved.isStale ? `branch mismatch: persisted '${state.branch}', current '${branch ?? "unknown"}'` : null };
}

export function resolveState(cwd: string, currentBranch?: string): ResolvedState {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  const none = (): ResolvedState => ({ state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false });
  if (!existsSync(wsDir)) {
    return none();
  }
  try {
    if (!isWithin(realpathSync(cwd), realpathSync(wsDir))) {
      return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
    }
  } catch {
    return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
  }

  const activeFile = join(wsDir, ACTIVE_FEATURE);
  if (existsSync(activeFile)) {
    const slug = readFileSync(activeFile, "utf8").trim();
    if (!isSafeStateSegment(slug)) {
      return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
    }
    const featuresDir = join(wsDir, "features");
    const featureDir = join(featuresDir, slug);
    const statePath = join(featureDir, "state.json");
    const staleTarget = (): ResolvedState => currentBranch
      ? none()
      : { state: null, statePath, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false };
    if (!existsSync(featuresDir)) return staleTarget();
    try {
      const realWorkState = realpathSync(wsDir);
      const realFeatures = realpathSync(featuresDir);
      if (!isWithin(realpathSync(cwd), realWorkState) || !isWithin(realWorkState, realFeatures) || (existsSync(featureDir) && !isWithin(realFeatures, realpathSync(featureDir)))) {
        return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
      }
    } catch {
      return { state: null, statePath, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false, invalid: true };
    }
    if (!existsSync(statePath)) {
      if (currentBranch) {
        const own = resolveBranchOwnedFeatureState(wsDir, currentBranch);
        if (own) return own;
      }
      const legacyFallback = resolveLegacyWorkflowFallback(cwd, wsDir, currentBranch);
      if (legacyFallback) return legacyFallback;
      return staleTarget();
    }
    try {
      const realFeature = realpathSync(featureDir);
      if (!isWithin(realFeature, realpathSync(statePath))) {
        return { state: null, statePath, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false, invalid: true };
      }
      const artifactsPath = join(featureDir, "artifacts");
      if (existsSync(artifactsPath) && !isWithin(realFeature, realpathSync(artifactsPath))) {
        return { state: null, statePath, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: false, invalid: true };
      }
      const state = normalizePersistedState(JSON.parse(readFileSync(statePath, "utf8")));
      if (!state) {
        const legacyFallback = resolveLegacyWorkflowFallback(cwd, wsDir, currentBranch);
        if (legacyFallback) return legacyFallback;
        return { state: null, statePath, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: false, invalid: true };
      }
      if (!state.classification || typeof state.classification.workflow !== "string" || !state.classification.workflow) {
        const legacyFallback = resolveLegacyWorkflowFallback(cwd, wsDir, currentBranch);
        if (legacyFallback) return legacyFallback;
      }
      const staleForBranch = Boolean(currentBranch) && state.branch !== currentBranch;
      if (currentBranch && staleForBranch) {
        // Branch-owned state outranks a stale slot: the current branch's own
        // derived feature state is authoritative over a pointer that belongs
        // to another branch.
        const own = resolveBranchOwnedFeatureState(wsDir, currentBranch);
        if (own) return own;
      }
      return { state, statePath, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: staleForBranch };
    } catch {
      return { state: null, statePath, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false, invalid: true };
    }
  }

  const legacyPath = join(wsDir, LEGACY_STATE);
  if (existsSync(legacyPath)) {
    try {
      const realWorkState = realpathSync(wsDir);
      if (!isWithin(realpathSync(cwd), realWorkState) || !isWithin(realWorkState, realpathSync(legacyPath))) {
        return { state: null, statePath: legacyPath, stateDir: wsDir, artifactsDir: join(wsDir, "artifacts"), isLegacy: true, isStale: false, invalid: true };
      }
      const artifactsPath = join(wsDir, "artifacts");
      if (existsSync(artifactsPath) && !isWithin(realWorkState, realpathSync(artifactsPath))) {
        return { state: null, statePath: legacyPath, stateDir: wsDir, artifactsDir: artifactsPath, isLegacy: true, isStale: false, invalid: true };
      }
      const state = normalizePersistedState(JSON.parse(readFileSync(legacyPath, "utf8")));
      if (!state) return { state: null, statePath: legacyPath, stateDir: wsDir, artifactsDir: artifactsPath, isLegacy: true, isStale: false, invalid: true };
      const staleForBranch = Boolean(currentBranch) && state.branch !== currentBranch;
      if (currentBranch && staleForBranch) {
        // Same ownership rule as the pointer path: the branch's own derived
        // feature state outranks a legacy root from another branch.
        const own = resolveBranchOwnedFeatureState(wsDir, currentBranch);
        if (own) return own;
      }
      return { state, statePath: legacyPath, stateDir: wsDir, artifactsDir: artifactsPath, isLegacy: true, isStale: staleForBranch };
    } catch {
      return { state: null, statePath: legacyPath, stateDir: wsDir, artifactsDir: join(wsDir, "artifacts"), isLegacy: true, isStale: false, invalid: true };
    }
  }
  if (currentBranch) {
    const own = resolveBranchOwnedFeatureState(wsDir, currentBranch);
    if (own) return own;
  }
  return none();
}

/**
 * Internal fixture/bootstrap writer. It is intentionally absent from the
 * package index: production mutations must use updateStateAtomically so an
 * existing run is always read and changed under the workspace lock.
 */
export function writeStateBootstrap(
  cwd: string,
  state: TeamState,
  opts: { featureSlug?: string; target?: ResolvedState } = {},
): { statePath: string; artifactsDir: string } {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  mkdirSync(wsDir, { recursive: true });
  const realWorkState = realpathSync(wsDir);
  if (!isWithin(realpathSync(cwd), realWorkState)) throw new Error("workflow state path escapes project root");
  const prepared = prepareStateTarget(cwd, realWorkState, wsDir, state, opts);
  const previous = readRawStateSnapshot(prepared.statePath);
  if (previous.kind === "invalid") throw new Error(previous.error);
  const previousRevision = previous.kind === "present" ? previous.revision : 0;
  return commitState(cwd, prepared, state, previousRevision + 1);
}

interface PreparedStateTarget {
  stateDir: string;
  statePath: string;
  artifactsDir: string;
  featureSlug: string | null;
}

function prepareStateTarget(
  cwd: string,
  realWorkState: string,
  wsDir: string,
  state: Pick<TeamState, "branch">,
  opts: { featureSlug?: string; target?: ResolvedState },
): PreparedStateTarget {
  const target = opts.target;
  if (target?.invalid) throw new Error("cannot write through an invalid workflow state target");
  if (target && (!target.stateDir || !target.statePath || !target.artifactsDir)) throw new Error("workflow state target is incomplete");
  if (target) {
    const targetStateDir = realpathSync(target.stateDir!);
    if (!isWithinTree(realWorkState, targetStateDir)) throw new Error("workflow state target escapes .work-state");
    if (existsSync(target.statePath!) && !isWithin(targetStateDir, realpathSync(target.statePath!))) {
      throw new Error("workflow state target escapes its state directory");
    }
  }

  const featureSlug = target
    ? target.isLegacy ? null : basename(target.stateDir!)
    : opts.featureSlug ?? deriveFeatureSlugFromBranch(state.branch) ?? "default";
  if (featureSlug && !isSafeStateSegment(featureSlug)) throw new Error("unsafe workflow feature slug");
  let stateDir: string;
  let statePath: string;
  let artifactsDir: string;

  if (target) {
    stateDir = target.stateDir!;
    statePath = target.statePath!;
    artifactsDir = target.artifactsDir!;
  } else if (featureSlug) {
    stateDir = join(wsDir, "features", featureSlug);
    statePath = join(stateDir, "state.json");
    artifactsDir = join(stateDir, "artifacts");
  } else {
    stateDir = wsDir;
    statePath = join(wsDir, LEGACY_STATE);
    artifactsDir = join(wsDir, "artifacts");
  }
  return validatePreparedTarget(realWorkState, wsDir, { stateDir, statePath, artifactsDir, featureSlug: featureSlug ?? null });
}

/** Run the containment and directory-creation checks for one prepared target. */
function validatePreparedTarget(realWorkState: string, wsDir: string, prepared: PreparedStateTarget): PreparedStateTarget {
  const { stateDir, statePath, artifactsDir, featureSlug } = prepared;
  if (featureSlug) {
    const featuresDir = join(wsDir, "features");
    mkdirSync(featuresDir, { recursive: true });
    const realFeatures = realpathSync(featuresDir);
    if (!isWithin(realWorkState, realFeatures)) throw new Error("workflow feature path escapes .work-state/features");
    mkdirSync(stateDir, { recursive: true });
    if (!isWithin(realFeatures, realpathSync(stateDir))) throw new Error("workflow feature path escapes .work-state/features");
  } else {
    mkdirSync(stateDir, { recursive: true });
  }

  const realStateDir = realpathSync(stateDir);
  if (!isWithinTree(realWorkState, realStateDir)) throw new Error("workflow state directory escapes .work-state");
  if (!isWithin(realStateDir, realpathSync(dirname(statePath)))) throw new Error("workflow state path escapes its state directory");
  if (!isWithin(realStateDir, realpathSync(dirname(artifactsDir)))) throw new Error("workflow artifacts path escapes its state directory");
  mkdirSync(artifactsDir, { recursive: true });
  if (!isWithin(realStateDir, realpathSync(artifactsDir))) throw new Error("workflow artifacts path escapes its state directory");
  return { stateDir, statePath, artifactsDir, featureSlug };
}

/** Reuse a resolved state's exact paths for a transactional commit. */
function prepareExistingTarget(realWorkState: string, wsDir: string, target: ResolvedState): PreparedStateTarget {
  if (!target.stateDir || !target.statePath || !target.artifactsDir) {
    throw new Error("workflow state target is incomplete");
  }
  const prepared = validatePreparedTarget(realWorkState, wsDir, {
    stateDir: target.stateDir,
    statePath: target.statePath,
    artifactsDir: target.artifactsDir,
    featureSlug: target.isLegacy ? null : basename(target.stateDir),
  });
  if (existsSync(prepared.statePath) && !isWithin(realpathSync(prepared.stateDir), realpathSync(prepared.statePath))) {
    throw new Error("workflow state target escapes its state directory");
  }
  return prepared;
}

interface PreparedFileWrite {
  path: string;
  tempPath: string;
}

function prepareFileWrite(path: string, content: string): PreparedFileWrite {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(tempPath, content, "utf8");
  return { path, tempPath };
}

function cleanupPreparedWrite(write: PreparedFileWrite): void {
  try {
    unlinkSync(write.tempPath);
  } catch {
    // The temp was published or already cleaned up.
  }
}

function readRegularFileNoFollow(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`workflow sidecar is not a regular file: ${path}`);
    const raw = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`workflow sidecar changed while being read: ${path}`);
    }
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function restoreSidecar(path: string, previous: string | null, published: string): void {
  let current: string | null;
  try {
    current = readRegularFileNoFollow(path);
  } catch {
    return;
  }
  if (current !== published) return;
  if (previous === null) {
    unlinkSync(path);
  } else {
    atomicWrite(path, previous);
  }
}
interface CommittedState {
  statePath: string;
  artifactsDir: string;
  state: TeamState;
}


function commitState(
  cwd: string,
  prepared: PreparedStateTarget,
  state: TeamState,
  stateRevision: number,
): CommittedState {
  const { stateDir, statePath, artifactsDir, featureSlug } = prepared;
  const rejectionIssues: string[] = [];
  const normalized = normalizePersistedState(state, rejectionIssues);
  if (!normalized) throw new Error(`workflow state contains malformed or conflicting typed control-plane fields: ${rejectionIssues.join("; ") || "unrecognized shape"}`);
  const stamped: TeamState = { ...normalized, state_revision: stateRevision, updated_at: new Date().toISOString() };
  const obsPointer = featureSlug ? readObservabilityPointerSafe(cwd, featureSlug) : null;
  if (obsPointer) {
    stamped.observability = obsPointer;
  } else {
    delete stamped.observability;
  }

  const stateContent = JSON.stringify(stamped, null, 2) + "\n";
  const stateMdPath = join(stateDir, STATE_MD);
  const stateMdContent = renderStateMd(stamped);
  const activePath = featureSlug ? join(resolve(cwd, WORK_STATE_DIR), ACTIVE_FEATURE) : null;
  const activeContent = featureSlug ? featureSlug + "\n" : null;
  // All potentially fallible content generation, old-byte snapshots and temp
  // writes complete before publication. Sidecars publish first; state.json is
  // the single authoritative commit point and is replaced last.
  const previousStateMd = readRegularFileNoFollow(stateMdPath);
  const previousActive = activePath ? readRegularFileNoFollow(activePath) : null;
  const stateMdWrite = prepareFileWrite(stateMdPath, stateMdContent);
  let activeWrite: PreparedFileWrite | null = null;
  let stateWrite: PreparedFileWrite | null = null;
  let stateMdPublished = false;
  let activePublished = false;
  try {
    if (activePath && activeContent !== null) activeWrite = prepareFileWrite(activePath, activeContent);
    stateWrite = prepareFileWrite(statePath, stateContent);
    renameSync(stateMdWrite.tempPath, stateMdPath);
    stateMdPublished = true;
    if (activeWrite && activePath) {
      renameSync(activeWrite.tempPath, activePath);
      activePublished = true;
    }
    // Authoritative commit point. Nothing after this rename may request or
    // signal rollback of state/artifact effects.
    renameSync(stateWrite.tempPath, statePath);
  } catch (error) {
    if (activePublished && activePath && activeContent !== null) restoreSidecar(activePath, previousActive, activeContent);
    if (stateMdPublished) restoreSidecar(stateMdPath, previousStateMd, stateMdContent);
    throw error;
  } finally {
    cleanupPreparedWrite(stateMdWrite);
    if (activeWrite) cleanupPreparedWrite(activeWrite);
    if (stateWrite) cleanupPreparedWrite(stateWrite);
  }
  return { statePath, artifactsDir, state: stamped };
}

// ---------------------------------------------------------------------------
// Cross-process state transaction: workspace lock + revision/raw-hash CAS.
//
// `updateStateAtomically` is THE seam for every state change that must not
// lose a concurrent writer (checkpoint answers, decisions, cursor moves).
// It serializes on `.work-state/.state.lock`, re-reads the latest state
// under the lock (never a pre-await snapshot), runs the mutation against
// that snapshot, and commits only when the file still carries the observed
// revision and raw hash — otherwise it fails `state_conflict` without
// writing. There is no event-loop assumption: a lock holder in another
// process is waited for (bounded), a dead holder is reclaimed, and a
// malformed or live-but-unverifiable holder is never stolen.
// ---------------------------------------------------------------------------

const STATE_LOCK_FILE = ".state.lock";
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_DEFAULT_TIMEOUT_MS = 10_000;
const STATE_LOCK_RECLAIM_PREFIX = `${STATE_LOCK_FILE}.reclaim.`;

export type StateTxErrorCode =
  | "state_invalid"
  | "state_missing"
  | "state_conflict"
  | "state_lock_unavailable";

export interface StateSnapshot {
  /** Latest normalized state, or null when the run has not been created yet. */
  state: TeamState | null;
  target: ResolvedState;
  /** Canonical CAS revision (legacy inputs read as 0). */
  revision: number;
  /** SHA-256 over the raw persisted bytes backing the snapshot. */
  raw_hash: string;
}

/**
 * A mutation may fail with its own domain code (e.g. a typed checkpoint
 * code); the transaction itself only ever surfaces the four
 * `StateTxErrorCode` values. The domain code always rides in `code` and its
 * explanation in `error`.
 */
export type StateMutationCode = StateTxErrorCode | (string & {});

export type StateMutation<T> =
  | { op: "commit"; state: TeamState; value?: T }
  | { op: "discard"; value?: T }
  | { op: "fail"; code: StateMutationCode; error: string };

export type StateUpdateResult<T> =
  | { ok: true; state: TeamState | null; target: ResolvedState; revision: number; committed: boolean; value?: T }
  // Transaction-level failures always carry one of the four StateTxErrorCode
  // values; a domain `op: "fail"` passes its own code through verbatim.
  | { ok: false; code: StateMutationCode; error: string };

interface StateLockOwner {
  pid: number;
  token: string;
  acquired_at: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    return true;
  }
}

function sleepSync(ms: number): void {
  // Prefer a parked wait; fall back to a bounded spin so worker-thread
  // environments (where Atomics.wait throws) still block safely.
  try {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const result = Atomics.wait(signal, 0, 0, ms);
    if (result === "timed-out" || result === "ok") return;
  } catch {
    // fall through to spinning
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // busy-wait
  }
}

type LockCreateOutcome = { created: true } | { created: false; reason: "exists" } | { created: false; reason: "error"; error: string };

/**
 * Publish the lock owner ATOMICALLY: the complete owner JSON is written to a
 * private temp file first and then hard-linked into place. `linkSync` is an
 * exclusive-create, so "the lock file exists" and "its owner metadata is
 * complete" become the same instant — a concurrent inspector can never
 * observe the exclusive-create-to-metadata window as a partial or empty
 * owner (which previously surfaced as a spurious immediate
 * `state_lock_unavailable` for a perfectly live lock).
 */
function tryCreateLock(lockPath: string, owner: StateLockOwner): LockCreateOutcome {
  const tmp = `${lockPath}.${randomUUID()}.owner-tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(owner));
    try {
      linkSync(tmp, lockPath);
      return { created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false, reason: "exists" };
      return { created: false, reason: "error", error: `state lock unavailable: ${(error as Error).message}` };
    }
  } catch (error) {
    return { created: false, reason: "error", error: `state lock unavailable: ${(error as Error).message}` };
  } finally {
    // Drop our temp directory entry; the link at lockPath (when created)
    // keeps the inode alive with the full owner content.
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
  }
}

interface LockInspection {
  /** inode of the lock file the owner content was read from. */
  ino: number;
  /** Parsed owner, or null when the content is unreadable/malformed. */
  owner: StateLockOwner | null;
}

/**
 * Inspect the current lock holder through ONE file descriptor, so the inode
 * and the owner metadata always describe the same generation even if a
 * concurrent reclaimer replaces the file between the open and the read.
 */
function inspectLock(lockPath: string): LockInspection | null {
  let fd: number;
  try {
    fd = openSync(lockPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const ino = fstatSync(fd).ino;
    let owner: StateLockOwner | null = null;
    try {
      const parsed = JSON.parse(readFileSync(fd, "utf8")) as StateLockOwner;
      if (parsed && Number.isInteger(parsed.pid) && typeof parsed.token === "string") owner = parsed;
    } catch {
      owner = null;
    }
    return { ino, owner };
  } finally {
    closeSync(fd);
  }
}

/**
 * Reclaim a verified-dead lock WITHOUT ever unlinking the live lock path.
 *
 * The current file is RENAMED to a private quarantine name — an atomic
 * move — and only the quarantined inode is ever unlinked, and only when it
 * is still the exact inode whose dead owner this waiter inspected. A waiter
 * that observed an older stale generation can therefore never delete a live
 * lock created after its snapshot:
 *   - the rename moves whatever is at the path NOW;
 *   - an inode mismatch means a newer (live) lock was displaced — it is
 *     restored with a hard link back to the path (exclusive-create checked)
 *     and this waiter simply retries;
 *   - an inode match means the dead lock itself was quarantined, and only
 *     its private quarantine name is removed.
 */
function reclaimStaleLock(lockPath: string, wsDir: string, observed: LockInspection): string | null {
  const token = randomUUID();
  const guardPath = join(wsDir, `${STATE_LOCK_RECLAIM_PREFIX}${token}`);
  const guard = tryCreateLock(guardPath, {
    pid: process.pid,
    token,
    acquired_at: new Date().toISOString(),
  });
  if (!guard.created) {
    return guard.reason === "error" ? guard.error : "state lock reclaim guard collision";
  }
  try {
    const guards = inspectReclaimGuards(wsDir, token);
    if (guards.error) return guards.error;
    if (guards.blocked) return null;

    // The guard closes the inspect-to-rename gap. Every conforming creator
    // checks for a live guard before publishing a generation; a creator that
    // passed that check before our guard can only (a) fail while the stale
    // generation is still present, or (b) publish after this rename. Re-read
    // through one fd after publishing the guard so a newer live generation
    // observed before the rename is never displaced.
    const current = inspectLock(lockPath);
    if (
      current === null
      || current.ino !== observed.ino
      || !current.owner
      || !observed.owner
      || current.owner.token !== observed.owner.token
      || current.owner.pid !== observed.owner.pid
      || pidAlive(current.owner.pid)
    ) {
      return null;
    }

    const quarantine = `${lockPath}.${randomUUID()}.stale`;
    try {
      renameSync(lockPath, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return `state lock unavailable: ${(error as Error).message}`;
    }
    try {
      if (statSync(quarantine).ino !== observed.ino) {
        // Non-conforming external writers are outside the advisory protocol;
        // restore their generation if one appeared despite the guarded
        // re-read. Protocol participants cannot reach this branch.
        try {
          linkSync(quarantine, lockPath);
        } catch {
          // A still newer generation already occupies the authoritative path.
        }
        return "state lock generation changed during guarded reclaim";
      }
    } finally {
      try {
        unlinkSync(quarantine);
      } catch {
        // The quarantine name is never authoritative.
      }
    }
    return null;
  } finally {
    try {
      unlinkSync(guardPath);
    } catch {
      // The unique guard path is best-effort cleanup after ownership ends.
    }
  }
}

/**
 * Inspect immutable, uniquely-named reclaim guards. Dead guards are safe to
 * remove because their UUID path is never reused; unlike the authoritative
 * lock path, cleanup can therefore never unlink a newer generation.
 */
function inspectReclaimGuards(wsDir: string, ownToken?: string): { blocked: boolean; error?: string } {
  let entries: string[];
  try {
    entries = readdirSync(wsDir).filter((entry) => entry.startsWith(STATE_LOCK_RECLAIM_PREFIX));
  } catch (error) {
    return { blocked: false, error: `state lock unavailable: ${(error as Error).message}` };
  }
  for (const entry of entries) {
    const guardPath = join(wsDir, entry);
    let inspection: LockInspection | null;
    try {
      inspection = inspectLock(guardPath);
    } catch (error) {
      return { blocked: false, error: `state lock unavailable: ${(error as Error).message}` };
    }
    if (inspection === null) continue;
    const owner = inspection.owner;
    if (!owner) return { blocked: false, error: "state lock reclaim guard has an unreadable owner" };
    if (owner.token === ownToken) continue;
    if (pidAlive(owner.pid)) return { blocked: true };
    try {
      unlinkSync(guardPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { blocked: false, error: `state lock unavailable: ${(error as Error).message}` };
      }
    }
  }
  return { blocked: false };
}

function acquireStateLock(wsDir: string, timeoutMs: number): { token: string } | { error: string } {
  const lockPath = join(wsDir, STATE_LOCK_FILE);
  const startedAt = Date.now();
  for (;;) {
    mkdirSync(wsDir, { recursive: true });
    const guards = inspectReclaimGuards(wsDir);
    if (guards.error) return { error: guards.error };
    if (!guards.blocked) {
      const token = randomUUID();
      const created = tryCreateLock(lockPath, { pid: process.pid, token, acquired_at: new Date().toISOString() });
      if (created.created) return { token };
      if (created.reason === "error") return { error: created.error };
      let inspection: LockInspection | null = null;
      try {
        inspection = inspectLock(lockPath);
      } catch (error) {
        return { error: `state lock unavailable: ${(error as Error).message}` };
      }
      if (inspection === null) continue;
      if (inspection.owner && pidAlive(inspection.owner.pid)) {
        // Live owner in another process: never stolen, only waited for.
      } else if (inspection.owner) {
        const reclaimError = reclaimStaleLock(lockPath, wsDir, inspection);
        if (reclaimError) return { error: reclaimError };
      } else {
        // With atomic owner publication a partial owner cannot occur, so an
        // unreadable owner is foreign corruption: it is not verifiably dead
        // and is never stolen. Waiting cannot help because there is no owner
        // to liveness-check. Fail closed immediately.
        return { error: "state lock is held by an unreadable owner; refusing to steal it" };
      }
    }
    if (Date.now() >= startedAt + timeoutMs) {
      return { error: "state lock wait timeout exceeded" };
    }
    sleepSync(STATE_LOCK_RETRY_MS);
  }
}

function releaseStateLock(wsDir: string, token: string): void {
  const lockPath = join(wsDir, STATE_LOCK_FILE);
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as StateLockOwner;
    if (owner.token === token) unlinkSync(lockPath);
  } catch {
    // The lock vanished or is no longer ours; nothing to release.
  }
}

interface RawStateSnapshot {
  kind: "present";
  state: TeamState;
  revision: number;
  raw_hash: string;
}

type RawStateRead =
  | RawStateSnapshot
  | { kind: "absent" }
  | { kind: "invalid"; error: string };

export interface StateTransactionTestHooks {
  afterTargetResolution?: (paths: { statePath: string; stateDir: string; artifactsDir: string }) => void;
  beforeCas?: (paths: { sourcePath: string; destinationPath: string }) => void;
  afterJournalFinalize?: (outcome: { committed: boolean; lockPath: string }) => void;
}

let stateTransactionTestHooks: StateTransactionTestHooks | null = null;

/** Internal deterministic race/fault seam; not exported from the package index. */
export function setStateTransactionTestHooks(hooks: StateTransactionTestHooks | null): void {
  stateTransactionTestHooks = hooks;
}


function hashRawState(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Read persisted bytes exactly once and derive normalization, revision and
 * hash from that same byte string. ENOENT is the only absent state; malformed
 * or otherwise unreadable files fail closed instead of masquerading as absence.
 */
function readRawStateSnapshot(statePath: string | null | undefined): RawStateRead {
  if (!statePath) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", error: `workflow state is unreadable: ${(error as Error).message}` };
  }
  try {
    const parsed = JSON.parse(raw) as { state_revision?: unknown };
    const issues: string[] = [];
    const state = normalizePersistedState(parsed, issues);
    if (!state) {
      return { kind: "invalid", error: `workflow state is malformed: ${issues.join("; ") || "unrecognized shape"}` };
    }
    const revision = Number.isInteger(parsed?.state_revision) && (parsed.state_revision as number) >= 0
      ? parsed.state_revision as number
      : 0;
    return { kind: "present", state, revision, raw_hash: hashRawState(raw) };
  } catch (error) {
    return { kind: "invalid", error: `workflow state is malformed: ${(error as Error).message}` };
  }
}

interface TransactionTargetResolution {
  prepared: PreparedStateTarget;
  target: ResolvedState;
}

function transactionTarget(
  cwd: string,
  realWorkState: string,
  wsDir: string,
  resolved: ResolvedState,
  branch: string,
  featureSlug?: string,
): TransactionTargetResolution {
  if (resolved.invalid && !resolved.stateDir && !resolved.statePath && !resolved.artifactsDir) {
    throw new Error("workflow state is invalid or unsafe");
  }
  if (resolved.stateDir || resolved.statePath || resolved.artifactsDir) {
    if (!resolved.stateDir || !resolved.artifactsDir) throw new Error("workflow state target is incomplete");
    const statePath = resolved.statePath
      ?? (resolved.isLegacy ? join(wsDir, LEGACY_STATE) : join(resolved.stateDir, "state.json"));
    const target: ResolvedState = { ...resolved, state: null, statePath, invalid: undefined };
    return { prepared: prepareExistingTarget(realWorkState, wsDir, target), target };
  }
  const prepared = prepareStateTarget(cwd, realWorkState, wsDir, { branch }, { featureSlug });
  return {
    prepared,
    target: {
      state: null,
      statePath: prepared.statePath,
      stateDir: prepared.stateDir,
      artifactsDir: prepared.artifactsDir,
      isLegacy: prepared.featureSlug === null,
      isStale: false,
    },
  };
}

/** The feature destination a branch-retargeting transaction would commit to. */
function featureDestinationPath(wsDir: string, branch: string, featureSlug?: string): string {
  const slug = featureSlug ?? deriveFeatureSlugFromBranch(branch) ?? "default";
  return join(wsDir, "features", slug, "state.json");
}

function casConflict(observed: RawStateRead, current: RawStateRead): string | null {
  if (current.kind === "invalid") return current.error;
  if (observed.kind === "invalid") return observed.error;
  if (observed.kind !== current.kind) {
    return observed.kind === "present"
      ? "workflow state was deleted during the transaction"
      : "workflow state was created during the transaction";
  }
  if (observed.kind === "present" && current.kind === "present"
    && (observed.revision !== current.revision || observed.raw_hash !== current.raw_hash)) {
    return `workflow state moved during the transaction (snapshot revision ${observed.revision}, found ${current.revision})`;
  }
  return null;
}

/**
 * Run one state mutation as a cross-process transaction.
 *
 * The mutation ALWAYS runs against the latest persisted state — never a
 * snapshot taken before an await — and its commit is guarded by a
 * revision + raw-hash CAS plus the workspace lock, so a concurrent writer
 * can neither be clobbered nor lost. Unrelated concurrent fields survive:
 * the mutation spreads the fresh snapshot, not its own stale copy.
 */
export function updateStateAtomically<T>(
  cwd: string,
  mutate: (snapshot: StateSnapshot) => StateMutation<T>,
  opts: { lockTimeoutMs?: number; target?: ResolvedState; branch?: string; featureSlug?: string } = {},
): StateUpdateResult<T> {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  mkdirSync(wsDir, { recursive: true });
  const realWorkState = realpathSync(wsDir);
  if (!isWithin(realpathSync(cwd), realWorkState)) {
    return { ok: false, code: "state_invalid", error: "workflow state path escapes project root" };
  }
  const lock = acquireStateLock(wsDir, opts.lockTimeoutMs ?? STATE_LOCK_DEFAULT_TIMEOUT_MS);
  if ("error" in lock) return { ok: false, code: "state_lock_unavailable", error: lock.error };
  beginArtifactJournal();
  let journalFinalized = false;
  const finalizeJournal = (committed: boolean): void => {
    if (journalFinalized) return;
    const journal = endArtifactJournal();
    journalFinalized = true;
    if (committed) commitArtifactJournal(journal);
    else rollbackArtifactJournal(journal);
    stateTransactionTestHooks?.afterJournalFinalize?.({
      committed,
      lockPath: join(wsDir, STATE_LOCK_FILE),
    });
  };
  try {
    const branch = opts.branch ?? resolveActiveBranch(cwd);
    const resolution = opts.target ?? resolveState(cwd, branch);
    let initial: TransactionTargetResolution;
    try {
      initial = transactionTarget(cwd, realWorkState, wsDir, resolution, branch, opts.featureSlug);
    } catch (error) {
      return { ok: false, code: "state_invalid", error: (error as Error).message };
    }
    // Snapshot the candidate retarget destination at initial resolution so
    // the pre-CAS check can distinguish a pre-existing own-branch state
    // (honest already-exists conflict) from a destination that appeared or
    // changed mid-transaction (fail-closed foreign-creation conflict).
    const candidateDestinationPath = featureDestinationPath(wsDir, branch, opts.featureSlug);
    const destinationAtResolution = candidateDestinationPath !== initial.prepared.statePath
      ? readRawStateSnapshot(candidateDestinationPath)
      : null;
    stateTransactionTestHooks?.afterTargetResolution?.({
      statePath: initial.prepared.statePath,
      stateDir: initial.prepared.stateDir,
      artifactsDir: initial.prepared.artifactsDir,
    });
    const raw = readRawStateSnapshot(initial.prepared.statePath);
    if (raw.kind === "invalid") return { ok: false, code: "state_invalid", error: raw.error };
    const state = raw.kind === "present" ? raw.state : null;
    const revision = raw.kind === "present" ? raw.revision : 0;
    const rawHash = raw.kind === "present" ? raw.raw_hash : "";
    // opts.target.state and resolveState's parsed object are deliberately
    // ignored: the transaction state, revision and hash all come from `raw`.
    const target: ResolvedState = {
      ...initial.target,
      state,
      isStale: state !== null ? state.branch !== branch : false,
    };
    const snapshot: StateSnapshot = { state, target, revision, raw_hash: rawHash };
    const mutation = mutate(snapshot);
    if (mutation.op === "fail") return { ok: false, code: mutation.code, error: mutation.error };
    if (mutation.op === "discard") {
      return { ok: true, state, target, revision, committed: false, value: mutation.value };
    }

    // Resolve the final destination before either CAS. A stale active feature
    // retargets by the mutation's branch, but an existing future destination
    // is always a conflict — it is never adopted or overwritten; only the
    // classification (honest own-branch already-exists vs mid-transaction
    // creation) is decided from the resolution-time destination snapshot.
    const staleForBranch = state !== null
      && target.isStale
      && typeof mutation.state.branch === "string"
      && mutation.state.branch !== state.branch;
    let prepared: PreparedStateTarget;
    try {
      prepared = staleForBranch
        ? prepareStateTarget(cwd, realWorkState, wsDir, mutation.state, { featureSlug: opts.featureSlug })
        : initial.prepared;
    } catch (error) {
      return { ok: false, code: "state_invalid", error: (error as Error).message };
    }

    stateTransactionTestHooks?.beforeCas?.({
      sourcePath: initial.prepared.statePath,
      destinationPath: prepared.statePath,
    });
    const sourceCurrent = readRawStateSnapshot(initial.prepared.statePath);
    const sourceConflict = casConflict(raw, sourceCurrent);
    if (sourceConflict) return { ok: false, code: "state_conflict", error: sourceConflict };
    if (prepared.statePath !== initial.prepared.statePath || target.isStale || raw.kind !== "present") {
      const destination = readRawStateSnapshot(prepared.statePath);
      if (destination.kind === "invalid") return { ok: false, code: "state_conflict", error: destination.error };
      if (destination.kind === "present") {
        // Timing + ownership: a destination that already existed at initial
        // resolution, is unchanged since, and belongs to the mutation's
        // branch is the run's own pre-existing state — report the honest,
        // recoverable conflict. A destination that appeared or changed
        // mid-transaction, or is owned by another branch, is never adopted
        // or overwritten and keeps the fail-closed creation conflict.
        const atResolution = destinationAtResolution;
        const preExistingOwnBranch = atResolution !== null
          && atResolution.kind === "present"
          && prepared.statePath === candidateDestinationPath
          && atResolution.revision === destination.revision
          && atResolution.raw_hash === destination.raw_hash
          && typeof mutation.state.branch === "string"
          && destination.state.branch === mutation.state.branch;
        return {
          ok: false,
          code: "state_conflict",
          error: preExistingOwnBranch
            ? "workflow state already exists for this branch; use continuation mode"
            : "workflow state was created at the future destination during the transaction",
        };
      }
    }

    let committed: CommittedState;
    try {
      committed = commitState(cwd, prepared, mutation.state, revision + 1);
    } catch (error) {
      return { ok: false, code: "state_invalid", error: `workflow state commit failed: ${(error as Error).message}` };
    }
    // state.json is authoritative now. Publish buffered observability while
    // still holding the same lock; commit hooks can never request rollback.
    finalizeJournal(true);
    const committedTarget: ResolvedState = {
      state: committed.state,
      statePath: prepared.statePath,
      stateDir: prepared.stateDir,
      artifactsDir: prepared.artifactsDir,
      isLegacy: prepared.featureSlug === null,
      isStale: false,
    };
    return { ok: true, state: committed.state, target: committedTarget, revision: revision + 1, committed: true, value: mutation.value };
  } finally {
    finalizeJournal(false);
    releaseStateLock(wsDir, lock.token);
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup must not hide the original I/O error.
    }
    throw error;
  }
}
function readObservabilityPointerSafe(cwd: string, featureSlug: string) {
  try {
    return readObservabilityPointer(cwd, featureSlug);
  } catch {
    return null;
  }
}

function renderStateMd(state: TeamState): string {
  const lines: string[] = [];
  lines.push("# TEAM STATE");
  lines.push("");
  lines.push("## Classification");
  lines.push(`- Type: ${state.classification.type}`);
  lines.push(`- Complexity: ${state.classification.complexity}`);
  lines.push(`- Workflow: ${state.classification.workflow}`);
  lines.push(`- Confidence: ${state.classification.confidence}`);
  lines.push(`- Autonomous: ${state.classification.autonomous}`);
  if (state.classification.autonomous_reason) {
    lines.push(`- Autonomous reason: ${state.classification.autonomous_reason}`);
  }
  lines.push("");
  const typed = state as TeamState & {
    checkpoint_policy?: CheckpointPolicy;
    migration?: MigrationReceipt;
    control_plane_provenance?: ControlPlaneProvenance;
    work_identity?: WorkIdentity;
    pending?: PendingState;
    completion_envelope?: CompletionEnvelope;
  };
  if (typed.completion_intent) {
    lines.push("## Completion intent");
    lines.push(`- mode: ${typed.completion_intent.mode}`);
    lines.push(`- acceptance: ${typed.completion_intent.acceptance}`);
    lines.push(`- source: ${typed.completion_intent.source}`);
    lines.push("");
  }
  if (typed.checkpoint_policy) {
    lines.push("## Checkpoint policy");
    lines.push(`- default: ${typed.checkpoint_policy.default}`);
    lines.push(`- rules: ${Object.keys(typed.checkpoint_policy.rules).sort().join(", ") || "none"}`);
    lines.push("- legacy autonomy/prose is migration/display input only");
    lines.push("");
  }
  if (typed.work_identity) {
    lines.push("## Work identity");
    lines.push(`- run: ${typed.work_identity.run_id}`);
    lines.push(`- wave: ${typed.work_identity.wave_id}`);
    lines.push(`- slice: ${typed.work_identity.slice_id}`);
    lines.push(`- stage: ${typed.work_identity.stage_id}`);
    lines.push(`- task: ${typed.work_identity.task_id}`);
    lines.push("");
  }
  if (typed.pending) {
    lines.push("## Pending");
    lines.push(`- status: ${typed.pending.status}`);
    lines.push(`- reason: ${typed.pending.pending_reason ?? "none"}`);
    lines.push("");
  }
  if (typed.migration || typed.control_plane_provenance) {
    lines.push("## Control-plane provenance");
    if (typed.migration) lines.push(`- migration: ${typed.migration.status} (${typed.migration.from_schema} → ${typed.migration.to_schema})`);
    if (typed.control_plane_provenance) lines.push(`- status: ${typed.control_plane_provenance.status}`);
    if (typed.control_plane_provenance?.legacy_inputs.length) lines.push(`- legacy inputs: ${typed.control_plane_provenance.legacy_inputs.join(", ")}`);
    lines.push("");
  }
  lines.push("## Task");
  lines.push(state.task);
  lines.push("");
  lines.push("## Progress");
  for (const s of state.stages) {
    const mark = s.status === "done" ? "[x]" : s.status === "in_progress" ? "[~]" : s.status === "skipped" ? "[s]" : s.status === "failed" ? "[!]" : "[ ]";
    lines.push(`- ${mark} ${s.id} - ${s.status}`);
  }
  lines.push("");
  lines.push("## Pause");
  lines.push(`- kind: ${state.pause.kind}`);
  if (state.pause.reason) lines.push(`- reason: ${state.pause.reason}`);
  lines.push("");
  lines.push("## Branch");
  lines.push(state.branch);
  lines.push("");
  lines.push("## Last update");
  lines.push(`- ${state.updated_at}`);
  lines.push("");
  if (state.observability) {
    const r = state.observability.rollup;
    lines.push("## Observability");
    lines.push(`- events: ${state.observability.eventsPath} (last id: ${state.observability.lastEventId || "none"})`);
    lines.push(`- agent invocations: ${r.agentInvocations}`);
    const subagentEntries = Object.entries(r.subagents).sort((a, b) => b[1] - a[1]);
    if (subagentEntries.length > 0) {
      lines.push("- subagents:");
      for (const [name, count] of subagentEntries) {
        lines.push(`  - ${name}: ${count}`);
      }
    }
    const skillEntries = Object.entries(r.skills).sort((a, b) => b[1] - a[1]);
    if (skillEntries.length > 0) {
      lines.push("- skills:");
      for (const [name, count] of skillEntries) {
        lines.push(`  - ${name}: ${count}`);
      }
    }
    if (r.totalToolCalls > 0) {
      lines.push(`- tool calls: ${r.totalToolCalls} (errors: ${r.totalToolErrors})`);
    }
    if (r.durationMs > 0) {
      lines.push(`- duration: ${r.durationMs}ms (${r.firstEventAt} → ${r.lastEventAt})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function writeStateMd(stateDir: string, state: TeamState): void {
  atomicWrite(join(stateDir, STATE_MD), renderStateMd(state));
}

export function setPause(state: TeamState, kind: PauseKind, reason = ""): TeamState {
  return { ...state, pause: { kind, reason }, updated_at: new Date().toISOString() };
}

export function setStageStatus(
  state: TeamState,
  stageId: string,
  status: StageStatus,
  /** Project root — enables best-effort stage_transition telemetry (optional). */
  cwd?: string,
): TeamState {
  const stages = state.stages.map((s) => (s.id === stageId ? { ...s, status } : s));
  const cursor = status === "in_progress" ? stageId : state.stage_cursor;
  if (cwd) {
    publishAfterStateCommit(() => {
      try {
        recordStageTransition(cwd, { stageId, stageStatus: status });
      } catch {
        // best-effort telemetry — never blocks the state transition
      }
    });
  }
  return { ...state, stages, stage_cursor: cursor, updated_at: new Date().toISOString() };
}
/**
 * Reopen a completed workflow after user feedback without losing prior state.
 * The affected stage and all downstream stages become pending; upstream
 * artifacts and stage history remain intact.
 */
export function reopenFromFeedback(
  state: TeamState,
  feedback: string,
  stageId: string,
): TeamState {
  const target = stageId;
  const index = state.stages.findIndex((stage) => stage.id === target);
  if (index < 0) throw new Error(`cannot reopen unknown stage: ${target}`);
  const history = [...(state.history ?? []), { task: state.task, feedback, at: new Date().toISOString() }];
  const stages = state.stages.map((stage, i) =>
    i >= index ? { ...stage, status: "pending" as const } : stage,
  );
  return {
    ...state,
    task: `${state.task}\n\nUser feedback: ${feedback}`,
    history,
    stages,
    stage_cursor: target,
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Monotonic check: a stage with `pending` must not precede a stage that is
 * `done` or `in_progress`. The P4 gate in claude-plugin's validate-state.sh.
 */
export function checkMonotonic(state: TeamState): { ok: true } | { ok: false; violation: string } {
  const statuses = state.stages.map((s) => s.status ?? "pending");
  const firstPending = statuses.indexOf("pending");
  if (firstPending === -1) return { ok: true };
  const after = statuses.slice(firstPending + 1).filter((s) => s === "done" || s === "in_progress");
  if (after.length > 0) {
    return {
      ok: false,
      violation: `stage progress is not monotonic — stage ${state.stages[firstPending]?.id ?? "?"} is pending while a later stage is done/in_progress`,
    };
  }
  return { ok: true };
}

function deriveFeatureSlugFromBranch(branch: string): string | null {
  if (!branch) return null;
  return branch.replace(/\//g, "-").replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
}

export function archiveStaleState(statePath: string, state: TeamState): void {
  const archiveDir = join(dirname(statePath), "..", "archive");
  try {
    mkdirSync(archiveDir, { recursive: true });
    const safeBranch = state.branch.replace(/\//g, "-").replace(/[^a-z0-9._-]/gi, "-");
    const dest = join(archiveDir, `${safeBranch}.${Date.now()}.bak.json`);
    writeFileSync(dest, JSON.stringify(state, null, 2));
  } catch {
    // best-effort
  }
}

export function listFeatures(cwd: string): string[] {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  const featuresDir = join(wsDir, "features");
  if (!existsSync(featuresDir)) return [];
  return readdirSync(featuresDir).filter((name) => {
    if (!isSafeStateSegment(name)) return false;
    const statePath = join(featuresDir, name, "state.json");
    return existsSync(statePath);
  });
}
