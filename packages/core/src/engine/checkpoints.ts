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
  CheckpointAnswerChannel,
  CheckpointAnswerProof,
  CheckpointDecision,
  CheckpointPolicy,
  CheckpointRule,
  StageDef,
  TeamState,
  TrustedCheckpointAnswer,
  TypedCheckpointDecision,
} from "./types.js";

const HARD_HUMAN_FLOOR: Record<string, true> = {
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
  const { binding: _binding, consumed_at: _consumedAt, ...payload } = answer as TrustedCheckpointAnswer;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex");
}

function checkpointWorkIdentityHash(state: TeamState, stageId: string): string {
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
  };
}

/**
 * Record an answer at the trusted terminal/escalation ingest boundary.
 *
 * The public checkpoint tool receives only the returned proof.  It cannot
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
  ) {
    throw new Error("checkpoint_unverified: trusted answer identity is incomplete");
  }
  if (input.reference.trim().toLowerCase().startsWith("user:")) {
    throw new Error("checkpoint_unverified: user provenance references are not durable answer identities");
  }
  const binding = capabilityBinding(state);
  if (!binding) throw new Error("checkpoint_unverified: checkpoint capability binding is unavailable");
  const policy = state.checkpoint_policy;
  if (!policy) throw new Error("checkpoint_unverified: checkpoint policy is unavailable");
  const policyHash = checkpointPolicyHash(policy);
  const runId = expectedRunId(state);
  const workIdentityHash = checkpointWorkIdentityHash(state, input.stage_id);
  const existing = (state.trusted_checkpoint_answers ?? []).find((candidate) => candidate.answer_id === input.answer_id);
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
    ) {
      throw new Error("checkpoint_unverified: trusted answer replay conflicts with the active context");
    }
    return { state, answer: existing, proof: answerProof(existing) };
  }
  const answer: TrustedCheckpointAnswer = {
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
    issued_at: input.issued_at ?? new Date().toISOString(),
  };
  answer.binding = checkpointAnswerBinding(answer);
  const next: TeamState = {
    ...state,
    trusted_checkpoint_answers: [...(state.trusted_checkpoint_answers ?? []), answer],
  };
  return { state: next, answer, proof: answerProof(answer) };
}

function policyValidationIssues(policy: CheckpointPolicy): string[] {
  const result = validateTypedControlPlane({ checkpoint_policy: policy });
  if (result.ok) return [];
  // Migration policies intentionally leave decisions empty: that represents
  // unresolved legacy consent and never authorizes a decision.
  return result.issues
    .filter((issue) => !(policy.source === "migration" && issue.path.endsWith(".allowed_decisions") && issue.message.includes("must not be empty")))
    .map((issue) => `${issue.path} ${issue.message}`);
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
export function resolveCheckpointPolicy(
  stage: StageCheckpointRef,
  state: TeamState,
): CheckpointPolicy | null {
  if (!stage.checkpoint) return null;
  const policy = state.checkpoint_policy
    ?? stage.checkpoint_policy
    ?? migrationCheckpointPolicy(stage.checkpoint);
  return applyLegacyMigrationPolicy(state, policy, stage.checkpoint);
}

function isFloorRule(policy: CheckpointPolicy, rule: CheckpointRule): boolean {
  return HARD_HUMAN_FLOOR[rule.kind] === true || policy.hard_human.includes(rule.kind);
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

function trustedHumanAnswerError(
  state: TeamState,
  candidate: TypedCheckpointDecision,
  stage: StageCheckpointRef,
): string | null {
  if (candidate.actor.kind !== "user") return "human checkpoint authorization requires a user actor";
  const proof = candidate.actor.proof;
  if (!proof) return "human checkpoint authorization requires a durable terminal/escalation answer proof";
  if (!nonEmpty(candidate.actor.ref) || proof.reference !== candidate.actor.ref) {
    return "human checkpoint authorization answer reference does not match actor provenance";
  }
  const answer = (state.trusted_checkpoint_answers ?? []).find((record) => record.answer_id === proof.answer_id);
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
    || answer.work_identity_hash !== checkpointWorkIdentityHash(state, stage.id)
  ) {
    return "human checkpoint authorization answer binding is stale or mismatched";
  }
  if (answer.binding !== checkpointAnswerBinding(answer) || proof.binding !== answer.binding) {
    return "human checkpoint authorization answer binding digest is invalid";
  }
  return null;
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
  const typedValidation = validateTypedControlPlane({ typed_checkpoint_decisions: [candidate] });
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

  const floor = isFloorRule(policy, rule);
  if (floor && (rule.default === "autonomous_allowed" || policy.default === "autonomous_allowed")) {
    return fail("policy_invalid", `hard-human checkpoint '${checkpointId}' cannot permit autonomous authorization`, "needs_human");
  }
  if (candidate.authorization === "human") {
    const provenanceError = trustedHumanAnswerError(state, candidate, stage);
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

/** Validate the current stage's decision, including the resumable missing-answer state. */
export function validateCheckpointForAdvance(
  stage: StageCheckpointRef,
  state: TeamState,
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
    const floor = isFloorRule(policy, rule);
    return fail(
      "checkpoint_unresolved",
      `checkpoint '${stage.checkpoint}' for stage '${stage.id}' is unresolved: explicit human consent is required before advancing`,
      floor ? "needs_human" : "user_checkpoint",
    );
  }
  for (const candidate of candidates) {
    const result = validateCheckpointDecision(state, candidate, { stage, policy });
    if (result.ok) return result;
    return result;
  }
  return fail("checkpoint_unresolved", `checkpoint '${stage.checkpoint}' for stage '${stage.id}' is unresolved`, "user_checkpoint");
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
  };
}

