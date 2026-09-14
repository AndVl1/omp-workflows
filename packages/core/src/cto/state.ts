/**
 * CtoState persistence + transitions.
 *
 * State lives in files (`.work-state/cto/<id>/state.json`) so parked teams
 * and pending escalations survive restarts, machine sleep, and compaction
 * (R7). The engine is the only writer; agents read through it.
 */

import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import { assertCurrentExecutionLiveness } from "../execution-liveness.js";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ModelClassification } from "../engine/run.js";
import {
  MAX_CTO_SPECIFICATION_TEXT_BYTES,
  MAX_PREPARATION_QUEUE_ITEMS,
  type CtoState,
  type BudgetState,
  type CtoControlPlaneFields,
  type EscalationRecord,
  type EscalationStatus,
  type CtoPendingDeliveryObligation,
  type CtoTerminalSummaryEvidence,
  type CtoDeliveryIntent,
  type TeamRunStatus,
  type TeamPlan,
  type WaveRecord,
  CTO_CONFORMANCE_RECEIPT_REF_RE,
} from "./types.js";
import { validateTypedControlPlane } from "../engine/workflow-contract.js";
import type { ControlPlaneProvenance, WorkIdentity } from "../engine/types.js";
import { PinnedProjectRoot, PinnedRootError, processStartIdentity, type PinnedRootPathEntryInfo, type PinnedRootWriteReceipt } from "../specification/pinned-root.js";
import { isCtoRuntimeDeliveryCapability } from "./runtime-access.js";
import { isSafeFeatureId, isSha256Hex } from "../specification/validation.js";
import { canonicalDurableIdFileName, safeLegacyDurableIdFileName } from "./durable-id.js";
import { withCtoRunLock } from "./transaction-lock.js";
import { validateEscalation } from "./escalation.js";
import { readOrCreateRootRuntimeSecret, deriveRuntimeSecretKey } from "../runtime-secret.js";
function errnoCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const CTO_OUTBOX_PUBLICATION_TRUST_ROOT_KEY = Symbol.for("omp.cto.outbox.publication-trust-root");
const ctoOutboxTrustGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown };
const CTO_OUTBOX_PUBLICATION_TRUST_ROOT = (() => {
  const existing = ctoOutboxTrustGlobal[CTO_OUTBOX_PUBLICATION_TRUST_ROOT_KEY];
  if (Buffer.isBuffer(existing) && existing.byteLength === 32) return existing;
  const generated = randomBytes(32);
  Object.defineProperty(globalThis, CTO_OUTBOX_PUBLICATION_TRUST_ROOT_KEY, {
    value: generated,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return generated;
})();
const CTO_RUNTIME_ORIGIN_PROOF_FILE = ".runtime-origin-proof.json";
function ctoRuntimeOriginRelativePath(runId: string): string {
  return join(".work-state", "cto", runId, CTO_RUNTIME_ORIGIN_PROOF_FILE);
}
function ctoRuntimeOriginIdentity(state: CtoState): string {
  return createHash("sha256").update(JSON.stringify({ id: state.id, task: state.task, branch: state.branch, autonomous: state.autonomous, standby: state.standby === true, owner_session: state.owner_session ?? null }), "utf8").digest("hex");
}
function indexedCtoRunOriginsValidPinned(pinnedRoot: PinnedProjectRoot, entries: readonly CtoRunDeliveryIndexEntry[]): boolean {
  for (const entry of entries) {
    const state = readCtoStatePinned(entry.run_id, pinnedRoot);
    if (!state || state.id !== entry.run_id || !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state)) return false;
  }
  return true;
}
export function ctoRuntimeRunInitialIdentityDigest(state: CtoState): string { return ctoRuntimeOriginIdentity(state); }
function ctoRuntimeOriginProofValue(pinnedRoot: PinnedProjectRoot, runId: string, ownerSession: string | null, standby: boolean, identity: string, sourceId: string, initialDigest: string): string | null {
  const master = readOrCreateRootRuntimeSecret(pinnedRoot);
  const key = master ? deriveRuntimeSecretKey(master, "cto-run-origin-v1") : null;
  if (!key) return null;
  return createHmac("sha256", key).update(["omp-cto-runtime-origin-v1", pinnedRoot.canonical_root, String(pinnedRoot.dev), String(pinnedRoot.ino), runId, ownerSession ?? "", standby ? "standby" : "owner", identity, sourceId, initialDigest].join("\u0000"), "utf8").digest("hex");
}
export function mintCtoRuntimeRunOrigin(pinnedRoot: PinnedProjectRoot, state: CtoState, ownerSession: string, sourceId = "runtime-access", initialDigest = ctoRuntimeOriginIdentity(state)): boolean {
  if (!pinnedRoot.isStable() || !isSafeCtoRunId(state?.id) || typeof ownerSession !== "string" || ownerSession.length === 0) return false;
  const identity = ctoRuntimeOriginIdentity(state); const owner = state.standby === true ? null : ownerSession; if (typeof sourceId !== "string" || sourceId.length === 0 || !/^[0-9a-f]{64}$/u.test(initialDigest)) return false; const proof = ctoRuntimeOriginProofValue(pinnedRoot, state.id, owner, state.standby === true, identity, sourceId, initialDigest);
  const payload = JSON.stringify({ schema_version: 1, run_id: state.id, root_dev: pinnedRoot.dev, root_ino: pinnedRoot.ino, owner_session: owner, standby: state.standby === true, identity_sha256: identity, source_id: sourceId, initial_state_sha256: initialDigest, proof }) + "\n"; const path = ctoRuntimeOriginRelativePath(state.id);
  try { pinnedRoot.ensureDirectories([join(".work-state", "cto", state.id)]); const existing = pinnedRoot.readFile(path, { maxBytes: 16 * 1024 }); return decodeUtf8(existing.bytes) === payload; } catch (error) { if (pinnedStateErrorCode(error) !== "not_found") return false; try { pinnedRoot.writeExclusive(path, Buffer.from(payload, "utf8")); return true; } catch { return false; } }
}
export function refreshCtoRuntimeRunOriginPinned(pinnedRoot: PinnedProjectRoot, state: CtoState, ownerSession: string, sourceId: string, initialDigest = ctoRuntimeOriginIdentity(state)): boolean {
  if (!pinnedRoot.isStable() || !isSafeCtoRunId(state?.id) || typeof ownerSession !== "string" || ownerSession.length === 0 || typeof sourceId !== "string" || sourceId.length === 0 || !/^[0-9a-f]{64}$/u.test(initialDigest)) return false;
  const identity = ctoRuntimeOriginIdentity(state); const owner = state.standby === true ? null : ownerSession;
  const proof = ctoRuntimeOriginProofValue(pinnedRoot, state.id, owner, state.standby === true, identity, sourceId, initialDigest);
  if (!proof) return false;
  const payload = Buffer.from(JSON.stringify({ schema_version: 1, run_id: state.id, root_dev: pinnedRoot.dev, root_ino: pinnedRoot.ino, owner_session: owner, standby: state.standby === true, identity_sha256: identity, source_id: sourceId, initial_state_sha256: initialDigest, proof }) + "\n", "utf8");
  const path = ctoRuntimeOriginRelativePath(state.id);
  try {
    const current = pinnedRoot.readFile(path, { maxBytes: 16 * 1024 });
    const prior = readCtoRuntimeRunOriginHandoffPinned(pinnedRoot, state.id);
    if (!prior || prior.source_id !== sourceId) return false;
    return pinnedRoot.replaceFileIfMatches(path, { dev: current.dev, ino: current.ino, sha256: createHash("sha256").update(current.bytes).digest("hex") }, payload), true;
  } catch { return false; }
}
const CTO_RUNTIME_STATE_PROOF_FILE = ".runtime-state-proof.json";
function ctoRuntimeStateProofPath(runId: string): string { return join(".work-state", "cto", runId, CTO_RUNTIME_STATE_PROOF_FILE); }
function ctoRuntimeStateProofValue(pinnedRoot: PinnedProjectRoot, runId: string, revision: number, stateSha256: string, previousSha256: string | null): string | null {
  const master = readOrCreateRootRuntimeSecret(pinnedRoot); const key = master ? deriveRuntimeSecretKey(master, "cto-state-v1") : null;
  if (!key) return null;
  return createHmac("sha256", key).update(["omp-cto-runtime-state-v1", pinnedRoot.canonical_root, String(pinnedRoot.dev), String(pinnedRoot.ino), runId, String(revision), stateSha256, previousSha256 ?? ""].join("\u0000"), "utf8").digest("hex");
}
function readCtoRuntimeStateProofRecordPinned(pinnedRoot: PinnedProjectRoot, runId: string): Record<string, unknown> | null {
  try {
    return JSON.parse(decodeUtf8(pinnedRoot.readFile(ctoRuntimeStateProofPath(runId), { maxBytes: 16 * 1024 }).bytes)) as Record<string, unknown>;
  } catch { return null; }
}

function validCtoRuntimeStateProofRecordPinned(
  pinnedRoot: PinnedProjectRoot,
  state: CtoState,
  raw: Record<string, unknown>,
  expectedStateSha256?: string,
): boolean {
  const previous = raw.previous_sha256 === null ? null : raw.previous_sha256;
  const stateSha256 = raw.state_sha256;
  if (raw.schema_version !== 1 || raw.run_id !== state.id || raw.root_dev !== pinnedRoot.dev || raw.root_ino !== pinnedRoot.ino
    || !Number.isSafeInteger(raw.state_revision) || (raw.state_revision as number) < 1
    || typeof stateSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(stateSha256)
    || (expectedStateSha256 !== undefined && stateSha256 !== expectedStateSha256)
    || (previous !== null && (typeof previous !== 'string' || !/^[0-9a-f]{64}$/u.test(previous)))
    || typeof raw.proof !== 'string' || !/^[0-9a-f]{64}$/u.test(raw.proof)) return false;
  return raw.proof === ctoRuntimeStateProofValue(pinnedRoot, state.id, raw.state_revision as number, stateSha256, previous as string | null);
}

/** Publish a proof for the exact state bytes, refusing to overwrite a present-invalid proof. */
export function writeCtoRuntimeStateProof(pinnedRoot: PinnedProjectRoot, state: CtoState): boolean {
  if (!pinnedRoot.isStable() || !state || !isSafeCtoRunId(state.id) || !Number.isSafeInteger(state.state_revision) || (state.state_revision as number) < 0) return false;
  try {
    const bytes = pinnedRoot.readFile(join('.work-state', 'cto', state.id, 'state.json'), { maxBytes: MAX_CTO_STATE_READ_BYTES }).bytes;
    const stateSha256 = createHash('sha256').update(bytes).digest('hex');
    let previousSha256: string | null = null;
    const proofInfo = pinnedRoot.pathEntryInfo(ctoRuntimeStateProofPath(state.id));
    if (proofInfo !== null) {
      if (proofInfo.kind !== 'file') return false;
      const previous = readCtoRuntimeStateProofRecordPinned(pinnedRoot, state.id);
      if (!previous || !validCtoRuntimeStateProofRecordPinned(pinnedRoot, state, previous)) return false;
      if (previous.state_sha256 === stateSha256 && previous.state_revision === state.state_revision) return true;
      previousSha256 = previous.state_sha256 as string;
      if (previousSha256 === stateSha256) return false;
    }
    const proof = ctoRuntimeStateProofValue(pinnedRoot, state.id, state.state_revision as number, stateSha256, previousSha256);
    if (!proof) return false;
    const payload = JSON.stringify({ schema_version: 1, run_id: state.id, root_dev: pinnedRoot.dev, root_ino: pinnedRoot.ino, state_revision: state.state_revision, state_sha256: stateSha256, previous_sha256: previousSha256, proof }) + '\n';
    const path = ctoRuntimeStateProofPath(state.id);
    if (proofInfo === null) pinnedRoot.writeExclusive(path, Buffer.from(payload, 'utf8'));
    else {
      const current = pinnedRoot.readFile(path, { maxBytes: 16 * 1024 });
      pinnedRoot.replaceFileIfMatches(path, { dev: current.dev, ino: current.ino, sha256: createHash('sha256').update(current.bytes).digest('hex') }, Buffer.from(payload, 'utf8'));
    }
    return true;
  } catch { return false; }
}

export type CtoRuntimeStateProofStatus = "absent" | "valid" | "invalid";
export function ctoRuntimeStateProofStatusPinned(pinnedRoot: PinnedProjectRoot, state: CtoState): CtoRuntimeStateProofStatus {
  if (!pinnedRoot.isStable() || !state || !isSafeCtoRunId(state.id)) return "invalid";
  try {
    const info = pinnedRoot.pathEntryInfo(ctoRuntimeStateProofPath(state.id));
    if (info === null) return "absent";
    if (info.kind !== "file") return "invalid";
  } catch {
    return "invalid";
  }
  return hasValidCtoRuntimeStateProofPinned(pinnedRoot, state) ? "valid" : "invalid";
}

export function hasValidCtoRuntimeStateProofPinned(pinnedRoot: PinnedProjectRoot, state: CtoState): boolean {
  if (!pinnedRoot.isStable() || !state || !isSafeCtoRunId(state.id)) return false;
  try {
    const bytes = pinnedRoot.readFile(join('.work-state', 'cto', state.id, 'state.json'), { maxBytes: MAX_CTO_STATE_READ_BYTES }).bytes;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const raw = readCtoRuntimeStateProofRecordPinned(pinnedRoot, state.id);
    return !!raw && validCtoRuntimeStateProofRecordPinned(pinnedRoot, state, raw, digest) && raw.state_revision === state.state_revision;
  } catch { return false; }
}

export function hasCtoRuntimeRunOriginHandoffPinned(pinnedRoot: PinnedProjectRoot, state: CtoState, ownerSession: string, sourceId: string, initialDigest: string): boolean {
  // The origin HMAC is independent of the state proof. This allows a
  // proofless crash-created state to be authenticated before its proof is
  // rebuilt, while present-invalid state proofs remain unrecoverable.
  if (!pinnedRoot.isStable() || !state || !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state)) return false;
  try {
    const raw = JSON.parse(decodeUtf8(pinnedRoot.readFile(ctoRuntimeOriginRelativePath(state.id), { maxBytes: 16 * 1024 }).bytes)) as Record<string, unknown>;
    return raw.source_id === sourceId && raw.initial_state_sha256 === initialDigest && raw.owner_session === (state.standby === true ? null : ownerSession) && raw.root_dev === pinnedRoot.dev && raw.root_ino === pinnedRoot.ino;
  } catch { return false; }
}
export interface CtoRuntimeRunOriginHandoffRead {
  readonly run_id: string;
  readonly owner_session: string | null;
  readonly standby: boolean;
  readonly identity_sha256: string;
  readonly source_id: string;
  readonly initial_state_sha256: string;
}
export function readCtoRuntimeRunOriginHandoffPinned(pinnedRoot: PinnedProjectRoot, runId: string): CtoRuntimeRunOriginHandoffRead | null {
  if (!pinnedRoot.isStable() || !isSafeCtoRunId(runId)) return null;
  try {
    const parsed = JSON.parse(decodeUtf8(pinnedRoot.readFile(ctoRuntimeOriginRelativePath(runId), { maxBytes: 16 * 1024 }).bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const keys = ["identity_sha256", "initial_state_sha256", "owner_session", "proof", "root_dev", "root_ino", "run_id", "schema_version", "source_id", "standby"].sort().join("\u0000");
    if (Object.keys(value).sort().join("\u0000") !== keys || value.schema_version !== 1 || value.run_id !== runId || value.root_dev !== pinnedRoot.dev || value.root_ino !== pinnedRoot.ino || typeof value.standby !== "boolean" || (value.owner_session !== null && typeof value.owner_session !== "string") || typeof value.identity_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.identity_sha256) || typeof value.source_id !== "string" || value.source_id.length === 0 || typeof value.initial_state_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.initial_state_sha256) || typeof value.proof !== "string" || !/^[0-9a-f]{64}$/u.test(value.proof)) return null;
    const expected = ctoRuntimeOriginProofValue(pinnedRoot, runId, value.owner_session as string | null, value.standby, value.identity_sha256, value.source_id, value.initial_state_sha256);
    if (!expected || expected !== value.proof) return null;
    return { run_id: runId, owner_session: value.owner_session as string | null, standby: value.standby, identity_sha256: value.identity_sha256, source_id: value.source_id, initial_state_sha256: value.initial_state_sha256 };
  } catch { return null; }
}

export function hasValidCtoRuntimeRunOriginPinned(pinnedRoot: PinnedProjectRoot, state: CtoState): boolean {
  if (!pinnedRoot.isStable() || !state || !isSafeCtoRunId(state.id)) return false;
  try { const parsed = JSON.parse(decodeUtf8(pinnedRoot.readFile(ctoRuntimeOriginRelativePath(state.id), { maxBytes: 16 * 1024 }).bytes)) as Record<string, unknown>; const owner = state.standby === true ? null : state.owner_session ?? null; const sourceId = parsed.source_id; const initialDigest = parsed.initial_state_sha256; return parsed.schema_version === 1 && parsed.run_id === state.id && parsed.root_dev === pinnedRoot.dev && parsed.root_ino === pinnedRoot.ino && parsed.owner_session === owner && parsed.standby === (state.standby === true) && parsed.identity_sha256 === ctoRuntimeOriginIdentity(state) && typeof sourceId === "string" && sourceId.length > 0 && typeof initialDigest === "string" && /^[0-9a-f]{64}$/u.test(initialDigest) && typeof parsed.proof === "string" && parsed.proof === ctoRuntimeOriginProofValue(pinnedRoot, state.id, owner, state.standby === true, parsed.identity_sha256 as string, sourceId, initialDigest); } catch { return false; }
}


function ensureDirectoryComponent(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`state directory must not be a symlink: ${path}`);
    if (!stat.isDirectory()) throw new Error(`state path component is not a directory: ${path}`);
    return;
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`state directory was replaced while being created: ${path}`);
  }
}

function verifiedAtomicTarget(path: string): { parent: string; target: string } {
  const absoluteTarget = resolve(path);
  const lexicalParent = dirname(absoluteTarget);
  const descendants: string[] = [];
  let boundary = lexicalParent;
  while (basename(boundary) !== ".work-state") {
    const next = dirname(boundary);
    if (next === boundary) {
      const parent = realpathSync(lexicalParent);
      const parentStat = lstatSync(parent);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw new Error(`atomic write parent is not a verified directory: ${lexicalParent}`);
      }
      return { parent, target: join(parent, basename(absoluteTarget)) };
    }
    descendants.unshift(basename(boundary));
    boundary = next;
  }

  const canonicalProject = realpathSync(dirname(boundary));
  let parent = join(canonicalProject, ".work-state");
  ensureDirectoryComponent(parent);
  for (const segment of descendants) {
    if (!segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error(`unsafe workflow state directory segment: ${segment}`);
    }
    parent = join(parent, segment);
    ensureDirectoryComponent(parent);
  }
  const canonicalParent = realpathSync(parent);
  if (canonicalParent !== parent) throw new Error(`workflow state parent contains a symlink: ${lexicalParent}`);
  return { parent: canonicalParent, target: join(canonicalParent, basename(absoluteTarget)) };
}

export function ensureSecureStateDirectory(path: string): string {
  return verifiedAtomicTarget(join(path, ".omp-directory-check")).parent;
}


function fsyncParent(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (error) {
    const code = errnoCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
  }
}

/** Crash-durable, symlink-safe atomic replacement for canonical state files. */
export function secureAtomicWriteFile(path: string, content: string, options: { createOnly?: boolean } = {}): void {
  const absoluteTarget = resolve(path);
  let boundary = dirname(absoluteTarget);
  while (basename(boundary) !== ".work-state") {
    const next = dirname(boundary);
    if (next === boundary) break;
    boundary = next;
  }
  const projectRoot = basename(boundary) === ".work-state" ? dirname(boundary) : dirname(absoluteTarget);
  const relativeTarget = relative(projectRoot, absoluteTarget);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`atomic write target is outside the verified project root: ${path}`);
  }

  // Node does not expose openat/renameat. PinnedProjectRoot supplies the
  // platform-specific descriptor-relative implementation: Linux uses paths
  // rooted at an open directory descriptor and Darwin delegates all *at
  // operations to its inherited-fd helper. A null pin is unsupported and must
  // fail closed rather than falling back to the path-only implementation.
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) {
    throw new Error(`atomic write requires descriptor-anchored filesystem support: ${path}`);
  }
  try {
    let existing: PinnedRootPathEntryInfo | null;
    try {
      existing = pinnedRoot.pathEntryInfo(relativeTarget);
    } catch (error) {
      if (error instanceof PinnedRootError && error.code === "path_unauthorized") {
        throw new Error(`state directory must not be a symlink: ${path}`);
      }
      throw error;
    }
    if (existing?.kind === "symlink") {
      throw new Error(`atomic write target must not be a symlink: ${path}`);
    }
    if (existing && existing.kind !== "file") {
      throw new Error(`atomic write target is not a regular file: ${path}`);
    }
    if (options.createOnly) pinnedRoot.writeExclusive(relativeTarget, content);
    else pinnedRoot.writeAtomic(relativeTarget, content);
  } finally {
    pinnedRoot.close();
  }
}

/** Canonical descriptor-relative path for an engine conformance receipt. */
export function ctoSpecificationConformanceReceiptRelativePath(runId: string, receiptRef: string): string | null {
  if (!isSafeCtoRunId(runId) || !CTO_CONFORMANCE_RECEIPT_REF_RE.test(receiptRef)) return null;
  return join(".work-state", "cto", runId, "conformance-receipts", `${receiptRef}.json`);
}

export function ctoStateDir(runId: string, root: string): string {
  if (!runId || runId === "." || runId === ".." || !/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("unsafe CTO run id");
  const workState = resolve(root, ".work-state");
  const ctoRoot = join(workState, "cto");
  const runDir = join(ctoRoot, runId);
  try {
    const realWorkState = existsSync(workState) ? realpathSync(workState) : workState;
    const realCtoRoot = existsSync(ctoRoot) ? realpathSync(ctoRoot) : join(realWorkState, "cto");
    const rootRel = relative(realWorkState, realCtoRoot);
    if (/^(?:\.\.(?:[\\/]|$))/.test(rootRel) || isAbsolute(rootRel)) throw new Error("CTO path escapes .work-state");
    if (existsSync(runDir)) {
      const runRel = relative(realCtoRoot, realpathSync(runDir));
      if (/^(?:\.\.(?:[\\/]|$))/.test(runRel) || isAbsolute(runRel)) throw new Error("CTO run path escapes .work-state/cto");
    }
  } catch (error) {
    if (error instanceof Error && /escapes/.test(error.message)) throw error;
    throw new Error("unsafe CTO state path");
  }
  return runDir;
}

export function ctoStatePath(runId: string, root: string): string {
  return join(ctoStateDir(runId, root), "state.json");
}

export const CTO_STATE_WRITE_LOCK_FILE = "state-write.lock";
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_OWNERLESS_GRACE_MS = 50;
const STATE_LOCK_OWNER_MAX_BYTES = 8 * 1024;

interface StateWriteLockOwner {
  pid: number;
  token: string;
  acquired_at: string;
  start_identity?: string;
}

interface StateLockFileExpectation {
  path: string;
  dev: number;
  ino: number;
  sha256: string;
}

interface StateLockDirectoryExpectation {
  dev: number;
  ino: number;
  mtimeMs: number;
}

interface StateLockObservation {
  owner: StateWriteLockOwner | null;
  directory: boolean;
  observed?: StateLockFileExpectation;
  directoryObserved?: StateLockDirectoryExpectation;
}

type StateLockOwnerRead = StateLockObservation | null | false;

function sleepForStateLock(ms: number): void {
  try {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* bounded fallback for worker contexts */ }
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncParent(fd); } finally { closeSync(fd); }
}

function sameStateLockStat(left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readStateLockOwnerFile(ownerPath: string): { bytes: Uint8Array; dev: number; ino: number; sha256: string } | null {
  let fd: number | undefined;
  try {
    fd = openSync(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile()) return null;
    const bytes = Buffer.alloc(STATE_LOCK_OWNER_MAX_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total > STATE_LOCK_OWNER_MAX_BYTES) return null;
    const closed = fstatSync(fd);
    if (!sameStateLockStat(opened, closed)) return null;
    const current = lstatSync(ownerPath);
    if (current.isSymbolicLink() || !current.isFile() || !sameStateLockStat(opened, current)) return null;
    const content = bytes.subarray(0, total);
    return {
      bytes: content,
      dev: opened.dev,
      ino: opened.ino,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* descriptor cleanup is best effort */ }
    }
  }
}

function parseStateLockOwnerBytes(content: Uint8Array): StateWriteLockOwner | null {
  if (content.length === 0 || content.length > STATE_LOCK_OWNER_MAX_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const own = (key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
  for (const key of Object.keys(record)) {
    if (key !== "pid" && key !== "token" && key !== "acquired_at" && key !== "start_identity") return null;
  }
  if (!own("pid") || !own("token") || !own("acquired_at")) return null;
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return null;
  if (typeof record.token !== "string" || record.token.length === 0) return null;
  if (typeof record.acquired_at !== "string" || record.acquired_at.length === 0) return null;
  if (own("start_identity") && (typeof record.start_identity !== "string" || record.start_identity.length === 0)) return null;
  return {
    pid: record.pid as number,
    token: record.token,
    acquired_at: record.acquired_at,
    ...(typeof record.start_identity === "string" ? { start_identity: record.start_identity } : {}),
  };
}

function stateWriteLockOwner(lockPath: string): StateLockOwnerRead {
  let lockStat: ReturnType<typeof lstatSync>;
  try {
    lockStat = lstatSync(lockPath);
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? null : false;
  }
  if (lockStat.isSymbolicLink() || (!lockStat.isDirectory() && !lockStat.isFile())) return false;
  const directory = lockStat.isDirectory();
  const ownerPath = directory ? join(lockPath, "owner.json") : lockPath;
  let ownerStat: ReturnType<typeof lstatSync>;
  try {
    ownerStat = lstatSync(ownerPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT" && directory) {
      return {
        owner: null,
        directory: true,
        directoryObserved: { dev: lockStat.dev, ino: lockStat.ino, mtimeMs: lockStat.mtimeMs },
      };
    }
    return errnoCode(error) === "ENOENT" ? null : false;
  }
  if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) return false;
  const read = readStateLockOwnerFile(ownerPath);
  const owner = read === null ? null : parseStateLockOwnerBytes(read.bytes);
  if (!owner || read === null) return false;
  return {
    owner,
    directory,
    observed: { path: ownerPath, dev: read.dev, ino: read.ino, sha256: read.sha256 },
    ...(directory ? { directoryObserved: { dev: lockStat.dev, ino: lockStat.ino, mtimeMs: lockStat.mtimeMs } } : {}),
  };
}

function stateWriteLockPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

function stateWriteLockOwnerStale(owner: StateWriteLockOwner): boolean {
  if (!stateWriteLockPidAlive(owner.pid)) return true;
  if (!owner.start_identity) return false;
  const actual = processStartIdentity(owner.pid);
  return actual !== null && actual !== owner.start_identity;
}

function removeStateLockIfMatches(lockPath: string, observation: StateLockObservation): void {
  if (!observation.observed && !observation.directoryObserved) return;
  const projectRoot = dirname(dirname(dirname(dirname(lockPath))));
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return;
  try {
    const relativeLockPath = relative(resolve(projectRoot), resolve(lockPath));
    if (observation.directory) {
      if (observation.observed) {
        const ownerPath = join(relativeLockPath, "owner.json");
        pinnedRoot.removeFileIfMatches(ownerPath, { dev: observation.observed.dev, ino: observation.observed.ino, sha256: observation.observed.sha256 });
      }
      if (observation.directoryObserved) pinnedRoot.removeEmptyDirectoryIfMatches(relativeLockPath, observation.directoryObserved);
    } else if (observation.observed) {
      pinnedRoot.removeFileIfMatches(relativeLockPath, { dev: observation.observed.dev, ino: observation.observed.ino, sha256: observation.observed.sha256 });
    }
  } catch {
    // A changed, vanished, or reclaimed lock is not ours to remove.
  } finally {
    pinnedRoot.close();
  }
}

function removeStateWriteLock(lockPath: string, token: string): void {
  const observation = stateWriteLockOwner(lockPath);
  if (observation === false || !observation?.owner || observation.owner.token !== token) return;
  removeStateLockIfMatches(lockPath, observation);
}

type PinnedStateLockState = {
  exists: boolean;
  directory: boolean;
  owner: StateWriteLockOwner | null;
  observed?: StateLockFileExpectation;
  directoryObserved?: StateLockDirectoryExpectation;
};

function stateLockFileExpectation(path: string, file: { dev: number; ino: number; bytes: Uint8Array }): StateLockFileExpectation {
  return { path, dev: file.dev, ino: file.ino, sha256: createHash("sha256").update(file.bytes).digest("hex") };
}

function pinnedStateErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function pinnedStateLockState(pinnedRoot: PinnedProjectRoot, relativeLockPath: string): PinnedStateLockState {
  if (!pinnedRoot.pathEntryExists(relativeLockPath)) return { exists: false, directory: false, owner: null };
  try {
    const file = pinnedRoot.readFile(relativeLockPath, { maxBytes: STATE_LOCK_OWNER_MAX_BYTES });
    const owner = parseStateLockOwnerBytes(file.bytes);
    if (!owner) throw new Error("state lock owner record is malformed");
    return { exists: true, directory: false, owner, observed: stateLockFileExpectation(relativeLockPath, file) };
  } catch (error) {
    if (pinnedStateErrorCode(error) !== "not_regular") throw error;
    const info = pinnedRoot.pathEntryInfo(relativeLockPath);
    if (!info || info.kind !== "directory") return { exists: false, directory: false, owner: null };
    const ownerPath = `${relativeLockPath}/owner.json`;
    if (!pinnedRoot.pathEntryExists(ownerPath)) {
      return {
        exists: true,
        directory: true,
        owner: null,
        directoryObserved: { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs },
      };
    }
    try {
      const file = pinnedRoot.readFile(ownerPath, { maxBytes: STATE_LOCK_OWNER_MAX_BYTES });
      const owner = parseStateLockOwnerBytes(file.bytes);
      if (!owner) throw new Error("state lock owner record is malformed");
      return {
        exists: true,
        directory: true,
        owner,
        observed: stateLockFileExpectation(ownerPath, file),
        directoryObserved: { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs },
      };
    } catch (ownerError) {
      if (pinnedStateErrorCode(ownerError) === "not_found") {
        return {
          exists: true,
          directory: true,
          owner: null,
          directoryObserved: { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs },
        };
      }
      throw ownerError;
    }
  }
}

function removePinnedStateWriteLock(pinnedRoot: PinnedProjectRoot, relativeLockPath: string, token: string): void {
  try {
    const current = pinnedStateLockState(pinnedRoot, relativeLockPath);
    if (!current.owner || current.owner.token !== token) return;
    if (current.directory) {
      if (current.observed) pinnedRoot.removeFileIfMatches(current.observed.path, current.observed);
      if (current.directoryObserved) pinnedRoot.removeEmptyDirectoryIfMatches(relativeLockPath, current.directoryObserved);
    } else if (current.observed) {
      pinnedRoot.removeFileIfMatches(relativeLockPath, current.observed);
    }
  } catch {
    // A changed, vanished, or reclaimed lock is not ours to remove.
  }
}

function acquireStateWriteLockPinned(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  timeoutMs: number,
): { token: string; lockPath: string; pinnedRoot: PinnedProjectRoot; relativeLockPath: string } | { error: string } {
  const lockDir = join(".work-state", "cto", runId);
  const lockPath = join(lockDir, CTO_STATE_WRITE_LOCK_FILE);
  const ownerStartIdentity = processStartIdentity();
  if (!ownerStartIdentity) return { error: "CTO state write lock unavailable: process identity unavailable" };
  const startedAt = Date.now();
  let ownerlessSince: number | null = null;
  for (;;) {
    try {
      pinnedRoot.ensureDirectory(lockDir);
    } catch (error) {
      const code = pinnedStateErrorCode(error);
      if (code !== "exists" && code !== "not_found") return { error: `CTO state write lock unavailable: ${String(error)}` };
      if (Date.now() >= startedAt + timeoutMs) return { error: "CTO state write lock wait timeout exceeded" };
      sleepForStateLock(STATE_LOCK_RETRY_MS);
      continue;
    }
    if (!pinnedRoot.isStable()) return { error: "CTO state write lock unavailable: pinned project root changed" };
    const token = randomUUID();
    const candidate = join(lockDir, `.${CTO_STATE_WRITE_LOCK_FILE}.${process.pid}.${token}.candidate`);
    let acquired = false;
    try {
      pinnedRoot.writeExclusive(candidate, JSON.stringify({ pid: process.pid, token, start_identity: ownerStartIdentity, acquired_at: new Date().toISOString() }));
      try {
        pinnedRoot.linkExclusive(candidate, lockPath);
        acquired = true;
      } catch (error) {
        if (pinnedStateErrorCode(error) !== "exists") return { error: `CTO state write lock unavailable: ${String(error)}` };
      } finally {
        pinnedRoot.removeFile(candidate, { missingOk: true });
      }
      if (acquired) {
        if (!pinnedRoot.isStable()) {
          removePinnedStateWriteLock(pinnedRoot, lockPath, token);
          return { error: "CTO state write lock unavailable: pinned project root changed" };
        }
        return { token, lockPath, pinnedRoot, relativeLockPath: lockPath };
      }
    } catch (error) {
      try { pinnedRoot.removeFile(candidate, { missingOk: true }); } catch { /* candidate cleanup is best effort */ }
      const code = pinnedStateErrorCode(error);
      if (code !== "exists" && code !== "not_found") return { error: `CTO state write lock unavailable: ${String(error)}` };
    }
    let current: PinnedStateLockState;
    try {
      current = pinnedStateLockState(pinnedRoot, lockPath);
    } catch (error) {
      // The owner can release the lock between pathEntryExists and readFile.
      // Treat that transient disappearance as normal contention and retry;
      // returning it as terminal makes concurrent writers fail spuriously.
      if (pinnedStateErrorCode(error) === "not_found" || pinnedStateErrorCode(error) === "changed") {
        if (Date.now() >= startedAt + timeoutMs) return { error: "CTO state write lock wait timeout exceeded" };
        sleepForStateLock(STATE_LOCK_RETRY_MS);
        continue;
      }
      return { error: `CTO state write lock unavailable: ${String(error)}` };
    }
    let reclaim = current.owner !== null && stateWriteLockOwnerStale(current.owner);
    if (current.owner === null && current.exists) {
      ownerlessSince ??= Date.now();
      reclaim = Date.now() - ownerlessSince >= STATE_OWNERLESS_GRACE_MS;
    } else {
      ownerlessSince = null;
    }
    if (reclaim) {
      try {
        if (current.directory) {
          if (current.observed) pinnedRoot.removeFileIfMatches(current.observed.path, current.observed);
          if (current.directoryObserved) pinnedRoot.removeEmptyDirectoryIfMatches(lockPath, current.directoryObserved);
        } else if (current.observed) {
          pinnedRoot.removeFileIfMatches(lockPath, current.observed);
        }
      } catch (error) {
        const code = pinnedStateErrorCode(error);
        if (code !== "not_found" && code !== "changed" && code !== "not_regular") {
          return { error: `CTO state write lock unavailable: ${String(error)}` };
        }
      }
    }
    if (Date.now() >= startedAt + timeoutMs) return { error: "CTO state write lock wait timeout exceeded" };
    sleepForStateLock(STATE_LOCK_RETRY_MS);
  }
}

function acquireStateWriteLock(root: string, runId: string, timeoutMs: number): { token: string; lockPath: string } | { error: string } {
  let runDir: string;
  try {
    runDir = ctoStateDir(runId, root);
    ensureSecureStateDirectory(runDir);
  } catch (error) {
    return { error: `CTO state write lock unavailable: ${String(error)}` };
  }

  const lockPath = join(runDir, CTO_STATE_WRITE_LOCK_FILE);
  const ownerStartIdentity = processStartIdentity();
  if (!ownerStartIdentity) return { error: "CTO state write lock unavailable: process identity unavailable" };
  const startedAt = Date.now();
  for (;;) {
    const token = randomUUID();
    const candidate = join(runDir, `.${CTO_STATE_WRITE_LOCK_FILE}.${process.pid}.${token}.candidate`);
    let acquired = false;
    try {
      writeFileSync(
        candidate,
        JSON.stringify({ pid: process.pid, token, start_identity: ownerStartIdentity, acquired_at: new Date().toISOString() }),
        { flag: "wx", mode: 0o600 },
      );
      const candidateFd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(candidateFd); } finally { closeSync(candidateFd); }
      try {
        linkSync(candidate, lockPath);
        try {
          fsyncDirectory(runDir);
        } catch (error) {
          removeStateWriteLock(lockPath, token);
          return { error: `CTO state write lock unavailable: ${String(error)}` };
        }
        acquired = true;
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") {
          return { error: `CTO state write lock unavailable: ${String(error)}` };
        }
      } finally {
        try { unlinkSync(candidate); } catch { /* candidate cleanup is best effort */ }
      }
      if (acquired) return { token, lockPath };
    } catch (error) {
      try { unlinkSync(candidate); } catch { /* candidate cleanup is best effort */ }
      if (errnoCode(error) !== "EEXIST") {
        return { error: `CTO state write lock unavailable: ${String(error)}` };
      }
    }
    const observation = stateWriteLockOwner(lockPath);
    if (observation === false) {
      if (Date.now() >= startedAt + timeoutMs) return { error: "CTO state write lock unavailable: lock owner record is unsafe" };
      sleepForStateLock(STATE_LOCK_RETRY_MS);
      continue;
    }
    let reclaim = observation !== null && observation.owner !== null && stateWriteLockOwnerStale(observation.owner);
    if (observation !== null && observation.owner === null && observation.directoryObserved) {
      reclaim = Date.now() - observation.directoryObserved.mtimeMs >= STATE_OWNERLESS_GRACE_MS;
    }
    if (reclaim && observation !== null) removeStateLockIfMatches(lockPath, observation);
    if (observation === null) {
      try {
        lstatSync(lockPath);
      } catch (error) {
        if (errnoCode(error) === "ENOENT") continue;
        return { error: `CTO state write lock unavailable: ${String(error)}` };
      }
    }
    if (Date.now() >= startedAt + timeoutMs) return { error: "CTO state write lock wait timeout exceeded" };
    sleepForStateLock(STATE_LOCK_RETRY_MS);
  }
}

const heldStateWriteLocks = new Map<string, { token: string; depth: number }>();

/**
 * Serialize all durable writes for one CTO run. The lock is deliberately
 * re-entrant within this process: transition helpers may call writeCtoState
 * from a state-lock callback (and deterministic race tests can exercise the
 * same path) without deadlocking themselves.
 */
