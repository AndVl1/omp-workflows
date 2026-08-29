/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */
/**
 * Durable checkpoint decisions.
 *
 * Checkpoint labels and legacy autonomy prose are migration/display inputs.
 * Permission is granted only by a policy-bound typed decision. Both native
 * checkpoint tools (through `appendCheckpointDecision`) and the interpreter
 * (`validateCheckpointForAdvance`) use the same validator below.
 */

import { createHash, randomBytes } from "node:crypto";
import { createDiagnostic } from "../workflow-v2/diagnostics.js";
import { validateProjectIdentity, validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import type { ProjectIdentity, WorkflowRunIdentity, WorkflowV2Diagnostic } from "../workflow-v2/types.js";
import { migrationCheckpointPolicy, validateTypedControlPlane } from "./workflow-contract.js";
import type {
  CheckpointActor,
  CheckpointAnswerChannel,
  CheckpointAnswerProof,
  CheckpointAuthorization,
  CheckpointDecision,
  CheckpointPolicy,
  CheckpointRule,
  CheckpointRuleKind,
  StageDef,
  TeamState,
  TrustedCheckpointAnswer,
  TypedCheckpointDecision,
  WorkIdentity,
} from "./types.js";

const HARD_HUMAN_FLOOR: Record<string, true> = {
  product_approval: true,
  security: true,
  destructive_side_effect: true,
  production: true,
  bundle_activation: true,
  migration_cutover: true,
};

const CHECKPOINT_RULE_KINDS: readonly CheckpointRuleKind[] = [
  "product_approval",
  "clarification",
  "architecture_choice",
  "implementation_approval",
  "review_fix",
  "regression_plan",
  "integration_acceptance",
  "security",
  "destructive_side_effect",
  "production",
  "bundle_activation",
  "migration_cutover",
  "custom",
];

const CHECKPOINT_DECISION_KEYS: readonly string[] = [
  "stage_id",
  "checkpoint",
  "mode",
  "decision",
  "actor",
  "rationale",
  "decided_at",
  "run_id",
  "checkpoint_id",
  "checkpoint_kind",
  "authorization",
  "actor_provenance",
  "capability_id",
  "capability_epoch",
  "policy_hash",
  "run_identity",
  "work_identity",
];

const TYPED_CHECKPOINT_DECISION_KEYS: readonly string[] = [
  "run_id",
  "stage_id",
  "checkpoint_id",
  "checkpoint_kind",
  "decision",
  "authorization",
  "actor",
  "capability_id",
  "capability_epoch",
  "policy_hash",
  "rationale",
  "decided_at",
  "run_identity",
];

const CHECKPOINT_ACTOR_KEYS: readonly string[] = ["kind", "ref", "proof"];
const CHECKPOINT_ANSWER_PROOF_KEYS: readonly string[] = [
  "answer_id",
  "nonce",
  "channel",
  "reference",
  "binding",
];
const TRUSTED_CHECKPOINT_ANSWER_KEYS: readonly string[] = [
  "answer_id",
  "nonce",
  "channel",
  "reference",
  "run_id",
  "stage_id",
  "checkpoint_id",
  "work_identity_hash",
  "capability_id",
  "capability_epoch",
  "policy_hash",
  "decision",
  "binding",
  "issued_at",
  "consumed_at",
];

type StageCheckpointRef = Pick<StageDef, "id" | "checkpoint" | "checkpoint_policy">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).every((key) => expected.includes(key));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => nonEmpty(entry));
}

function isCheckpointRuleKind(value: unknown): value is CheckpointRuleKind {
  return CHECKPOINT_RULE_KINDS.some((candidate) => candidate === value);
}

function isCheckpointAuthorization(value: unknown): value is CheckpointAuthorization {
  return value === "human" || value === "policy_auto";
}

function isCheckpointRule(value: unknown): value is CheckpointRule {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "default", "allowed_decisions", "phase", "rationale"])) return false;
  return isCheckpointRuleKind(value.kind)
    && (value.default === "required_human" || value.default === "autonomous_allowed")
    && isStringList(value.allowed_decisions)
    && (value.phase === "before_dispatch" || value.phase === "before_advance")
    && nonEmpty(value.rationale);
}

function isCheckpointPolicy(value: unknown): value is CheckpointPolicy {
  if (!isRecord(value) || !hasOnlyKeys(value, ["default", "scope", "hard_human", "rules", "source", "policy_version", "rationale"])) return false;
  if (value.default !== "required_human" && value.default !== "autonomous_allowed") return false;
  if (value.scope !== "decision") return false;
  if (!Array.isArray(value.hard_human) || !value.hard_human.every(isCheckpointRuleKind)) return false;
  if (!isRecord(value.rules)) return false;
  if (!Object.entries(value.rules).every(([checkpoint, rule]) => nonEmpty(checkpoint) && isCheckpointRule(rule))) return false;
  return (value.source === "profile" || value.source === "user" || value.source === "migration")
    && typeof value.policy_version === "number"
    && Number.isInteger(value.policy_version)
    && value.policy_version >= 1
    && nonEmpty(value.rationale);
}

function isWorkIdentity(value: unknown): value is WorkIdentity {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "run_id",
    "wave_id",
    "slice_id",
    "session_id",
    "workflow",
    "stage_id",
    "stage_cursor",
    "capability_id",
    "capability_epoch",
    "slot_id",
    "task_id",
    "dispatch_id",
    "attempt",
    "worker_id",
  ])) return false;
  for (const key of [
    "run_id",
    "wave_id",
    "slice_id",
    "session_id",
    "workflow",
    "stage_id",
    "stage_cursor",
    "capability_id",
    "capability_epoch",
    "slot_id",
    "task_id",
    "dispatch_id",
    "worker_id",
  ]) {
    if (!nonEmpty(value[key])) return false;
  }
  return typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt >= 1;
}

