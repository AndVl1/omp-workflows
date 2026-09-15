/**
 * Durable checkpoint decisions.
 *
 * Checkpoint labels and legacy autonomy prose are migration/display inputs.
 * Permission is granted only by a policy-bound typed decision. Both native
 * checkpoint tools (through `appendCheckpointDecision`) and the interpreter
 * (`validateCheckpointForAdvance`) use the same validator below.
 */

import { createHash, randomBytes } from "node:crypto";
import { migrationCheckpointPolicy, validateTypedControlPlane } from "./workflow-contract.js";
import type {
  CheckpointActor,
  CheckpointAnswerChannel,
  CheckpointAnswerProof,
  CheckpointDecision,
  CheckpointPolicy,
  CheckpointRule,
  NativeCheckpointRuleKind,
  StageDef,
  TeamState,
  TrustedCheckpointAnswer,
  TypedCheckpointDecision,
} from "./types.js";

export const CONSTITUTION_APPROVAL_DECISIONS = ["approve_continue", "request_changes"] as const;
export const SPECIFICATION_PHASE_APPROVAL_DECISIONS = [
  "approve_continue",
  "request_changes",
  "approve_stop",
] as const;

const NATIVE_CHECKPOINT_DECISIONS: Record<NativeCheckpointRuleKind, readonly string[]> = {
  constitution_approval: CONSTITUTION_APPROVAL_DECISIONS,
  specification_phase_approval: SPECIFICATION_PHASE_APPROVAL_DECISIONS,
};

const HARD_HUMAN_FLOOR: Record<string, true> = {
  constitution_approval: true,
  specification_phase_approval: true,
  product_approval: true,
  security: true,
  destructive_side_effect: true,
  production: true,
  bundle_activation: true,
  migration_cutover: true,
};

type StageCheckpointRef = Pick<StageDef, "id" | "checkpoint" | "checkpoint_policy">;
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
const isBoundedCheckpointFeedback = (value: string): boolean => Buffer.byteLength(value, "utf8") <= 8192 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);

const CHECKPOINT_CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CHECKPOINT_ID = /^[A-Za-z0-9._-]+$/u;
const CHECKPOINT_TEXT_BYTES = 4096;
const CHECKPOINT_RATIONALE_BYTES = 8192;
const isSafeCheckpointReference = (value: string): boolean =>
  !value.split(/[\\/]/u).some((segment) => segment === "" || segment === "." || segment === "..");

/** Filesystem identity bound to a host Ask capability. */
export interface TrustedCheckpointRootIdentity {
  canonical_root: string;
  dev: number;
  ino: number;
}

/**
 * Opaque runtime-only authority minted after the trusted host Ask returns.
 * The object has no bearer fields; the module-private WeakMap below is the
 * only source of its provenance.
 */
export type TrustedCheckpointAnswerCapability = object & { readonly __trusted_checkpoint_answer_capability?: never };

export interface TrustedCheckpointAnswerIssuanceInput {
  root: TrustedCheckpointRootIdentity;
  state: TeamState;
  answer_id: string;
  channel: CheckpointAnswerChannel;
  reference: string;
  stage_id: string;
  checkpoint_id: string;
  decision: string;
  feedback?: string;
  feature_id?: string;
  loop_iteration?: number;
  subject_binding?: string;
  subject_revision?: number;
  /** Exact canonical host question and ordered policy options. */
  question: string;
  options: readonly string[];
  /** Current host session identity and answer actor reference. */
  session_id: string;
  actor_ref: string;
  /** Immutable workflow profile identity rendered by the selected Ask. */
  profile_hash?: string;
}

export interface TrustedCheckpointAnswerRecordOptions {
  capability: TrustedCheckpointAnswerCapability;
  root: TrustedCheckpointRootIdentity;
}

type TrustedCheckpointAnswerAuthority = {
  capability: TrustedCheckpointAnswerCapability;
  root: TrustedCheckpointRootIdentity;
  answer_id: string;
  channel: CheckpointAnswerChannel;
  reference: string;
  stage_id: string;
  checkpoint_id: string;
  decision: string;
  feedback?: string;
  feature_id?: string;
  loop_iteration?: number;
  subject_binding?: string;
  subject_revision?: number;
  run_id: string;
  capability_id: string;
  capability_epoch: string;
  policy_hash: string;
  profile_hash?: string;
  work_identity_hash: string;
  question: string;
  options: readonly string[];
  session_id: string;
  actor_ref: string;
  authority_receipt: string;
  nonce: string;
  /** Monotonic process-local issue time; never trusted from host input. */
  issued_at_ms: number;
};

let trustedCheckpointHostBridge: object | null = null;
const trustedCheckpointAnswerAuthorities = new Map<string, TrustedCheckpointAnswerAuthority>();
const trustedCheckpointAnswerCapabilities = new WeakMap<object, TrustedCheckpointAnswerAuthority>();
const TRUSTED_CHECKPOINT_AUTHORITIES_MAX = 1024;
const TRUSTED_CHECKPOINT_AUTHORITY_TTL_MS = 30 * 60 * 1000;

function retireTrustedCheckpointAnswerAuthority(answerId: string): void {
  const authority = trustedCheckpointAnswerAuthorities.get(answerId);
  if (!authority) return;
  trustedCheckpointAnswerAuthorities.delete(answerId);
  trustedCheckpointAnswerCapabilities.delete(authority.capability);
}

/**
 * Remove authorities that are no longer usable. A durable consumed marker is
 * authoritative when a state snapshot is available; an unconsumed answer is
 * retained until its bounded TTL so a pending commit/retry is not silently
 * invalidated by a sweep.
 */
function sweepTrustedCheckpointAnswerAuthorities(state?: TeamState, retireConsumed = false): void {
  const now = Date.now();
  const consumed = retireConsumed
    ? new Set((state?.trusted_checkpoint_answers ?? [])
      .filter((answer) => answer.consumed_at !== undefined)
      .map((answer) => answer.answer_id))
    : undefined;
  for (const [answerId, authority] of trustedCheckpointAnswerAuthorities) {
    if (consumed?.has(answerId) || now - authority.issued_at_ms >= TRUSTED_CHECKPOINT_AUTHORITY_TTL_MS) {
      retireTrustedCheckpointAnswerAuthority(answerId);
    }
  }
}

/** Delete one authority after its durable transition is known to have committed. */
export function retireTrustedCheckpointAnswer(answerId: string): void {
  if (!nonEmpty(answerId)) return;
  retireTrustedCheckpointAnswerAuthority(answerId);
}

/** Internal one-time bridge installed by the mounted workflow host. */
export function registerTrustedCheckpointHostBridge(bridge: object): void {
  if (trustedCheckpointHostBridge === null) {
    trustedCheckpointHostBridge = bridge;
    return;
  }
  if (trustedCheckpointHostBridge !== bridge) throw new Error("checkpoint_unverified: trusted host bridge is already bound");
}

function authorityForCapability(value: unknown): TrustedCheckpointAnswerAuthority | null {
  if (!value || typeof value !== "object") return null;
  const authority = trustedCheckpointAnswerCapabilities.get(value) ?? null;
  if (!authority || trustedCheckpointAnswerAuthorities.get(authority.answer_id) !== authority) return null;
  return authority;
}

function sameRootIdentity(left: TrustedCheckpointRootIdentity, right: TrustedCheckpointRootIdentity): boolean {
  return left.canonical_root === right.canonical_root && left.dev === right.dev && left.ino === right.ino;
}

