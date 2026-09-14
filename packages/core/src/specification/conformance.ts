/**
 * Pure executor-neutral implementation conformance evaluation.
 *
 * The closure matrix is derived exclusively from the frozen handoff. Submitted
 * evidence may close a derived row, but can never add, remove, or waive one.
 */
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  writeArtifactWithReference,
  readArtifactPinned,
  readPinnedArtifactSnapshot,
  parseArtifactJson,
  type ArtifactReferenceAuthorization,
  type ArtifactSchemaValidator,
  type ArtifactWriteOwnershipToken,
  type PinnedArtifactSnapshot,
} from "../engine/artifacts.js";
import { MAX_PERSISTED_STATE_BYTES, updateStateAtomically, parseBoundedPersistedState } from "../engine/state.js";
import { validateProducedArtifact } from "../engine/artifact-contract.js";
import { PinnedProjectRoot } from "./pinned-root.js";
import type { CompletionArtifactRef, CompletionEnvelope, WorkIdentity } from "../engine/types.js";
import { readCurrentExecutionClaim, verifyExecutionClaimAdmissionBindingPinned } from "./claims.js";
import { canonicalHandoffDigest } from "./handoff.js";
import { readCanonicalHandoff } from "./canonical-reader.js";
import {
  isCtoSpecificationSafeId,
  MAX_CTO_SPECIFICATION_REQUESTS,
  type CtoSpecificationConformanceReceipt,
  type CtoSpecificationConformanceReceiptFeature,
  type CtoSpecificationMapping,
  type CtoState,
} from "../cto/types.js";
export type { CtoSpecificationConformanceReceipt, CtoSpecificationConformanceReceiptFeature } from "../cto/types.js";
import {
  captureWorkspacePathBinding,
  featureArtifactsDir,
  resolveFeatureWorkspace,
  type WorkspacePathBinding,
  type WorkspaceRootSnapshot,
} from "./workspace.js";
import type {
  CtoHandoffBinding,
  ConstitutionBinding,
  ConformanceFinding,
  ConformanceNextAction,
  ConformanceOverallStatus,
  ExecutedTestEvidence,
  ExecutionClaim,
  ExecutionClaimOwnerKind,
  ExecutionClaimStatus,
  FeatureWorkspace,
  ImplementationConformanceResult,
  ImplementationHandoff,
  QualityGateResult,
  RequirementClosureEntry,
} from "./types.js";
import {
  canonicalJson,
  digestOf,
  implementationConformanceMatrixDigest,
  isSha256Hex,
  isSafeRelativePath,
  isSafeFeatureId,
  validateExecutionClaim,
  validateConformanceAgainstHandoff,
  validateFeatureWorkspaceRecord,
  validateImplementationHandoff,
  MAX_HANDOFF_ARRAY_ITEMS,
  MAX_HANDOFF_VALIDATION_DEPTH,
  MAX_HANDOFF_VALIDATION_WORK,
  MAX_CONFORMANCE_ARTIFACT_BYTES,
} from "./validation.js";
import { validateTypedControlPlane } from "../engine/workflow-contract.js";
import { refreshCtoSpecificationConstitution } from "../cto/gates.js";
import { readPinnedCurrentConstitution } from "./constitution-identities.js";
import {
  ctoSpecificationConformanceReceiptRelativePath,
  isSafeCtoExecutionId,
  isSafeCtoRunId,
  readCtoStatePinned,
} from "../cto/state.js";
import { assertCtoRuntimeAccessFacadeLive, type CtoRunTransactionFacade, type CtoRuntimeAccessFacade } from "../cto/runtime-access.js";
import {
  MAX_CTO_MAPPING_CONTRACTS,
  MAX_CTO_MAPPING_FEATURES,
  MAX_CTO_MAPPING_PARALLELIZATION,
  MAX_CTO_MAPPING_TASKS,
  readPinnedCtoMappingRecord,
} from "./mapping-record.js";

export type ConformanceEvidenceKind =
  | "implementation"
  | "review"
  | "executed_test"
  | "intent_conflict";

export interface ConformanceEvidence {
  evidence_id: string;
  kind: ConformanceEvidenceKind;
  subject_id: string;
  requirement_id: string | null;
  handoff_digest: string;
  execution_claim_id: string;
  artifact: CompletionArtifactRef;
  review_verdict?: "pass" | "fail";
  test?: ExecutedTestEvidence;
  intent_message?: string;
}

export interface EvaluateImplementationConformanceInput {
  handoff: ImplementationHandoff;
  claim: ExecutionClaim;
  profile_hash: string;
  evidence: ConformanceEvidence[];
  quality_gates: QualityGateResult[];
  evaluated_at: string;
}

export interface NormalizeAndPersistImplementationConformanceInput extends EvaluateImplementationConformanceInput {
  workspace: FeatureWorkspace;
  project_root: string;
  active_owner_kind: ExecutionClaimOwnerKind;
  active_owner_run_id: string;
  allowed_artifact_paths: readonly string[];
}

export type NormalizeAndPersistImplementationConformanceResult =
  | { ok: true; result: ImplementationConformanceResult; artifact_ref: CompletionArtifactRef; artifact_ownership: ArtifactWriteOwnershipToken | null }
  | { ok: false; result: ImplementationConformanceResult; artifact_ref: null; issues: string[] };

type Remediation = Exclude<ConformanceNextAction, "complete_feature">;
type Subject = Pick<RequirementClosureEntry, "subject_kind" | "subject_id" | "requirement_id" | "observable_behavior">;
interface EvidenceAssessment { evidence: ConformanceEvidence; rejection: string | null; }
interface NormalizationFinding { message: string; remediation: Remediation; subject_id: string | null; evidence_refs: string[]; }

const CONFORMANCE_FAILED = "SPEC_IMPLEMENTATION_CONFORMANCE_FAILED";
const INTENT_CHANGED = "SPEC_IMPLEMENTATION_INTENT_CHANGED";
const EVIDENCE_KINDS: readonly string[] = ["implementation", "review", "executed_test", "intent_conflict"];
const TEST_KINDS: readonly string[] = ["unit", "integration", "e2e", "runtime"];
const NORMALIZATION_REJECTION = Symbol("implementation-conformance-normalization-rejection");
const NORMALIZATION_FINDINGS = Symbol("implementation-conformance-normalization-findings");
const CONFORMANCE_WORKSPACE_STATUSES: Partial<Record<FeatureWorkspace["status"], true>> = {
  claimed: true,
  executing: true,
  completion_validating: true,
  completion_blocked: true,
};
const REMEDIATION_PRECEDENCE: readonly Remediation[] = [
  "repair_implementation",
  "repeat_review",
  "repeat_tests",
  "repair_quality_gate",
];
const MAX_CANONICAL_CTO_INPUT_BYTES = 8 * 1024 * 1024;
/** Shared parser/domain ceilings for every conformance evidence envelope. */
export const MAX_CONFORMANCE_EVIDENCE_ENTRIES = 256;
export const MAX_CONFORMANCE_QUALITY_GATES = 64;
export const MAX_CONFORMANCE_ARTIFACT_REFS_PER_ENTRY = 64;
export const MAX_CONFORMANCE_FINDINGS_PER_GATE = 128;
export const MAX_CONFORMANCE_FINDING_REFS = 64;
export const MAX_CONFORMANCE_AGGREGATE_BYTES = 2 * 1024 * 1024;
export const MAX_CONFORMANCE_FIELD_BYTES = 16 * 1024;
export const MAX_CONFORMANCE_NESTING_DEPTH = 4;
/** Iterative direct-call ceilings covering the complete CTO input graph. */
export const MAX_CONFORMANCE_INPUT_NODES = 32_768;
export const MAX_CONFORMANCE_INPUT_DEPTH = Math.min(MAX_HANDOFF_VALIDATION_DEPTH, 64);
export const MAX_CONFORMANCE_INPUT_KEYS = 4_096;
export const MAX_CONFORMANCE_INPUT_ARRAY = MAX_HANDOFF_ARRAY_ITEMS;
export const MAX_CONFORMANCE_INPUT_STRING_BYTES = MAX_CONFORMANCE_FIELD_BYTES;
export const MAX_CONFORMANCE_INPUT_WORK = Math.min(MAX_HANDOFF_VALIDATION_WORK, 131_072);
export const MAX_CONFORMANCE_HANDOFFS = MAX_CTO_SPECIFICATION_REQUESTS;
export const MAX_CONFORMANCE_CLAIMS = MAX_CTO_SPECIFICATION_REQUESTS;

/** Internal deterministic race seam for canonical CTO input reads. */
export interface CtoConformanceReadTestHooks {
  afterRead?: (context: { path: string; relative_path: string; dev: number; ino: number }) => void;
}

interface CtoConformanceReadHookRegistration {
  hooks: CtoConformanceReadTestHooks;
  aliases: Set<string>;
}

const ctoConformanceReadTestHooksByRoot = new Map<string, CtoConformanceReadHookRegistration>();

function ctoConformanceReadLexicalAlias(projectRoot: unknown): string | null {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) return null;
  return `lexical:${resolve(projectRoot)}`;
}

function ctoConformanceReadCanonicalAlias(canonicalRoot: string): string {
  return `canonical:${canonicalRoot}`;
}

function ctoConformanceReadIdentityAlias(dev: number, ino: number): string {
  return `identity:${String(dev)}:${String(ino)}`;
}

function removeCtoConformanceReadHookRegistration(record: CtoConformanceReadHookRegistration): void {
  for (const alias of record.aliases) {
    if (ctoConformanceReadTestHooksByRoot.get(alias) === record) {
      ctoConformanceReadTestHooksByRoot.delete(alias);
    }
  }
}

function ctoConformanceReadHookForRoot(pinnedRoot: PinnedProjectRoot): CtoConformanceReadTestHooks | undefined {
  return ctoConformanceReadTestHooksByRoot.get(ctoConformanceReadIdentityAlias(pinnedRoot.dev, pinnedRoot.ino))?.hooks;
}

function setCtoConformanceReadHook(
  hooks: CtoConformanceReadTestHooks | null,
  projectRoot: unknown,
): void {
  const lexicalAlias = ctoConformanceReadLexicalAlias(projectRoot);
  if (!lexicalAlias) return;
  if (!hooks) {
    const directAliases = [lexicalAlias, ctoConformanceReadCanonicalAlias(resolve(projectRoot as string))];
    for (const alias of directAliases) {
      const direct = ctoConformanceReadTestHooksByRoot.get(alias);
      if (direct) {
        removeCtoConformanceReadHookRegistration(direct);
        return;
      }
    }
    const pinned = PinnedProjectRoot.open(projectRoot);
    if (!pinned) return;
    try {
      const aliases = [
        ctoConformanceReadCanonicalAlias(pinned.canonical_root),
        ctoConformanceReadIdentityAlias(pinned.dev, pinned.ino),
      ];
      const records = new Set<CtoConformanceReadHookRegistration>();
      for (const alias of aliases) {
        const record = ctoConformanceReadTestHooksByRoot.get(alias);
        if (record) records.add(record);
      }
      for (const record of records) removeCtoConformanceReadHookRegistration(record);
    } finally {
      pinned.close();
    }
    return;
  }

  const pinned = PinnedProjectRoot.open(projectRoot);
  if (!pinned) return;
  try {
    const aliases = new Set([
      lexicalAlias,
      ctoConformanceReadCanonicalAlias(pinned.canonical_root),
      ctoConformanceReadIdentityAlias(pinned.dev, pinned.ino),
    ]);
    const previous = new Set<CtoConformanceReadHookRegistration>();
    for (const alias of aliases) {
      const record = ctoConformanceReadTestHooksByRoot.get(alias);
      if (record) previous.add(record);
    }
    const sameIdentity = ctoConformanceReadTestHooksByRoot.get(
      ctoConformanceReadIdentityAlias(pinned.dev, pinned.ino),
    );
    if (sameIdentity && previous.size === 1) {
      sameIdentity.hooks = hooks;
      for (const alias of aliases) {
        sameIdentity.aliases.add(alias);
        ctoConformanceReadTestHooksByRoot.set(alias, sameIdentity);
      }
      return;
    }
    for (const record of previous) removeCtoConformanceReadHookRegistration(record);
    const record: CtoConformanceReadHookRegistration = { hooks, aliases };
    for (const alias of aliases) ctoConformanceReadTestHooksByRoot.set(alias, record);
  } finally {
    pinned.close();
  }
}

/** Install or clear the canonical CTO input read race seam for one project root. */
export function setCtoConformanceReadTestHooks(
  hooks: CtoConformanceReadTestHooks | null,
  projectRoot: string,
): void {
  setCtoConformanceReadHook(hooks, projectRoot);
}

interface PinnedCanonicalFile {
  path: string;
  relative_path: string;
  bytes: Buffer;
  dev: number;
  ino: number;
}

interface PinnedCanonicalReadFailure {
  ok: false;
  error: string;
}

type PinnedCanonicalRead = { ok: true; value: PinnedCanonicalFile } | PinnedCanonicalReadFailure;

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safePinnedRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split("/");
  return segments.length <= 128 && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Read one canonical input through the caller's already-open root descriptor.
 * The descriptor API performs no-follow traversal, bounded regular-file reads,
 * and descriptor/path identity checks; this wrapper adds explicit pre/post
 * root and leaf metadata checks around that single read.
 */
function readPinnedCanonicalFile(
  pinnedRoot: PinnedProjectRoot | null,
  candidate: unknown,
  label: string,
): PinnedCanonicalRead {
  if (!pinnedRoot) return { ok: false, error: `${label}: canonical project root is unavailable` };
  const relativePath = pinnedRoot.relativePath(candidate);
  if (!relativePath || !safePinnedRelativePath(relativePath)) {
    return { ok: false, error: `${label}: path is not a safe relative path below the canonical project root` };
  }
  try {
    if (!pinnedRoot.isStable()) return { ok: false, error: `${label}: project root changed before read` };
    const snapshot = pinnedRoot.readFile(relativePath, { maxBytes: MAX_CANONICAL_CTO_INPUT_BYTES });
    const path = pinnedRoot.anchorPath(relativePath);
    ctoConformanceReadHookForRoot(pinnedRoot)?.afterRead?.({ path, relative_path: relativePath, dev: snapshot.dev, ino: snapshot.ino });
    const after = pinnedRoot.pathEntryInfo(relativePath);
    if (after?.kind === "symlink") return { ok: false, error: `${label}: canonical file became a symlink while it was being read` };
    if (!after || after.kind !== "file"
      || snapshot.size === undefined || snapshot.mtimeMs === undefined || snapshot.ctimeMs === undefined
      || after.dev !== snapshot.dev || after.ino !== snapshot.ino
      || after.size !== snapshot.size || after.mtimeMs !== snapshot.mtimeMs || after.ctimeMs !== snapshot.ctimeMs) {
      return { ok: false, error: `${label}: canonical file changed while it was being read` };
    }
    if (!pinnedRoot.isStable()) return { ok: false, error: `${label}: project root changed after read` };
    return {
      ok: true,
      value: {
        path,
        relative_path: relativePath,
        bytes: Buffer.from(snapshot.bytes),
        dev: snapshot.dev,
        ino: snapshot.ino,
      },
    };
  } catch (error) {
    return { ok: false, error: `${label}: ${error instanceof Error ? error.message : String(error)}` };
  }
}


type NormalizedEvidence = ConformanceEvidence & { recorded_at: string; [NORMALIZATION_REJECTION]?: string };
type NormalizedGate = QualityGateResult & { [NORMALIZATION_REJECTION]?: string };
type NormalizedInput = EvaluateImplementationConformanceInput & { [NORMALIZATION_FINDINGS]?: readonly NormalizationFinding[] };
interface CtoTypedEvidenceEntry {
  evidence_id: string;
  kind: ConformanceEvidenceKind;
  subject_id: string;
  requirement_id: string | null;
  handoff_digest: string;
  execution_claim_id: string;
  review_verdict?: "pass" | "fail";
  test?: { evidence_ref: CompletionArtifactRef; test_kind: ExecutedTestEvidence["test_kind"]; status: "pass" | "fail"; executed_at: string };
  intent_message?: string;
  recorded_at: string;
}


interface CtoTypedQualityGate {
  gate_id: string;
  source: QualityGateResult["source"];
  status: QualityGateResult["status"];
  evidence_refs: CompletionArtifactRef[];
  findings: ConformanceFinding[];
  evaluated_at?: string;
}

/** Canonical, bounded UTC timestamps accepted in persisted evidence envelopes. */
export function isBoundedIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact execution authority binding shared by dispatch, close, and terminal replay. */
export function ctoMappingExecutionMatchesWave(
  execution: unknown,
  wave: unknown,
  ctoRunId: string,
  expectedSliceIds?: readonly string[],
  authoritativeIdentities?: readonly unknown[],
): boolean {
  if (!isSafeCtoRunId(ctoRunId) || !isRecord(execution) || !isRecord(wave)) return false;
  const identity = isRecord(wave.work_identity) ? wave.work_identity : null;
  const waveId = wave.id;
  const sourceId = wave.source_id;
  const capabilityId = execution.capability_id;
  const capabilityEpoch = execution.capability_epoch;
  const identityKeys = [
    "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id",
    "stage_cursor", "capability_id", "capability_epoch", "slot_id", "task_id",
    "dispatch_id", "attempt", "worker_id",
  ] as const;
  const validIdentity = (candidate: unknown): candidate is Record<string, unknown> => {
    if (!isRecord(candidate)
      || identityKeys.some((key) => !(key in candidate))
      || identityKeys.some((key) => key !== "attempt" && typeof candidate[key] !== "string")
      || !Number.isSafeInteger(candidate.attempt)
      || Number(candidate.attempt) < 0) return false;
    return true;
  };
  const sameIdentity = (left: Record<string, unknown>, right: Record<string, unknown>): boolean =>
    identityKeys.every((key) => left[key] === right[key]);
  if (execution.choice !== "cto"
    || wave.source !== "specification-execution"
    || (wave.status !== "active" && wave.status !== "done")
    || typeof waveId !== "string" || !isSafeCtoExecutionId(waveId)
    || typeof sourceId !== "string" || !isSafeCtoExecutionId(sourceId)
    || execution.wave_id !== waveId
    || execution.source_id !== sourceId
    || typeof capabilityId !== "string" || capabilityId.length === 0
    || typeof capabilityEpoch !== "string" || capabilityEpoch.length === 0
    || !validIdentity(identity)
    || identity.run_id !== ctoRunId
    || identity.wave_id !== waveId
    || identity.stage_id !== "execution"
    || identity.stage_cursor !== "execution"
    || identity.capability_id !== capabilityId
    || identity.capability_epoch !== capabilityEpoch
    || typeof identity.slice_id !== "string") return false;
  const waveSlices = Array.isArray(wave.slice_ids) ? wave.slice_ids : null;
  if (!waveSlices || !waveSlices.every((sliceId): sliceId is string => typeof sliceId === "string") || !waveSlices.includes(identity.slice_id)) return false;
  if (expectedSliceIds !== undefined) {
    const expectedSet = new Set(expectedSliceIds);
    const actualSet = new Set(waveSlices);
    if (expectedSet.size !== expectedSliceIds.length || actualSet.size !== waveSlices.length
      || expectedSet.size !== actualSet.size || [...expectedSet].some((sliceId) => !actualSet.has(sliceId))) return false;
  }
  if (authoritativeIdentities === undefined) return true;
  const bySlice = new Map<string, Record<string, unknown>>();
  for (const candidate of authoritativeIdentities) {
    if (!validIdentity(candidate) || typeof candidate.slice_id !== "string" || bySlice.has(candidate.slice_id)) return false;
    bySlice.set(candidate.slice_id, candidate);
  }
  if (expectedSliceIds === undefined || bySlice.size !== waveSlices.length || bySlice.size !== expectedSliceIds.length) return false;
  for (const sliceId of waveSlices) {
    const expected = bySlice.get(sliceId);
    if (!expected || expected.run_id !== ctoRunId || expected.wave_id !== waveId
      || expected.stage_id !== "execution" || expected.stage_cursor !== "execution"
      || expected.capability_id !== capabilityId || expected.capability_epoch !== capabilityEpoch) return false;
  }
  const authoritativeWaveIdentity = bySlice.get(identity.slice_id);
  return authoritativeWaveIdentity !== undefined && sameIdentity(identity, authoritativeWaveIdentity);
}
function finding(code: string, subjectId: string | null, message: string, evidenceRefs: string[] = []): ConformanceFinding {
  return { code, subject_id: subjectId, message, evidence_refs: evidenceRefs };
}

function artifactIds(evidence: readonly ConformanceEvidence[]): string[] {
  return evidence.map((item) => item.artifact.artifact_id);
}

function compareCanonical(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function cloneArtifact(artifact: CompletionArtifactRef): CompletionArtifactRef {
  return { ...artifact };
}

function cloneTest(test: ExecutedTestEvidence): ExecutedTestEvidence {
  return { ...test, evidence_ref: cloneArtifact(test.evidence_ref) };
}

function cloneGate(gate: QualityGateResult): QualityGateResult {
  return {
    ...gate,
    evidence_refs: gate.evidence_refs.map(cloneArtifact),
    findings: gate.findings.map((item) => ({ ...item, evidence_refs: [...item.evidence_refs] })),
  };
}

function artifactIssues(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} must be an artifact reference object`];
  const issues: string[] = [];
  if (!isCtoSpecificationSafeId(value.artifact_id)) issues.push(`${label}.artifact_id is not a safe bounded identifier`);
  if (typeof value.path !== "string" || value.path.length === 0) issues.push(`${label}.path is missing`);
  else if (Buffer.byteLength(value.path, "utf8") > MAX_CONFORMANCE_FIELD_BYTES || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.path)) issues.push(`${label}.path exceeds the bounded line-inert text limit`);
  if (!isSha256Hex(value.sha256)) issues.push(`${label}.sha256 is not a SHA-256 digest`);
  if (value.schema_status !== "met" && value.schema_status !== "failed") issues.push(`${label}.schema_status is invalid`);
  if (value.quality_gate_status !== "met" && value.quality_gate_status !== "pending" && value.quality_gate_status !== "failed") {
    issues.push(`${label}.quality_gate_status is invalid`);
  }
  return issues;
}

function evidenceIssues(value: unknown): string[] {
  if (!isRecord(value)) return ["evidence submission must be an object"];
  const issues: string[] = [];
  if (!isCtoSpecificationSafeId(value.evidence_id)) issues.push("evidence_id is not a safe bounded identifier");
  if (!EVIDENCE_KINDS.includes(String(value.kind))) issues.push(`kind '${String(value.kind)}' is unsupported`);
  if (!isCtoSpecificationSafeId(value.subject_id)) issues.push("subject_id is not a safe bounded identifier");
  if (value.requirement_id !== null && !isCtoSpecificationSafeId(value.requirement_id)) {
    issues.push("requirement_id must be a safe bounded identifier or null");
  }
  if (!isSha256Hex(value.handoff_digest)) issues.push("handoff_digest is not a SHA-256 digest");
  if (!isCtoSpecificationSafeId(value.execution_claim_id)) issues.push("execution_claim_id is not a safe bounded identifier");
  issues.push(...artifactIssues(value.artifact, "artifact"));
  if (value.kind === "review" && value.review_verdict !== "pass" && value.review_verdict !== "fail") issues.push("review evidence has no pass/fail verdict");
  if (value.kind === "executed_test") {
    if (!isRecord(value.test)) issues.push("executed_test evidence has no test record");
    else {
      issues.push(...artifactIssues(value.test.evidence_ref, "test.evidence_ref"));
      if (!TEST_KINDS.includes(String(value.test.test_kind))) issues.push("test.test_kind is invalid");
      if (value.test.status !== "pass" && value.test.status !== "fail") issues.push("test.status is invalid");
      if (typeof value.test.executed_at !== "string" || value.test.executed_at.length === 0) issues.push("test.executed_at is missing");
    }
  }
  if (value.kind === "intent_conflict" && (typeof value.intent_message !== "string" || value.intent_message.trim().length === 0)) {
    issues.push("intent_conflict evidence has no conflict description");
  }
  return issues;
}

const CONFORMANCE_INPUT_KEYS = [
  "project_root", "binding", "mapping", "handoff", "claim", "profile_hash", "workspace",
  "active_owner_kind", "active_owner_run_id", "allowed_artifact_paths", "handoffs", "claims",
  "evidence", "quality_gates", "evaluated_at", "feature_id", "run_key",
] as const;
const CTO_MAPPING_KEYS = [
  "schema_version", "mapping_id", "mapping_version", "mapping_hash", "feature_ids", "created_at",
  "updated_at", "cto_run_id", "selections", "execution_choice", "execution", "handoff_bindings",
  "task_to_slice", "shared_contracts", "parallelization", "checkpoint_ref", "status",
] as const;
const CTO_SELECTION_KEYS = ["feature_id", "run_key"] as const;
const CTO_HANDOFF_BINDING_KEYS = ["feature_id", "handoff_id", "handoff_digest", "artifact_versions"] as const;
const CTO_ARTIFACT_VERSION_KEYS = ["artifact_id", "kind", "version", "sha256"] as const;
const CTO_TASK_KEYS = ["feature_id", "task_id", "team_id", "slice_id", "requirement_ids", "verification_ids", "evidence_refs", "depends_on"] as const;
const CTO_CONTRACT_KEYS = ["contract_id", "contract", "owner", "task_ids", "order", "reason", "requires_serialization"] as const;
const CTO_PARALLELIZATION_KEYS = ["slice_id", "decision", "reason", "worktree", "depends_on_slice_ids", "shared_contract_ids"] as const;
const CTO_EXECUTION_KEYS = ["choice", "wave_id", "source_id", "capability_id", "capability_epoch"] as const;
function qualityGateIssues(value: unknown): string[] {
  if (!isRecord(value)) return ["quality gate must be an object"];
  const issues: string[] = [];
  if (!isCtoSpecificationSafeId(value.gate_id)) issues.push("gate_id is not a safe bounded identifier");
  if (value.source !== "project_constitution" && value.source !== "execution_profile") issues.push("source is invalid");
  if (value.status !== "pass" && value.status !== "fail") issues.push("status is invalid");

  if (!Array.isArray(value.evidence_refs)) issues.push("evidence_refs must be an array");
  else {
    if (value.evidence_refs.length > MAX_CONFORMANCE_ARTIFACT_REFS_PER_ENTRY) issues.push(`evidence_refs exceeds ${MAX_CONFORMANCE_ARTIFACT_REFS_PER_ENTRY} references`);
    value.evidence_refs.forEach((artifact, index) => issues.push(...artifactIssues(artifact, `evidence_refs[${index}]`)));
  }
  if (!Array.isArray(value.findings)) issues.push("findings must be an array");
  else {
    if (value.findings.length > MAX_CONFORMANCE_FINDINGS_PER_GATE) issues.push(`findings exceeds ${MAX_CONFORMANCE_FINDINGS_PER_GATE} findings`);
    value.findings.forEach((item, index) => {
      if (!isRecord(item) || !isCtoSpecificationSafeId(item.code) || (item.subject_id !== null && !isCtoSpecificationSafeId(item.subject_id))
        || typeof item.message !== "string" || item.message.trim().length === 0 || Buffer.byteLength(typeof item.message === "string" ? item.message : "", "utf8") > MAX_CONFORMANCE_FIELD_BYTES || !Array.isArray(item.evidence_refs)
        || (Array.isArray(item.evidence_refs) && item.evidence_refs.length > MAX_CONFORMANCE_FINDING_REFS)
        || (Array.isArray(item.evidence_refs) && item.evidence_refs.some((ref) => !isCtoSpecificationSafeId(ref)))) issues.push(`findings[${index}] is invalid`);
    });
  }
  return issues;
}

const CONFORMANCE_EVIDENCE_KEYS = ["evidence_id", "kind", "subject_id", "requirement_id", "handoff_digest", "execution_claim_id", "artifact", "review_verdict", "test", "intent_message", "recorded_at"] as const;
const CONFORMANCE_ARTIFACT_KEYS = ["artifact_id", "path", "sha256", "schema_status", "quality_gate_status"] as const;
const CONFORMANCE_TEST_KEYS = ["test_kind", "status", "executed_at", "evidence_ref"] as const;
const CONFORMANCE_GATE_KEYS = ["gate_id", "source", "status", "evidence_refs", "findings", "evaluated_at"] as const;
const CONFORMANCE_FINDING_KEYS = ["code", "subject_id", "message", "evidence_refs"] as const;

function conformanceId(value: unknown, label: string, issues: string[]): void {
  if (typeof value !== "string" || !isCtoSpecificationSafeId(value)) issues.push(`${label} must be a safe bounded identifier`);
}
function conformanceText(value: unknown, label: string, issues: string[], required = false): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || (required && value.trim().length === 0)) {
    issues.push(`${label} must be bounded line-inert text`);
    return;
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CONFORMANCE_FIELD_BYTES || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) issues.push(`${label} exceeds the bounded line-inert text limit`);
}
function conformanceKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${label}.${key} is not allowed`);
}

function scanConformanceInputGraph(input: unknown, add: (message: string) => void): void {
  const stack: Array<{ value: unknown; path: string; depth: number; leave?: object }> = [{ value: input, path: "$", depth: 0 }];
  const active = new Set<object>();
  let nodes = 0;
  let aggregateBytes = 0;
  let work = 0;
  while (stack.length > 0 && work <= MAX_CONFORMANCE_INPUT_WORK && nodes <= MAX_CONFORMANCE_INPUT_NODES) {
    const current = stack.pop()!;
    if (current.leave) {
      active.delete(current.leave);
      continue;
    }
    work += 1;
    nodes += 1;
    if (work > MAX_CONFORMANCE_INPUT_WORK) {
      add(`$ exceeds the ${MAX_CONFORMANCE_INPUT_WORK}-operation conformance input work budget`);
      return;
    }
    if (nodes > MAX_CONFORMANCE_INPUT_NODES) {
      add(`$ exceeds the ${MAX_CONFORMANCE_INPUT_NODES}-node conformance input budget`);
      return;
    }
    if (current.depth > MAX_CONFORMANCE_INPUT_DEPTH) {
      add(`${current.path} exceeds the ${MAX_CONFORMANCE_INPUT_DEPTH}-level conformance input nesting limit`);
      return;
    }
    if (typeof current.value === "string") {
      const bytes = Buffer.byteLength(current.value, "utf8");
      aggregateBytes += bytes;
      if (bytes > MAX_CONFORMANCE_INPUT_STRING_BYTES) add(`${current.path} exceeds the ${MAX_CONFORMANCE_INPUT_STRING_BYTES}-byte conformance input string limit`);
      if (aggregateBytes > MAX_CONFORMANCE_AGGREGATE_BYTES) add(`$ exceeds the ${MAX_CONFORMANCE_AGGREGATE_BYTES}-byte aggregate conformance input limit`);
      continue;
    }
    if (current.value === null || typeof current.value === "boolean" || typeof current.value === "number") {
      if (typeof current.value === "number" && !Number.isFinite(current.value)) add(`${current.path} must be a finite number`);
      continue;
    }
    if (typeof current.value !== "object") {
      add(`${current.path} contains an unsupported value`);
      continue;
    }
    if (active.has(current.value)) {
      add(`${current.path} contains a cyclic object`);
      return;
    }
    active.add(current.value);
    let keys: (string | symbol)[];
    try {
      const prototype = Object.getPrototypeOf(current.value);
      if (Array.isArray(current.value)) {
        if (prototype !== Array.prototype && prototype !== null) {
          add(`${current.path} must use a plain array prototype`);
          return;
        }
        if (current.value.length > MAX_CONFORMANCE_INPUT_ARRAY) {
          add(`${current.path} exceeds the ${MAX_CONFORMANCE_INPUT_ARRAY}-item conformance input array limit`);
          return;
        }
      } else if (prototype !== Object.prototype && prototype !== null) {
        add(`${current.path} must use a plain object prototype`);
        return;
      }
      keys = Reflect.ownKeys(current.value);
    } catch {
      add(`${current.path} could not be inspected safely`);
      return;
    }
    const keyCount = Array.isArray(current.value) ? Math.max(0, keys.length - 1) : keys.length;
    if (keyCount > MAX_CONFORMANCE_INPUT_KEYS) {
      add(`${current.path} exceeds the ${MAX_CONFORMANCE_INPUT_KEYS}-key conformance input limit`);
      return;
    }
    stack.push({ value: null, path: current.path, depth: current.depth, leave: current.value });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      if (typeof key !== "string") {
        if (key !== NORMALIZATION_FINDINGS && key !== NORMALIZATION_REJECTION) {
          return;
        }
        continue;
      }
      if (Array.isArray(current.value) && key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)) {
        add(`${current.path} contains a non-index array key '${key}'`);
        return;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor || !("value" in descriptor)) {
        add(`${current.path}.${key} must be a data property`);
        return;
      }
      const keyBytes = Buffer.byteLength(key, "utf8");
      aggregateBytes += keyBytes;
      if (keyBytes > MAX_CONFORMANCE_INPUT_STRING_BYTES) add(`${current.path}.${key} exceeds the conformance input key limit`);
      if (aggregateBytes > MAX_CONFORMANCE_AGGREGATE_BYTES) add(`$ exceeds the ${MAX_CONFORMANCE_AGGREGATE_BYTES}-byte aggregate conformance input limit`);
      if (key === "length") continue;
      stack.push({ value: descriptor.value, path: `${current.path}.${key}`, depth: current.depth + 1 });
      work += 1;
      if (work > MAX_CONFORMANCE_INPUT_WORK) {
        add(`$ exceeds the ${MAX_CONFORMANCE_INPUT_WORK}-operation conformance input work budget`);
        return;
      }
    }
  }
}
const CTO_CLAIM_KEYS = ["feature_id", "claim_id", "handoff_digest", "owner_kind", "owner_run_id", "status", "admission_binding"] as const;
const CTO_ADMISSION_BINDING_KEYS = [
  "mapping_record_path", "mapping_record_digest", "mapping_id", "mapping_hash", "mapping_version",
  "confirmation_state_revision", "feature_state_revision", "confirmation_state_digest",
  "confirmation_authorization_digest", "confirmation_ledger_digest", "checkpoint_ref", "trusted_answer_ref",
  "stage_id", "policy_hash", "wave_id", "capability_id", "capability_epoch",
] as const;

function strictConformanceKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, add: (message: string) => void): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) add(`${label}.${key} is not allowed`);
}

function conformanceDomainArray(
  owner: Record<string, unknown>,
  key: string,
  label: string,
  maximum: number,
  add: (message: string) => void,
): unknown[] | null {
  if (!Object.hasOwn(owner, key)) return null;
  const value = owner[key];
  if (!Array.isArray(value)) {
    add(`${label} must be an array`);
    return null;
  }
  if (value.length > maximum) add(`${label} exceeds ${maximum} entries`);
  return value;
}

function conformanceDomainRecords(
  owner: Record<string, unknown>,
  key: string,
  label: string,
  maximum: number,
  allowed: readonly string[],
  add: (message: string) => void,
): Record<string, unknown>[] {
  const values = conformanceDomainArray(owner, key, label, maximum, add) ?? [];
  const records: Record<string, unknown>[] = [];
  for (let index = 0; index < Math.min(values.length, maximum); index += 1) {
    const value = values[index];
    if (!isRecord(value)) {
      add(`${label}[${index}] must be an object`);
      continue;
    }
    strictConformanceKeys(value, allowed, `${label}[${index}]`, add);
    records.push(value);
  }
  return records;
}

function conformanceInputDomainIssues(input: Record<string, unknown>, add: (message: string) => void): void {
  strictConformanceKeys(input, CONFORMANCE_INPUT_KEYS, "input", add);
  const mapping = isRecord(input.mapping) ? input.mapping : null;
  if (Object.hasOwn(input, "mapping") && !mapping) add("mapping must be an object");
  if (mapping) {
    strictConformanceKeys(mapping, CTO_MAPPING_KEYS, "mapping", add);
    conformanceDomainArray(mapping, "feature_ids", "mapping.feature_ids", MAX_CTO_MAPPING_FEATURES, add);
    conformanceDomainRecords(mapping, "selections", "mapping.selections", MAX_CTO_MAPPING_FEATURES, CTO_SELECTION_KEYS, add);
    const bindings = conformanceDomainRecords(mapping, "handoff_bindings", "mapping.handoff_bindings", MAX_CTO_MAPPING_FEATURES, CTO_HANDOFF_BINDING_KEYS, add);
    const tasks = conformanceDomainRecords(mapping, "task_to_slice", "mapping.task_to_slice", MAX_CTO_MAPPING_TASKS, CTO_TASK_KEYS, add);
    const contracts = conformanceDomainRecords(mapping, "shared_contracts", "mapping.shared_contracts", MAX_CTO_MAPPING_CONTRACTS, CTO_CONTRACT_KEYS, add);
    if (Object.hasOwn(mapping, "execution") && !isRecord(mapping.execution)) add("mapping.execution must be an object");
    if (isRecord(mapping.execution)) strictConformanceKeys(mapping.execution, CTO_EXECUTION_KEYS, "mapping.execution", add);
    for (const [index, binding] of bindings.entries()) {
      conformanceDomainRecords(binding, "artifact_versions", `mapping.handoff_bindings[${index}].artifact_versions`, MAX_HANDOFF_ARRAY_ITEMS, CTO_ARTIFACT_VERSION_KEYS, add);
    }
    for (const [index, task] of tasks.entries()) {
      for (const key of ["requirement_ids", "verification_ids", "evidence_refs", "depends_on"]) {
        conformanceDomainArray(task, key, `mapping.task_to_slice[${index}].${key}`, MAX_HANDOFF_ARRAY_ITEMS, add);
      }
    }
    for (const [index, contract] of contracts.entries()) {
      conformanceDomainArray(contract, "task_ids", `mapping.shared_contracts[${index}].task_ids`, MAX_HANDOFF_ARRAY_ITEMS, add);
    }
  }
  const handoffs = conformanceDomainArray(input, "handoffs", "handoffs", MAX_CONFORMANCE_HANDOFFS, add);
  if (handoffs) {
    for (let index = 0; index < Math.min(handoffs.length, MAX_CONFORMANCE_HANDOFFS); index += 1) {
      const item = handoffs[index];
      if (!isRecord(item)) {
        add(`handoffs[${index}] must be an object`);
        continue;
      }
      strictConformanceKeys(item, ["feature_id", "run_key", "handoff", "quality_gates"], `handoffs[${index}]`, add);
      if (Object.hasOwn(item, "handoff") && !isRecord(item.handoff)) add(`handoffs[${index}].handoff must be an object`);
      conformanceDomainArray(item, "quality_gates", `handoffs[${index}].quality_gates`, MAX_CONFORMANCE_QUALITY_GATES, add);
    }
  }
  const claims = conformanceDomainArray(input, "claims", "claims", MAX_CONFORMANCE_CLAIMS, add);
  if (claims) {
    for (let index = 0; index < Math.min(claims.length, MAX_CONFORMANCE_CLAIMS); index += 1) {
      const item = claims[index];
      if (!isRecord(item)) {
        add(`claims[${index}] must be an object`);
        continue;
      }
      strictConformanceKeys(item, CTO_CLAIM_KEYS, `claims[${index}]`, add);
      if (Object.hasOwn(item, "admission_binding") && !isRecord(item.admission_binding)) add(`claims[${index}].admission_binding must be an object`);
      if (isRecord(item.admission_binding)) strictConformanceKeys(item.admission_binding, CTO_ADMISSION_BINDING_KEYS, `claims[${index}].admission_binding`, add);
    }
  }
  if (Object.hasOwn(input, "handoff") && !isRecord(input.handoff)) add("handoff must be an object");
}


/** Shared direct-call boundary; mounted Zod applies the same ceilings. */
export function conformanceInputBoundaryIssues(input: unknown): string[] {
  if (!isRecord(input)) return ["conformance input must be an object"];
  const issues: string[] = [];
  let aggregateBytes = 0;
  const add = (message: string): void => { if (issues.length < 128) issues.push(message); };
  const addText = (value: unknown, label: string, required = false): void => {
    conformanceText(value, label, issues, required);
    if (typeof value === "string") aggregateBytes += Buffer.byteLength(value, "utf8");
  };
  scanConformanceInputGraph(input, add);
  conformanceInputDomainIssues(input, add);
  if (input.feature_id !== undefined) conformanceId(input.feature_id, "feature_id", issues);
  addText(input.run_key, "run_key");
  addText(input.evaluated_at, "evaluated_at");
  const artifact = (value: unknown, label: string, depth = 2): void => {
    if (depth > MAX_CONFORMANCE_NESTING_DEPTH) { add(`${label} exceeds maximum nesting depth ${MAX_CONFORMANCE_NESTING_DEPTH}`); return; }
    if (!isRecord(value)) { add(`${label} must be an object`); return; }
    conformanceKeys(value, CONFORMANCE_ARTIFACT_KEYS, label, issues);
    conformanceId(value.artifact_id, `${label}.artifact_id`, issues);
    addText(value.path, `${label}.path`, true);
    addText(value.sha256, `${label}.sha256`, true);
  };
  const evidence = input.evidence;
  if (!Array.isArray(evidence)) add("evidence must be an array");
  else {
    if (evidence.length === 0) add("evidence must not be empty");
    if (evidence.length > MAX_CONFORMANCE_EVIDENCE_ENTRIES) add(`evidence exceeds ${MAX_CONFORMANCE_EVIDENCE_ENTRIES} entries`);
    for (let index = 0; index < Math.min(evidence.length, MAX_CONFORMANCE_EVIDENCE_ENTRIES); index += 1) {
      const item = evidence[index];
      const label = `evidence[${index}]`;
      if (!isRecord(item)) { add(`${label} must be an object`); continue; }
      conformanceKeys(item, CONFORMANCE_EVIDENCE_KEYS, label, issues);
      conformanceId(item.evidence_id, `${label}.evidence_id`, issues);
      if (item.requirement_id !== null) conformanceId(item.requirement_id, `${label}.requirement_id`, issues);
      conformanceId(item.subject_id, `${label}.subject_id`, issues);
      conformanceId(item.execution_claim_id, `${label}.execution_claim_id`, issues);
      addText(item.intent_message, `${label}.intent_message`);
      addText(item.recorded_at, `${label}.recorded_at`);
      artifact(item.artifact, `${label}.artifact`);
      if (isRecord(item.test)) {
        conformanceKeys(item.test, CONFORMANCE_TEST_KEYS, `${label}.test`, issues);
        addText(item.test.executed_at, `${label}.test.executed_at`, true);
        artifact(item.test.evidence_ref, `${label}.test.evidence_ref`, 4);
      }
    }
  }
  const qualityGates = input.quality_gates;
  if (qualityGates !== undefined && !Array.isArray(qualityGates)) add("quality_gates must be an array");
  else if (Array.isArray(qualityGates)) {
    if (qualityGates.length > MAX_CONFORMANCE_QUALITY_GATES) add(`quality_gates exceeds ${MAX_CONFORMANCE_QUALITY_GATES} entries`);
    for (let index = 0; index < Math.min(qualityGates.length, MAX_CONFORMANCE_QUALITY_GATES); index += 1) {
      const gate = qualityGates[index];
      const label = `quality_gates[${index}]`;
      if (!isRecord(gate)) { add(`${label} must be an object`); continue; }
      conformanceKeys(gate, CONFORMANCE_GATE_KEYS, label, issues);
      conformanceId(gate.gate_id, `${label}.gate_id`, issues);
      addText(gate.evaluated_at, `${label}.evaluated_at`);
      if (!Array.isArray(gate.evidence_refs)) add(`${label}.evidence_refs must be an array`);
      else {
        if (gate.evidence_refs.length > MAX_CONFORMANCE_ARTIFACT_REFS_PER_ENTRY) add(`${label}.evidence_refs exceeds ${MAX_CONFORMANCE_ARTIFACT_REFS_PER_ENTRY} references`);
        for (let refIndex = 0; refIndex < Math.min(gate.evidence_refs.length, MAX_CONFORMANCE_ARTIFACT_REFS_PER_ENTRY); refIndex += 1) artifact(gate.evidence_refs[refIndex], `${label}.evidence_refs[${refIndex}]`, 3);
      }
      if (!Array.isArray(gate.findings)) add(`${label}.findings must be an array`);
      else {
        if (gate.findings.length > MAX_CONFORMANCE_FINDINGS_PER_GATE) add(`${label}.findings exceeds ${MAX_CONFORMANCE_FINDINGS_PER_GATE} findings`);
        for (let findingIndex = 0; findingIndex < Math.min(gate.findings.length, MAX_CONFORMANCE_FINDINGS_PER_GATE); findingIndex += 1) {
          const entry = gate.findings[findingIndex];
          const findingLabel = `${label}.findings[${findingIndex}]`;
          if (!isRecord(entry)) { add(`${findingLabel} must be an object`); continue; }
          conformanceKeys(entry, CONFORMANCE_FINDING_KEYS, findingLabel, issues);
          conformanceId(entry.code, `${findingLabel}.code`, issues);
          if (entry.subject_id !== null) conformanceId(entry.subject_id, `${findingLabel}.subject_id`, issues);
          if (!Array.isArray(entry.evidence_refs)) add(`${findingLabel}.evidence_refs must be an array`);
          else {
            if (entry.evidence_refs.length > MAX_CONFORMANCE_FINDING_REFS) add(`${findingLabel}.evidence_refs exceeds ${MAX_CONFORMANCE_FINDING_REFS} references`);
            for (let refIndex = 0; refIndex < Math.min(entry.evidence_refs.length, MAX_CONFORMANCE_FINDING_REFS); refIndex += 1) conformanceId(entry.evidence_refs[refIndex], `${findingLabel}.evidence_refs[${refIndex}]`, issues);
          }
        }
      }
    }
  }
  if (aggregateBytes > MAX_CONFORMANCE_AGGREGATE_BYTES) add(`conformance aggregate text exceeds ${MAX_CONFORMANCE_AGGREGATE_BYTES} bytes`);
  return [...new Set(issues)].slice(0, 128);
}
function boundedImplementationConformanceResult(
  input: EvaluateImplementationConformanceInput,
  issues: readonly string[],
): ImplementationConformanceResult {
  const raw: Record<string, unknown> = isRecord(input) ? input : {};
  const handoff = isRecord(raw.handoff) ? raw.handoff : {};
  const claim = isRecord(raw.claim) ? raw.claim : {};
  const featureId = typeof handoff.feature_id === "string" ? handoff.feature_id : "";
  const handoffId = typeof handoff.handoff_id === "string" ? handoff.handoff_id : "";
  const handoffDigest = typeof handoff.handoff_digest === "string" ? handoff.handoff_digest : "";
  const claimId = typeof claim.claim_id === "string" ? claim.claim_id : "";
  const ownerKind = claim.owner_kind === "cto" ? "cto" : "do_work";
  const runId = typeof claim.owner_run_id === "string" ? claim.owner_run_id : "";
  const profileHash = typeof raw.profile_hash === "string" ? raw.profile_hash : "";
  const evaluatedAt = typeof raw.evaluated_at === "string" ? raw.evaluated_at : new Date().toISOString();
  const blockingFindings = issues.map((message) => finding(CONFORMANCE_FAILED, featureId || null, message));
  const conformanceId = `conformance-${digestOf({ featureId, handoffId, claimId, profileHash, issues })}`;
  return {
    schema_version: "1.0",
    conformance_id: conformanceId,
    matrix_digest: digestOf({ conformanceId, blockingFindings }),
    feature_id: featureId,
    handoff_id: handoffId,
    handoff_digest: handoffDigest,
    execution_claim_id: claimId,
    execution_owner: ownerKind,
    execution_run_id: runId,
    profile_hash: profileHash,
    evaluated_at: evaluatedAt,
    entries: [],
    quality_gate_results: [],
    overall_status: "blocked",
    blocking_findings: blockingFindings,
    next_action: "repair_implementation",
  };
}
function deriveSubjects(handoff: ImplementationHandoff): Subject[] {
  const observableRequirements = new Set<string>();
  const observableAcceptances = new Set<string>();
  for (const verification of handoff.verification) {
    if (!verification.observable_behavior) continue;
    for (const id of verification.requirement_ids) observableRequirements.add(id);
    for (const id of verification.acceptance_ids) observableAcceptances.add(id);
  }
  const subjects: Subject[] = [];
  const seen = new Set<string>();
  for (const requirement of handoff.requirements) {
    const requirementKey = `requirement:${requirement.requirement_id}`;
    if (!seen.has(requirementKey)) {
      seen.add(requirementKey);
      subjects.push({ subject_kind: "requirement", subject_id: requirement.requirement_id, requirement_id: requirement.requirement_id, observable_behavior: observableRequirements.has(requirement.requirement_id) });
    }
    for (const acceptanceId of requirement.acceptance_ids) {
      const acceptanceKey = `acceptance_scenario:${acceptanceId}`;
      if (seen.has(acceptanceKey)) continue;
      seen.add(acceptanceKey);
      subjects.push({ subject_kind: "acceptance_scenario", subject_id: acceptanceId, requirement_id: requirement.requirement_id, observable_behavior: observableAcceptances.has(acceptanceId) });
    }
  }
  return subjects;
}

function rejectionFor(evidence: ConformanceEvidence, subject: Subject, handoff: ImplementationHandoff, claim: ExecutionClaim): string | null {
  if (evidence.requirement_id !== subject.requirement_id) return `Evidence '${evidence.evidence_id}' names requirement '${evidence.requirement_id ?? "null"}' instead of approved owner '${subject.requirement_id}'.`;
  if (evidence.handoff_digest !== handoff.handoff_digest) return `Evidence '${evidence.evidence_id}' is stale or foreign: handoff digest '${evidence.handoff_digest}' does not match '${handoff.handoff_digest}'.`;
  if (evidence.execution_claim_id !== claim.claim_id) return `Evidence '${evidence.evidence_id}' belongs to foreign execution claim '${evidence.execution_claim_id}', not active claim '${claim.claim_id}'.`;
  return (evidence as NormalizedEvidence)[NORMALIZATION_REJECTION] ?? null;
}

function remediationForEvidence(kind: ConformanceEvidenceKind): Remediation {
  if (kind === "review") return "repeat_review";
  if (kind === "executed_test") return "repeat_tests";
  return "repair_implementation";
}

function closureEntry(subject: Subject, assessments: readonly EvidenceAssessment[]): { entry: RequirementClosureEntry; remediations: Set<Remediation> } {
  const remediations = new Set<Remediation>();
  const rowFindings: ConformanceFinding[] = [];
  const rejected = assessments.filter((item) => item.rejection !== null);
  for (const item of rejected) {
    rowFindings.push(finding(CONFORMANCE_FAILED, subject.subject_id, item.rejection!, [item.evidence.artifact.artifact_id]));
    remediations.add(remediationForEvidence(item.evidence.kind));
  }
  const current = assessments.filter((item) => item.rejection === null).map((item) => item.evidence).sort(compareCanonical);
  const implementation = current.filter((item) => item.kind === "implementation");
  const reviews = current.filter((item) => item.kind === "review");
  const tests = current.filter((item) => item.kind === "executed_test");
  const intentConflicts = current.filter((item) => item.kind === "intent_conflict");
  if (intentConflicts.length === 0 && implementation.length === 0) {
    rowFindings.push(finding(CONFORMANCE_FAILED, subject.subject_id, `Missing current implementation evidence for '${subject.subject_id}'.`));
    remediations.add("repair_implementation");
  }
  const reviewPasses = reviews.filter((item) => item.review_verdict === "pass");
  const reviewFailures = reviews.filter((item) => item.review_verdict === "fail");
  let reviewVerdict: RequirementClosureEntry["review_verdict"] = "missing";
  if (reviewFailures.length > 0) reviewVerdict = "fail";
  else if (reviewPasses.length > 0) reviewVerdict = "pass";
  if (intentConflicts.length === 0 && reviews.length === 0) {
    rowFindings.push(finding(CONFORMANCE_FAILED, subject.subject_id, `Missing current passing review evidence for '${subject.subject_id}'.`));
    remediations.add("repeat_review");
  } else if (intentConflicts.length === 0 && reviewPasses.length > 0 && reviewFailures.length > 0) {
    rowFindings.push(finding(CONFORMANCE_FAILED, subject.subject_id, `Contradictory review verdicts were submitted for '${subject.subject_id}'.`, artifactIds(reviews)));
    remediations.add("repeat_review");
  } else if (intentConflicts.length === 0 && reviewFailures.length > 0) {
    rowFindings.push(finding(CONFORMANCE_FAILED, subject.subject_id, `Review failed for '${subject.subject_id}'; repeat review after remediation.`, artifactIds(reviewFailures)));
    remediations.add("repeat_review");
  }
  const testEvidence = tests.map((item) => cloneTest(item.test!)).sort(compareCanonical);
  const passingTests = testEvidence.filter((item) => item.status === "pass");
  const failingTests = testEvidence.filter((item) => item.status === "fail");
  if (intentConflicts.length === 0 && passingTests.length > 0 && failingTests.length > 0) {
    rowFindings.push(finding(CONFORMANCE_FAILED, subject.subject_id, `Contradictory executed-test evidence was submitted for '${subject.subject_id}'.`, tests.map((item) => item.test!.evidence_ref.artifact_id)));
    remediations.add("repeat_tests");
  } else if (intentConflicts.length === 0 && failingTests.length > 0) {
    rowFindings.push(finding(CONFORMANCE_FAILED, subject.subject_id, `Executed tests failed for '${subject.subject_id}'.`, failingTests.map((item) => item.evidence_ref.artifact_id)));
    remediations.add("repeat_tests");
  } else if (intentConflicts.length === 0 && subject.observable_behavior && passingTests.length === 0) {
    rowFindings.push(finding(CONFORMANCE_FAILED, subject.subject_id, `Missing current passing executed-test evidence for observable subject '${subject.subject_id}'.`));
    remediations.add("repeat_tests");
  }
  if (intentConflicts.length > 0) {
    rowFindings.push(finding(INTENT_CHANGED, subject.subject_id, intentConflicts.map((item) => item.intent_message!.trim()).join("; "), artifactIds(intentConflicts)));
    remediations.add("revise_specification");
  }
  const status: RequirementClosureEntry["status"] = intentConflicts.length > 0 ? "changed_intent" : rowFindings.length > 0 ? "blocked" : "pass";
  return {
    entry: {
      entry_id: `closure.${digestOf({ handoff_subject: subject.subject_id, requirement_id: subject.requirement_id, subject_kind: subject.subject_kind })}`,
      ...subject,
      implementation_evidence_refs: implementation.map((item) => cloneArtifact(item.artifact)),
      review_verdict: reviewVerdict,
      review_evidence_refs: reviews.map((item) => cloneArtifact(item.artifact)),
      test_evidence: testEvidence,
      status,
      findings: rowFindings,
    },
    remediations,
  };
}

function nextAction(remediations: ReadonlySet<Remediation>): ConformanceNextAction {
  if (remediations.has("revise_specification")) return "revise_specification";
  for (const action of REMEDIATION_PRECEDENCE) if (remediations.has(action)) return action;
  return "repair_implementation";
}

/** Evaluate a frozen handoff against evidence attributable to its active exclusive claim. */
export function evaluateImplementationConformance(input: EvaluateImplementationConformanceInput): ImplementationConformanceResult {
  const boundaryIssues = conformanceInputBoundaryIssues(input);
  if (boundaryIssues.length > 0) return boundedImplementationConformanceResult(input, boundaryIssues);
  const rawInput: Record<string, unknown> = isRecord(input) ? input as unknown as Record<string, unknown> : {};
  const rawHandoff = rawInput.handoff;
  const rawClaim = rawInput.claim;
  const handoffValidation = validateImplementationHandoff(rawHandoff);
  const claimValidation = validateExecutionClaim(rawClaim);
  const handoff = (isRecord(rawHandoff) ? rawHandoff : {}) as unknown as ImplementationHandoff;
  const claim = (isRecord(rawClaim) ? rawClaim : {}) as unknown as ExecutionClaim;
  const subjects = handoffValidation.ok ? deriveSubjects(handoff) : [];
  const subjectById = new Map(subjects.map((subject) => [subject.subject_id, subject]));
  const assessmentsBySubject = new Map<string, EvidenceAssessment[]>();
  const globalFindings: ConformanceFinding[] = [];
  const globalRemediations = new Set<Remediation>();
  if (!handoffValidation.ok) {
    globalFindings.push(finding(CONFORMANCE_FAILED, typeof handoff.handoff_id === "string" ? handoff.handoff_id : null, `The frozen implementation handoff is invalid: ${handoffValidation.issues.join("; ")}`));
    globalRemediations.add("repair_implementation");
  }
  if (!claimValidation.ok || claim.status !== "active" || claim.handoff_digest !== handoff.handoff_digest) {
    const reasons = claimValidation.ok ? [] : [...claimValidation.issues];
    if (claim.status !== "active") reasons.push(`claim status is '${String(claim.status)}', not 'active'`);
    if (claim.handoff_digest !== handoff.handoff_digest) reasons.push(`claim handoff digest '${String(claim.handoff_digest)}' does not match '${String(handoff.handoff_digest)}'`);
    globalFindings.push(finding(CONFORMANCE_FAILED, typeof claim.claim_id === "string" ? claim.claim_id : null, `Conformance requires the exact active handoff claim: ${reasons.join("; ")}`));
    globalRemediations.add("repair_implementation");
  }
  const profileHash = typeof rawInput.profile_hash === "string" ? rawInput.profile_hash : "";
  if (!isSha256Hex(profileHash)) {
    globalFindings.push(finding(CONFORMANCE_FAILED, null, `Execution profile hash '${profileHash}' is not a SHA-256 binding.`));
    globalRemediations.add("repair_quality_gate");
  }
  for (const item of (input as NormalizedInput)[NORMALIZATION_FINDINGS] ?? []) {
    globalFindings.push(finding(CONFORMANCE_FAILED, item.subject_id, item.message, [...item.evidence_refs]));
    globalRemediations.add(item.remediation);
  }
  const rawEvidence = rawInput.evidence;
  if (!Array.isArray(rawEvidence)) {
    globalFindings.push(finding(CONFORMANCE_FAILED, null, "Conformance evidence must be an array."));
    globalRemediations.add("repair_implementation");
  }
  for (const rawItem of (Array.isArray(rawEvidence) ? [...rawEvidence].sort(compareCanonical) : [])) {
    const issues = evidenceIssues(rawItem);
    const itemRecord = isRecord(rawItem) ? rawItem : {};
    const subjectId = typeof itemRecord.subject_id === "string" ? itemRecord.subject_id : null;
    const subject = subjectId === null ? undefined : subjectById.get(subjectId);
    if (issues.length > 0) {
      const artifactId = isRecord(itemRecord.artifact) && typeof itemRecord.artifact.artifact_id === "string" ? [itemRecord.artifact.artifact_id] : [];
      const malformed = finding(CONFORMANCE_FAILED, subjectId, `Invalid conformance evidence: ${issues.join("; ")}.`, artifactId);
      if (!subject) {
        globalFindings.push(malformed);
        globalRemediations.add("repair_implementation");
      } else {
        const rejected = assessmentsBySubject.get(subject.subject_id) ?? [];
        rejected.push({ evidence: { ...(itemRecord as unknown as ConformanceEvidence), kind: EVIDENCE_KINDS.includes(String(itemRecord.kind)) ? itemRecord.kind as ConformanceEvidenceKind : "implementation", artifact: isRecord(itemRecord.artifact) ? itemRecord.artifact as unknown as CompletionArtifactRef : { artifact_id: "invalid", path: "invalid", sha256: "", schema_status: "failed", quality_gate_status: "failed" } }, rejection: malformed.message });
        assessmentsBySubject.set(subject.subject_id, rejected);
      }
      continue;
    }
    const evidence = rawItem as ConformanceEvidence;
    if (!subject) {
      globalFindings.push(finding(CONFORMANCE_FAILED, evidence.subject_id, `Evidence '${evidence.evidence_id}' targets subject '${evidence.subject_id}', which is not present in the frozen handoff.`, [evidence.artifact.artifact_id]));
      globalRemediations.add("repair_implementation");
      continue;
    }
    const assessments = assessmentsBySubject.get(subject.subject_id) ?? [];
    assessments.push({ evidence, rejection: rejectionFor(evidence, subject, handoff, claim) });
    assessmentsBySubject.set(subject.subject_id, assessments);
  }
  const entries: RequirementClosureEntry[] = [];
  for (const subject of subjects) {
    const evaluated = closureEntry(subject, assessmentsBySubject.get(subject.subject_id) ?? []);
    entries.push(evaluated.entry);
    for (const remediation of evaluated.remediations) globalRemediations.add(remediation);
  }
  const rawQualityGates = rawInput.quality_gates;
  if (!Array.isArray(rawQualityGates)) {
    globalFindings.push(finding(CONFORMANCE_FAILED, null, "Quality-gate results must be an array."));
    globalRemediations.add("repair_quality_gate");
  }
  const qualityGateResults: QualityGateResult[] = [];
  for (const rawGate of (Array.isArray(rawQualityGates) ? [...rawQualityGates].sort(compareCanonical) : [])) {
    const issues = qualityGateIssues(rawGate);
    if (issues.length > 0) {
      const gateId = isRecord(rawGate) && typeof rawGate.gate_id === "string" ? rawGate.gate_id : null;
      globalFindings.push(finding(CONFORMANCE_FAILED, gateId, `Invalid quality-gate result: ${issues.join("; ")}.`));
      globalRemediations.add("repair_quality_gate");
      continue;
    }
    const gate = rawGate as NormalizedGate;
    qualityGateResults.push(cloneGate(gate));
    const rejection = gate[NORMALIZATION_REJECTION];
    if (rejection) {
      globalFindings.push(finding(CONFORMANCE_FAILED, gate.gate_id, rejection, gate.evidence_refs.map((artifact) => artifact.artifact_id)));
      globalRemediations.add("repair_quality_gate");
    }
  }
  if (qualityGateResults.length === 0) {
    globalFindings.push(finding(CONFORMANCE_FAILED, null, "No valid mandatory constitution or execution-profile quality gate result was supplied."));
    globalRemediations.add("repair_quality_gate");
  }
  for (const gate of qualityGateResults) {
    if (gate.status !== "fail") continue;
    globalFindings.push(finding(CONFORMANCE_FAILED, gate.gate_id, `Required quality gate '${gate.gate_id}' failed.`, gate.evidence_refs.map((artifact) => artifact.artifact_id)));
    globalRemediations.add("repair_quality_gate");
  }
  const blockingFindings = [
    ...entries.flatMap((entry) => entry.findings.map((item) => ({ ...item, evidence_refs: [...item.evidence_refs] }))),
    ...globalFindings.map((item) => ({ ...item, evidence_refs: [...item.evidence_refs] })),
  ];
  const hasChangedIntent = entries.some((entry) => entry.status === "changed_intent");
  const overallStatus: ImplementationConformanceResult["overall_status"] = hasChangedIntent ? "changed_intent" : blockingFindings.length > 0 ? "blocked" : "pass";
  const selectedNextAction: ConformanceNextAction = blockingFindings.length === 0 ? "complete_feature" : nextAction(globalRemediations);
  const owner: ExecutionClaimOwnerKind = claim.owner_kind === "cto" ? "cto" : "do_work";
  const matrixContent = {
    schema_version: "1.0" as const,
    feature_id: typeof handoff.feature_id === "string" ? handoff.feature_id : "",
    handoff_id: typeof handoff.handoff_id === "string" ? handoff.handoff_id : "",
    handoff_digest: typeof handoff.handoff_digest === "string" ? handoff.handoff_digest : "",
    execution_claim_id: typeof claim.claim_id === "string" ? claim.claim_id : "",
    execution_owner: owner,
    execution_run_id: typeof claim.owner_run_id === "string" ? claim.owner_run_id : "",
    profile_hash: profileHash,
    entries,
    quality_gate_results: qualityGateResults,
    overall_status: overallStatus,
    blocking_findings: blockingFindings,
    next_action: selectedNextAction,
  };
  const matrixDigest = implementationConformanceMatrixDigest(matrixContent)!;
  return { ...matrixContent, conformance_id: `implementation-conformance.${matrixDigest}`, matrix_digest: matrixDigest, evaluated_at: typeof rawInput.evaluated_at === "string" ? rawInput.evaluated_at : "" };
}

function canonicalProjectRoot(projectRoot: string): string | null {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return null;
  try {
    return pinnedRoot.isStable() ? pinnedRoot.canonical_root : null;
  } finally {
    pinnedRoot.close();
  }
}

type PinnedReferenceNormalizationResult =
  | { ok: true; reference: CompletionArtifactRef; value: unknown; issues: string[] }
  | { ok: false; reference?: CompletionArtifactRef; value?: unknown; issues: string[] };

function normalizeReferencePinned(
  pinnedRoot: PinnedProjectRoot | null,
  authorization: ArtifactReferenceAuthorization,
  reference: CompletionArtifactRef,
  label: string,
  validateSchema: ArtifactSchemaValidator = (artifactId, value) => validateProducedArtifact(artifactId, value),
): PinnedReferenceNormalizationResult {
  const issues: string[] = [];
  if (!pinnedRoot) return { ok: false, issues: [`${label}: canonical project root is unavailable`] };
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    return { ok: false, issues: [`${label}: artifact reference must be an object`] };
  }
  const artifactId = typeof reference.artifact_id === "string" ? reference.artifact_id : "";
  if (!isCtoSpecificationSafeId(artifactId)) {
    issues.push(`${label}: artifact '${String(reference.artifact_id)}' is outside the authorized project artifact store`);
  }
  const artifactsRelative = pinnedRoot.relativePath(authorization.artifacts_dir);
  if (!artifactsRelative || !safePinnedRelativePath(artifactsRelative)) {
    issues.push(`${label}: artifact directory is outside the pinned project root`);
  }
  const expectedRelative = artifactsRelative && safePinnedRelativePath(artifactsRelative)
    ? `${artifactsRelative}/${artifactId}.json`
    : "";
  if (!safePinnedRelativePath(expectedRelative)) {
    issues.push(`${label}: artifact path is not a safe relative path below the canonical project root`);
  }
  const allowed = new Set<string>();
  for (const allowedPath of authorization.allowed_paths) {
    if (!safePinnedRelativePath(allowedPath)) issues.push(`${label}: allowed artifact path '${String(allowedPath)}' is unsafe`);
    else allowed.add(allowedPath);
  }
  if (!safePinnedRelativePath(reference.path)) {
    issues.push(`${label}: artifact '${artifactId}' path '${String(reference.path)}' is unsafe`);
  } else if (reference.path !== expectedRelative) {
    issues.push(`${label}: artifact '${artifactId}' path '${reference.path}' does not match current stored path '${expectedRelative}'`);
  }
  if (!allowed.has(expectedRelative)) {
    issues.push(`${label}: artifact '${artifactId}' path '${expectedRelative}' is not authorized for this execution`);
  }
  if (reference.schema_status !== "met") issues.push(`${label}: artifact '${artifactId}' schema status is '${String(reference.schema_status)}', not 'met'`);
  if (reference.quality_gate_status !== "met") issues.push(`${label}: artifact '${artifactId}' quality-gate status is '${String(reference.quality_gate_status)}', not 'met'`);
  if (expectedRelative.length === 0 || issues.some((issue) => issue.includes("outside the authorized project artifact store"))) {
    return { ok: false, issues };
  }

  const candidate = pinnedRoot.anchorPath(expectedRelative);
  const read = readPinnedCanonicalFile(pinnedRoot, candidate, `${label}: artifact '${artifactId}'`);
  if (!read.ok) {
    issues.push(`${label}: artifact '${artifactId}' is unreadable: ${read.error}`);
    return { ok: false, issues };
  }
  const parsed = parseArtifactJson(read.value.bytes);
  if (!parsed.ok) {
    issues.push(`${label}: artifact '${artifactId}' has no current readable JSON value (${parsed.reason})`);
    return { ok: false, issues };
  }
  const value = parsed.value;
  const digest = sha256Bytes(read.value.bytes);
  if (reference.sha256 !== digest) {
    issues.push(`${label}: artifact '${artifactId}' digest '${reference.sha256}' does not match current digest '${digest}'`);
  }
  const validation = validateSchema(artifactId, value);
  if (!validation.ok) {
    issues.push(...validation.issues.map((issue) => `${label}: artifact '${artifactId}' schema failed at ${issue.field}: ${issue.message}`));
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, reference: { ...reference }, value, issues: [] };
}

