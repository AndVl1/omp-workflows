import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  validateWorkIdentityValue,
  type ControlPlaneValidation,
} from "./control-plane-contract.js";
import {
  controlPath,
  readRunControlNoRecovery,
  readRunStateNoRecovery,
  runTarget,
} from "./run-store.js";
import {
  updateStateAtomically,
  withWorkspaceReadNoRecovery,
  type StateMutation,
  type StateSnapshot,
} from "./state.js";
import { loadProfile } from "./profile.js";
import type {
  DispatchRecord,
  RunControl,
  TeamState,
  TrustedExecutionContext,
  WorkIdentity,
  WorktreeExecutionClaim,
} from "./types.js";
import type {
  AuthenticatedRecoveryGrant,
  RecoveryAction,
  RecoveryAuthority,
  RecoveryBudget,
  RecoveryCancelAcknowledgement,
  RecoveryErrorField,
  RecoveryErrorClass,
  RecoveryEvidenceProof,
  RecoveryHandoffState,
  RecoveryMutation,
  RecoveryOperationRecord,
  RecoveryOwnershipProof,
  RecoveryPreflightNotStartedProof,
  RecoveryResponsePayload,
  RecoveryRevision,
  RecoveryStateProof,
  RecoveryTerminalProof,
  RecoveryTransitionEvidence,
  StageProducerBinding,
  StageRecoveryAckRequest,
  StageRecoveryPrepareRequest,
  StageRecoverySnapshot,
  StageRecoveryStore,
  StageRecoveryTransitionRequest,
  StageRecoveryTransitionResult,
  TrustedRecoveryHandoff,
  TrustedRecoverySelection,
} from "./stage-recovery.js";

/** The only persisted field added by the recovery adapter. */
export const STAGE_RECOVERY_FIELD = "stage_recovery" as const;
export const STAGE_RECOVERY_SCHEMA_VERSION = 1 as const;
/** The bounded repair allowance required for known recovery classes. */
export const DEFAULT_RECOVERY_BUDGET_LIMIT = 2 as const;
export const DEFAULT_RECOVERY_BUDGET_CLASSES: readonly RecoveryErrorClass[] = [
  "preflight_not_started",
  "terminal_failure",
  "cancelled",
  "incomplete_assignment",
  "format_validation",
  "transport",
];
export function recoveryBudgetsWithDefaults(budgets: readonly RecoveryBudget[]): RecoveryBudget[] {
  const result = budgets.map((entry) => ({ ...entry }));
  for (const errorClass of DEFAULT_RECOVERY_BUDGET_CLASSES) {
    if (!result.some((entry) => entry.error_class === errorClass)) result.push({ error_class: errorClass, limit: DEFAULT_RECOVERY_BUDGET_LIMIT, used: 0 });
  }
  return result;
}
export function recoveryBudgetsForPrepare(budgets: readonly RecoveryBudget[], errorClass: RecoveryErrorClass): RecoveryBudget[] {
  if (budgets.some((entry) => entry.error_class === errorClass) || !DEFAULT_RECOVERY_BUDGET_CLASSES.includes(errorClass)) return budgets.map((entry) => ({ ...entry }));
  return [...budgets.map((entry) => ({ ...entry })), { error_class: errorClass, limit: DEFAULT_RECOVERY_BUDGET_LIMIT, used: 0 }];
}

/**
 * Recovery state is a projection of the canonical assignment, not an
 * authority record.  In particular it deliberately contains no claim token,
 * owner proof, or `authenticated` bit.  Those values are recomputed from the
 * current run-control claim every read/transition.
 */
export interface StageRecoveryGrantRecord {
  readonly grant_id: string;
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly owner_id: string;
  readonly ownership_epoch: string;
  readonly error_class: RecoveryErrorClass;
  readonly identity: WorkIdentity;
  readonly limit: number;
  readonly used: number;
  readonly reason: string;
  readonly authorizer: string;
  /** A non-secret provenance digest; never accepted as host authority. */
  readonly proof_digest: string;
}

/** Persisted operation adds an immutable request digest and replacement permit metadata. */
export interface StageRecoveryOperationRecord extends RecoveryOperationRecord {
  readonly mutation_digest: string;
  /** Owner-minted replacement assignment; callers never supply this identity. */
  readonly replacement_identity?: WorkIdentity;
  /** Admission is consumed by the canonical dispatch transaction, not by ack. */
  readonly admission?: {
    readonly state: "ready" | "consumed";
    readonly tool_call_id?: string;
  };
}

export interface PreparedRecoveryAdmissionScope {
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  /** Current canonical rework generation supplied by the admitting owner. */
  readonly generation: number;
  /** The failed/preflight assignment whose bounded replacement is being admitted. */
  readonly identity: WorkIdentity;
  readonly retry_of: string;
  /** Optional exact owner-minted replacement identity for duplicate-permit disambiguation. */
  readonly replacement_identity?: WorkIdentity;
}

export interface ConsumePreparedRecoveryAdmissionSuccess {
  readonly ok: true;
  readonly operation_id: string;
  readonly retry_of: string;
  readonly replacement_identity: WorkIdentity;
  readonly ledger: StageRecoveryLedger;
}

export interface ConsumePreparedRecoveryAdmissionFailure {
  readonly ok: false;
  readonly code:
    | "admission_tool_call_required"
    | "admission_not_found"
    | "admission_ambiguous"
    | "admission_already_consumed"
    | "admission_invalid";
  readonly operation_id?: string;
}

export type ConsumePreparedRecoveryAdmissionResult = ConsumePreparedRecoveryAdmissionSuccess | ConsumePreparedRecoveryAdmissionFailure;

export interface StageRecoveryLineage {
  readonly generation: number;
  readonly identity: WorkIdentity;
  readonly producer?: StageProducerBinding;
  readonly producer_available?: boolean;
  readonly lifecycle: StageRecoverySnapshot["lifecycle"];
  /** Ownership epoch that recorded the latest nonterminal lifecycle evidence. */
  readonly lifecycle_owner_epoch?: string;
  readonly terminal?: RecoveryTerminalProof;
  readonly preflight?: RecoveryPreflightNotStartedProof;
  readonly error_context?: StageRecoverySnapshot["error_context"];
  readonly budgets: readonly RecoveryBudget[];
  readonly grants: readonly StageRecoveryGrantRecord[];
  readonly operations: readonly StageRecoveryOperationRecord[];
  readonly handoff?: RecoveryHandoffState;
  readonly cancellation?: {
    readonly requested: boolean;
    readonly acknowledgement?: RecoveryCancelAcknowledgement;
  };
}

export interface StageRecoveryLedger {
  readonly schema_version: typeof STAGE_RECOVERY_SCHEMA_VERSION;
  /** Stable assignment lineage key; old waves remain after a new wave begins. */
  readonly lineages: Readonly<Record<string, StageRecoveryLineage>>;
}

export interface StageRecoveryLedgerValidation {
  readonly ok: true;
  readonly ledger: StageRecoveryLedger;
}
export interface StageRecoveryLedgerValidationFailure {
  readonly ok: false;
  readonly error: string;
}
export type StageRecoveryLedgerValidationResult = StageRecoveryLedgerValidation | StageRecoveryLedgerValidationFailure;

/** Opaque, in-process proof issued only after Main has authenticated a UI grant. */
export interface RecoveryGrantAuthorizationProof {
  readonly __opaque_recovery_grant_proof: unique symbol;
}

export interface StageRecoveryGrantAuthorizationInput {
  readonly expected_revision: RecoveryRevision;
  readonly selection: TrustedRecoverySelection;
  readonly identity?: WorkIdentity;
}

export interface StageRecoveryGrantCommitInput {
  readonly proof: RecoveryGrantAuthorizationProof;
  readonly expected_revision: RecoveryRevision;
  readonly selection: TrustedRecoverySelection;
  readonly grant_id: string;
  readonly error_class: RecoveryErrorClass;
  readonly identity: WorkIdentity;
  readonly limit: number;
  readonly reason: string;
  readonly authorizer: string;
}
export interface StageRecoveryGrantCommitSuccess {
  readonly ok: true;
  readonly grant: AuthenticatedRecoveryGrant;
  readonly revision: RecoveryRevision;
  readonly state_proof: RecoveryStateProof;
}
export interface StageRecoveryGrantCommitFailure {
  readonly ok: false;
  readonly code: string;
  readonly revision?: RecoveryRevision;
}
export type StageRecoveryGrantCommitResult = StageRecoveryGrantCommitSuccess | StageRecoveryGrantCommitFailure;

export interface StageRecoveryStoreAuthentication {
  /** Derive the current host selection; this never accepts model fields. */
  readonly selection: (identity?: WorkIdentity) => TrustedRecoverySelection;
  /** Main calls this only after its explicit trusted UI answer is authenticated. */
  readonly captureGrantAuthorization: (input: StageRecoveryGrantAuthorizationInput) => RecoveryGrantAuthorizationProof;
  readonly commitGrant: (input: StageRecoveryGrantCommitInput) => StageRecoveryGrantCommitResult;
  /** Read the owner-derived current stage handoff without mutating or minting a dispatch. */
  readonly readCurrentHandoff: (input: CurrentRecoveryHandoffInput) => CurrentRecoveryHandoffResult;
}
export interface CurrentRecoveryHandoffInput {
  readonly run_id: string;
  /** Optional exact canonical identity; omit to resolve the current assignment. */
  readonly identity?: WorkIdentity;
  readonly selection?: TrustedRecoverySelection;
}
export type CurrentRecoveryHandoffFailureCode =
  | "recovery_foreign_run"
  | "recovery_foreign_owner"
  | "recovery_branch_mismatch"
  | "recovery_run_unavailable"
  | "recovery_foreign_assignment"
  | "recovery_state_corrupt"
  | "handoff_unavailable";
export interface CurrentRecoveryHandoffSuccess {
  readonly ok: true;
  readonly revision: RecoveryRevision;
  readonly handoff: TrustedRecoveryHandoff;
}
export interface CurrentRecoveryHandoffFailure {
  readonly ok: false;
  readonly code: CurrentRecoveryHandoffFailureCode;
  readonly revision?: RecoveryRevision;
  readonly begin_required?: boolean;
  readonly stage_cursor?: string;
  readonly generation?: number;
}
export type CurrentRecoveryHandoffResult = CurrentRecoveryHandoffSuccess | CurrentRecoveryHandoffFailure;

export interface StageRecoveryFormatValidationContext {
  readonly class: "format_validation";
  readonly code: string;
  readonly message: string;
  readonly field_errors: readonly RecoveryErrorField[];
  readonly source: "canonical";
}
export interface StageRecoveryFormatValidationInput {
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly expected_revision: RecoveryRevision;
  readonly selection: TrustedRecoverySelection;
  readonly identity: WorkIdentity;
  readonly state_proof: RecoveryStateProof;
  readonly producer: StageProducerBinding;
  readonly error_context: StageRecoveryFormatValidationContext;
}
export type StageRecoveryFormatValidationResult =
  | { readonly ok: true; readonly revision: RecoveryRevision; readonly state_proof: RecoveryStateProof; readonly error_context: StageRecoveryFormatValidationContext }
  | { readonly ok: false; readonly code: string; readonly revision?: RecoveryRevision };