function isCheckpointAnswerProof(value: unknown): value is CheckpointAnswerProof {
  if (!isRecord(value) || !hasOnlyKeys(value, CHECKPOINT_ANSWER_PROOF_KEYS)) return false;
  return nonEmpty(value.answer_id)
    && nonEmpty(value.nonce)
    && (value.channel === "terminal" || value.channel === "escalation")
    && nonEmpty(value.reference)
    && nonEmpty(value.binding);
}

function isCheckpointActor(value: unknown): value is CheckpointActor {
  if (!isRecord(value) || !hasOnlyKeys(value, CHECKPOINT_ACTOR_KEYS) || !nonEmpty(value.ref)) return false;
  if (value.kind !== "user" && value.kind !== "orchestrator" && value.kind !== "system") return false;
  return value.proof === undefined || isCheckpointAnswerProof(value.proof);
}

function isTypedCheckpointDecision(value: unknown): value is TypedCheckpointDecision {
  if (!isRecord(value) || !hasOnlyKeys(value, TYPED_CHECKPOINT_DECISION_KEYS)) return false;
  if (
    !nonEmpty(value.run_id)
    || !nonEmpty(value.stage_id)
    || !nonEmpty(value.checkpoint_id)
    || !isCheckpointRuleKind(value.checkpoint_kind)
    || !nonEmpty(value.decision)
    || !isCheckpointAuthorization(value.authorization)
    || !isCheckpointActor(value.actor)
    || !nonEmpty(value.capability_id)
    || !nonEmpty(value.capability_epoch)
    || !nonEmpty(value.policy_hash)
    || !nonEmpty(value.rationale)
    || !nonEmpty(value.decided_at)
  ) return false;
  return validateWorkflowRunIdentity(value.run_identity).ok;
}

function isLegacyCheckpointDecision(value: unknown): value is CheckpointDecision {
  if (!isRecord(value) || !hasOnlyKeys(value, CHECKPOINT_DECISION_KEYS)) return false;
  if (
    !nonEmpty(value.stage_id)
    || !nonEmpty(value.checkpoint)
    || (value.mode !== "interactive" && value.mode !== "autonomous")
    || !nonEmpty(value.decision)
    || !nonEmpty(value.actor)
    || !nonEmpty(value.rationale)
    || !nonEmpty(value.decided_at)
    || !validateWorkflowRunIdentity(value.run_identity).ok
  ) return false;
  if (value.run_id !== undefined && !nonEmpty(value.run_id)) return false;
  if (value.checkpoint_id !== undefined && !nonEmpty(value.checkpoint_id)) return false;
  if (value.checkpoint_kind !== undefined && !isCheckpointRuleKind(value.checkpoint_kind)) return false;
  if (value.authorization !== undefined && !isCheckpointAuthorization(value.authorization)) return false;
  if (value.actor_provenance !== undefined && !isCheckpointActor(value.actor_provenance)) return false;
  if (value.capability_id !== undefined && !nonEmpty(value.capability_id)) return false;
  if (value.capability_epoch !== undefined && !nonEmpty(value.capability_epoch)) return false;
  if (value.policy_hash !== undefined && !nonEmpty(value.policy_hash)) return false;
  return value.work_identity === undefined || isWorkIdentity(value.work_identity);
}

function legacyDecision(value: unknown): value is CheckpointDecision {
  return isLegacyCheckpointDecision(value);
}

function stageIdOf(value: unknown): string | undefined {
  if (!isRecord(value) || !hasOwn(value, "stage_id") || !nonEmpty(value.stage_id)) return undefined;
  return value.stage_id;
}

function checkpointIdOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (hasOwn(value, "checkpoint_id")) return nonEmpty(value.checkpoint_id) ? value.checkpoint_id : undefined;
  if (hasOwn(value, "checkpoint")) return nonEmpty(value.checkpoint) ? value.checkpoint : undefined;
  return undefined;
}

