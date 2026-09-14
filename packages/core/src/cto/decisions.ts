/**
 * Project decision memory (architecture §4.3, br-zps.11).
 *
 * Tag-based recall only (D6): exact-match on `tags`/`by`, project-scoped —
 * every entry lives in one run's `CtoState`, never shared across instances,
 * no semantic search. `state.json` stays canonical; `decisionsToMarkdown`
 * is a deterministic projection for the human-readable `decisions.md`.
 */

import {
  closeSync,
  existsSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { TextDecoder } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  PinnedProjectRoot,
  PinnedRootError,
  rollbackPinnedRootWriteReceipt,
  type PinnedRootWriteDescriptor,
  type PinnedRootWritePreimage,
  type PinnedRootWriteReceipt,
} from "../specification/pinned-root.js";
import type { CheckpointAnswerProof, TeamState } from "../engine/types.js";
import {
  checkpointPolicyHash,
  consumeTrustedCheckpointAnswer,
  nativeCheckpointPolicy,
  resolveCheckpointPolicy,
  trustedCheckpointAnswerError,
  validateCheckpointDecision,
} from "../engine/checkpoints.js";
import {
  MAX_PERSISTED_STATE_BYTES,
  atomicWriteFile,
  resolveState,
  resolveStatePinned,
  rollbackStateMutationReceipts,
  updateStateAtomically,
} from "../engine/state.js";
import type { ConstitutionBinding, ConstitutionGateStatus, ConstitutionProviderSelection, WorkspacePhase, WorkspacePhaseRecord } from "../specification/types.js";
import type { SpecificationPhaseDecisionValue } from "../specification/phase.js";
import {
  canonicalJson,
  isSafeFeatureId,
  sha256Hex,
  validateConstitutionBinding,
} from "../specification/validation.js";
import { featureStatePath } from "../specification/workspace.js";
import { readPinnedCurrentConstitution } from "../specification/constitution-identities.js";
import { readProjectConstitutionGate } from "../specification/prerequisite.js";
import {
  MAX_CTO_SPECIFICATION_DECISION_BATCH_BYTES,
  MAX_CTO_SPECIFICATION_DECISIONS,
  MAX_CTO_SPECIFICATION_PROOF_BYTES,
  MAX_CTO_SPECIFICATION_TEXT_BYTES,
} from "./types.js";
import type { CtoState, DecisionMemoryEntry } from "./types.js";
import { MAX_PERSISTED_STATE_ARRAY, ctoStateDir, isSafeCtoRunId, isValidPersistedDecisionEntry } from "./state.js";
import { withCtoRunLock } from "./transaction-lock.js";

/**
 * Append a decision to the run's memory. `why` is MANDATORY and non-empty
 * (architecture §4.3) — empty/whitespace rationale throws a descriptive
 * Error and leaves `state` untouched. The transition performs no persistence;
 * callers commit through a trusted runtime transaction.
 */
export function recordDecision(
  state: CtoState,
  entry: Omit<DecisionMemoryEntry, "id" | "at">,
): CtoState {
  if (!entry || typeof entry !== "object" || typeof entry.why !== "string" || entry.why.trim().length === 0) {
    throw new Error(
      `recordDecision: "why" is mandatory and must be non-empty (got ${JSON.stringify((entry as { why?: unknown } | null)?.why)}) — refusing to record a decision without a rationale`,
    );
  }
  const candidate = { ...entry, id: randomUUID(), at: new Date().toISOString() };
  if (!isValidPersistedDecisionEntry(candidate)) {
    throw new Error("recordDecision: decision entry does not match the persisted schema");
  }
  const apply = (current: CtoState): void => {
    const decisions = current.decisions ?? [];
    if (decisions.length >= MAX_PERSISTED_STATE_ARRAY) {
      throw new Error(`recordDecision: decisions exceeds ${MAX_PERSISTED_STATE_ARRAY} entries`);
    }
    current.decisions = [...decisions, candidate as DecisionMemoryEntry];
  };
  apply(state);
  return state;
}

/** Tag-based exact decision recall, newest first. */
export function recallDecisions(
  state: CtoState,
  opts: { tags?: string[]; by?: string; limit?: number } = {},
): DecisionMemoryEntry[] {
  const tags = opts.tags?.length ? opts.tags : undefined;
  const by = opts.by;
  const matched = (state.decisions ?? []).filter((entry) => {
    if (tags) {
      for (const tag of tags) if (!entry.tags.includes(tag)) return false;
    }
    return by === undefined || entry.by === by;
  });
  matched.sort((a, b) => {
    const diff = Date.parse(b.at) - Date.parse(a.at);
    if (diff !== 0 || Number.isNaN(diff)) {
      if (!Number.isNaN(diff)) return diff;
      return b.at < a.at ? -1 : b.at > a.at ? 1 : 0;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
  return (limit === undefined ? matched : matched.slice(0, limit)).map((entry) => ({ ...entry }));
}

/** Deterministic human-readable decision projection. */
export function decisionsToMarkdown(state: CtoState): string {
  const entries = recallDecisions(state);
  const lines = ["## Decisions"];
  if (entries.length === 0) {
    lines.push("", "_No decisions recorded._");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push("", `### ${entry.id}`, `- at: ${entry.at}`, `- by: ${entry.by}`);
    lines.push(`- tags: ${entry.tags.join(", ") || "(none)"}`);
    if (entry.refs && entry.refs.length > 0) lines.push(`- refs: ${entry.refs.join(", ")}`);
    lines.push(`- decision: ${entry.decision}`, `- why: ${entry.why}`);
  }
  return lines.join("\n");
}

// ── CTO specification preparation decisions (T105) ──────────────────────────

const SPECIFICATION_PHASE_ORDER: Readonly<Record<WorkspacePhase, number>> = {
  specify: 0,
  plan: 1,
  tasks: 2,
};
const SPECIFICATION_PHASE_CHECKPOINT = "specification_phase_approval";

export type CtoSpecificationDecisionValue = SpecificationPhaseDecisionValue;

export interface CtoSpecificationDecision {
  feature_id: string;
  run_key: string;
  phase: WorkspacePhase;
  decision: CtoSpecificationDecisionValue;
  /** Exact `checkpoint.<phase>.v<version>` currently open in the workspace. */
  checkpoint_ref: string;
  trusted_answer_ref: string;
  trusted_proof: CheckpointAnswerProof;
}

export interface CtoSpecificationDecisionsFile {
  schema_version: 1;
  cto_run_id: string;
  decisions: CtoSpecificationDecision[];
}

export interface CtoSpecificationDecisionsResult {
  decisions: CtoSpecificationDecision[];
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedStringIssue(value: unknown, label: string): string | null {
  if (!isNonBlankString(value)) return `${label} must be a non-blank string`;
  return Buffer.byteLength(value, "utf8") > MAX_CTO_SPECIFICATION_TEXT_BYTES
    ? `${label} exceeds the safe input limit`
    : null;
}

const PROOF_FIELDS = ["answer_id", "nonce", "channel", "reference", "binding", "feedback"] as const;

function proofIssues(proof: unknown, label: string): string[] {
  if (!isPlainObject(proof)) return [`${label} must be an object`];
  const issues: string[] = [];
  let proofBytes = 0;
  for (const key of Object.keys(proof)) {
    if (!(PROOF_FIELDS as readonly string[]).includes(key)) issues.push(`${label}.${key} is not allowed`);
  }
  for (const field of ["answer_id", "nonce", "reference", "binding"] as const) {
    const issue = boundedStringIssue(proof[field], `${label}.${field}`);
    if (issue) issues.push(issue);
    else proofBytes += Buffer.byteLength(proof[field] as string, "utf8");
  }
  if (proof.feedback !== undefined && (typeof proof.feedback !== "string" || proof.feedback.length === 0 || proof.feedback !== proof.feedback.trim() || Buffer.byteLength(proof.feedback, "utf8") > MAX_CTO_SPECIFICATION_TEXT_BYTES || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(proof.feedback))) {
    issues.push(`${label}.feedback must be bounded non-empty canonical single-line text`);
  } else if (typeof proof.feedback === "string") {
    proofBytes += Buffer.byteLength(proof.feedback, "utf8");
  }
  if (proofBytes > MAX_CTO_SPECIFICATION_PROOF_BYTES) {
    issues.push(`${label} exceeds the ${MAX_CTO_SPECIFICATION_PROOF_BYTES}-byte limit`);
  }
  if (proof.channel !== "terminal" && proof.channel !== "escalation") {
    issues.push(`${label}.channel must be "terminal" | "escalation"`);
  }
  return issues;
}

function validatedDecision(entry: unknown, label: string): CtoSpecificationDecision {
  if (!isPlainObject(entry)) throw new Error(`CTO_SPEC_DECISION_INVALID: ${label} must be an object`);
  if (!isSafeFeatureId(entry.feature_id)) {
    throw new Error(`CTO_SPEC_DECISION_INVALID: ${label}.feature_id is not a canonical safe feature id`);
  }
  const runKeyIssue = boundedStringIssue(entry.run_key, `${label}.run_key`);
  if (runKeyIssue || entry.run_key === "." || entry.run_key === ".." || (typeof entry.run_key === "string" && !/^[A-Za-z0-9._-]+$/.test(entry.run_key))) {
    throw new Error(`CTO_SPEC_DECISION_INVALID: ${runKeyIssue ?? `${label}.run_key must be a canonical safe state segment`}`);
  }
  if (entry.phase !== "specify" && entry.phase !== "plan" && entry.phase !== "tasks") {
    throw new Error(`CTO_SPEC_DECISION_INVALID: ${label}.phase must be specify | plan | tasks`);
  }
  if (entry.decision !== "approve_continue" && entry.decision !== "request_changes" && entry.decision !== "approve_stop") {
    throw new Error(`CTO_SPEC_DECISION_INVALID: ${label}.decision must be approve_continue | request_changes | approve_stop`);
  }
  const checkpointIssue = boundedStringIssue(entry.checkpoint_ref, `${label}.checkpoint_ref`);
  if (checkpointIssue) throw new Error(`CTO_SPEC_DECISION_INVALID: ${checkpointIssue}`);
  const answerRefIssue = boundedStringIssue(entry.trusted_answer_ref, `${label}.trusted_answer_ref`);
  if (answerRefIssue) throw new Error(`CTO_SPEC_DECISION_INVALID: ${answerRefIssue}`);
  const problems = proofIssues(entry.trusted_proof, `${label}.trusted_proof`);
  if (problems.length > 0) throw new Error(`CTO_SPEC_PROOF_INVALID: ${problems.join("; ")}`);
  const proof = entry.trusted_proof as CheckpointAnswerProof;
  if (proof.answer_id !== entry.trusted_answer_ref) {
    throw new Error(`CTO_SPEC_PROOF_INVALID: ${label}.trusted_proof.answer_id does not equal trusted_answer_ref`);
  }
  if (entry.decision === "request_changes" && typeof proof.feedback !== "string") {
    throw new Error(`CTO_SPEC_PROOF_INVALID: ${label}.request_changes requires trusted proof feedback`);
  }
  if (entry.decision !== "request_changes" && proof.feedback !== undefined) {
    throw new Error(`CTO_SPEC_PROOF_INVALID: ${label}.feedback is only valid for request_changes`);
  }
  return {
    feature_id: entry.feature_id,
    run_key: entry.run_key as string,
    phase: entry.phase,
    decision: entry.decision,
    checkpoint_ref: entry.checkpoint_ref as string,
    trusted_answer_ref: entry.trusted_answer_ref as string,
    trusted_proof: {
      answer_id: proof.answer_id,
      nonce: proof.nonce,
      channel: proof.channel,
      reference: proof.reference,
      binding: proof.binding,
      ...(proof.feedback !== undefined ? { feedback: proof.feedback } : {}),
    },
  };
}

function decisionBytes(decision: CtoSpecificationDecision): number {
  return Buffer.byteLength(decision.feature_id, "utf8")
    + Buffer.byteLength(decision.run_key, "utf8")
    + Buffer.byteLength(decision.phase, "utf8")
    + Buffer.byteLength(decision.decision, "utf8")
    + Buffer.byteLength(decision.checkpoint_ref, "utf8")
    + Buffer.byteLength(decision.trusted_answer_ref, "utf8")
    + Buffer.byteLength(decision.trusted_proof.answer_id, "utf8")
    + Buffer.byteLength(decision.trusted_proof.nonce, "utf8")
    + Buffer.byteLength(decision.trusted_proof.channel, "utf8")
    + Buffer.byteLength(decision.trusted_proof.reference, "utf8")
    + Buffer.byteLength(decision.trusted_proof.binding, "utf8")
    + (decision.trusted_proof.feedback === undefined ? 0 : Buffer.byteLength(decision.trusted_proof.feedback, "utf8"));
}
function approvedPhasePostimage(
  phase: WorkspacePhaseRecord | undefined,
  decision: Pick<CtoSpecificationDecision, "phase" | "checkpoint_ref">,
): boolean {
  if (
    !phase
    || phase.status !== "approved"
    || phase.current_version === null
    || !Number.isSafeInteger(phase.current_version)
    || phase.current_version < 1
    || phase.approved_version !== phase.current_version
    || phase.validation_ref !== `validation.${decision.phase}.v${phase.current_version}`
  ) {
    return false;
  }
  return phase.checkpoint_ref === decision.checkpoint_ref
    && decision.checkpoint_ref === `checkpoint.${decision.phase}.v${phase.current_version}`;
}

function validateDecisionBatch(
  entries: unknown[],
  options: { maxEntries: number; maxBytes: number },
  label = "decisions",
): CtoSpecificationDecision[] {
  if (entries.length > options.maxEntries) {
    throw new Error(`CTO_SPEC_DECISION_INVALID: ${label} may contain at most ${options.maxEntries} entries`);
  }
  const validated: CtoSpecificationDecision[] = [];
  let totalBytes = 0;
  for (const [index, entry] of entries.entries()) {
    const decision = validatedDecision(entry, `${label}[${index}]`);
    totalBytes += decisionBytes(decision);
    if (totalBytes > options.maxBytes) {
      throw new Error(`CTO_SPEC_DECISION_INVALID: ${label} exceeds the ${options.maxBytes}-byte limit`);
    }
    validated.push(decision);
  }
  return validated.sort(compareDecisions);
}

function decisionIdentity(decision: CtoSpecificationDecision): string {
  return `${decision.feature_id}\u0000${decision.run_key}\u0000${decision.phase}\u0000${decision.checkpoint_ref}`;
}

function compareDecisions(left: CtoSpecificationDecision, right: CtoSpecificationDecision): number {
  const byFeature = left.feature_id.localeCompare(right.feature_id);
  if (byFeature !== 0) return byFeature;
  const byPhase = SPECIFICATION_PHASE_ORDER[left.phase] - SPECIFICATION_PHASE_ORDER[right.phase];
  if (byPhase !== 0) return byPhase;
  const byRun = left.run_key.localeCompare(right.run_key);
  if (byRun !== 0) return byRun;
  const byCheckpoint = left.checkpoint_ref.localeCompare(right.checkpoint_ref);
  if (byCheckpoint !== 0) return byCheckpoint;
  return left.trusted_answer_ref.localeCompare(right.trusted_answer_ref);
}

function canonicalProjectRoot(projectRoot: string): string {
  if (!isNonBlankString(projectRoot)) {
    throw new Error("CTO_SPEC_DECISION_INVALID: projectRoot must be a non-blank string");
  }
  try {
    const root = realpathSync(resolve(projectRoot));
    if (!lstatSync(root).isDirectory()) throw new Error("not a directory");
    return root;
  } catch (error) {
    throw new Error(`CTO_SPEC_PATH_INVALID: project root is unavailable or unsafe: ${String(error)}`);
  }
}

/** Reject traversal, symlinked ancestors/leaves, and non-regular state files. */
function assertContainedPath(
  root: string,
  candidate: string,
  options: { allowMissing: boolean; regularFile: boolean },
): string {
  const target = resolve(candidate);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`CTO_SPEC_PATH_INVALID: path '${target}' escapes project root '${root}'`);
  }
  let current = root;
  const segments = rel === "" ? [] : rel.split(/[\\/]/);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing) return target;
      throw new Error(`CTO_SPEC_PATH_INVALID: path '${current}' is unavailable: ${String(error)}`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`CTO_SPEC_PATH_INVALID: symlinked state path component '${current}' is forbidden`);
    }
    const leaf = index === segments.length - 1;
    if (leaf && options.regularFile && !stats.isFile()) {
      throw new Error(`CTO_SPEC_PATH_INVALID: state path '${current}' is not a regular file`);
    }
    if (!leaf && !stats.isDirectory()) {
      throw new Error(`CTO_SPEC_PATH_INVALID: state path ancestor '${current}' is not a directory`);
    }
  }
  if (existsSync(target) && realpathSync(target) !== target) {
    throw new Error(`CTO_SPEC_PATH_INVALID: non-canonical state path '${target}' is forbidden`);
  }
  return target;
}

function decodeCanonicalUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`CTO_SPEC_PATH_INVALID: canonical file '${path}' is not valid UTF-8: ${String(error)}`);
  }
}

function readCanonicalFile(root: string, candidate: string, pinnedRoot?: PinnedProjectRoot, maxBytes = DECISION_TRANSACTION_MAX_BYTES): string {
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed before canonical read");
    const relativePath = pinnedRoot.relativePath(candidate);
    if (!relativePath) throw new Error("CTO_SPEC_PATH_INVALID: canonical path escapes pinned project root");
    try {
      const content = decodeCanonicalUtf8(pinnedRoot.readFile(relativePath, { maxBytes }).bytes, candidate);
      if (!pinnedRoot.isStable()) throw new Error("pinned project root changed after canonical read");
      return content;
    } catch (error) {
      throw new Error(`CTO_SPEC_PATH_INVALID: cannot safely read '${candidate}' through the pinned project root: ${String(error)}`);
    }
  }
  const target = assertContainedPath(root, candidate, { allowMissing: false, regularFile: true });
  let fd: number | null = null;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) throw new Error("opened path is not a regular file");
    return decodeCanonicalUtf8(readFileSync(fd), target);
  } catch (error) {
    throw new Error(`CTO_SPEC_PATH_INVALID: cannot safely read '${target}': ${String(error)}`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function specificationDecisionsPath(projectRoot: string, ctoRunId: string, pinnedRoot?: PinnedProjectRoot): string {
  const root = pinnedRoot ? pinnedRoot.canonical_root : canonicalProjectRoot(projectRoot);
  if (!isSafeCtoRunId(ctoRunId)) throw new Error(`CTO_SPEC_RUN_INVALID: unsafe CTO run id ${JSON.stringify(ctoRunId)}`);
  const target = join(ctoStateDir(ctoRunId, root), "specification-decisions.json");
  if (pinnedRoot) {
    if (!pinnedRoot.relativePath(target)) throw new Error("CTO_SPEC_PATH_INVALID: decision path escapes pinned project root");
    return target;
  }
  return assertContainedPath(root, target, { allowMissing: true, regularFile: true });
}
function parseDecisionsFile(raw: string, ctoRunId: string, path: string): CtoSpecificationDecision[] {
  if (Buffer.byteLength(raw, "utf8") > DECISION_TRANSACTION_MAX_BYTES) {
    throw new Error(`CTO_SPEC_DECISIONS_FILE_INVALID: specification decisions at ${path} exceed the ${DECISION_TRANSACTION_MAX_BYTES}-byte limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`CTO_SPEC_DECISIONS_FILE_INVALID: specification decisions at ${path} are unreadable: ${String(error)}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`CTO_SPEC_DECISIONS_FILE_INVALID: specification decisions at ${path} must be an object`);
  if (parsed.schema_version !== 1) throw new Error(`CTO_SPEC_DECISIONS_FILE_INVALID: unsupported schema_version at ${path}`);
  if (parsed.cto_run_id !== ctoRunId) {
    throw new Error(`CTO_SPEC_DECISIONS_RUN_MISMATCH: decisions at ${path} belong to a different CTO run`);
  }
  if (!Array.isArray(parsed.decisions)) throw new Error(`CTO_SPEC_DECISIONS_FILE_INVALID: decisions at ${path} must be an array`);
  return validateDecisionBatch(parsed.decisions, { maxEntries: DECISION_TRANSACTION_MAX_ENTRIES, maxBytes: DECISION_TRANSACTION_MAX_BYTES });
}
function readCtoSpecificationDecisionsUnlocked(projectRoot: string, ctoRunId: string, pinnedRoot?: PinnedProjectRoot): CtoSpecificationDecision[] {
  const root = pinnedRoot ? pinnedRoot.canonical_root : canonicalProjectRoot(projectRoot);
  const path = specificationDecisionsPath(root, ctoRunId, pinnedRoot);
  const pending = readPendingTransactions(root, ctoRunId, pinnedRoot);
  if (pending.length > 0) {
    const transaction = pending[0]!.transaction;
    if (transaction.status === "quarantined") {
      throw new Error(
        `CTO_SPEC_DECISION_QUARANTINED: durable decision transaction '${transaction.transaction_id}' requires manual recovery: ${transaction.quarantine_reason ?? "unknown reason"}`,
      );
    }
    throw new Error(
      `CTO_SPEC_DECISIONS_PENDING: durable decision transaction '${transaction.transaction_id}' must be recovered before decisions can be read`,
    );
  }
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed before decision read");
    const relativePath = pinnedRoot.relativePath(path);
    if (!relativePath) throw new Error("CTO_SPEC_PATH_INVALID: decision path escapes pinned project root");
    if (!pinnedRoot.pathEntryExists(relativePath)) return [];
    const raw = readCanonicalFile(root, path, pinnedRoot);
    if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed after decision read");
    return parseDecisionsFile(raw, ctoRunId, path);
  }
  if (!existsSync(path)) return [];
  return parseDecisionsFile(readCanonicalFile(root, path), ctoRunId, path);
}

export function readCtoSpecificationDecisions(projectRoot: string, ctoRunId: string): CtoSpecificationDecision[] {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) throw new Error("CTO_SPEC_PATH_INVALID: project root cannot be pinned for decision read");
  try {
    if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: project root changed before decision read");
    const root = pinnedRoot.canonical_root;
    return withCtoRunLock(root, ctoRunId, () => readCtoSpecificationDecisionsUnlocked(root, ctoRunId, pinnedRoot), { pinnedRoot });
  } finally {
    pinnedRoot.close();
  }
}

/**
 * Read the authoritative decision ledger while the caller already owns the
 * canonical CTO run lock. Preparation finalization keeps that lock across
 * decision reread, packet construction, and terminal state CAS; calling the
 * public reader there would deadlock on this non-reentrant lock.
 *
 * Internal CTO callers only. The public reader above remains the lock-owning
 * boundary for external callers.
 */
export function readCtoSpecificationDecisionsWhileLocked(
  projectRoot: string,
  ctoRunId: string,
  pinnedRoot: PinnedProjectRoot,
): CtoSpecificationDecision[] {
  if (!pinnedRoot) throw new Error("CTO_SPEC_PATH_INVALID: lock-owned decision read requires a pinned project root");
  const root = pinnedRoot.canonical_root;
  return readCtoSpecificationDecisionsUnlocked(root, ctoRunId, pinnedRoot);
}

/** Record preparation decisions while the caller owns the canonical run lock and root pin. */
export function recordCtoSpecificationDecisionsWhileLocked(
  projectRoot: string,
  input: { cto_run_id: string; decisions: unknown },
  pinnedRoot: PinnedProjectRoot,
): CtoSpecificationDecisionsResult {
  if (!pinnedRoot) throw new Error("CTO_SPEC_PATH_INVALID: lock-owned decision record requires a pinned project root");
  const root = pinnedRoot.canonical_root;
  return recordCtoSpecificationDecisionsUnlocked(root, input, pinnedRoot);
}

/**
 * A decision commit spans one canonical decisions file and one or more
 * feature state files. The transaction record is the write-ahead log for that
 * commit: it is durable before either logical file is changed and is retained
 * until every file can be verified and rewritten idempotently.
 */
interface StagedFeatureState {
  feature_id: string;
  run_key: string;
  /** Stable identity for this transaction's feature mutation. */
  mutation_id: string;
  /** Postimage retained for idempotent commit and exact compensation. */
  state: TeamState;
  /** Exact preimage bytes and parsed state observed before preparation. */
  source_content: string;
  source_state: TeamState;
  source_logical_digest: string;
  /** Durable progress marker used to distinguish committed mutations on recovery. */
  applied: boolean;
  target: {
    statePath: string;
    stateDir: string;
    artifactsDir: string;
    isLegacy: boolean;
  };
  source_digest: string;
  target_digest: string;
  /** Exact central write receipts for the latest staged publication. */
  receipts?: DurableWriteReceipt[];
  /** Ordered receipt sets, including any exact inverse compensation write. */
  receipt_chain?: DurableWriteReceipt[][];
  /** Set before an inverse state publication and retained for crash replay. */
  compensated?: boolean;
}

type SpecificationDecisionTransactionStatus = "pending" | "aborting" | "aborted" | "quarantined";
type SpecificationDecisionAbortReason = "decision_conflict" | "state_conflict";
type SpecificationDecisionTerminalDisposition = "restored" | "removed" | "preserved" | "quarantined";

interface DurableWriteReceipt {
  path: string;
  relative_path: string;
  descriptor: PinnedRootWriteDescriptor;
  preimage: DurableWritePreimage;
}

type DurableWritePreimage =
  | { kind: "absent" }
  | {
      kind: "file";
      bytes_base64: string;
      expectation: { dev: number; ino: number; sha256: string; size?: number };
    };

interface DecisionArtifactBefore {
  disposition: "present" | "absent";
  content: string | null;
  digest: string;
}

interface CtoDecisionConstitutionSnapshot {
  gate_id: string;
  status: ConstitutionGateStatus;
  checkpoint_ref: string | null;
  resume_marker: string | null;
  provider: ConstitutionProviderSelection;
  binding: ConstitutionBinding;
}

interface SpecificationDecisionTransaction {
  schema_version: 1;
  status: SpecificationDecisionTransactionStatus;
  transaction_id: string;
  cto_run_id: string;
  decision_path: string;
  base_decisions_digest: string;
  /** Exact canonical decision artifact observed before this WAL was prepared. */
  decision_before: DecisionArtifactBefore;
  decision_digest: string;
  decision_content: string;
  /** Exact central receipt for the decision artifact postimage. */
  decision_receipt?: DurableWriteReceipt;
  incoming_decisions: CtoSpecificationDecision[];
  decisions: CtoSpecificationDecision[];
  staged_states: StagedFeatureState[];
  /** Set once rollback starts; retained as terminal audit metadata. */
  abort_reason?: SpecificationDecisionAbortReason;
  aborted_at?: string;
  terminal_at?: string;
  terminal_disposition?: SpecificationDecisionTerminalDisposition;
  quarantine_reason?: string;
  /** Exact project constitution gate observed before this pending decision. */
  constitution_snapshot?: CtoDecisionConstitutionSnapshot;
}

/**
 * Test-only failure seam for exercising every durable write boundary. This
 * symbol is intentionally not re-exported from the package root.
 */
export type CtoSpecificationDecisionFailurePoint =
  | "before_prepare"
  | "after_prepare"
  | "before_decisions_write"
  | "before_decision_publish"
  | "after_decisions_write"
  | "before_feature_state_write"
  | "before_feature_state_publish"
  | "after_feature_state_write"
  | "before_abort"
  | "after_abort_prepare"
  | "before_abort_artifact_restore"
  | "after_abort_artifact_restore"
  | "after_abort"
  | "before_terminal_history_remove"
  | "after_commit";

export type CtoSpecificationDecisionFailureInjector = (
  point: CtoSpecificationDecisionFailurePoint,
  transactionId: string,
) => void;

let decisionFailureInjector: CtoSpecificationDecisionFailureInjector | null = null;

export function setCtoSpecificationDecisionFailureInjector(
  injector: CtoSpecificationDecisionFailureInjector | null,
): void {
  decisionFailureInjector = injector;
}

function injectDecisionFailure(
  point: CtoSpecificationDecisionFailurePoint,
  transactionId: string,
): void {
  decisionFailureInjector?.(point, transactionId);
}

function transactionDirectory(root: string, ctoRunId: string, pinnedRoot?: PinnedProjectRoot): string {
  const directory = join(
    ctoStateDir(ctoRunId, root),
    "specification-decision-transactions",
  );
  if (pinnedRoot) {
    if (!pinnedRoot.relativePath(directory)) throw new Error("CTO_SPEC_PATH_INVALID: transaction directory escapes pinned project root");
    return directory;
  }
  const safe = assertContainedPath(root, directory, { allowMissing: true, regularFile: false });
  if (existsSync(safe)) {
    let stats;
    try {
      stats = lstatSync(safe);
    } catch (error) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction directory is unavailable: ${String(error)}`);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction path is not a directory`);
    }
  }
  return safe;
}

function transactionHistoryDirectory(root: string, ctoRunId: string, pinnedRoot?: PinnedProjectRoot): string {
  const directory = join(transactionDirectory(root, ctoRunId, pinnedRoot), "history");
  if (pinnedRoot) {
    if (!pinnedRoot.relativePath(directory)) throw new Error("CTO_SPEC_PATH_INVALID: transaction history directory escapes pinned project root");
    pinnedRoot.ensureDirectories([pinnedRoot.relativePath(directory)!]);
    return directory;
  }
  const safe = assertContainedPath(root, directory, { allowMissing: true, regularFile: false });
  mkdirSync(safe, { recursive: true, mode: 0o700 });
  const stats = lstatSync(safe);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("CTO_SPEC_TRANSACTION_INVALID: transaction history path is not a directory");
  }
  return safe;
}

function historyTransactionPath(root: string, transaction: { cto_run_id: string; transaction_id: string }, pinnedRoot?: PinnedProjectRoot): string {
  const directory = transactionHistoryDirectory(root, transaction.cto_run_id, pinnedRoot);
  const target = join(directory, `${transaction.transaction_id}.json`);
  if (pinnedRoot) {
    if (!/^[A-Za-z0-9._-]+$/.test(transaction.transaction_id) || !pinnedRoot.relativePath(target)) {
      throw new Error("CTO_SPEC_PATH_INVALID: transaction history path escapes pinned project root");
    }
    return target;
  }
  return assertContainedPath(root, target, { allowMissing: true, regularFile: true });
}