export type OrdinaryStageRecoveryStore = StageRecoveryStore & StageRecoveryStoreAuthentication & {
  readonly recordFormatValidation: (input: StageRecoveryFormatValidationInput) => StageRecoveryFormatValidationResult;
};
export interface OrdinaryStageRecoveryStoreOptions {
  readonly context: TrustedExecutionContext;
  readonly runId: string;
}

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LINEAGE_KEY = /^[a-f0-9]{64}$/;
const ACTIONS: Record<RecoveryAction, true> = { none: true, observe: true, preflight: true, reconnect: true, resume: true, replace: true, retry: true, wait: true, clarify: true, cancel_ack: true, refresh_handoff: true, repair_format: true };
const LIFECYCLES: Record<StageRecoverySnapshot["lifecycle"], true> = { pending: true, running: true, disconnected: true, terminal: true, not_started: true, unknown: true };
const AUTHORITIES: Record<RecoveryAuthority, true> = { ordinary: true, cto: true };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function integer(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalize(entry)]));
  return value;
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
function identityKey(identity: WorkIdentity): string {
  return canonicalJson(identity);
}
function lineageIdentity(identity: WorkIdentity, rootDispatchId = identity.dispatch_id): Record<string, unknown> {
  const { dispatch_id: _dispatchId, attempt: _attempt, ...stable } = identity;
  return { root_dispatch_id: rootDispatchId, ...stable };
}
function sameIdentity(left: WorkIdentity | undefined, right: WorkIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && identityKey(left) === identityKey(right);
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function sanitizePersisted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePersisted);
  if (!record(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = sanitizePersisted(entry);
  const proof = result.proof;
  if (record(proof) && typeof proof.authenticated === "boolean") {
    result.proof = {
      ...proof,
      authenticated: false,
      ...(Object.prototype.hasOwnProperty.call(proof, "binding_id") ? { binding_id: "historical" } : {}),
    };
  }
  if (typeof result.authenticated === "boolean" && typeof result.source === "string" && typeof result.run_id === "string" && (result.authority === "ordinary" || result.authority === "cto")) {
    result.authenticated = false;
    if (Object.prototype.hasOwnProperty.call(result, "binding_id")) result.binding_id = "historical";
  }
  return result;
}
function persistedClone<T>(value: T): T {
  return sanitizePersisted(clone(value)) as T;
}
function identityValid(value: unknown): value is WorkIdentity {
  const validation: ControlPlaneValidation = validateWorkIdentityValue(value);
  return validation.ok;
}
function keyFor(identity: WorkIdentity, generation: number, rootDispatchId = identity.dispatch_id): string {
  return digest({ schema: 1, generation, identity: lineageIdentity(identity, rootDispatchId) });
}
export function stageRecoveryLineageKey(identity: WorkIdentity, generation: number): string {
  return keyFor(identity, generation);
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[], path: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) issues.push(`${path}.${key} is not supported`);
}
function validateProof(value: unknown, path: string, issues: string[]): void {
  if (!record(value)) { issues.push(`${path} must be an object`); return; }
  allowedKeys(value, ["authenticated", "source", "event_id", "binding_id", "observed_at", "state_revision", "digest"], path, issues);
  if (value.authenticated !== true && value.authenticated !== false) issues.push(`${path}.authenticated must be boolean`);
  if (!nonEmpty(value.source) || !nonEmpty(value.event_id) || !nonEmpty(value.observed_at) || (value.authenticated === true ? !nonEmpty(value.binding_id) : value.binding_id !== "historical")) issues.push(`${path} has invalid provenance identifiers`);
  if (value.digest !== undefined && !HASH.test(String(value.digest))) issues.push(`${path}.digest must be sha256`);
  if (value.state_revision !== undefined && !(typeof value.state_revision === "string" || integer(value.state_revision))) issues.push(`${path}.state_revision is invalid`);
}
function validateIdentity(value: unknown, path: string, issues: string[]): void {
  if (!identityValid(value)) issues.push(`${path} is not a valid WorkIdentity`);
}
function validateEvidence(value: unknown, path: string, issues: string[]): void {
  if (!record(value)) { issues.push(`${path} must be an object`); return; }
  if (value.authoritative !== true || !nonEmpty(value.run_id) || !nonEmpty(value.dispatch_id) || !record(value.identity)) issues.push(`${path} has invalid host evidence identity`);
  validateIdentity(value.identity, `${path}.identity`, issues);
  validateProof(value.proof, `${path}.proof`, issues);
}
function validateTerminal(value: unknown, path: string, issues: string[]): void {
  if (!record(value)) { issues.push(`${path} must be an object`); return; }
  allowedKeys(value, ["authoritative", "run_id", "dispatch_id", "identity", "outcome", "terminal_event_id", "observed_at", "proof"], path, issues);
  if (value.authoritative !== true || !nonEmpty(value.run_id) || !nonEmpty(value.dispatch_id) || !nonEmpty(value.terminal_event_id) || !["succeeded", "failed", "cancelled"].includes(String(value.outcome)) || !nonEmpty(value.observed_at)) issues.push(`${path} has invalid terminal proof`);
  validateIdentity(value.identity, `${path}.identity`, issues);
  validateProof(value.proof, `${path}.proof`, issues);
}
function validatePreflight(value: unknown, path: string, issues: string[]): void {
  if (!record(value)) { issues.push(`${path} must be an object`); return; }
  allowedKeys(value, ["authoritative", "kind", "never_started", "run_id", "dispatch_id", "identity", "reason", "observed_at", "proof"], path, issues);
  if (value.authoritative !== true || value.kind !== "preflight_not_started" || value.never_started !== true || !nonEmpty(value.run_id) || !nonEmpty(value.dispatch_id) || !nonEmpty(value.reason) || !nonEmpty(value.observed_at)) issues.push(`${path} has invalid preflight proof`);
  validateIdentity(value.identity, `${path}.identity`, issues);
  validateProof(value.proof, `${path}.proof`, issues);
}
function validateProducer(value: unknown, path: string, issues: string[]): void {
  if (!record(value)) { issues.push(`${path} must be an object`); return; }
  allowedKeys(value, ["authority", "identity", "host", "producer"], path, issues);
  if (value.authority !== "ordinary" && value.authority !== "cto") issues.push(`${path}.authority is invalid`);
  validateIdentity(value.identity, `${path}.identity`, issues);
  if (!record(value.host)) {
    issues.push(`${path}.host is invalid`);
  } else {
    allowedKeys(value.host, ["session_id", "worktree", "branch"], `${path}.host`, issues);
    if (!nonEmpty(value.host.session_id) || !nonEmpty(value.host.worktree) || !nonEmpty(value.host.branch)) issues.push(`${path}.host is invalid`);
  }
  const producer = value.producer;
  if (!record(producer)) {
    issues.push(`${path}.producer is invalid`);
    return;
  }
  const kind = producer.kind;
  if (kind === "worker") {
    allowedKeys(producer, ["kind", "profile", "role", "slot_id", "agent", "generation", "wave_id", "slice_id", "stage_id", "iteration", "lineage"], `${path}.producer`, issues);
    for (const key of ["profile", "role", "slot_id", "agent", "wave_id", "slice_id", "stage_id"]) if (!nonEmpty(producer[key])) issues.push(`${path}.producer.${key} is invalid`);
    if (!integer(producer.generation) || !integer(producer.iteration)) issues.push(`${path}.producer generation/iteration is invalid`);
    if (!record(producer.lineage)) {
      issues.push(`${path}.producer.lineage is invalid`);
    } else {
      allowedKeys(producer.lineage, ["session_id", "session_file", "parent_session_file", "parent_tool_call_id", "lifecycle_id"], `${path}.producer.lineage`, issues);
      for (const key of ["session_id", "session_file", "parent_session_file", "parent_tool_call_id", "lifecycle_id"]) if (!nonEmpty(producer.lineage[key])) issues.push(`${path}.producer.lineage.${key} is invalid`);
    }
  } else if (kind === "orchestrator") {
    allowedKeys(producer, ["kind", "profile", "stage_id", "iteration", "generation", "wave_id", "slice_id", "owner"], `${path}.producer`, issues);
    for (const key of ["profile", "stage_id", "wave_id", "slice_id"]) if (!nonEmpty(producer[key])) issues.push(`${path}.producer.${key} is invalid`);
    if (!integer(producer.iteration) || !integer(producer.generation) || (producer.owner !== "main-session" && producer.owner !== "native-lead")) issues.push(`${path}.producer iteration/generation/owner is invalid`);
  } else if (kind === "tool") {
    allowedKeys(producer, ["kind", "profile", "stage_id", "iteration", "generation", "wave_id", "slice_id", "tool_name"], `${path}.producer`, issues);
    for (const key of ["profile", "stage_id", "wave_id", "slice_id", "tool_name"]) if (!nonEmpty(producer[key])) issues.push(`${path}.producer.${key} is invalid`);
    if (!integer(producer.iteration) || !integer(producer.generation)) issues.push(`${path}.producer iteration/generation is invalid`);
  } else {
    issues.push(`${path}.producer.kind is invalid`);
  }
}
function validateBudget(value: unknown, path: string, issues: string[]): void {
  if (!record(value)) { issues.push(`${path} must be an object`); return; }
  if (!nonEmpty(value.error_class) || !integer(value.limit) || !integer(value.used) || Number(value.used) > Number(value.limit)) issues.push(`${path} is invalid`);
}
function validateGrantRecord(value: unknown, path: string, issues: string[]): void {
  if (!record(value)) { issues.push(`${path} must be an object`); return; }
  allowedKeys(value, ["grant_id", "run_id", "authority", "owner_id", "ownership_epoch", "error_class", "identity", "limit", "used", "reason", "authorizer", "proof_digest"], path, issues);
  if (!nonEmpty(value.grant_id) || !nonEmpty(value.run_id) || !Object.hasOwn(AUTHORITIES, String(value.authority)) || !nonEmpty(value.owner_id) || !nonEmpty(value.ownership_epoch) || !nonEmpty(value.error_class) || !integer(value.limit, 1) || !integer(value.used) || Number(value.used) > Number(value.limit) || !nonEmpty(value.reason) || !nonEmpty(value.authorizer) || !HASH.test(String(value.proof_digest))) issues.push(`${path} is invalid`);
  validateIdentity(value.identity, `${path}.identity`, issues);
}
function validateOperation(value: unknown, path: string, issues: string[]): void {
  if (!record(value)) { issues.push(`${path} must be an object`); return; }
  allowedKeys(value, ["operation_id", "parent_operation_id", "run_id", "authority", "action", "status", "dispatch_id", "expected_revision", "revision", "retry_of", "error_class", "producer_correction", "response", "evidence", "mutation_digest", "replacement_identity", "admission"], path, issues);
  if (!nonEmpty(value.operation_id) || !nonEmpty(value.run_id) || !Object.hasOwn(AUTHORITIES, String(value.authority)) || !Object.hasOwn(ACTIONS, String(value.action)) || !["prepared", "acked"].includes(String(value.status)) || !(typeof value.expected_revision === "string" || integer(value.expected_revision)) || !(typeof value.revision === "string" || integer(value.revision)) || !HASH.test(String(value.mutation_digest))) issues.push(`${path} is invalid`);
  if (value.admission !== undefined) {
    if (!record(value.admission) || !["ready", "consumed"].includes(String(value.admission.state))) issues.push(`${path}.admission is invalid`);
    else if (value.admission.state === "consumed" && !nonEmpty(value.admission.tool_call_id)) issues.push(`${path}.admission.tool_call_id is required when consumed`);
    else if (value.admission.tool_call_id !== undefined && !nonEmpty(value.admission.tool_call_id)) issues.push(`${path}.admission.tool_call_id is invalid`);
    if (record(value.admission)) allowedKeys(value.admission, ["state", "tool_call_id"], `${path}.admission`, issues);
    if (value.replacement_identity === undefined) issues.push(`${path}.admission requires replacement_identity`);
  }
  if (value.evidence !== undefined) validateEvidence(value.evidence, `${path}.evidence`, issues);
  if (value.response !== undefined && !record(value.response)) issues.push(`${path}.response must be an object`);
}
function validateLineage(value: unknown, path: string, issues: string[]): void {
  if (!record(value)) { issues.push(`${path} must be an object`); return; }
  allowedKeys(value, ["generation", "identity", "producer", "producer_available", "lifecycle", "lifecycle_owner_epoch", "terminal", "preflight", "error_context", "budgets", "grants", "operations", "handoff", "cancellation"], path, issues);
  if (!integer(value.generation) || !Object.hasOwn(LIFECYCLES, String(value.lifecycle))) issues.push(`${path} generation/lifecycle is invalid`);
  if (value.lifecycle_owner_epoch !== undefined && !nonEmpty(value.lifecycle_owner_epoch)) issues.push(`${path}.lifecycle_owner_epoch is invalid`);
  validateIdentity(value.identity, `${path}.identity`, issues);
  if (value.producer !== undefined) validateProducer(value.producer, `${path}.producer`, issues);
  if (value.producer_available !== undefined && typeof value.producer_available !== "boolean") issues.push(`${path}.producer_available is invalid`);
  if (value.terminal !== undefined) validateTerminal(value.terminal, `${path}.terminal`, issues);
  if (value.preflight !== undefined) validatePreflight(value.preflight, `${path}.preflight`, issues);
  if (!Array.isArray(value.budgets) || !Array.isArray(value.grants) || !Array.isArray(value.operations)) issues.push(`${path} budgets/grants/operations must be arrays`);
  else {
    value.budgets.forEach((entry, index) => validateBudget(entry, `${path}.budgets[${index}]`, issues));
    value.grants.forEach((entry, index) => validateGrantRecord(entry, `${path}.grants[${index}]`, issues));
    value.operations.forEach((entry, index) => validateOperation(entry, `${path}.operations[${index}]`, issues));
  }
  if (value.cancellation !== undefined && (!record(value.cancellation) || typeof value.cancellation.requested !== "boolean")) issues.push(`${path}.cancellation is invalid`);
}

