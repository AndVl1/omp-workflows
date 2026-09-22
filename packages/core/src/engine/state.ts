/**
 * Canonical workflow state machine: read/write `.work-state/runs/<run-id>/state.json`
 * with monotonic progress, explicit run identity, branch-context checks, and
 * lock/CAS publication.
 *
 * Legacy root/feature state is not runtime authority. Legacy source discovery
 * and reads belong exclusively to the explicit run-migration importer.
 */
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { recordStageTransition } from "../observability/hooks.js";
import {
  beginArtifactJournal,
  recoverArtifactJournals,
  assertNoPendingArtifactJournals,
  markArtifactJournalCommit,
  markArtifactJournalLifecycle,
  artifactJournalHasCommitBoundary,
  commitArtifactJournal,
  endArtifactJournal,
  publishAfterStateCommit,
  rollbackArtifactJournal,
} from "./artifacts.js";
import { assertNoUnresolvedLifecycleTransactions, beginLifecycleTransaction, commitLifecycleTransaction, recoverLifecycleTransactions } from "./lifecycle-journal.js";
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
const ORDINARY_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_MD = "team-state.md";

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.includes("/") && !rel.includes("\\"));
}
function isWithinTree(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
export function isSafeStateSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);
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
  if (state.schema !== undefined && state.schema !== 1 && state.schema !== 2) {
    issues.push("$.schema must be schema 1 (legacy) or schema 2 (ordinary canonical)");
  }
  if (state.schema === 2) {
    if (!nonEmptyStateString(state.run_id)) issues.push("$.run_id is required for schema 2 ordinary state");
    if (nonEmptyStateString(state.run_id) && !ORDINARY_RUN_ID_PATTERN.test(state.run_id)) issues.push("$.run_id must be a UUID for schema 2 ordinary state");
    if (!nonEmptyStateString(state.run_key)) issues.push("$.run_key is required for schema 2 ordinary state");
    if (nonEmptyStateString(state.run_id) && nonEmptyStateString(state.run_key) && state.run_id !== state.run_key) {
      issues.push("$.run_key must equal $.run_id for schema 2 ordinary state");
    }
    if (state.rework_generation !== undefined && (typeof state.rework_generation !== "number" || !Number.isInteger(state.rework_generation) || state.rework_generation < 0)) {
      issues.push("$.rework_generation must be an integer >= 0");
    }
  }
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
  if (state.schema !== 2 && state.work_identity === undefined && !capability && stageId && nonEmptyStateString(state.run_key ?? state.branch)) state.work_identity = legacyIdentity(state, workflow, stageId, capability);
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
  // Canonical ordinary runs are schema 2. They may receive typed control-plane
  // defaults during normalization, but that projection is not a lifecycle
  // migration and must not invent a schema receipt. Only legacy inputs (schema
  // 1 or an omitted schema) acquire a synthesized receipt here; an existing
  // import receipt is always preserved above.
  if (!migration && state.schema !== 2) {
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
  /** Canonical UUID run target; ordinary state is never selected from branch or marker files. */
  canonicalRun?: boolean;
  invalid?: boolean;
}

/**
 * A mutation target for an ordinary workflow run. Unlike a generic resolved
 * state, this shape cannot omit canonical identity, paths, or branch context.
 */
export interface CanonicalRunTarget {
  state: TeamState | null;
  statePath: string;
  stateDir: string;
  artifactsDir: string;
  isLegacy: false;
  isStale: boolean;
  canonicalRun: true;
  schema: 2;
  runId: string;
  runKey: string;
  branch: string;
  invalid?: false;
}

/** Canonical ordinary resolution with the run metadata used by read callers. */
export type ResolvedCanonicalRun = ResolvedActiveRun & CanonicalRunTarget;

/** Canonical run targets are explicit; legacy root and feature state are importer-only. */

