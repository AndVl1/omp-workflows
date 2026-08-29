/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveStageDispatchSlots, WorkflowStageIdentityError } from "./stage.js";
import { resolveState } from "./state.js";
import { loadProfileByIdentity } from "./profile.js";
import { artifactSchemaFor, type JsonSchemaDef } from "./artifact-contract.js";
import { sanitizeSlot } from "./fan-in.js";
import { createDiagnostic } from "../workflow-v2/diagnostics.js";
import { isProviderId, isWorkflowV2Digest, validateProjectIdentity, validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import type {
  AgentRef,
  EffectivePolicy,
  PolicySnapshot,
  ProjectIdentity,
  ProviderCatalog,
  WorkflowRunIdentity,
  WorkflowV2Diagnostic,
} from "../workflow-v2/types.js";
import type {
  CheckpointPolicy,
  CheckpointRule,
  CheckpointRuleKind,
  CheckpointDecision,
  TypedCheckpointDecision,
  ChildJoin,
  CompletionEnvelope,
  CompletionIntent,
  ControlPlaneFieldSource,
  ControlPlaneMigrationStatus,
  ControlPlaneProvenance,
  PendingState,
  RetiredCapability,
  RosterPolicy,
  RosterSelection,
  StageDef,
  DispatchSlot,
  StageStatus,
  TeamState,
  WorkIdentity,
  WorkflowContractStatus,
  WorkflowName,
} from "./types.js";

export interface TypedContractIssue {
  path: string;
  message: string;
}

export type TypedContractValidationResult =
  | { ok: true }
  | { ok: false; issues: TypedContractIssue[] };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addIssue(issues: TypedContractIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function unknownKeys(value: UnknownRecord, allowed: readonly string[], path: string, issues: TypedContractIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) addIssue(issues, `${path}.${key}`, "unknown field");
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => nonEmptyString(item));
}

function requireString(value: UnknownRecord, key: string, path: string, issues: TypedContractIssue[]): void {
  if (!nonEmptyString(value[key])) addIssue(issues, `${path}.${key}`, "must be a non-empty string");
}

function requireEnum(value: UnknownRecord, key: string, allowed: readonly string[], path: string, issues: TypedContractIssue[]): void {
  const candidate = value[key];
  if (typeof candidate !== "string" || !allowed.includes(candidate)) {
    addIssue(issues, `${path}.${key}`, `must be one of ${allowed.join(", ")}`);
  }
}

function requireInteger(value: UnknownRecord, key: string, path: string, issues: TypedContractIssue[], minimum = 0): void {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < minimum) {
    addIssue(issues, `${path}.${key}`, `must be an integer >= ${minimum}`);
  }
}

function stringArray(value: unknown, path: string, issues: TypedContractIssue[], required = true): string[] | null {
  if (value === undefined && !required) return null;
  if (!isNonEmptyStringArray(value)) {
    addIssue(issues, path, "must be an array of non-empty strings");
    return null;
  }
  const result = value;
  for (let index = 0; index < result.length; index += 1) {
    for (let previous = 0; previous < index; previous += 1) {
      if (result[previous] === result[index]) addIssue(issues, `${path}[${index}]`, "duplicate value");
    }
  }
  return result;
}

function safeRelativePath(value: unknown): boolean {
  return typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.includes("..") &&
    !value.includes("\\");
}

function validateCompletionIntent(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["mode", "acceptance", "source", "rationale"], path, issues);
  requireEnum(value, "mode", ["complete_outcome", "handoff_only"], path, issues);
  requireEnum(value, "acceptance", ["dod_and_artifacts", "explicit_human_acceptance"], path, issues);
  requireEnum(value, "source", ["user", "workflow_policy", "migration"], path, issues);
  requireString(value, "rationale", path, issues);
}

const CHECKPOINT_KINDS: readonly string[] = [
  "product_approval", "clarification", "architecture_choice", "implementation_approval",
  "review_fix", "regression_plan", "integration_acceptance", "security",
  "destructive_side_effect", "production", "bundle_activation", "migration_cutover", "custom",
];
const HARD_HUMAN_KINDS: readonly string[] = [
  "product_approval", "security", "destructive_side_effect", "production",
  "bundle_activation", "migration_cutover", "custom",
];

function validateCheckpointRule(
  value: unknown,
  path: string,
  issues: TypedContractIssue[],
  hardHuman: readonly string[],
  allowPendingDecisions = false,
): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["kind", "default", "allowed_decisions", "phase", "rationale"], path, issues);
  requireEnum(value, "kind", CHECKPOINT_KINDS, path, issues);
  requireEnum(value, "default", ["required_human", "autonomous_allowed"], path, issues);
  const decisions = stringArray(value.allowed_decisions, `${path}.allowed_decisions`, issues);
  // Migration-generated rules may legitimately carry no decisions yet;
  // unresolved consent remains human-required until typed decisions exist.
  if (decisions && decisions.length === 0 && !allowPendingDecisions) {
    addIssue(issues, `${path}.allowed_decisions`, "must not be empty for a typed rule");
  }
  requireEnum(value, "phase", ["before_dispatch", "before_advance"], path, issues);
  requireString(value, "rationale", path, issues);
  if (value.default === "autonomous_allowed" && typeof value.kind === "string" && hardHuman.includes(value.kind)) {
    addIssue(issues, path, "hard-human rule cannot allow autonomous decisions");
  }
}

function validateCheckpointPolicy(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["default", "scope", "hard_human", "rules", "source", "policy_version", "rationale"], path, issues);
  requireEnum(value, "default", ["required_human", "autonomous_allowed"], path, issues);
  requireEnum(value, "scope", ["decision"], path, issues);
  const hardHuman = stringArray(value.hard_human, `${path}.hard_human`, issues);
  if (hardHuman) {
    for (let index = 0; index < hardHuman.length; index += 1) {
      if (!HARD_HUMAN_KINDS.includes(hardHuman[index]!)) addIssue(issues, `${path}.hard_human[${index}]`, "unknown hard-human class");
    }
  }
  if (!isRecord(value.rules)) {
    addIssue(issues, `${path}.rules`, "must be an object");
  } else {
    for (const [checkpointId, rule] of Object.entries(value.rules)) {
      if (!nonEmptyString(checkpointId)) addIssue(issues, `${path}.rules`, "checkpoint ids must be non-empty");
      validateCheckpointRule(rule, `${path}.rules.${checkpointId}`, issues, hardHuman ?? [], value.source === "migration");
    }
  }
  requireEnum(value, "source", ["profile", "user", "migration"], path, issues);
  requireInteger(value, "policy_version", path, issues, 1);
  requireString(value, "rationale", path, issues);
}

function validateRosterPolicy(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, [
    "allowed_roles", "required_roles", "required_facets", "min_workers", "max_workers",
    "multiplicity", "prefer_distinct_agents", "selection_mode", "triggers", "budget",
  ], path, issues);
  const allowed = stringArray(value.allowed_roles, `${path}.allowed_roles`, issues);
  if (allowed && allowed.length === 0) addIssue(issues, `${path}.allowed_roles`, "must not be empty for a typed dispatch policy");
  const requiredRoles = stringArray(value.required_roles, `${path}.required_roles`, issues);
  stringArray(value.required_facets, `${path}.required_facets`, issues);
  requireInteger(value, "min_workers", path, issues);
  requireInteger(value, "max_workers", path, issues);
  if (typeof value.min_workers === "number" && typeof value.max_workers === "number" && value.min_workers > value.max_workers) {
    addIssue(issues, path, "min_workers must not exceed max_workers");
  }
  if (!isRecord(value.multiplicity)) {
    addIssue(issues, `${path}.multiplicity`, "must be an object");
  } else {
    let minimumTotal = 0;
    for (const [role, bound] of Object.entries(value.multiplicity)) {
      if (allowed && !allowed.includes(role)) addIssue(issues, `${path}.multiplicity.${role}`, "role is outside allowed_roles");
      if (!isRecord(bound)) {
        addIssue(issues, `${path}.multiplicity.${role}`, "must be an object");
        continue;
      }
      unknownKeys(bound, ["min", "max"], `${path}.multiplicity.${role}`, issues);
      requireInteger(bound, "min", `${path}.multiplicity.${role}`, issues);
      requireInteger(bound, "max", `${path}.multiplicity.${role}`, issues);
      if (typeof bound.min === "number") minimumTotal += bound.min;
      if (typeof bound.min === "number" && typeof bound.max === "number" && bound.min > bound.max) {
        addIssue(issues, `${path}.multiplicity.${role}`, "min must not exceed max");
      }
    }
    if (typeof value.max_workers === "number" && minimumTotal > value.max_workers) {
      addIssue(issues, `${path}.multiplicity`, "sum of role minima exceeds max_workers");
    }
  }
  if (allowed && requiredRoles) {
    for (const role of requiredRoles) {
      if (!allowed.includes(role)) addIssue(issues, `${path}.required_roles`, "required role is outside allowed_roles");
    }
  }
  if (typeof value.prefer_distinct_agents !== "boolean") addIssue(issues, `${path}.prefer_distinct_agents`, "must be boolean");
  requireEnum(value, "selection_mode", ["pre_dispatch_minimum_valid"], path, issues);
  if (!isRecord(value.triggers)) {
    addIssue(issues, `${path}.triggers`, "must be an object");
  } else {
    unknownKeys(value.triggers, ["complexity", "confidence", "scope_flags", "evidence"], `${path}.triggers`, issues);
    const complexity = stringArray(value.triggers.complexity, `${path}.triggers.complexity`, issues);
    const confidence = stringArray(value.triggers.confidence, `${path}.triggers.confidence`, issues);
    stringArray(value.triggers.scope_flags, `${path}.triggers.scope_flags`, issues);
    stringArray(value.triggers.evidence, `${path}.triggers.evidence`, issues);
    for (const item of complexity ?? []) if (!["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"].includes(item)) addIssue(issues, `${path}.triggers.complexity`, "unknown complexity");
    for (const item of confidence ?? []) if (!["HIGH", "MEDIUM", "LOW"].includes(item)) addIssue(issues, `${path}.triggers.confidence`, "unknown confidence");
  }
  if (!isRecord(value.budget)) {
    addIssue(issues, `${path}.budget`, "must be an object");
  } else {
    unknownKeys(value.budget, ["token_limit", "dollar_limit"], `${path}.budget`, issues);
    for (const key of ["token_limit", "dollar_limit"]) {
      const budget = value.budget[key];
      if (budget !== null && (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0)) {
        addIssue(issues, `${path}.budget.${key}`, "must be a non-negative number or null");
      }
    }
  }
}

function validateWorkIdentity(value: unknown, path: string, issues: TypedContractIssue[]): value is WorkIdentity {
  const initialIssueCount = issues.length;
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return false;
  }
  unknownKeys(value, [
    "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id", "stage_cursor",
    "capability_id", "capability_epoch", "slot_id", "task_id", "dispatch_id", "attempt", "worker_id",
  ], path, issues);
  for (const key of [
    "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id", "stage_cursor",
    "capability_id", "capability_epoch", "slot_id", "task_id", "dispatch_id", "worker_id",
  ]) requireString(value, key, path, issues);
  requireInteger(value, "attempt", path, issues, 1);
  return issues.length === initialIssueCount;
}

