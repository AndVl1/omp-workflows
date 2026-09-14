/**
 * CTO run entry point (two-layer contract, R12).
 *
 * The engine builds and persists the plan; the resident CTO performs the
 * delegated work. Specification preparation has a durable terminal boundary
 * and never reuses its authority for implementation.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { buildTeamPlan, validateDecompositionDepth, type PlanTeamInput } from "./plan.js";
import {
  activeWave,
  applyFinishWaveTransition,
  ctoStateDir,
  ctoPreparationTeamId,
  isSafeCtoRunId,
  isValidCtoBranchText,
  isValidCtoTaskText,
  newCtoState,
} from "./state.js";
import type { ModelClassification } from "../engine/run.js";
import type { CtoState, TeamDef, TeamPlan } from "./types.js";
import { assertCtoRuntimeAccessFacadeLive, isSafeCtoRuntimeSessionId } from "./runtime-access.js";
import type { CtoRuntimeAccessFacade } from "./runtime-access.js";
import { ctoRuntimeRunInitialIdentityDigest } from "./state.js";
import type { FeatureWorkspace, WorkspacePhase } from "../specification/types.js";
import { isSafeStateSegment } from "../engine/state.js";
import {
  readCtoSpecificationDecisionsWhileLocked,
  type CtoSpecificationDecision,
} from "./decisions.js";
import { resolveFeatureWorkspace } from "../specification/workspace.js";
import { readPinnedCurrentConstitution } from "../specification/constitution-identities.js";
import { ensureProjectConstitution } from "../specification/prerequisite.js";
import { canonicalJson } from "../specification/validation.js";
import { canonicalHandoffDigest, evaluateHandoffReadiness } from "../specification/handoff.js";
import { readCanonicalHandoff } from "../specification/canonical-reader.js";
import {
  buildCtoSpecificationReviewPacketFromDecisionSnapshot,
  buildCtoSpecificationReviewPacketFromDecisionSnapshotPinned,
  type CtoSpecificationReviewPacket,
} from "./specification-review-packet.js";
import { materializeCtoSpecificationReviewPacket, materializeCtoSpecificationReviewPacketPinned } from "../specification/materialize.js";
import { MAX_CTO_REVIEW_PACKET_BYTES } from "../specification/limits.js";

import { PinnedProjectRoot, PinnedRootError, type PinnedRootWriteDescriptor, type PinnedRootWriteReceipt } from "../specification/pinned-root.js";

export interface RunCtoOptions {
  task: string;
  cwd: string;
  branch: string;
  autonomous: boolean;
  classification?: ModelClassification;
  teams: PlanTeamInput[];
  defs: Record<string, TeamDef> | Map<string, TeamDef>;
  profileDepth?: (profile: string) => number;
  standby?: boolean;
  /** Exact host session identity bound to the authenticated runtime. */
  sessionId: string;
  /** Required live authenticated runtime used to mint root/state proofs. */
  runtimeAccess: CtoRuntimeAccessFacade;
  log?: (line: string) => void;
}

export type RunCtoResult =
  | { ok: true; plan: TeamPlan; state: CtoState; statePath: string }
  | { ok: false; reason: string };

function constitutionComparable(binding: FeatureWorkspace["constitution_binding"]): string {
  if (!binding) return "null";
  const { bound_at: _audit, ...semantic } = binding;
  return canonicalJson(semantic);
}

let runSeq = 0;

export function ctoRunId(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 23).replace(/[:T.]/g, "-");
  runSeq += 1;
  return `${slug || "task"}-${stamp}-${runSeq.toString(36)}`;
}
export function runCto(opts: RunCtoOptions): RunCtoResult {
  if (!isValidCtoTaskText(opts?.task)) return { ok: false, reason: "task must be a canonical non-blank string (UTF-8 <= 256 KiB)" };
  if (!isValidCtoBranchText(opts?.branch)) return { ok: false, reason: "branch must be a canonical non-blank control-safe string (UTF-8 <= 256 KiB)" };
  if (!opts.runtimeAccess || !isSafeCtoRuntimeSessionId(opts.sessionId)) return { ok: false, reason: "recovery_required: live runtime access and a non-blank sessionId are required for authoritative CTO run creation" };
  const runRoot = PinnedProjectRoot.open(opts.cwd);
  if (!runRoot) return { ok: false, reason: "recovery_required: project root cannot be pinned" };
  try { assertCtoRuntimeAccessFacadeLive(opts.runtimeAccess, runRoot.canonical_root, opts.sessionId); } catch { runRoot.close(); return { ok: false, reason: "recovery_required: runtime access does not match the project root" }; }
  runRoot.close();
  const built = buildTeamPlan(
    { id: ctoRunId(opts.task), task: opts.task, teams: opts.teams },
    opts.defs,
  );
  if (!built.ok) return built;

  const depth = validateDecompositionDepth(built.plan, opts.profileDepth);
  if (!depth.ok) return { ok: false, reason: depth.reason };

  const state = newCtoState({
    id: built.plan.id,
    task: opts.task,
    branch: opts.branch,
    autonomous: opts.autonomous,
    classification: opts.classification,
    plan: built.plan,
    ...(opts.standby === true ? { standby: true } : {}),
    owner_session: opts.sessionId,
  });
  // The initial CTO plan has no selected specification workspace or
  // constitution-bound authority; guarded preparation begins later.
  const initialStateDigest = ctoRuntimeRunInitialIdentityDigest(state);
  const created = opts.runtimeAccess.createRun(state, { source_id: "cto-run:" + built.plan.id, initial_state_sha256: initialStateDigest });
  const statePath = join(opts.runtimeAccess.stateDirectory(created.id), "state.json");
  opts.log?.("cto: plan " + built.plan.id + " — " + built.plan.teams.length + " teams, depth " + depth.depth + ", state " + statePath);
  return { ok: true, plan: built.plan, state: created, statePath };
}

// ── CTO specification preparation advance (T103/T106) ───────────────────────

export interface CtoSpecificationPreparationFeatureStatus {
  feature_id: string;
  run_key: string;
  phase: WorkspacePhase;
  checkpoint_ref: string;
  version: number;
  status: string;
  next_action: string;
}

export interface AdvanceCtoSpecificationPreparationResult {
  cto_run_id: string;
  features: CtoSpecificationPreparationFeatureStatus[];
  /** Canonical absolute path of the readable review packet. */
  review_packet_ref: string;
  execution_started: false;
  hard_stop: true;
}

/** Deterministic crash seams for specification preparation durable boundaries. */
export type CtoSpecificationPreparationFailurePoint =
  | "before_artifact_write"
  | "after_artifact_write"
  | "before_packet_publish"
  | "before_state_write"
  | "after_state_write"
  | "before_preparation_journal"
  | "after_preparation_journal"
  | "before_preparation_journal_clear"
  | "after_preparation_journal_clear"
  | "before_workspace_mkdir"
  | "after_workspace_mkdir"
  | "after_feature_state_write"
  | "before_wave_append"
  | "after_wave_append"
  | "after_cto_state_write";

export type CtoSpecificationPreparationFailureInjector =
  (point: CtoSpecificationPreparationFailurePoint) => void;

let preparationFailureInjector: CtoSpecificationPreparationFailureInjector | null = null;

/** Internal deterministic crash seam; intentionally not exported by package index. */
export function setCtoSpecificationPreparationFailureInjector(
  injector: CtoSpecificationPreparationFailureInjector | null,
): void {
  preparationFailureInjector = injector;
}

export function injectPreparationFailure(point: CtoSpecificationPreparationFailurePoint): void {
  preparationFailureInjector?.(point);
}

/** Typed failure for packet publication/replay and the terminal state boundary. */
export class CtoSpecificationPreparationError extends Error {
  readonly code: string;

  constructor(code: string, error: string) {
    super(`${code}: ${error}`);
    this.name = "CtoSpecificationPreparationError";
    this.code = code;
  }
}

const REVIEW_PACKET_DOC = "specification-review-packet.md";
// Shared with the materializer writer and the pinned reader.