function normalizedReferenceIssues(
  pinnedRoot: PinnedProjectRoot | null,
  authorization: ArtifactReferenceAuthorization,
  reference: CompletionArtifactRef,
  label: string,
): string[] {
  return normalizeReferencePinned(pinnedRoot, authorization, reference, label).issues;
}

/** Reuse the descriptor-anchored reader for durable nested evidence admission. */
export function normalizeCtoArtifactReferencePinned(
  pinnedRoot: PinnedProjectRoot,
  authorization: ArtifactReferenceAuthorization,
  reference: CompletionArtifactRef,
  label: string,
  validateSchema?: ArtifactSchemaValidator,
): PinnedReferenceNormalizationResult {
  return normalizeReferencePinned(pinnedRoot, authorization, reference, label, validateSchema);
}

function rejectNormalization(target: object, issues: readonly string[]): void {
  if (issues.length === 0) return;
  Object.defineProperty(target, NORMALIZATION_REJECTION, { value: [...issues].sort().join("; "), enumerable: false, configurable: false, writable: false });
}

function normalizationIdentityFindings(input: NormalizeAndPersistImplementationConformanceInput, canonicalRoot: string | null): NormalizationFinding[] {
  const findings: NormalizationFinding[] = [];
  const add = (message: string, remediation: Remediation, subjectId: string | null): void => {
    findings.push({ message, remediation, subject_id: subjectId, evidence_refs: [] });
  };
  const workspaceValidation = validateFeatureWorkspaceRecord(input.workspace);
  if (!workspaceValidation.ok) add(`Current feature workspace is invalid: ${workspaceValidation.issues.join("; ")}.`, "repair_implementation", input.workspace?.feature_id ?? null);
  if (!canonicalRoot || input.workspace.project_root !== canonicalRoot) add(`Workspace project authorization '${String(input.workspace.project_root)}' does not match current project root '${canonicalRoot ?? "unavailable"}'.`, "repair_implementation", input.workspace.feature_id);
  if (input.workspace.feature_id !== input.handoff.feature_id) add(`Workspace feature '${input.workspace.feature_id}' does not match handoff feature '${input.handoff.feature_id}'.`, "repair_implementation", input.workspace.feature_id);
  if (input.workspace.handoff_ref !== input.handoff.handoff_id) add(`Workspace handoff reference '${String(input.workspace.handoff_ref)}' does not match active handoff '${input.handoff.handoff_id}'.`, "repair_implementation", input.handoff.handoff_id);
  if (input.workspace.execution_claim_ref !== input.claim.claim_id) add(`Workspace execution claim reference '${String(input.workspace.execution_claim_ref)}' does not match active claim '${input.claim.claim_id}'.`, "repair_implementation", input.claim.claim_id);
  if (!CONFORMANCE_WORKSPACE_STATUSES[input.workspace.status]) add(`Workspace status '${input.workspace.status}' is not authorized for implementation conformance.`, "repair_implementation", input.workspace.feature_id);
  if (input.claim.owner_kind !== input.active_owner_kind || input.claim.owner_run_id !== input.active_owner_run_id) add(`Active execution identity '${input.active_owner_kind}/${input.active_owner_run_id}' does not match claim owner '${input.claim.owner_kind}/${input.claim.owner_run_id}'.`, "repair_implementation", input.claim.claim_id);
  if (input.workspace.profile_hash !== input.profile_hash) add(`Workspace profile hash '${input.workspace.profile_hash}' does not match evaluated profile hash '${input.profile_hash}'.`, "repair_quality_gate", input.workspace.feature_id);
  return findings.sort(compareCanonical);
}

function removeOwnedConformanceArtifactIfUnchanged(
  pinnedRoot: PinnedProjectRoot,
  ownership: ArtifactWriteOwnershipToken,
): boolean {
  if (!pinnedRoot.isStable()) return false;
  const relativePath = pinnedRoot.relativePath(ownership.path);
  if (relativePath === null || relativePath !== ownership.relative_path || pinnedRoot.anchorPath(relativePath) !== ownership.path) return false;
  let observed;
  try {
    observed = pinnedRoot.readFile(relativePath, { maxBytes: MAX_CONFORMANCE_ARTIFACT_BYTES });
  } catch (error) {
    if (error instanceof Error && /not exist|not found/iu.test(error.message)) return false;
    return false;
  }
  const info = pinnedRoot.pathEntryInfo(relativePath);
  if (!info || info.kind !== "file"
    || observed.path !== ownership.path
    || observed.dev !== ownership.dev || observed.ino !== ownership.ino
    || observed.bytes.byteLength !== ownership.size || info.size !== ownership.size
    || info.dev !== ownership.dev || info.ino !== ownership.ino
    || sha256Bytes(Buffer.from(observed.bytes)) !== ownership.sha256) return false;
  try {
    pinnedRoot.removeFileIfMatches(relativePath, { dev: ownership.dev, ino: ownership.ino, sha256: ownership.sha256 });
  } catch {
    return false;
  }
  return pinnedRoot.isStable();
}

