import { createHash } from "node:crypto";

import type { StageAuthority, StageProducerBinding } from "./reliable-stage.js";
import type { WorkIdentity } from "./types.js";

export type { StageProducerBinding };

/**
 * Recovery is deliberately a policy/orchestration boundary.  It never owns a
 * durable map: every observation and mutation goes through `StageRecoveryStore`.
 * Ordinary and native owners can therefore share this policy without sharing a
 * state file or bypassing their own revision/CAS rules.
 */

export type RecoveryAuthority = StageAuthority;
export type RecoveryRevision = string | number;
export type RecoveryCapabilityState = "supported" | "unsupported" | "unknown";
export type RecoveryOperation = "diagnose" | "reconcile";
export type RecoveryIntent =
  | "observe"
  | "reconnect"
  | "resume"
  | "replace"
  | "retry"
  | "clarify"
  | "cancel"
  | "cancel_ack"
  | "refresh_handoff"
  | "repair_format";
export type RecoveryWorkerState = "not_started" | "running" | "disconnected" | "terminal" | "unknown" | "unsupported";
export type RecoveryAction =
  | "none"
  | "observe"
  | "preflight"
  | "reconnect"
  | "resume"
  | "replace"
  | "retry"
  | "wait"
  | "clarify"
  | "cancel_ack"
  | "refresh_handoff"
  | "repair_format";
export type RecoveryErrorClass =
  | "preflight_not_started"
  | "terminal_failure"
  | "cancelled"
  | "format_validation"
  | "transport"
  | (string & {});

export type RecoveryCapability =
  | "preflight_not_started"
  | "inspect"
  | "observe"
  | "reconnect"
  | "resume"
  | "clarify"
  | "cancel_ack"
  | "format_repair"
  | "replacement_dispatch"
  | "producer_correction"
  | "operation_replay";

export interface RecoveryOwnershipProof {
  readonly authenticated: boolean;
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly owner_id: string;
  readonly ownership_epoch: string;
  readonly binding_id?: string;
  readonly proof: string;
}

export interface TrustedRecoverySelection {
  readonly authenticated: boolean;
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly owner_id: string;
  readonly ownership_epoch: string;
  readonly binding_id?: string;
  readonly proof: string;
}

export interface RecoveryStateProof {
  readonly authenticated: boolean;
  readonly source: string;
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly revision: RecoveryRevision;
  readonly dispatch_id?: string;
  readonly identity?: WorkIdentity;
  readonly event_id?: string;
  readonly digest?: string;
  readonly observed_at?: string;
}

export interface RecoveryEvidenceProof {
  readonly authenticated: boolean;
  readonly source: string;
  readonly event_id: string;
  readonly binding_id: string;
  readonly observed_at: string;
  readonly state_revision?: RecoveryRevision;
  readonly digest?: string;
}

export interface RecoveryTerminalProof {
  readonly authoritative: true;
  readonly run_id: string;
  readonly dispatch_id: string;
  readonly identity: WorkIdentity;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly terminal_event_id: string;
  readonly observed_at: string;
  readonly proof: RecoveryEvidenceProof;
}

export interface RecoveryPreflightNotStartedProof {
  readonly authoritative: true;
  readonly kind: "preflight_not_started";
  readonly never_started: true;
  readonly run_id: string;
  readonly dispatch_id: string;
  readonly identity: WorkIdentity;
  readonly reason: string;
  readonly observed_at: string;
  readonly proof: RecoveryEvidenceProof;
}

export interface RecoveryErrorField {
  readonly field: string;
  readonly message: string;
}

/** Error context comes from canonical state, not from a thrown exception. */
export interface StageRecoveryErrorContext {
  readonly class: RecoveryErrorClass;
  readonly code: string;
  readonly message: string;
  readonly field_errors?: readonly RecoveryErrorField[];
  readonly source?: "canonical" | "host" | "engine";
}

export interface RecoveryBudget {
  readonly error_class: RecoveryErrorClass;
  readonly limit: number;
  readonly used: number;
}

/**
 * A grant is intentionally not represented by a free-form reason alone.  The
 * state owner must authenticate and persist it before it contributes to a
 * replacement budget.
 */
export interface AuthenticatedRecoveryGrant {
  readonly authenticated: boolean;
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
  readonly proof: string;
}

export interface RecoveryHandoffState {
  readonly status: "current" | "stale";
  readonly revision: RecoveryRevision;
  readonly binding_id: string;
  readonly identity: WorkIdentity;
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
}

/** Handoffs are returned by the canonical owner; this module never mints tokens. */
export interface TrustedRecoveryHandoff {
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly revision: RecoveryRevision;
  readonly binding_id: string;
  readonly identity: WorkIdentity;
  readonly owner_id: string;
  readonly ownership_epoch: string;
  readonly proof: RecoveryStateProof;
  readonly value?: Readonly<Record<string, unknown>>;
}

export interface RecoveryOperationRecord {
  readonly operation_id: string;
  readonly parent_operation_id?: string;
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly action: RecoveryAction;
  readonly status: "prepared" | "acked";
  readonly dispatch_id?: string;
  readonly expected_revision: RecoveryRevision;
  readonly revision: RecoveryRevision;
  readonly retry_of?: string;
  readonly error_class?: RecoveryErrorClass;
  readonly producer_correction?: boolean;
  readonly replacement_identity?: WorkIdentity;
  readonly admission?: { readonly state: "ready" | "consumed"; readonly tool_call_id?: string };
  readonly response?: RecoveryResponsePayload;
  readonly evidence?: RecoveryTransitionEvidence;
}

export interface RecoveryResponsePayload {
  readonly code: string;
  readonly worker: RecoveryWorkerState;
  readonly action: RecoveryAction;
  readonly attempts_remaining: number;
  readonly state_revision?: RecoveryRevision;
  readonly state_proof?: RecoveryStateProof;
  readonly retry_of?: string;
  readonly blocking_condition?: string;
  readonly next_action?: string;
  readonly evidence?: RecoveryHostEvidence;
  readonly handoff?: TrustedRecoveryHandoff;
  readonly error_context?: SafeRecoveryErrorContext;
}

export interface SafeRecoveryErrorContext {
  readonly class: string;
  readonly code: string;
  readonly message: string;
  readonly field_errors?: readonly RecoveryErrorField[];
}

export interface StageRecoverySnapshot {
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly revision: RecoveryRevision;
  readonly state_proof: RecoveryStateProof;
  readonly ownership?: RecoveryOwnershipProof;
  readonly identity?: WorkIdentity;
  readonly producer?: StageProducerBinding;
  /** Stable owner-derived binding id used to authenticate host evidence. */
  readonly binding_id?: string;
  /** Canonical producer reachability; absent means unknown, never available. */
  readonly producer_available?: boolean;
  readonly lifecycle: "pending" | "running" | "disconnected" | "terminal" | "not_started" | "unknown";
  readonly terminal?: RecoveryTerminalProof;
  readonly preflight?: RecoveryPreflightNotStartedProof;
  readonly error_context?: StageRecoveryErrorContext;
  readonly budgets?: readonly RecoveryBudget[];
  readonly grants?: readonly AuthenticatedRecoveryGrant[];
  readonly operations?: readonly RecoveryOperationRecord[];
  readonly handoff?: RecoveryHandoffState;
  readonly cancellation?: {
    readonly requested: boolean;
    readonly acknowledgement?: RecoveryCancelAcknowledgement;
  };
}

export interface StageRecoveryRequest {
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly operation: RecoveryOperation;
  /** Stable caller id. Replays must use the same id; random ids are not generated here. */
  readonly operation_id: string;
  readonly intent?: RecoveryIntent;
  readonly identity?: WorkIdentity;
  readonly expected_revision?: RecoveryRevision;
  readonly selection?: TrustedRecoverySelection;
  readonly grant?: AuthenticatedRecoveryGrant;
  /** Host-provided deterministic timestamp for audit metadata only. */
  readonly now?: string;
}

export interface RecoveryHostInput {
  readonly request: StageRecoveryRequest;
  readonly operation_id: string;
  readonly snapshot: StageRecoverySnapshot;
  readonly identity: WorkIdentity;
  readonly state_proof: RecoveryStateProof;
  readonly prepared_operation?: RecoveryOperationRecord;
  readonly replacement_identity?: WorkIdentity;
  readonly error_context?: StageRecoveryErrorContext;
  readonly exact_format_errors?: readonly RecoveryErrorField[];
  readonly terminal?: RecoveryTerminalProof;
  readonly preflight?: RecoveryPreflightNotStartedProof;
}

export interface RecoveryHostEvidenceBase {
  readonly authoritative: true;
  readonly run_id: string;
  readonly dispatch_id: string;
  readonly identity: WorkIdentity;
  readonly operation: RecoveryCapability;
  readonly proof: RecoveryEvidenceProof;
}

export interface RecoveryRunningEvidence extends RecoveryHostEvidenceBase {
  readonly kind: "running";
  readonly same_worker: true;
}

export interface RecoveryDisconnectedEvidence extends RecoveryHostEvidenceBase {
  readonly kind: "disconnected";
  readonly transport: "unavailable";
}

export interface RecoveryUnknownEvidence extends RecoveryHostEvidenceBase {
  readonly kind: "unknown";
  readonly reason: string;
}

export interface RecoveryTerminalEvidence extends RecoveryHostEvidenceBase {
  readonly kind: "terminal";
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly terminal_event_id: string;
  readonly observed_at: string;
}

export type RecoveryObservationEvidence =
  | RecoveryRunningEvidence
  | RecoveryDisconnectedEvidence
  | RecoveryUnknownEvidence
  | RecoveryTerminalEvidence;

export type RecoveryPreflightEvidence = RecoveryPreflightNotStartedProof | RecoveryObservationEvidence;

export interface RecoveryResumeEvidence extends RecoveryHostEvidenceBase {
  readonly kind: "resume";
  readonly result: "running" | "terminal" | "unknown";
  readonly terminal_event_id?: string;
  readonly observed_at: string;
}

export interface RecoveryClarificationEvidence extends RecoveryHostEvidenceBase {
  readonly kind: "clarified";
  readonly result: "running" | "disconnected" | "terminal" | "unknown";
  readonly terminal_event_id?: string;
  readonly observed_at: string;
}

export interface RecoveryCancelAcknowledgement extends RecoveryHostEvidenceBase {
  readonly kind: "cancel_ack";
  readonly acknowledged: true;
  readonly executor_stopped: true;
  readonly observed_at: string;
}

export interface RecoveryFormatRepairEvidence extends RecoveryHostEvidenceBase {
  readonly kind: "format_repair";
  readonly same_producer: true;
  readonly accepted: boolean;
  readonly errors_digest: string;
  readonly observed_at: string;
}

