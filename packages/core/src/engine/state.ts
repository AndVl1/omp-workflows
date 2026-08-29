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
  validateProfileControlPlane,
} from "./profile.js";
import { createDiagnostic } from "../workflow-v2/diagnostics.js";
import { validateProjectIdentity, validateWorkflowRunIdentity, isProviderId, isWorkflowV2Digest } from "../workflow-v2/identity.js";
import type {
  ProjectIdentity,
  WorkflowRunIdentity,
  WorkflowV2Diagnostic,
} from "../workflow-v2/types.js";
import { WorkflowLifecycleError } from "./types.js";
import type {
  CheckpointPolicy,
  CompletionArtifactRef,
  CompletionEnvelope,
  ControlPlaneProvenance,
  DispatchCapabilityState,
  DispatchCompletion,
  DispatchRecord,
  MigrationReceipt,
  PauseKind,
  PendingState,
  RetiredCapability,
  StageStatus,
  TeamState,
  WorkIdentity,
} from "./types.js";
function validateRunIdentity(value: unknown, path: string, issues: string[]): void {
  const checked = validateWorkflowRunIdentity(value);
  if (!checked.ok) {
    for (const diagnostic of checked.diagnostics) issues.push(`${path} ${diagnostic.code}`);
  }
}
function sameProjectIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id;
}

function sameRunIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return sameProjectIdentity(left, right)
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

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
function sameWorkIdentity(left: WorkIdentity, right: WorkIdentity): boolean {
  return left.run_id === right.run_id
    && left.wave_id === right.wave_id
    && left.slice_id === right.slice_id
    && left.session_id === right.session_id
    && left.workflow === right.workflow
    && left.stage_id === right.stage_id
    && left.stage_cursor === right.stage_cursor
    && left.capability_id === right.capability_id
    && left.capability_epoch === right.capability_epoch
    && left.slot_id === right.slot_id
    && left.task_id === right.task_id
    && left.dispatch_id === right.dispatch_id
    && left.attempt === right.attempt
    && left.worker_id === right.worker_id;
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
  strictStateKeys(value, ["identity", "run_identity", "status", "pending_reason", "provider_ref", "lease", "terminal_signal", "retry_of", "updated_at"], path, issues);
  validateStateIdentity(value.identity, `${path}.identity`, issues);
  if (!Object.prototype.hasOwnProperty.call(value, "run_identity")) issues.push(`${path}.run_identity is required`);
  else validateRunIdentity(value.run_identity, `${path}.run_identity`, issues);
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
  strictStateKeys(value, ["run_identity", "parent", "child", "state", "expected_artifact_ids", "completion_envelope_ref", "attempt", "created_at", "joined_at"], path, issues);
  if (!Object.prototype.hasOwnProperty.call(value, "run_identity")) issues.push(`${path}.run_identity is required`);
  else validateRunIdentity(value.run_identity, `${path}.run_identity`, issues);
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
  strictStateKeys(value, ["schema_version", "identity", "run_identity", "outcome", "terminal_signal", "artifact_refs", "evidence_ref", "conflict_ref", "completed_by", "emitted_at"], path, issues);
  if (value.schema_version !== 1) issues.push(`${path}.schema_version must be 1`);
  validateStateIdentity(value.identity, `${path}.identity`, issues);
  if (!Object.prototype.hasOwnProperty.call(value, "run_identity")) issues.push(`${path}.run_identity is required`);
  else validateRunIdentity(value.run_identity, `${path}.run_identity`, issues);
  if (!["pending", "succeeded", "failed", "cancelled"].includes(String(value.outcome))) issues.push(`${path}.outcome has an unknown value`);
  if (Object.prototype.hasOwnProperty.call(value, "terminal_signal") && value.terminal_signal === undefined) issues.push(`${path}.terminal_signal must not be undefined`);
  else if (value.terminal_signal !== null && value.terminal_signal !== undefined && !["workflow_complete", "native_tool_result", "provider_terminal", "contract_failure"].includes(String(value.terminal_signal))) issues.push(`${path}.terminal_signal has an unknown value`);
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
function validateStateAgentRef(value: unknown, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, ["registered_name", "provider_id", "source_fingerprint"], path, issues);
  if (!nonEmptyStateString(value.registered_name)) issues.push(`${path}.registered_name must be a non-empty string`);
  if (!isProviderId(value.provider_id)) issues.push(`${path}.provider_id must be a provider id`);
  if (!isWorkflowV2Digest(value.source_fingerprint)) issues.push(`${path}.source_fingerprint must be a sha256 digest`);
}

function validateStateDispatchCompletion(value: unknown, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, [
    "dispatch_id", "cursor_epoch", "outcome", "artifact_ids", "evidence",
    "completed_by", "completed_at", "run_identity", "work_identity",
  ], path, issues);
  for (const key of ["dispatch_id", "cursor_epoch", "evidence", "completed_at"]) {
    if (!nonEmptyStateString(value[key])) issues.push(`${path}.${key} must be a non-empty string`);
  }
  if (!["succeeded", "failed", "cancelled"].includes(String(value.outcome))) issues.push(`${path}.outcome has an unknown value`);
  if (!Array.isArray(value.artifact_ids) || value.artifact_ids.some((id) => !nonEmptyStateString(id) || !isSafeStateSegment(String(id)))) {
    issues.push(`${path}.artifact_ids must be an array of safe non-empty strings`);
  }
  if (!["workflow_complete", "synchronous_tool_result", "engine_task_caller"].includes(String(value.completed_by))) {
    issues.push(`${path}.completed_by has an unknown value`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, "run_identity")) issues.push(`${path}.run_identity is required`);
  else validateRunIdentity(value.run_identity, `${path}.run_identity`, issues);
  if (Object.prototype.hasOwnProperty.call(value, "work_identity")) {
    if (value.work_identity === undefined) issues.push(`${path}.work_identity must not be undefined`);
    else validateStateIdentity(value.work_identity, `${path}.work_identity`, issues);
  }
}

function validateStateDispatchRecord(value: unknown, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, [
    "id", "role", "agent", "agent_ref", "tool_call_id", "status", "attempt",
    "created_at", "completed_at", "completion", "run_identity",
    "work_identity", "pending", "completion_envelope",
  ], path, issues);
  for (const key of ["id", "role", "agent", "created_at"]) {
    if (!nonEmptyStateString(value[key])) issues.push(`${path}.${key} must be a non-empty string`);
  }
  if (!["authorized", "running", "pending", "succeeded", "failed", "cancelled"].includes(String(value.status))) {
    issues.push(`${path}.status has an unknown value`);
  }
  if (!Number.isInteger(value.attempt) || (value.attempt as number) < 1) issues.push(`${path}.attempt must be an integer >= 1`);
  if (Object.prototype.hasOwnProperty.call(value, "agent_ref")) {
    if (value.agent_ref === undefined) issues.push(`${path}.agent_ref must not be undefined`);
    else validateStateAgentRef(value.agent_ref, `${path}.agent_ref`, issues);
  }
  for (const key of ["tool_call_id", "completed_at"]) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] === undefined) issues.push(`${path}.${key} must not be undefined`);
    else if (value[key] !== undefined && !nonEmptyStateString(value[key])) issues.push(`${path}.${key} must be a non-empty string`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, "run_identity")) issues.push(`${path}.run_identity is required`);
  else validateRunIdentity(value.run_identity, `${path}.run_identity`, issues);
  if (!Object.prototype.hasOwnProperty.call(value, "work_identity")) issues.push(`${path}.work_identity is required`);
  else validateStateIdentity(value.work_identity, `${path}.work_identity`, issues);
  for (const key of ["pending", "completion", "completion_envelope"]) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] === undefined) issues.push(`${path}.${key} must not be undefined`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "pending") && value.pending !== undefined) validateStatePending(value.pending, `${path}.pending`, issues);
  if (Object.prototype.hasOwnProperty.call(value, "completion") && value.completion !== undefined) validateStateDispatchCompletion(value.completion, `${path}.completion`, issues);
  if (Object.prototype.hasOwnProperty.call(value, "completion_envelope") && value.completion_envelope !== undefined) validateStateCompletion(value.completion_envelope, `${path}.completion_envelope`, issues);
}

