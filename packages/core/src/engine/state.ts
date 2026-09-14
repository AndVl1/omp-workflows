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
import { existsSync, fsyncSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, type Stats } from "node:fs";
import { TextDecoder } from "node:util";
import { assertCurrentExecutionLiveness, ExecutionLivenessViolation, withoutCurrentExecutionLiveness } from "../execution-liveness.js";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  OBSERVABILITY_MAX_EVENT_BYTES,
  OBSERVABILITY_MAX_RECORDS,
  OBSERVABILITY_MAX_LOG_BYTES,
  OBSERVABILITY_MAX_AGGREGATE_BYTES,
  OBSERVABILITY_MAX_READ_BYTES,
  parseBoundedObservabilityEvents,
  rollupFromEvents,
  readObservabilityPointer,
} from "../observability/recorder.js";
import type { ObservabilityPointer } from "../observability/events.js";
import { recordStageTransition } from "../observability/hooks.js";
import { activeWave, ensureSecureStateDirectory, readCtoState, secureAtomicWriteFile } from "../cto/state.js";
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
import type { FeatureWorkspace } from "../specification/types.js";
import { isValidPreparationHandoffTask, type WorkflowPreparationHandoff } from "./preparation.js";
import { PinnedProjectRoot, PinnedRootError, processStartIdentity, rollbackPinnedRootWriteReceipt, type PinnedRootWritePreimage, type PinnedRootWriteReceipt } from "../specification/pinned-root.js";
import { isSafeFeatureId, normalizeFeatureWorkspaceV1, validateConstitutionBinding, validateFeatureWorkspaceRecord } from "../specification/validation.js";
import {
  loadProfile,
  profileHash,
  resolveProfileControlPlane,
  validateProfileControlPlane,
} from "./profile.js";

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
/** Maximum UTF-8 bytes accepted for canonical feature state reads and writes. */
export const MAX_PERSISTED_STATE_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE_FEATURE_BYTES = 1024;
const MAX_PERSISTED_STATE_NODES = 100_000;
const MAX_PERSISTED_STATE_DEPTH = 128;
const MAX_PERSISTED_STATE_ARRAY_LENGTH = 16_384;
const MAX_PERSISTED_STATE_OBJECT_KEYS = 1_024;
const MAX_PERSISTED_STATE_STRING_BYTES = 256 * 1024;
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
  strictStateKeys(value, ["identity", "status", "pending_reason", "provider_ref", "reconciliation", "lease", "terminal_signal", "retry_of", "updated_at"], path, issues);
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
  if (value.reconciliation !== undefined) {
    const reconciliationPath = `${path}.reconciliation`;
    if (!isStateRecord(value.reconciliation)) {
      issues.push(`${reconciliationPath} must be an object`);
    } else {
      const reconciliation = value.reconciliation;
      strictStateKeys(
        reconciliation,
        ["identity", "result_digest", "outcome", "evidence", "artifact_ids", "terminal_signal", "provider_id", "updated_at"],
        reconciliationPath,
        issues,
      );
      validateStateIdentity(reconciliation.identity, `${reconciliationPath}.identity`, issues);
      if (typeof reconciliation.result_digest !== "string" || !/^[a-f0-9]{64}$/u.test(reconciliation.result_digest)) {
        issues.push(`${reconciliationPath}.result_digest must be a lowercase SHA-256 digest`);
      }
      if (!["succeeded", "failed", "cancelled"].includes(String(reconciliation.outcome))) {
        issues.push(`${reconciliationPath}.outcome has an unknown value`);
      }
      if (typeof reconciliation.evidence !== "string"
        || !nonEmptyStateString(reconciliation.evidence)
        || Buffer.byteLength(reconciliation.evidence, "utf8") > 8192
        || /[\u0000-\u001f\u007f\r\n]/u.test(reconciliation.evidence)) {
        issues.push(`${reconciliationPath}.evidence must be bounded non-empty line-inert text`);
      }
      if (!Array.isArray(reconciliation.artifact_ids) || reconciliation.artifact_ids.length > 64) {
        issues.push(`${reconciliationPath}.artifact_ids must contain at most 64 safe identifiers`);
      } else {
        const ids = new Set<string>();
        reconciliation.artifact_ids.forEach((id: unknown, index: number) => {
          if (typeof id !== "string" || !isSafeStateSegment(id)) issues.push(`${reconciliationPath}.artifact_ids[${index}] must be a safe identifier`);
          if (typeof id === "string" && ids.has(id)) issues.push(`${reconciliationPath}.artifact_ids[${index}] is duplicated`);
          if (typeof id === "string") ids.add(id);
        });
      }
      if (!["workflow_complete", "native_tool_result", "provider_terminal", "contract_failure"].includes(String(reconciliation.terminal_signal))) {
        issues.push(`${reconciliationPath}.terminal_signal has an unknown value`);
      }
      if (reconciliation.provider_id !== undefined && (typeof reconciliation.provider_id !== "string" || !isSafeStateSegment(reconciliation.provider_id))) {
        issues.push(`${reconciliationPath}.provider_id must be a safe identifier when present`);
      }
      if (typeof reconciliation.updated_at !== "string"
        || !nonEmptyStateString(reconciliation.updated_at)
        || Buffer.byteLength(reconciliation.updated_at, "utf8") > 256
        || /[\u0000-\u001f\u007f\r\n]/u.test(reconciliation.updated_at)) {
        issues.push(`${reconciliationPath}.updated_at must be bounded line-inert text`);
      }
      if (isStateRecord(value.identity) && isStateRecord(reconciliation.identity)
        && stableStateHash(value.identity) !== stableStateHash(reconciliation.identity)) {
        issues.push(`${reconciliationPath}.identity must match ${path}.identity`);
      }
      if (value.status !== "pending") issues.push(`${reconciliationPath} is only valid while ${path}.status is pending`);
    }
  }
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
      strictStateKeys(entry, ["artifact_id", "path", "sha256", "size_bytes", "schema_status", "quality_gate_status"], entryPath, issues);
      for (const key of ["artifact_id", "path", "sha256"]) if (!nonEmptyStateString(entry[key]) || (key === "path" && (String(entry[key]).startsWith("/") || String(entry[key]).startsWith("\\") || String(entry[key]).includes("..") || String(entry[key]).includes("\\")))) issues.push(`${entryPath}.${key} must be a safe non-empty relative value`);
      if (entry.size_bytes !== undefined && (typeof entry.size_bytes !== "number" || !Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0)) issues.push(`${entryPath}.size_bytes must be a non-negative safe integer`);
      if (!["met", "failed"].includes(String(entry.schema_status))) issues.push(`${entryPath}.schema_status has an unknown value`);
      if (!["met", "pending", "failed"].includes(String(entry.quality_gate_status))) issues.push(`${entryPath}.quality_gate_status has an unknown value`);
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
      "binding", "authority_receipt", "issued_at", "consumed_at", "feature_id", "loop_iteration", "subject_binding", "subject_revision", "feedback",
    ], entryPath, issues);
    for (const key of [
      "answer_id", "nonce", "reference", "run_id", "stage_id", "checkpoint_id",
      "work_identity_hash", "capability_id", "capability_epoch", "policy_hash",
      "decision", "binding", "issued_at",
    ]) {
      if (!nonEmptyStateString(entry[key])) issues.push(`${entryPath}.${key} must be a non-empty string`);
    }
    if (!["terminal", "escalation"].includes(String(entry.channel))) issues.push(`${entryPath}.channel has an unknown value`);
    if (entry.feature_id !== undefined && !isSafeFeatureId(entry.feature_id)) issues.push(`${entryPath}.feature_id must be a canonical safe feature id`);
    if (entry.loop_iteration !== undefined && (!Number.isSafeInteger(entry.loop_iteration) || (entry.loop_iteration as number) < 1 || (entry.loop_iteration as number) > 1000000)) issues.push(`${entryPath}.loop_iteration must be a bounded positive integer`);
    if (entry.subject_binding !== undefined && (typeof entry.subject_binding !== "string" || !/^[a-f0-9]{64}$/u.test(entry.subject_binding))) issues.push(`${entryPath}.subject_binding must be a lowercase SHA-256 digest`);
    if (entry.subject_revision !== undefined && (!Number.isSafeInteger(entry.subject_revision) || (entry.subject_revision as number) < 0)) issues.push(`${entryPath}.subject_revision must be a non-negative safe integer`);
    if (entry.feedback !== undefined && (typeof entry.feedback !== "string" || entry.feedback.length === 0 || entry.feedback !== entry.feedback.trim() || Buffer.byteLength(entry.feedback, "utf8") > 8192 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.feedback))) issues.push(`${entryPath}.feedback must be bounded non-empty single-line text`);
    if (entry.authority_receipt !== undefined && !nonEmptyStateString(entry.authority_receipt)) issues.push(`${entryPath}.authority_receipt must be a non-empty string`);
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

