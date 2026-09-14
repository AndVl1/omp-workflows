/**
 * Shared `ensure_project_constitution` prerequisite (T020).
 *
 * One idempotent, project-scoped gate record shared by native Specify,
 * external compatibility validation, nested `/do-work` preparation, and CTO
 * preparation. Resolution order is explicit override, exactly one discovered
 * provider, then the native `CONSTITUTION.md` default. A usable constitution
 * binds immediately; an unusable one blocks the exact origin behind the
 * plugin-native two-decision bootstrap (`approve_continue` |
 * `request_changes`); there is no `approve_stop` because the origin stays
 * blocked until a current constitution is approved. `approve_continue`
 * consumes the resume marker exactly once and resumes the exact native or
 * import target (`specify`, or `compatibility_validation` for imports).
 *
 * Durable typed state under
 * `<root>/.work-state/specification/constitution/` is authoritative; replays
 * return the established record and never duplicate drafts, decisions, or
 * approvals. No external command or network access is ever performed.
 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { TextDecoder } from "node:util";
import { basename, dirname, join, resolve, sep } from "node:path";
import { checkpointAnswerBinding, consumeTrustedCheckpointAnswer, trustedCheckpointAnswerError } from "../engine/checkpoints.js";
import { atomicWriteFile, parseBoundedPersistedState, resolvePreparationStatePinned, resolveStatePinned, updateStateAtomically, type StateMutation } from "../engine/state.js";
import { PinnedProjectRoot, PinnedRootError, rollbackPinnedRootWriteReceipt, type PinnedRootFileExpectation, type PinnedRootWriteReceipt } from "./pinned-root.js";
import { withCtoRunLock } from "../cto/transaction-lock.js";
import type {
  CheckpointActor,
  CheckpointAnswerProof,
  TrustedCheckpointAnswer,
  ConstitutionOriginDescriptor,
  ConstitutionResume,
  ConstitutionResumeTarget,
  TeamState,
} from "../engine/types.js";
import { evaluateConstitutionUsability } from "../gates/constitution.js";
import {
  NATIVE_CONSTITUTION_PATH,
  NATIVE_CONSTITUTION_PROVIDER_ID,
  resolveConstitutionProvider,
} from "./constitution-provider.js";
import type {
  ConstitutionBinding,
  ConstitutionGateRecord,
  ConstitutionOriginKind,
  ConstitutionProviderSelection,
} from "./types.js";
import {
  isRecord,
  isSafeRelativePath,
  isSha256Hex,
  canonicalJson,
  digestOf,
  sha256Hex,
  validateConstitutionBinding,
  validateFeatureWorkspaceRecord,
} from "./validation.js";
import {
  loadConstitutionImpactEvidence,
  type ApprovedArtifactImpactInput,
  type ConstitutionImpactResult,
} from "./constitution-impact.js";
import { readCanonicalPhaseArtifact } from "./phase.js";
import { readPinnedCurrentConstitution } from "./constitution-identities.js";
import {
  bindWorkspaceConstitution,
  persistFeatureWorkspace,
  resolveFeatureWorkspace,
  type WorkspaceRootSnapshot,
} from "./workspace.js";

export type ConstitutionGateCode =
  | "SPEC_PATH_UNAUTHORIZED"
  | "SPEC_CONSTITUTION_SOURCE_AMBIGUOUS"
  | "SPEC_CONSTITUTION_DISCOVERY_FAILED"
  | "SPEC_INPUT_OVERSIZED"
  | "SPEC_GATE_UNKNOWN"
  | "SPEC_CHECKPOINT_UNKNOWN"
  | "SPEC_DECISION_INVALID"
  | "SPEC_PROOF_INVALID"
  | "SPEC_FEEDBACK_REQUIRED"
  | "SPEC_DRAFT_INVALID"
  | "SPEC_STATE_INVALID"
  | "SPEC_CONSTITUTION_IMPACT_PENDING";
export type ConstitutionGateOutcome<T> =
  | { ok: true; value: T; receipt?: PinnedRootWriteReceipt }
  | { ok: false; code: ConstitutionGateCode; error: string };

/** Reference to an immutable answer in the engine-owned trusted ledger. */
export type ConstitutionTrustedProof = CheckpointAnswerProof;

export interface ConstitutionDraftPresentation {
  gate_id: string;
  feature_id: string;
  run_key: string;
  document: string;
}

export interface ConstitutionDecisionInput {
  gate_id: string;
  feature_id: string;
  run_key: string;
  checkpoint_id: string;
  decision: "approve_continue" | "request_changes" | (string & {});
  authorization: "human" | "policy_auto" | (string & {});
  actor_provenance: CheckpointActor;
  /** Required non-empty for `request_changes`; ignored otherwise. */
  feedback?: string;
}

const ORIGIN_KINDS: readonly ConstitutionOriginKind[] = ["native_direct", "do_work_nested", "cto_preparation", "external_import"];
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_FEATURE_STATE_BYTES = 8 * 1024 * 1024;
const MAX_DRAFTS = 25;
const MAX_DECISIONS = 100;
const DECISIONS = ["approve_continue", "request_changes"] as const;

type ConstitutionDecisionResult = ConstitutionGateOutcome<ConstitutionGateRecord & { resume?: ConstitutionResume; resume_consumed?: boolean; last_feedback?: string | null }>;

interface ConstitutionDraftRecord {
  version: number;
  document: string;
  document_sha256: string;
  validation_ref: string;
  presented_at: string;
}

interface ConstitutionUsabilityEvidence {
  schema_version: 1;
  ref: string;
  document_sha256: string;
  result: "usable";
  validator: "constitution-usability@1";
  checked_at: string;
}

interface ConstitutionDecisionRecord {
  checkpoint_id: string;
  decision: string;
  feedback: string | null;
  authorization: "human";
  actor_provenance: CheckpointActor;
  at: string;
}

/**
 * Constitution bootstrap answers are recorded in the project gate envelope,
 * before the normal workflow state/capability exists. They intentionally use
 * the same immutable answer/proof binding algorithm as workflow checkpoints.
 */
export interface ConstitutionTrustedAnswer extends TrustedCheckpointAnswer {
  gate_id: string;
  draft_sha256: string;
}

/**
 * Durable envelope around the canonical ConstitutionGateRecord. The gate
 * field is the canonical record; the siblings are the bounded bootstrap
 * ledger (draft versions, trusted answers, decision log, exact resume
 * descriptor).
 */
export interface ConstitutionGateEnvelope {
  schema_version: 1;
  gate_id: string;
  project_root: string;
  /** Feature workspace that opened the current bootstrap checkpoint. */
  feature_id: string | null;
  gate: ConstitutionGateRecord;
  origin: ConstitutionOriginDescriptor;
  drafts: ConstitutionDraftRecord[];
  trusted_answers?: ConstitutionTrustedAnswer[];
  decisions: ConstitutionDecisionRecord[];
  last_decision: { checkpoint_id: string; decision: string; feedback: string | null } | null;
  last_feedback: string | null;
  resume: ConstitutionResume | null;
  resume_marker_consumed: boolean;
}

const sha8 = (value: string): string => value.slice(0, 8);
const nowIso = (): string => new Date().toISOString();

/** Whitespace-normalized policy semantics; formatting-only edits keep this stable. */
function semanticHashOf(document: string): string {
  return sha256Hex(document.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim());
}

/** Parsed semantic version label; never trusted without the content digest. */
function parseVersion(document: string): string {
  const match = /(^|\n)Version:\s*([^\s]+)/i.exec(document);
  return match ? match[2]! : "0.0.0";
}

function validOrigin(origin: ConstitutionOriginDescriptor): boolean {
  return Boolean(origin)
    && ORIGIN_KINDS.includes(origin.origin_kind)
    && typeof origin.origin_run_key === "string"
    && origin.origin_run_key.trim().length > 0
    && origin.origin_run_key.length <= 256
    && typeof origin.origin_stage === "string"
    && origin.origin_stage.trim().length > 0
    && origin.origin_stage.length <= 128;
}

const CONSTITUTION_DIR_RELATIVE = join(".work-state", "specification", "constitution");
const CONSTITUTION_SOURCE_WRITE_WAL = join(CONSTITUTION_DIR_RELATIVE, "source-write-wal.json");

function constitutionDir(root: string, pinnedRoot?: PinnedProjectRoot): string {
  return pinnedRoot ? pinnedRoot.anchorPath(CONSTITUTION_DIR_RELATIVE) : join(root, CONSTITUTION_DIR_RELATIVE);
}