export function withCtoStateWriteLock<T>(
  projectRoot: string,
  ctoRunId: string,
  callback: () => T,
  options: { timeoutMs?: number; pinnedRoot?: PinnedProjectRoot } = {},
): T {
  const pinnedRoot = options.pinnedRoot;
  const lockPath = pinnedRoot
    ? join(".work-state", "cto", ctoRunId, CTO_STATE_WRITE_LOCK_FILE)
    : join(ctoStateDir(ctoRunId, projectRoot), CTO_STATE_WRITE_LOCK_FILE);
  // realpath collapses macOS /var -> /private/var (and equivalent project
  // aliases), so nested callers identify the same lock consistently.
  const key = pinnedRoot
    ? `${realpathSync(resolve(pinnedRoot.canonical_root))}\0${ctoRunId}`
    : `${realpathSync(resolve(projectRoot))}\0${ctoRunId}`;
  const held = heldStateWriteLocks.get(key);
  if (held) {
    held.depth += 1;
    try { return callback(); } finally { held.depth -= 1; }
  }

  const lock = pinnedRoot
    ? acquireStateWriteLockPinned(pinnedRoot, ctoRunId, options.timeoutMs ?? STATE_LOCK_TIMEOUT_MS)
    : acquireStateWriteLock(projectRoot, ctoRunId, options.timeoutMs ?? STATE_LOCK_TIMEOUT_MS);
  if ("error" in lock) throw new Error(lock.error);
  heldStateWriteLocks.set(key, { token: lock.token, depth: 1 });
  try {
    return callback();
  } finally {
    heldStateWriteLocks.delete(key);
    if ("relativeLockPath" in lock) {
      const pinnedLock = lock as unknown as { token: string; pinnedRoot: PinnedProjectRoot; relativeLockPath: string };
      removePinnedStateWriteLock(pinnedLock.pinnedRoot, pinnedLock.relativeLockPath, pinnedLock.token);
    } else {
      removeStateWriteLock(lock.lockPath, lock.token);
    }
  }
}

/**
 * Run a synchronous callback under the canonical delivery-index transaction.
 * The lock identity is intentionally private so adapters cannot select a
 * different lock or bypass the authenticated recovery ordering.
 */
export function withCtoRunDeliveryReadTransactionPinned<T>(
  pinnedRoot: PinnedProjectRoot,
  callback: (pinnedRoot: PinnedProjectRoot) => T,
): T {
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before delivery transaction");
  return withCtoStateWriteLock(
    pinnedRoot.canonical_root,
    CTO_RUN_DELIVERY_INDEX_LOCK_ID,
    () => callback(pinnedRoot),
    { pinnedRoot },
  );
}

export function newCtoState(opts: {
  id: string;
  task: string;
  branch: string;
  autonomous: boolean;
  /**
   * Model-first PHASE-0 classification (authority for `autonomous`). When
   * present, `classification.autonomous` is the decision and the top-level
   * `autonomous` field is mirrored from it for legacy readers — the two can
   * never disagree by construction. Legacy callers and engine-created
   * standby runs omit it and keep the explicit top-level flag verbatim.
   */
  classification?: ModelClassification;
  plan: TeamPlan;
  /** Standby runs are adoptable cross-session (inbox continuity). */
  standby?: boolean;
  /** Session that owns this interactive task run (foreign sessions do not amend it). */
  owner_session?: string;
}): CtoState {
  // Model-first: a well-formed classification carries ALL four PHASE-0
  // fields — string `type`/`complexity`/`confidence` and boolean
  // `autonomous` — and is the AUTHORITY, mirrored into the top-level field.
  // A malformed/partial runtime classification object — e.g. loosely typed
  // JSON parse missing any of the four or with a non-boolean `autonomous` —
  // must NOT hijack the flag: the explicit caller fallback (opts.autonomous)
  // applies and the malformed classification is not persisted (mirrors
  // isStructuredClassification on the markdown path).
  const classification =
    opts.classification &&
    typeof opts.classification.type === "string" &&
    typeof opts.classification.complexity === "string" &&
    typeof opts.classification.confidence === "string" &&
    typeof opts.classification.autonomous === "boolean"
      ? opts.classification
      : undefined;
  return {
    schema: 2,
    id: opts.id,
    task: opts.task,
    branch: opts.branch,
    autonomous: classification ? classification.autonomous : opts.autonomous,
    ...(classification ? { classification } : {}),
    plan: opts.plan,
    teams: opts.plan.teams.map((t) => ({ id: t.team, status: "pending", escalations: {}, ...(t.team_def_id ? { team_def_id: t.team_def_id } : {}) })),
    integration: { status: "pending" },
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
    state_revision: 0,
    ...(opts.standby === true ? { standby: true } : {}),
    ...(opts.owner_session ? { owner_session: opts.owner_session } : {}),
    // ── schema-2 defaults (br-zps.1): health/scheduler stay undefined until their owning teams write them ──
    budget: defaultBudgetShape(),
    leases: {},
    decisions: [],
    inbox_quarantine: {},
    // ── resident control-plane (cto-core): waves accumulate from wave 0; the
    // dispatcher/resolver owners set active_wave_id/channel_profile, never the
    // constructor (a fresh run has no wave and no resolved channel yet) ──
    wave_history: [],
    pending_delivery_obligations: [],
    terminal_summary_evidence: [],
  };
}

/** Default schema-2 budget shape (D3): all limits null, all accounting zero, no per-team spend. */
function defaultBudgetShape(): BudgetState {
  return {
    policy: { token_limit: null, dollar_limit: null, time_limit_ms: null },
    accounting: { tokens_estimated: 0, dollars_estimated: 0, elapsed_ms: 0, per_team: {} },
  };
}

export const MAX_CTO_STATE_READ_BYTES = 8 * 1024 * 1024;
const MAX_PERSISTED_STATE_NODES = 100_000;
const MAX_PERSISTED_STATE_DEPTH = 128;
export const MAX_PERSISTED_STATE_ARRAY = 4096;
const MAX_PERSISTED_STATE_KEYS = 1024;
const MAX_PERSISTED_STATE_STRING_BYTES = 256 * 1024;
/**
 * Typed control-plane fields are validated (never trusted) on every
 * migration: values present on disk must parse against the shared contract,
 * otherwise they are quarantined behind an `invalid` provenance record.
 * Legacy autonomy/roles/checkpoints stay display/migration inputs — they
 * never become permission here.
 */
function normalizeControlPlaneFields(state: Record<string, unknown>): void {
  state.control_plane_provenance ??= {
    completion_intent: "none", checkpoint_policy: "none", roster_policy: "legacy",
    roster_selection: "none", work_identity: "none", pending: "none",
    child_join: "none", completion_envelope: "none", legacy_inputs: [],
    warnings: [], status: "migrated",
  };
  const validation = validateTypedControlPlane(state);
  if (!validation.ok) {
    state.control_plane_provenance = {
      ...(state.control_plane_provenance as ControlPlaneProvenance),
      warnings: validation.issues.map((issue) => `${issue.path} ${issue.message}`),
      status: "invalid",
    };
  }
}
const CANONICAL_STATE_KEYS = new Set([
  "schema", "id", "task", "branch", "autonomous", "classification", "plan", "teams", "integration",
  "pause", "updated_at", "state_revision", "budget", "leases", "decisions", "inbox_quarantine", "wave_history",
  "active_wave_id", "specification_execution_preparation_digest", "specification_execution_requested_selections", "specification_execution_exclusions", "specification_execution_anchor", "channel_profile", "health", "scheduler", "standby", "owner_session", "preparation_digest", "preparation_features", "preparation_queued", "preparation_capability",
  "amended_at", "specification_preparation_transaction", "completion_intent", "checkpoint_policy", "roster_policy",
  "roster_selection", "roster_selections", "work_identity", "pending", "child_join", "child_joins",
  "completion_envelope", "migration", "control_plane_provenance", "control_plane_status", "pending_delivery_obligations", "terminal_summary_evidence",
]);

function objectHasExactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}
export const MAX_BUDGET_TEAM_ENTRIES = 64;
export const MAX_BUDGET_DOLLARS = 1_000_000_000_000;

export function isSafeBudgetInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isSafeBudgetDollar(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_BUDGET_DOLLARS;
}

function budgetDollarsEqual(left: number, right: number): boolean {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 16;
  return Math.abs(left - right) <= tolerance;
}

export function persistedBudgetValid(value: unknown): value is BudgetState {
  if (!objectHasExactKeys(value, ["policy", "accounting"])) return false;
  const policy = value.policy;
  const accounting = value.accounting;
  if (!objectHasExactKeys(policy, ["token_limit", "dollar_limit", "time_limit_ms"])
    || !objectHasExactKeys(accounting, ["tokens_estimated", "dollars_estimated", "elapsed_ms", "per_team"])) return false;
  if ((policy.token_limit !== null && !isSafeBudgetInteger(policy.token_limit))
    || (policy.dollar_limit !== null && !isSafeBudgetDollar(policy.dollar_limit))
    || (policy.time_limit_ms !== null && !isSafeBudgetInteger(policy.time_limit_ms))) return false;
  if (!isSafeBudgetInteger(accounting.tokens_estimated)
    || !isSafeBudgetDollar(accounting.dollars_estimated)
    || !isSafeBudgetInteger(accounting.elapsed_ms)
    || !accounting.per_team
    || typeof accounting.per_team !== "object"
    || Array.isArray(accounting.per_team)) return false;
  const perTeam = accounting.per_team as Record<string, unknown>;
  const teamKeys = Object.keys(perTeam);
  if (teamKeys.length > MAX_BUDGET_TEAM_ENTRIES) return false;
  let tokens = 0;
  let dollars = 0;
  for (const teamId of teamKeys) {
    if (!isSafeCtoRunId(teamId) || Buffer.byteLength(teamId, "utf8") > 256) return false;
    const entry = perTeam[teamId];
    if (!objectHasExactKeys(entry, ["tokens", "dollars", "ms"])
      || !isSafeBudgetInteger(entry.tokens)
      || !isSafeBudgetDollar(entry.dollars)
      || !isSafeBudgetInteger(entry.ms)) return false;
    tokens += entry.tokens;
    dollars += entry.dollars;
    if (!Number.isSafeInteger(tokens) || !isSafeBudgetDollar(dollars)) return false;
  }
  return tokens === accounting.tokens_estimated && budgetDollarsEqual(dollars, accounting.dollars_estimated);
}
export function isValidPersistedDecisionEntry(value: unknown): value is Record<string, unknown> {
  if (!objectHasExactKeys(value, ["id", "at", "decision", "why", "tags", "by"], ["refs"])) return false;
  const candidate = value as Record<string, unknown>;
  const text = (item: unknown): item is string => typeof item === "string"
    && item.trim().length > 0
    && Buffer.byteLength(item, "utf8") <= MAX_PERSISTED_STATE_STRING_BYTES;
  return isSafeCtoRunId(candidate.id)
    && isCanonicalCtoTimestamp(candidate.at)
    && text(candidate.decision)
    && text(candidate.why)
    && text(candidate.by)
    && Array.isArray(candidate.tags)
    && candidate.tags.length <= MAX_PERSISTED_STATE_ARRAY
    && candidate.tags.every((tag) => text(tag))
    && (candidate.refs === undefined
      || (Array.isArray(candidate.refs) && candidate.refs.length <= MAX_PERSISTED_STATE_ARRAY && candidate.refs.every((ref) => text(ref))));
}
const PREPARATION_PHASES = new Set(["specify", "plan", "tasks"]);
const PREPARATION_QUEUE_REASONS = new Set(["capacity", "depth", "ownership", "active_phase", "same_feature_serialized", "nested_cto"]);

function boundedPreparationText(value: unknown, maxBytes = 256): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\u0000-\u001f\u007f\r\n]/u.test(value);
}

function safePreparationId(value: unknown): value is string {
  return typeof value === "string"
    && isSafeCtoRunId(value)
    && Buffer.byteLength(value, "utf8") <= 128;
}

function preparationFeatureValid(value: unknown): value is Record<string, unknown> {
  if (!objectHasExactKeys(value, ["request_id", "feature_id", "run_key", "workspace_path", "state_path", "profile_name", "profile_hash", "phase_writer_id", "facets", "request"], ["owner_id"])) return false;
  if (!safePreparationId(value.request_id)
    || !isSafeFeatureId(value.feature_id)
    || !safePreparationId(value.run_key)
    || value.workspace_path !== `specs/${value.feature_id}`
    || value.state_path !== `.work-state/features/${value.feature_id}/state.json`
    || value.profile_name !== "spec-preparation"
    || !isSha256Hex(value.profile_hash)
    || !safePreparationId(value.phase_writer_id)
    || !Array.isArray(value.facets)
    || value.facets.length === 0
    || value.facets.length > 8
    || value.facets.some((facet) => !safePreparationId(facet))
    || !boundedPreparationText(value.request, MAX_CTO_SPECIFICATION_TEXT_BYTES)) return false;
  return value.owner_id === undefined || safePreparationId(value.owner_id);
}

function preparationQueueEntryValid(value: unknown): value is Record<string, unknown> {
  if (!objectHasExactKeys(value, ["request_id", "feature_id", "run_key", "phase", "facet_id", "profile_name", "profile_hash", "reason_code", "reason"], ["owner_id", "active_phase"])) return false;
  return safePreparationId(value.request_id)
    && isSafeFeatureId(value.feature_id)
    && safePreparationId(value.run_key)
    && typeof value.phase === "string" && PREPARATION_PHASES.has(value.phase)
    && safePreparationId(value.facet_id)
    && value.profile_name === "spec-preparation"
    && isSha256Hex(value.profile_hash)
    && typeof value.reason_code === "string" && PREPARATION_QUEUE_REASONS.has(value.reason_code)
    && boundedPreparationText(value.reason, 512)
    && (value.owner_id === undefined || safePreparationId(value.owner_id))
    && (value.active_phase === undefined || (typeof value.active_phase === "string" && PREPARATION_PHASES.has(value.active_phase)));
}

function preparationCapabilityValid(value: unknown, state: Record<string, unknown>): value is Record<string, unknown> {
  if (!objectHasExactKeys(value, ["capability_id", "dispatch_token_hash", "advance_token_hash", "issued_for", "kind", "expected_roles", "expected_count", "expected_roster", "status", "dispatches"])) return false;
  const issued = value.issued_for;
  if (!objectHasExactKeys(issued, ["run_key", "branch", "workflow", "profile_hash", "stage_cursor", "cursor_epoch"])
    || issued.run_key !== state.id
    || issued.branch !== state.branch
    || issued.workflow !== "spec-preparation"
    || !isSha256Hex(issued.profile_hash)
    || issued.stage_cursor !== "specification-preparation"
    || !safePreparationId(issued.cursor_epoch)) return false;
  if (!safePreparationId(value.capability_id)
    || !isSha256Hex(value.dispatch_token_hash)
    || !isSha256Hex(value.advance_token_hash)
    || value.kind !== "single"
    || !Array.isArray(value.expected_roles)
    || value.expected_roles.length !== 1
    || value.expected_roles[0] !== "cto"
    || value.expected_count !== 1
    || !Array.isArray(value.expected_roster)
    || value.expected_roster.length !== 1
    || !objectHasExactKeys(value.expected_roster[0], ["role", "agent"])
    || value.expected_roster[0].role !== "cto"
    || value.expected_roster[0].agent !== "cto"
    || value.status !== "ready"
    || !Array.isArray(value.dispatches)
    || value.dispatches.length !== 0) return false;
  return true;
}

function safePreparationRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function preparationImageValid(value: unknown, stateId: string, allowInlineLegacy: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  if (!objectHasExactKeys(image, ["path", "exists", "sha256"], ["byte_count", "dev", "ino", "preimage_ref", "bytes_base64"])) return false;
  if (!safePreparationRelativePath(image.path) || typeof image.exists !== "boolean" || typeof image.sha256 !== "string") return false;
  if (!image.exists) return image.sha256 === "" && image.preimage_ref === undefined && image.bytes_base64 === undefined
    && (image.byte_count === undefined || image.byte_count === 0);
  if (!isSha256Hex(image.sha256) || !Number.isSafeInteger(image.dev) || (image.dev as number) < 0 || !Number.isSafeInteger(image.ino) || (image.ino as number) < 0) return false;
  const byteCount = image.byte_count;
  if (image.preimage_ref !== undefined) {
    const expectedRef = ".work-state/cto/" + stateId + "/preparation-preimages/" + image.sha256 + ".bin";
    if (image.preimage_ref !== expectedRef || image.bytes_base64 !== undefined
      || !Number.isSafeInteger(byteCount) || (byteCount as number) < 0 || (byteCount as number) > MAX_CTO_STATE_READ_BYTES) return false;
    return true;
  }
  if (!allowInlineLegacy || typeof image.bytes_base64 !== "string" || image.bytes_base64.length === 0 || image.bytes_base64.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.bytes_base64)) return false;
  const bytes = Buffer.from(image.bytes_base64, "base64");
  return bytes.byteLength <= MAX_CTO_STATE_READ_BYTES
    && (byteCount === undefined || (Number.isSafeInteger(byteCount) && byteCount === bytes.byteLength))
    && bytes.toString("base64") === image.bytes_base64 && createHash("sha256").update(bytes).digest("hex") === image.sha256;
}

function preparationTransactionValid(value: unknown, stateId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const transaction = value as Record<string, unknown>;
  if (!objectHasExactKeys(transaction, ["schema_version", "id", "status", "request_digest", "root_identity", "expected_state_revision", "feature_state", "dod_files", "updated_at"], ["kind", "error", "source_id", "wave_id"])) return false;
  if (transaction.schema_version !== 1 || !safePreparationId(transaction.id) || !["prepared", "committing", "committed", "rolled_back"].includes(String(transaction.status))
    || !isSha256Hex(transaction.request_digest) || !Number.isSafeInteger(transaction.expected_state_revision) || (transaction.expected_state_revision as number) < 0
    || typeof transaction.updated_at !== "string" || (transaction.kind !== undefined && !["execution", "bootstrap"].includes(String(transaction.kind)))
    || (transaction.error !== undefined && typeof transaction.error !== "string")
    || (transaction.source_id !== undefined && !isSafeCtoExecutionId(transaction.source_id))
    || (transaction.wave_id !== undefined && !isSafeCtoExecutionId(transaction.wave_id))) return false;
  const identity = transaction.root_identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity) || !objectHasExactKeys(identity, ["canonical_path", "dev", "ino"])
    || typeof (identity as Record<string, unknown>).canonical_path !== "string" || !Number.isSafeInteger((identity as Record<string, unknown>).dev)
    || !Number.isSafeInteger((identity as Record<string, unknown>).ino)) return false;
  const allowInlineLegacy = transaction.kind !== "bootstrap";
  const feature = transaction.feature_state;
  if (!feature || typeof feature !== "object" || Array.isArray(feature)) return false;
  const featureRecord = feature as Record<string, unknown>;
  if (!objectHasExactKeys(featureRecord, ["path", "before"], ["after"]) || !safePreparationRelativePath(featureRecord.path)
    || !preparationImageValid(featureRecord.before, stateId, allowInlineLegacy)
    || (featureRecord.after !== undefined && !preparationImageValid(featureRecord.after, stateId, allowInlineLegacy))) return false;
  if (!Array.isArray(transaction.dod_files) || transaction.dod_files.length > 8) return false;
  return transaction.dod_files.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const file = entry as Record<string, unknown>;
    return objectHasExactKeys(file, ["path", "before"], ["after"]) && safePreparationRelativePath(file.path)
      && preparationImageValid(file.before, stateId, allowInlineLegacy)
      && (file.after === undefined || preparationImageValid(file.after, stateId, allowInlineLegacy));
  });
}

function preparationFieldsValid(state: Record<string, unknown>): boolean {
  if (state.specification_preparation_transaction !== undefined && !preparationTransactionValid(state.specification_preparation_transaction, String(state.id))) return false;
  const names = ["preparation_digest", "preparation_features", "preparation_queued", "preparation_capability"] as const;
  const present = names.filter((name) => Object.prototype.hasOwnProperty.call(state, name)).length;
  if (present === 0) return true;
  if (present !== names.length || !isSha256Hex(state.preparation_digest)) return false;
  const plan = state.plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return false;
  const planRecord = plan as Record<string, unknown>;
  if (planRecord.id !== state.id || planRecord.task !== state.task) return false;
  if (!Array.isArray(state.preparation_features) || state.preparation_features.length > 64
    || !Array.isArray(state.preparation_queued) || state.preparation_queued.length > MAX_PREPARATION_QUEUE_ITEMS
    || !preparationCapabilityValid(state.preparation_capability, state)) return false;
  const capability = state.preparation_capability as Record<string, unknown>;
  const issuedFor = capability.issued_for as Record<string, unknown>;
  const profileHash = issuedFor.profile_hash;
  const featureIds = new Set<string>();
  const requestIds = new Set<string>();
  for (const feature of state.preparation_features) {
    if (!preparationFeatureValid(feature) || feature.profile_hash !== profileHash) return false;
    if (featureIds.has(feature.feature_id as string) || requestIds.has(feature.request_id as string)) return false;
    featureIds.add(feature.feature_id as string);
    requestIds.add(feature.request_id as string);
  }
  for (const queued of state.preparation_queued) {
    if (!preparationQueueEntryValid(queued) || queued.profile_hash !== profileHash) return false;
    if (requestIds.has(queued.request_id as string)) return false;
    requestIds.add(queued.request_id as string);
  }
  return true;
}
const MAX_PENDING_DELIVERY_OBLIGATIONS = 256;
const MAX_PENDING_DELIVERY_ENVELOPE_BYTES = 64 * 1024;
const MAX_PENDING_DELIVERY_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_TERMINAL_SUMMARY_EVIDENCE = 256;

function terminalSummaryEvidenceValid(value: unknown, runId: string): value is CtoTerminalSummaryEvidence[] {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_TERMINAL_SUMMARY_EVIDENCE) return false;
  const waves = new Set<string>();
  let totalBytes = 0;
  for (const candidate of value) {
    if (!objectHasExactKeys(candidate, ["wave_id", "source_revision", "envelope_sha256", "envelope"])) return false;
    const item = candidate as Record<string, unknown>;
    if (!isSafeCtoExecutionId(item.wave_id) || waves.has(item.wave_id as string)
      || !Number.isSafeInteger(item.source_revision) || (item.source_revision as number) < 0
      || !isSha256Hex(item.envelope_sha256) || typeof item.envelope !== "string") return false;
    const bytes = Buffer.from(item.envelope, "utf8");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PENDING_DELIVERY_ENVELOPE_BYTES || (totalBytes += bytes.byteLength) > MAX_PENDING_DELIVERY_TOTAL_BYTES
      || createHash("sha256").update(bytes).digest("hex") !== item.envelope_sha256) return false;
    let parsed: unknown;
    try { parsed = JSON.parse(item.envelope); } catch { return false; }
    if (!validCtoDelivery(parsed, runId) || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const delivery = parsed as Record<string, unknown>;
    if (delivery.id !== `${runId}/wave/${item.wave_id}/summary` || delivery.intent !== "summary"
      || delivery.wave_id !== item.wave_id || delivery.state_revision !== item.source_revision) return false;
    waves.add(item.wave_id as string);
  }
  return true;
}

function pendingDeliveryObligationsValid(value: unknown, runId: string): value is CtoPendingDeliveryObligation[] {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_PENDING_DELIVERY_OBLIGATIONS) return false;
  let totalBytes = 0;
  const names = new Set<string>();
  for (const candidate of value) {
    if (!objectHasExactKeys(candidate, ["entry_name", "envelope_id", "run_id", "intent", "source", "source_ref", "created_revision", "envelope"])) return false;
    const item = candidate as Record<string, unknown>;
    if (!isSafeCtoRunId(item.run_id) || item.run_id !== runId || !isSafeCtoDeliveryEnvelopeId(item.envelope_id) || item.source_ref !== item.envelope_id
      || !isSafeCtoOutboxEntryName(item.entry_name)
      || item.source !== "cto" || !CTO_DELIVERY_INTENTS.has(item.intent as CtoDeliveryIntent)
      || !Number.isSafeInteger(item.created_revision) || (item.created_revision as number) < 0
      || typeof item.envelope !== "string") return false;
    const bytes = Buffer.from(item.envelope, "utf8");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PENDING_DELIVERY_ENVELOPE_BYTES || (totalBytes += bytes.byteLength) > MAX_PENDING_DELIVERY_TOTAL_BYTES) return false;
    if (names.has(item.entry_name)) return false;
    names.add(item.entry_name);
    let parsed: unknown;
    try { parsed = JSON.parse(item.envelope); } catch { return false; }
    if (!validCtoDelivery(parsed, runId) || parsed.id !== item.envelope_id || parsed.intent !== item.intent
      || parsed.state_revision !== item.created_revision || canonicalDurableIdFileName(item.envelope_id) !== item.entry_name) return false;
  }
  return true;
}

function legacyPersistedStateValid(raw: Record<string, unknown>): boolean {
  if (Object.keys(raw).some((key) => !CANONICAL_STATE_KEYS.has(key))
    || typeof raw.id !== "string" || !isSafeCtoRunId(raw.id)
    || typeof raw.task !== "string" || typeof raw.branch !== "string" || typeof raw.autonomous !== "boolean"
    || !raw.plan || typeof raw.plan !== "object" || Array.isArray(raw.plan)
    || !Array.isArray(raw.teams) || raw.teams.length > 8
    || !raw.integration || typeof raw.integration !== "object" || Array.isArray(raw.integration)
    || typeof raw.updated_at !== "string") return false;
  const plan = raw.plan as Record<string, unknown>;
  if (!objectHasExactKeys(plan, ["id", "task", "teams", "created_at"]) || !isSafeCtoRunId(plan.id)
    || typeof plan.task !== "string" || typeof plan.created_at !== "string" || !Array.isArray(plan.teams) || plan.teams.length > 8) return false;
  for (const candidate of plan.teams) {
    if (objectHasExactKeys(candidate, ["team", "role", "depends_on"])
      && isSafeCtoRunId(candidate.team) && typeof candidate.role === "string"
      && Array.isArray(candidate.depends_on) && candidate.depends_on.every((value) => isSafeCtoRunId(value))) continue;
    if (!objectHasExactKeys(candidate, ["team", "scope", "slice", "profile", "worktree", "depends_on"])
      || !isSafeCtoRunId(candidate.team) || !isSafeCtoRunId(candidate.slice) || typeof candidate.profile !== "string"
      || !["same_branch", "separate_worktree"].includes(String(candidate.worktree))
      || !Array.isArray(candidate.scope) || candidate.scope.some((item) => typeof item !== "string")
      || !Array.isArray(candidate.depends_on) || candidate.depends_on.some((value) => !isSafeCtoRunId(value))) return false;
  }
  const integration = raw.integration as Record<string, unknown>;
  if (!objectHasExactKeys(integration, ["status"], ["note"])
    || !["pending", "in_progress", "done", "failed"].includes(String(integration.status))
    || (integration.note !== undefined && typeof integration.note !== "string")) return false;
  if (raw.pause !== undefined) {
    const pause = raw.pause;
    if (!objectHasExactKeys(pause, ["kind", "reason"])
      || !["none", "background_wait", "user_checkpoint", "needs_human", "failed", "done"].includes(String(pause.kind))
      || typeof pause.reason !== "string") return false;
  }
  for (const candidate of raw.teams) {
    if (!objectHasExactKeys(candidate, ["id", "status", "escalations"], ["dod_path", "slice_id", "feature_id", "run_key", "task_id", "dod_digest", "team_def_id", "classification", "workflow", "completion_intent", "checkpoint_policy", "roster_policy", "roster_selection", "work_identity", "pending", "child_join", "completion_envelope", "control_plane_provenance", "control_plane_status"])
      || !isSafeCtoRunId(candidate.id) || !["pending", "in_progress", "parked", "done", "failed"].includes(String(candidate.status))
      || !candidate.escalations || typeof candidate.escalations !== "object" || Array.isArray(candidate.escalations)) return false;
    const escalations = candidate.escalations as Record<string, unknown>;
    if (Object.keys(escalations).length > MAX_PERSISTED_STATE_KEYS
      || Object.entries(escalations).some(([id, value]) => !isSafeCtoRunId(id) || !validEscalationRecord(value))) return false;
  }
  if (raw.wave_history === undefined) {
    if (raw.active_wave_id !== undefined) return false;
  } else if (!persistedWaveAuthorityValid(raw.wave_history, raw.active_wave_id)) {
    return false;
  }
  if (!persistedSpecificationExecutionSlicesValid(raw.wave_history, raw.teams)) return false;
  if (raw.decisions !== undefined && (!Array.isArray(raw.decisions) || raw.decisions.length > MAX_PERSISTED_STATE_ARRAY || raw.decisions.some((value) => !isValidPersistedDecisionEntry(value)))) return false;
  if (raw.leases !== undefined && (!raw.leases || typeof raw.leases !== "object" || Array.isArray(raw.leases)
    || Object.values(raw.leases).some((value) => !value || typeof value !== "object" || Array.isArray(value)))) return false;
  if (raw.inbox_quarantine !== undefined && (!raw.inbox_quarantine || typeof raw.inbox_quarantine !== "object" || Array.isArray(raw.inbox_quarantine)
    || Object.values(raw.inbox_quarantine).some((value) => !value || typeof value !== "object" || Array.isArray(value)))) return false;
  if (raw.budget !== undefined && !persistedBudgetValid(raw.budget)) return false;
  if (!pendingDeliveryObligationsValid(raw.pending_delivery_obligations, String(raw.id))) return false;
  if (!terminalSummaryEvidenceValid(raw.terminal_summary_evidence, String(raw.id))) return false;
  if (!preparationFieldsValid(raw)) return false;
  return true;
}
function persistedStateStructureValid(raw: Record<string, unknown>): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (++nodes > MAX_PERSISTED_STATE_NODES || depth > MAX_PERSISTED_STATE_DEPTH) return false;
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > MAX_PERSISTED_STATE_STRING_BYTES) return false;
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return false;
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      if (value.length > MAX_PERSISTED_STATE_ARRAY) return false;
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.length > MAX_PERSISTED_STATE_KEYS) return false;
    for (const key of keys) {
      if (Buffer.byteLength(key, "utf8") > MAX_PERSISTED_STATE_STRING_BYTES) return false;
      stack.push({ value: object[key], depth: depth + 1 });
    }
  }
  if (raw.schema === undefined || raw.schema === 1 || (raw.schema === 2 && raw.state_revision === undefined)) return legacyPersistedStateValid(raw);
  if (raw.schema !== 2 || !Number.isSafeInteger(raw.schema)) return false;
  const historicalPartialFields = ["budget", "leases", "decisions", "inbox_quarantine"] as const;
  const missingHistoricalFields = historicalPartialFields.some((field) => raw[field] === undefined);
  const missingLegacyPause = raw.pause === undefined;
  if (raw.state_revision === 1 && (missingHistoricalFields || missingLegacyPause)) {
    // A legacy schema-2 writer could publish revision one before the
    // non-authority control-plane projections or pause field existed. Only
    // those safe-empty projections may be default-filled; wave history
    // remains an authority record and must already be present.
    if (raw.wave_history === undefined) return false;
    const migratedInput = missingLegacyPause ? { ...raw, pause: { kind: "none", reason: "" } } : raw;
    return persistedStateStructureValid(migrateCtoState(migratedInput) as unknown as Record<string, unknown>);
  }
  if (Object.keys(raw).some((key) => !CANONICAL_STATE_KEYS.has(key))
    || typeof raw.id !== "string" || !isSafeCtoRunId(raw.id)
    || typeof raw.task !== "string" || typeof raw.branch !== "string"
    || typeof raw.autonomous !== "boolean"
    || !Number.isSafeInteger(raw.state_revision) || (raw.state_revision as number) < 0
    || typeof raw.updated_at !== "string"
    || !raw.plan || typeof raw.plan !== "object" || Array.isArray(raw.plan)
    || !Array.isArray(raw.teams) || raw.teams.length > 8
    || !raw.integration || typeof raw.integration !== "object" || Array.isArray(raw.integration)
    || !raw.pause || typeof raw.pause !== "object" || Array.isArray(raw.pause)
    || !raw.budget || typeof raw.budget !== "object" || Array.isArray(raw.budget)
    || !Array.isArray(raw.wave_history)
    || (raw.specification_execution_preparation_digest !== undefined && !isSha256Hex(raw.specification_execution_preparation_digest))) return false;
  const plan = raw.plan as Record<string, unknown>;
  if (!objectHasExactKeys(plan, ["id", "task", "teams", "created_at"])
    || !isSafeCtoRunId(plan.id) || typeof plan.task !== "string" || typeof plan.created_at !== "string"
    || !Array.isArray(plan.teams) || plan.teams.length > 8) return false;
  const specificationExecutionPlan = Array.isArray(raw.wave_history) && raw.wave_history.some((wave: unknown) =>
    wave !== null && typeof wave === "object" && !Array.isArray(wave) && (wave as Record<string, unknown>).source === "specification-execution");
  for (const candidate of plan.teams) {
    if (objectHasExactKeys(candidate, ["team", "role", "depends_on"])
      && isSafeCtoRunId(candidate.team) && typeof candidate.role === "string"
      && Array.isArray(candidate.depends_on) && candidate.depends_on.every((item) => isSafeCtoRunId(item))) continue;
    const canonicalPlanTeam = objectHasExactKeys(candidate, ["team", "team_def_id", "scope", "slice", "profile", "worktree", "depends_on"]);
    const legacyPlanTeam = objectHasExactKeys(candidate, ["team", "scope", "slice", "profile", "worktree", "depends_on"]);
    if ((!canonicalPlanTeam && !legacyPlanTeam)
      || (specificationExecutionPlan && legacyPlanTeam)
      || !isSafeCtoRunId(candidate.team) || (canonicalPlanTeam && !isSafeCtoRunId(candidate.team_def_id)) || !isSafeCtoRunId(candidate.slice) || typeof candidate.profile !== "string"
      || !["same_branch", "separate_worktree"].includes(String(candidate.worktree))
      || !Array.isArray(candidate.scope) || candidate.scope.some((item) => typeof item !== "string")
      || !Array.isArray(candidate.depends_on) || candidate.depends_on.some((value) => !isSafeCtoRunId(value))) return false;
  }
  const integration = raw.integration as Record<string, unknown>;
  if (!objectHasExactKeys(integration, ["status"], ["note"])
    || !["pending", "in_progress", "done", "failed"].includes(String(integration.status))
    || (integration.note !== undefined && typeof integration.note !== "string")) return false;
  const pause = raw.pause as Record<string, unknown>;
  if (!objectHasExactKeys(pause, ["kind", "reason"])
    || !["none", "background_wait", "user_checkpoint", "needs_human", "failed", "done"].includes(String(pause.kind)) || typeof pause.reason !== "string") return false;
  if (!persistedBudgetValid(raw.budget)) return false;
  if (!pendingDeliveryObligationsValid(raw.pending_delivery_obligations, String(raw.id))) return false;
  if (!terminalSummaryEvidenceValid(raw.terminal_summary_evidence, String(raw.id))) return false;
  if (raw.decisions !== undefined && (!Array.isArray(raw.decisions) || raw.decisions.length > MAX_PERSISTED_STATE_ARRAY || raw.decisions.some((value) => !isValidPersistedDecisionEntry(value)))) return false;
  const teamIds = new Set<string>();
  for (const candidate of raw.teams as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const team = candidate as Record<string, unknown>;
    if (!isSafeCtoRunId(team.id) || teamIds.has(team.id)
      || !["pending", "in_progress", "parked", "done", "failed"].includes(String(team.status))
      || !team.escalations || typeof team.escalations !== "object" || Array.isArray(team.escalations)) return false;
    const escalations = team.escalations as Record<string, unknown>;
    if (Object.keys(escalations).length > MAX_PERSISTED_STATE_KEYS
      || Object.entries(escalations).some(([id, value]) => !isSafeCtoRunId(id) || !validEscalationRecord(value))) return false;
    teamIds.add(team.id);
  }
  const waves = raw.wave_history as unknown[];
  if (!persistedWaveAuthorityValid(waves, raw.active_wave_id)) return false;
  if (!persistedSpecificationExecutionSlicesValid(waves, raw.teams)) return false;
  if (!preparationFieldsValid(raw)) return false;
  return true;
}

/**
 * Additive, backward-compatible schema migration (br-zps.1, architecture 3.3):
 * ANY input — schema 1, missing schema, or a partial schema-2 state written
 * directly by a standby/legacy writer — becomes schema 2 with the schema-2
 * fields (`budget`, `leases`, `decisions`, `inbox_quarantine`, `wave_history`)
 * default-filled when absent. Present values are preserved untouched, so a
 * complete canonical state passes through unchanged. `health`/`scheduler`
 * stay undefined until their owning teams write them. `active_wave_id` and
 * `channel_profile` are deliberately NOT default-filled: they are set only by
 * their owners (wave lifecycle / channel resolver).
 */
export function migrateCtoState(raw: Record<string, unknown>): CtoState {
  const migrated = migrateLegacyPlanRows(raw);
  const schema = typeof migrated.schema === "number" ? migrated.schema : 1;
  const state: Record<string, unknown> = { ...migrated };
  if (schema < 2) state.schema = 2;
  if (state.budget === undefined) state.budget = defaultBudgetShape();
  if (state.leases === undefined) state.leases = {};
  if (state.decisions === undefined) state.decisions = [];
  if (state.inbox_quarantine === undefined) state.inbox_quarantine = {};
  if (state.wave_history === undefined) state.wave_history = [];
  if (state.pending_delivery_obligations === undefined) state.pending_delivery_obligations = [];
  if (state.terminal_summary_evidence === undefined) state.terminal_summary_evidence = [];
  // Revision is additive metadata. Legacy/malformed documents enter the CAS
  // protocol at revision 0; valid persisted revisions are preserved.
  state.state_revision = Number.isSafeInteger(state.state_revision) && (state.state_revision as number) >= 0
    ? state.state_revision
    : 0;
  if (schema === 2 && state.state_revision === 1 && state.pause === undefined) {
    state.pause = { kind: "none", reason: "" };
  }

  normalizeControlPlaneFields(state);
  return state as unknown as CtoState;
}

function isValidPersistedWaveRecord(value: unknown): value is WaveRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const wave = value as Partial<WaveRecord> & Record<string, unknown>;
  if (
    typeof wave.id !== "string"
    || typeof wave.source !== "string"
    || !isSafeCtoRunId(wave.source)
    || typeof wave.source_id !== "string"
    || typeof wave.task !== "string"
    || !isValidCtoTaskText(wave.task)
    || !Array.isArray(wave.slice_ids)
    || typeof wave.started_at !== "string"
    || !isCanonicalCtoTimestamp(wave.started_at)
  ) return false;
  if (wave.outcome !== undefined
    && (wave.outcome !== "pass" && wave.outcome !== "blocked")) return false;
  if (wave.blocked_feature_ids !== undefined
    && (!Array.isArray(wave.blocked_feature_ids)
      || wave.blocked_feature_ids.length > 64
      || new Set(wave.blocked_feature_ids).size !== wave.blocked_feature_ids.length
      || wave.blocked_feature_ids.some((featureId) => !isSafeFeatureId(featureId)))) return false;
  if (wave.findings !== undefined
    && (!Array.isArray(wave.findings)
      || wave.findings.length > 128
      || wave.findings.some((finding) => typeof finding !== "string" || finding.trim().length === 0 || Buffer.byteLength(finding, "utf8") > 4096))) return false;
  if (wave.conformance_receipt_ref !== undefined && !CTO_CONFORMANCE_RECEIPT_REF_RE.test(wave.conformance_receipt_ref)) return false;
  if (wave.status === "active") return wave.finished_at === undefined;
  return (
    (wave.status === "done" || wave.status === "failed")
    && typeof wave.finished_at === "string"
    && wave.finished_at.length > 0
    && isCanonicalCtoTimestamp(wave.finished_at)
  );
}