function authorityInputError(
  state: TeamState,
  input: TrustedCheckpointAnswerInput,
  authority: TrustedCheckpointAnswerAuthority,
  root: TrustedCheckpointRootIdentity,
): string | null {
  const binding = capabilityBinding(state);
  const policy = state.checkpoint_policy;
  const expectedRun = expectedRunId(state);
  const policyHash = policy ? checkpointPolicyHash(policy) : null;
  const profileHash = state.profile_hash;
  if (!sameRootIdentity(authority.root, root)) return "checkpoint_unverified: trusted host answer root identity is stale or mismatched";
  if (!binding || !policy || !policyHash) return "checkpoint_unverified: checkpoint capability or policy binding is unavailable";
  if (authority.answer_id !== input.answer_id || authority.channel !== input.channel || authority.reference !== input.reference
    || authority.stage_id !== input.stage_id || authority.checkpoint_id !== input.checkpoint_id || authority.decision !== input.decision
    || authority.feedback !== input.feedback || authority.feature_id !== input.feature_id || authority.loop_iteration !== input.loop_iteration
    || authority.subject_binding !== input.subject_binding || authority.subject_revision !== input.subject_revision
    || authority.run_id !== expectedRun || authority.capability_id !== binding.id || authority.capability_epoch !== binding.epoch
    || authority.policy_hash !== policyHash || !authority.profile_hash || authority.profile_hash !== profileHash
    || authority.work_identity_hash !== checkpointWorkIdentityHash(state, input.stage_id)) {
    return "checkpoint_unverified: trusted host answer capability is stale or mismatched";
  }
  return null;
}

/**
 * Mint one opaque authority only for the mounted host Ask path.  Callers must
 * retain the returned object in memory and pass it to record/commit; copying
 * any durable answer fields cannot recreate this capability.
 */
export function issueTrustedCheckpointAnswerCapability(
  bridge: object,
  input: TrustedCheckpointAnswerIssuanceInput,
): TrustedCheckpointAnswerCapability {
  // A canonical consumed marker permits a later host Ask to reuse an answer id
  // only after the prior authority has been retired; pending records remain
  // protected by the duplicate-id check.
  sweepTrustedCheckpointAnswerAuthorities(input?.state, true);
  if (trustedCheckpointHostBridge === null || bridge !== trustedCheckpointHostBridge) {
    throw new Error("checkpoint_unverified: trusted host Ask bridge is unavailable");
  }
  if (trustedCheckpointAnswerAuthorities.size >= TRUSTED_CHECKPOINT_AUTHORITIES_MAX) {
    throw new Error("checkpoint_recovery_required: trusted host answer authority registry is at capacity; complete or recover a pending answer before asking again");
  }
  if (trustedCheckpointAnswerAuthorities.has(input.answer_id)) {
    throw new Error("checkpoint_unverified: trusted host answer capability has already been issued");
  }
  if (!nonEmpty(input.root.canonical_root)
    || !Number.isSafeInteger(input.root.dev) || !Number.isSafeInteger(input.root.ino)
    || !nonEmpty(input.answer_id) || !nonEmpty(input.reference) || !nonEmpty(input.stage_id)
    || !nonEmpty(input.checkpoint_id) || !nonEmpty(input.decision) || !nonEmpty(input.question)
    || !nonEmpty(input.session_id) || !nonEmpty(input.actor_ref) || !nonEmpty(input.profile_hash)
    || !Array.isArray(input.options) || input.options.length === 0
    || input.options.some((option) => !nonEmpty(option))) {
    throw new Error("checkpoint_unverified: trusted host answer capability context is incomplete");
  }
  const binding = capabilityBinding(input.state);
  const policy = input.state.checkpoint_policy;
  if (!binding || !policy) throw new Error("checkpoint_unverified: checkpoint capability or policy binding is unavailable");
  const rule = policy.rules[input.checkpoint_id];
  if (!rule || !rule.allowed_decisions.includes(input.decision)) throw new Error("checkpoint_unverified: decision is not allowed by the active checkpoint policy");
  const authority: TrustedCheckpointAnswerAuthority = {
    capability: Object.freeze(Object.create(null)) as TrustedCheckpointAnswerCapability,
    root: { canonical_root: input.root.canonical_root, dev: input.root.dev, ino: input.root.ino },
    answer_id: input.answer_id,
    channel: input.channel,
    reference: input.reference,
    stage_id: input.stage_id,
    checkpoint_id: input.checkpoint_id,
    decision: input.decision,
    ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
    ...(input.feature_id !== undefined ? { feature_id: input.feature_id } : {}),
    ...(input.loop_iteration !== undefined ? { loop_iteration: input.loop_iteration } : {}),
    ...(input.subject_binding !== undefined ? { subject_binding: input.subject_binding } : {}),
    ...(input.subject_revision !== undefined ? { subject_revision: input.subject_revision } : {}),
    run_id: expectedRunId(input.state),
    capability_id: binding.id,
    capability_epoch: binding.epoch,
    policy_hash: checkpointPolicyHash(policy),
    profile_hash: input.profile_hash,
    work_identity_hash: checkpointWorkIdentityHash(input.state, input.stage_id),
    question: input.question,
    options: Object.freeze([...input.options]),
    session_id: input.session_id,
    actor_ref: input.actor_ref,
    authority_receipt: randomBytes(32).toString("hex"),
    nonce: randomBytes(32).toString("hex"),
    issued_at_ms: Date.now(),
  };
  trustedCheckpointAnswerAuthorities.set(input.answer_id, authority);
  trustedCheckpointAnswerCapabilities.set(authority.capability, authority);
  return authority.capability;
}

function checkpointInputError(decision: CheckpointDecision | TypedCheckpointDecision): string | null {
  const value = decision as unknown as Record<string, unknown>;
  const textFields = [
    "stage_id", "checkpoint", "checkpoint_id", "decision", "rationale", "run_id",
    "capability_id", "capability_epoch", "policy_hash", "feature_id", "subject_binding",
    "artifact_id", "validation_ref", "artifact_digest", "validation_digest", "decided_at",
  ];
  let aggregate = 0;
  for (const field of textFields) {
    const item = value[field];
    if (item === undefined) continue;
    if (typeof item !== "string" || Buffer.byteLength(item, "utf8") > (field === "rationale" ? CHECKPOINT_RATIONALE_BYTES : CHECKPOINT_TEXT_BYTES) || CHECKPOINT_CONTROL_OR_FORMAT.test(item)) {
      return `checkpoint decision ${field} is not bounded line-inert text`;
    }
    aggregate += Buffer.byteLength(item, "utf8");
  }
  for (const field of ["stage_id", "checkpoint", "checkpoint_id", "capability_id", "capability_epoch", "feature_id", "artifact_id"] as const) {
    const item = value[field];
    if (item !== undefined && (typeof item !== "string" || !CHECKPOINT_ID.test(item) || item === "." || item === "..")) return `checkpoint decision ${field} is not a safe identifier`;
  }
  const actor = value.actor_provenance ?? value.actor;
  if (actor && typeof actor === "object" && !Array.isArray(actor)) {
    const actorValue = actor as Record<string, unknown>;
    const item = actorValue.ref;
    if (item !== undefined && (typeof item !== "string" || Buffer.byteLength(item, "utf8") > CHECKPOINT_TEXT_BYTES || CHECKPOINT_CONTROL_OR_FORMAT.test(item) || !isSafeCheckpointReference(item))) return "checkpoint actor ref is not bounded or safe";
    if (typeof item === "string") aggregate += Buffer.byteLength(item, "utf8");
    const proof = actorValue.proof;
    if (proof && typeof proof === "object" && !Array.isArray(proof)) {
      for (const field of ["answer_id", "nonce", "reference", "binding"] as const) {
        const proofItem = (proof as Record<string, unknown>)[field];
        if (proofItem !== undefined && (typeof proofItem !== "string" || Buffer.byteLength(proofItem, "utf8") > CHECKPOINT_TEXT_BYTES || CHECKPOINT_CONTROL_OR_FORMAT.test(proofItem) || !isSafeCheckpointReference(proofItem))) return `checkpoint proof ${field} is not bounded or safe`;
        if (typeof proofItem === "string") aggregate += Buffer.byteLength(proofItem, "utf8");
      }
      const feedback = (proof as Record<string, unknown>).feedback;
      if (feedback !== undefined && (typeof feedback !== "string" || !feedback.trim() || Buffer.byteLength(feedback, "utf8") > CHECKPOINT_RATIONALE_BYTES || CHECKPOINT_CONTROL_OR_FORMAT.test(feedback))) return "checkpoint proof feedback is not bounded non-empty line-inert text";
      if (typeof feedback === "string") aggregate += Buffer.byteLength(feedback, "utf8");
    }
  }
  return aggregate > 16 * 1024 ? "checkpoint decision text aggregate exceeds the maximum byte budget" : null;
}