function isStageCheckpointRef(value: unknown): value is StageCheckpointRef {
  if (!isRecord(value) || !nonEmpty(value.id)) return false;
  return value.checkpoint === undefined || nonEmpty(value.checkpoint);
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

type CheckpointIdentityCode = "MIGRATION_REQUIRED" | "IDENTITY_MISMATCH";

/** Typed checkpoint identity failures preserve the v2 diagnostic at throw boundaries. */
export class CheckpointIdentityError extends Error {
  readonly diagnostic: WorkflowV2Diagnostic;
  readonly checkpointCode: CheckpointIdentityCode;

  constructor(code: CheckpointIdentityCode, diagnostic: WorkflowV2Diagnostic) {
    super(`${diagnostic.code}: ${diagnostic.remediation}`);
    this.name = "CheckpointIdentityError";
    this.checkpointCode = code;
    this.diagnostic = diagnostic;
  }
}

function checkpointIdentityError(
  code: CheckpointIdentityCode,
  field: string,
  remediation: string,
): CheckpointIdentityError {
  return new CheckpointIdentityError(code, createDiagnostic({
    code,
    operation: "runtime.activate",
    evidence: { field },
    remediation,
  }));
}

function identityFailure(error: CheckpointIdentityError): CheckpointValidationFailure {
  return {
    ok: false,
    code: error.checkpointCode,
    error: error.message,
    diagnostic: error.diagnostic,
  };
}

function checkpointRunIdentity(state: TeamState): WorkflowRunIdentity | CheckpointIdentityError {
  const project = validateProjectIdentity(state.project_identity);
  if (!project.ok) {
    return checkpointIdentityError("MIGRATION_REQUIRED", "project_identity", "Checkpoint operations require a complete coherent project/run identity; migrate and re-admit the workflow before continuing.");
  }
  const run = validateWorkflowRunIdentity(state.run_identity);
  if (!run.ok) {
    return checkpointIdentityError("MIGRATION_REQUIRED", "run_identity", "Checkpoint operations require a complete coherent project/run identity; migrate and re-admit the workflow before continuing.");
  }
  if (!sameProjectIdentity(project.value, run.value)) {
    return checkpointIdentityError("IDENTITY_MISMATCH", "run_identity", "The persisted workflow run does not inherit the active project identity.");
  }
  return run.value;
}

function sameCheckpointWorkIdentity(left: WorkIdentity, right: WorkIdentity): boolean {
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

function checkpointWorkIdentity(state: TeamState): WorkIdentity | CheckpointIdentityError {
  const run = checkpointRunIdentity(state);
  if (run instanceof CheckpointIdentityError) return run;
  const identityValue: unknown = state.work_identity;
  if (!isWorkIdentity(identityValue)) {
    return checkpointIdentityError("MIGRATION_REQUIRED", "work_identity", "Checkpoint operations require a complete canonical v2 work identity; migrate and re-admit the workflow before continuing.");
  }
  const validation = validateTypedControlPlane({ work_identity: identityValue });
  if (!validation.ok) {
    return checkpointIdentityError("MIGRATION_REQUIRED", "work_identity", "The persisted checkpoint work identity is incomplete or malformed; migrate the workflow before continuing.");
  }
  if (identityValue.run_id !== run.run_id) {
    return checkpointIdentityError("IDENTITY_MISMATCH", "work_identity.run_id", "The persisted checkpoint work identity belongs to a different workflow run.");
  }
  if (identityValue.session_id !== run.session.session_id) {
    return checkpointIdentityError("IDENTITY_MISMATCH", "work_identity.session_id", "The persisted checkpoint work identity belongs to a different project session.");
  }
  if (state.dispatch_capability !== undefined) {
    const capability: unknown = state.dispatch_capability;
    if (!isRecord(capability) || !isWorkIdentity(capability.work_identity)) {
      return checkpointIdentityError("MIGRATION_REQUIRED", "dispatch_capability.work_identity", "Checkpoint operations require a complete capability-bound work identity; migrate and re-admit the workflow before continuing.");
    }
    const capabilityValidation = validateTypedControlPlane({ work_identity: capability.work_identity });
    if (!capabilityValidation.ok) {
      return checkpointIdentityError("MIGRATION_REQUIRED", "dispatch_capability.work_identity", "The persisted capability-bound checkpoint work identity is incomplete or malformed; migrate the workflow before continuing.");
    }
    if (!sameCheckpointWorkIdentity(identityValue, capability.work_identity)) {
      return checkpointIdentityError("IDENTITY_MISMATCH", "dispatch_capability.work_identity", "The dispatch capability work identity does not exactly match the persisted checkpoint work identity.");
    }
  }
  return identityValue;
}

function requireCheckpointRunIdentity(state: TeamState): WorkflowRunIdentity {
  const identity = checkpointRunIdentity(state);
  if (identity instanceof CheckpointIdentityError) throw identity;
  return identity;
}

function requireCheckpointWorkIdentity(state: TeamState): WorkIdentity {
  const identity = checkpointWorkIdentity(state);
  if (identity instanceof CheckpointIdentityError) throw identity;
  return identity;
}

function activeCapabilityStage(state: TeamState): string | undefined {
  const capability: unknown = state.dispatch_capability;
  if (!isRecord(capability) || !isRecord(capability.issued_for)) return undefined;
  return nonEmpty(capability.issued_for.stage_cursor) ? capability.issued_for.stage_cursor : undefined;
}

function capabilityBinding(state: TeamState): { id: string; epoch: string } | null {
  const capabilityValue: unknown = state.dispatch_capability;
  if (!isRecord(capabilityValue)) return null;
  if (
    !nonEmpty(capabilityValue.capability_id)
    || !nonEmpty(capabilityValue.dispatch_token_hash)
    || !nonEmpty(capabilityValue.advance_token_hash)
    || !nonEmpty(state.cursor_epoch)
  ) return null;
  if (
    hasOwn(capabilityValue, "run")
    || hasOwn(capabilityValue, "workflow")
    || hasOwn(capabilityValue, "profile_hash")
    || hasOwn(capabilityValue, "stage")
    || hasOwn(capabilityValue, "roles")
  ) return null;
  const issuedFor = capabilityValue.issued_for;
  if (!isRecord(issuedFor) || !nonEmpty(issuedFor.cursor_epoch) || issuedFor.cursor_epoch !== state.cursor_epoch) return null;
  const stateProject = validateProjectIdentity(state.project_identity);
  const stateRun = validateWorkflowRunIdentity(state.run_identity);
  const capabilityProject = validateProjectIdentity(capabilityValue.project_identity);
  const capabilityRun = validateWorkflowRunIdentity(capabilityValue.run_identity);
  const issuedProject = validateProjectIdentity(issuedFor.project_identity);
  const issuedRun = validateWorkflowRunIdentity(issuedFor.run_identity);
  if (!stateProject.ok || !stateRun.ok || !capabilityProject.ok || !capabilityRun.ok || !issuedProject.ok || !issuedRun.ok) return null;
  if (
    !sameProjectIdentity(stateProject.value, stateRun.value)
    || !sameProjectIdentity(stateProject.value, capabilityProject.value)
    || !sameRunIdentity(stateRun.value, capabilityRun.value)
    || !sameProjectIdentity(capabilityProject.value, issuedProject.value)
    || !sameRunIdentity(capabilityRun.value, issuedRun.value)
    || issuedFor.profile_hash !== issuedRun.value.profile_identity.fingerprint
    || issuedFor.stage_cursor !== state.stage_cursor
  ) return null;
  const capabilityContract = validateTypedControlPlane({ dispatch_capability: capabilityValue });
  if (!capabilityContract.ok) return null;
  return { id: capabilityValue.capability_id, epoch: issuedFor.cursor_epoch };
}

export type CheckpointValidationCode =
  | "policy_invalid"
  | "migration_conflict"
  | "checkpoint_unverified"
  | "checkpoint_unresolved"
  | "MIGRATION_REQUIRED"
  | "IDENTITY_MISMATCH";

export interface CheckpointValidationFailure {
  ok: false;
  code: CheckpointValidationCode;
  error: string;
  pauseKind?: "user_checkpoint" | "needs_human";
  diagnostic?: WorkflowV2Diagnostic;
}

function fail(
  code: CheckpointValidationCode,
  error: string,
  pauseKind?: "user_checkpoint" | "needs_human",
): CheckpointValidationFailure {
  const result: CheckpointValidationFailure = { ok: false, code, error };
  if (pauseKind !== undefined) result.pauseKind = pauseKind;
  return result;
}

export interface CheckpointValidationSuccess {
  ok: true;
  decision: TypedCheckpointDecision;
}

export type CheckpointValidationResult = CheckpointValidationSuccess | CheckpointValidationFailure;

export interface CheckpointAdvanceSuccess {
  ok: true;
  decision?: TypedCheckpointDecision;
}

export type CheckpointAdvanceResult = CheckpointAdvanceSuccess | CheckpointValidationFailure;

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
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
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
  issued_at?: string;
}

type AnswerBindingInput = Omit<TrustedCheckpointAnswer, "binding" | "consumed_at">;

/** Canonical digest that binds an answer to its complete decision context. */
export function checkpointAnswerBinding(answer: AnswerBindingInput): string {
  const payload = {
    answer_id: answer.answer_id,
    nonce: answer.nonce,
    channel: answer.channel,
    reference: answer.reference,
    run_id: answer.run_id,
    stage_id: answer.stage_id,
    checkpoint_id: answer.checkpoint_id,
    work_identity_hash: answer.work_identity_hash,
    capability_id: answer.capability_id,
    capability_epoch: answer.capability_epoch,
    policy_hash: answer.policy_hash,
    decision: answer.decision,
    issued_at: answer.issued_at,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex");
}

function checkpointWorkIdentityHash(identity: WorkIdentity): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(identity))).digest("hex");
}