function persistedWaveHistoryValid(value: unknown): value is WaveRecord[] {
  if (!Array.isArray(value) || value.length > MAX_PERSISTED_STATE_ARRAY) return false;
  const waveIds = new Set<string>();
  const sourceIds = new Set<string>();
  const sliceIds = new Set<string>();
  let activeWaves = 0;
  for (const candidate of value) {
    if (!isValidPersistedWaveRecord(candidate)) return false;
    const wave = candidate as WaveRecord;
    const waveSliceIds = new Set<string>();
    if (!isSafeCtoRunId(wave.id) || waveIds.has(wave.id)
      || !isSafeCtoRunId(wave.source_id) || sourceIds.has(wave.source_id)) return false;
    for (const sliceId of wave.slice_ids) {
      if (!isSafeCtoRunId(sliceId) || waveSliceIds.has(sliceId) || sliceIds.has(sliceId)) return false;
      waveSliceIds.add(sliceId);
    }
    waveIds.add(wave.id);
    sourceIds.add(wave.source_id);
    for (const sliceId of waveSliceIds) sliceIds.add(sliceId);
    if (wave.status === "active") activeWaves += 1;
  }
  return activeWaves <= 1;
}
function persistedWaveAuthorityValid(history: unknown, activeWaveId: unknown): history is WaveRecord[] {
  if (!persistedWaveHistoryValid(history)) return false;
  const activeWaves = history.filter((wave) => wave.status === "active");
  if (activeWaves.length === 0) return activeWaveId === undefined;
  return activeWaves.length === 1 && activeWaveId === activeWaves[0]!.id;
}

function persistedSpecificationExecutionSlicesValid(history: unknown, teams: unknown): boolean {
  if (!Array.isArray(history) || !Array.isArray(teams)) return false;
  const executionWaves = history.filter((candidate): candidate is WaveRecord => candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).source === "specification-execution");
  if (executionWaves.length === 0) return true;
  const teamSlices: string[] = [];
  for (const candidate of teams) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const sliceId = (candidate as Record<string, unknown>).slice_id;
    if (typeof sliceId !== "string" || !isSafeCtoRunId(sliceId) || teamSlices.includes(sliceId)) return false;
    teamSlices.push(sliceId);
  }
  const actual = new Set(teamSlices);
  return executionWaves.every((wave) => {
    const requested = new Set(wave.slice_ids);
    return requested.size === wave.slice_ids.length
      && requested.size === actual.size
      && teamSlices.every((sliceId) => requested.has(sliceId));
  });
}

function assertWaveAuthority(state: Pick<CtoState, "wave_history" | "active_wave_id">): void {
  if (!persistedWaveAuthorityValid(state.wave_history ?? [], state.active_wave_id)) {
    throw new Error("invalid wave authority");
  }
}

function assertWaveHistoryAuthority(history: readonly WaveRecord[]): void {
  if (!persistedWaveHistoryValid(history)) throw new Error("invalid wave history authority");
}

function migrateLegacyPlanRows(raw: Record<string, unknown>): Record<string, unknown> {
  const plan = raw.plan;
  const rawTeams = raw.teams;
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || !Array.isArray((plan as Record<string, unknown>).teams) || !Array.isArray(rawTeams)) return raw;
  const planRecord = plan as Record<string, unknown>;
  const legacyRows = planRecord.teams as unknown[];
  if (!legacyRows.some((row) => row && typeof row === "object" && !Array.isArray(row) && !("team_def_id" in row))) return raw;
  const teams = rawTeams.filter((team): team is Record<string, unknown> => Boolean(team && typeof team === "object" && !Array.isArray(team)));
  const bySlice = new Map<string, Record<string, unknown>[]>();
  for (const team of teams) {
    if (typeof team.slice_id !== "string") continue;
    const matches = bySlice.get(team.slice_id) ?? [];
    matches.push(team);
    bySlice.set(team.slice_id, matches);
  }
  const migrated = legacyRows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || "team_def_id" in row) return row;
    const legacy = row as Record<string, unknown>;
    const matches = typeof legacy.slice === "string" ? bySlice.get(legacy.slice) ?? [] : [];
    if (matches.length !== 1) return row;
    const team = matches[0]!;
    if (typeof team.id !== "string" || typeof team.team_def_id !== "string") return row;
    return { ...legacy, team: team.id, team_def_id: team.team_def_id };
  });
  if (migrated.some((row) => !row || typeof row !== "object" || Array.isArray(row) || !("team_def_id" in row))) return raw;
  const byLegacyTeam = new Map<string, string>();
  const byLegacySlice = new Map<string, string>();
  const byTeamDef = new Map<string, string[]>();
  for (let index = 0; index < legacyRows.length; index += 1) {
    const before = legacyRows[index] as Record<string, unknown>;
    const after = migrated[index] as Record<string, unknown>;
    if (typeof before.team === "string" && typeof after.team === "string") byLegacyTeam.set(before.team, after.team);
    if (typeof before.slice === "string" && typeof after.team === "string") byLegacySlice.set(before.slice, after.team);
    if (typeof after.team_def_id === "string" && typeof after.team === "string") {
      const ids = byTeamDef.get(after.team_def_id) ?? [];
      ids.push(after.team);
      byTeamDef.set(after.team_def_id, ids);
    }
  }
  const knownIds = new Set(migrated.map((row) => (row as Record<string, unknown>).team).filter((id): id is string => typeof id === "string"));
  const resolved = migrated.map((row) => {
    const next = row as Record<string, unknown>;
    const dependencies = Array.isArray(next.depends_on) ? next.depends_on : [];
    const expanded = new Set<string>();
    for (const dependency of dependencies) {
      if (typeof dependency !== "string") continue;
      const direct = byLegacyTeam.get(dependency) ?? byLegacySlice.get(dependency);
      if (direct) expanded.add(direct);
      else if (knownIds.has(dependency)) expanded.add(dependency);
      else for (const id of byTeamDef.get(dependency) ?? []) expanded.add(id);
    }
    if (typeof next.team === "string") expanded.delete(next.team);
    return { ...next, depends_on: [...expanded].sort() };
  });
  return { ...raw, plan: { ...planRecord, teams: resolved } };
}

export function parsePersistedCtoState(raw: Record<string, unknown>): CtoState | null {
  const migratedRaw = migrateLegacyPlanRows(raw);
  if (!persistedStateStructureValid(migratedRaw)) return null;
  const state = migrateCtoState(migratedRaw);
  if (!persistedWaveAuthorityValid(state.wave_history, state.active_wave_id)) return null;
  state.wave_history = state.wave_history as WaveRecord[];
  return state;
}

export function readCtoState(runId: string, root: string): CtoState | null {
  if (!isSafeCtoRunId(runId)) return null;
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) return null;
  try {
    return readCtoStatePinned(runId, pinnedRoot);
  } finally {
    pinnedRoot.close();
  }
}

/** Read one CTO run exclusively through an already pinned project root. */
export function readCtoStatePinned(runId: string, pinnedRoot: PinnedProjectRoot): CtoState | null {
  if (!isSafeCtoRunId(runId)) return null;
  const relativePath = join(".work-state", "cto", runId, "state.json");
  if (!pinnedRoot.isStable()) throw new Error("pinned project root changed before CTO state read");
  try {
    const read = pinnedRoot.readFile(relativePath, { maxBytes: MAX_CTO_STATE_READ_BYTES });
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const state = parsePersistedCtoState(parsed as Record<string, unknown>);
    if (!state || state.id !== runId || !pinnedRoot.isStable()) return null;
    return state;
  } catch (error) {
    const code = pinnedStateErrorCode(error);
    if (code === "not_found") return null;
    if (code !== undefined) throw error;
    return null;
  }
}

/**
 * active-run lookup; acknowledged terminal runs remain as a bounded recent
 * summary cache alongside active, standby, and pending delivery entries.
 * Directory names are never an authority for discovery or delivery enumeration.
 */
export const CTO_RUN_DELIVERY_INDEX_FILE = "active-run-index.json";
export const MAX_CTO_RUN_DELIVERY_INDEX_ENTRIES = 4096;
export const MAX_CTO_RUN_DELIVERY_INDEX_BYTES = 2 * 1024 * 1024;
const CTO_RUN_DELIVERY_INDEX_LOCK_ID = "__run-delivery-index__";
const CTO_RUN_DELIVERY_PAGE_LIMIT = 64;
/**
 * A per-run publication journal closes the gap between durable staging and
 * publication into the outbox. Recovery completes the move before readers or
 * acknowledgement may treat the pending marker as settled.
 */
const CTO_RUN_OUTBOX_PUBLICATION_JOURNAL_FILE = ".outbox-publication-journal.json";
const CTO_RUN_OUTBOX_PUBLICATION_STAGE_FILE = ".outbox-publication-stage.json";
const CTO_RUN_OUTBOX_PUBLICATION_AUTHORITY_FILE = ".outbox-publication-authority.json";
const CTO_RUN_OUTBOX_PUBLICATION_AUTHORITY_SCHEMA_VERSION = 1;
const CTO_RUN_OUTBOX_PUBLICATION_JOURNAL_SCHEMA_VERSION = 1;
const MAX_CTO_OUTBOX_ENVELOPE_BYTES = 64 * 1024;
/**
 * A per-run publication journal closes the otherwise unavoidable gap between
 * the atomic state.json commit and the subsequent index commit.  A journal is
 * written before state.json and removed only after the index has been
 * published; recovery can therefore distinguish an interrupted publication
 * from an ordinary missing index.
 */
const CTO_RUN_DELIVERY_JOURNAL_DIRECTORY = ".active-run-index-journal";
const CTO_RUN_DELIVERY_JOURNAL_SCHEMA_VERSION = 2;
const CTO_RUN_DELIVERY_JOURNAL_LEGACY_SCHEMA_VERSION = 1;
const CTO_RUN_DELIVERY_INDEX_PROOF_FILE = ".active-run-index.proof.json";
const CTO_RUN_DELIVERY_INDEX_PROOF_SCHEMA_VERSION = 1;
const MAX_CTO_RUN_DISCOVERY_ENTRIES = MAX_CTO_RUN_DELIVERY_INDEX_ENTRIES * 2;
const MAX_CTO_RUN_DISCOVERY_NAME_BYTES = 512 * 1024;

export const MAX_CTO_TERMINAL_DELIVERY_CANDIDATES = 64;
export type CtoRunDeliveryStatus = "active" | "standby" | "done" | "failed";

export interface CtoRunDeliveryIndexEntry {
  run_id: string;
  state_revision: number;
  status: CtoRunDeliveryStatus;
  updated_at: string;
  pending_summary: boolean;
  pending_outbox: boolean;
  pending_retry: boolean;
  summary_digest: string;
}

export interface CtoRunDeliveryIndexPage {
  entries: CtoRunDeliveryIndexEntry[];
  next_after_run_id: string | null;
  active_run_id: string | null;
}


interface CtoRunDeliveryJournalPreimage {
  dev: number;
  ino: number;
  size: number;
  sha256: string;
}
interface CtoRunDeliveryOriginTransitionIntent {
  index_preimage: CtoRunDeliveryJournalPreimage;
  proof_preimage: CtoRunDeliveryJournalPreimage;
  prior: {
    standby: true;
    owner_session: null;
    identity_sha256: string;
    source_id: string;
    initial_state_sha256: string;
  };
  target: {
    standby: false;
    owner_session: string;
    identity_sha256: string;
  };
  proof: string;
}
interface CtoRunDeliveryPublicationJournal {
  schema_version: 1 | 2;
  run_id: string;
  state_revision: number;
  state_sha256: string;
  proof?: string;
  origin_transition?: CtoRunDeliveryOriginTransitionIntent;
}

type CtoRunDeliveryJournalRead = {
  journal: CtoRunDeliveryPublicationJournal;
  observed: { dev: number; ino: number; sha256: string };
};
interface CtoRunOutboxPublicationJournal {
  schema_version: 1;
  run_id: string;
  state_revision: number;
  envelope_id: string;
  entry_name: string;
  bytes_length: number;
  bytes_sha256: string;
}

interface CtoRunOutboxPublicationAuthorityEntry {
  entry_name: string;
  envelope_id: string;
  state_revision: number;
  bytes_length: number;
  bytes_sha256: string;
  routing_config_sha256: string;
  routing_snapshot_sha256: string;
  routing_channel: string | null;
  routing_target: string | null;
  proof: string;
}

interface CtoRunOutboxPublicationAuthority {
  schema_version: 1;
  run_id: string;
  entries: CtoRunOutboxPublicationAuthorityEntry[];
}

type CtoRunOutboxPublicationAuthorityRead = {
  authority: CtoRunOutboxPublicationAuthority;
  observed: { dev: number; ino: number; sha256: string };
};

type CtoRunOutboxPublicationJournalRead = {
  journal: CtoRunOutboxPublicationJournal;
  observed: { dev: number; ino: number; sha256: string };
};

interface CtoRunDeliveryIndex {
  schema_version: 2;
  active_run_id: string | null;
  entries: CtoRunDeliveryIndexEntry[];
}

type CtoRunDeliveryIndexRead = {
  index: CtoRunDeliveryIndex;
  observed: { dev: number; ino: number; sha256: string } | null;
  /** False means the durable index needs recovery before it is authoritative. */
  valid: boolean;
};

type CtoRunDeliveryIndexProof = {
  schema_version: 1;
  root_dev: number;
  root_ino: number;
  index_dev: number;
  index_ino: number;
  index_sha256: string;
  active_run_id: string | null;
  owner_session: string | null;
  proof: string;
};

export interface CtoRunDeliveryIndexAuthorityRead {
  readonly index: CtoRunDeliveryIndex;
  readonly authenticated: boolean;
}

function ctoRunDeliveryIndexProofBinding(
  pinnedRoot: PinnedProjectRoot,
  observed: { dev: number; ino: number; sha256: string },
  index: CtoRunDeliveryIndex,
  ownerSession: string | null,
): string {
  return [
    "omp-cto-run-delivery-index-proof-v1",
    pinnedRoot.canonical_root, String(pinnedRoot.dev), String(pinnedRoot.ino),
    String(observed.dev), String(observed.ino), observed.sha256,
    index.active_run_id ?? "", ownerSession ?? "",
  ].join("\u0000");
}

function ctoRunDeliveryIndexProofFor(
  pinnedRoot: PinnedProjectRoot,
  read: CtoRunDeliveryIndexRead,
  ownerSession: string | null,
): CtoRunDeliveryIndexProof | null {
  if (!read.valid || !read.observed) return null;
  const master = readOrCreateRootRuntimeSecret(pinnedRoot);
  const key = master ? deriveRuntimeSecretKey(master, "cto-index-v1") : null;
  if (!key) return null;
  const proof = createHmac("sha256", key)
    .update(ctoRunDeliveryIndexProofBinding(pinnedRoot, read.observed, read.index, ownerSession), "utf8")
    .digest("hex");
  return {
    schema_version: CTO_RUN_DELIVERY_INDEX_PROOF_SCHEMA_VERSION,
    root_dev: pinnedRoot.dev, root_ino: pinnedRoot.ino,
    index_dev: read.observed.dev, index_ino: read.observed.ino, index_sha256: read.observed.sha256,
    active_run_id: read.index.active_run_id, owner_session: ownerSession, proof,
  };
}

function parseCtoRunDeliveryIndexProof(raw: Uint8Array): CtoRunDeliveryIndexProof {
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CTO run-delivery index proof is invalid");
  const value = parsed as Record<string, unknown>;
  const keys = ["active_run_id", "index_dev", "index_ino", "index_sha256", "owner_session", "proof", "root_dev", "root_ino", "schema_version"];
  if (Object.keys(value).sort().join("\u0000") !== keys.join("\u0000")
    || value.schema_version !== CTO_RUN_DELIVERY_INDEX_PROOF_SCHEMA_VERSION
    || !Number.isSafeInteger(value.root_dev) || !Number.isSafeInteger(value.root_ino)
    || !Number.isSafeInteger(value.index_dev) || !Number.isSafeInteger(value.index_ino)
    || typeof value.index_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.index_sha256)
    || typeof value.proof !== "string" || !/^[0-9a-f]{64}$/u.test(value.proof)
    || (value.active_run_id !== null && !isSafeCtoRunDeliveryId(value.active_run_id))
    || (value.owner_session !== null && (typeof value.owner_session !== "string" || value.owner_session.length === 0))) {
    throw new Error("CTO run-delivery index proof is invalid");
  }
  return { schema_version: 1, root_dev: value.root_dev as number, root_ino: value.root_ino as number, index_dev: value.index_dev as number, index_ino: value.index_ino as number, index_sha256: value.index_sha256 as string, active_run_id: value.active_run_id as string | null, owner_session: value.owner_session as string | null, proof: value.proof as string };
}

type CtoRunDeliveryIndexProofRead =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "present"; value: CtoRunDeliveryIndexProof; observed: { dev: number; ino: number; sha256: string } };
function readCtoRunDeliveryIndexProofDetailedPinned(pinnedRoot: PinnedProjectRoot): CtoRunDeliveryIndexProofRead {
  const path = join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE);
  try {
    const info = pinnedRoot.pathEntryInfo(path);
    if (info === null) return { status: "absent" };
    if (info.kind !== "file") return { status: "invalid" };
    const read = pinnedRoot.readFile(path, { maxBytes: 16 * 1024 });
    return {
      status: "present",
      value: parseCtoRunDeliveryIndexProof(read.bytes),
      observed: ctoRunDeliveryIndexExpectation(read),
    };
  } catch (error) {
    if (pinnedStateErrorCode(error) === "not_found") return { status: "absent" };
    return { status: "invalid" };
  }
}
function readCtoRunDeliveryIndexProofPinned(pinnedRoot: PinnedProjectRoot): CtoRunDeliveryIndexProof | null {
  const read = readCtoRunDeliveryIndexProofDetailedPinned(pinnedRoot);
  return read.status === "present" ? read.value : null;
}

function indexProofAuthenticatesPinned(pinnedRoot: PinnedProjectRoot, read: CtoRunDeliveryIndexRead): boolean {
  const stored = readCtoRunDeliveryIndexProofPinned(pinnedRoot);
  if (!stored || !read.observed || !read.valid || !indexedCtoRunOriginsValidPinned(pinnedRoot, read.index.entries) || stored.root_dev !== pinnedRoot.dev || stored.root_ino !== pinnedRoot.ino
    || stored.index_dev !== read.observed.dev || stored.index_ino !== read.observed.ino || stored.index_sha256 !== read.observed!.sha256
    || stored.active_run_id !== read.index.active_run_id) return false;
  if (read.index.active_run_id !== null) {
    const state = readCtoStatePinned(read.index.active_run_id, pinnedRoot);
    const ownerSession = state?.standby === true ? null : state?.owner_session ?? null;
    if (!state || state.id !== read.index.active_run_id || ownerSession !== stored.owner_session) return false;
  }
  const expected = ctoRunDeliveryIndexProofFor(pinnedRoot, read, stored.owner_session);
  return !!expected && timingSafeEqual(Buffer.from(expected.proof, "hex"), Buffer.from(stored.proof, "hex"));
}

function journalIndexPreimagesStillMatchPinned(
  pinnedRoot: PinnedProjectRoot,
  journal: CtoRunDeliveryPublicationJournal,
): boolean {
  if (journal.schema_version !== 2 || !journal.origin_transition) return false;
  const check = (relativePath: string, expected: CtoRunDeliveryJournalPreimage, maxBytes: number): boolean => {
    try {
      const current = pinnedRoot.readFile(relativePath, { maxBytes });
      return current.dev === expected.dev && current.ino === expected.ino && current.bytes.byteLength === expected.size
        && createHash("sha256").update(current.bytes).digest("hex") === expected.sha256;
    } catch { return false; }
  };
  return check(ctoRunDeliveryIndexRelativePath(), journal.origin_transition.index_preimage, MAX_CTO_RUN_DELIVERY_INDEX_BYTES)
    && check(join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), journal.origin_transition.proof_preimage, 16 * 1024);
}

function recoverOriginTransitionFromJournalPinned(
  pinnedRoot: PinnedProjectRoot,
  state: CtoState,
  journal: CtoRunDeliveryPublicationJournal,
): boolean {
  if (!journalTransitionAuthenticatesPinned(pinnedRoot, journal) || !journal.origin_transition) return false;
  let stateDigest: string;
  try {
    const bytes = pinnedRoot.readFile(join(".work-state", "cto", state.id, "state.json"), { maxBytes: MAX_CTO_STATE_READ_BYTES }).bytes;
    stateDigest = createHash("sha256").update(bytes).digest("hex");
  } catch { return false; }
  if (state.state_revision !== journal.state_revision || stateDigest !== journal.state_sha256) return false;
  const transition = journal.origin_transition;
  if (state.standby === true || state.owner_session !== transition.target.owner_session
    || ctoRuntimeRunInitialIdentityDigest(state) !== transition.target.identity_sha256) return false;
  const current = readCtoRuntimeRunOriginHandoffPinned(pinnedRoot, state.id);
  if (hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state)) {
    const index = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
    return !!current
      && current.standby === false
      && current.owner_session === transition.target.owner_session
      && current.identity_sha256 === transition.target.identity_sha256
      && current.source_id === transition.prior.source_id
      && current.initial_state_sha256 === transition.prior.initial_state_sha256
      && ((index.valid && indexProofAuthenticatesPinned(pinnedRoot, index)) || journalIndexPreimagesStillMatchPinned(pinnedRoot, journal));
  }
  if (!journalIndexPreimagesStillMatchPinned(pinnedRoot, journal)) return false;
  const prior = current;
  if (!prior || prior.standby !== true || prior.owner_session !== null
    || prior.identity_sha256 !== transition.prior.identity_sha256
    || prior.source_id !== transition.prior.source_id
    || prior.initial_state_sha256 !== transition.prior.initial_state_sha256) return false;
  if (!refreshCtoRuntimeRunOriginPinned(
    pinnedRoot,
    state,
    transition.target.owner_session,
    transition.prior.source_id,
    transition.prior.initial_state_sha256,
  )) return false;
  return hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state);
}

function journalAllowsPriorStateProofPinned(
  pinnedRoot: PinnedProjectRoot,
  state: CtoState,
  journal: CtoRunDeliveryPublicationJournal,
): boolean {
  if (journal.schema_version !== 2 || !journalAuthenticatesPinned(pinnedRoot, journal)
    || (journal.origin_transition && !journalTransitionAuthenticatesPinned(pinnedRoot, journal))) return false;
  try {
    const prior = readCtoRuntimeStateProofRecordPinned(pinnedRoot, state.id);
    return !!prior
      && prior.state_revision === journal.state_revision - 1
      && validCtoRuntimeStateProofRecordPinned(pinnedRoot, state, prior);
  } catch { return false; }
}

function legacyJournalExactStateProofPinned(
  pinnedRoot: PinnedProjectRoot,
  state: CtoState,
  journal: CtoRunDeliveryPublicationJournal,
): boolean {
  if (journal.schema_version !== 1) return false;
  try {
    const bytes = pinnedRoot.readFile(join(".work-state", "cto", state.id, "state.json"), { maxBytes: MAX_CTO_STATE_READ_BYTES }).bytes;
    return state.state_revision === journal.state_revision
      && createHash("sha256").update(bytes).digest("hex") === journal.state_sha256
      && hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state)
      && hasValidCtoRuntimeStateProofPinned(pinnedRoot, state);
  } catch { return false; }
}

function recoverCtoRunDeliveryJournalsForRefreshPinned(pinnedRoot: PinnedProjectRoot): boolean {
  let names: string[];
  try { names = pinnedRoot.listDirectory(ctoRunDeliveryJournalDirectoryRelativePath(), { maxEntries: MAX_CTO_RUN_DELIVERY_INDEX_ENTRIES, maxNameBytes: MAX_CTO_RUN_DISCOVERY_NAME_BYTES }); }
  catch (error) { if (pinnedStateErrorCode(error) === "not_found") return true; throw error; }
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".index-before.json")) continue;
    const runId = name.slice(0, -".json".length);
    if (!isSafeCtoRunId(runId)) return false;
    const recovered = withCtoRunLock(pinnedRoot.canonical_root, runId, () => withCtoStateWriteLock(pinnedRoot.canonical_root, CTO_RUN_DELIVERY_INDEX_LOCK_ID, () => {
      const journalRead = readCtoRunDeliveryJournalPinned(pinnedRoot, runId);
      if (!journalRead) return true;
      const state = readCtoStatePinned(runId, pinnedRoot);
      if (!state) {
        const stateInfo = pinnedRoot.pathEntryInfo(join(".work-state", "cto", runId, "state.json"));
        if (stateInfo !== null) return false;
        pinnedRoot.removeFileIfMatches(ctoRunDeliveryJournalRelativePath(runId), journalRead.observed);
        return true;
      }
      const bytes = pinnedRoot.readFile(join(".work-state", "cto", runId, "state.json"), { maxBytes: MAX_CTO_STATE_READ_BYTES }).bytes;
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (journalRead.journal.schema_version === 2 && !journalAuthenticatesPinned(pinnedRoot, journalRead.journal)) return false;
      if (journalRead.journal.schema_version === 1 && !legacyJournalExactStateProofPinned(pinnedRoot, state, journalRead.journal)) return false;
      if (state.state_revision === journalRead.journal.state_revision && digest !== journalRead.journal.state_sha256) return false;
      if (journalRead.journal.schema_version === 2
        ? (journalRead.journal.origin_transition
          ? !recoverOriginTransitionFromJournalPinned(pinnedRoot, state, journalRead.journal)
          : !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state))
        : !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state)) return false;
      const proofStatus = ctoRuntimeStateProofStatusPinned(pinnedRoot, state);
      if (proofStatus === "invalid") {
        const prior = readCtoRuntimeStateProofRecordPinned(pinnedRoot, runId);
        if (!prior || (!validCtoRuntimeStateProofRecordPinned(pinnedRoot, state, prior)
          && !journalAllowsPriorStateProofPinned(pinnedRoot, state, journalRead.journal))) return false;
      }
      if (journalRead.journal.schema_version === 2
        && (!writeCtoRuntimeStateProof(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state))) return false;
      const current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
      const known = current.index.entries.find((entry) => entry.run_id === runId);
      const nextEntry = ctoRunDeliveryEntry(state, known, pinnedRoot, { reconcileQueueEvidence: true });
      const entries = boundedRunDeliveryEntries([...current.index.entries.filter((entry) => entry.run_id !== runId), nextEntry]);
      const next = { schema_version: 2 as const, active_run_id: latestActiveRunId(entries), entries };
      if (journalRead.journal.origin_transition && !journalIndexPreimagesStillMatchPinned(pinnedRoot, journalRead.journal)) return false;
      const currentProofAuthenticated = indexProofAuthenticatesPinned(pinnedRoot, current);
      const priorProofAuthenticated = !currentProofAuthenticated && (
        (journalRead.journal.schema_version === 2 && journalTransitionAuthenticatesPinned(pinnedRoot, journalRead.journal)
          && journalIndexPreimagesStillMatchPinned(pinnedRoot, journalRead.journal))
        || (() => {
          const proofRead = readCtoRunDeliveryIndexProofDetailedPinned(pinnedRoot);
          return proofRead.status === "present" && pendingJournalProofAuthenticatesPinned(pinnedRoot, proofRead.value);
        })()
      );
      if (!currentProofAuthenticated && !priorProofAuthenticated) return false;
      try {
        persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed, {
          allowAuthenticatedStaleProof: priorProofAuthenticated,
          ...(journalRead.journal.schema_version === 2 && priorProofAuthenticated ? { transitionJournal: journalRead.journal } : {}),
        });
      }
      catch (error) { if (pinnedStateErrorCode(error) === "changed" || pinnedStateErrorCode(error) === "not_found") return false; throw error; }
      clearCtoRunDeliveryIndexPreimagePinned(pinnedRoot, runId);
      try { pinnedRoot.removeFileIfMatches(ctoRunDeliveryJournalRelativePath(runId), journalRead.observed); }
      catch (error) { if (pinnedStateErrorCode(error) === "changed" || pinnedStateErrorCode(error) === "not_found") return false; throw error; }
      return true;
    }, { pinnedRoot }), { pinnedRoot });
    if (!recovered) return false;
  }
  return true;
}

function canonicalCtoRunDeliveryIndexPinned(pinnedRoot: PinnedProjectRoot): CtoRunDeliveryIndex | null {
  try {
    // Preserve acknowledgement state from an authenticated current index while
    // rebuilding structural metadata from canonical run state. A rebuild with
    // no known entries would re-arm every terminal summary after ack.
    const current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
    const knownEntries = current.valid ? current.index.entries : [];
    const entries = enumerateCtoRunDeliveryEntriesPinned(pinnedRoot, knownEntries, { strict: true, reconcileQueueEvidence: true });
    for (const entry of entries) {
      const state = readCtoStatePinned(entry.run_id, pinnedRoot);
      if (!state || state.id !== entry.run_id || !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state)) return null;
    }
    return { schema_version: 2, active_run_id: latestActiveRunId(entries), entries };
  } catch { return null; }
}

function indexProofAuthenticatesBytesPinned(pinnedRoot: PinnedProjectRoot, indexBytes: Uint8Array, stored: CtoRunDeliveryIndexProof): boolean {
  let parsed: { index: CtoRunDeliveryIndex; valid: boolean };
  try { parsed = parseCtoRunDeliveryIndex(indexBytes); } catch { return false; }
  if (!parsed.valid || stored.root_dev !== pinnedRoot.dev || stored.root_ino !== pinnedRoot.ino) return false;
  const read: CtoRunDeliveryIndexRead = { index: parsed.index, valid: true, observed: { dev: stored.index_dev, ino: stored.index_ino, sha256: createHash("sha256").update(indexBytes).digest("hex") } };
  if (stored.index_sha256 !== read.observed!.sha256 || stored.active_run_id !== parsed.index.active_run_id || !indexedCtoRunOriginsValidPinned(pinnedRoot, parsed.index.entries)) return false;
  if (parsed.index.active_run_id !== null) {
    const state = readCtoStatePinned(parsed.index.active_run_id, pinnedRoot);
    const owner = state?.standby === true ? null : state?.owner_session ?? null;
    if (!state || state.id !== parsed.index.active_run_id || owner !== stored.owner_session) return false;
  } else if (stored.owner_session !== null) return false;
  const expected = ctoRunDeliveryIndexProofFor(pinnedRoot, read, stored.owner_session);
  return !!expected && expected.proof === stored.proof;
}

function pendingJournalProofAuthenticatesPinned(pinnedRoot: PinnedProjectRoot, current: CtoRunDeliveryIndexProof): boolean {
  let names: string[];
  try { names = pinnedRoot.listDirectory(ctoRunDeliveryJournalDirectoryRelativePath(), { maxEntries: MAX_CTO_RUN_DELIVERY_INDEX_ENTRIES, maxNameBytes: MAX_CTO_RUN_DISCOVERY_NAME_BYTES }); }
  catch (error) { return pinnedStateErrorCode(error) === "not_found" ? false : false; }
  for (const name of names) {
    if (!name.endsWith(".index-before.json")) continue;
    const runId = name.slice(0, -".index-before.json".length);
    if (!isSafeCtoRunId(runId)) continue;
    try {
      const raw = JSON.parse(decodeUtf8(pinnedRoot.readFile(join(ctoRunDeliveryJournalDirectoryRelativePath(), name), { maxBytes: 2 * MAX_CTO_RUN_DELIVERY_INDEX_BYTES }).bytes)) as Record<string, unknown>;
      const keys = ["index_base64", "proof_base64", "schema_version"].join("\u0000");
      if (Object.keys(raw).sort().join("\u0000") !== keys || raw.schema_version !== 1 || typeof raw.index_base64 !== "string" || typeof raw.proof_base64 !== "string") continue;
      const indexBytes = Buffer.from(raw.index_base64, "base64");
      const proofBytes = Buffer.from(raw.proof_base64, "base64");
      const proof = parseCtoRunDeliveryIndexProof(proofBytes);
      if (JSON.stringify(proof) !== JSON.stringify(current) || !indexProofAuthenticatesBytesPinned(pinnedRoot, indexBytes, proof)) continue;
      return true;
    } catch { /* malformed preimage evidence is not authority */ }
  }
  return false;
}

function staleIndexProofMayAdvance(pinnedRoot: PinnedProjectRoot, proof: CtoRunDeliveryIndexProof, canonical: CtoRunDeliveryIndex, currentIndexSha256?: string): boolean {
  if (proof.root_dev !== pinnedRoot.dev || proof.root_ino !== pinnedRoot.ino) return false;
  if (currentIndexSha256 === undefined || proof.index_sha256 === currentIndexSha256) return false;
  return pendingJournalProofAuthenticatesPinned(pinnedRoot, proof);
}

function writeCtoRunDeliveryIndexProofIfCurrent(pinnedRoot: PinnedProjectRoot, proof: CtoRunDeliveryIndexProof, observed: { dev: number; ino: number; sha256: string } | null): boolean {
  const path = join('.work-state', 'cto', CTO_RUN_DELIVERY_INDEX_PROOF_FILE);
  const serialized = JSON.stringify(proof, null, 2) + '\n';
  try {
    if (observed === null) pinnedRoot.writeExclusive(path, serialized);
    else pinnedRoot.replaceFileIfMatches(path, observed, serialized);
    return true;
  } catch (error) {
    const code = pinnedStateErrorCode(error);
    if (code === 'already_exists' || code === 'conflict' || code === 'changed' || code === 'not_found') return false;
    throw error;
  }
}

function refreshCtoRunDeliveryIndexAuthorityPinnedUnlocked(pinnedRoot: PinnedProjectRoot, capability: unknown, ownerSession: string): boolean {
  if (!isCtoRuntimeDeliveryCapability(capability) || typeof ownerSession !== 'string' || ownerSession.length === 0) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let read: CtoRunDeliveryIndexRead;
    try { read = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot); }
    catch (error) { throw new Error(`delivery index unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    const canonical = canonicalCtoRunDeliveryIndexPinned(pinnedRoot);
    if (!canonical) return false;
    const proofRead = readCtoRunDeliveryIndexProofDetailedPinned(pinnedRoot);
    if (proofRead.status === 'invalid') return false;
    const indexExact = read.valid && read.index.active_run_id === canonical.active_run_id && ctoRunDeliveryEntriesEqual(read.index.entries, canonical.entries);
    if (!indexExact) {
      if (read.observed !== null && !read.valid) return false;
      if (proofRead.status === 'present') {
        if (!read.valid || (!indexProofAuthenticatesPinned(pinnedRoot, read) && !staleIndexProofMayAdvance(pinnedRoot, proofRead.value, canonical, read.observed?.sha256))) return false;
      }
      const next = { schema_version: 2 as const, active_run_id: canonical.active_run_id, entries: canonical.entries };
      try { persistCtoRunDeliveryIndexPinned(pinnedRoot, next, read.observed, { allowAuthenticatedStaleProof: proofRead.status === "present" }); }
      catch (error) {
        const code = pinnedStateErrorCode(error);
        if (code === 'conflict' || code === 'already_exists') continue;
        throw error;
      }
      continue;
    }
    let boundOwnerSession: string | null = null;
    if (canonical.active_run_id !== null) {
      const state = readCtoStatePinned(canonical.active_run_id, pinnedRoot);
      if (!state || state.id !== canonical.active_run_id) return false;
      if (state.standby !== true && state.owner_session !== ownerSession) return false;
      boundOwnerSession = state.standby === true ? null : state.owner_session ?? null;
    }
    const proof = ctoRunDeliveryIndexProofFor(pinnedRoot, read, boundOwnerSession);
    if (!proof || !read.observed) return false;
    if (proofRead.status === 'present') {
      const exact = indexProofAuthenticatesPinned(pinnedRoot, read);
      if (!exact && !staleIndexProofMayAdvance(pinnedRoot, proofRead.value, canonical, read.observed?.sha256)) return false;
      if (exact) return true;
      if (proofRead.value.index_sha256 === read.observed.sha256) return false;
    }
    pinnedRoot.ensureDirectories([join('.work-state', 'cto')]);
    if (!writeCtoRunDeliveryIndexProofIfCurrent(pinnedRoot, proof, proofRead.status === 'present' ? proofRead.observed : null)) continue;
    try {
      const verifiedIndex = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
      const verifiedProof = readCtoRunDeliveryIndexProofDetailedPinned(pinnedRoot);
      if (!verifiedIndex.valid || !verifiedIndex.observed || verifiedIndex.index.active_run_id !== canonical.active_run_id || !ctoRunDeliveryEntriesEqual(verifiedIndex.index.entries, canonical.entries) || verifiedProof.status !== 'present' || !indexProofAuthenticatesPinned(pinnedRoot, verifiedIndex)) continue;
      return true;
    } catch (error) { throw new Error(`delivery index unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return false;
}

export function refreshCtoRunDeliveryIndexAuthorityPinned(pinnedRoot: PinnedProjectRoot, capability: unknown, ownerSession: string): boolean {
  if (!isCtoRuntimeDeliveryCapability(capability) || typeof ownerSession !== "string" || ownerSession.length === 0) return false;
  if (!recoverCtoRunDeliveryJournalsForRefreshPinned(pinnedRoot)) return false;
  try {
    return withCtoStateWriteLock(
      pinnedRoot.canonical_root,
      CTO_RUN_DELIVERY_INDEX_LOCK_ID,
      () => refreshCtoRunDeliveryIndexAuthorityPinnedUnlocked(pinnedRoot, capability, ownerSession),
      { pinnedRoot },
    );
  } catch (error) {
    if (pinnedStateErrorCode(error) === "not_found" || pinnedStateErrorCode(error) === "changed") return false;
    throw error;
  }
}

export function readCtoRunDeliveryIndexAuthorityPinned(pinnedRoot: PinnedProjectRoot): CtoRunDeliveryIndexAuthorityRead {
  const read = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
  const canonical = canonicalCtoRunDeliveryIndexPinned(pinnedRoot);
  const authenticated = !!canonical
    && read.valid
    && read.index.active_run_id === canonical.active_run_id
    && ctoRunDeliveryEntriesEqual(read.index.entries, canonical.entries)
    && indexProofAuthenticatesPinned(pinnedRoot, read);
  return { index: read.index, authenticated };
}

function emptyCtoRunDeliveryIndex(): CtoRunDeliveryIndex {
  return { schema_version: 2, active_run_id: null, entries: [] };
}

function isSafeCtoRunDeliveryId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}
function isSafeCtoDeliveryEnvelopeId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 4096
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isCanonicalCtoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function compareRunDeliveryIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCtoRunDeliveryStatus(value: unknown): value is CtoRunDeliveryStatus {
  return value === "active" || value === "standby" || value === "done" || value === "failed";
}

