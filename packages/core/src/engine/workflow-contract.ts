import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadProfile, profileHash as sharedProfileHash, resolveWorkflowProfilePath } from "./profile.js";
import { resolveConfig, resolveAgentForRole } from "./config.js";
import { resolveScope } from "./scope.js";
import { resolveActiveBranch, resolveState } from "./state.js";
import { resolveStageDispatchSlots } from "./stage.js";
import { sanitizeSlot } from "./fan-in.js";
import { artifactSchemaFor, type JsonSchemaDef } from "./artifact-contract.js";
import {
  checkpointPolicyHash,
  findCurrentCheckpointDecision,
  resolveCheckpointDeclaration,
  type CheckpointDeclarationResolution,
} from "./checkpoints.js";
import {
  isRecord,
  validateActiveCapabilityStateBinding,
  validateActiveDispatchCapabilityValue,
  validateCheckpointAnswerProofValue,
  validateCheckpointDecisionValue,
  validateCheckpointPolicyValue,
  validateCheckpointRuleValue,
  validateTypedCheckpointDecisionValue,
  validateTrustedCheckpointAnswerValue,
  validateDispatchCapabilityValue,
  validatePendingStateValue,
  validateWorkIdentityValue,
  type ControlPlaneIssue,
} from "./control-plane-contract.js";
import type {
  CheckpointDeclaration,
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
  RosterPolicy,
  RosterSelection,
  StageDef,
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

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addIssue(issues: TypedContractIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

/** Push the shared control-plane validation result into the local issue list. */
function pushShared(issues: TypedContractIssue[], result: { ok: true } | { ok: false; issues: ControlPlaneIssue[] }): void {
  if (!result.ok) issues.push(...result.issues);
}

function unknownKeys(value: UnknownRecord, allowed: readonly string[], path: string, issues: TypedContractIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) addIssue(issues, `${path}.${key}`, "unknown field");
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireString(value: UnknownRecord, key: string, path: string, issues: TypedContractIssue[]): void {
  if (!nonEmptyString(value[key])) addIssue(issues, `${path}.${key}`, "must be a non-empty string");
}

function requireEnum(value: UnknownRecord, key: string, allowed: readonly string[], path: string, issues: TypedContractIssue[]): void {
  if (typeof value[key] !== "string" || !allowed.includes(value[key] as string)) {
    addIssue(issues, `${path}.${key}`, `must be one of ${allowed.join(", ")}`);
  }
}

function requireInteger(value: UnknownRecord, key: string, path: string, issues: TypedContractIssue[], minimum = 0): void {
  if (!Number.isInteger(value[key]) || (value[key] as number) < minimum) {
    addIssue(issues, `${path}.${key}`, `must be an integer >= ${minimum}`);
  }
}

function stringArray(value: unknown, path: string, issues: TypedContractIssue[], required = true): string[] | null {
  if (value === undefined && !required) return null;
  if (!Array.isArray(value) || value.some((item) => !nonEmptyString(item))) {
    addIssue(issues, path, "must be an array of non-empty strings");
    return null;
  }
  const result = value as string[];
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
  pushShared(issues, validateCheckpointRuleValue(value, path, { allowPendingDecisions, hardHuman }));
}

function validateCheckpointPolicy(value: unknown, path: string, issues: TypedContractIssue[]): void {
  pushShared(issues, validateCheckpointPolicyValue(value, path));
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

function validateWorkIdentity(value: unknown, path: string, issues: TypedContractIssue[]): void {
  pushShared(issues, validateWorkIdentityValue(value, path));
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
  pushShared(issues, validatePendingStateValue(value, path, "single"));
}

function validateChildJoin(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["parent", "child", "state", "expected_artifact_ids", "completion_envelope_ref", "attempt", "created_at", "joined_at"], path, issues);
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

function validateCompletionEnvelope(value: unknown, path: string, issues: TypedContractIssue[]): void {
  if (!isRecord(value)) {
    addIssue(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["schema_version", "identity", "outcome", "terminal_signal", "artifact_refs", "evidence_ref", "conflict_ref", "completed_by", "emitted_at"], path, issues);
  if (value.schema_version !== 1) addIssue(issues, `${path}.schema_version`, "must be 1");
  validateWorkIdentity(value.identity, `${path}.identity`, issues);
  requireEnum(value, "outcome", ["pending", "succeeded", "failed", "cancelled"], path, issues);
  if (!hasOwn(value, "terminal_signal") || (value.terminal_signal !== null && value.terminal_signal !== undefined && !["workflow_complete", "native_tool_result", "provider_terminal", "contract_failure"].includes(value.terminal_signal as string))) {
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

function validateCheckpointAnswerProof(value: unknown, path: string, issues: TypedContractIssue[]): void {
  pushShared(issues, validateCheckpointAnswerProofValue(value, path));
}

function validateTrustedCheckpointAnswer(value: unknown, path: string, issues: TypedContractIssue[]): void {
  pushShared(issues, validateTrustedCheckpointAnswerValue(value, path));
}

function validateCheckpointDecision(value: unknown, path: string, issues: TypedContractIssue[]): void {
  pushShared(issues, validateCheckpointDecisionValue(value, path));
}

function validateTypedCheckpointDecision(value: unknown, path: string, issues: TypedContractIssue[]): void {
  // Persisted decisions from before the loop-scoped ledger keep their audit
  // readability (the same allowance the state-field boundary applies):
  // `loop_iteration` may be absent on such records. They never authorize —
  // the ledger boundary enforces the full scope on every authorizing read —
  // but a readable pre-loop state must not be rejected as POLICY_INVALID
  // merely for missing additive fields.
  pushShared(issues, validateTypedCheckpointDecisionValue(value, path, { allowLegacyLoopScope: true }));
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
 * The nested dispatch-capability contract, single-sourced in
 * `control-plane-contract.ts`. Deliberately distinct from the root-state
 * contract: `pending` is the capability's `PendingState[]` lifecycle log
 * here, while the root state keeps a single `PendingState` object.
 */
function validateDispatchCapabilityFields(value: unknown, path: string, issues: TypedContractIssue[]): void {
  pushShared(issues, validateDispatchCapabilityValue(value, path));
}

/**
 * Standalone validation of a persisted dispatch capability under the
 * array-aware nested contract. The root-state contract
 * (`validateTypedControlPlane`) must never be applied to a bare capability:
 * its `pending` is a legal `PendingState[]` lifecycle log.
 *
 * API boundary: intentionally NOT re-exported from the package barrel.
 */
export function validateDispatchCapability(value: unknown): TypedContractValidationResult {
  const issues: TypedContractIssue[] = [];
  validateDispatchCapabilityFields(value, "$", issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

/**
 * Validate only canonical typed fields. Legacy top-level fields are ignored
 * here and are handled by the explicit migration/conflict path below.
 */
export function validateTypedControlPlane(value: unknown): TypedContractValidationResult {
  if (!isRecord(value)) return { ok: false, issues: [{ path: "$", message: "typed control-plane input must be an object" }] };
  const issues: TypedContractIssue[] = [];
  if (hasOwn(value, "completion_intent")) validateCompletionIntent(value.completion_intent, "$.completion_intent", issues);
  if (hasOwn(value, "checkpoint_policy")) validateCheckpointPolicy(value.checkpoint_policy, "$.checkpoint_policy", issues);
  if (hasOwn(value, "roster_policy")) validateRosterPolicy(value.roster_policy, "$.roster_policy", issues);
  if (hasOwn(value, "roster_selection")) validateRosterSelection(value.roster_selection, "$.roster_selection", issues);
  if (hasOwn(value, "roster_selections")) {
    if (!isRecord(value.roster_selections)) addIssue(issues, "$.roster_selections", "must be an object");
    else for (const [stage, selection] of Object.entries(value.roster_selections)) validateRosterSelection(selection, `$.roster_selections.${stage}`, issues);
  }
  if (hasOwn(value, "work_identity")) validateWorkIdentity(value.work_identity, "$.work_identity", issues);
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
  if (hasOwn(value, "migration")) validateMigrationReceipt(value.migration, "$.migration", issues);
  if (hasOwn(value, "checkpoint_decisions")) {
    if (!Array.isArray(value.checkpoint_decisions)) addIssue(issues, "$.checkpoint_decisions", "must be an array");
    else value.checkpoint_decisions.forEach((decision, index) => validateCheckpointDecision(decision, `$.checkpoint_decisions[${index}]`, issues));
  }
  if (hasOwn(value, "dispatch_capability")) {
    validateDispatchCapabilityFields(value.dispatch_capability, "$.dispatch_capability", issues);
  }
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
  branch?: string;
  stageId?: string;
  maxInstructions?: number;
}

export interface WorkflowStageContract {
  id: string;
  title: string;
  type: StageDef["type"];
  description: string;
  prompt: string;
  roles: Array<{ role: string; agent: string }>;
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

export class WorkflowContractError extends Error {
  readonly code:
    | "STATE_MISSING"
    | "STATE_INVALID"
    | "STATE_STALE"
    | "PROFILE_MISSING"
    | "STAGE_MISSING"
    | "PROFILE_MISMATCH"
    | "POLICY_INVALID"
    | "MIGRATION_CONFLICT";
  constructor(code: WorkflowContractError["code"], message: string) {
    super(message);
    this.name = "WorkflowContractError";
    this.code = code;
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

/** Resolve the persisted run, profile and current stage into one bounded, typed contract. */
export function resolveWorkflowContract(cwd: string, options: WorkflowContractOptions = {}): WorkflowContract {
  const expectedBranch = options.branch ?? resolveActiveBranch(cwd);
  const resolved = resolveState(cwd, expectedBranch);
  if (resolved.invalid) throw new WorkflowContractError("STATE_INVALID", "workflow state is malformed or unsafe");
  const state = resolved.state as TeamState | null;
  if (options.requireState !== false && (!state || !resolved.statePath)) {
    throw new WorkflowContractError("STATE_MISSING", "workflow contract requires an active persisted state");
  }
  if (state && resolved.isStale) {
    throw new WorkflowContractError("STATE_STALE", `workflow state branch '${state.branch}' is stale (current '${expectedBranch ?? "unknown"}')`);
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
  const workflow = options.workflow ?? state?.classification?.workflow;
  if (!workflow) {
    throw new WorkflowContractError(
      options.requireState === false ? "PROFILE_MISSING" : "STATE_MISSING",
      options.requireState === false ? "stateless workflow contract requires options.workflow" : "workflow state is missing",
    );
  }
  if (state && options.workflow && options.workflow !== state.classification?.workflow) {
    throw new WorkflowContractError("PROFILE_MISMATCH", "requested workflow does not match persisted classification");
  }
  const profile = loadProfile(workflow);
  if (!profile) throw new WorkflowContractError("PROFILE_MISSING", `workflow profile '${workflow}' is unavailable`);
  const profileValidation = validateTypedControlPlane(profile);
  if (!profileValidation.ok) throw new WorkflowContractError("POLICY_INVALID", validationMessage(`workflow profile '${workflow}'`, profileValidation));
  const path = resolveWorkflowProfilePath(workflow, cwd);
  const pHash = sharedProfileHash(profile);
  const persistedHash = state?.profile_hash;
  if (persistedHash && persistedHash !== pHash) throw new WorkflowContractError("PROFILE_MISMATCH", "persisted profile hash is stale");
  const stageId = options.stageId ?? state?.stage_cursor ?? profile.stages.find((candidate) => candidate.id.length > 0)?.id;
  const stage = profile.stages.find(candidate => candidate.id === stageId);
  if (!stage) throw new WorkflowContractError("STAGE_MISSING", `stage cursor '${stageId ?? ""}' is not present in '${workflow}'`);
  const stageValidation = validateTypedControlPlane(stage);
  if (!stageValidation.ok) throw new WorkflowContractError("POLICY_INVALID", validationMessage(`workflow stage '${stage.id}'`, stageValidation));

  const config = resolveConfig(cwd);
  const flags = state?.scope ?? resolveScope([], config);
  const slots = resolveStageDispatchSlots(stage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
  const kind = stage.type === "single" || stage.type === "consilium" ? stage.type : null;
  const statuses = state?.stages.map(item => ({ id: item.id, status: item.status }))
    ?? profile.stages.map(item => ({ id: item.id, status: "pending" }));
  const capability = state?.dispatch_capability;
  if (capability) {
    // The nested capability contract, never the root-state contract: the
    // capability's `pending` is a legal `PendingState[]` lifecycle log and
    // must not be revalidated as the root state's single object.
    const capabilityValidation = validateDispatchCapability(capability);
    if (!capabilityValidation.ok) throw new WorkflowContractError("POLICY_INVALID", validationMessage("dispatch capability typed contract", capabilityValidation));
  }

  const intentCandidate = state?.completion_intent ?? stage.completion_intent ?? profile.completion_intent;
  const completion_intent = intentCandidate ?? migrationCompletionIntent();
  const intentSource: ControlPlaneFieldSource = state?.completion_intent
    ? "state"
    : stage.completion_intent || profile.completion_intent
      ? "profile"
      : "migration";

  // The CURRENT stage/profile declaration is authoritative for exposure: it
  // is resolved through resolveCheckpointDeclaration, which honors the
  // persisted mirror only while its binding names THIS stage with the
  // current profile hash. A prior-stage (or unbound) mirror is stale data
  // and is never reported as this stage's policy — a prior iteration/epoch
  // cannot dress up as the current contract.
  let currentDeclaration: CheckpointDeclaration | null = null;
  let declarationConflict = false;
  if (stage.checkpoint) {
    let resolution: CheckpointDeclarationResolution;
    if (!state) {
      const declared = stage.checkpoint_policy ?? profile.checkpoint_policy ?? null;
      resolution = declared
        ? { ok: true, declaration: { stage_id: stage.id, checkpoint_id: stage.checkpoint, policy: declared, rule: declared.rules[stage.checkpoint]!, policy_hash: checkpointPolicyHash(declared) } }
        : { ok: true, declaration: null };
    } else {
      resolution = resolveCheckpointDeclaration(stage, profile.checkpoint_policy, state, "authorize");
    }
    if (resolution.ok) {
      currentDeclaration = resolution.declaration;
    } else if (resolution.code === "policy_conflict") {
      // Read paths stay audit-readable: an ACTIVE binding that contradicts
      // the declared policy surfaces the declared policy plus an explicit
      // warning here. The engine still fails closed (policy_conflict) on
      // every authorizing use of that state.
      declarationConflict = true;
      const declared = stage.checkpoint_policy ?? profile.checkpoint_policy ?? migrationCheckpointPolicy(stage.checkpoint);
      currentDeclaration = { stage_id: stage.id, checkpoint_id: stage.checkpoint, policy: declared, rule: declared.rules[stage.checkpoint]!, policy_hash: checkpointPolicyHash(declared) };
    } else {
      throw new WorkflowContractError("POLICY_INVALID", `${resolution.code}: ${resolution.error}`);
    }
  }
  const policyCandidate = stage.checkpoint
    ? currentDeclaration?.policy ?? null
    : stage.checkpoint_policy ?? profile.checkpoint_policy ?? null;
  const checkpoint_policy = policyCandidate ?? (stage.checkpoint ? migrationCheckpointPolicy(stage.checkpoint) : null);
  const checkpointPolicySource: ControlPlaneFieldSource = currentDeclaration
    ? (state?.checkpoint_policy && currentDeclaration.policy === state.checkpoint_policy ? "state" : "profile")
    : stage.checkpoint
      ? "migration"
      : "none";
  // Classification.autonomous is legacy/model routing input, not a checkpoint
  // permission field. A typed profile/state policy therefore remains valid
  // alongside it; provenance records the legacy input without comparing
  // unrelated semantics or granting autonomous authorization.
  const checkpoint_rule = stage.checkpoint
    ? currentDeclaration?.rule ?? checkpoint_policy?.rules[stage.checkpoint] ?? null
    : null;
  // Only a VALIDATED CURRENT-SCOPE decision is exposed: same stage, same
  // checkpoint, bound to the active capability epoch, loop iteration and
  // policy hash. Records from prior epochs/iterations/stages are audit
  // history — the typed lookup is stage/checkpoint/epoch-complete, never
  // stage/checkpoint-only.
  const checkpoint_decision: CheckpointDecision | TypedCheckpointDecision | null = stage.checkpoint && state
    ? findCurrentCheckpointDecision(state, stage, currentDeclaration ?? undefined)
    : null;
  if (stage.checkpoint && !checkpoint_rule) {
    throw new WorkflowContractError("POLICY_INVALID", `checkpoint policy has no rule for '${stage.checkpoint}'`);
  }
  const roster_policy = stage.roster_policy ?? null;
  const capabilitySelection = capability?.roster_selection ?? null;
  const stateSelection = state?.roster_selection ?? null;
  if (stateSelection && capabilitySelection && hash(stateSelection) !== hash(capabilitySelection)) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "state roster_selection conflicts with capability roster_selection");
  }
  const rawSelection = stateSelection ?? capabilitySelection;
  // A selection is exposed only while it names the current stage AND is
  // bound to the authoritative persisted top-level cursor epoch. Anything
  // else is stale data from a completed, deferred or rotated capability
  // and is masked — a prior stage's frozen selection can never dress up as
  // the live stage's contract, and a stale one can never satisfy
  // `selectionReady`. Legacy states without a top-level cursor epoch mask
  // fail-closed: a capability-internal epoch is never accepted as a
  // substitute for the live cursor binding.
  const selectionCurrent = rawSelection !== null
    && state !== null
    && rawSelection.stage_id === stage.id
    && rawSelection.capability_epoch === state.cursor_epoch;
  const roster_selection = selectionCurrent ? rawSelection : null;
  const staleSelection = rawSelection !== null && roster_selection === null ? rawSelection : null;
  const capabilityIdentity = capability?.work_identity ?? null;
  const stateIdentity = state?.work_identity ?? null;
  const capabilityHasSingularIdentity = capability === undefined
    || capability === null
    || (capability.kind === "single" && capability.expected_count === 1);
  if (!capabilityHasSingularIdentity && (stateIdentity || capabilityIdentity)) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "non-single capability cannot project one dispatch work_identity");
  }
  if (stateIdentity && capabilityIdentity && hash(stateIdentity) !== hash(capabilityIdentity)) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "state work_identity conflicts with capability work_identity");
  }
  const work_identity = capabilityHasSingularIdentity ? stateIdentity ?? capabilityIdentity : null;
  // Root lifecycle fields are singular projections. A consilium keeps every
  // independent slot lifecycle in capability.pending/dispatches and exposes
  // no arbitrarily selected root pending or completion envelope.
  const capabilityPending = (capability?.pending ?? []).filter((candidate) =>
    candidate.status === "authorized" || candidate.status === "running" || candidate.status === "pending");
  if (!capabilityHasSingularIdentity && (state?.pending || state?.completion_envelope)) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "non-single capability cannot project one dispatch lifecycle onto the root state");
  }
  if (capabilityHasSingularIdentity && capabilityPending.length > 1 && !state?.pending && !capabilityIdentity) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "capability pending lifecycle is ambiguous without work_identity");
  }
  const pending = capabilityHasSingularIdentity
    ? state?.pending
      ?? capabilityPending.find((candidate) => !capabilityIdentity || candidate.identity.dispatch_id === capabilityIdentity.dispatch_id)
      ?? null
    : null;
  if (capabilityHasSingularIdentity && capabilityIdentity && capabilityPending.length > 0 && !pending) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "capability pending lifecycle has no matching work_identity");
  }
  const child_join = state?.child_join ?? null;
  const completion_envelope = capabilityHasSingularIdentity ? state?.completion_envelope ?? null : null;
  if (pending && completion_envelope && (pending.status === "pending") !== (completion_envelope.outcome === "pending")) {
    throw new WorkflowContractError("MIGRATION_CONFLICT", "pending lifecycle and completion_envelope outcomes conflict");
  }
  const selectionRequired = roster_policy !== null;
  const selectionReady = !selectionRequired || roster_selection !== null;
  // Dispatch permission requires the STRICT active capability contract: a
  // partial, shape-valid-but-incomplete or state-mismatched capability is
  // never advertised as dispatchable — the capability must pass the full
  // active validation and be strictly bound to the persisted state.
  const capabilityActive = capability !== undefined && capability !== null
    && validateActiveDispatchCapabilityValue(capability).ok
    && validateActiveCapabilityStateBinding(state).ok;
  const capabilityStatus = capabilityActive ? capability?.status : undefined;
  const dispatchAllowed = state !== null &&
    kind !== null &&
    selectionReady &&
    capabilityActive &&
    (capabilityStatus === "ready" || capabilityStatus === "dispatched");
  const selectedRoleAgents = roster_selection?.selected.map((entry) => ({ role: entry.slot_id, agent: entry.agent })) ?? [];
  const configuredRoleAgents = slots.map(slot => ({ role: slot.slot, agent: resolveAgentForRole(slot.role, config) }));
  const roleAgents = configuredRoleAgents.length > 0 ? configuredRoleAgents : selectedRoleAgents;
  const status = workflowStatus(state, stage.id, pending);
  const legacyInputs = [
    state?.classification?.autonomous !== undefined ? "classification.autonomous" : null,
    state?.autonomous !== undefined ? "TeamState.autonomous" : null,
    stage.autonomous ? "stage.autonomous" : null,
    !intentCandidate ? "completion_intent" : null,
    !policyCandidate && stage.checkpoint ? "checkpoint_policy" : null,
    !roster_policy && (stage.roles || stage.role) ? "roles/role" : null,
  ].filter((input): input is string => input !== null);
  const warnings = [
    stage.autonomous ? "stage.autonomous is display/migration input only" : null,
    !roster_policy && (stage.roles || stage.role) ? "legacy roles/role manifest remains exact and is not adaptive selection" : null,
    !roster_selection && roster_policy ? "adaptive stage awaits a frozen roster_selection before dispatch" : null,
    staleSelection ? `stale roster_selection (stage '${staleSelection.stage_id}', epoch '${staleSelection.capability_epoch}') is masked for the current stage cursor` : null,
    declarationConflict ? `persisted checkpoint_policy conflicts with the declared policy for stage '${stage.id}'; the declared policy is shown and every authorizing use fails closed until workflow_begin re-projects the mirror` : null,
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
      path: resolved.statePath,
      artifactsDir: resolved.artifactsDir,
      branch: state?.branch ?? expectedBranch ?? "",
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
