/**
 * Single-source low-level control-plane validators (br-zps checkpoint-ledger
 * correction).
 *
 * Every shape check for work identity, pending lifecycle, dispatch
 * capabilities (including their `PendingState[]` nested cardinality),
 * checkpoint policies, decisions and trusted answers lives here exactly once.
 * `workflow-contract.ts` (issue-array contract) and `state.ts` (executable
 * typed-state normalization) delegate to this module instead of keeping
 * parallel copies, and `durable.ts` derives `activeCapability` from the same
 * capability validator.
 *
 * Contract: every validator is total and non-throwing. It checks `isRecord`
 * before any property access and returns a stable issue list — malformed,
 * null or primitive input never surfaces as a `TypeError`.
 */

import type {
  CheckpointPolicy,
  DispatchCapabilityState,
  PendingState,
  TeamState,
  TrustedCheckpointAnswer,
  TypedCheckpointDecision,
  WorkIdentity,
} from "./types.js";

export interface ControlPlaneIssue {
  path: string;
  message: string;
}

export type ControlPlaneValidation = { ok: true } | { ok: false; issues: ControlPlaneIssue[] };

export type PendingCardinality = "single" | "array";

type UnknownRecord = Record<string, unknown>;

const CHECKPOINT_KINDS: readonly string[] = [
  "product_approval", "clarification", "architecture_choice", "implementation_approval",
  "review_fix", "regression_plan", "integration_acceptance", "security",
  "destructive_side_effect", "production", "bundle_activation", "migration_cutover", "custom",
];
const HARD_HUMAN_KINDS: readonly string[] = [
  "product_approval", "security", "destructive_side_effect", "production",
  "bundle_activation", "migration_cutover", "custom",
];

/** The canonical object guard for control-plane validation; shared module-wide. */
export function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function add(issues: ControlPlaneIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function unknownKeys(value: UnknownRecord, allowed: readonly string[], path: string, issues: ControlPlaneIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) add(issues, `${path}.${key}`, "unknown field");
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireString(value: UnknownRecord, key: string, path: string, issues: ControlPlaneIssue[]): void {
  if (!nonEmptyString(value[key])) add(issues, `${path}.${key}`, "must be a non-empty string");
}

function requireEnum(value: UnknownRecord, key: string, allowed: readonly string[], path: string, issues: ControlPlaneIssue[]): void {
  if (typeof value[key] !== "string" || !allowed.includes(value[key] as string)) {
    add(issues, `${path}.${key}`, `must be one of ${allowed.join(", ")}`);
  }
}

function requireInteger(value: UnknownRecord, key: string, path: string, issues: ControlPlaneIssue[], minimum = 0): void {
  if (!Number.isInteger(value[key]) || (value[key] as number) < minimum) {
    add(issues, `${path}.${key}`, `must be an integer >= ${minimum}`);
  }
}

function requireBooleanOrNull(value: UnknownRecord, key: string, path: string, issues: ControlPlaneIssue[]): void {
  const entry = value[key];
  if (entry !== null && entry !== undefined && typeof entry !== "string") {
    add(issues, `${path}.${key}`, "must be a non-empty string or null");
  }
}

function stringArray(value: unknown, path: string, issues: ControlPlaneIssue[], required = true): string[] | null {
  if (value === undefined && !required) return null;
  if (!Array.isArray(value) || value.some((item) => !nonEmptyString(item))) {
    add(issues, path, "must be an array of non-empty strings");
    return null;
  }
  const result = value as string[];
  for (let index = 0; index < result.length; index += 1) {
    for (let previous = 0; previous < index; previous += 1) {
      if (result[previous] === result[index]) add(issues, `${path}[${index}]`, "duplicate value");
    }
  }
  return result;
}

function canonicalJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as UnknownRecord)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonicalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(canonicalize(value));
}