function isTerminalDeliveryStatus(status: CtoRunDeliveryStatus): boolean {
  return status === "done" || status === "failed";
}

function ctoRunDeliveryStatus(state: CtoState): CtoRunDeliveryStatus {
  if (state.pause?.kind === "done") return "done";
  if (state.pause?.kind === "failed") return "failed";
  return state.standby === true ? "standby" : "active";
}

export function ctoRunDeliverySummaryDigest(state: CtoState): string {
  if (!Array.isArray(state.wave_history)) return "";
  const completed = state.wave_history
    .filter((wave) => wave && typeof wave === "object" && typeof wave.id === "string" && typeof wave.finished_at === "string")
    .map((wave) => {
      const value = wave as { id: string; finished_at: string; status?: string };
      return value.id + "\u0000" + value.finished_at + "\u0000" + (value.status ?? "");
    })
    .sort();
  return completed.length === 0 ? "" : createHash("sha256").update(completed.join("\n")).digest("hex");
}

function latestActiveRunId(entries: readonly CtoRunDeliveryIndexEntry[]): string | null {
  let latest: CtoRunDeliveryIndexEntry | undefined;
  for (const entry of entries) {
    if (isTerminalDeliveryStatus(entry.status)) continue;
    if (!latest || entry.updated_at > latest.updated_at || (entry.updated_at === latest.updated_at && entry.state_revision > latest.state_revision) || (entry.updated_at === latest.updated_at && entry.state_revision === latest.state_revision && compareRunDeliveryIds(entry.run_id, latest.run_id) < 0)) {
      latest = entry;
    }
  }
  return latest?.run_id ?? null;
}

function sortRunDeliveryEntries(entries: CtoRunDeliveryIndexEntry[]): CtoRunDeliveryIndexEntry[] {
  return entries.sort((left, right) => compareRunDeliveryIds(left.run_id, right.run_id));
}

function boundedRunDeliveryEntries(entries: CtoRunDeliveryIndexEntry[]): CtoRunDeliveryIndexEntry[] {
  if (entries.length > MAX_CTO_RUN_DELIVERY_INDEX_ENTRIES) {
    throw new Error(`CTO run-delivery index capacity exceeded: ${entries.length} canonical runs`);
  }
  return sortRunDeliveryEntries(entries);
}

function compactCtoRunDeliveryEntries(entries: readonly CtoRunDeliveryIndexEntry[]): CtoRunDeliveryIndexEntry[] {
  const protectedEntries = entries.filter((entry) => !isTerminalDeliveryStatus(entry.status) || entry.pending_summary || entry.pending_outbox || entry.pending_retry);
  const completed = entries
    .filter((entry) => isTerminalDeliveryStatus(entry.status) && !entry.pending_summary && !entry.pending_outbox && !entry.pending_retry)
    .sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at)
      || right.state_revision - left.state_revision
      || compareRunDeliveryIds(left.run_id, right.run_id),
    )
    .slice(0, MAX_CTO_TERMINAL_DELIVERY_CANDIDATES);
  return boundedRunDeliveryEntries([...protectedEntries, ...completed]);
}
function parseCtoRunDeliveryIndex(bytes: Uint8Array): { index: CtoRunDeliveryIndex; valid: boolean } {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.entries)) return { index: emptyCtoRunDeliveryIndex(), valid: false };
    if (parsed.entries.length > MAX_CTO_RUN_DELIVERY_INDEX_ENTRIES) return { index: emptyCtoRunDeliveryIndex(), valid: false };
    const legacy = parsed.schema_version === 1;
    if (!legacy && parsed.schema_version !== 2) return { index: emptyCtoRunDeliveryIndex(), valid: false };
    const expectedTopKeys = ["active_run_id", "entries", "schema_version"].join("\u0000");
    if (Object.keys(parsed).sort().join("\u0000") !== expectedTopKeys) return { index: emptyCtoRunDeliveryIndex(), valid: false };
    let valid = true;
    const byId = new Map<string, CtoRunDeliveryIndexEntry>();
    const originalIds: string[] = [];
    const expectedEntryKeys = legacy
      ? ["run_id", "state_revision", "updated_at"].join("\u0000")
      : ["pending_outbox", "pending_retry", "pending_summary", "run_id", "state_revision", "status", "summary_digest", "updated_at"].join("\u0000");
    const legacyV2EntryKeys = ["pending_outbox", "pending_summary", "run_id", "state_revision", "status", "summary_digest", "updated_at"].join("\u0000");
    for (const candidate of parsed.entries) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        valid = false;
        continue;
      }
      const value = candidate as Record<string, unknown>;
      const actualEntryKeys = Object.keys(value).sort().join("\u0000");
      if (actualEntryKeys !== expectedEntryKeys && !( !legacy && actualEntryKeys === legacyV2EntryKeys)
        || !isSafeCtoRunDeliveryId(value.run_id)
        || !Number.isSafeInteger(value.state_revision)
        || (value.state_revision as number) < 0
        || !isCanonicalCtoTimestamp(value.updated_at)) {
        valid = false;
        continue;
      }
      const status = legacy ? "active" : value.status;
      if (!isCtoRunDeliveryStatus(status)) {
        valid = false;
        continue;
      }
      if (!legacy
        && (typeof value.pending_summary !== "boolean"
          || (value.pending_outbox !== undefined && typeof value.pending_outbox !== "boolean")
          || (value.pending_retry !== undefined && typeof value.pending_retry !== "boolean")
          || !(value.summary_digest === "" || (typeof value.summary_digest === "string" && /^[0-9a-f]{64}$/iu.test(value.summary_digest))))) {
        valid = false;
        continue;
      }
      const entry: CtoRunDeliveryIndexEntry = {
        run_id: value.run_id,
        state_revision: value.state_revision as number,
        status,
        updated_at: value.updated_at,
        pending_summary: value.pending_summary === true,
        pending_outbox: value.pending_outbox === true,
        pending_retry: value.pending_retry === true,
        summary_digest: typeof value.summary_digest === "string" ? value.summary_digest : "",
      };
      if (byId.has(entry.run_id)) {
        valid = false;
        continue;
      }
      byId.set(entry.run_id, entry);
      originalIds.push(entry.run_id);
    }
    const entries = sortRunDeliveryEntries([...byId.values()]);
    if (originalIds.length !== entries.length || originalIds.some((runId, index) => runId !== entries[index]?.run_id)) valid = false;
    const requestedActive = parsed.active_run_id === null
      ? null
      : isSafeCtoRunDeliveryId(parsed.active_run_id) ? parsed.active_run_id : null;
    if (parsed.active_run_id !== null && requestedActive === null) valid = false;
    const activeEntry = requestedActive ? entries.find((entry) => entry.run_id === requestedActive && !isTerminalDeliveryStatus(entry.status)) : undefined;
    if (requestedActive !== null && !activeEntry) valid = false;
    const activeRunId = activeEntry?.run_id ?? latestActiveRunId(entries);
    if (parsed.active_run_id !== activeRunId) valid = false;
    return { index: { schema_version: 2, active_run_id: activeRunId, entries }, valid };
  } catch {
    return { index: emptyCtoRunDeliveryIndex(), valid: false };
  }
}


function ctoRunDeliveryIndexRelativePath(): string {
  return join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_FILE);
}

function ctoRunDeliveryIndexExpectation(read: { bytes: Uint8Array; dev: number; ino: number }): { dev: number; ino: number; sha256: string } {
  return { dev: read.dev, ino: read.ino, sha256: createHash("sha256").update(read.bytes).digest("hex") };
}

function readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot: PinnedProjectRoot): CtoRunDeliveryIndexRead {
  const path = ctoRunDeliveryIndexRelativePath();
  try {
    const read = pinnedRoot.readFile(path, { maxBytes: MAX_CTO_RUN_DELIVERY_INDEX_BYTES });
    const parsed = parseCtoRunDeliveryIndex(read.bytes);
    return { index: parsed.index, valid: parsed.valid, observed: ctoRunDeliveryIndexExpectation(read) };
  } catch (error) {
    if (pinnedStateErrorCode(error) === "not_found") return { index: emptyCtoRunDeliveryIndex(), observed: null, valid: false };
    throw error;
  }
}
export type CtoRunDeliveryCandidatesRead =
  | {
      ok: true;
      active_run_id: string | null;
      entries: CtoRunDeliveryIndexEntry[];
    }
  | {
      ok: false;
      code: "missing" | "corrupt" | "unavailable" | "recovery_required";
    };

/**
 * Read the canonical delivery index without recovery, directory discovery, or
 * writes. Consumers must remain unavailable when the index is absent/corrupt.
 */
function readCanonicalCtoRunDeliveryCandidatesPinned(
  pinnedRoot: PinnedProjectRoot,
): CtoRunDeliveryCandidatesRead {
  const path = ctoRunDeliveryIndexRelativePath();
  if (!pinnedRoot.isStable()) return { ok: false, code: "unavailable" };
  let info: ReturnType<PinnedProjectRoot["pathEntryInfo"]>;
  try {
    info = pinnedRoot.pathEntryInfo(path);
  } catch {
    return { ok: false, code: "unavailable" };
  }
  if (!info) return { ok: false, code: "missing" };
  if (info.kind !== "file") return { ok: false, code: "corrupt" };
  try {
    const read = pinnedRoot.readFile(path, { maxBytes: MAX_CTO_RUN_DELIVERY_INDEX_BYTES });
    const parsedRaw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) as unknown;
    if (!parsedRaw || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) return { ok: false, code: "corrupt" };
    const raw = parsedRaw as Record<string, unknown>;
    const topKeys = Object.keys(raw).sort().join("\u0000");
    if (raw.schema_version !== 2
      || topKeys !== ["active_run_id", "entries", "schema_version"].join("\u0000")
      || !(raw.active_run_id === null || isSafeCtoRunDeliveryId(raw.active_run_id))
      || !Array.isArray(raw.entries)
      || raw.entries.length > MAX_CTO_RUN_DELIVERY_INDEX_ENTRIES) {
      return { ok: false, code: "corrupt" };
    }
    const entryKeys = ["pending_outbox", "pending_retry", "pending_summary", "run_id", "state_revision", "status", "summary_digest", "updated_at"].sort().join("\u0000");
    const legacyEntryKeys = ["pending_outbox", "pending_summary", "run_id", "state_revision", "status", "summary_digest", "updated_at"].sort().join("\u0000");
    for (const candidate of raw.entries) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { ok: false, code: "corrupt" };
      const value = candidate as Record<string, unknown>;
      const actualEntryKeys = Object.keys(value).sort().join("\u0000");
      if (actualEntryKeys !== entryKeys && actualEntryKeys !== legacyEntryKeys
        || !isSafeCtoRunDeliveryId(value.run_id)
        || !Number.isSafeInteger(value.state_revision) || (value.state_revision as number) < 0
        || !isCtoRunDeliveryStatus(value.status)
        || !isCanonicalCtoTimestamp(value.updated_at)
        || typeof value.pending_summary !== "boolean"
        || (value.pending_outbox !== undefined && typeof value.pending_outbox !== "boolean")
        || (value.pending_retry !== undefined && typeof value.pending_retry !== "boolean")
        || !(value.summary_digest === "" || (typeof value.summary_digest === "string" && /^[0-9a-f]{64}$/iu.test(value.summary_digest)))) {
        return { ok: false, code: "corrupt" };
      }
    }
    const parsed = parseCtoRunDeliveryIndex(read.bytes);
    if (!parsed.valid) return { ok: false, code: "corrupt" };
    if (!indexedCtoRunOriginsValidPinned(pinnedRoot, parsed.index.entries)) return { ok: false, code: "recovery_required" };
    if (!pinnedRoot.isStable()) return { ok: false, code: "unavailable" };
    return {
      ok: true,
      active_run_id: parsed.index.active_run_id,
      entries: parsed.index.entries.map((entry) => ({ ...entry })),
    };
  } catch (error) {
    const code = pinnedStateErrorCode(error);
    return { ok: false, code: code === "not_found" ? "missing" : "unavailable" };
  }
}
/** Read all pending terminal summary candidates from the bounded canonical index. */
export function readCtoRunDeliveryCandidatesPinned(
  pinnedRoot: PinnedProjectRoot,
): CtoRunDeliveryCandidatesRead {
  try {
    return withCtoStateWriteLock(
      pinnedRoot.canonical_root,
      CTO_RUN_DELIVERY_INDEX_LOCK_ID,
      () => {
        recoverCtoRunDeliveryIndexLocked(pinnedRoot, { reconcileQueueEvidence: true });
        const result = readCanonicalCtoRunDeliveryCandidatesPinned(pinnedRoot);
        if (!result.ok) return result;
        return {
          ok: true,
          active_run_id: result.active_run_id,
          entries: result.entries
            .filter((entry) => (entry.status === "done" || entry.status === "failed") && (entry.pending_summary || entry.pending_outbox || entry.pending_retry))
            .sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
        };
      },
      { pinnedRoot },
    );
  } catch (error) {
    const code = pinnedStateErrorCode(error);
    return { ok: false, code: code === "not_found" ? "missing" : "unavailable" };
  }
}

/** Read recent terminal summaries regardless of whether delivery has been acknowledged. */
export function readCtoRunDeliveryCompletedCandidatesPinned(
  pinnedRoot: PinnedProjectRoot,
): CtoRunDeliveryCandidatesRead {
  try {
    const result = readCanonicalCtoRunDeliveryCandidatesPinned(pinnedRoot);
    if (!result.ok) return result;
    const terminalEntries = result.entries
      .filter((entry) => isTerminalDeliveryStatus(entry.status))
      .map((entry) => {
        const state = readCtoStatePinned(entry.run_id, pinnedRoot);
        return {
          entry: {
            ...entry,
            pending_outbox: entry.pending_outbox || ((state?.pending_delivery_obligations?.length ?? 0) > 0),
          },
          state,
        };
      });
    const protectedEntries = terminalEntries
      .filter(({ entry }) => entry.pending_summary || entry.pending_outbox || entry.pending_retry)
      .map(({ entry }) => entry);
    const completedEntries = terminalEntries
      .filter(({ entry }) => !entry.pending_summary && !entry.pending_outbox && !entry.pending_retry)
      .sort(({ entry: left }, { entry: right }) =>
        right.updated_at.localeCompare(left.updated_at)
        || right.state_revision - left.state_revision
        || compareRunDeliveryIds(left.run_id, right.run_id),
      )
      .slice(0, MAX_CTO_TERMINAL_DELIVERY_CANDIDATES)
      .map(({ entry }) => entry);
    const entries = [...protectedEntries, ...completedEntries];
    for (const entry of entries) {
      const state = readCtoStatePinned(entry.run_id, pinnedRoot);
      const rawRevision = state?.state_revision;
      const revision = typeof rawRevision === "number" && Number.isSafeInteger(rawRevision) && rawRevision >= 0
        ? rawRevision
        : undefined;
      if (
        !state
        || state.id !== entry.run_id
        || ctoRunDeliveryStatus(state) !== entry.status
        || revision !== entry.state_revision
        || state.updated_at !== entry.updated_at
        || ctoRunDeliverySummaryDigest(state) !== entry.summary_digest
      ) return { ok: false, code: "unavailable" };
    }
    return { ok: true, active_run_id: result.active_run_id, entries };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}
function ctoRunDeliveryEntriesEqual(
  left: readonly CtoRunDeliveryIndexEntry[],
  right: readonly CtoRunDeliveryIndexEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && entry.run_id === candidate.run_id
      && entry.state_revision === candidate.state_revision
      && entry.status === candidate.status
      && entry.updated_at === candidate.updated_at
      && entry.pending_summary === candidate.pending_summary
      && entry.pending_outbox === candidate.pending_outbox
      && entry.pending_retry === candidate.pending_retry
      && entry.summary_digest === candidate.summary_digest;
  });
}

function readIndexedCtoRunDeliveryActiveCandidatesPinned(
  pinnedRoot: PinnedProjectRoot,
): CtoRunDeliveryCandidatesRead {
  const result = readCanonicalCtoRunDeliveryCandidatesPinned(pinnedRoot);
  if (!result.ok) return result;
  const entries = result.entries
    .filter((entry) => entry.status === "active" || entry.status === "standby")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  for (const entry of entries) {
    const state = readCtoStatePinned(entry.run_id, pinnedRoot);
    if (!state || state.id !== entry.run_id) return { ok: false, code: "unavailable" };
    const revision = Number.isSafeInteger(state.state_revision) && (state.state_revision as number) >= 0
      ? state.state_revision as number
      : 0;
    if (ctoRunDeliveryStatus(state) !== entry.status
      || revision !== entry.state_revision
      || state.updated_at !== entry.updated_at
      || ctoRunDeliverySummaryDigest(state) !== entry.summary_digest) {
      return { ok: false, code: "unavailable" };
    }
  }
  return { ok: true, active_run_id: result.active_run_id, entries };
}

/** Read only indexed active/standby candidates for routing; never enumerate or rebuild the root. */
export function readCtoRunDeliveryActiveCandidatesPinned(
  pinnedRoot: PinnedProjectRoot,
): CtoRunDeliveryCandidatesRead {
  try {
    return withCtoStateWriteLock(
      pinnedRoot.canonical_root,
      CTO_RUN_DELIVERY_INDEX_LOCK_ID,
      () => {
        recoverCtoRunDeliveryIndexLocked(pinnedRoot, { reconcileQueueEvidence: true });
        return readIndexedCtoRunDeliveryActiveCandidatesPinned(pinnedRoot);
      },
      { pinnedRoot },
    );
  } catch (error) {
    const code = pinnedStateErrorCode(error);
    return { ok: false, code: code === "not_found" ? "missing" : "unavailable" };
  }
}

function readValidatedCtoRunDeliveryActiveCandidatesPinned(
  pinnedRoot: PinnedProjectRoot,
): CtoRunDeliveryCandidatesRead {
  const recovered = recoverCtoRunDeliveryIndexLocked(pinnedRoot, { reconcileQueueEvidence: false });
  const refreshed = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
  let current = refreshed.valid ? refreshed : { index: recovered, observed: null, valid: true };
  const canonicalEntries = enumerateCtoRunDeliveryEntriesPinned(pinnedRoot, current.index.entries, { strict: true, reconcileQueueEvidence: false });
  const indexedRunIds = new Set(current.index.entries.map((entry) => entry.run_id));
  const expectedEntries = canonicalEntries.filter((entry) => !isTerminalDeliveryStatus(entry.status) || indexedRunIds.has(entry.run_id));
  const expectedActiveRunId = latestActiveRunId(expectedEntries);
  if (current.index.active_run_id !== expectedActiveRunId || !ctoRunDeliveryEntriesEqual(current.index.entries, expectedEntries)) {
    const expected = { schema_version: 2 as const, active_run_id: expectedActiveRunId, entries: expectedEntries };
    persistCtoRunDeliveryIndexPinned(pinnedRoot, expected, current.observed);
    const refreshed = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
    if (!refreshed.valid || refreshed.index.active_run_id !== expectedActiveRunId || !ctoRunDeliveryEntriesEqual(refreshed.index.entries, expectedEntries)) {
      throw new Error("CTO run-delivery index changed while canonical recovery was in progress");
    }
    current = refreshed;
  }
  return {
    ok: true,
    active_run_id: current.index.active_run_id,
    entries: current.index.entries
      .filter((entry) => entry.status === "active" || entry.status === "standby")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
  };
}

/** Read and reconcile the complete bounded canonical active/standby set. */
export function readCtoRunDeliveryReconciledActiveCandidatesPinned(
  pinnedRoot: PinnedProjectRoot,
): CtoRunDeliveryCandidatesRead {
  try {
    return withCtoStateWriteLock(
      pinnedRoot.canonical_root,
      CTO_RUN_DELIVERY_INDEX_LOCK_ID,
      () => readValidatedCtoRunDeliveryActiveCandidatesPinned(pinnedRoot),
      { pinnedRoot },
    );
  } catch (error) {
    const code = pinnedStateErrorCode(error);
    return { ok: false, code: code === "not_found" ? "missing" : "unavailable" };
  }
}


function ctoRunDeliveryJournalDirectoryRelativePath(): string {
  return join(".work-state", "cto", CTO_RUN_DELIVERY_JOURNAL_DIRECTORY);
}

function ctoRunDeliveryJournalRelativePath(runId: string): string {
  return join(ctoRunDeliveryJournalDirectoryRelativePath(), `${runId}.json`);
}
function ctoRunDeliveryIndexPreimageRelativePath(runId: string): string {
  return join(ctoRunDeliveryJournalDirectoryRelativePath(), `${runId}.index-before.json`);
}
function writeCtoRunDeliveryIndexPreimagePinned(pinnedRoot: PinnedProjectRoot, runId: string, current: CtoRunDeliveryIndexRead): PinnedRootWriteReceipt | null {
  if (!current.observed || !current.valid) return null;
  try {
    const index = pinnedRoot.readFile(ctoRunDeliveryIndexRelativePath(), { maxBytes: MAX_CTO_RUN_DELIVERY_INDEX_BYTES });
    const proofBytes = (() => { try { return pinnedRoot.readFile(join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), { maxBytes: 16 * 1024 }).bytes; } catch { return null; } })();
    const payload = JSON.stringify({ schema_version: 1, index_base64: Buffer.from(index.bytes).toString("base64"), proof_base64: proofBytes ? Buffer.from(proofBytes).toString("base64") : null }) + "\n";
    return pinnedRoot.writeAtomicWithReceipt(ctoRunDeliveryIndexPreimageRelativePath(runId), payload);
  } catch { return null; }
}
function clearCtoRunDeliveryIndexPreimagePinned(pinnedRoot: PinnedProjectRoot, runId: string, receipt: PinnedRootWriteReceipt | null = null): void {
  try {
    const expected = receipt
      ? { dev: receipt.descriptor.dev, ino: receipt.descriptor.ino, size: receipt.descriptor.size, sha256: receipt.descriptor.sha256 }
      : (() => { const current = pinnedRoot.readFile(ctoRunDeliveryIndexPreimageRelativePath(runId), { maxBytes: 2 * MAX_CTO_RUN_DELIVERY_INDEX_BYTES }); return { dev: current.dev, ino: current.ino, sha256: createHash("sha256").update(current.bytes).digest("hex") }; })();
    pinnedRoot.removeFileIfMatches(ctoRunDeliveryIndexPreimageRelativePath(runId), expected);
  } catch { /* journal evidence remains for replay */ }
}
function ctoRunDeliveryJournalProof(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  stateRevision: number,
  stateSha256: string,
  transition?: CtoRunDeliveryOriginTransitionIntent,
): string | null {
  const master = readOrCreateRootRuntimeSecret(pinnedRoot);
  const key = master ? deriveRuntimeSecretKey(master, "cto-run-delivery-journal-v2") : null;
  if (!key) return null;
  const body = JSON.stringify({
    schema_version: 2,
    run_id: runId,
    state_revision: stateRevision,
    state_sha256: stateSha256,
    ...(transition ? { origin_transition: transition } : {}),
  });
  return createHmac("sha256", key)
    .update(["omp-cto-run-delivery-journal-v2", pinnedRoot.canonical_root, String(pinnedRoot.dev), String(pinnedRoot.ino), body].join("\u0000"), "utf8")
    .digest("hex");
}

function ctoRunDeliveryTransitionProof(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  stateRevision: number,
  stateSha256: string,
  transition: Omit<CtoRunDeliveryOriginTransitionIntent, "proof">,
): string | null {
  const master = readOrCreateRootRuntimeSecret(pinnedRoot);
  const key = master ? deriveRuntimeSecretKey(master, "cto-run-delivery-transition-v2") : null;
  if (!key) return null;
  const body = JSON.stringify({
    schema_version: 2,
    run_id: runId,
    state_revision: stateRevision,
    state_sha256: stateSha256,
    origin_transition: transition,
  });
  return createHmac("sha256", key)
    .update(["omp-cto-run-delivery-transition-v2", pinnedRoot.canonical_root, String(pinnedRoot.dev), String(pinnedRoot.ino), body].join("\u0000"), "utf8")
    .digest("hex");
}

function journalTransitionAuthenticatesPinned(
  pinnedRoot: PinnedProjectRoot,
  journal: CtoRunDeliveryPublicationJournal,
): boolean {
  if (journal.schema_version !== 2 || !journal.origin_transition) return false;
  const transition = journal.origin_transition;
  const withoutProof = {
    index_preimage: transition.index_preimage,
    proof_preimage: transition.proof_preimage,
    prior: transition.prior,
    target: transition.target,
  };
  const expected = ctoRunDeliveryTransitionProof(pinnedRoot, journal.run_id, journal.state_revision, journal.state_sha256, withoutProof);
  return !!expected && expected === transition.proof;
}

function journalAuthenticatesPinned(
  pinnedRoot: PinnedProjectRoot,
  journal: CtoRunDeliveryPublicationJournal,
): boolean {
  if (journal.schema_version !== 2 || typeof journal.proof !== "string") return false;
  const expected = ctoRunDeliveryJournalProof(pinnedRoot, journal.run_id, journal.state_revision, journal.state_sha256, journal.origin_transition);
  return !!expected && expected === journal.proof;
}

function parseCtoRunDeliveryJournal(bytes: Uint8Array): CtoRunDeliveryPublicationJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new Error("CTO run-delivery publication journal is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CTO run-delivery publication journal is not an object");
  const value = parsed as Record<string, unknown>;
  const baseKeys = ["run_id", "schema_version", "state_revision", "state_sha256"];
  const schema = value.schema_version;
  if (schema === CTO_RUN_DELIVERY_JOURNAL_LEGACY_SCHEMA_VERSION) {
    if (Object.keys(value).sort().join("\u0000") !== baseKeys.sort().join("\u0000")
      || !isSafeCtoRunId(value.run_id)
      || !Number.isSafeInteger(value.state_revision)
      || (value.state_revision as number) < 1
      || typeof value.state_sha256 !== "string"
      || !/^[0-9a-f]{64}$/i.test(value.state_sha256)) {
      throw new Error("CTO run-delivery publication journal is invalid");
    }
    return { schema_version: 1, run_id: value.run_id, state_revision: value.state_revision as number, state_sha256: value.state_sha256.toLowerCase() };
  }
  if (schema !== CTO_RUN_DELIVERY_JOURNAL_SCHEMA_VERSION
    || (Object.keys(value).sort().join("\u0000") !== [...baseKeys, "proof"].sort().join("\u0000")
      && Object.keys(value).sort().join("\u0000") !== [...baseKeys, "origin_transition", "proof"].sort().join("\u0000"))
    || !isSafeCtoRunId(value.run_id)
    || !Number.isSafeInteger(value.state_revision)
    || (value.state_revision as number) < 1
    || typeof value.state_sha256 !== "string"
    || !/^[0-9a-f]{64}$/i.test(value.state_sha256)
    || typeof value.proof !== "string" || !/^[0-9a-f]{64}$/i.test(value.proof)) {
    throw new Error("CTO run-delivery publication journal is invalid");
  }
  if (value.origin_transition === undefined) {
    return {
      schema_version: 2,
      run_id: value.run_id as string,
      state_revision: value.state_revision as number,
      state_sha256: (value.state_sha256 as string).toLowerCase(),
      proof: (value.proof as string).toLowerCase(),
    };
  }
  const raw = value.origin_transition;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("CTO run-delivery transition journal is invalid");
  const transition = raw as Record<string, unknown>;
  const prior = transition.prior;
  const target = transition.target;
  const indexPreimage = transition.index_preimage;
  const proofPreimage = transition.proof_preimage;
  if (!indexPreimage || typeof indexPreimage !== "object" || Array.isArray(indexPreimage)
    || !proofPreimage || typeof proofPreimage !== "object" || Array.isArray(proofPreimage)
    || !prior || typeof prior !== "object" || Array.isArray(prior) || !target || typeof target !== "object" || Array.isArray(target)
    || Object.keys(transition).sort().join("\u0000") !== ["index_preimage", "prior", "proof", "proof_preimage", "target"].join("\u0000")) throw new Error("CTO run-delivery transition journal is invalid");
  const ip = indexPreimage as Record<string, unknown>;
  const pp = proofPreimage as Record<string, unknown>;
  const validPreimage = (entry: Record<string, unknown>): boolean => Object.keys(entry).sort().join("\u0000") === ["dev", "ino", "sha256", "size"].join("\u0000")
    && Number.isSafeInteger(entry.dev) && Number.isSafeInteger(entry.ino) && Number.isSafeInteger(entry.size) && (entry.size as number) >= 0
    && typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/iu.test(entry.sha256);
  const p = prior as Record<string, unknown>;
  const t = target as Record<string, unknown>;
  if (!validPreimage(ip) || !validPreimage(pp)
    || Object.keys(p).sort().join("\u0000") !== ["identity_sha256", "initial_state_sha256", "owner_session", "source_id", "standby"].join("\u0000")
    || p.standby !== true || p.owner_session !== null || typeof p.identity_sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(p.identity_sha256)
    || typeof p.source_id !== "string" || p.source_id.length === 0 || typeof p.initial_state_sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(p.initial_state_sha256)
    || Object.keys(t).sort().join("\u0000") !== ["identity_sha256", "owner_session", "standby"].join("\u0000")
    || t.standby !== false || typeof t.owner_session !== "string" || t.owner_session.length === 0 || typeof t.identity_sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(t.identity_sha256)
    || typeof transition.proof !== "string" || !/^[0-9a-f]{64}$/i.test(transition.proof)) throw new Error("CTO run-delivery transition journal is invalid");
  return {
    schema_version: 2,
    run_id: value.run_id as string,
    state_revision: value.state_revision as number,
    state_sha256: (value.state_sha256 as string).toLowerCase(),
    proof: (value.proof as string).toLowerCase(),
    origin_transition: {
      index_preimage: { dev: ip.dev as number, ino: ip.ino as number, size: ip.size as number, sha256: (ip.sha256 as string).toLowerCase() },
      proof_preimage: { dev: pp.dev as number, ino: pp.ino as number, size: pp.size as number, sha256: (pp.sha256 as string).toLowerCase() },
      prior: { standby: true, owner_session: null, identity_sha256: p.identity_sha256.toLowerCase(), source_id: p.source_id as string, initial_state_sha256: p.initial_state_sha256.toLowerCase() },
      target: { standby: false, owner_session: t.owner_session as string, identity_sha256: t.identity_sha256.toLowerCase() },
      proof: (transition.proof as string).toLowerCase(),
    },
  };
}

function ctoRunOutboxPublicationJournalRelativePath(runId: string): string {
  return join(".work-state", "cto", runId, CTO_RUN_OUTBOX_PUBLICATION_JOURNAL_FILE);
}

function ctoRunOutboxPublicationAuthorityRelativePath(runId: string): string {
  return join(".work-state", "cto", runId, CTO_RUN_OUTBOX_PUBLICATION_AUTHORITY_FILE);
}

function parseCtoRunOutboxPublicationAuthority(bytes: Uint8Array): CtoRunOutboxPublicationAuthority {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new Error("CTO outbox publication authority is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CTO outbox publication authority is not an object");
  const value = parsed as Record<string, unknown>;
  const expectedKeys = ["entries", "run_id", "schema_version"].join("\u0000");
  if (Object.keys(value).sort().join("\u0000") !== expectedKeys
    || value.schema_version !== CTO_RUN_OUTBOX_PUBLICATION_AUTHORITY_SCHEMA_VERSION
    || !isSafeCtoRunId(value.run_id)
    || !Array.isArray(value.entries)
    || value.entries.length > MAX_CTO_RUN_DELIVERY_INDEX_ENTRIES) {
    throw new Error("CTO outbox publication authority is invalid");
  }
  const entries: CtoRunOutboxPublicationAuthorityEntry[] = [];
  for (const candidate of value.entries) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("CTO outbox publication authority entry is invalid");
    const entry = candidate as Record<string, unknown>;
    const entryKeys = ["bytes_length", "bytes_sha256", "entry_name", "envelope_id", "proof", "routing_channel", "routing_config_sha256", "routing_snapshot_sha256", "routing_target", "state_revision"].join("\u0000");
    if (Object.keys(entry).sort().join("\u0000") !== entryKeys
      || !isSafeCtoOutboxEntryName(entry.entry_name)
      || typeof entry.envelope_id !== "string"
      || entry.envelope_id.length === 0
      || Buffer.byteLength(entry.envelope_id, "utf8") > MAX_CTO_OUTBOX_ENVELOPE_BYTES
      || canonicalDurableIdFileName(entry.envelope_id) !== entry.entry_name
      || !Number.isSafeInteger(entry.state_revision)
      || (entry.state_revision as number) < 0
      || !Number.isSafeInteger(entry.bytes_length)
      || (entry.bytes_length as number) < 1
      || (entry.bytes_length as number) > MAX_CTO_OUTBOX_ENVELOPE_BYTES
      || typeof entry.bytes_sha256 !== "string"
      || !/^[0-9a-f]{64}$/iu.test(entry.bytes_sha256)
      || typeof entry.proof !== "string"
      || !/^[0-9a-f]{64}$/iu.test(entry.proof)
      || typeof entry.routing_config_sha256 !== "string"
      || !/^[0-9a-f]{64}$/iu.test(entry.routing_config_sha256)
      || typeof entry.routing_snapshot_sha256 !== "string"
      || !/^[0-9a-f]{64}$/iu.test(entry.routing_snapshot_sha256)
      || (entry.routing_channel !== null && typeof entry.routing_channel !== "string")
      || (entry.routing_target !== null && typeof entry.routing_target !== "string")
      || (typeof entry.routing_channel === "string" && Buffer.byteLength(entry.routing_channel, "utf8") > 512)
      || (typeof entry.routing_target === "string" && Buffer.byteLength(entry.routing_target, "utf8") > 1024)) {
      throw new Error("CTO outbox publication authority entry is invalid");
    }
    entries.push({
      entry_name: entry.entry_name,
      envelope_id: entry.envelope_id,
      state_revision: entry.state_revision as number,
      bytes_length: entry.bytes_length as number,
      bytes_sha256: entry.bytes_sha256.toLowerCase(),
      routing_config_sha256: entry.routing_config_sha256.toLowerCase(),
      routing_snapshot_sha256: entry.routing_snapshot_sha256.toLowerCase(),
      routing_channel: entry.routing_channel as string | null,
      routing_target: entry.routing_target as string | null,
      proof: entry.proof.toLowerCase(),
    });
  }
  entries.sort((left, right) => left.entry_name < right.entry_name ? -1 : left.entry_name > right.entry_name ? 1 : 0);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.entry_name === entries[index]!.entry_name) throw new Error("CTO outbox publication authority contains duplicate entries");
  }
  return { schema_version: CTO_RUN_OUTBOX_PUBLICATION_AUTHORITY_SCHEMA_VERSION, run_id: value.run_id, entries };
}

function serializeCtoRunOutboxPublicationAuthority(authority: CtoRunOutboxPublicationAuthority): string {
  const serialized = JSON.stringify(authority, null, 2) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_CTO_RUN_DELIVERY_INDEX_BYTES) throw new Error("CTO outbox publication authority exceeds its size limit");
  parseCtoRunOutboxPublicationAuthority(Buffer.from(serialized, "utf8"));
  return serialized;
}

function readCtoRunOutboxPublicationAuthorityPinned(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
): CtoRunOutboxPublicationAuthorityRead | null {
  try {
    const read = pinnedRoot.readFile(ctoRunOutboxPublicationAuthorityRelativePath(runId), { maxBytes: MAX_CTO_RUN_DELIVERY_INDEX_BYTES });
    const authority = parseCtoRunOutboxPublicationAuthority(read.bytes);
    if (authority.run_id !== runId) throw new Error("CTO outbox publication authority identity mismatch");
    return { authority, observed: ctoRunDeliveryIndexExpectation(read) };
  } catch (error) {
    if (pinnedStateErrorCode(error) === "not_found") return null;
    throw error;
  }
}

function ctoOutboxPublicationProof(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  descriptor: Omit<CtoRunOutboxPublicationAuthorityEntry, "proof">,
  delivery: Record<string, unknown>,
): string {
  const intent = String(ownCtoDeliveryValue(delivery, "intent"));
  const targetValue = ownCtoDeliveryValue(delivery, "target");
  const target = typeof targetValue === "string" ? targetValue : "";
  const binding = [
    "omp-cto-outbox-publication-v2",
    pinnedRoot.canonical_root,
    String(pinnedRoot.dev),
    String(pinnedRoot.ino),
    runId,
    descriptor.entry_name,
    descriptor.envelope_id,
    String(descriptor.state_revision),
    String(descriptor.bytes_length),
    descriptor.bytes_sha256,
    descriptor.routing_config_sha256,
    descriptor.routing_snapshot_sha256,
    descriptor.routing_channel ?? "",
    descriptor.routing_target ?? "",
    intent,
    target,
  ].join("\u0000");
  return createHmac("sha256", CTO_OUTBOX_PUBLICATION_TRUST_ROOT).update(binding, "utf8").digest("hex");
}

function outboxPublicationAuthorityEntryMatches(
  entry: CtoRunOutboxPublicationAuthorityEntry,
  descriptor: CtoRunOutboxPublicationAuthorityEntry,
): boolean {
  return entry.entry_name === descriptor.entry_name
    && entry.envelope_id === descriptor.envelope_id
    && entry.state_revision === descriptor.state_revision
    && entry.bytes_length === descriptor.bytes_length
    && entry.bytes_sha256 === descriptor.bytes_sha256
    && entry.routing_config_sha256 === descriptor.routing_config_sha256
    && entry.routing_snapshot_sha256 === descriptor.routing_snapshot_sha256
    && entry.routing_channel === descriptor.routing_channel
    && entry.routing_target === descriptor.routing_target
    && entry.proof === descriptor.proof;
}

function outboxPublicationAuthorityPayloadMatches(
  entry: CtoRunOutboxPublicationAuthorityEntry,
  descriptor: CtoRunOutboxPublicationAuthorityEntry,
): boolean {
  return entry.entry_name === descriptor.entry_name
    && entry.envelope_id === descriptor.envelope_id
    && entry.state_revision === descriptor.state_revision
    && entry.bytes_length === descriptor.bytes_length
    && entry.bytes_sha256 === descriptor.bytes_sha256;
}

function outboxPublicationAuthorityDescriptorMatches(
  entry: CtoRunOutboxPublicationAuthorityEntry,
  descriptor: CtoRunOutboxPublicationAuthorityEntry,
): boolean {
  return entry.entry_name === descriptor.entry_name
    && entry.envelope_id === descriptor.envelope_id
    && entry.state_revision === descriptor.state_revision
    && entry.bytes_length === descriptor.bytes_length
    && entry.bytes_sha256 === descriptor.bytes_sha256;
}