export interface RecoveryReplacementEvidence extends RecoveryHostEvidenceBase {
  readonly kind: "replacement_dispatched";
  readonly original_dispatch_id: string;
  readonly new_identity: WorkIdentity;
  readonly new_state: "authorized" | "running" | "pending";
  readonly observed_at: string;
  readonly errors_digest?: string;
}

export type RecoveryHostEvidence =
  | RecoveryPreflightNotStartedProof
  | RecoveryRunningEvidence
  | RecoveryDisconnectedEvidence
  | RecoveryUnknownEvidence
  | RecoveryTerminalEvidence
  | RecoveryResumeEvidence
  | RecoveryClarificationEvidence
  | RecoveryCancelAcknowledgement
  | RecoveryFormatRepairEvidence
  | RecoveryReplacementEvidence;

export interface RecoveryHandoffRefreshEvidence {
  readonly kind: "handoff_refresh";
  readonly authoritative: true;
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly revision: RecoveryRevision;
  readonly binding_id: string;
  readonly identity: WorkIdentity;
  readonly proof: RecoveryStateProof;
  /** Returned by the canonical owner, never minted by the orchestrator. */
  readonly handoff?: TrustedRecoveryHandoff;
}

export type RecoveryTransitionEvidence = RecoveryHostEvidence | RecoveryHandoffRefreshEvidence;

export interface StageRecoveryCapabilities {
  readonly trusted_lineage?: RecoveryCapabilityState;
  readonly terminal_lifecycle?: RecoveryCapabilityState;
  readonly preflight_not_started?: RecoveryCapabilityState;
  readonly inspect?: RecoveryCapabilityState;
  readonly observe?: RecoveryCapabilityState;
  readonly reconnect?: RecoveryCapabilityState;
  readonly resume?: RecoveryCapabilityState;
  readonly clarify?: RecoveryCapabilityState;
  readonly cancel_ack?: RecoveryCapabilityState;
  readonly format_repair?: RecoveryCapabilityState;
  readonly replacement_dispatch?: RecoveryCapabilityState;
  readonly producer_correction?: RecoveryCapabilityState;
  readonly operation_replay?: RecoveryCapabilityState;
}

type MaybePromise<T> = T | Promise<T>;

export interface RecoveryOperationLookupEvidence {
  readonly kind: "operation_lookup";
  readonly authoritative: true;
  readonly run_id: string;
  readonly dispatch_id: string;
  readonly identity: WorkIdentity;
  readonly operation_id: string;
  readonly state: "dispatched" | "not_dispatched";
  readonly evidence?: RecoveryReplacementEvidence;
  readonly proof: RecoveryEvidenceProof;
}

export interface StageRecoveryHost {
  readonly capabilities: StageRecoveryCapabilities;
  readonly preflightNotStarted?: (input: RecoveryHostInput) => MaybePromise<RecoveryPreflightEvidence>;
  readonly observe?: (input: RecoveryHostInput) => MaybePromise<RecoveryObservationEvidence>;
  /** `inspect` is the host spelling used by some runtimes; it remains capability-gated. */
  readonly inspect?: (input: RecoveryHostInput) => MaybePromise<RecoveryObservationEvidence>;
  readonly reconnect?: (input: RecoveryHostInput) => MaybePromise<RecoveryObservationEvidence>;
  readonly resume?: (input: RecoveryHostInput) => MaybePromise<RecoveryResumeEvidence | RecoveryObservationEvidence>;
  readonly clarify?: (input: RecoveryHostInput) => MaybePromise<RecoveryClarificationEvidence | RecoveryObservationEvidence>;
  readonly cancelAck?: (input: RecoveryHostInput) => MaybePromise<RecoveryCancelAcknowledgement>;
  readonly formatRepair?: (input: RecoveryHostInput) => MaybePromise<RecoveryFormatRepairEvidence>;
  readonly lookupOperation?: (input: RecoveryHostInput) => MaybePromise<RecoveryOperationLookupEvidence>;
  readonly dispatchReplacement?: (input: RecoveryHostInput & {
    readonly retry_of: string;
    readonly error_class: RecoveryErrorClass;
    readonly producer_correction: boolean;
  }) => MaybePromise<RecoveryReplacementEvidence>;
}

export type RecoveryMutation =
  | {
      readonly kind: "host_action";
      readonly action: RecoveryAction;
      readonly dispatch_id?: string;
      readonly state_proof: RecoveryStateProof;
    }
  | {
      readonly kind: "replacement";
      readonly action: "replace" | "retry" | "repair_format";
      readonly dispatch_id: string;
      readonly retry_of: string;
      readonly error_class: RecoveryErrorClass;
      readonly state_proof: RecoveryStateProof;
      readonly proof: RecoveryTerminalProof | RecoveryPreflightNotStartedProof;
      readonly grant?: AuthenticatedRecoveryGrant;
      readonly producer_correction: boolean;
      readonly exact_error_digest?: string;
    }
  | {
      readonly kind: "handoff_refresh";
      readonly action: "refresh_handoff";
      readonly state_proof: RecoveryStateProof;
      readonly binding_id: string;
    }
  | {
      readonly kind: "format_repair";
      readonly action: "repair_format";
      readonly dispatch_id: string;
      readonly state_proof: RecoveryStateProof;
      readonly error_class: RecoveryErrorClass;
      readonly grant?: AuthenticatedRecoveryGrant;
      readonly exact_error_digest: string;
    };

export interface StageRecoveryPrepareRequest {
  readonly phase: "prepare";
  readonly operation_id: string;
  readonly parent_operation_id?: string;
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly expected_revision: RecoveryRevision;
  readonly selection?: TrustedRecoverySelection;
  readonly mutation: RecoveryMutation;
}

export interface StageRecoveryAckRequest {
  readonly phase: "ack";
  readonly operation_id: string;
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly expected_revision: RecoveryRevision;
  readonly selection?: TrustedRecoverySelection;
  readonly evidence: RecoveryTransitionEvidence;
  readonly response: RecoveryResponsePayload;
}

export interface StageRecoveryReplayRequest {
  readonly phase: "replay";
  readonly operation_id: string;
  readonly run_id: string;
  readonly authority: RecoveryAuthority;
  readonly selection?: TrustedRecoverySelection;
}

export type StageRecoveryTransitionRequest = StageRecoveryPrepareRequest | StageRecoveryAckRequest | StageRecoveryReplayRequest;

export interface StageRecoveryTransitionSuccess {
  readonly ok: true;
  readonly revision: RecoveryRevision;
  readonly state_proof?: RecoveryStateProof;
  readonly operation: RecoveryOperationRecord;
  readonly remaining_attempts?: number;
  readonly handoff?: TrustedRecoveryHandoff;
}

export interface StageRecoveryTransitionFailure {
  readonly ok: false;
  readonly code: string;
  readonly revision?: RecoveryRevision;
  readonly state_proof?: RecoveryStateProof;
  readonly operation?: RecoveryOperationRecord;
  readonly remaining_attempts?: number;
  readonly handoff?: TrustedRecoveryHandoff;
}

export type StageRecoveryTransitionResult = StageRecoveryTransitionSuccess | StageRecoveryTransitionFailure;

export interface StageRecoveryStore {
  /** Read only the owner’s canonical state and immutable recovery projection. */
  readonly read: (input: {
    readonly run_id: string;
    readonly authority: RecoveryAuthority;
    readonly identity?: WorkIdentity;
    readonly selection?: TrustedRecoverySelection;
  }) => MaybePromise<StageRecoverySnapshot>;
  /** Every mutation, including budget consumption, must be owner-locked and CASed. */
  readonly transition: (input: StageRecoveryTransitionRequest) => MaybePromise<StageRecoveryTransitionResult>;
}

export interface StageRecoveryResult extends RecoveryResponsePayload {
  readonly operation_id: string;
  readonly replayed?: boolean;
  readonly action_operation_id?: string;
  readonly supported_actions?: readonly RecoveryAction[];
}

export interface StageRecoveryExecutionOptions {
  readonly request: StageRecoveryRequest;
  readonly store: StageRecoveryStore;
  readonly host?: StageRecoveryHost;
}

const EMPTY_CAPABILITIES: StageRecoveryCapabilities = Object.freeze({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameRevision(left: RecoveryRevision | undefined, right: RecoveryRevision | undefined): boolean {
  return left !== undefined && right !== undefined && left === right;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalize(entry)]));
  return value;
}