export type CheckpointValidationCode =
  | "policy_invalid"
  | "migration_conflict"
  | "checkpoint_unverified"
  | "checkpoint_unresolved";

export interface CheckpointValidationFailure {
  ok: false;
  code: CheckpointValidationCode;
  error: string;
  pauseKind?: "user_checkpoint" | "needs_human";
}

export interface CheckpointValidationSuccess {
  ok: true;
  decision: TypedCheckpointDecision;
}

export type CheckpointValidationResult = CheckpointValidationSuccess | CheckpointValidationFailure;

export interface CheckpointValidationOptions {
  /** The declaring stage.  When omitted, ids on the decision are used. */
  stage?: StageCheckpointRef;
  /** Explicit policy projection; state/stage/migration precedence is used otherwise. */
  policy?: CheckpointPolicy;
  /**
   * Historical decisions may be consumed after the capability has advanced.
   * New decisions and advance-time validation keep the binding enabled.
   */
  bindCapability?: boolean;
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}
function checkpointSubjectIdentity(decision: Pick<TypedCheckpointDecision, "feature_id" | "loop_iteration" | "subject_binding" | "artifact_id" | "artifact_version" | "artifact_digest" | "validation_ref" | "validation_digest">): string {
  return JSON.stringify(canonicalize({
    feature_id: decision.feature_id ?? null,
    loop_iteration: decision.loop_iteration ?? null,
    subject_binding: decision.subject_binding ?? null,
    artifact_id: decision.artifact_id ?? null,
    artifact_version: decision.artifact_version ?? null,
    artifact_digest: decision.artifact_digest ?? null,
    validation_ref: decision.validation_ref ?? null,
    validation_digest: decision.validation_digest ?? null,
  }));
}


/** SHA-256 over canonical policy JSON; persisted migration uses the same rule. */
export function checkpointPolicyHash(policy: CheckpointPolicy): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(policy)))
    .digest("hex");
}
export interface TrustedCheckpointAnswerInput {
  /** Durable identity supplied by a trusted terminal/escalation ingest path. */
  answer_id: string;
  channel: CheckpointAnswerChannel;
  reference: string;
  stage_id: string;
  checkpoint_id: string;
  decision: string;
  /** Trusted current-user feedback required by selected request_changes callers. */
  feedback?: string;
  feature_id?: string;
  loop_iteration?: number;
  subject_binding?: string;
  subject_revision?: number;
  issued_at?: string;
}

type AnswerBindingInput = Omit<TrustedCheckpointAnswer, "binding" | "consumed_at">;

/** Canonical digest that binds an answer to its complete decision context. */
export function checkpointAnswerBinding(answer: AnswerBindingInput): string {
  const { binding: _binding, consumed_at: _consumedAt, ...payload } = answer as TrustedCheckpointAnswer;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex");
}

export function checkpointWorkIdentityHash(state: TeamState, stageId: string): string {
  const binding = capabilityBinding(state);
  const identity = state.work_identity ?? {
    run_id: expectedRunId(state),
    wave_id: "checkpoint",
    slice_id: "checkpoint",
    session_id: "checkpoint",
    workflow: state.classification.workflow,
    stage_id: stageId,
    stage_cursor: stageId,
    capability_id: binding?.id ?? "",
    capability_epoch: binding?.epoch ?? "",
    slot_id: "checkpoint",
    task_id: `checkpoint:${stageId}`,
    dispatch_id: `checkpoint:${stageId}`,
    attempt: 1,
    worker_id: "engine",
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(identity))).digest("hex");
}

function answerProof(answer: TrustedCheckpointAnswer): CheckpointAnswerProof {
  return {
    answer_id: answer.answer_id,
    nonce: answer.nonce,
    channel: answer.channel,
    reference: answer.reference,
    binding: answer.binding,
    ...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}),
  };
}

/**
 * Record an answer at the trusted terminal/escalation ingest boundary.
 *
 * The host Ask must first issue an opaque runtime capability. The public
 * checkpoint tool receives only the returned proof; it cannot choose the
 * nonce, receipt, or binding, and re-ingesting an answer id is idempotent only
 * when every durable context field and authenticated receipt are identical.
 */
