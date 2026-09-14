import { randomUUID, createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AcquireClaimPreparedWal,
  ClaimJournalEnvelopeV2,
  ClaimJournalManifest,
  ClaimPreparedWal,
  CompleteClaimPreparedWal,
  ExecutionClaim,
  ExecutionClaimOwnerKind,
  FeatureWorkspace,
  ExecutionClaimAdmissionBinding,
  ImplementationConformanceResult,
  ImplementationHandoff,
  WorkspacePathBinding,
} from "./types.js";
import {
  canonicalJson,
  digestOf,
  implementationConformanceMatrixDigest,
  isRecord,
  isSafeFeatureId,
  isSafeRelativePath,
  isSha256Hex,
  nextActionForWorkspace,
  validateExecutionClaim,
  validateFeatureWorkspaceRecord,
  validateImplementationConformance,
  validateImplementationHandoff,
  validateWorkspacePathBinding,
} from "./validation.js";
import { canonicalHandoffDigest, evaluateHandoffReadiness } from "./handoff.js";
import { readCanonicalHandoff } from "./canonical-reader.js";
import { readPinnedCtoMappingRecord } from "./mapping-record.js";
import { isSafeCtoExecutionId, isSafeCtoRunId } from "../cto/state.js";
import { captureWorkspacePathBinding, workspacePathBindingDigest } from "./workspace.js";
import { readPinnedCurrentConstitution } from "./constitution-identities.js";
import { PinnedProjectRoot, PinnedRootError, processStartIdentity, type PinnedRootFileExpectation, type PinnedRootWriteReceipt } from "./pinned-root.js";
import type { CheckpointAnswerProof, TeamState } from "../engine/types.js";
import { trustedCheckpointAnswerError } from "../engine/checkpoints.js";
import { MAX_PERSISTED_STATE_BYTES, normalizePersistedState, parseBoundedPersistedState, rollbackStateMutationReceipts, updateStateAtomically, type StateMutationReceipt, type StateSnapshot } from "../engine/state.js";
import { readArtifactPinned } from "../engine/artifacts.js";

export type ExecutionClaimResultCode =
  | "SPEC_HANDOFF_NOT_READY"
  | "SPEC_STALE"
  | "SPEC_EXECUTION_CLAIMED"
  | "SPEC_CLAIM_RECOVERY_REQUIRED"
  | "SPEC_STATE_INVALID"
  | "SPEC_PATH_UNAUTHORIZED"
  | "SPEC_CLAIM_PERSIST_FAILED"
  | "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED"
  | "SPEC_IMPLEMENTATION_INTENT_CHANGED";

export interface ExecutionClaimMutationReceipt {
  readonly state?: readonly StateMutationReceipt[];
  readonly journal?: PinnedRootWriteReceipt;
  readonly rollback: () => boolean;
}

export type ExecutionClaimResult<T = ExecutionClaim> =
  | { ok: true; value: T; receipt?: ExecutionClaimMutationReceipt; receipts?: readonly StateMutationReceipt[] }
  | { ok: false; code: ExecutionClaimResultCode; error: string; claim?: ExecutionClaim };

export interface ClaimTransitionPublicationOptions {
  /** Return/register exact claim-journal and state receipts at publication. */
  readonly captureReceipts?: boolean;
  readonly onReceipt?: (receipt: ExecutionClaimMutationReceipt) => void;
}

export interface ExecutionClaimRequest {
  handoff: ImplementationHandoff;
  owner_kind: ExecutionClaimOwnerKind;
  owner_run_id: string;
  run_key: string;
  /** Semantic workspace digest captured by the caller before admission. */
  expected_workspace_digest?: string;
  /** Exact CTO mapping/confirmation image fenced into the feature-state CAS. */
  admission_binding?: ExecutionClaimAdmissionBinding;
  acquired_at?: string;
}

export interface ClaimIdentityInput {
  claim_id: string;
  handoff_digest: string;
  owner_kind: ExecutionClaimOwnerKind;
  owner_run_id: string;
}

export interface ClaimTransitionInput extends ClaimIdentityInput {
  reason: string;
  updated_at?: string;
}

export interface ClaimCompletionInput extends ClaimIdentityInput {
  conformance: ImplementationConformanceResult;
  updated_at?: string;
  /** Exact workspace preimage captured by the authenticated finalizer. */
  expected_workspace_digest?: string;
  /** Exact state revision captured by the authenticated finalizer. */
  expected_state_revision?: number;
  /** Exact conformance reference observed by the authenticated finalizer. */
  expected_conformance_ref?: string | null;
  /** Capability identity/epoch observed by the authenticated finalizer. */
  expected_capability?: { capability_id: string; capability_epoch: string };
}
/**
 * Deterministic crash seam for completion recovery tests. The callback runs
 * after the completed workspace CAS is durable and before the terminal claim
 * journal append, leaving the exact prepared WAL/postimage pair for replay.
 */
export interface ExecutionClaimCompletionTestHooks {
  afterWorkspaceCasBeforeJournalAppend?: (input: {
    feature_id: string;
    claim_id: string;
    transaction_id: string;
  }) => void;
}

type CompletionHookRecord = { hook: ExecutionClaimCompletionTestHooks; aliases: string[] };
const executionClaimCompletionTestHooksByRoot = new Map<string, CompletionHookRecord>();
function completionHookScopeKeys(projectRoot: string): string[] {
  const lexical = resolve(projectRoot);
  try {
    const canonical = resolve(realpathSync(projectRoot));
    return canonical === lexical ? [lexical] : [lexical, canonical];
  } catch {
    return [lexical];
  }
}
function completionHookIdentity(projectRoot: string): string | undefined {
  try {
    const stat = lstatSync(realpathSync(projectRoot));
    return "identity:" + String(stat.dev) + ":" + String(stat.ino);
  } catch {
    return undefined;
  }
}
function findCompletionHook(projectRoot: string, pinnedRoot?: PinnedProjectRoot): ExecutionClaimCompletionTestHooks | undefined {
  const aliases = pinnedRoot
    ? ["identity:" + String(pinnedRoot.dev) + ":" + String(pinnedRoot.ino), ...completionHookScopeKeys(projectRoot)]
    : completionHookScopeKeys(projectRoot);
  for (const alias of aliases) {
    const record = executionClaimCompletionTestHooksByRoot.get(alias);
    if (record) return record.hook;
  }
  return undefined;
}

/** Internal deterministic crash seam; intentionally not exported by the package index. */
export function setExecutionClaimCompletionTestHooks(hooks: ExecutionClaimCompletionTestHooks | null, projectRoot: string): void {
  const aliases = [...completionHookScopeKeys(projectRoot)];
  const identity = completionHookIdentity(projectRoot);
  if (identity && !aliases.includes(identity)) aliases.push(identity);
  const previous = new Set<CompletionHookRecord>();
  for (const alias of aliases) {
    const record = executionClaimCompletionTestHooksByRoot.get(alias);
    if (record) previous.add(record);
  }
  for (const record of previous) for (const alias of record.aliases) {
    if (executionClaimCompletionTestHooksByRoot.get(alias) === record) executionClaimCompletionTestHooksByRoot.delete(alias);
  }
  if (!hooks) return;
  const record: CompletionHookRecord = { hook: hooks, aliases };
  for (const alias of aliases) executionClaimCompletionTestHooksByRoot.set(alias, record);
}
export interface CompletionRecoveryAuthorization {
  /**
   * Optional pre-authorization used when the normal authority reader cannot
   * bind an active journal tail to an already-completed workspace postimage.
   * It runs while the claim lock is held, after the exact completion WAL and
   * postimage have been verified and before the terminal claim is appended.
   */
  preauthorize?: (claim: ExecutionClaim, workspace: FeatureWorkspace, runKey: string) => boolean;
}
/**
 * Immutable mapping/execution fields expected by one admitted CTO claim.
 * State-derived admission fields remain authenticated by the verifier.
 */
export interface ExecutionClaimAdmissionMappingContext {
  /** Canonical selector selected from the immutable mapping record. */
  selected_feature_id: string;
  selected_run_key: string;
  mapping_record_path: string;
  mapping_record_digest: string;
  mapping_id: string;
  mapping_hash: string;
  mapping_version: number;
  checkpoint_ref: string;
  trusted_answer_ref: string;
  wave_id: string;
  capability_id: string;
  capability_epoch: string;
}

/**
 * Exact durable inputs used to authenticate a CTO claim admission without
 * reopening the project root or mutating feature state.
 */
export interface ExecutionClaimAdmissionVerificationContext {
  feature_id: string;
  run_key: string;
  owner_run_id: string;
  workspace: FeatureWorkspace;
  claim: ExecutionClaim;
  handoff: ImplementationHandoff;
  mapping: ExecutionClaimAdmissionMappingContext;
  /**
   * Terminal mode authenticates the immutable admission image even after its
   * confirmation anchor has advanced through normal execution.
   */
  verification_mode?: "active" | "terminal";

}
/**
 * Re-verify one already-read CTO claim admission against the canonical
 * mapping, confirmation anchor, and feature state through a borrowed root.
 * The state transaction is discard-only; no state or claim mutation occurs.
 */
export function verifyExecutionClaimAdmissionBindingPinned(
  pinnedRoot: PinnedProjectRoot,
  context: ExecutionClaimAdmissionVerificationContext,
): { ok: true } | { ok: false; error: string } {
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before claim admission verification" };
  const { feature_id: featureId, run_key: runKey, owner_run_id: ownerRunId, workspace, claim, handoff, mapping, verification_mode: verificationMode = "active" } = context;
  const admission = claim.admission_binding;
  if (!admission) return { ok: false, error: "CTO claim has no admission binding" };
  const mappingKeys: (keyof ExecutionClaimAdmissionBinding & keyof ExecutionClaimAdmissionMappingContext)[] = [
    "mapping_record_path",
    "mapping_record_digest",
    "mapping_id",
    "mapping_hash",
    "mapping_version",
    "checkpoint_ref",
    "trusted_answer_ref",
    "wave_id",
    "capability_id",
    "capability_epoch",
  ];
  if (mapping.selected_feature_id !== featureId || mapping.selected_run_key !== runKey) {
    return { ok: false, error: "CTO claim admission mapping selector does not match the selected feature/run" };
  }
  const expectedMappingPath = isSafeCtoRunId(ownerRunId) && isSafeCtoExecutionId(admission.mapping_id)
    ? `.work-state/cto/${ownerRunId}/specification-mappings/${admission.mapping_id}.json`
    : null;
  if (expectedMappingPath === null || admission.mapping_record_path !== expectedMappingPath) {
    return { ok: false, error: "CTO claim admission mapping record path is not canonical for its owner run" };
  }
  if (
    workspace.feature_id !== featureId
    || typeof admission.mapping_record_path !== "string"
    || admission.mapping_record_path.length === 0
    || workspace.execution_claim_ref !== claim.claim_id
    || workspace.handoff_ref !== handoff.handoff_id
    || handoff.handoff_digest !== claim.handoff_digest
    || claim.owner_kind !== "cto"
    || claim.owner_run_id !== ownerRunId
    || mappingKeys.some((key) => admission[key] !== mapping[key])
  ) return { ok: false, error: "CTO claim admission context does not match the selected workspace, handoff, owner, or mapping" };
  const verification = updateStateAtomically(
    pinnedRoot.canonical_root,
    (snapshot) => {
      const error = verifyClaimAdmissionBinding(snapshot, pinnedRoot, featureId, ownerRunId, admission, verificationMode);
      return error
        ? { op: "fail", code: "state_conflict", error } as const
        : { op: "discard", value: true } as const;
    },
    { selector: { feature_id: featureId, run_key: runKey }, branchNeutral: true, pinnedRoot },
  );
  if (!verification.ok) return { ok: false, error: verification.error };
  return pinnedRoot.isStable()
    ? { ok: true }
    : { ok: false, error: "project root changed after claim admission verification" };
}

type ExecutionClaimFailure = {
  ok: false;
  code: ExecutionClaimResultCode;
  error: string;
  claim?: ExecutionClaim;
};

type ExecutionClaimFailureWithClaim = ExecutionClaimFailure & { claim: ExecutionClaim };

export type ExecutionClaimAcquisitionDisposition = "created" | "replayed";

export type ExecutionClaimAcquisitionSuccess = {
  ok: true;
  value: ExecutionClaim;
  readonly disposition: ExecutionClaimAcquisitionDisposition;
};

export type ExecutionClaimAcquisitionResult = ExecutionClaimAcquisitionSuccess | ExecutionClaimFailure;

function failure(code: ExecutionClaimResultCode, error: string): ExecutionClaimFailure {
  return { ok: false, code, error };
}