function pathEntryExists(path: string, pinnedRoot?: PinnedProjectRoot): boolean {
  if (pinnedRoot) {
    const relativePath = pinnedRoot.relativePath(path);
    return relativePath !== null && pinnedRoot.pathEntryExists(relativePath);
  }
  if (existsSync(path)) return true;
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(realRoot: string, candidate: string): boolean {
  return candidate === realRoot || candidate.startsWith(realRoot + sep);
}

/**
 * Containment for existing and not-yet-existing paths. The candidate must be
 * lexically rooted under the canonical project root, and its deepest existing
 * ancestor (including a symlink at the candidate itself) must resolve there.
 */
function assertInsideRoot(root: string, absolute: string, pinnedRoot?: PinnedProjectRoot): boolean {
  if (pinnedRoot) {
    const relativePath = pinnedRoot.relativePath(absolute);
    if (relativePath === null || !pinnedRoot.isStable()) return false;
    try {
      const info = pinnedRoot.pathEntryInfo(relativePath);
      return info === null || info.kind === "file" || info.kind === "directory"
        ? pinnedRoot.isStable()
        : false;
    } catch {
      return false;
    }
  }
  try {
    const realRoot = realpathSync(root);
    const candidate = resolve(absolute);
    if (!isWithin(realRoot, candidate)) return false;
    let probe = candidate;
    for (;;) {
      if (pathEntryExists(probe)) return isWithin(realRoot, realpathSync(probe));
      const parent = dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  } catch {
    return false;
  }
}

function constitutionStateAncestorsSafe(root: string, pinnedRoot?: PinnedProjectRoot): boolean {
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) return false;
    let current = "";
    for (const segment of [".work-state", "specification", "constitution"]) {
      current = current ? join(current, segment) : segment;
      if (!pinnedRoot.pathEntryExists(current)) break;
      try { pinnedRoot.listDirectory(current); } catch { return false; }
    }
    return true;
  }
  try {
    const realRoot = realpathSync(root);
    let current = realRoot;
    for (const segment of [".work-state", "specification", "constitution"]) {
      current = join(current, segment);
      if (!pathEntryExists(current)) break;
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory() || !isWithin(realRoot, realpathSync(current))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function persistEnvelope(root: string, envelope: ConstitutionGateEnvelope, pinnedRoot?: PinnedProjectRoot, options: { beforeWrite?: () => void; afterWrite?: (receipt: PinnedRootWriteReceipt) => void } = {}): PinnedRootWriteReceipt | undefined {
  const dir = constitutionDir(root, pinnedRoot);
  const path = join(dir, "gate.json");
  if (!constitutionStateAncestorsSafe(root, pinnedRoot) || !assertInsideRoot(root, path, pinnedRoot)) throw new Error("constitution gate path escapes the authorized project root");
  const content = serializedGateEnvelope(envelope);
  if (pinnedRoot) {
    pinnedRoot.ensureDirectory(CONSTITUTION_DIR_RELATIVE);
    if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed while persisting constitution gate");
    options.beforeWrite?.();
    if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before constitution gate write");
    if (envelope.gate.binding
      && envelope.gate.status !== "blocked"
      && envelope.gate.status !== "constitution_required") {
      const current = readPinnedCurrentConstitution(root, pinnedRoot, envelope.gate.binding, { requireGate: false });
      if (!current.ok) {
        throw new Error(`SPEC_STALE: current constitution source changed before constitution gate write: ${current.error}`);
      }
    }
    const relativePath = join(CONSTITUTION_DIR_RELATIVE, "gate.json");
    const receipt = pinnedRoot.writeAtomicWithReceipt(relativePath, content);
    options.afterWrite?.(receipt);
    return receipt;
  }
  mkdirSync(dir, { recursive: true });
  if (!constitutionStateAncestorsSafe(root) || !assertInsideRoot(root, path)) throw new Error("constitution gate path escapes the authorized project root");
  atomicWriteFile(join(realpathSync(dir), basename(path)), content);
  return undefined;
}

class ConstitutionGatePersistenceError extends Error {
  readonly code: "SPEC_INPUT_OVERSIZED" = "SPEC_INPUT_OVERSIZED";

  constructor(message: string) {
    super(message);
    this.name = "ConstitutionGatePersistenceError";
  }
}

function draftArtifactPath(root: string, version: number, create: boolean, pinnedRoot?: PinnedProjectRoot): string {
  const relativePath = join(CONSTITUTION_DIR_RELATIVE, "drafts", "v" + version + ".json");
  const dir = join(constitutionDir(root, pinnedRoot), "drafts");
  const path = join(dir, "v" + version + ".json");
  if (!constitutionStateAncestorsSafe(root, pinnedRoot) || !assertInsideRoot(root, path, pinnedRoot)) throw new Error("constitution draft path escapes the authorized project root");
  if (create) {
    if (pinnedRoot) pinnedRoot.ensureDirectory(join(CONSTITUTION_DIR_RELATIVE, "drafts"));
    else mkdirSync(dir, { recursive: true });
  }
  if (!constitutionStateAncestorsSafe(root, pinnedRoot) || !assertInsideRoot(root, path, pinnedRoot)) throw new Error("constitution draft path escapes the authorized project root");
  if (pinnedRoot) return pinnedRoot.anchorPath(relativePath);
  return join(realpathSync(dir), basename(path));
}

function serializedDraftArtifact(gateId: string, draft: ConstitutionDraftRecord): Buffer {
  return Buffer.from(JSON.stringify({ gate_id: gateId, ...draft }, null, 2) + "\n", "utf8");
}

function draftArtifactMatchesPath(path: string, expected: Buffer, pinnedRoot?: PinnedProjectRoot): boolean {
  try {
    if (pinnedRoot) return Buffer.from(pinnedRoot.readFile(pinnedRoot.relativePath(path) ?? "").bytes).equals(expected);
    const entry = lstatSync(path);
    return entry.isFile() && readFileSync(path).equals(expected);
  } catch {
    return false;
  }
}

/** Verify the exact immutable bytes published for a draft version. */
function persistedDraftMatches(root: string, gateId: string, draft: ConstitutionDraftRecord, pinnedRoot?: PinnedProjectRoot): boolean {
  try {
    const target = draftArtifactPath(root, draft.version, false, pinnedRoot);
    return draftArtifactMatchesPath(target, serializedDraftArtifact(gateId, draft), pinnedRoot);
  } catch {
    return false;
  }
}

/**
 * Publish one immutable draft artifact. Existing paths are never adopted by
 * digest alone: the complete serialized bytes (including gate identity and
 * version) must match exactly.
 */
function persistDraft(root: string, gateId: string, draft: ConstitutionDraftRecord, pinnedRoot?: PinnedProjectRoot): string {
  const target = draftArtifactPath(root, draft.version, true, pinnedRoot);
  const expected = serializedDraftArtifact(gateId, draft);
  if (pathEntryExists(target, pinnedRoot)) {
    if (!draftArtifactMatchesPath(target, expected, pinnedRoot)) {
      throw new Error("immutable constitution draft artifact v" + draft.version + " already exists with different bytes");
    }
    return "constitution.draft.v" + draft.version;
  }
  if (pinnedRoot) pinnedRoot.writeExclusive(join(CONSTITUTION_DIR_RELATIVE, "drafts", "v" + draft.version + ".json"), expected.toString("utf8"));
  else atomicWriteFile(target, expected.toString("utf8"));
  if (!draftArtifactMatchesPath(target, expected, pinnedRoot)) {
    throw new Error("persisted constitution draft artifact v" + draft.version + " failed exact-byte verification");
  }
  return "constitution.draft.v" + draft.version;
}

function usabilityEvidenceRef(documentSha: string): string {
  return "constitution.validation." + documentSha;
}

function usabilityEvidencePath(root: string, documentSha: string): string {
  return join(constitutionDir(root), "validation-" + documentSha + ".json");
}

function loadUsabilityEvidence(
  root: string,
  validationRef: string,
  documentSha: string,
  pinnedRoot: PinnedProjectRoot,
): ConstitutionUsabilityEvidence | null {
  if (validationRef !== usabilityEvidenceRef(documentSha)) return null;
  const path = usabilityEvidencePath(root, documentSha);
  if (!constitutionStateAncestorsSafe(root, pinnedRoot) || !assertInsideRoot(root, path, pinnedRoot) || !pathEntryExists(path, pinnedRoot)) return null;
  try {
    const relativePath = pinnedRoot.relativePath(path);
    if (relativePath === null) return null;
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(
      pinnedRoot.readFile(relativePath, { maxBytes: MAX_EVIDENCE_BYTES }).bytes,
    );
    const parsed: unknown = JSON.parse(serialized);
    if (!boundedJsonShape(parsed, 8, 64) || !isRecord(parsed)
      || !exactKeys(parsed, ["checked_at", "document_sha256", "ref", "result", "schema_version", "validator"])
      || parsed.schema_version !== 1
      || parsed.ref !== validationRef
      || parsed.document_sha256 !== documentSha
      || parsed.result !== "usable"
      || parsed.validator !== "constitution-usability@1"
      || !boundedGateText(parsed.checked_at)) return null;
    return parsed as unknown as ConstitutionUsabilityEvidence;
  } catch {
    return null;
  }
}

function persistUsabilityEvidence(root: string, documentSha: string, pinnedRoot: PinnedProjectRoot): string {
  const ref = usabilityEvidenceRef(documentSha);
  const path = usabilityEvidencePath(root, documentSha);
  if (!constitutionStateAncestorsSafe(root, pinnedRoot) || !assertInsideRoot(root, path, pinnedRoot)) throw new Error("constitution validation evidence path escapes the authorized project root");
  const relativePath = pinnedRoot.relativePath(path);
  if (relativePath === null) throw new Error("constitution validation evidence path escapes the authorized project root");
  const evidence: ConstitutionUsabilityEvidence = {
    schema_version: 1,
    ref,
    document_sha256: documentSha,
    result: "usable",
    validator: "constitution-usability@1",
    checked_at: nowIso(),
  };
  const serialized = JSON.stringify(evidence, null, 2) + "\n";
  pinnedRoot.ensureDirectory(CONSTITUTION_DIR_RELATIVE);
  if (pinnedRoot.pathEntryExists(relativePath)) {
    if (!loadUsabilityEvidence(root, ref, documentSha, pinnedRoot)) throw new Error("existing constitution validation evidence is invalid");
    return ref;
  }
  pinnedRoot.writeExclusive(join(CONSTITUTION_DIR_RELATIVE, "validation-" + documentSha + ".json"), serialized);
  if (!loadUsabilityEvidence(root, ref, documentSha, pinnedRoot)) throw new Error("persisted constitution validation evidence could not be verified");
  return ref;
}

const MAX_GATE_BYTES = 2 * 1024 * 1024;
const MAX_GATE_FIELD_BYTES = 8 * 1024;
const MAX_TRUSTED_ANSWERS = MAX_DECISIONS;
const MAX_GATE_NODES = 8192;
const MAX_EVIDENCE_BYTES = 16 * 1024;
function serializedGateEnvelope(envelope: ConstitutionGateEnvelope): string {
  const content = JSON.stringify(envelope, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > MAX_GATE_BYTES) {
    throw new ConstitutionGatePersistenceError(`constitution gate envelope exceeds ${MAX_GATE_BYTES} bytes`);
  }
  return content;
}

function gatePersistenceFailure(error: unknown, context: string): { code: ConstitutionGateCode; error: string } {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    code: error instanceof ConstitutionGatePersistenceError ? error.code : "SPEC_STATE_INVALID",
    error: `${context}: ${detail}`,
  };
}

function boundedJsonShape(value: unknown, maxDepth = 16, maxNodes = MAX_GATE_NODES): boolean {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    if (++nodes > maxNodes || depth > maxDepth) return false;
    if (Array.isArray(candidate)) return candidate.every((item) => visit(item, depth + 1));
    if (isRecord(candidate)) return Object.values(candidate).every((item) => visit(item, depth + 1));
    return true;
  };
  return visit(value, 0);
}

function boundedGateText(value: unknown, maxBytes = MAX_GATE_FIELD_BYTES): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes;
}
function boundedGateFeedback(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= 8192
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function validPersistedBinding(value: unknown): value is ConstitutionBinding {
  if (!isRecord(value) || !validDigest(value.content_sha256) || !boundedGateText(value.validation_ref)) return false;
  return validateConstitutionBinding(value).length === 0
    && value.validation_ref === usabilityEvidenceRef(value.content_sha256);
}

function validPersistedSourcePreimage(value: unknown): value is ConstitutionSourcePreimage {
  if (!isRecord(value) || typeof value.kind !== "string" || !isSafeRelativePath(value.path)) return false;
  if (value.kind === "absent") return exactKeys(value, ["kind", "path"]);
  return value.kind === "file"
    && Number.isSafeInteger(value.dev)
    && (value.dev as number) >= 0
    && Number.isSafeInteger(value.ino)
    && (value.ino as number) >= 0
    && validDigest(value.sha256)
    && exactKeys(value, ["kind", "path", "dev", "ino", "sha256"]);
}

function validatePersistedGateEnvelope(value: unknown, expectedProjectRoot?: string): value is ConstitutionGateEnvelope {
  if (!boundedJsonShape(value)
    || !isRecord(value)
    || !exactKeys(value, ["schema_version", "gate_id", "project_root", "feature_id", "origin", "gate", "drafts", "decisions", "last_decision", "last_feedback", "resume", "resume_marker_consumed"], ["trusted_answers", "source_preimage"])
    || (value.source_preimage !== undefined && !validPersistedSourcePreimage(value.source_preimage))
    || value.schema_version !== 1
    || !boundedGateText(value.gate_id)
    || !boundedGateText(value.project_root, 4096)
    || (expectedProjectRoot !== undefined && value.project_root !== expectedProjectRoot)
    || (value.feature_id !== null && !boundedGateText(value.feature_id))
    || !isRecord(value.origin)
    || !validOrigin(value.origin as unknown as ConstitutionOriginDescriptor)
    || !isRecord(value.gate)
    || !Array.isArray(value.drafts)
    || value.drafts.length > MAX_DRAFTS
    || !Array.isArray(value.decisions)
    || value.decisions.length > MAX_DECISIONS
    || (value.trusted_answers !== undefined && (!Array.isArray(value.trusted_answers) || value.trusted_answers.length > MAX_TRUSTED_ANSWERS))
    || (value.last_decision !== null && !isRecord(value.last_decision))
    || (value.resume !== null && !isRecord(value.resume))
    || (value.last_feedback !== null && !boundedGateText(value.last_feedback))
    || typeof value.resume_marker_consumed !== "boolean") {
    return false;
  }
  const gate = value.gate;
  if (!exactKeys(gate, ["gate_id", "origin_kind", "origin_run_key", "origin_stage", "status", "usability_result", "provider", "constitution_workflow_ref", "checkpoint_ref", "binding", "resume_marker"])
    || gate.gate_id !== value.gate_id
    || !boundedGateText(gate.origin_run_key)
    || !boundedGateText(gate.origin_stage)
    || !ORIGIN_KINDS.includes(gate.origin_kind as ConstitutionOriginKind)
    || !["checking", "usable", "constitution_required", "awaiting_approval", "approved", "blocked"].includes(String(gate.status))
    || (gate.usability_result !== null && !["usable", "missing", "empty", "unresolved_template", "structurally_invalid"].includes(String(gate.usability_result)))
    || (gate.constitution_workflow_ref !== null && !boundedGateText(gate.constitution_workflow_ref))
    || (gate.checkpoint_ref !== null && !boundedGateText(gate.checkpoint_ref))
    || (gate.binding !== null && !validPersistedBinding(gate.binding))) {
    return false;
  }
  if (gate.provider !== null) {
    if (!isRecord(gate.provider)
      || !exactKeys(gate.provider, ["provider_id", "source", "path", "template_ref", "template_hash", "selection_hash", "selected_at"])
      || !boundedGateText(gate.provider.provider_id)
      || !["explicit_override", "discovered_provider", "native_default"].includes(String(gate.provider.source))
      || !isSafeRelativePath(gate.provider.path)
      || !boundedGateText(gate.provider.template_ref)
      || !validDigest(gate.provider.template_hash)
      || !validDigest(gate.provider.selection_hash)
      || !boundedGateText(gate.provider.selected_at)) return false;
  }
  if (value.source_preimage !== undefined && value.source_preimage.path !== gate.provider?.path) return false;
  for (const draft of value.drafts) {
    if (!isRecord(draft)
      || !exactKeys(draft, ["version", "document", "document_sha256", "validation_ref", "presented_at"])
      || !Number.isInteger(draft.version)
      || (draft.version as number) < 1
      || typeof draft.document !== "string"
      || Buffer.byteLength(draft.document, "utf8") > MAX_DOCUMENT_BYTES
      || !validDigest(draft.document_sha256)
      || draft.validation_ref !== usabilityEvidenceRef(draft.document_sha256)
      || !boundedGateText(draft.validation_ref)
      || !boundedGateText(draft.presented_at)) return false;
  }
  for (const decision of value.decisions) {
    if (!isRecord(decision)
      || !exactKeys(decision, ["checkpoint_id", "decision", "feedback", "authorization", "actor_provenance", "at"])
      || !boundedGateText(decision.checkpoint_id)
      || !boundedGateText(decision.decision)
      || (decision.feedback !== null && !boundedGateText(decision.feedback))
      || decision.authorization !== "human"
      || !isRecord(decision.actor_provenance)
      || !boundedJsonShape(decision.actor_provenance, 8, 128)
      || !boundedGateText(decision.at)) return false;
  }
  if (Array.isArray(value.trusted_answers)) {
    const requiredAnswerKeys = ["answer_id", "nonce", "channel", "reference", "run_id", "stage_id", "checkpoint_id", "work_identity_hash", "capability_id", "capability_epoch", "policy_hash", "decision", "binding", "issued_at", "gate_id", "draft_sha256"] as const;
    for (const answer of value.trusted_answers) {
      if (!isRecord(answer)
        || !exactKeys(answer, requiredAnswerKeys, ["feature_id", "loop_iteration", "subject_binding", "subject_revision", "consumed_at", "feedback"])
        || requiredAnswerKeys.some((key) => !boundedGateText(answer[key]))
        || (answer.feedback !== undefined && !boundedGateFeedback(answer.feedback))
        || !validDigest(answer.draft_sha256)
        || (answer.feature_id !== undefined && !boundedGateText(answer.feature_id))
        || (answer.loop_iteration !== undefined && (!Number.isInteger(answer.loop_iteration) || (answer.loop_iteration as number) < 0))
        || (answer.subject_binding !== undefined && !boundedGateText(answer.subject_binding))
        || (answer.subject_revision !== undefined && (!Number.isInteger(answer.subject_revision) || (answer.subject_revision as number) < 0))
        || (answer.consumed_at !== undefined && !boundedGateText(answer.consumed_at))) return false;
    }
  }
  if (value.last_decision !== null
    && (!exactKeys(value.last_decision, ["checkpoint_id", "decision", "feedback"])
      || typeof value.last_decision.checkpoint_id !== "string"
      || typeof value.last_decision.decision !== "string"
      || (value.last_decision.feedback !== null && typeof value.last_decision.feedback !== "string"))) return false;
  if (value.resume !== null
    && (!exactKeys(value.resume, ["origin_kind", "origin_run_key", "resume_target"])
      || !ORIGIN_KINDS.includes(value.resume.origin_kind as ConstitutionOriginKind)
      || typeof value.resume.origin_run_key !== "string"
      || typeof value.resume.resume_target !== "string")) return false;
  return true;
}

function persistedGateStatusConsistent(envelope: ConstitutionGateEnvelope): boolean {
  const gate = envelope.gate;
  const latest = envelope.drafts.length > 0 ? envelope.drafts[envelope.drafts.length - 1]! : null;
  if (gate.status === "constitution_required") return gate.binding === null && gate.checkpoint_ref === null && gate.usability_result !== "usable";
  if (gate.status === "checking") return gate.binding === null && gate.checkpoint_ref === null && gate.resume_marker === null && gate.usability_result === null;
  if (gate.status === "awaiting_approval") {
    return gate.binding === null
      && gate.usability_result === "usable"
      && typeof gate.checkpoint_ref === "string"
      && typeof gate.resume_marker === "string"
      && latest !== null
      && gate.checkpoint_ref === `${gate.gate_id}.checkpoint.v${latest.version}`;
  }
  if (gate.status === "usable" || gate.status === "approved") {
    return gate.binding !== null && gate.usability_result === "usable" && gate.checkpoint_ref === null;
  }
  return gate.status === "blocked" && gate.checkpoint_ref === null;
}

function persistedProviderMatchesSelection(
  provider: ConstitutionProviderSelection | null,
  selection: ConstitutionProviderSelection,
): boolean {
  return provider !== null
    && provider.provider_id === selection.provider_id
    && provider.source === selection.source
    && provider.path === selection.path
    && provider.template_ref === selection.template_ref
    && provider.template_hash === selection.template_hash
    && provider.selection_hash === selection.selection_hash;
}
function loadEnvelope(root: string, origin: ConstitutionOriginDescriptor, pinnedRoot?: PinnedProjectRoot): ConstitutionGateEnvelope | null {
  if (!pinnedRoot || !pinnedRoot.isStable()) return null;
  const canonicalRoot = pinnedRoot.canonical_root;
  const path = join(constitutionDir(canonicalRoot, pinnedRoot), "gate.json");
  if (!constitutionStateAncestorsSafe(canonicalRoot, pinnedRoot) || !assertInsideRoot(canonicalRoot, path, pinnedRoot)) return null;
  if (!pathEntryExists(path, pinnedRoot)) {
    if (!pinnedRoot.isStable()) return null;
    return {
      schema_version: 1,
      gate_id: `constitution-gate-${sha8(sha256Hex(canonicalRoot))}`,
      project_root: canonicalRoot,
      feature_id: null,
      origin,
      gate: {
        gate_id: `constitution-gate-${sha8(sha256Hex(canonicalRoot))}`,
        origin_kind: origin.origin_kind,
        origin_run_key: origin.origin_run_key,
        origin_stage: origin.origin_stage,
        status: "checking",
        usability_result: null,
        provider: null,
        constitution_workflow_ref: null,
        checkpoint_ref: null,
        binding: null,
        resume_marker: null,
      },
      drafts: [],
      decisions: [],
      last_decision: null,
      last_feedback: null,
      resume: null,
      resume_marker_consumed: false,
    };
  }
  try {
    const relativePath = pinnedRoot.relativePath(path);
    if (relativePath === null) throw new PinnedRootError("path_unauthorized", "constitution gate path escapes the pinned project root");
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(pinnedRoot.readFile(relativePath, { maxBytes: MAX_GATE_BYTES }).bytes);
    const parsed: unknown = JSON.parse(serialized);
    return validatePersistedGateEnvelope(parsed, canonicalRoot) && pinnedRoot.isStable() ? parsed : null;
  } catch {
    return null;
  }
}
export type ConstitutionGateEnvelopeRead =
  | { ok: true; value: ConstitutionGateEnvelope | null }
  | { ok: false; error: string };

/** Read the canonical constitution gate through one borrowed pinned root. */
export function readConstitutionGateEnvelopePinned(pinnedRoot: PinnedProjectRoot): ConstitutionGateEnvelopeRead {
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before constitution gate read" };
  const relativePath = join(".work-state", "specification", "constitution", "gate.json");
  try {
    if (!pinnedRoot.pathEntryExists(relativePath)) return { ok: true, value: null };
    const envelope = loadEnvelope(pinnedRoot.canonical_root, {
      origin_kind: "native_direct",
      origin_run_key: "constitution-gate-read",
      origin_stage: "specify",
    }, pinnedRoot);
    if (!envelope) return { ok: false, error: "constitution gate is malformed or exceeds bounded limits" };
    if (envelope.project_root !== pinnedRoot.canonical_root) return { ok: false, error: "constitution gate project root does not match the pinned root" };
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed during constitution gate read" };
    return { ok: true, value: envelope };
  } catch (error) {
    return { ok: false, error: `constitution gate is unreadable: ${String(error)}` };
  }
}

interface DiskDocument {
  ok: true;
  document: string | null;
}
interface DiskFailure {
  ok: false;
  code: ConstitutionGateCode;
  error: string;
}

/** Bounded, descriptor-relative read of a project constitution document. */
function readDocument(root: string, relativePath: string, pinnedRoot: PinnedProjectRoot): DiskDocument | DiskFailure {
  if (!isSafeRelativePath(relativePath)) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `unsafe constitution path: ${relativePath}` };
  }
  const absolute = join(root, relativePath);
  if (!assertInsideRoot(root, absolute, pinnedRoot)) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `constitution path escapes the project root: ${relativePath}` };
  }
  if (!pathEntryExists(absolute, pinnedRoot)) return { ok: true, document: null };
  try {
    const entry = pinnedRoot.readFile(relativePath, { maxBytes: MAX_DOCUMENT_BYTES });
    const document = new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes);
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "constitution target changed while being read" };
    return { ok: true, document };
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "write_failed") {
      return { ok: false, code: "SPEC_INPUT_OVERSIZED", error: `constitution document exceeds ${MAX_DOCUMENT_BYTES} bytes: ${relativePath}` };
    }
    if (error instanceof PinnedRootError && error.code === "changed") {
      return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `constitution target changed while being read: ${relativePath}` };
    }
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `constitution target cannot be resolved safely: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function bindingFromDocument(selection: ConstitutionProviderSelection, document: string, validationRef: string): ConstitutionBinding {
  return {
    provider_id: selection.provider_id,
    path: selection.path,
    version: parseVersion(document),
    content_sha256: sha256Hex(document),
    semantic_hash: semanticHashOf(document),
    validation_ref: validationRef,
    bound_at: nowIso(),
  };
}

function canonicalFeatureInventory(
  root: string,
  featureId: string,
  runKey: string,
  pinnedRoot: PinnedProjectRoot,
): ApprovedArtifactImpactInput[] | null {
  const snapshot: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };
  const resolved = resolveFeatureWorkspace(root, { feature_id: featureId, run_key: runKey }, snapshot);
  if (!resolved.ok) return null;
  const seen = new Set<string>();
  const inventory: ApprovedArtifactImpactInput[] = [];
  for (const phase of resolved.value.phases) {
    const versions = new Set<number>();
    if (phase.current_version !== null) versions.add(phase.current_version);
    if (phase.approved_version !== null) versions.add(phase.approved_version);
    for (const version of versions) {
      const artifactId = `${phase.phase}.v${version}`;
      if (seen.has(artifactId)) continue;
      seen.add(artifactId);
      const artifact = readCanonicalPhaseArtifact(root, {
        feature_id: featureId,
        run_key: runKey,
        phase: phase.phase,
        version,
      }, pinnedRoot);
      if (!artifact) return null;
      inventory.push({
        artifact_id: artifact.artifact_id,
        semantic_section_hashes: { ...artifact.semantic_section_hashes },
        depends_on: artifact.upstream_versions.map((entry) => entry.artifact_id),
      });
    }
  }
  return inventory;
}

function assessmentProvesNoImpact(
  root: string,
  assessment: ConstitutionImpactResult | undefined,
  previous: ConstitutionBinding,
  current: ConstitutionBinding,
  featureId: string | undefined,
  runKey: string,
  pinnedRoot: PinnedProjectRoot,
): boolean {
  if (!assessment) return false;
  const persisted = loadConstitutionImpactEvidence(root, assessment, previous, current, pinnedRoot);
  if (!persisted || !persisted.artifact_results.every((row) => row.verdict === "no_impact")) return false;
  if (featureId === undefined) return true;
  if (persisted.feature_id !== featureId || persisted.run_key !== runKey
    || persisted.inventory_digest !== digestOf(persisted.approved_artifacts)) return false;
  const inventory = canonicalFeatureInventory(root, featureId, runKey, pinnedRoot);
  return inventory !== null
    && canonicalJson(persisted.approved_artifacts) === canonicalJson(inventory)
    && persisted.inventory_digest === digestOf(inventory);
}

interface ConstitutionSourcePreimageAbsent {
  kind: "absent";
  path: string;
}
interface ConstitutionSourcePreimageFile {
  kind: "file";
  path: string;
  dev: number;
  ino: number;
  sha256: string;
}
type ConstitutionSourcePreimage = ConstitutionSourcePreimageAbsent | ConstitutionSourcePreimageFile;
type ConstitutionGateEnvelopeWithPreimage = ConstitutionGateEnvelope & { source_preimage?: ConstitutionSourcePreimage };
interface ConstitutionSourceWriteWal {
  schema_version: 1;
  path: string;
  preimage: ConstitutionSourcePreimage;
  preimage_document: string | null;
  desired_document: string;
  desired_sha256: string;
  source_descriptor: PinnedRootFileExpectation;
  gate_id: string;
  checkpoint_id: string;
}
interface ConstitutionMaterializedSource {
  document: string;
  source_receipt: PinnedRootWriteReceipt;
  wal_receipt: PinnedRootWriteReceipt;
}

type ConstitutionSourcePreimageResult =
  | { ok: true; value: ConstitutionSourcePreimage }
  | { ok: false; code: "SPEC_PATH_UNAUTHORIZED" | "SPEC_STATE_INVALID"; error: string };

function sourcePreimageOf(envelope: ConstitutionGateEnvelope): ConstitutionSourcePreimage | undefined {
  const value = (envelope as ConstitutionGateEnvelopeWithPreimage).source_preimage;
  return value;
}

function setSourcePreimage(envelope: ConstitutionGateEnvelope, value: ConstitutionSourcePreimage): void {
  (envelope as ConstitutionGateEnvelopeWithPreimage).source_preimage = value;
}

function clearSourcePreimage(envelope: ConstitutionGateEnvelope): void {
  delete (envelope as ConstitutionGateEnvelopeWithPreimage).source_preimage;
}

/** Capture the exact unusable source selected by the gate classification. */
function captureConstitutionSourcePreimage(
  relativePath: string,
  document: string | null,
  pinnedRoot: PinnedProjectRoot,
): ConstitutionSourcePreimageResult {
  if (!isSafeRelativePath(relativePath)) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `unsafe constitution path: ${relativePath}` };
  }
  try {
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while capturing constitution source preimage" };
    if (document === null) {
      const info = pinnedRoot.pathEntryInfo(relativePath);
      if (info !== null) return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution source appeared while capturing its absent preimage" };
      if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while capturing constitution source preimage" };
      return { ok: true, value: { kind: "absent", path: relativePath } };
    }
    const read = pinnedRoot.readFile(relativePath, { maxBytes: MAX_DOCUMENT_BYTES });
    const exact = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    if (exact !== document) return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution source changed while capturing its preimage" };
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while capturing constitution source preimage" };
    return { ok: true, value: { kind: "file", path: relativePath, dev: read.dev, ino: read.ino, sha256: sha256Hex(exact) } };
  } catch (error) {
    if (error instanceof PinnedRootError && (error.code === "path_unauthorized" || error.code === "changed")) {
      return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `constitution source changed while capturing its preimage: ${error.message}` };
    }
    return { ok: false, code: "SPEC_STATE_INVALID", error: `constitution source preimage could not be captured: ${error instanceof Error ? error.message : String(error)}` };
  }
}

type ConstitutionMaterializationResult =
  | { ok: true; document: string; source_receipt: PinnedRootWriteReceipt; wal_receipt: PinnedRootWriteReceipt }
  | { ok: false; code: "SPEC_PATH_UNAUTHORIZED" | "SPEC_STATE_INVALID"; error: string };

function sourceWriteWalBytes(wal: ConstitutionSourceWriteWal): Buffer {
  return Buffer.from(JSON.stringify(wal, null, 2) + "\n", "utf8");
}

function validSourceWriteWal(value: unknown): value is ConstitutionSourceWriteWal {
  if (!isRecord(value)
    || value.schema_version !== 1
    || typeof value.path !== "string"
    || !isSafeRelativePath(value.path)
    || (typeof value.preimage_document !== "string" && value.preimage_document !== null)
    || typeof value.desired_document !== "string"
    || Buffer.byteLength(value.desired_document, "utf8") > MAX_DOCUMENT_BYTES
    || !isSha256Hex(String(value.desired_sha256))
    || !isRecord(value.preimage)
    || !validPersistedSourcePreimage(value.preimage)
    || (value.preimage_document !== null && sha256Hex(value.preimage_document) !== value.preimage.sha256)
    || (value.preimage_document === null && value.preimage.kind !== "absent")
    || (value.preimage_document !== null && value.preimage.kind !== "file")
    || value.preimage.path !== value.path
    || sha256Hex(value.desired_document) !== value.desired_sha256
    || typeof value.gate_id !== "string"
    || typeof value.checkpoint_id !== "string") return false;
  if (!isRecord(value.source_descriptor)
    || !Number.isSafeInteger(value.source_descriptor.dev)
    || !Number.isSafeInteger(value.source_descriptor.ino)
    || !isSha256Hex(String(value.source_descriptor.sha256))) return false;
  return true;
}

function readSourceWriteWal(pinnedRoot: PinnedProjectRoot): { present: false } | { present: true; value: ConstitutionSourceWriteWal | null; descriptor: PinnedRootFileExpectation } {
  try {
    if (!pinnedRoot.pathEntryExists(CONSTITUTION_SOURCE_WRITE_WAL)) return { present: false };
    const observed = pinnedRoot.readFile(CONSTITUTION_SOURCE_WRITE_WAL, { maxBytes: MAX_DOCUMENT_BYTES * 3 });
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes)); } catch { parsed = null; }
    return {
      present: true,
      value: validSourceWriteWal(parsed) ? parsed : null,
      descriptor: { dev: observed.dev, ino: observed.ino, sha256: sha256Hex(Buffer.from(observed.bytes).toString("utf8")) },
    };
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return { present: false };
    return { present: true, value: null, descriptor: { dev: -1, ino: -1, sha256: "" } };
  }
}

function retireSourceWriteWal(pinnedRoot: PinnedProjectRoot, descriptor: PinnedRootFileExpectation): boolean {
  try { pinnedRoot.removeFileIfMatches(CONSTITUTION_SOURCE_WRITE_WAL, descriptor); return true; } catch { return false; }
}

function recoverSourceWriteWal(root: string, envelope: ConstitutionGateEnvelope, pinnedRoot: PinnedProjectRoot): ConstitutionGateOutcome<null> {
  const walRead = readSourceWriteWal(pinnedRoot);
  if (!walRead.present) return { ok: true, value: null };
  const wal = walRead.value;
  if (!wal || walRead.descriptor.dev < 0 || wal.gate_id !== envelope.gate_id) {
    return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "constitution source write WAL is malformed or belongs to another gate" };
  }
  const sourceMatchesPreimage = (): boolean => {
    try {
      const current = pinnedRoot.pathEntryInfo(wal.path);
      if (wal.preimage.kind === "absent") return current === null;
      if (current === null || current.kind !== "file"
        || current.dev !== wal.preimage.dev || current.ino !== wal.preimage.ino) return false;
      const read = pinnedRoot.readFile(wal.path, { maxBytes: MAX_DOCUMENT_BYTES });
      return read.dev === wal.preimage.dev
        && read.ino === wal.preimage.ino
        && sha256Hex(Buffer.from(read.bytes).toString("utf8")) === wal.preimage.sha256;
    } catch {
      return false;
    }
  };
  const sourceMatchesOwnedPostimage = (): boolean => {
    try {
      const current = pinnedRoot.readFile(wal.path, { maxBytes: MAX_DOCUMENT_BYTES });
      return current.dev === wal.source_descriptor.dev
        && current.ino === wal.source_descriptor.ino
        && sha256Hex(Buffer.from(current.bytes).toString("utf8")) === wal.source_descriptor.sha256;
    } catch {
      return false;
    }
  };
  // The WAL is written from the source receipt before source publication. If
  // publication did not happen, retire the WAL and let the durable answer
  // replay the correction from its exact preimage.
  if (sourceMatchesPreimage()) {
    if (!retireSourceWriteWal(pinnedRoot, walRead.descriptor)) return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "constitution source write WAL changed before preimage recovery could retire it" };
    return { ok: true, value: null };
  }
  if (envelope.gate.status === "approved" && envelope.gate.binding
    && envelope.gate.binding.path === wal.path && envelope.gate.binding.content_sha256 === wal.desired_sha256) {
    if (!sourceMatchesOwnedPostimage()) return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "approved constitution source no longer matches the source write WAL" };
    if (!retireSourceWriteWal(pinnedRoot, walRead.descriptor)) return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "constitution source write WAL changed before approved recovery could retire it" };
    return { ok: true, value: null };
  }
  if (envelope.gate.status !== "awaiting_approval") return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "constitution source write WAL has no recoverable gate state" };
  const descriptor = wal.source_descriptor;
  try {
    const current = pinnedRoot.readFile(wal.path, { maxBytes: MAX_DOCUMENT_BYTES });
    const currentDescriptor = { dev: current.dev, ino: current.ino, sha256: sha256Hex(Buffer.from(current.bytes).toString("utf8")) };
    if (currentDescriptor.dev !== descriptor.dev || currentDescriptor.ino !== descriptor.ino || currentDescriptor.sha256 !== descriptor.sha256) return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "constitution source write WAL source was concurrently replaced" };
    if (wal.preimage.kind === "absent") pinnedRoot.removeFileIfMatches(wal.path, descriptor);
    else if (wal.preimage_document !== null) pinnedRoot.replaceFileIfMatches(wal.path, descriptor, Buffer.from(wal.preimage_document, "utf8"));
    else return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "constitution source write WAL preimage bytes are missing" };
    if (!retireSourceWriteWal(pinnedRoot, walRead.descriptor)) return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "constitution source write WAL changed during rollback" };
    return { ok: true, value: null };
  } catch (error) {
    return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: `constitution source write WAL rollback failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Materialize an approved correction only against the exact unusable source
 * observed by the gate. Native/default paths may be created or replaced;
 * discovered provider files remain read-only by policy.
 */