function validateStateCapability(value: unknown, path: string, issues: string[]): void {
  if (!isStateRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  strictStateKeys(value, [
    "capability_id", "dispatch_token_hash", "advance_token_hash", "issued_for", "kind",
    "project_identity", "run_identity", "expected_roles", "expected_count", "expected_roster",
    "roster_selection", "work_identity", "pending", "status", "dispatches",
  ], path, issues);
  for (const key of ["capability_id", "dispatch_token_hash", "advance_token_hash"]) {
    if (!nonEmptyStateString(value[key])) issues.push(`${path}.${key} must be a non-empty string`);
  }
  for (const key of ["dispatch_token_hash", "advance_token_hash"]) {
    if (typeof value[key] === "string" && !/^[0-9a-f]{64}$/.test(value[key])) issues.push(`${path}.${key} must be a lowercase sha256 hash`);
  }
  const project = Object.prototype.hasOwnProperty.call(value, "project_identity")
    ? validateProjectIdentity(value.project_identity)
    : null;
  const run = Object.prototype.hasOwnProperty.call(value, "run_identity")
    ? validateWorkflowRunIdentity(value.run_identity)
    : null;
  if (!project?.ok) issues.push(`${path}.project_identity is malformed`);
  if (!run?.ok) issues.push(`${path}.run_identity is malformed`);
  if (project?.ok && run?.ok && !sameProjectIdentity(project.value, run.value)) issues.push(`${path}.run_identity must inherit project_identity`);
  if (!isStateRecord(value.issued_for)) {
    issues.push(`${path}.issued_for must be an object`);
  } else {
    const issued = value.issued_for;
    strictStateKeys(issued, [
      "run_key", "branch", "workflow", "profile_hash", "stage_cursor", "cursor_epoch",
      "project_identity", "run_identity",
    ], `${path}.issued_for`, issues);
    for (const key of ["run_key", "branch", "workflow", "profile_hash", "stage_cursor", "cursor_epoch"]) {
      if (!nonEmptyStateString(issued[key])) issues.push(`${path}.issued_for.${key} must be a non-empty string`);
    }
    const issuedProject = Object.prototype.hasOwnProperty.call(issued, "project_identity")
      ? validateProjectIdentity(issued.project_identity)
      : null;
    const issuedRun = Object.prototype.hasOwnProperty.call(issued, "run_identity")
      ? validateWorkflowRunIdentity(issued.run_identity)
      : null;
    if (!issuedProject?.ok) issues.push(`${path}.issued_for.project_identity is malformed`);
    if (!issuedRun?.ok) issues.push(`${path}.issued_for.run_identity is malformed`);
    if (issuedProject?.ok && issuedRun?.ok && !sameProjectIdentity(issuedProject.value, issuedRun.value)) {
      issues.push(`${path}.issued_for.run_identity must inherit issued_for.project_identity`);
    }
    if (project?.ok && issuedProject?.ok && !sameProjectIdentity(project.value, issuedProject.value)) {
      issues.push(`${path}.issued_for.project_identity must match project_identity`);
    }
    if (run?.ok && issuedRun?.ok && !sameRunIdentity(run.value, issuedRun.value)) {
      issues.push(`${path}.issued_for.run_identity must match run_identity`);
    }
  }
  if (!["none", "single", "consilium"].includes(String(value.kind))) issues.push(`${path}.kind has an unknown value`);
  if (!Array.isArray(value.expected_roles) || value.expected_roles.some((role) => !nonEmptyStateString(role))) {
    issues.push(`${path}.expected_roles must be an array of non-empty strings`);
  }
  if (!Number.isInteger(value.expected_count) || (value.expected_count as number) < 0) issues.push(`${path}.expected_count must be an integer >= 0`);
  if (!Array.isArray(value.expected_roster)) {
    issues.push(`${path}.expected_roster must be an array`);
  } else {
    const roles = new Set<string>();
    value.expected_roster.forEach((entry, index) => {
      const entryPath = `${path}.expected_roster[${index}]`;
      if (!isStateRecord(entry)) {
        issues.push(`${entryPath} must be an object`);
        return;
      }
      strictStateKeys(entry, ["role", "agent", "agent_ref", "slot_id", "semantic_role", "occurrence", "facet"], entryPath, issues);
      for (const key of ["role", "agent"]) if (!nonEmptyStateString(entry[key])) issues.push(`${entryPath}.${key} must be a non-empty string`);
      if (roles.has(String(entry.role))) issues.push(`${entryPath}.role is duplicated`);
      roles.add(String(entry.role));
      if (!Object.prototype.hasOwnProperty.call(entry, "agent_ref") || entry.agent_ref === undefined) issues.push(`${entryPath}.agent_ref is required`);
      else {
        validateStateAgentRef(entry.agent_ref, `${entryPath}.agent_ref`, issues);
        if (project?.ok && isStateRecord(entry.agent_ref) && entry.agent_ref.provider_id !== project.value.provider_id) {
          issues.push(`${entryPath}.agent_ref.provider_id must match project_identity.provider_id`);
        }
        if (isStateRecord(entry.agent_ref) && entry.agent_ref.registered_name !== entry.agent) {
          issues.push(`${entryPath}.agent_ref.registered_name must match agent`);
        }
      }
      if (Object.prototype.hasOwnProperty.call(entry, "slot_id") && entry.slot_id === undefined) issues.push(`${entryPath}.slot_id must not be undefined`);
      else if (entry.slot_id !== undefined && !nonEmptyStateString(entry.slot_id)) issues.push(`${entryPath}.slot_id must be a non-empty string`);
      if (Object.prototype.hasOwnProperty.call(entry, "semantic_role") && entry.semantic_role === undefined) issues.push(`${entryPath}.semantic_role must not be undefined`);
      else if (entry.semantic_role !== undefined && !nonEmptyStateString(entry.semantic_role)) issues.push(`${entryPath}.semantic_role must be a non-empty string`);
      if (Object.prototype.hasOwnProperty.call(entry, "occurrence") && entry.occurrence === undefined) issues.push(`${entryPath}.occurrence must not be undefined`);
      else if (entry.occurrence !== undefined && (!Number.isInteger(entry.occurrence) || (entry.occurrence as number) < 1)) issues.push(`${entryPath}.occurrence must be an integer >= 1`);
      if (Object.prototype.hasOwnProperty.call(entry, "facet") && entry.facet === undefined) issues.push(`${entryPath}.facet must be a non-empty string or null`);
      else if (entry.facet !== undefined && entry.facet !== null && !nonEmptyStateString(entry.facet)) issues.push(`${entryPath}.facet must be a non-empty string or null`);
    });
  }
  if (Object.prototype.hasOwnProperty.call(value, "roster_selection")) {
    if (value.roster_selection === undefined) issues.push(`${path}.roster_selection must not be undefined`);
    else validateStateSelection(value.roster_selection, `${path}.roster_selection`, issues);
  }
  if (!Object.prototype.hasOwnProperty.call(value, "work_identity")) issues.push(`${path}.work_identity is required`);
  else validateStateIdentity(value.work_identity, `${path}.work_identity`, issues);
  if (Object.prototype.hasOwnProperty.call(value, "pending")) {
    if (value.pending === undefined) issues.push(`${path}.pending must not be undefined`);
    else if (!Array.isArray(value.pending)) issues.push(`${path}.pending must be an array`);
    else value.pending.forEach((entry, index) => validateStatePending(entry, `${path}.pending[${index}]`, issues));
  }
  if (!["ready", "dispatched", "joining", "complete", "invalidated"].includes(String(value.status))) issues.push(`${path}.status has an unknown value`);
  if (!Array.isArray(value.dispatches)) {
    issues.push(`${path}.dispatches must be an array`);
  } else {
    value.dispatches.forEach((entry, index) => validateStateDispatchRecord(entry, `${path}.dispatches[${index}]`, issues));
  }
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

function validateStateRetiredCapabilities(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return;
  }
  if (value.length > 128) issues.push(`${path} must contain at most 128 entries per run`);
  const keys = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isStateRecord(entry)) {
      issues.push(`${entryPath} must be an object`);
      return;
    }
    strictStateKeys(entry, [
      "capability_id", "capability_epoch", "run_identity", "work_identity",
      "dispatch_capability", "completion_outcome", "completion_envelope", "reason", "retired_at",
    ], entryPath, issues);
    for (const key of ["capability_id", "capability_epoch", "reason", "retired_at"]) {
      if (!nonEmptyStateString(entry[key])) issues.push(`${entryPath}.${key} must be a non-empty string`);
    }
    const key = `${String(entry.capability_id)}:${String(entry.capability_epoch)}`;
    if (keys.has(key)) issues.push(`${entryPath} duplicates capability_id+capability_epoch`);
    keys.add(key);
    if (!Object.prototype.hasOwnProperty.call(entry, "run_identity")) issues.push(`${entryPath}.run_identity is required`);
    else validateRunIdentity(entry.run_identity, `${entryPath}.run_identity`, issues);
    validateStateIdentity(entry.work_identity, `${entryPath}.work_identity`, issues);
    if (!Object.prototype.hasOwnProperty.call(entry, "dispatch_capability")) issues.push(`${entryPath}.dispatch_capability is required`);
    else if (entry.dispatch_capability === undefined) issues.push(`${entryPath}.dispatch_capability must not be undefined`);
    else validateStateCapability(entry.dispatch_capability, `${entryPath}.dispatch_capability`, issues);
    if (!Object.prototype.hasOwnProperty.call(entry, "completion_outcome")) {
      issues.push(`${entryPath}.completion_outcome is required`);
    } else if (entry.completion_outcome !== null && !["pending", "succeeded", "failed", "cancelled"].includes(String(entry.completion_outcome))) {
      issues.push(`${entryPath}.completion_outcome has an unknown value`);
    }
    if (!Object.prototype.hasOwnProperty.call(entry, "completion_envelope")) {
      issues.push(`${entryPath}.completion_envelope is required`);
    } else if (entry.completion_envelope === undefined) {
      issues.push(`${entryPath}.completion_envelope must be null or a valid envelope`);
    } else if (entry.completion_envelope !== null) {
      validateStateCompletion(entry.completion_envelope, `${entryPath}.completion_envelope`, issues);
    }
    const capability = isStateRecord(entry.dispatch_capability) ? entry.dispatch_capability : null;
    const entryRun = validateWorkflowRunIdentity(entry.run_identity);
    const entryIdentity = isStateRecord(entry.work_identity) ? entry.work_identity : null;
    const capabilityIdentity = capability && isStateRecord(capability.work_identity) ? capability.work_identity : null;
    const capabilityRun = capability ? validateWorkflowRunIdentity(capability.run_identity) : null;
    if (entryRun?.ok && capabilityRun?.ok && !sameRunIdentity(entryRun.value, capabilityRun.value)) {
      issues.push(`${entryPath}.dispatch_capability.run_identity must match run_identity`);
    }
    if (entryIdentity && capabilityIdentity && !sameWorkIdentity(entryIdentity as unknown as WorkIdentity, capabilityIdentity as unknown as WorkIdentity)) {
      issues.push(`${entryPath}.dispatch_capability.work_identity must match work_identity`);
    }
    if (capability && String(capability.capability_id) !== String(entry.capability_id)) issues.push(`${entryPath}.capability_id must match dispatch_capability.capability_id`);
    if (capability && isStateRecord(capability.issued_for) && String(capability.issued_for.cursor_epoch) !== String(entry.capability_epoch)) {
      issues.push(`${entryPath}.capability_epoch must match dispatch_capability.issued_for.cursor_epoch`);
    }
    if (capabilityIdentity && String(capabilityIdentity.capability_epoch) !== String(entry.capability_epoch)) {
      issues.push(`${entryPath}.capability_epoch must match dispatch_capability.work_identity.capability_epoch`);
    }
    const envelope = entry.completion_envelope;
    if (envelope && isStateRecord(envelope)) {
      if (String(envelope.outcome) !== String(entry.completion_outcome)) issues.push(`${entryPath}.completion_outcome must match completion_envelope.outcome`);
      if (entryIdentity && isStateRecord(envelope.identity) && !sameWorkIdentity(entryIdentity as unknown as WorkIdentity, envelope.identity as unknown as WorkIdentity)) {
        issues.push(`${entryPath}.completion_envelope.identity must match work_identity`);
      }
      if (entryRun?.ok) {
        const envelopeRun = validateWorkflowRunIdentity(envelope.run_identity);
        if (envelopeRun.ok && !sameRunIdentity(entryRun.value, envelopeRun.value)) issues.push(`${entryPath}.completion_envelope.run_identity must match run_identity`);
      }
    } else if (entry.completion_outcome !== null) {
      issues.push(`${entryPath}.completion_envelope is required when completion_outcome is not null`);
    }
  });
}