/** Strict validator shared by ordinary and native canonical state validators. */
export function validateStageRecoveryLedger(value: unknown): StageRecoveryLedgerValidationResult {
  const issues: string[] = [];
  if (!record(value)) return { ok: false, error: "stage_recovery must be an object" };
  allowedKeys(value, ["schema_version", "lineages"], "stage_recovery", issues);
  if (value.schema_version !== STAGE_RECOVERY_SCHEMA_VERSION) issues.push("stage_recovery.schema_version is unsupported");
  if (!record(value.lineages)) issues.push("stage_recovery.lineages must be an object");
  else {
    for (const [key, lineage] of Object.entries(value.lineages)) {
      if (!LINEAGE_KEY.test(key)) issues.push(`stage_recovery.lineages.${key} has an unsafe key`);
      validateLineage(lineage, `stage_recovery.lineages.${key}`, issues);
    }
  }
  if (issues.length > 0) return { ok: false, error: issues.join("; ") };
  return { ok: true, ledger: persistedClone(value as unknown as StageRecoveryLedger) };
}

/** Additive migration for the short-lived single-lineage draft shape. */
export function migrateStageRecoveryLedger(value: unknown): StageRecoveryLedger | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error("stage_recovery must be an object");
  if (value.schema_version === undefined && record(value.lineage) && record(value.lineages) === false) {
    const identity = value.lineage.identity;
    if (!identityValid(identity)) throw new Error("legacy stage_recovery.lineage identity is invalid");
    const generation = integer(value.lineage.generation) ? value.lineage.generation : 0;
    const migrated = {
      schema_version: STAGE_RECOVERY_SCHEMA_VERSION,
      lineages: { [keyFor(identity, generation)]: { ...value.lineage, generation, budgets: value.lineage.budgets ?? [], grants: value.lineage.grants ?? [], operations: value.lineage.operations ?? [] } },
    };
    const checked = validateStageRecoveryLedger(migrated);
    if (!checked.ok) throw new Error(checked.error);
    return checked.ledger;
  }
  const checked = validateStageRecoveryLedger(value);
  if (!checked.ok) throw new Error(checked.error);
  return checked.ledger;
}

function sameRecoveryScope(left: WorkIdentity, right: WorkIdentity): boolean {
  return left.run_id === right.run_id
    && left.wave_id === right.wave_id
    && left.slice_id === right.slice_id
    && left.session_id === right.session_id
    && left.workflow === right.workflow
    && left.stage_id === right.stage_id
    && left.stage_cursor === right.stage_cursor
    && left.capability_id === right.capability_id
    && left.capability_epoch === right.capability_epoch
    && left.loop_iteration === right.loop_iteration
    && left.slot_id === right.slot_id
    && left.task_id === right.task_id;
}

/**
 * Consume an owner-prepared replacement permit without taking a workspace
 * lock. Ordinary and native admission owners call this inside the same
 * canonical dispatch-creation transaction that records the new dispatch.
 * Replaying the exact tool call is idempotent; a different call can never
 * consume the bounded permit twice.
 */
export function consumePreparedRecoveryAdmission(
  ledger: StageRecoveryLedger,
  scope: PreparedRecoveryAdmissionScope,
  toolCallId: string,
): ConsumePreparedRecoveryAdmissionResult {
  if (!nonEmpty(toolCallId)) return { ok: false, code: "admission_tool_call_required" };
  if (!integer(scope.generation)) return { ok: false, code: "admission_invalid" };
  const matches: Array<{ key: string; line: StageRecoveryLineage; operation: StageRecoveryOperationRecord }> = [];
  for (const [key, line] of Object.entries(ledger.lineages)) {
    if (line.generation !== scope.generation || !sameRecoveryScope(line.identity, scope.identity)) continue;
    for (const operation of line.operations) {
      if (operation.run_id !== scope.run_id || operation.authority !== scope.authority || operation.retry_of !== scope.retry_of) continue;
      if (scope.replacement_identity && (!operation.replacement_identity || !sameIdentity(operation.replacement_identity, scope.replacement_identity))) continue;
      if ((operation.status !== "prepared" && operation.status !== "acked") || !operation.replacement_identity || !operation.admission) continue;
      matches.push({ key, line, operation });
    }
  }
  if (matches.length === 0) return { ok: false, code: "admission_not_found" };
  if (matches.length > 1) return { ok: false, code: "admission_ambiguous" };
  const match = matches[0]!;
  const admission = match.operation.admission!;
  if (admission.state === "consumed") {
    return admission.tool_call_id === toolCallId
      ? { ok: true, operation_id: match.operation.operation_id, retry_of: match.operation.retry_of!, replacement_identity: clone(match.operation.replacement_identity!), ledger: clone(ledger) }
      : { ok: false, code: "admission_already_consumed", operation_id: match.operation.operation_id };
  }
  const nextOperation: StageRecoveryOperationRecord = { ...match.operation, admission: { state: "consumed", tool_call_id: toolCallId } };
  const nextLine: StageRecoveryLineage = { ...match.line, operations: match.line.operations.map((entry) => entry.operation_id === match.operation.operation_id ? nextOperation : entry) };
  return {
    ok: true,
    operation_id: match.operation.operation_id,
    retry_of: match.operation.retry_of!,
    replacement_identity: clone(match.operation.replacement_identity!),
    ledger: { schema_version: STAGE_RECOVERY_SCHEMA_VERSION, lineages: { ...ledger.lineages, [match.key]: nextLine } },
  };
}

interface CurrentOwner {
  readonly claim: WorktreeExecutionClaim;
  readonly owner_id: string;
  readonly ownership_epoch: string;
  readonly binding_id: string;
  readonly proof: string;
}
interface CanonicalRead {
  readonly state: TeamState;
  readonly raw_hash: string;
  readonly revision: number;
  readonly owner: CurrentOwner;
}