function preparationNextAction(decision: string): string {
  switch (decision) {
    case "approve_continue": return "review_packet_ready";
    case "request_changes": return "revision_requested";
    case "approve_stop": return "preparation_stopped";
    default: return `unrecognized_decision:${decision}`;
  }
}

function decisionVersion(decision: CtoSpecificationDecision): number {
  const expectedPrefix = `checkpoint.${decision.phase}.v`;
  if (!decision.checkpoint_ref.startsWith(expectedPrefix)) {
    throw new Error(
      `advanceCtoSpecificationPreparation: checkpoint '${decision.checkpoint_ref}' is not bound to phase '${decision.phase}'`,
    );
  }
  const version = Number(decision.checkpoint_ref.slice(expectedPrefix.length));
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(
      `advanceCtoSpecificationPreparation: checkpoint '${decision.checkpoint_ref}' has an invalid version`,
    );
  }
  return version;
}

function canonicalProjectRoot(projectRoot: string): string {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    throw new CtoSpecificationPreparationError(
      "CTO_REVIEW_STATE_INVALID",
      "projectRoot must be a non-blank string",
    );
  }
  try {
    const root = realpathSync(resolve(projectRoot));
    if (!lstatSync(root).isDirectory()) throw new Error("projectRoot is not a directory");
    return root;
  } catch (error) {
    throw new CtoSpecificationPreparationError(
      "CTO_REVIEW_STATE_INVALID",
      `project root is unavailable or unsafe: ${String(error)}`,
    );
  }
}

/** Resolve the one canonical packet path without following any symlink. */
function reviewPacketPath(root: string, ctoRunId: string, allowMissing: boolean): string {
  let target: string;
  try {
    target = join(ctoStateDir(ctoRunId, root), REVIEW_PACKET_DOC);
  } catch (error) {
    throw new CtoSpecificationPreparationError(
      "CTO_REVIEW_PACKET_PATH_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new CtoSpecificationPreparationError(
      "CTO_REVIEW_PACKET_PATH_INVALID",
      `review packet path '${target}' escapes project root '${root}'`,
    );
  }
  let current = root;
  const segments = rel === "" ? [] : rel.split(/[\\/]/);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return target;
      throw new CtoSpecificationPreparationError(
        "CTO_REVIEW_PACKET_PATH_INVALID",
        `review packet path '${current}' is unavailable: ${String(error)}`,
      );
    }
    if (stats.isSymbolicLink()) {
      throw new CtoSpecificationPreparationError(
        "CTO_REVIEW_PACKET_PATH_INVALID",
        `review packet path component '${current}' is a symlink`,
      );
    }
    const leaf = index === segments.length - 1;
    if (!leaf && !stats.isDirectory()) {
      throw new CtoSpecificationPreparationError(
        "CTO_REVIEW_PACKET_PATH_INVALID",
        `review packet path ancestor '${current}' is not a directory`,
      );
    }
    if (leaf && !stats.isFile()) {
      throw new CtoSpecificationPreparationError(
        "CTO_REVIEW_PACKET_PATH_INVALID",
        `review packet path '${current}' is not a regular file`,
      );
    }
  }
  try {
    if (realpathSync(target) !== target) {
      throw new CtoSpecificationPreparationError(
        "CTO_REVIEW_PACKET_PATH_INVALID",
        `review packet path '${target}' is not canonical`,
      );
    }
  } catch (error) {
    if (error instanceof CtoSpecificationPreparationError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return target;
    throw new CtoSpecificationPreparationError(
      "CTO_REVIEW_PACKET_PATH_INVALID",
      `review packet path '${target}' is unavailable: ${String(error)}`,
    );
  }
  return target;
}