function answerProof(answer: TrustedCheckpointAnswer): CheckpointAnswerProof {
  return {
    answer_id: answer.answer_id,
    nonce: answer.nonce,
    channel: answer.channel,
    reference: answer.reference,
    binding: answer.binding,
  };
}

function trustedCheckpointAnswers(state: TeamState): TrustedCheckpointAnswer[] | null {
  const raw: unknown = state.trusted_checkpoint_answers;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const answers: TrustedCheckpointAnswer[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!isTrustedCheckpointAnswer(entry) || ids.has(entry.answer_id)) return null;
    ids.add(entry.answer_id);
    answers.push(entry);
  }
  return answers;
}

function isTrustedCheckpointAnswer(value: unknown): value is TrustedCheckpointAnswer {
  if (!isRecord(value) || !hasOnlyKeys(value, TRUSTED_CHECKPOINT_ANSWER_KEYS)) return false;
  if (
    !nonEmpty(value.answer_id)
    || !nonEmpty(value.nonce)
    || (value.channel !== "terminal" && value.channel !== "escalation")
    || !nonEmpty(value.reference)
    || !nonEmpty(value.run_id)
    || !nonEmpty(value.stage_id)
    || !nonEmpty(value.checkpoint_id)
    || !nonEmpty(value.work_identity_hash)
    || !nonEmpty(value.capability_id)
    || !nonEmpty(value.capability_epoch)
    || !nonEmpty(value.policy_hash)
    || !nonEmpty(value.decision)
    || !nonEmpty(value.binding)
    || !nonEmpty(value.issued_at)
  ) return false;
  return value.consumed_at === undefined || nonEmpty(value.consumed_at);
}

/**
 * Record an answer at the trusted terminal/escalation ingest boundary.
 *
 * The public checkpoint tool receives only the returned proof. It cannot
 * choose the nonce or binding, and re-ingesting an answer id is idempotent
 * only when every durable context field is identical.
 */