function validateRosterSelection(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, [
    "snapshot_id", "run_key", "wave_id", "slice_id", "session_id", "workflow", "stage_id",
    "profile_hash", "policy_hash", "scope_hash", "mapping_hash", "capability_epoch",
    "selected", "omitted", "triggers", "stop_reason", "selected_at", "frozen_at",
  ], path, issues);
  for (const key of [
    "snapshot_id", "run_key", "wave_id", "slice_id", "session_id", "workflow", "stage_id",
    "profile_hash", "policy_hash", "scope_hash", "mapping_hash", "capability_epoch", "selected_at", "frozen_at",
  ]) requireString(value, key, path, issues);
  requireEnum(value, "stop_reason", ["minimum_valid_set", "risk_trigger_satisfied", "max_workers", "budget_limit"], path, issues);
  stringArray(value.triggers, `${path}.triggers`, issues);
  if (!Array.isArray(value.selected)) {
    addIssue(issues, `${path}.selected`, "must be an array");
  } else {
    const slots: string[] = [];
    value.selected.forEach((entry, index) => {
      const entryPath = `${path}.selected[${index}]`;
      if (!isRecord(entry)) {
        addIssue(issues, entryPath, "must be an object");
        return;
      }
      unknownKeys(entry, ["slot_id", "role", "occurrence", "facet", "agent", "reason"], entryPath, issues);
      requireString(entry, "slot_id", entryPath, issues);
      requireString(entry, "role", entryPath, issues);
      requireInteger(entry, "occurrence", entryPath, issues, 1);
      if (!hasOwn(entry, "facet") || (entry.facet !== null && !nonEmptyString(entry.facet))) addIssue(issues, `${entryPath}.facet`, "must be a non-empty string or null");
      requireString(entry, "agent", entryPath, issues);
      requireString(entry, "reason", entryPath, issues);
      if (typeof entry.slot_id === "string") {
        if (slots.includes(entry.slot_id)) addIssue(issues, `${entryPath}.slot_id`, "duplicate slot_id");
        slots.push(entry.slot_id);
      }
    });
  }
  if (!Array.isArray(value.omitted)) {
    addIssue(issues, `${path}.omitted`, "must be an array");
  } else {
    value.omitted.forEach((entry, index) => {
      const entryPath = `${path}.omitted[${index}]`;
      if (!isRecord(entry)) {
        addIssue(issues, entryPath, "must be an object");
        return;
      }
      unknownKeys(entry, ["role", "reason"], entryPath, issues);
      requireString(entry, "role", entryPath, issues);
      requireString(entry, "reason", entryPath, issues);
    });
  }
}
function validatePendingState(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["identity", "run_identity", "status", "pending_reason", "provider_ref", "lease", "terminal_signal", "retry_of", "updated_at"], path, issues);
  validateWorkIdentity(value.identity, `${path}.identity`, issues);
  if (!hasOwn(value, "run_identity")) addIssue(issues, `${path}.run_identity`, "required for an active v2 lifecycle");
  else validateRunIdentityValue(value.run_identity, `${path}.run_identity`, issues);
  requireEnum(value, "status", ["authorized", "running", "pending", "succeeded", "failed", "cancelled"], path, issues);
  if (value.pending_reason !== undefined && (typeof value.pending_reason !== "string" || !["provider_running", "awaiting_result", "transport_reconnect"].includes(value.pending_reason))) {
    addIssue(issues, `${path}.pending_reason`, "unknown pending reason");
  }
  if (value.provider_ref !== undefined && !nonEmptyString(value.provider_ref)) addIssue(issues, `${path}.provider_ref`, "must be a non-empty string");
  if (value.lease !== undefined) {
    if (!isRecord(value.lease)) addIssue(issues, `${path}.lease`, "must be an object");
    else {
      unknownKeys(value.lease, ["token", "observed_at", "revoked_at"], `${path}.lease`, issues);
      requireString(value.lease, "token", `${path}.lease`, issues);
      requireString(value.lease, "observed_at", `${path}.lease`, issues);
      if (!hasOwn(value.lease, "revoked_at") || (value.lease.revoked_at !== null && !nonEmptyString(value.lease.revoked_at))) addIssue(issues, `${path}.lease.revoked_at`, "must be a non-empty string or null");
    }
  }
  if (value.terminal_signal !== undefined && value.terminal_signal !== null && !nonEmptyString(value.terminal_signal)) addIssue(issues, `${path}.terminal_signal`, "must be a non-empty string or null");
  if (value.retry_of !== undefined && value.retry_of !== null && !nonEmptyString(value.retry_of)) addIssue(issues, `${path}.retry_of`, "must be a non-empty string or null");
  requireString(value, "updated_at", path, issues);
  if (value.status === "pending" && value.terminal_signal !== undefined && value.terminal_signal !== null) {
    addIssue(issues, `${path}.terminal_signal`, "pending work cannot claim a terminal signal");
  }
}

function validateChildJoin(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["run_identity", "parent", "child", "state", "expected_artifact_ids", "completion_envelope_ref", "attempt", "created_at", "joined_at"], path, issues);
  if (!hasOwn(value, "run_identity")) addIssue(issues, `${path}.run_identity`, "required for an active v2 lifecycle");
  else validateRunIdentityValue(value.run_identity, `${path}.run_identity`, issues);
  validateWorkIdentity(value.parent, `${path}.parent`, issues);
  validateWorkIdentity(value.child, `${path}.child`, issues);
  requireEnum(value, "state", ["planned", "authorized", "pending", "succeeded", "failed", "cancelled", "conflict"], path, issues);
  stringArray(value.expected_artifact_ids, `${path}.expected_artifact_ids`, issues);
  if (!hasOwn(value, "completion_envelope_ref") || (value.completion_envelope_ref !== null && !nonEmptyString(value.completion_envelope_ref))) {
    addIssue(issues, `${path}.completion_envelope_ref`, "must be a non-empty string or null");
  }
  requireInteger(value, "attempt", path, issues, 1);
  requireString(value, "created_at", path, issues);
  requireString(value, "joined_at", path, issues);
}
const PROJECT_IDENTITY_KEYS = [
  "root_instance_id",
  "provider_id",
  "descriptor_fingerprint",
  "executable_provenance",
  "catalog_content_digest",
  "config_byte_sha256",
  "config_semantic_sha256",
  "session",
] as const;

const RUN_IDENTITY_KEYS = [...PROJECT_IDENTITY_KEYS, "run_id", "profile_identity"] as const;

function validateProjectIdentityValue(value: unknown, path: string, issues: TypedContractIssue[]): ProjectIdentity | null {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be a complete project identity");
    return null;
  }
  unknownKeys(value, PROJECT_IDENTITY_KEYS, path, issues);
  const checked = validateProjectIdentity(value);
  if (!checked.ok) {
    for (const diagnostic of checked.diagnostics) {
      const field = diagnostic.evidence.changed_field;
      addIssue(issues, typeof field === "string" && field.length > 0 ? `${path}.${field}` : path, "is not a valid project identity");
    }
    return null;
  }
  return checked.value;
}

function validateRunIdentityValue(value: unknown, path: string, issues: TypedContractIssue[]): WorkflowRunIdentity | null {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be a complete workflow run identity");
    return null;
  }
  unknownKeys(value, RUN_IDENTITY_KEYS, path, issues);
  const checked = validateWorkflowRunIdentity(value);
  if (!checked.ok) {
    for (const diagnostic of checked.diagnostics) {
      const field = diagnostic.evidence.changed_field;
      addIssue(issues, typeof field === "string" && field.length > 0 ? `${path}.${field}` : path, "is not a valid workflow run identity");
    }
    return null;
  }
  return checked.value;
}

function validateAgentRef(value: unknown, path: string, issues: TypedContractIssue[]): boolean {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be a provider-qualified agent reference");
    return false;
  }
  unknownKeys(value, ["registered_name", "provider_id", "source_fingerprint"], path, issues);
  requireString(value, "registered_name", path, issues);
  if (!isProviderId(value.provider_id)) addIssue(issues, `${path}.provider_id`, "must be a lowercase package-qualified provider id");
  if (!isWorkflowV2Digest(value.source_fingerprint)) {
    addIssue(issues, `${path}.source_fingerprint`, "must be a sha256:<64 lowercase hex> digest");
  }
  return true;
}
function validateDispatchCompletion(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, [
    "dispatch_id", "cursor_epoch", "outcome", "artifact_ids", "evidence",
    "completed_by", "completed_at", "run_identity", "work_identity",
  ], path, issues);
  for (const key of ["dispatch_id", "cursor_epoch", "evidence", "completed_at"]) requireString(value, key, path, issues);
  requireEnum(value, "outcome", ["succeeded", "failed", "cancelled"], path, issues);
  stringArray(value.artifact_ids, `${path}.artifact_ids`, issues);
  requireEnum(value, "completed_by", ["workflow_complete", "synchronous_tool_result", "engine_task_caller"], path, issues);
  if (!hasOwn(value, "run_identity")) addIssue(issues, `${path}.run_identity`, "required for an active v2 lifecycle");
  else validateRunIdentityValue(value.run_identity, `${path}.run_identity`, issues);
  if (hasOwn(value, "work_identity")) validateWorkIdentity(value.work_identity, `${path}.work_identity`, issues);
}

function validateDispatchRecord(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, [
    "id", "role", "agent", "agent_ref", "tool_call_id", "status", "attempt",
    "created_at", "completed_at", "completion", "run_identity",
    "work_identity", "pending", "completion_envelope",
  ], path, issues);
  for (const key of ["id", "role", "agent", "created_at"]) requireString(value, key, path, issues);
  requireEnum(value, "status", ["authorized", "running", "pending", "succeeded", "failed", "cancelled"], path, issues);
  requireInteger(value, "attempt", path, issues, 1);
  if (value.tool_call_id !== undefined) requireString(value, "tool_call_id", path, issues);
  if (value.completed_at !== undefined) requireString(value, "completed_at", path, issues);
  if (hasOwn(value, "agent_ref")) validateAgentRef(value.agent_ref, `${path}.agent_ref`, issues);
  if (hasOwn(value, "work_identity")) validateWorkIdentity(value.work_identity, `${path}.work_identity`, issues);
  if (hasOwn(value, "pending")) validatePendingState(value.pending, `${path}.pending`, issues);
  if (hasOwn(value, "completion")) validateDispatchCompletion(value.completion, `${path}.completion`, issues);
  if (hasOwn(value, "completion_envelope")) validateCompletionEnvelope(value.completion_envelope, `${path}.completion_envelope`, issues);
  if (!hasOwn(value, "run_identity")) addIssue(issues, `${path}.run_identity`, "required for an active v2 lifecycle");
  else validateRunIdentityValue(value.run_identity, `${path}.run_identity`, issues);
}

function validateExpectedRosterEntry(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["role", "agent", "agent_ref", "slot_id", "semantic_role", "occurrence", "facet"], path, issues);
  requireString(value, "role", path, issues);
  requireString(value, "agent", path, issues);
  if (!hasOwn(value, "agent_ref")) addIssue(issues, `${path}.agent_ref`, "required for a qualified dispatch roster");
  else validateAgentRef(value.agent_ref, `${path}.agent_ref`, issues);
  if (value.slot_id !== undefined) requireString(value, "slot_id", path, issues);
  if (value.semantic_role !== undefined) requireString(value, "semantic_role", path, issues);
  if (value.occurrence !== undefined) requireInteger(value, "occurrence", path, issues, 1);
  if (value.facet !== undefined && value.facet !== null) requireString(value, "facet", path, issues);
}