function readReviewPacketBytes(root: string, ctoRunId: string, pinnedRoot?: PinnedProjectRoot): Buffer {
  const relativePath = join(".work-state", "cto", ctoRunId, REVIEW_PACKET_DOC);
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) throw new CtoSpecificationPreparationError("CTO_REVIEW_ROOT_CHANGED", "pinned project root changed before review packet read");
    try {
      const bytes = Buffer.from(pinnedRoot.readFile(relativePath, { maxBytes: MAX_CTO_REVIEW_PACKET_BYTES }).bytes);
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!pinnedRoot.isStable()) throw new CtoSpecificationPreparationError("CTO_REVIEW_ROOT_CHANGED", "pinned project root changed while reading review packet");
      return bytes;
    } catch (error) {
      if (error instanceof CtoSpecificationPreparationError) throw error;
      throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_INVALID", `review packet '${relativePath}' cannot be read safely: ${String(error)}`);
    }
  }
  const target = reviewPacketPath(root, ctoRunId, false);
  let fd: number | null = null;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error("opened review packet is not a regular file");
    if (!Number.isSafeInteger(stats.size) || stats.size < 0 || stats.size > MAX_CTO_REVIEW_PACKET_BYTES) {
      throw new Error(`review packet exceeds the ${MAX_CTO_REVIEW_PACKET_BYTES}-byte read limit`);
    }
    const bytes = readFileSync(fd);
    if (bytes.byteLength > MAX_CTO_REVIEW_PACKET_BYTES) throw new Error(`review packet exceeds the ${MAX_CTO_REVIEW_PACKET_BYTES}-byte read limit`);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes;
  } catch (error) {
    throw new CtoSpecificationPreparationError(
      "CTO_REVIEW_PACKET_INVALID",
      `review packet '${target}' cannot be read safely: ${String(error)}`,
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Validate the canonical terminal newline and hash the exact persisted bytes. */
function packetContentSha256(bytes: Buffer): string {
  if (bytes.length < 2 || bytes[bytes.length - 1] !== 0x0a || bytes[bytes.length - 2] === 0x0a) {
    throw new CtoSpecificationPreparationError(
      "CTO_REVIEW_PACKET_INVALID",
      "review packet must end with exactly one newline",
    );
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyPublishedProjection(
  root: string,
  packet: CtoSpecificationReviewPacket,
  projection: { cto_run_id: string; packet_ref: string; path: string; content_sha256: string },
  bytes: Buffer,
  pinnedRoot?: PinnedProjectRoot,
): string {
  if (pinnedRoot && !pinnedRoot.isStable()) throw new CtoSpecificationPreparationError("CTO_REVIEW_ROOT_CHANGED", "pinned project root changed while verifying review packet");
  const target = pinnedRoot
    ? join(pinnedRoot.lexical_root, ".work-state", "cto", packet.cto_run_id, REVIEW_PACKET_DOC)
    : reviewPacketPath(root, packet.cto_run_id, false);
  if (
    projection.cto_run_id !== packet.cto_run_id
    || projection.packet_ref !== packet.packet_ref
    || resolve(projection.path) !== target
  ) {
    throw new CtoSpecificationPreparationError(
      "CTO_REVIEW_PACKET_INVALID",
      "materializer returned a projection with an unexpected run, packet reference, or path",
    );
  }
  if (packetContentSha256(bytes) !== projection.content_sha256) {
    throw new CtoSpecificationPreparationError(
      "CTO_REVIEW_PACKET_INVALID",
      "materializer content hash does not match the persisted review packet bytes",
    );
  }
  if (pinnedRoot && !pinnedRoot.isStable()) throw new CtoSpecificationPreparationError("CTO_REVIEW_ROOT_CHANGED", "pinned project root changed after review packet verification");
  return target;
}

type ReviewPacket = CtoSpecificationReviewPacket;

function renderExpectedReplayBytes(packet: ReviewPacket): Buffer {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "cto-review-packet-replay-"));
  const canonicalTemporaryRoot = canonicalProjectRoot(temporaryRoot);
  try {
    let materialized;
    try {
      materialized = materializeCtoSpecificationReviewPacket(canonicalTemporaryRoot, packet);
    } catch (error) {
      throw new CtoSpecificationPreparationError(
        "CTO_REVIEW_PACKET_REPLAY_INVALID",
        `could not render expected replay bytes: ${String(error)}`,
      );
    }
    if (!materialized.ok) {
      throw new CtoSpecificationPreparationError(
        "CTO_REVIEW_PACKET_REPLAY_INVALID",
        `${materialized.code}: ${materialized.error}`,
      );
    }
    const bytes = readReviewPacketBytes(canonicalTemporaryRoot, packet.cto_run_id);
    verifyPublishedProjection(canonicalTemporaryRoot, packet, materialized.value, bytes);
    return bytes;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function readExistingReviewPacket(root: string, packet: ReviewPacket, pinnedRoot?: PinnedProjectRoot): Buffer | null {
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) throw new CtoSpecificationPreparationError("CTO_REVIEW_ROOT_CHANGED", "pinned project root changed before existing packet read");
    const relativePath = join(".work-state", "cto", packet.cto_run_id, REVIEW_PACKET_DOC);
    if (!pinnedRoot.pathEntryExists(relativePath)) return null;
    return readReviewPacketBytes(root, packet.cto_run_id, pinnedRoot);
  }
  reviewPacketPath(root, packet.cto_run_id, true);
  try {
    return readReviewPacketBytes(root, packet.cto_run_id);
  } catch (error) {
    if (
      error instanceof CtoSpecificationPreparationError
      && error.code === "CTO_REVIEW_PACKET_PATH_INVALID"
      && /ENOENT|unavailable/.test(error.message)
    ) return null;
    if (
      error instanceof CtoSpecificationPreparationError
      && error.code === "CTO_REVIEW_PACKET_INVALID"
      && /ENOENT/.test(error.message)
    ) return null;
    throw error;
  }
}

/**
 * Publish exactly once, or verify the existing bytes on a replay. The actual
 * project-root materializer is only called when the canonical artifact is
 * absent; a collision is never overwritten.
 */
interface ReviewPacketPublicationTransaction {
  schema_version: 1;
  cto_run_id: string;
  packet_ref: string;
  path: string;
  before_content: string | null;
  before_digest: string;
  after_content: string;
  after_digest: string;
  postimage_descriptor?: PinnedRootWriteDescriptor;
  constitution_bindings: Array<{
    feature_id: string;
    run_key: string;
    binding: NonNullable<FeatureWorkspace["constitution_binding"]>;
  }>;
}
const REVIEW_PACKET_TRANSACTION_FILE = "review-packet.transaction.json";
const MAX_REVIEW_PACKET_TRANSACTION_BYTES = MAX_CTO_REVIEW_PACKET_BYTES * 2;
function reviewPacketTransactionPath(root: string, ctoRunId: string): string {
  const path = join(root, ".work-state", "cto", ctoRunId, REVIEW_PACKET_TRANSACTION_FILE);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_PATH_INVALID", "review packet transaction path escapes project root");
  }
  return path;
}
function reviewPacketTransactionContent(transaction: ReviewPacketPublicationTransaction): string {
  const content = `${JSON.stringify(transaction, null, 2)}\r
`;
  if (Buffer.byteLength(content, "utf8") > MAX_REVIEW_PACKET_TRANSACTION_BYTES) {
    throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_INVALID", "review packet transaction exceeds its bounded size");
  }
  return content;
}
function persistReviewPacketTransaction(
  root: string,
  transaction: ReviewPacketPublicationTransaction,
  pinnedRoot: PinnedProjectRoot,
): void {
  const path = reviewPacketTransactionPath(root, transaction.cto_run_id);
  const relativePath = pinnedRoot.relativePath(path);
  if (!relativePath) throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_PATH_INVALID", "review packet transaction path is outside the pinned project root");
  pinnedRoot.writeAtomic(relativePath, reviewPacketTransactionContent(transaction));
}
function removeReviewPacketTransaction(
  root: string,
  ctoRunId: string,
  pinnedRoot: PinnedProjectRoot,
): void {
  const path = reviewPacketTransactionPath(root, ctoRunId);
  const relativePath = pinnedRoot.relativePath(path);
  if (!relativePath) throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_PATH_INVALID", "review packet transaction path is outside the pinned project root");
  try {
    const current = pinnedRoot.readFile(relativePath, { maxBytes: MAX_REVIEW_PACKET_TRANSACTION_BYTES });
    pinnedRoot.removeFileIfMatches(relativePath, {
      dev: current.dev,
      ino: current.ino,
      sha256: createHash("sha256").update(Buffer.from(current.bytes)).digest("hex"),
    });
  } catch (error) {
    if (!(error instanceof PinnedRootError && error.code === "not_found")) throw error;
  }
}
function captureReviewPacketConstitutionBindings(
  root: string,
  state: CtoState,
  pinnedRoot: PinnedProjectRoot,
): ReviewPacketPublicationTransaction["constitution_bindings"] {
  const features = (state as CtoState & { preparation_features?: Array<{ feature_id?: unknown; run_key?: unknown }> }).preparation_features;
  if (!Array.isArray(features)) return [];
  return features.map((feature) => {
    if (typeof feature.feature_id !== "string" || typeof feature.run_key !== "string") {
      throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_CONSTITUTION_CONFLICT", "preparation feature identity is malformed");
    }
    const workspace = resolveFeatureWorkspace(root, { feature_id: feature.feature_id, run_key: feature.run_key }, {
      lexical_root: pinnedRoot.lexical_root,
      canonical_root: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
      pinned_root: pinnedRoot,
    });
    if (!workspace.ok || !workspace.value.constitution_binding) {
      throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_CONSTITUTION_CONFLICT", `constitution workspace '${feature.feature_id}' is unavailable`);
    }
    return { feature_id: feature.feature_id, run_key: feature.run_key, binding: workspace.value.constitution_binding };
  });
}
function restoreReviewPacketPreimage(
  transaction: ReviewPacketPublicationTransaction,
  pinnedRoot: PinnedProjectRoot,
): boolean {
  if (!pinnedRoot.isStable() || !transaction.postimage_descriptor) return false;
  const relativePath = pinnedRoot.relativePath(transaction.path);
  if (!relativePath || transaction.postimage_descriptor.relative_path !== relativePath
    || transaction.postimage_descriptor.path !== pinnedRoot.anchorPath(relativePath)) return false;
  try {
    const current = pinnedRoot.readFile(relativePath, { maxBytes: MAX_CTO_REVIEW_PACKET_BYTES });
    const bytes = Buffer.from(current.bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== transaction.after_digest || bytes.toString("utf8") !== transaction.after_content) return false;
    const expected = { dev: transaction.postimage_descriptor.dev, ino: transaction.postimage_descriptor.ino, sha256: transaction.postimage_descriptor.sha256 };
    if (transaction.postimage_descriptor.size !== bytes.byteLength) return false;
    if (transaction.before_content === null) {
      pinnedRoot.removeFileIfMatches(relativePath, expected);
    } else {
      pinnedRoot.replaceFileIfMatches(relativePath, expected, transaction.before_content);
    }
    return pinnedRoot.isStable();
  } catch {
    return false;
  }
}
function reviewPacketConstitutionError(
  transaction: ReviewPacketPublicationTransaction,
  pinnedRoot: PinnedProjectRoot,
): string | null {
  for (const entry of transaction.constitution_bindings) {
    const current = readPinnedCurrentConstitution(pinnedRoot.canonical_root, pinnedRoot, entry.binding);
    if (!current.ok || constitutionComparable(current.value.binding) !== constitutionComparable(entry.binding)) {
      return `live constitution binding changed for '${entry.feature_id}'`;
    }
  }
  return null;
}
function recoverReviewPacketTransaction(
  root: string,
  ctoRunId: string,
  pinnedRoot: PinnedProjectRoot,
): void {
  const path = reviewPacketTransactionPath(root, ctoRunId);
  const relativePath = pinnedRoot.relativePath(path);
  if (!relativePath) throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_PATH_INVALID", "review packet transaction path is outside the pinned project root");
  let read;
  try { read = pinnedRoot.readFile(relativePath, { maxBytes: MAX_REVIEW_PACKET_TRANSACTION_BYTES }); }
  catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(read.bytes).toString("utf8")); }
  catch (error) { throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_INVALID", `review packet transaction is unreadable: ${String(error)}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_INVALID", "review packet transaction is not an object");
  const transaction = parsed as Partial<ReviewPacketPublicationTransaction>;
  if (transaction.schema_version !== 1 || transaction.cto_run_id !== ctoRunId || typeof transaction.packet_ref !== "string"
    || typeof transaction.path !== "string" || transaction.path !== reviewPacketRelativePath({ cto_run_id: ctoRunId } as ReviewPacket)
    || (transaction.before_content !== null && typeof transaction.before_content !== "string")
    || typeof transaction.before_digest !== "string" || !/^[a-f0-9]{64}$/u.test(transaction.before_digest)
    || transaction.before_digest !== createHash("sha256").update(transaction.before_content ?? "").digest("hex")
    || typeof transaction.after_content !== "string" || typeof transaction.after_digest !== "string" || !/^[a-f0-9]{64}$/u.test(transaction.after_digest)
    || transaction.after_digest !== createHash("sha256").update(transaction.after_content).digest("hex")
    || !Array.isArray(transaction.constitution_bindings)) {
    throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_INVALID", "review packet transaction identity or digest is invalid");
  }
  const descriptor = transaction.postimage_descriptor;
  if (descriptor !== undefined) {
    if (!descriptor || typeof descriptor !== "object"
      || descriptor.path !== pinnedRoot.anchorPath(transaction.path)
      || descriptor.relative_path !== transaction.path
      || !Number.isSafeInteger(descriptor.dev) || descriptor.dev < 0
      || !Number.isSafeInteger(descriptor.ino) || descriptor.ino < 0
      || !Number.isSafeInteger(descriptor.size) || descriptor.size !== Buffer.byteLength(transaction.after_content, "utf8")
      || descriptor.sha256 !== transaction.after_digest) {
      throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_INVALID", "review packet transaction write descriptor is invalid");
    }
  }
  const current = reviewPacketImage(pinnedRoot, { cto_run_id: ctoRunId } as ReviewPacket);
  const currentContent = current?.bytes.toString("utf8") ?? null;
  const currentDigest = createHash("sha256").update(currentContent ?? "").digest("hex");
  const before = currentContent === transaction.before_content && currentDigest === transaction.before_digest;
  const after = currentContent === transaction.after_content && currentDigest === transaction.after_digest;
  if (!before && !after) throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_COLLISION", "review packet transaction target differs from both its registered preimage and postimage");
  if (before) {
    removeReviewPacketTransaction(root, ctoRunId, pinnedRoot);
    return;
  }
  const constitutionError = reviewPacketConstitutionError(transaction as ReviewPacketPublicationTransaction, pinnedRoot);
  if (constitutionError) {
    if (!restoreReviewPacketPreimage(transaction as ReviewPacketPublicationTransaction, pinnedRoot)) throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_CONFLICT", "stale review packet postimage could not be restored without clobbering a concurrent replacement");
    removeReviewPacketTransaction(root, ctoRunId, pinnedRoot);
    throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_CONSTITUTION_CONFLICT", constitutionError);
  }
  if (!transaction.postimage_descriptor
    || !current
    || current.dev !== transaction.postimage_descriptor.dev
    || current.ino !== transaction.postimage_descriptor.ino
    || current.bytes.byteLength !== transaction.postimage_descriptor.size) {
    throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_CONFLICT", "review packet postimage ownership descriptor is unavailable or no longer matches the persisted packet");
  }
  removeReviewPacketTransaction(root, ctoRunId, pinnedRoot);
}

