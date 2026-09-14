import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { blockExecutionClaim, readCurrentExecutionClaim } from "./claims.js";
import {
  assessConstitutionImpact,
  readConstitutionImpactEvidence,
  type ApprovedArtifactImpactInput,
  type ConstitutionImpactResult,
} from "./constitution-impact.js";
import { readCanonicalPhaseArtifact } from "./phase.js";
import { isSafeCtoRunId } from "../cto/state.js";
import { canonicalHandoffDigest } from "./handoff.js";
import {
  bindWorkspaceConstitution,
  applyConstitutionImpact,
  applyHandoffStaleness,
  persistFeatureWorkspace,
  resolveFeatureWorkspace,
  workspaceRootIsStable,
  type WorkspaceRootSnapshot,
} from "./workspace.js";
import type {
  ConstitutionBinding,
  ExecutionClaim,
  FeatureWorkspace,
  ImplementationHandoff,
} from "./types.js";
import {
  canonicalJson,
  digestOf,
  isRecord,
  isSafeFeatureId,
  isSha256Hex,
  sha256Hex,
  validateConstitutionBinding,
  validateExecutionClaim,
  validateFeatureWorkspaceRecord,
  validateImplementationHandoff,
} from "./validation.js";
import {
  PinnedRootError,
  PinnedProjectRoot,
  rollbackPinnedRootWriteReceipt,
  type PinnedRootFileExpectation,
  type PinnedRootWriteReceipt,
} from "./pinned-root.js";
import { rollbackStateMutationReceipts, type StateMutationReceipt } from "../engine/state.js";
import {
  commitConstitutionImpactBinding,
  readProjectConstitutionGate,
  resolveCurrentConstitutionBinding,
} from "./prerequisite.js";
import { withCtoRunLock } from "../cto/transaction-lock.js";

type RuntimeFailureCode =
  | "SPEC_PATH_UNAUTHORIZED"
  | "SPEC_STATE_INVALID"
  | "SPEC_CONSTITUTION_IMPACT_PENDING"
  | "SPEC_IMPACT_GRAPH_INVALID"
  | "SPEC_IMPACT_EVIDENCE_INVALID"
  | "SPEC_BINDING_INVALID"
  | "SPEC_DRAFT_INVALID"
  | "SPEC_CONSTITUTION_SOURCE_AMBIGUOUS"
  | "SPEC_CONSTITUTION_DISCOVERY_FAILED"
  | "SPEC_INPUT_OVERSIZED"
  | "SPEC_GATE_UNKNOWN"
  | "SPEC_CHECKPOINT_UNKNOWN"
  | "SPEC_DECISION_INVALID"
  | "SPEC_PROOF_INVALID"
  | "SPEC_FEEDBACK_REQUIRED"
  | "SPEC_CONSTITUTION_IMPACT_REJECTED"
  | "SPEC_IMPACT_RECOVERY_REQUIRED";
const IMPACT_DECISION_DIR = join(".work-state", "specification", "constitution");
const IMPACT_TRANSACTION_FILE = /^constitution-impact-transaction-[a-f0-9]{64}$/;
const IMPACT_DECISION_FILE = /^constitution-impact-answer-[a-f0-9]{64}$/;
const IMPACT_APPLICATION_FILE = /^constitution-impact-application-[a-f0-9]{64}$/;
const IMPACT_DECISIONS = ["approve", "reject"] as const;
const MAX_IMPACT_PROOF_BYTES = 32 * 1024;
const MAX_IMPACT_HANDOFF_BYTES = 4 * 1024 * 1024;
const MAX_IMPACT_TRANSACTION_BYTES = 512 * 1024;
const MAX_IMPACT_JSON_DEPTH = 256;
const MAX_IMPACT_JSON_NODES = 100_000;
const MAX_IMPACT_JSON_ARRAY = 4_096;
const MAX_IMPACT_JSON_KEYS = 4_096;
const MAX_IMPACT_JSON_STRING_BYTES = 8 * 1024;
const MAX_IMPACT_APPLICATION_BYTES = 128 * 1024;
const IMPACT_CAPABILITY_ID = /^constitution-impact-capability-[0-9a-f-]{36}$/u;
const IMPACT_NONCE = /^[A-Za-z0-9._:-]{16,128}$/u;

const IMPACT_CAPABILITY_BRAND = Symbol("constitution-impact-capability");
interface ImpactAnswerCapabilityHandle {
  readonly token: string;
  readonly [IMPACT_CAPABILITY_BRAND]: true;
}
interface ImpactAnswerCapability {
  readonly token: string;
  readonly nonce: string;
  readonly canonicalRoot: string;
  readonly dev: number;
  readonly ino: number;
  readonly featureId: string;
  readonly runKey: string;
  readonly gateId: string;
  readonly checkpointId: string;
  readonly assessmentId: string;
  readonly assessmentHash: string;
  readonly workspaceDigest: string;
  readonly decision: "approve" | "reject";
  readonly previousBindingHash: string;
  readonly currentBindingHash: string;
  readonly configHash: string;
  readonly actorSessionId: string;
  readonly actorSession: object;
  consumed: boolean;
}
const impactAnswerCapabilities = new Map<string, ImpactAnswerCapability>();
const impactAskNonces = new Set<string>();

function impactConfigHash(config: { question_id: string; question: string; header: string; allowed: readonly string[] }, nonce: string): string {
  const questionId = config.question_id.endsWith(nonce)
    ? config.question_id.slice(0, -nonce.length) + "<ask-nonce>"
    : config.question_id;
  return digestOf({ ...config, question_id: questionId, allowed: [...config.allowed] });
}

/** Issue a nonce for exactly one trusted host Ask request. */
export function issueConstitutionImpactAskNonce(): string {
  const nonce = randomUUID();
  impactAskNonces.add(nonce);
  return nonce;
}
const impactAnswerHandles = new WeakMap<object, ImpactAnswerCapability>();

function decisionPath(_root: PinnedProjectRoot, answerId: string): string | null {
  return IMPACT_DECISION_FILE.test(answerId) ? join(IMPACT_DECISION_DIR, `${answerId}.json`) : null;
}

function applicationPath(_root: PinnedProjectRoot, applicationId: string): string | null {
  return IMPACT_APPLICATION_FILE.test(applicationId) ? join(IMPACT_DECISION_DIR, `${applicationId}.json`) : null;
}

export type ConstitutionImpactRuntimeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: RuntimeFailureCode; error: string };

export interface ConstitutionImpactAssessmentPublication {
  feature_id: string;
  run_key: string;
  gate_id: string;
  checkpoint_id: string;
  workspace_digest: string;
  previous_binding: ConstitutionBinding;
  current_binding: ConstitutionBinding;
  assessment: ConstitutionImpactResult;
  allowed_decisions: readonly ["approve", "reject"];
}

export interface ConstitutionImpactDecisionProof {
  schema_version: 1;
  answer_id: string;
  capability_id: string;
  nonce: string;
  actor_session_id: string;
  config_hash: string;
  constitution_hash: string;
  channel: "terminal";
  reference: string;
  binding: string;
  gate_id: string;
  checkpoint_id: string;
  assessment_id: string;
  assessment_hash: string;
  feature_id: string;
  run_key: string;
  workspace_digest: string;
  decision: "approve" | "reject";
  issued_at: string;
}

export interface ConstitutionImpactApplication {
  schema_version: 1;
  application_id: string;
  capability_id: string;
  proof_binding: string;
  gate_id: string;
  checkpoint_id: string;
  assessment_id: string;
  answer_id: string;
  feature_id: string;
  run_key: string;
  decision: "approve";
  previous_binding_hash: string;
  current_binding_hash: string;
  stale_artifacts: string[];
  handoff_ref: string | null;
  previous_handoff_ref: string | null;
  pre_workspace_digest: string;
  workspace_digest: string;
  applied_at: string;
}

export interface ConstitutionImpactApplyInput {
  feature_id: string;
  run_key: string;
  gate_id: string;
  checkpoint_id: string;
  assessment_id: string;
  assessment_hash: string;
  workspace_digest: string;
  proof: ConstitutionImpactDecisionProof;
}

function failure(code: RuntimeFailureCode, error: string): ConstitutionImpactRuntimeOutcome<never> {
  return { ok: false, code, error };
}


interface ConstitutionImpactTransaction {
  schema_version: 1;
  transaction_id: string;
  phase: "prepared" | "committed";
  application: ConstitutionImpactApplication;
  previous_binding: ConstitutionBinding;
  current_binding: ConstitutionBinding;
  pre_workspace_digest: string;
  workspace: FeatureWorkspace;
  handoff: ImplementationHandoff | null;
  claim: ExecutionClaim | null;
}
function impactBindingHash(binding: ConstitutionBinding): string {
  return digestOf({
    provider_id: binding.provider_id,
    path: binding.path,
    version: binding.version,
    content_sha256: binding.content_sha256,
    semantic_hash: binding.semantic_hash,
    validation_ref: binding.validation_ref,
  });
}

function sameBinding(left: ConstitutionBinding, right: ConstitutionBinding): boolean {
  return left.provider_id === right.provider_id
    && left.path === right.path
    && left.version === right.version
    && left.content_sha256 === right.content_sha256
    && left.semantic_hash === right.semantic_hash
    && left.validation_ref === right.validation_ref;
}

function isConstitutionBinding(value: unknown): value is ConstitutionBinding {
  return isRecord(value) && validateConstitutionBinding(value).length === 0;
}

function boundedImpactJson(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (++nodes > MAX_IMPACT_JSON_NODES || current.depth > MAX_IMPACT_JSON_DEPTH) return false;
    if (typeof current.value === "string") {
      if (Buffer.byteLength(current.value, "utf8") > MAX_IMPACT_JSON_STRING_BYTES) return false;
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_IMPACT_JSON_ARRAY) return false;
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (current.value && typeof current.value === "object") {
      if (Object.getPrototypeOf(current.value) !== Object.prototype && Object.getPrototypeOf(current.value) !== null) return false;
      const keys = Object.keys(current.value);
      if (keys.length > MAX_IMPACT_JSON_KEYS) return false;
      for (const key of keys) {
        if (Buffer.byteLength(key, "utf8") > MAX_IMPACT_JSON_STRING_BYTES) return false;
        pending.push({ value: (current.value as Record<string, unknown>)[key], depth: current.depth + 1 });
      }
    }
  }
  return true;
}

function readPinnedJson<T>(root: PinnedProjectRoot, relativePath: string, maxBytes: number): T | null {
  try {
    const source = root.readFile(relativePath, { maxBytes });
    if (!root.isStable()) return null;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
    const parsed: unknown = JSON.parse(raw);
    return boundedImpactJson(parsed) && root.isStable() ? parsed as T : null;
  } catch {
    return null;
  }
}

