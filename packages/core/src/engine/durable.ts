import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { loadProfile, profileHash } from "./profile.js";
import { resolveState, resolveStatePinned, resolveStatePinnedActive, isSafeStateSegment, resolveActiveBranch, updateStateAtomically, type FeatureStateSelector, type ResolvedState, type StateMutation, type StateSnapshot, type StateRootGuard } from "./state.js";
import { agentMappingIssueForRole, resolveConfig, resolveAgentForRole, type ResolvedConfig } from "./config.js";
import { agentMappingPublicationReceipt, latestPublishedAgentMapping, readAgentMapping, validateAgentMappingState, verifyAgentMappingPublicationReceipt, type AgentMappingDiagnostic, type AgentMappingPublicationReceipt, type AgentMappingState } from "./agent-mapping.js";
import { resolveScope, type ScopeFlags } from "./scope.js";
import { resolveStageDispatchSlots, selectRoster, type RosterSelectionContext } from "./stage.js";
import { MAX_ARTIFACT_BYTES, artifactExistsPinned, parseArtifactJson, readArtifactPinned, rollbackArtifactAtomicWrite, artifactAtomicWriteRollbackTokenFromReceipt, type ArtifactAtomicWriteRollbackToken } from "./artifacts.js";
import { isDoDComplete, isRootCauseDocumentedPinned, readDoDPinned } from "./dod.js";
import { buildDispatchMarker, dispatchTaskId } from "../gates/dispatch.js";
import { evaluatePredicate } from "./predicate.js";
import {
  appendCheckpointDecision,
  checkpointDecisionEffect,
  checkpointPolicyHash,
  recordTrustedCheckpointAnswer,
  checkpointAnswerBinding,
  findCheckpointDecision,
  selectLatestValidCheckpointDecision,
  resolveCheckpointPolicy,
  validateCheckpointDecision,
  unresolvedCheckpointError,
  trustedCheckpointAnswerError,
  retireTrustedCheckpointAnswer,
  type TrustedCheckpointAnswerCapability,
  type TrustedCheckpointRootIdentity,
} from "./checkpoints.js";
import { loopExhaustionKind, loopIterationRecord, loopReentryDecision, loopStateFor, resolveBackToStage } from "./loops.js";
import {
  durableNamespacedArtifactId,
  legacyNamespacedArtifactId,
  slotArtifactEnvelopeBytes,
  synthesizeArtifacts,
  type FanInPolicy,
  type SynthesisResult,
} from "./fan-in.js";
import { readPinnedCtoMappingRecord } from "../specification/mapping-record.js";
import { isSafeCtoExecutionId, isSafeCtoRunId, readCtoStatePinned } from "../cto/state.js";
import { withCtoRunLock } from "../cto/transaction-lock.js";
import { assertCtoRuntimeAccessFacadeLive, type CtoRuntimeAccessFacade } from "../cto/runtime-access.js";
import {
  artifactSchemaFor,
  validateConsumedArtifacts,
  validateProducedArtifact,
  DEFAULT_ARTIFACT_CONTRACT_POLICY,
  type ArtifactContractPolicy,
} from "./artifact-contract.js";
import {
  ctoMandatoryQualityGateIssues,
  ctoMandatoryQualityGateSpecs,
  doWorkMandatoryQualityGateSpecs,
  typedEvidenceEntryIssues,
  typedQualityGateIssues,
  normalizeCtoArtifactReferencePinned,
} from "../specification/conformance.js";
import type {
  CheckpointDecision,
  CheckpointPolicy,
  CheckpointRule,
  ChildJoin,
  CompletionArtifactRef,
  CompletionEnvelope,
  DispatchCompletion,
  DocumentRenderer,
  DispatchRecord,
  LoopState,
  PendingState,
  PendingReconciliation,
  Profile,
  RosterSelection,
  StageDef,
  TeamState,
  TypedCheckpointDecision,
  TrustedCheckpointAnswer,
  CheckpointAnswerProof,
  WorkIdentity,
  ConstitutionContinuationGate,
} from "./types.js";
import { completeExecutionClaim, recoverExecutionClaimCompletion, readClaimAuthority, type CompletionRecoveryAuthorization, type ExecutionClaimResultCode } from "../specification/claims.js";
import { PinnedProjectRoot, PinnedRootError, type PinnedRootWriteReceipt } from "../specification/pinned-root.js";
import { preparationStartPostimageDigest, verifyPreparationHandoffAuth, verifyPreparationHandoffDigest, type NativePreparationStartMarker } from "./preparation.js";
import { deriveRuntimeSecretKey, readOrCreateRootRuntimeSecret } from "../runtime-secret.js";
import { materializeImplementationHandoffPinned, revalidateMaterializedDocumentsPinned } from "../specification/materialize.js";
import { productPrdOutputRelativePaths } from "./product-prd.js";
import { canonicalHandoffDigest } from "../specification/handoff.js";
import { readCanonicalBoundedJson, readCanonicalHandoff, serializeCanonicalHandoff } from "../specification/canonical-reader.js";
import { deriveNativeImplementationHandoff, readCanonicalPhaseArtifact, deterministicValidationInputForArtifact, deterministicValidationMatchesArtifact, type PersistedPhaseResultEnvelope } from "../specification/phase.js";
import { readPinnedCurrentConstitution } from "../specification/constitution-identities.js";
import { validateNativePhase } from "../specification/validation.js";
import { canonicalJson, compatibilitySupplementContentHash, compatibilitySupplementId, digestOf, validateConformanceAgainstHandoff, validateExecutionClaim, validateFeatureWorkspaceRecord, validateImplementationConformance, validateImplementationHandoff, validateImportLimits, validateImportSnapshot, validateCompatibilityReport, validateCompatibilitySupplement, validateConstitutionBinding, validateConformanceBounds, isSafeFeatureId, isSafeRelativePath, isSha256Hex, isRecord, MAX_CONFORMANCE_ARTIFACT_BYTES, MAX_CONFORMANCE_ENTRIES, MAX_CONFORMANCE_QUALITY_GATES, MAX_CONFORMANCE_EVIDENCE_REFS, MAX_CONFORMANCE_TEST_EVIDENCE, MAX_CONFORMANCE_FINDINGS, MAX_CONFORMANCE_FINDING_REFS, MAX_CONFORMANCE_AGGREGATE_BYTES, MAX_CONFORMANCE_NODES, MAX_CONFORMANCE_DEPTH, MAX_CONFORMANCE_STRING_BYTES, MAX_HANDOFF_AGGREGATE_BYTES } from "../specification/validation.js";
import { requireDocumentRenderer } from "../specification/registry.js";
import { validateTypedControlPlane } from "./workflow-contract.js";
import type { ExecutionClaim, FeatureWorkspace, ImplementationConformanceResult, ImplementationHandoff, ImportSnapshot, ImportSnapshotLimits, CompatibilityReport, CompatibilitySupplement, ConstitutionBinding } from "../specification/types.js";
import type { CtoState } from "../cto/types.js";
import { bindImportRecognition, buildCompatibilityReport, createImportedHandoff, rehashImportedSpecification, recreateImportedSnapshot, DEFAULT_IMPORT_LIMITS, type SecureSnapshotBundle } from "../specification/import.js";
import { cloneAndFreeze, createRegistryRegistrationLiveGuard, descriptorFingerprint, recordRegistryUndo, registryRegistrationPrincipal, registryRegistrationProjectRoot, requireRegistryRegistration, type RegistryRegistrationPrincipal, type RegistryRegistrationToken } from "../registry/owner.js";

/** Runtime ceilings shared by mounted schemas and every durable input boundary. */
export const MAX_ADVANCE_FIELD_BYTES = 4096;
export const MAX_ADVANCE_EVIDENCE_BYTES = 8192;
export const MAX_COMPLETION_ARTIFACT_COUNT = 64;
export const MAX_COMPLETION_ARTIFACT_BYTES = 16 * 1024;
const MAX_COMPLETION_ARTIFACT_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_ROSTER_SELECTION_COUNT = 8;
export const MAX_ROSTER_SELECTION_BYTES = 16 * 1024;
export const MAX_CHECKPOINT_RATIONALE_BYTES = 8192;

/** Internal deterministic seam for finalizer canonical handoff writes. */
export interface HandoffFinalizerWriteTestHooks {
  beforeCanonicalWrite?: (context: { root: string; handoff_id: string }) => void;
}
const handoffFinalizerWriteHooks = new Map<string, HandoffFinalizerWriteTestHooks>();
export function setHandoffFinalizerWriteTestHooks(hooks: HandoffFinalizerWriteTestHooks | null, projectRoot: string): void {
  const key = projectRoot;
  if (hooks) handoffFinalizerWriteHooks.set(key, hooks);
  else handoffFinalizerWriteHooks.delete(key);
}
function injectHandoffFinalizerWriteHook(pinnedRoot: PinnedProjectRoot, handoffId: string): void {
  handoffFinalizerWriteHooks.get(pinnedRoot.canonical_root)?.beforeCanonicalWrite?.({ root: pinnedRoot.canonical_root, handoff_id: handoffId });
}

const CONTROL_OR_FORMAT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Bounded UTF-8 text that cannot inject control, bidi, or line-separator data. */
export const isBoundedLineInert = (value: string, maxBytes: number): boolean =>
  value.length > 0
  && Buffer.byteLength(value, "utf8") <= maxBytes
  && !CONTROL_OR_FORMAT_CHARACTERS.test(value);

/** External identifiers are path-safe, line-inert state segments. */
export const isSafeWorkflowIdentifier = (value: string, maxBytes = MAX_ADVANCE_FIELD_BYTES): boolean =>
  isBoundedLineInert(value, maxBytes) && isSafeStateSegment(value);
const isSafeWorkflowReference = (value: string): boolean =>
  isBoundedLineInert(value, MAX_ADVANCE_FIELD_BYTES)
  && !value.split(/[\\/]/u).some((segment) => segment === "" || segment === "." || segment === "..");

const invalidWorkflowInput = (field: string, reason: string): string =>
  `WORKFLOW_INPUT_INVALID: ${field} ${reason}`;

function boundedWorkflowField(
  input: Record<string, unknown>,
  field: string,
  maxBytes = MAX_ADVANCE_FIELD_BYTES,
  identifier = false,
): string | null {
  const value = input[field];
  if (value === undefined) return null;
  if (typeof value !== "string" || !isBoundedLineInert(value, maxBytes)) {
    return invalidWorkflowInput(field, `must be bounded line-inert text of at most ${maxBytes} bytes`);
  }
  if (identifier && !isSafeWorkflowIdentifier(value, maxBytes)) {
    return invalidWorkflowInput(field, "must be a safe identifier");
  }
  return null;
}

/**
 * Validate completion payloads before opening the durable transaction. This is
 * intentionally independent of authorization: malformed external input must
 * never acquire the lock or reach artifact/state mutation.
 */
export function workflowCompletionInputError(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalidWorkflowInput("input", "must be an object");
  const candidate = input as Record<string, unknown>;
  for (const field of ["feature_id", "dispatch_id", "capability_id"] as const) {
    const error = boundedWorkflowField(candidate, field, MAX_ADVANCE_FIELD_BYTES, true);
    if (error) return error;
  }
  for (const field of ["token"] as const) {
    const error = boundedWorkflowField(candidate, field, MAX_ADVANCE_FIELD_BYTES, true);
    if (error) return error;
  }
  for (const field of ["run_key", "branch", "workflow", "profile_hash", "stage_cursor", "cursor_epoch", "role", "slot_id", "task_id", "retry_of", "agent", "tool_call_id", "provider_ref", "provider_id"] as const) {
    const error = boundedWorkflowField(candidate, field);
    if (error) return error;
  }
  const evidenceError = boundedWorkflowField(candidate, "evidence", MAX_ADVANCE_EVIDENCE_BYTES);
  if (evidenceError) return evidenceError;
  if (candidate.terminal_signal !== undefined && !["workflow_complete", "native_tool_result"].includes(String(candidate.terminal_signal))) {
    return invalidWorkflowInput("terminal_signal", "must be a supported completion signal");
  }
  if (candidate.outcome !== undefined && !["succeeded", "failed", "cancelled"].includes(String(candidate.outcome))) {
    return invalidWorkflowInput("outcome", "must be a supported completion outcome");
  }
  if (candidate.pending_reason !== undefined && !["provider_running", "awaiting_result", "transport_reconnect"].includes(String(candidate.pending_reason))) {
    return invalidWorkflowInput("pending_reason", "must be a supported pending reason");
  }
  if (candidate.completed_by !== undefined && !["workflow_complete", "synchronous_tool_result", "engine_task_caller"].includes(String(candidate.completed_by))) {
    return invalidWorkflowInput("completed_by", "must be a supported completion source");
  }
  if (candidate.artifact_ids === undefined) return null;
  if (!Array.isArray(candidate.artifact_ids)) return invalidWorkflowInput("artifact_ids", "must be an array");
  if (candidate.artifact_ids.length > MAX_COMPLETION_ARTIFACT_COUNT) {
    return invalidWorkflowInput("artifact_ids", `must contain at most ${MAX_COMPLETION_ARTIFACT_COUNT} identifiers`);
  }
  let aggregateBytes = 0;
  for (const artifactId of candidate.artifact_ids) {
    if (typeof artifactId !== "string" || !isSafeWorkflowIdentifier(artifactId)) {
      return invalidWorkflowInput("artifact_ids", "must contain only safe identifiers");
    }
    aggregateBytes += Buffer.byteLength(artifactId, "utf8");
    if (aggregateBytes > MAX_COMPLETION_ARTIFACT_BYTES) {
      return invalidWorkflowInput("artifact_ids", `total identifier bytes must not exceed ${MAX_COMPLETION_ARTIFACT_BYTES}`);
    }
  }
  if (new Set(candidate.artifact_ids).size !== candidate.artifact_ids.length) {
    return invalidWorkflowInput("artifact_ids", "must not contain duplicates");
  }
  return null;
}

/** Validate the semantic roster payload before opening the durable lock. */
export function workflowRosterSelectionInputError(selection: unknown): string | null {
  if (selection === undefined) return null;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) return invalidWorkflowInput("selection", "must be an object");
  const candidate = selection as Record<string, unknown>;
  if (!Array.isArray(candidate.occurrences) || candidate.occurrences.length === 0) return invalidWorkflowInput("selection.occurrences", "must be a non-empty array");
  if (candidate.occurrences.length > MAX_ROSTER_SELECTION_COUNT) return invalidWorkflowInput("selection.occurrences", `must contain at most ${MAX_ROSTER_SELECTION_COUNT} entries`);
  if (candidate.rationale !== undefined && (typeof candidate.rationale !== "string" || candidate.rationale.trim() === "" || !isBoundedLineInert(candidate.rationale, MAX_ADVANCE_FIELD_BYTES))) {
    return invalidWorkflowInput("selection.rationale", `must be bounded line-inert text of at most ${MAX_ADVANCE_FIELD_BYTES} bytes`);
  }
  if (candidate.evidence !== undefined && (!Array.isArray(candidate.evidence) || candidate.evidence.length > MAX_ROSTER_SELECTION_COUNT || candidate.evidence.some((entry) => typeof entry !== "string" || entry.trim() === "" || !isBoundedLineInert(entry, MAX_ADVANCE_FIELD_BYTES)))) {
    return invalidWorkflowInput("selection.evidence", `must contain at most ${MAX_ROSTER_SELECTION_COUNT} bounded line-inert entries`);
  }
  let aggregateBytes = 0;
  const addBytes = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    aggregateBytes += Buffer.byteLength(value, "utf8");
    return aggregateBytes <= MAX_ROSTER_SELECTION_BYTES;
  };
  if (candidate.rationale !== undefined && !addBytes(candidate.rationale)) return invalidWorkflowInput("selection", `aggregate text must not exceed ${MAX_ROSTER_SELECTION_BYTES} bytes`);
  if (Array.isArray(candidate.evidence) && candidate.evidence.some((entry) => !addBytes(entry))) return invalidWorkflowInput("selection", `aggregate text must not exceed ${MAX_ROSTER_SELECTION_BYTES} bytes`);
  for (const [index, occurrence] of candidate.occurrences.entries()) {
    if (!occurrence || typeof occurrence !== "object" || Array.isArray(occurrence)) return invalidWorkflowInput(`selection.occurrences[${index}]`, "must be an object");
    const item = occurrence as Record<string, unknown>;
    if (typeof item.role !== "string" || item.role.trim() === "" || !isSafeWorkflowIdentifier(item.role)) return invalidWorkflowInput("selection.occurrences.role", "must be a safe identifier");
    if (!addBytes(item.role)) return invalidWorkflowInput("selection", `aggregate text must not exceed ${MAX_ROSTER_SELECTION_BYTES} bytes`);
    for (const key of ["facet", "focus", "reason"] as const) {
      const value = item[key];
      if (value !== undefined && value !== null && (typeof value !== "string" || value.trim() === "" || !isBoundedLineInert(value, MAX_ADVANCE_FIELD_BYTES))) {
        return invalidWorkflowInput(`selection.occurrences.${key}`, `must be bounded line-inert text of at most ${MAX_ADVANCE_FIELD_BYTES} bytes`);
      }
      if (value !== undefined && value !== null && !addBytes(value)) return invalidWorkflowInput("selection", `aggregate text must not exceed ${MAX_ROSTER_SELECTION_BYTES} bytes`);
    }
    if ("agent" in item) return "semantic roster selection must not include concrete agent ids";
  }
  return null;
}
/** Validate checkpoint input before any lock, auth lookup, or state mutation. */
export function workflowCheckpointInputError(input: unknown): string | null {
  const baseError = workflowCompletionInputError(input);
  if (baseError) return baseError;
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalidWorkflowInput("input", "must be an object");
  const candidate = input as Record<string, unknown>;
  for (const field of ["advance_token"] as const) {
    const error = boundedWorkflowField(candidate, field, MAX_ADVANCE_FIELD_BYTES, true);
    if (error) return error;
  }
  for (const field of ["checkpoint", "checkpoint_id", "checkpoint_kind", "stage_cursor", "decision"] as const) {
    const error = boundedWorkflowField(candidate, field);
    if (error) return error;
  }
  const rationale = candidate.rationale;
  if (typeof rationale !== "string" || rationale.trim().length === 0 || Buffer.byteLength(rationale, "utf8") > MAX_CHECKPOINT_RATIONALE_BYTES || CONTROL_OR_FORMAT_CHARACTERS.test(rationale)) {
    return invalidWorkflowInput("rationale", `must be bounded nonempty single-line UTF-8 text of at most ${MAX_CHECKPOINT_RATIONALE_BYTES} bytes`);
  }
  const evidence = candidate.evidence;
  if (evidence !== undefined && (typeof evidence !== "string" || evidence.trim().length === 0 || Buffer.byteLength(evidence, "utf8") > MAX_CHECKPOINT_RATIONALE_BYTES || CONTROL_OR_FORMAT_CHARACTERS.test(evidence))) {
    return invalidWorkflowInput("evidence", `must be bounded nonempty single-line UTF-8 text of at most ${MAX_CHECKPOINT_RATIONALE_BYTES} bytes`);
  }
  const feedback = candidate.feedback;
  if (feedback !== undefined && (typeof feedback !== "string" || feedback.trim().length === 0 || Buffer.byteLength(feedback, "utf8") > MAX_CHECKPOINT_RATIONALE_BYTES || CONTROL_OR_FORMAT_CHARACTERS.test(feedback))) {
    return invalidWorkflowInput("feedback", `must be bounded nonempty single-line UTF-8 text of at most ${MAX_CHECKPOINT_RATIONALE_BYTES} bytes`);
  }
  for (const field of ["subject_binding", "run_id", "actor"] as const) {
    const error = boundedWorkflowField(candidate, field);
    if (error) return error;
  }
  if (candidate.actor_provenance !== undefined) {
    if (!candidate.actor_provenance || typeof candidate.actor_provenance !== "object" || Array.isArray(candidate.actor_provenance)) return invalidWorkflowInput("actor_provenance", "must be an object");
    const actor = candidate.actor_provenance as Record<string, unknown>;
    if (!["user", "orchestrator", "system"].includes(String(actor.kind))) return invalidWorkflowInput("actor_provenance.kind", "must be a supported actor kind");
    const actorRefError = boundedWorkflowField(actor, "ref");
    if (actorRefError) return actorRefError.replace(/^WORKFLOW_INPUT_INVALID: ref/u, "WORKFLOW_INPUT_INVALID: actor_provenance.ref");
    if (typeof actor.ref === "string" && !isSafeWorkflowReference(actor.ref)) return invalidWorkflowInput("actor_provenance.ref", "must not contain unsafe path segments");
    if (actor.proof !== undefined) {
      if (!actor.proof || typeof actor.proof !== "object" || Array.isArray(actor.proof)) return invalidWorkflowInput("actor_provenance.proof", "must be an object");
      const proof = actor.proof as Record<string, unknown>;
      for (const field of ["answer_id", "nonce", "reference", "binding"] as const) {
        const proofError = boundedWorkflowField(proof, field);
        if (proofError) return proofError.replace(`: ${field} `, `: actor_provenance.proof.${field} `);
        if (typeof proof[field] === "string" && !isSafeWorkflowReference(proof[field] as string)) return invalidWorkflowInput(`actor_provenance.proof.${field}`, "must not contain unsafe path segments");
      }
      const proofFeedbackError = boundedWorkflowField(proof, "feedback", MAX_CHECKPOINT_RATIONALE_BYTES);
      if (proofFeedbackError) return proofFeedbackError.replace(": feedback ", ": actor_provenance.proof.feedback ");
      if (!["terminal", "escalation"].includes(String(proof.channel))) return invalidWorkflowInput("actor_provenance.proof.channel", "must be a supported answer channel");
    }
  }
  const allText = [candidate.checkpoint, candidate.checkpoint_id, candidate.decision, rationale, candidate.feedback, candidate.subject_binding, candidate.run_id]
    .filter((value): value is string => typeof value === "string");
  if (allText.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0) > MAX_ROSTER_SELECTION_BYTES) {
    return invalidWorkflowInput("checkpoint", `aggregate text must not exceed ${MAX_ROSTER_SELECTION_BYTES} bytes`);
  }
  return null;
}
export type DispatchAuth = {
  feature_id?: string;
  token: string;
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  role?: string;
  slot_id?: string;
  task_id?: string;
  retry_of?: string;
  evidence?: string;
  agent?: string;
  expected_count?: number;
  tool_call_id?: string;
  pending?: boolean;
  pending_reason?: PendingState["pending_reason"];
  provider_ref?: string;
  phase_version?: number;
};
/**
 * Internal engine authority for a restart-loaded capability postimage. It
 * deliberately carries no bearer secret: the durable capability hashes are
 * validated against the immutable binding and postimage instead.
 */
export type PersistedStagePostimage = Omit<DispatchAuth, "token"> & {
  config_hash: string;
  policy_hash: string;
  work_identity?: WorkIdentity;
};

/**
 * CTO completion authority is a durable envelope, not a bearer token. The
 * finalizer re-reads every referenced record under a pinned root before it
 * permits a claim/workspace terminal transition.
 */
export type CtoSpecificationCompletionEnvelope = {
  owner_kind: "cto";
  owner_run_key: string;
  wave_id: string;
  mapping_id: string;
  mapping_digest: string;
  feature_id: string;
  run_key: string;
  handoff_digest: string;
  conformance_id: string;
};

export type SpecificationExecutionCompletionInput =
  | (DispatchAuth & { feature_id: string })
  | CtoSpecificationCompletionEnvelope;

/**
 * Semantic roster selection accepted at capability begin: role, facet, focus
 * and reason occurrences drawn from the stage's allowed pool. Concrete agent
 * ids are never caller authority — every selected role must resolve through
 * the live registered agent mapping before dispatch.
 */
export type RosterBeginSelection = {
  rationale?: string;
  evidence?: string[];
  occurrences: Array<{
    role: string;
    facet?: string | null;
    focus?: string;
    reason?: string;
  }>;
};
type ActiveCapability = {
  capability_id: string; dispatch_token_hash: string; advance_token_hash: string;
  issued_for: { run_key: string; branch: string; workflow: TeamState["classification"]["workflow"]; profile_hash: string; stage_cursor: string; cursor_epoch: string };
  kind: "none" | "single" | "consilium"; expected_roles: string[]; expected_count: number;
  expected_roster: Array<{ role: string; agent: string }>;
  /** Exact stage control-plane digest for restart-safe engine resumption. */
  policy_hash?: string;
  /** Frozen adaptive selection bound by the capability epoch. */
  roster_selection?: RosterSelection;
  /** Frozen work identity, when a dispatch has already been authorized. */
  work_identity?: WorkIdentity;
  status: "ready" | "dispatched" | "joining" | "complete" | "invalidated"; dispatches: DispatchRecord[]; pending?: PendingState[];
};
/**
 * Keep the profile binding model-safe without weakening its identity.
 *
 * The full SHA-256 remains persisted in state. Workflow control calls carry a
 * compact first-30/last-2 fingerprint because long hashes are routinely
 * abbreviated by an LLM when copied through a long-running session.
 */
const profileHashFingerprint = (value: string): string =>
  value.length > 32 ? `${value.slice(0, 30)}${value.slice(-2)}` : value;

const profileHashMatches = (expected: string, provided: string): boolean =>
  provided === expected || provided === profileHashFingerprint(expected);

const activeCapability = (value: TeamState["dispatch_capability"]): ActiveCapability | null => {
  if (
    !value?.issued_for
    || typeof value.issued_for !== "object"
    || typeof value.capability_id !== "string"
    || !value.capability_id
    || typeof value.dispatch_token_hash !== "string"
    || !/^[0-9a-f]{64}$/.test(value.dispatch_token_hash)
    || typeof value.advance_token_hash !== "string"
    || !/^[0-9a-f]{64}$/.test(value.advance_token_hash)
    || !Array.isArray(value.dispatches)
    || !Array.isArray(value.expected_roles)
    || value.expected_count === undefined
    || !Number.isInteger(value.expected_count)
    || !Array.isArray(value.expected_roster)
    || !value.status
  ) return null;
  const issued = value.issued_for;
  const expectedRoles = value.expected_roles;
  const expectedRoster = value.expected_roster;
  const expectedCount = value.expected_count;
  if (
    !["none", "single", "consilium"].includes(value.kind)
    || !["ready", "dispatched", "joining", "complete", "invalidated"].includes(value.status)
    || [issued.run_key, issued.branch, issued.workflow, issued.profile_hash, issued.stage_cursor, issued.cursor_epoch].some((field) => typeof field !== "string" || !field)
  ) return null;
  if ((value.kind === "none" ? expectedCount !== 0 : expectedCount <= 0) || expectedCount !== expectedRoles.length || expectedCount !== expectedRoster.length) return null;
  if (
    expectedRoles.some((role) => typeof role !== "string" || !role)
    || expectedRoster.some((entry) => !entry || typeof entry !== "object" || typeof entry.role !== "string" || !entry.role || typeof entry.agent !== "string" || !entry.agent)
    || new Set(expectedRoles).size !== expectedRoles.length
    || new Set(expectedRoster.map((entry) => entry.role)).size !== expectedRoster.length
    || expectedRoles.some((role) => !expectedRoster.some((entry) => entry.role === role))
  ) return null;
  const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
  const identityValid = (identity: WorkIdentity, role: string, dispatchId: string, attempt: number): boolean =>
    Boolean(identity.run_id)
    && identity.slot_id === role
    && identity.capability_id === value.capability_id
    && identity.capability_epoch === issued.cursor_epoch
    && identity.dispatch_id === dispatchId
    && identity.attempt === attempt
    && Boolean(identity.task_id)
    && Boolean(identity.worker_id);
  const envelopeValid = (envelope: CompletionEnvelope | undefined, identity: WorkIdentity, outcome: CompletionEnvelope["outcome"]): boolean =>
    envelope !== undefined
    && envelope.schema_version === 1
    && sameIdentity(envelope.identity, identity)
    && envelope.outcome === outcome
    && (outcome === "pending" ? envelope.terminal_signal === null : envelope.terminal_signal !== null)
    && Array.isArray(envelope.artifact_refs)
    && typeof envelope.emitted_at === "string";
  const reconciliationValid = (reconciliation: PendingReconciliation | undefined, identity: WorkIdentity): boolean =>
    reconciliation !== undefined
    && sameIdentity(reconciliation.identity, identity)
    && /^[0-9a-f]{64}$/.test(reconciliation.result_digest)
    && ["succeeded", "failed", "cancelled"].includes(reconciliation.outcome)
    && isBoundedLineInert(reconciliation.evidence, MAX_ADVANCE_EVIDENCE_BYTES)
    && Array.isArray(reconciliation.artifact_ids)
    && reconciliation.artifact_ids.length <= MAX_COMPLETION_ARTIFACT_COUNT
    && new Set(reconciliation.artifact_ids).size === reconciliation.artifact_ids.length
    && reconciliation.artifact_ids.every((id) => isSafeWorkflowIdentifier(id))
    && ["workflow_complete", "native_tool_result", "provider_terminal", "contract_failure"].includes(reconciliation.terminal_signal)
    && (reconciliation.provider_id === undefined || isSafeWorkflowIdentifier(reconciliation.provider_id))
    && typeof reconciliation.updated_at === "string";
  if (
    new Set(value.dispatches.map((record) => record?.id)).size !== value.dispatches.length
    || value.dispatches.some((record) => {
      const immutableGeneration = record?.purpose === "generation" && record.status === "succeeded";
      if (
        !record
        || typeof record.id !== "string"
        || !record.id
        || typeof record.role !== "string"
        || !record.role
        || (!immutableGeneration && !expectedRoles.includes(record.role))
        || typeof record.agent !== "string"
        || !record.agent
        || (!immutableGeneration && !expectedRoster.some((entry) => entry.role === record.role && entry.agent === record.agent))
        || !["authorized", "running", "pending", "succeeded", "failed", "cancelled"].includes(record.status)
        || !Number.isInteger(record.attempt)
        || record.attempt < 1
        || typeof record.created_at !== "string"
        || (record.tool_call_id !== undefined && (typeof record.tool_call_id !== "string" || !record.tool_call_id))
        || (record.purpose !== undefined && record.purpose !== "generation" && record.purpose !== "validation")
        || (record.phase_version !== undefined && (!Number.isInteger(record.phase_version) || record.phase_version < 1))
        || !record.work_identity
        || (!immutableGeneration && !identityValid(record.work_identity, record.role, record.id, record.attempt))
      ) return true;
      const completion = record.completion;
      if (!terminalStatuses.has(record.status)) {
        if (completion !== undefined) return true;
        if (!envelopeValid(record.completion_envelope, record.work_identity, record.status === "pending" ? "pending" : "pending")) return true;
        if (record.pending !== undefined && (
          record.pending.identity.dispatch_id !== record.id
          || record.pending.identity.slot_id !== record.role
          || record.pending.status !== record.status
          || (record.status === "pending" && record.pending.terminal_signal !== undefined && record.pending.terminal_signal !== null)
          || (record.pending.reconciliation !== undefined && !reconciliationValid(record.pending.reconciliation, record.work_identity))
        )) return true;
        return false;
      }
      return !completion
        || typeof completion !== "object"
        || completion.dispatch_id !== record.id
        || (!immutableGeneration && completion.cursor_epoch !== issued.cursor_epoch)
        || completion.outcome !== record.status
        || typeof completion.evidence !== "string"
        || !completion.evidence.trim()
        || !Array.isArray(completion.artifact_ids)
        || new Set(completion.artifact_ids).size !== completion.artifact_ids.length
        || completion.artifact_ids.some((id) => typeof id !== "string" || !isSafeStateSegment(id))
        || !["workflow_complete", "synchronous_tool_result", "engine_task_caller"].includes(completion.completed_by)
        || typeof completion.completed_at !== "string"
        || record.completed_at !== completion.completed_at
        || !completion.work_identity
        || !sameIdentity(completion.work_identity, record.work_identity)
        || !envelopeValid(record.completion_envelope, record.work_identity, record.status);
  })) return null;
  const latestByRole = new Map<string, DispatchRecord>();
  for (const record of value.dispatches) {
    const previous = latestByRole.get(record.role);
    if (previous && previous.status !== "failed" && previous.status !== "cancelled") return null;
    latestByRole.set(record.role, record);
  }
  const normalizedDispatches = value.dispatches.map((record) => record.purpose === undefined ? { ...record, purpose: "generation" as const } : record);
  return { ...value, dispatches: normalizedDispatches } as ActiveCapability;
};

/** Issued capability secrets plus the persisted capability state (see createCapability). */
export type IssuedCapability = {
  capability_id: string;
  dispatch_token: string;
  advance_token: string;
  state: NonNullable<TeamState["dispatch_capability"]>;
};

export type TransitionResult = { ok: true; state: TeamState; record?: DispatchRecord; handoff?: CapabilityHandoff; implementation_handoff?: NativeImplementationHandoffFinalizationResult; child_join?: ChildJoin; transition?: "advance" | "stopped" | "revision_required" } | { ok: false; error: string; state?: TeamState; child_join?: ChildJoin };
/** Apply a trusted mounted checkpoint decision to the canonical native phase record. */
export function projectNativeSpecificationPhaseDecision(
  workspace: FeatureWorkspace,
  phase: "specify" | "plan" | "tasks",
  decision: "approve_continue" | "request_changes" | "approve_stop",
  rationale: string,
): FeatureWorkspace {
  if (workspace.source_kind !== "native") return workspace;
  const record = workspace.phases.find((candidate) => candidate.phase === phase);
  if (!record || record.current_version === null) return workspace;
  const revisionRequired = decision === "request_changes";
  const command = phase === "specify"
    ? `/specify --feature ${workspace.feature_id}`
    : phase === "plan"
      ? `/spec-plan --feature ${workspace.feature_id}`
      : `/spec-tasks --feature ${workspace.feature_id}`;
  return {
    ...workspace,
    status: "in_progress",
    handoff_ref: revisionRequired || decision === "approve_stop" ? null : workspace.handoff_ref,
    phases: workspace.phases.map((candidate) => candidate.phase === phase
      ? {
        ...candidate,
        status: revisionRequired ? "revision_required" as const : "approved" as const,
        approved_version: revisionRequired ? null : record.current_version,
        checkpoint_ref: revisionRequired ? null : `checkpoint.${phase}.v${record.current_version}`,
        last_feedback: revisionRequired ? rationale : candidate.last_feedback,
      }
      : candidate),
    next_action: revisionRequired
      ? { kind: "command" as const, command, reason: `The ${phase} revision is required; re-enter with the recorded feedback.` }
      : {
        kind: "none" as const,
        command: null,
        reason: decision === "approve_stop"
          ? `Workflow stopped after the ${phase} checkpoint; no next stage or implementation worker was dispatched.`
          : "The phase approval is durable.",
      },
  };
}

export interface CapabilityHandoff {
  capability_id: string;
  dispatch_token: string;
  advance_token: string;
  run_key: string;
  branch: string;
  workflow: TeamState["classification"]["workflow"];
  /** Compact first-30/last-2 binding fingerprint; the full hash stays state-only. */
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  kind: "none" | "single" | "consilium";
  expected_roster: Array<{ role: string; agent: string }>;
  dispatch_markers: Array<{ role: string; agent: string; marker: string }>;
}

function handoffFromState(
  state: TeamState,
  secrets: { capability_id: string; dispatch_token: string; advance_token: string },
  stage: StageDef,
): CapabilityHandoff | undefined {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return undefined;
  const roles = cap.expected_roster.map(({ role }) => role);
  const dispatch_markers = cap.kind === "none"
    ? []
    : cap.expected_roster.map(({ role, agent }) => ({
      role,
      agent,
      marker: buildDispatchMarker(
        cap.issued_for.run_key,
        stage,
        roles,
        role,
        cap.issued_for.cursor_epoch,
        cap.capability_id,
        role,
        expectedTaskId(cap, role),
      ),
    }));
  return {
    capability_id: secrets.capability_id,
    dispatch_token: secrets.dispatch_token,
    advance_token: secrets.advance_token,
    run_key: cap.issued_for.run_key,
    branch: cap.issued_for.branch,
    workflow: cap.issued_for.workflow,
    profile_hash: profileHashFingerprint(cap.issued_for.profile_hash),
    stage_cursor: cap.issued_for.stage_cursor,
    cursor_epoch: cap.issued_for.cursor_epoch,
    kind: cap.kind,
    expected_roster: cap.expected_roster,
    dispatch_markers,
  };
}


const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
function createDurableAttemptRollback(
  pinnedRoot: PinnedProjectRoot,
  paths: readonly string[],
  registerRollback?: (cleanup: () => void) => void,
): { record: (relativePath: string, receipt: PinnedRootWriteReceipt) => void } | null {
  if (!registerRollback) return null;
  const allowed = new Set(paths);
  const receipts = new Map<string, PinnedRootWriteReceipt>();
  const rollback = (): void => {
    for (const receipt of [...receipts.values()].reverse()) receipt.rollback();
  };
  const record = (relativePath: string, receipt: PinnedRootWriteReceipt): void => {
    if (!allowed.has(relativePath)) return;
    receipts.set(relativePath, receipt);
  };
  registerRollback(rollback);
  return { record };
}

const now = (): string => new Date().toISOString();
function currentForInput(cwd: string, input: { feature_id?: string; run_key?: string }): { found: { state: TeamState; target: ResolvedState } | null; error?: string } {
  const hasFeature = input.feature_id !== undefined;
  let selector: FeatureStateSelector | undefined;
  if (hasFeature) {
    if (typeof input.run_key !== "string" || input.run_key.trim().length === 0) {
      return { found: null, error: "explicit feature_id requires a nonblank run_key selector" };
    }
    selector = { feature_id: input.feature_id!, run_key: input.run_key };
  }
  const target = resolveState(cwd, resolveActiveBranch(cwd), selector);
  if (target.invalid) return { found: null, error: "workflow state is invalid or unsafe" };
  return { found: target.state ? { state: target.state, target } : null };
}

export type DurableTransactionOptions = { rootGuard?: StateRootGuard; pinnedRoot?: PinnedProjectRoot; expectedStateRawHash?: string; preCommit?: () => void; postCommit?: () => void; onAbort?: () => void; requireNativePreparationMarker?: boolean };
type DurableMutationResult = { ok: boolean; state?: TeamState; error?: string };
/**
 * The only durable mutation boundary.  State selection, authentication and
 * precondition checks run against the lock-protected authoritative snapshot;
 * the resulting state is committed by `updateStateAtomically` before unlock.
 */
function runDurableTransaction<T extends DurableMutationResult>(
  cwd: string,
  input: { feature_id?: string; run_key?: string },
  mutate: (state: TeamState, target: ResolvedState, pinnedRoot: PinnedProjectRoot) => T,
  options: DurableTransactionOptions = {},
): T {
  if (input.feature_id !== undefined && (typeof input.run_key !== "string" || input.run_key.trim().length === 0)) {
    return { ok: false, error: "explicit feature_id requires a nonblank run_key selector" } as T;
  }
  const selector: FeatureStateSelector | undefined = input.feature_id !== undefined
    ? { feature_id: input.feature_id, run_key: input.run_key! }
    : undefined;
  let pinnedRoot = options.pinnedRoot;
  let ownsPinnedRoot = false;
  if (!pinnedRoot) {
    pinnedRoot = PinnedProjectRoot.open(cwd) ?? undefined;
    ownsPinnedRoot = true;
  }
  if (!pinnedRoot) return { ok: false, error: "current project root could not be pinned for state transaction" } as T;
  try {
    // Durable mutations must never initialize a replacement project root before
    // proving that an authoritative state exists. A caller may have retained a
    // path while its project root was replaced; resolve through this pin first,
    // and fail closed without creating .work-state in the replacement.
    const activeBranch = resolveActiveBranch(cwd);
    const preflight = selector
      ? resolveStatePinned(cwd, pinnedRoot, selector)
      : resolveStatePinnedActive(cwd, pinnedRoot, activeBranch);
    if (preflight.invalid) return { ok: false, error: "workflow state is invalid or unsafe" } as T;
    if (!preflight.state) return { ok: false, error: "state not found" } as T;
    const { postCommit, ...stateOptions } = options;
    const outcome = updateStateAtomically<T>(cwd, (snapshot: StateSnapshot): StateMutation<T> => {
      if (options.expectedStateRawHash !== undefined && snapshot.raw_hash !== options.expectedStateRawHash) {
        return { op: "fail", code: "state_conflict", error: "workflow state changed after the pinned durable snapshot" };
      }
      if (!snapshot.state) return { op: "fail", code: "state_missing", error: "state not found" };
      if (snapshot.target.isStale) return { op: "discard", value: { ok: false, error: "workflow state is stale for the active branch", state: snapshot.state } as T };
      const result = mutate(snapshot.state, snapshot.target, pinnedRoot!);
      if (result.ok) return { op: "commit", state: result.state ?? snapshot.state, value: result };
      // Some fail-closed transitions (pending joins and child conflicts) persist
      // a diagnostic state while returning `ok: false`; preserve that update.
      if (result.state && result.state !== snapshot.state) return { op: "commit", state: result.state, value: result };
      return { op: "discard", value: result };
    }, { ...stateOptions, selector, pinnedRoot });
    if (!outcome.ok) {
      try { options.onAbort?.(); } catch { /* rollback is best effort and must preserve the primary CAS error */ }
      return { ok: false, error: outcome.error } as T;
    }
    if (!outcome.committed) {
      try { options.onAbort?.(); } catch { /* rollback is best effort and must preserve the primary discard result */ }
    }
    const logicalAbort = outcome.committed && outcome.value && !outcome.value.ok;
    if (logicalAbort) {
      try { options.onAbort?.(); } catch { /* rollback is best effort and must preserve the primary mutation error */ }
    }
    if (outcome.committed) {
      try { postCommit?.(); } catch { /* post-commit cleanup is best effort */ }
    }
    if (!outcome.value) return { ok: false, error: "state transaction completed without a result" } as T;
    if (outcome.committed && outcome.state && outcome.value.state !== undefined) {
      return { ...outcome.value, state: outcome.state };
    }
    return outcome.value;
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}
function stableIdentitySeed(state: TeamState, cap: Pick<ActiveCapability, "issued_for" | "capability_id">): string {
  return `${cap.capability_id}|${cap.issued_for.run_key}|${cap.issued_for.branch}|${cap.issued_for.workflow}|${cap.issued_for.stage_cursor}`;
}

function workIdentityFor(
  state: TeamState,
  cap: Pick<ActiveCapability, "issued_for" | "capability_id">,
  role: string,
  agent: string,
  dispatchId: string,
  attempt: number,
  taskId?: string,
): WorkIdentity {
  const base = state.work_identity;
  const seed = stableIdentitySeed(state, cap);
  return {
    run_id: base?.run_id ?? cap.issued_for.run_key,
    wave_id: base?.wave_id ?? `wave-${hash(seed).slice(0, 20)}`,
    slice_id: base?.slice_id ?? cap.issued_for.stage_cursor,
    session_id: base?.session_id ?? `session-${hash(`${seed}|session`).slice(0, 20)}`,
    workflow: cap.issued_for.workflow,
    stage_id: cap.issued_for.stage_cursor,
    stage_cursor: cap.issued_for.stage_cursor,
    capability_id: cap.capability_id,
    capability_epoch: cap.issued_for.cursor_epoch,
    slot_id: role,
    task_id: taskId ?? dispatchTaskId(cap.capability_id, cap.issued_for.run_key, cap.issued_for.branch, cap.issued_for.workflow, cap.issued_for.stage_cursor, role),
    dispatch_id: dispatchId,
    attempt,
    worker_id: agent,
  };
}

function pendingFor(
  identity: WorkIdentity,
  status: PendingState["status"],
  reason?: PendingState["pending_reason"],
  providerRef?: string,
  retryOf?: string | null,
): PendingState {
  return {
    identity,
    status,
    ...(reason ? { pending_reason: reason } : {}),
    ...(providerRef ? { provider_ref: providerRef } : {}),
    ...(status === "pending" ? { lease: { token: randomUUID(), observed_at: now(), revoked_at: null } } : {}),
    terminal_signal: status === "pending" ? null : undefined,
    retry_of: retryOf ?? null,
    updated_at: now(),
  };
}

function completionArtifactRefs(
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
  artifactIds: string[],
  sourceIds?: Readonly<Record<string, string>>,
): CompletionArtifactRef[] {
  return artifactIds.map((artifactId) => {
    const storageId = sourceIds?.[artifactId] ?? artifactId;
    const value = readArtifactPinned(pinnedRoot, artifactsDirRelative, storageId);
    let size_bytes = 0;
    let sha256 = digestOf(value);
    try {
      const relativePath = artifactsDirRelative.length > 0 ? `${artifactsDirRelative}/${storageId}.json` : `${storageId}.json`;
      const observed = pinnedRoot.readFile(relativePath, { maxBytes: MAX_COMPLETION_ARTIFACT_PAYLOAD_BYTES });
      size_bytes = observed.bytes.byteLength;
      sha256 = createHash("sha256").update(observed.bytes).digest("hex");
    } catch {
      // Missing or unsafe files remain represented as failed refs; completion admission validates them before persistence.
    }
    return {
      artifact_id: artifactId,
      path: `${artifactId}.json`,
      sha256,
      size_bytes,
      schema_status: value === null ? "failed" : "met",
      quality_gate_status: value === null ? "failed" : "met",
    };
  });
}

function artifactsRelativeFor(pinnedRoot: PinnedProjectRoot, target: ResolvedState): string | null {
  return target.artifactsDir ? pinnedRoot.relativePath(target.artifactsDir) : null;
}

function completionArtifactRefsError(
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
  envelope: CompletionEnvelope,
  sourceIds?: Readonly<Record<string, string>>,
): string | null {
  for (const reference of envelope.artifact_refs) {
    if (
      typeof reference.artifact_id !== "string"
      || !isSafeWorkflowIdentifier(reference.artifact_id)
      || reference.path !== `${reference.artifact_id}.json`
      || !/^[0-9a-f]{64}$/.test(reference.sha256)
      || !Number.isSafeInteger(reference.size_bytes)
      || (reference.size_bytes ?? -1) < 0
    ) {
      return "completion artifact reference is malformed";
    }
    const namespacedStorageId = envelope.identity?.slot_id
      ? durableNamespacedArtifactId(reference.artifact_id, envelope.identity.slot_id)
      : undefined;
    const candidateStorageIds = sourceIds?.[reference.artifact_id]
      ? [sourceIds[reference.artifact_id]]
      : [namespacedStorageId, reference.artifact_id].filter((id, index, all): id is string => typeof id === "string" && all.indexOf(id) === index);
    let sawReadableArtifact = false;
    let matchedArtifact = false;
    for (const storageId of candidateStorageIds) {
      const relativePath = artifactsDirRelative.length > 0
        ? `${artifactsDirRelative}/${storageId}.json`
        : `${storageId}.json`;
      try {
        const observed = pinnedRoot.readFile(relativePath, { maxBytes: MAX_COMPLETION_ARTIFACT_PAYLOAD_BYTES });
        sawReadableArtifact = true;
        const observedDigest = createHash("sha256").update(observed.bytes).digest("hex");
        if (observedDigest === reference.sha256 && observed.bytes.byteLength === reference.size_bytes) {
          matchedArtifact = true;
          break;
        }
      } catch {
        // Try the logical or alternate namespaced source before reporting an error.
      }
    }
    if (matchedArtifact) continue;
    if (sawReadableArtifact) return `completion artifact '${reference.artifact_id}' changed since completion`;
    return `completion artifact '${reference.artifact_id}' is missing or unsafe`;
  }
  return null;
}

function completionEnvelopeFor(
  identity: WorkIdentity,
  outcome: CompletionEnvelope["outcome"],
  terminalSignal: CompletionEnvelope["terminal_signal"],
  artifactRefs: CompletionArtifactRef[],
  evidence: string,
  completedBy: CompletionEnvelope["completed_by"],
): CompletionEnvelope {
  return {
    schema_version: 1,
    identity,
    outcome,
    terminal_signal: terminalSignal,
    artifact_refs: artifactRefs,
    evidence_ref: evidence.trim() ? `evidence/${identity.dispatch_id}` : null,
    conflict_ref: null,
    completed_by: completedBy,
    emitted_at: now(),
  };
}

export function hashDispatchSecret(secret: string): string { return hash(secret); }

function rosterPolicyHash(stage: StageDef | undefined): string | undefined {
  return stage?.roster_policy === undefined ? undefined : digestOf(stage.roster_policy);
}

export function createCapability(input: {
  run_key: string; branch: string; workflow: TeamState["classification"]["workflow"]; profile_hash: string;
  stage_cursor: string; cursor_epoch?: string; kind: "none" | "single" | "consilium"; expected_roles?: string[];
  dispatch_secret?: string; advance_secret?: string;
  capability_id?: string;
  expected_roster?: Array<{ role: string; agent: string; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }>;
  dispatches?: DispatchRecord[];
  roster_selection?: TeamState["roster_selection"];
  policy_hash?: string;
  work_identity?: WorkIdentity;
}): IssuedCapability {
  if (!input.run_key || !input.branch || !input.workflow || !input.profile_hash || !input.stage_cursor) throw new Error("invalid capability binding");
  const cursor_epoch = input.cursor_epoch ?? randomUUID();
  const dispatch_token = input.dispatch_secret ?? randomUUID();
  const advance_token = input.advance_secret ?? randomUUID();
  const roster = (input.expected_roster ?? (input.expected_roles ?? []).map((role) => ({ role, agent: role }))).map((entry) => ({ ...entry, role: entry.role, agent: entry.agent }));
  const expected_roles = roster.map((entry) => entry.role);
  if ((input.kind === "none" && roster.length !== 0) || (input.kind === "single" && roster.length !== 1) || (input.kind === "consilium" && roster.length === 0)) throw new Error("capability roster does not match dispatch kind");
  if (new Set(expected_roles).size !== expected_roles.length || roster.some((entry) => !entry.role || !entry.agent)) throw new Error("invalid capability roster");
  const state = {
    capability_id: input.capability_id ?? randomUUID(),
    dispatch_token_hash: hash(dispatch_token),
    advance_token_hash: hash(advance_token),
    issued_for: { run_key: input.run_key, branch: input.branch, workflow: input.workflow, profile_hash: input.profile_hash, stage_cursor: input.stage_cursor, cursor_epoch },
    kind: input.kind,
    expected_roles,
    expected_count: roster.length,
    expected_roster: roster,
    ...(input.roster_selection ? { roster_selection: input.roster_selection } : {}),
    ...(input.policy_hash ? { policy_hash: input.policy_hash } : {}),
    ...(input.work_identity ? { work_identity: input.work_identity } : {}),
    status: "ready" as const,
    dispatches: input.dispatches?.map((record) => ({ ...record })) ?? [],
  };
  return { capability_id: state.capability_id, dispatch_token, advance_token, state };
}
function reissueActiveCapability(cap: ActiveCapability, policyHash?: string): IssuedCapability {
  const dispatch_token = randomUUID();
  const advance_token = randomUUID();
  return {
    capability_id: cap.capability_id,
    dispatch_token,
    advance_token,
    state: {
      ...cap,
      ...(policyHash === undefined ? {} : { policy_hash: policyHash }),
      dispatch_token_hash: hash(dispatch_token),
      advance_token_hash: hash(advance_token),
    },
  };
}

function nativePreparationSourceError(
  state: TeamState,
  cap: ActiveCapability | null,
  source: NativePreparationSource,
  phase: string,
  profileHashValue: string,
  expectedRoster: NativePreparationSource["expected_roster"],
): string | null {
  if (!isSafeFeatureId(source.feature_id) || source.feature_id !== state.specification?.feature_id) return "native preparation source feature binding mismatch";
  if (source.run_key !== state.run_key || source.phase !== phase || source.profile_hash !== profileHashValue) return "native preparation source workflow binding mismatch";
  if (!selectedBoundedString(source.request_id, MAX_ADVANCE_FIELD_BYTES) || !isSha256Hex(source.preparation_handoff_digest) || !isSha256Hex(source.profile_hash) || (source.policy_hash !== undefined && !isSha256Hex(source.policy_hash)) || !Number.isSafeInteger(source.preparation_state_revision) || source.preparation_state_revision < 1) return "native preparation source is malformed";
  if (!state.preparation_handoff || state.preparation_handoff.digest !== source.preparation_handoff_digest || state.preparation_handoff.state_revision !== source.preparation_state_revision) return "native preparation source is not bound to the persisted preparation handoff";
  if (source.expected_roster !== undefined && canonicalJson(source.expected_roster) !== canonicalJson(expectedRoster)) return "native preparation source roster does not match the issued capability";
  if (source.policy_hash !== undefined && cap && source.policy_hash !== cap.policy_hash) return "native preparation source policy binding mismatch";
  const marker = state.preparation_start;
  if (!marker) return null;
  if (marker.status !== "begun" && marker.status !== "started") return "native preparation begin marker is no longer retryable";
  if (!cap || cap.capability_id !== marker.capability_id) return "native preparation begin capability is unavailable";
  if (marker.capability_epoch !== undefined && marker.capability_epoch !== cap.issued_for.cursor_epoch) return "native preparation begin marker capability epoch mismatch";
  const expectedRosterEntry = expectedRoster?.[0];
  const dispatchedRecord = cap.dispatches[0];
  const pendingRecords = cap.pending ?? [];
  const pendingMatchesDispatch = pendingRecords.length === 0
    || (pendingRecords.length === 1
      && dispatchedRecord !== undefined
      && pendingRecords[0]?.identity.dispatch_id === dispatchedRecord.id
      && pendingRecords[0]?.identity.capability_id === cap.capability_id
      && pendingRecords[0]?.identity.capability_epoch === cap.issued_for.cursor_epoch);
  const exactDispatched = cap.status === "dispatched"
    && cap.dispatches.length === 1
    && pendingMatchesDispatch
    && dispatchedRecord?.purpose !== "validation"
    && dispatchedRecord?.tool_call_id === source.request_id
    && dispatchedRecord?.role === expectedRosterEntry?.role
    && dispatchedRecord?.agent === expectedRosterEntry?.agent
    && dispatchedRecord?.work_identity?.capability_id === cap.capability_id
    && dispatchedRecord?.work_identity?.capability_epoch === cap.issued_for.cursor_epoch
    && (marker.dispatch_id === undefined || marker.dispatch_id === dispatchedRecord.id);
  const readyEmpty = marker.status === "begun" && cap.status === "ready" && cap.dispatches.length === 0 && (cap.pending?.length ?? 0) === 0;
  if (!readyEmpty && !exactDispatched) return "native preparation begin marker no longer matches a ready empty or exact dispatched capability";
  if (marker.phase !== phase || marker.capability_id !== cap.capability_id || marker.request_id !== source.request_id || marker.preparation_digest !== source.preparation_handoff_digest || marker.preparation_state_revision !== source.preparation_state_revision || marker.profile_hash !== profileHashValue || canonicalJson(marker.expected_roster) !== canonicalJson(expectedRoster) || marker.policy_hash !== cap.policy_hash) return "native preparation begin marker binding mismatch";
  const expectedStateRevision = marker.expected_state_revision;
  if (!Number.isSafeInteger(expectedStateRevision) || (expectedStateRevision as number) < 1 || (expectedStateRevision as number) > (state.state_revision ?? 0)) return "native preparation begin marker revision is invalid";
  const postimageMatches = preparationStartPostimageDigest(state) === marker.start_postimage_digest;
  const dispatchedBaselineMatches = exactDispatched && preparationStartPostimageDigest({
    ...state,
    dispatch_capability: { ...cap, status: "ready", dispatches: [] },
  }) === marker.start_postimage_digest;
  if (!postimageMatches && !dispatchedBaselineMatches) return "native preparation begin marker postimage no longer matches the capability";
  return null;
}

type ClearedArtifactRemovalReceipt = {
  readonly relative_path: string;
  readonly expected: { dev: number; ino: number; size: number; sha256: string };
};

/**
 * Capture an exact removal receipt for a slot snapshot. The recorded digest
 * and size must still describe the pathname before the state CAS; otherwise
 * cleanup is deliberately nondestructive because the pathname may already
 * belong to a newer publication.
 */
function clearedArtifactRemovalReceipt(
  pinnedRoot: PinnedProjectRoot,
  target: ResolvedState,
  candidate: string,
  recorded: { sha256: string; size_bytes: number },
): ClearedArtifactRemovalReceipt | null {
  const artifactsDir = target.artifactsDir;
  if (!artifactsDir || !/^[a-f0-9]{64}$/u.test(recorded.sha256) || !Number.isSafeInteger(recorded.size_bytes) || recorded.size_bytes < 0) return null;
  try {
    const artifactsRelative = pinnedRoot.relativePath(artifactsDir);
    const candidateRelative = pinnedRoot.relativePath(candidate);
    if (artifactsRelative === null || candidateRelative === null) return null;
    const prefix = artifactsRelative.length > 0 ? `${artifactsRelative}/` : "";
    if (!candidateRelative.startsWith(prefix) || candidateRelative === artifactsRelative) return null;
    const observed = pinnedRoot.readFile(candidateRelative, { maxBytes: MAX_ARTIFACT_BYTES });
    const sha256 = createHash("sha256").update(observed.bytes).digest("hex");
    if (observed.size !== recorded.size_bytes || sha256 !== recorded.sha256) return null;
    return {
      relative_path: candidateRelative,
      expected: { dev: observed.dev, ino: observed.ino, size: observed.size, sha256 },
    };
  } catch {
    return null;
  }
}

/** Remove one stale slot snapshot only when its exact publication receipt still matches. */
function removeClearedArtifactFile(pinnedRoot: PinnedProjectRoot, receipt: ClearedArtifactRemovalReceipt): void {
  try {
    pinnedRoot.removeFileIfMatches(receipt.relative_path, receipt.expected);
  } catch {
    // Stale cleanup is intentionally best-effort and nondestructive on mismatch.
  }
}

type DeferredCleanup = (cleanup: () => void) => void;

function resetReopenedStageState(
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  profile: NonNullable<ReturnType<typeof loadProfile>>,
  stageId: string,
  existing: ActiveCapability | null,
  deferCleanup?: DeferredCleanup,
): TeamState {
  const index = state.stages.findIndex((entry) => entry.id === stageId);
  if (index < 0) return state;
  const clearedStageIds = new Set(state.stages.slice(index).map((entry) => entry.id));
  const profileIndex = profile.stages.findIndex((entry) => entry.id === stageId);
  if (profileIndex >= 0) {
    for (const stage of profile.stages.slice(profileIndex)) clearedStageIds.add(stage.id);
  }
  const staleReceipts = new Map<string, ClearedArtifactRemovalReceipt>();
  const clearedArtifactIds = new Set<string>();
  for (const clearedStageId of clearedStageIds) {
    const records = state.slot_artifacts?.[clearedStageId];
    for (const slotRecords of Object.values(records?.slots ?? {})) {
      for (const [artifactId, record] of Object.entries(slotRecords ?? {})) {
        clearedArtifactIds.add(artifactId);
        if (!record || typeof record.path !== "string") continue;
        const receipt = clearedArtifactRemovalReceipt(pinnedRoot, target, record.path, record);
        if (receipt) staleReceipts.set(receipt.relative_path, receipt);
      }
    }
  }
  if (existing && clearedStageIds.has(existing.issued_for.stage_cursor)) {
    for (const record of existing.dispatches) {
      for (const id of record.completion?.artifact_ids ?? []) clearedArtifactIds.add(id);
    }
  }
  // Logical artifact ids and completion lists do not carry publication
  // identity receipts. Never unlink their deterministic names by pathname:
  // a concurrent/new slot may already own that name.
  const cleanup = (): void => {
    for (const receipt of staleReceipts.values()) removeClearedArtifactFile(pinnedRoot, receipt);
  };
  // Deleting slot snapshots is part of reopening, but it must happen only
  // after the state CAS commits. Otherwise a pre-commit drift or concurrent
  // state writer would leave the old authoritative state pointing at missing
  // artifacts.
  if (deferCleanup) deferCleanup(cleanup);
  else cleanup();

  const retainedSlotArtifacts = Object.fromEntries(
    Object.entries(state.slot_artifacts ?? {}).filter(([id]) => !clearedStageIds.has(id)),
  );
  // Upstream mappings are intentionally retained; only artifacts named by cleared records are stale.
  const retainedArtifacts = Object.fromEntries(
    Object.entries(state.artifacts ?? {}).filter(([id]) => !clearedArtifactIds.has(id)),
  );
  return {
    ...state,
    artifacts: retainedArtifacts,
    slot_artifacts: Object.keys(retainedSlotArtifacts).length > 0 ? retainedSlotArtifacts : undefined,
  };
}

function stoppedNativePreparationRequiredState(
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  profile: NonNullable<ReturnType<typeof loadProfile>>,
  sourcePhase: "specify" | "plan" | "tasks",
  targetPhase: "specify" | "plan" | "tasks",
  existing: ActiveCapability | null = null,
  deferCleanup?: DeferredCleanup,
): TeamState {
  const reset = resetReopenedStageState(state, target, pinnedRoot, profile, targetPhase, existing, deferCleanup);
  const { pending: _pending, preparation_start: _preparationStart, preparation_handoff: _preparationHandoff, dispatch_capability: _dispatchCapability, roster_selection: _rosterSelection, roster_selections: _rosterSelections, ...withoutAuthority } = reset;
  const targetIndex = profile.stages.findIndex((candidate) => candidate.id === targetPhase);
  const retainedSelections = Object.fromEntries(
    Object.entries(state.roster_selections ?? {}).filter(([stageId]) => profile.stages.findIndex((candidate) => candidate.id === stageId) < targetIndex),
  );
  const workspace = state.specification;
  return {
    ...withoutAuthority,
    stage_cursor: targetPhase,
    cursor_epoch: randomUUID(),
    stages: state.stages.map((entry) => {
      const entryIndex = profile.stages.findIndex((candidate) => candidate.id === entry.id);
      if (entry.id === sourcePhase) return { ...entry, status: "done" as const };
      if (entryIndex >= targetIndex) return { ...entry, status: "pending" as const };
      return entry;
    }),
    ...(Object.keys(retainedSelections).length > 0 ? { roster_selections: retainedSelections } : {}),
    ...(workspace ? {
      specification: {
        ...workspace,
        status: "in_progress" as const,
        handoff_ref: null,
        phases: workspace.phases.map((phaseRecord) => {
          const phaseIndex = profile.stages.findIndex((candidate) => candidate.id === phaseRecord.phase);
          if (phaseIndex < targetIndex) return phaseRecord;
          return {
            ...phaseRecord,
            status: "not_started" as const,
            current_version: null,
            approved_version: null,
            validation_ref: null,
            checkpoint_ref: null,
            upstream_versions: [],
            stale_reason: null,
            last_feedback: null,
          };
        }),
        next_action: {
          kind: "command" as const,
          command: targetPhase === "plan" ? `/spec-plan --feature ${workspace.feature_id}` : targetPhase === "tasks" ? `/spec-tasks --feature ${workspace.feature_id}` : `/specify --feature ${workspace.feature_id}`,
          reason: `The ${sourcePhase} phase was stopped; prepare the ${targetPhase} phase before starting its worker.`,
        },
      },
    } : {}),
    pause: { kind: "none", reason: "" },
    history: [
      ...(state.history ?? []),
      {
        task: state.task,
        feedback: `Explicitly resumed native specification after approve_stop at ${sourcePhase}; ${targetPhase} requires fresh preparation authority.`,
        at: now(),
      },
    ],
    updated_at: now(),
  };
}

export interface NativeSpecificationResumeInput {
  feature_id: string;
  run_key: string;
  phase: "specify" | "plan" | "tasks";
}

export type NativeSpecificationResumeResult =
  | {
    ok: true;
    resumed: boolean;
    preparation_required?: boolean;
    next_phase: "specify" | "plan" | "tasks" | null;
    state: TeamState;
    handoff?: CapabilityHandoff;
  }
  | { ok: false; error: string; state?: TeamState };

/**
 * Resume an explicitly stopped native phase at the next phase boundary.
 *
 * This is intentionally separate from `advanceCursor`: the old capability
 * remains terminal and passive advance stays rejected. A trusted explicit
 * phase command is the only authority that can re-open the next phase after
 * an approve_stop decision.
 */
export function resumeStoppedNativeSpecificationPhase(
  cwd: string,
  input: NativeSpecificationResumeInput,
  options: DurableTransactionOptions = {},
): NativeSpecificationResumeResult {
  if (!isSafeFeatureId(input.feature_id) || !input.run_key.trim()) {
    return { ok: false, error: "native specification resume selectors are invalid" };
  }
  let guardedRoot: PinnedProjectRoot | undefined;
  let guardedWorkspace: FeatureWorkspace | undefined;
  const deferredCleanups: Array<() => void> = [];
  const deferredRollbacks: Array<() => void> = [];
  const transactionOptions: DurableTransactionOptions = {
    ...options,
    onAbort: () => { options.onAbort?.(); for (const rollback of deferredRollbacks.slice().reverse()) rollback(); },
    preCommit: () => {
      options.preCommit?.();
      if (guardedRoot && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
        const constitutionError = workspaceConstitutionError(guardedRoot, guardedWorkspace);
        if (constitutionError) throw new Error(constitutionError);
      }
    },
    postCommit: () => { for (const cleanup of deferredCleanups) cleanup(); },
  };
  const result = runDurableTransaction<NativeSpecificationResumeResult>(
    cwd,
    { feature_id: input.feature_id, run_key: input.run_key },
    (state, target, pinnedRoot) => {
      guardedRoot = pinnedRoot;
      guardedWorkspace = state.specification;
      const workspace = state.specification;
      if (!workspace || workspace.source_kind !== "native") {
        return { ok: false, error: "native specification resume requires a native workspace", state };
      }
      if (
        state.run_key !== input.run_key
        || workspace.feature_id !== input.feature_id
        || workspace.project_root !== pinnedRoot.canonical_root
        || workspace.project_root_identity.canonical_path !== pinnedRoot.canonical_root
        || workspace.project_root_identity.dev !== pinnedRoot.dev
        || workspace.project_root_identity.ino !== pinnedRoot.ino
        || !pinnedRoot.isStable()
      ) {
        return { ok: false, error: "native specification resume source identity changed", state };
      }
      const profile = loadProfile(state.classification?.workflow ?? "spec-preparation");
      if (!profile || profile.name !== "spec-preparation") {
        return { ok: false, error: "native specification resume profile is unavailable", state };
      }
      if (state.profile_hash && !profileHashMatches(profileHash(profile), state.profile_hash)) {
        return { ok: false, error: "native specification resume profile binding drifted", state };
      }
      const phaseOrder = ["specify", "plan", "tasks"] as const;
      const sourcePhase = state.stage_cursor as (typeof phaseOrder)[number] | undefined;
      const sourceIndex = sourcePhase === undefined ? -1 : phaseOrder.indexOf(sourcePhase);
      const requestedIndex = phaseOrder.indexOf(input.phase);
      const sourceStage = sourceIndex >= 0 ? profile.stages.find((candidate) => candidate.id === sourcePhase) : undefined;
      const sourceRecord = sourcePhase === undefined ? undefined : state.specification?.phases.find((candidate) => candidate.phase === sourcePhase);
      const sourceStageRecord = sourcePhase === undefined ? undefined : state.stages.find((candidate) => candidate.id === sourcePhase);
      const sourceCapability = activeCapability(state.dispatch_capability);
      if (
        sourcePhase !== undefined
        && sourcePhase !== input.phase
        && requestedIndex === sourceIndex + 1
        && sourceStage?.checkpoint
        && sourceRecord?.status === "approved"
        && sourceRecord.current_version !== null
        && sourceRecord.approved_version === sourceRecord.current_version
        && sourceRecord.validation_ref === `validation.${sourcePhase}.v${sourceRecord.current_version}`
        && sourceRecord.checkpoint_ref === `checkpoint.${sourcePhase}.v${sourceRecord.current_version}`
        && Array.isArray(state.stages)
        && sourceStageRecord?.status === "done"
        && state.pause.kind === "done"
        && (!sourceCapability || (sourceCapability.status === "complete"
          && sourceCapability.issued_for.stage_cursor === sourcePhase))
        && state.specification?.next_action.kind === "none"
      ) {
        const stopped = selectLatestValidCheckpointDecision(sourceStage, state, { bindCapability: false });
        if (stopped.ok && stopped.decision && checkpointDecisionEffect(stopped.decision) === "stop") {
          const expectedArtifactId = `${sourcePhase}.v${sourceRecord.current_version}`;
          const artifactsDir = artifactsRelativeFor(pinnedRoot, target);
          const artifact = artifactsDir ? readNativeHandoffArtifact(pinnedRoot, target, expectedArtifactId) : null;
          const validation = artifactsDir && sourceRecord.validation_ref
            ? readArtifactPinned<Record<string, unknown>>(pinnedRoot, artifactsDir, sourceRecord.validation_ref)
            : null;
          if (
            stopped.decision.feature_id === workspace?.feature_id
            && stopped.decision.artifact_id === expectedArtifactId
            && stopped.decision.artifact_version === sourceRecord.current_version
            && stopped.decision.validation_ref === sourceRecord.validation_ref
            && artifact
            && validation
            && deterministicValidationMatchesArtifact(artifact, validation, pinnedRoot)
            && stopped.decision.artifact_digest === digestOf(artifact)
            && stopped.decision.validation_digest === digestOf(validation)
          ) {
            const prepared = stoppedNativePreparationRequiredState(state, target, pinnedRoot, profile, sourcePhase, input.phase, sourceCapability);
            return { ok: true, resumed: false, preparation_required: true, next_phase: input.phase, state: prepared };
          }
          return { ok: false, error: "native specification resume checkpoint is stale for the current phase artifact", state };
        }
      }
      const stage = profile.stages.find((candidate) => candidate.id === input.phase);
      if (!stage?.checkpoint) {
        return { ok: false, error: `native specification phase '${input.phase}' has no declared checkpoint`, state };
      }
      const phaseRecord = workspace.phases.find((candidate) => candidate.phase === input.phase);
      if (!Array.isArray(state.stages)) return { ok: true, resumed: false, next_phase: null, state };
      const stageRecord = state.stages.find((candidate) => candidate.id === input.phase);
      const cap = activeCapability(state.dispatch_capability);
      if (
        state.stage_cursor !== input.phase
        || stageRecord?.status !== "done"
        || state.pause.kind !== "done"
        || !cap
        || cap.status !== "complete"
        || cap.issued_for.stage_cursor !== input.phase
        || workspace.next_action.kind !== "none"
        || !phaseRecord
        || phaseRecord.status !== "approved"
        || phaseRecord.current_version === null
        || phaseRecord.approved_version !== phaseRecord.current_version
        || phaseRecord.validation_ref !== `validation.${input.phase}.v${phaseRecord.current_version}`
        || phaseRecord.checkpoint_ref !== `checkpoint.${input.phase}.v${phaseRecord.current_version}`
      ) {
        return { ok: true, resumed: false, next_phase: null, state };
      }
      const selected = selectLatestValidCheckpointDecision(stage, state, { bindCapability: false });
      if (!selected.ok || !selected.decision || checkpointDecisionEffect(selected.decision) !== "stop") {
        return { ok: true, resumed: false, next_phase: null, state };
      }
      const decision = selected.decision;
      const expectedArtifactId = `${input.phase}.v${phaseRecord.current_version}`;
      if (
        decision.feature_id !== workspace.feature_id
        || decision.artifact_id !== expectedArtifactId
        || decision.artifact_version !== phaseRecord.current_version
        || decision.validation_ref !== phaseRecord.validation_ref
      ) {
        return { ok: false, error: "native specification resume checkpoint is stale for the current phase artifact", state };
      }
      if (!workspace.constitution_binding || validateConstitutionBinding(workspace.constitution_binding).length > 0) {
        return { ok: false, error: "native specification resume constitution binding is unavailable or invalid", state };
      }
      const artifact = readNativeHandoffArtifact(pinnedRoot, target, expectedArtifactId);
      if (
        !artifact
        || artifact.artifact_id !== expectedArtifactId
        || artifact.phase !== input.phase
        || artifact.version !== phaseRecord.current_version
        || canonicalJson(artifact.constitution_binding) !== canonicalJson(workspace.constitution_binding)
      ) {
        return { ok: false, error: "native specification resume phase artifact is missing or stale", state };
      }
      const artifactsDir = artifactsRelativeFor(pinnedRoot, target);
      const validation = artifactsDir ? readArtifactPinned<Record<string, unknown>>(pinnedRoot, artifactsDir, phaseRecord.validation_ref) : null;
      if (!artifactsDir || !validation || !deterministicValidationMatchesArtifact(artifact, validation, pinnedRoot)) {
        return { ok: false, error: "native specification resume phase validation is missing or stale", state };
      }
      if (decision.artifact_digest !== digestOf(artifact) || decision.validation_digest !== digestOf(validation)) {
        return { ok: false, error: "native specification resume checkpoint digest is stale for the current phase evidence", state };
      }
      const materialized = revalidateMaterializedDocumentsPinned(pinnedRoot, {
        feature_id: workspace.feature_id,
        phase: input.phase,
        version: phaseRecord.current_version,
      });
      if (
        !materialized.ok
        || !materialized.value.binding
        || materialized.value.binding.artifact_id !== expectedArtifactId
        || canonicalJson(materialized.value.binding.constitution_binding) !== canonicalJson(workspace.constitution_binding)
        || !Object.values(materialized.value.documents).every((document) => document.matches)
      ) {
        return { ok: false, error: "native specification resume phase projection is missing or stale", state };
      }
      const targetPhase = input.phase === "specify" ? "plan" : input.phase === "plan" ? "tasks" : null;
      if (!targetPhase) {
        const finalized = finalizeNativeImplementationHandoffMutation(state, target, pinnedRoot, input.run_key, (cleanup) => { deferredRollbacks.push(cleanup); });
        if (!finalized.ok) return { ok: false, error: finalized.error, state };
        if (!finalized.state) return { ok: false, error: "native specification resume finalization did not return committed state", state };
        return { ok: true, resumed: true, next_phase: null, state: finalized.state };
      }
      const targetStage = profile.stages.find((candidate) => candidate.id === targetPhase);
      if (!targetStage) return { ok: false, error: `native specification resume target phase '${targetPhase}' is unavailable`, state };
      const prepared = stoppedNativePreparationRequiredState(state, target, pinnedRoot, profile, input.phase, targetPhase, cap, (cleanup) => { deferredCleanups.push(cleanup); });
      return { ok: true, resumed: false, preparation_required: true, next_phase: targetPhase, state: prepared };
    },
    transactionOptions,
  );
  return result;
}

/**
 * Strict role -> agent resolution for roster-policy stages: only a trusted
 * live registered mapping may name the concrete agent. An empty string means
 * "no registered agent" and fails closed downstream — project config
 * fallbacks and identity (role-name-as-agent) fallbacks never apply here.
 */
function liveRosterAgent(config: ResolvedConfig, role: string): string {
  return config.agent_mapping?.resolved_roles[role] ?? "";
}

/**
 * Opaque proof that a host-discovered agent mapping was published and then
 * reread from the current project root together with its exact config.
 *
 * The runtime brand is deliberately module-private: structural objects that
 * merely resemble a proof cannot cross the authorization boundary. The proof
 * is revalidated against the pinned root and canonical mapping at each use,
 * so callers cannot substitute a stale mapping or move a proof between roots.
 */
const trustedMappingProofs = new WeakMap<object, {
  readonly canonical_root: string;
  readonly dev: number;
  readonly ino: number;
  readonly descriptor_fingerprint: string;
  readonly mapping: AgentMappingState;
  readonly publication: AgentMappingPublicationReceipt;
  used: boolean;
}>();
const trustedMappingProofBrand: unique symbol = Symbol("omp.trusted.mapping.proof");

export interface TrustedMappingProof {
  readonly [trustedMappingProofBrand]: true;
}

function mappingExpectationForConfig(config: ResolvedConfig): Record<string, unknown> {
  return {
    roles: config.roles,
    extraRoles: config.scope_map.map((entry) => entry.dev_agent),
    scope_map: config.scope_map,
    flags: config.flags,
    roster: config.roster_overrides,
    config_path: config.config_path,
    config_source: config.config_source,
    config_hash: config.config_hash,
    config_version: config.config_version,
    config_provenance: config.config_provenance,
  };
}

function canonicalPublishedMapping(
  cwd: string,
  pinnedRoot: PinnedProjectRoot,
  config: ResolvedConfig,
): AgentMappingState | null {
  if (!pinnedRoot.isStable()) return null;
  if (!/^[a-f0-9]{64}$/u.test(config.config_hash)) return null;
  if (config.config_path === null) {
    if (config.config_source !== "defaults") return null;
  } else if (pinnedRoot.relativePath(config.config_path) === null) return null;
  const mapping = readAgentMapping(cwd, mappingExpectationForConfig(config), pinnedRoot);
  if (!mapping || mapping.config_path !== config.config_path || mapping.config_hash !== config.config_hash) return null;
  if (mapping.provenance?.config_path !== config.config_path || mapping.provenance?.config_hash !== config.config_hash) return null;
  return mapping;
}

function trustedMappingDescriptor(
  pinnedRoot: PinnedProjectRoot,
  config: ResolvedConfig,
  mapping: AgentMappingState,
): string {
  return descriptorFingerprint({
    root: { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    config: { path: config.config_path, hash: config.config_hash, version: config.config_version },
    mapping,
  });
}

/**
 * Mint a proof only for a mapping that exactly reproduces the canonical
 * workspace publication. Callers must publish the mapping first; a freshly
 * constructed in-memory map is never accepted as authorization input.
 */
export function issueTrustedMappingProof(cwd: string, mapping: unknown): TrustedMappingProof {
  const validated = validateAgentMappingState(mapping);
  if (!validated.ok) throw new Error(`trusted agent mapping handoff is malformed (${validated.error})`);
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) throw new Error('project root could not be pinned for trusted agent mapping proof');
  try {
    const publication = agentMappingPublicationReceipt(validated.mapping, pinnedRoot);
    if (!publication) throw new Error('trusted agent mapping is not the exact canonical config-bound publication (engine publication receipt missing or stale)');
    const config = resolveConfig(cwd, undefined, pinnedRoot);
    const canonical = canonicalPublishedMapping(cwd, pinnedRoot, config);
    if (!canonical || canonicalJson(canonical) !== canonicalJson(validated.mapping)) {
      throw new Error('trusted agent mapping is not the exact canonical config-bound publication');
    }
    const proof = Object.freeze(Object.create(null)) as TrustedMappingProof;
    trustedMappingProofs.set(proof as object, {
      canonical_root: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
      descriptor_fingerprint: trustedMappingDescriptor(pinnedRoot, config, canonical),
      mapping: cloneAndFreeze(canonical),
      publication,
      used: false,
    });
    return proof;
  } finally {
    pinnedRoot.close();
  }
}

/** Mint a fresh proof from the exact in-memory host publication for this root. */
export function issueCurrentTrustedMappingProof(cwd: string): TrustedMappingProof | undefined {
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return undefined;
  try {
    const mapping = latestPublishedAgentMapping(pinnedRoot);
    return mapping ? issueTrustedMappingProof(cwd, mapping) : undefined;
  } finally {
    pinnedRoot.close();
  }
}

export interface NativePreparationSource {
  feature_id: string;
  run_key: string;
  phase: "specify" | "plan" | "tasks";
  preparation_handoff_digest: string;
  preparation_state_revision: number;
  request_id: string;
  profile_hash: string;
  policy_hash?: string;
  expected_roster?: Array<{ role: string; agent: string; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }>;
}

export type TrustedMappingOptions = { trustedMappingProof?: TrustedMappingProof; feature_id?: string; run_key?: string; consumeTrustedMappingProof?: boolean; native_preparation_source?: NativePreparationSource };

/**
 * Bind an opaque canonical mapping proof over the resolved workspace config.
 * The published map and config are reread under the transaction's pinned root
 * before role availability can influence capability issuance.
 */
function bindTrustedMapping(
  cwd: string,
  pinnedRoot: PinnedProjectRoot,
  config: ResolvedConfig,
  proof: unknown,
): { ok: true; config: ResolvedConfig; trusted: boolean } | { ok: false; error: string } {
  if (proof === undefined) return { ok: true, config, trusted: false };
  if (!proof || typeof proof !== 'object') {
    return { ok: false, error: 'trusted agent mapping proof is not an engine-issued opaque proof' };
  }
  const cell = trustedMappingProofs.get(proof as object);
  if (!cell) return { ok: false, error: 'trusted agent mapping proof is unknown or stale' };
  if (!pinnedRoot.isStable() || cell.canonical_root !== pinnedRoot.canonical_root || cell.dev !== pinnedRoot.dev || cell.ino !== pinnedRoot.ino) {
    return { ok: false, error: 'trusted agent mapping proof is bound to a different or changed project root' };
  }
  if (cell.used) return { ok: false, error: 'trusted agent mapping proof is already consumed or stale' };
  if (!verifyAgentMappingPublicationReceipt(pinnedRoot, cell.publication)) {
    return { ok: false, error: 'trusted agent mapping proof publication receipt is stale or replaced' };
  }
  const canonical = canonicalPublishedMapping(cwd, pinnedRoot, config);
  if (!canonical || canonicalJson(canonical) !== canonicalJson(cell.mapping)
    || trustedMappingDescriptor(pinnedRoot, config, canonical) !== cell.descriptor_fingerprint) {
    return { ok: false, error: 'trusted agent mapping proof is stale or no longer matches the canonical config-bound publication' };
  }
  return { ok: true, config: { ...config, agent_mapping: cell.mapping }, trusted: true };
}

/** Mark an already-validated proof consumed only from a committed transition. */
function consumeTrustedMappingProof(proof: unknown): void {
  if (!proof || typeof proof !== "object") return;
  const cell = trustedMappingProofs.get(proof as object);
  if (cell) cell.used = true;
}

/**
 * Dispatch-slot agent resolution at the trusted boundary. With a handoff
 * bound, the slot role must resolve through the handoff's `resolved_roles`
 * (`available_agents` membership is already guaranteed by the shared
 * validator) — a missing or unavailable role returns `null` and the caller
 * fails closed instead of falling back to config or the role name. Roster
 * stages require this proof before reaching this resolver; non-roster legacy
 * stages may still resolve their exact manifest through config.
 */
function trustedSlotAgent(role: string, config: ResolvedConfig, trusted: boolean): string | null {
  if (!trusted) return resolveAgentForRole(role, config);
  return liveRosterAgent(config, role) || null;
}

/**
 * Prefix match between a caller's requested semantic composition and the
 * frozen selection. Slots the engine deterministically appends (minimum
 * worker bound, risk triggers) are engine-owned, so a requested composition
 * matches when it is a prefix of the frozen one; any other difference is a
 * changed selection. Occurrences are numbered by position among same-role
 * entries, exactly as `selectRoster` freezes them.
 */
function selectionCompositionMatchesFrozen(
  requested: Array<{ role: string; facet?: string | null }>,
  frozen: Array<{ role: string; occurrence: number; facet: string | null }>,
): boolean {
  if (requested.length > frozen.length) return false;
  const seen = new Map<string, number>();
  return requested.every((occurrence, index) => {
    const entry = frozen[index];
    if (!entry) return false;
    const occurrenceNumber = (seen.get(occurrence.role) ?? 0) + 1;
    seen.set(occurrence.role, occurrenceNumber);
    return entry.role === occurrence.role
      && entry.occurrence === occurrenceNumber
      && (entry.facet ?? null) === (occurrence.facet ?? null);
  });
}

/** Live registered agent for a role, or null when the mapping does not name one. */
function requestedSelectionOccurrences(selection: RosterBeginSelection): RosterSelectionContext["selected_occurrences"] {
  return selection.occurrences.map((occurrence) => ({
    role: occurrence.role,
    facet: occurrence.facet ?? null,
    ...(occurrence.focus !== undefined ? { focus: occurrence.focus } : {}),
    ...(occurrence.reason !== undefined ? { reason: occurrence.reason } : {}),
  }));
}

function rosterSelectionInputError(selection: unknown): string | null {
  return workflowRosterSelectionInputError(selection);
}

/**
 * Create the opaque dispatch capability after the model has persisted the
 * classification and stage list. This is the entry point for the native
 * `/do-work` prompt; the interpreter path uses `createCapability` directly.
 * An optional semantic roster selection (never concrete agent ids) is
 * validated against the stage's allowed pool and the live registered agent
 * mapping, then frozen on the issued capability.
 *
 * `options.trustedMappingProof` carries an opaque engine-issued proof for a
 * canonical host-discovered mapping. A raw, stale, or absent proof cannot
 * authorize roster role availability; roster capabilities fail closed until
 * the host publishes a fresh engine-issued proof.
 */
export function beginCapability(cwd: string, requested?: RosterBeginSelection, options?: TrustedMappingOptions): TransitionResult {
  const selectionError = rosterSelectionInputError(requested);
  if (selectionError) return { ok: false, error: `roster selection rejected: ${selectionError}` };
  let guardedWorkspace: FeatureWorkspace | undefined;
  let guardedRoot: PinnedProjectRoot | undefined;
  const deferredCleanups: Array<() => void> = [];
  const deferredProofConsumptions: Array<() => void> = [];
  const result = runDurableTransaction<TransitionResult>(cwd, options ?? {}, (state, target, pinnedRoot) => {
    guardedRoot = pinnedRoot;
    guardedWorkspace = state.specification;
    if (guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
      const constitutionError = workspaceConstitutionError(pinnedRoot, guardedWorkspace);
      if (constitutionError) return { ok: false, error: constitutionError, state };
    }
    const mutation = beginCapabilityMutation(cwd, state, target, pinnedRoot, requested, options, (cleanup) => { deferredCleanups.push(cleanup); });
    if (mutation.ok && options?.trustedMappingProof !== undefined && options.consumeTrustedMappingProof !== false) deferredProofConsumptions.push(() => consumeTrustedMappingProof(options.trustedMappingProof));
    return mutation;
  }, {
    ...(options ?? {}),
    preCommit: () => {
      if (guardedRoot && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
        const constitutionError = workspaceConstitutionError(guardedRoot, guardedWorkspace);
        if (constitutionError) throw new Error(constitutionError);
      }
    },
    postCommit: () => {
      for (const cleanup of deferredCleanups) cleanup();
      for (const consume of deferredProofConsumptions) consume();
    },
  });
  return result;
}
export interface NativePreparationBeginReissueInput {
  feature_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  phase: "specify" | "plan" | "tasks";
  preparation_handoff_digest: string;
  preparation_state_revision: number;
  request_id: string;
  capability_id: string;
  cursor_epoch: string;
}

/** Reissue only the bearer secrets for an exact crash-after-begin postimage. */
export function reissueNativePreparationBegin(cwd: string, input: NativePreparationBeginReissueInput): TransitionResult {
  if (!isSafeFeatureId(input.feature_id) || !input.run_key.trim() || !input.branch.trim() || !input.workflow.trim() || !input.profile_hash.trim() || !input.phase || !input.request_id.trim() || !input.capability_id.trim() || !input.cursor_epoch.trim()) {
    return { ok: false, error: "native preparation begin reissue input is malformed" };
  }
  const profile = loadProfile(input.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === input.phase);
  if (!stage) return { ok: false, error: "native preparation begin reissue workflow stage is unavailable" };
  return runDurableTransaction(cwd, { feature_id: input.feature_id, run_key: input.run_key }, (state, _target, _pinnedRoot) => {
    const marker = state.preparation_start;
    const cap = activeCapability(state.dispatch_capability);
    if (!marker || marker.status !== "begun" || !marker.expected_roster) return { ok: false, error: "native preparation begin marker is unavailable or no longer retryable", state };
    if (state.branch !== input.branch || state.run_key !== input.run_key || state.classification.workflow !== input.workflow || state.stage_cursor !== input.phase || state.profile_hash !== input.profile_hash || marker.capability_id !== input.capability_id || marker.phase !== input.phase || marker.request_id !== input.request_id || marker.preparation_digest !== input.preparation_handoff_digest || marker.preparation_state_revision !== input.preparation_state_revision || cap?.issued_for.cursor_epoch !== input.cursor_epoch) return { ok: false, error: "native preparation begin reissue binding mismatch", state };
    const source: NativePreparationSource = {
      feature_id: input.feature_id,
      run_key: input.run_key,
      phase: input.phase,
      preparation_handoff_digest: input.preparation_handoff_digest,
      preparation_state_revision: input.preparation_state_revision,
      request_id: input.request_id,
      profile_hash: input.profile_hash,
      ...(marker.policy_hash === undefined ? {} : { policy_hash: marker.policy_hash }),
      expected_roster: marker.expected_roster,
    };
    const sourceError = nativePreparationSourceError(state, cap, source, input.phase, input.profile_hash, marker.expected_roster);
    if (sourceError) return { ok: false, error: sourceError, state };
    if (!cap) return { ok: false, error: "native preparation begin capability is unavailable", state };
    const reissued = reissueActiveCapability(cap, marker.policy_hash);
    const next: TeamState = {
      ...state,
      dispatch_capability: { ...reissued.state, roster_selection: cap.roster_selection },
      updated_at: now(),
    };
    return { ok: true, state: next, handoff: handoffFromState(next, { capability_id: reissued.capability_id, dispatch_token: reissued.dispatch_token, advance_token: reissued.advance_token }, stage) };
  }, {});
}

function beginCapabilityMutation(cwd: string, state: TeamState, target: ResolvedState, pinnedRoot: PinnedProjectRoot, requested?: RosterBeginSelection, options?: TrustedMappingOptions, deferCleanup?: DeferredCleanup): TransitionResult {

  if (state.specification?.status === "stale") {
    return { ok: false, error: "specification workspace is stale; repair the execution claim binding before issuing a capability", state };
  }
  const workflow = state.classification?.workflow;
  if (!workflow) return { ok: false, error: "workflow classification is missing", state };
  const profile = loadProfile(workflow);
  if (!profile) return { ok: false, error: `workflow '${workflow}' is unavailable`, state };
  const persistedHash = profileHash(profile);
  if (state.profile_hash && state.profile_hash !== persistedHash) return { ok: false, error: "workflow profile hash is stale", state };
  if (!Array.isArray(state.stages)) return { ok: false, error: "workflow stages are missing", state };
  const stages = state.stages.length > 0
    ? state.stages
    : profile.stages.map((candidate) => ({ id: candidate.id, status: "pending" as const }));
  const stageId = state.stage_cursor || profile.stages[0]?.id;
  const stage = profile.stages.find((candidate) => candidate.id === stageId);
  if (!stage) return { ok: false, error: `workflow stage '${stageId ?? ""}' is unavailable`, state };
  const stageEntry = stages.find((candidate) => candidate.id === stage.id);
  if (!stageEntry) return { ok: false, error: `workflow stage '${stage.id}' is not persisted`, state };
  if (stageEntry.status === "done" || stageEntry.status === "skipped") return { ok: false, error: `workflow stage '${stage.id}' is already ${stageEntry.status}`, state };
  const nativePreparationStage = state.specification?.source_kind === "native"
    && (stage.id === "specify" || stage.id === "plan" || stage.id === "tasks");
  if (nativePreparationStage) {
    const handoff = state.preparation_handoff;
    if (!handoff || !verifyPreparationHandoffDigest(handoff) || !verifyPreparationHandoffAuth(pinnedRoot, handoff)) {
      return { ok: false, error: "native specification capability requires the exact authenticated preparation_handoff", state };
    }
    if (!options?.native_preparation_source) {
      return { ok: false, error: "native specification capability requires the engine-issued authenticated preparation source", state };
    }
  }
  if (stage.roster_policy && options?.trustedMappingProof === undefined) {
    return { ok: false, error: `workflow stage '${stage.id}' requires an engine-issued trusted agent mapping proof before roster selection`, state };
  }
  // Legacy migration resumes validate an existing immutable phase artifact;
  // they never dispatch a content worker. Treat this capability as a
  // non-roster validation gate so host agent discovery cannot block the
  // required fresh validation of migrated content.
  const migratedValidationPhase = state.specification?.source_kind === "legacy"
    && state.specification.phases.some((candidate) => candidate.phase === stage.id && candidate.status === "materialized" && candidate.current_version !== null);

  const existing = activeCapability(state.dispatch_capability);
  if (state.policy?.strict_orchestrator === true && state.dispatch_capability && !existing) return { ok: false, error: "workflow dispatch capability is malformed", state };
  const existingDispatches = existing?.issued_for.stage_cursor === stage.id ? existing.dispatches : [];
  const config = resolveConfig(cwd, undefined, pinnedRoot);
  const trusted = bindTrustedMapping(cwd, pinnedRoot, config, options?.trustedMappingProof);
  if (!trusted.ok) return { ok: false, error: trusted.error, state };
  const effectiveConfig = trusted.config;
  const flags = state.scope ?? resolveScope([], config);
  const kind: "none" | "single" | "consilium" = migratedValidationPhase
    ? "none"
    : stage.type === "single" || stage.type === "consilium" ? stage.type : "none";
  const reuseSelection = stage.roster_policy
    ? state.roster_selection?.stage_id === stage.id
      ? state.roster_selection
      : state.roster_selections?.[stage.id]
    : undefined;
  const capabilityEpoch = existing?.issued_for.stage_cursor === stage.id
    ? existing.issued_for.cursor_epoch
    : state.cursor_epoch ?? randomUUID();
  let rosterSelection = reuseSelection;
  let slots: ReturnType<typeof resolveStageDispatchSlots> = [];
  let expectedRoster: Array<{ role: string; agent: string; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }> = [];
  if (kind === "none") {
    slots = [];
  } else if (stage.roster_policy) {
    if (!effectiveConfig.agent_mapping) {
      return {
        ok: false,
        error: `workflow stage '${stage.id}' requires a live registered agent mapping before dispatch; none is trusted for the current configuration (regenerate the agent mapping from host discovery)`,
        state,
      };
    }
    if (requested) {
      if (requested.occurrences.some((occurrence) => "agent" in occurrence)) {
        return { ok: false, error: `workflow stage '${stage.id}' accepts only semantic role/facet/reason selections; concrete agent ids are never caller authority`, state };
      }
      if (requested.occurrences.some((occurrence) => typeof occurrence.role !== "string" || occurrence.role.trim() === "")) {
        return { ok: false, error: `workflow stage '${stage.id}' roster selection requires a non-empty semantic role for every occurrence`, state };
      }
      const unmapped = [...new Set(requested.occurrences.map((occurrence) => occurrence.role))].filter((role) => !effectiveConfig.agent_mapping?.resolved_roles[role]);
      if (unmapped.length > 0) {
        return { ok: false, error: `workflow stage '${stage.id}' selected roles have no live registered agent mapping: ${unmapped.map((role) => `'${role}'`).join(", ")}`, state };
      }
    }
    const frozen = reuseSelection;
    const frozenActive = Boolean(
      frozen
      && frozen.capability_epoch === capabilityEpoch
      && existing?.issued_for.stage_cursor === stage.id
      && existing.status !== "complete"
      && existing.status !== "invalidated",
    );
    if (frozenActive && frozen && requested && !selectionCompositionMatchesFrozen(requested.occurrences, frozen.selected)) {
      return {
        ok: false,
        error: `workflow stage '${stage.id}' roster selection is frozen for the active capability (snapshot '${frozen.snapshot_id}'); a changed selection is rejected — re-issue the identical semantic selection or wait for the capability to complete`,
        state,
      };
    }
    const requestedOccurrences = requested && !frozenActive ? requestedSelectionOccurrences(requested) : undefined;
    const selection = requestedOccurrences
      ? selectRoster(stage, {
          cwd,
          flags,
          resolveDevAgent: () => flags.dev_agent,
          state,
          profile_hash: persistedHash,
          run_key: state.run_key ?? state.branch,
          workflow,
          capability_epoch: capabilityEpoch,
          resolveAgent: (role) => liveRosterAgent(effectiveConfig, role),
          selected_occurrences: requestedOccurrences,
          ...(requested?.rationale !== undefined ? { rationale: requested.rationale } : {}),
          ...(requested?.evidence !== undefined ? { evidence: requested.evidence } : {}),
        } satisfies RosterSelectionContext)
      : reuseSelection && reuseSelection.capability_epoch === capabilityEpoch
        ? {
            ok: true as const,
            selection: reuseSelection,
            slots: reuseSelection.selected.map((entry) => ({ slot: entry.slot_id, slot_id: entry.slot_id, role: entry.role, occurrence: entry.occurrence, facet: entry.facet })),
            expected_roster: reuseSelection.selected.map((entry) => ({ role: entry.slot_id, agent: entry.agent })),
          }
        : selectRoster(stage, {
            cwd,
            flags,
            resolveDevAgent: () => flags.dev_agent,
            state,
            profile_hash: persistedHash,
            run_key: state.run_key ?? state.branch,
            workflow,
            capability_epoch: capabilityEpoch,
            resolveAgent: (role) => liveRosterAgent(effectiveConfig, role),
          } satisfies RosterSelectionContext);
    if (selection.ok === false) return { ok: false, error: `workflow stage '${stage.id}' roster selection failed: ${selection.error}`, state };
    rosterSelection = selection.selection;
    slots = selection.slots;
    expectedRoster = selection.expected_roster;
  } else {
    try {
      slots = resolveStageDispatchSlots(stage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
      for (const slot of slots) {
        const agent = trustedSlotAgent(slot.role, effectiveConfig, trusted.trusted);
        if (agent === null) {
          return {
            ok: false,
            error: `workflow stage '${stage.id}' dispatch roster unresolved: role '${slot.role}' is missing or unavailable in the trusted agent mapping handoff's resolved_roles`,
            state,
          };
        }
        expectedRoster.push({ role: slot.slot, agent });
      }
    } catch (error) {
      return { ok: false, error: `workflow stage '${stage.id}' dispatch roster unresolved: ${String(error)}`, state };
    }
  }
  if ((kind === "single" && slots.length !== 1) || (kind === "consilium" && slots.length === 0)) return { ok: false, error: `workflow stage '${stage.id}' has an invalid dispatch roster`, state };
  const mappingIssues: Array<{ role: string; diagnostic: AgentMappingDiagnostic }> = [];
  for (const slot of slots) {
    const diagnostic = agentMappingIssueForRole(slot.role, effectiveConfig);
    if (diagnostic) mappingIssues.push({ role: slot.role, diagnostic });
  }
  if (mappingIssues.length > 0) {
    const details = mappingIssues.map(({ role, diagnostic }) => `role '${role}' requested '${diagnostic.requested}' (candidates: ${diagnostic.candidates.join(", ")})`).join("; ");
    return { ok: false, error: `workflow stage '${stage.id}' has no available agent mapping: ${details}`, state };
  }

  const nativePreparationSource = options?.native_preparation_source;
  if (nativePreparationSource) {
    const sourceError = nativePreparationSourceError(state, existing, nativePreparationSource, stage.id, persistedHash, expectedRoster);
    if (sourceError) return { ok: false, error: sourceError, state };
  } else if (state.preparation_start?.status === "begun") {
    return { ok: false, error: "native preparation begin marker requires its authenticated source for retry", state };
  }

  const terminalValidationRound = Boolean(existing
    && existing.dispatches.some((record) => record.purpose === "validation")
    && existing.dispatches.every((record) => record.status === "succeeded" || record.status === "failed" || record.status === "cancelled"));
  if (existing && existing.issued_for.stage_cursor === stage.id && stageEntry.status === "in_progress" && existing.status !== "complete" && existing.status !== "invalidated" && !terminalValidationRound) {
    const rosterChanged = JSON.stringify(existing.expected_roster) !== JSON.stringify(expectedRoster);
    if (existingDispatches.length > 0 && rosterChanged) return { ok: false, error: "active dispatch capability roster is inconsistent", state };
    if (!rosterChanged) {
      const reissued = reissueActiveCapability(existing, rosterPolicyHash(stage));
      const pendingActive = (reissued.state.dispatches ?? []).some((record) => record.status === "pending" || record.status === "running");
      const next: TeamState = {
        ...state,
        run_key: state.run_key ?? state.branch,
        profile_hash: persistedHash,
        cursor_epoch: reissued.state.issued_for!.cursor_epoch,
        stage_cursor: stage.id,
        scope: flags,
        stages: stages.map((entry) => entry.id === stage.id ? { ...entry, status: "in_progress" as const } : entry),
        ...(rosterSelection ? { roster_selection: rosterSelection, roster_selections: { ...(state.roster_selections ?? {}), [stage.id]: rosterSelection } } : {}),
        dispatch_capability: { ...reissued.state, roster_selection: rosterSelection ?? reissued.state.roster_selection },
        pause: pendingActive ? { kind: "background_wait", reason: "provider work remains pending" } : { kind: "none", reason: "" },
        updated_at: now(),
      };
      return { ok: true, state: next, handoff: handoffFromState(next, { capability_id: reissued.capability_id, dispatch_token: reissued.dispatch_token, advance_token: reissued.advance_token }, stage) };
    }
  }
  const resetState = stageEntry.status === "in_progress" ? state : resetReopenedStageState(state, target, pinnedRoot, profile, stage.id, existing, deferCleanup);
  const retainedDispatches = stageEntry.status === "in_progress" && !terminalValidationRound ? existingDispatches : [];
  const issued = createCapability({
    run_key: resetState.run_key ?? resetState.branch,
    branch: resetState.branch,
    workflow,
    profile_hash: persistedHash,
    stage_cursor: stage.id,
    cursor_epoch: capabilityEpoch,
    kind,
    expected_roster: expectedRoster,
    roster_selection: rosterSelection,
    ...(rosterPolicyHash(stage) === undefined ? {} : { policy_hash: rosterPolicyHash(stage) }),
  });
  if (nativePreparationSource && nativePreparationSource.policy_hash !== undefined && nativePreparationSource.policy_hash !== issued.state.policy_hash) return { ok: false, error: "native preparation source policy binding mismatch", state };
  const next: TeamState = {
    ...resetState,
    run_key: resetState.run_key ?? resetState.branch,
    profile_hash: persistedHash,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    stage_cursor: stage.id,
    scope: flags,
    policy: { ...(resetState.policy ?? {}), strict_orchestrator: true },
    stages: stages.map((entry) => entry.id === stage.id ? { ...entry, status: "in_progress" as const } : entry),
    ...(rosterSelection ? { roster_selection: rosterSelection, roster_selections: { ...(resetState.roster_selections ?? {}), [stage.id]: rosterSelection } } : {}),
    dispatch_capability: { ...issued.state, status: retainedDispatches.length > 0 ? "dispatched" as const : "ready" as const, dispatches: retainedDispatches },
    pause: { kind: "none", reason: "" },
    updated_at: now(),
  };
  const markedNext: TeamState = nativePreparationSource
    ? {
      ...next,
      preparation_start: {
        status: "begun",
        phase: stage.id as "specify" | "plan" | "tasks",
        capability_id: issued.capability_id,
        capability_epoch: issued.state.issued_for!.cursor_epoch,
        request_id: nativePreparationSource.request_id,
        start_postimage_digest: preparationStartPostimageDigest(next),
        token: resetState.preparation_handoff!.token,
        preparation_digest: nativePreparationSource.preparation_handoff_digest,
        preparation_state_revision: nativePreparationSource.preparation_state_revision,
        expected_state_revision: (state.state_revision ?? 0) + 1,
        profile_hash: persistedHash,
        ...(issued.state.policy_hash === undefined ? {} : { policy_hash: issued.state.policy_hash }),
        expected_roster: issued.state.expected_roster,
      },
    }
    : next;
  return {
    ok: true,
    state: markedNext,
    handoff: handoffFromState(markedNext, { capability_id: issued.capability_id, dispatch_token: issued.dispatch_token, advance_token: issued.advance_token }, stage),
  };
}
function capabilityBindingError(cap: ActiveCapability, a: Pick<DispatchAuth, "capability_id" | "run_key" | "branch" | "workflow" | "profile_hash" | "stage_cursor" | "cursor_epoch">): string | null {
  if (!a.capability_id || a.capability_id !== cap.capability_id) return "capability identity mismatch";
  const b = cap.issued_for;
  if (a.run_key !== b.run_key || a.branch !== b.branch || a.workflow !== b.workflow || !profileHashMatches(b.profile_hash, a.profile_hash) || a.stage_cursor !== b.stage_cursor || a.cursor_epoch !== b.cursor_epoch) return "capability binding mismatch";
  return null;
}

function auth(cap: ActiveCapability, a: DispatchAuth, secretHash: string): string | null {
  if (!a.capability_id || a.capability_id !== cap.capability_id) return "capability identity mismatch";
  if (!a.token || hash(a.token) !== secretHash) return "invalid secret";
  return capabilityBindingError(cap, a);
}

/** Verify the persisted state still authenticates the capability issuer. */
function stateCapabilityBindingError(
  state: TeamState,
  cap: ActiveCapability,
  pinnedRoot?: PinnedProjectRoot,
  featureId?: string,
): string | null {
  const issued = cap.issued_for;
  if (state.run_key !== issued.run_key
    || state.branch !== issued.branch
    || state.classification.workflow !== issued.workflow
    || !state.profile_hash
    || !profileHashMatches(issued.profile_hash, state.profile_hash)
    || state.stage_cursor !== issued.stage_cursor
    || state.cursor_epoch !== issued.cursor_epoch) {
    return "capability state binding mismatch";
  }
  if (featureId !== undefined && state.specification?.feature_id !== featureId) return "capability feature binding mismatch";
  if (pinnedRoot && state.specification) {
    const identity = state.specification.project_root_identity;
    if (identity.canonical_path !== pinnedRoot.canonical_root || identity.dev !== pinnedRoot.dev || identity.ino !== pinnedRoot.ino) return "capability root binding mismatch";
  }
  return null;
}

/**
 * Validate the exact durable stage postimage used by the interpreter after a
 * process restart. This is intentionally stricter than bearer-token auth:
 * neither a reminted secret nor a capability-id-only replay can pass.
 */
function persistedStageAuthError(state: TeamState, cap: ActiveCapability, input: PersistedStagePostimage): string | null {
  const bindingError = capabilityBindingError(cap, input);
  if (bindingError) return bindingError;
  if (!input.config_hash || state.config_hash !== input.config_hash) return "workflow configuration is missing or stale";
  if (!input.policy_hash || !cap.policy_hash || cap.policy_hash !== input.policy_hash) return "workflow stage policy is missing or stale";
  if (input.work_identity && state.work_identity && JSON.stringify(input.work_identity) !== JSON.stringify(state.work_identity)) return "workflow work identity mismatch";
  return null;
}
function expectedTaskId(cap: ActiveCapability, role: string): string {
  return dispatchTaskId(cap.capability_id, cap.issued_for.run_key, cap.issued_for.branch, cap.issued_for.workflow, cap.issued_for.stage_cursor, role);
}

function authorizeBoundRecord(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  input: DispatchAuth,
  purpose: "generation" | "validation" = "generation",
): TransitionResult {
  const stateBindingError = stateCapabilityBindingError(state, cap, undefined, input.feature_id);
  if (stateBindingError) return { ok: false, error: stateBindingError, state };
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  const role = input.slot_id ?? input.role ?? "";
  const rosterEntry = cap.expected_roster.find((entry) => entry.role === role);
  if (!rosterEntry) return { ok: false, error: "role/slot not expected", state };
  if (input.role !== undefined && input.role !== role) return { ok: false, error: "slot identity mismatch", state };
  if (input.expected_count !== undefined && input.expected_count !== cap.expected_count) return { ok: false, error: "cardinality mismatch", state };
  const taskId = expectedTaskId(cap, role);
  if (input.task_id !== undefined && input.task_id !== taskId) return { ok: false, error: "task identity mismatch", state };
  const recordsForRole = cap.dispatches.filter((record) => record.role === role);
  const latest = recordsForRole[recordsForRole.length - 1];
  if (latest && latest.status !== "failed" && latest.status !== "cancelled") {
    const sameTool = Boolean(input.tool_call_id && latest.tool_call_id === input.tool_call_id);
    const sameTask = Boolean(input.task_id && latest.work_identity?.task_id === input.task_id);
    if (sameTask && !latest.tool_call_id && input.tool_call_id) {
      const rebound: DispatchRecord = { ...latest, tool_call_id: input.tool_call_id };
      const reboundState: TeamState = {
        ...state,
        dispatch_capability: { ...cap, dispatches: cap.dispatches.map((candidate) => candidate.id === latest.id ? rebound : candidate) },
        updated_at: now(),
      };
      return { ok: true, state: reboundState, record: rebound };
    }
    if ((sameTool || sameTask) && (!input.task_id || latest.work_identity?.task_id === input.task_id)) return { ok: true, state, record: latest };
  }
  if (latest && (!input.retry_of || input.retry_of !== latest.id || (latest.status !== "failed" && latest.status !== "cancelled"))) {
    return { ok: false, error: "retry requires an explicit terminal failure linkage", state };
  }
  const dispatchId = randomUUID();
  const attempt = latest ? latest.attempt + 1 : 1;
  const identity = workIdentityFor(state, cap, role, rosterEntry.agent, dispatchId, attempt, taskId);
  const pending = pendingFor(identity, "authorized", undefined, undefined, latest?.id ?? null);
  const record: DispatchRecord = {
    id: dispatchId,
    purpose,
    role,
    agent: rosterEntry.agent,
    tool_call_id: input.tool_call_id,
    status: "authorized",
    attempt,
    created_at: now(),
    work_identity: identity,
    pending,
    completion_envelope: completionEnvelopeFor(identity, "pending", null, [], "authorized", "engine_task_caller"),
    ...(input.phase_version !== undefined ? { phase_version: input.phase_version } : {}),
  };
  const next: TeamState = {
    ...state,
    work_identity: identity,
    completion_envelope: completionEnvelopeFor(identity, "pending", null, [], "authorized", "engine_task_caller"),
    dispatch_capability: {
      ...cap,
      status: "dispatched",
      dispatches: [...cap.dispatches, record],
      pending: [...(cap.pending ?? []), pending],
    },
  };
  return { ok: true, state: next, record };
}

/** Existing-ledger seams for native specification phases.
 */
export type SpecificationDispatchLifecycleResult =
  | { ok: true; state: TeamState; record: DispatchRecord; work_identity: WorkIdentity; capability_epoch: string }
  | { ok: false; error: string; state?: TeamState };

export function authorizeSpecificationPhaseDispatch(cwd: string, input: DispatchAuth & { feature_id: string; request_id: string }, options?: DurableTransactionOptions & TrustedMappingOptions): SpecificationDispatchLifecycleResult {
  if (!isSafeStateSegment(input.feature_id)) return { ok: false, error: "an explicit safe feature_id is required for specification dispatch" };
  if (!input.run_key?.trim()) return { ok: false, error: "an explicit nonblank run_key is required for specification dispatch" };
  if (!input.request_id?.trim()) return { ok: false, error: "a nonblank request_id is required for idempotent specification dispatch" };
  const authorized = authorizeDispatch(cwd, { ...input, tool_call_id: input.request_id }, { ...(options ?? {}), requireNativePreparationMarker: true });
  if (!authorized.ok || !authorized.record?.work_identity) return { ok: false, error: authorized.ok ? "dispatch authorization produced no work identity" : authorized.error, state: authorized.state };
  if (authorized.record.tool_call_id !== input.request_id) return { ok: false, error: "request_id does not match the authorized dispatch", state: authorized.state };
  return { ok: true, state: authorized.state, record: authorized.record, work_identity: authorized.record.work_identity, capability_epoch: authorized.record.work_identity.capability_epoch };
}

export type SpecificationPhaseValidationDispatchResult =
  | {
    ok: true;
    state: TeamState;
    record: DispatchRecord;
    work_identity: WorkIdentity;
    capability_epoch: string;
    capability_id: string;
    dispatch_token: string;
    advance_token: string;
  }
  | { ok: false; error: string; state?: TeamState };

function validationCapabilityLedger(cap: ActiveCapability): {
  expected_roster: Array<{ role: string; agent: string; slot_id?: string }>;
  dispatches: DispatchRecord[];
  kind: "single" | "consilium";
} {
  const latestGeneration = new Map<string, DispatchRecord>();
  for (const record of cap.dispatches) {
    if (record.purpose !== "generation" || record.status !== "succeeded") continue;
    const prior = latestGeneration.get(record.role);
    if (!prior || record.attempt > prior.attempt) latestGeneration.set(record.role, record);
  }
  const generation = [...latestGeneration.values()].sort((left, right) => left.role.localeCompare(right.role));
  const expected_roster = [{ role: "validator", agent: "validator", slot_id: "validator" }];
  return {
    expected_roster,
    dispatches: generation,
    kind: "single",
  };
}

/** Issue a dedicated validation dispatch only after the selected phase has a current materialized artifact. */
export function authorizeSpecificationPhaseValidationDispatch(
  cwd: string,
  input: DispatchAuth & { feature_id: string; request_id: string },
  options: { pinnedRoot?: PinnedProjectRoot; trustedMappingProof?: TrustedMappingProof } = {},
): SpecificationPhaseValidationDispatchResult {
  const inputError = workflowCompletionInputError({ ...input, dispatch_id: input.request_id });
  if (inputError) return { ok: false, error: inputError };
  if (!isSafeStateSegment(input.feature_id)) return { ok: false, error: "an explicit safe feature_id is required for phase validation" };
  if (!input.run_key?.trim() || !input.request_id?.trim()) return { ok: false, error: "run_key and request_id are required for phase validation" };
  if (!input.stage_cursor?.trim()) return { ok: false, error: "stage_cursor is required for phase validation" };
  const suppliedPinnedRoot = options.pinnedRoot;
  const pinnedRoot = suppliedPinnedRoot ?? PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return { ok: false, error: "project root cannot be pinned for phase validation dispatch" };
  try {
    type Transaction = SpecificationPhaseValidationDispatchResult;
    let preCommitConstitutionGuard: (() => void) | null = null;
    let consumeProof = false;
    return runDurableTransaction<Transaction>(cwd, input, (state, target, transactionRoot) => {
      const cap = activeCapability(state.dispatch_capability);
      if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
      const stateBindingError = stateCapabilityBindingError(state, cap, transactionRoot, input.feature_id);
      if (stateBindingError) return { ok: false, error: stateBindingError, state };
      const mappingError = rosterMappingProofError(cwd, state, cap, transactionRoot, options.trustedMappingProof);
      if (mappingError) return { ok: false, error: mappingError, state };
      const readyForValidation = cap.status === "ready" && cap.dispatches.length === 0 && (cap.pending?.length ?? 0) === 0;
      if (!readyForValidation && cap.status !== "dispatched" && cap.status !== "joining") return { ok: false, error: "dispatch capability is not active", state };
      const authError = auth(cap, input, cap.dispatch_token_hash);
      if (authError) return { ok: false, error: authError, state };
      const workspace = state.specification;
      if (!workspace || workspace.feature_id !== input.feature_id || (workspace.source_kind !== "native" && workspace.source_kind !== "legacy")) {
        return { ok: false, error: "phase validation requires a native or verified migrated workspace", state };
      }
      const nativeValidationError = nativePreparationValidationError(state, transactionRoot, input);
      if (nativeValidationError) return { ok: false, error: nativeValidationError, state };
      if (state.stage_cursor !== input.stage_cursor || cap.issued_for.stage_cursor !== input.stage_cursor || cap.issued_for.run_key !== input.run_key
        || state.cursor_epoch !== cap.issued_for.cursor_epoch || state.run_key !== cap.issued_for.run_key || state.branch !== cap.issued_for.branch
        || state.classification.workflow !== cap.issued_for.workflow || workspace.profile_name !== input.workflow
        || (workspace.profile_hash !== input.profile_hash && !profileHashMatches(workspace.profile_hash, input.profile_hash))) {
        return { ok: false, error: "validation dispatch stage is stale for the selected workflow", state };
      }
      const phase = workspace.phases.find((candidate) => candidate.phase === input.stage_cursor);
      if (!phase || phase.status !== "materialized" || phase.current_version === null || phase.current_version < 1) {
        return { ok: false, error: "phase validation dispatch requires a current materialized phase version", state };
      }
      const artifactPath = join(".work-state", "features", input.feature_id, "artifacts", input.stage_cursor + ".v" + phase.current_version + ".json");
      const artifactEntry = pinnedRoot.pathEntryInfo(artifactPath);
      const artifact = readCanonicalPhaseArtifact(pinnedRoot.canonical_root, {
        feature_id: input.feature_id,
        run_key: input.run_key,
        phase: phase.phase,
        version: phase.current_version,
      }, pinnedRoot);
      if (
        !artifact
        || !artifactEntry
        || artifactEntry.kind !== "file"
        || !Number.isSafeInteger(artifactEntry.size)
        || artifactEntry.size < 0
        || artifactEntry.size > MAX_COMPLETION_ARTIFACT_PAYLOAD_BYTES
        || !pinnedRoot.isStable()
      ) {
        return { ok: false, error: "phase validation dispatch requires the current immutable phase artifact", state };
      }
      const constitutionError = phaseConstitutionError(pinnedRoot, workspace, artifact);
      if (constitutionError) return { ok: false, error: constitutionError, state };
      preCommitConstitutionGuard = () => {
        const latestError = phaseConstitutionError(transactionRoot, workspace, artifact);
        if (latestError) throw new Error(latestError);
      };
      const latestValidation = [...cap.dispatches].reverse().find((record) => record.purpose === "validation");
      if (input.retry_of !== undefined) {
        if (!latestValidation || latestValidation.id !== input.retry_of || (latestValidation.status !== "failed" && latestValidation.status !== "cancelled") || latestValidation.phase_version !== phase.current_version) {
          return { ok: false, error: "validation retry must link the latest failed validator dispatch for the current immutable phase version", state };
        }
      } else if (latestValidation) {
        return { ok: false, error: "validation dispatch already has a terminal attempt; retry requires retry_of", state };
      }
      let issued: IssuedCapability;
      let validationSeed: TeamState;
      if (latestValidation) {
        const reissued = reissueActiveCapability(cap, rosterPolicyHash(loadProfile(input.workflow)?.stages.find((candidate) => candidate.id === input.stage_cursor)));
        issued = reissued;
        validationSeed = { ...state, stage_cursor: input.stage_cursor, cursor_epoch: reissued.state.issued_for!.cursor_epoch, dispatch_capability: { ...reissued.state, status: "dispatched" } };
      } else {
        const validationLedger = validationCapabilityLedger(cap);
        const policyHash = rosterPolicyHash(loadProfile(input.workflow)?.stages.find((candidate) => candidate.id === input.stage_cursor));
        issued = createCapability({
          run_key: cap.issued_for.run_key,
          branch: cap.issued_for.branch,
          workflow: cap.issued_for.workflow,
          profile_hash: cap.issued_for.profile_hash,
          stage_cursor: input.stage_cursor,
          kind: validationLedger.kind,
          expected_roster: validationLedger.expected_roster,
          dispatches: validationLedger.dispatches,
          ...(policyHash === undefined ? {} : { policy_hash: policyHash }),
        });
        validationSeed = { ...state, stage_cursor: input.stage_cursor, cursor_epoch: issued.state.issued_for!.cursor_epoch, dispatch_capability: issued.state };
      }
      const validationCap = activeCapability(validationSeed.dispatch_capability);
      if (!validationCap) return { ok: false, error: "validation capability could not be initialized", state };
      const authorized = authorizeBoundRecord(cwd, validationSeed, target, validationCap, {
        ...input,
        role: "validator",
        slot_id: "validator",
        agent: "validator",
        tool_call_id: input.request_id,
        phase_version: phase.current_version,
      }, "validation");
      if (!authorized.ok || !authorized.record?.work_identity) return { ok: false, error: authorized.ok ? "validation dispatch produced no work identity" : authorized.error, state };
      consumeProof = options.trustedMappingProof !== undefined;
      return {
        ok: true,
        state: authorized.state ?? validationSeed,
        record: authorized.record,
        work_identity: authorized.record.work_identity,
        capability_epoch: authorized.record.work_identity.capability_epoch,
        capability_id: issued.capability_id,
        dispatch_token: issued.dispatch_token,
        advance_token: issued.advance_token,
      };
    }, {
      pinnedRoot,
      preCommit: () => { preCommitConstitutionGuard?.(); },
      postCommit: () => { if (consumeProof) consumeTrustedMappingProof(options.trustedMappingProof); },
    });
  } finally {
    pinnedRoot.close();
  }
}


export type NativeSpecificationValidationObservationInput = {
  feature_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  phase: "specify" | "plan" | "tasks";
  version: number;
  capability_id: string;
  generation_dispatch_id: string;
  request_id: string;
};

export type NativeSpecificationValidationObservation =
  | {
    ok: true;
    status: "authorized" | "running" | "pending";
    state: TeamState;
    record: DispatchRecord;
    capability_id: string;
    dispatch_token: string;
    advance_token: string;
    capability_epoch: string;
    phase_version: number;
  }
  | {
    ok: true;
    status: "succeeded";
    state: TeamState;
    record: DispatchRecord;
    completion: DispatchCompletion;
    completion_envelope?: CompletionEnvelope;
    capability_id: string;
    capability_epoch: string;
    phase_version: number;
  }
  | {
    ok: false;
    code: "not_found" | "failed" | "mismatch" | "stale";
    error: string;
    state?: TeamState;
  };

type NativeValidatorSelection = { record?: DispatchRecord; error?: string };

function exactNativeValidatorRecord(
  record: DispatchRecord,
  capability: ActiveCapability,
  binding: ActiveCapability["issued_for"],
  phase: "specify" | "plan" | "tasks",
  version: number,
  requestId: string,
): boolean {
  return record.phase_version === version
    && record.tool_call_id === requestId
    && record.role === "validator"
    && record.agent === "validator"
    && record.work_identity?.run_id === binding.run_key
    && record.work_identity?.workflow === binding.workflow
    && record.work_identity?.stage_id === phase
    && record.work_identity?.stage_cursor === phase
    && record.work_identity?.capability_id === capability.capability_id
    && record.work_identity?.capability_epoch === binding.cursor_epoch
    && record.work_identity?.dispatch_id === record.id
    && record.work_identity?.attempt === record.attempt;
}

function selectNativeValidatorRecord(
  capability: ActiveCapability,
  phase: "specify" | "plan" | "tasks",
  version: number,
  requestId: string,
): NativeValidatorSelection {
  const binding = capability.issued_for;
  const validators = capability.dispatches.filter((record) => record.purpose === "validation");
  if (validators.some((record) => !exactNativeValidatorRecord(record, capability, binding, phase, version, requestId))) {
    return { error: "native validator dispatch is not bound to the exact current phase, artifact, and request" };
  }
  const record = validators.reduce<DispatchRecord | undefined>(
    (latest, candidate) => latest === undefined || candidate.attempt >= latest.attempt ? candidate : latest,
    undefined,
  );
  return { record };
}

function nativeValidatorSuccessPostimageError(
  record: DispatchRecord,
  artifact: PersistedPhaseResultEnvelope,
  validation: Record<string, unknown> | null,
  binding: ActiveCapability["issued_for"],
  phase: "specify" | "plan" | "tasks",
  pinnedRoot: PinnedProjectRoot,
): string | null {
  const expectedEvidence = "phase '" + phase + "' validation passed for '" + artifact.artifact_id + "'";
  if (record.status !== "succeeded"
    || !record.work_identity
    || record.work_identity.run_id !== binding.run_key
    || record.work_identity.workflow !== binding.workflow
    || record.work_identity.stage_id !== phase
    || record.work_identity.stage_cursor !== phase
    || record.work_identity.capability_epoch !== binding.cursor_epoch
    || record.work_identity.dispatch_id !== record.id
    || record.work_identity.attempt !== record.attempt
    || !record.completion
    || record.completion.outcome !== "succeeded"
    || record.completion.dispatch_id !== record.id
    || record.completion.cursor_epoch !== binding.cursor_epoch
    || !sameIdentity(record.completion.work_identity, record.work_identity)
    || record.completion.evidence !== expectedEvidence
    || record.completion.artifact_ids.length !== 0
    || !record.completion_envelope
    || record.completion_envelope.outcome !== "succeeded"
    || !sameIdentity(record.completion_envelope.identity, record.work_identity)
    || record.completion_envelope.artifact_refs.length !== 0
    || !validation
    || validation.status !== "pass"
    || !deterministicValidationMatchesArtifact(artifact, validation, pinnedRoot)) {
    return "native validator terminal postimage is stale or not bound to the current artifact";
  }
  return null;
}

/***
 * Observe or safely resume one exact native validator postimage. This helper
 * never creates a dispatch: active validator records receive a fresh bearer
 * for the existing capability/dispatch, while succeeded records return their
 * persisted completion envelope for finalizer replay. Every identity and
 * current-root/config/mapping binding is checked before any bearer is issued.
 */
export function observeNativeSpecificationValidation(
  cwd: string,
  input: NativeSpecificationValidationObservationInput,
  options: { pinnedRoot?: PinnedProjectRoot; trustedMappingProof?: TrustedMappingProof } = {},
): NativeSpecificationValidationObservation {
  if (!isSafeStateSegment(input.feature_id) || !input.run_key.trim() || !input.branch.trim() || !input.workflow.trim() || !input.profile_hash.trim() || !input.request_id.trim() || !Number.isSafeInteger(input.version) || input.version < 1 || !input.capability_id.trim() || !input.generation_dispatch_id.trim()) {
    return { ok: false, code: "mismatch", error: "native validator observation input is malformed" };
  }
  const suppliedPinnedRoot = options.pinnedRoot;
  const pinnedRoot = suppliedPinnedRoot ?? PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return { ok: false, code: "stale", error: "project root cannot be pinned for native validator observation" };
  let consumeProof = false;
  try {
    type Transaction = NativeSpecificationValidationObservation;
    const result = runDurableTransaction<Transaction>(cwd, input, (state, _target, transactionRoot) => {
      const cap = activeCapability(state.dispatch_capability);
      if (!cap) return { ok: false, code: "stale", error: "dispatch capability unavailable", state };
      const binding = cap.issued_for;
      const stateBindingError = stateCapabilityBindingError(state, cap, transactionRoot, input.feature_id);
      if (stateBindingError) return { ok: false, code: "mismatch", error: stateBindingError, state };
      if (cap.capability_id !== input.capability_id
        || binding.run_key !== input.run_key
        || binding.branch !== input.branch
        || binding.workflow !== input.workflow
        || !profileHashMatches(binding.profile_hash, input.profile_hash)
        || binding.stage_cursor !== input.phase
        || state.run_key !== input.run_key
        || state.branch !== input.branch
        || state.stage_cursor !== input.phase) {
        return { ok: false, code: "mismatch", error: "native validator observation capability binding mismatch", state };
      }
      const mappingError = rosterMappingProofError(cwd, state, cap, transactionRoot, options.trustedMappingProof);
      if (mappingError) return { ok: false, code: "stale", error: mappingError, state };
      const profile = loadProfile(binding.workflow);
      const stage = profile?.stages.find((candidate) => candidate.id === input.phase);
      if (!profile || !stage || !stage.roster_policy) return { ok: false, code: "stale", error: "native validator observation workflow stage is unavailable or not rostered", state };
      const workspace = state.specification;
      const phase = workspace?.phases.find((candidate) => candidate.phase === input.phase);
      if (!workspace || workspace.source_kind !== "native" || workspace.feature_id !== input.feature_id
        || workspace.profile_name !== input.workflow
        || workspace.project_root !== transactionRoot.canonical_root
        || workspace.project_root_identity.canonical_path !== transactionRoot.canonical_root
        || workspace.project_root_identity.dev !== transactionRoot.dev
        || workspace.project_root_identity.ino !== transactionRoot.ino
        || !phase || phase.current_version !== input.version || !["materialized", "validating", "awaiting_approval"].includes(phase.status)) {
        return { ok: false, code: "stale", error: "native validator observation workspace or phase version is stale", state };
      }
      const generation = cap.dispatches.find((record) => record.id === input.generation_dispatch_id && (record.purpose ?? "generation") === "generation");
      const phaseArtifact = readCanonicalPhaseArtifact(transactionRoot.canonical_root, {
        feature_id: input.feature_id,
        run_key: input.run_key,
        phase: input.phase,
        version: input.version,
      }, transactionRoot);
      if ((generation && generation.status !== "succeeded") || (!generation && phaseArtifact?.dispatch_id !== input.generation_dispatch_id)) {
        return { ok: false, code: "stale", error: "native validator generation postimage is missing or stale", state };
      }
      const validatorSelection = selectNativeValidatorRecord(cap, input.phase, input.version, input.request_id);
      if (validatorSelection.error) return { ok: false, code: "mismatch", error: validatorSelection.error, state };
      const record = validatorSelection.record;
      if (!record) return { ok: false, code: "not_found", error: "exact native validator dispatch is not persisted", state };
      if (!record.work_identity || record.work_identity.run_id !== binding.run_key || record.work_identity.workflow !== binding.workflow || record.work_identity.stage_id !== input.phase || record.work_identity.stage_cursor !== input.phase || record.work_identity.dispatch_id !== record.id || record.work_identity.attempt !== record.attempt) {
        return { ok: false, code: "stale", error: "native validator dispatch identity is stale", state };
      }
      if (record.status === "succeeded") {
        if (!record.completion || record.completion.outcome !== "succeeded" || !record.completion_envelope) {
          return { ok: false, code: "stale", error: "native validator success receipt is incomplete", state };
        }
        return { ok: true, status: "succeeded", state, record, completion: record.completion, completion_envelope: record.completion_envelope, capability_id: cap.capability_id, capability_epoch: binding.cursor_epoch, phase_version: input.version };
      }
      if (record.status === "failed" || record.status === "cancelled") {
        return { ok: false, code: "failed", error: "native validator dispatch is terminal without a successful receipt", state };
      }
      if (record.status !== "authorized" && record.status !== "running" && record.status !== "pending") {
        return { ok: false, code: "stale", error: "native validator dispatch has an unsupported persisted status", state };
      }
      const reissued = reissueActiveCapability(cap, rosterPolicyHash(loadProfile(input.workflow)?.stages.find((candidate) => candidate.id === input.phase)));
      const nextState: TeamState = { ...state, dispatch_capability: reissued.state, updated_at: now() };
      consumeProof = options.trustedMappingProof !== undefined;
      return { ok: true, status: record.status, state: nextState, record, capability_id: reissued.capability_id, dispatch_token: reissued.dispatch_token, advance_token: reissued.advance_token, capability_epoch: reissued.state.issued_for!.cursor_epoch, phase_version: input.version };
    }, {
      pinnedRoot,
      postCommit: () => { if (consumeProof) consumeTrustedMappingProof(options.trustedMappingProof); },
    });
    return result;
  } finally {
    if (!suppliedPinnedRoot) pinnedRoot.close();
  }
}


export type NativeSpecificationValidationResumeInput = NativeSpecificationValidationObservationInput & {
  generation: PersistedStagePostimage & {
    dispatch_id: string;
    role: string;
    agent: string;
    slot_id?: string;
    task_id?: string;
    work_identity?: WorkIdentity;
  };
  generation_artifact_ids: string[];
  generation_evidence: string;
};

/**
 * Recover the crash window between immutable phase materialization and
 * generation completion. The exact persisted generation dispatch is completed
 * in this transaction (never reissued or duplicated), then one validator is
 * issued or an existing exact validator is observed/reissued.
 */
export function resumeNativeSpecificationValidationFromPersisted(
  cwd: string,
  input: NativeSpecificationValidationResumeInput,
  options: { pinnedRoot?: PinnedProjectRoot; trustedMappingProof?: TrustedMappingProof } = {},
): NativeSpecificationValidationObservation {
  const generationEvidenceError = workflowCompletionInputError({ evidence: input.generation_evidence });
  if (generationEvidenceError) return { ok: false, code: "mismatch", error: generationEvidenceError };
  if (!Array.isArray(input.generation_artifact_ids) || input.generation_artifact_ids.length === 0 || !input.generation_evidence.trim()) {
    return { ok: false, code: "mismatch", error: "persisted native generation result is missing bounded artifacts or evidence" };
  }
  const expectedValidationRequestId = "native-validation-" + input.phase + "-" + input.feature_id + "-" + input.version;
  if (input.request_id !== expectedValidationRequestId) {
    return { ok: false, code: "mismatch", error: "native validator request is not bound to the exact phase artifact" };
  }
  const suppliedPinnedRoot = options.pinnedRoot;
  const pinnedRoot = suppliedPinnedRoot ?? PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return { ok: false, code: "stale", error: "project root cannot be pinned for native validator resume" };
  let consumeProof = false;
  try {
    type Transaction = NativeSpecificationValidationObservation;
    const result = runDurableTransaction<Transaction>(cwd, input, (rawState, target, transactionRoot) => {
      const cap = activeCapability(rawState.dispatch_capability);
      if (!cap) return { ok: false, code: "stale", error: "dispatch capability unavailable", state: rawState };
      const binding = cap.issued_for;
      const stateBindingError = stateCapabilityBindingError(rawState, cap, transactionRoot, input.feature_id);
      if (stateBindingError) return { ok: false, code: "mismatch", error: stateBindingError, state: rawState };
      if (cap.capability_id !== input.capability_id || binding.run_key !== input.run_key || binding.branch !== input.branch || binding.workflow !== input.workflow || !profileHashMatches(binding.profile_hash, input.profile_hash) || binding.stage_cursor !== input.phase || rawState.run_key !== input.run_key || rawState.branch !== input.branch || rawState.stage_cursor !== input.phase) {
        return { ok: false, code: "mismatch", error: "native validator resume capability binding mismatch", state: rawState };
      }
      const mappingError = rosterMappingProofError(cwd, rawState, cap, transactionRoot, options.trustedMappingProof);
      if (mappingError) return { ok: false, code: "stale", error: mappingError, state: rawState };
      const profile = loadProfile(binding.workflow);
      const stage = profile?.stages.find((candidate) => candidate.id === input.phase);
      const workspace = rawState.specification;
      const phase = workspace?.phases.find((candidate) => candidate.phase === input.phase);
      if (!profile || !stage?.roster_policy || !workspace || workspace.source_kind !== "native" || workspace.feature_id !== input.feature_id || workspace.profile_name !== input.workflow || workspace.project_root !== transactionRoot.canonical_root || workspace.project_root_identity.canonical_path !== transactionRoot.canonical_root || workspace.project_root_identity.dev !== transactionRoot.dev || workspace.project_root_identity.ino !== transactionRoot.ino || !phase || phase.current_version !== input.version || !["materialized", "validating", "awaiting_approval"].includes(phase.status)) {
        return { ok: false, code: "stale", error: "native validator resume workspace or phase version is stale", state: rawState };
      }
      const artifact = readCanonicalPhaseArtifact(transactionRoot.canonical_root, { feature_id: input.feature_id, run_key: input.run_key, phase: input.phase, version: input.version }, transactionRoot);
      if (!artifact || artifact.dispatch_id !== input.generation_dispatch_id || artifact.version !== input.version || artifact.feature_id !== input.feature_id || artifact.run_key !== input.run_key) {
        return { ok: false, code: "stale", error: "persisted native phase result does not bind the exact generation dispatch/version", state: rawState };
      }
      const generationArtifacts = stageProduces(stage);
      if (canonicalJson(input.generation_artifact_ids) !== canonicalJson(generationArtifacts)
        || !generationArtifacts.includes(artifact.source_artifact_id)) {
        return { ok: false, code: "mismatch", error: "persisted native generation artifacts do not match the exact current phase outputs", state: rawState };
      }
      const generation = cap.dispatches.find((record) => record.id === input.generation_dispatch_id && (record.purpose ?? "generation") === "generation");
      if (!generation?.work_identity || !generation.tool_call_id || !artifact.work_identity || !sameIdentity(artifact.work_identity, generation.work_identity)) {
        return { ok: false, code: "stale", error: "persisted native phase result does not bind the exact generation work identity", state: rawState };
      }
      const generationInput = input.generation;
      if (!generationInput.work_identity
        || generationInput.feature_id !== input.feature_id
        || generationInput.capability_id !== generation.work_identity.capability_id
        || generationInput.run_key !== generation.work_identity.run_id
        || generationInput.branch !== binding.branch
        || generationInput.workflow !== generation.work_identity.workflow
        || generationInput.profile_hash !== binding.profile_hash
        || generationInput.stage_cursor !== generation.work_identity.stage_id
        || generationInput.cursor_epoch !== generation.work_identity.capability_epoch
        || generationInput.dispatch_id !== generation.id
        || generationInput.role !== generation.role
        || generationInput.agent !== generation.agent
        || generationInput.slot_id !== generation.work_identity.slot_id
        || generationInput.task_id !== generation.work_identity.task_id
        || generationInput.work_identity.attempt !== generation.attempt
        || generationInput.tool_call_id !== generation.tool_call_id
        || !sameIdentity(generationInput.work_identity, generation.work_identity)) {
        return { ok: false, code: "mismatch", error: "persisted native generation postimage does not match the exact current dispatch identity", state: rawState };
      }
      const validatorSelection = selectNativeValidatorRecord(cap, input.phase, input.version, input.request_id);
      if (validatorSelection.error) return { ok: false, code: "mismatch", error: validatorSelection.error, state: rawState };
      const existing = validatorSelection.record;
      if (existing?.status === "failed" || existing?.status === "cancelled") {
        return { ok: false, code: "failed", error: "native validator dispatch is terminal without a successful receipt", state: rawState };
      }
      if (existing?.status === "succeeded") {
        const validation = readArtifactPinned<Record<string, unknown>>(
          transactionRoot,
          join(".work-state", "features", input.feature_id, "artifacts"),
          "validation." + input.phase + ".v" + input.version,
        );
        const expectedEvidence = "phase '" + input.phase + "' validation passed for '" + artifact.artifact_id + "'";
        if (generation.status !== "succeeded"
          || !generation.completion
          || generation.completion.outcome !== "succeeded"
          || !existing.completion
          || existing.completion.outcome !== "succeeded"
          || existing.completion.dispatch_id !== existing.id
          || existing.completion.cursor_epoch !== binding.cursor_epoch
          || !sameIdentity(existing.completion.work_identity, existing.work_identity)
          || !existing.completion_envelope
          || existing.completion_envelope.outcome !== "succeeded"
          || !sameIdentity(existing.completion_envelope.identity, existing.work_identity)
          || existing.completion.evidence !== expectedEvidence
          || !validation
          || validation.status !== "pass"
          || !deterministicValidationMatchesArtifact(artifact, validation, transactionRoot)) {
          return { ok: false, code: "stale", error: "native validator terminal postimage is stale or not bound to the current artifact", state: rawState };
        }
      }
      const reconciliation = generation.pending?.reconciliation;
      if (reconciliation) {
        if (reconciliation.outcome === "failed" || reconciliation.outcome === "cancelled") {
          return { ok: false, code: "failed", error: "native generation reconciliation is terminal without a successful result", state: rawState };
        }
        const expectedReconciliationDigest = nativeReconciliationDigest(
          generation.work_identity!,
          reconciliation.outcome,
          input.generation_evidence,
          input.generation_artifact_ids,
          reconciliation.terminal_signal,
          reconciliation.provider_id,
        );
        if (reconciliation.outcome !== "succeeded"
          || !sameIdentity(reconciliation.identity, generation.work_identity)
          || canonicalJson(reconciliation.artifact_ids) !== canonicalJson(input.generation_artifact_ids)
          || reconciliation.evidence !== input.generation_evidence
          || reconciliation.result_digest !== expectedReconciliationDigest) {
          return { ok: false, code: "mismatch", error: "native generation reconciliation does not match the exact worker result postimage", state: rawState };
        }
        if (generation.completion && (generation.completion.outcome !== "succeeded"
          || canonicalJson(generation.completion.artifact_ids) !== canonicalJson(input.generation_artifact_ids)
          || generation.completion.evidence !== input.generation_evidence
          || !sameIdentity(generation.completion.work_identity, generation.work_identity))) {
          return { ok: false, code: "mismatch", error: "native generation completion conflicts with its reconciliation postimage", state: rawState };
        }
      }
      if (generation && generation.status !== "succeeded" && (generation.status === "failed" || generation.status === "cancelled")) {
        return { ok: false, code: "failed", error: "native generation dispatch is terminal without a successful result", state: rawState };
      }
      let state = rawState;
      let currentCap = cap;
      let generationRecord = generation;
      if (generationRecord && generationRecord.status !== "succeeded") {
        if (!generationRecord.work_identity || generationRecord.work_identity.capability_id !== currentCap.capability_id || generationRecord.work_identity.capability_epoch !== currentCap.issued_for.cursor_epoch) {
          return { ok: false, code: "stale", error: "native generation dispatch identity is stale", state: rawState };
        }
        if (input.generation.dispatch_id !== generationRecord.id || input.generation.role !== generationRecord.role || input.generation.agent !== generationRecord.agent || (input.generation.slot_id !== undefined && input.generation.slot_id !== generationRecord.work_identity.slot_id) || (input.generation.task_id !== undefined && input.generation.task_id !== generationRecord.work_identity.task_id)) {
          return { ok: false, code: "mismatch", error: "persisted native generation postimage does not match the exact dispatch", state: rawState };
        }
        if ((input.generation.config_hash && rawState.config_hash && input.generation.config_hash !== rawState.config_hash)
          || (input.generation.policy_hash && currentCap.policy_hash && input.generation.policy_hash !== currentCap.policy_hash)) {
          return { ok: false, code: "stale", error: "persisted native generation configuration or policy is stale", state: rawState };
        }
        const completed = completeRecord(cwd, rawState, target, transactionRoot, currentCap, generationRecord, {
          outcome: "succeeded",
          artifact_ids: input.generation_artifact_ids,
          evidence: input.generation_evidence,
          completed_by: "engine_task_caller",
        }, () => {
          const constitutionError = workspaceConstitutionError(transactionRoot, workspace);
          if (constitutionError) throw new Error(constitutionError);
        });
        if (!completed.ok || !completed.state) return { ok: false, code: "stale", error: completed.ok ? "native generation completion produced no state" : completed.error, state: rawState };
        state = completed.state;
        currentCap = activeCapability(state.dispatch_capability) ?? currentCap;
        generationRecord = currentCap.dispatches.find((record) => record.id === input.generation_dispatch_id);
      }
      if (generationRecord && generationRecord.status !== "succeeded") return { ok: false, code: "stale", error: "native generation completion did not produce a succeeded postimage", state };
      if (existing?.status === "succeeded") {
        if (!existing.completion || existing.completion.outcome !== "succeeded" || !existing.completion_envelope) return { ok: false, code: "stale", error: "native validator success receipt is incomplete", state };
        return { ok: true, status: "succeeded", state, record: existing, completion: existing.completion, completion_envelope: existing.completion_envelope, capability_id: currentCap.capability_id, capability_epoch: currentCap.issued_for.cursor_epoch, phase_version: input.version };
      }
      if (existing && (existing.status === "failed" || existing.status === "cancelled")) return { ok: false, code: "failed", error: "native validator dispatch is terminal without a successful receipt", state };
      if (existing) {
        if (existing.status !== "authorized" && existing.status !== "running" && existing.status !== "pending") return { ok: false, code: "stale", error: "native validator dispatch has an unsupported persisted status", state };
        const reissued = reissueActiveCapability(currentCap, rosterPolicyHash(loadProfile(input.workflow)?.stages.find((candidate) => candidate.id === input.phase)));
        const nextState: TeamState = { ...state, dispatch_capability: reissued.state, updated_at: now() };
        consumeProof = options.trustedMappingProof !== undefined;
        return { ok: true, status: existing.status, state: nextState, record: existing, capability_id: reissued.capability_id, dispatch_token: reissued.dispatch_token, advance_token: reissued.advance_token, capability_epoch: reissued.state.issued_for!.cursor_epoch, phase_version: input.version };
      }
      const validationLedger = validationCapabilityLedger(currentCap);
      const issued = createCapability({
        run_key: currentCap.issued_for.run_key,
        branch: currentCap.issued_for.branch,
        workflow: currentCap.issued_for.workflow,
        profile_hash: currentCap.issued_for.profile_hash,
        stage_cursor: input.phase,
        kind: validationLedger.kind,
        expected_roster: validationLedger.expected_roster,
        dispatches: validationLedger.dispatches,
        ...(() => {
          const policyHash = currentCap.policy_hash ?? rosterPolicyHash(loadProfile(input.workflow)?.stages.find((candidate) => candidate.id === input.phase));
          return policyHash === undefined ? {} : { policy_hash: policyHash };
        })(),
      });
      const validationSeed: TeamState = { ...state, stage_cursor: input.phase, cursor_epoch: issued.state.issued_for!.cursor_epoch, dispatch_capability: issued.state };
      const validationCap = activeCapability(validationSeed.dispatch_capability);
      if (!validationCap) return { ok: false, code: "stale", error: "native validator capability could not be initialized", state };
      const authorized = authorizeBoundRecord(cwd, validationSeed, target, validationCap, { token: "__persisted_stage_postimage__", capability_id: issued.capability_id, feature_id: input.feature_id, run_key: input.run_key, branch: input.branch, workflow: input.workflow, profile_hash: input.profile_hash, stage_cursor: input.phase, cursor_epoch: validationCap.issued_for.cursor_epoch, role: "validator", slot_id: "validator", agent: "validator", tool_call_id: input.request_id, phase_version: input.version }, "validation");
      if (!authorized.ok || !authorized.state || !authorized.record?.work_identity) return { ok: false, code: "stale", error: authorized.ok ? "native validator dispatch produced no identity" : authorized.error, state };
      consumeProof = options.trustedMappingProof !== undefined;
      return { ok: true, status: "authorized", state: authorized.state, record: authorized.record, capability_id: issued.capability_id, dispatch_token: issued.dispatch_token, advance_token: issued.advance_token, capability_epoch: issued.state.issued_for!.cursor_epoch, phase_version: input.version };
    }, {
      pinnedRoot,
      postCommit: () => { if (consumeProof) consumeTrustedMappingProof(options.trustedMappingProof); },
    });
    return result;
  } finally {
    if (!suppliedPinnedRoot) pinnedRoot.close();
  }
}


/**
 * Reissue only the hashed capability bearer needed to reopen a native phase
 * checkpoint after a process crash. The immutable generation and validator
 * dispatch postimages remain authoritative; no new work is spawned and no
 * validation attempt is created.
 */
export type NativeSpecificationCheckpointCapabilityResult =
  | { ok: true; state: TeamState; capability_id: string; advance_token: string; cursor_epoch: string }
  | { ok: false; error: string; state?: TeamState; code?: "NATIVE_COMPOSITE_REQUIRED" };

function nativePreparationStartExpectedRoster(capability: ActiveCapability): Array<{ role: string; agent: string }> {
  const latestByRole = new Map<string, DispatchRecord>();
  for (const record of capability.dispatches) {
    if ((record.purpose ?? "generation") !== "generation") continue;
    const prior = latestByRole.get(record.role);
    if (!prior || record.attempt > prior.attempt) latestByRole.set(record.role, record);
  }
  return [...latestByRole.values()]
    .sort((left, right) => left.attempt - right.attempt || left.created_at.localeCompare(right.created_at))
    .map((record) => ({ role: record.role, agent: record.agent }));
}

function nativePreparationStartSnapshotDigest(state: TeamState, capability: ActiveCapability, marker: NativePreparationStartMarker, generation: DispatchRecord): string {
  const originalGeneration: DispatchRecord = {
    ...generation,
    status: "authorized",
    completed_at: undefined,
    completion: undefined,
    pending: undefined,
    completion_envelope: undefined,
  };
  const originalCapability: ActiveCapability = {
    ...capability,
    capability_id: marker.capability_id,
    status: "dispatched",
    expected_roster: nativePreparationStartExpectedRoster(capability),
    dispatches: capability.dispatches
      .filter((record) => (record.purpose ?? "generation") === "generation")
      .map((record) => record.id === marker.dispatch_id ? originalGeneration : record),
  };
  return preparationStartPostimageDigest({ ...state, dispatch_capability: originalCapability });
}

export function reissueNativeSpecificationCheckpointCapability(
  cwd: string,
  input: {
    feature_id: string;
    run_key: string;
    branch: string;
    workflow: TeamState["classification"]["workflow"];
    profile_hash: string;
    phase: "specify" | "plan" | "tasks";
    version: number;
    capability_id: string;
    generation_dispatch_id: string;
  },
): NativeSpecificationCheckpointCapabilityResult {
  let preCommitConstitutionGuard: (() => void) | undefined;
  return runDurableTransaction<NativeSpecificationCheckpointCapabilityResult>(cwd, input, (state, target, pinnedRoot) => {
    const cap = activeCapability(state.dispatch_capability);
    if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
    const stateBindingError = stateCapabilityBindingError(state, cap, pinnedRoot, input.feature_id);
    if (stateBindingError) return { ok: false, code: "NATIVE_COMPOSITE_REQUIRED", error: `NATIVE_COMPOSITE_REQUIRED: ${stateBindingError}`, state };
    const binding = cap.issued_for;
    if (input.capability_id !== cap.capability_id
      || input.run_key !== binding.run_key
      || input.branch !== binding.branch
      || input.workflow !== binding.workflow
      || !profileHashMatches(binding.profile_hash, input.profile_hash)
      || input.phase !== binding.stage_cursor
      || state.run_key !== input.run_key
      || state.branch !== input.branch
      || state.stage_cursor !== input.phase
      || state.cursor_epoch !== binding.cursor_epoch) {
      return { ok: false, error: "checkpoint capability binding mismatch", state };
    }
    const workspace = state.specification;
    const phase = workspace?.phases.find((candidate) => candidate.phase === input.phase);
    const handoff = state.preparation_handoff;
    const marker = state.preparation_start;
    const generationMarker = marker
      ? cap.dispatches.find((record) => record.id === marker.dispatch_id && (record.purpose ?? "generation") === "generation")
      : undefined;
    const generation = cap.dispatches.find((record) => record.id === input.generation_dispatch_id && (record.purpose ?? "generation") === "generation");
    const validatorRequestId = "native-validation-" + input.phase + "-" + input.feature_id + "-" + input.version;
    const validatorSelection = selectNativeValidatorRecord(cap, input.phase, input.version, validatorRequestId);
    const validatorPostimage = validatorSelection.record;
    const originalExpectedRoster = nativePreparationStartExpectedRoster(cap);
    if (!handoff || !verifyPreparationHandoffDigest(handoff) || !verifyPreparationHandoffAuth(pinnedRoot, handoff)
      || handoff.source_kind !== "native" || handoff.feature_id !== input.feature_id || handoff.run_key !== input.run_key
      || handoff.branch !== input.branch || handoff.classification.workflow !== input.workflow) {
      return { ok: false, code: "NATIVE_COMPOSITE_REQUIRED", error: "NATIVE_COMPOSITE_REQUIRED: native checkpoint reissue requires the exact authenticated preparation_handoff", state };
    }
    if (!marker || marker.status !== "started" || marker.phase !== input.phase
      || marker.token !== handoff.token || marker.preparation_digest !== handoff.digest
      || marker.preparation_state_revision !== handoff.state_revision
      || marker.capability_id !== generationMarker?.work_identity?.capability_id
      || marker.capability_epoch !== generationMarker?.work_identity?.capability_epoch
      || !marker.expected_roster
      || canonicalJson(marker.expected_roster) !== canonicalJson(originalExpectedRoster)
      || marker.profile_hash !== input.profile_hash
      || (marker.policy_hash !== undefined && marker.policy_hash !== cap.policy_hash)) {
      return { ok: false, code: "NATIVE_COMPOSITE_REQUIRED", error: "NATIVE_COMPOSITE_REQUIRED: native checkpoint reissue requires the exact composite start marker", state };
    }
    const originalPreparationDigest = generation
      ? nativePreparationStartSnapshotDigest(state, cap, marker, generation)
      : null;
    if (!generationMarker || !generation
      || generation.id !== marker.dispatch_id
      || generation.id !== input.generation_dispatch_id
      || generationMarker.id !== generation.id
      || generationMarker.tool_call_id !== marker.request_id
      || !originalExpectedRoster.some((entry) => entry.role === generation?.role && entry.agent === generation?.agent)
      || generationMarker.status !== "succeeded"
      || generation.status !== "succeeded"
      || !generationMarker.work_identity
      || !generation.work_identity
      || generation.work_identity.run_id !== input.run_key
      || generation.work_identity.workflow !== input.workflow
      || generation.work_identity.stage_id !== input.phase
      || generation.work_identity.stage_cursor !== input.phase
      || generation.work_identity.capability_id !== marker.capability_id
      || generation.work_identity.capability_epoch !== marker.capability_epoch
      || generation.work_identity.dispatch_id !== generation.id
      || generation.work_identity.attempt !== generation.attempt
      || !generationMarker.completion || generationMarker.completion.outcome !== "succeeded"
      || !generation.completion || generation.completion.outcome !== "succeeded"
      || canonicalJson(generation.completion.work_identity) !== canonicalJson(generation.work_identity)
      || !generation.completion_envelope
      || generation.completion_envelope.outcome !== "succeeded"
      || canonicalJson(generation.completion_envelope.identity) !== canonicalJson(generation.work_identity)
      || !generationMarker.completion.evidence.includes(`${input.phase}.v${input.version}`)
      || !generation.completion.evidence.includes(`${input.phase}.v${input.version}`)
      || !validatorPostimage || validatorPostimage.status !== "succeeded"
      || !validatorPostimage.completion || validatorPostimage.completion.outcome !== "succeeded"
      || !validatorPostimage.work_identity
      || validatorPostimage.work_identity.run_id !== binding.run_key
      || validatorPostimage.work_identity.workflow !== binding.workflow
      || validatorPostimage.work_identity.stage_id !== input.phase
      || validatorPostimage.work_identity.stage_cursor !== input.phase
      || validatorPostimage.work_identity.attempt !== validatorPostimage.attempt
      || validatorPostimage.work_identity.capability_id !== cap.capability_id
      || validatorPostimage.work_identity.capability_epoch !== cap.issued_for.cursor_epoch
      || validatorPostimage.work_identity.dispatch_id !== validatorPostimage.id
      || canonicalJson(validatorPostimage.completion.work_identity) !== canonicalJson(validatorPostimage.work_identity)
      || !validatorPostimage.completion_envelope
      || validatorPostimage.completion_envelope.outcome !== "succeeded"
      || canonicalJson(validatorPostimage.completion_envelope.identity) !== canonicalJson(validatorPostimage.work_identity)
      || marker.start_postimage_digest !== originalPreparationDigest) {
      return { ok: false, code: "NATIVE_COMPOSITE_REQUIRED", error: "NATIVE_COMPOSITE_REQUIRED: native checkpoint reissue requires complete generation and validator postimages", state };
    }
    if (!workspace || workspace.source_kind !== "native" || workspace.feature_id !== input.feature_id
      || workspace.project_root !== pinnedRoot.canonical_root
      || workspace.project_root_identity.canonical_path !== pinnedRoot.canonical_root
      || workspace.project_root_identity.dev !== pinnedRoot.dev
      || workspace.project_root_identity.ino !== pinnedRoot.ino
      || !phase || phase.status !== "awaiting_approval" || phase.current_version !== input.version
      || phase.validation_ref !== `validation.${input.phase}.v${input.version}`) {
      return { ok: false, error: "native phase checkpoint postimage is unavailable", state };
    }
    const artifact = readCanonicalPhaseArtifact(pinnedRoot.canonical_root, {
      feature_id: input.feature_id,
      run_key: input.run_key,
      phase: input.phase,
      version: input.version,
    }, pinnedRoot);
    const validation = readArtifactPinned<Record<string, unknown>>(
      pinnedRoot,
      join(".work-state", "features", input.feature_id, "artifacts"),
      phase.validation_ref,
    );
    if (!artifact || !validation || validation.status !== "pass" || !deterministicValidationMatchesArtifact(artifact, validation, pinnedRoot)) {
      return { ok: false, error: "native phase checkpoint artifact or validation postimage is unavailable", state };
    }
    if (validatorSelection.error) return { ok: false, code: "NATIVE_COMPOSITE_REQUIRED", error: "NATIVE_COMPOSITE_REQUIRED: " + validatorSelection.error, state };
    if (!validatorPostimage) return { ok: false, code: "NATIVE_COMPOSITE_REQUIRED", error: "NATIVE_COMPOSITE_REQUIRED: exact native validator postimage is unavailable", state };
    const validatorTerminalError = nativeValidatorSuccessPostimageError(validatorPostimage, artifact, validation, binding, input.phase, pinnedRoot);
    if (validatorTerminalError) return { ok: false, code: "NATIVE_COMPOSITE_REQUIRED", error: "NATIVE_COMPOSITE_REQUIRED: " + validatorTerminalError, state };
    if (!generationMarker?.work_identity || !generation?.work_identity
      || canonicalJson(artifact.work_identity) !== canonicalJson(generationMarker.work_identity)
      || canonicalJson(generationMarker.work_identity) !== canonicalJson(generation.work_identity)
      || !generation.completion?.artifact_ids.includes(artifact.source_artifact_id)) {
      return { ok: false, code: "NATIVE_COMPOSITE_REQUIRED", error: "NATIVE_COMPOSITE_REQUIRED: native checkpoint reissue generation identity or artifact binding is stale", state };
    }
    const constitutionError = phaseConstitutionError(pinnedRoot, workspace, artifact);
    if (constitutionError) return { ok: false, error: constitutionError, state };
    const validator = validatorPostimage;
    if (!generation || generation.status !== "succeeded" || !validator || validator.status !== "succeeded") {
      return { ok: false, error: "native phase generation and validator postimages are not complete", state };
    }
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed during native phase checkpoint reissue", state };
    preCommitConstitutionGuard = () => {
      const latestError = phaseConstitutionError(pinnedRoot, workspace, artifact);
      if (latestError) throw new Error(latestError);
    };
    const reissued = reissueActiveCapability(cap);
    const reissuedState: TeamState = {
      ...state,
      dispatch_capability: reissued.state,
      updated_at: now(),
    };
    return {
      ok: true,
      state: reissuedState,
      capability_id: reissued.capability_id,
      advance_token: reissued.advance_token,
      cursor_epoch: reissued.state.issued_for!.cursor_epoch,
    };
  }, { preCommit: () => { preCommitConstitutionGuard?.(); } });
}

export type SpecificationPhaseValidationDispatchConsumption =
  | { ok: true; state: TeamState; record: DispatchRecord }
  | { ok: false; error: string; state: TeamState };

/** Consume a validator dispatch exactly once after its evidence is evaluated. */
export function consumeSpecificationPhaseValidationDispatch(
  state: TeamState,
  dispatchId: string,
  outcome: "succeeded" | "failed",
  evidence: string,
): SpecificationPhaseValidationDispatchConsumption {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const record = cap.dispatches.find((candidate) => candidate.id === dispatchId);
  if (!record || record.purpose !== "validation") return { ok: false, error: "validation dispatch record not found", state };
  if (record.status !== "authorized" && record.status !== "running" && record.status !== "pending") return { ok: false, error: "validation dispatch was already consumed", state };
  if (!evidence.trim()) return { ok: false, error: "validation dispatch evidence is required", state };
  const identity = record.work_identity;
  if (!identity) return { ok: false, error: "validation dispatch identity is unavailable", state };
  const completedAt = now();
  const completion: DispatchCompletion = {
    dispatch_id: record.id,
    cursor_epoch: cap.issued_for.cursor_epoch,
    outcome,
    artifact_ids: [],
    evidence,
    completed_by: "engine_task_caller",
    completed_at: completedAt,
    work_identity: identity,
  };
  const envelope = completionEnvelopeFor(identity, outcome, outcome === "succeeded" ? "workflow_complete" : "workflow_complete", [], evidence, "engine_task_caller");
  const updated: DispatchRecord = {
    ...record,
    status: outcome,
    completed_at: completedAt,
    completion,
    pending: pendingFor(identity, outcome, undefined, undefined, record.pending?.retry_of ?? null),
    completion_envelope: envelope,
  };
  const nextCapability = {
    ...cap,
    dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? updated : candidate),
    pending: [...(cap.pending ?? []).filter((candidate) => candidate.identity.dispatch_id !== record.id), pendingFor(identity, outcome, undefined, undefined, record.pending?.retry_of ?? null)],
  };
  return {
    ok: true,
    record: updated,
    state: {
      ...withDispatchLifecycle(state, nextCapability, identity, envelope),
      dispatch_capability: nextCapability,
    },
  };
}

export function resolveSpecificationPhaseDispatch(
  cwd: string,
  input: DispatchAuth & { feature_id: string; request_id: string; dispatch_id: string; allow_committed_replay?: boolean },
  lockedSnapshot?: { state: TeamState; target: ResolvedState; pinnedRoot?: PinnedProjectRoot },
): SpecificationDispatchLifecycleResult {
  if (!isSafeStateSegment(input.feature_id)) return { ok: false, error: "an explicit safe feature_id is required for specification dispatch" };
  if (!input.run_key?.trim()) return { ok: false, error: "an explicit nonblank run_key is required for specification dispatch" };
  if (!input.request_id?.trim() || !input.dispatch_id?.trim()) return { ok: false, error: "request_id and dispatch_id are required for specification result persistence" };
  const selected = lockedSnapshot
    ? { found: lockedSnapshot, error: undefined }
    : currentForInput(cwd, input);
  if (selected.error) return { ok: false, error: selected.error };
  const found = selected.found;
  if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found;
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const stateBindingError = stateCapabilityBindingError(state, cap, lockedSnapshot?.pinnedRoot, input.feature_id);
  if (stateBindingError) return { ok: false, error: stateBindingError, state };
  const binding = cap.issued_for;
  if (cap.status !== "dispatched" && cap.status !== "joining") return { ok: false, error: "dispatch capability is not active", state };
  if (state.run_key !== binding.run_key
    || state.branch !== binding.branch
    || state.classification.workflow !== binding.workflow
    || state.stage_cursor !== binding.stage_cursor
    || state.cursor_epoch !== binding.cursor_epoch) {
    return { ok: false, error: "dispatch capability is stale for the current workflow epoch", state };
  }
  const authError = auth(cap, input, cap.dispatch_token_hash);
  if (authError) return { ok: false, error: authError, state };
  const record = cap.dispatches.find((candidate) => candidate.id === input.dispatch_id);
  if (!record?.work_identity) return { ok: false, error: "authorized dispatch record not found", state };
  if (record.tool_call_id !== input.request_id) return { ok: false, error: "request_id does not match the authorized dispatch", state };
  const identity = record.work_identity;
  if (identity.run_id !== binding.run_key
    || identity.workflow !== binding.workflow
    || identity.stage_id !== binding.stage_cursor
    || identity.stage_cursor !== binding.stage_cursor
    || identity.capability_id !== cap.capability_id
    || identity.capability_epoch !== binding.cursor_epoch
    || identity.slot_id !== record.role
    || identity.worker_id !== record.agent
    || identity.dispatch_id !== record.id
    || identity.attempt !== record.attempt) {
    return { ok: false, error: "dispatch work identity is stale or inconsistent for the active capability", state };
  }
  if (input.role !== undefined && input.role !== record.role) return { ok: false, error: "dispatch role mismatch", state };
  if (input.slot_id !== undefined && input.slot_id !== record.role && input.slot_id !== identity.slot_id) return { ok: false, error: "dispatch slot mismatch", state };
  if (input.task_id !== undefined && input.task_id !== identity.task_id) return { ok: false, error: "dispatch task mismatch", state };
  if (input.agent !== undefined && input.agent !== record.agent) return { ok: false, error: "dispatch agent mismatch", state };
  const nonterminal = record.status === "authorized" || record.status === "running" || record.status === "pending";
  const committedSuccessReplay = record.status === "succeeded" && input.allow_committed_replay === true;
  if (!nonterminal && !committedSuccessReplay) return { ok: false, error: "dispatch record is terminal or no longer active", state };
  return { ok: true, state, record, work_identity: identity, capability_epoch: identity.capability_epoch };
}

// ── T054 implementation-conformance terminal guard ───────────────────────────

const SPEC_CONFORMANCE_FAILED = "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED";
const SPEC_INTENT_CHANGED = "SPEC_IMPLEMENTATION_INTENT_CHANGED";

/**
 * Specification execution statuses whose terminal durable boundaries are
 * conformance-guarded. Preparation work (`implementation_ready` and earlier)
 * and legacy non-specification states are never affected.
 */
const SPEC_GUARDED_WORKSPACE_STATUSES: Record<string, true> = {
  claimed: true,
  executing: true,
  completion_validating: true,
  completion_blocked: true,
  completed: true,
};

type SpecificationConformanceGuardResult =
  | { ok: true; handoff: ImplementationHandoff; claim: ExecutionClaim; conformance: ImplementationConformanceResult }
  | { ok: false; code: typeof SPEC_CONFORMANCE_FAILED | typeof SPEC_INTENT_CHANGED | "SPEC_PATH_UNAUTHORIZED"; error: string };

function specificationConformanceGuardFailure(
  code: typeof SPEC_CONFORMANCE_FAILED | typeof SPEC_INTENT_CHANGED | "SPEC_PATH_UNAUTHORIZED",
  error: string,
): SpecificationConformanceGuardResult {
  return { ok: false, code, error };
}

/**
 * Load one canonical specification record from the selected feature artifact
 * tree (`<artifactsDir>/<directory>/<ref>.json`). Symlinks, escapes, and
 * non-object payloads fail closed; identifiers stay single safe segments.
 */
function specificationArtifactRecord(
  pinnedRoot: PinnedProjectRoot,
  workspace: FeatureWorkspace,
  directory: "implementation_handoff" | "execution_claim" | "implementation_conformance",
  ref: unknown,
): { ok: true; value: Record<string, unknown>; digest: string } | { ok: false; code: "SPEC_PATH_UNAUTHORIZED" | "SPEC_CONFORMANCE_ERROR"; error: string } {
  if (typeof ref !== "string" || ref.length === 0 || ref === "." || ref === ".." || !/^[A-Za-z0-9._-]+$/u.test(ref)) {
    return { ok: false, code: "SPEC_CONFORMANCE_ERROR", error: `specification ${directory} reference is not a safe artifact identifier` };
  }
  const relativePath = `.work-state/features/${workspace.feature_id}/artifacts/${directory}/${ref}.json`;
  const readError = (message: string): { ok: false; code: "SPEC_PATH_UNAUTHORIZED" | "SPEC_CONFORMANCE_ERROR"; error: string } => {
    const pathUnauthorized = !pinnedRoot.isStable()
      || /changed|outside the authorized project boundary|symlink|not[_ ](?:directory|regular)/iu.test(message);
    return {
      ok: false,
      code: pathUnauthorized ? "SPEC_PATH_UNAUTHORIZED" : "SPEC_CONFORMANCE_ERROR",
      error: `specification ${directory} '${ref}' is unreadable: ${message}`,
    };
  };
  if (directory === "implementation_handoff") {
    const loaded = readCanonicalHandoff(pinnedRoot, relativePath, `specification ${directory} '${ref}'`);
    if (!loaded.ok) return readError(loaded.error);
    return {
      ok: true,
      value: loaded.handoff as unknown as Record<string, unknown>,
      digest: createHash("sha256").update(loaded.snapshot.bytes).digest("hex"),
    };
  }
  const loaded = readCanonicalBoundedJson(pinnedRoot, relativePath, MAX_CONFORMANCE_ARTIFACT_BYTES, `specification ${directory} '${ref}'`);
  if (!loaded.ok) return readError(loaded.error);
  const parsed = loaded.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "SPEC_CONFORMANCE_ERROR", error: `specification ${directory} '${ref}' is not a JSON object` };
  }
  return {
    ok: true,
    value: parsed as Record<string, unknown>,
    digest: createHash("sha256").update(loaded.snapshot.bytes).digest("hex"),
  };
}

function constitutionBindingIdentity(binding: ConstitutionBinding | null | undefined): string {
  if (!binding) return "null";
  const { bound_at: _boundAt, ...semantic } = binding;
  return canonicalJson(semantic);
}

function workspaceConstitutionError(pinnedRoot: PinnedProjectRoot, workspace: FeatureWorkspace): string | null {
  const expected = workspace.constitution_binding;
  if (!expected) return "specification workspace has no constitution binding";
  const current = readPinnedCurrentConstitution(pinnedRoot.canonical_root, pinnedRoot, expected);
  return current.ok ? null : "live constitution is unavailable: " + current.error;
}

function phaseConstitutionError(
  pinnedRoot: PinnedProjectRoot,
  workspace: FeatureWorkspace,
  artifact: PersistedPhaseResultEnvelope,
): string | null {
  const expected = workspace.constitution_binding;
  if (!expected) return "specification workspace has no constitution binding";
  const current = readPinnedCurrentConstitution(pinnedRoot.canonical_root, pinnedRoot, expected);
  if (!current.ok) return "live constitution is unavailable: " + current.error;
  if (constitutionBindingIdentity(current.value.binding) !== constitutionBindingIdentity(artifact.constitution_binding)) {
    return "live constitution binding does not match immutable phase artifact";
  }
  return null;
}

function liveConstitutionError(pinnedRoot: PinnedProjectRoot, workspace: FeatureWorkspace): string | null {
  if (!workspace.handoff_ref) return "specification workspace has no implementation handoff reference";
  const record = specificationArtifactRecord(pinnedRoot, workspace, "implementation_handoff", workspace.handoff_ref);
  if (!record.ok) return record.error;
  const handoff = record.value as unknown as ImplementationHandoff;
  const validation = validateImplementationHandoff(handoff);
  if (!validation.ok) return `implementation handoff is invalid: ${validation.issues.join("; ")}`;
  if (handoff.feature_id !== workspace.feature_id || handoff.handoff_id !== workspace.handoff_ref || canonicalHandoffDigest(handoff) !== handoff.handoff_digest) {
    return "implementation handoff identity or digest does not match the workspace";
  }
  const constitutionError = workspaceConstitutionError(pinnedRoot, workspace);
  if (constitutionError) return constitutionError;
  const comparable = (binding: ConstitutionBinding | null | undefined): string => {
    if (!binding) return "null";
    const { bound_at: _boundAt, ...semantic } = binding;
    return canonicalJson(semantic);
  };
  return comparable(workspace.constitution_binding) === comparable(handoff.constitution_binding)
    ? null
    : "live constitution binding does not match implementation handoff";
}

const NESTED_ARTIFACT_REFERENCE_KEYS = ["artifact_id", "path", "sha256", "schema_status", "quality_gate_status"] as const;
const NESTED_EVIDENCE_KINDS: Record<string, true> = { implementation: true, review: true, executed_test: true, intent_conflict: true };
const NESTED_TEST_KINDS: Record<string, true> = { unit: true, integration: true, e2e: true, runtime: true };
const NESTED_EVIDENCE_KEYS = ["evidence_id", "kind", "subject_id", "requirement_id", "handoff_digest", "execution_claim_id", "review_verdict", "test", "intent_message", "recorded_at"] as const;
const NESTED_TEST_KEYS = ["evidence_ref", "test_kind", "status", "executed_at"] as const;
const NESTED_QUALITY_KEYS = ["schema_version", "artifact_id", "gates"] as const;
const NESTED_GATE_KEYS = ["gate_id", "source", "status", "evidence_refs", "findings", "evaluated_at"] as const;
function nestedExactKeys(value: unknown, expected: readonly string[], location: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${location} must be an object`];
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return [`${location} must use a plain object prototype`];
  const allowed = new Set(expected);
  return Object.keys(value).every((key) => allowed.has(key))
    ? [] : [`${location} contains unexpected or duplicate keys`];
}

type NestedConformanceProvenance = {
  handoff_digest: string;
  execution_claim_id: string;
  require_typed_envelope: boolean;
};

function nestedArtifactReferenceShapeIssues(value: unknown, location: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${location} must be an artifact reference object`];
  const budgetIssues = validateConformanceBounds(value);
  if (budgetIssues.length > 0) return budgetIssues.map((issue) => `${location}: ${issue}`);
  const exactIssues = nestedExactKeys(value, NESTED_ARTIFACT_REFERENCE_KEYS, location);
  if (exactIssues.length > 0) return exactIssues;
  const record = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof record.artifact_id !== "string" || !/^[A-Za-z0-9._-]+$/u.test(record.artifact_id)) issues.push(`${location}.artifact_id must be a safe artifact identifier`);
  if (typeof record.path !== "string" || !isSafeRelativePath(record.path)) issues.push(`${location}.path must be a safe project-relative path`);
  if (!isSha256Hex(record.sha256)) issues.push(`${location}.sha256 must be a SHA-256 digest`);
  if (record.schema_status !== "met") issues.push(`${location}.schema_status must be 'met'`);
  if (record.quality_gate_status !== "met") issues.push(`${location}.quality_gate_status must be 'met'`);
  return issues;
}
type NestedArtifactSchema = "conformance_evidence" | "quality_gate_evidence";
function nestedArtifactSchema(value: unknown): NestedArtifactSchema | null {
  if (!isRecord(value)) return null;
  if (value.artifact_schema === "conformance_evidence" || value.artifact_schema === "quality_gate_evidence") {
    return value.artifact_schema;
  }
  const hasEntries = Array.isArray(value.entries);
  const hasGates = Array.isArray(value.gates);
  if (hasEntries === hasGates) return null;
  return hasEntries ? "conformance_evidence" : "quality_gate_evidence";
}
type NestedEvidenceKind = "implementation" | "review" | "executed_test" | "intent_conflict";
type NestedExpectedTestRow = {
  subject_id: string;
  requirement_id: string | null;
  test_kind: string;
  status: "pass" | "fail";
  executed_at: string;
};
type NestedArtifactContext = {
  requiredSchema: NestedArtifactSchema | "either";
  kind?: NestedEvidenceKind;
  subject_id?: string;
  requirement_id?: string | null;
  test_kind?: string;
  test_status?: "pass" | "fail";
  executed_at?: string;
  gate_id?: string;
  gate_source?: "project_constitution" | "execution_profile";
  expected_runtime_rows?: readonly NestedExpectedTestRow[];
  canonical_runtime_artifact_id?: string;
  canonical_quality_artifact_id?: string;
  require_empty_quality_refs?: boolean;
};
function nestedArtifactContextKey(context: NestedArtifactContext): string {
  return JSON.stringify([
    context.requiredSchema,
    context.kind ?? null,
    context.subject_id ?? null,
    context.requirement_id ?? null,
    context.test_kind ?? null,
    context.test_status ?? null,
    context.executed_at ?? null,
    context.gate_id ?? null,
    context.gate_source ?? null,
    context.canonical_runtime_artifact_id ?? null,
    context.canonical_quality_artifact_id ?? null,
    context.require_empty_quality_refs ?? false,
    context.expected_runtime_rows ?? null,
  ]);
}

function nestedEvidenceEnvelopeIssues(
  value: unknown,
  reference: CompletionArtifactRef,
  location: string,
  provenance: NestedConformanceProvenance,
  context: NestedArtifactContext,
  admit: (value: unknown, location: string, depth: number, context: NestedArtifactContext) => void,
  depth: number,
): string[] {
  const budgetIssues = validateConformanceBounds(value);
  if (budgetIssues.length > 0) return budgetIssues.map((issue) => `${location}: ${issue}`);
  const envelopeKeys = Object.prototype.hasOwnProperty.call(value, "artifact_schema")
    ? ["schema_version", "artifact_id", "artifact_schema", "entries"] as const
    : ["schema_version", "artifact_id", "entries"] as const;
  const envelopeIssues = nestedExactKeys(value, envelopeKeys, location);
  const record = value as Record<string, unknown>;
  const issues: string[] = [...envelopeIssues];
  if (record.schema_version !== 1 || record.artifact_id !== reference.artifact_id || !Array.isArray(record.entries) || record.entries.length === 0) {
    issues.push(`${location} must contain schema_version 1, its exact artifact_id, and at least one entry`);
    return issues;
  }
  const expectedRows = context.expected_runtime_rows;
  const runtimeEnvelope = context.canonical_runtime_artifact_id !== undefined;
  if (runtimeEnvelope) {
    const canonicalRuntimeId = context.canonical_runtime_artifact_id!;
    const featureId = canonicalRuntimeId.slice("runtime_test_evidence-".length);
    const canonicalRuntimePath = `.work-state/features/${featureId}/artifacts/${canonicalRuntimeId}.json`;
    if (reference.artifact_id !== canonicalRuntimeId) issues.push(`${location} must use the canonical runtime artifact '${canonicalRuntimeId}'`);
    if (reference.path !== canonicalRuntimePath) issues.push(`${location} must use the canonical runtime path '${canonicalRuntimePath}'`);
    if (reference.artifact_id !== canonicalRuntimeId || reference.path !== canonicalRuntimePath) return issues;
  }
  let matchesExpectedRow = false;
  const seenRuntimeRows = new Set<string>();
  const matchedRuntimeRows = new Set<number>();
  record.entries.forEach((rawEntry, index) => {
    const entryLocation = `${location}.entries[${index}]`;
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      issues.push(`${entryLocation} must be an object`);
      return;
    }
    const entry = rawEntry as Record<string, unknown>;
    issues.push(...typedEvidenceEntryIssues(rawEntry, entryLocation));
    const entryIssues = nestedExactKeys(rawEntry, NESTED_EVIDENCE_KEYS, entryLocation);
    if (entryIssues.length > 0) {
      issues.push(...entryIssues);
      return;
    }
    if (entry.handoff_digest !== provenance.handoff_digest) issues.push(`${entryLocation}.handoff_digest does not match the frozen handoff`);
    if (entry.execution_claim_id !== provenance.execution_claim_id) issues.push(`${entryLocation}.execution_claim_id does not match the active execution claim`);
    const entryTest = isRecord(entry.test) ? entry.test : null;
    const rowMatches = (context.kind === undefined || entry.kind === context.kind)
      && (context.subject_id === undefined || entry.subject_id === context.subject_id)
      && (context.requirement_id === undefined || entry.requirement_id === context.requirement_id)
      && (context.test_kind === undefined || entry.kind !== "executed_test" || entryTest?.test_kind === context.test_kind)
      && (context.test_status === undefined || entry.kind !== "executed_test" || entryTest?.status === context.test_status)
      && (context.executed_at === undefined || entry.kind !== "executed_test" || entryTest?.executed_at === context.executed_at);
    if (rowMatches) matchesExpectedRow = true;
    if (runtimeEnvelope) {
      if (entry.kind !== "executed_test" || !entryTest) {
        issues.push(`${entryLocation} must be an executed_test row in the canonical runtime artifact`);
      } else {
        const row = {
          subject_id: typeof entry.subject_id === "string" ? entry.subject_id : "",
          requirement_id: entry.requirement_id === null || typeof entry.requirement_id === "string" ? entry.requirement_id : null,
          test_kind: typeof entryTest.test_kind === "string" ? entryTest.test_kind : "",
          status: entryTest.status === "pass" || entryTest.status === "fail" ? entryTest.status : "fail",
          executed_at: typeof entryTest.executed_at === "string" ? entryTest.executed_at : "",
        } satisfies NestedExpectedTestRow;
        const rowKey = JSON.stringify([row.subject_id, row.requirement_id, row.test_kind, row.status, row.executed_at]);
        if (seenRuntimeRows.has(rowKey)) issues.push(`${entryLocation} duplicates a runtime executed_test row`);
        seenRuntimeRows.add(rowKey);
        const expectedIndex = expectedRows?.findIndex((expected) => JSON.stringify([expected.subject_id, expected.requirement_id, expected.test_kind, expected.status, expected.executed_at]) === rowKey) ?? -1;
        if (expectedIndex < 0) issues.push(`${entryLocation} does not match any outer executed_test row`);
        else matchedRuntimeRows.add(expectedIndex);
      }
    }
    if (entry.kind === "executed_test" && isRecord(entry.test) && isRecord(entry.test.evidence_ref)) {
      admit(
        entry.test.evidence_ref,
        `${entryLocation}.test.evidence_ref`,
        depth + 1,
        runtimeEnvelope
          ? {
            requiredSchema: "quality_gate_evidence",
            canonical_quality_artifact_id: context.canonical_quality_artifact_id,
            require_empty_quality_refs: true,
          }
          : { requiredSchema: "either" },
      );
    }
  });
  if (context.kind !== undefined && !matchesExpectedRow) {
    issues.push(`${location} does not contain evidence for the expected ${context.kind} row '${context.subject_id ?? "unknown"}'`);
  }
  if (runtimeEnvelope) {
    if (!expectedRows || expectedRows.length === 0) issues.push(`${location} has no outer executed_test rows to authorize it`);
    else {
      if (record.entries.length !== expectedRows.length) issues.push(`${location} must contain exactly the outer executed_test rows`);
      expectedRows.forEach((_, index) => {
        if (!matchedRuntimeRows.has(index)) issues.push(`${location} is missing outer executed_test row ${index}`);
      });
    }
  }
  return issues;
}

function nestedQualityEnvelopeIssues(
  value: unknown,
  reference: CompletionArtifactRef,
  location: string,
  admit: (value: unknown, location: string, depth: number, context: NestedArtifactContext) => void,
  depth: number,
  context: NestedArtifactContext,
): string[] {
  const budgetIssues = validateConformanceBounds(value);
  if (budgetIssues.length > 0) return budgetIssues.map((issue) => `${location}: ${issue}`);
  const envelopeKeys = Object.prototype.hasOwnProperty.call(value, "artifact_schema")
    ? ["schema_version", "artifact_id", "artifact_schema", "gates"] as const
    : ["schema_version", "artifact_id", "gates"] as const;
  const issues = [
    ...nestedExactKeys(value, envelopeKeys, location),
    ...typedQualityGateIssues(value, location),
  ];
  const record = value as Record<string, unknown>;
  if (context.canonical_quality_artifact_id !== undefined && reference.artifact_id !== context.canonical_quality_artifact_id) {
    issues.push(`${location} must use the canonical quality artifact ${context.canonical_quality_artifact_id}`);
  }
  if (record.schema_version !== 1 || record.artifact_id !== reference.artifact_id || !Array.isArray(record.gates) || record.gates.length === 0) {
    issues.push(`${location} must contain schema_version 1, its exact artifact_id, and at least one gate`);
    return issues;
  }
  let matchesExpectedGate = false;
  record.gates.forEach((rawGate, index) => {
    const gateLocation = `${location}.gates[${index}]`;
    if (!rawGate || typeof rawGate !== "object" || Array.isArray(rawGate)) {
      issues.push(`${gateLocation} must be an object`);
      return;
    }
    const gateIssues = nestedExactKeys(rawGate, NESTED_GATE_KEYS, gateLocation);
    if (gateIssues.length > 0) {
      issues.push(...gateIssues);
      return;
    }
    const gate = rawGate as Record<string, unknown>;
    const gateMatches = (context.gate_id === undefined || gate.gate_id === context.gate_id)
      && (context.gate_source === undefined || gate.source === context.gate_source);
    if (gateMatches) matchesExpectedGate = true;
    if (Array.isArray(gate.evidence_refs)) {
      if (context.require_empty_quality_refs && gate.evidence_refs.length > 0) {
        issues.push(`${gateLocation}.evidence_refs must be empty in the canonical quality artifact`);
      }
      gate.evidence_refs.forEach((nested, nestedIndex) => admit(
        nested,
        `${gateLocation}.evidence_refs[${nestedIndex}]`,
        depth + 1,
        { requiredSchema: "either" },
      ));
    }
  });
  if (context.gate_id !== undefined && !matchesExpectedGate) {
    issues.push(`${location} does not contain the expected quality gate '${context.gate_id}'`);
  }
  return issues;
}

/**
 * Re-admit every nested evidence reference from the conformance matrix under
 * the same pinned feature artifact root used for canonical records. Every
 * reference is exact, current, status-met, schema-valid, and (for CTO
 * authority) a typed envelope whose evidence is bound to the frozen handoff
 * and active claim.
 */
function nestedConformanceEvidenceIssues(
  pinnedRoot: PinnedProjectRoot,
  workspace: FeatureWorkspace,
  conformance: ImplementationConformanceResult,
): string[] {
  const relativeArtifactsDir = `.work-state/features/${workspace.feature_id}/artifacts`;
  const budgetIssues = validateConformanceBounds(conformance);
  if (budgetIssues.length > 0) return budgetIssues;
  const issues: string[] = [];
  const expectedRuntimeRows: NestedExpectedTestRow[] = conformance.entries.flatMap((entry) => entry.test_evidence.map((test) => ({
    subject_id: entry.subject_id,
    requirement_id: entry.requirement_id,
    test_kind: test.test_kind,
    status: test.status,
    executed_at: test.executed_at,
  })));
  const canonicalRuntimeArtifactId = `runtime_test_evidence-${workspace.feature_id}`;
  const canonicalQualityArtifactId = `quality_gate_evidence-${workspace.feature_id}`;
  try {
    const names = pinnedRoot.listDirectory(relativeArtifactsDir);
    const expectedRuntimeName = `${canonicalRuntimeArtifactId}.json`;
    for (const name of names) {
      if (name.startsWith("implementation_evidence-")) issues.push(`feature ${workspace.feature_id} contains forbidden standalone implementation evidence artifact ${name}`);
      else if (name.startsWith("runtime_test_evidence-") && name !== expectedRuntimeName) issues.push(`feature ${workspace.feature_id} contains an alternate runtime evidence artifact ${name}`);
    }
    if (expectedRuntimeRows.length === 0 && names.includes(expectedRuntimeName)) issues.push(`feature ${workspace.feature_id} contains an unused canonical runtime evidence artifact`);
  } catch (error) {
    issues.push(`feature ${workspace.feature_id} artifact directory could not be enumerated safely: ${error instanceof Error ? error.message : String(error)}`);
  }
  const provenance: NestedConformanceProvenance = {
    handoff_digest: conformance.handoff_digest,
    execution_claim_id: conformance.execution_claim_id,
    require_typed_envelope: conformance.execution_owner === "cto",
  };
  const visited = new Set<string>();
  const admit = (
    rawReference: unknown,
    location: string,
    depth = 0,
    context: NestedArtifactContext = { requiredSchema: "either" },
  ): void => {
    const shapeIssues = nestedArtifactReferenceShapeIssues(rawReference, location);
    issues.push(...shapeIssues);
    if (shapeIssues.length > 0 || !rawReference || typeof rawReference !== "object" || Array.isArray(rawReference)) return;
    const record = rawReference as Record<string, unknown>;
    if (typeof record.path !== "string" || !record.path.startsWith(`${relativeArtifactsDir}/`)) {
      issues.push(`${location}.path must be below the feature artifact store`);
      return;
    }
    if (depth > 8) {
      issues.push(`${location} nested evidence exceeded the maximum dereference depth`);
      return;
    }
    const artifactsDir = join(pinnedRoot.canonical_root, dirname(record.path));
    const result = normalizeCtoArtifactReferencePinned(
      pinnedRoot,
      {
        project_root: pinnedRoot.canonical_root,
        artifacts_dir: artifactsDir,
        allowed_paths: [record.path],
      },
      rawReference as unknown as CompletionArtifactRef,
      location,
      (_artifactId, value) => {
        if (!provenance.require_typed_envelope) return { ok: true };
        const schema = nestedArtifactSchema(value);
        if (schema === null) {
          return {
            ok: false,
            issues: [{ field: "$.artifact_schema", message: "artifact envelope must declare or structurally identify conformance_evidence or quality_gate_evidence" }],
          };
        }
        if (context.requiredSchema !== "either" && schema !== context.requiredSchema) {
          return {
            ok: false,
            issues: [{ field: "$.artifact_schema", message: `artifact envelope schema '${schema}' does not match required '${context.requiredSchema}'` }],
          };
        }
        return validateProducedArtifact(schema, value);
      },
    );
    if (!result.ok) {
      issues.push(...result.issues.map((issue) => `${location}: ${issue}`));
      return;
    }
    const reference = result.reference;
    const schema = provenance.require_typed_envelope ? nestedArtifactSchema(result.value) : null;
    if (provenance.require_typed_envelope && schema === null) {
      issues.push(`${location} must contain a canonical conformance_evidence or quality_gate_evidence envelope for CTO execution`);
      return;
    }
    const visitKey = `${nestedArtifactContextKey(context)}:${schema ?? "generic"}:${reference.artifact_id}:${reference.sha256}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    if (!provenance.require_typed_envelope) return;
    if (schema === "conformance_evidence") {
      issues.push(...nestedEvidenceEnvelopeIssues(result.value, reference, location, provenance, context, admit, depth));
    } else if (schema === "quality_gate_evidence") {
      issues.push(...nestedQualityEnvelopeIssues(result.value, reference, location, admit, depth, context));
    }
  };

  conformance.entries.forEach((entry, index) => {
    entry.implementation_evidence_refs.forEach((reference, referenceIndex) => {
      admit(reference, `$.entries[${index}].implementation_evidence_refs[${referenceIndex}]`, 0, {
        requiredSchema: "conformance_evidence",
        kind: "implementation",
        subject_id: entry.subject_id,
        requirement_id: entry.requirement_id,
      });
    });
    entry.review_evidence_refs.forEach((reference, referenceIndex) => {
      admit(reference, `$.entries[${index}].review_evidence_refs[${referenceIndex}]`, 0, {
        requiredSchema: "conformance_evidence",
        kind: "review",
        subject_id: entry.subject_id,
        requirement_id: entry.requirement_id,
      });
    });
    entry.test_evidence.forEach((test, testIndex) => {
      admit(test.evidence_ref, `$.entries[${index}].test_evidence[${testIndex}].evidence_ref`, 0, {
        requiredSchema: "conformance_evidence",
        expected_runtime_rows: expectedRuntimeRows,
        canonical_runtime_artifact_id: canonicalRuntimeArtifactId,
        canonical_quality_artifact_id: canonicalQualityArtifactId,
      });
    });
  });
  conformance.quality_gate_results.forEach((gate, gateIndex) => {
    gate.evidence_refs.forEach((reference, referenceIndex) => {
      admit(reference, `$.quality_gate_results[${gateIndex}].evidence_refs[${referenceIndex}]`, 0, {
        requiredSchema: "quality_gate_evidence",
        require_empty_quality_refs: true,
      });
    });
  });
  return issues;
}

/**
 * The one shared evidence chain behind every specification terminal boundary
 * (T054): load the frozen handoff, the current exclusive claim, and the
 * implementation conformance result from the feature artifact tree, validate
 * each canonical record, and require exact feature/handoff/claim/owner/run/
 * profile bindings with pass-only rows, pass-only quality gates, empty
 * blocking findings, and a ready handoff. Missing, stale, foreign, or failed
 * evidence fails closed with the stable conformance code; a current
 * `changed_intent` result surfaces the stable intent-change code.
 */
function loadSpecificationExecutionEvidence(
  pinnedRoot: PinnedProjectRoot,
  workspace: FeatureWorkspace,
): SpecificationConformanceGuardResult {
  if (!workspace.handoff_ref) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, "specification workspace has no implementation handoff reference");
  }
  const handoffRecord = specificationArtifactRecord(pinnedRoot, workspace, "implementation_handoff", workspace.handoff_ref);
  if (!handoffRecord.ok) {
    return specificationConformanceGuardFailure(
      handoffRecord.code === "SPEC_PATH_UNAUTHORIZED" ? "SPEC_PATH_UNAUTHORIZED" : SPEC_CONFORMANCE_FAILED,
      handoffRecord.error,
    );
  }
  const handoffValidation = validateImplementationHandoff(handoffRecord.value);
  if (!handoffValidation.ok) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `implementation handoff is invalid: ${handoffValidation.issues.join("; ")}`);
  }
  const handoff = handoffRecord.value as unknown as ImplementationHandoff;
  if (handoff.handoff_id !== workspace.handoff_ref) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `loaded handoff '${handoff.handoff_id}' does not match the workspace handoff reference '${workspace.handoff_ref}'`);
  }
  if (handoff.feature_id !== workspace.feature_id) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `handoff feature '${handoff.feature_id}' does not match the workspace feature '${workspace.feature_id}'`);
  }
  if (handoff.status !== "ready") {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `implementation handoff '${handoff.handoff_id}' is '${handoff.status}', not ready`);
  }
  if (canonicalHandoffDigest(handoff) !== handoff.handoff_digest) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `implementation handoff '${handoff.handoff_id}' digest does not match its canonical content`);
  }

  const constitutionError = liveConstitutionError(pinnedRoot, workspace);
  if (constitutionError) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, constitutionError);
  }

  const authority = readClaimAuthority(pinnedRoot, workspace.feature_id);
  if (!authority.ok) {
    return specificationConformanceGuardFailure(
      authority.code === "SPEC_PATH_UNAUTHORIZED" ? "SPEC_PATH_UNAUTHORIZED" : SPEC_CONFORMANCE_FAILED,
      `${authority.code}: ${authority.error}`,
    );
  }
  const claim = authority.value;
  if (!claim) return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, "specification workspace does not carry a bound active execution claim");
  if (claim.status === "released") return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `execution claim '${claim.claim_id}' is released; the workspace has no active execution owner`);
  if (claim.handoff_digest !== handoff.handoff_digest) return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `execution claim '${claim.claim_id}' does not bind the ready handoff digest`);
  if (!workspace.implementation_conformance_ref) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, "specification workspace has no implementation conformance reference");
  }
  const conformanceRecord = specificationArtifactRecord(pinnedRoot, workspace, "implementation_conformance", workspace.implementation_conformance_ref);
  if (!conformanceRecord.ok) {
    return specificationConformanceGuardFailure(
      conformanceRecord.code === "SPEC_PATH_UNAUTHORIZED" ? "SPEC_PATH_UNAUTHORIZED" : SPEC_CONFORMANCE_FAILED,
      conformanceRecord.error,
    );
  }
  const conformanceValidation = validateImplementationConformance(conformanceRecord.value);
  if (!conformanceValidation.ok) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `implementation conformance is invalid: ${conformanceValidation.issues.join("; ")}`);
  }
  const conformance = conformanceRecord.value as unknown as ImplementationConformanceResult;
  if (conformance.conformance_id !== workspace.implementation_conformance_ref) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `loaded conformance '${conformance.conformance_id}' does not match the workspace conformance reference '${workspace.implementation_conformance_ref}'`);
  }
  if (conformance.feature_id !== workspace.feature_id
    || conformance.handoff_id !== handoff.handoff_id
    || conformance.handoff_digest !== handoff.handoff_digest
    || conformance.execution_claim_id !== claim.claim_id
    || conformance.execution_owner !== claim.owner_kind
    || conformance.execution_run_id !== claim.owner_run_id) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, "implementation conformance identity does not match the current workspace, canonical handoff, or live execution claim");
  }
  const crossValidation = validateConformanceAgainstHandoff(conformance, handoff, claim);
  if (!crossValidation.ok) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `implementation conformance does not bind the active handoff and claim: ${crossValidation.issues.join("; ")}`);
  }
  if (conformance.profile_hash !== workspace.profile_hash) {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `implementation conformance profile hash '${conformance.profile_hash}' does not match the workspace profile binding '${workspace.profile_hash}'`);
  }
  const mandatoryGateSpecs = claim.owner_kind === "cto"
    ? ctoMandatoryQualityGateSpecs(workspace.profile_hash, handoff.handoff_id)
    : doWorkMandatoryQualityGateSpecs(workspace.profile_hash, handoff.handoff_id);
  const mandatoryGateIssues = ctoMandatoryQualityGateIssues(conformance.quality_gate_results, mandatoryGateSpecs);
  if (mandatoryGateIssues.length > 0) {
    return specificationConformanceGuardFailure(
      SPEC_CONFORMANCE_FAILED,
      `implementation conformance mandatory quality gate validation failed: ${mandatoryGateIssues.join("; ")}`,
    );
  }
  if (conformance.overall_status === "changed_intent") {
    return specificationConformanceGuardFailure(SPEC_INTENT_CHANGED, "implementation conformance reports changed intent; revise the earliest affected specification phase");
  }
  if (conformance.overall_status !== "pass") {
    return specificationConformanceGuardFailure(SPEC_CONFORMANCE_FAILED, `implementation conformance is '${conformance.overall_status}'; terminal completion requires a current pass`);
  }
  const nestedEvidenceIssues = nestedConformanceEvidenceIssues(pinnedRoot, workspace, conformance);
  if (nestedEvidenceIssues.length > 0) {
    return specificationConformanceGuardFailure(
      SPEC_CONFORMANCE_FAILED,
      `implementation conformance contains inadmissible nested evidence: ${nestedEvidenceIssues.join("; ")}`,
    );
  }
  return { ok: true, handoff, claim, conformance };
}

/**
 * T054 terminal guard verdict for one durable state: a stable fail-closed
 * error when the carried specification execution workspace lacks its current
 * passing conformance chain, or null when the guard does not apply or is
 * satisfied. Purely observational — it never mutates state.
 */
export function specificationTerminalGuardError(state: TeamState, artifactsDir: string | null): string | null {
  const workspace = state.specification;
  if (!workspace || !SPEC_GUARDED_WORKSPACE_STATUSES[workspace.status]) return null;
  if (!artifactsDir) return `${SPEC_CONFORMANCE_FAILED}: specification execution requires the feature artifact tree`;
  const pinnedRoot = PinnedProjectRoot.open(workspace.project_root);
  if (!pinnedRoot) return `${SPEC_CONFORMANCE_FAILED}: specification execution project root cannot be pinned`;
  try {
    const evidence = loadSpecificationExecutionEvidence(pinnedRoot, workspace);
    return evidence.ok ? null : `${evidence.code}: ${evidence.error}`;

  } finally {
    pinnedRoot.close();
  }
}
function isCtoSpecificationCompletionEnvelope(
  input: SpecificationExecutionCompletionInput,
): input is CtoSpecificationCompletionEnvelope {
  return Boolean(input && "owner_kind" in input && input.owner_kind === "cto");
}

type CtoCompletionGuardResult =
  | { ok: true; state: TeamState; claim: ExecutionClaim }
  | { ok: false; error: string };

/**
 * Authenticate a CTO completion without a bearer token. Every value in this
 * envelope is merely a selector: the exact current CTO state, confirmed
 * mapping record, answer ledger, feature claim, and admission binding are
 * re-read while the root is pinned.
 */
function authorizeCtoSpecificationCompletion(
  cwd: string,
  pinnedRoot: PinnedProjectRoot,
  state: TeamState,
  workspace: FeatureWorkspace,
  input: CtoSpecificationCompletionEnvelope,
  claimOverride?: ExecutionClaim,
): CtoCompletionGuardResult {
  if (!isSafeCtoRunId(input.owner_run_key) || !isSafeCtoExecutionId(input.wave_id) || !isSafeCtoExecutionId(input.mapping_id) || !isSafeFeatureId(input.feature_id)
    || !input.run_key.trim() || !input.handoff_digest.trim() || !input.conformance_id.trim()
    || !isSha256Hex(input.mapping_digest) || !isSha256Hex(input.handoff_digest)
    || workspace.feature_id !== input.feature_id || state.run_key !== input.run_key) {
    return { ok: false, error: "CTO completion envelope identity is invalid" };
  }
  let claim: ExecutionClaim | null = claimOverride ?? null;
  if (!claim) {
    const authority = readClaimAuthority(pinnedRoot, input.feature_id);
    if (!authority.ok) return { ok: false, error: authority.error };
    claim = authority.value;
  }
  if (!claim || claim.owner_kind !== "cto" || claim.owner_run_id !== input.owner_run_key
    || (claim.status !== "active" && claim.status !== "completed")
    || workspace.execution_claim_ref !== claim.claim_id
    || claim.handoff_digest !== input.handoff_digest
    || !claim.admission_binding) {
    return { ok: false, error: "CTO completion envelope does not bind the current feature claim" };
  }
  const admission = claim.admission_binding;
  if (admission.mapping_id !== input.mapping_id
    || admission.mapping_record_digest !== input.mapping_digest
    || admission.mapping_hash.trim().length === 0
    || admission.wave_id !== input.wave_id
    || admission.confirmation_authorization_digest.trim().length === 0) {
    return { ok: false, error: "CTO completion envelope does not bind the claim admission authority" };
  }
  const mappingPath = `.work-state/cto/${input.owner_run_key}/specification-mappings/${input.mapping_id}.json`;
  if (admission.mapping_record_path !== mappingPath) return { ok: false, error: "CTO completion mapping path is not canonical" };
  const mappingRead = readPinnedCtoMappingRecord(
    pinnedRoot,
    mappingPath,
    input.owner_run_key,
    input.mapping_id,
  );
  if (!mappingRead.ok) return { ok: false, error: `CTO completion mapping record is unreadable: ${mappingRead.error}` };
  if (mappingRead.value.digest !== input.mapping_digest) {
    return { ok: false, error: "CTO completion mapping digest changed" };
  }
  const mappingRecord = mappingRead.value.record;
  const mapping = mappingRecord.mapping as Record<string, unknown>;
  const handoffBindings = mapping.handoff_bindings as unknown[];
  const featureBinding = handoffBindings.find((candidate: unknown) => Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).feature_id === input.feature_id)) as Record<string, unknown> | undefined;
  if (!featureBinding || featureBinding.handoff_digest !== input.handoff_digest) {
    return { ok: false, error: "CTO completion mapping handoff binding is stale for the selected feature" };
  }
  const selections = mappingRecord.selections as unknown[];
  if (mappingRecord.schema_version !== 1
    || !mapping || typeof mapping !== "object" || Array.isArray(mapping)
    || (mapping as Record<string, unknown>).status !== "confirmed"
    || (mapping as Record<string, unknown>).mapping_id !== input.mapping_id
    || (mapping as Record<string, unknown>).mapping_hash !== admission.mapping_hash
    || (mapping as Record<string, unknown>).mapping_version !== admission.mapping_version
    || !Array.isArray(selections)
    || !selections.some((selection) => Boolean(selection && typeof selection === "object" && !Array.isArray(selection)
      && (selection as Record<string, unknown>).feature_id === input.feature_id
      && (selection as Record<string, unknown>).run_key === input.run_key))) {
    return { ok: false, error: "CTO completion mapping is not the confirmed exact feature selection" };
  }
  const context = mappingRecord.confirmation_context;
  if (!context || typeof context !== "object" || Array.isArray(context)) return { ok: false, error: "CTO completion mapping confirmation context is missing" };
  const confirmation = context as Record<string, unknown>;
  if (confirmation.decision !== "approve_continue"
    || confirmation.capability_id !== admission.capability_id
    || confirmation.capability_epoch !== admission.capability_epoch
    || confirmation.stage_id !== admission.stage_id
    || confirmation.policy_hash !== admission.policy_hash
    || mappingRecord.checkpoint_ref !== admission.checkpoint_ref
    || mappingRecord.trusted_answer_ref !== admission.trusted_answer_ref) {
    return { ok: false, error: "CTO completion mapping confirmation context is stale" };
  }
  const ctoState = readCtoStatePinned(input.owner_run_key, pinnedRoot);
  const wave = ctoState?.wave_history?.find((candidate) => candidate.id === input.wave_id);
  const waveIdentity = wave?.work_identity;
  const mappingExecution = (mapping as Record<string, unknown>).execution;
  const waveTeam = waveIdentity ? ctoState?.teams.find((candidate) => candidate.slice_id === waveIdentity.slice_id) : undefined;
  const featureTaskOwners: Array<Record<string, unknown>> = Array.isArray(mapping.task_to_slice)
    ? mapping.task_to_slice.filter((candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.feature_id === input.feature_id)
    : [];
  const featureTeams = ctoState?.teams.filter((candidate) => candidate.feature_id === input.feature_id && candidate.run_key === input.run_key) ?? [];
  const ownerKeys = featureTaskOwners.map((owner) => `${String(owner.team_id)}\0${String(owner.slice_id)}\0${String(owner.task_id)}`);
  const expectedTeamIds = featureTaskOwners.map((owner) => String(owner.team_id));
  const ownerSetIsUnique = new Set(ownerKeys).size === ownerKeys.length
    && new Set(expectedTeamIds).size === expectedTeamIds.length;
  const completionTeams = featureTaskOwners.map((owner) => {
    const matches = featureTeams.filter((candidate) => candidate.id === owner.team_id && candidate.slice_id === owner.slice_id && candidate.task_id === owner.task_id);
    return matches.length === 1 ? matches[0] : undefined;
  });
  const waveIdentityMatches = Boolean(waveIdentity && waveTeam?.work_identity
    && JSON.stringify(waveTeam.work_identity) === JSON.stringify(waveIdentity)
    && waveIdentity.run_id === input.owner_run_key
    && waveIdentity.wave_id === input.wave_id
    && waveIdentity.workflow === waveTeam.workflow
    && waveIdentity.stage_id === "execution"
    && waveIdentity.stage_cursor === "execution"
    && waveIdentity.slice_id === wave.slice_ids[0]
    && waveIdentity.slot_id === waveIdentity.slice_id
    && wave.slice_ids.includes(waveIdentity.slice_id));
  const selectedIdentityMatches = Boolean(ctoState && waveIdentity && featureTaskOwners.length > 0
    && featureTeams.length === featureTaskOwners.length
    && ownerSetIsUnique
    && completionTeams.every((team, index) => {
      const owner = featureTaskOwners[index];
      if (!owner) return false;
      const identity = team?.work_identity;
      const envelope = team?.completion_envelope;
      return Boolean(team && identity && envelope
        && team.feature_id === input.feature_id
        && team.run_key === input.run_key
        && team.id === owner.team_id
        && team.slice_id === owner.slice_id
        && team.task_id === owner.task_id
        && team.status !== "pending" && team.status !== "in_progress" && team.status !== "parked"
        && (team.status === "done" ? envelope.outcome === "succeeded" : envelope.outcome === "failed")
        && team.pending === undefined
        && canonicalJson(envelope.identity) === canonicalJson(identity)
        && validateTypedControlPlane({ work_identity: identity, completion_envelope: envelope }).ok
        && identity.run_id === input.owner_run_key
        && identity.wave_id === input.wave_id
        && identity.workflow === team.workflow
        && identity.workflow === waveIdentity.workflow
        && identity.session_id === waveIdentity.session_id
        && identity.stage_id === "execution"
        && identity.stage_cursor === "execution"
        && identity.capability_id === admission.capability_id
        && identity.capability_epoch === admission.capability_epoch
        && identity.slice_id === owner.slice_id
        && identity.slot_id === owner.slice_id
        && typeof identity.task_id === "string" && identity.task_id.length > 0
        && typeof identity.dispatch_id === "string" && identity.dispatch_id.length > 0
        && Number.isSafeInteger(identity.attempt) && identity.attempt >= 1
        && typeof identity.worker_id === "string" && identity.worker_id.length > 0);
    }));
  if (!ctoState || ctoState.id !== input.owner_run_key || ctoState.active_wave_id !== input.wave_id || !wave || wave.status !== "active"
    || wave.source !== "specification-execution" || !waveIdentityMatches
    || !mappingExecution || typeof mappingExecution !== "object"
    || (mappingExecution as Record<string, unknown>).wave_id !== input.wave_id
    || (mappingExecution as Record<string, unknown>).source_id !== wave.source_id
    || (mappingExecution as Record<string, unknown>).capability_id !== admission.capability_id
    || (mappingExecution as Record<string, unknown>).capability_epoch !== admission.capability_epoch
    || !selectedIdentityMatches) {
    return { ok: false, error: "CTO completion envelope does not bind the active execution wave" };
  }
  const anchor = resolveStatePinned(cwd, pinnedRoot, { feature_id: String(confirmation.feature_id), run_key: String(confirmation.run_key) });
  const anchorState = anchor.state;
  const answerId = mappingRecord.trusted_answer_ref;
  const answer = anchorState?.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === answerId);
  if (!anchorState || !answer || !mappingRecord.checkpoint_ref || typeof confirmation.stage_id !== "string"
    || typeof confirmation.policy_hash !== "string") {
    return { ok: false, error: "CTO completion trusted confirmation answer is unavailable" };
  }
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
    run_id: String(confirmation.run_key),
    stage_id: confirmation.stage_id,
    checkpoint_id: mappingRecord.checkpoint_ref,
    decision: "approve_continue",
    feature_id: String(confirmation.feature_id),
    capability_id: admission.capability_id,
    capability_epoch: admission.capability_epoch,
    policy_hash: confirmation.policy_hash,
    root_identity: { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    bind_active_context: true,
  });
  if (proofError) return { ok: false, error: `CTO completion trusted confirmation proof is invalid: ${proofError}` };
  if (workspace.handoff_ref === null || workspace.implementation_conformance_ref !== input.conformance_id) {
    return { ok: false, error: "CTO completion envelope does not bind workspace conformance" };
  }
  return { ok: true, state, claim };
}

export type SpecificationExecutionCompletionResult =
  | {
    ok: true;
    state: TeamState;
    claim: ExecutionClaim;
    workspace: FeatureWorkspace;
    next_action: FeatureWorkspace["next_action"];
    disposition: "created" | "replayed";
    replayed: boolean;
  }
  | {
    ok: false;
    code: "SPEC_STATE_INVALID" | ExecutionClaimResultCode | typeof SPEC_CONFORMANCE_FAILED | typeof SPEC_INTENT_CHANGED;
    error: string;
    state?: TeamState;
  };

/**
 * The one guarded completion path for a specification-backed execution
 * (T054): only a current overall-pass conformance chain transitions the
 * active claim through `completeExecutionClaim`, persists the completed
 * claim, and marks the embedded workspace completed with its conformance
 * reference and a deterministic none next action. Completed replay is
 * idempotent, and an interrupted completion (claim already persisted
 * completed) heals forward deterministically from the same passing evidence.
 * Generic quality gates, feature DoD, or human decisions cannot reach this
 * boundary: the evidence chain above fails closed first.
 */
function completeSpecificationExecutionUnlocked(
  cwd: string,
  input: SpecificationExecutionCompletionInput,
  suppliedPinnedRoot?: PinnedProjectRoot,
): SpecificationExecutionCompletionResult {
  if (!isSafeStateSegment(input.feature_id) || typeof input.run_key !== "string" || input.run_key.trim().length === 0) {
    return { ok: false, code: "SPEC_STATE_INVALID", error: "SPEC_STATE_INVALID: explicit feature_id and run_key selectors are required" };
  }
  const pinnedRoot = suppliedPinnedRoot ?? PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) {
    return {
      ok: false,
      code: "SPEC_PATH_UNAUTHORIZED",
      error: "SPEC_PATH_UNAUTHORIZED: project root cannot be pinned for specification execution completion",
    };
  }
  try {
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "SPEC_PATH_UNAUTHORIZED: project root changed before finalizer authorization" };
    const target = resolveStatePinned(cwd, pinnedRoot, { feature_id: input.feature_id, run_key: input.run_key });
    if (target.invalid || !target.state) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: "SPEC_STATE_INVALID: selected feature/run workspace is unavailable or does not match" };
    }
    const state = target.state;
    const workspace = state.specification;
    if (!workspace || workspace.feature_id !== input.feature_id) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: "embedded specification workspace unavailable", state };
    }
    const liveConstitutionFinding = liveConstitutionError(pinnedRoot, workspace);
    if (liveConstitutionFinding) {
      return { ok: false, code: SPEC_CONFORMANCE_FAILED, error: `${SPEC_CONFORMANCE_FAILED}: ${liveConstitutionFinding}`, state };
    }
    if (isCtoSpecificationCompletionEnvelope(input)
      && workspace.status === "completed"
      && workspace.execution_claim_ref
      && workspace.implementation_conformance_ref) {
      const conformanceRecord = specificationArtifactRecord(pinnedRoot, workspace, "implementation_conformance", workspace.implementation_conformance_ref);
      if (conformanceRecord.ok) {
        const conformanceValidation = validateImplementationConformance(conformanceRecord.value);
        const nestedIssues = conformanceValidation.ok
          ? nestedConformanceEvidenceIssues(pinnedRoot, workspace, conformanceRecord.value as unknown as ImplementationConformanceResult)
          : [];
        if (conformanceValidation.ok && nestedIssues.length === 0) {
          const recoveryAuthorization: CompletionRecoveryAuthorization = {
            preauthorize: (claim, recoveredWorkspace, recoveredRunKey) => {
              if (recoveredRunKey !== input.run_key || recoveredWorkspace.feature_id !== input.feature_id || !pinnedRoot.isStable()) return false;
              const current = resolveStatePinned(cwd, pinnedRoot, { feature_id: input.feature_id, run_key: input.run_key });
              const currentWorkspace = current.state?.specification;
              if (current.invalid || !current.state || !currentWorkspace
                || current.state.run_key !== input.run_key
                || digestOf(currentWorkspace) !== digestOf(recoveredWorkspace)) {
                return false;
              }
              return authorizeCtoSpecificationCompletion(cwd, pinnedRoot, current.state, currentWorkspace, input, claim).ok;
            },
          };
          const recovered = recoverExecutionClaimCompletion(
            cwd,
            input.feature_id,
            conformanceRecord.value as unknown as ImplementationConformanceResult,
            pinnedRoot,
            recoveryAuthorization,
          );
          if (recovered && !recovered.ok) return { ok: false, code: recovered.code, error: `${recovered.code}: ${recovered.error}`, state };
        }
      }
    }
    const cap = activeCapability(state.dispatch_capability);
    if (isCtoSpecificationCompletionEnvelope(input)) {
      const authorized = authorizeCtoSpecificationCompletion(cwd, pinnedRoot, state, workspace, input);
      if (!authorized.ok) return { ok: false, code: "SPEC_STATE_INVALID", error: authorized.error, state };
    } else {
      if (!cap) return { ok: false, code: "SPEC_STATE_INVALID", error: "dispatch capability unavailable", state };
      if (cap.status === "invalidated") return { ok: false, code: "SPEC_STATE_INVALID", error: "capability invalidated", state };
      const authError = auth(cap, input, cap.advance_token_hash);
      if (authError) return { ok: false, code: "SPEC_STATE_INVALID", error: authError, state };
    }
    if (!SPEC_GUARDED_WORKSPACE_STATUSES[workspace.status]) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: `SPEC_STATE_INVALID: specification execution completion requires an active execution workspace, saw '${workspace.status}'`, state };
    }
    if (workspace.status === "completed" && workspace.execution_claim_ref && workspace.implementation_conformance_ref) {
      const conformanceRecord = specificationArtifactRecord(pinnedRoot, workspace, "implementation_conformance", workspace.implementation_conformance_ref);
      if (conformanceRecord.ok) {
        const conformanceValidation = validateImplementationConformance(conformanceRecord.value);
        const nestedIssues = conformanceValidation.ok
          ? nestedConformanceEvidenceIssues(pinnedRoot, workspace, conformanceRecord.value as unknown as ImplementationConformanceResult)
          : [];
        if (conformanceValidation.ok && nestedIssues.length === 0) {
          const recovered = recoverExecutionClaimCompletion(
            cwd,
            input.feature_id,
            conformanceRecord.value as unknown as ImplementationConformanceResult,
            pinnedRoot,
          );
          if (recovered && !recovered.ok) return { ok: false, code: recovered.code, error: `${recovered.code}: ${recovered.error}`, state };
        }
      }
    }
    const evidence = loadSpecificationExecutionEvidence(pinnedRoot, workspace);
    if (!evidence.ok) return { ok: false, code: evidence.code, error: `${evidence.code}: ${evidence.error}`, state };
    const { claim, conformance } = evidence;
    if (claim.status === "completed") {
      if (workspace.status !== "completed" || workspace.implementation_conformance_ref !== conformance.conformance_id) {
        return { ok: false, code: "SPEC_CLAIM_RECOVERY_REQUIRED", error: "completed claim and workspace postimages are not paired", state };
      }
      return {
        ok: true,
        state,
        claim,
        workspace,
        next_action: workspace.next_action,
        disposition: "replayed",
        replayed: true,
      };
    }
    const completion = completeExecutionClaim(cwd, input.feature_id, {
      claim_id: claim.claim_id,
      handoff_digest: claim.handoff_digest,
      owner_kind: claim.owner_kind,
      owner_run_id: claim.owner_run_id,
      conformance,
      expected_workspace_digest: digestOf(workspace),
      expected_state_revision: selectedStateRevision(state),
      expected_conformance_ref: workspace.implementation_conformance_ref,
      ...(cap ? { expected_capability: { capability_id: cap.capability_id, capability_epoch: cap.issued_for.cursor_epoch } } : {}),
    }, pinnedRoot);
    if (!completion.ok) {
      return { ok: false, code: completion.code, error: `${completion.code}: ${completion.error}`, state };
    }
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "SPEC_PATH_UNAUTHORIZED: root changed after finalizer commit", state };
    const finalTarget = resolveStatePinned(cwd, pinnedRoot, { feature_id: input.feature_id, run_key: input.run_key });
    const finalWorkspace = finalTarget.state?.specification;
    if (finalTarget.invalid || !finalTarget.state || !finalWorkspace) {
      return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "SPEC_PATH_UNAUTHORIZED: completed workspace could not be reread from the pinned root", state };
    }
    if (finalWorkspace.status !== "completed"
      || finalWorkspace.execution_claim_ref !== completion.value.claim_id
      || finalWorkspace.implementation_conformance_ref !== conformance.conformance_id) {
      return { ok: false, code: "SPEC_CLAIM_PERSIST_FAILED", error: "claim and completed workspace postimages were not paired", state: finalTarget.state };
    }
    return {
      ok: true,
      state: finalTarget.state,
      claim: completion.value,
      workspace: finalWorkspace,
      next_action: finalWorkspace.next_action,
      disposition: "created",
      replayed: false,
    };
  } finally {
    if (!suppliedPinnedRoot) pinnedRoot.close();
  }
}
export function completeSpecificationExecution(
  cwd: string,
  input: CtoSpecificationCompletionEnvelope,
  options: { pinnedRoot?: PinnedProjectRoot; runtimeAccess: CtoRuntimeAccessFacade; sessionId: string },
): SpecificationExecutionCompletionResult;
export function completeSpecificationExecution(
  cwd: string,
  input: DispatchAuth & { feature_id: string },
  options?: { pinnedRoot?: PinnedProjectRoot },
): SpecificationExecutionCompletionResult;
export function completeSpecificationExecution(
  cwd: string,
  input: SpecificationExecutionCompletionInput,
  options: { pinnedRoot?: PinnedProjectRoot; runtimeAccess?: CtoRuntimeAccessFacade; sessionId?: string } = {},
): SpecificationExecutionCompletionResult {
  const suppliedPinnedRoot = options.pinnedRoot;
  if (!isCtoSpecificationCompletionEnvelope(input)) {
    return completeSpecificationExecutionUnlocked(cwd, input, suppliedPinnedRoot);
  }
  if (!options.runtimeAccess || typeof options.sessionId !== "string" || options.sessionId.trim().length === 0) {
    return { ok: false, code: "SPEC_STATE_INVALID", error: "SPEC_STATE_INVALID: CTO execution completion requires authenticated runtime access and session" };
  }
  const pinnedRoot = suppliedPinnedRoot ?? PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) {
    return {
      ok: false,
      code: "SPEC_PATH_UNAUTHORIZED",
      error: "SPEC_PATH_UNAUTHORIZED: project root cannot be pinned for CTO execution completion",
    };
  }
  try {
    assertCtoRuntimeAccessFacadeLive(options.runtimeAccess, pinnedRoot.canonical_root, options.sessionId);
    options.runtimeAccess.assertProjectRoot(pinnedRoot.canonical_root);
    const result = options.runtimeAccess.withRunTransaction(input.owner_run_key, (transaction) => {
      const runtimeState = transaction.readState();
      if (runtimeState.id !== input.owner_run_key) {
        return { ok: false, code: "SPEC_STATE_INVALID", error: "SPEC_STATE_INVALID: CTO runtime transaction selected a different run" } as SpecificationExecutionCompletionResult;
      }
      const runtimeWorkIdentity = runtimeState.work_identity;
      if (runtimeState.standby === true
        || runtimeState.owner_session !== options.sessionId
        || !runtimeWorkIdentity
        || runtimeWorkIdentity.session_id !== options.sessionId) {
        return { ok: false, code: "SPEC_STATE_INVALID", error: "SPEC_STATE_INVALID: CTO execution completion session does not own the canonical runtime state" } as SpecificationExecutionCompletionResult;
      }
      options.runtimeAccess!.assertLive();
      const completed = completeSpecificationExecutionUnlocked(cwd, input, pinnedRoot);
      options.runtimeAccess!.assertLive();
      return completed;
    });
    return result;
  } catch (error) {
    return {
      ok: false,
      code: "SPEC_STATE_INVALID",
      error: `SPEC_STATE_INVALID: CTO execution transaction lock failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (!suppliedPinnedRoot) pinnedRoot.close();
  }
}
/**
 * Resume an already persisted stage without reissuing its bearer secrets.
 * This path is only used by the engine after it has reconstructed and
 * validated the exact profile/config/policy/work postimage.
 */
function dispatchConstitutionGuard(
  state: TeamState,
  pinnedRoot: PinnedProjectRoot,
): (() => void) | undefined {
  const workspace = state.specification;
  if (!workspace?.constitution_binding) return undefined;
  return () => {
    const error = workspaceConstitutionError(pinnedRoot, workspace);
    if (error) throw new Error(error);
  };
}

function rosterMappingProofError(
  cwd: string,
  state: TeamState,
  capability: ActiveCapability,
  pinnedRoot: PinnedProjectRoot,
  proof: unknown,
): string | null {
  const profile = loadProfile(capability.issued_for.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === capability.issued_for.stage_cursor);
  if (!stage?.roster_policy) return null;
  if (proof === undefined) return `workflow stage '${stage.id}' requires an engine-issued trusted agent mapping proof before dispatch`;
  const config = resolveConfig(cwd, undefined, pinnedRoot);
  const bound = bindTrustedMapping(cwd, pinnedRoot, config, proof);
  return bound.ok ? null : bound.error;
}

function runGuardedDispatchAuthorization<T extends TransitionResult>(
  cwd: string,
  input: { feature_id?: string; run_key?: string },
  mutation: (state: TeamState, target: ResolvedState, pinnedRoot: PinnedProjectRoot, guard: () => void) => T,
  options: DurableTransactionOptions = {},
): T {
  let preCommitConstitutionGuard: (() => void) | undefined;
  return runDurableTransaction(cwd, input, (state, target, pinnedRoot) => {
    const guard = dispatchConstitutionGuard(state, pinnedRoot);
    if (guard) {
      preCommitConstitutionGuard = guard;
      try { guard(); } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), state } as T;
      }
    }
    return mutation(state, target, pinnedRoot, guard ?? (() => {}));
  }, {
    ...options,
    preCommit: () => {
      options.preCommit?.();
      preCommitConstitutionGuard?.();
    },
  });
}

/**
 * Resume an already persisted stage without reissuing its bearer secrets.
 * This path is only used by the engine after it has reconstructed and
 * validated the exact profile/config/policy/work postimage.
 */
export function authorizeDispatchFromPersisted(
  cwd: string,
  input: PersistedStagePostimage,
  options?: DurableTransactionOptions & TrustedMappingOptions,
): TransitionResult {
  let consumeProof = false;
  const result = runGuardedDispatchAuthorization(cwd, input, (state, target, pinnedRoot, guard) => {
    const cap = activeCapability(state.dispatch_capability);
    if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
    const mappingError = rosterMappingProofError(cwd, state, cap, pinnedRoot, options?.trustedMappingProof);
    if (mappingError) return { ok: false, error: mappingError, state };
    const error = persistedStageAuthError(state, cap, input);
    if (error) return { ok: false, error, state };
    guard();
    const result = authorizeBoundRecord(cwd, state, target, cap, { ...input, token: "__persisted_stage_postimage__" });
    if (result.ok && options?.trustedMappingProof !== undefined) consumeProof = true;
    return result;
  }, {
    ...(options ?? {}),
    postCommit: () => {
      options?.postCommit?.();
      if (consumeProof) consumeTrustedMappingProof(options?.trustedMappingProof);
    },
  });
  return result;
}

/** Persist authorization before any native task is executed. */
export function authorizeDispatch(cwd: string, authInput: DispatchAuth, options?: DurableTransactionOptions & TrustedMappingOptions): TransitionResult {
  let consumeProof = false;
  const result = runGuardedDispatchAuthorization(cwd, authInput, (state, target, pinnedRoot, guard) => {
    const authorized = authorizeDispatchMutation(cwd, state, target, pinnedRoot, authInput, options?.trustedMappingProof, options?.requireNativePreparationMarker === true);
    if (authorized.ok) {
      guard();
      if (options?.trustedMappingProof !== undefined) consumeProof = true;
    }
    return authorized;
  }, {
    ...(options ?? {}),
    postCommit: () => {
      options?.postCommit?.();
      if (consumeProof) consumeTrustedMappingProof(options?.trustedMappingProof);
    },
  });
  return result;
}

function nativePreparationMarkerError(state: TeamState, pinnedRoot: PinnedProjectRoot, input: DispatchAuth): string | null {
  if (state.specification?.source_kind !== "native") return null;
  const handoff = state.preparation_handoff;
  if (!handoff) return "native specification dispatch requires the persisted authenticated preparation_handoff";
  if (!verifyPreparationHandoffDigest(handoff) || !verifyPreparationHandoffAuth(pinnedRoot, handoff)) {
    return "native specification dispatch requires an authenticated preparation_handoff";
  }
  const marker = state.preparation_start;
  if (!marker || (marker.status !== "begun" && marker.status !== "started")) {
    return "native specification dispatch requires the engine-issued composite preparation marker";
  }
  if (marker.phase !== input.stage_cursor
    || marker.capability_id !== input.capability_id
    || marker.request_id !== input.tool_call_id
    || marker.token !== handoff.token
    || marker.preparation_digest !== handoff.digest
    || marker.preparation_state_revision !== handoff.state_revision) {
    return "native specification dispatch preparation marker is stale or not bound to this request";
  }
  return null;
}

function nativePreparationValidationError(state: TeamState, pinnedRoot: PinnedProjectRoot, input: DispatchAuth): string | null {
  if (state.specification?.source_kind !== "native") return null;
  const handoff = state.preparation_handoff;
  if (!handoff || !verifyPreparationHandoffDigest(handoff) || !verifyPreparationHandoffAuth(pinnedRoot, handoff)) {
    return "native validation dispatch requires the exact authenticated preparation_handoff";
  }
  const marker = state.preparation_start;
  if (!marker || marker.status !== "started") {
    return "native validation dispatch requires the engine-issued composite preparation marker";
  }
  if (marker.phase !== input.stage_cursor
    || marker.capability_id !== input.capability_id
    || marker.token !== handoff.token
    || marker.preparation_digest !== handoff.digest
    || marker.preparation_state_revision !== handoff.state_revision) {
    return "native validation dispatch preparation marker is stale or not bound to this capability";
  }
  return null;
}

function authorizeDispatchMutation(cwd: string, state: TeamState, target: ResolvedState, pinnedRoot: PinnedProjectRoot, authInput: DispatchAuth, proof?: TrustedMappingProof, requireNativePreparationMarker = false): TransitionResult {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const stateBindingError = stateCapabilityBindingError(state, cap, pinnedRoot, authInput.feature_id);
  if (stateBindingError) return { ok: false, error: stateBindingError, state };
  if (requireNativePreparationMarker) {
    const preparationError = nativePreparationMarkerError(state, pinnedRoot, authInput);
    if (preparationError) return { ok: false, error: preparationError, state };
  }
  const mappingError = rosterMappingProofError(cwd, state, cap, pinnedRoot, proof);
  if (mappingError) return { ok: false, error: mappingError, state };
  const error = auth(cap, authInput, cap.dispatch_token_hash);
  if (error) return { ok: false, error, state };
  return authorizeBoundRecord(cwd, state, target, cap, authInput);
}

export type SpecificationPhaseDispatchMutation<T> =
  | { ok: true; state: TeamState; value: T }
  | { ok: false; error: string; state?: TeamState };

/** Authorize a native phase dispatch and apply its workspace transition in one locked state transaction. */
export function authorizeSpecificationPhaseDispatchWithMutation<T>(
  cwd: string,
  input: DispatchAuth & { feature_id: string; request_id: string },
  mutate: (state: TeamState, target: ResolvedState, record: DispatchRecord) => SpecificationPhaseDispatchMutation<T>,
  options: { rootGuard?: StateRootGuard; pinnedRoot?: PinnedProjectRoot; preCommit?: () => void; postCommit?: () => void; trustedMappingProof?: TrustedMappingProof } = {},
): SpecificationDispatchLifecycleResult & { value?: T } {
  if (!isSafeStateSegment(input.feature_id)) return { ok: false, error: "an explicit safe feature_id is required for specification dispatch" };
  if (!input.run_key?.trim()) return { ok: false, error: "an explicit nonblank run_key is required for specification dispatch" };
  if (!input.request_id?.trim()) return { ok: false, error: "a nonblank request_id is required for idempotent specification dispatch" };
  type TransactionResult = SpecificationDispatchLifecycleResult & { value?: T };
  let consumeProof = false;
  return runGuardedDispatchAuthorization<TransactionResult>(cwd, input, (state, target, pinnedRoot, guard) => {
    const authorized = authorizeDispatchMutation(cwd, state, target, pinnedRoot, { ...input, tool_call_id: input.request_id }, options.trustedMappingProof, true);
    if (!authorized.ok || !authorized.record?.work_identity) {
      return { ok: false, error: authorized.ok ? "dispatch authorization produced no work identity" : authorized.error, state: authorized.state };
    }
    if (authorized.record.tool_call_id !== input.request_id) {
      return { ok: false, error: "request_id does not match the authorized dispatch", state: authorized.state };
    }
    guard();
    const authorizedState = authorized.state ?? state;
    const transition = mutate(authorizedState, target, authorized.record);
    if (!transition.ok) return transition;
    if (options.trustedMappingProof !== undefined) consumeProof = true;
    return {
      ok: true,
      state: transition.state,
      record: authorized.record,
      work_identity: authorized.record.work_identity,
      capability_epoch: authorized.record.work_identity.capability_epoch,
      value: transition.value,
    };
  }, {
    ...options,
    postCommit: () => {
      options.postCommit?.();
      if (consumeProof) consumeTrustedMappingProof(options.trustedMappingProof);
    },
  });
}

export interface TrustedDispatchInput {
  /** Explicit feature selector for native concurrent phase workers. */
  feature_id?: string;
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  role: string;
  slot_id?: string;
  task_id?: string;
  agent: string;
  tool_call_id: string;
  expected_count?: number;
  retry_of?: string;
}

/** Authorize a task after the trusted runtime gate validated its marker. */
export function authorizeDispatchTrusted(cwd: string, input: TrustedDispatchInput, options?: DurableTransactionOptions & TrustedMappingOptions): TransitionResult {
  let consumeProof = false;
  const result = runGuardedDispatchAuthorization(cwd, input, (state, target, pinnedRoot, guard) => {
    const authorized = authorizeDispatchTrustedMutation(cwd, state, target, pinnedRoot, input, options?.trustedMappingProof);
    if (authorized.ok) {
      guard();
      if (options?.trustedMappingProof !== undefined) consumeProof = true;
    }
    return authorized;
  }, {
    ...(options ?? {}),
    postCommit: () => {
      options?.postCommit?.();
      if (consumeProof) consumeTrustedMappingProof(options?.trustedMappingProof);
    },
  });
  return result;
}

function authorizeDispatchTrustedMutation(cwd: string, state: TeamState, target: ResolvedState, pinnedRoot: PinnedProjectRoot, input: TrustedDispatchInput, proof?: TrustedMappingProof): TransitionResult {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const stateBindingError = stateCapabilityBindingError(state, cap, pinnedRoot, input.feature_id);
  if (stateBindingError) return { ok: false, error: stateBindingError, state };
  const mappingError = rosterMappingProofError(cwd, state, cap, pinnedRoot, proof);
  if (mappingError) return { ok: false, error: mappingError, state };
  const binding = cap.issued_for;
  if (
    input.capability_id !== cap.capability_id
    || input.run_key !== binding.run_key
    || input.branch !== binding.branch
    || input.workflow !== binding.workflow
    || input.profile_hash !== binding.profile_hash
    || input.stage_cursor !== binding.stage_cursor
    || input.cursor_epoch !== binding.cursor_epoch
  ) return { ok: false, error: "capability binding mismatch", state };
  if (!input.tool_call_id) return { ok: false, error: "tool call identity required", state };
  return authorizeBoundRecord(cwd, state, target, cap, {
    token: "__trusted_gate__",
    capability_id: input.capability_id,
    run_key: input.run_key,
    branch: input.branch,
    workflow: input.workflow,
    profile_hash: input.profile_hash,
    stage_cursor: input.stage_cursor,
    cursor_epoch: input.cursor_epoch,
    role: input.role,
    slot_id: input.slot_id,
    task_id: input.task_id,
    agent: input.agent,
    tool_call_id: input.tool_call_id,
    expected_count: input.expected_count,
    retry_of: input.retry_of,
  });
}

type CompletionInput = {
  outcome: DispatchCompletion["outcome"];
  evidence: string;
  artifact_ids?: string[];
  completed_by?: DispatchCompletion["completed_by"];
  terminal_signal?: CompletionEnvelope["terminal_signal"];
  provider_id?: string;
};

function pendingRecord(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  record: DispatchRecord,
  reason: PendingState["pending_reason"] = "provider_running",
  providerRef?: string,
): TransitionResult {
  if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") return { ok: false, error: "terminal dispatch cannot become pending", state };
  const identity = record.work_identity ?? workIdentityFor(state, cap, record.role, record.agent, record.id, record.attempt);
  const previous = record.pending;
  if (previous?.status === "pending" && previous.provider_ref === providerRef && previous.pending_reason === reason) return { ok: true, state, record };
  if (previous?.status === "pending" && previous.provider_ref !== providerRef) return { ok: false, error: "conflicting pending replay", state };
  const pending = pendingFor(identity, "pending", reason, providerRef, previous?.retry_of ?? null);
  const envelope = completionEnvelopeFor(identity, "pending", null, [], providerRef ?? reason, "engine_task_caller");
  const updated: DispatchRecord = {
    ...record,
    status: "pending",
    work_identity: identity,
    pending,
    completion_envelope: envelope,
  };
  const nextCapability = {
    ...cap,
    status: "dispatched" as const,
    dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? updated : candidate),
    pending: [...(cap.pending ?? []).filter((candidate) => candidate.identity.dispatch_id !== record.id), pending],
  };
  const next: TeamState = {
    ...state,
    work_identity: identity,
    pending,
    completion_envelope: envelope,
    dispatch_capability: nextCapability,
    pause: { kind: "background_wait", reason: providerRef ? `provider work pending (${providerRef})` : "provider work remains pending" },
    updated_at: now(),
  };
  return { ok: true, state: next, record: updated };
}
function nativeReconciliationDigest(
  identity: WorkIdentity,
  outcome: DispatchCompletion["outcome"],
  evidence: string,
  artifact_ids: string[],
  terminal_signal: CompletionEnvelope["terminal_signal"],
  provider_id?: string,
): string {
  return digestOf({ identity, outcome, evidence, artifact_ids, terminal_signal, ...(provider_id ? { provider_id } : {}) });
}

function deferNativeCompletion(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  record: DispatchRecord,
  input: CompletionInput,
  artifact_ids: string[],
): TransitionResult {
  const identity = record.work_identity ?? workIdentityFor(state, cap, record.role, record.agent, record.id, record.attempt);
  const terminalSignal = input.terminal_signal ?? "native_tool_result";
  const providerId = input.provider_id;
  const result_digest = nativeReconciliationDigest(identity, input.outcome, input.evidence, artifact_ids, terminalSignal, providerId);
  const existing = record.pending?.reconciliation;
  if (existing) {
    if (existing.result_digest === result_digest) return { ok: true, state, record };
    return { ok: false, error: "conflicting native artifact reconciliation", state };
  }
  const pendingResult = pendingRecord(cwd, state, target, cap, record, "awaiting_result", "native-artifact-reconciliation");
  if (!pendingResult.ok || !pendingResult.record || !pendingResult.state.dispatch_capability) return pendingResult;
  const pending = pendingResult.record.pending;
  if (!pending) return { ok: false, error: "native artifact reconciliation pending state missing", state };
  const reconciliation: PendingReconciliation = {
    identity,
    result_digest,
    outcome: input.outcome,
    evidence: input.evidence,
    artifact_ids: [...artifact_ids],
    terminal_signal: terminalSignal,
    ...(providerId ? { provider_id: providerId } : {}),
    updated_at: now(),
  };
  const updatedPending = { ...pending, reconciliation };
  const updatedRecord = { ...pendingResult.record, pending: updatedPending };
  const pendingCapability = activeCapability(pendingResult.state.dispatch_capability);
  if (!pendingCapability) return { ok: false, error: "native artifact reconciliation capability disappeared", state };
  const dispatch_capability = {
    ...pendingCapability,
    dispatches: pendingCapability.dispatches.map((candidate) => candidate.id === record.id ? updatedRecord : candidate),
  };
  const next = {
    ...pendingResult.state,
    pending: updatedPending,
    dispatch_capability,
    completion_envelope: updatedRecord.completion_envelope,
    work_identity: updatedRecord.work_identity,
  };
  return { ok: true, state: next, record: updatedRecord };
}

function withDispatchLifecycle(
  state: TeamState,
  capability: ActiveCapability,
  terminalIdentity: WorkIdentity,
  terminalEnvelope?: CompletionEnvelope,
): TeamState {
  const activeRecord = capability.dispatches.find((candidate) => candidate.status === "pending" || candidate.status === "running");
  const { pending: _pending, completion_envelope: _completionEnvelope, ...stateWithoutLifecycle } = state;
  if (activeRecord?.pending) {
    return {
      ...stateWithoutLifecycle,
      work_identity: activeRecord.pending.identity,
      pending: activeRecord.pending,
      ...(activeRecord.completion_envelope ? { completion_envelope: activeRecord.completion_envelope } : {}),
    };
  }
  return {
    ...stateWithoutLifecycle,
    work_identity: terminalIdentity,
    ...(terminalEnvelope ? { completion_envelope: terminalEnvelope } : {}),
  };
}

/** Persist a neutral provider-running state before returning to the caller. */
export function persistPendingDispatch(
  cwd: string,
  input: DispatchAuth & { dispatch_id: string; pending_reason?: PendingState["pending_reason"]; provider_ref?: string },
): TransitionResult {
  let guardedWorkspace: FeatureWorkspace | undefined;
  let guardedRoot: PinnedProjectRoot | undefined;
  return runDurableTransaction(cwd, input, (state, target, pinnedRoot) => {
    guardedRoot = pinnedRoot;
    guardedWorkspace = state.specification;
    if (guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
      const constitutionError = workspaceConstitutionError(pinnedRoot, guardedWorkspace);
      if (constitutionError) return { ok: false, error: constitutionError, state };
    }
    return persistPendingDispatchMutation(cwd, state, target, pinnedRoot, input);
  }, {
    preCommit: () => {
      if (guardedRoot && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
        const constitutionError = workspaceConstitutionError(guardedRoot, guardedWorkspace);
        if (constitutionError) throw new Error(constitutionError);
      }
    },
  });
}

function persistPendingDispatchMutation(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  input: DispatchAuth & { dispatch_id: string; pending_reason?: PendingState["pending_reason"]; provider_ref?: string },
): TransitionResult {
  const cap = activeCapability(state.dispatch_capability);
  if (cap) {
    const stateBindingError = stateCapabilityBindingError(state, cap, pinnedRoot, input.feature_id);
    if (stateBindingError) return { ok: false, error: stateBindingError, state };
  }
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const error = auth(cap, input, cap.dispatch_token_hash);
  if (error) return { ok: false, error, state };
  const record = cap.dispatches.find((candidate) => candidate.id === input.dispatch_id);
  if (!record) return { ok: false, error: "unknown dispatch", state };
  if (input.role !== undefined && input.role !== record.role) return { ok: false, error: "dispatch slot mismatch", state };
  return pendingRecord(cwd, state, target, cap, record, input.pending_reason, input.provider_ref);
}

/** Alias retained for adapters that name the transition as a lifecycle update. */
export const markDispatchPending = persistPendingDispatch;

function completeRecord(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  cap: ActiveCapability,
  record: DispatchRecord,
  input: CompletionInput,
  beforeArtifactWrite?: () => void,
  registerRollback?: (cleanup: () => void) => void,
): TransitionResult {
  const inputError = workflowCompletionInputError({ artifact_ids: input.artifact_ids });
  if (inputError) return { ok: false, error: inputError, state };
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  if (!input.evidence.trim()) return { ok: false, error: "completion evidence required", state };
  const artifact_ids = input.artifact_ids ?? [];
  const workflowProfile = loadProfile(cap.issued_for.workflow);
  const currentStage = workflowProfile?.stages.find((candidate) => candidate.id === cap.issued_for.stage_cursor);
  if (!currentStage) return { ok: false, error: "invalid workflow state: current stage definition is unavailable", state };
  const declaredProduces = stageProduces(currentStage);
  const expectedSet = new Set(declaredProduces);
  if (expectedSet.size !== declaredProduces.length) {
    return { ok: false, error: "invalid workflow state: current stage.produces contains duplicate artifact identifiers", state };
  }
  const exactArtifactSet = (actual: string[], expected: string[]): boolean =>
    actual.length === expected.length && new Set(actual).size === expectedSet.size && actual.every((id) => expectedSet.has(id));
  const previousCompletion = record.completion;
  if (previousCompletion && !exactArtifactSet(previousCompletion.artifact_ids, declaredProduces)) {
    return { ok: false, error: "invalid workflow state: persisted completion artifact ids do not match current stage.produces", state };
  }
  if (!exactArtifactSet(artifact_ids, declaredProduces)) {
    return { ok: false, error: "completion artifact ids must exactly match current stage.produces", state };
  }
  const artifactsDirRelative = artifactsRelativeFor(pinnedRoot, target);
  if (artifactsDirRelative === null) return { ok: false, error: "workflow artifact directory is unavailable or outside the pinned project root", state };
  const pendingRecoverySlotId = cap.kind === "consilium" && cap.expected_count > 1
    ? record.pending?.reconciliation?.identity.slot_id
    : undefined;
  const candidateSlotId = pendingRecoverySlotId
    ?? (cap.kind === "consilium" && cap.expected_count > 1 ? record.work_identity?.slot_id : undefined);
  const namespacedReady = candidateSlotId !== undefined
    && artifact_ids.every((id) => artifactExistsPinned(pinnedRoot, artifactsDirRelative, durableNamespacedArtifactId(id, candidateSlotId)));
  const logicalReady = artifact_ids.every((id) => artifactExistsPinned(pinnedRoot, artifactsDirRelative, id));
  const recoverySlotId = pendingRecoverySlotId ?? (!logicalReady && namespacedReady ? candidateSlotId : undefined);
  const sourceIds = recoverySlotId
    ? Object.fromEntries(artifact_ids.map((id) => [id, durableNamespacedArtifactId(id, recoverySlotId)]))
    : undefined;
  if (previousCompletion && record.completion_envelope) {
    const refs: CompletionArtifactRef[] = record.completion_envelope.artifact_refs;
    if (
      refs.length !== previousCompletion.artifact_ids.length
      || new Set(refs.map((reference: CompletionArtifactRef) => reference.artifact_id)).size !== refs.length
      || refs.some((reference: CompletionArtifactRef) => !previousCompletion.artifact_ids.includes(reference.artifact_id))
    ) {
      return { ok: false, error: "completion artifact references do not match the persisted artifact ids", state };
    }
    const integrityError = completionArtifactRefsError(pinnedRoot, artifactsDirRelative, record.completion_envelope, sourceIds);
    if (integrityError) return { ok: false, error: integrityError, state };
  }
  const declaredArtifacts = state.artifacts ?? {};
  const missingArtifacts = artifact_ids.some((id) => {
    const storageId = sourceIds?.[id] ?? id;
    return !artifactExistsPinned(pinnedRoot, artifactsDirRelative, storageId)
      && !Object.prototype.hasOwnProperty.call(declaredArtifacts, id);
  });
  const unsafeArtifacts = new Set(artifact_ids).size !== artifact_ids.length || artifact_ids.some((id) => !isSafeStateSegment(id));
  const sameOutcome = previousCompletion?.outcome === input.outcome;
  const sameArtifacts = previousCompletion !== undefined && exactArtifactSet(previousCompletion.artifact_ids, artifact_ids);
  if (unsafeArtifacts || missingArtifacts) return { ok: false, error: "declared artifact missing or unsafe", state };
  if (previousCompletion && !(sameOutcome && sameArtifacts)) return { ok: false, error: "conflicting replay", state };
  const identity = record.work_identity ?? workIdentityFor(state, cap, record.role, record.agent, record.id, record.attempt);
  const completedBy = input.completed_by ?? "workflow_complete";
  const terminalSignal = input.terminal_signal ?? (completedBy === "synchronous_tool_result" ? "native_tool_result" : "workflow_complete");
  const snapshotted = snapshotSlotArtifacts(state, cap, record, artifact_ids, input.provider_id, declaredProduces, pinnedRoot, artifactsDirRelative, beforeArtifactWrite, registerRollback);
  if (snapshotted.ok === false) {
    if (snapshotted.retryable && previousCompletion) {
      const identity = record.work_identity ?? workIdentityFor(state, cap, record.role, record.agent, record.id, record.attempt);
      const deferredCompletion: DispatchCompletion = {
        ...previousCompletion,
        artifact_ids,
        evidence: input.evidence,
        work_identity: identity,
      };
      const deferredEnvelope = completionEnvelopeFor(identity, input.outcome, "native_tool_result", completionArtifactRefs(pinnedRoot, artifactsDirRelative, artifact_ids, sourceIds), input.evidence, "synchronous_tool_result");
      const deferredIntegrityError = completionArtifactRefsError(pinnedRoot, artifactsDirRelative, deferredEnvelope, sourceIds);
      if (deferredIntegrityError) return { ok: false, error: deferredIntegrityError, state };
      const deferredRecord: DispatchRecord = { ...record, work_identity: identity, completion: deferredCompletion, completion_envelope: deferredEnvelope };
      const deferredCapability = {
        ...cap,
        dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? deferredRecord : candidate),
      };
      const deferredState: TeamState = {
        ...withDispatchLifecycle(state, deferredCapability, identity, deferredEnvelope),
        dispatch_capability: deferredCapability,
      };
      return { ok: true, state: deferredState, record: deferredRecord };
    }
    return { ok: false, error: snapshotted.error, state };
  }
  if (previousCompletion && sameOutcome && sameArtifacts) {
    const replayedRecord: DispatchRecord = { ...record, work_identity: identity };
    const replayedCapability = {
      ...cap,
      dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? replayedRecord : candidate),
    };
    const replayedState: TeamState = {
      ...withDispatchLifecycle(snapshotted.state, replayedCapability, identity, record.completion_envelope),
      dispatch_capability: replayedCapability,
    };
    return { ok: true, state: replayedState, record: replayedRecord };
  }
  const completedAt = now();
  const completion: DispatchCompletion = {
    dispatch_id: record.id,
    cursor_epoch: cap.issued_for.cursor_epoch,
    outcome: input.outcome,
    artifact_ids,
    evidence: input.evidence,
    completed_by: completedBy,
    completed_at: completedAt,
    work_identity: identity,
  };
  const envelope = completionEnvelopeFor(identity, input.outcome, terminalSignal, completionArtifactRefs(pinnedRoot, artifactsDirRelative, artifact_ids, sourceIds), input.evidence, completedBy);
  const integrityError = completionArtifactRefsError(pinnedRoot, artifactsDirRelative, envelope, sourceIds);
  if (integrityError) return { ok: false, error: integrityError, state };
  const terminalPending = pendingFor(identity, input.outcome, undefined, undefined, record.pending?.retry_of ?? null);
  const updated: DispatchRecord = {
    ...record,
    status: input.outcome,
    completed_at: completedAt,
    work_identity: identity,
    pending: terminalPending,
    completion,
    completion_envelope: envelope,
  };
  const nextCapability = {
    ...cap,
    dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? updated : candidate),
    pending: [...(cap.pending ?? []).filter((candidate) => candidate.identity.dispatch_id !== record.id), terminalPending],
  };
  const activePendingRecord = nextCapability.dispatches.find((candidate) => candidate.status === "pending" || candidate.status === "running");
  const next: TeamState = {
    ...withDispatchLifecycle(snapshotted.state, nextCapability, identity, envelope),
    dispatch_capability: nextCapability,
    pause: activePendingRecord ? { kind: "background_wait", reason: "provider work remains pending" } : { kind: "none", reason: "" },
  };
  return { ok: true, state: next, record: updated };
}

/**
 * For multi-slot consilium stages, capture each slot's artifact content into
 * a namespaced snapshot (`<id>-<slot>.json`) at completion time, before a
 * later slot can overwrite the shared file. Recording the same artifact for
 * the same slot twice with different content is a collision and fails
 * closed. The namespaced snapshots are the provenance source for the
 * deterministic synthesis performed at advance.
 */
function snapshotSlotArtifacts(
  state: TeamState,
  cap: ActiveCapability,
  record: DispatchRecord,
  artifactIds: string[],
  providerId: string | undefined,
  declaredProduces: string[],
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
  beforeArtifactWrite?: () => void,
  registerRollback?: (cleanup: () => void) => void,
): { ok: true; state: TeamState } | { ok: false; error: string; retryable?: boolean } {
  if (cap.kind !== "consilium" || cap.expected_count <= 1 || artifactIds.length === 0) {
    return { ok: true, state };
  }
  const stageId = cap.issued_for.stage_cursor;
  const existing = state.slot_artifacts?.[stageId] ?? { slots: {} };
  const slots = { ...existing.slots };
  const exactProviderId = providerId ?? record.agent;
  const exactSlotId = record.work_identity?.slot_id ?? record.role;
  const slotMap = { ...(slots[exactSlotId] ?? {}) };
  const values: Array<{
    id: string;
    value: unknown;
    rawBytes: Buffer;
    rawDev: number;
    rawIno: number;
    envelopeBytes: Buffer;
  }> = [];
  const namespacedReady = artifactIds.every((id) => artifactExistsPinned(
    pinnedRoot,
    artifactsDirRelative,
    durableNamespacedArtifactId(id, exactSlotId),
  ));
  const logicalMissing = artifactIds.some((id) => !artifactExistsPinned(pinnedRoot, artifactsDirRelative, id));
  const slotBoundRecovery = record.pending?.reconciliation?.identity.slot_id === exactSlotId
    || (logicalMissing && namespacedReady);
  for (const id of artifactIds) {
    const logicalId = declaredProduces.find((produce) =>
      id === durableNamespacedArtifactId(produce, exactSlotId)
      || id === legacyNamespacedArtifactId(produce, exactSlotId),
    ) ?? id;
    const storedSlotId = durableNamespacedArtifactId(logicalId, exactSlotId);
    const readId = slotBoundRecovery
      ? storedSlotId
      : logicalId !== id && readArtifactPinned(pinnedRoot, artifactsDirRelative, logicalId) !== null ? logicalId : id;
    const readPath = artifactsDirRelative.length > 0 ? `${artifactsDirRelative}/${readId}.json` : `${readId}.json`;
    let rawBytes: Buffer;
    let rawDev: number;
    let rawIno: number;
    let parsedValue: unknown;
    try {
      if (!pinnedRoot.isStable()) throw new Error("project root changed");
      const entry = pinnedRoot.readFile(readPath, { maxBytes: MAX_ARTIFACT_BYTES });
      if (!pinnedRoot.isStable()) throw new Error("project root changed");
      rawBytes = Buffer.from(entry.bytes);
      rawDev = entry.dev;
      rawIno = entry.ino;
      const parsed = parseArtifactJson(rawBytes);
      if (!parsed.ok) throw new Error(parsed.reason);
      parsedValue = parsed.value;
    } catch {
      return {
        ok: false,
        retryable: true,
        error: `slot '${record.role}' artifact '${id}' is not readable yet; retry completion or workflow_advance`,
      };
    }
    let value = parsedValue;
    if (parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      && "$omp_slot_artifact" in parsedValue) {
      const envelope = parsedValue as { $omp_slot_artifact?: unknown; value?: unknown };
      const header = envelope.$omp_slot_artifact;
      if (!header || typeof header !== "object" || Array.isArray(header)) {
        return { ok: false, error: `slot artifact '${id}' has an invalid persisted envelope` };
      }
      const metadata = header as Record<string, unknown>;
      const identity = { artifact_id: metadata.artifact_id, slot_id: metadata.slot_id, provider_id: metadata.provider_id };
      if (
        metadata.artifact_id !== logicalId
        || metadata.slot_id !== exactSlotId
        || metadata.provider_id !== exactProviderId
        || metadata.identity_sha256 !== digestOf(identity)
        || !("value" in envelope)
      ) {
        return { ok: false, error: `slot artifact '${id}' collided with a different slot/provider payload` };
      }
      value = envelope.value;
    }
    const envelopeBytes = Buffer.from(slotArtifactEnvelopeBytes(logicalId, exactSlotId, exactProviderId, value), "utf8");
    if (envelopeBytes.byteLength > MAX_ARTIFACT_BYTES) {
      return { ok: false, error: `slot artifact '${id}' envelope exceeds the ${MAX_ARTIFACT_BYTES}-byte payload limit` };
    }
    values.push({ id: logicalId, value, rawBytes, rawDev, rawIno, envelopeBytes });
  }
  for (const { id, value, rawBytes, rawDev, rawIno, envelopeBytes } of values) {
    const valueSha256 = digestOf(value);
    const previous = slotMap[id];
    if (
      previous
      && (
        (previous.value_sha256 !== undefined && previous.value_sha256 !== valueSha256)
        || (previous.value_sha256 === undefined && previous.sha256 !== valueSha256)
        || (previous.slot_id !== undefined && previous.slot_id !== exactSlotId)
        || (previous.provider_id !== undefined && previous.provider_id !== exactProviderId)
      )
    ) {
      return { ok: false, error: `slot artifact conflict: slot '${record.role}' wrote '${id}' with different content or provider identity` };
    }
    const namespaced = durableNamespacedArtifactId(id, exactSlotId);
    const relativePath = artifactsDirRelative.length > 0 ? `${artifactsDirRelative}/${namespaced}.json` : `${namespaced}.json`;
    const expectedBytes = envelopeBytes;
    let persistedBytes: Buffer;
    let wroteOwnAttempt = false;
    let rollbackToken: ArtifactAtomicWriteRollbackToken | null = null;
    let rollbackRegistered = false;
    const registerAttemptRollback = (): void => {
      if (!registerRollback || rollbackRegistered) return;
      registerRollback(() => { if (rollbackToken) rollbackArtifactAtomicWrite(pinnedRoot, rollbackToken); });
      rollbackRegistered = true;
    };
    const rollbackAttempt = (): void => {
      if (rollbackToken) rollbackArtifactAtomicWrite(pinnedRoot, rollbackToken);
    };
    try {
      if (!pinnedRoot.isStable()) return { ok: false, error: `slot artifact '${id}' could not be persisted safely: project root changed` };
      if (slotBoundRecovery) {
        if (!rawBytes.equals(expectedBytes)) {
          registerAttemptRollback();
          beforeArtifactWrite?.();
          const workspace = state.specification;
          if (workspace && (workspace.source_kind === "native" || workspace.source_kind === "legacy" || workspace.source_kind === "external")) {
            const constitutionError = workspaceConstitutionError(pinnedRoot, workspace);
            if (constitutionError) return { ok: false, error: constitutionError };
          }
          const receipt = pinnedRoot.replaceFileIfMatchesWithReceipt(relativePath, {
            dev: rawDev,
            ino: rawIno,
            sha256: createHash("sha256").update(rawBytes).digest("hex"),
          }, expectedBytes);
          rollbackToken = artifactAtomicWriteRollbackTokenFromReceipt(pinnedRoot, relativePath, receipt);
          wroteOwnAttempt = true;
        }
      } else {
        registerAttemptRollback();
        try {
          beforeArtifactWrite?.();
          const workspace = state.specification;
          if (workspace && (workspace.source_kind === "native" || workspace.source_kind === "legacy" || workspace.source_kind === "external")) {
            const constitutionError = workspaceConstitutionError(pinnedRoot, workspace);
            if (constitutionError) return { ok: false, error: constitutionError };
          }
          const receipt = pinnedRoot.writeExclusiveWithReceipt(relativePath, expectedBytes, { beforePublish: (published) => {
            rollbackToken = artifactAtomicWriteRollbackTokenFromReceipt(pinnedRoot, relativePath, published);
            wroteOwnAttempt = true;
          } });
          rollbackToken ??= artifactAtomicWriteRollbackTokenFromReceipt(pinnedRoot, relativePath, receipt);
          wroteOwnAttempt = true;
        } catch (error) {
          if (!(error instanceof PinnedRootError) || error.code !== "exists") throw error;
          const existingBytes = Buffer.from(pinnedRoot.readFile(relativePath, { maxBytes: MAX_ARTIFACT_BYTES }).bytes);
          if (!existingBytes.equals(expectedBytes)) {
            return { ok: false, error: `slot artifact '${id}' collided with a different slot/provider payload` };
          }
        }
      }
      if (!pinnedRoot.isStable()) {
        rollbackAttempt();
        return { ok: false, error: `slot artifact '${id}' could not be persisted safely: project root changed` };
      }
      // A successful write already owns the exact requested bytes through its
      // operation descriptor. Re-reading the pathname here could adopt a
      // concurrent same-content replacement between publication and capture.
      // Existing idempotent files still require a pinned read for collision
      // validation because this invocation did not publish them.
      persistedBytes = wroteOwnAttempt
        ? Buffer.from(expectedBytes)
        : Buffer.from(pinnedRoot.readFile(relativePath, { maxBytes: MAX_ARTIFACT_BYTES }).bytes);
      if (!pinnedRoot.isStable()) {
        rollbackAttempt();
        return { ok: false, error: `slot artifact '${id}' changed while its exact persisted bytes were recorded` };
      }
    } catch (error) {
      rollbackAttempt();
      if (error instanceof PinnedRootError && error.code === "changed") {
        return { ok: false, error: `slot artifact '${id}' changed while its exact persisted bytes were recorded` };
      }
      return { ok: false, error: `slot artifact '${id}' could not be persisted safely` };
    }
    const persistedSha256 = createHash("sha256").update(persistedBytes).digest("hex");
    if (!persistedBytes.equals(expectedBytes)) {
      rollbackAttempt();
      return { ok: false, error: `slot artifact '${id}' changed while its exact persisted bytes were recorded` };
    }
    slotMap[id] = {
      path: join(pinnedRoot.canonical_root, relativePath),
      sha256: persistedSha256,
      size_bytes: persistedBytes.byteLength,
      artifact_id: id,
      slot_id: exactSlotId,
      provider_id: exactProviderId,
      value_sha256: valueSha256,
      identity_sha256: digestOf({ artifact_id: id, slot_id: exactSlotId, provider_id: exactProviderId }),
    };
  }
  slots[exactSlotId] = slotMap;
  return { ok: true, state: { ...state, slot_artifacts: { ...(state.slot_artifacts ?? {}), [stageId]: { ...existing, slots } } } };
}

export function completeDispatch(
  cwd: string,
  input: DispatchAuth & { dispatch_id: string } & Partial<CompletionInput>,
  options?: DurableTransactionOptions,
): TransitionResult {
  return completeDispatchInternal(cwd, input, options, false);
}

/** Internal completion used only after native phase finalizer validation. */
export function completeNativeSpecificationGeneration(
  cwd: string,
  input: DispatchAuth & { dispatch_id: string } & Partial<CompletionInput>,
  options?: DurableTransactionOptions,
): TransitionResult {
  return completeDispatchInternal(cwd, input, options, true);
}

function completeDispatchInternal(
  cwd: string,
  input: DispatchAuth & { dispatch_id: string } & Partial<CompletionInput>,
  options: DurableTransactionOptions | undefined,
  allowNativeCompositeCompletion: boolean,
): TransitionResult {
  const inputError = workflowCompletionInputError(input);
  if (inputError) return { ok: false, error: inputError };
  let guardedWorkspace: FeatureWorkspace | undefined;
  let guardedRoot: PinnedProjectRoot | undefined;
  const rollbacks: Array<() => void> = [];
  return runDurableTransaction(cwd, input, (state, target, pinnedRoot) => {
    guardedRoot = pinnedRoot;
    guardedWorkspace = state.specification;
    if ((input.pending === true || input.outcome === "succeeded") && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
      const constitutionError = workspaceConstitutionError(pinnedRoot, guardedWorkspace);
      if (constitutionError) return { ok: false, error: constitutionError, state };
    }
    const beforeArtifactWrite = input.outcome === "succeeded" && guardedWorkspace
      && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")
      ? () => {
        const constitutionError = workspaceConstitutionError(pinnedRoot, guardedWorkspace!);
        if (constitutionError) throw new Error(constitutionError);
      }
      : undefined;
    return completeDispatchMutation(cwd, state, target, pinnedRoot, input, beforeArtifactWrite, (cleanup) => { rollbacks.push(cleanup); }, allowNativeCompositeCompletion);
  }, {
    ...(options ?? {}),
    onAbort: () => { options?.onAbort?.(); for (const rollback of rollbacks.slice().reverse()) rollback(); },
    preCommit: () => {
      options?.preCommit?.();
      if ((input.pending === true || input.outcome === "succeeded") && guardedRoot && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
        const constitutionError = workspaceConstitutionError(guardedRoot, guardedWorkspace);
        if (constitutionError) throw new Error(constitutionError);
      }
    },
  });
}

function completeDispatchMutation(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  input: DispatchAuth & { dispatch_id: string } & Partial<CompletionInput>,
  beforeArtifactWrite?: () => void,
  registerRollback?: (cleanup: () => void) => void,
  allowNativeCompositeCompletion = false,
): TransitionResult {
  const nativePhase = state.specification?.source_kind === "native"
    ? state.specification.phases.find((phase) => phase.phase === input.stage_cursor && ["specify", "plan", "tasks"].includes(phase.phase) && phase.status === "generating")
    : undefined;
  if (nativePhase && !allowNativeCompositeCompletion) {
    return { ok: false, error: "NATIVE_COMPOSITE_REQUIRED: active native phase generation may only be completed by the composite native phase finalizer", state };
  }
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const stateBindingError = stateCapabilityBindingError(state, cap, pinnedRoot, input.feature_id);
  if (stateBindingError) return { ok: false, error: stateBindingError, state };
  const error = auth(cap, input, cap.dispatch_token_hash);
  if (error) return { ok: false, error, state };
  const record = cap.dispatches.find((d) => d.id === input.dispatch_id);
  if (!record) return { ok: false, error: "unknown dispatch", state };
  if (!allowNativeCompositeCompletion && state.specification?.source_kind === "native" && record.purpose === "validation") {
    return { ok: false, error: "NATIVE_COMPOSITE_REQUIRED: native validator dispatch may only be completed through persisted deterministic validation", state };
  }
  if (input.role !== undefined && input.role !== record.role) return { ok: false, error: "dispatch role mismatch", state };
  if (input.slot_id !== undefined && input.slot_id !== record.work_identity?.slot_id && input.slot_id !== record.role) return { ok: false, error: "dispatch slot mismatch", state };
  if (input.task_id !== undefined && input.task_id !== record.work_identity?.task_id) return { ok: false, error: "dispatch task mismatch", state };
  if (input.agent !== undefined && input.agent !== record.agent) return { ok: false, error: "dispatch agent mismatch", state };
  if (input.tool_call_id !== undefined && record.tool_call_id !== undefined && input.tool_call_id !== record.tool_call_id) return { ok: false, error: "dispatch tool-call mismatch", state };
  if (input.pending === true) return pendingRecord(cwd, state, target, cap, record, input.pending_reason, input.provider_ref);
  if (!input.outcome || !input.evidence) return { ok: false, error: "terminal completion outcome and evidence are required", state };
  return completeRecord(cwd, state, target, pinnedRoot, cap, record, input as CompletionInput, beforeArtifactWrite, registerRollback);
}
/** Complete or mark pending a dispatch using a validated restart postimage. */
export function completeDispatchFromPersisted(
  cwd: string,
  input: PersistedStagePostimage & { dispatch_id: string } & Partial<CompletionInput>,
  options?: DurableTransactionOptions,
): TransitionResult {
  const inputError = workflowCompletionInputError(input);
  if (inputError) return { ok: false, error: inputError };
  let guardedWorkspace: FeatureWorkspace | undefined;
  let guardedRoot: PinnedProjectRoot | undefined;
  const rollbacks: Array<() => void> = [];
  return runDurableTransaction(cwd, input, (state, target, pinnedRoot) => {
    guardedRoot = pinnedRoot;
    guardedWorkspace = state.specification;
    if ((input.pending === true || input.outcome === "succeeded") && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
      const constitutionError = workspaceConstitutionError(pinnedRoot, guardedWorkspace);
      if (constitutionError) return { ok: false, error: constitutionError, state };
    }
    const cap = activeCapability(state.dispatch_capability);
    if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
    const stateBindingError = stateCapabilityBindingError(state, cap, pinnedRoot, input.feature_id);
    if (stateBindingError) return { ok: false, error: stateBindingError, state };
    if (state.specification?.feature_id && input.feature_id !== state.specification.feature_id) {
      return { ok: false, error: "capability feature binding mismatch", state };
    }
    const nativePhase = state.specification?.source_kind === "native"
      ? state.specification.phases.find((phase) => phase.phase === input.stage_cursor && ["specify", "plan", "tasks"].includes(phase.phase) && phase.status === "generating")
      : undefined;
    if (nativePhase) return { ok: false, error: "NATIVE_COMPOSITE_REQUIRED: active native phase generation may only be completed by the composite native phase finalizer", state };
    const error = persistedStageAuthError(state, cap, input);
    if (error) return { ok: false, error, state };
    const record = cap.dispatches.find((candidate) => candidate.id === input.dispatch_id);
    if (!record) return { ok: false, error: "unknown dispatch", state };
    if (input.role !== undefined && input.role !== record.role) return { ok: false, error: "dispatch role mismatch", state };
    if (input.slot_id !== undefined && input.slot_id !== record.work_identity?.slot_id && input.slot_id !== record.role) return { ok: false, error: "dispatch slot mismatch", state };
    if (input.task_id !== undefined && input.task_id !== record.work_identity?.task_id) return { ok: false, error: "dispatch task mismatch", state };
    if (input.agent !== undefined && input.agent !== record.agent) return { ok: false, error: "dispatch agent mismatch", state };
    if (input.pending === true) return pendingRecord(cwd, state, target, cap, record, input.pending_reason, input.provider_ref);
    if (!input.outcome || !input.evidence) return { ok: false, error: "terminal completion outcome and evidence are required", state };
    const beforeArtifactWrite = input.outcome === "succeeded" && guardedWorkspace
      && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")
      ? () => {
        const constitutionError = workspaceConstitutionError(pinnedRoot, guardedWorkspace!);
        if (constitutionError) throw new Error(constitutionError);
      }
      : undefined;
    return completeRecord(cwd, state, target, pinnedRoot, cap, record, input as CompletionInput, beforeArtifactWrite, (cleanup) => { rollbacks.push(cleanup); });
  }, {
    ...(options ?? {}),
    onAbort: () => { options?.onAbort?.(); for (const rollback of rollbacks.slice().reverse()) rollback(); },
    preCommit: () => {
      options?.preCommit?.();
      if ((input.pending === true || input.outcome === "succeeded") && guardedRoot && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
        const constitutionError = workspaceConstitutionError(guardedRoot, guardedWorkspace);
        if (constitutionError) throw new Error(constitutionError);
      }
    },
  });
}


const TRUSTED_TASK_RESULT_RECEIPT_SCHEMA = 1 as const;
const TRUSTED_TASK_RESULT_RECEIPT_DOMAIN = "trusted-task-result-receipt-v1";
const TRUSTED_TASK_RESULT_RECEIPT_DIRECTORY = ".work-state/features";
const TRUSTED_TASK_RESULT_RECEIPT_MAX_BYTES = 512 * 1024;

export interface TrustedTaskResultReceipt {
  schema_version: typeof TRUSTED_TASK_RESULT_RECEIPT_SCHEMA;
  authority_kind: "native" | "cto";
  root_identity: { canonical_path: string; dev: number; ino: number };
  feature_id: string;
  run_key: string;
  state_path: string;
  state_revision: number;
  cto_run_id?: string;
  dispatch_id: string;
  tool_call_id: string | null;
  work_identity: WorkIdentity;
  completion_envelope: CompletionEnvelope;
  completion_envelope_digest: string;
  completion_status: DispatchCompletion["outcome"];
  provider_ref: string | null;
  evidence_digest: string;
  receipt_hmac: string;
}

export type TrustedTaskResultReceiptSelector = {
  feature_id: string;
  run_key: string;
  cto_run_id?: string;
  expected_work_identity?: WorkIdentity;
  dispatch_id?: string;
  tool_call_id?: string;
  provider_ref?: string | null;
};

export type TrustedTaskResultReceiptReadResult =
  | { ok: true; receipt: TrustedTaskResultReceipt }
  | { ok: false; code: "absent" | "invalid" | "recovery_required"; error: string };

function trustedTaskResultReceiptRelativePath(featureId: string, dispatchId: string, ctoRunId?: string): string {
  return ctoRunId
    ? `.work-state/cto/${ctoRunId}/artifacts/task-result-receipts/${dispatchId}.json`
    : `${TRUSTED_TASK_RESULT_RECEIPT_DIRECTORY}/${featureId}/artifacts/task-result-receipts/${dispatchId}.json`;
}

function trustedTaskResultReceiptUnsigned(receipt: Omit<TrustedTaskResultReceipt, "receipt_hmac">): string {
  return canonicalJson(receipt);
}

function trustedTaskResultReceiptHmac(pinnedRoot: PinnedProjectRoot, receipt: Omit<TrustedTaskResultReceipt, "receipt_hmac">): string {
  const secret = readOrCreateRootRuntimeSecret(pinnedRoot);
  if (!secret) throw new Error("trusted task result receipt runtime secret is unavailable");
  const key = deriveRuntimeSecretKey(secret, TRUSTED_TASK_RESULT_RECEIPT_DOMAIN);
  if (!key) throw new Error("trusted task result receipt runtime key is unavailable");
  return createHmac("sha256", key).update(trustedTaskResultReceiptUnsigned(receipt), "utf8").digest("hex");
}

function trustedTaskResultReceiptSigned(
  pinnedRoot: PinnedProjectRoot,
  receipt: Omit<TrustedTaskResultReceipt, "receipt_hmac">,
): TrustedTaskResultReceipt {
  return { ...receipt, receipt_hmac: trustedTaskResultReceiptHmac(pinnedRoot, receipt) };
}

function trustedTaskResultReceiptHmacValid(pinnedRoot: PinnedProjectRoot, receipt: TrustedTaskResultReceipt): boolean {
  if (!/^[a-f0-9]{64}$/u.test(receipt.receipt_hmac)) return false;
  const { receipt_hmac: _receiptHmac, ...unsigned } = receipt;
  const expected = trustedTaskResultReceiptHmac(pinnedRoot, unsigned);
  const actualBytes = Buffer.from(receipt.receipt_hmac, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function trustedTaskResultReceiptShape(value: unknown): value is TrustedTaskResultReceipt {
  if (!isRecord(value) || value.schema_version !== TRUSTED_TASK_RESULT_RECEIPT_SCHEMA
    || (value.authority_kind !== "native" && value.authority_kind !== "cto")
    || !isRecord(value.root_identity)
    || typeof value.root_identity.canonical_path !== "string"
    || typeof value.root_identity.dev !== "number" || !Number.isSafeInteger(value.root_identity.dev)
    || typeof value.root_identity.ino !== "number" || !Number.isSafeInteger(value.root_identity.ino)
    || typeof value.feature_id !== "string" || !isSafeFeatureId(value.feature_id)
    || typeof value.run_key !== "string" || value.run_key.trim().length === 0
    || typeof value.state_path !== "string" || !isSafeRelativePath(value.state_path)
    || typeof value.state_revision !== "number" || !Number.isSafeInteger(value.state_revision) || value.state_revision < 0
    || (value.cto_run_id !== undefined && (typeof value.cto_run_id !== "string" || !isSafeStateSegment(value.cto_run_id)))
    || typeof value.dispatch_id !== "string" || !isSafeStateSegment(value.dispatch_id)
    || (value.tool_call_id !== null && typeof value.tool_call_id !== "string")
    || !isRecord(value.work_identity)
    || !isRecord(value.completion_envelope)
    || typeof value.completion_envelope_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.completion_envelope_digest)
    || (value.completion_status !== "succeeded" && value.completion_status !== "failed" && value.completion_status !== "cancelled")
    || (value.provider_ref !== null && typeof value.provider_ref !== "string")
    || typeof value.evidence_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.evidence_digest)
    || (value.authority_kind === "cto" && typeof value.cto_run_id !== "string")
    || typeof value.receipt_hmac !== "string") return false;
  return true;
}

function trustedTaskResultReceiptEqual(left: TrustedTaskResultReceipt, right: TrustedTaskResultReceipt): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function trustedTaskResultReceiptReadRaw(
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
): TrustedTaskResultReceiptReadResult {
  let observed;
  try {
    if (!pinnedRoot.pathEntryExists(relativePath)) return { ok: false, code: "absent", error: "trusted task result receipt is absent" };
    observed = pinnedRoot.readFile(relativePath, { maxBytes: TRUSTED_TASK_RESULT_RECEIPT_MAX_BYTES });
  } catch {
    return { ok: false, code: "invalid", error: "trusted task result receipt cannot be read safely" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(observed.bytes).toString("utf8")) as unknown; } catch {
    return { ok: false, code: "invalid", error: "trusted task result receipt is not valid JSON" };
  }
  if (!trustedTaskResultReceiptShape(parsed)) return { ok: false, code: "invalid", error: "trusted task result receipt schema is invalid" };
  if (!trustedTaskResultReceiptHmacValid(pinnedRoot, parsed)) return { ok: false, code: "invalid", error: "trusted task result receipt authentication failed" };
  return { ok: true, receipt: parsed };
}

function trustedTaskResultReceiptStateError(
  pinnedRoot: PinnedProjectRoot,
  target: ResolvedState | null,
  state: TeamState | null,
  receipt: TrustedTaskResultReceipt,
  selector: TrustedTaskResultReceiptSelector,
): string | null {
  if (receipt.authority_kind === "cto") {
    if (!receipt.cto_run_id || (selector.cto_run_id !== undefined && receipt.cto_run_id !== selector.cto_run_id)
      || receipt.state_path !== `.work-state/cto/${receipt.cto_run_id}/state.json`
      || receipt.root_identity.canonical_path !== pinnedRoot.canonical_root
      || receipt.root_identity.dev !== pinnedRoot.dev || receipt.root_identity.ino !== pinnedRoot.ino
      || digestOf(receipt.completion_envelope) !== receipt.completion_envelope_digest
      || receipt.completion_envelope.outcome !== receipt.completion_status
      || canonicalJson(receipt.completion_envelope.identity) !== canonicalJson(receipt.work_identity)
      || receipt.completion_envelope.evidence_ref !== trustedTaskResultReceiptRelativePath(receipt.feature_id, receipt.dispatch_id, receipt.cto_run_id)
      || receipt.completion_envelope.artifact_refs.length !== 0
      || (receipt.completion_envelope.terminal_signal !== "native_tool_result" && receipt.completion_envelope.terminal_signal !== "contract_failure")
      || selector.dispatch_id !== undefined && receipt.dispatch_id !== selector.dispatch_id
      || selector.provider_ref !== undefined && receipt.provider_ref !== selector.provider_ref) {
      return "trusted CTO task result receipt selector binding is invalid";
    }
    const ctoState = readCtoStatePinned(receipt.cto_run_id, pinnedRoot);
    if (!ctoState || ctoState.id !== receipt.cto_run_id) return "trusted CTO task result receipt state binding is stale";
    const ctoRevision = ctoState.state_revision;
    if (typeof ctoRevision !== "number" || !Number.isSafeInteger(ctoRevision) || ctoRevision < receipt.state_revision) return "trusted CTO task result receipt state binding is stale";
    const receiptIdentity = receipt.work_identity as Partial<WorkIdentity>;
    if (receiptIdentity.dispatch_id !== receipt.dispatch_id) return "trusted CTO task result receipt work binding is stale";
    const matchingTeams = ctoState.teams.filter((candidate) => candidate.work_identity?.dispatch_id === receipt.dispatch_id);
    if (matchingTeams.length !== 1) return "trusted CTO task result receipt work binding is stale";
    const team = matchingTeams[0];
    const identity = team?.work_identity;
    if (!team || !identity
      || team.feature_id !== receipt.feature_id
      || team.run_key !== receipt.run_key
      || team.slice_id !== identity.slice_id
      || team.task_id !== identity.task_id
      || identity.dispatch_id !== receipt.dispatch_id
      || identity.capability_id !== receiptIdentity.capability_id
      || identity.capability_epoch !== receiptIdentity.capability_epoch
      || canonicalJson(identity) !== canonicalJson(receipt.work_identity)
      || (team.status !== "pending" && team.status !== "in_progress" && team.status !== "done" && team.status !== "failed")) {
      return "trusted CTO task result receipt work binding is stale";
    }
    if (team.status === "pending" || team.status === "in_progress") {
      if (!team.pending || typeof team.pending.provider_ref !== "string" || team.pending.provider_ref !== receipt.provider_ref) {
        return "trusted CTO task result receipt provider binding is stale";
      }
    } else {
      if (team.pending !== undefined
        || !team.completion_envelope
        || canonicalJson(team.completion_envelope) !== canonicalJson(receipt.completion_envelope)
        || team.completion_envelope.identity.dispatch_id !== receipt.dispatch_id
        || receipt.completion_envelope.identity.dispatch_id !== receipt.dispatch_id
        || receipt.tool_call_id === null
        || receipt.provider_ref !== `host-task:${receipt.tool_call_id}`) {
        return "trusted CTO task result receipt completion binding is stale";
      }
    }
    if (selector.tool_call_id !== undefined && receipt.tool_call_id !== selector.tool_call_id) return "trusted CTO task result receipt tool binding is invalid";
    if (selector.expected_work_identity !== undefined && canonicalJson(selector.expected_work_identity) !== canonicalJson(receipt.work_identity)) return "trusted CTO task result receipt work binding is invalid";
    return null;
  }
  if (!target || !state) return "trusted task result receipt state binding is stale";
  const relativeStatePath = target.statePath ? pinnedRoot.relativePath(target.statePath) : null;
  if (relativeStatePath === null || receipt.state_path !== relativeStatePath || receipt.state_revision > (state.state_revision ?? 0)) {
    return "trusted task result receipt state binding is stale";
  }
  const workspace = state.specification;
  if (state.run_key !== selector.run_key || !workspace || workspace.feature_id !== selector.feature_id
    || workspace.project_root_identity.canonical_path !== pinnedRoot.canonical_root
    || workspace.project_root_identity.dev !== pinnedRoot.dev
    || workspace.project_root_identity.ino !== pinnedRoot.ino
    || receipt.root_identity.canonical_path !== pinnedRoot.canonical_root
    || receipt.root_identity.dev !== pinnedRoot.dev || receipt.root_identity.ino !== pinnedRoot.ino) {
    return "trusted task result receipt root or run binding is invalid";
  }
  const cap = activeCapability(state.dispatch_capability);
  const record = cap?.dispatches.find((candidate) => candidate.id === receipt.dispatch_id);
  if (!cap || !record || record.id !== selector.dispatch_id && selector.dispatch_id !== undefined
    || record.tool_call_id !== receipt.tool_call_id
    || record.status !== receipt.completion_status
    || !record.completion_envelope
    || canonicalJson(record.completion_envelope) !== canonicalJson(receipt.completion_envelope)
    || digestOf(record.completion_envelope) !== receipt.completion_envelope_digest
    || !record.work_identity || canonicalJson(record.work_identity) !== canonicalJson(receipt.work_identity)) {
    return "trusted task result receipt completion binding is stale";
  }
  if (selector.cto_run_id !== undefined) return "trusted task result receipt authority binding is invalid";
  if (selector.provider_ref !== undefined && receipt.provider_ref !== selector.provider_ref) return "trusted task result receipt provider binding is invalid";
  if (selector.tool_call_id !== undefined && selector.tool_call_id !== receipt.tool_call_id) return "trusted task result receipt tool binding is invalid";
  if (selector.expected_work_identity !== undefined && canonicalJson(selector.expected_work_identity) !== canonicalJson(receipt.work_identity)) return "trusted task result receipt work binding is invalid";
  return null;
}

/** Verify one caller-supplied receipt against the pinned root and canonical state. */
export function verifyTrustedTaskResultReceipt(
  rootOrCwd: PinnedProjectRoot | string,
  receipt: TrustedTaskResultReceipt,
  selector: TrustedTaskResultReceiptSelector = { feature_id: receipt.feature_id, run_key: receipt.run_key, dispatch_id: receipt.dispatch_id },
): TrustedTaskResultReceiptReadResult {
  if (!trustedTaskResultReceiptShape(receipt)) return { ok: false, code: "invalid", error: "trusted task result receipt schema is invalid" };
  const pinnedRoot = typeof rootOrCwd === "string" ? PinnedProjectRoot.open(rootOrCwd) ?? undefined : rootOrCwd;
  if (!pinnedRoot) return { ok: false, code: "invalid", error: "project root could not be pinned for trusted task result receipt" };
  const ownsRoot = typeof rootOrCwd === "string";
  try {
    if (!trustedTaskResultReceiptHmacValid(pinnedRoot, receipt)) return { ok: false, code: "invalid", error: "trusted task result receipt authentication failed" };
    if (receipt.feature_id !== selector.feature_id || receipt.run_key !== selector.run_key) return { ok: false, code: "invalid", error: "trusted task result receipt feature or run binding is invalid" };
    const exactSelector = { ...selector, dispatch_id: selector.dispatch_id ?? receipt.dispatch_id };
    if (receipt.authority_kind === "cto") {
      const stateError = trustedTaskResultReceiptStateError(pinnedRoot, null, null, receipt, exactSelector);
      if (stateError) return { ok: false, code: "recovery_required", error: stateError };
      return { ok: true, receipt };
    }
    const resolved = resolveStatePinned(pinnedRoot.canonical_root, pinnedRoot, { feature_id: selector.feature_id, run_key: selector.run_key });
    if (resolved.invalid || !resolved.state) return { ok: false, code: "recovery_required", error: "trusted task result receipt state is unavailable" };
    const stateError = trustedTaskResultReceiptStateError(pinnedRoot, resolved, resolved.state, receipt, exactSelector);
    if (stateError) return { ok: false, code: "recovery_required", error: stateError };
    return { ok: true, receipt };
  } catch {
    return { ok: false, code: "invalid", error: "trusted task result receipt verification failed" };
  } finally {
    if (ownsRoot) pinnedRoot.close();
  }
}

/** Read and verify a trusted native/Cto task receipt without exposing a signer. */
export function readTrustedTaskResultReceipt(
  rootOrCwd: PinnedProjectRoot | string,
  selector: TrustedTaskResultReceiptSelector,
): TrustedTaskResultReceiptReadResult {
  if (!isSafeFeatureId(selector.feature_id) || !selector.run_key.trim()) return { ok: false, code: "invalid", error: "trusted task result receipt selector is invalid" };
  const pinnedRoot = typeof rootOrCwd === "string" ? PinnedProjectRoot.open(rootOrCwd) ?? undefined : rootOrCwd;
  if (!pinnedRoot) return { ok: false, code: "invalid", error: "project root could not be pinned for trusted task result receipt" };
  const ownsRoot = typeof rootOrCwd === "string";
  try {
    const relativePath = selector.dispatch_id && isSafeStateSegment(selector.dispatch_id)
      ? trustedTaskResultReceiptRelativePath(selector.feature_id, selector.dispatch_id, selector.cto_run_id)
      : null;
    if (relativePath === null) return { ok: false, code: "absent", error: "trusted task result receipt dispatch selector is absent" };
    const raw = trustedTaskResultReceiptReadRaw(pinnedRoot, relativePath);
    if (!raw.ok) return raw;
    if (raw.receipt.feature_id !== selector.feature_id || raw.receipt.run_key !== selector.run_key
      || (selector.cto_run_id !== undefined ? raw.receipt.authority_kind !== "cto" || raw.receipt.cto_run_id !== selector.cto_run_id : raw.receipt.authority_kind !== "native")) {
      return { ok: false, code: "invalid", error: "trusted task result receipt feature, run, or authority binding is invalid" };
    }
    return verifyTrustedTaskResultReceipt(pinnedRoot, raw.receipt, selector);
  } catch {
    return { ok: false, code: "invalid", error: "trusted task result receipt verification failed" };
  } finally {
    if (ownsRoot) pinnedRoot.close();
  }
}

function persistTrustedTaskResultReceipt(
  pinnedRoot: PinnedProjectRoot,
  target: ResolvedState,
  state: TeamState,
  record: DispatchRecord,
  completionEnvelope: CompletionEnvelope,
  registerRollback?: (cleanup: () => void) => void,
  options: { authority_kind?: TrustedTaskResultReceipt["authority_kind"]; state_revision?: number; cto_run_id?: string; provider_ref?: string | null; receipt_path?: string } = {},
): TrustedTaskResultReceipt | null {
  const statePath = target.statePath ? pinnedRoot.relativePath(target.statePath) : null;
  if (statePath === null) return null;
  const stateSegments = statePath.split("/");
  const pathFeatureId = stateSegments.length === 4 && stateSegments[0] === ".work-state" && stateSegments[1] === "features" && stateSegments[3] === "state.json" ? stateSegments[2] : undefined;
  const featureId = state.specification?.feature_id ?? pathFeatureId;
  if (!featureId || !isSafeFeatureId(featureId) || !state.run_key) return null;
  const identity = record.work_identity ?? completionEnvelope.identity;
  const unsigned = {
    schema_version: TRUSTED_TASK_RESULT_RECEIPT_SCHEMA,
    authority_kind: options.authority_kind ?? "native",
    root_identity: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    feature_id: featureId,
    run_key: state.run_key,
    state_path: statePath,
    state_revision: options.state_revision ?? ((state.state_revision ?? 0) + 1),
    ...(options.cto_run_id ? { cto_run_id: options.cto_run_id } : {}),
    dispatch_id: record.id,
    tool_call_id: record.tool_call_id ?? null,
    work_identity: identity,
    completion_envelope: completionEnvelope,
    completion_envelope_digest: digestOf(completionEnvelope),
    completion_status: record.status as DispatchCompletion["outcome"],
    provider_ref: options.provider_ref ?? null,
    evidence_digest: digestOf(record.completion?.evidence ?? completionEnvelope.evidence_ref ?? ""),
  } satisfies Omit<TrustedTaskResultReceipt, "receipt_hmac">;
  const receipt = trustedTaskResultReceiptSigned(pinnedRoot, unsigned);
  const relativePath = options.receipt_path ?? trustedTaskResultReceiptRelativePath(featureId, record.id);
  pinnedRoot.ensureDirectory(dirname(relativePath));
  const existing = trustedTaskResultReceiptReadRaw(pinnedRoot, relativePath);
  if (existing.ok) {
    if (!trustedTaskResultReceiptEqual(existing.receipt, receipt)) throw new Error("conflicting trusted task result receipt");
    return existing.receipt;
  }
  if ("code" in existing && existing.code !== "absent") throw new Error(existing.error);
  const publication = pinnedRoot.writeExclusiveWithReceipt(relativePath, JSON.stringify(receipt) + "\n");
  registerRollback?.(() => publication.rollback());
  return receipt;
}

export interface TrustedTaskResultHostRootIdentity {
  canonical_root: string;
  dev: number;
  ino: number;
}

/** Opaque host-only capability; durable fields live only in the module WeakMap. */
export type TrustedTaskResultHostCapability = object & { readonly __trusted_task_result_host_capability?: never };

export interface TrustedTaskResultHostAuthorizationInput {
  root: TrustedTaskResultHostRootIdentity;
  state: CtoState;
  cto_run_id: string;
  state_revision: number;
  feature_id: string;
  run_key: string;
  dispatch_id: string;
  tool_call_id: string;
  work_identity: WorkIdentity;
  provider_ref: string;
}

export interface TrustedTaskResultHostResultInput {
  outcome: Extract<DispatchCompletion["outcome"], "succeeded" | "failed">;
  evidence: string;
  terminal_signal?: Extract<CompletionEnvelope["terminal_signal"], "native_tool_result" | "contract_failure">;
  provider_ref?: string;
  artifact_ids?: readonly string[];
}

type TrustedTaskResultHostAuthority = {
  capability: TrustedTaskResultHostCapability;
  root: TrustedTaskResultHostRootIdentity;
  cto_run_id: string;
  state_revision: number;
  state_path: string;
  feature_id: string;
  run_key: string;
  dispatch_id: string;
  tool_call_id: string;
  work_identity: WorkIdentity;
  provider_ref: string;
  consumed: boolean;
  /** Monotonic wall-clock issuance timestamp for bounded abandoned-capability cleanup. */
  issued_at_ms: number;
  /** Digest of the selected team/dispatch preimage at host task authorization. */
  team_preimage_digest: string;
  receipt?: TrustedTaskResultReceipt;
};

let trustedTaskResultHostBridge: object | null = null;
const trustedTaskResultHostAuthorities = new WeakMap<object, TrustedTaskResultHostAuthority>();
const trustedTaskResultHostIssuances = new Map<string, TrustedTaskResultHostAuthority>();
const TRUSTED_TASK_RESULT_HOST_AUTHORITY_TTL_MS = 30 * 60 * 1000;
const TRUSTED_TASK_RESULT_HOST_AUTHORITY_MAX = 1024;

function trustedTaskResultHostIssuanceKey(authority: Pick<TrustedTaskResultHostAuthority, "cto_run_id" | "feature_id" | "run_key" | "dispatch_id">): string {
  return `${authority.cto_run_id}|${authority.feature_id}|${authority.run_key}|${authority.dispatch_id}`;
}

function sweepTrustedTaskResultHostIssuances(nowMs = Date.now()): void {
  for (const [key, authority] of trustedTaskResultHostIssuances) {
    if (!authority.consumed && nowMs - authority.issued_at_ms >= TRUSTED_TASK_RESULT_HOST_AUTHORITY_TTL_MS) trustedTaskResultHostIssuances.delete(key);
  }
}

/** Install the one mounted-host bridge used to mint CTO task result capabilities. */
export function registerTrustedTaskResultHostBridge(bridge: object): void {
  if (!bridge || typeof bridge !== "object") throw new Error("trusted_task_result_unverified: host bridge is unavailable");
  if (trustedTaskResultHostBridge === null) {
    trustedTaskResultHostBridge = bridge;
    return;
  }
  if (trustedTaskResultHostBridge !== bridge) throw new Error("trusted_task_result_unverified: trusted host bridge is already bound");
}

function trustedTaskResultHostAuthorityFor(value: unknown): TrustedTaskResultHostAuthority | null {
  if (!value || typeof value !== "object") return null;
  return trustedTaskResultHostAuthorities.get(value) ?? null;
}

function trustedTaskResultHostRootMatches(left: TrustedTaskResultHostRootIdentity, right: TrustedTaskResultHostRootIdentity): boolean {
  return left.canonical_root === right.canonical_root && left.dev === right.dev && left.ino === right.ino;
}

function trustedTaskResultHostTeamPreimageDigest(
  team: CtoState["teams"][number],
  providerRef: string,
): string {
  return digestOf({
    team_id: team.id,
    feature_id: team.feature_id ?? null,
    run_key: team.run_key ?? null,
    slice_id: team.slice_id ?? null,
    task_id: team.task_id ?? null,
    status: team.status,
    pending: team.pending ?? null,
    completion_envelope: team.completion_envelope ?? null,
    provider_ref: providerRef,
    work_identity: team.work_identity ?? null,
  });
}

function trustedTaskResultHostIssueError(input: TrustedTaskResultHostAuthorizationInput): string | null {
  if (!input || typeof input !== "object" || !input.state || typeof input.state !== "object" || !Array.isArray(input.state.teams)
    || !input.root || typeof input.root !== "object"
    || !isSafeCtoRunId(input.cto_run_id) || input.state.id !== input.cto_run_id
    || !Number.isSafeInteger(input.state_revision) || input.state_revision < 0 || input.state.state_revision !== input.state_revision
    || !isSafeFeatureId(input.feature_id) || typeof input.run_key !== "string" || !input.run_key.trim()
    || !isSafeStateSegment(input.dispatch_id) || !isSafeStateSegment(input.tool_call_id)
    || typeof input.root.canonical_root !== "string" || !input.root.canonical_root.trim()
    || !Number.isSafeInteger(input.root.dev) || !Number.isSafeInteger(input.root.ino)
    || typeof input.provider_ref !== "string" || !input.provider_ref.trim()) return "trusted_task_result_unverified: host task authorization is incomplete";
  const matchingTeams = input.state.teams.filter((candidate) => candidate.work_identity?.dispatch_id === input.dispatch_id);
  if (matchingTeams.length !== 1) return "trusted_task_result_unverified: host task authorization is stale or mismatched";
  const team = matchingTeams[0];
  if (!team || team.feature_id !== input.feature_id || team.run_key !== input.run_key
    || team.slice_id !== input.work_identity.slice_id || team.task_id !== input.work_identity.task_id
    || !team.work_identity || team.work_identity.capability_id !== input.work_identity.capability_id
    || team.work_identity.capability_epoch !== input.work_identity.capability_epoch
    || canonicalJson(team.work_identity) !== canonicalJson(input.work_identity)
    || team.work_identity.dispatch_id !== input.dispatch_id
    || team.pending?.provider_ref !== input.provider_ref
    || (team.status !== "pending" && team.status !== "in_progress")) {
    return "trusted_task_result_unverified: host task authorization is stale or mismatched";
  }
  return null;
}

/** Mint one opaque capability from the mounted host's exact task_call authorization. */
export function issueTrustedTaskResultHostCapability(
  bridge: object,
  input: TrustedTaskResultHostAuthorizationInput,
): TrustedTaskResultHostCapability {
  if (trustedTaskResultHostBridge === null || bridge !== trustedTaskResultHostBridge) throw new Error("trusted_task_result_unverified: trusted host bridge is unavailable");
  const issueError = trustedTaskResultHostIssueError(input);
  if (issueError) throw new Error(issueError);
  sweepTrustedTaskResultHostIssuances();
  const team = input.state.teams.find((candidate) => candidate.work_identity?.dispatch_id === input.dispatch_id);
  if (!team) throw new Error("trusted_task_result_unverified: host task authorization team disappeared");
  const selectorKey = `${input.cto_run_id}|${input.feature_id}|${input.run_key}|${input.dispatch_id}`;
  if (trustedTaskResultHostIssuances.has(selectorKey)) throw new Error("trusted_task_result_conflict: host task authorization capability has already been issued");
  if (trustedTaskResultHostIssuances.size >= TRUSTED_TASK_RESULT_HOST_AUTHORITY_MAX) throw new Error("trusted_task_result_recovery_required: host task authorization registry is at capacity");
  const capability = Object.freeze(Object.create(null)) as TrustedTaskResultHostCapability;
  const workIdentity = Object.freeze({ ...input.work_identity }) as WorkIdentity;
  const authority: TrustedTaskResultHostAuthority = {
    capability,
    root: { ...input.root },
    cto_run_id: input.cto_run_id,
    state_revision: input.state_revision,
    state_path: `.work-state/cto/${input.cto_run_id}/state.json`,
    feature_id: input.feature_id,
    run_key: input.run_key,
    dispatch_id: input.dispatch_id,
    tool_call_id: input.tool_call_id,
    work_identity: workIdentity,
    provider_ref: input.provider_ref,
    consumed: false,
    issued_at_ms: Date.now(),
    team_preimage_digest: trustedTaskResultHostTeamPreimageDigest(team, input.provider_ref),
  };
  trustedTaskResultHostAuthorities.set(capability, authority);
  trustedTaskResultHostIssuances.set(selectorKey, authority);
  return capability;
}

function trustedTaskResultHostReceipt(
  pinnedRoot: PinnedProjectRoot,
  authority: TrustedTaskResultHostAuthority,
  result: TrustedTaskResultHostResultInput,
): TrustedTaskResultReceipt {
  if ((result.outcome !== "succeeded" && result.outcome !== "failed")
    || typeof result.evidence !== "string" || !result.evidence.trim() || result.evidence.length > MAX_ADVANCE_EVIDENCE_BYTES
    || (result.terminal_signal !== undefined && result.terminal_signal !== "native_tool_result" && result.terminal_signal !== "contract_failure")
    || (result.artifact_ids !== undefined && (!Array.isArray(result.artifact_ids) || result.artifact_ids.length !== 0))) throw new Error("trusted_task_result_unverified: CTO host results require bounded evidence and verified empty artifacts");
  const terminalSignal = result.terminal_signal ?? (result.outcome === "failed" ? "contract_failure" : "native_tool_result");
  const receiptPath = trustedTaskResultReceiptRelativePath(authority.feature_id, authority.dispatch_id, authority.cto_run_id);
  const envelope: CompletionEnvelope = {
    schema_version: 1,
    identity: authority.work_identity,
    outcome: result.outcome,
    terminal_signal: terminalSignal,
    artifact_refs: [],
    evidence_ref: receiptPath,
    conflict_ref: null,
    completed_by: "engine_task_caller",
    emitted_at: now(),
  };
  const unsigned = {
    schema_version: TRUSTED_TASK_RESULT_RECEIPT_SCHEMA,
    authority_kind: "cto" as const,
    root_identity: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    feature_id: authority.feature_id,
    run_key: authority.run_key,
    state_path: authority.state_path,
    state_revision: authority.state_revision,
    cto_run_id: authority.cto_run_id,
    dispatch_id: authority.dispatch_id,
    tool_call_id: authority.tool_call_id,
    work_identity: authority.work_identity,
    completion_envelope: envelope,
    completion_envelope_digest: digestOf(envelope),
    completion_status: result.outcome,
    provider_ref: result.provider_ref ?? authority.provider_ref,
    evidence_digest: digestOf(result.evidence),
  } satisfies Omit<TrustedTaskResultReceipt, "receipt_hmac">;
  if (unsigned.provider_ref !== authority.provider_ref) throw new Error("trusted_task_result_unverified: host provider binding mismatch");
  const receipt = trustedTaskResultReceiptSigned(pinnedRoot, unsigned);
  const relativePath = receiptPath;
  pinnedRoot.ensureDirectory(dirname(relativePath));
  const existing = trustedTaskResultReceiptReadRaw(pinnedRoot, relativePath);
  if (existing.ok) {
    if (!trustedTaskResultReceiptEqual(existing.receipt, receipt)) throw new Error("trusted_task_result_conflict: host task receipt replay differs");
    return existing.receipt;
  }
  if ("code" in existing && existing.code !== "absent") throw new Error(existing.error);
  const publication = pinnedRoot.writeExclusiveWithReceipt(relativePath, JSON.stringify(receipt) + "\n");
  return receipt;
}

/** Sign one host task result into a CTO receipt; this does not mutate feature or CTO state. */
export function recordTrustedTaskResultFromHost(
  cwd: string,
  capability: TrustedTaskResultHostCapability,
  result: TrustedTaskResultHostResultInput,
  options: { pinnedRoot?: PinnedProjectRoot } = {},
): TrustedTaskResultReceipt {
  sweepTrustedTaskResultHostIssuances();
  const authority = trustedTaskResultHostAuthorityFor(capability);
  if (!authority) throw new Error("trusted_task_result_recovery_required: host task result capability is unavailable");
  if (!authority.consumed && Date.now() - authority.issued_at_ms >= TRUSTED_TASK_RESULT_HOST_AUTHORITY_TTL_MS) {
    throw new Error("trusted_task_result_recovery_required: host task result capability has expired");
  }
  const pinnedRoot = options.pinnedRoot ?? PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) throw new Error("trusted_task_result_recovery_required: project root could not be pinned");
  const ownsRoot = options.pinnedRoot === undefined;
  try {
    if (!pinnedRoot.isStable() || !trustedTaskResultHostRootMatches(authority.root, { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino })) {
      throw new Error("trusted_task_result_unverified: host task result root identity is stale or mismatched");
    }
    if (authority.consumed) {
      if (!authority.receipt || result.provider_ref !== undefined && result.provider_ref !== authority.provider_ref
        || result.artifact_ids !== undefined && result.artifact_ids.length !== 0) throw new Error("trusted_task_result_conflict: host task result capability was already consumed");
      const replay = readTrustedTaskResultReceipt(pinnedRoot, { feature_id: authority.feature_id, run_key: authority.run_key, cto_run_id: authority.cto_run_id, dispatch_id: authority.dispatch_id, tool_call_id: authority.tool_call_id, expected_work_identity: authority.work_identity, provider_ref: authority.provider_ref });
      const replaySignal = result.terminal_signal ?? (result.outcome === "failed" ? "contract_failure" : "native_tool_result");
      if (!replay.ok || digestOf(result.evidence) !== replay.receipt.evidence_digest || result.outcome !== replay.receipt.completion_status || replay.receipt.completion_envelope.terminal_signal !== replaySignal) throw new Error("trusted_task_result_conflict: host task result replay differs");
      return replay.receipt;
    }
    const current = readCtoStatePinned(authority.cto_run_id, pinnedRoot);
    if (!current || current.id !== authority.cto_run_id || typeof current.state_revision !== "number" || current.state_revision < authority.state_revision) throw new Error("trusted_task_result_recovery_required: CTO task authorization state is stale");
    const matchingTeams = current.teams.filter((candidate) => candidate.work_identity?.dispatch_id === authority.dispatch_id);
    if (matchingTeams.length !== 1) throw new Error("trusted_task_result_unverified: CTO task authorization no longer matches one exact pending team");
    const team = matchingTeams[0];
    if (!team || team.feature_id !== authority.feature_id || team.run_key !== authority.run_key
      || team.slice_id !== authority.work_identity.slice_id || team.task_id !== authority.work_identity.task_id
      || !team.work_identity || team.work_identity.capability_id !== authority.work_identity.capability_id
      || team.work_identity.capability_epoch !== authority.work_identity.capability_epoch
      || canonicalJson(team.work_identity) !== canonicalJson(authority.work_identity)
      || team.pending?.provider_ref !== authority.provider_ref
      || (team.status !== "pending" && team.status !== "in_progress")
      || team.completion_envelope !== undefined
      || trustedTaskResultHostTeamPreimageDigest(team, authority.provider_ref) !== authority.team_preimage_digest) throw new Error("trusted_task_result_unverified: CTO task authorization no longer matches current pending team");
    const receipt = trustedTaskResultHostReceipt(pinnedRoot, authority, result);
    authority.consumed = true;
    authority.receipt = receipt;
    trustedTaskResultHostIssuances.delete(trustedTaskResultHostIssuanceKey(authority));
    return receipt;
  } finally {
    if (ownsRoot) pinnedRoot.close();
  }
}

/** Reconcile a native task result without exposing capability secrets to hooks. */
export type TrustedTaskResultInput = {
  /** Explicit feature selector for native concurrent phase result reconciliation. */
  feature_id?: string;
  run_key?: string;
  tool_call_id?: string;
  capability_id?: string;
  cursor_epoch?: string;
  dispatch_id?: string;
  role?: string;
  slot_id?: string;
  task_id?: string;
  work_identity?: WorkIdentity;
  outcome: DispatchCompletion["outcome"];
  evidence: string;
  artifact_ids?: string[];
  pending?: boolean;
  pending_reason?: PendingState["pending_reason"];
  provider_id?: string;
  provider_ref?: string;
  terminal_signal?: CompletionEnvelope["terminal_signal"];
};

export function reconcileTrustedTaskResult(cwd: string, input: TrustedTaskResultInput, options: DurableTransactionOptions = {}): TransitionResult {
  if (!input.tool_call_id && !input.dispatch_id && !input.work_identity) return { ok: false, error: "dispatch identity required" };
  const inputError = workflowCompletionInputError(input);
  if (inputError) return { ok: false, error: inputError };
  // A completed state can survive a process crash after its state CAS but before
  // receipt publication. An already verified receipt is an exact idempotent
  // replay and must not advance the state revision a second time.
  if (input.dispatch_id && input.feature_id && input.run_key) {
    const pinned = PinnedProjectRoot.open(cwd);
    if (pinned) {
      try {
        const receipt = readTrustedTaskResultReceipt(pinned, {
          feature_id: input.feature_id,
          run_key: input.run_key,
          dispatch_id: input.dispatch_id,
          ...(input.tool_call_id ? { tool_call_id: input.tool_call_id } : {}),
          ...(input.work_identity ? { expected_work_identity: input.work_identity } : {}),
        });
        if (receipt.ok) {
          const resolved = resolveStatePinned(pinned.canonical_root, pinned, { feature_id: input.feature_id, run_key: input.run_key });
          const replayCapability = resolved.state ? activeCapability(resolved.state.dispatch_capability) : null;
          const record = replayCapability?.dispatches.find((candidate) => candidate.id === input.dispatch_id);
          const replayStage = replayCapability
            ? loadProfile(replayCapability.issued_for.workflow)?.stages.find((candidate) => candidate.id === replayCapability.issued_for.stage_cursor)
            : undefined;
          const expectedArtifacts = input.artifact_ids ?? (replayStage ? stageProduces(replayStage) : []);
          if (resolved.state && record?.completion
            && record.completion.outcome === input.outcome
            && record.completion.evidence === input.evidence
            && canonicalJson(record.completion.artifact_ids) === canonicalJson(expectedArtifacts)
            && record.completion_envelope?.terminal_signal === (input.terminal_signal ?? "native_tool_result")) {
            return { ok: true, state: resolved.state };
          }
          return { ok: false, error: "conflicting trusted task result replay" };
        }
        if ("code" in receipt && receipt.code !== "absent") return { ok: false, error: receipt.error };
      } finally {
        pinned.close();
      }
    }
  }
  let guardedWorkspace: FeatureWorkspace | undefined;
  let guardedRoot: PinnedProjectRoot | undefined;
  let deferredReceipt: { record: DispatchRecord; envelope: CompletionEnvelope } | undefined;
  let receiptPublicationError: string | undefined;
  let receiptPublished = false;
  const rollbacks: Array<() => void> = [];
  const transaction = runDurableTransaction(cwd, input, (state, target, pinnedRoot) => {
    guardedRoot = pinnedRoot;
    guardedWorkspace = state.specification;
    if ((input.pending === true || input.outcome === "succeeded") && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
      const constitutionError = workspaceConstitutionError(pinnedRoot, guardedWorkspace);
      if (constitutionError) return { ok: false, error: constitutionError, state };
    }
    const beforeArtifactWrite = input.outcome === "succeeded" && guardedWorkspace
      && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")
      ? () => {
        const constitutionError = workspaceConstitutionError(pinnedRoot, guardedWorkspace!);
        if (constitutionError) throw new Error(constitutionError);
      }
      : undefined;
    return reconcileTrustedTaskResultMutation(cwd, state, target, pinnedRoot, input, beforeArtifactWrite, (cleanup) => { rollbacks.push(cleanup); }, (record, envelope) => {
      deferredReceipt = { record, envelope };
    });
  }, {
    ...(options ?? {}),
    onAbort: () => { options?.onAbort?.(); for (const rollback of rollbacks.slice().reverse()) rollback(); },
    postCommit: () => {
      if (deferredReceipt && input.feature_id && input.run_key) {
        try {
          const committed = resolveStatePinned(cwd, guardedRoot!, { feature_id: input.feature_id, run_key: input.run_key });
          const committedRecord = committed.state?.dispatch_capability?.dispatches?.find((candidate) => candidate.id === deferredReceipt!.record.id);
          if (!committed.state || !committedRecord?.completion_envelope
            || committedRecord.status !== deferredReceipt.record.status
            || canonicalJson(committedRecord.completion_envelope) !== canonicalJson(deferredReceipt.envelope)) {
            throw new Error("committed state no longer contains the exact terminal task result");
          }
          const published = persistTrustedTaskResultReceipt(guardedRoot!, committed, committed.state, committedRecord, committedRecord.completion_envelope, undefined, { state_revision: committed.state.state_revision });
          if (!published) throw new Error("the canonical receipt path is unavailable");
          const verified = readTrustedTaskResultReceipt(guardedRoot!, { feature_id: input.feature_id, run_key: input.run_key, dispatch_id: committedRecord.id, ...(input.tool_call_id ? { tool_call_id: input.tool_call_id } : {}) });
          if (!verified.ok) throw new Error(verified.error);
          receiptPublished = true;
        } catch (error) {
          receiptPublicationError = error instanceof Error ? error.message : String(error);
        }
      }
      options?.postCommit?.();
    },
    preCommit: () => {
      if ((input.pending === true || input.outcome === "succeeded") && guardedRoot && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
        const constitutionError = workspaceConstitutionError(guardedRoot, guardedWorkspace);
        if (constitutionError) throw new Error(constitutionError);
      }
    },
  });
  if (transaction.ok && deferredReceipt && !receiptPublished) {
    return { ...transaction, ok: false, error: `trusted_task_result_recovery_required: terminal state committed but receipt publication failed; retry is required (${receiptPublicationError ?? "unknown receipt publication failure"})` };
  }
  return transaction;
}

function reconcileTrustedTaskResultMutation(cwd: string, state: TeamState, target: ResolvedState, pinnedRoot: PinnedProjectRoot, input: TrustedTaskResultInput, beforeArtifactWrite?: () => void, registerRollback?: (cleanup: () => void) => void, deferReceipt?: (record: DispatchRecord, envelope: CompletionEnvelope) => void): TransitionResult {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const stateBindingError = stateCapabilityBindingError(state, cap, pinnedRoot, input.feature_id);
  if (stateBindingError) return { ok: false, error: stateBindingError, state };
  if (input.capability_id && input.capability_id !== cap.capability_id) return { ok: false, error: "capability identity mismatch", state };
  if (input.cursor_epoch && input.cursor_epoch !== cap.issued_for.cursor_epoch) return { ok: false, error: "cursor epoch mismatch", state };
  const candidates = cap.dispatches.filter((record) => {
    if (input.dispatch_id && record.id !== input.dispatch_id) return false;
    if (input.tool_call_id && record.tool_call_id !== input.tool_call_id) return false;
    if (input.slot_id && input.slot_id !== record.role && input.slot_id !== record.work_identity?.slot_id) return false;
    if (input.task_id && input.task_id !== record.work_identity?.task_id) return false;
    if (input.work_identity && JSON.stringify(record.work_identity) !== JSON.stringify(input.work_identity)) return false;
    return true;
  });
  if (candidates.length !== 1) return { ok: false, error: candidates.length === 0 ? "unknown or already reconciled dispatch" : "ambiguous positional result", state };
  const record = candidates[0];
  if (!record) return { ok: false, error: "dispatch result identity disappeared", state };
  if (input.role && input.role !== record.role) return { ok: false, error: "dispatch role mismatch", state };
  if (input.pending) return pendingRecord(cwd, state, target, cap, record, input.pending_reason, input.provider_ref);
  const currentStage = loadProfile(cap.issued_for.workflow)?.stages.find((candidate) => candidate.id === cap.issued_for.stage_cursor);
  const artifact_ids = input.artifact_ids ?? (currentStage ? stageProduces(currentStage) : []);
  const terminalSignal = input.terminal_signal ?? "native_tool_result";
  if (record.completion) {
    if (record.completion.outcome !== input.outcome
      || record.completion.evidence !== input.evidence
      || canonicalJson(record.completion.artifact_ids) !== canonicalJson(artifact_ids)
      || !record.completion_envelope
      || record.completion_envelope.outcome !== input.outcome
      || record.completion_envelope.terminal_signal !== terminalSignal) {
      return { ok: false, error: "conflicting trusted task result replay", state };
    }
    try {
      persistTrustedTaskResultReceipt(pinnedRoot, target, state, record, record.completion_envelope, registerRollback, { state_revision: state.state_revision });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), state };
    }
    return { ok: true, state, record };
  }
  const identity = record.work_identity ?? workIdentityFor(state, cap, record.role, record.agent, record.id, record.attempt);
  const resultDigest = nativeReconciliationDigest(identity, input.outcome, input.evidence, artifact_ids, terminalSignal, input.provider_id);
  if (record.pending?.reconciliation && record.pending.reconciliation.result_digest !== resultDigest) {
    return { ok: false, error: "conflicting native artifact reconciliation", state };
  }
  const artifactsDirRelative = artifactsRelativeFor(pinnedRoot, target);
  if (artifactsDirRelative === null) return { ok: false, error: "workflow artifact directory is unavailable or outside the pinned project root", state };
  const multiSlot = cap.kind === "consilium" && cap.expected_count > 1;
  const sourceSlotId = multiSlot ? record.work_identity?.slot_id : undefined;
  const missingArtifacts = artifact_ids.filter((id) => {
    const logicalReady = artifactExistsPinned(pinnedRoot, artifactsDirRelative, id);
    const slotReady = sourceSlotId !== undefined && artifactExistsPinned(
      pinnedRoot,
      artifactsDirRelative,
      durableNamespacedArtifactId(id, sourceSlotId),
    );
    return !logicalReady && !slotReady && !Object.prototype.hasOwnProperty.call(state.artifacts ?? {}, id);
  });
  if (missingArtifacts.length > 0) {
    return deferNativeCompletion(cwd, state, target, cap, record, {
      outcome: input.outcome,
      evidence: input.evidence,
      artifact_ids,
      completed_by: "synchronous_tool_result",
      terminal_signal: terminalSignal,
      ...(input.provider_id ? { provider_id: input.provider_id } : {}),
    }, artifact_ids);
  }
  const completed = completeRecord(cwd, state, target, pinnedRoot, cap, record, {
    outcome: input.outcome,
    evidence: input.evidence,
    artifact_ids,
    completed_by: "synchronous_tool_result",
    terminal_signal: terminalSignal,
    ...(input.provider_id ? { provider_id: input.provider_id } : {}),
  }, beforeArtifactWrite, registerRollback);
  if (completed.ok && completed.record?.completion_envelope) {
    deferReceipt?.(completed.record, completed.record.completion_envelope);
  }
  return completed;
}
function stageProduces(stage: StageDef): string[] {
  if (Array.isArray(stage.produces)) return stage.produces;
  return stage.produces ? [stage.produces] : [];
}

/**
 * Prove that the selected phase has one canonical, current, passing
 * validation postimage. This is deliberately shared by native and legacy
 * workspaces: an empty validator completion is safe only after every
 * immutable identity, source-kind, binding, and document digest has been
 * re-read from the pinned root.
 */
function canonicalPhaseArtifactReady(
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  stage: StageDef,
): boolean {
  const workspace = state.specification;
  if ((workspace?.source_kind !== "native" && workspace?.source_kind !== "legacy")
    || !["specify", "plan", "tasks"].includes(stage.id)) return false;
  const phase = stage.id as "specify" | "plan" | "tasks";
  const record = workspace.phases.find((candidate) => candidate.phase === phase);
  const version = record?.current_version ?? null;
  const validationRef = version === null ? null : `validation.${phase}.v${version}`;
  const projectedDecision = record?.status === "approved" || record?.status === "revision_required";
  if (!record || (record.status !== "awaiting_approval" && !projectedDecision) || version === null || version < 1 || validationRef === null
    || record.validation_ref !== validationRef
    || !workspace.constitution_binding || validateConstitutionBinding(workspace.constitution_binding).length > 0
    || typeof state.run_key !== "string" || state.run_key.trim().length === 0) return false;
  if (record.status === "awaiting_approval"
    ? record.approved_version !== null
    : record.status === "approved"
      ? record.approved_version !== version || record.checkpoint_ref !== `checkpoint.${phase}.v${version}`
      : record.approved_version !== null || record.checkpoint_ref !== null) return false;

  const artifact = readCanonicalPhaseArtifact(pinnedRoot.canonical_root, {
    feature_id: workspace.feature_id,
    run_key: state.run_key,
    phase,
    version,
  }, pinnedRoot);
  const artifactsDirRelative = artifactsRelativeFor(pinnedRoot, target);
  const currentUpstream = record.upstream_versions.map((binding) => ({
    artifact_id: `${binding.phase}.v${binding.version}`,
    version: binding.version,
    hash: binding.hash,
  }));
  if (!artifact || !artifactsDirRelative
    || artifact.feature_id !== workspace.feature_id
    || artifact.run_key !== state.run_key
    || artifact.phase !== phase
    || artifact.version !== version
    || artifact.artifact_id !== `${phase}.v${version}`
    || canonicalJson(artifact.constitution_binding) !== canonicalJson(workspace.constitution_binding)
    || canonicalJson(artifact.upstream_versions) !== canonicalJson(currentUpstream)) return false;

  // Native source artifacts intentionally have no legacy provenance marker;
  // a legacy marker in a native workspace is a cross-source substitution.
  // Legacy records, conversely, must carry the migration marker explicitly.
  const sourceKind = artifact.source_artifact.source_kind;
  if (workspace.source_kind === "legacy" ? sourceKind !== "legacy" : sourceKind === "legacy") return false;

  const validation = readArtifactPinned<Record<string, unknown>>(pinnedRoot, artifactsDirRelative, validationRef);
  if (!validation
    || validation.validation_id !== validationRef
    || validation.phase !== phase
    || validation.artifact_version !== artifact.artifact_id
    || validation.status !== "pass"
    || typeof validation.validated_at !== "string") return false;
  const artifactDigest = digestOf(artifact);
  const validationDigest = digestOf(validation);
  // Historical typed decisions remain durable evidence, but multiple current
  // decisions bound to this exact artifact and validation are ambiguous and
  // must fail closed even before the legacy stop projection runs.
  const typedDecisions = (state.typed_checkpoint_decisions ?? []).filter((candidate) =>
    candidate.stage_id === phase
    && candidate.checkpoint_id === "specification_phase_approval"
    && candidate.feature_id === workspace.feature_id
    && candidate.artifact_id === artifact.artifact_id
    && candidate.artifact_version === version
    && candidate.artifact_digest === artifactDigest
    && candidate.validation_ref === validationRef
    && candidate.validation_digest === validationDigest,
  );
  if (typedDecisions.length > 1) return false;
  if (projectedDecision) {
    // An atomic selected Ask has already projected the phase record. Only its
    // one typed decision may authorize this postimage; the schema-1 mirror is
    // not an independent decision.
    if (typedDecisions.length !== 1) return false;
    const selected = selectLatestValidCheckpointDecision(
      { id: phase, checkpoint: "specification_phase_approval" },
      state,
      { bindCapability: true },
    );
    if (!selected.ok) return false;
    const decision = selected.decision;
    if (decision.feature_id !== workspace.feature_id
      || decision.artifact_id !== artifact.artifact_id
      || decision.artifact_version !== version
      || decision.artifact_digest !== artifactDigest
      || decision.validation_ref !== validationRef
      || decision.validation_digest !== validationDigest) return false;
  }
  const input = deterministicValidationInputForArtifact(artifact, pinnedRoot, validation.validated_at);
  if (input === null) return false;
  try {
    // Native validation carries an immutable artifact digest and the shared
    // matcher verifies that digest, all document bytes, and deterministic
    // validation output. Legacy validation deliberately has no artifact
    // digest, so compare its complete deterministic payload directly.
    return workspace.source_kind === "native"
      ? deterministicValidationMatchesArtifact(artifact, validation, pinnedRoot)
      : canonicalJson(validateNativePhase(input)) === canonicalJson(validation);
  } catch {
    return false;
  }
}

/**
 * Validate native completion bindings at the advance boundary and repair only
 * missing per-slot snapshots for already-declared logical artifact ids. Native
 * completions with missing files remain pending until a later retry.
 */
function recoverSynchronousArtifactIds(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  cap: ActiveCapability,
  stage: StageDef,
  canonicalPhaseArtifactReady = false,
  registerRollback?: DeferredCleanup,
): { ok: true; state: TeamState } | { ok: false; error: string } {
  const artifactsDirRelative = artifactsRelativeFor(pinnedRoot, target);
  if (artifactsDirRelative === null) return { ok: false, error: "workflow artifact directory is unavailable or outside the pinned project root" };
  const produces = stageProduces(stage);
  const multiSlot = cap.kind === "consilium" && cap.expected_count > 1;
  let recovered = state;
  const beforeArtifactWrite = (): void => {
    const workspace = recovered.specification;
    if (workspace && (workspace.source_kind === "native" || workspace.source_kind === "legacy" || workspace.source_kind === "external")) {
      const constitutionError = workspaceConstitutionError(pinnedRoot, workspace);
      if (constitutionError) throw new Error(constitutionError);
    }
  };
  for (const candidate of cap.dispatches) {
    const reconciliation = candidate.pending?.reconciliation;
    if (!candidate.completion && reconciliation) {
      const expectedDigest = nativeReconciliationDigest(
        reconciliation.identity,
        reconciliation.outcome,
        reconciliation.evidence,
        reconciliation.artifact_ids,
        reconciliation.terminal_signal,
        reconciliation.provider_id,
      );
      if (
        !sameIdentity(reconciliation.identity, candidate.work_identity)
        || reconciliation.result_digest !== expectedDigest
        || reconciliation.artifact_ids.length !== produces.length
        || reconciliation.artifact_ids.some((id) => !produces.includes(id))
      ) {
        return { ok: false, error: "invalid workflow state: stale native artifact reconciliation binding" };
      }
      const slotId = reconciliation.identity.slot_id;
      const missing = produces.filter((id) => {
        const storedId = multiSlot ? durableNamespacedArtifactId(id, slotId) : id;
        return !artifactExistsPinned(pinnedRoot, artifactsDirRelative, storedId);
      });
      if (missing.length > 0) {
        return { ok: false, error: `native completion artifacts are not ready: ${missing.join(", ")}` };
      }
      const currentCap = activeCapability(recovered.dispatch_capability);
      if (!currentCap) return { ok: false, error: "dispatch capability disappeared during artifact recovery" };
      const record = currentCap.dispatches.find((entry) => entry.id === candidate.id);
      if (!record || !record.pending?.reconciliation) return { ok: false, error: "native artifact reconciliation dispatch disappeared" };
      const result = completeRecord(cwd, recovered, target, pinnedRoot, currentCap, record, {
        outcome: reconciliation.outcome,
        evidence: reconciliation.evidence,
        artifact_ids: reconciliation.artifact_ids,
        completed_by: "synchronous_tool_result",
        terminal_signal: reconciliation.terminal_signal,
        ...(reconciliation.provider_id ? { provider_id: reconciliation.provider_id } : {}),
      }, beforeArtifactWrite, registerRollback);
      if (!result.ok) return { ok: false, error: result.error };
      recovered = result.state;
      continue;
    }
    const completion = candidate.completion;
    if (!completion) continue;
    if (!candidate.completion_envelope) return { ok: false, error: "invalid workflow state: terminal dispatch completion envelope is missing" };
    const completionIntegrityError = completionArtifactRefsError(pinnedRoot, artifactsDirRelative, candidate.completion_envelope);
    if (completionIntegrityError) return { ok: false, error: completionIntegrityError };
    const artifactIds = completion.artifact_ids;
    const exactProducedIds = artifactIds.length === produces.length
      && new Set(artifactIds).size === produces.length
      && artifactIds.every((id) => produces.includes(id));
    if (artifactIds.length > 0) {
      // Every explicit completion binding, including a forged validation
      // record, must name exactly the current stage outputs. Only re-enter
      // completion to create missing consilium snapshots; single-stage
      // artifacts are validated directly by the stage contract below.
      if (!exactProducedIds) {
        return { ok: false, error: "invalid workflow state: native completion artifact ids do not match the current stage.produces" };
      }
      if (!multiSlot) continue;
      const slotMap = recovered.slot_artifacts?.[stage.id]?.slots?.[candidate.role] ?? {};
      const needsSnapshot = artifactIds.some((id) => !slotMap[id]);
      if (!needsSnapshot || !artifactIds.every((id) => readArtifactPinned(pinnedRoot, artifactsDirRelative, id) !== null)) continue;
    } else if (produces.length > 0) {
      // A validated phase is bound to its canonical immutable phase artifact,
      // not the profile's generation artifact id. Its dedicated validation
      // dispatch intentionally records no artifact ids, but only a current
      // canonical phase postimage may take this path.
      if (canonicalPhaseArtifactReady && candidate.purpose === "validation") continue;
      return { ok: false, error: "invalid workflow state: native completion is missing the current stage.produces artifact ids" };
    } else {
      continue;
    }

    const currentCap = activeCapability(recovered.dispatch_capability);
    if (!currentCap) return { ok: false, error: "dispatch capability disappeared during artifact recovery" };
    const record = currentCap.dispatches.find((entry) => entry.id === candidate.id);
    if (!record) return { ok: false, error: "dispatch disappeared during artifact recovery" };
    const result = completeRecord(cwd, recovered, target, pinnedRoot, currentCap, record, {
      outcome: completion.outcome,
      evidence: `${completion.evidence}\r\nRecovered declared artifact ids at workflow advance.`,
      artifact_ids: artifactIds,
      completed_by: "synchronous_tool_result",
    }, beforeArtifactWrite, registerRollback);
    if (!result.ok) return { ok: false, error: result.error };
    recovered = result.state;
  }
  return { ok: true, state: recovered };
}

function objectArtifact(pinnedRoot: PinnedProjectRoot, artifactsDirRelative: string, id: string): Record<string, unknown> | null {
  const value = readArtifactPinned(pinnedRoot, artifactsDirRelative, id);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}


function readWorkspaceBoundHandoffPinned(
  state: TeamState,
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
): unknown | null {
  const workspace = state.specification;
  const handoffRef = workspace?.handoff_ref;
  if (
    !workspace
    || !isSafeFeatureId(workspace.feature_id)
    || typeof handoffRef !== "string"
    || !isSafeStateSegment(handoffRef)
    || handoffRef.includes("/")
  ) return null;
  const relativePath = artifactsDirRelative.length > 0
    ? `${artifactsDirRelative}/implementation_handoff/${handoffRef}.json`
    : `implementation_handoff/${handoffRef}.json`;
  const loaded = readCanonicalHandoff(pinnedRoot, relativePath, `workspace-bound handoff '${handoffRef}'`);
  if (!loaded.ok) return null;
  const handoff = loaded.handoff;
  return handoff.feature_id === workspace.feature_id
    && handoff.handoff_id === handoffRef
    ? handoff
    : null;
}

function evaluateStageGate(stage: StageDef, state: TeamState, target: ResolvedState, pinnedRoot: PinnedProjectRoot, flags: ScopeFlags): string | null {
  const gate = stage.gate?.trim();
  if (!gate) return null;
  const artifactsDir = target.artifactsDir;
  const artifactsDirRelative = artifactsRelativeFor(pinnedRoot, target);
  if (!artifactsDir || artifactsDirRelative === null) return "workflow artifact directory is unavailable or outside the pinned project root";
  const result = evaluatePredicate(gate, {
    flags,
    artifactsDir,
    state,
    stage,
    pinnedRoot,
    artifactsDirRelative,
    namedGate: (name) => {
      const named = NAMED_GATES[name];
      return named ? named(state, artifactsDir, pinnedRoot, artifactsDirRelative) : undefined;
    },
  });
  if (!result.ok) return result.error;
  return result.value ? null : `gate '${gate}' is not satisfied`;
}

/** Named gates are plain identifiers resolved by the predicate evaluator. */
const NAMED_GATES: Record<string, (state: TeamState, artifactsDir: string, pinnedRoot?: PinnedProjectRoot, artifactsDirRelative?: string) => string | null> = {
  branch_created: (state) => (state.branch.trim() ? null : "branch_created gate requires a persisted branch"),
  root_cause_documented: (_state, _artifactsDir, pinnedRoot, artifactsDirRelative) => {
    if (!pinnedRoot || artifactsDirRelative === undefined) return "root_cause_documented gate requires a pinned artifact root";
    const result = isRootCauseDocumentedPinned(pinnedRoot, artifactsDirRelative);
    return result.ok ? null : result.reason;
  },
  dod_complete: (_state, _artifactsDir, pinnedRoot, artifactsDirRelative) => {
    if (!pinnedRoot || artifactsDirRelative === undefined) return "dod_complete gate requires a pinned artifact root";
    const result = isDoDComplete(readDoDPinned(pinnedRoot, artifactsDirRelative));
    return result.ok ? null : `dod_complete gate is not satisfied (${result.pending.length} pending items)`;
  },
  plan_valid: (_state, artifactsDir, pinnedRoot, artifactsDirRelative) => {
    const plan = objectArtifact(pinnedRoot!, artifactsDirRelative!, "team_plan");
    return plan && Array.isArray(plan.teams) && plan.teams.length > 0 ? null : "plan_valid gate requires a non-empty team_plan.teams array";
  },
  contract_complete: (_state, artifactsDir, pinnedRoot, artifactsDirRelative) => {
    const architecture = objectArtifact(pinnedRoot!, artifactsDirRelative!, "architecture");
    return architecture && Array.isArray(architecture.options) && architecture.options.length > 0 && typeof architecture.chosen === "string" && architecture.chosen.trim() ? null : "contract_complete gate requires architecture options and a chosen option";
  },
  feature_spec_present: (_state, artifactsDir, pinnedRoot, artifactsDirRelative) => {
    const spec = objectArtifact(pinnedRoot!, artifactsDirRelative!, "feature_spec");
    return spec && typeof spec.goal === "string" && spec.goal.trim() && Array.isArray(spec.acceptance_criteria) && spec.acceptance_criteria.length > 0 ? null : "feature_spec_present gate requires a goal and acceptance criteria";
  },
  qa_reported_pass: (_state, artifactsDir, pinnedRoot, artifactsDirRelative) => {
    const tests = objectArtifact(pinnedRoot!, artifactsDirRelative!, "qa_tests");
    return tests?.build_status === "pass" ? null : "qa_reported_pass gate requires the canonical qa_tests artifact to report build_status=pass";
  },
  /**
   * Product approval gate. Requires a durable decision for the
   * (stage, checkpoint) pair ('product_approval', 'product_approval'):
   * recorded interactively, never autonomous, normalized to exactly one of
   * the four allowed product decisions. Attached to both the
   * `product_approval` stage (which records the decision) and the
   * `product_handoff` stage (which consumes the approval record), so the
   * decision lookup is keyed by the declaring stage id, not the gate host.
   */
  product_approval_recorded: (state) => {
    const PRODUCT_APPROVAL_STAGE = "product_approval";
    const PRODUCT_APPROVAL_CHECKPOINT = "product_approval";
    const PRODUCT_DECISIONS = ["proceed", "needs_more_validation", "defer", "reject"];
    const decision = findCheckpointDecision(state, PRODUCT_APPROVAL_STAGE, PRODUCT_APPROVAL_CHECKPOINT);
    if (!decision) {
      return "product_approval_recorded gate: no durable decision recorded for checkpoint 'product_approval' (stage 'product_approval'); the product owner must answer via workflow_checkpoint with checkpoint_kind=product_approval, authorization=human, and actor_provenance bound to the product-owner answer; decision exactly one of proceed | needs_more_validation | defer | reject — no inferred consent";
    }
    if (decision.mode !== "interactive") {
      return `product_approval_recorded gate: checkpoint 'product_approval' was not recorded with interactive human authorization (projection mode '${decision.mode}'); product approval requires actor provenance from the product owner — autonomous decisions are rejected`;
    }
    const normalized = decision.decision.trim().toLowerCase();
    if (!PRODUCT_DECISIONS.includes(normalized)) {
      return `product_approval_recorded gate: decision '${decision.decision}' is not one of the four allowed product approval decisions (proceed | needs_more_validation | defer | reject)`;
    }
    return null;
  },
};

type StageCompletionResult = { ok: true; notes: string[] } | { ok: false; error: string };

/**
 * Executable artifact contract policy for durable advance. Additive and
 * compatibility-first: the shipped default validates every schema-defined
 * artifact with no grandfathering; legacy artifacts can be grandfathered
 * explicitly via the authenticated registry transaction.
 */
type PolicyLease = {
  readonly principal: RegistryRegistrationPrincipal;
  readonly token: RegistryRegistrationToken;
  readonly liveGuard: () => void;
};
type PolicyCell<T> = {
  readonly descriptor_fingerprint: string;
  readonly value: T;
  readonly leases: Map<RegistryRegistrationPrincipal, Set<PolicyLease>>;
};
const MAX_POLICY_LEASES_PER_PRINCIPAL = 4;
const MAX_POLICY_LEASES = 256;

function policyLeaseCount<T>(cell: PolicyCell<T>): number {
  let count = 0;
  for (const leases of cell.leases.values()) count += leases.size;
  return count;
}

function removePolicyLease<T>(cell: PolicyCell<T>, lease: PolicyLease): void {
  const leases = cell.leases.get(lease.principal);
  if (!leases) return;
  leases.delete(lease);
  if (leases.size === 0) cell.leases.delete(lease.principal);
}

const privateDefaultArtifactContractPolicy: ArtifactContractPolicy = cloneAndFreeze({
  validate: DEFAULT_ARTIFACT_CONTRACT_POLICY.validate,
  grandfathered: [...DEFAULT_ARTIFACT_CONTRACT_POLICY.grandfathered],
});
let artifactContractPolicy: ArtifactContractPolicy = privateDefaultArtifactContractPolicy;
let artifactContractPolicyCell: PolicyCell<ArtifactContractPolicy> | undefined;

const privateDefaultFanInPolicy: FanInPolicy = cloneAndFreeze({
  enabled: true,
  strict: true,
});
let fanInPolicy: FanInPolicy = privateDefaultFanInPolicy;
let fanInPolicyCell: PolicyCell<FanInPolicy> | undefined;

function registryMutationError(code: "owner_conflict" | "registry_transaction_invalid", message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function plainPolicyRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactPolicyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw registryMutationError("registry_transaction_invalid", `${label}.${key} is not supported`);
  }
}

function normalizedArtifactContractPolicy(input: ArtifactContractPolicy): ArtifactContractPolicy {
  if (!plainPolicyRecord(input)) throw registryMutationError("registry_transaction_invalid", "artifact contract policy must be a plain object");
  const value = input as unknown as Record<string, unknown>;
  assertExactPolicyKeys(value, ["validate", "grandfathered"], "artifact contract policy");
  if (typeof value.validate !== "boolean") throw registryMutationError("registry_transaction_invalid", "artifact contract policy.validate must be boolean");
  if (!Array.isArray(value.grandfathered) || value.grandfathered.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw registryMutationError("registry_transaction_invalid", "artifact contract policy.grandfathered must be an array of non-empty strings");
  }
  return cloneAndFreeze({ validate: value.validate, grandfathered: [...value.grandfathered] });
}

function normalizedFanInPolicy(input: FanInPolicy): FanInPolicy {
  if (!plainPolicyRecord(input)) throw registryMutationError("registry_transaction_invalid", "fan-in policy must be a plain object");
  const value = input as unknown as Record<string, unknown>;
  assertExactPolicyKeys(value, ["enabled", "strict", "resolutions"], "fan-in policy");
  if (typeof value.enabled !== "boolean") throw registryMutationError("registry_transaction_invalid", "fan-in policy.enabled must be boolean");
  if (typeof value.strict !== "boolean") throw registryMutationError("registry_transaction_invalid", "fan-in policy.strict must be boolean");
  if (value.resolutions !== undefined && !Array.isArray(value.resolutions)) {
    throw registryMutationError("registry_transaction_invalid", "fan-in policy.resolutions must be an array when provided");
  }
  const resolutions = (value.resolutions ?? []).map((entry, index) => {
    if (!plainPolicyRecord(entry)) throw registryMutationError("registry_transaction_invalid", `fan-in policy.resolutions[${index}] must be a plain object`);
    assertExactPolicyKeys(entry, ["artifact", "field", "strategy", "rationale"], `fan-in policy.resolutions[${index}]`);
    if (typeof entry.artifact !== "string" || entry.artifact.trim().length === 0) throw registryMutationError("registry_transaction_invalid", `fan-in policy.resolutions[${index}].artifact must be a non-empty string`);
    if (typeof entry.field !== "string" || entry.field.trim().length === 0) throw registryMutationError("registry_transaction_invalid", `fan-in policy.resolutions[${index}].field must be a non-empty string`);
    if (entry.strategy !== "first_slot") throw registryMutationError("registry_transaction_invalid", `fan-in policy.resolutions[${index}].strategy must be 'first_slot'`);
    if (typeof entry.rationale !== "string" || entry.rationale.trim().length === 0) throw registryMutationError("registry_transaction_invalid", `fan-in policy.resolutions[${index}].rationale must be a non-empty string`);
    return { artifact: entry.artifact, field: entry.field, strategy: "first_slot" as const, rationale: entry.rationale };
  });
  return cloneAndFreeze({
    enabled: value.enabled,
    strict: value.strict,
    ...(value.resolutions !== undefined ? { resolutions } : {}),
  });
}

function sweepPolicyCell<T>(cell: PolicyCell<T> | undefined, reset: () => void): PolicyCell<T> | undefined {
  if (!cell) return undefined;
  for (const [principal, leases] of cell.leases) {
    for (const lease of [...leases]) {
      try { lease.liveGuard(); } catch { leases.delete(lease); }
    }
    if (leases.size === 0) cell.leases.delete(principal);
  }
  if (policyLeaseCount(cell) === 0) {
    reset();
    return undefined;
  }
  return cell;
}

function currentArtifactContractPolicy(): ArtifactContractPolicy {
  const cell = sweepPolicyCell(artifactContractPolicyCell, () => {
    artifactContractPolicyCell = undefined;
    artifactContractPolicy = privateDefaultArtifactContractPolicy;
  });
  return cell?.value ?? artifactContractPolicy;
}

function currentFanInPolicy(): FanInPolicy {
  const cell = sweepPolicyCell(fanInPolicyCell, () => {
    fanInPolicyCell = undefined;
    fanInPolicy = privateDefaultFanInPolicy;
  });
  return cell?.value ?? fanInPolicy;
}

function addPolicyLease<T>(
  token: RegistryRegistrationToken,
  cell: PolicyCell<T>,
  lease: PolicyLease,
  rollback: () => void,
): void {
  const leases = cell.leases.get(lease.principal) ?? new Set<PolicyLease>();
  if ([...leases].some((candidate) => candidate.token === token)) return;
  if (leases.size >= MAX_POLICY_LEASES_PER_PRINCIPAL || policyLeaseCount(cell) >= MAX_POLICY_LEASES) {
    throw registryMutationError("owner_conflict", `registry activation leases are bounded at ${MAX_POLICY_LEASES} per policy descriptor`);
  }
  // Register compensation before touching the shared cell. A token can be
  // exhausted/revoked while registering undo callbacks; that failure must
  // leave the policy publication exactly as it was.
  recordRegistryUndo(token, () => {
    removePolicyLease(cell, lease);
    rollback();
  });
  leases.add(lease);
  cell.leases.set(lease.principal, leases);
}

/** Register the process-global artifact contract policy under an open owner transaction. */
export function setArtifactContractPolicy(token: RegistryRegistrationToken, policy: ArtifactContractPolicy): void {
  requireRegistryRegistration(token, "artifact_contract_policy");
  const normalized = normalizedArtifactContractPolicy(policy);
  const principal = registryRegistrationPrincipal(token, "artifact_contract_policy");
  const liveGuard = createRegistryRegistrationLiveGuard(token, "artifact_contract_policy");
  const descriptor_fingerprint = descriptorFingerprint(normalized);
  const prior = sweepPolicyCell(artifactContractPolicyCell, () => {
    artifactContractPolicyCell = undefined;
    artifactContractPolicy = privateDefaultArtifactContractPolicy;
  });
  if (prior) {
    if (prior.descriptor_fingerprint !== descriptor_fingerprint) {
      throw registryMutationError("owner_conflict", "artifact contract policy is already registered by another descriptor");
    }
    addPolicyLease(token, prior, { principal, token, liveGuard }, () => {
      if (prior.leases.size === 0 && artifactContractPolicyCell === prior) {
        artifactContractPolicyCell = undefined;
        artifactContractPolicy = privateDefaultArtifactContractPolicy;
      }
    });
    return;
  }
  const inserted: PolicyCell<ArtifactContractPolicy> = Object.freeze({ descriptor_fingerprint, value: normalized, leases: new Map() });
  addPolicyLease(token, inserted, { principal, token, liveGuard }, () => {
    if (artifactContractPolicyCell === inserted) {
      artifactContractPolicyCell = undefined;
      artifactContractPolicy = privateDefaultArtifactContractPolicy;
    }
  });
  artifactContractPolicyCell = inserted;
  artifactContractPolicy = normalized;
}

/** Register the process-global consilium fan-in policy under an open owner transaction. */
export function setFanInPolicy(token: RegistryRegistrationToken, policy: FanInPolicy): void {
  requireRegistryRegistration(token, "fan_in_policy");
  const normalized = normalizedFanInPolicy(policy);
  const principal = registryRegistrationPrincipal(token, "fan_in_policy");
  const liveGuard = createRegistryRegistrationLiveGuard(token, "fan_in_policy");
  const descriptor_fingerprint = descriptorFingerprint(normalized);
  const prior = sweepPolicyCell(fanInPolicyCell, () => {
    fanInPolicyCell = undefined;
    fanInPolicy = privateDefaultFanInPolicy;
  });
  if (prior) {
    if (prior.descriptor_fingerprint !== descriptor_fingerprint) {
      throw registryMutationError("owner_conflict", "fan-in policy is already registered by another descriptor");
    }
    addPolicyLease(token, prior, { principal, token, liveGuard }, () => {
      if (prior.leases.size === 0 && fanInPolicyCell === prior) {
        fanInPolicyCell = undefined;
        fanInPolicy = privateDefaultFanInPolicy;
      }
    });
    return;
  }
  const inserted: PolicyCell<FanInPolicy> = Object.freeze({ descriptor_fingerprint, value: normalized, leases: new Map() });
  addPolicyLease(token, inserted, { principal, token, liveGuard }, () => {
    if (fanInPolicyCell === inserted) {
      fanInPolicyCell = undefined;
      fanInPolicy = privateDefaultFanInPolicy;
    }
  });
  fanInPolicyCell = inserted;
  fanInPolicy = normalized;
}

/**
 * Constitution bootstrap continuation gate (T020): while a specification
 * origin's constitution bootstrap is pending, the durable cursor must block
 * instead of advancing. Gates are project-scoped by the owner token's
 * canonical root; no public clear/reset route exists.
 */
type ConstitutionGateRegistration = {
  readonly gate: ConstitutionContinuationGate;
  readonly principal: RegistryRegistrationPrincipal;
  readonly descriptor_fingerprint: string;
  readonly root_dev: number;
  readonly root_ino: number;
  readonly leases: Map<object, () => void>;
};
const constitutionContinuationGates = new Map<string, ConstitutionGateRegistration>();
const CONSTITUTION_CONTINUATION_GATES_MAX = 255;

function sweepConstitutionContinuationGates(): void {
  for (const [root, registration] of constitutionContinuationGates) {
    for (const [token, liveGuard] of registration.leases) {
      try { liveGuard(); } catch { registration.leases.delete(token); }
    }
    if (registration.leases.size === 0) constitutionContinuationGates.delete(root);
  }
}

/** Register a constitution continuation gate under an open owner transaction. */
export function setConstitutionContinuationGate(
  token: RegistryRegistrationToken,
  gate: ConstitutionContinuationGate,
): void {
  requireRegistryRegistration(token, "constitution_gate");
  if (typeof gate !== "function") throw registryMutationError("registry_transaction_invalid", "constitution continuation gate must be a function");
  const principal = registryRegistrationPrincipal(token, "constitution_gate");
  const liveGuard = createRegistryRegistrationLiveGuard(token, "constitution_gate");
  const root = registryRegistrationProjectRoot(token, "constitution_gate");
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot || pinnedRoot.canonical_root !== root || !pinnedRoot.isStable()) {
    pinnedRoot?.close();
    throw registryMutationError("owner_conflict", `constitution continuation gate root '${root}' could not be pinned safely`);
  }
  try {
    // Revalidate the token after pinning: the descriptor identity and root
    // authorization must still describe the exact pinned root before we
    // publish a process-global registration.
    requireRegistryRegistration(token, "constitution_gate");
    const validatedPrincipal = registryRegistrationPrincipal(token, "constitution_gate");
    const validatedRoot = registryRegistrationProjectRoot(token, "constitution_gate");
    if (validatedPrincipal !== principal || validatedRoot !== pinnedRoot.canonical_root || !pinnedRoot.isStable()) {
      throw registryMutationError("owner_conflict", `constitution continuation gate root '${root}' authorization changed while pinning`);
    }
    liveGuard();
    const descriptor_fingerprint = descriptorFingerprint(gate);
    sweepConstitutionContinuationGates();
    const prior = constitutionContinuationGates.get(root);
    if (prior) {
      const sameIdentity = prior.root_dev === pinnedRoot.dev && prior.root_ino === pinnedRoot.ino;
      if (!sameIdentity) {
        // A stale physical-root entry should have been swept by its live guard;
        // retain fail-closed behavior if an authenticated old lease still lives.
        throw registryMutationError("owner_conflict", `constitution continuation gate is already registered for replaced project root '${root}'`);
      }
      if (prior.descriptor_fingerprint !== descriptor_fingerprint) {
        throw registryMutationError("owner_conflict", `constitution continuation gate is already registered for project root '${root}'`);
      }
      const lease: () => void = liveGuard;
      const key = token as unknown as object;
      if (!prior.leases.has(key)) {
        // Compensation must be armed before the lease becomes visible.
        recordRegistryUndo(token, () => {
          if (prior.leases.get(key) !== lease) return;
          prior.leases.delete(key);
          if (prior.leases.size === 0 && constitutionContinuationGates.get(root) === prior) constitutionContinuationGates.delete(root);
        });
        prior.leases.set(key, lease);
      }
      return;
    }
    if (constitutionContinuationGates.size >= CONSTITUTION_CONTINUATION_GATES_MAX) {
      throw registryMutationError("owner_conflict", "recovery_required: constitution continuation gate registry is at capacity; an active registration must be released before registering another project root");
    }
    const inserted: ConstitutionGateRegistration = Object.freeze({
      gate,
      principal,
      descriptor_fingerprint,
      root_dev: pinnedRoot.dev,
      root_ino: pinnedRoot.ino,
      leases: new Map(),
    });
    const key = token as unknown as object;
    // Arm rollback before publishing either the lease or the global cell.
    recordRegistryUndo(token, () => {
      if (constitutionContinuationGates.get(root) !== inserted) return;
      inserted.leases.delete(key);
      if (inserted.leases.size === 0) constitutionContinuationGates.delete(root);
    });
    inserted.leases.set(key, liveGuard);
    constitutionContinuationGates.set(root, inserted);
  } finally {
    pinnedRoot.close();
  }
}

function validateStageCompletion(
  stage: StageDef,
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  evidence: string,
  flags: ScopeFlags,
  profile: NonNullable<ReturnType<typeof loadProfile>>,
  deferProducedValidation = false,
): StageCompletionResult {
  if (!evidence.trim()) return { ok: false, error: "stage completion evidence required" };
  const artifactsDir = target.artifactsDir ?? "";
  const artifactsDirRelative = artifactsRelativeFor(pinnedRoot, target);
  if (artifactsDirRelative === null) return { ok: false, error: "workflow artifact directory is unavailable or outside the pinned project root" };
  const boundedArtifactsDirRelative: string = artifactsDirRelative;
  if (!deferProducedValidation) {
    for (const id of stageProduces(stage)) {
      if (!isSafeStateSegment(id)) return { ok: false, error: `unsafe stage artifact id '${id}'` };
      // Implementation handoffs are immutable, feature-scoped records. Their
      // workspace handoff_ref is the only authority; a flat
      // implementation_handoff.json must never satisfy this gate.
      const value = id === "implementation_handoff"
        ? readWorkspaceBoundHandoffPinned(state, pinnedRoot, boundedArtifactsDirRelative)
        : readArtifactPinned(pinnedRoot, boundedArtifactsDirRelative, id);
      if (value === null) return { ok: false, error: `required stage artifact '${id}.json' is missing or invalid` };
      const validated = validateProducedArtifact(id, value, currentArtifactContractPolicy());
      if (!validated.ok) {
        return {
          ok: false,
          error: `produced artifact '${id}' violates its contract: ${validated.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}`,
        };
      }
    }
  }
  const consumed = validateConsumedArtifacts(stage, artifactsDir, state, profile, currentArtifactContractPolicy(), {
    pinnedRoot,
    artifactsDirRelative: boundedArtifactsDirRelative,
  });
  if (!consumed.ok) return { ok: false, error: consumed.error };
  const gateError = evaluateStageGate(stage, state, target, pinnedRoot, flags);
  if (gateError) return { ok: false, error: gateError };
  const notes = consumed.diagnostics
    .filter((diagnostic) => diagnostic.missing && diagnostic.issues.length === 0)
    .map((diagnostic) => `consumed artifact '${diagnostic.id}' is absent (producer ${diagnostic.producer_status ?? "unknown"})`);
  return { ok: true, notes };
}

/**
 * Executable `document` stage render at the durable advance boundary: the
 * engine — not an agent — renders the declared document from the stage's
 * declared sources and persists the document plus the typed artifact.
 * Fail-closed: a missing source, an unsupported contract or an unsafe
 * path blocks the transition before anything is marked done.
 */
function renderStageDocument(
  stage: StageDef,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  registerRollback: (cleanup: () => void) => void,
): { ok: true } | { ok: false; error: string } {
  const contract = stage.document;
  if (!contract) return { ok: false, error: `document stage ${stage.id} is missing its document declaration` };
  if (contract.format !== "markdown") {
    return { ok: false, error: `document stage ${stage.id} declares an unsupported document contract (format ${contract.format}, renderer ${contract.renderer})` };
  }
  let renderer: DocumentRenderer;
  try {
    renderer = requireDocumentRenderer(contract.renderer);
  } catch (error) {
    return { ok: false, error: `document stage ${stage.id}: ${String(error)}` };
  }
  const artifactsDirRelative = artifactsRelativeFor(pinnedRoot, target);
  const stateDirRelative = target.stateDir ? pinnedRoot.relativePath(target.stateDir) : null;
  if (artifactsDirRelative === null || stateDirRelative === null) {
    return { ok: false, error: `document stage ${stage.id}: state/artifacts directory is outside the pinned project root` };
  }
  const sourceArtifacts: Record<string, unknown> = {};
  for (const id of renderer.requiredSourceArtifacts) {
    const artifact = readArtifactPinned(pinnedRoot, artifactsDirRelative, id);
    if (artifact === null) return { ok: false, error: `document stage ${stage.id}: source artifact ${id}.json not found` };
    sourceArtifacts[id] = artifact;
  }
  if (!pinnedRoot.isStable()) return { ok: false, error: `document stage ${stage.id}: project root changed before render` };
  const workspace = target.state?.specification;
  if (workspace?.constitution_binding) {
    const constitutionError = workspaceConstitutionError(pinnedRoot, workspace);
    if (constitutionError) return { ok: false, error: `document stage ${stage.id}: ${constitutionError}` };
  }
  try {
    const written = renderer.render({
      pinnedRoot,
      stateDirRelative,
      artifactsDirRelative,
      path: contract.path,
      sourceArtifacts,
      registerRollback,
    });
    if (!written.ok) {
      return { ok: false, error: `document stage ${stage.id} render failed: ${written.error}` };
    }
    if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", `document stage ${stage.id} render changed the project root`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `document stage ${stage.id} render failed: ${String(error)}` };
  }
}

type AdvanceCursorOptions = TrustedMappingOptions & { persistedStage?: PersistedStagePostimage };

export function advanceCursor(cwd: string, input: DispatchAuth, options?: AdvanceCursorOptions & DurableTransactionOptions): TransitionResult {
  let guardedRoot: PinnedProjectRoot | undefined;
  let guardedWorkspace: FeatureWorkspace | undefined;
  const deferredCleanups: Array<() => void> = [];
  const deferredProofConsumptions: Array<() => void> = [];
  const deferredRollbacks: Array<() => void> = [];
  const transactionOptions: AdvanceCursorOptions & DurableTransactionOptions = {
    ...(options ?? {}),
    onAbort: () => { options?.onAbort?.(); for (const rollback of deferredRollbacks.slice().reverse()) rollback(); },
    preCommit: () => {
      options?.preCommit?.();
      if (guardedRoot && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
        const constitutionError = workspaceConstitutionError(guardedRoot, guardedWorkspace);
        if (constitutionError) throw new Error(constitutionError);
      }
    },
    postCommit: () => {
      for (const cleanup of deferredCleanups) cleanup();
      for (const consume of deferredProofConsumptions) consume();
    },
  };
  const result = runDurableTransaction(cwd, { ...input, ...(options ?? {}) }, (state, target, pinnedRoot) => {
    guardedRoot = pinnedRoot;
    guardedWorkspace = state.specification;
    const result = advanceCursorMutation(cwd, state, target, pinnedRoot, input, options, (cleanup) => { deferredCleanups.push(cleanup); }, (cleanup) => { deferredRollbacks.push(cleanup); });
    if (result.ok && options?.trustedMappingProof !== undefined && options.consumeTrustedMappingProof !== false) deferredProofConsumptions.push(() => consumeTrustedMappingProof(options.trustedMappingProof));
    if (result.state?.specification) guardedWorkspace = result.state.specification;
    return result;
  }, transactionOptions);
  return result;
}

/** Advance a restart-loaded stage using its exact persisted postimage. */
export function advanceCursorFromPersisted(
  cwd: string,
  input: PersistedStagePostimage & { evidence: string },
  options?: TrustedMappingOptions & DurableTransactionOptions,
): TransitionResult {
  const authInput: DispatchAuth = { ...input, token: "__persisted_stage_postimage__" };
  const advanceOptions: AdvanceCursorOptions = { ...(options ?? {}), persistedStage: input };
  let guardedRoot: PinnedProjectRoot | undefined;
  let guardedWorkspace: FeatureWorkspace | undefined;
  const deferredCleanups: Array<() => void> = [];
  const deferredProofConsumptions: Array<() => void> = [];
  const deferredRollbacks: Array<() => void> = [];
  const transactionOptions: DurableTransactionOptions = {
    ...(options ?? {}),
    onAbort: () => { options?.onAbort?.(); for (const rollback of deferredRollbacks.slice().reverse()) rollback(); },
    preCommit: () => {
      options?.preCommit?.();
      if (guardedRoot && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
        const constitutionError = workspaceConstitutionError(guardedRoot, guardedWorkspace);
        if (constitutionError) throw new Error(constitutionError);
      }
    },
    postCommit: () => {
      for (const cleanup of deferredCleanups) cleanup();
      for (const consume of deferredProofConsumptions) consume();
    },
  };
  const result = runDurableTransaction(cwd, input, (state, target, pinnedRoot) => {
    guardedRoot = pinnedRoot;
    guardedWorkspace = state.specification;
    const mutationResult = advanceCursorMutation(cwd, state, target, pinnedRoot, authInput, advanceOptions, (cleanup) => { deferredCleanups.push(cleanup); }, (cleanup) => { deferredRollbacks.push(cleanup); });
    if (mutationResult.ok && options?.trustedMappingProof !== undefined && options.consumeTrustedMappingProof !== false) deferredProofConsumptions.push(() => consumeTrustedMappingProof(options.trustedMappingProof));
    if (mutationResult.state?.specification) guardedWorkspace = mutationResult.state.specification;
    return mutationResult;
  }, transactionOptions);
  return result;
}

function advanceCursorMutation(
  cwd: string,
  rawState: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  input: DispatchAuth,
  options?: AdvanceCursorOptions,
  deferCleanup?: DeferredCleanup,
  registerRollback?: (cleanup: () => void) => void,
): TransitionResult {
  if (input.feature_id !== undefined && !isSafeFeatureId(input.feature_id)) return { ok: false, error: "advance feature_id must be a canonical safe feature id", state: rawState };
  const persistedStage = options?.persistedStage;
  const advanceFields: Array<unknown> = [input.token, input.capability_id, input.run_key, input.branch, input.workflow, input.profile_hash, input.stage_cursor, input.cursor_epoch];
  if (advanceFields.some((value) => !selectedBoundedString(value, MAX_ADVANCE_FIELD_BYTES))) return { ok: false, error: "advance authorization fields must be bounded line-inert strings", state: rawState };
  if (!selectedBoundedString(input.evidence, MAX_ADVANCE_EVIDENCE_BYTES)) return { ok: false, error: "advance evidence must be bounded line-inert text", state: rawState };
  const cap = activeCapability(rawState.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state: rawState };
  const stateBindingError = stateCapabilityBindingError(rawState, cap, pinnedRoot, input.feature_id);
  if (stateBindingError) return { ok: false, error: stateBindingError, state: rawState };
  const error = persistedStage
    ? persistedStageAuthError(rawState, cap, persistedStage)
    : auth(cap, input, cap.advance_token_hash);
  if (error) return { ok: false, error, state: rawState };
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state: rawState };
  if (input.cursor_epoch !== cap.issued_for.cursor_epoch || rawState.stage_cursor !== cap.issued_for.stage_cursor || rawState.cursor_epoch !== cap.issued_for.cursor_epoch) return { ok: false, error: "stale cursor binding", state: rawState };
  if (typeof input.evidence !== "string" || !input.evidence.trim()) return { ok: false, error: "stage advancement evidence required", state: rawState };
  const profile = loadProfile(cap.issued_for.workflow);
  if (!profile || profileHash(profile) !== cap.issued_for.profile_hash) return { ok: false, error: "workflow profile is missing or stale", state: rawState };
  const currentStage = profile.stages.find((candidate) => candidate.id === rawState.stage_cursor);
  if (!currentStage) return { ok: false, error: "current workflow stage unavailable", state: rawState };
  if (currentStage.roster_policy && options?.trustedMappingProof === undefined) {
    return { ok: false, error: `workflow stage '${currentStage.id}' requires an engine-issued trusted agent mapping proof before advancement`, state: rawState };
  }
  const advanceConstitutionError = (candidate: TeamState["specification"]): string | null => {
    if (!candidate || (candidate.source_kind !== "native" && candidate.source_kind !== "legacy" && candidate.source_kind !== "external")) return null;
    return workspaceConstitutionError(pinnedRoot, candidate);
  };
  const nativePhaseCheckpoint = currentStage.checkpoint === "specification_phase_approval"
    && ["specify", "plan", "tasks"].includes(currentStage.id);
  if (nativePhaseCheckpoint) {
    const workspace = rawState.specification && (rawState.specification.source_kind === "native" || rawState.specification.source_kind === "legacy")
      ? rawState.specification
      : null;
    if (!workspace || !isSafeFeatureId(workspace.feature_id)) {
      return { ok: false, error: "native checkpoint decision is missing or not bound to the current feature, artifact, and validation", state: rawState };
    }
  }
  if (rawState.specification?.source_kind === "external") {
    const workspace = rawState.specification;
    const checkpointId = currentStage.checkpoint;
    const selectedDecision = checkpointId
      ? selectLatestValidCheckpointDecision({ id: currentStage.id, checkpoint: checkpointId }, rawState)
      : { ok: false as const, code: "checkpoint_unresolved" as const, error: "external checkpoint is not declared" };
    const typedDecision = selectedDecision.ok ? selectedDecision.decision : undefined;
    if (!checkpointId || !typedDecision || typedDecision.feature_id !== workspace.feature_id || !typedDecision.subject_binding || typedDecision.loop_iteration === undefined) {
      return { ok: false, error: selectedDecision.ok ? "external checkpoint subject binding is missing; re-authorize the selected checkpoint" : selectedDecision.error, state: rawState };
    }
    const policy = resolveCheckpointPolicy(currentStage, rawState);
    const rule = policy?.rules[checkpointId];
    if (!policy || !rule) return { ok: false, error: "external checkpoint policy is unavailable during advance revalidation", state: rawState };
    const selectedInput: CheckpointAskSelectedRequest = {
      feature_id: workspace.feature_id,
      token: input.token,
      capability_id: input.capability_id,
      run_key: input.run_key,
      branch: input.branch,
      workflow: input.workflow,
      profile_hash: input.profile_hash,
      stage_cursor: input.stage_cursor,
      cursor_epoch: input.cursor_epoch,
      checkpoint: checkpointId,
      checkpoint_id: checkpointId,
      checkpoint_kind: rule.kind,
      loop_iteration: typedDecision.loop_iteration,
    };
    const subjectResult = selectedSubjectForCheckpoint(pinnedRoot, rawState, target, selectedInput, currentStage, profile!, policy, rule, rule.allowed_decisions);
    if (subjectResult.error || !subjectResult.subject) return { ok: false, error: subjectResult.error ?? "external checkpoint subject could not be revalidated", state: rawState };
    if (subjectResult.subject.binding !== typedDecision.subject_binding || subjectResult.subject.loop_iteration !== typedDecision.loop_iteration) {
      return { ok: false, error: "external checkpoint source, constitution, report, or workspace subject changed; re-authorize", state: rawState };
    }
    const answerId = typedDecision.actor.proof?.answer_id;
    const answer = answerId ? (rawState.trusted_checkpoint_answers ?? []).find((candidate) => candidate.answer_id === answerId) : undefined;
    if (!answer || answer.feature_id !== workspace.feature_id || answer.subject_binding !== subjectResult.subject.binding || answer.loop_iteration !== subjectResult.subject.loop_iteration || answer.subject_revision === undefined || answer.subject_revision > selectedStateRevision(rawState)) {
      return { ok: false, error: "external checkpoint proof is stale or not bound to the current subject", state: rawState };
    }
  }
  // Constitution bootstrap continuation (T020): a pending constitution
  // bootstrap blocks the exact originating cursor before any transition. A
  // specification state without a registered gate fails closed; non-spec and
  // custom flows retain the historical no-gate behavior.
  sweepConstitutionContinuationGates();
  const continuationRegistration = constitutionContinuationGates.get(pinnedRoot.canonical_root);
  if (rawState.specification) {
    if (!continuationRegistration) return { ok: false, error: `constitution continuation gate is unavailable for pinned project root ${pinnedRoot.canonical_root}`, state: rawState };
    if (
      continuationRegistration.root_dev !== pinnedRoot.dev
      || continuationRegistration.root_ino !== pinnedRoot.ino
      || !pinnedRoot.isStable()
    ) {
      return { ok: false, error: `constitution continuation gate is unavailable for the authenticated root identity '${pinnedRoot.canonical_root}'`, state: rawState };
    }
    const constitutionBlock = continuationRegistration.gate({ state: rawState, stage: currentStage });
    if (constitutionBlock) return { ok: false, error: constitutionBlock, state: rawState };
  }

  const config = resolveConfig(cwd, undefined, pinnedRoot);
  const trusted = bindTrustedMapping(cwd, pinnedRoot, config, options?.trustedMappingProof);
  if (!trusted.ok) return { ok: false, error: trusted.error, state: rawState };
  const effectiveConfig = trusted.config;
  const flags = rawState.scope ?? resolveScope([], config);
  const artifactsDirRelative = artifactsRelativeFor(pinnedRoot, target);
  if (artifactsDirRelative === null) return { ok: false, error: "artifact directory is outside the pinned project root", state: rawState };
  const canonicalArtifactReady = canonicalPhaseArtifactReady(rawState, target, pinnedRoot, currentStage);
  const migratedArtifactReady = canonicalArtifactReady && rawState.specification?.source_kind === "legacy";
  const recovered = recoverSynchronousArtifactIds(cwd, rawState, target, pinnedRoot, cap, currentStage, canonicalArtifactReady, registerRollback);
  if (!recovered.ok) return { ok: false, error: recovered.error, state: rawState };
  let state = recovered.state;

  // Join by the persisted slot identity, never by array position or provider
  // result order. A retry replaces only the same slot's terminal record.
  const joinCap = activeCapability(state.dispatch_capability) ?? cap;
  const expected = new Set(joinCap.expected_roles);
  const nativeGenerationDispatch = state.specification?.source_kind === "native"
    && ["specify", "plan", "tasks"].includes(currentStage.id);
  const latest = new Map<string, DispatchRecord>();
  for (const record of joinCap.dispatches) {
    if (nativeGenerationDispatch && record.purpose === "generation") continue;
    const prior = latest.get(record.role);
    if (!prior || record.attempt > prior.attempt) latest.set(record.role, record);
  }
  const records = Array.from(latest.values()).sort((left, right) => left.role.localeCompare(right.role));
  const incomplete = records.some((record) => !expected.has(record.role) || record.status !== "succeeded")
    || records.length !== joinCap.expected_count
    || joinCap.expected_roles.some((role) => !latest.has(role));
  if (incomplete) {
    const pending = records.find((record) => record.status === "pending")?.pending ?? state.pending;
    if (pending) {
      const pendingState: TeamState = {
        ...state,
        pending,
        pause: { kind: "background_wait", reason: "dispatch join remains pending" },
        updated_at: now(),
      };
      return { ok: false, error: "dispatch join pending", state: pendingState };
    }
    return { ok: false, error: "dispatch join incomplete", state };
  }
  const joinSummary = {
    stage_id: rawState.stage_cursor,
    cursor_epoch: cap.issued_for.cursor_epoch,
    dispatch_ids: records.map((r) => r.id),
    roles: records.map((r) => r.role),
    evidence: input.evidence.trim(),
    joined_at: now(),
  };

  // Fan-in: deterministically synthesize multi-slot consilium results into
  // the stable shared artifact ids before any validation or handoff. Missing
  // slot results and collisions fail closed; schema-required scalar
  // disagreements block by default (strict) unless the stage declares an
  // explicit, documented resolution — every applied resolution is recorded
  // in the synthesis provenance (`conflicts`).
  const isMultiSlotConsilium = cap.kind === "consilium" && cap.expected_count > 1;
  if (isMultiSlotConsilium) {
    const currentRecords = activeCapability(state.dispatch_capability)?.dispatches ?? records;
    const withoutArtifacts = currentRecords
      .filter((record) => (!nativeGenerationDispatch || record.purpose !== "generation") && record.status === "succeeded" && (record.completion?.artifact_ids.length ?? 0) === 0)
      .map((record) => `${record.role} (${durableNamespacedArtifactId(stageProduces(currentStage)[0] ?? "artifact", record.role)})`);
    if (withoutArtifacts.length > 0) {
      return {
        ok: false,
        error: `consilium fan-in incomplete: dispatches without recorded artifact_ids: ${withoutArtifacts.join(", ")}; call workflow_complete with each slot's artifact ids before workflow_advance`,
        state,
      };
    }
  }
  if (isMultiSlotConsilium) {
    const activeFanInPolicy = currentFanInPolicy();
    const policy: FanInPolicy = {
      ...activeFanInPolicy,
      resolutions: [...(activeFanInPolicy.resolutions ?? []), ...(currentStage.fan_in?.resolutions ?? [])],
    };
    let synthesized: SynthesisResult;
    const fanInConstitutionError = advanceConstitutionError(state.specification);
    if (fanInConstitutionError) return { ok: false, error: fanInConstitutionError, state };
    try {
      synthesized = synthesizeArtifacts(
        state,
        currentStage.id,
        target.artifactsDir ?? "",
        stageProduces(currentStage),
        cap.expected_roster.map((entry) => entry.role),
        policy,
        pinnedRoot,
        {
          beforeWrite: () => {
            const liveConstitutionError = advanceConstitutionError(state.specification);
            if (liveConstitutionError) throw new Error(liveConstitutionError);
          },
          registerRollback,
        },
      );
    } catch {
      return { ok: false, error: "consilium fan-in failed safely: bounded structure, canonicalization, or merge failure", state };
    }
    if (!synthesized.ok) return { ok: false, error: synthesized.error, state };
    state = synthesized.state;
  }
  // Validate every consumed source before a document renderer can write any
  // output. Produced artifacts are deferred for document stages because the
  // renderer creates them as part of the same advance.
  if (currentStage.type === "document") {
    const sourceValidation = validateStageCompletion(currentStage, state, target, pinnedRoot, input.evidence, flags, profile, true);
    if (!sourceValidation.ok) return { ok: false, error: sourceValidation.error, state };
    const renderConstitutionError = advanceConstitutionError(state.specification);
    if (renderConstitutionError) return { ok: false, error: renderConstitutionError, state };
    if (!registerRollback) return { ok: false, error: "document stage rollback registrar is unavailable", state };
    const rendered = renderStageDocument(currentStage, target, pinnedRoot, registerRollback);
    if (!rendered.ok) return { ok: false, error: rendered.error, state };
  }

  // Stage completion validation: consumed and produced artifact contracts,
  // plus the profile gate expression, all fail closed.
  const completion = validateStageCompletion(currentStage, state, target, pinnedRoot, input.evidence, flags, profile, migratedArtifactReady);
  if (!completion.ok) return { ok: false, error: completion.error, state };

  // Isolate the diagnostic pause from the transaction snapshot.
  const checkpointState = { ...state };
  const checkpointError = unresolvedCheckpointError(currentStage, checkpointState);
  if (checkpointError) {
    const pauseChanged = checkpointState.pause.kind !== state.pause.kind || checkpointState.pause.reason !== state.pause.reason;
    return { ok: false, error: checkpointError, state: pauseChanged ? checkpointState : state };
  }
  const taskCheckpointSelection = currentStage.checkpoint
    ? selectLatestValidCheckpointDecision({ id: currentStage.id, checkpoint: currentStage.checkpoint }, state)
    : { ok: false as const, code: "checkpoint_unresolved" as const, error: "tasks checkpoint is not declared" };
  const taskCheckpointDecision = taskCheckpointSelection.ok ? taskCheckpointSelection.decision : undefined;
  const taskCheckpointEffect = taskCheckpointDecision ? checkpointDecisionEffect(taskCheckpointDecision) : null;
  if (nativePhaseCheckpoint) {
    const workspace = state.specification && (state.specification.source_kind === "native" || state.specification.source_kind === "legacy")
      ? state.specification
      : null;
    const phase = currentStage.id as "specify" | "plan" | "tasks";
    const phaseRecord = workspace?.phases.find((record) => record.phase === phase);
    const postDecisionProjected = phaseRecord?.status === "approved" || phaseRecord?.status === "revision_required";
    // commitCheckpointAnswerSelected({ apply_decision: true }) atomically
    // persists the typed decision and projects the native phase before this
    // advance call. Re-running the pre-answer awaiting_approval identity here
    // would reject that exact, already-applied decision; canonical readiness
    // above has revalidated its artifact/validation digests instead.
    const nativeIdentity = workspace && !postDecisionProjected
      ? selectedNativePhaseIdentity(pinnedRoot, target, workspace, currentStage, undefined, taskCheckpointDecision !== undefined)
      : { identity: null };
    const identity = nativeIdentity.identity;
    const bindingComplete = !workspace || postDecisionProjected || Boolean(taskCheckpointDecision
      && taskCheckpointDecision.feature_id === (workspace.feature_id ?? input.feature_id)
      && typeof taskCheckpointDecision.artifact_id === "string"
      && Number.isSafeInteger(taskCheckpointDecision.artifact_version)
      && (taskCheckpointDecision.artifact_version ?? 0) >= 1
      && isSha256Hex(taskCheckpointDecision.artifact_digest)
      && typeof taskCheckpointDecision.validation_ref === "string"
      && isSha256Hex(taskCheckpointDecision.validation_digest));
    const exactNativeBinding = !workspace || postDecisionProjected || Boolean(identity && taskCheckpointDecision
      && taskCheckpointDecision.artifact_id === identity.artifact_id
      && taskCheckpointDecision.artifact_version === identity.artifact_version
      && taskCheckpointDecision.artifact_digest === identity.artifact_digest
      && taskCheckpointDecision.validation_ref === identity.validation_ref
      && taskCheckpointDecision.validation_digest === identity.validation_digest);
    if ((postDecisionProjected && !canonicalArtifactReady) || (!postDecisionProjected && (nativeIdentity.error || !bindingComplete || !exactNativeBinding))) {
      return {
        ok: false,
        error: nativeIdentity.error ?? "native checkpoint decision is missing or not bound to the current feature, artifact, and validation",
        state,
      };
    }
  }
  if (taskCheckpointEffect === "revise") {
    const phase = ["specify", "plan", "tasks"].includes(currentStage.id)
      ? currentStage.id as "specify" | "plan" | "tasks"
      : null;
    const revisionWorkspace = state.specification
      ? {
        ...state.specification,
        status: "in_progress" as const,
        handoff_ref: null,
        ...(phase ? {
          phases: state.specification.phases.map((record) => record.phase === phase
            ? {
              ...record,
              status: "revision_required" as const,
              approved_version: null,
              checkpoint_ref: null,
              last_feedback: taskCheckpointDecision?.rationale ?? record.last_feedback,
            }
            : record),
        } : {}),
        next_action: {
          kind: phase ? "command" as const : "remediation" as const,
          command: phase
            ? phase === "specify"
              ? `/specify --feature ${state.specification.feature_id}`
              : phase === "plan"
                ? `/spec-plan --feature ${state.specification.feature_id}`
                : `/spec-tasks --feature ${state.specification.feature_id}`
            : null,
          reason: phase
            ? `The ${phase} revision is required; re-enter with the recorded feedback.`
            : `Checkpoint '${currentStage.checkpoint}' requested changes; re-enter the current stage before its checkpoint.`,
        },
      }
      : undefined;
    if (state.specification?.source_kind === "native" && phase) {
      // A native revision invalidates the previous generation authority. Do not
      // mint a bearer capability from the checkpoint transition: the phase
      // command must run PHASE-0 again and supply a fresh authenticated handoff
      // through the composite native start path.
      const { pending: _pending, preparation_start: _preparationStart, preparation_handoff: _preparationHandoff, dispatch_capability: _dispatchCapability, ...withoutAuthority } = state;
      return {
        ok: true,
        state: {
          ...withoutAuthority,
          ...(revisionWorkspace ? { specification: revisionWorkspace } : {}),
          stage_cursor: currentStage.id,
          cursor_epoch: randomUUID(),
          stages: state.stages.map((entry) => entry.id === currentStage.id ? { ...entry, status: "pending" as const } : entry),
          pause: { kind: "none", reason: "" },
          updated_at: now(),
        },
        transition: "revision_required",
      };
    }
    const resetState = state.specification?.source_kind === "native"
      ? state
      : resetReopenedStageState(state, target, pinnedRoot, profile, currentStage.id, cap, deferCleanup);
    const { pending: _pending, preparation_start: _preparationStart, preparation_handoff: _preparationHandoff, ...stateWithoutPending } = resetState;
    const issued = createCapability({
      run_key: cap.issued_for.run_key,
      branch: cap.issued_for.branch,
      workflow: cap.issued_for.workflow,
      profile_hash: cap.issued_for.profile_hash,
      stage_cursor: currentStage.id,
      kind: cap.kind,
      expected_roster: cap.expected_roster,
      ...(cap.roster_selection ? { roster_selection: cap.roster_selection } : {}),
      ...(rosterPolicyHash(currentStage) === undefined ? {} : { policy_hash: rosterPolicyHash(currentStage) }),
    });
    const revisedState: TeamState = {
      ...stateWithoutPending,
      ...(revisionWorkspace ? { specification: revisionWorkspace } : {}),
      stage_cursor: currentStage.id,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      stages: resetState.stages.map((entry) => entry.id === currentStage.id ? { ...entry, status: "in_progress" as const } : entry),
      dispatch_capability: issued.state,
      pause: { kind: "none", reason: "" },
      updated_at: now(),
    };
    return {
      ok: true,
      state: revisedState,
      handoff: handoffFromState(revisedState, {
        capability_id: issued.capability_id,
        dispatch_token: issued.dispatch_token,
        advance_token: issued.advance_token,
      }, currentStage),
      transition: "revision_required",
    };
  }
  let nativeTasksFinalization: NativeImplementationHandoffFinalizationResult | undefined;
  const finalizeNativeTasks = (): string | null => {
    if (state.specification?.source_kind !== "native" || currentStage.id !== "tasks" || (taskCheckpointEffect !== "stop" && taskCheckpointEffect !== "continue")) return null;
    const workspace = state.specification;
    const taskRecord = workspace.phases.find((record) => record.phase === "tasks");
    if (!taskRecord || taskRecord.current_version === null || taskRecord.status === "stale" || taskRecord.status === "revision_required") return "native tasks phase is not available for implementation handoff finalization";
    const approvedWorkspace: FeatureWorkspace = taskRecord.status === "approved"
      ? workspace
      : {
        ...workspace,
        status: "in_progress",
        phases: workspace.phases.map((record) => record.phase === "tasks"
          ? {
            ...record,
            status: "approved" as const,
            approved_version: record.current_version,
            checkpoint_ref: `checkpoint.tasks.v${record.current_version}`,
            last_feedback: null,
          }
          : record),
      };
    const finalizerConstitutionError = advanceConstitutionError(approvedWorkspace);
    if (finalizerConstitutionError) return finalizerConstitutionError;
    const finalized = finalizeNativeImplementationHandoffMutation(
      { ...state, specification: approvedWorkspace },
      target,
      pinnedRoot,
      input.run_key,
      registerRollback,
    );
    if (!finalized.ok) return finalized.error;
    state = finalized.state ?? state;
    const { state: _finalizedState, ...finalizationMetadata } = finalized;
    nativeTasksFinalization = finalizationMetadata;
    return null;
  };
  if (taskCheckpointEffect === "stop" || taskCheckpointEffect === "continue") {
    const finalizationError = finalizeNativeTasks();
    if (finalizationError) return { ok: false, error: finalizationError, state };
  }
  if (taskCheckpointEffect === "stop") {
    const legacyStop = state.specification?.source_kind === "legacy";
    const phaseOrder = ["specify", "plan", "tasks"];
    const currentPhaseIndex = phaseOrder.indexOf(currentStage.id);
    const nextLegacyPhase = legacyStop
      ? phaseOrder.slice(currentPhaseIndex + 1).find((phase): phase is "specify" | "plan" | "tasks" => state.specification?.phases.some((record) => record.phase === phase) === true) ?? null
      : null;
    const nextLegacyCommand = nextLegacyPhase === "plan"
      ? `/spec-plan --feature ${state.specification?.feature_id ?? input.feature_id}`
      : nextLegacyPhase === "tasks"
        ? `/spec-tasks --feature ${state.specification?.feature_id ?? input.feature_id}`
        : null;
    const nativeTasksFinalized = state.specification?.source_kind === "native" && currentStage.id === "tasks" && taskCheckpointEffect === "stop";
    const stoppedWorkspace = nativeTasksFinalized
      ? state.specification
      : state.specification
      ? {
        ...state.specification,
        handoff_ref: null,
        phases: state.specification.phases.map((record) => {
          if (record.phase === currentStage.id) {
            return {
              ...record,
              status: "approved" as const,
              approved_version: record.current_version,
              checkpoint_ref: record.current_version === null ? null : `checkpoint.${record.phase}.v${record.current_version}`,
              last_feedback: null,
            };
          }
          if (legacyStop && phaseOrder.indexOf(record.phase) > currentPhaseIndex) {
            return { ...record, status: "not_started" as const, current_version: null, approved_version: null, validation_ref: null, checkpoint_ref: null, upstream_versions: [], stale_reason: null, last_feedback: null };
          }
          return record;
        }),
        next_action: nextLegacyCommand
          ? { kind: "command" as const, command: nextLegacyCommand, reason: "approve_stop records the current migrated phase and routes to the first unapproved phase." }
          : { kind: "none" as const, command: null, reason: `Workflow stopped after checkpoint '${currentStage.checkpoint}'; no next stage or implementation worker was dispatched.` },
      }
      : undefined;
    const { pending: _pending, ...stateWithoutPending } = state;
    const { preparation_start: _preparationStart, preparation_handoff: _preparationHandoff, dispatch_capability: _dispatchCapability, ...stateWithoutPreparationAuthority } = stateWithoutPending;
    const stoppedStateBase = state.specification?.source_kind === "native" ? stateWithoutPreparationAuthority : stateWithoutPending;
    return {
      ok: true,
      state: {
        ...stoppedStateBase,
        ...(stoppedWorkspace ? { specification: stoppedWorkspace } : {}),
        stages: state.stages.map((stage) => stage.id === state.stage_cursor ? { ...stage, status: "done" as const } : stage),
        ...(state.specification?.source_kind === "native" ? {} : { dispatch_capability: cap ? { ...cap, status: "complete" as const, dispatches: [] } : cap }),
        pause: { kind: "done", reason: `Workflow stopped after checkpoint '${currentStage.checkpoint}'.` },
        updated_at: now(),
      },
      implementation_handoff: nativeTasksFinalization,
      transition: "stopped",
    };
  }
  if (taskCheckpointEffect === "continue" && nativeTasksFinalization) {
    const { preparation_start: _preparationStart, preparation_handoff: _preparationHandoff, ...continuedState } = state;
    return {
      ok: true,
      state: continuedState,
      implementation_handoff: nativeTasksFinalization,
      transition: "advance",
    };
  }

  // Bounded loop: evaluate `until`; re-enter `back_to` with a fresh
  // epoch/capability or map exhaustion to needs_human/failed.
  if (currentStage.loop) {
    const until = evaluatePredicate(currentStage.loop.until, {
      flags,
      artifactsDir: target.artifactsDir ?? "",
      state,
      stage: currentStage,
      pinnedRoot,
      artifactsDirRelative,
    });
    if (!until.ok) return { ok: false, error: `loop until evaluation failed: ${until.error}`, state };
    if (!until.value) {
      const loop = loopStateFor(state, currentStage.id);
      const decision = loopReentryDecision(loop, currentStage.loop.max_iterations);
      if (decision.exhausted) {
        const kind = loopExhaustionKind(currentStage.loop.on_exhausted);
        const exhausted: LoopState = {
          ...(loop ?? { reentries: 0, history: [], epoch: cap.issued_for.cursor_epoch }),
          stage_id: currentStage.id,
          back_to: currentStage.loop.back_to,
          until: currentStage.loop.until,
          max_iterations: currentStage.loop.max_iterations,
          on_exhausted: currentStage.loop.on_exhausted,
          status: "exhausted",
          outcome: kind,
          ended_at: now(),
        };
        const next: TeamState = {
          ...state,
          loop_state: exhausted,
          pause: { kind, reason: `loop '${currentStage.id}' exhausted after ${currentStage.loop.max_iterations} iteration(s)` },
          stages: state.stages.map((s) => (s.id === currentStage.id ? { ...s, status: "done" as const } : s)),
          join_summary: joinSummary,
          dispatch_capability: { ...cap, status: "complete" as const, dispatches: [] },
          updated_at: now(),
        };
        return { ok: true, state: next };
      }
      return reenterLoop(cwd, state, target, profile, cap, currentStage, records, joinSummary, decision.reentries, flags, effectiveConfig, trusted.trusted);
    }
    const existingLoop = loopStateFor(state, currentStage.id);
    if (existingLoop) {
      state = { ...state, loop_state: { ...existingLoop, status: "complete" as const, ended_at: now() } };
    }
  }

  const index = state.stages.findIndex((s) => s.id === state.stage_cursor);
  if (index < 0) return { ok: false, error: "current workflow stage unavailable", state };

  // Skip-aware advance (WF-3): evaluate every consecutive next stage's
  // `skip_if` with the same fail-closed predicate evaluator the interpreter
  // uses before arming a capability. A stage whose skip_if holds is marked
  // terminal `skipped` and is never armed or counted as an expected
  // dispatch; the first runnable stage is armed atomically under this
  // advance token. Malformed or unsupported skip expressions fail closed —
  // they block advance instead of silently skipping or silently running.
  const skippedStageIds: string[] = [];
  let nextStage: StageDef | undefined;
  for (let i = index + 1; i < state.stages.length; i += 1) {
    const entry = state.stages[i];
    const candidate = entry ? profile.stages.find((s) => s.id === entry.id) : undefined;
    if (!candidate) {
      if (entry) return { ok: false, error: "next workflow stage unavailable", state };
      continue;
    }
    const candidateStage = candidate;
    if (candidateStage.skip_if) {
      const skip = evaluatePredicate(candidateStage.skip_if, {
        flags,
        artifactsDir: target.artifactsDir ?? "",
        state,
        stage: candidateStage,
        pinnedRoot,
        artifactsDirRelative,
      });
      if (!skip.ok) {
        return { ok: false, error: `next stage '${candidateStage.id}' skip_if evaluation failed: ${skip.error}`, state };
      }
      if (skip.value) {
        skippedStageIds.push(candidateStage.id);
        continue;
      }
    }
    nextStage = candidateStage;
    break;
  }
  // T054 terminal guard: a specification-backed run completes only with a
  // current passing implementation conformance chain (frozen ready handoff,
  // active exclusive claim, pass-only closure matrix bound to this exact
  // workspace). Missing, stale, foreign, or failed evidence fails closed
  // before anything is committed; generic gates and human decisions cannot
  // bypass it. Preparation work and non-specification runs are unaffected.
  if (!nextStage && state.specification && state.specification.status !== "completed") {
    return { ok: false, error: "SPEC_IMPLEMENTATION_COMPLETION_REQUIRED: call workflow_complete_specification_execution before workflow_advance", state };
  }
  if (nextStage?.roster_policy && options?.trustedMappingProof === undefined) {
    return { ok: false, error: `workflow stage '${nextStage.id}' requires an engine-issued trusted agent mapping proof before advancement`, state };
  }
  if (!nextStage) {
    const conformanceBlock = specificationTerminalGuardError(state, target.artifactsDir);
    if (conformanceBlock) return { ok: false, error: conformanceBlock, state };
  }
  const epoch = randomUUID();
  let handoffSecrets: { capability_id: string; dispatch_token: string; advance_token: string } | undefined;
  // Automatic capability issuance during advance never freezes a roster for
  // a roster-policy stage: such a next stage stays semantically unselected
  // and pending until its explicit workflow_begin freezes a selection from
  // the trusted or persisted live registered mapping. Only a non-roster
  // stage — executable, or an orchestrator shell — is atomically armed here.
  let armedStage: StageDef | undefined;
  const { roster_selection: _completedSelection, ...completedCap } = cap;
  let nextCap: NonNullable<TeamState["dispatch_capability"]> = { ...completedCap, status: "complete" as const, dispatches: [] };
  if (nextStage) {
    const nextKind: "none" | "single" | "consilium" =
      nextStage.type === "single" || nextStage.type === "consilium" ? nextStage.type : "none";
    if (!nextStage.roster_policy) {
      let slots: ReturnType<typeof resolveStageDispatchSlots> = [];
      let expectedRoster: Array<{ role: string; agent: string; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }> = [];
      if (nextKind !== "none") {
        try {
          slots = resolveStageDispatchSlots(nextStage, { cwd, flags, resolveDevAgent: () => flags.dev_agent, state });
          for (const slot of slots) {
            const agent = trustedSlotAgent(slot.role, effectiveConfig, trusted.trusted);
            if (agent === null) {
              return {
                ok: false,
                error: `next stage '${nextStage.id}' dispatch roster unresolved: role '${slot.role}' is missing or unavailable in the trusted agent mapping handoff's resolved_roles`,
                state,
              };
            }
            expectedRoster.push({ role: slot.slot, agent });
          }
        } catch (error) {
          return { ok: false, error: `next stage '${nextStage.id}' dispatch roster unresolved: ${String(error)}`, state };
        }
        if ((nextKind === "single" && slots.length !== 1) || (nextKind === "consilium" && slots.length === 0)) {
          return { ok: false, error: `next stage '${nextStage.id}' has an invalid dispatch roster`, state };
        }
      }
      const issued = createCapability({
        run_key: cap.issued_for.run_key,
        branch: cap.issued_for.branch,
        workflow: cap.issued_for.workflow,
        profile_hash: cap.issued_for.profile_hash,
        stage_cursor: nextStage.id,
        cursor_epoch: epoch,
        kind: nextKind,
        expected_roster: expectedRoster,
      });
      nextCap = issued.state;
      armedStage = nextStage;
      handoffSecrets = { capability_id: issued.capability_id, dispatch_token: issued.dispatch_token, advance_token: issued.advance_token };
    }
  }
  // Deferral/completion masking: a frozen selection is data of the stage it
  // was frozen for. When the cursor leaves that stage the top-level mirror
  // is dropped (the per-stage `roster_selections` history retains it), so a
  // prior stage's selection can never leak into a later stage's contract.
  const priorSelection = state.roster_selection;
  const selectionStays = Boolean(priorSelection && nextStage && priorSelection.stage_id === nextStage.id);
  const nativePreparationTransition = Boolean(
    state.specification
      && (state.specification.source_kind === "native" || state.specification.source_kind === "legacy")
      && ["specify", "plan", "tasks"].includes(state.stage_cursor),
  );
  const { roster_selection: _carriedSelection, ...stateWithoutSelection } = state;
  const { preparation_start: _preparationStart, preparation_handoff: _preparationHandoff, ...stateWithoutPreparationAuthority } = stateWithoutSelection;
  const carriedState = nativePreparationTransition ? stateWithoutPreparationAuthority : stateWithoutSelection;
  const nextNativeCommand = nextStage?.id === "plan"
    ? `/spec-plan --feature ${carriedState.specification?.feature_id ?? input.feature_id}`
    : nextStage?.id === "tasks"
      ? `/spec-tasks --feature ${carriedState.specification?.feature_id ?? input.feature_id}`
      : nextStage?.id === "specify"
        ? `/specify --feature ${carriedState.specification?.feature_id ?? input.feature_id}`
        : null;
  const next: TeamState = {
    ...carriedState,
    ...(nativePreparationTransition && nextNativeCommand && carriedState.specification ? {
      specification: {
        ...carriedState.specification,
        status: "in_progress" as const,
        handoff_ref: null,
        next_action: {
          kind: "command" as const,
          command: nextNativeCommand,
          reason: "The previous native phase advanced; prepare the next phase before starting its worker.",
        },
      },
    } : {}),
    stage_cursor: nextStage?.id ?? state.stage_cursor,
    cursor_epoch: epoch,
    // Only an atomically armed non-roster capability coexists with an
    // in_progress stage cursor. A deferred roster-policy next stage stays
    // pending — nothing can dispatch against it until workflow_begin arms
    // the selected capability. Consecutive skip_if stages are marked
    // terminal `skipped` in the same update; they are never armed.
    stages: state.stages.map((s) => {
      if (s.id === state.stage_cursor) return { ...s, status: "done" as const };
      if (skippedStageIds.includes(s.id)) return { ...s, status: "skipped" as const };
      if (armedStage && s.id === armedStage.id) return { ...s, status: "in_progress" as const };
      return s;
    }),
    join_summary: joinSummary,
    ...(selectionStays && priorSelection ? { roster_selection: priorSelection } : {}),
    ...(armedStage || !nativePreparationTransition ? { dispatch_capability: nextCap } : { dispatch_capability: undefined }),
    pause: nextStage ? { kind: "none", reason: "" } : { kind: "done", reason: "" },
  };
  return { ok: true, state: next, handoff: armedStage && handoffSecrets ? handoffFromState(next, handoffSecrets, armedStage) : undefined };
}

/**
 * Loop re-entry: point the cursor back at the loop's `back_to` stage and
 * rotate to a fresh cursor epoch. Old epochs can never authorize a
 * re-entered iteration — the durable binding rotates with every loop-back.
 * Iteration history is appended durably. An executable non-roster target is
 * armed immediately; a roster-policy target stays semantically unselected
 * and pending until its explicit workflow_begin freezes the iteration's
 * roster from the trusted or persisted live mapping.
 */
function reenterLoop(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  profile: NonNullable<ReturnType<typeof loadProfile>>,
  cap: ActiveCapability,
  currentStage: StageDef,
  records: DispatchRecord[],
  joinSummary: TeamState["join_summary"],
  reentries: number,
  flags: ScopeFlags,
  config: ResolvedConfig,
  trusted: boolean,
): TransitionResult {
  const loop = currentStage.loop!;
  const backToStage = resolveBackToStage(profile, loop.back_to);
  if (!backToStage) return { ok: false, error: `loop back_to '${loop.back_to}' is not a stage in the profile`, state };
  const kind: "none" | "single" | "consilium" =
    backToStage.type === "single" || backToStage.type === "consilium" ? backToStage.type : "none";
  const epoch = randomUUID();
  // Same invariant as the linear advance path: a roster-policy loop target
  // is never roster-resolved here. Re-entry rotates the cursor epoch,
  // records the iteration history, and parks the stage pending until its
  // explicit workflow_begin freezes the iteration's selection.
  const deferredRoster = kind !== "none" && !!backToStage.roster_policy;
  let rosterSelection: TeamState["roster_selection"];
  let slots: ReturnType<typeof resolveStageDispatchSlots> = [];
  let expectedRoster: Array<{ role: string; agent: string; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }> = [];
  if (!deferredRoster && kind !== "none") {
    try {
      slots = resolveStageDispatchSlots(backToStage, { cwd, flags, resolveDevAgent: () => flags.dev_agent, state });
      for (const slot of slots) {
        const agent = trustedSlotAgent(slot.role, config, trusted);
        if (agent === null) {
          return {
            ok: false,
            error: `loop target stage '${backToStage.id}' dispatch roster unresolved: role '${slot.role}' is missing or unavailable in the trusted agent mapping handoff's resolved_roles`,
            state,
          };
        }
        expectedRoster.push({ role: slot.slot, agent });
      }
    } catch (error) {
      return { ok: false, error: `loop target stage '${backToStage.id}' dispatch roster unresolved: ${String(error)}`, state };
    }
  }
  if (!deferredRoster && ((kind === "single" && slots.length !== 1) || (kind === "consilium" && slots.length === 0))) {
    return { ok: false, error: `loop target stage '${backToStage.id}' has an invalid dispatch roster`, state };
  }
  const issued = deferredRoster
    ? undefined
    : createCapability({
        run_key: cap.issued_for.run_key,
        branch: cap.issued_for.branch,
        workflow: cap.issued_for.workflow,
        profile_hash: cap.issued_for.profile_hash,
        stage_cursor: backToStage.id,
        cursor_epoch: epoch,
        kind,
        expected_roster: expectedRoster,
        roster_selection: rosterSelection,
        ...(rosterPolicyHash(backToStage) === undefined ? {} : { policy_hash: rosterPolicyHash(backToStage) }),
      });
  const iteration = reentries + 1;
  const loopState: LoopState = {
    stage_id: currentStage.id,
    back_to: loop.back_to,
    until: loop.until,
    max_iterations: loop.max_iterations,
    on_exhausted: loop.on_exhausted,
    reentries: iteration,
    epoch,
    status: "running",
    history: [
      ...(loopStateFor(state, currentStage.id)?.history ?? []),
      loopIterationRecord(iteration, cap.issued_for.cursor_epoch, epoch, false),
    ],
  };
  // Masking mirrors the linear advance: the completed iteration's frozen
  // selection belongs to the stage it was frozen for and is dropped from
  // both the state mirror and the completed capability. The per-stage
  // `roster_selections` history retains it for audit.
  const priorLoopSelection = state.roster_selection?.stage_id === backToStage.id ? state.roster_selection : undefined;
  const { roster_selection: _carriedLoopSelection, ...carriedLoopState } = state;
  const { roster_selection: _completedLoopSelection, ...completedLoopCap } = cap;
  const next: TeamState = {
    ...carriedLoopState,
    stage_cursor: backToStage.id,
    cursor_epoch: epoch,
    loop_state: loopState,
    stages: state.stages.map((s) =>
      s.id === currentStage.id
        ? { ...s, status: "done" as const }
        : s.id === backToStage.id
          ? deferredRoster
            ? { ...s, status: "pending" as const }
            : { ...s, status: "in_progress" as const }
          : s,
    ),
    join_summary: joinSummary,
    ...(priorLoopSelection ? { roster_selection: priorLoopSelection } : {}),
    dispatch_capability: issued
      ? { ...issued.state, status: "ready" as const, dispatches: [] }
      : { ...completedLoopCap, status: "complete" as const, dispatches: [] },
    updated_at: now(),
  };
  return issued
    ? {
        ok: true,
        state: next,
        handoff: handoffFromState(next, {
          capability_id: issued.capability_id,
          dispatch_token: issued.dispatch_token,
          advance_token: issued.advance_token,
        }, backToStage),
      }
    : { ok: true, state: next };
}
export interface ImportedHandoffFinalizationInput {
  feature_id: string;
  advance_token: string;
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  evidence: string;
}

export type ImportedHandoffFinalizationResult =
  | {
      ok: true;
      transition: "finalize_import_handoff";
      handoff_ref: string;
      handoff_digest: string;
      artifact_path: string;
      document_path: string;
      projection_content_sha256: string;
      status: "implementation_ready";
      next_action: string;
      replayed: boolean;
    }
  | {
      ok: false;
      code: string;
      error: string;
    };

type ImportedHandoffFinalizationMutationResult = ImportedHandoffFinalizationResult & { state?: TeamState };

const MAX_FINALIZER_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const FINALIZER_APPROVAL_STAGE = "compatibility_approval";
const FINALIZER_APPROVAL_CHECKPOINT = "import_compatibility_approval";
const FINALIZER_HANDOFF_STAGE = "handoff";

function finalizerFailure(
  code: string,
  error: string,
  _state?: TeamState,
): ImportedHandoffFinalizationResult {
  return { ok: false, code, error };
}

function finalizerStateFingerprint(state: TeamState): string {
  const value = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  delete value.updated_at;
  delete value.state_revision;
  return canonicalJson(value);
}

function finalizerArtifactPath(
  pinnedRoot: PinnedProjectRoot,
  target: ResolvedState,
  handoffId: string,
): string | null {
  const artifactsDir = artifactsRelativeFor(pinnedRoot, target);
  if (
    artifactsDir === null
    || !isSafeStateSegment(handoffId)
    || handoffId.includes("/")
  ) return null;
  return `${artifactsDir}/implementation_handoff/${handoffId}.json`;
}

function finalizerReadFlatArtifact(
  pinnedRoot: PinnedProjectRoot,
  target: ResolvedState,
  id: string,
): unknown | null {
  const artifactsDir = artifactsRelativeFor(pinnedRoot, target);
  return artifactsDir === null ? null : readArtifactPinned(pinnedRoot, artifactsDir, id);
}

function finalizerSourceBytesMatch(
  snapshot: ImportSnapshot,
  sourceRoot: PinnedProjectRoot,
): boolean {
  if (
    !sourceRoot.isStable()
    || sourceRoot.canonical_root !== snapshot.source_root
    || sourceRoot.dev !== snapshot.source_root_identity.dev
    || sourceRoot.ino !== snapshot.source_root_identity.ino
  ) return false;
  const limitsValidation = snapshot.limits === undefined ? { ok: true as const } : validateImportLimits(snapshot.limits);
  if (!limitsValidation.ok) return false;
  const limits = snapshot.limits ?? DEFAULT_IMPORT_LIMITS;
  if (!Array.isArray(snapshot.files) || snapshot.files.length > limits.maxFiles) return false;
  let aggregateBytes = 0;
  let textBytes = 0;
  for (const file of snapshot.files) {
    const mediaType = typeof file.media_type === "string" ? file.media_type.toLowerCase() : "";
    const textMedia = mediaType.startsWith("text/") || ["application/json", "application/yaml", "application/toml", "application/xml", "application/javascript", "application/typescript"].includes(mediaType);
    const mediaLimit = textMedia ? limits.maxTextBytes : limits.maxBinaryBytes;
    if (!Number.isSafeInteger(file.size_bytes) || file.size_bytes < 1 || file.size_bytes > limits.maxFileBytes
      || (!textMedia && file.size_bytes > mediaLimit)
      || file.size_bytes > limits.maxBytes - aggregateBytes
      || (textMedia && file.size_bytes > limits.maxTextBytes - textBytes)) return false;
    aggregateBytes += file.size_bytes;
    if (textMedia) textBytes += file.size_bytes;
    try {
      const read = sourceRoot.readFile(file.path, { maxBytes: Math.min(MAX_FINALIZER_SOURCE_FILE_BYTES, limits.maxFileBytes, textMedia ? limits.maxTextBytes - textBytes + file.size_bytes : mediaLimit) });
      const bytes = Buffer.from(read.bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== file.size_bytes || digest !== file.sha256) return false;
    } catch {
      return false;
    }
  }
  return sourceRoot.isStable();
}

function finalizerApproval(
  state: TeamState,
  profile: Profile,
): { ok: true; decision: TypedCheckpointDecision; reference: string } | { ok: false; error: string } {
  const stage = profile.stages.find((candidate) => candidate.id === FINALIZER_APPROVAL_STAGE);
  if (!stage || stage.checkpoint !== FINALIZER_APPROVAL_CHECKPOINT) {
    return { ok: false, error: "spec-import profile does not declare the imported compatibility approval stage" };
  }
  const selected = selectLatestValidCheckpointDecision(stage, state, { bindCapability: false });
  if (!selected.ok) return { ok: false, error: `trusted imported compatibility approval is invalid: ${selected.error}` };
  const decision = selected.decision;
  if (
    decision.authorization !== "human"
    || (checkpointDecisionEffect(decision) !== "continue" && checkpointDecisionEffect(decision) !== "stop")
    || !decision.actor.proof
    || decision.feature_id !== state.specification?.feature_id
    || decision.run_id !== (state.work_identity?.run_id ?? state.run_key ?? state.branch)
    || !decision.subject_binding
    || decision.loop_iteration === undefined
  ) return { ok: false, error: "trusted imported compatibility approval is not an approved typed human decision bound to this import subject" };
  return {
    ok: true,
    decision,
    reference: decision.actor.proof.reference,
  };
}

type ImportedHandoffFinalizerPrepared = {
  state: TeamState;
  target: ResolvedState;
  pinnedRoot: PinnedProjectRoot;
  sourceRoot: PinnedProjectRoot;
  snapshot: ImportSnapshot;
  report: CompatibilityReport;
  supplement: CompatibilitySupplement | null;
  bundle: SecureSnapshotBundle;
  handoff: ImplementationHandoff;
  approval: TypedCheckpointDecision;
  approved_subject_binding: string;
  approved_loop_iteration: number;
  approved_import_identity: SelectedImportIdentity;
  state_fingerprint: string;
};

function finalizerImportSubject(
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  sourceRoot: PinnedProjectRoot,
  profile: Profile,
  approval: TypedCheckpointDecision,
): { ok: true; subject: SelectedSubjectResult } | { ok: false; error: string } {
  const stage = profile.stages.find((candidate) => candidate.id === FINALIZER_APPROVAL_STAGE);
  if (!stage || stage.checkpoint !== FINALIZER_APPROVAL_CHECKPOINT) {
    return { ok: false, error: "spec-import profile does not declare the imported compatibility approval stage" };
  }
  const policy = resolveCheckpointPolicy(stage, state);
  const rule = policy?.rules[FINALIZER_APPROVAL_CHECKPOINT];
  if (!policy || !rule) return { ok: false, error: "imported compatibility approval policy is unavailable" };
  const subjectResult = selectedSubjectForCheckpoint(
    pinnedRoot,
    state,
    target,
    {
      feature_id: state.specification?.feature_id ?? "",
      advance_token: "finalizer-subject-revalidation",
      capability_id: approval.capability_id,
      run_key: state.run_key ?? approval.run_id,
      branch: state.branch,
      workflow: state.classification.workflow,
      profile_hash: profileHash(profile),
      stage_cursor: FINALIZER_APPROVAL_STAGE,
      cursor_epoch: approval.capability_epoch,
      checkpoint: FINALIZER_APPROVAL_CHECKPOINT,
      checkpoint_id: FINALIZER_APPROVAL_CHECKPOINT,
      checkpoint_kind: rule.kind,
      loop_iteration: approval.loop_iteration,
    },
    stage,
    profile,
    policy,
    rule,
    rule.allowed_decisions,
    sourceRoot,
  );
  if (subjectResult.error || !subjectResult.subject) {
    return { ok: false, error: subjectResult.error ?? "imported compatibility subject could not be revalidated" };
  }
  return { ok: true, subject: subjectResult.subject };
}

async function prepareImportedHandoffFinalizer(
  cwd: string,
  input: ImportedHandoffFinalizationInput,
  pinnedRoot: PinnedProjectRoot,
): Promise<
  | { ok: true; prepared: ImportedHandoffFinalizerPrepared }
  | { ok: false; result: ImportedHandoffFinalizationResult }
> {
  if (
    !isSafeFeatureId(input.feature_id)
    || !selectedBoundedString(input.advance_token, MAX_ADVANCE_FIELD_BYTES)
    || !selectedBoundedString(input.capability_id, MAX_ADVANCE_FIELD_BYTES)
    || !selectedBoundedString(input.run_key, MAX_ADVANCE_FIELD_BYTES)
    || !selectedBoundedString(input.branch, MAX_ADVANCE_FIELD_BYTES)
    || input.workflow !== "spec-import"
    || !selectedBoundedString(input.workflow, MAX_ADVANCE_FIELD_BYTES)
    || !selectedBoundedString(input.profile_hash, MAX_ADVANCE_FIELD_BYTES)
    || input.stage_cursor !== FINALIZER_HANDOFF_STAGE
    || !selectedBoundedString(input.stage_cursor, MAX_ADVANCE_FIELD_BYTES)
    || !selectedBoundedString(input.cursor_epoch, MAX_ADVANCE_FIELD_BYTES)
    || !selectedBoundedString(input.evidence, MAX_ADVANCE_EVIDENCE_BYTES)
  ) return { ok: false, result: finalizerFailure("SPEC_IMPORT_HANDOFF_REJECTED", "finalizer authorization fields must be exact bounded line-inert values") };
  if (!pinnedRoot.isStable()) return { ok: false, result: finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "project root changed before imported handoff finalization") };
  const target = resolveStatePinned(cwd, pinnedRoot, { feature_id: input.feature_id, run_key: input.run_key });
  if (target.invalid || !target.state) return { ok: false, result: finalizerFailure("SPEC_STATE_INVALID", "selected imported workflow state is missing or invalid") };
  const state = target.state;
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, result: finalizerFailure("SPEC_STATE_INVALID", "handoff capability is unavailable", state) };
  const authError = auth(cap, {
    token: input.advance_token,
    capability_id: input.capability_id,
    run_key: input.run_key,
    branch: input.branch,
    workflow: input.workflow as TeamState["classification"]["workflow"],
    profile_hash: input.profile_hash,
    stage_cursor: input.stage_cursor,
    cursor_epoch: input.cursor_epoch,
  }, cap.advance_token_hash);
  if (authError) return { ok: false, result: finalizerFailure("SPEC_STATE_INVALID", authError, state) };
  if (cap.issued_for.stage_cursor !== FINALIZER_HANDOFF_STAGE || (cap.status !== "ready" && cap.status !== "complete")) {
    return { ok: false, result: finalizerFailure("SPEC_STATE_INVALID", "import handoff capability is not active at the handoff stage", state) };
  }
  if (state.stage_cursor !== FINALIZER_HANDOFF_STAGE || state.run_key !== input.run_key || state.branch !== input.branch || state.classification.workflow !== "spec-import") {
    return { ok: false, result: finalizerFailure("SPEC_STATE_INVALID", "workflow state and handoff capability binding mismatch", state) };
  }
  const profile = loadProfile("spec-import");
  if (!profile || profileHash(profile) !== cap.issued_for.profile_hash) {
    return { ok: false, result: finalizerFailure("SPEC_STATE_INVALID", "spec-import profile is unavailable or stale", state) };
  }
  const workspace = state.specification;
  if (
    !workspace
    || workspace.source_kind !== "external"
    || workspace.feature_id !== input.feature_id
    || workspace.project_root !== pinnedRoot.canonical_root
    || workspace.project_root_identity.canonical_path !== pinnedRoot.canonical_root
    || workspace.project_root_identity.dev !== pinnedRoot.dev
    || workspace.project_root_identity.ino !== pinnedRoot.ino
    || !workspace.import_ref
    || !workspace.constitution_binding
  ) return { ok: false, result: finalizerFailure("SPEC_IMPORT_HANDOFF_REJECTED", "external workspace identity or constitution binding is incomplete", state) };
  const handoffStage = state.stages.find((entry) => entry.id === FINALIZER_HANDOFF_STAGE);
  if (!handoffStage || (handoffStage.status !== "in_progress" && handoffStage.status !== "done")) {
    return { ok: false, result: finalizerFailure("SPEC_STATE_INVALID", "import handoff stage is not ready for finalization", state) };
  }
  const artifactsDir = artifactsRelativeFor(pinnedRoot, target);
  if (artifactsDir === null) return { ok: false, result: finalizerFailure("SPEC_PATH_UNAUTHORIZED", "selected feature artifact directory is unavailable", state) };
  const rawSnapshot = finalizerReadFlatArtifact(pinnedRoot, target, "import_snapshot");
  const rawReport = finalizerReadFlatArtifact(pinnedRoot, target, "compatibility_report");
  const snapshotValidation = validateImportSnapshot(rawSnapshot);
  if (!snapshotValidation.ok) return { ok: false, result: finalizerFailure("SPEC_IMPORT_SNAPSHOT_INVALID", `canonical import snapshot is invalid: ${snapshotValidation.issues.join("; ")}`, state) };
  const reportValidation = validateCompatibilityReport(rawReport);
  if (!reportValidation.ok) return { ok: false, result: finalizerFailure("SPEC_IMPORT_COMPATIBILITY_INVALID", `canonical compatibility report is invalid: ${reportValidation.issues.join("; ")}`, state) };
  const snapshot = rawSnapshot as ImportSnapshot;
  const report = rawReport as CompatibilityReport;
  if (
    snapshot.snapshot_id !== workspace.import_ref
    || report.snapshot_ref !== snapshot.snapshot_id
    || report.status !== "ready"
    || canonicalJson(report.constitution_binding) !== canonicalJson(workspace.constitution_binding)
  ) return { ok: false, result: finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "canonical import snapshot/report is stale for the selected workspace", state) };
  const snapshotContract = validateProducedArtifact("import_snapshot", snapshot, currentArtifactContractPolicy());
  if (!snapshotContract.ok) return { ok: false, result: finalizerFailure("SPEC_IMPORT_SNAPSHOT_INVALID", "canonical import snapshot violates its artifact contract", state) };
  const reportContract = validateProducedArtifact("compatibility_report", report, currentArtifactContractPolicy());
  if (!reportContract.ok) return { ok: false, result: finalizerFailure("SPEC_IMPORT_COMPATIBILITY_INVALID", "canonical compatibility report violates its artifact contract", state) };
  let supplement: CompatibilitySupplement | null = null;
  if (report.supplement_ref !== null) {
    const rawSupplement = finalizerReadFlatArtifact(pinnedRoot, target, "compatibility_supplement");
    const supplementValidation = validateCompatibilitySupplement(rawSupplement);
    if (!supplementValidation.ok) return { ok: false, result: finalizerFailure("SPEC_IMPORT_SUPPLEMENT_CHANGED", `canonical compatibility supplement is invalid: ${supplementValidation.issues.join("; ")}`, state) };
    const supplementContract = validateProducedArtifact("compatibility_supplement", rawSupplement, currentArtifactContractPolicy());
    if (!supplementContract.ok) return { ok: false, result: finalizerFailure("SPEC_IMPORT_SUPPLEMENT_CHANGED", "canonical compatibility supplement violates its artifact contract", state) };
    supplement = rawSupplement as CompatibilitySupplement;
    if (supplement.supplement_id !== report.supplement_ref
      || supplement.supplement_id !== compatibilitySupplementId(supplement)
      || supplement.content_sha256 !== compatibilitySupplementContentHash(supplement)
      || supplement.snapshot_ref !== snapshot.snapshot_id
      || supplement.snapshot_id !== snapshot.snapshot_id
      || supplement.feature_id !== workspace.feature_id
      || supplement.framework !== report.framework
      || supplement.mapping_id !== report.mapping_id
      || supplement.mapping_version !== report.mapping_version) {
      return { ok: false, result: finalizerFailure("SPEC_IMPORT_SUPPLEMENT_CHANGED", "canonical compatibility supplement is bound to a different provider, report, or snapshot", state) };
    }
  }
  const approval = finalizerApproval(state, profile);
  if (!approval.ok) return { ok: false, result: finalizerFailure("SPEC_IMPORT_APPROVAL_REQUIRED", approval.error, state) };
  const sourceRoot = PinnedProjectRoot.open(snapshot.source_root);
  if (!sourceRoot) return { ok: false, result: finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "approved external source root could not be pinned", state) };
  let transferred = false;
  try {
    const approvedSubject = finalizerImportSubject(state, target, pinnedRoot, sourceRoot, profile, approval.decision);
    if (!approvedSubject.ok || !approvedSubject.subject.import_identity) {
      return { ok: false, result: finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", approvedSubject.ok ? "approved import subject is missing its import identity" : approvedSubject.error, state) };
    }
    if (
      approvedSubject.subject.binding !== approval.decision.subject_binding
      || approvedSubject.subject.loop_iteration !== approval.decision.loop_iteration
    ) {
      return { ok: false, result: finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "current import subject does not match the trusted compatibility approval", state) };
    }
    const approvedImportIdentity = approvedSubject.subject.import_identity;
    if (!finalizerSourceBytesMatch(snapshot, sourceRoot)) {
      return { ok: false, result: finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "approved external source root identity or bytes changed", state) };
    }
    const persistedRecognition = {
      framework: snapshot.framework,
      confidence: "high" as const,
      selected_paths: [...snapshot.selected_paths],
      ignored_candidates: [...snapshot.ignored_candidates],
      mapping_id: snapshot.mapping_id,
      mapping_version: snapshot.mapping_version,
    };
    const bundle = bindImportRecognition(await recreateImportedSnapshot({
      snapshot,
      feature: input.feature_id,
      run: input.run_key,
    }, sourceRoot), persistedRecognition);
    if (canonicalJson(bundle.importSnapshot) !== canonicalJson(snapshot)) {
      return { ok: false, result: finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "current external source does not reproduce the approved import snapshot", state) };
    }
    const rehash = await rehashImportedSpecification({
      bundle,
      report,
      constitution_binding: workspace.constitution_binding,
      supplement,
    }, sourceRoot);
    if (!rehash.ok) {
      return { ok: false, result: finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", rehash.findings.map((finding) => finding.message).join("; ") || "approved import source became stale", state) };
    }
    const currentReport = buildCompatibilityReport({
      bundle: rehash.bundle,
      constitution_binding: workspace.constitution_binding,
      recognition: rehash.bundle.recognition,
      framework: report.framework,
      supplement,
      evaluated_at: report.evaluated_at,
    }).report;
    if (canonicalJson(currentReport) !== canonicalJson(report)) {
      return { ok: false, result: finalizerFailure("SPEC_IMPORT_COMPATIBILITY_INVALID", "current source no longer reproduces the approved compatibility report", state) };
    }
    const handoff = createImportedHandoff({
      bundle: rehash.bundle,
      report,
      constitution_binding: workspace.constitution_binding,
      approval_refs: [approval.reference],
      supplement,
      language: workspace.language.language,
      handoff_id: `${input.feature_id}.handoff.v1`,
    }).handoff;
    const handoffValidation = validateImplementationHandoff(handoff);
    if (!handoffValidation.ok || canonicalHandoffDigest(handoff) !== handoff.handoff_digest) {
      return { ok: false, result: finalizerFailure("SPEC_HANDOFF_INVALID", "engine-derived imported handoff failed strict schema or digest validation", state) };
    }
    const handoffContract = validateProducedArtifact("implementation_handoff", handoff, currentArtifactContractPolicy());
    if (!handoffContract.ok) return { ok: false, result: finalizerFailure("SPEC_HANDOFF_INVALID", "engine-derived imported handoff violates its artifact contract", state) };
    transferred = true;
    return {
      ok: true,
      prepared: {
        state,
        target,
        pinnedRoot,
        sourceRoot,
        snapshot,
        report,
        supplement,
        bundle: rehash.bundle,
        handoff,
        approval: approval.decision,
        approved_subject_binding: approval.decision.subject_binding!,
        approved_loop_iteration: approval.decision.loop_iteration!,
        approved_import_identity: approvedImportIdentity,
        state_fingerprint: finalizerStateFingerprint(state),
      },
    };
  } catch (error) {
    return { ok: false, result: finalizerFailure("SPEC_IMPORT_HANDOFF_REJECTED", `imported handoff derivation failed safely: ${error instanceof Error ? error.message : String(error)}`, state) };
  } finally {
    if (!transferred) sourceRoot.close();
  }
}

function finalizeImportedHandoffMutation(
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  sourceRoot: PinnedProjectRoot,
  prepared: ImportedHandoffFinalizerPrepared,
  input: ImportedHandoffFinalizationInput,
  registerRollback?: (cleanup: () => void) => void,
): ImportedHandoffFinalizationMutationResult {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return finalizerFailure("SPEC_STATE_INVALID", "handoff capability disappeared during finalization", state);
  const authError = auth(cap, {
    token: input.advance_token,
    capability_id: input.capability_id,
    run_key: input.run_key,
    branch: input.branch,
    workflow: input.workflow as TeamState["classification"]["workflow"],
    profile_hash: input.profile_hash,
    stage_cursor: input.stage_cursor,
    cursor_epoch: input.cursor_epoch,
  }, cap.advance_token_hash);
  if (authError) return finalizerFailure("SPEC_STATE_INVALID", authError, state);
  if (state.stage_cursor !== FINALIZER_HANDOFF_STAGE || cap.issued_for.stage_cursor !== FINALIZER_HANDOFF_STAGE) {
    return finalizerFailure("SPEC_STATE_INVALID", "handoff stage or capability moved before finalization", state);
  }
  const profile = loadProfile("spec-import");
  if (!profile || profileHash(profile) !== cap.issued_for.profile_hash) {
    return finalizerFailure("SPEC_STATE_INVALID", "spec-import profile is unavailable or stale during finalization", state);
  }
  const currentSubject = finalizerImportSubject(state, target, pinnedRoot, sourceRoot, profile, prepared.approval);
  if (!currentSubject.ok || !currentSubject.subject.import_identity) {
    return finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", currentSubject.ok ? "current import subject is missing its import identity" : currentSubject.error, state);
  }
  if (
    currentSubject.subject.binding !== prepared.approved_subject_binding
    || currentSubject.subject.loop_iteration !== prepared.approved_loop_iteration
    || canonicalJson(currentSubject.subject.import_identity) !== canonicalJson(prepared.approved_import_identity)
  ) {
    return finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "current import subject no longer matches the trusted compatibility approval", state);
  }
  if (finalizerStateFingerprint(state) !== prepared.state_fingerprint) {
    return finalizerFailure("SPEC_STATE_INVALID", "workflow state changed during imported handoff derivation; retry with the current handoff capability", state);
  }
  const currentSnapshot = finalizerReadFlatArtifact(pinnedRoot, target, "import_snapshot");
  const currentReport = finalizerReadFlatArtifact(pinnedRoot, target, "compatibility_report");
  if (canonicalJson(currentSnapshot) !== canonicalJson(prepared.snapshot) || canonicalJson(currentReport) !== canonicalJson(prepared.report)) {
    return finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "canonical import artifacts changed during imported handoff finalization", state);
  }
  if (prepared.supplement !== null && canonicalJson(finalizerReadFlatArtifact(pinnedRoot, target, "compatibility_supplement")) !== canonicalJson(prepared.supplement)) {
    return finalizerFailure("SPEC_IMPORT_SUPPLEMENT_CHANGED", "canonical compatibility supplement changed during imported handoff finalization", state);
  }
  if (!finalizerSourceBytesMatch(prepared.snapshot, sourceRoot)) {
    return finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "approved external source bytes changed during imported handoff finalization", state);
  }
  const workspace = state.specification;
  if (
    !workspace
    || workspace.feature_id !== input.feature_id
    || workspace.import_ref !== prepared.snapshot.snapshot_id
    || (workspace.handoff_ref !== null && workspace.handoff_ref !== prepared.handoff.handoff_id)
  ) {
    return finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "workspace import or handoff binding changed during imported handoff finalization", state);
  }
  const artifactPath = finalizerArtifactPath(pinnedRoot, target, prepared.handoff.handoff_id);
  if (artifactPath === null) return finalizerFailure("SPEC_PATH_UNAUTHORIZED", "canonical imported handoff path is unavailable", state);
  const serializedHandoff = serializeCanonicalHandoff(prepared.handoff);
  if (!serializedHandoff.ok) return finalizerFailure("SPEC_HANDOFF_INVALID", serializedHandoff.error, state);
  const attemptRollback = createDurableAttemptRollback(pinnedRoot, [artifactPath, `specs/${input.feature_id}/handoff.md`], registerRollback);
  try {
    let replayed = false;
    let existing: ImplementationHandoff | null = null;
    const existingEntry = pinnedRoot.pathEntryInfo(artifactPath);
    if (existingEntry !== null) {
      const loaded = readCanonicalHandoff(pinnedRoot, artifactPath, "existing canonical imported handoff");
      if (!loaded.ok) return finalizerFailure("SPEC_HANDOFF_CONFLICT", loaded.error, state);
      existing = loaded.handoff;
    }
    if (existing !== null) {
      if (existing.handoff_id !== prepared.handoff.handoff_id || canonicalJson(existing) !== canonicalJson(prepared.handoff)) {
        return finalizerFailure("SPEC_HANDOFF_CONFLICT", "an incompatible canonical imported handoff artifact already exists", state);
      }
      replayed = true;
    } else {
      try {
        injectHandoffFinalizerWriteHook(pinnedRoot, prepared.handoff.handoff_id);
        const beforeCanonicalWriteError = workspaceConstitutionError(pinnedRoot, workspace);
        if (beforeCanonicalWriteError) throw new Error(beforeCanonicalWriteError);
        pinnedRoot.writeExclusiveWithReceipt(artifactPath, serializedHandoff.bytes, { beforePublish: (published) => attemptRollback?.record(artifactPath, published) });
      } catch (error) {
        if (!(error instanceof PinnedRootError && error.code === "exists")) throw error;
        const loaded = readCanonicalHandoff(pinnedRoot, artifactPath, "concurrent canonical imported handoff");
        if (!loaded.ok) return finalizerFailure("SPEC_HANDOFF_CONFLICT", loaded.error, state);
        existing = loaded.handoff;
        if (canonicalJson(existing) !== canonicalJson(prepared.handoff)) {
          return finalizerFailure("SPEC_HANDOFF_CONFLICT", "concurrent canonical imported handoff conflicts with the derived handoff", state);
        }
        replayed = true;
      }
    }
    const readback = readCanonicalHandoff(pinnedRoot, artifactPath, "canonical imported handoff readback");
    if (!readback.ok || canonicalJson(readback.handoff) !== canonicalJson(prepared.handoff)) {
      return finalizerFailure("SPEC_HANDOFF_INVALID", readback.ok ? "canonical imported handoff readback failed strict schema or digest validation" : readback.error, state);
    }
    const rendered = materializeImplementationHandoffPinned(pinnedRoot, prepared.handoff, {
      beforeWrite: () => {
        const constitutionError = workspaceConstitutionError(pinnedRoot, workspace);
        if (constitutionError) throw new Error(constitutionError);
      },
      beforePublish: (receipt) => { attemptRollback?.record(`specs/${input.feature_id}/handoff.md`, receipt); },
    });
    if (!rendered.ok) return finalizerFailure("SPEC_HANDOFF_RENDER_FAILED", rendered.error, state);
    const nextWorkspace: FeatureWorkspace = {
      ...workspace,
      status: "implementation_ready",
      handoff_ref: prepared.handoff.handoff_id,
      next_action: {
        kind: "command",
        command: `/do-work --spec ${input.feature_id}`,
        reason: "Imported compatibility approval finalized the engine-owned implementation handoff.",
      },
    };
    const workspaceValidation = validateFeatureWorkspaceRecord(nextWorkspace);
    if (!workspaceValidation.ok) return finalizerFailure("SPEC_STATE_INVALID", `implementation-ready workspace is invalid: ${workspaceValidation.issues.join("; ")}`, state);
    const next: TeamState = {
      ...state,
      stages: state.stages.map((entry) => entry.id === FINALIZER_HANDOFF_STAGE ? { ...entry, status: "done" as const } : entry),
      dispatch_capability: { ...cap, status: "complete" as const, dispatches: [] },
      pause: { kind: "done", reason: "" },
      specification: nextWorkspace,
      updated_at: now(),
    };
    return {
      ok: true,
      transition: "finalize_import_handoff",
      handoff_ref: prepared.handoff.handoff_id,
      handoff_digest: prepared.handoff.handoff_digest,
      artifact_path: artifactPath,
      document_path: `specs/${input.feature_id}/handoff.md`,
      projection_content_sha256: rendered.value.content_sha256,
      status: "implementation_ready",
      next_action: `/do-work --spec ${input.feature_id}`,
      replayed,
      state: next,
    };
  } catch (error) {
    return finalizerFailure("SPEC_HANDOFF_PERSIST_FAILED", `imported handoff persistence failed safely: ${error instanceof Error ? error.message : String(error)}`, state);
  }
}

export async function finalizeImportedHandoff(
  cwd: string,
  input: ImportedHandoffFinalizationInput,
): Promise<ImportedHandoffFinalizationResult> {
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return finalizerFailure("SPEC_PATH_UNAUTHORIZED", "current project root could not be pinned for imported handoff finalization");
  try {
    const prepared = await prepareImportedHandoffFinalizer(cwd, input, pinnedRoot);
    if (!prepared.ok) return prepared.result;
    const { sourceRoot } = prepared.prepared;
    const preparedConstitution = readPinnedCurrentConstitution(cwd, pinnedRoot, prepared.prepared.handoff.constitution_binding);
    if (!preparedConstitution.ok) {
      sourceRoot.close();
      return finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", preparedConstitution.error);
    }
    let preCommitConstitutionGuard: (() => void) | undefined;
    const rollbackCleanups: Array<() => void> = [];
    try {
      const transaction = runDurableTransaction(
        cwd,
        { feature_id: input.feature_id, run_key: input.run_key },
        (state, target, transactionRoot) => {
          const workspace = state.specification;
          if (workspace && workspace.constitution_binding) {
            if (workspace.source_kind !== "external" || workspace.feature_id !== input.feature_id
              || constitutionBindingIdentity(workspace.constitution_binding) !== constitutionBindingIdentity(prepared.prepared.handoff.constitution_binding)) {
              return finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "imported handoff workspace constitution binding changed during finalization", state);
            }
            preCommitConstitutionGuard = () => {
              const error = workspaceConstitutionError(transactionRoot, workspace);
              if (error) throw new Error(error);
            };
            try { preCommitConstitutionGuard(); } catch (error) {
              return finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", error instanceof Error ? error.message : String(error), state);
            }
          } else {
            return finalizerFailure("SPEC_IMPORT_SOURCE_CHANGED", "imported handoff workspace constitution binding is unavailable", state);
          }
          return finalizeImportedHandoffMutation(state, target, transactionRoot, sourceRoot, prepared.prepared, input, (cleanup) => { rollbackCleanups.push(cleanup); });
        },
        { pinnedRoot, onAbort: () => { for (const rollback of rollbackCleanups) rollback(); }, preCommit: () => { preCommitConstitutionGuard?.(); } },
      );
      if (!transaction.ok) return transaction;
      return {
        ok: true,
        transition: transaction.transition,
        handoff_ref: transaction.handoff_ref,
        handoff_digest: transaction.handoff_digest,
        artifact_path: transaction.artifact_path,
        document_path: transaction.document_path,
        projection_content_sha256: transaction.projection_content_sha256,
        status: transaction.status,
        next_action: transaction.next_action,
        replayed: transaction.replayed,
      };
    } finally {
      sourceRoot.close();
    }
  } catch (error) {
    return finalizerFailure("SPEC_HANDOFF_FINALIZE_FAILED", `imported handoff finalization failed safely: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pinnedRoot.close();
  }
}

/** Alias using the command's terminology for consumers that call the operation directly. */
export const finalizeImportHandoff = finalizeImportedHandoff;

export interface NativeImplementationHandoffFinalizationResult {
  ok: true;
  transition: "finalize_native_handoff";
  source_kind: "native";
  profile_name: string;
  profile_hash: string;
  profile_gate: string;
  handoff_ref: string;
  handoff_digest: string;
  artifact_path: string;
  document_path: string;
  projection_content_sha256: string;
  status: "implementation_ready";
  next_action: string;
  replayed: boolean;
}

type NativeImplementationHandoffFinalizationMutationResult =
  | (NativeImplementationHandoffFinalizationResult & { state?: TeamState })
  | { ok: false; code: string; error: string; state?: TeamState };

function nativeHandoffFinalizerFailure(
  code: string,
  error: string,
  state?: TeamState,
): NativeImplementationHandoffFinalizationMutationResult {
  return { ok: false, code, error, ...(state ? { state } : {}) };
}

function nativeHandoffArtifactPath(
  pinnedRoot: PinnedProjectRoot,
  target: ResolvedState,
  artifactId: string,
): string | null {
  const artifactsDir = artifactsRelativeFor(pinnedRoot, target);
  if (
    artifactsDir === null
    || !/^(specify|plan|tasks)\.v[1-9][0-9]*$/.test(artifactId)
    || !isSafeStateSegment(artifactId)
  ) return null;
  return `${artifactsDir}/${artifactId}.json`;
}

function readNativeHandoffArtifact(
  pinnedRoot: PinnedProjectRoot,
  target: ResolvedState,
  artifactId: string,
): PersistedPhaseResultEnvelope | null {
  const parsed = /^(specify|plan|tasks)\.v([1-9][0-9]*)$/u.exec(artifactId);
  const state = target.state;
  const workspace = state?.specification;
  const runKey = state?.run_key;
  if (!parsed || !state || !workspace || typeof runKey !== "string" || runKey.trim().length === 0) return null;
  return readCanonicalPhaseArtifact(
    pinnedRoot.canonical_root,
    {
      feature_id: workspace.feature_id,
      run_key: runKey,
      phase: parsed[1] as "specify" | "plan" | "tasks",
      version: Number(parsed[2]),
    },
    pinnedRoot,
  );
}

/**
 * Complete a native Specify → Plan → Tasks approval while the caller already
 * owns the durable state transaction. All source reads and immutable writes
 * stay behind that transaction's pinned-root/CAS boundary.
 */
export function finalizeNativeImplementationHandoffMutation(
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  runKey: string,
  registerRollback?: (cleanup: () => void) => void,
): NativeImplementationHandoffFinalizationMutationResult {
  const workspace = state.specification;
  if (!workspace || workspace.source_kind !== "native") {
    return nativeHandoffFinalizerFailure("SPEC_HANDOFF_REJECTED", "native handoff finalization requires a native specification workspace", state);
  }
  if (state.run_key !== runKey || workspace.project_root !== pinnedRoot.canonical_root
    || workspace.project_root_identity.canonical_path !== pinnedRoot.canonical_root
    || workspace.project_root_identity.dev !== pinnedRoot.dev
    || workspace.project_root_identity.ino !== pinnedRoot.ino
    || !pinnedRoot.isStable()) {
    return nativeHandoffFinalizerFailure("SPEC_HANDOFF_SOURCE_CHANGED", "native handoff source identity changed before finalization", state);
  }
  if (!workspace.constitution_binding || !isSafeFeatureId(workspace.feature_id)) {
    return nativeHandoffFinalizerFailure("SPEC_HANDOFF_REJECTED", "native workspace constitution or feature identity is incomplete", state);
  }
  const records = new Map(workspace.phases.map((record) => [record.phase, record]));
  const artifactsDir = artifactsRelativeFor(pinnedRoot, target);
  if (!artifactsDir) return nativeHandoffFinalizerFailure("SPEC_PATH_UNAUTHORIZED", "native phase artifact directory is unavailable", state);
  const phaseArtifacts: Partial<Record<"specify" | "plan" | "tasks", PersistedPhaseResultEnvelope>> = {};
  for (const phase of ["specify", "plan", "tasks"] as const) {
    const record = records.get(phase);
    if (!record || record.status !== "approved" || record.current_version === null || record.approved_version !== record.current_version
      || record.validation_ref !== `validation.${phase}.v${record.current_version}`
      || record.checkpoint_ref !== `checkpoint.${phase}.v${record.current_version}`) {
      return nativeHandoffFinalizerFailure("SPEC_HANDOFF_REJECTED", `native ${phase} phase is not approved at one immutable validated version`, state);
    }
    const artifactId = `${phase}.v${record.current_version}`;
    const artifact = readNativeHandoffArtifact(pinnedRoot, target, artifactId);
    if (!artifact) return nativeHandoffFinalizerFailure("SPEC_HANDOFF_SOURCE_CHANGED", `native ${artifactId} artifact is missing or malformed`, state);
    const validation = readArtifactPinned<Record<string, unknown>>(pinnedRoot, artifactsDir, record.validation_ref);
    if (!validation || !deterministicValidationMatchesArtifact(artifact, validation, pinnedRoot)) {
      return nativeHandoffFinalizerFailure("SPEC_HANDOFF_SOURCE_CHANGED", `native ${artifactId} validation is missing or does not match deterministic artifact validation`, state);
    }
    const materialized = revalidateMaterializedDocumentsPinned(pinnedRoot, {
      feature_id: workspace.feature_id,
      phase,
      version: record.current_version,
    });
    if (!materialized.ok || !Object.values(materialized.value.documents).every((document) => document.matches)
      || !materialized.value.binding
      || materialized.value.binding.artifact_id !== artifact.artifact_id
      || canonicalJson(materialized.value.binding.constitution_binding) !== canonicalJson(artifact.constitution_binding)
      || canonicalJson(materialized.value.binding.upstream_versions) !== canonicalJson(artifact.upstream_versions)) {
      return nativeHandoffFinalizerFailure("SPEC_HANDOFF_SOURCE_CHANGED", `native ${artifactId} readable projection or binding is stale`, state);
    }
    phaseArtifacts[phase] = artifact;
  }
  let handoff: ImplementationHandoff;
  try {
    handoff = deriveNativeImplementationHandoff({
      workspace,
      run_key: runKey,
      phase_artifacts: phaseArtifacts as {
        specify: PersistedPhaseResultEnvelope;
        plan: PersistedPhaseResultEnvelope;
        tasks: PersistedPhaseResultEnvelope;
      },
      phase_dispatches: (() => {
        const dispatches = state.dispatch_capability?.dispatches ?? [];
        const phaseIds = Object.values(phaseArtifacts).map((artifact) => artifact.dispatch_id);
        const matching = phaseIds.map((dispatchId) => dispatches.filter((dispatch) => dispatch.id === dispatchId));
        return matching.every((candidates) => candidates.length === 1)
          ? matching.map((candidates) => candidates[0]!)
          : undefined;
      })(),
    });
  } catch (error) {
    return nativeHandoffFinalizerFailure("SPEC_HANDOFF_REJECTED", `native handoff derivation failed closed: ${error instanceof Error ? error.message : String(error)}`, state);
  }
  const handoffValidation = validateImplementationHandoff(handoff);
  if (!handoffValidation.ok || canonicalHandoffDigest(handoff) !== handoff.handoff_digest) {
    return nativeHandoffFinalizerFailure("SPEC_HANDOFF_INVALID", "engine-derived native handoff failed strict schema or digest validation", state);
  }
  const handoffContract = validateProducedArtifact("implementation_handoff", handoff, currentArtifactContractPolicy());
  if (!handoffContract.ok) return nativeHandoffFinalizerFailure("SPEC_HANDOFF_INVALID", "engine-derived native handoff violates its artifact contract", state);
  if (workspace.handoff_ref !== null && workspace.handoff_ref !== handoff.handoff_id) {
    return nativeHandoffFinalizerFailure("SPEC_HANDOFF_CONFLICT", "workspace points at a different native handoff revision", state);
  }
  const artifactPath = finalizerArtifactPath(pinnedRoot, target, handoff.handoff_id);
  if (artifactPath === null) return nativeHandoffFinalizerFailure("SPEC_PATH_UNAUTHORIZED", "canonical native handoff path is unavailable", state);
  const serializedHandoff = serializeCanonicalHandoff(handoff);
  if (!serializedHandoff.ok) return nativeHandoffFinalizerFailure("SPEC_HANDOFF_INVALID", serializedHandoff.error, state);
  const attemptRollback = createDurableAttemptRollback(pinnedRoot, [artifactPath, `specs/${workspace.feature_id}/handoff.md`], registerRollback);
  try {
    let replayed = false;
    let existing: ImplementationHandoff | null = null;
    const preHandoffConstitutionError = workspaceConstitutionError(pinnedRoot, workspace);
    if (preHandoffConstitutionError) return nativeHandoffFinalizerFailure("SPEC_HANDOFF_SOURCE_CHANGED", preHandoffConstitutionError, state);
    const existingEntry = pinnedRoot.pathEntryInfo(artifactPath);
    if (existingEntry !== null) {
      const loaded = readCanonicalHandoff(pinnedRoot, artifactPath, "existing canonical native handoff");
      if (!loaded.ok) return nativeHandoffFinalizerFailure("SPEC_HANDOFF_CONFLICT", loaded.error, state);
      existing = loaded.handoff;
    }
    if (existing !== null) {
      if (existing.handoff_id !== handoff.handoff_id
        || canonicalJson(existing) !== canonicalJson(handoff)) {
        return nativeHandoffFinalizerFailure("SPEC_HANDOFF_CONFLICT", "an incompatible canonical native handoff artifact already exists", state);
      }
      replayed = true;
    } else {
      try {
        injectHandoffFinalizerWriteHook(pinnedRoot, handoff.handoff_id);
        const beforeCanonicalWriteError = workspaceConstitutionError(pinnedRoot, workspace);
        if (beforeCanonicalWriteError) throw new Error(beforeCanonicalWriteError);
        pinnedRoot.writeExclusiveWithReceipt(artifactPath, serializedHandoff.bytes, { beforePublish: (published) => attemptRollback?.record(artifactPath, published) });
      } catch (error) {
        if (!(error instanceof PinnedRootError && error.code === "exists")) throw error;
        const loaded = readCanonicalHandoff(pinnedRoot, artifactPath, "concurrent canonical native handoff");
        if (!loaded.ok) return nativeHandoffFinalizerFailure("SPEC_HANDOFF_CONFLICT", loaded.error, state);
        existing = loaded.handoff;
        if (canonicalJson(existing) !== canonicalJson(handoff)) {
          return nativeHandoffFinalizerFailure("SPEC_HANDOFF_CONFLICT", "concurrent canonical native handoff conflicts with the derived handoff", state);
        }
        replayed = true;
      }
    }
    const readback = readCanonicalHandoff(pinnedRoot, artifactPath, "canonical native handoff readback");
    if (!readback.ok || canonicalJson(readback.handoff) !== canonicalJson(handoff)) {
      return nativeHandoffFinalizerFailure("SPEC_HANDOFF_INVALID", readback.ok ? "canonical native handoff readback failed strict schema or digest validation" : readback.error, state);
    }
    const preProjectionConstitutionError = workspaceConstitutionError(pinnedRoot, workspace);
    if (preProjectionConstitutionError) return nativeHandoffFinalizerFailure("SPEC_HANDOFF_SOURCE_CHANGED", preProjectionConstitutionError, state);
    const rendered = materializeImplementationHandoffPinned(pinnedRoot, handoff, {
      beforeWrite: () => {
        const constitutionError = workspaceConstitutionError(pinnedRoot, workspace);
        if (constitutionError) throw new Error(constitutionError);
      },
      beforePublish: (receipt) => { attemptRollback?.record(`specs/${workspace.feature_id}/handoff.md`, receipt); },
    });
    if (!rendered.ok) return nativeHandoffFinalizerFailure("SPEC_HANDOFF_RENDER_FAILED", rendered.error, state);
    if (!pinnedRoot.isStable()) return nativeHandoffFinalizerFailure("SPEC_HANDOFF_SOURCE_CHANGED", "project root changed during native handoff materialization", state);
    const preCommitConstitutionError = workspaceConstitutionError(pinnedRoot, workspace);
    if (preCommitConstitutionError) return nativeHandoffFinalizerFailure("SPEC_HANDOFF_SOURCE_CHANGED", preCommitConstitutionError, state);
    const nextWorkspace: FeatureWorkspace = {
      ...workspace,
      status: "implementation_ready",
      handoff_ref: handoff.handoff_id,
      next_action: {
        kind: "command",
        command: `/do-work --spec ${workspace.feature_id}`,
        reason: "Native Specify, Plan, and Tasks approvals finalized the engine-owned implementation handoff.",
      },
    };
    const workspaceValidation = validateFeatureWorkspaceRecord(nextWorkspace);
    if (!workspaceValidation.ok) return nativeHandoffFinalizerFailure("SPEC_STATE_INVALID", `implementation-ready workspace is invalid: ${workspaceValidation.issues.join("; ")}`, state);
    const cap = state.dispatch_capability;
    const next: TeamState = {
      ...state,
      stages: state.stages.map((stage) => stage.id === "tasks" ? { ...stage, status: "done" as const } : stage),
      ...(cap ? { dispatch_capability: { ...cap, status: "complete" as const, dispatches: [] } } : {}),
      pause: { kind: "done", reason: "" },
      specification: nextWorkspace,
      updated_at: now(),
    };
    return {
      ok: true,
      transition: "finalize_native_handoff",
      source_kind: "native",
      profile_name: workspace.profile_name,
      profile_hash: workspace.profile_hash,
      profile_gate: `execution-profile.${workspace.profile_hash}`,
      handoff_ref: handoff.handoff_id,
      handoff_digest: handoff.handoff_digest,
      artifact_path: artifactPath,
      document_path: `specs/${workspace.feature_id}/handoff.md`,
      projection_content_sha256: rendered.value.content_sha256,
      status: "implementation_ready",
      next_action: `/do-work --spec ${workspace.feature_id}`,
      replayed,
      state: next,
    };
  } catch (error) {
    return nativeHandoffFinalizerFailure("SPEC_HANDOFF_PERSIST_FAILED", `native handoff persistence failed safely: ${error instanceof Error ? error.message : String(error)}`, state);
  }
}


export interface ChildJoinInput {
  parent: WorkIdentity;
  child: WorkIdentity;
  state: ChildJoin["state"];
  expected_artifact_ids: string[];
  completion_envelope_ref: string | null;
  attempt: number;
  completion_envelope?: CompletionEnvelope;
}

function sameIdentity(left: WorkIdentity | undefined, right: WorkIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/** Append a child result to the durable parent ledger without positional joins. */
export function appendChildJoin(cwd: string, input: ChildJoinInput): TransitionResult {
  let guardedRoot: PinnedProjectRoot | undefined;
  let guardedWorkspace: FeatureWorkspace | undefined;
  return runDurableTransaction(cwd, {}, (state, target, pinnedRoot) => {
    guardedRoot = pinnedRoot;
    guardedWorkspace = state.specification;
    return appendChildJoinMutation(cwd, state, target, input);
  }, {
    preCommit: () => {
      if (guardedRoot && guardedWorkspace?.constitution_binding) {
        const constitutionError = workspaceConstitutionError(guardedRoot, guardedWorkspace);
        if (constitutionError) throw new Error(constitutionError);
      }
    },
  });
}

function appendChildJoinMutation(cwd: string, state: TeamState, target: ResolvedState, input: ChildJoinInput): TransitionResult {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  if (!sameIdentity(input.parent, state.work_identity) && (
    input.parent.capability_id !== cap.capability_id
    || input.parent.capability_epoch !== cap.issued_for.cursor_epoch
  )) return { ok: false, error: "parent identity is not bound to the active capability", state };
  if (!input.child.run_id || !input.child.task_id || !input.child.dispatch_id || !input.child.worker_id) return { ok: false, error: "child identity is incomplete", state };
  if (sameIdentity(input.parent, input.child)) return { ok: false, error: "parent and child identities must differ", state };
  if (!Number.isInteger(input.attempt) || input.attempt < 1) return { ok: false, error: "child attempt must be a positive integer", state };
  if (new Set(input.expected_artifact_ids).size !== input.expected_artifact_ids.length || input.expected_artifact_ids.some((id) => !isSafeStateSegment(id))) {
    return { ok: false, error: "child artifact ids are unsafe or duplicated", state };
  }
  if (input.completion_envelope) {
    const terminal = input.state === "succeeded" || input.state === "failed" || input.state === "cancelled";
    if (
      !sameIdentity(input.completion_envelope.identity, input.child)
      || input.completion_envelope.outcome !== (terminal ? input.state : "pending")
      || (terminal ? input.completion_envelope.terminal_signal === null : input.completion_envelope.terminal_signal !== null)
    ) return { ok: false, error: "child completion envelope is not a validated terminal/pending envelope", state };
  }
  if ((input.state === "succeeded" || input.state === "failed" || input.state === "cancelled") && !input.completion_envelope) {
    return { ok: false, error: "terminal child join requires a completion envelope", state };
  }
  const existing = (state.child_joins ?? []).find((join) => sameIdentity(join.parent, input.parent) && sameIdentity(join.child, input.child));
  if (existing) {
    const exact = existing.state === input.state
      && existing.attempt === input.attempt
      && existing.completion_envelope_ref === input.completion_envelope_ref
      && JSON.stringify(existing.expected_artifact_ids) === JSON.stringify(input.expected_artifact_ids);
    if (exact) return { ok: true, state, child_join: existing };
    const conflictRef = `conflict:${hash(JSON.stringify({ existing, input }))}`;
    const conflict: ChildJoin = {
      parent: input.parent,
      child: input.child,
      state: "conflict",
      expected_artifact_ids: [...input.expected_artifact_ids],
      completion_envelope_ref: conflictRef,
      attempt: Math.max(existing.attempt, input.attempt),
      created_at: existing.created_at,
      joined_at: now(),
    };
    const next: TeamState = { ...state, child_join: conflict, child_joins: [...(state.child_joins ?? []), conflict], updated_at: now() };
    return { ok: false, error: `child join conflict (${conflictRef})`, state: next, child_join: conflict };
  }
  const priorChild = (state.child_joins ?? []).find((join) => sameIdentity(join.parent, input.parent) && join.child.task_id === input.child.task_id);
  if (priorChild && priorChild.state !== "succeeded" && priorChild.state !== "failed" && priorChild.state !== "cancelled") {
    return { ok: false, error: "active child join cannot be replaced", state };
  }
  if (priorChild && input.attempt <= priorChild.attempt) return { ok: false, error: "child replacement attempt must increase", state };
  const joined: ChildJoin = {
    parent: input.parent,
    child: input.child,
    state: input.state,
    expected_artifact_ids: [...input.expected_artifact_ids],
    completion_envelope_ref: input.completion_envelope_ref,
    attempt: input.attempt,
    created_at: now(),
    joined_at: now(),
  };
  const next: TeamState = {
    ...state,
    child_join: joined,
    child_joins: [...(state.child_joins ?? []), joined],
    updated_at: now(),
  };
  return { ok: true, state: next, child_join: joined };
}


export interface CheckpointDecisionInput extends Omit<DispatchAuth, "token"> {
  token?: string;
  advance_token?: string;
  checkpoint: string;
  decision: string;
  rationale: string;
  evidence?: string;
  feature_id?: string;
  loop_iteration?: number;
  subject_binding?: string;
  run_id?: string;
  checkpoint_id?: string;
  checkpoint_kind?: TypedCheckpointDecision["checkpoint_kind"];
  authorization?: TypedCheckpointDecision["authorization"];
  actor_provenance?: TypedCheckpointDecision["actor"];
  /** Legacy fields are accepted as display input only and never authorize. */
  mode?: "interactive" | "autonomous";
  actor?: string;
}

/** Persist a policy-bound typed checkpoint decision. */
export function recordCheckpointDecision(cwd: string, input: CheckpointDecisionInput): TransitionResult {
  const inputError = workflowCheckpointInputError(input);
  if (inputError) return { ok: false, error: inputError };
  let guardedRoot: PinnedProjectRoot | undefined;
  let guardedWorkspace: FeatureWorkspace | undefined;
  return runDurableTransaction(cwd, input, (state, target, pinnedRoot) => {
    guardedRoot = pinnedRoot;
    guardedWorkspace = state.specification;
    const result = recordCheckpointDecisionMutation(cwd, state, target, pinnedRoot, input);
    if (result.state?.specification) guardedWorkspace = result.state.specification;
    return result;
  }, {
    preCommit: () => {
      if (guardedRoot && guardedWorkspace && (guardedWorkspace.source_kind === "native" || guardedWorkspace.source_kind === "legacy" || guardedWorkspace.source_kind === "external")) {
        const constitutionError = workspaceConstitutionError(guardedRoot, guardedWorkspace);
        if (constitutionError) throw new Error(constitutionError);
      }
    },
  });
}

function recordCheckpointDecisionMutation(cwd: string, state: TeamState, target: ResolvedState, pinnedRoot: PinnedProjectRoot, input: CheckpointDecisionInput, allowInFlightSubjectRevision = false, allowNativeComposite = false): TransitionResult {
  const inputError = workflowCheckpointInputError(input);
  if (inputError) return { ok: false, error: inputError, state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const stateBindingError = stateCapabilityBindingError(state, cap, pinnedRoot, input.feature_id);
  if (stateBindingError) return { ok: false, error: stateBindingError, state };
  const selectedToken = selectedAdvanceToken(input);
  if (!selectedToken) return { ok: false, error: "advance_token is required and must not conflict with legacy token", state };
  const error = auth(cap, { ...input, token: selectedToken }, cap.advance_token_hash);
  if (error) return { ok: false, error, state };
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  if (input.stage_cursor !== cap.issued_for.stage_cursor) return { ok: false, error: "checkpoint stage does not match the active capability", state };
  if (!input.checkpoint.trim() || !input.decision.trim()) return { ok: false, error: "checkpoint name and decision are required", state };
  if (!input.authorization || !input.actor_provenance) {
    return { ok: false, error: "typed checkpoint authorization and actor provenance are required; legacy mode/actor fields cannot authorize", state };
  }
  const profile = loadProfile(cap.issued_for.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === cap.issued_for.stage_cursor);
  if (!stage?.checkpoint) return { ok: false, error: `stage '${cap.issued_for.stage_cursor}' declares no checkpoint`, state };
  if (input.checkpoint !== stage.checkpoint || (input.checkpoint_id && input.checkpoint_id !== input.checkpoint)) {
    return { ok: false, error: `checkpoint '${input.checkpoint}' does not match declared checkpoint '${stage.checkpoint}'`, state };
  }
  const policy = resolveCheckpointPolicy(stage, state);
  if (!policy) return { ok: false, error: `checkpoint '${input.checkpoint}' has no policy`, state };
  const rule = policy.rules[input.checkpoint];
  if (!rule) return { ok: false, error: `checkpoint policy has no rule for '${input.checkpoint}'`, state };
  const specification = state.specification;
  if (specification && (specification.source_kind === "native" || specification.source_kind === "legacy" || specification.source_kind === "external")) {
    const constitutionError = workspaceConstitutionError(pinnedRoot, specification);
    if (constitutionError) return { ok: false, error: constitutionError, state };
  }
  let selectedSubject: SelectedSubjectResult | null = null;
  let selectedNative: SelectedNativePhaseIdentity | null = null;
  let replayedDecision: TypedCheckpointDecision | undefined;
  const nativePhaseCheckpoint = (specification?.source_kind === "native" || specification?.source_kind === "legacy")
    && ["specify", "plan", "tasks"].includes(stage.id);
  if (!allowNativeComposite && specification?.source_kind === "native" && ["specify", "plan", "tasks"].includes(stage.id)) {
    return { ok: false, error: "NATIVE_COMPOSITE_REQUIRED: native specification checkpoint decisions must be committed through the authenticated selected Ask path", state };
  }
  if (specification !== undefined
    || (specification === undefined && input.feature_id !== undefined && input.subject_binding !== undefined)) {
    const subjectKind = nativePhaseCheckpoint ? "native" : specification?.source_kind === "external" ? "external" : "selected";
    const selectedFeatureId = input.feature_id;
    if (!selectedFeatureId || (specification && (!specification.feature_id || selectedFeatureId !== specification.feature_id))) {
      return { ok: false, error: ` checkpoint decision feature identity is missing or mismatched`, state };
    }
    const selectedInput: CheckpointAskSelectedRequest = {
      feature_id: selectedFeatureId,
      advance_token: selectedToken,
      capability_id: input.capability_id,
      run_key: input.run_key,
      branch: input.branch,
      workflow: input.workflow,
      profile_hash: input.profile_hash,
      stage_cursor: input.stage_cursor,
      cursor_epoch: input.cursor_epoch,
      checkpoint: input.checkpoint,
      checkpoint_id: input.checkpoint_id ?? input.checkpoint,
      checkpoint_kind: input.checkpoint_kind ?? rule.kind,
      loop_iteration: input.loop_iteration,
    };
    const subjectResult = selectedSubjectForCheckpoint(pinnedRoot, state, target, selectedInput, stage, profile!, policy, rule, rule.allowed_decisions, undefined, input.actor_provenance?.proof?.answer_id);
    if (subjectResult.error || !subjectResult.subject) return { ok: false, error: subjectResult.error ?? `${subjectKind} checkpoint subject could not be bound`, state };
    selectedSubject = subjectResult.subject;
    selectedNative = selectedSubject.native_identity;
    if (input.subject_binding !== undefined && input.subject_binding !== selectedSubject.binding) return { ok: false, error: `${subjectKind} checkpoint subject binding is stale`, state };
    const answerId = input.actor_provenance?.proof?.answer_id;
    if (answerId) {
      const answer = state.trusted_checkpoint_answers?.find((candidate) => candidate.answer_id === answerId);
      replayedDecision = answer?.consumed_at
        ? state.typed_checkpoint_decisions?.find((candidate) => candidate.actor.proof?.answer_id === answerId)
        : undefined;
      const immediateReplay = replayedDecision !== undefined
        && answer?.subject_revision !== undefined
        && answer.subject_revision + 1 === selectedSubject.state_revision;
      if (!answer || (answer.subject_revision !== selectedSubject.state_revision
        && !immediateReplay
        && !(allowInFlightSubjectRevision && answer.subject_revision === selectedSubject.state_revision + 1))) {
        return { ok: false, error: `${subjectKind} checkpoint proof subject revision is stale`, state };
      }
    }
  }
  const decision: TypedCheckpointDecision = {
    run_id: input.run_id ?? state.work_identity?.run_id ?? state.run_key ?? state.branch,
    stage_id: stage.id,
    checkpoint_id: input.checkpoint,
    checkpoint_kind: input.checkpoint_kind ?? rule.kind,
    decision: input.decision.trim(),
    authorization: input.authorization,
    actor: input.actor_provenance,
    capability_id: cap.capability_id,
    capability_epoch: cap.issued_for.cursor_epoch,
    policy_hash: checkpointPolicyHash(policy),
    ...(selectedSubject ? { feature_id: input.feature_id, loop_iteration: selectedSubject.loop_iteration, subject_binding: selectedSubject.binding } : {}),
    ...(selectedNative ? {
      artifact_id: selectedNative.artifact_id,
      artifact_version: selectedNative.artifact_version,
      artifact_digest: selectedNative.artifact_digest,
      validation_ref: selectedNative.validation_ref,
      validation_digest: selectedNative.validation_digest,
    } : {}),
    rationale: input.rationale.trim(),
    decided_at: replayedDecision?.decided_at ?? now(),
  };
  const validated = validateCheckpointDecision(state, decision, { stage, policy });
  if (!validated.ok) return { ok: false, error: `${validated.code}: ${validated.error}`, state };
  try {
    const next = appendCheckpointDecision(state, validated.decision);
    if (
      next.specification?.source_kind === "native"
      && ["specify", "plan", "tasks"].includes(stage.id)
      && ["approve_continue", "request_changes", "approve_stop"].includes(validated.decision.decision)
    ) {
      const phase = stage.id as "specify" | "plan" | "tasks";
      const projected = projectNativeSpecificationPhaseDecision(
        next.specification,
        phase,
        validated.decision.decision as "approve_continue" | "request_changes" | "approve_stop",
        validated.decision.rationale,
      );
      return { ok: true, state: { ...next, specification: projected } };
    }
    return { ok: true, state: next };
  } catch (appendError) {
    return { ok: false, error: appendError instanceof Error ? appendError.message : String(appendError), state };
  }
}
type ReconcileTaskResultInput = {
  dispatch_id?: string;
  tool_call_id?: string;
  slot_id?: string;
  task_id?: string;
  token?: string;
  capability_id: string;
  cursor_epoch?: string;
  output?: string;
  isError?: boolean;
  details?: { async?: { state?: string; provider_ref?: string } };
};

/**
 * Explicit feature-selected trusted checkpoint ask. Unlike the legacy ask
 */
export interface CheckpointAskCanonicalSummary {
  feature_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  checkpoint: string;
  checkpoint_id: string;
  checkpoint_kind: string;
  cursor_epoch: string;
  capability_id: string;
  policy_hash: string;
  allowed_decisions: string[];
  loop_iteration: number;
  snapshot_id: string | null;
  source_sha256: string | null;
  normalized_hash: string | null;
  constitution_content_sha256: string | null;
  compatibility_report_id: string | null;
  source_root: string | null;
  source_root_dev: number | null;
  source_root_ino: number | null;
  subject_binding: string;
}

export interface CheckpointAskSelectedRequest {
  feature_id: string;
  token?: string;
  advance_token?: string;
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  checkpoint: string;
  checkpoint_id: string;
  checkpoint_kind: string;
  loop_iteration?: number;
  question?: string;
}

export interface CheckpointAskSelectedContext {
  state: TeamState;
  target: ResolvedState;
  stage: StageDef;
  policy: CheckpointPolicy;
  rule: CheckpointRule;
  allowed: string[];
  loop_iteration: number;
  subject_binding: string;
  native_identity: SelectedNativePhaseIdentity | null;
  state_revision: number;
  state_digest: string;
  /** Canonical external source root to pin across the host UI and commit. */
  external_source_root?: { canonical_path: string; dev: number; ino: number };
  canonical_summary: CheckpointAskCanonicalSummary;
}

export type CheckpointAskSelectedPreflight =
  | { ok: true; context: CheckpointAskSelectedContext }
  | { ok: false; error: string };

const MAX_SELECTED_SUBJECT_FILES = 4096;
const MAX_SELECTED_SUBJECT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SELECTED_LOOP_ITERATION = 1_000_000;

type SelectedImportIdentity = {
  snapshot_id: string;
  source_sha256: string;
  normalized_hash: string;
  constitution_content_sha256: string;
  compatibility_report_id: string;
  snapshot_digest: string;
  report_digest: string;
  constitution_digest: string;
  source_root: string;
  source_root_dev: number;
  source_root_ino: number;
  limits: ImportSnapshotLimits;
};

type SelectedNativePhaseIdentity = {
  phase: "specify" | "plan" | "tasks";
  artifact_id: string;
  artifact_version: number;
  artifact_digest: string;
  validation_ref: string;
  validation_digest: string;
  constitution_digest: string;
};

type SelectedSubjectResult = {
  binding: string;
  state_revision: number;
  state_digest: string;
  loop_iteration: number;
  import_identity: SelectedImportIdentity | null;
  native_identity: SelectedNativePhaseIdentity | null;
};

function selectedBoundedString(value: unknown, maxLength = 4096): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxLength
    && Buffer.byteLength(value, "utf8") <= maxLength
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function selectedAdvanceToken(input: { token?: unknown; advance_token?: unknown }): string | null {
  const legacy = selectedBoundedString(input.token, 4096) ? input.token : null;
  const canonical = selectedBoundedString(input.advance_token, 4096) ? input.advance_token : null;
  if (legacy !== null && canonical !== null && legacy !== canonical) return null;
  return canonical ?? legacy;
}

function selectedExpectedRunId(state: TeamState): string {
  return state.work_identity?.run_id ?? state.run_key ?? state.branch;
}

function selectedStateRevision(state: TeamState): number {
  const revision = (state as TeamState & { state_revision?: unknown }).state_revision;
  return Number.isSafeInteger(revision) && (revision as number) >= 0 ? revision as number : 0;
}

function selectedCurrentLoopIteration(state: TeamState, profile: Profile, stageId: string): number {
  const currentIndex = profile.stages.findIndex((stage) => stage.id === stageId);
  if (currentIndex < 0) return 1;
  const inLoopInterval = (ownerId: string, backTo: string): boolean => {
    const ownerIndex = profile.stages.findIndex((stage) => stage.id === ownerId);
    const backToIndex = profile.stages.findIndex((stage) => stage.id === backTo);
    return ownerIndex >= 0 && backToIndex >= 0 && backToIndex <= currentIndex && currentIndex <= ownerIndex;
  };
  const loop = state.loop_state;
  if (loop?.status === "running" && Number.isSafeInteger(loop.reentries) && loop.reentries >= 0 && inLoopInterval(loop.stage_id, loop.back_to)) {
    return Math.min(MAX_SELECTED_LOOP_ITERATION, Math.max(1, loop.reentries + 1));
  }
  // Before the first loop-back there is no durable LoopState yet. Every
  // stage in the profile-ordered back_to -> owner interval is therefore in
  // iteration one; the interval check above is only needed once re-entry
  // history exists, to prevent a stale loop record binding an unrelated stage.
  return 1;
}

function selectedStableStateProjection(state: TeamState): unknown {
  const projection = { ...state } as Record<string, unknown>;
  delete projection.updated_at;
  delete projection.state_revision;
  delete projection.trusted_checkpoint_answers;
  delete projection.typed_checkpoint_decisions;
  delete projection.checkpoint_decisions;
  return projection;
}

function selectedArtifactDirectory(pinnedRoot: PinnedProjectRoot, target: ResolvedState): string | null {
  const relativePath = pinnedRoot.relativePath(target.artifactsDir);
  return relativePath === null || relativePath.length === 0 ? null : relativePath;
}
function selectedNativePhaseIdentity(
  pinnedRoot: PinnedProjectRoot,
  target: ResolvedState,
  workspace: FeatureWorkspace,
  stage: StageDef,
  trustedAnswerId?: string,
  allowExistingDecision = false,
): { identity: SelectedNativePhaseIdentity | null; error?: string } {
  if ((workspace.source_kind !== "native" && workspace.source_kind !== "legacy")
    || !["specify", "plan", "tasks"].includes(stage.id)) return { identity: null };
  const phase = stage.id as SelectedNativePhaseIdentity["phase"];
  const record = workspace.phases.find((candidate) => candidate.phase === phase);
  const version = record?.current_version ?? null;
  const canonicalPresentationRef = version === null ? null : `checkpoint.${phase}.v${version}`;
  const priorDecision = target.state ? findCheckpointDecision(target.state, phase, "specification_phase_approval") : null;
  const currentAnswers = (target.state?.trusted_checkpoint_answers ?? []).filter((answer) =>
    !answer.consumed_at
    && answer.feature_id === workspace.feature_id
    && answer.run_id === (target.state?.run_key ?? "")
    && answer.stage_id === phase
    && answer.checkpoint_id === "specification_phase_approval",
  );
  // A selected-ask answer is the only mutable-looking checkpoint state that
  // may coexist with the native awaiting_approval postimage: the decision
  // path must revalidate that exact answer before consuming it. A second ask
  // (or a guessed/stale answer id) remains rejected.
  const exactCurrentAnswer = trustedAnswerId === undefined
    ? null
    : currentAnswers.find((answer) => answer.answer_id === trustedAnswerId) ?? null;
  const priorAnswer = trustedAnswerId === undefined
    ? currentAnswers.length > 0
    : currentAnswers.length > 0 && exactCurrentAnswer === null;
  if (!record || record.status !== "awaiting_approval" || version === null || version < 1
    || record.approved_version !== null
    || (record.checkpoint_ref !== null && record.checkpoint_ref !== canonicalPresentationRef)
    || (priorDecision !== null && !allowExistingDecision)
    || priorAnswer
    || record.validation_ref !== `validation.${phase}.v${version}`) {
    return { identity: null, error: `${workspace.source_kind} ${phase} checkpoint requires one current awaiting_approval candidate without a prior approval decision` };
  }
  if (!workspace.constitution_binding || validateConstitutionBinding(workspace.constitution_binding).length > 0) {
    return { identity: null, error: "native checkpoint constitution binding is unavailable or invalid" };
  }
  const artifactsDir = selectedArtifactDirectory(pinnedRoot, target);
  if (!artifactsDir) return { identity: null, error: "native checkpoint artifact directory is outside the pinned project root" };
  const artifactId = `${phase}.v${version}`;
  const artifact = readCanonicalPhaseArtifact(pinnedRoot.canonical_root, {
    feature_id: workspace.feature_id,
    run_key: target.state?.run_key ?? "",
    phase,
    version,
  }, pinnedRoot);
  if (!artifact
    || artifact.feature_id !== workspace.feature_id
    || artifact.run_key !== (target.state?.run_key ?? "")
    || artifact.artifact_id !== artifactId
    || artifact.phase !== phase
    || artifact.version !== version
    || canonicalJson(artifact.constitution_binding) !== canonicalJson(workspace.constitution_binding)) {
    return { identity: null, error: `native ${artifactId} candidate artifact is missing, stale, or not bound to the current constitution` };
  }
  const validation = readArtifactPinned<Record<string, unknown>>(pinnedRoot, artifactsDir, record.validation_ref);
  if (!validation || typeof validation.validated_at !== "string") return { identity: null, error: `native ${record.validation_ref} validation artifact is missing or malformed` };
  const validationInput = deterministicValidationInputForArtifact(artifact, pinnedRoot, validation.validated_at);
  if (validationInput === null) {
    return { identity: null, error: `${workspace.source_kind} ${record.validation_ref} cannot derive deterministic validation input for ${artifactId}` };
  }
  const validationMatches = workspace.source_kind === "native"
    ? deterministicValidationMatchesArtifact(artifact, validation, pinnedRoot)
    : canonicalJson(validateNativePhase(validationInput)) === canonicalJson(validation);
  if (!validationMatches) {
    return { identity: null, error: `${workspace.source_kind} ${record.validation_ref} does not match deterministic validation for ${artifactId}` };
  }
  const checks = validation.checks;
  const findings = validation.blocking_findings;
  const constitution = validation.constitution;
  const validationBinding = isRecord(constitution) ? constitution.binding : undefined;
  if (
    validation.validation_id !== record.validation_ref
    || validation.phase !== phase
    || validation.artifact_version !== artifactId
    || validation.status !== "pass"
    || !Array.isArray(checks)
    || checks.length === 0
    || checks.some((check) => !isRecord(check) || check.status !== "pass")
    || !Array.isArray(findings)
    || findings.length !== 0
    || !isRecord(constitution)
    || !validationBinding
    || canonicalJson(validationBinding) !== canonicalJson(workspace.constitution_binding)
  ) {
    return { identity: null, error: `native ${record.validation_ref} is not a strict passing validation bound to ${artifactId}` };
  }
  return {
    identity: {
      phase,
      artifact_id: artifactId,
      artifact_version: version,
      artifact_digest: digestOf(artifact),
      validation_ref: record.validation_ref,
      validation_digest: digestOf(validation),
      constitution_digest: digestOf(workspace.constitution_binding),
    },
  };
}

function selectedImportedIdentity(
  pinnedRoot: PinnedProjectRoot,
  target: ResolvedState,
  workspace: FeatureWorkspace,
  sourceRoot?: PinnedProjectRoot,
): { identity: SelectedImportIdentity | null; error?: string } {
  if (workspace.source_kind !== "external") return { identity: null };
  if (!workspace.import_ref || !workspace.constitution_binding) return { identity: null, error: "external workspace import/constitution binding is incomplete" };
  const artifactsDir = selectedArtifactDirectory(pinnedRoot, target);
  if (!artifactsDir) return { identity: null, error: "selected artifact directory is outside the pinned project root" };
  const snapshotRaw = readArtifactPinned<Record<string, unknown>>(pinnedRoot, artifactsDir, "import_snapshot");
  const reportRaw = readArtifactPinned<Record<string, unknown>>(pinnedRoot, artifactsDir, "compatibility_report");
  const snapshot = snapshotRaw as unknown as ImportSnapshot | null;
  const report = reportRaw as unknown as CompatibilityReport | null;
  if (!snapshot || !report) return { identity: null, error: "current import snapshot and compatibility report are unavailable" };
  const snapshotValidation = validateImportSnapshot(snapshot);
  if (!snapshotValidation.ok) return { identity: null, error: "current import snapshot is invalid: " + snapshotValidation.issues.join("; ") };
  const reportValidation = validateCompatibilityReport(report);
  if (!reportValidation.ok) return { identity: null, error: "current compatibility report is invalid: " + reportValidation.issues.join("; ") };
  const constitutionIssues = validateConstitutionBinding(workspace.constitution_binding);
  if (constitutionIssues.length > 0) return { identity: null, error: "current constitution binding is invalid: " + constitutionIssues.join("; ") };
  if (snapshot.snapshot_id !== workspace.import_ref) return { identity: null, error: "workspace import reference does not match the current snapshot" };
  if (report.snapshot_ref !== snapshot.snapshot_id || report.status !== "ready") return { identity: null, error: "compatibility report is stale or not ready for authorization" };
  if (canonicalJson(report.constitution_binding) !== canonicalJson(workspace.constitution_binding)) return { identity: null, error: "compatibility report constitution binding is stale" };
  if (!pinnedRoot.isStable()) return { identity: null, error: "pinned project root changed while reading import artifacts" };
  if (!pinnedRoot.isStable()) return { identity: null, error: "pinned project root changed while reading import artifacts" };
  const persistedLimitsValidation = snapshot.limits === undefined ? { ok: true as const } : validateImportLimits(snapshot.limits);
  if (!persistedLimitsValidation.ok) return { identity: null, error: "persisted import limits are invalid: " + persistedLimitsValidation.issues.join("; ") };
  const importLimits = snapshot.limits ?? DEFAULT_IMPORT_LIMITS;
  if (!Array.isArray(snapshot.files) || snapshot.files.length > MAX_SELECTED_SUBJECT_FILES || snapshot.files.length > importLimits.maxFiles) return { identity: null, error: "import snapshot file count exceeds the persisted authorization bound" };
  const fileRecords = snapshot.files as unknown as Array<Record<string, unknown>>;
  let aggregateBytes = 0;
  let textBytes = 0;
  const ownsSourceRoot = sourceRoot === undefined;
  const externalRoot = sourceRoot ?? PinnedProjectRoot.open(snapshot.source_root);
  if (!externalRoot) return { identity: null, error: "import source root could not be pinned" };
  try {
    if (!externalRoot.isStable()
      || externalRoot.canonical_root !== snapshot.source_root
      || externalRoot.dev !== snapshot.source_root_identity.dev
      || externalRoot.ino !== snapshot.source_root_identity.ino) {
      return { identity: null, error: "import source root identity changed" };
    }
    for (const file of fileRecords) {
      const mediaType = typeof file.media_type === "string" ? file.media_type.toLowerCase() : "";
      const textMedia = mediaType.startsWith("text/") || ["application/json", "application/yaml", "application/toml", "application/xml", "application/javascript", "application/typescript"].includes(mediaType);
      const mediaLimit = textMedia ? importLimits.maxTextBytes : importLimits.maxBinaryBytes;
      if (typeof file.path !== "string" || !isSafeRelativePath(file.path) || typeof file.sha256 !== "string" || typeof file.size_bytes !== "number" || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 1 || file.size_bytes > MAX_SELECTED_SUBJECT_FILE_BYTES || file.size_bytes > importLimits.maxFileBytes || (!textMedia && file.size_bytes > mediaLimit) || file.size_bytes > importLimits.maxBytes - aggregateBytes || (textMedia && file.size_bytes > importLimits.maxTextBytes - textBytes)) {
        return { identity: null, error: "import snapshot contains a file outside the persisted authorization limits" };
      }
      aggregateBytes += file.size_bytes;
      if (textMedia) textBytes += file.size_bytes;
      let read;
      try { read = externalRoot.readFile(file.path, { maxBytes: Math.min(MAX_SELECTED_SUBJECT_FILE_BYTES, importLimits.maxFileBytes, textMedia ? importLimits.maxTextBytes - textBytes + file.size_bytes : mediaLimit) }); } catch { return { identity: null, error: "import source file could not be read through the pinned source root" }; }
      const bytes = Buffer.from(read.bytes);
      const sourceDigest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== file.size_bytes || sourceDigest !== file.sha256) return { identity: null, error: "import source bytes changed since snapshot" };
    }
    if (!pinnedRoot.isStable() || !externalRoot.isStable()) return { identity: null, error: "pinned source or project root changed while reading import sources" };
  } finally {
    if (ownsSourceRoot) externalRoot.close();
  }
  if (typeof snapshot.normalized_content_ref !== "string") return { identity: null, error: "normalized import identity is missing" };
  const normalizedMatch = /^normalized\.([a-f0-9]{64})$/u.exec(snapshot.normalized_content_ref);
  if (!normalizedMatch) return { identity: null, error: "normalized import identity is malformed" };
  const constitutionPath = workspace.constitution_binding.path;
  if (!isSafeRelativePath(constitutionPath)) return { identity: null, error: "constitution binding path is unsafe" };
  let constitutionBytes;
  try { constitutionBytes = pinnedRoot.readFile(constitutionPath, { maxBytes: MAX_SELECTED_SUBJECT_FILE_BYTES }).bytes; } catch { return { identity: null, error: "constitution bytes could not be read through the pinned root" }; }
  const constitutionDigest = createHash("sha256").update(Buffer.from(constitutionBytes)).digest("hex");
  if (constitutionDigest !== workspace.constitution_binding.content_sha256) return { identity: null, error: "constitution bytes changed since approval" };
  const sourceSha256 = fileRecords.length === 1
    ? String(fileRecords[0]?.sha256 ?? "")
    : digestOf(fileRecords.map((file) => ({ path: file.path, sha256: file.sha256, size_bytes: file.size_bytes })));
  return {
    identity: {
      snapshot_id: snapshot.snapshot_id,
      source_sha256: sourceSha256,
      normalized_hash: normalizedMatch[1]!,
      constitution_content_sha256: workspace.constitution_binding.content_sha256,
      compatibility_report_id: report.report_id,
      snapshot_digest: digestOf(snapshot),
      report_digest: digestOf(report),
      constitution_digest: digestOf(workspace.constitution_binding),
      source_root: snapshot.source_root,
      source_root_dev: snapshot.source_root_identity.dev,
      source_root_ino: snapshot.source_root_identity.ino,
      limits: importLimits,
    },
  };
}

function selectedSubjectForCheckpoint(
  pinnedRoot: PinnedProjectRoot,
  state: TeamState,
  target: ResolvedState,
  input: CheckpointAskSelectedRequest,
  stage: StageDef,
  profile: Profile,
  policy: CheckpointPolicy,
  rule: CheckpointRule,
  allowed: string[],
  sourceRoot?: PinnedProjectRoot,
  trustedAnswerId?: string,
): { subject: SelectedSubjectResult | null; error?: string } {
  if (!pinnedRoot.isStable()) return { subject: null, error: "pinned project root changed before checkpoint preflight" };
  const workspace = state.specification;
  if (workspace && workspace.feature_id !== input.feature_id) return { subject: null, error: "selected specification workspace is unavailable or mismatched" };
  if (workspace && !isSafeFeatureId(input.feature_id)) return { subject: null, error: "feature_id is not a canonical safe feature id" };
  if (workspace?.source_kind === "external" && workspace.project_root_identity && (workspace.project_root_identity.dev !== pinnedRoot.dev || workspace.project_root_identity.ino !== pinnedRoot.ino || workspace.project_root_identity.canonical_path !== pinnedRoot.canonical_root)) {
    return { subject: null, error: "selected workspace project root identity changed" };
  }
  const imported = workspace ? selectedImportedIdentity(pinnedRoot, target, workspace, sourceRoot) : { identity: null };
  if (imported.error) return { subject: null, error: imported.error };
  const importIdentity = imported.identity;
  const native = workspace ? selectedNativePhaseIdentity(pinnedRoot, target, workspace, stage, trustedAnswerId) : { identity: null };
  if (native.error) return { subject: null, error: native.error };
  const nativeIdentity = native.identity;
  const revision = selectedStateRevision(state);
  const stateDigest = digestOf(selectedStableStateProjection(state));
  const loopIteration = selectedCurrentLoopIteration(state, profile, stage.id);
  const bindingPayload = {
    version: 1,
    feature_id: input.feature_id,
    run_key: input.run_key,
    branch: input.branch,
    workflow: input.workflow,
    // Imported subjects use the canonical profile identity so they remain
    // comparable after advance rotates the capability to the handoff stage.
    profile_hash: importIdentity ? profileHash(profile) : input.profile_hash,
    stage_cursor: input.stage_cursor,
    checkpoint: input.checkpoint,
    checkpoint_id: input.checkpoint_id,
    checkpoint_kind: rule.kind,
    cursor_epoch: input.cursor_epoch,
    capability_id: input.capability_id,
    ...(importIdentity ? {} : { state_digest: stateDigest }),
    root: { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    artifacts_dir: selectedArtifactDirectory(pinnedRoot, target),
    import: importIdentity,
    native: nativeIdentity,
  };
  return {
    subject: {
      binding: digestOf(bindingPayload),
      state_revision: revision,
      state_digest: stateDigest,
      loop_iteration: loopIteration,
      import_identity: importIdentity,
      native_identity: nativeIdentity,
    },
  };
}

/**
 * Resolve the exact native specification-phase subject used by selected Ask
 * proofs. Direct phase decisions use this same durable/artifact/validation
 * binding instead of trusting caller-supplied proof context.
 */
export interface NativePhaseCheckpointSubject {
  subject_binding: string;
  state_revision: number;
  state_digest: string;
}

export function resolveNativePhaseCheckpointSubject(
  cwd: string,
  input: { feature_id: string; run_key: string; phase: string; trusted_answer_id?: string },
): { ok: true; subject: NativePhaseCheckpointSubject } | { ok: false; error: string } {
  const ownsPinnedRoot = true;
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return { ok: false, error: "project root could not be pinned for native phase subject" };
  try {
    const target = resolveStatePinned(cwd, pinnedRoot, { feature_id: input.feature_id, run_key: input.run_key });
    if (target.invalid || !target.state) return { ok: false, error: "native phase subject state is unavailable or invalid" };
    const state = target.state;
    const workspace = state.specification;
    if (!workspace || !["native", "legacy"].includes(workspace.source_kind) || workspace.feature_id !== input.feature_id) {
      return { ok: false, error: "native phase subject workspace is unavailable or mismatched" };
    }
    const cap = activeCapability(state.dispatch_capability);
    if (!cap?.capability_id || !cap.issued_for) return { ok: false, error: "native phase subject capability is unavailable" };
    const profile = loadProfile(cap.issued_for.workflow);
    if (!profile) return { ok: false, error: "native phase subject workflow profile is unavailable" };
    const stage = profile.stages.find((candidate) => candidate.id === input.phase);
    if (!stage?.checkpoint) return { ok: false, error: "native phase subject stage/checkpoint is unavailable" };
    const policy = resolveCheckpointPolicy(stage, state);
    const rule = policy?.rules[stage.checkpoint];
    if (!policy || !rule) return { ok: false, error: "native phase subject checkpoint policy is unavailable" };
    if (state.stage_cursor !== input.phase || cap.issued_for.stage_cursor !== input.phase) {
      return { ok: false, error: "native phase subject stage cursor is stale or mismatched" };
    }
    const currentAnswers = (state.trusted_checkpoint_answers ?? []).filter((answer) =>
      !answer.consumed_at
      && answer.feature_id === input.feature_id
      && answer.run_id === (state.run_key ?? "")
      && answer.stage_id === input.phase
      && answer.checkpoint_id === stage.checkpoint,
    );
    const trustedAnswerId = input.trusted_answer_id ?? (currentAnswers.length === 1 ? currentAnswers[0]!.answer_id : undefined);
    const selectedInput: CheckpointAskSelectedRequest = {
      feature_id: input.feature_id,
      advance_token: "native-phase-subject",
      capability_id: cap.capability_id,
      run_key: input.run_key,
      branch: state.branch,
      workflow: cap.issued_for.workflow,
      profile_hash: cap.issued_for.profile_hash,
      stage_cursor: cap.issued_for.stage_cursor,
      cursor_epoch: cap.issued_for.cursor_epoch,
      checkpoint: stage.checkpoint,
      checkpoint_id: stage.checkpoint,
      checkpoint_kind: rule.kind,
    };
    const subjectResult = selectedSubjectForCheckpoint(pinnedRoot, state, target, selectedInput, stage, profile, policy, rule, rule.allowed_decisions, undefined, trustedAnswerId);
    if (subjectResult.error || !subjectResult.subject) return { ok: false, error: subjectResult.error ?? "native phase subject could not be derived" };
    let subjectRevision = subjectResult.subject.state_revision;
    if (input.trusted_answer_id) {
      const answer = (state.trusted_checkpoint_answers ?? []).find((candidate) => candidate.answer_id === input.trusted_answer_id && !candidate.consumed_at);
      if (answer?.subject_revision === subjectRevision - 1) subjectRevision = answer.subject_revision;
    }
    return { ok: true, subject: { subject_binding: subjectResult.subject.binding, state_revision: subjectRevision, state_digest: subjectResult.subject.state_digest } };
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}

/** Revalidate the exact imported subject bound to a historical approve_stop. */
export function validateStoppedImportedCheckpointBinding(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  stage: StageDef,
  decision: TypedCheckpointDecision,
): { ok: true } | { ok: false; error: string } {
  if (state.specification?.source_kind !== "external") return { ok: false, error: "stopped imported checkpoint requires an external workspace" };
  if (
    !decision.feature_id
    || !decision.capability_id
    || !decision.capability_epoch
    || !state.run_key
    || !stage.checkpoint
  ) return { ok: false, error: "stopped imported checkpoint subject binding is incomplete" };
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return { ok: false, error: "project root cannot be pinned to revalidate stopped imported checkpoint" };
  try {
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before stopped imported checkpoint revalidation" };
    const profile = loadProfile(state.classification?.workflow ?? "spec-import");
    if (!profile) return { ok: false, error: "spec-import profile is unavailable during stopped checkpoint revalidation" };
    const policy = resolveCheckpointPolicy(stage, state);
    if (!policy) return { ok: false, error: "stopped imported checkpoint policy is unavailable" };
    const rule = policy.rules[stage.checkpoint];
    if (!rule) return { ok: false, error: "stopped imported checkpoint rule is unavailable" };
    const allowed = rule.allowed_decisions.filter((value) => typeof value === "string" && value.trim().length > 0);
    const subject = selectedSubjectForCheckpoint(
      pinnedRoot,
      state,
      target,
      {
        feature_id: decision.feature_id,
        capability_id: decision.capability_id,
        run_key: state.run_key,
        branch: state.branch,
        workflow: state.classification?.workflow ?? "spec-import",
        profile_hash: profileHash(profile),
        stage_cursor: stage.id,
        cursor_epoch: decision.capability_epoch,
        checkpoint: stage.checkpoint,
        checkpoint_id: decision.checkpoint_id,
        checkpoint_kind: decision.checkpoint_kind,
        loop_iteration: decision.loop_iteration,
      },
      stage,
      profile,
      policy,
      rule,
      allowed,
    );
    if (subject.error || !subject.subject) return { ok: false, error: subject.error ?? "stopped imported checkpoint subject could not be revalidated" };
    if (!decision.subject_binding || decision.subject_binding !== subject.subject.binding) {
      return { ok: false, error: "stopped imported checkpoint subject binding is stale" };
    }
    return { ok: true };
  } finally {
    pinnedRoot.close();
  }
}

export function renderCheckpointCanonicalPacket(summary: CheckpointAskCanonicalSummary): string {
  const lines = [
    "CANONICAL CHECKPOINT PACKET (engine-authored; authoritative)",
    "feature_id: " + summary.feature_id,
    "run_key: " + summary.run_key,
    "branch: " + summary.branch,
    "workflow: " + summary.workflow,
    "profile_hash: " + summary.profile_hash,
    "stage_cursor: " + summary.stage_cursor,
    "checkpoint: " + summary.checkpoint,
    "checkpoint_id: " + summary.checkpoint_id,
    "checkpoint_kind: " + summary.checkpoint_kind,
    "cursor_epoch: " + summary.cursor_epoch,
    "capability_id: " + summary.capability_id,
    "policy_hash: " + summary.policy_hash,
    "allowed_decisions: [" + summary.allowed_decisions.join(", ") + "]",
    "loop_iteration: " + summary.loop_iteration,
    "snapshot_id: " + (summary.snapshot_id ?? "none"),
    "source_sha256: " + (summary.source_sha256 ?? "none"),
    "normalized_hash: " + (summary.normalized_hash ?? "none"),
    "constitution_content_sha256: " + (summary.constitution_content_sha256 ?? "none"),
    "compatibility_report_id: " + (summary.compatibility_report_id ?? "none"),
    "source_root: " + (summary.source_root ?? "none"),
    "source_root_dev: " + (summary.source_root_dev ?? "none"),
    "source_root_ino: " + (summary.source_root_ino ?? "none"),
    "subject_binding: " + summary.subject_binding,
    "END CANONICAL CHECKPOINT PACKET",
  ];
  return lines.join("\r\n");
}

function checkpointAskSelectedContextFor(
  state: TeamState,
  target: ResolvedState,
  input: CheckpointAskSelectedRequest,
  pinnedRoot: PinnedProjectRoot,
  sourceRoot?: PinnedProjectRoot,
): CheckpointAskSelectedPreflight {
  if (!isSafeFeatureId(input.feature_id)) return { ok: false, error: "an explicit bounded safe feature_id is required" };
  if (!selectedBoundedString(input.run_key) || !selectedBoundedString(input.branch) || !selectedBoundedString(input.workflow) || !selectedBoundedString(input.profile_hash) || !selectedBoundedString(input.stage_cursor) || !selectedBoundedString(input.cursor_epoch) || !selectedBoundedString(input.capability_id)) return { ok: false, error: "selected checkpoint identity fields must be bounded line-inert strings" };
  if (!selectedBoundedString(input.checkpoint, 256) || !selectedBoundedString(input.checkpoint_id, 256)) return { ok: false, error: "checkpoint and checkpoint_id must be bounded line-inert strings" };
  if (!selectedBoundedString(input.checkpoint_kind, 128)) return { ok: false, error: "checkpoint_kind must be a bounded line-inert string" };
  if (input.loop_iteration !== undefined && (!Number.isSafeInteger(input.loop_iteration) || input.loop_iteration < 1 || input.loop_iteration > MAX_SELECTED_LOOP_ITERATION)) {
    return { ok: false, error: "loop_iteration must be a bounded positive integer" };
  }
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable" };
  const selectedToken = selectedAdvanceToken(input);
  if (!selectedToken) return { ok: false, error: "advance_token is required and must not conflict with legacy token" };
  const authError = auth(cap, { ...input, token: selectedToken }, cap.advance_token_hash);
  if (authError) return { ok: false, error: authError };
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated" };
  if (
    state.run_key !== input.run_key
    || state.branch !== input.branch
    || state.classification?.workflow !== input.workflow
    || state.stage_cursor !== input.stage_cursor
    || state.cursor_epoch !== input.cursor_epoch
    || (state.profile_hash !== undefined && state.profile_hash !== cap.issued_for.profile_hash)
  ) return { ok: false, error: "workflow state and capability binding mismatch" };
  const profile = loadProfile(cap.issued_for.workflow);
  if (!profile) return { ok: false, error: `workflow '${cap.issued_for.workflow}' is unavailable` };
  if (profileHash(profile) !== cap.issued_for.profile_hash) return { ok: false, error: "workflow profile hash drifted from the capability binding" };
  const stage = profile.stages.find((candidate) => candidate.id === cap.issued_for.stage_cursor);
  if (!stage?.checkpoint) return { ok: false, error: `stage '${cap.issued_for.stage_cursor}' declares no checkpoint` };
  if (input.checkpoint !== stage.checkpoint || input.checkpoint_id !== input.checkpoint) {
    return { ok: false, error: `checkpoint '${input.checkpoint}' does not match declared checkpoint '${stage.checkpoint}'` };
  }
  const policy = resolveCheckpointPolicy(stage, state);
  if (!policy) return { ok: false, error: `checkpoint '${input.checkpoint}' has no policy` };
  const rule = policy.rules[input.checkpoint];
  if (!rule) return { ok: false, error: `checkpoint policy has no rule for '${input.checkpoint}'` };
  if (input.checkpoint_kind !== rule.kind) return { ok: false, error: `checkpoint kind '${input.checkpoint_kind}' does not match policy kind '${rule.kind}'` };
  const allowed = rule.allowed_decisions.filter((decision) => typeof decision === "string" && decision.trim().length > 0);
  if (allowed.length === 0) return { ok: false, error: `checkpoint '${input.checkpoint}' policy allows no decisions` };
  if (allowed.length > 256 || allowed.some((decision) => !selectedBoundedString(decision, 256))) return { ok: false, error: "checkpoint policy decision bound exceeded" };
  if (typeof input.question === "string" && input.question.length > 2048) return { ok: false, error: "question exceeds the bounded selected-ask limit" };
  const workspace = state.specification;
  if (workspace && (workspace.source_kind === "native" || workspace.source_kind === "legacy" || workspace.source_kind === "external")) {
    const constitutionError = workspaceConstitutionError(pinnedRoot, workspace);
    if (constitutionError) return { ok: false, error: constitutionError };
  }
  const subjectResult = selectedSubjectForCheckpoint(pinnedRoot, state, target, input, stage, profile, policy, rule, allowed, sourceRoot);
  if (subjectResult.error || !subjectResult.subject) return { ok: false, error: subjectResult.error ?? "selected checkpoint subject could not be bound" };
  if (workspace && (workspace.source_kind === "native" || workspace.source_kind === "legacy" || workspace.source_kind === "external")) {
    const constitutionError = workspaceConstitutionError(pinnedRoot, workspace);
    if (constitutionError) return { ok: false, error: constitutionError };
  }
  if (input.loop_iteration !== undefined && input.loop_iteration !== subjectResult.subject.loop_iteration) {
    return { ok: false, error: `loop_iteration ${input.loop_iteration} does not match current loop iteration ${subjectResult.subject.loop_iteration}` };
  }
  const subject = subjectResult.subject;
  const importIdentity = subject.import_identity;
  const canonical_summary: CheckpointAskCanonicalSummary = {
    feature_id: input.feature_id,
    run_key: input.run_key,
    branch: input.branch,
    workflow: input.workflow,
    profile_hash: input.profile_hash,
    stage_cursor: input.stage_cursor,
    checkpoint: input.checkpoint,
    checkpoint_id: input.checkpoint_id,
    checkpoint_kind: rule.kind,
    cursor_epoch: input.cursor_epoch,
    capability_id: input.capability_id,
    policy_hash: checkpointPolicyHash(policy),
    allowed_decisions: [...allowed],
    loop_iteration: subject.loop_iteration,
    snapshot_id: importIdentity?.snapshot_id ?? null,
    source_sha256: importIdentity?.source_sha256 ?? null,
    normalized_hash: importIdentity?.normalized_hash ?? null,
    constitution_content_sha256: importIdentity?.constitution_content_sha256 ?? null,
    compatibility_report_id: importIdentity?.compatibility_report_id ?? null,
    source_root: importIdentity?.source_root ?? null,
    source_root_dev: importIdentity?.source_root_dev ?? null,
    source_root_ino: importIdentity?.source_root_ino ?? null,
    subject_binding: subject.binding,
  };
  return { ok: true, context: { state, target, stage, policy, rule, allowed, loop_iteration: subject.loop_iteration, subject_binding: subject.binding, native_identity: subject.native_identity, state_revision: subject.state_revision, state_digest: subject.state_digest, ...(importIdentity ? { external_source_root: { canonical_path: importIdentity.source_root, dev: importIdentity.source_root_dev, ino: importIdentity.source_root_ino } } : {}), canonical_summary } };
}

/** Validate the exact selected feature/run snapshot before displaying UI. */
export interface CheckpointAskSelectedValidationOptions {
  pinnedRoot?: PinnedProjectRoot;
}

export function validateCheckpointAskSelected(
  cwd: string,
  input: CheckpointAskSelectedRequest,
  options: CheckpointAskSelectedValidationOptions = {},
): CheckpointAskSelectedPreflight {
  if (!isSafeFeatureId(input.feature_id) || !selectedBoundedString(input.run_key)) {
    return { ok: false, error: "an explicit safe feature_id and nonblank run_key selector are required" };
  }
  const ownsPinnedRoot = options.pinnedRoot === undefined;
  const pinnedRoot = options.pinnedRoot ?? PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return { ok: false, error: "current project root could not be pinned for checkpoint preflight" };
  try {
    const target = resolveStatePinned(cwd, pinnedRoot, { feature_id: input.feature_id, run_key: input.run_key });
    if (target.invalid) return { ok: false, error: "workflow state is invalid or unsafe" };
    if (!target.state) return { ok: false, error: "workflow state not found" };
    return checkpointAskSelectedContextFor(target.state, target, input, pinnedRoot);
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}

export type CheckpointAnswerSelectedCommitResult =
  | {
      ok: true;
      outcome: "minted" | "already_recorded";
      decision: string;
      checkpoint_kind: string;
      allowed: string[];
      answer: TrustedCheckpointAnswer | null;
      proof: CheckpointAnswerProof | null;
      /** True when this commit also appended the typed checkpoint decision. */
      applied?: boolean;
      persisted_decision?: TypedCheckpointDecision;
      state: TeamState;
    }
  | { ok: false; kind: "rejected" | "stale"; code: string; error: string };

type SelectedAskMutation = CheckpointAnswerSelectedCommitResult & { state?: TeamState };

/**
 * Mint one trusted answer against the lock-protected selected state. When
 * apply_decision is enabled, the same compare-and-swap also applies that
 * answer through the typed checkpoint mutation; a cursor/capability/policy
 * move cannot mint stale authority or write to another active feature.
 */
export interface CheckpointAskSelectedCommitOptions {
  pinnedRoot?: PinnedProjectRoot;
  /** Apply the trusted answer through the checkpoint mutation in this same CAS transaction. */
  apply_decision?: boolean;
  /** Optional descriptor pinned to an external import source root. */
  sourceRoot?: PinnedProjectRoot;
  expected_subject_binding?: string;
  expected_state_revision?: number;
  expected_state_digest?: string;
  /** Runtime-only authority returned by the mounted host Ask tool. */
  trusted_answer_capability?: TrustedCheckpointAnswerCapability;
  trusted_answer_id?: string;
}


type NativeSelectedAnswerReplay =
  | { kind: "match"; value: CheckpointAnswerSelectedCommitResult }
  | { kind: "reject"; error: string }
  | null;

/**
 * Revalidate an already-applied native selected answer without reopening the
 * pre-answer awaiting_approval subject. The atomic Ask projects native phase
 * state immediately, so the ordinary preflight intentionally rejects a
 * second read; this path accepts only one exact, user-attributed persisted
 * decision whose current artifact, validation, policy, and phase projection
 * still match byte-for-byte.
 */
function nativeSelectedAnswerReplay(
  state: TeamState,
  target: ResolvedState,
  pinnedRoot: PinnedProjectRoot,
  input: CheckpointAskSelectedRequest & { decision: string; feedback?: string },
  cap: ActiveCapability,
): NativeSelectedAnswerReplay {
  const workspace = state.specification;
  if (workspace && (workspace.source_kind === "native" || workspace.source_kind === "legacy" || workspace.source_kind === "external")) {
    const constitutionError = workspaceConstitutionError(pinnedRoot, workspace);
    if (constitutionError) return { kind: "reject", error: "checkpoint_invalid: " + constitutionError };
  }
  if (workspace?.source_kind !== "native" || !["specify", "plan", "tasks"].includes(input.stage_cursor)) return null;
  const phase = input.stage_cursor as "specify" | "plan" | "tasks";
  const record = workspace.phases.find((candidate) => candidate.phase === phase);
  if (record?.status !== "approved" && record?.status !== "revision_required") return null;
  const profile = loadProfile(cap.issued_for.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === phase);
  if (!profile || !stage?.checkpoint || input.checkpoint !== stage.checkpoint || input.checkpoint_id !== stage.checkpoint || input.checkpoint_kind !== (resolveCheckpointPolicy(stage, state)?.rules[stage.checkpoint]?.kind ?? "")) {
    return { kind: "reject", error: "checkpoint_invalid: native selected answer replay stage or policy identity is stale" };
  }
  const typed = (state.typed_checkpoint_decisions ?? []).filter((candidate) =>
    candidate.stage_id === phase && candidate.checkpoint_id === stage.checkpoint,
  );
  if (typed.length !== 1) return { kind: "reject", error: "checkpoint_invalid: native selected answer replay is missing or has duplicate typed decisions" };
  const decision = typed[0]!;
  const answerId = decision.actor.proof?.answer_id;
  const answer = answerId ? (state.trusted_checkpoint_answers ?? []).find((candidate) => candidate.answer_id === answerId) : undefined;
  const policy = resolveCheckpointPolicy(stage, state);
  const rule = policy?.rules[stage.checkpoint];
  if (!policy || !rule || !answer || answer.consumed_at === undefined || decision.actor.kind !== "user" || decision.actor.ref !== answer.reference || decision.authorization !== "human" || decision.run_id !== state.run_key || decision.feature_id !== workspace.feature_id || decision.capability_id !== cap.capability_id || decision.capability_epoch !== cap.issued_for.cursor_epoch || decision.policy_hash !== checkpointPolicyHash(policy) || answer.run_id !== state.run_key || answer.stage_id !== phase || answer.checkpoint_id !== stage.checkpoint || answer.capability_id !== cap.capability_id || answer.capability_epoch !== cap.issued_for.cursor_epoch || answer.policy_hash !== checkpointPolicyHash(policy) || answer.feature_id !== workspace.feature_id || answer.decision !== input.decision || decision.decision !== input.decision || answer.feedback !== input.feedback || (input.decision === "request_changes" ? decision.rationale !== input.feedback : decision.rationale !== "trusted selected checkpoint answer")) {
    return { kind: "reject", error: "checkpoint_invalid: native selected answer replay proof or applied decision does not match current state" };
  }
  if (answer.binding !== checkpointAnswerBinding(answer)) return { kind: "reject", error: "checkpoint_invalid: native selected answer replay proof binding is invalid" };
  const authorityError = trustedCheckpointAnswerError(state, {
    actor: decision.actor,
    run_id: decision.run_id,
    stage_id: decision.stage_id,
    checkpoint_id: decision.checkpoint_id,
    decision: decision.decision,
    capability_id: decision.capability_id,
    capability_epoch: decision.capability_epoch,
    policy_hash: decision.policy_hash,
    feature_id: decision.feature_id,
    loop_iteration: decision.loop_iteration,
    subject_binding: decision.subject_binding,
    root_identity: { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    bind_active_context: true,
    feedback: decision.decision === "request_changes" ? decision.rationale : undefined,
  });
  if (authorityError) return { kind: "reject", error: "checkpoint_invalid: native selected answer replay authority is invalid: " + authorityError };
  const ready = canonicalPhaseArtifactReady(state, target, pinnedRoot, stage);
  if (!ready) return { kind: "reject", error: "checkpoint_invalid: native selected answer replay artifact or validation is stale" };
  const version = record.current_version;
  const artifactsDir = artifactsRelativeFor(pinnedRoot, target);
  const artifact = version === null ? null : readCanonicalPhaseArtifact(pinnedRoot.canonical_root, { feature_id: workspace.feature_id, run_key: state.run_key!, phase, version }, pinnedRoot);
  const validationRef = version === null ? null : `validation.${phase}.v${version}`;
  const validation = artifactsDir && validationRef ? readArtifactPinned<Record<string, unknown>>(pinnedRoot, artifactsDir, validationRef) : null;
  if (!artifact || !validation || validationRef === null || decision.artifact_id !== artifact.artifact_id || decision.artifact_version !== version || decision.artifact_digest !== digestOf(artifact) || decision.validation_ref !== validationRef || decision.validation_digest !== digestOf(validation)) {
    return { kind: "reject", error: "checkpoint_invalid: native selected answer replay draft or validation digest is stale" };
  }
  const expectedStatus = input.decision === "request_changes" ? "revision_required" : "approved";
  if (record.status !== expectedStatus || state.stage_cursor !== phase || cap.issued_for.stage_cursor !== phase || state.cursor_epoch !== cap.issued_for.cursor_epoch) {
    return { kind: "reject", error: "checkpoint_invalid: native selected answer replay resulting phase or cursor identity is stale" };
  }
  const proof = decision.actor.proof!;
  const exactProof = proof.answer_id === answer.answer_id
    && proof.nonce === answer.nonce
    && proof.channel === answer.channel
    && proof.reference === answer.reference
    && proof.binding === answer.binding
    && proof.feedback === answer.feedback;
  if (!exactProof) return { kind: "reject", error: "checkpoint_invalid: native selected answer replay proof is partial or tampered" };
  return {
    kind: "match",
    value: {
      ok: true,
      outcome: "already_recorded",
      decision: decision.decision,
      checkpoint_kind: rule.kind,
      allowed: [...rule.allowed_decisions],
      answer,
      proof,
      applied: true,
      persisted_decision: decision,
      state,
    },
  };
}

export function commitCheckpointAnswerSelected(
  cwd: string,
  input: CheckpointAskSelectedRequest & { decision: string; feedback?: string },
  options: CheckpointAskSelectedCommitOptions = {},
): CheckpointAnswerSelectedCommitResult {
  if (!options.trusted_answer_capability || !options.trusted_answer_id) {
    return { ok: false, kind: "rejected", code: "recovery_required", error: "checkpoint recovery_required: only the trusted host Ask may mint a selected checkpoint answer" };
  }
  if (!isSafeFeatureId(input.feature_id) || !selectedBoundedString(input.run_key)) {
    return { ok: false, kind: "rejected", code: "selector_invalid", error: "an explicit safe feature_id and nonblank run_key selector are required" };
  }
  if (!selectedBoundedString(input.decision, 256)) return { ok: false, kind: "rejected", code: "decision_invalid", error: "selected checkpoint decision must be a bounded line-inert string" };
  const selectedFeedback = input.feedback;
  if (input.decision === "request_changes" && (selectedFeedback === undefined
    || selectedFeedback !== selectedFeedback.trim()
    || !isBoundedLineInert(selectedFeedback, MAX_CHECKPOINT_RATIONALE_BYTES))) {
    return { ok: false, kind: "rejected", code: "feedback_required", error: "request_changes requires non-empty bounded trusted feedback without surrounding whitespace" };
  }
  if (input.decision !== "request_changes" && input.feedback !== undefined) {
    return { ok: false, kind: "rejected", code: "feedback_invalid", error: "feedback is only valid for request_changes" };
  }
  const ownsPinnedRoot = options.pinnedRoot === undefined;
  const pinnedRoot = options.pinnedRoot ?? PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return { ok: false, kind: "rejected", code: "state_invalid", error: "current project root could not be pinned for state transaction" };
  let preCommitWorkspace: FeatureWorkspace | undefined;
  try {
    const result = updateStateAtomically<SelectedAskMutation>(
      cwd,
      (snapshot: StateSnapshot): StateMutation<SelectedAskMutation> => {
        if (!snapshot.state) return { op: "fail", code: "state_missing", error: "workflow state not found" };
        if (snapshot.target.isStale) return { op: "discard", value: { ok: false, kind: "stale", code: "state_stale", error: "workflow state is stale for the selected feature/run" } };
        const expectedRunId = selectedExpectedRunId(snapshot.state);
        const replayCap = activeCapability(snapshot.state.dispatch_capability);
        const replayToken = selectedAdvanceToken(input);
        if (replayCap && replayToken && !auth(replayCap, { ...input, token: replayToken }, replayCap.advance_token_hash)) {
          const replay = nativeSelectedAnswerReplay(snapshot.state, snapshot.target, pinnedRoot, input, replayCap);
          if (replay?.kind === "reject") return { op: "discard", value: { ok: false, kind: "rejected", code: "checkpoint_invalid", error: replay.error } };
          if (replay?.kind === "match") return { op: "discard", value: replay.value };
        }
        const preflight = checkpointAskSelectedContextFor(snapshot.state, snapshot.target, input, pinnedRoot, options.sourceRoot);
        if (!preflight.ok) return { op: "discard", value: { ok: false, kind: "rejected", code: "checkpoint_invalid", error: preflight.error } };
        const { stage, rule, allowed, subject_binding, native_identity, state_revision, state_digest, loop_iteration } = preflight.context;
        const selectedToken = selectedAdvanceToken(input);
        if (!selectedToken) return { op: "discard", value: { ok: false, kind: "rejected", code: "token_invalid", error: "advance_token is required and must not conflict with legacy token" } };
        const applySelectedAnswer = (answerState: TeamState, answer: TrustedCheckpointAnswer, proof: CheckpointAnswerProof) => recordCheckpointDecisionMutation(cwd, answerState, snapshot.target, pinnedRoot, {
          ...input,
          token: undefined,
          advance_token: selectedToken,
          checkpoint_id: input.checkpoint,
          checkpoint_kind: rule.kind,
          authorization: "human",
          actor_provenance: { kind: "user", ref: answer.reference, proof },
          decision: answer.decision,
          rationale: answer.decision === "request_changes" ? (answer.feedback ?? "") : "trusted selected checkpoint answer",
          evidence: "checkpoint-answer:" + answer.answer_id,
          loop_iteration,
          subject_binding,
        }, true, true);
        if (!pinnedRoot.isStable()) return { op: "discard", value: { ok: false, kind: "stale", code: "root_changed", error: "pinned project root changed after checkpoint preflight" } };
        if (options.expected_subject_binding !== undefined && options.expected_subject_binding !== subject_binding) return { op: "discard", value: { ok: false, kind: "stale", code: "subject_stale", error: "checkpoint subject changed after UI preflight" } };
        if (options.expected_state_revision !== undefined && options.expected_state_revision !== state_revision) return { op: "discard", value: { ok: false, kind: "stale", code: "state_stale", error: "workflow state revision changed after UI preflight" } };
        if (options.expected_state_digest !== undefined && options.expected_state_digest !== state_digest) return { op: "discard", value: { ok: false, kind: "stale", code: "state_stale", error: "workflow state subject changed after UI preflight" } };
        const currentWorkspace = snapshot.state.specification;
        preCommitWorkspace = currentWorkspace;
        if (currentWorkspace && (currentWorkspace.source_kind === "native" || currentWorkspace.source_kind === "legacy" || currentWorkspace.source_kind === "external")) {
          const constitutionError = workspaceConstitutionError(pinnedRoot, currentWorkspace);
          if (constitutionError) return { op: "discard", value: { ok: false, kind: "stale", code: "constitution_stale", error: constitutionError } };
        }
        const existing = findCheckpointDecision(snapshot.state, stage.id, input.checkpoint);
        const existingNativeMatches = native_identity === null
          ? existing?.artifact_id === undefined
            && existing?.artifact_version === undefined
            && existing?.artifact_digest === undefined
            && existing?.validation_ref === undefined
            && existing?.validation_digest === undefined
          : existing?.artifact_id === native_identity.artifact_id
            && existing?.artifact_version === native_identity.artifact_version
            && existing?.artifact_digest === native_identity.artifact_digest
            && existing?.validation_ref === native_identity.validation_ref
            && existing?.validation_digest === native_identity.validation_digest;
        const existingMatchesCurrentSubject = existing !== null
          && existing.feature_id === input.feature_id
          && existing.loop_iteration === loop_iteration
          && existing.subject_binding === subject_binding
          && existingNativeMatches;
        const unconsumed = (snapshot.state.trusted_checkpoint_answers ?? []).find((answer) =>
          !answer.consumed_at
          && answer.feature_id === input.feature_id
          && answer.run_id === expectedRunId
          && answer.stage_id === stage.id
          && answer.checkpoint_id === input.checkpoint
          && answer.capability_id === input.capability_id
          && answer.loop_iteration === loop_iteration
          && answer.subject_binding === subject_binding,
        );
        if (unconsumed && (unconsumed.decision !== input.decision || unconsumed.feedback !== selectedFeedback)) {
          return { op: "discard", value: { ok: false, kind: "rejected", code: "duplicate_conflict", error: "a contradictory unconsumed checkpoint answer already exists" } };
        }
        if (existingMatchesCurrentSubject && (existing.decision !== input.decision || (existing.decision === "request_changes" && existing.rationale !== selectedFeedback))) {
          return { op: "discard", value: { ok: false, kind: "rejected", code: "duplicate_conflict", error: "a contradictory checkpoint decision already exists" } };
        }
        if (existingMatchesCurrentSubject || unconsumed) {
          const existingProof = (existingMatchesCurrentSubject ? existing?.actor_provenance?.proof : undefined) ?? (unconsumed ? {
            answer_id: unconsumed.answer_id,
            nonce: unconsumed.nonce,
            channel: unconsumed.channel,
            reference: unconsumed.reference,
            binding: unconsumed.binding,
            ...(unconsumed.feedback !== undefined ? { feedback: unconsumed.feedback } : {}),
          } : null);
          const existingAnswer = existingProof
            ? (snapshot.state.trusted_checkpoint_answers ?? []).find((answer) => answer.answer_id === existingProof.answer_id) ?? null
            : null;
          if (existingAnswer && existingProof) {
            const authorityError = trustedCheckpointAnswerError(snapshot.state, {
              actor: { kind: "user", ref: existingAnswer.reference, proof: existingProof },
              run_id: expectedRunId,
              stage_id: stage.id,
              checkpoint_id: input.checkpoint,
              decision: existingAnswer.decision,
              capability_id: existingAnswer.capability_id,
              capability_epoch: existingAnswer.capability_epoch,
              policy_hash: existingAnswer.policy_hash,
              feature_id: existingAnswer.feature_id,
              loop_iteration: existingAnswer.loop_iteration,
              subject_binding: existingAnswer.subject_binding,
              root_identity: { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
              bind_active_context: true,
              feedback: existingAnswer.decision === "request_changes" ? existingAnswer.feedback : undefined,
            });
            if (authorityError) return { op: "discard", value: { ok: false, kind: "rejected", code: "checkpoint_invalid", error: "selected checkpoint answer authority is invalid: " + authorityError } };
          }
          if (options.apply_decision && !existingMatchesCurrentSubject && existingAnswer && existingProof) {
            const applied = applySelectedAnswer(snapshot.state, existingAnswer, existingProof);
            if (!applied.ok) return { op: "discard", value: { ok: false, kind: "rejected", code: "checkpoint_invalid", error: applied.error ?? "selected checkpoint decision could not be applied" } };
            const appliedState = applied.state ?? snapshot.state;
            const persisted = (appliedState.typed_checkpoint_decisions ?? []).find((candidate) => candidate.stage_id === stage.id
              && candidate.checkpoint_id === input.checkpoint
              && candidate.actor.proof?.answer_id === existingAnswer.answer_id);
            const value: SelectedAskMutation = {
              ok: true,
              outcome: "already_recorded",
              decision: existingAnswer.decision,
              checkpoint_kind: rule.kind,
              allowed,
              answer: existingAnswer,
              proof: existingProof,
              applied: true,
              ...(persisted ? { persisted_decision: persisted } : {}),
              state: appliedState,
            };
            return { op: "commit", state: appliedState, value };
          }
          const persisted = existingMatchesCurrentSubject
            ? (snapshot.state.typed_checkpoint_decisions ?? []).find((candidate) => candidate.stage_id === stage.id
              && candidate.checkpoint_id === input.checkpoint
              && candidate.feature_id === input.feature_id
              && candidate.subject_binding === subject_binding
              && candidate.loop_iteration === loop_iteration)
            : undefined;
          const value: SelectedAskMutation = {
            ok: true,
            outcome: "already_recorded",
            decision: existingMatchesCurrentSubject ? existing!.decision : (unconsumed?.decision ?? input.decision),
            checkpoint_kind: rule.kind,
            allowed,
            answer: existingAnswer,
            proof: existingProof,
            ...(options.apply_decision && existingMatchesCurrentSubject ? { applied: true } : {}),
            ...(persisted ? { persisted_decision: persisted } : {}),
            state: snapshot.state,
          };
          return { op: "discard", value };
        }
        if (!input.decision || !allowed.includes(input.decision)) {
          return { op: "discard", value: { ok: false, kind: "rejected", code: "policy_invalid", error: "the selected label is not a policy-allowed decision" } };
        }
        const answerId = options.trusted_answer_id!;
        const recorded = recordTrustedCheckpointAnswer(snapshot.state, {
          answer_id: answerId,
          channel: "terminal",
          reference: `terminal:workflow_checkpoint_ask_selected:${answerId}`,
          stage_id: stage.id,
          checkpoint_id: input.checkpoint,
          decision: input.decision,
          feature_id: input.feature_id,
          loop_iteration,
          subject_binding,
          subject_revision: state_revision + 1,
          ...(selectedFeedback !== undefined ? { feedback: selectedFeedback } : {}),
        }, {
          capability: options.trusted_answer_capability!,
          root: { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
        });
        let finalState = recorded.state;
        let appliedDecision: TypedCheckpointDecision | undefined;
        if (options.apply_decision) {
          const applied = applySelectedAnswer(recorded.state, recorded.answer, recorded.proof);
          if (!applied.ok) return { op: "discard", value: { ok: false, kind: "rejected", code: "checkpoint_invalid", error: applied.error ?? "selected checkpoint decision could not be applied" } };
          finalState = applied.state ?? recorded.state;
          appliedDecision = (finalState.typed_checkpoint_decisions ?? []).find((candidate) =>
            candidate.stage_id === stage.id
            && candidate.checkpoint_id === input.checkpoint
            && candidate.actor.proof?.answer_id === recorded.answer.answer_id,
          );
        }
        const value: SelectedAskMutation = {
          ok: true,
          outcome: "minted",
          decision: input.decision,
          checkpoint_kind: rule.kind,
          allowed,
          answer: recorded.answer,
          proof: recorded.proof,
          ...(options.apply_decision ? { applied: true } : {}),
          ...(appliedDecision ? { persisted_decision: appliedDecision } : {}),
          state: finalState,
        };
        return { op: "commit", state: finalState, value };
      },
      {
        selector: { feature_id: input.feature_id, run_key: input.run_key },
        pinnedRoot,
        preCommit: () => {
          if (preCommitWorkspace && (preCommitWorkspace.source_kind === "native" || preCommitWorkspace.source_kind === "legacy" || preCommitWorkspace.source_kind === "external")) {
            const constitutionError = workspaceConstitutionError(pinnedRoot, preCommitWorkspace);
            if (constitutionError) throw new Error(constitutionError);
          }
        },
      },
    );
    if (!result.ok) return { ok: false, kind: "rejected", code: result.code, error: result.error };
    if (!result.value) return { ok: false, kind: "rejected", code: "state_invalid", error: "state transaction completed without a result" };
    if (!result.value.ok) return result.value;
    if (result.committed && result.state) {
      // Retire the one-time host authority only after updateStateAtomically
      // has durably published the selected answer postimage. Validation,
      // discarded mutations, CAS conflicts, and aborted WALs retain it for
      // an authenticated retry.
      if (result.value.answer) retireTrustedCheckpointAnswer(result.value.answer.answer_id);
      return { ...result.value, state: result.state };
    }
    return result.value;
  } catch (error) {
    return { ok: false, kind: "rejected", code: "checkpoint_failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}

export function reconcileTaskResult(cwd: string, input: ReconcileTaskResultInput): TransitionResult {
  if (!input.dispatch_id && !input.tool_call_id) return { ok: false, error: "dispatch identity required" };
  if (!input.token) return { ok: false, error: "dispatch token required" };
  let preCommitConstitutionGuard: (() => void) | undefined;
  return runDurableTransaction(cwd, {}, (state, target, pinnedRoot) => {
    const workspace = state.specification;
    if (workspace && (workspace.source_kind === "native" || workspace.source_kind === "legacy" || workspace.source_kind === "external")) {
      preCommitConstitutionGuard = () => {
        const error = workspaceConstitutionError(pinnedRoot, workspace);
        if (error) throw new Error(error);
      };
      try { preCommitConstitutionGuard(); } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), state };
      }
    }
    return reconcileTaskResultMutation(cwd, state, target, pinnedRoot, input, preCommitConstitutionGuard);
  }, { preCommit: () => { preCommitConstitutionGuard?.(); } });
}

function reconcileTaskResultMutation(cwd: string, state: TeamState, target: ResolvedState, pinnedRoot: PinnedProjectRoot, input: ReconcileTaskResultInput, beforeArtifactWrite?: () => void): TransitionResult {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  if (cap.capability_id !== input.capability_id || (input.cursor_epoch && cap.issued_for.cursor_epoch !== input.cursor_epoch)) {
    return { ok: false, error: "capability binding mismatch", state };
  }
  const authError = auth(cap, {
    token: input.token!,
    capability_id: input.capability_id,
    run_key: cap.issued_for.run_key,
    branch: cap.issued_for.branch,
    workflow: cap.issued_for.workflow,
    profile_hash: cap.issued_for.profile_hash,
    stage_cursor: cap.issued_for.stage_cursor,
    cursor_epoch: cap.issued_for.cursor_epoch,
  }, cap.dispatch_token_hash);
  if (authError) return { ok: false, error: authError, state };
  const records = cap.dispatches.filter((record) =>
    !record.completion
    && (input.dispatch_id ? record.id === input.dispatch_id : record.tool_call_id === input.tool_call_id)
    && (!input.slot_id || input.slot_id === record.role || input.slot_id === record.work_identity?.slot_id)
    && (!input.task_id || input.task_id === record.work_identity?.task_id),
  );
  if (records.length !== 1) return { ok: false, error: records.length === 0 ? "unknown dispatch" : "ambiguous positional result", state };
  const record = records[0];
  if (!record) return { ok: false, error: "dispatch result identity disappeared", state };
  const asyncState = input.details?.async?.state;
  const remainsPending = asyncState === "running" || asyncState === "spawned" || asyncState === "scheduled" || (!input.output && !input.isError);
  if (remainsPending) {
    try { beforeArtifactWrite?.(); } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), state };
    }
    return pendingRecord(cwd, state, target, cap, record, "provider_running", input.details?.async?.provider_ref ?? asyncState);
  }
  const evidence = input.output?.trim() || (input.isError ? "task failed" : "");
  return completeRecord(cwd, state, target, pinnedRoot, cap, record, {
    outcome: input.isError ? "failed" : "succeeded",
    evidence,
    completed_by: "synchronous_tool_result",
  }, beforeArtifactWrite);
}