function reviewPacketRelativePath(packet: ReviewPacket): string {
  return join(".work-state", "cto", packet.cto_run_id, REVIEW_PACKET_DOC);
}

function reviewPacketImage(pinnedRoot: PinnedProjectRoot, packet: ReviewPacket): { bytes: Buffer; dev: number; ino: number } | null {
  try {
    const read = pinnedRoot.readFile(reviewPacketRelativePath(packet), { maxBytes: MAX_CTO_REVIEW_PACKET_BYTES });
    return { bytes: Buffer.from(read.bytes), dev: read.dev, ino: read.ino };
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return null;
    throw error;
  }
}

function rollbackCreatedReviewPacket(
  pinnedRoot: PinnedProjectRoot,
  packet: ReviewPacket,
  before: { bytes: Buffer; dev: number; ino: number } | null,
  expected: Buffer,
  descriptor?: PinnedRootWriteDescriptor,
): boolean {
  if (before !== null) return true;
  if (!pinnedRoot.isStable()) return false;
  const path = reviewPacketRelativePath(packet);
  try {
    const current = pinnedRoot.readFile(path, { maxBytes: MAX_CTO_REVIEW_PACKET_BYTES });
    const bytes = Buffer.from(current.bytes);
    if (!bytes.equals(expected)) return false;
    if (!descriptor
      || descriptor.relative_path !== path
      || descriptor.path !== pinnedRoot.anchorPath(path)
      || descriptor.dev !== current.dev
      || descriptor.ino !== current.ino
      || descriptor.size !== bytes.byteLength
      || descriptor.sha256 !== createHash("sha256").update(bytes).digest("hex")) return false;
    pinnedRoot.removeFileIfMatches(path, {
      dev: descriptor.dev,
      ino: descriptor.ino,
      sha256: descriptor.sha256,
    });
    return pinnedRoot.isStable();
  } catch (error) {
    // A helper that rolled back its own failed publication leaves no target.
    if (error instanceof PinnedRootError && error.code === "not_found") return true;
    // A changed or vanished packet belongs to a concurrent winner; preserve it.
    return false;
  }
}

function materializeOrVerifyReviewPacket(
  root: string,
  packet: ReviewPacket,
  pinnedRoot: PinnedProjectRoot,
  state: CtoState,
  beforePublish?: (receipt: PinnedRootWriteReceipt) => void,
): { path: string; write_descriptor?: PinnedRootWriteDescriptor } {
  const existing = readExistingReviewPacket(root, packet, pinnedRoot);
  if (existing !== null) {
    const expected = renderExpectedReplayBytes(packet);
    if (!existing.equals(expected)) {
      throw new CtoSpecificationPreparationError(
        "CTO_REVIEW_PACKET_COLLISION",
        `existing review packet for run '${packet.cto_run_id}' differs from the exact packet bytes`,
      );
    }
    return {
      path: pinnedRoot
        ? join(pinnedRoot.lexical_root, ".work-state", "cto", packet.cto_run_id, REVIEW_PACKET_DOC)
        : reviewPacketPath(root, packet.cto_run_id, false),
    };
  }

  let materialized;
  try {
    materialized = materializeCtoSpecificationReviewPacketPinned(pinnedRoot, packet, {
      beforeWrite: () => {
        assertPreparationConstitutionFresh(root, state, pinnedRoot);
      },
      ...(beforePublish ? { beforePublish } : {}),
    });
  } catch (error) {
    throw new CtoSpecificationPreparationError(
      "CTO_REVIEW_PACKET_MATERIALIZATION_FAILED",
      String(error),
    );
  }
  if (!materialized.ok) {
    throw new CtoSpecificationPreparationError(
      materialized.code,
      materialized.error,
    );
  }
  if (!materialized.value.write_descriptor) {
    throw new CtoSpecificationPreparationError(
      "CTO_REVIEW_PACKET_INVALID",
      "newly materialized review packet did not return its anchored write descriptor",
    );
  }
  const bytes = readReviewPacketBytes(root, packet.cto_run_id, pinnedRoot);
  return {
    path: verifyPublishedProjection(root, packet, materialized.value, bytes, pinnedRoot),
    write_descriptor: materialized.value.write_descriptor,
  };
}
function finalizedPreparationState(state: CtoState): boolean {
  return state.pending?.status === "succeeded"
    && state.pending.identity.run_id === state.id
    && state.completion_envelope?.outcome === "succeeded"
    && state.completion_envelope.identity.run_id === state.id
    && state.pause?.kind === "done"
    && state.control_plane_status?.stage === "done"
    && state.control_plane_status.lifecycle === "complete";
}

