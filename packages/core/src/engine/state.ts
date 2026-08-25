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
 *   3. undefined (no state yet)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readObservabilityPointer } from "../observability/recorder.js";
import { recordStageTransition } from "../observability/hooks.js";
import { activeWave, readCtoState } from "../cto/state.js";
import {
  loadProfile,
  profileHash,
  resolveProfileControlPlane,
  validateProfileControlPlane,
} from "./profile.js";
import type {
  CheckpointPolicy,
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
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  const keys = [
    "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id", "stage_cursor",
    "capability_id", "capability_epoch", "slot_id", "task_id", "dispatch_id", "attempt", "worker_id",
  ] as const;
  strictStateKeys(value, keys, path, issues);
  for (const key of keys) {
    if (key === "attempt") {
      if (!Number.isInteger(value[key]) || (value[key] as number) < 1) issues.push(`${path}.attempt must be an integer >= 1`);
    } else if (!nonEmptyStateString(value[key])) {
      issues.push(`${path}.${key} must be a non-empty string`);
    }
  }
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
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, ["identity", "status", "pending_reason", "provider_ref", "lease", "terminal_signal", "retry_of", "updated_at"], path, issues);
  validateStateIdentity(value.identity, `${path}.identity`, issues);
  if (!["authorized", "running", "pending", "succeeded", "failed", "cancelled"].includes(String(value.status))) issues.push(`${path}.status has an unknown value`);
  if (value.pending_reason !== undefined && !["provider_running", "awaiting_result", "transport_reconnect"].includes(String(value.pending_reason))) issues.push(`${path}.pending_reason has an unknown value`);
  if (value.provider_ref !== undefined && !nonEmptyStateString(value.provider_ref)) issues.push(`${path}.provider_ref must be a non-empty string`);
  if (value.lease !== undefined) {
    if (!isStateRecord(value.lease)) issues.push(`${path}.lease must be an object`);
    else {
      strictStateKeys(value.lease, ["token", "observed_at", "revoked_at"], `${path}.lease`, issues);
      if (!nonEmptyStateString(value.lease.token)) issues.push(`${path}.lease.token must be a non-empty string`);
      if (!nonEmptyStateString(value.lease.observed_at)) issues.push(`${path}.lease.observed_at must be a non-empty string`);
      if (!Object.prototype.hasOwnProperty.call(value.lease, "revoked_at") || (value.lease.revoked_at !== null && !nonEmptyStateString(value.lease.revoked_at))) issues.push(`${path}.lease.revoked_at must be a non-empty string or null`);
    }
  }
  if (value.terminal_signal !== undefined && value.terminal_signal !== null && !nonEmptyStateString(value.terminal_signal)) issues.push(`${path}.terminal_signal must be a non-empty string or null`);
  if (value.retry_of !== undefined && value.retry_of !== null && !nonEmptyStateString(value.retry_of)) issues.push(`${path}.retry_of must be a non-empty string or null`);
  if (!nonEmptyStateString(value.updated_at)) issues.push(`${path}.updated_at must be a non-empty string`);
  if (value.status === "pending" && value.terminal_signal !== undefined && value.terminal_signal !== null) issues.push(`${path}.terminal_signal cannot be terminal for pending work`);
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
    const entryPath = `${path}[${index}]`;
    if (!isStateRecord(entry)) {
      issues.push(`${entryPath} must be an object`);
      return;
    }
    strictStateKeys(entry, [
      "answer_id", "nonce", "channel", "reference", "run_id", "stage_id", "checkpoint_id",
      "work_identity_hash", "capability_id", "capability_epoch", "policy_hash", "decision",
      "binding", "issued_at", "consumed_at",
    ], entryPath, issues);
    for (const key of [
      "answer_id", "nonce", "reference", "run_id", "stage_id", "checkpoint_id",
      "work_identity_hash", "capability_id", "capability_epoch", "policy_hash",
      "decision", "binding", "issued_at",
    ]) {
      if (!nonEmptyStateString(entry[key])) issues.push(`${entryPath}.${key} must be a non-empty string`);
    }
    if (!["terminal", "escalation"].includes(String(entry.channel))) issues.push(`${entryPath}.channel has an unknown value`);
    if (entry.consumed_at !== undefined && !nonEmptyStateString(entry.consumed_at)) issues.push(`${entryPath}.consumed_at must be a non-empty string`);
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