export function recordTrustedCheckpointAnswer(
  state: TeamState,
  input: TrustedCheckpointAnswerInput,
  options: TrustedCheckpointAnswerRecordOptions,
): { state: TeamState; answer: TrustedCheckpointAnswer; proof: CheckpointAnswerProof } {
  sweepTrustedCheckpointAnswerAuthorities(state);
  const authority = authorityForCapability(options?.capability);
  if (!authority) throw new Error("checkpoint_recovery_required: trusted host answer authority capability is unavailable; repeat the host Ask");
  if (!options?.root) throw new Error("checkpoint_recovery_required: trusted host answer root binding is unavailable; repeat the host Ask");
  const authorityError = authorityInputError(state, input, authority, options.root);
  if (authorityError) throw new Error(authorityError);
  if (
    !nonEmpty(input.answer_id)
    || !nonEmpty(input.reference)
    || !nonEmpty(input.stage_id)
    || !nonEmpty(input.checkpoint_id)
    || !nonEmpty(input.decision)
    || (input.channel !== "terminal" && input.channel !== "escalation")
  ) {
    throw new Error("checkpoint_unverified: trusted answer identity is incomplete");
  }
  const bounded = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
  if (!bounded(input.answer_id) || !bounded(input.reference) || !bounded(input.stage_id) || !bounded(input.checkpoint_id) || !bounded(input.decision, 256)) throw new Error("checkpoint_unverified: trusted answer fields exceed bounds");
  if (input.feature_id !== undefined && (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.feature_id))) throw new Error("checkpoint_unverified: trusted answer feature_id is invalid");
  if (input.loop_iteration !== undefined && (!Number.isSafeInteger(input.loop_iteration) || input.loop_iteration < 1 || input.loop_iteration > 1000000)) throw new Error("checkpoint_unverified: trusted answer loop_iteration is invalid");
  if (input.subject_binding !== undefined && !/^[a-f0-9]{64}$/u.test(input.subject_binding)) throw new Error("checkpoint_unverified: trusted answer subject binding is invalid");
  if (input.subject_revision !== undefined && (!Number.isSafeInteger(input.subject_revision) || input.subject_revision < 0)) throw new Error("checkpoint_unverified: trusted answer subject revision is invalid");
  if (input.decision === "request_changes") {
    if (input.feedback === undefined || typeof input.feedback !== "string" || !input.feedback || input.feedback !== input.feedback.trim() || !isBoundedCheckpointFeedback(input.feedback)) throw new Error("checkpoint_unverified: request_changes trusted answer requires exact bounded feedback");
  } else if (input.feedback !== undefined) {
    throw new Error("checkpoint_unverified: feedback is only valid for request_changes");
  }
  if (input.reference.trim().toLowerCase().startsWith("user:")) {
    throw new Error("checkpoint_unverified: user provenance references are not durable answer identities");
  }
  const binding = capabilityBinding(state);
  if (!binding) throw new Error("checkpoint_unverified: checkpoint capability binding is unavailable");
  const policy = state.checkpoint_policy;
  if (!policy) throw new Error("checkpoint_unverified: checkpoint policy is unavailable");
  const policyIssues = policyValidationIssues(policy);
  if (policyIssues.length > 0) {
    throw new Error("checkpoint_unverified: checkpoint policy is invalid: " + policyIssues.join("; "));
  }
  const rule = policy.rules[input.checkpoint_id];
  if (!rule || !rule.allowed_decisions.includes(input.decision)) {
    throw new Error("checkpoint_unverified: decision is not allowed by the active checkpoint policy");
  }
  const policyHash = checkpointPolicyHash(policy);
  const runId = expectedRunId(state);
  const workIdentityHash = checkpointWorkIdentityHash(state, input.stage_id);
  const existing = (state.trusted_checkpoint_answers ?? []).find((candidate) => candidate.answer_id === input.answer_id);
  const sameOptionalContext = (left: unknown, right: unknown): boolean =>
    (left === undefined) === (right === undefined) && left === right;
  if (existing) {
    const expected = checkpointAnswerBinding(existing);
    if (
      existing.binding !== expected
      || existing.authority_receipt !== authority.authority_receipt
      || existing.nonce !== authority.nonce
      || existing.channel !== input.channel
      || existing.reference !== input.reference
      || existing.run_id !== runId
      || existing.stage_id !== input.stage_id
      || existing.checkpoint_id !== input.checkpoint_id
      || existing.work_identity_hash !== workIdentityHash
      || existing.capability_id !== binding.id
      || existing.capability_epoch !== binding.epoch
      || existing.policy_hash !== policyHash
      || existing.decision !== input.decision
      || !sameOptionalContext(existing.feature_id, input.feature_id)
      || !sameOptionalContext(existing.loop_iteration, input.loop_iteration)
      || !sameOptionalContext(existing.subject_binding, input.subject_binding)
      || !sameOptionalContext(existing.subject_revision, input.subject_revision)
      || !sameOptionalContext(existing.feedback, input.feedback)
    ) {
      throw new Error("checkpoint_unverified: trusted answer replay conflicts with the active context");
    }
    return { state, answer: existing, proof: answerProof(existing) };
  }
  const answer: TrustedCheckpointAnswer = {
    answer_id: input.answer_id,
    nonce: authority.nonce,
    channel: input.channel,
    reference: input.reference,
    run_id: runId,
    stage_id: input.stage_id,
    checkpoint_id: input.checkpoint_id,
    work_identity_hash: workIdentityHash,
    capability_id: binding.id,
    capability_epoch: binding.epoch,
    policy_hash: policyHash,
    ...(input.feature_id !== undefined ? { feature_id: input.feature_id } : {}),
    ...(input.loop_iteration !== undefined ? { loop_iteration: input.loop_iteration } : {}),
    ...(input.subject_binding !== undefined ? { subject_binding: input.subject_binding } : {}),
    ...(input.subject_revision !== undefined ? { subject_revision: input.subject_revision } : {}),
    decision: input.decision,
    ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
    binding: "",
    authority_receipt: authority.authority_receipt,
    issued_at: input.issued_at ?? new Date().toISOString(),
  };
  answer.binding = checkpointAnswerBinding(answer);
  const next: TeamState = {
    ...state,
    trusted_checkpoint_answers: [...(state.trusted_checkpoint_answers ?? []), answer],
  };
  return { state: next, answer, proof: answerProof(answer) };
}

function nativeCheckpointKind(value: string): NativeCheckpointRuleKind | null {
  return Object.prototype.hasOwnProperty.call(NATIVE_CHECKPOINT_DECISIONS, value)
    ? value as NativeCheckpointRuleKind
    : null;
}

function exactDecisionSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((decision) => actual.includes(decision));
}

function policyForTypedControlPlane(policy: CheckpointPolicy): CheckpointPolicy {
  const hardHuman = policy.hard_human.map((kind) => nativeCheckpointKind(kind) ? "product_approval" as const : kind);
  return {
    ...policy,
    hard_human: [...new Set(hardHuman)],
    rules: Object.fromEntries(Object.entries(policy.rules).map(([id, rule]) => [
      id,
      nativeCheckpointKind(rule.kind) ? { ...rule, kind: "product_approval" as const } : rule,
    ])),
  };
}

function policyValidationIssues(policy: CheckpointPolicy): string[] {
  const result = validateTypedControlPlane({ checkpoint_policy: policyForTypedControlPlane(policy) });
  const issues = result.ok ? [] : result.issues
    .filter((issue) => !(policy.source === "migration" && issue.path.endsWith(".allowed_decisions") && issue.message.includes("must not be empty")))
    .map((issue) => issue.path + " " + issue.message);

  for (const [checkpointId, rule] of Object.entries(policy.rules)) {
    const kind = nativeCheckpointKind(rule.kind) ?? nativeCheckpointKind(checkpointId);
    if (!kind) continue;
    if (nativeCheckpointKind(rule.kind) && checkpointId !== kind) {
      issues.push("checkpoint_policy.rules." + checkpointId + ".kind must match checkpoint id '" + kind + "'");
      continue;
    }
    const expected = NATIVE_CHECKPOINT_DECISIONS[kind];
    if (!exactDecisionSet(rule.allowed_decisions, expected)) {
      issues.push("checkpoint_policy.rules." + checkpointId + ".allowed_decisions must be exactly " + expected.join(" | "));
    }
    if (policy.default !== "required_human" || rule.default !== "required_human") {
      issues.push("checkpoint_policy.rules." + checkpointId + " must be required_human at policy and rule level");
    }
    if (rule.phase !== "before_advance") {
      issues.push("checkpoint_policy.rules." + checkpointId + ".phase must be before_advance");
    }
    if (!isFloorRule(policy, rule, checkpointId)) {
      issues.push("checkpoint_policy.rules." + checkpointId + " must be hard-human");
    }
  }
  return issues;
}

/**
 * Resolve legacy values only at the migration boundary. The resulting policy
 * still needs an explicit typed decision before advance.
 */
function legacyAutonomous(state: TeamState): boolean | undefined {
  if (typeof state.classification?.autonomous === "boolean") return state.classification.autonomous;
  return typeof state.autonomous === "boolean" ? state.autonomous : undefined;
}

function applyLegacyMigrationPolicy(state: TeamState, policy: CheckpointPolicy, checkpoint: string): CheckpointPolicy {
  if (policy.source !== "migration" || legacyAutonomous(state) !== true) return policy;
  const rule = policy.rules[checkpoint];
  if (!rule || HARD_HUMAN_FLOOR[rule.kind] === true || policy.hard_human.includes(rule.kind)) return policy;
  return {
    ...policy,
    default: "autonomous_allowed",
    rules: {
      ...policy.rules,
      [checkpoint]: { ...rule, default: "autonomous_allowed" },
    },
  };
}

/**
 * Resolve policy in the same precedence used by the typed workflow contract.
 * A declared legacy checkpoint gets a conservative migration policy; absence
 * of a checkpoint is not an approval requirement and does not imply consent.
 */