/** Full deep-equality over canonical JSON; order-insensitive and total. */
export function controlPlaneValueEquals(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

// ---------------------------------------------------------------------------
// Work identity
// ---------------------------------------------------------------------------

const WORK_IDENTITY_KEYS = [
  "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id", "stage_cursor",
  "capability_id", "capability_epoch", "loop_iteration", "slot_id", "task_id", "dispatch_id", "attempt", "worker_id",
] as const;

export function validateWorkIdentityValue(value: unknown, path = "$"): ControlPlaneValidation {
  const issues: ControlPlaneIssue[] = [];
  validateWorkIdentityInto(value, path, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

function validateWorkIdentityInto(value: unknown, path: string, issues: ControlPlaneIssue[]): void {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, WORK_IDENTITY_KEYS, path, issues);
  for (const key of [
    "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id", "stage_cursor",
    "capability_id", "capability_epoch", "slot_id", "task_id", "dispatch_id", "worker_id",
  ]) requireString(value, key, path, issues);
  requireInteger(value, "attempt", path, issues, 1);
  // Pre-loop-scope identities omit the additive loop scope; when present it
  // must be well-formed. Scope enforcement happens at the engine boundary.
  if (value.loop_iteration !== undefined && (!Number.isInteger(value.loop_iteration) || (value.loop_iteration as number) < 1)) {
    add(issues, `${path}.loop_iteration`, "must be an integer >= 1");
  }
}

// ---------------------------------------------------------------------------
// Pending lifecycle — shared with a cardinality parameter: the root state
// keeps one `PendingState` object, a nested capability keeps `PendingState[]`.
// ---------------------------------------------------------------------------

export function validatePendingStateValue(
  value: unknown,
  path = "$",
  cardinality: PendingCardinality = "single",
): ControlPlaneValidation {
  const issues: ControlPlaneIssue[] = [];
  if (cardinality === "array") {
    if (!Array.isArray(value)) {
      add(issues, path, "must be an array");
      return { ok: false, issues };
    }
    value.forEach((entry, index) => validatePendingEntryInto(entry, `${path}[${index}]`, issues));
  } else {
    if (Array.isArray(value)) {
      add(issues, path, "must be an object");
      return { ok: false, issues };
    }
    validatePendingEntryInto(value, path, issues);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

function validatePendingEntryInto(value: unknown, path: string, issues: ControlPlaneIssue[]): void {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["identity", "status", "pending_reason", "provider_ref", "lease", "terminal_signal", "retry_of", "updated_at"], path, issues);
  validateWorkIdentityInto(value.identity, `${path}.identity`, issues);
  requireEnum(value, "status", ["authorized", "running", "pending", "succeeded", "failed", "cancelled"], path, issues);
  if (value.pending_reason !== undefined && (typeof value.pending_reason !== "string" || !["provider_running", "awaiting_result", "transport_reconnect"].includes(value.pending_reason))) {
    add(issues, `${path}.pending_reason`, "unknown pending reason");
  }
  if (value.provider_ref !== undefined && !nonEmptyString(value.provider_ref)) add(issues, `${path}.provider_ref`, "must be a non-empty string");
  if (value.lease !== undefined) {
    if (!isRecord(value.lease)) add(issues, `${path}.lease`, "must be an object");
    else {
      unknownKeys(value.lease, ["token", "observed_at", "revoked_at"], `${path}.lease`, issues);
      requireString(value.lease, "token", `${path}.lease`, issues);
      requireString(value.lease, "observed_at", `${path}.lease`, issues);
      if (!hasOwn(value.lease, "revoked_at") || (value.lease.revoked_at !== null && !nonEmptyString(value.lease.revoked_at))) add(issues, `${path}.lease.revoked_at`, "must be a non-empty string or null");
    }
  }
  if (value.terminal_signal !== undefined && value.terminal_signal !== null && !nonEmptyString(value.terminal_signal)) add(issues, `${path}.terminal_signal`, "must be a non-empty string or null");
  if (value.retry_of !== undefined && value.retry_of !== null && !nonEmptyString(value.retry_of)) add(issues, `${path}.retry_of`, "must be a non-empty string or null");
  requireString(value, "updated_at", path, issues);
  if (value.status === "pending" && value.terminal_signal !== undefined && value.terminal_signal !== null) {
    add(issues, `${path}.terminal_signal`, "pending work cannot claim a terminal signal");
  }
}

// ---------------------------------------------------------------------------
// Checkpoint policy / rule
// ---------------------------------------------------------------------------

export function validateCheckpointRuleValue(
  value: unknown,
  path = "$",
  opts: { allowPendingDecisions?: boolean; hardHuman?: readonly string[] } = {},
): ControlPlaneValidation {
  const issues: ControlPlaneIssue[] = [];
  validateCheckpointRuleInto(value, path, issues, opts.hardHuman ?? [], opts.allowPendingDecisions === true);
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

function validateCheckpointRuleInto(
  value: unknown,
  path: string,
  issues: ControlPlaneIssue[],
  hardHuman: readonly string[],
  allowPendingDecisions: boolean,
): void {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["kind", "default", "allowed_decisions", "phase", "rationale"], path, issues);
  requireEnum(value, "kind", CHECKPOINT_KINDS, path, issues);
  requireEnum(value, "default", ["required_human", "autonomous_allowed"], path, issues);
  const decisions = stringArray(value.allowed_decisions, `${path}.allowed_decisions`, issues);
  // Migration-generated rules may legitimately carry no decisions yet;
  // unresolved consent remains human-required until typed decisions exist.
  if (decisions && decisions.length === 0 && !allowPendingDecisions) {
    add(issues, `${path}.allowed_decisions`, "must not be empty for a typed rule");
  }
  requireEnum(value, "phase", ["before_dispatch", "before_advance"], path, issues);
  requireString(value, "rationale", path, issues);
  if (value.default === "autonomous_allowed" && typeof value.kind === "string" && hardHuman.includes(value.kind)) {
    add(issues, path, "hard-human rule cannot allow autonomous decisions");
  }
}

export function validateCheckpointPolicyValue(value: unknown, path = "$"): ControlPlaneValidation {
  const issues: ControlPlaneIssue[] = [];
  validateCheckpointPolicyInto(value, path, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

function validateCheckpointPolicyInto(value: unknown, path: string, issues: ControlPlaneIssue[]): void {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["default", "scope", "hard_human", "rules", "source", "policy_version", "rationale"], path, issues);
  requireEnum(value, "default", ["required_human", "autonomous_allowed"], path, issues);
  requireEnum(value, "scope", ["decision"], path, issues);
  const hardHuman = stringArray(value.hard_human, `${path}.hard_human`, issues);
  if (hardHuman) {
    for (let index = 0; index < hardHuman.length; index += 1) {
      if (!HARD_HUMAN_KINDS.includes(hardHuman[index]!)) add(issues, `${path}.hard_human[${index}]`, "unknown hard-human class");
    }
  }
  if (!isRecord(value.rules)) {
    add(issues, `${path}.rules`, "must be an object");
  } else {
    for (const [checkpointId, rule] of Object.entries(value.rules)) {
      if (!nonEmptyString(checkpointId)) add(issues, `${path}.rules`, "checkpoint ids must be non-empty");
      validateCheckpointRuleInto(rule, `${path}.rules.${checkpointId}`, issues, hardHuman ?? [], value.source === "migration");
    }
  }
  requireEnum(value, "source", ["profile", "user", "migration"], path, issues);
  requireInteger(value, "policy_version", path, issues, 1);
  requireString(value, "rationale", path, issues);
}

// ---------------------------------------------------------------------------
// Checkpoint proofs, trusted answers and decisions
// ---------------------------------------------------------------------------

export function validateCheckpointAnswerProofValue(value: unknown, path = "$"): ControlPlaneValidation {
  const issues: ControlPlaneIssue[] = [];
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return { ok: false, issues };
  }
  unknownKeys(value, ["answer_id", "nonce", "channel", "reference", "binding"], path, issues);
  for (const key of ["answer_id", "nonce", "reference", "binding"]) requireString(value, key, path, issues);
  requireEnum(value, "channel", ["terminal", "escalation"], path, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

export function validateTrustedCheckpointAnswerValue(value: unknown, path = "$"): ControlPlaneValidation {
  const issues: ControlPlaneIssue[] = [];
  validateTrustedAnswerInto(value, path, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

function validateTrustedAnswerInto(value: unknown, path: string, issues: ControlPlaneIssue[]): void {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, [
    "answer_id", "nonce", "channel", "reference", "run_id", "stage_id", "checkpoint_id",
    "work_identity_hash", "capability_id", "capability_epoch", "loop_iteration", "policy_hash",
    "decision", "binding", "issued_at", "consumed_at", "consumed_reason", "finalized_decision_key",
  ], path, issues);
  for (const key of [
    "answer_id", "nonce", "reference", "run_id", "stage_id", "checkpoint_id",
    "work_identity_hash", "capability_id", "capability_epoch", "policy_hash",
    "decision", "binding", "issued_at",
  ]) requireString(value, key, path, issues);
  requireEnum(value, "channel", ["terminal", "escalation"], path, issues);
  if (value.loop_iteration !== undefined && (!Number.isInteger(value.loop_iteration) || (value.loop_iteration as number) < 1)) {
    add(issues, `${path}.loop_iteration`, "must be an integer >= 1");
  }
  if (value.consumed_at !== undefined && !nonEmptyString(value.consumed_at)) add(issues, `${path}.consumed_at`, "must be a non-empty string");
  if (value.consumed_reason !== undefined) {
    if (typeof value.consumed_reason !== "string" || !["finalized", "superseded"].includes(value.consumed_reason)) {
      add(issues, `${path}.consumed_reason`, `must be one of finalized, superseded`);
    }
    // A consumed reason is an audit marker on top of a consumed answer: the
    // record must be consumed, and a finalized record must name its decision.
    if (value.consumed_at === undefined) add(issues, `${path}.consumed_reason`, "requires consumed_at");
    if (value.consumed_reason === "finalized" && !nonEmptyString(value.finalized_decision_key)) {
      add(issues, `${path}.finalized_decision_key`, "finalized answers require their immutable decision key");
    }
  }
  if (value.finalized_decision_key !== undefined && !nonEmptyString(value.finalized_decision_key)) {
    add(issues, `${path}.finalized_decision_key`, "must be a non-empty string");
  }
  if (value.finalized_decision_key !== undefined && value.consumed_reason !== "finalized") {
    add(issues, `${path}.finalized_decision_key`, "requires consumed_reason 'finalized'");
  }
}

export function validateCheckpointDecisionValue(value: unknown, path = "$"): ControlPlaneValidation {
  const issues: ControlPlaneIssue[] = [];
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return { ok: false, issues };
  }
  unknownKeys(value, [
    "stage_id", "checkpoint", "mode", "decision", "actor", "rationale", "decided_at",
    "run_id", "checkpoint_id", "checkpoint_kind", "authorization", "actor_provenance",
    "capability_id", "capability_epoch", "loop_iteration", "policy_hash", "work_identity",
  ], path, issues);
  for (const key of ["stage_id", "checkpoint", "decision", "actor", "rationale", "decided_at"]) requireString(value, key, path, issues);
  requireEnum(value, "mode", ["interactive", "autonomous"], path, issues);
  if (value.checkpoint_kind !== undefined) requireEnum(value, "checkpoint_kind", CHECKPOINT_KINDS, path, issues);
  if (value.authorization !== undefined) requireEnum(value, "authorization", ["human", "policy_auto"], path, issues);
  if (value.actor_provenance !== undefined) {
    if (!isRecord(value.actor_provenance)) add(issues, `${path}.actor_provenance`, "must be an object");
    else validateActorInto(value.actor_provenance, `${path}.actor_provenance`, issues);
  }
  for (const key of ["run_id", "checkpoint_id", "capability_id", "capability_epoch", "policy_hash"]) {
    requireBooleanOrNull(value, key, path, issues);
  }
  if (value.loop_iteration !== undefined && (!Number.isInteger(value.loop_iteration) || (value.loop_iteration as number) < 1)) {
    add(issues, `${path}.loop_iteration`, "must be an integer >= 1");
  }
  if (value.work_identity !== undefined) validateWorkIdentityInto(value.work_identity, `${path}.work_identity`, issues);
  if (value.authorization === "policy_auto" && value.mode === "interactive") add(issues, `${path}.authorization`, "policy_auto cannot use interactive mode");
  if (value.authorization === "human" && value.mode === "autonomous") add(issues, `${path}.authorization`, "human authorization cannot use autonomous mode");
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

function validateActorInto(value: UnknownRecord, path: string, issues: ControlPlaneIssue[]): void {
  unknownKeys(value, ["kind", "ref", "proof"], path, issues);
  requireEnum(value, "kind", ["user", "orchestrator", "system"], path, issues);
  requireString(value, "ref", path, issues);
  if (value.proof !== undefined) {
    if (!isRecord(value.proof)) add(issues, `${path}.proof`, "must be an object");
    else {
      const proofIssues = validateCheckpointAnswerProofValue(value.proof, `${path}.proof`);
      if (!proofIssues.ok) issues.push(...proofIssues.issues);
    }
  }
}

export function validateTypedCheckpointDecisionValue(
  value: unknown,
  path = "$",
  opts: { allowLegacyLoopScope?: boolean } = {},
): ControlPlaneValidation {
  const issues: ControlPlaneIssue[] = [];
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return { ok: false, issues };
  }
  unknownKeys(value, [
    "run_id", "stage_id", "checkpoint_id", "checkpoint_kind", "decision", "authorization",
    "actor", "capability_id", "capability_epoch", "loop_iteration", "policy_hash", "rationale", "decided_at",
  ], path, issues);
  for (const key of ["run_id", "stage_id", "checkpoint_id", "decision", "capability_id", "capability_epoch", "policy_hash", "rationale", "decided_at"]) {
    requireString(value, key, path, issues);
  }
  requireEnum(value, "checkpoint_kind", CHECKPOINT_KINDS, path, issues);
  requireEnum(value, "authorization", ["human", "policy_auto"], path, issues);
  if (opts.allowLegacyLoopScope === true) {
    if (value.loop_iteration !== undefined && (!Number.isInteger(value.loop_iteration) || (value.loop_iteration as number) < 1)) {
      add(issues, `${path}.loop_iteration`, "must be an integer >= 1");
    }
  } else {
    requireInteger(value, "loop_iteration", path, issues, 1);
  }
  if (!isRecord(value.actor)) add(issues, `${path}.actor`, "must be an object");
  else validateActorInto(value.actor, `${path}.actor`, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

// ---------------------------------------------------------------------------
// Dispatch capability — the complete nested contract
// ---------------------------------------------------------------------------

const CAPABILITY_KEYS = [
  "run", "workflow", "profile_hash", "stage", "roles",
  "capability_id", "dispatch_token_hash", "advance_token_hash", "issued_for", "kind",
  "expected_roles", "expected_count", "expected_roster", "roster_selection", "work_identity",
  "pending", "status", "dispatches",
] as const;

const SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/;

function completionEnvelopeIssues(value: unknown, path: string, issues: ControlPlaneIssue[]): void {
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return;
  }
  unknownKeys(value, ["schema_version", "identity", "outcome", "terminal_signal", "artifact_refs", "evidence_ref", "conflict_ref", "completed_by", "emitted_at"], path, issues);
  if (value.schema_version !== 1) add(issues, `${path}.schema_version`, "must be 1");
  validateWorkIdentityInto(value.identity, `${path}.identity`, issues);
  requireEnum(value, "outcome", ["pending", "succeeded", "failed", "cancelled"], path, issues);
  if (!hasOwn(value, "terminal_signal") || (value.terminal_signal !== null && value.terminal_signal !== undefined && !["workflow_complete", "native_tool_result", "provider_terminal", "contract_failure"].includes(value.terminal_signal as string))) {
    add(issues, `${path}.terminal_signal`, "unknown or missing terminal signal");
  }
  if (!Array.isArray(value.artifact_refs)) {
    add(issues, `${path}.artifact_refs`, "must be an array");
  } else {
    value.artifact_refs.forEach((entry, index) => {
      const entryPath = `${path}.artifact_refs[${index}]`;
      if (!isRecord(entry)) {
        add(issues, entryPath, "must be an object");
        return;
      }
      unknownKeys(entry, ["artifact_id", "path", "sha256", "schema_status", "dod_status"], entryPath, issues);
      for (const key of ["artifact_id", "path", "sha256"]) requireString(entry, key, entryPath, issues);
      requireEnum(entry, "schema_status", ["met", "failed"], entryPath, issues);
      requireEnum(entry, "dod_status", ["met", "pending", "failed"], entryPath, issues);
    });
  }
  if (!hasOwn(value, "evidence_ref") || (value.evidence_ref !== null && !nonEmptyString(value.evidence_ref))) add(issues, `${path}.evidence_ref`, "must be a non-empty string or null");
  if (!hasOwn(value, "conflict_ref") || (value.conflict_ref !== null && !nonEmptyString(value.conflict_ref))) add(issues, `${path}.conflict_ref`, "must be a non-empty string or null");
  requireEnum(value, "completed_by", ["workflow_complete", "synchronous_tool_result", "engine_task_caller"], path, issues);
  requireString(value, "emitted_at", path, issues);
  if (value.outcome === "pending") {
    if (value.terminal_signal !== null && value.terminal_signal !== undefined) add(issues, `${path}.terminal_signal`, "pending envelope cannot claim a terminal signal");
    if (Array.isArray(value.artifact_refs) && value.artifact_refs.length > 0) add(issues, `${path}.artifact_refs`, "pending envelope cannot claim terminal artifacts");
  } else if (value.terminal_signal === null || value.terminal_signal === undefined) {
    add(issues, `${path}.terminal_signal`, "terminal envelope requires a terminal signal");
  }
}

function isSafeSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);
}

function validateDispatchRecordInto(recordValue: unknown, recordPath: string, issues: ControlPlaneIssue[], capability: UnknownRecord, issued: UnknownRecord): void {
  if (!isRecord(recordValue)) {
    add(issues, recordPath, "must be an object");
    return;
  }
  unknownKeys(recordValue, ["id", "role", "agent", "tool_call_id", "status", "attempt", "created_at", "completed_at", "completion", "work_identity", "pending", "completion_envelope"], recordPath, issues);
  for (const key of ["id", "role", "agent", "created_at"]) requireString(recordValue, key, recordPath, issues);
  requireEnum(recordValue, "status", ["authorized", "running", "pending", "succeeded", "failed", "cancelled"], recordPath, issues);
  requireInteger(recordValue, "attempt", recordPath, issues, 1);
  if (recordValue.tool_call_id !== undefined && !nonEmptyString(recordValue.tool_call_id)) add(issues, `${recordPath}.tool_call_id`, "must be a non-empty string");
  const expectedRoles = Array.isArray(capability.expected_roles) ? capability.expected_roles as string[] : [];
  if (nonEmptyString(recordValue.role) && expectedRoles.length > 0 && !expectedRoles.includes(recordValue.role)) {
    add(issues, `${recordPath}.role`, "is not part of the capability's expected roles");
  }
  const roster = Array.isArray(capability.expected_roster) ? capability.expected_roster as UnknownRecord[] : [];
  if (nonEmptyString(recordValue.role) && nonEmptyString(recordValue.agent) && roster.length > 0) {
    const rosterMatch = roster.some((entry) => isRecord(entry) && entry.role === recordValue.role && entry.agent === recordValue.agent);
    if (!rosterMatch) add(issues, `${recordPath}.agent`, "does not match the capability's expected roster");
  }
  const identity = recordValue.work_identity;
  if (identity === undefined || identity === null) {
    add(issues, `${recordPath}.work_identity`, "is required for every dispatch record");
  } else {
    validateWorkIdentityInto(identity, `${recordPath}.work_identity`, issues);
    if (isRecord(identity) && isRecord(capability) && typeof capability.capability_id === "string") {
      const identityOk = nonEmptyString(identity.run_id)
        && identity.slot_id === recordValue.role
        && identity.capability_id === capability.capability_id
        && identity.capability_epoch === issued.cursor_epoch
        && identity.dispatch_id === recordValue.id
        && identity.attempt === recordValue.attempt
        && nonEmptyString(identity.task_id)
        && nonEmptyString(identity.worker_id);
      if (!identityOk) add(issues, `${recordPath}.work_identity`, "does not bind to the dispatch record and the capability epoch");
    }
  }
  const terminalStatuses = ["succeeded", "failed", "cancelled"];
  const isTerminal = typeof recordValue.status === "string" && terminalStatuses.includes(recordValue.status);
  const completion = recordValue.completion;
  if (!isTerminal) {
    if (completion !== undefined) add(issues, `${recordPath}.completion`, "non-terminal records cannot carry a completion");
    const envelope = recordValue.completion_envelope;
    if (envelope === undefined) {
      add(issues, `${recordPath}.completion_envelope`, "is required for non-terminal records");
    } else {
      completionEnvelopeIssues(envelope, `${recordPath}.completion_envelope`, issues);
      if (isRecord(envelope) && envelope.outcome !== "pending") {
        add(issues, `${recordPath}.completion_envelope.outcome`, "non-terminal records carry a pending envelope");
      }
      if (isRecord(envelope) && isRecord(envelope.identity) && isRecord(identity) && !controlPlaneValueEquals(envelope.identity, identity)) {
        add(issues, `${recordPath}.completion_envelope.identity`, "does not match the record's work identity");
      }
    }
    if (recordValue.pending !== undefined) {
      const pendingIssues = validatePendingStateValue(recordValue.pending, `${recordPath}.pending`, "single");
      if (!pendingIssues.ok) issues.push(...pendingIssues.issues);
      if (isRecord(recordValue.pending) && isRecord(recordValue.pending.identity)) {
        const pendingIdentity = recordValue.pending.identity;
        if (pendingIdentity.dispatch_id !== recordValue.id || pendingIdentity.slot_id !== recordValue.role) {
          add(issues, `${recordPath}.pending.identity`, "does not match the dispatch record identity");
        }
        if (recordValue.pending.status !== recordValue.status) {
          add(issues, `${recordPath}.pending.status`, "does not match the record status");
        }
      }
      if (isRecord(recordValue.pending) && recordValue.status === "pending" && recordValue.pending.terminal_signal !== undefined && recordValue.pending.terminal_signal !== null) {
        add(issues, `${recordPath}.pending.terminal_signal`, "pending work cannot claim a terminal signal");
      }
    }
    if (recordValue.completed_at !== undefined) add(issues, `${recordPath}.completed_at`, "non-terminal records cannot claim a completion time");
    return;
  }
  if (!isRecord(completion)) {
    add(issues, `${recordPath}.completion`, "is required for terminal records");
    return;
  }
  unknownKeys(completion, ["dispatch_id", "cursor_epoch", "outcome", "artifact_ids", "evidence", "completed_by", "completed_at", "work_identity"], `${recordPath}.completion`, issues);
  if (completion.dispatch_id !== recordValue.id) add(issues, `${recordPath}.completion.dispatch_id`, "does not match the dispatch record");
  if (completion.cursor_epoch !== issued.cursor_epoch) add(issues, `${recordPath}.completion.cursor_epoch`, "does not match the capability epoch");
  requireEnum(completion, "outcome", ["succeeded", "failed", "cancelled"], `${recordPath}.completion`, issues);
  if (typeof completion.outcome === "string" && typeof recordValue.status === "string" && completion.outcome !== recordValue.status) {
    add(issues, `${recordPath}.completion.outcome`, "does not match the record status");
  }
  if (!nonEmptyString(completion.evidence)) add(issues, `${recordPath}.completion.evidence`, "must be a non-empty string");
  if (!Array.isArray(completion.artifact_ids)) {
    add(issues, `${recordPath}.completion.artifact_ids`, "must be an array");
  } else {
    const ids = completion.artifact_ids as unknown[];
    if (ids.some((id) => !isSafeSegment(id))) add(issues, `${recordPath}.completion.artifact_ids`, "must be safe artifact segments");
    if (new Set(ids).size !== ids.length) add(issues, `${recordPath}.completion.artifact_ids`, "duplicate artifact id");
  }
  requireEnum(completion, "completed_by", ["workflow_complete", "synchronous_tool_result", "engine_task_caller"], `${recordPath}.completion`, issues);
  requireString(completion, "completed_at", `${recordPath}.completion`, issues);
  if (nonEmptyString(completion.completed_at) && completion.completed_at !== recordValue.completed_at) {
    add(issues, `${recordPath}.completed_at`, "does not match the completion record");
  }
  if (recordValue.completed_at !== undefined && !nonEmptyString(recordValue.completed_at)) add(issues, `${recordPath}.completed_at`, "must be a non-empty string");
  if (!isRecord(completion.work_identity)) {
    add(issues, `${recordPath}.completion.work_identity`, "is required for terminal records");
  } else {
    validateWorkIdentityInto(completion.work_identity, `${recordPath}.completion.work_identity`, issues);
    if (isRecord(identity) && !controlPlaneValueEquals(completion.work_identity, identity)) {
      add(issues, `${recordPath}.completion.work_identity`, "does not match the record's work identity");
    }
  }
  const envelope = recordValue.completion_envelope;
  if (envelope === undefined) {
    add(issues, `${recordPath}.completion_envelope`, "is required for terminal records");
  } else {
    completionEnvelopeIssues(envelope, `${recordPath}.completion_envelope`, issues);
    if (isRecord(envelope)) {
      const expectedOutcome = recordValue.status;
      if (envelope.outcome !== expectedOutcome) add(issues, `${recordPath}.completion_envelope.outcome`, "does not match the record status");
      if (isRecord(envelope.identity) && isRecord(identity) && !controlPlaneValueEquals(envelope.identity, identity)) {
        add(issues, `${recordPath}.completion_envelope.identity`, "does not match the record's work identity");
      }
    }
  }
}

/**
 * Complete shape validation of a persisted dispatch capability:
 * identity fields, secret hashes, `issued_for` binding (including the
 * loop-scoped `loop_iteration` and `checkpoint_policy_hash`), kind/status
 * enums, kind↔roster cardinality, roster uniqueness, dispatch records with
 * their identity/envelope/pending cross-bindings, and the `PendingState[]`
 * nested lifecycle. Null or primitive input yields issues, never a throw.
 *
 * `issued_for.loop_iteration` and `checkpoint_policy_hash` are legal to omit
 * only on genuinely legacy (pre-loop-scope) capabilities; whenever present
 * they must be well-formed. Scope enforcement itself happens at the ledger
 * boundary, which requires the loop-scoped fields on every authorizing proof.
 */
export function validateDispatchCapabilityValue(value: unknown, path = "$"): ControlPlaneValidation {
  const issues: ControlPlaneIssue[] = [];
  if (!isRecord(value)) {
    add(issues, path, "must be an object");
    return { ok: false, issues };
  }
  unknownKeys(value, CAPABILITY_KEYS, path, issues);
  requireString(value, "capability_id", path, issues);
  if (value.dispatch_token_hash !== undefined && (typeof value.dispatch_token_hash !== "string" || !SECRET_HASH_PATTERN.test(value.dispatch_token_hash))) {
    add(issues, `${path}.dispatch_token_hash`, "must be a 64-character lowercase hex digest");
  }
  if (value.advance_token_hash !== undefined && (typeof value.advance_token_hash !== "string" || !SECRET_HASH_PATTERN.test(value.advance_token_hash))) {
    add(issues, `${path}.advance_token_hash`, "must be a 64-character lowercase hex digest");
  }
  requireEnum(value, "kind", ["none", "single", "consilium"], path, issues);
  requireEnum(value, "status", ["ready", "dispatched", "joining", "complete", "invalidated"], path, issues);
  const issued = value.issued_for;
  if (!isRecord(issued)) {
    add(issues, `${path}.issued_for`, "must be an object");
  } else {
    unknownKeys(issued, ["run_key", "branch", "workflow", "profile_hash", "stage_cursor", "cursor_epoch", "loop_iteration", "checkpoint_policy_hash"], `${path}.issued_for`, issues);
    for (const key of ["run_key", "branch", "workflow", "profile_hash", "stage_cursor", "cursor_epoch"]) requireString(issued, key, `${path}.issued_for`, issues);
    if (issued.loop_iteration !== undefined && (!Number.isInteger(issued.loop_iteration) || (issued.loop_iteration as number) < 1)) {
      add(issues, `${path}.issued_for.loop_iteration`, "must be an integer >= 1");
    }
    if (issued.checkpoint_policy_hash !== undefined && issued.checkpoint_policy_hash !== null && !nonEmptyString(issued.checkpoint_policy_hash)) {
      add(issues, `${path}.issued_for.checkpoint_policy_hash`, "must be a non-empty string or null");
    }
  }
  const kind = value.kind;
  const expectedRoles = value.expected_roles;
  const expectedRoster = value.expected_roster;
  if (expectedRoles !== undefined && !Array.isArray(expectedRoles)) add(issues, `${path}.expected_roles`, "must be an array");
  if (expectedRoster !== undefined && !Array.isArray(expectedRoster)) add(issues, `${path}.expected_roster`, "must be an array");
  if (value.expected_count !== undefined && (!Number.isInteger(value.expected_count) || (value.expected_count as number) < 0)) {
    add(issues, `${path}.expected_count`, "must be an integer >= 0");
  }
  const roles = Array.isArray(expectedRoles) ? expectedRoles as unknown[] : [];
  if (Array.isArray(expectedRoles)) {
    if (roles.some((role) => !nonEmptyString(role))) add(issues, `${path}.expected_roles`, "must be an array of non-empty strings");
    if (new Set(roles).size !== roles.length) add(issues, `${path}.expected_roles`, "duplicate role");
  }
  const rosterEntries = Array.isArray(expectedRoster) ? expectedRoster as unknown[] : [];
  if (Array.isArray(expectedRoster)) {
    rosterEntries.forEach((entry, index) => {
      const entryPath = `${path}.expected_roster[${index}]`;
      if (!isRecord(entry)) {
        add(issues, entryPath, "must be an object");
        return;
      }
      unknownKeys(entry, ["role", "agent", "slot_id", "semantic_role", "occurrence", "facet"], entryPath, issues);
      requireString(entry, "role", entryPath, issues);
      requireString(entry, "agent", entryPath, issues);
      if (entry.slot_id !== undefined && !nonEmptyString(entry.slot_id)) add(issues, `${entryPath}.slot_id`, "must be a non-empty string");
      if (entry.semantic_role !== undefined && !nonEmptyString(entry.semantic_role)) add(issues, `${entryPath}.semantic_role`, "must be a non-empty string");
      if (entry.occurrence !== undefined && (!Number.isInteger(entry.occurrence) || (entry.occurrence as number) < 1)) add(issues, `${entryPath}.occurrence`, "must be an integer >= 1");
      if (entry.facet !== undefined && entry.facet !== null && !nonEmptyString(entry.facet)) add(issues, `${entryPath}.facet`, "must be a non-empty string or null");
    });
    const rosterRoles = rosterEntries.filter((entry): entry is UnknownRecord => isRecord(entry) && nonEmptyString(entry.role)).map((entry) => entry.role as string);
    if (new Set(rosterRoles).size !== rosterRoles.length) add(issues, `${path}.expected_roster`, "duplicate roster role");
    if (Array.isArray(expectedRoles) && roles.every((role) => typeof role === "string")) {
      for (const role of roles as string[]) {
        if (!rosterRoles.includes(role)) add(issues, `${path}.expected_roster`, "expected roles must all appear in the roster");
      }
    }
  }
  if (typeof kind === "string" && Number.isInteger(value.expected_count)) {
    const count = value.expected_count as number;
    if (
      (kind === "none" && count !== 0)
      || (kind === "single" && count !== 1)
      || (kind === "consilium" && count <= 0)
    ) {
      add(issues, `${path}.expected_count`, `does not match dispatch kind '${kind}'`);
    }
    if (Array.isArray(expectedRoles) && count !== roles.length) add(issues, `${path}.expected_count`, "does not match expected_roles length");
    if (Array.isArray(expectedRoster) && count !== rosterEntries.length) add(issues, `${path}.expected_count`, "does not match expected_roster length");
  }
  if (value.roster_selection !== undefined) {
    // The frozen selection is validated by the composed contract; shape-only
    // checks here keep this module free of selection semantics.
    if (!isRecord(value.roster_selection)) add(issues, `${path}.roster_selection`, "must be an object");
  }
  if (value.work_identity !== undefined) validateWorkIdentityInto(value.work_identity, `${path}.work_identity`, issues);
  if (value.pending !== undefined) {
    const pending = validatePendingStateValue(value.pending, `${path}.pending`, "array");
    if (!pending.ok) issues.push(...pending.issues);
  }
  if (value.dispatches !== undefined) {
    if (!Array.isArray(value.dispatches)) {
      add(issues, `${path}.dispatches`, "must be an array");
    } else {
      const records = value.dispatches as unknown[];
      const ids = records.filter((record): record is UnknownRecord => isRecord(record) && nonEmptyString(record.id)).map((record) => record.id as string);
      if (new Set(ids).size !== ids.length) add(issues, `${path}.dispatches`, "duplicate dispatch id");
      records.forEach((record, index) => {
        if (isRecord(issued)) validateDispatchRecordInto(record, `${path}.dispatches[${index}]`, issues, value, issued);
      });
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

// ---------------------------------------------------------------------------
// State ↔ capability cross-bindings
// ---------------------------------------------------------------------------

/**
 * Cross-bindings between the persisted state and its active capability:
 * run, branch, workflow, profile hash, cursor epoch and stage cursor must
 * agree, and a top-level `work_identity` must mirror the capability's own
 * identity. Returns issues — never throws on malformed input.
 */
export function validateCapabilityStateBinding(state: unknown, path = "$"): ControlPlaneValidation {
  const issues: ControlPlaneIssue[] = [];
  if (!isRecord(state)) {
    add(issues, path, "must be an object");
    return { ok: false, issues };
  }
  const capability = state.dispatch_capability;
  if (capability === undefined || capability === null) {
    return { ok: true };
  }
  if (!isRecord(capability)) {
    add(issues, `${path}.dispatch_capability`, "must be an object");
    return { ok: false, issues };
  }
  const issued = capability.issued_for;
  if (isRecord(issued)) {
    const comparisons: Array<[string, unknown, unknown]> = [
      ["run_key", state.run_key, issued.run_key],
      ["branch", state.branch, issued.branch],
      ["workflow", isRecord(state.classification) ? state.classification.workflow : undefined, issued.workflow],
      ["profile_hash", state.profile_hash, issued.profile_hash],
      ["cursor_epoch", state.cursor_epoch, issued.cursor_epoch],
      ["stage_cursor", state.stage_cursor, issued.stage_cursor],
    ];
    for (const [field, stateValue, issuedValue] of comparisons) {
      if (stateValue !== undefined && issuedValue !== undefined && stateValue !== issuedValue) {
        add(issues, `${path}.dispatch_capability.issued_for.${field}`, "does not match the workflow state");
      }
    }
  }
  if (state.work_identity !== undefined && capability.work_identity !== undefined && !controlPlaneValueEquals(state.work_identity, capability.work_identity)) {
    add(issues, `${path}.dispatch_capability.work_identity`, "does not match the state work_identity");
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

/**
 * Active dispatch identities are authorization material, not audit metadata.
 * Bind every repeated identity field to the capability generation and the
 * concrete dispatch record; legacy identities that omit loop scope remain
 * readable through the shape validator but fail this active boundary.
 */
function validateActiveDispatchIdentityInto(
  identityValue: unknown,
  path: string,
  issues: ControlPlaneIssue[],
  capability: UnknownRecord,
  issued: UnknownRecord,
  record: UnknownRecord,
): void {
  if (!isRecord(identityValue)) {
    add(issues, path, "must be an object for an active dispatch identity");
    return;
  }
  const bindings: Array<[string, unknown, unknown]> = [
    ["run_id", identityValue.run_id, issued.run_key],
    ["workflow", identityValue.workflow, issued.workflow],
    ["stage_id", identityValue.stage_id, issued.stage_cursor],
    ["stage_cursor", identityValue.stage_cursor, issued.stage_cursor],
    ["capability_id", identityValue.capability_id, capability.capability_id],
    ["capability_epoch", identityValue.capability_epoch, issued.cursor_epoch],
    ["loop_iteration", identityValue.loop_iteration, issued.loop_iteration],
    ["slot_id", identityValue.slot_id, record.role],
    ["dispatch_id", identityValue.dispatch_id, record.id],
    ["attempt", identityValue.attempt, record.attempt],
    ["worker_id", identityValue.worker_id, record.agent],
  ];
  for (const [field, actual, expected] of bindings) {
    if (actual === undefined || expected === undefined) {
      add(issues, `${path}.${field}`, "is required for an active dispatch identity");
    } else if (actual !== expected) {
      add(issues, `${path}.${field}`, "does not match the active capability and dispatch record");
    }
  }
}

function validateActiveNestedDispatchIdentities(
  capability: UnknownRecord,
  issued: UnknownRecord,
  path: string,
  issues: ControlPlaneIssue[],
): void {
  const records = Array.isArray(capability.dispatches)
    ? capability.dispatches.filter((record): record is UnknownRecord => isRecord(record))
    : [];
  const byDispatch = new Map(records.map((record) => [record.id, record]));
  records.forEach((record, index) => {
    const recordPath = `${path}.dispatches[${index}]`;
    validateActiveDispatchIdentityInto(record.work_identity, `${recordPath}.work_identity`, issues, capability, issued, record);
    if (isRecord(record.pending)) {
      validateActiveDispatchIdentityInto(record.pending.identity, `${recordPath}.pending.identity`, issues, capability, issued, record);
    }
    if (isRecord(record.completion)) {
      validateActiveDispatchIdentityInto(record.completion.work_identity, `${recordPath}.completion.work_identity`, issues, capability, issued, record);
    }
    if (isRecord(record.completion_envelope)) {
      validateActiveDispatchIdentityInto(record.completion_envelope.identity, `${recordPath}.completion_envelope.identity`, issues, capability, issued, record);
    }
  });

  const validateProjectedIdentity = (identity: unknown, identityPath: string): UnknownRecord | null => {
    if (!isRecord(identity)) {
      add(issues, identityPath, "must be an object for an active dispatch identity");
      return null;
    }
    const record = byDispatch.get(identity.dispatch_id);
    if (!record) {
      add(issues, `${identityPath}.dispatch_id`, "does not name a dispatch in the active capability");
      return null;
    }
    validateActiveDispatchIdentityInto(identity, identityPath, issues, capability, issued, record);
    return record;
  };

  if (capability.work_identity !== undefined) {
    validateProjectedIdentity(capability.work_identity, `${path}.work_identity`);
  }
  if (Array.isArray(capability.pending)) {
    capability.pending.forEach((pending, index) => {
      if (!isRecord(pending)) return;
      const pendingPath = `${path}.pending[${index}]`;
      const record = validateProjectedIdentity(pending.identity, `${pendingPath}.identity`);
      if (record && record.pending !== undefined && !controlPlaneValueEquals(pending, record.pending)) {
        add(issues, pendingPath, "does not match the dispatch record pending lifecycle");
      }
    });
  }
}

// ---------------------------------------------------------------------------
// ACTIVE capability — the complete, modern contract
// ---------------------------------------------------------------------------

/**
 * Complete validation for an ACTIVE dispatch capability: everything the
 * persisted shape requires plus every field an engine transition
 * dereferences — the secret hashes, the roster arrays/count, the dispatch
 * ledger and the loop-scoped binding. A shape-valid but partial capability
 * (or a genuinely legacy pre-loop-scope one) passes the read/migration
 * validator above and stays readable there, but is never active: it must be
 * re-issued via `workflow_begin` before it can authorize anything. Total by
 * construction: null/primitive/partial input yields issues, never a throw.
 */
export function validateActiveDispatchCapabilityValue(value: unknown, path = "$"): ControlPlaneValidation {
  const shape = validateDispatchCapabilityValue(value, path);
  if (!isRecord(value)) return shape;
  // Preserve shape diagnostics while continuing through the active checks:
  // callers receive exact forged-binding paths instead of only a coarse
  // record-level issue when both invariants fail.
  const issues: ControlPlaneIssue[] = shape.ok ? [] : [...shape.issues];
  const cap = value;
  // VALUE and TYPE checks, never key-presence checks: an own `undefined`
  // property satisfies hasOwn() while every field below is dereferenced by
  // engine transitions (array iteration, count math, secret hashing), so a
  // present-but-undefined field must reject exactly like an absent one.
  if (typeof cap.dispatch_token_hash !== "string" || !SECRET_HASH_PATTERN.test(cap.dispatch_token_hash)) {
    add(issues, `${path}.dispatch_token_hash`, "must be a 64-character lowercase hex digest");
  }
  if (typeof cap.advance_token_hash !== "string" || !SECRET_HASH_PATTERN.test(cap.advance_token_hash)) {
    add(issues, `${path}.advance_token_hash`, "must be a 64-character lowercase hex digest");
  }
  if (!Array.isArray(cap.expected_roles)) add(issues, `${path}.expected_roles`, "must be an array for an active dispatch capability");
  if (!Array.isArray(cap.expected_roster)) add(issues, `${path}.expected_roster`, "must be an array for an active dispatch capability");
  if (!Number.isInteger(cap.expected_count)) add(issues, `${path}.expected_count`, "must be an integer for an active dispatch capability");
  if (!Array.isArray(cap.dispatches)) add(issues, `${path}.dispatches`, "must be an array for an active dispatch capability");
  const issued = cap.issued_for;
  if (!isRecord(issued)) {
    add(issues, `${path}.issued_for`, "must be an object for an active dispatch capability");
    return issues.length > 0 ? { ok: false, issues } : { ok: true };
  }
  if (!Number.isInteger(issued.loop_iteration) || (issued.loop_iteration as number) < 1) {
    add(issues, `${path}.issued_for.loop_iteration`, "is required for an active (loop-scoped) capability");
  }
  if (issued.checkpoint_policy_hash !== null && !nonEmptyString(issued.checkpoint_policy_hash)) {
    add(issues, `${path}.issued_for.checkpoint_policy_hash`, "must be a non-empty string or null for an active dispatch capability");
  }
  const records = Array.isArray(cap.dispatches)
    ? cap.dispatches.filter((record): record is UnknownRecord => isRecord(record))
    : [];
  if (cap.kind === "single") {
    if (records.length === 0 && cap.work_identity !== undefined) {
      add(issues, `${path}.work_identity`, "is forbidden before the single dispatch is authorized");
    } else if (records.length > 0 && cap.work_identity === undefined) {
      add(issues, `${path}.work_identity`, "is required for an active single-dispatch capability");
    } else if (records.length > 0 && isRecord(cap.work_identity)) {
      const latest = records[records.length - 1];
      if (latest && cap.work_identity.dispatch_id !== latest.id) {
        add(issues, `${path}.work_identity.dispatch_id`, "must project the latest single dispatch record");
      }
    }
  } else if (cap.work_identity !== undefined) {
    add(issues, `${path}.work_identity`, "is forbidden for a capability without one singular dispatch identity");
  }
  validateActiveNestedDispatchIdentities(cap, issued, path, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

/**
 * STRICT cross-bindings for an ACTIVE capability: every shared field
 * (run, branch, workflow, profile hash, cursor epoch, stage cursor) must be
 * present on BOTH the persisted state and the capability binding and
 * strictly equal. Invoked before every authorizing mutation — a partial or
 * diverged state can never host a modern capability transition; repair or
 * re-begin is required.
 */
export function validateActiveCapabilityStateBinding(state: unknown, path = "$"): ControlPlaneValidation {
  const issues: ControlPlaneIssue[] = [];
  if (!isRecord(state)) {
    add(issues, path, "must be an object");
    return { ok: false, issues };
  }
  const capability = state.dispatch_capability;
  if (!isRecord(capability)) {
    add(issues, `${path}.dispatch_capability`, "must be an object");
    return { ok: false, issues };
  }
  const issued = capability.issued_for;
  if (!isRecord(issued)) {
    add(issues, `${path}.dispatch_capability.issued_for`, "must be an object");
    return { ok: false, issues };
  }
  const comparisons: Array<[string, unknown, unknown]> = [
    ["run_key", state.run_key, issued.run_key],
    ["branch", state.branch, issued.branch],
    ["workflow", isRecord(state.classification) ? state.classification.workflow : undefined, issued.workflow],
    ["profile_hash", state.profile_hash, issued.profile_hash],
    ["cursor_epoch", state.cursor_epoch, issued.cursor_epoch],
    ["stage_cursor", state.stage_cursor, issued.stage_cursor],
  ];
  for (const [field, stateValue, issuedValue] of comparisons) {
    if (!nonEmptyString(stateValue) || !nonEmptyString(issuedValue)) {
      add(issues, `${path}.dispatch_capability.issued_for.${field}`, "must be present on both the workflow state and the capability binding");
    } else if (stateValue !== issuedValue) {
      add(issues, `${path}.dispatch_capability.issued_for.${field}`, "does not match the workflow state");
    }
  }
  const projectedIdentity = capability.work_identity;
  const stateIdentity = state.work_identity;
  const singularProjection = capability.kind === "single" && capability.expected_count === 1;
  if (!singularProjection) {
    if (projectedIdentity !== undefined) {
      add(issues, `${path}.dispatch_capability.work_identity`, "is forbidden when the capability has no singular dispatch identity");
    }
    if (stateIdentity !== undefined) {
      add(issues, `${path}.work_identity`, "is forbidden when the active capability has no singular dispatch identity");
    }
  } else if (projectedIdentity === undefined) {
    if (stateIdentity !== undefined) {
      add(issues, `${path}.work_identity`, "is forbidden when the active capability has no projected identity");
    }
  } else if (stateIdentity === undefined) {
    add(issues, `${path}.work_identity`, "is required when the active capability projects an identity");
  } else {
    validateWorkIdentityInto(stateIdentity, `${path}.work_identity`, issues);
    if (!controlPlaneValueEquals(stateIdentity, projectedIdentity)) {
      add(issues, `${path}.work_identity`, "must exactly mirror the active capability work_identity");
    }
    if (isRecord(stateIdentity)) {
      const identityBindings: Array<[string, unknown, unknown]> = [
        ["run_id", stateIdentity.run_id, issued.run_key],
        ["workflow", stateIdentity.workflow, issued.workflow],
        ["stage_id", stateIdentity.stage_id, issued.stage_cursor],
        ["stage_cursor", stateIdentity.stage_cursor, issued.stage_cursor],
        ["capability_id", stateIdentity.capability_id, capability.capability_id],
        ["capability_epoch", stateIdentity.capability_epoch, issued.cursor_epoch],
        ["loop_iteration", stateIdentity.loop_iteration, issued.loop_iteration],
      ];
      for (const [field, actual, expected] of identityBindings) {
        if (actual === undefined || expected === undefined) {
          add(issues, `${path}.work_identity.${field}`, "is required for an active projected identity");
        } else if (actual !== expected) {
          add(issues, `${path}.work_identity.${field}`, "does not match the active capability binding");
        }
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

/** Narrow typed accessor for engine code after a successful capability validation. */
export function asDispatchCapability(value: unknown): DispatchCapabilityState | null {
  return validateDispatchCapabilityValue(value).ok ? value as DispatchCapabilityState : null;
}

export type { PendingState, TeamState, TrustedCheckpointAnswer, TypedCheckpointDecision, WorkIdentity, CheckpointPolicy };