function validatePreparationHandoff(value: unknown, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, ["schema_version", "status", "token", "digest", "feature_id", "run_key", "branch", "task", "classification", "state_revision", "state_digest", "root_identity", "source_kind", "constitution_binding", "constitution_gate_ref", "capacity", "auth_proof"], path, issues);
  if (value.schema_version !== 1) issues.push(`${path}.schema_version must be 1`);
  if (value.status !== "prepared") issues.push(`${path}.status must be prepared`);
  if (!nonEmptyStateString(value.token) || value.token.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(String(value.token))) issues.push(`${path}.token must be bounded opaque text`);
  for (const key of ["digest", "state_digest"]) if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/u.test(value[key] as string)) issues.push(`${path}.${key} must be a lowercase SHA-256 digest`);
  if (!isSafeFeatureId(value.feature_id)) issues.push(`${path}.feature_id must be a safe feature id`);
  for (const key of ["run_key", "branch"]) if (!nonEmptyStateString(value[key]) || (value[key] as string).length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(String(value[key]))) issues.push(`${path}.${key} must be bounded single-line text`);
  if (!isValidPreparationHandoffTask(value.task)) issues.push(`${path}.task must be bounded single-line text`);
  if (!Number.isSafeInteger(value.state_revision) || (value.state_revision as number) < 1) issues.push(`${path}.state_revision must be a positive safe integer`);
  const sourceKind = value.source_kind;
  if (sourceKind !== undefined && !["native", "legacy", "external"].includes(String(sourceKind))) issues.push(`${path}.source_kind must be native, legacy, or external when present`);
  if (value.constitution_binding !== undefined && value.constitution_binding !== null) issues.push(...validateConstitutionBinding(value.constitution_binding, `${path}.constitution_binding`));
  if (value.constitution_gate_ref !== undefined && value.constitution_gate_ref !== null && (!nonEmptyStateString(value.constitution_gate_ref) || (value.constitution_gate_ref as string).length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(String(value.constitution_gate_ref)))) issues.push(`${path}.constitution_gate_ref must be bounded text or null`);
  if (value.capacity !== undefined && (!Number.isSafeInteger(value.capacity) || (value.capacity as number) < 1 || (value.capacity as number) > 64)) issues.push(`${path}.capacity must be a positive safe integer no greater than 64`);
  if (value.auth_proof !== undefined && (typeof value.auth_proof !== "string" || !/^[a-f0-9]{64}$/u.test(value.auth_proof))) issues.push(`${path}.auth_proof must be a lowercase SHA-256 HMAC when present`);
  if (sourceKind !== undefined) {
    if (value.constitution_binding === undefined) issues.push(`${path}.constitution_binding must be present when source_kind is present`);
    if (value.constitution_gate_ref === undefined) issues.push(`${path}.constitution_gate_ref must be present when source_kind is present`);
    if (value.capacity === undefined) issues.push(`${path}.capacity must be present when source_kind is present`);
    if (value.auth_proof === undefined) issues.push(`${path}.auth_proof must be present when source_kind is present`);
    if (sourceKind === "native" && (value.constitution_binding === null || value.constitution_binding === undefined)) issues.push(`${path}.constitution_binding must be non-null for native preparation`);
  }
  if (!isStateRecord(value.classification)) {
    issues.push(`${path}.classification must be an object`);
  } else {
    strictStateKeys(value.classification, ["type", "complexity", "confidence", "autonomous", "autonomous_reason", "workflow"], `${path}.classification`, issues);
    if (!["FEATURE", "REFACTOR", "OPS", "BUG_FIX", "SPEC", "REGRESS", "INVESTIGATION", "LECTURE_RESEARCH", "REVIEW", "HOTFIX", "PRODUCT_DISCOVERY"].includes(String(value.classification.type))) issues.push(`${path}.classification.type is invalid`);
    if (!["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"].includes(String(value.classification.complexity))) issues.push(`${path}.classification.complexity is invalid`);
    if (!["HIGH", "MEDIUM", "LOW"].includes(String(value.classification.confidence))) issues.push(`${path}.classification.confidence is invalid`);
    if (typeof value.classification.autonomous !== "boolean") issues.push(`${path}.classification.autonomous must be boolean`);
    if (value.classification.workflow !== undefined && !nonEmptyStateString(value.classification.workflow)) issues.push(`${path}.classification.workflow must be non-empty when present`);
    if (value.classification.autonomous_reason !== undefined && !nonEmptyStateString(value.classification.autonomous_reason)) issues.push(`${path}.classification.autonomous_reason must be non-empty when present`);
  }
  if (!isStateRecord(value.root_identity)) {
    issues.push(`${path}.root_identity must be an object`);
  } else {
    strictStateKeys(value.root_identity, ["canonical_path", "dev", "ino"], `${path}.root_identity`, issues);
    if (!nonEmptyStateString(value.root_identity.canonical_path) || !isAbsolute(value.root_identity.canonical_path as string)) issues.push(`${path}.root_identity.canonical_path must be absolute`);
    for (const key of ["dev", "ino"]) if (!Number.isSafeInteger(value.root_identity[key]) || (value.root_identity[key] as number) < 0) issues.push(`${path}.root_identity.${key} must be a non-negative safe integer`);
  }
}

function validatePreparationStart(value: unknown, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, ["status", "phase", "capability_id", "capability_epoch", "request_id", "dispatch_id", "start_postimage_digest", "token", "preparation_digest", "preparation_state_revision", "expected_state_revision", "profile_hash", "policy_hash", "expected_roster", "cto_slice_marker"], path, issues);
  if (value.status !== "begun" && value.status !== "started") issues.push(`${path}.status must be begun or started`);
  if (!["specify", "plan", "tasks"].includes(String(value.phase))) issues.push(`${path}.phase has an unknown value`);
  for (const key of ["capability_id", "request_id"] as const) {
    if (!nonEmptyStateString(value[key]) || (value[key] as string).length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(String(value[key]))) {
      issues.push(`${path}.${key} must be bounded single-line text`);
    }
  }
  if (value.capability_epoch !== undefined && (!nonEmptyStateString(value.capability_epoch) || (value.capability_epoch as string).length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(String(value.capability_epoch)))) issues.push(`${path}.capability_epoch must be bounded single-line text when present`);
  if (value.status === "started" && (!nonEmptyStateString(value.dispatch_id) || (value.dispatch_id as string).length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(String(value.dispatch_id)))) {
    issues.push(`${path}.dispatch_id must be bounded single-line text for a started marker`);
  } else if (value.dispatch_id !== undefined && value.dispatch_id !== null && (!nonEmptyStateString(value.dispatch_id) || (value.dispatch_id as string).length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(String(value.dispatch_id)))) {
    issues.push(`${path}.dispatch_id must be bounded single-line text when present`);
  }
  if (value.cto_slice_marker !== undefined && (typeof value.cto_slice_marker !== "string" || value.cto_slice_marker.length > 0x400 || /[\u0000-\u001f\u007f\r\n]/u.test(value.cto_slice_marker))) issues.push(`${path}.cto_slice_marker must be bounded single-line text`);
  for (const key of ["start_postimage_digest", "preparation_digest"] as const) {
    if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/u.test(value[key] as string)) {
      issues.push(`${path}.${key} must be a lowercase SHA-256 digest`);
    }
  }
  if (value.profile_hash !== undefined && (typeof value.profile_hash !== "string" || !/^[a-f0-9]{64}$/u.test(value.profile_hash))) issues.push(`${path}.profile_hash must be a lowercase SHA-256 digest when present`);
  if (value.policy_hash !== undefined && (typeof value.policy_hash !== "string" || !/^[a-f0-9]{64}$/u.test(value.policy_hash))) issues.push(`${path}.policy_hash must be a lowercase SHA-256 digest when present`);
  if (value.status === "begun") {
    if (!nonEmptyStateString(value.capability_epoch)) issues.push(`${path}.capability_epoch must be present on a begun marker`);
    if (!Number.isSafeInteger(value.preparation_state_revision) || (value.preparation_state_revision as number) < 1) issues.push(`${path}.preparation_state_revision must be present on a begun marker`);
    if (!Number.isSafeInteger(value.expected_state_revision) || (value.expected_state_revision as number) < 1) issues.push(`${path}.expected_state_revision must be present on a begun marker`);
    if (typeof value.profile_hash !== "string" || !/^[a-f0-9]{64}$/u.test(value.profile_hash)) issues.push(`${path}.profile_hash must be present on a begun marker`);
    if (!Array.isArray(value.expected_roster)) issues.push(`${path}.expected_roster must be present on a begun marker`);
  }
  if (value.expected_roster !== undefined && (!Array.isArray(value.expected_roster) || value.expected_roster.length > 64)) issues.push(`${path}.expected_roster must be a bounded array`);
  if (!nonEmptyStateString(value.token) || value.token.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(String(value.token))) {
    issues.push(`${path}.token must be bounded opaque text`);
  }
}

function validateAdaptivePreparation(value: unknown, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, ["depth", "rationale_codes", "feature_id", "run_key", "request_digest"], path, issues);
  if (!["quick", "bounded_specify", "full_specification"].includes(String(value.depth))) issues.push(`${path}.depth has an unknown value`);
  const rationaleCodes = value.rationale_codes;
  if (!Array.isArray(rationaleCodes)) {
    issues.push(`${path}.rationale_codes must be an array`);
  } else {
    if (rationaleCodes.length > 64) issues.push(`${path}.rationale_codes must contain at most 64 entries`);
    rationaleCodes.forEach((entry, index) => {
      if (!nonEmptyStateString(entry) || entry.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(entry)) issues.push(`${path}.rationale_codes[${index}] must be a bounded non-empty single-line string`);
      if (index > 0 && typeof rationaleCodes[index - 1] === "string" && typeof entry === "string" && rationaleCodes[index - 1]!.localeCompare(entry) > 0) {
        issues.push(`${path}.rationale_codes must be sorted in canonical order`);
      }
    });
  }
  if (!isSafeFeatureId(String(value.feature_id ?? ""))) issues.push(`${path}.feature_id must be a safe feature id`);
  if (!nonEmptyStateString(value.run_key) || value.run_key.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(String(value.run_key))) issues.push(`${path}.run_key must be a bounded non-empty single-line string`);
  if (typeof value.request_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.request_digest)) issues.push(`${path}.request_digest must be a lowercase sha256 digest`);
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
  if (Object.prototype.hasOwnProperty.call(state, "adaptive_preparation")) validateAdaptivePreparation(state.adaptive_preparation, "$.adaptive_preparation", issues);
  if (Object.prototype.hasOwnProperty.call(state, "preparation_handoff")) validatePreparationHandoff(state.preparation_handoff, "$.preparation_handoff", issues);
  if (Object.prototype.hasOwnProperty.call(state, "preparation_start")) validatePreparationStart(state.preparation_start, "$.preparation_start", issues);
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
  if (Object.prototype.hasOwnProperty.call(state, "specification")) {
    const aggregate = validateFeatureWorkspaceRecord(state.specification);
    if (!aggregate.ok) issues.push(...aggregate.issues.map((issue) => `$.specification${issue.slice(1)}`));
  }
  return issues;
}

/**
 * Validate the intentionally minimal state written before workflow
 * preparation. A specification workspace is not a TeamState yet: it has no
 * branch, classification, cursor, or stages to render. Import intake may add
 * only the existing nonterminal `needs_human` pause; it never grants a
 * checkpoint, capability, or handoff on this envelope.
 */