/** Normalize current persisted evidence, evaluate the unchanged T052 matrix, and persist through the canonical artifact store. */
function normalizeAndPersistImplementationConformancePinned(
  input: NormalizeAndPersistImplementationConformanceInput,
  pinnedRoot: PinnedProjectRoot,
): NormalizeAndPersistImplementationConformanceResult {
  const canonicalRoot = pinnedRoot.isStable() ? pinnedRoot.canonical_root : null;
  const identityFindings = normalizationIdentityFindings(input, canonicalRoot);
  const featureArtifactsDir = canonicalRoot
    ? join(canonicalRoot, ".work-state", "features", input.workspace.feature_id, "artifacts")
    : "";
  const authorization: ArtifactReferenceAuthorization = { project_root: input.project_root, artifacts_dir: featureArtifactsDir, allowed_paths: [...input.allowed_artifact_paths] };
  const evidence = input.evidence.map((submitted): ConformanceEvidence => {
    if (evidenceIssues(submitted).length > 0) return submitted;
    const normalized: NormalizedEvidence = { recorded_at: "", ...submitted, artifact: cloneArtifact(submitted.artifact), ...(submitted.test ? { test: cloneTest(submitted.test) } : {}) };
    const issues = normalizedReferenceIssues(pinnedRoot, authorization, normalized.artifact, `Evidence '${normalized.evidence_id}' artifact`);
    if (normalized.kind === "executed_test" && normalized.test) issues.push(...normalizedReferenceIssues(pinnedRoot, authorization, normalized.test.evidence_ref, `Evidence '${normalized.evidence_id}' executed-test artifact`));
    rejectNormalization(normalized, issues);
    return normalized;
  });
  const qualityGates = input.quality_gates.map((submitted): QualityGateResult => {
    if (qualityGateIssues(submitted).length > 0) return submitted;
    const normalized = cloneGate(submitted) as NormalizedGate;
    const issues = normalized.evidence_refs.length === 0 ? [`Quality gate '${normalized.gate_id}' has no current artifact reference.`] : normalized.evidence_refs.flatMap((reference) => normalizedReferenceIssues(pinnedRoot, authorization, reference, `Quality gate '${normalized.gate_id}' artifact`));
    rejectNormalization(normalized, issues);
    return normalized;
  });
  const normalizedInput: NormalizedInput = { handoff: input.handoff, claim: input.claim, profile_hash: input.profile_hash, evidence, quality_gates: qualityGates, evaluated_at: input.evaluated_at };
  Object.defineProperty(normalizedInput, NORMALIZATION_FINDINGS, { value: identityFindings, enumerable: false, configurable: false, writable: false });
  const result = evaluateImplementationConformance(normalizedInput);
  if (identityFindings.length > 0 || !canonicalRoot) return { ok: false, result, artifact_ref: null, issues: identityFindings.map((item) => item.message) };
  const resultValidation = validateProducedArtifact("implementation_conformance", result);
  if (!resultValidation.ok) return { ok: false, result, artifact_ref: null, issues: resultValidation.issues.map((issue) => `${issue.field}: ${issue.message}`) };
  try {
    if (!input.workspace.constitution_binding) return { ok: false, result, artifact_ref: null, issues: ["Specification workspace has no constitution binding."] };
    const liveConstitution = readPinnedCurrentConstitution(canonicalRoot, pinnedRoot, input.workspace.constitution_binding);
    if (!liveConstitution.ok) return { ok: false, result, artifact_ref: null, issues: ["Live constitution is unavailable: " + liveConstitution.error] };
    const bindingIdentity = (binding: ConstitutionBinding | null | undefined): string => {
      if (!binding) return "null";
      const { bound_at: _boundAt, ...semantic } = binding;
      return canonicalJson(semantic);
    };
    if (bindingIdentity(liveConstitution.value.binding) !== bindingIdentity(input.handoff.constitution_binding)) {
      return { ok: false, result, artifact_ref: null, issues: ["Live constitution binding does not match the implementation handoff."] };
    }
    const conformanceArtifactsDir = join(featureArtifactsDir, "implementation_conformance");
    let artifactOwnership: ArtifactWriteOwnershipToken | null = null;
    const artifactRef = writeArtifactWithReference(canonicalRoot, conformanceArtifactsDir, result.conformance_id, result, { schema_status: "met", quality_gate_status: result.overall_status === "pass" ? "met" : "failed" }, {
      pinnedRoot,
      onCreated: (ownership) => { artifactOwnership = ownership; },
    });
    return { ok: true, result, artifact_ref: artifactRef, artifact_ownership: artifactOwnership };
  } catch (error) {
    return { ok: false, result, artifact_ref: null, issues: [`Implementation conformance could not be persisted: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/** Public entry point: open one root descriptor for normalization and persistence. */
export function normalizeAndPersistImplementationConformance(input: NormalizeAndPersistImplementationConformanceInput): NormalizeAndPersistImplementationConformanceResult {
  const boundaryIssues = conformanceInputBoundaryIssues(input);
  if (boundaryIssues.length > 0) {
    const result = boundedImplementationConformanceResult(input, boundaryIssues);
    return { ok: false, result, artifact_ref: null, issues: boundaryIssues };
  }
  const openedRoot = PinnedProjectRoot.open(input.project_root);
  const pinnedRoot = openedRoot && openedRoot.isStable() ? openedRoot : null;
  if (openedRoot && !pinnedRoot) openedRoot.close();
  if (!pinnedRoot) {
    const result = evaluateImplementationConformance(input);
    return { ok: false, result, artifact_ref: null, issues: ["The project root is unavailable or changed."] };
  }
  try {
    return normalizeAndPersistImplementationConformancePinned(input, pinnedRoot);
  } finally {
    pinnedRoot.close();
  }
}
export interface PersistDoWorkSpecificationConformanceInput {
  project_root: string;
  feature_id: string;
  run_key: string;
  evidence: readonly ConformanceEvidence[];
  quality_gates: readonly QualityGateResult[];
  evaluated_at?: string;
}

export interface PersistDoWorkSpecificationConformanceResult {
  status: "persisted" | "blocked";
  replayed: boolean;
  feature_id: string;
  conformance_id: string | null;
  artifact_ref: CompletionArtifactRef | null;
  findings: string[];
}

function blockedDoWorkConformance(featureId: string, findings: readonly string[]): PersistDoWorkSpecificationConformanceResult {
  return {
    status: "blocked",
    replayed: false,
    feature_id: featureId,
    conformance_id: null,
    artifact_ref: null,
    findings: [...findings],
  };
}

interface DoWorkProfileGateValidation {
  quality_gates: QualityGateResult[];
  issues: string[];
}

export interface MandatoryQualityGateSpec {
  gate_id: string;
  source: QualityGateResult["source"];
  require_evidence: boolean;
}

/** Pure required-gate set shared by producer, terminal close, and durable completion. */
export function ctoMandatoryQualityGateSpecs(profileHash: string, handoffId: string): MandatoryQualityGateSpec[] {
  return [
    { gate_id: `execution-profile.${profileHash}`, source: "execution_profile", require_evidence: true },
    { gate_id: `cto-handoff-constitution-binding.${handoffId}`, source: "project_constitution", require_evidence: false },
  ];
}

export function ctoMandatoryQualityGateIssues(
  gates: readonly QualityGateResult[],
  specs: readonly MandatoryQualityGateSpec[],
  options: { requirePass?: boolean } = {},
): string[] {
  const issues: string[] = [];
  const requirePass = options.requirePass !== false;
  for (const spec of specs) {
    const matching = gates.filter((gate) => gate.gate_id === spec.gate_id && gate.source === spec.source);
    if (matching.length === 0) {
      issues.push(`Missing mandatory ${spec.source} quality gate '${spec.gate_id}'.`);
      continue;
    }
    if (matching.length > 1) {
      issues.push(`Multiple mandatory ${spec.source} quality gates '${spec.gate_id}' were supplied; exactly one canonical gate is required.`);
      continue;
    }
    const gate = matching[0]!;
    if (requirePass && gate.status !== "pass") issues.push(`Mandatory quality gate '${spec.gate_id}' must pass before terminal completion.`);
    if (spec.require_evidence && (!Array.isArray(gate.evidence_refs) || gate.evidence_refs.length === 0)) issues.push(`Mandatory quality gate '${spec.gate_id}' has no canonical quality_gate_evidence reference.`);
  }
  return issues;
}

export function executionProfileGateIssues(profileHash: string, gates: readonly QualityGateResult[]): string[] {
  return ctoMandatoryQualityGateIssues(gates, [{ gate_id: `execution-profile.${profileHash}`, source: "execution_profile", require_evidence: true }]);
}

/** Generic do-work uses the same profile gate and adds the derived constitution binding when a frozen handoff is available. */
export function doWorkMandatoryQualityGateSpecs(profileHash: string, handoffId?: string): MandatoryQualityGateSpec[] {
  return handoffId === undefined ? [{ gate_id: `execution-profile.${profileHash}`, source: "execution_profile", require_evidence: true }] : ctoMandatoryQualityGateSpecs(profileHash, handoffId);
}

/**
 * Generic /do-work requires one canonical execution-profile gate for the
 * currently selected workspace profile. The submitted gate is only a locator:
 * the persisted quality_gate_evidence envelope is the authority, and all
 * nested proof references are re-read through the same pinned root.
 */
function normalizeDoWorkProfileGate(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  profileHash: string,
  submittedGates: readonly QualityGateResult[],
): DoWorkProfileGateValidation {
  const requiredGateId = `execution-profile.${profileHash}`;
  const matching = submittedGates.filter((gate) => gate.source === "execution_profile" && gate.gate_id === requiredGateId);
  if (matching.length === 0) {
    return {
      quality_gates: [...submittedGates],
      issues: [`Missing mandatory execution-profile quality gate '${requiredGateId}' bound to the selected profile hash.`],
    };
  }
  if (matching.length > 1) {
    return {
      quality_gates: [...submittedGates],
      issues: [`Multiple execution-profile quality gates '${requiredGateId}' were supplied; exactly one canonical gate is required.`],
    };
  }
  const submitted = matching[0]!;
  const normalized = normalizeCtoQualityGate(pinnedRoot, featureId, submitted, false) as NormalizedGate;
  const issues: string[] = [];
  const rejection = normalized[NORMALIZATION_REJECTION];
  if (rejection) issues.push(rejection);
  issues.push(...executionProfileGateIssues(profileHash, [normalized]));
  const quality_gates = submittedGates.map((gate) => gate === submitted ? normalized : gate);
  return { quality_gates, issues };
}

/**
 * Engine-owned generic /do-work fan-in. The producer reads the current pinned
 * workspace, claim, and handoff, persists the immutable matrix, then adopts
 * exactly that content-addressed ref through a workspace CAS. Callers must not
 * write implementation_conformance_ref themselves.
 */
export function persistDoWorkSpecificationConformance(
  input: PersistDoWorkSpecificationConformanceInput,
): PersistDoWorkSpecificationConformanceResult {
  const boundaryIssues = conformanceInputBoundaryIssues(input);
  if (boundaryIssues.length > 0) return blockedDoWorkConformance(input.feature_id, boundaryIssues);
  const openedRoot = PinnedProjectRoot.open(input.project_root);
  const pinnedRoot = openedRoot && openedRoot.isStable() ? openedRoot : null;
  if (openedRoot && !pinnedRoot) openedRoot.close();
  if (!pinnedRoot) return blockedDoWorkConformance(input.feature_id, ["The project root is unavailable or changed."]);

  try {
    const snapshot: WorkspaceRootSnapshot = {
      lexical_root: pinnedRoot.lexical_root,
      canonical_root: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
      pinned_root: pinnedRoot,
    };
    const workspaceRead = resolveFeatureWorkspace(
      pinnedRoot.canonical_root,
      { feature_id: input.feature_id, run_key: input.run_key },
      snapshot,
    );
    if (!workspaceRead.ok) return blockedDoWorkConformance(input.feature_id, [workspaceRead.error]);
    const workspace = workspaceRead.value;
    const claimRead = readCurrentExecutionClaim(pinnedRoot.canonical_root, input.feature_id, pinnedRoot);
    if (!claimRead.ok || !claimRead.value) {
      return blockedDoWorkConformance(input.feature_id, [claimRead.ok ? "No active execution claim was found." : claimRead.error]);
    }
    const claim = claimRead.value;
    const claimValidation = validateExecutionClaim(claim);
    if (!claimValidation.ok) return blockedDoWorkConformance(input.feature_id, claimValidation.issues);
    if (claim.status !== "active" || claim.owner_kind !== "do_work") {
      return blockedDoWorkConformance(input.feature_id, ["The current execution claim is not an active do_work claim."]);
    }
    if (workspace.execution_claim_ref !== claim.claim_id) {
      return blockedDoWorkConformance(input.feature_id, ["Workspace execution_claim_ref does not match the current claim."]);
    }
    if (workspace.status !== "claimed" && workspace.status !== "executing") {
      return blockedDoWorkConformance(input.feature_id, [`Workspace status '${workspace.status}' is not eligible for conformance.`]);
    }
    if (!workspace.handoff_ref) return blockedDoWorkConformance(input.feature_id, ["Workspace has no canonical handoff reference."]);

    const handoff = readArtifactPinned<ImplementationHandoff>(
      pinnedRoot,
      `.work-state/features/${input.feature_id}/artifacts/implementation_handoff`,
      workspace.handoff_ref,
    );
    if (!handoff) return blockedDoWorkConformance(input.feature_id, ["The current implementation handoff is unreadable."]);
    const handoffValidation = validateImplementationHandoff(handoff);
    if (!handoffValidation.ok) return blockedDoWorkConformance(input.feature_id, handoffValidation.issues);
    if (
      handoff.feature_id !== input.feature_id ||
      handoff.handoff_id !== workspace.handoff_ref ||
      handoff.handoff_digest !== claim.handoff_digest ||
      canonicalHandoffDigest(handoff) !== handoff.handoff_digest
    ) {
      return blockedDoWorkConformance(input.feature_id, ["The current handoff identity or digest is not self-authenticating."]);
    }
    const constitutionError = ctoConstitutionErrorReadOnly(pinnedRoot, workspace, handoff);
    if (constitutionError) return blockedDoWorkConformance(input.feature_id, [constitutionError]);
    const profileGate = normalizeDoWorkProfileGate(
      pinnedRoot,
      input.feature_id,
      workspace.profile_hash,
      input.quality_gates,
    );
    if (profileGate.issues.length > 0) {
      return blockedDoWorkConformance(input.feature_id, profileGate.issues);
    }


    const allowedPaths = new Set<string>();
    const addAllowed = (reference: CompletionArtifactRef): void => {
      if (reference && typeof reference.artifact_id === "string") {
        allowedPaths.add(`.work-state/features/${input.feature_id}/artifacts/${reference.artifact_id}.json`);
      }
    };
    for (const evidence of input.evidence) {
      addAllowed(evidence.artifact);
      if (evidence.kind === "executed_test" && evidence.test) addAllowed(evidence.test.evidence_ref);
    }
    for (const gate of input.quality_gates) {
      for (const reference of gate.evidence_refs) addAllowed(reference);
    }
    const normalized = normalizeAndPersistImplementationConformancePinned({
      handoff,
      claim,
      profile_hash: workspace.profile_hash,
      evidence: [...input.evidence],
      quality_gates: [...profileGate.quality_gates],
      evaluated_at: input.evaluated_at ?? new Date().toISOString(),
      workspace,
      project_root: pinnedRoot.canonical_root,
      active_owner_kind: "do_work",
      active_owner_run_id: claim.owner_run_id,
      allowed_artifact_paths: [...allowedPaths],
    }, pinnedRoot);
    if (!normalized.ok || !normalized.artifact_ref) {
      return blockedDoWorkConformance(input.feature_id, normalized.issues);
    }

    const conformanceId = normalized.result.conformance_id;
    if (normalized.result.overall_status !== "pass") {
      return {
        status: "blocked",
        replayed: false,
        feature_id: input.feature_id,
        conformance_id: conformanceId,
        artifact_ref: normalized.artifact_ref,
        findings: normalized.result.blocking_findings.map((item) => item.message),
      };
    }
    const adoption = updateStateAtomically(
      pinnedRoot.canonical_root,
      (current) => {
        const currentState = current.state;
        const currentWorkspace = currentState?.specification;
        if (
          !currentState ||
          !currentWorkspace ||
          currentState.run_key !== input.run_key ||
          currentWorkspace.feature_id !== input.feature_id
        ) {
          return { op: "fail", code: "state_missing", error: "The target workspace disappeared before conformance adoption." } as const;
        }
        if (
          currentWorkspace.execution_claim_ref !== claim.claim_id ||
          currentWorkspace.handoff_ref !== handoff.handoff_id ||
          currentWorkspace.profile_hash !== workspace.profile_hash ||
          (currentWorkspace.status !== "claimed" && currentWorkspace.status !== "executing")
        ) {
          return { op: "fail", code: "state_conflict", error: "Workspace claim, handoff, profile, or status changed before conformance adoption." } as const;
        }
        const currentConstitutionError = ctoConstitutionErrorReadOnly(pinnedRoot, currentWorkspace, handoff);
        if (currentConstitutionError) {
          return { op: "fail", code: "state_conflict", error: "Live constitution changed before conformance adoption: " + currentConstitutionError } as const;
        }
        if (currentWorkspace.implementation_conformance_ref === conformanceId) {
          return { op: "discard", value: true } as const;
        }
        if (currentWorkspace.implementation_conformance_ref !== null) {
          return { op: "fail", code: "state_conflict", error: "Workspace already points to a different implementation conformance artifact." } as const;
        }
        return {
          op: "commit",
          value: false,
          state: {
            ...currentState,
            specification: {
              ...currentWorkspace,
              status: currentWorkspace.status === "claimed" && normalized.result.overall_status === "pass" ? "executing" : currentWorkspace.status,
              implementation_conformance_ref: conformanceId,
            },
          },
        } as const;
      },
      {
        selector: { feature_id: input.feature_id, run_key: input.run_key },
        branchNeutral: true,
        pinnedRoot,
        rootGuard: pinnedRoot,
        preCommit: () => {
          const latestConstitutionError = ctoConstitutionErrorReadOnly(pinnedRoot, workspace, handoff);
          if (latestConstitutionError) throw new Error(latestConstitutionError);
        },
      },
    );
    if (!adoption.ok) {
      if (normalized.ok && normalized.artifact_ownership) {
        removeOwnedConformanceArtifactIfUnchanged(pinnedRoot, normalized.artifact_ownership);
      }
      return blockedDoWorkConformance(input.feature_id, [adoption.error]);
    }
    const replayed = adoption.value === true;
    const findings = normalized.result.blocking_findings.map((item) => item.message);
    return {
      status: normalized.result.overall_status === "pass" ? "persisted" : "blocked",
      replayed,
      feature_id: input.feature_id,
      conformance_id: conformanceId,
      artifact_ref: normalized.artifact_ref,
      findings,
    };
  } catch (error) {
    return blockedDoWorkConformance(input.feature_id, [`Generic conformance persistence failed: ${error instanceof Error ? error.message : String(error)}`]);
  } finally {
    pinnedRoot.close();
  }
}

/** One supplied frozen handoff bound to its selected feature id and run. */
export interface CtoSpecificationConformanceHandoff {
  feature_id: string;
  run_key: string;
  handoff: ImplementationHandoff;
  /** Optional feature-local quality gates submitted by the executor. */
  quality_gates?: readonly QualityGateResult[];
}

/** Read-only view of the active exclusive claim for one selected feature. */
export interface CtoActiveClaimSummary {
  feature_id: string;
  claim_id: string;
  handoff_digest: string;
  owner_kind: ExecutionClaimOwnerKind;
  owner_run_id: string;
  status: ExecutionClaimStatus;
  admission_binding?: ExecutionClaim["admission_binding"];
}

/** Serializable opaque authority issued only after trusted command dispatch. */
export interface CtoSpecificationConformanceBinding {
  readonly capability_id: string;
  /** Digest of the exact terminal team postimages observed by the issuer. */
  readonly terminal_teams_digest: string;
}

/** Exact terminal state image bound to one mapped CTO execution slice. */
export interface CtoTerminalTeamPostimage {
  readonly team_id: string;
  readonly feature_id: string;
  readonly run_key: string;
  readonly task_id: string;
  readonly slice_id: string;
  readonly status: "done" | "failed";
  readonly work_identity: WorkIdentity;
  readonly completion_envelope: CompletionEnvelope;
}

export type CtoTerminalTeamsDigestResult =
  | { readonly ok: true; readonly digest: string; readonly teams: readonly CtoTerminalTeamPostimage[] }
  | { readonly ok: false; readonly error: string };

/** Exact feature/run selectors copied from the durable mapping record. */
export interface CtoTerminalTeamSelector {
  readonly feature_id: string;
  readonly run_key: string;
}

function terminalTeamPostimageError(teamId: string, message: string): CtoTerminalTeamsDigestResult {
  return { ok: false, error: `mapped CTO team '${teamId}' ${message}` };
}

/**
 * Canonical authenticated postimage for all teams selected by a CTO mapping.
 * This helper is deliberately read-only: issuers call it on a state snapshot,
 * while conformance persistence calls it again against the current state.
 */
export function computeCtoTerminalTeamsDigest(
  state: Pick<CtoState, "id" | "teams"> | null | undefined,
  mapping: CtoSpecificationMapping | null | undefined,
  selectors: ReadonlyMap<string, string | CtoTerminalTeamSelector> | readonly CtoTerminalTeamSelector[],
): CtoTerminalTeamsDigestResult {
  if (!state || typeof state.id !== "string" || !Array.isArray(state.teams)) {
    return { ok: false, error: "CTO state is unavailable for terminal-team postimage" };
  }
  if (!mapping || !Array.isArray(mapping.feature_ids) || !Array.isArray(mapping.task_to_slice) || mapping.task_to_slice.length === 0 || !Array.isArray(mapping.parallelization) || mapping.parallelization.length === 0) {
    return { ok: false, error: "CTO mapping has no canonical feature/task-to-slice/parallelization ownership rows" };
  }
  if (!selectors || (!Array.isArray(selectors) && typeof (selectors as { forEach?: unknown }).forEach !== "function")) return { ok: false, error: "CTO mapping feature/run selectors are unavailable" };
  const selections = new Map<string, string>();
  if (Array.isArray(selectors)) {
    for (const candidate of selectors) {
      if (!candidate || !isSafeFeatureId(candidate.feature_id) || typeof candidate.run_key !== "string" || candidate.run_key.trim().length === 0 || selections.has(candidate.feature_id)) return { ok: false, error: "CTO mapping feature/run selectors are unsafe or duplicated" };
      selections.set(candidate.feature_id, candidate.run_key);
    }
  } else {
    let invalidSelector = false;
    selectors.forEach((candidate, featureId) => {
      const runKey = typeof candidate === "string" ? candidate : candidate?.run_key;
      if (!isSafeFeatureId(featureId) || typeof runKey !== "string" || runKey.trim().length === 0 || selections.has(featureId)) {
        invalidSelector = true;
        return;
      }
      selections.set(featureId, runKey);
    });
    if (invalidSelector) return { ok: false, error: "CTO mapping feature/run selectors are unsafe or duplicated" };
  }
  if (selections.size !== mapping.feature_ids.length || mapping.feature_ids.some((featureId) => !selections.has(featureId))) return { ok: false, error: "CTO mapping feature/run selectors are missing, unsafe, or duplicated" };
  const teamsById = new Map<string, CtoState["teams"][number][]>();
  for (const team of state.teams) {
    if (typeof team?.id !== "string") continue;
    const existing = teamsById.get(team.id) ?? [];
    existing.push(team);
    teamsById.set(team.id, existing);
  }
  const ownersBySlice = new Map<string, typeof mapping.task_to_slice[number]>();
  for (const owner of mapping.task_to_slice) {
    if (!owner || typeof owner.slice_id !== "string" || typeof owner.team_id !== "string") return { ok: false, error: "CTO mapping has an unsafe task-to-slice ownership row" };
    if (ownersBySlice.has(owner.slice_id)) return terminalTeamPostimageError(owner.team_id, "has duplicate task-to-slice ownership for its slice");
    ownersBySlice.set(owner.slice_id, owner);
  }
  const seenSlices = new Set<string>();
  const postimages: CtoTerminalTeamPostimage[] = [];
  for (const parallel of mapping.parallelization) {
    const sliceId = typeof parallel?.slice_id === "string" ? parallel.slice_id : "";
    if (!sliceId || seenSlices.has(sliceId)) return terminalTeamPostimageError(sliceId || "<missing>", "has duplicate or unsafe parallelization slice identity");
    seenSlices.add(sliceId);
    const owner = ownersBySlice.get(sliceId);
    if (!owner) return terminalTeamPostimageError(sliceId, "has no unique task-to-slice owner");
    const matchingRows = mapping.task_to_slice.filter((candidate) => candidate.slice_id === sliceId);
    if (matchingRows.length !== 1) return terminalTeamPostimageError(sliceId, "has ambiguous task-to-slice ownership");
    const expectedRunKey = selections.get(owner.feature_id);
    const matchingTeams = teamsById.get(owner.team_id) ?? [];
    if (matchingTeams.length !== 1) return terminalTeamPostimageError(owner.team_id, matchingTeams.length === 0 ? "is missing from authenticated state" : "has duplicate authenticated state rows");
    const team = matchingTeams[0]!;
    const teamFeatureId = team.feature_id;
    const teamRunKey = team.run_key;
    const teamTaskId = team.task_id;
    const teamSliceId = team.slice_id;
    if (teamFeatureId !== owner.feature_id || (expectedRunKey !== undefined && teamRunKey !== expectedRunKey) || teamTaskId !== owner.task_id || teamSliceId !== owner.slice_id) {
      return terminalTeamPostimageError(owner.team_id, "feature/run/task/slice identity does not match mapping");
    }
    if (typeof teamFeatureId !== "string" || typeof teamRunKey !== "string" || typeof teamTaskId !== "string" || typeof teamSliceId !== "string") return terminalTeamPostimageError(owner.team_id, "has incomplete feature/run/task/slice identity");
    if (team.status !== "done" && team.status !== "failed") return terminalTeamPostimageError(owner.team_id, "is not terminal (pending/in_progress/parked)");
    if (team.pending !== undefined) return terminalTeamPostimageError(owner.team_id, "retains a pending marker after terminalization");
    const identity = team.work_identity;
    const envelope = team.completion_envelope;
    if (!identity || !envelope) return terminalTeamPostimageError(owner.team_id, "lacks terminal work identity or completion envelope");
    if (identity.run_id !== state.id || identity.slice_id !== owner.slice_id || identity.task_id !== owner.task_id) return terminalTeamPostimageError(owner.team_id, "work identity does not match state/mapping");
    if (canonicalJson(envelope.identity) !== canonicalJson(identity)) return terminalTeamPostimageError(owner.team_id, "completion identity is stale");
    if (envelope.outcome !== (team.status === "done" ? "succeeded" : "failed") || envelope.terminal_signal === null) return terminalTeamPostimageError(owner.team_id, "completion outcome is inconsistent with terminal status");
    if (!validateTypedControlPlane({ work_identity: identity, completion_envelope: envelope }).ok) return terminalTeamPostimageError(owner.team_id, "completion envelope is not typed/authenticated");
    postimages.push({
      team_id: team.id,
      feature_id: teamFeatureId,
      run_key: teamRunKey,
      task_id: teamTaskId,
      slice_id: teamSliceId,
      status: team.status,
      work_identity: identity,
      completion_envelope: envelope,
    });
  }
  if (seenSlices.size !== ownersBySlice.size) return { ok: false, error: "CTO mapping contains task-to-slice owners absent from parallelization" };
  return { ok: true, digest: digestOf(postimages.sort(compareCanonical)), teams: postimages };
}

interface CtoSpecificationConformanceAuthority {
  /** Canonical real project root identity captured at dispatch. */
  readonly project_root: string;
  readonly cto_run_id: string;
  readonly mapping_id: string;
  readonly mapping_hash: string;
  /** Canonical absolute durable mapping-record identity. */
  readonly mapping_record_path: string;
  /** SHA-256 of the exact durable mapping-record bytes. */
  readonly mapping_record_digest: string;
  readonly checkpoint_id: string;
  readonly trusted_answer_id: string;
  /** Digest of exact active claim identities observed at dispatch. */
  readonly active_claims_digest: string;
  /** Digest of exact terminal team postimages observed at dispatch/derivation. */
  readonly terminal_teams_digest: string;
}

interface CtoDurableMappingSelection {
  feature_id: string;
  run_key: string;
}

function terminalTeamsAuthorityError(
  pinnedRoot: PinnedProjectRoot,
  authority: Readonly<CtoSpecificationConformanceAuthority>,
  mapping: CtoSpecificationMapping,
  selectors: ReadonlyMap<string, string | CtoTerminalTeamSelector>,
): string | null {
  const state = readCtoStatePinned(authority.cto_run_id, pinnedRoot);
  const terminal = computeCtoTerminalTeamsDigest(state, mapping, selectors);
  if (!terminal.ok) return terminal.error;
  if (terminal.digest !== authority.terminal_teams_digest) return "current terminal CTO team postimage digest does not match the conformance authority";
  return null;
}

interface CtoDurableMappingSnapshot {
  mapping: Record<string, unknown>;
  feature_ids: string[];
  selectors: Map<string, CtoDurableMappingSelection>;
}

interface CtoDurableMappingResolution {
  snapshot: CtoDurableMappingSnapshot | null;
  feature_ids: string[];
  selectors: Map<string, CtoDurableMappingSelection>;
  issues: string[];
}

function expectedCtoMappingRecordPath(root: string, ctoRunId: string, mappingId: string): string | null {
  if (!isSafeCtoRunId(ctoRunId) || !isSafeCtoExecutionId(mappingId)) return null;
  return join(root, ".work-state", "cto", ctoRunId, "specification-mappings", `${mappingId}.json`);
}


function ctoRecordFeatureIds(value: unknown, issues: string[], label: string): string[] {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return [];
  }
  if (value.length > MAX_CTO_SPECIFICATION_REQUESTS) {
    issues.push(`${label} exceeds the selector bound`);
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  value.forEach((candidate, index) => {
    if (!isSafeFeatureId(candidate)) {
      issues.push(`${label}[${index}] is not a safe feature id`);
      return;
    }
    if (seen.has(candidate)) {
      issues.push(`${label} contains duplicate feature '${candidate}'`);
      return;
    }
    seen.add(candidate);
    ids.push(candidate);
  });
  return ids;
}

function ctoRecordSelectors(value: unknown, issues: string[], label: string): { selections: CtoDurableMappingSelection[]; byFeature: Map<string, CtoDurableMappingSelection> } {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return { selections: [], byFeature: new Map() };
  }
  if (value.length > MAX_CTO_SPECIFICATION_REQUESTS) {
    issues.push(`${label} exceeds the selector bound`);
    return { selections: [], byFeature: new Map() };
  }
  const selections: CtoDurableMappingSelection[] = [];
  const byFeature = new Map<string, CtoDurableMappingSelection>();
  value.forEach((candidate, index) => {
    if (!isRecord(candidate) || !isSafeFeatureId(candidate.feature_id) || typeof candidate.run_key !== "string" || candidate.run_key.trim().length === 0) {
      issues.push(`${label}[${index}] is not an explicit safe feature/run selector`);
      return;
    }
    if (byFeature.has(candidate.feature_id)) {
      issues.push(`${label} contains duplicate feature '${candidate.feature_id}'`);
      return;
    }
    const selection = { feature_id: candidate.feature_id, run_key: candidate.run_key };
    selections.push(selection);
    byFeature.set(selection.feature_id, selection);
  });
  return { selections, byFeature };
}

/** The durable confirmed mapping record is the authority for selected features and run selectors. */
function ctoMappingRecordResolution(
  canonicalRoot: string | null,
  callerMapping: Record<string, unknown>,
  authority: Readonly<CtoSpecificationConformanceAuthority> | null,
  pinnedRoot: PinnedProjectRoot | null,
): CtoDurableMappingResolution {
  const issues: string[] = [];
  const fallbackFeatureIds = ctoRecordFeatureIds(callerMapping.feature_ids, [], "caller mapping.feature_ids");
  const empty = { snapshot: null, feature_ids: fallbackFeatureIds, selectors: new Map<string, CtoDurableMappingSelection>(), issues };
  if (!authority) {
    issues.push("CTO conformance requires the opaque binding issued by verified command dispatch.");
    return empty;
  }
  if (!canonicalRoot) {
    issues.push("CTO conformance project root is missing or cannot be canonicalized.");
    return empty;
  }
  if (authority.project_root !== canonicalRoot) {
    issues.push(`CTO conformance authority is bound to project root '${authority.project_root}', not canonical root '${canonicalRoot}'.`);
    return empty;
  }
  const expectedPath = expectedCtoMappingRecordPath(canonicalRoot, authority.cto_run_id, authority.mapping_id);
  if (!expectedPath || authority.mapping_record_path !== expectedPath) {
    issues.push("CTO conformance authority does not identify the canonical durable mapping record.");
    return empty;
  }
  if (!isSha256Hex(authority.mapping_record_digest)) {
    issues.push("CTO conformance authority has an invalid durable mapping-record digest.");
    return empty;
  }
  const relativePath = pinnedRoot?.relativePath(expectedPath);
  if (!pinnedRoot || !relativePath) {
    issues.push("The exact durable CTO mapping record could not be anchored below the canonical project root.");
    return empty;
  }
  const read = readPinnedCtoMappingRecord(
    pinnedRoot,
    relativePath,
    authority.cto_run_id,
    authority.mapping_id,
    { afterRead: (context) => ctoConformanceReadHookForRoot(pinnedRoot)?.afterRead?.(context) },
  );
  if (!read.ok) {
    issues.push(`The exact durable CTO mapping record could not be reloaded: ${read.error}.`);
    return empty;
  }
  const digest = read.value.digest;
  if (digest !== authority.mapping_record_digest) {
    issues.push("The exact durable CTO mapping record digest changed since authority issuance.");
  }
  const parsed: unknown = read.value.record;
  if (!isRecord(parsed)) {
    issues.push("The exact durable CTO mapping record is not an object.");
    return empty;
  }
  const record = parsed;
  if (record.schema_version !== 1 || record.cto_run_id !== authority.cto_run_id || !isRecord(record.mapping)) {
    issues.push("The exact durable CTO mapping record has an invalid envelope or run identity.");
    return empty;
  }
  const durableMapping = record.mapping;
  const featureIds = ctoRecordFeatureIds(durableMapping.feature_ids, issues, "durable mapping.feature_ids");
  const recordSelectors = ctoRecordSelectors(record.selections, issues, "durable mapping record selections");
  const mappingSelectors = ctoRecordSelectors(durableMapping.selections, issues, "durable mapping selections");
  if (recordSelectors.selections.length !== featureIds.length || featureIds.some((id, index) => id !== recordSelectors.selections[index]?.feature_id)) {
    issues.push("durable mapping feature ids do not match its exact record selectors");
  }
  if (mappingSelectors.selections.length !== recordSelectors.selections.length
    || mappingSelectors.selections.some((selection, index) => selection.feature_id !== recordSelectors.selections[index]?.feature_id || selection.run_key !== recordSelectors.selections[index]?.run_key)) {
    issues.push("durable mapping selectors do not match its exact record selectors");
  }
  if (durableMapping.mapping_id !== authority.mapping_id || durableMapping.mapping_hash !== authority.mapping_hash) {
    issues.push("durable mapping identity does not match the verified dispatch authority");
  }
  const expectedMappingHash = digestOf(ctoMappingHashBody(durableMapping));
  if (durableMapping.mapping_hash !== expectedMappingHash || durableMapping.mapping_id !== `cto-mapping-${expectedMappingHash.slice(0, 32)}`) {
    issues.push("durable mapping content does not match its canonical mapping hash identity");
  }
  if (durableMapping.status !== "confirmed" || durableMapping.checkpoint_ref !== authority.checkpoint_id) {
    issues.push("durable mapping is not the confirmed mapping bound to this checkpoint");
  }
  if (record.checkpoint_ref !== authority.checkpoint_id || record.trusted_answer_ref !== authority.trusted_answer_id || durableMapping.checkpoint_ref !== record.checkpoint_ref) {
    issues.push("durable mapping record confirmation references do not match the verified authority");
  }
  const immutable = durableMapping;
  if (immutable.cto_run_id !== authority.cto_run_id || immutable.execution_choice !== "cto" || !isRecord(immutable.execution)
    || immutable.execution.choice !== "cto" || !isSafeCtoExecutionId(immutable.execution.wave_id)
    || !isSafeCtoRunId(authority.cto_run_id)
    || !isSafeCtoExecutionId(authority.mapping_id)
    || typeof immutable.execution.capability_id !== "string" || immutable.execution.capability_id.trim().length === 0
    || typeof immutable.execution.capability_epoch !== "string" || immutable.execution.capability_epoch.trim().length === 0) {
    issues.push("durable mapping immutable run/execution identity is invalid");
  }
  const confirmation = record.confirmation_context;
  if (!isRecord(confirmation)
    || !isSafeFeatureId(confirmation.feature_id)
    || typeof confirmation.run_key !== "string" || confirmation.run_key.trim().length === 0
    || typeof confirmation.stage_id !== "string" || confirmation.stage_id.trim().length === 0
    || confirmation.decision !== "approve_continue"
    || typeof confirmation.capability_id !== "string" || confirmation.capability_id.trim().length === 0
    || typeof confirmation.capability_epoch !== "string" || confirmation.capability_epoch.trim().length === 0
    || typeof confirmation.policy_hash !== "string" || !isSha256Hex(confirmation.policy_hash)) {
    issues.push("durable mapping confirmation context is invalid");
  } else {
    const selected = recordSelectors.byFeature.get(confirmation.feature_id);
    if (!selected || selected.run_key !== confirmation.run_key) issues.push("durable mapping confirmation context is not bound to an exact record selector");
  }
  if (canonicalJson(durableMapping) !== canonicalJson(callerMapping)) {
    issues.push("caller mapping does not exactly match the durable mapping record");
  }
  const snapshot: CtoDurableMappingSnapshot = {

    mapping: durableMapping,
    feature_ids: featureIds,
    selectors: recordSelectors.byFeature,
  };
  return {
    snapshot,
    feature_ids: featureIds.length > 0 ? featureIds : fallbackFeatureIds,
    selectors: recordSelectors.byFeature,
    issues,
  };
}
function encodeAuthorityField(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeAuthorityField(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return Buffer.from(decoded, "utf8").toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

/** Maximum UTF-8 bytes accepted for the stateless CTO conformance authority token. */
export const CTO_CONFORMANCE_CAPABILITY_ID_MAX_BYTES = 4096;

/**
 * Validate the issuer-owned, stateless v2 conformance token envelope. The
 * token is intentionally longer than path identifiers: each of its eight
 * canonical base64url fields carry one immutable authority input.
 */
export function isCtoSpecificationConformanceCapabilityId(value: unknown): value is string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > CTO_CONFORMANCE_CAPABILITY_ID_MAX_BYTES
    || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) return false;
  const parts = value.split(".");
  if (parts.length !== 10 || parts[0] !== "cto-conformance-v2") return false;
  return parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/u.test(part) && decodeAuthorityField(part) !== null);
}

function ctoConformanceCapabilityId(input: CtoSpecificationConformanceAuthority): string {
  const fields = [
    input.project_root,
    input.cto_run_id,
    input.mapping_id,
    input.mapping_hash,
    input.mapping_record_digest,
    input.checkpoint_id,
    input.trusted_answer_id,
    input.active_claims_digest,
    input.terminal_teams_digest,
  ];
  const capabilityId = ["cto-conformance-v2", ...fields.map(encodeAuthorityField)].join(".");
  if (!isCtoSpecificationConformanceCapabilityId(capabilityId)) throw new Error("issued CTO conformance capability exceeds its bounded token envelope");
  return capabilityId;
}

/** Deterministic digest of the active claim postimage observed by dispatch. */
export function ctoConformanceClaimsDigest(
  claims: readonly Pick<CtoActiveClaimSummary, "claim_id" | "handoff_digest" | "owner_kind" | "owner_run_id" | "status" | "admission_binding">[],
): string {
  return digestOf(claims.map((claim) => ({
    claim_id: claim.claim_id,
    handoff_digest: claim.handoff_digest,
    owner_kind: claim.owner_kind,
    owner_run_id: claim.owner_run_id,
    status: claim.status,
    admission_binding: claim.admission_binding ?? null,
  })).sort(compareCanonical));
}

/** The durable handle is derived from the confirmed mapping and active claim postimage. */
export function issueCtoSpecificationConformanceBinding(input: CtoSpecificationConformanceAuthority): CtoSpecificationConformanceBinding {
  const canonicalRoot = typeof input?.project_root === "string" ? canonicalProjectRoot(input.project_root) : null;
  const expectedRecordPath = canonicalRoot && isSafeCtoRunId(input?.cto_run_id) && isSafeCtoExecutionId(input?.mapping_id)
    ? expectedCtoMappingRecordPath(canonicalRoot, input.cto_run_id, input.mapping_id)
    : null;
  if (
    !input
    || !canonicalRoot
    || input.project_root !== canonicalRoot
    || !isSafeCtoRunId(input.cto_run_id)
    || !isSafeCtoExecutionId(input.mapping_id)
    || !isSha256Hex(input.mapping_hash)
    || !expectedRecordPath
    || input.mapping_record_path !== expectedRecordPath
    || !isSha256Hex(input.mapping_record_digest)
    || typeof input.checkpoint_id !== "string" || input.checkpoint_id.trim().length === 0
    || typeof input.trusted_answer_id !== "string" || input.trusted_answer_id.trim().length === 0
    || !isSha256Hex(input.active_claims_digest)
    || !isSha256Hex(input.terminal_teams_digest)
  ) throw new Error("invalid CTO specification conformance binding");
  const frozen = Object.freeze({ ...input, project_root: canonicalRoot });
  return Object.freeze({ capability_id: ctoConformanceCapabilityId(frozen), terminal_teams_digest: frozen.terminal_teams_digest });
}

function resolveCtoConformanceAuthority(
  binding: unknown,
  projectRoot: string,
  pinnedRoot?: PinnedProjectRoot | null,
): Readonly<CtoSpecificationConformanceAuthority> | null {
  if (!isRecord(binding) || !isCtoSpecificationConformanceCapabilityId(binding.capability_id)) return null;
  const parts = binding.capability_id.split(".");
  const decoded = parts.slice(1).map(decodeAuthorityField);
  if (decoded.some((value) => value === null)) return null;
  const fields = decoded as string[];
  const canonicalRoot = pinnedRoot !== undefined
    ? pinnedRoot && pinnedRoot.isStable() ? pinnedRoot.canonical_root : null
    : canonicalProjectRoot(projectRoot);
  if (!canonicalRoot) return null;
  const [issuedRoot, cto_run_id, mapping_id, mapping_hash, mapping_record_digest, checkpoint_id, trusted_answer_id, active_claims_digest, terminal_teams_digest] = fields;
  if (issuedRoot !== canonicalRoot) return null;
  if (!cto_run_id || !mapping_id || !mapping_hash || !mapping_record_digest || !checkpoint_id || !trusted_answer_id || !active_claims_digest || !terminal_teams_digest) return null;
  const mapping_record_path = expectedCtoMappingRecordPath(canonicalRoot, cto_run_id, mapping_id);
  if (!mapping_record_path) return null;
  const authority: CtoSpecificationConformanceAuthority = {
    project_root: canonicalRoot,
    cto_run_id,
    mapping_id,
    mapping_hash,
    mapping_record_path,
    mapping_record_digest,
    checkpoint_id,
    trusted_answer_id,
    active_claims_digest,
    terminal_teams_digest,
  };
  return ctoConformanceCapabilityId(authority) === binding.capability_id ? Object.freeze(authority) : null;
}

/** Publicly exposes only the immutable fields needed to construct the next mounted finalizer call. */
export interface CtoSpecificationConformanceAuthorityView {
  readonly cto_run_id: string;
  readonly mapping_id: string;
  readonly mapping_hash: string;
  readonly mapping_record_digest: string;
  readonly checkpoint_id: string;
  readonly trusted_answer_id: string;
  readonly capability_id: string;
  readonly active_claims_digest: string;
  readonly terminal_teams_digest: string;
}

export function readCtoSpecificationConformanceAuthority(
  binding: unknown,
  projectRoot: string,
): CtoSpecificationConformanceAuthorityView | null {
  const authority = resolveCtoConformanceAuthority(binding, projectRoot);
  if (!authority) return null;
  return {
    cto_run_id: authority.cto_run_id,
    mapping_id: authority.mapping_id,
    mapping_hash: authority.mapping_hash,
    mapping_record_digest: authority.mapping_record_digest,
    checkpoint_id: authority.checkpoint_id,
    trusted_answer_id: authority.trusted_answer_id,
    capability_id: ctoConformanceCapabilityId(authority),
    active_claims_digest: authority.active_claims_digest,
    terminal_teams_digest: authority.terminal_teams_digest,
  };
}

/** Fan-in input authorized by one exact verified/consumed CTO dispatch binding. */
export interface EvaluateCtoSpecificationConformanceInput {
  /** Canonical project root containing all selected feature workspaces. */
  project_root: string;
  binding: CtoSpecificationConformanceBinding;
  mapping: CtoSpecificationMapping;
  handoffs: readonly CtoSpecificationConformanceHandoff[];
  /** Caller summaries are cross-checked against each durable journal tail. */
  claims: readonly CtoActiveClaimSummary[];
  evidence: readonly ConformanceEvidence[];
  /** Optional wave-level quality gates; feature-local gates may be on handoffs. */
  quality_gates?: readonly QualityGateResult[];
}

/** Compact per-feature verdict derived from the full closure matrix. */
export interface CtoFeatureConformanceSummary {
  overall_status: ConformanceOverallStatus;
  blocking_findings: ConformanceFinding[];
}

/** `release` only when the feature's own matrix passes with no blocking finding. */
export type CtoConformanceClaimAction = "release" | "retain";

/** Per-feature outcome: the full T052 matrix plus the compact claim verdict. */
export interface CtoFeatureConformanceResult {
  feature_id: string;
  handoff_digest: string;
  matrix: ImplementationConformanceResult;
  result: CtoFeatureConformanceSummary;
  claim_action: CtoConformanceClaimAction;
}

export interface CtoSpecificationConformanceResult {
  /** One entry per mapping feature id, in deterministic mapping order. */
  features: CtoFeatureConformanceResult[];
  passing_feature_ids: string[];
  blocked_feature_ids: string[];
}


const CTO_CONFORMANCE_RECEIPT_MAX_FEATURES = 128;
const CTO_CONFORMANCE_RECEIPT_ID_RE = /^cto-conformance-receipt-[a-f0-9]{64}$/u;
const CTO_CONFORMANCE_RECEIPT_CONFORMANCE_ID_RE = /^implementation-conformance\.[a-f0-9]{64}$/u;
const CTO_CONFORMANCE_RECEIPT_CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;

function conformanceReceiptBody(receipt: CtoSpecificationConformanceReceipt): Record<string, unknown> {
  const { receipt_ref: _receiptRef, ...body } = receipt;
  return body;
}

function conformanceReceiptRefForBody(body: Record<string, unknown>): string {
  return `cto-conformance-receipt-${digestOf(body)}`;
}

/** Validate an immutable engine-owned CTO run-level conformance receipt. */
export function validateCtoSpecificationConformanceReceipt(
  value: unknown,
): { ok: true; value: CtoSpecificationConformanceReceipt } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "CTO conformance receipt must be an object" };
  const expectedKeys = [
    "schema_version", "receipt_ref", "cto_run_id", "wave_id", "mapping_id",
    "mapping_record_digest", "conformance_capability_id", "active_claims_digest",
    "terminal_teams_digest", "features",
  ].sort();
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(expectedKeys)) {
    return { ok: false, error: "CTO conformance receipt has an unexpected field set" };
  }
  if (value.schema_version !== 1
    || !CTO_CONFORMANCE_RECEIPT_ID_RE.test(String(value.receipt_ref ?? ""))
    || !isSafeCtoRunId(value.cto_run_id)
    || !isSafeCtoExecutionId(value.wave_id)
    || !isSafeCtoExecutionId(value.mapping_id)
    || !isSha256Hex(value.mapping_record_digest)
    || !isCtoSpecificationConformanceCapabilityId(value.conformance_capability_id)
    || !isSha256Hex(value.active_claims_digest)
    || !isSha256Hex(value.terminal_teams_digest)
    || !Array.isArray(value.features)
    || value.features.length === 0
    || value.features.length > CTO_CONFORMANCE_RECEIPT_MAX_FEATURES) {
    return { ok: false, error: "CTO conformance receipt identity or bounds are invalid" };
  }
  const features: CtoSpecificationConformanceReceiptFeature[] = [];
  const seen = new Set<string>();
  for (const candidate of value.features) {
    if (!isRecord(candidate)) return { ok: false, error: "CTO conformance receipt feature row is malformed" };
    const featureKeys = ["feature_id", "run_key", "conformance_id", "artifact_sha256", "matrix_digest", "claim_id"].sort();
    if (canonicalJson(Object.keys(candidate).sort()) !== canonicalJson(featureKeys)
      || !isSafeFeatureId(candidate.feature_id)
      || typeof candidate.run_key !== "string"
      || candidate.run_key.trim().length === 0
      || Buffer.byteLength(candidate.run_key, "utf8") > 512
      || /[\u0000\r\n]/u.test(candidate.run_key)
      || typeof candidate.conformance_id !== "string"
      || !CTO_CONFORMANCE_RECEIPT_CONFORMANCE_ID_RE.test(candidate.conformance_id)
      || !isSha256Hex(candidate.artifact_sha256)
      || !isSha256Hex(candidate.matrix_digest)
      || typeof candidate.claim_id !== "string"
      || !CTO_CONFORMANCE_RECEIPT_CLAIM_ID_RE.test(candidate.claim_id)
      || seen.has(candidate.feature_id)) {
      return { ok: false, error: "CTO conformance receipt feature identity or digest is invalid" };
    }
    seen.add(candidate.feature_id);
    features.push(candidate as unknown as CtoSpecificationConformanceReceiptFeature);
  }
  const sorted = [...features].sort(compareCanonical);
  if (canonicalJson(features) !== canonicalJson(sorted)) return { ok: false, error: "CTO conformance receipt features are not canonically sorted" };
  const receipt = value as unknown as CtoSpecificationConformanceReceipt;
  if (conformanceReceiptRefForBody(conformanceReceiptBody(receipt)) !== receipt.receipt_ref) {
    return { ok: false, error: "CTO conformance receipt reference does not match its canonical body" };
  }
  return { ok: true, value: receipt };
}

/** Read and validate one exact engine-owned CTO conformance receipt. */
export function readCtoSpecificationConformanceReceipt(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  receiptRef: string,
): { ok: true; value: CtoSpecificationConformanceReceipt; digest: string } | { ok: false; error: string } {
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before CTO conformance receipt read" };
  const relativePath = ctoSpecificationConformanceReceiptRelativePath(runId, receiptRef);
  if (!relativePath) return { ok: false, error: "CTO conformance receipt identity is invalid" };
  try {
    const source = pinnedRoot.readFile(relativePath, { maxBytes: MAX_CONFORMANCE_ARTIFACT_BYTES });
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed while reading CTO conformance receipt" };
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)) as unknown;
    const validated = validateCtoSpecificationConformanceReceipt(parsed);
    if (!validated.ok) return validated;
    const canonicalBytes = Buffer.from(`${canonicalJson(validated.value)}\n`, "utf8");
    if (!Buffer.from(source.bytes).equals(canonicalBytes)) return { ok: false, error: "CTO conformance receipt bytes are not canonical" };
    if (validated.value.receipt_ref !== receiptRef || validated.value.cto_run_id !== runId) {
      return { ok: false, error: "CTO conformance receipt path identity does not match its content" };
    }
    return { ok: true, value: validated.value, digest: createHash("sha256").update(source.bytes).digest("hex") };
  } catch (error) {
    return { ok: false, error: `CTO conformance receipt is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Frozen-digest resolution for one selected feature, before evaluation. */
interface ResolvedCtoFeatureHandoff {
  handoff: ImplementationHandoff;
  handoff_digest: string;
  findings: NormalizationFinding[];
}

/** Wave-binding violations repair the execution inputs; the taxonomy is closed. */
function ctoWaveFinding(message: string, subjectId: string | null): NormalizationFinding {
  return { message, remediation: "repair_implementation", subject_id: subjectId, evidence_refs: [] };
}

function ctoMappingHashBody(mapping: Record<string, unknown>): Record<string, unknown> {
  const { mapping_id: _id, mapping_hash: _hash, created_at: _created, updated_at: _updated, ...body } = mapping;
  return { ...body, checkpoint_ref: null, status: "awaiting_confirmation" };
}

function ctoAuthorityFindings(mapping: Record<string, unknown>, authority: Readonly<CtoSpecificationConformanceAuthority> | null): string[] {
  if (!authority) return ["CTO conformance requires the opaque binding issued by verified command dispatch."];
  const expectedHash = digestOf(ctoMappingHashBody(mapping));
  const expectedId = `cto-mapping-${expectedHash.slice(0, 32)}`;
  const issues: string[] = [];
  if (mapping.mapping_hash !== expectedHash) issues.push("CTO mapping content does not match its canonical mapping hash.");
  if (mapping.mapping_id !== expectedId) issues.push("CTO mapping id does not match its canonical mapping hash identity.");
  if (authority.mapping_hash !== mapping.mapping_hash || authority.mapping_id !== mapping.mapping_id) issues.push("CTO mapping does not match the exact verified dispatch binding.");
  if (mapping.checkpoint_ref !== authority.checkpoint_id) issues.push("CTO mapping checkpoint does not match the exact verified confirmation binding.");
  if (mapping.status !== "confirmed") issues.push(`CTO mapping '${String(mapping.mapping_id || "unknown")}' is not confirmed (status '${String(mapping.status)}').`);
  return issues;
}

function orderedUniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

/** Group supplied records by their string `feature_id`, canonically sorted per group. */
function groupCtoRecordsByFeature(value: unknown): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  if (!Array.isArray(value)) return groups;
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.feature_id !== "string") continue;
    const group = groups.get(entry.feature_id) ?? [];
    group.push(entry);
    groups.set(entry.feature_id, group);
  }
  for (const group of groups.values()) group.sort(compareCanonical);
  return groups;
}

function readCtoCanonicalHandoff(
  pinnedRoot: PinnedProjectRoot | null,
  featureId: string,
  workspace: FeatureWorkspace | null,
): { handoff: ImplementationHandoff | null; findings: NormalizationFinding[] } {
  const findings: NormalizationFinding[] = [];
  const fail = (message: string): { handoff: null; findings: NormalizationFinding[] } => ({
    handoff: null,
    findings: [ctoWaveFinding(message, featureId)],
  });
  if (!pinnedRoot) return fail(`Canonical project root is unavailable for feature '${featureId}'.`);
  if (!workspace) return fail(`No canonical workspace is available to resolve the implementation handoff for '${featureId}'.`);
  const handoffRef = workspace.handoff_ref;
  if (!isCtoSpecificationSafeId(handoffRef)) {
    return fail(`Feature workspace '${featureId}' has no safe canonical handoff reference.`);
  }
  const relativePath = `.work-state/features/${featureId}/artifacts/implementation_handoff/${handoffRef}.json`;
  const read = readCanonicalHandoff(
    pinnedRoot,
    relativePath,
    `Canonical handoff for feature '${featureId}'`,
    { afterRead: ctoConformanceReadHookForRoot(pinnedRoot)?.afterRead },
  );
  if (!read.ok) return fail(read.error);
  const handoff = read.handoff;
  if (handoff.handoff_id !== handoffRef || handoff.feature_id !== featureId) {
    return fail(`Canonical handoff identity for feature '${featureId}' does not match the current workspace reference.`);
  }
  return { handoff, findings };
}

/** Resolve handoff identifiers and mapping binding; handoff content is loaded separately from canonical storage. */
function resolveCtoFeatureHandoff(
  featureId: string,
  supplied: Record<string, unknown>[],
  bindings: Record<string, unknown>[],
): ResolvedCtoFeatureHandoff {
  const findings: NormalizationFinding[] = [];
  if (supplied.length === 0) {
    findings.push(ctoWaveFinding(`No frozen implementation handoff was supplied for feature '${featureId}'.`, featureId));
  } else if (supplied.length > 1) {
    findings.push(ctoWaveFinding(`${supplied.length} implementation handoffs were supplied for feature '${featureId}'; exactly one frozen handoff is required.`, featureId));
  }
  if (supplied.length > 0 && !isRecord(supplied[0]!.handoff)) {
    findings.push(ctoWaveFinding(`Supplied handoff identifier for feature '${featureId}' is not a record.`, featureId));
  }
  let binding: CtoHandoffBinding | null = null;
  if (bindings.length === 0) {
    findings.push(ctoWaveFinding(`The confirmed mapping has no handoff binding for feature '${featureId}'.`, featureId));
  } else {
    if (bindings.length > 1) {
      findings.push(ctoWaveFinding(`The mapping declares ${bindings.length} handoff bindings for feature '${featureId}'; exactly one is allowed.`, featureId));
    }
    binding = bindings[0] as unknown as CtoHandoffBinding;
  }
  const handoffDigest = typeof binding?.handoff_digest === "string" ? binding.handoff_digest : "";
  return { handoff: {} as unknown as ImplementationHandoff, handoff_digest: handoffDigest, findings };
}

function flagSharedCtoHandoffDigests(resolved: ReadonlyMap<string, ResolvedCtoFeatureHandoff>): void {
  const ownersByDigest = new Map<string, string[]>();
  for (const [featureId, entry] of resolved) {
    if (entry.handoff_digest === "") continue;
    const owners = ownersByDigest.get(entry.handoff_digest) ?? [];
    owners.push(featureId);
    ownersByDigest.set(entry.handoff_digest, owners);
  }
  for (const [digest, owners] of ownersByDigest) {
    if (owners.length < 2) continue;
    const ownerList = owners.map((id) => `'${id}'`).join(", ");
    for (const featureId of owners) {
      resolved.get(featureId)!.findings.push(ctoWaveFinding(`Frozen handoff digest '${digest}' is shared by features ${ownerList}; evidence cannot be attributed to exactly one handoff.`, featureId));
    }
  }
}

/**
 * Route evidence by its caller-supplied digest when it names one selected
 * handoff; otherwise inspect the byte-verified typed record and route by its
 * canonical handoff digest. Wrapper fields are never used as evidence facts.
 */
function ctoEvidenceOwner(
  item: Record<string, unknown>,
  pinnedRoot: PinnedProjectRoot | null,
  resolved: ReadonlyMap<string, ResolvedCtoFeatureHandoff>,
): string | null {
  const ownersByDigest = new Map<string, string[]>();
  for (const [featureId, entry] of resolved) {
    if (entry.handoff_digest === "") continue;
    ownersByDigest.set(entry.handoff_digest, [...(ownersByDigest.get(entry.handoff_digest) ?? []), featureId]);
  }
  const declaredDigest = typeof item.handoff_digest === "string" ? item.handoff_digest : "";
  const declaredOwners = ownersByDigest.get(declaredDigest);
  if (declaredOwners && declaredOwners.length === 1) return declaredOwners[0]!;
  const artifactReference = isRecord(item.artifact) ? item.artifact as unknown as CompletionArtifactRef : null;
  if (!artifactReference) return null;
  const matches: string[] = [];
  for (const [featureId, resolution] of resolved) {
    const artifact = readCanonicalCtoArtifact(pinnedRoot, featureId, artifactReference, `Evidence '${String(item.evidence_id ?? "unknown")}' artifact`, "conformance_evidence");
    const selected = typedEvidenceEntry(artifact, typeof item.evidence_id === "string" ? item.evidence_id : null, `Evidence '${String(item.evidence_id ?? "unknown")}' artifact`);
    if (selected.entry && selected.entry.handoff_digest === resolution.handoff_digest) matches.push(featureId);
  }
  return matches.length === 1 ? matches[0]! : null;
}

function partitionCtoEvidenceByFrozenDigest(
  value: unknown,
  pinnedRoot: PinnedProjectRoot | null,
  resolved: ReadonlyMap<string, ResolvedCtoFeatureHandoff>,
): Map<string, ConformanceEvidence[]> {
  const buckets = new Map<string, ConformanceEvidence[]>();
  if (!Array.isArray(value)) return buckets;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const featureId = ctoEvidenceOwner(item, pinnedRoot, resolved);
    if (!featureId) continue;
    const bucket = buckets.get(featureId) ?? [];
    bucket.push(item as unknown as ConformanceEvidence);
    buckets.set(featureId, bucket);
  }
  return buckets;
}

interface CanonicalCtoArtifact {
  reference: CompletionArtifactRef;
  value: unknown;
  issues: string[];
}

const canonicalCtoArtifactCaches = new WeakMap<PinnedProjectRoot, Map<string, CanonicalCtoArtifact>>();
function canonicalCtoArtifactCacheKey(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  reference: CompletionArtifactRef,
): string | null {
  if (!isRecord(reference) || typeof reference.artifact_id !== "string" || typeof reference.sha256 !== "string") return null;
  const authorization = ctoArtifactAuthorization(pinnedRoot.canonical_root, featureId, reference);
  const expectedPath = authorization.allowed_paths[0];
  return `${expectedPath ?? ""}\u0000${reference.sha256}`;
}

interface CtoArtifactBatchCandidate {
  featureId: string;
  reference: CompletionArtifactRef;
}

function canonicalCtoArtifactDirectoryIssues(
  pinnedRoot: PinnedProjectRoot,
  featureIds: readonly string[],
  featuresWithTests: ReadonlySet<string>,
): Map<string, string[]> {
  const directoryIssues = new Map<string, string[]>();
  for (const featureId of featureIds) {
    const relativeDirectory = relative(pinnedRoot.canonical_root, featureArtifactsDir(pinnedRoot.canonical_root, featureId)).split(sep).join("/");
    try {
      const names = pinnedRoot.listDirectory(relativeDirectory);
      const exactRuntime = `runtime_test_evidence-${featureId}.json`;
      for (const name of names) {
        const issue = name.startsWith("implementation_evidence-")
          ? `feature ${featureId} contains forbidden standalone implementation evidence artifact ${name}`
          : name.startsWith("runtime_test_evidence-") && (name !== exactRuntime || !featuresWithTests.has(featureId))
            ? `feature ${featureId} contains an alternate or unused runtime evidence artifact ${name}`
            : null;
        if (issue) {
          const entries = directoryIssues.get(featureId) ?? [];
          entries.push(issue);
          directoryIssues.set(featureId, entries);
        }
      }
    } catch (error) {
      const entries = directoryIssues.get(featureId) ?? [];
      entries.push(`feature ${featureId} artifact directory could not be enumerated safely: ${error instanceof Error ? error.message : String(error)}`);
      directoryIssues.set(featureId, entries);
    }
  }
  return directoryIssues;
}