function persistCtoRunOutboxPublicationAuthorityPinned(
  pinnedRoot: PinnedProjectRoot,
  descriptor: CtoRunOutboxPublicationAuthorityEntry,
  allowPendingObligationReplacement = false,
): boolean {
  const runId = descriptor.envelope_id.split("/")[0];
  if (!isSafeCtoRunId(runId)) return false;
  const current = readCtoRunOutboxPublicationAuthorityPinned(pinnedRoot, runId);
  if (current) {
    const existing = current.authority.entries.find((candidate) => candidate.entry_name === descriptor.entry_name);
    if (existing) {
      if (outboxPublicationAuthorityEntryMatches(existing, descriptor)) return true;
      if (!outboxPublicationAuthorityDescriptorMatches(existing, descriptor) && !allowPendingObligationReplacement) return false;
      const next: CtoRunOutboxPublicationAuthority = {
        schema_version: CTO_RUN_OUTBOX_PUBLICATION_AUTHORITY_SCHEMA_VERSION,
        run_id: runId,
        entries: current.authority.entries.map((candidate) => candidate.entry_name === descriptor.entry_name ? descriptor : candidate),
      };
      pinnedRoot.replaceFileIfMatches(ctoRunOutboxPublicationAuthorityRelativePath(runId), current.observed, serializeCtoRunOutboxPublicationAuthority(next));
      return true;
    }
    const next: CtoRunOutboxPublicationAuthority = {
      schema_version: CTO_RUN_OUTBOX_PUBLICATION_AUTHORITY_SCHEMA_VERSION,
      run_id: runId,
      entries: [...current.authority.entries, descriptor].sort((left, right) => left.entry_name < right.entry_name ? -1 : left.entry_name > right.entry_name ? 1 : 0),
    };
    pinnedRoot.replaceFileIfMatches(ctoRunOutboxPublicationAuthorityRelativePath(runId), current.observed, serializeCtoRunOutboxPublicationAuthority(next));
    return true;
  }
  pinnedRoot.ensureDirectories([join(".work-state", "cto", runId)]);
  try {
    pinnedRoot.writeExclusive(ctoRunOutboxPublicationAuthorityRelativePath(runId), serializeCtoRunOutboxPublicationAuthority({
      schema_version: CTO_RUN_OUTBOX_PUBLICATION_AUTHORITY_SCHEMA_VERSION,
      run_id: runId,
      entries: [descriptor],
    }));
    return true;
  } catch (error) {
    if (pinnedStateErrorCode(error) !== "exists") throw error;
    const raced = readCtoRunOutboxPublicationAuthorityPinned(pinnedRoot, runId);
    const existing = raced?.authority.entries.find((candidate) => candidate.entry_name === descriptor.entry_name);
    return existing ? outboxPublicationAuthorityEntryMatches(existing, descriptor) : false;
  }
}

function parseCtoRunOutboxPublicationJournal(bytes: Uint8Array): CtoRunOutboxPublicationJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new Error("CTO outbox publication journal is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CTO outbox publication journal is not an object");
  const value = parsed as Record<string, unknown>;
  const expectedKeys = ["bytes_length", "bytes_sha256", "entry_name", "envelope_id", "run_id", "schema_version", "state_revision"].join("\u0000");
  if (
    Object.keys(value).sort().join("\u0000") !== expectedKeys
    || value.schema_version !== CTO_RUN_OUTBOX_PUBLICATION_JOURNAL_SCHEMA_VERSION
    || !isSafeCtoRunId(value.run_id)
    || !isSafeCtoOutboxEntryName(value.entry_name)
    || typeof value.envelope_id !== "string"
    || value.envelope_id.length === 0
    || Buffer.byteLength(value.envelope_id, "utf8") > MAX_CTO_OUTBOX_ENVELOPE_BYTES
    || !Number.isSafeInteger(value.state_revision)
    || (value.state_revision as number) < 0
    || !Number.isSafeInteger(value.bytes_length)
    || (value.bytes_length as number) < 1
    || (value.bytes_length as number) > MAX_CTO_OUTBOX_ENVELOPE_BYTES
    || typeof value.bytes_sha256 !== "string"
    || !/^[0-9a-f]{64}$/iu.test(value.bytes_sha256)
  ) throw new Error("CTO outbox publication journal is invalid");
  return {
    schema_version: CTO_RUN_OUTBOX_PUBLICATION_JOURNAL_SCHEMA_VERSION,
    run_id: value.run_id,
    state_revision: value.state_revision as number,
    envelope_id: value.envelope_id,
    entry_name: value.entry_name,
    bytes_length: value.bytes_length as number,
    bytes_sha256: value.bytes_sha256.toLowerCase(),
  };
}

function readCtoRunOutboxPublicationJournalPinned(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
): CtoRunOutboxPublicationJournalRead | null {
  try {
    const path = ctoRunOutboxPublicationJournalRelativePath(runId);
    const read = pinnedRoot.readFile(path, { maxBytes: MAX_CTO_OUTBOX_ENVELOPE_BYTES * 4 });
    const journal = parseCtoRunOutboxPublicationJournal(read.bytes);
    if (journal.run_id !== runId) throw new Error("CTO outbox publication journal identity mismatch");
    return { journal, observed: ctoRunDeliveryIndexExpectation(read) };
  } catch (error) {
    if (pinnedStateErrorCode(error) === "not_found") return null;
    throw error;
  }
}

function ctoRunOutboxPublicationJournalExistsPinned(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
): boolean {
  try {
    const info = pinnedRoot.pathEntryInfo(ctoRunOutboxPublicationJournalRelativePath(runId));
    if (!info) return false;
    if (info.kind !== "file") throw new Error(`CTO outbox publication journal for '${runId}' is not a regular file`);
    return true;
  } catch (error) {
    if (pinnedStateErrorCode(error) === "not_found") return false;
    throw error;
  }
}

function readCtoRunDeliveryJournalPinned(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
): CtoRunDeliveryJournalRead | null {
  try {
    const read = pinnedRoot.readFile(ctoRunDeliveryJournalRelativePath(runId), { maxBytes: 64 * 1024 });
    const journal = parseCtoRunDeliveryJournal(read.bytes);
    if (journal.run_id !== runId) throw new Error("CTO run-delivery publication journal identity mismatch");
    return { journal, observed: ctoRunDeliveryIndexExpectation(read) };
  } catch (error) {
    if (pinnedStateErrorCode(error) === "not_found") return null;
    throw error;
  }
}

function serializeCtoRunDeliveryIndex(next: CtoRunDeliveryIndex): string {
  if (!next || next.schema_version !== 2 || !Array.isArray(next.entries)) {
    throw new Error("CTO_RUN_DELIVERY_INDEX_INVALID: index envelope is not canonical");
  }
  const entries = boundedRunDeliveryEntries([...next.entries]);
  if (entries.some((entry, index) => entry !== next.entries[index])) {
    throw new Error("CTO_RUN_DELIVERY_INDEX_INVALID: entries are not canonically sorted");
  }
  const activeRunId = latestActiveRunId(entries);
  if (next.active_run_id !== activeRunId) {
    throw new Error("CTO_RUN_DELIVERY_INDEX_INVALID: active_run_id is not canonical");
  }
  const serialized = JSON.stringify(next, null, 2) + "\n";
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength > MAX_CTO_RUN_DELIVERY_INDEX_BYTES) {
    throw new Error(`CTO_RUN_DELIVERY_INDEX_INVALID: serialized index exceeds the ${MAX_CTO_RUN_DELIVERY_INDEX_BYTES}-byte limit`);
  }
  const parsed = parseCtoRunDeliveryIndex(bytes);
  if (!parsed.valid || parsed.index.active_run_id !== next.active_run_id || !ctoRunDeliveryEntriesEqual(parsed.index.entries, next.entries)) {
    throw new Error("CTO_RUN_DELIVERY_INDEX_INVALID: index entries are not schema-valid");
  }
  return serialized;
}

function publishCtoRunDeliveryIndexProofPinned(pinnedRoot: PinnedProjectRoot, indexRead: CtoRunDeliveryIndexRead): void {
  if (!indexRead.valid || !indexRead.observed || !indexedCtoRunOriginsValidPinned(pinnedRoot, indexRead.index.entries)) return;
  let ownerSession: string | null = null;
  if (indexRead.index.active_run_id !== null) {
    const state = readCtoStatePinned(indexRead.index.active_run_id, pinnedRoot);
    if (!state || state.id !== indexRead.index.active_run_id) return;
    ownerSession = state.standby === true ? null : state.owner_session ?? null;
  }
  const proof = ctoRunDeliveryIndexProofFor(pinnedRoot, indexRead, ownerSession);
  if (!proof) throw new PinnedRootError("recovery_required", "CTO delivery index proof could not be derived from authenticated state");
  const current = readCtoRunDeliveryIndexProofDetailedPinned(pinnedRoot);
  if (current.status === "invalid") throw new PinnedRootError("recovery_required", "CTO delivery index proof is present but invalid");
  const ok = writeCtoRunDeliveryIndexProofIfCurrent(pinnedRoot, proof, current.status === "present" ? current.observed : null);
  if (!ok) throw new PinnedRootError("changed", "CTO delivery index proof changed during publication");
}

function persistCtoRunDeliveryIndexPinned(
  pinnedRoot: PinnedProjectRoot,
  next: CtoRunDeliveryIndex,
  observed: CtoRunDeliveryIndexRead["observed"],
  options: { allowAuthenticatedStaleProof?: boolean; transitionJournal?: CtoRunDeliveryPublicationJournal } = {},
): void {
  const transitionJournalAuthorized = options.transitionJournal?.schema_version === 2
    && journalTransitionAuthenticatesPinned(pinnedRoot, options.transitionJournal)
    && journalIndexPreimagesStillMatchPinned(pinnedRoot, options.transitionJournal);
  // Never mutate an index while a present proof is malformed or fails its
  // current-image HMAC. Missing proofs are the only repairable gap.
  const current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
  const currentProof = readCtoRunDeliveryIndexProofDetailedPinned(pinnedRoot);
  if (currentProof.status === "invalid") throw new PinnedRootError("recovery_required", "CTO delivery index proof is present but invalid");
  if (currentProof.status === "present" && current.valid && !indexProofAuthenticatesPinned(pinnedRoot, current)
    && options.allowAuthenticatedStaleProof !== true && !transitionJournalAuthorized) {
    throw new PinnedRootError("recovery_required", "CTO delivery index proof does not authenticate the current index");
  }
  if (currentProof.status === "present" && !current.valid) {
    throw new PinnedRootError("recovery_required", "CTO delivery index is corrupt while its proof is present");
  }
  const serialized = serializeCtoRunDeliveryIndex(next);
  const path = ctoRunDeliveryIndexRelativePath();
  if (transitionJournalAuthorized && !journalIndexPreimagesStillMatchPinned(pinnedRoot, options.transitionJournal!)) {
    throw new PinnedRootError("changed", "CTO transition index preimage changed before index CAS");
  }
  if (observed === null) {
    pinnedRoot.ensureDirectories([join(".work-state", "cto")]);
    pinnedRoot.writeExclusive(path, serialized);
  } else {
    pinnedRoot.replaceFileIfMatches(path, observed, serialized);
  }
  const published = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
  publishCtoRunDeliveryIndexProofPinned(pinnedRoot, published);
}

function ctoRunDeliveryEntry(
  state: CtoState,
  known?: CtoRunDeliveryIndexEntry,
  pinnedRoot?: PinnedProjectRoot,
  options: { reconcileQueueEvidence?: boolean } = {},
): CtoRunDeliveryIndexEntry {
  const revision = Number.isSafeInteger(state.state_revision) && (state.state_revision as number) >= 0
    ? state.state_revision as number
    : 0;
  const status = ctoRunDeliveryStatus(state);
  const summaryDigest = ctoRunDeliverySummaryDigest(state);
  return {
    run_id: state.id,
    state_revision: revision,
    status,
    updated_at: typeof state.updated_at === "string" ? state.updated_at : "",
    pending_summary: known
      ? known.pending_summary
        || (!isTerminalDeliveryStatus(known.status) && isTerminalDeliveryStatus(status))
        || (summaryDigest !== "" && summaryDigest !== known.summary_digest)
      : isTerminalDeliveryStatus(status),
    pending_outbox: Boolean(known?.pending_outbox || ((state.pending_delivery_obligations?.length ?? 0) > 0) || (options.reconcileQueueEvidence !== false && pinnedRoot ? !ctoRunOutboxQueueEvidenceEmptyPinned(pinnedRoot, state.id) : false)),
    pending_retry: Boolean(known?.pending_retry || (options.reconcileQueueEvidence !== false && pinnedRoot ? !ctoRunRetryQueueEvidenceEmptyPinned(pinnedRoot, state.id) : false)),
    summary_digest: summaryDigest,
  };
}

function enumerateCtoRunDeliveryEntriesPinned(
  pinnedRoot: PinnedProjectRoot,
  knownEntries: readonly CtoRunDeliveryIndexEntry[] = [],
  options: { strict?: boolean; reconcileQueueEvidence?: boolean } = {},
): CtoRunDeliveryIndexEntry[] {
  const strict = options.strict === true;
  let names: string[];
  try {
    names = pinnedRoot.listDirectory(join(".work-state", "cto"), {
      maxEntries: MAX_CTO_RUN_DISCOVERY_ENTRIES,
      maxNameBytes: MAX_CTO_RUN_DISCOVERY_NAME_BYTES,
    });
  } catch (error) {
    if (pinnedStateErrorCode(error) === "not_found") return [];
    throw error;
  }
  const knownById = new Map(knownEntries.map((entry) => [entry.run_id, entry]));
  const entries: CtoRunDeliveryIndexEntry[] = [];
  for (const name of names) {
    if (name === CTO_RUN_DELIVERY_INDEX_FILE || name === CTO_RUN_DELIVERY_JOURNAL_DIRECTORY || name === CTO_RUN_DELIVERY_INDEX_PROOF_FILE || RESERVED_CTO_RUN_IDS.has(name)) continue;
    const indexed = knownById.has(name);
    const relativeRunDirectory = join(".work-state", "cto", name);
    const info = pinnedRoot.pathEntryInfo(relativeRunDirectory);
    if (!info) {
      if (strict && indexed) throw new Error(`indexed CTO run directory '${name}' disappeared during canonical recovery`);
      continue;
    }
    if (!isSafeCtoRunId(name)) {
      if (strict && (info.kind === "directory" || info.kind === "symlink" || info.kind === "other")) {
        throw new Error(`unsafe CTO run directory '${name}' is not a canonical directory`);
      }
      continue;
    }
    if (info.kind === "symlink" || info.kind === "other") {
      if (strict) throw new Error(`CTO run directory '${name}' is not a canonical directory`);
      continue;
    }
    if (info.kind !== "directory") {
      if (strict && indexed) throw new Error(`indexed CTO run directory '${name}' is not a canonical directory`);
      continue;
    }
    const statePathInfo = pinnedRoot.pathEntryInfo(join(relativeRunDirectory, "state.json"));
    const state = readCtoStatePinned(name, pinnedRoot);
    if (!state) {
      if (strict && (indexed || statePathInfo !== null)) throw new Error(`canonical CTO state for '${name}' is missing or unreadable`);
      continue;
    }
    if (state.id !== name || !isSafeCtoRunId(state.id)) throw new Error(`CTO state identity mismatch for '${name}'`);
    entries.push(ctoRunDeliveryEntry(state, knownById.get(name), pinnedRoot, options));
  }
  if (strict) {
    const seenRunIds = new Set(entries.map((entry) => entry.run_id));
    for (const entry of knownEntries) {
      if (!seenRunIds.has(entry.run_id)) throw new Error(`indexed CTO run '${entry.run_id}' has no readable canonical state`);
    }
  }
  if (entries.length > MAX_CTO_RUN_DELIVERY_INDEX_ENTRIES) {
    throw new Error(`CTO run-delivery index capacity exceeded: ${entries.length} canonical runs`);
  }
  return sortRunDeliveryEntries(entries);
}

/** Rebuild the bounded index from canonical state files, never from names alone. */
function rebuildCtoRunDeliveryIndexPinned(pinnedRoot: PinnedProjectRoot, options: { reconcileQueueEvidence?: boolean } = {}): CtoRunDeliveryIndex {
  const entries = enumerateCtoRunDeliveryEntriesPinned(pinnedRoot, [], options);
  return { schema_version: 2, active_run_id: latestActiveRunId(entries), entries };
}
function ctoRunDeliveryQueueEvidencePinned(
  pinnedRoot: PinnedProjectRoot,
  runIds: readonly string[],
): Map<string, { outbox: boolean; retry: boolean }> {
  const result = new Map<string, { outbox: boolean; retry: boolean }>();
  for (let index = 0; index < runIds.length; index += 8) {
    const chunk = runIds.slice(index, index + 8);
    const paths = chunk.flatMap((runId) => [
      ctoRunOutboxRelativePath(runId),
      join(".work-state", "cto", runId, "outbox-retry"),
    ]);
    let infos: Array<ReturnType<PinnedProjectRoot["pathEntryInfo"]>>;
    try {
      infos = pinnedRoot.pathEntryInfoBatch(paths);
    } catch (error) {
      if (pinnedStateErrorCode(error) === "not_found") {
        for (const runId of chunk) result.set(runId, { outbox: false, retry: false });
        continue;
      }
      for (const runId of chunk) result.set(runId, { outbox: true, retry: true });
      continue;
    }
    chunk.forEach((runId, chunkIndex) => {
      const outboxInfo = infos[chunkIndex * 2] ?? null;
      const retryInfo = infos[chunkIndex * 2 + 1] ?? null;
      const queueHasEvidence = (info: ReturnType<PinnedProjectRoot["pathEntryInfo"]>, relativePath: string): boolean => {
        if (info === null) return false;
        if (info.kind !== "directory") return true;
        return !ctoRunDeliveryQueueEmptyPinned(pinnedRoot, relativePath, true);
      };
      result.set(runId, {
        outbox: queueHasEvidence(outboxInfo, ctoRunOutboxRelativePath(runId)),
        retry: queueHasEvidence(retryInfo, join(".work-state", "cto", runId, "outbox-retry")),
      });
    });
  }
  return result;
}

function reconcileIndexedCtoRunDeliveryEntriesPinned(
  pinnedRoot: PinnedProjectRoot,
  current: CtoRunDeliveryIndexRead,
): CtoRunDeliveryIndexRead {
  let canonical: CtoRunDeliveryIndexEntry[];
  try {
    canonical = enumerateCtoRunDeliveryEntriesPinned(pinnedRoot, current.index.entries, {
      strict: false,
      reconcileQueueEvidence: false,
    });
  } catch (error) {
    if (pinnedStateErrorCode(error) === "limit") return current;
    throw error;
  }
  const knownById = new Map(current.index.entries.map((entry) => [entry.run_id, entry]));
  const expected = canonical
    .filter((entry) => !isTerminalDeliveryStatus(entry.status) || knownById.has(entry.run_id))
    .map((entry) => {
      const known = knownById.get(entry.run_id);
      if (!known) return entry;
      const state = readCtoStatePinned(entry.run_id, pinnedRoot);
      if (!state) return entry;
      // Pending flags are rebuilt only from state-owned obligations here;
      // authenticated queue evidence is added by the following authority
      // reconciliation pass. Never carry forgeable index booleans forward.
      return {
        ...entry,
        pending_summary: entry.pending_summary && !terminalSummaryDeliveredPinned(pinnedRoot, state),
        pending_outbox: (state.pending_delivery_obligations?.length ?? 0) > 0,
        pending_retry: false,
      };
    });
  const nextEntries = boundedRunDeliveryEntries(expected);
  const next: CtoRunDeliveryIndex = {
    schema_version: 2,
    active_run_id: latestActiveRunId(nextEntries),
    entries: nextEntries,
  };
  if (ctoRunDeliveryEntriesEqual(nextEntries, current.index.entries) && next.active_run_id === current.index.active_run_id) return current;
  persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed);
  return readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
}

function reconcileCtoRunDeliveryObligationEvidencePinned(
  pinnedRoot: PinnedProjectRoot,
  current: CtoRunDeliveryIndexRead,
): CtoRunDeliveryIndexRead {
  // Read canonical run directories once; do not probe every indexed ID on each
  // page read. Missing indexed directories are handled by the bounded
  // canonical recovery pass below, while state-owned obligations are promoted
  // from the readable canonical set regardless of stale index flags.
  let canonical: CtoRunDeliveryIndexEntry[];
  try {
    canonical = enumerateCtoRunDeliveryEntriesPinned(pinnedRoot, current.index.entries, {
      strict: false,
      reconcileQueueEvidence: false,
    });
  } catch (error) {
    // A valid indexed read must remain usable when unrelated canonical junk
    // exceeds the bounded discovery budget; indexed candidates are still
    // authoritative and the next bounded recovery may retry discovery.
    if (pinnedStateErrorCode(error) === "limit") return current;
    throw error;
  }
  const obligationRuns = new Set<string>();
  for (const entry of canonical) {
    const state = readCtoStatePinned(entry.run_id, pinnedRoot);
    if ((state?.pending_delivery_obligations?.length ?? 0) > 0) obligationRuns.add(entry.run_id);
  }
  const entries = boundedRunDeliveryEntries(current.index.entries.map((entry) => ({
    ...entry,
    pending_outbox: entry.pending_outbox || obligationRuns.has(entry.run_id),
  })));
  if (ctoRunDeliveryEntriesEqual(entries, current.index.entries)) return current;
  const next: CtoRunDeliveryIndex = { schema_version: 2, active_run_id: latestActiveRunId(entries), entries };
  persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed);
  return readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
}

function reconcileMissingCtoRunDeliveryObligationEntriesPinned(
  pinnedRoot: PinnedProjectRoot,
  current: CtoRunDeliveryIndexRead,
): CtoRunDeliveryIndexRead {
  // A valid index can still be missing a terminal run whose obligation was
  // committed immediately before a crash. Discover canonical run state in one
  // bounded directory pass and transactionally add only obligation-owned runs.
  let canonical: CtoRunDeliveryIndexEntry[];
  try {
    canonical = enumerateCtoRunDeliveryEntriesPinned(pinnedRoot, current.index.entries, {
      strict: false,
      reconcileQueueEvidence: false,
    });
  } catch (error) {
    if (pinnedStateErrorCode(error) === "limit") return current;
    throw error;
  }
  const knownById = new Map(current.index.entries.map((entry) => [entry.run_id, entry]));
  let changed = false;
  for (const entry of canonical) {
    const state = readCtoStatePinned(entry.run_id, pinnedRoot);
    if ((state?.pending_delivery_obligations?.length ?? 0) === 0) continue;
    const known = knownById.get(entry.run_id);
    if (!known || !ctoRunDeliveryEntriesEqual([known], [entry])) {
      knownById.set(entry.run_id, entry);
      changed = true;
    }
  }
  if (!changed) return current;
  const entries = boundedRunDeliveryEntries([...knownById.values()]);
  const next: CtoRunDeliveryIndex = { schema_version: 2, active_run_id: latestActiveRunId(entries), entries };
  persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed);
  return readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
}

function reconcileCtoRunDeliveryQueueEvidencePinned(
  pinnedRoot: PinnedProjectRoot,
  current: CtoRunDeliveryIndexRead,
): CtoRunDeliveryIndexRead {
  // Valid indexes are reconciled only from durable queue evidence under
  // already-indexed run IDs; canonical root enumeration belongs to invalid-index
  // rebuild and candidate validation, never this recovery path.
  const evidence = ctoRunDeliveryQueueEvidencePinned(pinnedRoot, current.index.entries.map((entry) => entry.run_id));
  const entries = boundedRunDeliveryEntries(current.index.entries.map((entry) => {
    const queue = evidence.get(entry.run_id);
    if (!queue?.outbox && !queue?.retry) return entry;
    // Queue names are not publication authority. Only an indexed run with a
    // readable authenticated commitment may have new same-run bytes reassert
    // bounded work; orphan/malformed queues never revive a run.
    let hasAuthority = false;
    try { hasAuthority = readCtoRunOutboxPublicationAuthorityPinned(pinnedRoot, entry.run_id) !== null; } catch { hasAuthority = false; }
    if (!hasAuthority) return entry;
    return {
      ...entry,
      pending_outbox: entry.pending_outbox || queue.outbox === true,
      pending_retry: entry.pending_retry || queue.retry === true,
    };
  }));
  if (ctoRunDeliveryEntriesEqual(entries, current.index.entries)) return current;
  const next: CtoRunDeliveryIndex = { schema_version: 2, active_run_id: latestActiveRunId(entries), entries };
  persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed);
  return readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
}

function recoverCtoRunDeliveryIndexLocked(
  pinnedRoot: PinnedProjectRoot,
  options: { reconcileQueueEvidence?: boolean; reconcileObligations?: boolean } = {},
): CtoRunDeliveryIndex {
  let current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
  // Validate pending publication proofs before any index repair. A tampered
  // proof must fail closed rather than being hidden by a rebuilt index.
  let pendingJournalNames: string[] = [];
  try {
    pendingJournalNames = pinnedRoot.listDirectory(ctoRunDeliveryJournalDirectoryRelativePath(), { maxEntries: MAX_CTO_RUN_DELIVERY_INDEX_ENTRIES, maxNameBytes: MAX_CTO_RUN_DISCOVERY_NAME_BYTES });
  } catch (error) {
    if (pinnedStateErrorCode(error) !== "not_found") throw error;
  }
  for (const name of pendingJournalNames) {
    if (!name.endsWith(".json") || name.endsWith(".index-before.json")) continue;
    const runId = name.slice(0, -".json".length);
    if (!isSafeCtoRunId(runId)) throw new Error("unsafe CTO run-delivery publication journal name");
    const journalRead = readCtoRunDeliveryJournalPinned(pinnedRoot, runId);
    if (!journalRead) continue;
    const state = readCtoStatePinned(runId, pinnedRoot);
    if (!state) continue;
    if (journalRead.journal.schema_version === 2 && !journalAuthenticatesPinned(pinnedRoot, journalRead.journal)) throw new Error(`CTO publication journal is not authenticated for '${runId}'`);
    if (journalRead.journal.schema_version === 1 && !legacyJournalExactStateProofPinned(pinnedRoot, state, journalRead.journal)) throw new Error(`legacy CTO journal is not exactly proved for '${runId}'`);
    if (journalRead.journal.schema_version === 2
      ? (journalRead.journal.origin_transition
        ? !recoverOriginTransitionFromJournalPinned(pinnedRoot, state, journalRead.journal)
        : !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state))
      : !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state)) throw new Error(`CTO runtime origin is not authenticated for journal '${runId}'`);
    const proofStatus = ctoRuntimeStateProofStatusPinned(pinnedRoot, state);
    if (proofStatus === "invalid") {
      const prior = readCtoRuntimeStateProofRecordPinned(pinnedRoot, runId);
      if (!prior || !validCtoRuntimeStateProofRecordPinned(pinnedRoot, state, prior)) throw new Error(`CTO state proof is present but invalid for journal '${runId}'`);
    }
  }
  // Queue names may reassert pending work only for an already-valid indexed run.
  // A missing/corrupt index must never be revived from forgeable queue files.
  const queueEvidenceAllowed = current.valid;
  if (!current.valid) {
    const rebuilt = rebuildCtoRunDeliveryIndexPinned(pinnedRoot, { ...options, reconcileQueueEvidence: false });
    // An absent index in an empty project is safe and should not create a
    // state tree merely because a read occurred. Existing corrupt files and
    // non-empty rebuilds are repaired durably before becoming authoritative.
    if (current.observed !== null || rebuilt.entries.length > 0) {
      persistCtoRunDeliveryIndexPinned(pinnedRoot, rebuilt, current.observed);
      current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
    } else {
      current = { index: rebuilt, observed: null, valid: true };
    }
  }

  const transitionJournalPending = pendingJournalNames.some((name) => {
    if (!name.endsWith(".json") || name.endsWith(".index-before.json")) return false;
    const runId = name.slice(0, -".json".length);
    if (!isSafeCtoRunId(runId)) return false;
    try { return readCtoRunDeliveryJournalPinned(pinnedRoot, runId)?.journal.schema_version === 2; } catch { return false; }
  });
  if (!transitionJournalPending) current = reconcileIndexedCtoRunDeliveryEntriesPinned(pinnedRoot, current);
  if (options.reconcileObligations !== false) {
    current = reconcileCtoRunDeliveryObligationEvidencePinned(pinnedRoot, current);
    current = reconcileMissingCtoRunDeliveryObligationEntriesPinned(pinnedRoot, current);
  }
  if (options.reconcileQueueEvidence !== false && queueEvidenceAllowed) current = reconcileCtoRunDeliveryQueueEvidencePinned(pinnedRoot, current);
  const journalNames = pendingJournalNames;
  if (journalNames.length === 0) return current.index;
  for (const name of journalNames) {
    if (!name.endsWith(".json") || name.endsWith(".index-before.json")) continue;
    const runId = name.slice(0, -".json".length);
    if (!isSafeCtoRunId(runId)) throw new Error("unsafe CTO run-delivery publication journal name");
    const journalRead = readCtoRunDeliveryJournalPinned(pinnedRoot, runId);
    if (!journalRead) continue;
    const state = readCtoStatePinned(runId, pinnedRoot);
    if (!state) {
      // Only an actually absent state path is the pre-state publication gap.
      // A present malformed/symlinked state is recovery evidence and must not
      // be deleted or hidden by index repair.
      const stateInfo = pinnedRoot.pathEntryInfo(join(".work-state", "cto", runId, "state.json"));
      if (stateInfo !== null) throw new Error(`CTO state for journal '${runId}' is present but invalid`);
      pinnedRoot.removeFileIfMatches(ctoRunDeliveryJournalRelativePath(runId), journalRead.observed);
      continue;
    }
    if (state.id !== runId || !isSafeCtoRunId(state.id)) throw new Error(`CTO state identity mismatch for journal '${runId}'`);
    const revision = Number.isSafeInteger(state.state_revision) && (state.state_revision as number) >= 0
      ? state.state_revision as number
      : 0;
    if (revision < journalRead.journal.state_revision) {
      pinnedRoot.removeFileIfMatches(ctoRunDeliveryJournalRelativePath(runId), journalRead.observed);
      continue;
    }
    const stateBytes = pinnedRoot.readFile(join(".work-state", "cto", runId, "state.json"), { maxBytes: 8 * 1024 * 1024 }).bytes;
    const digest = createHash("sha256").update(stateBytes).digest("hex");
    if (revision === journalRead.journal.state_revision && digest !== journalRead.journal.state_sha256) throw new Error(`CTO state digest does not match publication journal for '${runId}'`);
    if (journalRead.journal.schema_version === 2 && !journalAuthenticatesPinned(pinnedRoot, journalRead.journal)) throw new Error(`CTO publication journal is not authenticated for '${runId}'`);
    if (journalRead.journal.schema_version === 1 && !legacyJournalExactStateProofPinned(pinnedRoot, state, journalRead.journal)) throw new Error(`legacy CTO journal is not exactly proved for '${runId}'`);
    if (journalRead.journal.schema_version === 2
      ? (journalRead.journal.origin_transition
        ? !recoverOriginTransitionFromJournalPinned(pinnedRoot, state, journalRead.journal)
        : !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state))
      : !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state)) throw new Error(`CTO runtime origin is not authenticated for journal '${runId}'`);
    const proofStatus = ctoRuntimeStateProofStatusPinned(pinnedRoot, state);
    if (proofStatus === "invalid") {
      // A previous proof may be independently authentic but bound to the
      // preimage immediately before this authenticated transition journal.
      // A malformed or forged proof is never overwritten during recovery.
      const prior = readCtoRuntimeStateProofRecordPinned(pinnedRoot, runId);
      if (!prior || (!validCtoRuntimeStateProofRecordPinned(pinnedRoot, state, prior)
        && !journalAllowsPriorStateProofPinned(pinnedRoot, state, journalRead.journal))) throw new Error(`CTO state proof is present but invalid for journal '${runId}'`);
    }
    if (journalRead.journal.schema_version === 2
      && (!writeCtoRuntimeStateProof(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state))) throw new Error(`CTO state proof recovery failed for journal '${runId}'`);
    const known = current.index.entries.find((entry) => entry.run_id === runId);
    const nextEntry = ctoRunDeliveryEntry(state, known, pinnedRoot, options);
    if (!known || nextEntry.state_revision >= known.state_revision) {
      const entries = boundedRunDeliveryEntries([
        ...current.index.entries.filter((entry) => entry.run_id !== runId),
        nextEntry,
      ]);
      const next = { schema_version: 2 as const, active_run_id: latestActiveRunId(entries), entries };
      if (journalRead.journal.origin_transition && !journalIndexPreimagesStillMatchPinned(pinnedRoot, journalRead.journal)) throw new Error(`CTO transition preimage changed during recovery for '${runId}'`);
      persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed, journalRead.journal.schema_version === 2 ? {
        allowAuthenticatedStaleProof: true,
        transitionJournal: journalRead.journal,
      } : undefined);
      current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
    }
    clearCtoRunDeliveryIndexPreimagePinned(pinnedRoot, runId);
    pinnedRoot.removeFileIfMatches(ctoRunDeliveryJournalRelativePath(runId), journalRead.observed);
  }
  if (transitionJournalPending) current = reconcileIndexedCtoRunDeliveryEntriesPinned(pinnedRoot, current);
  return current.index;
}

/** Internal pinned read used by command authority; repairs before returning. */
export function readCtoRunDeliveryIndexPinned(pinnedRoot: PinnedProjectRoot): CtoRunDeliveryIndex {
  return withCtoStateWriteLock(
    pinnedRoot.canonical_root,
    CTO_RUN_DELIVERY_INDEX_LOCK_ID,
    () => recoverCtoRunDeliveryIndexLocked(pinnedRoot, { reconcileQueueEvidence: false }),
    { pinnedRoot },
  );
}
function readCtoRunDeliveryIndexPagePinned(pinnedRoot: PinnedProjectRoot, options: { after_run_id?: string; startAfter?: string; limit?: number } = {}): CtoRunDeliveryIndexPage {
  const rawAfter = options.after_run_id ?? options.startAfter;
  const index = recoverCtoRunDeliveryIndexLocked(pinnedRoot, { reconcileQueueEvidence: true });
  const requestedLimit = options.limit;
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(CTO_RUN_DELIVERY_PAGE_LIMIT, requestedLimit as number)) : CTO_RUN_DELIVERY_PAGE_LIMIT;
  const after = rawAfter === undefined ? null : isSafeCtoRunDeliveryId(rawAfter) ? rawAfter : null;
  const pending = index.entries.filter((entry) => entry.pending_summary || entry.pending_outbox || entry.pending_retry);
  const eligible = after === null ? pending : pending.filter((entry) => compareRunDeliveryIds(entry.run_id, after) > 0);
  const entries = eligible.slice(0, limit);
  return {
    entries,
    next_after_run_id: entries.length === limit && eligible.length > limit ? entries[entries.length - 1]!.run_id : null,
    active_run_id: index.active_run_id,
  };
}

/** Read one bounded run-delivery page through an internally pinned project root. */
export function readCtoRunDeliveryIndexPage(root: string, options: { after_run_id?: string; startAfter?: string; limit?: number } = {}, providedRoot?: PinnedProjectRoot): CtoRunDeliveryIndexPage {
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return { entries: [], next_after_run_id: null, active_run_id: null };
  try {
    return withCtoStateWriteLock(
      pinnedRoot.canonical_root,
      CTO_RUN_DELIVERY_INDEX_LOCK_ID,
      () => readCtoRunDeliveryIndexPagePinned(pinnedRoot, options),
      { pinnedRoot },
    );
  } catch (error) {
    if (pinnedStateErrorCode(error) === "not_found") return { entries: [], next_after_run_id: null, active_run_id: null };
    throw error;
  } finally {
    if (!providedRoot) pinnedRoot.close();
  }
}

function readCtoRunDeliveryCompletedIndexPagePinned(pinnedRoot: PinnedProjectRoot, options: { after_run_id?: string; limit?: number } = {}): CtoRunDeliveryIndexPage {
  const index = recoverCtoRunDeliveryIndexLocked(pinnedRoot, { reconcileQueueEvidence: false });
  const requestedLimit = options.limit;
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(CTO_RUN_DELIVERY_PAGE_LIMIT, requestedLimit as number)) : CTO_RUN_DELIVERY_PAGE_LIMIT;
  const rawAfter = options.after_run_id;
  const after = rawAfter === undefined ? null : isSafeCtoRunDeliveryId(rawAfter) ? rawAfter : null;
  const completed = index.entries.filter((entry) => isTerminalDeliveryStatus(entry.status));
  const eligible = after === null ? completed : completed.filter((entry) => compareRunDeliveryIds(entry.run_id, after) > 0);
  const entries = eligible.slice(0, limit);
  return {
    entries,
    next_after_run_id: entries.length === limit && eligible.length > limit ? entries[entries.length - 1]!.run_id : null,
    active_run_id: index.active_run_id,
  };
}

/** Read terminal delivery entries without queue reconciliation or mutation. */
export function readCtoRunDeliveryCompletedIndexPage(root: string, options: { after_run_id?: string; limit?: number } = {}, providedRoot?: PinnedProjectRoot): CtoRunDeliveryIndexPage {
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return { entries: [], next_after_run_id: null, active_run_id: null };
  try {
    return withCtoStateWriteLock(
      pinnedRoot.canonical_root,
      CTO_RUN_DELIVERY_INDEX_LOCK_ID,
      () => readCtoRunDeliveryCompletedIndexPagePinned(pinnedRoot, options),
      { pinnedRoot },
    );
  } catch (error) {
    if (pinnedStateErrorCode(error) === "not_found") return { entries: [], next_after_run_id: null, active_run_id: null };
    throw error;
  } finally {
    if (!providedRoot) pinnedRoot.close();
  }
}