function failureWithClaim(
  code: ExecutionClaimResultCode,
  error: string,
  claim: ExecutionClaim,
): ExecutionClaimFailureWithClaim {
  return { ok: false, code, error, claim };
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validAdmissionBinding(value: unknown): value is ExecutionClaimAdmissionBinding {
  if (!isRecord(value)
    || !isSafeRelativePath(value.mapping_record_path)
    || !isSha256Hex(value.mapping_record_digest)
    || !isSafeCtoExecutionId(value.mapping_id)
    || !isSha256Hex(value.mapping_hash)
    || !Number.isSafeInteger(value.mapping_version) || (value.mapping_version as number) < 1
    || !Number.isSafeInteger(value.confirmation_state_revision) || (value.confirmation_state_revision as number) < 0
    || !Number.isSafeInteger(value.feature_state_revision) || (value.feature_state_revision as number) < 0
    || !isSha256Hex(value.confirmation_authorization_digest)
    || !isSha256Hex(value.confirmation_ledger_digest)
    || !nonBlank(value.checkpoint_ref) || !nonBlank(value.trusted_answer_ref)
    || !nonBlank(value.stage_id) || !isSha256Hex(value.policy_hash)
    || !isSafeCtoExecutionId(value.wave_id)
    || !nonBlank(value.capability_id) || !nonBlank(value.capability_epoch)) return false;
  return true;
}

function sameAdmissionBinding(left: ExecutionClaimAdmissionBinding | undefined, right: ExecutionClaimAdmissionBinding | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return digestOf(left) === digestOf(right);
}

function confirmationLedgerDigest(state: TeamState): string {
  return digestOf({
    checkpoint_policy: state.checkpoint_policy ?? null,
    trusted_checkpoint_answers: state.trusted_checkpoint_answers ?? [],
  });
}

/** Canonical authorization projection fenced into CTO claim admission.
 *
 * This projection intentionally excludes state revision, raw serialization,
 * timestamps, and unrelated ledger entries. Any field that can authorize the
 * dispatch remains exact: feature/run, capability and stage, the selected
 * policy/rule, the complete trusted answer plus proof, constitution binding,
 * and the descriptor-bound project root identity.
 */
export interface ExecutionClaimAuthorizationProjectionInput {
  feature_id: string;
  run_key: string;
  stage_id: string;
  capability_id: string;
  capability_epoch: string;
  capability_stage_id: string | null;
  checkpoint_ref: string;
  trusted_answer_ref: string;
  checkpoint_policy: unknown;
  checkpoint_rule: unknown;
  trusted_answer: unknown;
  trusted_proof: CheckpointAnswerProof;
  constitution_binding: unknown;
  root_binding: unknown;
  mapping_id?: string;
  mapping_hash?: string;
  mapping_version?: number;
}

export function executionClaimAuthorizationProjectionDigest(
  input: ExecutionClaimAuthorizationProjectionInput,
): string {
  return digestOf({
    feature_run: { feature_id: input.feature_id, run_key: input.run_key },
    capability: {
      capability_id: input.capability_id,
      capability_epoch: input.capability_epoch,
      stage_id: input.capability_stage_id,
    },
    checkpoint: {
      stage_id: input.stage_id,
      checkpoint_ref: input.checkpoint_ref,
      trusted_answer_ref: input.trusted_answer_ref,
      policy: input.checkpoint_policy,
      rule: input.checkpoint_rule,
    },
    trusted_answer: input.trusted_answer,
    trusted_proof: input.trusted_proof,
    constitution_binding: input.constitution_binding,
    root_binding: input.root_binding,
    mapping: input.mapping_id === undefined ? undefined : {
      mapping_id: input.mapping_id,
      mapping_hash: input.mapping_hash,
      mapping_version: input.mapping_version,
    },
  });
}

/**
 * Digest only the workspace fields that authorize a claim. The persisted
 * state normalizer may add non-security bookkeeping fields, so callers and
 * the state-lock sink must share this stable projection rather than hashing
 * incidental serialization details.
 */
export function workspaceAdmissionDigest(workspace: FeatureWorkspace, canonicalRoot?: string): string {
  return digestOf({
    feature_id: workspace.feature_id,
    project_root: canonicalRoot ?? workspace.project_root,
    project_root_identity: {
      canonical_path: canonicalRoot ?? workspace.project_root_identity.canonical_path,
      dev: workspace.project_root_identity.dev,
      ino: workspace.project_root_identity.ino,
    },
    workspace_path: workspace.workspace_path,
    state_path: workspace.state_path,
    source_kind: workspace.source_kind,
    status: workspace.status,
    handoff_ref: workspace.handoff_ref,
    constitution_gate_ref: workspace.constitution_gate_ref,
    constitution_binding: workspace.constitution_binding,
    import_ref: workspace.import_ref,
    phases: workspace.phases.map((phase) => ({
      phase: phase.phase,
      status: phase.status,
      current_version: phase.current_version,
      approved_version: phase.approved_version,
      validation_ref: phase.validation_ref,
      checkpoint_ref: phase.checkpoint_ref,
      upstream_versions: phase.upstream_versions,
    })),
  });
}
function timestamp(value: unknown, field: string): ExecutionClaimResult<string> {
  if (value !== undefined && !nonBlank(value)) {
    return failure("SPEC_STATE_INVALID", `${field} must be a non-blank string when provided`);
  }
  return { ok: true, value: value === undefined ? new Date().toISOString() : value };
}

function validClaim(claim: unknown): ExecutionClaimResult<ExecutionClaim> {
  const validation = validateExecutionClaim(claim);
  if (!validation.ok) {
    return failure("SPEC_STATE_INVALID", `execution claim is invalid: ${validation.issues.join("; ")}`);
  }
  return { ok: true, value: claim as ExecutionClaim };
}


function ownerDescription(claim: ExecutionClaim): string {
  return `${claim.owner_kind} owner '${claim.owner_run_id}' (claim '${claim.claim_id}', status '${claim.status}')`;
}

function validateClaimStore(claims: readonly ExecutionClaim[]): ExecutionClaimResult<readonly ExecutionClaim[]> {
  for (let index = 0; index < claims.length; index += 1) {
    const validation = validateExecutionClaim(claims[index]);
    if (!validation.ok) {
      return failure(
        "SPEC_STATE_INVALID",
        `execution claim store entry ${index} is invalid: ${validation.issues.join("; ")}`,
      );
    }
  }
  return { ok: true, value: claims };
}

function newClaimId(
  handoffDigest: string,
  ownerKind: ExecutionClaimOwnerKind,
  ownerRunId: string,
  claims: readonly ExecutionClaim[],
): string {
  const priorClaimIds = claims
    .filter((claim) => claim.handoff_digest === handoffDigest)
    .map((claim) => claim.claim_id)
    .sort();
  return `claim-${digestOf({
    handoff_digest: handoffDigest,
    owner_kind: ownerKind,
    owner_run_id: ownerRunId,
    prior_claim_ids: priorClaimIds,
  }).slice(0, 32)}`;
}

/**
 * Acquires the one exclusive claim for a ready handoff digest. The supplied
 * claim records are the complete decision input; this function never persists
 * or mutates them.
 */
function computeExecutionClaim(request: ExecutionClaimRequest & { active_claims?: readonly ExecutionClaim[] }): ExecutionClaimResult<ExecutionClaim> {
  const readiness = evaluateHandoffReadiness(request.handoff);
  if (!readiness.ok) {
    return failure(
      readiness.code === "SPEC_STALE" ? "SPEC_STALE" : "SPEC_HANDOFF_NOT_READY",
      readiness.error,
    );
  }
  if (request.owner_kind !== "do_work" && request.owner_kind !== "cto") {
    return failure("SPEC_STATE_INVALID", "owner_kind must be 'do_work' or 'cto'");
  }
  if (!nonBlank(request.owner_run_id)) {
    return failure("SPEC_STATE_INVALID", "owner_run_id must be a non-blank string");
  }
  if (request.active_claims !== undefined && !Array.isArray(request.active_claims)) {
    return failure("SPEC_STATE_INVALID", "active_claims must be an array when provided");
  }

  const claims = request.active_claims ?? [];
  const storeValidation = validateClaimStore(claims);
  if (!storeValidation.ok) return storeValidation;

  const live = claims.filter((claim) => claim.handoff_digest === request.handoff.handoff_digest && isLiveExecutionClaim(claim));
  if (live.length > 1) {
    return failure(
      "SPEC_EXECUTION_CLAIMED",
      `handoff digest '${request.handoff.handoff_digest}' has contested live ownership: ${live.map(ownerDescription).join(", ")}`,
    );
  }
  if (live.length === 1) {
    const established = live[0]!;
    if (
      established.owner_kind === request.owner_kind
      && established.owner_run_id === request.owner_run_id
    ) {
      return { ok: true, value: { ...established } };
    }
    return failure(
      "SPEC_EXECUTION_CLAIMED",
      `handoff digest '${request.handoff.handoff_digest}' is already claimed by ${ownerDescription(established)}`,
    );
  }

  const acquiredAt = timestamp(request.acquired_at, "acquired_at");
  if (!acquiredAt.ok) return acquiredAt;
  const claim: ExecutionClaim = {
    claim_id: newClaimId(
      request.handoff.handoff_digest,
      request.owner_kind,
      request.owner_run_id,
      claims,
    ),
    handoff_digest: request.handoff.handoff_digest,
    owner_kind: request.owner_kind,
    owner_run_id: request.owner_run_id,
    status: "active",
    acquired_at: acquiredAt.value,
    updated_at: acquiredAt.value,
    release_reason: null,
    ...(request.admission_binding ? { admission_binding: { ...request.admission_binding } } : {}),
  };
  const validation = validateExecutionClaim(claim);
  if (!validation.ok) {
    return failure("SPEC_STATE_INVALID", `acquired execution claim is invalid: ${validation.issues.join("; ")}`);
  }
  return { ok: true, value: claim };
}

/** Releases active or blocked ownership; completed and released claims are terminal. */
function computeReleaseExecutionClaim(input: { claim: ExecutionClaim; reason: string; updated_at?: string }): ExecutionClaimResult<ExecutionClaim> {
  const checked = validClaim(input.claim);
  if (!checked.ok) return checked;
  if (!nonBlank(input.reason)) {
    return failure("SPEC_STATE_INVALID", "release requires an explicit non-blank reason");
  }
  if (checked.value.status !== "active" && checked.value.status !== "blocked") {
    return failure(
      "SPEC_STATE_INVALID",
      `claim '${checked.value.claim_id}' cannot be released from status '${checked.value.status}'`,
    );
  }
  const updatedAt = timestamp(input.updated_at, "updated_at");
  if (!updatedAt.ok) return updatedAt;
  return {
    ok: true,
    value: {
      ...checked.value,
      status: "released",
      updated_at: updatedAt.value,
      release_reason: input.reason.trim(),
    },
  };
}

/** Blocks an active claim while retaining its exclusive owner and digest. */
function computeBlockExecutionClaim(input: { claim: ExecutionClaim; reason: string; updated_at?: string }): ExecutionClaimResult<ExecutionClaim> {
  const checked = validClaim(input.claim);
  if (!checked.ok) return checked;
  if (!nonBlank(input.reason)) {
    return failure("SPEC_STATE_INVALID", "blocking requires an explicit non-blank reason");
  }
  if (checked.value.status !== "active") {
    return failure(
      "SPEC_STATE_INVALID",
      `claim '${checked.value.claim_id}' cannot be blocked from status '${checked.value.status}'`,
    );
  }
  const updatedAt = timestamp(input.updated_at, "updated_at");
  if (!updatedAt.ok) return updatedAt;
  return {
    ok: true,
    value: {
      ...checked.value,
      status: "blocked",
      updated_at: updatedAt.value,
      release_reason: input.reason.trim(),
    },
  };
}

/** Completes only an active claim with exact-bound, structurally passing conformance. */
function computeCompleteExecutionClaim(input: { claim: ExecutionClaim; conformance: ImplementationConformanceResult; updated_at?: string }): ExecutionClaimResult<ExecutionClaim> {
  const checked = validClaim(input.claim);
  if (!checked.ok) return checked;
  if (checked.value.status !== "active") {
    return failure(
      "SPEC_STATE_INVALID",
      `claim '${checked.value.claim_id}' cannot be completed from status '${checked.value.status}'`,
    );
  }

  if (!isRecord(input.conformance)) {
    return failure(
      "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED",
      "implementation conformance must be a canonical record",
    );
  }
  const conformance = input.conformance;
  const bindingsMatch =
    conformance.execution_claim_id === checked.value.claim_id
    && conformance.handoff_digest === checked.value.handoff_digest
    && conformance.execution_owner === checked.value.owner_kind
    && conformance.execution_run_id === checked.value.owner_run_id;
  if (!bindingsMatch) {
    return failure(
      "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED",
      `implementation conformance does not match claim '${checked.value.claim_id}', handoff digest, owner, and run`,
    );
  }
  if (conformance.overall_status === "changed_intent") {
    return failure(
      "SPEC_IMPLEMENTATION_INTENT_CHANGED",
      "implementation conformance reports changed intent; the claim remains active until explicitly blocked",
    );
  }
  const conformanceValidation = validateImplementationConformance(conformance);
  if (!conformanceValidation.ok) {
    return failure(
      "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED",
      `implementation conformance is invalid: ${conformanceValidation.issues.join("; ")}`,
    );
  }
  if (conformance.overall_status !== "pass") {
    return failure(
      "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED",
      "implementation conformance must pass before the execution claim can complete",
    );
  }

  const updatedAt = timestamp(input.updated_at ?? conformance.evaluated_at, "updated_at");
  if (!updatedAt.ok) return updatedAt;
  return {
    ok: true,
    value: {
      ...checked.value,
      status: "completed",
      updated_at: updatedAt.value,
      release_reason: null,
    },
  };
}


// ── Durable claim authority journal ─────────────────────────────────────────
interface ClaimJournalEnvelope {
  schema: 1 | 2;
  previous_digest: string | null;
  claim: ExecutionClaim;
  transaction_id?: string;
  operation?: "active" | "completed";
}
interface ClaimJournal {
  envelopes: ClaimJournalEnvelope[];
  claims: ExecutionClaim[];
  tail: ClaimJournalEnvelope | null;
  relative_dir: string;
  pinnedRoot: PinnedProjectRoot;
  manifest: ClaimJournalManifest | null;
}
const CLAIM_TMP_RE = /^(?:\.claim\.[A-Za-z0-9-]+\.tmp|\.claim-lock-[A-Za-z0-9-]+\.tmp)$/u;
const CLAIM_WAL_RE = /^[a-z0-9][a-z0-9-]{7,127}\.json$/;
const MAX_CLAIM_BYTES = 1024 * 1024;
const MAX_CLAIM_ENTRIES = 4096;
const MAX_CLAIM_NAME_BYTES = 4 * 1024 * 1024;
const MAX_CLAIM_NODES = 4096;
const MAX_CLAIM_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_CLAIM_WAL_RECORDS = 64;
const MAX_CLAIM_WAL_FILE_BYTES = 512 * 1024;
const MAX_CLAIM_WAL_AGGREGATE_BYTES = 4 * 1024 * 1024;
const MAX_CLAIM_WAL_JSON_DEPTH = 32;
const MAX_CLAIM_WAL_JSON_NODES = 12_000;
const MAX_CLAIM_WAL_JSON_KEYS = 128;
const MAX_CLAIM_WAL_JSON_ARRAY = 256;
const MAX_CLAIM_WAL_TEXT_BYTES = 256 * 1024;
const MAX_CLAIM_WAL_JSON_WORK = 1_048_576;
const MAX_CLAIM_WAL_READ_MS = 30_000;
const MAX_CLAIM_WAL_DIRECTORY_ENTRIES = MAX_CLAIM_WAL_RECORDS + 32;
const MAX_CLAIM_WAL_NAME_BYTES = 256;
// Keep the descriptor captured while a validated WAL record was read. Cleanup
// must compare that exact inode rather than re-opening a possibly replaced
// pathname later in the retry.
const claimWalReadExpectations = new WeakMap<ClaimPreparedWal, PinnedRootFileExpectation>();
const CLAIM_MANIFEST_KEYS = [
  "schema", "feature_id", "project_root_identity", "workspace_path_binding_digest",
  "claim_directory_identity", "next_directory_identity", "journal_format", "legacy_tail_digest",
] as const;
const CLAIM_ACQUIRE_WAL_KEYS = new Set([
  "schema", "operation", "transaction_id", "claim", "feature_id", "run_key", "handoff_ref",
  "expected_workspace_digest", "previous_digest", "workspace_path_binding_digest",
  "project_root_identity", "path_binding", "created_at",
]);
const CLAIM_COMPLETE_WAL_KEYS = new Set([
  "schema", "operation", "transaction_id", "claim", "conformance_ref",
  "conformance_artifact_digest", "matrix_digest", "expected_workspace_digest",
  "completed_workspace_digest", "workspace_path_binding_digest", "project_root_identity",
  "path_binding", "created_at",
]);
function checkedEnvelope(value: unknown, previous: string | null): ExecutionClaimResult<ClaimJournalEnvelope> {
  if (!isRecord(value) || (value.schema !== 1 && value.schema !== 2) || value.previous_digest !== previous) {
    return failure("SPEC_STATE_INVALID", "claim journal envelope has invalid predecessor binding");
  }
  const allowed = value.schema === 1 ? ["schema", "previous_digest", "claim"] : ["schema", "transaction_id", "operation", "previous_digest", "claim"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return failure("SPEC_STATE_INVALID", "claim journal envelope contains unsupported fields");
  if (value.schema === 2 && (!nonBlank(value.transaction_id) || (value.operation !== "active" && value.operation !== "completed"))) {
    return failure("SPEC_STATE_INVALID", "schema-2 claim envelope transaction metadata is invalid");
  }
  const valid = validateExecutionClaim(value.claim);
  if (!valid.ok) return failure("SPEC_STATE_INVALID", valid.issues.join("; "));
  const claim = value.claim as unknown as ExecutionClaim;
  if (value.schema === 2 && value.operation === "active" && claim.status !== "active" && claim.status !== "blocked" && claim.status !== "released") {
    return failure("SPEC_STATE_INVALID", "active claim envelope must carry an active, blocked, or released claim");
  }
  if (value.schema === 2 && value.operation === "completed" && claim.status !== "completed") {
    return failure("SPEC_STATE_INVALID", "completed claim envelope must carry a completed claim");
  }
  return { ok: true, value: value as unknown as ClaimJournalEnvelope };
}
function journalDigest(value: ClaimJournalEnvelope): string { return digestOf(value); }
function pinnedClaimFailure(error: unknown, context: string): ExecutionClaimResult<never> {
  if (error instanceof PinnedRootError) {
    if (error.code === "path_unauthorized" || error.code === "changed" || error.code === "unsupported") return failure("SPEC_PATH_UNAUTHORIZED", `${context}: ${error.message}`);
    return failure("SPEC_STATE_INVALID", `${context}: ${error.message}`);
  }
  return failure("SPEC_STATE_INVALID", `${context}: ${String(error)}`);
}

function manifestFor(pinnedRoot: PinnedProjectRoot, featureId: string, binding: WorkspacePathBinding): ClaimJournalManifest {
  const rootIdentity = { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino };
  return {
    schema: 2,
    feature_id: featureId,
    project_root_identity: rootIdentity,
    workspace_path_binding_digest: workspacePathBindingDigest(binding),
    claim_directory_identity: { ...binding.execution_claim! },
    next_directory_identity: { ...binding.execution_claim_next! },
    journal_format: "legacy-chain-v1+wal-v2",
    legacy_tail_digest: null,
  };
}

function readOrCreateManifest(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  relativeDir: string,
  create: boolean,
  capturedPathBinding?: WorkspacePathBinding,
): ExecutionClaimResult<ClaimJournalManifest | null> {
  const manifestPath = `${relativeDir}/manifest.json`;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      pinnedRoot.readFile(manifestPath, { maxBytes: MAX_CLAIM_BYTES }).bytes,
    )) as unknown;
    if (!isRecord(parsed)
      || Object.keys(parsed).length !== CLAIM_MANIFEST_KEYS.length
      || CLAIM_MANIFEST_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(parsed, key))
      || parseBoundedPersistedState(parsed) === null
      || parsed.schema !== 2
      || parsed.feature_id !== featureId
      || parsed.journal_format !== "legacy-chain-v1+wal-v2"
      || (parsed.legacy_tail_digest !== null && !isSha256Hex(parsed.legacy_tail_digest))) {
      return failure("SPEC_STATE_INVALID", "claim manifest is malformed");
    }
    const binding = capturedPathBinding ?? captureWorkspacePathBinding(pinnedRoot, featureId);
    const expected = manifestFor(pinnedRoot, featureId, binding);
    if (digestOf(parsed) !== digestOf({ ...expected, legacy_tail_digest: parsed.legacy_tail_digest ?? null })) return failure("SPEC_STATE_INVALID", "claim manifest identity does not match the pinned workspace");
    return { ok: true, value: parsed as unknown as ClaimJournalManifest };
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") {
      if (!create) return { ok: true, value: null };
      const binding = capturedPathBinding ?? captureWorkspacePathBinding(pinnedRoot, featureId);
      const manifest = manifestFor(pinnedRoot, featureId, binding);
      pinnedRoot.writeExclusive(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: true, value: manifest };
    }
    if (error instanceof PinnedRootError && error.code === "exists") return readOrCreateManifest(pinnedRoot, featureId, relativeDir, false, capturedPathBinding);
    return pinnedClaimFailure(error, `claim manifest for '${featureId}' cannot be opened`);
  }
}

function loadPinnedClaimJournal(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  create: boolean,
  capturedPathBinding?: WorkspacePathBinding,
): ExecutionClaimResult<ClaimJournal> {
  if (!isSafeFeatureId(featureId)) return failure("SPEC_PATH_UNAUTHORIZED", `unsafe feature id ${JSON.stringify(featureId)}`);
  const relativeDir = `.work-state/features/${featureId}/artifacts/execution_claim`;
  const empty = (manifest: ClaimJournalManifest | null = null): ExecutionClaimResult<ClaimJournal> => ({ ok: true, value: { relative_dir: relativeDir, envelopes: [], claims: [], tail: null, pinnedRoot, manifest } });
  let entries: string[];
  try {
    if (create) pinnedRoot.ensureDirectory(`${relativeDir}/wal`);
    entries = pinnedRoot.listDirectory(relativeDir, { maxEntries: MAX_CLAIM_ENTRIES, maxNameBytes: MAX_CLAIM_NAME_BYTES });
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found" && !create) return empty();
    return pinnedClaimFailure(error, `claim store for '${featureId}' cannot be opened`);
  }
  const manifestResult = readOrCreateManifest(pinnedRoot, featureId, relativeDir, create, capturedPathBinding);
  if (!manifestResult.ok) return manifestResult;
  const manifest = manifestResult.value;
  try {
    for (const name of entries) if (name !== "root.json" && name !== "next" && name !== "manifest.json" && name !== "wal" && name !== "claim.lock" && !CLAIM_TMP_RE.test(name)) return failure("SPEC_STATE_INVALID", `unknown claim journal entry '${name}'`);
    const rootName = "root.json";
    const nextRelative = `${relativeDir}/next`;
    let nextEntries: string[] = [];
    try { nextEntries = pinnedRoot.listDirectory(nextRelative, { maxEntries: MAX_CLAIM_ENTRIES, maxNameBytes: MAX_CLAIM_NAME_BYTES }); }
    catch (error) { if (!(error instanceof PinnedRootError && error.code === "not_found")) return pinnedClaimFailure(error, `claim successor directory for '${featureId}' is unreadable`); }
    const nextNames = new Set(nextEntries);
    if (!entries.includes(rootName)) {
      if (nextEntries.some((name) => !CLAIM_TMP_RE.test(name))) return failure("SPEC_STATE_INVALID", "claim successors exist without a root");
      return empty(manifest);
    }
    const readEnvelope = (relativePath: string): ExecutionClaimResult<{ envelope: ClaimJournalEnvelope; bytes: number }> => {
      try {
        const source = pinnedRoot.readFile(relativePath, { maxBytes: MAX_CLAIM_BYTES });
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes));
        if (parseBoundedPersistedState(parsed) === null) {
          return failure("SPEC_STATE_INVALID", `claim journal entry '${relativePath}' exceeds bounded JSON limits`);
        }
        return { ok: true, value: { envelope: parsed as ClaimJournalEnvelope, bytes: source.bytes.byteLength } };
      } catch (error) { return pinnedClaimFailure(error, `claim journal entry '${relativePath}' is unreadable`); }
    };
    const envelopes: ClaimJournalEnvelope[] = [], visited = new Set<string>();
    let path = `${relativeDir}/${rootName}`, previous: string | null = null, journalBytes = 0;
    for (let depth = 0; depth < MAX_CLAIM_NODES; depth += 1) {
      const parsed = readEnvelope(path); if (!parsed.ok) return parsed;
      journalBytes += parsed.value.bytes;
      if (journalBytes > MAX_CLAIM_JOURNAL_BYTES) return failure("SPEC_STATE_INVALID", "claim journal exceeds its byte bound");
      const checked = checkedEnvelope(parsed.value.envelope, previous); if (!checked.ok) return checked;
      envelopes.push(checked.value);
      const digest = journalDigest(checked.value), name = `${digest}.json`;
      if (!nextNames.has(name)) break;
      visited.add(name); previous = digest; path = `${nextRelative}/${name}`;
      if (depth === MAX_CLAIM_NODES - 1) return failure("SPEC_STATE_INVALID", "claim journal exceeds its traversal bound");
    }
    for (const name of nextEntries.sort()) if (!CLAIM_TMP_RE.test(name) && (!/^[a-f0-9]{64}\.json$/u.test(name) || !visited.has(name))) return failure("SPEC_STATE_INVALID", `unreachable claim successor '${name}'`);
    const latest = new Map<string, ExecutionClaim>();
    for (const item of envelopes) latest.set(item.claim.claim_id, item.claim);
    return { ok: true, value: { relative_dir: relativeDir, envelopes, claims: [...latest.values()], tail: envelopes.at(-1) ?? null, pinnedRoot, manifest } };
  } catch (error) { return pinnedClaimFailure(error, `claim store for '${featureId}' is unreadable`); }
}
function loadClaimJournal(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  create: boolean,
  capturedPathBinding?: WorkspacePathBinding,
): ExecutionClaimResult<ClaimJournal> {
  return loadPinnedClaimJournal(pinnedRoot, featureId, create, capturedPathBinding);
}
function appendClaim(
  journal: ClaimJournal,
  claim: ExecutionClaim,
  transactionId = `transition-${digestOf({ claim, previous: journal.tail ? journalDigest(journal.tail) : null }).slice(0, 48)}`,
  operation: "active" | "completed" = claim.status === "completed" ? "completed" : "active",
  beforeWrite?: () => void,
  onReceipt?: (receipt: PinnedRootWriteReceipt) => void,
): ExecutionClaimResult<ClaimJournalEnvelope> & { receipt?: PinnedRootWriteReceipt } {
  const pinnedRoot = journal.pinnedRoot;
  const relativeDir = journal.relative_dir;
  const previous = journal.tail ? journalDigest(journal.tail) : null;
  const value: ClaimJournalEnvelope = { schema: 2, transaction_id: transactionId, operation, previous_digest: previous, claim };
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (parseBoundedPersistedState(value) === null) {
    return failure("SPEC_CLAIM_PERSIST_FAILED", "claim journal envelope exceeds bounded JSON limits");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_CLAIM_BYTES) {
    return failure("SPEC_CLAIM_PERSIST_FAILED", `claim journal envelope exceeds its ${MAX_CLAIM_BYTES}-byte file bound`);
  }
  const relativeTarget = previous ? `${relativeDir}/next/${previous}.json` : `${relativeDir}/root.json`;
  try {
    beforeWrite?.();
    let receipt: PinnedRootWriteReceipt | undefined;
    if (onReceipt) {
      receipt = pinnedRoot.writeExclusiveWithReceipt(relativeTarget, body);
      try { onReceipt(receipt); } catch (error) {
        receipt.rollback();
        throw error;
      }
    } else {
      pinnedRoot.writeExclusive(relativeTarget, body);
    }
    return { ok: true, value, ...(receipt ? { receipt } : {}) };
  } catch (error) {
    if (!pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", `claim CAS cannot commit safely: project root changed`);
    if (error instanceof PinnedRootError && error.code === "exists") return failure("SPEC_EXECUTION_CLAIMED", `claim CAS target already exists: ${relativeTarget}`);
    if (error instanceof PinnedRootError && (error.code === "path_unauthorized" || error.code === "changed" || error.code === "unsupported")) return failure("SPEC_PATH_UNAUTHORIZED", `claim CAS cannot commit safely: ${error.message}`);
    return failure("SPEC_CLAIM_PERSIST_FAILED", `claim CAS failed: ${String(error)}`);
  }
}

function walRelativePath(journal: ClaimJournal, transactionId: string): string {
  return `${journal.relative_dir}/wal/${transactionId}.json`;
}

function deterministicClaimId(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  request: ExecutionClaimRequest,
): string {
  return `claim-${digestOf({
    feature_id: featureId,
    run_key: request.run_key,
    owner_kind: request.owner_kind,
    owner_run_id: request.owner_run_id,
    handoff_ref: request.handoff.handoff_id,
    handoff_digest: request.handoff.handoff_digest,
    admission_binding: request.admission_binding ?? null,
    root: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
  }).slice(0, 32)}`;
}
function deterministicTransactionId(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  request: ExecutionClaimRequest,
  expectedWorkspaceDigest: string,
): string {
  return `acquire-${digestOf({
    feature_id: featureId,
    run_key: request.run_key,
    owner_kind: request.owner_kind,
    owner_run_id: request.owner_run_id,
    handoff_ref: request.handoff.handoff_id,
    handoff_digest: request.handoff.handoff_digest,
    admission_binding: request.admission_binding ?? null,
    expected_workspace_digest: expectedWorkspaceDigest,
    root: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
  }).slice(0, 48)}`;
}

function writePreparedWal(journal: ClaimJournal, wal: ClaimPreparedWal, beforeWrite?: () => void): ExecutionClaimResult<ClaimPreparedWal> & { wal_receipt?: PinnedRootWriteReceipt } {
  const path = walRelativePath(journal, wal.transaction_id);
  const body = `${JSON.stringify(wal, null, 2)}\n`;
  const jsonBudget: ClaimWalJsonBudget = {
    nodes: 0,
    max_nodes: MAX_CLAIM_WAL_JSON_NODES,
    text_bytes: 0,
    max_text_bytes: MAX_CLAIM_WAL_FILE_BYTES,
    deadline_ms: Date.now() + MAX_CLAIM_WAL_READ_MS,
  };
  if (!boundedClaimWalJson(wal, 0, jsonBudget)) {
    return failure("SPEC_CLAIM_PERSIST_FAILED", `claim WAL '${wal.transaction_id}' exceeds bounded JSON limits`);
  }
  if (Buffer.byteLength(body, "utf8") > MAX_CLAIM_WAL_FILE_BYTES) {
    return failure("SPEC_CLAIM_PERSIST_FAILED", `claim WAL '${wal.transaction_id}' exceeds its ${MAX_CLAIM_WAL_FILE_BYTES}-byte file bound`);
  }
  try {
    beforeWrite?.();
    const receipt = journal.pinnedRoot.writeExclusiveWithReceipt(path, body);
    return { ok: true, value: wal, wal_receipt: receipt };
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "exists") {
      try {
        const existingSource = journal.pinnedRoot.readFile(path, { maxBytes: MAX_CLAIM_WAL_FILE_BYTES });
        const existing = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(existingSource.bytes)) as unknown;
        const checked = validateClaimWalRecord(existing, `${wal.transaction_id}.json`);
        if (!checked.ok) return checked;
        if (digestOf(checked.value) === digestOf(wal)) return { ok: true, value: checked.value };
        return failure("SPEC_STATE_INVALID", `claim WAL transaction '${wal.transaction_id}' collides with different content`);
      } catch (readError) { return pinnedClaimFailure(readError, `claim WAL '${wal.transaction_id}' cannot be replayed`); }
    }
    if (!journal.pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", "claim WAL cannot be committed safely: project root changed");
    if (error instanceof PinnedRootError && (error.code === "path_unauthorized" || error.code === "changed")) return failure("SPEC_PATH_UNAUTHORIZED", `claim WAL cannot be committed safely: ${error.message}`);
    return failure("SPEC_CLAIM_PERSIST_FAILED", `claim WAL write failed: ${String(error)}`);
  }
}