function validateMinimalSpecificationEnvelope(state: StateRecord): string[] {
  const issues: string[] = [];
  strictStateKeys(state, ["schema", "run_key", "specification", "adaptive_preparation", "pause", "state_revision"], "$", issues);
  if (state.schema !== 1) issues.push("$.schema must be 1");
  if (!nonEmptyStateString(state.run_key)) issues.push("$.run_key must be a non-empty string");
  if (state.pause !== undefined) {
    if (!isStateRecord(state.pause)) {
      issues.push("$.pause must be an object");
    } else {
      strictStateKeys(state.pause, ["kind", "reason"], "$.pause", issues);
      if (!["none", "needs_human"].includes(String(state.pause.kind))) {
        issues.push("$.pause.kind must be none or needs_human in a minimal specification envelope");
      }
      if (typeof state.pause.reason !== "string" || state.pause.reason.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(state.pause.reason)) {
        issues.push("$.pause.reason must be bounded single-line text");
      } else if (state.pause.kind === "needs_human" && state.pause.reason.trim().length === 0) {
        issues.push("$.pause.reason must be non-blank when pause.kind is needs_human");
      }
    }
  }
  if (state.state_revision !== undefined && (!Number.isInteger(state.state_revision) || (state.state_revision as number) < 0)) {
    issues.push("$.state_revision must be an integer >= 0");
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
    acceptance: "quality_gates_and_artifacts",
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

/**
 * Deterministic migration input for the completion-contract cutover. The
 * legacy names below are accepted ONLY here — once, while persisted state is
 * loaded and before canonical typed validation — and map to
 * `quality_gates_and_artifacts` / `quality_gate_status`. No validator,
 * producer, export, or other reader accepts or emits the legacy names;
 * consumed inputs are returned so the migration receipt and control-plane
 * provenance record exactly what was migrated.
 */
const LEGACY_COMPLETION_ACCEPTANCE = "dod_and_artifacts";
const CANONICAL_COMPLETION_ACCEPTANCE = "quality_gates_and_artifacts";
const LEGACY_GATE_STATUS_FIELD = "dod_status";
const CANONICAL_GATE_STATUS_FIELD = "quality_gate_status";

function migrateLegacyCompletionIntent(intent: StateRecord, legacyInputs: string[]): void {
  if (intent.acceptance === LEGACY_COMPLETION_ACCEPTANCE) {
    intent.acceptance = CANONICAL_COMPLETION_ACCEPTANCE;
    legacyInputs.push("completion_intent.acceptance=dod_and_artifacts");
  }
}

function migrateLegacyCompletionEnvelope(envelope: StateRecord, path: string, legacyInputs: string[]): void {
  if (!Array.isArray(envelope.artifact_refs)) return;
  envelope.artifact_refs.forEach((entry, index) => {
    if (!isStateRecord(entry) || entry[LEGACY_GATE_STATUS_FIELD] === undefined) return;
    if (entry[CANONICAL_GATE_STATUS_FIELD] === undefined) {
      entry[CANONICAL_GATE_STATUS_FIELD] = entry[LEGACY_GATE_STATUS_FIELD];
    }
    legacyInputs.push(`${path}.artifact_refs[${index}].dod_status`);
    delete entry[LEGACY_GATE_STATUS_FIELD];
  });
}

/** Map legacy completion vocabulary once, before canonical validation. */
function migrateLegacyCompletionVocabulary(state: StateRecord, classification: StateRecord | null): string[] {
  const legacyInputs: string[] = [];
  if (classification && isStateRecord(classification.completion_intent)) {
    const before = legacyInputs.length;
    migrateLegacyCompletionIntent(classification.completion_intent, legacyInputs);
    if (legacyInputs.length > before) state.classification = classification;
  }
  if (isStateRecord(state.completion_intent)) migrateLegacyCompletionIntent(state.completion_intent, legacyInputs);
  if (isStateRecord(state.completion_envelope)) migrateLegacyCompletionEnvelope(state.completion_envelope, "$.completion_envelope", legacyInputs);
  const capability = isStateRecord(state.dispatch_capability) ? state.dispatch_capability : null;
  if (capability && Array.isArray(capability.dispatches)) {
    capability.dispatches.forEach((record, index) => {
      if (isStateRecord(record) && isStateRecord(record.completion_envelope)) {
        migrateLegacyCompletionEnvelope(record.completion_envelope, `$.dispatch_capability.dispatches[${index}].completion_envelope`, legacyInputs);
      }
    });
  }
  return legacyInputs;
}

function completionVocabularyMigrationReceipt(state: StateRecord, legacyInputs: string[]): MigrationReceipt {
  const unresolvedProfile = "unresolved-profile";
  return {
    id: "migration-" + stableStateHash({ state, legacy_inputs: legacyInputs }).slice(0, 24),
    from_schema: 1,
    to_schema: 2,
    source_profile_hash: unresolvedProfile,
    target_profile_hash: unresolvedProfile,
    source_policy_hash: null,
    target_policy_hash: stableStateHash({ default: "required_human", scope: "decision", rules: {} }),
    legacy_inputs: [...new Set(legacyInputs)],
    warnings: ["legacy completion vocabulary migrated to the quality_gates_and_artifacts/quality_gate_status names"],
    status: "complete",
    migrated_at: new Date().toISOString(),
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

type PersistedProjectRootIdentity = { canonical_path: string; dev: number; ino: number };

export function normalizePersistedState(
  raw: unknown,
  rejectionIssues?: string[],
  rootIdentity?: PersistedProjectRootIdentity,
): TeamState | null {
  if (!isStateRecord(raw)) return null;
  const state: StateRecord = { ...raw };
  const workspaceIdentityInputs: string[] = [];
  const suppliedRootIdentity = rootIdentity;
  if (isStateRecord(state.specification) && state.specification.schema_version === 1) {
    if (!suppliedRootIdentity) {
      rejectionIssues?.push("$.specification.project_root_identity cannot be bound without the current pinned project root");
      return null;
    }
    const migrated = normalizeFeatureWorkspaceV1(state.specification, suppliedRootIdentity);
    if (!migrated) return null;
    workspaceIdentityInputs.push("$.specification.schema_version=1", "$.specification.project_root_identity");
    if (migrated.status === "stale") workspaceIdentityInputs.push("$.specification.pre_identity_authority_staled");
    state.specification = migrated;
  }
  const rawClassification = state.classification;
  const classification = isStateRecord(rawClassification) ? { ...rawClassification } : null;
  if (Object.prototype.hasOwnProperty.call(state, "specification") && !classification) {
    const envelopeIssues = validateMinimalSpecificationEnvelope(state);
    if (envelopeIssues.length > 0) {
      rejectionIssues?.push(...envelopeIssues);
      return null;
    }
  }
  const legacyWorkflow = nonEmptyStateString(state.workflow) ? state.workflow : null;
  if (classification && !nonEmptyStateString(classification.workflow) && legacyWorkflow) {
    classification.workflow = legacyWorkflow;
    state.classification = classification;
  }
  const legacyCompletionInputs = migrateLegacyCompletionVocabulary(state, classification);
  legacyCompletionInputs.push(...workspaceIdentityInputs);
  if (
    legacyCompletionInputs.length > 0
    && state.migration === undefined
    && (!classification || !nonEmptyStateString(classification.workflow))
  ) {
    state.migration = completionVocabularyMigrationReceipt(state, legacyCompletionInputs);
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
  const legacyInputs: string[] = [...legacyCompletionInputs];
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
        legacyCompletionInputs.length > 0 ? "legacy completion vocabulary migrated to the quality_gates_and_artifacts/quality_gate_status names" : null,
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
  /** SHA-256 of the exact bounded bytes used to parse `state`. */
  raw_hash?: string;
  isLegacy: boolean;
  isStale: boolean;
  invalid?: boolean;
}

export type StateSelector = { kind?: "auto" | "team" | "cto-slice"; runId?: string; sliceId?: string; capabilityId?: string };
export type FeatureStateSelector = { feature_id: string; run_key: string };
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

function specificationIdentityMatchesSelection(cwd: string, selector: FeatureStateSelector, state: TeamState, pinnedRoot?: PinnedProjectRoot): boolean {
  const aggregate = state.specification;
  if (!aggregate) return true;
  const expectedWorkspacePath = `specs/${selector.feature_id}`;
  const expectedStatePath = `.work-state/features/${selector.feature_id}/state.json`;
  if (
    aggregate.feature_id !== selector.feature_id
    || aggregate.workspace_path !== expectedWorkspacePath
    || aggregate.state_path !== expectedStatePath
  ) return false;
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) return false;
    let aggregateRoot: string;
    let aggregateRootStat: Stats;
    try {
      // A persisted workspace may retain the lexical Darwin alias (/var),
      // so authorize its resolved spelling only after checking the live
      // directory identity against the descriptor-held root. This prevents
      // an ABA replacement at the same pathname from being accepted.
      aggregateRoot = realpathSync(resolve(aggregate.project_root));
      aggregateRootStat = lstatSync(aggregateRoot);
    } catch {
      return false;
    }
    if (aggregateRoot !== pinnedRoot.canonical_root
      || aggregateRootStat.isSymbolicLink()
      || !aggregateRootStat.isDirectory()
      || aggregateRootStat.dev !== pinnedRoot.dev
      || aggregateRootStat.ino !== pinnedRoot.ino) return false;
    try {
      const [workspaceExists, stateExists] = pinnedRoot.pathEntriesExist([expectedWorkspacePath, expectedStatePath]);
      return workspaceExists === true && stateExists === true && pinnedRoot.isStable();
    } catch {
      return false;
    }
  }
  try {
    const projectRoot = realpathSync(cwd);
    if (realpathSync(resolve(aggregate.project_root)) !== projectRoot) return false;
    const workspacePath = resolve(projectRoot, aggregate.workspace_path);
    const statePath = resolve(projectRoot, aggregate.state_path);
    if (
      workspacePath !== resolve(projectRoot, expectedWorkspacePath)
      || statePath !== resolve(projectRoot, expectedStatePath)
      || !existsSync(workspacePath)
      || !isWithinTree(projectRoot, realpathSync(workspacePath))
      || !existsSync(statePath)
      || !isWithinTree(projectRoot, realpathSync(statePath))
    ) return false;
  } catch {
    return false;
  }
  return true;
}

function isBareSpecificationEnvelope(value: StateRecord): boolean {
  return validateMinimalSpecificationEnvelope(value).length === 0
    && isStateRecord(value.specification);
}

function resolveExplicitFeatureState(
  cwd: string,
  wsDir: string,
  selector: FeatureStateSelector,
  currentBranch?: string,
  allowBareSpecificationEnvelope = false,
): ResolvedState {
  const invalid = (statePath: string | null = null, stateDir: string | null = null, artifactsDir: string | null = null): ResolvedState => ({ state: null, statePath, stateDir, artifactsDir, isLegacy: false, isStale: false, invalid: true });
  if (!isSafeFeatureId(selector.feature_id) || !nonEmptyStateString(selector.run_key)) return invalid();
  const featuresDir = join(wsDir, "features");
  const featureDir = join(featuresDir, selector.feature_id);
  const statePath = join(featureDir, "state.json");
  const artifactsDir = join(featureDir, "artifacts");
  if (!existsSync(featuresDir)) return { state: null, statePath, stateDir: featureDir, artifactsDir, isLegacy: false, isStale: false };
  try {
    const realWorkState = realpathSync(wsDir);
    const realFeatures = realpathSync(featuresDir);
    if (!isWithin(realpathSync(cwd), realWorkState) || !isWithin(realWorkState, realFeatures)) return invalid(statePath, featureDir, artifactsDir);
    if (existsSync(featureDir) && !isWithin(realFeatures, realpathSync(featureDir))) return invalid(statePath, featureDir, artifactsDir);
  } catch {
    return invalid(statePath, featureDir, artifactsDir);
  }
  if (!existsSync(statePath)) return { state: null, statePath, stateDir: featureDir, artifactsDir, isLegacy: false, isStale: false };
  try {
    const realFeature = realpathSync(featureDir);
    if (!isWithin(realFeature, realpathSync(statePath))) return invalid(statePath, featureDir, artifactsDir);
    if (existsSync(artifactsDir) && !isWithin(realFeature, realpathSync(artifactsDir))) return invalid(statePath, featureDir, artifactsDir);
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    if (!isStateRecord(parsed) || parsed.run_key !== selector.run_key) return invalid(statePath, featureDir, artifactsDir);
    let state: TeamState | null;
    if (allowBareSpecificationEnvelope) {
      if (!isBareSpecificationEnvelope(parsed)) return invalid(statePath, featureDir, artifactsDir);
      const issues = validateTypedStateFields(parsed);
      if (issues.length > 0) return invalid(statePath, featureDir, artifactsDir);
      state = parsed as unknown as TeamState;
    } else {
      state = normalizePersistedState(parsed);
      if (!state) return invalid(statePath, featureDir, artifactsDir);
    }
    if (state.run_key !== undefined && state.run_key !== selector.run_key) return invalid(statePath, featureDir, artifactsDir);
    if (!specificationIdentityMatchesSelection(cwd, selector, state)) return invalid(statePath, featureDir, artifactsDir);
    const bareSpecification = isBareSpecificationEnvelope(state as unknown as StateRecord);
    return { state, statePath, stateDir: featureDir, artifactsDir, isLegacy: false, isStale: false };
  } catch {
    return invalid(statePath, featureDir, artifactsDir);
  }
}

/**
 * Resolve the exact explicit target used while transforming a bare
 * specification envelope into a durable TeamState. This preparation-only
 * path never consults .active-feature and accepts only the minimal, validated
 * { schema, run_key, specification } envelope shape plus state_revision, the
 * monotonic transaction metadata written by updateStateAtomically.
 */
export function resolvePreparationState(cwd: string, currentBranch: string | undefined, selector: FeatureStateSelector): ResolvedState {
  const invalid: ResolvedState = { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return invalid;
  try {
    if (!pinnedRoot.isStable()) return invalid;
    const branch = currentBranch;
    const resolved = pinnedResolvedState(cwd, pinnedRoot, branch, selector);
    const bareCandidate = resolved.state?.specification !== undefined && resolved.state.classification === undefined;
    if (!resolved.invalid && !bareCandidate) return pinnedRoot.isStable() ? resolved : invalid;
    const prepared = pinnedResolvedState(cwd, pinnedRoot, branch, selector, true);
    return pinnedRoot.isStable() ? prepared : invalid;
  } catch {
    return invalid;
  } finally {
    pinnedRoot.close();
  }
}

export function resolveState(cwd: string, currentBranch?: string, selector?: FeatureStateSelector): ResolvedState {
  const invalid: ResolvedState = { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return invalid;
  try {
    if (!pinnedRoot.isStable()) return invalid;
    const resolved = pinnedResolvedState(cwd, pinnedRoot, currentBranch, selector);
    return pinnedRoot.isStable() ? resolved : invalid;
  } catch {
    return invalid;
  } finally {
    pinnedRoot.close();
  }
}

// ---------------------------------------------------------------------------
// Cross-process state transaction: lock + authoritative re-read + CAS.
//
// Durable callers must not resolve a state, yield to another process, and
// then persist that stale object.  This seam resolves the selected target only
// after acquiring the workspace lock, reads the exact state bytes backing that
// target, and verifies the same revision/hash immediately before commit.
// ---------------------------------------------------------------------------
const STATE_LOCK_FILE = ".state.lock";
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_MAX_RETRY_MS = 250;
// A secure constitution decision can publish a bounded state, evidence, draft,
// and projection set. Each descriptor helper startup is one durable operation;
// this budget covers the largest current transaction with generous scheduling
// headroom (the measured Darwin helper startup is substantially lower).
const STATE_LOCK_MAX_DURABLE_OPERATIONS = 64;
const STATE_LOCK_OPERATION_BUDGET_MS = 500;
const STATE_LOCK_DEFAULT_TIMEOUT_MS = STATE_LOCK_MAX_DURABLE_OPERATIONS * STATE_LOCK_OPERATION_BUDGET_MS;
const STATE_LOCK_MAX_TIMEOUT_MS = STATE_LOCK_DEFAULT_TIMEOUT_MS * 4;
const STATE_LOCK_TIMEOUT_ENV = "OMP_STATE_LOCK_TIMEOUT_MS";
// New locks publish a fully populated owner record through one hard-link CAS.
// This grace period is only for ownerless directory locks left by pre-CAS
// processes; current writers never expose an ownerless lock while active.
const STATE_LOCK_OWNERLESS_GRACE_MS = 50;

export type StateTxErrorCode = "state_invalid" | "state_missing" | "state_conflict" | "state_lock_unavailable";

export interface StateSnapshot {
  state: TeamState | null;
  target: ResolvedState;
  revision: number;
  raw_hash: string;
}

export type StateMutationCode = StateTxErrorCode | (string & {});
export type StateMutation<T> =
  | { op: "commit"; state: TeamState; value?: T }
  | { op: "discard"; value?: T }
  | { op: "fail"; code: StateMutationCode; error: string };
export type StateMutationReceipt = PinnedRootWriteReceipt;

/** Roll back state authority/projections in reverse publication order. */
export function rollbackStateMutationReceipts(
  pinnedRoot: PinnedProjectRoot,
  receipts: readonly StateMutationReceipt[],
): boolean {
  let ok = true;
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    ok = rollbackPinnedRootWriteReceipt(pinnedRoot, receipts[index]!) && ok;
  }
  return ok;
}

export type StateUpdateResult<T> =
  | { ok: true; state: TeamState | null; target: ResolvedState; revision: number; raw_hash: string; committed: boolean; value?: T; receipts?: readonly StateMutationReceipt[] }
  | { ok: false; code: StateMutationCode; error: string };

interface StateLockOwner { pid: number; token: string; acquired_at: string; start_identity?: string }
interface StateLockObservation {
  owner: StateLockOwner | null;
  expected: { dev: number; ino: number; sha256: string } | null;
  kind: "file" | "directory" | "symlink" | "other" | null;
  dev: number | null;
  ino: number | null;
  mtimeMs: number | null;
}

function sleepStateLock(ms: number): void {
  try {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, ms);
    return;
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* bounded fallback for worker contexts */ }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

interface RawStateSnapshot {
  kind: "present";
  state: TeamState;
  revision: number;
  raw_hash: string;
}
type RawStateRead = RawStateSnapshot | { kind: "absent" } | { kind: "invalid"; error: string };

function hashRawState(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function persistedStateShapeError(value: unknown): string | null {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_PERSISTED_STATE_NODES) return `workflow state exceeds the ${MAX_PERSISTED_STATE_NODES}-node structural limit`;
    if (current.depth > MAX_PERSISTED_STATE_DEPTH) return `workflow state exceeds the ${MAX_PERSISTED_STATE_DEPTH}-level structural limit`;
    if (typeof current.value === "string") {
      if (Buffer.byteLength(current.value, "utf8") > MAX_PERSISTED_STATE_STRING_BYTES) return `workflow state contains text exceeding the ${MAX_PERSISTED_STATE_STRING_BYTES}-byte limit`;
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_PERSISTED_STATE_ARRAY_LENGTH) return `workflow state array exceeds the ${MAX_PERSISTED_STATE_ARRAY_LENGTH}-entry limit`;
      for (const entry of current.value) pending.push({ value: entry, depth: current.depth + 1 });
      continue;
    }
    if (current.value && typeof current.value === "object") {
      if (Object.getPrototypeOf(current.value) !== Object.prototype && Object.getPrototypeOf(current.value) !== null && !Array.isArray(current.value)) {
        return "workflow state contains an unsafe object prototype";
      }
      const entries = Object.entries(current.value as StateRecord);
      if (entries.length > MAX_PERSISTED_STATE_OBJECT_KEYS) return `workflow state object exceeds the ${MAX_PERSISTED_STATE_OBJECT_KEYS}-field limit`;
      for (const [key, entry] of entries) {
        if (Buffer.byteLength(key, "utf8") > MAX_PERSISTED_STATE_STRING_BYTES) return "workflow state contains an oversized field name";
        pending.push({ value: entry, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

/** Parse one bounded JSON-derived workflow state before any normalization. */
export function parseBoundedPersistedState(value: unknown): StateRecord | null {
  if (persistedStateShapeError(value) !== null || !value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as StateRecord;
}

function readRawStateSnapshot(statePath: string | null): RawStateRead {
  if (!statePath) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", error: `workflow state is unreadable: ${String(error)}` };
  }
  try {
    const parsed = JSON.parse(raw) as { state_revision?: unknown };
    const issues: string[] = [];
    const state = normalizePersistedState(parsed, issues);
    if (!state) return { kind: "invalid", error: `workflow state is malformed: ${issues.join("; ") || "unrecognized shape"}` };
    const revision = Number.isInteger(parsed.state_revision) && (parsed.state_revision as number) >= 0 ? parsed.state_revision as number : 0;
    return { kind: "present", state, revision, raw_hash: hashRawState(raw) };
  } catch (error) {
    return { kind: "invalid", error: `workflow state is malformed: ${String(error)}` };
  }
}

function rawStateConflict(observed: RawStateRead, current: RawStateRead): string | null {
  if (current.kind === "invalid") return current.error;
  if (observed.kind !== current.kind) return observed.kind === "present" ? "workflow state was deleted during the transaction" : "workflow state was created during the transaction";
  if (observed.kind === "present" && current.kind === "present" && (observed.revision !== current.revision || observed.raw_hash !== current.raw_hash)) {
    return `workflow state moved during the transaction (snapshot revision ${observed.revision}, found ${current.revision})`;
  }
  return null;
}

export interface StateTransactionTestHooks {
  afterTargetResolution?: (paths: { statePath: string; stateDir: string; artifactsDir: string }) => void;
  beforeCas?: (paths: { sourcePath: string; destinationPath: string }) => void;
}

/** Minimal identity guard for transactions rooted in a pinned filesystem descriptor. */
export interface StateRootGuard {
  isStable(): boolean;
}
type StateHookRecord = { hook: StateTransactionTestHooks; aliases: string[] };
const stateTransactionTestHooksByRoot = new Map<string, StateHookRecord>();
function stateHookScopeKeys(projectRoot: string): string[] {
  const lexical = resolve(projectRoot);
  try {
    const canonical = resolve(realpathSync(projectRoot));
    return canonical === lexical ? [lexical] : [lexical, canonical];
  } catch {
    return [lexical];
  }
}
function stateHookIdentity(projectRoot: string): string | undefined {
  try {
    const stat = lstatSync(realpathSync(projectRoot));
    return "identity:" + String(stat.dev) + ":" + String(stat.ino);
  } catch {
    return undefined;
  }
}
function findStateHook(projectRoot: string, pinnedRoot?: PinnedProjectRoot): StateTransactionTestHooks | undefined {
  const aliases = pinnedRoot
    ? ["identity:" + String(pinnedRoot.dev) + ":" + String(pinnedRoot.ino), ...stateHookScopeKeys(projectRoot)]
    : stateHookScopeKeys(projectRoot);
  for (const alias of aliases) {
    const record = stateTransactionTestHooksByRoot.get(alias);
    if (record) return record.hook;
  }
  return undefined;
}
function setStateHook(hook: StateTransactionTestHooks | null, projectRoot: string): void {
  const aliases = [...stateHookScopeKeys(projectRoot)];
  const identity = stateHookIdentity(projectRoot);
  if (identity && !aliases.includes(identity)) aliases.push(identity);
  const previous = new Set<StateHookRecord>();
  for (const alias of aliases) {
    const record = stateTransactionTestHooksByRoot.get(alias);
    if (record) previous.add(record);
  }
  for (const record of previous) for (const alias of record.aliases) {
    if (stateTransactionTestHooksByRoot.get(alias) === record) stateTransactionTestHooksByRoot.delete(alias);
  }
  if (!hook) return;
  const record: StateHookRecord = { hook, aliases };
  for (const alias of aliases) stateTransactionTestHooksByRoot.set(alias, record);
}
/** Internal deterministic race seam; intentionally not exported by package index. */
export function setStateTransactionTestHooks(hooks: StateTransactionTestHooks | null, projectRoot: string): void {
  setStateHook(hooks, projectRoot);
}

function targetForTransaction(cwd: string, branch: string, selector: FeatureStateSelector | undefined, resolved: ResolvedState, featureSlug?: string): ResolvedState {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  const forcedSlug = selector?.feature_id ?? featureSlug;
  // An explicit selector or feature slug is an authoritative destination, not
  // a hint for resolving the active pointer. This is essential when a stale
  // pointer names a foreign branch: preparation must snapshot the current
  // branch destination under the lock rather than adopt that foreign state.
  if (forcedSlug !== undefined) {
    if (!isSafeStateSegment(forcedSlug)) return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
    const stateDir = join(wsDir, "features", forcedSlug);
    return { state: null, statePath: join(stateDir, "state.json"), stateDir, artifactsDir: join(stateDir, "artifacts"), isLegacy: false, isStale: false };
  }
  if (resolved.statePath && resolved.stateDir && resolved.artifactsDir) return { ...resolved, state: null };
  return { state: null, statePath: join(wsDir, LEGACY_STATE), stateDir: wsDir, artifactsDir: join(wsDir, "artifacts"), isLegacy: true, isStale: false };
}

function pinnedAbsolutePath(cwd: string, relativePath: string, pinnedRoot?: PinnedProjectRoot): string {
  return resolve(pinnedRoot?.canonical_root ?? cwd, relativePath);
}

function canonicalPinnedTarget(pinnedRoot: PinnedProjectRoot, target: ResolvedState): ResolvedState {
  const canonicalize = (path: string | null): string | null => {
    if (!path) return null;
    const relativePath = pinnedRoot.relativePath(path);
    return relativePath ? resolve(pinnedRoot.canonical_root, relativePath) : path;
  };
  return { ...target, statePath: canonicalize(target.statePath), stateDir: canonicalize(target.stateDir), artifactsDir: canonicalize(target.artifactsDir) };
}

function pinnedRelativePath(pinnedRoot: PinnedProjectRoot, absolutePath: string): string {
  const relativePath = pinnedRoot.relativePath(absolutePath);
  if (!relativePath) throw new PinnedRootError("path_unauthorized", "workflow state path escapes the pinned project root");
  return relativePath;
}

function readRawStateSnapshotPinned(
  pinnedRoot: PinnedProjectRoot,
  statePath: string | null,
  allowBareSpecificationEnvelope = false,
): RawStateRead {
  if (!statePath) return { kind: "absent" };
  let raw: string;
  try {
    const read = pinnedRoot.readFile(pinnedRelativePath(pinnedRoot, statePath), { maxBytes: MAX_PERSISTED_STATE_BYTES });
    raw = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return { kind: "absent" };
    return { kind: "invalid", error: `workflow state is unreadable: ${String(error)}` };
  }
  try {
    const parsed = JSON.parse(raw) as { state_revision?: unknown };
    const shapeError = persistedStateShapeError(parsed);
    if (shapeError) return { kind: "invalid", error: shapeError };
    const issues: string[] = [];
    let state = normalizePersistedState(parsed, issues, { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino });
    if (!state && allowBareSpecificationEnvelope && isBareSpecificationEnvelope(parsed)) {
      const bareIssues = validateTypedStateFields(parsed);
      if (bareIssues.length === 0) state = parsed as unknown as TeamState;
    }
    if (!state) return { kind: "invalid", error: `workflow state is malformed: ${issues.join("; ") || "unrecognized shape"}` };
    const revision = Number.isInteger(parsed.state_revision) && (parsed.state_revision as number) >= 0 ? parsed.state_revision as number : 0;
    return { kind: "present", state, revision, raw_hash: hashRawState(raw) };
  } catch (error) {
    return { kind: "invalid", error: `workflow state is malformed: ${String(error)}` };
  }
}

function readPinnedText(pinnedRoot: PinnedProjectRoot, relativePath: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      pinnedRoot.readFile(relativePath, { maxBytes: MAX_ACTIVE_FEATURE_BYTES }).bytes,
    );
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return null;
    throw error;
  }
}

function pinnedResolvedState(
  cwd: string,
  pinnedRoot: PinnedProjectRoot,
  branch: string | undefined,
  selector: FeatureStateSelector | undefined,
  allowBareSpecificationEnvelope = false,
): ResolvedState {
  const stateFor = (relativeStatePath: string, stateDirRelative: string, artifactsRelative: string, isLegacy: boolean): ResolvedState => {
    const statePath = pinnedAbsolutePath(cwd, relativeStatePath, pinnedRoot);
    const stateDir = pinnedAbsolutePath(cwd, stateDirRelative, pinnedRoot);
    const artifactsDir = pinnedAbsolutePath(cwd, artifactsRelative, pinnedRoot);
    const raw = readRawStateSnapshotPinned(pinnedRoot, statePath, allowBareSpecificationEnvelope);
    if (raw.kind === "absent") return { state: null, statePath, stateDir, artifactsDir, isLegacy, isStale: false };
    if (raw.kind === "invalid") return { state: null, statePath, stateDir, artifactsDir, isLegacy, isStale: false, invalid: true };
    // The state file may be valid while its artifact tree is redirected by a
    // symlink. Treat that as an invalid authoritative state rather than
    // exposing an apparently usable path that can escape the pinned root.
    const artifactsInfo = pinnedRoot.pathEntryInfo(artifactsRelative);
    if (artifactsInfo !== null && artifactsInfo.kind !== "directory") {
      return { state: null, statePath, stateDir, artifactsDir, isLegacy, isStale: false, invalid: true };
    }
    return {
      state: raw.state,
      statePath,
      stateDir,
      artifactsDir,
      raw_hash: raw.raw_hash,
      isLegacy,
      isStale: branch !== undefined && typeof raw.state.branch === "string" ? raw.state.branch !== branch : false,
    };
  };
  if (selector) {
    if (!isSafeFeatureId(selector.feature_id) || !nonEmptyStateString(selector.run_key)) {
      return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
    }
    const relativeStatePath = join(WORK_STATE_DIR, "features", selector.feature_id, "state.json");
    const candidate = stateFor(
      relativeStatePath,
      join(WORK_STATE_DIR, "features", selector.feature_id),
      join(WORK_STATE_DIR, "features", selector.feature_id, "artifacts"),
      false,
    );
    if (!candidate.state) return candidate;
    if (candidate.state.run_key !== selector.run_key || !specificationIdentityMatchesSelection(cwd, selector, candidate.state, pinnedRoot)) {
      return { ...candidate, state: null, invalid: true };
    }
    return { ...candidate, isStale: false };
  }
  const active = readPinnedText(pinnedRoot, join(WORK_STATE_DIR, ACTIVE_FEATURE));
  if (active !== null) {
    const slug = active.trim();
    if (!isSafeStateSegment(slug)) return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
    return stateFor(
      join(WORK_STATE_DIR, "features", slug, "state.json"),
      join(WORK_STATE_DIR, "features", slug),
      join(WORK_STATE_DIR, "features", slug, "artifacts"),
      false,
    );
  }
  return stateFor(join(WORK_STATE_DIR, LEGACY_STATE), WORK_STATE_DIR, join(WORK_STATE_DIR, "artifacts"), true);
}
/** Resolve the active or legacy state while borrowing one caller-owned pin. */
export function resolveActiveStatePinned(
  cwd: string,
  pinnedRoot: PinnedProjectRoot,
  currentBranch?: string,
): ResolvedState {
  const invalid: ResolvedState = { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
  if (!(pinnedRoot instanceof PinnedProjectRoot) || !pinnedRoot.isStable()) return invalid;
  try {
    const resolved = pinnedResolvedState(cwd, pinnedRoot, currentBranch, undefined);
    return pinnedRoot.isStable() ? resolved : invalid;
  } catch {
    return invalid;
  }
}

/**
 * Resolve one explicit feature/run state through an already-open pinned root.
 * Callers own the descriptor lifetime; this function never opens a second
 * root or follows the active-feature pointer.
 */
export function resolveStatePinned(
  cwd: string,
  pinnedRoot: PinnedProjectRoot,
  selector: FeatureStateSelector,
): ResolvedState {
  const invalid: ResolvedState = { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
  if (!(pinnedRoot instanceof PinnedProjectRoot) || !pinnedRoot.isStable()) return invalid;
  if (!isSafeFeatureId(selector.feature_id) || !nonEmptyStateString(selector.run_key)) return invalid;
  return pinnedResolvedState(cwd, pinnedRoot, NO_GIT_BRANCH, selector);
}

/**
 * Resolve one explicit feature/run preparation state through an already-open
 * pinned root. Preparation may contain the bare specification envelope used
 * before the first workflow transition; all reads remain under that pin.
 */
export function resolvePreparationStatePinned(
  cwd: string,
  pinnedRoot: PinnedProjectRoot,
  selector: FeatureStateSelector,
): ResolvedState {
  const invalid: ResolvedState = { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
  if (!(pinnedRoot instanceof PinnedProjectRoot) || !pinnedRoot.isStable()) return invalid;
  if (!isSafeFeatureId(selector.feature_id) || !nonEmptyStateString(selector.run_key)) return invalid;
  return pinnedResolvedState(cwd, pinnedRoot, NO_GIT_BRANCH, selector, true);
}

/**
 * Resolve the active-feature or legacy state through an already-open pinned
 * root. The active pointer and selected state are both read through the same
 * descriptor, so callers never fall back to an unbounded pathname read.
 */
export function resolveStatePinnedActive(
  cwd: string,
  pinnedRoot: PinnedProjectRoot,
  branch?: string,
): ResolvedState {
  const invalid: ResolvedState = { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
  if (!(pinnedRoot instanceof PinnedProjectRoot) || !pinnedRoot.isStable()) return invalid;
  return pinnedResolvedState(cwd, pinnedRoot, branch, undefined);
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function configuredStateLockTimeoutMs(override: number | undefined): number {
  const requested = override ?? Number(process.env[STATE_LOCK_TIMEOUT_ENV]);
  if (!Number.isFinite(requested) || requested <= 0) return STATE_LOCK_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(requested), STATE_LOCK_MAX_TIMEOUT_MS);
}

function pinnedOwnerFor(pinnedRoot: PinnedProjectRoot, lockPath: string): StateLockObservation {
  try {
    const entry = pinnedRoot.readFile(lockPath, { maxBytes: 4 * 1024 });
    let parsed: unknown = null;
    try { parsed = JSON.parse(Buffer.from(entry.bytes).toString("utf8")); } catch { /* malformed owner is reclaimed only after grace */ }
    const candidate = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    const owner = candidate && Number.isSafeInteger(candidate.pid) && (candidate.pid as number) > 0
      && typeof candidate.token === "string" && candidate.token.length > 0
      ? {
        pid: candidate.pid as number,
        token: candidate.token,
        acquired_at: typeof candidate.acquired_at === "string" ? candidate.acquired_at : "",
        ...(typeof candidate.start_identity === "string" && candidate.start_identity.length > 0 ? { start_identity: candidate.start_identity } : {}),
      }
      : null;
    const expected = { dev: entry.dev, ino: entry.ino, sha256: createHash("sha256").update(entry.bytes).digest("hex") };
    let mtimeMs: number | null = null;
    if (!owner || !owner.start_identity) {
      try { mtimeMs = pinnedRoot.pathEntryInfo(lockPath)?.mtimeMs ?? null; } catch { /* exact expected bytes remain authoritative */ }
    }
    return { owner, expected, kind: "file", dev: entry.dev, ino: entry.ino, mtimeMs };
  } catch (error) {
    if (!(error instanceof PinnedRootError && (error.code === "not_found" || error.code === "not_regular"))) throw error;
    try {
      const info = pinnedRoot.pathEntryInfo(lockPath);
      return {
        owner: null,
        expected: null,
        kind: info?.kind ?? null,
        dev: info?.dev ?? null,
        ino: info?.ino ?? null,
        mtimeMs: info?.mtimeMs ?? null,
      };
    } catch (infoError) {
      if (infoError instanceof PinnedRootError && infoError.code === "not_found") {
        return { owner: null, expected: null, kind: null, dev: null, ino: null, mtimeMs: null };
      }
      throw infoError;
    }
  }
}

function acquirePinnedStateLock(pinnedRoot: PinnedProjectRoot, timeoutMs?: number): { token: string } | { error: string } {
  const lockPath = join(WORK_STATE_DIR, STATE_LOCK_FILE);
  const ownerStartIdentity = processStartIdentity();
  if (!ownerStartIdentity) return { error: "state lock unavailable: process start identity is unavailable" };
  const deadline = monotonicNowMs() + configuredStateLockTimeoutMs(timeoutMs);
  const timedOut = (): boolean => monotonicNowMs() >= deadline;
  try {
    const workState = pinnedRoot.pathEntryInfo(WORK_STATE_DIR);
    if (!workState || workState.kind !== "directory") return { error: "state lock unavailable: workflow state directory is missing or not a directory" };
  } catch (error) {
    return { error: `state lock unavailable: ${String(error)}` };
  }
  let retryMs = STATE_LOCK_RETRY_MS;
  for (;;) {
    if (timedOut()) return { error: "state lock wait timeout exceeded" };
    const token = randomUUID();
    const candidate = `${lockPath}.${process.pid}.${token}.candidate`;
    try {
      if (pinnedRoot.tryAcquireExclusiveLock(
        candidate,
        lockPath,
        JSON.stringify({ pid: process.pid, token, start_identity: ownerStartIdentity, acquired_at: new Date().toISOString() }),
        { ownerlessGraceMs: STATE_LOCK_OWNERLESS_GRACE_MS },
      )) return { token };
    } catch (error) {
      if (!(error instanceof PinnedRootError && error.code === "exists")) return { error: `state lock unavailable: ${String(error)}` };
    }

    let observation: StateLockObservation;
    try { observation = pinnedOwnerFor(pinnedRoot, lockPath); }
    catch (error) { return { error: `state lock unavailable: ${String(error)}` }; }
    if (observation.kind === "symlink") return { error: "state lock unavailable: state lock path is a symbolic link" };
    const staleByGrace = observation.mtimeMs !== null
      && Date.now() - observation.mtimeMs >= STATE_LOCK_OWNERLESS_GRACE_MS;
    let reclaim = false;
    if (observation.kind === "directory") {
      reclaim = staleByGrace && observation.dev !== null && observation.ino !== null;
    } else if (observation.kind === "file") {
      if (observation.owner) {
        const alive = pidAlive(observation.owner.pid);
        if (!alive) {
          // A legacy PID-only owner is reclaimable only after its publication
          // grace. A live PID without a start identity is never evidence of
          // staleness: it may be a replacement process with the same PID.
          reclaim = observation.owner.start_identity ? true : staleByGrace;
        } else if (observation.owner.start_identity) {
          const actualIdentity = processStartIdentity(observation.owner.pid);
          reclaim = actualIdentity !== null && actualIdentity !== observation.owner.start_identity;
        }
      } else {
        reclaim = staleByGrace;
      }
    }

    if (reclaim) {
      try {
        if (observation.kind === "directory" && observation.dev !== null && observation.ino !== null) {
          pinnedRoot.removeEmptyDirectoryIfMatches(lockPath, { dev: observation.dev, ino: observation.ino });
        } else if (observation.kind === "file" && observation.expected) {
          pinnedRoot.removeFileIfMatches(lockPath, observation.expected);
        }
      } catch (error) {
        if (!(error instanceof PinnedRootError && (error.code === "not_found" || error.code === "changed" || error.code === "not_directory" || error.code === "not_regular"))) {
          return { error: `state lock unavailable: ${String(error)}` };
        }
      }
      continue;
    }
    if (timedOut()) return { error: "state lock wait timeout exceeded" };
    sleepStateLock(retryMs);
    retryMs = Math.min(retryMs * 2, STATE_LOCK_MAX_RETRY_MS);
  }
}

function releasePinnedStateLock(pinnedRoot: PinnedProjectRoot, token: string): void {
  const lockPath = join(WORK_STATE_DIR, STATE_LOCK_FILE);
  try {
    withoutCurrentExecutionLiveness(() => {
      const observation = pinnedOwnerFor(pinnedRoot, lockPath);
      if (observation.owner?.token !== token || !observation.expected) return;
      pinnedRoot.removeFileIfMatches(lockPath, observation.expected);
    });
  } catch {
    /* a changed or vanished lock is already released */
  }
}


function statePostimageMatches(actual: TeamState, desired: TeamState, revision: number): boolean {
  if ((actual as TeamState & { state_revision?: unknown }).state_revision !== revision) return false;
  const issues: string[] = [];
  const normalized = normalizePersistedState(desired, issues);
  if (!normalized || issues.length > 0) return false;
  const comparable = (state: TeamState): StateRecord => {
    const record = { ...(state as unknown as StateRecord) };
    // writeState adds these non-authoritative fields while publishing. The
    // state revision and all semantic/control-plane fields remain exact.
    delete record.state_revision;
    delete record.updated_at;
    delete record.observability;
    return record;
  };
  return stableStateHash(comparable(actual)) === stableStateHash(comparable(normalized));
}

function updateStateAtomicallyPinned<T>(
  cwd: string,
  mutate: (snapshot: StateSnapshot) => StateMutation<T>,
  opts: { lockTimeoutMs?: number; target?: ResolvedState; selector?: FeatureStateSelector; featureSlug?: string; branch?: string; branchNeutral?: boolean; rootGuard?: StateRootGuard; preCommit?: () => void; captureReceipts?: boolean; beforePublish?: (receipts: readonly StateMutationReceipt[]) => void; pinnedRoot: PinnedProjectRoot },
): StateUpdateResult<T> {
  const pinnedRoot = opts.pinnedRoot;
  assertCurrentExecutionLiveness();
  if (!pinnedRoot.isStable() || (opts.rootGuard !== undefined && !opts.rootGuard.isStable())) return { ok: false, code: "root_unstable", error: "pinned transaction root changed before state transaction" };
  try {
    pinnedRoot.ensureDirectory(WORK_STATE_DIR);
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "changed") return { ok: false, code: "root_unstable", error: "pinned transaction root changed while opening workflow state directory" };
    return { ok: false, code: "state_lock_unavailable", error: `state lock unavailable: workflow state directory could not be initialized: ${String(error)}` };
  }
  if (!pinnedRoot.isStable() || (opts.rootGuard !== undefined && !opts.rootGuard.isStable())) return { ok: false, code: "root_unstable", error: "pinned transaction root changed after opening workflow state directory" };
  const lock = acquirePinnedStateLock(pinnedRoot, opts.lockTimeoutMs);
  if ("error" in lock) return { ok: false, code: "state_lock_unavailable", error: lock.error };
  try {
    if (!pinnedRoot.isStable() || (opts.rootGuard !== undefined && !opts.rootGuard.isStable())) return { ok: false, code: "root_unstable", error: "pinned transaction root changed after state lock acquisition" };
    const branch = opts.branch ?? resolveActiveBranch(cwd);
    const resolved = opts.selector ? pinnedResolvedState(cwd, pinnedRoot, branch, opts.selector) : (opts.target ?? pinnedResolvedState(cwd, pinnedRoot, branch, undefined));
    if (resolved.invalid) return { ok: false, code: "state_invalid", error: "workflow state is invalid or unsafe" };
    const target = canonicalPinnedTarget(pinnedRoot, targetForTransaction(cwd, branch, opts.selector, resolved, opts.featureSlug));
    if (!target.stateDir || !target.statePath || !target.artifactsDir) return { ok: false, code: "state_invalid", error: "workflow state target is incomplete" };
    findStateHook(cwd, pinnedRoot)?.afterTargetResolution?.({ statePath: target.statePath!, stateDir: target.stateDir!, artifactsDir: target.artifactsDir! });
    const raw = readRawStateSnapshotPinned(pinnedRoot, target.statePath);
    if (raw.kind === "invalid") return { ok: false, code: "state_invalid", error: raw.error };
    const state = raw.kind === "present" ? raw.state : null;
    const revision = raw.kind === "present" ? raw.revision : 0;
    const snapshot: StateSnapshot = {
      state,
      target: { ...target, state, isStale: opts.selector || opts.branchNeutral ? false : state !== null && typeof state.branch === "string" ? state.branch !== branch : false },
      revision,
      raw_hash: raw.kind === "present" ? raw.raw_hash : "",
    };
    const mutation = mutate(snapshot);
    if (mutation.op === "fail") return { ok: false, code: mutation.code, error: mutation.error };
    if (mutation.op === "discard") {
      if (opts.preCommit) {
        findStateHook(cwd, pinnedRoot)?.beforeCas?.({ sourcePath: target.statePath ?? "", destinationPath: target.statePath ?? "" });
        try { opts.preCommit(); } catch (error) {
          return { ok: false, code: "state_invalid", error: "pre-commit guard failed: " + (error instanceof Error ? error.message : String(error)) };
        }
      }
      if (!pinnedRoot.isStable() || (opts.rootGuard !== undefined && !opts.rootGuard.isStable())) return { ok: false, code: "root_unstable", error: "pinned transaction root changed before discard" };
      return { ok: true, state, target: snapshot.target, revision, raw_hash: raw.kind === "present" ? raw.raw_hash : "", committed: false, value: mutation.value };
    }
    if (!pinnedRoot.isStable() || (opts.rootGuard !== undefined && !opts.rootGuard.isStable())) return { ok: false, code: "root_unstable", error: "pinned transaction root changed before state compare-and-swap" };
    const retarget = Boolean(
      target.isStale && state && typeof state.branch === "string" && typeof mutation.state.branch === "string" && mutation.state.branch !== state.branch,
    );
    let commitTarget = target;
    let commitObserved: RawStateRead = raw;
    let commitRevision = revision;
    if (retarget) {
      const destinationSlug = opts.featureSlug ?? deriveFeatureSlugFromBranch(mutation.state.branch) ?? "default";
      commitTarget = canonicalPinnedTarget(pinnedRoot, targetForTransaction(cwd, branch, opts.selector, { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false }, destinationSlug));
      if (!commitTarget.stateDir || !commitTarget.statePath || !commitTarget.artifactsDir) return { ok: false, code: "state_invalid", error: "workflow state target is incomplete" };
      commitObserved = readRawStateSnapshotPinned(pinnedRoot, commitTarget.statePath);
      if (commitObserved.kind === "invalid") return { ok: false, code: "state_conflict", error: commitObserved.error };
      if (commitObserved.kind === "present") return { ok: false, code: "state_conflict", error: "workflow state already exists at the current branch destination" };
      // Retarget races are tested at the destination file itself. Initialize
      // only the pinned destination directories before the CAS seam so a
      // concurrent creator can publish a candidate, while still rejecting any
      // root replacement or symlink redirection through the pin.
      try {
        pinnedRoot.ensureDirectories([
          pinnedRelativePath(pinnedRoot, commitTarget.stateDir),
          pinnedRelativePath(pinnedRoot, commitTarget.artifactsDir),
        ]);
      } catch (error) {
        if (error instanceof PinnedRootError && error.code === "changed") return { ok: false, code: "root_unstable", error: "pinned transaction root changed while opening state target" };
        return { ok: false, code: "state_invalid", error: "workflow state target is invalid or unsafe: " + String(error) };
      }
      commitRevision = 0;
    }
    findStateHook(cwd, pinnedRoot)?.beforeCas?.({ sourcePath: target.statePath ?? "", destinationPath: commitTarget.statePath ?? "" });
    if (retarget) {
      const sourceConflict = rawStateConflict(raw, readRawStateSnapshotPinned(pinnedRoot, target.statePath));
      if (sourceConflict) return { ok: false, code: "state_conflict", error: sourceConflict };
    }
    const conflict = rawStateConflict(commitObserved, readRawStateSnapshotPinned(pinnedRoot, commitTarget.statePath));
    if (conflict) return { ok: false, code: "state_conflict", error: conflict };
    if (!pinnedRoot.isStable() || (opts.rootGuard !== undefined && !opts.rootGuard.isStable())) return { ok: false, code: "root_unstable", error: "pinned transaction root changed immediately before state commit" };
    assertCurrentExecutionLiveness();
    try {
      pinnedRoot.ensureDirectories([
        pinnedRelativePath(pinnedRoot, commitTarget.stateDir!),
        pinnedRelativePath(pinnedRoot, commitTarget.artifactsDir!),
      ]);
    } catch (error) {
      if (error instanceof PinnedRootError && error.code === "changed") return { ok: false, code: "root_unstable", error: "pinned transaction root changed while opening state target" };
      return { ok: false, code: "state_invalid", error: "workflow state target is invalid or unsafe: " + String(error) };
    }
    if (!pinnedRoot.isStable() || (opts.rootGuard !== undefined && !opts.rootGuard.isStable())) return { ok: false, code: "root_unstable", error: "pinned transaction root changed after opening state target" };
    try {
      opts.preCommit?.();
    } catch (error) {
      return { ok: false, code: "state_invalid", error: "pre-commit guard failed: " + (error instanceof Error ? error.message : String(error)) };
    }
    const toWrite = { ...mutation.state, state_revision: commitRevision + 1 } as TeamState;
    let publication: { statePath: string; artifactsDir: string; receipts?: readonly StateMutationReceipt[] } | undefined;
    try {
      assertCurrentExecutionLiveness();
      publication = writeStatePinned(cwd, toWrite, { target: commitTarget, pinnedRoot, directoriesReady: true, captureReceipts: opts.captureReceipts, beforePublish: opts.beforePublish }, pinnedRoot);
      assertCurrentExecutionLiveness();
    } catch (error) {
      if (error instanceof ExecutionLivenessViolation) {
        return { ok: false, code: "root_unstable", error: error.message };
      }
      if (!pinnedRoot.isStable() || (opts.rootGuard !== undefined && !opts.rootGuard.isStable())) {
        return { ok: false, code: "root_unstable", error: "pinned transaction root changed during state commit" };
      }
      // The ordered batch writes state.json before its human mirror and active
      // pointer. If a later projection write failed, state authority is still
      // committed and a replay can repair the readable projections. Never
      // report that durable state as an uncommitted transaction.
      const postimage = readRawStateSnapshotPinned(pinnedRoot, commitTarget.statePath);
      if (postimage.kind === "present" && statePostimageMatches(postimage.state, toWrite, commitRevision + 1)) {
        return {
          ok: true,
          state: postimage.state,
          target: { ...commitTarget, state: postimage.state, isStale: false },
          revision: postimage.revision,
          raw_hash: postimage.raw_hash,
          committed: true,
          value: mutation.value,
          ...(publication?.receipts ? { receipts: publication.receipts } : {}),
        };
      }
      return { ok: false, code: "state_invalid", error: `workflow state commit failed: ${String(error)}` };
    }
    if (!pinnedRoot.isStable() || (opts.rootGuard !== undefined && !opts.rootGuard.isStable())) return { ok: false, code: "root_unstable", error: "pinned transaction root changed after state commit" };
    const committedRaw = readRawStateSnapshotPinned(pinnedRoot, commitTarget.statePath);
    if (committedRaw.kind !== "present") return { ok: false, code: "state_invalid", error: "workflow state commit produced no readable state" };
    const committedTarget = { ...commitTarget, state: committedRaw.state, isStale: false };
    if (!pinnedRoot.isStable() || (opts.rootGuard !== undefined && !opts.rootGuard.isStable())) return { ok: false, code: "root_unstable", error: "pinned transaction root changed after final state verification" };
    return { ok: true, state: committedRaw.state, target: committedTarget, revision: committedRaw.revision, raw_hash: committedRaw.raw_hash, committed: true, value: mutation.value, ...(publication?.receipts ? { receipts: publication.receipts } : {}) };
  } finally {
    releasePinnedStateLock(pinnedRoot, lock.token);
  }
}

export function updateStateAtomically<T>(
  cwd: string,
  mutate: (snapshot: StateSnapshot) => StateMutation<T>,
  opts: { lockTimeoutMs?: number; target?: ResolvedState; selector?: FeatureStateSelector; featureSlug?: string; branch?: string; branchNeutral?: boolean; rootGuard?: StateRootGuard; preCommit?: () => void; captureReceipts?: boolean; beforePublish?: (receipts: readonly StateMutationReceipt[]) => void; pinnedRoot?: PinnedProjectRoot } = {},
): StateUpdateResult<T> {
  if (opts.pinnedRoot) return updateStateAtomicallyPinned(cwd, mutate, { ...opts, pinnedRoot: opts.pinnedRoot });
  if (opts.rootGuard && !opts.rootGuard.isStable()) return { ok: false, code: "root_unstable", error: "pinned transaction root changed before state transaction" };
  const ownedPinnedRoot = PinnedProjectRoot.open(cwd);
  if (!ownedPinnedRoot) return { ok: false, code: "state_invalid", error: "current project root could not be pinned for state transaction" };
  try {
    return updateStateAtomicallyPinned(cwd, mutate, { ...opts, pinnedRoot: ownedPinnedRoot });
  } finally {
    ownedPinnedRoot.close();
  }
}

function readObservabilityPointerPinned(pinnedRoot: PinnedProjectRoot, featureSlug: string): ObservabilityPointer | null {
  if (!isSafeStateSegment(featureSlug)) throw new PinnedRootError("invalid", "unsafe observability feature slug");
  const eventsPath = join(WORK_STATE_DIR, "features", featureSlug, "observability", "events.jsonl");
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before observability pointer read");
  const info = pinnedRoot.pathEntryInfo(eventsPath);
  if (info === null) return null;
  if (info.kind === "symlink") throw new PinnedRootError("path_unauthorized", "observability event log must not be a symbolic link");
  if (info.kind !== "file") throw new PinnedRootError("not_regular", "observability event log must be a regular file");
  let read;
  try {
    read = pinnedRoot.readFile(eventsPath, { maxBytes: OBSERVABILITY_MAX_READ_BYTES });
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return null;
    throw error;
  }
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed after observability pointer read");
  const events = parseBoundedObservabilityEvents(read.bytes, {
    maxBytes: OBSERVABILITY_MAX_READ_BYTES,
    maxRecords: OBSERVABILITY_MAX_RECORDS,
    maxEventBytes: OBSERVABILITY_MAX_EVENT_BYTES,
    maxAggregateBytes: Math.min(OBSERVABILITY_MAX_LOG_BYTES, OBSERVABILITY_MAX_AGGREGATE_BYTES),
    maxWork: OBSERVABILITY_MAX_READ_BYTES * 4,
  });
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed while reducing observability pointer");
  const last = events[events.length - 1];
  return {
    eventsPath: join("observability", "events.jsonl"),
    lastEventId: last?.id ?? "",
    rollupThroughId: last?.id ?? "",
    rollup: rollupFromEvents(events),
  };
}

function writeStatePinned(
  cwd: string,
  state: TeamState,
  opts: { featureSlug?: string; target?: ResolvedState; pinnedRoot?: PinnedProjectRoot; directoriesReady?: boolean; captureReceipts?: boolean; beforePublish?: (receipts: readonly StateMutationReceipt[]) => void },
  pinnedRoot: PinnedProjectRoot,
): { statePath: string; artifactsDir: string; receipts?: readonly StateMutationReceipt[] } {
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before state write");
  assertCurrentExecutionLiveness();
  const target = opts.target;
  if (target?.invalid) throw new Error("cannot write through an invalid workflow state target");
  if (target && (!target.stateDir || !target.statePath || !target.artifactsDir)) throw new Error("workflow state target is incomplete");
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  const featureSlug = target
    ? target.isLegacy ? null : basename(target.stateDir!)
    : opts.featureSlug ?? deriveFeatureSlugFromBranch(state.branch) ?? "default";
  if (featureSlug && !isSafeStateSegment(featureSlug)) throw new Error("unsafe workflow feature slug");
  const stateDir = target?.stateDir ?? (featureSlug ? join(wsDir, "features", featureSlug) : wsDir);
  const statePath = target?.statePath ?? (featureSlug ? join(stateDir, "state.json") : join(wsDir, LEGACY_STATE));
  const artifactsDir = target?.artifactsDir ?? (featureSlug ? join(stateDir, "artifacts") : join(wsDir, "artifacts"));
  const stateRelative = pinnedRelativePath(pinnedRoot, statePath);
  const stateDirRelative = pinnedRelativePath(pinnedRoot, stateDir);
  const artifactsRelative = pinnedRelativePath(pinnedRoot, artifactsDir);
  const rejectionIssues: string[] = [];
  const minimalEnvelope = isBareSpecificationEnvelope(state as unknown as StateRecord);
  const normalized = normalizePersistedState(state, rejectionIssues, { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino });
  if (!normalized) throw new Error(`workflow state contains malformed or conflicting typed control-plane fields: ${rejectionIssues.join("; ") || "unrecognized shape"}`);
  const stamped: TeamState = minimalEnvelope ? normalized : { ...normalized, updated_at: new Date().toISOString() };
  const obsPointer = !minimalEnvelope && featureSlug ? readObservabilityPointerPinned(pinnedRoot, featureSlug) : null;
  if (obsPointer) stamped.observability = obsPointer as TeamState["observability"];
  else delete stamped.observability;
  const serializedState = Buffer.from(JSON.stringify(stamped, null, 2) + "\n", "utf8");
  if (serializedState.byteLength > MAX_PERSISTED_STATE_BYTES) {
    throw new Error(`serialized workflow state exceeds the ${MAX_PERSISTED_STATE_BYTES}-byte limit`);
  }
  if (!opts.directoriesReady) pinnedRoot.ensureDirectories([stateDirRelative, artifactsRelative]);
  // Preserve the durable ordering (state JSON, then human mirror, then the
  // active-feature pointer) while publishing all three through one bounded
  // inherited-fd request on Darwin. The helper executes entries in order and
  // keeps each write atomic/no-follow.
  const activePointerPath = join(WORK_STATE_DIR, ACTIVE_FEATURE);
  const activePointerPreimage: PinnedRootWritePreimage | undefined = !featureSlug
    ? pinnedRoot.captureWritePreimageForReceipt(activePointerPath)
    : undefined;
  const entries = [
    { path: stateRelative, content: serializedState },
    { path: join(stateDirRelative, STATE_MD), content: renderStateMarkdown(stamped) },
    ...(featureSlug ? [{ path: activePointerPath, content: featureSlug + "\n" }] : []),
  ];
  let receipts: readonly StateMutationReceipt[] | undefined;
  if (opts.captureReceipts) {
    receipts = pinnedRoot.writeAtomicFilesWithReceipts(entries, {
      ...(opts.beforePublish ? { beforePublish: opts.beforePublish } : {}),
    });
    if (receipts.length !== entries.length) throw new PinnedRootError("write_failed", "state publication returned an incomplete receipt set");
  } else {
    pinnedRoot.writeAtomicFiles(entries);
  }
  if (!featureSlug && activePointerPreimage?.kind === "file") {
    try {
      pinnedRoot.removeFileIfMatches(activePointerPath, activePointerPreimage.expectation);
    } catch (error) {
      // A concurrent replacement wins the pointer race and must be preserved;
      // the state authority remains committed and can reconcile on replay.
      if (!(error instanceof PinnedRootError) || !["changed", "not_found"].includes(error.code)) throw error;
    }
  }
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed after state write");
  return { statePath, artifactsDir, ...(receipts ? { receipts } : {}) };
}

export function writeState(
  cwd: string,
  state: TeamState,
  opts: { featureSlug?: string; target?: ResolvedState; pinnedRoot?: PinnedProjectRoot; captureReceipts?: boolean; beforePublish?: (receipts: readonly StateMutationReceipt[]) => void } = {},
): { statePath: string; artifactsDir: string; receipts?: readonly StateMutationReceipt[] } {
  if (opts.pinnedRoot) return writeStatePinned(cwd, state, opts, opts.pinnedRoot);
  const ownedPinnedRoot = PinnedProjectRoot.open(cwd);
  if (!ownedPinnedRoot) throw new Error("current project root could not be pinned for state write");
  try {
    return writeStatePinned(cwd, state, { ...opts, pinnedRoot: ownedPinnedRoot }, ownedPinnedRoot);
  } finally {
    ownedPinnedRoot.close();
  }
}

function atomicWrite(path: string, content: string, pinnedRoot?: PinnedProjectRoot): void {
  if (pinnedRoot) {
    const relativePath = pinnedRoot.relativePath(path);
    if (!relativePath) throw new PinnedRootError("path_unauthorized", "state write path escapes the pinned project root");
    pinnedRoot.writeAtomic(relativePath, content);
    return;
  }
  secureAtomicWriteFile(path, content);
}
function readObservabilityPointerSafe(cwd: string, featureSlug: string) {
  try {
    return readObservabilityPointer(cwd, featureSlug);
  } catch {
    return null;
  }
}


/** Maximum bytes accepted from an explicitly selected legacy JSON source. */
const MAX_LEGACY_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_LEGACY_SOURCE_PATH_LENGTH = 4096;

export type LegacySpecificationSourceCode =
  | "path_unauthorized"
  | "not_found"
  | "not_regular"
  | "too_large"
  | "unstable"
  | "read_failed";

export type LegacySpecificationSourceResult =
  | { ok: true; path: string; relative_path: string; bytes: Uint8Array; dev: number; ino: number }
  | { ok: false; code: LegacySpecificationSourceCode; error: string };

function legacyRootStat(pinnedRoot: PinnedProjectRoot): Stats | null {
  try {
    const root = lstatSync(pinnedRoot.canonical_root);
    return root.isDirectory() && !root.isSymbolicLink() ? root : null;
  } catch {
    return null;
  }
}

function sameLegacyRootStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/**
 * Read an explicitly selected legacy source through the caller's already
 * borrowed project-root descriptor. The source selector is translated to a
 * safe relative path exactly once; every component and the final regular file
 * are then opened no-follow by PinnedProjectRoot.readFile. No lexical root
 * path is re-resolved after the descriptor is borrowed.
 */
export function readLegacySpecificationSource(
  pinnedRoot: PinnedProjectRoot,
  sourcePath: string,
): LegacySpecificationSourceResult {
  if (!(pinnedRoot instanceof PinnedProjectRoot) || typeof sourcePath !== "string") {
    return { ok: false, code: "path_unauthorized", error: "a borrowed pinned project root and source path are required" };
  }
  if (sourcePath.length > MAX_LEGACY_SOURCE_PATH_LENGTH) {
    return { ok: false, code: "path_unauthorized", error: "legacy source path exceeds the bounded selector limit" };
  }
  const candidate = isAbsolute(sourcePath)
    ? sourcePath
    : join(pinnedRoot.lexical_root, sourcePath);
  const relativePath = pinnedRoot.relativePath(candidate);
  if (!relativePath || relativePath.length > MAX_LEGACY_SOURCE_PATH_LENGTH) {
    return { ok: false, code: "path_unauthorized", error: "legacy source path must remain within the pinned project root" };
  }
  try {
    if (!pinnedRoot.isStable()) return { ok: false, code: "unstable", error: "pinned project root changed before the legacy source read" };
    const rootBefore = legacyRootStat(pinnedRoot);
    if (!rootBefore) return { ok: false, code: "unstable", error: "pinned project root pathname is not a stable directory" };
    const read = pinnedRoot.readFile(relativePath, { maxBytes: MAX_LEGACY_SOURCE_BYTES });
    const rootAfter = legacyRootStat(pinnedRoot);
    if (!pinnedRoot.isStable() || !rootAfter || !sameLegacyRootStat(rootBefore, rootAfter)) return { ok: false, code: "unstable", error: "pinned project root changed while the legacy source was being read" };
    return {
      ok: true,
      path: read.path,
      relative_path: relativePath.replaceAll("\\", "/"),
      bytes: read.bytes,
      dev: read.dev,
      ino: read.ino,
    };
  } catch (error) {
    if (error instanceof PinnedRootError) {
      switch (error.code) {
        case "not_found":
          return { ok: false, code: "not_found", error: "legacy source does not exist below the pinned project root" };
        case "not_regular":
          return { ok: false, code: "not_regular", error: "legacy source must be a regular file" };
        case "changed":
          return { ok: false, code: "unstable", error: "legacy source changed while it was being read" };
        case "path_unauthorized":
        case "invalid":
          return { ok: false, code: "path_unauthorized", error: "legacy source path is not a safe relative file below the pinned project root" };
        case "write_failed":
          return { ok: false, code: /exceeds the bounded read limit/iu.test(error.message) ? "too_large" : "read_failed", error: "legacy source could not be read within the bounded limit" };
        default:
          return { ok: false, code: "read_failed", error: "legacy source could not be read safely" };
      }
    }
    return { ok: false, code: "read_failed", error: "legacy source could not be read safely: " + String(error) };
  }
}

/**
 * Engine-owned safe atomic file write (temp file + rename in the target
 * directory). The canonical persistence primitive for specification
 * aggregate state alongside `writeState`; readers never observe partial bytes.
 */
export const atomicWriteFile = atomicWrite;

function renderSpecificationStateMd(state: StateRecord): string {
  const workspace = state.specification as FeatureWorkspace;
  const currentPhase = workspace.phases.find((phase) => phase.status !== "approved");
  const nextAction = workspace.next_action;
  const lines: string[] = [];
  lines.push("# TEAM STATE");
  lines.push("");
  lines.push("## Specification workspace");
  lines.push(`- Feature: ${workspace.feature_id}`);
  lines.push(`- Display name: ${workspace.display_name}`);
  lines.push(`- Run: ${state.run_key}`);
  lines.push(`- Source: ${workspace.source_kind}`);
  lines.push(`- Status: ${workspace.status}`);
  lines.push(`- Current phase: ${currentPhase ? `${currentPhase.phase} (${currentPhase.status})` : "none (all phases approved)"}`);
  lines.push(`- Next action: ${nextAction.command ?? nextAction.kind}`);
  lines.push(`- Next action kind: ${nextAction.kind}`);
  lines.push(`- Next action reason: ${nextAction.reason}`);
  lines.push("");
  lines.push("## Workspace");
  lines.push(`- Path: ${workspace.workspace_path}`);
  lines.push(`- State: ${workspace.state_path}`);
  lines.push(`- Profile: ${workspace.profile_name}`);
  lines.push(`- Language: ${workspace.language.language}`);
  lines.push(`- Template set: ${workspace.template_set.template_set_id}`);
  lines.push(`- Constitution: ${workspace.constitution_binding ? "bound" : "unresolved"}`);
  lines.push("");
  lines.push("## Phases");
  for (const phase of workspace.phases) {
    lines.push(`- ${phase.phase}: ${phase.status} (current version: ${phase.current_version ?? "none"}; approved version: ${phase.approved_version ?? "none"})`);
  }
  lines.push("");
  lines.push("## Persistence");
  lines.push(`- Schema: ${state.schema}`);
  lines.push(`- Revision: ${state.state_revision ?? "none"}`);
  lines.push("");
  return lines.join("\n");
}

function renderFullStateMd(state: TeamState): string {
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

function renderStateMarkdown(state: TeamState): string {
  const record = state as unknown as StateRecord;
  return isBareSpecificationEnvelope(record)
    ? renderSpecificationStateMd(record)
    : renderFullStateMd(state);
}

export function writeStateMd(stateDir: string, state: TeamState, pinnedRoot?: PinnedProjectRoot): void {
  atomicWrite(join(stateDir, STATE_MD), renderStateMarkdown(state), pinnedRoot);
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
 * artifacts and stage history remain intact. Native preparation continuations keep the
 * initial task immutable; generic workflows retain their historical projection.
 */
export function reopenFromFeedback(
  state: TeamState,
  feedback: string,
  stageId: string,
  options: { preserveTask?: boolean } = {},
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
    ...(options.preserveTask ? {} : { task: state.task + "\n\nUser feedback: " + feedback }),
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
    ensureSecureStateDirectory(archiveDir);
    const safeBranch = state.branch.replace(/\//g, "-").replace(/[^a-z0-9._-]/gi, "-");
    const dest = join(archiveDir, `${safeBranch}.${Date.now()}.bak.json`);
    atomicWrite(dest, JSON.stringify(state, null, 2));
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