function materializeApprovedConstitution(
  root: string,
  provider: ConstitutionProviderSelection | null,
  document: string,
  preimage: ConstitutionSourcePreimage | undefined,
  pinnedRoot: PinnedProjectRoot,
  gateId = "constitution-gate",
  checkpointId = "constitution-correction",
): ConstitutionMaterializationResult {
  if (!provider) return { ok: false, code: "SPEC_STATE_INVALID", error: "approved constitution has no selected provider" };
  if (provider.source !== "native_default" && provider.source !== "explicit_override") {
    return { ok: false, code: "SPEC_STATE_INVALID", error: "discovered constitution providers are read-only and cannot accept generated corrections" };
  }
  if (!isSafeRelativePath(provider.path)) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `unsafe constitution path: ${provider.path}` };
  if (!preimage || preimage.path !== provider.path) return { ok: false, code: "SPEC_STATE_INVALID", error: "approved constitution correction is missing its exact selected-source preimage" };
  if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before constitution correction" };
  let sourceReceipt: PinnedRootWriteReceipt | undefined;
  let walReceipt: PinnedRootWriteReceipt | undefined;
  try {
    const info = pinnedRoot.pathEntryInfo(provider.path);
    let preimageDocument: string | null = null;
    if (preimage.kind === "absent") {
      if (info !== null) return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution source appeared after the absent preimage was captured" };
    } else {
      if (!info || info.kind !== "file" || info.dev !== preimage.dev || info.ino !== preimage.ino) return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution source identity changed since gate classification" };
      const current = pinnedRoot.readFile(provider.path, { maxBytes: MAX_DOCUMENT_BYTES });
      preimageDocument = new TextDecoder("utf-8", { fatal: true }).decode(current.bytes);
      const expected = { dev: preimage.dev, ino: preimage.ino, sha256: preimage.sha256 };
      if (current.dev !== expected.dev || current.ino !== expected.ino || sha256Hex(preimageDocument) !== expected.sha256) return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution source bytes changed since gate classification" };
    }
    const walBase = {
      schema_version: 1 as const,
      path: provider.path,
      preimage,
      preimage_document: preimageDocument,
      desired_document: document,
      desired_sha256: sha256Hex(document),
      gate_id: gateId,
      checkpoint_id: checkpointId,
    };
    pinnedRoot.ensureDirectory(CONSTITUTION_DIR_RELATIVE);
    const publishWalDescriptor = (receipt: PinnedRootWriteReceipt): void => {
      if (walReceipt) throw new Error("constitution source write WAL was published more than once");
      const durableWal: ConstitutionSourceWriteWal = { ...walBase, source_descriptor: receipt.descriptor };
      // This callback runs before the source name is made visible. The
      // exclusive WAL write therefore either precedes source publication or
      // aborts it without exposing a source postimage without a receipt.
      walReceipt = pinnedRoot.writeExclusiveWithReceipt(CONSTITUTION_SOURCE_WRITE_WAL, sourceWriteWalBytes(durableWal));
    };
    if (preimage.kind === "absent") {
      const parent = dirname(provider.path);
      if (parent && parent !== ".") pinnedRoot.ensureDirectory(parent);
      if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before creating constitution correction" };
      sourceReceipt = pinnedRoot.writeExclusiveWithReceipt(provider.path, document, { beforePublish: publishWalDescriptor });
    } else {
      const expected = { dev: preimage.dev, ino: preimage.ino, sha256: preimage.sha256 };
      sourceReceipt = pinnedRoot.replaceFileIfMatchesWithReceipt(provider.path, expected, document, { beforePublish: publishWalDescriptor });
    }
    if (!sourceReceipt || sourceReceipt.descriptor.sha256 !== sha256Hex(document)) throw new Error("constitution correction receipt does not match approved bytes");
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed after constitution correction" };
    return { ok: true, document, source_receipt: sourceReceipt, wal_receipt: walReceipt! };
  } catch (error) {
    if (sourceReceipt) rollbackPinnedRootWriteReceipt(pinnedRoot, sourceReceipt);
    if (walReceipt) rollbackPinnedRootWriteReceipt(pinnedRoot, walReceipt);
    if (error instanceof PinnedRootError && (error.code === "path_unauthorized" || error.code === "changed")) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `constitution correction path changed: ${error.message}` };
    if (error instanceof PinnedRootError && (error.code === "not_found" || error.code === "exists")) return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution correction target changed during durable publication" };
    return { ok: false, code: "SPEC_STATE_INVALID", error: `constitution correction could not be committed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Normative resume target: imports revalidate compatibility; every native origin enters Specify. */
function resumeTargetFor(gate: ConstitutionGateRecord): ConstitutionResumeTarget {
  return gate.origin_kind === "external_import" ? "compatibility_validation" : "specify";
}

function sameActor(left: CheckpointActor, right: CheckpointActor): boolean {
  const leftProof = left.proof;
  const rightProof = right.proof;
  return left.kind === right.kind
    && left.ref === right.ref
    && Boolean(leftProof) === Boolean(rightProof)
    && (!leftProof || !rightProof || (
      leftProof.answer_id === rightProof.answer_id
      && leftProof.nonce === rightProof.nonce
      && leftProof.channel === rightProof.channel
      && leftProof.reference === rightProof.reference
      && leftProof.binding === rightProof.binding
      && leftProof.feedback === rightProof.feedback
    ));
}



function latestDraft(envelope: ConstitutionGateEnvelope): ConstitutionDraftRecord | null {
  return envelope.drafts.length > 0 ? envelope.drafts[envelope.drafts.length - 1]! : null;
}

function isConstitutionGateCode(code: string): code is ConstitutionGateCode {
  switch (code) {
    case "SPEC_PATH_UNAUTHORIZED":
    case "SPEC_CONSTITUTION_SOURCE_AMBIGUOUS":
    case "SPEC_CONSTITUTION_DISCOVERY_FAILED":
    case "SPEC_INPUT_OVERSIZED":
    case "SPEC_GATE_UNKNOWN":
    case "SPEC_CHECKPOINT_UNKNOWN":
    case "SPEC_DECISION_INVALID":
    case "SPEC_PROOF_INVALID":
    case "SPEC_FEEDBACK_REQUIRED":
    case "SPEC_DRAFT_INVALID":
    case "SPEC_STATE_INVALID":
    case "SPEC_CONSTITUTION_IMPACT_PENDING":
      return true;
    default:
      return false;
  }
}

type FeatureWorkspaceBindingRead =
  | { kind: "absent" }
  | { kind: "valid"; binding: ConstitutionBinding }
  | { kind: "malformed"; error: string };

function featureWorkspaceBinding(
  featureId: string | undefined,
  pinnedRoot: PinnedProjectRoot,
): FeatureWorkspaceBindingRead {
  if (!featureId || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(featureId)) return { kind: "absent" };
  const path = join(".work-state", "features", featureId, "state.json");
  let parsed: unknown;
  try {
    const source = pinnedRoot.readFile(path, { maxBytes: MAX_FEATURE_STATE_BYTES });
    if (!pinnedRoot.isStable()) return { kind: "malformed", error: "feature workspace state changed while being read" };
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
    const candidate = JSON.parse(raw) as unknown;
    parsed = parseBoundedPersistedState(candidate);
    if (!parsed) return { kind: "malformed", error: "feature workspace state exceeds bounded structural limits or has an unsafe object shape" };
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return { kind: "absent" };
    return { kind: "malformed", error: "feature workspace state is present but unreadable" };
  }
  if (!isRecord(parsed)) return { kind: "malformed", error: "feature workspace state envelope is malformed" };
  if (!Object.prototype.hasOwnProperty.call(parsed, "specification") || parsed.specification === null) {
    return { kind: "absent" };
  }
  if (!isRecord(parsed.specification)) {
    return { kind: "malformed", error: "feature workspace specification aggregate is malformed" };
  }
  const workspace = parsed.specification;
  const validWorkspace = validateFeatureWorkspaceRecord(workspace);
  if (!validWorkspace.ok || workspace.feature_id !== featureId) {
    return { kind: "malformed", error: "feature workspace specification aggregate is invalid" };
  }
  if (workspace.constitution_binding === null || workspace.constitution_binding === undefined) {
    return { kind: "absent" };
  }
  if (validateConstitutionBinding(workspace.constitution_binding).length > 0) {
    return { kind: "malformed", error: "feature workspace constitution binding is malformed" };
  }
  return { kind: "valid", binding: workspace.constitution_binding as ConstitutionBinding };
}

function pendingConstitutionImpactTransaction(
  featureId: string | undefined,
  pinnedRoot: PinnedProjectRoot,
): { pending: boolean; malformed: boolean } {
  const directory = join(".work-state", "specification", "constitution");
  let entries: string[];
  try {
    entries = pinnedRoot.listDirectory(directory, { maxEntries: 256, maxNameBytes: 8192 });
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return { pending: false, malformed: false };
    return { pending: false, malformed: true };
  }
  for (const entry of entries) {
    if (!/^constitution-impact-transaction-[a-f0-9]{64}\.json$/u.test(entry)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        pinnedRoot.readFile(join(directory, entry), { maxBytes: 256 * 1024 }).bytes,
      ));
    } catch {
      return { pending: false, malformed: true };
    }
    if (!isRecord(parsed) || !isRecord(parsed.application)
      || typeof parsed.application.feature_id !== "string") return { pending: false, malformed: true };
    if (featureId !== undefined && parsed.application.feature_id !== featureId) continue;
    return { pending: true, malformed: false };
  }
  return { pending: false, malformed: false };
}

/**
 * Idempotent shared constitution prerequisite. Returns the established gate
 * record: `usable` with an exact binding when a current constitution is
 * bound (persisted approval remains authoritative when the canonical file is
 * absent), `constitution_required` while the bootstrap blocks the exact
 * origin, `awaiting_approval` while a draft checkpoint is open, and
 * `blocked` when the disk content drifted from the approved binding and no
 * current impact assessment has re-established safety.
 */
function ensureProjectConstitutionUnlocked(
  projectRoot: string,
  origin: ConstitutionOriginDescriptor,
  options: { feature_id?: string; explicit_path?: string | null; impact_assessment?: ConstitutionImpactResult; pinnedRoot?: PinnedProjectRoot } = {},
): ConstitutionGateOutcome<ConstitutionGateRecord> {
  const ownsPinnedRoot = options.pinnedRoot === undefined;
  const pinnedRoot = options.pinnedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `project root is not a readable directory: ${projectRoot}` };
  }
  const root = pinnedRoot.canonical_root;
  try {
    if (!validOrigin(origin)) {
    return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution origin descriptor is incomplete or invalid" };
  }
  const selection = resolveConstitutionProvider(root, { ...options, pinnedRoot });
  if (!selection.ok) {
    return { ok: false, code: selection.code, error: selection.error };
  }
  const envelope = loadEnvelope(root, origin, pinnedRoot);
  if (!envelope) {
    return { ok: false, code: "SPEC_STATE_INVALID", error: "persisted constitution gate state is corrupt; refusing to reset approved state" };
  }
  if (!persistedGateStatusConsistent(envelope)
    || envelope.origin.origin_kind !== envelope.gate.origin_kind
    || envelope.origin.origin_run_key !== envelope.gate.origin_run_key
    || envelope.origin.origin_stage !== envelope.gate.origin_stage) {
    return { ok: false, code: "SPEC_STATE_INVALID", error: "persisted constitution gate provenance or status is inconsistent" };
  }
  const sourceRecovery = recoverSourceWriteWal(root, envelope, pinnedRoot);
  if (!sourceRecovery.ok) return sourceRecovery;
  const gate = envelope.gate;
  if (gate.provider !== null && !persistedProviderMatchesSelection(gate.provider, selection.value)) {
    const discoveredSourceDisappeared = gate.provider.source === "discovered_provider"
      && pinnedRoot.pathEntryInfo(gate.provider.path) === null;
    if (!discoveredSourceDisappeared) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: "persisted constitution gate provider does not match the selected source" };
    }
    const fallbackDisk = readDocument(root, selection.value.path, pinnedRoot);
    if (!fallbackDisk.ok) return fallbackDisk;
    const fallbackPreimage = captureConstitutionSourcePreimage(selection.value.path, fallbackDisk.document, pinnedRoot);
    if (!fallbackPreimage.ok) return fallbackPreimage;
    const cleared = clearStaleOriginWorkspaceConstitution(root, options.feature_id, origin.origin_run_key, gate.gate_id, gate.binding, pinnedRoot);
    if (!cleared.ok) return cleared;
    gate.provider = selection.value;
    gate.binding = null;
    gate.status = "constitution_required";
    gate.usability_result = "missing";
    gate.checkpoint_ref = null;
    gate.resume_marker = null;
    envelope.resume = null;
    envelope.resume_marker_consumed = false;
    setSourcePreimage(envelope, fallbackPreimage.value);
    envelope.origin = origin;
    gate.origin_kind = origin.origin_kind;
    gate.origin_run_key = origin.origin_run_key;
    gate.origin_stage = origin.origin_stage;
    persistEnvelope(root, envelope, pinnedRoot);
    return { ok: true, value: { ...gate } };
  }
  const pendingTransaction = pendingConstitutionImpactTransaction(options.feature_id, pinnedRoot);
  if (pendingTransaction.malformed) {
    return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution impact transaction is corrupt or unreadable" };
  }
  if (pendingTransaction.pending) {
    return {
      ok: true,
      value: {
        ...gate,
        status: "blocked",
        usability_result: "structurally_invalid",
        checkpoint_ref: null,
      },
    };
  }

  const sameOrigin = gate.origin_kind === origin.origin_kind
    && gate.origin_run_key === origin.origin_run_key
    && gate.origin_stage === origin.origin_stage;
  if (!gate.binding && gate.status !== "checking" && !sameOrigin) {
    return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution bootstrap is already owned by another unresolved origin" };
  }
  if (!gate.binding && gate.status === "constitution_required") {
    return { ok: true, value: { ...gate } };
  }

  if (gate.binding) {
    const featureWorkspace = featureWorkspaceBinding(options.feature_id, pinnedRoot);
    if (featureWorkspace.kind === "malformed") {
      return { ok: false, code: "SPEC_STATE_INVALID", error: featureWorkspace.error };
    }
    const disk = readDocument(root, gate.binding.path, pinnedRoot);
    if (!disk.ok) return disk;
    const correctionAllowed = gate.provider?.source === "native_default" || gate.provider?.source === "explicit_override";
    if (disk.document === null) {
      if (!correctionAllowed) {
        gate.status = "blocked";
        gate.usability_result = "missing";
        gate.checkpoint_ref = null;
      } else {
        const sourcePreimage = captureConstitutionSourcePreimage(gate.binding.path, null, pinnedRoot);
        if (!sourcePreimage.ok) return sourcePreimage;
        const staleBinding = gate.binding;
        const cleared = clearStaleOriginWorkspaceConstitution(root, options.feature_id, origin.origin_run_key, gate.gate_id, staleBinding, pinnedRoot);
        if (!cleared.ok) return cleared;
        gate.status = "constitution_required";
        gate.usability_result = "missing";
        gate.binding = null;
        gate.checkpoint_ref = null;
        setSourcePreimage(envelope, sourcePreimage.value);
      }
      envelope.origin = origin;
      gate.origin_kind = origin.origin_kind;
      gate.origin_run_key = origin.origin_run_key;
      gate.origin_stage = origin.origin_stage;
      persistEnvelope(root, envelope, pinnedRoot);
      return { ok: true, value: { ...gate } };
    }
    {
      const diskSha = sha256Hex(disk.document);
      const diskUsability = evaluateConstitutionUsability(disk.document);
      if (diskUsability.status !== "usable") {
        if (!correctionAllowed) {
          gate.status = "blocked";
          gate.usability_result = diskUsability.detail;
          gate.checkpoint_ref = null;
        } else {
          const sourcePreimage = captureConstitutionSourcePreimage(gate.binding.path, disk.document, pinnedRoot);
          if (!sourcePreimage.ok) return sourcePreimage;
          const staleBinding = gate.binding;
          const cleared = clearStaleOriginWorkspaceConstitution(root, options.feature_id, origin.origin_run_key, gate.gate_id, staleBinding, pinnedRoot);
          if (!cleared.ok) return cleared;
          gate.status = "constitution_required";
          gate.usability_result = diskUsability.detail;
          gate.binding = null;
          gate.checkpoint_ref = null;
          setSourcePreimage(envelope, sourcePreimage.value);
        }
        envelope.origin = origin;
        gate.origin_kind = origin.origin_kind;
        gate.origin_run_key = origin.origin_run_key;
        gate.origin_stage = origin.origin_stage;
        persistEnvelope(root, envelope, pinnedRoot);
        return { ok: true, value: { ...gate } };
      }
      const validationRef = usabilityEvidenceRef(diskSha);
      const expectedBinding = bindingFromDocument(selection.value, disk.document, validationRef);
      const bindingMatchesCanonicalBytes = sameConstitutionBinding(gate.binding, expectedBinding);
      if ((gate.status === "usable" || gate.status === "approved")
        && bindingMatchesCanonicalBytes
        && (diskSha !== gate.binding.content_sha256
          || gate.binding.validation_ref !== validationRef
          || !loadUsabilityEvidence(root, validationRef, diskSha, pinnedRoot))) {
        return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution gate binding lacks matching canonical usability evidence" };
      }
    }
    if (disk.document !== null && sha256Hex(disk.document) !== gate.binding.content_sha256) {
      const usability = evaluateConstitutionUsability(disk.document);
      let current: ConstitutionBinding | null = null;
      if (usability.status === "usable") {
        try {
          const validationRef = persistUsabilityEvidence(root, sha256Hex(disk.document), pinnedRoot);
          current = bindingFromDocument(gate.provider ?? selection.value, disk.document, validationRef);
        } catch {
          current = null;
        }
      }
      const workspaceMatchesCurrent = current
        && (featureWorkspace.kind !== "valid" || sameConstitutionBinding(featureWorkspace.binding, current));
      if (current && workspaceMatchesCurrent && assessmentProvesNoImpact(root, options.impact_assessment, gate.binding, current, options.feature_id, origin.origin_run_key, pinnedRoot)) {
        gate.binding = current;
        gate.status = "usable";
        gate.usability_result = "usable";
      } else {
        gate.status = "blocked";
      }
      gate.checkpoint_ref = null;
      envelope.origin = origin;
      gate.origin_kind = origin.origin_kind;
      gate.origin_run_key = origin.origin_run_key;
      gate.origin_stage = origin.origin_stage;
      persistEnvelope(root, envelope, pinnedRoot);
      return { ok: true, value: { ...gate } };
    }
    if (featureWorkspace.kind === "valid" && !sameConstitutionBinding(featureWorkspace.binding, gate.binding)) {
      // A valid workspace bound to different constitution bytes is a
      // deterministic structural mismatch, not a usable gate. Persist the
      // block before returning so restart/process boundaries cannot resurrect
      // the previously approved gate from stale disk state.
      gate.status = "blocked";
      gate.usability_result = "structurally_invalid";
      gate.checkpoint_ref = null;
      gate.resume_marker = null;
      envelope.resume = null;
      envelope.resume_marker_consumed = false;
      envelope.origin = origin;
      gate.origin_kind = origin.origin_kind;
      gate.origin_run_key = origin.origin_run_key;
      gate.origin_stage = origin.origin_stage;
      persistEnvelope(root, envelope, pinnedRoot);
      return { ok: true, value: { ...gate } };
    }
    gate.status = "usable";
    gate.usability_result = "usable";
    gate.checkpoint_ref = null;
    gate.provider = gate.provider ?? selection.value;
    envelope.origin = origin;
    gate.origin_kind = origin.origin_kind;
    gate.origin_run_key = origin.origin_run_key;
    gate.origin_stage = origin.origin_stage;
    persistEnvelope(root, envelope, pinnedRoot);
    return { ok: true, value: { ...gate } };
  }

  if (gate.status === "awaiting_approval" && gate.checkpoint_ref) {
    // Established open checkpoint: replay, never a second bootstrap.
    return { ok: true, value: { ...gate } };
  }

  const disk = readDocument(root, selection.value.path, pinnedRoot);
  if (!disk.ok) return disk;
  const usability = evaluateConstitutionUsability(disk.document);
  envelope.origin = origin;
  gate.origin_kind = origin.origin_kind;
  gate.origin_run_key = origin.origin_run_key;
  gate.origin_stage = origin.origin_stage;
  gate.provider = selection.value;
  if (usability.status === "usable") {
    const document = disk.document!;
    const documentSha = sha256Hex(document);
    let validationRef: string;
    try {
      validationRef = persistUsabilityEvidence(root, documentSha, pinnedRoot);
    } catch (error) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: `constitution validation evidence could not be persisted: ${error instanceof Error ? error.message : String(error)}` };
    }
    gate.status = "usable";
    gate.usability_result = "usable";
    gate.binding = bindingFromDocument(selection.value, document, validationRef);
    gate.checkpoint_ref = null;
    clearSourcePreimage(envelope);
  } else {
    const sourcePreimage = captureConstitutionSourcePreimage(selection.value.path, disk.document, pinnedRoot);
    if (!sourcePreimage.ok) return sourcePreimage;
    gate.status = "constitution_required";
    gate.usability_result = usability.detail;
    gate.checkpoint_ref = null;
    setSourcePreimage(envelope, sourcePreimage.value);
  }
  persistEnvelope(root, envelope, pinnedRoot);
  if (options.feature_id && gate.binding) {
    const workspaceBinding = featureWorkspaceBinding(options.feature_id, pinnedRoot);
    if (workspaceBinding.kind === "malformed") return { ok: false, code: "SPEC_STATE_INVALID", error: workspaceBinding.error };
    if (workspaceBinding.kind === "absent") {
      const originBinding = bindApprovedOriginWorkspace(root, {
      gate_id: gate.gate_id,
      feature_id: options.feature_id,
      run_key: origin.origin_run_key,
      checkpoint_id: gate.checkpoint_ref ?? `${gate.gate_id}.usable`,
      decision: "approve_continue",
      authorization: "policy_auto",
      actor_provenance: { kind: "system", ref: "ensure_project_constitution", proof: undefined },
    }, gate, gate.binding, pinnedRoot);
      if (!originBinding.ok) return originBinding;
    }
  }
  return { ok: true, value: { ...gate } };
  } catch (error) {
    if (error instanceof ConstitutionGatePersistenceError) {
      return { ok: false, code: error.code, error: error.message };
    }
    throw error;
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}

export function ensureProjectConstitution(
  projectRoot: string,
  origin: ConstitutionOriginDescriptor,
  options: { feature_id?: string; explicit_path?: string | null; impact_assessment?: ConstitutionImpactResult; pinnedRoot?: PinnedProjectRoot } = {},
): ConstitutionGateOutcome<ConstitutionGateRecord> {
  const ownsPinnedRoot = options.pinnedRoot === undefined;
  const pinnedRoot = options.pinnedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `project root is not a readable directory: ${projectRoot}` };
  try {
    return withCtoRunLock(
      pinnedRoot.canonical_root,
      "__constitution__",
      () => ensureProjectConstitutionUnlocked(pinnedRoot.canonical_root, origin, { ...options, pinnedRoot }),
      { pinnedRoot },
    );
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}
/**
 * Read the canonical project constitution gate for an impact transition.
 * This is intentionally read-only: callers must use the impact assessment
 * service before they can advance a blocked binding.
 */
export function readProjectConstitutionGate(
  projectRoot: string,
  providedRoot?: PinnedProjectRoot,
): ConstitutionGateOutcome<ConstitutionGateRecord> {
  const ownsPinnedRoot = providedRoot === undefined;
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `project root is not a readable directory: ${projectRoot}` };
  }
  try {
    const root = pinnedRoot.canonical_root;
    const envelope = loadEnvelope(root, {
      origin_kind: "native_direct",
      origin_run_key: "constitution-impact",
      origin_stage: "specify",
    }, pinnedRoot);
    if (!envelope) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: "persisted constitution gate state is corrupt" };
    }
    return { ok: true, value: { ...envelope.gate } };
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}

/**
 * Resolve and validate the exact current constitution binding without
 * changing the gate. Impact assessment uses this seam to obtain the fresh
 * fingerprint while keeping approval and invalidation as a separate commit.
 */
export function resolveCurrentConstitutionBinding(
  projectRoot: string,
  options: { explicit_path?: string | null; pinnedRoot?: PinnedProjectRoot } = {},
): ConstitutionGateOutcome<ConstitutionBinding> {
  const ownsPinnedRoot = options.pinnedRoot === undefined;
  const pinnedRoot = options.pinnedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `project root is not a readable directory: ${projectRoot}` };
  }
  try {
    const root = pinnedRoot.canonical_root;
    const selection = resolveConstitutionProvider(root, { explicit_path: options.explicit_path, pinnedRoot });
    if (!selection.ok) return { ok: false, code: selection.code, error: selection.error };
    const document = readDocument(root, selection.value.path, pinnedRoot);
    if (!document.ok) return document;
    if (document.document === null) {
      return { ok: false, code: "SPEC_DRAFT_INVALID", error: "constitution source disappeared while resolving its binding" };
    }
    const usability = evaluateConstitutionUsability(document.document);
    if (usability.status !== "usable") {
      return { ok: false, code: "SPEC_DRAFT_INVALID", error: `constitution source is not usable: ${usability.detail}` };
    }
    const validationRef = persistUsabilityEvidence(root, sha256Hex(document.document), pinnedRoot);
    return {
      ok: true,
      value: bindingFromDocument(selection.value, document.document, validationRef),
    };
  } catch (error) {
    return { ok: false, code: "SPEC_STATE_INVALID", error: `constitution binding resolution failed: ${String(error)}` };
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}

/**
 * Read-only authority check for a constitution-bound workspace write. The
 * prerequisite gate is the decision ledger; the workspace binding alone is
 * never sufficient after the gate has been approved.
 */
export function currentConstitutionPersistenceIssue(
  root: string,
  expectedBinding: ConstitutionBinding,
  expectedGateId: string,
  pinnedRoot: PinnedProjectRoot,
): string | null {
  if (!pinnedRoot.isStable()) return "project root changed before constitution persistence";
  const gate = readProjectConstitutionGate(root, pinnedRoot);
  if (!gate.ok) return `current constitution gate is unavailable: ${gate.error}`;
  if (
    gate.value.gate_id !== expectedGateId
    || (gate.value.status !== "usable" && gate.value.status !== "approved")
    || gate.value.usability_result !== "usable"
    || gate.value.checkpoint_ref !== null
    || !gate.value.binding
    || canonicalJson(gate.value.binding) !== canonicalJson(expectedBinding)
  ) return "current constitution gate no longer matches the expected approved binding";
  const freshness = readPinnedCurrentConstitution(root, pinnedRoot, expectedBinding);
  if (!freshness.ok) return `current constitution source is stale: ${freshness.error}`;
  if (!pinnedRoot.isStable()) return "project root changed after constitution persistence check";
  return null;
}

function sameConstitutionBinding(left: ConstitutionBinding, right: ConstitutionBinding): boolean {
  return left.provider_id === right.provider_id
    && left.path === right.path
    && left.version === right.version
    && left.content_sha256 === right.content_sha256
    && left.semantic_hash === right.semantic_hash
    && left.validation_ref === right.validation_ref;
}

/**
 * Reconcile the gate decision into the one feature workspace that opened it.
 *
 * The project gate is committed first because it is the durable decision
 * ledger. This second commit deliberately uses the exact origin selector,
 * the same borrowed root descriptor, and a workspace digest CAS. Therefore
 * a crash between the two commits is recoverable by replaying the same
 * trusted answer, while a moved/foreign workspace can never be adopted by
 * the approval path.
 */
function bindApprovedOriginWorkspace(
  root: string,
  input: ConstitutionDecisionInput,
  gate: ConstitutionGateRecord,
  binding: ConstitutionBinding,
  pinnedRoot: PinnedProjectRoot,
): ConstitutionGateOutcome<null> {
  if (gate.gate_id !== input.gate_id || gate.origin_run_key !== input.run_key) {
    return {
      ok: false,
      code: "SPEC_PROOF_INVALID",
      error: "approved constitution gate origin does not match the requested workspace selector",
    };
  }
  if (!pinnedRoot.isStable()) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before constitution workspace binding" };
  }

  const rootSnapshot: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };
  const resolved = resolveFeatureWorkspace(
    root,
    { feature_id: input.feature_id, run_key: input.run_key },
    rootSnapshot,
  );
  if (!resolved.ok) {
    // Bootstrap may legitimately happen before the feature workspace exists.
    // There is no unrelated workspace to mutate in that case; workflow
    // preparation will create/bind its own exact origin aggregate later.
    if (resolved.code === "SPEC_FEATURE_UNKNOWN") return { ok: true, value: null };
    return { ok: false, code: "SPEC_STATE_INVALID", error: `origin feature workspace could not be resolved: ${resolved.error}` };
  }
  const workspace = resolved.value;
  const expectedSource = gate.origin_kind === "external_import" ? "external" : "native";
  if (workspace.source_kind !== expectedSource) {
    return {
      ok: false,
      code: "SPEC_PROOF_INVALID",
      error: `origin workspace source kind '${workspace.source_kind}' does not match constitution origin '${gate.origin_kind}'`,
    };
  }
  if (!pinnedRoot.isStable()) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed while resolving the constitution workspace" };
  }

  if (workspace.constitution_binding !== null) {
    if (!sameConstitutionBinding(workspace.constitution_binding, binding)) {
      return {
        ok: false,
        code: "SPEC_STATE_INVALID",
        error: "origin feature workspace is already bound to a different constitution",
      };
    }
    if (workspace.constitution_gate_ref === gate.gate_id) return { ok: true, value: null };
    return {
      ok: false,
      code: "SPEC_STATE_INVALID",
      error: "origin feature workspace constitution binding has a mismatched gate reference",
    };
  }

  const candidate = bindWorkspaceConstitution(workspace, binding, gate.gate_id);
  if (!pinnedRoot.isStable()) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before constitution workspace persistence" };
  }
  const persisted = persistFeatureWorkspace(
    root,
    candidate,
    rootSnapshot,
    {
      expected_workspace_digest: digestOf(workspace),
      pre_commit: () => {
        const persistenceIssue = currentConstitutionPersistenceIssue(root, binding, gate.gate_id, pinnedRoot);
        if (persistenceIssue) throw new Error(persistenceIssue);
      },
    },
  );
  if (!persisted.ok) {
    return {
      ok: false,
      code: persisted.code === "SPEC_PATH_UNAUTHORIZED" ? "SPEC_PATH_UNAUTHORIZED" : "SPEC_STATE_INVALID",
      error: `approved constitution binding could not be persisted to the origin workspace: ${persisted.error}`,
    };
  }
  if (!pinnedRoot.isStable()
    || persisted.value.constitution_gate_ref !== gate.gate_id
    || !persisted.value.constitution_binding
    || !sameConstitutionBinding(persisted.value.constitution_binding, binding)) {
    return {
      ok: false,
      code: "SPEC_PATH_UNAUTHORIZED",
      error: "project root or origin workspace changed while persisting the constitution binding",
    };
  }
  return { ok: true, value: null };
}

/**
 * Clear only the origin workspace binding that still identifies the exact
 * stale constitution source being invalidated. A newer or unrelated binding
 * is never adopted or removed; its CAS conflict fails closed.
 */
function clearStaleOriginWorkspaceConstitution(
  root: string,
  featureId: string | undefined,
  runKey: string,
  gateId: string,
  staleBinding: ConstitutionBinding | null,
  pinnedRoot: PinnedProjectRoot,
): ConstitutionGateOutcome<null> {
  if (!featureId || !staleBinding) return { ok: true, value: null };
  if (!pinnedRoot.isStable()) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before stale constitution workspace recovery" };
  }
  const rootSnapshot: WorkspaceRootSnapshot = {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  };
  const resolved = resolveFeatureWorkspace(root, { feature_id: featureId, run_key: runKey }, rootSnapshot);
  if (!resolved.ok) {
    if (resolved.code === "SPEC_FEATURE_UNKNOWN") return { ok: true, value: null };
    return { ok: false, code: "SPEC_STATE_INVALID", error: `origin feature workspace could not be resolved for constitution recovery: ${resolved.error}` };
  }
  const workspace = resolved.value;
  if (workspace.constitution_binding === null
    || workspace.constitution_gate_ref !== gateId
    || !sameConstitutionBinding(workspace.constitution_binding, staleBinding)) {
    return { ok: true, value: null };
  }
  const candidate = {
    ...workspace,
    constitution_binding: null,
    constitution_gate_ref: null,
  };
  if (!pinnedRoot.isStable()) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before stale constitution workspace recovery" };
  }
  const persisted = persistFeatureWorkspace(
    root,
    candidate,
    rootSnapshot,
    { expected_workspace_digest: digestOf(workspace), authority_neutral_cleanup: true },
  );
  if (!persisted.ok) {
    return {
      ok: false,
      code: persisted.code === "SPEC_PATH_UNAUTHORIZED" ? "SPEC_PATH_UNAUTHORIZED" : "SPEC_STATE_INVALID",
      error: `stale origin constitution binding could not be cleared safely: ${persisted.error}`,
    };
  }
  if (!pinnedRoot.isStable()
    || persisted.value.constitution_binding !== null
    || persisted.value.constitution_gate_ref !== null) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "origin workspace changed while stale constitution binding was being cleared" };
  }
  return { ok: true, value: null };
}

/**
 * Commit the approved impact transition to the one canonical gate. The
 * previous binding is a CAS precondition; no caller can advance a gate that
 * moved since assessment.
 */
export function commitConstitutionImpactBinding(
  projectRoot: string,
  input: {
    previous_binding: ConstitutionBinding;
    current_binding: ConstitutionBinding;
    pinnedRoot?: PinnedProjectRoot;
    lock_held?: boolean;
    beforeWrite?: () => void;
  },
): ConstitutionGateOutcome<ConstitutionGateRecord> {
  const ownsPinnedRoot = input.pinnedRoot === undefined;
  const pinnedRoot = input.pinnedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `project root is not a readable directory: ${projectRoot}` };
  }
  const root = pinnedRoot.canonical_root;
  const commit = (): ConstitutionGateOutcome<ConstitutionGateRecord> => {
    let mutationReceipt: PinnedRootWriteReceipt | undefined;
    const envelope = loadEnvelope(root, {
      origin_kind: "native_direct",
      origin_run_key: "constitution-impact",
      origin_stage: "specify",
    }, pinnedRoot);
    if (!envelope || !envelope.gate.binding) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution gate has no approved previous binding" };
    }
    if (validateConstitutionBinding(input.previous_binding).length > 0
      || validateConstitutionBinding(input.current_binding).length > 0) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution impact bindings are malformed" };
    }
    if (!sameConstitutionBinding(envelope.gate.binding, input.previous_binding)) {
      if (sameConstitutionBinding(envelope.gate.binding, input.current_binding)) return { ok: true, value: { ...envelope.gate } };
      return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "constitution gate binding changed after impact assessment" };
    }
    const current = resolveCurrentConstitutionBinding(root, { explicit_path: input.current_binding.path, pinnedRoot });
    if (!current.ok || !sameConstitutionBinding(current.value, input.current_binding)) {
      return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "current constitution source changed before impact gate commit" };
    }
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before impact gate commit" };
    const gateRelativePath = join(CONSTITUTION_DIR_RELATIVE, "gate.json");
    envelope.gate.binding = { ...input.current_binding };
    envelope.gate.status = "usable";
    envelope.gate.usability_result = "usable";
    envelope.gate.checkpoint_ref = null;
    envelope.gate.provider = envelope.gate.provider ?? null;
    const expectedPostimage = Buffer.from(serializedGateEnvelope(envelope), "utf8");
    persistEnvelope(root, envelope, pinnedRoot, {
      beforeWrite: input.beforeWrite,
      afterWrite: (receipt) => { mutationReceipt = receipt; },
    });
    if (!pinnedRoot.isStable()) return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed after impact gate commit" };
    let postimageMatches = false;
    try {
      const observed = Buffer.from(pinnedRoot.readFile(gateRelativePath, { maxBytes: MAX_GATE_BYTES }).bytes);
      postimageMatches = observed.equals(expectedPostimage);
    } catch {
      postimageMatches = false;
    }
    if (!postimageMatches) {
      return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "constitution gate changed during impact commit" };
    }
    const liveAfterWrite = resolveCurrentConstitutionBinding(root, { explicit_path: input.current_binding.path, pinnedRoot });
    if (!liveAfterWrite.ok || !sameConstitutionBinding(liveAfterWrite.value, input.current_binding)) {
      // The source may have changed after the gate write hook. Undo only our
      // exact postimage; if another writer won the gate CAS, preserve it.
      if (mutationReceipt) rollbackPinnedRootWriteReceipt(pinnedRoot, mutationReceipt);
      return { ok: false, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: "current constitution source changed after impact gate commit" };
    }
    return { ok: true, value: { ...envelope.gate }, receipt: mutationReceipt };
  };
  try {
    return input.lock_held ? commit() : withCtoRunLock(root, "__constitution__", commit, { pinnedRoot });
  } catch (error) {
    const failure = gatePersistenceFailure(error, "constitution impact gate commit failed");
    return { ok: false, code: failure.code, error: failure.error };
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}

export interface ConstitutionImpactAssessmentPreflight {
  feature_id: string;
  run_key: string;
  /** Explicit expected workspace digest used by the apply CAS. */
  workspace_digest: string;
  previous_binding: ConstitutionBinding;
  current_binding: ConstitutionBinding;
  assessment_id: string;
}


export interface ConstitutionCheckpointAskInput {
  gate_id: string;
  feature_id: string;
  run_key: string;
  checkpoint_id: string;
  draft_sha256: string;
  feedback?: string;
}

export interface ConstitutionCheckpointAskPreview {
  gate_id: string;
  feature_id: string;
  run_key: string;
  checkpoint_id: string;
  draft_sha256: string;
  draft_version: number;
  allowed_decisions: readonly ["approve_continue", "request_changes"];
}

function constitutionAskFailure(code: ConstitutionGateCode, error: string): ConstitutionGateOutcome<never> {
  return { ok: false, code, error };
}

function previewConstitutionCheckpointUnlocked(
  root: string,
  input: ConstitutionCheckpointAskInput,
  pinnedRoot: PinnedProjectRoot,
): ConstitutionGateOutcome<ConstitutionCheckpointAskPreview> {
  const placeholderOrigin: ConstitutionOriginDescriptor = { origin_kind: "native_direct", origin_run_key: input.run_key, origin_stage: "specify" };
  const envelope = loadEnvelope(root, placeholderOrigin, pinnedRoot);
  if (!envelope) return constitutionAskFailure("SPEC_STATE_INVALID", "persisted constitution gate state is corrupt; refusing to authorize a checkpoint");
  if (envelope.gate_id !== input.gate_id) return constitutionAskFailure("SPEC_GATE_UNKNOWN", `unknown constitution gate: ${input.gate_id}`);
  const gate = envelope.gate;
  if (envelope.feature_id !== input.feature_id || gate.origin_run_key !== input.run_key) {
    return constitutionAskFailure("SPEC_PROOF_INVALID", "constitution checkpoint selectors do not match the blocked origin");
  }
  if (gate.status !== "awaiting_approval" || gate.checkpoint_ref !== input.checkpoint_id) {
    return constitutionAskFailure("SPEC_CHECKPOINT_UNKNOWN", `no open constitution checkpoint '${input.checkpoint_id}'`);
  }
  const draft = latestDraft(envelope);
  if (!draft || draft.document_sha256 !== input.draft_sha256 || sha256Hex(draft.document) !== draft.document_sha256) {
    return constitutionAskFailure("SPEC_DRAFT_INVALID", "constitution checkpoint is not bound to the exact draft digest");
  }
  const expectedCheckpoint = `${gate.gate_id}.checkpoint.v${draft.version}`;
  if (input.checkpoint_id !== expectedCheckpoint
    || !loadUsabilityEvidence(root, draft.validation_ref, draft.document_sha256, pinnedRoot)
    || !persistedDraftMatches(root, envelope.gate_id, draft, pinnedRoot)) {
    return constitutionAskFailure("SPEC_DRAFT_INVALID", "constitution checkpoint is not bound to its exact immutable draft artifact");
  }
  return {
    ok: true,
    value: {
      gate_id: envelope.gate_id,
      feature_id: input.feature_id,
      run_key: input.run_key,
      checkpoint_id: input.checkpoint_id,
      draft_sha256: draft.document_sha256,
      draft_version: draft.version,
      allowed_decisions: DECISIONS,
    },
  };
}

/** Validate the exact open constitution checkpoint before showing host UI. */
export function validateConstitutionCheckpointAsk(
  projectRoot: string,
  input: ConstitutionCheckpointAskInput,
): ConstitutionGateOutcome<ConstitutionCheckpointAskPreview> {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return constitutionAskFailure("SPEC_PATH_UNAUTHORIZED", `project root is not a readable directory: ${projectRoot}`);
  try {
    return previewConstitutionCheckpointUnlocked(pinnedRoot.canonical_root, input, pinnedRoot);
  } finally {
    pinnedRoot.close();
  }
}

function constitutionAnswerBinding(answer: ConstitutionTrustedAnswer): string {
  return checkpointAnswerBinding(answer);
}

/**
 * Record a host-selected constitution answer before the normal workflow state
 * exists. The envelope is the pre-workflow trusted ledger; the proof fields
 * and digest are exactly the same immutable answer mechanism used by generic
 * workflow checkpoints.
 */
export function recordConstitutionCheckpointAnswer(
  projectRoot: string,
  input: ConstitutionCheckpointAskInput & { decision: "approve_continue" | "request_changes"; feedback?: string; beforeWrite?: () => void },
): ConstitutionGateOutcome<{ preview: ConstitutionCheckpointAskPreview; answer: ConstitutionTrustedAnswer; proof: CheckpointAnswerProof }> {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return constitutionAskFailure("SPEC_PATH_UNAUTHORIZED", `project root is not a readable directory: ${projectRoot}`);
  const root = pinnedRoot.canonical_root;
  try {
    return withCtoRunLock(
      root,
      "__constitution__",
      () => {
        const preview = previewConstitutionCheckpointUnlocked(root, input, pinnedRoot);
        if (!preview.ok) return preview;
        const placeholderOrigin: ConstitutionOriginDescriptor = { origin_kind: "native_direct", origin_run_key: input.run_key, origin_stage: "specify" };
        const envelope = loadEnvelope(root, placeholderOrigin, pinnedRoot);
        if (!envelope) return constitutionAskFailure("SPEC_STATE_INVALID", "persisted constitution gate state is corrupt; refusing to record an answer");
        const selectedFeedback = input.feedback;
        if (input.decision === "request_changes" && (selectedFeedback === undefined || !boundedGateFeedback(selectedFeedback))) {
          return constitutionAskFailure("SPEC_FEEDBACK_REQUIRED", "request_changes requires non-empty bounded trusted feedback");
        }
        if (input.decision !== "request_changes" && input.feedback !== undefined) {
          return constitutionAskFailure("SPEC_PROOF_INVALID", "feedback is only valid for request_changes");
        }
        const existing = (envelope.trusted_answers ?? []).find((candidate) =>
          !candidate.consumed_at
          && candidate.gate_id === input.gate_id
          && candidate.feature_id === input.feature_id
          && candidate.run_id === input.run_key
          && candidate.checkpoint_id === input.checkpoint_id
          && candidate.draft_sha256 === input.draft_sha256,
        );
        if (existing) {
          if (existing.decision !== input.decision || existing.feedback !== selectedFeedback) return constitutionAskFailure("SPEC_PROOF_INVALID", "a contradictory unconsumed constitution answer already exists");
          return { ok: true, value: { preview: preview.value, answer: existing, proof: { answer_id: existing.answer_id, nonce: existing.nonce, channel: existing.channel, reference: existing.reference, binding: existing.binding, ...(existing.feedback !== undefined ? { feedback: existing.feedback } : {}) } } };
        }
        const answerId = `constitution-answer-${randomUUID()}`;
        const answer: ConstitutionTrustedAnswer = {
          answer_id: answerId,
          nonce: randomUUID(),
          channel: "terminal",
          reference: `terminal:constitution_checkpoint_ask_selected:${answerId}`,
          run_id: input.run_key,
          stage_id: envelope.gate.origin_stage,
          checkpoint_id: input.checkpoint_id,
          work_identity_hash: sha256Hex(`${root}\n${input.gate_id}\n${input.feature_id}\n${input.run_key}\n${input.draft_sha256}`),
          capability_id: `constitution:${input.gate_id}`,
          capability_epoch: `draft:${preview.value.draft_version}`,
          policy_hash: sha256Hex(JSON.stringify({ gate_id: input.gate_id, checkpoint_id: input.checkpoint_id, draft_sha256: input.draft_sha256, allowed_decisions: DECISIONS })),
          feature_id: input.feature_id,
          subject_binding: input.draft_sha256,
          subject_revision: preview.value.draft_version,
          decision: input.decision,
          ...(selectedFeedback !== undefined ? { feedback: selectedFeedback } : {}),
          binding: "",
          issued_at: nowIso(),
          gate_id: input.gate_id,
          draft_sha256: input.draft_sha256,
        };
        answer.binding = constitutionAnswerBinding(answer);
        envelope.trusted_answers = [...(envelope.trusted_answers ?? []), answer].slice(-MAX_DECISIONS);
        let gateReceipt: PinnedRootWriteReceipt | undefined;
        persistEnvelope(root, envelope, pinnedRoot, {
          beforeWrite: input.beforeWrite,
          afterWrite: (receipt) => { gateReceipt = receipt; },
        });
        if (!pinnedRoot.isStable()) {
          if (gateReceipt) rollbackPinnedRootWriteReceipt(pinnedRoot, gateReceipt);
          return constitutionAskFailure("SPEC_PATH_UNAUTHORIZED", "project root changed after constitution answer persistence");
        }
        // A bootstrap/correction answer is a non-advancing gate-owned ledger
        // entry, so an absent or unusable source is expected here. Existing
        // usable bindings remain authority-bearing and must still be checked
        // after the exact gate receipt is published.
        if (envelope.gate.binding && envelope.gate.usability_result === "usable") {
          const liveAfterWrite = resolveCurrentConstitutionBinding(root, { explicit_path: envelope.gate.binding.path, pinnedRoot });
          if (!liveAfterWrite.ok || !sameConstitutionBinding(liveAfterWrite.value, envelope.gate.binding)) {
            if (gateReceipt) rollbackPinnedRootWriteReceipt(pinnedRoot, gateReceipt);
            return constitutionAskFailure("SPEC_CONSTITUTION_IMPACT_PENDING", "current constitution source changed after answer persistence");
          }
        }
        return { ok: true, value: { preview: preview.value, answer, proof: { answer_id: answer.answer_id, nonce: answer.nonce, channel: answer.channel, reference: answer.reference, binding: answer.binding, ...(answer.feedback !== undefined ? { feedback: answer.feedback } : {}) } } };
      },
      { pinnedRoot },
    );
  } catch (error) {
    const failure = gatePersistenceFailure(error, "constitution answer could not be persisted");
    return constitutionAskFailure(failure.code, failure.error);
  } finally {
    pinnedRoot.close();
  }
}

function presentConstitutionDraftWithoutWorkflowState(
  root: string,
  input: ConstitutionDraftPresentation,
  documentSha: string,
  validationRef: string,
  pinnedRoot: PinnedProjectRoot,
): ConstitutionGateOutcome<ConstitutionGateRecord & { allowed_decisions: typeof DECISIONS; draft_version: number }> {
  return withCtoRunLock(root, "__constitution__", () => {
    const placeholderOrigin: ConstitutionOriginDescriptor = { origin_kind: "native_direct", origin_run_key: input.run_key, origin_stage: "specify" };
    const envelope = loadEnvelope(root, placeholderOrigin, pinnedRoot);
    if (!envelope) return constitutionAskFailure("SPEC_STATE_INVALID", "persisted constitution gate state is corrupt; refusing to reset approved state");
    if (envelope.gate_id !== input.gate_id) return constitutionAskFailure("SPEC_GATE_UNKNOWN", `unknown constitution gate: ${input.gate_id}`);
    const gate = envelope.gate;
    if (gate.origin_run_key !== input.run_key) return constitutionAskFailure("SPEC_STATE_INVALID", "constitution draft origin does not match the requested run");
    if (envelope.feature_id === null) envelope.feature_id = input.feature_id;
    else if (envelope.feature_id !== input.feature_id) return constitutionAskFailure("SPEC_STATE_INVALID", "constitution bootstrap is already bound to another feature workspace");
    if (gate.status === "awaiting_approval") {
      const current = latestDraft(envelope);
      if (current && current.document === input.document && current.document_sha256 === documentSha && current.validation_ref === validationRef
        && loadUsabilityEvidence(root, validationRef, documentSha, pinnedRoot)
        && gate.checkpoint_ref === `${gate.gate_id}.checkpoint.v${current.version}`
        && persistedDraftMatches(root, envelope.gate_id, current, pinnedRoot)) {
        return { ok: true, value: { ...gate, allowed_decisions: DECISIONS, draft_version: current.version } };
      }
      return constitutionAskFailure("SPEC_STATE_INVALID", "a constitution checkpoint is already open; decide it before presenting new content");
    }
    if (gate.status !== "constitution_required") return constitutionAskFailure("SPEC_STATE_INVALID", `constitution gate is not open for a draft (status ${gate.status})`);
    let version = (latestDraft(envelope)?.version ?? 0) + 1;
    let draft: ConstitutionDraftRecord;
    for (;;) {
      draft = { version, document: input.document, document_sha256: documentSha, validation_ref: validationRef, presented_at: nowIso() };
      try {
        persistUsabilityEvidence(root, documentSha, pinnedRoot);
        persistDraft(root, envelope.gate_id, draft, pinnedRoot);
        break;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.includes("already exists with different bytes")) {
          version += 1;
          continue;
        }
        return constitutionAskFailure("SPEC_STATE_INVALID", `constitution draft could not be persisted: ${detail}`);
      }
    }
    envelope.drafts.push(draft);
    if (envelope.drafts.length > MAX_DRAFTS) envelope.drafts.splice(0, envelope.drafts.length - MAX_DRAFTS);
    gate.status = "awaiting_approval";
    gate.usability_result = "usable";
    gate.checkpoint_ref = `${gate.gate_id}.checkpoint.v${version}`;
    gate.resume_marker = `${gate.gate_id}.resume.v${version}`;
    envelope.resume_marker_consumed = false;
    persistEnvelope(root, envelope, pinnedRoot);
    return { ok: true, value: { ...gate, allowed_decisions: DECISIONS, draft_version: version } };
  }, { pinnedRoot });
}

/**
 * Present a bootstrap draft for the two-decision checkpoint. Only a draft
 * that passes the deterministic usability gate opens the hard-human
 * checkpoint; re-presenting the exact open draft replays the established
 * record, while new content becomes a new immutable draft version.
 */
export function presentConstitutionDraft(
  projectRoot: string,
  input: ConstitutionDraftPresentation,
  providedRoot?: PinnedProjectRoot,
): ConstitutionGateOutcome<ConstitutionGateRecord & { allowed_decisions: typeof DECISIONS; draft_version: number }> {
  const ownsPinnedRoot = providedRoot === undefined;
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `project root is not a readable directory: ${projectRoot}` };
  }
  const root = pinnedRoot.canonical_root;
  try {
    if (typeof input.document !== "string" || input.document.length === 0) {
    return { ok: false, code: "SPEC_DRAFT_INVALID", error: "constitution draft document is required" };
  }
  if (Buffer.byteLength(input.document, "utf8") > MAX_DOCUMENT_BYTES) {
    return { ok: false, code: "SPEC_INPUT_OVERSIZED", error: `constitution draft exceeds ${MAX_DOCUMENT_BYTES} bytes` };
  }
  const usability = evaluateConstitutionUsability(input.document);
  if (usability.status !== "usable") {
    return { ok: false, code: "SPEC_DRAFT_INVALID", error: `constitution draft rejected: ${usability.reason}` };
  }

  const documentSha = sha256Hex(input.document);
  const validationRef = usabilityEvidenceRef(documentSha);
  const selector = { feature_id: input.feature_id, run_key: input.run_key };
  const selected = resolveStatePinned(root, pinnedRoot, selector);
  const preparation = resolvePreparationStatePinned(root, pinnedRoot, selector);
  if (!pinnedRoot.isStable()) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed during constitution draft classification" };
  }
  if ((!selected.invalid && !selected.state)
    || (!preparation.invalid && preparation.state && preparation.state.classification === undefined)) {
    if (!pinnedRoot.isStable()) {
      return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before constitution draft persistence" };
    }
    return presentConstitutionDraftWithoutWorkflowState(root, input, documentSha, validationRef, pinnedRoot);
  }
  if (!pinnedRoot.isStable()) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed before constitution state persistence" };
  }
  const transaction = updateStateAtomically<ConstitutionGateOutcome<ConstitutionGateRecord & { allowed_decisions: typeof DECISIONS; draft_version: number }>>(
    root,
    (snapshot): StateMutation<ConstitutionGateOutcome<ConstitutionGateRecord & { allowed_decisions: typeof DECISIONS; draft_version: number }>> => {
      if (!snapshot.state || !snapshot.target.statePath) {
        return { op: "fail", code: "state_invalid", error: "constitution draft workspace is unavailable" };
      }
      const placeholderOrigin: ConstitutionOriginDescriptor = { origin_kind: "native_direct", origin_run_key: "unknown", origin_stage: "specify" };
      const envelope = loadEnvelope(root, placeholderOrigin, pinnedRoot);
      if (!envelope) {
        return { op: "fail", code: "SPEC_STATE_INVALID", error: "persisted constitution gate state is corrupt; refusing to reset approved state" };
      }
      if (envelope.gate_id !== input.gate_id) {
        return { op: "fail", code: "SPEC_GATE_UNKNOWN", error: `unknown constitution gate: ${input.gate_id}` };
      }
      const gate = envelope.gate;
      if (
        gate.origin_run_key !== input.run_key
        || snapshot.state.run_key !== input.run_key
        || snapshot.state.specification?.feature_id !== input.feature_id
      ) {
        return { op: "fail", code: "SPEC_STATE_INVALID", error: "constitution draft workspace identity does not match the blocked origin" };
      }
      if (envelope.feature_id === null) {
        envelope.feature_id = input.feature_id;
      } else if (envelope.feature_id !== input.feature_id) {
        return { op: "fail", code: "SPEC_STATE_INVALID", error: "constitution bootstrap is already bound to another feature workspace" };
      }

      if (gate.status === "awaiting_approval") {
        const current = latestDraft(envelope);
        if (current
          && current.document === input.document
          && current.document_sha256 === documentSha
          && current.validation_ref === validationRef
          && loadUsabilityEvidence(root, validationRef, documentSha, pinnedRoot)) {
          try {
            persistDraft(root, envelope.gate_id, current, pinnedRoot);
          } catch (error) {
            return { op: "fail", code: "SPEC_STATE_INVALID", error: `constitution draft artifact could not be verified: ${error instanceof Error ? error.message : String(error)}` };
          }
          const expectedCheckpoint = `${gate.gate_id}.checkpoint.v${current.version}`;
          if (gate.checkpoint_ref !== expectedCheckpoint || !persistedDraftMatches(root, envelope.gate_id, current, pinnedRoot)) {
            return { op: "fail", code: "SPEC_STATE_INVALID", error: "open constitution checkpoint is not bound to its immutable draft artifact" };
          }
          return {
            op: "discard",
            value: { ok: true, value: { ...gate, allowed_decisions: DECISIONS, draft_version: current.version } },
          };
        }
        return { op: "fail", code: "SPEC_STATE_INVALID", error: "a constitution checkpoint is already open; decide it before presenting new content" };
      }
      if (gate.status !== "constitution_required") {
        return { op: "fail", code: "SPEC_STATE_INVALID", error: `constitution gate is not open for a draft (status ${gate.status})` };
      }

      let version = (latestDraft(envelope)?.version ?? 0) + 1;
      let draft: ConstitutionDraftRecord;
      for (;;) {
        draft = {
          version,
          document: input.document,
          document_sha256: documentSha,
          validation_ref: validationRef,
          presented_at: nowIso(),
        };
        try {
          persistUsabilityEvidence(root, documentSha, pinnedRoot);
          persistDraft(root, envelope.gate_id, draft, pinnedRoot);
          break;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (detail.includes("already exists with different bytes")) {
            version += 1;
            continue;
          }
          return { op: "fail", code: "SPEC_STATE_INVALID", error: `constitution draft could not be persisted: ${detail}` };
        }
      }
      envelope.drafts.push(draft);
      if (envelope.drafts.length > MAX_DRAFTS) envelope.drafts.splice(0, envelope.drafts.length - MAX_DRAFTS);
      gate.status = "awaiting_approval";
      gate.usability_result = "usable";
      gate.checkpoint_ref = `${gate.gate_id}.checkpoint.v${version}`;
      gate.resume_marker = `${gate.gate_id}.resume.v${version}`;
      envelope.resume_marker_consumed = false;
      try {
        persistEnvelope(root, envelope, pinnedRoot);
      } catch (error) {
        const failure = gatePersistenceFailure(error, "constitution gate could not be persisted");
        return { op: "fail", code: failure.code, error: failure.error };
      }
      const result: ConstitutionGateOutcome<ConstitutionGateRecord & { allowed_decisions: typeof DECISIONS; draft_version: number }> = {
        ok: true,
        value: { ...gate, allowed_decisions: DECISIONS, draft_version: version },
      };
      return { op: "commit", state: snapshot.state, value: result };
    },
    { selector: { feature_id: input.feature_id, run_key: input.run_key }, pinnedRoot },
  );
  if (!transaction.ok) {
    const code = isConstitutionGateCode(transaction.code) ? transaction.code : "SPEC_STATE_INVALID";
    return { ok: false, code, error: transaction.error };
  }
  return transaction.value ?? { ok: false, code: "SPEC_STATE_INVALID", error: "constitution draft transaction completed without a result" };
  } catch (error) {
    if (error instanceof ConstitutionGatePersistenceError) {
      return { ok: false, code: error.code, error: error.message };
    }
    throw error;
  } finally {
    if (ownsPinnedRoot) pinnedRoot.close();
  }
}

function constitutionAnswerProofError(
  envelope: ConstitutionGateEnvelope,
  input: ConstitutionDecisionInput,
): ConstitutionTrustedAnswer | string {
  const proof = input.actor_provenance?.proof;
  if (input.authorization !== "human" || input.actor_provenance?.kind !== "user" || !proof) {
    return "constitution checkpoint decisions require typed human actor provenance";
  }
  const answer = (envelope.trusted_answers ?? []).find((candidate) => candidate.answer_id === proof.answer_id);
  if (!answer) return "constitution answer proof is not present in the gate-owned trusted ledger";
  const latest = latestDraft(envelope);
  if (!latest || answer.subject_revision !== latest.version || answer.draft_sha256 !== latest.document_sha256) return "constitution answer proof subject revision is stale";
  if (answer.gate_id !== input.gate_id
    || answer.feature_id !== input.feature_id
    || answer.run_id !== input.run_key
    || answer.checkpoint_id !== input.checkpoint_id
    || answer.decision !== input.decision
    || answer.reference !== input.actor_provenance.ref
    || answer.nonce !== proof.nonce
    || answer.channel !== "terminal"
    || answer.channel !== proof.channel
    || answer.reference !== proof.reference
    || answer.binding !== proof.binding
    || answer.feedback !== proof.feedback
    || answer.binding !== constitutionAnswerBinding(answer)) {
    return "constitution answer proof is stale or mismatched";
  }
  return answer;
}

function decideConstitutionCheckpointFromGate(
  root: string,
  input: ConstitutionDecisionInput,
  pinnedRoot: PinnedProjectRoot,
): ConstitutionDecisionResult {
  try {
    return withCtoRunLock(root, "__constitution__", () => {
    const placeholderOrigin: ConstitutionOriginDescriptor = { origin_kind: "native_direct", origin_run_key: input.run_key, origin_stage: "specify" };
    const envelope = loadEnvelope(root, placeholderOrigin, pinnedRoot);
    if (!envelope) return { ok: false, code: "SPEC_STATE_INVALID", error: "persisted constitution gate state is corrupt; refusing to reset approved state" };
    if (envelope.gate_id !== input.gate_id) return { ok: false, code: "SPEC_GATE_UNKNOWN", error: `unknown constitution gate: ${input.gate_id}` };
    const gate = envelope.gate;
    if (!DECISIONS.includes(input.decision as (typeof DECISIONS)[number])) {
      return { ok: false, code: "SPEC_DECISION_INVALID", error: `'${String(input.decision)}' is not a constitution bootstrap decision; bootstrap allows exactly approve_continue | request_changes` };
    }
    const proofAnswer = constitutionAnswerProofError(envelope, input);
    if (typeof proofAnswer === "string") return { ok: false, code: "SPEC_PROOF_INVALID", error: proofAnswer };
    const proofFeedback = input.actor_provenance.proof?.feedback;
    if (input.decision === "request_changes"
      ? input.feedback === undefined || input.feedback !== proofAnswer.feedback || input.feedback !== proofFeedback
      : input.feedback !== undefined || proofAnswer.feedback !== undefined || proofFeedback !== undefined) {
      return { ok: false, code: "SPEC_PROOF_INVALID", error: "constitution feedback must equal the trusted Ask proof byte-for-byte and is forbidden for approve_continue" };
    }
    if (envelope.feature_id !== input.feature_id || gate.origin_run_key !== input.run_key) {
      return { ok: false, code: "SPEC_PROOF_INVALID", error: "constitution answer workspace identity does not match the blocked origin" };
    }
    const established = [...envelope.decisions].reverse().find((record) =>
      record.checkpoint_id === input.checkpoint_id
      && record.decision === input.decision
      && (input.decision !== "request_changes" || record.feedback === (input.feedback ?? null)),
    );
    const isReplay = gate.checkpoint_ref !== input.checkpoint_id || gate.status !== "awaiting_approval";
    if (isReplay && (!established || !sameActor(established.actor_provenance, input.actor_provenance))) {
      return { ok: false, code: "SPEC_CHECKPOINT_UNKNOWN", error: `no open constitution checkpoint '${input.checkpoint_id}'` };
    }
    proofAnswer.consumed_at = proofAnswer.consumed_at ?? nowIso();
    if (isReplay) {
      persistEnvelope(root, envelope, pinnedRoot);
      if (gate.status === "approved" && envelope.resume) {
        if (!gate.binding) return { ok: false, code: "SPEC_STATE_INVALID", error: "approved constitution gate has no binding" };
        const originBinding = bindApprovedOriginWorkspace(root, input, gate, gate.binding, pinnedRoot);
        if (!originBinding.ok) return originBinding;
        return { ok: true, value: { ...gate, resume: envelope.resume, resume_consumed: true } };
      }
      return { ok: true, value: { ...gate, last_feedback: envelope.last_feedback } };
    }
    const draft = latestDraft(envelope);
    if (!draft || sha256Hex(draft.document) !== draft.document_sha256
      || proofAnswer.draft_sha256 !== draft.document_sha256
      || !loadUsabilityEvidence(root, draft.validation_ref, draft.document_sha256, pinnedRoot)
      || gate.checkpoint_ref !== `${gate.gate_id}.checkpoint.v${draft.version}`
      || !persistedDraftMatches(root, envelope.gate_id, draft, pinnedRoot)) {
      return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution draft is not bound to its exact immutable artifact and engine-owned usability evidence" };
    }
    const feedback = input.decision === "request_changes" ? (input.feedback ?? "").trim() : null;
    if (input.decision === "request_changes" && !feedback) return { ok: false, code: "SPEC_FEEDBACK_REQUIRED", error: "request_changes requires non-empty feedback" };
    const decisionRecord: ConstitutionDecisionRecord = {
      checkpoint_id: input.checkpoint_id,
      decision: input.decision,
      feedback,
      authorization: "human",
      actor_provenance: { kind: "user", ref: input.actor_provenance.ref, proof: { ...input.actor_provenance.proof! } },
      at: nowIso(),
    };
    if (input.decision === "request_changes") {
      gate.status = "constitution_required";
      gate.checkpoint_ref = null;
      gate.usability_result = null;
      gate.resume_marker = null;
      envelope.last_feedback = feedback;
      envelope.last_decision = { checkpoint_id: input.checkpoint_id, decision: input.decision, feedback };
      envelope.decisions.push(decisionRecord);
      if (envelope.decisions.length > MAX_DECISIONS) envelope.decisions.splice(0, envelope.decisions.length - MAX_DECISIONS);
      persistEnvelope(root, envelope, pinnedRoot);
      return { ok: true, value: { ...gate, last_feedback: envelope.last_feedback } };
    }
    const provider = gate.provider;
    const materialized = materializeApprovedConstitution(
      root,
      provider,
      draft.document,
      sourcePreimageOf(envelope),
      pinnedRoot,
      gate.gate_id,
      input.checkpoint_id,
    );
    if (!materialized.ok) return materialized;
    if (materialized.document !== draft.document || sha256Hex(materialized.document) !== draft.document_sha256) {
      rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.source_receipt);
      rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.wal_receipt);
      return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution correction bytes do not match the approved draft" };
    }
    if (!provider) {
      rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.source_receipt);
      rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.wal_receipt);
      return { ok: false, code: "SPEC_STATE_INVALID", error: "approved constitution has no selected provider" };
    }
    const binding: ConstitutionBinding = bindingFromDocument(provider, materialized.document, draft.validation_ref);
    const issues = validateConstitutionBinding(binding);
    if (issues.length > 0) {
      rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.source_receipt);
      rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.wal_receipt);
      return { ok: false, code: "SPEC_STATE_INVALID", error: `approved binding is invalid: ${issues.join("; ")}` };
    }
    gate.status = "approved";
    gate.binding = binding;
    gate.checkpoint_ref = null;
    gate.usability_result = "usable";
    clearSourcePreimage(envelope);
    envelope.resume = { origin_kind: gate.origin_kind, origin_run_key: gate.origin_run_key, resume_target: resumeTargetFor(gate) };
    envelope.resume_marker_consumed = true;
    envelope.last_decision = { checkpoint_id: input.checkpoint_id, decision: input.decision, feedback: null };
    envelope.decisions.push(decisionRecord);
    if (envelope.decisions.length > MAX_DECISIONS) envelope.decisions.splice(0, envelope.decisions.length - MAX_DECISIONS);
    try {
      persistEnvelope(root, envelope, pinnedRoot);
    } catch (error) {
      rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.source_receipt);
      rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.wal_receipt);
      throw error;
    }
    // The approved gate is durable; retire only this exact WAL receipt.
    rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.wal_receipt);
    const originBinding = bindApprovedOriginWorkspace(root, input, gate, binding, pinnedRoot);
    if (!originBinding.ok) return originBinding;
    return { ok: true, value: { ...gate, resume: envelope.resume, resume_consumed: true } };
  }, { pinnedRoot });
  } catch (error) {
    const failure = gatePersistenceFailure(error, "constitution decision could not be persisted");
    return { ok: false, code: failure.code, error: failure.error };
  }
}

/**
 * Record one trusted two-decision bootstrap decision. `approve_continue`
 * binds the approved draft, consumes the resume marker exactly once, and
 * returns the exact origin resume descriptor; `request_changes` requires
 * non-empty feedback and reopens the same draft stage. Replays return the
 * established result without duplicate side effects; `approve_stop` never
 * applies to bootstrap.
 */
export function decideConstitutionCheckpoint(
  projectRoot: string,
  input: ConstitutionDecisionInput,
): ConstitutionDecisionResult {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) {
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: `project root is not a readable directory: ${projectRoot}` };
  }
  const root = pinnedRoot.canonical_root;
  const gateEnvelope = loadEnvelope(
    root,
    { origin_kind: "native_direct", origin_run_key: input.run_key, origin_stage: "specify" },
    pinnedRoot,
  );
  const selector = { feature_id: input.feature_id, run_key: input.run_key };
  const selected = resolveStatePinned(root, pinnedRoot, selector);
  const preparation = resolvePreparationStatePinned(root, pinnedRoot, selector);
  if (!pinnedRoot.isStable()) {
    pinnedRoot.close();
    return { ok: false, code: "SPEC_PATH_UNAUTHORIZED", error: "project root changed during constitution decision classification" };
  }
  const gateAnswer = gateEnvelope?.trusted_answers?.some((answer) => answer.answer_id === input.actor_provenance?.proof?.answer_id) ?? false;
  if ((!selected.invalid && !selected.state)
    || (!preparation.invalid && preparation.state && preparation.state.classification === undefined)
    || gateAnswer) {
    const outcome = decideConstitutionCheckpointFromGate(root, input, pinnedRoot);
    pinnedRoot.close();
    return outcome;
  }
  try {
  const transaction = updateStateAtomically<ConstitutionDecisionResult>(
    root,
    (snapshot): StateMutation<ConstitutionDecisionResult> => {
      if (!snapshot.state || !snapshot.target.statePath) {
        return { op: "fail", code: "state_invalid", error: "constitution answer workspace is unavailable" };
      }
      let consumedState: TeamState | null = null;
      const result: ConstitutionDecisionResult = (() => {
        const placeholderOrigin: ConstitutionOriginDescriptor = { origin_kind: "native_direct", origin_run_key: "unknown", origin_stage: "specify" };
        const envelope = loadEnvelope(root, placeholderOrigin, pinnedRoot);
        if (!envelope) {
          return { ok: false, code: "SPEC_STATE_INVALID", error: "persisted constitution gate state is corrupt; refusing to reset approved state" } as const;
        }
        if (envelope.gate_id !== input.gate_id) {
          return { ok: false, code: "SPEC_GATE_UNKNOWN", error: `unknown constitution gate: ${input.gate_id}` } as const;
        }
        const gate = envelope.gate;
        if (!DECISIONS.includes(input.decision as (typeof DECISIONS)[number])) {
          return { ok: false, code: "SPEC_DECISION_INVALID", error: `'${String(input.decision)}' is not a constitution bootstrap decision; bootstrap allows exactly approve_continue | request_changes` } as const;
        }
        if (input.authorization !== "human" || !input.actor_provenance || typeof input.actor_provenance !== "object") {
          return { ok: false, code: "SPEC_PROOF_INVALID", error: "constitution checkpoint decisions require typed human actor provenance" } as const;
        }
        const selectedState = snapshot.state;
        if (
          envelope.feature_id !== input.feature_id
          || gate.origin_run_key !== input.run_key
          || selectedState.run_key !== input.run_key
          || selectedState.specification?.feature_id !== input.feature_id
        ) {
          return { ok: false, code: "SPEC_PROOF_INVALID", error: "constitution answer workspace identity does not match the blocked origin" } as const;
        }

        const established = [...envelope.decisions].reverse().find((record) =>
          record.checkpoint_id === input.checkpoint_id
          && record.decision === input.decision
          && (input.decision !== "request_changes" || record.feedback === (input.feedback ?? null)),
        );
        const isReplay = gate.checkpoint_ref !== input.checkpoint_id || gate.status !== "awaiting_approval";
        if (isReplay && (!established || established.authorization !== "human" || !sameActor(established.actor_provenance, input.actor_provenance))) {
          return { ok: false, code: "SPEC_CHECKPOINT_UNKNOWN", error: `no open constitution checkpoint '${input.checkpoint_id}'` } as const;
        }

        if (input.decision === "request_changes" && (!input.feedback || input.feedback !== input.feedback.trim())) {
          return { ok: false, code: "SPEC_FEEDBACK_REQUIRED", error: "request_changes requires exact non-empty feedback" } as const;
        }
        if (input.decision !== "request_changes" && input.feedback !== undefined) {
          return { ok: false, code: "SPEC_PROOF_INVALID", error: "feedback is only valid for request_changes" } as const;
        }
        const answerContext = {
          actor: input.actor_provenance,
          run_id: input.run_key,
          stage_id: gate.origin_stage,
          checkpoint_id: input.checkpoint_id,
          decision: input.decision,
          feature_id: input.feature_id,
          bind_active_context: !isReplay,
          require_hard_human: true,
          ...(input.decision === "request_changes" && input.feedback !== undefined ? { feedback: input.feedback } : {}),
        };
        const proofError = trustedCheckpointAnswerError(selectedState, answerContext);
        if (proofError) {
          return { ok: false, code: "SPEC_PROOF_INVALID", error: `constitution answer proof is invalid: ${proofError}` } as const;
        }

        const persistConsumption = (): ConstitutionGateOutcome<never> | null => {
          if (consumedState) return null;
          try {
            consumedState = consumeTrustedCheckpointAnswer(selectedState, answerContext);
            return null;
          } catch (error) {
            return { ok: false, code: "SPEC_STATE_INVALID", error: `constitution answer consumption could not be persisted: ${error instanceof Error ? error.message : String(error)}` };
          }
        };

        if (isReplay) {
          const consumptionFailure = persistConsumption();
          if (consumptionFailure) return consumptionFailure;
          if (gate.status === "approved" && envelope.resume) {
            return { ok: true, value: { ...gate, resume: envelope.resume, resume_consumed: true } };
          }
          return { ok: true, value: { ...gate, last_feedback: envelope.last_feedback } };
        }

        const draft = latestDraft(envelope);
        if (!draft) {
          return { ok: false, code: "SPEC_STATE_INVALID", error: "no constitution draft is bound to the open checkpoint" };
        }
        const actualDocumentSha = sha256Hex(draft.document);
        const expectedCheckpoint = `${gate.gate_id}.checkpoint.v${draft.version}`;
        if (actualDocumentSha !== draft.document_sha256
          || !loadUsabilityEvidence(root, draft.validation_ref, actualDocumentSha, pinnedRoot)
          || gate.checkpoint_ref !== expectedCheckpoint
          || !persistedDraftMatches(root, envelope.gate_id, draft, pinnedRoot)) {
          return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution draft is not bound to its exact immutable artifact and engine-owned usability evidence" };
        }
        const feedback = input.decision === "request_changes" ? (input.feedback ?? "").trim() : null;
        if (input.decision === "request_changes" && (!feedback || feedback.length === 0)) {
          return { ok: false, code: "SPEC_FEEDBACK_REQUIRED", error: "request_changes requires non-empty feedback" };
        }
        const decisionRecord: ConstitutionDecisionRecord = {
          checkpoint_id: input.checkpoint_id,
          decision: input.decision,
          feedback,
          authorization: "human",
          actor_provenance: {
            kind: input.actor_provenance.kind,
            ref: input.actor_provenance.ref,
            ...(input.actor_provenance.proof ? { proof: { ...input.actor_provenance.proof } } : {}),
          },
          at: nowIso(),
        };

        if (input.decision === "request_changes") {
          const consumptionFailure = persistConsumption();
          if (consumptionFailure) return consumptionFailure;
          gate.status = "constitution_required";
          gate.checkpoint_ref = null;
          gate.usability_result = null;
          gate.resume_marker = null;
          envelope.last_feedback = feedback;
          envelope.last_decision = { checkpoint_id: input.checkpoint_id, decision: input.decision, feedback };
          envelope.decisions.push(decisionRecord);
          if (envelope.decisions.length > MAX_DECISIONS) envelope.decisions.splice(0, envelope.decisions.length - MAX_DECISIONS);
          try {
            persistEnvelope(root, envelope, pinnedRoot);
          } catch (error) {
            const failure = gatePersistenceFailure(error, "constitution decision could not be persisted");
            return { ok: false, code: failure.code, error: failure.error };
          }
          return { ok: true, value: { ...gate, last_feedback: envelope.last_feedback } };
        }

        const provider = gate.provider;
        const materialized = materializeApprovedConstitution(
          root,
          provider,
          draft.document,
          sourcePreimageOf(envelope),
          pinnedRoot,
          gate.gate_id,
          input.checkpoint_id,
        );
        if (!materialized.ok) return materialized;
        if (materialized.document !== draft.document || sha256Hex(materialized.document) !== draft.document_sha256) {
          rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.source_receipt);
          rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.wal_receipt);
          return { ok: false, code: "SPEC_STATE_INVALID", error: "constitution correction bytes do not match the approved draft" };
        }
        if (!provider) {
          rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.source_receipt);
          rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.wal_receipt);
          return { ok: false, code: "SPEC_STATE_INVALID", error: "approved constitution has no selected provider" };
        }
        const binding: ConstitutionBinding = bindingFromDocument(provider, materialized.document, draft.validation_ref);
        const issues = validateConstitutionBinding(binding);
        if (issues.length > 0) {
          rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.source_receipt);
          rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.wal_receipt);
          return { ok: false, code: "SPEC_STATE_INVALID", error: `approved binding is invalid: ${issues.join("; ")}` };
        }
        const consumptionFailure = persistConsumption();
        if (consumptionFailure) return consumptionFailure;
        gate.status = "approved";
        gate.binding = binding;
        gate.checkpoint_ref = null;
        gate.usability_result = "usable";
        clearSourcePreimage(envelope);
        envelope.resume = {
          origin_kind: gate.origin_kind,
          origin_run_key: gate.origin_run_key,
          resume_target: resumeTargetFor(gate),
        };
        envelope.resume_marker_consumed = true;
        envelope.last_decision = { checkpoint_id: input.checkpoint_id, decision: input.decision, feedback: null };
        envelope.decisions.push(decisionRecord);
        if (envelope.decisions.length > MAX_DECISIONS) envelope.decisions.splice(0, envelope.decisions.length - MAX_DECISIONS);
        try {
          persistEnvelope(root, envelope, pinnedRoot);
        } catch (error) {
          rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.source_receipt);
          rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.wal_receipt);
          const failure = gatePersistenceFailure(error, "constitution decision could not be persisted");
          return { ok: false, code: failure.code, error: failure.error };
        }
        rollbackPinnedRootWriteReceipt(pinnedRoot, materialized.wal_receipt);
        return { ok: true, value: { ...gate, resume: envelope.resume, resume_consumed: true } };
      })();
      if (!result.ok) return { op: "fail", code: result.code, error: result.error };
      return consumedState
        ? { op: "commit", state: consumedState, value: result }
        : { op: "discard", value: result };
    },
    { selector: { feature_id: input.feature_id, run_key: input.run_key }, pinnedRoot },
  );
  if (!transaction.ok) {
    const code = isConstitutionGateCode(transaction.code) ? transaction.code : "SPEC_STATE_INVALID";
    return { ok: false, code, error: transaction.error };
  }
  return transaction.value ?? { ok: false, code: "SPEC_STATE_INVALID", error: "constitution decision transaction completed without a result" };
  } finally {
    pinnedRoot.close();
  }
}

// ── CTO preparation prerequisite adapter (T103) ─────────────────────────────

/** Input for the CTO preparation constitution prerequisite adapter. */
export interface CtoPreparationPrerequisiteInput {
  /** CTO run key the preparation attempt is bound to (never inferred). */
  origin_run_key: string;
  /** Optional explicit constitution document path (canonical provider contract). */
  explicit_path?: string | null;
  /** Caller-owned root pin for a larger atomic preparation operation. */
  pinnedRoot?: PinnedProjectRoot;
  /** Optional current impact assessment, re-establishing safety after drift. */
  impact_assessment?: ConstitutionImpactResult;
}

/**
 * Route the `cto_preparation` origin through the canonical constitution
 * prerequisite. Pure adapter: same gate record, same bootstrap ledger, same
 * provider/profile resolution as every other origin — no parallel state
 * machine, no preparation-specific gate storage. The blocked origin resumes
 * at Specify once the constitution is approved.
 */
export function ensureCtoPreparationPrerequisite(
  projectRoot: string,
  input: CtoPreparationPrerequisiteInput,
): ConstitutionGateOutcome<ConstitutionGateRecord> {
  if (!input || typeof input !== "object"
    || typeof input.origin_run_key !== "string"
    || input.origin_run_key.trim().length === 0
    || input.origin_run_key.length > 256) {
    return {
      ok: false,
      code: "SPEC_STATE_INVALID",
      error: "cto preparation prerequisite requires a non-empty origin_run_key (max 256 chars)",
    };
  }
  return ensureProjectConstitution(
    projectRoot,
    { origin_kind: "cto_preparation", origin_run_key: input.origin_run_key, origin_stage: "cto" },
    { explicit_path: input.explicit_path ?? null, impact_assessment: input.impact_assessment, pinnedRoot: input.pinnedRoot },
  );
}