type ClaimWalJsonBudget = {
  nodes: number;
  max_nodes: number;
  text_bytes: number;
  max_text_bytes: number;
  deadline_ms: number;
};

function boundedClaimWalJson(value: unknown, depth: number, budget: ClaimWalJsonBudget): boolean {
  if (Date.now() > budget.deadline_ms || ++budget.nodes > budget.max_nodes || depth > MAX_CLAIM_WAL_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    budget.text_bytes += bytes;
    return bytes <= MAX_CLAIM_WAL_TEXT_BYTES && budget.text_bytes <= budget.max_text_bytes;
  }
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Array.isArray(value)) {
    if (value.length > MAX_CLAIM_WAL_JSON_ARRAY) return false;
    return value.every((item) => boundedClaimWalJson(item, depth + 1, budget));
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length > MAX_CLAIM_WAL_JSON_KEYS) return false;
  for (const key of keys) {
    const keyBytes = Buffer.byteLength(key, "utf8");
    budget.text_bytes += keyBytes;
    if (keyBytes > MAX_CLAIM_WAL_TEXT_BYTES || budget.text_bytes > budget.max_text_bytes
      || !boundedClaimWalJson(object[key], depth + 1, budget)) return false;
  }
  return true;
}

function validateClaimWalRecord(
  value: unknown,
  filename: string,
  jsonBudget?: ClaimWalJsonBudget,
): ExecutionClaimResult<ClaimPreparedWal> {
  if (!isRecord(value) || value.schema !== 1 || (value.operation !== "acquire_prepared" && value.operation !== "complete_prepared")) {
    return failure("SPEC_STATE_INVALID", `claim WAL '${filename}' is malformed`);
  }
  const allowedKeys = value.operation === "acquire_prepared" ? CLAIM_ACQUIRE_WAL_KEYS : CLAIM_COMPLETE_WAL_KEYS;
  const keys = Object.keys(value);
  if (keys.some((key) => !allowedKeys.has(key)) || [...allowedKeys].some((key) => !Object.hasOwn(value, key))) {
    return failure("SPEC_STATE_INVALID", `claim WAL '${filename}' has an invalid schema`);
  }
  const budget = jsonBudget ?? {
    nodes: 0,
    max_nodes: MAX_CLAIM_WAL_JSON_NODES,
    text_bytes: 0,
    max_text_bytes: MAX_CLAIM_WAL_FILE_BYTES,
    deadline_ms: Date.now() + MAX_CLAIM_WAL_READ_MS,
  };
  if (!boundedClaimWalJson(value, 0, budget)) {
    return failure("SPEC_STATE_INVALID", `claim WAL '${filename}' exceeds bounded JSON schema/work limits`);
  }
  if (!nonBlank(value.transaction_id) || `${value.transaction_id}.json` !== filename) {
    return failure("SPEC_STATE_INVALID", `claim WAL '${filename}' has an invalid transaction id`);
  }
  const claimCheck = validateExecutionClaim(value.claim);
  if (!claimCheck.ok) return failure("SPEC_STATE_INVALID", `claim WAL '${filename}' claim is invalid: ${claimCheck.issues.join("; ")}`);
  const claim = value.claim as unknown as ExecutionClaim;
  const root = value.project_root_identity;
  if (!isRecord(root) || typeof root.canonical_path !== "string" || !root.canonical_path.startsWith("/")
    || !Number.isSafeInteger(root.dev) || (root.dev as number) < 0
    || !Number.isSafeInteger(root.ino) || (root.ino as number) < 0) {
    return failure("SPEC_STATE_INVALID", `claim WAL '${filename}' root identity is invalid`);
  }
  const binding = value.path_binding;
  const featureId = isRecord(binding) && isRecord(binding.feature_state)
    && typeof binding.feature_state.relative_path === "string"
    ? binding.feature_state.relative_path.split("/").at(-1) ?? ""
    : "";
  if (!isSafeFeatureId(featureId)) return failure("SPEC_STATE_INVALID", `claim WAL '${filename}' path binding has no safe feature identity`);
  const bindingCheck = validateWorkspacePathBinding(binding, featureId);
  if (!bindingCheck.ok) return failure("SPEC_STATE_INVALID", `claim WAL '${filename}' path binding is invalid: ${bindingCheck.issues.join("; ")}`);
  if (!isSha256Hex(value.workspace_path_binding_digest)
    || value.workspace_path_binding_digest !== workspacePathBindingDigest(binding as unknown as WorkspacePathBinding)
    || !nonBlank(value.created_at)) {
    return failure("SPEC_STATE_INVALID", `claim WAL '${filename}' binding or timestamp is invalid`);
  }
  if (value.operation === "acquire_prepared") {
    if (value.feature_id !== featureId || !nonBlank(value.run_key) || !isSafeRelativePath(value.handoff_ref)
      || !isSha256Hex(value.expected_workspace_digest)
      || (value.previous_digest !== null && !isSha256Hex(value.previous_digest))
      || claim.status !== "active") {
      return failure("SPEC_STATE_INVALID", `claim WAL '${filename}' acquire record is invalid`);
    }
    return { ok: true, value: value as unknown as AcquireClaimPreparedWal };
  }
  if (!isSafeFeatureId(value.conformance_ref)
    || !isSha256Hex(value.conformance_artifact_digest)
    || !isSha256Hex(value.matrix_digest)
    || !isSha256Hex(value.expected_workspace_digest)
    || !isSha256Hex(value.completed_workspace_digest)
    || claim.status !== "completed") {
    return failure("SPEC_STATE_INVALID", `claim WAL '${filename}' completion record is invalid`);
  }
  return { ok: true, value: value as unknown as CompleteClaimPreparedWal };
}

function readWalRecords(journal: ClaimJournal): ExecutionClaimResult<ClaimPreparedWal[]> {
  let names: string[];
  const walDirectory = `${journal.relative_dir}/wal`;
  try { names = journal.pinnedRoot.listDirectory(walDirectory, { maxEntries: MAX_CLAIM_WAL_DIRECTORY_ENTRIES, maxNameBytes: MAX_CLAIM_WAL_NAME_BYTES }); }
  catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return { ok: true, value: [] };
    return pinnedClaimFailure(error, "claim WAL directory is unreadable");
  }
  const walNames = names
    .filter((name) => !CLAIM_TMP_RE.test(name))
    .sort();
  if (walNames.length > MAX_CLAIM_WAL_RECORDS) {
    return failure("SPEC_STATE_INVALID", `claim WAL transaction count exceeds ${MAX_CLAIM_WAL_RECORDS}`);
  }
  for (const name of walNames) {
    if (!CLAIM_WAL_RE.test(name)) return failure("SPEC_STATE_INVALID", `unknown claim WAL entry '${name}'`);
  }
  const deadlineMs = Date.now() + MAX_CLAIM_WAL_READ_MS;
  const sources: Array<{ name: string; bytes: Uint8Array; dev: number; ino: number }> = [];
  let aggregateBytes = 0;
  for (const name of walNames) {
    if (Date.now() > deadlineMs) return failure("SPEC_STATE_INVALID", "claim WAL read work exceeded its time bound");
    const relativePath = `${walDirectory}/${name}`;
    try {
      const entry = journal.pinnedRoot.pathEntryInfo(relativePath);
      if (!entry) return failure("SPEC_STATE_INVALID", `claim WAL entry '${name}' disappeared while it was being read`);
      if (entry.kind !== "file") return failure("SPEC_PATH_UNAUTHORIZED", `claim WAL entry '${name}' is not a regular file`);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_CLAIM_WAL_FILE_BYTES) {
        return failure("SPEC_STATE_INVALID", `claim WAL entry '${name}' exceeds its per-file byte bound`);
      }
      aggregateBytes += entry.size;
      if (aggregateBytes > MAX_CLAIM_WAL_AGGREGATE_BYTES) {
        return failure("SPEC_STATE_INVALID", `claim WAL aggregate exceeds ${MAX_CLAIM_WAL_AGGREGATE_BYTES} bytes`);
      }
      const source = journal.pinnedRoot.readFile(relativePath, { maxBytes: MAX_CLAIM_WAL_FILE_BYTES });
      if (source.bytes.byteLength > MAX_CLAIM_WAL_FILE_BYTES) {
        return failure("SPEC_STATE_INVALID", `claim WAL entry '${name}' exceeds its per-file byte bound`);
      }
      if (!journal.pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", "project root changed while reading claim WAL");
      sources.push({ name, bytes: source.bytes, dev: source.dev, ino: source.ino });
    } catch (error) {
      return pinnedClaimFailure(error, `claim WAL '${name}' is unreadable`);
    }
  }
  const parseBudget: ClaimWalJsonBudget = {
    nodes: 0,
    max_nodes: MAX_CLAIM_WAL_JSON_WORK,
    text_bytes: 0,
    max_text_bytes: MAX_CLAIM_WAL_AGGREGATE_BYTES,
    deadline_ms: deadlineMs,
  };
  const records: ClaimPreparedWal[] = [];
  for (const source of sources) {
    if (Date.now() > deadlineMs) return failure("SPEC_STATE_INVALID", "claim WAL parse work exceeded its time bound");
    try {
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
      const parsed = JSON.parse(raw) as unknown;
      const checked = validateClaimWalRecord(parsed, source.name, parseBudget);
      if (!checked.ok) return checked;
      claimWalReadExpectations.set(checked.value, {
        dev: source.dev,
        ino: source.ino,
        size: source.bytes.byteLength,
        sha256: createHash("sha256").update(source.bytes).digest("hex"),
      });
      records.push(checked.value);
    } catch (error) {
      return pinnedClaimFailure(error, `claim WAL '${source.name}' is unreadable`);
    }
  }
  return { ok: true, value: records };
}
function exactClaim(claim: ExecutionClaim, input: ClaimIdentityInput): boolean {
  return claim.claim_id === input.claim_id && claim.handoff_digest === input.handoff_digest && claim.owner_kind === input.owner_kind && claim.owner_run_id === input.owner_run_id;
}
function sameClaimRecord(left: ExecutionClaim, right: ExecutionClaim): boolean {
  return exactClaim(left, right) && digestOf(left) === digestOf(right);
}
function removePreparedWalIfMatches(
  pinnedRoot: PinnedProjectRoot,
  journal: ClaimJournal,
  transactionId: string,
  expected: PinnedRootFileExpectation,
): void {
  try {
    // The descriptor identifies the exact inode observed/published for this
    // transaction. A pathname-only delete could remove a replacement WAL.
    pinnedRoot.removeFileIfMatches(walRelativePath(journal, transactionId), expected);
  } catch (error) {
    // A missing WAL is already clean; any changed inode must remain untouched
    // and surface as a persistence failure to force recovery.
    if (error instanceof PinnedRootError && error.code === "not_found") return;
    throw error;
  }
}
function removePreparedWalIfOwned(
  pinnedRoot: PinnedProjectRoot,
  journal: ClaimJournal,
  transactionId: string,
  receipt: PinnedRootWriteReceipt | undefined,
): void {
  if (!receipt) return;
  removePreparedWalIfMatches(pinnedRoot, journal, transactionId, receipt.descriptor);
}
function removePreparedWalAfterRead(
  pinnedRoot: PinnedProjectRoot,
  journal: ClaimJournal,
  record: ClaimPreparedWal,
): void {
  const expected = claimWalReadExpectations.get(record);
  if (!expected) throw new PinnedRootError("changed", `claim WAL ${record.transaction_id} has no retained read descriptor`);
  removePreparedWalIfMatches(pinnedRoot, journal, record.transaction_id, expected);
}
function compensateAcquiredClaim(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  claim: ExecutionClaim,
  reason: string,
): ExecutionClaimResult<ExecutionClaim> {
  // Compensation is journal-authoritative: never resolve or rewrite the
  // workspace candidate that failed its CAS. A retry handles an append race
  // and the terminal-tail check makes replay idempotent.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const loaded = loadClaimJournal(pinnedRoot, featureId, false);
    if (!loaded.ok) return loaded;
    const current = loaded.value.tail?.claim;
    if (!current) return failureWithClaim(
      "SPEC_CLAIM_PERSIST_FAILED",
      "acquired claim " + claim.claim_id + " is no longer present in journal authority",
      claim,
    );
    if (!exactClaim(current, claim)) return failureWithClaim(
      "SPEC_CLAIM_PERSIST_FAILED",
      "claim authority moved before admission rollback for " + claim.claim_id,
      current,
    );
    // A prior compensation attempt may have published the terminal release
    // before its response was lost. Treat that exact canonical tail as the
    // idempotent success path; computing another release would reject a
    // terminal claim and could leave preparation cleanup orphaned.
    if (current.status === "released") return { ok: true, value: current };
    const computed = computeReleaseExecutionClaim({ claim: current, reason });
    if (!computed.ok) return computed;
    const committed = appendClaim(loaded.value, computed.value);
    if (committed.ok) return computed;
    // A deterministic seam or transient descriptor failure can occur after
    // the active append. Retry once before surfacing a compensation failure;
    // every retry reloads the journal tail and rechecks exact identity.
    if (committed.code === "SPEC_EXECUTION_CLAIMED" || attempt === 0) continue;
    return failureWithClaim(committed.code, committed.error, current);
  }
  return failureWithClaim(
    "SPEC_CLAIM_PERSIST_FAILED",
    "claim authority kept moving during admission rollback for " + claim.claim_id,
    claim,
  );
}
function claimedWorkspace(workspace: FeatureWorkspace, claim: ExecutionClaim): FeatureWorkspace {
  return { ...workspace, status: "claimed", execution_claim_ref: claim.claim_id, next_action: nextActionForWorkspace(workspace.phases, { status: "claimed", hasConstitutionBinding: workspace.constitution_binding !== null, sourceKind: workspace.source_kind }) };
}
function readCanonicalHandoffForClaim(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  workspace: FeatureWorkspace,
  _options: { allowUnstable?: boolean } = {},
): { ok: true; handoff: ImplementationHandoff } | { ok: false; error: string } {
  const handoffRef = workspace.handoff_ref;
  if (!handoffRef || !isSafeRelativePath(handoffRef) || handoffRef.includes("/")) return { ok: false, error: "workspace handoff reference is unsafe" };
  const relativePath = `.work-state/features/${featureId}/artifacts/implementation_handoff/${handoffRef}.json`;
  const read = readCanonicalHandoff(pinnedRoot, relativePath, `canonical handoff '${handoffRef}'`);
  if (!read.ok) return read;
  if (read.handoff.feature_id !== featureId || read.handoff.handoff_id !== handoffRef) {
    return { ok: false, error: "handoff identity does not match workspace" };
  }
  return { ok: true, handoff: read.handoff };
}
function constitutionBindingDigest(value: unknown): string {
  if (!isRecord(value)) return canonicalJson(value);
  const { bound_at: _boundAt, ...evidence } = value;
  return canonicalJson(evidence);
}

/** Re-read the approved constitution at a claim admission boundary. */
function constitutionClaimAdmissionError(
  pinnedRoot: PinnedProjectRoot,
  workspace: FeatureWorkspace,
  handoff: ImplementationHandoff,
): string | null {
  const workspaceBinding = workspace.constitution_binding;
  if (!workspaceBinding) return "SPEC_STALE: workspace has no constitution binding";
  if (constitutionBindingDigest(workspaceBinding) !== constitutionBindingDigest(handoff.constitution_binding)) {
    return "SPEC_STALE: workspace and canonical handoff constitution bindings differ";
  }
  const current = readPinnedCurrentConstitution(pinnedRoot.canonical_root, pinnedRoot, workspaceBinding);
  if (!current.ok) return "SPEC_STALE: " + current.error;
  if (constitutionBindingDigest(current.value.binding) !== constitutionBindingDigest(workspaceBinding)) {
    return "SPEC_STALE: live constitution binding does not match the workspace";
  }
  return null;
}

/**
 * Validate the caller's handoff against the immutable canonical artifact
 * before creating claim directories, WAL records, or workspace postimages.
 * The request is untrusted even when it is structurally valid: its digest
 * must identify the exact handoff currently bound by the workspace.
 */