function transactionPath(root: string, tx: SpecificationDecisionTransaction | { cto_run_id: string; transaction_id: string }, pinnedRoot?: PinnedProjectRoot): string {
  const directory = transactionDirectory(root, tx.cto_run_id, pinnedRoot);
  const target = join(directory, `${tx.transaction_id}.json`);
  if (pinnedRoot) {
    if (!/^[A-Za-z0-9._-]+$/.test(tx.transaction_id) || !pinnedRoot.relativePath(target)) {
      throw new Error("CTO_SPEC_PATH_INVALID: transaction path escapes pinned project root");
    }
    return target;
  }
  return assertContainedPath(root, target, { allowMissing: true, regularFile: true });
}
function terminalTransaction(status: SpecificationDecisionTransactionStatus): boolean {
  return status === "aborted" || status === "quarantined";
}

interface ExactReadDescriptor {
  path: string;
  relative_path: string;
  dev: number;
  ino: number;
  size: number;
  sha256: string;
}

interface CanonicalRead {
  raw: string;
  descriptor?: ExactReadDescriptor;
}
/** Exact bytes and descriptor observed for a transaction journal entry. */
interface TransactionJournalRead {
  raw: string;
  descriptor?: ExactReadDescriptor;
}
/** Parsed transaction paired with the exact journal bytes read from disk. */
interface PendingTransactionRead {
  transaction: SpecificationDecisionTransaction;
  journal: TransactionJournalRead;
}

function readCanonicalFileWithDescriptor(
  root: string,
  candidate: string,
  pinnedRoot: PinnedProjectRoot | undefined,
  maxBytes = DECISION_TRANSACTION_MAX_BYTES,
): CanonicalRead {
  if (!pinnedRoot) return { raw: readCanonicalFile(root, candidate, undefined, maxBytes) };
  if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed before canonical read");
  const relativePath = pinnedRoot.relativePath(candidate);
  if (!relativePath) throw new Error("CTO_SPEC_PATH_INVALID: canonical path escapes pinned project root");
  try {
    const observed = pinnedRoot.readFile(relativePath, { maxBytes });
    const raw = decodeCanonicalUtf8(observed.bytes, candidate);
    if (!pinnedRoot.isStable()) throw new Error("pinned project root changed after canonical read");
    return {
      raw,
      descriptor: {
        path: observed.path,
        relative_path: relativePath,
        dev: observed.dev,
        ino: observed.ino,
        size: observed.size ?? observed.bytes.byteLength,
        sha256: sha256Hex(raw),
      },
    };
  } catch (error) {
    throw new Error(`CTO_SPEC_PATH_INVALID: cannot safely read '${candidate}' through the pinned project root: ${String(error)}`);
  }
}

function moveTerminalTransaction(
  root: string,
  transaction: SpecificationDecisionTransaction,
  content: string,
  pinnedRoot?: PinnedProjectRoot,
  pendingRead?: ExactReadDescriptor,
): void {
  const pendingPath = transactionPath(root, transaction, pinnedRoot);
  const historyPath = historyTransactionPath(root, transaction, pinnedRoot);
  const remediation = `CTO_SPEC_TRANSACTION_INVALID: terminal transaction '${transaction.transaction_id}' could not be moved to durable history; manual remediation required`;
  if (pinnedRoot) {
    const pendingRelative = pinnedRoot.relativePath(pendingPath);
    const historyRelative = pinnedRoot.relativePath(historyPath);
    if (!pendingRelative || !historyRelative || !pendingRead
      || pendingRead.relative_path !== pendingRelative
      || pendingRead.path !== pinnedRoot.canonical_root + "/" + pendingRelative) throw new Error(remediation);
    let archived = false;
    try {
      // Archive the exact bytes parsed from the descriptor-anchored read.  An
      // exclusive publication never replaces a history entry owned by some
      // other transaction.
      pinnedRoot.writeExclusiveWithReceipt(historyRelative, content);
      archived = true;
    } catch (error) {
      if (!(error instanceof PinnedRootError && error.code === "exists")) throw new Error(`${remediation}: ${String(error)}`);
      let existing: string;
      try { existing = readCanonicalFile(root, historyPath, pinnedRoot, DECISION_TRANSACTION_MAX_FILE_BYTES); }
      catch (readError) { throw new Error(`${remediation}: ${String(readError)}`); }
      if (existing !== content) throw new Error(`${remediation}: history collision for '${transaction.transaction_id}'`);
      archived = true;
    }
    if (!archived) throw new Error(remediation);
    injectDecisionFailure("before_terminal_history_remove", transaction.transaction_id);
    try {
      pinnedRoot.removeFileIfMatches(pendingRelative, {
        dev: pendingRead.dev,
        ino: pendingRead.ino,
        size: pendingRead.size,
        sha256: pendingRead.sha256,
      });
    } catch (error) {
      // A replacement pending transaction must remain pending.  The exact
      // archive is already durable, so this is a successful migration even
      // though the replacement is intentionally left for the next pass.
      if (error instanceof PinnedRootError && (error.code === "changed" || error.code === "not_found")) return;
      throw new Error(`${remediation}: ${String(error)}`);
    }
    return;
  }
  const pendingSafe = assertContainedPath(root, pendingPath, { allowMissing: false, regularFile: true });
  const historySafe = assertContainedPath(root, historyPath, { allowMissing: true, regularFile: true });
  try {
    linkSync(pendingSafe, historySafe);
    unlinkSync(pendingSafe);
  } catch (error) {
    if (!existsSync(historySafe)) throw new Error(`${remediation}: ${String(error)}`);
    let existing: string;
    try { existing = readCanonicalFile(root, historySafe, undefined, DECISION_TRANSACTION_MAX_FILE_BYTES); }
    catch (readError) { throw new Error(`${remediation}: ${String(readError)}`); }
    if (existing !== content) throw new Error(`${remediation}: history collision for '${transaction.transaction_id}'`);
    try { unlinkSync(pendingSafe); } catch (removeError) { throw new Error(`${remediation}: ${String(removeError)}`); }
  }
  fsyncDirectory(root, transactionDirectory(root, transaction.cto_run_id));
  fsyncDirectory(root, transactionHistoryDirectory(root, transaction.cto_run_id));
}

function stateComparable(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const copy = { ...value };
  delete copy.updated_at;
  delete copy.state_revision;
  return copy;
}

function stateDigest(value: unknown): string {
  return sha256Hex(canonicalJson(stateComparable(value)));
}
function decisionTransactionStateError(
  candidate: Record<string, unknown>,
  decisions: readonly CtoSpecificationDecision[],
): string | null {
  const sourceState = isPlainObject(candidate.source_state) ? candidate.source_state : null;
  const targetState = isPlainObject(candidate.state) ? candidate.state : null;
  if (!sourceState || !targetState) return "source or postimage state must be a plain object";
  let sourceContent: unknown;
  try {
    sourceContent = JSON.parse(candidate.source_content as string);
  } catch {
    return "source state content is not valid JSON";
  }
  if (!isPlainObject(sourceContent)
    || stateDigest(sourceContent) !== candidate.source_logical_digest
    || canonicalJson(sourceContent) !== canonicalJson(sourceState)) {
    return "source state content, parsed source state, and source digest disagree";
  }
  if (stateDigest(targetState) !== candidate.target_digest) return "postimage state and target digest disagree";
  const sourceSpecification = isPlainObject(sourceState.specification) ? sourceState.specification : null;
  const targetSpecification = isPlainObject(targetState.specification) ? targetState.specification : null;
  if (
    sourceState.run_key !== candidate.run_key
    || targetState.run_key !== candidate.run_key
    || sourceSpecification?.feature_id !== candidate.feature_id
    || targetSpecification?.feature_id !== candidate.feature_id
  ) {
    return "staged state identity does not match its feature/run";
  }
  const permittedAnswerIds = new Set(
    decisions
      .filter((decision) => decision.feature_id === candidate.feature_id && decision.run_key === candidate.run_key)
      .map((decision) => decision.trusted_answer_ref),
  );
  const sourceAnswers = Array.isArray(sourceState.trusted_checkpoint_answers) ? sourceState.trusted_checkpoint_answers : [];
  const targetAnswers = Array.isArray(targetState.trusted_checkpoint_answers) ? targetState.trusted_checkpoint_answers : [];
  const sourceWithoutAnswers = { ...sourceState };
  const targetWithoutAnswers = { ...targetState };
  delete sourceWithoutAnswers.trusted_checkpoint_answers;
  delete targetWithoutAnswers.trusted_checkpoint_answers;
  if (canonicalJson(sourceWithoutAnswers) !== canonicalJson(targetWithoutAnswers)) return "postimage changed fields outside trusted-answer consumption";
  if (sourceAnswers.length !== targetAnswers.length) return "staged state changed its trusted-answer ledger shape";
  for (let index = 0; index < sourceAnswers.length; index += 1) {
    const sourceAnswer = sourceAnswers[index];
    const targetAnswer = targetAnswers[index];
    if (
      !isPlainObject(sourceAnswer)
      || !isPlainObject(targetAnswer)
      || typeof sourceAnswer.answer_id !== "string"
      || sourceAnswer.answer_id !== targetAnswer.answer_id
    ) return "staged state contains a reordered, replaced, or invalid trusted-answer entry";
    if (canonicalJson(sourceAnswer) === canonicalJson(targetAnswer)) continue;
    if (
      !permittedAnswerIds.has(sourceAnswer.answer_id)
      || sourceAnswer.consumed_at !== undefined
      || typeof targetAnswer.consumed_at !== "string"
      || targetAnswer.consumed_at.trim().length === 0
    ) {
      return "staged state changed an unapproved trusted-answer field";
    }
    const sourceWithoutConsumption = { ...sourceAnswer };
    const targetWithoutConsumption = { ...targetAnswer };
    delete sourceWithoutConsumption.consumed_at;
    delete targetWithoutConsumption.consumed_at;
    if (canonicalJson(sourceWithoutConsumption) !== canonicalJson(targetWithoutConsumption)) {
      return "staged state changed trusted-answer fields beyond consumption";
    }
  }
  return null;
}


function readOptionalCanonicalFile(root: string, candidate: string, pinnedRoot?: PinnedProjectRoot): string | null {
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed while reading decision artifact");
    const relativePath = pinnedRoot.relativePath(candidate);
    if (!relativePath) throw new Error("CTO_SPEC_PATH_INVALID: decision artifact escapes pinned project root");
    if (!pinnedRoot.pathEntryExists(relativePath)) return null;
    return readCanonicalFile(root, candidate, pinnedRoot);
  }
  const target = assertContainedPath(root, candidate, { allowMissing: true, regularFile: true });
  try {
    lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`CTO_SPEC_PATH_INVALID: cannot safely inspect ${JSON.stringify(target)}: ${String(error)}`);
  }
  return readCanonicalFile(root, target);
}

function currentCanonicalDigest(root: string, path: string, pinnedRoot?: PinnedProjectRoot): string {
  const content = readOptionalCanonicalFile(root, path, pinnedRoot);
  return sha256Hex(content ?? "");
}

function fsyncDirectory(root: string, candidate: string): void {
  const directory = assertContainedPath(root, candidate, { allowMissing: false, regularFile: false });
  let fd: number | null = null;
  try {
    if (!lstatSync(directory).isDirectory()) throw new Error("not a directory");
    fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      fsyncSync(fd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;


      if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
    }
  } catch (error) {
    throw new Error(`CTO_SPEC_TRANSACTION_DURABILITY_FAILED: cannot fsync directory ${JSON.stringify(directory)}: ${String(error)}`);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* preserve durability result */ }
    }
  }
}
const DURABLE_RECEIPT_KEYS = new Set(["path", "relative_path", "descriptor", "preimage"]);
const DURABLE_DESCRIPTOR_KEYS = new Set(["path", "relative_path", "dev", "ino", "size", "sha256"]);
const DURABLE_FILE_PREIMAGE_KEYS = new Set(["kind", "bytes_base64", "expectation"]);
const DURABLE_PREIMAGE_EXPECTATION_KEYS = new Set(["dev", "ino", "sha256", "size"]);

function durableWriteReceipt(receipt: PinnedRootWriteReceipt): DurableWriteReceipt {
  const preimage = receipt.preimage.kind === "absent"
    ? { kind: "absent" as const }
    : {
        kind: "file" as const,
        bytes_base64: Buffer.from(receipt.preimage.bytes).toString("base64"),
        expectation: { ...receipt.preimage.expectation },
      };
  return {
    path: receipt.path,
    relative_path: receipt.relative_path,
    descriptor: { ...receipt.descriptor },
    preimage,
  };
}

function validReceiptIdentity(value: unknown): value is { dev: number; ino: number; size: number; sha256: string } {
  return isPlainObject(value)
    && Number.isSafeInteger(value.dev) && (value.dev as number) >= 0
    && Number.isSafeInteger(value.ino) && (value.ino as number) >= 0
    && Number.isSafeInteger(value.size) && (value.size as number) >= 0
    && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);
}

function parseDurableReceipt(
  value: unknown,
  root: string,
  expectedPath?: string,
): DurableWriteReceipt | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || !exactTransactionKeys(value, DURABLE_RECEIPT_KEYS)
    || typeof value.path !== "string" || typeof value.relative_path !== "string"
    || !isPlainObject(value.descriptor) || !exactTransactionKeys(value.descriptor, DURABLE_DESCRIPTOR_KEYS)
    || !isPlainObject(value.preimage)) {
    throw new Error("invalid durable write receipt shape");
  }
  const path = resolve(value.path);
  const relativePath = relative(root, path);
  if (path !== value.path || relativePath.startsWith("..") || isAbsolute(relativePath)
    || relativePath !== value.relative_path || (expectedPath !== undefined && path !== expectedPath)) {
    throw new Error("durable write receipt path is outside its transaction root");
  }
  const descriptor = value.descriptor as Record<string, unknown>;
  if (descriptor.path !== path || descriptor.relative_path !== relativePath || !validReceiptIdentity(descriptor)) {
    throw new Error("durable write receipt descriptor is invalid");
  }
  const descriptorIdentity = descriptor as { path: string; relative_path: string; dev: number; ino: number; size: number; sha256: string };
  const preimage = value.preimage as Record<string, unknown>;
  let durablePreimage: DurableWritePreimage;
  if (preimage.kind === "absent" && Object.keys(preimage).length === 1) {
    durablePreimage = { kind: "absent" };
  } else if (preimage.kind === "file" && exactTransactionKeys(preimage, DURABLE_FILE_PREIMAGE_KEYS)
    && typeof preimage.bytes_base64 === "string"
    && /^[A-Za-z0-9+/]*={0,2}$/.test(preimage.bytes_base64)
    && isPlainObject(preimage.expectation)
    && exactTransactionKeys(preimage.expectation, DURABLE_PREIMAGE_EXPECTATION_KEYS)
    && validReceiptIdentity({ ...(preimage.expectation as Record<string, unknown>), size: Buffer.byteLength(Buffer.from(preimage.bytes_base64, "base64")) })) {
    const bytes = Buffer.from(preimage.bytes_base64, "base64");
    const expectation = preimage.expectation as { dev: number; ino: number; sha256: string; size?: number };
    if (bytes.toString("base64") !== preimage.bytes_base64
      || createHash("sha256").update(bytes).digest("hex") !== expectation.sha256
      || bytes.byteLength > DECISION_TRANSACTION_MAX_STAGED_BYTES) {
      throw new Error("durable write receipt preimage bytes are invalid");
    }
    durablePreimage = {
      kind: "file",
      bytes_base64: preimage.bytes_base64,
      expectation: { dev: expectation.dev, ino: expectation.ino, sha256: expectation.sha256, ...(expectation.size !== undefined ? { size: expectation.size } : {}) },
    };
  } else {
    throw new Error("durable write receipt preimage is invalid");
  }
  if (descriptorIdentity.size > DECISION_TRANSACTION_MAX_STAGED_BYTES
    || descriptorIdentity.size < 0) {
    throw new Error("durable write receipt descriptor size is invalid");
  }
  return {
    path: value.path,
    relative_path: value.relative_path,
    descriptor: {
      path: descriptorIdentity.path,
      relative_path: descriptorIdentity.relative_path,
      dev: descriptorIdentity.dev,
      ino: descriptorIdentity.ino,
      size: descriptorIdentity.size,
      sha256: descriptorIdentity.sha256,
    },
    preimage: durablePreimage,
  };
}

