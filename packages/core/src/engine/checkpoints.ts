/**
 * Durable checkpoint decisions.
 *
 * Checkpoint labels and legacy autonomy prose are migration/display inputs.
 * Permission is granted only by a policy-bound typed decision whose scope is
 * the CURRENT (run, stage, checkpoint, capability epoch, loop iteration,
 * policy hash) window. Both native checkpoint tools (through
 * `appendCheckpointDecision`) and the interpreter (`validateCheckpointForAdvance`)
 * use the same validator below.
 *
 * Ledger invariants:
 *   - a live answer carries no `consumed_at`/`consumed_reason`;
 *   - a superseded proof never authorizes anything;
 *   - a consumed proof authorizes only the exact immutable decision it was
 *     finalized for (`checkpointDecisionKey` equality), and legacy records
 *     consumed without a reason stay non-authorizing until that exact final
 *     decision is provable in the ledger;
 *   - for one question (`run_id`, `stage_id`, `checkpoint_id`) there is at
 *     most one live answer across both channels and all epochs;
 *   - one current-scope final record per question: an exact key replay is
 *     idempotent (a regenerated `decided_at` is never a conflict), any other
 *     current-scope record is a `decision_conflict`.
 */

import { createHash, randomBytes } from "node:crypto";
import { migrationCheckpointPolicy, validateTypedControlPlane } from "./workflow-contract.js";
import { loadProfile } from "./profile.js";
import {
  validateActiveCapabilityStateBinding,
  validateActiveDispatchCapabilityValue,
  validateTrustedCheckpointAnswerValue,
  validateTypedCheckpointDecisionValue,
} from "./control-plane-contract.js";
import type {
  CheckpointAnswerProof,
  CheckpointDeclaration,
  CheckpointDecision,
  CheckpointPolicy,
  CheckpointRule,
  CheckpointScope,
  StageDef,
  TeamState,
  DispatchCapabilityState,
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

type StageCheckpointRef = Pick<StageDef, "id" | "checkpoint" | "checkpoint_policy">;
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}


export type CheckpointValidationCode =
  | "policy_invalid"
  | "policy_conflict"
  | "migration_conflict"
  | "checkpoint_unverified"
  | "checkpoint_scope_stale"
  | "proof_superseded"
  | "proof_consumed_mismatch"
  | "decision_invalid"
  | "decision_conflict"
  | "state_invalid"
  | "capability_invalid"
  | "binding_invalid"
  | "identity_invalid"
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
  /** Authoritative resolved declaration; resolved from stage/profile/state otherwise. */
  declaration?: CheckpointDeclaration;
  /**
   * `current` (default) requires the decision to bind the active capability
   * epoch, loop iteration and policy hash. `historical` re-validates a
   * decision against an explicitly supplied declaration without requiring
   * currency — reserved for the named product gate; never for advance/ask.
   */
  mode?: "current" | "historical";
}

/** Non-throwing result of the current-stage declaration resolver. */
export type CheckpointDeclarationResolution =
  | { ok: true; declaration: CheckpointDeclaration | null }
  | { ok: false; code: CheckpointValidationCode; error: string };

/** Non-throwing result of appending one validated decision to the ledger. */
export type CheckpointAppendResult =
  | { ok: true; state: TeamState; idempotent: boolean; decision: TypedCheckpointDecision }
  | { ok: false; code: CheckpointValidationCode; error: string };

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

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 over canonical policy JSON; persisted migration uses the same rule. */
export function checkpointPolicyHash(policy: CheckpointPolicy): string {
  return createHash("sha256")
    .update(canonicalJson(policy))
    .digest("hex");
}

export interface TrustedCheckpointAnswerInput {
  /** Durable identity supplied by a trusted terminal/escalation ingest path. */
  answer_id: string;
  channel: "terminal" | "escalation";
  reference: string;
  stage_id: string;
  checkpoint_id: string;
  decision: string;
  issued_at?: string;
}

type AnswerBindingInput = Omit<TrustedCheckpointAnswer, "binding" | "consumed_at" | "consumed_reason" | "finalized_decision_key">;

/**
 * Canonical digest that binds an answer to its complete decision context.
 * Consumption metadata is audit state added after minting and is excluded.
 */
export function checkpointAnswerBinding(answer: AnswerBindingInput): string {
  const {
    binding: _binding,
    consumed_at: _consumedAt,
    consumed_reason: _consumedReason,
    finalized_decision_key: _finalizedDecisionKey,
    ...payload
  } = answer as TrustedCheckpointAnswer;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}



const DECISION_KEY_FIELDS = [
  "run_id", "stage_id", "checkpoint_id", "checkpoint_kind", "decision", "authorization",
  "actor", "capability_id", "capability_epoch", "loop_iteration", "policy_hash", "rationale",
] as const;

/**
 * Immutable identity of one decision: SHA-256 over the canonical decision
 * fields. `decided_at` is generated metadata and is deliberately excluded —
 * an exact retry that only regenerates the timestamp replays to the same key
 * and stays idempotent.
 */