export type StateSelector = { kind?: "auto" | "team" | "cto-slice"; runId?: string; sliceId?: string; capabilityId?: string };
export interface ResolvedActiveRun extends ResolvedState {
  kind: "legacy-root" | "feature" | "run" | "cto-slice";
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

/** Resolve one explicitly selected canonical run. Legacy selectors fail closed. */
export function resolveCanonicalRun(
  cwd: string,
  selector: { kind?: "auto" | "team"; runId: string },
  currentBranch?: string,
): ResolvedCanonicalRun | null;
export function resolveCanonicalRun(cwd: string, selector?: StateSelector, currentBranch?: string): ResolvedActiveRun | null;
export function resolveCanonicalRun(cwd: string, selector: StateSelector = {}, currentBranch?: string): ResolvedCanonicalRun | ResolvedActiveRun | null {
  const branch = currentBranch;
  if (selector.kind !== "cto-slice" && selector.runId) {
    const runId = selector.runId;
    if (!ORDINARY_RUN_ID_PATTERN.test(runId)) throw new Error("migration_required: canonical run selector requires a UUID run id");
    const wsDir = resolve(cwd, WORK_STATE_DIR);
    const runsDir = join(wsDir, "runs");
    const stateDir = join(runsDir, runId);
    const statePath = join(stateDir, "state.json");
    const artifactsDir = join(stateDir, "artifacts");
    try {
      const realWorkState = realpathSync(wsDir);
      const realCwd = realpathSync(cwd);
      if (!isWithin(realCwd, realWorkState)) throw new Error("ordinary run target escapes project root");
      const realRuns = existsSync(runsDir) ? realpathSync(runsDir) : runsDir;
      if (!isWithin(realWorkState, realRuns) || (existsSync(stateDir) && !isWithin(realRuns, realpathSync(stateDir)))) {
        throw new Error("ordinary run target escapes .work-state/runs");
      }
      if (!existsSync(statePath)) return null;
      if (!isWithin(realpathSync(stateDir), realpathSync(statePath))) throw new Error("ordinary run state escapes its run directory");
      if (existsSync(artifactsDir) && !isWithin(realpathSync(stateDir), realpathSync(artifactsDir))) throw new Error("ordinary run artifacts escape its run directory");
      const rejectionIssues: string[] = [];
      const state = normalizePersistedState(JSON.parse(readFileSync(statePath, "utf8")), rejectionIssues);
      if (!state || state.schema !== 2 || state.run_id !== runId || state.run_key !== runId) throw new Error(rejectionIssues.join("; ") || "ordinary run state identity is invalid");
      const staleReason = branch && state.branch !== branch ? `branch mismatch: persisted '${state.branch}', current '${branch}'` : null;
      return {
        state,
        statePath,
        stateDir,
        artifactsDir,
        isLegacy: false,
        isStale: Boolean(staleReason),
        canonicalRun: true,
        schema: 2,
        runId,
        runKey: runId,
        kind: "run",
        branch: state.branch,
        workflow: state.classification.workflow,
        profileHash: state.profile_hash ?? "",
        stageCursor: state.stage_cursor,
        cursorEpoch: state.cursor_epoch ?? "",
        dispatch: state.dispatch_capability ?? null,
        staleReason,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
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
  // Unscoped ordinary authority is canonical-run only. Legacy state is read by
  // the explicit migration importer, never by a generic runtime resolver.
  return null;
}


interface PreparedStateTarget {
  stateDir: string;
  statePath: string;
  artifactsDir: string;
  canonicalRun: true;
}

/** Validate and prepare one explicit canonical run target. */
function validatePreparedTarget(realWorkState: string, wsDir: string, prepared: Omit<PreparedStateTarget, "canonicalRun">): PreparedStateTarget {
  const stateDir = resolve(prepared.stateDir);
  const statePath = resolve(prepared.statePath);
  const artifactsDir = resolve(prepared.artifactsDir);
  const runsDir = join(wsDir, "runs");
  const runId = basename(stateDir);
  if (!ORDINARY_RUN_ID_PATTERN.test(runId)) throw new Error("canonical workflow target must name a UUID run");
  if (statePath !== join(stateDir, "state.json")) throw new Error("canonical workflow state path must be runs/<run-id>/state.json");
  if (artifactsDir !== join(stateDir, "artifacts")) throw new Error("canonical workflow artifacts path must be runs/<run-id>/artifacts");

  mkdirSync(runsDir, { recursive: true });
  const realRuns = realpathSync(runsDir);
  if (!isWithin(realWorkState, realRuns)) throw new Error("canonical workflow runs path escapes .work-state/runs");
  mkdirSync(stateDir, { recursive: true });
  const realStateDir = realpathSync(stateDir);
  if (!isWithin(realRuns, realStateDir)) throw new Error("canonical workflow state directory escapes .work-state/runs");
  if (!isWithinTree(realWorkState, realStateDir)) throw new Error("workflow state directory escapes .work-state");
  if (!isWithin(realStateDir, realpathSync(dirname(statePath)))) throw new Error("workflow state path escapes its state directory");
  mkdirSync(artifactsDir, { recursive: true });
  if (!isWithin(realStateDir, realpathSync(artifactsDir))) throw new Error("workflow artifacts path escapes its state directory");
  return { stateDir, statePath, artifactsDir, canonicalRun: true };
}

/** Reuse a canonical target's exact paths for a transactional commit. */
function prepareExistingTarget(realWorkState: string, wsDir: string, target: CanonicalRunTarget): PreparedStateTarget {
  if (target.canonicalRun !== true) throw new Error("migration_required: only canonical run targets may be mutated");
  const prepared = validatePreparedTarget(realWorkState, wsDir, {
    stateDir: target.stateDir,
    statePath: target.statePath,
    artifactsDir: target.artifactsDir,
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

export interface StatePublication {
  operation: "new" | "resume" | "rework" | "migration" | "claim";
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

function commitState(
  cwd: string,
  prepared: PreparedStateTarget,
  state: TeamState,
  stateRevision: number,
  publication?: StatePublication,
): CommittedState {
  const { stateDir, statePath, artifactsDir } = prepared;
  const rejectionIssues: string[] = [];
  const normalized = normalizePersistedState(state, rejectionIssues);
  if (!normalized) throw new Error(`workflow state contains malformed or conflicting typed control-plane fields: ${rejectionIssues.join("; ") || "unrecognized shape"}`);
  const stamped: TeamState = { ...normalized, state_revision: stateRevision, updated_at: new Date().toISOString() };

  const stateContent = JSON.stringify(stamped, null, 2) + "\n";
  const stateMdPath = join(stateDir, STATE_MD);
  const stateMdContent = renderStateMd(stamped);
  // State JSON is authoritative; the markdown mirror is published first.
  const previousStateMd = readRegularFileNoFollow(stateMdPath);
  const stateMdWrite = prepareFileWrite(stateMdPath, stateMdContent);
  let stateWrite: PreparedFileWrite | null = null;
  let stateMdPublished = false;
  try {
    stateWrite = prepareFileWrite(statePath, stateContent);
    renameSync(stateMdWrite.tempPath, stateMdPath);
    stateMdPublished = true;
    // Authoritative commit point. When a lifecycle publication is supplied,
    // state.json and its control sidecar share one durable journal marker.
    if (publication) {
      markArtifactJournalCommit(statePath, stateContent);
      const transaction = beginLifecycleTransaction({
        cwd,
        operation: publication.operation,
        before: { [statePath]: readRegularFileNoFollow(statePath), ...publication.before },
        after: { [statePath]: stateContent, ...publication.after },
      });
      markArtifactJournalLifecycle(transaction.transaction_id);
      commitLifecycleTransaction(cwd, transaction.transaction_id);
    } else {
      markArtifactJournalCommit(statePath, stateContent);
      renameSync(stateWrite.tempPath, statePath);
    }
  } catch (error) {
    if (stateMdPublished) restoreSidecar(stateMdPath, previousStateMd, stateMdContent);
    throw error;
  } finally {
    cleanupPreparedWrite(stateMdWrite);
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
const STATE_LOCK_DEFAULT_TIMEOUT_MS = 30_000;
const STATE_LOCK_RECLAIM_PREFIX = ".state.lock.reclaim.";
export type StateTxErrorCode =
  | "state_invalid"
  | "state_missing"
  | "state_conflict"
  | "state_lock_unavailable"
  | "recovery_required";

export interface StateSnapshot {
  /** Latest normalized state, or null when the run has not been created yet. */
  state: TeamState | null;
  target: CanonicalRunTarget;
  /** Canonical CAS revision (legacy inputs read as 0). */
  revision: number;
  /** SHA-256 over the raw persisted bytes backing the snapshot. */
  raw_hash: string;
}

/**
 * A mutation may fail with its own domain code (e.g. a typed checkpoint
 * code); the transaction itself only ever surfaces its `StateTxErrorCode` values,
 * with the explanation carried in `error`.
 */
export type StateMutationCode = StateTxErrorCode | (string & {});

export type StateMutation<T> =
  | { op: "commit"; state: TeamState; value?: T; publication?: StatePublication }
  | { op: "discard"; value?: T }
  | { op: "fail"; code: StateMutationCode; error: string };

export type StateUpdateResult<T> =
  | { ok: true; state: TeamState | null; target: CanonicalRunTarget; revision: number; committed: boolean; value?: T }
  // Transaction-level failures always carry one of the `StateTxErrorCode` values;
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

/**
 * Shared workspace transaction seam for lifecycle control and state changes.
 * Every caller uses the same lock as updateStateAtomically; recovery runs
 * while that lock is held, so a malformed or torn lifecycle record fails
 * closed before any reader or writer can inspect authority.
 */
function withLockedWorkspace<T>(
  cwd: string,
  action: () => T,
  opts: { lockTimeoutMs?: number; createIfMissing?: boolean },
  recover: boolean,
): T {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  if (!existsSync(wsDir)) {
    if (opts.createIfMissing === false) throw new Error("workspace disappeared before acquiring the read lock");
    mkdirSync(wsDir, { recursive: true });
  }
  const nestedDepth = workspaceLockDepth.get(wsDir) ?? 0;
  if (nestedDepth > 0) {
    if (!recover) {
      assertNoUnresolvedLifecycleTransactions(cwd);
      assertNoPendingArtifactJournals(cwd);
    }
    workspaceLockDepth.set(wsDir, nestedDepth + 1);
    try { return action(); } finally { workspaceLockDepth.set(wsDir, nestedDepth); }
  }
  const lock = acquireStateLock(wsDir, opts.lockTimeoutMs ?? STATE_LOCK_DEFAULT_TIMEOUT_MS);
  if ("error" in lock) throw new Error(lock.error);
  workspaceLockDepth.set(wsDir, 1);
  try {
    if (recover) {
      recoverLifecycleTransactions(cwd);
      recoverArtifactJournals(cwd);
    } else {
      assertNoUnresolvedLifecycleTransactions(cwd);
      assertNoPendingArtifactJournals(cwd);
    }
    return action();
  } finally {
    workspaceLockDepth.delete(wsDir);
    releaseStateLock(wsDir, lock.token);
  }
}

/**
 * Shared workspace transaction seam for lifecycle control and state changes.
 * Every caller uses the same lock as updateStateAtomically; recovery runs
 * while that lock is held, so a malformed or torn lifecycle record fails
 * closed before any reader or writer can inspect authority.
 */
export function withWorkspaceTransaction<T>(
  cwd: string,
  action: () => T,
  opts: { lockTimeoutMs?: number; createIfMissing?: boolean } = {},
): T {
  return withLockedWorkspace(cwd, action, opts, true);
}

/** Read under the shared workspace lock without recovering or publishing journal state. */
export function withWorkspaceReadNoRecovery<T>(cwd: string, action: () => T, absent: () => T, opts: { lockTimeoutMs?: number } = {}): T {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  if (!existsSync(wsDir)) return absent();
  return withLockedWorkspace(cwd, action, { ...opts, createIfMissing: false }, false);
}

/** Read under the shared workspace lock when it exists, without creating a workspace for empty roots. */
export function withWorkspaceRead<T>(cwd: string, action: () => T, absent: () => T, opts: { lockTimeoutMs?: number } = {}): T {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  if (!existsSync(wsDir)) return absent();
  return withLockedWorkspace(cwd, action, { ...opts, createIfMissing: false }, true);
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
const workspaceLockDepth = new Map<string, number>();

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

function canonicalIdentityError(state: TeamState, expectedRunId: string): string | null {
  if (state.schema !== 2) return `canonical workflow state schema must be 2 for run '${expectedRunId}'`;
  if (state.run_id !== expectedRunId || state.run_key !== expectedRunId) {
    return `canonical workflow state identity does not match selected run '${expectedRunId}'`;
  }
  return null;
}

interface TransactionTargetResolution {
  prepared: PreparedStateTarget;
  target: CanonicalRunTarget;
}

function transactionTarget(
  realWorkState: string,
  wsDir: string,
  resolved: CanonicalRunTarget,
): TransactionTargetResolution {
  if (resolved.invalid) throw new Error("workflow state is invalid or unsafe");
  if (resolved.canonicalRun !== true) throw new Error("migration_required: canonical run target is required");
  if (resolved.schema !== 2 || !ORDINARY_RUN_ID_PATTERN.test(resolved.runId) || resolved.runKey !== resolved.runId) {
    throw new Error("canonical workflow target identity is invalid");
  }
  if (basename(resolve(resolved.stateDir)) !== resolved.runId) {
    throw new Error("canonical workflow target identity does not match its run directory");
  }
  const target: CanonicalRunTarget = {
    ...resolved,
    state: null,
    isLegacy: false,
    canonicalRun: true,
    schema: 2,
    runId: resolved.runId,
    runKey: resolved.runKey,
    statePath: resolved.statePath,
    stateDir: resolved.stateDir,
    artifactsDir: resolved.artifactsDir,
  };
  return { prepared: prepareExistingTarget(realWorkState, wsDir, target), target };
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
  opts: { lockTimeoutMs?: number; target: CanonicalRunTarget; branch?: string; publication?: (snapshot: StateSnapshot, nextState: TeamState, target: CanonicalRunTarget) => StatePublication | undefined },
): StateUpdateResult<T> {
  if (!opts?.target) {
    return { ok: false, code: "migration_required", error: "canonical workflow run target is required; legacy state requires explicit migration" };
  }
  if (opts.target.canonicalRun !== true) {
    return { ok: false, code: "migration_required", error: "only canonical workflow run targets may be mutated" };
  }
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  mkdirSync(wsDir, { recursive: true });
  const realWorkState = realpathSync(wsDir);
  if (!isWithin(realpathSync(cwd), realWorkState)) {
    return { ok: false, code: "state_invalid", error: "workflow state path escapes project root" };
  }
  const lock = acquireStateLock(wsDir, opts.lockTimeoutMs ?? STATE_LOCK_DEFAULT_TIMEOUT_MS);
  if ("error" in lock) return { ok: false, code: "state_lock_unavailable", error: lock.error };
  try {
    recoverLifecycleTransactions(cwd);
    recoverArtifactJournals(cwd);
  } catch (error) {
    releaseStateLock(wsDir, lock.token);
    return { ok: false, code: "recovery_required", error: (error as Error).message };
  }
  beginArtifactJournal(cwd);
  let journalFinalized = false;
  const finalizeJournal = (committed: boolean): void => {
    if (journalFinalized) return;
    const journal = endArtifactJournal();
    journalFinalized = true;
    if (committed || artifactJournalHasCommitBoundary(journal)) commitArtifactJournal(journal);
    else rollbackArtifactJournal(journal);
    stateTransactionTestHooks?.afterJournalFinalize?.({
      committed,
      lockPath: join(wsDir, STATE_LOCK_FILE),
    });
  };
  try {
    const branch = opts.branch ?? resolveActiveBranch(cwd);
    const resolution = opts.target;
    let initial: TransactionTargetResolution;
    try {
      initial = transactionTarget(realWorkState, wsDir, resolution);
    } catch (error) {
      return { ok: false, code: "state_invalid", error: (error as Error).message };
    }
    stateTransactionTestHooks?.afterTargetResolution?.({
      statePath: initial.prepared.statePath,
      stateDir: initial.prepared.stateDir,
      artifactsDir: initial.prepared.artifactsDir,
    });
    const raw = readRawStateSnapshot(initial.prepared.statePath);
    if (raw.kind === "invalid") return { ok: false, code: "state_invalid", error: raw.error };
    const expectedRunId = initial.target.runId;
    if (!ORDINARY_RUN_ID_PATTERN.test(expectedRunId)) {
      return { ok: false, code: "state_invalid", error: "canonical workflow target identity is invalid" };
    }
    if (raw.kind === "present") {
      const identityError = canonicalIdentityError(raw.state, expectedRunId);
      if (identityError) return { ok: false, code: "state_invalid", error: identityError };
    }
    const state = raw.kind === "present" ? raw.state : null;
    const revision = raw.kind === "present" ? raw.revision : 0;
    const rawHash = raw.kind === "present" ? raw.raw_hash : "";
    // The transaction state, revision and hash all come from the freshly read canonical bytes.
    const target: CanonicalRunTarget = {
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
    const mutationIdentityError = canonicalIdentityError(mutation.state, expectedRunId);
    if (mutationIdentityError) return { ok: false, code: "state_invalid", error: mutationIdentityError };

    const prepared = initial.prepared;

    stateTransactionTestHooks?.beforeCas?.({
      sourcePath: initial.prepared.statePath,
      destinationPath: prepared.statePath,
    });
    const sourceCurrent = readRawStateSnapshot(initial.prepared.statePath);
    const sourceConflict = casConflict(raw, sourceCurrent);
    if (sourceConflict) return { ok: false, code: "state_conflict", error: sourceConflict };

    let committed: CommittedState;
    try {
      const publication = mutation.publication ?? opts.publication?.(snapshot, mutation.state, target);
      committed = commitState(cwd, prepared, mutation.state, revision + 1, publication);
    } catch (error) {
      return { ok: false, code: "state_invalid", error: `workflow state commit failed: ${(error as Error).message}` };
    }
    // state.json is authoritative now. Publish buffered observability while
    // still holding the same lock; commit hooks can never request rollback.
    finalizeJournal(true);
    const committedTarget: CanonicalRunTarget = {
      ...target,
      state: committed.state,
      statePath: prepared.statePath,
      stateDir: prepared.stateDir,
      artifactsDir: prepared.artifactsDir,
      isLegacy: false,
      isStale: false,
      canonicalRun: true,
      schema: 2,
      runId: expectedRunId,
      runKey: expectedRunId,
      branch: committed.state.branch,
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
        recordStageTransition(cwd, { stageId, stageStatus: status, runId: state.run_id });
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
  const {
    required_input_receipts: _requiredInputReceipts,
    checkpoint_policy: _checkpointPolicy,
    checkpoint_policy_binding: _checkpointPolicyBinding,
    cursor_epoch: _cursorEpoch,
    dispatch_capability: _dispatchCapability,
    work_identity: _workIdentity,
    pending: _pending,
    child_join: _childJoin,
    child_joins: _childJoins,
    completion_envelope: _completionEnvelope,
    loop_state: _loopState,
    roster_selection: _rosterSelection,
    roster_selections: _rosterSelections,
    migration_succeeded_slots: _migrationSucceededSlots,
    slot_artifacts: _slotArtifacts,
    ...reopenedBase
  } = state;
  const upstreamStageIds = new Set(state.stages.slice(0, index).map((stage) => stage.id));
  const retainedSlotArtifacts = Object.fromEntries(
    Object.entries(state.slot_artifacts ?? {}).filter(([stageId]) => upstreamStageIds.has(stageId)),
  );
  const stages = state.stages.map((stage, i) =>
    i >= index ? { ...stage, status: "pending" as const } : stage,
  );
  return {
    ...reopenedBase,
    task: `${state.task}\n\nUser feedback: ${feedback}`,
    history,
    stages,
    slot_artifacts: Object.keys(retainedSlotArtifacts).length > 0 ? retainedSlotArtifacts : undefined,
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