function primeCanonicalCtoArtifactCache(
  pinnedRoot: PinnedProjectRoot,
  raw: Record<string, unknown>,
  featureIds: readonly string[],
): Map<string, string[]> {
  const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  const featuresWithTests = new Set(featureIds.filter((featureId) => rawEvidence.some((item) => isRecord(item) && (isRecord(item.test) || item.kind === "executed_test") && (item.feature_id === featureId || (isRecord(item.artifact) && typeof item.artifact.path === "string" && item.artifact.path.includes(`.work-state/features/${featureId}/artifacts/`))))));
  const directoryIssues = canonicalCtoArtifactDirectoryIssues(pinnedRoot, featureIds, featuresWithTests);
  const pending: CtoArtifactBatchCandidate[] = [];
  const seen = new Set<string>();
  const add = (featureId: string, value: unknown): void => {
    if (!isRecord(value) || typeof value.artifact_id !== "string" || typeof value.path !== "string" || typeof value.sha256 !== "string") return;
    const reference = value as unknown as CompletionArtifactRef;
    const key = canonicalCtoArtifactCacheKey(pinnedRoot, featureId, reference);
    if (!key || seen.has(key)) return;
    seen.add(key);
    pending.push({ featureId, reference });
  };
  const featureForReference = (value: unknown): string | null => {
    if (!isRecord(value)) return null;
    const path = value.path;
    if (typeof path !== "string") return null;
    return featureIds.find((featureId) => path.includes(`.work-state/features/${featureId}/artifacts/`)) ?? null;
  };
  const addArtifactRefs = (featureId: string, value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) add(featureId, item);
  };
  for (const item of rawEvidence) {
    if (!isRecord(item)) continue;
    const featureId = typeof item.feature_id === "string" ? item.feature_id : featureForReference(item.artifact);
    if (featureId) {
      add(featureId, item.artifact);
      if (isRecord(item.test)) add(featureId, item.test.evidence_ref);
    }
  }
  const rawQualityGates = Array.isArray(raw.quality_gates) ? raw.quality_gates : [];
  for (const gate of rawQualityGates) {
    if (!isRecord(gate) || !Array.isArray(gate.evidence_refs)) continue;
    for (const reference of gate.evidence_refs) {
      const featureId = featureForReference(reference);
      if (featureId) add(featureId, reference);
    }
  }
  const rawHandoffs = Array.isArray(raw.handoffs) ? raw.handoffs : [];
  for (const item of rawHandoffs) {
    if (!isRecord(item) || typeof item.feature_id !== "string") continue;
    const qualityGates = Array.isArray(item.quality_gates) ? item.quality_gates : [];
    for (const gate of qualityGates) {
      if (isRecord(gate)) addArtifactRefs(item.feature_id, gate.evidence_refs);
    }
  }
  for (let round = 0; round < 4 && pending.length > 0; round += 1) {
    const current = pending.splice(0);
    const groups = new Map<string, Map<string, CtoArtifactBatchCandidate>>();
    for (const candidate of current) {
      const authorization = ctoArtifactAuthorization(pinnedRoot.canonical_root, candidate.featureId, candidate.reference);
      const expectedPath = authorization.allowed_paths[0] ?? "";
      const slash = expectedPath.lastIndexOf("/");
      if (slash <= 0 || slash === expectedPath.length - 1) continue;
      const directory = expectedPath.slice(0, slash);
      const name = expectedPath.slice(slash + 1);
      const entries = groups.get(directory) ?? new Map<string, CtoArtifactBatchCandidate>();
      entries.set(name, candidate);
      groups.set(directory, entries);
    }
    for (const [directory, entries] of groups) {
      let batch: ReturnType<PinnedProjectRoot["readBatch"]>;
      try {
        batch = pinnedRoot.readBatch(directory, [...entries.keys()]);
      } catch {
        continue;
      }
      for (const record of batch.records) {
        const candidate = entries.get(record.name);
        if (!candidate) continue;
        const bytes = Buffer.from(record.bytes);
        if (sha256Bytes(bytes) !== candidate.reference.sha256) continue;
        const parsed = parseArtifactJson(bytes);
        if (!parsed.ok) {
          continue;
        }
        const value = parsed.value;
        if (!validateProducedArtifact(candidate.reference.artifact_id, value).ok) continue;
        const cacheKey = canonicalCtoArtifactCacheKey(pinnedRoot, candidate.featureId, candidate.reference);
        if (!cacheKey) continue;
        const cache = canonicalCtoArtifactCaches.get(pinnedRoot) ?? new Map<string, CanonicalCtoArtifact>();
        canonicalCtoArtifactCaches.set(pinnedRoot, cache);
        const artifactIssues: string[] = [];
        if (isRecord(value) && Array.isArray(value.gates)) {
          for (const gate of value.gates) {
            if (isRecord(gate) && Array.isArray(gate.evidence_refs) && gate.evidence_refs.length > 0) {
              artifactIssues.push(`quality gate artifact '${candidate.reference.artifact_id}' must persist empty evidence_refs`);
            }
          }
        }
        cache.set(cacheKey, { reference: { ...candidate.reference }, value, issues: artifactIssues });
        if (isRecord(value) && Array.isArray(value.entries)) {
          for (const entry of value.entries) {
            if (isRecord(entry) && isRecord(entry.test)) add(candidate.featureId, entry.test.evidence_ref);
          }
        }
        if (isRecord(value) && Array.isArray(value.gates)) {
          for (const gate of value.gates) {
            if (isRecord(gate)) addArtifactRefs(candidate.featureId, gate.evidence_refs);
          }
        }
      }
    }
  }
  return directoryIssues;
}

function ctoArtifactAuthorization(
  canonicalRoot: string,
  featureId: string,
  reference: CompletionArtifactRef,
): ArtifactReferenceAuthorization {
  const artifactsDir = featureArtifactsDir(canonicalRoot, featureId);
  const artifactId = typeof reference?.artifact_id === "string" ? reference.artifact_id : "";
  const expectedPath = relative(canonicalRoot, join(artifactsDir, `${artifactId}.json`)).split(sep).join("/");
  return {
    project_root: canonicalRoot,
    artifacts_dir: artifactsDir,
    // A reference is authorized only for the canonical path derived from its id;
    // normalizeReferencePinned then verifies the current bytes through the pin.
    allowed_paths: [expectedPath],
  };
}

function readCanonicalCtoArtifact(
  pinnedRoot: PinnedProjectRoot | null,
  featureId: string,
  reference: CompletionArtifactRef,
  label: string,
  expectedSchema?: "conformance_evidence" | "quality_gate_evidence",
): CanonicalCtoArtifact {
  const fallback = isRecord(reference) ? cloneArtifact(reference as CompletionArtifactRef) : {} as CompletionArtifactRef;
  if (!pinnedRoot) return { reference: fallback, value: null, issues: [`${label}: canonical project root is unavailable.`] };
  const cacheKey = canonicalCtoArtifactCacheKey(pinnedRoot, featureId, reference);
  const cache = canonicalCtoArtifactCaches.get(pinnedRoot) ?? new Map<string, CanonicalCtoArtifact>();
  canonicalCtoArtifactCaches.set(pinnedRoot, cache);
  const validateSchema = (artifact: CanonicalCtoArtifact): CanonicalCtoArtifact => {
    if (!expectedSchema || artifact.value === null) return artifact;
    const validation = validateProducedArtifact(expectedSchema, artifact.value);
    if (validation.ok) return artifact;
    return {
      reference: artifact.reference,
      value: artifact.value,
      issues: validation.issues.map((issue) => `${label}: ${issue.field}: ${issue.message}`),
    };
  };
  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) return validateSchema(cached);
  }
  const normalized = normalizeReferencePinned(
    pinnedRoot,
    ctoArtifactAuthorization(pinnedRoot.canonical_root, featureId, reference),
    reference,
    label,
  );
  if (!normalized.ok || !normalized.reference) {
    return { reference: fallback, value: null, issues: normalized.issues };
  }
  const result: CanonicalCtoArtifact = { reference: normalized.reference, value: normalized.value, issues: [] };
  if (cacheKey) cache.set(cacheKey, result);
  return validateSchema(result);
}

type CanonicalCtoArtifactSchema = "conformance_evidence" | "quality_gate_evidence";

function canonicalCtoArtifactSchema(value: unknown): CanonicalCtoArtifactSchema | null {
  if (!isRecord(value)) return null;
  const hasEntries = Array.isArray(value.entries);
  const hasGates = Array.isArray(value.gates);
  if (hasEntries === hasGates) return null;
  return hasEntries ? "conformance_evidence" : "quality_gate_evidence";
}

function readCanonicalCtoArtifactByContent(
  pinnedRoot: PinnedProjectRoot | null,
  featureId: string,
  reference: CompletionArtifactRef,
  label: string,
  expectedSchema?: CanonicalCtoArtifactSchema,
): CanonicalCtoArtifact {
  const artifact = readCanonicalCtoArtifact(pinnedRoot, featureId, reference, label, expectedSchema);
  if (artifact.issues.length > 0 || artifact.value === null) return artifact;
  const schema = canonicalCtoArtifactSchema(artifact.value);
  if (!schema) return { ...artifact, issues: [label + ": canonical artifact envelope schema is ambiguous"] };
  if (!isRecord(artifact.value) || artifact.value.artifact_id !== reference.artifact_id) {
    return { ...artifact, issues: [label + ": canonical artifact_id does not match its submitted reference"] };
  }
  if (expectedSchema && schema !== expectedSchema) return { ...artifact, issues: [label + ": canonical artifact has the wrong explicit schema"] };
  const validation = validateProducedArtifact(schema, artifact.value);
  if (!validation.ok) {
    return { ...artifact, issues: validation.issues.map((issue) => label + ": " + issue.field + ": " + issue.message) };
  }
  return artifact;
}
export function typedEvidenceEntryIssues(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} is not an object`];
  const issues: string[] = [];
  if (Object.keys(value).some((key) => !CONFORMANCE_EVIDENCE_KEYS.some((allowed) => allowed === key))) issues.push(`${label} contains an unknown field`);
  if (!isCtoSpecificationSafeId(value.evidence_id)) issues.push(`${label}.evidence_id is missing or invalid`);
  if (!EVIDENCE_KINDS.includes(String(value.kind))) issues.push(`${label}.kind is invalid`);
  if (!isCtoSpecificationSafeId(value.subject_id)) issues.push(`${label}.subject_id is missing or invalid`);
  if (value.requirement_id !== null && !isCtoSpecificationSafeId(value.requirement_id)) issues.push(`${label}.requirement_id is invalid`);
  if (!isSha256Hex(value.handoff_digest)) issues.push(`${label}.handoff_digest is invalid`);
  if (!isCtoSpecificationSafeId(value.execution_claim_id)) issues.push(`${label}.execution_claim_id is missing or invalid`);
  if (!isBoundedIsoTimestamp(value.recorded_at)) issues.push(`${label}.recorded_at is missing or invalid`);
  if (value.kind === "review") {
    if (value.review_verdict !== "pass" && value.review_verdict !== "fail") issues.push(`${label}.review_verdict is invalid`);
  }
  if (value.kind === "executed_test") {
    if (!isRecord(value.test)) issues.push(`${label}.test is missing`);
    else {
      if (!isRecord(value.test.evidence_ref)) issues.push(`${label}.test.evidence_ref is missing or invalid`);
      else issues.push(...artifactIssues(value.test.evidence_ref, `${label}.test.evidence_ref`));
      if (!TEST_KINDS.includes(String(value.test.test_kind))) issues.push(`${label}.test.test_kind is invalid`);
      if (value.test.status !== "pass" && value.test.status !== "fail") issues.push(`${label}.test.status is invalid`);
      if (!isBoundedIsoTimestamp(value.test.executed_at)) issues.push(`${label}.test.executed_at is missing or invalid`);
    }
  }
  if (value.kind === "intent_conflict") {
    if (typeof value.intent_message !== "string" || value.intent_message.trim().length === 0) issues.push(`${label}.intent_message is missing`);
  }
  if (value.intent_message !== undefined && (typeof value.intent_message !== "string" || Buffer.byteLength(value.intent_message, "utf8") > MAX_CONFORMANCE_FIELD_BYTES || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(String(value.intent_message)))) {
    issues.push(`${label}.intent_message exceeds the bounded line-inert text limit`);
  }
  return issues;
}

function canonicalArtifactAggregateIssues(value: unknown, label: string): string[] {
  try {
    return Buffer.byteLength(canonicalJson(value), "utf8") > MAX_CONFORMANCE_AGGREGATE_BYTES
      ? [`${label} exceeds ${MAX_CONFORMANCE_AGGREGATE_BYTES} aggregate bytes`]
      : [];
  } catch {
    return [`${label} cannot be serialized as canonical JSON`];
  }
}

function typedEvidenceEntry(
  artifact: CanonicalCtoArtifact,
  requestedEvidenceId: string | null,
  label: string,
): { entry: CtoTypedEvidenceEntry | null; issues: string[] } {
  const issues = [...artifact.issues, ...(artifact.value === null ? [] : canonicalArtifactAggregateIssues(artifact.value, label))];
  if (issues.length > 0) return { entry: null, issues };
  if (!isRecord(artifact.value) || artifact.value.schema_version !== 1 || artifact.value.artifact_id !== artifact.reference.artifact_id || !Array.isArray(artifact.value.entries)) {
    return { entry: null, issues: [`${label} is not a canonical conformance_evidence envelope`] };
  }
  const entries = artifact.value.entries;
  if (entries.length === 0) issues.push(`${label} has no entries`);
  if (entries.length > MAX_CONFORMANCE_EVIDENCE_ENTRIES) issues.push(`${label} exceeds ${MAX_CONFORMANCE_EVIDENCE_ENTRIES} entries`);
  const validEntries = entries.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  issues.push(...entries.flatMap((entry, index) => typedEvidenceEntryIssues(entry, `${label}.entries[${index}]`)));
  if (issues.length > 0) return { entry: null, issues };
  const selected = requestedEvidenceId === null
    ? validEntries.length === 1 ? validEntries[0] : undefined
    : validEntries.find((entry) => entry.evidence_id === requestedEvidenceId);
  if (!selected) {
    return { entry: null, issues: [`${label} does not contain the caller-identified evidence record '${requestedEvidenceId ?? "unknown"}'`] };
  }
  return { entry: selected as unknown as CtoTypedEvidenceEntry, issues: [] };
}

function nestedRuntimeNormalizationIssues(
  featureId: string,
  runtimeArtifact: CanonicalCtoArtifact,
  outerEntry: CtoTypedEvidenceEntry,
  pinnedRoot: PinnedProjectRoot | null,
): string[] {
  const issues = [...runtimeArtifact.issues];
  const runtimeId = `runtime_test_evidence-${featureId}`;
  const expectedRuntimePath = `.work-state/features/${featureId}/artifacts/${runtimeId}.json`;
  const qualityId = `quality_gate_evidence-${featureId}`;
  if (runtimeArtifact.reference.artifact_id !== runtimeId) issues.push(`executed-test artifact must use canonical runtime artifact '${runtimeId}'`);
  if (runtimeArtifact.reference.path !== expectedRuntimePath) issues.push(`executed-test artifact must use canonical runtime path '${expectedRuntimePath}'`);
  if (runtimeArtifact.reference.artifact_id !== runtimeId || runtimeArtifact.reference.path !== expectedRuntimePath) return issues;
  if (!isRecord(runtimeArtifact.value) || !Array.isArray(runtimeArtifact.value.entries) || runtimeArtifact.value.entries.length === 0) {
    issues.push(`canonical runtime artifact '${runtimeId}' has no entries`);
    return issues;
  }
  const seen = new Set<string>();
  let matched = false;
  runtimeArtifact.value.entries.forEach((rawEntry, index) => {
    const location = `runtime artifact '${runtimeId}'.entries[${index}]`;
    issues.push(...typedEvidenceEntryIssues(rawEntry, location));
    if (!isRecord(rawEntry)) return;
    const entry = rawEntry;
    if (entry.kind !== "executed_test" || !isRecord(entry.test)) {
      issues.push(`${location} must be an executed_test entry`);
      return;
    }
    if (entry.handoff_digest !== outerEntry.handoff_digest || entry.execution_claim_id !== outerEntry.execution_claim_id) {
      issues.push(`${location} has foreign handoff or execution claim context`);
    }
    const test = entry.test;
    const key = JSON.stringify([entry.subject_id, entry.requirement_id, test.test_kind, test.status, test.executed_at]);
    if (seen.has(key)) issues.push(`${location} duplicates a runtime executed_test row`);
    seen.add(key);
    if (entry.subject_id === outerEntry.subject_id && entry.requirement_id === outerEntry.requirement_id
      && isRecord(outerEntry.test)
      && test.test_kind === outerEntry.test.test_kind
      && test.status === outerEntry.test.status
      && test.executed_at === outerEntry.test.executed_at) matched = true;
    if (!isRecord(test.evidence_ref)) return;
    const nested = readCanonicalCtoArtifactByContent(
      pinnedRoot,
      featureId,
      test.evidence_ref as unknown as CompletionArtifactRef,
      `${location}.test.evidence_ref`,
      "quality_gate_evidence",
    );
    issues.push(...nested.issues);
    if (nested.reference.artifact_id !== qualityId) issues.push(`${location}.test.evidence_ref must use canonical quality artifact '${qualityId}'`);
    if (isRecord(nested.value) && Array.isArray(nested.value.gates)) {
      for (const gate of nested.value.gates) {
        if (isRecord(gate) && Array.isArray(gate.evidence_refs) && gate.evidence_refs.length > 0) issues.push(`${location}.test.evidence_ref quality gate evidence_refs must be empty`);
      }
    }
  });
  if (!matched) issues.push(`canonical runtime artifact '${runtimeId}' has no row matching the selected outer test`);
  return issues;
}

function runtimeEvidenceRowKey(entry: Record<string, unknown>): string | null {
  if (!isRecord(entry) || typeof entry.evidence_id !== "string" || !isRecord(entry.test)) return null;
  const test = entry.test;
  return JSON.stringify([
    entry.evidence_id,
    entry.subject_id,
    entry.requirement_id,
    test.test_kind,
    test.status,
    test.executed_at,
    entry.handoff_digest,
    entry.execution_claim_id,
  ]);
}

type RuntimeOuterEvidence = {
  evidence_id: string;
  kind: string;
  subject_id: string;
  requirement_id: string | null;
  handoff_digest: string;
  execution_claim_id: string;
  test?: { evidence_ref: CompletionArtifactRef; test_kind: string; status: "pass" | "fail"; executed_at: string };
};

function runtimeEnvelopeCompletenessIssues(
  featureId: string,
  evidence: readonly RuntimeOuterEvidence[],
  pinnedRoot: PinnedProjectRoot | null,
): string[] {
  const groups = new Map<string, { reference: CompletionArtifactRef; entries: RuntimeOuterEvidence[] }>();
  for (const item of evidence) {
    if (item.kind !== "executed_test" || !item.test || !isRecord(item.test.evidence_ref)) continue;
    const reference = item.test.evidence_ref as CompletionArtifactRef;
    const key = JSON.stringify([reference.artifact_id, reference.path, reference.sha256]);
    const group = groups.get(key) ?? { reference, entries: [] };
    group.entries.push(item);
    groups.set(key, group);
  }
  const issues: string[] = [];
  for (const group of groups.values()) {
    const artifact = readCanonicalCtoArtifactByContent(
      pinnedRoot,
      featureId,
      group.reference,
      `Feature '${featureId}' supporting runtime evidence`,
      "conformance_evidence",
    );
    issues.push(...artifact.issues);
    if (artifact.issues.length > 0 || artifact.value === null || !isRecord(artifact.value) || !Array.isArray(artifact.value.entries)) continue;
    if (group.reference.artifact_id !== `runtime_test_evidence-${featureId}`) continue;
    const expected = new Map<string, number>();
    for (const item of group.entries) {
      const row = {
        evidence_id: item.evidence_id,
        kind: item.kind,
        subject_id: item.subject_id,
        requirement_id: item.requirement_id,
        handoff_digest: item.handoff_digest,
        execution_claim_id: item.execution_claim_id,
        test: item.test,
      } as unknown as Record<string, unknown>;
      const key = runtimeEvidenceRowKey(row);
      if (key) expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    const actual = new Map<string, number>();
    for (const rawEntry of artifact.value.entries) {
      if (!isRecord(rawEntry)) continue;
      const key = runtimeEvidenceRowKey(rawEntry);
      if (key) actual.set(key, (actual.get(key) ?? 0) + 1);
    }
    const keys = new Set([...expected.keys(), ...actual.keys()]);
    for (const key of keys) {
      if ((expected.get(key) ?? 0) !== (actual.get(key) ?? 0)) {
        issues.push(`Feature '${featureId}' supporting runtime evidence rows do not exactly match the complete outer executed_test multiset`);
        break;
      }
    }
    const first = group.entries[0];
    if (first) issues.push(...nestedRuntimeNormalizationIssues(featureId, artifact, first as unknown as CtoTypedEvidenceEntry, pinnedRoot));
  }
  return issues;
}

function normalizeCtoEvidence(
  pinnedRoot: PinnedProjectRoot | null,
  featureId: string,
  submitted: ConformanceEvidence,
): NormalizedEvidence {
  const artifact = readCanonicalCtoArtifact(pinnedRoot, featureId, submitted?.artifact, `Evidence '${String(submitted?.evidence_id ?? "unknown")}' artifact`);
  const selected = typedEvidenceEntry(artifact, typeof submitted?.evidence_id === "string" ? submitted.evidence_id : null, `Evidence '${String(submitted?.evidence_id ?? "unknown")}' artifact`);
  if (selected.entry === null) {
    const fallback: NormalizedEvidence = {
      ...(isRecord(submitted) ? submitted : {} as ConformanceEvidence),
      artifact: cloneArtifact(submitted?.artifact),
      recorded_at: "",
    };
    rejectNormalization(fallback, selected.issues);
    return fallback;
  }
  const entry = selected.entry;
  const normalized: NormalizedEvidence = {
    evidence_id: entry.evidence_id,
    kind: entry.kind,
    subject_id: entry.subject_id,
    requirement_id: entry.requirement_id,
    handoff_digest: entry.handoff_digest,
    execution_claim_id: entry.execution_claim_id,
    recorded_at: entry.recorded_at,
    artifact: cloneArtifact(artifact.reference),
  };
  if (entry.kind === "review") normalized.review_verdict = entry.review_verdict;
  if (entry.kind === "executed_test" && entry.test) {
    const testArtifact = readCanonicalCtoArtifactByContent(
      pinnedRoot,
      featureId,
      entry.test.evidence_ref,
      "Evidence " + entry.evidence_id + " executed-test artifact",
      "conformance_evidence", 
    );
    const runtimeIssues = nestedRuntimeNormalizationIssues(featureId, testArtifact, entry, pinnedRoot);
    if (runtimeIssues.length > 0) {
      const fallback: NormalizedEvidence = {
        ...(isRecord(submitted) ? submitted : {} as ConformanceEvidence),
        artifact: cloneArtifact(submitted?.artifact),
        recorded_at: "",
      };
      rejectNormalization(fallback, runtimeIssues);
      return fallback;
    }
    normalized.test = {
      evidence_ref: cloneArtifact(testArtifact.reference),
      test_kind: entry.test.test_kind,
      status: entry.test.status,
      executed_at: entry.test.executed_at,
    };
  }
  if (entry.kind === "intent_conflict") normalized.intent_message = entry.intent_message;
  return normalized;
}

export function typedQualityGateIssues(value: unknown, label: string): string[] {
  if (!isRecord(value) || value.schema_version !== 1 || !isCtoSpecificationSafeId(value.artifact_id) || !Array.isArray(value.gates)) {
    return [`${label} is not a canonical quality_gate_evidence envelope`];
  }
  const issues: string[] = [...canonicalArtifactAggregateIssues(value, label)];
  if (Object.keys(value).some((key) => key !== "schema_version" && key !== "artifact_id" && key !== "gates")) issues.push(`${label} contains an unknown field`);
  if (value.gates.length === 0) issues.push(`${label} has no gates`);
  if (value.gates.length > MAX_CONFORMANCE_QUALITY_GATES) issues.push(`${label} exceeds ${MAX_CONFORMANCE_QUALITY_GATES} gates`);
  value.gates.forEach((gate, index) => {
    const path = `${label}.gates[${index}]`;
    if (!isRecord(gate)) {
      issues.push(`${path} is not an object`);
      return;
    }
    if (Object.keys(gate).some((key) => !CONFORMANCE_GATE_KEYS.some((allowed) => allowed === key))) issues.push(`${path} contains an unknown field`);
    if (!isCtoSpecificationSafeId(gate.gate_id)) issues.push(`${path}.gate_id is missing or invalid`);
    if (gate.source !== "project_constitution" && gate.source !== "execution_profile") issues.push(`${path}.source is invalid`);
    if (gate.status !== "pass" && gate.status !== "fail") issues.push(`${path}.status is invalid`);
    if (!Array.isArray(gate.evidence_refs)) issues.push(`${path}.evidence_refs is invalid`);
    else {
      if (gate.evidence_refs.length > MAX_CONFORMANCE_ARTIFACT_REFS_PER_ENTRY) issues.push(`${path}.evidence_refs exceeds ${MAX_CONFORMANCE_ARTIFACT_REFS_PER_ENTRY} references`);
      gate.evidence_refs.forEach((reference, refIndex) => issues.push(...artifactIssues(reference, `${path}.evidence_refs[${refIndex}]`)));
    }
    if (!Array.isArray(gate.findings)) issues.push(`${path}.findings is invalid`);
    else {
      if (gate.findings.length > MAX_CONFORMANCE_FINDINGS_PER_GATE) issues.push(`${path}.findings exceeds ${MAX_CONFORMANCE_FINDINGS_PER_GATE} findings`);
      gate.findings.forEach((item, findingIndex) => {
      if (!isRecord(item) || Object.keys(item).some((key) => !CONFORMANCE_FINDING_KEYS.some((allowed) => allowed === key))
        || !isCtoSpecificationSafeId(item.code) || (item.subject_id !== null && !isCtoSpecificationSafeId(item.subject_id))
        || typeof item.message !== "string" || item.message.trim().length === 0 || Buffer.byteLength(typeof item.message === "string" ? item.message : "", "utf8") > MAX_CONFORMANCE_FIELD_BYTES || !Array.isArray(item.evidence_refs)
        || (Array.isArray(item.evidence_refs) && item.evidence_refs.length > MAX_CONFORMANCE_FINDING_REFS)
        || (Array.isArray(item.evidence_refs) && item.evidence_refs.some((ref) => !isCtoSpecificationSafeId(ref)))) issues.push(`${path}.findings[${findingIndex}] is invalid`);
    });
    }
    if (!isBoundedIsoTimestamp(gate.evaluated_at)) issues.push(`${path}.evaluated_at is missing or invalid`);
  });
  return issues;
}

function normalizeCtoQualityGate(
  pinnedRoot: PinnedProjectRoot | null,
  featureId: string,
  submitted: QualityGateResult,
  requireEmptyEvidenceRefs = false,
): QualityGateResult {
  const submittedGateId = isRecord(submitted) && typeof submitted.gate_id === "string" ? submitted.gate_id : null;
  const submittedRefs = isRecord(submitted) && Array.isArray(submitted.evidence_refs) ? submitted.evidence_refs : [];
  const issues: string[] = [];
  if (submittedRefs.length === 0) issues.push(`Quality gate '${submittedGateId ?? "unknown"}' has no current artifact reference.`);
  const candidates: Array<{ gate: CtoTypedQualityGate; reference: CompletionArtifactRef }> = [];
  for (const reference of submittedRefs) {
    const artifact = readCanonicalCtoArtifact(pinnedRoot, featureId, reference, `Quality gate '${submittedGateId ?? "unknown"}' artifact`, "quality_gate_evidence");
    issues.push(...artifact.issues);
    if (artifact.issues.length > 0) continue;
    const typedIssues = typedQualityGateIssues(artifact.value, `Quality gate '${submittedGateId ?? "unknown"}' artifact`);
    issues.push(...typedIssues);
    if (typedIssues.length > 0) continue;
    if (!isRecord(artifact.value) || artifact.value.artifact_id !== reference.artifact_id || !Array.isArray(artifact.value.gates)) continue;
    const matches = artifact.value.gates.filter((gate): gate is Record<string, unknown> => isRecord(gate) && (submittedGateId === null || gate.gate_id === submittedGateId));
    if (matches.length === 0) {
      issues.push(`Quality gate artifact '${reference.artifact_id}' does not contain caller-identified gate '${submittedGateId ?? "unknown"}'.`);
      continue;
    }
    if (matches.length > 1) issues.push(`Quality gate artifact '${reference.artifact_id}' contains duplicate gate '${submittedGateId ?? "unknown"}'.`);
    const gate = matches[0]!;
    if (requireEmptyEvidenceRefs && Array.isArray(gate.evidence_refs) && gate.evidence_refs.length > 0) {
      issues.push(`Quality gate artifact '${reference.artifact_id}' must persist empty evidence_refs.`);
      continue;
    }
    candidates.push({ gate: gate as unknown as CtoTypedQualityGate, reference: artifact.reference });
  }
  if (candidates.length === 0) {
    const fallback: NormalizedGate = {
      ...(isRecord(submitted) ? submitted : {} as QualityGateResult),
      evidence_refs: submittedRefs.map(cloneArtifact),
      findings: isRecord(submitted) && Array.isArray(submitted.findings) ? submitted.findings.map((item) => ({ ...item, evidence_refs: [...item.evidence_refs] })) : [],
    } as NormalizedGate;
    rejectNormalization(fallback, issues);
    return fallback;
  }
  if (candidates.length > 1) issues.push(`Quality gate '${submittedGateId ?? candidates[0]!.gate.gate_id}' was identified by multiple canonical artifacts.`);
  const selected = candidates[0]!.gate;
  for (const reference of selected.evidence_refs) {
    const nested = readCanonicalCtoArtifactByContent(
      pinnedRoot,
      featureId,
      reference,
      "Quality gate " + selected.gate_id + " nested evidence",
    );
    issues.push(...nested.issues);
  }
  const normalized: NormalizedGate = {
    gate_id: selected.gate_id,
    source: selected.source,
    status: selected.status,
    // The gate artifact itself is the byte-verified proof for this row.
    evidence_refs: [cloneArtifact(candidates[0]!.reference)],
    findings: selected.findings.map((item) => ({ ...item, evidence_refs: [...item.evidence_refs] })),
  };
  rejectNormalization(normalized, issues);
  return normalized;
}

function ctoClaimSummaryMatches(
  summary: Record<string, unknown>,
  current: ExecutionClaim,
): boolean {
  return summary.claim_id === current.claim_id
    && summary.handoff_digest === current.handoff_digest
    && summary.owner_kind === current.owner_kind
    && summary.owner_run_id === current.owner_run_id
    && summary.status === current.status;
}

function ctoClaimFindings(
  featureId: string,
  handoff: ImplementationHandoff,
  workspace: FeatureWorkspace | null,
  current: ExecutionClaim | null,
  summaries: Record<string, unknown>[],
  verifiedRunId: string,
  canonicalRoot: string | null,
): NormalizationFinding[] {
  const findings: NormalizationFinding[] = [];
  const add = (message: string): void => {
    findings.push(ctoWaveFinding(message, featureId));
  };
  if (!workspace) {
    add(`No current feature workspace could be resolved for '${featureId}'.`);
  } else {
    if (workspace.project_root !== (canonicalRoot ?? "")) {
      add(`Feature workspace '${featureId}' is not bound to the canonical project root '${canonicalRoot ?? "unavailable"}'.`);
    }
    if (!CONFORMANCE_WORKSPACE_STATUSES[workspace.status]) {
      add(`Feature workspace '${featureId}' has unauthorized conformance status '${workspace.status}'.`);
    }
    if (workspace.feature_id !== featureId) add(`Feature workspace identity '${workspace.feature_id}' does not match selected feature '${featureId}'.`);
    if (current && workspace.execution_claim_ref !== current.claim_id) {
      add(`Feature workspace claim reference '${String(workspace.execution_claim_ref)}' does not match current durable claim '${current.claim_id}'.`);
    }
  }
  if (!current) {
    add(`No current durable execution claim exists for feature '${featureId}'.`);
  } else {
    if (current.handoff_digest !== handoff.handoff_digest) add(`Current durable claim '${current.claim_id}' is bound to handoff digest '${current.handoff_digest}', not frozen digest '${handoff.handoff_digest}'.`);
    if (current.owner_kind !== "cto") add(`Current durable claim '${current.claim_id}' is owned by '${current.owner_kind}', not CTO.`);
    if (current.owner_run_id !== verifiedRunId) add(`Current durable claim '${current.claim_id}' belongs to CTO run '${current.owner_run_id}', not the verified run '${verifiedRunId || "unavailable"}'.`);
  }
  if (summaries.length === 0) {
    add(`No execution claim summary was supplied for feature '${featureId}'.`);
  } else if (summaries.length > 1) {
    add(`${summaries.length} execution claim summaries were supplied for feature '${featureId}'; exactly one is allowed.`);
  } else {
    const summary = summaries[0]!;
    if (summary.feature_id !== featureId) add(`Execution claim summary feature '${String(summary.feature_id)}' does not match selected feature '${featureId}'.`);
    if (!current || !ctoClaimSummaryMatches(summary, current)) {
      add(`Execution claim summary for feature '${featureId}' does not exactly match the current durable claim.`);
    }
    if (Object.keys(summary).some((key) => !["feature_id", "claim_id", "handoff_digest", "owner_kind", "owner_run_id", "status", "admission_binding"].includes(key))) {
      add(`Execution claim summary for feature '${featureId}' contains fields outside the canonical summary.`);
    }
  }
  return findings;
}
function ctoEvidenceInputFindings(
  value: unknown,
  pinnedRoot: PinnedProjectRoot | null,
  resolved: ReadonlyMap<string, ResolvedCtoFeatureHandoff>,
): string[] {
  if (!Array.isArray(value)) return ["CTO conformance evidence must be an array."];
  const findings: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || !ctoEvidenceOwner(item, pinnedRoot, resolved)) {
      const declaredDigest = isRecord(item) && typeof item.handoff_digest === "string" ? item.handoff_digest : "unknown";
      findings.push(`CTO conformance evidence names an unknown, ambiguous, or unreadable frozen handoff record '${declaredDigest}'.`);
    }
  }
  return [...new Set(findings)].sort();
}

/** Rebuild the strict claim shape from a trusted durable claim. */
function trustedCtoClaim(current: ExecutionClaim | null): ExecutionClaim {
  return current ?? {} as unknown as ExecutionClaim;
}


/**
 * The pure fan-in has no runtime gate evidence: the frozen handoff's validated
 * project-constitution binding is the derived constitution gate row, and a
 * handoff that no longer validates fails it.
 */
function ctoConstitutionBindingGate(handoff: ImplementationHandoff, handoffValid: boolean): QualityGateResult {
  return {
    gate_id: `cto-handoff-constitution-binding.${typeof handoff.handoff_id === "string" ? handoff.handoff_id : "unknown"}`,
    source: "project_constitution",
    status: handoffValid ? "pass" : "fail",
    evidence_refs: [],
    findings: [],
  };
}

/**
 * Evaluate one closure matrix per selected feature (T098).
 *
 * The CTO path resolves every selected workspace and reads its current
 * durable claim journal tail. Caller summaries are only consistency proofs;
 * they never become evaluation authority. Submitted artifact references are
 * normalized against the feature's canonical artifact store before the
 * unchanged single-handoff evaluator runs.
 */
export function evaluateCtoSpecificationConformance(input: EvaluateCtoSpecificationConformanceInput): CtoSpecificationConformanceResult {
  const boundaryIssues = conformanceInputBoundaryIssues(input);
  if (boundaryIssues.length > 0) return { features: [], passing_feature_ids: [], blocked_feature_ids: [] };
  const raw: Record<string, unknown> = isRecord(input) ? input as unknown as Record<string, unknown> : {};
  const projectRoot = typeof raw.project_root === "string" ? raw.project_root : "";
  const openedRoot = PinnedProjectRoot.open(projectRoot);
  const pinnedRoot = openedRoot && openedRoot.isStable() ? openedRoot : null;
  if (openedRoot && !pinnedRoot) openedRoot.close();
  const canonicalRoot = pinnedRoot?.canonical_root ?? null;
  try {
    return evaluateCtoSpecificationConformancePinned(raw, projectRoot, pinnedRoot, canonicalRoot);
  } finally {
    pinnedRoot?.close();
  }
}

function evaluateCtoSpecificationConformancePinned(
  raw: Record<string, unknown>,
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot | null,
  canonicalRoot: string | null,
): CtoSpecificationConformanceResult {
  const mapping: Record<string, unknown> = isRecord(raw.mapping) ? raw.mapping : {};
  const authority = resolveCtoConformanceAuthority(raw.binding, canonicalRoot ?? projectRoot, pinnedRoot);
  const mappingRecord = ctoMappingRecordResolution(canonicalRoot, mapping, authority, pinnedRoot);
  const featureIds = mappingRecord.feature_ids.length > 0 ? mappingRecord.feature_ids : orderedUniqueStrings(mapping.feature_ids);
  const artifactDirectoryIssues = pinnedRoot
    ? primeCanonicalCtoArtifactCache(pinnedRoot, raw, featureIds)
    : new Map<string, string[]>();
  let authorityFindings = [
    ...ctoAuthorityFindings(mapping, authority),
    ...mappingRecord.issues,
  ];
  const trustedMapping = mappingRecord.snapshot?.mapping ?? mapping;
  const boundRunId = authority?.cto_run_id ?? "";
  const mappingId = typeof trustedMapping.mapping_id === "string" ? trustedMapping.mapping_id : "";
  const mappingVersion = trustedMapping.mapping_version ?? null;
  const handoffGroups = groupCtoRecordsByFeature(raw.handoffs);
  const claimGroups = groupCtoRecordsByFeature(raw.claims);
  const bindingGroups = groupCtoRecordsByFeature(trustedMapping.handoff_bindings);
  const resolved = new Map<string, ResolvedCtoFeatureHandoff>();
  const workspaces = new Map<string, FeatureWorkspace | null>();
  const workspaceErrors = new Map<string, string>();
  const currentClaims = new Map<string, ExecutionClaim | null>();
  const workspaceRoot: WorkspaceRootSnapshot | null = pinnedRoot
    ? { lexical_root: pinnedRoot.lexical_root, canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino, pinned_root: pinnedRoot }
    : null;
  const claimErrors = new Map<string, string>();
  for (const featureId of featureIds) {
    let capturedPathBinding: WorkspacePathBinding | undefined;
    if (pinnedRoot) {
      try {
        capturedPathBinding = captureWorkspacePathBinding(pinnedRoot, featureId);
      } catch {
        capturedPathBinding = undefined;
      }
    }
    const preliminary = resolveCtoFeatureHandoff(featureId, handoffGroups.get(featureId) ?? [], bindingGroups.get(featureId) ?? []);
    const suppliedHandoff = handoffGroups.get(featureId)?.[0];
    const durableSelector = mappingRecord.selectors.get(featureId);
    const preliminaryFindings = [...preliminary.findings];
    if (!durableSelector) {
      preliminaryFindings.push(ctoWaveFinding("Durable mapping record has no exact selector for feature " + featureId + ".", featureId));
    } else if (suppliedHandoff && suppliedHandoff.run_key !== durableSelector.run_key) {
      preliminaryFindings.push(ctoWaveFinding("Supplied run selector " + String(suppliedHandoff.run_key) + " does not match durable mapping run " + durableSelector.run_key + " for feature " + featureId + ".", featureId));
    }
    const suppliedRunKey = suppliedHandoff && typeof suppliedHandoff.run_key === "string" ? suppliedHandoff.run_key : "";
    const runKey = durableSelector?.run_key ?? suppliedRunKey;
    const workspaceResult = runKey.trim().length === 0
      ? { ok: false as const, code: "SPEC_SELECTOR_REQUIRED" as const, error: `No non-blank run_key was supplied for feature '${featureId}'.` }
      : workspaceRoot
        ? resolveFeatureWorkspace(projectRoot, { feature_id: featureId, run_key: runKey }, workspaceRoot)
        : { ok: false as const, code: "SPEC_PATH_UNAUTHORIZED" as const, error: "project root cannot be pinned for workspace inspection" };
    const workspace = workspaceResult.ok ? workspaceResult.value : null;
    workspaces.set(featureId, workspace);
    if (!workspaceResult.ok) workspaceErrors.set(featureId, workspaceResult.error);
    const canonical = readCtoCanonicalHandoff(pinnedRoot, featureId, workspace);
    const currentClaimResult = pinnedRoot
      ? readCurrentExecutionClaim(projectRoot, featureId, pinnedRoot, capturedPathBinding, canonical.handoff ?? undefined)
      : { ok: false as const, code: "SPEC_PATH_UNAUTHORIZED" as const, error: "project root cannot be pinned for claim inspection" };
    const currentClaim = currentClaimResult.ok ? currentClaimResult.value : null;
    currentClaims.set(featureId, currentClaim);
    if (!currentClaimResult.ok) claimErrors.set(featureId, currentClaimResult.error);

    const findings = [...preliminaryFindings, ...canonical.findings];
    const resolution: ResolvedCtoFeatureHandoff = {
      handoff: canonical.handoff ?? ({} as unknown as ImplementationHandoff),
      handoff_digest: canonical.handoff?.handoff_digest ?? preliminary.handoff_digest,
      findings,
    };
    const binding = bindingGroups.get(featureId)?.[0];
    if (canonical.handoff && binding) {
      if (binding.handoff_id !== canonical.handoff.handoff_id) findings.push(ctoWaveFinding(`Mapping binding pins handoff '${String(binding.handoff_id)}' but canonical storage contains '${canonical.handoff.handoff_id}'.`, featureId));
      if (binding.handoff_digest !== canonical.handoff.handoff_digest) findings.push(ctoWaveFinding(`Mapping binding digest '${String(binding.handoff_digest)}' does not match canonical handoff digest '${canonical.handoff.handoff_digest}'.`, featureId));
      if (canonicalJson(binding.artifact_versions) !== canonicalJson(canonical.handoff.artifact_versions)) findings.push(ctoWaveFinding(`Mapping binding for feature '${featureId}' pins different artifact versions than canonical handoff storage.`, featureId));
    }
    resolved.set(featureId, resolution);
  }
  const terminalTeamFindingsByFeature = new Map<string, string[]>();
  if (authority && pinnedRoot) {
    let terminal: CtoTerminalTeamsDigestResult | null = null;
    try {
      const ctoState = readCtoStatePinned(authority.cto_run_id, pinnedRoot);
      terminal = computeCtoTerminalTeamsDigest(ctoState, trustedMapping as unknown as CtoSpecificationMapping, mappingRecord.selectors);
    } catch (error) {
      authorityFindings = [...authorityFindings, `Terminal CTO team postimage could not be read: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (terminal && !terminal.ok) {
      authorityFindings = [...authorityFindings, `Terminal CTO team postimage is unavailable or invalid: ${terminal.error}`];
    } else if (terminal) {
      if (terminal.digest !== authority.terminal_teams_digest) {
        authorityFindings = [...authorityFindings, "Current terminal CTO team postimage digest does not match the exact dispatch conformance authority."];
      }
      for (const team of terminal.teams) {
        if (team.status !== "failed") continue;
        const findings = terminalTeamFindingsByFeature.get(team.feature_id) ?? [];
        findings.push(`CTO execution slice '${team.slice_id}' completed with failure; feature cannot be released.`);
        terminalTeamFindingsByFeature.set(team.feature_id, findings);
      }
    }
  }
  if (authority) {
    const currentClaimEntries = featureIds.flatMap((featureId) => {
      const claim = currentClaims.get(featureId);
      return claim ? [{
        claim_id: claim.claim_id,
        handoff_digest: claim.handoff_digest,
        owner_kind: claim.owner_kind,
        owner_run_id: claim.owner_run_id,
        status: claim.status,
        admission_binding: claim.admission_binding,
      }] : [];
    });
    const claimDigest = ctoConformanceClaimsDigest(currentClaimEntries);
    const callerClaimsHaveAdmissionBinding = Array.isArray(raw.claims)
      && raw.claims.some((candidate) => isRecord(candidate) && isRecord(candidate.admission_binding));
    const legacyClaimDigest = digestOf(currentClaimEntries.map((claim) => ({
      claim_id: claim.claim_id,
      handoff_digest: claim.handoff_digest,
      owner_kind: claim.owner_kind,
      owner_run_id: claim.owner_run_id,
      status: claim.status,
      admission_binding: null,
    })).sort(compareCanonical));
    if (claimDigest !== authority.active_claims_digest
      && (callerClaimsHaveAdmissionBinding || legacyClaimDigest !== authority.active_claims_digest)) {
      authorityFindings = [...authorityFindings, "Current active claim postimage does not match the exact dispatch conformance authority."];
    }
  }
  flagSharedCtoHandoffDigests(resolved);
  const evidenceBuckets = partitionCtoEvidenceByFrozenDigest(raw.evidence, pinnedRoot, resolved);
  const evidenceInputFindings = ctoEvidenceInputFindings(raw.evidence, pinnedRoot, resolved);
  const rawWaveQualityGates = raw.quality_gates;
  const waveQualityGates = rawWaveQualityGates === undefined
    ? []
    : Array.isArray(rawWaveQualityGates) ? rawWaveQualityGates : [];
  const features: CtoFeatureConformanceResult[] = [];
  const passingFeatureIds: string[] = [];
  const blockedFeatureIds: string[] = [];
  for (const featureId of featureIds) {
    const resolution = resolved.get(featureId)!;
    const suppliedHandoff = handoffGroups.get(featureId)?.[0];
    const workspace = workspaces.get(featureId) ?? null;
    const currentClaim = currentClaims.get(featureId) ?? null;
    const waveFindings = [
      ...resolution.findings,
      ...authorityFindings.map((message) => ctoWaveFinding(message, featureId)),
      ...(terminalTeamFindingsByFeature.get(featureId) ?? []).map((message) => ctoWaveFinding(message, featureId)),
      ...ctoClaimFindings(featureId, resolution.handoff, workspace, currentClaim, claimGroups.get(featureId) ?? [], boundRunId, canonicalRoot),
      ...evidenceInputFindings.map((message) => ctoWaveFinding(message, featureId)),
      ...(artifactDirectoryIssues.get(featureId) ?? []).map((message) => ctoWaveFinding(message, featureId)),
    ];
    const workspaceError = workspaceErrors.get(featureId);
    if (workspaceError) waveFindings.push(ctoWaveFinding(`Feature workspace resolution failed: ${workspaceError}`, featureId));
    const claimError = claimErrors.get(featureId);
    if (claimError) waveFindings.push(ctoWaveFinding(`Current durable claim could not be read: ${claimError}`, featureId));
    if (rawWaveQualityGates !== undefined && !Array.isArray(rawWaveQualityGates)) {
      waveFindings.push(ctoWaveFinding("CTO conformance quality_gates must be an array when supplied.", featureId));
    }
    const featureQualityGates = [
      ...waveQualityGates,
      ...(suppliedHandoff && Array.isArray(suppliedHandoff.quality_gates) ? suppliedHandoff.quality_gates : []),
    ];
    const normalizedEvidence = (evidenceBuckets.get(featureId) ?? []).map((item) => normalizeCtoEvidence(pinnedRoot, featureId, item));
    const normalizedQualityGates = featureQualityGates.map((gate) => normalizeCtoQualityGate(pinnedRoot, featureId, gate, true));
    waveFindings.push(...runtimeEnvelopeCompletenessIssues(featureId, normalizedEvidence, pinnedRoot).map((message) => ctoWaveFinding(message, featureId)));
    const selectedProfileHash = workspace?.profile_hash ?? "";
    const handoffValidation = validateImplementationHandoff(resolution.handoff);
    const derivedConstitutionGate = ctoConstitutionBindingGate(resolution.handoff, handoffValidation.ok);
    const mandatoryGates = [derivedConstitutionGate, ...normalizedQualityGates];
    for (const mandatoryIssue of ctoMandatoryQualityGateIssues(mandatoryGates, ctoMandatoryQualityGateSpecs(selectedProfileHash, resolution.handoff.handoff_id))) waveFindings.push(ctoWaveFinding(mandatoryIssue, featureId));
    waveFindings.sort(compareCanonical);
    const claim = trustedCtoClaim(currentClaim);
    const evaluatedInput: NormalizedInput = {
      handoff: resolution.handoff,
      claim,
      profile_hash: selectedProfileHash,
      evidence: normalizedEvidence,
      quality_gates: mandatoryGates,
      evaluated_at: "",
    };
    Object.defineProperty(evaluatedInput, NORMALIZATION_FINDINGS, { value: waveFindings, enumerable: false, configurable: false, writable: false });
    const matrix = evaluateImplementationConformance(evaluatedInput);
    // A release recommendation is possible only when the evaluated claim was
    // the current durable active claim and every authority finding is absent.
    const claimAction: CtoConformanceClaimAction = matrix.overall_status === "pass" && currentClaim?.status === "active" ? "release" : "retain";
    features.push({
      feature_id: featureId,
      handoff_digest: resolution.handoff_digest,
      matrix,
      result: { overall_status: matrix.overall_status, blocking_findings: matrix.blocking_findings },
      claim_action: claimAction,
    });
    if (claimAction === "release") passingFeatureIds.push(featureId);
    else blockedFeatureIds.push(featureId);
  }
  return { features, passing_feature_ids: passingFeatureIds, blocked_feature_ids: blockedFeatureIds };
}
 