type CtoRunDeliveryExactPreimage = Readonly<{ dev: number; ino: number; size: number; sha256: string; bytes: Uint8Array }>;
interface CtoRunDeliveryIndexTransitionAuth {
  readonly index: CtoRunDeliveryExactPreimage | null;
  readonly proof: CtoRunDeliveryExactPreimage | null;
  readonly origin: CtoRunDeliveryExactPreimage | null;
}
function captureCtoRunDeliveryIndexTransitionAuthPinned(pinnedRoot: PinnedProjectRoot, runId: string): CtoRunDeliveryIndexTransitionAuth {
  const current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
  const proof = readCtoRunDeliveryIndexProofDetailedPinned(pinnedRoot);
  if (proof.status === "invalid") throw new PinnedRootError("recovery_required", "CTO delivery index proof is present but invalid");
  if (proof.status === "present" && current.valid && !indexProofAuthenticatesPinned(pinnedRoot, current)) {
    throw new PinnedRootError("recovery_required", "CTO delivery index proof does not authenticate the current index");
  }
  const readExact = (relative: string, maxBytes: number): CtoRunDeliveryExactPreimage | null => {
    try {
      const read = pinnedRoot.readFile(relative, { maxBytes });
      return { dev: read.dev, ino: read.ino, size: read.bytes.byteLength, sha256: createHash("sha256").update(read.bytes).digest("hex"), bytes: new Uint8Array(read.bytes) };
    } catch { return null; }
  };
  return {
    index: readExact(ctoRunDeliveryIndexRelativePath(), MAX_CTO_RUN_DELIVERY_INDEX_BYTES),
    proof: readExact(join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), 16 * 1024),
    origin: readExact(ctoRuntimeOriginRelativePath(runId), 16 * 1024),
  };
}
function exactPreimageStillMatches(pinnedRoot: PinnedProjectRoot, relative: string, expected: CtoRunDeliveryExactPreimage | null, maxBytes: number): boolean {
  const current = (() => { try { return pinnedRoot.readFile(relative, { maxBytes }); } catch { return null; } })();
  if (!expected) return current === null;
  return current !== null && current.dev === expected.dev && current.ino === expected.ino && current.bytes.byteLength === expected.size
    && createHash("sha256").update(current.bytes).digest("hex") === expected.sha256
    && Buffer.from(current.bytes).equals(Buffer.from(expected.bytes));
}
function transitionPreimageStillMatches(pinnedRoot: PinnedProjectRoot, runId: string, auth: CtoRunDeliveryIndexTransitionAuth): boolean {
  return exactPreimageStillMatches(pinnedRoot, ctoRunDeliveryIndexRelativePath(), auth.index, MAX_CTO_RUN_DELIVERY_INDEX_BYTES)
    && exactPreimageStillMatches(pinnedRoot, join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), auth.proof, 16 * 1024)
    && exactPreimageStillMatches(pinnedRoot, ctoRuntimeOriginRelativePath(runId), auth.origin, 16 * 1024);
}function transitionIndexProofStillMatches(pinnedRoot: PinnedProjectRoot, auth: CtoRunDeliveryIndexTransitionAuth): boolean {
  return exactPreimageStillMatches(pinnedRoot, ctoRunDeliveryIndexRelativePath(), auth.index, MAX_CTO_RUN_DELIVERY_INDEX_BYTES)
    && exactPreimageStillMatches(pinnedRoot, join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), auth.proof, 16 * 1024);
}

function updateCtoRunDeliveryIndexLocked(state: CtoState, pinnedRoot: PinnedProjectRoot, transitionAuth: CtoRunDeliveryIndexTransitionAuth = { index: null, proof: null, origin: null }): void {
  let current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
  if (!current.valid) {
    const rebuilt = rebuildCtoRunDeliveryIndexPinned(pinnedRoot);
    if (current.observed !== null || rebuilt.entries.length > 0) {
      persistCtoRunDeliveryIndexPinned(pinnedRoot, rebuilt, current.observed);
      current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
    } else {
      current = { index: rebuilt, observed: null, valid: true };
    }
  }
  const known = current.index.entries.find((entry) => entry.run_id === state.id);
  const revision = Number.isSafeInteger(state.state_revision) && (state.state_revision as number) >= 0 ? state.state_revision as number : 0;
  if (known && revision < known.state_revision) return;
  const entry = ctoRunDeliveryEntry(state, known, pinnedRoot);
  const entries = boundedRunDeliveryEntries([...current.index.entries.filter((candidate) => candidate.run_id !== state.id), entry]);
  const next: CtoRunDeliveryIndex = { schema_version: 2, active_run_id: latestActiveRunId(entries), entries };
  const preimage = writeCtoRunDeliveryIndexPreimagePinned(pinnedRoot, state.id, current);
  try {
    persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed, {
      allowAuthenticatedStaleProof: transitionIndexProofStillMatches(pinnedRoot, transitionAuth),
    });
    clearCtoRunDeliveryIndexPreimagePinned(pinnedRoot, state.id, preimage);
  }
  catch (error) {
    // Leave the preimage beside the state journal so restart can authenticate
    // a proof still bound to the previous index image.
    throw error;
  }
}

function updateCtoRunDeliveryIndex(state: CtoState, root: string, providedRoot?: PinnedProjectRoot, transitionAuth: CtoRunDeliveryIndexTransitionAuth = { index: null, proof: null, origin: null }): void {
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("run-delivery index requires a pinnable project root");
  try {
    withCtoStateWriteLock(pinnedRoot.canonical_root, CTO_RUN_DELIVERY_INDEX_LOCK_ID, () => updateCtoRunDeliveryIndexLocked(state, pinnedRoot, transitionAuth), { pinnedRoot });
  } finally {
    if (!providedRoot) pinnedRoot.close();
}
}

/** Mark one engine-written run as having queued summary or outbox work. */
export function markCtoRunDeliveryPending(root: string, runId: string, stateRevision?: number, kind: "outbox" | "summary" | "retry" = "outbox", providedRoot?: PinnedProjectRoot, capability?: unknown): boolean {
  if (!isCtoRuntimeDeliveryCapability(capability)) return false;
  if (!isSafeCtoRunId(runId) || (stateRevision !== undefined && (!Number.isSafeInteger(stateRevision) || stateRevision < 0))) return false;
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return false;
  try {
    return withCtoStateWriteLock(pinnedRoot.canonical_root, CTO_RUN_DELIVERY_INDEX_LOCK_ID, () => {
      const current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
      const entry = current.index.entries.find((candidate) => candidate.run_id === runId);
      const state = readCtoStatePinned(runId, pinnedRoot);
      if (!entry || !state || state.id !== runId || !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state)) return false;
      const revision = state.state_revision;
      if (!Number.isSafeInteger(revision) || (stateRevision !== undefined && revision !== stateRevision)) return false;
      const updated: CtoRunDeliveryIndexEntry = {
        ...entry,
        state_revision: revision as number,
        status: ctoRunDeliveryStatus(state),
        updated_at: state.updated_at,
        summary_digest: ctoRunDeliverySummaryDigest(state),
        ...(kind === "summary" ? { pending_summary: true } : kind === "retry" ? { pending_retry: true } : { pending_outbox: true }),
      };
      const nextEntries = boundedRunDeliveryEntries(current.index.entries.map((candidate) => candidate.run_id === runId ? updated : candidate));
      const next: CtoRunDeliveryIndex = { schema_version: 2, active_run_id: latestActiveRunId(nextEntries), entries: nextEntries };
      if (!current.observed) return false;
      const preimage = writeCtoRunDeliveryIndexPreimagePinned(pinnedRoot, runId, current);
      try {
        persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed);
        clearCtoRunDeliveryIndexPreimagePinned(pinnedRoot, runId, preimage);
      } catch {
        return false;
      }
      return true;
    }, { pinnedRoot });
  } finally {
    if (!providedRoot) pinnedRoot.close();
  }
}

function isSafeCtoOutboxEntryName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== ".." && value.endsWith(".json");
}

function ctoRunOutboxRelativePath(runId: string, entryName?: string): string {
  return entryName === undefined
    ? join(".work-state", "cto", runId, "outbox")
    : join(".work-state", "cto", runId, "outbox", entryName);
}

function ctoRunDeliveryQueueEmptyPinned(
  pinnedRoot: PinnedProjectRoot,
  relativeDirectory: string,
  durableOnly = false,
  allowSentDirectory = false,
): boolean {
  let page: { names: string[]; nextCursor: string | null };
  try {
    page = pinnedRoot.listDirectoryPage(relativeDirectory, {
      maxEntries: 64,
      maxNameBytes: 16 * 1024,
      maxScanEntries: 1024,
      maxScanNameBytes: 128 * 1024,
    });
  } catch (error) {
    // An absent queue is empty; every other enumeration failure is a
    // fail-closed non-empty result so acknowledgement cannot clear evidence.
    return pinnedStateErrorCode(error) === "not_found";
  }
  if (page.nextCursor !== null) return false;
  for (const name of page.names) {
    if (!durableOnly && allowSentDirectory && name === "sent") {
      try {
        // Only the active outbox lane may treat this exact verified directory
        // as the settled publication area. Retry and rejected lanes have no
        // directory exemption.
        if (pinnedRoot.pathEntryInfo(join(relativeDirectory, name))?.kind === "directory") continue;
      } catch {
        return false;
      }
      return false;
    }
    if (!durableOnly) return false;
    try {
      const info = pinnedRoot.pathEntryInfo(join(relativeDirectory, name));
      // Directory collisions are not durable envelopes during reconciliation;
      // regular files, symlinks, other kinds, and vanished entries block.
      if (info?.kind === "directory") continue;
    } catch {
      return false;
    }
    return false;
  }
  return true;
}

function ctoRunOutboxQueueEmptyPinned(pinnedRoot: PinnedProjectRoot, runId: string): boolean {
  return ctoRunDeliveryQueueEmptyPinned(pinnedRoot, ctoRunOutboxRelativePath(runId), false, true);
}
function ctoRunRetryQueueEmptyPinned(pinnedRoot: PinnedProjectRoot, runId: string): boolean {
  return ctoRunDeliveryQueueEmptyPinned(pinnedRoot, join(".work-state", "cto", runId, "outbox-retry"));
}
function ctoRunOutboxQueueEvidenceEmptyPinned(pinnedRoot: PinnedProjectRoot, runId: string): boolean {
  return ctoRunDeliveryQueueEmptyPinned(pinnedRoot, ctoRunOutboxRelativePath(runId), true);
}
function ctoRunRetryQueueEvidenceEmptyPinned(pinnedRoot: PinnedProjectRoot, runId: string): boolean {
  return ctoRunDeliveryQueueEmptyPinned(pinnedRoot, join(".work-state", "cto", runId, "outbox-retry"), true);
}
function ctoRunOutboxEmptyPinned(pinnedRoot: PinnedProjectRoot, runId: string): boolean {
  return ctoRunOutboxQueueEmptyPinned(pinnedRoot, runId) && ctoRunRetryQueueEmptyPinned(pinnedRoot, runId);
}

export interface CtoOutboxDeliveryRoutingBinding {
  config_sha256: string;
  snapshot_sha256: string;
  channel: string | null;
  target: string | null;
  /** Adapter routing is bound to the exact project root; null is only for the no-adapter default. */
  canonical_root: string | null;
  root_dev: number | null;
  root_ino: number | null;
}

export interface CtoOutboxDeliveryPublishInput {
  run_id: string;
  state_revision: number;
  entry_name: string;
  /** Previous lossy filename, accepted only for an exact migration lookup. */
  legacy_entry_name?: string;
  json: string | Uint8Array;
  routing_binding?: CtoOutboxDeliveryRoutingBinding;
}

function durableEnvelopeId(bytes: Buffer): string | null {
  try {
    const value = JSON.parse(decodeUtf8(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

const CTO_DELIVERY_INTENTS = new Set(["ack", "question", "progress", "summary"] as const);
const ABSENT_ROUTING_CONFIG_SHA256 = createHash("sha256").update("omp-escalation-config:absent", "utf8").digest("hex");
const ABSENT_ROUTING_SNAPSHOT_SHA256 = createHash("sha256").update("omp-escalation-routing:absent", "utf8").digest("hex");
const DEFAULT_ROUTING_BINDING: CtoOutboxDeliveryRoutingBinding = Object.freeze({
  config_sha256: ABSENT_ROUTING_CONFIG_SHA256,
  snapshot_sha256: ABSENT_ROUTING_SNAPSHOT_SHA256,
  channel: null,
  target: null,
  canonical_root: null,
  root_dev: null,
  root_ino: null,
});
const CTO_DELIVERY_ALLOWED_KEYS = new Set([
  "id", "level", "title", "body", "options", "default", "timeoutMs", "replyTo",
  "intent", "at", "by", "run_id", "state_revision", "wave_id", "target", "topic", "idempotency_key",
]);

function ownCtoDeliveryValue(delivery: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(delivery, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

export function normalizeCtoOutboxDeliveryRoutingBinding(value: unknown): CtoOutboxDeliveryRoutingBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;
  const config = binding.config_sha256;
  const snapshot = binding.snapshot_sha256;
  const channel = binding.channel;
  const target = binding.target;
  const canonicalRoot = binding.canonical_root;
  const rootDev = binding.root_dev;
  const rootIno = binding.root_ino;
  const rootFieldsValid = canonicalRoot === null && rootDev === null && rootIno === null
    || (typeof canonicalRoot === "string" && canonicalRoot.length > 0 && Number.isSafeInteger(rootDev) && (rootDev as number) >= 0 && Number.isSafeInteger(rootIno) && (rootIno as number) >= 0);
  if (typeof config !== "string" || !/^[0-9a-f]{64}$/iu.test(config)
    || typeof snapshot !== "string" || !/^[0-9a-f]{64}$/iu.test(snapshot)
    || (channel !== null && typeof channel !== "string")
    || (target !== null && typeof target !== "string")
    || !rootFieldsValid
    || (typeof canonicalRoot === "string" && Buffer.byteLength(canonicalRoot, "utf8") > 4096)
    || (typeof channel === "string" && Buffer.byteLength(channel, "utf8") > 512)
    || (typeof target === "string" && Buffer.byteLength(target, "utf8") > 1024)) return null;
  return Object.freeze({
    config_sha256: config.toLowerCase(),
    snapshot_sha256: snapshot.toLowerCase(),
    channel: channel as string | null,
    target: target as string | null,
    canonical_root: canonicalRoot as string | null,
    root_dev: rootDev as number | null,
    root_ino: rootIno as number | null,
  });
}

/** Validate the exact bounded CtoDelivery envelope written by queueCtoDelivery. */
function validCtoDelivery(delivery: unknown, runId: string): delivery is Record<string, unknown> {
  try {
    if (!isSafeCtoRunId(runId) || validateEscalation(delivery as never) !== null
      || !delivery || typeof delivery !== "object" || Array.isArray(delivery)) return false;
    const record = delivery as Record<string, unknown>;
    if (Object.keys(record).some((key) => !CTO_DELIVERY_ALLOWED_KEYS.has(key))
      || !Object.hasOwn(record, "intent")
      || !CTO_DELIVERY_INTENTS.has(ownCtoDeliveryValue(record, "intent") as CtoDeliveryIntent)) return false;
    const id = ownCtoDeliveryValue(record, "id");
    if (typeof id !== "string" || id.split("/")[0] !== runId) return false;
    const at = ownCtoDeliveryValue(record, "at");
    const by = ownCtoDeliveryValue(record, "by");
    const target = ownCtoDeliveryValue(record, "target");
    const topic = ownCtoDeliveryValue(record, "topic");
    const run = ownCtoDeliveryValue(record, "run_id");
    const wave = ownCtoDeliveryValue(record, "wave_id");
    const revision = ownCtoDeliveryValue(record, "state_revision");
    const idempotencyKey = ownCtoDeliveryValue(record, "idempotency_key");
    if (at !== undefined && typeof at !== "string") return false;
    if (by !== undefined && typeof by !== "string") return false;
    if (target !== undefined && typeof target !== "string") return false;
    if (topic !== undefined && typeof topic !== "string") return false;
    if (run !== undefined && (run !== runId || !isSafeCtoRunId(run))) return false;
    if (wave !== undefined && !isSafeCtoRunId(wave)) return false;
    if (revision !== undefined && (!Number.isSafeInteger(revision) || (revision as number) < 0)) return false;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey !== id)) return false;
    return true;
  } catch {
    return false;
  }
}

function ctoDeliveryMatchesState(
  delivery: Record<string, unknown>,
  bytes: Buffer,
  state: CtoState,
  input: CtoOutboxDeliveryPublishInput,
  options: { allowHistoricalSummaryRevision?: boolean; allowHistoricalObligationRevision?: boolean } = {},
): boolean {
  const deliveryIntent = delivery.intent as CtoDeliveryIntent;
  const historicalRevision = Number.isSafeInteger(delivery.state_revision)
    && (delivery.state_revision as number) >= 0
    && (delivery.state_revision as number) <= input.state_revision;
  const historicalSummary = options.allowHistoricalSummaryRevision === true && deliveryIntent === "summary" && historicalRevision;
  const historicalObligation = options.allowHistoricalObligationRevision === true && historicalRevision;
  if (state.id !== input.run_id
    || delivery.run_id !== undefined && delivery.run_id !== state.id
    || delivery.state_revision !== undefined && delivery.state_revision !== input.state_revision && !historicalSummary && !historicalObligation
    || delivery.idempotency_key !== delivery.id) return false;
  const intent = delivery.intent as CtoDeliveryIntent;
  const expectedTarget = state.channel_profile?.ackTarget;
  if (intent === "ack") {
    if (delivery.target !== expectedTarget) return false;
  } else if (delivery.target !== undefined && delivery.target !== expectedTarget) {
    return false;
  }
  if (intent !== "summary" && delivery.wave_id !== undefined && delivery.wave_id !== state.active_wave_id) return false;
  if (intent === "summary") return isDeterministicCtoTerminalSummaryDelivery(state, String(delivery.id), bytes, historicalSummary || historicalObligation);
  if (intent === "ack") return true;
  return !isCtoRunTerminal(state);
}

/** Exact input for the internal current-delivery validator. */
function ctoPendingObligationMatchesDelivery(
  state: CtoState,
  entryName: string,
  envelopeId: string,
  delivery: unknown,
): boolean {
  const obligation = (state.pending_delivery_obligations ?? []).find((candidate) => candidate.entry_name === entryName && candidate.envelope_id === envelopeId);
  if (!obligation || !delivery || typeof delivery !== "object" || Array.isArray(delivery)) return false;
  try {
    const expected = JSON.parse(obligation.envelope) as Record<string, unknown>;
    const actual = { ...(delivery as Record<string, unknown>) };
    delete expected.state_revision;
    delete actual.state_revision;
    return JSON.stringify(expected) === JSON.stringify(actual);
  } catch {
    return false;
  }
}

/**
 * `recovery_required` means a durable obligation/proof sidecar exists but
 * this process cannot authenticate its process-scoped proof; transport and
 * acknowledgement must remain blocked until a new trusted source intent.
 */
export type CtoCurrentOutboxDeliveryStatus = "current" | "invalid" | "unavailable" | "recovery_required";

const CTO_DELIVERY_PROOF_SCHEMA_VERSION = 1;
function ctoDeliveryProofRelativePath(runId: string, entryName: string): string {
  return join(".work-state", "cto", runId, `.obligation-${entryName}.proof.json`);
}
function ctoDeliveryProofValue(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  entryName: string,
  envelopeId: string,
  intent: CtoDeliveryIntent,
  sourceRevision: number,
  envelopeSha256: string,
  routingBinding: CtoOutboxDeliveryRoutingBinding,
): string {
  const binding = [
    "omp-cto-delivery-obligation-proof-v1",
    pinnedRoot.canonical_root,
    String(pinnedRoot.dev), String(pinnedRoot.ino), runId, entryName, envelopeId,
    intent, String(sourceRevision), envelopeSha256,
    routingBinding.config_sha256, routingBinding.snapshot_sha256,
    routingBinding.channel ?? "", routingBinding.target ?? "",
    routingBinding.canonical_root ?? "",
    routingBinding.root_dev === null ? "" : String(routingBinding.root_dev),
    routingBinding.root_ino === null ? "" : String(routingBinding.root_ino),
  ].join("\u0000");
  return createHmac("sha256", CTO_OUTBOX_PUBLICATION_TRUST_ROOT).update(binding, "utf8").digest("hex");
}
function ctoDeliveryProofBytes(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  entryName: string,
  envelopeId: string,
  delivery: Record<string, unknown>,
  bytes: Buffer,
  routingBinding: CtoOutboxDeliveryRoutingBinding,
): Buffer | null {
  const sourceRevision = delivery.state_revision;
  if (!Number.isSafeInteger(sourceRevision) || (sourceRevision as number) < 0) return null;
  const envelopeSha256 = createHash("sha256").update(bytes).digest("hex");
  const proof = ctoDeliveryProofValue(pinnedRoot, runId, entryName, envelopeId, delivery.intent as CtoDeliveryIntent, sourceRevision as number, envelopeSha256, routingBinding);
  return Buffer.from(JSON.stringify({
    schema_version: CTO_DELIVERY_PROOF_SCHEMA_VERSION,
    run_id: runId,
    entry_name: entryName,
    envelope_id: envelopeId,
    intent: delivery.intent,
    source_revision: sourceRevision,
    envelope_sha256: envelopeSha256,
    routing_config_sha256: routingBinding.config_sha256,
    routing_snapshot_sha256: routingBinding.snapshot_sha256,
    routing_channel: routingBinding.channel,
    routing_target: routingBinding.target,
    routing_canonical_root: routingBinding.canonical_root,
    routing_root_dev: routingBinding.root_dev,
    routing_root_ino: routingBinding.root_ino,
    proof,
  }) + "\n", "utf8");
}
function ensureCtoDeliveryProof(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  entryName: string,
  envelopeId: string,
  delivery: Record<string, unknown>,
  bytes: Buffer,
  routingBinding: CtoOutboxDeliveryRoutingBinding,
): boolean {
  const proofBytes = ctoDeliveryProofBytes(pinnedRoot, runId, entryName, envelopeId, delivery, bytes, routingBinding);
  if (!proofBytes) return false;
  const path = ctoDeliveryProofRelativePath(runId, entryName);
  try {
    const existing = pinnedRoot.readFile(path, { maxBytes: 16 * 1024 });
    return Buffer.from(existing.bytes).equals(proofBytes);
  } catch (error) {
    if (pinnedStateErrorCode(error) !== "not_found") return false;
    try { pinnedRoot.writeExclusive(path, proofBytes); return true; } catch { return false; }
  }
}
function rebindCtoDeliveryProof(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  entryName: string,
  envelopeId: string,
  delivery: Record<string, unknown>,
  bytes: Buffer,
  routingBinding: CtoOutboxDeliveryRoutingBinding,
): boolean {
  const proofPath = ctoDeliveryProofRelativePath(runId, entryName);
  try {
    const current = pinnedRoot.readFile(proofPath, { maxBytes: 16 * 1024 });
    const raw = JSON.parse(decodeUtf8(current.bytes)) as Record<string, unknown>;
    const previousBinding = normalizeCtoOutboxDeliveryRoutingBinding({
      config_sha256: raw.routing_config_sha256,
      snapshot_sha256: raw.routing_snapshot_sha256,
      channel: raw.routing_channel,
      target: raw.routing_target,
      canonical_root: raw.routing_canonical_root,
      root_dev: raw.routing_root_dev,
      root_ino: raw.routing_root_ino,
    });
    if (!previousBinding || (previousBinding.config_sha256 === routingBinding.config_sha256
      && previousBinding.snapshot_sha256 === routingBinding.snapshot_sha256
      && previousBinding.channel === routingBinding.channel
      && previousBinding.target === routingBinding.target
      && previousBinding.canonical_root === routingBinding.canonical_root
      && previousBinding.root_dev === routingBinding.root_dev
      && previousBinding.root_ino === routingBinding.root_ino)) return false;
    const previousProof = ctoDeliveryProofBytes(pinnedRoot, runId, entryName, envelopeId, delivery, bytes, previousBinding);
    const nextProof = ctoDeliveryProofBytes(pinnedRoot, runId, entryName, envelopeId, delivery, bytes, routingBinding);
    if (!previousProof || !nextProof || !Buffer.from(current.bytes).equals(previousProof)) return false;
    const sentPath = join(ctoRunOutboxRelativePath(runId), "sent", entryName);
    try {
      if (pinnedRoot.pathEntryInfo(sentPath)?.kind === "file") return false;
    } catch { return false; }
    pinnedRoot.replaceFileIfMatches(proofPath, { dev: current.dev, ino: current.ino, sha256: createHash("sha256").update(current.bytes).digest("hex") }, nextProof);
    return validCtoDeliveryProof(pinnedRoot, runId, entryName, envelopeId, delivery, bytes, routingBinding);
  } catch {
    return false;
  }
}
function ctoDeliveryProofExists(pinnedRoot: PinnedProjectRoot, runId: string, entryName: string): boolean {
  try {
    return pinnedRoot.pathEntryInfo(ctoDeliveryProofRelativePath(runId, entryName))?.kind === "file";
  } catch { return false; }
}
function ctoDeliveryProofRouteMatches(pinnedRoot: PinnedProjectRoot, runId: string, entryName: string, routingBinding: CtoOutboxDeliveryRoutingBinding): boolean {
  try {
    const raw = JSON.parse(decodeUtf8(pinnedRoot.readFile(ctoDeliveryProofRelativePath(runId, entryName), { maxBytes: 16 * 1024 }).bytes)) as Record<string, unknown>;
    return raw.routing_config_sha256 === routingBinding.config_sha256
      && raw.routing_snapshot_sha256 === routingBinding.snapshot_sha256
      && raw.routing_channel === routingBinding.channel
      && raw.routing_target === routingBinding.target
      && (routingBinding.canonical_root === null || raw.routing_canonical_root === routingBinding.canonical_root)
      && (routingBinding.root_dev === null || raw.routing_root_dev === routingBinding.root_dev)
      && (routingBinding.root_ino === null || raw.routing_root_ino === routingBinding.root_ino);
  } catch { return false; }
}
function validCtoDeliveryProof(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  entryName: string,
  envelopeId: string,
  delivery: Record<string, unknown>,
  bytes: Buffer,
  routingBinding: CtoOutboxDeliveryRoutingBinding,
): boolean {
  const expected = ctoDeliveryProofBytes(pinnedRoot, runId, entryName, envelopeId, delivery, bytes, routingBinding);
  if (!expected) return false;
  try {
    const read = pinnedRoot.readFile(ctoDeliveryProofRelativePath(runId, entryName), { maxBytes: 16 * 1024 });
    return Buffer.from(read.bytes).equals(expected);
  } catch { return false; }
}
function removeCtoDeliveryProofIfSettled(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  entryName: string,
  envelopeId: string,
  envelope: string,
): void {
  const sentPath = join(ctoRunOutboxRelativePath(runId), "sent", entryName);
  try {
    const sent = pinnedRoot.readFile(sentPath, { maxBytes: MAX_CTO_OUTBOX_ENVELOPE_BYTES });
    const bytes = Buffer.from(sent.bytes);
    if (durableEnvelopeId(bytes) !== envelopeId || !bytes.equals(Buffer.from(envelope, "utf8"))) return;
    const proofPath = ctoDeliveryProofRelativePath(runId, entryName);
    const proof = pinnedRoot.readFile(proofPath, { maxBytes: 16 * 1024 });
    pinnedRoot.removeFileIfMatches(proofPath, { dev: proof.dev, ino: proof.ino, sha256: createHash("sha256").update(proof.bytes).digest("hex") });
  } catch { /* proof cleanup is best-effort; absence never weakens delivery */ }
}

export interface CtoCurrentOutboxDeliveryInput {
  run_id: string;
  state_revision: number;
  entry_name: string;
  /** Retry queue basename; omitted for outbox or equal to entry_name. */
  storage_entry_name?: string;
  json: string | Uint8Array;
  lane: "outbox" | "retry";
  routing_binding?: CtoOutboxDeliveryRoutingBinding;
}

/**
 * Validate one exact outbox/retry delivery without recovery or index mutation.
 * This helper is intentionally exported only from the internal state module;
 * package barrels do not re-export it.
 */
export function currentOutboxDeliveryStatusPinned(input: CtoCurrentOutboxDeliveryInput, pinnedRoot: PinnedProjectRoot, capability?: unknown): CtoCurrentOutboxDeliveryStatus {
  try {
    if (!input || typeof input !== "object" || !isSafeCtoRunDeliveryId(input.run_id) || input.run_id.length > 128
      || !Number.isSafeInteger(input.state_revision) || input.state_revision < 0
      || !isSafeCtoOutboxEntryName(input.entry_name)
      || (input.storage_entry_name !== undefined && !isSafeCtoOutboxEntryName(input.storage_entry_name))
      || (input.lane !== "outbox" && input.lane !== "retry")
      || (input.lane === "outbox" && input.storage_entry_name !== undefined && input.storage_entry_name !== input.entry_name)) return "invalid";
    const bytes = typeof input.json === "string"
      ? Buffer.from(input.json, "utf8")
      : input.json instanceof Uint8Array ? Buffer.from(input.json) : null;
    if (!bytes || bytes.byteLength > MAX_CTO_OUTBOX_ENVELOPE_BYTES) return "invalid";
    const routingBinding = input.routing_binding === undefined ? DEFAULT_ROUTING_BINDING : normalizeCtoOutboxDeliveryRoutingBinding(input.routing_binding);
    if (!routingBinding) return "invalid";
    let delivery: unknown;
    try { delivery = JSON.parse(decodeUtf8(bytes)); } catch { return "invalid"; }
    if (!validCtoDelivery(delivery, input.run_id)) return "invalid";
    const envelopeId = durableEnvelopeId(bytes);
    if (!envelopeId || canonicalDurableIdFileName(envelopeId) !== input.entry_name) return "invalid";
    const state = readCtoStatePinned(input.run_id, pinnedRoot);
    if (!state || state.id !== input.run_id) return "unavailable";
    if (!hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state)) return "recovery_required";
    if (!ctoPendingObligationMatchesDelivery(state, input.entry_name, envelopeId, delivery)) return "invalid";
    const proofValid = validCtoDeliveryProof(pinnedRoot, input.run_id, input.entry_name, envelopeId, delivery as Record<string, unknown>, bytes, routingBinding);
    if (!proofValid) return ctoDeliveryProofExists(pinnedRoot, input.run_id, input.entry_name)
      && ctoDeliveryProofRouteMatches(pinnedRoot, input.run_id, input.entry_name, routingBinding)
      ? "recovery_required" : "unavailable";
    if (!isCtoRuntimeDeliveryCapability(capability)) return "unavailable";
    const authority = readCtoRunOutboxPublicationAuthorityPinned(pinnedRoot, input.run_id);
    if (!authority) return "invalid";
    const commitment = authority.authority.entries.find((candidate) => candidate.entry_name === input.entry_name);
    const payloadDigest = createHash("sha256").update(bytes).digest("hex");
    const deliveryRevision = (delivery as Record<string, unknown>).state_revision;
    if (!Number.isSafeInteger(deliveryRevision) || (deliveryRevision as number) < 0
      || !commitment
      || commitment.envelope_id !== envelopeId
      || !Number.isSafeInteger(commitment.state_revision)
      || commitment.state_revision < 0
      || input.state_revision !== commitment.state_revision && input.state_revision !== state.state_revision
      || commitment.bytes_length !== bytes.byteLength
      || commitment.bytes_sha256 !== payloadDigest) return "invalid";
    if (commitment.routing_config_sha256 !== routingBinding.config_sha256
      || commitment.routing_snapshot_sha256 !== routingBinding.snapshot_sha256
      || commitment.routing_channel !== routingBinding.channel
      || commitment.routing_target !== routingBinding.target) return "unavailable";
    const proofDescriptor = {
      entry_name: commitment.entry_name,
      envelope_id: commitment.envelope_id,
      state_revision: commitment.state_revision,
      bytes_length: commitment.bytes_length,
      bytes_sha256: commitment.bytes_sha256,
      routing_config_sha256: commitment.routing_config_sha256,
      routing_snapshot_sha256: commitment.routing_snapshot_sha256,
      routing_channel: commitment.routing_channel,
      routing_target: commitment.routing_target,
    };
    if (commitment.proof !== ctoOutboxPublicationProof(pinnedRoot, input.run_id, proofDescriptor, delivery)) return "unavailable";
    const publishInput: CtoOutboxDeliveryPublishInput = {
      run_id: input.run_id,
      state_revision: commitment.state_revision,
      entry_name: input.entry_name,
      json: bytes,
      routing_binding: routingBinding,
    };
    // The exact pending obligation and its process-scoped HMAC proof were
    // verified above, so a source envelope may retain its immutable revision
    // while the authority/index binds the current publication revision.
    if (!ctoDeliveryMatchesState(delivery as Record<string, unknown>, bytes, state, publishInput, { allowHistoricalObligationRevision: true })) return "invalid";
    const storageEntryName = input.storage_entry_name ?? input.entry_name;
    const relativePath = input.lane === "outbox"
      ? ctoRunOutboxRelativePath(input.run_id, storageEntryName)
      : join(".work-state", "cto", input.run_id, "outbox-retry", storageEntryName);
    let storageInfo: ReturnType<PinnedProjectRoot["pathEntryInfo"]>;
    try { storageInfo = pinnedRoot.pathEntryInfo(relativePath); } catch { return "unavailable"; }
    if (!storageInfo || storageInfo.kind !== "file") return "invalid";
    let stored: { bytes: Uint8Array };
    try { stored = pinnedRoot.readFile(relativePath, { maxBytes: MAX_CTO_OUTBOX_ENVELOPE_BYTES }); } catch { return "unavailable"; }
    if (Buffer.compare(Buffer.from(stored.bytes), bytes) !== 0) return "invalid";
    const current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
    if (!current.valid || !current.observed) return "unavailable";
    const entry = current.index.entries.find((candidate) => candidate.run_id === input.run_id);
    if (!entry || entry.status !== ctoRunDeliveryStatus(state)) return "invalid";
    if (input.lane === "outbox" ? entry.pending_outbox !== true : entry.pending_retry !== true) return "invalid";
    if (!pinnedRoot.isStable()) return "unavailable";
    return "current";
  } catch {
    return "unavailable";
  }
}

export class CtoDeliveryObligationCapacityError extends Error {
  readonly code = "CTO_DELIVERY_OBLIGATION_CAPACITY";

  constructor(message = "CTO delivery obligation capacity exceeded") {
    super(message);
    this.name = "CtoDeliveryObligationCapacityError";
  }
}
export class CtoDeliveryObligationRecoveryRequiredError extends Error {
  readonly code = "CTO_DELIVERY_OBLIGATION_RECOVERY_REQUIRED";

  constructor(message = "CTO delivery obligation recorded; pending index recovery is required") {
    super(message);
    this.name = "CtoDeliveryObligationRecoveryRequiredError";
  }
}

export interface CtoOutboxDeliveryObligationInput {
  run_id: string;
  entry_name: string;
  json: string | Uint8Array;
  routing_binding?: CtoOutboxDeliveryRoutingBinding;
}

export interface CtoOutboxDeliveryObligationRead {
  run_id: string;
  entry_name: string;
  envelope_id: string;
  intent: CtoDeliveryIntent;
  /** Immutable revision carried by the authenticated source envelope. */
  source_revision: number;
  created_revision: number;
  /** Current revision used to bind this publication in the index/authority. */
  state_revision: number;
  json: Uint8Array;
}

function immutableSummaryEvidenceEnvelope(state: CtoState, delivery: Record<string, unknown>): Buffer | null {
  if (delivery.intent !== "summary" || typeof delivery.wave_id !== "string") return null;
  const evidence = (state.terminal_summary_evidence ?? []).find((candidate) => candidate.wave_id === delivery.wave_id);
  if (!evidence) return null;
  let stored: unknown;
  try { stored = JSON.parse(evidence.envelope); } catch { return null; }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const expected = { ...(stored as Record<string, unknown>) };
  const actual = { ...delivery };
  delete expected.state_revision;
  delete actual.state_revision;
  if (JSON.stringify(expected) !== JSON.stringify(actual)) return null;
  const bytes = Buffer.from(evidence.envelope, "utf8");
  return createHash("sha256").update(bytes).digest("hex") === evidence.envelope_sha256 ? bytes : null;
}

/** CAS-record one canonical envelope before any workspace outbox/index publication. */
export function recordCtoOutboxDeliveryObligation(
  root: string,
  input: CtoOutboxDeliveryObligationInput,
  providedRoot?: PinnedProjectRoot,
  capability?: unknown,
): CtoOutboxDeliveryObligationRead | null {
  if (!isCtoRuntimeDeliveryCapability(capability)) return null;
  if (!isSafeCtoRunId(input?.run_id) || !isSafeCtoOutboxEntryName(input?.entry_name)) return null;
  const bytes = typeof input.json === "string" ? Buffer.from(input.json, "utf8") : input.json instanceof Uint8Array ? Buffer.from(input.json) : null;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_PENDING_DELIVERY_ENVELOPE_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(decodeUtf8(bytes)); } catch { return null; }
  if (!validCtoDelivery(parsed, input.run_id)) return null;
  const routingBinding = input.routing_binding === undefined ? DEFAULT_ROUTING_BINDING : normalizeCtoOutboxDeliveryRoutingBinding(input.routing_binding);
  if (!routingBinding) return null;
  const envelopeId = durableEnvelopeId(bytes);
  if (!envelopeId || canonicalDurableIdFileName(envelopeId) !== input.entry_name) return null;
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return null;
  let result: CtoOutboxDeliveryObligationRead | null = null;
  try {
    withCtoRunLock(pinnedRoot.canonical_root, input.run_id, () => {
      const current = readCtoStatePinned(input.run_id, pinnedRoot);
      if (!current || !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, current) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, current)) return;
      const currentRevisionValue = current.state_revision;
      if (!current || typeof currentRevisionValue !== "number" || !Number.isSafeInteger(currentRevisionValue) || currentRevisionValue < 0) return;
      const currentRevision: number = currentRevisionValue;
      const parsedDelivery = parsed as Record<string, unknown>;
      const obligations = current.pending_delivery_obligations ?? [];
      const existing = obligations.find((candidate) => candidate.entry_name === input.entry_name);
      const exactExisting = existing !== undefined
        && existing.envelope_id === envelopeId
        && existing.intent === parsedDelivery.intent
        && ctoPendingObligationMatchesDelivery(current, input.entry_name, envelopeId, parsedDelivery);
      if (!ctoDeliveryMatchesState(parsedDelivery, bytes, current, {
          run_id: input.run_id,
          state_revision: currentRevision,
          entry_name: input.entry_name,
          json: bytes,
        }, { allowHistoricalSummaryRevision: true, allowHistoricalObligationRevision: exactExisting })) return;
      if (existing) {
        if (existing.envelope_id !== envelopeId || existing.intent !== parsedDelivery.intent
          || !ctoPendingObligationMatchesDelivery(current, input.entry_name, envelopeId, parsedDelivery)) return;
        const rebound = Buffer.from(existing.envelope, "utf8");
        if (!rebound.byteLength || !immutableSummaryEvidenceEnvelope(current, parsedDelivery) && existing.intent === "summary") return;
        if (!isCtoRuntimeDeliveryCapability(capability)) return;
        const reboundDelivery = JSON.parse(decodeUtf8(rebound)) as Record<string, unknown>;
        const proofValid = validCtoDeliveryProof(pinnedRoot, input.run_id, input.entry_name, envelopeId, reboundDelivery, rebound, routingBinding);
        if (!proofValid && !rebindCtoDeliveryProof(pinnedRoot, input.run_id, input.entry_name, envelopeId, reboundDelivery, rebound, routingBinding)) return;
        result = { run_id: input.run_id, entry_name: existing.entry_name, envelope_id: existing.envelope_id, intent: existing.intent, source_revision: existing.created_revision, created_revision: existing.created_revision, state_revision: currentRevision, json: rebound };
        return;
      }
      if (obligations.length >= MAX_PENDING_DELIVERY_OBLIGATIONS) throw new CtoDeliveryObligationCapacityError();
      const nextRevision = currentRevision + 1;
      const candidate = { ...(parsed as Record<string, unknown>), run_id: input.run_id, state_revision: nextRevision };
      const evidenceBytes = immutableSummaryEvidenceEnvelope(current, parsedDelivery);
      const canonicalBytes = evidenceBytes ?? Buffer.from(JSON.stringify(candidate), "utf8");
      let canonicalCandidate: Record<string, unknown>;
      try { canonicalCandidate = JSON.parse(decodeUtf8(canonicalBytes)) as Record<string, unknown>; } catch { return; }
      if (!validCtoDelivery(canonicalCandidate, input.run_id) || canonicalBytes.byteLength > MAX_PENDING_DELIVERY_ENVELOPE_BYTES
        || canonicalCandidate.id !== envelopeId || canonicalCandidate.intent !== parsedDelivery.intent) return;
      const existingBytes = obligations.reduce((total, item) => total + Buffer.byteLength(item.envelope, "utf8"), 0);
      if (existingBytes + canonicalBytes.byteLength > MAX_PENDING_DELIVERY_TOTAL_BYTES) throw new CtoDeliveryObligationCapacityError();
      const sourceRevision = Number(canonicalCandidate.state_revision);
      if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) return;
      const obligation: CtoPendingDeliveryObligation = {
        entry_name: input.entry_name,
        envelope_id: envelopeId,
        run_id: input.run_id,
        intent: canonicalCandidate.intent as CtoDeliveryIntent,
        source: "cto",
        source_ref: envelopeId,
        created_revision: sourceRevision,
        envelope: decodeUtf8(canonicalBytes),
      };
      if (isCtoRuntimeDeliveryCapability(capability) && !ensureCtoDeliveryProof(pinnedRoot, input.run_id, input.entry_name, envelopeId, canonicalCandidate, canonicalBytes, routingBinding)) return;
      if (obligation.intent === "summary" && typeof canonicalCandidate.wave_id === "string" && !current.terminal_summary_evidence?.some((item) => item.wave_id === canonicalCandidate.wave_id)) {
        current.terminal_summary_evidence = [...(current.terminal_summary_evidence ?? []), {
          wave_id: canonicalCandidate.wave_id,
          source_revision: sourceRevision,
          envelope_sha256: createHash("sha256").update(canonicalBytes).digest("hex"),
          envelope: obligation.envelope,
        }];
      }
      current.pending_delivery_obligations = [...obligations, obligation];
      writeCtoStateLocked(current, pinnedRoot.canonical_root, { pinnedRoot });
      if (!writeCtoRuntimeStateProof(pinnedRoot, current)) throw new CtoDeliveryObligationRecoveryRequiredError();
      findCtoRunDeliveryHook(pinnedRoot, root)?.beforeObligationMark?.({ root, run_id: input.run_id, entry_name: input.entry_name });
      if (!markCtoRunDeliveryPending(pinnedRoot.canonical_root, input.run_id, nextRevision, "outbox", pinnedRoot, capability)) {
        throw new CtoDeliveryObligationRecoveryRequiredError();
      }
      findCtoRunDeliveryHook(pinnedRoot, root)?.afterObligationRecord?.({ root, run_id: input.run_id, entry_name: input.entry_name });
      result = { run_id: input.run_id, entry_name: input.entry_name, envelope_id: envelopeId, intent: obligation.intent, source_revision: sourceRevision, created_revision: sourceRevision, state_revision: nextRevision, json: canonicalBytes };
    }, { pinnedRoot });
    return result;
  } finally {
    if (!providedRoot) pinnedRoot.close();
  }
}