function exactClaim(claim: WorktreeExecutionClaim | null, runId: string, context: TrustedExecutionContext): WorktreeExecutionClaim | undefined {
  if (!claim || claim.owner_kind !== "workflow" || claim.run_id !== runId || claim.released_at !== null) return undefined;
  if (claim.coordinator_session_id !== context.session_id) return undefined;
  if ((claim.coordinator_process_id ?? undefined) !== (context.process_id ?? undefined)) return undefined;
  return claim;
}
function currentOwner(control: RunControl, runId: string, context: TrustedExecutionContext, identity?: WorkIdentity): CurrentOwner {
  const claim = exactClaim(control.execution_claim, runId, context);
  if (!claim) throw new Error("authenticated ordinary workflow claim is not current");
  const binding_id = digest({ version: 1, authority: "ordinary", run_id: runId, owner_id: claim.coordinator_session_id, ownership_epoch: claim.ownership_epoch, identity: identity ?? null });
  const proof = digest({ version: 1, authority: "ordinary", run_id: runId, owner_id: claim.coordinator_session_id, ownership_epoch: claim.ownership_epoch, binding_id });
  return { claim, owner_id: claim.coordinator_session_id, ownership_epoch: claim.ownership_epoch, binding_id, proof };
}
function stateRaw(cwd: string, runId: string): string {
  return readFileSync(runTarget(cwd, runId).statePath, "utf8");
}
function controlWhileLocked(cwd: string): RunControl {
  const raw = readFileSync(controlPath(cwd), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!record(parsed)) throw new Error("ordinary run control is malformed");
  return parsed as unknown as RunControl;
}
function dispatchCandidates(state: TeamState): Array<{ identity: WorkIdentity; record?: DispatchRecord }> {
  const result: Array<{ identity: WorkIdentity; record?: DispatchRecord }> = [];
  const add = (identity: WorkIdentity | undefined, dispatch?: DispatchRecord): void => {
    if (!identity || identity.run_id !== state.run_id || identity.stage_cursor !== state.stage_cursor || !identityValid(identity)) return;
    const existing = result.find((entry) => sameIdentity(entry.identity, identity));
    if (existing) {
      if (!existing.record && dispatch) existing.record = dispatch;
      return;
    }
    result.push({ identity: clone(identity), ...(dispatch ? { record: dispatch } : {}) });
  };
  add(state.work_identity);
  add(state.dispatch_capability?.work_identity);
  add(state.dispatch_capability?.producer_assignment);
  add(state.pending?.identity);
  for (const dispatch of state.dispatch_capability?.dispatches ?? []) {
    if ("work_identity" in dispatch) add(dispatch.work_identity, dispatch as DispatchRecord);
    add(dispatch.pending?.identity, dispatch as DispatchRecord);
  }
  return result;
}
function identityForState(state: TeamState, requested?: WorkIdentity): { identity?: WorkIdentity; dispatch?: DispatchRecord } {
  const candidates = dispatchCandidates(state);
  if (requested) {
    const found = candidates.find((entry) => sameIdentity(entry.identity, requested));
    return found ? { identity: found.identity, dispatch: found.record } : {};
  }
  if (state.work_identity) {
    const found = candidates.find((entry) => sameIdentity(entry.identity, state.work_identity));
    if (found) return { identity: found.identity, dispatch: found.record };
  }
  return candidates.length === 1 ? { identity: candidates[0]!.identity, dispatch: candidates[0]!.record } : {};
}
function generationFor(state: TeamState, _identity: WorkIdentity): number {
  return typeof state.rework_generation === "number" && Number.isSafeInteger(state.rework_generation)
    ? Math.max(0, state.rework_generation)
    : 0;
}
function rootDispatchIdFor(state: TeamState, identity: WorkIdentity): string {
  const records = (state.dispatch_capability?.dispatches ?? []).filter((entry): entry is DispatchRecord => "work_identity" in entry);
  const byId = new Map(records.map((entry) => [entry.id, entry]));
  let current = identity.dispatch_id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const record = byId.get(current);
    const parent = record?.pending?.retry_of;
    if (!nonEmpty(parent)) break;
    current = parent;
  }
  return current;
}
function replacementIdentityFor(state: TeamState, identity: WorkIdentity): WorkIdentity | undefined {
  const capability = state.dispatch_capability;
  const issued = capability?.issued_for;
  if (!capability || !issued || capability.capability_id !== identity.capability_id || issued.cursor_epoch !== identity.capability_epoch || issued.stage_cursor !== identity.stage_cursor || issued.workflow !== identity.workflow) return undefined;
  const attempts = (capability.dispatches ?? []).flatMap((entry) => {
    const candidate = (entry as DispatchRecord).work_identity;
    return candidate && sameRecoveryScope(candidate, identity) ? [candidate.attempt] : [];
  });
  const attempt = Math.max(identity.attempt, ...attempts, 0) + 1;
  return { ...clone(identity), dispatch_id: randomUUID(), attempt };
}
function producerFor(cwd: string, state: TeamState, identity: WorkIdentity, owner: CurrentOwner, line?: StageRecoveryLineage): StageProducerBinding | undefined {
  if (line?.producer) return clone(line.producer);
  const profile = loadProfile(identity.workflow);
  if (!profile) return undefined;
  const stage = profile.stages.find((candidate) => candidate.id === identity.stage_id);
  if (!stage) return undefined;
  const dispatch = (state.dispatch_capability?.dispatches ?? []).find((entry) => "work_identity" in entry && sameIdentity(entry.work_identity, identity)) as DispatchRecord | undefined;
  const producerBase = { authority: "ordinary" as const, identity: clone(identity), host: { session_id: owner.claim.coordinator_session_id, worktree: cwd, branch: state.branch } };
  const generation = generationFor(state, identity);
  if (stage.producer?.kind === "tool") return { ...producerBase, producer: { kind: "tool", profile: profile.name, stage_id: identity.stage_id, iteration: identity.loop_iteration ?? 1, generation, wave_id: identity.wave_id, slice_id: identity.slice_id, tool_name: stage.producer.tool_name } };
  if (dispatch) return undefined; // A worker binding requires persisted trusted session lineage.
  return { ...producerBase, producer: { kind: "orchestrator", profile: profile.name, stage_id: identity.stage_id, iteration: identity.loop_iteration ?? 1, generation, wave_id: identity.wave_id, slice_id: identity.slice_id, owner: "main-session" } };
}
function ordinaryProducerKindMatches(state: TeamState, identity: WorkIdentity, producer: StageProducerBinding): boolean {
  const profile = loadProfile(identity.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === identity.stage_id);
  if (!profile || !stage) return false;
  const dispatch = (state.dispatch_capability?.dispatches ?? []).some((entry) => "work_identity" in entry && sameIdentity(entry.work_identity, identity));
  const expected = stage.producer?.kind === "tool" ? "tool" : dispatch ? "worker" : "orchestrator";
  return producer.producer.kind === expected;
}
function workerDispatchFor(state: TeamState, identity: WorkIdentity, dispatch: DispatchRecord | undefined, line?: StageRecoveryLineage): boolean {
  if (!dispatch) return false;
  if (line?.producer) return line.producer.producer.kind === "worker";
  const profile = loadProfile(identity.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === identity.stage_id);
  return stage?.producer?.kind !== "tool";
}
function lifecycleFor(state: TeamState, identity: WorkIdentity | undefined, dispatch: DispatchRecord | undefined, line: StageRecoveryLineage | undefined, ownerEpoch: string): StageRecoverySnapshot["lifecycle"] {
  if (line?.lifecycle === "terminal" || line?.lifecycle === "not_started") return line.lifecycle;
  if (!identity) return "unknown";
  const pending = dispatch?.pending ?? state.pending;
  const status = dispatch?.status ?? pending?.status ?? "pending";
  if (status === "succeeded" || status === "failed" || status === "cancelled") return "terminal";
  if (status === "running" || status === "authorized") {
    if (workerDispatchFor(state, identity, dispatch, line) && dispatch?.origin_ownership_epoch !== ownerEpoch) return "unknown";
    return "running";
  }
  if (status === "pending") {
    if (pending?.pending_reason === "transport_reconnect") return "disconnected";
    if (pending?.pending_reason === "awaiting_result" && !pending.provider_ref?.startsWith("preflight:")) return "unknown";
    return "pending";
  }
  return "unknown";
}
function proofFor(cwd: string, runId: string, revision: number, rawHash: string, identity?: WorkIdentity): RecoveryStateProof {
  return { authenticated: true, source: "ordinary-canonical-state", run_id: runId, authority: "ordinary", revision, ...(identity ? { dispatch_id: identity.dispatch_id, identity: clone(identity) } : {}), digest: rawHash, ...(identity ? { event_id: identity.dispatch_id } : {}), observed_at: new Date().toISOString() };
}
function ownershipFor(runId: string, owner: CurrentOwner, identity?: WorkIdentity): RecoveryOwnershipProof {
  return { authenticated: true, run_id: runId, authority: "ordinary", owner_id: owner.owner_id, ownership_epoch: owner.ownership_epoch, binding_id: owner.binding_id, proof: owner.proof };
}
function grantProofDigest(value: StageRecoveryGrantRecord, owner: CurrentOwner): string {
  return digest({ version: 1, run_id: value.run_id, authority: value.authority, grant_id: value.grant_id, owner_id: owner.owner_id, ownership_epoch: owner.ownership_epoch, error_class: value.error_class, identity: value.identity, limit: value.limit, reason: value.reason, authorizer: value.authorizer });
}
function grantSnapshot(recordValue: StageRecoveryGrantRecord, owner?: CurrentOwner): AuthenticatedRecoveryGrant {
  return { authenticated: true, grant_id: recordValue.grant_id, run_id: recordValue.run_id, authority: recordValue.authority, owner_id: owner?.owner_id ?? recordValue.owner_id, ownership_epoch: owner?.ownership_epoch ?? recordValue.ownership_epoch, error_class: recordValue.error_class, identity: clone(recordValue.identity), limit: recordValue.limit, used: recordValue.used, reason: recordValue.reason, authorizer: recordValue.authorizer, proof: owner ? grantProofDigest(recordValue, owner) : recordValue.proof_digest };
}
function persistedLedger(state: TeamState): StageRecoveryLedger | undefined {
  const raw = (state as unknown as Record<string, unknown>)[STAGE_RECOVERY_FIELD];
  return migrateStageRecoveryLedger(raw);
}
function withLedger(state: TeamState, ledger: StageRecoveryLedger): TeamState {
  return { ...state, [STAGE_RECOVERY_FIELD]: ledger } as TeamState;
}
function lineFor(ledger: StageRecoveryLedger | undefined, identity: WorkIdentity | undefined, generation: number, rootDispatchId?: string): { key: string; line?: StageRecoveryLineage } {
  if (!identity) return { key: "" };
  const key = keyFor(identity, generation, rootDispatchId);
  const direct = ledger?.lineages[key];
  if (direct) return { key, line: direct };
  const matches = Object.entries(ledger?.lineages ?? {}).filter(([, line]) => line.generation === generation && sameRecoveryScope(line.identity, identity));
  if (matches.length === 1) return { key: matches[0]![0], line: matches[0]![1] };
  const linked = matches.filter(([, line]) => line.operations.some((operation) => operation.replacement_identity && sameIdentity(operation.replacement_identity, identity)));
  return linked.length === 1 ? { key: linked[0]![0], line: linked[0]![1] } : { key };
}
function historicalProof(
  proof: RecoveryEvidenceProof,
  bindingId: string,
): RecoveryEvidenceProof | undefined {
  if ((proof.authenticated !== true && proof.authenticated !== false) || !nonEmpty(proof.source) || !nonEmpty(proof.event_id) || !nonEmpty(proof.observed_at) || (proof.authenticated === false && proof.binding_id !== "historical") || (proof.authenticated === true && !nonEmpty(proof.binding_id))) return undefined;
  return { ...proof, authenticated: true, binding_id: bindingId };
}
function terminalForRead(
  terminal: RecoveryTerminalProof | undefined,
  identity: WorkIdentity | undefined,
  dispatch: DispatchRecord | undefined,
  bindingId: string,
): RecoveryTerminalProof | undefined {
  if (!terminal || !identity || !dispatch || !dispatch.work_identity || !sameIdentity(terminal.identity, identity) || terminal.dispatch_id !== identity.dispatch_id || dispatch.id !== identity.dispatch_id || !sameIdentity(dispatch.work_identity, identity) || dispatch.status !== terminal.outcome) return undefined;
  const proof = historicalProof(terminal.proof, bindingId);
  return proof ? { ...clone(terminal), proof } : undefined;
}
/** Reuse a host-committed terminal envelope; a bare cancelled status is insufficient. */
function canonicalTerminalForRead(dispatch: DispatchRecord | undefined, identity: WorkIdentity | undefined, bindingId: string): RecoveryTerminalProof | undefined {
  if (!dispatch || !identity) return undefined;
  const envelope = dispatch.completion_envelope;
  const completion = dispatch.completion;
  if (!envelope || !completion || !sameIdentity(dispatch.work_identity, identity) || !sameIdentity(envelope.identity, identity) || !sameIdentity(completion.work_identity, identity)
    || envelope.outcome !== dispatch.status || completion.outcome !== dispatch.status
    || (envelope.outcome !== "succeeded" && envelope.outcome !== "failed" && envelope.outcome !== "cancelled")
    || envelope.completed_by !== "synchronous_tool_result" || completion.completed_by !== "synchronous_tool_result"
    || (envelope.terminal_signal !== "provider_terminal" && envelope.terminal_signal !== "native_tool_result")
    || !nonEmpty(envelope.evidence_ref) || !nonEmpty(envelope.emitted_at)) return undefined;
  const eventId = `canonical-completion:${dispatch.id}`;
  return {
    authoritative: true, run_id: identity.run_id, dispatch_id: dispatch.id, identity: clone(identity),
    outcome: envelope.outcome, terminal_event_id: eventId, observed_at: envelope.emitted_at,
    proof: { authenticated: true, source: "ordinary-canonical-completion", event_id: eventId, binding_id: bindingId, observed_at: envelope.emitted_at },
  };
}
function preflightReceiptMatches(
  preflight: RecoveryPreflightNotStartedProof,
  operations: readonly StageRecoveryOperationRecord[],
  identity: WorkIdentity,
): boolean {
  const expected = canonicalJson(persistedClone(preflight));
  return operations.some((operation) => {
    if (operation.status !== "acked" || operation.dispatch_id !== identity.dispatch_id || (operation.action !== "observe" && operation.action !== "preflight")) return false;
    const preparedRevision = typeof operation.expected_revision === "number" ? operation.expected_revision + 1 : undefined;
    if (preparedRevision !== undefined && preflight.proof.state_revision !== preparedRevision) return false;
    if (operation.response?.state_revision !== preflight.proof.state_revision) return false;
    const evidence = operation.evidence;
    const responseEvidence = operation.response?.evidence;
    return evidence?.kind === "preflight_not_started"
      && responseEvidence?.kind === "preflight_not_started"
      && canonicalJson(persistedClone(evidence)) === expected
      && canonicalJson(persistedClone(responseEvidence)) === expected;
  });
}
function canonicalPreflightRefusal(dispatch: DispatchRecord, identity: WorkIdentity, preflight: RecoveryPreflightNotStartedProof): boolean {
  const signal: string = typeof dispatch.completion_envelope?.terminal_signal === "string" ? String(dispatch.completion_envelope.terminal_signal) : "";
  if (dispatch.status !== "failed" || dispatch.completion_envelope?.outcome !== "failed" || (signal !== "preflight:missing_prompt" && signal !== "preflight:invalid_arguments")) return false;
  if (dispatch.id !== identity.dispatch_id || !dispatch.completion || dispatch.completion.dispatch_id !== identity.dispatch_id || dispatch.completion.outcome !== "failed" || !sameIdentity(dispatch.completion.work_identity, identity)) return false;
  const suffix = `:${identity.dispatch_id}`;
  const eventId = preflight.proof.event_id;
  if (!eventId.startsWith("task_call:") || !eventId.endsWith(suffix) || !dispatch.tool_call_id) return false;
  return eventId.slice("task_call:".length, -suffix.length) === dispatch.tool_call_id;
}
function preflightForRead(
  preflight: RecoveryPreflightNotStartedProof | undefined,
  operations: readonly StageRecoveryOperationRecord[],
  identity: WorkIdentity | undefined,
  dispatch: DispatchRecord | undefined,
  bindingId: string,
): RecoveryPreflightNotStartedProof | undefined {
  if (!preflight || !identity || !dispatch || !dispatch.work_identity || !sameIdentity(preflight.identity, identity) || preflight.dispatch_id !== identity.dispatch_id || dispatch.id !== identity.dispatch_id || !sameIdentity(dispatch.work_identity, identity) || !canonicalPreflightRefusal(dispatch, identity, preflight) || !preflightReceiptMatches(preflight, operations, identity)) return undefined;
  const proof = historicalProof(preflight.proof, bindingId);
  return proof ? { ...clone(preflight), proof } : undefined;
}
function materializeOperation(
  operation: StageRecoveryOperationRecord,
  revision: RecoveryRevision,
  stateProof: RecoveryStateProof,
  terminal?: RecoveryTerminalProof,
  preflight?: RecoveryPreflightNotStartedProof,
): StageRecoveryOperationRecord {
  const historicalEvidence = operation.evidence;
  let evidence = historicalEvidence;
  if (historicalEvidence?.kind === "preflight_not_started" && preflight && canonicalJson(persistedClone(historicalEvidence)) === canonicalJson(persistedClone(preflight))) {
    evidence = preflight;
  }
  if (
    historicalEvidence?.kind === "terminal"
    && terminal
    && historicalEvidence.authoritative === terminal.authoritative
    && historicalEvidence.run_id === terminal.run_id
    && historicalEvidence.dispatch_id === terminal.dispatch_id
    && sameIdentity(historicalEvidence.identity, terminal.identity)
    && historicalEvidence.outcome === terminal.outcome
    && historicalEvidence.terminal_event_id === terminal.terminal_event_id
    && historicalEvidence.observed_at === terminal.observed_at
    && canonicalJson(persistedClone(historicalEvidence.proof)) === canonicalJson(persistedClone(terminal.proof))
  ) {
    evidence = { ...historicalEvidence, proof: terminal.proof };
  }
  const historicalResponseEvidence = operation.response?.evidence;
  const responseEvidence = evidence && evidence.kind !== "handoff_refresh" ? evidence : undefined;
  const response = operation.response
    ? {
        ...operation.response,
        state_revision: revision,
        state_proof: stateProof,
        ...(responseEvidence && historicalResponseEvidence && historicalEvidence && canonicalJson(persistedClone(historicalResponseEvidence)) === canonicalJson(persistedClone(historicalEvidence)) ? { evidence: responseEvidence } : {}),
      }
    : undefined;
  return { ...operation, ...(evidence ? { evidence } : {}), ...(response ? { response } : {}) };
}
function snapshotFromRead(input: { cwd: string; run_id: string; state: TeamState; revision: number; raw_hash: string; owner: CurrentOwner; identity?: WorkIdentity }): StageRecoverySnapshot {
  const selected = identityForState(input.state, input.identity);
  const identity = selected.identity;
  const generation = identity ? generationFor(input.state, identity) : 0;
  const ledger = persistedLedger(input.state);
  const selectedLine = lineFor(ledger, identity, generation, identity ? rootDispatchIdFor(input.state, identity) : undefined).line;
  if (selectedLine && identity && !sameRecoveryScope(selectedLine.identity, identity)) throw new Error("stage recovery lineage does not match the canonical assignment scope");
  const producer = identity ? producerFor(input.cwd, input.state, identity, input.owner, selectedLine) : undefined;
  const proof = proofFor(input.cwd, input.run_id, input.revision, input.raw_hash, identity);
  const bindingId = identity ? digest({ version: 1, authority: "ordinary", run_id: input.run_id, owner_id: input.owner.owner_id, ownership_epoch: input.owner.ownership_epoch, identity }) : input.owner.binding_id;
  const ownership = ownershipFor(input.run_id, { ...input.owner, binding_id: bindingId, proof: digest({ version: 1, authority: "ordinary", run_id: input.run_id, owner_id: input.owner.owner_id, ownership_epoch: input.owner.ownership_epoch, binding_id: bindingId }) }, identity);
  const line = selectedLine;
  const terminal = terminalForRead(line?.terminal, identity, selected.dispatch, bindingId)
    ?? canonicalTerminalForRead(selected.dispatch, identity, bindingId);
  const preflight = preflightForRead(line?.preflight, line?.operations ?? [], identity, selected.dispatch, bindingId);
  const rawLifecycle = lifecycleFor(input.state, identity, selected.dispatch, line, input.owner.ownership_epoch);
  const lifecycle = (rawLifecycle === "terminal" && !terminal) || (rawLifecycle === "not_started" && !preflight) ? "unknown" : rawLifecycle;
  const stage = identity ? loadProfile(identity.workflow)?.stages.find((entry) => entry.id === identity.stage_id) : undefined;
  const outputs = stage ? (Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : []) : [];
  const receipt = identity ? Object.values(input.state.stage_receipts ?? {}).find((entry) => sameIdentity(entry.work_identity, identity)) : undefined;
  return {
    run_id: input.run_id,
    authority: "ordinary",
    revision: input.revision,
    state_proof: proof,
    ownership,
    ...(identity ? { identity } : {}),
    ...(producer ? { producer } : {}),
    binding_id: bindingId,
    ...(line?.producer_available === undefined ? { producer_available: producer !== undefined && lifecycle !== "terminal" } : { producer_available: line.producer_available }),
    lifecycle,
    ...(terminal ? { terminal } : {}),
    ...(identity && selected.dispatch && stage ? { submission: { required: outputs.length > 0, accepted: receipt !== undefined, task: input.state.task } } : {}),
    ...(preflight ? { preflight } : {}),
    ...(line?.error_context ? { error_context: clone(line.error_context) } : {}),
    budgets: clone(recoveryBudgetsWithDefaults(line?.budgets ?? [])),
    grants: clone((line?.grants ?? []).map((entry) => grantSnapshot(entry, input.owner))),
    operations: clone((line?.operations ?? []).map((entry) => {
      const materialized = materializeOperation(entry, input.revision, proof, terminal, preflight);
      const { mutation_digest: _digest, ...operation } = materialized;
      return operation;
    })),
    ...(line?.handoff ? { handoff: clone(line.handoff) } : {}),
    ...(line?.cancellation ? { cancellation: persistedClone(line.cancellation) } : {}),
  };
}
function readCanonical(cwd: string, runId: string, context: TrustedExecutionContext, identity?: WorkIdentity): CanonicalRead {
  if (!UUID.test(runId)) throw new Error("ordinary recovery requires a canonical UUID run id");
  if (context.caller !== "host" || context.authority !== "coordinator" || context.worktree !== cwd) throw new Error("ordinary recovery requires the authenticated coordinator host");
  const state = readRunStateNoRecovery(cwd, runId, context.branch);
  if (!state || state.run_id !== runId || state.branch !== context.branch) throw new Error("ordinary canonical run is unavailable or branch-mismatched");
  const raw = stateRaw(cwd, runId);
  const control = readRunControlNoRecovery(cwd);
  const selected = identityForState(state, identity).identity;
  return { state, raw_hash: createHash("sha256").update(raw, "utf8").digest("hex"), revision: typeof state.state_revision === "number" ? state.state_revision : 0, owner: currentOwner(control, runId, context, selected) };
}
function selectionFor(runId: string, context: TrustedExecutionContext, identity?: WorkIdentity): TrustedRecoverySelection {
  const current = withWorkspaceReadNoRecovery(context.worktree, () => readCanonical(context.worktree, runId, context), () => { throw new Error("ordinary canonical run is unavailable"); });
  const selected = identityForState(current.state, identity).identity;
  if (identity && !selected) throw new Error("ordinary recovery assignment is not current");
  const bindingId = selected ? digest({ version: 1, authority: "ordinary", run_id: runId, owner_id: current.owner.owner_id, ownership_epoch: current.owner.ownership_epoch, identity: selected }) : current.owner.binding_id;
  const proof = digest({ version: 1, authority: "ordinary", run_id: runId, owner_id: current.owner.owner_id, ownership_epoch: current.owner.ownership_epoch, binding_id: bindingId });
  return { authenticated: true, run_id: runId, authority: "ordinary", owner_id: current.owner.owner_id, ownership_epoch: current.owner.ownership_epoch, binding_id: bindingId, proof };
}
function selectionMatches(selection: TrustedRecoverySelection | undefined, snapshot: StageRecoverySnapshot, owner: CurrentOwner): boolean {
  if (!selection || selection.authenticated !== true || selection.run_id !== snapshot.run_id || selection.authority !== "ordinary" || selection.owner_id !== owner.owner_id || selection.ownership_epoch !== owner.ownership_epoch) return false;
  if (selection.binding_id !== undefined && selection.binding_id !== snapshot.binding_id && selection.binding_id !== owner.binding_id) return false;
  const expected = digest({ version: 1, authority: "ordinary", run_id: snapshot.run_id, owner_id: owner.owner_id, ownership_epoch: owner.ownership_epoch, binding_id: selection.binding_id ?? snapshot.binding_id });
  return selection.proof === expected;
}
function stateProofMatches(proof: RecoveryStateProof, snapshot: StageRecoverySnapshot): boolean {
  return proof.authenticated === true && proof.run_id === snapshot.run_id && proof.authority === "ordinary" && proof.revision === snapshot.revision && (!proof.digest || proof.digest === snapshot.state_proof.digest);
}
function operationFingerprint(mutation: RecoveryMutation): string {
  const copy = { ...mutation, state_proof: undefined } as Record<string, unknown>;
  delete copy.state_proof;
  delete copy.grant;
  return digest(copy);
}
function operationRecordFor(line: StageRecoveryLineage | undefined, operationId: string): StageRecoveryOperationRecord | undefined {
  return line?.operations.find((entry) => entry.operation_id === operationId || entry.parent_operation_id === operationId);
}
function failure(code: string, revision?: RecoveryRevision, operation?: RecoveryOperationRecord, remaining_attempts?: number): StageRecoveryTransitionResult {
  return { ok: false, code, ...(revision === undefined ? {} : { revision }), ...(operation ? { operation } : {}), ...(remaining_attempts === undefined ? {} : { remaining_attempts }) };
}
function currentLine(snapshot: StageRecoverySnapshot, ledger: StageRecoveryLedger | undefined, state: TeamState): { key: string; line: StageRecoveryLineage } | undefined {
  if (!snapshot.identity) return undefined;
  const generation = generationFor(state, snapshot.identity);
  const info = lineFor(ledger, snapshot.identity, generation, rootDispatchIdFor(state, snapshot.identity));
  if (info.line) return { key: info.key, line: clone(info.line) };
  return {
    key: info.key,
    line: { generation, identity: clone(snapshot.identity), ...(snapshot.producer ? { producer: clone(snapshot.producer) } : {}), ...(snapshot.producer_available === undefined ? {} : { producer_available: snapshot.producer_available }), lifecycle: snapshot.lifecycle, ...(snapshot.terminal ? { terminal: clone(snapshot.terminal) } : {}), ...(snapshot.preflight ? { preflight: clone(snapshot.preflight) } : {}), ...(snapshot.error_context ? { error_context: clone(snapshot.error_context) } : {}), budgets: clone(snapshot.budgets ?? []), grants: [], operations: [], ...(snapshot.handoff ? { handoff: clone(snapshot.handoff) } : {}), ...(snapshot.cancellation ? { cancellation: clone(snapshot.cancellation) } : {}) },
  };
}
function remaining(line: StageRecoveryLineage, errorClass?: RecoveryErrorClass): number {
  if (!errorClass) return 0;
  const budget = line.budgets.find((entry) => entry.error_class === errorClass);
  const base = budget ? Math.max(0, budget.limit - budget.used) : 0;
  const grants = line.grants.filter((entry) => entry.error_class === errorClass).reduce((total, entry) => total + Math.max(0, entry.limit - entry.used), 0);
  return base + grants;
}
function grantExact(input: AuthenticatedRecoveryGrant, line: StageRecoveryLineage, owner: CurrentOwner, snapshot: StageRecoverySnapshot): StageRecoveryGrantRecord | undefined {
  const found = line.grants.find((entry) => entry.grant_id === input.grant_id);
  if (!found) return undefined;
  const currentProof = grantProofDigest(found, owner);
  if (input.authenticated !== true || input.run_id !== snapshot.run_id || input.authority !== "ordinary" || input.error_class !== found.error_class || input.limit !== found.limit || input.used !== found.used || input.reason !== found.reason || input.authorizer !== found.authorizer || (input.proof !== found.proof_digest && input.proof !== currentProof) || !sameRecoveryScope(input.identity, found.identity)) return undefined;
  return found;
}
type BudgetConsumption = { ok: true; line: StageRecoveryLineage; remaining: number } | { ok: false; code: string };
function consumeBudget(line: StageRecoveryLineage, input: StageRecoveryPrepareRequest, snapshot: StageRecoverySnapshot, owner: CurrentOwner, errorClass: RecoveryErrorClass): { ok: true; line: StageRecoveryLineage; remaining: number } | { ok: false; code: string } {
  const mutation = input.mutation;
  if (mutation.kind !== "replacement" && mutation.kind !== "format_repair") return { ok: true, line, remaining: remaining(line, errorClass) };
  if (!snapshot.identity) return { ok: false, code: "recovery_identity_unavailable" };
  const budgetLine: StageRecoveryLineage = { ...line, budgets: recoveryBudgetsForPrepare(line.budgets, errorClass) };
  if (mutation.kind === "replacement") {
    if (!mutation.proof || !stateProofMatches(mutation.state_proof, snapshot)) return { ok: false, code: "invalid_terminal_proof" };
    if ("kind" in mutation.proof && mutation.proof.kind === "preflight_not_started") {
      if (!snapshot.preflight || canonicalJson(snapshot.preflight) !== canonicalJson(mutation.proof)) return { ok: false, code: "preflight_proof_unpersisted" };
    } else {
      if ("outcome" in mutation.proof && mutation.proof.outcome === "succeeded" && (errorClass !== "incomplete_assignment" || !snapshot.submission?.required || snapshot.submission.accepted)) return { ok: false, code: "assignment_continuation_denied" };
      if (!snapshot.terminal || canonicalJson(snapshot.terminal) !== canonicalJson(mutation.proof)) return { ok: false, code: "executor_not_attested_stopped" };
    }
  }
  if (mutation.kind === "format_repair" && !stateProofMatches(mutation.state_proof, snapshot)) return { ok: false, code: "stale_revision" };
  const requestedGrant = mutation.kind === "replacement" ? mutation.grant : undefined;
  if (requestedGrant) {
    if (!grantExact(requestedGrant, budgetLine, owner, snapshot)) return { ok: false, code: "grant_unpersisted" };
    const grant = budgetLine.grants.find((entry) => entry.grant_id === requestedGrant.grant_id)!;
    if (grant.used >= grant.limit) return { ok: false, code: "recovery_budget_exhausted" };
    const grants = budgetLine.grants.map((entry) => entry.grant_id === grant.grant_id ? { ...entry, used: entry.used + 1 } : entry);
    return { ok: true, line: { ...budgetLine, grants }, remaining: remaining({ ...budgetLine, grants }, errorClass) };
  }
  const index = budgetLine.budgets.findIndex((entry) => entry.error_class === errorClass && entry.used < entry.limit);
  if (index < 0) return { ok: false, code: "recovery_budget_exhausted" };
  const budgets = budgetLine.budgets.map((entry, position) => position === index ? { ...entry, used: entry.used + 1 } : entry);
  return { ok: true, line: { ...budgetLine, budgets }, remaining: remaining({ ...budgetLine, budgets }, errorClass) };
}
function mutationErrorClass(mutation: RecoveryMutation): RecoveryErrorClass | undefined {
  return mutation.kind === "replacement" ? mutation.error_class : mutation.kind === "format_repair" ? "format_validation" : undefined;
}
function proofTerminalMatchesCurrent(mutation: RecoveryMutation, snapshot: StageRecoverySnapshot): boolean {
  if (mutation.kind !== "replacement") return true;
  const proof = mutation.proof;
  if (!snapshot.identity || !sameIdentity(proof.identity, snapshot.identity) || proof.run_id !== snapshot.run_id || proof.dispatch_id !== snapshot.identity.dispatch_id) return false;
  const raw = proof.proof;
  return raw.authenticated === true && raw.binding_id === snapshot.binding_id && nonEmpty(raw.event_id) && nonEmpty(raw.source);
}
function evidenceValid(evidence: RecoveryTransitionEvidence, request: StageRecoveryAckRequest, snapshot: StageRecoverySnapshot, operation: StageRecoveryOperationRecord): boolean {
  if (evidence.kind === "handoff_refresh") {
    return evidence.authoritative === true && evidence.run_id === request.run_id && evidence.authority === "ordinary" && evidence.binding_id === snapshot.binding_id && evidence.revision === operation.revision && evidence.proof.authenticated === true && evidence.proof.run_id === request.run_id && evidence.proof.authority === "ordinary" && evidence.proof.revision === operation.revision;
  }
  if (evidence.authoritative !== true || evidence.run_id !== request.run_id || !snapshot.identity || !sameIdentity(evidence.identity, snapshot.identity) || evidence.dispatch_id !== (operation.dispatch_id ?? snapshot.identity.dispatch_id)) return false;
  if (!evidence.proof || evidence.proof.authenticated !== true || evidence.proof.binding_id !== snapshot.binding_id || !nonEmpty(evidence.proof.event_id) || !nonEmpty(evidence.proof.source) || !nonEmpty((evidence as { proof: RecoveryEvidenceProof }).proof.observed_at)) return false;
  if (evidence.proof.state_revision !== undefined && evidence.proof.state_revision !== operation.expected_revision && evidence.proof.state_revision !== operation.revision) return false;
  if (evidence.kind === "replacement_dispatched" && (!operation.replacement_identity || !sameIdentity(operation.replacement_identity, evidence.new_identity))) return false;
  return true;
}
function nextLineFromEvidence(line: StageRecoveryLineage, evidence: RecoveryTransitionEvidence, response: RecoveryResponsePayload): StageRecoveryLineage {
  if (evidence.kind === "handoff_refresh") {
    const handoff = evidence.handoff;
    return handoff ? { ...line, handoff: { status: "current", revision: handoff.revision, binding_id: handoff.binding_id, identity: clone(handoff.identity), run_id: handoff.run_id, authority: handoff.authority } } : line;
  }
  let lifecycle = line.lifecycle;
  if (evidence.kind === "preflight_not_started") lifecycle = "not_started";
  else if (evidence.kind === "running" || evidence.kind === "resume" && evidence.result === "running" || evidence.kind === "clarified" && evidence.result === "running" || evidence.kind === "format_repair" && evidence.accepted) lifecycle = "running";
  else if (evidence.kind === "disconnected" || evidence.kind === "clarified" && evidence.result === "disconnected") lifecycle = "disconnected";
  else if (evidence.kind === "terminal" || evidence.kind === "cancel_ack" || evidence.kind === "resume" && evidence.result === "terminal" || evidence.kind === "clarified" && evidence.result === "terminal" || evidence.kind === "format_repair" && !evidence.accepted) lifecycle = "terminal";
  else if (evidence.kind === "unknown" || evidence.kind === "resume" && evidence.result === "unknown" || evidence.kind === "clarified" && evidence.result === "unknown") lifecycle = "unknown";
  let next: StageRecoveryLineage = { ...line, lifecycle };
  if (evidence.kind === "preflight_not_started") next = { ...next, preflight: persistedClone(evidence) };
  if (evidence.kind === "terminal") next = { ...next, terminal: { authoritative: true, run_id: evidence.run_id, dispatch_id: evidence.dispatch_id, identity: clone(evidence.identity), outcome: evidence.outcome, terminal_event_id: evidence.terminal_event_id, observed_at: evidence.observed_at, proof: persistedClone(evidence.proof) } };
  if (evidence.kind === "cancel_ack") next = { ...next, cancellation: { requested: true, acknowledgement: persistedClone(evidence) } };
  if (response.error_context && response.error_context.class === "format_validation") next = { ...next, error_context: { class: "format_validation", code: response.error_context.code, message: response.error_context.message, ...(response.error_context.field_errors ? { field_errors: clone(response.error_context.field_errors) } : {}) } };
  return next;
}
function responseMatches(left: RecoveryResponsePayload | undefined, right: RecoveryResponsePayload): boolean {
  return left !== undefined && canonicalJson(persistedClone(left)) === canonicalJson(persistedClone(right));
}
function evidenceMatches(left: RecoveryTransitionEvidence | undefined, right: RecoveryTransitionEvidence): boolean {
  return left !== undefined && canonicalJson(persistedClone(left)) === canonicalJson(persistedClone(right));
}
function transitionIdentity(input: StageRecoveryTransitionRequest): WorkIdentity | undefined {
  if (input.phase === "ack") return input.evidence.identity;
  if (input.phase === "prepare") return input.mutation.state_proof.identity ?? (input.mutation.kind === "replacement" ? input.mutation.proof.identity : undefined);
  return undefined;
}
function operationLocated(ledger: StageRecoveryLedger | undefined, operationId: string): { line: StageRecoveryLineage; operation: StageRecoveryOperationRecord } | undefined {
  for (const line of Object.values(ledger?.lineages ?? {})) {
    const operation = operationRecordFor(line, operationId);
    if (operation) return { line, operation };
  }
  return undefined;
}