/**
 * Engine-owned CTO fan-in result. The public route deliberately returns only
 * durable references and verdicts; callers never author or adopt the matrix.
 */
export interface PersistedCtoFeatureConformance {
  feature_id: string;
  conformance_id: string | null;
  artifact_ref: CompletionArtifactRef | null;
  overall_status: ConformanceOverallStatus;
  claim_action: CtoConformanceClaimAction;
  status: "persisted" | "blocked";
}

export interface PersistedCtoSpecificationConformanceResult {
  status: "ready" | "blocked";
  replayed: boolean;
  features: PersistedCtoFeatureConformance[];
  passing_feature_ids: string[];
  blocked_feature_ids: string[];
  findings: string[];
  /** False means no implementation-conformance artifact or workspace ref was adopted. */
  persisted?: boolean;
  /** Bounded repair/close routing hint for mounted callers. */
  next_action?: string;
}
function blockedCtoConformanceResult(
  input: EvaluateCtoSpecificationConformanceInput,
  finding: string,
): PersistedCtoSpecificationConformanceResult {
  const featureIds = Array.isArray(input?.mapping?.feature_ids)
    ? input.mapping.feature_ids.filter((id): id is string => typeof id === "string")
    : [];
  return {
    status: "blocked",
    replayed: false,
    features: featureIds.map((feature_id) => ({
      feature_id,
      conformance_id: null,
      artifact_ref: null,
      overall_status: "blocked",
      claim_action: "retain",
      status: "blocked",
    })),
    passing_feature_ids: [],
    blocked_feature_ids: featureIds,
    findings: [finding],
    persisted: false,
  };
}
/**
 * Read-only replay after the CTO terminal finalizer. This deliberately avoids
 * evaluator/adoption paths: only exact completed postimages authenticated by
 * the original dispatch binding can return existing artifact refs.
 */
export function terminalConformanceEvidenceError(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
  matrix: ImplementationConformanceResult,
  handoff: ImplementationHandoff,
  claim: ExecutionClaim,
): string | null {
  const semantic = validateConformanceAgainstHandoff(matrix, handoff, claim);
  if (!semantic.ok) return `feature '${featureId}' conformance matrix semantic binding failed: ${semantic.issues[0] ?? "unknown issue"}`;
  type ArtifactSchema = "conformance_evidence" | "quality_gate_evidence";
  type TerminalExpectedTestRow = { subject_id: string; requirement_id: string | null; test_kind: string; status: "pass" | "fail"; executed_at: string };
  type ArtifactContext = { value: unknown; schema: ArtifactSchema; topLevel: boolean; expectedContext?: string; expectedRuntimeRows?: readonly TerminalExpectedTestRow[]; canonicalQuality?: boolean };
  const references: ArtifactContext[] = [];
  const addReferences = (values: readonly unknown[], schema: ArtifactSchema, topLevel: boolean, expectedContext?: string, expectedRuntimeRows?: readonly TerminalExpectedTestRow[], canonicalQuality = false): void => {
    for (const value of values) references.push({ value, schema, topLevel, expectedContext, expectedRuntimeRows, canonicalQuality });
  };
  const expectedRuntimeRows: TerminalExpectedTestRow[] = matrix.entries.flatMap((entry) => entry.test_evidence.map((test) => ({
    subject_id: entry.subject_id,
    requirement_id: entry.requirement_id,
    test_kind: test.test_kind,
    status: test.status,
    executed_at: test.executed_at,
  })));
  const expectedPrefix = `.work-state/features/${featureId}/artifacts/`;
  const canonicalRuntimeArtifactId = `runtime_test_evidence-${featureId}`;
  const canonicalQualityArtifactId = `quality_gate_evidence-${featureId}`;
  try {
    const names = pinnedRoot.listDirectory(expectedPrefix.slice(0, -1));
    const expectedRuntimeName = `${canonicalRuntimeArtifactId}.json`;
    for (const name of names) {
      if (name.startsWith("implementation_evidence-")) return `feature ${featureId} conformance contains forbidden standalone implementation evidence artifact ${name}`;
      if (name.startsWith("runtime_test_evidence-") && name !== expectedRuntimeName) return `feature ${featureId} conformance contains an alternate runtime evidence artifact ${name}`;
    }
    if (expectedRuntimeRows.length === 0 && names.includes(expectedRuntimeName)) return `feature ${featureId} conformance contains an unused canonical runtime evidence artifact`;
  } catch {
    return `feature ${featureId} conformance artifact directory could not be enumerated safely`;
  }
  for (const entry of matrix.entries) {
    const subjectContext = `${entry.subject_id}:${entry.requirement_id}`;
    for (const reference of entry.implementation_evidence_refs) addReferences([reference], "conformance_evidence", true, `implementation:${subjectContext}`);
    for (const reference of entry.review_evidence_refs) addReferences([reference], "conformance_evidence", true, `review:${subjectContext}`);
    for (const test of entry.test_evidence) addReferences([test.evidence_ref], "conformance_evidence", true, undefined, expectedRuntimeRows);
  }
  const mandatoryGateIssues = ctoMandatoryQualityGateIssues(
    matrix.quality_gate_results,
    ctoMandatoryQualityGateSpecs(matrix.profile_hash, matrix.handoff_id),
    { requirePass: matrix.overall_status === "pass" },
  );
  if (mandatoryGateIssues.length > 0) return `feature '${featureId}' conformance mandatory quality gate validation failed: ${mandatoryGateIssues[0]}`;
  for (const gate of matrix.quality_gate_results) addReferences(gate.evidence_refs, "quality_gate_evidence", true, gate.gate_id, undefined, true);
  if (references.length === 0) return `feature '${featureId}' conformance has no worker evidence references`;
  const seen = new Set<string>();
  const schemaFor = (value: unknown): ArtifactSchema | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.artifact_schema === "conformance_evidence" || record.artifact_schema === "quality_gate_evidence") return record.artifact_schema;
    const hasEntries = Array.isArray(record.entries);
    const hasGates = Array.isArray(record.gates);
    return hasEntries === hasGates ? null : hasEntries ? "conformance_evidence" : "quality_gate_evidence";
  };
  const inspect = (candidate: unknown, requiredSchema: ArtifactSchema | "either", topLevel: boolean, depth: number, expectedContext?: string, expectedRows?: readonly TerminalExpectedTestRow[], canonicalQuality = false): string | null => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return `feature '${featureId}' conformance contains an invalid evidence reference`;
    const reference = candidate as Record<string, unknown>;
    const artifactId = typeof reference.artifact_id === "string" ? reference.artifact_id : "";
    const artifactPath = typeof reference.path === "string" ? reference.path : "";
    const expectedPath = `${expectedPrefix}${artifactId}.json`;
    if (!isCtoSpecificationSafeId(artifactId) || !isSafeRelativePath(artifactPath) || artifactPath !== expectedPath) return `feature '${featureId}' conformance evidence reference is outside its canonical artifact store`;
    if (canonicalQuality && artifactId !== canonicalQualityArtifactId) return `feature '${featureId}' quality evidence must use the canonical artifact '${canonicalQualityArtifactId}'`;
    if (reference.schema_status !== "met" || reference.quality_gate_status !== "met") return `feature '${featureId}' conformance evidence reference '${artifactId}' is not a current met artifact`;
    if (!isSha256Hex(reference.sha256)) return `feature '${featureId}' conformance evidence reference '${artifactId}' has no valid digest`;
    if (depth > 8) return `feature '${featureId}' conformance evidence nesting exceeded the maximum depth`;
    const seenKey = `${requiredSchema}:${artifactId}:${artifactPath}:${reference.sha256}:${expectedContext ?? ""}`;
    if (seen.has(seenKey)) return null;
    seen.add(seenKey);
    let snapshot: { bytes: Uint8Array };
    try {
      if (!pinnedRoot.isStable()) return `feature '${featureId}' conformance evidence root changed before artifact read`;
      snapshot = pinnedRoot.readFile(artifactPath, { maxBytes: MAX_CONFORMANCE_ARTIFACT_BYTES });
      if (!pinnedRoot.isStable()) return `feature '${featureId}' conformance evidence root changed while reading artifact`;
    } catch {
      return `feature '${featureId}' conformance evidence artifact '${artifactId}' is unreadable`;
    }
    const digest = createHash("sha256").update(snapshot.bytes).digest("hex");
    if (digest !== reference.sha256) return `feature '${featureId}' conformance evidence artifact '${artifactId}' digest is stale`;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes)) as unknown; }
    catch { return `feature '${featureId}' conformance evidence artifact '${artifactId}' is not valid JSON`; }
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).artifact_id !== artifactId) return `feature '${featureId}' conformance evidence artifact '${artifactId}' has a mismatched internal artifact_id`;
    const schema = schemaFor(value);
    if (!schema || (requiredSchema !== "either" && schema !== requiredSchema)) return `feature '${featureId}' conformance evidence artifact '${artifactId}' has the wrong explicit artifact schema`;
    const validation = validateProducedArtifact(schema, value);
    if (!validation.ok) return `feature '${featureId}' conformance evidence artifact '${artifactId}' failed its producer contract`;
    if (schema === "conformance_evidence") {
      const entries = (value as Record<string, unknown>).entries;
      if (!Array.isArray(entries) || entries.length === 0) return `feature '${featureId}' conformance evidence artifact '${artifactId}' has no entries`;
      let contextMatched = expectedContext === undefined;
      const runtimeEnvelope = expectedRows !== undefined;
      const seenRuntimeRows = new Set<string>();
      const matchedRuntimeRows = new Set<number>();
      if (runtimeEnvelope) {
        if (artifactId !== canonicalRuntimeArtifactId) return `feature '${featureId}' runtime evidence must use the canonical artifact '${canonicalRuntimeArtifactId}'`;
        const canonicalRuntimePath = `${expectedPrefix}${canonicalRuntimeArtifactId}.json`;
        if (artifactPath !== canonicalRuntimePath) return `feature '${featureId}' runtime evidence must use the canonical path '${canonicalRuntimePath}'`;
      }
      for (const rawEntry of entries) {
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return `feature '${featureId}' conformance evidence artifact '${artifactId}' contains an invalid entry`;
        const entry = rawEntry as Record<string, unknown>;
        if (entry.handoff_digest !== matrix.handoff_digest || entry.execution_claim_id !== matrix.execution_claim_id) return `feature '${featureId}' conformance evidence artifact '${artifactId}' contains foreign handoff or claim context`;
        if (expectedContext !== undefined && `${String(entry.kind)}:${String(entry.subject_id)}:${String(entry.requirement_id)}` === expectedContext) contextMatched = true;
        const test = entry.test;
        if (runtimeEnvelope) {
          if (entry.kind !== "executed_test" || !test || typeof test !== "object" || Array.isArray(test)) return `feature '${featureId}' runtime evidence contains a non-test entry`;
          const testRecord = test as Record<string, unknown>;
          const rowKey = JSON.stringify([entry.subject_id, entry.requirement_id, testRecord.test_kind, testRecord.status, testRecord.executed_at]);
          if (seenRuntimeRows.has(rowKey)) return `feature '${featureId}' runtime evidence contains duplicate executed_test rows`;
          seenRuntimeRows.add(rowKey);
          const expectedIndex = expectedRows!.findIndex((expected) => JSON.stringify([expected.subject_id, expected.requirement_id, expected.test_kind, expected.status, expected.executed_at]) === rowKey);
          if (expectedIndex < 0) return `feature '${featureId}' runtime evidence contains an unrelated executed_test row`;
          matchedRuntimeRows.add(expectedIndex);
          const nested = inspect(testRecord.evidence_ref, "quality_gate_evidence", false, depth + 1, undefined, undefined, true);
          if (nested) return nested;
        } else if (entry.kind === "executed_test" && test && typeof test === "object" && !Array.isArray(test)) {
          const nested = inspect((test as Record<string, unknown>).evidence_ref, "either", false, depth + 1);
          if (nested) return nested;
        }
      }
      if (expectedContext !== undefined && !contextMatched) return `feature '${featureId}' conformance evidence artifact '${artifactId}' contains no entry for the exact closure-row context`;
      if (runtimeEnvelope) {
        if (entries.length !== expectedRows!.length || expectedRows!.some((_, index) => !matchedRuntimeRows.has(index))) return `feature '${featureId}' runtime evidence rows do not exactly match outer executed_test rows`;
      }
    } else {
      const gates = (value as Record<string, unknown>).gates;
      if (!Array.isArray(gates) || gates.length === 0) return `feature '${featureId}' quality gate artifact '${artifactId}' has no gates`;
      if (expectedContext !== undefined && !gates.some((gate) => gate && typeof gate === "object" && !Array.isArray(gate) && (gate as Record<string, unknown>).gate_id === expectedContext)) return `feature '${featureId}' quality gate artifact '${artifactId}' contains no matrix-matching gate`;
      for (const gate of gates) {
        if (!gate || typeof gate !== "object" || Array.isArray(gate)) continue;
        const nestedRefs = (gate as Record<string, unknown>).evidence_refs;
        if (!Array.isArray(nestedRefs)) continue;
        if (canonicalQuality && nestedRefs.length > 0) return `feature '${featureId}' canonical quality evidence must persist empty evidence_refs`;
        for (const nestedRef of nestedRefs) {
          const nested = inspect(nestedRef, "either", false, depth + 1);
          if (nested) return nested;
        }
      }
    }
    return null;
  };
  for (const reference of references) {
    const error = inspect(reference.value, reference.schema, reference.topLevel, 0, reference.expectedContext, reference.expectedRuntimeRows, reference.canonicalQuality);
    if (error) return error;
  }
  return null;
}