/** Read only state-owned obligations; callers must republish through the trusted runtime facade. */
export function readCtoOutboxDeliveryObligationsPinned(root: string, runId: string, providedRoot?: PinnedProjectRoot): CtoOutboxDeliveryObligationRead[] {
  if (!isSafeCtoRunId(runId)) return [];
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return [];
  try {
    const state = readCtoStatePinned(runId, pinnedRoot);
    const stateRevisionValue = state?.state_revision;
    if (!state || !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state) || typeof stateRevisionValue !== "number" || !Number.isSafeInteger(stateRevisionValue) || stateRevisionValue < 0) return [];
    const stateRevision: number = stateRevisionValue;
    return (state.pending_delivery_obligations ?? []).flatMap((obligation) => {
      const json = Buffer.from(obligation.envelope, "utf8");
      return json.byteLength > 0 && json.byteLength <= MAX_PENDING_DELIVERY_ENVELOPE_BYTES
        ? [{ run_id: runId, entry_name: obligation.entry_name, envelope_id: obligation.envelope_id, intent: obligation.intent, source_revision: obligation.created_revision, created_revision: obligation.created_revision, state_revision: stateRevision, json }]
        : [];
    });
  } finally {
    if (!providedRoot) pinnedRoot.close();
  }
}

/** Rebind the active-run index to a post-obligation state revision before transport archival.
 *
 * The transport callback is already confirmed at this point, but the active
 * outbox file is still present. Clear the old pending flags with an exact CAS
 * so the subsequent ACK can use the new state revision. If the process dies
 * before archival, queue/evidence recovery reasserts pending work.
 */
function reconcileCtoRunDeliveryIndexAfterObligationRemovalPinned(state: CtoState, pinnedRoot: PinnedProjectRoot): void {
  let current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
  if (!current.valid) {
    const rebuilt = rebuildCtoRunDeliveryIndexPinned(pinnedRoot, { reconcileQueueEvidence: false });
    if (current.observed !== null || rebuilt.entries.length > 0) {
      persistCtoRunDeliveryIndexPinned(pinnedRoot, rebuilt, current.observed);
      current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
    } else {
      current = { index: rebuilt, observed: null, valid: true };
    }
  }
  const known = current.index.entries.find((entry) => entry.run_id === state.id);
  const revision = Number.isSafeInteger(state.state_revision) && (state.state_revision as number) >= 0
    ? state.state_revision as number
    : 0;
  if (!known || revision < known.state_revision) return;
  const refreshed = ctoRunDeliveryEntry(state, known, pinnedRoot, { reconcileQueueEvidence: false });
  const settled: CtoRunDeliveryIndexEntry = {
    ...refreshed,
    state_revision: revision,
    pending_summary: isTerminalDeliveryStatus(ctoRunDeliveryStatus(state)) && !terminalSummaryDeliveredPinned(pinnedRoot, state),
    // The confirmed envelope is gone, but unrelated queue evidence must keep
    // this run indexed so the bounded drain can quarantine or deliver it.
    pending_outbox: !ctoRunOutboxQueueEvidenceEmptyPinned(pinnedRoot, state.id),
    pending_retry: !ctoRunRetryQueueEvidenceEmptyPinned(pinnedRoot, state.id),
  };
  const entries = boundedRunDeliveryEntries([
    ...current.index.entries.filter((entry) => entry.run_id !== state.id),
    settled,
  ]);
  const next: CtoRunDeliveryIndex = { schema_version: 2, active_run_id: latestActiveRunId(entries), entries };
  persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed);
}

function reconcileCtoRunDeliveryIndexAfterObligationRemoval(state: CtoState, pinnedRoot: PinnedProjectRoot): void {
  withCtoStateWriteLock(
    pinnedRoot.canonical_root,
    CTO_RUN_DELIVERY_INDEX_LOCK_ID,
    () => reconcileCtoRunDeliveryIndexAfterObligationRemovalPinned(state, pinnedRoot),
    { pinnedRoot },
  );
}

/** CAS-remove one exact state-owned obligation after transport success. */
export function removeCtoOutboxDeliveryObligation(root: string, runId: string, entryName: string, envelopeId: string, providedRoot?: PinnedProjectRoot, capability?: unknown): boolean {
  if (!isCtoRuntimeDeliveryCapability(capability)) return false;
  if (!isSafeCtoRunId(runId) || !isSafeCtoOutboxEntryName(entryName) || !isSafeCtoDeliveryEnvelopeId(envelopeId)) return false;
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return false;
  let removed = false;
  let removedEnvelope: string | null = null;
  try {
    withCtoRunLock(pinnedRoot.canonical_root, runId, () => {
      const current = readCtoStatePinned(runId, pinnedRoot);
      if (!current || !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, current) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, current)) return;
      const removedObligation = current?.pending_delivery_obligations?.find((entry) => entry.entry_name === entryName && entry.envelope_id === envelopeId);
      if (!removedObligation || !current) return;
      removedEnvelope = removedObligation.envelope;
      current.pending_delivery_obligations = (current.pending_delivery_obligations ?? []).filter((entry) => !(entry.entry_name === entryName && entry.envelope_id === envelopeId));
      findCtoRunDeliveryHook(pinnedRoot, root)?.beforeObligationRemove?.({ root, run_id: runId, entry_name: entryName, envelope_id: envelopeId });
      writeCtoStateLocked(current, pinnedRoot.canonical_root, { pinnedRoot });
      if (!writeCtoRuntimeStateProof(pinnedRoot, current)) throw new CtoDeliveryObligationRecoveryRequiredError();
      findCtoRunDeliveryHook(pinnedRoot, root)?.afterObligationRemove?.({ root, run_id: runId, entry_name: entryName, envelope_id: envelopeId });
      removed = true;
    }, { pinnedRoot });
    if (removed) {
      const latest = readCtoStatePinned(runId, pinnedRoot);
      if (removedEnvelope) removeCtoDeliveryProofIfSettled(pinnedRoot, runId, entryName, envelopeId, removedEnvelope);
      if (latest && (latest.pending_delivery_obligations?.length ?? 0) > 0 && Number.isSafeInteger(latest.state_revision) && (latest.state_revision as number) >= 0) {
        markCtoRunDeliveryPending(pinnedRoot.canonical_root, runId, latest.state_revision as number, "outbox", pinnedRoot, capability);
      } else if (latest) {
        reconcileCtoRunDeliveryIndexAfterObligationRemoval(latest, pinnedRoot);
      }
    }
    return removed;
  } finally {
    if (!providedRoot) pinnedRoot.close();
  }
}

export interface CtoTerminalSummaryEnvelope {
  id: string;
  level: "question";
  title: "CTO wave complete";
  body: string;
  intent: "summary";
  topic: "summary";
  at: string;
  by: "cto";
  run_id: string;
  state_revision: number;
  wave_id: string;
  idempotency_key: string;
}

/** Build the sole canonical terminal wave-summary envelope. */
export function buildCtoTerminalSummaryEnvelope(
  state: CtoState,
  wave: WaveRecord,
): CtoTerminalSummaryEnvelope {
  const excerpt = wave.task.trim().slice(0, 200);
  const counts: Record<string, number> = {};
  for (const team of state.teams ?? []) counts[team.status] = (counts[team.status] ?? 0) + 1;
  const teamSummary = Object.entries(counts).map(([status, count]) => `${count} ${status}`).sort().join(", ") || "0 teams";
  const lines = [
    `Run ${state.id}: wave ${wave.id} ${wave.status}.`,
    `Started: ${wave.started_at}; finished: ${wave.finished_at}.`,
    `Task: "${excerpt}"`,
    `Teams: ${teamSummary}.`,
  ];
  if (state.integration?.status) lines.push(`Integration: ${state.integration.status}.`);
  const id = `${state.id}/wave/${wave.id}/summary`;
  return {
    id,
    level: "question",
    title: "CTO wave complete",
    body: lines.join("\n"),
    intent: "summary",
    topic: "summary",
    at: typeof wave.finished_at === "string" ? wave.finished_at : "",
    by: "cto",
    run_id: state.id,
    state_revision: Number.isSafeInteger(state.state_revision) && (state.state_revision as number) >= 0
      ? state.state_revision as number
      : 0,
    wave_id: wave.id,
    idempotency_key: id,
  };
}

export function isDeterministicCtoTerminalSummaryDelivery(
  state: CtoState,
  envelopeId: string,
  bytes: Buffer,
  allowHistoricalRevision = false,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (typeof state.id !== "string" || !Array.isArray(state.wave_history) || !Array.isArray(state.teams)) return false;
  const value = parsed as Record<string, unknown>;
  const parts = envelopeId.split("/");
  if (parts.length !== 4 || parts[0] !== state.id || parts[1] !== "wave" || parts[3] !== "summary" || !isSafeCtoExecutionId(parts[2])) return false;
  const wave = state.wave_history.find((candidate) => candidate && candidate.id === parts[2]);
  if (!wave || typeof wave.id !== "string" || typeof wave.task !== "string" || typeof wave.started_at !== "string" || !Array.isArray(wave.slice_ids) || (wave.status !== "done" && wave.status !== "failed") || typeof wave.finished_at !== "string" || wave.finished_at.length === 0) return false;
  const expected = buildCtoTerminalSummaryEnvelope(state, wave);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(value).sort();
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) return false;
  if (!allowHistoricalRevision) {
    return expectedKeys.every((key) => value[key] === expected[key as keyof CtoTerminalSummaryEnvelope])
      && bytes.equals(Buffer.from(JSON.stringify(expected)));
  }
  const deliveryRevision = value.state_revision;
  const currentRevision = state.state_revision;
  if (!Number.isSafeInteger(deliveryRevision) || (deliveryRevision as number) < 0
    || !Number.isSafeInteger(currentRevision) || (currentRevision as number) < 0
    || (deliveryRevision as number) > (currentRevision as number)) return false;
  if (!expectedKeys.every((key) => key === "state_revision" || value[key] === expected[key as keyof CtoTerminalSummaryEnvelope])) return false;
  if (!bytes.equals(Buffer.from(JSON.stringify(value)))) return false;
  return JSON.stringify({ ...value, state_revision: expected.state_revision }) === JSON.stringify(expected);
}
function terminalSummaryDeliveredPinned(pinnedRoot: PinnedProjectRoot, state: CtoState): boolean {
  if (!Array.isArray(state.wave_history)) return true;
  const completed: WaveRecord[] = [];
  for (const wave of state.wave_history) {
    if (!wave || typeof wave.id !== "string" || !isSafeCtoExecutionId(wave.id)) return false;
    if (wave.status === "active") {
      if (wave.finished_at !== undefined && (typeof wave.finished_at !== "string" || wave.finished_at.length === 0)) return false;
      continue;
    }
    if (wave.status !== "done" && wave.status !== "failed") return false;
    if (typeof wave.finished_at !== "string" || wave.finished_at.length === 0) return false;
    completed.push(wave);
  }
  return completed.every((wave) => {
    const envelopeId = `${state.id}/wave/${wave.id}/summary`;
    const sentPath = join(ctoRunOutboxRelativePath(state.id), "sent", canonicalDurableIdFileName(envelopeId));
    try {
      const first = pinnedRoot.readFile(sentPath, { maxBytes: 64 * 1024 });
      const firstBytes = Buffer.from(first.bytes);
      if (!isDeterministicCtoTerminalSummaryDelivery(state, envelopeId, firstBytes, true)) return false;
      let parsed: unknown;
      try { parsed = JSON.parse(decodeUtf8(firstBytes)); } catch { return false; }
      const evidence = immutableSummaryEvidenceEnvelope(state, parsed as Record<string, unknown>);
      const parsedRevision = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).state_revision
        : undefined;
      if (parsedRevision !== state.state_revision && (!evidence || !evidence.equals(firstBytes))) return false;
      const second = pinnedRoot.readFile(sentPath, { maxBytes: 64 * 1024 });
      return first.dev === second.dev && first.ino === second.ino && firstBytes.equals(Buffer.from(second.bytes));
    } catch {
      return false;
    }
  });
}

type ExistingOutboxPathStatus = "absent" | "same" | "conflict";

function existingOutboxPathStatus(
  pinnedRoot: PinnedProjectRoot,
  path: string,
  expectedId: string,
  expectedBytes: Buffer,
): ExistingOutboxPathStatus {
  let info: ReturnType<PinnedProjectRoot["pathEntryInfo"]>;
  try {
    info = pinnedRoot.pathEntryInfo(path);
  } catch {
    return "conflict";
  }
  if (!info) return "absent";
  if (info.kind !== "file") return "absent";
  try {
    const bytes = Buffer.from(pinnedRoot.readFile(path, { maxBytes: 64 * 1024 }).bytes);
    const actualId = durableEnvelopeId(bytes);
    if (actualId !== expectedId || !bytes.equals(expectedBytes)) return "conflict";
    return "same";
  } catch {
    return "conflict";
  }
}

function existingOutboxDirectoryEnvelopeStatus(
  pinnedRoot: PinnedProjectRoot,
  directory: string,
  expectedId: string,
  expectedBytes: Buffer,
): ExistingOutboxPathStatus {
  const canonicalPath = join(directory, canonicalDurableIdFileName(expectedId));
  let cursor: string | null = null;
  for (;;) {
    let page: ReturnType<PinnedProjectRoot["listDirectoryPage"]>;
    try {
      page = pinnedRoot.listDirectoryPage(directory, {
        cursor,
        maxEntries: 64,
        maxNameBytes: 16 * 1024,
        maxScanEntries: 1024,
        maxScanNameBytes: 128 * 1024,
      });
    } catch (error) {
      if (pinnedStateErrorCode(error) === "not_found") return "absent";
      return "conflict";
    }
    for (const name of page.names) {
      if (!name.endsWith(".json") || name.endsWith(".index-before.json")) continue;
      const path = join(directory, name);
      if (path === canonicalPath) continue;
      let info: ReturnType<PinnedProjectRoot["pathEntryInfo"]>;
      try {
        info = pinnedRoot.pathEntryInfo(path);
      } catch {
        return "conflict";
      }
      if (!info || info.kind !== "file") return "conflict";
      let bytes: Buffer;
      try {
        bytes = Buffer.from(pinnedRoot.readFile(path, { maxBytes: 64 * 1024 }).bytes);
      } catch {
        return "conflict";
      }
      const actualId = durableEnvelopeId(bytes);
      if (actualId === null) return "conflict";
      if (actualId !== expectedId) continue;
      if (!bytes.equals(expectedBytes)) return "conflict";
      return "same";
    }
    if (page.nextCursor === null) return "absent";
    cursor = page.nextCursor;
  }
}

export interface CtoRunDeliveryTestHooks {
  beforePendingMark?: (context: { root: string; run_id: string; entry_name: string }) => void;
  afterPendingMark?: (context: { root: string; run_id: string; entry_name: string }) => void;
  beforeObligationMark?: (context: { root: string; run_id: string; entry_name: string }) => void;
  afterObligationRecord?: (context: { root: string; run_id: string; entry_name: string }) => void;
  beforeObligationRemove?: (context: { root: string; run_id: string; entry_name: string; envelope_id: string }) => void;
  afterObligationRemove?: (context: { root: string; run_id: string; entry_name: string; envelope_id: string }) => void;
}
type CtoRunDeliveryHookRecord = { hook: CtoRunDeliveryTestHooks; aliases: string[] };
const ctoRunDeliveryHooksByAlias = new Map<string, CtoRunDeliveryHookRecord>();
function ctoRunDeliveryHookAliases(projectRoot: string): string[] {
  const lexical = resolve(projectRoot);
  const aliases = [lexical];
  try {
    const canonical = resolve(realpathSync(projectRoot));
    if (!aliases.includes(canonical)) aliases.push(canonical);
    const stat = lstatSync(canonical);
    aliases.push("identity:" + String(stat.dev) + ":" + String(stat.ino));
  } catch {
    // The lexical alias remains usable for a pinned operation after a root swap.
  }
  return aliases;
}
function findCtoRunDeliveryHook(pinnedRoot: PinnedProjectRoot, projectRoot: string): CtoRunDeliveryTestHooks | undefined {
  const aliases = ["identity:" + String(pinnedRoot.dev) + ":" + String(pinnedRoot.ino), ...ctoRunDeliveryHookAliases(projectRoot)];
  for (const alias of aliases) {
    const record = ctoRunDeliveryHooksByAlias.get(alias);
    if (record) return record.hook;
  }
  return undefined;
}
/** Internal deterministic race seam; intentionally not exported by package index. */
export function setCtoRunDeliveryTestHooks(hooks: CtoRunDeliveryTestHooks | null, projectRoot: string): void {
  const aliases = ctoRunDeliveryHookAliases(projectRoot);
  const previous = new Set<CtoRunDeliveryHookRecord>();
  for (const alias of aliases) {
    const record = ctoRunDeliveryHooksByAlias.get(alias);
    if (record) previous.add(record);
  }
  for (const record of previous) for (const alias of record.aliases) {
    if (ctoRunDeliveryHooksByAlias.get(alias) === record) ctoRunDeliveryHooksByAlias.delete(alias);
  }
  if (!hooks) return;
  const record: CtoRunDeliveryHookRecord = { hook: hooks, aliases };
  for (const alias of aliases) ctoRunDeliveryHooksByAlias.set(alias, record);
}
/**
 * Publish one outbox file and its pending marker under one index lock. The
 * durable outbox file is committed before the index marker: a crash or write
 * failure therefore leaves either a recoverable envelope or no index mutation.
 */
export function publishCtoOutboxDelivery(root: string, input: CtoOutboxDeliveryPublishInput, providedRoot?: PinnedProjectRoot, capability?: unknown): string | null {
  if (!isCtoRuntimeDeliveryCapability(capability)) return null;
  if (!isSafeCtoRunId(input?.run_id) || !Number.isSafeInteger(input?.state_revision) || input.state_revision < 0 || !isSafeCtoOutboxEntryName(input?.entry_name)) return null;
  if (input.legacy_entry_name !== undefined && !isSafeCtoOutboxEntryName(input.legacy_entry_name)) return null;
  const initialBytes = typeof input.json === "string" ? Buffer.from(input.json, "utf8") : input.json instanceof Uint8Array ? Buffer.from(input.json) : null;
  if (!initialBytes || initialBytes.byteLength > 64 * 1024) return null;
  let bytes: Buffer<ArrayBufferLike> = initialBytes;
  const routingBinding = input.routing_binding === undefined ? DEFAULT_ROUTING_BINDING : normalizeCtoOutboxDeliveryRoutingBinding(input.routing_binding);
  if (!routingBinding) return null;
  let delivery: unknown;
  try {
    delivery = JSON.parse(decodeUtf8(bytes));
  } catch {
    return null;
  }
  if (!validCtoDelivery(delivery, input.run_id)) return null;
  const envelopeId = durableEnvelopeId(bytes);
  if (!envelopeId || canonicalDurableIdFileName(envelopeId) !== input.entry_name) return null;
  if (input.legacy_entry_name !== undefined && safeLegacyDurableIdFileName(envelopeId) !== input.legacy_entry_name) return null;
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return null;
  try {
    return withCtoStateWriteLock(pinnedRoot.canonical_root, CTO_RUN_DELIVERY_INDEX_LOCK_ID, () => {
      // Validate the canonical payload against the current run before any
      // recovery can repair or rewrite the delivery index. Invalid, foreign,
      // stale, or misrouted deliveries therefore leave every durable file
      // untouched.
      let state = readCtoStatePinned(input.run_id, pinnedRoot);
      if (!state || !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state) || !ctoPendingObligationMatchesDelivery(state, input.entry_name, envelopeId, delivery)) return null;
      const canonicalizeObligationForState = (currentState: CtoState): boolean => {
        const currentRevisionValue = currentState.state_revision;
        if (!Number.isSafeInteger(currentRevisionValue) || (currentRevisionValue as number) < 0) return false;
        const currentRevision = currentRevisionValue as number;
        const obligation = (currentState.pending_delivery_obligations ?? []).find((candidate) => candidate.entry_name === input.entry_name && candidate.envelope_id === envelopeId);
        if (!obligation) return false;
        const rebound = Buffer.from(obligation.envelope, "utf8");
        if (!rebound || !rebound.byteLength || rebound.byteLength > 64 * 1024) return false;
        let reboundDelivery: unknown;
        try { reboundDelivery = JSON.parse(decodeUtf8(rebound)); } catch { return false; }
        if (!validCtoDelivery(reboundDelivery, input.run_id) || durableEnvelopeId(rebound) !== envelopeId) return false;
        bytes = rebound;
        delivery = reboundDelivery;
        input = { ...input, state_revision: currentRevision, json: rebound };
        return ctoPendingObligationMatchesDelivery(currentState, input.entry_name, envelopeId, delivery)
          && ctoDeliveryMatchesState(delivery as Record<string, unknown>, bytes, currentState, input, { allowHistoricalObligationRevision: true });
      };
      if (!canonicalizeObligationForState(state)) return null;
      if (!ensureCtoDeliveryProof(pinnedRoot, input.run_id, input.entry_name, envelopeId, delivery as Record<string, unknown>, bytes, routingBinding)) return null;
      // A publisher may be the first post-crash reader. Recover journals and
      // rebuild missing/corrupt indexes only after payload authority is proven.
      // The obligation marker and state revision were just committed under the
      // run lock; avoid rediscovering every canonical run before this
      // publication's exact index CAS.
      recoverCtoRunDeliveryIndexLocked(pinnedRoot, { reconcileObligations: false });
      let current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
      let entry = current.index.entries.find((candidate) => candidate.run_id === input.run_id);
      const stateStatus = ctoRunDeliveryStatus(state);
      if (!current.valid || !current.observed || !entry || entry.state_revision !== state.state_revision || entry.status !== stateStatus) {
        const latestState = readCtoStatePinned(input.run_id, pinnedRoot);
        if (!latestState || !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, latestState) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, latestState) || !canonicalizeObligationForState(latestState)) return null;
        state = latestState;
        const rebuilt = rebuildCtoRunDeliveryIndexPinned(pinnedRoot);
        persistCtoRunDeliveryIndexPinned(pinnedRoot, rebuilt, current.observed);
        current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
        state = readCtoStatePinned(input.run_id, pinnedRoot);
        if (!state || !state.id || !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state) || !canonicalizeObligationForState(state)) return null;
        entry = current.index.entries.find((candidate) => candidate.run_id === input.run_id);
      }
      if (!ctoDeliveryMatchesState(delivery as Record<string, unknown>, bytes, state, input, { allowHistoricalObligationRevision: true, allowHistoricalSummaryRevision: true })) return null;
      const terminalRun = entry !== undefined && (isTerminalDeliveryStatus(entry.status) || isCtoRunTerminal(state));
      if (
        !entry
        || !current.valid
        || !current.observed
        || state.state_revision !== input.state_revision
        || entry.state_revision !== input.state_revision
        || entry.status !== ctoRunDeliveryStatus(state)
        || (terminalRun && (delivery as Record<string, unknown>).intent === "summary" && entry.pending_summary !== true)
        || (terminalRun && (delivery as Record<string, unknown>).intent !== "ack" && !isDeterministicCtoTerminalSummaryDelivery(state, envelopeId, bytes, true))
      ) return null;
      // Only active outbox and retry lanes are producer authority. The sent
      // archive is workspace-writable transport evidence, so exact or
      // conflicting sent records never dedupe or suppress a fresh publish.
      // Legacy names remain advisory probes only; a lossy alias owned by
      // another durable ID must never starve its canonical delivery.
      const rearmPendingDelivery = (lane: "outbox" | "retry"): void => {
        if ((lane === "outbox" ? entry?.pending_outbox : entry?.pending_retry) || !current.observed) return;
        const pendingEntry: CtoRunDeliveryIndexEntry = { ...entry!, state_revision: input.state_revision, pending_outbox: lane === "outbox" ? true : entry!.pending_outbox, pending_retry: lane === "retry" ? true : entry!.pending_retry, updated_at: state!.updated_at, summary_digest: ctoRunDeliverySummaryDigest(state!) };
        const nextEntries = boundedRunDeliveryEntries(current.index.entries.map((candidate) => candidate.run_id === input.run_id ? pendingEntry : candidate));
        const next: CtoRunDeliveryIndex = { schema_version: 2, active_run_id: latestActiveRunId(nextEntries), entries: nextEntries };
        findCtoRunDeliveryHook(pinnedRoot, root)?.beforePendingMark?.({ root, run_id: input.run_id, entry_name: input.entry_name });
        const preimage = writeCtoRunDeliveryIndexPreimagePinned(pinnedRoot, input.run_id, current);
        try {
          persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed);
          clearCtoRunDeliveryIndexPreimagePinned(pinnedRoot, input.run_id, preimage);
        } catch (error) {
          // Preserve the preimage as recovery evidence when index/proof publication
          // is interrupted; an authenticated stale proof can then advance exactly.
          throw error;
        }
        findCtoRunDeliveryHook(pinnedRoot, root)?.afterPendingMark?.({ root, run_id: input.run_id, entry_name: input.entry_name });
        current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
        entry = current.index.entries.find((candidate) => candidate.run_id === input.run_id);
      };
      const descriptorBase = {
        entry_name: input.entry_name,
        envelope_id: envelopeId,
        state_revision: input.state_revision,
        bytes_length: bytes.byteLength,
        bytes_sha256: createHash("sha256").update(bytes).digest("hex"),
        routing_config_sha256: routingBinding.config_sha256,
        routing_snapshot_sha256: routingBinding.snapshot_sha256,
        routing_channel: routingBinding.channel,
        routing_target: routingBinding.target,
      };
      let descriptor: CtoRunOutboxPublicationAuthorityEntry = {
        ...descriptorBase,
        proof: ctoOutboxPublicationProof(pinnedRoot, input.run_id, descriptorBase, delivery as Record<string, unknown>),
      };
      let knownAuthority: CtoRunOutboxPublicationAuthorityRead | null;
      try {
        knownAuthority = readCtoRunOutboxPublicationAuthorityPinned(pinnedRoot, input.run_id);
      } catch {
        return null;
      }
      if (knownAuthority) {
        for (const existing of knownAuthority.authority.entries) {
          if (existing.entry_name === input.entry_name || existing.state_revision === input.state_revision) continue;
          const obligation = (state.pending_delivery_obligations ?? []).find((candidate) => candidate.entry_name === existing.entry_name && candidate.envelope_id === existing.envelope_id);
          if (!obligation) continue;
          let stored: { bytes: Uint8Array };
          try { stored = pinnedRoot.readFile(ctoRunOutboxRelativePath(input.run_id, existing.entry_name), { maxBytes: MAX_CTO_OUTBOX_ENVELOPE_BYTES }); } catch { continue; }
          const storedBytes = Buffer.from(stored.bytes);
          let storedDelivery: unknown;
          try { storedDelivery = JSON.parse(decodeUtf8(storedBytes)); } catch { return null; }
          if (!ctoPendingObligationMatchesDelivery(state, existing.entry_name, existing.envelope_id, storedDelivery)) return null;
          const nextBase = { ...existing, state_revision: input.state_revision, bytes_length: storedBytes.byteLength, bytes_sha256: createHash("sha256").update(storedBytes).digest("hex") };
          const nextDescriptor: CtoRunOutboxPublicationAuthorityEntry = { ...nextBase, proof: ctoOutboxPublicationProof(pinnedRoot, input.run_id, nextBase, storedDelivery as Record<string, unknown>) };
          if (!persistCtoRunOutboxPublicationAuthorityPinned(pinnedRoot, nextDescriptor, true)) return null;
        }
        knownAuthority = readCtoRunOutboxPublicationAuthorityPinned(pinnedRoot, input.run_id);
      }
      const knownCommitment = knownAuthority?.authority.entries.find((candidate) => candidate.entry_name === input.entry_name);
      if (knownCommitment && !outboxPublicationAuthorityPayloadMatches(knownCommitment, descriptor)
        && (!ctoPendingObligationMatchesDelivery(state, input.entry_name, envelopeId, delivery))) return null;
      const canonicalPaths = [
        ctoRunOutboxRelativePath(input.run_id, input.entry_name),
        join(".work-state", "cto", input.run_id, "outbox-retry", input.entry_name),
      ];
      const canonicalStatuses = canonicalPaths.map((path) => existingOutboxPathStatus(pinnedRoot, path, envelopeId, bytes));
      for (let index = 0; index < canonicalStatuses.length; index += 1) {
        if (canonicalStatuses[index] !== "conflict") continue;
        const path = canonicalPaths[index]!;
        try {
          const stale = pinnedRoot.readFile(path, { maxBytes: MAX_CTO_OUTBOX_ENVELOPE_BYTES });
          const staleDelivery = JSON.parse(decodeUtf8(stale.bytes));
          if (!ctoPendingObligationMatchesDelivery(state, input.entry_name, envelopeId, staleDelivery)) return null;
          pinnedRoot.removeFileIfMatches(path, { dev: stale.dev, ino: stale.ino, sha256: createHash("sha256").update(stale.bytes).digest("hex") });
          canonicalStatuses[index] = "absent";
        } catch {
          return null;
        }
      }
      if (canonicalStatuses[0] === "same" || canonicalStatuses[1] === "same") {
        try {
          if (!persistCtoRunOutboxPublicationAuthorityPinned(pinnedRoot, descriptor, true)) return null;
        } catch {
          return null;
        }
        rearmPendingDelivery(canonicalStatuses[1] === "same" ? "retry" : "outbox");
        return null;
      }
      const arbitraryQueueStatuses = [
        existingOutboxDirectoryEnvelopeStatus(pinnedRoot, ctoRunOutboxRelativePath(input.run_id), envelopeId, bytes),
        existingOutboxDirectoryEnvelopeStatus(pinnedRoot, join(".work-state", "cto", input.run_id, "outbox-retry"), envelopeId, bytes),
      ];
      if (arbitraryQueueStatuses.some((status) => status === "conflict")) return null;
      if (arbitraryQueueStatuses.some((status) => status === "same")) {
        try {
          if (!persistCtoRunOutboxPublicationAuthorityPinned(pinnedRoot, descriptor, true)) return null;
        } catch {
          return null;
        }
        rearmPendingDelivery(arbitraryQueueStatuses[1] === "same" ? "retry" : "outbox");
        return null;
      }
      if (input.legacy_entry_name && input.legacy_entry_name !== input.entry_name) {
        const legacyPaths = [
          ctoRunOutboxRelativePath(input.run_id, input.legacy_entry_name),
          join(".work-state", "cto", input.run_id, "outbox-retry", input.legacy_entry_name),
        ];
        const legacyStatuses = legacyPaths.map((path) => existingOutboxPathStatus(pinnedRoot, path, envelopeId, bytes));
        if (legacyStatuses[0] === "same" || legacyStatuses[1] === "same") {
          try {
            if (!persistCtoRunOutboxPublicationAuthorityPinned(pinnedRoot, descriptor, true)) return null;
          } catch {
            return null;
          }
          rearmPendingDelivery(legacyStatuses[1] === "same" ? "retry" : "outbox");
          return null;
        }
      }
      const relativeOutboxPath = ctoRunOutboxRelativePath(input.run_id, input.entry_name);
      const removeOwnPublication = (expectedBytes: Buffer = bytes): void => {
        try {
          const written = pinnedRoot.readFile(relativeOutboxPath, { maxBytes: MAX_CTO_OUTBOX_ENVELOPE_BYTES });
          if (durableEnvelopeId(Buffer.from(written.bytes)) === envelopeId && Buffer.from(written.bytes).equals(expectedBytes)) {
            pinnedRoot.removeFileIfMatches(relativeOutboxPath, { dev: written.dev, ino: written.ino, sha256: createHash("sha256").update(written.bytes).digest("hex") });
          }
        } catch {
          // A concurrent publisher may already have replaced the staged file.
        }
      };
      const refreshAfterDrift = (): boolean => {
        const latestState = readCtoStatePinned(input.run_id, pinnedRoot);
        const latestIndex = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
        if (!latestState || !latestIndex.valid || !latestIndex.observed) return false;
        if (!ctoPendingObligationMatchesDelivery(latestState, input.entry_name, envelopeId, delivery)) return false;
        if (!canonicalizeObligationForState(latestState)) return false;
        state = latestState;
        current = latestIndex;
        entry = current.index.entries.find((candidate) => candidate.run_id === input.run_id);
        if (!entry) return false;
        const descriptorBase = {
          entry_name: input.entry_name,
          envelope_id: envelopeId,
          state_revision: input.state_revision,
          bytes_length: bytes.byteLength,
          bytes_sha256: createHash("sha256").update(bytes).digest("hex"),
          routing_config_sha256: routingBinding.config_sha256,
          routing_snapshot_sha256: routingBinding.snapshot_sha256,
          routing_channel: routingBinding.channel,
          routing_target: routingBinding.target,
        };
        descriptor = { ...descriptorBase, proof: ctoOutboxPublicationProof(pinnedRoot, input.run_id, descriptorBase, delivery as Record<string, unknown>) };
        return true;
      };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          pinnedRoot.writeExclusive(relativeOutboxPath, bytes);
        } catch (error) {
          if (pinnedStateErrorCode(error) === "exists" || pinnedStateErrorCode(error) === "not_regular") return null;
          throw error;
        }
        let authorityPersisted = false;
        try {
          authorityPersisted = persistCtoRunOutboxPublicationAuthorityPinned(pinnedRoot, descriptor, true);
        } catch {
          authorityPersisted = false;
        }
        if (!authorityPersisted) {
          removeOwnPublication();
          return null;
        }
        // Optimistic barrier: state-owned obligations may advance while this
        // publisher is between authority and index CAS. Rebind and retry only
        // when the exact obligation survives; replacement/disappearance is a
        // hard reject, never a falsely-current publication.
        const latestState = readCtoStatePinned(input.run_id, pinnedRoot);
        const latestIndex = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
        const latestEntry = latestIndex.index.entries.find((candidate) => candidate.run_id === input.run_id);
        if (!latestState || !latestIndex.valid || !latestIndex.observed || !latestEntry
          || latestState.state_revision !== input.state_revision
          || latestEntry.state_revision !== input.state_revision) {
          const stagedBytes = bytes;
          removeOwnPublication(stagedBytes);
          if (!latestState || !ctoPendingObligationMatchesDelivery(latestState, input.entry_name, envelopeId, delivery)
            || !refreshAfterDrift()) return null;
          continue;
        }
        const pendingEntry: CtoRunDeliveryIndexEntry = { ...entry, state_revision: input.state_revision, pending_outbox: true, updated_at: state.updated_at, summary_digest: ctoRunDeliverySummaryDigest(state) };
        const nextEntries = boundedRunDeliveryEntries(current.index.entries.map((candidate) => candidate.run_id === input.run_id ? pendingEntry : candidate));
        const next: CtoRunDeliveryIndex = { schema_version: 2, active_run_id: latestActiveRunId(nextEntries), entries: nextEntries };
        findCtoRunDeliveryHook(pinnedRoot, root)?.beforePendingMark?.({ root, run_id: input.run_id, entry_name: input.entry_name });
        const preimage = writeCtoRunDeliveryIndexPreimagePinned(pinnedRoot, input.run_id, current);
        try {
          persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed);
          clearCtoRunDeliveryIndexPreimagePinned(pinnedRoot, input.run_id, preimage);
        } catch {
          removeOwnPublication();
          return null;
        }
        findCtoRunDeliveryHook(pinnedRoot, root)?.afterPendingMark?.({ root, run_id: input.run_id, entry_name: input.entry_name });
        const verifiedState = readCtoStatePinned(input.run_id, pinnedRoot);
        const verifiedIndex = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
        const verifiedEntry = verifiedIndex.index.entries.find((candidate) => candidate.run_id === input.run_id);
        if (verifiedState?.state_revision === input.state_revision && verifiedEntry?.state_revision === input.state_revision) {
          return join(pinnedRoot.canonical_root, relativeOutboxPath);
        }
        const stagedBytes = bytes;
        removeOwnPublication(stagedBytes);
        if (!verifiedState || !ctoPendingObligationMatchesDelivery(verifiedState, input.entry_name, envelopeId, delivery) || !refreshAfterDrift()) return null;
      }
      removeOwnPublication();
      return null;
    }, { pinnedRoot });
  } finally {
    if (!providedRoot) pinnedRoot.close();
  }
}