export function nativeCheckpointPolicy(kind: NativeCheckpointRuleKind): CheckpointPolicy {
  return {
    default: "required_human",
    scope: "decision",
    hard_human: [kind],
    rules: {
      [kind]: {
        kind,
        default: "required_human",
        allowed_decisions: [...NATIVE_CHECKPOINT_DECISIONS[kind]],
        phase: "before_advance",
        rationale: kind === "constitution_approval"
          ? "Constitution bootstrap decisions require a trusted human answer."
          : "Specification phase decisions require a trusted human answer.",
      },
    },
    source: "profile",
    policy_version: 1,
    rationale: "Native specification checkpoints are hard-human and decision-bound.",
  };
}

export function resolveCheckpointPolicy(
  stage: StageCheckpointRef,
  state: TeamState,
): CheckpointPolicy | null {
  if (!stage.checkpoint) return null;
  const nativeKind = nativeCheckpointKind(stage.checkpoint);
  const policy = state.checkpoint_policy
    ?? stage.checkpoint_policy
    ?? (nativeKind ? nativeCheckpointPolicy(nativeKind) : migrationCheckpointPolicy(stage.checkpoint));
  return applyLegacyMigrationPolicy(state, policy, stage.checkpoint);
}

function isFloorRule(policy: CheckpointPolicy, rule: CheckpointRule, checkpointId?: string): boolean {
  return (checkpointId !== undefined && nativeCheckpointKind(checkpointId) !== null)
    || HARD_HUMAN_FLOOR[rule.kind] === true
    || policy.hard_human.includes(rule.kind);
}

function expectedRunId(state: TeamState): string {
  return state.work_identity?.run_id ?? state.run_key ?? state.branch;
}

function capabilityBinding(state: TeamState): { id: string; epoch: string } | null {
  const capability = state.dispatch_capability;
  const id = capability?.capability_id;
  const epoch = capability?.issued_for?.cursor_epoch ?? state.cursor_epoch;
  return nonEmpty(id) && nonEmpty(epoch) ? { id, epoch } : null;
}

export interface TrustedCheckpointAnswerContext {
  actor: CheckpointActor;
  run_id: string;
  stage_id: string;
  checkpoint_id: string;
  decision: string;
  capability_id?: string;
  capability_epoch?: string;
  policy_hash?: string;
  /** Explicit specification identity; omitted for non-specification checkpoints. */
  feature_id?: string;
  loop_iteration?: number;
  subject_binding?: string;
  /** Exact state/artifact revision captured when the trusted answer was minted. */
  subject_revision?: number;
  /** Historical idempotent replay validates the immutable record, not the moved cursor. */
  bind_active_context?: boolean;
  /** Require a checkpoint-specific hard-human rule (constitution/bootstrap use). */
  require_hard_human?: boolean;
  /** Exact decision rationale bound to a request_changes trusted answer. */
  feedback?: string;
  /** Root identity captured by the trusted host Ask, when available. */
  root_identity?: TrustedCheckpointRootIdentity;
  /** Host session identity captured by the trusted host Ask, when available. */
  session_id?: string;
}

/**
 * Canonical verification for an engine-issued human answer. Callers outside
 * the normal typed checkpoint transition (for example the project
 * constitution prerequisite) must use this verifier rather than interpreting
 * proof strings themselves.
 */
export function trustedCheckpointAnswerError(
  state: TeamState,
  context: TrustedCheckpointAnswerContext,
): string | null {
  sweepTrustedCheckpointAnswerAuthorities(state);
  if (context.actor.kind !== "user") return "human checkpoint authorization requires a user actor";
  const proof = context.actor.proof;
  if (!proof) return "human checkpoint authorization requires a durable terminal/escalation answer proof";
  if (!nonEmpty(context.actor.ref) || proof.reference !== context.actor.ref) {
    return "human checkpoint authorization answer reference does not match actor provenance";
  }
  if (context.feature_id !== undefined && state.specification && state.specification.feature_id !== context.feature_id) {
    return "human checkpoint authorization feature identity does not match the selected workspace";
  }
  if (expectedRunId(state) !== context.run_id) {
    return "human checkpoint authorization run identity does not match the selected workspace";
  }
  const answer = (state.trusted_checkpoint_answers ?? []).find((record) => record.answer_id === proof.answer_id);
  if (!answer) return "human checkpoint authorization answer identity is not present in the durable answer ledger";
  const authority = trustedCheckpointAnswerAuthorities.get(answer.answer_id);
  if (!authority) {
    if (!answer.consumed_at) return "human checkpoint authorization recovery_required: trusted host answer authority is unavailable after process restart; repeat the host Ask";
    // A consumed answer is already durable and cannot authorize a new
    // transition. Permit only the exact immutable replay from its canonical
    // ledger record after the one-time runtime authority has been retired.
    if (answer.reference !== context.actor.ref || answer.run_id !== context.run_id
      || answer.stage_id !== context.stage_id || answer.checkpoint_id !== context.checkpoint_id
      || answer.decision !== context.decision || answer.nonce !== proof.nonce
      || answer.answer_id !== proof.answer_id || answer.channel !== proof.channel
      || answer.reference !== proof.reference || answer.feedback !== proof.feedback
      || answer.binding !== proof.binding || answer.binding !== checkpointAnswerBinding(answer)
      || (context.capability_id !== undefined && answer.capability_id !== context.capability_id)
      || (context.capability_epoch !== undefined && answer.capability_epoch !== context.capability_epoch)
      || (context.policy_hash !== undefined && answer.policy_hash !== context.policy_hash)
      || (context.feature_id !== undefined && answer.feature_id !== context.feature_id)
      || (context.loop_iteration !== undefined && answer.loop_iteration !== context.loop_iteration)
      || (context.subject_binding !== undefined && answer.subject_binding !== context.subject_binding)
      || (context.subject_revision !== undefined && answer.subject_revision !== context.subject_revision)
      || (context.decision === "request_changes" && answer.feedback !== context.feedback)
      || (context.decision !== "request_changes" && answer.feedback !== undefined)) {
      return "human checkpoint authorization answer authority is stale or mismatched";
    }
    return null;
  }
  if (context.root_identity && !sameRootIdentity(context.root_identity, authority.root)) {
    return "human checkpoint authorization answer root identity does not match the trusted host Ask";
  }
  if (context.session_id !== undefined && context.session_id !== authority.session_id) {
    return "human checkpoint authorization answer host session does not match the trusted host Ask";
  }
  if (authority.actor_ref !== context.actor.ref || authority.run_id !== context.run_id || authority.stage_id !== context.stage_id
    || authority.checkpoint_id !== context.checkpoint_id || authority.decision !== context.decision
    || (context.feature_id !== undefined && authority.feature_id !== context.feature_id)
    || (context.loop_iteration !== undefined && authority.loop_iteration !== context.loop_iteration)
    || (context.subject_binding !== undefined && authority.subject_binding !== context.subject_binding)
    || (context.subject_revision !== undefined && authority.subject_revision !== context.subject_revision)
    || (context.feedback !== undefined && authority.feedback !== context.feedback)
    || authority.nonce !== answer.nonce
    || authority.authority_receipt !== answer.authority_receipt) {
    return "human checkpoint authorization answer authority is stale or mismatched";
  }
  if (
    answer.answer_id !== proof.answer_id
    || answer.nonce !== proof.nonce
    || answer.channel !== proof.channel
    || answer.reference !== proof.reference
    || answer.feedback !== proof.feedback
    || (context.decision === "request_changes" && answer.feedback !== context.feedback)
    || (context.decision !== "request_changes" && answer.feedback !== undefined)
    || answer.run_id !== context.run_id
    || answer.stage_id !== context.stage_id
    || answer.checkpoint_id !== context.checkpoint_id
    || answer.decision !== context.decision
    || (context.capability_id !== undefined && answer.capability_id !== context.capability_id)
    || (context.capability_epoch !== undefined && answer.capability_epoch !== context.capability_epoch)
    || (context.policy_hash !== undefined && answer.policy_hash !== context.policy_hash)
    || (context.feature_id !== undefined && answer.feature_id !== context.feature_id)
    || (context.loop_iteration !== undefined && answer.loop_iteration !== context.loop_iteration)
    || (context.subject_binding !== undefined && answer.subject_binding !== context.subject_binding)
    || (context.subject_revision !== undefined && answer.subject_revision !== context.subject_revision)
  ) {
    return "human checkpoint authorization answer binding is stale or mismatched";
  }
  if (answer.binding !== checkpointAnswerBinding(answer) || proof.binding !== answer.binding) {
    return "human checkpoint authorization answer binding digest is invalid";
  }
  if (context.bind_active_context !== false) {
    const binding = capabilityBinding(state);
    const capabilityStage = state.dispatch_capability?.issued_for?.stage_cursor;
    const policy = state.checkpoint_policy;
    if (!binding || !policy) return "human checkpoint authorization active context is unavailable";
    const mappingExecutionCheckpoint = context.checkpoint_id.startsWith("cto-specification-mapping-");
    const stageMatches = state.stage_cursor === context.stage_id
      || (mappingExecutionCheckpoint && capabilityStage === context.stage_id);
    if (!stageMatches || capabilityStage !== context.stage_id) {
      return "human checkpoint authorization stage identity does not match the active capability";
    }
    if (context.require_hard_human) {
      const rule = policy.rules[context.checkpoint_id];
      if (!rule || !isFloorRule(policy, rule, context.checkpoint_id)
        || policy.default !== "required_human" || rule.default !== "required_human"
        || !rule.allowed_decisions.includes(context.decision)) {
        return "human checkpoint authorization is not bound to a hard-human checkpoint policy";
      }
    }
    if (
      answer.capability_id !== binding.id
      || answer.capability_epoch !== binding.epoch
      || answer.policy_hash !== checkpointPolicyHash(policy)
      || answer.work_identity_hash !== checkpointWorkIdentityHash(state, context.stage_id)
    ) {
      return "human checkpoint authorization answer binding is stale or mismatched";
    }
  }
  if (answer.consumed_at) retireTrustedCheckpointAnswerAuthority(answer.answer_id);
  return null;
}