function validateStateIdentityCoherence(state: StateRecord, issues: string[]): void {
  const checkedRun = validateWorkflowRunIdentity(state.run_identity);
  if (!checkedRun.ok) return;
  const run = checkedRun.value;
  const workflow = typeof state.workflow === "string" ? state.workflow : null;
  const classification = isStateRecord(state.classification) ? state.classification : null;
  const classificationWorkflow = classification && typeof classification.workflow === "string" ? classification.workflow : null;
  const stageCursor = typeof state.stage_cursor === "string" ? state.stage_cursor : null;
  const validateIdentityBinding = (value: unknown, path: string, requireStage = false): void => {
    if (!isStateRecord(value)) return;
    if (value.run_id !== run.run_id) issues.push(`${path}.run_id does not match $.run_identity.run_id`);
    if (value.session_id !== run.session.session_id) issues.push(`${path}.session_id does not match $.run_identity.session.session_id`);
    if (workflow && value.workflow !== workflow) issues.push(`${path}.workflow does not match $.workflow`);
    if (classificationWorkflow && value.workflow !== classificationWorkflow) issues.push(`${path}.workflow does not match $.classification.workflow`);
    if (requireStage && stageCursor && (value.stage_id !== stageCursor || value.stage_cursor !== stageCursor)) {
      issues.push(`${path}.stage_id/stage_cursor does not match $.stage_cursor`);
    }
  };
  if (isStateRecord(state.work_identity)) validateIdentityBinding(state.work_identity, "$.work_identity", true);
  if (isStateRecord(state.pending)) {
    validateIdentityBinding(state.pending.identity, "$.pending.identity", true);
    const pendingRun = validateWorkflowRunIdentity(state.pending.run_identity);
    if (pendingRun.ok && !sameRunIdentity(run, pendingRun.value)) issues.push("$.pending.run_identity does not match $.run_identity");
    if (isStateRecord(state.work_identity) && isStateRecord(state.pending.identity) && !sameWorkIdentity(state.work_identity as unknown as WorkIdentity, state.pending.identity as unknown as WorkIdentity)) {
      issues.push("$.pending.identity does not match $.work_identity");
    }
  }
  if (isStateRecord(state.completion_envelope)) {
    validateIdentityBinding(state.completion_envelope.identity, "$.completion_envelope.identity", true);
    const envelopeRun = validateWorkflowRunIdentity(state.completion_envelope.run_identity);
    if (envelopeRun.ok && !sameRunIdentity(run, envelopeRun.value)) issues.push("$.completion_envelope.run_identity does not match $.run_identity");
    if (isStateRecord(state.work_identity) && isStateRecord(state.completion_envelope.identity) && !sameWorkIdentity(state.work_identity as unknown as WorkIdentity, state.completion_envelope.identity as unknown as WorkIdentity)) {
      issues.push("$.completion_envelope.identity does not match $.work_identity");
    }
  }
  const validateChild = (value: unknown, path: string): void => {
    if (!isStateRecord(value)) return;
    const childRun = validateWorkflowRunIdentity(value.run_identity);
    if (childRun.ok && !sameRunIdentity(run, childRun.value)) issues.push(`${path}.run_identity does not match $.run_identity`);
    validateIdentityBinding(value.parent, `${path}.parent`);
    validateIdentityBinding(value.child, `${path}.child`);
  };
  if (Object.prototype.hasOwnProperty.call(state, "child_join")) validateChild(state.child_join, "$.child_join");
  if (Array.isArray(state.child_joins)) state.child_joins.forEach((join, index) => validateChild(join, `$.child_joins[${index}]`));
  if (isStateRecord(state.join_summary)) {
    const summaryRun = validateWorkflowRunIdentity(state.join_summary.run_identity);
    if (summaryRun.ok && !sameRunIdentity(run, summaryRun.value)) issues.push("$.join_summary.run_identity does not match $.run_identity");
    if (isStateRecord(state.join_summary.work_identity)) validateIdentityBinding(state.join_summary.work_identity, "$.join_summary.work_identity");
  }
  if (Array.isArray(state.typed_checkpoint_decisions)) {
    state.typed_checkpoint_decisions.forEach((decision, index) => {
      if (!isStateRecord(decision)) return;
      if (decision.run_id !== run.run_id) issues.push(`$.typed_checkpoint_decisions[${index}].run_id does not match $.run_identity.run_id`);
      const decisionRun = validateWorkflowRunIdentity(decision.run_identity);
      if (decisionRun.ok && !sameRunIdentity(run, decisionRun.value)) issues.push(`$.typed_checkpoint_decisions[${index}].run_identity does not match $.run_identity`);
    });
  }
  if (Array.isArray(state.checkpoint_decisions)) {
    state.checkpoint_decisions.forEach((decision, index) => {
      if (!isStateRecord(decision)) return;
      if (decision.run_id !== undefined && decision.run_id !== run.run_id) issues.push(`$.checkpoint_decisions[${index}].run_id does not match $.run_identity.run_id`);
      if (decision.run_identity !== undefined) {
        const decisionRun = validateWorkflowRunIdentity(decision.run_identity);
        if (decisionRun.ok && !sameRunIdentity(run, decisionRun.value)) issues.push(`$.checkpoint_decisions[${index}].run_identity does not match $.run_identity`);
      }
      if (decision.work_identity !== undefined) validateIdentityBinding(decision.work_identity, `$.checkpoint_decisions[${index}].work_identity`);
    });
  }
  if (Array.isArray(state.trusted_checkpoint_answers)) {
    state.trusted_checkpoint_answers.forEach((answer, index) => {
      if (isStateRecord(answer) && answer.run_id !== run.run_id) issues.push(`$.trusted_checkpoint_answers[${index}].run_id does not match $.run_identity.run_id`);
    });
  }
  if (isStateRecord(state.roster_selection)) {
    if (state.roster_selection.session_id !== run.session.session_id) issues.push("$.roster_selection.session_id does not match $.run_identity.session.session_id");
    if (workflow && state.roster_selection.workflow !== workflow) issues.push("$.roster_selection.workflow does not match $.workflow");
    if (classificationWorkflow && state.roster_selection.workflow !== classificationWorkflow) issues.push("$.roster_selection.workflow does not match $.classification.workflow");
    if (stageCursor && state.roster_selection.stage_id !== stageCursor) issues.push("$.roster_selection.stage_id does not match $.stage_cursor");
  }
  if (isStateRecord(state.dispatch_capability)) {
    const capabilityRun = validateWorkflowRunIdentity(state.dispatch_capability.run_identity);
    if (capabilityRun.ok && !sameRunIdentity(run, capabilityRun.value)) issues.push("$.dispatch_capability.run_identity does not match $.run_identity");
    const issued = isStateRecord(state.dispatch_capability.issued_for) ? state.dispatch_capability.issued_for : null;
    const issuedRun = issued ? validateWorkflowRunIdentity(issued.run_identity) : null;
    if (issuedRun?.ok && !sameRunIdentity(run, issuedRun.value)) issues.push("$.dispatch_capability.issued_for.run_identity does not match $.run_identity");
    if (isStateRecord(state.work_identity) && isStateRecord(state.dispatch_capability.work_identity) && !sameWorkIdentity(state.work_identity as unknown as WorkIdentity, state.dispatch_capability.work_identity as unknown as WorkIdentity)) {
      issues.push("$.dispatch_capability.work_identity does not match $.work_identity");
    }
    if (isStateRecord(state.dispatch_capability.work_identity)) validateIdentityBinding(state.dispatch_capability.work_identity, "$.dispatch_capability.work_identity", true);
    if (Array.isArray(state.dispatch_capability.pending)) {
      state.dispatch_capability.pending.forEach((pending, index) => {
        if (!isStateRecord(pending)) return;
        const pendingRun = validateWorkflowRunIdentity(pending.run_identity);
        if (pendingRun.ok && !sameRunIdentity(run, pendingRun.value)) issues.push(`$.dispatch_capability.pending[${index}].run_identity does not match $.run_identity`);
        validateIdentityBinding(pending.identity, `$.dispatch_capability.pending[${index}].identity`);
      });
    }
    if (Array.isArray(state.dispatch_capability.dispatches)) {
      state.dispatch_capability.dispatches.forEach((record, index) => {
        if (!isStateRecord(record)) return;
        const recordRun = validateWorkflowRunIdentity(record.run_identity);
        if (recordRun.ok && !sameRunIdentity(run, recordRun.value)) issues.push(`$.dispatch_capability.dispatches[${index}].run_identity does not match $.run_identity`);
        validateIdentityBinding(record.work_identity, `$.dispatch_capability.dispatches[${index}].work_identity`);
        if (isStateRecord(record.pending)) {
          const pendingRun = validateWorkflowRunIdentity(record.pending.run_identity);
          if (pendingRun.ok && !sameRunIdentity(run, pendingRun.value)) issues.push(`$.dispatch_capability.dispatches[${index}].pending.run_identity does not match $.run_identity`);
          if (isStateRecord(record.work_identity) && isStateRecord(record.pending.identity) && !sameWorkIdentity(record.work_identity as unknown as WorkIdentity, record.pending.identity as unknown as WorkIdentity)) {
            issues.push(`$.dispatch_capability.dispatches[${index}].pending.identity does not match dispatch work_identity`);
          }
        }
        if (isStateRecord(record.completion)) {
          const completionRun = validateWorkflowRunIdentity(record.completion.run_identity);
          if (completionRun.ok && !sameRunIdentity(run, completionRun.value)) issues.push(`$.dispatch_capability.dispatches[${index}].completion.run_identity does not match $.run_identity`);
          if (isStateRecord(record.work_identity) && isStateRecord(record.completion.work_identity) && !sameWorkIdentity(record.work_identity as unknown as WorkIdentity, record.completion.work_identity as unknown as WorkIdentity)) {
            issues.push(`$.dispatch_capability.dispatches[${index}].completion.work_identity does not match dispatch work_identity`);
          }
        }
        if (isStateRecord(record.completion_envelope)) {
          const envelopeRun = validateWorkflowRunIdentity(record.completion_envelope.run_identity);
          if (envelopeRun.ok && !sameRunIdentity(run, envelopeRun.value)) issues.push(`$.dispatch_capability.dispatches[${index}].completion_envelope.run_identity does not match $.run_identity`);
          if (isStateRecord(record.work_identity) && isStateRecord(record.completion_envelope.identity) && !sameWorkIdentity(record.work_identity as unknown as WorkIdentity, record.completion_envelope.identity as unknown as WorkIdentity)) {
            issues.push(`$.dispatch_capability.dispatches[${index}].completion_envelope.identity does not match dispatch work_identity`);
          }
        }
      });
    }
  }
}