function terminalEvidenceReconciled(state: TeamState, evidence: Extract<RecoveryTransitionEvidence, { kind: "terminal" }>): boolean {
  const selected = identityForState(state, evidence.identity);
  return Boolean(selected.identity && selected.dispatch && selected.dispatch.id === evidence.dispatch_id && sameIdentity(selected.dispatch.work_identity, evidence.identity) && selected.dispatch.status === evidence.outcome);
}

function reconnectCanonicalDispatch(state: TeamState, identity: WorkIdentity): { ok: true; state: TeamState } | { ok: false; error: string } {
  const capability = state.dispatch_capability;
  if (!capability || capability.status === "complete" || capability.status === "invalidated") return { ok: false, error: "dispatch capability unavailable" };
  const selected = identityForState(state, identity);
  const record = selected.dispatch;
  if (!record || record.id !== identity.dispatch_id || !sameIdentity(record.work_identity, identity)) return { ok: false, error: "reconnect identity is stale or foreign" };
  if (record.status !== "pending" || record.pending?.status !== "pending" || record.pending.pending_reason !== "transport_reconnect") return { ok: false, error: "dispatch is not awaiting transport reconnect" };
  if (record.completion || record.completion_envelope?.outcome !== "pending" || record.completion_envelope.terminal_signal !== null) return { ok: false, error: "dispatch is no longer nonterminal" };
  const rootProjection = capability.kind === "single" && capability.expected_count === 1;
  if (rootProjection && (!sameIdentity(capability.work_identity, identity) || !sameIdentity(state.work_identity, identity))) return { ok: false, error: "reconnect root projection is stale or foreign" };
  const priorPending = record.pending;
  const runningPending = {
    identity: clone(identity),
    status: "running" as const,
    ...(priorPending.provider_ref !== undefined ? { provider_ref: priorPending.provider_ref } : {}),
    ...(priorPending.retry_of === undefined ? {} : { retry_of: priorPending.retry_of }),
    updated_at: priorPending.updated_at,
  };
  const runningEnvelope = {
    schema_version: 1 as const,
    identity: clone(identity),
    outcome: "pending" as const,
    terminal_signal: null,
    artifact_refs: [],
    evidence_ref: `evidence/${identity.dispatch_id}`,
    conflict_ref: null,
    completed_by: "engine_task_caller" as const,
    emitted_at: new Date().toISOString(),
  };
  const updatedRecord: DispatchRecord = { ...record, status: "running", pending: runningPending, completion_envelope: runningEnvelope };
  const updatedCapability = {
    ...capability,
    status: "dispatched" as const,
    dispatches: (capability.dispatches ?? []).map((entry) => entry.id === record.id ? updatedRecord : entry),
    pending: [...(capability.pending ?? []).filter((entry) => entry.identity.dispatch_id !== record.id), runningPending],
  };
  if (rootProjection) updatedCapability.work_identity = clone(identity);
  else delete updatedCapability.work_identity;
  const next: TeamState = { ...state, dispatch_capability: updatedCapability, updated_at: new Date().toISOString() };
  if (rootProjection) {
    next.work_identity = clone(identity);
    next.pending = { ...runningPending, status: "pending" };
    next.completion_envelope = runningEnvelope;
  } else {
    delete next.work_identity;
    delete next.pending;
    delete next.completion_envelope;
  }
  return { ok: true, state: next };
}
function transitionInState(cwd: string, context: TrustedExecutionContext, stateSnapshot: StateSnapshot, input: StageRecoveryTransitionRequest): StateMutation<StageRecoveryTransitionResult> {
  const state = stateSnapshot.state;
  if (!state) return { op: "discard", value: failure("run_unavailable") };
  const requestedIdentity = transitionIdentity(input);
  let owner: CurrentOwner;
  try {
    owner = currentOwner(controlWhileLocked(cwd), input.run_id, context, identityForState(state, requestedIdentity).identity);
  } catch {
    return { op: "discard", value: failure("recovery_authority_denied", stateSnapshot.revision) };
  }
  const canonical: CanonicalRead = { state, raw_hash: stateSnapshot.raw_hash, revision: stateSnapshot.revision, owner };
  const snapshot = snapshotFromRead({ cwd, run_id: input.run_id, state: canonical.state, revision: stateSnapshot.revision, raw_hash: canonical.raw_hash, owner: canonical.owner, identity: requestedIdentity });
  if (input.run_id !== state.run_id || input.authority !== "ordinary") return { op: "discard", value: failure("recovery_authority_denied", snapshot.revision) };
  if ((input.phase === "prepare" || input.phase === "ack") && !selectionMatches(input.selection, snapshot, canonical.owner)) return { op: "discard", value: failure("recovery_authority_denied", snapshot.revision) };
  if (input.phase === "replay" && input.selection && !selectionMatches(input.selection, snapshot, canonical.owner)) return { op: "discard", value: failure("recovery_authority_denied", snapshot.revision) };
  const ledger = persistedLedger(canonical.state);
  const nextRevision = stateSnapshot.revision + 1;
  if (input.phase === "replay") {
    const located = operationLocated(ledger, input.operation_id);
    const operation = located?.operation;
    const materialized = operation ? materializeOperation(operation, snapshot.revision, snapshot.state_proof, snapshot.terminal, snapshot.preflight) : undefined;
    return materialized ? { op: "discard", value: { ok: true, revision: snapshot.revision, operation: materialized, state_proof: snapshot.state_proof } } : { op: "discard", value: failure("operation_not_found", snapshot.revision) };
  }
  if (input.expected_revision !== snapshot.revision) return { op: "discard", value: failure("stale_revision", snapshot.revision) };
  const lineInfo = currentLine(snapshot, ledger, canonical.state);
  if (!lineInfo) return { op: "discard", value: failure("recovery_identity_unavailable", snapshot.revision) };
  const line = lineInfo.line;
  if (input.phase === "prepare") {
    const mutationDigest = operationFingerprint(input.mutation);
    const existing = operationRecordFor(line, input.operation_id);
    if (existing) {
      if (existing.mutation_digest !== mutationDigest || existing.run_id !== input.run_id || existing.authority !== input.authority) return { op: "discard", value: failure("operation_conflict", snapshot.revision, existing) };
      return { op: "discard", value: { ok: true, revision: snapshot.revision, operation: existing, state_proof: snapshot.state_proof, remaining_attempts: remaining(line, existing.error_class) } };
    }
    if (input.parent_operation_id && !operationRecordFor(line, input.parent_operation_id)) return { op: "discard", value: failure("parent_operation_not_found", snapshot.revision) };
    if (input.mutation.kind === "replacement") {
      if (!proofTerminalMatchesCurrent(input.mutation, snapshot)) return { op: "discard", value: failure("executor_not_attested_stopped", snapshot.revision) };
      const retryOf = input.mutation.retry_of;
      const linked = line.operations.find((entry) => entry.retry_of === retryOf && entry.operation_id !== input.operation_id && (entry.action === "replace" || entry.action === "retry"));
      if (linked) return { op: "discard", value: failure("operation_conflict", snapshot.revision, linked) };
    }
    const errorClass = mutationErrorClass(input.mutation);
    let consumed: BudgetConsumption = { ok: true, line, remaining: remaining(line, errorClass) };
    if (errorClass) consumed = consumeBudget(line, input, snapshot, canonical.owner, errorClass);
    if (!consumed.ok) return { op: "discard", value: failure(consumed.code, snapshot.revision, undefined, remaining(line, errorClass)) };
    let replacementIdentity: WorkIdentity | undefined;
    if (input.mutation.kind === "replacement") {
      replacementIdentity = replacementIdentityFor(canonical.state, snapshot.identity!);
      if (!replacementIdentity) return { op: "discard", value: failure("replacement_identity_unavailable", snapshot.revision) };
    }
    const action: RecoveryAction = input.mutation.kind === "host_action" ? input.mutation.action : input.mutation.kind === "handoff_refresh" ? input.mutation.action : input.mutation.kind === "format_repair" ? "repair_format" : "replace";
    const operation: StageRecoveryOperationRecord = {
      operation_id: input.operation_id,
      ...(input.parent_operation_id ? { parent_operation_id: input.parent_operation_id } : {}),
      run_id: input.run_id,
      authority: "ordinary",
      action,
      status: "prepared",
      ...(input.mutation.kind === "host_action" && input.mutation.dispatch_id ? { dispatch_id: input.mutation.dispatch_id } : {}),
      ...(input.mutation.kind === "replacement" ? {
        dispatch_id: input.mutation.dispatch_id ?? snapshot.identity!.dispatch_id,
        replacement_identity: replacementIdentity!,
        admission: { state: "ready" as const },
        retry_of: input.mutation.retry_of,
        error_class: input.mutation.error_class,
        ...(input.mutation.producer_correction ? { producer_correction: true } : {}),
      } : input.mutation.kind === "format_repair" ? {
        dispatch_id: input.mutation.dispatch_id,
        error_class: input.mutation.error_class,
      } : input.mutation.kind !== "host_action" && errorClass ? { error_class: errorClass } : {}),
      expected_revision: snapshot.revision,
      revision: nextRevision,
      mutation_digest: mutationDigest,
    };
    const nextLine: StageRecoveryLineage = { ...consumed.line, operations: [...consumed.line.operations, operation] };
    const nextLedger: StageRecoveryLedger = { schema_version: STAGE_RECOVERY_SCHEMA_VERSION, lineages: { ...(ledger?.lineages ?? {}), [lineInfo.key]: nextLine } };
    return { op: "commit", state: withLedger(canonical.state, nextLedger), value: { ok: true, revision: nextRevision, operation, state_proof: { authenticated: true, source: "ordinary-canonical-state", run_id: input.run_id, authority: "ordinary", revision: nextRevision }, remaining_attempts: consumed.remaining } };
  }
  const existing = operationRecordFor(line, input.operation_id);
  if (!existing) return { op: "discard", value: failure("operation_not_found", snapshot.revision) };
  if (existing.status === "acked") {
    if (!responseMatches(existing.response, input.response) || !evidenceMatches(existing.evidence, input.evidence)) return { op: "discard", value: failure("operation_conflict", snapshot.revision, existing) };
    return { op: "discard", value: { ok: true, revision: snapshot.revision, operation: existing, state_proof: snapshot.state_proof } };
  }
  if (input.evidence.kind === "terminal" && !terminalEvidenceReconciled(canonical.state, input.evidence)) return { op: "discard", value: failure("terminal_reconciliation_pending", snapshot.revision, existing) };
  if (input.evidence.kind === "handoff_refresh" && !input.evidence.handoff) return { op: "discard", value: failure("handoff_unissued", snapshot.revision, existing) };
  let commitState = canonical.state;
  if (existing.action === "reconnect" && input.evidence.kind === "running") {
    const reconnected = reconnectCanonicalDispatch(commitState, input.evidence.identity);
    if (!reconnected.ok) return { op: "discard", value: failure("reconnect_state_conflict", snapshot.revision, existing) };
    commitState = reconnected.state;
  }
  const acked: StageRecoveryOperationRecord = { ...existing, status: "acked", revision: nextRevision, response: persistedClone(input.response), evidence: persistedClone(input.evidence) };
  const nextLine = nextLineFromEvidence({ ...line, operations: line.operations.map((entry) => entry.operation_id === existing.operation_id ? acked : entry) }, input.evidence, input.response);
  const nextLedger: StageRecoveryLedger = { schema_version: STAGE_RECOVERY_SCHEMA_VERSION, lineages: { ...(ledger?.lineages ?? {}), [lineInfo.key]: nextLine } };
  return { op: "commit", state: withLedger(commitState, nextLedger), value: { ok: true, revision: nextRevision, operation: acked, state_proof: { authenticated: true, source: "ordinary-canonical-state", run_id: input.run_id, authority: "ordinary", revision: nextRevision }, ...(nextLine.handoff && nextLine.handoff.status === "current" ? { handoff: input.evidence.kind === "handoff_refresh" ? input.evidence.handoff : undefined } : {}) } };
}