function rehydrateDurableReceipt(
  pinnedRoot: PinnedProjectRoot,
  receipt: DurableWriteReceipt,
): PinnedRootWriteReceipt {
  const preimage: PinnedRootWritePreimage = receipt.preimage.kind === "absent"
    ? { kind: "absent" }
    : {
        kind: "file",
        bytes: Buffer.from(receipt.preimage.bytes_base64, "base64"),
        expectation: { ...receipt.preimage.expectation },
      };
  const runtime: PinnedRootWriteReceipt = {
    path: receipt.path,
    relative_path: receipt.relative_path,
    descriptor: receipt.descriptor,
    preimage,
    rollback: () => rollbackPinnedRootWriteReceipt(pinnedRoot, runtime),
  };
  return runtime;
}

function parseTransaction(
  root: string,
  raw: string,
  path: string,
  ctoRunId: string,
  transactionId: string,
  pinnedRoot?: PinnedProjectRoot,
): SpecificationDecisionTransaction {
  if (Buffer.byteLength(raw, "utf8") > DECISION_TRANSACTION_MAX_FILE_BYTES) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction at ${path} exceeds its ${DECISION_TRANSACTION_MAX_FILE_BYTES}-byte limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction at ${path} is unreadable: ${String(error)}`);
  }
  if (!boundedTransactionJson(parsed, 0, { nodes: 0 })) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction at ${path} exceeds JSON depth, node, key, array, or string bounds`);
  }
  if (!exactTransactionKeys(parsed, DECISION_TRANSACTION_REQUIRED_KEYS, DECISION_TRANSACTION_OPTIONAL_KEYS)
    || parsed.schema_version !== 1) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction at ${path} has an unsupported schema or unknown fields`);
  }
  if (parsed.transaction_id !== transactionId || parsed.cto_run_id !== ctoRunId
    || typeof parsed.transaction_id !== "string"
    || !/^[A-Za-z0-9._-]+$/.test(parsed.transaction_id)
    || !isSafeCtoRunId(parsed.cto_run_id)) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction identity does not match its path`);
  }
  const status = parsed.status;
  if (status !== "pending" && status !== "aborting" && status !== "aborted" && status !== "quarantined") {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction.status is invalid`);
  }
  if (
    typeof parsed.decision_path !== "string"
    || Buffer.byteLength(parsed.decision_path, "utf8") > MAX_CTO_SPECIFICATION_TEXT_BYTES
    || parsed.decision_path !== specificationDecisionsPath(root, ctoRunId, pinnedRoot)
    || typeof parsed.decision_content !== "string"
    || Buffer.byteLength(parsed.decision_content, "utf8") > MAX_CTO_SPECIFICATION_DECISION_BATCH_BYTES
    || !Array.isArray(parsed.incoming_decisions)
    || parsed.incoming_decisions.length > MAX_CTO_SPECIFICATION_DECISIONS
    || !Array.isArray(parsed.decisions)
    || parsed.decisions.length > MAX_CTO_SPECIFICATION_DECISIONS
    || !Array.isArray(parsed.staged_states)
  ) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction at ${path} is incomplete or exceeds its count bounds`);
  }
  const stagedPreflightError = stagedStatePreflightError(parsed.staged_states);
  if (stagedPreflightError) throw new Error(`CTO_SPEC_TRANSACTION_INVALID: ${stagedPreflightError}`);
  const digestFields = ["base_decisions_digest", "decision_digest"] as const;
  for (const field of digestFields) {
    if (typeof parsed[field] !== "string" || !/^[a-f0-9]{64}$/.test(parsed[field])) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction.${field} is not a SHA-256 digest`);
    }
  }
  const decisionBefore = parsed.decision_before;
  if (!exactTransactionKeys(decisionBefore, DECISION_BEFORE_KEYS)) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction.decision_before is invalid`);
  }
  const beforeDisposition = decisionBefore.disposition;
  const beforeContent = decisionBefore.content;
  const beforeDigest = decisionBefore.digest;
  if ((beforeDisposition !== "present" && beforeDisposition !== "absent")
    || (beforeDisposition === "present" && typeof beforeContent !== "string")
    || (beforeDisposition === "present" && typeof beforeContent === "string" && Buffer.byteLength(beforeContent, "utf8") > DECISION_TRANSACTION_MAX_BYTES)
    || (beforeDisposition === "absent" && beforeContent !== null)
    || typeof beforeDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(typeof beforeDigest === "string" ? beforeDigest : "")
    || (typeof beforeContent === "string" && typeof beforeDigest === "string" && sha256Hex(beforeContent) !== beforeDigest)
    || (beforeContent === null && beforeDigest !== sha256Hex(""))
    || beforeDigest !== parsed.base_decisions_digest
  ) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction.decision_before is invalid`);
  }
  let decisionReceipt: DurableWriteReceipt | undefined;
  try {
    decisionReceipt = parseDurableReceipt(parsed.decision_receipt, root, parsed.decision_path as string);
  } catch (error) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction.decision_receipt is invalid: ${String(error)}`);
  }
  if (decisionReceipt !== undefined) {
    if (decisionReceipt.descriptor.sha256 !== parsed.decision_digest
      || decisionReceipt.descriptor.size !== Buffer.byteLength(parsed.decision_content as string, "utf8")) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction.decision_receipt does not describe its decision postimage`);
    }
    if (beforeContent === null) {
      if (decisionReceipt.preimage.kind !== "absent") throw new Error(`CTO_SPEC_TRANSACTION_INVALID: decision receipt preimage must be absent`);
    } else if (decisionReceipt.preimage.kind !== "file"
      || Buffer.from(decisionReceipt.preimage.bytes_base64, "base64").toString("utf8") !== beforeContent
      || decisionReceipt.preimage.expectation.sha256 !== beforeDigest) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: decision receipt preimage disagrees with decision_before`);
    }
  }
  if (status === "pending" && (parsed.abort_reason !== undefined || parsed.aborted_at !== undefined || parsed.terminal_at !== undefined || parsed.terminal_disposition !== undefined)) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: pending transaction cannot carry abort metadata`);
  }
  if (status !== "pending" && (parsed.abort_reason !== "decision_conflict" && parsed.abort_reason !== "state_conflict"
    || typeof parsed.aborted_at !== "string"
    || parsed.aborted_at.trim().length === 0
    || Buffer.byteLength(parsed.aborted_at, "utf8") > MAX_CTO_SPECIFICATION_TEXT_BYTES)) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: aborting or terminal transaction requires typed abort metadata`);
  }
  if ((status === "aborted" || status === "quarantined")
    && (typeof parsed.terminal_at !== "string"
      || parsed.terminal_at.trim().length === 0
      || Buffer.byteLength(parsed.terminal_at, "utf8") > MAX_CTO_SPECIFICATION_TEXT_BYTES
      || (parsed.terminal_disposition !== "restored" && parsed.terminal_disposition !== "removed" && parsed.terminal_disposition !== "preserved" && parsed.terminal_disposition !== "quarantined"))) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: terminal transaction requires disposition and timestamp`);
  }
  if (parsed.quarantine_reason !== undefined
    && (typeof parsed.quarantine_reason !== "string" || Buffer.byteLength(parsed.quarantine_reason, "utf8") > MAX_CTO_SPECIFICATION_TEXT_BYTES)) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction quarantine reason is invalid`);
  }
  if (parsed.constitution_snapshot !== undefined && !validCtoDecisionConstitutionSnapshot(parsed.constitution_snapshot)) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction constitution snapshot is invalid`);
  }
  const incoming = validateDecisionBatch(parsed.incoming_decisions, { maxEntries: MAX_CTO_SPECIFICATION_DECISIONS, maxBytes: MAX_CTO_SPECIFICATION_DECISION_BATCH_BYTES }, "transaction.incoming_decisions");
  const decisions = validateDecisionBatch(parsed.decisions, { maxEntries: MAX_CTO_SPECIFICATION_DECISIONS, maxBytes: MAX_CTO_SPECIFICATION_DECISION_BATCH_BYTES }, "transaction.decisions");
  if (sha256Hex(parsed.decision_content) !== parsed.decision_digest) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction decision content digest does not match`);
  }
  const parsedDecisions = parseDecisionsFile(parsed.decision_content, ctoRunId, path);
  if (canonicalJson(parsedDecisions) !== canonicalJson(decisions)) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction decision content does not match its decisions`);
  }
  const stagedStates: StagedFeatureState[] = [];
  for (const [index, candidate] of parsed.staged_states.entries()) {
    if (!isPlainObject(candidate) || !isPlainObject(candidate.target) || !isPlainObject(candidate.state)) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction.staged_states[${index}] is incomplete`);
    }
    if (
      !isNonBlankString(candidate.feature_id)
      || !isSafeFeatureId(candidate.feature_id)
      || !isNonBlankString(candidate.run_key)
      || candidate.run_key === "."
      || candidate.run_key === ".."
      || !/^[A-Za-z0-9._-]+$/.test(candidate.run_key)
      || typeof candidate.mutation_id !== "string"
      || candidate.mutation_id !== `${transactionId}:${candidate.feature_id}:${candidate.run_key}`
      || typeof candidate.source_content !== "string"
      || typeof candidate.source_state !== "object"
      || candidate.source_state === null
      || Array.isArray(candidate.source_state)
      || typeof candidate.applied !== "boolean"
      || typeof candidate.source_digest !== "string"
      || !/^[a-f0-9]{64}$/.test(candidate.source_digest)
      || sha256Hex(candidate.source_content) !== candidate.source_digest
      || typeof candidate.target_digest !== "string"
      || !/^[a-f0-9]{64}$/.test(candidate.target_digest)
      || typeof candidate.target.statePath !== "string"
      || typeof candidate.target.stateDir !== "string"
      || typeof candidate.target.artifactsDir !== "string"
      || typeof candidate.target.isLegacy !== "boolean"
    ) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction.staged_states[${index}] has invalid identity or digests`);
    }
    const expectedStatePath = featureStatePath(root, candidate.feature_id);
    const expectedStateDir = dirname(expectedStatePath);
    const expectedArtifactsDir = join(expectedStateDir, "artifacts");
    if (
      candidate.target.statePath !== expectedStatePath
      || candidate.target.stateDir !== expectedStateDir
      || candidate.target.artifactsDir !== expectedArtifactsDir
      || candidate.target.isLegacy
    ) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction state target is not the canonical feature state path`);
    }
    const transitionError = decisionTransactionStateError(candidate, decisions);
    if (transitionError) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction.staged_states[${index}] ${transitionError}`);
    }
    const statePath = assertContainedPath(root, candidate.target.statePath as string, { allowMissing: false, regularFile: true });
    const stateDir = assertContainedPath(root, candidate.target.stateDir as string, { allowMissing: false, regularFile: false });
    const artifactsDir = assertContainedPath(root, candidate.target.artifactsDir as string, { allowMissing: true, regularFile: false });
    let receipts: DurableWriteReceipt[] | undefined;
    let receiptChain: DurableWriteReceipt[][] | undefined;
    try {
      const allowedPaths = new Set([statePath, join(stateDir, "team-state.md"), join(root, ".work-state", ".active-feature")]);
      const parseReceiptSet = (value: unknown): DurableWriteReceipt[] => {
        if (!Array.isArray(value) || value.length === 0) throw new Error("receipt set must not be empty");
        const parsedReceipts = value.map((receipt) => parseDurableReceipt(receipt, root)!);
        if (parsedReceipts.some((receipt) => !allowedPaths.has(receipt.path))) throw new Error("receipt path is outside the canonical state publication set");
        if (!parsedReceipts.some((receipt) => receipt.path === statePath)) throw new Error("receipt set must include the canonical state path");
        return parsedReceipts;
      };
      if (candidate.receipts !== undefined) receipts = parseReceiptSet(candidate.receipts);
      if (candidate.receipt_chain !== undefined) {
        if (!Array.isArray(candidate.receipt_chain) || candidate.receipt_chain.length === 0) throw new Error("receipt chain must not be empty");
        receiptChain = candidate.receipt_chain.map((batch) => parseReceiptSet(batch));
        if (receipts && canonicalJson(receiptChain.at(-1)) !== canonicalJson(receipts)) throw new Error("latest receipt chain entry disagrees with receipts");
        if (!receipts) receipts = receiptChain.at(-1);
      }
      if (candidate.compensated !== undefined && typeof candidate.compensated !== "boolean") throw new Error("compensated marker is invalid");
    } catch (error) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction.staged_states[${index}].receipts is invalid: ${String(error)}`);
    }
    stagedStates.push({
      feature_id: candidate.feature_id as string,
      run_key: candidate.run_key as string,
      mutation_id: candidate.mutation_id as string,
      state: candidate.state as unknown as TeamState,
      source_content: candidate.source_content as string,
      source_state: candidate.source_state as unknown as TeamState,
      source_logical_digest: candidate.source_logical_digest as string,
      applied: candidate.applied as boolean,
      target: { statePath, stateDir, artifactsDir, isLegacy: false },
      source_digest: candidate.source_digest as string,
      target_digest: candidate.target_digest as string,
      ...(receipts ? { receipts } : {}),
      ...(receiptChain ? { receipt_chain: receiptChain } : {}),
      ...(candidate.compensated !== undefined ? { compensated: candidate.compensated as boolean } : {}),
    });
  }
  return {
    schema_version: 1,
    status: status as SpecificationDecisionTransactionStatus,
    transaction_id: transactionId,
    cto_run_id: ctoRunId,
    decision_path: parsed.decision_path,
    base_decisions_digest: parsed.base_decisions_digest as string,
    decision_before: {
      disposition: decisionBefore.disposition as "present" | "absent",
      content: decisionBefore.content as string | null,
      digest: decisionBefore.digest as string,
    },
    ...(decisionReceipt ? { decision_receipt: decisionReceipt } : {}),
    decision_digest: parsed.decision_digest as string,
    decision_content: parsed.decision_content,
    incoming_decisions: incoming,
    decisions,
    staged_states: stagedStates,
    ...(parsed.constitution_snapshot !== undefined ? { constitution_snapshot: parsed.constitution_snapshot as CtoDecisionConstitutionSnapshot } : {}),
    ...(status !== "pending" ? {
      abort_reason: parsed.abort_reason as SpecificationDecisionAbortReason,
      aborted_at: parsed.aborted_at as string,
      ...(status === "aborted" || status === "quarantined" ? {
        terminal_at: parsed.terminal_at as string,
        terminal_disposition: parsed.terminal_disposition as SpecificationDecisionTerminalDisposition,
        ...(typeof parsed.quarantine_reason === "string" ? { quarantine_reason: parsed.quarantine_reason } : {}),
      } : {}),
    } : {}),
  };
}