function markTrustedAnswerConsumed(state: TeamState, answerId: string): TeamState {
  if (!state.trusted_checkpoint_answers) return state;
  const index = state.trusted_checkpoint_answers.findIndex((answer) => answer.answer_id === answerId);
  if (index < 0 || state.trusted_checkpoint_answers[index]?.consumed_at) return state;
  const answers = [...state.trusted_checkpoint_answers];
  answers[index] = { ...answers[index]!, consumed_at: new Date().toISOString() };
  return { ...state, trusted_checkpoint_answers: answers };
}

/** Validate and idempotently consume one immutable trusted answer record. */
export function consumeTrustedCheckpointAnswer(
  state: TeamState,
  context: TrustedCheckpointAnswerContext,
): TeamState {
  const error = trustedCheckpointAnswerError(state, context);
  if (error) throw new Error("checkpoint_unverified: " + error);
  return markTrustedAnswerConsumed(state, context.actor.proof!.answer_id);
}

function trustedHumanAnswerError(
  state: TeamState,
  candidate: TypedCheckpointDecision,
  stage: StageCheckpointRef,
  bindActiveContext: boolean,
): string | null {
  return trustedCheckpointAnswerError(state, {
    actor: candidate.actor,
    run_id: candidate.run_id,
    stage_id: stage.id,
    checkpoint_id: candidate.checkpoint_id,
    decision: candidate.decision,
    capability_id: candidate.capability_id,
    capability_epoch: candidate.capability_epoch,
    policy_hash: candidate.policy_hash,
    feature_id: candidate.feature_id,
    loop_iteration: candidate.loop_iteration,
    subject_binding: candidate.subject_binding,
    bind_active_context: bindActiveContext,
    feedback: candidate.decision === "request_changes" ? candidate.rationale : undefined,
  });
}

function fail(
  code: CheckpointValidationCode,
  error: string,
  pauseKind?: "user_checkpoint" | "needs_human",
): CheckpointValidationFailure {
  return { ok: false, code, error, pauseKind };
}

function legacyDecision(decision: CheckpointDecision): boolean {
  return !("checkpoint_id" in decision) && !("authorization" in decision) && !("actor_provenance" in decision);
}

function typedInput(
  state: TeamState,
  decision: CheckpointDecision | TypedCheckpointDecision,
  policy: CheckpointPolicy,
  rule: CheckpointRule,
): { candidate: TypedCheckpointDecision; legacy: boolean } | CheckpointValidationFailure {
  const legacy = legacyDecision(decision as CheckpointDecision);
  if (
    !legacy &&
    "checkpoint_id" in decision &&
    "authorization" in decision &&
    "actor" in decision &&
    decision.actor !== null &&
    typeof decision.actor === "object" &&
    !Array.isArray(decision.actor)
  ) {
    return { candidate: decision as TypedCheckpointDecision, legacy: false };
  }

  const old = decision as CheckpointDecision;
  if (
    !nonEmpty(old.run_id ?? expectedRunId(state)) ||
    !nonEmpty(old.checkpoint_id ?? old.checkpoint) ||
    !nonEmpty(old.capability_id ?? capabilityBinding(state)?.id) ||
    !nonEmpty(old.capability_epoch ?? capabilityBinding(state)?.epoch) ||
    !nonEmpty(old.policy_hash ?? checkpointPolicyHash(policy)) ||
    !old.authorization ||
    old.actor_provenance === undefined ||
    old.actor_provenance === null ||
    typeof old.actor_provenance !== "object" ||
    Array.isArray(old.actor_provenance)
  ) {
    return fail(
      "checkpoint_unverified",
      "checkpoint decision lacks typed authorization, actor provenance, capability binding, or policy hash",
    );
  }

  const candidate: TypedCheckpointDecision = {
    run_id: old.run_id ?? expectedRunId(state),
    stage_id: old.stage_id,
    checkpoint_id: old.checkpoint_id ?? old.checkpoint,
    checkpoint_kind: old.checkpoint_kind ?? rule.kind,
    decision: old.decision,
    authorization: old.authorization,
    actor: old.actor_provenance,
    capability_id: old.capability_id ?? capabilityBinding(state)!.id,
    capability_epoch: old.capability_epoch ?? capabilityBinding(state)!.epoch,
    policy_hash: old.policy_hash ?? checkpointPolicyHash(policy),
    feature_id: old.feature_id,
    loop_iteration: old.loop_iteration,
    subject_binding: old.subject_binding,
    artifact_id: old.artifact_id,
    artifact_version: old.artifact_version,
    artifact_digest: old.artifact_digest,
    validation_ref: old.validation_ref,
    validation_digest: old.validation_digest,
    rationale: old.rationale,
    decided_at: old.decided_at,
  };
  return { candidate, legacy: true };
}

/**
 * Validate one policy-bound decision.  This is intentionally independent from
 * the caller surface: the native tool and `run()` both consume this result.
 */