function artifactInventory(
  workspace: FeatureWorkspace,
  runKey: string,
  pinnedRoot: PinnedProjectRoot,
): ConstitutionImpactRuntimeOutcome<ApprovedArtifactImpactInput[]> {
  const seen = new Set<string>();
  const artifacts: ApprovedArtifactImpactInput[] = [];
  for (const phase of workspace.phases) {
    const versions = new Set<number>();
    if (phase.current_version !== null) versions.add(phase.current_version);
    if (phase.approved_version !== null) versions.add(phase.approved_version);
    for (const version of versions) {
      const artifactId = `${phase.phase}.v${version}`;
      if (seen.has(artifactId)) continue;
      seen.add(artifactId);
      const artifact = readCanonicalPhaseArtifact(pinnedRoot.canonical_root, {
        feature_id: workspace.feature_id,
        run_key: runKey,
        phase: phase.phase,
        version,
      }, pinnedRoot);
      if (!artifact) return failure("SPEC_IMPACT_EVIDENCE_INVALID", `approved phase artifact '${artifactId}' is missing, malformed, tampered, or not canonically bound`);
      artifacts.push({
        artifact_id: artifact.artifact_id,
        semantic_section_hashes: { ...artifact.semantic_section_hashes },
        depends_on: artifact.upstream_versions.map((entry) => entry.artifact_id),
      });
    }
  }
  return { ok: true, value: artifacts };
}

function handoffFor(
  workspace: FeatureWorkspace,
  pinnedRoot: PinnedProjectRoot,
): ConstitutionImpactRuntimeOutcome<ImplementationHandoff | null> {
  if (!workspace.handoff_ref) return { ok: true, value: null };
  const relativePath = join(
    ".work-state", "features", workspace.feature_id, "artifacts", "implementation_handoff", `${workspace.handoff_ref}.json`,
  );
  const handoff = readPinnedJson<ImplementationHandoff>(pinnedRoot, relativePath, MAX_IMPACT_HANDOFF_BYTES);
  if (!handoff) return failure("SPEC_STATE_INVALID", `implementation handoff '${workspace.handoff_ref}' is missing or unreadable`);
  const valid = validateImplementationHandoff(handoff);
  if (!valid.ok || handoff.handoff_id !== workspace.handoff_ref || canonicalHandoffDigest(handoff) !== handoff.handoff_digest) {
    return failure("SPEC_STATE_INVALID", `implementation handoff '${workspace.handoff_ref}' is invalid or stale`);
  }
  return { ok: true, value: handoff };
}

function assessmentFor(
  projectRoot: string,
  featureId: string,
  runKey: string,
  pinnedRoot: PinnedProjectRoot,
): ConstitutionImpactRuntimeOutcome<{
  workspace: FeatureWorkspace;
  assessment: ConstitutionImpactResult;
  previous_binding: ConstitutionBinding;
  current_binding: ConstitutionBinding;
}> {
  const resolved = resolveFeatureWorkspace(projectRoot, { feature_id: featureId, run_key: runKey }, {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  });
  if (!resolved.ok) return failure(resolved.code === "SPEC_PATH_UNAUTHORIZED" ? resolved.code : "SPEC_STATE_INVALID", resolved.error);
  const workspace = resolved.value;
  if (!workspace.constitution_binding || validateConstitutionBinding(workspace.constitution_binding).length > 0) {
    return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "feature workspace has no valid previous constitution binding");
  }
  const inventory = artifactInventory(workspace, runKey, pinnedRoot);
  if (!inventory.ok) return inventory;
  const current = resolveCurrentConstitutionBinding(projectRoot, { explicit_path: workspace.constitution_binding.path, pinnedRoot });
  if (!current.ok) return failure(current.code === "SPEC_DRAFT_INVALID" ? "SPEC_CONSTITUTION_IMPACT_PENDING" : "SPEC_STATE_INVALID", current.error);
  const assessment = assessConstitutionImpact(projectRoot, {
    feature_id: workspace.feature_id,
    run_key: runKey,
    previous_binding: workspace.constitution_binding,
    current_binding: current.value,
    approved_artifacts: inventory.value,
  }, pinnedRoot);
  if (!assessment.ok) return failure(assessment.code, assessment.error);
  return {
    ok: true,
    value: {
      workspace,
      assessment: assessment.value,
      previous_binding: workspace.constitution_binding,
      current_binding: current.value,
    },
  };
}

export function createConstitutionImpactAnswerCapability(
  projectRoot: string,
  input: {
    feature_id: string;
    run_key: string;
    gate_id: string;
    checkpoint_id: string;
    assessment_id: string;
    assessment_hash: string;
    workspace_digest: string;
    decision: "approve" | "reject";
    request_nonce: string;
    actor_session_id: string;
    actor_session: object;
    config: { question_id: string; question: string; header: string; allowed: readonly string[] };
  },
): ConstitutionImpactRuntimeOutcome<unknown> {
  if (!isSafeFeatureId(input.feature_id) || !isSafeCtoRunId(input.run_key)
    || typeof input.gate_id !== "string" || input.gate_id.trim().length === 0
    || typeof input.checkpoint_id !== "string" || input.checkpoint_id.trim().length === 0
    || !isSha256Hex(input.assessment_hash) || !isSha256Hex(input.workspace_digest)
    || !IMPACT_DECISIONS.includes(input.decision) || !IMPACT_NONCE.test(input.request_nonce)
    || typeof input.actor_session_id !== "string" || input.actor_session_id.trim().length === 0
    || Buffer.byteLength(input.actor_session_id, "utf8") > 4096
    || !input.actor_session || typeof input.actor_session !== "object"
    || !input.config || typeof input.config !== "object"
    || typeof input.config.question_id !== "string"
    || typeof input.config.question !== "string"
    || typeof input.config.header !== "string"
    || !Array.isArray(input.config.allowed)
    || input.config.allowed.length !== IMPACT_DECISIONS.length
    || input.config.allowed[0] !== IMPACT_DECISIONS[0]
    || input.config.allowed[1] !== IMPACT_DECISIONS[1]
    || !input.config.question_id.endsWith(input.request_nonce)
    || Buffer.byteLength(input.config.question, "utf8") > 64 * 1024
    || Buffer.byteLength(input.config.header, "utf8") > 4096) {
    return failure("SPEC_PROOF_INVALID", "constitution impact Ask capability inputs are invalid");
  }
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return failure("SPEC_PATH_UNAUTHORIZED", "constitution impact Ask capability requires a pinned project root");
  try {
    const gate = readProjectConstitutionGate(pinnedRoot.canonical_root, pinnedRoot);
    if (!gate.ok || !gate.value.binding) return failure("SPEC_PROOF_INVALID", "constitution impact gate identity is missing or stale");
    const assessed = assessmentFor(pinnedRoot.canonical_root, input.feature_id, input.run_key, pinnedRoot);
    if (!assessed.ok) return assessed;
    const publication = assessed.value;
    const checkpointId = `constitution-impact:${input.feature_id}:${publication.assessment.assessment_id}`;
    if (gate.value.gate_id !== input.gate_id
      || checkpointId !== input.checkpoint_id
      || publication.assessment.assessment_id !== input.assessment_id
      || publication.assessment.assessment_hash !== input.assessment_hash
      || digestOf(publication.workspace) !== input.workspace_digest
      || !sameBinding(gate.value.binding, publication.previous_binding)
      || !isConstitutionBinding(publication.workspace.constitution_binding)
      || !sameBinding(gate.value.binding, publication.workspace.constitution_binding)) {
      return failure("SPEC_PROOF_INVALID", "constitution impact Ask capability selectors are stale or mismatched");
    }
    if (!pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", "project root changed before constitution impact Ask capability issuance");
    if (!impactAskNonces.delete(input.request_nonce)) return failure("SPEC_PROOF_INVALID", "constitution impact Ask nonce was not issued by the engine or was already consumed");
    const token = `constitution-impact-capability-${randomUUID()}`;
    const capability: ImpactAnswerCapability = {
      token,
      nonce: input.request_nonce,
      canonicalRoot: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
      featureId: input.feature_id,
      runKey: input.run_key,
      gateId: input.gate_id,
      checkpointId: input.checkpoint_id,
      assessmentId: input.assessment_id,
      assessmentHash: input.assessment_hash,
      workspaceDigest: input.workspace_digest,
      decision: input.decision,
      previousBindingHash: impactBindingHash(publication.previous_binding),
      currentBindingHash: impactBindingHash(publication.current_binding),
      configHash: impactConfigHash(input.config, input.request_nonce),
      actorSessionId: input.actor_session_id,
      actorSession: input.actor_session,
      consumed: false,
    };
    const handle = Object.freeze({ token, [IMPACT_CAPABILITY_BRAND]: true as const }) as ImpactAnswerCapabilityHandle;
    impactAnswerCapabilities.set(token, capability);
    impactAnswerHandles.set(handle, capability);
    return { ok: true, value: handle };
  } finally {
    pinnedRoot.close();
  }
}

export function assessConstitutionImpactForFeature(
  projectRoot: string,
  input: { feature_id: string; run_key: string },
): ConstitutionImpactRuntimeOutcome<ConstitutionImpactAssessmentPublication> {
  if (!isSafeFeatureId(input.feature_id) || !isSafeCtoRunId(input.run_key)) {
    return failure("SPEC_STATE_INVALID", "feature_id and run_key must be explicit and valid");
  }
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return failure("SPEC_PATH_UNAUTHORIZED", "project root cannot be pinned for constitution impact assessment");
  try {
    const gate = readProjectConstitutionGate(pinnedRoot.canonical_root, pinnedRoot);
    if (!gate.ok || !gate.value.binding) return failure("SPEC_CONSTITUTION_IMPACT_PENDING", gate.ok ? "constitution gate has no approved binding" : gate.error);
    const assessed = assessmentFor(pinnedRoot.canonical_root, input.feature_id, input.run_key, pinnedRoot);
    if (!assessed.ok) return assessed;
    if (!sameBinding(gate.value.binding, assessed.value.previous_binding)
      || !isConstitutionBinding(assessed.value.workspace.constitution_binding)
      || !sameBinding(gate.value.binding, assessed.value.workspace.constitution_binding)) {
      return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution gate does not match the feature's approved previous constitution binding");
    }
    if (!workspaceRootIsStable({ lexical_root: pinnedRoot.lexical_root, canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino, pinned_root: pinnedRoot })) {
      return failure("SPEC_PATH_UNAUTHORIZED", "project root changed during constitution impact assessment");
    }
    return {
      ok: true,
      value: {
        feature_id: input.feature_id,
        run_key: input.run_key,
        gate_id: gate.value.gate_id,
        checkpoint_id: `constitution-impact:${input.feature_id}:${assessed.value.assessment.assessment_id}`,
        workspace_digest: digestOf(assessed.value.workspace),
        previous_binding: assessed.value.previous_binding,
        current_binding: assessed.value.current_binding,
        assessment: assessed.value.assessment,
        allowed_decisions: IMPACT_DECISIONS,
      },
    };
  } finally {
    pinnedRoot.close();
  }
}

function decisionPayload(proof: Record<string, unknown>): Record<string, unknown> {
  const { binding: _binding, ...payload } = proof;
  return payload;
}
const DECISION_PROOF_FIELDS = [
  "schema_version", "answer_id", "capability_id", "nonce", "actor_session_id", "config_hash", "constitution_hash", "channel", "reference", "binding",
  "gate_id", "checkpoint_id", "assessment_id", "assessment_hash", "feature_id",
  "run_key", "workspace_digest", "decision", "issued_at",
] as const;
const IMPACT_REFERENCE_PREFIX = "terminal:constitution_impact_ask_selected:";

interface ConstitutionImpactProofExpectation {
  project_root_hash: string;
  gate_id: string;
  checkpoint_id: string;
  assessment: ConstitutionImpactResult;
  feature_id: string;
  run_key: string;
  workspace_digest: string;
  decision: "approve" | "reject";
  capability_id?: string;
  nonce?: string;
  actor_session_id?: string;
  config_hash?: string;
  constitution_hash?: string;
}

function canonicalImpactAnswerId(expected: ConstitutionImpactProofExpectation): string {
  return `constitution-impact-answer-${digestOf({
    project_root_hash: expected.project_root_hash,
    gate_id: expected.gate_id,
    checkpoint_id: expected.checkpoint_id,
    feature_id: expected.feature_id,
    run_key: expected.run_key,
    workspace_digest: expected.workspace_digest,
    assessment_id: expected.assessment.assessment_id,
    assessment_hash: expected.assessment.assessment_hash,
  })}`;
}

function canonicalIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateDecisionProof(
  value: unknown,
  expected: ConstitutionImpactProofExpectation,
): ConstitutionImpactDecisionProof | null {
  if (!isRecord(value)
    || Object.keys(value).length !== DECISION_PROOF_FIELDS.length
    || DECISION_PROOF_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(value, field))) return null;
  const answerId = canonicalImpactAnswerId(expected);
  if (value.schema_version !== 1
    || value.answer_id !== answerId
    || (expected.capability_id !== undefined && value.capability_id !== expected.capability_id)
    || (expected.nonce !== undefined && value.nonce !== expected.nonce)
    || (expected.actor_session_id !== undefined && value.actor_session_id !== expected.actor_session_id)
    || (expected.config_hash !== undefined && value.config_hash !== expected.config_hash)
    || (expected.constitution_hash !== undefined && value.constitution_hash !== expected.constitution_hash)
    || typeof value.capability_id !== "string"
    || !IMPACT_CAPABILITY_ID.test(value.capability_id)
    || typeof value.nonce !== "string"
    || !IMPACT_NONCE.test(value.nonce)
    || typeof value.actor_session_id !== "string"
    || value.actor_session_id.trim().length === 0
    || !isSha256Hex(value.config_hash)
    || !isSha256Hex(value.constitution_hash)
    || value.channel !== "terminal"
    || value.reference !== `${IMPACT_REFERENCE_PREFIX}${answerId}`
    || value.gate_id !== expected.gate_id
    || value.checkpoint_id !== expected.checkpoint_id
    || value.assessment_id !== expected.assessment.assessment_id
    || value.assessment_hash !== expected.assessment.assessment_hash
    || value.feature_id !== expected.feature_id
    || value.run_key !== expected.run_key
    || value.workspace_digest !== expected.workspace_digest
    || value.decision !== expected.decision
    || value.issued_at !== expected.assessment.assessed_at
    || !isSha256Hex(value.assessment_hash)
    || !isSha256Hex(value.workspace_digest)
    || !canonicalIsoTimestamp(value.issued_at)
    || !isSha256Hex(value.binding)
    || value.binding !== digestOf(decisionPayload(value))) return null;
  return value as unknown as ConstitutionImpactDecisionProof;
}