function validateTypedStateFields(state: StateRecord): string[] {
  const issues: string[] = [];
  for (const retired of ["identity", "profile_identity"]) {
    if (Object.prototype.hasOwnProperty.call(state, retired)) issues.push(`$.${retired} is retired; persist project_identity and run_identity instead`);
  }
  if (!Object.prototype.hasOwnProperty.call(state, "project_identity")) {
    issues.push("$.project_identity is required for an active v2 lifecycle");
  }
  if (!Object.prototype.hasOwnProperty.call(state, "run_identity")) {
    issues.push("$.run_identity is required for an active v2 lifecycle");
  }
  const project = validateProjectIdentity(state.project_identity);
  if (!project.ok) issues.push(...project.diagnostics.map((diagnostic) => `$.project_identity ${diagnostic.code}`));
  const run = validateWorkflowRunIdentity(state.run_identity);
  if (!run.ok) issues.push(...run.diagnostics.map((diagnostic) => `$.run_identity ${diagnostic.code}`));
  if (project.ok && run.ok && !sameProjectIdentity(project.value, run.value)) {
    issues.push("$.run_identity project pins do not match $.project_identity");
  }
  for (const key of ["workflow", "stage_cursor", "cursor_epoch"]) {
    if (!nonEmptyStateString(state[key])) issues.push(`$.${key} must be a non-empty string`);
  }
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
  if (Object.prototype.hasOwnProperty.call(state, "dispatch_capability")) {
    if (state.dispatch_capability === undefined) issues.push("$.dispatch_capability must not be undefined");
    else validateStateCapability(state.dispatch_capability, "$.dispatch_capability", issues);
  }
  if (Object.prototype.hasOwnProperty.call(state, "retired_capabilities")) {
    validateStateRetiredCapabilities(state.retired_capabilities, "$.retired_capabilities", issues);
  }
  const classification = isStateRecord(state.classification) ? state.classification : null;
  if (classification) {
    const classificationFields: StateRecord = {};
    for (const key of ["completion_intent", "checkpoint_policy"]) if (Object.prototype.hasOwnProperty.call(classification, key)) classificationFields[key] = classification[key];
    const classificationValidation = validateProfileControlPlane(classificationFields);
    if (!classificationValidation.ok) issues.push(...classificationValidation.issues.map((entry) => `classification${entry.slice(1)}`));
  }
  if (
    Object.prototype.hasOwnProperty.call(state, "completion_intent")
    && classification
    && Object.prototype.hasOwnProperty.call(classification, "completion_intent")
  ) {
    const rootCompletionValidation = validateProfileControlPlane({
      completion_intent: state.completion_intent,
    });
    const classificationCompletionValidation = validateProfileControlPlane({
      completion_intent: classification.completion_intent,
    });
    if (
      rootCompletionValidation.ok
      && classificationCompletionValidation.ok
      && stableStateHash(state.completion_intent) !== stableStateHash(classification.completion_intent)
    ) {
      issues.push("classification.completion_intent conflicts with completion_intent");
    }
  }
  validateStateIdentityCoherence(state, issues);
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
const MAX_RETIRED_CAPABILITIES = 128;

function clonedStateValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function lifecycleDiagnostic(
  code: "IDENTITY_MISMATCH" | "MIGRATION_REQUIRED",
  operation: "runtime.activate" | "binding.write",
  field: string,
  remediation: string,
): WorkflowLifecycleError {
  return new WorkflowLifecycleError(createDiagnostic({
    code,
    operation,
    severity: "error",
    evidence: { field },
    remediation,
  }));
}

/**
 * Append an immutable retirement record. Duplicate capability id/epoch
 * replays are accepted only when the complete archived entry is equivalent.
 */
export function appendRetiredCapability(state: TeamState, entry: RetiredCapability): TeamState {
  const history = state.retired_capabilities ?? [];
  if (!Array.isArray(history)) {
    throw lifecycleDiagnostic("MIGRATION_REQUIRED", "binding.write", "retired_capabilities", "Migrate the retired capability ledger to the strict bounded array shape.");
  }
  const key = `${entry.capability_id}:${entry.capability_epoch}`;
  const existing = history.find((candidate) => `${candidate.capability_id}:${candidate.capability_epoch}` === key);
  if (existing) {
    if (stableStateHash(existing) !== stableStateHash(entry)) {
      throw lifecycleDiagnostic("MIGRATION_REQUIRED", "binding.write", "retired_capabilities", "Archive the conflicting capability history before retrying the lifecycle transition.");
    }
    return state;
  }
  if (history.length >= MAX_RETIRED_CAPABILITIES) {
    throw lifecycleDiagnostic("MIGRATION_REQUIRED", "binding.write", "retired_capabilities", "Archive or migrate the retired capability ledger before issuing another capability; the per-run limit is 128.");
  }
  return {
    ...state,
    retired_capabilities: [...history, clonedStateValue(entry)],
  };
}

/** Remove all current capability-bound fields without creating own undefined keys. */
export function clearCurrentIdentityFields(state: TeamState): TeamState {
  const cleared: StateRecord = { ...state };
  for (const key of ["dispatch_capability", "work_identity", "pending", "completion_envelope", "child_join", "join_summary", "roster_selection"]) {
    delete cleared[key];
  }
  return cleared as unknown as TeamState;
}

/**
 * Retire the currently armed capability and clear all current authority. An
 * unarmed state with no current work identity is already reset; a work
 * identity without its capability is unrecoverable and fails closed.
 */
export function retireCurrentCapability(state: TeamState, reason: string): TeamState {
  const hasCapability = Object.prototype.hasOwnProperty.call(state, "dispatch_capability");
  const hasWorkIdentity = Object.prototype.hasOwnProperty.call(state, "work_identity");
  if (!hasCapability) {
    if (hasWorkIdentity || Object.prototype.hasOwnProperty.call(state, "pending") || Object.prototype.hasOwnProperty.call(state, "completion_envelope")) {
      throw lifecycleDiagnostic("MIGRATION_REQUIRED", "runtime.activate", "dispatch_capability", "The current work identity has no capability snapshot to retire; migrate or recreate the workflow before rotating it.");
    }
    return clearCurrentIdentityFields(state);
  }
  if (state.dispatch_capability === undefined || !isStateRecord(state.dispatch_capability)) {
    throw lifecycleDiagnostic("MIGRATION_REQUIRED", "runtime.activate", "dispatch_capability", "The current dispatch capability is malformed and cannot be retired safely.");
  }
  const capabilityIssues: string[] = [];
  validateStateCapability(state.dispatch_capability, "$.dispatch_capability", capabilityIssues);
  if (capabilityIssues.length > 0) {
    throw lifecycleDiagnostic("MIGRATION_REQUIRED", "runtime.activate", "dispatch_capability", "The current dispatch capability is malformed and cannot be retired safely.");
  }
  if (!isStateRecord(state.work_identity)) {
    throw lifecycleDiagnostic("MIGRATION_REQUIRED", "runtime.activate", "work_identity", "The current capability has no complete top-level work identity to archive.");
  }
  const identityIssues: string[] = [];
  validateStateIdentity(state.work_identity, "$.work_identity", identityIssues);
  if (identityIssues.length > 0) {
    throw lifecycleDiagnostic("MIGRATION_REQUIRED", "runtime.activate", "work_identity", "The current capability has no complete top-level work identity to archive.");
  }
  const capability = state.dispatch_capability as unknown as DispatchCapabilityState;
  const identity = state.work_identity as unknown as WorkIdentity;
  if (!isStateRecord(capability.work_identity) || !sameWorkIdentity(identity, capability.work_identity as unknown as WorkIdentity)) {
    throw lifecycleDiagnostic("IDENTITY_MISMATCH", "runtime.activate", "work_identity", "The top-level and capability work identities must match before retirement.");
  }
  const run = validateWorkflowRunIdentity(state.run_identity);
  const capabilityRun = validateWorkflowRunIdentity(capability.run_identity);
  if (!run.ok || !capabilityRun.ok || !sameRunIdentity(run.value, capabilityRun.value) || identity.run_id !== run.value.run_id) {
    throw lifecycleDiagnostic("IDENTITY_MISMATCH", "runtime.activate", "run_identity", "The current capability and work identity must belong to the active workflow run before retirement.");
  }
  const completion = Object.prototype.hasOwnProperty.call(state, "completion_envelope")
    ? state.completion_envelope
    : null;
  if (completion !== null && completion !== undefined) {
    const completionIssues: string[] = [];
    validateStateCompletion(completion, "$.completion_envelope", completionIssues);
    if (completionIssues.length > 0) {
      throw lifecycleDiagnostic("MIGRATION_REQUIRED", "runtime.activate", "completion_envelope", "The current completion envelope is malformed and cannot be archived safely.");
    }
    const completionRecord = isStateRecord(completion) ? completion : null;
    if (completionRecord === null) {
      throw lifecycleDiagnostic("MIGRATION_REQUIRED", "runtime.activate", "completion_envelope", "The current completion envelope is malformed and cannot be archived safely.");
    }
    const completionRun = validateWorkflowRunIdentity(completionRecord.run_identity);
    if (
      !completionRun.ok
      || !sameRunIdentity(run.value, completionRun.value)
      || !isStateRecord(completionRecord.identity)
      || !sameWorkIdentity(identity, completionRecord.identity as unknown as WorkIdentity)
      || completionRecord.outcome === "pending"
    ) {
      throw lifecycleDiagnostic("IDENTITY_MISMATCH", "runtime.activate", "completion_envelope", "The current completion envelope must be a terminal envelope for the active work identity before retirement.");
    }
  }
  const entry: RetiredCapability = {
    capability_id: capability.capability_id,
    capability_epoch: capability.work_identity.capability_epoch,
    run_identity: clonedStateValue(run.value),
    work_identity: clonedStateValue(identity),
    dispatch_capability: clonedStateValue(capability),
    completion_outcome: completion && isStateRecord(completion) ? completion.outcome as RetiredCapability["completion_outcome"] : null,
    completion_envelope: completion && isStateRecord(completion) ? clonedStateValue(completion) : null,
    reason: reason.trim(),
    retired_at: new Date().toISOString(),
  };
  if (!entry.reason) {
    throw lifecycleDiagnostic("MIGRATION_REQUIRED", "runtime.activate", "retired_capabilities.reason", "Retirements require a non-empty reason.");
  }
  const appended = appendRetiredCapability(state, entry);
  return {
    ...clearCurrentIdentityFields(appended),
    cursor_epoch: randomUUID(),
  };
}

/**
 * Remove target/downstream roster and slot bindings while preserving upstream
 * artifacts and all checkpoint/audit ledgers.
 */
export function clearStageBindings(state: TeamState, clearedStageIds: ReadonlySet<string>): TeamState {
  const cleared = clearCurrentIdentityFields(state) as unknown as StateRecord;
  const selections = state.roster_selections;
  if (selections) {
    const retainedSelections = Object.fromEntries(Object.entries(selections).filter(([stageId]) => !clearedStageIds.has(stageId)));
    if (Object.keys(retainedSelections).length > 0) cleared.roster_selections = retainedSelections;
    else delete cleared.roster_selections;
  }
  const slotArtifacts = state.slot_artifacts;
  if (slotArtifacts) {
    const retainedSlotArtifacts = Object.fromEntries(Object.entries(slotArtifacts).filter(([stageId]) => !clearedStageIds.has(stageId)));
    if (Object.keys(retainedSlotArtifacts).length > 0) cleared.slot_artifacts = retainedSlotArtifacts;
    else delete cleared.slot_artifacts;
  }
  return cleared as unknown as TeamState;
}


export function normalizePersistedState(raw: unknown, rejectionIssues?: string[]): TeamState | null {
  if (!isStateRecord(raw)) return null;
  const state: StateRecord = { ...raw };
  const rawClassification = state.classification;
  const classification = isStateRecord(rawClassification) ? { ...rawClassification } : null;
  const legacyWorkflow = nonEmptyStateString(state.workflow) ? state.workflow : null;

  /*
   * Structural normalization is intentionally limited to fields that describe
   * the old cursor shape. It does not resolve a profile, project policy, or
   * identity from process-global/filesystem state. Such records remain
   * migration input and are never eligible for a v2 resume.
   */
  const hasLegacyCursor = Array.isArray(state.pending_stages) || typeof state.status === "string";
  const hasDurableCursor = Array.isArray(state.stages) && typeof state.stage_cursor === "string";
  if (classification && legacyWorkflow && hasLegacyCursor && !hasDurableCursor) {
    state.schema = 1;
    if (!nonEmptyStateString(state.run_key)) delete state.run_key;
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

  const initialIssues = validateTypedStateFields(state);
  if (initialIssues.length > 0) {
    rejectionIssues?.push(...initialIssues);
    return null;
  }

  /*
   * An armed dispatch capability is itself a durable authorization boundary.
   * Its work identity and top-level work identity must both be complete and
   * exactly synchronized. Never repair either side from the other.
   */
  const rawCapability = state.dispatch_capability;
  if (rawCapability !== undefined) {
    if (!isStateRecord(rawCapability)) {
      rejectionIssues?.push("$.dispatch_capability must be an object when present");
      return null;
    }
    const capabilityIdentity = rawCapability.work_identity;
    if (!Object.prototype.hasOwnProperty.call(rawCapability, "work_identity") || capabilityIdentity === undefined) {
      rejectionIssues?.push("$.dispatch_capability.work_identity is required for an armed capability");
      return null;
    }
    const capabilityIdentityIssues: string[] = [];
    validateStateIdentity(capabilityIdentity, "$.dispatch_capability.work_identity", capabilityIdentityIssues);
    if (capabilityIdentityIssues.length > 0) {
      rejectionIssues?.push(...capabilityIdentityIssues);
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(state, "work_identity") || state.work_identity === undefined) {
      rejectionIssues?.push("$.work_identity is required when dispatch_capability is present");
      return null;
    }
    if (stableStateHash(state.work_identity) !== stableStateHash(capabilityIdentity)) {
      rejectionIssues?.push("$.work_identity conflicts with dispatch_capability.work_identity");
      return null;
    }
  }

  if (isStateRecord(state.dispatch_capability)) {
    const capability = state.dispatch_capability;
    const capabilityRun = capability.run_identity;
    if (capabilityRun !== undefined) {
      const checkedCapabilityRun = validateWorkflowRunIdentity(capabilityRun);
      if (!checkedCapabilityRun.ok) {
        rejectionIssues?.push("$.dispatch_capability.run_identity is malformed");
        return null;
      }
      const stateRun = state.run_identity;
      if (stateRun !== undefined) {
        const checkedStateRun = validateWorkflowRunIdentity(stateRun);
        if (!checkedStateRun.ok || !sameRunIdentity(checkedStateRun.value, checkedCapabilityRun.value)) {
          rejectionIssues?.push("$.run_identity conflicts with dispatch_capability.run_identity");
          return null;
        }
      }
    }
  }

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

  const finalIssues = validateTypedStateFields(state);
  if (finalIssues.length > 0) {
    rejectionIssues?.push(...finalIssues);
    return null;
  }
  return state as unknown as TeamState;
}



export interface ResolvedState {
  state: TeamState | null;
  statePath: string | null;
  stateDir: string | null;
  artifactsDir: string | null;
  isLegacy: boolean;
  isStale: boolean;
  invalid?: boolean;
  /** Typed reason when a persisted state is not eligible for runtime use. */
  diagnostics?: readonly WorkflowV2Diagnostic[];
}

function resolutionDiagnostic(
  code: "MIGRATION_REQUIRED" | "IDENTITY_MISMATCH" | "UNSAFE_PATH",
  statePath: string | null,
  evidence: Record<string, unknown>,
): WorkflowV2Diagnostic {
  return createDiagnostic({
    code,
    operation: "runtime.activate",
    evidence: { ...(statePath ? { path: statePath } : {}), ...evidence },
    remediation: code === "IDENTITY_MISMATCH"
      ? "Start a fresh workflow lifecycle for the current root, provider, catalog, config, profile, and session identity."
      : "Migrate the persisted state explicitly before attempting to resume it.",
  });
}

function invalidResolution(
  statePath: string | null,
  stateDir: string | null,
  artifactsDir: string | null,
  code: "MIGRATION_REQUIRED" | "IDENTITY_MISMATCH" | "UNSAFE_PATH",
  evidence: Record<string, unknown> = {},
  state: TeamState | null = null,
): ResolvedState {
  return {
    state,
    statePath,
    stateDir,
    artifactsDir,
    isLegacy: false,
    isStale: false,
    invalid: true,
    diagnostics: [resolutionDiagnostic(code, statePath, evidence)],
  };
}

export type StateSelector = { kind?: "auto" | "team" | "cto-slice"; runId?: string; sliceId?: string; capabilityId?: string };
export interface ResolvedActiveRun extends ResolvedState {
  kind: "feature" | "cto-slice";
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

/** Resolve the one authoritative persisted run. Explicit CTO selectors fail closed. */
export function resolveCanonicalRun(
  cwd: string,
  expectedRunIdentity: WorkflowRunIdentity,
  selector: StateSelector = {},
  currentBranch?: string,
): ResolvedActiveRun | null {
  const identity = validateWorkflowRunIdentity(expectedRunIdentity);
  if (!identity.ok) {
    throw new WorkflowLifecycleError(identity.diagnostics[0] ?? createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "runtime.activate",
      severity: "error",
      evidence: { field: "expected_run_identity" },
      remediation: "Provide a complete prepared workflow run identity before resolving a canonical run.",
    }));
  }
  const runIdentity = identity.value;
  const branch = currentBranch;
  if (selector.kind === "cto-slice" || selector.runId || selector.sliceId) {
    if (!selector.runId || !selector.sliceId) throw new Error("cto-slice selector requires runId and sliceId");
    const runId = selector.runId;
    const sliceId = selector.sliceId;
    const cto = readCtoState(runId, cwd, runIdentity);
    if (!cto) throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      severity: "error",
      evidence: { run_id: runId },
      remediation: "Migrate or recreate the CTO run with a complete prepared run identity.",
    }));
    if (!cto.run_identity) throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      severity: "error",
      evidence: { run_id: runId, field: "run_identity" },
      remediation: "Migrate or recreate the CTO run with a complete prepared run identity.",
    }));
    const wave = activeWave(cto);
    if (!wave) throw new Error(`CTO run '${runId}' has no active wave`);
    const matches = cto.teams.filter((team) => team.slice_id === sliceId);
    if (matches.length !== 1) throw new Error(`CTO slice '${sliceId}' must map to exactly one active team`);
    const team = matches[0]!;
    const teamRecord = team as unknown as Record<string, unknown>;
    const execution = teamRecord.execution;
    if (!execution || typeof execution !== "object") {
      throw new WorkflowLifecycleError(createDiagnostic({
        code: "MIGRATION_REQUIRED",
        operation: "runtime.activate",
        severity: "error",
        evidence: { run_id: runId, slice_id: sliceId, field: "execution" },
        remediation: "Migrate the CTO slice with a canonical shared execution capability.",
      }));
    }
    const executionRecord = execution as Record<string, unknown>;
    const runKey = typeof executionRecord.run_key === "string" && executionRecord.run_key.trim() ? executionRecord.run_key : null;
    const workflow = typeof team.workflow === "string" && team.workflow.trim() ? team.workflow : null;
    const profileHash = typeof executionRecord.profile_hash === "string" && executionRecord.profile_hash.trim() ? executionRecord.profile_hash : null;
    const stageCursor = typeof executionRecord.stage_cursor === "string" && executionRecord.stage_cursor.trim() ? executionRecord.stage_cursor : null;
    const cursorEpoch = typeof executionRecord.cursor_epoch === "string" && executionRecord.cursor_epoch.trim() ? executionRecord.cursor_epoch : null;
    if (!runKey || !workflow || !profileHash || !stageCursor || !cursorEpoch) {
      throw new WorkflowLifecycleError(createDiagnostic({
        code: "MIGRATION_REQUIRED",
        operation: "runtime.activate",
        severity: "error",
        evidence: { run_id: runId, slice_id: sliceId, field: "execution" },
        remediation: "Migrate the CTO slice with canonical run, workflow, profile, stage, and cursor bindings.",
      }));
    }
    const staleReason = branch && cto.branch !== branch ? `branch mismatch: persisted '${cto.branch}', current '${branch}'` : null;
    return {
      state: null,
      statePath: join(cwd, WORK_STATE_DIR, "cto", cto.id, "state.json"),
      stateDir: join(cwd, WORK_STATE_DIR, "cto", cto.id),
      artifactsDir: join(cwd, WORK_STATE_DIR, "cto", cto.id, "artifacts"),
      isLegacy: false,
      isStale: Boolean(staleReason),
      kind: "cto-slice",
      runKey,
      branch: cto.branch,
      workflow,
      profileHash,
      stageCursor,
      cursorEpoch,
      dispatch: execution,
      staleReason,
      selectedTeam: team,
    };
  }
  const resolved = resolveState(cwd, branch, runIdentity);
  if (resolved.invalid) {
    const code = resolved.diagnostics?.[0]?.code ?? "MIGRATION_REQUIRED";
    const diagnostic = resolved.diagnostics?.[0] ?? createDiagnostic({
      code,
      operation: "runtime.activate",
      severity: "error",
      evidence: { field: "state" },
      remediation: "Migrate or recreate the persisted state before runtime activation.",
    });
    throw new WorkflowLifecycleError(diagnostic);
  }
  if (!resolved.state || !resolved.statePath) return null;
  const state = resolved.state;
  if (!state.project_identity || !state.run_identity || !state.run_key || !state.profile_hash || !state.cursor_epoch || !state.classification?.workflow) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      severity: "error",
      evidence: { field: "project_identity_or_run_binding" },
      remediation: "Persist complete project and run identities, run key, workflow, profile fingerprint, and cursor epoch before activation.",
    }));
  }
  return {
    ...resolved,
    kind: "feature",
    runKey: state.run_key,
    branch: state.branch,
    workflow: state.classification.workflow,
    profileHash: state.profile_hash,
    stageCursor: state.stage_cursor,
    cursorEpoch: state.cursor_epoch,
    dispatch: state.dispatch_capability ?? null,
    staleReason: resolved.isStale ? `branch mismatch: persisted '${state.branch}', current '${branch ?? "unknown"}'` : null,
  };
}