function canonicalClaimAdmissionError(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  workspace: FeatureWorkspace,
  request: ExecutionClaimRequest,
): string | null {
  if (workspace.feature_id !== featureId) return "workspace feature identity does not match claim selector";
  if (workspace.handoff_ref !== request.handoff.handoff_id) return "workspace does not bind requested canonical handoff";
  const canonical = readCanonicalHandoffForClaim(pinnedRoot, featureId, workspace);
  if (!canonical.ok) return canonical.error;
  if (
    canonical.handoff.handoff_id !== request.handoff.handoff_id
    || canonical.handoff.handoff_digest !== request.handoff.handoff_digest
  ) return "requested handoff id or digest does not match the canonical workspace handoff";
  if (canonical.handoff.source_kind !== workspace.source_kind) return "canonical handoff source kind does not match workspace identity";
  if (constitutionBindingDigest(canonical.handoff.constitution_binding) !== constitutionBindingDigest(workspace.constitution_binding)) {
    return "canonical handoff constitution binding does not match workspace binding";
  }
  const readiness = evaluateHandoffReadiness(canonical.handoff, {
    current_constitution_binding: workspace.constitution_binding,
  });
  if (!readiness.ok) return readiness.error;
  if (workspace.source_kind === "native") {
    const phases = {
      specify: workspace.phases.find((candidate) => candidate.phase === "specify"),
      plan: workspace.phases.find((candidate) => candidate.phase === "plan"),
      tasks: workspace.phases.find((candidate) => candidate.phase === "tasks"),
    };
    for (const phaseName of ["specify", "plan", "tasks"] as const) {
      const phase = phases[phaseName];
      if (!phase) return `canonical handoff task-plan or validation binding is missing phase '${phaseName}'`;
      const hasPhaseBinding = phase.current_version !== null
        || phase.approved_version !== null
        || phase.validation_ref !== null
        || phase.checkpoint_ref !== null;
      if (!hasPhaseBinding) continue;
      const artifact = canonical.handoff.artifact_versions.find((candidate) => candidate.kind === phaseName);
      if (
        phase.status !== "approved"
        || phase.current_version === null
        || phase.approved_version !== phase.current_version
        || !artifact
        || artifact.artifact_id !== `${phaseName}.v${phase.approved_version}`
        || artifact.version !== phase.approved_version
        || !phase.validation_ref
        || !canonical.handoff.validation_refs.includes(phase.validation_ref)
        || !phase.checkpoint_ref
        || !canonical.handoff.approval_refs.includes(phase.checkpoint_ref)
      ) {
        return `canonical handoff task-plan or validation binding is not current for phase '${phaseName}'`;
      }
    }
  }
  return null;
}
function readPinnedAdmissionState(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  runKey: string,
  options: { allowUnstable?: boolean; expected_state_revision?: number } = {},
): { ok: true; state: TeamState; state_revision: number; state_digest: string; ledger_digest: string } | { ok: false; error: string } {
  if (!isSafeFeatureId(featureId) || !nonBlank(runKey)) return { ok: false, error: "confirmation anchor feature/run identity is invalid" };
  const requireStable = options.allowUnstable !== true;
  try {
    if (requireStable && !pinnedRoot.isStable()) return { ok: false, error: "project root changed before confirmation anchor reread" };
    const source = pinnedRoot.readFile(`.work-state/features/${featureId}/state.json`, { maxBytes: MAX_PERSISTED_STATE_BYTES });
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed while reading confirmation anchor" };
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)) as unknown;
    const bounded = parseBoundedPersistedState(parsed);
    if (!bounded) return { ok: false, error: "confirmation anchor state exceeds bounded structural limits or has an unsafe object shape" };
    if (bounded.run_key !== runKey || !isRecord(bounded.specification) || bounded.specification.feature_id !== featureId) {
      return { ok: false, error: "confirmation anchor feature/run identity changed before claim admission" };
    }
    const rawRevision = bounded.state_revision;
    const revisionIsValid = Number.isSafeInteger(rawRevision) && (rawRevision as number) >= 0;
    const stateRevision = revisionIsValid ? rawRevision as number : 0;
    if (options.expected_state_revision !== undefined && (!revisionIsValid || stateRevision !== options.expected_state_revision)) {
      return { ok: false, error: "confirmation anchor state revision changed before claim admission" };
    }
    const issues: string[] = [];
    const state = normalizePersistedState(bounded, issues, {
      canonical_path: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
    });

    if (!state) return { ok: false, error: `confirmation anchor state is invalid${issues.length ? `: ${issues.join("; ")}` : ""}` };
    if (state.run_key !== runKey || state.specification?.feature_id !== featureId) {
      return { ok: false, error: "confirmation anchor feature/run identity changed before claim admission" };
    }
    if (requireStable && !pinnedRoot.isStable()) return { ok: false, error: "project root changed after confirmation anchor reread" };
    const rawBytes = Buffer.from(source.bytes);
    return {
      ok: true,
      state,
      state_revision: stateRevision,
      state_digest: createHash("sha256").update(rawBytes).digest("hex"),
      ledger_digest: confirmationLedgerDigest(state),
    };
  } catch (error) {
    return { ok: false, error: `confirmation anchor state is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type ClaimAuthorityDisposition = "bound" | "none";
export type ClaimAuthorityResult =
  | { ok: true; value: ExecutionClaim | null; disposition: ClaimAuthorityDisposition }
  | { ok: false; code: ExecutionClaimResultCode; error: string; claim?: ExecutionClaim };

function samePathBinding(left: WorkspacePathBinding, right: WorkspacePathBinding): boolean {
  return digestOf(left) === digestOf(right);
}

function sameRootIdentity(
  left: { canonical_path: string; dev: number; ino: number },
  right: { canonical_path: string; dev: number; ino: number },
): boolean {
  return left.canonical_path === right.canonical_path && left.dev === right.dev && left.ino === right.ino;
}

function authorityPathBindingError(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  workspace: FeatureWorkspace,
  manifest: ClaimJournalManifest | null,
  capturedPathBinding?: WorkspacePathBinding,
): { code: "SPEC_PATH_UNAUTHORIZED" | "SPEC_STATE_INVALID"; error: string } | null {
  // Root replacement is an authorization failure, not malformed state. Check
  // the pinned identity before inspecting any persisted binding fields so a
  // swap cannot be collapsed into structural validation below.
  if (!pinnedRoot.isStable()) return { code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim authority" };
  if (workspace.schema_version !== 3 || !workspace.path_binding) return null;
  const rootIdentity = workspace.project_root_identity;
  if (!isRecord(rootIdentity)
    || typeof rootIdentity.canonical_path !== "string"
    || !Number.isSafeInteger(rootIdentity.dev)
    || !Number.isSafeInteger(rootIdentity.ino)) {
    return { code: "SPEC_STATE_INVALID", error: "workspace project-root identity is malformed" };
  }
  if (!sameRootIdentity(rootIdentity as { canonical_path: string; dev: number; ino: number }, {
    canonical_path: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
  })) {
    return { code: "SPEC_PATH_UNAUTHORIZED", error: "workspace project-root identity changed since claim acquisition" };
  }
  if (manifest && manifest.workspace_path_binding_digest !== workspacePathBindingDigest(workspace.path_binding)) {
    return { code: "SPEC_PATH_UNAUTHORIZED", error: "claim journal manifest path binding does not match workspace authority" };
  }
  const captured = capturedPathBinding ?? captureWorkspacePathBinding(pinnedRoot, featureId);
  if (!samePathBinding(workspace.path_binding, captured)) {
    return { code: "SPEC_PATH_UNAUTHORIZED", error: "workspace path binding changed since claim acquisition" };
  }
  return null;
}
/** Read claim authority only when the journal tail and the exact workspace
 * postimage form one descriptor-bound tuple. Raw journal tails remain audit data. */
export function readClaimAuthority(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  capturedPathBinding?: WorkspacePathBinding,
  capturedHandoff?: ImplementationHandoff,
): ClaimAuthorityResult {
  if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim authority" };
  const loaded = loadClaimJournal(pinnedRoot, featureId, false, capturedPathBinding);
  if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error };
  if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim authority" };
  const tail = loaded.value.tail?.claim;
  if (!tail || (tail.status !== "active" && tail.status !== "blocked" && tail.status !== "completed")) return { ok: true, value: null, disposition: "none" };
  let state: TeamState;
  try {
    const source = pinnedRoot.readFile(`.work-state/features/${featureId}/state.json`, { maxBytes: MAX_PERSISTED_STATE_BYTES });
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim authority" };
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)) as unknown;
    const bounded = parseBoundedPersistedState(parsed);
    if (!bounded || typeof bounded.run_key !== "string") return { ok: false, code: "SPEC_STATE_INVALID", error: "claim authority state envelope is malformed or exceeds bounded structural limits" };
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim authority" };
    const admission = readPinnedAdmissionState(pinnedRoot, featureId, bounded.run_key, { allowUnstable: true });
    if (!admission.ok) {
      if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim authority" };
      return { ok: false, code: "SPEC_STATE_INVALID", error: admission.error };
    }
    state = admission.state;
  } catch (error) {
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim authority" };
    const failed = pinnedClaimFailure(error, "claim authority workspace state is unreadable");
    return failed.ok ? { ok: false, code: "SPEC_STATE_INVALID", error: "claim authority workspace state is unreadable" } : { ok: false, code: failed.code, error: failed.error };
  }
  if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim authority" };
  const workspace = state.specification;
  if (!workspace || workspace.feature_id !== featureId) return { ok: true, value: null, disposition: "none" };
  try {
    const pathError = authorityPathBindingError(pinnedRoot, featureId, workspace, loaded.value.manifest, capturedPathBinding);
    if (pathError) return { ok: false, code: pathError.code, error: pathError.error };
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim authority" };
  } catch (error) {
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim authority" };
    const failed = pinnedClaimFailure(error, "claim authority descendants are unsafe");
    return failed.ok ? { ok: false, code: "SPEC_STATE_INVALID", error: "claim authority descendants are unsafe" } : { ok: false, code: failed.code, error: failed.error };
  }
  if (workspace.execution_claim_prepare_ref !== null || workspace.execution_claim_ref !== tail.claim_id) return { ok: true, value: null, disposition: "none" };
  if (workspace.schema_version !== 3 || !workspace.path_binding) return { ok: true, value: null, disposition: "none" };
  if (!["claimed", "executing", "completion_validating", "completion_blocked", "completed"].includes(workspace.status)) return { ok: true, value: null, disposition: "none" };
  if (!workspace.handoff_ref) return { ok: true, value: null, disposition: "none" };
  try {
    const handoff = capturedHandoff
      ? { ok: true as const, handoff: capturedHandoff }
      : readCanonicalHandoffForClaim(pinnedRoot, featureId, workspace, { allowUnstable: true });
    if (!handoff.ok || handoff.handoff.handoff_digest !== tail.handoff_digest) return { ok: true, value: null, disposition: "none" };
    if (tail.status === "completed" && workspace.status !== "completed") return { ok: true, value: null, disposition: "none" };
    if (tail.status !== "completed" && workspace.status === "completed") return { ok: true, value: null, disposition: "none" };
    return { ok: true, value: tail, disposition: "bound" };
  } catch (error) {
    const failed = pinnedClaimFailure(error, "claim authority descendants are unsafe");
    return failed.ok ? { ok: false, code: "SPEC_STATE_INVALID", error: "claim authority descendants are unsafe" } : { ok: false, code: failed.code, error: failed.error };
  }
}

function verifyClaimAdmissionBinding(
  snapshot: StateSnapshot,
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  ownerRunId: string,
  admission: ExecutionClaimAdmissionBinding,
  verificationMode: "active" | "terminal" = "active",
): string | null {
  if (!validAdmissionBinding(admission)) return "claim admission control-plane binding is invalid";
  const featureState = snapshot.state;
  if (!featureState) return "canonical feature state is unavailable for claim admission";
  if (!isSafeCtoRunId(ownerRunId)) return "claim admission owner run id is not a safe CTO run id";
  const expectedMappingPath = `.work-state/cto/${ownerRunId}/specification-mappings/${admission.mapping_id}.json`;
  if (admission.mapping_record_path !== expectedMappingPath) {
    return "claim admission mapping record path is not the canonical owner mapping path";
  }
  const mappingRead = readPinnedCtoMappingRecord(
    pinnedRoot,
    admission.mapping_record_path,
    ownerRunId,
    admission.mapping_id,
  );
  if (!mappingRead.ok) return `canonical mapping record is unreadable during claim admission: ${mappingRead.error}`;
  if (mappingRead.value.digest !== admission.mapping_record_digest) return "canonical mapping record changed before claim admission";
  const parsed = mappingRead.value.record;
  if (parsed.cto_run_id !== ownerRunId || !isRecord(parsed.mapping)) {
    return "canonical mapping record identity is invalid during claim admission";
  }
  const mapping = parsed.mapping;
  if (mapping.mapping_id !== admission.mapping_id
    || mapping.mapping_hash !== admission.mapping_hash
    || mapping.mapping_version !== admission.mapping_version
    || mapping.status !== "confirmed"
    || mapping.checkpoint_ref !== admission.checkpoint_ref
    || parsed.checkpoint_ref !== admission.checkpoint_ref
    || parsed.trusted_answer_ref !== admission.trusted_answer_ref) {
    return "canonical mapping confirmation changed before claim admission";
  }
  if (!Array.isArray(parsed.selections)
    || !parsed.selections.some((selection) => isRecord(selection)
      && selection.feature_id === featureId
      && selection.run_key === featureState.run_key)) {
    return "claim feature/run selector is not one of the exact confirmed mapping selections";
  }
  const execution = mapping.execution;
  if (!isRecord(execution)
    || execution.choice !== "cto"
    || execution.wave_id !== admission.wave_id
    || execution.capability_id !== admission.capability_id
    || execution.capability_epoch !== admission.capability_epoch) {
    return "canonical mapping execution wave changed before claim admission";
  }
  const context = parsed.confirmation_context;
  if (!isRecord(context)
    || !isSafeFeatureId(context.feature_id)
    || !nonBlank(context.run_key)
    || !nonBlank(context.stage_id)
    || context.stage_id !== admission.stage_id
    || context.decision !== "approve_continue"
    || context.capability_id !== admission.capability_id
    || context.capability_epoch !== admission.capability_epoch
    || context.policy_hash !== admission.policy_hash) {
    return "confirmation anchor context changed before claim admission";
  }
  const anchorStateResult = context.feature_id === featureId && featureState.run_key === context.run_key
    ? {
        ok: true as const,
        state: featureState,
        state_revision: snapshot.revision,
        state_digest: snapshot.raw_hash,
        ledger_digest: confirmationLedgerDigest(featureState),
      }
    : readPinnedAdmissionState(
      pinnedRoot,
      context.feature_id,
      context.run_key,
      verificationMode === "terminal"
        ? { allowUnstable: true }
        : { expected_state_revision: admission.confirmation_state_revision },
    );
  if (!anchorStateResult.ok) return anchorStateResult.error;
  if (verificationMode !== "terminal" && admission.confirmation_state_revision !== anchorStateResult.state_revision) {
    return "confirmation anchor state revision changed before claim admission";
  }
  if (verificationMode !== "terminal" && admission.confirmation_state_digest !== anchorStateResult.state_digest) {
    return "confirmation anchor state bytes changed before claim admission";
  }
  const anchorState = anchorStateResult.state;
  if (admission.confirmation_ledger_digest !== anchorStateResult.ledger_digest) {
    return "confirmation anchor trusted-answer ledger changed before claim admission";
  }
  if (anchorState.dispatch_capability?.capability_id !== admission.capability_id
    || anchorState.dispatch_capability?.issued_for?.cursor_epoch !== admission.capability_epoch) {
    return "confirmation anchor capability changed before claim admission";
  }
  const policy = anchorState.checkpoint_policy;
  if (!policy) return "confirmation anchor checkpoint policy is missing before claim admission";
  const answer = anchorState.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === admission.trusted_answer_ref);
  if (!answer) return "confirmation anchor trusted answer is missing before claim admission";
  const proof: CheckpointAnswerProof = {
    answer_id: answer.answer_id,
    nonce: answer.nonce,
    channel: answer.channel,
    reference: answer.reference,
    binding: answer.binding,
    ...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}),
  };
  const proofError = trustedCheckpointAnswerError(anchorState, {
    actor: { kind: "user", ref: answer.reference, proof },
    run_id: context.run_key,
    stage_id: admission.stage_id,
    checkpoint_id: admission.checkpoint_ref,
    decision: "approve_continue",
    feature_id: context.feature_id,
    capability_id: admission.capability_id,
    capability_epoch: admission.capability_epoch,
    policy_hash: admission.policy_hash,
    bind_active_context: true,
  });
  if (proofError) return `confirmation anchor proof changed before claim admission: ${proofError}`;
  const authorizationDigest = executionClaimAuthorizationProjectionDigest({
    feature_id: context.feature_id,
    run_key: context.run_key,
    stage_id: context.stage_id,
    capability_id: admission.capability_id,
    capability_epoch: admission.capability_epoch,
    capability_stage_id: anchorState.dispatch_capability?.issued_for?.stage_cursor ?? null,
    checkpoint_ref: admission.checkpoint_ref,
    trusted_answer_ref: admission.trusted_answer_ref,
    checkpoint_policy: policy,
    checkpoint_rule: policy.rules[admission.checkpoint_ref] ?? null,
    trusted_answer: answer,
    trusted_proof: proof,
    constitution_binding: anchorState.specification?.constitution_binding ?? null,
    root_binding: {
      pinned_root: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
      workspace_root: anchorState.specification?.project_root_identity ?? null,
    },
    mapping_id: String(mapping.mapping_id),
    mapping_hash: String(mapping.mapping_hash),
    mapping_version: Number(mapping.mapping_version),
  });
  if (authorizationDigest !== admission.confirmation_authorization_digest) {
    return "confirmation anchor authorization projection changed before claim admission";
  }
  return null;
}

function committedClaimBindingOnRoot(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  request: ExecutionClaimRequest,
  claim: ExecutionClaim,
  allowUnstable: boolean,
): boolean {
  const journal = loadClaimJournal(pinnedRoot, featureId, false);
  const current = journal.ok ? journal.value.tail?.claim : undefined;
  if (!current || current.status !== "active" || !exactClaim(current, claim)) return false;
  const admission = readPinnedAdmissionState(
    pinnedRoot,
    featureId,
    request.run_key,
    allowUnstable ? { allowUnstable: true } : undefined,
  );
  if (!admission.ok) return false;
  const workspace = admission.state.specification;
  if (!workspace
    || workspace.feature_id !== featureId
    || workspace.status !== "claimed"
    || workspace.execution_claim_ref !== claim.claim_id
    || workspace.handoff_ref !== request.handoff.handoff_id) return false;
  const handoff = readCanonicalHandoffForClaim(
    pinnedRoot,
    featureId,
    workspace,
    allowUnstable ? { allowUnstable: true } : undefined,
  );
  return handoff.ok && handoff.handoff.handoff_digest === claim.handoff_digest;
}

function committedClaimBinding(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  request: ExecutionClaimRequest,
  claim: ExecutionClaim,
): boolean {
  if (!pinnedRoot.isStable()) return false;
  return committedClaimBindingOnRoot(pinnedRoot, featureId, request, claim, false);
}

function bindClaimWorkspace(projectRoot: string, pinnedRoot: PinnedProjectRoot, featureId: string, request: ExecutionClaimRequest, claim: ExecutionClaim): ExecutionClaimResult<ExecutionClaim> {
  const persisted = updateStateAtomically<ExecutionClaim>(
    projectRoot,
    (snapshot) => {
      const state = snapshot.state;
      if (!state || !snapshot.target.statePath) {
        return { op: "fail", code: "state_missing", error: "canonical feature state cannot be resolved without losing control-plane fields" };
      }
      const workspace = state.specification;
      if (!workspace || workspace.feature_id !== featureId) {
        return { op: "fail", code: "state_invalid", error: "canonical feature state does not carry the selected specification workspace" };
      }
      let workspaceRoot: string;
      try {
        workspaceRoot = realpathSync(resolve(workspace.project_root));
      } catch {
        return { op: "fail", code: "state_invalid", error: "workspace project root cannot be resolved safely" };
      }
      if (workspaceRoot !== pinnedRoot.canonical_root) {
        return { op: "fail", code: "state_conflict", error: "workspace project root changed after admission revalidation" };
      }
      const rootIdentity = workspace.project_root_identity;
      if (!rootIdentity
        || rootIdentity.canonical_path !== pinnedRoot.canonical_root
        || rootIdentity.dev !== pinnedRoot.dev
        || rootIdentity.ino !== pinnedRoot.ino) {
        return { op: "fail", code: "state_conflict", error: "workspace project root identity changed after admission revalidation" };
      }
      if (request.admission_binding) {
      const admissionError = verifyClaimAdmissionBinding(snapshot, pinnedRoot, featureId, request.owner_run_id, request.admission_binding);
        if (admissionError) return { op: "fail", code: "state_conflict", error: admissionError };
      }
      const exactClaimBinding = workspace.execution_claim_ref === claim.claim_id && workspace.status === "claimed";
      if (!exactClaimBinding && request.expected_workspace_digest !== undefined && workspaceAdmissionDigest(workspace, pinnedRoot.canonical_root) !== request.expected_workspace_digest) {
        return { op: "fail", code: "state_conflict", error: "workspace changed after admission revalidation" };
      }
      if (workspace.handoff_ref !== request.handoff.handoff_id) {
        return { op: "fail", code: "state_invalid", error: "workspace does not bind requested handoff" };
      }
      const currentHandoff = readCanonicalHandoffForClaim(pinnedRoot, featureId, workspace);
      if (!currentHandoff.ok) return { op: "fail", code: "state_invalid", error: currentHandoff.error };
      if (currentHandoff.handoff.handoff_digest !== request.handoff.handoff_digest) {
        return { op: "fail", code: "state_conflict", error: "canonical handoff changed after admission revalidation" };
      }
      const readiness = evaluateHandoffReadiness(currentHandoff.handoff, { current_constitution_binding: workspace.constitution_binding });
      if (!readiness.ok) return { op: "fail", code: "state_invalid", error: `canonical handoff is no longer ready: ${readiness.error}` };
      let replacingTerminalReference = false;
      if (workspace.execution_claim_ref && workspace.execution_claim_ref !== claim.claim_id) {
        const journal = loadClaimJournal(pinnedRoot, featureId, false);
        const referenced = journal.ok ? journal.value.claims.find((candidate) => candidate.claim_id === workspace.execution_claim_ref) : undefined;
        if (!referenced || isLiveExecutionClaim(referenced)) {
          return { op: "fail", code: "state_conflict", error: `workspace references foreign claim '${workspace.execution_claim_ref}'` };
        }
        replacingTerminalReference = true;
      }
      if (exactClaimBinding) {
        return { op: "discard", value: claim };
      }
      if (workspace.status !== "implementation_ready" && !(workspace.status === "claimed" && replacingTerminalReference)) {
        return { op: "fail", code: "state_invalid", error: `workspace cannot be claimed from '${workspace.status}'` };
      }
      const nextWorkspace = claimedWorkspace(workspace, claim);
      return {
        op: "commit",
        state: { ...state, specification: nextWorkspace },
        value: claim,
      };
    },
    { selector: { feature_id: featureId, run_key: request.run_key }, rootGuard: pinnedRoot, pinnedRoot },
  );
  if (!persisted.ok) {
    if (committedClaimBinding(pinnedRoot, featureId, request, claim)) return { ok: true, value: claim };
    return failureWithClaim("SPEC_CLAIM_PERSIST_FAILED", persisted.error, claim);
  }
  return { ok: true, value: claim };
}
function stateWorkspaceFromPinned(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
): { ok: true; state: TeamState; workspace: FeatureWorkspace; runKey: string } | { ok: false; code: ExecutionClaimResultCode; error: string } {
  if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before claim admission state read" };
  try {
    const source = pinnedRoot.readFile(`.work-state/features/${featureId}/state.json`, { maxBytes: MAX_PERSISTED_STATE_BYTES });
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim admission state" };
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)) as unknown;
    const bounded = parseBoundedPersistedState(parsed);
    if (!bounded || typeof bounded.run_key !== "string") return { ok: false, code: "SPEC_STATE_INVALID", error: "feature state envelope is malformed or exceeds bounded structural limits" };
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim admission state" };
    const admission = readPinnedAdmissionState(pinnedRoot, featureId, bounded.run_key, { allowUnstable: true });
    if (!admission.ok) {
      if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim admission state" };
      return { ok: false, code: "SPEC_STATE_INVALID", error: admission.error };
    }
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while reading claim admission state" };
    if (!admission.state.specification) return { ok: false, code: "SPEC_STATE_INVALID", error: "feature state has no specification workspace" };
    return { ok: true, state: admission.state, workspace: admission.state.specification, runKey: bounded.run_key };
  } catch (error) {
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while loading claim admission state" };
    return { ok: false, code: error instanceof PinnedRootError && (error.code === "path_unauthorized" || error.code === "changed" || error.code === "unsupported") ? "SPEC_PATH_UNAUTHORIZED" : "SPEC_STATE_INVALID", error: `feature state cannot be loaded for claim admission: ${error instanceof Error ? error.message : String(error)}` };
  }
}

type ClaimWorkspaceCasSuccess<T> = { ok: true; value: T; state_revision: number; state_digest: string; receipts?: readonly StateMutationReceipt[] };
type ClaimWorkspaceCasResult<T> = ClaimWorkspaceCasSuccess<T> | ExecutionClaimFailure;

function claimWorkspaceCas(
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  runKey: string,
  expectedWorkspaceDigest: string,
  mutate: (workspace: FeatureWorkspace, snapshot: StateSnapshot) => FeatureWorkspace | { error: string },
  expectedStateRevision?: number,
  expectedCapability?: { capability_id: string; capability_epoch: string },
  preCommit?: (workspace: FeatureWorkspace) => void,
  captureReceipts = false,
): ClaimWorkspaceCasResult<FeatureWorkspace> {
  let preCommitWorkspace: FeatureWorkspace | null = null;
  const persisted = updateStateAtomically<FeatureWorkspace>(
    projectRoot,
    (snapshot) => {
      const workspace = snapshot.state?.specification;
      if (!snapshot.state || !workspace || !snapshot.target.statePath) return { op: "fail", code: "state_missing", error: "canonical feature state is unavailable" };
      if (expectedStateRevision !== undefined) {
        const revision = (snapshot.state as TeamState & { state_revision?: unknown }).state_revision;
        if (revision !== expectedStateRevision) return { op: "fail", code: "state_conflict", error: "workflow state revision changed before claim transition" };
      }
      if (expectedCapability !== undefined) {
        const capability = snapshot.state?.dispatch_capability;
        if (!capability
          || capability.capability_id !== expectedCapability.capability_id
          || capability.issued_for?.cursor_epoch !== expectedCapability.capability_epoch) {
          return { op: "fail", code: "state_conflict", error: "dispatch capability changed before claim transition" };
        }
      }
      if (digestOf(workspace) !== expectedWorkspaceDigest) return { op: "fail", code: "state_conflict", error: "workspace changed before claim transition" };
      const next = mutate(workspace, snapshot);
      if ("error" in next) return { op: "fail", code: "state_invalid", error: next.error };
      const valid = validateFeatureWorkspaceRecord(next);
      if (!valid.ok) return { op: "fail", code: "state_invalid", error: valid.issues.join("; ") };
      preCommitWorkspace = next;
      return { op: "commit", state: { ...(snapshot.state as TeamState), specification: next }, value: next };
    },
    { selector: { feature_id: featureId, run_key: runKey }, rootGuard: pinnedRoot, pinnedRoot, captureReceipts, preCommit: () => {
      if (preCommitWorkspace) preCommit?.(preCommitWorkspace);
    } },
  );
  if (!persisted.ok) {
    if (!pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", persisted.error);
    const code = persisted.code === "state_conflict" ? "SPEC_EXECUTION_CLAIMED" : persisted.code === "state_invalid" && persisted.error.includes("SPEC_STALE:") ? "SPEC_STALE" : persisted.code === "state_invalid" ? "SPEC_STATE_INVALID" : "SPEC_CLAIM_PERSIST_FAILED";
    return failure(code, persisted.error);
  }
  return persisted.state?.specification
    ? { ok: true, value: persisted.state.specification, state_revision: persisted.revision, state_digest: persisted.raw_hash, ...(persisted.receipts ? { receipts: persisted.receipts } : {}) }
    : failure("SPEC_CLAIM_PERSIST_FAILED", "claim workspace transition committed without a workspace");
}
function releasedWorkspacePostimage(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  claim: ExecutionClaim,
): { ok: true; workspace: FeatureWorkspace } | { ok: false; error: string } {
  const journal = loadClaimJournal(pinnedRoot, featureId, false);
  if (!journal.ok) return { ok: false, error: journal.error };
  const tail = journal.value.tail?.claim;
  if (!tail || tail.status !== "released" || !exactClaim(tail, claim)) return { ok: false, error: "released claim is not the canonical journal tail" };
  const state = stateWorkspaceFromPinned(pinnedRoot, featureId);
  if (!state.ok) return { ok: false, error: state.error };
  const workspace = state.workspace;
  if (
    workspace.execution_claim_ref !== null
    || workspace.execution_claim_prepare_ref !== null
    || workspace.status !== "implementation_ready"
    || workspace.implementation_conformance_ref !== null
  ) return { ok: false, error: "released claim and workspace postimages are not paired" };
  return { ok: true, workspace };
}

function releaseClaimWorkspace(
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  runKey: string,
  claim: ExecutionClaim,
  preCommit?: (workspace: FeatureWorkspace) => void,
  captureReceipts = false,
): ExecutionClaimResult<FeatureWorkspace> {
  const state = stateWorkspaceFromPinned(pinnedRoot, featureId);
  if (!state.ok) return state;
  if (state.runKey !== runKey || state.workspace.execution_claim_ref !== claim.claim_id) {
    return failure("SPEC_CLAIM_PERSIST_FAILED", "released claim is not bound to the canonical workspace");
  }
  return claimWorkspaceCas(projectRoot, pinnedRoot, featureId, runKey, digestOf(state.workspace), (workspace) => {
    if (workspace.execution_claim_ref !== claim.claim_id) return { error: "workspace claim reference changed during release" };
    if (workspace.status === "completed") return { error: "completed workspace cannot be released" };
    return {
      ...workspace,
      status: "implementation_ready",
      execution_claim_prepare_ref: null,
      execution_claim_ref: null,
      implementation_conformance_ref: null,
      next_action: nextActionForWorkspace(workspace.phases, {
        status: "implementation_ready",
        hasConstitutionBinding: workspace.constitution_binding !== null,
        sourceKind: workspace.source_kind,
      }),
    };
  }, undefined, undefined, preCommit, captureReceipts);
}

function healReleasedClaimWorkspace(
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  runKey: string,
  claim: ExecutionClaim,
): ExecutionClaimResult<FeatureWorkspace> | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = stateWorkspaceFromPinned(pinnedRoot, featureId);
    if (!observed.ok) return observed;
    if (observed.runKey !== runKey || observed.workspace.execution_claim_ref !== claim.claim_id) return null;
    const canonical = readCanonicalHandoffForClaim(pinnedRoot, featureId, observed.workspace);
    if (!canonical.ok) return failure("SPEC_STATE_INVALID", canonical.error);
    const releaseGuard = (candidate: FeatureWorkspace) => {
      const constitutionError = constitutionClaimAdmissionError(pinnedRoot, candidate, canonical.handoff);
      if (constitutionError) throw new Error(constitutionError);
    };
    const repaired = releaseClaimWorkspace(projectRoot, pinnedRoot, featureId, runKey, claim, releaseGuard, true);
    if (repaired.ok) {
      const verified = releasedWorkspacePostimage(pinnedRoot, featureId, claim);
      if (verified.ok) return { ok: true, value: verified.workspace, ...(repaired.receipts ? { receipts: repaired.receipts } : {}) };
      if (repaired.receipts && !rollbackStateMutationReceipts(pinnedRoot, repaired.receipts)) {
        return failure("SPEC_CLAIM_PERSIST_FAILED", `${verified.error}; released workspace rollback failed`);
      }
      if (attempt === 1) return failure("SPEC_CLAIM_PERSIST_FAILED", verified.error);
    } else if (attempt === 1) {
      return repaired;
    }
  }
  return failure("SPEC_CLAIM_PERSIST_FAILED", "released claim workspace could not be repaired");
}
function prepareClaimWorkspace(
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  runKey: string,
  workspace: FeatureWorkspace,
  transactionId: string,
): ExecutionClaimResult<FeatureWorkspace> {
  const expected = digestOf(workspace);
  return claimWorkspaceCas(projectRoot, pinnedRoot, featureId, runKey, expected, (current) => {
    if (current.schema_version !== 3 || current.execution_claim_ref !== null || (current.execution_claim_prepare_ref !== null && current.execution_claim_prepare_ref !== transactionId)) return { error: "workspace is not available for this claim preparation" };
    if (current.execution_claim_prepare_ref === transactionId) return current;
    if (current.status !== "implementation_ready") return { error: `workspace cannot be prepared from '${current.status}'` };
    return { ...current, execution_claim_prepare_ref: transactionId };
  });
}

function clearClaimPreparation(
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  runKey: string,
  transactionId: string,
): ExecutionClaimResult<FeatureWorkspace> {
  const observed = stateWorkspaceFromPinned(pinnedRoot, featureId);
  if (!observed.ok) return observed;
  if (observed.workspace.execution_claim_ref !== null) return failure("SPEC_CLAIM_PERSIST_FAILED", "cannot clear claim preparation after workspace activation");
  if (observed.workspace.execution_claim_prepare_ref === null) return { ok: true, value: observed.workspace };
  if (observed.workspace.execution_claim_prepare_ref !== transactionId) return failure("SPEC_CLAIM_PERSIST_FAILED", "claim preparation belongs to a different transaction");
  return claimWorkspaceCas(projectRoot, pinnedRoot, featureId, runKey, digestOf(observed.workspace), (current) => {
    if (current.execution_claim_ref !== null) return { error: "cannot clear claim preparation after workspace activation" };
    if (current.execution_claim_prepare_ref !== transactionId) return { error: "claim preparation changed before cleanup" };
    return { ...current, execution_claim_prepare_ref: null };
  });
}

function confirmationAnchorMatchesTarget(
  pinnedRoot: PinnedProjectRoot,
  admission: ExecutionClaimAdmissionBinding,
  ownerRunId: string,
  featureId: string,
  runKey: string,
): { ok: true; matches: boolean } | { ok: false; error: string } {
  const mapping = readPinnedCtoMappingRecord(pinnedRoot, admission.mapping_record_path, ownerRunId, admission.mapping_id);
  if (!mapping.ok) return { ok: false, error: `canonical mapping record is unreadable before claim activation: ${mapping.error}` };
  const context = mapping.value.record.confirmation_context;
  return {
    ok: true,
    matches: isRecord(context) && context.feature_id === featureId && context.run_key === runKey,
  };
}

function activateClaimWorkspace(
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  runKey: string,
  workspace: FeatureWorkspace,
  transactionId: string,
  claim: ExecutionClaim,
  request: ExecutionClaimRequest,
  activationAdmissionBinding?: ExecutionClaimAdmissionBinding,
  expectedStateRevision?: number,
): ExecutionClaimResult<FeatureWorkspace> {
  const expected = digestOf(workspace);
  const admissionRequest = activationAdmissionBinding ? { ...request, admission_binding: activationAdmissionBinding } : request;
  return claimWorkspaceCas(projectRoot, pinnedRoot, featureId, runKey, expected, (current, snapshot) => {
    if (admissionRequest.admission_binding) {
      const admissionError = verifyClaimAdmissionBinding(snapshot, pinnedRoot, featureId, admissionRequest.owner_run_id, admissionRequest.admission_binding);
      if (admissionError) return { error: admissionError };
    }
    const canonicalBindingError = canonicalClaimAdmissionError(pinnedRoot, featureId, current, request);
    if (canonicalBindingError) return { error: canonicalBindingError };
    if (current.execution_claim_prepare_ref !== transactionId) {
      if (current.execution_claim_ref === claim.claim_id && current.execution_claim_prepare_ref === null && current.status === "claimed") return current;
      return { error: "workspace claim preparation binding changed before activation" };
    }
    if (current.execution_claim_ref !== null || current.status !== "implementation_ready") return { error: "workspace is not in the prepared claim state" };
    return claimedWorkspace({ ...current, execution_claim_prepare_ref: null }, claim);
  }, expectedStateRevision, undefined, (currentWorkspace) => {
    const constitutionError = constitutionClaimAdmissionError(pinnedRoot, currentWorkspace, request.handoff);
    if (constitutionError) throw new Error(constitutionError);
  });
}

const CLAIM_LOCK_RETRY_MS = 10;
const CLAIM_LOCK_TIMEOUT_MS = 10_000;
const CLAIM_LOCK_OWNERLESS_GRACE_MS = 50;
type ClaimLockOwner = { pid: number; token: string; start_identity?: string };

function parseClaimLockOwner(bytes: Uint8Array): ClaimLockOwner | null {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<ClaimLockOwner>;
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0 || typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    return {
      pid: parsed.pid as number,
      token: parsed.token,
      ...(typeof parsed.start_identity === "string" && parsed.start_identity.length > 0 ? { start_identity: parsed.start_identity } : {}),
    };
  } catch {
    return null;
  }
}

function claimLockOwnerLive(owner: ClaimLockOwner, _mtimeMs: number | undefined): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EPERM") return true;
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    return true;
  }
  // A PID-only legacy owner is authoritative for as long as that PID lives.
  // Without a process-start identity, age cannot distinguish it from a PID
  // replacement and must never trigger takeover.
  if (!owner.start_identity) return true;
  const actual = processStartIdentity(owner.pid);
  return actual === null || actual === owner.start_identity;
}

function claimLock(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
): { ok: true; token: string; target: string; candidate: string; expected: { dev: number; ino: number; sha256: string } } | { ok: false; error: string } {
  const base = `.work-state/features/${featureId}/artifacts/execution_claim`;
  const target = `${base}/claim.lock`;
  const startIdentity = processStartIdentity();
  if (!startIdentity) return { ok: false, error: "claim authority lock process start identity is unavailable" };
  const startedAt = Date.now();
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const token = randomUUID();
    const candidate = `${base}/.claim-lock-${token}.tmp`;
    const owner = JSON.stringify({ schema: 2, token, pid: process.pid, start_identity: startIdentity, operation: "claim" }) + "\n";
    let acquired = false;
    try {
      acquired = pinnedRoot.tryAcquireExclusiveLock(candidate, target, owner, { ownerlessGraceMs: CLAIM_LOCK_OWNERLESS_GRACE_MS });
    } catch (error) {
      return { ok: false, error: String(error) };
    }
    if (acquired) {
      try {
        const observed = pinnedRoot.readFile(target, { maxBytes: 4 * 1024 });
        return {
          ok: true,
          token,
          target,
          candidate,
          expected: { dev: observed.dev, ino: observed.ino, sha256: createHash("sha256").update(observed.bytes).digest("hex") },
        };
      } catch (error) {
        try { pinnedRoot.releaseExclusiveLock(target, token); } catch { /* publication failed before an authoritative lock existed */ }
        return { ok: false, error: String(error) };
      }
    }
    let observed;
    try {
      observed = pinnedRoot.readFile(target, { maxBytes: 4 * 1024 });
    } catch (error) {
      if (error instanceof PinnedRootError && error.code === "not_found") continue;
      return { ok: false, error: String(error) };
    }
    let mtimeMs: number | undefined;
    try { mtimeMs = pinnedRoot.pathEntryInfo(target)?.mtimeMs; } catch { /* the read identity remains authoritative */ }
    const currentOwner = parseClaimLockOwner(observed.bytes);
    const staleByGrace = mtimeMs !== undefined && Date.now() - mtimeMs >= CLAIM_LOCK_OWNERLESS_GRACE_MS;
    const stale = currentOwner
      ? !claimLockOwnerLive(currentOwner, mtimeMs) && (Boolean(currentOwner.start_identity) || staleByGrace)
      : staleByGrace;
    if (stale) {
      const expected = { dev: observed.dev, ino: observed.ino, sha256: createHash("sha256").update(observed.bytes).digest("hex") };
      try { pinnedRoot.removeFileIfMatches(target, expected); } catch { /* changed/replaced lock is retried from a fresh observation */ }
      continue;
    }
    if (Date.now() >= startedAt + CLAIM_LOCK_TIMEOUT_MS) return { ok: false, error: "claim authority lock is held by another owner" };
    Atomics.wait(waitBuffer, 0, 0, CLAIM_LOCK_RETRY_MS);
  }
}
function contenderResult(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  request: ExecutionClaimRequest,
): ExecutionClaimAcquisitionResult | null {
  // A lock loser may observe the winner between its WAL prepare and the
  // canonical active envelope. Give that bounded interval a chance to settle,
  // then classify the canonical bound winner rather than leaking a lock error.
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const authority = readClaimAuthority(pinnedRoot, featureId);
    if (!authority.ok) {
      // During lazy storage initialization the winner can briefly expose a
      // state postimage before its manifest/journal tail is observable.
      // A valid live journal tail is already a conservative conflict proof,
      // even before its workspace postimage becomes readable.
      if (authority.code === "SPEC_STATE_INVALID") {
        const settled = loadClaimJournal(pinnedRoot, featureId, false);
        const tail = settled.ok ? settled.value.tail?.claim : null;
        if (tail && isLiveExecutionClaim(tail)) {
          return failureWithClaim("SPEC_EXECUTION_CLAIMED", `feature '${featureId}' is already claimed by ${ownerDescription(tail)}`, tail);
        }
        if (attempt < 199) {
          Atomics.wait(waitBuffer, 0, 0, 10);
          continue;
        }
      }
      return authority;
    }
    if (authority.value) {
      if (exactClaim(authority.value, {
        claim_id: authority.value.claim_id,
        handoff_digest: request.handoff.handoff_digest,
        owner_kind: request.owner_kind,
        owner_run_id: request.owner_run_id,
      }) && sameAdmissionBinding(authority.value.admission_binding, request.admission_binding)) {
        const replayState = stateWorkspaceFromPinned(pinnedRoot, featureId);
        if (!replayState.ok) return failureWithClaim("SPEC_STALE", replayState.error, authority.value);
        const replayConstitutionError = constitutionClaimAdmissionError(pinnedRoot, replayState.workspace, request.handoff);
        if (replayConstitutionError) return failureWithClaim("SPEC_STALE", replayConstitutionError, authority.value);
        return { ok: true, value: authority.value, disposition: "replayed" };
      }
      return failureWithClaim(
        "SPEC_EXECUTION_CLAIMED",
        `feature '${featureId}' is already claimed by ${ownerDescription(authority.value)}`,
        authority.value,
      );
    }
    if (attempt < 199) Atomics.wait(waitBuffer, 0, 0, 10);
  }
  return null;
}


function releaseClaimLock(
  pinnedRoot: PinnedProjectRoot,
  lock: { token: string; target: string; candidate: string; expected: { dev: number; ino: number; sha256: string } },
): void {
  try { pinnedRoot.removeFileIfMatches(lock.target, lock.expected); } catch { /* lock owner is already gone */ }
  try { pinnedRoot.removeFile(lock.candidate, { missingOk: true }); } catch { /* candidate cleanup is best effort */ }
}

type WorkspaceV3MigrationPostimage = {
  state_revision: number;
  state_digest: string;
  ledger_digest: string;
};

type WorkspaceV3EnsureValue = {
  workspace: FeatureWorkspace;
  migrated: boolean;
  postimage?: WorkspaceV3MigrationPostimage;
};

type WorkspaceV3Admission = {
  owner_run_id: string;
  binding: ExecutionClaimAdmissionBinding;
};

function ensureWorkspaceV3(
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  runKey: string,
  workspace: FeatureWorkspace,
  admission?: WorkspaceV3Admission,
  constitutionGuard?: () => void,
): ExecutionClaimResult<WorkspaceV3EnsureValue> {
  if (workspace.schema_version === 3 && workspace.path_binding && workspace.path_binding.execution_claim && workspace.path_binding.execution_claim_next && workspace.execution_claim_prepare_ref !== undefined) {
    return { ok: true, value: { workspace, migrated: false } };
  }
  const expected = digestOf(workspace);
  try {
    const persisted = updateStateAtomically<FeatureWorkspace>(
      projectRoot,
      (snapshot) => {
        const current = snapshot.state?.specification;
        if (!current) return { op: "fail", code: "state_missing", error: "feature state is unavailable during workspace migration" };
        // Derive the path binding while holding the state lock and require
        // the exact preimage observed before locking. A concurrent revocation
        // or handoff update must never be overwritten by stale v2 data.
        if (digestOf(current) !== expected) return { op: "fail", code: "state_conflict", error: "workspace changed during schema migration" };
        // For CTO admission, authenticate the original control-plane image
        // against this exact pre-migration snapshot. The migration itself
        // changes the feature state bytes (and therefore its revision/digest),
        // so verification after the write would self-invalidate an anchor that
        // points at this feature.
        if (admission) {
          const admissionError = verifyClaimAdmissionBinding(snapshot, pinnedRoot, featureId, admission.owner_run_id, admission.binding);
          if (admissionError) return { op: "fail", code: "state_conflict", error: admissionError };
        }
        let binding: WorkspacePathBinding;
        try {
          binding = captureWorkspacePathBinding(pinnedRoot, featureId);
        } catch (error) {
          return { op: "fail", code: "state_invalid", error: `workspace path binding cannot be captured safely: ${String(error)}` };
        }
        const upgraded = { ...current, schema_version: 3 as const, path_binding: binding, execution_claim_prepare_ref: null };
        const valid = validateFeatureWorkspaceRecord(upgraded);
        if (!valid.ok) return { op: "fail", code: "state_invalid", error: `workspace migration is invalid: ${valid.issues.join("; ")}` };
        return { op: "commit", state: { ...(snapshot.state as TeamState), specification: upgraded }, value: upgraded };
      },
      { selector: { feature_id: featureId, run_key: runKey }, rootGuard: pinnedRoot, pinnedRoot, preCommit: constitutionGuard },
    );
    if (!persisted.ok) {
      const code = !pinnedRoot.isStable() || persisted.code === "root_unstable"
        ? "SPEC_PATH_UNAUTHORIZED"
         : persisted.code === "state_conflict" ? "SPEC_EXECUTION_CLAIMED" : persisted.error.includes("SPEC_STALE:") ? "SPEC_STALE" : "SPEC_STATE_INVALID";
      return failure(code, persisted.error);
    }
    if (!persisted.state?.specification) return failure("SPEC_STATE_INVALID", "workspace migration committed without a workspace");
    return {
      ok: true,
      value: {
        workspace: persisted.state.specification,
        migrated: persisted.committed,
        ...(persisted.committed ? {
          postimage: {
            state_revision: persisted.revision,
            state_digest: persisted.raw_hash,
            ledger_digest: confirmationLedgerDigest(persisted.state),
          },
        } : {}),
      },
    };
  } catch (error) {
    return pinnedClaimFailure(error, "workspace schema migration failed");
  }
}

export function acquireExecutionClaim(projectRoot: string, featureId: string, request: ExecutionClaimRequest, providedRoot?: PinnedProjectRoot): ExecutionClaimAcquisitionResult {
  const requestValidation = validateImplementationHandoff(request.handoff);
  if (!requestValidation.ok) return failure("SPEC_HANDOFF_NOT_READY", `requested handoff is structurally invalid: ${requestValidation.issues.join("; ")}`);
  if (!isSafeFeatureId(featureId) || request.handoff.feature_id !== featureId) return failure("SPEC_PATH_UNAUTHORIZED", "claim and handoff feature identities must exactly match one safe feature");
  if (canonicalHandoffDigest(request.handoff) !== request.handoff.handoff_digest) return failure("SPEC_HANDOFF_NOT_READY", "requested handoff digest does not match its canonical content");
  if (request.admission_binding && request.owner_kind !== "cto") return failure("SPEC_STATE_INVALID", "CTO admission binding requires a cto claim owner");
  if (request.expected_workspace_digest !== undefined && !isSha256Hex(request.expected_workspace_digest)) return failure("SPEC_STATE_INVALID", "expected_workspace_digest must be a SHA-256 digest");
  const choice = request.owner_kind === "do_work" ? "do-work" : request.owner_kind;
  if (!request.handoff.execution_choices.includes(choice as "do-work" | "cto")) return failure("SPEC_HANDOFF_NOT_READY", `handoff does not authorize '${choice}' executor`);
  const readiness = evaluateHandoffReadiness(request.handoff);
  if (!readiness.ok) return failure(readiness.code === "SPEC_STALE" ? "SPEC_STALE" : "SPEC_HANDOFF_NOT_READY", readiness.error);
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return failure("SPEC_PATH_UNAUTHORIZED", "project root cannot be pinned for claim admission");
  let lock: { token: string; target: string; candidate: string; expected: { dev: number; ino: number; sha256: string } } | null = null;
  try {
    // Read the canonical workspace before creating any claim subtree. A
    // blocked/non-ready import must not leave an execution_claim artifact as
    // a side effect. Ready v2 workspaces are migrated only after this gate.
    const preflightState = stateWorkspaceFromPinned(pinnedRoot, featureId);
    if (!preflightState.ok) return { ok: false, code: preflightState.code, error: preflightState.error };
    if (preflightState.runKey !== request.run_key) return failure("SPEC_STATE_INVALID", "run_key does not match the canonical feature state");
    if (preflightState.workspace.execution_claim_ref === null && preflightState.workspace.status !== "implementation_ready") {
      return failure("SPEC_HANDOFF_NOT_READY", `workspace cannot be claimed from '${preflightState.workspace.status}'`);
    }
    const canonicalBindingError = canonicalClaimAdmissionError(pinnedRoot, featureId, preflightState.workspace, request);
    if (canonicalBindingError) return failure("SPEC_STATE_INVALID", canonicalBindingError);
    pinnedRoot.ensureDirectory(`.work-state/features/${featureId}/artifacts/execution_claim`);
    const acquiredLock = claimLock(pinnedRoot, featureId);
    if (!acquiredLock.ok) {
      const contender = contenderResult(pinnedRoot, featureId, request);
      if (contender) return contender;
      return failure(pinnedRoot.isStable() ? "SPEC_CLAIM_PERSIST_FAILED" : "SPEC_PATH_UNAUTHORIZED", acquiredLock.error);
    }
    lock = acquiredLock;
    pinnedRoot.ensureDirectory(`.work-state/features/${featureId}/artifacts/execution_claim/next`);
    pinnedRoot.ensureDirectory(`.work-state/features/${featureId}/artifacts/execution_claim/wal`);
    let loaded = loadClaimJournal(pinnedRoot, featureId, true);
    if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error };
    let journal = loaded.value;
    const stateResult = stateWorkspaceFromPinned(pinnedRoot, featureId);
    if (!stateResult.ok) return { ok: false, code: stateResult.code, error: stateResult.error };
    if (stateResult.runKey !== request.run_key) return failure("SPEC_STATE_INVALID", "run_key does not match the canonical feature state");
    const postLockBindingError = canonicalClaimAdmissionError(pinnedRoot, featureId, stateResult.workspace, request);
    if (postLockBindingError) return failure("SPEC_STATE_INVALID", postLockBindingError);
    if (request.expected_workspace_digest !== undefined
      && stateResult.workspace.execution_claim_prepare_ref === null
      && workspaceAdmissionDigest(stateResult.workspace, pinnedRoot.canonical_root) !== request.expected_workspace_digest) return failure("SPEC_EXECUTION_CLAIMED", "workspace changed since claim preparation");
    const admissionBindingBeforeMigration = request.owner_kind === "cto" ? request.admission_binding : undefined;
    const migrated = ensureWorkspaceV3(
      projectRoot,
      pinnedRoot,
      featureId,
      request.run_key,
      stateResult.workspace,
      admissionBindingBeforeMigration
        ? { owner_run_id: request.owner_run_id, binding: admissionBindingBeforeMigration }
        : undefined,
      () => {
        const constitutionError = constitutionClaimAdmissionError(pinnedRoot, stateResult.workspace, request.handoff);
        if (constitutionError) throw new Error(constitutionError);
      },
    );
    if (!migrated.ok) return { ok: false, code: migrated.code, error: migrated.error };
    let workspace = migrated.value.workspace;
    let preparedWalReceipt: PinnedRootWriteReceipt | undefined;
    // Resolve an already-bound claim before deriving any migration postimage
    // binding. A replay must authenticate and return the existing authority;
    // it must never reinterpret that claim through a newly observed revision.
    const authority = readClaimAuthority(pinnedRoot, featureId);
    if (!authority.ok) return { ok: false, code: authority.code, error: authority.error };
    if (authority.value) {
      if (!exactClaim(authority.value, {
        claim_id: authority.value.claim_id,
        handoff_digest: request.handoff.handoff_digest,
        owner_kind: request.owner_kind,
        owner_run_id: request.owner_run_id,
      }) || !sameAdmissionBinding(authority.value.admission_binding, admissionBindingBeforeMigration)) {
        return failureWithClaim("SPEC_EXECUTION_CLAIMED", `feature '${featureId}' is already claimed by ${ownerDescription(authority.value)}`, authority.value);
      }
      const replayConstitutionError = constitutionClaimAdmissionError(pinnedRoot, workspace, request.handoff);
      if (replayConstitutionError) return failureWithClaim("SPEC_STALE", replayConstitutionError, authority.value);
      return { ok: true, value: authority.value, disposition: "replayed" };
    }
    // A schema migration is a legitimate feature-state write. If the
    // confirmation anchor is this exact feature/run, the original binding is
    // intentionally stale after that write. Refresh only from the migration's
    // proven postimage; never read or adopt an arbitrary later revision.
    let admissionBinding = admissionBindingBeforeMigration;
    if (migrated.value.migrated && admissionBinding && migrated.value.postimage) {
      const anchorMatch = confirmationAnchorMatchesTarget(pinnedRoot, admissionBinding, request.owner_run_id, featureId, request.run_key);
      if (!anchorMatch.ok) return failure("SPEC_STATE_INVALID", anchorMatch.error);
      if (anchorMatch.matches) {
        admissionBinding = {
          ...admissionBinding,
          confirmation_state_revision: migrated.value.postimage.state_revision,
          confirmation_state_digest: migrated.value.postimage.state_digest,
          confirmation_ledger_digest: migrated.value.postimage.ledger_digest,
        };
      }
    }
    const admissionRequest = admissionBinding === request.admission_binding
      ? request
      : { ...request, admission_binding: admissionBinding };
    // A released journal tail can be durable while its workspace CAS was
    // interrupted. Repair that exact bound workspace before admitting a new
    // claim; otherwise the stale reference would make reacquisition appear
    // unavailable forever.
    const releasedTail = journal.tail?.claim;
    if (releasedTail?.status === "released" && workspace.execution_claim_ref === releasedTail.claim_id) {
      const healed = healReleasedClaimWorkspace(projectRoot, pinnedRoot, featureId, request.run_key, releasedTail);
      if (!healed) return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "released claim is bound to a stale workspace");
      if (!healed.ok) return healed;
      workspace = healed.value;
      loaded = loadClaimJournal(pinnedRoot, featureId, false);
      if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error };
      journal = loaded.value;
    }
    const walRead = readWalRecords(journal);
    if (!walRead.ok) return { ok: false, code: walRead.code, error: walRead.error };
    const candidateClaims = journal.claims.filter((candidate) => !isLiveExecutionClaim(candidate) || (authority.value && exactClaim(candidate, authority.value)));
    const expectedClaimId = deterministicClaimId(pinnedRoot, featureId, admissionRequest);
    const preparedCandidates = walRead.value.filter((record): record is AcquireClaimPreparedWal =>
      record.operation === "acquire_prepared"
      && record.feature_id === featureId
      && record.run_key === request.run_key
      && record.handoff_ref === request.handoff.handoff_id
      && record.claim.owner_kind === request.owner_kind
      && record.claim.owner_run_id === request.owner_run_id
      && record.claim.handoff_digest === request.handoff.handoff_digest
      && sameAdmissionBinding(record.claim.admission_binding, admissionBinding));
    if (preparedCandidates.length > 1) {
      return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "multiple claim preparation WALs match the canonical acquisition request");
    }
    const expectedPreviousDigest = journal.tail ? journalDigest(journal.tail) : null;
    const terminalReleasePreviousDigest = releasedTail?.status === "released" && journal.tail ? journal.tail.previous_digest : null;
    for (const candidate of preparedCandidates) {
      const predecessorMatches = candidate.previous_digest === expectedPreviousDigest
        || (releasedTail?.status === "released"
          && exactClaim(releasedTail, candidate.claim)
          && candidate.previous_digest === terminalReleasePreviousDigest);
      if (candidate.transaction_id !== deterministicTransactionId(pinnedRoot, featureId, admissionRequest, candidate.expected_workspace_digest)
        || candidate.claim.claim_id !== expectedClaimId
        || !predecessorMatches) {
        return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "claim preparation WAL is not bound to the canonical acquisition request");
      }
    }
    let prepared = preparedCandidates[0];
    if (workspace.execution_claim_prepare_ref && (!prepared || workspace.execution_claim_prepare_ref !== prepared.transaction_id)) {
      return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "feature has an unresolved claim preparation transaction");
    }
    // A compensation release may already be the canonical tail when the
    // previous attempt crashed before clearing its preparation marker/WAL.
    // Consume that exact terminal pair once, without appending another
    // release record; the validated WAL read retained its inode descriptor.
    if (releasedTail?.status === "released" && prepared && exactClaim(releasedTail, prepared.claim)) {
      if (workspace.execution_claim_prepare_ref === prepared.transaction_id) {
        const cleared = clearClaimPreparation(projectRoot, pinnedRoot, featureId, request.run_key, prepared.transaction_id);
        if (!cleared.ok) return failure("SPEC_CLAIM_RECOVERY_REQUIRED", `released claim preparation cleanup failed: ${cleared.error}`);
        workspace = cleared.value;
      }
      try { removePreparedWalAfterRead(pinnedRoot, journal, prepared); }
      catch (error) {
        return failure("SPEC_CLAIM_PERSIST_FAILED", `released claim WAL cleanup failed: ${String(error)}`);
      }
      prepared = undefined;
    }
    let claim: ExecutionClaim;
    let disposition: ExecutionClaimAcquisitionDisposition = "created";
    if (prepared) {
      if (!sameRootIdentity(prepared.project_root_identity, {
        canonical_path: pinnedRoot.canonical_root,
        dev: pinnedRoot.dev,
        ino: pinnedRoot.ino,
      })) return failure("SPEC_PATH_UNAUTHORIZED", "claim preparation root identity changed");
      if (!samePathBinding(prepared.path_binding, workspace.path_binding)
        || prepared.workspace_path_binding_digest !== workspacePathBindingDigest(workspace.path_binding)) {
        return failure("SPEC_PATH_UNAUTHORIZED", "claim preparation workspace path binding changed");
      }
      claim = prepared.claim;
      disposition = "replayed";
    } else if (authority.value) {
      claim = authority.value;
      disposition = "replayed";
    } else {
      const computed = computeExecutionClaim({ ...admissionRequest, active_claims: candidateClaims });
      if (!computed.ok) return computed;
      claim = {
        ...computed.value,
        claim_id: deterministicClaimId(pinnedRoot, featureId, admissionRequest),
      };
    }
    let admissionWorkspace = workspace;
    const admissionVerification = updateStateAtomically(
      pinnedRoot.canonical_root,
      (snapshot) => {
        const current = snapshot.state?.specification;
        if (!snapshot.state || !current) return { op: "fail", code: "state_missing", error: "canonical feature workspace is unavailable" } as const;
        admissionWorkspace = current;
        if (admissionBinding) {
          const admissionError = verifyClaimAdmissionBinding(snapshot, pinnedRoot, featureId, request.owner_run_id, admissionBinding);
          if (admissionError) return { op: "fail", code: "state_conflict", error: admissionError } as const;
        }
        return { op: "discard", value: true } as const;
      },
      { selector: { feature_id: featureId, run_key: request.run_key }, branchNeutral: true, pinnedRoot, preCommit: () => {
        const constitutionError = constitutionClaimAdmissionError(pinnedRoot, admissionWorkspace, admissionRequest.handoff);
        if (constitutionError) throw new Error(constitutionError);
      } },
    );
    if (!admissionVerification.ok) {
      if (!pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", admissionVerification.error);
      if (admissionVerification.error.includes("SPEC_STALE:")) return failure("SPEC_STALE", admissionVerification.error);
      return failure("SPEC_STATE_INVALID", admissionVerification.error);
    }
    if (!prepared) {
      const beforeWalBindingError = canonicalClaimAdmissionError(pinnedRoot, featureId, workspace, request);
      if (beforeWalBindingError) return failure("SPEC_STATE_INVALID", beforeWalBindingError);
    }
    const expectedWorkspaceDigest = prepared?.expected_workspace_digest ?? digestOf(workspace);
    if (prepared) {
      if (workspace.execution_claim_prepare_ref === prepared.transaction_id) {
        const unprepared = { ...workspace, execution_claim_prepare_ref: null };
        if (digestOf(unprepared) !== expectedWorkspaceDigest) return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "prepared workspace does not match the acquire WAL preimage");
      } else if (digestOf(workspace) !== expectedWorkspaceDigest) {
        return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "workspace changed before claim preparation could be recovered");
      }
    }
    const transactionId = prepared?.transaction_id ?? deterministicTransactionId(pinnedRoot, featureId, admissionRequest, expectedWorkspaceDigest);
    if (!prepared) {
      const wal: AcquireClaimPreparedWal = {
        schema: 1,
        operation: "acquire_prepared",
        transaction_id: transactionId,
        claim,
        feature_id: featureId,
        run_key: request.run_key,
        handoff_ref: request.handoff.handoff_id,
        expected_workspace_digest: expectedWorkspaceDigest,
        previous_digest: journal.tail ? journalDigest(journal.tail) : null,
        workspace_path_binding_digest: workspacePathBindingDigest(workspace.path_binding),
        project_root_identity: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
        path_binding: workspace.path_binding,
        created_at: request.acquired_at ?? new Date().toISOString(),
      };
      const beforeWalConstitutionError = constitutionClaimAdmissionError(pinnedRoot, workspace, admissionRequest.handoff);
      if (beforeWalConstitutionError) return failure("SPEC_STALE", beforeWalConstitutionError);
      const written = writePreparedWal(journal, wal, () => {
        const error = constitutionClaimAdmissionError(pinnedRoot, workspace, admissionRequest.handoff);
        if (error) throw new Error(error);
      });
      if (!written.ok) return written;
      preparedWalReceipt = written.wal_receipt;
    }
    let preparedStateRevision: number | undefined;
    let preparedStateDigest: string | undefined;
    if (workspace.execution_claim_prepare_ref !== transactionId) {
      const preparedWorkspace = claimWorkspaceCas(projectRoot, pinnedRoot, featureId, request.run_key, digestOf(workspace), (current) => {
        if (current.schema_version !== 3 || current.execution_claim_ref !== null) return { error: "workspace is no longer available for claim preparation" };
        if (current.execution_claim_prepare_ref && current.execution_claim_prepare_ref !== transactionId) return { error: "workspace has a different unresolved claim preparation" };
        if (current.status !== "implementation_ready") return { error: `workspace cannot be prepared from '${current.status}'` };
        return { ...current, execution_claim_prepare_ref: transactionId };
      }, undefined, undefined, (current) => {
        const constitutionError = constitutionClaimAdmissionError(pinnedRoot, current, admissionRequest.handoff);
        if (constitutionError) throw new Error(constitutionError);
      });
      if (!preparedWorkspace.ok) {
        try { removePreparedWalIfOwned(pinnedRoot, journal, transactionId, preparedWalReceipt); }
        catch (error) {
          return failure("SPEC_CLAIM_PERSIST_FAILED", preparedWorkspace.error + "; preparation WAL cleanup failed: " + String(error));
        }
        return preparedWorkspace;
      }
      workspace = preparedWorkspace.value;
      preparedStateRevision = preparedWorkspace.state_revision;
      preparedStateDigest = preparedWorkspace.state_digest;
    }
    if (workspace.execution_claim_prepare_ref === transactionId && preparedStateRevision === undefined) {
      const preparedState = readPinnedAdmissionState(pinnedRoot, featureId, request.run_key, { allowUnstable: true });
      if (!preparedState.ok) return failure("SPEC_CLAIM_RECOVERY_REQUIRED", preparedState.error);
      if (!preparedState.state.specification) return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "prepared workspace is unavailable during claim activation");
      workspace = preparedState.state.specification;
      preparedStateRevision = preparedState.state_revision;
      preparedStateDigest = preparedState.state_digest;
    }

    loaded = loadClaimJournal(pinnedRoot, featureId, true);
    if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error };
    journal = loaded.value;
    const tail = journal.tail?.claim;
    if (!tail || !exactClaim(tail, claim) || tail.status !== "active") {
      if (tail && isLiveExecutionClaim(tail) && !exactClaim(tail, claim)) {
        return failureWithClaim("SPEC_EXECUTION_CLAIMED", `feature '${featureId}' is already claimed by ${ownerDescription(tail)}`, tail);
      }
      const beforeAppendConstitutionError = constitutionClaimAdmissionError(pinnedRoot, workspace, admissionRequest.handoff);
      if (beforeAppendConstitutionError) return failure("SPEC_STALE", beforeAppendConstitutionError);
      const appended = appendClaim(journal, claim, transactionId, "active", () => {
        const error = constitutionClaimAdmissionError(pinnedRoot, workspace, admissionRequest.handoff);
        if (error) throw new Error(error);
      });
      if (!appended.ok) {
        loaded = loadClaimJournal(pinnedRoot, featureId, false);
        if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error };
        const raced = loaded.value.tail?.claim;
        if (!raced || !exactClaim(raced, claim)) {
          if (raced && isLiveExecutionClaim(raced)) {
            return failureWithClaim("SPEC_EXECUTION_CLAIMED", `feature '${featureId}' is already claimed by ${ownerDescription(raced)}`, raced);
          }
          return failureWithClaim("SPEC_CLAIM_PERSIST_FAILED", appended.error, raced ?? claim);
        }
      }
    } else disposition = "replayed";
    let activationRequest = admissionRequest;
    if (admissionBinding) {
      const anchorMatch = confirmationAnchorMatchesTarget(pinnedRoot, admissionBinding, request.owner_run_id, featureId, request.run_key);
      if (!anchorMatch.ok) return failure("SPEC_STATE_INVALID", anchorMatch.error);
      if (anchorMatch.matches) {
        if (preparedStateRevision === undefined || preparedStateDigest === undefined) return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "prepared workspace postimage is unavailable during claim activation");
        activationRequest = {
          ...admissionRequest,
          admission_binding: {
            ...admissionBinding,
            confirmation_state_revision: preparedStateRevision,
            confirmation_state_digest: preparedStateDigest,
          },
        };
      }
    }
    const activeWorkspace = activateClaimWorkspace(projectRoot, pinnedRoot, featureId, request.run_key, workspace, transactionId, claim, admissionRequest, activationRequest.admission_binding, preparedStateRevision);
    if (!activeWorkspace.ok) {
      const authorityAfter = readClaimAuthority(pinnedRoot, featureId);
      if (authorityAfter.ok && authorityAfter.value) {
        if (exactClaim(authorityAfter.value, claim) && committedClaimBinding(pinnedRoot, featureId, request, claim)) {
          const replayState = stateWorkspaceFromPinned(pinnedRoot, featureId);
          if (!replayState.ok) return failure("SPEC_STALE", replayState.error);
          const replayConstitutionError = constitutionClaimAdmissionError(pinnedRoot, replayState.workspace, request.handoff);
          if (replayConstitutionError) return failureWithClaim("SPEC_STALE", replayConstitutionError, authorityAfter.value);
          return { ok: true, value: authorityAfter.value, disposition: "replayed" };
        }
        if (exactClaim(authorityAfter.value, claim)) {
          // The active journal is not sufficient authority until its canonical
          // workspace postimage is also bound to the same handoff.
        } else {
          return failureWithClaim("SPEC_EXECUTION_CLAIMED", `feature '${featureId}' is already claimed by ${ownerDescription(authorityAfter.value)}`, authorityAfter.value);
        }
      }
      if (!authorityAfter.ok && authorityAfter.code === "SPEC_PATH_UNAUTHORIZED") return authorityAfter;
      const compensated = compensateAcquiredClaim(pinnedRoot, featureId, claim, activeWorkspace.error);
      if (!compensated.ok) return { ok: false, code: "SPEC_CLAIM_PERSIST_FAILED", error: `${activeWorkspace.error}; compensation failed: ${compensated.error}`, claim };
      if (!prepared) {
        const cleared = clearClaimPreparation(projectRoot, pinnedRoot, featureId, request.run_key, transactionId);
        if (!cleared.ok) return { ok: false, code: "SPEC_CLAIM_PERSIST_FAILED", error: `${activeWorkspace.error}; preparation cleanup failed: ${cleared.error}`, claim };
        try { removePreparedWalIfOwned(pinnedRoot, journal, transactionId, preparedWalReceipt); }
        catch (error) { return { ok: false, code: "SPEC_CLAIM_PERSIST_FAILED", error: `${activeWorkspace.error}; preparation WAL cleanup failed: ${String(error)}`, claim }; }
      }
      return { ok: false, code: "SPEC_CLAIM_PERSIST_FAILED", error: activeWorkspace.error, claim };
    }
    const final = readClaimAuthority(pinnedRoot, featureId);
    if (!final.ok || !final.value || !exactClaim(final.value, claim) || final.value.status !== "active") {
      // Both postimages have committed by this point. A descendant swap
      // during this final observational read must not report failure while
      // the exact workspace postimage remains bound on the pinned root.
      const postimage = stateWorkspaceFromPinned(pinnedRoot, featureId);
      const boundHandoff = postimage.ok
        ? readCanonicalHandoffForClaim(pinnedRoot, featureId, postimage.workspace, { allowUnstable: true })
        : null;
      if (pinnedRoot.isStable() && postimage.ok
        && postimage.workspace.status === "claimed"
        && postimage.workspace.execution_claim_ref === claim.claim_id
        && postimage.workspace.execution_claim_prepare_ref === null
        && postimage.workspace.handoff_ref === request.handoff.handoff_id
        && boundHandoff?.ok
        && boundHandoff.handoff.handoff_digest === claim.handoff_digest) {
        return { ok: true, value: claim, disposition };
      }
      if (!final.ok) return { ok: false, code: final.code, error: final.error };
      return failureWithClaim("SPEC_CLAIM_PERSIST_FAILED", "claim and workspace postimages were not paired after acquisition", claim);
    }
    return { ok: true, value: final.value, disposition };
  } catch (error) {
    // Two contenders may race while lazily creating the claim directory
    // before either can publish its lock. Treat the descriptor-level
    // EEXIST as a loser path only after a bounded probe proves an exact live
    // journal authority; otherwise preserve the original typed failure.
    if (error instanceof PinnedRootError && error.code === "exists") {
      const contender = contenderResult(pinnedRoot, featureId, request);
      if (contender) return contender;
    }
    if (error instanceof PinnedRootError && error.code === "write_failed") {
      return { ok: false, code: pinnedRoot.isStable() ? "SPEC_CLAIM_PERSIST_FAILED" : "SPEC_PATH_UNAUTHORIZED", error: `claim acquisition failed: ${error.message}` };
    }
    const failed = pinnedClaimFailure(error, "claim acquisition failed");
    return failed.ok ? { ok: false, code: "SPEC_CLAIM_PERSIST_FAILED", error: "claim acquisition failed" } : { ok: false, code: failed.code, error: failed.error };
  } finally {
    if (lock) releaseClaimLock(pinnedRoot, lock);
    if (!providedRoot) pinnedRoot.close();
  }
}
function makeClaimMutationReceipt(pinnedRoot: PinnedProjectRoot, journal: PinnedRootWriteReceipt, state?: readonly StateMutationReceipt[]): ExecutionClaimMutationReceipt {
  return {
    ...(state ? { state } : {}),
    journal,
    rollback: () => {
      let ok = true;
      if (state) ok = rollbackStateMutationReceipts(pinnedRoot, state) && ok;
      ok = journal.rollback() && ok;
      return ok;
    },
  };
}

function transitionDurable(projectRoot: string, featureId: string, input: ClaimTransitionInput, status: "released" | "blocked", providedRoot?: PinnedProjectRoot, publicationOptions: ClaimTransitionPublicationOptions = {}): ExecutionClaimResult<ExecutionClaim> {
  if (!isSafeFeatureId(featureId) || !nonBlank(input.claim_id) || !isSha256Hex(input.handoff_digest) || !nonBlank(input.owner_run_id)) return failure("SPEC_STATE_INVALID", "transition requires exact feature, claim, digest, owner, and run");
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return failure("SPEC_PATH_UNAUTHORIZED", "project root cannot be pinned for claim transition");
  let lock: { token: string; target: string; candidate: string; expected: { dev: number; ino: number; sha256: string } } | null = null;
  let journalReceipt: PinnedRootWriteReceipt | undefined;
  let stateReceipts: readonly StateMutationReceipt[] | undefined;
  let ambiguousJournalCommitted = false;
  try {
    pinnedRoot.ensureDirectory(`.work-state/features/${featureId}/artifacts/execution_claim/next`);
    pinnedRoot.ensureDirectory(`.work-state/features/${featureId}/artifacts/execution_claim/wal`);
    const acquiredLock = claimLock(pinnedRoot, featureId);
    if (!acquiredLock.ok) return failure("SPEC_CLAIM_PERSIST_FAILED", acquiredLock.error);
    lock = acquiredLock;
    const authority = readClaimAuthority(pinnedRoot, featureId);
    if (!authority.ok) return authority;
    const current = authority.value;
    if (!current || !exactClaim(current, input)) {
      if (current) return failureWithClaim("SPEC_EXECUTION_CLAIMED", "transition identity does not match current authority", current);
      return failure("SPEC_EXECUTION_CLAIMED", "transition identity does not match current authority");
    }
    let releaseWorkspaceState: ReturnType<typeof stateWorkspaceFromPinned> | null = null;
    let releaseHandoff: ImplementationHandoff | null = null;
    if (status === "released") {
      const state = stateWorkspaceFromPinned(pinnedRoot, featureId);
      if (!state.ok) return failureWithClaim(state.code, state.error, current);
      const canonical = readCanonicalHandoffForClaim(pinnedRoot, featureId, state.workspace);
      if (!canonical.ok) return failureWithClaim("SPEC_STATE_INVALID", canonical.error, current);
      const constitutionError = constitutionClaimAdmissionError(pinnedRoot, state.workspace, canonical.handoff);
      if (constitutionError) return failureWithClaim("SPEC_STALE", constitutionError, current);
      releaseWorkspaceState = state;
      releaseHandoff = canonical.handoff;
    }
    const computed = status === "released"
      ? computeReleaseExecutionClaim({ claim: current, reason: input.reason, updated_at: input.updated_at })
      : computeBlockExecutionClaim({ claim: current, reason: input.reason, updated_at: input.updated_at });
    if (!computed.ok) return computed;
    const loaded = loadClaimJournal(pinnedRoot, featureId, false);
    if (!loaded.ok) return loaded;
    if (status === "released" && releaseWorkspaceState && releaseHandoff) {
      const beforeReleaseAppendConstitutionError = constitutionClaimAdmissionError(pinnedRoot, releaseWorkspaceState.workspace, releaseHandoff);
      if (beforeReleaseAppendConstitutionError) return failureWithClaim("SPEC_STALE", beforeReleaseAppendConstitutionError, current);
    }
    const committed = appendClaim(loaded.value, computed.value, undefined, undefined, releaseHandoff && releaseWorkspaceState
      ? () => {
        const error = constitutionClaimAdmissionError(pinnedRoot, releaseWorkspaceState!.workspace, releaseHandoff!);
        if (error) throw new Error(error);
      }
      : undefined, (receipt) => { journalReceipt = receipt; });
    if (!committed.ok) {
      if (status !== "released") return failureWithClaim(committed.code, committed.error, current);
      // A descriptor helper may publish the successor before its response or
      // ACK is lost. Re-read the canonical tail before deciding whether the
      // release append actually committed; never release the workspace based
      // on an ambiguous error alone.
      const replay = loadClaimJournal(pinnedRoot, featureId, false);
      if (!replay.ok) return failureWithClaim(committed.code, committed.error, current);
      const replayTail = replay.value.tail?.claim;
      if (!replayTail || replayTail.status !== "released" || !sameClaimRecord(replayTail, computed.value)) {
        return failureWithClaim(committed.code, committed.error, replayTail ?? current);
      }
      ambiguousJournalCommitted = true;
    }
    const rollbackReleasePublication = (): boolean => {
      let ok = true;
      if (stateReceipts) ok = rollbackStateMutationReceipts(pinnedRoot, stateReceipts) && ok;
      if (journalReceipt) ok = journalReceipt.rollback() && ok;
      if (!ok) return false;
      const restored = readClaimAuthority(pinnedRoot, featureId);
      return restored.ok && Boolean(restored.value) && exactClaim(restored.value!, current) && restored.value!.status === "active";
    };
    if (status === "blocked") {
      const verified = readClaimAuthority(pinnedRoot, featureId);
      if (!verified.ok) {
        const rolledBack = rollbackReleasePublication();
        return rolledBack ? verified : failureWithClaim("SPEC_CLAIM_PERSIST_FAILED", `${verified.error}; claim publication rollback failed`, computed.value);
      }
      if (!verified.value || !exactClaim(verified.value, computed.value) || verified.value.status !== "blocked") {
        const rolledBack = rollbackReleasePublication();
        return failureWithClaim("SPEC_CLAIM_PERSIST_FAILED", rolledBack ? "blocked claim journal postimage was not paired" : "blocked claim journal postimage was not paired; claim publication rollback failed", computed.value);
      }
      const receipt = journalReceipt ? makeClaimMutationReceipt(pinnedRoot, journalReceipt, stateReceipts) : undefined;
      if (receipt) {
        try { publicationOptions.onReceipt?.(receipt); } catch (error) {
          receipt.rollback();
          return failureWithClaim("SPEC_CLAIM_PERSIST_FAILED", `claim publication receipt registrar failed: ${String(error)}`, verified.value);
        }
      }
      return { ok: true, value: verified.value, ...(receipt ? { receipt } : {}) };
    }

    // Journal release is not success until its workspace postimage commits.
    // Retry once for a one-shot state CAS failure, then perform the same
    // exact repair used by acquisition recovery.
    const transitionState = releaseWorkspaceState ?? stateWorkspaceFromPinned(pinnedRoot, featureId);
    if (!transitionState.ok) {
      const rolledBack = rollbackReleasePublication();
      return failureWithClaim(rolledBack ? transitionState.code : "SPEC_CLAIM_PERSIST_FAILED", rolledBack ? transitionState.error : `${transitionState.error}; release publication rollback failed`, computed.value);
    }
    if (releaseHandoff) {
      const beforeReleaseCasConstitutionError = constitutionClaimAdmissionError(pinnedRoot, transitionState.workspace, releaseHandoff);
      if (beforeReleaseCasConstitutionError) {
        const rolledBack = rollbackReleasePublication();
        return failureWithClaim(rolledBack ? "SPEC_STALE" : "SPEC_CLAIM_PERSIST_FAILED", rolledBack ? beforeReleaseCasConstitutionError : `${beforeReleaseCasConstitutionError}; release publication rollback failed`, current);
      }
    }
    const releaseGuard = (candidate: FeatureWorkspace) => {
      if (!releaseHandoff) return;
      const constitutionError = constitutionClaimAdmissionError(pinnedRoot, candidate, releaseHandoff);
      if (constitutionError) throw new Error(constitutionError);
    };
    let workspaceRelease = releaseClaimWorkspace(projectRoot, pinnedRoot, featureId, transitionState.runKey, current, releaseGuard, true);
    if (workspaceRelease.ok) stateReceipts = workspaceRelease.receipts;
    if (!workspaceRelease.ok) {
      workspaceRelease = releaseClaimWorkspace(projectRoot, pinnedRoot, featureId, transitionState.runKey, current, releaseGuard, Boolean(publicationOptions.captureReceipts || publicationOptions.onReceipt));
      if (workspaceRelease.ok) stateReceipts = workspaceRelease.receipts;
    }
    if (!workspaceRelease.ok && workspaceRelease.code === "SPEC_STALE" && !ambiguousJournalCommitted) {
      const rolledBack = rollbackReleasePublication();
      return failureWithClaim(rolledBack ? "SPEC_STALE" : "SPEC_CLAIM_PERSIST_FAILED", rolledBack ? workspaceRelease.error : `${workspaceRelease.error}; release publication rollback failed`, computed.value);
    }
    if (!workspaceRelease.ok) {
      const repaired = healReleasedClaimWorkspace(projectRoot, pinnedRoot, featureId, transitionState.runKey, computed.value);
      if (!repaired?.ok) {
        const rolledBack = rollbackReleasePublication();
        const repairCode = repaired && !repaired.ok ? repaired.code : workspaceRelease.code;
        const repairError = repaired && !repaired.ok ? repaired.error : `${workspaceRelease.error}; released workspace recovery unavailable`;
        return failureWithClaim(rolledBack ? repairCode : "SPEC_CLAIM_PERSIST_FAILED", rolledBack ? repairError : `${repairError}; release publication rollback failed`, computed.value);
      }
      if (repaired.receipts) stateReceipts = repaired.receipts;
    }
    let verified = releasedWorkspacePostimage(pinnedRoot, featureId, computed.value);
    if (!verified.ok && ambiguousJournalCommitted) {
      // The journal append is authoritative once the exact tail was proven.
      // If the first workspace CAS or postimage read lost a race, make the
      // same deterministic repair used by ordinary release recovery instead
      // of returning with a released tail and an active workspace reference.
      const repaired = healReleasedClaimWorkspace(projectRoot, pinnedRoot, featureId, transitionState.runKey, computed.value);
      if (repaired?.ok) {
        stateReceipts = repaired.receipts;
        verified = releasedWorkspacePostimage(pinnedRoot, featureId, computed.value);
      }
      if (!verified.ok) {
        return failureWithClaim("SPEC_CLAIM_RECOVERY_REQUIRED", `${verified.error}; ambiguous release publication requires workspace recovery`, computed.value);
      }
    }
    if (!verified.ok) {
      const rolledBack = rollbackReleasePublication();
      return failureWithClaim("SPEC_CLAIM_PERSIST_FAILED", rolledBack ? verified.error : `${verified.error}; release publication rollback failed`, computed.value);
    }
    const receipt = journalReceipt ? makeClaimMutationReceipt(pinnedRoot, journalReceipt, stateReceipts) : undefined;
    if (receipt) {
      try { publicationOptions.onReceipt?.(receipt); } catch (error) {
        receipt.rollback();
        return failureWithClaim("SPEC_CLAIM_PERSIST_FAILED", `claim publication receipt registrar failed: ${String(error)}`, computed.value);
      }
    }
    return { ok: true, value: computed.value, ...(receipt ? { receipt } : {}) };
  } finally {
    if (lock) releaseClaimLock(pinnedRoot, lock);
    if (!providedRoot) pinnedRoot.close();
  }
}
export function releaseExecutionClaim(projectRoot: string, featureId: string, input: ClaimTransitionInput, providedRoot?: PinnedProjectRoot, publicationOptions?: ClaimTransitionPublicationOptions): ExecutionClaimResult<ExecutionClaim> { return transitionDurable(projectRoot, featureId, input, "released", providedRoot, publicationOptions); }
export function blockExecutionClaim(projectRoot: string, featureId: string, input: ClaimTransitionInput, providedRoot?: PinnedProjectRoot, publicationOptions?: ClaimTransitionPublicationOptions): ExecutionClaimResult<ExecutionClaim> { return transitionDurable(projectRoot, featureId, input, "blocked", providedRoot, publicationOptions); }
function recoverCompletionWal(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  journal: ClaimJournal,
  walRecords: readonly ClaimPreparedWal[],
  state: { workspace: FeatureWorkspace; runKey: string },
  input: ClaimCompletionInput,
  authorization?: CompletionRecoveryAuthorization,
): ExecutionClaimResult<ExecutionClaim> | null {
  const tail = journal.tail?.claim;
  if (!state.workspace || state.workspace.status !== "completed" || !state.workspace.execution_claim_ref || !tail || tail.status !== "active" || !exactClaim(tail, input)) return null;
  const matching = walRecords.filter((record): record is CompleteClaimPreparedWal =>
    record.operation === "complete_prepared"
    && record.claim.claim_id === tail.claim_id
    && exactClaim(record.claim, tail)
    && record.conformance_ref === input.conformance.conformance_id);
  if (matching.length !== 1) return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completed workspace has no unique matching completion WAL");
  const wal = matching[0]!;
  if (
    wal.conformance_artifact_digest !== digestOf(input.conformance)
    || wal.matrix_digest !== input.conformance.matrix_digest
    || wal.completed_workspace_digest !== digestOf(state.workspace)
    || state.workspace.execution_claim_ref !== tail.claim_id
    || state.workspace.implementation_conformance_ref !== wal.conformance_ref
    || !sameRootIdentity(wal.project_root_identity, { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino })
    || !samePathBinding(wal.path_binding, state.workspace.path_binding)
    || wal.workspace_path_binding_digest !== workspacePathBindingDigest(state.workspace.path_binding)
  ) return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completion WAL does not match the completed workspace postimage");
  const computed = computeCompleteExecutionClaim({ claim: tail, conformance: input.conformance, updated_at: input.updated_at });
  if (!computed.ok) return computed;
  if (!exactClaim(wal.claim, computed.value) || wal.claim.status !== "completed") return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completion WAL claim postimage is not exact");
  if (authorization?.preauthorize && !authorization.preauthorize(tail, state.workspace, state.runKey)) return null;
  const recoveryHandoff = readCanonicalHandoffForClaim(pinnedRoot, featureId, state.workspace, { allowUnstable: true });
  if (!recoveryHandoff.ok) return failure("SPEC_STATE_INVALID", recoveryHandoff.error);
  const recoveryConstitutionError = constitutionClaimAdmissionError(pinnedRoot, state.workspace, recoveryHandoff.handoff);
  if (recoveryConstitutionError) return failure("SPEC_STALE", recoveryConstitutionError);
  const appended = appendClaim(journal, wal.claim, wal.transaction_id, "completed", () => {
    const error = constitutionClaimAdmissionError(pinnedRoot, state.workspace, recoveryHandoff.handoff);
    if (error) throw new Error(error);
  });
  if (!appended.ok) {
    const replay = loadClaimJournal(pinnedRoot, featureId, false);
    if (!replay.ok) return replay;
    const replayTail = replay.value.tail?.claim;
    if (!replayTail || !exactClaim(replayTail, wal.claim) || replayTail.status !== "completed") return failureWithClaim(appended.code, appended.error, tail);
  }
  const final = readClaimAuthority(pinnedRoot, featureId);
  if (!final.ok) {
    const postimage = stateWorkspaceFromPinned(pinnedRoot, featureId);
    const boundHandoff = postimage.ok
      ? readCanonicalHandoffForClaim(pinnedRoot, featureId, postimage.workspace, { allowUnstable: true })
      : null;
    if (pinnedRoot.isStable() && postimage.ok
      && postimage.workspace.status === "completed"
      && postimage.workspace.execution_claim_ref === wal.claim.claim_id
      && postimage.workspace.execution_claim_prepare_ref === null
      && postimage.workspace.implementation_conformance_ref === wal.conformance_ref
      && boundHandoff?.ok
      && boundHandoff.handoff.handoff_digest === wal.claim.handoff_digest) {
      return { ok: true, value: wal.claim };
    }
    return final;
  }
  if (!final.value || !exactClaim(final.value, wal.claim) || final.value.status !== "completed") {
    const postimage = stateWorkspaceFromPinned(pinnedRoot, featureId);
    const boundHandoff = postimage.ok
      ? readCanonicalHandoffForClaim(pinnedRoot, featureId, postimage.workspace, { allowUnstable: true })
      : null;
    if (pinnedRoot.isStable() && postimage.ok
      && postimage.workspace.status === "completed"
      && postimage.workspace.execution_claim_ref === wal.claim.claim_id
      && postimage.workspace.execution_claim_prepare_ref === null
      && postimage.workspace.implementation_conformance_ref === wal.conformance_ref
      && boundHandoff?.ok
      && boundHandoff.handoff.handoff_digest === wal.claim.handoff_digest) {
      return { ok: true, value: wal.claim };
    }
    return failureWithClaim("SPEC_CLAIM_RECOVERY_REQUIRED", "recovered completion claim is not paired with its workspace", wal.claim);
  }
  return { ok: true, value: final.value };
}

export function completeExecutionClaim(projectRoot: string, featureId: string, input: ClaimCompletionInput, providedRoot?: PinnedProjectRoot): ExecutionClaimResult<ExecutionClaim> {
  if (!isSafeFeatureId(featureId) || !nonBlank(input.claim_id) || !isSha256Hex(input.handoff_digest) || !nonBlank(input.owner_run_id)) {
    return failure("SPEC_STATE_INVALID", "completion requires exact feature, claim, digest, owner, and run");
  }
  if (input.expected_workspace_digest !== undefined && !isSha256Hex(input.expected_workspace_digest)) return failure("SPEC_STATE_INVALID", "expected_workspace_digest must be a SHA-256 digest");
  if (input.expected_state_revision !== undefined && (!Number.isSafeInteger(input.expected_state_revision) || input.expected_state_revision < 0)) return failure("SPEC_STATE_INVALID", "expected_state_revision must be a non-negative integer");
  if (input.expected_conformance_ref !== undefined && input.expected_conformance_ref !== null && !nonBlank(input.expected_conformance_ref)) return failure("SPEC_STATE_INVALID", "expected_conformance_ref must be non-blank when provided");
  if (input.expected_capability !== undefined && (!nonBlank(input.expected_capability.capability_id) || !nonBlank(input.expected_capability.capability_epoch))) return failure("SPEC_STATE_INVALID", "expected capability binding is invalid");
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return failure("SPEC_PATH_UNAUTHORIZED", "project root cannot be pinned for claim completion");
  let lock: { token: string; target: string; candidate: string; expected: { dev: number; ino: number; sha256: string } } | null = null;
  try {
    pinnedRoot.ensureDirectory(`.work-state/features/${featureId}/artifacts/execution_claim/next`);
    pinnedRoot.ensureDirectory(`.work-state/features/${featureId}/artifacts/execution_claim/wal`);
    const acquiredLock = claimLock(pinnedRoot, featureId);
    if (!acquiredLock.ok) return failure(pinnedRoot.isStable() ? "SPEC_CLAIM_PERSIST_FAILED" : "SPEC_PATH_UNAUTHORIZED", acquiredLock.error);
    lock = acquiredLock;

    let loaded = loadClaimJournal(pinnedRoot, featureId, false);
    if (!loaded.ok) return loaded;
    let walRead = readWalRecords(loaded.value);
    if (!walRead.ok) return walRead;
    const state = stateWorkspaceFromPinned(pinnedRoot, featureId);
    if (!state.ok) return state;
    const completionHandoff = readCanonicalHandoffForClaim(pinnedRoot, featureId, state.workspace);
    if (!completionHandoff.ok) return failure("SPEC_STATE_INVALID", completionHandoff.error);
    const completionConstitutionError = constitutionClaimAdmissionError(pinnedRoot, state.workspace, completionHandoff.handoff);
    if (completionConstitutionError) return failure("SPEC_STALE", completionConstitutionError);
    const recovered = recoverCompletionWal(pinnedRoot, featureId, loaded.value, walRead.value, state, input);
    if (recovered) return recovered;
    const authority = readClaimAuthority(pinnedRoot, featureId);
    if (!authority.ok) return authority;
    const current = authority.value;
    if (!current || !exactClaim(current, input)) {
      if (current) return failureWithClaim("SPEC_EXECUTION_CLAIMED", "completion identity does not match current authority", current);
      const unresolved = walRead.value.some((record) => record.operation === "complete_prepared");
      return unresolved
        ? failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completion has an unresolved terminal WAL without a bound active claim")
        : failure("SPEC_EXECUTION_CLAIMED", "completion identity does not match current authority");
    }

    const completionWals = walRead.value.filter((record): record is CompleteClaimPreparedWal =>
      record.operation === "complete_prepared" && record.claim.claim_id === current?.claim_id);
    if (input.expected_workspace_digest !== undefined && digestOf(state.workspace) !== input.expected_workspace_digest) {
      return failure("SPEC_EXECUTION_CLAIMED", "workspace changed after finalizer evidence admission");
    }
    if (input.expected_state_revision !== undefined) {
      const revision = (state.state as TeamState & { state_revision?: unknown }).state_revision;
      if (revision !== input.expected_state_revision) return failure("SPEC_EXECUTION_CLAIMED", "workflow state revision changed after finalizer evidence admission");
    }
    if (input.expected_conformance_ref !== undefined && state.workspace.implementation_conformance_ref !== input.expected_conformance_ref) {
      return failure("SPEC_IMPLEMENTATION_CONFORMANCE_FAILED", "workspace conformance reference changed after finalizer evidence admission");
    }
    if (input.expected_capability !== undefined) {
      const capability = state.state.dispatch_capability;
      if (!capability
        || capability.capability_id !== input.expected_capability.capability_id
        || capability.issued_for?.cursor_epoch !== input.expected_capability.capability_epoch) {
        return failure("SPEC_EXECUTION_CLAIMED", "dispatch capability changed after finalizer evidence admission");
      }
    }
    const matchingWal = completionWals.find((record) =>
      record.claim.handoff_digest === current?.handoff_digest
      && record.claim.owner_kind === current?.owner_kind
      && record.claim.owner_run_id === current?.owner_run_id
      && record.conformance_ref === input.conformance.conformance_id);
    if (completionWals.length > 0 && !matchingWal) {
      return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completion WAL does not match the current claim and conformance");
    }
    if (matchingWal && (
      matchingWal.conformance_artifact_digest !== digestOf(input.conformance)
      || matchingWal.matrix_digest !== input.conformance.matrix_digest
    )) {
      return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completion WAL conformance digest does not match the supplied canonical result");
    }
    if (current.status === "completed") {
      if (state.workspace.status !== "completed"
        || state.workspace.execution_claim_ref !== current.claim_id
        || state.workspace.implementation_conformance_ref !== input.conformance.conformance_id) {
        return matchingWal
          ? failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completed claim and workspace postimages are not paired")
          : failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completed claim has no exact completed workspace postimage");
      }
      if (completionWals.length !== 1 || !matchingWal) return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completed claim has no unique matching completion WAL");
      const canonicalConformance = readArtifactPinned<ImplementationConformanceResult>(
        pinnedRoot,
        `.work-state/features/${featureId}/artifacts/implementation_conformance`,
        input.conformance.conformance_id,
      );
      if (!canonicalConformance) return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completed claim conformance artifact is unavailable");
      const validation = validateImplementationConformance(canonicalConformance);
      const canonicalMatrixDigest = implementationConformanceMatrixDigest(canonicalConformance);
      if (!validation.ok || canonicalConformance.overall_status !== "pass" || canonicalMatrixDigest === null
        || canonicalConformance.matrix_digest !== canonicalMatrixDigest
        || canonicalConformance.conformance_id !== state.workspace.implementation_conformance_ref
        || canonicalConformance.feature_id !== featureId
        || canonicalConformance.handoff_id !== completionHandoff.handoff.handoff_id
        || canonicalConformance.handoff_digest !== current.handoff_digest
        || canonicalConformance.execution_claim_id !== current.claim_id
        || canonicalConformance.execution_owner !== current.owner_kind
        || canonicalConformance.execution_run_id !== current.owner_run_id
        || digestOf(canonicalConformance) !== digestOf(input.conformance)) {
        return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completed claim conformance does not match the canonical pinned artifact");
      }
      const journalTail = loaded.value.tail?.claim;
      if (!journalTail || !sameClaimRecord(journalTail, current) || journalTail.status !== "completed"
        || !sameClaimRecord(matchingWal.claim, current) || matchingWal.claim.status !== "completed"
        || matchingWal.conformance_ref !== canonicalConformance.conformance_id
        || matchingWal.conformance_artifact_digest !== digestOf(canonicalConformance)
        || matchingWal.matrix_digest !== canonicalConformance.matrix_digest
        || matchingWal.completed_workspace_digest !== digestOf(state.workspace)
        || matchingWal.workspace_path_binding_digest !== workspacePathBindingDigest(state.workspace.path_binding)
        || !sameRootIdentity(matchingWal.project_root_identity, { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino })
        || !samePathBinding(matchingWal.path_binding, state.workspace.path_binding)) {
        return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completed claim WAL, receipt, and workspace postimages are not exact");
      }
      return { ok: true, value: current };
    }

    const computed = matchingWal
      ? { ok: true as const, value: matchingWal.claim }
      : computeCompleteExecutionClaim({ claim: current, conformance: input.conformance, updated_at: input.updated_at });
    if (!computed.ok) return computed;
    const completedWorkspace: FeatureWorkspace = {
      ...state.workspace,
      status: "completed",
      execution_claim_prepare_ref: null,
      execution_claim_ref: current.claim_id,
      implementation_conformance_ref: input.conformance.conformance_id,
      next_action: {
        kind: "none",
        command: null,
        reason: `Implementation conformance '${input.conformance.conformance_id}' passed for claim '${current.claim_id}'; the feature is complete.`,
      },
    };
    if (matchingWal && (
      digestOf(state.workspace) !== matchingWal.expected_workspace_digest
      || digestOf(completedWorkspace) !== matchingWal.completed_workspace_digest
      || !exactClaim(matchingWal.claim, current)
      || matchingWal.claim.status !== "completed"
    )) {
      return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completion WAL does not match the exact workspace and claim postimages");
    }
    const transactionId = matchingWal?.transaction_id
      ?? `complete-${digestOf({ feature_id: featureId, claim: current, conformance: input.conformance }).slice(0, 48)}`;
    const wal: CompleteClaimPreparedWal = matchingWal ?? {
      schema: 1,
      operation: "complete_prepared",
      transaction_id: transactionId,
      claim: computed.value,
      conformance_ref: input.conformance.conformance_id,
      conformance_artifact_digest: digestOf(input.conformance),
      matrix_digest: input.conformance.matrix_digest,
      expected_workspace_digest: digestOf(state.workspace),
      completed_workspace_digest: digestOf(completedWorkspace),
      workspace_path_binding_digest: workspacePathBindingDigest(state.workspace.path_binding),
      project_root_identity: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
      path_binding: state.workspace.path_binding,
      created_at: input.updated_at ?? input.conformance.evaluated_at,
    };
    if (!sameRootIdentity(wal.project_root_identity, {
      canonical_path: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
    }) || !samePathBinding(wal.path_binding, state.workspace.path_binding)) {
      return failure("SPEC_PATH_UNAUTHORIZED", "completion WAL path binding changed");
    }
    if (wal.workspace_path_binding_digest !== workspacePathBindingDigest(state.workspace.path_binding)) {
      return failure("SPEC_PATH_UNAUTHORIZED", "completion WAL workspace path binding changed");
    }
    const beforeCompletionWalConstitutionError = constitutionClaimAdmissionError(pinnedRoot, state.workspace, completionHandoff.handoff);
    if (beforeCompletionWalConstitutionError) return failure("SPEC_STALE", beforeCompletionWalConstitutionError);
    const written = writePreparedWal(loaded.value, wal, () => {
      const error = constitutionClaimAdmissionError(pinnedRoot, state.workspace, completionHandoff.handoff);
      if (error) throw new Error(error);
    });
    if (!written.ok) return written;

    if (!matchingWal || state.workspace.status !== "completed") {
      const beforeCompletionCasConstitutionError = constitutionClaimAdmissionError(pinnedRoot, state.workspace, completionHandoff.handoff);
      if (beforeCompletionCasConstitutionError) return failure("SPEC_STALE", beforeCompletionCasConstitutionError);
      const completed = claimWorkspaceCas(
        projectRoot,
        pinnedRoot,
        featureId,
        state.runKey,
        digestOf(state.workspace),
        () => completedWorkspace,
        input.expected_state_revision,
        input.expected_capability,
        (currentWorkspace) => {
          const constitutionError = constitutionClaimAdmissionError(pinnedRoot, currentWorkspace, completionHandoff.handoff);
          if (constitutionError) throw new Error(constitutionError);
        },
      );
      if (!completed.ok) {
        if (!pinnedRoot.isStable()) return completed;
        const retryAuthority = readClaimAuthority(pinnedRoot, featureId);
        if (retryAuthority.ok && retryAuthority.value?.claim_id === current.claim_id && retryAuthority.value.status === "completed") {
          return { ok: true, value: retryAuthority.value };
        }
        return { ok: false, code: completed.code, error: completed.error, claim: current };
      }
      findCompletionHook(pinnedRoot.lexical_root, pinnedRoot)?.afterWorkspaceCasBeforeJournalAppend?.({
        feature_id: featureId,
        claim_id: computed.value.claim_id,
        transaction_id: transactionId,
      });
    } else if (digestOf(state.workspace) !== wal.completed_workspace_digest) {
      return failure("SPEC_CLAIM_RECOVERY_REQUIRED", "completed workspace does not match completion WAL");
    }

    loaded = loadClaimJournal(pinnedRoot, featureId, false);
    if (!loaded.ok) return loaded;
    const tail = loaded.value.tail;
    if (!tail || tail.claim.claim_id !== computed.value.claim_id || tail.claim.status !== "completed") {
      const beforeCompletionAppendConstitutionError = constitutionClaimAdmissionError(pinnedRoot, state.workspace, completionHandoff.handoff);
      if (beforeCompletionAppendConstitutionError) return failure("SPEC_STALE", beforeCompletionAppendConstitutionError);
      const appended = appendClaim(loaded.value, computed.value, transactionId, "completed", () => {
        const error = constitutionClaimAdmissionError(pinnedRoot, state.workspace, completionHandoff.handoff);
        if (error) throw new Error(error);
      });
      if (!appended.ok) {
        const replay = loadClaimJournal(pinnedRoot, featureId, false);
        if (!replay.ok) return replay;
        const replayTail = replay.value.tail?.claim;
        if (!replayTail || replayTail.claim_id !== computed.value.claim_id || replayTail.status !== "completed") {
          return failureWithClaim(appended.code, appended.error, current);
        }
      }
    }
    const final = readClaimAuthority(pinnedRoot, featureId);
    if (!final.ok || !final.value || final.value.claim_id !== computed.value.claim_id || final.value.status !== "completed") {
      const postimage = stateWorkspaceFromPinned(pinnedRoot, featureId);
      const boundHandoff = postimage.ok
        ? readCanonicalHandoffForClaim(pinnedRoot, featureId, postimage.workspace, { allowUnstable: true })
        : null;
      if (pinnedRoot.isStable() && postimage.ok
        && postimage.workspace.status === "completed"
        && postimage.workspace.execution_claim_ref === computed.value.claim_id
        && postimage.workspace.implementation_conformance_ref === input.conformance.conformance_id
        && postimage.workspace.execution_claim_prepare_ref === null
        && boundHandoff?.ok
        && boundHandoff.handoff.handoff_digest === computed.value.handoff_digest) {
        return { ok: true, value: computed.value };
      }
      if (!final.ok) return final;
      return failureWithClaim("SPEC_CLAIM_PERSIST_FAILED", "claim and completed workspace postimages were not paired", computed.value);
    }
    return { ok: true, value: final.value };
  } catch (error) {
    const failed = pinnedClaimFailure(error, "claim completion failed");
    return failed.ok ? { ok: false, code: "SPEC_CLAIM_PERSIST_FAILED", error: "claim completion failed" } : failed;
  } finally {
    if (lock) releaseClaimLock(pinnedRoot, lock);
    if (!providedRoot) pinnedRoot.close();
  }
}
/**
 * Recover the exact completion postimage after a crash between workspace CAS
 * and terminal journal append. A null result means no interrupted completion
 * was observed; callers may continue the ordinary authority path.
 */
export function recoverExecutionClaimCompletion(
  projectRoot: string,
  featureId: string,
  conformance: ImplementationConformanceResult,
  providedRoot?: PinnedProjectRoot,
  authorization?: CompletionRecoveryAuthorization,
): ExecutionClaimResult<ExecutionClaim> | null {
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return failure("SPEC_PATH_UNAUTHORIZED", "project root cannot be pinned for completion recovery");
  let lock: { token: string; target: string; candidate: string; expected: { dev: number; ino: number; sha256: string } } | null = null;
  try {
    const acquired = claimLock(pinnedRoot, featureId);
    if (!acquired.ok) return failure("SPEC_CLAIM_PERSIST_FAILED", acquired.error);
    lock = acquired;
    const loaded = loadClaimJournal(pinnedRoot, featureId, false);
    if (!loaded.ok) return loaded;
    const walRead = readWalRecords(loaded.value);
    if (!walRead.ok) return walRead;
    const state = stateWorkspaceFromPinned(pinnedRoot, featureId);
    if (!state.ok) return state;
    const tail = loaded.value.tail?.claim;
    if (!tail || tail.status !== "active") return null;
    const recovered = recoverCompletionWal(pinnedRoot, featureId, loaded.value, walRead.value, state, {
      claim_id: tail.claim_id,
      handoff_digest: tail.handoff_digest,
      owner_kind: tail.owner_kind,
      owner_run_id: tail.owner_run_id,
      conformance,
    }, authorization);
    return recovered;
  } catch (error) {
    return pinnedClaimFailure(error, "completion WAL recovery failed");
  } finally {
    if (lock) releaseClaimLock(pinnedRoot, lock);
    if (!providedRoot) pinnedRoot.close();
  }
}

// ── Claim-store inspection (T099) ────────────────────────────────────────────

export type ClaimStoreResultCode = "SPEC_PATH_UNAUTHORIZED" | "SPEC_STATE_INVALID";

export type ClaimStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ClaimStoreResultCode; error: string };

/** Live claims hold exclusive ownership; completed and released claims are terminal. */
export function isLiveExecutionClaim(claim: ExecutionClaim): boolean {
  return claim.status === "active" || claim.status === "blocked";
}

/**
 * Read every persisted execution-claim record for one explicit feature.
 * Strictly read-only: unknown files, malformed records, or boundary escapes
 * fail closed instead of being skipped, so callers never admit work against
 * a partially observed claim store. Records are returned in deterministic
 * file-name order; transitions in this module are unchanged.
 */
export function readExecutionClaimStore(
  projectRoot: string,
  featureId: string,
): ClaimStoreResult<ExecutionClaim[]> {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root cannot be pinned for claim inspection" };
  try {
    const loaded = loadClaimJournal(pinnedRoot, featureId, false);
    if (loaded.ok) return { ok: true, value: loaded.value.envelopes.map((envelope) => envelope.claim) };
    return {
      ok: false,
      code: loaded.code === "SPEC_PATH_UNAUTHORIZED" ? "SPEC_PATH_UNAUTHORIZED" : "SPEC_STATE_INVALID",
      error: loaded.error,
    };
  } finally {
    pinnedRoot.close();
  }
}
/** Read current claim authority for one feature; unbound tails return null. */
export function readCurrentExecutionClaim(
  projectRoot: string,
  featureId: string,
  providedRoot?: PinnedProjectRoot,
  capturedPathBinding?: WorkspacePathBinding,
  capturedHandoff?: ImplementationHandoff,
): ClaimStoreResult<ExecutionClaim | null> {
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root cannot be pinned for claim inspection" };
  try {
    const authority = readClaimAuthority(pinnedRoot, featureId, capturedPathBinding, capturedHandoff);
    if (!authority.ok) return { ok: false, code: authority.code === "SPEC_PATH_UNAUTHORIZED" ? "SPEC_PATH_UNAUTHORIZED" : "SPEC_STATE_INVALID", error: authority.error };
    return { ok: true, value: authority.value };
  } finally {
    if (!providedRoot) pinnedRoot.close();
  }
}

export interface ClaimConflictProbe {
  /** The exact handoff digest admission is attempting to execute. */
  handoff_digest: string;
  /** Caller identity; a live claim held by this exact owner is not a conflict. */
  owner_kind?: ExecutionClaimOwnerKind;
  owner_run_id?: string;
}

/**
 * Detect the first live claim that blocks admission of the given handoff
 * digest. Any live claim held by a different owner is a conflict — takeover
 * is never inferred here. Returns null when admission may proceed.
 */
export function findBlockingExecutionClaim(
  claims: readonly ExecutionClaim[],
  probe: ClaimConflictProbe,
): { claim: ExecutionClaim; error: string } | null {
  const latest = new Map<string, ExecutionClaim>();
  for (const claim of claims) latest.set(claim.claim_id, claim);
  for (const claim of latest.values()) {
    if (!isLiveExecutionClaim(claim)) continue;
    const ownClaim =
      probe.owner_kind !== undefined
      && probe.owner_run_id !== undefined
      && claim.owner_kind === probe.owner_kind
      && claim.owner_run_id === probe.owner_run_id
      && claim.handoff_digest === probe.handoff_digest
      && claim.status === "active";
    if (ownClaim) continue;
    const digestMatch = claim.handoff_digest === probe.handoff_digest;
    const digestNote = digestMatch
      ? "it already owns the exact handoff digest"
      : `it owns a different handoff digest ('${claim.handoff_digest}')`;
    return {
      claim,
      error: `an ${claim.status} execution claim '${claim.claim_id}' owned by ${ownerDescription(claim)} blocks admission because ${digestNote}; takeover requires an explicit release by its owner`,
    };
  }
  return null;
}