function canonicalJson(value: unknown): string {
  const result = JSON.stringify(canonicalize(value));
  return result === undefined ? "null" : result;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
/** Stable digest passed to the original producer for exact format repair. */
export function recoveryErrorDigest(errors: readonly RecoveryErrorField[]): string {
  return digest(errors);
}


const IDENTITY_KEYS: readonly (keyof WorkIdentity)[] = [
  "run_id",
  "wave_id",
  "slice_id",
  "session_id",
  "workflow",
  "stage_id",
  "stage_cursor",
  "capability_id",
  "capability_epoch",
  "loop_iteration",
  "slot_id",
  "task_id",
  "dispatch_id",
  "attempt",
  "worker_id",
];

function identityMatches(left: WorkIdentity | undefined, right: WorkIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  return IDENTITY_KEYS.every((key) => left[key] === right[key]);
}
function replacementScopeMatches(original: WorkIdentity, replacement: WorkIdentity): boolean {
  return original.run_id === replacement.run_id
    && original.wave_id === replacement.wave_id
    && original.slice_id === replacement.slice_id
    && original.workflow === replacement.workflow
    && original.stage_id === replacement.stage_id
    && original.stage_cursor === replacement.stage_cursor
    && original.capability_id === replacement.capability_id
    && original.capability_epoch === replacement.capability_epoch
    && original.loop_iteration === replacement.loop_iteration
    && original.slot_id === replacement.slot_id
    && original.task_id === replacement.task_id;
}


function stateProofMatches(snapshot: StageRecoverySnapshot): boolean {
  const proof = snapshot.state_proof;
  return proof.authenticated === true
    && proof.run_id === snapshot.run_id
    && proof.authority === snapshot.authority
    && sameRevision(proof.revision, snapshot.revision)
    && (!snapshot.identity || proof.dispatch_id === snapshot.identity.dispatch_id)
    && (!proof.identity || !snapshot.identity || identityMatches(proof.identity, snapshot.identity));
}

function ownershipMatches(request: StageRecoveryRequest, snapshot: StageRecoverySnapshot): boolean {
  const ownership = snapshot.ownership;
  if (!ownership || ownership.authenticated !== true || ownership.run_id !== snapshot.run_id || ownership.authority !== snapshot.authority) return false;
  const selection = request.selection;
  if (!selection) return true;
  if (selection.authenticated !== true || selection.run_id !== request.run_id || selection.authority !== request.authority) return false;
  if (selection.owner_id !== ownership.owner_id || selection.ownership_epoch !== ownership.ownership_epoch) return false;
  if (ownership.binding_id !== undefined && selection.binding_id !== undefined && ownership.binding_id !== selection.binding_id) return false;
  return true;
}

function snapshotError(snapshot: StageRecoverySnapshot): SafeRecoveryErrorContext | undefined {
  const error = snapshot.error_context;
  if (!error) return undefined;
  const fields = error.field_errors?.slice(0, 32).map((entry) => ({
    field: safeText(entry.field, 128),
    message: safeText(entry.message, 256),
  }));
  return {
    class: safeText(error.class, 96),
    code: safeText(error.code, 96),
    message: safeText(error.message, 512),
    ...(fields && fields.length > 0 ? { field_errors: fields } : {}),
  };
}

function safeText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function callbackFailure(action: string): SafeRecoveryErrorContext {
  // Do not copy exception text: provider errors frequently contain credentials,
  // prompts, filesystem paths, or dispatch tokens.
  return {
    class: "host_callback",
    code: "host_callback_failed",
    message: `authoritative ${safeText(action, 64)} callback failed`,
  };
}

function transitionFailure(error: StageRecoveryTransitionFailure): SafeRecoveryErrorContext {
  const code = safeText(error.code, 96).replace(/[^A-Za-z0-9_.:-]/g, "_");
  return { class: "canonical_transition", code, message: "canonical recovery transition was rejected" };
}

function persistedGrantMatches(grant: AuthenticatedRecoveryGrant, snapshot: StageRecoverySnapshot, errorClass: RecoveryErrorClass): boolean {
  const ownership = snapshot.ownership;
  return grant.authenticated === true
    && grant.run_id === snapshot.run_id
    && grant.authority === snapshot.authority
    && grant.error_class === errorClass
    && identityMatches(grant.identity, snapshot.identity)
    && ownership?.authenticated === true
    && grant.owner_id === ownership.owner_id
    && grant.ownership_epoch === ownership.ownership_epoch;
}

function availableAttempts(snapshot: StageRecoverySnapshot, errorClass?: RecoveryErrorClass, request?: StageRecoveryRequest): number {
  if (!errorClass) return 0;
  const budget = (snapshot.budgets ?? []).find((entry) => entry.error_class === errorClass);
  const base = budget ? Math.max(0, Math.floor(budget.limit) - Math.max(0, Math.floor(budget.used))) : 0;
  const grants = (snapshot.grants ?? []).filter((grant) => persistedGrantMatches(grant, snapshot, errorClass));
  const seen = new Set<string>();
  let persisted = 0;
  for (const grant of grants) {
    if (seen.has(grant.grant_id)) continue;
    seen.add(grant.grant_id);
    persisted += Math.max(0, Math.floor(grant.limit) - Math.max(0, Math.floor(grant.used)));
  }
  const supplied = request && grantMatches(request, snapshot, errorClass) && request.grant && !seen.has(request.grant.grant_id)
    ? Math.max(0, Math.floor(request.grant.limit) - Math.max(0, Math.floor(request.grant.used)))
    : 0;
  return base + persisted + supplied;
}

function grantMatches(request: StageRecoveryRequest, snapshot: StageRecoverySnapshot, errorClass: RecoveryErrorClass): boolean {
  const grant = request.grant;
  if (!grant) return false;
  if (grant.authenticated !== true || grant.run_id !== request.run_id || grant.authority !== request.authority || grant.error_class !== errorClass) return false;
  if (!nonEmpty(grant.grant_id) || !nonEmpty(grant.owner_id) || !nonEmpty(grant.ownership_epoch) || !nonEmpty(grant.proof) || grant.limit < 1 || grant.used < 0 || grant.used >= grant.limit) return false;
  if (!identityMatches(grant.identity, snapshot.identity)) return false;
  const ownership = snapshot.ownership;
  if (!ownership || ownership.authenticated !== true || grant.owner_id !== ownership.owner_id || grant.ownership_epoch !== ownership.ownership_epoch) return false;
  return true;
}

function budgetAvailable(snapshot: StageRecoverySnapshot, request: StageRecoveryRequest, errorClass: RecoveryErrorClass): boolean {
  return availableAttempts(snapshot, errorClass) > 0 || grantMatches(request, snapshot, errorClass);
}

function supported(capabilities: StageRecoveryCapabilities, capability: RecoveryCapability, callback: unknown): boolean {
  return capabilities[capability] === "supported" && typeof callback === "function";
}
function observationSupported(host: StageRecoveryHost | undefined): boolean {
  if (!host) return false;
  return supported(host.capabilities, "observe", host.observe) || supported(host.capabilities, "inspect", host.inspect);
}


function supportedActions(snapshot: StageRecoverySnapshot, host: StageRecoveryHost | undefined): readonly RecoveryAction[] {
  const capabilities = host?.capabilities ?? EMPTY_CAPABILITIES;
  const actions: RecoveryAction[] = [];
  if (snapshot.lifecycle === "running") actions.push("observe");
  if (snapshot.lifecycle === "disconnected" && supported(capabilities, "reconnect", host?.reconnect)) actions.push("reconnect");
  if (snapshot.lifecycle === "terminal" && snapshot.terminal?.outcome === "failed" && supported(capabilities, "resume", host?.resume)) actions.push("resume");
  if (supported(capabilities, "clarify", host?.clarify)) actions.push("clarify");
  if (supported(capabilities, "cancel_ack", host?.cancelAck)) actions.push("cancel_ack");
  if (supported(capabilities, "format_repair", host?.formatRepair)) actions.push("repair_format");
  if (supported(capabilities, "replacement_dispatch", host?.dispatchReplacement)) actions.push("replace");
  return actions;
}

function result(
  request: StageRecoveryRequest,
  snapshot: StageRecoverySnapshot,
  values: Omit<RecoveryResponsePayload, "attempts_remaining" | "state_revision" | "state_proof"> & { error_class?: RecoveryErrorClass },
): StageRecoveryResult {
  const attempts = values.error_class ? availableAttempts(snapshot, values.error_class, request) : 0;
  const { error_class: _errorClass, ...payload } = values;
  return {
    ...payload,
    attempts_remaining: attempts,
    state_revision: snapshot.revision,
    state_proof: snapshot.state_proof,
    operation_id: request.operation_id,
    supported_actions: supportedActions(snapshot, undefined),
  };
}

function resultWithHost(
  request: StageRecoveryRequest,
  snapshot: StageRecoverySnapshot,
  host: StageRecoveryHost | undefined,
  values: Omit<RecoveryResponsePayload, "attempts_remaining" | "state_revision" | "state_proof"> & { error_class?: RecoveryErrorClass },
): StageRecoveryResult {
  const base = result(request, snapshot, values);
  return { ...base, supported_actions: supportedActions(snapshot, host) };
}

function invalidRequestResult(request: StageRecoveryRequest, code: string, condition: string): StageRecoveryResult {
  return {
    code,
    worker: "unsupported",
    action: "clarify",
    attempts_remaining: 0,
    operation_id: request.operation_id,
    blocking_condition: condition,
    next_action: "provide the exact authenticated recovery request and canonical owner selection",
  };
}

function replayPayload(request: StageRecoveryRequest, operation: RecoveryOperationRecord, snapshot?: StageRecoverySnapshot): StageRecoveryResult | undefined {
  if (operation.status !== "acked" || !operation.response) return undefined;
  const attempts = operation.error_class && snapshot
    ? availableAttempts(snapshot, operation.error_class, request)
    : operation.response.attempts_remaining;
  return { ...operation.response, attempts_remaining: attempts, operation_id: request.operation_id, replayed: true };
}

function operationFor(snapshot: StageRecoverySnapshot, operationId: string, retryOf?: string): RecoveryOperationRecord | undefined {
  const operations = snapshot.operations ?? [];
  const direct = operations.filter((entry) => entry.operation_id === operationId || entry.parent_operation_id === operationId);
  if (direct.length > 0) {
    const prepared = direct.find((entry) => entry.status === "prepared");
    if (prepared) return prepared;
    const linkedChild = direct.find((entry) => entry.parent_operation_id === operationId && (entry.action === "replace" || entry.action === "retry"));
    return linkedChild ?? direct[0];
  }
  if (!retryOf) return undefined;
  const linked = operations.filter((entry) => entry.run_id === snapshot.run_id
    && entry.authority === snapshot.authority
    && entry.retry_of === retryOf
    && (entry.action === "replace" || entry.action === "retry"));
  return linked.find((entry) => entry.status === "prepared") ?? linked[0];
}
function operationIntentMatches(operation: RecoveryOperationRecord, request: StageRecoveryRequest): boolean {
  if (!request.intent) return true;
  if (request.intent === "observe") return operation.action === "observe";
  if (request.intent === "reconnect") return operation.action === "reconnect";
  if (request.intent === "resume") return operation.action === "resume";
  if (request.intent === "clarify") return operation.action === "clarify";
  if (request.intent === "cancel" || request.intent === "cancel_ack") return operation.action === "cancel_ack";
  if (request.intent === "refresh_handoff") return operation.action === "refresh_handoff";
  if (request.intent === "repair_format") return operation.action === "repair_format" || (operation.action === "replace" && operation.producer_correction === true);
  if (request.intent === "replace" || request.intent === "retry") return operation.action === "replace" || operation.action === "retry";
  return false;
}
function preparedOperationMatches(expected: RecoveryOperationRecord, actual: RecoveryOperationRecord | undefined): boolean {
  return actual?.status === "prepared"
    && actual.operation_id === expected.operation_id
    && actual.run_id === expected.run_id
    && actual.authority === expected.authority
    && actual.action === expected.action
    && actual.dispatch_id === expected.dispatch_id
    && actual.retry_of === expected.retry_of
    && actual.error_class === expected.error_class
    && actual.producer_correction === expected.producer_correction
    && (!expected.replacement_identity || (actual.replacement_identity !== undefined && identityMatches(actual.replacement_identity, expected.replacement_identity)));
}
function producerBindingId(snapshot: StageRecoverySnapshot): string | undefined {
  return snapshot.binding_id ?? snapshot.ownership?.binding_id;
}


function operationIdFor(request: StageRecoveryRequest, suffix: string): string {
  return `${request.operation_id}:${suffix}`;
}

function hostEvidenceMatches(
  evidence: RecoveryHostEvidence,
  request: StageRecoveryRequest,
  snapshot: StageRecoverySnapshot,
  action: RecoveryAction,
): boolean {
  const rawProof = (evidence as unknown as Record<string, unknown>).proof;
  if (!isRecord(rawProof)) return false;
  if (evidence.authoritative !== true || evidence.run_id !== request.run_id || !nonEmpty(evidence.dispatch_id) || evidence.dispatch_id !== snapshot.identity?.dispatch_id || !identityMatches(evidence.identity, snapshot.identity)) return false;
  if (rawProof.authenticated !== true || rawProof.binding_id !== producerBindingId(snapshot) || !nonEmpty(rawProof.event_id) || !nonEmpty(rawProof.source)) return false;
  if (!("operation" in evidence)) return false;
  const expectedOperation: RecoveryCapability | undefined = action === "observe" ? "observe" : action === "preflight" ? "preflight_not_started" : action === "reconnect" ? "reconnect" : action === "resume" ? "resume" : action === "clarify" ? "clarify" : action === "cancel_ack" ? "cancel_ack" : action === "repair_format" ? "format_repair" : undefined;
  if (expectedOperation && evidence.operation !== expectedOperation) return false;
  if (evidence.kind === "running") return evidence.same_worker === true;
  if (evidence.kind === "disconnected") return evidence.transport === "unavailable";
  if (evidence.kind === "unknown") return nonEmpty(evidence.reason);
  if (evidence.kind === "terminal") return nonEmpty(evidence.terminal_event_id) && nonEmpty(evidence.observed_at);
  if (evidence.kind === "resume") return nonEmpty(evidence.observed_at) && (evidence.result !== "terminal" || nonEmpty(evidence.terminal_event_id));
  if (evidence.kind === "clarified") return nonEmpty(evidence.observed_at) && (evidence.result !== "terminal" || nonEmpty(evidence.terminal_event_id));
  if (evidence.kind === "cancel_ack") return evidence.acknowledged === true && evidence.executor_stopped === true && nonEmpty(evidence.observed_at);
  if (evidence.kind === "format_repair") return evidence.same_producer === true && nonEmpty(evidence.errors_digest) && nonEmpty(evidence.observed_at);
  if (evidence.kind === "replacement_dispatched") return nonEmpty(evidence.original_dispatch_id) && nonEmpty(evidence.observed_at) && nonEmpty(evidence.new_identity.dispatch_id);
  return false;
}
function preflightEvidenceMatches(
  evidence: RecoveryPreflightNotStartedProof,
  request: StageRecoveryRequest,
  snapshot: StageRecoverySnapshot,
): boolean {
  const rawProof = (evidence as unknown as Record<string, unknown>).proof;
  if (!isRecord(rawProof)) return false;
  return evidence.authoritative === true
    && evidence.kind === "preflight_not_started"
    && evidence.never_started === true
    && evidence.run_id === request.run_id
    && nonEmpty(evidence.dispatch_id)
    && evidence.dispatch_id === snapshot.identity?.dispatch_id
    && rawProof.authenticated === true
    && rawProof.binding_id === producerBindingId(snapshot)
    && nonEmpty(rawProof.event_id)
    && nonEmpty(rawProof.source)
    && nonEmpty(evidence.reason)
    && nonEmpty(evidence.observed_at);
}


function transitionPayload(
  request: StageRecoveryRequest,
  snapshot: StageRecoverySnapshot,
  action: RecoveryAction,
  evidence: RecoveryHostEvidence,
  errorClass?: RecoveryErrorClass,
): RecoveryResponsePayload {
  if (evidence.kind === "running") {
    return { code: action === "resume" ? "worker_resumed" : action === "reconnect" ? "worker_reconnected" : "worker_running", worker: "running", action: action === "resume" || action === "reconnect" ? action : "observe", attempts_remaining: availableAttempts(snapshot, errorClass, request), evidence, state_revision: snapshot.revision, state_proof: snapshot.state_proof };
  }
  if (evidence.kind === "disconnected") return { code: "worker_disconnected", worker: "disconnected", action: "wait", attempts_remaining: availableAttempts(snapshot, errorClass, request), evidence, blocking_condition: "the authoritative host reports transport loss without executor-stop proof", next_action: "reconnect the same worker or wait for a terminal lifecycle event", state_revision: snapshot.revision, state_proof: snapshot.state_proof };
  if (evidence.kind === "terminal") return { code: evidence.outcome === "succeeded" ? "worker_succeeded" : "worker_terminal", worker: "terminal", action: "none", attempts_remaining: availableAttempts(snapshot, errorClass, request), retry_of: evidence.dispatch_id, evidence, state_revision: snapshot.revision, state_proof: snapshot.state_proof };
  if (evidence.kind === "preflight_not_started") return { code: "preflight_not_started", worker: "not_started", action: "wait", attempts_remaining: availableAttempts(snapshot, errorClass, request), retry_of: evidence.dispatch_id, evidence, blocking_condition: "the host supplied an authenticated preflight proof that execution never started", next_action: "prepare one corrected linked dispatch", state_revision: snapshot.revision, state_proof: snapshot.state_proof };
  if (evidence.kind === "resume") return { code: evidence.result === "running" ? "worker_resumed" : evidence.result === "terminal" ? "resume_terminal" : "resume_unknown", worker: evidence.result === "running" ? "running" : evidence.result === "terminal" ? "terminal" : "unknown", action: evidence.result === "running" ? "resume" : "wait", attempts_remaining: availableAttempts(snapshot, errorClass, request), evidence, blocking_condition: evidence.result === "unknown" ? "resume returned no authoritative lifecycle result" : undefined, next_action: evidence.result === "unknown" ? "wait for the same worker terminal event" : undefined, state_revision: snapshot.revision, state_proof: snapshot.state_proof };
  if (evidence.kind === "clarified") return { code: `clarified_${evidence.result}`, worker: evidence.result === "running" ? "running" : evidence.result === "disconnected" ? "disconnected" : evidence.result === "terminal" ? "terminal" : "unknown", action: evidence.result === "running" ? "observe" : "wait", attempts_remaining: availableAttempts(snapshot, errorClass, request), evidence, state_revision: snapshot.revision, state_proof: snapshot.state_proof };
  if (evidence.kind === "cancel_ack") return { code: "cancel_acknowledged", worker: "terminal", action: "cancel_ack", attempts_remaining: availableAttempts(snapshot, errorClass, request), evidence, blocking_condition: "replacement requires a new operation after this cancellation acknowledgement", next_action: "read canonical state and request a linked replacement only after terminal cancellation proof", state_revision: snapshot.revision, state_proof: snapshot.state_proof };
  if (evidence.kind === "format_repair") return { code: evidence.accepted ? "format_repair_accepted" : "format_repair_rejected", worker: evidence.accepted ? "running" : "terminal", action: "repair_format", attempts_remaining: availableAttempts(snapshot, errorClass, request), evidence, ...(evidence.accepted ? {} : { blocking_condition: "the original producer did not accept the exact validation errors" }), state_revision: snapshot.revision, state_proof: snapshot.state_proof };
  return { code: "worker_outcome_unknown", worker: "unknown", action: "wait", attempts_remaining: availableAttempts(snapshot, errorClass, request), evidence, blocking_condition: "the authoritative host did not establish a lifecycle state", next_action: "wait or request clarification; do not replace the worker", state_revision: snapshot.revision, state_proof: snapshot.state_proof };
}

function replacementPayload(
  request: StageRecoveryRequest,
  snapshot: StageRecoverySnapshot,
  evidence: RecoveryReplacementEvidence,
  errorClass: RecoveryErrorClass,
): RecoveryResponsePayload {
  return {
    code: "replacement_dispatched",
    worker: evidence.new_state === "running" ? "running" : "unknown",
    action: "replace",
    attempts_remaining: availableAttempts(snapshot, errorClass, request),
    retry_of: evidence.original_dispatch_id,
    evidence,
    next_action: evidence.new_state === "running" ? "observe the linked replacement" : "wait for the linked replacement lifecycle",
    state_revision: snapshot.revision,
    state_proof: snapshot.state_proof,
  };
}

function validateSnapshot(request: StageRecoveryRequest, snapshot: StageRecoverySnapshot): string | undefined {
  if (snapshot.run_id !== request.run_id || snapshot.authority !== request.authority) return "canonical snapshot does not belong to the requested run and authority";
  if (!stateProofMatches(snapshot)) return "canonical state proof is missing, unauthenticated, or stale";
  if (request.expected_revision !== undefined && !sameRevision(request.expected_revision, snapshot.revision)) return "the caller supplied a stale canonical revision";
  if (!ownershipMatches(request, snapshot)) return "trusted recovery ownership or selection does not match canonical state";
  if (request.identity && !identityMatches(request.identity, snapshot.identity)) return "worker identity does not match canonical state";
  if (snapshot.identity && snapshot.producer && !identityMatches(snapshot.identity, snapshot.producer.identity)) return "producer binding identity does not match canonical state";
  if (snapshot.terminal && (!identityMatches(snapshot.terminal.identity, snapshot.identity) || snapshot.terminal.dispatch_id !== snapshot.identity?.dispatch_id || snapshot.terminal.run_id !== request.run_id || !nonEmpty(snapshot.terminal.terminal_event_id) || !nonEmpty(snapshot.terminal.observed_at))) return "terminal proof does not match canonical worker identity";
  if (snapshot.preflight && (!identityMatches(snapshot.preflight.identity, snapshot.identity) || snapshot.preflight.dispatch_id !== snapshot.identity?.dispatch_id || snapshot.preflight.run_id !== request.run_id || snapshot.preflight.never_started !== true || !nonEmpty(snapshot.preflight.reason) || !nonEmpty(snapshot.preflight.observed_at))) return "preflight proof does not match canonical worker identity";
  return undefined;
}

function terminalProof(snapshot: StageRecoverySnapshot): RecoveryTerminalProof | undefined {
  if (!snapshot.terminal || snapshot.terminal.authoritative !== true) return undefined;
  if (snapshot.terminal.outcome === "succeeded") return undefined;
  return snapshot.terminal;
}

function canonicalPreflight(snapshot: StageRecoverySnapshot): RecoveryPreflightNotStartedProof | undefined {
  if (!snapshot.preflight || snapshot.preflight.authoritative !== true || snapshot.preflight.never_started !== true) return undefined;
  return snapshot.preflight;
}

function errorClassFor(snapshot: StageRecoverySnapshot, proof?: RecoveryTerminalProof | RecoveryPreflightNotStartedProof): RecoveryErrorClass {
  if (proof && "kind" in proof && proof.kind === "preflight_not_started") return "preflight_not_started";
  if (proof && "outcome" in proof && proof.outcome === "cancelled") return "cancelled";
  if (snapshot.error_context?.class === "format_validation") return "format_validation";
  return "terminal_failure";
}

function mutationResponse(
  request: StageRecoveryRequest,
  snapshot: StageRecoverySnapshot,
  action: RecoveryAction,
  errorClass?: RecoveryErrorClass,
  extra: Partial<RecoveryResponsePayload> = {},
): RecoveryResponsePayload {
  return {
    code: extra.code ?? "recovery_prepared",
    worker: extra.worker ?? (snapshot.lifecycle === "terminal" ? "terminal" : snapshot.lifecycle === "not_started" ? "not_started" : "unknown"),
    action,
    attempts_remaining: errorClass ? availableAttempts(snapshot, errorClass, request) : 0,
    state_revision: snapshot.revision,
    state_proof: snapshot.state_proof,
    ...(errorClass ? { error_context: snapshotError(snapshot) } : {}),
    ...extra,
  };
}

async function transition(
  store: StageRecoveryStore,
  input: StageRecoveryTransitionRequest,
): Promise<StageRecoveryTransitionResult> {
  try {
    return await store.transition(input);
  } catch {
    return { ok: false, code: "transition_exception" };
  }
}

async function acknowledge(
  store: StageRecoveryStore,
  request: StageRecoveryRequest,
  snapshot: StageRecoverySnapshot,
  operationId: string,
  revision: RecoveryRevision,
  evidence: RecoveryTransitionEvidence,
  response: RecoveryResponsePayload,
): Promise<StageRecoveryResult> {
  const acknowledged = await transition(store, {
    phase: "ack",
    operation_id: operationId,
    run_id: request.run_id,
    authority: request.authority,
    expected_revision: revision,
    ...(request.selection ? { selection: request.selection } : {}),
    evidence,
    response,
  });
  if (!acknowledged.ok) {
    return {
      code: "recovery_ack_rejected",
      worker: "unknown",
      action: "wait",
      attempts_remaining: acknowledged.remaining_attempts ?? response.attempts_remaining,
      operation_id: request.operation_id,
      ...(response.retry_of ? { retry_of: response.retry_of } : {}),
      ...(response.evidence ? { evidence: response.evidence } : {}),
      ...(acknowledged.state_proof ? { state_proof: acknowledged.state_proof } : response.state_proof ? { state_proof: response.state_proof } : {}),
      ...(acknowledged.revision !== undefined ? { state_revision: acknowledged.revision } : response.state_revision !== undefined ? { state_revision: response.state_revision } : {}),
      error_context: transitionFailure(acknowledged),
      blocking_condition: "the canonical owner rejected the recovery acknowledgement; external evidence is not a committed recovery result",
      next_action: acknowledged.code === "stale_revision" ? "reread canonical recovery state and replay the same operation id" : "preserve the operation id and ask the canonical owner to reconcile the prepared operation",
      supported_actions: [],
    };
  }
  return {
    ...response,
    operation_id: request.operation_id,
    attempts_remaining: acknowledged.remaining_attempts ?? response.attempts_remaining,
    state_revision: acknowledged.revision,
    ...(acknowledged.state_proof ? { state_proof: acknowledged.state_proof } : response.state_proof ? { state_proof: { ...response.state_proof, revision: acknowledged.revision } } : {}),
    ...(acknowledged.handoff ? { handoff: acknowledged.handoff } : {}),
  };
}

async function prepare(
  store: StageRecoveryStore,
  request: StageRecoveryRequest,
  snapshot: StageRecoverySnapshot,
  operationId: string,
  mutation: RecoveryMutation,
): Promise<{ ok: true; revision: RecoveryRevision; operation: RecoveryOperationRecord; remaining_attempts?: number } | { ok: false; result: StageRecoveryResult }> {
  const parentOperation = operationId !== request.operation_id && (snapshot.operations ?? []).some((entry) => entry.operation_id === request.operation_id);
  const prepared = await transition(store, {
    phase: "prepare",
    operation_id: operationId,
    ...(parentOperation ? { parent_operation_id: request.operation_id } : {}),
    run_id: request.run_id,
    authority: request.authority,
    expected_revision: snapshot.revision,
    ...(request.selection ? { selection: request.selection } : {}),
    mutation,
  });
  if (!prepared.ok) {
    const error = transitionFailure(prepared);
    const blocking = prepared.code === "stale_revision" ? "canonical state changed before recovery could be prepared" : prepared.code === "operation_conflict" ? "another recovery operation already owns this dispatch" : prepared.code === "recovery_budget_exhausted" ? "the persisted error-class recovery budget is exhausted" : "the canonical owner rejected recovery preparation";
    const next = prepared.code === "stale_revision" ? "reread canonical state and replay the same operation id" : prepared.code === "recovery_budget_exhausted" ? "present a new authenticated bounded grant" : "wait for the canonical owner to reconcile the existing operation";
    return {
      ok: false,
      result: resultWithHost(request, snapshot, undefined, {
        code: prepared.code === "recovery_budget_exhausted" ? "recovery_budget_exhausted" : prepared.code === "operation_conflict" ? "recovery_operation_conflict" : "recovery_prepare_rejected",
        worker: snapshot.lifecycle === "terminal" ? "terminal" : snapshot.lifecycle === "not_started" ? "not_started" : "unknown",
        action: "wait",
        retry_of: mutation.kind === "replacement" ? mutation.retry_of : undefined,
        blocking_condition: blocking,
        next_action: next,
        error_context: error,
        error_class: mutation.kind === "replacement" ? mutation.error_class : undefined,
      }),
    };
  }
  return { ok: true, revision: prepared.revision, operation: prepared.operation, remaining_attempts: prepared.remaining_attempts };
}

async function executeHostAction(
  options: StageRecoveryExecutionOptions,
  snapshot: StageRecoverySnapshot,
  identity: WorkIdentity,
  operationId: string,
  action: RecoveryAction,
  mutation: RecoveryMutation,
  errorClass?: RecoveryErrorClass,
): Promise<StageRecoveryResult> {
  const { request, store, host } = options;
  const capabilities = host?.capabilities ?? EMPTY_CAPABILITIES;
  const inspectObservation = action === "observe" && !supported(capabilities, "observe", host?.observe) && supported(capabilities, "inspect", host?.inspect);
  const callback = action === "preflight" ? host?.preflightNotStarted
    : action === "observe" ? inspectObservation ? host?.inspect : host?.observe
      : action === "reconnect" ? host?.reconnect
        : action === "resume" ? host?.resume
          : action === "clarify" ? host?.clarify
            : action === "cancel_ack" ? host?.cancelAck
              : action === "repair_format" ? host?.formatRepair
                : action === "replace" || action === "retry" ? host?.dispatchReplacement
                  : undefined;
  const capability: RecoveryCapability | undefined = action === "preflight" ? "preflight_not_started"
    : action === "observe" ? inspectObservation ? "inspect" : "observe"
      : action === "reconnect" ? "reconnect"
        : action === "resume" ? "resume"
          : action === "clarify" ? "clarify"
            : action === "cancel_ack" ? "cancel_ack"
              : action === "repair_format" ? "format_repair"
                : action === "replace" || action === "retry" ? "replacement_dispatch"
                  : undefined;
  if (!capability || !supported(capabilities, capability, callback)) {
    return resultWithHost(request, snapshot, host, {
      code: `${action}_unsupported`,
      worker: snapshot.lifecycle === "terminal" ? "terminal" : snapshot.lifecycle === "not_started" ? "not_started" : "unknown",
      action: "wait",
      retry_of: mutation.kind === "replacement" ? mutation.retry_of : undefined,
      error_class: errorClass,
      blocking_condition: `authoritative host capability ${capability ?? action} is unsupported or not injected`,
      next_action: action === "replace" || action === "retry" ? "do not create another writer; wait for a truthful replacement dispatch boundary" : "wait for a host that declares and implements this operation",
    });
  }
  const prepared = await prepare(store, request, snapshot, operationId, mutation);
  if (!prepared.ok) return prepared.result;
  const input: RecoveryHostInput & { retry_of?: string; error_class?: RecoveryErrorClass; producer_correction?: boolean } = {
    request,
    operation_id: operationId,
    snapshot,
    identity,
    state_proof: snapshot.state_proof,
    prepared_operation: prepared.operation,
    ...(prepared.operation.replacement_identity ? { replacement_identity: prepared.operation.replacement_identity } : {}),
    ...(snapshot.error_context ? { error_context: snapshot.error_context } : {}),
    ...(snapshot.error_context?.field_errors ? { exact_format_errors: snapshot.error_context.field_errors } : {}),
    ...(snapshot.terminal ? { terminal: snapshot.terminal } : {}),
    ...(snapshot.preflight ? { preflight: snapshot.preflight } : {}),
    ...(mutation.kind === "replacement" ? { retry_of: mutation.retry_of, error_class: mutation.error_class, producer_correction: mutation.producer_correction } : {}),
  };
  let evidence: RecoveryHostEvidence;
  try {
    if (action === "preflight") {
      evidence = await (callback as NonNullable<StageRecoveryHost["preflightNotStarted"]>)(input);
    } else if (action === "replace" || action === "retry") {
      evidence = await (callback as NonNullable<StageRecoveryHost["dispatchReplacement"]>)({ ...input, retry_of: mutation.kind === "replacement" ? mutation.retry_of : identity.dispatch_id, error_class: mutation.kind === "replacement" ? mutation.error_class : "terminal_failure", producer_correction: mutation.kind === "replacement" ? mutation.producer_correction : false });
    } else if (action === "repair_format") {
      evidence = await (callback as NonNullable<StageRecoveryHost["formatRepair"]>)(input);
    } else if (action === "cancel_ack") {
      evidence = await (callback as NonNullable<StageRecoveryHost["cancelAck"]>)(input);
    } else if (action === "resume") {
      evidence = await (callback as NonNullable<StageRecoveryHost["resume"]>)(input);
    } else if (action === "reconnect") {
      evidence = await (callback as NonNullable<StageRecoveryHost["reconnect"]>)(input);
    } else if (action === "clarify") {
      evidence = await (callback as NonNullable<StageRecoveryHost["clarify"]>)(input);
    } else {
      evidence = await (callback as NonNullable<StageRecoveryHost["observe"]>)(input);
    }
  } catch {
    return {
      ...mutationResponse(request, snapshot, action, errorClass, {
        code: "host_callback_failed",
        worker: snapshot.lifecycle === "terminal" ? "terminal" : snapshot.lifecycle === "not_started" ? "not_started" : "unknown",
        action: "wait",
        retry_of: mutation.kind === "replacement" ? mutation.retry_of : undefined,
        blocking_condition: "authoritative host operation failed; the prepared operation remains replayable",
        next_action: "replay the same operation id; never create a second writer",
        error_context: callbackFailure(action),
      }),
      operation_id: request.operation_id,
      action_operation_id: operationId,
    };
  }
  const candidateEvidence = evidence as RecoveryHostEvidence;
  const evidenceValid = isRecord(evidence) && (action === "preflight" && candidateEvidence.kind === "preflight_not_started"
    ? preflightEvidenceMatches(candidateEvidence, request, snapshot)
    : hostEvidenceMatches(candidateEvidence, request, snapshot, action));
  if (!evidenceValid) {
    return {
      ...mutationResponse(request, snapshot, action, errorClass, {
        code: "invalid_host_evidence",
        worker: snapshot.lifecycle === "terminal" ? "terminal" : snapshot.lifecycle === "not_started" ? "not_started" : "unknown",
        action: "wait",
        retry_of: mutation.kind === "replacement" ? mutation.retry_of : undefined,
        blocking_condition: "host evidence was not authenticated to the exact run, binding, dispatch, and operation",
        next_action: "preserve the prepared operation and obtain a truthful host receipt",
        error_context: { class: "host_evidence", code: "invalid_host_evidence", message: "authoritative host evidence failed identity validation" },
      }),
      operation_id: request.operation_id,
      action_operation_id: operationId,
    };
  }
  const typedEvidence = evidence as RecoveryHostEvidence;
  if (typedEvidence.kind === "format_repair" && (typedEvidence.same_producer !== true || typedEvidence.errors_digest !== digest(snapshot.error_context?.field_errors ?? []))) {
    return {
      ...mutationResponse(request, snapshot, action, errorClass, {
        code: "invalid_format_repair_evidence",
        worker: snapshot.lifecycle === "terminal" ? "terminal" : "unknown",
        action: "wait",
        blocking_condition: "format repair was not tied to the exact canonical producer errors",
        next_action: "send the unchanged canonical field errors to the original producer",
        error_context: { class: "host_evidence", code: "invalid_format_repair_evidence", message: "format repair evidence did not bind exact producer errors" },
      }),
      operation_id: request.operation_id,
      action_operation_id: operationId,
    };
  }
  if (typedEvidence.kind === "replacement_dispatched") {
    const expectedOriginal = mutation.kind === "replacement" ? mutation.retry_of : identity.dispatch_id;
    const expectedReplacement = prepared.operation.replacement_identity;
    const correctionDigestValid = mutation.kind !== "replacement" || !mutation.producer_correction || typedEvidence.errors_digest === mutation.exact_error_digest;
    if (!expectedReplacement || typedEvidence.original_dispatch_id !== expectedOriginal || typedEvidence.new_identity.run_id !== request.run_id || typedEvidence.new_identity.dispatch_id === identity.dispatch_id || !identityMatches(typedEvidence.new_identity, expectedReplacement) || !replacementScopeMatches(identity, typedEvidence.new_identity) || !correctionDigestValid) {
      return {
        ...mutationResponse(request, snapshot, action, errorClass, {
          code: "invalid_replacement_evidence",
          worker: "unknown",
          action: "wait",
          retry_of: mutation.kind === "replacement" ? mutation.retry_of : identity.dispatch_id,
          blocking_condition: "replacement evidence did not prove a distinct linked assignment",
          next_action: "preserve the prepared operation and reconcile the canonical dispatch ledger",
          error_context: { class: "host_evidence", code: "invalid_replacement_evidence", message: "replacement evidence failed linkage validation" },
        }),
        operation_id: request.operation_id,
        action_operation_id: operationId,
      };
    }
  }
  let acknowledgementSnapshot = snapshot;
  try {
    const reread = await store.read({
      run_id: request.run_id,
      authority: request.authority,
      ...(identity ? { identity } : {}),
      ...(request.selection ? { selection: request.selection } : {}),
    });
    const rereadRequest: StageRecoveryRequest = { ...request, expected_revision: undefined };
    const rereadInvalid = validateSnapshot(rereadRequest, reread);
    const currentOperation = (reread.operations ?? []).find((entry) => entry.operation_id === operationId);
    const producerStillBound = mutation.kind !== "format_repair"
      || (reread.producer !== undefined && identityMatches(reread.producer.identity, identity));
    if (rereadInvalid || reread.identity === undefined || !identityMatches(reread.identity, identity) || producerBindingId(reread) !== producerBindingId(snapshot) || !preparedOperationMatches(prepared.operation, currentOperation) || !producerStillBound) throw new Error("recovery acknowledgement witness changed");
    acknowledgementSnapshot = reread;
  } catch {
    const reconciliation = mutationResponse(request, snapshot, action, errorClass, {
      code: "recovery_ack_reconciliation_required",
      worker: "unknown",
      action: "wait",
      retry_of: mutation.kind === "replacement" ? mutation.retry_of : identity.dispatch_id,
      evidence: typedEvidence,
      blocking_condition: "the host produced an external receipt but the canonical prepared operation or producer witness changed before acknowledgement",
      next_action: "reread canonical state and replay the same operation id; do not dispatch or submit again",
    });
    return { ...reconciliation, operation_id: request.operation_id, action_operation_id: operationId };
  }
  const response = typedEvidence.kind === "replacement_dispatched"
    ? replacementPayload(request, acknowledgementSnapshot, typedEvidence, errorClass ?? "terminal_failure")
    : transitionPayload(request, acknowledgementSnapshot, action, typedEvidence, errorClass);
  const acknowledged = await acknowledge(store, request, acknowledgementSnapshot, operationId, acknowledgementSnapshot.revision, typedEvidence, response);
  return { ...acknowledged, action_operation_id: operationId === request.operation_id ? undefined : operationId };
}

async function replayPrepared(
  options: StageRecoveryExecutionOptions,
  snapshot: StageRecoverySnapshot,
  operation: RecoveryOperationRecord,
): Promise<StageRecoveryResult | undefined> {
  const { request, store, host } = options;
  const replay = await transition(store, {
    phase: "replay",
    operation_id: operation.operation_id,
    run_id: request.run_id,
    authority: request.authority,
    ...(request.selection ? { selection: request.selection } : {}),
  });
  if (!replay.ok) {
    return resultWithHost(request, snapshot, host, {
      code: "recovery_replay_rejected",
      worker: snapshot.lifecycle === "terminal" ? "terminal" : snapshot.lifecycle === "not_started" ? "not_started" : "unknown",
      action: "wait",
      retry_of: operation.retry_of,
      blocking_condition: "the canonical owner did not accept the durable operation replay",
      next_action: "reread canonical state and preserve the same operation id",
      error_context: transitionFailure(replay),
      error_class: operation.error_class,
    });
  }
  const durableOperation = replay.operation;
  const prior = replayPayload(request, durableOperation, snapshot);
  if (prior) return { ...prior, supported_actions: supportedActions(snapshot, host) };
  if (durableOperation.status !== "prepared") return undefined;
  const identity = snapshot.identity;
  if (!identity) return resultWithHost(request, snapshot, host, { code: "recovery_identity_unavailable", worker: "unknown", action: "wait", retry_of: durableOperation.retry_of, blocking_condition: "prepared recovery operation has no canonical worker identity", next_action: "reread canonical state" });
  const action = durableOperation.action;
  if (action === "refresh_handoff") return undefined;
  if ((action === "replace" || action === "retry") && !supported(host?.capabilities ?? EMPTY_CAPABILITIES, "operation_replay", host?.lookupOperation)) {
    return resultWithHost(request, snapshot, host, { code: "recovery_replay_requires_lookup", worker: "unknown", action: "wait", retry_of: durableOperation.retry_of, blocking_condition: "a prepared external dispatch has no truthful operation-id lookup boundary", next_action: "reconcile the prepared operation through the same host operation id; do not dispatch again" });
  }
  if (action === "replace" || action === "retry") {
    let lookup: RecoveryOperationLookupEvidence;
    try {
      lookup = await host!.lookupOperation!({ request, operation_id: durableOperation.operation_id, snapshot, identity, state_proof: snapshot.state_proof, prepared_operation: durableOperation, ...(durableOperation.replacement_identity ? { replacement_identity: durableOperation.replacement_identity } : {}) });
    } catch {
      return resultWithHost(request, snapshot, host, { code: "recovery_replay_lookup_failed", worker: "unknown", action: "wait", retry_of: durableOperation.retry_of, blocking_condition: "prepared replacement lookup failed without proof", next_action: "retry the same operation id; do not create another writer" });
    }
    const lookupValid = lookup.authoritative === true
      && lookup.kind === "operation_lookup"
      && lookup.operation_id === durableOperation.operation_id
      && lookup.run_id === request.run_id
      && lookup.dispatch_id === identity.dispatch_id
      && identityMatches(lookup.identity, identity)
      && lookup.proof.authenticated === true
      && lookup.proof.binding_id === producerBindingId(snapshot)
      && nonEmpty(lookup.proof.event_id);
    if (!lookupValid) return resultWithHost(request, snapshot, host, { code: "invalid_recovery_replay_lookup", worker: "unknown", action: "wait", retry_of: durableOperation.retry_of, blocking_condition: "host replay lookup was not authenticated to this operation and assignment", next_action: "preserve the prepared operation" });
    if (lookup.state === "dispatched" && lookup.evidence && hostEvidenceMatches(lookup.evidence, request, snapshot, "replace")) {
      const response = replacementPayload(request, snapshot, lookup.evidence, durableOperation.error_class ?? "terminal_failure");
      return acknowledge(store, request, snapshot, durableOperation.operation_id, replay.revision, lookup.evidence, response);
    }
    if (lookup.state !== "not_dispatched") return resultWithHost(request, snapshot, host, { code: "invalid_recovery_replay_lookup", worker: "unknown", action: "wait", retry_of: durableOperation.retry_of, blocking_condition: "host replay lookup did not prove either an existing dispatch or a safe not-dispatched state", next_action: "preserve the prepared operation" });
  }
  const mutation: RecoveryMutation = action === "repair_format"
    ? {
        kind: "format_repair",
        action: "repair_format",
        dispatch_id: durableOperation.dispatch_id ?? identity.dispatch_id,
        state_proof: snapshot.state_proof,
        error_class: "format_validation",
        ...(request.grant ? { grant: request.grant } : {}),
        exact_error_digest: digest(snapshot.error_context?.field_errors ?? []),
      }
    : durableOperation.producer_correction || action === "replace" || action === "retry"
      ? {
          kind: "replacement",
          action: "replace",
          dispatch_id: durableOperation.dispatch_id ?? identity.dispatch_id,
          retry_of: durableOperation.retry_of ?? identity.dispatch_id,
          error_class: durableOperation.error_class ?? "terminal_failure",
          state_proof: snapshot.state_proof,
          proof: snapshot.terminal ?? snapshot.preflight as RecoveryPreflightNotStartedProof,
          ...(request.grant ? { grant: request.grant } : {}),
          producer_correction: durableOperation.producer_correction === true,
          ...(snapshot.error_context?.field_errors && durableOperation.producer_correction ? { exact_error_digest: digest(snapshot.error_context.field_errors) } : {}),
        }
      : { kind: "host_action", action, dispatch_id: durableOperation.dispatch_id, state_proof: snapshot.state_proof };
  return executeHostAction(options, snapshot, identity, durableOperation.operation_id, action, mutation, durableOperation.error_class);
}

async function refreshHandoff(
  options: StageRecoveryExecutionOptions,
  snapshot: StageRecoverySnapshot,
): Promise<StageRecoveryResult> {
  const { request, store } = options;
  if (!snapshot.handoff || snapshot.handoff.status !== "stale" || !snapshot.producer) return resultWithHost(request, snapshot, options.host, { code: "handoff_not_stale", worker: snapshot.lifecycle === "running" ? "running" : "unknown", action: "wait", blocking_condition: "canonical state has no stale handoff to refresh", next_action: "reread the current canonical binding" });
  if (!ownershipMatches(request, snapshot)) return invalidRequestResult(request, "recovery_authority_denied", "stale handoff refresh requires exact authenticated ownership");
  const bindingId = producerBindingId(snapshot);
  if (!bindingId) return resultWithHost(request, snapshot, options.host, { code: "handoff_binding_unavailable", worker: "unknown", action: "wait", blocking_condition: "canonical binding has no authenticated host identifier", next_action: "reread the owner handoff" });
  const prepared = await prepare(store, request, snapshot, request.operation_id, { kind: "handoff_refresh", action: "refresh_handoff", state_proof: snapshot.state_proof, binding_id: bindingId });
  if (!prepared.ok) return prepared.result;
  const proof: RecoveryStateProof = { ...snapshot.state_proof, revision: prepared.revision };
  const handoffEvidence: RecoveryHandoffRefreshEvidence = {
    kind: "handoff_refresh",
    authoritative: true,
    run_id: request.run_id,
    authority: request.authority,
    revision: prepared.revision,
    binding_id: bindingId,
    identity: snapshot.producer.identity,
    proof,
  };
  const response: RecoveryResponsePayload = {
    code: "handoff_refreshed",
    worker: snapshot.lifecycle === "running" ? "running" : snapshot.lifecycle === "terminal" ? "terminal" : "unknown",
    action: "refresh_handoff",
    attempts_remaining: 0,
    state_revision: prepared.revision,
    state_proof: proof,
  };
  return acknowledge(store, request, snapshot, request.operation_id, prepared.revision, handoffEvidence, response);
}

async function replaceAfterProof(
  options: StageRecoveryExecutionOptions,
  snapshot: StageRecoverySnapshot,
  proof: RecoveryTerminalProof | RecoveryPreflightNotStartedProof,
  errorClass: RecoveryErrorClass,
  producerCorrection = false,
): Promise<StageRecoveryResult> {
  const { request, store, host } = options;
  const identity = snapshot.identity;
  if (!identity) return resultWithHost(request, snapshot, host, { code: "recovery_identity_unavailable", worker: "unknown", action: "wait", error_class: errorClass, blocking_condition: "replacement requires the exact canonical worker identity", next_action: "reread canonical assignment state" });
  const isPreflight = "kind" in proof && proof.kind === "preflight_not_started";
  if (request.operation === "diagnose") return resultWithHost(request, snapshot, host, { code: isPreflight ? "preflight_not_started" : "worker_terminal", worker: isPreflight ? "not_started" : "terminal", action: "replace", retry_of: proof.dispatch_id, error_class: errorClass, blocking_condition: "diagnose is read-only; no replacement was prepared", next_action: "call reconcile with the same canonical identity and a bounded budget/grant" });
  if (!budgetAvailable(snapshot, request, errorClass)) return resultWithHost(request, snapshot, host, { code: "recovery_grant_required", worker: isPreflight ? "not_started" : "terminal", action: "wait", retry_of: proof.dispatch_id, error_class: errorClass, blocking_condition: "no persisted budget remains for this error class and no authenticated grant was supplied", next_action: "present one explicit authenticated bounded grant; never reset the persisted budget" });
  if (!supported(host?.capabilities ?? EMPTY_CAPABILITIES, "replacement_dispatch", host?.dispatchReplacement)) return resultWithHost(request, snapshot, host, { code: "replacement_unsupported", worker: isPreflight ? "not_started" : "terminal", action: "wait", retry_of: proof.dispatch_id, error_class: errorClass, blocking_condition: "the host has no truthful replacement-dispatch boundary", next_action: "wait for a coordinator/native adapter that declares replacement dispatch; do not launch a second writer" });
  const operationId = producerCorrection || isPreflight ? operationIdFor(request, producerCorrection ? "producer-correction" : "replacement") : request.operation_id;
  const mutation: RecoveryMutation = {
    kind: "replacement",
    action: "replace",
    dispatch_id: identity.dispatch_id,
    retry_of: proof.dispatch_id,
    error_class: errorClass,
    state_proof: snapshot.state_proof,
    proof,
    ...(request.grant ? { grant: request.grant } : {}),
    producer_correction: producerCorrection,
    ...(producerCorrection && snapshot.error_context?.field_errors ? { exact_error_digest: digest(snapshot.error_context.field_errors) } : {}),
  };
  return executeHostAction(options, snapshot, identity, operationId, producerCorrection ? "replace" : "replace", mutation, errorClass);
}

async function repairFormat(
  options: StageRecoveryExecutionOptions,
  snapshot: StageRecoverySnapshot,
): Promise<StageRecoveryResult> {
  const { request, store, host } = options;
  const identity = snapshot.identity;
  const producer = snapshot.producer;
  const errors = snapshot.error_context?.field_errors;
  if (snapshot.error_context?.class !== "format_validation" || !errors || errors.length === 0) return resultWithHost(request, snapshot, host, { code: "format_repair_unavailable", worker: snapshot.lifecycle === "terminal" ? "terminal" : "unknown", action: "wait", blocking_condition: "canonical state has no exact producer-only format validation errors", next_action: "preserve the original submission error context" });
  if (!identity || !producer) return resultWithHost(request, snapshot, host, { code: "producer_identity_unavailable", worker: "unknown", action: "wait", error_class: "format_validation", blocking_condition: "format repair requires the exact original producer binding", next_action: "reread canonical producer ownership" });
  if (request.operation === "diagnose") return resultWithHost(request, snapshot, host, { code: "format_repair_available", worker: snapshot.lifecycle === "running" ? "running" : "terminal", action: "repair_format", error_class: "format_validation", blocking_condition: "diagnose is read-only", next_action: "reconcile exact errors with the same producer" });
  if (snapshot.producer_available === true && supported(host?.capabilities ?? EMPTY_CAPABILITIES, "format_repair", host?.formatRepair)) {
    if (!budgetAvailable(snapshot, request, "format_validation")) return resultWithHost(request, snapshot, host, { code: "recovery_grant_required", worker: snapshot.lifecycle === "terminal" ? "terminal" : "running", action: "wait", error_class: "format_validation", blocking_condition: "the persisted format-validation budget is exhausted", next_action: "present one explicit authenticated bounded grant" });
    const mutation: RecoveryMutation = { kind: "format_repair", action: "repair_format", dispatch_id: identity.dispatch_id, state_proof: snapshot.state_proof, error_class: "format_validation", ...(request.grant ? { grant: request.grant } : {}), exact_error_digest: digest(errors) };
    return executeHostAction(options, snapshot, identity, request.operation_id, "repair_format", mutation, "format_validation");
  }
  const terminal = terminalProof(snapshot);
  if (!terminal) return resultWithHost(request, snapshot, host, { code: "format_repair_waiting_terminal", worker: snapshot.lifecycle === "running" ? "running" : "unknown", action: "wait", error_class: "format_validation", blocking_condition: "the original producer is unavailable and no authoritative terminal proof permits a correction dispatch", next_action: "obtain terminal proof or reconnect the same producer" });
  if (!supported(host?.capabilities ?? EMPTY_CAPABILITIES, "replacement_dispatch", host?.dispatchReplacement)) return resultWithHost(request, snapshot, host, { code: "producer_correction_unsupported", worker: "terminal", action: "wait", retry_of: terminal.dispatch_id, error_class: "format_validation", blocking_condition: "producer-only correction has no truthful dispatch boundary", next_action: "do not rerun implementation or downstream work" });
  return replaceAfterProof(options, snapshot, terminal, "format_validation", true);
}

async function classifyAndReconcile(options: StageRecoveryExecutionOptions, snapshot: StageRecoverySnapshot): Promise<StageRecoveryResult> {
  const { request, store, host } = options;
  const identity = snapshot.identity;
  const retryOf = snapshot.preflight?.dispatch_id ?? terminalProof(snapshot)?.dispatch_id;
  if (request.intent === "repair_format" && (snapshot.error_context?.class !== "format_validation" || !snapshot.error_context.field_errors || snapshot.error_context.field_errors.length === 0)) return repairFormat(options, snapshot);
  const persistedOperation = operationFor(snapshot, request.operation_id, retryOf);
  if (persistedOperation) {
    if (!operationIntentMatches(persistedOperation, request)) {
      return resultWithHost(request, snapshot, host, {
        code: "recovery_operation_conflict",
        worker: snapshot.lifecycle === "terminal" ? "terminal" : snapshot.lifecycle === "not_started" ? "not_started" : "unknown",
        action: "wait",
        retry_of: persistedOperation.retry_of,
        blocking_condition: "the stable recovery operation id is already bound to a different recovery intent",
        next_action: "reuse the original operation intent or issue a new operation id; no second recovery writer was started",
        error_context: { class: "canonical_transition", code: "recovery_operation_conflict", message: "recovery operation intent conflicts with its persisted action" },
      });
    }
    const replayed = replayPayload(request, persistedOperation, snapshot);
    if (replayed && request.operation === "reconcile" && persistedOperation.evidence?.kind === "preflight_not_started") {
      return replaceAfterProof(options, snapshot, persistedOperation.evidence, "preflight_not_started");
    }
    if (replayed) return { ...replayed, ...(persistedOperation.operation_id !== request.operation_id ? { action_operation_id: persistedOperation.operation_id } : {}), supported_actions: supportedActions(snapshot, host) };
    const resumed = await replayPrepared(options, snapshot, persistedOperation);
    if (resumed) return resumed;
  }
  if (request.intent === "refresh_handoff") return refreshHandoff(options, snapshot);
  if (request.intent === "repair_format") return repairFormat(options, snapshot);
  if (!identity) {
    if (request.intent === "clarify" && supported(host?.capabilities ?? EMPTY_CAPABILITIES, "clarify", host?.clarify)) {
      return resultWithHost(request, snapshot, host, { code: "recovery_identity_unavailable", worker: "unknown", action: "wait", blocking_condition: "clarification cannot safely target a worker without canonical identity", next_action: "reread canonical assignment and ownership" });
    }
    return resultWithHost(request, snapshot, host, { code: "worker_outcome_unknown", worker: "unknown", action: "wait", blocking_condition: "canonical state has no exact worker identity or authoritative lifecycle proof", next_action: "wait or clarify; never infer not_started from missing identity" });
  }
  if ((request.intent === "cancel" || request.intent === "cancel_ack") && snapshot.lifecycle !== "terminal") {
    if (!supported(host?.capabilities ?? EMPTY_CAPABILITIES, "cancel_ack", host?.cancelAck)) return resultWithHost(request, snapshot, host, { code: "cancel_ack_unsupported", worker: snapshot.lifecycle === "running" ? "running" : "unknown", action: "wait", blocking_condition: "replacement is blocked until the same worker has an authoritative cancellation acknowledgement", next_action: "obtain a truthful cancel acknowledgement; do not create another writer" });
    return executeHostAction(options, snapshot, identity, request.operation_id, "cancel_ack", { kind: "host_action", action: "cancel_ack", dispatch_id: identity.dispatch_id, state_proof: snapshot.state_proof });
  }
  if (request.intent === "clarify" && supported(host?.capabilities ?? EMPTY_CAPABILITIES, "clarify", host?.clarify)) {
    return executeHostAction(options, snapshot, identity, request.operation_id, "clarify", { kind: "host_action", action: "clarify", dispatch_id: identity.dispatch_id, state_proof: snapshot.state_proof });
  }
  if (request.intent === "clarify") return resultWithHost(request, snapshot, host, { code: "clarify_unsupported", worker: snapshot.lifecycle === "running" ? "running" : snapshot.lifecycle === "disconnected" ? "disconnected" : "unknown", action: "wait", blocking_condition: "the host has no declared authoritative clarification callback", next_action: "wait for lifecycle evidence; do not infer not_started" });
  if (snapshot.lifecycle === "running") {
    if (request.operation === "diagnose" || request.intent === "observe" || !observationSupported(host)) return resultWithHost(request, snapshot, host, { code: "worker_running", worker: "running", action: "observe", next_action: "wait for the authoritative terminal lifecycle" });
    return executeHostAction(options, snapshot, identity, request.operation_id, "observe", { kind: "host_action", action: "observe", dispatch_id: identity.dispatch_id, state_proof: snapshot.state_proof });
  }
  if (snapshot.lifecycle === "disconnected") {
    if (request.operation === "reconcile" && (request.intent === undefined || request.intent === "reconnect") && supported(host?.capabilities ?? EMPTY_CAPABILITIES, "reconnect", host?.reconnect)) return executeHostAction(options, snapshot, identity, request.operation_id, "reconnect", { kind: "host_action", action: "reconnect", dispatch_id: identity.dispatch_id, state_proof: snapshot.state_proof });
    return resultWithHost(request, snapshot, host, { code: "worker_disconnected", worker: "disconnected", action: "wait", blocking_condition: "transport loss is not proof that the executor stopped", next_action: supported(host?.capabilities ?? EMPTY_CAPABILITIES, "reconnect", host?.reconnect) ? "reconnect the same worker" : "wait for reconnect or terminal lifecycle evidence" });
  }
  const preflight = canonicalPreflight(snapshot);
  if (preflight) {
    if (request.intent === "observe" || request.operation === "diagnose") return resultWithHost(request, snapshot, host, { code: "preflight_not_started", worker: "not_started", action: "replace", retry_of: preflight.dispatch_id, error_class: "preflight_not_started", blocking_condition: "canonical state contains an authenticated preflight proof", next_action: request.operation === "diagnose" ? "reconcile for one bounded linked replacement" : "prepare one bounded linked replacement" });
    return replaceAfterProof(options, snapshot, preflight, "preflight_not_started");
  }
  const terminal = terminalProof(snapshot);
  if (terminal) {
    if (terminal.outcome === "failed" && supported(host?.capabilities ?? EMPTY_CAPABILITIES, "resume", host?.resume) && request.intent !== "replace" && request.intent !== "retry") {
      if (request.operation === "diagnose") return resultWithHost(request, snapshot, host, { code: "resume_available", worker: "terminal", action: "resume", retry_of: terminal.dispatch_id, error_class: "terminal_failure", next_action: "reconcile the same worker with the authoritative resume callback" });
      return executeHostAction(options, snapshot, identity, request.operation_id, "resume", { kind: "host_action", action: "resume", dispatch_id: identity.dispatch_id, state_proof: snapshot.state_proof }, "terminal_failure");
    }
    if (request.intent === "resume") return resultWithHost(request, snapshot, host, { code: "resume_unsupported", worker: "terminal", action: "wait", retry_of: terminal.dispatch_id, error_class: "terminal_failure", blocking_condition: "the actual host does not declare a truthful same-worker resume operation", next_action: "request a bounded linked replacement only with an explicit grant" });
    if (request.operation === "diagnose" || request.intent === "replace" || request.intent === "retry" || !supported(host?.capabilities ?? EMPTY_CAPABILITIES, "resume", host?.resume)) return replaceAfterProof(options, snapshot, terminal, terminal.outcome === "cancelled" ? "cancelled" : "terminal_failure");
    return resultWithHost(request, snapshot, host, { code: "worker_terminal", worker: "terminal", action: "wait", retry_of: terminal.dispatch_id, error_class: terminal.outcome === "cancelled" ? "cancelled" : "terminal_failure", blocking_condition: "terminal proof exists but no safe recovery intent was selected", next_action: "request resume or one bounded linked replacement" });
  }
  if (snapshot.lifecycle === "pending" && request.operation === "reconcile" && supported(host?.capabilities ?? EMPTY_CAPABILITIES, "preflight_not_started", host?.preflightNotStarted)) {
    const prepared = await prepare(store, request, snapshot, request.operation_id, { kind: "host_action", action: "preflight", dispatch_id: identity.dispatch_id, state_proof: snapshot.state_proof });
    if (!prepared.ok) return prepared.result;
    let evidence: RecoveryPreflightEvidence;
    try {
      evidence = await host!.preflightNotStarted!({ request, operation_id: request.operation_id, snapshot, identity, state_proof: snapshot.state_proof, prepared_operation: prepared.operation, ...(snapshot.error_context ? { error_context: snapshot.error_context } : {}) });
    } catch {
      return { ...mutationResponse(request, snapshot, "wait", undefined, { code: "host_callback_failed", worker: "unknown", action: "wait", blocking_condition: "authoritative preflight failed without proof; not_started was not inferred", next_action: "replay the same operation id or wait for a terminal event", error_context: callbackFailure("preflight") }), operation_id: request.operation_id };
    }
    const candidate = evidence as RecoveryPreflightEvidence;
    const valid = isRecord(evidence) && (candidate.kind === "preflight_not_started"
      ? preflightEvidenceMatches(candidate, request, snapshot)
      : hostEvidenceMatches(candidate, request, snapshot, "preflight"));
    if (!valid) {
      return { ...mutationResponse(request, snapshot, "wait", undefined, { code: "invalid_preflight_evidence", worker: "unknown", action: "wait", blocking_condition: "preflight evidence was not authenticated to the exact assignment", next_action: "preserve the prepared operation and obtain an authoritative lifecycle receipt", error_context: { class: "host_evidence", code: "invalid_preflight_evidence", message: "preflight evidence failed identity validation" } }), operation_id: request.operation_id };
    }
    const typed = candidate as RecoveryHostEvidence;
    const response = transitionPayload(request, snapshot, "preflight", typed, typed.kind === "preflight_not_started" ? "preflight_not_started" : undefined);
    const acknowledged = await acknowledge(store, request, snapshot, request.operation_id, prepared.revision, typed, response);
    if (typed.kind !== "preflight_not_started" || acknowledged.code !== "preflight_not_started") return acknowledged;
    const replacement = await replaceAfterProof({ ...options, request: { ...request, operation: "reconcile" } }, { ...snapshot, revision: acknowledged.state_revision ?? prepared.revision, state_proof: acknowledged.state_proof ?? { ...snapshot.state_proof, revision: acknowledged.state_revision ?? prepared.revision }, preflight: typed }, typed, "preflight_not_started");
    return { ...replacement, operation_id: request.operation_id };
  }
  return resultWithHost(request, snapshot, host, { code: "worker_outcome_unknown", worker: "unknown", action: "wait", blocking_condition: "no authoritative start, reconnect, preflight, or terminal event proves an outcome", next_action: "wait for a host lifecycle result; do not create a replacement writer" });
}

/** Execute one bounded recovery operation against an ordinary or native owner. */
export async function recoverStageExecution(options: StageRecoveryExecutionOptions): Promise<StageRecoveryResult> {
  const { request, store, host } = options;
  if (!nonEmpty(request.run_id) || !nonEmpty(request.operation_id) || (request.operation !== "diagnose" && request.operation !== "reconcile")) return invalidRequestResult(request, "invalid_recovery_request", "run_id, operation_id, and operation are required");
  let snapshot: StageRecoverySnapshot;
  try {
    snapshot = await store.read({ run_id: request.run_id, authority: request.authority, ...(request.identity ? { identity: request.identity } : {}), ...(request.selection ? { selection: request.selection } : {}) });
  } catch {
    return invalidRequestResult(request, "recovery_state_unavailable", "the canonical recovery owner could not be read; no lifecycle inference was made");
  }
  const invalid = validateSnapshot(request, snapshot);
  if (invalid) return { ...invalidRequestResult(request, "recovery_authority_denied", invalid), state_revision: snapshot.revision, state_proof: snapshot.state_proof, error_context: { class: "canonical_state", code: "recovery_authority_denied", message: "canonical state failed exact recovery identity or ownership validation" } };
  if (request.operation === "diagnose") {
    const operation = operationFor(snapshot, request.operation_id, snapshot.preflight?.dispatch_id ?? terminalProof(snapshot)?.dispatch_id);
    const replay = operation ? replayPayload(request, operation, snapshot) : undefined;
    if (replay) return { ...replay, replayed: true, supported_actions: supportedActions(snapshot, host) };
    // Diagnose deliberately does not call transition or a mutating host callback.
    if (request.intent === "repair_format") return repairFormat({ ...options, request }, snapshot);
    if (snapshot.lifecycle === "running") return resultWithHost(request, snapshot, host, { code: "worker_running", worker: "running", action: "observe", next_action: "wait for the authoritative terminal lifecycle" });
    if (snapshot.lifecycle === "disconnected") return resultWithHost(request, snapshot, host, { code: "worker_disconnected", worker: "disconnected", action: "wait", blocking_condition: "transport loss is not proof that the executor stopped", next_action: "reconnect the same worker or wait for terminal proof" });
    const preflight = canonicalPreflight(snapshot);
    if (preflight) return resultWithHost(request, snapshot, host, { code: "preflight_not_started", worker: "not_started", action: "replace", retry_of: preflight.dispatch_id, error_class: "preflight_not_started", next_action: "reconcile one bounded linked replacement" });
    const terminal = terminalProof(snapshot);
    if (terminal) {
      const resumeAvailable = terminal.outcome === "failed" && supported(host?.capabilities ?? EMPTY_CAPABILITIES, "resume", host?.resume);
      return resultWithHost(request, snapshot, host, { code: resumeAvailable ? "resume_available" : "worker_terminal", worker: "terminal", action: resumeAvailable ? "resume" : "replace", retry_of: terminal.dispatch_id, error_class: terminal.outcome === "cancelled" ? "cancelled" : "terminal_failure", next_action: resumeAvailable ? "reconcile the same worker with the authoritative resume callback" : "reconcile only after terminal proof and budget checks" });
    }
    return resultWithHost(request, snapshot, host, { code: "worker_outcome_unknown", worker: "unknown", action: "wait", blocking_condition: "no authoritative start, preflight, or terminal event is persisted", next_action: "wait or clarify; never infer not_started from provider_ref, timeout, absence, or exception" });
  }
  return classifyAndReconcile(options, snapshot);
}