export function validateCheckpointDecision(
  state: TeamState,
  decision: CheckpointDecision | TypedCheckpointDecision,
  options: CheckpointValidationOptions = {},
): CheckpointValidationResult {
  const inputError = checkpointInputError(decision);
  if (inputError) return fail("policy_invalid", inputError);
  const stageId = options.stage?.id ?? decision.stage_id;
  const checkpointId = options.stage?.checkpoint
    ?? ("checkpoint_id" in decision ? decision.checkpoint_id : decision.checkpoint);
  if (!nonEmpty(stageId) || !nonEmpty(checkpointId)) {
    return fail("policy_invalid", "checkpoint stage_id and checkpoint_id are required");
  }
  const stage: StageCheckpointRef = options.stage ?? { id: stageId, checkpoint: checkpointId };
  const policy = options.policy ?? resolveCheckpointPolicy(stage, state);
  if (!policy) return fail("policy_invalid", `checkpoint '${checkpointId}' has no policy`);
  const issues = policyValidationIssues(policy);
  if (issues.length > 0) return fail("policy_invalid", `checkpoint policy is invalid: ${issues.join("; ")}`);
  const rule = policy.rules[checkpointId];
  if (!rule) return fail("policy_invalid", `checkpoint policy has no rule for '${checkpointId}'`);
  if (stage.id !== decision.stage_id || checkpointId !== (("checkpoint_id" in decision) ? decision.checkpoint_id : decision.checkpoint)) {
    return fail("checkpoint_unverified", "checkpoint decision identity does not match the declaring stage");
  }

  const conflictAutonomous = legacyAutonomous(state);
  if (
    policy.source === "migration" &&
    typeof conflictAutonomous === "boolean" &&
    policy.default !== (conflictAutonomous ? "autonomous_allowed" : "required_human")
  ) {
    return fail(
      "migration_conflict",
      `typed checkpoint policy.default '${policy.default}' conflicts with legacy autonomy=${conflictAutonomous}`,
    );
  }

  const prepared = typedInput(state, decision, policy, rule);
  if ("ok" in prepared) return prepared;
  const candidate = prepared.candidate;
  const typedValidation = validateTypedControlPlane({
    typed_checkpoint_decisions: [nativeCheckpointKind(candidate.checkpoint_kind)
      ? { ...candidate, checkpoint_kind: "product_approval" }
      : candidate],
  });
  if (!typedValidation.ok) {
    return fail(
      "policy_invalid",
      `checkpoint decision is malformed: ${typedValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
    );
  }
  if (candidate.run_id !== expectedRunId(state)) {
    return fail("checkpoint_unverified", "checkpoint decision run identity does not match the active state");
  }
  if (candidate.stage_id !== stage.id || candidate.checkpoint_id !== checkpointId) {
    return fail("checkpoint_unverified", "checkpoint decision stage/checkpoint binding does not match the active stage");
  }
  if (candidate.checkpoint_kind !== rule.kind) {
    return fail("policy_invalid", `checkpoint kind '${candidate.checkpoint_kind}' does not match policy kind '${rule.kind}'`);
  }
  if (!rule.allowed_decisions.includes(candidate.decision)) {
    return fail(
      "policy_invalid",
      `decision '${candidate.decision}' is not allowed for checkpoint '${checkpointId}' (allowed: ${rule.allowed_decisions.join(" | ") || "none"})`,
    );
  }
  if (candidate.policy_hash !== checkpointPolicyHash(policy)) {
    return fail("checkpoint_unverified", "checkpoint decision policy_hash does not match the active policy");
  }
  const binding = capabilityBinding(state);
  const bindCapability = options.bindCapability !== false;
  if (bindCapability) {
    if (!binding) return fail("checkpoint_unverified", "checkpoint capability binding is unavailable");
    if (candidate.capability_id !== binding.id || candidate.capability_epoch !== binding.epoch) {
      return fail("checkpoint_unverified", "checkpoint decision capability_id/capability_epoch is stale or mismatched");
    }
  } else if (!nonEmpty(candidate.capability_id) || !nonEmpty(candidate.capability_epoch)) {
    return fail("checkpoint_unverified", "checkpoint decision capability binding is missing");
  }

  const floor = isFloorRule(policy, rule, checkpointId);
  if (floor && (rule.default === "autonomous_allowed" || policy.default === "autonomous_allowed")) {
    return fail("policy_invalid", `hard-human checkpoint '${checkpointId}' cannot permit autonomous authorization`, "needs_human");
  }
  if (candidate.authorization === "human") {
    const provenanceError = trustedHumanAnswerError(state, candidate, stage, bindCapability);
    if (provenanceError) {
      return fail("checkpoint_unverified", provenanceError, "needs_human");
    }
  } else if (candidate.authorization === "policy_auto") {
    if (floor) return fail("policy_invalid", `policy_auto is forbidden for hard-human checkpoint '${checkpointId}'`, "needs_human");
    if (rule.default !== "autonomous_allowed") {
      return fail("policy_invalid", `policy_auto is not explicitly permitted by checkpoint rule '${checkpointId}'`);
    }
    if (candidate.actor.kind === "user") {
      return fail("checkpoint_unverified", "policy_auto actor provenance must be orchestrator or system");
    }
  } else {
    return fail("policy_invalid", "checkpoint authorization is unknown");
  }

  const legacyRecord = decision as CheckpointDecision;
  if (prepared.legacy || ("actor" in decision && typeof legacyRecord.actor === "string")) {
    if (typeof legacyRecord.mode !== "string" || typeof legacyRecord.actor !== "string") {
      return fail("policy_invalid", "legacy checkpoint actor/mode fields are malformed");
    }
    const expectedMode = candidate.authorization === "human" ? "interactive" : "autonomous";
    if (legacyRecord.mode !== expectedMode) {
      return fail("checkpoint_unverified", `legacy checkpoint mode '${legacyRecord.mode}' conflicts with typed authorization '${candidate.authorization}'`);
    }
    const actorRef = legacyRecord.actor.trim();
    if (actorRef !== candidate.actor.ref && actorRef !== `${candidate.actor.kind}:${candidate.actor.ref}`) {
      return fail("checkpoint_unverified", "legacy actor spelling conflicts with typed actor provenance");
    }
  }
  return { ok: true, decision: candidate };
}

/**
 * Select the newest valid decision for a stage.
 *
 * Typed decisions and their schema-1 mirrors are both present in migrated
 * state. Validation runs newest-first by durable decision timestamp, while
 * stale decisions (for example, a superseded capability epoch) are skipped.
 * Two different valid decisions at the same timestamp are ambiguous and fail
 * closed; equivalent typed/mirror pairs are harmless duplicates.
 */
export function selectLatestValidCheckpointDecision(
  stage: StageCheckpointRef,
  state: TeamState,
  options: Pick<CheckpointValidationOptions, "bindCapability"> = {},
): CheckpointValidationResult {
  if (!stage.checkpoint) return { ok: true, decision: undefined as never };
  const policy = resolveCheckpointPolicy(stage, state);
  if (!policy) return fail("policy_invalid", `checkpoint '${stage.checkpoint}' has no policy`, "needs_human");
  const candidates: Array<CheckpointDecision | TypedCheckpointDecision> = [
    ...(state.typed_checkpoint_decisions ?? []),
    ...(state.checkpoint_decisions ?? []),
  ].filter((decision) => {
    const id = "checkpoint_id" in decision ? decision.checkpoint_id : decision.checkpoint;
    return decision.stage_id === stage.id && id === stage.checkpoint;
  });
  if (candidates.length === 0) {
    const rule = policy.rules[stage.checkpoint];
    if (!rule) return fail("policy_invalid", `checkpoint policy has no rule for '${stage.checkpoint}'`, "needs_human");
    const floor = isFloorRule(policy, rule, stage.checkpoint);
    return fail(
      "checkpoint_unresolved",
      `checkpoint '${stage.checkpoint}' for stage '${stage.id}' is unresolved: explicit human consent is required before advancing`,
      floor ? "needs_human" : "user_checkpoint",
    );
  }

  const valid: Array<{ decision: TypedCheckpointDecision; index: number }> = [];
  let latestFailure: CheckpointValidationFailure | undefined;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const result = validateCheckpointDecision(state, candidates[index]!, {
      stage,
      policy,
      bindCapability: options.bindCapability,
    });
    if (result.ok) valid.push({ decision: result.decision, index });
    else if (!latestFailure) latestFailure = result;
  }
  if (valid.length === 0) {
    return latestFailure ?? fail("checkpoint_unresolved", `checkpoint '${stage.checkpoint}' for stage '${stage.id}' is unresolved`, "user_checkpoint");
  }

  const timestamp = valid.reduce((latest, candidate) =>
    candidate.decision.decided_at > latest ? candidate.decision.decided_at : latest, valid[0]!.decision.decided_at);
  const newest = valid.filter((candidate) => candidate.decision.decided_at === timestamp);
  const decisions = new Set(newest.map((candidate) => candidate.decision.decision));
  if (decisions.size > 1) {
    return fail(
      "checkpoint_unverified",
      `checkpoint '${stage.checkpoint}' for stage '${stage.id}' has conflicting valid decisions at '${timestamp}'`,
      "needs_human",
    );
  }
  newest.sort((left, right) => right.index - left.index);
  return { ok: true, decision: newest[0]!.decision };
}
/**
 * Resolve the only state transition effects a validated checkpoint decision
 * may have. Callers must branch on this result rather than treating every
 * approved decision as permission to continue.
 */
export type CheckpointDecisionEffect = "continue" | "stop" | "revise";

export function checkpointDecisionEffect(
  decision: Pick<TypedCheckpointDecision, "decision">,
): CheckpointDecisionEffect {
  if (decision.decision === "approve_continue" || decision.decision === "proceed") return "continue";
  if (decision.decision === "approve_stop") return "stop";
  return "revise";
}


/** Validate the current stage's decision, including the resumable missing-answer state. */
export function validateCheckpointForAdvance(
  stage: StageCheckpointRef,
  state: TeamState,
): CheckpointValidationResult {
  return selectLatestValidCheckpointDecision(stage, state, { bindCapability: true });
}

function toLegacyDecision(decision: TypedCheckpointDecision): CheckpointDecision {
  return {
    stage_id: decision.stage_id,
    checkpoint: decision.checkpoint_id,
    mode: decision.authorization === "human" ? "interactive" : "autonomous",
    decision: decision.decision,
    actor: `${decision.actor.kind}:${decision.actor.ref}`,
    rationale: decision.rationale,
    decided_at: decision.decided_at,
    run_id: decision.run_id,
    checkpoint_id: decision.checkpoint_id,
    checkpoint_kind: decision.checkpoint_kind,
    authorization: decision.authorization,
    actor_provenance: decision.actor,
    capability_id: decision.capability_id,
    capability_epoch: decision.capability_epoch,
    policy_hash: decision.policy_hash,
    feature_id: decision.feature_id,
    loop_iteration: decision.loop_iteration,
    subject_binding: decision.subject_binding,
    artifact_id: decision.artifact_id,
    artifact_version: decision.artifact_version,
    artifact_digest: decision.artifact_digest,
    validation_ref: decision.validation_ref,
    validation_digest: decision.validation_digest,
  };
}

export function findCheckpointDecision(
  state: TeamState,
  stageId: string,
  checkpoint: string,
): CheckpointDecision | null {
  const stage: StageCheckpointRef = { id: stageId, checkpoint };
  const currentStage = state.dispatch_capability?.issued_for?.stage_cursor === stageId;
  const selected = selectLatestValidCheckpointDecision(stage, state, { bindCapability: currentStage });
  return selected.ok ? toLegacyDecision(selected.decision) : null;
}

export function hasCheckpointDecision(state: TeamState, stageId: string, checkpoint: string): boolean {
  return findCheckpointDecision(state, stageId, checkpoint) !== null;
}

function consumeTrustedAnswer(state: TeamState, decision: TypedCheckpointDecision): TeamState {
  const answerId = decision.actor.proof?.answer_id;
  return answerId ? markTrustedAnswerConsumed(state, answerId) : state;
}

/**
 * Idempotent append of a validated typed decision.  The schema-1 mirror is
 * retained for readers during migration, but an untyped legacy record cannot
 * authorize a checkpoint. A human answer is marked consumed without deleting
 * it, so the exact same decision can be replayed safely.
 */
export function appendCheckpointDecision(
  state: TeamState,
  decision: CheckpointDecision | TypedCheckpointDecision,
): TeamState {
  const stage: StageCheckpointRef = {
    id: decision.stage_id,
    checkpoint: "checkpoint_id" in decision ? decision.checkpoint_id : decision.checkpoint,
  };
  const policy = resolveCheckpointPolicy(stage, state);
  const result = validateCheckpointDecision(state, decision, { stage, policy: policy ?? undefined });
  if (!result.ok) {
    const error = new Error(`${result.code}: ${result.error}`);
    error.name = "CheckpointValidationError";
    throw error;
  }
  const typed = result.decision;
  const existingTyped = state.typed_checkpoint_decisions ?? [];
  const sameCapability = (candidate: TypedCheckpointDecision): boolean =>
    candidate.run_id === typed.run_id
      && candidate.stage_id === typed.stage_id
      && candidate.checkpoint_id === typed.checkpoint_id
      && candidate.capability_id === typed.capability_id
      && candidate.capability_epoch === typed.capability_epoch;
  const subjectIdentity = checkpointSubjectIdentity(typed);
  const sameSubject = existingTyped.filter((candidate) => sameCapability(candidate) && checkpointSubjectIdentity(candidate) === subjectIdentity);
  const existingForSubject = sameSubject.at(-1);
  if (existingForSubject) {
    if (JSON.stringify(canonicalize(existingForSubject)) !== JSON.stringify(canonicalize(typed))) {
      throw new Error("migration_conflict: conflicting checkpoint decision already exists for the current subject");
    }
    return consumeTrustedAnswer(state, typed);
  }
  const existingLegacy = state.checkpoint_decisions ?? [];
  const mirror = "checkpoint_id" in decision ? toLegacyDecision(typed) : { ...decision, ...toLegacyDecision(typed) };
  const next: TeamState = {
    ...state,
    typed_checkpoint_decisions: [...existingTyped, typed],
    checkpoint_decisions: [
      ...existingLegacy.filter((candidate) => !(candidate.stage_id === mirror.stage_id && candidate.checkpoint === mirror.checkpoint)),
      mirror,
    ],
  };
  return consumeTrustedAnswer(next, typed);
}
/**
 * Advance-blocking check. The returned text includes the durable pause kind
 * so adapters can persist `user_checkpoint`/`needs_human` instead of treating
 * missing consent as a generic failure.
 */
export function unresolvedCheckpointError(stage: StageDef, state: TeamState): string | null {
  if (!stage.checkpoint) return null;
  const result = validateCheckpointForAdvance(stage, state);
  if (result.ok) return null;
  const pauseKind = result.pauseKind ?? (result.code === "checkpoint_unresolved" ? "user_checkpoint" : "needs_human");
  state.pause = { kind: pauseKind, reason: result.error };
  state.updated_at = new Date().toISOString();
  return `${result.code} [${pauseKind}]: ${result.error}`;
}