export function formatValidationContextValid(context: StageRecoveryFormatValidationContext): boolean {
  if (!record(context)) return false;
  return context.class === "format_validation"
    && context.source === "canonical"
    && nonEmpty(context.code)
    && nonEmpty(context.message)
    && Array.isArray(context.field_errors)
    && context.field_errors.length > 0
    && context.field_errors.every((entry) => record(entry) && nonEmpty(entry.field) && nonEmpty(entry.message));
}
export function formatValidationProducerValid(producer: unknown, authority: RecoveryAuthority, identity: WorkIdentity): boolean {
  const issues: string[] = [];
  validateProducer(producer, "$.producer", issues);
  if (issues.length > 0 || !record(producer) || !identityValid(producer.identity)) return false;
  return producer.authority === authority && sameIdentity(producer.identity, identity);
}
function recordFormatValidationInState(cwd: string, context: TrustedExecutionContext, stateSnapshot: StateSnapshot, input: StageRecoveryFormatValidationInput): StateMutation<StageRecoveryFormatValidationResult> {
  const state = stateSnapshot.state;
  if (!state) return { op: "discard", value: { ok: false, code: "run_unavailable" } };
  if (input.run_id !== state.run_id || input.authority !== "ordinary") return { op: "discard", value: { ok: false, code: "recovery_authority_denied", revision: stateSnapshot.revision } };
  if (!formatValidationContextValid(input.error_context) || !formatValidationProducerValid(input.producer, input.authority, input.identity)) return { op: "discard", value: { ok: false, code: "invalid_format_validation", revision: stateSnapshot.revision } };
  let owner: CurrentOwner;
  try {
    owner = currentOwner(controlWhileLocked(cwd), input.run_id, context, identityForState(state, input.identity).identity);
  } catch {
    return { op: "discard", value: { ok: false, code: "recovery_authority_denied", revision: stateSnapshot.revision } };
  }
  const canonical: CanonicalRead = { state, raw_hash: stateSnapshot.raw_hash, revision: stateSnapshot.revision, owner };
  const snapshot = snapshotFromRead({ cwd, run_id: input.run_id, state, revision: stateSnapshot.revision, raw_hash: stateSnapshot.raw_hash, owner, identity: input.identity });
  if (snapshot.revision !== input.expected_revision) return { op: "discard", value: { ok: false, code: "stale_revision", revision: snapshot.revision } };
  if (!selectionMatches(input.selection, snapshot, owner)) return { op: "discard", value: { ok: false, code: "recovery_authority_denied", revision: snapshot.revision } };
  if (!snapshot.identity || !sameIdentity(snapshot.identity, input.identity) || !input.state_proof.identity || !sameIdentity(input.state_proof.identity, input.identity) || input.state_proof.dispatch_id !== input.identity.dispatch_id || !stateProofMatches(input.state_proof, snapshot)) return { op: "discard", value: { ok: false, code: "stale_revision", revision: snapshot.revision } };
  if (!ordinaryProducerKindMatches(state, input.identity, input.producer)) return { op: "discard", value: { ok: false, code: "invalid_format_validation", revision: snapshot.revision } };
  const lineInfo = currentLine(snapshot, persistedLedger(canonical.state), canonical.state);
  if (!lineInfo) return { op: "discard", value: { ok: false, code: "recovery_identity_unavailable", revision: snapshot.revision } };
  const ledger = persistedLedger(canonical.state);
  const persistedLine = ledger?.lineages[lineInfo.key];
  const existing = persistedLine?.error_context;
  const existingProducer = persistedLine?.producer;
  if (existingProducer && canonicalJson(existingProducer) !== canonicalJson(input.producer)) return { op: "discard", value: { ok: false, code: "format_validation_conflict", revision: snapshot.revision } };
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson(input.error_context)) return { op: "discard", value: { ok: false, code: "format_validation_conflict", revision: snapshot.revision } };
    return { op: "discard", value: { ok: true, revision: snapshot.revision, state_proof: snapshot.state_proof, error_context: clone(input.error_context) } };
  }
  const baseLine = persistedLine ?? { ...lineInfo.line, budgets: [], grants: [], operations: [] };
  const nextLine: StageRecoveryLineage = {
    ...baseLine,
    producer: clone(input.producer),
    producer_available: snapshot.lifecycle === "terminal" ? false : true,
    error_context: clone(input.error_context),
  };
  const nextLedger: StageRecoveryLedger = { schema_version: STAGE_RECOVERY_SCHEMA_VERSION, lineages: { ...(ledger?.lineages ?? {}), [lineInfo.key]: nextLine } };
  const nextRevision = stateSnapshot.revision + 1;
  const { digest: _digest, ...proofWithoutDigest } = snapshot.state_proof;
  const nextProof: RecoveryStateProof = { ...proofWithoutDigest, revision: nextRevision, observed_at: new Date().toISOString() };
  return { op: "commit", state: withLedger(state, nextLedger), value: { ok: true, revision: nextRevision, state_proof: nextProof, error_context: clone(input.error_context) } };
}
function makeGrantProof(): RecoveryGrantAuthorizationProof {
  return Object.freeze({}) as RecoveryGrantAuthorizationProof;
}