const DECISION_TRANSACTION_MAX_ENTRIES = 256;
const DECISION_TRANSACTION_MAX_FILES = 64;
const DECISION_TRANSACTION_MAX_MIGRATION_FILES = DECISION_TRANSACTION_MAX_FILES * 4;
const DECISION_TRANSACTION_MAX_NAME_BYTES = 64 * 1024;
const DECISION_TRANSACTION_MAX_STAGED_STATES = 64;
const DECISION_TRANSACTION_MAX_STAGED_BYTES = 2 * 1024 * 1024;
/**
 * One WAL byte bound is shared by the writer, reader, and anchored cleanup.
 * It covers the bounded staged source/target postimages, the decision content
 * and both decision arrays, the before-image, and JSON/text framing overhead.
 */
const DECISION_TRANSACTION_MAX_FILE_BYTES =
  DECISION_TRANSACTION_MAX_STAGED_BYTES
  + MAX_CTO_SPECIFICATION_DECISION_BATCH_BYTES * 4
  + MAX_CTO_SPECIFICATION_TEXT_BYTES * 128;
const DECISION_TRANSACTION_MAX_TOTAL_BYTES = DECISION_TRANSACTION_MAX_FILE_BYTES * 2;
const DECISION_TRANSACTION_MAX_JSON_DEPTH = 64;
const DECISION_TRANSACTION_MAX_JSON_NODES = 200_000;
const DECISION_TRANSACTION_MAX_JSON_KEYS = 1_024;
const DECISION_TRANSACTION_MAX_JSON_ARRAY = 4_096;
const DECISION_TRANSACTION_MAX_STRING_BYTES = DECISION_TRANSACTION_MAX_FILE_BYTES;
const DECISION_TRANSACTION_MAX_BYTES = MAX_CTO_SPECIFICATION_DECISION_BATCH_BYTES;

const DECISION_TRANSACTION_REQUIRED_KEYS = new Set([
  "schema_version", "status", "transaction_id", "cto_run_id", "decision_path",
  "base_decisions_digest", "decision_before", "decision_digest", "decision_content",
  "incoming_decisions", "decisions", "staged_states",
]);
const DECISION_TRANSACTION_OPTIONAL_KEYS = new Set([
  "decision_receipt", "abort_reason", "aborted_at", "terminal_at", "terminal_disposition", "quarantine_reason", "constitution_snapshot",
]);
const DECISION_BEFORE_KEYS = new Set(["disposition", "content", "digest"]);
const CONSTITUTION_SNAPSHOT_KEYS = new Set([
  "gate_id", "status", "checkpoint_ref", "resume_marker", "provider", "binding",
]);
const CONSTITUTION_PROVIDER_KEYS = new Set([
  "provider_id", "source", "path", "template_ref", "template_hash", "selection_hash", "selected_at",
]);

function validCtoDecisionConstitutionSnapshot(value: unknown): value is CtoDecisionConstitutionSnapshot {
  if (!isPlainObject(value) || !exactTransactionKeys(value, CONSTITUTION_SNAPSHOT_KEYS)
    || typeof value.gate_id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(value.gate_id)
    || (value.status !== "usable" && value.status !== "approved")
    || (value.checkpoint_ref !== null && (typeof value.checkpoint_ref !== "string" || value.checkpoint_ref.length > MAX_CTO_SPECIFICATION_TEXT_BYTES))
    || (value.resume_marker !== null && (typeof value.resume_marker !== "string" || value.resume_marker.length > MAX_CTO_SPECIFICATION_TEXT_BYTES))
    || !isPlainObject(value.provider) || !exactTransactionKeys(value.provider, CONSTITUTION_PROVIDER_KEYS)
    || Object.values(value.provider).some((candidate) => typeof candidate !== "string")
    || !isPlainObject(value.binding) || validateConstitutionBinding(value.binding).length > 0) {
    return false;
  }
  return true;
}
const STAGED_STATE_KEYS = new Set([
  "feature_id", "run_key", "mutation_id", "state", "source_content", "source_state",
  "source_logical_digest", "applied", "target", "source_digest", "target_digest",
]);
const STAGED_STATE_OPTIONAL_KEYS = new Set(["receipts", "receipt_chain", "compensated"]);
const STAGED_TARGET_KEYS = new Set(["statePath", "stateDir", "artifactsDir", "isLegacy"]);

function exactTransactionKeys(value: unknown, required: ReadonlySet<string>, optional = new Set<string>()): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  return keys.every((key) => required.has(key) || optional.has(key))
    && [...required].every((key) => Object.hasOwn(object, key));
}

function boundedTransactionJson(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): boolean {
  if (++budget.nodes > DECISION_TRANSACTION_MAX_JSON_NODES || depth > DECISION_TRANSACTION_MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= DECISION_TRANSACTION_MAX_STRING_BYTES;
  if (Array.isArray(value)) {
    return value.length <= DECISION_TRANSACTION_MAX_JSON_ARRAY
      && value.every((item) => boundedTransactionJson(item, depth + 1, budget));
  }
  if (!value || typeof value !== "object"
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  return keys.length <= DECISION_TRANSACTION_MAX_JSON_KEYS
    && keys.every((key) => Buffer.byteLength(key, "utf8") <= MAX_CTO_SPECIFICATION_TEXT_BYTES)
    && keys.every((key) => boundedTransactionJson(object[key], depth + 1, budget));
}

function stagedStatePreflightError(stagedStates: unknown): string | null {
  if (!Array.isArray(stagedStates)) return "transaction.staged_states must be an array";
  if (stagedStates.length > DECISION_TRANSACTION_MAX_STAGED_STATES) return "transaction.staged_states exceeds its count limit";
  let aggregateBytes: number;
  try {
    aggregateBytes = Buffer.byteLength(JSON.stringify(stagedStates), "utf8");
  } catch (error) {
    return `transaction.staged_states cannot be measured: ${String(error)}`;
  }
  if (aggregateBytes > DECISION_TRANSACTION_MAX_STAGED_BYTES) return "transaction.staged_states exceeds its aggregate byte limit";
  for (const [index, candidate] of stagedStates.entries()) {
    if (!exactTransactionKeys(candidate, STAGED_STATE_KEYS, STAGED_STATE_OPTIONAL_KEYS)
      || !exactTransactionKeys((candidate as Record<string, unknown>).target, STAGED_TARGET_KEYS)) {
      return `transaction.staged_states[${index}] has an invalid shape`;
    }
    const value = candidate as Record<string, unknown>;
    if (value.receipts !== undefined && (!Array.isArray(value.receipts) || value.receipts.length > 8)) {
      return "transaction.staged_states[" + index + "].receipts is invalid";
    }
    if (typeof value.source_content !== "string"
      || Buffer.byteLength(value.source_content, "utf8") > DECISION_TRANSACTION_MAX_STAGED_BYTES
      || typeof value.source_digest !== "string"
      || !/^[a-f0-9]{64}$/.test(value.source_digest)
      || sha256Hex(value.source_content) !== value.source_digest
      || !isPlainObject(value.source_state)
      || typeof value.source_logical_digest !== "string"
      || !/^[a-f0-9]{64}$/.test(value.source_logical_digest)
      || stateDigest(value.source_state) !== value.source_logical_digest
      || !isPlainObject(value.state)
      || typeof value.target_digest !== "string"
      || !/^[a-f0-9]{64}$/.test(value.target_digest)
      || stateDigest(value.state) !== value.target_digest) {
      return `transaction.staged_states[${index}] has inconsistent content or digests`;
    }
  }
  return null;
}

function readPendingTransactions(root: string, ctoRunId: string, pinnedRoot?: PinnedProjectRoot): PendingTransactionRead[] {
  const directory = transactionDirectory(root, ctoRunId, pinnedRoot);
  const rawTransactions: Array<{ transactionId: string; path: string; raw: string; descriptor?: ExactReadDescriptor }> = [];
  let totalBytes = 0;
  const addRawTransaction = (entry: string, path: string, read: CanonicalRead): void => {
    const raw = read.raw;
    const size = Buffer.byteLength(raw, "utf8");
    if (size > DECISION_TRANSACTION_MAX_FILE_BYTES) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: pending transaction '${entry}' exceeds its byte bound`);
    }
    totalBytes += size;
    if (totalBytes > DECISION_TRANSACTION_MAX_TOTAL_BYTES) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: pending transactions exceed their aggregate ${DECISION_TRANSACTION_MAX_TOTAL_BYTES}-byte limit`);
    }
    rawTransactions.push({ transactionId: entry.slice(0, -".json".length), path, raw, descriptor: read.descriptor });
  };
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed before pending transaction read");
    const relativeDirectory = pinnedRoot.relativePath(directory);
    if (!relativeDirectory) throw new Error("CTO_SPEC_PATH_INVALID: transaction directory escapes pinned project root");
    if (!pinnedRoot.pathEntryExists(relativeDirectory)) return [];
    let entries: string[];
    try {
      entries = pinnedRoot.listDirectory(relativeDirectory, {
        maxEntries: DECISION_TRANSACTION_MAX_MIGRATION_FILES,
        maxNameBytes: DECISION_TRANSACTION_MAX_NAME_BYTES,
      });
    } catch (error) {
      throw new Error(`CTO_SPEC_TRANSACTION_INVALID: cannot enumerate pending transactions: ${String(error)}`);
    }
    for (const entry of entries.filter((candidate) => candidate.endsWith(".json")).sort((left, right) => left.localeCompare(right))) {
      const transactionId = entry.slice(0, -".json".length);
      if (!/^[A-Za-z0-9._-]+$/.test(transactionId)) throw new Error("CTO_SPEC_TRANSACTION_INVALID: unsafe pending transaction name");
      const path = join(directory, entry);
      let read: CanonicalRead;
      try { read = readCanonicalFileWithDescriptor(root, path, pinnedRoot, DECISION_TRANSACTION_MAX_FILE_BYTES); }
      catch (error) { throw new Error(`CTO_SPEC_TRANSACTION_INVALID: cannot read pending transaction: ${String(error)}`); }
      addRawTransaction(entry, path, read);
    }
    if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed after pending transaction reads");
  } else {
    if (!existsSync(directory)) return [];
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
      if (entries.length > DECISION_TRANSACTION_MAX_MIGRATION_FILES
        || entries.reduce((total, entry) => total + Buffer.byteLength(entry.name, "utf8"), 0) > DECISION_TRANSACTION_MAX_NAME_BYTES) {
        throw new Error("bounded pending decision transaction enumeration exceeded its migration limit");
      }
      } catch (error) {
        throw new Error(`CTO_SPEC_TRANSACTION_INVALID: cannot enumerate pending transactions: ${String(error)}`);
      }
    for (const entry of entries.filter((candidate) => candidate.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile()) throw new Error(`CTO_SPEC_TRANSACTION_INVALID: pending transaction '${entry.name}' is not a regular file`);
      const transactionId = entry.name.slice(0, -".json".length);
      if (!/^[A-Za-z0-9._-]+$/.test(transactionId)) throw new Error("CTO_SPEC_TRANSACTION_INVALID: unsafe pending transaction name");
      const path = assertContainedPath(root, join(directory, entry.name), { allowMissing: false, regularFile: true });
      let read: CanonicalRead;
      try { read = readCanonicalFileWithDescriptor(root, path, undefined, DECISION_TRANSACTION_MAX_FILE_BYTES); }
      catch (error) { throw new Error(`CTO_SPEC_TRANSACTION_INVALID: cannot read pending transaction: ${String(error)}`); }
      addRawTransaction(entry.name, path, read);
    }
  }
  const parsed = rawTransactions.map(({ transactionId, path, raw }) => parseTransaction(root, raw, path, ctoRunId, transactionId, pinnedRoot));
  const pending: PendingTransactionRead[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const transaction = parsed[index]!;
    const source = rawTransactions[index]!;
    if (terminalTransaction(transaction.status)) {
      moveTerminalTransaction(root, transaction, source.raw, pinnedRoot, source.descriptor);
    } else {
      pending.push({ transaction, journal: { raw: source.raw, descriptor: source.descriptor } });
    }
  }
  if (pending.length > DECISION_TRANSACTION_MAX_FILES) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: active pending transactions exceed ${DECISION_TRANSACTION_MAX_FILES}`);
  }
  return pending;
}

function serializeTransaction(transaction: SpecificationDecisionTransaction): string {
  const content = `${JSON.stringify(transaction, null, 2)}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > DECISION_TRANSACTION_MAX_FILE_BYTES) {
    throw new Error(`CTO_SPEC_TRANSACTION_INVALID: transaction '${transaction.transaction_id}' exceeds its ${DECISION_TRANSACTION_MAX_FILE_BYTES}-byte bound before write`);
  }
  return content;
}

function persistTransaction(
  root: string,
  transaction: SpecificationDecisionTransaction,
  pinnedRoot?: PinnedProjectRoot,
  options: { beforeWrite?: () => void } = {},
): TransactionJournalRead {
  const content = serializeTransaction(transaction);
  const txPath = transactionPath(root, transaction, pinnedRoot);
  let publishedDescriptor: ExactReadDescriptor | undefined;
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed before transaction write");
    const relativePath = pinnedRoot.relativePath(txPath);
    if (!relativePath) throw new Error("CTO_SPEC_PATH_INVALID: transaction path escapes pinned project root");
    options.beforeWrite?.();
    const receipt = pinnedRoot.writeAtomicWithReceipt(relativePath, content);
    publishedDescriptor = {
      path: receipt.descriptor.path,
      relative_path: receipt.descriptor.relative_path,
      dev: receipt.descriptor.dev,
      ino: receipt.descriptor.ino,
      size: receipt.descriptor.size,
      sha256: receipt.descriptor.sha256,
    };
  } else {
    options.beforeWrite?.();
    atomicWriteFile(txPath, content);
  }
  if (terminalTransaction(transaction.status)) {
    moveTerminalTransaction(root, transaction, content, pinnedRoot, publishedDescriptor);
  } else if (!pinnedRoot) {
    // atomicWriteFile fsyncs the file and its parent. Fsyncing the directory
    // as well makes the pending WAL transition durable across a crash.
    fsyncDirectory(root, transactionDirectory(root, transaction.cto_run_id));
  }
  return { raw: content, descriptor: publishedDescriptor };
}