function featureStatuses(
  decisions: readonly CtoSpecificationDecision[],
  preparedFeatures?: readonly { feature_id: string; run_key: string }[],
): CtoSpecificationPreparationFeatureStatus[] {
  const ordered = preparedFeatures
    ? preparedFeatures.map((feature) => ({ feature_id: feature.feature_id, run_key: feature.run_key }))
    : [...new Map(decisions.map((entry) => [`${entry.feature_id}\u0000${entry.run_key}`, { feature_id: entry.feature_id, run_key: entry.run_key }])).values()];
  return ordered.map(({ feature_id, run_key }) => {
    const entry = decisions.find((candidate) => candidate.feature_id === feature_id && candidate.run_key === run_key && candidate.phase === "tasks");
    if (!entry) throw new Error(`advanceCtoSpecificationPreparation: Tasks decision missing for '${feature_id}'`);
    return {
      feature_id,
      run_key,
      phase: entry.phase,
      checkpoint_ref: entry.checkpoint_ref,
      version: decisionVersion(entry),
      status: entry.decision,
      next_action: preparationNextAction(entry.decision),
    };
  });
}

function currentPreparationDecisions(
  state: CtoState,
  decisions: readonly CtoSpecificationDecision[],
): CtoSpecificationDecision[] {
  const prepared = (state as CtoState & {
    preparation_features?: Array<{ feature_id?: unknown; run_key?: unknown }>;
  }).preparation_features;
  if (!Array.isArray(prepared)) return [...decisions];
  const expected = new Set(
    prepared.flatMap((feature) => typeof feature.feature_id === "string" && typeof feature.run_key === "string"
      ? [`${feature.feature_id}\u0000${feature.run_key}`]
      : []),
  );
  const groups = new Map<string, CtoSpecificationDecision[]>();
  for (const decision of decisions) {
    const featureKey = `${decision.feature_id}\u0000${decision.run_key}`;
    if (!expected.has(featureKey)) continue;
    const key = `${featureKey}\u0000${decision.phase}`;
    const group = groups.get(key) ?? [];
    group.push(decision);
    groups.set(key, group);
  }
  const selected = new Set<CtoSpecificationDecision>();
  for (const group of groups.values()) {
    const versions = group.map((decision) => {
      const match = /^checkpoint\.(?:specify|plan|tasks)\.v([0-9]+)$/.exec(decision.checkpoint_ref);
      return match ? Number(match[1]) : -1;
    });
    const newest = Math.max(...versions);
    group.forEach((decision, index) => {
      if (versions[index] === newest) selected.add(decision);
    });
  }
  return decisions.filter((decision) => {
    const featureKey = `${decision.feature_id}\u0000${decision.run_key}`;
    return !expected.has(featureKey) || selected.has(decision);
  });
}

function assertExactPreparationDecisionSet(state: CtoState, decisions: readonly CtoSpecificationDecision[]): void {
  const prepared = (state as CtoState & {
    preparation_features?: Array<{ feature_id?: unknown; run_key?: unknown }>;
  }).preparation_features;
  if (!Array.isArray(prepared) || prepared.length === 0) {
    throw new Error(
      `advanceCtoSpecificationPreparation: active preparation has no scheduled preparation_features`,
    );
  }
  const expected = new Map<string, string>();
  for (const feature of prepared) {
    if (
      typeof feature.feature_id !== "string"
      || typeof feature.run_key !== "string"
      || !isSafeStateSegment(feature.feature_id)
      || !isSafeStateSegment(feature.run_key)
      || expected.has(feature.feature_id)
    ) {
      throw new Error(
        `advanceCtoSpecificationPreparation: scheduled preparation_features are invalid or duplicated`,
      );
    }
    expected.set(feature.feature_id, feature.run_key);
  }
  const seen = new Set<string>();
  for (const decision of decisions) {
    const runKey = expected.get(decision.feature_id);
    if (
      runKey === undefined
      || decision.run_key !== runKey
      || decision.phase !== "specify" && decision.phase !== "plan" && decision.phase !== "tasks"
    ) {
      throw new Error(
        `advanceCtoSpecificationPreparation: decision '${decision.trusted_answer_ref}' is outside the exact scheduled feature/run set`,
      );
    }
    const key = `${decision.feature_id}\\u0000${decision.run_key}\\u0000${decision.phase}`;
    if (seen.has(key)) {
      throw new Error(
        `advanceCtoSpecificationPreparation: duplicate terminal decision for '${decision.feature_id}' phase '${decision.phase}'`,
      );
    }
    seen.add(key);
    if (decision.decision !== "approve_continue") {
      throw new Error(
        `advanceCtoSpecificationPreparation: '${decision.feature_id}' phase '${decision.phase}' is not an approved terminal decision`,
      );
    }
  }
  const required = expected.size * 3;
  if (decisions.length !== required) {
    throw new Error(
      `advanceCtoSpecificationPreparation: expected exactly ${required} approved phase decisions for ${expected.size} scheduled feature(s), received ${decisions.length}`,
    );
  }
  for (const [featureId, runKey] of expected) {
    for (const phase of ["specify", "plan", "tasks"] as const) {
      if (!seen.has(`${featureId}\\u0000${runKey}\\u0000${phase}`)) {
        throw new Error(
          `advanceCtoSpecificationPreparation: scheduled feature '${featureId}' is missing its approved ${phase} decision`,
        );
      }
    }
  }
}
function assertPreparationWorkspacesReady(
  root: string,
  state: CtoState,
  packet: CtoSpecificationReviewPacket,
  pinnedRoot?: PinnedProjectRoot,
): void {
  const prepared = (state as CtoState & {
    preparation_features?: Array<{
      feature_id?: unknown;
      run_key?: unknown;
      profile_name?: unknown;
      profile_hash?: unknown;
    }>;
  }).preparation_features;
  if (!Array.isArray(prepared) || packet.features.length !== prepared.length) {
    throw new Error(
      `advanceCtoSpecificationPreparation: review packet does not cover the exact scheduled feature set`,
    );
  }
  const expected = new Map(prepared.map((feature) => [String(feature.feature_id), feature]));
  const rootPin = pinnedRoot ?? PinnedProjectRoot.open(root);
  if (!rootPin) throw new Error("advanceCtoSpecificationPreparation: project root cannot be pinned for handoff validation");
  const ownsRootPin = pinnedRoot === undefined;
  try {
    for (const feature of packet.features) {
      const persisted = expected.get(feature.feature_id);
      if (
        !persisted
        || persisted.run_key !== feature.run_key
        || feature.workspace_status !== "implementation_ready"
        || feature.phases.length !== 3
        || feature.phases.some((phase) => phase.status !== "approved" || phase.approved_version === null || phase.version !== phase.approved_version)
      ) {
        throw new Error(
          `advanceCtoSpecificationPreparation: feature '${feature.feature_id}' is not implementation-ready with every phase approved`,
        );
      }
      const workspaceResult = resolveFeatureWorkspace(root, { feature_id: feature.feature_id, run_key: feature.run_key }, {
        lexical_root: rootPin.lexical_root,
        canonical_root: rootPin.canonical_root,
        dev: rootPin.dev,
        ino: rootPin.ino,
        pinned_root: rootPin,
      });
      if (!workspaceResult.ok) throw new Error(`advanceCtoSpecificationPreparation: workspace '${feature.feature_id}' could not be reread: ${workspaceResult.error}`);
      const workspace = workspaceResult.value;
      if (
        workspace.project_root !== rootPin.canonical_root
        || workspace.project_root_identity.canonical_path !== rootPin.canonical_root
        || workspace.profile_name !== persisted.profile_name
        || workspace.profile_hash !== persisted.profile_hash
        || !workspace.handoff_ref
        || !isSafeStateSegment(workspace.handoff_ref)
        || !workspace.constitution_binding
      ) {
        throw new Error(`advanceCtoSpecificationPreparation: workspace '${feature.feature_id}' has an invalid implementation-ready identity`);
      }
      const handoffRelative = rootPin.relativePath(join(rootPin.canonical_root, ".work-state", "features", feature.feature_id, "artifacts", "implementation_handoff", `${workspace.handoff_ref}.json`));
      if (!handoffRelative) throw new Error(`advanceCtoSpecificationPreparation: handoff path for '${feature.feature_id}' escapes the pinned project root`);
      const loaded = readCanonicalHandoff(rootPin, handoffRelative, `canonical handoff for '${feature.feature_id}'`);
      if (!loaded.ok) throw new Error(`advanceCtoSpecificationPreparation: ${loaded.error}`);
      const canonical = loaded.handoff;
      if (
        canonical.status !== "ready"
        || canonical.feature_id !== feature.feature_id
        || canonical.handoff_id !== workspace.handoff_ref
        || canonicalHandoffDigest(canonical) !== canonical.handoff_digest
        || JSON.stringify(canonical.constitution_binding) !== JSON.stringify(workspace.constitution_binding)
      ) {
        throw new Error(`advanceCtoSpecificationPreparation: canonical handoff for '${feature.feature_id}' is stale, foreign, or tampered`);
      }
      const constitution = readPinnedCurrentConstitution(rootPin.canonical_root, rootPin, workspace.constitution_binding);
      if (!constitution.ok) throw new Error(`advanceCtoSpecificationPreparation: SPEC_CONSTITUTION_IMPACT_PENDING: ${constitution.error}`);
      if (constitutionComparable(constitution.value.binding) !== constitutionComparable(workspace.constitution_binding)
        || constitutionComparable(constitution.value.binding) !== constitutionComparable(canonical.constitution_binding)) {
        throw new Error(`advanceCtoSpecificationPreparation: live constitution binding does not match workspace or handoff '${feature.feature_id}'`);
      }
      const readiness = evaluateHandoffReadiness(canonical, { current_constitution_binding: constitution.value.binding });
      if (!readiness.ok) throw new Error(`advanceCtoSpecificationPreparation: handoff readiness for '${feature.feature_id}' failed: ${readiness.error}`);
      for (const phase of feature.phases) {
        const artifact = canonical.artifact_versions.find((candidate) => candidate.kind === phase.phase);
        if (!artifact || artifact.version !== phase.version || !canonical.approval_refs.includes(phase.checkpoint_ref ?? "")) {
          throw new Error(`advanceCtoSpecificationPreparation: handoff for '${feature.feature_id}' does not bind approved ${phase.phase} v${phase.version}`);
        }
      }
    }
    if (!rootPin.isStable()) throw new Error("advanceCtoSpecificationPreparation: project root changed during handoff validation");
  } finally {
    if (ownsRootPin) rootPin.close();
  }
}