export function checkpointDecisionKey(decision: TypedCheckpointDecision): string {
  const payload: Record<string, unknown> = {};
  for (const field of DECISION_KEY_FIELDS) payload[field] = (decision as unknown as Record<string, unknown>)[field];
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/**
 * Return the active projected identity only after the strict state/capability
 * validator proves the top-level mirror and every repeated scope field.
 * Absent projections stay absent; stale/foreign mirrors are never authority.
 */
function identityBoundToActiveCapability(state: TeamState): WorkIdentity | null {
  if (!validateActiveCapabilityStateBinding(state).ok) return null;
  const identity = state.work_identity;
  const projected = state.dispatch_capability?.work_identity;
  return identity && projected ? identity : null;
}

function expectedRunId(state: TeamState): string {
  return identityBoundToActiveCapability(state)?.run_id ?? state.run_key ?? state.branch;
}

/** Authoritative run identity for the current window (see expectedRunId). */
export function activeRunIdOf(state: TeamState): string {
  return expectedRunId(state);
}

/** The profile-level policy declared for the loaded workflow, if any. */
function profilePolicyFor(state: TeamState): CheckpointPolicy | null {
  const workflow = state.classification?.workflow;
  if (!nonEmpty(workflow)) return null;
  return loadProfile(workflow)?.checkpoint_policy ?? null;
}

function capabilityBinding(state: TeamState): { id: string; epoch: string; loop_iteration: number } | null {
  const capability = state.dispatch_capability;
  if (!capability) return null;
  // The scope is derived from the ACTIVE capability only: a capability that
  // is not complete/modern (or a state-epoch fallback) can never host a live
  // checkpoint decision or answer. Legacy capabilities stay readable but
  // must be re-issued before they participate in the ledger.
  if (!validateActiveDispatchCapabilityValue(capability).ok) return null;
  const issued = capability.issued_for;
  if (!issued || !nonEmpty(capability.capability_id) || !nonEmpty(issued.cursor_epoch) || !Number.isInteger(issued.loop_iteration)) return null;
  return { id: capability.capability_id, epoch: issued.cursor_epoch, loop_iteration: issued.loop_iteration };
}

/**
 * Immutable proof-scope identity hash for one (stage, capability binding).
 * A top-level `work_identity` is used only when it provably belongs to THIS
 * binding and stage; anything else (a stale prior-stage identity) is
 * ignored and the synthetic checkpoint identity under the given binding is
 * hashed instead — a stale top-level identity can never influence proof
 * hashing, and the hash is stable whether or not the stale mirror is
 * present.
 */
function checkpointWorkIdentityHash(state: TeamState, stageId: string, binding: { id: string; epoch: string; loop_iteration: number }): string {
  const identity = identityBoundToActiveCapability(state);
  const bound = identity !== null
    && identity.capability_id === binding.id
    && identity.capability_epoch === binding.epoch
    && identity.loop_iteration === binding.loop_iteration
    && identity.stage_id === stageId
    && identity.stage_cursor === stageId;
  const effective = bound ? identity : {
    run_id: expectedRunId(state),
    wave_id: "checkpoint",
    slice_id: "checkpoint",
    session_id: "checkpoint",
    workflow: state.classification.workflow,
    stage_id: stageId,
    stage_cursor: stageId,
    capability_id: binding.id,
    capability_epoch: binding.epoch,
    loop_iteration: binding.loop_iteration,
    slot_id: "checkpoint",
    task_id: `checkpoint:${stageId}`,
    dispatch_id: `checkpoint:${stageId}`,
    attempt: 1,
    worker_id: "engine",
  };
  return createHash("sha256").update(canonicalJson(effective)).digest("hex");
}

/** The proof envelope a caller may hold for one durable answer record. */
export function checkpointProofOf(answer: TrustedCheckpointAnswer): CheckpointAnswerProof {
  return {
    answer_id: answer.answer_id,
    nonce: answer.nonce,
    channel: answer.channel,
    reference: answer.reference,
    binding: answer.binding,
  };
}

/** Result of one trusted-ingest call: the (possibly unchanged) state, the durable answer, and its proof. */
export interface TrustedCheckpointAnswerIngest {
  state: TeamState;
  answer: TrustedCheckpointAnswer;
  proof: CheckpointAnswerProof;
}

/**
 * Record an answer at the trusted terminal/escalation ingest boundary.
 *
 * The public checkpoint tool receives only the returned proof.  It cannot
 * choose the nonce or binding, and re-ingesting an answer id is idempotent
 * only when every durable context field is identical. Answers always bind
 * the active capability epoch and loop iteration; a capability without a
 * loop-scoped binding cannot mint answers.
 */
export function recordTrustedCheckpointAnswer(
  state: TeamState,
  input: TrustedCheckpointAnswerInput,
): TrustedCheckpointAnswerIngest {
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
  if (!binding) throw new Error("checkpoint_unverified: checkpoint capability binding is unavailable or predates loop-scoped bindings");
  const activeBinding = validateActiveCapabilityStateBinding(state);
  if (!activeBinding.ok) {
    throw new Error(`checkpoint_unverified: workflow state and capability disagree: ${activeBinding.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
  const policy = state.checkpoint_policy;
  if (!policy) throw new Error("checkpoint_unverified: checkpoint policy is unavailable");
  const policyHash = checkpointPolicyHash(policy);
  const runId = expectedRunId(state);
  const workIdentityHash = checkpointWorkIdentityHash(state, input.stage_id, binding);
  const existing = (state.trusted_checkpoint_answers ?? []).find((candidate) => candidate.answer_id === input.answer_id);
  const existingShape = existing ? validateTrustedCheckpointAnswerValue(existing) : null;
  if (existingShape && !existingShape.ok) {
    throw new Error(`checkpoint_unverified: trusted answer is malformed: ${existingShape.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
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
      || existing.loop_iteration !== binding.loop_iteration
      || existing.policy_hash !== policyHash
      || existing.decision !== input.decision
    ) {
      throw new Error("checkpoint_unverified: trusted answer replay conflicts with the active context");
    }
    return { state, answer: existing, proof: checkpointProofOf(existing) };
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
    loop_iteration: binding.loop_iteration,
    policy_hash: policyHash,
    decision: input.decision,
    binding: "",
    issued_at: input.issued_at ?? new Date().toISOString(),
  };
  answer.binding = checkpointAnswerBinding(answer);
  // Live-answer uniqueness is enforced HERE, in the ingest primitive itself,
  // not only by the commit path: minting a new answer supersedes every other
  // live answer for the same question (run, stage, checkpoint) across both
  // channels and all epochs. A direct caller can therefore never produce a
  // state with two live answers for one question.
  const supersededAt = new Date().toISOString();
  const next: TeamState = {
    ...state,
    trusted_checkpoint_answers: [
      ...(state.trusted_checkpoint_answers ?? []).map((candidate) =>
        candidate.answer_id !== input.answer_id
        && liveAnswer(candidate)
        && candidate.run_id === runId
        && candidate.stage_id === input.stage_id
        && candidate.checkpoint_id === input.checkpoint_id
          ? { ...candidate, consumed_at: supersededAt, consumed_reason: "superseded" as const }
          : candidate),
      answer,
    ],
  };
  return { state: next, answer, proof: checkpointProofOf(answer) };
}

/**
 * Structural validation issues for a checkpoint policy, shared by the typed
 * workflow contract and the trusted human-ask ingest boundary. Migration
 * policies keep their intentional empty `allowed_decisions` allowance.
 */
export function checkpointPolicyValidationIssues(policy: CheckpointPolicy): string[] {
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
 * Resolve the authoritative checkpoint declaration for a stage.
 *
 * Source order:
 *   1. `stage.checkpoint_policy`;
 *   2. the declaring profile's policy;
 *   3. the persisted state policy — only while `checkpoint_policy_binding`
 *      names THIS stage with the current profile hash and its own hash;
 *   4. a conservative migration policy for legacy checkpoints.
 *
 * A declared stage/profile policy is always stronger than the state mirror.
 * In `authorize` mode a persisted mirror that contradicts the declaration is
 * corruption and fails closed (`policy_conflict`); in `rebind` mode the
 * caller is a state transition that re-projects the mirror, so the declared
 * policy simply wins. A binding for a different stage is a prior-stage
 * projection: it neither authorizes nor blocks and is dropped by the next
 * transition.
 */
export function resolveCheckpointDeclaration(
  stage: StageCheckpointRef,
  profilePolicy: CheckpointPolicy | null | undefined,
  state: TeamState,
  mode: "authorize" | "rebind" = "authorize",
): CheckpointDeclarationResolution {
  if (!stage.checkpoint) return { ok: true, declaration: null };
  const declared = stage.checkpoint_policy ?? profilePolicy ?? null;
  const binding = state.checkpoint_policy_binding ?? null;
  const bindingCurrent = binding !== null
    && binding.stage_id === stage.id
    && binding.profile_hash === (state.profile_hash ?? "");
  let policy: CheckpointPolicy;
  if (declared) {
    policy = declared;
    // A persisted mirror that contradicts the declaration is corruption in
    // authorize mode — but only while the mirror is attributable to THIS
    // stage: its binding names this stage, or the stage declares no policy
    // of its own (there the profile declaration is the projection source, so
    // a contradicting mirror can only be drift between the state and the
    // declaring profile). A stage-level declaration simply wins: the mirror
    // may be a prior stage's leftover sharing the checkpoint id, and the
    // next transition re-projects it.
    const mirrorContradicts = state.checkpoint_policy !== undefined
      && checkpointPolicyHash(state.checkpoint_policy) !== checkpointPolicyHash(declared);
    if (mirrorContradicts && (bindingCurrent || !stage.checkpoint_policy)) {
      if (mode === "authorize") {
        return {
          ok: false,
          code: "policy_conflict",
          error: `persisted checkpoint policy for stage '${stage.id}' conflicts with the declared stage/profile policy; re-run workflow_begin to re-project it`,
        };
      }
    }
  } else if (bindingCurrent && state.checkpoint_policy) {
    policy = state.checkpoint_policy;
    if (binding.policy_hash !== checkpointPolicyHash(policy)) {
      return { ok: false, code: "policy_conflict", error: `persisted checkpoint policy hash does not match the policy binding for stage '${stage.id}'` };
    }
  } else {
    policy = applyLegacyMigrationPolicy(state, migrationCheckpointPolicy(stage.checkpoint), stage.checkpoint);
  }
  const issues = checkpointPolicyValidationIssues(policy);
  if (issues.length > 0) return { ok: false, code: "policy_invalid", error: `checkpoint policy is invalid: ${issues.join("; ")}` };
  const rule = policy.rules[stage.checkpoint];
  if (!rule) return { ok: false, code: "policy_invalid", error: `checkpoint policy has no rule for '${stage.checkpoint}'` };
  return {
    ok: true,
    declaration: {
      stage_id: stage.id,
      checkpoint_id: stage.checkpoint,
      policy,
      rule,
      policy_hash: checkpointPolicyHash(policy),
    },
  };
}

function isFloorRule(policy: CheckpointPolicy, rule: CheckpointRule): boolean {
  return HARD_HUMAN_FLOOR[rule.kind] === true || policy.hard_human.includes(rule.kind);
}

function fail(
  code: CheckpointValidationCode,
  error: string,
  pauseKind?: "user_checkpoint" | "needs_human",
): CheckpointValidationFailure {
  return { ok: false, code, error, pauseKind };
}

/**
 * The active checkpoint scope: fully resolved from the current declaration
 * and the active loop-scoped capability binding. A capability without the
 * loop-scoped binding fields predates scoping and can never host a live
 * checkpoint decision or answer.
 */
export function currentCheckpointScope(
  state: TeamState,
  stage: StageCheckpointRef,
  declaration: CheckpointDeclaration,
): { ok: true; scope: CheckpointScope } | { ok: false; code: CheckpointValidationCode; error: string } {
  const binding = capabilityBinding(state);
  if (!binding) {
    return {
      ok: false,
      code: "checkpoint_scope_stale",
      error: "active dispatch capability is unavailable or predates loop-scoped checkpoint bindings; re-run workflow_begin",
    };
  }
  const bindingIssues = validateActiveCapabilityStateBinding(state);
  if (!bindingIssues.ok) {
    return {
      ok: false,
      code: "binding_invalid",
      error: `workflow state and capability disagree: ${bindingIssues.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
    };
  }
  return {
    ok: true,
    scope: {
      run_id: expectedRunId(state),
      stage_id: stage.id,
      checkpoint_id: declaration.checkpoint_id,
      checkpoint_kind: declaration.rule.kind,
      capability_id: binding.id,
      capability_epoch: binding.epoch,
      loop_iteration: binding.loop_iteration,
      policy_hash: declaration.policy_hash,
    },
  };
}

/**
 * The immutable scope fields a decision carries, or null when the record is
 * unscoped (a legacy record predating the loop-scoped ledger can therefore
 * never match a current scope).
 */
export function decisionScopeOf(decision: CheckpointDecision | TypedCheckpointDecision): CheckpointScope | null {
  const record = decision as unknown as Record<string, unknown>;
  const iteration = record.loop_iteration;
  if (
    !nonEmpty(record.capability_id)
    || !nonEmpty(record.capability_epoch)
    || !nonEmpty(record.policy_hash)
    || !Number.isInteger(iteration)
    || (iteration as number) < 1
  ) return null;
  const stageRef = decision as TypedCheckpointDecision;
  return {
    run_id: stageRef.run_id,
    stage_id: stageRef.stage_id,
    checkpoint_id: stageRef.checkpoint_id,
    checkpoint_kind: stageRef.checkpoint_kind,
    capability_id: stageRef.capability_id,
    capability_epoch: stageRef.capability_epoch,
    loop_iteration: iteration as number,
    policy_hash: stageRef.policy_hash,
  };
}

function sameScope(left: CheckpointScope, right: CheckpointScope): boolean {
  return left.capability_id === right.capability_id
    && left.capability_epoch === right.capability_epoch
    && left.loop_iteration === right.loop_iteration
    && left.policy_hash === right.policy_hash
    && left.run_id === right.run_id
    && left.stage_id === right.stage_id
    && left.checkpoint_id === right.checkpoint_id
    && left.checkpoint_kind === right.checkpoint_kind;
}

function legacyDecision(decision: CheckpointDecision): boolean {
  return !("checkpoint_id" in decision) && !("authorization" in decision) && !("actor_provenance" in decision);
}

/**
 * Convert a legacy (schema-1 mirror) record into the typed candidate.
 * Strict by design: capability, epoch, loop iteration and policy hash MUST
 * be present on the record itself — they are never defaulted from the live
 * state, so an unscoped legacy record can never masquerade as current-scope
 * evidence.
 */
function typedInput(
  decision: CheckpointDecision | TypedCheckpointDecision,
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
    !nonEmpty(old.run_id) ||
    !nonEmpty(old.checkpoint_id ?? old.checkpoint) ||
    !nonEmpty(old.capability_id) ||
    !nonEmpty(old.capability_epoch) ||
    !nonEmpty(old.policy_hash) ||
    !Number.isInteger(old.loop_iteration) ||
    (old.loop_iteration as number) < 1 ||
    !old.authorization ||
    old.actor_provenance === undefined ||
    old.actor_provenance === null ||
    typeof old.actor_provenance !== "object" ||
    Array.isArray(old.actor_provenance)
  ) {
    return fail(
      "checkpoint_unverified",
      "checkpoint decision lacks typed authorization, actor provenance, capability binding, loop iteration, or policy hash",
    );
  }

  const candidate: TypedCheckpointDecision = {
    run_id: old.run_id,
    stage_id: old.stage_id,
    checkpoint_id: old.checkpoint_id ?? old.checkpoint,
    checkpoint_kind: old.checkpoint_kind ?? "custom",
    decision: old.decision,
    authorization: old.authorization,
    actor: old.actor_provenance,
    capability_id: old.capability_id,
    capability_epoch: old.capability_epoch,
    loop_iteration: old.loop_iteration as number,
    policy_hash: old.policy_hash,
    rationale: old.rationale,
    decided_at: old.decided_at,
  };
  return { candidate, legacy: true };
}

function trustedHumanAnswerError(
  state: TeamState,
  candidate: TypedCheckpointDecision,
  stage: StageCheckpointRef,
): CheckpointValidationFailure | null {
  if (candidate.actor.kind !== "user") {
    return fail("checkpoint_unverified", "human checkpoint authorization requires a user actor", "needs_human");
  }
  const proof = candidate.actor.proof;
  if (!proof) {
    return fail("checkpoint_unverified", "human checkpoint authorization requires a durable terminal/escalation answer proof", "needs_human");
  }
  if (!nonEmpty(candidate.actor.ref) || proof.reference !== candidate.actor.ref) {
    return fail("checkpoint_unverified", "human checkpoint authorization answer reference does not match actor provenance", "needs_human");
  }
  const answer = (state.trusted_checkpoint_answers ?? []).find((record) => record.answer_id === proof.answer_id);
  if (!answer) {
    return fail("checkpoint_unverified", "human checkpoint authorization answer identity is not present in the durable answer ledger", "needs_human");
  }
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
    || answer.loop_iteration !== candidate.loop_iteration
    || answer.policy_hash !== candidate.policy_hash
    || answer.decision !== candidate.decision
    // The proof identity binds the decision's OWN immutable capability
    // scope — the binding that was active when the answer was minted. In
    // current mode that equals the active capability (validated below); in
    // historical mode it lets a decision survive capability rotation (the
    // product_approval -> product_handoff gate) instead of being compared
    // against whatever capability is active now.
    || answer.work_identity_hash !== checkpointWorkIdentityHash(state, stage.id, { id: candidate.capability_id, epoch: candidate.capability_epoch, loop_iteration: candidate.loop_iteration })
  ) {
    return fail("checkpoint_unverified", "human checkpoint authorization answer binding is stale or mismatched", "needs_human");
  }
  if (answer.binding !== checkpointAnswerBinding(answer) || proof.binding !== answer.binding) {
    return fail("checkpoint_unverified", "human checkpoint authorization answer binding digest is invalid", "needs_human");
  }
  // Consumption semantics: a consumed proof authorizes only the exact
  // immutable decision it was finalized for.
  if (answer.consumed_at !== undefined) {
    if (answer.consumed_reason === "superseded") {
      return fail("proof_superseded", "checkpoint proof was superseded by a newer answer and can never authorize a decision", "needs_human");
    }
    const key = checkpointDecisionKey(candidate);
    if (answer.consumed_reason === "finalized") {
      if (!nonEmpty(answer.finalized_decision_key)) {
        return fail("proof_consumed_mismatch", "finalized checkpoint proof is missing its immutable decision key", "needs_human");
      }
      if (answer.finalized_decision_key !== key) {
        return fail("proof_consumed_mismatch", "consumed checkpoint proof does not match the presented decision; only the exact finalized decision replays", "needs_human");
      }
    }
    // Finalized and legacy-consumed records alike must have a durable final
    // decision with this exact key and this answer as its proof; without
    // that proof the record is treated as superseded.
    const final = (state.typed_checkpoint_decisions ?? []).find((record) =>
      checkpointDecisionKey(record) === key && record.actor.proof?.answer_id === answer.answer_id,
    );
    if (!final) {
      return fail(
        answer.consumed_reason === undefined ? "proof_superseded" : "proof_consumed_mismatch",
        "consumed checkpoint proof has no provable matching final decision in the ledger; it is treated as superseded",
        "needs_human",
      );
    }
  }
  return null;
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
  const declaration: CheckpointDeclarationResolution = options.declaration
    ? { ok: true, declaration: options.declaration }
    : resolveCheckpointDeclaration(stage, profilePolicyFor(state), state, "authorize");
  if (!declaration.ok) return fail(declaration.code, declaration.error, declaration.code === "policy_conflict" ? "needs_human" : undefined);
  if (!declaration.declaration) return fail("policy_invalid", `checkpoint '${checkpointId}' has no policy`);
  const resolved = declaration.declaration;
  const policy = resolved.policy;
  const rule = resolved.rule;
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

  const prepared = typedInput(decision);
  if ("ok" in prepared) return prepared;
  const candidate = prepared.candidate;
  const shapeValidation = validateTypedCheckpointDecisionValue(candidate);
  if (!shapeValidation.ok) {
    return fail(
      "decision_invalid",
      `checkpoint decision is malformed: ${shapeValidation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
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
  if (candidate.policy_hash !== resolved.policy_hash) {
    return fail("checkpoint_unverified", "checkpoint decision policy_hash does not match the active policy");
  }

  const mode = options.mode ?? "current";
  if (mode === "current") {
    const scope = currentCheckpointScope(state, stage, resolved);
    if (!scope.ok) return fail(scope.code, scope.error, scope.code === "checkpoint_scope_stale" ? "needs_human" : undefined);
    if (candidate.capability_id !== scope.scope.capability_id || candidate.capability_epoch !== scope.scope.capability_epoch || candidate.loop_iteration !== scope.scope.loop_iteration) {
      // Presented as current evidence but not minted under the live binding:
      // tampered context and prior-epoch replays alike are unverified, never
      // a live scope. (checkpoint_scope_stale stays reserved for the ask
      // commit's world-moved-during-dialog classification.)
      return fail("checkpoint_unverified", "checkpoint decision capability_id/capability_epoch/loop_iteration does not match the active capability", "needs_human");
    }
  } else if (!nonEmpty(candidate.capability_id) || !nonEmpty(candidate.capability_epoch) || !Number.isInteger(candidate.loop_iteration) || candidate.loop_iteration < 1) {
    return fail("checkpoint_unverified", "historical checkpoint decision is missing its capability binding or loop iteration");
  }

  const floor = isFloorRule(policy, rule);
  if (floor && (rule.default === "autonomous_allowed" || policy.default === "autonomous_allowed")) {
    return fail("policy_invalid", `hard-human checkpoint '${checkpointId}' cannot permit autonomous authorization`, "needs_human");
  }
  if (candidate.authorization === "human") {
    const provenanceError = trustedHumanAnswerError(state, candidate, stage);
    if (provenanceError) return provenanceError;
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
 * Advance-blocking check scoped to the CURRENT window. Records from prior
 * epochs or loop iterations are audit history, not candidates: they neither
 * satisfy nor deadlock the current checkpoint. Multiple conflicting
 * current-scope records are corruption and fail closed.
 */
export function validateCheckpointForAdvance(
  stage: StageCheckpointRef,
  state: TeamState,
  explicitDeclaration?: CheckpointDeclaration,
): CheckpointValidationResult {
  if (!stage.checkpoint) return { ok: true, decision: undefined as never };
  const resolved: CheckpointDeclarationResolution = explicitDeclaration
    ? { ok: true, declaration: explicitDeclaration }
    : resolveCheckpointDeclaration(stage, profilePolicyFor(state), state, "authorize");
  if (!resolved.ok) return fail(resolved.code, resolved.error, "needs_human");
  const declaration = resolved.declaration;
  if (!declaration) return fail("policy_invalid", `checkpoint '${stage.checkpoint}' has no policy`, "needs_human");
  const scope = currentCheckpointScope(state, stage, declaration);
  if (!scope.ok) return fail(scope.code, scope.error, "needs_human");
  const active = scope.scope;
  const rule = declaration.rule;
  const floor = isFloorRule(declaration.policy, rule);
  const unresolved = () => fail(
    "checkpoint_unresolved",
    `checkpoint '${stage.checkpoint}' for stage '${stage.id}' is unresolved: explicit human consent is required before advancing`,
    floor ? "needs_human" : "user_checkpoint",
  );

  const candidates: Array<CheckpointDecision | TypedCheckpointDecision> = [
    ...(state.typed_checkpoint_decisions ?? []),
    ...(state.checkpoint_decisions ?? []),
  ].filter((decision) => {
    const id = "checkpoint_id" in decision ? decision.checkpoint_id : decision.checkpoint;
    if (decision.stage_id !== stage.id || id !== stage.checkpoint) return false;
    const candidateScope = decisionScopeOf(decision);
    return candidateScope !== null && sameScope(candidateScope, active);
  });
  if (candidates.length === 0) return unresolved();

  const validated: TypedCheckpointDecision[] = [];
  for (const candidate of candidates) {
    const result = validateCheckpointDecision(state, candidate, { stage, declaration, mode: "current" });
    if (!result.ok) return result;
    validated.push(result.decision);
  }
  const keys = new Set(validated.map((decision) => checkpointDecisionKey(decision)));
  if (keys.size > 1) {
    return fail(
      "decision_conflict",
      `multiple conflicting decisions exist for checkpoint '${stage.checkpoint}' in the current scope`,
      "needs_human",
    );
  }
  return { ok: true, decision: validated[0]! };
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
    loop_iteration: decision.loop_iteration,
    policy_hash: decision.policy_hash,
  };
}

/**
 * Current-scope lookup: the validated decision for THIS capability epoch,
 * loop iteration and policy hash, or null. Replaces the ambiguous
 * stage/checkpoint-only lookup for every authorizing read.
 */
export function findCurrentCheckpointDecision(
  state: TeamState,
  stage: StageCheckpointRef,
  declaration?: CheckpointDeclaration,
): CheckpointDecision | null {
  if (!stage.checkpoint) return null;
  const resolved: CheckpointDeclarationResolution = declaration
    ? { ok: true, declaration }
    : resolveCheckpointDeclaration(stage, profilePolicyFor(state), state, "authorize");
  if (!resolved.ok || !resolved.declaration) return null;
  // The explicit declaration (when supplied) is authoritative for the
  // lookup — it must not silently fall back to a second resolution.
  const result = validateCheckpointForAdvance(stage, state, resolved.declaration);
  if (!result.ok) return null;
  return toLegacyDecision(result.decision);
}
export type HistoricalCheckpointSelector =
  | { decision_key: string }
  | { scope: CheckpointScope };

export type HistoricalCheckpointLookupResult =
  | { ok: true; decision: CheckpointDecision | null; decision_key: string | null }
  | { ok: false; code: "decision_ambiguous" | CheckpointValidationCode; error: string };

/**
 * Historical lookup against an explicit declaration. Callers that may see
 * more than one completed generation must pass its immutable decision key or
 * full scope. Without a selector, one unique validated generation is allowed;
 * multiple generations return an explicit ambiguity instead of array-order
 * selection.
 */
export function findHistoricalCheckpointDecision(
  state: TeamState,
  declaration: CheckpointDeclaration,
  selector?: HistoricalCheckpointSelector,
): HistoricalCheckpointLookupResult {
  const stage: StageCheckpointRef = { id: declaration.stage_id, checkpoint: declaration.checkpoint_id };
  const decisions: Array<CheckpointDecision | TypedCheckpointDecision> = [
    ...(state.typed_checkpoint_decisions ?? []),
    ...(state.checkpoint_decisions ?? []),
  ].filter((decision) => {
    const id = "checkpoint_id" in decision ? decision.checkpoint_id : decision.checkpoint;
    return decision.stage_id === declaration.stage_id && id === declaration.checkpoint_id;
  });
  const validated = new Map<string, { decision: TypedCheckpointDecision; scope: CheckpointScope }>();
  for (const decision of decisions) {
    const result = validateCheckpointDecision(state, decision, { stage, declaration, mode: "historical" });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        error: `historical checkpoint ledger is invalid for '${declaration.checkpoint_id}': ${result.error}`,
      };
    }
    const scope = decisionScopeOf(result.decision);
    if (!scope) {
      return {
        ok: false,
        code: "checkpoint_unverified",
        error: `historical checkpoint decision for '${declaration.checkpoint_id}' has no immutable scope`,
      };
    }
    validated.set(checkpointDecisionKey(result.decision), { decision: result.decision, scope });
  }
  let matches = Array.from(validated.entries());
  if (selector && "decision_key" in selector) {
    matches = matches.filter(([key]) => key === selector.decision_key);
  } else if (selector) {
    matches = matches.filter(([, candidate]) => sameScope(candidate.scope, selector.scope));
  }
  if (matches.length === 0) return { ok: true, decision: null, decision_key: null };
  if (matches.length > 1) {
    return {
      ok: false,
      code: "decision_ambiguous",
      error: `multiple historical generations exist for checkpoint '${declaration.checkpoint_id}'; an exact decision key or scope is required`,
    };
  }
  const [decisionKey, selected] = matches[0]!;
  return { ok: true, decision: toLegacyDecision(selected.decision), decision_key: decisionKey };
}


function liveAnswer(answer: TrustedCheckpointAnswer): boolean {
  return answer.consumed_at === undefined && answer.consumed_reason === undefined;
}

/**
 * Mark the decision's trusted answer finalized: consumed, with the reason
 * and the immutable decision key so only the exact decision replays. Live
 * answers only — superseded records can never be resurrected.
 */
function finalizeTrustedAnswer(state: TeamState, decision: TypedCheckpointDecision): TeamState {
  const proof = decision.actor.proof;
  if (!proof || !state.trusted_checkpoint_answers) return state;
  const index = state.trusted_checkpoint_answers.findIndex((answer) => answer.answer_id === proof.answer_id);
  const answer = state.trusted_checkpoint_answers[index];
  if (index < 0 || !answer || !liveAnswer(answer)) return state;
  const answers = [...state.trusted_checkpoint_answers];
  answers[index] = {
    ...answer,
    consumed_at: new Date().toISOString(),
    consumed_reason: "finalized",
    finalized_decision_key: checkpointDecisionKey(decision),
  };
  return { ...state, trusted_checkpoint_answers: answers };
}

/**
 * Idempotent, non-throwing append of a validated typed decision.
 *
 * For the active scope:
 *   - a record with the same immutable `checkpointDecisionKey` makes the
 *     call idempotent: the first record (with its original `decided_at` and
 *     rationale) is kept and the trusted answer is finalized exactly once;
 *   - any other current-scope record is a `decision_conflict`;
 *   - records from other epochs or loop iterations are audit history and
 *     never conflict; a new record is appended alongside them;
 *   - a human decision finalizes its trusted answer in the same mutation.
 */
export function appendCheckpointDecision(
  state: TeamState,
  decision: CheckpointDecision | TypedCheckpointDecision,
): CheckpointAppendResult {
  const stage: StageCheckpointRef = {
    id: decision.stage_id,
    checkpoint: "checkpoint_id" in decision ? decision.checkpoint_id : decision.checkpoint,
  };
  // The declaring profile stage is authoritative for the policy resolution:
  // a bare decision ref carries no stage-level checkpoint_policy, so
  // resolving from it alone would silently fall back to the migration
  // policy and reject the very decision a stage-declared policy produced.
  const appendingProfile = loadProfile(state.classification?.workflow ?? "");
  const declaringStage = appendingProfile?.stages.find((candidate) => candidate.id === stage.id) ?? stage;
  const declaration = resolveCheckpointDeclaration(declaringStage, profilePolicyFor(state), state, "authorize");
  if (!declaration.ok) return { ok: false, code: declaration.code, error: declaration.error };
  if (!declaration.declaration) return { ok: false, code: "policy_invalid", error: `stage '${stage.id}' declares no checkpoint` };
  const scope = currentCheckpointScope(state, stage, declaration.declaration);
  if (!scope.ok) return { ok: false, code: scope.code, error: scope.error };
  const result = validateCheckpointDecision(state, decision, { stage, declaration: declaration.declaration, mode: "current" });
  if (!result.ok) return { ok: false, code: result.code, error: result.error };
  const typed = result.decision;
  const key = checkpointDecisionKey(typed);

  const existingTyped = state.typed_checkpoint_decisions ?? [];
  const existingLegacy = state.checkpoint_decisions ?? [];
  const inCurrentScope = (candidate: CheckpointDecision | TypedCheckpointDecision): boolean => {
    const candidateScope = decisionScopeOf(candidate);
    return candidateScope !== null
      && candidateScope.stage_id === scope.scope.stage_id
      && candidateScope.checkpoint_id === scope.scope.checkpoint_id
      && sameScope(candidateScope, scope.scope);
  };
  // ONE current-scope conflict check across BOTH ledgers: the legacy mirror
  // of a typed decision is as final as its typed twin, so a different
  // decision is a conflict and the exact decision replays idempotently
  // regardless of which array holds the first record.
  const currentRecords = new Map<string, TypedCheckpointDecision>();
  for (const candidate of [...existingTyped, ...existingLegacy]) {
    if (!inCurrentScope(candidate)) continue;
    const validated = validateCheckpointDecision(state, candidate, { stage, declaration: declaration.declaration, mode: "current" });
    if (!validated.ok) return { ok: false, code: validated.code, error: validated.error };
    currentRecords.set(checkpointDecisionKey(validated.decision), validated.decision);
  }
  const identical = currentRecords.get(key);
  if (identical) {
    return { ok: true, state: finalizeTrustedAnswer(state, typed), idempotent: true, decision: identical };
  }
  if (currentRecords.size > 0) {
    const recorded = currentRecords.values().next().value!;
    return {
      ok: false,
      code: "decision_conflict",
      error: `a conflicting decision ('${recorded.decision}') already exists for checkpoint '${typed.checkpoint_id}' in the current scope`,
    };
  }

  const mirror = toLegacyDecision(typed);
  const next: TeamState = {
    ...state,
    typed_checkpoint_decisions: [...existingTyped, typed],
    checkpoint_decisions: [
      ...existingLegacy.filter((candidate) => !(
        candidate.stage_id === mirror.stage_id
        && candidate.checkpoint === mirror.checkpoint
        && candidate.capability_epoch === mirror.capability_epoch
        && candidate.loop_iteration === mirror.loop_iteration
      )),
      mirror,
    ],
  };
  return { ok: true, state: finalizeTrustedAnswer(next, typed), idempotent: false, decision: typed };
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