function writeDecisionArtifactPinned(
  pinnedRoot: PinnedProjectRoot,
  decisionPath: string,
  expectedDigest: string,
  content: string,
  beforeWrite?: () => void,
  beforePublish?: (receipt: PinnedRootWriteReceipt) => void,
): PinnedRootWriteReceipt {
  if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed before decisions write");
  const relativePath = pinnedRoot.relativePath(decisionPath);
  if (!relativePath) throw new Error("CTO_SPEC_PATH_INVALID: decision artifact escapes pinned project root");
  let existing: { bytes: Uint8Array; dev: number; ino: number } | null = null;
  try {
    const observed = pinnedRoot.readFile(relativePath, { maxBytes: DECISION_TRANSACTION_MAX_BYTES });
    existing = { bytes: observed.bytes, dev: observed.dev, ino: observed.ino };
  } catch (error) {
    if (!(error instanceof PinnedRootError && error.code === "not_found")) throw error;
  }
  const actualDigest = existing === null ? sha256Hex("") : sha256Hex(decodeCanonicalUtf8(existing.bytes, decisionPath));
  if (actualDigest !== expectedDigest) throw new Error("CTO_SPEC_DECISION_CONFLICT: decision artifact changed before its CAS write");
  beforeWrite?.();
  let receipt: PinnedRootWriteReceipt;
  try {
    if (existing === null) {
      receipt = pinnedRoot.writeExclusiveWithReceipt(relativePath, content, { beforePublish });
    } else {
      receipt = pinnedRoot.replaceFileIfMatchesWithReceipt(
        relativePath,
        { dev: existing.dev, ino: existing.ino, sha256: actualDigest },
        content,
        { beforePublish },
      );
    }
  } catch (error) {
    if (error instanceof PinnedRootError && (error.code === "changed" || error.code === "exists" || error.code === "not_found")) {
      throw new Error("CTO_SPEC_DECISION_CONFLICT: decision artifact changed during its CAS write");
    }
    throw error;
  }
  const written = pinnedRoot.readFile(relativePath, { maxBytes: DECISION_TRANSACTION_MAX_BYTES });
  if (written.dev !== receipt.descriptor.dev || written.ino !== receipt.descriptor.ino
    || written.size !== receipt.descriptor.size
    || sha256Hex(decodeCanonicalUtf8(written.bytes, decisionPath)) !== receipt.descriptor.sha256
    || receipt.descriptor.sha256 !== sha256Hex(content)) {
    throw new Error("CTO_SPEC_DECISION_CONFLICT: decision artifact changed after its CAS write");
  }
  if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed after decisions write");
  return receipt;
}

function removeCanonicalFileIfMatches(
  root: string,
  candidate: string,
  expectedDigest: string,
  pinnedRoot?: PinnedProjectRoot,
  maxBytes = DECISION_TRANSACTION_MAX_BYTES,
  expectedDescriptor?: ExactReadDescriptor,
): boolean {
  const anchor = pinnedRoot ?? PinnedProjectRoot.open(root);
  if (!anchor) throw new Error("CTO_SPEC_PATH_INVALID: project root cannot be pinned for exact cleanup");
  const ownsAnchor = pinnedRoot === undefined;
  try {
    if (!anchor.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed before exact cleanup");
    const relativePath = anchor.relativePath(candidate);
    if (!relativePath) throw new Error("CTO_SPEC_PATH_INVALID: cleanup path escapes pinned project root");
    let observed;
    try {
      observed = anchor.readFile(relativePath, { maxBytes });
    } catch (error) {
      if (error instanceof PinnedRootError && error.code === "not_found") return false;
      throw error;
    }
    const actualDigest = sha256Hex(decodeCanonicalUtf8(observed.bytes, candidate));
    const observedSize = observed.size ?? observed.bytes.byteLength;
    if (expectedDescriptor
      && (observed.path !== expectedDescriptor.path
        || expectedDescriptor.relative_path !== relativePath
        || observed.dev !== expectedDescriptor.dev
        || observed.ino !== expectedDescriptor.ino
        || observedSize !== expectedDescriptor.size
        || actualDigest !== expectedDescriptor.sha256)) return false;
    if (actualDigest !== expectedDigest) return false;
    try {
      anchor.removeFileIfMatches(relativePath, { dev: observed.dev, ino: observed.ino, sha256: actualDigest });
    } catch (error) {
      if (error instanceof PinnedRootError && (error.code === "changed" || error.code === "not_found")) return false;
      throw error;
    }
    if (!anchor.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed after exact cleanup");
    return true;
  } finally {
    if (ownsAnchor) anchor.close();
  }
}

function restoreStagedDecisionArtifact(
  root: string,
  transaction: SpecificationDecisionTransaction,
  pinnedRoot?: PinnedProjectRoot,
): SpecificationDecisionTerminalDisposition {
  const current = readOptionalCanonicalFile(root, transaction.decision_path, pinnedRoot);
  if (current === null) return transaction.decision_before.disposition === "absent" ? "removed" : "preserved";
  const currentDigest = sha256Hex(current);
  if (currentDigest === transaction.decision_before.digest) return "preserved";
  if (currentDigest !== transaction.decision_digest || !transaction.decision_receipt || !pinnedRoot) return "preserved";

  // Roll back only the exact inode central publication assigned to this WAL.
  // Same-byte replacements on a different inode are concurrent winners and
  // must remain untouched; there is intentionally no digest-only fallback.
  const receipt = rehydrateDurableReceipt(pinnedRoot, transaction.decision_receipt);
  const restored = rollbackPinnedRootWriteReceipt(pinnedRoot, receipt);
  if (!restored) return "preserved";
  return transaction.decision_before.disposition === "present" ? "restored" : "removed";
}

function compensateCommittedStates(root: string, transaction: SpecificationDecisionTransaction, pinnedRoot?: PinnedProjectRoot): void {
  if (!pinnedRoot) {
    if (transaction.staged_states.some((staged) => staged.receipts !== undefined)) {
      throw new Error("CTO_SPEC_STATE_COMPENSATION_CONFLICT: exact state receipts require a pinned project root");
    }
    return;
  }
  for (const staged of transaction.staged_states) {
    if (!staged.receipts) continue;
    const latestOwned = latestOwnedStagedReceipts(pinnedRoot, staged);
    const currentIsSource = (snapshot: { raw_hash: string; state: TeamState | null }): boolean =>
      snapshot.raw_hash === staged.source_digest
      || (staged.compensated === true
        && snapshot.state !== null
        && stateDigest(snapshot.state) === stateDigest(staged.source_state)
        && latestOwned !== undefined);
    const compensated = updateStateAtomically<null>(
      root,
      (snapshot) => {
        if (!snapshot.state || !snapshot.target.statePath || resolve(snapshot.target.statePath) !== resolve(staged.target.statePath)) {
          return { op: "fail", code: "state_conflict", error: `feature '${staged.feature_id}' state target is unavailable while compensating` };
        }
        if (currentIsSource(snapshot)) return { op: "discard", value: null };
        if (stateDigest(snapshot.state) !== staged.target_digest || latestOwned === undefined) {
          return { op: "fail", code: "state_conflict", error: `feature '${staged.feature_id}' postimage ownership descriptor no longer matches` };
        }
        // The transaction validator proves that source -> target changed only
        // approved trusted-answer consumption. Restoring source therefore
        // inverses that owned fragment while retaining every unrelated field.
        return { op: "commit", state: staged.source_state, value: null };
      },
      {
        selector: { feature_id: staged.feature_id, run_key: staged.run_key },
        ...(typeof staged.state.branch === "string" ? { branch: staged.state.branch } : {}),
        ...(pinnedRoot ? { pinnedRoot, rootGuard: pinnedRoot } : {}),
        beforePublish: (receipts: readonly PinnedRootWriteReceipt[]) => {
          if (receipts.length === 0) throw new Error("CTO_SPEC_STATE_COMPENSATION_CONFLICT: inverse state publication returned no receipts");
          const durable = receipts.map(durableWriteReceipt);
          staged.receipts = durable;
          staged.receipt_chain = [...(staged.receipt_chain ?? []), durable];
          staged.compensated = true;
          persistTransaction(root, transaction, pinnedRoot);
        },
        captureReceipts: true,
      },
    );
    if (!compensated.ok) throw new Error(`CTO_SPEC_STATE_COMPENSATION_CONFLICT: ${"error" in compensated ? compensated.error : "state compensation failed"}`);
    if (compensated.state && stateDigest(compensated.state) !== stateDigest(staged.source_state)) {
      throw new Error(`CTO_SPEC_STATE_COMPENSATION_CONFLICT: feature '${staged.feature_id}' inverse state did not restore the owned source`);
    }
  }
}

function abortTransaction(
  root: string,
  transaction: SpecificationDecisionTransaction,
  reason: SpecificationDecisionAbortReason,
  pinnedRoot?: PinnedProjectRoot,
): void {
  if (transaction.status === "aborted" || transaction.status === "quarantined") return;

  if (transaction.status !== "aborting") {
    injectDecisionFailure("before_abort", transaction.transaction_id);
    transaction.status = "aborting";
    transaction.abort_reason = reason;
    transaction.aborted_at = new Date().toISOString();
    persistTransaction(root, transaction, pinnedRoot);
    injectDecisionFailure("after_abort_prepare", transaction.transaction_id);
  }

  injectDecisionFailure("before_abort_artifact_restore", transaction.transaction_id);
  let disposition: SpecificationDecisionTerminalDisposition;
  try {
    disposition = restoreStagedDecisionArtifact(root, transaction, pinnedRoot);
    compensateCommittedStates(root, transaction, pinnedRoot);
  } catch (error) {
    transaction.status = "quarantined";
    transaction.abort_reason ??= reason;
    transaction.aborted_at ??= new Date().toISOString();
    transaction.terminal_at = new Date().toISOString();
    transaction.terminal_disposition = "quarantined";
    transaction.quarantine_reason = error instanceof Error ? error.message : String(error);
    persistTransaction(root, transaction, pinnedRoot);
    throw new Error(`CTO_SPEC_DECISION_QUARANTINED: ${transaction.quarantine_reason}`);
  }
  injectDecisionFailure("after_abort_artifact_restore", transaction.transaction_id);

  transaction.status = "aborted";
  transaction.abort_reason ??= reason;
  transaction.aborted_at ??= new Date().toISOString();
  transaction.terminal_at = new Date().toISOString();
  transaction.terminal_disposition = disposition;
  persistTransaction(root, transaction, pinnedRoot);
  injectDecisionFailure("after_abort", transaction.transaction_id);
}

function commitTransaction(
  root: string,
  transaction: SpecificationDecisionTransaction,
  pinnedRoot?: PinnedProjectRoot,
  options: { beforeDecisionWrite?: () => void; journal?: TransactionJournalRead } = {},
): "committed" | "aborted" {
  if (transaction.status === "aborted") return "aborted";
  if (transaction.status === "quarantined") {
    throw new Error(`CTO_SPEC_DECISION_QUARANTINED: ${transaction.quarantine_reason ?? "transaction requires manual recovery"}`);
  }
  if (transaction.status === "aborting") {
    abortTransaction(root, transaction, transaction.abort_reason!, pinnedRoot);
    return "aborted";
  }

  let cleanupJournal: TransactionJournalRead = options.journal ?? { raw: serializeTransaction(transaction) };
  const currentDigest = currentCanonicalDigest(root, transaction.decision_path, pinnedRoot);
  if (currentDigest !== transaction.decision_digest) {
    if (currentDigest !== transaction.base_decisions_digest) {
      abortTransaction(root, transaction, "decision_conflict", pinnedRoot);
      return "aborted";
    }
    injectDecisionFailure("before_decisions_write", transaction.transaction_id);
    if (pinnedRoot) {
      writeDecisionArtifactPinned(
        pinnedRoot,
        transaction.decision_path,
        transaction.base_decisions_digest,
        transaction.decision_content,
        options.beforeDecisionWrite,
        (receipt) => {
          transaction.decision_receipt = durableWriteReceipt(receipt);
          cleanupJournal = persistTransaction(root, transaction, pinnedRoot, { beforeWrite: options.beforeDecisionWrite });
          injectDecisionFailure("before_decision_publish", transaction.transaction_id);
        },
      );
    } else {
      options.beforeDecisionWrite?.();
      atomicWriteFile(transaction.decision_path, transaction.decision_content);
    }
    injectDecisionFailure("after_decisions_write", transaction.transaction_id);
  } else if (pinnedRoot
    && transaction.decision_digest !== transaction.base_decisions_digest
    && (!transaction.decision_receipt || !pinnedReceiptOwnsCurrent(pinnedRoot, transaction.decision_receipt))) {
    abortTransaction(root, transaction, "decision_conflict", pinnedRoot);
    return "aborted";
  }

  for (const staged of transaction.staged_states) {
    injectDecisionFailure("before_feature_state_write", transaction.transaction_id);
    const committed = updateStateAtomically<null>(
      root,
      (snapshot) => {
        if (!snapshot.state || !snapshot.target.statePath || resolve(snapshot.target.statePath) !== resolve(staged.target.statePath)) {
          return { op: "fail", code: "state_conflict", error: `feature '${staged.feature_id}' state target is unavailable` };
        }
        if (snapshot.raw_hash === staged.source_digest) {
          return { op: "commit", state: staged.state, value: null };
        }
        if (stateDigest(snapshot.state) === staged.target_digest) {
          if (!pinnedRoot || !stagedReceiptsOwnCurrent(pinnedRoot, staged)) {
            return { op: "fail", code: "state_conflict", error: `feature '${staged.feature_id}' target matches only by digest without an owned postimage descriptor` };
          }
          return { op: "discard", value: null };
        }
        return {
          op: "fail",
          code: "state_conflict",
          error: `feature '${staged.feature_id}' changed while its decision transaction was pending`,
        };
      },
      {
        selector: { feature_id: staged.feature_id, run_key: staged.run_key },
        ...(typeof staged.state.branch === "string" ? { branch: staged.state.branch } : {}),
        ...(pinnedRoot ? { pinnedRoot, rootGuard: pinnedRoot } : {}),
        ...(options.beforeDecisionWrite ? { preCommit: options.beforeDecisionWrite } : {}),
        ...(pinnedRoot ? {
          captureReceipts: true,
          beforePublish: (receipts: readonly PinnedRootWriteReceipt[]) => {
            if (receipts.length === 0) throw new Error("CTO_SPEC_STATE_COMPENSATION_CONFLICT: state publication returned no receipts");
            const durable = receipts.map(durableWriteReceipt);
            staged.receipts = durable;
            staged.receipt_chain = [...(staged.receipt_chain ?? []), durable];
            cleanupJournal = persistTransaction(root, transaction, pinnedRoot, { beforeWrite: options.beforeDecisionWrite });
            injectDecisionFailure("before_feature_state_publish", transaction.transaction_id);
          },
        } : {}),
      },
    );
    if (!committed.ok) {
      abortTransaction(root, transaction, "state_conflict", pinnedRoot);
      return "aborted";
    }
    injectDecisionFailure("after_feature_state_write", transaction.transaction_id);
    if (!committed.state || stateDigest(committed.state) !== staged.target_digest) {
      abortTransaction(root, transaction, "state_conflict", pinnedRoot);
      return "aborted";
    }
    // Persist mutation ownership after each state write. If a later feature
    // conflicts, recovery can compensate already-applied feature mutations;
    // if a crash occurs before this marker, exact postimage matching still
    // permits safe idempotent compensation.
    staged.applied = true;
    // The exact receipt was already persisted in beforePublish. Rechecking
    // source identity here would mistake a concurrent replacement of the
    // just-published inode for a stale preimage and strand the WAL pending.
    cleanupJournal = persistTransaction(root, transaction, pinnedRoot);
  }

  injectDecisionFailure("after_commit", transaction.transaction_id);
  cleanupPendingTransaction(root, transaction, pinnedRoot, cleanupJournal);
  return "committed";
}

function fullyCommittedExactPostimage(
  root: string,
  transaction: SpecificationDecisionTransaction,
  pinnedRoot?: PinnedProjectRoot,
): boolean {
  if (!pinnedRoot || transaction.status !== "pending" || transaction.staged_states.length === 0 || transaction.staged_states.some((staged) => staged.applied !== true)) return false;
  if (!pinnedRoot.isStable()) return false;
  if (currentCanonicalDigest(root, transaction.decision_path, pinnedRoot) !== transaction.decision_digest) return false;
  if (transaction.decision_digest !== transaction.base_decisions_digest
    && (!transaction.decision_receipt || !pinnedReceiptOwnsCurrent(pinnedRoot, transaction.decision_receipt))) return false;
  for (const staged of transaction.staged_states) {
    if (!stagedReceiptsOwnCurrent(pinnedRoot, staged)) return false;
    try {
      const raw = readCanonicalFile(root, staged.target.statePath, pinnedRoot, MAX_PERSISTED_STATE_BYTES);
      const state = JSON.parse(raw) as unknown;
      if (stateDigest(state) !== staged.target_digest) return false;
    } catch {
      return false;
    }
  }
  return pinnedRoot.isStable();
}

function cleanupPendingTransaction(
  root: string,
  transaction: SpecificationDecisionTransaction,
  pinnedRoot: PinnedProjectRoot | undefined,
  journal: TransactionJournalRead,
): void {
  const txPath = transactionPath(root, transaction, pinnedRoot);
  try {
    if (!removeCanonicalFileIfMatches(root, txPath, sha256Hex(journal.raw), pinnedRoot, DECISION_TRANSACTION_MAX_FILE_BYTES, journal.descriptor)) {
      throw new Error("transaction cleanup target changed before exact removal");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`CTO_SPEC_TRANSACTION_CLEANUP_FAILED: ${String(error)}`);
    }
  }
}

function recoverPendingTransactions(
  root: string,
  ctoRunId: string,
  pinnedRoot?: PinnedProjectRoot,
): SpecificationDecisionTransaction[] {
  const completed: SpecificationDecisionTransaction[] = [];
  for (const { transaction, journal } of readPendingTransactions(root, ctoRunId, pinnedRoot)) {
    if (fullyCommittedExactPostimage(root, transaction, pinnedRoot)) {
      cleanupPendingTransaction(root, transaction, pinnedRoot, journal);
      completed.push(transaction);
      continue;
    }
    const guard = pinnedRoot
      ? () => assertCtoDecisionSourcesCurrent(root, transaction, pinnedRoot)
      : undefined;
    if (commitTransaction(root, transaction, pinnedRoot, { beforeDecisionWrite: guard, journal }) === "committed") completed.push(transaction);
  }
  return completed;
}

function sameCtoDecisionBinding(left: ConstitutionBinding, right: ConstitutionBinding): boolean {
  return left.provider_id === right.provider_id
    && left.path === right.path
    && left.version === right.version
    && left.content_sha256 === right.content_sha256
    && left.semantic_hash === right.semantic_hash
    && left.validation_ref === right.validation_ref;
}

function sameCtoDecisionProvider(left: ConstitutionProviderSelection, right: ConstitutionProviderSelection): boolean {
  return left.provider_id === right.provider_id
    && left.source === right.source
    && left.path === right.path
    && left.template_ref === right.template_ref
    && left.template_hash === right.template_hash
    && left.selection_hash === right.selection_hash;
}

function ctoDecisionProviderBindsSource(
  provider: ConstitutionProviderSelection,
  binding: ConstitutionBinding,
): boolean {
  return provider.provider_id === binding.provider_id && provider.path === binding.path;
}

function constitutionDecisionImpactPending(pinnedRoot: PinnedProjectRoot): boolean {
  const impactDir = ".work-state/specification/constitution";
  if (!pinnedRoot.pathEntryExists(impactDir)) return false;
  return pinnedRoot.listDirectory(impactDir, { maxEntries: 256 }).some(
    (entry) => /^constitution-impact-transaction-[a-f0-9]{64}\.json$/u.test(entry),
  );
}

function captureCtoDecisionConstitutionSnapshot(
  root: string,
  stagedStates: readonly StagedFeatureState[],
  pinnedRoot: PinnedProjectRoot,
): CtoDecisionConstitutionSnapshot {
  if (stagedStates.length === 0) throw new Error("CTO_SPEC_CONSTITUTION_STALE: decision has no selected workspace");
  if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed before decision constitution snapshot");
  const gate = readProjectConstitutionGate(root, pinnedRoot);
  if (!gate.ok) throw new Error(`CTO_SPEC_CONSTITUTION_STALE: ${gate.error}`);
  const current = gate.value;
  if ((current.status !== "usable" && current.status !== "approved") || current.usability_result !== "usable") {
    throw new Error("CTO_SPEC_CONSTITUTION_STALE: constitution gate is not in an approved usable state");
  }
  if (!current.provider || !current.binding || !ctoDecisionProviderBindsSource(current.provider, current.binding)) {
    throw new Error("CTO_SPEC_CONSTITUTION_STALE: constitution gate provider or source binding is missing or mismatched");
  }
  if (constitutionDecisionImpactPending(pinnedRoot)) {
    throw new Error("CTO_SPEC_CONSTITUTION_STALE: constitution impact assessment is unresolved");
  }
  for (const staged of stagedStates) {
    const workspace = staged.source_state.specification;
    const binding = workspace?.constitution_binding;
    if (!binding || validateConstitutionBinding(binding).length > 0 || !workspace?.constitution_gate_ref) {
      throw new Error(`CTO_SPEC_CONSTITUTION_STALE: feature '${staged.feature_id}' has no valid persisted constitution binding`);
    }
    if (!sameCtoDecisionBinding(binding, current.binding)) {
      throw new Error(`CTO_SPEC_CONSTITUTION_STALE: feature '${staged.feature_id}' source binding differs from the current gate`);
    }
    const source = readPinnedCurrentConstitution(root, pinnedRoot, binding, { requireGate: false });
    if (!source.ok) throw new Error(`CTO_SPEC_CONSTITUTION_STALE: ${source.error}`);
  }
  if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed during decision constitution snapshot");
  return {
    gate_id: current.gate_id,
    status: current.status,
    checkpoint_ref: current.checkpoint_ref,
    resume_marker: current.resume_marker,
    provider: { ...current.provider },
    binding: { ...current.binding },
  };
}

function assertCtoDecisionConstitutionCurrent(
  root: string,
  transaction: SpecificationDecisionTransaction,
  pinnedRoot: PinnedProjectRoot,
): void {
  if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed before decision constitution guard");
  if (!transaction.constitution_snapshot) {
    if (transaction.staged_states.length === 0) return;
    throw new Error("CTO_SPEC_CONSTITUTION_STALE: pending decision has no constitution snapshot");
  }
  const expected = transaction.constitution_snapshot;
  const gate = readProjectConstitutionGate(root, pinnedRoot);
  if (!gate.ok) throw new Error(`CTO_SPEC_CONSTITUTION_STALE: ${gate.error}`);
  const current = gate.value;
  if ((current.status !== "usable" && current.status !== "approved") || current.usability_result !== "usable") {
    throw new Error("CTO_SPEC_CONSTITUTION_STALE: constitution gate is not in an approved usable state");
  }
  if (current.gate_id !== expected.gate_id
    || current.status !== expected.status
    || current.checkpoint_ref !== expected.checkpoint_ref
    || current.resume_marker !== expected.resume_marker
    || !current.provider || !sameCtoDecisionProvider(current.provider, expected.provider)
    || !current.binding || !sameCtoDecisionBinding(current.binding, expected.binding)
    || !ctoDecisionProviderBindsSource(current.provider, current.binding)) {
    throw new Error("CTO_SPEC_CONSTITUTION_STALE: constitution gate identity or source binding changed while decision was pending");
  }
  if (constitutionDecisionImpactPending(pinnedRoot)) {
    throw new Error("CTO_SPEC_CONSTITUTION_STALE: constitution impact assessment is unresolved");
  }
  for (const staged of transaction.staged_states) {
    const workspace = staged.source_state.specification;
    const binding = workspace?.constitution_binding;
    if (!binding || validateConstitutionBinding(binding).length > 0 || !workspace?.constitution_gate_ref) {
      throw new Error(`CTO_SPEC_CONSTITUTION_STALE: feature '${staged.feature_id}' has no valid persisted constitution binding`);
    }
    if (!sameCtoDecisionBinding(binding, expected.binding)) {
      throw new Error(`CTO_SPEC_CONSTITUTION_STALE: feature '${staged.feature_id}' source binding changed while decision was pending`);
    }
    const source = readPinnedCurrentConstitution(root, pinnedRoot, binding, { requireGate: false });
    if (!source.ok) throw new Error(`CTO_SPEC_CONSTITUTION_STALE: ${source.error}`);
  }
  if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed during decision constitution guard");
}

function pinnedReceiptOwnsCurrent(pinnedRoot: PinnedProjectRoot, receipt: DurableWriteReceipt): boolean {
  try {
    const observed = pinnedRoot.readFile(receipt.relative_path, { maxBytes: DECISION_TRANSACTION_MAX_STAGED_BYTES });
    return observed.dev === receipt.descriptor.dev
      && observed.ino === receipt.descriptor.ino
      && observed.bytes.byteLength === receipt.descriptor.size
      && sha256Hex(decodeCanonicalUtf8(observed.bytes, receipt.path)) === receipt.descriptor.sha256;
  } catch {
    return false;
  }
}

function stagedReceiptSetOwnsCurrent(
  pinnedRoot: PinnedProjectRoot,
  staged: StagedFeatureState,
  receipts: readonly DurableWriteReceipt[],
): boolean {
  // state.json is the authority; projections such as team-state.md and the
  // shared active-feature pointer may legitimately belong to a later writer.
  const stateReceipt = receipts.find((receipt) => receipt.path === staged.target.statePath);
  return stateReceipt !== undefined && pinnedReceiptOwnsCurrent(pinnedRoot, stateReceipt);
}

function stagedReceiptsOwnCurrent(pinnedRoot: PinnedProjectRoot, staged: StagedFeatureState): boolean {
  return staged.receipts !== undefined && stagedReceiptSetOwnsCurrent(pinnedRoot, staged, staged.receipts);
}

function latestOwnedStagedReceipts(pinnedRoot: PinnedProjectRoot, staged: StagedFeatureState): DurableWriteReceipt[] | undefined {
  const chain = staged.receipt_chain ?? (staged.receipts ? [staged.receipts] : []);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const receipts = chain[index];
    if (receipts && stagedReceiptSetOwnsCurrent(pinnedRoot, staged, receipts)) return receipts;
  }
  return undefined;
}