function trustedHandoffFromSnapshot(snapshot: StageRecoverySnapshot): TrustedRecoveryHandoff | undefined {
  const ownership = snapshot.ownership;
  const bindingId = snapshot.binding_id;
  if (!snapshot.identity || !ownership || !nonEmpty(bindingId) || snapshot.authority !== "ordinary" || snapshot.state_proof.revision !== snapshot.revision || snapshot.state_proof.run_id !== snapshot.run_id || snapshot.state_proof.authority !== "ordinary" || snapshot.state_proof.authenticated !== true) return undefined;
  return {
    run_id: snapshot.run_id,
    authority: snapshot.authority,
    revision: snapshot.revision,
    binding_id: bindingId,
    identity: clone(snapshot.identity),
    owner_id: ownership.owner_id,
    ownership_epoch: ownership.ownership_epoch,
    proof: clone(snapshot.state_proof),
  };
}

function currentHandoffFailure(error: unknown): CurrentRecoveryHandoffFailure {
  const message = String(error);
  if (message.includes("branch-mismatched")) return { ok: false, code: "recovery_branch_mismatch" };
  if (message.includes("canonical run is unavailable")) return { ok: false, code: "recovery_run_unavailable" };
  if (message.includes("authenticated") || message.includes("coordinator")) return { ok: false, code: "recovery_foreign_owner" };
  return { ok: false, code: "recovery_state_corrupt" };
}
export function createOrdinaryStageRecoveryStore(cwd: string, options: OrdinaryStageRecoveryStoreOptions): OrdinaryStageRecoveryStore {
  const context: TrustedExecutionContext = {
    session_id: options.context.session_id,
    caller: options.context.caller,
    ...(options.context.process_id === undefined ? {} : { process_id: options.context.process_id }),
    worktree: options.context.worktree,
    branch: options.context.branch,
    authority: options.context.authority,
  };
  const runId = options.runId;
  const activeProofs = new WeakMap<object, { expected_revision: RecoveryRevision; selection: TrustedRecoverySelection; identity?: WorkIdentity }>();
  const selection = (identity?: WorkIdentity): TrustedRecoverySelection => selectionFor(runId, context, identity);
  const captureGrantAuthorization = (input: StageRecoveryGrantAuthorizationInput): RecoveryGrantAuthorizationProof => {
    const current = withWorkspaceReadNoRecovery(cwd, () => readCanonical(cwd, runId, context, input.identity), () => { throw new Error("ordinary canonical run is unavailable"); });
    const snapshot = snapshotFromRead({ cwd, run_id: runId, state: current.state, revision: current.revision, raw_hash: current.raw_hash, owner: current.owner, identity: input.identity });
    if (input.expected_revision !== snapshot.revision || !selectionMatches(input.selection, snapshot, current.owner)) throw new Error("grant authorization is stale or not owned by the current coordinator");
    const proof = makeGrantProof();
    activeProofs.set(proof as object, { expected_revision: input.expected_revision, selection: clone(input.selection), ...(snapshot.identity ? { identity: clone(snapshot.identity) } : {}) });
    return proof;
  };
  const commitGrant = (input: StageRecoveryGrantCommitInput): StageRecoveryGrantCommitResult => {
    const proofRecord = activeProofs.get(input.proof as object);
    if (!proofRecord || proofRecord.expected_revision !== input.expected_revision || canonicalJson(proofRecord.selection) !== canonicalJson(input.selection) || !sameIdentity(proofRecord.identity, input.identity)) return { ok: false, code: "grant_proof_invalid" };
    const current = withWorkspaceReadNoRecovery(cwd, () => readCanonical(cwd, runId, context, input.identity), () => { throw new Error("ordinary canonical run is unavailable"); });
    const snapshot = snapshotFromRead({ cwd, run_id: runId, state: current.state, revision: current.revision, raw_hash: current.raw_hash, owner: current.owner, identity: input.identity });
    if (snapshot.revision !== input.expected_revision || !selectionMatches(input.selection, snapshot, current.owner) || !snapshot.identity || !sameIdentity(snapshot.identity, input.identity)) return { ok: false, code: "stale_revision", revision: snapshot.revision };
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || !nonEmpty(input.grant_id) || !nonEmpty(input.reason) || !nonEmpty(input.authorizer)) return { ok: false, code: "invalid_grant", revision: snapshot.revision };
    let result: StageRecoveryGrantCommitResult = { ok: false, code: "grant_commit_failed", revision: snapshot.revision };
    const update = updateStateAtomically(cwd, (state) => {
      const fresh = state.state;
      if (!fresh) return { op: "fail", code: "state_missing", error: "canonical ordinary state is missing" };
      let freshOwner: CurrentOwner;
      try {
        const control = controlWhileLocked(cwd);
        freshOwner = currentOwner(control, runId, context, identityForState(fresh, input.identity).identity);
      } catch {
        return { op: "fail", code: "state_invalid", error: "ordinary run control is unavailable or no longer owned" };
      }
      const freshCanonical: CanonicalRead = { state: fresh, raw_hash: state.raw_hash, revision: state.revision, owner: freshOwner };
      const freshSnapshot = snapshotFromRead({ cwd, run_id: runId, state: freshCanonical.state, revision: freshCanonical.revision, raw_hash: freshCanonical.raw_hash, owner: freshCanonical.owner, identity: input.identity });
      if (state.revision !== input.expected_revision || !selectionMatches(input.selection, freshSnapshot, freshCanonical.owner)) return { op: "fail", code: "state_conflict", error: "grant revision or owner selection is stale" };
      const ledger = persistedLedger(fresh);
      const lineInfo = currentLine(freshSnapshot, ledger, fresh);
      if (!lineInfo) return { op: "fail", code: "state_invalid", error: "recovery assignment identity is unavailable" };
      const existing = lineInfo.line.grants.find((entry) => entry.grant_id === input.grant_id);
      const proofDigest = digest({ version: 1, run_id: runId, authority: "ordinary", grant_id: input.grant_id, owner_id: freshCanonical.owner.owner_id, ownership_epoch: freshCanonical.owner.ownership_epoch, error_class: input.error_class, identity: input.identity, limit: input.limit, reason: input.reason, authorizer: input.authorizer });
      if (existing) {
        if (existing.error_class !== input.error_class || existing.limit !== input.limit || existing.reason !== input.reason || existing.authorizer !== input.authorizer || existing.proof_digest !== proofDigest || !sameIdentity(existing.identity, input.identity)) return { op: "fail", code: "grant_conflict", error: "grant id is already bound to different recovery authority" };
        result = { ok: true, grant: grantSnapshot(existing, freshOwner), revision: state.revision, state_proof: freshSnapshot.state_proof };
        return { op: "discard", value: undefined };
      }
      const grantRecord: StageRecoveryGrantRecord = { grant_id: input.grant_id, run_id: runId, authority: "ordinary", owner_id: freshCanonical.owner.owner_id, ownership_epoch: freshCanonical.owner.ownership_epoch, error_class: input.error_class, identity: clone(input.identity), limit: input.limit, used: 0, reason: input.reason, authorizer: input.authorizer, proof_digest: proofDigest };
      const nextLine: StageRecoveryLineage = { ...lineInfo.line, grants: [...lineInfo.line.grants, grantRecord] };
      const nextLedger: StageRecoveryLedger = { schema_version: STAGE_RECOVERY_SCHEMA_VERSION, lineages: { ...(ledger?.lineages ?? {}), [lineInfo.key]: nextLine } };
      result = { ok: true, grant: grantSnapshot(grantRecord, freshOwner), revision: state.revision + 1, state_proof: { authenticated: true, source: "ordinary-canonical-state", run_id: runId, authority: "ordinary", revision: state.revision + 1 } };
      return { op: "commit", state: withLedger(fresh, nextLedger), value: undefined };
    }, { target: runTarget(cwd, runId), branch: context.branch });
    if (!update.ok && result.ok === false) return { ok: false, code: update.code, revision: current.revision };
    if (result.ok) activeProofs.delete(input.proof as object);
    return result;
  };
  const recordFormatValidation = (input: StageRecoveryFormatValidationInput): StageRecoveryFormatValidationResult => {
    if (input.run_id !== runId || input.authority !== "ordinary") return { ok: false, code: "recovery_authority_denied" };
    const update = updateStateAtomically<StageRecoveryFormatValidationResult>(cwd, (state) => recordFormatValidationInState(cwd, context, state, input), { target: runTarget(cwd, runId), branch: context.branch });
    if (!update.ok) return { ok: false, code: update.code };
    return update.value ?? { ok: false, code: "format_validation_commit_failed" };
  };
  const read = (input: { run_id: string; authority: RecoveryAuthority; identity?: WorkIdentity; selection?: TrustedRecoverySelection }): StageRecoverySnapshot => {
    if (input.run_id !== runId || input.authority !== "ordinary") throw new Error("ordinary recovery store received a foreign authority or run");
    return withWorkspaceReadNoRecovery(cwd, () => {
      const canonical = readCanonical(cwd, runId, context, input.identity);
      return snapshotFromRead({ cwd, run_id: runId, state: canonical.state, revision: canonical.revision, raw_hash: canonical.raw_hash, owner: canonical.owner, identity: input.identity });
    }, () => { throw new Error("ordinary canonical run is unavailable"); });
  };
  const readCurrentHandoff = (input: CurrentRecoveryHandoffInput): CurrentRecoveryHandoffResult => {
    if (input.run_id !== runId) return { ok: false, code: "recovery_foreign_run" };
    try {
      return withWorkspaceReadNoRecovery<CurrentRecoveryHandoffResult>(cwd, () => {
        const canonical = readCanonical(cwd, runId, context, input.identity);
        const snapshot = snapshotFromRead({ cwd, run_id: runId, state: canonical.state, revision: canonical.revision, raw_hash: canonical.raw_hash, owner: canonical.owner, identity: input.identity });
        if (input.selection && !selectionMatches(input.selection, snapshot, canonical.owner)) return { ok: false, code: "recovery_foreign_owner", revision: snapshot.revision };
        if (input.identity && !snapshot.identity) return { ok: false, code: "recovery_foreign_assignment", revision: snapshot.revision };
        const handoff = trustedHandoffFromSnapshot(snapshot);
        const generation = typeof canonical.state.rework_generation === "number" && Number.isSafeInteger(canonical.state.rework_generation) ? Math.max(0, canonical.state.rework_generation) : 0;
        const metadata = { begin_required: true as const, ...(canonical.state.stage_cursor ? { stage_cursor: canonical.state.stage_cursor } : {}), generation };
        return handoff ? { ok: true, revision: snapshot.revision, handoff } : { ok: false, code: "handoff_unavailable", revision: snapshot.revision, ...metadata };
      }, () => currentHandoffFailure(new Error("ordinary canonical run is unavailable")));
    } catch (error) {
      return currentHandoffFailure(error);
    }
  };
  const transition = (input: StageRecoveryTransitionRequest): StageRecoveryTransitionResult => {
    if (input.run_id !== runId || input.authority !== "ordinary") return failure("recovery_authority_denied");
    let value: StageRecoveryTransitionResult | undefined;
    const update = updateStateAtomically(cwd, (state) => {
      const result = transitionInState(cwd, context, state, input);
      if (result.op === "commit" || result.op === "discard") value = result.value;
      return result;
    }, { target: runTarget(cwd, runId), branch: context.branch });
    if (!update.ok) {
      return failure(update.code === "state_conflict" ? "stale_revision" : update.code, undefined);
    }
    return value ?? failure("transition_rejected");
  };
  return { read, transition, selection, captureGrantAuthorization, commitGrant, recordFormatValidation, readCurrentHandoff };
}