function validateDispatchCapability(value: unknown, path: string, issues: TypedContractIssue[]): WorkIdentity | null {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return null;
  }
  unknownKeys(value, [
    "run", "workflow", "profile_hash", "stage", "roles", "capability_id",
    "dispatch_token_hash", "advance_token_hash", "issued_for", "kind",
    "project_identity", "run_identity", "expected_roles", "expected_count",
    "expected_roster", "roster_selection", "work_identity", "pending", "status",
    "dispatches",
  ], path, issues);
  let workIdentity: WorkIdentity | null = null;
  const topProject = hasOwn(value, "project_identity")
    ? validateProjectIdentityValue(value.project_identity, `${path}.project_identity`, issues)
    : (addIssue(issues, `${path}.project_identity`, "required for an active v2 lifecycle"), null);
  const topRun = hasOwn(value, "run_identity")
    ? validateRunIdentityValue(value.run_identity, `${path}.run_identity`, issues)
    : (addIssue(issues, `${path}.run_identity`, "required for an active v2 lifecycle"), null);
  if (topProject && topRun && !sameProjectIdentity(topProject, topRun)) {
    addIssue(issues, `${path}.run_identity`, "must inherit project_identity");
  }
  if (value.run !== undefined) requireString(value, "run", path, issues);
  if (value.workflow !== undefined) requireString(value, "workflow", path, issues);
  if (value.profile_hash !== undefined) requireString(value, "profile_hash", path, issues);
  if (value.stage !== undefined) requireString(value, "stage", path, issues);
  if (value.roles !== undefined) stringArray(value.roles, `${path}.roles`, issues);
  if (value.capability_id !== undefined) requireString(value, "capability_id", path, issues);
  for (const key of ["dispatch_token_hash", "advance_token_hash"]) {
    if (value[key] !== undefined) {
      requireString(value, key, path, issues);
      if (typeof value[key] === "string" && !/^[0-9a-f]{64}$/.test(value[key])) addIssue(issues, `${path}.${key}`, "must be a lowercase sha256 hash");
    }
  }
  if (!isRecord(value.issued_for)) {
    addIssue(issues, `${path}.issued_for`, "must include the project and run identity binding");
  } else {
    unknownKeys(value.issued_for, [
      "run_key", "branch", "workflow", "profile_hash", "stage_cursor", "cursor_epoch",
      "project_identity", "run_identity",
    ], `${path}.issued_for`, issues);
    for (const key of ["run_key", "branch", "workflow", "profile_hash", "stage_cursor", "cursor_epoch"]) {
      requireString(value.issued_for, key, `${path}.issued_for`, issues);
    }
    const issuedProject = hasOwn(value.issued_for, "project_identity")
      ? validateProjectIdentityValue(value.issued_for.project_identity, `${path}.issued_for.project_identity`, issues)
      : (addIssue(issues, `${path}.issued_for.project_identity`, "required for an active v2 lifecycle"), null);
    const issuedRun = hasOwn(value.issued_for, "run_identity")
      ? validateRunIdentityValue(value.issued_for.run_identity, `${path}.issued_for.run_identity`, issues)
      : (addIssue(issues, `${path}.issued_for.run_identity`, "required for an active v2 lifecycle"), null);
    if (issuedProject && issuedRun && !sameProjectIdentity(issuedProject, issuedRun)) {
      addIssue(issues, `${path}.issued_for.run_identity`, "must inherit issued_for.project_identity");
    }
    if (topProject && issuedProject && !sameProjectIdentity(topProject, issuedProject)) {
      addIssue(issues, `${path}.issued_for.project_identity`, "must match dispatch_capability.project_identity");
    }
    if (topRun && issuedRun && !sameRunIdentity(topRun, issuedRun)) {
      addIssue(issues, `${path}.issued_for.run_identity`, "must match dispatch_capability.run_identity");
    }
  }
  requireEnum(value, "kind", ["none", "single", "consilium"], path, issues);
  if (hasOwn(value, "expected_roles")) stringArray(value.expected_roles, `${path}.expected_roles`, issues);
  if (hasOwn(value, "expected_count")) requireInteger(value, "expected_count", path, issues);
  if (hasOwn(value, "expected_roster")) {
    if (!Array.isArray(value.expected_roster)) addIssue(issues, `${path}.expected_roster`, "must be an array");
    else value.expected_roster.forEach((entry, index) => {
      const entryPath = `${path}.expected_roster[${index}]`;
      validateExpectedRosterEntry(entry, entryPath, issues);
      if (topProject && isRecord(entry) && isRecord(entry.agent_ref) && entry.agent_ref.provider_id !== topProject.provider_id) {
        addIssue(issues, `${entryPath}.agent_ref.provider_id`, "must match project_identity.provider_id");
      }
    });
  }
  if (hasOwn(value, "roster_selection")) validateRosterSelection(value.roster_selection, `${path}.roster_selection`, issues);
  if (!hasOwn(value, "work_identity")) {
    addIssue(issues, `${path}.work_identity`, "required for an active v2 lifecycle");
  } else if (validateWorkIdentity(value.work_identity, `${path}.work_identity`, issues)) {
    workIdentity = value.work_identity as WorkIdentity;
  }
  if (hasOwn(value, "pending")) {
    if (!Array.isArray(value.pending)) addIssue(issues, `${path}.pending`, "must be an array");
    else value.pending.forEach((entry, index) => validatePendingState(entry, `${path}.pending[${index}]`, issues));
  }
  if (hasOwn(value, "status")) requireEnum(value, "status", ["ready", "dispatched", "joining", "complete", "invalidated"], path, issues);
  if (hasOwn(value, "dispatches")) {
    if (!Array.isArray(value.dispatches)) addIssue(issues, `${path}.dispatches`, "must be an array");
    else value.dispatches.forEach((entry, index) => {
      validateDispatchRecord(entry, `${path}.dispatches[${index}]`, issues);
      const entryRun = isRecord(entry) ? validateWorkflowRunIdentity(entry.run_identity) : null;
      if (topRun && entryRun?.ok && !sameRunIdentity(topRun, entryRun.value)) {
        addIssue(issues, `${path}.dispatches[${index}].run_identity`, "must match dispatch_capability.run_identity");
      }
    });
  }
  return workIdentity;
}
function validateJoinSummary(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["stage_id", "run_identity", "cursor_epoch", "dispatch_ids", "roles", "evidence", "joined_at", "work_identity"], path, issues);
  for (const key of ["stage_id", "cursor_epoch", "joined_at"]) requireString(value, key, path, issues);
  stringArray(value.dispatch_ids, `${path}.dispatch_ids`, issues);
  stringArray(value.roles, `${path}.roles`, issues);
  if (value.evidence !== undefined) requireString(value, "evidence", path, issues);
  if (!hasOwn(value, "run_identity")) addIssue(issues, `${path}.run_identity`, "required for an active v2 lifecycle");
  else validateRunIdentityValue(value.run_identity, `${path}.run_identity`, issues);
  if (hasOwn(value, "work_identity")) validateWorkIdentity(value.work_identity, `${path}.work_identity`, issues);
}

function validateCompletionEnvelope(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["schema_version", "identity", "run_identity", "outcome", "terminal_signal", "artifact_refs", "evidence_ref", "conflict_ref", "completed_by", "emitted_at"], path, issues);
  if (value.schema_version !== 1) addIssue(issues, `${path}.schema_version`, "must be 1");
  validateWorkIdentity(value.identity, `${path}.identity`, issues);
  if (!hasOwn(value, "run_identity")) addIssue(issues, `${path}.run_identity`, "required for an active v2 lifecycle");
  else validateRunIdentityValue(value.run_identity, `${path}.run_identity`, issues);
  requireEnum(value, "outcome", ["pending", "succeeded", "failed", "cancelled"], path, issues);
  const terminalSignal = value.terminal_signal;
  if (!hasOwn(value, "terminal_signal") || (
    terminalSignal !== null
    && terminalSignal !== undefined
    && (typeof terminalSignal !== "string" || !["workflow_complete", "native_tool_result", "provider_terminal", "contract_failure"].includes(terminalSignal))
  )) {
    addIssue(issues, `${path}.terminal_signal`, "unknown or missing terminal signal");
  }
  if (!Array.isArray(value.artifact_refs)) {
    addIssue(issues, `${path}.artifact_refs`, "must be an array");
  } else {
    value.artifact_refs.forEach((entry, index) => {
      const entryPath = `${path}.artifact_refs[${index}]`;
      if (!isRecord(entry)) {
        addIssue(issues, entryPath, "must be an object");
        return;
      }
      unknownKeys(entry, ["artifact_id", "path", "sha256", "schema_status", "dod_status"], entryPath, issues);
      requireString(entry, "artifact_id", entryPath, issues);
      if (!safeRelativePath(entry.path)) addIssue(issues, `${entryPath}.path`, "must be a safe relative path");
      requireString(entry, "sha256", entryPath, issues);
      requireEnum(entry, "schema_status", ["met", "failed"], entryPath, issues);
      requireEnum(entry, "dod_status", ["met", "pending", "failed"], entryPath, issues);
    });
  }
  if (!hasOwn(value, "evidence_ref") || (value.evidence_ref !== null && !nonEmptyString(value.evidence_ref))) addIssue(issues, `${path}.evidence_ref`, "must be a non-empty string or null");
  if (!hasOwn(value, "conflict_ref") || (value.conflict_ref !== null && !nonEmptyString(value.conflict_ref))) addIssue(issues, `${path}.conflict_ref`, "must be a non-empty string or null");
  requireEnum(value, "completed_by", ["workflow_complete", "synchronous_tool_result", "engine_task_caller"], path, issues);
  requireString(value, "emitted_at", path, issues);
  if (value.outcome === "pending") {
    if (value.terminal_signal !== null && value.terminal_signal !== undefined) addIssue(issues, `${path}.terminal_signal`, "pending envelope cannot claim a terminal signal");
    if (Array.isArray(value.artifact_refs) && value.artifact_refs.length > 0) addIssue(issues, `${path}.artifact_refs`, "pending envelope cannot claim terminal artifacts");
  } else if (value.terminal_signal === null || value.terminal_signal === undefined) {
    addIssue(issues, `${path}.terminal_signal`, "terminal envelope requires a terminal signal");
  }
}
function validateRetiredCapability(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, [
    "capability_id", "capability_epoch", "run_identity", "work_identity",
    "dispatch_capability", "completion_outcome", "completion_envelope", "reason", "retired_at",
  ], path, issues);
  for (const key of ["capability_id", "capability_epoch", "reason", "retired_at"]) requireString(value, key, path, issues);
  if (!hasOwn(value, "run_identity")) addIssue(issues, `${path}.run_identity`, "required");
  else validateRunIdentityValue(value.run_identity, `${path}.run_identity`, issues);
  validateWorkIdentity(value.work_identity, `${path}.work_identity`, issues);
  if (!hasOwn(value, "dispatch_capability")) {
    addIssue(issues, `${path}.dispatch_capability`, "required");
  } else if (!isRecord(value.dispatch_capability)) {
    addIssue(issues, `${path}.dispatch_capability`, "must be an object");
  } else {
    const capability = value.dispatch_capability;
    for (const legacy of ["run", "workflow", "profile_hash", "stage", "roles"]) {
      if (hasOwn(capability, legacy)) addIssue(issues, `${path}.dispatch_capability.${legacy}`, "legacy capability field is not allowed in retired history");
    }
    const capabilityIdentity = validateDispatchCapability(capability, `${path}.dispatch_capability`, issues);
    if (capabilityIdentity && isRecord(value.work_identity) && isWorkIdentityComparable(value.work_identity) && !sameWorkIdentity(value.work_identity, capabilityIdentity)) {
      addIssue(issues, `${path}.dispatch_capability.work_identity`, "must match work_identity");
    }
    if (isRecord(value.dispatch_capability) && String(value.dispatch_capability.capability_id) !== String(value.capability_id)) {
      addIssue(issues, `${path}.capability_id`, "must match dispatch_capability.capability_id");
    }
    if (isRecord(value.dispatch_capability) && isRecord(value.dispatch_capability.issued_for) && String(value.dispatch_capability.issued_for.cursor_epoch) !== String(value.capability_epoch)) {
      addIssue(issues, `${path}.capability_epoch`, "must match dispatch_capability.issued_for.cursor_epoch");
    }
    const entryRun = validateWorkflowRunIdentity(value.run_identity);
    const capabilityRun = validateWorkflowRunIdentity(capability.run_identity);
    if (entryRun.ok && capabilityRun.ok && !sameRunIdentity(entryRun.value, capabilityRun.value)) {
      addIssue(issues, `${path}.dispatch_capability.run_identity`, "must match run_identity");
    }
  }
  if (!hasOwn(value, "completion_outcome")) addIssue(issues, `${path}.completion_outcome`, "required");
  else if (value.completion_outcome !== null) requireEnum(value, "completion_outcome", ["pending", "succeeded", "failed", "cancelled"], path, issues);
  if (!hasOwn(value, "completion_envelope")) {
    addIssue(issues, `${path}.completion_envelope`, "required");
  } else if (value.completion_envelope === undefined) {
    addIssue(issues, `${path}.completion_envelope`, "must not be undefined");
  } else if (value.completion_envelope !== null) {
    validateCompletionEnvelope(value.completion_envelope, `${path}.completion_envelope`, issues);
    if (isRecord(value.completion_envelope) && value.completion_outcome !== value.completion_envelope.outcome) {
      addIssue(issues, `${path}.completion_outcome`, "must match completion_envelope.outcome");
    }
    if (isRecord(value.work_identity) && isWorkIdentityComparable(value.work_identity) && isRecord(value.completion_envelope) && isRecord(value.completion_envelope.identity) && isWorkIdentityComparable(value.completion_envelope.identity) && !sameWorkIdentity(value.work_identity, value.completion_envelope.identity)) {
      addIssue(issues, `${path}.completion_envelope.identity`, "must match work_identity");
    }
    const entryRun = validateRunIdentityValue(value.run_identity, `${path}.run_identity`, issues);
    const envelope = value.completion_envelope;
    const envelopeRun = isRecord(envelope) ? validateWorkflowRunIdentity(envelope.run_identity) : null;
    if (entryRun && envelopeRun?.ok && !sameRunIdentity(entryRun, envelopeRun.value)) addIssue(issues, `${path}.completion_envelope.run_identity`, "must match run_identity");
  } else if (value.completion_outcome !== null) {
    addIssue(issues, `${path}.completion_envelope`, "must be present when completion_outcome is non-null");
  }
}