function validateTypedStateFields(state: StateRecord): string[] {
  const issues: string[] = [];
  const profileFields: StateRecord = {};
  for (const key of ["completion_intent", "checkpoint_policy", "roster_policy"]) {
    if (Object.prototype.hasOwnProperty.call(state, key)) profileFields[key] = state[key];
  }
  const profileValidation = validateProfileControlPlane(profileFields);
  if (!profileValidation.ok) issues.push(...profileValidation.issues.map((entry) => `state${entry.slice(1)}`));
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
  const typedPolicy = state.checkpoint_policy;
  const checkpoint_policy = typedPolicy
    ?? projection?.checkpoint_policy
    ?? (stage?.checkpoint ? migrationPolicy(stage.checkpoint) : undefined);
  if (checkpoint_policy) state.checkpoint_policy = checkpoint_policy;
  if (stage?.roster_policy && state.roster_policy === undefined) state.roster_policy = stage.roster_policy;

  const capability = isStateRecord(state.dispatch_capability) ? state.dispatch_capability : null;
  const capabilityIdentity = capability?.work_identity;
  if (state.work_identity === undefined && capabilityIdentity !== undefined) state.work_identity = capabilityIdentity;
  else if (state.work_identity !== undefined && capabilityIdentity !== undefined && stableStateHash(state.work_identity) !== stableStateHash(capabilityIdentity)) {
    rejectionIssues?.push("$.work_identity conflicts with dispatch_capability.work_identity");
    return null;
  }
  if (state.work_identity === undefined && stageId && nonEmptyStateString(state.run_key ?? state.branch)) state.work_identity = legacyIdentity(state, workflow, stageId, capability);
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
      to_schema: 2,
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
    checkpoint_policy: typedPolicy ? "state" : projection?.checkpoint_policy ? "profile" : stage?.checkpoint ? "migration" : "none",
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
  if (!existsSync(wsDir)) {
    return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false };
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
    if (!existsSync(featuresDir)) return { state: null, statePath: null, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false };
    try {
      const realWorkState = realpathSync(wsDir);
      const realFeatures = realpathSync(featuresDir);
      if (!isWithin(realpathSync(cwd), realWorkState) || !isWithin(realWorkState, realFeatures) || (existsSync(featureDir) && !isWithin(realFeatures, realpathSync(featureDir)))) {
        return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
      }
    } catch {
      return { state: null, statePath, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false, invalid: true };
    }
    if (!existsSync(statePath)) return { state: null, statePath: null, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false };
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
      return { state, statePath, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: currentBranch ? state.branch !== currentBranch : false };
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
      return { state, statePath: legacyPath, stateDir: wsDir, artifactsDir: artifactsPath, isLegacy: true, isStale: currentBranch ? state.branch !== currentBranch : false };
    } catch {
      return { state: null, statePath: legacyPath, stateDir: wsDir, artifactsDir: join(wsDir, "artifacts"), isLegacy: true, isStale: false, invalid: true };
    }
  }
  return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false };
}

export function writeState(
  cwd: string,
  state: TeamState,
  opts: { featureSlug?: string; target?: ResolvedState } = {},
): { statePath: string; artifactsDir: string } {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  mkdirSync(wsDir, { recursive: true });
  const realWorkState = realpathSync(wsDir);
  if (!isWithin(realpathSync(cwd), realWorkState)) throw new Error("workflow state path escapes project root");
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

  const rejectionIssues: string[] = [];
  const normalized = normalizePersistedState(state, rejectionIssues);
  if (!normalized) throw new Error(`workflow state contains malformed or conflicting typed control-plane fields: ${rejectionIssues.join("; ") || "unrecognized shape"}`);
  const stamped: TeamState = { ...normalized, updated_at: new Date().toISOString() };
  // Embed the observability pointer (best-effort: a missing event log is
  // fine for pre-observability features). The recorder file lives under
  // `<featureDir>/observability/events.jsonl`; we read it synchronously
  // here because `writeState` is itself sync and the file is bounded by
  // session length.
  const obsPointer = featureSlug ? readObservabilityPointerSafe(cwd, featureSlug) : null;
  if (obsPointer) {
    stamped.observability = obsPointer;
  } else {
    delete stamped.observability;
  }
  atomicWrite(statePath, JSON.stringify(stamped, null, 2) + "\n");
  writeStateMd(stateDir, stamped);
  if (featureSlug) atomicWrite(join(wsDir, ACTIVE_FEATURE), featureSlug + "\n");

  return { statePath, artifactsDir };
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

export function writeStateMd(stateDir: string, state: TeamState): void {
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

  atomicWrite(join(stateDir, STATE_MD), lines.join("\n"));
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
    try {
      recordStageTransition(cwd, { stageId, stageStatus: status });
    } catch {
      // best-effort telemetry — never blocks the state transition
    }
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