export function recordTrustedCheckpointAnswer(
  state: TeamState,
  input: TrustedCheckpointAnswerInput,
): { state: TeamState; answer: TrustedCheckpointAnswer; proof: CheckpointAnswerProof } {
  if (
    !nonEmpty(input.answer_id)
    || !nonEmpty(input.reference)
    || !nonEmpty(input.stage_id)
    || !nonEmpty(input.checkpoint_id)
    || !nonEmpty(input.decision)
    || (input.channel !== "terminal" && input.channel !== "escalation")
    || (input.issued_at !== undefined && !nonEmpty(input.issued_at))
  ) {
    throw new Error("checkpoint_unverified: trusted answer identity is incomplete");
  }
  if (input.reference.trim().toLowerCase().startsWith("user:")) {
    throw new Error("checkpoint_unverified: user provenance references are not durable answer identities");
  }
  const identity = requireCheckpointWorkIdentity(state);
  const binding = capabilityBinding(state);
  if (!binding) throw new Error("checkpoint_unverified: checkpoint capability binding is unavailable");
  if (activeCapabilityStage(state) !== input.stage_id) {
    throw new Error("checkpoint_unverified: trusted answer stage does not match the active capability");
  }
  const policyValue: unknown = state.checkpoint_policy;
  if (!isCheckpointPolicy(policyValue)) throw new Error("checkpoint_unverified: checkpoint policy is unavailable or malformed");
  const policy = policyValue;
  const policyIssues = policyValidationIssues(policy);
  if (policyIssues.length > 0) throw new Error(`checkpoint_unverified: checkpoint policy is invalid: ${policyIssues.join("; ")}`);
  if (!policy.rules[input.checkpoint_id]) {
    throw new Error(`checkpoint_unverified: checkpoint policy has no rule for '${input.checkpoint_id}'`);
  }
  const policyHash = checkpointPolicyHash(policy);
  const runId = identity.run_id;
  const workIdentityHash = checkpointWorkIdentityHash(identity);
  const answers = trustedCheckpointAnswers(state);
  if (!answers) throw new Error("checkpoint_unverified: trusted answer ledger is malformed");
  const existing = answers.find((candidate) => candidate.answer_id === input.answer_id);
  if (existing) {
    const expected = checkpointAnswerBinding(existing);
    if (
      existing.binding !== expected
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
      || (input.issued_at !== undefined && existing.issued_at !== input.issued_at)
    ) {
      throw new Error("checkpoint_unverified: trusted answer replay conflicts with the active context");
    }
    return { state, answer: existing, proof: answerProof(existing) };
  }
  const issuedAt = input.issued_at === undefined ? new Date().toISOString() : input.issued_at;
  const unsignedAnswer: TrustedCheckpointAnswer = {
    answer_id: input.answer_id,
    nonce: randomBytes(32).toString("hex"),
    channel: input.channel,
    reference: input.reference,
    run_id: runId,
    stage_id: input.stage_id,
    checkpoint_id: input.checkpoint_id,
    work_identity_hash: workIdentityHash,
    capability_id: binding.id,
    capability_epoch: binding.epoch,
    policy_hash: policyHash,
    decision: input.decision,
    binding: "",
    issued_at: issuedAt,
  };
  const answer: TrustedCheckpointAnswer = {
    ...unsignedAnswer,
    binding: checkpointAnswerBinding(unsignedAnswer),
  };
  const next: TeamState = {
    ...state,
    trusted_checkpoint_answers: [...answers, answer],
  };
  return { state: next, answer, proof: answerProof(answer) };
}
function policyValidationIssues(policy: unknown): string[] {
  const result = validateTypedControlPlane({ checkpoint_policy: policy });
  if (result.ok) return [];
  const migration = isRecord(policy) && policy.source === "migration";
  // Migration policies intentionally leave decisions empty: that represents
  // unresolved legacy consent and never authorizes a decision.
  return result.issues
    .filter((issue) => !(migration && issue.path.endsWith(".allowed_decisions") && issue.message.includes("must not be empty")))
    .map((issue) => `${issue.path} ${issue.message}`);
}

/**
 * Resolve legacy values only at the migration boundary. The resulting policy
 * still needs an explicit typed decision before advance.
 */