export function findCheckpointDecision(
  state: TeamState,
  stageId: string,
  checkpoint: string,
): CheckpointDecision | null {
  const stage: StageCheckpointRef = { id: stageId, checkpoint };
  const currentStage = state.dispatch_capability?.issued_for?.stage_cursor === stageId;
  for (const decision of state.typed_checkpoint_decisions ?? []) {
    if (decision.stage_id !== stageId || decision.checkpoint_id !== checkpoint) continue;
    const result = validateCheckpointDecision(state, decision, { stage, bindCapability: currentStage });
    if (result.ok) return toLegacyDecision(result.decision);
  }
  for (const decision of state.checkpoint_decisions ?? []) {
    if (decision.stage_id !== stageId || decision.checkpoint !== checkpoint) continue;
    const result = validateCheckpointDecision(state, decision, { stage, bindCapability: currentStage });
    if (result.ok) return decision;
  }
  return null;
}

export function hasCheckpointDecision(state: TeamState, stageId: string, checkpoint: string): boolean {
  return findCheckpointDecision(state, stageId, checkpoint) !== null;
}

function consumeTrustedAnswer(state: TeamState, decision: TypedCheckpointDecision): TeamState {
  const proof = decision.actor.proof;
  if (!proof || !state.trusted_checkpoint_answers) return state;
  const index = state.trusted_checkpoint_answers.findIndex((answer) => answer.answer_id === proof.answer_id);
  if (index < 0 || state.trusted_checkpoint_answers[index]?.consumed_at) return state;
  const answers = [...state.trusted_checkpoint_answers];
  answers[index] = { ...answers[index]!, consumed_at: new Date().toISOString() };
  return { ...state, trusted_checkpoint_answers: answers };
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
  const existingForCheckpoint = existingTyped.find(
    (candidate) => candidate.stage_id === typed.stage_id && candidate.checkpoint_id === typed.checkpoint_id,
  );
  if (existingForCheckpoint) {
    if (JSON.stringify(canonicalize(existingForCheckpoint)) !== JSON.stringify(canonicalize(typed))) {
      throw new Error("migration_conflict: conflicting checkpoint decision already exists");
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