function proofExpectation(
  projectRootHash: string,
  gateId: string,
  checkpointId: string,
  assessment: ConstitutionImpactResult,
  featureId: string,
  runKey: string,
  workspaceDigest: string,
  decision: "approve" | "reject",
): ConstitutionImpactProofExpectation {
  return {
    project_root_hash: projectRootHash,
    gate_id: gateId,
    checkpoint_id: checkpointId,
    assessment,
    feature_id: featureId,
    run_key: runKey,
    workspace_digest: workspaceDigest,
    decision,
  };
}

function readPersistedDecision(
  root: PinnedProjectRoot,
  expected: ConstitutionImpactProofExpectation,
): ConstitutionImpactDecisionProof | null {
  const answerId = canonicalImpactAnswerId(expected);
  const path = decisionPath(root, answerId);
  if (!path) return null;
  return validateDecisionProof(readPinnedJson<unknown>(root, path, MAX_IMPACT_PROOF_BYTES), expected);
}

function readDecision(
  root: PinnedProjectRoot,
  answer: unknown,
  expected: ConstitutionImpactProofExpectation,
): ConstitutionImpactDecisionProof | null {
  const checked = readPersistedDecision(root, expected);
  if (!checked || canonicalJson(checked) !== canonicalJson(answer)) return null;
  return checked;
}
function capabilityForHandle(value: unknown): ImpactAnswerCapability | null {
  if (!value || typeof value !== "object") return null;
  return impactAnswerHandles.get(value) ?? null;
}

function capabilityForProof(value: unknown): ImpactAnswerCapability | null {
  if (!isRecord(value) || typeof value.capability_id !== "string" || !IMPACT_CAPABILITY_ID.test(value.capability_id)) return null;
  return impactAnswerCapabilities.get(value.capability_id) ?? null;
}

function consumeAfterImpactCommit<T>(capability: ImpactAnswerCapability | null, outcome: ConstitutionImpactRuntimeOutcome<T>): ConstitutionImpactRuntimeOutcome<T> {
  if (outcome.ok && capability) capability.consumed = true;
  return outcome;
}

function capabilitySelectorsMatch(
  capability: ImpactAnswerCapability,
  expected: { canonicalRoot: string; dev: number; ino: number; featureId: string; runKey: string; gateId: string; checkpointId: string; assessmentId: string; assessmentHash: string; workspaceDigest: string; decision: "approve" | "reject" },
): boolean {
  return capability.canonicalRoot === expected.canonicalRoot
    && capability.dev === expected.dev
    && capability.ino === expected.ino
    && capability.featureId === expected.featureId
    && capability.runKey === expected.runKey
    && capability.gateId === expected.gateId
    && capability.checkpointId === expected.checkpointId
    && capability.assessmentId === expected.assessmentId
    && capability.assessmentHash === expected.assessmentHash
    && capability.workspaceDigest === expected.workspaceDigest
    && capability.decision === expected.decision;
}