function legacyAutonomous(state: TeamState): boolean | undefined {
  const classification: unknown = state.classification;
  if (isRecord(classification) && typeof classification.autonomous === "boolean") return classification.autonomous;
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
export function resolveCheckpointPolicy(
  stage: StageCheckpointRef,
  state: TeamState,
): CheckpointPolicy | null {
  if (!nonEmpty(stage.checkpoint)) return null;
  let policyValue: unknown;
  if (state.checkpoint_policy !== undefined) policyValue = state.checkpoint_policy;
  else if (stage.checkpoint_policy !== undefined) policyValue = stage.checkpoint_policy;
  else policyValue = migrationCheckpointPolicy(stage.checkpoint);
  if (!isCheckpointPolicy(policyValue)) return null;
  return applyLegacyMigrationPolicy(state, policyValue, stage.checkpoint);
}

function isFloorRule(policy: CheckpointPolicy, rule: CheckpointRule): boolean {
  return HARD_HUMAN_FLOOR[rule.kind] === true || policy.hard_human.includes(rule.kind);
}

function trustedHumanAnswerError(
  state: TeamState,
  candidate: TypedCheckpointDecision,
  stage: StageCheckpointRef,
  identity: WorkIdentity,
): string | null {
  if (candidate.actor.kind !== "user") return "human checkpoint authorization requires a user actor";
  const proof = candidate.actor.proof;
  if (!proof) return "human checkpoint authorization requires a durable terminal/escalation answer proof";
  if (proof.reference !== candidate.actor.ref) {
    return "human checkpoint authorization answer reference does not match actor provenance";
  }
  const answers = trustedCheckpointAnswers(state);
  if (!answers) return "human checkpoint authorization answer ledger is malformed";
  const answer = answers.find((record) => record.answer_id === proof.answer_id);
  if (!answer) return "human checkpoint authorization answer identity is not present in the durable answer ledger";
  if (
    answer.answer_id !== proof.answer_id
    || answer.nonce !== proof.nonce
    || answer.channel !== proof.channel
    || answer.reference !== proof.reference
    || answer.run_id !== candidate.run_id
    || answer.stage_id !== stage.id
    || answer.checkpoint_id !== candidate.checkpoint_id
    || answer.capability_id !== candidate.capability_id
    || answer.capability_epoch !== candidate.capability_epoch
    || answer.policy_hash !== candidate.policy_hash
    || answer.decision !== candidate.decision
    || answer.work_identity_hash !== checkpointWorkIdentityHash(identity)
  ) {
    return "human checkpoint authorization answer binding is stale or mismatched";
  }
  if (answer.binding !== checkpointAnswerBinding(answer) || proof.binding !== answer.binding) {
    return "human checkpoint authorization answer binding digest is invalid";
  }
  return null;
}

function typedInput(
  state: TeamState,
  runIdentity: WorkflowRunIdentity,
  identity: WorkIdentity,
  decision: CheckpointDecision | TypedCheckpointDecision,
  policy: CheckpointPolicy,
  rule: CheckpointRule,
): { candidate: TypedCheckpointDecision; legacy: boolean } | CheckpointValidationFailure {
  if (isTypedCheckpointDecision(decision)) return { candidate: decision, legacy: false };
  if (!legacyDecision(decision)) {
    return fail("checkpoint_unverified", "checkpoint decision is not a complete canonical typed or migration decision");
  }
  const runId = decision.run_id;
  const checkpointId = decision.checkpoint_id;
  const checkpointKind = decision.checkpoint_kind;
  const authorization = decision.authorization;
  const actor = decision.actor_provenance;
  const capabilityId = decision.capability_id;
  const capabilityEpoch = decision.capability_epoch;
  const policyHash = decision.policy_hash;
  if (
    !nonEmpty(runId)
    || !nonEmpty(checkpointId)
    || !isCheckpointRuleKind(checkpointKind)
    || !isCheckpointAuthorization(authorization)
    || !isCheckpointActor(actor)
    || !nonEmpty(capabilityId)
    || !nonEmpty(capabilityEpoch)
    || !nonEmpty(policyHash)
  ) {
    return fail("checkpoint_unverified", "checkpoint decision lacks typed authorization, actor provenance, capability binding, policy hash, or run identity");
  }
  const candidate: TypedCheckpointDecision = {
    run_id: runId,
    run_identity: decision.run_identity,
    stage_id: decision.stage_id,
    checkpoint_id: checkpointId,
    checkpoint_kind: checkpointKind,
    decision: decision.decision,
    authorization,
    actor,
    capability_id: capabilityId,
    capability_epoch: capabilityEpoch,
    policy_hash: policyHash,
    rationale: decision.rationale,
    decided_at: decision.decided_at,
  };
  return { candidate, legacy: true };
}

/**
 * Validate one policy-bound decision. This is intentionally independent from
 * the caller surface: the native tool and `run()` both consume this result.
 */
export function validateCheckpointDecision(
  state: TeamState,
  decision: CheckpointDecision | TypedCheckpointDecision,
  options: CheckpointValidationOptions = {},
): CheckpointValidationResult {
  const optionStageValue: unknown = options.stage;
  let optionStage: StageCheckpointRef | undefined;
  if (optionStageValue !== undefined) {
    if (!isStageCheckpointRef(optionStageValue)) {
      return fail("policy_invalid", "checkpoint declaring stage is malformed");
    }
    optionStage = optionStageValue;
  }
  const decisionStageId = stageIdOf(decision);
  const decisionCheckpointId = checkpointIdOf(decision);
  const stageId = optionStage?.id ?? decisionStageId;
  const checkpointId = optionStage?.checkpoint ?? decisionCheckpointId;
  if (!nonEmpty(stageId) || !nonEmpty(checkpointId)) {
    return fail("policy_invalid", "checkpoint stage_id and checkpoint_id are required");
  }
  const stage: StageCheckpointRef = optionStage ?? { id: stageId, checkpoint: checkpointId };
  let policyValue: unknown;
  if (options.policy !== undefined) policyValue = options.policy;
  else policyValue = resolveCheckpointPolicy(stage, state);
  if (policyValue === null || policyValue === undefined) {
    return fail("policy_invalid", `checkpoint '${checkpointId}' has no policy`);
  }
  const issues = policyValidationIssues(policyValue);
  if (issues.length > 0) return fail("policy_invalid", `checkpoint policy is invalid: ${issues.join("; ")}`);
  if (!isCheckpointPolicy(policyValue)) {
    return fail("policy_invalid", "checkpoint policy is malformed");
  }
  const policy = policyValue;
  const rule = policy.rules[checkpointId];
  if (!rule) return fail("policy_invalid", `checkpoint policy has no rule for '${checkpointId}'`);
  const runIdentity = checkpointRunIdentity(state);
  if (runIdentity instanceof CheckpointIdentityError) return identityFailure(runIdentity);
  const identity = checkpointWorkIdentity(state);
  if (identity instanceof CheckpointIdentityError) return identityFailure(identity);
  if (decisionStageId !== stage.id || decisionCheckpointId !== checkpointId) {
    return identityFailure(checkpointIdentityError(
      "IDENTITY_MISMATCH",
      "stage_id",
      "The checkpoint decision identity does not match the declaring stage in the active canonical work identity.",
    ));
  }

  const conflictAutonomous = legacyAutonomous(state);
  if (
    policy.source === "migration"
    && typeof conflictAutonomous === "boolean"
    && policy.default !== (conflictAutonomous ? "autonomous_allowed" : "required_human")
  ) {
    return fail(
      "migration_conflict",
      `typed checkpoint policy.default '${policy.default}' conflicts with legacy autonomy=${conflictAutonomous}`,
    );
  }

  const prepared = typedInput(state, runIdentity, identity, decision, policy, rule);
  if ("ok" in prepared) return prepared;
  const candidate = prepared.candidate;
  const { run_identity: _runIdentity, ...contractDecision } = candidate;
  const typedValidation = validateTypedControlPlane({ typed_checkpoint_decisions: [contractDecision] });
  if (!typedValidation.ok) {
    return fail(
      "policy_invalid",
      `checkpoint decision is malformed: ${typedValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
    );
  }
  if (!sameRunIdentity(candidate.run_identity, runIdentity) || candidate.run_id !== runIdentity.run_id) {
    return identityFailure(checkpointIdentityError(
      "IDENTITY_MISMATCH",
      "run_identity",
      "The checkpoint decision run identity does not match the active prepared workflow run.",
    ));
  }
  if (candidate.stage_id !== stage.id || candidate.checkpoint_id !== checkpointId) {
    return identityFailure(checkpointIdentityError(
      "IDENTITY_MISMATCH",
      "stage_id",
      "The checkpoint decision stage/checkpoint binding does not match the active stage identity.",
    ));
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

  const floor = isFloorRule(policy, rule);
  if (floor && (rule.default === "autonomous_allowed" || policy.default === "autonomous_allowed")) {
    return fail("policy_invalid", `hard-human checkpoint '${checkpointId}' cannot permit autonomous authorization`, "needs_human");
  }
  if (candidate.authorization === "human") {
    const provenanceError = trustedHumanAnswerError(state, candidate, stage, identity);
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

  if (prepared.legacy) {
    if (!legacyDecision(decision)) {
      return fail("checkpoint_unverified", "legacy checkpoint decision cannot be interpreted as typed authorization");
    }
    const expectedMode = candidate.authorization === "human" ? "interactive" : "autonomous";
    if (decision.mode !== expectedMode) {
      return fail("checkpoint_unverified", `legacy checkpoint mode '${decision.mode}' conflicts with typed authorization '${candidate.authorization}'`);
    }
    const actorRef = decision.actor.trim();
    if (actorRef !== candidate.actor.ref && actorRef !== `${candidate.actor.kind}:${candidate.actor.ref}`) {
      return fail("checkpoint_unverified", "legacy actor spelling conflicts with typed actor provenance");
    }
  }
  return { ok: true, decision: candidate };
}

interface CheckpointDecisionLedgers {
  typed: TypedCheckpointDecision[];
  legacy: CheckpointDecision[];
}

function checkpointDecisionLedgers(state: TeamState): CheckpointDecisionLedgers | null {
  const typedValue: unknown = state.typed_checkpoint_decisions;
  const legacyValue: unknown = state.checkpoint_decisions;
  if (typedValue !== undefined && !Array.isArray(typedValue)) return null;
  if (legacyValue !== undefined && !Array.isArray(legacyValue)) return null;
  const typed: TypedCheckpointDecision[] = [];
  const legacy: CheckpointDecision[] = [];
  for (const entry of typedValue ?? []) {
    if (!isTypedCheckpointDecision(entry)) return null;
    typed.push(entry);
  }
  for (const entry of legacyValue ?? []) {
    if (!legacyDecision(entry)) return null;
    legacy.push(entry);
  }
  return { typed, legacy };
}

/** Validate the current stage's decision, including the resumable missing-answer state. */
export function validateCheckpointForAdvance(
  stage: StageCheckpointRef,
  state: TeamState,
): CheckpointAdvanceResult {
  const stageValue: unknown = stage;
  if (!isStageCheckpointRef(stageValue)) {
    return fail("policy_invalid", "checkpoint declaring stage is malformed", "needs_human");
  }
  const stageRef = stageValue;
  if (!stageRef.checkpoint) return { ok: true, decision: undefined };
  const identityResult = checkpointWorkIdentity(state);
  if (identityResult instanceof CheckpointIdentityError) return identityFailure(identityResult);
  const policy = resolveCheckpointPolicy(stageRef, state);
  if (!policy) return fail("policy_invalid", `checkpoint '${stageRef.checkpoint}' has no policy`, "needs_human");
  const ledgers = checkpointDecisionLedgers(state);
  if (!ledgers) return fail("checkpoint_unverified", "persisted checkpoint decision ledger is malformed", "needs_human");
  const candidates: Array<CheckpointDecision | TypedCheckpointDecision> = [
    ...ledgers.typed,
    ...ledgers.legacy,
  ].filter((decision) => {
    const id = checkpointIdOf(decision);
    return decision.stage_id === stageRef.id && id === stageRef.checkpoint;
  });
  if (candidates.length === 0) {
    const rule = policy.rules[stageRef.checkpoint];
    if (!rule) return fail("policy_invalid", `checkpoint policy has no rule for '${stageRef.checkpoint}'`, "needs_human");
    const floor = isFloorRule(policy, rule);
    return fail(
      "checkpoint_unresolved",
      `checkpoint '${stageRef.checkpoint}' for stage '${stageRef.id}' is unresolved: explicit human consent is required before advancing`,
      floor ? "needs_human" : "user_checkpoint",
    );
  }
  for (const candidate of candidates) {
    const result = validateCheckpointDecision(state, candidate, { stage: stageRef, policy });
    if (result.ok) return result;
    return result;
  }
  return fail("checkpoint_unresolved", `checkpoint '${stageRef.checkpoint}' for stage '${stageRef.id}' is unresolved`, "user_checkpoint");
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
    run_identity: decision.run_identity,
    checkpoint_id: decision.checkpoint_id,
    checkpoint_kind: decision.checkpoint_kind,
    authorization: decision.authorization,
    actor_provenance: decision.actor,
    capability_id: decision.capability_id,
    capability_epoch: decision.capability_epoch,
    policy_hash: decision.policy_hash,
  };
}

export function findCheckpointDecision(
  state: TeamState,
  stageId: string,
  checkpoint: string,
): CheckpointDecision | null {
  requireCheckpointWorkIdentity(state);
  if (!nonEmpty(stageId) || !nonEmpty(checkpoint)) return null;
  const stage: StageCheckpointRef = { id: stageId, checkpoint };
  const ledgers = checkpointDecisionLedgers(state);
  if (!ledgers) return null;
  const currentStage = activeCapabilityStage(state) === stageId;
  for (const decision of ledgers.typed) {
    if (decision.stage_id !== stageId || decision.checkpoint_id !== checkpoint) continue;
    const result = validateCheckpointDecision(state, decision, { stage, bindCapability: currentStage });
    if (result.ok) return toLegacyDecision(result.decision);
    return null;
  }
  for (const decision of ledgers.legacy) {
    if (decision.stage_id !== stageId || decision.checkpoint !== checkpoint) continue;
    const result = validateCheckpointDecision(state, decision, { stage, bindCapability: currentStage });
    if (result.ok) return decision;
    return null;
  }
  return null;
}

export function hasCheckpointDecision(state: TeamState, stageId: string, checkpoint: string): boolean {
  return findCheckpointDecision(state, stageId, checkpoint) !== null;
}

function consumeTrustedAnswer(state: TeamState, decision: TypedCheckpointDecision): TeamState {
  const proof = decision.actor.proof;
  if (!proof) return state;
  const answers = trustedCheckpointAnswers(state);
  if (!answers) throw new Error("checkpoint_unverified: trusted answer ledger is malformed");
  const index = answers.findIndex((answer) => answer.answer_id === proof.answer_id);
  if (index < 0) return state;
  const answer = answers[index];
  if (!answer || answer.consumed_at) return state;
  const nextAnswers = [...answers];
  nextAnswers[index] = { ...answer, consumed_at: new Date().toISOString() };
  return { ...state, trusted_checkpoint_answers: nextAnswers };
}

/**
 * Idempotent append of a validated typed decision. The schema-1 mirror is
 * retained for readers during migration, but an untyped legacy record cannot
 * authorize a checkpoint. A human answer is marked consumed without deleting
 * it, so the exact same decision can be replayed safely.
 */
export function appendCheckpointDecision(
  state: TeamState,
  decision: CheckpointDecision | TypedCheckpointDecision,
): TeamState {
  const stageId = stageIdOf(decision);
  const checkpointId = checkpointIdOf(decision);
  if (!nonEmpty(stageId) || !nonEmpty(checkpointId)) {
    throw new Error("policy_invalid: checkpoint stage_id and checkpoint_id are required");
  }
  const stage: StageCheckpointRef = { id: stageId, checkpoint: checkpointId };
  const policy = resolveCheckpointPolicy(stage, state);
  const result = validateCheckpointDecision(state, decision, { stage, policy: policy ?? undefined });
  if (!result.ok) {
    if (result.code === "MIGRATION_REQUIRED" && result.diagnostic) {
      throw new CheckpointIdentityError(result.code, result.diagnostic);
    }
    if (result.code === "IDENTITY_MISMATCH" && result.diagnostic) {
      throw new CheckpointIdentityError(result.code, result.diagnostic);
    }
    const error = new Error(`${result.code}: ${result.error}`);
    error.name = "CheckpointValidationError";
    throw error;
  }
  const typed = result.decision;
  const ledgers = checkpointDecisionLedgers(state);
  if (!ledgers) throw new Error("checkpoint_unverified: persisted checkpoint decision ledger is malformed");
  const existingForCheckpoint = ledgers.typed.find(
    (candidate) => candidate.stage_id === typed.stage_id && candidate.checkpoint_id === typed.checkpoint_id,
  );
  if (existingForCheckpoint) {
    if (JSON.stringify(canonicalize(existingForCheckpoint)) !== JSON.stringify(canonicalize(typed))) {
      throw new Error("migration_conflict: conflicting checkpoint decision already exists");
    }
    return consumeTrustedAnswer(state, typed);
  }
  let mirror: CheckpointDecision;
  if (isTypedCheckpointDecision(decision)) {
    mirror = toLegacyDecision(typed);
  } else if (legacyDecision(decision)) {
    mirror = { ...decision, ...toLegacyDecision(typed) };
  } else {
    throw new Error("checkpoint_unverified: checkpoint decision shape changed during validation");
  }
  const next: TeamState = {
    ...state,
    typed_checkpoint_decisions: [...ledgers.typed, typed],
    checkpoint_decisions: [
      ...ledgers.legacy.filter((candidate) => !(candidate.stage_id === mirror.stage_id && candidate.checkpoint === mirror.checkpoint)),
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
  if (!nonEmpty(stage.checkpoint)) return null;
  const result = validateCheckpointForAdvance(stage, state);
  if (result.ok) return null;
  const pauseKind = result.pauseKind ?? (result.code === "checkpoint_unresolved" ? "user_checkpoint" : "needs_human");
  state.pause = { kind: pauseKind, reason: result.error };
  state.updated_at = new Date().toISOString();
  return `${result.code} [${pauseKind}]: ${result.error}`;
}