function validateCheckpointAnswerProof(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["answer_id", "nonce", "channel", "reference", "binding"], path, issues);
  for (const key of ["answer_id", "nonce", "reference", "binding"]) requireString(value, key, path, issues);
  requireEnum(value, "channel", ["terminal", "escalation"], path, issues);
}
function validateTrustedCheckpointAnswer(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, [
    "answer_id", "nonce", "channel", "reference", "run_id", "stage_id", "checkpoint_id",
    "work_identity_hash", "capability_id", "capability_epoch", "policy_hash", "decision",
    "binding", "issued_at", "consumed_at",
  ], path, issues);
  for (const key of [
    "answer_id", "nonce", "reference", "run_id", "stage_id", "checkpoint_id",
    "work_identity_hash", "capability_id", "capability_epoch", "policy_hash",
    "decision", "binding", "issued_at",
  ]) requireString(value, key, path, issues);
  requireEnum(value, "channel", ["terminal", "escalation"], path, issues);
  if (value.consumed_at !== undefined) requireString(value, "consumed_at", path, issues);
}

function validateCheckpointDecision(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, [
    "stage_id", "checkpoint", "mode", "decision", "actor", "rationale", "decided_at",
    "run_id", "checkpoint_id", "checkpoint_kind", "authorization", "actor_provenance",
    "capability_id", "capability_epoch", "policy_hash", "work_identity",
  ], path, issues);
  for (const key of ["stage_id", "checkpoint", "decision", "actor", "rationale", "decided_at"]) requireString(value, key, path, issues);
  requireEnum(value, "mode", ["interactive", "autonomous"], path, issues);
  if (value.checkpoint_kind !== undefined) requireEnum(value, "checkpoint_kind", CHECKPOINT_KINDS, path, issues);
  if (value.authorization !== undefined) requireEnum(value, "authorization", ["human", "policy_auto"], path, issues);
  if (value.actor_provenance !== undefined) {
    if (!isRecord(value.actor_provenance)) addIssue(issues, `${path}.actor_provenance`, "must be an object");
    else {
      unknownKeys(value.actor_provenance, ["kind", "ref", "proof"], `${path}.actor_provenance`, issues);
      requireEnum(value.actor_provenance, "kind", ["user", "orchestrator", "system"], `${path}.actor_provenance`, issues);
      requireString(value.actor_provenance, "ref", `${path}.actor_provenance`, issues);
      if (value.actor_provenance.proof !== undefined) {
        validateCheckpointAnswerProof(value.actor_provenance.proof, `${path}.actor_provenance.proof`, issues);
      }
    }
  }
  for (const key of ["run_id", "checkpoint_id", "capability_id", "capability_epoch", "policy_hash"]) {
    if (value[key] !== undefined && !nonEmptyString(value[key])) addIssue(issues, `${path}.${key}`, "must be a non-empty string");
  }
  if (value.work_identity !== undefined) validateWorkIdentity(value.work_identity, `${path}.work_identity`, issues);
  if (value.authorization === "policy_auto" && value.mode === "interactive") addIssue(issues, `${path}.authorization`, "policy_auto cannot use interactive mode");
  if (value.authorization === "human" && value.mode === "autonomous") addIssue(issues, `${path}.authorization`, "human authorization cannot use autonomous mode");
}
function validateTypedCheckpointDecision(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, [
    "run_id", "stage_id", "checkpoint_id", "checkpoint_kind", "decision", "authorization",
    "actor", "capability_id", "capability_epoch", "policy_hash", "rationale", "decided_at",
  ], path, issues);
  for (const key of ["run_id", "stage_id", "checkpoint_id", "decision", "capability_id", "capability_epoch", "policy_hash", "rationale", "decided_at"]) {
    requireString(value, key, path, issues);
  }
  requireEnum(value, "checkpoint_kind", CHECKPOINT_KINDS, path, issues);
  requireEnum(value, "authorization", ["human", "policy_auto"], path, issues);
  if (!isRecord(value.actor)) addIssue(issues, `${path}.actor`, "must be an object");
  else {
    unknownKeys(value.actor, ["kind", "ref", "proof"], `${path}.actor`, issues);
    requireEnum(value.actor, "kind", ["user", "orchestrator", "system"], `${path}.actor`, issues);
    requireString(value.actor, "ref", `${path}.actor`, issues);
    if (value.actor.proof !== undefined) validateCheckpointAnswerProof(value.actor.proof, `${path}.actor.proof`, issues);
  }
}