/** Acknowledge drained delivery work and clear/remove its exact indexed entry. */
export function acknowledgeCtoRunDelivery(root: string, runId: string, expectedRevision: number, options: { drained: true }, providedRoot?: PinnedProjectRoot, capability?: unknown): boolean {
  if (!isCtoRuntimeDeliveryCapability(capability)) return false;
  if (!isSafeCtoRunId(runId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || options?.drained !== true) return false;
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return false;
  try {
    return withCtoStateWriteLock(pinnedRoot.canonical_root, CTO_RUN_DELIVERY_INDEX_LOCK_ID, () => {
      recoverCtoRunDeliveryIndexLocked(pinnedRoot);
      const current = readCtoRunDeliveryIndexSnapshotPinned(pinnedRoot);
      const entry = current.index.entries.find((candidate) => candidate.run_id === runId);
      const state = readCtoStatePinned(runId, pinnedRoot);
      if (!entry || !current.valid || !current.observed || !state || state.id !== runId || !hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state) || state.state_revision !== expectedRevision || entry.state_revision !== expectedRevision) return false;
      if ((state.pending_delivery_obligations?.length ?? 0) > 0) return false;
      const status = ctoRunDeliveryStatus(state);
      if (status !== entry.status || !ctoRunOutboxEmptyPinned(pinnedRoot, runId)) return false;
      if (isTerminalDeliveryStatus(status) && !terminalSummaryDeliveredPinned(pinnedRoot, state)) return false;
      const acknowledgedEntries = current.index.entries.map((candidate) => candidate.run_id === runId
        ? { ...candidate, pending_summary: false, pending_outbox: false, pending_retry: false }
        : candidate);
      const entries = compactCtoRunDeliveryEntries(acknowledgedEntries);
      const next: CtoRunDeliveryIndex = { schema_version: 2, active_run_id: latestActiveRunId(entries), entries };
      if (!current.observed) return false;
      const preimage = writeCtoRunDeliveryIndexPreimagePinned(pinnedRoot, runId, current);
      try {
        persistCtoRunDeliveryIndexPinned(pinnedRoot, next, current.observed);
        clearCtoRunDeliveryIndexPreimagePinned(pinnedRoot, runId, preimage);
      } catch {
        return false;
      }
      return true;
    }, { pinnedRoot });
  } finally {
    if (!providedRoot) pinnedRoot.close();
  }
}

export class CtoStateConflictError extends Error {
  readonly code = "CTO_STATE_CONFLICT";
  readonly expectedRevision: number;
  readonly actualRevision: number | undefined;

  constructor(runId: string, expectedRevision: number, actualRevision: number | undefined) {
    const actual = actualRevision === undefined ? "absent" : String(actualRevision);
    super(`CTO_STATE_CONFLICT: CTO run '${runId}' expected state revision ${expectedRevision}, found ${actual}`);
    this.name = "CtoStateConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class CtoStateInvalidError extends Error {
  readonly code = "CTO_STATE_INVALID";

  constructor(message = "CTO state invalid before write") {
    super(`CTO_STATE_INVALID: ${message}`);
    this.name = "CtoStateInvalidError";
  }
}

interface CanonicalCtoStateRead {
  state: CtoState;
  bytes: Buffer;
  observed: { dev: number; ino: number; sha256: string };
}

function readCanonicalCtoState(path: string, pinnedRoot: PinnedProjectRoot, relativePath?: string): CanonicalCtoStateRead | null {
  if (!pinnedRoot.isStable()) throw new Error("pinned project root changed before CTO state read");
  try {
    const target = relativePath ?? pinnedRoot.relativePath(path);
    if (!target) throw new Error("CTO state path escapes the pinned project root");
    const read = pinnedRoot.readFile(target, { maxBytes: MAX_CTO_STATE_READ_BYTES });
    const bytes = Buffer.from(read.bytes);
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`CTO state target is not a JSON object: ${target}`);
    }
    const state = parsePersistedCtoState(parsed as Record<string, unknown>);
    return state ? {
      state,
      bytes,
      observed: { dev: read.dev, ino: read.ino, sha256: createHash("sha256").update(bytes).digest("hex") },
    } : null;
  } catch (error) {
    if (pinnedStateErrorCode(error) === "not_found") return null;
    throw error;
  }
}

function writeCtoRunDeliveryPublicationJournal(
  state: CtoState,
  root: string,
  stateRevision: number,
  stateBytes: string,
  pinnedRoot: PinnedProjectRoot,
  originTransition?: {
    prior: CtoRuntimeRunOriginHandoffRead;
    target: CtoState;
    indexPreimage: CtoRunDeliveryExactPreimage;
    proofPreimage: CtoRunDeliveryExactPreimage;
  },
): PinnedRootWriteReceipt {
  const stateSha256 = createHash("sha256").update(stateBytes).digest("hex");
  const transition = originTransition ? {
    index_preimage: {
      dev: originTransition.indexPreimage.dev,
      ino: originTransition.indexPreimage.ino,
      size: originTransition.indexPreimage.size,
      sha256: originTransition.indexPreimage.sha256,
    },
    proof_preimage: {
      dev: originTransition.proofPreimage.dev,
      ino: originTransition.proofPreimage.ino,
      size: originTransition.proofPreimage.size,
      sha256: originTransition.proofPreimage.sha256,
    },
    prior: {
      standby: true as const,
      owner_session: null,
      identity_sha256: originTransition.prior.identity_sha256,
      source_id: originTransition.prior.source_id,
      initial_state_sha256: originTransition.prior.initial_state_sha256,
    },
    target: {
      standby: false as const,
      owner_session: originTransition.target.owner_session as string,
      identity_sha256: ctoRuntimeRunInitialIdentityDigest(originTransition.target),
    },
  } : undefined;
  const transitionProof = transition ? ctoRunDeliveryTransitionProof(pinnedRoot, state.id, stateRevision, stateSha256, transition) : null;
  if (transition && !transitionProof) throw new PinnedRootError("recovery_required", "CTO transition journal authority unavailable");
  const authenticatedTransition = transition ? { ...transition, proof: transitionProof! } : undefined;
  const proof = ctoRunDeliveryJournalProof(pinnedRoot, state.id, stateRevision, stateSha256, authenticatedTransition);
  if (!proof) throw new PinnedRootError("recovery_required", "CTO publication journal authority unavailable");
  const serialized = JSON.stringify({
    schema_version: CTO_RUN_DELIVERY_JOURNAL_SCHEMA_VERSION,
    run_id: state.id,
    state_revision: stateRevision,
    state_sha256: stateSha256,
    proof,
    ...(authenticatedTransition ? { origin_transition: authenticatedTransition } : {}),
  }) + "\n";
  pinnedRoot.ensureDirectories([ctoRunDeliveryJournalDirectoryRelativePath()]);
  return pinnedRoot.writeAtomicWithReceipt(ctoRunDeliveryJournalRelativePath(state.id), serialized);
}

function clearCtoRunDeliveryPublicationJournal(
  root: string,
  runId: string,
  receipt: PinnedRootWriteReceipt,
  pinnedRoot?: PinnedProjectRoot,
): void {
  const path = ctoRunDeliveryJournalRelativePath(runId);
  const expected = {
    dev: receipt.descriptor.dev,
    ino: receipt.descriptor.ino,
    size: receipt.descriptor.size,
    sha256: receipt.descriptor.sha256,
  };
  const remove = (pin: PinnedProjectRoot): void => {
    try {
      pin.removeFileIfMatches(path, expected);
    } catch (error) {
      if (error instanceof PinnedRootError && (error.code === "changed" || error.code === "not_found")) {
        throw new PinnedRootError("recovery_required", "run-delivery publication journal " + path + " changed before exact cleanup");
      }
      throw error;
    }
  };
  if (pinnedRoot) {
    remove(pinnedRoot);
    return;
  }
  const pin = PinnedProjectRoot.open(root);
  if (!pin) throw new Error("run-delivery journal requires a pinnable project root");
  try {
    remove(pin);
  } finally {
    pin.close();
  }
}

export interface CtoStateWritePreCommitContext {
  pinnedRoot: PinnedProjectRoot;
  current: CtoState | null;
  candidate: CtoState;
}

/** Write one candidate while the canonical per-run state lock is held. */
export function writeCtoStateLocked(state: CtoState, root: string, options: { pinnedRoot?: PinnedProjectRoot; preCommit?: (context: CtoStateWritePreCommitContext) => void; originTransition?: { ownerSession: string } } = {}): string {
  assertCurrentExecutionLiveness();
  if (!isSafeCtoRunId(state?.id)) throw new Error("unsafe CTO run id");
  const pinnedRoot = options.pinnedRoot;
  if (!pinnedRoot) throw new Error("CTO state mutation requires a pinned project root");
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    throw new CtoStateInvalidError("CTO state writer root is not resolvable");
  }
  if (canonicalRoot !== pinnedRoot.canonical_root) {
    throw new CtoStateInvalidError("CTO state writer root does not match the pinned project root");
  }
  const relativePath = join(".work-state", "cto", state.id, "state.json");
  const path = join(pinnedRoot.canonical_root, relativePath);
  if (!pinnedRoot.isStable()) throw new Error("pinned project root changed before CTO state write");
  const expectedRevision = Number.isSafeInteger(state.state_revision) && (state.state_revision as number) >= 0
    ? state.state_revision as number
    : 0;
  const current = readCanonicalCtoState(path, pinnedRoot, relativePath);
  const actualRevision = current?.state.state_revision ?? (current === null ? undefined : 0);
  if (current !== null && current.state.id !== state.id) {
    throw new CtoStateConflictError(state.id, expectedRevision, actualRevision);
  }
  if (current === null) {
    if (expectedRevision !== 0) throw new CtoStateConflictError(state.id, expectedRevision, 0);
  } else if (actualRevision !== expectedRevision) {
    throw new CtoStateConflictError(state.id, expectedRevision, actualRevision);
  }
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`CTO state revision overflow for run '${state.id}'`);
  }

  const nextRevision = expectedRevision + 1;
  const updatedAt = new Date().toISOString();
  const candidate = { ...state, state_revision: nextRevision, updated_at: updatedAt } as Record<string, unknown>;
  if (!parsePersistedCtoState(candidate)) throw new CtoStateInvalidError();
  const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes > MAX_CTO_STATE_READ_BYTES) {
    throw new CtoStateInvalidError(`serialized state exceeds the ${MAX_CTO_STATE_READ_BYTES}-byte limit`);
  }
  // The journal is the recovery authority only for this exact candidate. It
  // must be durable before the state write so a process crash at either
  // atomic boundary leaves enough information to repair the index.
  const publication = (): string => {
    assertCurrentExecutionLiveness();
    // Capture proof authentication against the pre-CAS state/index image. A
    // standby-to-owned transition changes proof ownership only after state CAS;
    // the captured authenticated preimage authorizes that one journaled update.
    const transitionAuth = captureCtoRunDeliveryIndexTransitionAuthPinned(pinnedRoot, state.id);
    const priorOrigin = readCtoRuntimeRunOriginHandoffPinned(pinnedRoot, state.id);
    const candidateInitialDigest = ctoRuntimeRunInitialIdentityDigest(state);
    const identityChanged = priorOrigin !== null && priorOrigin.identity_sha256 !== candidateInitialDigest;
    const authorizedPromotion = identityChanged
      && priorOrigin?.standby === true
      && priorOrigin.owner_session === null
      && state.standby !== true
      && typeof state.owner_session === "string"
      && options.originTransition?.ownerSession === state.owner_session;
    if (identityChanged && !authorizedPromotion) {
      throw new PinnedRootError('recovery_required', 'CTO run origin identity transition is not authorized');
    }
    if (authorizedPromotion && (!transitionAuth.index || !transitionAuth.proof)) {
      throw new PinnedRootError('recovery_required', 'CTO promotion requires authenticated delivery index and proof preimages');
    }
    // The index lock spans journal publication, state.json, and index. This
    // prevents a reader from observing the short interval where the journal
    // exists but state.json has not committed yet and admitting a duplicate.
    const publicationJournalReceipt = writeCtoRunDeliveryPublicationJournal(
      state,
      root,
      nextRevision,
      serialized,
      pinnedRoot,
      authorizedPromotion && priorOrigin
        ? {
          prior: priorOrigin,
          target: candidate as unknown as CtoState,
          indexPreimage: transitionAuth.index!,
          proofPreimage: transitionAuth.proof!,
        }
        : undefined,
    );
    // Revalidate all external constitution-backed authorities at the final
    // state CAS boundary, after the latest canonical state read and before
    // wave history can become terminal. A failed guard leaves the durable
    // publication journal for the normal recovery path but never writes the
    // stale candidate state.
    options.preCommit?.({
      pinnedRoot,
      current: current?.state ?? null,
      candidate: candidate as unknown as CtoState,
    });
    if (!transitionPreimageStillMatches(pinnedRoot, state.id, transitionAuth)) {
      throw new PinnedRootError('changed', 'CTO delivery transition preimage changed before state CAS');
    }
    try {
      if (current === null) pinnedRoot.writeExclusive(relativePath, serialized);
      else pinnedRoot.replaceFileIfMatches(relativePath, current.observed, serialized);
    } catch (error) {
      if ((pinnedStateErrorCode(error) === "exists" || errnoCode(error) === "EEXIST") && current === null) {
        throw new CtoStateConflictError(state.id, expectedRevision, 0);
      }
      throw error;
    }
    // Keep the caller's object current so repeated in-process transitions carry
    // the latest CAS preimage instead of becoming stale after their first write.
    state.state_revision = nextRevision;
    state.updated_at = updatedAt;
    // State proof publication is part of the journal transaction. A crash
    // after state CAS therefore leaves an exact, recoverable postimage before
    // the delivery index can be considered authoritative.
    if (!writeCtoRuntimeStateProof(pinnedRoot, state) || !hasValidCtoRuntimeStateProofPinned(pinnedRoot, state)) {
      throw new PinnedRootError('recovery_required', 'CTO state proof publication failed; journal retained for recovery');
    }
    if (authorizedPromotion
      && priorOrigin
      && !refreshCtoRuntimeRunOriginPinned(pinnedRoot, state, options.originTransition!.ownerSession, priorOrigin.source_id, priorOrigin.initial_state_sha256)) {
      throw new PinnedRootError('recovery_required', 'CTO run origin transition failed; journal retained for recovery');
    }
    // Keep the index transition inside the per-run write lock so an older
    // active snapshot cannot be applied after a newer terminal transition.
    // Keeping this here also covers trusted callers that use the locked writer
    // directly for multi-artifact transactions.
    if (!exactPreimageStillMatches(pinnedRoot, ctoRunDeliveryIndexRelativePath(), transitionAuth.index, MAX_CTO_RUN_DELIVERY_INDEX_BYTES)
      || !exactPreimageStillMatches(pinnedRoot, join(".work-state", "cto", CTO_RUN_DELIVERY_INDEX_PROOF_FILE), transitionAuth.proof, 16 * 1024)) {
      throw new PinnedRootError('changed', 'CTO delivery index preimage changed after state CAS');
    }
    updateCtoRunDeliveryIndex(state, root, pinnedRoot, transitionAuth);
    // Clearing the journal is deliberately last. If this process dies while
    // clearing it, replay is idempotent and re-publishes the same exact entry.
    clearCtoRunDeliveryPublicationJournal(root, state.id, publicationJournalReceipt, pinnedRoot);
    assertCurrentExecutionLiveness();
    return path;
  };
  return withCtoStateWriteLock(
    pinnedRoot.canonical_root,
    CTO_RUN_DELIVERY_INDEX_LOCK_ID,
    publication,
    { pinnedRoot },
  );
}
export function writeCtoState(
  state: CtoState,
  root: string,
  options: { pinnedRoot?: PinnedProjectRoot; preCommit: (context: CtoStateWritePreCommitContext) => void },
): string {
  if (typeof options?.preCommit !== "function") throw new Error("CTO state write requires a preCommit callback");
  if (!isSafeCtoRunId(state?.id)) throw new Error("unsafe CTO run id");
  const pinnedRoot = options.pinnedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("CTO state mutation requires a pinnable project root");
  try {
    return withCtoRunLock(
      pinnedRoot.canonical_root,
      state.id,
      () => writeCtoStateLocked(state, pinnedRoot.canonical_root, { ...options, pinnedRoot }),
      { ...options, pinnedRoot },
    );
  } finally {
    if (!options.pinnedRoot) pinnedRoot.close();
  }
}
/**
 * Resolve the authoritative autonomous flag for a CTO run, model-first:
 * - `classification.autonomous` (the model's PHASE-0 decision) is the
 *   AUTHORITY whenever a classification is present — the top-level field
 *   can never override it (new state mirrors the classification, so the two
 *   agree by construction; a legacy file with both must honor the model).
 * - The top-level `autonomous` field is the fallback ONLY when the
 *   classification is absent: legacy runs and the engine-created standby
 *   exception (no user task, nothing to classify).
 */
export function resolveCtoAutonomous(state: Pick<CtoState, "classification" | "autonomous">): boolean {
  const model = state.classification?.autonomous;
  if (model !== undefined) return model;
  return state.autonomous;
}

function teamOf(state: CtoState, teamId: string): CtoState["teams"][number] | undefined {
  return state.teams.find((t) => t.id === teamId);
}

const WORK_IDENTITY_FIELDS: readonly (keyof WorkIdentity)[] = [
  "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id", "stage_cursor",
  "capability_id", "capability_epoch", "slot_id", "task_id", "dispatch_id", "attempt", "worker_id",
];

function sameWorkIdentity(left: WorkIdentity | undefined, right: WorkIdentity | undefined): boolean {
  if (!left || !right) return false;
  return WORK_IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

/**
 * Execution slices may only enter a terminal status after the exact current
 * dispatch has emitted its identity-bound terminal result. Legacy teams have no engine
 * work identity and retain their historical status transition semantics.
 */
function executionTeamCompletionValid(state: CtoState, team: CtoState["teams"][number], status: "done" | "failed"): boolean {
  const identity = team.work_identity;
  if (!identity) return true;
  if (identity.run_id !== state.id || (team.slice_id !== undefined && identity.slice_id !== team.slice_id)) return false;
  const envelope = team.completion_envelope;
  if (!envelope || envelope.outcome === "pending" || envelope.terminal_signal === null || envelope.terminal_signal === undefined) return false;
  if (!sameWorkIdentity(identity, envelope.identity)) return false;
  if (envelope.outcome !== (status === "done" ? "succeeded" : "failed")) return false;
  return validateTypedControlPlane({ work_identity: identity, completion_envelope: envelope }).ok;
}

/** Transition one team's run status in memory; persistence belongs to a trusted transaction. */
export function setTeamStatus(state: CtoState, teamId: string, status: TeamRunStatus): CtoState {
  if (!["pending", "in_progress", "parked", "done", "failed"].includes(status)) {
    throw new CtoStateInvalidError(`invalid team status '${String(status)}'`);
  }
  const apply = (current: CtoState): void => {
    const team = teamOf(current, teamId);
    if (!team) throw new CtoStateInvalidError(`unknown CTO team '${teamId}'`);
    if (team.work_identity && (team.status === "done" || team.status === "failed") && status !== team.status) {
      throw new CtoStateInvalidError(`execution team '${teamId}' has a terminal status and cannot reopen`);
    }
    if ((status === "done" || status === "failed") && !executionTeamCompletionValid(current, team, status)) {
      throw new CtoStateInvalidError(`execution team '${teamId}' lacks the current identity-bound terminal result`);
    }
    team.status = status;
  };
  apply(state);
  return state;
}

function validEscalationRecord(value: unknown): value is EscalationRecord {
  if (!objectHasExactKeys(value, ["status"], ["sent_at", "timeout_ms"])) return false;
  const candidate = value as Record<string, unknown>;
  return ["pending", "answered", "expired", "cancelled", "undelivered"].includes(String(candidate.status))
    && (candidate.sent_at === undefined || (typeof candidate.sent_at === "string" && isCanonicalCtoTimestamp(candidate.sent_at)))
    && (candidate.timeout_ms === undefined || (Number.isSafeInteger(candidate.timeout_ms) && (candidate.timeout_ms as number) >= 0));
}

/** Record an escalation for a team in memory; persistence belongs to a trusted transaction. */
export function setEscalation(
  state: CtoState,
  teamId: string,
  escId: string,
  record: EscalationRecord,
): CtoState {
  if (!isSafeCtoRunId(teamId)) throw new Error("invalid escalation team id");
  if (!isSafeCtoRunId(escId)) throw new Error("invalid escalation id");
  if (!validEscalationRecord(record)) throw new Error("invalid escalation record");
  const apply = (current: CtoState): void => {
    const team = teamOf(current, teamId);
    if (!team) return;
    if (!Object.hasOwn(team.escalations, escId) && Object.keys(team.escalations).length >= MAX_PERSISTED_STATE_KEYS) {
      throw new Error(`escalations exceed ${MAX_PERSISTED_STATE_KEYS} entries`);
    }
    team.escalations[escId] = { ...record };
  };
  apply(state);
  return state;
}

export function setEscalationStatus(
  state: CtoState,
  teamId: string,
  escId: string,
  status: EscalationStatus,
): CtoState {
  const apply = (current: CtoState): void => {
    const team = teamOf(current, teamId);
    const record = team?.escalations[escId];
    if (team && record) record.status = status;
  };
  apply(state);
  return state;
}

/** Mark the integration phase in memory; persistence belongs to a trusted transaction. */
export function setIntegration(
  state: CtoState,
  status: CtoState["integration"]["status"],
  note: string | undefined,
): CtoState {
  const apply = (current: CtoState): void => {
    current.integration = { status, note };
  };
  apply(state);
  return state;
}

export function setCtoPause(
  state: CtoState,
  kind: CtoState["pause"]["kind"],
  reason: string,
): CtoState {
  const apply = (current: CtoState): void => {
    current.pause = { kind, reason };
  };
  apply(state);
  return state;
}

/** Stamp a mid-run amendment (br-k19) in memory; persistence belongs to a trusted transaction. */
export function markAmended(state: CtoState): CtoState {
  const apply = (current: CtoState): void => {
    current.amended_at = new Date().toISOString();
  };
  apply(state);
  return state;
}

// ── Typed control-plane projection (schema-2 additive; cto-core owns writes) ──

function assertTypedControlPlane(value: unknown): void {
  const validation = validateTypedControlPlane(value);
  if (!validation.ok) {
    throw new Error(`invalid typed control-plane update: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
}

/** Existing lifecycle projections must remain bound to the current identity. */
function assertControlPlaneIdentityBinding(
  value: Pick<CtoControlPlaneFields, "work_identity" | "pending" | "completion_envelope">,
): void {
  const identity = value.work_identity;
  if (!identity) return;
  for (const [name, candidate] of [["pending", value.pending], ["completion_envelope", value.completion_envelope]] as const) {
    if (candidate && !sameWorkIdentity(identity, candidate.identity)) {
      throw new CtoStateInvalidError(`typed control-plane ${name} is stale for the current work identity`);
    }
  }
}

function assignDefined(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) target[key] = value;
  }
}

/**
 * Merge a contract-valid typed control-plane projection into run state;
 * performs no persistence; callers commit the returned in-memory state through a trusted transaction.
 * Undefined patch entries never erase an existing field. Validation runs BEFORE the merge so an invalid update
 * cannot poison persisted state — legacy autonomy/prose stays display input
 * and never becomes permission here.
 */
export function setCtoControlPlane(
  state: CtoState,
  fields: Partial<CtoControlPlaneFields>,
): CtoState {
  const apply = (current: CtoState): void => {
    const candidate = { ...current, ...fields };
    assertTypedControlPlane(candidate);
    assertControlPlaneIdentityBinding(candidate);
    assignDefined(current as unknown as Record<string, unknown>, fields as Record<string, unknown>);
  };
  apply(state);
  return state;
}

/**
 * Merge a contract-valid typed control-plane projection into ONE team slice
 * entry in memory. Same validation contract as setCtoControlPlane; persistence
 * belongs to a trusted transaction.
 */
export function setTeamControlPlane(
  state: CtoState,
  teamId: string,
  fields: Partial<Omit<CtoControlPlaneFields, "child_joins" | "migration" | "control_plane_provenance" | "control_plane_status">>,
): CtoState {
  const apply = (current: CtoState): boolean => {
    const team = teamOf(current, teamId);
    if (!team) return false;
    const candidate = { ...team, ...fields };
    assertTypedControlPlane(candidate);
    assertControlPlaneIdentityBinding(candidate);
    assignDefined(team as unknown as Record<string, unknown>, fields as Record<string, unknown>);
    return true;
  };
  apply(state);
  return state;
}

// ── Resident control-plane: wave lifecycle (schema-2 additive) ─────────────

/**
 * True when the run is a CTO resident: the standby marker makes a run
 * adoptable cross-session and keeps it ACTIVE after wave completion.
 * Pure check — `state.standby === true` (contract: resident marker).
 */
export function isCtoResident(state: Pick<CtoState, "standby">): boolean {
  return state.standby === true;
}

/** State-segment identity convention used by durable state paths and ids. */
function isSafeWaveSegment(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && /^[A-Za-z0-9._-]+$/.test(value);
}
const RESERVED_CTO_RUN_IDS = new Set(["active-run-index.json", CTO_RUN_DELIVERY_JOURNAL_DIRECTORY, ".standby-registry.lock", "__resident_cto__", "__constitution__", "__run-delivery-index__"]);
/**
 * Canonical identity predicate for CTO execution waves and durable mappings.
 * These ids share the state-segment alphabet, admit uppercase ASCII, and are
 * bounded to the same 128-character SAFE_ID contract as mounted inputs.
 */
export function isSafeCtoExecutionId(value: unknown): value is string {
  return isSafeWaveSegment(value) && value.length <= 128;
}
export function isSafeCtoRunId(value: unknown): value is string {
  return isSafeCtoExecutionId(value) && !RESERVED_CTO_RUN_IDS.has(value);
}

/** Derive a deterministic bounded id while preserving readable canonical ids when possible. */
export function deriveSafeCtoId(parts: readonly string[]): string {
  if (!Array.isArray(parts) || parts.length === 0 || parts.some((part) => typeof part !== "string")) {
    throw new Error("cannot derive CTO id from invalid parts");
  }
  const joined = parts.join("-");
  if (isSafeCtoRunId(joined)) return joined;
  const digest = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 24);
  const readable = String(joined).replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "id";
  const suffix = `-${digest}`;
  const prefixBytes = 128 - Buffer.byteLength(suffix, "utf8");
  const prefix = readable.slice(0, prefixBytes).replace(/-+$/u, "") || "id";
  const derived = `${prefix}${suffix}`;
  if (!isSafeCtoRunId(derived)) throw new Error("derived CTO id is not canonical");
  return derived;
}

/** Canonical team identity for one engine-owned specification-preparation request. */
export function ctoPreparationTeamId(requestId: string): string {
  if (typeof requestId !== "string" || requestId.length === 0) throw new Error("preparation request id is required");
  return deriveSafeCtoId(["preparation", requestId]);
}

function assertSafeWaveSegment(field: string, value: unknown): asserts value is string {
  if (!isSafeCtoRunId(value)) throw new Error(`invalid wave ${field}: must be a safe state segment`);
}

export function isValidCtoTaskText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_PERSISTED_STATE_STRING_BYTES;
}

export function isValidCtoBranchText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_PERSISTED_STATE_STRING_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function assertNonBlankWaveText(field: string, value: unknown, maxBytes = MAX_PERSISTED_STATE_STRING_BYTES): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid wave ${field}: must be a non-blank string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`invalid wave ${field}: exceeds ${maxBytes} UTF-8 bytes`);
  }
}

function validateWaveAdmission(opts: {
  id: string;
  source: string;
  source_id: string;
  task: string;
  slice_ids?: string[];
  work_identity?: WorkIdentity;
  now?: string;
}): void {
  assertSafeWaveSegment("id", opts.id);
  assertSafeWaveSegment("source", opts.source);
  assertSafeWaveSegment("source_id", opts.source_id);
  assertNonBlankWaveText("task", opts.task);
  if (opts.now !== undefined && !isCanonicalCtoTimestamp(opts.now)) {
    throw new Error("invalid wave now: must be a canonical UTC timestamp");
  }
  if (opts.slice_ids !== undefined) {
    if (!Array.isArray(opts.slice_ids)) throw new Error("invalid wave slice_ids: must be an array");
    const seenSliceIds = new Set<string>();
    for (const sliceId of opts.slice_ids) {
      assertSafeWaveSegment("slice_id", sliceId);
      if (seenSliceIds.has(sliceId)) throw new Error(`invalid wave slice_id '${sliceId}': duplicate slice id`);
      seenSliceIds.add(sliceId);
    }
  }
  if (opts.work_identity) assertTypedControlPlane({ work_identity: opts.work_identity });
}

/**
 * Admit a work wave (state_contract.wave_history). IDEMPOTENT on transport
 * `source_id`: when a record with the same `source_id` already exists the
 * state is returned UNCHANGED (no second record, `active_wave_id` untouched)
 * — a duplicate inbound message must never start a second wave. Otherwise the
 * record is appended with status "active" and `active_wave_id` is set.
 * Persists when a root is given (same pattern as setTeamStatus).
 */
export type AppendWaveOptions = {
  id: string;
  source: string;
  source_id: string;
  task: string;
  slice_ids?: string[];
  work_identity?: WorkIdentity;
  now?: string;
};
function waveAdmissionMatches(record: WaveRecord, opts: AppendWaveOptions): boolean {
  return record.id === opts.id
    && record.source === opts.source
    && record.source_id === opts.source_id
    && record.task === opts.task
    && JSON.stringify(record.slice_ids) === JSON.stringify(opts.slice_ids ?? [])
    && JSON.stringify(record.work_identity) === JSON.stringify(opts.work_identity);
}

/**
 * Pure state transition for admitting a work wave. Persistence belongs to the
 * run-lock adapter; this function never accepts a filesystem root or performs
 * I/O. Duplicate source ids are idempotent and return the original state.
 */
export function applyAppendWaveTransition(state: CtoState, opts: AppendWaveOptions): CtoState {
  if (isCtoRunTerminal(state)) throw new Error("cannot append wave to a terminal CTO run");
  validateWaveAdmission(opts);
  assertWaveAuthority(state);
  const history = state.wave_history ?? [];
  assertWaveHistoryAuthority(history);
  const idMatches = history.filter((wave) => wave.id === opts.id);
  if (idMatches.length > 1) {
    throw new Error(`ambiguous wave id '${opts.id}': multiple history records`);
  }
  const sourceMatches = history.filter((wave) => wave.source_id === opts.source_id);
  if (sourceMatches.length > 1) {
    throw new Error(`ambiguous wave source_id '${opts.source_id}': multiple history records`);
  }
  if (sourceMatches.length === 1) {
    if (!waveAdmissionMatches(sourceMatches[0]!, opts)) {
      throw new Error(`wave source_id '${opts.source_id}' replay does not match the admitted wave`);
    }
    return state;
  }
  if (idMatches.length === 1) {
    throw new Error(`wave id '${opts.id}' is already used by a different source_id`);
  }
  if (history.length >= MAX_PERSISTED_STATE_ARRAY) {
    throw new Error(`wave history exceeds ${MAX_PERSISTED_STATE_ARRAY} entries`);
  }
  if (state.active_wave_id !== undefined || history.some((wave) => wave.status === "active")) {
    throw new Error("cannot append wave while another wave is active");
  }

  const record: WaveRecord = {
    id: opts.id,
    source: opts.source,
    source_id: opts.source_id,
    task: opts.task,
    slice_ids: opts.slice_ids ?? [],
    status: "active",
    started_at: opts.now ?? new Date().toISOString(),
    ...(opts.work_identity ? { work_identity: opts.work_identity } : {}),
  };
  return {
    ...state,
    wave_history: [...history, record],
    active_wave_id: opts.id,
  };
}

/**
 * Close a wave: stamp `finished_at` + status ("done" | "failed") and clear
 * `active_wave_id` when it points at this wave. Unknown id → return unchanged
 * (never throws). Repeating a terminal status is idempotent; switching a
 * finalized wave to the other terminal status is rejected. The run itself
 * stays active when resident — the resident carve-out lives in
 * isCtoRunTerminal. Persists when a root is given.
 */
export type FinishWaveOptions = {
  id: string;
  status: "done" | "failed";
  now?: string;
  /** Optional terminal aggregate for a specification-execution wave. */
  outcome?: "pass" | "blocked";
  blocked_feature_ids?: string[];
  findings?: string[];
};

export function applyFinishWaveTransition(state: CtoState, opts: FinishWaveOptions): CtoState {
  assertSafeWaveSegment("id", opts.id);
  if (opts.status !== "done" && opts.status !== "failed") {
    throw new Error(`invalid wave status for '${opts.id}': must be done or failed`);
  }
  if (opts.outcome !== undefined && opts.outcome !== "pass" && opts.outcome !== "blocked") {
    throw new Error(`invalid wave outcome for '${opts.id}': must be pass or blocked`);
  }
  if (opts.now !== undefined && !isCanonicalCtoTimestamp(opts.now)) {
    throw new Error("invalid wave now: must be a canonical UTC timestamp");
  }
  assertWaveAuthority(state);
  const history = state.wave_history ?? [];
  const matches = history.filter((wave) => wave.id === opts.id);
  if (matches.length > 1) {
    throw new Error(`ambiguous wave id '${opts.id}': multiple history records`);
  }
  const record = matches[0];
  if (!record) return state;
  if (record.source === "specification-execution") {
    throw new Error("raw wave transition rejects specification-execution; use the authoritative CTO close command");
  }
  if (record.status !== "active") {
    if (record.status === opts.status) return state;
    throw new Error(`invalid wave status transition for '${opts.id}': ${record.status} -> ${opts.status}`);
  }
  if (opts.blocked_feature_ids !== undefined) {
    if (!Array.isArray(opts.blocked_feature_ids) || opts.blocked_feature_ids.length > 64
      || new Set(opts.blocked_feature_ids).size !== opts.blocked_feature_ids.length) throw new Error(`invalid wave blocked_feature_ids for '${opts.id}'`);
    for (const featureId of opts.blocked_feature_ids) {
      if (!isSafeFeatureId(featureId)) throw new Error(`invalid wave blocked_feature_id for '${opts.id}'`);
    }
  }
  if (opts.findings !== undefined) {
    if (!Array.isArray(opts.findings) || opts.findings.length > 128) throw new Error(`invalid wave findings for '${opts.id}'`);
    for (const finding of opts.findings) {
      if (typeof finding !== "string" || finding.trim().length === 0 || Buffer.byteLength(finding, "utf8") > 4096) throw new Error(`invalid wave finding for '${opts.id}'`);
    }
  }
  const finishedAt = opts.now ?? new Date().toISOString();
  const recordUpdate: WaveRecord = {
    ...record,
    status: opts.status,
    finished_at: finishedAt,
    ...(opts.outcome !== undefined ? { outcome: opts.outcome } : {}),
    ...(opts.blocked_feature_ids !== undefined ? { blocked_feature_ids: [...opts.blocked_feature_ids] } : {}),
    ...(opts.findings !== undefined ? { findings: [...opts.findings] } : {}),
  };
  const next: CtoState = {
    ...state,
    wave_history: history.map((wave) => wave.id === opts.id ? recordUpdate : wave),
  };
  if (next.active_wave_id === opts.id) delete next.active_wave_id;
  return next;
}

/**
 * The currently running wave: the wave_history record with status "active"
 * whose id matches `active_wave_id`. No active_wave_id or ambiguous id → null.
 */
export function activeWave(state: CtoState): WaveRecord | null {
  const activeId = state.active_wave_id;
  if (!isSafeCtoRunId(activeId)) return null;
  const matches = (state.wave_history ?? []).filter((wave) => wave.id === activeId);
  if (matches.length !== 1) return null;
  return matches[0]?.status === "active" ? matches[0] : null;
}

/** Find a wave record by its transport source_id (dedup / admission lookup). */
export function findWaveBySourceId(state: CtoState, sourceId: string): WaveRecord | null {
  if (!isSafeCtoRunId(sourceId)) return null;
  const matches = (state.wave_history ?? []).filter((wave) => wave.source_id === sourceId);
  if (matches.length !== 1) return null;
  const match = matches[0];
  return match ?? null;
}

/**
 * Expire pending escalations whose timeout elapsed. `timeout_ms: 0`/absent
 * (blocker default) never expires — the team stays parked and the rest of
 * the run continues (interview Q4). Returns the expired escalation ids.
 */
export function expireEscalations(state: CtoState, now: number): string[] {
  const expired: string[] = [];
  for (const team of state.teams) {
    for (const [escId, record] of Object.entries(team.escalations)) {
      const timeoutMs = record.timeout_ms ?? 0;
      if (record.status !== "pending" || timeoutMs <= 0 || !record.sent_at) continue;
      if (now - Date.parse(record.sent_at) >= timeoutMs) {
        record.status = "expired";
        expired.push(escId);
      }
    }
  }
  return expired;
}

/** All pending escalations across ACTIVE teams (for adapter re-send on session start, R7). */
export function pendingEscalations(state: CtoState): Array<{ teamId: string; escId: string; record: EscalationRecord }> {
  const out: Array<{ teamId: string; escId: string; record: EscalationRecord }> = [];
  for (const team of state.teams) {
    if (team.status !== "pending" && team.status !== "in_progress" && team.status !== "parked") continue;
    for (const [escId, record] of Object.entries(team.escalations)) {
      if (record.status === "pending") out.push({ teamId: team.id, escId, record });
    }
  }
  return out;
}

/** Teams not yet finished (pending | in_progress | parked). */
export function activeTeams(state: CtoState): string[] {
  return state.teams.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "parked").map((t) => t.id);
}

/**
 * True when the run is finished and must not be selected as active (RC5).
 * A run is terminal when its pause is done/failed, or when ALL teams are
 * done/failed AND integration is done — even when the pause was never
 * stamped done/failed (e.g. runs whose wave completed through the engine
 * without a pause transition).
 *
 * Resident carve-out (state_contract.resident): an explicit stop/failure
 * (pause done/failed) is ALWAYS terminal — the first check — but a run with
 * `standby: true` (the CTO resident marker) stays ACTIVE after wave
 * completion: teams done + integration done only closes the wave, the
 * resident run returns to standby and awaits the next inbox task. Non-resident
 * runs keep the legacy terminality verbatim.
 *
 * Legacy/non-canonical state may lack `pause` entirely (pre-pause writers;
 * migrateCtoState does not default it). Missing pause is NOT terminal by
 * itself — only the integration/team conditions below can prove terminality.
 */
export function isCtoRunTerminal(state: CtoState): boolean {
  const pauseKind = state.pause?.kind;
  if (pauseKind === "done" || pauseKind === "failed") return true;
  if (state.standby === true) return false; // resident run stays active after wave completion
  if (state.integration?.status === "done") {
    return state.teams.every((t) => t.status === "done" || t.status === "failed");
  }
  return false;
}
