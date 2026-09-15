/**
 * Capability-bound native Specify → Plan → Tasks lifecycle (T029).
 *
 * The durable engine remains the only capability/dispatch ledger. This module
 * owns only immutable specification versions and the corresponding aggregate
 * projection; it does not introduce a second state machine or renderer.
 */
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { CheckpointDecisionInput, DispatchAuth, RosterBeginSelection, TransitionResult, TrustedMappingProof, NativePreparationSource } from "../engine/durable.js";
import {
  authorizeSpecificationPhaseDispatchWithMutation,
  authorizeSpecificationPhaseValidationDispatch,
  beginCapability,
  issueCurrentTrustedMappingProof,
  resumeNativeSpecificationValidationFromPersisted,
  reissueNativePreparationBegin,
  completeNativeSpecificationGeneration,
  consumeSpecificationPhaseValidationDispatch,
  createCapability,
  resolveSpecificationPhaseDispatch,
  finalizeNativeImplementationHandoffMutation,
  projectNativeSpecificationPhaseDecision,
  reissueNativeSpecificationCheckpointCapability,
  resolveNativePhaseCheckpointSubject,
} from "../engine/durable.js";
import {
  appendCheckpointDecision,
  checkpointDecisionEffect,
  checkpointPolicyHash,
  nativeCheckpointPolicy,
  resolveCheckpointPolicy,
  trustedCheckpointAnswerError,
} from "../engine/checkpoints.js";
import { isBoundedLineInert, MAX_CHECKPOINT_RATIONALE_BYTES } from "../engine/durable.js";
import { resolveActiveBranch, resolveState, resolveStatePinned, updateStateAtomically, type StateSnapshot } from "../engine/state.js";
import type { CheckpointActor, DispatchRecord, TeamState, TypedCheckpointDecision, WorkIdentity } from "../engine/types.js";
import { PinnedProjectRoot, PinnedRootError, type PinnedRootFileExpectation, type PinnedRootWriteDescriptor, type PinnedRootWritePreimage, type PinnedRootWriteReceipt } from "./pinned-root.js";
import {
  materializeFeatureDocumentsUnderStateLock,
  materializePhaseValidationPinned,
  phaseValidationProjectionMatchesPinned,
  revalidateMaterializedDocuments,
  revalidateMaterializedDocumentsPinned,
  type MaterializeOutcome,
  type MaterializedDocumentRequest,
} from "./materialize.js";
import type {
  ConstitutionBinding,
  FeatureWorkspace,
  PhaseArtifactVersion,
  PhaseUpstreamVersionBinding,
  WorkspacePhase,
  WorkspacePhaseRecord,
  PhaseValidationResult,
  SpecificationSemanticModel,
  SpecifySemanticSections,
  PlanSemanticSections,
  ImplementationHandoff,
  HandoffRequirement,
  HandoffDecision,
  ImplementationTask,
  HandoffVerification,
  TemplateSelection,
} from "./types.js";
import {
  resolveFeatureWorkspace,
  normalizeWorkspaceToV3ForTransaction,
} from "./workspace.js";
import { readMigrationReceiptPinned, type WorkspaceRootSnapshot } from "./migration.js";
import { prepareNativePhaseValidation, validateNativePhase, type NativePhaseValidationInput, type NativeValidationPreparation } from "./validation.js";
import { loadSpecificationPresentationConfig } from "./presentation-config.js";
import { resolveSpecificationTemplateSet, SHIPPED_SPECIFICATION_TEMPLATE_IDS, type ResolvedSpecificationTemplate } from "./templates.js";
import { specificationPhaseSchemaForConstitution, validateProducedArtifact } from "../engine/artifact-contract.js";
import { artifactExistsPinned, MAX_ARTIFACT_BYTES, parseArtifactJson, readPinnedArtifactSnapshot, writeArtifactPinned } from "../engine/artifacts.js";
import {
  nextActionForWorkspace,
  canonicalJson,
  digestOf,
  isRecord,
  isSafeFeatureId,
  isSafeRelativePath,
  isSha256Hex,
  sha256Hex,
  validateConstitutionBinding,
  validateFeatureWorkspaceRecord,
  validateImplementationHandoff,
} from "./validation.js";
import { freezeImplementationHandoff, canonicalHandoffDigest } from "./handoff.js";
import { MAX_PHASE_INPUT_BYTES } from "./limits.js";
import { preparationStartPostimageDigest, preparationStateDigest, verifyPreparationHandoffAuth, verifyPreparationHandoffDigest, type NativePreparationStartMarker, type WorkflowPreparationHandoff } from "../engine/preparation.js";
import { parseConstitutionPrincipleIdentities, readPinnedConstitutionPrincipleIdentities, readPinnedCurrentConstitution, type ConstitutionPrincipleIdentity } from "./constitution-identities.js";
import { buildDispatchMarker, dispatchTaskId, nativeGenerationBinding, nativeWorkerName as deriveNativeWorkerName, parseDispatchMarker } from "../gates/dispatch.js";
export { MAX_PHASE_INPUT_BYTES };
export { parseConstitutionPrincipleIdentities, readPinnedConstitutionPrincipleIdentities };
export type { ConstitutionPrincipleIdentity };

const PHASES: readonly WorkspacePhase[] = ["specify", "plan", "tasks"];
const PHASE_CHECKPOINT = "specification_phase_approval";
const PHASE_COMMAND: Readonly<Record<WorkspacePhase, string>> = {
  specify: "/specify",
  plan: "/spec-plan",
  tasks: "/spec-tasks",
};
const PHASE_DECISIONS = ["approve_continue", "request_changes", "approve_stop"] as const;
const PHASE_DOCUMENT: Readonly<Record<WorkspacePhase, string>> = {
  specify: "spec.md",
  plan: "plan.md",
  tasks: "tasks.md",
};
const PHASE_SOURCE_ARTIFACT: Readonly<Record<WorkspacePhase, string>> = {
  specify: "specify_draft",
  plan: "plan_draft",
  tasks: "task_graph",
};

type NativePhaseTemplate = Readonly<Pick<ResolvedSpecificationTemplate, "template_id" | "source" | "content" | "content_hash" | "required_markers">>;

const LEGACY_SHIPPED_TEMPLATE_SET_DIGESTS = new Set([
  digestOf({ template_set: "specification-default" }),
  sha256Hex("template-set:specification-default"),
]);

function isLegacyMaterializedArtifact(workspace: FeatureWorkspace, artifact: { schema_version: unknown; source_artifact: unknown }): boolean {
  return workspace.source_kind === "legacy"
    && artifact.schema_version === 1
    && isRecord(artifact.source_artifact)
    && artifact.source_artifact.source_kind === "legacy";
}

function sameTemplateSelection(left: TemplateSelection, right: { template_set_id: string; source: string; content_hash: string; required_markers: readonly string[] }): boolean {
  return left.template_set_id === right.template_set_id
    && left.source === right.source
    && left.content_hash === right.content_hash
    && left.required_markers.length === right.required_markers.length
    && left.required_markers.every((marker, index) => marker === right.required_markers[index]);
}

/** Resolve the exact immutable presentation selected by the workspace.
 *
 * Native workers never rediscover a lower-precedence template. Configured
 * project/feature selections must still exist and hash exactly as they did
 * when the workspace was bound; only an unconfigured shipped-default
 * workspace may use the historical default selection digest.
 */
function resolveNativePhaseTemplate(
  projectRoot: string,
  workspace: FeatureWorkspace,
  phase: WorkspacePhase,
  pinnedRoot: PinnedProjectRoot,
): { ok: true; value: NativePhaseTemplate } | { ok: false; error: string } {
  const config = loadSpecificationPresentationConfig(projectRoot, workspace.feature_id, pinnedRoot);
  if (!config.ok) return { ok: false, error: `presentation configuration is unavailable: ${config.code}: ${config.error}` };
  const configured = Object.keys(config.value.feature_templates).length > 0
    || Object.keys(config.value.project_templates).length > 0;
  const resolved = resolveSpecificationTemplateSet({
    template_ids: SHIPPED_SPECIFICATION_TEMPLATE_IDS,
    feature_overrides: config.value.feature_templates,
    project_defaults: config.value.project_templates,
  });
  if (!resolved.ok) return { ok: false, error: `presentation template set is unavailable: ${resolved.code}: ${resolved.error}` };
  const selection = workspace.template_set;
  const exactSelection = sameTemplateSelection(selection, resolved.value.selection);
  const legacyShippedSelection = !configured
    && selection.source === "shipped_default"
    && (LEGACY_SHIPPED_TEMPLATE_SET_DIGESTS.has(selection.content_hash) || exactSelection);
  if (!exactSelection && !legacyShippedSelection) {
    return { ok: false, error: "workspace template selection no longer matches the exact configured template set" };
  }
  const template = resolved.value.templates.find((candidate) => candidate.template_id === phase);
  if (!template) return { ok: false, error: `resolved template set has no '${phase}' template` };
  return { ok: true, value: template };
}

/** Stable bounded task name for the native worker, derived only from its dispatch id. */
function nativeWorkerName(phase: WorkspacePhase, dispatchId: string): string {
  return deriveNativeWorkerName(phase, dispatchId);
}
export function nativeWorkerAssignment(dispatch: SpecificationPhaseDispatch, requesterContext: string): string {
  const reference = nativeWorkerReference(dispatch);
  const digest = nativeWorkerPromptDigest(dispatch, requesterContext);
  return [
    dispatch.dispatch_marker,
    `NATIVE_WORKER_INPUT_REF schema=1 ref=${reference} digest=${digest}`,
    NATIVE_WORKER_REF_INSTRUCTION,
  ].join("\n\n");
}
export type SpecificationPhaseFailurePoint =
  | "before_prepare"
  | "before_dispatch_transition"
  | "before_checkpoint_validation"
  | "before_validation_evidence_write"
  | "after_prepare"
  | "after_journal_parse"
  | "before_artifact_write"
  | "after_artifact_write"
  | "before_state_write"
  | "after_state_write"
  | "before_projection"
  | "before_projection_artifact"
  | "before_projection_artifact_replace"
  | "after_projection_document"
  | "after_projection"
  | "before_cleanup"
  | "after_cleanup"
  | "after_commit"
  | "after_capability_begin"
  | "after_start_dispatch"
  | "after_materialize"
  | "after_generation_complete"
  | "after_validation_dispatch"
  | "after_validation_observe"
  | "after_checkpoint_presentation";
export interface SpecificationPhaseDocumentBoundary {
  index: number;
  path: string;
  total: number;
}

export type SpecificationPhaseFailureInjector = (
  point: SpecificationPhaseFailurePoint,
  document?: SpecificationPhaseDocumentBoundary,
) => void;

let specificationPhaseFailureInjector: SpecificationPhaseFailureInjector | null = null;

/** Test-only failure seam for proving every phase durable boundary replays. */
export function setSpecificationPhaseFailureInjector(
  injector: SpecificationPhaseFailureInjector | null,
): void {
  specificationPhaseFailureInjector = injector;
}

function injectPhaseFailure(point: SpecificationPhaseFailurePoint, document?: SpecificationPhaseDocumentBoundary): void {
  specificationPhaseFailureInjector?.(point, document);
}

type NativePhaseArtifactProjectionResult =
  | { ok: true }
  | { ok: false; code: "SPEC_PHASE_IMMUTABLE" | "SPEC_PHASE_PERSIST_FAILED"; error: string };

interface NativeProjectionPreimage {
  dev: number;
  ino: number;
  sha256: string;
}

interface PhaseRollbackImage {
  bytes: Buffer;
  expectation: PinnedRootFileExpectation;
}

interface PhaseArtifactOwnership {
  path: string;
  expectation: PinnedRootFileExpectation;
  size: number;
}

interface PhaseRollbackOperation {
  kind: "write" | "remove";
  descriptor?: PinnedRootWriteDescriptor;
}

interface PhasePersistenceRollback {
  capture(path: string): void;
  setPreimage(path: string, preimage: PinnedRootWritePreimage): void;
  plan(path: string, operation: PhaseRollbackOperation): void;
  recordReceipt(path: string, receipt: PinnedRootWriteReceipt): void;
  recordCurrent(path: string, descriptor: PinnedRootWriteDescriptor): void;
  recordImmutableCreated(path: string, expectedContent: string | Uint8Array, descriptor: PinnedRootWriteDescriptor): void;
  cleanup(): void;
}

function phaseRollbackImage(pinnedRoot: PinnedProjectRoot, path: string): PhaseRollbackImage | null {
  try {
    const observed = pinnedRoot.readFile(path, { maxBytes: MAX_ARTIFACT_BYTES });
    const bytes = Buffer.from(observed.bytes);
    return { bytes, expectation: { dev: observed.dev, ino: observed.ino, sha256: sha256Bytes(bytes) } };
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return null;
    throw error;
  }
}

function samePhaseRollbackImage(left: PhaseRollbackImage, right: PhaseRollbackImage): boolean {
  return left.expectation.dev === right.expectation.dev
    && left.expectation.ino === right.expectation.ino
    && left.expectation.sha256 === right.expectation.sha256;
}

function createPhasePersistenceRollback(
  pinnedRoot: PinnedProjectRoot,
  paths: readonly string[],
): PhasePersistenceRollback {
  const entries = new Map<string, { before: PhaseRollbackImage | null; after: PhaseRollbackImage | null; operation: PhaseRollbackOperation | null; recorded: boolean }>();
  const capture = (path: string): void => {
    if (entries.has(path)) return;
    entries.set(path, { before: phaseRollbackImage(pinnedRoot, path), after: null, operation: null, recorded: false });
  };
  for (const path of new Set(paths)) capture(path);
  const setPreimage = (path: string, preimage: PinnedRootWritePreimage): void => {
    const entry = entries.get(path);
    if (!entry) return;
    entry.before = preimage.kind === "absent"
      ? null
      : { bytes: Buffer.from(preimage.bytes), expectation: preimage.expectation };
  };
  const plan = (path: string, operation: PhaseRollbackOperation): void => {
    const entry = entries.get(path);
    if (!entry) return;
    entry.operation = operation;
  };
  const immutableCreated: PhaseArtifactOwnership[] = [];
  const recordImmutableCreated = (path: string, expectedContent: string | Uint8Array, descriptor: PinnedRootWriteDescriptor): void => {
    const expectedSize = typeof expectedContent === "string" ? Buffer.byteLength(expectedContent, "utf8") : expectedContent.byteLength;
    const expectedDigest = typeof expectedContent === "string" ? sha256Hex(expectedContent) : sha256Bytes(expectedContent);
    if (descriptor.relative_path !== path || descriptor.size !== expectedSize || descriptor.sha256 !== expectedDigest) throw new PinnedRootError("changed", "immutable phase artifact descriptor does not match the requested bytes");
    immutableCreated.push({ path, expectation: { dev: descriptor.dev, ino: descriptor.ino, sha256: descriptor.sha256 }, size: descriptor.size });
  };
  const recordReceipt = (path: string, receipt: PinnedRootWriteReceipt): void => {
    const entry = entries.get(path);
    if (!entry) return;
    entry.before = receipt.preimage.kind === "absent"
      ? null
      : { bytes: Buffer.from(receipt.preimage.bytes), expectation: receipt.preimage.expectation };
    entry.operation = { kind: "write", descriptor: receipt.descriptor };
    entry.recorded = true;
    entry.after = null;
  };
  const recordCurrent = (path: string, descriptor: PinnedRootWriteDescriptor): void => {
    const entry = entries.get(path);
    if (!entry) return;
    entry.operation = { kind: "write", descriptor };
    entry.recorded = true;
    entry.after = { bytes: Buffer.alloc(0), expectation: { dev: descriptor.dev, ino: descriptor.ino, sha256: descriptor.sha256 } };
  };
  return {
    capture,
    setPreimage,
    plan,
    recordReceipt,
    recordCurrent,
    recordImmutableCreated,
    cleanup: () => {
      for (const owner of immutableCreated) {
        try {
          const info = pinnedRoot.pathEntryInfo(owner.path);
          if (info?.kind === "file" && info.dev === owner.expectation.dev && info.ino === owner.expectation.ino && info.size === owner.size) {
            pinnedRoot.removeFileIfMatches(owner.path, owner.expectation);
          }
        } catch {
          // A changed or vanished artifact is not ours to clean up; preserve it.
        }
      }
      for (const [path, entry] of entries) {
        if (!entry.operation || !entry.recorded) continue;
        let current: PhaseRollbackImage | null;
        try { current = phaseRollbackImage(pinnedRoot, path); }
        catch { continue; }
        try {
          if (entry.after) {
            if (!current || !samePhaseRollbackImage(current, entry.after)) continue;
          } else if (entry.operation.kind === "remove") {
            if (current) continue;
          } else {
            const descriptor = entry.operation.descriptor;
            if (!descriptor || !current || current.expectation.dev !== descriptor.dev || current.expectation.ino !== descriptor.ino || current.expectation.sha256 !== descriptor.sha256) continue;
          }
          if (!entry.before) {
            if (current) pinnedRoot.removeFileIfMatches(path, current.expectation);
          } else if (!current) {
            if (entry.operation.kind === "remove") pinnedRoot.writeExclusiveWithDescriptor(path, entry.before.bytes);
          } else if (entry.before.expectation.sha256 !== current.expectation.sha256) {
            pinnedRoot.replaceFileIfMatchesWithDescriptor(path, current.expectation, entry.before.bytes);
          }
        } catch {
          // A changed or vanished file is not ours to clean up; preserve it.
        }
      }
    },
  };
}

interface NativeProjectionOwnership {
  projectRoot: string;
  featureId: string;
  runKey: string;
  phase: WorkspacePhase;
  version: number;
  workspace: FeatureWorkspace;
  pinnedRoot: PinnedProjectRoot;
  transaction?: PhasePersistenceTransaction;
  beforeWrite: () => void;
  onWritten?: (descriptor: PinnedRootWriteDescriptor) => void;
}

function nativeProjectionBytes(model: SpecificationSemanticModel): Buffer {
  return Buffer.from(`${JSON.stringify(model, null, 2)}\n`, "utf8");
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function projectionPreimage(
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
): NativeProjectionPreimage | null {
  try {
    const entry = pinnedRoot.readFile(relativePath, { maxBytes: MAX_ARTIFACT_BYTES });
    if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "project root changed while reading the native artifact projection");
    return { dev: entry.dev, ino: entry.ino, sha256: sha256Bytes(Buffer.from(entry.bytes)) };
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return null;
    throw error;
  }
}

function projectionTransactionOwnsPath(
  ownership: NativeProjectionOwnership | undefined,
  projectionPath: string,
  artifactId: string,
  expected: Buffer,
  semanticModel: SpecificationSemanticModel,
): boolean {
  const transaction = ownership?.transaction;
  if (!transaction
    || transaction.feature_id !== ownership.featureId
    || transaction.run_key !== ownership.runKey
    || transaction.phase !== ownership.phase
    || transaction.version !== ownership.version
    || transaction.artifact_path !== join(".work-state", "features", ownership.featureId, "artifacts", `${ownership.phase}.v${ownership.version}.json`)
    || transaction.projection_path !== projectionPath
    || transaction.projection_preimage === null
    || transaction.projection_postimage_sha256 !== sha256Bytes(expected)) return false;
  try {
    const parsed = parseArtifactJson(Buffer.from(transaction.artifact_content, "utf8"));
    return parsed.ok
      && isRecord(parsed.value)
      && parsed.value.artifact_id === `${ownership.phase}.v${ownership.version}`
      && parsed.value.source_artifact_id === artifactId
      && same(parsed.value.semantic_model, semanticModel);
  } catch {
    return false;
  }
}

function projectionPreviousVersionIsAuthoritative(
  ownership: NativeProjectionOwnership | undefined,
  existing: Record<string, unknown>,
  existingBytes: Buffer,
): boolean {
  if (!ownership || !Number.isSafeInteger(existing.version) || (existing.version as number) < 1 || (existing.version as number) >= ownership.version) return false;
  const record = ownership.workspace.phases.find((candidate) => candidate.phase === ownership.phase);
  if (!record || record.current_version !== existing.version) return false;
  const previous = readVersion(ownership.projectRoot, ownership.featureId, `${ownership.phase}.v${existing.version}`, ownership.runKey, ownership.pinnedRoot);
  if (!previous || previous.phase !== ownership.phase || previous.version !== existing.version || !same(previous.semantic_model, existing)) return false;
  return Buffer.compare(existingBytes, nativeProjectionBytes(previous.semantic_model)) === 0;
}

function ensureNativePhaseArtifactProjection(
  pinnedRoot: PinnedProjectRoot,
  artifactsRelative: string,
  artifactId: string,
  semanticModel: SpecificationSemanticModel,
  ownership: NativeProjectionOwnership,
): NativePhaseArtifactProjectionResult {
  const expected = nativeProjectionBytes(semanticModel);
  const projectionPath = join(artifactsRelative, `${artifactId}.json`);
  if (!artifactExistsPinned(pinnedRoot, artifactsRelative, artifactId)) {
    try {
      writeArtifactPinned(pinnedRoot, artifactsRelative, artifactId, semanticModel, { beforeWrite: ownership.beforeWrite, onWritten: (token) => { if (!token.receipt) throw new PinnedRootError("changed", "native artifact write returned no publication receipt"); ownership.onWritten?.(token.receipt.descriptor); } });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "SPEC_PHASE_PERSIST_FAILED", error: `native artifact projection '${artifactId}' could not be written safely: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  try {
    const entry = pinnedRoot.readFile(projectionPath, { maxBytes: MAX_ARTIFACT_BYTES });
    const existingBytes = Buffer.from(entry.bytes);
    if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "project root changed while reading the native artifact projection");
    if (Buffer.compare(existingBytes, expected) === 0) return { ok: true };
    const parsed = parseArtifactJson(existingBytes);
    const existing = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
    const transactionOwnsPath = projectionTransactionOwnsPath(ownership, projectionPath, artifactId, expected, semanticModel);
    const preimage = ownership?.transaction?.projection_preimage;
    const preimageMatches = preimage !== null && preimage !== undefined
      && preimage.dev === entry.dev && preimage.ino === entry.ino && preimage.sha256 === sha256Bytes(existingBytes);
    const invalidOrUnversioned = existing === null || !Number.isSafeInteger(existing.version);
    const lowerVersion = existing !== null && Number.isSafeInteger(existing.version) && (existing.version as number) < semanticModel.version;
    const mayReplace = transactionOwnsPath && preimageMatches
      && (invalidOrUnversioned || (lowerVersion && projectionPreviousVersionIsAuthoritative(ownership, existing, existingBytes)));
    if (!mayReplace) {
      return { ok: false, code: "SPEC_PHASE_IMMUTABLE", error: `native artifact projection '${artifactId}' conflicts with the immutable phase semantic model` };
    }
    try {
      injectPhaseFailure("before_projection_artifact_replace");
      ownership.beforeWrite();
      const receipt = pinnedRoot.replaceFileIfMatchesWithReceipt(projectionPath, { dev: entry.dev, ino: entry.ino, sha256: sha256Bytes(existingBytes) }, expected);
      ownership.onWritten?.(receipt.descriptor);
      return { ok: true };
    } catch (error) {
      if (error instanceof PinnedRootError && error.code === "changed") {
        try {
          const winner = Buffer.from(pinnedRoot.readFile(projectionPath, { maxBytes: MAX_ARTIFACT_BYTES }).bytes);
          if (Buffer.compare(winner, expected) === 0) return { ok: true };
        } catch {
          // Preserve the immutable conflict below.
        }
      }
      return { ok: false, code: "SPEC_PHASE_IMMUTABLE", error: `native artifact projection '${artifactId}' conflicts with the immutable phase semantic model` };
    }
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") {
      return { ok: false, code: "SPEC_PHASE_IMMUTABLE", error: `native artifact projection '${artifactId}' disappeared before its owned repair` };
    }
    return { ok: false, code: "SPEC_PHASE_PERSIST_FAILED", error: `native artifact projection '${artifactId}' could not be read safely: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type PhaseLifecycleCode =
  | "SPEC_SEMANTIC_MODEL_REQUIRED"
  | "SPEC_PHASE_REQUEST_INVALID"
  | "SPEC_PHASE_FORBIDDEN"
  | "SPEC_PHASE_NOT_READY"
  | "SPEC_PHASE_STALE"
  | "SPEC_PHASE_CONFLICT"
  | "SPEC_PHASE_IMMUTABLE"
  | "SPEC_PHASE_PERSIST_FAILED"
  | "SPEC_PHASE_RECOVERY_REQUIRED"
  | "SPEC_CHECKPOINT_BLOCKED"
  | "SPEC_CHECKPOINT_UNKNOWN"
  | "SPEC_DECISION_INVALID"
  | "SPEC_PROOF_INVALID"
  | "SPEC_FEEDBACK_REQUIRED"
  | "SPEC_FEEDBACK_INVALID"
  | "NATIVE_COMPOSITE_REQUIRED";

export type PhaseLifecycleResult<T> =
  | { ok: true; value: T; replayed: boolean }
  | { ok: false; code: PhaseLifecycleCode; error: string };

type PhaseCapabilityInput = Omit<DispatchAuth, "feature_id" | "run_key" | "stage_cursor" | "tool_call_id"> & {
  feature_id: string;
  run_key: string;
  phase: WorkspacePhase;
  request_id: string;
};

export type SpecificationPhaseDispatchInput = PhaseCapabilityInput;

export interface NativeSpecificationPhaseStartInput {
  feature_id: string;
  run_key: string;
  preparation_handoff: WorkflowPreparationHandoff;
  selection?: RosterBeginSelection;
}

export interface NativeSpecificationPhaseStartOptions {
  /** Opaque engine-issued proof for the exact canonical mapping of this transition. */
  trustedMappingProof?: TrustedMappingProof;
  /** Composite native start keeps the proof open until its dispatch commit. */
  consumeTrustedMappingProof?: boolean;
  /** Exact engine-owned CTO routing marker for a preparation wave. */
  ctoSliceMarker?: string;
}

export interface NativeSpecificationGenerationHandoff extends SpecificationPhaseDispatch {
  workflow: TeamState["classification"]["workflow"];
  cursor_epoch: string;
  token: string;
  capability_id: string;
  advance_token: string;
  branch: string;
  profile_hash: string;
  role: string;
  slot_id: string;
  agent: string;
}

export interface NativeSpecificationTaskEnvelope {
  name: "task";
  arguments: {
    i: string;
    context: string;
    tasks: Array<{
      name: string;
      agent: string;
      task: string;
      outputSchema: Record<string, unknown>;
      schemaMode: "strict";
    }>;
  };
}

export interface NativeSpecificationWorkerPromptHydrationInput {
  prompt: string;
  session_id: string;
  session_file: string;
  session_dir: string;
}

export type NativeSpecificationWorkerPromptHydrationResult =
  | { ok: true; worker_name: string; reference: string; digest: string; system_prompt: string }
  | { ok: false; code: string; error: string; provenance: "unauthenticated" | "authenticated_assignment" };

export interface NativeSpecificationPhaseStart {
  handoff: NativeSpecificationGenerationHandoff;
  required_next_tool: NativeSpecificationTaskEnvelope;
  next_action: string;
  cto_slice_marker?: string;
}

export function nativeWorkerTaskEnvelope(dispatch: SpecificationPhaseDispatch, requesterContext: string, ctoSliceMarker?: string): NativeSpecificationTaskEnvelope {
  return {
    name: "task",
    arguments: {
      i: NATIVE_TASK_INTENT,
      context: NATIVE_TASK_CONTEXT,
      tasks: [{
        name: dispatch.worker_name,
        agent: dispatch.work_identity.worker_id,
        task: nativeWorkerAssignment(dispatch, requesterContext) + (ctoSliceMarker === undefined ? "" : "\n\n" + ctoSliceMarker),
        outputSchema: dispatch.output_schema,
        schemaMode: "strict",
      }],
    },
  };
}

export interface NativeSpecificationWorkerPrincipleObservation {
  principle_id: string;
  applicability: "applicable" | "not_applicable";
  status: "pass" | "fail" | "not_applicable";
  evidence: string;
}

export interface NativeSpecificationWorkerResult {
  /** Exact engine-issued generation identity copied from NATIVE_WORKER_INPUT.engine_binding. */
  input_ref: string;
  input_digest: string;
  sections: SpecifySemanticSections | PlanSemanticSections | { task_graph: string; dependencies: string; expected_outcomes: string };
  requirements: SpecificationSemanticModel["requirements"];
  decisions: SpecificationSemanticModel["decisions"];
  tasks: SpecificationSemanticModel["tasks"];
  verification: SpecificationSemanticModel["verification"];
  contradictions: SpecificationSemanticModel["contradictions"];
  constitution_principles: NativeSpecificationWorkerPrincipleObservation[];
}

export interface NativeSpecificationPhaseFinalizeInput {
  feature_id: string;
  run_key: string;
  worker_result: NativeSpecificationWorkerResult;
}

export interface NativeSpecificationPhaseFinalize {
  persisted_version: PersistedPhaseResultEnvelope;
  validation: PhaseValidationResult;
  required_next_tool: {
    name: "workflow_checkpoint_ask_selected";
    arguments: Record<string, unknown>;
  };
  next_action: string;
}

interface NativeWorkerAuthoritativeInput {
  language: FeatureWorkspace["language"];
  constitution: {
    binding: ConstitutionBinding;
    path: string;
    content_sha256: string;
    document_text: string;
  };
  upstream_artifact_refs: Array<PhaseUpstreamVersionBinding & {
    semantic_model: SpecificationSemanticModel;
  }>;
}

export interface SpecificationPhaseDispatch {
  feature_id: string;
  run_key: string;
  phase: WorkspacePhase;
  version: number;
  request_id: string;
  dispatch_id: string;
  /** Exact generic-task name; engine-derived from dispatch_id and never model-generated. */
  worker_name: string;
  /** Exact marker copied into the single native task assignment. */
  dispatch_marker: string;
  /** Opaque engine-issued generation input identity echoed by the worker. */
  input_ref: string;
  input_digest: string;
  /** Dynamic constitution-bound semantic model schema for the native task. */
  output_schema: Record<string, unknown>;
  work_identity: WorkIdentity;
  capability_epoch: string;
  constitution_binding: ConstitutionBinding;
  upstream_versions: PhaseUpstreamVersionBinding[];
  template_hash: string;
  language_hash: string;
  feedback: string | null;
  /** Compact approved principle identities copied into the worker assignment. */
  constitution_principles?: Array<Pick<ConstitutionPrincipleIdentity, "principle_id" | "title">>;
  /** Requester context declared by the prepared workflow state. */
  requester_context?: string;
  /** Full validated bytes loaded through the pinned root for native worker assignment. */
  authoritative_input?: NativeWorkerAuthoritativeInput;
  /** Exact selected phase template, including immutable content and hash. */
  phase_template: NativePhaseTemplate;
}

export interface SpecificationWorkerResultInput extends PhaseCapabilityInput {
  /** Optional native generation echo, rechecked against the locked dispatch CAS. */
  input_ref?: string;
  input_digest?: string;
  dispatch_id: string;
  version: number;
  source_artifact: Record<string, unknown>;
  documents: Array<{ path: string; content: string }>;
  /** Stable semantic marker to the exact section bytes owned by that marker. */
  semantic_sections: Record<string, string>;
  constitution_binding: ConstitutionBinding;
  upstream_versions: PhaseUpstreamVersionBinding[];
  template_hash: string;
  language_hash: string;
}

/** Capability-bound deterministic validation of one already materialized phase revision.
 * The dispatch_id identifies a live validation-stage dispatch, never the terminal worker
 * dispatch that produced the immutable phase artifact.
 */
export interface SpecificationPhaseValidationInput extends PhaseCapabilityInput {
  dispatch_id: string;
  validation: NativePhaseValidationInput;
}

export interface PersistedPhaseResultEnvelope extends PhaseArtifactVersion {
  schema_version: 1;
  feature_id: string;
  run_key: string;
  request_id: string;
  request_digest: string;
  source_artifact_id: string;
  source_artifact: Record<string, unknown>;
  capability_epoch: string;
}

interface PhasePersistenceTransaction {
  schema_version: 1;
  transaction_id: string;
  request_digest: string;
  feature_id: string;
  run_key: string;
  phase: WorkspacePhase;
  version: number;
  artifact_path: string;
  projection_path: string;
  projection_preimage: NativeProjectionPreimage | null;
  projection_postimage_sha256: string;
  artifact_content: string;
  materialize_request: MaterializedDocumentRequest & { binding: PhaseArtifactVersion };
  workspace_before_digest: string;
  next_workspace: FeatureWorkspace;
}

interface PhaseTransactionJournalRead {
  readonly bytes: Buffer;
  readonly expectation: PinnedRootFileExpectation;
}

interface LoadedPhaseTransaction {
  readonly transaction: PhasePersistenceTransaction;
  readonly read: PhaseTransactionJournalRead;
}

export interface PersistedSpecificationPhase {
  workspace: FeatureWorkspace;
  version: PersistedPhaseResultEnvelope;
  handoff_required: boolean;
}

function fail<T>(code: PhaseLifecycleCode, error: string): PhaseLifecycleResult<T> {
  return { ok: false, code, error };
}

function authInput(input: PhaseCapabilityInput): DispatchAuth & { feature_id: string; request_id: string } {
  return {
    token: input.token,
    capability_id: input.capability_id,
    feature_id: input.feature_id,
    run_key: input.run_key,
    branch: input.branch,
    workflow: input.workflow,
    profile_hash: input.profile_hash,
    stage_cursor: input.phase,
    cursor_epoch: input.cursor_epoch,
    request_id: input.request_id,
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.slot_id !== undefined ? { slot_id: input.slot_id } : {}),
    ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.expected_count !== undefined ? { expected_count: input.expected_count } : {}),
    ...(input.retry_of !== undefined ? { retry_of: input.retry_of } : {}),
  };
}
function phaseTransactionPath(featureId: string, requestDigest: string): string {
  return join(".work-state", "features", featureId, "artifacts", ".phase-" + requestDigest + ".json");
}
const MAX_PHASE_TRANSACTION_BYTES = 4 * 1024 * 1024;
const MAX_PHASE_TRANSACTION_NODES = 32_768;
const MAX_PHASE_TRANSACTION_KEYS = 128;
const MAX_PHASE_TRANSACTION_ARRAY_ITEMS = 4_096;
const MAX_PHASE_TRANSACTION_STRING_BYTES = 1 * 1024 * 1024;
const MAX_PHASE_TRANSACTION_AGGREGATE_BYTES = 4 * 1024 * 1024;
const PHASE_TRANSACTION_FIELDS = [
  "schema_version", "transaction_id", "request_digest", "feature_id", "run_key",
  "phase", "version", "artifact_path", "projection_path", "projection_preimage", "projection_postimage_sha256", "artifact_content", "materialize_request",
  "workspace_before_digest", "next_workspace",
] as const;
const MATERIALIZE_TRANSACTION_FIELDS = ["feature_id", "run_key", "phase", "version", "documents", "binding", "validation_id"] as const;
const MATERIALIZE_DOCUMENT_FIELDS = ["path", "content"] as const;

function boundedPhaseTransactionShape(value: unknown): string | null {
  let nodes = 0;
  let aggregateBytes = 0;
  const visit = (current: unknown, depth: number, path: string): string | null => {
    nodes += 1;
    if (nodes > MAX_PHASE_TRANSACTION_NODES) return `${path} exceeds the transaction node bound`;
    if (depth > MAX_PHASE_DEPTH) return `${path} exceeds the transaction nesting depth bound`;
    if (typeof current === "string") {
      const bytes = Buffer.byteLength(current, "utf8");
      if (bytes > MAX_PHASE_TRANSACTION_STRING_BYTES) return `${path} exceeds the transaction string bound`;
      aggregateBytes += bytes;
      return aggregateBytes > MAX_PHASE_TRANSACTION_AGGREGATE_BYTES ? "phase transaction exceeds the aggregate string bound" : null;
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_PHASE_TRANSACTION_ARRAY_ITEMS) return `${path} exceeds the transaction array bound`;
      for (let index = 0; index < current.length; index += 1) {
        const issue = visit(current[index], depth + 1, `${path}[${index}]`);
        if (issue) return issue;
      }
      return null;
    }
    if (isRecord(current)) {
      const keys = Object.keys(current);
      if (keys.length > MAX_PHASE_TRANSACTION_KEYS) return `${path} exceeds the transaction object-key bound`;
      for (const key of keys) {
        if (Buffer.byteLength(key, "utf8") > 256) return `${path} contains an overlong transaction key`;
        const issue = visit(current[key], depth + 1, `${path}.${key}`);
        if (issue) return issue;
      }
    }
    return null;
  };
  return visit(value, 0, "$");
}

function phaseTransactionBindingIssues(
  value: unknown,
  path: string,
  phase: WorkspacePhase,
  version: number,
): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return [`${path} must be an object`];
  strictKeys(value, PHASE_ARTIFACT_FIELDS, path, issues);
  if (value.artifact_id !== `${phase}.v${version}`) issues.push(`${path}.artifact_id must match phase/version`);
  return issues;
}

function phaseTransactionRequestIssues(
  value: unknown,
  path: string,
  featureId: string,
  runKey: string,
  phase: WorkspacePhase,
  version: number,
): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return [`${path} must be an object`];
  strictKeys(value, MATERIALIZE_TRANSACTION_FIELDS, path, issues);
  if (value.feature_id !== featureId) issues.push(`${path}.feature_id does not match the transaction`);
  if (value.run_key !== runKey) issues.push(`${path}.run_key does not match the transaction`);
  if (value.phase !== phase) issues.push(`${path}.phase does not match the transaction`);
  if (value.version !== version) issues.push(`${path}.version does not match the transaction`);
  if (!Array.isArray(value.documents) || value.documents.length === 0 || value.documents.length > 64) {
    issues.push(`${path}.documents must contain 1..64 entries`);
  } else {
    const paths = new Set<string>();
    for (const [index, document] of value.documents.entries()) {
      const documentPath = `${path}.documents[${index}]`;
      if (!isRecord(document)) {
        issues.push(`${documentPath} must be an object`);
        continue;
      }
      strictKeys(document, MATERIALIZE_DOCUMENT_FIELDS, documentPath, issues);
      if (!isSafeRelativePath(document.path)) issues.push(`${documentPath}.path must be a safe relative path`);
      if (typeof document.content !== "string" || document.content.length === 0 || Buffer.byteLength(document.content, "utf8") > MAX_PHASE_TRANSACTION_STRING_BYTES) {
        issues.push(`${documentPath}.content must be a non-empty bounded string`);
      }
      if (typeof document.path === "string" && paths.has(document.path)) issues.push(`${documentPath}.path must be unique`);
      if (typeof document.path === "string") paths.add(document.path);
    }
  }
  issues.push(...phaseTransactionBindingIssues(value.binding, `${path}.binding`, phase, version));
  if (value.validation_id !== undefined && !nonEmptyPhaseString(value.validation_id)) issues.push(`${path}.validation_id must be a non-empty string when present`);
  return issues;
}

function parsePhaseTransactionContents(
  pinnedRoot: PinnedProjectRoot,
  path: string,
  requestDigest: string,
  contents: string,
): PhasePersistenceTransaction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error("phase persistence journal is unreadable: " + (error instanceof Error ? error.message : String(error)));
  }
  const shapeIssue = boundedPhaseTransactionShape(parsed);
  if (shapeIssue) throw new Error("phase persistence journal is unreadable: " + shapeIssue);
  if (!isRecord(parsed)) throw new Error("phase persistence journal is unreadable: journal must be an object");
  const issues: string[] = [];
  strictKeys(parsed, PHASE_TRANSACTION_FIELDS, "phase persistence journal", issues);
  if (parsed.schema_version !== 1) issues.push("phase persistence journal.schema_version must be 1");
  if (typeof parsed.transaction_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(parsed.transaction_id)) issues.push("phase persistence journal.transaction_id must be a UUID");
  if (!isSha256Hex(parsed.request_digest) || parsed.request_digest !== requestDigest) issues.push("phase persistence journal.request_digest does not match the requested transaction");
  if (!isSafeFeatureId(parsed.feature_id)) issues.push("phase persistence journal.feature_id is unsafe");
  if (!nonEmptyPhaseString(parsed.run_key) || Buffer.byteLength(String(parsed.run_key), "utf8") > PHASE_INPUT_MAX_BYTES || PHASE_CONTROL_OR_FORMAT.test(String(parsed.run_key))) issues.push("phase persistence journal.run_key is invalid");
  if (!Number.isSafeInteger(parsed.version) || (parsed.version as number) < 1) issues.push("phase persistence journal.version must be a positive safe integer");
  const phase = parsed.phase as WorkspacePhase;
  const version = parsed.version as number;
  if (PHASES.includes(phase) && Number.isSafeInteger(version) && version >= 1) {
    const artifactPath = join(".work-state", "features", parsed.feature_id as string, "artifacts", `${phase}.v${version}.json`);
    if (parsed.artifact_path !== artifactPath || !isSafeRelativePath(parsed.artifact_path)) issues.push("phase persistence journal.artifact_path does not match phase/version");
  }
  if (PHASES.includes(phase) && Number.isSafeInteger(version) && version >= 1) {
    const projectionPath = join(".work-state", "features", parsed.feature_id as string, "artifacts", `${PHASE_SOURCE_ARTIFACT[phase]}.json`);
    if (parsed.projection_path !== projectionPath || !isSafeRelativePath(parsed.projection_path)) issues.push("phase persistence journal.projection_path does not match phase");
  }
  if (!isSha256Hex(parsed.projection_postimage_sha256)) issues.push("phase persistence journal.projection_postimage_sha256 must be a SHA-256 digest");
  if (parsed.projection_preimage !== null && parsed.projection_preimage !== undefined) {
    if (!isRecord(parsed.projection_preimage)) issues.push("phase persistence journal.projection_preimage must be null or an object");
    else {
      strictKeys(parsed.projection_preimage, ["dev", "ino", "sha256"], "phase persistence journal.projection_preimage", issues);
      if (!Number.isSafeInteger(parsed.projection_preimage.dev) || (parsed.projection_preimage.dev as number) < 0 || !Number.isSafeInteger(parsed.projection_preimage.ino) || (parsed.projection_preimage.ino as number) < 0 || !isSha256Hex(parsed.projection_preimage.sha256)) issues.push("phase persistence journal.projection_preimage is invalid");
    }
  } else if (parsed.projection_preimage !== null) {
    issues.push("phase persistence journal.projection_preimage must be present");
  }
  if (typeof parsed.artifact_content !== "string" || Buffer.byteLength(parsed.artifact_content, "utf8") > MAX_PHASE_TRANSACTION_STRING_BYTES) {
    issues.push("phase persistence journal.artifact_content is missing or exceeds the bounded size");
  }
  if (!isSha256Hex(parsed.workspace_before_digest)) issues.push("phase persistence journal.workspace_before_digest must be a SHA-256 digest");
  if (!isRecord(parsed.materialize_request)) issues.push("phase persistence journal.materialize_request must be an object");
  if (!isRecord(parsed.next_workspace)) issues.push("phase persistence journal.next_workspace must be an object");
  if (issues.length > 0) throw new Error("phase persistence journal is unreadable: " + issues.join("; "));

  const featureId = parsed.feature_id as string;
  const runKey = parsed.run_key as string;
  const materializeIssues = phaseTransactionRequestIssues(parsed.materialize_request, "phase persistence journal.materialize_request", featureId, runKey, phase, version);
  const nextWorkspaceValidation = validateFeatureWorkspaceRecord(parsed.next_workspace);
  if (!nextWorkspaceValidation.ok) materializeIssues.push(...nextWorkspaceValidation.issues.map((issue) => `phase persistence journal.next_workspace ${issue}`));

  let artifact: unknown;
  try {
    artifact = JSON.parse(parsed.artifact_content as string);
  } catch (error) {
    materializeIssues.push("phase persistence journal.artifact_content is not valid JSON: " + (error instanceof Error ? error.message : String(error)));
  }
  if (!isRecord(artifact)) {
    materializeIssues.push("phase persistence journal.artifact_content must contain an object envelope");
  } else {
    const artifactShapeIssue = boundedPhaseTransactionShape(artifact);
    if (artifactShapeIssue) {
      throw new Error("phase persistence journal is unreadable: phase persistence journal.artifact_content " + artifactShapeIssue);
    }
    const artifactIssues = validatePhaseArtifactEnvelope(artifact, {
      projectRoot: pinnedRoot.canonical_root,
      featureId,
      runKey,
      pinnedRoot,
    });
    materializeIssues.push(...artifactIssues.map((issue) => `phase persistence journal.artifact_content ${issue}`));
    if (artifact.request_digest !== requestDigest
      || artifact.feature_id !== featureId
      || artifact.run_key !== runKey
      || artifact.phase !== phase
      || artifact.version !== version) {
      materializeIssues.push("phase persistence journal.artifact_content identity does not match the transaction");
    }
    const request = parsed.materialize_request as Record<string, unknown>;
    const binding = request.binding;
    if (!isRecord(binding) || !same(binding, artifact)) {
      materializeIssues.push("phase persistence journal materialization binding does not match the artifact envelope");
    }
    const next = parsed.next_workspace as unknown as FeatureWorkspace;
    if (isRecord(artifact.source_artifact) && Array.isArray(artifact.upstream_versions)) {
      const sourceModel = canonicalSourceModel(phase, artifact.source_artifact, {
        featureId,
        runKey,
        version,
        dispatchId: artifact.dispatch_id as string,
        constitution: artifact.constitution_binding as ConstitutionBinding,
        upstream: artifact.upstream_versions as PhaseUpstreamVersionBinding[],
      });
      if (!sourceModel.ok) {
        materializeIssues.push(`phase persistence journal.artifact_content source semantic model is invalid: ${sourceModel.error}`);
      } else if (!same(artifact.semantic_model, sourceModel.value)) {
        materializeIssues.push("phase persistence journal.artifact_content semantic_model does not match source_artifact");
      } else if (parsed.projection_postimage_sha256 !== sha256Bytes(nativeProjectionBytes(sourceModel.value))) {
        materializeIssues.push("phase persistence journal projection postimage does not match semantic_model");
      }
    }
    const requestDocuments = Array.isArray(request.documents) ? request.documents : [];
    const requestDocumentIdentity = requestDocuments
      .filter((document): document is Record<string, unknown> => isRecord(document) && typeof document.path === "string" && typeof document.content === "string")
      .map((document) => ({ path: document.path as string, hash: sha256Hex(document.content as string) }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const artifactDocumentIdentity = Array.isArray(artifact.document_paths)
      ? artifact.document_paths.map((documentPath) => ({ path: documentPath, hash: isRecord(artifact.document_hashes) ? artifact.document_hashes[documentPath] : null }))
      : [];
    if (!same(requestDocumentIdentity, artifactDocumentIdentity)) {
      materializeIssues.push("phase persistence journal materialization documents do not match the artifact document paths and hashes");
    }
    const nextPhase = Array.isArray(next.phases) ? next.phases.find((candidate) => candidate.phase === phase) : null;
    const artifactUpstream = Array.isArray(artifact.upstream_versions)
      ? artifact.upstream_versions.map((entry) => isRecord(entry) && typeof entry.artifact_id === "string" && Number.isSafeInteger(entry.version) && typeof entry.hash === "string"
        ? { phase: entry.artifact_id.split(".")[0] as WorkspacePhase, version: entry.version, hash: entry.hash }
        : null)
      : [];
    if (!nextPhase || nextPhase.status !== "materialized" || nextPhase.current_version !== version
      || nextPhase.approved_version !== null || !same(nextPhase.upstream_versions, artifactUpstream)) {
      materializeIssues.push("phase persistence journal.next_workspace does not carry the exact materialized phase result");
    }
  }
  if (!pinnedRoot.isStable()) materializeIssues.push("project root changed while reading the phase persistence journal");
  if (materializeIssues.length > 0) throw new Error("phase persistence journal is unreadable: " + materializeIssues.join("; "));
  return parsed as unknown as PhasePersistenceTransaction;
}

function phaseJournalReadMatches(pinnedRoot: PinnedProjectRoot, path: string, read: PhaseTransactionJournalRead): boolean {
  try {
    const current = pinnedRoot.readFile(path, { maxBytes: MAX_PHASE_TRANSACTION_BYTES });
    const currentBytes = Buffer.from(current.bytes);
    const expectedSize = read.expectation.size ?? read.bytes.byteLength;
    return current.dev === read.expectation.dev
      && current.ino === read.expectation.ino
      && (current.size ?? currentBytes.byteLength) === expectedSize
      && sha256Bytes(currentBytes) === read.expectation.sha256
      && Buffer.compare(currentBytes, read.bytes) === 0
      && pinnedRoot.isStable();
  } catch {
    return false;
  }
}

function loadPhaseTransaction(pinnedRoot: PinnedProjectRoot, path: string, requestDigest: string): LoadedPhaseTransaction | null {
  let file: { bytes: Uint8Array; dev: number; ino: number; size?: number };
  try {
    file = pinnedRoot.readFile(path, { maxBytes: MAX_PHASE_TRANSACTION_BYTES });
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return null;
    if (error instanceof PinnedRootError && error.code === "limit") throw new Error("phase persistence journal exceeds the bounded size");
    throw new Error("phase persistence journal is unreadable: " + (error instanceof Error ? error.message : String(error)));
  }
  const bytes = Buffer.from(file.bytes);
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("phase persistence journal is unreadable: " + (error instanceof Error ? error.message : String(error)));
  }
  const transaction = parsePhaseTransactionContents(pinnedRoot, path, requestDigest, contents);
  return {
    transaction,
    read: {
      bytes,
      expectation: {
        dev: file.dev,
        ino: file.ino,
        size: file.size ?? bytes.byteLength,
        sha256: sha256Bytes(bytes),
      },
    },
  };
}

function expectedMaterializationBinding(
  workspace: FeatureWorkspace,
  request: MaterializedDocumentRequest & { binding: PhaseArtifactVersion },
): Record<string, unknown> {
  const binding = request.binding;
  return {
    feature_id: request.feature_id,
    run_key: request.run_key,
    phase: request.phase,
    version: request.version,
    artifact_id: binding.artifact_id,
    validation_id: typeof request.validation_id === "string" && request.validation_id.trim().length > 0 ? request.validation_id : null,
    constitution_binding: binding.constitution_binding,
    upstream_versions: binding.upstream_versions,
    worker: { dispatch_id: binding.dispatch_id, work_identity: binding.work_identity },
    presentation: {
      language: workspace.language.language,
      language_source: workspace.language.source,
      language_hash: binding.language_hash,
      template_set_id: workspace.template_set.template_set_id,
      template_source: workspace.template_set.source,
      template_hash: binding.template_hash,
      required_markers: [...workspace.template_set.required_markers],
      next_action: workspace.next_action,
    },
  };
}

function stableMaterializationBinding(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.presentation)) return value;
  return { ...value, presentation: { ...value.presentation, next_action: null } };
}

function ensurePhaseProjection(
  projectRoot: string,
  request: MaterializedDocumentRequest & { binding: PhaseArtifactVersion },
  replay = false,
  pinnedRoot: PinnedProjectRoot,
  workspaceOverride?: FeatureWorkspace,
  onMaterializationBeforeWrite?: (path: string, descriptor?: { kind: "write" | "remove"; descriptor?: PinnedRootWriteDescriptor; receipt?: PinnedRootWriteReceipt }) => void,
  onMaterializationBeforePublish?: (path: string, receipt: PinnedRootWriteReceipt) => void,
  onMaterializationWritten?: (path: string, descriptor?: { kind: "write" | "remove"; descriptor?: PinnedRootWriteDescriptor; receipt?: PinnedRootWriteReceipt }) => void,
  onRetiredDocumentRemoval?: (path: string, expected: PinnedRootFileExpectation) => void,
): MaterializeOutcome {
  const resolvedWorkspace = workspaceOverride
    ? { ok: true as const, value: workspaceOverride }
    : resolveFeatureWorkspace(projectRoot, {
      feature_id: request.feature_id,
      run_key: request.run_key,
    });
  if (!resolvedWorkspace.ok) return resolvedWorkspace;
  const projectionWorkspace = resolvedWorkspace.value;
  const expectedBinding = expectedMaterializationBinding(projectionWorkspace, request);
  const checked = revalidateMaterializedDocumentsPinned(pinnedRoot, {
    feature_id: request.feature_id,
    phase: request.phase,
    version: request.version,
  });
  if (checked.ok) {
    if (Object.values(checked.value.documents).some((document) => !document.matches)) {
      return { ok: false, code: "SPEC_ARTIFACT_IMMUTABLE", error: "materialized projection exists but is incomplete or changed" };
    }
    if (checked.value.binding === undefined || !same(stableMaterializationBinding(checked.value.binding), stableMaterializationBinding(expectedBinding))) {
      return { ok: false, code: "SPEC_ARTIFACT_IMMUTABLE", error: "materialized projection binding is missing or does not match the committed phase artifact" };
    }
    return {
      ok: true,
      value: {
        feature_id: request.feature_id,
        phase: request.phase,
        version: request.version,
        document_hashes: Object.fromEntries(
          Object.entries(checked.value.documents).map(([path, document]) => [path, document.expected_sha256]),
        ),
        ...(checked.value.binding ? { binding: checked.value.binding } : {}),
      },
    };
  }
  // Revalidation has one additional outcome (SPEC_ARTIFACT_UNKNOWN) that
  // means the projection has not been materialized yet. Do not return the
  // wider revalidation union here: this boundary must expose only a
  // materialization outcome while preserving the original typed diagnostic.
  if (checked.code !== "SPEC_ARTIFACT_UNKNOWN") {
    return { ok: false, code: checked.code, error: checked.error };
  }
  const materializationConstitutionBinding = request.binding.constitution_binding;
  if (!materializationConstitutionBinding) return { ok: false, code: "SPEC_ARTIFACT_IMMUTABLE", error: "materialization constitution binding is unavailable" };
  const materializeOptions = {
    replay,
    validateBeforeWrite: () => {
      const current = readPinnedCurrentConstitution(projectRoot, pinnedRoot, materializationConstitutionBinding);
      if (!current.ok) throw new Error("SPEC_PHASE_STALE:" + current.error);
    },
    onBeforeWrite: (path: string, descriptor?: { kind: "write" | "remove"; descriptor?: PinnedRootWriteDescriptor; receipt?: PinnedRootWriteReceipt }) => { onMaterializationBeforeWrite?.(path, descriptor); },
    onBeforePublish: (path: string, receipt: PinnedRootWriteReceipt) => { onMaterializationBeforePublish?.(path, receipt); },
    onWritten: (path: string, descriptor?: { kind: "write" | "remove"; descriptor?: PinnedRootWriteDescriptor; receipt?: PinnedRootWriteReceipt }) => { onMaterializationWritten?.(path, descriptor); },
    deferRetiredDocumentRemoval: onRetiredDocumentRemoval !== undefined,
    onRetiredDocumentRemoval,
    afterDocumentWrite: (index: number, path: string, total: number) => {
      injectPhaseFailure("after_projection_document", { index, path, total });
    },
  };
  const materialized = materializeFeatureDocumentsUnderStateLock(pinnedRoot, request, projectionWorkspace, materializeOptions);
  if (!materialized.ok) return materialized;
  const validated = revalidateMaterializedDocumentsPinned(pinnedRoot, {
    feature_id: request.feature_id,
    phase: request.phase,
    version: request.version,
  });
  if (!validated.ok) {
    return {
      ok: false,
      code: validated.code === "SPEC_ARTIFACT_UNKNOWN" ? "SPEC_ARTIFACT_IMMUTABLE" : validated.code,
      error: validated.error,
    };
  }
  if (Object.values(validated.value.documents).some((document) => !document.matches)) {
    return { ok: false, code: "SPEC_ARTIFACT_IMMUTABLE", error: "materialized projection exists but is incomplete or changed" };
  }
  if (validated.value.binding === undefined || !same(stableMaterializationBinding(validated.value.binding), stableMaterializationBinding(expectedBinding))) {
    return { ok: false, code: "SPEC_ARTIFACT_IMMUTABLE", error: "materialized projection binding is missing or does not match the committed phase artifact" };
  }
  return {
    ok: true,
    value: {
      ...materialized.value,
      document_hashes: Object.fromEntries(
        Object.entries(validated.value.documents).map(([path, document]) => [path, document.expected_sha256]),
      ),
      ...(validated.value.binding ? { binding: validated.value.binding } : {}),
    },
  };
}

function validateSelector(input: PhaseCapabilityInput | { feature_id: string; run_key: string; phase: WorkspacePhase }): string | null {
  if (typeof input.feature_id !== "string" || input.feature_id.trim().length === 0) return "an explicit feature_id is required";
  if (typeof input.run_key !== "string" || input.run_key.trim().length === 0) return "an explicit run_key is required";
  if (!PHASES.includes(input.phase)) return `unsupported specification phase '${String(input.phase)}'`;
  return null;
}
const PHASE_CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const PHASE_SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const PHASE_INPUT_MAX_BYTES = 4096;

function nativeCapabilityInputError(input: unknown, extraFields: readonly string[] = []): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "phase request must be an object";
  const value = input as Record<string, unknown>;
  const requiredFields = ["feature_id", "token", "capability_id", "run_key", "branch", "workflow", "profile_hash", "cursor_epoch", "request_id"];
  for (const field of requiredFields) {
    const entry = value[field];
    if (typeof entry !== "string" || entry.length === 0 || Buffer.byteLength(entry, "utf8") > PHASE_INPUT_MAX_BYTES || PHASE_CONTROL_OR_FORMAT.test(entry)) {
      return `phase request field '${field}' is not bounded line-inert text`;
    }
  }
  for (const field of extraFields) {
    const entry = value[field];
    if (entry !== undefined && (typeof entry !== "string" || entry.length === 0 || Buffer.byteLength(entry, "utf8") > PHASE_INPUT_MAX_BYTES || PHASE_CONTROL_OR_FORMAT.test(entry))) {
      return `phase request field '${field}' is not bounded line-inert text`;
    }
  }
  for (const field of ["feature_id", "capability_id", "token", "stage_cursor", "cursor_epoch", "request_id", "dispatch_id", "retry_of"] as const) {
    const entry = value[field];
    if (entry !== undefined && (typeof entry !== "string" || !PHASE_SAFE_ID.test(entry) || entry === "." || entry === "..")) return `phase request field '${field}' is not a safe identifier`;
  }
  if (!isSafeFeatureId(value.feature_id)) return "phase request feature_id is not safe";
  return null;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function phaseRecord(workspace: FeatureWorkspace, phase: WorkspacePhase): WorkspacePhaseRecord | null {
  return workspace.phases.find((candidate) => candidate.phase === phase) ?? null;
}

const PHASE_ARTIFACT_FIELDS = [
  "schema_version", "feature_id", "run_key", "request_id", "request_digest",
  "source_artifact_id", "source_artifact", "artifact_id", "phase", "version",
  "dispatch_id", "work_identity", "capability_epoch", "source_artifact_hash", "semantic_model",
  "document_paths", "document_hashes", "semantic_section_hashes", "template_hash",
  "language_hash", "upstream_versions", "created_at", "constitution_binding",
] as const;

const WORK_IDENTITY_FIELDS = [
  "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id",
  "stage_cursor", "capability_id", "capability_epoch", "slot_id", "task_id",
  "dispatch_id", "attempt", "worker_id",
] as const;

function nonEmptyPhaseString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key} is an unknown field`);
  }
}

function validatePhaseUpstreamBindings(
  value: unknown,
  phase: WorkspacePhase,
  issues: string[],
  path: string,
): value is PhaseUpstreamVersionBinding[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return false;
  }
  const expectedPhases: WorkspacePhase[] = phase === "specify" ? [] : phase === "plan" ? ["specify"] : ["specify", "plan"];
  if (value.length !== expectedPhases.length) issues.push(`${path} must contain exactly ${expectedPhases.length} upstream bindings`);
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      issues.push(`${entryPath} must be an object`);
      continue;
    }
    strictKeys(entry, ["artifact_id", "version", "hash"], entryPath, issues);
    if (!nonEmptyPhaseString(entry.artifact_id)) issues.push(`${entryPath}.artifact_id must be a non-empty string`);
    if (!Number.isSafeInteger(entry.version) || (entry.version as number) < 1) issues.push(`${entryPath}.version must be a positive safe integer`);
    if (!isSha256Hex(entry.hash)) issues.push(`${entryPath}.hash must be a SHA-256 digest`);
    if (typeof entry.artifact_id === "string") {
      if (seen.has(entry.artifact_id)) issues.push(`${entryPath}.artifact_id is duplicated`);
      seen.add(entry.artifact_id);
      const expectedPhase = expectedPhases[index];
      if (expectedPhase && Number.isSafeInteger(entry.version) && entry.artifact_id !== `${expectedPhase}.v${entry.version}`) {
        issues.push(`${entryPath}.artifact_id does not match its upstream phase/version`);
      }
    }
  }
  return value.every((entry): entry is PhaseUpstreamVersionBinding => isRecord(entry)
    && typeof entry.artifact_id === "string"
    && Number.isSafeInteger(entry.version) && (entry.version as number) >= 1
    && isSha256Hex(entry.hash));
}

function validatePhaseArtifactEnvelope(
  value: unknown,
  options: { projectRoot: string; featureId: string; runKey?: string; pinnedRoot: PinnedProjectRoot },
): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["phase artifact must be an object"];
  strictKeys(value, PHASE_ARTIFACT_FIELDS, "phase artifact", issues);
  if (value.schema_version !== 1) issues.push("phase artifact.schema_version must be 1");
  if (!isSafeFeatureId(value.feature_id)) issues.push("phase artifact.feature_id must be a safe feature id");
  if (value.feature_id !== options.featureId) issues.push("phase artifact.feature_id does not match the selected feature");
  if (!nonEmptyPhaseString(value.run_key)) issues.push("phase artifact.run_key must be a non-empty string");
  if (options.runKey !== undefined && value.run_key !== options.runKey) issues.push("phase artifact.run_key does not match the selected run");
  if (!nonEmptyPhaseString(value.request_id)) issues.push("phase artifact.request_id must be a non-empty string");
  if (!isSha256Hex(value.request_digest)) issues.push("phase artifact.request_digest must be a SHA-256 digest");
  if (!PHASES.includes(value.phase as WorkspacePhase)) issues.push("phase artifact.phase is unsupported");
  const phase = value.phase as WorkspacePhase;
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) issues.push("phase artifact.version must be a positive safe integer");
  const version = value.version as number;
  const expectedArtifactId = PHASES.includes(phase) && Number.isSafeInteger(version) && version >= 1 ? `${phase}.v${version}` : null;
  if (!nonEmptyPhaseString(value.artifact_id)) issues.push("phase artifact.artifact_id must be a non-empty string");
  if (expectedArtifactId && value.artifact_id !== expectedArtifactId) issues.push("phase artifact.artifact_id does not match phase/version");
  const expectedSourceId = PHASES.includes(phase) ? PHASE_SOURCE_ARTIFACT[phase] : null;
  if (!nonEmptyPhaseString(value.source_artifact_id)) issues.push("phase artifact.source_artifact_id must be a non-empty string");
  if (expectedSourceId && value.source_artifact_id !== expectedSourceId) issues.push("phase artifact.source_artifact_id does not match phase");
  if (!nonEmptyPhaseString(value.dispatch_id)) issues.push("phase artifact.dispatch_id must be a non-empty string");
  if (!nonEmptyPhaseString(value.capability_epoch)) issues.push("phase artifact.capability_epoch must be a non-empty string");
  if (!isSha256Hex(value.source_artifact_hash)) issues.push("phase artifact.source_artifact_hash must be a SHA-256 digest");
  if (!isSha256Hex(value.template_hash)) issues.push("phase artifact.template_hash must be a SHA-256 digest");
  if (!isSha256Hex(value.language_hash)) issues.push("phase artifact.language_hash must be a SHA-256 digest");
  if (!nonEmptyPhaseString(value.created_at) || Number.isNaN(Date.parse(value.created_at as string))) issues.push("phase artifact.created_at must be a valid timestamp");

  if (!isRecord(value.work_identity)) {
    issues.push("phase artifact.work_identity must be an object");
  } else {
    strictKeys(value.work_identity, WORK_IDENTITY_FIELDS, "phase artifact.work_identity", issues);
    for (const field of WORK_IDENTITY_FIELDS) {
      if (field !== "attempt" && !nonEmptyPhaseString(value.work_identity[field])) issues.push(`phase artifact.work_identity.${field} must be a non-empty string`);
    }
    if (!Number.isSafeInteger(value.work_identity.attempt) || (value.work_identity.attempt as number) < 1) issues.push("phase artifact.work_identity.attempt must be a positive safe integer");
    if (value.work_identity.dispatch_id !== value.dispatch_id) issues.push("phase artifact.work_identity.dispatch_id does not match dispatch_id");
    if (PHASES.includes(phase) && value.work_identity.stage_cursor !== phase) issues.push("phase artifact.work_identity.stage_cursor does not match phase");
    if (value.work_identity.capability_epoch !== value.capability_epoch) issues.push("phase artifact.work_identity.capability_epoch does not match capability_epoch");
  }

  let documentPaths: string[] = [];
  let documentHashes: Record<string, unknown> = {};
  if (!Array.isArray(value.document_paths) || value.document_paths.length === 0 || value.document_paths.length > 64) {
    issues.push("phase artifact.document_paths must contain 1..64 paths");
  } else {
    documentPaths = value.document_paths.filter((path): path is string => typeof path === "string");
    const seen = new Set<string>();
    for (const [index, path] of value.document_paths.entries()) {
      if (!isSafeRelativePath(path)) issues.push(`phase artifact.document_paths[${index}] must be a safe relative path`);
      if (typeof path === "string" && seen.has(path)) issues.push(`phase artifact.document_paths[${index}] is duplicated`);
      if (typeof path === "string") seen.add(path);
      if (index > 0 && typeof path === "string" && typeof value.document_paths[index - 1] === "string" && value.document_paths[index - 1]!.localeCompare(path) > 0) issues.push("phase artifact.document_paths must be sorted");
    }
  }
  if (!isRecord(value.document_hashes)) {
    issues.push("phase artifact.document_hashes must be an object");
  } else {
    documentHashes = value.document_hashes;
    for (const [path, hash] of Object.entries(documentHashes)) {
      if (!isSafeRelativePath(path)) issues.push(`phase artifact.document_hashes.${path} must be a safe relative path`);
      if (!isSha256Hex(hash)) issues.push(`phase artifact.document_hashes.${path} must be a SHA-256 digest`);
    }
    if (documentPaths.length > 0 && (Object.keys(documentHashes).length !== documentPaths.length || documentPaths.some((path) => !Object.prototype.hasOwnProperty.call(documentHashes, path)))) {
      issues.push("phase artifact.document_hashes keys must exactly match document_paths");
    }
  }

  if (!isRecord(value.semantic_section_hashes) || Object.keys(value.semantic_section_hashes).length === 0) {
    issues.push("phase artifact.semantic_section_hashes must be a non-empty object");
  } else {
    const markers = Object.keys(value.semantic_section_hashes);
    for (const [marker, hash] of Object.entries(value.semantic_section_hashes)) {
      if (!marker.trim()) issues.push("phase artifact.semantic_section_hashes contains an empty marker");
      if (!isSha256Hex(hash)) issues.push(`phase artifact.semantic_section_hashes.${marker} must be a SHA-256 digest`);
    }
    for (let index = 1; index < markers.length; index += 1) if (markers[index - 1]!.localeCompare(markers[index]!) > 0) issues.push("phase artifact.semantic_section_hashes must be sorted");
  }

  const upstreamValid = PHASES.includes(phase) && validatePhaseUpstreamBindings(value.upstream_versions, phase, issues, "phase artifact.upstream_versions");
  if (!PHASES.includes(phase)) issues.push("phase artifact.upstream_versions cannot be validated for an unsupported phase");
  issues.push(...validateConstitutionBinding(value.constitution_binding, "phase artifact.constitution_binding"));

  if (!isRecord(value.source_artifact)) {
    issues.push("phase artifact.source_artifact must be an object");
  } else {
    const source = value.source_artifact;
    if (source.schema_version !== 1) issues.push("phase artifact.source_artifact.schema_version must be 1");
    if (source.feature_id !== options.featureId || source.run_key !== value.run_key || source.version !== value.version) issues.push("phase artifact.source_artifact identity/version does not match the envelope");
    if (!isRecord(source.worker)) {
      issues.push("phase artifact.source_artifact.worker must be an object");
    } else {
      strictKeys(source.worker, ["role", "agent", "dispatch_id"], "phase artifact.source_artifact.worker", issues);
      for (const field of ["role", "agent", "dispatch_id"] as const) if (!nonEmptyPhaseString(source.worker[field])) issues.push(`phase artifact.source_artifact.worker.${field} must be a non-empty string`);
      if (source.worker.dispatch_id !== value.dispatch_id) issues.push("phase artifact.source_artifact.worker.dispatch_id does not match dispatch_id");
    }
    if (!isSha256Hex(source.document_sha256)) issues.push("phase artifact.source_artifact.document_sha256 must be a SHA-256 digest");
    if (documentPaths.length > 0 && PHASES.includes(phase)) {
      const primaryPath = PHASE_DOCUMENT[phase];
      if (documentHashes[primaryPath] !== source.document_sha256) issues.push("phase artifact.source_artifact.document_sha256 does not match the primary document hash");
    }
    issues.push(...validateConstitutionBinding(source.constitution_binding, "phase artifact.source_artifact.constitution_binding"));
    if (!same(source.constitution_binding, value.constitution_binding)) issues.push("phase artifact source constitution binding does not match the envelope");
    const sourceUpstreamValid = PHASES.includes(phase) && validatePhaseUpstreamBindings(source.upstream_versions, phase, issues, "phase artifact.source_artifact.upstream_versions");
    if (sourceUpstreamValid && upstreamValid && !same(source.upstream_versions, value.upstream_versions)) issues.push("phase artifact source upstream bindings do not match the envelope");
    if (isSha256Hex(value.source_artifact_hash) && digestOf(source) !== value.source_artifact_hash) issues.push("phase artifact.source_artifact_hash does not match source_artifact");
  }

  if (upstreamValid && PHASES.includes(phase) && typeof value.run_key === "string" && typeof value.feature_id === "string") {
    const migrated = isRecord(value.source_artifact) && value.source_artifact.source_kind === "legacy";
    for (const entry of value.upstream_versions as PhaseUpstreamVersionBinding[]) {
      const upstream = readVersion(options.projectRoot, options.featureId, entry.artifact_id, value.run_key, options.pinnedRoot);
      if (!upstream || (migrated ? semanticArtifactHash(upstream) : digestOf(upstream)) !== entry.hash) {
        issues.push(`phase artifact upstream hash does not match '${entry.artifact_id}'`);
      }
    }
  }
  return issues;
}

function phaseArtifactIdentity(value: PersistedPhaseResultEnvelope): Record<string, unknown> {
  const { created_at: _createdAt, ...identity } = value;
  return identity;
}

function phaseArtifactMatchesCandidate(existing: PersistedPhaseResultEnvelope, candidate: PersistedPhaseResultEnvelope): boolean {
  return same(phaseArtifactIdentity(existing), phaseArtifactIdentity(candidate));
}

function readVersion(projectRoot: string, featureId: string, artifactId: string, runKey: string | undefined, pinnedRoot: PinnedProjectRoot): PersistedPhaseResultEnvelope | null {
  const parsedId = /^(specify|plan|tasks)\.v([1-9][0-9]*)$/.exec(artifactId);
  if (!parsedId) return null;
  const relativePath = join(".work-state", "features", featureId, "artifacts", artifactId + ".json");
  const value = readPinnedRelativeArtifact<unknown>(pinnedRoot, relativePath);
  if (!isRecord(value)) return null;
  const issues = validatePhaseArtifactEnvelope(value, { projectRoot, featureId, ...(runKey !== undefined ? { runKey } : {}), pinnedRoot });
  if (issues.length > 0) return null;
  return value as unknown as PersistedPhaseResultEnvelope;
}
/**
 * Read one immutable phase artifact through the canonical envelope validator.
 *
 * Impact assessment must never infer semantics from an arbitrary JSON object:
 * this reader verifies the typed source model, the envelope copy, every
 * semantic-section digest, and the exact bytes of each canonical document.
 */
export function readCanonicalPhaseArtifact(
  projectRoot: string,
  input: { feature_id: string; run_key: string; phase: WorkspacePhase; version: number },
  pinnedRoot: PinnedProjectRoot,
): PersistedPhaseResultEnvelope | null {
  if (!isSafeFeatureId(input.feature_id) || !Number.isSafeInteger(input.version) || input.version < 1 || !PHASES.includes(input.phase)) return null;
  const artifactId = `${input.phase}.v${input.version}`;
  const artifact = readVersion(projectRoot, input.feature_id, artifactId, input.run_key, pinnedRoot);
  if (!artifact || artifact.feature_id !== input.feature_id || artifact.run_key !== input.run_key
    || artifact.phase !== input.phase || artifact.version !== input.version || artifact.artifact_id !== artifactId) return null;
  if (!isRecord(artifact.source_artifact)) return null;
  if (!isSha256Hex(artifact.source_artifact_hash) || digestOf(artifact.source_artifact) !== artifact.source_artifact_hash) return null;
  const sourceModel = canonicalSourceModel(artifact.phase, artifact.source_artifact, {
    featureId: input.feature_id,
    runKey: input.run_key,
    version: input.version,
    dispatchId: artifact.dispatch_id,
    constitution: artifact.constitution_binding,
    upstream: artifact.upstream_versions,
  });
  if (!sourceModel.ok || !same(sourceModel.value, artifact.semantic_model)) return null;
  const expectedSemanticSectionHashes = Object.fromEntries(
    Object.entries(sourceModel.value.sections)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([marker, content]) => [marker, sha256Hex(content)]),
  );
  if (!same(expectedSemanticSectionHashes, artifact.semantic_section_hashes)) return null;
  const documentContents: Record<string, string> = {};
  for (const documentPath of artifact.document_paths) {
    try {
      const bytes = pinnedRoot.readFile(join("specs", input.feature_id, documentPath), { maxBytes: MAX_PHASE_INPUT_BYTES }).bytes;
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!pinnedRoot.isStable()) return null;
      documentContents[documentPath] = content;
      if (sha256Hex(content) !== artifact.document_hashes[documentPath]) return null;
    } catch {
      return null;
    }
  }
  const expectedRequestDigest = digestOf({
    feature_id: artifact.feature_id,
    run_key: artifact.run_key,
    phase: artifact.phase,
    version: artifact.version,
    request_id: artifact.request_id,
    dispatch_id: artifact.dispatch_id,
    source_artifact: artifact.source_artifact,
    documents: artifact.document_paths.map((path) => ({ path, content: documentContents[path] })),
    semantic_sections: sourceModel.value.sections,
    constitution_binding: artifact.constitution_binding,
    upstream_versions: artifact.upstream_versions,
    template_hash: artifact.template_hash,
    language_hash: artifact.language_hash,
  });
  if (artifact.request_digest !== expectedRequestDigest) return null;
  const primaryPath = PHASE_DOCUMENT[input.phase];
  const primaryContent = documentContents[primaryPath];
  const workspace = resolveFeatureWorkspace(pinnedRoot.canonical_root, { feature_id: input.feature_id, run_key: input.run_key }, { lexical_root: pinnedRoot.lexical_root, canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino, pinned_root: pinnedRoot }, { persistMigration: false });
  if (!workspace.ok) return null;
  const legacyFallback = isLegacyMaterializedArtifact(workspace.value, artifact);
  const phaseTemplate = legacyFallback ? null : resolveNativePhaseTemplate(pinnedRoot.canonical_root, workspace.value, input.phase, pinnedRoot);
  const selectedTemplate = phaseTemplate?.ok === true ? phaseTemplate.value : undefined;
  if (primaryContent === undefined
    || (!legacyFallback && selectedTemplate === undefined)
    || artifact.source_artifact.document_sha256 !== artifact.document_hashes[primaryPath]
    || primaryContent !== renderCanonicalPhaseDocument(input.phase, sourceModel.value, selectedTemplate)) return null;
  const materialized = revalidateMaterializedDocumentsPinned(pinnedRoot, {
    feature_id: input.feature_id,
    phase: input.phase,
    version: input.version,
  });
  if (!materialized.ok) return null;
  const manifestDocuments = materialized.value.documents;
  const manifestPaths = Object.keys(manifestDocuments).sort((left, right) => left.localeCompare(right));
  const artifactPaths = [...artifact.document_paths].sort((left, right) => left.localeCompare(right));
  if (!same(manifestPaths, artifactPaths)) return null;
  for (const documentPath of artifactPaths) {
    const manifestDocument = manifestDocuments[documentPath];
    if (!manifestDocument
      || manifestDocument.expected_sha256 !== artifact.document_hashes[documentPath]
      || !manifestDocument.matches) return null;
  }
  const binding = materialized.value.binding;
  if (!binding
    || binding.feature_id !== artifact.feature_id
    || binding.run_key !== artifact.run_key
    || binding.phase !== artifact.phase
    || binding.version !== artifact.version
    || binding.artifact_id !== artifact.artifact_id
    || binding.worker.dispatch_id !== artifact.dispatch_id
    || !same(binding.worker.work_identity, artifact.work_identity)
    || !same(binding.constitution_binding, artifact.constitution_binding)
    || !same(binding.upstream_versions, artifact.upstream_versions)) return null;
  return pinnedRoot.isStable() ? artifact : null;
}

export const MAX_PHASE_STRING_BYTES = 32_768;
export const MAX_PHASE_ARRAY_ITEMS = 4_096;
export const MAX_PHASE_OBJECT_KEYS = 128;
export const MAX_PHASE_RESULT_BYTES = 2 * 1024 * 1024;
export const MAX_PHASE_SEMANTIC_SECTION_KEY_BYTES = 256;
export const MAX_PHASE_SEMANTIC_SECTION_VALUE_BYTES = MAX_PHASE_STRING_BYTES;
export const MAX_PHASE_SEMANTIC_SECTIONS_AGGREGATE_BYTES = 1 * 1024 * 1024;
const MAX_PHASE_DEPTH = 12;

function phaseReadableDocumentBytesIssue(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const [index, document] of value.entries()) {
    if (!isRecord(document) || typeof document.content !== "string") continue;
    const bytes = Buffer.byteLength(document.content, "utf8");
    if (bytes > MAX_PHASE_INPUT_BYTES) {
      const path = typeof document.path === "string" ? ` '${document.path}'` : ` at index ${index}`;
      return `phase document${path} exceeds the ${MAX_PHASE_INPUT_BYTES}-byte UTF-8 limit`;
    }
  }
  return null;
}

function phaseWorkerResultBoundsIssue(value: unknown): string | null {
  if (!isRecord(value)) return "phase result must be an object";
  const sections = value.semantic_sections;
  if (!isRecord(sections)) return "semantic_sections must be an object";
  let sectionAggregateBytes = 0;
  for (const [key, section] of Object.entries(sections)) {
    const keyBytes = Buffer.byteLength(key, "utf8");
    const sectionBytes = typeof section === "string" ? Buffer.byteLength(section, "utf8") : 0;
    if (keyBytes > MAX_PHASE_SEMANTIC_SECTION_KEY_BYTES) return "semantic_sections contains an overlong key";
    if (typeof section !== "string" || sectionBytes > MAX_PHASE_SEMANTIC_SECTION_VALUE_BYTES) return "semantic_sections contains an overlong value";
    sectionAggregateBytes += keyBytes + sectionBytes;
    if (sectionAggregateBytes > MAX_PHASE_SEMANTIC_SECTIONS_AGGREGATE_BYTES) return "semantic_sections exceeds the aggregate key/value budget";
  }
  const documentIssue = phaseReadableDocumentBytesIssue(value.documents);
  if (documentIssue) return documentIssue;
  const pending: unknown[] = [value];
  let aggregateBytes = 0;
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > MAX_PHASE_TRANSACTION_NODES) return "phase result exceeds the aggregate structure budget";
    if (typeof current === "string") {
      aggregateBytes += Buffer.byteLength(current, "utf8");
      if (aggregateBytes > MAX_PHASE_RESULT_BYTES) return "phase result exceeds the aggregate serialized-value budget";
      continue;
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_PHASE_ARRAY_ITEMS) return "phase result contains too many array items";
      pending.push(...current);
      continue;
    }
    if (isRecord(current)) {
      const keys = Object.keys(current);
      if (keys.length > MAX_PHASE_OBJECT_KEYS) return "phase result contains too many object keys";
      for (const key of keys) {
        aggregateBytes += Buffer.byteLength(key, "utf8");
        if (aggregateBytes > MAX_PHASE_RESULT_BYTES) return "phase result exceeds the aggregate serialized-value budget";
        pending.push(current[key]);
      }
    }
  }
  return null;
}


function boundedPhaseShape(value: unknown): string | null {
  type WalkContext = "normal" | "documents" | "document_entry" | "document_content";
  const walk = (current: unknown, depth: number, context: WalkContext): string | null => {
    if (depth > MAX_PHASE_DEPTH) return "phase input exceeds the bounded nesting depth";
    if (typeof current === "string") {
      const limit = context === "document_content" ? MAX_PHASE_INPUT_BYTES : MAX_PHASE_STRING_BYTES;
      return Buffer.byteLength(current, "utf8") > limit ? (context === "document_content" ? "phase document content exceeds the " + MAX_PHASE_INPUT_BYTES + "-byte UTF-8 limit" : "phase input contains an overlong string") : null;
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_PHASE_ARRAY_ITEMS) return "phase input contains too many array items";
      const itemContext: WalkContext = context === "documents" ? "document_entry" : context === "document_entry" ? "normal" : context;
      for (const item of current) { const issue = walk(item, depth + 1, itemContext); if (issue) return issue; }
      return null;
    }
    if (isRecord(current)) {
      const keys = Object.keys(current);
      if (keys.length > MAX_PHASE_OBJECT_KEYS) return "phase input contains too many object keys";
      for (const key of keys) {
        if (Buffer.byteLength(key, "utf8") > MAX_PHASE_SEMANTIC_SECTION_KEY_BYTES) return "phase input contains an overlong object key";
        const childContext: WalkContext = context === "normal" && key === "documents"
          ? "documents"
          : context === "document_entry" && key === "content" ? "document_content" : "normal";
        const issue = walk(current[key], depth + 1, childContext);
        if (issue) return issue;
      }
    }
    return null;
  };
  return walk(value, 0, "normal");
}


function cloneBoundedPhaseInput<T>(value: T): { ok: true; value: T } | { ok: false; error: string } {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return { ok: false, error: "phase input must be serializable" }; }
  if (typeof serialized !== "string") return { ok: false, error: "phase input must be a serializable object" };
  if (Buffer.byteLength(serialized, "utf8") > MAX_PHASE_RESULT_BYTES) return { ok: false, error: "phase input exceeds the bounded serialized-size budget" };
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { return { ok: false, error: "phase input must contain valid JSON values" }; }
  const shapeError = boundedPhaseShape(parsed);
  return shapeError ? { ok: false, error: shapeError } : { ok: true, value: parsed as T };
}


const MAX_PHASE_VALIDATION_WORK = 1_048_576;

/** Build the exact validation indexes before entering the durable state lock. */
function phaseValidationWorkIssue(value: unknown): NativeValidationPreparation {
  if (!isRecord(value)) return { ok: false, error: "validation payload must be an object" };
  return prepareNativePhaseValidation(value as unknown as NativePhaseValidationInput, MAX_PHASE_VALIDATION_WORK);
}

function malformedNativePhaseValidation(input: SpecificationPhaseValidationInput, reason: string): PhaseValidationResult {
  const payload: Record<string, unknown> = isRecord(input.validation) ? input.validation as unknown as Record<string, unknown> : {};
  return {
    validation_id: typeof payload.validation_id === "string" ? payload.validation_id : "validation." + input.phase + ".malformed",
    phase: input.phase,
    artifact_version: input.phase + ".v" + (typeof payload.version === "number" ? payload.version : 0),
    status: "fail",
    checks: [{ check_id: "validation_input", status: "fail", evidence: reason, remediation: PHASE_COMMAND[input.phase] + " --feature " + input.feature_id }],
    blocking_findings: [{ code: "SPEC_VALIDATION_INPUT_MALFORMED", severity: "blocking", subject_id: null, message: reason, evidence_refs: [], remediation: PHASE_COMMAND[input.phase] + " --feature " + input.feature_id }],
    warnings: [],
    constitution: { binding: isRecord(payload.constitution_binding) ? payload.constitution_binding as unknown as ConstitutionBinding : {} as ConstitutionBinding, principles: [] },
    traceability_summary: null,
    validator_version: "specification-validation@3",
    validated_at: new Date().toISOString(),
  };
}

const MODEL_KEYS: Readonly<Record<WorkspacePhase, readonly string[]>> = {
  specify: ["schema_version", "feature_id", "run_key", "phase", "version", "worker", "constitution_binding", "upstream_versions", "sections", "requirements", "decisions", "tasks", "verification", "contradictions", "constitution_principles"],
  plan: ["schema_version", "feature_id", "run_key", "phase", "version", "worker", "constitution_binding", "upstream_versions", "sections", "requirements", "decisions", "tasks", "verification", "contradictions", "constitution_principles"],
  tasks: ["schema_version", "feature_id", "run_key", "phase", "version", "worker", "constitution_binding", "upstream_versions", "sections", "requirements", "decisions", "tasks", "verification", "contradictions", "constitution_principles"],
};
const MODEL_ALLOWED_PHASES: Readonly<Record<WorkspacePhase, string>> = { specify: "specify", plan: "plan", tasks: "tasks" };
const NATIVE_PHASE_SECTIONS: Readonly<Record<WorkspacePhase, readonly string[]>> = {
  specify: ["problem", "scope", "non_goals", "actors", "journeys", "requirements", "edge_cases", "assumptions", "dependencies", "success_criteria"],
  plan: ["repository_grounding", "decisions", "alternatives", "contracts", "data_flow", "control_flow", "migration", "security", "operations", "verification_strategy", "constitution_recheck"],
  tasks: ["task_graph", "dependencies", "expected_outcomes"],
};
const MODEL_REQUIREMENT_KEYS = ["requirement_id", "statement", "acceptance_ids", "source_refs", "testable", "untestable_reason"] as const;
const MODEL_DECISION_KEYS = ["decision_id", "decision", "rationale", "requirement_ids"] as const;
const MODEL_TASK_KEYS = ["id", "title", "requirement_ids", "acceptance_ids", "decision_ids", "verification_ids", "depends_on", "expected_outcome", "affected_scope", "completion_evidence", "parallel_safe"] as const;
const MODEL_VERIFICATION_KEYS = ["verification_id", "requirement_ids", "acceptance_ids", "task_ids", "observable_behavior", "expected_evidence"] as const;
const MODEL_CONTRADICTION_KEYS = ["contradiction_id", "subject_ids", "status", "assessment", "evidence"] as const;
const MODEL_PRINCIPLE_KEYS = ["principle_id", "title", "applicability", "status", "evidence", "binding"] as const;

function phaseHeadingLabel(key: string): string {
  return key.split("_").map((part) => part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function exactModelKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function exactRecordKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && exactModelKeys(value, keys);
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function validSemanticModelRows(model: Record<string, unknown>): boolean {
  if (!Array.isArray(model.requirements) || !Array.isArray(model.decisions) || !Array.isArray(model.tasks) || !Array.isArray(model.verification) || !Array.isArray(model.contradictions) || !Array.isArray(model.constitution_principles)) return false;
  if (model.requirements.length > MAX_PHASE_ARRAY_ITEMS || model.decisions.length > MAX_PHASE_ARRAY_ITEMS || model.tasks.length > MAX_PHASE_ARRAY_ITEMS || model.verification.length > MAX_PHASE_ARRAY_ITEMS || model.contradictions.length > MAX_PHASE_ARRAY_ITEMS || model.constitution_principles.length > MAX_PHASE_ARRAY_ITEMS) return false;
  const requirementIds = new Set<string>();
  const acceptanceIds = new Set<string>();
  for (const row of model.requirements) {
    if (!exactRecordKeys(row, MODEL_REQUIREMENT_KEYS) || !nonEmptyPhaseString(row.requirement_id) || requirementIds.has(row.requirement_id) || !nonEmptyPhaseString(row.statement) || !nonEmptyStringArray(row.acceptance_ids) || !nonEmptyStringArray(row.source_refs) || typeof row.testable !== "boolean" || (row.untestable_reason !== null && !nonEmptyPhaseString(row.untestable_reason))) return false;
    requirementIds.add(row.requirement_id);
    for (const acceptance of row.acceptance_ids) acceptanceIds.add(acceptance);
  }
  const decisionIds = new Set<string>();
  for (const row of model.decisions) {
    if (!exactRecordKeys(row, MODEL_DECISION_KEYS) || !nonEmptyPhaseString(row.decision_id) || decisionIds.has(row.decision_id) || !nonEmptyPhaseString(row.decision) || !nonEmptyPhaseString(row.rationale) || !nonEmptyStringArray(row.requirement_ids) || row.requirement_ids.some((id: unknown) => typeof id !== "string" || !requirementIds.has(id))) return false;
    decisionIds.add(row.decision_id);
  }
  const taskIds = new Set<string>();
  const verificationIds = new Set<string>();
  for (const row of model.verification) {
    if (!exactRecordKeys(row, MODEL_VERIFICATION_KEYS) || !nonEmptyPhaseString(row.verification_id) || verificationIds.has(row.verification_id) || !nonEmptyStringArray(row.requirement_ids) || !nonEmptyStringArray(row.acceptance_ids) || !Array.isArray(row.task_ids) || row.task_ids.some((id) => typeof id !== "string" || id.trim().length === 0) || !nonEmptyPhaseString(row.expected_evidence) || typeof row.observable_behavior !== "boolean") return false;
    verificationIds.add(row.verification_id);
  }
  for (const row of model.tasks) {
    if (!exactRecordKeys(row, MODEL_TASK_KEYS) || !nonEmptyPhaseString(row.id) || taskIds.has(row.id) || !nonEmptyPhaseString(row.title) || !nonEmptyStringArray(row.requirement_ids) || row.requirement_ids.some((id: unknown) => typeof id !== "string" || !requirementIds.has(id)) || !nonEmptyStringArray(row.acceptance_ids) || row.acceptance_ids.some((id: unknown) => typeof id !== "string" || !acceptanceIds.has(id)) || !nonEmptyStringArray(row.decision_ids) || row.decision_ids.some((id: unknown) => typeof id !== "string" || !decisionIds.has(id)) || !nonEmptyStringArray(row.verification_ids) || row.verification_ids.some((id: unknown) => typeof id !== "string" || !verificationIds.has(id)) || !Array.isArray(row.depends_on) || row.depends_on.some((id) => typeof id !== "string") || !nonEmptyPhaseString(row.expected_outcome) || !nonEmptyStringArray(row.affected_scope) || !nonEmptyStringArray(row.completion_evidence) || typeof row.parallel_safe !== "boolean") return false;
    taskIds.add(row.id);
  }
  for (const row of model.verification) {
    if (row.requirement_ids.some((id: unknown) => typeof id !== "string" || !requirementIds.has(id)) || row.acceptance_ids.some((id: unknown) => typeof id !== "string" || !acceptanceIds.has(id)) || row.task_ids.some((id: unknown) => typeof id !== "string" || !taskIds.has(id))) return false;
  }
  for (const row of model.tasks) if (row.depends_on.some((id: unknown) => typeof id !== "string" || !taskIds.has(id))) return false;
  const contradictionIds = new Set<string>();
  for (const row of model.contradictions) {
    if (!exactRecordKeys(row, MODEL_CONTRADICTION_KEYS) || !nonEmptyPhaseString(row.contradiction_id) || contradictionIds.has(row.contradiction_id) || !nonEmptyStringArray(row.subject_ids) || !["resolved", "accepted", "unresolved"].includes(String(row.status)) || !nonEmptyPhaseString(row.assessment) || !nonEmptyPhaseString(row.evidence)) return false;
    contradictionIds.add(row.contradiction_id);
  }
  const principleIds = new Set<string>();
  for (const row of model.constitution_principles) {
    if (!exactRecordKeys(row, MODEL_PRINCIPLE_KEYS) || !nonEmptyPhaseString(row.principle_id) || !nonEmptyPhaseString(row.title) || principleIds.has(row.principle_id) || !["applicable", "not_applicable"].includes(String(row.applicability)) || !["pass", "fail", "not_applicable"].includes(String(row.status)) || !nonEmptyPhaseString(row.evidence) || !same(row.binding, model.constitution_binding)) return false;
    principleIds.add(row.principle_id);
  }
  return true;
}

const WORKER_RESULT_KEYS = ["input_ref", "input_digest", "sections", "requirements", "decisions", "tasks", "verification", "contradictions", "constitution_principles"] as const;
const WORKER_PRINCIPLE_KEYS = ["principle_id", "applicability", "status", "evidence"] as const;

function hydrateNativeSpecificationWorkerResult(
  phase: WorkspacePhase,
  handoff: NativeSpecificationGenerationHandoff,
  raw: unknown,
  identities: readonly ConstitutionPrincipleIdentity[],
): { ok: true; value: SpecificationSemanticModel } | { ok: false; error: string } {
  if (!isRecord(raw) || !exactModelKeys(raw, WORKER_RESULT_KEYS)) return { ok: false, error: "worker_result keys must contain the exact generation binding and semantic fields" };
  if (raw.input_ref !== handoff.input_ref || raw.input_digest !== handoff.input_digest) return { ok: false, error: "worker_result generation binding does not match the current immutable dispatch" };
  if (!isRecord(raw.sections) || !exactModelKeys(raw.sections, NATIVE_PHASE_SECTIONS[phase]) || Object.values(raw.sections).some((value) => !nonEmptyPhaseString(value) || value.includes("\r"))) {
    return { ok: false, error: "worker_result sections do not match the authorized phase grammar" };
  }
  if (!Array.isArray(raw.constitution_principles) || raw.constitution_principles.length !== identities.length) return { ok: false, error: "worker_result constitution principle observations must cover every approved principle exactly once" };
  const observations = new Map<string, NativeSpecificationWorkerPrincipleObservation>();
  for (const observation of raw.constitution_principles) {
    if (!exactRecordKeys(observation, WORKER_PRINCIPLE_KEYS) || !nonEmptyPhaseString(observation.principle_id) || !["applicable", "not_applicable"].includes(String(observation.applicability)) || !["pass", "fail", "not_applicable"].includes(String(observation.status)) || !nonEmptyPhaseString(observation.evidence)) {
      return { ok: false, error: "worker_result contains a malformed constitution principle observation" };
    }
    if (observations.has(observation.principle_id)) return { ok: false, error: `worker_result contains duplicate constitution principle '${observation.principle_id}'` };
    if (!identities.some((identity) => identity.principle_id === observation.principle_id)) return { ok: false, error: `worker_result contains unknown constitution principle '${observation.principle_id}'` };
    observations.set(observation.principle_id, observation as unknown as NativeSpecificationWorkerPrincipleObservation);
  }
  const principleRows = identities.map((identity) => {
    const observation = observations.get(identity.principle_id);
    if (!observation) return null;
    return { ...observation, title: identity.title, binding: structuredClone(handoff.constitution_binding) };
  });
  if (principleRows.some((row) => row === null)) return { ok: false, error: "worker_result omits an approved constitution principle" };
  const model = {
    schema_version: 1 as const,
    feature_id: handoff.feature_id,
    run_key: handoff.run_key,
    phase,
    version: handoff.version,
    worker: { role: handoff.role, agent: handoff.agent, dispatch_id: handoff.dispatch_id },
    constitution_binding: structuredClone(handoff.constitution_binding),
    upstream_versions: structuredClone(handoff.upstream_versions),
    sections: structuredClone(raw.sections),
    requirements: structuredClone(raw.requirements),
    decisions: structuredClone(raw.decisions),
    tasks: structuredClone(raw.tasks),
    verification: structuredClone(raw.verification),
    contradictions: structuredClone(raw.contradictions),
    constitution_principles: principleRows,
  } as unknown as SpecificationSemanticModel;
  if (!validSemanticModelRows(model as unknown as Record<string, unknown>)) return { ok: false, error: "worker_result contains malformed, duplicate, or dangling semantic rows" };
  return { ok: true, value: model };
}

 function canonicalSourceModel(
  phase: WorkspacePhase,
  source: Record<string, unknown>,
  identity: { featureId: string; runKey: string; version: number; dispatchId: string; constitution: ConstitutionBinding; upstream: PhaseUpstreamVersionBinding[] },
): { ok: true; value: SpecificationSemanticModel } | { ok: false; error: string } {
  const candidate = source.semantic_model;
  if (candidate === undefined) return { ok: false, error: "phase source_artifact.semantic_model is required" };
  if (!isRecord(candidate) || !exactModelKeys(candidate, MODEL_KEYS[phase])) return { ok: false, error: "phase semantic_model keys do not match the complete typed artifact schema" };
  const schema = validateProducedArtifact("specification_phase_model", candidate);
  if (!schema.ok) return { ok: false, error: "phase semantic_model violates the complete typed artifact schema: " + schema.issues.map((issue) => issue.field + " " + issue.message).join("; ") };
  if (candidate.schema_version !== 1 || candidate.feature_id !== identity.featureId || candidate.run_key !== identity.runKey || candidate.phase !== MODEL_ALLOWED_PHASES[phase] || candidate.version !== identity.version) return { ok: false, error: "phase semantic_model identity/version binding is stale" };
  if (!isRecord(candidate.worker) || candidate.worker.dispatch_id !== identity.dispatchId) return { ok: false, error: "phase semantic_model worker dispatch binding is stale" };
  if (!same(candidate.constitution_binding, identity.constitution) || !same(candidate.upstream_versions, identity.upstream)) return { ok: false, error: "phase semantic_model constitution/upstream binding is stale" };
  const sections = candidate.sections;
  if (!isRecord(sections) || !exactModelKeys(sections, NATIVE_PHASE_SECTIONS[phase]) || Object.values(sections).some((value) => !nonEmptyPhaseString(value) || value.includes("\r"))) return { ok: false, error: "phase semantic_model sections do not match the complete phase grammar" };
  if (!validSemanticModelRows(candidate)) return { ok: false, error: "phase semantic_model contains malformed, duplicate, or dangling semantic rows" };
  return { ok: true, value: candidate as unknown as SpecificationSemanticModel };
}

/**
 * Exact native Specify → Plan → Tasks handoff derivation.
 *
 * This is deliberately pure: the engine supplies the three immutable phase
 * envelopes after reading them under its state/root lock. No phase, approval,
 * filesystem, or workspace state is inferred here. Keeping the mapping in one
 * place prevents executors from selecting their own requirements, decisions,
 * task graph, or evidence links.
 */
export interface NativeImplementationHandoffInput {
  workspace: FeatureWorkspace;
  run_key: string;
  phase_artifacts: {
    specify: PersistedPhaseResultEnvelope;
    plan: PersistedPhaseResultEnvelope;
    tasks: PersistedPhaseResultEnvelope;
  };
  /** Authenticated feature-state dispatch records, when deriving at a finalizer boundary. */
  phase_dispatches?: readonly DispatchRecord[];
}

function nativeHandoffIssue(message: string): never {
  throw new Error(`native implementation handoff derivation rejected: ${message}`);
}

function phaseArtifactForHandoff(
  input: NativeImplementationHandoffInput,
  phase: WorkspacePhase,
  artifact: PersistedPhaseResultEnvelope,
  expectedUpstream: PhaseUpstreamVersionBinding[],
  priorModels: SpecificationSemanticModel[],
): SpecificationSemanticModel {
  const workspace = input.workspace;
  const record = phaseRecord(workspace, phase);
  if (!record || record.status !== "approved" || record.current_version === null || record.approved_version !== record.current_version) {
    nativeHandoffIssue(`${phase} is not currently approved at one immutable version`);
  }
  const version = record.current_version!;
  if (
    artifact.feature_id !== workspace.feature_id
    || artifact.run_key !== input.run_key
    || artifact.phase !== phase
    || artifact.version !== version
    || artifact.artifact_id !== `${phase}.v${version}`
  ) {
    nativeHandoffIssue(`${phase} artifact identity/version is stale or foreign`);
  }
  if (record.validation_ref !== `validation.${phase}.v${version}` || record.checkpoint_ref !== `checkpoint.${phase}.v${version}`) {
    nativeHandoffIssue(`${phase} approval does not bind its current validation and checkpoint references`);
  }
  if (!isSha256Hex(artifact.source_artifact_hash) || artifact.source_artifact_hash !== digestOf(artifact.source_artifact)) {
    nativeHandoffIssue(`${phase} source artifact hash is invalid`);
  }
  if (!isSha256Hex(artifact.template_hash) || !isSha256Hex(artifact.language_hash) || typeof artifact.created_at !== "string" || Number.isNaN(Date.parse(artifact.created_at))) {
    nativeHandoffIssue(`${phase} presentation or timestamp binding is invalid`);
  }
  if (!isRecord(artifact.work_identity)) nativeHandoffIssue(`${phase} worker identity is missing`);
  const identity = artifact.work_identity;
  const sourceWorker = isRecord(artifact.source_artifact.worker) ? artifact.source_artifact.worker : null;
  if (!sourceWorker) nativeHandoffIssue(`${phase} source worker attribution is missing`);
  if (
    identity.dispatch_id !== artifact.dispatch_id
    || identity.stage_cursor !== phase
    || identity.capability_epoch !== artifact.capability_epoch
    || identity.slot_id !== sourceWorker.role
    || identity.worker_id !== sourceWorker.agent
    || sourceWorker.dispatch_id !== artifact.dispatch_id
  ) {
    nativeHandoffIssue(`${phase} worker ownership binding is inconsistent`);
  }
  if (input.phase_dispatches !== undefined) {
    const matchingDispatches = input.phase_dispatches.filter((dispatch) => dispatch.id === artifact.dispatch_id);
    const dispatch = matchingDispatches.length === 1 ? matchingDispatches[0] : undefined;
    if (!dispatch || dispatch.status !== "succeeded" || !dispatch.work_identity
      || canonicalJson(dispatch.work_identity) !== canonicalJson(identity)
      || dispatch.work_identity.run_id !== artifact.run_key
      || dispatch.work_identity.stage_cursor !== phase
      || dispatch.work_identity.capability_epoch !== artifact.capability_epoch
      || !dispatch.completion
      || dispatch.completion.dispatch_id !== dispatch.id
      || dispatch.completion.outcome !== "succeeded"
      || !dispatch.completion.artifact_ids.includes(artifact.artifact_id)
      || (dispatch.completion_envelope !== undefined && canonicalJson(dispatch.completion_envelope.identity) !== canonicalJson(identity))) {
      nativeHandoffIssue(`${phase} artifact is not bound to its authenticated succeeded phase dispatch`);
    }
    if (dispatch.work_identity.slot_id !== sourceWorker.role || dispatch.work_identity.worker_id !== sourceWorker.agent) {
      nativeHandoffIssue(`${phase} source worker attribution is not bound to its authenticated dispatch`);
    }
  }
  if (!same(artifact.upstream_versions, expectedUpstream)) nativeHandoffIssue(`${phase} upstream versions are stale or reordered`);
  if (!same(artifact.constitution_binding, workspace.constitution_binding)) nativeHandoffIssue(`${phase} constitution binding is stale`);
  if (validateConstitutionBinding(artifact.constitution_binding).length > 0) nativeHandoffIssue(`${phase} constitution binding is malformed`);
  if (!Array.isArray(artifact.document_paths) || artifact.document_paths.length === 0 || !artifact.document_paths.includes(PHASE_DOCUMENT[phase])) {
    nativeHandoffIssue(`${phase} readable document binding is missing`);
  }
  if (!isRecord(artifact.document_hashes) || artifact.document_paths.some((path) => !isSha256Hex(artifact.document_hashes[path]))) {
    nativeHandoffIssue(`${phase} readable document hashes are malformed`);
  }
  if (!same(artifact.semantic_model, artifact.source_artifact.semantic_model)) {
    nativeHandoffIssue(`${phase} envelope semantic model differs from its source artifact`);
  }
  const modelResult = canonicalSourceModel(phase, artifact.source_artifact, {
    featureId: artifact.feature_id,
    runKey: artifact.run_key,
    version: artifact.version,
    dispatchId: artifact.dispatch_id,
    constitution: artifact.constitution_binding,
    upstream: artifact.upstream_versions,
  });
  if (!modelResult.ok) nativeHandoffIssue(`${phase} semantic model is invalid: ${modelResult.error}`);
  if (!same(artifact.semantic_model, modelResult.value)) nativeHandoffIssue(`${phase} semantic model copy is tampered`);
  const upstreamIssue = phaseSemanticUpstreamIssue(phase, modelResult.value, priorModels);
  if (upstreamIssue) nativeHandoffIssue(upstreamIssue);
  return modelResult.value;
}

/**
 * Derive and freeze a ready native handoff from exactly the approved phase
 * envelopes. The returned value is suitable for the engine's immutable
 * artifact write; callers must still perform that write and workspace CAS.
 */
export function deriveNativeImplementationHandoff(input: NativeImplementationHandoffInput): ImplementationHandoff {
  const workspace = input.workspace;
  if (workspace.source_kind !== "native") nativeHandoffIssue("only native workspaces may use native phase handoff derivation");
  if (!isSafeFeatureId(workspace.feature_id)) nativeHandoffIssue("workspace feature id is unsafe");
  if (!workspace.constitution_binding || validateConstitutionBinding(workspace.constitution_binding).length > 0) {
    nativeHandoffIssue("workspace constitution binding is missing or malformed");
  }
  const artifacts = input.phase_artifacts;
  const specify = phaseArtifactForHandoff(input, "specify", artifacts.specify, [], []);
  const plan = phaseArtifactForHandoff(
    input,
    "plan",
    artifacts.plan,
    [{ artifact_id: artifacts.specify.artifact_id, version: artifacts.specify.version, hash: digestOf(artifacts.specify) }],
    [specify],
  );
  const tasks = phaseArtifactForHandoff(
    input,
    "tasks",
    artifacts.tasks,
    [
      { artifact_id: artifacts.specify.artifact_id, version: artifacts.specify.version, hash: digestOf(artifacts.specify) },
      { artifact_id: artifacts.plan.artifact_id, version: artifacts.plan.version, hash: digestOf(artifacts.plan) },
    ],
    [specify, plan],
  );
  const requirements: HandoffRequirement[] = specify.requirements.map((requirement) => ({
    requirement_id: requirement.requirement_id,
    statement: requirement.statement,
    acceptance_ids: [...requirement.acceptance_ids],
    source_refs: [...requirement.source_refs],
  }));
  const decisions: HandoffDecision[] = plan.decisions.map((decision) => ({
    decision_id: decision.decision_id,
    decision: decision.decision,
    rationale: decision.rationale,
    requirement_ids: [...decision.requirement_ids],
  }));
  const implementationTasks: ImplementationTask[] = tasks.tasks.map((task) => ({
    task_id: task.id,
    title: task.title,
    requirement_ids: [...task.requirement_ids],
    depends_on: [...task.depends_on],
    expected_outcome: task.expected_outcome,
    affected_scope: [...task.affected_scope],
    completion_evidence: [...task.completion_evidence],
    parallel_safe: task.parallel_safe,
  }));
  const verification: HandoffVerification[] = tasks.verification.map((item) => ({
    verification_id: item.verification_id,
    requirement_ids: [...item.requirement_ids],
    acceptance_ids: [...item.acceptance_ids],
    task_ids: [...item.task_ids],
    observable_behavior: item.observable_behavior,
    expected_evidence: item.expected_evidence,
  }));
  const unresolved = [...specify.contradictions, ...plan.contradictions, ...tasks.contradictions]
    .filter((contradiction) => contradiction.status === "unresolved")
    .map((contradiction) => contradiction.contradiction_id);
  if (unresolved.length > 0) nativeHandoffIssue(`unresolved contradictions remain: ${unresolved.join(", ")}`);
  const risks = [...new Map(
    [...specify.contradictions, ...plan.contradictions, ...tasks.contradictions]
      .filter((contradiction) => contradiction.status === "accepted")
      .map((contradiction) => [contradiction.contradiction_id, `${contradiction.contradiction_id}: ${contradiction.assessment}`]),
  ).values()].sort((left, right) => left.localeCompare(right, "en"));
  const specifySections = specify.sections as SpecifySemanticSections;
  const planSections = plan.sections as PlanSemanticSections;
  const phaseRecords = PHASES.map((phase) => phaseRecord(workspace, phase)!);
  const handoff = freezeImplementationHandoff({
    handoff_id: `${workspace.feature_id}.handoff.v${tasks.version}`,
    feature_id: workspace.feature_id,
    source_kind: "native",
    artifact_versions: PHASES.map((phase) => {
      const artifact = input.phase_artifacts[phase];
      return { artifact_id: artifact.artifact_id, kind: phase, version: artifact.version, sha256: digestOf(artifact) };
    }),
    scope: {
      in_scope: [specifySections.scope],
      out_of_scope: [specifySections.non_goals],
      constraints: [planSections.contracts, planSections.security],
    },
    requirements,
    decisions,
    tasks: implementationTasks,
    verification,
    validation_refs: phaseRecords.map((record) => record.validation_ref!),
    approval_refs: phaseRecords.map((record) => record.checkpoint_ref!),
    language: workspace.language.language,
    constitution_binding: structuredClone(workspace.constitution_binding!),
    constitution_impact_ref: null,
    risks,
    open_decisions: [],
    execution_choices: ["do-work", "cto"],
    import_snapshot_ref: null,
    compatibility_supplement_ref: null,
  });
  return handoff;
}
/**
 * Stable semantic identity used only for migrated upstream bindings.
 * Environment-specific legacy provenance (absolute roots and filesystem
 * identities) remains checked separately by the migration receipt/TOCTOU
 * guards and is intentionally excluded from this digest. The project-relative
 * source path and source bytes remain part of the identity.
 */
export function semanticArtifactHash(
  artifact: Pick<PersistedPhaseResultEnvelope, "semantic_model" | "source_artifact">,
): string {
  const source = isRecord(artifact.source_artifact)
    ? {
        source_kind: artifact.source_artifact.source_kind,
        source_path: artifact.source_artifact.source_path,
        source_sha256: artifact.source_artifact.source_sha256,
      }
    : null;
  return digestOf({ semantic_model: artifact.semantic_model, source });
}

function readPinnedUpstreamSemanticModels(
  projectRoot: string,
  featureId: string,
  runKey: string,
  bindings: PhaseUpstreamVersionBinding[],
  pinnedRoot: PinnedProjectRoot,
): { ok: true; value: SpecificationSemanticModel[] } | { ok: false; error: string } {
  const models: SpecificationSemanticModel[] = [];
  for (const binding of bindings) {
    const artifact = readVersion(projectRoot, featureId, binding.artifact_id, runKey, pinnedRoot);
    if (!artifact) return { ok: false, error: `required upstream artifact '${binding.artifact_id}' is missing or invalid` };
    const model = canonicalSourceModel(artifact.phase, artifact.source_artifact, {
      featureId: artifact.feature_id, runKey: artifact.run_key, version: artifact.version,
      dispatchId: artifact.dispatch_id, constitution: artifact.constitution_binding, upstream: artifact.upstream_versions,
    });
    if (!model.ok) return { ok: false, error: `required upstream artifact '${binding.artifact_id}' has no valid semantic model: ${model.error}` };
    models.push(model.value);
  }
  return { ok: true, value: models };
}

function phaseConstitutionPrincipleIssue(model: SpecificationSemanticModel, binding: ConstitutionBinding, identities: ConstitutionPrincipleIdentity[]): string | null {
  if (model.constitution_principles.length !== identities.length) return "phase constitution principle set must exactly match every H2 heading in the approved constitution";
  for (const [index, identity] of identities.entries()) {
    const principle = model.constitution_principles[index];
    if (!principle || principle.principle_id !== identity.principle_id || principle.title !== identity.title || !same(principle.binding, binding)) return `phase constitution principle ${identity.principle_id} is missing or bound to a different constitution`;
    if (!identity.optional && principle.applicability !== "applicable") return `constitution principle ${identity.principle_id} is not optional and cannot be marked not_applicable`;
    if (principle.applicability === "not_applicable" && !identity.optional) return `constitution principle ${identity.principle_id} cannot be marked not_applicable without an explicit optional marker`;
  }
  return null;
}

function modelPrincipleIdentity(model: SpecificationSemanticModel): Array<{ principle_id: string; title: string; applicability: string; binding: ConstitutionBinding }> {
  return model.constitution_principles.map((principle) => ({ principle_id: principle.principle_id, title: principle.title, applicability: principle.applicability, binding: principle.binding }));
}

/** Upstream semantic rows are immutable inputs, not worker-selected observations. */
function phaseSemanticUpstreamIssue(phase: WorkspacePhase, current: SpecificationSemanticModel, upstream: SpecificationSemanticModel[]): string | null {
  if (phase === "specify") return upstream.length === 0 ? null : "Specify cannot carry upstream semantic models";
  const specify = upstream.find((model) => model.phase === "specify");
  if (!specify) return `phase ${phase} is missing its immutable Specify semantic model`;
  if (!same(current.requirements, specify.requirements)) return `${phase} requirements must equal the approved Specify semantic model`;
  if (!same(current.contradictions, specify.contradictions)) return `${phase} contradictions must equal the approved Specify semantic model`;
  if (!same(modelPrincipleIdentity(current), modelPrincipleIdentity(specify))) return `${phase} constitution principle identities must equal the approved Specify semantic model`;
  if (phase === "tasks") {
    const plan = upstream.find((model) => model.phase === "plan");
    if (!plan) return "tasks is missing its immutable Plan semantic model";
    if (!same(current.decisions, plan.decisions)) return "tasks decisions must equal the approved Plan semantic model";
    if (!same(modelPrincipleIdentity(current), modelPrincipleIdentity(plan))) return "tasks constitution principle identities must equal the approved Plan semantic model";
  }
  return null;
}

/**
 * Render one canonical readable phase document. A configured feature/project
 * template is rendered exactly; an unconfigured shipped-default keeps the
 * legacy canonical layout for compatibility with existing artifacts. The full
 * semantic model is emitted once as canonical JSON in addition to its typed
 * section bodies.
 */
function renderSelectedPhaseTemplate(phase: WorkspacePhase, model: SpecificationSemanticModel, template: NativePhaseTemplate): string {
  const values: Record<string, string> = {
    FEATURE_NAME: model.feature_id,
    FEATURE_ID: model.feature_id,
    RUN_KEY: model.run_key,
    VERSION: String(model.version),
    WORKER_ROLE: model.worker.role,
    WORKER_AGENT: model.worker.agent,
    WORKER: model.worker.role + " (" + model.worker.agent + ")",
    DISPATCH_ID: model.worker.dispatch_id,
    CONSTITUTION: canonicalJson(model.constitution_binding),
    UPSTREAM_VERSIONS: canonicalJson(model.upstream_versions),
    ...Object.fromEntries(Object.entries(model.sections).map(([key, value]) => [key.toUpperCase(), value])),
  };
  let rendered = "";
  let cursor = 0;
  while (cursor < template.content.length) {
    const open = template.content.indexOf("{{", cursor);
    const close = template.content.indexOf("}}", cursor);
    if (open === -1) {
      if (close !== -1) throw new Error("selected " + phase + " template contains an unmatched interpolation delimiter");
      rendered += template.content.slice(cursor);
      cursor = template.content.length;
      break;
    }
    if (close !== -1 && close < open) throw new Error("selected " + phase + " template contains an unmatched interpolation delimiter");
    rendered += template.content.slice(cursor, open);
    const end = template.content.indexOf("}}", open + 2);
    if (end === -1) throw new Error("selected " + phase + " template contains an unmatched interpolation delimiter");
    const token = template.content.slice(open, end + 2);
    const key = token.slice(2, -2);
    const first = key[0] ?? "";
    if (key.length < 1 || key.length > 64 || first < "A" || first > "Z" || [...key].some((char) => !(char >= "A" && char <= "Z") && !(char >= "0" && char <= "9") && char !== "_")) {
      throw new Error("selected " + phase + " template contains a non-canonical interpolation token");
    }
    const value = values[key];
    if (value === undefined) throw new Error("selected " + phase + " template contains unresolved placeholder '" + token + "'");
    rendered += value;
    cursor = end + 2;
  }
  const markerMatches: string[] = [];
  for (const line of rendered.split("\n")) {
    const trimmed = line.trim();
    const prefix = "<!-- omp-spec:marker:";
    if (!trimmed.startsWith(prefix) || !trimmed.endsWith(" -->")) continue;
    markerMatches.push(trimmed.slice(prefix.length, -4));
  }
  const required = [...template.required_markers];
  for (const marker of required) {
    const placeholder = "{{" + marker.toUpperCase() + "}}";
    if (!template.content.includes(placeholder)) throw new Error("selected " + phase + " template is missing mandatory placeholder " + placeholder);
  }
  const markerCounts = new Map<string, number>();
  for (const marker of markerMatches) markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1);
  if (markerMatches.length !== required.length
    || new Set(markerMatches).size !== markerMatches.length
    || required.some((marker) => markerCounts.get(marker) !== 1)) {
    throw new Error("selected " + phase + " template markers do not match its mandatory marker set");
  }
  const lines = rendered.split("\n");
  const isMarkerLine = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed.startsWith("<!-- omp-spec:marker:") && trimmed.endsWith(" -->");
  };
  const firstMarkerIndex = lines.findIndex(isMarkerLine);
  if (firstMarkerIndex < 0) throw new Error("selected " + phase + " template is missing its semantic body");
  const headerLines = lines.slice(0, firstMarkerIndex);
  const titleCandidates = headerLines.filter((line) => line.startsWith("# ") && !line.startsWith("## "));
  const title = titleCandidates[0] ?? "# " + phaseHeadingLabel(phase);
  if (lines.some((line) => line.trim() === "## Semantic Model")) throw new Error("selected " + phase + " template must not provide a duplicate Semantic Model section");
  const identityLabels = ["Feature:", "Run:", "Version:", "Worker:", "Dispatch:", "Constitution:", "Upstream versions:"];
  const headerExtras = headerLines
    .filter((line) => !(line.startsWith("# ") && !line.startsWith("## ")) && !identityLabels.some((label) => line.startsWith(label + " ")))
    .join("\n")
    .replace(/(?:\r\n|\n|\r)+$/u, "");
  const body = lines.slice(firstMarkerIndex).join("\n").replace(/(?:\r\n|\n|\r)+$/u, "");
  const metadata = [
    title,
    "",
    "Feature: " + model.feature_id,
    "Run: " + model.run_key,
    "Version: " + model.version,
    "Worker: " + model.worker.role + " (" + model.worker.agent + ")",
    "Dispatch: " + model.worker.dispatch_id,
    "Constitution: " + canonicalJson(model.constitution_binding),
    "Upstream versions: " + canonicalJson(model.upstream_versions),
  ];
  const prefix = metadata.join("\n") + (headerExtras ? "\n\n" + headerExtras : "") + "\n\n";
  return prefix + body + "\n\n## Semantic Model\n\n```json\n" + canonicalJson(model) + "\n```\n";
}

/**
 * Render one canonical readable phase document. A selected template is the
 * authoritative presentation source for every layer, including shipped
 * defaults. Omitting a template intentionally retains the explicit legacy
 * renderer used by historical artifacts.
 */
export function renderCanonicalPhaseDocument(phase: WorkspacePhase, model: SpecificationSemanticModel, template?: NativePhaseTemplate): string {
  if (model.phase !== phase) throw new Error("canonical phase renderer received a model for a different phase");
  if (template) return renderSelectedPhaseTemplate(phase, model, template);
  const lines: string[] = [
    "# " + phaseHeadingLabel(phase),
    "",
    "Feature: " + model.feature_id,
    "Run: " + model.run_key,
    "Version: " + model.version,
    "Worker: " + model.worker.role + " (" + model.worker.agent + ")",
    "Dispatch: " + model.worker.dispatch_id,
    "Constitution: " + canonicalJson(model.constitution_binding),
    "Upstream versions: " + canonicalJson(model.upstream_versions),
  ];
  for (const section of NATIVE_PHASE_SECTIONS[phase]) {
    lines.push("", "## " + phaseHeadingLabel(section), "", (model.sections as unknown as Record<string, string>)[section]!);
  }
  lines.push("", "## Semantic Model", "", "```json", canonicalJson(model), "```", "");
  return lines.join("\n");
}

/** Stable alias for consumers that prefer the noun-first renderer name. */
export const canonicalPhaseMarkdown = renderCanonicalPhaseDocument;

/** Extract exact section bodies from a canonical phase document in one pass. */
export function extractPhaseSectionBodies(content: string, phase: WorkspacePhase): Record<string, string> {
  const lines = content.split("\n");
  const result: Record<string, string> = {};
  const headings: Array<{ key: string; line: number }> = [];
  for (let line = 0; line < lines.length; line += 1) {
    const match = /^##[ \t]+([^#\r\n].*?)[ \t]*$/u.exec(lines[line]!);
    if (!match) continue;
    const key = match[1]!.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "");
    headings.push({ key, line });
  }
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    if (!NATIVE_PHASE_SECTIONS[phase].includes(heading.key)) continue;
    const start = heading.line + 1;
    const end = index + 1 < headings.length ? headings[index + 1]!.line : lines.length;
    let body = lines.slice(start, end).join("\n");
    if (body.startsWith("\n")) body = body.slice(1);
    if (body.endsWith("\n")) body = body.slice(0, -1);
    result[heading.key] = body;
  }
  return result;
}

/** Require byte equality with the one engine renderer; no substring checks. */
function phaseDocumentRoundtripIssue(content: string, phase: WorkspacePhase, model: SpecificationSemanticModel, template?: NativePhaseTemplate): string | null {
  const canonical = renderCanonicalPhaseDocument(phase, model, template);
  if (Buffer.byteLength(canonical, "utf8") > MAX_PHASE_INPUT_BYTES) {
    return `canonical ${phase} document exceeds the ${MAX_PHASE_INPUT_BYTES}-byte UTF-8 limit`;
  }
  if (content !== canonical) return "primary phase document must equal the canonical semantic model rendering";
  return null;
}

function semanticModelReports(
  phase: WorkspacePhase,
  current: SpecificationSemanticModel,
  upstream: SpecificationSemanticModel[],
): Pick<NativePhaseValidationInput, "requirements" | "decisions" | "tasks" | "verification" | "contradictions"> & { constitution_principles: Array<{ principle_id: string; status: "pass" | "fail" | "not_applicable"; evidence: string }> } {
  const specify = phase === "specify" ? current : upstream.find((model) => model.phase === "specify") ?? current;
  const plan = phase === "plan" ? current : upstream.find((model) => model.phase === "plan") ?? current;
  const policy = phase === "tasks" ? plan : current;
  const requirements = specify.requirements.map((item) => ({ requirement_id: item.requirement_id, statement: item.statement, acceptance_ids: [...item.acceptance_ids], source_refs: [...item.source_refs], testable: item.testable, untestable_reason: item.untestable_reason }));
  const decisions = plan.decisions.map((item) => ({ decision_id: item.decision_id, decision: item.decision, rationale: item.rationale, requirement_ids: [...item.requirement_ids] }));
  const tasks = phase === "tasks" ? current.tasks.map((item) => ({ task_id: item.id, id: item.id, title: item.title, requirement_ids: [...item.requirement_ids], acceptance_ids: [...item.acceptance_ids], decision_ids: [...item.decision_ids], verification_ids: [...item.verification_ids], depends_on: [...item.depends_on], expected_outcome: item.expected_outcome, affected_scope: [...item.affected_scope], completion_evidence: [...item.completion_evidence], parallel_safe: item.parallel_safe })) : [];
  const verification = current.verification.map((item) => ({ verification_id: item.verification_id, requirement_ids: [...item.requirement_ids], acceptance_ids: [...item.acceptance_ids], task_ids: [...item.task_ids], observable_behavior: item.observable_behavior, expected_evidence: item.expected_evidence }));
  const contradictions = specify.contradictions.map((item) => ({ ...item, subject_ids: [...item.subject_ids] }));
  const constitution_principles = policy.constitution_principles.map((item) => ({ principle_id: item.principle_id, status: item.status, evidence: item.evidence }));
  return { requirements, decisions, tasks, verification, contradictions, constitution_principles };
}

function revisionRequiredWorkspace(workspace: FeatureWorkspace, phase: WorkspacePhase, featureId: string, reason: string, validationRef: string): FeatureWorkspace {
  return {
    ...workspace,
    status: "in_progress",
    handoff_ref: null,
    phases: workspace.phases.map((candidate) => candidate.phase === phase
      ? { ...candidate, status: "revision_required", validation_ref: validationRef, checkpoint_ref: null, stale_reason: reason, last_feedback: reason }
      : candidate),
    next_action: { kind: "remediation", command: PHASE_COMMAND[phase] + " --feature " + featureId, reason: reason + " Resume with " + PHASE_COMMAND[phase] + " --feature " + featureId + " for a new immutable revision before validation." },
  };
}

function expectedUpstream(projectRoot: string, workspace: FeatureWorkspace, phase: WorkspacePhase, runKey: string | undefined, pinnedRoot: PinnedProjectRoot): PhaseLifecycleResult<PhaseUpstreamVersionBinding[]> {
  const required: WorkspacePhase[] = phase === "specify" ? [] : phase === "plan" ? ["specify"] : ["specify", "plan"];
  const bindings: PhaseUpstreamVersionBinding[] = [];
  for (const upstreamPhase of required) {
    const record = phaseRecord(workspace, upstreamPhase);
    if (!record || record.status !== "approved" || record.approved_version === null || record.current_version !== record.approved_version) {
      return fail("SPEC_PHASE_NOT_READY", `${phase} requires the current approved ${upstreamPhase} version`);
    }
    const artifactId = `${upstreamPhase}.v${record.approved_version}`;
    const version = readVersion(projectRoot, workspace.feature_id, artifactId, runKey, pinnedRoot);
    if (!version || version.phase !== upstreamPhase || version.version !== record.approved_version) {
      return fail("SPEC_PHASE_STALE", `approved upstream artifact '${artifactId}' is missing or inconsistent`);
    }
    bindings.push({ artifact_id: artifactId, version: record.approved_version, hash: digestOf(version) });
  }
  return { ok: true, value: bindings, replayed: false };
}
const MAX_NATIVE_WORKER_INPUT_BYTES = 8 * MAX_PHASE_INPUT_BYTES;

function readNativeWorkerText(pinnedRoot: PinnedProjectRoot, relativePath: string, label: string): string {
  if (!isSafeRelativePath(relativePath)) throw new Error(`${label} path is unsafe`);
  const bytes = pinnedRoot.readFile(relativePath, { maxBytes: MAX_PHASE_INPUT_BYTES }).bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  if (!pinnedRoot.isStable()) throw new Error(`project root changed while reading ${label}`);
  return text;
}

function loadNativeWorkerAuthoritativeInput(
  projectRoot: string,
  workspace: FeatureWorkspace,
  runKey: string,
  upstream: PhaseUpstreamVersionBinding[],
  pinnedRoot: PinnedProjectRoot,
): { ok: true; value: NativeWorkerAuthoritativeInput } | { ok: false; error: string } {
  try {
    const binding = workspace.constitution_binding;
    if (!binding || validateConstitutionBinding(binding).length > 0) return { ok: false, error: "current constitution binding is invalid" };
    const constitutionText = readNativeWorkerText(pinnedRoot, binding.path, "approved constitution");
    if (sha256Hex(constitutionText) !== binding.content_sha256) return { ok: false, error: "approved constitution bytes do not match the bound content hash" };
    const upstreamArtifactRefs: NativeWorkerAuthoritativeInput["upstream_artifact_refs"] = [];
    for (const versionBinding of upstream) {
      const artifactPath = join(".work-state", "features", workspace.feature_id, "artifacts", `${versionBinding.artifact_id}.json`);
      const artifactText = readNativeWorkerText(pinnedRoot, artifactPath, `approved upstream artifact '${versionBinding.artifact_id}'`);
      const artifact = readVersion(projectRoot, workspace.feature_id, versionBinding.artifact_id, runKey, pinnedRoot);
      if (!artifact || artifact.artifact_id !== versionBinding.artifact_id || artifact.version !== versionBinding.version || digestOf(artifact) !== versionBinding.hash) {
        return { ok: false, error: `approved upstream artifact '${versionBinding.artifact_id}' is stale or its declared hash does not match` };
      }
      let parsedArtifact: unknown;
      try { parsedArtifact = JSON.parse(artifactText); } catch { return { ok: false, error: `approved upstream artifact '${versionBinding.artifact_id}' is not valid JSON` }; }
      if (!isRecord(parsedArtifact) || !same(parsedArtifact, artifact)) return { ok: false, error: `approved upstream artifact '${versionBinding.artifact_id}' bytes do not match its validated envelope` };
      const upstreamPhase = versionBinding.artifact_id.split(".")[0] as WorkspacePhase;
      const projectionPath = join(".work-state", "features", workspace.feature_id, "artifacts", `${PHASE_SOURCE_ARTIFACT[upstreamPhase]}.json`);
      const projectionText = readNativeWorkerText(pinnedRoot, projectionPath, `approved upstream projection '${PHASE_SOURCE_ARTIFACT[upstreamPhase]}'`);
      if (projectionText !== nativeProjectionBytes(artifact.semantic_model).toString("utf8")) return { ok: false, error: `approved upstream projection '${PHASE_SOURCE_ARTIFACT[upstreamPhase]}' is stale or tampered` };
      upstreamArtifactRefs.push({ ...versionBinding, semantic_model: artifact.semantic_model });
    }
    const value: NativeWorkerAuthoritativeInput = {
      language: { ...workspace.language },
      constitution: { binding, path: binding.path, content_sha256: binding.content_sha256, document_text: constitutionText },
      upstream_artifact_refs: upstreamArtifactRefs,
    };
    if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_NATIVE_WORKER_INPUT_BYTES) return { ok: false, error: "native worker authoritative input exceeds the bounded size" };
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed after loading native worker authoritative input" };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}


function nativeHydrationFailure(
  code: string,
  error: string,
  provenance: "unauthenticated" | "authenticated_assignment" = "unauthenticated",
): NativeSpecificationWorkerPromptHydrationResult {
  return { ok: false, code, error, provenance };
}

function sameNativeSessionStat(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

type NativeSessionRead =
  | { ok: true; file: string; session_id: string | null }
  | { ok: false };

function readNativeSessionIdentity(sessionFile: string, sessionDir: string): NativeSessionRead {
  const maxBytes = 16 * 1024;
  let descriptor: number | undefined;
  try {
    if (sessionFile.includes("\0") || sessionDir.includes("\0")) return { ok: false };
    const requestedDir = resolve(sessionDir);
    const requestedFile = resolve(sessionFile);
    const canonicalDir = realpathSync(requestedDir);
    const dirStat = lstatSync(canonicalDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { ok: false };
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const nonBlock = constants.O_NONBLOCK ?? 0;
    descriptor = openSync(requestedFile, constants.O_RDONLY | noFollow | nonBlock);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) return { ok: false };
    const openedPath = realpathSync(requestedFile);
    const child = relative(canonicalDir, openedPath);
    if (!child || child === ".." || child.startsWith(".." + requirePathSeparator()) || isAbsolute(child)) return { ok: false };
    const pathBefore = lstatSync(requestedFile);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || !sameNativeSessionStat(before, pathBefore)) return { ok: false };
    const bytes = Buffer.allocUnsafe(maxBytes);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(descriptor, bytes, offset, before.size - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== before.size) return { ok: false };
    const after = fstatSync(descriptor);
    if (!sameNativeSessionStat(before, after)) return { ok: false };
    const pathAfter = lstatSync(requestedFile);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || !sameNativeSessionStat(after, pathAfter)) return { ok: false };
    if (realpathSync(requestedFile) !== openedPath || realpathSync(requestedDir) !== canonicalDir) return { ok: false };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    for (const line of text.split(/\r?\n/u).slice(0, 64)) {
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value) && value.type === "session" && typeof value.id === "string") return { ok: true, file: openedPath, session_id: value.id };
      } catch {
        // A partial or unrelated transcript line does not authenticate a session.
      }
    }
    return { ok: true, file: openedPath, session_id: null };
  } catch {
    return { ok: false };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
function requirePathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function parseNativeWorkerPrompt(prompt: string): { markerText: string; marker: NonNullable<ReturnType<typeof parseDispatchMarker>>; reference: string; digest: string; ctoSliceMarker?: string } | null {
  if (typeof prompt !== "string" || !prompt.startsWith(NATIVE_WORKER_PROMPT_PREFIX)) return null;
  const assignment = prompt.slice(NATIVE_WORKER_PROMPT_PREFIX.length);
  const parts = assignment.split("\n\n");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const markerText = parts[0];
  const referenceLine = parts[1];
  const instruction = parts[2];
  if (typeof markerText !== "string" || typeof referenceLine !== "string" || typeof instruction !== "string") return null;
  if (!markerText.startsWith("<!-- omp-dispatch") || !markerText.endsWith("-->") || /\r/u.test(markerText)) return null;
  const marker = parseDispatchMarker(markerText);
  if (!marker) return null;
  const referenceMatch = referenceLine.match(NATIVE_WORKER_REF_RE);
  if (!referenceMatch || instruction !== NATIVE_WORKER_REF_INSTRUCTION) return null;
  if (parts.length === 4 && (typeof parts[3] !== "string" || !parts[3] || /\r|\n/u.test(parts[3]))) return null;
  const reference = referenceMatch[1];
  const digest = referenceMatch[2];
  if (!reference || !digest) return null;
  return {
    markerText,
    marker,
    reference,
    digest,
    ...(parts.length === 4 ? { ctoSliceMarker: parts[3] } : {}),
  };
}

function nativeWorkerDispatchFromState(
  projectRoot: string,
  state: TeamState,
  workspace: FeatureWorkspace,
  phase: WorkspacePhase,
  record: NonNullable<NonNullable<TeamState["dispatch_capability"]>["dispatches"]>[number],
  pinnedRoot: PinnedProjectRoot,
): { ok: true; dispatch: SpecificationPhaseDispatch } | { ok: false } {
  try {
    if (!record.work_identity || !record.tool_call_id || !workspace.constitution_binding || typeof state.run_key !== "string" || state.run_key.length === 0) return { ok: false };
    const phaseRecordValue = workspace.phases.find((candidate) => candidate.phase === phase);
    if (!phaseRecordValue) return { ok: false };
    const identities = readPinnedConstitutionPrincipleIdentities(pinnedRoot, workspace.constitution_binding);
    if (!identities.ok) return { ok: false };
    const generation = nativeGenerationBinding({
      feature_id: workspace.feature_id,
      run_key: state.run_key,
      phase,
      version: (phaseRecordValue.current_version ?? 0) + 1,
      request_id: record.tool_call_id,
      dispatch_id: record.id,
      capability_id: record.work_identity.capability_id,
      capability_epoch: record.work_identity.capability_epoch,
      run_id: record.work_identity.run_id,
      workflow: record.work_identity.workflow,
      task_id: record.work_identity.task_id,
      worker_id: record.work_identity.worker_id,
    });
    const outputSchema = specificationPhaseSchemaForConstitution(identities.value, workspace.constitution_binding, phase, generation);
    if (!outputSchema) return { ok: false };
    const upstream = expectedUpstream(projectRoot, workspace, phase, state.run_key, pinnedRoot);
    if (!upstream.ok) return { ok: false };
    const phaseTemplate = resolveNativePhaseTemplate(projectRoot, workspace, phase, pinnedRoot);
    if (!phaseTemplate.ok) return { ok: false };
    const authoritative = loadNativeWorkerAuthoritativeInput(projectRoot, workspace, state.run_key, upstream.value, pinnedRoot);
    if (!authoritative.ok) return { ok: false };
    const capability = state.dispatch_capability;
    if (!capability?.capability_id || !record.tool_call_id) return { ok: false };
    const dispatchMarker = buildDispatchMarker(
      state.run_key,
      { id: phase, title: phase, type: "single", role: record.role },
      [record.role],
      record.role,
      record.work_identity.capability_epoch,
      capability.capability_id,
      record.role,
      record.work_identity.task_id,
      workspace.feature_id,
    );
    return {
      ok: true,
      dispatch: {
        feature_id: workspace.feature_id,
        run_key: state.run_key,
        phase,
        version: (phaseRecordValue.current_version ?? 0) + 1,
        request_id: record.tool_call_id,
        dispatch_id: record.id,
        worker_name: nativeWorkerName(phase, record.id),
        dispatch_marker: dispatchMarker,
        output_schema: outputSchema as Record<string, unknown>,
        input_ref: generation.input_ref,
        input_digest: generation.input_digest,
        work_identity: record.work_identity,
        capability_epoch: record.work_identity.capability_epoch,
        constitution_binding: workspace.constitution_binding,
        upstream_versions: upstream.value,
        template_hash: workspace.template_set.content_hash,
        language_hash: workspace.language.selection_hash,
        feedback: phaseRecordValue.last_feedback,
        constitution_principles: identities.value.map(({ principle_id, title }) => ({ principle_id, title })),
        authoritative_input: authoritative.value,
        phase_template: phaseTemplate.value,
        requester_context: state.task,
      },
    };
  } catch {
    return { ok: false };
  }
}

function nativeHydrationStateIdentity(state: TeamState, dispatchId: string): string {
  const capability = state.dispatch_capability;
  const record = capability?.dispatches?.find((candidate) => candidate.id === dispatchId);
  return digestOf({
    state_revision: state.state_revision,
    run_key: state.run_key,
    stage_cursor: state.stage_cursor,
    capability_id: capability?.capability_id,
    capability_status: capability?.status,
    cursor_epoch: capability?.issued_for?.cursor_epoch,
    dispatch_id: record?.id,
    dispatch_status: record?.status,
    dispatch_tool_call_id: record?.tool_call_id,
    work_identity: record?.work_identity,
  });
}

function nativeHydrationStateMatches(
  initial: { state: TeamState; raw_hash?: string },
  current: { state: TeamState; raw_hash?: string },
  dispatchId: string,
): boolean {
  return initial.raw_hash === current.raw_hash
    && digestOf(initial.state) === digestOf(current.state)
    && nativeHydrationStateIdentity(initial.state, dispatchId) === nativeHydrationStateIdentity(current.state, dispatchId);
}

/**
 * Reconstruct the exact native worker input from the pinned project state at
 * hook time. The task carries only a bounded reference and digest; no input is
 * retained in a process-local vault or trusted from host-provided state.
 */
export function hydrateNativeSpecificationWorkerPrompt(
  projectRoot: string,
  input: NativeSpecificationWorkerPromptHydrationInput,
): NativeSpecificationWorkerPromptHydrationResult {
  if (!isRecord(input)
    || typeof input.prompt !== "string"
    || typeof input.session_id !== "string"
    || typeof input.session_file !== "string"
    || typeof input.session_dir !== "string"
    || input.session_id.length === 0
    || input.session_id.length > 256
    || /[\0-\r\n]/u.test(input.session_id)) {
    return nativeHydrationFailure("NATIVE_WORKER_REQUEST_INVALID", "native worker hydration request is invalid");
  }
  const parsed = parseNativeWorkerPrompt(input.prompt);
  if (!parsed) return nativeHydrationFailure("NATIVE_WORKER_PROMPT_INVALID", "native worker prompt is not the exact engine assignment");
  const marker = parsed.marker;
  if (!marker.feature_id || !marker.task_id || !marker.capability_id || !marker.slot_id || marker.kind !== "single" || !["specify", "plan", "tasks"].includes(marker.stage)) {
    return nativeHydrationFailure("NATIVE_WORKER_PROMPT_INVALID", "native worker prompt marker is incomplete");
  }
  const phase = marker.stage as WorkspacePhase;
  const selected = resolveState(projectRoot, resolveActiveBranch(projectRoot), { feature_id: marker.feature_id, run_key: marker.run });
  if (selected.invalid || !selected.state?.specification) return nativeHydrationFailure("NATIVE_WORKER_STATE_STALE", "native worker workflow state is unavailable");
  const state = selected.state;
  const workspace = state.specification;
  const runKey = state.run_key;
  if (!workspace || typeof runKey !== "string" || runKey.length === 0) return nativeHydrationFailure("NATIVE_WORKER_STATE_STALE", "native worker workflow state is unavailable");
  const phaseRecordValue = workspace.phases.find((candidate) => candidate.phase === phase);
  const capability = state.dispatch_capability;
  if (workspace.source_kind !== "native"
    || workspace.feature_id !== marker.feature_id
    || runKey !== marker.run
    || state.stage_cursor !== phase
    || phaseRecordValue?.status !== "generating"
    || !capability
    || capability.status !== "dispatched"
    || !capability.capability_id
    || capability.capability_id !== marker.capability_id
    || !capability.issued_for
    || capability.issued_for.run_key !== runKey
    || capability.issued_for.stage_cursor !== phase) {
    return nativeHydrationFailure("NATIVE_WORKER_STATE_STALE", "native worker dispatch is no longer active");
  }
  const expectedPrefix = NATIVE_WORKER_REFERENCE_PREFIX + [workspace.feature_id, runKey, phase, ""].join(":");
  if (!parsed.reference.startsWith(expectedPrefix)) return nativeHydrationFailure("NATIVE_WORKER_REFERENCE_MISMATCH", "native worker reference does not match the selected workflow");
  const dispatchId = parsed.reference.slice(expectedPrefix.length);
  if (!dispatchId || !/^[A-Za-z0-9._-]{1,256}$/u.test(dispatchId)) return nativeHydrationFailure("NATIVE_WORKER_REFERENCE_MISMATCH", "native worker reference is invalid");
  const record = capability.dispatches?.find((candidate) => candidate.id === dispatchId);
  if (!record
    || (record.purpose ?? "generation") !== "generation"
    || !["authorized", "running", "pending"].includes(record.status)
    || !record.work_identity
    || record.work_identity.dispatch_id !== record.id
    || record.work_identity.run_id !== runKey
    || record.work_identity.workflow !== capability.issued_for.workflow
    || record.work_identity.capability_id !== capability.capability_id
    || record.work_identity.stage_id !== phase
    || record.work_identity.stage_cursor !== phase
    || record.work_identity.capability_epoch !== capability.issued_for.cursor_epoch
    || record.work_identity.slot_id !== marker.slot_id
    || record.role !== marker.role
    || record.agent !== record.work_identity.worker_id
    || marker.role !== marker.slot_id
    || marker.task_id !== record.work_identity.task_id) {
    return nativeHydrationFailure("NATIVE_WORKER_DISPATCH_MISMATCH", "native worker dispatch identity is not active");
  }
  const expectedWorkerName = nativeWorkerName(phase, record.id);
  const startMarker = state.preparation_start;
  if (startMarker !== undefined
    && (startMarker.status !== "started"
      || startMarker.dispatch_id !== record.id
      || startMarker.capability_id !== capability.capability_id
      || startMarker.request_id !== record.tool_call_id
      || preparationStartPostimageDigest(state) !== startMarker.start_postimage_digest)) {
    return nativeHydrationFailure("NATIVE_WORKER_STATE_STALE", "native worker start postimage is no longer active");
  }
  if (parsed.markerText !== buildDispatchMarker(runKey, { id: phase, title: phase, type: "single", role: record.role }, [record.role], record.role, record.work_identity.capability_epoch, capability.capability_id, record.role, record.work_identity.task_id, workspace.feature_id)) {
    return nativeHydrationFailure("NATIVE_WORKER_PROMPT_INVALID", "native worker dispatch marker is not exact");
  }
  const expectedCtoMarker = state.preparation_start?.cto_slice_marker;
  if ((expectedCtoMarker === undefined && parsed.ctoSliceMarker !== undefined)
    || (expectedCtoMarker !== undefined && parsed.ctoSliceMarker !== expectedCtoMarker)) {
    return nativeHydrationFailure("NATIVE_WORKER_PROMPT_INVALID", "native worker CTO slice marker is not exact");
  }
  const safeSession = readNativeSessionIdentity(input.session_file, input.session_dir);
  if (!safeSession.ok || basename(safeSession.file) !== expectedWorkerName + ".jsonl" || safeSession.session_id !== input.session_id) {
    return nativeHydrationFailure("NATIVE_WORKER_SESSION_INVALID", "native worker session identity is not authenticated", "authenticated_assignment");
  }
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return nativeHydrationFailure("NATIVE_WORKER_STATE_STALE", "native worker project root is unavailable", "authenticated_assignment");
  try {
    const pinnedSelected = resolveStatePinned(projectRoot, pinnedRoot, { feature_id: marker.feature_id, run_key: marker.run });
    if (pinnedSelected.invalid || !pinnedSelected.state || !pinnedSelected.state.specification
      || !nativeHydrationStateMatches(
        { state, raw_hash: selected.raw_hash },
        { state: pinnedSelected.state, raw_hash: pinnedSelected.raw_hash },
        dispatchId,
      )) {
      return nativeHydrationFailure("NATIVE_WORKER_STATE_STALE", "native worker workflow state changed during hydration", "authenticated_assignment");
    }
    // From this point onward every reconstructed byte comes from the
    // descriptor-anchored state snapshot, never the initial pathname read.
    const authoritativeState = pinnedSelected.state;
    const authoritativeWorkspace = authoritativeState.specification;
    if (!authoritativeWorkspace) return nativeHydrationFailure("NATIVE_WORKER_STATE_STALE", "native worker workspace disappeared during hydration", "authenticated_assignment");
    const rootIdentity = authoritativeState.preparation_handoff?.root_identity;
    if (isRecord(rootIdentity)
      && (rootIdentity.canonical_path !== pinnedRoot.canonical_root || rootIdentity.dev !== pinnedRoot.dev || rootIdentity.ino !== pinnedRoot.ino)) {
      return nativeHydrationFailure("NATIVE_WORKER_STATE_STALE", "native worker project root identity is stale", "authenticated_assignment");
    }
    const reconstructed = nativeWorkerDispatchFromState(projectRoot, authoritativeState, authoritativeWorkspace, phase, record, pinnedRoot);
    if (!reconstructed.ok) return nativeHydrationFailure("NATIVE_WORKER_INPUT_UNAVAILABLE", "native worker authoritative input is unavailable", "authenticated_assignment");
    const dispatch = reconstructed.dispatch;
    const reference = nativeWorkerReference(dispatch);
    if (reference !== parsed.reference) return nativeHydrationFailure("NATIVE_WORKER_REFERENCE_MISMATCH", "native worker reference does not match the active dispatch", "authenticated_assignment");
    const systemPrompt = nativeWorkerPromptText(dispatch, authoritativeState.task);
    const digest = sha256Hex(systemPrompt);
    if (digest !== parsed.digest) return nativeHydrationFailure("NATIVE_WORKER_INPUT_MISMATCH", "native worker input digest does not match the authoritative state", "authenticated_assignment");
    if (Buffer.byteLength(systemPrompt, "utf8") > MAX_NATIVE_WORKER_PROMPT_BYTES) return nativeHydrationFailure("NATIVE_WORKER_INPUT_TOO_LARGE", "native worker input exceeds the provider context budget", "authenticated_assignment");
    const finalSelected = resolveStatePinned(projectRoot, pinnedRoot, { feature_id: marker.feature_id, run_key: marker.run });
    if (finalSelected.invalid || !finalSelected.state?.specification
      || !nativeHydrationStateMatches(
        { state: authoritativeState, raw_hash: pinnedSelected.raw_hash },
        { state: finalSelected.state, raw_hash: finalSelected.raw_hash },
        dispatchId,
      )
      || !pinnedRoot.isStable()) {
      return nativeHydrationFailure("NATIVE_WORKER_STATE_STALE", "native worker workflow state changed before hydration completed", "authenticated_assignment");
    }
    return { ok: true, worker_name: expectedWorkerName, reference, digest, system_prompt: systemPrompt };
  } catch {
    return nativeHydrationFailure("NATIVE_WORKER_INPUT_UNAVAILABLE", "native worker authoritative input is unavailable", "authenticated_assignment");
  } finally {
    pinnedRoot.close();
  }
}


function currentConstitutionGuard(
  projectRoot: string,
  binding: ConstitutionBinding | null | undefined,
): ReturnType<typeof readPinnedCurrentConstitution> {
  if (!binding) return { ok: false, error: "current constitution binding is unavailable" };
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return { ok: false, error: "project root cannot be pinned for constitution freshness" };
  try {
    return readPinnedCurrentConstitution(projectRoot, pinnedRoot, binding);
  } finally {
    pinnedRoot.close();
  }
}

function currentWorkspace(projectRoot: string, input: PhaseCapabilityInput, workspaceOverride?: FeatureWorkspace | null, options: { allowMigrated?: boolean; persistMigration?: boolean } = {}): PhaseLifecycleResult<FeatureWorkspace> {
  const selectorError = validateSelector(input);
  if (selectorError) return fail("SPEC_PHASE_REQUEST_INVALID", selectorError);
  let workspace: FeatureWorkspace;
  if (workspaceOverride !== undefined) {
    if (!workspaceOverride || workspaceOverride.feature_id !== input.feature_id) return fail("SPEC_PHASE_FORBIDDEN", "authoritative workspace snapshot does not match the requested feature");
    workspace = workspaceOverride;
  } else {
    const resolved = resolveFeatureWorkspace(projectRoot, { feature_id: input.feature_id, run_key: input.run_key }, undefined, { persistMigration: options.persistMigration });
    if (!resolved.ok) return fail("SPEC_PHASE_FORBIDDEN", resolved.error);
    workspace = resolved.value;
  }

  if (workspace.source_kind !== "native" && !(options.allowMigrated && workspace.source_kind === "legacy")) return fail("SPEC_PHASE_FORBIDDEN", "phase dispatch requires a native or verified migrated workspace");
  const compactProfileHash = workspace.profile_hash.length > 32 ? `${workspace.profile_hash.slice(0, 30)}${workspace.profile_hash.slice(-2)}` : workspace.profile_hash;
  if (workspace.profile_name !== input.workflow || (workspace.profile_hash !== input.profile_hash && compactProfileHash !== input.profile_hash)) {
    return fail("SPEC_PHASE_FORBIDDEN", "workspace profile binding does not match the dispatch capability");
  }
  if (!workspace.constitution_binding) return fail("SPEC_PHASE_NOT_READY", "the current project constitution must be bound before native phase dispatch");
  const constitutionIssues = validateConstitutionBinding(workspace.constitution_binding);
  if (constitutionIssues.length > 0) return fail("SPEC_PHASE_STALE", `current constitution binding is invalid: ${constitutionIssues.join("; ")}`);
  return { ok: true, value: workspace, replayed: false };
}
function withGeneratingPhase(workspace: FeatureWorkspace, phase: WorkspacePhase): FeatureWorkspace {
  return {
    ...workspace,
    status: "in_progress",
    handoff_ref: null,
    phases: workspace.phases.map((record) => record.phase === phase
      ? { ...record, status: "generating", validation_ref: null, checkpoint_ref: null, stale_reason: null }
      : record),
    next_action: { kind: "none", command: null, reason: `The ${phase} worker dispatch is active.` },
  };
}

/** Authorize exactly one native phase worker against the current engine capability. */
export function dispatchSpecificationPhase(
  projectRoot: string,
  input: SpecificationPhaseDispatchInput,
  options?: { trustedMappingProof?: TrustedMappingProof },
): PhaseLifecycleResult<SpecificationPhaseDispatch> {
  const inputError = nativeCapabilityInputError(input, ["role", "slot_id", "agent", "retry_of"]);
  if (inputError) return fail("SPEC_PHASE_REQUEST_INVALID", inputError);
  const selectorError = validateSelector(input);
  if (selectorError) return fail("SPEC_PHASE_REQUEST_INVALID", selectorError);
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return fail("SPEC_PHASE_PERSIST_FAILED", "project root cannot be pinned for phase dispatch");
  try {
    const dispatchProof = options?.trustedMappingProof ?? issueCurrentTrustedMappingProof(projectRoot);
    const preWorkspace = currentWorkspace(projectRoot, input, undefined, { allowMigrated: true, persistMigration: false });
    if (!preWorkspace.ok) return preWorkspace;
    const preUpstream = expectedUpstream(projectRoot, preWorkspace.value, input.phase, input.run_key, pinnedRoot);
    if (!preUpstream.ok) return preUpstream;
    const preTemplate = resolveNativePhaseTemplate(projectRoot, preWorkspace.value, input.phase, pinnedRoot);
    if (!preTemplate.ok) return fail("SPEC_PHASE_STALE", preTemplate.error);
    const preConstitution = preWorkspace.value.constitution_binding
      ? readPinnedCurrentConstitution(projectRoot, pinnedRoot, preWorkspace.value.constitution_binding)
      : { ok: false as const, error: "workspace constitution binding is unavailable" };
    if (!preConstitution.ok) return fail("SPEC_PHASE_STALE", preConstitution.error);
    const preloadedAuthoritativeInput = preWorkspace.value.source_kind === "native"
      ? loadNativeWorkerAuthoritativeInput(projectRoot, preWorkspace.value, input.run_key, preUpstream.value, pinnedRoot)
      : { ok: true as const, value: undefined };
    if (!preloadedAuthoritativeInput.ok) return fail("SPEC_PHASE_STALE", `native worker authoritative input unavailable: ${preloadedAuthoritativeInput.error}`);
    if (!pinnedRoot.isStable()) return fail("SPEC_PHASE_STALE", "project root changed before native phase dispatch");
    const authorized = authorizeSpecificationPhaseDispatchWithMutation(
      projectRoot,
      authInput(input),
      (state, _target, record) => {
        const storedWorkspace = state.specification ?? null;
        const transactionWorkspace = storedWorkspace
          ? normalizeWorkspaceToV3ForTransaction(projectRoot, { feature_id: input.feature_id, run_key: input.run_key }, storedWorkspace, pinnedRoot)
          : null;
        if (storedWorkspace && !transactionWorkspace) return { ok: false as const, error: "SPEC_STATE_INVALID:feature workspace cannot be normalized to schema 3 inside the dispatch transaction" };
        const workspaceResult = currentWorkspace(projectRoot, input, transactionWorkspace, { allowMigrated: true });
        if (!workspaceResult.ok) return { ok: false as const, error: workspaceResult.error };
        const workspace = workspaceResult.value;
        if (workspace.source_kind === "native") {
          const preparationHandoff = state.preparation_handoff;
          if (!preparationHandoff) {
            return { ok: false as const, error: "SPEC_PHASE_FORBIDDEN:native phase dispatch requires the exact persisted authenticated preparation_handoff" };
          }
          const preparationAuthorityError = nativePreparationAuthorityError(projectRoot, state, {
            feature_id: input.feature_id,
            run_key: input.run_key,
            preparation_handoff: preparationHandoff,
          });
          if (preparationAuthorityError) {
            return { ok: false as const, error: "SPEC_PHASE_FORBIDDEN:native preparation_handoff authority is unavailable or stale: " + preparationAuthorityError };
          }
        }
        const phaseTemplate = resolveNativePhaseTemplate(projectRoot, workspace, input.phase, pinnedRoot);
        if (!phaseTemplate.ok) return { ok: false as const, error: "SPEC_PHASE_STALE:" + phaseTemplate.error };
        if (phaseTemplate.value.content_hash !== preTemplate.value.content_hash || phaseTemplate.value.content !== preTemplate.value.content) {
          return { ok: false as const, error: "SPEC_PHASE_STALE:native phase template changed while dispatching" };
        }
        const phaseRecordValue = phaseRecord(workspace, input.phase);
        if (!phaseRecordValue || !["not_started", "revision_required", "generating"].includes(phaseRecordValue.status)) {
          return { ok: false as const, error: `SPEC_PHASE_CONFLICT:phase ${input.phase} cannot dispatch from status ${phaseRecordValue?.status ?? "missing"}` };
        }
        if (workspace.source_kind === "legacy") {
          const migratedRecord = phaseRecordValue;
          const migratedArtifact = migratedRecord?.current_version === null ? null : readVersion(projectRoot, input.feature_id, input.phase + ".v" + migratedRecord.current_version, input.run_key, pinnedRoot);
          const migratedMaterialized = migratedRecord?.current_version === null
            ? null
            : revalidateMaterializedDocumentsPinned(pinnedRoot, { feature_id: input.feature_id, phase: input.phase, version: migratedRecord.current_version });
          const receipt = migratedReceipt(pinnedRoot, workspace, input.run_key);
          const isLegacyArtifact = migratedArtifact?.source_artifact.source_kind === "legacy";
          if (isLegacyArtifact && (!migratedRecord || !migratedArtifact || !receipt || !migratedMaterialized
            || !migratedPhaseEnvelopeValid(pinnedRoot, workspace, migratedRecord, input.run_key, migratedArtifact, receipt, migratedMaterialized))) {
            return { ok: false as const, error: "SPEC_PHASE_STALE:migrated phase receipt or immutable envelope is not current" };
          }
        }
        if (record.work_identity?.stage_cursor !== input.phase || record.work_identity.capability_epoch !== input.cursor_epoch) {
          return { ok: false as const, error: "SPEC_PHASE_FORBIDDEN:authorized work identity does not bind the requested phase and capability epoch" };
        }
        // The injector is deliberately before the final freshness read: tests
        // can interleave a source/root replacement at this exact pre-commit seam.
        injectPhaseFailure("before_dispatch_transition");
        const currentConstitution = workspace.constitution_binding
          ? readPinnedCurrentConstitution(projectRoot, pinnedRoot, workspace.constitution_binding)
          : { ok: false as const, error: "workspace constitution binding is unavailable" };
        if (!currentConstitution.ok) return { ok: false as const, error: "SPEC_PHASE_STALE:" + currentConstitution.error };
        if (digestOf(currentConstitution.value.content) !== digestOf(preConstitution.value.content)
          || digestOf(currentConstitution.value.identities) !== digestOf(preConstitution.value.identities)
          || digestOf(currentConstitution.value.binding) !== digestOf(preConstitution.value.binding)) {
          return { ok: false as const, error: "SPEC_PHASE_STALE:constitution source or binding changed while dispatching" };
        }
        const upstream = expectedUpstream(projectRoot, workspace, input.phase, input.run_key, pinnedRoot);
        if (!upstream.ok) return { ok: false as const, error: upstream.code + ":" + upstream.error };
        if (!same(upstream.value, preUpstream.value)) return { ok: false as const, error: "SPEC_PHASE_STALE:native worker upstream bindings changed while dispatching" };
        if (workspace.source_kind === "native") {
          const currentInput = loadNativeWorkerAuthoritativeInput(projectRoot, workspace, input.run_key, upstream.value, pinnedRoot);
          if (!currentInput.ok) return { ok: false as const, error: "SPEC_PHASE_STALE:native worker authoritative input unavailable: " + currentInput.error };
          if (!preloadedAuthoritativeInput.value || digestOf(currentInput.value) !== digestOf(preloadedAuthoritativeInput.value)) {
            return { ok: false as const, error: "SPEC_PHASE_STALE:native worker authoritative input changed while dispatching" };
          }
        }
        if (!pinnedRoot.isStable()) return { ok: false as const, error: "SPEC_PHASE_STALE:project root changed while dispatching" };
        const nextWorkspace = withGeneratingPhase(workspace, input.phase);
        const transactionState = transactionWorkspace && transactionWorkspace !== storedWorkspace
          ? { ...state, specification: transactionWorkspace }
          : state;
        return {
          ok: true as const,
          state: { ...transactionState, specification: nextWorkspace, updated_at: new Date().toISOString() },
          value: {
            workspace,
            upstream: upstream.value,
            requester_context: state.task,
            phase_template: phaseTemplate.value,
            constitution_identities: currentConstitution.value.identities,
            replayed: phaseRecordValue.status === "generating",
          },
        };
      },
      {
        pinnedRoot,
        preCommit: () => {
          const current = currentConstitutionGuard(projectRoot, preConstitution.value.binding);
          if (!current.ok) throw new Error("SPEC_PHASE_STALE:" + current.error);
        },
        trustedMappingProof: dispatchProof,
      },
    );
    if (!authorized.ok) {
      const typed = /^(SPEC_[A-Z_]+):(.*)$/s.exec(authorized.error);
      const code = typed?.[1] as PhaseLifecycleCode | undefined;
      if (code && [
        "SPEC_PHASE_REQUEST_INVALID", "SPEC_PHASE_FORBIDDEN", "SPEC_PHASE_NOT_READY", "SPEC_PHASE_STALE",
        "SPEC_PHASE_CONFLICT", "SPEC_PHASE_IMMUTABLE", "SPEC_PHASE_PERSIST_FAILED", "SPEC_PHASE_RECOVERY_REQUIRED", "SPEC_CHECKPOINT_BLOCKED", "NATIVE_COMPOSITE_REQUIRED",
        "SPEC_CHECKPOINT_UNKNOWN", "SPEC_DECISION_INVALID", "SPEC_PROOF_INVALID", "SPEC_FEEDBACK_REQUIRED",
      ].includes(code)) return fail(code, typed?.[2] ?? authorized.error);
      return fail("SPEC_PHASE_FORBIDDEN", authorized.error);
    }
    const dispatchValue = authorized.value;
    if (!dispatchValue || !authorized.record?.work_identity) return fail("SPEC_PHASE_PERSIST_FAILED", "phase dispatch transaction completed without a result");
    const binding = dispatchValue.workspace.constitution_binding;
    if (!binding) return fail("SPEC_PHASE_PERSIST_FAILED", "phase dispatch constitution binding is unavailable");
    const identities = { ok: true as const, value: dispatchValue.constitution_identities };
    const dispatchMarker = buildDispatchMarker(
      input.run_key,
      { id: input.phase, title: input.phase, type: "single", role: authorized.record.role },
      [authorized.record.role],
      authorized.record.role,
      authorized.capability_epoch,
      authorized.record.work_identity.capability_id,
      authorized.record.role,
      authorized.record.work_identity.task_id,
      input.feature_id,
    );
    const generation = nativeGenerationBinding({
      feature_id: input.feature_id,
      run_key: input.run_key,
      phase: input.phase,
      version: (dispatchValue.workspace.phases.find((phase) => phase.phase === input.phase)?.current_version ?? 0) + 1,
      request_id: input.request_id,
      dispatch_id: authorized.record.id,
      capability_id: authorized.record.work_identity.capability_id,
      capability_epoch: authorized.record.work_identity.capability_epoch,
      run_id: authorized.record.work_identity.run_id,
      workflow: authorized.record.work_identity.workflow,
      task_id: authorized.record.work_identity.task_id,
      worker_id: authorized.record.work_identity.worker_id,
    });
    const boundOutputSchema = specificationPhaseSchemaForConstitution(identities.value, binding, input.phase, generation);
    if (!boundOutputSchema) return fail("SPEC_PHASE_PERSIST_FAILED", "phase dispatch generation schema cannot be bound");
    if (dispatchValue.workspace.source_kind === "native" && !preloadedAuthoritativeInput.value) return fail("SPEC_PHASE_STALE", "native worker authoritative input was not retained for dispatch");
    return {
      ok: true,
      replayed: dispatchValue.replayed,
      value: {
        feature_id: input.feature_id,
        run_key: input.run_key,
        phase: input.phase,
        version: (dispatchValue.workspace.phases.find((phase) => phase.phase === input.phase)?.current_version ?? 0) + 1,
        request_id: input.request_id,
        dispatch_id: authorized.record.id,
        worker_name: nativeWorkerName(input.phase, authorized.record.id),
        dispatch_marker: dispatchMarker,
        output_schema: boundOutputSchema as Record<string, unknown>,
        input_ref: generation.input_ref,
        input_digest: generation.input_digest,
        work_identity: authorized.work_identity,
        capability_epoch: authorized.capability_epoch,
        constitution_binding: binding,
        upstream_versions: dispatchValue.upstream,
        template_hash: dispatchValue.workspace.template_set.content_hash,
        language_hash: dispatchValue.workspace.language.selection_hash,
        feedback: dispatchValue.workspace.phases.find((phase) => phase.phase === input.phase)?.last_feedback ?? null,
        constitution_principles: identities.value.map(({ principle_id, title }) => ({ principle_id, title })),
        ...(preloadedAuthoritativeInput.value ? { authoritative_input: preloadedAuthoritativeInput.value } : {}),
        phase_template: dispatchValue.phase_template,
        requester_context: dispatchValue.requester_context,
      },
    };
  } finally {
    pinnedRoot.close();
  }
}

function validateWorkerEnvelope(
  input: SpecificationWorkerResultInput,
  workspace: FeatureWorkspace,
  identity: WorkIdentity,
  expected: PhaseUpstreamVersionBinding[],
): string | null {
  if (!Number.isInteger(input.version) || input.version < 1) return "phase version must be an integer >= 1";
  if (!isRecord(input.source_artifact) || input.source_artifact.schema_version !== 1) return "source_artifact must be a schema-versioned typed worker result object";
  if (input.source_artifact.feature_id !== input.feature_id || input.source_artifact.run_key !== input.run_key || input.source_artifact.version !== input.version) {
    return "worker result identity/version does not match the phase request";
  }
  const worker = input.source_artifact.worker;
  if (!isRecord(worker) || worker.role !== identity.slot_id || worker.agent !== identity.worker_id || worker.dispatch_id !== input.dispatch_id) {
    return "worker attribution does not match the authorized dispatch identity";
  }
  if (!same(input.source_artifact.constitution_binding, input.constitution_binding)) return "worker result constitution binding mismatch";
  if (input.phase !== "specify" && !same(input.source_artifact.upstream_versions, input.upstream_versions)) return "worker result upstream binding mismatch";
  if (!same(input.constitution_binding, workspace.constitution_binding)) return "result is bound to a stale constitution";
  if (!same(input.upstream_versions, expected)) return "result is bound to stale or foreign upstream versions";
  if (input.template_hash !== workspace.template_set.content_hash || input.language_hash !== workspace.language.selection_hash) {
    return "result template/language binding is stale";
  }
  if (input.input_ref !== undefined || input.input_digest !== undefined) {
    const generation = nativeGenerationBinding({
      feature_id: workspace.feature_id,
      run_key: input.run_key,
      phase: input.phase,
      version: input.version,
      request_id: input.request_id,
      dispatch_id: input.dispatch_id,
      capability_id: identity.capability_id,
      capability_epoch: identity.capability_epoch,
      run_id: identity.run_id,
      workflow: identity.workflow,
      task_id: identity.task_id,
      worker_id: identity.worker_id,
    });
    if (input.input_ref !== generation.input_ref || input.input_digest !== generation.input_digest) {
      return "worker result generation binding does not match the locked dispatch";
    }
  }
  if (!Array.isArray(input.documents) || input.documents.length === 0) return "at least one readable document is required";
  if (input.documents.some((document) => !isSafeRelativePath(document.path) || typeof document.content !== "string" || document.content.length === 0)) {
    return "documents must have safe relative paths and non-empty content";
  }
  if (new Set(input.documents.map((document) => document.path)).size !== input.documents.length) return "document paths must be unique";
  const primary = input.documents.find((document) => document.path === PHASE_DOCUMENT[input.phase]);
  if (!primary) return `${input.phase} must materialize '${PHASE_DOCUMENT[input.phase]}'`;
  if (input.source_artifact.document_sha256 !== sha256Hex(primary.content)) return "worker document_sha256 does not match the primary readable document";
  const markers = Object.entries(input.semantic_sections);
  if (markers.length === 0 || markers.some(([marker, content]) => !marker.trim() || typeof content !== "string" || content.length === 0)) {
    return "semantic_sections must contain non-empty stable marker content";
  }
  return null;
}

function withMaterializedPhase(workspace: FeatureWorkspace, phase: WorkspacePhase, version: number, upstream: PhaseUpstreamVersionBinding[]): FeatureWorkspace {
  return {
    ...workspace,
    status: "in_progress",
    handoff_ref: null,
    phases: workspace.phases.map((record) => record.phase === phase
      ? { ...record, status: "materialized", current_version: version, approved_version: null, validation_ref: null, checkpoint_ref: null, upstream_versions: upstream.map((binding) => ({ phase: binding.artifact_id.split(".")[0] as WorkspacePhase, version: binding.version, hash: binding.hash })), stale_reason: null }
      : record),
    next_action: { kind: "remediation", command: null, reason: `Validate ${phase}.v${version} before opening its hard-human checkpoint.` },
  };
}

/** Persist one immutable worker result and atomically move only its workspace pointer. */
export function persistSpecificationPhaseResult(projectRoot: string, callerInput: SpecificationWorkerResultInput): PhaseLifecycleResult<PersistedSpecificationPhase> {
  const rollbackHolder: { value: PhasePersistenceRollback | null } = { value: null };
  const postCommitActions: Array<() => void> = [];
  let transactionCommitted = false;
  const cleanupAttemptRollback = (): void => {
    rollbackHolder.value?.cleanup();
  };
  const inputError = nativeCapabilityInputError(callerInput, ["role", "slot_id", "agent", "retry_of", "dispatch_id"]);
  if (inputError) return fail("SPEC_PHASE_REQUEST_INVALID", inputError);
  const boundsError = phaseWorkerResultBoundsIssue(callerInput);
  if (boundsError) return fail("SPEC_PHASE_REQUEST_INVALID", boundsError);
  const ownedInput = cloneBoundedPhaseInput(callerInput);
  if (!ownedInput.ok) return fail("SPEC_PHASE_REQUEST_INVALID", ownedInput.error);
  const input = ownedInput.value;
  if (!input.constitution_binding) return fail("SPEC_PHASE_STALE", "phase result constitution binding is unavailable");
  const selectorError = validateSelector(input);
  if (selectorError) return fail("SPEC_PHASE_REQUEST_INVALID", selectorError);
  let result: PhaseLifecycleResult<PersistedSpecificationPhase> | null = null;
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return fail("SPEC_PHASE_PERSIST_FAILED", "project root cannot be pinned for phase persistence");
  try {
    const transaction = updateStateAtomically(projectRoot, (snapshot) => {
      if (!snapshot.state) {
        result = fail("SPEC_PHASE_FORBIDDEN", "state not found");
        return { op: "discard" as const };
      }
      let stagedWorkspace: FeatureWorkspace | null = null;
      const persisted = persistSpecificationPhaseResultInternal(projectRoot, input, (workspace) => {
        stagedWorkspace = workspace;
      }, pinnedRoot, snapshot.state.specification ?? null, snapshot, (rollback) => {
        rollbackHolder.value = rollback;
      }, (action) => {
        postCommitActions.push(action);
      });
      result = persisted;
      if (!persisted.ok || !stagedWorkspace) return { op: "discard" as const, value: persisted };
      return {
        op: "commit" as const,
        state: { ...snapshot.state, specification: stagedWorkspace, updated_at: new Date().toISOString() },
        value: persisted,
      };
    }, {
      selector: { feature_id: input.feature_id, run_key: input.run_key },
      pinnedRoot,
      preCommit: () => {
        const current = readPinnedCurrentConstitution(projectRoot, pinnedRoot, input.constitution_binding);
        if (!current.ok) throw new Error("SPEC_PHASE_STALE:" + current.error);
      },
    });
    if (!transaction.ok) {
      cleanupAttemptRollback();
      if (transaction.error.startsWith("pre-commit guard failed: SPEC_PHASE_STALE:")) return fail("SPEC_PHASE_STALE", transaction.error.slice("pre-commit guard failed: SPEC_PHASE_STALE:".length));
      return fail("SPEC_PHASE_PERSIST_FAILED", transaction.error);
    }
    transactionCommitted = transaction.committed;
    if (transaction.committed) {
      for (const action of postCommitActions) action();
    }
    if (transaction.committed) injectPhaseFailure("after_state_write");
    const finalResult = result as PhaseLifecycleResult<PersistedSpecificationPhase> | null;
    if (!finalResult) {
      if (!transactionCommitted) cleanupAttemptRollback();
      return fail("SPEC_PHASE_PERSIST_FAILED", "phase persistence transaction completed without a result");
    }
    if (!finalResult.ok) {
      if (!transactionCommitted) cleanupAttemptRollback();
      return finalResult;
    }
    if (transaction.committed && transaction.state?.specification) {
      return { ...finalResult, value: { ...finalResult.value, workspace: transaction.state.specification } };
    }
    return finalResult;
  } catch (error) {
    if (!transactionCommitted) cleanupAttemptRollback();
    return fail("SPEC_PHASE_PERSIST_FAILED", `phase result persistence failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pinnedRoot.close();
  }
}

function persistSpecificationPhaseResultInternal(projectRoot: string, input: SpecificationWorkerResultInput, stageWorkspace: (workspace: FeatureWorkspace) => void, pinnedRoot: PinnedProjectRoot, snapshotWorkspace: FeatureWorkspace | null, stateSnapshot: StateSnapshot, registerRollback: (rollback: PhasePersistenceRollback) => void, registerPostCommit: (action: () => void) => void): PhaseLifecycleResult<PersistedSpecificationPhase> {
  const workspaceResult = currentWorkspace(projectRoot, input, snapshotWorkspace, { allowMigrated: true });
  if (!workspaceResult.ok) return workspaceResult;
  const workspace = workspaceResult.value;
  const constitutionBinding = workspace.constitution_binding;
  if (!constitutionBinding) return fail("SPEC_PHASE_STALE", "current constitution binding is unavailable");
  const liveConstitution = readPinnedCurrentConstitution(projectRoot, pinnedRoot, constitutionBinding);
  if (!liveConstitution.ok) return fail("SPEC_PHASE_STALE", liveConstitution.error);
  const record = phaseRecord(workspace, input.phase);
  if (!record || !["generating", "revision_required", "not_started", "materialized"].includes(record.status)) return fail("SPEC_PHASE_CONFLICT", "phase " + input.phase + " cannot accept a result from status " + (record?.status ?? "missing"));
  const expectedVersion = record.status === "materialized" && record.current_version !== null ? record.current_version : (record.current_version ?? 0) + 1;
  if (input.version !== expectedVersion) return fail("SPEC_PHASE_STALE", "expected " + input.phase + ".v" + expectedVersion + ", received v" + input.version);
  const artifactId = input.phase + ".v" + input.version;
  const artifactsRelative = join(".work-state", "features", input.feature_id, "artifacts");
  const artifactRelative = join(artifactsRelative, artifactId + ".json");
  const existing = readVersion(projectRoot, input.feature_id, artifactId, input.run_key, pinnedRoot);
  if (!stateSnapshot.state) return fail("SPEC_PHASE_FORBIDDEN", "workflow state unavailable during phase result persistence");
  const lifecycle = resolveSpecificationPhaseDispatch(projectRoot, { ...authInput(input), dispatch_id: input.dispatch_id, allow_committed_replay: existing !== null }, { state: stateSnapshot.state, target: stateSnapshot.target, pinnedRoot });
  if (!lifecycle.ok) return fail("SPEC_PHASE_FORBIDDEN", lifecycle.error);
  if (lifecycle.record.purpose !== "generation") return fail("SPEC_PHASE_FORBIDDEN", "phase result requires a generation dispatch; validation dispatches cannot publish immutable artifacts");
  if (lifecycle.work_identity.stage_cursor !== input.phase || lifecycle.capability_epoch !== input.cursor_epoch) return fail("SPEC_PHASE_FORBIDDEN", "worker result phase/capability epoch mismatch");
  const upstream = expectedUpstream(projectRoot, workspace, input.phase, input.run_key, pinnedRoot);
  if (!upstream.ok) return upstream;
  const envelopeIssue = validateWorkerEnvelope(input, workspace, lifecycle.work_identity, upstream.value);
  if (envelopeIssue) return fail("SPEC_PHASE_STALE", envelopeIssue);
  const sourceModelResult = canonicalSourceModel(input.phase, input.source_artifact, { featureId: input.feature_id, runKey: input.run_key, version: input.version, dispatchId: input.dispatch_id, constitution: input.constitution_binding, upstream: upstream.value });
  if (!sourceModelResult.ok) return fail(sourceModelResult.error.includes("semantic_model is required") ? "SPEC_SEMANTIC_MODEL_REQUIRED" : "SPEC_PHASE_STALE", sourceModelResult.error);
  if (!same(input.semantic_sections, sourceModelResult.value.sections)) return fail("SPEC_PHASE_STALE", "semantic_sections must equal the complete typed semantic model sections");
  const upstreamModelsResult = readPinnedUpstreamSemanticModels(projectRoot, input.feature_id, input.run_key, upstream.value, pinnedRoot);
  if (!upstreamModelsResult.ok) return fail("SPEC_PHASE_STALE", upstreamModelsResult.error);
  const upstreamSemanticIssue = phaseSemanticUpstreamIssue(input.phase, sourceModelResult.value, upstreamModelsResult.value);
  if (upstreamSemanticIssue) return fail("SPEC_PHASE_STALE", upstreamSemanticIssue);
  const constitutionPrinciples = liveConstitution.value.identities;
  const constitutionPrincipleIssue = phaseConstitutionPrincipleIssue(sourceModelResult.value, input.constitution_binding, constitutionPrinciples);
  if (constitutionPrincipleIssue) return fail("SPEC_PHASE_STALE", constitutionPrincipleIssue);
  const legacyFallback = isLegacyMaterializedArtifact(workspace, { schema_version: 1, source_artifact: input.source_artifact });
  const phaseTemplate = legacyFallback ? null : resolveNativePhaseTemplate(projectRoot, workspace, input.phase, pinnedRoot);
  if (!legacyFallback && !phaseTemplate?.ok) return fail("SPEC_PHASE_STALE", phaseTemplate?.error ?? "selected native phase template is unavailable");
  const primaryDocument = input.documents.find((document) => document.path === PHASE_DOCUMENT[input.phase]);
  if (!primaryDocument) return fail("SPEC_PHASE_STALE", "phase primary document is missing");
  const documentRoundtripIssue = phaseDocumentRoundtripIssue(primaryDocument.content, input.phase, sourceModelResult.value, phaseTemplate?.ok === true ? phaseTemplate.value : undefined);
  if (documentRoundtripIssue) {
    const code = documentRoundtripIssue.startsWith("canonical ") ? "SPEC_PHASE_REQUEST_INVALID" : "SPEC_PHASE_STALE";
    return fail(code, documentRoundtripIssue);
  }
  const canonicalDocuments = [...input.documents].sort((left, right) => left.path.localeCompare(right.path));
  const requestDigest = digestOf({ feature_id: input.feature_id, run_key: input.run_key, phase: input.phase, version: input.version, request_id: input.request_id, dispatch_id: input.dispatch_id, source_artifact: input.source_artifact, documents: canonicalDocuments, semantic_sections: input.semantic_sections, constitution_binding: input.constitution_binding, upstream_versions: input.upstream_versions, template_hash: input.template_hash, language_hash: input.language_hash });
  const semanticSectionHashes = Object.fromEntries(Object.entries(sourceModelResult.value.sections).sort(([left], [right]) => left.localeCompare(right)).map(([marker, content]) => [marker, sha256Hex(content)]));
  const provisional: PersistedPhaseResultEnvelope = { schema_version: 1, feature_id: input.feature_id, run_key: input.run_key, request_id: input.request_id, request_digest: requestDigest, source_artifact_id: PHASE_SOURCE_ARTIFACT[input.phase], source_artifact: input.source_artifact, artifact_id: artifactId, phase: input.phase, version: input.version, dispatch_id: input.dispatch_id, work_identity: lifecycle.work_identity, capability_epoch: lifecycle.capability_epoch, source_artifact_hash: digestOf(input.source_artifact), semantic_model: sourceModelResult.value, document_paths: input.documents.map((document) => document.path).sort(), document_hashes: Object.fromEntries(input.documents.map((document) => [document.path, sha256Hex(document.content)])), semantic_section_hashes: semanticSectionHashes, template_hash: input.template_hash, language_hash: input.language_hash, upstream_versions: upstream.value, created_at: new Date().toISOString(), constitution_binding: input.constitution_binding };
  const materializeRequest: MaterializedDocumentRequest & { binding: PhaseArtifactVersion } = { feature_id: input.feature_id, run_key: input.run_key, phase: input.phase, version: input.version, documents: input.documents, binding: provisional };
  const nextWorkspace = withMaterializedPhase(workspace, input.phase, input.version, upstream.value);
  const txPath = phaseTransactionPath(input.feature_id, requestDigest);
  const projectionPath = join(artifactsRelative, `${PHASE_SOURCE_ARTIFACT[input.phase]}.json`);
  const manifestPath = join(artifactsRelative, "documents", input.phase, `v${input.version}.json`);
  const readableProjectionPaths = input.documents.map((document) => join("specs", input.feature_id, document.path));
  const attemptRollback = createPhasePersistenceRollback(pinnedRoot, [txPath, ...readableProjectionPaths, manifestPath, projectionPath]);
  registerRollback(attemptRollback);
  const retiredReadableDocuments: Array<{ path: string; expected: PinnedRootFileExpectation }> = [];
  const registerRetiredReadableCleanup = (): void => {
    if (retiredReadableDocuments.length === 0) return;
    const removals = retiredReadableDocuments.splice(0);
    registerPostCommit(() => {
      for (const removal of removals) {
        try { pinnedRoot.removeFileIfMatches(removal.path, removal.expected); } catch { /* preserve a concurrent replacement */ }
      }
    });
  };
  try {
    const loadedJournal = loadPhaseTransaction(pinnedRoot, txPath, requestDigest);
    if (loadedJournal) injectPhaseFailure("after_journal_parse");
    const pending = loadedJournal?.transaction ?? null;
    let journalRead = loadedJournal?.read ?? null;
    let journalExpectation = journalRead?.expectation ?? null;
    if (loadedJournal && !phaseJournalReadMatches(pinnedRoot, txPath, loadedJournal.read)) {
      return fail("SPEC_PHASE_RECOVERY_REQUIRED", "phase persistence journal descriptor changed after parse; preserve the replacement and recover the original journal before retrying");
    }
    if (pending && (pending.feature_id !== input.feature_id || pending.run_key !== input.run_key || pending.phase !== input.phase || pending.version !== input.version || pending.artifact_path !== artifactRelative)) {
      return fail("SPEC_PHASE_PERSIST_FAILED", "phase persistence journal identity does not match the requested worker result");
    }
    if (pending) {
      const currentWorkspaceDigest = digestOf(workspace);
      if (currentWorkspaceDigest !== pending.workspace_before_digest && currentWorkspaceDigest !== digestOf(pending.next_workspace)) {
        return fail("SPEC_PHASE_PERSIST_FAILED", "phase persistence journal workspace snapshot does not match the current workspace");
      }
    }
    if (pending && !same(pending.next_workspace, nextWorkspace)) {
      return fail("SPEC_PHASE_PERSIST_FAILED", "phase persistence journal next workspace does not match the requested result");
    }
    if (pending && !phaseArtifactMatchesCandidate(pending.materialize_request.binding as unknown as PersistedPhaseResultEnvelope, provisional)) {
      return fail("SPEC_PHASE_PERSIST_FAILED", "phase persistence journal artifact does not match the requested result");
    }
    if (!existing && pinnedRoot.listDirectory(artifactsRelative).includes(artifactId + ".json")) return fail("SPEC_PHASE_IMMUTABLE", "immutable artifact " + artifactId + " is malformed or does not match the requested phase result");
    if (existing) {
      if (!phaseArtifactMatchesCandidate(existing, provisional)) return fail("SPEC_PHASE_IMMUTABLE", `immutable artifact '${artifactId}' already exists for a different or tampered request`);
      const replayWorkspace = record.current_version === input.version && record.status === "materialized" ? workspace : nextWorkspace;
      const committedWorkspace = replayWorkspace;
      if (replayWorkspace !== workspace) {
        stageWorkspace(replayWorkspace);
      }
      injectPhaseFailure("before_projection");
      const beforeReplayProjectionConstitution = readPinnedCurrentConstitution(projectRoot, pinnedRoot, constitutionBinding);
      if (!beforeReplayProjectionConstitution.ok) return fail("SPEC_PHASE_STALE", beforeReplayProjectionConstitution.error);
      const projection = ensurePhaseProjection(projectRoot, materializeRequest, true, pinnedRoot, committedWorkspace, (path, descriptor) => { attemptRollback.capture(path); attemptRollback.plan(path, { kind: descriptor?.kind ?? "write", ...(descriptor?.descriptor ? { descriptor: descriptor.descriptor } : {}) }); }, (path, receipt) => { attemptRollback.setPreimage(path, receipt.preimage); attemptRollback.plan(path, { kind: "write", descriptor: receipt.descriptor }); }, (path, descriptor) => { if (descriptor?.receipt) attemptRollback.setPreimage(path, descriptor.receipt.preimage); if (descriptor?.descriptor) attemptRollback.recordCurrent(path, descriptor.descriptor); }, (path, expected) => retiredReadableDocuments.push({ path, expected }));
      if (!projection.ok) return fail("SPEC_PHASE_PERSIST_FAILED", projection.error);
      registerRetiredReadableCleanup();
      injectPhaseFailure("before_projection_artifact");
      const artifactProjection = ensureNativePhaseArtifactProjection(pinnedRoot, artifactsRelative, PHASE_SOURCE_ARTIFACT[input.phase], existing.semantic_model as SpecificationSemanticModel, {
        projectRoot,
        featureId: input.feature_id,
        runKey: input.run_key,
        phase: input.phase,
        version: input.version,
        workspace,
        pinnedRoot,
        beforeWrite: phaseConstitutionWriteGuard(projectRoot, pinnedRoot, constitutionBinding),
        onWritten: (descriptor) => attemptRollback.recordCurrent(projectionPath, descriptor),
        ...(pending ? { transaction: pending } : {}),
      });
      if (!artifactProjection.ok) return fail(artifactProjection.code, artifactProjection.error);
      for (const document of input.documents) attemptRollback.capture(join("specs", input.feature_id, document.path));
      injectPhaseFailure("after_projection");
      injectPhaseFailure("before_cleanup");
      if (journalExpectation) {
        try { pinnedRoot.removeFileIfMatches(txPath, journalExpectation); } catch (error) { return fail("SPEC_PHASE_PERSIST_FAILED", `phase persistence journal cleanup failed: ${String(error)}`); }
      }
      injectPhaseFailure("after_cleanup");
      injectPhaseFailure("after_commit");
      return { ok: true, replayed: true, value: { workspace: committedWorkspace, version: existing, handoff_required: input.phase === "tasks" } };
    }

    let projectionBefore: NativeProjectionPreimage | null;
    try {
      projectionBefore = projectionPreimage(pinnedRoot, projectionPath);
    } catch (error) {
      return fail("SPEC_PHASE_PERSIST_FAILED", `native artifact projection preimage could not be captured: ${error instanceof Error ? error.message : String(error)}`);
    }
    const transaction: PhasePersistenceTransaction = {
      schema_version: 1,
      transaction_id: randomUUID(),
      request_digest: requestDigest,
      feature_id: input.feature_id,
      run_key: input.run_key,
      phase: input.phase,
      version: input.version,
      artifact_path: artifactRelative,
      projection_path: projectionPath,
      projection_preimage: projectionBefore,
      projection_postimage_sha256: sha256Bytes(nativeProjectionBytes(sourceModelResult.value)),
      artifact_content: `${JSON.stringify(provisional, null, 2)}\n`,
      materialize_request: materializeRequest,
      workspace_before_digest: digestOf(workspace),
      next_workspace: nextWorkspace,
    };
    const serializedTransaction = `${JSON.stringify(transaction, null, 2)}\n`;
    if (Buffer.byteLength(serializedTransaction, "utf8") > MAX_PHASE_TRANSACTION_BYTES) {
      return fail("SPEC_PHASE_PERSIST_FAILED", "phase persistence journal exceeds the bounded size");
    }
    injectPhaseFailure("before_prepare");
    const beforePrepareConstitution = readPinnedCurrentConstitution(projectRoot, pinnedRoot, constitutionBinding);
    if (!beforePrepareConstitution.ok) return fail("SPEC_PHASE_STALE", beforePrepareConstitution.error);
    if (!pending) {
      phaseConstitutionWriteGuard(projectRoot, pinnedRoot, constitutionBinding)();
      attemptRollback.plan(txPath, { kind: "write" });
      const transactionReceipt = pinnedRoot.writeExclusiveWithReceipt(txPath, serializedTransaction, { beforePublish: (receipt) => attemptRollback.recordReceipt(txPath, receipt) });
      attemptRollback.setPreimage(txPath, transactionReceipt.preimage);
      attemptRollback.recordCurrent(txPath, transactionReceipt.descriptor);
      journalRead = {
        bytes: Buffer.from(serializedTransaction, "utf8"),
        expectation: {
          dev: transactionReceipt.descriptor.dev,
          ino: transactionReceipt.descriptor.ino,
          size: transactionReceipt.descriptor.size,
          sha256: transactionReceipt.descriptor.sha256,
        },
      };
      journalExpectation = journalRead.expectation;
    }
    if (!journalExpectation) return fail("SPEC_PHASE_PERSIST_FAILED", "phase persistence journal disappeared before phase commit");
    injectPhaseFailure("after_prepare");
    if (journalRead && !phaseJournalReadMatches(pinnedRoot, txPath, journalRead)) {
      return fail("SPEC_PHASE_RECOVERY_REQUIRED", "phase persistence journal descriptor changed after prepare; preserve the replacement and recover the original journal before retrying");
    }

    let persistedEnvelope = provisional;
    let racedReplay = false;
    injectPhaseFailure("before_artifact_write");
    const beforeArtifactConstitution = readPinnedCurrentConstitution(projectRoot, pinnedRoot, constitutionBinding);
    if (!beforeArtifactConstitution.ok) return fail("SPEC_PHASE_STALE", beforeArtifactConstitution.error);
    try {
      phaseConstitutionWriteGuard(projectRoot, pinnedRoot, constitutionBinding)();
      const artifactReceipt = pinnedRoot.writeExclusiveWithReceipt(artifactRelative, transaction.artifact_content);
      attemptRollback.recordImmutableCreated(artifactRelative, transaction.artifact_content, artifactReceipt.descriptor);
    } catch (error) {
      if (!(error instanceof PinnedRootError) || error.code !== "exists") return fail("SPEC_PHASE_PERSIST_FAILED", `immutable '${artifactId}' could not be durably published: ${String(error)}`);
      const raced = readVersion(projectRoot, input.feature_id, artifactId, input.run_key, pinnedRoot);
      if (!raced || !phaseArtifactMatchesCandidate(raced, provisional)) return fail("SPEC_PHASE_IMMUTABLE", `failed to create immutable '${artifactId}' exclusively: ${String(error)}`);
      persistedEnvelope = raced;
      racedReplay = true;
    }
    injectPhaseFailure("after_artifact_write");

    injectPhaseFailure("before_state_write");
    stageWorkspace(nextWorkspace);
    const committedWorkspace = nextWorkspace;

    injectPhaseFailure("before_projection");
    const beforeProjectionConstitution = readPinnedCurrentConstitution(projectRoot, pinnedRoot, constitutionBinding);
    if (!beforeProjectionConstitution.ok) return fail("SPEC_PHASE_STALE", beforeProjectionConstitution.error);
    const projection = ensurePhaseProjection(projectRoot, materializeRequest, false, pinnedRoot, nextWorkspace, (path, descriptor) => { attemptRollback.capture(path); attemptRollback.plan(path, { kind: descriptor?.kind ?? "write", ...(descriptor?.descriptor ? { descriptor: descriptor.descriptor } : {}) }); }, (path, receipt) => { attemptRollback.setPreimage(path, receipt.preimage); attemptRollback.plan(path, { kind: "write", descriptor: receipt.descriptor }); }, (path, descriptor) => { if (descriptor?.receipt) attemptRollback.setPreimage(path, descriptor.receipt.preimage); if (descriptor?.descriptor) attemptRollback.recordCurrent(path, descriptor.descriptor); }, (path, expected) => retiredReadableDocuments.push({ path, expected }));
    if (!projection.ok) return fail("SPEC_PHASE_PERSIST_FAILED", projection.error);
    registerRetiredReadableCleanup();
    for (const document of input.documents) attemptRollback.capture(join("specs", input.feature_id, document.path));
    const envelope: PersistedPhaseResultEnvelope = { ...persistedEnvelope, document_hashes: projection.value.document_hashes };
    injectPhaseFailure("before_projection_artifact");
    const beforeProjectionArtifactConstitution = readPinnedCurrentConstitution(projectRoot, pinnedRoot, constitutionBinding);
    if (!beforeProjectionArtifactConstitution.ok) return fail("SPEC_PHASE_STALE", beforeProjectionArtifactConstitution.error);
    const artifactProjection = ensureNativePhaseArtifactProjection(pinnedRoot, artifactsRelative, PHASE_SOURCE_ARTIFACT[input.phase], sourceModelResult.value, {
      projectRoot,
      featureId: input.feature_id,
      runKey: input.run_key,
      phase: input.phase,
      version: input.version,
      workspace,
      pinnedRoot,
      beforeWrite: phaseConstitutionWriteGuard(projectRoot, pinnedRoot, constitutionBinding),
      onWritten: (descriptor) => attemptRollback.recordCurrent(projectionPath, descriptor),
      transaction,
    });
    if (!artifactProjection.ok) return fail(artifactProjection.code, artifactProjection.error);
    injectPhaseFailure("after_projection");
    injectPhaseFailure("before_cleanup");
    if (!journalExpectation) return fail("SPEC_PHASE_PERSIST_FAILED", "phase persistence journal expectation is unavailable");
    try { pinnedRoot.removeFileIfMatches(txPath, journalExpectation); } catch (error) { return fail("SPEC_PHASE_PERSIST_FAILED", `phase persistence journal cleanup failed: ${String(error)}`); }
    injectPhaseFailure("after_cleanup");
    injectPhaseFailure("after_commit");
    return { ok: true, replayed: racedReplay, value: { workspace: committedWorkspace, version: envelope, handoff_required: input.phase === "tasks" } };
  } catch (error) {
    return fail("SPEC_PHASE_PERSIST_FAILED", `phase result persistence failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface PhaseCheckpointPresentation {
  phase: WorkspacePhase;
  version: number;
  checkpoint_id: typeof PHASE_CHECKPOINT;
  allowed_decisions: string[];
  revision_feedback: string | null;
}

export interface PhaseCheckpointDecisionInput {
  feature_id: string;
  run_key: string;
  phase: WorkspacePhase;
  checkpoint_id: string;
  decision: string;
  authorization: string;
  actor_provenance: CheckpointActor;
  feedback?: string;
}

export interface PhaseCheckpointDecision {
  decision: string;
  phase: WorkspacePhase;
  version: number;
  replay: boolean;
  status: "approved" | "revision_required";
  revision_feedback: string | null;
  resume_next_phase: WorkspacePhase | null;
  dispatched_next_phase: WorkspacePhase | null;
}


function strictValidationKeys(value: Record<string, unknown>, path: string, issues: string[]): void {
  const allowed = ["validation_id", "phase", "artifact_version", "artifact_digest", "status", "checks", "blocking_findings", "warnings", "constitution", "traceability_summary", "validator_version", "validated_at"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${path}.${key} is an unknown field`);
}

function strictValidationFinding(value: unknown, path: string, expectedSeverity?: "blocking" | "warning"): boolean {
  if (!isRecord(value)) return false;
  const issues: string[] = [];
  strictKeys(value, ["code", "severity", "subject_id", "message", "evidence_refs", "remediation"], path, issues);
  if (!nonEmptyPhaseString(value.code)) issues.push(`${path}.code is missing`);
  if (value.severity !== "blocking" && value.severity !== "warning") issues.push(`${path}.severity is invalid`);
  if (expectedSeverity && value.severity !== expectedSeverity) issues.push(`${path}.severity is not ${expectedSeverity}`);
  if (value.subject_id !== null && !nonEmptyPhaseString(value.subject_id)) issues.push(`${path}.subject_id is invalid`);
  if (!nonEmptyPhaseString(value.message)) issues.push(`${path}.message is missing`);
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.some((ref) => !nonEmptyPhaseString(ref))) issues.push(`${path}.evidence_refs is invalid`);
  if (value.remediation !== null && !nonEmptyPhaseString(value.remediation)) issues.push(`${path}.remediation is invalid`);
  return issues.length === 0;
}
/** Build the deterministic validation payload for one verified immutable artifact. */
export function deterministicValidationInputForArtifact(
  artifact: PersistedPhaseResultEnvelope,
  pinnedRoot: PinnedProjectRoot,
  validatedAt = new Date().toISOString(),
): NativePhaseValidationInput | null {
  if (!isRecord(artifact.source_artifact) || !isRecord(artifact.source_artifact.semantic_model)) return null;
  const sourceModelResult = canonicalSourceModel(artifact.phase, artifact.source_artifact, {
    featureId: artifact.feature_id,
    runKey: artifact.run_key,
    version: artifact.version,
    dispatchId: artifact.dispatch_id,
    constitution: artifact.constitution_binding,
    upstream: artifact.upstream_versions,
  });
  if (!sourceModelResult.ok || !same(sourceModelResult.value, artifact.semantic_model)) return null;
  const primaryPath = PHASE_DOCUMENT[artifact.phase];
  const documentSha256 = artifact.source_artifact.document_sha256;
  if (!isSha256Hex(documentSha256) || artifact.document_hashes[primaryPath] !== documentSha256) return null;
  let primaryContent: string;
  try {
    primaryContent = new TextDecoder("utf-8", { fatal: true }).decode(
      pinnedRoot.readFile(join("specs", artifact.feature_id, primaryPath), { maxBytes: MAX_PHASE_INPUT_BYTES }).bytes,
    );
    if (!pinnedRoot.isStable() || sha256Hex(primaryContent) !== documentSha256) return null;
  } catch {
    return null;
  }
  const model = sourceModelResult.value;
  const workspace = resolveFeatureWorkspace(pinnedRoot.canonical_root, { feature_id: artifact.feature_id, run_key: artifact.run_key }, { lexical_root: pinnedRoot.lexical_root, canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino, pinned_root: pinnedRoot }, { persistMigration: false });
  if (!workspace.ok) return null;
  const legacyFallback = isLegacyMaterializedArtifact(workspace.value, artifact);
  const phaseTemplate = legacyFallback ? null : resolveNativePhaseTemplate(pinnedRoot.canonical_root, workspace.value, artifact.phase, pinnedRoot);
  const selectedTemplate = phaseTemplate?.ok === true ? phaseTemplate.value : undefined;
  if ((!legacyFallback && selectedTemplate === undefined)
    || primaryContent !== renderCanonicalPhaseDocument(artifact.phase, model, selectedTemplate)) return null;
  const sections = Object.fromEntries(Object.entries(model.sections).map(([key, value]) => [key, value])) as Record<string, string>;
  return {
    validation_id: `validation.${artifact.phase}.v${artifact.version}`,
    feature_id: artifact.feature_id,
    run_key: artifact.run_key,
    phase: artifact.phase,
    version: artifact.version,
    artifact_version: artifact.artifact_id,
    document_path: primaryPath,
    document_sha256: documentSha256,
    sections,
    upstream_versions: artifact.upstream_versions,
    expected_upstream_versions: artifact.upstream_versions,
    constitution_binding: artifact.constitution_binding,
    expected_constitution_binding: artifact.constitution_binding,
    constitution_principles: model.constitution_principles.map((principle) => ({
      principle_id: principle.principle_id,
      status: principle.status,
      evidence: principle.evidence,
    })),
    requirements: model.requirements,
    decisions: model.decisions,
    tasks: model.tasks.map((item) => ({ task_id: item.id, id: item.id, title: item.title, requirement_ids: [...item.requirement_ids], acceptance_ids: [...item.acceptance_ids], decision_ids: [...item.decision_ids], verification_ids: [...item.verification_ids], depends_on: [...item.depends_on], expected_outcome: item.expected_outcome, affected_scope: [...item.affected_scope], completion_evidence: [...item.completion_evidence], parallel_safe: item.parallel_safe })),
    verification: model.verification,
    contradictions: model.contradictions,
    validated_at: validatedAt,
    validator_version: "specification-validation@3",
  };
}

export function deterministicValidationMatchesArtifact(
  artifact: PersistedPhaseResultEnvelope,
  persisted: unknown,
  pinnedRoot: PinnedProjectRoot,
  selectedTemplate?: NativePhaseTemplate,
): boolean {
  if (!isRecord(persisted)
    || typeof persisted.validation_id !== "string"
    || typeof persisted.validated_at !== "string"
    || (persisted.validator_version !== undefined && typeof persisted.validator_version !== "string")
    || !isRecord(artifact.source_artifact)
    || !isRecord(artifact.source_artifact.semantic_model)) return false;
  if (!isSha256Hex(persisted.artifact_digest) || persisted.artifact_digest !== digestOf(artifact)) return false;
  const sourceModelResult = canonicalSourceModel(artifact.phase, artifact.source_artifact, {
    featureId: artifact.feature_id,
    runKey: artifact.run_key,
    version: artifact.version,
    dispatchId: artifact.dispatch_id,
    constitution: artifact.constitution_binding,
    upstream: artifact.upstream_versions,
  });
  if (!sourceModelResult.ok) return false;
  const primaryPath = PHASE_DOCUMENT[artifact.phase];
  let primaryContent: string;
  try {
    primaryContent = new TextDecoder("utf-8", { fatal: true }).decode(
      pinnedRoot.readFile(join("specs", artifact.feature_id, primaryPath), { maxBytes: MAX_PHASE_INPUT_BYTES }).bytes,
    );
    if (!pinnedRoot.isStable()) return false;
  } catch {
    return false;
  }
  const model = sourceModelResult.value;
  let phaseTemplate: NativePhaseTemplate | undefined = selectedTemplate;
  if (selectedTemplate === undefined) {
    const workspace = resolveFeatureWorkspace(pinnedRoot.canonical_root, { feature_id: artifact.feature_id, run_key: artifact.run_key }, { lexical_root: pinnedRoot.lexical_root, canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino, pinned_root: pinnedRoot }, { persistMigration: false });
    if (!workspace.ok) return false;
    const legacyFallback = isLegacyMaterializedArtifact(workspace.value, artifact);
    const resolved = legacyFallback ? null : resolveNativePhaseTemplate(pinnedRoot.canonical_root, workspace.value, artifact.phase, pinnedRoot);
    if (!legacyFallback && resolved?.ok !== true) return false;
    phaseTemplate = resolved?.ok === true ? resolved.value : undefined;
  }
  const documentSha256 = artifact.source_artifact.document_sha256;
  if (!isSha256Hex(documentSha256)) return false;
  const sections = Object.fromEntries(Object.entries(model.sections).map(([key, value]) => [key, value])) as Record<string, string>;
  const input: NativePhaseValidationInput = {
    validation_id: `validation.${artifact.phase}.v${artifact.version}`,
    feature_id: artifact.feature_id,
    run_key: artifact.run_key,
    phase: artifact.phase,
    version: artifact.version,
    artifact_version: artifact.artifact_id,
    document_path: primaryPath,
    document_sha256: documentSha256,
    sections,
    upstream_versions: artifact.upstream_versions,
    expected_upstream_versions: artifact.upstream_versions,
    constitution_binding: artifact.constitution_binding,
    expected_constitution_binding: artifact.constitution_binding,
    constitution_principles: model.constitution_principles.map((principle) => ({
      principle_id: principle.principle_id,
      status: principle.status,
      evidence: principle.evidence,
    })),
    requirements: model.requirements,
    decisions: model.decisions,
    tasks: model.tasks.map((item) => ({ task_id: item.id, id: item.id, title: item.title, requirement_ids: [...item.requirement_ids], acceptance_ids: [...item.acceptance_ids], decision_ids: [...item.decision_ids], verification_ids: [...item.verification_ids], depends_on: [...item.depends_on], expected_outcome: item.expected_outcome, affected_scope: [...item.affected_scope], completion_evidence: [...item.completion_evidence], parallel_safe: item.parallel_safe })),
    verification: model.verification,
    contradictions: model.contradictions,
    validated_at: persisted.validated_at,
    ...(typeof persisted.validator_version === "string" ? { validator_version: persisted.validator_version } : {}),
  };
  const renderEqual = primaryContent === renderCanonicalPhaseDocument(artifact.phase, model, phaseTemplate);
  const hashesEqual = sha256Hex(primaryContent) === artifact.document_hashes[primaryPath]
    && artifact.source_artifact.document_sha256 === artifact.document_hashes[primaryPath];
  if (!hashesEqual || !renderEqual) return false;
  const comparable = { ...persisted };
  delete comparable.artifact_digest;
  return same(validateNativePhase(input), comparable);
}

function strictValidationResult(value: unknown, workspace: FeatureWorkspace, record: WorkspacePhaseRecord, artifact: PersistedPhaseResultEnvelope, materialized: ReturnType<typeof revalidateMaterializedDocuments>, runKey: string, pinnedRoot: PinnedProjectRoot): boolean {
  if (!isRecord(value)) return false;
  const issues: string[] = [];
  strictValidationKeys(value, "phase validation", issues);
  const expectedArtifactId = `${record.phase}.v${record.current_version}`;
  const expectedValidationId = `validation.${record.phase}.v${record.current_version}`;
  if (value.validation_id !== expectedValidationId || value.phase !== record.phase || value.artifact_version !== expectedArtifactId || value.status !== "pass") return false;
  if (!nonEmptyPhaseString(value.validator_version) || !nonEmptyPhaseString(value.validated_at) || Number.isNaN(Date.parse(value.validated_at as string))) return false;

  if (!Array.isArray(value.checks) || value.checks.length < 2) return false;
  const checkIds = new Set<string>();
  let hasBindings = false;
  let hasContent = false;
  for (const [index, check] of value.checks.entries()) {
    if (!isRecord(check)) return false;
    const checkIssues: string[] = [];
    strictKeys(check, ["check_id", "status", "evidence", "remediation"], `phase validation.checks[${index}]`, checkIssues);
    for (const key of Object.keys(check)) if (!["check_id", "status", "evidence", "remediation"].includes(key)) checkIssues.push(key);
    if (checkIssues.length > 0 || !nonEmptyPhaseString(check.check_id) || checkIds.has(check.check_id) || check.status !== "pass" || !nonEmptyPhaseString(check.evidence) || check.remediation !== null) return false;
    checkIds.add(check.check_id);
    if (check.check_id === "exact_bindings") hasBindings = true;
    if (check.check_id === `${record.phase}_content`) hasContent = true;
  }
  if (!hasBindings || !hasContent) return false;
  if (!Array.isArray(value.blocking_findings) || value.blocking_findings.length !== 0) return false;
  if (!Array.isArray(value.warnings)) return false;
  for (const [index, finding] of value.warnings.entries()) if (!strictValidationFinding(finding, `phase validation.warnings[${index}]`, "warning")) return false;

  if (!isRecord(value.constitution)) return false;
  strictKeys(value.constitution, ["binding", "principles"], "phase validation.constitution", issues);
  if (Object.keys(value.constitution).some((key) => !["binding", "principles"].includes(key))) return false;
  if (validateConstitutionBinding(value.constitution.binding).length > 0
    || !same(value.constitution.binding, workspace.constitution_binding)
    || !same(value.constitution.binding, artifact.constitution_binding)
    || !Array.isArray(value.constitution.principles)
    || value.constitution.principles.length === 0) return false;
  const principles = new Set<string>();
  for (const [index, principle] of value.constitution.principles.entries()) {
    if (!isRecord(principle)) return false;
    strictKeys(principle, ["principle_id", "status", "evidence"], `phase validation.constitution.principles[${index}]`, issues);
    if (Object.keys(principle).some((key) => !["principle_id", "status", "evidence"].includes(key))) return false;
    if (!nonEmptyPhaseString(principle.principle_id) || principles.has(principle.principle_id)
      || (principle.status !== "pass" && principle.status !== "not_applicable")
      || !nonEmptyPhaseString(principle.evidence)) return false;
    principles.add(principle.principle_id);
  }

  if (record.phase === "specify") {
    if (value.traceability_summary !== null) return false;
  } else {
    if (!isRecord(value.traceability_summary)) return false;
    strictKeys(value.traceability_summary, ["requirements_total", "requirements_with_acceptance", "decisions_linked", "tasks_linked", "verification_linked", "missing_ids"], "phase validation.traceability_summary", issues);
    if (Object.keys(value.traceability_summary).some((key) => !["requirements_total", "requirements_with_acceptance", "decisions_linked", "tasks_linked", "verification_linked", "missing_ids"].includes(key))) return false;
    for (const key of ["requirements_total", "requirements_with_acceptance", "decisions_linked", "tasks_linked", "verification_linked"] as const) {
      if (!Number.isInteger(value.traceability_summary[key]) || (value.traceability_summary[key] as number) < 0) return false;
    }
    if (!Array.isArray(value.traceability_summary.missing_ids) || value.traceability_summary.missing_ids.some((id: unknown) => !nonEmptyPhaseString(id)) || value.traceability_summary.missing_ids.length > 0) return false;
  }

  if (!materialized.ok) return false;
  const docs = materialized.value.documents;
  const expectedPaths = Object.keys(artifact.document_hashes).sort((left, right) => left.localeCompare(right));
  const actualPaths = Object.keys(docs).sort((left, right) => left.localeCompare(right));
  if (!same(expectedPaths, actualPaths)) return false;
  for (const path of expectedPaths) {
    const document = docs[path];
    if (!document || !document.matches || document.expected_sha256 !== artifact.document_hashes[path]) return false;
  }
  const binding = materialized.value.binding;
  if (!binding || binding.feature_id !== workspace.feature_id || binding.run_key !== runKey || binding.phase !== record.phase || binding.version !== record.current_version || binding.artifact_id !== artifact.artifact_id || !same(binding.constitution_binding, artifact.constitution_binding) || !same(binding.upstream_versions, artifact.upstream_versions) || binding.worker.dispatch_id !== artifact.dispatch_id || !same(binding.worker.work_identity, artifact.work_identity)) return false;
  const legacyFallback = isLegacyMaterializedArtifact(workspace, artifact);
  const phaseTemplate = legacyFallback ? null : resolveNativePhaseTemplate(workspace.project_root, workspace, record.phase, pinnedRoot);
  return issues.length === 0
    && (legacyFallback || phaseTemplate?.ok === true)
    && (workspace.source_kind !== "native" || deterministicValidationMatchesArtifact(artifact, value, pinnedRoot, phaseTemplate?.ok === true ? phaseTemplate.value : undefined));
}

function readPinnedArtifact<T>(pinnedRoot: PinnedProjectRoot, featureId: string, artifactId: string): T | null {
  if (!isSafeFeatureId(featureId) || !/^[A-Za-z0-9._-]+$/.test(artifactId)) return null;
  return readPinnedRelativeArtifact<T>(pinnedRoot, join(".work-state", "features", featureId, "artifacts", artifactId + ".json"));
}

function readPinnedRelativeArtifact<T>(pinnedRoot: PinnedProjectRoot, relativePath: string): T | null {
  try {
    const first = pinnedRoot.readFile(relativePath, { maxBytes: MAX_PHASE_TRANSACTION_BYTES });
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(first.bytes);
    const parsed: unknown = JSON.parse(decoded);
    const shapeIssue = boundedPhaseTransactionShape(parsed);
    if (shapeIssue) return null;
    const second = pinnedRoot.readFile(relativePath, { maxBytes: MAX_PHASE_TRANSACTION_BYTES });
    if (first.dev !== second.dev || first.ino !== second.ino || Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes)) !== 0 || !pinnedRoot.isStable()) return null;
    return parsed as T;
  } catch {
    return null;
  }
}
function migratedReceipt(pinnedRoot: PinnedProjectRoot, workspace: FeatureWorkspace, runKey: string): Record<string, unknown> | null {
  const reference = workspace.migration_receipt_ref;
  if (typeof reference !== "string" || !/^migration-[a-f0-9]{24}$/.test(reference)) return null;
  const receiptId = reference;
  const receiptPath = join(".work-state", "features", workspace.feature_id, "artifacts", "migration", receiptId + ".json");
  const snapshot: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };
  const parsedReceipt = readMigrationReceiptPinned(snapshot, receiptPath, {
    id: receiptId,
    expectedPath: join(pinnedRoot.canonical_root, ...receiptPath.split("/")),
    verifyRootStability: true,
  });
  if (!parsedReceipt.ok) return null;
  const receipt = parsedReceipt.value as unknown as Record<string, unknown>;
  if (!pinnedRoot.isStable()) return null;
  if (!receipt || receipt.id !== receiptId || receipt.status !== "complete" || receipt.outcome !== "migrated" || receipt.feature_id !== workspace.feature_id || receipt.run_key !== runKey || !Array.isArray(receipt.diagnostics) || receipt.diagnostics.length !== 0) return null;
  if (receipt.project_root !== pinnedRoot.canonical_root || receipt.workspace_path !== "specs/" + workspace.feature_id || receipt.state_path !== ".work-state/features/" + workspace.feature_id + "/state.json") return null;
  if (receipt.project_root_dev !== pinnedRoot.dev || receipt.project_root_ino !== pinnedRoot.ino) return null;
  if (!isSha256Hex(receipt.source_digest) || !isSha256Hex(receipt.source_sha256) || receipt.source_digest !== receipt.source_sha256) return null;
  if (typeof receipt.migrated_at !== "string" || Number.isNaN(Date.parse(receipt.migrated_at))) return null;
  if (!Array.isArray(receipt.legacy_inputs) || receipt.legacy_inputs.some((entry) => typeof entry !== "string")) return null;
  if (!isRecord(receipt.constitution_binding) || typeof receipt.constitution_binding.version !== "string" || !isSha256Hex(receipt.constitution_binding.fingerprint)) return null;
  const binding = workspace.constitution_binding;
  if (!binding || binding.version !== receipt.constitution_binding.version || binding.content_sha256 !== receipt.constitution_binding.fingerprint) return null;
  return receipt;
}

function migratedPhaseEnvelopeValid(
  pinnedRoot: PinnedProjectRoot,
  workspace: FeatureWorkspace,
  record: WorkspacePhaseRecord,
  runKey: string,
  artifact: PersistedPhaseResultEnvelope,
  receipt: Record<string, unknown>,
  materialized: ReturnType<typeof revalidateMaterializedDocuments>,
): boolean {
  if (artifact.artifact_id !== record.phase + ".v" + record.current_version || artifact.version !== record.current_version || artifact.phase !== record.phase) return false;
  if (!isRecord(artifact.source_artifact)
    || artifact.source_artifact.source_kind !== "legacy"
    || artifact.source_artifact.approved !== false
    || artifact.source_artifact.source_sha256 !== receipt.source_sha256
    || artifact.source_artifact.project_root !== pinnedRoot.canonical_root
    || artifact.source_artifact.project_root_dev !== pinnedRoot.dev
    || artifact.source_artifact.project_root_ino !== pinnedRoot.ino
    || artifact.source_artifact.request_id !== artifact.request_id
    || !same(artifact.source_artifact.semantic_model, artifact.semantic_model)) return false;
  if (!materialized.ok || !materialized.value.binding || materialized.value.binding.artifact_id !== artifact.artifact_id || !same(materialized.value.binding.constitution_binding, artifact.constitution_binding) || !same(materialized.value.binding.upstream_versions, artifact.upstream_versions)) return false;
  for (const upstream of artifact.upstream_versions) {
    const loaded = readVersion(workspace.project_root, workspace.feature_id, upstream.artifact_id, runKey, pinnedRoot);
    if (!loaded || semanticArtifactHash(loaded) !== upstream.hash) return false;
  }
  return true;
}

function currentValidationPostimagePass(projectRoot: string, workspace: FeatureWorkspace, record: WorkspacePhaseRecord, runKey: string, pinnedRoot: PinnedProjectRoot): boolean {
  if (record.current_version === null || !Number.isInteger(record.current_version) || record.current_version < 1) return false;
  const expectedRef = `validation.${record.phase}.v${record.current_version}`;
  if (record.validation_ref !== expectedRef) return false;
  const artifact = readVersion(projectRoot, workspace.feature_id, `${record.phase}.v${record.current_version}`, runKey, pinnedRoot);
  if (!artifact) return false;
  const materialized = revalidateMaterializedDocumentsPinned(pinnedRoot, { feature_id: workspace.feature_id, phase: record.phase, version: record.current_version });
  if (((workspace.source_kind as string) === "legacy" || (workspace.source_kind as string) === "migrated") && artifact.source_artifact.source_kind === "legacy") {
    const receipt = migratedReceipt(pinnedRoot, workspace, runKey);
    if (!receipt || !migratedPhaseEnvelopeValid(pinnedRoot, workspace, record, runKey, artifact, receipt, materialized)) return false;
  }
  const value = readPinnedArtifact<unknown>(pinnedRoot, workspace.feature_id, expectedRef);
  if (!strictValidationResult(value, workspace, record, artifact, materialized, runKey, pinnedRoot)) return false;
  return phaseValidationProjectionMatchesPinned(pinnedRoot, workspace.feature_id, value as PhaseValidationResult);
}

function validationPass(projectRoot: string, workspace: FeatureWorkspace, record: WorkspacePhaseRecord, runKey: string, pinnedRoot: PinnedProjectRoot, postimageValid = currentValidationPostimagePass(projectRoot, workspace, record, runKey, pinnedRoot)): boolean {
  injectPhaseFailure("before_checkpoint_validation");
  return record.status === "awaiting_approval" && postimageValid;
}

function checkpointFreshnessError(
  projectRoot: string,
  workspace: FeatureWorkspace,
  phase: WorkspacePhase,
  runKey: string,
  record: WorkspacePhaseRecord | null,
  pinnedRoot: PinnedProjectRoot,
): string | null {
  const binding = workspace.constitution_binding;
  if (!binding) return "checkpoint workspace constitution binding is unavailable";
  const current = readPinnedCurrentConstitution(projectRoot, pinnedRoot, binding);
  if (!current.ok) return "current constitution is not usable: " + current.error;
  if (!record || record.current_version === null || !Number.isSafeInteger(record.current_version) || record.current_version < 1) {
    return "checkpoint phase does not have a current immutable version";
  }
  const artifact = readVersion(projectRoot, workspace.feature_id, phase + ".v" + record.current_version, runKey, pinnedRoot);
  if (!artifact) return "current immutable phase artifact is unavailable";
  const bindingIdentity = (candidate: ConstitutionBinding | null | undefined): string => candidate ? canonicalJson(candidate) : "null";
  if (bindingIdentity(current.value.binding) !== bindingIdentity(workspace.constitution_binding)
    || bindingIdentity(current.value.binding) !== bindingIdentity(artifact.constitution_binding)) {
    return "current constitution binding does not match the workspace and immutable phase artifact";
  }
  const validationRef = "validation." + phase + ".v" + record.current_version;
  if (record.validation_ref !== validationRef) return "checkpoint validation reference is not current";
  const validation = readPinnedArtifact<unknown>(pinnedRoot, workspace.feature_id, validationRef);
  if (!isRecord(validation) || validation.validation_id !== validationRef || validation.status !== "pass") {
    return "current phase validation evidence is unavailable or not passing";
  }
  if (!isRecord(validation.constitution)
    || bindingIdentity(validation.constitution.binding as ConstitutionBinding | undefined) !== bindingIdentity(artifact.constitution_binding)) {
    return "phase validation binding does not match the immutable phase artifact";
  }
  if (!currentValidationPostimagePass(projectRoot, workspace, record, runKey, pinnedRoot)) {
    return "current phase artifact, validation, or readable projection is stale";
  }
  return null;
}

function boundedValidationEvidence(value: unknown): value is PhaseValidationResult {
  if (!isRecord(value)) return false;
  const shapeIssue = boundedPhaseTransactionShape(value);
  if (shapeIssue) return false;
  const issues: string[] = [];
  strictValidationKeys(value, "phase validation", issues);
  if (!nonEmptyPhaseString(value.validation_id) || !/^validation\.(specify|plan|tasks)\.v[1-9][0-9]*$/u.test(value.validation_id)) return false;
  if (!PHASES.includes(value.phase as WorkspacePhase) || !/^(specify|plan|tasks)\.v[1-9][0-9]*$/u.test(String(value.artifact_version))) return false;
  if (value.status !== "pass" && value.status !== "fail") return false;
  if (!Array.isArray(value.checks) || value.checks.length > 64 || !Array.isArray(value.blocking_findings) || value.blocking_findings.length > 4096 || !Array.isArray(value.warnings) || value.warnings.length > 4096) return false;
  if (!isRecord(value.constitution) || !Array.isArray(value.constitution.principles) || value.constitution.principles.length > 4096 || validateConstitutionBinding(value.constitution.binding).length > 0) return false;
  if (value.artifact_digest !== undefined && !isSha256Hex(value.artifact_digest)) return false;
  return nonEmptyPhaseString(value.validator_version)
    && nonEmptyPhaseString(value.validated_at)
    && !Number.isNaN(Date.parse(value.validated_at));
}

function validationEvidencePath(featureId: string, validation: PhaseValidationResult, failed: boolean): string {
  const version = validation.artifact_version.split('.v')[1];
  const suffix = failed ? '.attempt.' + digestOf(validation) : '';
  return join('.work-state', 'features', featureId, 'artifacts', 'validation.' + validation.phase + '.v' + version + suffix + '.json');
}

type ValidationEvidenceWriteResult =
  | { ok: true; replayed: boolean; receipt?: PinnedRootWriteReceipt }
  | { ok: false; code: "SPEC_PHASE_STALE" | "SPEC_PHASE_PERSIST_FAILED"; error: string };

function persistValidationEvidence(
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
  value: PhaseValidationResult,
  beforeWrite: () => string | null,
): ValidationEvidenceWriteResult {
  const content = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(content, "utf8") > MAX_PHASE_TRANSACTION_BYTES) {
    return { ok: false, code: "SPEC_PHASE_PERSIST_FAILED", error: "validation evidence exceeds the bounded file size" };
  }
  try {
    injectPhaseFailure("before_validation_evidence_write");
    const freshnessError = beforeWrite();
    if (freshnessError) {
      return { ok: false, code: "SPEC_PHASE_STALE", error: freshnessError };
    }
    const receipt = pinnedRoot.writeExclusiveWithReceipt(relativePath, content);
    return { ok: true, replayed: false, receipt };
  } catch (error) {
    if (!(error instanceof PinnedRootError) || error.code !== 'exists') {
      return { ok: false, code: "SPEC_PHASE_PERSIST_FAILED", error: 'validation evidence could not be persisted: ' + String(error) };
    }
    try {
      const existing = readPinnedRelativeArtifact<unknown>(pinnedRoot, relativePath);
      if (!boundedValidationEvidence(existing)) {
        return { ok: false, code: "SPEC_PHASE_PERSIST_FAILED", error: "immutable validation evidence '" + relativePath + "' is unreadable or exceeds bounded schema limits" };
      }
      return same(existing, value)
        ? { ok: true, replayed: true }
        : { ok: false, code: "SPEC_PHASE_PERSIST_FAILED", error: "immutable validation evidence '" + relativePath + "' already exists for a different result" };
    } catch (readError) {
      return { ok: false, code: "SPEC_PHASE_PERSIST_FAILED", error: "immutable validation evidence '" + relativePath + "' is unreadable: " + String(readError) };
    }
  }
}

function phaseLiveConstitutionError(
  pinnedRoot: PinnedProjectRoot,
  workspace: FeatureWorkspace,
  artifact: PersistedPhaseResultEnvelope,
): string | null {
  const expected = workspace.constitution_binding;
  if (!expected) return "specification workspace has no constitution binding";
  const current = readPinnedCurrentConstitution(pinnedRoot.canonical_root, pinnedRoot, expected);
  if (!current.ok) return "live constitution is unavailable: " + current.error;
  const comparable = (binding: ConstitutionBinding | null | undefined): string => {
    if (!binding) return "null";
    const { bound_at: _boundAt, ...semantic } = binding;
    return canonicalJson(semantic);
  };
  if (comparable(current.value.binding) !== comparable(artifact.constitution_binding)) {
    return "live constitution binding does not match immutable phase artifact";
  }
  return null;
}

function phaseConstitutionWriteGuard(
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot,
  constitutionBinding: ConstitutionBinding,
): () => void {
  return () => {
    const current = readPinnedCurrentConstitution(projectRoot, pinnedRoot, constitutionBinding);
    if (!current.ok) throw new Error("SPEC_PHASE_STALE:" + current.error);
  };
}

function phaseValidationEvidenceError(
  pinnedRoot: PinnedProjectRoot,
  workspace: FeatureWorkspace,
  artifact: PersistedPhaseResultEnvelope,
  validation: PhaseValidationResult,
): string | null {
  const constitutionError = phaseLiveConstitutionError(pinnedRoot, workspace, artifact);
  if (constitutionError) return constitutionError;
  if (!same(validation.constitution.binding, artifact.constitution_binding)) {
    return "validation evidence constitution binding does not match immutable phase artifact";
  }
  return null;
}

function phaseValidationProjectionGuard(
  pinnedRoot: PinnedProjectRoot,
  workspace: FeatureWorkspace,
  artifact: PersistedPhaseResultEnvelope,
): (path: string) => void {
  return () => {
    const constitutionError = phaseLiveConstitutionError(pinnedRoot, workspace, artifact);
    if (constitutionError) throw new Error("SPEC_PHASE_STALE:" + constitutionError);
  };
}

function validationInputMismatch(actual: unknown, expected: unknown, field: string): string | null {
  return same(actual, expected) ? null : 'validation ' + field + ' is not bound to the current immutable phase artifact';
}

/**
 * Validate and persist one exact materialized phase revision. The caller must
 * hold a live validation-stage dispatch; the terminal worker dispatch that
 * produced the phase artifact is deliberately not accepted as authority.
 */
export function persistSpecificationPhaseValidation(
  projectRoot: string,
  callerInput: SpecificationPhaseValidationInput,
): PhaseLifecycleResult<PhaseValidationResult> {
  const inputError = nativeCapabilityInputError(callerInput, ["role", "slot_id", "agent", "retry_of", "dispatch_id"]);
  if (inputError) return fail('SPEC_PHASE_REQUEST_INVALID', inputError);
  const ownedInput = cloneBoundedPhaseInput(callerInput);
  if (!ownedInput.ok) return fail('SPEC_PHASE_REQUEST_INVALID', ownedInput.error);
  const input = ownedInput.value;
  const selectorError = validateSelector(input);
  if (selectorError) return fail('SPEC_PHASE_REQUEST_INVALID', selectorError);
  if (!input.dispatch_id?.trim()) return fail('SPEC_PHASE_REQUEST_INVALID', 'an explicit validation dispatch_id is required');
  if (!input.validation || typeof input.validation !== 'object') return fail('SPEC_PHASE_REQUEST_INVALID', 'an explicit validation payload is required');
  const validationPreparation = phaseValidationWorkIssue(input.validation);
  if (!validationPreparation.ok) return fail('SPEC_PHASE_REQUEST_INVALID', "error" in validationPreparation ? validationPreparation.error : "validation preparation failed");
  let prevalidatedValidation: PhaseValidationResult | null = null;
  try { prevalidatedValidation = validateNativePhase(input.validation as unknown as NativePhaseValidationInput, validationPreparation.indexes); }
  catch (error) { prevalidatedValidation = malformedNativePhaseValidation(input, 'phase validation input is malformed: ' + String(error)); }
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return fail('SPEC_PHASE_PERSIST_FAILED', 'project root cannot be pinned for phase validation');
  const rollbackHolder: { value: PhasePersistenceRollback | null } = { value: null };
  const postCommitActions: Array<() => void> = [];
  let transactionCommitted = false;
  const cleanupAttemptRollback = (): void => {
    rollbackHolder.value?.cleanup();
  };
  try {
    let result: PhaseLifecycleResult<PhaseValidationResult> | null = null;
    let preCommitConstitutionGuard: (() => void) | null = null;
    const transaction = updateStateAtomically(projectRoot, (snapshot) => {
      if (!snapshot.state || !snapshot.target.statePath) {
        result = fail('SPEC_PHASE_FORBIDDEN', 'workflow state unavailable during phase validation');
        return { op: 'discard' as const };
      }
      const state = snapshot.state;
      const workspace = state.specification;
      if (!workspace || workspace.feature_id !== input.feature_id || workspace.project_root !== pinnedRoot.canonical_root) {
        result = fail('SPEC_PHASE_FORBIDDEN', 'selected specification workspace is unavailable or not bound to the pinned project root');
        return { op: 'discard' as const };
      }
      if (workspace.source_kind !== 'native' && workspace.source_kind !== 'legacy') {
        result = fail('SPEC_PHASE_FORBIDDEN', 'phase validation requires a native or verified migrated workspace');
        return { op: 'discard' as const };
      }
      const record = phaseRecord(workspace, input.phase);
      if (!record || record.current_version === null || record.current_version < 1) {
        result = fail('SPEC_PHASE_NOT_READY', "phase '" + input.phase + "' has no current immutable version");
        return { op: 'discard' as const };
      }
      if (!['materialized', 'validating', 'awaiting_approval'].includes(record.status)) {
        result = fail('SPEC_PHASE_CONFLICT', "phase '" + input.phase + "' cannot be validated from status '" + record.status + "'");
        return { op: 'discard' as const };
      }
      const lifecycle = resolveSpecificationPhaseDispatch(projectRoot, { ...authInput(input), dispatch_id: input.dispatch_id, allow_committed_replay: true }, { state, target: snapshot.target, pinnedRoot });
      const artifact = readVersion(projectRoot, input.feature_id, input.phase + '.v' + record.current_version, input.run_key, pinnedRoot);
      if (!artifact) {
        result = fail('SPEC_PHASE_STALE', "current immutable artifact '" + input.phase + '.v' + record.current_version + "' is missing or invalid");
        return { op: 'discard' as const };
      }
      preCommitConstitutionGuard = () => {
        const constitutionError = phaseLiveConstitutionError(pinnedRoot, workspace, artifact);
        if (constitutionError) throw new Error("SPEC_PHASE_STALE:" + constitutionError);
      };
      if (!lifecycle.ok) {
        result = fail('SPEC_PHASE_FORBIDDEN', lifecycle.error);
        return { op: 'discard' as const };
      }
      if (lifecycle.record.purpose !== 'validation') {
        result = fail('SPEC_PHASE_FORBIDDEN', 'phase validation requires a dedicated validation dispatch, not a generation worker dispatch');
        return { op: 'discard' as const };
      }
      const primaryPath = PHASE_DOCUMENT[input.phase];
      const primaryHash = artifact.document_hashes[primaryPath];
      if (!primaryHash || !isSha256Hex(primaryHash) || artifact.source_artifact.document_sha256 !== primaryHash) {
        result = fail('SPEC_PHASE_STALE', "immutable '" + artifact.artifact_id + "' has no exact primary document binding");
        return { op: 'discard' as const };
      }
      let primaryContent: string;
      try {
        primaryContent = new TextDecoder("utf-8", { fatal: true }).decode(
          pinnedRoot.readFile(join(workspace.workspace_path, primaryPath), { maxBytes: MAX_PHASE_INPUT_BYTES }).bytes,
        );
        if (!pinnedRoot.isStable()) throw new Error("pinned project root changed while reading the primary phase document");
      } catch (error) {
        result = fail('SPEC_PHASE_STALE', "current primary document '" + primaryPath + "' is unreadable: " + String(error));
        return { op: 'discard' as const };
      }
      if (sha256Hex(primaryContent) !== primaryHash) {
        result = fail('SPEC_PHASE_STALE', "current primary document '" + primaryPath + "' no longer matches '" + artifact.artifact_id + "'");
        return { op: 'discard' as const };
      }
      const materialized = revalidateMaterializedDocumentsPinned(pinnedRoot, { feature_id: input.feature_id, phase: input.phase, version: record.current_version });
      if (!materialized.ok || Object.values(materialized.value.documents).some((document) => !document.matches)
        || !materialized.value.binding || materialized.value.binding.artifact_id !== artifact.artifact_id
        || !same(materialized.value.binding.constitution_binding, artifact.constitution_binding)
        || !same(materialized.value.binding.upstream_versions, artifact.upstream_versions)) {
        result = fail('SPEC_PHASE_STALE', 'materialized documents or their binding no longer match the immutable phase artifact');
        return { op: 'discard' as const };
      }
      const sourceModelResult = canonicalSourceModel(input.phase, artifact.source_artifact, { featureId: artifact.feature_id, runKey: artifact.run_key, version: artifact.version, dispatchId: artifact.dispatch_id, constitution: artifact.constitution_binding, upstream: artifact.upstream_versions });
      if (!sourceModelResult.ok) {
        const reason = sourceModelResult.error;
        const remediation = PHASE_COMMAND[input.phase] + ' --feature ' + input.feature_id;
        const attempt: PhaseValidationResult = {
          validation_id: 'validation.' + input.phase + '.v' + record.current_version,
          phase: input.phase,
          artifact_version: artifact.artifact_id,
          artifact_digest: digestOf(artifact),
          status: 'fail',
          checks: [{ check_id: 'semantic_model', status: 'fail', evidence: reason, remediation }],
          blocking_findings: [{ code: 'SPEC_SEMANTIC_MODEL_REQUIRED', severity: 'blocking', subject_id: null, message: reason, evidence_refs: [], remediation }],
          warnings: [],
          constitution: { binding: artifact.constitution_binding, principles: [] },
          traceability_summary: null,
          validator_version: 'engine.semantic-model.v1',
          validated_at: new Date().toISOString(),
        };
        const evidencePath = validationEvidencePath(input.feature_id, attempt, true);
        const constitutionError = phaseLiveConstitutionError(pinnedRoot, workspace, artifact);
        if (constitutionError) { result = fail('SPEC_PHASE_STALE', constitutionError); return { op: 'discard' as const }; }
        const persistedAttempt = persistValidationEvidence(pinnedRoot, evidencePath, attempt, () => phaseValidationEvidenceError(pinnedRoot, workspace, artifact, attempt));
        if (!persistedAttempt.ok) { result = fail(persistedAttempt.code, persistedAttempt.error); return { op: 'discard' as const }; }
        const beforeProjectionConstitution = phaseLiveConstitutionError(pinnedRoot, workspace, artifact);
        if (beforeProjectionConstitution) { result = fail('SPEC_PHASE_STALE', beforeProjectionConstitution); return { op: 'discard' as const }; }
        const attemptReport = materializePhaseValidationPinned(pinnedRoot, input.feature_id, attempt, { beforeWrite: phaseValidationProjectionGuard(pinnedRoot, workspace, artifact) });
        if (!attemptReport.ok) { result = fail('SPEC_PHASE_PERSIST_FAILED', attemptReport.error); return { op: 'discard' as const }; }
        const consumed = consumeSpecificationPhaseValidationDispatch(state, input.dispatch_id, 'failed', reason);
        if (!consumed.ok) { result = fail('SPEC_PHASE_PERSIST_FAILED', consumed.error); return { op: 'discard' as const }; }
        const code = reason.includes('semantic_model is required') ? 'SPEC_SEMANTIC_MODEL_REQUIRED' : 'SPEC_PHASE_STALE';
        result = fail(code, reason);
        return { op: 'commit' as const, state: { ...consumed.state, specification: revisionRequiredWorkspace(workspace, input.phase, input.feature_id, reason, evidencePath.endsWith('.json') ? evidencePath.slice(0, -5) : evidencePath) }, value: result };
      }
      if (isRecord(artifact.semantic_model) && !same(artifact.semantic_model, sourceModelResult.value)) {
        result = fail('SPEC_PHASE_IMMUTABLE', 'immutable phase semantic_model copy does not match its source semantic model');
        return { op: 'discard' as const };
      }
      const migratedArtifact = workspace.source_kind === 'legacy' && artifact.source_artifact.source_kind === 'legacy';
      const receipt = migratedArtifact ? migratedReceipt(pinnedRoot, workspace, input.run_key) : null;
      if (migratedArtifact && (!receipt || !migratedPhaseEnvelopeValid(pinnedRoot, workspace, record, input.run_key, artifact, receipt, materialized))) {
        result = fail('SPEC_PHASE_STALE', 'migrated phase receipt or immutable envelope is not current');
        return { op: 'discard' as const };
      }
      const expected = migratedArtifact
        ? { ok: true as const, value: artifact.upstream_versions }
        : expectedUpstream(projectRoot, workspace, input.phase, input.run_key, pinnedRoot);
      if (!expected.ok || !same(artifact.upstream_versions, expected.value)) {
        result = fail('SPEC_PHASE_STALE', expected.ok ? 'immutable phase upstream binding is stale' : expected.error);
        return { op: 'discard' as const };
      }
      const payload = input.validation as NativePhaseValidationInput;
      const upstreamModels: SpecificationSemanticModel[] = [];
      for (const binding of artifact.upstream_versions) {
        const upstreamArtifact = readVersion(projectRoot, input.feature_id, binding.artifact_id, input.run_key, pinnedRoot);
        if (!upstreamArtifact) { result = fail('SPEC_PHASE_STALE', 'required upstream artifact ' + binding.artifact_id + ' is missing'); return { op: 'discard' as const }; }
        const upstreamModel = canonicalSourceModel(upstreamArtifact.phase, upstreamArtifact.source_artifact, { featureId: upstreamArtifact.feature_id, runKey: upstreamArtifact.run_key, version: upstreamArtifact.version, dispatchId: upstreamArtifact.dispatch_id, constitution: upstreamArtifact.constitution_binding, upstream: upstreamArtifact.upstream_versions });
        if (!upstreamModel.ok) {
          const reason = 'required upstream artifact ' + binding.artifact_id + ' has no valid semantic model';
          const remediation = PHASE_COMMAND[input.phase] + ' --feature ' + input.feature_id;
          const attempt: PhaseValidationResult = { validation_id: 'validation.' + input.phase + '.v' + record.current_version, phase: input.phase, artifact_version: artifact.artifact_id, artifact_digest: digestOf(artifact), status: 'fail', checks: [{ check_id: 'semantic_model', status: 'fail', evidence: reason, remediation }], blocking_findings: [{ code: 'SPEC_SEMANTIC_MODEL_REQUIRED', severity: 'blocking', subject_id: null, message: reason, evidence_refs: [], remediation }], warnings: [], constitution: { binding: artifact.constitution_binding, principles: [] }, traceability_summary: null, validator_version: 'engine.semantic-model.v1', validated_at: new Date().toISOString() };
          const evidencePath = validationEvidencePath(input.feature_id, attempt, true);
          const constitutionError = phaseLiveConstitutionError(pinnedRoot, workspace, artifact);
          if (constitutionError) { result = fail('SPEC_PHASE_STALE', constitutionError); return { op: 'discard' as const }; }
          const persistedAttempt = persistValidationEvidence(pinnedRoot, evidencePath, attempt, () => phaseValidationEvidenceError(pinnedRoot, workspace, artifact, attempt));
          if (!persistedAttempt.ok) { result = fail(persistedAttempt.code, persistedAttempt.error); return { op: 'discard' as const }; }
          const beforeProjectionConstitution = phaseLiveConstitutionError(pinnedRoot, workspace, artifact);
          if (beforeProjectionConstitution) { result = fail('SPEC_PHASE_STALE', beforeProjectionConstitution); return { op: 'discard' as const }; }
          const attemptReport = materializePhaseValidationPinned(pinnedRoot, input.feature_id, attempt, { beforeWrite: phaseValidationProjectionGuard(pinnedRoot, workspace, artifact) });
          if (!attemptReport.ok) { result = fail('SPEC_PHASE_PERSIST_FAILED', attemptReport.error); return { op: 'discard' as const }; }
          const consumed = consumeSpecificationPhaseValidationDispatch(state, input.dispatch_id, 'failed', reason);
          if (!consumed.ok) { result = fail('SPEC_PHASE_PERSIST_FAILED', consumed.error); return { op: 'discard' as const }; }
          result = fail('SPEC_SEMANTIC_MODEL_REQUIRED', reason);
          return { op: 'commit' as const, state: { ...consumed.state, specification: revisionRequiredWorkspace(workspace, input.phase, input.feature_id, reason, evidencePath.endsWith('.json') ? evidencePath.slice(0, -5) : evidencePath) }, value: result };
        }
        upstreamModels.push(upstreamModel.value);
      }
      const constitutionPrinciples = readPinnedConstitutionPrincipleIdentities(pinnedRoot, artifact.constitution_binding);
      if (!constitutionPrinciples.ok) { result = fail('SPEC_PHASE_STALE', "error" in constitutionPrinciples ? constitutionPrinciples.error : 'approved constitution principle derivation failed'); return { op: 'discard' as const }; }
      const constitutionPrincipleIssue = phaseConstitutionPrincipleIssue(sourceModelResult.value, artifact.constitution_binding, constitutionPrinciples.value);
      if (constitutionPrincipleIssue) { result = fail('SPEC_PHASE_STALE', constitutionPrincipleIssue); return { op: 'discard' as const }; }
      const upstreamSemanticIssue = phaseSemanticUpstreamIssue(input.phase, sourceModelResult.value, upstreamModels);
      if (upstreamSemanticIssue) { result = fail('SPEC_PHASE_STALE', upstreamSemanticIssue); return { op: 'discard' as const }; }
      const expectedSemantic = semanticModelReports(input.phase, sourceModelResult.value, upstreamModels);
      const expectedSections = sourceModelResult.value.sections;
      const semanticFactsMismatch = !same(payload.sections, expectedSections)
        || !same(payload.requirements, expectedSemantic.requirements)
        || !same(payload.decisions, expectedSemantic.decisions)
        || !same(payload.tasks, expectedSemantic.tasks)
        || !same(payload.verification, expectedSemantic.verification);
      const semanticObservationMismatch = semanticFactsMismatch
        || !same(payload.constitution_principles, expectedSemantic.constitution_principles);
      const immutableIdentityMismatch = !same(payload.validation_id, `validation.${input.phase}.v${record.current_version}`)
        || !same(payload.feature_id, artifact.feature_id)
        || !same(payload.run_key, artifact.run_key)
        || !same(payload.phase, artifact.phase)
        || !same(payload.version, artifact.version)
        || !same(payload.artifact_version, artifact.artifact_id)
        || !same(payload.document_path, primaryPath)
        || !same(payload.document_sha256, primaryHash)
        || !same(payload.upstream_versions, artifact.upstream_versions)
        || !same(payload.expected_upstream_versions, expected.value)
        || !same(payload.constitution_binding, artifact.constitution_binding)
        || !same(payload.expected_constitution_binding, workspace.constitution_binding);
      const malformedValidationInput = prevalidatedValidation?.blocking_findings.some((finding) => finding.code === "SPEC_VALIDATION_INPUT_MALFORMED") ?? true;
      const failedValidationIsBound = prevalidatedValidation?.status === "fail" && !malformedValidationInput && !immutableIdentityMismatch;
      if ((semanticFactsMismatch && !failedValidationIsBound)
        || (semanticObservationMismatch && (malformedValidationInput || immutableIdentityMismatch || prevalidatedValidation?.status !== "fail"))) {
        const reason = 'validation report does not exactly match the immutable semantic model and rendered document';
        result = fail('SPEC_PHASE_STALE', reason);
        return { op: 'discard' as const };
      }
      const legacyFallback = isLegacyMaterializedArtifact(workspace, artifact);
      const phaseTemplate = legacyFallback ? null : resolveNativePhaseTemplate(projectRoot, workspace, input.phase, pinnedRoot);
      if (!legacyFallback && !phaseTemplate?.ok) {
        result = fail('SPEC_PHASE_STALE', phaseTemplate?.error ?? 'presentation template is unavailable');
        return { op: 'discard' as const };
      }
      const documentRoundtripIssue = phaseDocumentRoundtripIssue(primaryContent, input.phase, sourceModelResult.value, phaseTemplate?.ok === true ? phaseTemplate.value : undefined);
      if (documentRoundtripIssue && !legacyFallback) {
        result = fail('SPEC_PHASE_STALE', documentRoundtripIssue);
        return { op: 'discard' as const };
      }
      const immutableChecks: Array<[unknown, unknown, string]> = [
        [payload.validation_id, 'validation.' + input.phase + '.v' + record.current_version, 'validation_id'],
        [payload.feature_id, artifact.feature_id, 'feature_id'],
        [payload.run_key, artifact.run_key, 'run_key'],
        [payload.phase, artifact.phase, 'phase'],
        [payload.version, artifact.version, 'version'],
        [payload.artifact_version, artifact.artifact_id, 'artifact_version'],
        [payload.document_path, primaryPath, 'document_path'],
        [payload.document_sha256, primaryHash, 'document_sha256'],
        [payload.upstream_versions, artifact.upstream_versions, 'upstream_versions'],
        [payload.expected_upstream_versions, expected.value, 'expected_upstream_versions'],
        [payload.constitution_binding, artifact.constitution_binding, 'constitution_binding'],
        [payload.expected_constitution_binding, workspace.constitution_binding, 'expected_constitution_binding'],
      ];
      const mismatch = immutableChecks.map(([actual, expectedValue, field]) => validationInputMismatch(actual, expectedValue, field)).find((entry): entry is string => entry !== null);
      if (mismatch) {
        result = fail('SPEC_PHASE_STALE', mismatch);
        return { op: 'discard' as const };
      }
      if (!isRecord(payload.sections)) {
        result = fail('SPEC_PHASE_STALE', 'validation section observations are not byte-bound to the immutable semantic model');
        return { op: 'discard' as const };
      }
      const validationBase = prevalidatedValidation ?? malformedNativePhaseValidation(input, 'phase validation input is malformed');
      const validation: PhaseValidationResult = workspace.source_kind === "native"
        ? { ...validationBase, artifact_digest: digestOf(artifact) }
        : validationBase;
      const validationRef = 'validation.' + input.phase + '.v' + record.current_version;
      const prePersistConstitutionError = phaseLiveConstitutionError(pinnedRoot, workspace, artifact);
      if (prePersistConstitutionError) {
        result = fail('SPEC_PHASE_STALE', prePersistConstitutionError);
        return { op: 'discard' as const };
      }
      const candidateRecord: WorkspacePhaseRecord = { ...record, status: 'awaiting_approval', validation_ref: validationRef };
      const strictPass = validation.status === 'pass' && strictValidationResult(validation, workspace, candidateRecord, artifact, materialized, input.run_key, pinnedRoot);
      const evidencePath = validationEvidencePath(input.feature_id, validation, !strictPass);
      const validationProjectionPath = join("specs", input.feature_id, "validation", input.phase + ".md");
      const validationRollback = createPhasePersistenceRollback(pinnedRoot, [evidencePath, validationProjectionPath]);
      rollbackHolder.value = validationRollback;
      const persisted = persistValidationEvidence(pinnedRoot, evidencePath, validation, () => phaseValidationEvidenceError(pinnedRoot, workspace, artifact, validation));
      if (!persisted.ok) {
        result = fail(persisted.code, persisted.error);
        return { op: 'discard' as const };
      }
      if (persisted.receipt) validationRollback.recordReceipt(evidencePath, persisted.receipt);
      if (strictPass) {
        const beforeProjectionConstitution = phaseLiveConstitutionError(pinnedRoot, workspace, artifact);
        if (beforeProjectionConstitution) { result = fail('SPEC_PHASE_STALE', beforeProjectionConstitution); return { op: 'discard' as const }; }
        const projection = materializePhaseValidationPinned(pinnedRoot, input.feature_id, validation, {
          beforeWrite: phaseValidationProjectionGuard(pinnedRoot, workspace, artifact),
          beforePublish: (receipt) => validationRollback.recordReceipt(validationProjectionPath, receipt),
          onWritten: (_path, descriptor) => { if (descriptor) validationRollback.recordCurrent(validationProjectionPath, descriptor); },
        });
        if (!projection.ok) {
          result = fail('SPEC_PHASE_PERSIST_FAILED', projection.error);
          return { op: 'discard' as const };
        }
        if (!projection.value.replayed) persisted.replayed = false;
      }
      if (!strictPass) {
        // A deterministic, artifact-bound failure is still a readable report.
        // Malformed, stale, or otherwise non-current input is never allowed to
        // replace the report already bound to this phase revision.
        if (validation.status === 'fail' && failedValidationIsBound) {
          const beforeProjectionConstitution = phaseLiveConstitutionError(pinnedRoot, workspace, artifact);
          if (beforeProjectionConstitution) { result = fail('SPEC_PHASE_STALE', beforeProjectionConstitution); return { op: 'discard' as const }; }
          const failureReport = materializePhaseValidationPinned(pinnedRoot, input.feature_id, validation, {
            beforeWrite: phaseValidationProjectionGuard(pinnedRoot, workspace, artifact),
            beforePublish: (receipt) => validationRollback.recordReceipt(validationProjectionPath, receipt),
            onWritten: (_path, descriptor) => { if (descriptor) validationRollback.recordCurrent(validationProjectionPath, descriptor); },
          });
          if (!failureReport.ok && failureReport.code !== 'SPEC_ARTIFACT_IMMUTABLE' && failureReport.code !== 'SPEC_REQUEST_INVALID') {
            result = fail('SPEC_PHASE_PERSIST_FAILED', failureReport.error);
            return { op: 'discard' as const };
          }
 
        }
        const consumed = consumeSpecificationPhaseValidationDispatch(state, input.dispatch_id, 'failed', validation.status === 'pass'
          ? "phase '" + input.phase + "' validation evidence was structurally inconsistent with its immutable artifact"
          : "phase '" + input.phase + "' validation failed; remediation is required before opening its hard-human checkpoint");
        if (!consumed.ok) {
          result = fail('SPEC_PHASE_PERSIST_FAILED', consumed.error);
          return { op: 'discard' as const };
        }
        const failureReason = validation.status === 'pass'
          ? "phase '" + input.phase + "' validation evidence is structurally inconsistent with its immutable artifact"
          : "phase '" + input.phase + "' validation failed; remediation is required before opening its hard-human checkpoint";
        const failureWorkspace = revisionRequiredWorkspace(workspace, input.phase, input.feature_id, failureReason, evidencePath.endsWith('.json') ? evidencePath.slice(0, -5) : evidencePath);
        result = fail('SPEC_CHECKPOINT_BLOCKED', failureReason);
        return { op: 'commit' as const, state: { ...consumed.state, specification: failureWorkspace }, value: result };
      }
      if (record.status === 'awaiting_approval' && record.validation_ref === validationRef) {
        result = { ok: true, replayed: true, value: validation };
        return { op: 'discard' as const, value: result };
      }
      const nextWorkspace: FeatureWorkspace = {
        ...workspace,
        status: 'in_progress',
        phases: workspace.phases.map((candidate) => candidate.phase === input.phase
          ? { ...candidate, status: 'awaiting_approval', validation_ref: validationRef, checkpoint_ref: null, stale_reason: null }
          : candidate),
        next_action: { kind: 'checkpoint', command: null, reason: "Validation '" + validationRef + "' passed for '" + artifact.artifact_id + "'; the hard-human checkpoint is ready." },
      };
      const consumed = consumeSpecificationPhaseValidationDispatch(state, input.dispatch_id, 'succeeded', "phase '" + input.phase + "' validation passed for '" + artifact.artifact_id + "'");
      if (!consumed.ok) {
        result = fail('SPEC_PHASE_PERSIST_FAILED', consumed.error);
        return { op: 'discard' as const };
      }
      result = { ok: true, replayed: persisted.replayed, value: validation };
      return { op: 'commit' as const, state: { ...consumed.state, specification: nextWorkspace, updated_at: new Date().toISOString() }, value: result };
    }, {
      selector: { feature_id: input.feature_id, run_key: input.run_key },
      pinnedRoot,
      preCommit: () => { preCommitConstitutionGuard?.(); },
    });
    if (!transaction.ok) {
      cleanupAttemptRollback();
      const stalePrefix = "pre-commit guard failed: SPEC_PHASE_STALE:";
      if (transaction.error.startsWith(stalePrefix)) return fail("SPEC_PHASE_STALE", transaction.error.slice(stalePrefix.length));
      return fail('SPEC_PHASE_PERSIST_FAILED', transaction.error);
    }
    transactionCommitted = transaction.committed;
    if (transaction.committed) {
      for (const action of postCommitActions) action();
    }
    return result ?? transaction.value ?? fail('SPEC_PHASE_PERSIST_FAILED', 'phase validation transaction completed without a result');
  } catch (error) {
    if (!transactionCommitted) cleanupAttemptRollback();
    return fail('SPEC_PHASE_PERSIST_FAILED', 'phase validation failed: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    pinnedRoot.close();
  }
}

function checkpointRef(phase: WorkspacePhase, version: number): string {
  return `checkpoint.${phase}.v${version}`;
}

function phaseDecisionPolicy(state: TeamState) {
  const stage = { id: "specify", checkpoint: PHASE_CHECKPOINT };
  return resolveCheckpointPolicy(stage, state) ?? nativeCheckpointPolicy("specification_phase_approval");
}

/** Return the immutable phase immediately after phase, or null at tasks. */
function nextPhase(phase: WorkspacePhase): WorkspacePhase | null {
  const index = PHASES.indexOf(phase);
  return index >= 0 && index + 1 < PHASES.length ? PHASES[index + 1]! : null;
}

/**
 * Find a decision that can be replayed without authorizing a new transition.
 * A replay is bound to the exact actor/proof and (when requested) the active
 * capability epoch; this keeps stale answers from being treated as retries.
 */
interface PhaseDecisionReplayContext {
  state: TeamState;
  workspace: FeatureWorkspace;
  record: WorkspacePhaseRecord | null;
  artifact_digest: string | null;
  validation_digest: string | null;
  validation_postimage_valid: boolean;
  pinned_root: PinnedProjectRoot;
}

function currentPhaseValidationDigest(
  workspace: FeatureWorkspace,
  record: WorkspacePhaseRecord | null,
  pinnedRoot: PinnedProjectRoot,
): string | null {
  if (!record || record.current_version === null
    || record.validation_ref !== `validation.${record.phase}.v${record.current_version}`) return null;
  const validation = readPinnedArtifact<unknown>(pinnedRoot, workspace.feature_id, record.validation_ref);
  if (!isRecord(validation)
    || validation.validation_id !== record.validation_ref
    || validation.phase !== record.phase
    || validation.artifact_version !== `${record.phase}.v${record.current_version}`
    || !isRecord(validation.constitution)
    || !same(validation.constitution.binding, workspace.constitution_binding)) return null;
  return digestOf(validation);
}
function currentPhaseArtifactDigest(
  workspace: FeatureWorkspace,
  record: WorkspacePhaseRecord | null,
  pinnedRoot: PinnedProjectRoot,
  runKey: string,
): string | null {
  if (workspace.source_kind !== "native" || !record || record.current_version === null) return null;
  const artifact = readCanonicalPhaseArtifact(pinnedRoot.canonical_root, {
    feature_id: workspace.feature_id,
    run_key: runKey,
    phase: record.phase,
    version: record.current_version,
  }, pinnedRoot);
  return artifact ? digestOf(artifact) : null;
}

function phaseDecisionMatchesCurrentPostimage(
  phase: WorkspacePhase,
  candidate: TypedCheckpointDecision,
  context: PhaseDecisionReplayContext,
): boolean {
  const { state, workspace, record, artifact_digest, validation_digest, validation_postimage_valid } = context;
  if (!validation_postimage_valid
    || !record || record.current_version === null || !isSha256Hex(validation_digest)
    || (workspace.source_kind === "native" && (!isSha256Hex(artifact_digest) || candidate.artifact_digest !== artifact_digest))
    || candidate.feature_id !== workspace.feature_id
    || candidate.artifact_id !== `${phase}.v${record.current_version}`
    || candidate.artifact_version !== record.current_version
    || candidate.validation_ref !== `validation.${phase}.v${record.current_version}`
    || candidate.validation_digest !== validation_digest) return false;
  if (candidate.decision === "request_changes") {
    return record.status === "revision_required"
      && record.approved_version === null
      && record.checkpoint_ref === null
      && workspace.handoff_ref === null;
  }
  if (record.status !== "approved"
    || record.approved_version !== record.current_version
    || record.checkpoint_ref !== `checkpoint.${phase}.v${record.current_version}`) return false;
  if (candidate.decision === "approve_stop") {
    const phaseStage = state.stages.find((stage) => stage.id === phase);
    return workspace.status === "in_progress"
      && workspace.handoff_ref === null
      && state.stage_cursor === phase
      && phaseStage?.status === "done"
      && state.pause.kind === "done"
      && state.dispatch_capability?.status === "complete";
  }
  if (phase === "tasks" && workspace.source_kind === "native") {
    if (workspace.status !== "implementation_ready" || typeof workspace.handoff_ref !== "string" || workspace.handoff_ref.length === 0) return false;
    const handoff = readPinnedArtifact<ImplementationHandoff>(context.pinned_root, workspace.feature_id, workspace.handoff_ref);
    if (!handoff || handoff.feature_id !== workspace.feature_id || handoff.handoff_id !== workspace.handoff_ref
      || !validateImplementationHandoff(handoff).ok || canonicalHandoffDigest(handoff) !== handoff.handoff_digest) return false;
    const artifactIds = new Set(handoff.artifact_versions.map((artifact) => artifact.artifact_id));
    if (["specify", "plan", "tasks"].some((name) => {
      const version = context.workspace.phases.find((item) => item.phase === name)?.approved_version;
      return version === null || version === undefined || !artifactIds.has(`${name}.v${version}`);
    })) return false;
  } else if (workspace.handoff_ref !== null) {
    return false;
  }
  return true;
}

function priorDecision(
  state: TeamState,
  phase: WorkspacePhase,
  input: PhaseCheckpointDecisionInput,
  options: { context: PhaseDecisionReplayContext; bindCurrentEpoch?: boolean },
): TypedCheckpointDecision | undefined {
  if (input.authorization !== "human" || input.actor_provenance.kind !== "user") return undefined;
  const runId = state.work_identity?.run_id ?? state.run_key ?? state.branch;
  const capability = state.dispatch_capability;
  const currentEpoch = capability?.issued_for?.cursor_epoch;
  const currentCapabilityId = capability?.capability_id;
  const requestedFeedback = input.decision === "request_changes" ? input.feedback ?? null : null;

  return [...(state.typed_checkpoint_decisions ?? [])].reverse().find((candidate) => {
    if (candidate.run_id !== runId
      || candidate.stage_id !== phase
      || candidate.checkpoint_id !== PHASE_CHECKPOINT
      || candidate.decision !== input.decision
      || candidate.authorization !== "human"
      || !same(candidate.actor, input.actor_provenance)
      || !phaseDecisionMatchesCurrentPostimage(phase, candidate, options.context)) {
      return false;
    }
    if (input.decision === "request_changes" && candidate.rationale !== requestedFeedback) return false;
    if (options.bindCurrentEpoch
      && (!capability || !currentEpoch || !currentCapabilityId
        || candidate.capability_epoch !== currentEpoch
        || candidate.capability_id !== currentCapabilityId)) {
      return false;
    }
    return true;
  });
}

/** Keep phase decisions on the canonical, policy-validating ledger path. */
function appendPhaseDecision(state: TeamState, decision: TypedCheckpointDecision): TeamState {
  return appendCheckpointDecision(state, decision);
}

const NATIVE_TASK_INTENT = "Dispatching specification phase worker";
const NATIVE_TASK_CONTEXT = "Engine-authorized native specification phase assignment.";
const NATIVE_WORKER_PROMPT_PREFIX = "Complete assignment thoroughly:\n\n";
const NATIVE_WORKER_REF_INSTRUCTION = "The engine will inject the authoritative NATIVE_WORKER_INPUT in the child system prompt. Treat it as complete context. Author all prose and document body content in the selected language from NATIVE_WORKER_INPUT.language; preserve the selected template literal headings, markers, and placeholders exactly, even when they are in another language. Do not call any tool, read any source, delegate, or emit commentary; return exactly one strict structured worker_result object via yield. Copy engine_binding.input_ref and engine_binding.input_digest exactly into worker_result.input_ref and worker_result.input_digest. Yield once.";
const NATIVE_WORKER_REFERENCE_PREFIX = "spec-native:";
const MAX_NATIVE_WORKER_PROMPT_BYTES = 256 * 1024;
const NATIVE_WORKER_REF_RE = /^NATIVE_WORKER_INPUT_REF schema=1 ref=([A-Za-z0-9._:-]{1,512}) digest=([a-f0-9]{64})$/;

type NativeWorkerPromptData = {
  engine_binding: {
    feature_id: string;
    run_key: string;
    phase: WorkspacePhase;
    version: number;
    request_id: string;
    dispatch_id: string;
    worker_name: string;
    dispatch_marker: string;
    capability_id: string;
    capability_epoch: string;
    role: string;
    slot_id: string;
    task_id: string;
    worker_id: string;
    work_identity: WorkIdentity;
    output_schema: Record<string, unknown>;
    input_ref: string;
    input_digest: string;
    constitution_binding: ConstitutionBinding;
    upstream_versions: PhaseUpstreamVersionBinding[];
    template_hash: string;
    language_hash: string;
  };
  language: FeatureWorkspace["language"];
  constitution: {
    binding: ConstitutionBinding;
    path: string;
    content_sha256: string;
    document_text: string;
    principles: Array<Pick<ConstitutionPrincipleIdentity, "principle_id" | "title">>;
  };
  requester_context: string;
  upstream_artifact_refs: NonNullable<NativeWorkerAuthoritativeInput>["upstream_artifact_refs"];
  phase_template: NativePhaseTemplate;
};

function nativeWorkerReference(dispatch: Pick<SpecificationPhaseDispatch, "feature_id" | "run_key" | "phase" | "dispatch_id">): string {
  return NATIVE_WORKER_REFERENCE_PREFIX + [dispatch.feature_id, dispatch.run_key, dispatch.phase, dispatch.dispatch_id].join(":");
}

function nativeWorkerPromptData(dispatch: SpecificationPhaseDispatch, requesterContext: string): NativeWorkerPromptData {
  if (!dispatch.authoritative_input) throw new Error("native worker authoritative input is unavailable");
  return {
    engine_binding: {
      feature_id: dispatch.feature_id,
      run_key: dispatch.run_key,
      phase: dispatch.phase,
      version: dispatch.version,
      request_id: dispatch.request_id,
      dispatch_id: dispatch.dispatch_id,
      worker_name: dispatch.worker_name,
      dispatch_marker: dispatch.dispatch_marker,
      capability_id: dispatch.work_identity.capability_id,
      capability_epoch: dispatch.capability_epoch,
      role: parseDispatchMarker(dispatch.dispatch_marker)?.role ?? dispatch.work_identity.slot_id,
      slot_id: dispatch.work_identity.slot_id,
      task_id: dispatch.work_identity.task_id,
      worker_id: dispatch.work_identity.worker_id,
      input_ref: dispatch.input_ref,
      input_digest: dispatch.input_digest,
      work_identity: dispatch.work_identity,
      output_schema: dispatch.output_schema,
      constitution_binding: dispatch.constitution_binding,
      upstream_versions: dispatch.upstream_versions,
      template_hash: dispatch.template_hash,
      language_hash: dispatch.language_hash,
    },
    language: { ...dispatch.authoritative_input.language },
    constitution: {
      ...dispatch.authoritative_input.constitution,
      principles: (dispatch.constitution_principles ?? []).map(({ principle_id, title }) => ({ principle_id, title })),
    },
    requester_context: requesterContext,
    upstream_artifact_refs: dispatch.authoritative_input.upstream_artifact_refs,
    phase_template: dispatch.phase_template,
  };
}

function nativeWorkerPromptText(dispatch: SpecificationPhaseDispatch, requesterContext: string): string {
  return "NATIVE_WORKER_INPUT " + canonicalJson(nativeWorkerPromptData(dispatch, requesterContext));
}

function nativeWorkerPromptDigest(dispatch: SpecificationPhaseDispatch, requesterContext: string): string {
  return sha256Hex(nativeWorkerPromptText(dispatch, requesterContext));
}

function nativePreparationRequestId(phase: WorkspacePhase, featureId: string, handoff: WorkflowPreparationHandoff): string {
  return "native-" + phase + "-" + featureId + "-" + handoff.digest.slice(0, 16);
}

function nativePreparationTaskId(capabilityId: string, handoff: WorkflowPreparationHandoff, phase: WorkspacePhase, role: string): string {
  return dispatchTaskId(capabilityId, handoff.run_key, handoff.branch, handoff.classification.workflow, phase, role);
}
function nativePreparationSource(
  state: TeamState,
  handoff: WorkflowPreparationHandoff,
  phase: WorkspacePhase,
  requestId: string,
  expectedRoster?: NativePreparationSource["expected_roster"],
  policyHash?: string,
): NativePreparationSource {
  return {
    feature_id: handoff.feature_id,
    run_key: handoff.run_key,
    phase,
    preparation_handoff_digest: handoff.digest,
    preparation_state_revision: handoff.state_revision,
    request_id: requestId,
    profile_hash: state.profile_hash ?? "",
    ...(policyHash === undefined ? {} : { policy_hash: policyHash }),
    ...(expectedRoster === undefined ? {} : { expected_roster: expectedRoster }),
  };
}
function nativeCompositeInputError(input: { feature_id?: unknown; run_key?: unknown }): string | null {
  if (typeof input.feature_id !== "string" || !isSafeFeatureId(input.feature_id)) return "an explicit safe feature_id is required";
  if (typeof input.run_key !== "string" || input.run_key.trim().length === 0 || input.run_key.length > MAX_PHASE_INPUT_BYTES) return "an explicit bounded run_key is required";
  return null;
}

function nativePreparationAuthorityError(projectRoot: string, state: TeamState, input: NativeSpecificationPhaseStartInput): string | null {
  const handoff = input.preparation_handoff;
  if (!isRecord(handoff.root_identity)) return "preparation_handoff root identity is missing";
  if (!verifyPreparationHandoffDigest(handoff)) return "preparation_handoff digest is invalid";
  if (handoff.feature_id !== input.feature_id || handoff.run_key !== input.run_key) return "preparation_handoff feature/run selector does not match the requested native phase";
  if (handoff.feature_id !== state.specification?.feature_id || handoff.run_key !== state.run_key) return "native phase selector does not match the persisted workspace identity";
  if (handoff.branch !== state.branch || handoff.task !== state.task) return "preparation_handoff branch or task does not match the prepared postimage";
  if (digestOf(handoff.classification) !== digestOf(state.classification)) return "preparation_handoff classification does not match the prepared postimage";
  const rawStateRevision = state.state_revision;
  if (!Number.isSafeInteger(rawStateRevision) || (rawStateRevision as number) < 0) return "prepared workflow state revision is invalid";
  const stateRevision = rawStateRevision as number;
  if (!state.preparation_handoff || canonicalJson(state.preparation_handoff) !== canonicalJson(handoff)) return "preparation_handoff is not the exact persisted authority for this workspace";
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return "project root cannot be pinned for preparation_handoff verification";
  try {
    if (handoff.root_identity.canonical_path !== pinnedRoot.canonical_root
      || handoff.root_identity.dev !== pinnedRoot.dev
      || handoff.root_identity.ino !== pinnedRoot.ino) return "preparation_handoff root identity does not match the current project root";
    if (!verifyPreparationHandoffAuth(pinnedRoot, handoff)) return "preparation_handoff authentication proof is invalid";
    const boundWorkspace = state.specification;
    if (!boundWorkspace || handoff.source_kind !== boundWorkspace.source_kind
      || handoff.capacity !== 1
      || canonicalJson(handoff.constitution_binding) !== canonicalJson(boundWorkspace.constitution_binding)
      || handoff.constitution_gate_ref !== boundWorkspace.constitution_gate_ref) return "preparation_handoff authenticated workspace binding is stale";
    const marker = state.preparation_start;
    const active = state.dispatch_capability;
    const phase = state.stage_cursor as WorkspacePhase;
    const expectedRequestId = nativePreparationRequestId(phase, input.feature_id, handoff);
    if (marker) {
      if (marker.token !== handoff.token || marker.preparation_digest !== handoff.digest || marker.phase !== phase) return "native start postimage marker is not bound to this preparation authority";
      if (marker.status === "begun") {
        const markerBindingValid = !!active
          && marker.capability_id === active.capability_id
          && marker.capability_epoch === active.issued_for?.cursor_epoch
          && marker.request_id === expectedRequestId
          && marker.preparation_state_revision === handoff.state_revision
          && marker.profile_hash === state.profile_hash
          && (marker.policy_hash === undefined || marker.policy_hash === active.policy_hash)
          && canonicalJson(marker.expected_roster) === canonicalJson(active.expected_roster)
          && Number.isSafeInteger(marker.expected_state_revision)
          && (marker.expected_state_revision as number) <= stateRevision;
        if (!markerBindingValid) return "native preparation begin postimage marker does not match the current capability";
        if (active.status === "ready" && (active.dispatches?.length ?? 0) === 0
          && preparationStartPostimageDigest(state) === marker.start_postimage_digest) return null;
        const expectedRosterEntry = marker.expected_roster?.[0];
        const currentDispatch = active.dispatches?.find((candidate) => candidate.tool_call_id === marker.request_id);
        const expectedTaskId = expectedRosterEntry ? nativePreparationTaskId(marker.capability_id, handoff, phase, expectedRosterEntry.role) : null;
        if (active.status === "dispatched" && stateRevision >= (marker.expected_state_revision as number)
          && currentDispatch?.work_identity?.capability_id === marker.capability_id
          && currentDispatch.work_identity.capability_epoch === marker.capability_epoch
          && currentDispatch.work_identity.task_id === expectedTaskId
          && currentDispatch.role === expectedRosterEntry?.role
          && currentDispatch.agent === expectedRosterEntry?.agent) return null;
        return "native preparation begin postimage marker does not match the current capability";
      }
      if (marker.status !== "started") return "native start postimage marker is not bound to this preparation authority";
      const currentDispatch = active?.dispatches?.find((candidate) => candidate.id === marker.dispatch_id);
      if (!active || active.capability_id !== marker.capability_id || active.status === "complete" || active.status === "invalidated" || !currentDispatch || currentDispatch.tool_call_id !== marker.request_id || marker.request_id !== expectedRequestId) return "native start postimage marker does not match the current capability and dispatch";
      if (preparationStartPostimageDigest(state) !== marker.start_postimage_digest) return "native start postimage no longer matches the persisted capability and dispatch";
      return null;
    }
    if (active) {
      const preparedPostimage = stateRevision === handoff.state_revision
        && handoff.state_digest === preparationStateDigest(state, stateRevision)
        && active.status === "ready"
        && active.issued_for?.run_key === handoff.run_key
        && active.issued_for?.branch === handoff.branch
        && active.issued_for?.workflow === handoff.classification.workflow
        && active.issued_for?.stage_cursor === phase
        && (active.dispatches?.length ?? 0) === 0;
      if (preparedPostimage) return null;
      const roster = active.expected_roster?.[0];
      const currentDispatch = active.dispatches?.find((candidate) => candidate.tool_call_id === expectedRequestId);
      const expectedTaskId = active.capability_id && roster ? nativePreparationTaskId(active.capability_id, handoff, phase, roster.role) : null;
      const recoverable = stateRevision > handoff.state_revision
        && active.status === "dispatched"
        && active.capability_id
        && active.issued_for?.run_key === handoff.run_key
        && active.issued_for?.branch === handoff.branch
        && active.issued_for?.workflow === handoff.classification.workflow
        && active.issued_for?.stage_cursor === phase
        && currentDispatch?.work_identity?.task_id === expectedTaskId;
      if (!recoverable) return "preparation_handoff is stale: an arbitrary or pre-existing capability cannot authorize native start";
      return null;
    }
    if (stateRevision !== handoff.state_revision || handoff.state_digest !== preparationStateDigest(state, stateRevision)) return "preparation_handoff is stale: prepared state revision or postimage changed";
    return null;
  } finally {
    pinnedRoot.close();
  }
}
function rollbackNativeStartBegin(
  projectRoot: string,
  beforeState: TeamState,
  begunCapabilityId: string,
  expectedDispatchId?: string,
  phase?: WorkspacePhase,
): { ok: true } | { ok: false; error: string } {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return { ok: false, error: "project root cannot be pinned while rolling back native start" };
  try {
    const rolledBack = updateStateAtomically(projectRoot, (snapshot) => {
      const current = snapshot.state;
      const capability = current?.dispatch_capability;
      const beforeWorkspace = beforeState.specification;
      const currentWorkspace = current?.specification;
      const expectedWorkspace = expectedDispatchId && phase ? withGeneratingPhase(beforeWorkspace ?? ({} as FeatureWorkspace), phase) : beforeWorkspace;
      const dispatchesMatch = expectedDispatchId
        ? (capability?.dispatches?.length ?? 0) === 1 && capability?.dispatches?.[0]?.id === expectedDispatchId
        : (capability?.dispatches?.length ?? 0) === 0;
      const marker = current?.preparation_start;
      const markerMatchesBegin = marker === undefined
        || (marker.status === "begun"
          && marker.capability_id === begunCapabilityId
          && marker.token === beforeState.preparation_handoff?.token
          && marker.preparation_digest === beforeState.preparation_handoff?.digest
          && (phase === undefined || marker.phase === phase));
      if (!current || !capability || capability.capability_id !== begunCapabilityId
        || !dispatchesMatch
        || !markerMatchesBegin
        || !beforeWorkspace || !currentWorkspace
        || !expectedWorkspace
        || digestOf(currentWorkspace) !== digestOf(expectedWorkspace)
        || current.stage_cursor !== beforeState.stage_cursor
        || current.run_key !== beforeState.run_key
        || canonicalJson(current.preparation_handoff) !== canonicalJson(beforeState.preparation_handoff)) {
        return { op: "fail" as const, code: "state_conflict", error: "native start rollback identity no longer matches the just-issued capability" };
      }
      return { op: "commit" as const, state: { ...beforeState, updated_at: new Date().toISOString() } };
    }, { selector: { feature_id: beforeState.specification?.feature_id ?? "", run_key: beforeState.run_key ?? "" }, branch: beforeState.branch, branchNeutral: true, pinnedRoot });
    if (!rolledBack.ok) return { ok: false, error: rolledBack.error };
    return { ok: true };
  } finally {
    pinnedRoot.close();
  }
}

function rollbackNativeStartReplay(
  projectRoot: string,
  beforeState: TeamState,
  capabilityId: string,
  dispatchId: string,
): { ok: true } | { ok: false; error: string } {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return { ok: false, error: "project root cannot be pinned while rolling back native start replay" };
  try {
    const rolledBack = updateStateAtomically(projectRoot, (snapshot) => {
      const current = snapshot.state;
      const capability = current?.dispatch_capability;
      const beforeWorkspace = beforeState.specification;
      const currentWorkspace = current?.specification;
      const beforeDispatch = capability?.dispatches?.find((candidate) => candidate.id === dispatchId);
      const currentDispatch = current?.dispatch_capability?.dispatches?.find((candidate) => candidate.id === dispatchId);
      if (!current || !capability || capability.capability_id !== capabilityId || !beforeWorkspace || !currentWorkspace
        || digestOf(currentWorkspace) !== digestOf(beforeWorkspace)
        || !beforeDispatch || !currentDispatch || canonicalJson(currentDispatch) !== canonicalJson(beforeDispatch)
        || canonicalJson(current.preparation_start) !== canonicalJson(beforeState.preparation_start)) {
        return { op: "fail" as const, code: "state_conflict", error: "native start replay rollback identity no longer matches the existing postimage" };
      }
      return { op: "commit" as const, state: { ...beforeState, updated_at: new Date().toISOString() } };
    }, { selector: { feature_id: beforeState.specification?.feature_id ?? "", run_key: beforeState.run_key ?? "" }, branch: beforeState.branch, branchNeutral: true, pinnedRoot });
    if (!rolledBack.ok) return { ok: false, error: rolledBack.error };
    return { ok: true };
  } finally {
    pinnedRoot.close();
  }
}

function repairNativeBeginDispatchPostimage(
  projectRoot: string,
  state: TeamState,
  marker: NativePreparationStartMarker,
  recordId: string,
  options?: NativeSpecificationPhaseStartOptions,
): PhaseLifecycleResult<NativeSpecificationPhaseStart> {
  const workspace = state.specification;
  const handoff = state.preparation_handoff;
  const capability = state.dispatch_capability;
  if (!workspace || !workspace.constitution_binding || !handoff || !capability || !state.branch || !state.classification?.workflow || !capability.issued_for || !Array.isArray(capability.dispatches)) return fail("SPEC_PHASE_RECOVERY_REQUIRED", "native preparation dispatch postimage is unavailable for marker repair");
  const nativeStartProof = issueCurrentTrustedMappingProof(projectRoot);
  const trustedMappingProof = nativeStartProof;
  const source = nativePreparationSource(state, handoff, marker.phase, marker.request_id, marker.expected_roster, marker.policy_hash);
  const reissued = beginCapability(projectRoot, undefined, {
    feature_id: workspace.feature_id,
    run_key: state.run_key!,
    ...(trustedMappingProof === undefined ? {} : { trustedMappingProof }),
    consumeTrustedMappingProof: false,
    native_preparation_source: source,
  });
  if (!reissued.ok || !reissued.handoff) return fail("SPEC_PHASE_RECOVERY_REQUIRED", reissued.ok ? "native preparation dispatch bearer is unavailable" : reissued.error);
  if (reissued.handoff.capability_id !== marker.capability_id || reissued.handoff.stage_cursor !== marker.phase) return fail("SPEC_PHASE_RECOVERY_REQUIRED", "native preparation dispatch bearer binding changed");
  const selected = resolveState(projectRoot, resolveActiveBranch(projectRoot), { feature_id: workspace.feature_id, run_key: state.run_key! });
  const currentState = selected.state;
  const currentCapability = currentState?.dispatch_capability;
  const currentRecord = currentCapability?.dispatches?.find((candidate) => candidate.id === recordId);
  if (selected.invalid || !currentState?.specification || !currentCapability || !currentRecord) return fail("SPEC_PHASE_RECOVERY_REQUIRED", "native preparation dispatch postimage changed before marker repair");
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return fail("SPEC_PHASE_PERSIST_FAILED", "project root cannot be pinned while repairing native preparation marker");
  let reconstructed: SpecificationPhaseDispatch | undefined;
  try {
    const value = nativeWorkerDispatchFromState(projectRoot, currentState, currentState.specification, marker.phase, currentRecord, pinnedRoot);
    if (!value.ok) return fail("SPEC_PHASE_RECOVERY_REQUIRED", "native preparation dispatch input cannot be reconstructed for marker repair");
    reconstructed = value.dispatch;
  } finally {
    pinnedRoot.close();
  }
  const startedMarker: NativePreparationStartMarker = { ...marker, status: "started", dispatch_id: currentRecord.id, start_postimage_digest: "" };
  const marked = updateStateAtomically(projectRoot, (snapshot) => {
    const current = snapshot.state;
    const liveCapability = current?.dispatch_capability;
    const liveRecord = liveCapability?.dispatches?.find((candidate) => candidate.id === currentRecord.id);
    if (!current || !liveCapability || liveCapability.capability_id !== marker.capability_id || !liveRecord || liveRecord.tool_call_id !== marker.request_id || canonicalJson(current.preparation_start) !== canonicalJson(marker)) return { op: "fail" as const, code: "state_conflict", error: "native preparation marker repair postimage changed" };
    return { op: "commit" as const, state: { ...current, preparation_start: { ...startedMarker, start_postimage_digest: preparationStartPostimageDigest(current) } } };
  }, { selector: { feature_id: workspace.feature_id, run_key: state.run_key! }, branch: state.branch, branchNeutral: true });
  if (!marked.ok) return fail("SPEC_PHASE_RECOVERY_REQUIRED", marked.error);
  const dispatch = reconstructed;
  const { authoritative_input: _authoritativeInput, ...handoffDispatch } = dispatch;
  const generationHandoff: NativeSpecificationGenerationHandoff = { ...handoffDispatch, workflow: reissued.handoff.workflow, cursor_epoch: dispatch.capability_epoch, token: reissued.handoff.dispatch_token, capability_id: reissued.handoff.capability_id, advance_token: reissued.handoff.advance_token, branch: reissued.handoff.branch, profile_hash: reissued.handoff.profile_hash, role: dispatch.work_identity.slot_id, slot_id: dispatch.work_identity.slot_id, agent: dispatch.work_identity.worker_id };
  const taskEnvelope = nativeWorkerTaskEnvelope(dispatch, dispatch.requester_context ?? state.task, marker.cto_slice_marker);
  return { ok: true, replayed: true, value: { handoff: generationHandoff, required_next_tool: taskEnvelope, next_action: `Execute required_next_tool.arguments exactly once. Wait with hub {op:"wait",ids:["<exact-child-id>"]} on the original child task until terminal, bounded by the remaining native stage SLA; use ids with one or more exact pending child IDs (or from for one exact child), never a bare wait when multiple native contexts are active. Then read agent://<exact-child-id> exactly once and call workflow_finalize_native_specification_phase with {feature_id: <exact feature_id from this start result>, run_key: <exact run_key from this start result>, worker_result: <that bare direct agent object>}. Do not copy a handoff or any token/phase/version fields; never issue a second task or poll the child URI while pending.` } };
}
function replayNativeBeginPostimage(
  projectRoot: string,
  state: TeamState,
  marker: NativePreparationStartMarker,
  selection?: RosterBeginSelection,
  options?: NativeSpecificationPhaseStartOptions,
): PhaseLifecycleResult<NativeSpecificationPhaseStart> {
  if (marker.status !== "begun") return fail("SPEC_PHASE_STALE", "native preparation begin marker is not retryable");
  const phase = marker.phase as WorkspacePhase;
  const workspace = state.specification;
  const capability = state.dispatch_capability;
  const handoff = state.preparation_handoff;
  const expectedRoster = marker.expected_roster;
  const profileHash = marker.profile_hash;
  if (!workspace || !workspace.constitution_binding || !capability || !handoff || !state.branch || !state.classification?.workflow || !Array.isArray(capability.dispatches) || !Array.isArray(capability.expected_roster) || !expectedRoster || !profileHash || !capability.issued_for || capability.capability_id !== marker.capability_id) return fail("SPEC_PHASE_STALE", "native preparation begin postimage is no longer current");
  const roster = capability.expected_roster.find((candidate) => candidate.role === expectedRoster[0]?.role) ?? capability.expected_roster[0];
  if (!roster || roster.agent !== expectedRoster.find((candidate) => candidate.role === roster.role)?.agent) return fail("SPEC_PHASE_STALE", "native preparation begin roster is no longer current");
  if (capability.status === "dispatched") {
    const existingDispatch = capability.dispatches.find((candidate) => candidate.tool_call_id === marker.request_id);
    const expectedTaskId = nativePreparationTaskId(marker.capability_id, handoff, phase, roster.role);
    if (!existingDispatch || existingDispatch.work_identity?.capability_id !== marker.capability_id || existingDispatch.work_identity.capability_epoch !== marker.capability_epoch || existingDispatch.work_identity.task_id !== expectedTaskId || existingDispatch.role !== roster.role || existingDispatch.agent !== roster.agent) return fail("SPEC_PHASE_RECOVERY_REQUIRED", "native preparation begin dispatch postimage does not match its authority");
    return repairNativeBeginDispatchPostimage(projectRoot, state, marker, existingDispatch.id, options);
  }
  if (capability.status !== "ready" || capability.dispatches.length !== 0) return fail("SPEC_PHASE_STALE", "native preparation begin postimage is no longer current");
  const nativeStartProof = issueCurrentTrustedMappingProof(projectRoot);
  const trustedMappingProof = options?.trustedMappingProof ?? nativeStartProof;
  const source = nativePreparationSource(state, handoff, phase, marker.request_id, expectedRoster, marker.policy_hash);
  const reissued = reissueNativePreparationBegin(projectRoot, {
    feature_id: workspace.feature_id,
    run_key: state.run_key!,
    branch: state.branch,
    workflow: state.classification.workflow,
    profile_hash: profileHash,
    phase,
    preparation_handoff_digest: source.preparation_handoff_digest,
    preparation_state_revision: source.preparation_state_revision,
    request_id: source.request_id,
    capability_id: marker.capability_id,
    cursor_epoch: capability.issued_for.cursor_epoch,
  });
  if (!reissued.ok || !reissued.handoff) return fail("SPEC_PHASE_FORBIDDEN", reissued.ok ? "native preparation begin bearer is unavailable" : reissued.error);
  injectPhaseFailure("after_capability_begin");
  if (reissued.handoff.capability_id !== marker.capability_id || reissued.handoff.cursor_epoch !== capability.issued_for.cursor_epoch || reissued.handoff.stage_cursor !== phase) return fail("SPEC_PHASE_STALE", "native preparation begin reissue changed its binding");
  const dispatched = dispatchSpecificationPhase(projectRoot, {
    token: reissued.handoff.dispatch_token,
    capability_id: reissued.handoff.capability_id,
    feature_id: workspace.feature_id,
    run_key: state.run_key!,
    branch: reissued.handoff.branch,
    workflow: reissued.handoff.workflow,
    profile_hash: reissued.handoff.profile_hash,
    phase,
    cursor_epoch: reissued.handoff.cursor_epoch,
    request_id: marker.request_id,
    role: roster.role,
    slot_id: roster.role,
    agent: roster.agent,
    task_id: nativePreparationTaskId(marker.capability_id, handoff, phase, roster.role),
  }, trustedMappingProof === undefined ? {} : { trustedMappingProof });
  if (!dispatched.ok) return dispatched;
  const dispatch = dispatched.value;
  injectPhaseFailure("after_start_dispatch");
  if (dispatch.request_id !== marker.request_id || dispatch.work_identity.capability_id !== marker.capability_id) return fail("SPEC_PHASE_STALE", "native preparation begin retry produced an unexpected dispatch postimage");
  const startedMarker: NativePreparationStartMarker = {
    ...marker,
    status: "started",
    dispatch_id: dispatch.dispatch_id,
    start_postimage_digest: "",
  };
  const marked = updateStateAtomically(projectRoot, (snapshot) => {
    const current = snapshot.state;
    const currentCapability = current?.dispatch_capability;
    const currentDispatch = currentCapability?.dispatches?.find((candidate) => candidate.id === dispatch.dispatch_id);
    if (!current || !currentCapability || currentCapability.capability_id !== marker.capability_id || !currentDispatch || currentDispatch.tool_call_id !== marker.request_id || canonicalJson(current.preparation_start) !== canonicalJson(marker)) return { op: "fail" as const, code: "state_conflict", error: "native preparation begin retry postimage changed before marker receipt" };
    const receipt = { ...startedMarker, start_postimage_digest: preparationStartPostimageDigest(current) };
    return { op: "commit" as const, state: { ...current, preparation_start: receipt } };
  }, { selector: { feature_id: workspace.feature_id, run_key: state.run_key! }, branch: state.branch, branchNeutral: true });
  if (!marked.ok) return fail("SPEC_PHASE_RECOVERY_REQUIRED", marked.error);
  const { authoritative_input: _authoritativeInput, ...handoffDispatch } = dispatch;
  const generationHandoff: NativeSpecificationGenerationHandoff = {
    ...handoffDispatch,
    workflow: reissued.handoff.workflow,
    cursor_epoch: dispatch.capability_epoch,
    token: reissued.handoff.dispatch_token,
    capability_id: reissued.handoff.capability_id,
    advance_token: reissued.handoff.advance_token,
    branch: reissued.handoff.branch,
    profile_hash: reissued.handoff.profile_hash,
    role: dispatch.work_identity.slot_id,
    slot_id: dispatch.work_identity.slot_id,
    agent: dispatch.work_identity.worker_id,
  };
  const taskEnvelope = nativeWorkerTaskEnvelope(dispatch, dispatch.requester_context ?? state.task, marker.cto_slice_marker);
  return { ok: true, replayed: true, value: { handoff: generationHandoff, required_next_tool: taskEnvelope, next_action: `Execute required_next_tool.arguments exactly once. Wait with hub {op:"wait",ids:["<exact-child-id>"]} on the original child task until terminal, bounded by the remaining native stage SLA; use ids with one or more exact pending child IDs (or from for one exact child), never a bare wait when multiple native contexts are active. Then read agent://<exact-child-id> exactly once and call workflow_finalize_native_specification_phase with {feature_id: <exact feature_id from this start result>, run_key: <exact run_key from this start result>, worker_result: <that bare direct agent object>}. Do not copy a handoff or any token/phase/version fields; never issue a second task or poll the child URI while pending.` } };
}
function replayNativeStartPostimage(
  projectRoot: string,
  state: TeamState,
  marker: NativePreparationStartMarker,
  selection?: RosterBeginSelection,
  options?: NativeSpecificationPhaseStartOptions,
): PhaseLifecycleResult<NativeSpecificationPhaseStart> {
  const phase = marker.phase as WorkspacePhase;
  const capability = state.dispatch_capability;
  const record = capability?.dispatches?.find((candidate) => candidate.id === marker.dispatch_id);
  const workspace = state.specification;
  const phaseRecordValue = workspace?.phases.find((candidate) => candidate.phase === phase);
  if (!capability || !record?.work_identity || !workspace?.constitution_binding || !state.preparation_handoff || phaseRecordValue?.status !== "generating") return fail("SPEC_PHASE_STALE", "native start postimage is missing its current capability, dispatch, workspace binding, preparation handoff, or generating phase");
  const roster = capability.expected_roster?.find((candidate) => candidate.role === record.role);
  if (!roster || roster.agent !== record.agent) return fail("SPEC_PHASE_STALE", "native start postimage dispatch roster is no longer current");
  const liveConstitution = currentConstitutionGuard(projectRoot, workspace.constitution_binding);
  if (!liveConstitution.ok) return fail("SPEC_PHASE_STALE", liveConstitution.error);

  const nativeStartProof = issueCurrentTrustedMappingProof(projectRoot);
  const trustedMappingProof = options?.trustedMappingProof ?? nativeStartProof;
  const source = nativePreparationSource(state, state.preparation_handoff!, phase, marker.request_id, marker.expected_roster, marker.policy_hash);
  const begun = beginCapability(projectRoot, selection, {
    feature_id: workspace.feature_id,
    run_key: state.run_key!,
    ...(trustedMappingProof === undefined ? {} : { trustedMappingProof }),
    consumeTrustedMappingProof: false,
    native_preparation_source: source,
  });
  if (!begun.ok || !begun.handoff) return fail("SPEC_PHASE_FORBIDDEN", begun.ok ? "native phase capability handoff is unavailable" : begun.error);
  injectPhaseFailure("after_capability_begin");
  if (begun.handoff.capability_id !== marker.capability_id
    || begun.handoff.run_key !== state.run_key
    || begun.handoff.branch !== state.branch
    || begun.handoff.workflow !== state.classification.workflow
    || begun.handoff.stage_cursor !== phase
    || begun.handoff.cursor_epoch !== record.work_identity.capability_epoch) {
    return fail("SPEC_PHASE_STALE", "native start replay reissued a capability with a mismatched binding");
  }
  const reissuedRoster = begun.handoff.expected_roster.find((candidate) => candidate.role === record.role);
  if (!reissuedRoster || reissuedRoster.agent !== record.agent) return fail("SPEC_PHASE_STALE", "native start replay reissued a mismatched dispatch roster");

  const dispatched = dispatchSpecificationPhase(projectRoot, {
    token: begun.handoff.dispatch_token,
    capability_id: begun.handoff.capability_id,
    feature_id: workspace.feature_id,
    run_key: state.run_key!,
    branch: begun.handoff.branch,
    workflow: begun.handoff.workflow,
    profile_hash: begun.handoff.profile_hash,
    phase,
    cursor_epoch: begun.handoff.cursor_epoch,
    request_id: marker.request_id,
    role: record.role,
    slot_id: record.role,
    agent: reissuedRoster.agent,
    task_id: record.work_identity.task_id,
  }, trustedMappingProof === undefined ? {} : { trustedMappingProof });
  if (!dispatched.ok) {
    const rollback = rollbackNativeStartReplay(projectRoot, state, marker.capability_id, marker.dispatch_id ?? "");
    if (!rollback.ok) return fail("SPEC_PHASE_PERSIST_FAILED", "native start replay dispatch failed and rollback was not safe: " + rollback.error);
    return dispatched;
  }
  const dispatch = dispatched.value;
  if (!dispatched.replayed || dispatch.dispatch_id !== marker.dispatch_id || dispatch.request_id !== marker.request_id
    || dispatch.work_identity.capability_id !== marker.capability_id
    || dispatch.work_identity.dispatch_id !== marker.dispatch_id
    || dispatch.work_identity.task_id !== record.work_identity.task_id) {
    return fail("SPEC_PHASE_STALE", "native start replay did not return the exact existing dispatch");
  }
  const { authoritative_input: _authoritativeInput, ...handoffDispatch } = dispatch;

  const selected = resolveState(projectRoot, resolveActiveBranch(projectRoot), { feature_id: workspace.feature_id, run_key: state.run_key! });
  if (selected.invalid || !selected.state?.specification) return fail("SPEC_PHASE_STALE", "native start replay state postimage is unavailable");
  const current = selected.state;
  const currentCapability = current.dispatch_capability;
  const currentMarker = current.preparation_start;
  const currentDispatch = currentCapability?.dispatches?.find((candidate) => candidate.id === marker.dispatch_id);
  if (!currentMarker
    || canonicalJson(currentMarker) !== canonicalJson(marker)
    || !currentCapability
    || currentCapability.capability_id !== marker.capability_id
    || !currentDispatch
    || currentDispatch.tool_call_id !== marker.request_id
    || currentDispatch.id !== dispatch.dispatch_id
    || !currentDispatch.work_identity
    || currentDispatch.work_identity.task_id !== dispatch.work_identity.task_id
    || preparationStartPostimageDigest(current) !== marker.start_postimage_digest) {
    return fail("SPEC_PHASE_STALE", "native start replay postimage no longer matches the preparation marker");
  }
  const generationHandoff: NativeSpecificationGenerationHandoff = {
    ...handoffDispatch,
    workflow: begun.handoff.workflow,
    cursor_epoch: dispatch.capability_epoch,
    token: begun.handoff.dispatch_token,
    capability_id: begun.handoff.capability_id,
    advance_token: begun.handoff.advance_token,
    branch: begun.handoff.branch,
    profile_hash: begun.handoff.profile_hash,
    role: dispatch.work_identity.slot_id,
    slot_id: dispatch.work_identity.slot_id,
    agent: dispatch.work_identity.worker_id,
  };
  const taskEnvelope = nativeWorkerTaskEnvelope(dispatch, dispatch.requester_context ?? state.task, marker.cto_slice_marker);
  return { ok: true, replayed: true, value: { handoff: generationHandoff, required_next_tool: taskEnvelope, next_action: "Execute required_next_tool.arguments exactly once. Wait with hub {op:\"wait\",ids:[\"<exact-child-id>\"]} on the original child task until terminal, bounded by the remaining native stage SLA; use ids with one or more exact pending child IDs (or from for one exact child), never a bare wait when multiple native contexts are active. Then read agent://<exact-child-id> exactly once and call workflow_finalize_native_specification_phase with {feature_id: <exact feature_id from this start result>, run_key: <exact run_key from this start result>, worker_result: <that bare direct agent object>}. Do not copy a handoff or any token/phase/version fields; never issue a second task or poll the child URI while pending.", ...(marker.cto_slice_marker === undefined ? {} : { cto_slice_marker: marker.cto_slice_marker }) } };
}

/**
 * Compose the native phase start transition into one durable capability and one
 * exact generic-task envelope. The lower-level begin/dispatch devices remain
 * available for recovery and migration, but the normal native path never asks
 * the coordinator to copy a handoff through several model-facing calls.
 */
export function startNativeSpecificationPhase(
  projectRoot: string,
  input: NativeSpecificationPhaseStartInput,
  options?: NativeSpecificationPhaseStartOptions,
): PhaseLifecycleResult<NativeSpecificationPhaseStart> {
  const inputError = nativeCompositeInputError(input);
  if (inputError) return fail("SPEC_PHASE_REQUEST_INVALID", inputError);
  if (!isRecord(input.preparation_handoff)) return fail("SPEC_PHASE_REQUEST_INVALID", "an opaque preparation_handoff from workflow_prepare is required");
  const selected = resolveState(projectRoot, resolveActiveBranch(projectRoot), { feature_id: input.feature_id, run_key: input.run_key });
  if (selected.invalid || !selected.state) return fail("SPEC_PHASE_FORBIDDEN", "native specification phase start requires the selected workflow state");
  const state = selected.state;
  if (
    state.classification?.workflow !== "spec-preparation"
    || state.specification?.source_kind !== "native"
    || !state.specification.constitution_binding
    || !["specify", "plan", "tasks"].includes(state.stage_cursor)
  ) return fail("SPEC_PHASE_FORBIDDEN", "native specification phase start requires a bound native specification workspace");
  const authorityError = nativePreparationAuthorityError(projectRoot, state, input);
  if (authorityError) {
    const begunCommittedDispatch = state.preparation_start?.status === "begun"
      && state.dispatch_capability?.status === "dispatched"
      && (state.dispatch_capability.dispatches?.filter((candidate) => (candidate.purpose ?? "generation") === "generation").length ?? 0) === 1;
    return fail(begunCommittedDispatch ? "SPEC_PHASE_RECOVERY_REQUIRED" : "SPEC_PHASE_FORBIDDEN", authorityError);
  }
  const phase = state.stage_cursor as WorkspacePhase;
  const liveConstitution = currentConstitutionGuard(projectRoot, state.specification.constitution_binding);
  if (!liveConstitution.ok) return fail("SPEC_PHASE_STALE", liveConstitution.error);
  if (state.preparation_start) return state.preparation_start.status === "begun"
    ? replayNativeBeginPostimage(projectRoot, state, state.preparation_start, input.selection, options)
    : replayNativeStartPostimage(projectRoot, state, state.preparation_start, input.selection, options);
  const nativeStartProof = issueCurrentTrustedMappingProof(projectRoot);
  const trustedMappingProof = options?.trustedMappingProof ?? nativeStartProof;
  const preparationRequestId = nativePreparationRequestId(phase, input.feature_id, input.preparation_handoff);
  const begun = beginCapability(projectRoot, input.selection, {
    feature_id: input.feature_id,
    run_key: input.run_key,
    ...(trustedMappingProof === undefined ? {} : { trustedMappingProof }),
    consumeTrustedMappingProof: false,
    native_preparation_source: nativePreparationSource(state, input.preparation_handoff, phase, preparationRequestId),
  });
  if (!begun.ok || !begun.handoff) return fail("SPEC_PHASE_FORBIDDEN", begun.ok ? "native phase capability handoff is unavailable" : begun.error);
  injectPhaseFailure("after_capability_begin");
  const roster = begun.handoff.expected_roster[0];
  if (!roster) {
    const rollback = rollbackNativeStartBegin(projectRoot, state, begun.handoff.capability_id);
    return rollback.ok
      ? fail("SPEC_PHASE_FORBIDDEN", "native specification phase has no selected worker")
      : fail("SPEC_PHASE_PERSIST_FAILED", "native start capability was issued without a worker and rollback was not safe: " + rollback.error);
  }
  const latestGeneration = begun.state?.dispatch_capability?.dispatches
    ?.filter((candidate) => (candidate.purpose ?? "generation") === "generation")
    .at(-1);
  const retryOf = latestGeneration && (latestGeneration.status === "failed" || latestGeneration.status === "cancelled")
    ? latestGeneration.id
    : undefined;
  const beforeDispatchConstitution = currentConstitutionGuard(projectRoot, state.specification.constitution_binding);
  if (!beforeDispatchConstitution.ok) {
    const rollback = rollbackNativeStartBegin(projectRoot, state, begun.handoff.capability_id);
    if (!rollback.ok) return fail("SPEC_PHASE_PERSIST_FAILED", "native start constitution guard failed and rollback was not safe: " + rollback.error);
    return fail("SPEC_PHASE_STALE", beforeDispatchConstitution.error);
  }
  const dispatched = dispatchSpecificationPhase(projectRoot, {
    token: begun.handoff.dispatch_token,
    capability_id: begun.handoff.capability_id,
    feature_id: input.feature_id,
    run_key: input.run_key,
    branch: begun.handoff.branch,
    workflow: begun.handoff.workflow,
    profile_hash: begun.handoff.profile_hash,
    phase,
    cursor_epoch: begun.handoff.cursor_epoch,
    request_id: nativePreparationRequestId(phase, input.feature_id, input.preparation_handoff),
    role: roster.role,
    slot_id: roster.role,
    agent: roster.agent,
    task_id: dispatchTaskId(begun.handoff.capability_id, input.run_key, begun.handoff.branch, begun.handoff.workflow, phase, roster.role),
    ...(retryOf ? { retry_of: retryOf } : {}),
  }, trustedMappingProof === undefined ? {} : { trustedMappingProof });
  if (!dispatched.ok) {
    const rollback = rollbackNativeStartBegin(projectRoot, state, begun.handoff.capability_id);
    if (!rollback.ok) return fail("SPEC_PHASE_PERSIST_FAILED", "native start dispatch failed and rollback was not safe: " + rollback.error);
    return dispatched;
  }
  const dispatch = dispatched.value;
  injectPhaseFailure("after_start_dispatch");
  const begunState = begun.state;
  const begunCapability = begunState?.dispatch_capability;
  const begunMarker = begunState?.preparation_start;
  if (!begunState || !begunCapability || !begunMarker || begunMarker.status !== "begun"
    || !Number.isSafeInteger(begunState.state_revision) || (begunState.state_revision as number) < 1
    || begunMarker.expected_state_revision !== begunState.state_revision
    || begunMarker.capability_id !== begunCapability.capability_id
    || begunMarker.profile_hash !== begunState.profile_hash
    || canonicalJson(begunMarker.expected_roster) !== canonicalJson(begunCapability.expected_roster)) {
    const rollback = rollbackNativeStartBegin(projectRoot, state, begun.handoff.capability_id, dispatch.dispatch_id, phase);
    return rollback.ok
      ? fail("SPEC_PHASE_STALE", "native start begun postimage is incomplete or mismatched")
      : fail("SPEC_PHASE_PERSIST_FAILED", "native start begun postimage is incomplete and rollback was not safe: " + rollback.error);
  }
  const startMarker: NativePreparationStartMarker = {
    status: "started",
    phase,
    capability_id: dispatch.work_identity.capability_id,
    request_id: dispatch.request_id,
    dispatch_id: dispatch.dispatch_id,
    start_postimage_digest: "",
    preparation_state_revision: begunMarker.preparation_state_revision,
    expected_state_revision: begunMarker.expected_state_revision,
    capability_epoch: begunMarker.capability_epoch,
    profile_hash: begunMarker.profile_hash,
    ...(begunMarker.policy_hash === undefined ? {} : { policy_hash: begunMarker.policy_hash }),
    expected_roster: begunMarker.expected_roster,
    token: input.preparation_handoff.token,
    preparation_digest: input.preparation_handoff.digest,
    ...(options?.ctoSliceMarker === undefined ? {} : { cto_slice_marker: options.ctoSliceMarker }),
  };
  const marked = updateStateAtomically(projectRoot, (snapshot) => {
    if (!snapshot.state) return { op: "fail" as const, code: "state_invalid", error: "native start postimage has no persisted workflow state" };
    const current = snapshot.state;
    const currentDispatch = current.dispatch_capability?.dispatches?.find((candidate) => candidate.id === startMarker.dispatch_id);
    if (!currentDispatch || currentDispatch.tool_call_id !== startMarker.request_id || current.dispatch_capability?.capability_id !== startMarker.capability_id) return { op: "fail" as const, code: "state_conflict", error: "native start postimage capability or dispatch changed before receipt" };
    const existing = current.preparation_start;
    if (existing) {
      if (existing.status === "begun") {
        if (canonicalJson(existing) !== canonicalJson(begunMarker) || current.preparation_start?.capability_id !== startMarker.capability_id || current.preparation_start?.request_id !== startMarker.request_id) return { op: "fail" as const, code: "state_conflict", error: "native begin postimage receipt conflicts with the current capability and dispatch" };
        const receipt = { ...startMarker, start_postimage_digest: preparationStartPostimageDigest(current) };
        return { op: "commit" as const, state: { ...current, preparation_start: receipt } };
      }
      if (canonicalJson(existing) !== canonicalJson({ ...startMarker, start_postimage_digest: existing.start_postimage_digest }) || preparationStartPostimageDigest(current) !== existing.start_postimage_digest) return { op: "fail" as const, code: "state_conflict", error: "native start postimage receipt conflicts with the current capability and dispatch" };
      return { op: "discard" as const };
    }
    const receipt = { ...startMarker, start_postimage_digest: preparationStartPostimageDigest(current) };
    return { op: "commit" as const, state: { ...current, preparation_start: receipt } };
  }, {
    selector: { feature_id: input.feature_id, run_key: input.run_key },
    branch: begun.handoff.branch,
    branchNeutral: true,
    preCommit: () => {
      const current = currentConstitutionGuard(projectRoot, state.specification?.constitution_binding);
      if (!current.ok) throw new Error("SPEC_PHASE_STALE:" + current.error);
    },
  });
  if (!marked.ok) {
    const rollback = rollbackNativeStartBegin(projectRoot, state, begun.handoff.capability_id, dispatch.dispatch_id, phase);
    if (!rollback.ok) return fail("SPEC_PHASE_PERSIST_FAILED", marked.error + "; native start rollback was not safe: " + rollback.error);
    return fail("SPEC_PHASE_PERSIST_FAILED", marked.error);
  }
  const { authoritative_input: _authoritativeInput, ...handoffDispatch } = dispatch;
  const generationHandoff: NativeSpecificationGenerationHandoff = {
    ...handoffDispatch,
    workflow: begun.handoff.workflow,
    cursor_epoch: dispatch.capability_epoch,
    token: begun.handoff.dispatch_token,
    capability_id: begun.handoff.capability_id,
    advance_token: begun.handoff.advance_token,
    branch: begun.handoff.branch,
    profile_hash: begun.handoff.profile_hash,
    role: dispatch.work_identity.slot_id,
    slot_id: dispatch.work_identity.slot_id,
    agent: dispatch.work_identity.worker_id,
  };
  const taskEnvelope = nativeWorkerTaskEnvelope(dispatch, dispatch.requester_context ?? state.task, options?.ctoSliceMarker);
  return {
    ok: true,
    replayed: dispatched.replayed,
    value: {
      handoff: generationHandoff,
      required_next_tool: taskEnvelope,
      ...(options?.ctoSliceMarker === undefined ? {} : { cto_slice_marker: options.ctoSliceMarker }),
      next_action: "Execute required_next_tool.arguments exactly once. Wait with hub {op:\"wait\",ids:[\"<exact-child-id>\"]} on the original child task until terminal, bounded by the remaining native stage SLA; use ids with one or more exact pending child IDs (or from for one exact child), never a bare wait when multiple native contexts are active. Then read agent://<exact-child-id> exactly once and call workflow_finalize_native_specification_phase with {feature_id: <exact feature_id from this start result>, run_key: <exact run_key from this start result>, worker_result: <that bare direct agent object>}. Do not copy a handoff or any token/phase/version fields; never issue a second task or poll the child URI while pending.",
    },
  };
}
function readCurrentNativeGenerationHandoff(
  projectRoot: string,
  input: Pick<NativeSpecificationPhaseFinalizeInput, "feature_id" | "run_key">,
): { ok: true; handoff: NativeSpecificationGenerationHandoff; phase_status: WorkspacePhaseRecord["status"] } | { ok: false; code: PhaseLifecycleCode; error: string } {
  const selected = resolveState(projectRoot, resolveActiveBranch(projectRoot), { feature_id: input.feature_id, run_key: input.run_key });
  if (selected.invalid || !selected.state?.specification) return { ok: false, code: "SPEC_PHASE_FORBIDDEN", error: "native finalization requires the selected workflow state" };
  const workspace = selected.state.specification;
  const phase = workspace.phases.find((candidate) => candidate.phase === selected.state!.stage_cursor);
  if (!phase || !["generating", "materialized", "awaiting_approval"].includes(phase.status)) return { ok: false, code: "SPEC_PHASE_FORBIDDEN", error: "native finalization requires the selected native phase" };
  const dispatches = selected.state.dispatch_capability?.dispatches ?? [];
  const generationDispatches = dispatches.filter((candidate) => (candidate.purpose ?? "generation") === "generation");
  const dispatchId = selected.state.preparation_start?.dispatch_id;
  let record = (dispatchId ? dispatches.find((candidate) => candidate.id === dispatchId) : undefined) ?? generationDispatches.at(-1);
  const capability = selected.state.dispatch_capability;
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return { ok: false, code: "SPEC_PHASE_PERSIST_FAILED", error: "project root cannot be pinned while reading the native generation handoff" };
  try {
    if (!record && (phase.status === "awaiting_approval" || phase.status === "materialized") && phase.current_version !== null) {
      const artifact = readVersion(projectRoot, input.feature_id, `${phase.phase}.v${phase.current_version}`, input.run_key, pinnedRoot);
      const worker = isRecord(artifact?.semantic_model) && isRecord(artifact.semantic_model.worker) ? artifact.semantic_model.worker : undefined;
      if (artifact && isRecord(artifact.work_identity) && worker && typeof(worker.role) === "string" && typeof(worker.agent) === "string") {
        record = { id: artifact.dispatch_id, role: worker.role, agent: worker.agent, tool_call_id: artifact.request_id, work_identity: artifact.work_identity } as NonNullable<typeof record>;
      }
    }
    const requestId = record?.tool_call_id ?? selected.state.preparation_start?.request_id;
    if (!record?.work_identity || !capability?.capability_id || !selected.state.profile_hash || !requestId) return { ok: false, code: "SPEC_PHASE_STALE", error: "native generation handoff is unavailable in the selected workflow state" };
    if (!workspace.constitution_binding) return { ok: false, code: "SPEC_PHASE_STALE", error: "native generation constitution binding is unavailable" };
    const identities = readPinnedConstitutionPrincipleIdentities(pinnedRoot, workspace.constitution_binding);
    if (!identities.ok) return { ok: false, code: "SPEC_PHASE_STALE", error: identities.error };
    if (record.work_identity.run_id !== input.run_key
      || record.work_identity.workflow !== capability.issued_for?.workflow
      || record.work_identity.stage_id !== phase.phase
      || record.work_identity.stage_cursor !== phase.phase
      || record.work_identity.dispatch_id !== record.id) {
      return { ok: false, code: "SPEC_PHASE_STALE", error: "native generation handoff work identity is not bound to the selected run, workflow, and phase" };
    }
    const handoffVersion = phase.status === "generating" ? (phase.current_version ?? 0) + 1 : (phase.current_version ?? 0);
    const generation = nativeGenerationBinding({
      feature_id: input.feature_id,
      run_key: input.run_key,
      phase: phase.phase,
      version: handoffVersion,
      request_id: requestId,
      dispatch_id: record.id,
      capability_id: record.work_identity.capability_id,
      capability_epoch: record.work_identity.capability_epoch,
      run_id: record.work_identity.run_id,
      workflow: record.work_identity.workflow,
      task_id: record.work_identity.task_id,
      worker_id: record.work_identity.worker_id,
    });
    const outputSchema = specificationPhaseSchemaForConstitution(identities.value, workspace.constitution_binding, phase.phase, generation);
    const upstream = expectedUpstream(projectRoot, workspace, phase.phase, input.run_key, pinnedRoot);
    if (!outputSchema || !upstream.ok) return { ok: false, code: "SPEC_PHASE_STALE", error: upstream.ok ? "native worker output schema is unavailable" : upstream.error };
    const phaseTemplate = resolveNativePhaseTemplate(projectRoot, workspace, phase.phase, pinnedRoot);
    if (!phaseTemplate.ok) return { ok: false, code: "SPEC_PHASE_STALE", error: phaseTemplate.error };
    const generationMarker = buildDispatchMarker(input.run_key, { id: phase.phase, title: phase.phase, type: "single", role: record.role }, [record.role], record.role, record.work_identity.capability_epoch, record.work_identity.capability_id, record.role, record.work_identity.task_id, input.feature_id);
    const handoff: NativeSpecificationGenerationHandoff = {
      feature_id: input.feature_id,
      run_key: input.run_key,
      phase: phase.phase,
      version: handoffVersion,
      request_id: requestId,
      dispatch_id: record.id,
      worker_name: nativeWorkerName(phase.phase, record.id),
      dispatch_marker: generationMarker,
      input_ref: generation.input_ref,
      input_digest: generation.input_digest,
      output_schema: outputSchema,
      work_identity: record.work_identity,
      capability_epoch: record.work_identity.capability_epoch,
      constitution_binding: workspace.constitution_binding,
      upstream_versions: upstream.value,
      template_hash: workspace.template_set.content_hash,
      language_hash: workspace.language.selection_hash,
      feedback: phase.last_feedback,
      workflow: selected.state.classification.workflow,
      cursor_epoch: record.work_identity.capability_epoch,
      token: "",
      capability_id: record.work_identity.capability_id,
      advance_token: "",
      branch: selected.state.branch,
      profile_hash: selected.state.profile_hash,
      role: record.work_identity.slot_id,
      slot_id: record.work_identity.slot_id,
      agent: record.work_identity.worker_id,
      constitution_principles: identities.value.map(({ principle_id, title }) => ({ principle_id, title })),
      requester_context: selected.state.task,
      phase_template: phaseTemplate.value,
    };
    return { ok: true, handoff, phase_status: phase.status };
  } finally {
    pinnedRoot.close();
  }
}

function resolveCurrentNativeGenerationHandoff(
  projectRoot: string,
  input: Pick<NativeSpecificationPhaseFinalizeInput, "feature_id" | "run_key">,
  currentHandoff?: { ok: true; handoff: NativeSpecificationGenerationHandoff; phase_status: WorkspacePhaseRecord["status"] },
): { ok: true; handoff: NativeSpecificationGenerationHandoff } | { ok: false; code: PhaseLifecycleCode; error: string } {
  const current = currentHandoff ?? readCurrentNativeGenerationHandoff(projectRoot, input);
  if (!current.ok) return current;
  if (current.phase_status === "awaiting_approval" || current.phase_status === "materialized") return { ok: true, handoff: current.handoff };
  const selected = resolveState(projectRoot, resolveActiveBranch(projectRoot), { feature_id: input.feature_id, run_key: input.run_key });
  if (selected.invalid || !selected.state?.preparation_handoff) return { ok: false, code: "SPEC_PHASE_STALE", error: "native generation preparation authority is unavailable in the selected workflow state" };
  const started = startNativeSpecificationPhase(projectRoot, { feature_id: input.feature_id, run_key: input.run_key, preparation_handoff: selected.state.preparation_handoff });
  if (!started.ok) return started;
  return { ok: true, handoff: started.value.handoff };
}

function nativePersistedPhaseResultReplayError(
  existing: PersistedPhaseResultEnvelope,
  handoff: NativeSpecificationGenerationHandoff,
  semanticModel: SpecificationSemanticModel,
  sourceArtifact: Record<string, unknown>,
  documentPath: string,
  document: string,
): string | null {
  const semanticSections = semanticModel.sections as unknown as Record<string, string>;
  const documents = [{ path: documentPath, content: document }];
  const requestDigest = digestOf({
    feature_id: handoff.feature_id,
    run_key: handoff.run_key,
    phase: handoff.phase,
    version: handoff.version,
    request_id: handoff.request_id,
    dispatch_id: handoff.dispatch_id,
    source_artifact: sourceArtifact,
    documents,
    semantic_sections: semanticSections,
    constitution_binding: handoff.constitution_binding,
    upstream_versions: handoff.upstream_versions,
    template_hash: handoff.template_hash,
    language_hash: handoff.language_hash,
  });
  const sectionHashes = Object.fromEntries(
    Object.entries(semanticSections).sort(([left], [right]) => left.localeCompare(right)).map(([marker, content]) => [marker, sha256Hex(content)]),
  );
  const expectedDocumentHashes = { [documentPath]: sha256Hex(document) };
  if (existing.schema_version !== 1 || existing.feature_id !== handoff.feature_id || existing.run_key !== handoff.run_key
    || existing.artifact_id !== handoff.phase + ".v" + handoff.version || existing.phase !== handoff.phase || existing.version !== handoff.version
    || existing.request_id !== handoff.request_id || existing.request_digest !== requestDigest || existing.source_artifact_id !== PHASE_SOURCE_ARTIFACT[handoff.phase]
    || existing.dispatch_id !== handoff.dispatch_id || existing.capability_epoch !== handoff.capability_epoch
    || !same(existing.work_identity, handoff.work_identity) || existing.source_artifact_hash !== digestOf(sourceArtifact)
    || !same(existing.source_artifact, sourceArtifact) || !same(existing.semantic_model, semanticModel)
    || !same(existing.document_paths, [documentPath]) || !same(existing.document_hashes, expectedDocumentHashes)
    || !same(existing.semantic_section_hashes, sectionHashes) || existing.template_hash !== handoff.template_hash
    || existing.language_hash !== handoff.language_hash || !same(existing.upstream_versions, handoff.upstream_versions)
    || !same(existing.constitution_binding, handoff.constitution_binding)) {
    return "persisted native phase artifact does not match the exact generation handoff and worker_result";
  }
  return null;
}
function replayNativeSpecificationFinalization(
  projectRoot: string,
  handoff: NativeSpecificationGenerationHandoff,
  workerResult: NativeSpecificationWorkerResult,
): PhaseLifecycleResult<NativeSpecificationPhaseFinalize> | null {
  const selected = resolveState(projectRoot, resolveActiveBranch(projectRoot), { feature_id: handoff.feature_id, run_key: handoff.run_key });
  if (selected.invalid || !selected.state?.specification) return fail("SPEC_PHASE_FORBIDDEN", "native specification phase replay requires the selected workflow state");
  const workspace = selected.state.specification;
  const phase = workspace.phases.find((candidate) => candidate.phase === handoff.phase);
  if (!phase || phase.status !== "awaiting_approval") return null;
  if (phase.current_version !== handoff.version) return fail("SPEC_PHASE_STALE", "native phase replay handoff version is no longer current");
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return fail("SPEC_PHASE_PERSIST_FAILED", "project root cannot be pinned for native phase replay");
  try {
    const identities = readPinnedConstitutionPrincipleIdentities(pinnedRoot, handoff.constitution_binding);
    if (!identities.ok) return fail("SPEC_PHASE_STALE", identities.error);
    const hydrated = hydrateNativeSpecificationWorkerResult(handoff.phase, handoff, workerResult, identities.value);
    if (!hydrated.ok) return fail("SPEC_SEMANTIC_MODEL_REQUIRED", hydrated.error);
    const semanticModel = hydrated.value;
    const artifact = readVersion(projectRoot, handoff.feature_id, `${handoff.phase}.v${handoff.version}`, handoff.run_key, pinnedRoot);
    if (!artifact || digestOf(artifact.semantic_model) !== digestOf(semanticModel)) return fail("SPEC_PHASE_IMMUTABLE", "native phase replay worker_result does not match the immutable artifact");
    if (artifact.dispatch_id !== handoff.dispatch_id || artifact.capability_epoch !== handoff.capability_epoch || !isRecord(artifact.work_identity) || artifact.work_identity.capability_id !== handoff.capability_id) return fail("SPEC_PHASE_STALE", "native phase replay handoff is not bound to the immutable generation artifact");
    const validationSnapshot = readPinnedArtifactSnapshot(pinnedRoot, join(".work-state", "features", handoff.feature_id, "artifacts"), `validation.${handoff.phase}.v${handoff.version}`).value;
    if (!isRecord(validationSnapshot) || validationSnapshot.status !== "pass" || !deterministicValidationMatchesArtifact(artifact, validationSnapshot, pinnedRoot)) return fail("SPEC_PHASE_STALE", "native phase replay validation postimage is missing or inconsistent");
    const checkpointCapability = reissueNativeSpecificationCheckpointCapability(projectRoot, { feature_id: handoff.feature_id, run_key: handoff.run_key, branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash, phase: handoff.phase, version: handoff.version, capability_id: selected.state.dispatch_capability?.capability_id ?? "", generation_dispatch_id: handoff.dispatch_id });
    if (!checkpointCapability.ok) return fail(checkpointCapability.code === "NATIVE_COMPOSITE_REQUIRED" ? "NATIVE_COMPOSITE_REQUIRED" : "SPEC_PHASE_FORBIDDEN", checkpointCapability.error);
    const beforePresentationConstitution = currentConstitutionGuard(projectRoot, handoff.constitution_binding);
  if (!beforePresentationConstitution.ok) return fail("SPEC_PHASE_STALE", beforePresentationConstitution.error);
  const presented = presentPhaseCheckpoint(projectRoot, { feature_id: handoff.feature_id, run_key: handoff.run_key, phase: handoff.phase });
    if (!presented.ok) return presented;
    injectPhaseFailure("after_checkpoint_presentation");
    const askArguments = { feature_id: handoff.feature_id, advance_token: checkpointCapability.advance_token, capability_id: checkpointCapability.capability_id, run_key: handoff.run_key, branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash, stage_cursor: handoff.phase, cursor_epoch: checkpointCapability.cursor_epoch, checkpoint: PHASE_CHECKPOINT, checkpoint_id: PHASE_CHECKPOINT, checkpoint_kind: PHASE_CHECKPOINT, loop_iteration: 1, question: `Review the validated ${handoff.phase} phase artifact ${artifact.artifact_id}.` };
    return { ok: true, replayed: true, value: { persisted_version: artifact, validation: validationSnapshot as unknown as PhaseValidationResult, required_next_tool: { name: "workflow_checkpoint_ask_selected", arguments: askArguments }, next_action: "Immediately call required_next_tool.arguments on the trusted host UI; do not infer or record a phase decision before the current user answers." } };
  } catch (error) {
    return fail("SPEC_PHASE_STALE", `native phase replay postimage could not be read: ${String(error)}`);
  } finally {
    pinnedRoot.close();
  }
}
/**
 * Compose child-result fan-in, canonical persistence, generation completion,
 * validator-only dispatch, deterministic validation, and checkpoint Ask
 * preparation. No interactive Ask is performed here; callers must execute the
 * returned checkpoint_ask_selected descriptor on the trusted host surface.
 */
export function finalizeNativeSpecificationPhase(
  projectRoot: string,
  input: NativeSpecificationPhaseFinalizeInput,
): PhaseLifecycleResult<NativeSpecificationPhaseFinalize> {
  const inputError = nativeCompositeInputError({ feature_id: input?.feature_id, run_key: input?.run_key });
  if (inputError) return fail("SPEC_PHASE_REQUEST_INVALID", inputError);
  if (!isRecord(input.worker_result)) return fail("SPEC_SEMANTIC_MODEL_REQUIRED", "native phase finalization requires one structured worker_result");
  const provisional = readCurrentNativeGenerationHandoff(projectRoot, input);
  if (!provisional.ok) return fail(provisional.code, provisional.error);
  let handoff = provisional.handoff;
  const initialConstitution = currentConstitutionGuard(projectRoot, handoff.constitution_binding);
  if (!initialConstitution.ok) return fail("SPEC_PHASE_STALE", initialConstitution.error);
  const pinnedForHydration = PinnedProjectRoot.open(projectRoot);
  if (!pinnedForHydration) return fail("SPEC_PHASE_PERSIST_FAILED", "project root cannot be pinned while hydrating native worker_result");
  let semanticModel: SpecificationSemanticModel;
  try {
    const identities = readPinnedConstitutionPrincipleIdentities(pinnedForHydration, handoff.constitution_binding);
    if (!identities.ok) return fail("SPEC_PHASE_STALE", identities.error);
    const hydrated = hydrateNativeSpecificationWorkerResult(handoff.phase, handoff, input.worker_result, identities.value);
    if (!hydrated.ok) return fail("SPEC_SEMANTIC_MODEL_REQUIRED", hydrated.error);
    semanticModel = hydrated.value;
  } finally {
    pinnedForHydration.close();
  }
  const resolved = resolveCurrentNativeGenerationHandoff(projectRoot, input, provisional);
  if (!resolved.ok) return fail(resolved.code, resolved.error);
  handoff = resolved.handoff;
  // The worker result was hydrated against the handoff observed before any
  // continuation/recovery work. Re-read the authoritative state immediately
  // before replay or persistence so a retry cannot publish an older generation.
  const current = readCurrentNativeGenerationHandoff(projectRoot, input);
  if (!current.ok) return fail(current.code, current.error);
  if (input.worker_result.input_ref !== handoff.input_ref
    || input.worker_result.input_digest !== handoff.input_digest
    || current.handoff.input_ref !== handoff.input_ref
    || current.handoff.input_digest !== handoff.input_digest) {
    return fail("SPEC_PHASE_STALE", "native worker_result generation binding is no longer current");
  }
  const replay = replayNativeSpecificationFinalization(projectRoot, handoff, input.worker_result);
  if (replay) return replay;
  const documentPath = PHASE_DOCUMENT[handoff.phase];
  let document: string;
  try {
    document = renderCanonicalPhaseDocument(handoff.phase, semanticModel, handoff.phase_template);
  } catch (error) {
    return fail("SPEC_PHASE_REQUEST_INVALID", `canonical phase document could not be rendered: ${String(error)}`);
  }
  const sourceArtifact: Record<string, unknown> = {
    schema_version: 1,
    feature_id: handoff.feature_id,
    run_key: handoff.run_key,
    phase: handoff.phase,
    version: handoff.version,
    worker: { role: handoff.role, agent: handoff.agent, dispatch_id: handoff.dispatch_id },
    constitution_binding: handoff.constitution_binding,
    upstream_versions: handoff.upstream_versions,
    document_sha256: sha256Hex(document),
    semantic_model: semanticModel,
  };
  const beforePersistConstitution = currentConstitutionGuard(projectRoot, handoff.constitution_binding);
  if (!beforePersistConstitution.ok) return fail("SPEC_PHASE_STALE", beforePersistConstitution.error);
  const selectedBeforeMaterialize = resolveState(projectRoot, resolveActiveBranch(projectRoot), { feature_id: handoff.feature_id, run_key: handoff.run_key });
  if (selectedBeforeMaterialize.invalid || !selectedBeforeMaterialize.state?.specification) return fail("SPEC_PHASE_FORBIDDEN", "native phase finalization state disappeared before persistence");
  const materializedReplay = selectedBeforeMaterialize.state.specification.phases.find((candidate) => candidate.phase === handoff.phase)?.status === "materialized";
  let persisted: PhaseLifecycleResult<PersistedSpecificationPhase>;
  if (materializedReplay) {
    const pinnedForExisting = PinnedProjectRoot.open(projectRoot);
    if (!pinnedForExisting) return fail("SPEC_PHASE_PERSIST_FAILED", "project root cannot be pinned while reading native phase materialization");
    let existing: PersistedPhaseResultEnvelope | null;
    try { existing = readVersion(projectRoot, handoff.feature_id, handoff.phase + ".v" + handoff.version, handoff.run_key, pinnedForExisting); } finally { pinnedForExisting.close(); }
    if (!existing) return fail("SPEC_PHASE_STALE", "native phase materialization postimage is unavailable for exact retry");
    const replayIssue = nativePersistedPhaseResultReplayError(existing, handoff, semanticModel, sourceArtifact, documentPath, document);
    if (replayIssue) return fail("SPEC_PHASE_IMMUTABLE", replayIssue);
    persisted = { ok: true, replayed: true, value: { workspace: selectedBeforeMaterialize.state.specification, version: existing, handoff_required: handoff.phase === "tasks" } };
  } else {
    persisted = persistSpecificationPhaseResult(projectRoot, {
      token: handoff.token,
      capability_id: handoff.capability_id,
      feature_id: handoff.feature_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      phase: handoff.phase,
      request_id: handoff.request_id,
      cursor_epoch: handoff.cursor_epoch,
      dispatch_id: handoff.dispatch_id,
      input_ref: handoff.input_ref,
      input_digest: handoff.input_digest,
      role: handoff.role,
      slot_id: handoff.slot_id,
      agent: handoff.agent,
      version: handoff.version,
      source_artifact: sourceArtifact,
      documents: [{ path: documentPath, content: document }],
      semantic_sections: semanticModel.sections as unknown as Record<string, string>,
      constitution_binding: handoff.constitution_binding,
      upstream_versions: handoff.upstream_versions,
      template_hash: handoff.template_hash,
      language_hash: handoff.language_hash,
    });
  }
  injectPhaseFailure("after_materialize");
  if (!persisted.ok) return persisted;
  let validator: { capability_id: string; dispatch_token: string; advance_token: string; capability_epoch: string; record: { id: string } } | null = null;
  let validationAlreadySucceeded = false;
  if (materializedReplay) {
    const selected = resolveState(projectRoot, resolveActiveBranch(projectRoot), { feature_id: handoff.feature_id, run_key: handoff.run_key });
    const state = selected.state;
    const cap = state?.dispatch_capability;
    const generationRecord = cap?.dispatches?.find((candidate) => candidate.id === handoff.dispatch_id && (candidate.purpose ?? "generation") === "generation");
    const policyHash = cap?.policy_hash;
    const configHash = state?.config_hash;
    if (!state || !cap || !cap.capability_id || !cap.issued_for || !generationRecord?.work_identity
      || generationRecord.status !== "succeeded"
      || !generationRecord.completion || generationRecord.completion.outcome !== "succeeded"
      || canonicalJson(generationRecord.work_identity) !== canonicalJson(handoff.work_identity)
      || generationRecord.role !== handoff.role || generationRecord.agent !== handoff.agent
      || !configHash || !policyHash) {
      return fail("SPEC_PHASE_STALE", "native materialized phase resume authority is unavailable or generation identity is stale");
    }
    if (canonicalJson(persisted.value.version.work_identity) !== canonicalJson(generationRecord.work_identity)
      || !generationRecord.completion.artifact_ids.includes(persisted.value.version.source_artifact_id)) {
      return fail("SPEC_PHASE_STALE", "native materialized phase artifact is not bound to its authenticated generation postimage");
    }
    const validatorProof = issueCurrentTrustedMappingProof(projectRoot);
    const resumed = resumeNativeSpecificationValidationFromPersisted(projectRoot, {
      feature_id: handoff.feature_id,
      run_key: handoff.run_key,
      branch: state.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      phase: handoff.phase,
      version: handoff.version,
      capability_id: cap.capability_id,
      generation_dispatch_id: handoff.dispatch_id,
      request_id: `native-validation-${handoff.phase}-${handoff.feature_id}-${handoff.version}`,
      generation: {
        capability_id: cap.capability_id,
        run_key: state.run_key ?? handoff.run_key,
        branch: state.branch,
        workflow: handoff.workflow,
        profile_hash: handoff.profile_hash,
        stage_cursor: handoff.phase,
        cursor_epoch: cap.issued_for.cursor_epoch,
        config_hash: configHash,
        policy_hash: policyHash,
        dispatch_id: generationRecord.id,
        role: generationRecord.role,
        slot_id: generationRecord.work_identity.slot_id,
        task_id: generationRecord.work_identity.task_id,
        agent: generationRecord.agent,
        work_identity: generationRecord.work_identity,
      },
      generation_artifact_ids: [persisted.value.version.source_artifact_id],
      generation_evidence: `engine finalized ${persisted.value.version.artifact_id} from the exact child worker_result`,
    }, validatorProof === undefined ? {} : { trustedMappingProof: validatorProof });
    if (!resumed.ok) return fail(resumed.code === "failed" ? "SPEC_PHASE_CONFLICT" : "SPEC_PHASE_FORBIDDEN", resumed.error);
    injectPhaseFailure("after_generation_complete");
    injectPhaseFailure("after_validation_dispatch");
    if (resumed.status === "succeeded") {
      validationAlreadySucceeded = true;
    } else {
      validator = {
        capability_id: resumed.capability_id,
        dispatch_token: resumed.dispatch_token,
        advance_token: resumed.advance_token,
        capability_epoch: resumed.capability_epoch,
        record: resumed.record,
      };
    }
  } else {
    const beforeCompleteConstitution = currentConstitutionGuard(projectRoot, handoff.constitution_binding);
    if (!beforeCompleteConstitution.ok) return fail("SPEC_PHASE_STALE", beforeCompleteConstitution.error);
    const completed = completeNativeSpecificationGeneration(projectRoot, {
      token: handoff.token,
      capability_id: handoff.capability_id,
      feature_id: handoff.feature_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.phase,
      cursor_epoch: handoff.cursor_epoch,
      dispatch_id: handoff.dispatch_id,
      role: handoff.role,
      slot_id: handoff.slot_id,
      agent: handoff.agent,
      outcome: "succeeded",
      evidence: `engine finalized ${persisted.value.version.artifact_id} from the exact child worker_result`,
      artifact_ids: [persisted.value.version.source_artifact_id],
    });
    if (!completed.ok) return fail("SPEC_PHASE_FORBIDDEN", completed.error);
    injectPhaseFailure("after_generation_complete");
    const beforeValidatorConstitution = currentConstitutionGuard(projectRoot, handoff.constitution_binding);
    if (!beforeValidatorConstitution.ok) return fail("SPEC_PHASE_STALE", beforeValidatorConstitution.error);
    const validationRequestId = `native-validation-${handoff.phase}-${handoff.feature_id}-${handoff.version}`;
    const validatorProof = issueCurrentTrustedMappingProof(projectRoot);
    const issued = authorizeSpecificationPhaseValidationDispatch(projectRoot, {
      token: handoff.token,
      capability_id: handoff.capability_id,
      feature_id: handoff.feature_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      stage_cursor: handoff.phase,
      cursor_epoch: handoff.cursor_epoch,
      request_id: validationRequestId,
    }, validatorProof === undefined ? {} : { trustedMappingProof: validatorProof });
    if (!issued.ok) return fail("SPEC_PHASE_FORBIDDEN", issued.error);
    validator = issued;
    injectPhaseFailure("after_validation_dispatch");
  }
  const validationRequestId = `native-validation-${handoff.phase}-${handoff.feature_id}-${handoff.version}`;
  let validation: PhaseLifecycleResult<PhaseValidationResult>;
  let validationReplayed = false;
  if (validationAlreadySucceeded) {
    const pinned = PinnedProjectRoot.open(projectRoot);
    if (!pinned) return fail("SPEC_PHASE_PERSIST_FAILED", "project root cannot be pinned while reading native validator success");
    let validationSnapshot: unknown;
    try {
      validationSnapshot = readPinnedArtifactSnapshot(pinned, join(".work-state", "features", handoff.feature_id, "artifacts"), `validation.${handoff.phase}.v${handoff.version}`).value;
      if (!isRecord(validationSnapshot) || validationSnapshot.status !== "pass" || !deterministicValidationMatchesArtifact(persisted.value.version, validationSnapshot, pinned)) {
        return fail("SPEC_PHASE_STALE", "native validator success receipt has no exact passing validation postimage");
      }
    } finally {
      pinned.close();
    }
    validation = { ok: true, replayed: true, value: validationSnapshot as unknown as PhaseValidationResult };
    validationReplayed = true;
    injectPhaseFailure("after_validation_observe");
  } else {
    if (!validator) return fail("SPEC_PHASE_FORBIDDEN", "native validator dispatch authority is unavailable");
    const pinnedForValidation = PinnedProjectRoot.open(projectRoot);
    if (!pinnedForValidation) return fail("SPEC_PHASE_PERSIST_FAILED", "project root cannot be pinned while deriving native validation facts");
    let upstreamModels: SpecificationSemanticModel[];
    try {
      const upstream = readPinnedUpstreamSemanticModels(projectRoot, handoff.feature_id, handoff.run_key, persisted.value.version.upstream_versions, pinnedForValidation);
      if (!upstream.ok) return fail("SPEC_PHASE_STALE", upstream.error);
      upstreamModels = upstream.value;
    } finally {
      pinnedForValidation.close();
    }
    const semanticReports = semanticModelReports(handoff.phase, semanticModel, upstreamModels);
    const beforeValidationConstitution = currentConstitutionGuard(projectRoot, handoff.constitution_binding);
    if (!beforeValidationConstitution.ok) return fail("SPEC_PHASE_STALE", beforeValidationConstitution.error);
    validation = persistSpecificationPhaseValidation(projectRoot, {
      token: validator.dispatch_token,
      capability_id: validator.capability_id,
      feature_id: handoff.feature_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      phase: handoff.phase,
      request_id: validationRequestId,
      cursor_epoch: validator.capability_epoch,
      dispatch_id: validator.record.id,
      validation: {
        validation_id: `validation.${handoff.phase}.v${persisted.value.version.version}`,
        feature_id: handoff.feature_id,
        run_key: handoff.run_key,
        phase: handoff.phase,
        version: persisted.value.version.version,
        artifact_version: persisted.value.version.artifact_id,
        document_path: documentPath,
        document_sha256: persisted.value.version.document_hashes[documentPath]!,
        sections: semanticModel.sections as unknown as Record<string, string>,
        upstream_versions: semanticModel.upstream_versions,
        expected_upstream_versions: semanticModel.upstream_versions,
        constitution_binding: semanticModel.constitution_binding,
        expected_constitution_binding: semanticModel.constitution_binding,
        constitution_principles: semanticReports.constitution_principles,
        requirements: semanticReports.requirements,
        decisions: semanticReports.decisions,
        tasks: semanticReports.tasks,
        verification: semanticReports.verification,
        contradictions: semanticReports.contradictions,
        validated_at: "1970-01-01T00:00:00.000Z",
      },
    });
    if (!validation.ok) return validation;
    validationReplayed = validation.replayed;
    injectPhaseFailure("after_validation_observe");
  }
  if (validation.value.status !== "pass") return fail("SPEC_CHECKPOINT_BLOCKED", "native phase validation did not pass; checkpoint Ask remains closed");
  let askCapability = validator;
  if (validationAlreadySucceeded) {
    const selected = resolveState(projectRoot, resolveActiveBranch(projectRoot), { feature_id: handoff.feature_id, run_key: handoff.run_key });
    const currentCap = selected.state?.dispatch_capability;
    if (!currentCap?.capability_id) return fail("SPEC_PHASE_STALE", "native checkpoint capability is unavailable after validator observation");
    const checkpoint = reissueNativeSpecificationCheckpointCapability(projectRoot, {
      feature_id: handoff.feature_id,
      run_key: handoff.run_key,
      branch: handoff.branch,
      workflow: handoff.workflow,
      profile_hash: handoff.profile_hash,
      phase: handoff.phase,
      version: handoff.version,
      capability_id: currentCap.capability_id,
      generation_dispatch_id: handoff.dispatch_id,
    });
    if (!checkpoint.ok) return fail(checkpoint.code === "NATIVE_COMPOSITE_REQUIRED" ? "NATIVE_COMPOSITE_REQUIRED" : "SPEC_PHASE_FORBIDDEN", checkpoint.error);
    askCapability = { capability_id: checkpoint.capability_id, dispatch_token: "", advance_token: checkpoint.advance_token, capability_epoch: checkpoint.cursor_epoch, record: { id: "" } };
  }
  const presented = presentPhaseCheckpoint(projectRoot, { feature_id: handoff.feature_id, run_key: handoff.run_key, phase: handoff.phase });
  if (!presented.ok) return fail(presented.code, presented.error);
  injectPhaseFailure("after_checkpoint_presentation");
  const askArguments = { feature_id: handoff.feature_id, advance_token: askCapability!.advance_token, capability_id: askCapability!.capability_id, run_key: handoff.run_key, branch: handoff.branch, workflow: handoff.workflow, profile_hash: handoff.profile_hash, stage_cursor: handoff.phase, cursor_epoch: askCapability!.capability_epoch, checkpoint: PHASE_CHECKPOINT, checkpoint_id: PHASE_CHECKPOINT, checkpoint_kind: PHASE_CHECKPOINT, loop_iteration: 1, question: `Review the validated ${handoff.phase} phase artifact ${persisted.value.version.artifact_id}.` };
  return { ok: true, replayed: materializedReplay || persisted.replayed || validationReplayed || presented.replayed, value: { persisted_version: persisted.value.version, validation: validation.value, required_next_tool: { name: "workflow_checkpoint_ask_selected", arguments: askArguments }, next_action: "Immediately call required_next_tool.arguments on the trusted host UI; do not infer or record a phase decision before the current user answers." } };
}
/** Present the current immutable, passing phase version for hard-human approval. */
export function presentPhaseCheckpoint(projectRoot: string, input: { feature_id: string; run_key: string; phase: WorkspacePhase }): PhaseLifecycleResult<PhaseCheckpointPresentation> {
  const selectorError = validateSelector(input);
  if (selectorError) return fail("SPEC_PHASE_REQUEST_INVALID", selectorError);
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return fail("SPEC_PHASE_PERSIST_FAILED", "project root cannot be pinned for phase checkpoint presentation");
  try {
    let preCommitCheckpointGuard: (() => void) | null = null;
    const outcome = updateStateAtomically<PhaseLifecycleResult<PhaseCheckpointPresentation>>(
      projectRoot,
      (snapshot) => {
        if (!snapshot.state || !snapshot.target.statePath) return { op: "fail", code: "SPEC_CHECKPOINT_UNKNOWN", error: "selected phase checkpoint is unavailable" };
        const state = snapshot.state;
        if (!state.specification || !["native", "legacy"].includes(state.specification.source_kind)) return { op: "fail", code: "SPEC_PHASE_FORBIDDEN", error: "phase checkpoint requires a native or verified migrated workspace" };
        const workspace = state.specification;
        const record = phaseRecord(workspace, input.phase);
        if (!record) {
          return { op: "fail", code: "SPEC_PHASE_NOT_READY", error: `phase '${input.phase}' is unavailable` };
        }
        const freshnessError = checkpointFreshnessError(projectRoot, workspace, input.phase, input.run_key, record, pinnedRoot);
        if (freshnessError) return { op: "fail", code: "SPEC_CHECKPOINT_BLOCKED", error: freshnessError };
        preCommitCheckpointGuard = () => {
          const latestError = checkpointFreshnessError(projectRoot, workspace, input.phase, input.run_key, record, pinnedRoot);
          if (latestError) throw new Error("SPEC_CHECKPOINT_STALE:" + latestError);
        };
        if (!validationPass(projectRoot, workspace, record, input.run_key, pinnedRoot)) {
          return { op: "fail", code: "SPEC_CHECKPOINT_BLOCKED", error: `phase '${input.phase}' has no current passing validation result` };
        }
        const expected = checkpointRef(input.phase, record.current_version!);
        const checkpointEstablished = record.checkpoint_ref === expected;
        const canonicalNextAction = nextActionForWorkspace(workspace.phases, {
          status: workspace.status,
          hasConstitutionBinding: workspace.constitution_binding !== null,
          sourceKind: workspace.source_kind,
        });
        const phaseCheckpointReason = canonicalNextAction.reason;
        const pauseEstablished = state.pause.kind === "user_checkpoint" && state.pause.reason === phaseCheckpointReason;
        if (checkpointEstablished && pauseEstablished) {
          return {
            op: "discard",
            value: {
              ok: true,
              replayed: true,
              value: {
                phase: input.phase,
                version: record.current_version!,
                checkpoint_id: PHASE_CHECKPOINT,
                allowed_decisions: [...PHASE_DECISIONS],
                revision_feedback: record.last_feedback,
              },
            },
          };
        }
        const phases = workspace.phases.map((candidate) => candidate.phase === input.phase ? { ...candidate, checkpoint_ref: expected } : candidate);
        const nextWorkspace = {
          ...workspace,
          phases,
          next_action: {
            kind: "checkpoint" as const,
            command: null,
            reason: phaseCheckpointReason,
          },
        };
        return {
          op: "commit",
          state: { ...state, specification: nextWorkspace, pause: { kind: "user_checkpoint", reason: phaseCheckpointReason } },
          value: {
            ok: true,
            replayed: checkpointEstablished,
            value: {
              phase: input.phase,
              version: record.current_version!,
              checkpoint_id: PHASE_CHECKPOINT,
              allowed_decisions: [...PHASE_DECISIONS],
              revision_feedback: record.last_feedback,
            },
          },
        };
      },
      {
        selector: { feature_id: input.feature_id, run_key: input.run_key },
        pinnedRoot,
        preCommit: () => preCommitCheckpointGuard?.(),
      },
    );
    if (!outcome.ok) {
      const code: PhaseLifecycleCode = outcome.code === "state_conflict"
        ? "SPEC_PHASE_CONFLICT"
        : outcome.code === "SPEC_PHASE_FORBIDDEN"
          ? "SPEC_PHASE_FORBIDDEN"
          : outcome.code === "SPEC_PHASE_NOT_READY"
            ? "SPEC_PHASE_NOT_READY"
            : outcome.code === "SPEC_CHECKPOINT_BLOCKED"
              ? "SPEC_CHECKPOINT_BLOCKED"
              : outcome.code === "SPEC_CHECKPOINT_UNKNOWN"
                ? "SPEC_CHECKPOINT_UNKNOWN"
                : "SPEC_PHASE_PERSIST_FAILED";
      if (outcome.error.startsWith("pre-commit guard failed: SPEC_CHECKPOINT_STALE:")) {
        return fail("SPEC_CHECKPOINT_BLOCKED", outcome.error.slice("pre-commit guard failed: SPEC_CHECKPOINT_STALE:".length));
      }
      return fail(code, outcome.error);
    }
    return outcome.value ?? fail("SPEC_PHASE_PERSIST_FAILED", "phase checkpoint transaction completed without a result");
  } catch (error) {
    return fail("SPEC_PHASE_PERSIST_FAILED", `phase checkpoint could not be persisted: ${String(error)}`);
  } finally {
    pinnedRoot.close();
  }
}
// ── Trusted decision projection (T105) ──────────────────────────────────────

/** The only decision values a specification phase checkpoint accepts (T101). */
export type SpecificationPhaseDecisionValue = (typeof PHASE_DECISIONS)[number];

export interface SpecificationPhaseDecisionProjection {
  decision: SpecificationPhaseDecisionValue;
  phase: WorkspacePhase;
  /** Mirrors the T101 checkpoint decision status exactly. */
  status: "approved" | "revision_required";
  resume_next_phase: WorkspacePhase | null;
  dispatched_next_phase: WorkspacePhase | null;
  /** True only when the supplied trusted decision itself arms the next phase. */
  dispatch_authorized: boolean;
}

/**
 * Pure projection of an already-trusted phase decision into the same shape
 * the mounted selected checkpoint Ask/advance path reports — without granting any authority beyond
 * that supplied decision: nothing is written, no capability is issued, and
 * the decision value is never upgraded, defaulted, or inferred. Unknown
 * phases or decisions fail closed with a deterministic error.
 */
export function mapSpecificationPhaseDecision(input: { phase: WorkspacePhase; decision: string }): SpecificationPhaseDecisionProjection {
  if (!PHASES.includes(input.phase)) {
    throw new Error(`mapSpecificationPhaseDecision: unsupported specification phase '${String(input.phase)}'`);
  }
  if (!PHASE_DECISIONS.includes(input.decision as SpecificationPhaseDecisionValue)) {
    throw new Error(`mapSpecificationPhaseDecision: decision '${String(input.decision)}' is not one of approve_continue | request_changes | approve_stop`);
  }
  const decision = input.decision as SpecificationPhaseDecisionValue;
  const effect = checkpointDecisionEffect({ decision });
  const target = nextPhase(input.phase);
  return {
    decision,
    phase: input.phase,
    status: effect === "revise" ? "revision_required" : "approved",
    resume_next_phase: target,
    dispatched_next_phase: effect === "continue" ? target : null,
    dispatch_authorized: effect === "continue" && target !== null,
  };
}