function validateTypedIdentityCoherence(value: UnknownRecord, stateWorkIdentity: WorkIdentity | null, issues: TypedContractIssue[]): void {
  const rootRun = hasOwn(value, "run_identity") ? validateWorkflowRunIdentity(value.run_identity) : null;
  if (!rootRun?.ok) return;
  const run = rootRun.value;
  const workflow = typeof value.workflow === "string" ? value.workflow : null;
  const classification = isRecord(value.classification) ? value.classification : null;
  const classificationWorkflow = classification && typeof classification.workflow === "string" ? classification.workflow : null;
  const stageCursor = typeof value.stage_cursor === "string" ? value.stage_cursor : null;
  const bind = (candidate: unknown, path: string, requireStage = false): void => {
    if (!isRecord(candidate)) return;
    if (candidate.run_id !== run.run_id) addIssue(issues, `${path}.run_id`, "must match run_identity.run_id");
    if (candidate.session_id !== run.session.session_id) addIssue(issues, `${path}.session_id`, "must match run_identity.session.session_id");
    if (workflow && candidate.workflow !== workflow) addIssue(issues, `${path}.workflow`, "must match workflow");
    if (classificationWorkflow && candidate.workflow !== classificationWorkflow) addIssue(issues, `${path}.workflow`, "must match classification.workflow");
    if (requireStage && stageCursor && (candidate.stage_id !== stageCursor || candidate.stage_cursor !== stageCursor)) {
      addIssue(issues, path, "stage_id/stage_cursor must match stage_cursor");
    }
  };
  if (stateWorkIdentity) bind(stateWorkIdentity, "$.work_identity", true);
  if (isRecord(value.pending)) {
    bind(value.pending.identity, "$.pending.identity", true);
    const pendingRun = validateWorkflowRunIdentity(value.pending.run_identity);
    if (pendingRun.ok && !sameRunIdentity(run, pendingRun.value)) addIssue(issues, "$.pending.run_identity", "must match run_identity");
    if (stateWorkIdentity && isRecord(value.pending.identity) && isWorkIdentityComparable(value.pending.identity) && !sameWorkIdentity(stateWorkIdentity, value.pending.identity)) addIssue(issues, "$.pending.identity", "must match work_identity");
  }
  if (isRecord(value.completion_envelope)) {
    bind(value.completion_envelope.identity, "$.completion_envelope.identity", true);
    const envelopeRun = validateWorkflowRunIdentity(value.completion_envelope.run_identity);
    if (envelopeRun.ok && !sameRunIdentity(run, envelopeRun.value)) addIssue(issues, "$.completion_envelope.run_identity", "must match run_identity");
    if (stateWorkIdentity && isRecord(value.completion_envelope.identity) && isWorkIdentityComparable(value.completion_envelope.identity) && !sameWorkIdentity(stateWorkIdentity, value.completion_envelope.identity)) addIssue(issues, "$.completion_envelope.identity", "must match work_identity");
  }
  const child = (candidate: unknown, path: string): void => {
    if (!isRecord(candidate)) return;
    const childRun = validateWorkflowRunIdentity(candidate.run_identity);
    if (childRun.ok && !sameRunIdentity(run, childRun.value)) addIssue(issues, `${path}.run_identity`, "must match run_identity");
    bind(candidate.parent, `${path}.parent`);
    bind(candidate.child, `${path}.child`);
  };
  if (hasOwn(value, "child_join")) child(value.child_join, "$.child_join");
  if (Array.isArray(value.child_joins)) value.child_joins.forEach((join, index) => child(join, `$.child_joins[${index}]`));
  if (isRecord(value.join_summary)) {
    const summaryRun = validateWorkflowRunIdentity(value.join_summary.run_identity);
    if (summaryRun.ok && !sameRunIdentity(run, summaryRun.value)) addIssue(issues, "$.join_summary.run_identity", "must match run_identity");
    if (isRecord(value.join_summary.work_identity)) bind(value.join_summary.work_identity, "$.join_summary.work_identity");
  }
  if (Array.isArray(value.typed_checkpoint_decisions)) {
    value.typed_checkpoint_decisions.forEach((decision, index) => {
      if (!isRecord(decision)) return;
      if (decision.run_id !== run.run_id) addIssue(issues, `$.typed_checkpoint_decisions[${index}].run_id`, "must match run_identity.run_id");
      const decisionRun = validateWorkflowRunIdentity(decision.run_identity);
      if (decisionRun.ok && !sameRunIdentity(run, decisionRun.value)) addIssue(issues, `$.typed_checkpoint_decisions[${index}].run_identity`, "must match run_identity");
    });
  }
  if (Array.isArray(value.checkpoint_decisions)) {
    value.checkpoint_decisions.forEach((decision, index) => {
      if (!isRecord(decision)) return;
      if (decision.run_id !== undefined && decision.run_id !== run.run_id) addIssue(issues, `$.checkpoint_decisions[${index}].run_id`, "must match run_identity.run_id");
      if (decision.run_identity !== undefined) {
        const decisionRun = validateWorkflowRunIdentity(decision.run_identity);
        if (decisionRun.ok && !sameRunIdentity(run, decisionRun.value)) addIssue(issues, `$.checkpoint_decisions[${index}].run_identity`, "must match run_identity");
      }
      if (decision.work_identity !== undefined && isRecord(decision.work_identity)) bind(decision.work_identity, `$.checkpoint_decisions[${index}].work_identity`);
    });
  }
  if (Array.isArray(value.trusted_checkpoint_answers)) {
    value.trusted_checkpoint_answers.forEach((answer, index) => {
      if (isRecord(answer) && answer.run_id !== run.run_id) addIssue(issues, `$.trusted_checkpoint_answers[${index}].run_id`, "must match run_identity.run_id");
    });
  }
  if (isRecord(value.dispatch_capability)) {
    const capabilityRun = validateWorkflowRunIdentity(value.dispatch_capability.run_identity);
    if (capabilityRun.ok && !sameRunIdentity(run, capabilityRun.value)) addIssue(issues, "$.dispatch_capability.run_identity", "must match run_identity");
    const issued = isRecord(value.dispatch_capability.issued_for) ? validateWorkflowRunIdentity(value.dispatch_capability.issued_for.run_identity) : null;
    if (issued?.ok && !sameRunIdentity(run, issued.value)) addIssue(issues, "$.dispatch_capability.issued_for.run_identity", "must match run_identity");
    const capabilityIdentity = isRecord(value.dispatch_capability.work_identity) ? value.dispatch_capability.work_identity : null;
    if (stateWorkIdentity && capabilityIdentity && isWorkIdentityComparable(capabilityIdentity) && !sameWorkIdentity(stateWorkIdentity, capabilityIdentity)) addIssue(issues, "$.dispatch_capability.work_identity", "must match work_identity");
    if (capabilityIdentity) bind(capabilityIdentity, "$.dispatch_capability.work_identity", true);
    if (Array.isArray(value.dispatch_capability.pending)) {
      value.dispatch_capability.pending.forEach((pending, index) => {
        if (!isRecord(pending)) return;
        const pendingRun = validateWorkflowRunIdentity(pending.run_identity);
        if (pendingRun.ok && !sameRunIdentity(run, pendingRun.value)) addIssue(issues, `$.dispatch_capability.pending[${index}].run_identity`, "must match run_identity");
        bind(pending.identity, `$.dispatch_capability.pending[${index}].identity`);
      });
    }
    if (Array.isArray(value.dispatch_capability.dispatches)) {
      value.dispatch_capability.dispatches.forEach((record, index) => {
        if (!isRecord(record)) return;
        const recordRun = validateWorkflowRunIdentity(record.run_identity);
        if (recordRun.ok && !sameRunIdentity(run, recordRun.value)) addIssue(issues, `$.dispatch_capability.dispatches[${index}].run_identity`, "must match run_identity");
        bind(record.work_identity, `$.dispatch_capability.dispatches[${index}].work_identity`);
        if (isRecord(record.pending)) {
          const pendingRun = validateWorkflowRunIdentity(record.pending.run_identity);
          if (pendingRun.ok && !sameRunIdentity(run, pendingRun.value)) addIssue(issues, `$.dispatch_capability.dispatches[${index}].pending.run_identity`, "must match run_identity");
        }
        if (isRecord(record.completion)) {
          const completionRun = validateWorkflowRunIdentity(record.completion.run_identity);
          if (completionRun.ok && !sameRunIdentity(run, completionRun.value)) addIssue(issues, `$.dispatch_capability.dispatches[${index}].completion.run_identity`, "must match run_identity");
        }
        if (isRecord(record.completion_envelope)) {
          const envelopeRun = validateWorkflowRunIdentity(record.completion_envelope.run_identity);
          if (envelopeRun.ok && !sameRunIdentity(run, envelopeRun.value)) addIssue(issues, `$.dispatch_capability.dispatches[${index}].completion_envelope.run_identity`, "must match run_identity");
        }
      });
    }
  }
}

function validateMigrationReceipt(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["id", "from_schema", "to_schema", "source_profile_hash", "target_profile_hash", "source_policy_hash", "target_policy_hash", "legacy_inputs", "warnings", "status", "migrated_at"], path, issues);
  requireString(value, "id", path, issues);
  requireInteger(value, "from_schema", path, issues, 1);
  requireInteger(value, "to_schema", path, issues, 1);
  for (const key of ["source_profile_hash", "target_profile_hash", "target_policy_hash"]) requireString(value, key, path, issues);
  if (value.source_policy_hash !== null && value.source_policy_hash !== undefined && !nonEmptyString(value.source_policy_hash)) addIssue(issues, `${path}.source_policy_hash`, "must be a non-empty string or null");
  stringArray(value.legacy_inputs, `${path}.legacy_inputs`, issues);
  stringArray(value.warnings, `${path}.warnings`, issues);
  requireEnum(value, "status", ["complete", "blocked"], path, issues);
  requireString(value, "migrated_at", path, issues);
}

/**
 * Validate only canonical typed fields. Legacy top-level fields are ignored
 * here and are handled by the explicit migration/conflict path below.
 */