export function recordConstitutionImpactAnswer(
  projectRoot: string,
  input: {
    feature_id: string;
    run_key: string;
    gate_id: string;
    checkpoint_id: string;
    assessment_id: string;
    assessment_hash: string;
    workspace_digest: string;
    decision: "approve" | "reject";
  },
  capabilityValue?: unknown,
): ConstitutionImpactRuntimeOutcome<ConstitutionImpactDecisionProof> {
  const capability = capabilityForHandle(capabilityValue);
  if (!capability || capability.consumed) return failure("SPEC_PROOF_INVALID", "constitution impact answer requires a live engine-issued Ask capability");
  if (!isSafeFeatureId(input.feature_id) || !isSafeCtoRunId(input.run_key)
    || typeof input.gate_id !== "string" || input.gate_id.trim().length === 0
    || typeof input.checkpoint_id !== "string" || input.checkpoint_id.trim().length === 0
    || !IMPACT_DECISIONS.includes(input.decision) || !isSha256Hex(input.assessment_hash) || !isSha256Hex(input.workspace_digest)) {
    return failure("SPEC_PROOF_INVALID", "constitution impact answer selectors, checkpoint, digests, and decision are invalid");
  }
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return failure("SPEC_PATH_UNAUTHORIZED", "constitution impact answer cannot be recorded without a pinned project root");
  try {
    if (!capabilitySelectorsMatch(capability, { canonicalRoot: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino, featureId: input.feature_id, runKey: input.run_key, gateId: input.gate_id, checkpointId: input.checkpoint_id, assessmentId: input.assessment_id, assessmentHash: input.assessment_hash, workspaceDigest: input.workspace_digest, decision: input.decision })) return failure("SPEC_PROOF_INVALID", "constitution impact Ask capability is bound to a different root or assessment");
    const gate = readProjectConstitutionGate(pinnedRoot.canonical_root, pinnedRoot);
    if (!gate.ok || !gate.value.binding) return failure("SPEC_PROOF_INVALID", "constitution impact gate identity is missing or stale");
    const assessed = assessmentFor(pinnedRoot.canonical_root, input.feature_id, input.run_key, pinnedRoot);
    if (!assessed.ok) return assessed;
    if (!sameBinding(gate.value.binding, assessed.value.previous_binding)
      || !isConstitutionBinding(assessed.value.workspace.constitution_binding)
      || !sameBinding(gate.value.binding, assessed.value.workspace.constitution_binding)) {
      return failure("SPEC_PROOF_INVALID", "constitution gate does not match the feature's approved previous constitution binding");
    }
    const publicationWorkspaceDigest = digestOf(assessed.value.workspace);
    const checkpointId = `constitution-impact:${input.feature_id}:${assessed.value.assessment.assessment_id}`;
    if (gate.value.gate_id !== input.gate_id
      || checkpointId !== input.checkpoint_id
      || assessed.value.assessment.assessment_id !== input.assessment_id
      || assessed.value.assessment.assessment_hash !== input.assessment_hash
      || publicationWorkspaceDigest !== input.workspace_digest) {
      return failure("SPEC_PROOF_INVALID", "constitution impact assessment is stale or mismatched");
    }
    if (!pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", "project root changed during constitution impact answer validation");
    const canonicalAssessment = readConstitutionImpactEvidence(pinnedRoot.canonical_root, input.assessment_id, pinnedRoot);
    if (!canonicalAssessment || canonicalJson(canonicalAssessment) !== canonicalJson(assessed.value.assessment)) {
      return failure("SPEC_PROOF_INVALID", "constitution impact assessment evidence is not the canonical engine record");
    }
    const expectedProof = {
      ...proofExpectation(
        canonicalAssessment.project_root_hash,
        input.gate_id,
        input.checkpoint_id,
        canonicalAssessment,
        input.feature_id,
        input.run_key,
        input.workspace_digest,
        input.decision,
      ),
      capability_id: capability.token,
      nonce: capability.nonce,
      actor_session_id: capability.actorSessionId,
      config_hash: capability.configHash,
      constitution_hash: capability.currentBindingHash,
    };
    const answerId = canonicalImpactAnswerId(expectedProof);
    const proofWithoutBinding = {
      schema_version: 1 as const,
      answer_id: answerId,
      capability_id: capability.token,
      nonce: capability.nonce,
      actor_session_id: capability.actorSessionId,
      config_hash: capability.configHash,
      constitution_hash: capability.currentBindingHash,
      channel: "terminal" as const,
      reference: `${IMPACT_REFERENCE_PREFIX}${answerId}`,
      gate_id: input.gate_id,
      checkpoint_id: input.checkpoint_id,
      assessment_id: input.assessment_id,
      assessment_hash: input.assessment_hash,
      feature_id: input.feature_id,
      run_key: input.run_key,
      workspace_digest: input.workspace_digest,
      decision: input.decision,
      issued_at: canonicalAssessment.assessed_at,
    };
    const proof: ConstitutionImpactDecisionProof = { ...proofWithoutBinding, binding: digestOf(proofWithoutBinding) };
    if (!validateDecisionProof(proof, expectedProof)) {
      return failure("SPEC_PROOF_INVALID", "constitution impact answer proof failed canonical validation");
    }
    if (!pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", "project root changed before constitution impact answer persistence");
    const answerCurrent = resolveCurrentConstitutionBinding(pinnedRoot.canonical_root, { explicit_path: assessed.value.assessment.current_binding.path, pinnedRoot });
    if (!answerCurrent.ok || !sameBinding(answerCurrent.value, assessed.value.assessment.current_binding)) {
      return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution changed again before impact answer proof persistence");
    }
    if (!pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", "project root changed before constitution impact answer proof persistence");
    pinnedRoot.ensureDirectory(IMPACT_DECISION_DIR);
    const path = decisionPath(pinnedRoot, answerId)!;
    const existing = readDecision(pinnedRoot, proof, expectedProof);
    if (existing) return { ok: true, value: existing };
    const persistedExpected = { ...expectedProof, capability_id: undefined, nonce: undefined, actor_session_id: undefined, config_hash: undefined, constitution_hash: undefined };
    const persistedExisting = readPersistedDecision(pinnedRoot, persistedExpected);
    if (persistedExisting) {
      const priorCapability = capabilityForProof(persistedExisting);
      const replaySelectorsMatch = priorCapability ? capabilitySelectorsMatch(priorCapability, { canonicalRoot: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino, featureId: input.feature_id, runKey: input.run_key, gateId: input.gate_id, checkpointId: input.checkpoint_id, assessmentId: input.assessment_id, assessmentHash: input.assessment_hash, workspaceDigest: input.workspace_digest, decision: input.decision }) : false;
      if (priorCapability && !priorCapability.consumed
        && priorCapability.actorSessionId === capability.actorSessionId
        && priorCapability.configHash === capability.configHash
        && priorCapability.currentBindingHash === capability.currentBindingHash
        && replaySelectorsMatch) return { ok: true, value: persistedExisting };
    }
    const proofBytes = Buffer.from(JSON.stringify(proof, null, 2) + "\n", "utf8");
    let proofReceipt: PinnedRootWriteReceipt | undefined;
    try {
      proofReceipt = pinnedRoot.writeExclusiveWithReceipt(path, proofBytes);
    } catch (error) {
      if (!(error instanceof PinnedRootError) || error.code !== "exists") {
        return failure("SPEC_IMPACT_EVIDENCE_INVALID", `constitution impact answer could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const cleanupProof = () => {
      if (proofReceipt) rollbackPinnedRootWriteReceipt(pinnedRoot, proofReceipt);
    };
    const afterBinding = resolveCurrentConstitutionBinding(pinnedRoot.canonical_root, { explicit_path: assessed.value.assessment.current_binding.path, pinnedRoot });
    const afterAssessment = readConstitutionImpactEvidence(pinnedRoot.canonical_root, input.assessment_id, pinnedRoot);
    const sourceDrifted = !pinnedRoot.isStable()
      || !afterBinding.ok
      || !sameBinding(afterBinding.value, assessed.value.assessment.current_binding)
      || !afterAssessment
      || canonicalJson(afterAssessment) !== canonicalJson(assessed.value.assessment);
    const persisted = readDecision(pinnedRoot, proof, expectedProof);
    if (sourceDrifted) {
      cleanupProof();
      return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution changed while impact answer proof was being persisted");
    }
    if (!persisted || !pinnedRoot.isStable()) {
      cleanupProof();
      return failure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact answer failed durable verification");
    }
    return { ok: true, value: persisted };
  } finally {
    pinnedRoot.close();
  }
}
const APPLICATION_FIELDS = [
  "schema_version", "application_id", "capability_id", "proof_binding", "gate_id", "checkpoint_id", "assessment_id", "answer_id",
  "feature_id", "run_key", "decision", "previous_binding_hash", "current_binding_hash",
  "stale_artifacts", "handoff_ref", "previous_handoff_ref", "pre_workspace_digest", "workspace_digest", "applied_at",
] as const;

interface ConstitutionImpactApplicationExpectation {
  application_id: string;
  capability_id: string;
  proof_binding: string;
  gate_id: string;
  checkpoint_id: string;
  assessment_id: string;
  answer_id: string;
  feature_id: string;
  run_key: string;
  previous_binding_hash: string;
  current_binding_hash: string;
  pre_workspace_digest: string;
  allowed_stale_artifacts: ReadonlySet<string>;
  current_handoff_ref?: string | null;
  previous_handoff_ref?: string | null;
}

function validateApplication(
  value: unknown,
  expected: ConstitutionImpactApplicationExpectation,
): ConstitutionImpactApplication | null {
  if (!isRecord(value) || Object.keys(value).length !== APPLICATION_FIELDS.length
    || APPLICATION_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(value, field))) return null;
  if (value.schema_version !== 1 || value.application_id !== expected.application_id
    || value.capability_id !== expected.capability_id
    || !IMPACT_CAPABILITY_ID.test(String(value.capability_id))
    || value.proof_binding !== expected.proof_binding
    || !isSha256Hex(value.proof_binding)
    || value.gate_id !== expected.gate_id || value.checkpoint_id !== expected.checkpoint_id
    || value.assessment_id !== expected.assessment_id || value.answer_id !== expected.answer_id
    || value.feature_id !== expected.feature_id || value.run_key !== expected.run_key
    || value.decision !== "approve" || value.previous_binding_hash !== expected.previous_binding_hash
    || value.current_binding_hash !== expected.current_binding_hash
    || value.pre_workspace_digest !== expected.pre_workspace_digest
    || !isSha256Hex(value.previous_binding_hash) || !isSha256Hex(value.current_binding_hash)
    || !isSha256Hex(value.pre_workspace_digest) || !isSha256Hex(value.workspace_digest)
    || typeof value.applied_at !== "string" || Number.isNaN(Date.parse(value.applied_at))) return null;
  if (!Array.isArray(value.stale_artifacts)) return null;
  const seen = new Set<string>();
  for (const artifactId of value.stale_artifacts) {
    if (typeof artifactId !== "string" || !/^(?:specify|plan|tasks)\.v[1-9][0-9]*$/u.test(artifactId)
      || seen.has(artifactId) || !expected.allowed_stale_artifacts.has(artifactId)) return null;
    seen.add(artifactId);
  }
  for (const field of ["handoff_ref", "previous_handoff_ref"] as const) {
    if (value[field] !== null && (typeof value[field] !== "string" || value[field].trim().length === 0)) return null;
  }
  if (expected.current_handoff_ref !== undefined && value.handoff_ref !== expected.current_handoff_ref) return null;
  if (expected.previous_handoff_ref !== undefined && value.previous_handoff_ref !== expected.previous_handoff_ref) return null;
  return value as unknown as ConstitutionImpactApplication;
}


function transactionPath(root: PinnedProjectRoot, transactionId: string): string | null {
  return IMPACT_TRANSACTION_FILE.test(transactionId) ? join(IMPACT_DECISION_DIR, `${transactionId}.json`) : null;
}

function transactionIdFor(applicationId: string): string {
  return `constitution-impact-transaction-${digestOf({ application_id: applicationId })}`;
}

function serializeImpactTransaction(
  value: ConstitutionImpactTransaction,
): ConstitutionImpactRuntimeOutcome<Buffer> {
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    return failure(
      "SPEC_IMPACT_EVIDENCE_INVALID",
      `constitution impact transaction could not be serialized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength > MAX_IMPACT_TRANSACTION_BYTES) {
    return failure(
      "SPEC_IMPACT_EVIDENCE_INVALID",
      `constitution impact transaction exceeds ${MAX_IMPACT_TRANSACTION_BYTES}-byte limit`,
    );
  }
  return { ok: true, value: bytes };
}

function validateImpactTransaction(value: unknown): ConstitutionImpactTransaction | null {
  const fields = [
    "schema_version", "transaction_id", "phase", "application", "previous_binding",
    "current_binding", "pre_workspace_digest", "workspace", "handoff", "claim",
  ] as const;
  if (!isRecord(value) || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.prototype.hasOwnProperty.call(value, field))) return null;
  if (value.schema_version !== 1 || (value.phase !== "prepared" && value.phase !== "committed")
    || typeof value.transaction_id !== "string" || !IMPACT_TRANSACTION_FILE.test(value.transaction_id)
    || !isSha256Hex(value.pre_workspace_digest)) return null;
  const application = value.application;
  if (!isRecord(application)) return null;
  const expectedApplication: ConstitutionImpactApplicationExpectation = {
    application_id: typeof application.application_id === "string" ? application.application_id : "",
    capability_id: typeof application.capability_id === "string" ? application.capability_id : "",
    proof_binding: typeof application.proof_binding === "string" ? application.proof_binding : "",
    gate_id: typeof application.gate_id === "string" ? application.gate_id : "",
    checkpoint_id: typeof application.checkpoint_id === "string" ? application.checkpoint_id : "",
    assessment_id: typeof application.assessment_id === "string" ? application.assessment_id : "",
    answer_id: typeof application.answer_id === "string" ? application.answer_id : "",
    feature_id: typeof application.feature_id === "string" ? application.feature_id : "",
    run_key: typeof application.run_key === "string" ? application.run_key : "",
    previous_binding_hash: typeof application.previous_binding_hash === "string" ? application.previous_binding_hash : "",
    current_binding_hash: typeof application.current_binding_hash === "string" ? application.current_binding_hash : "",
    pre_workspace_digest: typeof application.pre_workspace_digest === "string" ? application.pre_workspace_digest : "",
    allowed_stale_artifacts: new Set(Array.isArray(application.stale_artifacts) ? application.stale_artifacts.filter((item): item is string => typeof item === "string") : []),
  };
  const checkedApplication = validateApplication(application, expectedApplication);
  if (!checkedApplication || checkedApplication.pre_workspace_digest !== value.pre_workspace_digest) return null;
  const previous = value.previous_binding;
  const current = value.current_binding;
  if (!isConstitutionBinding(previous) || !isConstitutionBinding(current)) return null;
  const workspaceValidation = validateFeatureWorkspaceRecord(value.workspace);
  if (!workspaceValidation.ok) return null;
  if (!isRecord(value.workspace)
    || digestOf(value.workspace) !== checkedApplication.workspace_digest
    || digestOf(previous) !== checkedApplication.previous_binding_hash
    || digestOf(current) !== checkedApplication.current_binding_hash
    || !isConstitutionBinding(value.workspace.constitution_binding)
    || !sameBinding(value.workspace.constitution_binding, current)
    || value.workspace.handoff_ref !== checkedApplication.handoff_ref) return null;
  if (value.handoff !== null) {
    const handoffValidation = validateImplementationHandoff(value.handoff);
    if (!handoffValidation.ok) return null;
    if (!isRecord(value.handoff) || value.handoff.feature_id !== checkedApplication.feature_id
      || value.handoff.handoff_id !== checkedApplication.handoff_ref) return null;
  } else if (checkedApplication.handoff_ref !== null) {
    return null;
  }
  if (value.claim !== null) {
    const claimValidation = validateExecutionClaim(value.claim);
    if (!claimValidation.ok || !isRecord(value.claim) || value.claim.status !== "blocked") return null;
  }
  if (value.transaction_id !== transactionIdFor(checkedApplication.application_id)) return null;
  return value as unknown as ConstitutionImpactTransaction;
}

interface ImpactTransactionReadReceipt {
  readonly path: string;
  readonly bytes: Readonly<Uint8Array>;
  readonly expectation: PinnedRootFileExpectation;
}

interface ImpactTransactionRead {
  present: boolean;
  value: ConstitutionImpactTransaction | null;
  receipt: ImpactTransactionReadReceipt | null;
}

function readImpactTransaction(
  root: PinnedProjectRoot,
  transactionId: string,
): ImpactTransactionRead {
  const path = transactionPath(root, transactionId);
  if (!path) return { present: true, value: null, receipt: null };
  let source: ReturnType<PinnedProjectRoot["readFile"]>;
  try {
    if (!root.pathEntryExists(path)) return { present: false, value: null, receipt: null };
    source = root.readFile(path, { maxBytes: MAX_IMPACT_TRANSACTION_BYTES });
  } catch {
    return { present: true, value: null, receipt: null };
  }
  const bytes = Buffer.from(source.bytes);
  const receipt: ImpactTransactionReadReceipt = {
    path,
    bytes,
    expectation: {
      dev: source.dev,
      ino: source.ino,
      size: source.size ?? bytes.byteLength,
      sha256: sha256Hex(bytes.toString("utf8")),
    },
  };
  try {
    if (!root.isStable()) return { present: true, value: null, receipt };
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(raw);
    return {
      present: true,
      value: boundedImpactJson(parsed) ? validateImpactTransaction(parsed) : null,
      receipt,
    };
  } catch {
    return { present: true, value: null, receipt };
  }
}

function impactTransactionReadMatches(
  pinnedRoot: PinnedProjectRoot,
  receipt: ImpactTransactionReadReceipt,
): boolean {
  try {
    const observed = pinnedRoot.readFile(receipt.path, { maxBytes: MAX_IMPACT_TRANSACTION_BYTES });
    return observed.dev === receipt.expectation.dev
      && observed.ino === receipt.expectation.ino
      && (observed.size ?? observed.bytes.byteLength) === receipt.expectation.size
      && sha256Hex(Buffer.from(observed.bytes).toString("utf8")) === receipt.expectation.sha256
      && Buffer.compare(Buffer.from(observed.bytes), Buffer.from(receipt.bytes)) === 0;
  } catch {
    return false;
  }
}

function exactClaim(value: unknown, expected: ExecutionClaim): boolean {
  return isRecord(value) && canonicalJson(value) === canonicalJson(expected);
}

interface ImpactRecoveryFileSnapshot {
  path: string;
  receipt?: PinnedRootWriteReceipt;
  stateReceipts?: readonly StateMutationReceipt[];
}

function captureImpactRecoveryFile(
  pinnedRoot: PinnedProjectRoot,
  path: string,
  _maxBytes = MAX_IMPACT_TRANSACTION_BYTES,
): ImpactRecoveryFileSnapshot {
  // Capture only path authorization here. Every mutation later registers its
  // exact descriptor receipt; rollback never adopts a pathname readback.
  pinnedRoot.pathEntryInfo(path);
  return { path };
}

function verifyImpactRecoveryReceipt(
  pinnedRoot: PinnedProjectRoot,
  snapshot: ImpactRecoveryFileSnapshot,
  maxBytes = MAX_IMPACT_TRANSACTION_BYTES,
): boolean {
  const receipt = snapshot.receipt;
  if (!receipt) return false;
  try {
    const observed = pinnedRoot.readFile(snapshot.path, { maxBytes });
    return observed.dev === receipt.descriptor.dev
      && observed.ino === receipt.descriptor.ino
      && sha256Hex(Buffer.from(observed.bytes).toString("utf8")) === receipt.descriptor.sha256;
  } catch {
    return false;
  }
}

function rollbackImpactRecoveryFiles(
  pinnedRoot: PinnedProjectRoot,
  snapshots: readonly ImpactRecoveryFileSnapshot[],
): void {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (!snapshot || (!snapshot.receipt && !snapshot.stateReceipts)) continue;
    if (snapshot.receipt) {
      rollbackPinnedRootWriteReceipt(pinnedRoot, snapshot.receipt);
      continue;
    }
    if (snapshot.stateReceipts) {
      rollbackStateMutationReceipts(pinnedRoot, snapshot.stateReceipts);
    }
  }
}

function impactClaimJournalFiles(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
): string[] {
  const base = join(".work-state", "features", featureId, "artifacts", "execution_claim");
  const paths = [join(base, "root.json"), join(base, "manifest.json")];
  try {
    for (const name of pinnedRoot.listDirectory(join(base, "next"))) paths.push(join(base, "next", name));
  } catch {
    // The transaction's claim preimage may not have a successor directory.
  }
  return paths;
}

/** Capture the claim journal's deterministic append target before blocking the claim. */
function impactClaimTransitionPlan(
  pinnedRoot: PinnedProjectRoot,
  featureId: string,
): { paths: string[]; target: string; previous: string | null } {
  const base = join(".work-state", "features", featureId, "artifacts", "execution_claim");
  const rootPath = join(base, "root.json");
  const paths = impactClaimJournalFiles(pinnedRoot, featureId);
  let currentPath = rootPath;
  let tailDigest: string | null = null;
  try {
    for (let depth = 0; depth < 256; depth += 1) {
      if (!pinnedRoot.pathEntryExists(currentPath)) break;
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        pinnedRoot.readFile(currentPath, { maxBytes: MAX_IMPACT_TRANSACTION_BYTES }).bytes,
      ));
      tailDigest = digestOf(parsed);
      const nextPath = join(base, "next", `${tailDigest}.json`);
      if (!pinnedRoot.pathEntryExists(nextPath)) break;
      paths.push(nextPath);
      currentPath = nextPath;
    }
  } catch {
    // A malformed journal will be rejected by blockExecutionClaim before it writes.
  }
  const target = tailDigest === null ? rootPath : join(base, "next", `${tailDigest}.json`);
  paths.push(target);
  return { paths: [...new Set(paths)], target, previous: tailDigest };
}

/** Authorize recovery against the exact source postimage carried by its WAL.
 * Unlike the general reader, this permits the transaction's own pending WAL. */
function impactRecoveryTransactionError(
  pinnedRoot: PinnedProjectRoot,
  receipt: ImpactTransactionReadReceipt | null,
): string | null {
  if (!receipt || !impactTransactionReadMatches(pinnedRoot, receipt)) {
    return "constitution impact transaction descriptor changed after parse; preserve the replacement and recover the original transaction before retrying";
  }
  return null;
}

function impactRecoveryConstitutionError(
  pinnedRoot: PinnedProjectRoot,
  transaction: ConstitutionImpactTransaction,
): string | null {
  if (!pinnedRoot.isStable()) return "project root changed before constitution impact recovery";
  const current = resolveCurrentConstitutionBinding(pinnedRoot.canonical_root, {
    explicit_path: transaction.current_binding.path,
    pinnedRoot,
  });
  if (!current.ok || !sameBinding(current.value, transaction.current_binding)) {
    return "current constitution source no longer matches the impact transaction binding";
  }
  const gate = readProjectConstitutionGate(pinnedRoot.canonical_root, pinnedRoot);
  if (!gate.ok || !gate.value.binding || gate.value.gate_id !== transaction.application.gate_id) {
    return "constitution impact recovery gate identity is missing or stale";
  }
  const gateAtPrevious = sameBinding(gate.value.binding, transaction.previous_binding);
  const gateAtCurrent = sameBinding(gate.value.binding, transaction.current_binding);
  const postWorkspace = digestOf(transaction.workspace) === transaction.application.workspace_digest;
  if (transaction.phase === "prepared") {
    if (!gateAtPrevious && !(gateAtCurrent && postWorkspace)) return "constitution impact recovery gate is neither its exact preimage nor postimage";
  } else if (!gateAtCurrent || !postWorkspace) {
    return "committed constitution impact recovery gate or workspace postimage is stale";
  }
  const assessment = readConstitutionImpactEvidence(pinnedRoot.canonical_root, transaction.application.assessment_id, pinnedRoot);
  if (!assessment || assessment.assessment_id !== transaction.application.assessment_id) return "constitution impact recovery assessment identity is stale";
  if (!pinnedRoot.isStable()) return "project root changed during constitution impact recovery validation";
  return null;
}

function recoverImpactTransaction(
  pinnedRoot: PinnedProjectRoot,
  transaction: ConstitutionImpactTransaction,
  transactionReceipt: ImpactTransactionReadReceipt | null,
): ConstitutionImpactRuntimeOutcome<ConstitutionImpactApplication> {
  if (!pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", "project root changed before constitution impact recovery");
  const recoveryTransactionError = impactRecoveryTransactionError(pinnedRoot, transactionReceipt);
  if (recoveryTransactionError) return failure("SPEC_IMPACT_RECOVERY_REQUIRED", recoveryTransactionError);
  const recoveryConstitutionError = impactRecoveryConstitutionError(pinnedRoot, transaction);
  if (recoveryConstitutionError) return failure("SPEC_CONSTITUTION_IMPACT_PENDING", recoveryConstitutionError);
  let activeTransactionReceipt = transactionReceipt;
  let recoveryFailure = (code: RuntimeFailureCode, error: string): ConstitutionImpactRuntimeOutcome<never> => failure(code, error);
  const assertRecoveryTransaction = (): ConstitutionImpactRuntimeOutcome<never> | null => {
    const error = impactRecoveryTransactionError(pinnedRoot, activeTransactionReceipt);
    return error ? recoveryFailure("SPEC_IMPACT_RECOVERY_REQUIRED", error) : null;
  };
  const assertRecoveryConstitution = (): ConstitutionImpactRuntimeOutcome<never> | null => {
    const error = impactRecoveryConstitutionError(pinnedRoot, transaction);
    return error ? recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", error) : null;
  };
  const assertRecoveryReady = (): ConstitutionImpactRuntimeOutcome<never> | null =>
    assertRecoveryTransaction() ?? assertRecoveryConstitution();
  let committedBytes: Buffer | null = null;
  if (transaction.phase === "prepared") {
    const committed = { ...transaction, phase: "committed" as const };
    const serializedCommitted = serializeImpactTransaction(committed);
    if (!serializedCommitted.ok) return serializedCommitted;
    committedBytes = serializedCommitted.value;
  }
  const app = transaction.application;
  const recoverySnapshots = new Map<string, ImpactRecoveryFileSnapshot>();
  recoveryFailure = (code, error) => {
    rollbackImpactRecoveryFiles(pinnedRoot, [...recoverySnapshots.values()]);
    return failure(code, error);
  };
  const trackRecoveryFile = (path: string, maxBytes = MAX_IMPACT_TRANSACTION_BYTES): ImpactRecoveryFileSnapshot => {
    const existing = recoverySnapshots.get(path);
    if (existing) return existing;
    const snapshot = captureImpactRecoveryFile(pinnedRoot, path, maxBytes);
    recoverySnapshots.set(path, snapshot);
    return snapshot;
  };
  const stateSnapshot = trackRecoveryFile(
    join(".work-state", "features", app.feature_id, "state.json"),
    8 * 1024 * 1024,
  );
  const gateSnapshot = trackRecoveryFile(
    join(".work-state", "specification", "constitution", "gate.json"),
    512 * 1024,
  );
  let claimSnapshots: ImpactRecoveryFileSnapshot[] = [];
  let claimTransitionTarget: string | null = null;
  const resolved = resolveFeatureWorkspace(pinnedRoot.canonical_root, {
    feature_id: app.feature_id,
    run_key: app.run_key,
  }, {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  });
  if (!resolved.ok) return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", resolved.error);
  let workspace = resolved.value;
  const workspaceDigest = digestOf(workspace);
  if (transaction.claim !== null) {
    const plan = impactClaimTransitionPlan(pinnedRoot, app.feature_id);
    claimTransitionTarget = plan.target;
    claimSnapshots = plan.paths.map((path) => trackRecoveryFile(path, MAX_IMPACT_TRANSACTION_BYTES));
    const targetSnapshot = claimSnapshots.find((snapshot) => snapshot.path === plan.target);

  }
  if (workspaceDigest !== transaction.pre_workspace_digest && workspaceDigest !== app.workspace_digest) {
    return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact transaction workspace is neither its preimage nor postimage");
  }
  const gate = readProjectConstitutionGate(pinnedRoot.canonical_root, pinnedRoot);
  if (!gate.ok || !gate.value.binding) return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact recovery gate is missing or malformed");
  const gateAtPrevious = sameBinding(gate.value.binding, transaction.previous_binding);
  const gateAtCurrent = sameBinding(gate.value.binding, transaction.current_binding);
  if (transaction.phase === "prepared") {
    if (!gateAtPrevious && !(workspaceDigest === app.workspace_digest && gateAtCurrent)) {
      return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact recovery gate no longer matches its exact preimage or committed postimage");
    }
  } else if (workspaceDigest !== app.workspace_digest || !gateAtCurrent) {
    return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", "committed constitution impact transaction is not at its exact durable postimage");
  }
  if (!pinnedRoot.isStable()) return recoveryFailure("SPEC_PATH_UNAUTHORIZED", "project root changed before constitution impact recovery writes");
  if (transaction.handoff) {
    const handoffGuard = assertRecoveryReady();
    if (handoffGuard) return handoffGuard;
    const handoffDir = join(".work-state", "features", app.feature_id, "artifacts", "implementation_handoff");
    pinnedRoot.ensureDirectory(handoffDir);
    const handoffPath = join(handoffDir, `${transaction.handoff.handoff_id}.json`);
    const handoffSnapshot = trackRecoveryFile(handoffPath, MAX_IMPACT_HANDOFF_BYTES);
    let existingHandoffPresent: boolean;
    try {
      existingHandoffPresent = pinnedRoot.pathEntryExists(handoffPath);
    } catch {
      return recoveryFailure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact recovery handoff path is unreadable");
    }
    const existingHandoff = existingHandoffPresent
      ? readPinnedJson<ImplementationHandoff>(pinnedRoot, handoffPath, MAX_IMPACT_HANDOFF_BYTES)
      : null;
    if (existingHandoffPresent && !existingHandoff) {
      return recoveryFailure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact recovery handoff is missing, malformed, oversized, or changed");
    }
    if (!pinnedRoot.isStable()) return recoveryFailure("SPEC_PATH_UNAUTHORIZED", "constitution impact recovery handoff snapshot changed while being read");
    if (existingHandoff && canonicalJson(existingHandoff) !== canonicalJson(transaction.handoff)) {
      return recoveryFailure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact recovery handoff collides with different bytes");
    }
    if (!existingHandoff) {
      const handoffGuard = assertRecoveryReady();
      if (handoffGuard) return handoffGuard;
      const handoffBytes = Buffer.from(JSON.stringify(transaction.handoff, null, 2) + "\n", "utf8");
      // The publication receipt owns the exact preimage and published inode;
      // rollback never re-reads and adopts a concurrent replacement.
      try {
        handoffSnapshot.receipt = pinnedRoot.writeExclusiveWithReceipt(handoffPath, handoffBytes);
      } catch (error) {
        rollbackImpactRecoveryFiles(pinnedRoot, [...recoverySnapshots.values()]);
        return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", `constitution impact recovery handoff write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const claim = readCurrentExecutionClaim(pinnedRoot.canonical_root, app.feature_id, pinnedRoot);
  if (!claim.ok) return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", claim.error);
  if (transaction.claim === null) {
    if (claim.value) return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact recovery found an unexpected execution claim");
  } else if (!claim.value || !exactClaim(claim.value, transaction.claim)) {
    if (!claim.value || claim.value.claim_id !== transaction.claim.claim_id || claim.value.status !== "active") {
      return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact recovery claim is neither its active preimage nor blocked postimage");
    }
    const claimGuard = assertRecoveryReady();
    if (claimGuard) return claimGuard;
    let blocked: ReturnType<typeof blockExecutionClaim>;
    try {
      blocked = blockExecutionClaim(pinnedRoot.canonical_root, app.feature_id, {
        claim_id: transaction.claim.claim_id,
        handoff_digest: transaction.claim.handoff_digest,
        owner_kind: transaction.claim.owner_kind,
        owner_run_id: transaction.claim.owner_run_id,
        reason: transaction.claim.release_reason ?? "constitution impact approved by the current user",
        updated_at: transaction.claim.updated_at,
      }, pinnedRoot, {
        captureReceipts: true,
        onReceipt: (receipt) => {
          const journal = receipt.journal;
          if (!journal) return;
          const target = claimSnapshots.find((snapshot) => snapshot.path === journal.relative_path);
          if (target) target.receipt = journal;
        },
      });
    } catch (error) {
      return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", `constitution impact recovery claim write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!blocked.ok || !exactClaim(blocked.value, transaction.claim)) {
      return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", blocked.ok ? "constitution impact recovery claim postimage mismatch" : blocked.error);
    }
    const targetSnapshot = claimSnapshots.find((snapshot) => snapshot.path === claimTransitionTarget);
    if (targetSnapshot && (!targetSnapshot.receipt || !verifyImpactRecoveryReceipt(pinnedRoot, targetSnapshot, MAX_IMPACT_TRANSACTION_BYTES))) {
      return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact recovery claim journal receipt is missing or stale");
    }
  }
  if (workspaceDigest === transaction.pre_workspace_digest) {
    const workspaceGuard = assertRecoveryReady();
    if (workspaceGuard) return workspaceGuard;
    let persisted: ReturnType<typeof persistFeatureWorkspace>;
    try {
      persisted = persistFeatureWorkspace(
        pinnedRoot.canonical_root,
        transaction.workspace,
        { lexical_root: pinnedRoot.lexical_root, canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino, pinned_root: pinnedRoot },
        {
          expected_workspace_digest: transaction.pre_workspace_digest,
          pre_commit: () => {
            const error = impactRecoveryConstitutionError(pinnedRoot, transaction);
            if (error) throw new Error(error);
          },
        },
      );
    } catch (error) {
      return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", `constitution impact recovery workspace write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!persisted.ok) return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", persisted.error);
    if (!persisted.receipts || persisted.receipts.length === 0) return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact recovery workspace mutation receipts are missing");
    stateSnapshot.stateReceipts = persisted.receipts;
    workspace = persisted.value;
  } else if (workspaceDigest !== app.workspace_digest) {
    return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact recovery workspace postimage is not durable");
  }
  const gateGuard = assertRecoveryReady();
  if (gateGuard) return gateGuard;
  let committedGate: ReturnType<typeof commitConstitutionImpactBinding>;
  try {
    committedGate = commitConstitutionImpactBinding(pinnedRoot.canonical_root, {
      previous_binding: transaction.previous_binding,
      current_binding: transaction.current_binding,
      pinnedRoot,
      lock_held: true,
      beforeWrite: () => {
        const error = impactRecoveryConstitutionError(pinnedRoot, transaction);
        if (error) throw new Error(error);
      },
    });
  } catch (error) {
    return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", `constitution impact recovery gate write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!committedGate.ok) return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", committedGate.error);
  if (committedGate.receipt) gateSnapshot.receipt = committedGate.receipt;
  const expectedApplication: ConstitutionImpactApplicationExpectation = {
    application_id: app.application_id,
    capability_id: app.capability_id,
    proof_binding: app.proof_binding,
    gate_id: app.gate_id,
    checkpoint_id: app.checkpoint_id,
    assessment_id: app.assessment_id,
    answer_id: app.answer_id,
    feature_id: app.feature_id,
    run_key: app.run_key,
    previous_binding_hash: app.previous_binding_hash,
    current_binding_hash: app.current_binding_hash,
    pre_workspace_digest: app.pre_workspace_digest,
    allowed_stale_artifacts: new Set(app.stale_artifacts),
  };
  const appPath = applicationPath(pinnedRoot, app.application_id)!;
  const applicationSnapshot = trackRecoveryFile(appPath, MAX_IMPACT_TRANSACTION_BYTES);
  const existing = readApplication(pinnedRoot, expectedApplication);
  if (existing.present && (!existing.value || canonicalJson(existing.value) !== canonicalJson(app))) {
    return recoveryFailure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact recovery application collides with different bytes");
  }
  if (!existing.present) {
    const applicationGuard = assertRecoveryReady();
    if (applicationGuard) return applicationGuard;
    const applicationBytes = Buffer.from(JSON.stringify(app, null, 2) + "\n", "utf8");
    try {
      applicationSnapshot.receipt = pinnedRoot.writeExclusiveWithReceipt(appPath, applicationBytes);
    } catch (error) {
      rollbackImpactRecoveryFiles(pinnedRoot, [...recoverySnapshots.values()]);
      return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", `constitution impact recovery application write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const durable = readApplication(pinnedRoot, expectedApplication);
  if (!durable.value || canonicalJson(durable.value) !== canonicalJson(app)) {
    rollbackImpactRecoveryFiles(pinnedRoot, [...recoverySnapshots.values()]);
    return recoveryFailure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact recovery application postimage is not durable");
  }
  if (!activeTransactionReceipt) return recoveryFailure("SPEC_IMPACT_RECOVERY_REQUIRED", "constitution impact transaction receipt is unavailable before recovery mutation");
  if (transaction.phase === "prepared") {
    if (!committedBytes) return recoveryFailure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact committed WAL bytes are missing");
    const walGuard = assertRecoveryReady();
    if (walGuard) return walGuard;
    try {
      const published = pinnedRoot.replaceFileIfMatchesWithReceipt(
        activeTransactionReceipt.path,
        activeTransactionReceipt.expectation,
        committedBytes,
      );
      // The replacement receipt identifies the committed WAL inode. Keep the
      // original read bytes only for the source CAS; cleanup must target this
      // exact replacement, never a pathname.
      activeTransactionReceipt = {
        path: published.relative_path,
        bytes: committedBytes,
        expectation: published.descriptor,
      };
    } catch (error) {
      return recoveryFailure("SPEC_IMPACT_RECOVERY_REQUIRED", `constitution impact committed WAL descriptor changed before replacement: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const removeWalGuard = assertRecoveryReady();
  if (removeWalGuard) return removeWalGuard;
  try {
    pinnedRoot.removeFileIfMatches(activeTransactionReceipt.path, activeTransactionReceipt.expectation);
  } catch (error) {
    // The committed WAL and all postimages remain durable for replay; do not
    // roll them back after the final WAL removal itself fails.
    return failure("SPEC_IMPACT_RECOVERY_REQUIRED", `constitution impact transaction cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, value: durable.value };
}
function existingApplicationMatchesPostimage(
  application: ConstitutionImpactApplication,
  expected: ConstitutionImpactApplicationExpectation,
  assessment: ConstitutionImpactResult,
  proof: ConstitutionImpactDecisionProof,
  workspace: FeatureWorkspace,
  gateBinding: ConstitutionBinding,
): boolean {
  if (application.application_id !== expected.application_id
    || application.capability_id !== proof.capability_id
    || application.proof_binding !== proof.binding
    || application.applied_at !== proof.issued_at
    || application.pre_workspace_digest !== expected.pre_workspace_digest
    || application.workspace_digest !== digestOf(workspace)
    || application.previous_binding_hash !== digestOf(assessment.previous_binding)
    || application.current_binding_hash !== digestOf(assessment.current_binding)
    || !sameBinding(gateBinding, assessment.current_binding)
    || !isConstitutionBinding(workspace.constitution_binding)
    || !sameBinding(workspace.constitution_binding, assessment.current_binding)
    || canonicalJson(application.stale_artifacts)
      !== canonicalJson(assessment.artifact_results.filter((row) => row.verdict === "affected").map((row) => row.artifact_id))) {
    return false;
  }
  const impactSuffix = `.impact.${assessment.assessment_id.slice(-8)}`;
  const previousHandoffRef = workspace.handoff_ref?.endsWith(impactSuffix)
    ? workspace.handoff_ref.slice(0, -impactSuffix.length)
    : null;
  return application.previous_handoff_ref === previousHandoffRef
    && (!application.stale_artifacts.length || workspace.execution_claim_ref === null);
}

function pendingTransactionMatchesCurrentPostimage(
  transaction: ConstitutionImpactTransaction,
  expectedApplication: ConstitutionImpactApplicationExpectation,
  assessment: ConstitutionImpactResult,
  proof: ConstitutionImpactDecisionProof,
  workspace: FeatureWorkspace,
  pinnedRoot: PinnedProjectRoot,
): boolean {
  const applicationExpected: ConstitutionImpactApplicationExpectation = {
    ...expectedApplication,
    current_handoff_ref: undefined,
    previous_handoff_ref: undefined,
  };
  if (transaction.application.applied_at !== proof.issued_at
    || !validateApplication(transaction.application, applicationExpected)
    || transaction.pre_workspace_digest !== expectedApplication.pre_workspace_digest
    || !sameBinding(transaction.previous_binding, assessment.previous_binding)
    || !sameBinding(transaction.current_binding, assessment.current_binding)
    || digestOf(transaction.workspace) !== digestOf(workspace)
    || transaction.application.workspace_digest !== digestOf(workspace)
    || transaction.workspace.feature_id !== expectedApplication.feature_id
    || transaction.workspace.handoff_ref !== transaction.application.handoff_ref
    || canonicalJson(transaction.application.stale_artifacts)
      !== canonicalJson(assessment.artifact_results.filter((row) => row.verdict === "affected").map((row) => row.artifact_id))) {
    return false;
  }
  const impactSuffix = `.impact.${assessment.assessment_id.slice(-8)}`;
  const previousHandoffRef = workspace.handoff_ref?.endsWith(impactSuffix)
    ? workspace.handoff_ref.slice(0, -impactSuffix.length)
    : null;
  if (transaction.application.previous_handoff_ref !== previousHandoffRef) return false;
  if (!isConstitutionBinding(transaction.workspace.constitution_binding)
    || !sameBinding(transaction.workspace.constitution_binding, assessment.current_binding)) return false;
  const claim = readCurrentExecutionClaim(pinnedRoot.canonical_root, expectedApplication.feature_id, pinnedRoot);
  if (!claim.ok) return false;
  if (transaction.claim === null) return !claim.value;
  return !claim.value
    || exactClaim(claim.value, transaction.claim)
    || (claim.value.claim_id === transaction.claim.claim_id && claim.value.status === "active");
}
function readApplication(
  root: PinnedProjectRoot,
  expected: ConstitutionImpactApplicationExpectation,
): { present: boolean; value: ConstitutionImpactApplication | null } {
  const path = applicationPath(root, expected.application_id);
  if (!path) return { present: true, value: null };
  try {
    if (!root.pathEntryExists(path)) return { present: false, value: null };
  } catch {
    return { present: true, value: null };
  }
  const parsed = readPinnedJson<unknown>(root, path, MAX_IMPACT_APPLICATION_BYTES);
  return { present: true, value: validateApplication(parsed, expected) };
}

function staleHandoff(
  handoff: ImplementationHandoff,
  current: ConstitutionBinding,
  assessmentId: string,
  affected: boolean,
): ImplementationHandoff {
  const next: ImplementationHandoff = {
    ...handoff,
    handoff_id: `${handoff.handoff_id}.impact.${assessmentId.slice(-8)}`,
    handoff_digest: "",
    constitution_binding: { ...current },
    constitution_impact_ref: assessmentId,
    status: affected ? "stale" : handoff.status,
  };
  next.handoff_digest = canonicalHandoffDigest(next);
  return next;
}
export function applyConstitutionImpactForFeature(
  projectRoot: string,
  input: ConstitutionImpactApplyInput,
  actor?: { session_id: string; session: object },
): ConstitutionImpactRuntimeOutcome<ConstitutionImpactApplication> {
  if (!isRecord(input)) return failure("SPEC_PROOF_INVALID", "constitution impact apply input is missing");
  if (!isSafeFeatureId(input.feature_id) || !isSafeCtoRunId(input.run_key)
    || typeof input.gate_id !== "string" || input.gate_id.trim().length === 0
    || typeof input.checkpoint_id !== "string" || input.checkpoint_id.trim().length === 0
    || !isSha256Hex(input.assessment_hash) || !isSha256Hex(input.workspace_digest)) {
    return failure("SPEC_STATE_INVALID", "constitution impact apply requires explicit selectors, checkpoint, and SHA-256 CAS digests");
  }
  if (!isRecord(input.proof)) return failure("SPEC_PROOF_INVALID", "constitution impact decision proof is missing");
  const decision = input.proof.decision;
  if (decision !== "approve" && decision !== "reject") {
    return failure("SPEC_PROOF_INVALID", "constitution impact decision proof has an invalid decision");
  }
  if (input.proof.gate_id !== input.gate_id
    || input.proof.checkpoint_id !== input.checkpoint_id
    || input.proof.assessment_id !== input.assessment_id
    || input.proof.assessment_hash !== input.assessment_hash || input.proof.feature_id !== input.feature_id
    || input.proof.run_key !== input.run_key || input.proof.workspace_digest !== input.workspace_digest) {
    return failure("SPEC_PROOF_INVALID", "constitution impact decision proof does not match the requested application");
  }
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return failure("SPEC_PATH_UNAUTHORIZED", "project root cannot be pinned for constitution impact application");
  const borrowed: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };
  try {
    return withCtoRunLock(pinnedRoot.canonical_root, "__constitution__", () => withCtoRunLock(
      pinnedRoot.canonical_root,
      input.run_key,
      () => {
      const gate = readProjectConstitutionGate(pinnedRoot.canonical_root, pinnedRoot);
      if (!gate.ok || !gate.value.binding) return failure("SPEC_PROOF_INVALID", "constitution impact gate identity is missing or stale");
      if (gate.value.gate_id !== input.gate_id) return failure("SPEC_PROOF_INVALID", "constitution impact gate identity is missing or stale");
      const assessment = readConstitutionImpactEvidence(pinnedRoot.canonical_root, input.assessment_id, pinnedRoot);
      if (!assessment || assessment.assessment_hash !== input.assessment_hash) return failure("SPEC_PROOF_INVALID", "constitution impact assessment evidence is missing or stale");
      if (input.checkpoint_id !== `constitution-impact:${input.feature_id}:${assessment.assessment_id}`) {
        return failure("SPEC_PROOF_INVALID", "constitution impact checkpoint identity is stale");
      }
      const expectedProof = proofExpectation(
        assessment.project_root_hash,
        input.gate_id,
        input.checkpoint_id,
        assessment,
        input.feature_id,
        input.run_key,
        input.workspace_digest,
        decision,
      );
      const proof = readDecision(pinnedRoot, input.proof, expectedProof);
      if (!proof) return failure("SPEC_PROOF_INVALID", "constitution impact answer proof is missing, stale, or malformed");
      const capability = capabilityForProof(proof);
      const replayOnly = capability === null || capability.consumed;
      if (capability && !capabilitySelectorsMatch(capability, { canonicalRoot: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino, featureId: input.feature_id, runKey: input.run_key, gateId: input.gate_id, checkpointId: input.checkpoint_id, assessmentId: assessment.assessment_id, assessmentHash: assessment.assessment_hash, workspaceDigest: input.workspace_digest, decision })) return failure("SPEC_PROOF_INVALID", "constitution impact proof capability is bound to a different root or assessment");
      if (capability && capability.nonce !== proof.nonce) return failure("SPEC_PROOF_INVALID", "constitution impact proof nonce is not the engine-issued Ask capability nonce");
      if (capability && (capability.actorSessionId !== proof.actor_session_id
        || capability.configHash !== proof.config_hash
        || capability.currentBindingHash !== proof.constitution_hash)) return failure("SPEC_PROOF_INVALID", "constitution impact proof actor, UI configuration, or constitution binding is not the engine-issued Ask postimage");
      if (capability && !replayOnly
        && (!actor || actor.session_id !== capability.actorSessionId || actor.session !== capability.actorSession)) return failure("SPEC_PROOF_INVALID", "constitution impact apply must remain in the original approving host session");
      const resolved = resolveFeatureWorkspace(pinnedRoot.canonical_root, { feature_id: input.feature_id, run_key: input.run_key }, borrowed);
      if (!resolved.ok) return failure("SPEC_STATE_INVALID", resolved.error);
      const workspace = resolved.value;
      const workspaceDigest = digestOf(workspace);
      const workspaceBinding = isConstitutionBinding(workspace.constitution_binding) ? workspace.constitution_binding : null;
      const gateAtPrevious = sameBinding(gate.value.binding, assessment.previous_binding);
      const gateAtCurrent = sameBinding(gate.value.binding, assessment.current_binding);
      const workspaceAtPrevious = workspaceBinding !== null && sameBinding(workspaceBinding, assessment.previous_binding);
      const workspaceAtCurrent = workspaceBinding !== null && sameBinding(workspaceBinding, assessment.current_binding);
      if (decision === "reject") {
        if (workspaceDigest !== input.workspace_digest || !gateAtPrevious || !workspaceAtPrevious) {
          return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact reject proof is stale or no longer bound to the assessed workspace");
        }
        const current = resolveCurrentConstitutionBinding(pinnedRoot.canonical_root, { explicit_path: assessment.previous_binding.path, pinnedRoot });
        if (!current.ok || !sameBinding(current.value, assessment.current_binding)) {
          return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution changed again after impact assessment");
        }
        if (!pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", "project root changed during constitution impact validation");
        return failure("SPEC_CONSTITUTION_IMPACT_REJECTED", "constitution impact was rejected by the current user; no mutation was applied");
      }
      if (workspaceDigest === input.workspace_digest) {
        if (!gateAtPrevious || !workspaceAtPrevious) {
          return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact gate or workspace no longer matches the assessed previous binding");
        }
      } else if ((!gateAtPrevious && !gateAtCurrent) || (gateAtCurrent && !workspaceAtCurrent)) {
        return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution impact gate or workspace is neither its exact preimage nor postimage");
      }
      const currentSource = resolveCurrentConstitutionBinding(pinnedRoot.canonical_root, { explicit_path: assessment.previous_binding.path, pinnedRoot });
      if (!currentSource.ok || !sameBinding(currentSource.value, assessment.current_binding)) {
        return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution changed again after impact assessment");
      }
      const previousBindingHash = digestOf(assessment.previous_binding);
      const currentBindingHash = digestOf(assessment.current_binding);
      const applicationId = `constitution-impact-application-${digestOf({ answer_id: proof.answer_id, workspace_digest: input.workspace_digest })}`;
      const impactHandoffSuffix = `.impact.${assessment.assessment_id.slice(-8)}`;
      const expectedApplication: ConstitutionImpactApplicationExpectation = {
        application_id: applicationId,
        capability_id: proof.capability_id,
        proof_binding: proof.binding,
        gate_id: input.gate_id,
        checkpoint_id: input.checkpoint_id,
        assessment_id: assessment.assessment_id,
        answer_id: proof.answer_id,
        feature_id: input.feature_id,
        run_key: input.run_key,
        previous_binding_hash: previousBindingHash,
        current_binding_hash: currentBindingHash,
        pre_workspace_digest: input.workspace_digest,
        allowed_stale_artifacts: new Set(assessment.artifact_results.filter((row) => row.verdict === "affected").map((row) => row.artifact_id)),
        current_handoff_ref: workspace.handoff_ref,
        previous_handoff_ref: workspace.handoff_ref?.endsWith(impactHandoffSuffix)
          ? workspace.handoff_ref.slice(0, -impactHandoffSuffix.length)
          : null,
      };
      const transactionId = transactionIdFor(applicationId);
      const pending = readImpactTransaction(pinnedRoot, transactionId);
      if (pending.present && digestOf(workspace) !== input.workspace_digest) {
        if (!pending.value) return failure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact transaction is corrupt or mismatched");
        if (!pendingTransactionMatchesCurrentPostimage(pending.value, expectedApplication, assessment, proof, workspace, pinnedRoot)) {
          return failure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact transaction postimage does not match the current proof-derived state");
        }
        return consumeAfterImpactCommit(capability, recoverImpactTransaction(pinnedRoot, pending.value, pending.receipt));
      }
      const existing = readApplication(pinnedRoot, expectedApplication);
      if (existing.present && !pending.present) {
        if (!existing.value) return failure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact application bytes are corrupt or mismatched");
        if (!existingApplicationMatchesPostimage(existing.value, expectedApplication, assessment, proof, workspace, gate.value.binding!)) {
          return failure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact application receipt does not match the durable postimage");
        }
        return consumeAfterImpactCommit(capability, { ok: true, value: existing.value });
      }

      if (replayOnly) return failure("SPEC_IMPACT_RECOVERY_REQUIRED", "approval_recovery_required: constitution impact Ask capability is unavailable; rerun the trusted Ask before applying");
      if (digestOf(workspace) !== input.workspace_digest) return failure("SPEC_STATE_INVALID", "feature workspace changed after impact assessment");
      const previous = workspace.constitution_binding;
      if (!previous || !sameBinding(previous, assessment.previous_binding)) {
        return failure("SPEC_PROOF_INVALID", "constitution impact assessment is not bound to the current workspace");
      }
      const current = resolveCurrentConstitutionBinding(pinnedRoot.canonical_root, { explicit_path: assessment.previous_binding.path, pinnedRoot });
      if (!current.ok) return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution changed again after impact assessment");
      if (!sameBinding(current.value, assessment.current_binding)) return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "constitution changed again after impact assessment");
      if (!pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", "project root changed during constitution impact validation");
      const inventoryRows = assessment.artifact_results;
      const reason = `constitution impact ${assessment.assessment_id} approved by the current user`;
      const impacted = applyConstitutionImpact(workspace, inventoryRows, reason);
      const affected = inventoryRows.some((row) => row.verdict === "affected");
      if (!affected && workspace.execution_claim_ref) {
        return failure("SPEC_CONSTITUTION_IMPACT_PENDING", "no-impact constitution approval cannot revise a workspace with an active execution claim");
      }
      const handoffResult = handoffFor(workspace, pinnedRoot);
      if (!handoffResult.ok) return handoffResult;
      const previousHandoffRef = workspace.handoff_ref;
      let nextHandoff = handoffResult.value;
      if (nextHandoff) {
        const stale = applyHandoffStaleness(nextHandoff, impacted.stale_artifacts);
        nextHandoff = staleHandoff(stale.handoff, assessment.current_binding, assessment.assessment_id, affected || stale.stale);
      }
      const appliedAt = proof.issued_at;
      let nextClaim: ExecutionClaim | null = null;
      if (affected && workspace.execution_claim_ref) {
        const claim = readCurrentExecutionClaim(pinnedRoot.canonical_root, input.feature_id, pinnedRoot);
        if (!claim.ok) return failure("SPEC_STATE_INVALID", claim.error);
        if (claim.value) {
          const blockedClaim: ExecutionClaim = {
            ...claim.value,
            status: "blocked",
            updated_at: appliedAt,
            release_reason: reason,
          };
          nextClaim = blockedClaim;
        }
      }
      let nextWorkspace = bindWorkspaceConstitution(impacted.workspace, assessment.current_binding, workspace.constitution_gate_ref ?? undefined);
      if (nextHandoff) {
        nextWorkspace = { ...nextWorkspace, handoff_ref: nextHandoff.handoff_id };
      }
      if (affected) {
        nextWorkspace = { ...nextWorkspace, execution_claim_prepare_ref: null, execution_claim_ref: null, implementation_conformance_ref: null };
      }
      const application: ConstitutionImpactApplication = {
        schema_version: 1,
        application_id: applicationId,
        capability_id: proof.capability_id,
        proof_binding: proof.binding,
        gate_id: input.gate_id,
        checkpoint_id: input.checkpoint_id,
        assessment_id: assessment.assessment_id,
        answer_id: proof.answer_id,
        feature_id: input.feature_id,
        run_key: input.run_key,
        decision: "approve",
        previous_binding_hash: previousBindingHash,
        current_binding_hash: currentBindingHash,
        stale_artifacts: [...impacted.stale_artifacts],
        handoff_ref: nextWorkspace.handoff_ref,
        previous_handoff_ref: previousHandoffRef,
        pre_workspace_digest: input.workspace_digest,
        workspace_digest: digestOf(nextWorkspace),
        applied_at: appliedAt,
      };
      const transaction: ConstitutionImpactTransaction = {
        schema_version: 1,
        transaction_id: transactionId,
        phase: "prepared",
        application,
        previous_binding: assessment.previous_binding,
        current_binding: assessment.current_binding,
        pre_workspace_digest: input.workspace_digest,
        workspace: nextWorkspace,
        handoff: nextHandoff,
        claim: nextClaim,
      };
      if (!pinnedRoot.isStable()) return failure("SPEC_PATH_UNAUTHORIZED", "project root changed before constitution impact writes");
      if (!validateImpactTransaction(transaction)) return failure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact transaction postimages are invalid");
      const serializedTransaction = serializeImpactTransaction(transaction);
      if (!serializedTransaction.ok) return serializedTransaction;
      if (pending.present) {
        if (!pending.value || canonicalJson(pending.value) !== canonicalJson(transaction)) {
          return failure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact transaction does not match the proof-derived deterministic plan");
        }
        return recoverImpactTransaction(pinnedRoot, pending.value, pending.receipt);
      }
      pinnedRoot.ensureDirectory(IMPACT_DECISION_DIR);
      const transactionFile = transactionPath(pinnedRoot, transactionId)!;
      try {
        pinnedRoot.writeExclusive(transactionFile, serializedTransaction.value);
      } catch (error) {
        if (!(error instanceof PinnedRootError) || error.code !== "exists") {
          return failure("SPEC_IMPACT_EVIDENCE_INVALID", `constitution impact transaction could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const durable = readImpactTransaction(pinnedRoot, transactionId);
      if (!durable.value || canonicalJson(durable.value) !== canonicalJson(transaction)) {
        return failure("SPEC_IMPACT_EVIDENCE_INVALID", "constitution impact transaction failed durable verification");
      }
      if (!durable.receipt) return failure("SPEC_IMPACT_RECOVERY_REQUIRED", "constitution impact transaction receipt is unavailable after persistence");
      return consumeAfterImpactCommit(capability, recoverImpactTransaction(pinnedRoot, durable.value, durable.receipt));
      }, { pinnedRoot }), { pinnedRoot });
  } catch (error) {
    return failure("SPEC_STATE_INVALID", `constitution impact application failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pinnedRoot.close();
  }
}