/**
 * Build the exact review packet, materialize it before the durable terminal
 * state write, then finish the active preparation wave. Replays require the
 * already-published file to match byte-for-byte and never overwrite a
 * collision. A later implementation must be admitted as a new
 * `specification-execution` wave with a separately issued epoch.
 */
function assertPreparationOwnerSession(state: CtoState | null, ctoRunId: string, sessionId: string): void {
  if (!state) return;
  const wave = activeWave(state);
  if (state.owner_session !== sessionId || (wave !== null && wave.work_identity?.session_id !== sessionId)) {
    throw new CtoSpecificationPreparationError(
      "CTO_RUNTIME_ACCESS_INVALID",
      `CTO run "${ctoRunId}" is owned by a different authenticated session`,
    );
  }
}

function advanceCtoSpecificationPreparationUnlocked(
  root: string,
  ctoRunId: string,
  pinnedRoot: PinnedProjectRoot,
  state: CtoState,
  commitState: (next: CtoState) => void,
  assertRuntimeLive: () => void,
  markPacketTransactionCommitted: () => void,
): AdvanceCtoSpecificationPreparationResult {
  assertRuntimeLive();
  recoverReviewPacketTransaction(root, ctoRunId, pinnedRoot);
  assertRuntimeLive();
  let decisions: CtoSpecificationDecision[];
  try {
    if (!pinnedRoot.isStable()) throw new CtoSpecificationPreparationError("CTO_REVIEW_ROOT_CHANGED", `pinned project root changed before decision reread`);
    decisions = readCtoSpecificationDecisionsWhileLocked(root, ctoRunId, pinnedRoot);
    if (!pinnedRoot.isStable()) throw new CtoSpecificationPreparationError("CTO_REVIEW_ROOT_CHANGED", `pinned project root changed after decision reread`);
  } catch (error) {
    throw new Error(
      `advanceCtoSpecificationPreparation: durable preparation decisions for run '${ctoRunId}' are unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (decisions.length === 0) {
    throw new Error(
      `advanceCtoSpecificationPreparation: run '${ctoRunId}' has no trusted preparation decisions to finalize`,
    );
  }

  if (!state || state.id !== ctoRunId) {
    throw new Error(
      `advanceCtoSpecificationPreparation: CTO run '${ctoRunId}' is missing or unsafe; preparation cannot be finalized durably`,
    );
  }
  decisions = currentPreparationDecisions(state, decisions);
  if (decisions.length === 0) {
    throw new Error(
      `advanceCtoSpecificationPreparation: run '${ctoRunId}' has no current trusted preparation decisions to finalize`,
    );
  }
  assertExactPreparationDecisionSet(state, decisions);
  const scheduledFeatureIds = new Set(
    ((state as CtoState & { preparation_features?: Array<{ feature_id?: unknown }> }).preparation_features ?? [])
      .map((feature) => String(feature.feature_id)),
  );

  const packet = pinnedRoot
    ? buildCtoSpecificationReviewPacketFromDecisionSnapshotPinned(
      pinnedRoot,
      { cto_run_id: ctoRunId },
      decisions,
      scheduledFeatureIds,
    )
    : buildCtoSpecificationReviewPacketFromDecisionSnapshot(
      root,
      { cto_run_id: ctoRunId },
      decisions,
    );
  if (!packet.ok) {
    throw new Error(
      `advanceCtoSpecificationPreparation: review packet for run '${ctoRunId}' could not be built: ${packet.code}: ${packet.error}`,
    );
  }
  if (packet.value.recorded_decisions.length !== decisions.length) {
    throw new Error(
      `advanceCtoSpecificationPreparation: review packet omitted one or more exact phase decisions`,
    );
  }
  for (const [index, decision] of decisions.entries()) {
    const recorded = packet.value.recorded_decisions[index];
    if (
      !recorded
      || recorded.feature_id !== decision.feature_id
      || recorded.run_key !== decision.run_key
      || recorded.phase !== decision.phase
      || recorded.checkpoint_ref !== decision.checkpoint_ref
      || recorded.trusted_answer_ref !== decision.trusted_answer_ref
    ) {
      throw new Error(
        `advanceCtoSpecificationPreparation: review packet changed one or more exact phase decisions while being built`,
      );
    }
  }
  assertPreparationWorkspacesReady(root, state, packet.value, pinnedRoot);
  const features = featureStatuses(decisions, (state as CtoState & { preparation_features?: Array<{ feature_id: string; run_key: string }> }).preparation_features);

  const wave = activeWave(state);
  if (!wave) {
    if (!finalizedPreparationState(state)) {
      throw new Error(
        `advanceCtoSpecificationPreparation: run '${ctoRunId}' has no active specification-preparation wave`,
      );
    }
    let packetPath: string;
    try {
      const existing = readExistingReviewPacket(root, packet.value, pinnedRoot);
      if (existing === null) {
        throw new CtoSpecificationPreparationError(
          "CTO_REVIEW_PACKET_MISSING",
          `finalized run '${ctoRunId}' has no readable review packet`,
        );
      }
      const expected = renderExpectedReplayBytes(packet.value);
      if (!existing.equals(expected)) {
        throw new CtoSpecificationPreparationError(
          "CTO_REVIEW_PACKET_COLLISION",
          `existing review packet for run '${ctoRunId}' differs from the exact packet bytes`,
        );
      }
      if (pinnedRoot && !pinnedRoot.isStable()) throw new CtoSpecificationPreparationError("CTO_REVIEW_ROOT_CHANGED", "pinned project root changed during completed replay");
      packetPath = pinnedRoot
        ? join(pinnedRoot.lexical_root, ".work-state", "cto", ctoRunId, REVIEW_PACKET_DOC)
        : reviewPacketPath(root, ctoRunId, false);
      if (state.completion_envelope?.evidence_ref !== packetPath) {
        throw new CtoSpecificationPreparationError(
          "CTO_REVIEW_PACKET_REPLAY_INVALID",
          `completed run '${ctoRunId}' does not bind its evidence reference to the canonical packet path`,
        );
      }
    } catch (error) {
      if (error instanceof CtoSpecificationPreparationError) throw error;
      throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_REPLAY_INVALID", String(error));
    }
    return {
      cto_run_id: ctoRunId,
      features,
      review_packet_ref: packetPath,
      execution_started: false,
      hard_stop: true,
    };
  }
  if (wave.source !== "specification-preparation") {
    throw new Error(
      `advanceCtoSpecificationPreparation: run '${ctoRunId}' has no active specification-preparation wave`,
    );
  }
  const identity = wave.work_identity;
  if (
    !identity
    || identity.run_id !== ctoRunId
    || identity.wave_id !== wave.id
    || identity.workflow !== "spec-preparation"
    || !isSafeStateSegment(identity.capability_id)
    || !isSafeStateSegment(identity.capability_epoch)
  ) {
    throw new Error(
      `advanceCtoSpecificationPreparation: active preparation wave has no exact engine-issued capability identity`,
    );
  }
  const preparationFeatures = (state as CtoState & {
    preparation_features?: Array<{ feature_id?: unknown; run_key?: unknown; request_id?: unknown; phase_writer_id?: unknown }>;
  }).preparation_features;
  if (
    !state.work_identity
    || JSON.stringify(state.work_identity) !== JSON.stringify(identity)
    || !Array.isArray(preparationFeatures)
    || preparationFeatures.length === 0
    || JSON.stringify(wave.slice_ids) !== JSON.stringify(preparationFeatures.map((feature) => feature.phase_writer_id))
  ) {
    throw new Error(
      `advanceCtoSpecificationPreparation: preparation capability or scheduled slice graph is not exact`,
    );
  }
  const expectedTeams = preparationFeatures.map((feature) => ({
    id: ctoPreparationTeamId(String(feature.request_id)),
    feature_id: String(feature.feature_id),
    run_key: String(feature.run_key),
    task_id: String(feature.request_id),
    slice_id: String(feature.phase_writer_id),
  }));
  if (
    state.teams.length !== expectedTeams.length
    || expectedTeams.some((expected) => {
      const team = state.teams.find((candidate) => candidate.id === expected.id);
      return !team
        || team.status !== "pending"
        || team.feature_id !== expected.feature_id
        || team.run_key !== expected.run_key
        || team.task_id !== expected.task_id
        || team.slice_id !== expected.slice_id
        || team.workflow !== "spec-preparation"
        || JSON.stringify(team.work_identity) !== JSON.stringify(state.work_identity);
    })
  ) {
    throw new Error(
      `advanceCtoSpecificationPreparation: scheduled team graph is not exact`,
    );
  }

  // The packet is built from the exact decision/workspace view observed
  // inside the authenticated run transaction. The transaction lock prevents
  // a cooperating state writer from changing that view while bytes publish.
  assertPreparationConstitutionFresh(root, state, pinnedRoot);
  injectPreparationFailure("before_artifact_write");
  assertPreparationConstitutionFresh(root, state, pinnedRoot);
  const packetBefore = reviewPacketImage(pinnedRoot, packet.value);
  const packetExpected = packetBefore?.bytes ?? renderExpectedReplayBytes(packet.value);
  let packetTransaction: ReviewPacketPublicationTransaction | null = null;
  if (packetBefore === null) {
    packetTransaction = {
      schema_version: 1,
      cto_run_id: ctoRunId,
      packet_ref: packet.value.packet_ref,
      path: reviewPacketRelativePath(packet.value),
      before_content: null,
      before_digest: createHash("sha256").update("").digest("hex"),
      after_content: packetExpected.toString("utf8"),
      after_digest: createHash("sha256").update(packetExpected).digest("hex"),
      constitution_bindings: captureReviewPacketConstitutionBindings(root, state, pinnedRoot),
    };
    assertRuntimeLive();
    persistReviewPacketTransaction(root, packetTransaction, pinnedRoot);
    assertRuntimeLive();
  }
  let packetPath: string;
  let packetPrePublishForeign = false;
  const beforePacketPublish = (receipt: PinnedRootWriteReceipt): void => {
    if (!packetTransaction) throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_CONFLICT", "packet write receipt arrived without a registered publication WAL");
    assertRuntimeLive();
    if (receipt.preimage.kind !== "absent") {
      packetPrePublishForeign = true;
      throw new CtoSpecificationPreparationError("CTO_REVIEW_PACKET_COLLISION", "a competing review packet appeared before publication");
    }
    packetTransaction.postimage_descriptor = receipt.descriptor;
    assertRuntimeLive();
    persistReviewPacketTransaction(root, packetTransaction, pinnedRoot);
    assertRuntimeLive();
    injectPreparationFailure("before_packet_publish");
  };
  try {
    assertRuntimeLive();
    const packetPublication = materializeOrVerifyReviewPacket(root, packet.value, pinnedRoot, state, beforePacketPublish);
    assertRuntimeLive();
    packetPath = packetPublication.path;
    if (packetTransaction && !packetPublication.write_descriptor) {
      // A concurrent writer won between preflight and publication. We verified
      // its exact canonical bytes but did not publish or own its inode.
      assertRuntimeLive();
      removeReviewPacketTransaction(root, ctoRunId, pinnedRoot);
      assertRuntimeLive();
      packetTransaction = null;
    }
  } catch (error) {
    if (packetTransaction && packetPrePublishForeign) {
      assertRuntimeLive();
      removeReviewPacketTransaction(root, ctoRunId, pinnedRoot);
      assertRuntimeLive();
      packetTransaction = null;
    }

    if (packetTransaction) assertRuntimeLive();
    if (packetTransaction && rollbackCreatedReviewPacket(pinnedRoot, packet.value, packetBefore, packetExpected, packetTransaction?.postimage_descriptor)) {
      assertRuntimeLive();
      removeReviewPacketTransaction(root, ctoRunId, pinnedRoot);
      assertRuntimeLive();
    }
    throw error;
  }
  // This boundary intentionally occurs after the atomic packet write and
  // before the terminal state CAS; a crash here is replayed through the WAL.
  injectPreparationFailure("after_artifact_write");
  const emittedAt = new Date().toISOString();
  const finalized = applyFinishWaveTransition(state, { id: wave.id, status: "done", now: emittedAt });
  finalized.work_identity = identity;
  finalized.pending = {
    identity,
    status: "succeeded",
    terminal_signal: "native_tool_result",
    updated_at: emittedAt,
  };
  finalized.completion_envelope = {
    schema_version: 1,
    identity,
    outcome: "succeeded",
    terminal_signal: "native_tool_result",
    artifact_refs: [],
    evidence_ref: packetPath,
    conflict_ref: null,
    completed_by: "engine_task_caller",
    emitted_at: emittedAt,
  };
  finalized.control_plane_status = {
    stage: "done",
    lifecycle: "complete",
    pause: "done",
    reason: "Specification preparation finalized; execution requires a new engine-issued execution wave and capability epoch.",
  };
  finalized.pause = {
    kind: "done",
    reason: "Specification preparation hard-stopped after review packet finalization.",
  };
  let stateWriteStarted = false;
  try {
    injectPreparationFailure("before_state_write");
    stateWriteStarted = true;
    assertPreparationConstitutionFresh(root, state, pinnedRoot);
    assertRuntimeLive();
    commitState(finalized);
    assertRuntimeLive();
  } catch (error) {
    if (stateWriteStarted && packetTransaction) {
      assertRuntimeLive();
      const rolledBack = rollbackCreatedReviewPacket(pinnedRoot, packet.value, packetBefore, packetExpected, packetTransaction?.postimage_descriptor);
      assertRuntimeLive();
      if (rolledBack) {
        assertRuntimeLive();
        removeReviewPacketTransaction(root, ctoRunId, pinnedRoot);
        assertRuntimeLive();
      }
    }
    if (error instanceof CtoSpecificationPreparationError) throw error;
    const errorCode = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    const errorMessage = String(error);
    if (
      errorCode === "CTO_STATE_CONFLICT"
      || (errorCode === "runtime_access_invalid" && /state (?:changed|proof)|proof recovery|state CAS/i.test(errorMessage))
    ) {
      throw new CtoSpecificationPreparationError("CTO_STATE_CONFLICT", errorMessage);
    }
    throw new CtoSpecificationPreparationError(
      "CTO_STATE_FINALIZATION_FAILED",
      String(error),
    );
  }
  injectPreparationFailure("after_state_write");
  if (packetTransaction) {
    assertRuntimeLive();
    // The runtime transaction callback has only staged the CTO state here;
    // its outer commit still owns the state/index CAS. Defer WAL removal until
    // that commit returns successfully so any failure retains recovery proof.
    markPacketTransactionCommitted();
    assertRuntimeLive();
  }

  return {
    cto_run_id: ctoRunId,
    features,
    review_packet_ref: packetPath,
    execution_started: false,
    hard_stop: true,
  };
}


/** Recheck every selected preparation workspace without reacquiring the constitution lock. */
function assertPreparationConstitutionFresh(root: string, state: CtoState, pinnedRoot: PinnedProjectRoot): void {
  const features = (state as CtoState & { preparation_features?: Array<{ feature_id?: unknown; run_key?: unknown }> }).preparation_features;
  if (!Array.isArray(features)) return;
  for (const feature of features) {
    if (typeof feature.feature_id !== "string" || typeof feature.run_key !== "string") {
      throw new Error("advanceCtoSpecificationPreparation: preparation feature identity is malformed");
    }
    const workspace = resolveFeatureWorkspace(root, { feature_id: feature.feature_id, run_key: feature.run_key }, {
      lexical_root: pinnedRoot.lexical_root,
      canonical_root: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
      pinned_root: pinnedRoot,
    });
    if (!workspace.ok || !workspace.value.constitution_binding) {
      throw new Error(`advanceCtoSpecificationPreparation: constitution workspace '${feature.feature_id}' is unavailable`);
    }
    const current = readPinnedCurrentConstitution(pinnedRoot.canonical_root, pinnedRoot, workspace.value.constitution_binding);
    if (!current.ok) throw new Error(`advanceCtoSpecificationPreparation: SPEC_CONSTITUTION_IMPACT_PENDING: ${current.error}`);
    if (constitutionComparable(current.value.binding) !== constitutionComparable(workspace.value.constitution_binding)) {
      throw new Error(`advanceCtoSpecificationPreparation: live constitution binding changed for '${feature.feature_id}'`);
    }
  }
}

/** Mutating constitution bootstrap must precede the per-run lock (constitution -> run). */
function ensurePreparationConstitutionBeforeRunLock(
  root: string,
  pinnedRoot: PinnedProjectRoot,
  state: CtoState | null,
  assertRuntimeLive: () => void,
): void {
  const features = (state as CtoState & { preparation_features?: Array<{ feature_id?: unknown; run_key?: unknown }> } | null)?.preparation_features;
  if (!Array.isArray(features)) return;
  for (const feature of features) {
    if (typeof feature.feature_id !== "string" || typeof feature.run_key !== "string") {
      throw new Error("advanceCtoSpecificationPreparation: preparation feature identity is malformed");
    }
    const workspace = resolveFeatureWorkspace(root, { feature_id: feature.feature_id, run_key: feature.run_key }, {
      lexical_root: pinnedRoot.lexical_root,
      canonical_root: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
      pinned_root: pinnedRoot,
    }, { persistMigration: false, requireMigration: true });
    // Leave malformed/symlinked workspaces to the locked canonical packet
    // validation so callers retain its precise fail-closed diagnostic.
    if (!workspace.ok) continue;
    assertRuntimeLive();
    const ensured = ensureProjectConstitution(root, {
      origin_kind: "cto_preparation",
      origin_run_key: feature.run_key,
      origin_stage: "cto",
    }, { feature_id: feature.feature_id, pinnedRoot });
    assertRuntimeLive();
    if (!ensured.ok) throw new Error(`advanceCtoSpecificationPreparation: ${ensured.code}: ${ensured.error}`);
    if (ensured.value.status !== "usable" || !ensured.value.binding) {
      throw new Error(`advanceCtoSpecificationPreparation: SPEC_CONSTITUTION_IMPACT_PENDING: live constitution prerequisite is ${ensured.value.status}`);
    }
  }
}

/**
 * Finalize specification preparation as one serialized CTO transition. The
 * lock deliberately spans the final eligibility reread, workspace/decision
 * packet projection, packet publication, and terminal state CAS.
 */
export function advanceCtoSpecificationPreparation(
  projectRoot: string,
  input: { cto_run_id: string },
  options: { runtimeAccess: CtoRuntimeAccessFacade; sessionId: string },
): AdvanceCtoSpecificationPreparationResult {
  if (
    !input
    || typeof input !== "object"
    || !isSafeCtoRunId(input.cto_run_id)
    || !isSafeStateSegment(input.cto_run_id)
  ) {
    throw new Error("advanceCtoSpecificationPreparation: cto_run_id must be a canonical safe state segment");
  }
  const ctoRunId = input.cto_run_id;
  if (!options?.runtimeAccess || typeof options.sessionId !== "string" || options.sessionId.length === 0) {
    throw new CtoSpecificationPreparationError("CTO_RUNTIME_ACCESS_REQUIRED", "live runtime access and authenticated session are required for CTO preparation finalization");
  }
  const root = canonicalProjectRoot(projectRoot);
  const assertRuntimeLive = () => assertCtoRuntimeAccessFacadeLive(options.runtimeAccess, root, options.sessionId);
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new CtoSpecificationPreparationError("CTO_REVIEW_ROOT_INVALID", "project root cannot be pinned for CTO preparation finalization");
  try {
    try {
      assertRuntimeLive();
    } catch (error) {
      throw new CtoSpecificationPreparationError("CTO_RUNTIME_ACCESS_INVALID", String(error));
    }
    if (!pinnedRoot.isStable()) throw new CtoSpecificationPreparationError("CTO_REVIEW_ROOT_CHANGED", "pinned project root changed before CTO preparation finalization");
    assertRuntimeLive();
    const projectedState = options.runtimeAccess.readState(ctoRunId) as unknown as CtoState | null;
    assertRuntimeLive();
    assertPreparationOwnerSession(projectedState, ctoRunId, options.sessionId);
    recoverReviewPacketTransaction(root, ctoRunId, pinnedRoot);
    assertRuntimeLive();
    try {
      ensurePreparationConstitutionBeforeRunLock(root, pinnedRoot, projectedState, assertRuntimeLive);
      assertRuntimeLive();
      let packetTransactionCommitted = false;
      const result = options.runtimeAccess.withRunTransaction(ctoRunId, (transaction) => {
        assertRuntimeLive();
        const state = transaction.readState();
        assertPreparationOwnerSession(state, ctoRunId, options.sessionId);
        assertRuntimeLive();
        return advanceCtoSpecificationPreparationUnlocked(
          root,
          ctoRunId,
          pinnedRoot,
          state,
          (next) => { assertRuntimeLive(); transaction.writeState(next); assertRuntimeLive(); },
          assertRuntimeLive,
          () => { packetTransactionCommitted = true; },
        );
      });
      if (packetTransactionCommitted) {
        assertRuntimeLive();
        removeReviewPacketTransaction(root, ctoRunId, pinnedRoot);
        assertRuntimeLive();
      }
      return result;
    } catch (error) {
      if (error instanceof CtoSpecificationPreparationError && error.code === "CTO_REVIEW_ROOT_CHANGED") throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/pinned project root changed|root changed|root is unstable/i.test(message)) {
        throw new CtoSpecificationPreparationError("CTO_REVIEW_ROOT_CHANGED", message);
      }
      throw error;
    }
  } finally {
    pinnedRoot.close();
  }
}