export function resolveState(
  cwd: string,
  currentBranch?: string,
  expectedRunIdentity?: WorkflowRunIdentity,
): ResolvedState {
  const checkedExpected = expectedRunIdentity === undefined
    ? null
    : validateWorkflowRunIdentity(expectedRunIdentity);
  if (checkedExpected && !checkedExpected.ok) {
    return invalidResolution(null, null, null, "IDENTITY_MISMATCH", { field: "expected_run_identity" });
  }
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  if (!existsSync(wsDir)) {
    return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false };
  }
  try {
    if (!isWithin(realpathSync(cwd), realpathSync(wsDir))) {
      return invalidResolution(null, null, null, "UNSAFE_PATH", { field: "work_state" });
    }
  } catch {
    return invalidResolution(wsDir, wsDir, null, "UNSAFE_PATH", { field: "work_state" });
  }

  const activeFile = join(wsDir, ACTIVE_FEATURE);
  if (existsSync(activeFile)) {
    const slug = readFileSync(activeFile, "utf8").trim();
    if (!isSafeStateSegment(slug)) {
      return invalidResolution(activeFile, null, null, "UNSAFE_PATH", { field: "active_feature" });
    }
    const featuresDir = join(wsDir, "features");
    const featureDir = join(featuresDir, slug);
    const statePath = join(featureDir, "state.json");
    const artifactsPath = join(featureDir, "artifacts");
    if (!existsSync(featuresDir)) {
      return { state: null, statePath: null, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: false };
    }
    try {
      const realWorkState = realpathSync(wsDir);
      const realFeatures = realpathSync(featuresDir);
      if (
        !isWithin(realpathSync(cwd), realWorkState)
        || !isWithin(realWorkState, realFeatures)
        || (existsSync(featureDir) && !isWithin(realFeatures, realpathSync(featureDir)))
      ) {
        return invalidResolution(statePath, featureDir, artifactsPath, "UNSAFE_PATH", { field: "feature" });
      }
    } catch {
      return invalidResolution(statePath, featureDir, artifactsPath, "UNSAFE_PATH", { field: "feature" });
    }
    if (!existsSync(statePath)) {
      return { state: null, statePath: null, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: false };
    }
    try {
      const realFeature = realpathSync(featureDir);
      if (!isWithin(realFeature, realpathSync(statePath))) {
        return invalidResolution(statePath, featureDir, artifactsPath, "UNSAFE_PATH", { field: "state" });
      }
      if (existsSync(artifactsPath) && !isWithin(realFeature, realpathSync(artifactsPath))) {
        return invalidResolution(statePath, featureDir, artifactsPath, "UNSAFE_PATH", { field: "artifacts" });
      }
      const state = normalizePersistedState(JSON.parse(readFileSync(statePath, "utf8")));
      if (!state) {
        return invalidResolution(statePath, featureDir, artifactsPath, "MIGRATION_REQUIRED", { field: "state" });
      }
      const stale = currentBranch ? state.branch !== currentBranch : false;
      const stateRun = validateWorkflowRunIdentity(state.run_identity);
      const stateProject = validateProjectIdentity(state.project_identity);
      if (!stateRun.ok || !stateProject.ok) {
        return invalidResolution(statePath, featureDir, artifactsPath, "MIGRATION_REQUIRED", { field: "project_identity_or_run_identity" }, state);
      }
      if (!sameProjectIdentity(stateProject.value, stateRun.value)) {
        return invalidResolution(statePath, featureDir, artifactsPath, "IDENTITY_MISMATCH", { field: "project_identity" }, state);
      }
      if (checkedExpected && !sameRunIdentity(stateRun.value, checkedExpected.value)) {
        return invalidResolution(statePath, featureDir, artifactsPath, "IDENTITY_MISMATCH", { field: "run_identity" }, state);
      }
      if (!state.classification || typeof state.classification.workflow !== "string" || !state.classification.workflow) {
        return invalidResolution(statePath, featureDir, artifactsPath, "MIGRATION_REQUIRED", { field: "classification" }, state);
      }
      if (!nonEmptyStateString(state.workflow) || state.workflow !== state.classification.workflow) {
        return invalidResolution(statePath, featureDir, artifactsPath, "IDENTITY_MISMATCH", { field: "workflow" }, state);
      }
      return { state, statePath, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: stale };
    } catch {
      return invalidResolution(statePath, featureDir, artifactsPath, "MIGRATION_REQUIRED", { field: "state" });
    }
  }

  /*
   * The root `team-state.json` is a v1 migration input, never a runtime
   * fallback. Keep its location in the diagnostic so management can explain
   * what must be migrated without reading or rewriting it here.
   */
  const legacyPath = join(wsDir, LEGACY_STATE);
  if (existsSync(legacyPath)) {
    const rejected = invalidResolution(legacyPath, wsDir, join(wsDir, "artifacts"), "MIGRATION_REQUIRED", { field: "legacy_root_state" });
    return { ...rejected, isLegacy: true };
  }
  return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false };
}
export function writeState(
  cwd: string,
  state: TeamState,
  opts: { featureSlug?: string; target?: ResolvedState } = {},
): { statePath: string; artifactsDir: string } {
  const project = validateProjectIdentity(state.project_identity);
  const run = validateWorkflowRunIdentity(state.run_identity);
  if (!project.ok || !run.ok) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "binding.write",
      severity: "error",
      evidence: { field: !project.ok ? "project_identity" : "run_identity" },
      remediation: "Persist complete project and run identities before writing lifecycle state.",
    }));
  }
  if (!sameProjectIdentity(project.value, run.value)) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "binding.write",
      severity: "error",
      evidence: { field: "project_identity" },
      remediation: "Persist a run identity inherited from the same project identity.",
    }));
  }
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  mkdirSync(wsDir, { recursive: true });
  const realWorkState = realpathSync(wsDir);
  if (!isWithin(realpathSync(cwd), realWorkState)) throw new Error("UNSAFE_PATH: workflow state path escapes project root");
  const target = opts.target;
  if (target?.isLegacy) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "binding.write",
      severity: "error",
      evidence: { field: "legacy_root_state" },
      remediation: "Migrate legacy root state explicitly; it cannot be rewritten as v2 state.",
    }));
  }
  if (target?.invalid) throw new Error("MIGRATION_REQUIRED: cannot write through an invalid workflow state target");
  if (target && (!target.stateDir || !target.statePath || !target.artifactsDir)) throw new Error("MIGRATION_REQUIRED: workflow state target is incomplete");
  if (target) {
    const targetStateDir = realpathSync(target.stateDir!);
    if (!isWithinTree(realWorkState, targetStateDir)) throw new Error("UNSAFE_PATH: workflow state target escapes .work-state");
    if (existsSync(target.statePath!) && !isWithin(targetStateDir, realpathSync(target.statePath!))) {
      throw new Error("UNSAFE_PATH: workflow state target escapes its state directory");
    }
  }

  const featureSlug = target
    ? basename(target.stateDir!)
    : opts.featureSlug ?? deriveFeatureSlugFromBranch(state.branch);
  if (!featureSlug || !isSafeStateSegment(featureSlug)) throw new Error("MIGRATION_REQUIRED: workflow feature slug is required");
  let stateDir: string;
  let statePath: string;
  let artifactsDir: string;

  if (target) {
    stateDir = target.stateDir!;
    statePath = target.statePath!;
    artifactsDir = target.artifactsDir!;
  } else {
    stateDir = join(wsDir, "features", featureSlug);
    statePath = join(stateDir, "state.json");
    artifactsDir = join(stateDir, "artifacts");
  }
  const featuresDir = join(wsDir, "features");
  mkdirSync(featuresDir, { recursive: true });
  const realFeatures = realpathSync(featuresDir);
  if (!isWithin(realWorkState, realFeatures)) throw new Error("UNSAFE_PATH: workflow feature path escapes .work-state/features");
  mkdirSync(stateDir, { recursive: true });
  if (!isWithin(realFeatures, realpathSync(stateDir))) throw new Error("UNSAFE_PATH: workflow feature path escapes .work-state/features");

  const realStateDir = realpathSync(stateDir);
  if (!isWithinTree(realWorkState, realStateDir)) throw new Error("workflow state directory escapes .work-state");
  if (!isWithin(realStateDir, realpathSync(dirname(statePath)))) throw new Error("workflow state path escapes its state directory");
  if (!isWithin(realStateDir, realpathSync(dirname(artifactsDir)))) throw new Error("workflow artifacts path escapes its state directory");
  mkdirSync(artifactsDir, { recursive: true });
  if (!isWithin(realStateDir, realpathSync(artifactsDir))) throw new Error("workflow artifacts path escapes its state directory");

  const rejectionIssues: string[] = [];
  const normalized = normalizePersistedState(state, rejectionIssues);
  if (!normalized) throw new Error(`workflow state contains malformed or conflicting typed control-plane fields: ${rejectionIssues.join("; ") || "unrecognized shape"}`);
  assertRetiredHistoryAppendOnly(statePath, normalized);
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
  const index = state.stages.findIndex((stage) => stage.id === stageId);
  if (index < 0) throw new Error(`cannot reopen unknown stage: ${stageId}`);
  const history = [...(state.history ?? []), { task: state.task, feedback, at: new Date().toISOString() }];
  const stages = state.stages.map((stage, stageIndex) =>
    stageIndex >= index ? { ...stage, status: "pending" as const } : stage,
  );
  const reopened = {
    ...state,
    task: `${state.task}\n\nUser feedback: ${feedback}`,
    history,
    stages,
    stage_cursor: stageId,
    pause: { kind: "none" as const, reason: "" },
  };
  const retired = retireCurrentCapability(reopened, "reopen_from_feedback");
  const cleared = clearStageBindings(retired, new Set(stages.slice(index).map((stage) => stage.id)));
  return {
    ...cleared,
    stage_cursor: stageId,
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

function assertRetiredHistoryAppendOnly(statePath: string, state: TeamState): void {
  if (!existsSync(statePath)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    throw lifecycleDiagnostic("MIGRATION_REQUIRED", "binding.write", "retired_capabilities", "The existing workflow state cannot be read safely before appending retired capability history.");
  }
  if (!isStateRecord(raw) || !Object.prototype.hasOwnProperty.call(raw, "retired_capabilities")) return;
  const previous = raw.retired_capabilities;
  const next = state.retired_capabilities;
  if (!Array.isArray(previous) || !Array.isArray(next) || next.length < previous.length) {
    throw lifecycleDiagnostic("MIGRATION_REQUIRED", "binding.write", "retired_capabilities", "Retired capability history is append-only; archive or migrate the existing ledger before writing.");
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (stableStateHash(previous[index]) !== stableStateHash(next[index])) {
      throw lifecycleDiagnostic("MIGRATION_REQUIRED", "binding.write", "retired_capabilities", "Retired capability history is immutable; archive or migrate the conflicting ledger before writing.");
    }
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