function readTerminalCtoConformanceReplay(
  input: EvaluateCtoSpecificationConformanceInput,
  authority: Readonly<CtoSpecificationConformanceAuthority>,
  pinnedRoot: PinnedProjectRoot,
  transaction: CtoRunTransactionFacade,
): PersistedCtoSpecificationConformanceResult | null {
  const state = transaction.readState();
  const callerMapping = isRecord(input.mapping) ? input.mapping : {};
  const mappingRecord = ctoMappingRecordResolution(pinnedRoot.canonical_root, callerMapping, authority, pinnedRoot);
  if (!mappingRecord.snapshot || mappingRecord.issues.length > 0) return null;
  const mapping = mappingRecord.snapshot.mapping;
  const execution = isRecord(mapping.execution) ? mapping.execution : null;
  if (
    mapping.status !== "confirmed"
    || mapping.execution_choice !== "cto"
    || !execution
    || execution.choice !== "cto"
    || typeof execution.wave_id !== "string"
    || typeof execution.source_id !== "string"
    || typeof execution.capability_id !== "string"
    || typeof execution.capability_epoch !== "string"
  ) return null;
  const handoffBindings = Array.isArray(mapping.handoff_bindings)
    ? mapping.handoff_bindings.filter(isRecord)
    : [];
  const wave = state.wave_history?.find((candidate) => candidate.id === execution.wave_id);
  if (
    !wave
    || wave.source !== "specification-execution"
    || wave.status !== "done"
    || state.active_wave_id !== undefined
  ) return null;
  const receiptRead = wave.conformance_receipt_ref === undefined
    ? null
    : readCtoSpecificationConformanceReceipt(pinnedRoot, authority.cto_run_id, wave.conformance_receipt_ref);
  if (receiptRead && (!receiptRead.ok
    || receiptRead.value.cto_run_id !== authority.cto_run_id
    || receiptRead.value.wave_id !== execution.wave_id
    || receiptRead.value.mapping_id !== authority.mapping_id
    || receiptRead.value.mapping_record_digest !== authority.mapping_record_digest
    || receiptRead.value.conformance_capability_id !== ctoConformanceCapabilityId(authority)
    || receiptRead.value.active_claims_digest !== authority.active_claims_digest
    || receiptRead.value.terminal_teams_digest !== authority.terminal_teams_digest)) return null;
  const admittedSlices = Array.isArray(mapping.parallelization)
    ? mapping.parallelization.filter(isRecord).map((decision) => decision.slice_id).filter((sliceId): sliceId is string => typeof sliceId === "string")
    : null;
  if (!admittedSlices || !ctoMappingExecutionMatchesWave(execution, wave, authority.cto_run_id, admittedSlices, state.teams.map((team) => team.work_identity))) return null;
  const rootSnapshot: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };
  const terminalClaims: CtoActiveClaimSummary[] = [];
  const persistedFeatures: PersistedCtoFeatureConformance[] = [];
  const replayFindings: string[] = [];
  for (const featureId of mappingRecord.feature_ids) {
    const selection = mappingRecord.selectors.get(featureId);
    if (!selection) return null;
    const suppliedHandoff = input.handoffs.find((handoff) => handoff.feature_id === featureId);
    if (!suppliedHandoff || suppliedHandoff.run_key !== selection.run_key) return null;
    const workspaceResult = resolveFeatureWorkspace(
      pinnedRoot.canonical_root,
      selection,
      rootSnapshot,
      { persistMigration: false },
    );
    if (!workspaceResult.ok) return null;
    const workspace = workspaceResult.value;
    const claimRead = readCurrentExecutionClaim(pinnedRoot.canonical_root, featureId, pinnedRoot);
    if (!claimRead.ok || !claimRead.value) return null;
    const claim = claimRead.value;
    const admission = claim.admission_binding;
    const binding = handoffBindings.find((candidate) => candidate.feature_id === featureId);
    const completedPostimage = workspace.status === "completed" && claim.status === "completed";
    const blockedPostimage =
      ["claimed", "executing", "completion_validating", "completion_blocked"].includes(workspace.status)
      && (claim.status === "active" || claim.status === "blocked");
    if (
      (!completedPostimage && !blockedPostimage)
      || workspace.execution_claim_ref !== claim.claim_id
      || !workspace.implementation_conformance_ref
      || !binding
      || suppliedHandoff.handoff.handoff_digest !== binding.handoff_digest
      || claim.owner_kind !== "cto"
      || claim.owner_run_id !== authority.cto_run_id
      || claim.handoff_digest !== binding.handoff_digest
      || !admission
      || admission.mapping_record_digest !== authority.mapping_record_digest
      || admission.mapping_id !== authority.mapping_id
      || admission.mapping_hash !== authority.mapping_hash
      || admission.wave_id !== execution.wave_id
      || admission.capability_id !== execution.capability_id
      || admission.capability_epoch !== execution.capability_epoch
      || admission.checkpoint_ref !== authority.checkpoint_id
      || admission.trusted_answer_ref !== authority.trusted_answer_id
    ) return null;
    if (!workspace.handoff_ref) return null;
    const canonicalHandoff = readArtifactPinned<ImplementationHandoff>(
      pinnedRoot,
      `.work-state/features/${featureId}/artifacts/implementation_handoff`,
      workspace.handoff_ref,
    );
    if (
      !canonicalHandoff
      || !validateImplementationHandoff(canonicalHandoff).ok
      || canonicalHandoff.feature_id !== featureId
      || canonicalHandoff.handoff_id !== workspace.handoff_ref
      || canonicalHandoff.handoff_id !== binding.handoff_id
      || canonicalHandoff.handoff_digest !== binding.handoff_digest
      || canonicalHandoff.handoff_digest !== claim.handoff_digest
      || canonicalHandoff.handoff_digest !== canonicalHandoffDigest(canonicalHandoff)
    ) return null;
    const mappingRecordPath = pinnedRoot.relativePath(authority.mapping_record_path);
    const mappingVersion = typeof mapping.mapping_version === "number" ? mapping.mapping_version : -1;
    if (!mappingRecordPath) return null;
    const admissionVerification = verifyExecutionClaimAdmissionBindingPinned(pinnedRoot, {
      feature_id: featureId,
      run_key: selection.run_key,
      owner_run_id: authority.cto_run_id,
      workspace,
      claim,
      handoff: canonicalHandoff,
      verification_mode: "terminal",
      mapping: {
        selected_feature_id: featureId,
        selected_run_key: selection.run_key,
        mapping_record_path: mappingRecordPath,
        mapping_record_digest: authority.mapping_record_digest,
        mapping_id: authority.mapping_id,
        mapping_hash: authority.mapping_hash,
        mapping_version: mappingVersion,
        checkpoint_ref: authority.checkpoint_id,
        trusted_answer_ref: authority.trusted_answer_id,
        wave_id: execution.wave_id,
        capability_id: execution.capability_id,
        capability_epoch: execution.capability_epoch,
      },
    });
    if (!admissionVerification.ok) return null;
    const conformanceId = workspace.implementation_conformance_ref;
    let matrixSnapshot: PinnedArtifactSnapshot | null = null;
    try {
      matrixSnapshot = readPinnedArtifactSnapshot(
        pinnedRoot,
        `.work-state/features/${featureId}/artifacts/implementation_conformance`,
        conformanceId,
        { verifyPathAfterRead: true },
      );
    } catch {
      matrixSnapshot = null;
    }
    const matrix = matrixSnapshot?.value as ImplementationConformanceResult | null;
    const matrixIsTerminal = matrix?.overall_status === "pass"
      || matrix?.overall_status === "blocked"
      || matrix?.overall_status === "changed_intent";
    const matrixSemantic = matrix ? validateConformanceAgainstHandoff(matrix, canonicalHandoff, claim) : null;
    const matrixMandatoryGateIssues = matrix
      ? ctoMandatoryQualityGateIssues(
        matrix.quality_gate_results,
        ctoMandatoryQualityGateSpecs(matrix.profile_hash, matrix.handoff_id),
        { requirePass: matrix.overall_status === "pass" },
      )
      : ["terminal matrix is missing"];
    const matrixEvidenceError = matrix
      ? terminalConformanceEvidenceError(pinnedRoot, featureId, matrix, canonicalHandoff, claim)
      : "terminal matrix is missing";
    if (
      !matrixSnapshot
      || !matrix
      || !validateProducedArtifact("implementation_conformance", matrix).ok
      || !matrixIsTerminal
      || !matrixSemantic?.ok
      || matrixMandatoryGateIssues.length > 0
      || matrixEvidenceError !== null
      || matrix.conformance_id !== conformanceId
      || matrix.matrix_digest !== implementationConformanceMatrixDigest(matrix)
      || matrix.feature_id !== featureId
      || matrix.handoff_id !== canonicalHandoff.handoff_id
      || matrix.handoff_digest !== canonicalHandoff.handoff_digest
      || matrix.profile_hash !== workspace.profile_hash
      || matrix.execution_owner !== "cto"
      || matrix.execution_run_id !== authority.cto_run_id
      || matrix.execution_claim_id !== claim.claim_id
      || matrix.handoff_digest !== claim.handoff_digest
      || (completedPostimage && matrix.overall_status !== "pass")
      || (blockedPostimage && matrix.overall_status === "pass")
    ) return null;
    if (matrix.overall_status !== "pass") {
      for (const finding of matrix.blocking_findings) {
        if (replayFindings.length < 128) replayFindings.push(`Feature '${featureId}': ${finding.message}`.slice(0, 4096));
      }
    }
    const artifactPath = matrixSnapshot.path;
    terminalClaims.push({
      feature_id: featureId,
      claim_id: claim.claim_id,
      handoff_digest: claim.handoff_digest,
      owner_kind: claim.owner_kind,
      owner_run_id: claim.owner_run_id,
      status: claim.status,
      admission_binding: claim.admission_binding,
    });
    persistedFeatures.push({
      feature_id: featureId,
      conformance_id: conformanceId,
      artifact_ref: {
        artifact_id: conformanceId,
        path: artifactPath,
        sha256: matrixSnapshot.sha256,
        schema_status: "met",
        quality_gate_status: matrix.overall_status === "pass" ? "met" : "failed",
      },
      overall_status: matrix.overall_status,
      claim_action: matrix.overall_status === "pass" ? "release" : "retain",
      status: "persisted",
    });
  }
  const terminalAuthorityClaims = terminalClaims.map((claim) => ({
    ...claim,
    // Dispatch authority is issued against the active claim postimage. A
    // blocked closure is a supported terminal replay, but its claim status is
    // normalized to that same active authority for digest comparison.
    status: claim.status === "completed" || claim.status === "blocked" ? "active" as const : claim.status,
  }));
  if (ctoConformanceClaimsDigest(terminalAuthorityClaims) !== authority.active_claims_digest) return null;
  const passingFeatureIds = persistedFeatures
    .filter((feature) => feature.overall_status === "pass")
    .map((feature) => feature.feature_id);
  const blockedFeatureIds = persistedFeatures
    .filter((feature) => feature.overall_status !== "pass")
    .map((feature) => feature.feature_id);
  const replayOutcome = blockedFeatureIds.length > 0 ? "blocked" : "pass";
  if (wave.status !== "done" || state.active_wave_id !== undefined || wave.outcome !== replayOutcome) return null;
  const receiptRows = receiptRowsFromPersistedFeatures(persistedFeatures, input, mappingRecord.selectors, pinnedRoot);
  if (!receiptRows) return null;
  if (receiptRead && canonicalJson(receiptRows) !== canonicalJson(receiptRead.value.features)) return null;
  if (!receiptRead) {
    const repaired = repairLegacyTerminalCtoConformanceReceipt(input, pinnedRoot, authority, mappingRecord.selectors, persistedFeatures, transaction);
    if (!repaired.ok) return null;
  }
  return {
    status: replayOutcome === "blocked" ? "blocked" : "ready",
    replayed: true,
    features: persistedFeatures,
    passing_feature_ids: passingFeatureIds,
    blocked_feature_ids: blockedFeatureIds,
    findings: replayFindings,
    persisted: true,
  };
}

function hasCompletedCtoWorkspacePostimages(
  input: EvaluateCtoSpecificationConformanceInput,
  pinnedRoot: PinnedProjectRoot,
  state: ReturnType<typeof readCtoStatePinned>,
): boolean {
  if (!state || state.active_wave_id === undefined) return false;
  const mapping = (isRecord(input.mapping) ? input.mapping : {}) as Record<string, unknown>;
  const execution = isRecord(mapping.execution) ? mapping.execution : null;
  if (!execution || state.active_wave_id !== execution.wave_id || typeof execution.wave_id !== "string") return false;
  const featureIds = Array.isArray(mapping.feature_ids)
    ? mapping.feature_ids.filter((featureId): featureId is string => typeof featureId === "string")
    : [];
  if (featureIds.length === 0) return false;
  const rootSnapshot: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };
  return featureIds.every((featureId) => {
    const handoff = input.handoffs.find((candidate) => candidate.feature_id === featureId);
    if (!handoff) return false;
    const workspace = resolveFeatureWorkspace(
      pinnedRoot.canonical_root,
      { feature_id: featureId, run_key: handoff.run_key },
      rootSnapshot,
      { persistMigration: false },
    );
    return workspace.ok && workspace.value.status === "completed" && typeof workspace.value.implementation_conformance_ref === "string";
  });
}
function validateActiveCtoConformanceAuthority(
  input: EvaluateCtoSpecificationConformanceInput,
  authority: Readonly<CtoSpecificationConformanceAuthority>,
  pinnedRoot: PinnedProjectRoot,
): { ok: true } | { ok: false; error: string } {
  const state = readCtoStatePinned(authority.cto_run_id, pinnedRoot);
  const mapping = isRecord(input.mapping) ? input.mapping : {};
  const mappingRecord = ctoMappingRecordResolution(pinnedRoot.canonical_root, mapping, authority, pinnedRoot);
  if (!state || state.active_wave_id === undefined) return { ok: false, error: "canonical active CTO specification wave is unavailable" };
  if (!mappingRecord.snapshot || mappingRecord.issues.length > 0) {
    return { ok: false, error: mappingRecord.issues[0] ?? "durable CTO mapping authority is invalid" };
  }
  const frozenMapping = mappingRecord.snapshot.mapping;
  const execution = isRecord(frozenMapping.execution) ? frozenMapping.execution : null;
  const wave = execution && typeof execution.wave_id === "string"
    ? state.wave_history?.find((candidate) => candidate.id === execution.wave_id)
    : undefined;
  const admittedSlices = Array.isArray(frozenMapping.parallelization)
    ? frozenMapping.parallelization.filter(isRecord).map((decision) => decision.slice_id).filter((sliceId): sliceId is string => typeof sliceId === "string")
    : null;
  if (
    !execution
    || execution.choice !== "cto"
    || state.active_wave_id !== execution.wave_id
    || !wave
    || wave.status !== "active"
    || !admittedSlices
    || !ctoMappingExecutionMatchesWave(execution, wave, authority.cto_run_id, admittedSlices, state.teams.map((team) => team.work_identity))
  ) return { ok: false, error: "CTO conformance authority is stale because its execution wave is not active" };
  const rootSnapshot: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };
  const bindings = Array.isArray(frozenMapping.handoff_bindings)
    ? frozenMapping.handoff_bindings.filter(isRecord)
    : [];
  const activeClaims: CtoActiveClaimSummary[] = [];
  for (const featureId of mappingRecord.feature_ids) {
    const selection = mappingRecord.selectors.get(featureId);
    const suppliedHandoff = input.handoffs.find((handoff) => handoff.feature_id === featureId);
    const binding = bindings.find((candidate) => candidate.feature_id === featureId);
    if (!selection || !suppliedHandoff || !binding || suppliedHandoff.run_key !== selection.run_key) {
      return { ok: false, error: `CTO conformance authority has an incomplete selector or handoff binding for '${featureId}'` };
    }
    const workspaceResult = resolveFeatureWorkspace(
      pinnedRoot.canonical_root,
      selection,
      rootSnapshot,
      { persistMigration: false },
    );
    if (!workspaceResult.ok) return { ok: false, error: workspaceResult.error };
    const workspace = workspaceResult.value;
    const claimRead = readCurrentExecutionClaim(pinnedRoot.canonical_root, featureId, pinnedRoot);
    if (!claimRead.ok || !claimRead.value) return { ok: false, error: claimRead.ok ? `feature '${featureId}' has no active CTO claim` : claimRead.error };
    const claim = claimRead.value;
    if (
      (workspace.status !== "claimed" && workspace.status !== "executing")
      || workspace.execution_claim_ref !== claim.claim_id
      || workspace.handoff_ref !== binding.handoff_id
      || suppliedHandoff.handoff.handoff_digest !== binding.handoff_digest
      || claim.status !== "active"
      || claim.owner_kind !== "cto"
      || claim.owner_run_id !== authority.cto_run_id
      || claim.handoff_digest !== binding.handoff_digest
      || !claim.admission_binding
      || claim.admission_binding.mapping_record_digest !== authority.mapping_record_digest
      || claim.admission_binding.mapping_id !== authority.mapping_id

      || claim.admission_binding.mapping_hash !== authority.mapping_hash
      || claim.admission_binding.wave_id !== execution.wave_id
      || claim.admission_binding.capability_id !== execution.capability_id
      || claim.admission_binding.capability_epoch !== execution.capability_epoch
      || claim.admission_binding.checkpoint_ref !== authority.checkpoint_id
      || claim.admission_binding.trusted_answer_ref !== authority.trusted_answer_id
    ) return { ok: false, error: `feature '${featureId}' active workspace or CTO claim no longer matches conformance authority` };
    const mappingRecordPath = pinnedRoot.relativePath(authority.mapping_record_path);
    const mappingVersion = typeof frozenMapping.mapping_version === "number" ? frozenMapping.mapping_version : -1;
    if (!mappingRecordPath) return { ok: false, error: "CTO conformance authority mapping record path is outside the pinned root" };
    const admissionVerification = verifyExecutionClaimAdmissionBindingPinned(pinnedRoot, {
      feature_id: featureId,
      run_key: selection.run_key,
      owner_run_id: authority.cto_run_id,
      workspace,
      claim,
      handoff: suppliedHandoff.handoff,
      verification_mode: "terminal",
      mapping: {
        selected_feature_id: featureId,
        selected_run_key: selection.run_key,
        mapping_record_path: mappingRecordPath,
        mapping_record_digest: authority.mapping_record_digest,
        mapping_id: authority.mapping_id,
        mapping_hash: authority.mapping_hash,
        mapping_version: mappingVersion,
        checkpoint_ref: authority.checkpoint_id,
        trusted_answer_ref: authority.trusted_answer_id,
        wave_id: execution.wave_id,
        capability_id: execution.capability_id,
        capability_epoch: execution.capability_epoch,
      },
    });
    if (!admissionVerification.ok) return { ok: false, error: `feature '${featureId}' claim admission binding is invalid: ${admissionVerification.error}` };
    activeClaims.push({
      feature_id: featureId,
      claim_id: claim.claim_id,
      handoff_digest: claim.handoff_digest,
      owner_kind: claim.owner_kind,
      owner_run_id: claim.owner_run_id,
      status: claim.status,
      admission_binding: claim.admission_binding,
    });
  }
  if (ctoConformanceClaimsDigest(activeClaims) !== authority.active_claims_digest) {
    return { ok: false, error: "active CTO claim postimage does not match conformance authority" };
  }
  return { ok: true };
}
/**
 * Validate all caller-supplied CTO evidence envelopes before the producer
 * evaluates or persists any feature matrix. The durable mapping determines
 * the only feature artifact stores that may be referenced.
 */
function ctoEvidenceBoundaryIssues(
  input: EvaluateCtoSpecificationConformanceInput,
  authority: Readonly<CtoSpecificationConformanceAuthority>,
  pinnedRoot: PinnedProjectRoot,
): string[] {
  const mapping = isRecord(input.mapping) ? input.mapping : {};
  const mappingRecord = ctoMappingRecordResolution(pinnedRoot.canonical_root, mapping, authority, pinnedRoot);
  const featureIds = mappingRecord.snapshot?.feature_ids ?? [];
  const issues: string[] = [];
  const add = (message: string): void => {
    if (issues.length < 128) issues.push(message.slice(0, 4096));
  };
  const featureForReference = (reference: unknown): string | null => {
    if (!isRecord(reference) || typeof reference.artifact_id !== "string" || typeof reference.path !== "string") return null;
    for (const featureId of featureIds) {
      const expected = relative(
        pinnedRoot.canonical_root,
        join(featureArtifactsDir(pinnedRoot.canonical_root, featureId), `${reference.artifact_id}.json`),
      ).split(sep).join("/");
      if (reference.path === expected) return featureId;
    }
    return null;
  };
  const evidenceArtifacts = new Map<string, CanonicalCtoArtifact>();
  const reportedEvidenceArtifacts = new Set<string>();
  const entriesByFeature = new Map<string, CtoTypedEvidenceEntry[]>();
  const rawEvidence = Array.isArray(input.evidence) ? input.evidence : [];
  for (const submitted of rawEvidence) {
    const reference = isRecord(submitted) ? submitted.artifact : null;
    const featureId = featureForReference(reference);
    if (!featureId) {
      add(`CTO conformance evidence reference '${String(isRecord(reference) ? reference.artifact_id : "unknown")}' does not resolve to a selected feature artifact store`);
      continue;
    }
    const artifactId = String(isRecord(reference) ? reference.artifact_id : "unknown");
    const evidenceKey = `${featureId}:${artifactId}`;
    let artifact = evidenceArtifacts.get(evidenceKey);
    if (!artifact) {
      artifact = readCanonicalCtoArtifact(
        pinnedRoot,
        featureId,
        reference as CompletionArtifactRef,
        `Evidence '${String(isRecord(submitted) ? submitted.evidence_id : "unknown")}' artifact`,
        "conformance_evidence",
      );
      evidenceArtifacts.set(evidenceKey, artifact);
    }
    if (artifact.issues.length > 0) {
      if (!reportedEvidenceArtifacts.has(evidenceKey)) {
        reportedEvidenceArtifacts.add(evidenceKey);
        for (const issue of artifact.issues) add(issue);
      }
      continue;
    }
    const selected = typedEvidenceEntry(
      artifact,
      typeof submitted?.evidence_id === "string" ? submitted.evidence_id : null,
      `Evidence '${String(submitted?.evidence_id ?? "unknown")}' artifact`,
    );
    for (const issue of selected.issues) add(issue);
    if (!selected.entry) continue;
    const submittedRecord = isRecord(submitted) ? submitted : {};
    for (const field of ["evidence_id", "kind", "subject_id", "requirement_id", "handoff_digest", "execution_claim_id"] as const) {
      if (submittedRecord[field] !== selected.entry[field]) {
        add(`Evidence '${String(selected.entry.evidence_id)}' ${field} does not match its canonical artifact entry`);
      }
    }
    const entries = entriesByFeature.get(featureId) ?? [];
    entries.push(selected.entry);
    entriesByFeature.set(featureId, entries);
    if (selected.entry.kind === "executed_test" && selected.entry.test) {
      const testArtifact = readCanonicalCtoArtifactByContent(
        pinnedRoot,
        featureId,
        selected.entry.test.evidence_ref,
        "Evidence " + selected.entry.evidence_id + " executed-test artifact",
        "conformance_evidence", 
      );
      for (const issue of nestedRuntimeNormalizationIssues(featureId, testArtifact, selected.entry, pinnedRoot)) add(issue);
    }
  }
  const featuresWithTests = new Set(
    [...entriesByFeature.entries()]
      .filter(([, entries]) => entries.some((entry) => entry.kind === "executed_test" && entry.test))
      .map(([featureId]) => featureId),
  );
  const boundaryDirectoryIssues = canonicalCtoArtifactDirectoryIssues(pinnedRoot, featureIds, featuresWithTests);
  for (const messages of boundaryDirectoryIssues.values()) for (const message of messages) add(message);
  const rawQualityGates = input.quality_gates;
  if (Array.isArray(rawQualityGates)) {
    const seenGates = new Set<string>();
    for (const submitted of rawQualityGates) {
      if (!isRecord(submitted) || !Array.isArray(submitted.evidence_refs)) {
        add("CTO conformance quality_gates contains a malformed gate envelope");
        continue;
      }
      for (const reference of submitted.evidence_refs) {
        const featureId = featureForReference(reference);
        if (!featureId) {
          add(`CTO conformance quality-gate reference '${String(isRecord(reference) ? reference.artifact_id : "unknown")}' does not resolve to a selected feature artifact store`);
          continue;
        }
        const evidenceKey = `${featureId}:${String(isRecord(reference) ? reference.artifact_id : "unknown")}`;
        if (seenGates.has(evidenceKey)) continue;
        seenGates.add(evidenceKey);
        const artifact = readCanonicalCtoArtifact(
          pinnedRoot,
          featureId,
          reference as CompletionArtifactRef,
          `Quality gate '${String(submitted.gate_id ?? "unknown")}' artifact`,
          "quality_gate_evidence",
        );
        for (const issue of artifact.issues) add(issue);
        if (artifact.issues.length === 0) {
          for (const issue of typedQualityGateIssues(artifact.value, `Quality gate '${String(submitted.gate_id ?? "unknown")}' artifact`)) add(issue);
          if (isRecord(artifact.value) && Array.isArray(artifact.value.gates)) {
            for (const gate of artifact.value.gates) {
              if (isRecord(gate) && Array.isArray(gate.evidence_refs) && gate.evidence_refs.length > 0) add(`Quality gate artifact '${artifact.reference.artifact_id}' must persist empty evidence_refs`);
            }
          }
        }
      }
    }
  }
  const state = readCtoStatePinned(authority.cto_run_id, pinnedRoot);
  const frozenMapping = mappingRecord.snapshot?.mapping;
  const execution = isRecord(frozenMapping?.execution) ? frozenMapping.execution : null;
  const rootSnapshot: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };
  if (!state) {
    add("CTO conformance cannot validate worker evidence without the canonical CTO state");
  }
  if (!execution || typeof execution.wave_id !== "string" || typeof execution.capability_id !== "string" || typeof execution.capability_epoch !== "string") {
    add("CTO conformance mapping has no exact execution work identity");
  }
  const handoffBindings = Array.isArray(frozenMapping?.handoff_bindings)
    ? frozenMapping.handoff_bindings.filter(isRecord)
    : [];
  const taskRows = Array.isArray(frozenMapping?.task_to_slice)
    ? frozenMapping.task_to_slice.filter(isRecord)
    : [];
  const selectedFeatureSet = new Set(featureIds);
  for (const taskRow of taskRows) {
    if (typeof taskRow.feature_id !== "string" || !selectedFeatureSet.has(taskRow.feature_id)) {
      add("CTO conformance mapping contains a task projection row for a foreign feature '" + String(taskRow.feature_id) + "'.");
    }
  }
  const inputClaimsByFeature = groupCtoRecordsByFeature(input.claims);
  const teams = state?.teams ?? [];
  for (const featureId of featureIds) {
    const selection = mappingRecord.selectors.get(featureId);
    const binding = handoffBindings.find((candidate) => candidate.feature_id === featureId);
    const submittedHandoffs = (Array.isArray(input.handoffs) ? input.handoffs : []).filter((candidate) => candidate.feature_id === featureId);
    const submittedClaims = inputClaimsByFeature.get(featureId) ?? [];
    if (!selection) {
      add(`Feature '${featureId}' has no canonical feature/run selector`);
      continue;
    }
    if (submittedHandoffs.length !== 1) {
      add(`Feature '${featureId}' must submit exactly one handoff for run '${selection.run_key}'`);
    }
    const submittedHandoff = submittedHandoffs[0];
    if (submittedHandoff && submittedHandoff.run_key !== selection.run_key) {
      add(`Feature '${featureId}' handoff run_key '${submittedHandoff.run_key}' does not match canonical run_key '${selection.run_key}'`);
    }
    if (!binding || typeof binding.handoff_id !== "string" || typeof binding.handoff_digest !== "string") {
      add(`Feature '${featureId}' has no exact frozen handoff binding`);
    } else if (submittedHandoff && (
      submittedHandoff.handoff.handoff_id !== binding.handoff_id
      || submittedHandoff.handoff.handoff_digest !== binding.handoff_digest
    )) {
      add(`Feature '${featureId}' supplied handoff identity does not match the frozen handoff binding`);
    }
    if (submittedClaims.length !== 1) {
      add(`Feature '${featureId}' must submit exactly one execution claim summary`);
    }
    const currentClaimRead = readCurrentExecutionClaim(pinnedRoot.canonical_root, featureId, pinnedRoot);
    const currentClaim = currentClaimRead.ok ? currentClaimRead.value : null;
    const submittedClaim = submittedClaims[0];
    if (!currentClaim) {
      add(`Feature '${featureId}' has no current execution claim for worker evidence`);
    } else {
      if (currentClaim.owner_kind !== "cto" || currentClaim.owner_run_id !== authority.cto_run_id) {
        add(`Feature '${featureId}' current claim owner does not match CTO execution authority`);
      }
      if (submittedClaim && (
        submittedClaim.claim_id !== currentClaim.claim_id
        || submittedClaim.handoff_digest !== currentClaim.handoff_digest
        || submittedClaim.owner_kind !== currentClaim.owner_kind
        || submittedClaim.owner_run_id !== currentClaim.owner_run_id
      )) {
        add(`Feature '${featureId}' supplied claim summary does not match the current execution claim`);
      }
    }
    const workspaceResult = resolveFeatureWorkspace(
      pinnedRoot.canonical_root,
      selection,
      rootSnapshot,
      { persistMigration: false },
    );
    const workspace = workspaceResult.ok ? workspaceResult.value : null;
    if (!workspace) {
      add(`Feature '${featureId}' workspace is not ready for CTO conformance evidence`);
    } else if (!["claimed", "executing", "completion_validating", "completion_blocked", "completed"].includes(workspace.status)) {
      add(`Feature '${featureId}' workspace status '${workspace.status}' is not a conformance-ready worker postimage`);
    }
    const canonical = readCtoCanonicalHandoff(pinnedRoot, featureId, workspace);
    if (!canonical.handoff) {
      for (const finding of canonical.findings) add(finding.message);
    } else if (canonical.handoff.status !== "ready") {
      add(`Feature '${featureId}' canonical handoff status '${canonical.handoff.status}' is not ready`);
    }
    const subjects = canonical.handoff ? deriveSubjects(canonical.handoff) : [];
    const subjectById = new Map(subjects.map((subject) => [subject.subject_id, subject]));
    const featureTasks = taskRows.filter((candidate) => candidate.feature_id === featureId);
    const teamCandidates = teams.filter((candidate) => candidate.feature_id === featureId);
    const handoffTasks = canonical.handoff?.tasks ?? [];
    const handoffTaskIds = new Set(handoffTasks.map((task) => task.task_id));
    if (featureTasks.length !== handoffTasks.length) {
      add("Feature '" + featureId + "' mapping task projection must cover exactly " + handoffTasks.length + " handoff tasks; saw " + featureTasks.length + ".");
    }
    if (teamCandidates.length !== featureTasks.length) {
      add("Feature '" + featureId + "' team ownership must cover exactly " + featureTasks.length + " mapped tasks; saw " + teamCandidates.length + ".");
    }
    const seenTaskIds = new Set<string>();
    const seenTeamIds = new Set<string>();
    const seenSliceIds = new Set<string>();
    const identityKeys = [
      "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id",
      "stage_cursor", "capability_id", "capability_epoch", "slot_id", "task_id",
      "dispatch_id", "attempt", "worker_id",
    ] as const;
    for (const task of featureTasks) {
      const taskId = typeof task.task_id === "string" ? task.task_id : null;
      const teamId = typeof task.team_id === "string" ? task.team_id : null;
      const sliceId = typeof task.slice_id === "string" ? task.slice_id : null;
      if (!taskId || !handoffTaskIds.has(taskId)) add("Feature '" + featureId + "' mapping task projection contains a missing or foreign task '" + String(task.task_id) + "'.");
      if (taskId && seenTaskIds.has(taskId)) add("Feature '" + featureId + "' mapping task projection contains duplicate task '" + taskId + "'.");
      if (taskId) seenTaskIds.add(taskId);
      if (teamId && seenTeamIds.has(teamId)) add("Feature '" + featureId + "' mapping task projection contains duplicate team '" + teamId + "'.");
      if (teamId) seenTeamIds.add(teamId);
      if (sliceId && seenSliceIds.has(sliceId)) add("Feature '" + featureId + "' mapping task projection contains duplicate slice '" + sliceId + "'.");
      if (sliceId) seenSliceIds.add(sliceId);
      const matches = teamId === null ? [] : teamCandidates.filter((candidate) => candidate.id === teamId);
      if (matches.length !== 1) {
        add("Feature '" + featureId + "' mapping task '" + String(task.task_id) + "' must have exactly one canonical team owner; saw " + matches.length + ".");
        continue;
      }
      const team = matches[0]!;
      if (team.run_key !== selection.run_key || team.task_id !== taskId || team.slice_id !== sliceId) {
        add("Feature '" + featureId + "' team/run/task/slice identity does not match the canonical mapping for task '" + String(task.task_id) + "'.");
      }
      const identity = team.work_identity;
      if (!identity
        || identityKeys.some((key) => !(key in identity))
        || identityKeys.some((key) => key !== "attempt" && typeof identity[key] !== "string")
        || !Number.isSafeInteger(identity.attempt)
        || identity.attempt < 0
        || identity.run_id !== authority.cto_run_id
        || identity.wave_id !== execution?.wave_id
        || identity.slice_id !== sliceId
        || identity.stage_id !== "execution"
        || identity.stage_cursor !== "execution"
        || identity.capability_id !== execution?.capability_id
        || identity.capability_epoch !== execution?.capability_epoch
        || identity.slot_id !== sliceId
        || typeof identity.task_id !== "string"
        || identity.task_id.length === 0
        || typeof identity.dispatch_id !== "string"
        || identity.dispatch_id.length === 0
        || typeof identity.worker_id !== "string"
        || identity.worker_id.length === 0) {
        add("Feature '" + featureId + "' task '" + String(task.task_id) + "' worker evidence has no exact active work_identity binding.");
      }
    }
    for (const team of teamCandidates) {
      if (typeof team.id === "string" && !seenTeamIds.has(team.id)) add("Feature '" + featureId + "' has a foreign team ownership row '" + team.id + "' outside the canonical task projection.");
    }
    const entries = entriesByFeature.get(featureId) ?? [];
    if (entries.length === 0) {
      add(`Feature '${featureId}' has no dereferenceable worker evidence references`);
    }
    for (const message of runtimeEnvelopeCompletenessIssues(featureId, entries, pinnedRoot)) add(message);
    for (const entry of entries) {
      if (binding && entry.handoff_digest !== binding.handoff_digest) {
        add(`Feature '${featureId}' evidence '${entry.evidence_id}' handoff_digest does not match the frozen handoff`);
      }
      if (currentClaim && entry.execution_claim_id !== currentClaim.claim_id) {
        add(`Feature '${featureId}' evidence '${entry.evidence_id}' execution_claim_id does not match the current claim`);
      }
      const subject = subjectById.get(entry.subject_id);
      if (!subject) {
        add(`Feature '${featureId}' evidence '${entry.evidence_id}' targets subject '${entry.subject_id}' outside the frozen handoff`);
      } else if (entry.requirement_id !== subject.requirement_id) {
        add(`Feature '${featureId}' evidence '${entry.evidence_id}' requirement_id '${entry.requirement_id ?? "null"}' does not match subject '${subject.subject_id}' owner '${subject.requirement_id}'`);
      }
    }
    for (const subject of subjects) {
      const subjectEntries = entries.filter((entry) => entry.subject_id === subject.subject_id);
      const implementations = subjectEntries.filter((entry) => entry.kind === "implementation");
      const reviews = subjectEntries.filter((entry) => entry.kind === "review");
      const tests = subjectEntries.filter((entry) => entry.kind === "executed_test");
      const conflicts = subjectEntries.filter((entry) => entry.kind === "intent_conflict");
      if (conflicts.length === 0 && implementations.length === 0) add("Feature '" + featureId + "' subject '" + subject.subject_id + "' has no implementation worker evidence reference");
      if (conflicts.length === 0 && reviews.length === 0) add("Feature '" + featureId + "' subject '" + subject.subject_id + "' has no review evidence reference");
      if (subject.observable_behavior && tests.length === 0 && conflicts.length === 0) {
        add(`Feature '${featureId}' observable subject '${subject.subject_id}' has no executed-test evidence reference`);
      }
    }
  }
  return issues;
}

/**
 * Official CTO conformance producer. Evaluation is performed through the
 * durable mapping/claim/evidence path above, then each matrix is rebound to
 * the selected workspace's exact profile hash before immutable persistence.
 */
function ctoConstitutionErrorReadOnly(
  pinnedRoot: PinnedProjectRoot,
  workspace: FeatureWorkspace,
  handoff: ImplementationHandoff,
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
  if (comparable(current.value.binding) !== comparable(handoff.constitution_binding)) {
    return "live constitution binding does not match the canonical handoff";
  }
  return null;
}


function receiptRowsFromPersistedFeatures(
  persistedFeatures: readonly PersistedCtoFeatureConformance[],
  input: EvaluateCtoSpecificationConformanceInput,
  selectors: ReadonlyMap<string, string | CtoTerminalTeamSelector>,
  pinnedRoot: PinnedProjectRoot,
): CtoSpecificationConformanceReceiptFeature[] | null {
  const rows: CtoSpecificationConformanceReceiptFeature[] = [];
  for (const feature of persistedFeatures) {
    if (feature.status !== "persisted" || !feature.conformance_id || !feature.artifact_ref || !isSha256Hex(feature.artifact_ref.sha256)) return null;
    const selector = selectors.get(feature.feature_id);
    const runKey = typeof selector === "string" ? selector : selector?.run_key;
    const claimRead = readCurrentExecutionClaim(pinnedRoot.canonical_root, feature.feature_id, pinnedRoot);
    const claimId = claimRead.ok ? claimRead.value?.claim_id : null;
    const callerClaim = input.claims.find((candidate) => candidate.feature_id === feature.feature_id);
    const matrixDigest = feature.conformance_id.startsWith("implementation-conformance.")
      ? feature.conformance_id.slice("implementation-conformance.".length)
      : "";
    let matrix: Record<string, unknown> | null = null;
    try {
      const snapshot = readPinnedArtifactSnapshot(
        pinnedRoot,
        `.work-state/features/${feature.feature_id}/artifacts/implementation_conformance`,
        feature.conformance_id,
        { verifyPathAfterRead: true },
      );
      matrix = isRecord(snapshot.value) ? snapshot.value : null;
      if (snapshot.sha256 !== feature.artifact_ref.sha256) return null;
    } catch {
      return null;
    }
    if (typeof runKey !== "string" || runKey.trim().length === 0
      || !isSha256Hex(matrixDigest) || typeof claimId !== "string" || claimId.trim().length === 0
      || (callerClaim !== undefined && callerClaim.claim_id !== claimId)
      || matrix?.execution_claim_id !== claimId
      || matrix?.matrix_digest !== matrixDigest) return null;
    rows.push({
      feature_id: feature.feature_id,
      run_key: runKey,
      conformance_id: feature.conformance_id,
      artifact_sha256: feature.artifact_ref.sha256,
      matrix_digest: matrixDigest,
      claim_id: claimId,
    });
  }
  rows.sort(compareCanonical);
  return rows;
}