function assertCtoDecisionSourcesCurrent(
  root: string,
  transaction: SpecificationDecisionTransaction,
  pinnedRoot: PinnedProjectRoot,
): void {
  assertCtoDecisionConstitutionCurrent(root, transaction, pinnedRoot);
  for (const staged of transaction.staged_states) {
    const raw = readCanonicalFile(root, staged.target.statePath, pinnedRoot, MAX_PERSISTED_STATE_BYTES);
    if (sha256Hex(raw) === staged.source_digest) continue;
    let state: TeamState;
    try { state = JSON.parse(raw) as TeamState; } catch { throw new Error(`CTO_SPEC_STATE_CONFLICT: feature '${staged.feature_id}' state is unreadable while its decision was pending`); }
    if (stateDigest(state) !== staged.target_digest || !stagedReceiptsOwnCurrent(pinnedRoot, staged)) {
      throw new Error(`CTO_SPEC_STATE_CONFLICT: feature '${staged.feature_id}' changed without an owned postimage descriptor while its decision transaction was pending`);
    }
  }
}

/**
 * Verify and consume engine-issued phase answers, then persist their exact
 * feature/run/phase/checkpoint decisions. Proof-shaped caller data has no
 * authority without the matching immutable answer ledger record.
 *
 */
function recordCtoSpecificationDecisionsUnlocked(
  projectRoot: string,
  input: { cto_run_id: string; decisions: unknown },
  pinnedRoot?: PinnedProjectRoot,
): CtoSpecificationDecisionsResult {
  const root = pinnedRoot ? pinnedRoot.canonical_root : canonicalProjectRoot(projectRoot);
  if (pinnedRoot && !pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed before decision transaction");
  if (!isPlainObject(input)) throw new Error("CTO_SPEC_DECISION_INVALID: input must be an object");
  const ctoRunId = input.cto_run_id;
  if (!isSafeCtoRunId(ctoRunId)) {
    throw new Error(`CTO_SPEC_RUN_INVALID: unsafe CTO run id ${JSON.stringify(ctoRunId ?? null)}`);
  }
  if (!Array.isArray(input.decisions)) throw new Error("CTO_SPEC_DECISION_INVALID: decisions must be an array");
  const incoming = validateDecisionBatch(input.decisions, { maxEntries: MAX_CTO_SPECIFICATION_DECISIONS, maxBytes: MAX_CTO_SPECIFICATION_DECISION_BATCH_BYTES });

  const recovered = recoverPendingTransactions(root, ctoRunId, pinnedRoot);
  const recoveredRetry = recovered.find(
    (transaction) => canonicalJson(transaction.incoming_decisions) === canonicalJson(incoming),
  );
  if (recoveredRetry) {
    return {
      decisions: recoveredRetry.decisions.map((decision) => ({
        ...decision,
        trusted_proof: { ...decision.trusted_proof },
      })),
    };
  }

  const path = specificationDecisionsPath(root, ctoRunId, pinnedRoot);
  const recordedRaw = readOptionalCanonicalFile(root, path, pinnedRoot);
  const recorded = recordedRaw === null ? [] : parseDecisionsFile(recordedRaw, ctoRunId, path);
  if (incoming.length === 0) {
    return {
      decisions: recorded.map((decision) => ({
        ...decision,
        trusted_proof: { ...decision.trusted_proof },
      })),
    };
  }
  const identities = new Map(recorded.map((decision) => [decisionIdentity(decision), decision]));
  const recordedIdentities = new Set(identities.keys());
  const answerBindings = new Map(recorded.map((decision) => [decision.trusted_answer_ref, decisionIdentity(decision)]));
  const stagedStates = new Map<string, StagedFeatureState>();
  const transactionId = randomUUID();

  for (const decision of incoming) {
    const identity = decisionIdentity(decision);
    const existing = identities.get(identity);
    const replayExisting = existing !== undefined && recordedIdentities.has(identity);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(decision)) {
        throw new Error(`CTO_SPEC_DECISION_CONFLICT: exact feature/run/phase/checkpoint already has a different decision`);
      }
      if (!replayExisting) {
        throw new Error(`CTO_SPEC_PROOF_REPLAYED: trusted answer '${decision.trusted_answer_ref}' was already supplied in this batch`);
      }
    }
    const priorAnswerBinding = answerBindings.get(decision.trusted_answer_ref);
    if (priorAnswerBinding && priorAnswerBinding !== identity) {
      throw new Error(`CTO_SPEC_ANSWER_CONFLICT: trusted answer '${decision.trusted_answer_ref}' is bound to another context`);
    }

    const expectedStatePath = featureStatePath(root, decision.feature_id);
    const source = readCanonicalFile(root, expectedStatePath, pinnedRoot, MAX_PERSISTED_STATE_BYTES);
    const found = pinnedRoot
      ? resolveStatePinned(root, pinnedRoot, { feature_id: decision.feature_id, run_key: decision.run_key })
      : resolveState(root, undefined, {
        feature_id: decision.feature_id,
        run_key: decision.run_key,
      });
    if (
      found.invalid
      || found.isStale
      || found.isLegacy
      || !found.state
      || !found.statePath
      || !found.stateDir
      || !found.artifactsDir
      || resolve(found.statePath) !== resolve(expectedStatePath)
    ) {
      throw new Error(`CTO_SPEC_WORKSPACE_MISMATCH: selected feature/run state is unavailable, foreign, stale, or unsafe`);
    }

    const sourceState = JSON.parse(source) as TeamState;
    const state = stagedStates.get(expectedStatePath)?.state ?? sourceState;
    const workspace = state.specification;
    const phase = workspace?.phases.find((candidate) => candidate.phase === decision.phase);
    if (!workspace || workspace.feature_id !== decision.feature_id || !phase) {
      throw new Error("CTO_SPEC_WORKSPACE_MISMATCH: decision does not match the selected workspace");
    }
    const expectedCheckpoint = `checkpoint.${decision.phase}.v${phase.current_version ?? "none"}`;
    const policy = resolveCheckpointPolicy(
      { id: decision.phase, checkpoint: SPECIFICATION_PHASE_CHECKPOINT },
      state,
    ) ?? nativeCheckpointPolicy("specification_phase_approval");
    const appliedTyped = (state.typed_checkpoint_decisions ?? [])
      .filter((candidate) =>
        candidate.run_id === decision.run_key
        && candidate.stage_id === decision.phase
        && candidate.checkpoint_id === SPECIFICATION_PHASE_CHECKPOINT
        && candidate.feature_id === decision.feature_id
        && candidate.actor.kind === "user"
        && candidate.actor.proof?.answer_id === decision.trusted_answer_ref
        && candidate.decision === decision.decision,
      )
      .sort((left, right) => left.decided_at.localeCompare(right.decided_at))
      .at(-1);
    const appliedAnswer = (state.trusted_checkpoint_answers ?? []).find(
      (candidate) => candidate.answer_id === decision.trusted_answer_ref,
    );
    const selectedAskPostimage = appliedTyped !== undefined && appliedAnswer?.consumed_at !== undefined;
    if (selectedAskPostimage && (!Number.isSafeInteger(appliedAnswer?.subject_revision)
      || (appliedAnswer!.subject_revision as number) < 1
      || (state.state_revision !== undefined && (appliedAnswer!.subject_revision as number) > state.state_revision))) {
      throw new Error("CTO_SPEC_PROOF_INVALID: selected Ask answer subject revision is not a valid current-state predecessor");
    }
    const selectedAskCurrent = selectedAskPostimage
      && appliedTyped!.artifact_version === phase.current_version
      && appliedTyped!.validation_ref === phase.validation_ref
      && (phase.checkpoint_ref === decision.checkpoint_ref
        || (decision.decision === "request_changes" && phase.checkpoint_ref === null))
      && ((decision.decision === "request_changes" && phase.status === "revision_required")
        || (decision.decision !== "request_changes" && phase.status === "approved"));
    const approved = decision.decision === "approve_continue"
      && approvedPhasePostimage(phase, decision);
    if (!approved && selectedAskCurrent) {
      const validated = validateCheckpointDecision(state, appliedTyped!, {
        stage: { id: decision.phase, checkpoint: SPECIFICATION_PHASE_CHECKPOINT },
        policy,
        bindCapability: false,
      });
      if (!validated.ok) throw new Error(`CTO_SPEC_PROOF_INVALID: ${validated.error}`);
      const proofError = trustedCheckpointAnswerError(state, {
        actor: {
          kind: "user",
          ref: decision.trusted_proof.reference,
          proof: decision.trusted_proof,
        },
        run_id: decision.run_key,
        stage_id: decision.phase,
        checkpoint_id: SPECIFICATION_PHASE_CHECKPOINT,
        decision: decision.decision,
        policy_hash: checkpointPolicyHash(policy),
        feature_id: decision.feature_id,
        subject_revision: appliedAnswer!.subject_revision,
        feedback: decision.trusted_proof.feedback,
        bind_active_context: false,
      });
      if (proofError) throw new Error(`CTO_SPEC_PROOF_INVALID: ${proofError}`);
      identities.set(identity, decision);
      answerBindings.set(decision.trusted_answer_ref, identity);
      continue;
    }
    if (
      !approved
      && (
        phase.status !== "awaiting_approval"
        || phase.current_version === null
        || !Number.isInteger(phase.current_version)
        || phase.current_version < 1
      )
    ) {
      throw new Error(`CTO_SPEC_CHECKPOINT_STALE: feature '${decision.feature_id}' phase '${decision.phase}' has no eligible open or approved version`);
    }
    if (
      phase.current_version !== null
      && (decision.checkpoint_ref !== expectedCheckpoint || phase.checkpoint_ref !== expectedCheckpoint)
    ) {
      throw new Error(`CTO_SPEC_CHECKPOINT_STALE: decision checkpoint does not match the exact phase version`);
    }

    let nextState: TeamState = state;
    if (approved) {
      /*
       * Generic workflow_checkpoint + workflow_advance already owns the
       * phase approval and has consumed the answer. The CTO final decision is
       * a read-only synthesis assertion over that exact postimage: validate
       * the canonical typed decision and its immutable proof, but do not
       * project the phase or consume the answer a second time.
       */
      const typed = (state.typed_checkpoint_decisions ?? [])
        .filter((candidate) =>
          candidate.run_id === decision.run_key
          && candidate.stage_id === decision.phase
          && candidate.checkpoint_id === SPECIFICATION_PHASE_CHECKPOINT
          && candidate.decision === decision.decision
          && candidate.actor.kind === "user"
          && candidate.actor.proof?.answer_id === decision.trusted_answer_ref
        )
        .sort((left, right) => left.decided_at.localeCompare(right.decided_at))
        .at(-1);
      if (!typed) {
        throw new Error(`CTO_SPEC_CHECKPOINT_STALE: approved phase '${decision.phase}' has no matching generic checkpoint decision`);
      }
      if (
        (typed.artifact_version !== undefined && typed.artifact_version !== phase.current_version)
        || (typed.validation_ref !== undefined && typed.validation_ref !== phase.validation_ref)
      ) {
        throw new Error(`CTO_SPEC_CHECKPOINT_STALE: generic checkpoint decision is not bound to the approved phase postimage`);
      }
      const validated = validateCheckpointDecision(state, typed, {
        stage: { id: decision.phase, checkpoint: SPECIFICATION_PHASE_CHECKPOINT },
        policy,
        bindCapability: false,
      });
      if (!validated.ok) {
        throw new Error(`CTO_SPEC_PROOF_INVALID: ${validated.error}`);
      }
      const proofError = trustedCheckpointAnswerError(state, {
        actor: {
          kind: "user",
          ref: decision.trusted_proof.reference,
          proof: decision.trusted_proof,
        },
        run_id: decision.run_key,
        stage_id: decision.phase,
        checkpoint_id: SPECIFICATION_PHASE_CHECKPOINT,
        decision: decision.decision,
        policy_hash: checkpointPolicyHash(policy),
        feature_id: decision.feature_id,
        subject_revision: appliedAnswer?.subject_revision,
        feedback: decision.trusted_proof.feedback,
        bind_active_context: false,
      });
      if (proofError) throw new Error(`CTO_SPEC_PROOF_INVALID: ${proofError}`);
      if (replayExisting) continue;
    } else {
      const answer = (state.trusted_checkpoint_answers ?? []).find(
        (candidate) => candidate.answer_id === decision.trusted_answer_ref,
      );
      if (answer?.consumed_at) {
        throw new Error(`CTO_SPEC_PROOF_REPLAYED: trusted answer '${decision.trusted_answer_ref}' was already consumed`);
      }
      const capability = state.dispatch_capability;
      const capabilityId = capability?.capability_id;
      const capabilityEpoch = capability?.issued_for?.cursor_epoch ?? state.cursor_epoch;
      try {
        nextState = consumeTrustedCheckpointAnswer(state, {
          actor: {
            kind: "user",
            ref: decision.trusted_proof.reference,
            proof: decision.trusted_proof,
          },
          run_id: decision.run_key,
          stage_id: decision.phase,
          checkpoint_id: SPECIFICATION_PHASE_CHECKPOINT,
          decision: decision.decision,
          capability_id: capabilityId,
          capability_epoch: capabilityEpoch,
          policy_hash: checkpointPolicyHash(policy),
          feature_id: decision.feature_id,
          subject_revision: state.state_revision,
          feedback: decision.trusted_proof.feedback,
          bind_active_context: true,
          require_hard_human: true,
        });
      } catch (error) {
        throw new Error(`CTO_SPEC_PROOF_INVALID: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // The public selected Ask already committed the approved native phase
    // postimage. CTO recording is a read-only synthesis assertion for that
    // path; staging the same state again creates a needless CAS/compensation
    // cycle and can strand a decision WAL after the Ask revision advances.
    if (approved) {
      identities.set(identity, decision);
      answerBindings.set(decision.trusted_answer_ref, identity);
      continue;
    }
    const prior = stagedStates.get(expectedStatePath);
    stagedStates.set(expectedStatePath, {
      feature_id: decision.feature_id,
      run_key: decision.run_key,
      mutation_id: prior?.mutation_id ?? `${transactionId}:${decision.feature_id}:${decision.run_key}`,
      state: nextState,
      source_content: prior?.source_content ?? source,
      source_state: prior?.source_state ?? sourceState,
      source_logical_digest: prior?.source_logical_digest ?? stateDigest(sourceState),
      applied: false,
      target: {
        statePath: found.statePath,
        stateDir: found.stateDir,
        artifactsDir: found.artifactsDir,
        isLegacy: found.isLegacy,
      },
      source_digest: sha256Hex(source),
      target_digest: stateDigest(nextState),
    });
    identities.set(identity, decision);
    answerBindings.set(decision.trusted_answer_ref, identity);
  }

  const merged = [...identities.values()].sort(compareDecisions);
  const file: CtoSpecificationDecisionsFile = {
    schema_version: 1,
    cto_run_id: ctoRunId,
    decisions: merged,
  };

  // Re-read through O_NOFOLLOW and compare exact byte digests immediately
  // before preparing, so a raced or substituted state is never staged.
  for (const [statePath, staged] of stagedStates) {
    if (sha256Hex(readCanonicalFile(root, statePath, pinnedRoot, MAX_PERSISTED_STATE_BYTES)) !== staged.source_digest) {
      throw new Error("CTO_SPEC_STATE_CONFLICT: feature state changed while decisions were verified");
    }
  }

  const decisionContent = `${JSON.stringify(file, null, 2)}\n`;
  const constitutionSnapshot = pinnedRoot && stagedStates.size > 0
    ? captureCtoDecisionConstitutionSnapshot(root, [...stagedStates.values()], pinnedRoot)
    : undefined;
  const transaction: SpecificationDecisionTransaction = {
    schema_version: 1,
    status: "pending",
    transaction_id: transactionId,
    cto_run_id: ctoRunId,
    decision_path: path,
    base_decisions_digest: sha256Hex(recordedRaw ?? ""),
    decision_before: recordedRaw === null
      ? { disposition: "absent", content: null, digest: sha256Hex("") }
      : { disposition: "present", content: recordedRaw, digest: sha256Hex(recordedRaw) },
    decision_digest: sha256Hex(decisionContent),
    decision_content: decisionContent,
    incoming_decisions: incoming,
    decisions: merged,
    staged_states: [...stagedStates.values()],
    ...(constitutionSnapshot ? { constitution_snapshot: constitutionSnapshot } : {}),
  };
  const txPath = transactionPath(root, transaction, pinnedRoot);
  const assertDecisionSourcesCurrent = (): void => {
    if (!pinnedRoot) throw new Error("CTO_SPEC_PATH_INVALID: decision constitution guard requires a pinned project root");
    assertCtoDecisionSourcesCurrent(root, transaction, pinnedRoot);
  };
  injectDecisionFailure("before_prepare", transaction.transaction_id);
  if (pinnedRoot) {
    if (!pinnedRoot.isStable() || !pinnedRoot.relativePath(txPath)) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed before decision WAL prepare");
  } else {
    assertContainedPath(root, txPath, { allowMissing: true, regularFile: true });
  }
  const preparedJournal = persistTransaction(root, transaction, pinnedRoot, { beforeWrite: assertDecisionSourcesCurrent });
  injectDecisionFailure("after_prepare", transaction.transaction_id);

  try {
    const outcome = commitTransaction(root, transaction, pinnedRoot, { beforeDecisionWrite: assertDecisionSourcesCurrent, journal: preparedJournal });
    if (outcome === "aborted") {
      throw new Error(`CTO_SPEC_DECISION_ABORTED: transaction aborted (${transaction.abort_reason ?? "unknown"})`);
    }
  } catch (error) {
    throw new Error(`CTO_SPEC_DECISION_COMMIT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (pinnedRoot && !pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: pinned project root changed after decision transaction");
  return {
    decisions: merged.map((decision) => ({
      ...decision,
      trusted_proof: { ...decision.trusted_proof },
    })),
  };
}

export function recordCtoSpecificationDecisions(
  projectRoot: string,
  input: { cto_run_id: string; decisions: unknown },
): CtoSpecificationDecisionsResult {
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) throw new Error("CTO_SPEC_PATH_INVALID: project root cannot be pinned for decision transaction");
  try {
    if (!pinnedRoot.isStable()) throw new Error("CTO_SPEC_PATH_INVALID: project root changed before decision transaction");
    const root = pinnedRoot.canonical_root;
    const rawInput = input as unknown as { cto_run_id: string; decisions: unknown };
    if (!isPlainObject(input)) return recordCtoSpecificationDecisionsUnlocked(root, rawInput, pinnedRoot);
    const ctoRunId = input.cto_run_id;
    if (!isSafeCtoRunId(ctoRunId)) return recordCtoSpecificationDecisionsUnlocked(root, input, pinnedRoot);
    return withCtoRunLock(
      root,
      ctoRunId,
      () => recordCtoSpecificationDecisionsUnlocked(root, input, pinnedRoot),
      { pinnedRoot },
    );
  } finally {
    pinnedRoot.close();
  }
}