export function validateTypedControlPlane(value: unknown): TypedContractValidationResult {
  if (!isRecord(value)) return { ok: false, issues: [{ path: "$", message: "typed control-plane input must be an object" }] };
  const issues: TypedContractIssue[] = [];
  if (hasOwn(value, "workflow_identity")) addIssue(issues, "$.workflow_identity", "retired; persist project_identity and run_identity instead");
  if (hasOwn(value, "project_identity")) validateProjectIdentityValue(value.project_identity, "$.project_identity", issues);
  if (hasOwn(value, "run_identity")) validateRunIdentityValue(value.run_identity, "$.run_identity", issues);
  if (hasOwn(value, "completion_intent")) validateCompletionIntent(value.completion_intent, "$.completion_intent", issues);
  if (hasOwn(value, "checkpoint_policy")) validateCheckpointPolicy(value.checkpoint_policy, "$.checkpoint_policy", issues);
  if (hasOwn(value, "roster_policy")) validateRosterPolicy(value.roster_policy, "$.roster_policy", issues);
  if (hasOwn(value, "roster_selection")) validateRosterSelection(value.roster_selection, "$.roster_selection", issues);
  if (hasOwn(value, "roster_selections")) {
    if (!isRecord(value.roster_selections)) addIssue(issues, "$.roster_selections", "must be an object");
    else for (const [stage, selection] of Object.entries(value.roster_selections)) validateRosterSelection(selection, `$.roster_selections.${stage}`, issues);
  }
  const stateWorkIdentity = hasOwn(value, "work_identity")
    ? (validateWorkIdentity(value.work_identity, "$.work_identity", issues) ? value.work_identity as WorkIdentity : null)
    : null;
  if (hasOwn(value, "pending")) validatePendingState(value.pending, "$.pending", issues);
  if (hasOwn(value, "child_join")) validateChildJoin(value.child_join, "$.child_join", issues);
  if (hasOwn(value, "child_joins")) {
    if (!Array.isArray(value.child_joins)) addIssue(issues, "$.child_joins", "must be an array");
    else value.child_joins.forEach((join, index) => validateChildJoin(join, `$.child_joins[${index}]`, issues));
  }
  if (hasOwn(value, "typed_checkpoint_decisions")) {
    if (!Array.isArray(value.typed_checkpoint_decisions)) addIssue(issues, "$.typed_checkpoint_decisions", "must be an array");
    else value.typed_checkpoint_decisions.forEach((decision, index) => validateTypedCheckpointDecision(decision, `$.typed_checkpoint_decisions[${index}]`, issues));
  }
  if (hasOwn(value, "trusted_checkpoint_answers")) {
    if (!Array.isArray(value.trusted_checkpoint_answers)) addIssue(issues, "$.trusted_checkpoint_answers", "must be an array");
    else value.trusted_checkpoint_answers.forEach((answer, index) => validateTrustedCheckpointAnswer(answer, `$.trusted_checkpoint_answers[${index}]`, issues));
  }
  if (hasOwn(value, "completion_envelope")) validateCompletionEnvelope(value.completion_envelope, "$.completion_envelope", issues);
  if (hasOwn(value, "join_summary")) validateJoinSummary(value.join_summary, "$.join_summary", issues);
  if (hasOwn(value, "migration")) validateMigrationReceipt(value.migration, "$.migration", issues);
  if (hasOwn(value, "checkpoint_decisions")) {
    if (!Array.isArray(value.checkpoint_decisions)) addIssue(issues, "$.checkpoint_decisions", "must be an array");
    else value.checkpoint_decisions.forEach((decision, index) => validateCheckpointDecision(decision, `$.checkpoint_decisions[${index}]`, issues));
  }
  if (hasOwn(value, "dispatch_capability")) {
    const capabilityWorkIdentity = validateDispatchCapability(value.dispatch_capability, "$.dispatch_capability", issues);
    if (stateWorkIdentity && capabilityWorkIdentity && !sameWorkIdentity(stateWorkIdentity, capabilityWorkIdentity)) {
      addIssue(issues, "$.dispatch_capability.work_identity", "must match state.work_identity");
    }
  }
  if (hasOwn(value, "retired_capabilities")) {
    if (!Array.isArray(value.retired_capabilities)) {
      addIssue(issues, "$.retired_capabilities", "must be an array");
    } else {
      if (value.retired_capabilities.length > 128) addIssue(issues, "$.retired_capabilities", "must contain at most 128 entries per run");
      const retiredKeys = new Set<string>();
      value.retired_capabilities.forEach((entry, index) => {
        validateRetiredCapability(entry, `$.retired_capabilities[${index}]`, issues);
        if (isRecord(entry)) {
          const key = `${String(entry.capability_id)}:${String(entry.capability_epoch)}`;
          if (retiredKeys.has(key)) addIssue(issues, `$.retired_capabilities[${index}]`, "duplicate capability_id+capability_epoch");
          retiredKeys.add(key);
        }
      });
    }
  }
  validateTypedIdentityCoherence(value, stateWorkIdentity, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

/** Legacy autonomy routes the profile; it does not semantically authorize a typed policy. */
export function checkpointPolicyLegacyConflict(policy: CheckpointPolicy | undefined, legacyAutonomous: unknown): string | null {
  if (!policy || policy.source !== "migration" || typeof legacyAutonomous !== "boolean") return null;
  const expected: CheckpointPolicy["default"] = legacyAutonomous ? "autonomous_allowed" : "required_human";
  return policy.default === expected ? null : `typed checkpoint_policy.default '${policy.default}' conflicts with legacy classification.autonomous=${legacyAutonomous}`;
}

export function migrationCompletionIntent(): CompletionIntent {
  return {
    mode: "complete_outcome",
    acceptance: "dod_and_artifacts",
    source: "migration",
    rationale: "Legacy workflow runs requested a completed outcome; this default grants no checkpoint permission.",
  };
}

function migrationCheckpointKind(checkpoint: string): CheckpointRuleKind {
  switch (checkpoint) {
    case "product_approval": return "product_approval";
    case "confirm_understanding":
    case "user_answers": return "clarification";
    case "user_choice": return "architecture_choice";
    case "approve_implementation":
    case "approve_fix": return "implementation_approval";
    case "fix_decision":
    case "fix_selection": return "review_fix";
    case "regression_plan_approval": return "regression_plan";
    case "confirm_contract":
    case "user_accepts": return "integration_acceptance";
    default: return "custom";
  }
}

export function migrationCheckpointPolicy(checkpoint: string): CheckpointPolicy {
  const product = checkpoint === "product_approval";
  return {
    default: "required_human",
    scope: "decision",
    hard_human: product ? ["product_approval"] : [],
    rules: {
      [checkpoint]: {
        kind: migrationCheckpointKind(checkpoint),
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

export interface WorkflowContractOptions {
  /** Require a persisted, branch-current run. Defaults to true. */
  requireState?: boolean;
  workflow?: WorkflowName;
  /** Manager-supplied canonical branch; never inferred from process cwd. */
  branch?: string;
  stageId?: string;
  maxInstructions?: number;
  /**
   * These values are produced by host validation. Contract resolution never
   * reads runtime config, searches a profile directory, or infers a provider.
   */
  policySnapshot?: Readonly<PolicySnapshot>;
  effectivePolicy?: Readonly<EffectivePolicy>;
  catalog?: Readonly<ProviderCatalog>;
  project_identity?: Readonly<ProjectIdentity>;
  run_identity?: Readonly<WorkflowRunIdentity>;
  agentInventory?: readonly AgentRef[];
}

export interface WorkflowStageContract {
  id: string;
  title: string;
  type: StageDef["type"];
  description: string;
  prompt: string;
  roles: Array<{ role: string; agent: string; agent_ref: AgentRef }>;
  parallel: boolean;
  consumes: string[];
  produces: string[];
  /** Exact JSON schemas for every declared output; null means unconstrained. */
  artifact_schemas: Record<string, JsonSchemaDef | null>;
  /** Artifact ids each dispatch slot must write before completion. */
  slot_artifacts: Record<string, string[]>;
  /** Legacy checkpoint label retained for display/migration only. */
  checkpoint: string | null;
  /** Legacy prose; never treated as authorization. */
  autonomous: string | null;
  completion_intent: CompletionIntent;
  checkpoint_policy: CheckpointPolicy | null;
  checkpoint_rule: CheckpointRule | null;
  checkpoint_decision: CheckpointDecision | TypedCheckpointDecision | null;
  roster_policy: RosterPolicy | null;
  roster_selection: RosterSelection | null;
  work_identity: WorkIdentity | null;
  pending: PendingState | null;
  child_join: ChildJoin | null;
  completion_envelope: CompletionEnvelope | null;
  gate: string | null;
  skip_if: string | null;
  loop: StageDef["loop"] | null;
  /** Executable document contract for `document` stages; null otherwise. */
  document: StageDef["document"] | null;
  dispatch: {
    permitted: boolean;
    kind: "single" | "consilium" | null;
    expected_count: number;
    capability_id: string | null;
    cursor_epoch: string | null;
    selection_id: string | null;
  };
  status: WorkflowContractStatus;
  instructions: string;
  provenance: {
    source: "workflow";
    profilePath: string | null;
    profileHash: string;
    stageHash: string;
    control_plane: ControlPlaneProvenance;
  };
}
function slotArtifactsFor(stage: StageDef, slots: Array<{ role: string; agent: string }>): Record<string, string[]> {
  const produces = Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];
  const multiSlot = stage.type === "consilium" && slots.length > 1;
  return Object.fromEntries(slots.map(({ role }) => [
    role,
    multiSlot ? produces.map(id => `${id}-${sanitizeSlot(role)}`) : produces,
  ]));
}

function artifactSchemasFor(stage: StageDef): Record<string, JsonSchemaDef | null> {
  const produces = Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];
  return Object.fromEntries(produces.map((id) => [id, artifactSchemaFor(id)]));
}

export interface WorkflowContract {
  /** The validated profile-free project identity used for this contract. */
  project_identity: ProjectIdentity;
  /** The exact prepared run identity bound to durable state and dispatch. */
  run_identity: WorkflowRunIdentity;
  workflow: WorkflowName;
  profile: { title: string; description: string; path: string | null; hash: string; source: "workflow" };
  completion_intent: CompletionIntent;
  checkpoint_policy: CheckpointPolicy | null;
  checkpoint_decision: CheckpointDecision | TypedCheckpointDecision | null;
  roster_policy: RosterPolicy | null;
  roster_selection: RosterSelection | null;
  work_identity: WorkIdentity | null;
  pending: PendingState | null;
  child_join: ChildJoin | null;
  completion_envelope: CompletionEnvelope | null;
  status: WorkflowContractStatus;
  state: {
    project_identity: ProjectIdentity;
    run_identity: WorkflowRunIdentity;
    path: string | null;
    /** Exact directory where the current run's declared artifacts must be written. */
    artifactsDir: string | null;
    branch: string;
    workflow: WorkflowName;
    profileHash: string;
    stageCursor: string;
    stageStatuses: Array<{ id: string; status: string }>;
    completion_intent: CompletionIntent;
    checkpoint_policy: CheckpointPolicy | null;
    checkpoint_decision: CheckpointDecision | TypedCheckpointDecision | null;
    roster_policy: RosterPolicy | null;
    roster_selection: RosterSelection | null;
    work_identity: WorkIdentity | null;
    pending: PendingState | null;
    child_join: ChildJoin | null;
    completion_envelope: CompletionEnvelope | null;
    status: WorkflowContractStatus;
    dispatch: {
      allowed: boolean;
      stageId: string;
      kind: "single" | "consilium" | null;
      capability: string;
      cursorEpoch?: string | null;
      selectionId?: string | null;
    };
  };
  stage: WorkflowStageContract;
  provenance: {
    statePath: string | null;
    profilePath: string | null;
    profileHash: string;
    stateHash: string;
    control_plane: ControlPlaneProvenance;
  };
}

function errorDiagnostic(code: WorkflowContractError["code"], message: string): WorkflowV2Diagnostic {
  const diagnosticCode: WorkflowV2Diagnostic["code"] =
    code === "STATE_STALE" || code === "PROFILE_MISMATCH" ? "IDENTITY_MISMATCH"
      : code === "PROFILE_MISSING" || code === "STAGE_MISSING" ? "PROFILE_UNAVAILABLE"
        : code === "POLICY_INVALID" || code === "STATE_INVALID" ? "CONFIG_MALFORMED"
          : "MIGRATION_REQUIRED";
  return createDiagnostic({
    code: diagnosticCode,
    operation: "profile.resolve",
    evidence: { field: message.match(/'([^']+)'/)?.[1] ?? null },
    remediation: "Provide unchanged selected-provider policy, catalog and identity snapshots before resolving workflow state.",
  });
}

export class WorkflowContractError extends Error {
  readonly code:
    | "STATE_MISSING"
    | "STATE_INVALID"
    | "STATE_STALE"
    | "PROFILE_MISSING"
    | "STAGE_MISSING"
    | "PROFILE_MISMATCH"
    | "POLICY_INVALID"
    | "MIGRATION_CONFLICT"
    | "MIGRATION_REQUIRED";
  readonly diagnostic: WorkflowV2Diagnostic;

  constructor(code: WorkflowContractError["code"], message: string, diagnostic?: WorkflowV2Diagnostic) {
    super(message);
    this.name = "WorkflowContractError";
    this.code = code;
    this.diagnostic = diagnostic ?? errorDiagnostic(code, message);
  }
}


function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

function instructions(stage: StageDef, max: number): string {
  const text = [
    stage.description,
    stage.prompt,
    stage.checkpoint ? `Checkpoint: ${stage.checkpoint}` : undefined,
    stage.gate ? `Gate: ${stage.gate}` : undefined,
    stage.autonomous ? `Legacy autonomous rationale (migration input only): ${stage.autonomous}` : undefined,
  ].filter(Boolean).join("\n\n").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function workflowStatus(
  state: TeamState | null,
  stageId: string,
  pending: PendingState | null,
): WorkflowContractStatus {
  const stageStatus = state?.stages.find((entry) => entry.id === stageId)?.status ?? "pending";
  const pause = state?.pause?.kind ?? "none";
  const reason = state?.pause?.reason ?? "";
  let lifecycle: WorkflowContractStatus["lifecycle"] = "ready";
  if (pending || pause === "background_wait") lifecycle = "pending";
  else if (pause === "user_checkpoint" || pause === "needs_human") lifecycle = "paused";
  else if (pause === "failed" || stageStatus === "failed") lifecycle = "failed";
  else if (stageStatus === "done" || pause === "done") lifecycle = "complete";
  else if (stageStatus === "skipped") lifecycle = "skipped";
  else if (pause !== "none" && pause !== "done") lifecycle = "blocked";
  return { stage: stageStatus, lifecycle, pause, reason };
}

function controlPlaneProvenance(
  intent: ControlPlaneFieldSource,
  checkpointPolicy: ControlPlaneFieldSource,
  rosterPolicy: ControlPlaneFieldSource,
  selection: ControlPlaneFieldSource,
  identity: ControlPlaneFieldSource,
  pending: ControlPlaneFieldSource,
  childJoin: ControlPlaneFieldSource,
  completionEnvelope: ControlPlaneFieldSource,
  legacyInputs: string[],
  warnings: string[],
): ControlPlaneProvenance {
  const status: ControlPlaneMigrationStatus = legacyInputs.length > 0 || [intent, checkpointPolicy, rosterPolicy, selection, identity, pending, childJoin, completionEnvelope].includes("migration")
    ? "migrated"
    : "typed";
  return {
    completion_intent: intent,
    checkpoint_policy: checkpointPolicy,
    roster_policy: rosterPolicy,
    roster_selection: selection,
    work_identity: identity,
    pending,
    child_join: childJoin,
    completion_envelope: completionEnvelope,
    legacy_inputs: legacyInputs,
    warnings,
    status,
  };
}

function validationMessage(label: string, result: TypedContractValidationResult): string {
  if (result.ok) return "";
  return `${label}: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`;
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
type WorkIdentityComparable = {
  run_id: string;
  wave_id: string;
  slice_id: string;
  session_id: string;
  workflow: string;
  stage_id: string;
  stage_cursor: string;
  capability_id: string;
  capability_epoch: string;
  slot_id: string;
  task_id: string;
  dispatch_id: string;
  attempt: number;
  worker_id: string;
};
function isWorkIdentityComparable(value: UnknownRecord): value is WorkIdentityComparable {
  return hasOwn(value, "run_id") && nonEmptyString(value.run_id)
    && hasOwn(value, "wave_id") && nonEmptyString(value.wave_id)
    && hasOwn(value, "slice_id") && nonEmptyString(value.slice_id)
    && hasOwn(value, "session_id") && nonEmptyString(value.session_id)
    && hasOwn(value, "workflow") && nonEmptyString(value.workflow)
    && hasOwn(value, "stage_id") && nonEmptyString(value.stage_id)
    && hasOwn(value, "stage_cursor") && nonEmptyString(value.stage_cursor)
    && hasOwn(value, "capability_id") && nonEmptyString(value.capability_id)
    && hasOwn(value, "capability_epoch") && nonEmptyString(value.capability_epoch)
    && hasOwn(value, "slot_id") && nonEmptyString(value.slot_id)
    && hasOwn(value, "task_id") && nonEmptyString(value.task_id)
    && hasOwn(value, "dispatch_id") && nonEmptyString(value.dispatch_id)
    && hasOwn(value, "attempt") && typeof value.attempt === "number"
    && Number.isInteger(value.attempt) && value.attempt > 0
    && hasOwn(value, "worker_id") && nonEmptyString(value.worker_id);
}
function sameWorkIdentity(left: WorkIdentityComparable, right: WorkIdentityComparable): boolean {
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


function requiredValidatedContext(cwd: string, options: WorkflowContractOptions): {
  policySnapshot: Readonly<PolicySnapshot>;
  effectivePolicy: Readonly<EffectivePolicy>;
  catalog: Readonly<ProviderCatalog>;
  project_identity: ProjectIdentity;
  run_identity?: WorkflowRunIdentity;
  agentInventory: readonly AgentRef[];
} {
  const policySnapshot = options.policySnapshot;
  const effectivePolicy = options.effectivePolicy;
  const catalog = options.catalog;
  const project_identity = options.project_identity;
  const agentInventory = options.agentInventory;
  if (!policySnapshot || !effectivePolicy || !catalog || !project_identity || !agentInventory) {
    throw new WorkflowContractError(
      "MIGRATION_REQUIRED",
      "workflow contract requires the immutable policy, provider catalog, qualified agent inventory, and project identity from host admission",
    );
  }
  if (!Array.isArray(agentInventory)) {
    throw new WorkflowContractError("POLICY_INVALID", "qualified provider agent inventory is malformed");
  }
  const checkedProject = validateProjectIdentity(project_identity);
  if (!checkedProject.ok) {
    throw new WorkflowContractError("POLICY_INVALID", "project identity is malformed", checkedProject.diagnostics[0]);
  }
  const checkedRun = options.run_identity === undefined ? null : validateWorkflowRunIdentity(options.run_identity);
  if (checkedRun && !checkedRun.ok) {
    throw new WorkflowContractError("POLICY_INVALID", "workflow run identity is malformed", checkedRun.diagnostics[0]);
  }
  if (checkedRun && checkedRun.ok && !sameProjectIdentity(checkedProject.value, checkedRun.value)) {
    throw new WorkflowContractError("PROFILE_MISMATCH", "workflow run identity does not inherit the admitted project identity");
  }
  if (typeof policySnapshot.root !== "string" || policySnapshot.root !== cwd) {
    throw new WorkflowContractError("PROFILE_MISMATCH", "validated policy root does not match the workflow contract root");
  }
  const provider = effectivePolicy.provider;
  const documentProvider = policySnapshot.document?.provider;
  if (
    !provider
    || !documentProvider
    || provider.id !== documentProvider.id
    || provider.protocol_version !== documentProvider.protocol_version
    || provider.descriptor_fingerprint !== documentProvider.descriptor_fingerprint
    || provider.catalog_content_digest !== documentProvider.catalog_content_digest
    || provider.id !== checkedProject.value.provider_id
    || provider.descriptor_fingerprint !== checkedProject.value.descriptor_fingerprint
    || provider.catalog_content_digest !== checkedProject.value.catalog_content_digest
    || catalog.content_digest !== checkedProject.value.catalog_content_digest
  ) {
    throw new WorkflowContractError("PROFILE_MISMATCH", "policy, provider catalog, and project identity are not the same immutable selection");
  }
  if (
    policySnapshot.byte_sha256 !== checkedProject.value.config_byte_sha256
    || policySnapshot.semantic_sha256 !== checkedProject.value.config_semantic_sha256
  ) {
    throw new WorkflowContractError("PROFILE_MISMATCH", "policy snapshot digest does not match the project identity");
  }
  for (const candidate of agentInventory) {
    if (
      !candidate
      || typeof candidate.registered_name !== "string"
      || candidate.registered_name.trim().length === 0
      || candidate.provider_id !== provider.id
      || !isProviderId(candidate.provider_id)
      || !isWorkflowV2Digest(candidate.source_fingerprint)
    ) {
      throw new WorkflowContractError("POLICY_INVALID", "qualified provider agent inventory contains an invalid or unselected-provider identity");
    }
  }
  for (const [role, ref] of Object.entries(effectivePolicy.roles ?? {})) {
    if (
      !ref
      || ref.provider_id !== provider.id
      || !isProviderId(ref.provider_id)
      || !isWorkflowV2Digest(ref.source_fingerprint)
    ) {
      throw new WorkflowContractError("POLICY_INVALID", `policy role '${role}' is not a qualified agent for the selected provider`);
    }
    const observed = agentInventory.find((candidate) =>
      candidate.registered_name === ref.registered_name
      && candidate.provider_id === ref.provider_id
      && candidate.source_fingerprint === ref.source_fingerprint
    );
    if (!observed) {
      throw new WorkflowContractError("POLICY_INVALID", `policy role '${role}' is absent from the selected provider inventory`);
    }
  }
  for (const rule of effectivePolicy.scope_map ?? []) {
    const ref = rule?.dev_agent;
    const observed = ref && agentInventory.find((candidate) =>
      candidate.registered_name === ref.registered_name
      && candidate.provider_id === ref.provider_id
      && candidate.source_fingerprint === ref.source_fingerprint
    );
    if (!ref || !observed || ref.provider_id !== provider.id) {
      throw new WorkflowContractError("POLICY_INVALID", `scope rule '${rule?.scope ?? ""}' has no matching qualified provider agent`);
    }
  }
  return {
    policySnapshot,
    effectivePolicy,
    catalog,
    project_identity: checkedProject.value,
    run_identity: checkedRun?.ok ? checkedRun.value : undefined,
    agentInventory,
  };
}

/** Resolve the persisted run, profile and current stage into one bounded, typed contract. */
export function resolveWorkflowContract(cwd: string, options: WorkflowContractOptions = {}): WorkflowContract {
  const expectedBranch = options.branch?.trim();
  if (!expectedBranch) {
    throw new WorkflowContractError("MIGRATION_REQUIRED", "workflow contract requires the canonical branch from the active session manager");
  }
  const context = requiredValidatedContext(cwd, options);
  const resolved = resolveState(cwd, expectedBranch, context.run_identity);
  if (resolved.invalid) {
    const diagnostic = resolved.diagnostics?.[0];
    const code = diagnostic?.code === "IDENTITY_MISMATCH"
      ? "STATE_STALE"
      : diagnostic?.code === "MIGRATION_REQUIRED"
        ? "MIGRATION_REQUIRED"
        : "STATE_INVALID";
    const message = diagnostic
      ? `${diagnostic.code}: ${diagnostic.remediation}`
      : "workflow state is malformed or unsafe";
    throw new WorkflowContractError(code, message, diagnostic);
  }
  if (resolved.isLegacy) {
    throw new WorkflowContractError("MIGRATION_REQUIRED", "legacy workflow state is not an authority for provider-v2 contract resolution");
  }
  const state = resolved.state;
  if (options.requireState !== false && (!state || !resolved.statePath)) {
    throw new WorkflowContractError("STATE_MISSING", "workflow contract requires an active persisted state");
  }
  if (state && (!state.project_identity || !state.run_identity)) {
    throw new WorkflowContractError("MIGRATION_REQUIRED", "persisted workflow state has no complete project and run identity");
  }
  if (state && !sameProjectIdentity(state.project_identity, context.project_identity)) {
    throw new WorkflowContractError("STATE_STALE", "persisted workflow project identity differs from the admitted project identity");
  }
  if (state && context.run_identity && !sameRunIdentity(state.run_identity, context.run_identity)) {
    throw new WorkflowContractError("STATE_STALE", "persisted workflow run identity differs from the requested run identity");
  }
  if (state && resolved.isStale) {
    throw new WorkflowContractError("STATE_STALE", `workflow state branch '${state.branch}' is stale (current '${expectedBranch}')`);
  }
  if (state) {
    const stateValidation = validateTypedControlPlane(state);
    if (!stateValidation.ok) throw new WorkflowContractError("POLICY_INVALID", validationMessage("persisted typed contract", stateValidation));
    const classificationValidation = validateTypedControlPlane(state.classification);
    if (!classificationValidation.ok) throw new WorkflowContractError("POLICY_INVALID", validationMessage("classification typed contract", classificationValidation));
    if (state.completion_intent && state.classification.completion_intent && hash(state.completion_intent) !== hash(state.classification.completion_intent)) {
      throw new WorkflowContractError("MIGRATION_CONFLICT", "persisted completion_intent conflicts with classification.completion_intent");
    }
  }
  const run_identity = state?.run_identity ?? context.run_identity;
  if (!run_identity) {
    throw new WorkflowContractError("MIGRATION_REQUIRED", "workflow contract requires the exact prepared run identity");
  }
  const workflow = options.workflow ?? state?.classification?.workflow ?? run_identity.profile_identity.id;
  if (!workflow) {
    throw new WorkflowContractError(
      options.requireState === false ? "PROFILE_MISSING" : "STATE_MISSING",
      options.requireState === false ? "stateless workflow contract requires options.workflow" : "workflow state is missing",
    );
  }
  if (state && options.workflow && options.workflow !== state.classification?.workflow) {
    throw new WorkflowContractError("PROFILE_MISMATCH", "requested workflow does not match persisted classification");
  }
  if (run_identity.profile_identity.id !== workflow) {
    throw new WorkflowContractError("PROFILE_MISMATCH", `workflow '${workflow}' does not match the selected catalog profile`);
  }
  const loadedProfile = loadProfileByIdentity(context.catalog, run_identity.profile_identity);
  if (!loadedProfile.ok) {
    throw new WorkflowContractError("PROFILE_MISSING", `workflow profile '${workflow}' is unavailable`, loadedProfile.diagnostics[0]);
  }
  const profile = loadedProfile.value;
  const profileValidation = validateTypedControlPlane(profile);
  if (!profileValidation.ok) throw new WorkflowContractError("POLICY_INVALID", validationMessage(`workflow profile '${workflow}'`, profileValidation));
  const path = null;
  const pHash = run_identity.profile_identity.fingerprint;
  const persistedHash = state?.profile_hash;
  if (persistedHash && persistedHash !== pHash) throw new WorkflowContractError("PROFILE_MISMATCH", "persisted profile hash is stale");
  const stageId = options.stageId ?? state?.stage_cursor ?? profile.stages.find((candidate) => candidate.id.length > 0)?.id;
  const stage = profile.stages.find(candidate => candidate.id === stageId);
  if (!stage) throw new WorkflowContractError("STAGE_MISSING", `stage cursor '${stageId ?? ""}' is not present in '${workflow}'`);
  const stageValidation = validateTypedControlPlane(stage);
  if (!stageValidation.ok) throw new WorkflowContractError("POLICY_INVALID", validationMessage(`workflow stage '${stage.id}'`, stageValidation));

  const flags = state?.scope ?? {
    scope: [],
    has_security: Boolean(context.effectivePolicy.flags.has_security),
    has_infra: Boolean(context.effectivePolicy.flags.has_infra),
    has_ui: Boolean(context.effectivePolicy.flags.has_ui),
    has_runtime: Boolean(context.effectivePolicy.flags.has_runtime),
    dev_agent: null,
  };
  let slots: DispatchSlot[];
  try {
    slots = resolveStageDispatchSlots(stage, {
      cwd,
      flags,
      state: state ?? undefined,
      project_identity: context.project_identity,
      run_identity,
      catalog: context.catalog,
      effectivePolicy: context.effectivePolicy,
      agentInventory: context.agentInventory,
      resolveDevAgent: () => flags.dev_agent,
    });
  } catch (error) {
    if (error instanceof WorkflowStageIdentityError) {
      throw new WorkflowContractError("POLICY_INVALID", error.message, error.diagnostic);
    }
    throw error;
  }
  const kind = stage.type === "single" || stage.type === "consilium" ? stage.type : null;
  const statuses = state?.stages.map(item => ({ id: item.id, status: item.status }))
    ?? profile.stages.map(item => ({ id: item.id, status: "pending" }));
  const capability = state?.dispatch_capability;
  if (capability) {
    const capabilityValidation = validateTypedControlPlane(capability);
    if (!capabilityValidation.ok) throw new WorkflowContractError("POLICY_INVALID", validationMessage("dispatch capability typed contract", capabilityValidation));
    if (
      !capability.project_identity
      || !capability.run_identity
      || !sameProjectIdentity(capability.project_identity, context.project_identity)
      || !sameRunIdentity(capability.run_identity, run_identity)
    ) {
      throw new WorkflowContractError("STATE_STALE", "dispatch capability identity differs from the admitted project/run identity");
    }
  }

  const intentCandidate = state?.completion_intent ?? stage.completion_intent ?? profile.completion_intent;
  const completion_intent = intentCandidate ?? migrationCompletionIntent();
  const intentSource: ControlPlaneFieldSource = state?.completion_intent
    ? "state"
    : stage.completion_intent || profile.completion_intent
      ? "profile"
      : "migration";

  const policyCandidate = state?.checkpoint_policy ?? stage.checkpoint_policy ?? profile.checkpoint_policy;
  const checkpoint_policy = policyCandidate ?? (stage.checkpoint ? migrationCheckpointPolicy(stage.checkpoint) : null);
  const checkpointPolicySource: ControlPlaneFieldSource = state?.checkpoint_policy
    ? "state"
    : stage.checkpoint_policy || profile.checkpoint_policy
      ? "profile"
      : stage.checkpoint
        ? "migration"
        : "none";
  const checkpoint_rule = stage.checkpoint
    ? checkpoint_policy?.rules[stage.checkpoint] ?? null
    : null;
  const typedCheckpointDecision = stage.checkpoint
    ? state?.typed_checkpoint_decisions?.find((decision) =>
      decision.stage_id === stage.id && decision.checkpoint_id === stage.checkpoint,
    ) ?? null
    : null;
  const checkpoint_decision: CheckpointDecision | TypedCheckpointDecision | null = typedCheckpointDecision
    ?? (stage.checkpoint
      ? state?.checkpoint_decisions?.find((decision) =>
        decision.stage_id === stage.id && decision.checkpoint === stage.checkpoint,
      ) ?? null
      : null);
  if (stage.checkpoint && !checkpoint_rule) {
    throw new WorkflowContractError("POLICY_INVALID", `checkpoint policy has no rule for '${stage.checkpoint}'`);
  }
  const roster_policy = stage.roster_policy ?? null;
  const capabilitySelection = capability?.roster_selection ?? null;
  const stateSelection = state?.roster_selection ?? null;
  if (stateSelection && capabilitySelection && hash(stateSelection) !== hash(capabilitySelection)) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "state roster_selection conflicts with capability roster_selection");
  }
  const roster_selection = stateSelection ?? capabilitySelection;
  const capabilityIdentity = capability?.work_identity ?? null;
  const stateIdentity = state?.work_identity ?? null;
  if (stateIdentity && capabilityIdentity && !sameWorkIdentity(stateIdentity, capabilityIdentity)) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "state work_identity conflicts with capability work_identity");
  }
  const work_identity = stateIdentity ?? capabilityIdentity;
  const capabilityPending = capability?.pending ?? [];
  if (capabilityPending.length > 1 && !state?.pending && !capabilityIdentity) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "capability pending lifecycle is ambiguous without work_identity");
  }
  const pending = state?.pending
    ?? capabilityPending.find((candidate) => !capabilityIdentity || candidate.identity.dispatch_id === capabilityIdentity.dispatch_id)
    ?? null;
  if (capabilityIdentity && capabilityPending.length > 0 && !pending) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "capability pending lifecycle has no matching work_identity");
  }
  const child_join = state?.child_join ?? null;
  const completion_envelope = state?.completion_envelope ?? null;
  if (pending && completion_envelope && (pending.status === "pending") !== (completion_envelope.outcome === "pending")) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "pending lifecycle and completion_envelope outcomes conflict");
  }
  const selectionRequired = roster_policy !== null;
  const selectionReady = !selectionRequired || roster_selection !== null;
  const capabilityStatus = capability?.status;
  const roleAgents = slots.map((slot) => {
    const ref = context.effectivePolicy.roles[slot.role];
    if (!ref) {
      throw new WorkflowContractError("POLICY_INVALID", `stage role '${slot.role}' has no exact qualified policy mapping`);
    }
    const observed = context.agentInventory.find((candidate) =>
      candidate.registered_name === ref.registered_name
      && candidate.provider_id === ref.provider_id
      && candidate.source_fingerprint === ref.source_fingerprint
    );
    if (!observed) {
      throw new WorkflowContractError("POLICY_INVALID", `stage role '${slot.role}' has no matching qualified provider inventory entry`);
    }
    return { role: slot.slot, agent: ref.registered_name, agent_ref: ref };
  });
  const dispatchAllowed = state !== null &&
    kind !== null &&
    selectionReady &&
    roleAgents.length === slots.length &&
    (capabilityStatus === "ready" || capabilityStatus === "dispatched");
  const status = workflowStatus(state, stage.id, pending);
  const legacyInputs = [
    state?.classification?.autonomous !== undefined ? "classification.autonomous" : null,
    state?.autonomous !== undefined ? "TeamState.autonomous" : null,
    stage.autonomous ? "stage.autonomous" : null,
    !intentCandidate ? "completion_intent" : null,
    !policyCandidate && stage.checkpoint ? "checkpoint_policy" : null,
  ].filter((input): input is string => input !== null);
  const warnings = [
    stage.autonomous ? "stage.autonomous is display/migration input only" : null,
    !roster_selection && roster_policy ? "adaptive stage awaits a frozen roster_selection before dispatch" : null,
  ].filter((warning): warning is string => warning !== null);
  const control_plane = controlPlaneProvenance(
    intentSource,
    checkpointPolicySource,
    roster_policy ? "profile" : "legacy",
    roster_selection ? (stateSelection ? "state" : "typed") : "none",
    work_identity ? (stateIdentity ? "state" : "typed") : "none",
    pending ? (state?.pending ? "state" : "typed") : "none",
    child_join ? "state" : "none",
    completion_envelope ? "state" : "none",
    legacyInputs,
    warnings,
  );
  const stageContract: WorkflowStageContract = {
    id: stage.id,
    title: stage.title,
    type: stage.type,
    description: stage.description ?? "",
    prompt: stage.prompt ?? "",
    roles: roleAgents,
    parallel: stage.parallel ?? stage.type === "consilium",
    consumes: stage.consumes ?? [],
    produces: typeof stage.produces === "string" ? [stage.produces] : stage.produces ?? [],
    artifact_schemas: artifactSchemasFor(stage),
    checkpoint_decision,
    slot_artifacts: slotArtifactsFor(stage, roleAgents),
    checkpoint: stage.checkpoint ?? null,
    autonomous: stage.autonomous ?? null,
    completion_intent,
    checkpoint_policy,
    checkpoint_rule,
    roster_policy,
    roster_selection,
    work_identity,
    pending,
    child_join,
    completion_envelope,
    gate: stage.gate ?? null,
    skip_if: stage.skip_if ?? null,
    loop: stage.loop ?? null,
    document: stage.document ?? null,
    dispatch: {
      permitted: dispatchAllowed,
      kind,
      expected_count: capability?.expected_count ?? roster_selection?.selected.length ?? slots.length,
      capability_id: capability?.capability_id ?? null,
      cursor_epoch: state?.cursor_epoch ?? null,
      selection_id: roster_selection?.snapshot_id ?? null,
    },
    status,
    instructions: instructions(stage, options.maxInstructions ?? 4000),
    provenance: { source: "workflow", profilePath: path, profileHash: pHash, stageHash: hash(stage), control_plane },
  };
  const stateRaw = resolved.statePath ? readFileSync(resolved.statePath, "utf8") : null;
  const stateHash = stateRaw
    ? hash(JSON.parse(stateRaw))
    : hash({ source: "stateless", workflow, stage: stage.id, profileHash: pHash });
  return {
    workflow,
    project_identity: context.project_identity,
    run_identity,
    profile: { title: profile.title, description: profile.description, path, hash: pHash, source: "workflow" },
    completion_intent,
    checkpoint_policy,
    checkpoint_decision,
    roster_policy,
    roster_selection,
    work_identity,
    pending,
    child_join,
    completion_envelope,
    status,
    state: {
      project_identity: context.project_identity,
      run_identity,
      path: resolved.statePath,
      artifactsDir: resolved.artifactsDir,
      branch: state?.branch ?? expectedBranch,
      workflow,
      profileHash: pHash,
      stageCursor: state?.stage_cursor ?? stage.id,
      stageStatuses: statuses,
      completion_intent,
      checkpoint_policy,
      checkpoint_decision,
      roster_policy,
      roster_selection,
      work_identity,
      pending,
      child_join,
      completion_envelope,
      status,
      dispatch: {
        allowed: dispatchAllowed,
        stageId: stage.id,
        kind,
        capability: kind ? `task:${kind}` : "none",
        cursorEpoch: state?.cursor_epoch ?? null,
        selectionId: roster_selection?.snapshot_id ?? null,
      },
    },
    stage: stageContract,
    provenance: { statePath: resolved.statePath, profilePath: path, profileHash: pHash, stateHash, control_plane },
  };
}

export function resolveStageInstructions(cwd: string, options: WorkflowContractOptions = {}): WorkflowStageContract {
  return resolveWorkflowContract(cwd, options).stage;
}