interface BuiltCtoConformanceReceipt {
  receipt: CtoSpecificationConformanceReceipt;
  relativePath: string;
  bytes: Buffer;
}

function buildCtoConformanceReceipt(
  input: EvaluateCtoSpecificationConformanceInput,
  pinnedRoot: PinnedProjectRoot,
  authority: Readonly<CtoSpecificationConformanceAuthority>,
  selectors: ReadonlyMap<string, string | CtoTerminalTeamSelector>,
  persistedFeatures: readonly PersistedCtoFeatureConformance[],
): BuiltCtoConformanceReceipt | { error: string } {
  const rows = receiptRowsFromPersistedFeatures(persistedFeatures, input, selectors, pinnedRoot);
  const execution = isRecord(input.mapping) && isRecord(input.mapping.execution) ? input.mapping.execution : null;
  const waveId = execution && typeof execution.wave_id === "string" ? execution.wave_id : null;
  const capabilityId = ctoConformanceCapabilityId(authority);
  if (!rows || rows.length === 0 || !waveId || !isSafeCtoExecutionId(waveId)) {
    return { error: "conformance receipt inputs are incomplete after feature adoption" };
  }
  const body = {
    schema_version: 1 as const,
    cto_run_id: authority.cto_run_id,
    wave_id: waveId,
    mapping_id: authority.mapping_id,
    mapping_record_digest: authority.mapping_record_digest,
    conformance_capability_id: capabilityId,
    active_claims_digest: authority.active_claims_digest,
    terminal_teams_digest: authority.terminal_teams_digest,
    features: rows,
  };
  const receipt = { ...body, receipt_ref: conformanceReceiptRefForBody(body) } as CtoSpecificationConformanceReceipt;
  const validated = validateCtoSpecificationConformanceReceipt(receipt);
  if (!validated.ok) return { error: validated.error };
  const relativePath = ctoSpecificationConformanceReceiptRelativePath(authority.cto_run_id, receipt.receipt_ref);
  if (!relativePath) return { error: "conformance receipt path identity is invalid" };
  return { receipt, relativePath, bytes: Buffer.from(`${canonicalJson(receipt)}\n`, "utf8") };
}

function receiptMatchesWaveAuthority(
  state: CtoState,
  input: EvaluateCtoSpecificationConformanceInput,
  selectors: ReadonlyMap<string, string | CtoTerminalTeamSelector>,
  authority: Readonly<CtoSpecificationConformanceAuthority>,
): { ok: true; waveId: string } | { ok: false; error: string } {
  const execution = isRecord(input.mapping) && isRecord(input.mapping.execution) ? input.mapping.execution : null;
  const waveId = execution && typeof execution.wave_id === "string" ? execution.wave_id : null;
  if (!waveId || !isSafeCtoExecutionId(waveId)) return { ok: false, error: "conformance receipt execution wave identity is invalid" };
  const terminal = computeCtoTerminalTeamsDigest(state, input.mapping, selectors);
  if (!terminal.ok) return { ok: false, error: `terminal CTO team postimage is invalid during conformance receipt publication: ${terminal.error}` };
  if (terminal.digest !== authority.terminal_teams_digest) return { ok: false, error: "terminal CTO team postimage digest changed during conformance receipt publication" };
  return { ok: true, waveId };
}

/** Publish a receipt only while its specification-execution wave is active. */
function publishCtoConformanceReceipt(
  input: EvaluateCtoSpecificationConformanceInput,
  pinnedRoot: PinnedProjectRoot,
  authority: Readonly<CtoSpecificationConformanceAuthority>,
  selectors: ReadonlyMap<string, string | CtoTerminalTeamSelector>,
  persistedFeatures: readonly PersistedCtoFeatureConformance[],
  transaction: CtoRunTransactionFacade,
): { ok: true; receipt: CtoSpecificationConformanceReceipt; replayed: boolean } | { ok: false; error: string } {
  try {
    const state = transaction.readState();
    const authorityMatch = receiptMatchesWaveAuthority(state, input, selectors, authority);
    if (!authorityMatch.ok) return authorityMatch;
    const wave = (state.wave_history ?? []).find((candidate) => candidate.id === authorityMatch.waveId);
    if (!wave || state.active_wave_id !== authorityMatch.waveId || wave.status !== "active" || wave.source !== "specification-execution") {
      return { ok: false, error: "active CTO specification execution wave changed before conformance receipt publication" };
    }
    const payload = buildCtoConformanceReceipt(input, pinnedRoot, authority, selectors, persistedFeatures);
    if ("error" in payload) return { ok: false, error: payload.error };
    if (wave.conformance_receipt_ref !== undefined) {
      const existing = readCtoSpecificationConformanceReceipt(pinnedRoot, authority.cto_run_id, wave.conformance_receipt_ref);
      if (!existing.ok) return { ok: false, error: `existing conformance receipt is invalid: ${existing.error}` };
      if (canonicalJson(existing.value) !== canonicalJson(payload.receipt)) return { ok: false, error: "active CTO wave points to a different conformance receipt" };
      return { ok: true, replayed: true, receipt: existing.value };
    }
    pinnedRoot.ensureDirectories([dirname(payload.relativePath)]);
    try { pinnedRoot.writeExclusive(payload.relativePath, payload.bytes); }
    catch {
      const existing = readCtoSpecificationConformanceReceipt(pinnedRoot, authority.cto_run_id, payload.receipt.receipt_ref);
      if (!existing.ok || canonicalJson(existing.value) !== canonicalJson(payload.receipt)) return { ok: false, error: "conformance receipt publication raced with a different content" };
    }
    transaction.writeState({
      ...state,
      wave_history: (state.wave_history ?? []).map((candidate) => candidate.id === authorityMatch.waveId
        ? { ...candidate, conformance_receipt_ref: payload.receipt.receipt_ref }
        : candidate),
    });
    return { ok: true, replayed: false, receipt: payload.receipt };
  } catch (error) {
    return { ok: false, error: `conformance receipt transaction failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Repair a legacy terminal wave that has no receipt, using the authenticated run transaction. */
function repairLegacyTerminalCtoConformanceReceipt(
  input: EvaluateCtoSpecificationConformanceInput,
  pinnedRoot: PinnedProjectRoot,
  authority: Readonly<CtoSpecificationConformanceAuthority>,
  selectors: ReadonlyMap<string, string | CtoTerminalTeamSelector>,
  persistedFeatures: readonly PersistedCtoFeatureConformance[],
  transaction: CtoRunTransactionFacade,
): { ok: true; receipt: CtoSpecificationConformanceReceipt } | { ok: false; error: string } {
  try {
    const state = transaction.readState();
    const authorityMatch = receiptMatchesWaveAuthority(state, input, selectors, authority);
    if (!authorityMatch.ok) return authorityMatch;
    const wave = (state.wave_history ?? []).find((candidate) => candidate.id === authorityMatch.waveId);
    if (!wave || state.active_wave_id !== undefined || wave.status !== "done" || wave.source !== "specification-execution") {
      return { ok: false, error: "legacy terminal CTO specification execution wave is not repairable" };
    }
    const payload = buildCtoConformanceReceipt(input, pinnedRoot, authority, selectors, persistedFeatures);
    if ("error" in payload) return { ok: false, error: payload.error };
    if (wave.conformance_receipt_ref !== undefined) return { ok: false, error: "legacy terminal CTO wave already has a receipt pointer" };
    pinnedRoot.ensureDirectories([dirname(payload.relativePath)]);
    try { pinnedRoot.writeExclusive(payload.relativePath, payload.bytes); }
    catch {
      const existing = readCtoSpecificationConformanceReceipt(pinnedRoot, authority.cto_run_id, payload.receipt.receipt_ref);
      if (!existing.ok || canonicalJson(existing.value) !== canonicalJson(payload.receipt)) return { ok: false, error: "legacy conformance receipt publication raced with a different content" };
    }
    transaction.writeState({
      ...state,
      wave_history: (state.wave_history ?? []).map((candidate) => candidate.id === authorityMatch.waveId
        ? { ...candidate, conformance_receipt_ref: payload.receipt.receipt_ref }
        : candidate),
    });
    return { ok: true, receipt: payload.receipt };
  } catch (error) {
    return { ok: false, error: `legacy conformance receipt repair failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function persistCtoSpecificationConformanceUnlocked(
  input: EvaluateCtoSpecificationConformanceInput,
  pinnedRoot: PinnedProjectRoot,
  options: PersistCtoSpecificationConformanceOptions,
  authority: Readonly<CtoSpecificationConformanceAuthority>,
  selectors: ReadonlyMap<string, string | CtoTerminalTeamSelector>,
  transaction: CtoRunTransactionFacade,
): PersistedCtoSpecificationConformanceResult {
  const preflightState = transaction.readState();
  const preflightTerminal = computeCtoTerminalTeamsDigest(preflightState, input.mapping, selectors);
  if (!preflightTerminal.ok) return blockedCtoConformanceResult(input, `terminal CTO team postimage is invalid before conformance adoption: ${preflightTerminal.error}`);
  if (preflightTerminal.digest !== authority.terminal_teams_digest) return blockedCtoConformanceResult(input, "terminal CTO team postimage digest changed before conformance adoption");
  for (const featureId of input.mapping.feature_ids) {
    const suppliedClaim = input.claims.find((candidate) => candidate.feature_id === featureId);
    const durableClaim = readCurrentExecutionClaim(pinnedRoot.canonical_root, featureId, pinnedRoot);
    if (!durableClaim.ok || !durableClaim.value || (suppliedClaim !== undefined && suppliedClaim.claim_id !== durableClaim.value.claim_id)) {
      return blockedCtoConformanceResult(input, `feature '${featureId}' caller claim does not match the canonical durable claim postimage`);
    }
  }
  const evaluated = evaluateCtoSpecificationConformancePinned(
    input as unknown as Record<string, unknown>,
    input.project_root,
    pinnedRoot,
    pinnedRoot.canonical_root,
  );

  const findings: string[] = [];
  const persistedFeatures: PersistedCtoFeatureConformance[] = [];
  let allReplayed = true;
  const canonicalRoot = pinnedRoot.canonical_root;
  const rootSnapshot: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: canonicalRoot,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };
  for (const feature of evaluated.features) {
      const suppliedHandoff = input.handoffs.find((handoff) => handoff.feature_id === feature.feature_id);
      const runKey = suppliedHandoff?.run_key ?? "";
      const workspaceResult = runKey.trim().length > 0
        ? resolveFeatureWorkspace(canonicalRoot, { feature_id: feature.feature_id, run_key: runKey }, rootSnapshot)
        : { ok: false as const, code: "SPEC_SELECTOR_REQUIRED" as const, error: `No run_key was supplied for feature '${feature.feature_id}'.` };
      if (!workspaceResult.ok) {
        const message = `Feature '${feature.feature_id}' workspace resolution failed: ${workspaceResult.error}`;
        findings.push(message);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }
      const workspace = workspaceResult.value;
      const expectedWorkspaceDigest = digestOf(workspace);
      let expectedStateRevision: number;
      try {
        const stateBytes = pinnedRoot.readFile(`.work-state/features/${feature.feature_id}/state.json`, { maxBytes: MAX_PERSISTED_STATE_BYTES }).bytes;
        const parsedState: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stateBytes));
        const stateEnvelope = parseBoundedPersistedState(parsedState);
        if (!stateEnvelope) {
          throw new Error("feature state exceeds bounded structural limits or has an unsafe object shape");
        }
        if (
          stateEnvelope.run_key !== runKey
          || !isRecord(stateEnvelope.specification)
          || stateEnvelope.specification.feature_id !== feature.feature_id
        ) {
          throw new Error("feature state identity does not match the selected feature and run");
        }
        if (!Number.isSafeInteger(stateEnvelope.state_revision) || Number(stateEnvelope.state_revision) < 0) {
          throw new Error("state_revision is missing or invalid");
        }
        expectedStateRevision = Number(stateEnvelope.state_revision);
      } catch (error) {
        findings.push(`Feature '${feature.feature_id}' state revision could not be authenticated before conformance adoption: ${error instanceof Error ? error.message : String(error)}`);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }
      const claimRead = readCurrentExecutionClaim(canonicalRoot, feature.feature_id, pinnedRoot);
      if (!claimRead.ok || !claimRead.value) {
        findings.push(`Feature '${feature.feature_id}' current execution claim changed or disappeared before conformance adoption: ${claimRead.ok ? "no claim authority" : claimRead.error}`);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }
      const expectedClaim = claimRead.value;
      if (
        expectedClaim.status !== "active"
        || expectedClaim.owner_kind !== "cto"
        || expectedClaim.claim_id !== feature.matrix.execution_claim_id
        || expectedClaim.handoff_digest !== feature.matrix.handoff_digest
        || expectedClaim.owner_kind !== feature.matrix.execution_owner
        || expectedClaim.owner_run_id !== feature.matrix.execution_run_id
      ) {
        findings.push(`Feature '${feature.feature_id}' claim is not the active CTO authority required for conformance adoption`);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }
      const canonicalHandoff = readCtoCanonicalHandoff(pinnedRoot, feature.feature_id, workspace);
      if (!canonicalHandoff.handoff || canonicalHandoff.handoff.handoff_digest !== expectedClaim.handoff_digest) {
        findings.push(`Feature '${feature.feature_id}' canonical handoff or claim digest changed before conformance adoption`);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }
      const expectedHandoff = canonicalHandoff.handoff;
      const constitutionError = ctoConstitutionErrorReadOnly(pinnedRoot, workspace, expectedHandoff);
      if (constitutionError) {
        findings.push(`Feature '${feature.feature_id}' constitution prerequisite changed before conformance persistence: ${constitutionError}`);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }
      if (!isSha256Hex(workspace.profile_hash)) {
        const message = `Feature '${feature.feature_id}' workspace has no valid profile hash binding.`;
        findings.push(message);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }

      const matrixWithWorkspaceProfile: ImplementationConformanceResult = {
        ...feature.matrix,
        profile_hash: workspace.profile_hash,
        evaluated_at: new Date().toISOString(),
      };
      const matrixDigest = implementationConformanceMatrixDigest(matrixWithWorkspaceProfile);
      if (!matrixDigest) {
        const message = `Feature '${feature.feature_id}' produced a matrix without a canonical digest.`;
        findings.push(message);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }
      const matrix: ImplementationConformanceResult = {
        ...matrixWithWorkspaceProfile,
        matrix_digest: matrixDigest,
        conformance_id: `implementation-conformance.${matrixDigest}`,
      };
      const validation = validateProducedArtifact("implementation_conformance", matrix);
      if (!validation.ok) {
        const message = `Feature '${feature.feature_id}' conformance matrix is invalid: ${validation.issues.map((issue) => issue.message).join("; ")}`;
        findings.push(message);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }

      const previousRef = workspace.implementation_conformance_ref;
      try {
        assertCtoRuntimeAccessFacadeLive(options.runtimeAccess, pinnedRoot.canonical_root, options.sessionId);
        const terminalError = terminalTeamsAuthorityError(pinnedRoot, authority, input.mapping, selectors);
        if (terminalError) throw new Error(`terminal CTO team postimage changed before feature '${feature.feature_id}' adoption: ${terminalError}`);
      } catch (error) {
        findings.push(`Feature '${feature.feature_id}' durable conformance adoption requires live authenticated runtime access or unchanged terminal team postimage: ${error instanceof Error ? error.message : String(error)}`);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }
      let artifactRef: CompletionArtifactRef | null = null;
      let artifactOwnership: ArtifactWriteOwnershipToken | null = null;
      let preCommitConstitutionGuard: (() => void) | null = null;
      const update = updateStateAtomically(
        canonicalRoot,
        (snapshot) => {
          const currentState = snapshot.state;
          const current = currentState?.specification;
          if (!currentState || !current) return { op: "fail" as const, code: "state_missing", error: `feature '${feature.feature_id}' has no specification workspace in durable state` };
          const canonicalCurrent = current.project_root === canonicalRoot
            ? current
            : { ...current, project_root: canonicalRoot };
          const changedWorkspaceKeys = Object.keys({ ...workspace, ...canonicalCurrent }).filter((key) => canonicalJson((canonicalCurrent as unknown as Record<string, unknown>)[key]) !== canonicalJson((workspace as unknown as Record<string, unknown>)[key]));
          if (
            snapshot.revision !== expectedStateRevision
            || currentState.run_key !== runKey
            || changedWorkspaceKeys.length > 0
            || current.feature_id !== feature.feature_id
            || current.status !== workspace.status
            || current.handoff_ref !== workspace.handoff_ref
            || current.profile_hash !== workspace.profile_hash
            || current.execution_claim_ref !== expectedClaim.claim_id
            || current.implementation_conformance_ref !== previousRef
          ) {
            return {
              op: "fail" as const,
              code: "state_conflict",
              error: `workspace state revision, identity, profile, claim, or prior conformance reference changed before adoption (revision ${snapshot.revision}/${expectedStateRevision}, run ${String(currentState.run_key)}/${runKey}, changed workspace keys ${changedWorkspaceKeys.join(",") || "none"})`,
            };
          }
          const currentClaimRead = readCurrentExecutionClaim(canonicalRoot, feature.feature_id, pinnedRoot);
          if (!currentClaimRead.ok || !currentClaimRead.value) {
            return { op: "fail" as const, code: "state_conflict", error: "current execution claim disappeared before conformance adoption" };
          }
          const currentClaim = currentClaimRead.value;
          if (
            currentClaim.claim_id !== expectedClaim.claim_id
            || currentClaim.handoff_digest !== expectedClaim.handoff_digest
            || currentClaim.owner_kind !== expectedClaim.owner_kind
            || currentClaim.owner_run_id !== expectedClaim.owner_run_id
            || currentClaim.status !== expectedClaim.status
            || canonicalJson(currentClaim.admission_binding ?? null) !== canonicalJson(expectedClaim.admission_binding ?? null)
          ) {
            return { op: "fail" as const, code: "state_conflict", error: "execution claim identity or admission binding changed before conformance adoption" };
          }
          const currentHandoff = readCtoCanonicalHandoff(pinnedRoot, feature.feature_id, current);
          if (
            !currentHandoff.handoff
            || currentHandoff.handoff.handoff_id !== expectedHandoff.handoff_id
            || currentHandoff.handoff.handoff_digest !== expectedHandoff.handoff_digest
          ) {
            return { op: "fail" as const, code: "state_conflict", error: "canonical handoff identity or digest changed before conformance adoption" };
          }
          if (previousRef !== null && previousRef !== matrix.conformance_id) {
            return { op: "fail" as const, code: "state_conflict", error: "workspace already points to a different implementation conformance artifact" };
          }
          const artifactPath = `.work-state/features/${feature.feature_id}/artifacts/implementation_conformance/${matrix.conformance_id}.json`;
          if (previousRef === matrix.conformance_id && !pinnedRoot.pathEntryExists(artifactPath)) {
            return { op: "fail" as const, code: "state_conflict", error: "workspace points to a missing implementation conformance artifact" };
          }
          const currentConstitutionError = ctoConstitutionErrorReadOnly(pinnedRoot, canonicalCurrent, currentHandoff.handoff);
          if (currentConstitutionError) {
            return { op: "fail" as const, code: "state_conflict", error: "live constitution changed before conformance artifact publication: " + currentConstitutionError };
          }
          preCommitConstitutionGuard = () => {
            const latestConstitutionError = ctoConstitutionErrorReadOnly(pinnedRoot, workspace, expectedHandoff);
            if (latestConstitutionError) throw new Error(latestConstitutionError);
          };
          try {
            assertCtoRuntimeAccessFacadeLive(options.runtimeAccess, pinnedRoot.canonical_root, options.sessionId);
            const terminalError = terminalTeamsAuthorityError(pinnedRoot, authority, input.mapping, selectors);
            if (terminalError) throw new Error(`terminal CTO team postimage changed before artifact publication: ${terminalError}`);
            artifactRef = writeArtifactWithReference(
              canonicalRoot,
              join(featureArtifactsDir(canonicalRoot, feature.feature_id), "implementation_conformance"),
              matrix.conformance_id,
              matrix,
              {
                schema_status: "met",
                quality_gate_status: matrix.overall_status === "pass" ? "met" : "failed",
              },
              { pinnedRoot, beforeWrite: () => { preCommitConstitutionGuard?.(); }, onCreated: (ownership) => { artifactOwnership = ownership; } },
            );
            const writtenInfo = pinnedRoot.pathEntryInfo(artifactPath);
            if (!writtenInfo || writtenInfo.kind !== "file" || !pinnedRoot.isStable()) {
              return { op: "fail" as const, code: "state_conflict", error: "conformance artifact disappeared or was replaced before workspace adoption" };
            }
            if (artifactOwnership && (
              artifactOwnership.relative_path !== artifactPath
              || artifactOwnership.sha256 !== artifactRef.sha256
              || artifactOwnership.dev !== writtenInfo.dev
              || artifactOwnership.ino !== writtenInfo.ino
              || artifactOwnership.size !== writtenInfo.size
            )) {
              return { op: "fail" as const, code: "state_conflict", error: "conformance artifact ownership identity changed before workspace adoption" };
            }
          } catch (error) {
            return { op: "fail" as const, code: "state_invalid", error: `conformance artifact could not be persisted: ${String(error)}` };
          }
          try {
            assertCtoRuntimeAccessFacadeLive(options.runtimeAccess, pinnedRoot.canonical_root, options.sessionId);
            const terminalError = terminalTeamsAuthorityError(pinnedRoot, authority, input.mapping, selectors);
            if (terminalError) return { op: "fail" as const, code: "terminal_team_postimage_changed", error: `terminal CTO team postimage changed before workspace CAS: ${terminalError}` };
          } catch (error) {
            return { op: "fail" as const, code: "runtime_access_invalid", error: `live authenticated runtime access was revoked before workspace CAS: ${error instanceof Error ? error.message : String(error)}` };
          }
          if (previousRef === matrix.conformance_id) return { op: "discard" as const, value: true };
          return {
            op: "commit" as const,
            state: {
              ...currentState,
              specification: {
                ...current,
                status: current.status === "claimed" && matrix.overall_status === "pass" ? "executing" : current.status,
                implementation_conformance_ref: matrix.conformance_id,
              },
            },
          };
        },
        {
          selector: { feature_id: feature.feature_id, run_key: runKey },
          branchNeutral: true,
          pinnedRoot,
          rootGuard: pinnedRoot,
          preCommit: () => { preCommitConstitutionGuard?.(); },
        },
      );
      if (!update.ok) {
        if (artifactOwnership) removeOwnedConformanceArtifactIfUnchanged(pinnedRoot, artifactOwnership);
        findings.push(`Feature '${feature.feature_id}' durable conformance adoption failed: ${update.error}`);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }
      if (!artifactRef) {
        findings.push(`Feature '${feature.feature_id}' conformance adoption produced no artifact reference`);
        persistedFeatures.push({
          feature_id: feature.feature_id,
          conformance_id: null,
          artifact_ref: null,
          overall_status: feature.result.overall_status,
          claim_action: feature.claim_action,
          status: "blocked",
        });
        allReplayed = false;
        continue;
      }

      const replayed = previousRef === matrix.conformance_id;
      allReplayed = allReplayed && replayed;
      persistedFeatures.push({
        feature_id: feature.feature_id,
        conformance_id: matrix.conformance_id,
        artifact_ref: artifactRef,
        overall_status: matrix.overall_status,
        claim_action: feature.claim_action,
        status: "persisted",
      });
      for (const item of feature.matrix.blocking_findings) {
        findings.push(`Feature '${feature.feature_id}': ${item.message}`);
      }
      if (matrix.overall_status !== "pass" || feature.claim_action !== "release") {
        allReplayed = false;
      }
    }

  const passingFeatureIds = persistedFeatures
    .filter((feature) => feature.status === "persisted" && feature.claim_action === "release")
    .map((feature) => feature.feature_id);
  const blockedFeatureIds = persistedFeatures
    .filter((feature) => feature.status !== "persisted" || feature.claim_action !== "release")
    .map((feature) => feature.feature_id);
  const persisted = persistedFeatures.some((feature) => feature.status === "persisted");
  const baseResult: PersistedCtoSpecificationConformanceResult = {
    status: persistedFeatures.length > 0 && blockedFeatureIds.length === 0 && findings.length === 0 ? "ready" : "blocked",
    replayed: allReplayed && persistedFeatures.length > 0,
    features: persistedFeatures,
    passing_feature_ids: passingFeatureIds,
    blocked_feature_ids: blockedFeatureIds,
    findings,
    persisted,
  };
  if (persistedFeatures.length !== input.mapping.feature_ids.length || persistedFeatures.some((feature) => feature.status !== "persisted")) {
    return baseResult;
  }
  const receipt = publishCtoConformanceReceipt(input, pinnedRoot, authority, selectors, persistedFeatures, transaction);
  if (!receipt.ok) {
    return {
      ...baseResult,
      status: "blocked",
      replayed: false,
      findings: [...baseResult.findings, `CTO conformance receipt publication failed: ${receipt.error}`],
    };
  }
  return { ...baseResult, replayed: baseResult.replayed && receipt.replayed };
}
/**
 * Serialize CTO conformance fan-in against the exact run transaction. The
 * lock remains held through mapping/wave authorization, nested evidence
 * reads, artifact persistence, and every feature workspace CAS adoption.
 */
export interface PersistCtoSpecificationConformanceOptions {
  /** Genuine mounted runtime access for the exact project root. */
  runtimeAccess: CtoRuntimeAccessFacade;
  /** Authenticated host session that owns the mounted runtime. */
  sessionId: string;
}

function conformanceRuntimeSessionValid(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string"
    && sessionId.trim().length > 0
    && Buffer.byteLength(sessionId, "utf8") <= 512
    && !/[\u0000\r\n]/u.test(sessionId);
}

function conformanceRuntimeBlocked(input: EvaluateCtoSpecificationConformanceInput, error: unknown): PersistedCtoSpecificationConformanceResult {
  return blockedCtoConformanceResult(
    input,
    `recovery_required: authenticated runtime access is unavailable: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function persistCtoSpecificationConformance(
  input: EvaluateCtoSpecificationConformanceInput,
  options: PersistCtoSpecificationConformanceOptions,
): PersistedCtoSpecificationConformanceResult {
  if (!options || !conformanceRuntimeSessionValid(options.sessionId) || !options.runtimeAccess) {
    return conformanceRuntimeBlocked(input, new Error("runtimeAccess and a bounded non-blank sessionId are required"));
  }
  const boundaryIssues = conformanceInputBoundaryIssues(input);
  if (boundaryIssues.length > 0) {
    return {
      ...blockedCtoConformanceResult(input, boundaryIssues.join("; ")),
      next_action: "repair_conformance_evidence",
    };
  }
  const openedRoot = typeof input?.project_root === "string" ? PinnedProjectRoot.open(input.project_root) : null;
  const pinnedRoot = openedRoot && openedRoot.isStable() ? openedRoot : null;
  if (openedRoot && !pinnedRoot) openedRoot.close();
  if (!pinnedRoot) return blockedCtoConformanceResult(input, "CTO conformance project root is unavailable or unstable.");
  try {
    assertCtoRuntimeAccessFacadeLive(options.runtimeAccess, pinnedRoot.canonical_root, options.sessionId);
  } catch (error) {
    pinnedRoot.close();
    return conformanceRuntimeBlocked(input, error);
  }
  const authority = resolveCtoConformanceAuthority(input?.binding, pinnedRoot.canonical_root, pinnedRoot);
  const finish = (result: PersistedCtoSpecificationConformanceResult): PersistedCtoSpecificationConformanceResult => {
    try {
      assertCtoRuntimeAccessFacadeLive(options.runtimeAccess, pinnedRoot.canonical_root, options.sessionId);
      if (authority) {
        const finishMapping = ctoMappingRecordResolution(pinnedRoot.canonical_root, input.mapping as unknown as Record<string, unknown>, authority, pinnedRoot);
        const terminalError = terminalTeamsAuthorityError(pinnedRoot, authority, input.mapping, finishMapping.selectors);
        if (terminalError) return conformanceRuntimeBlocked(input, new Error(`terminal CTO team postimage revalidation failed: ${terminalError}`));
      }
      return result;
    } catch (error) {
      return conformanceRuntimeBlocked(input, error);
    }
  };
  if (!authority) {
    const result = finish(blockedCtoConformanceResult(input, "CTO conformance binding is invalid, stale, or was not issued by confirmed dispatch."));
    pinnedRoot.close();
    return result;
  }
  try {
    const preflightState = readCtoStatePinned(authority.cto_run_id, pinnedRoot);
    if (!preflightState || preflightState.id !== authority.cto_run_id || (preflightState.standby !== true && preflightState.owner_session !== options.sessionId)) {
      return finish(blockedCtoConformanceResult(input, "CTO conformance runtime session does not own the canonical run."));
    }
    return finish(options.runtimeAccess.withRunTransaction(
      authority.cto_run_id,
      (transaction) => {
        const normalizedInput = { ...input, project_root: pinnedRoot.canonical_root };
        const evidenceIssues = ctoEvidenceBoundaryIssues(normalizedInput, authority, pinnedRoot);
        if (evidenceIssues.length > 0) {
          const rejected = blockedCtoConformanceResult(input, evidenceIssues[0]!);
          return {
            ...rejected,
            persisted: false,
            next_action: "repair_conformance_evidence",
            findings: evidenceIssues.slice(0, 128),
          };
        }
        const profileGateFindings: string[] = [];
        const mappingRecord = ctoMappingRecordResolution(pinnedRoot.canonical_root, normalizedInput.mapping as unknown as Record<string, unknown>, authority, pinnedRoot);
        for (const featureId of mappingRecord.feature_ids) {
          const selection = mappingRecord.selectors.get(featureId);
          const workspace = selection
            ? resolveFeatureWorkspace(pinnedRoot.canonical_root, selection, {
              lexical_root: pinnedRoot.lexical_root,
              canonical_root: pinnedRoot.canonical_root,
              dev: pinnedRoot.dev,
              ino: pinnedRoot.ino,
              pinned_root: pinnedRoot,
            }, { persistMigration: false })
            : { ok: false as const, error: "canonical feature selector is unavailable" };
          const profileHash = workspace.ok ? workspace.value.profile_hash : "";
          const requiredGateId = `execution-profile.${profileHash}`;
          const suppliedHandoff = normalizedInput.handoffs.find((handoff) => handoff.feature_id === featureId);
          const candidateGates = [
            ...(Array.isArray(normalizedInput.quality_gates) ? normalizedInput.quality_gates : []),
            ...(suppliedHandoff && Array.isArray(suppliedHandoff.quality_gates) ? suppliedHandoff.quality_gates : []),
          ];
          const exactGates = candidateGates.filter((gate) => gate.source === "execution_profile" && gate.gate_id === requiredGateId);
          if (exactGates.length === 0) {
            profileGateFindings.push(`Feature '${featureId}': Missing mandatory execution-profile quality gate '${requiredGateId}' bound to the selected profile hash.`);
          } else if (exactGates.length > 1) {
            profileGateFindings.push(`Feature '${featureId}': Multiple execution-profile quality gates '${requiredGateId}' were supplied; exactly one canonical gate is required.`);
          }
        }
        if (profileGateFindings.length > 0) {
          const rejected = blockedCtoConformanceResult(input, profileGateFindings[0]!);
          return {
            ...rejected,
            persisted: false,
            next_action: "repair_conformance_quality_gates",
            findings: profileGateFindings.slice(0, 128),
          };
        }
        const state = transaction.readState();
        if (!state || state.id !== authority.cto_run_id || (state.standby !== true && state.owner_session !== options.sessionId)) {
          return blockedCtoConformanceResult(input, "CTO conformance runtime session does not own the canonical run.");
        }
        const replay = readTerminalCtoConformanceReplay(normalizedInput, authority, pinnedRoot, transaction);
        if (replay) return replay;
        const execution = isRecord(input.mapping) && isRecord(input.mapping.execution) ? input.mapping.execution : null;
        if (hasCompletedCtoWorkspacePostimages(normalizedInput, pinnedRoot, state)) {
          return blockedCtoConformanceResult(input, "terminal CTO conformance postimages no longer match the immutable producer binding.");
        }
        if (
          state?.active_wave_id === undefined
          && typeof execution?.wave_id === "string"
          && state?.wave_history?.some((wave) => wave.id === execution.wave_id && wave.status === "done")
        ) {
          return blockedCtoConformanceResult(input, "terminal CTO conformance postimages no longer match the immutable producer binding.");
        }
        const activeAuthority = validateActiveCtoConformanceAuthority(normalizedInput, authority, pinnedRoot);
        if (!activeAuthority.ok) return blockedCtoConformanceResult(input, activeAuthority.error);
        try {
          assertCtoRuntimeAccessFacadeLive(options.runtimeAccess, pinnedRoot.canonical_root, options.sessionId);
          const terminal = computeCtoTerminalTeamsDigest(transaction.readState(), normalizedInput.mapping, mappingRecord.selectors);
          if (!terminal.ok) return conformanceRuntimeBlocked(input, new Error(`terminal CTO team postimage revalidation failed: ${terminal.error}`));
          if (terminal.digest !== authority.terminal_teams_digest) return conformanceRuntimeBlocked(input, new Error("terminal CTO team postimage revalidation failed: digest changed"));
        } catch (error) {
          return conformanceRuntimeBlocked(input, error);
        }
        return persistCtoSpecificationConformanceUnlocked(normalizedInput, pinnedRoot, options, authority, mappingRecord.selectors, transaction);
      },
    ));
  } catch (error) {
    return finish({
      status: "blocked",
      replayed: false,
      features: [],
      passing_feature_ids: [],
      blocked_feature_ids: [],
      findings: [`CTO conformance transaction lock failed: ${error instanceof Error ? error.message : String(error)}`],
    });
  } finally {
    pinnedRoot.close();
  }
}

