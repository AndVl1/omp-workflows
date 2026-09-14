/**
 * Typed artifact I/O. Stages declare `consumes` and `produces` artifact ids;
 * the engine reads/writes them under `.work-state/artifacts/<id>.json` (or per-feature
 * subdir, set by `state.ts`).
 *
 * The schema is the same as claude-plugin's `workflows/artifacts-schema.json`.
 * Storage remains the only persistence mechanism here; specification conformance
 * adds authorization and current-byte checks before accepting stored references.
 */

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { CompletionArtifactRef } from "./types.js";
import { PinnedProjectRoot, PinnedRootError, type PinnedRootWriteReceipt } from "../specification/pinned-root.js";
import { canonicalJson } from "../specification/validation.js";

const ARTIFACT_ID_RE = /^[A-Za-z0-9._-]+$/;
/** Maximum UTF-8 bytes accepted for one serialized artifact payload. */
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
/** Maximum UTF-8 bytes accepted across one exact TaskResult artifact set. */
export const MAX_ARTIFACT_AGGREGATE_BYTES = 8 * 1024 * 1024;

/** Shared structural limits for every parsed or directly supplied artifact value. */
export const ARTIFACT_STRUCTURE_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 50_000,
  maxKeys: 16_384,
  maxArrayItems: 16_384,
  maxStringBytes: 1 * 1024 * 1024,
  maxAggregateStringBytes: 4 * 1024 * 1024,
  maxWork: 32 * 1024 * 1024,
});
/** O_NOFOLLOW where the platform provides it (0 where it does not). */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
/** Keep a FIFO posing as an artifact from blocking the bounded read. */
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

export interface ArtifactStructureBudget {
  nodes: number;
  keys: number;
  stringBytes: number;
  work: number;
}

export function createArtifactStructureBudget(): ArtifactStructureBudget {
  return { nodes: 0, keys: 0, stringBytes: 0, work: 0 };
}

export type ArtifactStructureFailureCode =
  | "depth"
  | "nodes"
  | "keys"
  | "array"
  | "string"
  | "aggregate"
  | "work"
  | "bytes"
  | "cycle"
  | "unsupported";

export type ArtifactStructureValidationResult =
  | { ok: true }
  | { ok: false; code: ArtifactStructureFailureCode; error: string };

interface ArtifactStructureFrame {
  value: unknown;
  depth: number;
  exit?: boolean;
}

/**
 * Validate a JSON-compatible value without recursion. The optional budget is
 * mutable so callers such as fan-in can enforce one aggregate cap across
 * several independently parsed slot values.
 */
export function validateArtifactStructure(
  value: unknown,
  budget: ArtifactStructureBudget = createArtifactStructureBudget(),
): ArtifactStructureValidationResult {
  const active = new WeakSet<object>();
  const stack: ArtifactStructureFrame[] = [{ value, depth: 0 }];
  const fail = (code: ArtifactStructureFailureCode, message: string): ArtifactStructureValidationResult => ({
    ok: false,
    code,
    error: `artifact structure limit exceeded: ${message}`,
  });
  const accountString = (input: string): ArtifactStructureValidationResult => {
    const bytes = Buffer.byteLength(input, "utf8");
    if (bytes > ARTIFACT_STRUCTURE_LIMITS.maxStringBytes) {
      return fail("string", `string exceeds ${ARTIFACT_STRUCTURE_LIMITS.maxStringBytes} bytes`);
    }
    budget.stringBytes += bytes;
    budget.work += bytes;
    if (budget.stringBytes > ARTIFACT_STRUCTURE_LIMITS.maxAggregateStringBytes) {
      return fail("aggregate", `aggregate strings exceed ${ARTIFACT_STRUCTURE_LIMITS.maxAggregateStringBytes} bytes`);
    }
    if (budget.work > ARTIFACT_STRUCTURE_LIMITS.maxWork) {
      return fail("work", `work budget exceeds ${ARTIFACT_STRUCTURE_LIMITS.maxWork}`);
    }
    return { ok: true };
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      if (frame.value && typeof frame.value === "object") active.delete(frame.value);
      continue;
    }
    if (frame.depth > ARTIFACT_STRUCTURE_LIMITS.maxDepth) {
      return fail("depth", `nesting depth exceeds ${ARTIFACT_STRUCTURE_LIMITS.maxDepth}`);
    }
    budget.nodes += 1;
    budget.work += 1;
    if (budget.nodes > ARTIFACT_STRUCTURE_LIMITS.maxNodes) {
      return fail("nodes", `node count exceeds ${ARTIFACT_STRUCTURE_LIMITS.maxNodes}`);
    }
    if (budget.work > ARTIFACT_STRUCTURE_LIMITS.maxWork) {
      return fail("work", `work budget exceeds ${ARTIFACT_STRUCTURE_LIMITS.maxWork}`);
    }
    if (typeof frame.value === "string") {
      const result = accountString(frame.value);
      if (!result.ok) return result;
      continue;
    }
    if (typeof frame.value === "number" && !Number.isFinite(frame.value)) {
      return fail("unsupported", "non-finite number is not valid JSON");
    }
    if (frame.value === null || typeof frame.value !== "object") {
      if (typeof frame.value === "bigint" || typeof frame.value === "function" || typeof frame.value === "symbol" || frame.value === undefined) {
        return fail("unsupported", `${typeof frame.value} is not valid JSON`);
      }
      continue;
    }
    if (active.has(frame.value)) return fail("cycle", "cyclic value is not supported");
    const prototype = Object.getPrototypeOf(frame.value);
    if (Array.isArray(frame.value)) {
      const array = frame.value;
      if (prototype !== Array.prototype) return fail("unsupported", "array has a non-standard prototype");
      if (array.length > ARTIFACT_STRUCTURE_LIMITS.maxArrayItems) {
        return fail("array", `array length exceeds ${ARTIFACT_STRUCTURE_LIMITS.maxArrayItems}`);
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      return fail("unsupported", "object has a non-standard prototype");
    }
    if (Object.getOwnPropertySymbols(frame.value).some((symbol) => Object.prototype.propertyIsEnumerable.call(frame.value, symbol))) {
      return fail("unsupported", "symbol keys are not valid JSON");
    }
    active.add(frame.value);
    stack.push({ value: frame.value, depth: frame.depth, exit: true });
    if (Array.isArray(frame.value)) {
      const array = frame.value;
      const keys = Object.keys(array);
      if (keys.length !== array.length || keys.some((key) => !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= array.length)) {
        return fail("unsupported", "array must contain only contiguous data items");
      }
      budget.work += array.length;
      if (budget.work > ARTIFACT_STRUCTURE_LIMITS.maxWork) return fail("work", `work budget exceeds ${ARTIFACT_STRUCTURE_LIMITS.maxWork}`);
      for (let index = array.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
        if (!descriptor || !("value" in descriptor)) return fail("unsupported", `array item ${index} is not a data property`);
        stack.push({ value: descriptor.value, depth: frame.depth + 1 });
      }
      continue;
    }
    const keys = Object.keys(frame.value);
    budget.keys += keys.length;
    budget.work += keys.length;
    if (budget.keys > ARTIFACT_STRUCTURE_LIMITS.maxKeys) return fail("keys", `object key count exceeds ${ARTIFACT_STRUCTURE_LIMITS.maxKeys}`);
    if (budget.work > ARTIFACT_STRUCTURE_LIMITS.maxWork) return fail("work", `work budget exceeds ${ARTIFACT_STRUCTURE_LIMITS.maxWork}`);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      const keyResult = accountString(key);
      if (!keyResult.ok) return keyResult;
      const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
      if (!descriptor || !("value" in descriptor)) return fail("unsupported", `property '${key}' is not a data property`);
      stack.push({ value: descriptor.value, depth: frame.depth + 1 });
    }
  }
  return { ok: true };
}

export class ArtifactStructureError extends Error {
  readonly code: ArtifactStructureFailureCode;

  constructor(result: Extract<ArtifactStructureValidationResult, { ok: false }>) {
    super(result.error);
    this.name = "ArtifactStructureError";
    this.code = result.code;
  }
}

function assertArtifactId(id: string): void {
  if (!ARTIFACT_ID_RE.test(id) || id === "." || id === "..") {
    throw new Error(`unsafe artifact id: ${id}`);
  }
}
export type ArtifactJsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; kind: "encoding"; reason: string }
  | { ok: false; kind: "malformed"; reason: string }
  | { ok: false; kind: "structure-limit"; code: ArtifactStructureFailureCode; reason: string };

/** Parse one JSON payload and immediately apply the shared structure bounds. */
export function parseArtifactJson(input: string | Buffer): ArtifactJsonParseResult {
  let raw: string;
  if (typeof input === "string") {
    raw = input;
  } else {
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return { ok: false, kind: "encoding", reason: "artifact payload is not valid UTF-8" };
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, kind: "malformed", reason: "artifact payload is not valid JSON" };
  }
  const structure = validateArtifactStructure(value);
  return structure.ok
    ? { ok: true, value }
    : { ok: false, kind: "structure-limit", code: structure.code, reason: structure.error };
}

function assertArtifactStructure(value: unknown): void {
  const result = validateArtifactStructure(value);
  if (!result.ok) throw new ArtifactStructureError(result);
}

function artifactStructureFailure(code: ArtifactStructureFailureCode, error: string): ArtifactStructureError {
  return new ArtifactStructureError({ ok: false, code, error });
}

function serializedArtifactBody(id: string, value: unknown): { body: string; bytes: number } {
  assertArtifactStructure(value);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw artifactStructureFailure("bytes", `artifact "${id}" exceeds the ${MAX_ARTIFACT_BYTES}-byte persisted payload limit`);
  }
  return { body, bytes };
}

function parseReturnedArtifact(id: string, value: unknown): unknown {
  if (typeof value !== "string") {
    assertArtifactStructure(value);
    return value;
  }
  const rawBytes = Buffer.byteLength(value, "utf8");
  if (rawBytes > MAX_ARTIFACT_BYTES) {
    throw artifactStructureFailure("bytes", `artifact "${id}" exceeds the ${MAX_ARTIFACT_BYTES}-byte returned payload limit`);
  }
  const parsed = parseArtifactJson(value);
  if (!parsed.ok) {
    if (parsed.kind === "structure-limit") {
      throw new ArtifactStructureError({
        ok: false,
        code: parsed.code,
        error: `artifact "${id}" ${parsed.reason}`,
      });
    }
    throw new Error(`artifact "${id}" is not valid JSON`);
  }
  return parsed.value;
}

function assertArtifactManifest(artifacts: Record<string, unknown>): readonly string[] {
  if (artifacts === null || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw artifactStructureFailure("unsupported", "returned artifacts must be a plain object manifest");
  }
  const prototype = Object.getPrototypeOf(artifacts);
  if (prototype !== Object.prototype && prototype !== null) {
    throw artifactStructureFailure("unsupported", "returned artifacts must be a plain object manifest");
  }
  if (Object.getOwnPropertySymbols(artifacts).some((symbol) => Object.prototype.propertyIsEnumerable.call(artifacts, symbol))) {
    throw artifactStructureFailure("unsupported", "returned artifact manifest cannot contain symbol keys");
  }
  const ids = Object.keys(artifacts);
  if (ids.length > ARTIFACT_STRUCTURE_LIMITS.maxKeys) {
    throw artifactStructureFailure("keys", `returned artifact manifest contains more than ${ARTIFACT_STRUCTURE_LIMITS.maxKeys} entries`);
  }
  for (const id of ids) {
    if (Buffer.byteLength(id, "utf8") > ARTIFACT_STRUCTURE_LIMITS.maxStringBytes) {
      throw artifactStructureFailure("string", `artifact id exceeds ${ARTIFACT_STRUCTURE_LIMITS.maxStringBytes} bytes`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(artifacts, id);
    if (!descriptor || !("value" in descriptor)) {
      throw artifactStructureFailure("unsupported", `artifact manifest entry '${id}' is not a data property`);
    }
  }
  return ids;
}

interface PreparedArtifactWrite {
  id: string;
  body: string;
  bytes: number;
}

function prepareReturnedArtifacts(artifacts: Record<string, unknown>): PreparedArtifactWrite[] {
  const ids = assertArtifactManifest(artifacts);
  const prepared: PreparedArtifactWrite[] = [];
  let aggregateReturnedBytes = 0;
  let aggregatePersistedBytes = 0;
  for (const id of ids) {
    assertArtifactId(id);
    const value = (Object.getOwnPropertyDescriptor(artifacts, id) as PropertyDescriptor).value;
    const returnedBytes = typeof value === "string"
      ? Buffer.byteLength(value, "utf8")
      : undefined;
    const parsed = parseReturnedArtifact(id, value);
    if (returnedBytes !== undefined) {
      aggregateReturnedBytes += returnedBytes;
      if (aggregateReturnedBytes > MAX_ARTIFACT_AGGREGATE_BYTES) {
        throw artifactStructureFailure("aggregate", `returned artifact payloads exceed the ${MAX_ARTIFACT_AGGREGATE_BYTES}-byte aggregate limit`);
      }
    }
    const serialized = serializedArtifactBody(id, parsed);
    aggregatePersistedBytes += serialized.bytes;
    if (aggregatePersistedBytes > MAX_ARTIFACT_AGGREGATE_BYTES) {
      throw artifactStructureFailure("aggregate", `persisted artifact payloads exceed the ${MAX_ARTIFACT_AGGREGATE_BYTES}-byte aggregate limit`);
    }
    prepared.push({ id, ...serialized });
  }
  return prepared;
}

/**
 * Persist a prevalidated returned-artifact manifest through a descriptor-anchored root.
 * Every target path is validated before the first write; a later failure rolls back
 * already-published files in reverse order using descriptor-bound receipts.
 */
export function persistReturnedArtifactsPinned(
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
  artifacts: Record<string, unknown>,
): string[] {
  const prepared = prepareReturnedArtifacts(artifacts);
  if (prepared.length === 0) return [];
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before returned artifact persistence");
  const paths = prepared.map(({ id }) => pinnedArtifactPath(artifactsDirRelative, id));
  pinnedRoot.ensureDirectory(artifactsDirRelative);
  const rollbackTokens: ArtifactAtomicWriteRollbackToken[] = [];
  try {
    for (let index = 0; index < prepared.length; index += 1) {
      const receipt = pinnedRoot.writeAtomicWithReceipt(paths[index]!, prepared[index]!.body);
      rollbackTokens.push(artifactAtomicWriteRollbackTokenFromReceipt(pinnedRoot, paths[index]!, receipt));
    }
    return prepared.map(({ id }) => id);
  } catch (error) {
    for (let index = rollbackTokens.length - 1; index >= 0; index -= 1) {
      try { rollbackArtifactAtomicWrite(pinnedRoot, rollbackTokens[index]!); } catch { /* preserve original write failure */ }
    }
    throw error;
  }
}

export type ArtifactId =
  | "discovery"
  | "feature_spec"
  | "exploration"
  | "dod"
  | "clarifications"
  | "architecture"
  | "diagnosis"
  | "implementation"
  | "debug"
  | "review"
  | "qa_tests"
  | "manual_qa"
  | "summary"
  | "lecture_intake"
  | "lecture_acquisition"
  | "lecture_mapping"
  | "lecture_candidates"
  | "lecture_repo_fit"
  | "lecture_decision";
/** A stable, descriptor-bound stat returned with an artifact byte snapshot. */
export interface ArtifactSnapshotStat {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export type ArtifactSnapshotFailureKind =
  | "missing"
  | "symlink"
  | "not-regular"
  | "too-large"
  | "changed"
  | "unsafe"
  | "encoding"
  | "malformed"
  | "structure-limit"
  | "unreadable";


export type ArtifactSnapshotResult<T = unknown> =
  | {
      ok: true;
      path: string;
      bytes: Buffer;
      stat: ArtifactSnapshotStat;
      sha256: string;
      value: T;
    }
  | {
      ok: false;
      kind: ArtifactSnapshotFailureKind;
      reason: string;
    };

/** Internal deterministic race seam; intentionally not exported by package index. */
export interface ArtifactReadTestHooks {
  /** Invoked after the complete bounded descriptor read and before stability checks. */
  afterRead?: (context: { path: string; stat: ArtifactSnapshotStat }) => void;
}
let artifactReadTestHooks: ArtifactReadTestHooks | null = null;

/** Install or clear the deterministic artifact read race seam used by focused tests. */
export function setArtifactReadTestHooks(hooks: ArtifactReadTestHooks | null): void {
  artifactReadTestHooks = hooks;
}

/**
 * Read one artifact through a single opened descriptor. The returned bytes are
 * the authority for the digest and parsed value; callers must not reopen the
 * returned path for validation. A bounded read, descriptor stat before/after,
 * no-follow open, and pathname identity check reject replacement races.
 */
/** Build one descriptor-relative artifact path; never accepts an absolute path. */
function pinnedArtifactPath(artifactsDirRelative: string, id: string): string {
  assertArtifactId(id);
  const path = artifactsDirRelative.length === 0 ? `${id}.json` : `${artifactsDirRelative}/${id}.json`;
  if (!safeRelativePath(path)) throw new PinnedRootError("path_unauthorized", "artifact path is not safe relative to the pinned project root");
  return path;
}
/** Read one artifact through the caller's already-borrowed project-root descriptor. */
export function readArtifactPinned<T = unknown>(
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
  id: string,
): T | null {
  try {
    if (!pinnedRoot.isStable()) return null;
    const path = pinnedArtifactPath(artifactsDirRelative, id);
    const entry = pinnedRoot.readFile(path, { maxBytes: MAX_ARTIFACT_BYTES });
    if (!pinnedRoot.isStable()) return null;
    const parsed = parseArtifactJson(Buffer.from(entry.bytes));
    return parsed.ok ? parsed.value as T : null;
  } catch {
    return null;
  }
}

/** Check one artifact entry without following a symlink or leaving the pinned root. */
export function artifactExistsPinned(
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
  id: string,
): boolean {
  try {
    if (!pinnedRoot.isStable()) return false;
    const info = pinnedRoot.pathEntryInfo(pinnedArtifactPath(artifactsDirRelative, id));
    return info?.kind === "file" && pinnedRoot.isStable();
  } catch {
    return false;
  }
}

/** Build an exact rollback token from the central pinned publication receipt. */
export function artifactAtomicWriteRollbackTokenFromReceipt(
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
  receipt: PinnedRootWriteReceipt,
): ArtifactAtomicWriteRollbackToken {
  const path = pinnedRoot.anchorPath(relativePath);
  if (receipt.relative_path !== relativePath || receipt.path !== path || receipt.descriptor.path !== path || !pinnedRoot.isStable()) {
    throw new PinnedRootError("changed", "artifact atomic write receipt is not bound to its requested target");
  }
  const preimage = receipt.preimage.kind === "absent"
    ? { kind: "absent" as const, path }
    : {
      kind: "file" as const,
      path,
      bytes: Uint8Array.from(receipt.preimage.bytes),
      dev: receipt.preimage.expectation.dev,
      ino: receipt.preimage.expectation.ino,
      size: receipt.preimage.bytes.byteLength,
      sha256: receipt.preimage.expectation.sha256,
    };
  return {
    receipt,
    path,
    relative_path: relativePath,
    preimage,
    postimage: { dev: receipt.descriptor.dev, ino: receipt.descriptor.ino, size: receipt.descriptor.size, sha256: receipt.descriptor.sha256 },
  };
}


/** Roll back an exact mutable artifact attempt without clobbering a replacement. */
export function rollbackArtifactAtomicWrite(
  pinnedRoot: PinnedProjectRoot,
  token: ArtifactAtomicWriteRollbackToken,
): boolean {
  try {
    if (token.receipt) return token.receipt.rollback();
    if (!pinnedRoot.isStable() || !token || typeof token.relative_path !== "string" || !token.relative_path || token.path !== pinnedRoot.anchorPath(token.relative_path)) return false;
    if (token.preimage.path !== token.path) return false;
    const authorized = pinnedRoot.relativePath(token.path);
    if (authorized !== token.relative_path) return false;
    const observed = pinnedRoot.readFile(token.relative_path, { maxBytes: MAX_ARTIFACT_BYTES });
    const info = pinnedRoot.pathEntryInfo(token.relative_path);
    const bytes = Buffer.from(observed.bytes);
    const digest = sha256Bytes(bytes);
    if (!info || info.kind !== "file" || observed.dev !== token.postimage.dev || observed.ino !== token.postimage.ino || bytes.byteLength !== token.postimage.size || digest !== token.postimage.sha256) return false;
    if (token.preimage.kind === "absent") {
      pinnedRoot.removeFileIfMatches(token.relative_path, token.postimage);
    } else {
      const preimageBytes = Buffer.from(token.preimage.bytes);
      if (preimageBytes.byteLength !== token.preimage.size || sha256Bytes(preimageBytes) !== token.preimage.sha256) return false;
      pinnedRoot.replaceFileIfMatches(token.relative_path, token.postimage, preimageBytes);
    }
    return true;
  } catch {
    return false;
  }
}

/** Persist one artifact through the caller's descriptor-anchored root. */
export function writeArtifactPinned<T = unknown>(
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
  id: string,
  data: T,
  options: Pick<ArtifactWriteOptions, "beforeWrite" | "beforePublish" | "onWritten"> = {},
): string {
  assertArtifactStructure(data);
  const path = pinnedArtifactPath(artifactsDirRelative, id);
  const body = JSON.stringify(data, null, 2) + "\n";
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_ARTIFACT_BYTES) {
    throw new PinnedRootError("invalid", `artifact ${id} exceeds the ${MAX_ARTIFACT_BYTES}-byte persisted payload limit`);
  }
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before artifact write");
  pinnedRoot.ensureDirectory(artifactsDirRelative);
  options.beforeWrite?.();
  let rollbackToken: ArtifactAtomicWriteRollbackToken | null = null;
  try {
    if (options.onWritten) {
      const receipt = pinnedRoot.writeAtomicWithReceipt(path, body, { beforePublish: options.beforePublish });
      rollbackToken = artifactAtomicWriteRollbackTokenFromReceipt(pinnedRoot, path, receipt);
      options.onWritten(rollbackToken);
    } else {
      pinnedRoot.writeAtomic(path, body);
    }
    return path;
  } catch (error) {
    if (rollbackToken) rollbackArtifactAtomicWrite(pinnedRoot, rollbackToken);
    throw error;
  }
}

export interface PinnedArtifactSnapshot {
  readonly path: string;
  /** Detached bytes copy; mutating it cannot alter the descriptor read. */
  readonly bytes: Readonly<Uint8Array>;
  readonly sha256: string;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  readonly value: unknown;
}

/**
 * Read and parse one artifact through a borrowed pinned root. The returned
 * bytes and parsed value belong to this snapshot only; no mutable descriptor
 * buffer is exposed to callers.
 */
export function readPinnedArtifactSnapshot(
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
  id: string,
  options: { verifyPathAfterRead?: boolean } = {},
): PinnedArtifactSnapshot {
  const path = pinnedArtifactPath(artifactsDirRelative, id);
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before artifact read");
  const entry = pinnedRoot.readFile(path, { maxBytes: MAX_ARTIFACT_BYTES });
  artifactReadTestHooks?.afterRead?.({
    path: pinnedRoot.anchorPath(path),
    stat: {
      dev: entry.dev,
      ino: entry.ino,
      mode: 0,
      size: entry.size ?? entry.bytes.byteLength,
      mtimeMs: entry.mtimeMs ?? 0,
      ctimeMs: entry.ctimeMs ?? 0,
    },
  });
  if (options.verifyPathAfterRead) {
    let after: ReturnType<PinnedProjectRoot["pathEntryInfo"]>;
    try {
      after = pinnedRoot.pathEntryInfo(path);
    } catch (error) {
      if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed after artifact read");
      throw error;
    }
    if (
      !after
      || after.kind !== "file"
      || entry.size === undefined
      || entry.mtimeMs === undefined
      || entry.ctimeMs === undefined
      || after.dev !== entry.dev
      || after.ino !== entry.ino
      || after.size !== entry.size
      || after.mtimeMs !== entry.mtimeMs
      || after.ctimeMs !== entry.ctimeMs
    ) {
      throw new PinnedRootError("changed", "pinned artifact changed after its snapshot was captured");
    }
  }
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed after artifact read");
  const descriptorBytes = Buffer.from(entry.bytes);
  const parsed = parseArtifactJson(descriptorBytes);
  if (!parsed.ok) throw new PinnedRootError("write_failed", parsed.reason);
  const bytes = Uint8Array.from(descriptorBytes);
  return Object.freeze({
    path,
    bytes,
    sha256: sha256Bytes(descriptorBytes),
    size: bytes.byteLength,
    dev: entry.dev,
    ino: entry.ino,
    value: parsed.value,
  });
}

/** Explicit snapshot-oriented spelling for callers that prefer the read API name. */
export const readArtifactSnapshotPinned = readPinnedArtifactSnapshot;
export interface ArtifactReferenceAuthorization {
  /** Existing canonical project root authorized by the current workspace. */
  project_root: string;
  /** Existing artifact store selected by durable feature state. */
  artifacts_dir: string;
  /** Exact project-relative paths the active execution may cite. */
  allowed_paths: readonly string[];
}

export type ArtifactSchemaValidator = (
  artifactId: string,
  value: unknown,
) => { ok: true } | { ok: false; issues: readonly { field: string; message: string }[] };

export type ArtifactReferenceNormalizationResult =
  | { ok: true; reference: CompletionArtifactRef; value: unknown }
  | { ok: false; issues: string[] };

function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotStat(stat: Stats): ArtifactSnapshotStat {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameSnapshotStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function isWithinTree(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  if (value.includes("//")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function realDirectory(path: string): string | null {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) return null;
    return realpathSync(path);
  } catch {
    return null;
  }
}

function authorizedArtifactLocation(
  authorization: Pick<ArtifactReferenceAuthorization, "project_root" | "artifacts_dir">,
  artifactId: string,
): { ok: true; projectRoot: string; artifactsDir: string; path: string; relativePath: string } | null {
  if (!ARTIFACT_ID_RE.test(artifactId) || artifactId === "." || artifactId === "..") return null;
  const projectRoot = realDirectory(resolve(authorization.project_root));
  const artifactsDir = realDirectory(resolve(authorization.artifacts_dir));
  if (!projectRoot || !artifactsDir || !isWithinTree(projectRoot, artifactsDir)) return null;
  const path = join(artifactsDir, `${artifactId}.json`);
  const relativePath = relative(projectRoot, path).split(sep).join("/");
  if (!safeRelativePath(relativePath)) return null;
  return { ok: true, projectRoot, artifactsDir, path, relativePath };
}

type ArtifactSnapshotLocation = {
  ok: true;
  projectRoot: string;
  artifactsDir: string;
  path: string;
} | {
  ok: false;
  kind: ArtifactSnapshotFailureKind;
  reason: string;
};

function artifactSnapshotLocation(artifactsDir: string, id: string, projectRoot?: string): ArtifactSnapshotLocation {
  if (!ARTIFACT_ID_RE.test(id) || id === "." || id === "..") {
    return { ok: false, kind: "unsafe", reason: "artifact id is unsafe" };
  }
  if (projectRoot !== undefined) {
    const location = authorizedArtifactLocation({ project_root: projectRoot, artifacts_dir: artifactsDir }, id);
    if (!location) {
      return { ok: false, kind: "unsafe", reason: "artifact path is outside the authorized artifact store" };
    }
    return {
      ok: true,
      projectRoot: location.projectRoot,
      artifactsDir: location.artifactsDir,
      path: location.path,
    };
  }
  const realArtifactsDir = realDirectory(resolve(artifactsDir));
  if (!realArtifactsDir) {
    return { ok: false, kind: "missing", reason: "artifact directory is missing or is not a regular directory" };
  }
  const path = join(realArtifactsDir, `${id}.json`);
  if (!safeRelativePath(`${id}.json`)) {
    return { ok: false, kind: "unsafe", reason: "artifact path is unsafe" };
  }
  return { ok: true, projectRoot: realArtifactsDir, artifactsDir: realArtifactsDir, path };
}

function artifactPathRejection(location: Extract<ArtifactSnapshotLocation, { ok: true }>): string | null {
  try {
    const rootReal = realpathSync(location.projectRoot);
    const artifactsDirReal = realpathSync(location.artifactsDir);
    if (rootReal !== location.projectRoot || artifactsDirReal !== location.artifactsDir) {
      return "artifact directory resolves through a symlink or changed while being read";
    }
    if (!isWithinTree(location.projectRoot, location.artifactsDir)) {
      return "artifact directory is outside the authorized project root";
    }
    const pathReal = realpathSync(location.path);
    if (!isWithinTree(location.projectRoot, pathReal) || !isWithinTree(location.artifactsDir, pathReal)) {
      return "artifact resolves outside the authorized artifact store";
    }
    return null;
  } catch {
    return "artifact path changed or cannot be canonicalized";
  }
}

function preflightArtifactPath(location: Extract<ArtifactSnapshotLocation, { ok: true }>): ArtifactSnapshotResult<never> | null {
  try {
    const rootStat = lstatSync(location.projectRoot);
    const artifactsDirStat = lstatSync(location.artifactsDir);
    if (rootStat.isSymbolicLink() || artifactsDirStat.isSymbolicLink()) {
      return { ok: false, kind: "unsafe", reason: "artifact directory is a symbolic link" };
    }
    if (!rootStat.isDirectory() || !artifactsDirStat.isDirectory()) {
      return { ok: false, kind: "unsafe", reason: "artifact directory is not a regular directory" };
    }
    if (!existsSync(location.path)) {
      return { ok: false, kind: "missing", reason: "artifact file is missing" };
    }
    const pathStat = lstatSync(location.path);
    if (pathStat.isSymbolicLink()) {
      return { ok: false, kind: "symlink", reason: "artifact file is a symbolic link" };
    }
    if (!pathStat.isFile()) {
      return { ok: false, kind: "not-regular", reason: "artifact file is not a regular file" };
    }
    const rejection = artifactPathRejection(location);
    if (rejection !== null) return { ok: false, kind: "unsafe", reason: rejection };
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, kind: "missing", reason: "artifact file is missing" };
    }
    return { ok: false, kind: "unreadable", reason: `artifact path cannot be inspected: ${code || "unknown error"}` };
  }
}

function readArtifactSnapshotAtLocation<T>(location: Extract<ArtifactSnapshotLocation, { ok: true }>): ArtifactSnapshotResult<T> {
  const preflight = preflightArtifactPath(location);
  if (preflight) return preflight;

  let descriptor: number | null = null;
  try {
    try {
      descriptor = openSync(location.path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "ELOOP") return { ok: false, kind: "symlink", reason: "artifact file is a symbolic link" };
      if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, kind: "missing", reason: "artifact file is missing" };
      if (code === "EISDIR") return { ok: false, kind: "not-regular", reason: "artifact file is not a regular file" };
      return { ok: false, kind: "unreadable", reason: `artifact file could not be opened: ${code || "unknown error"}` };
    }

    let before: Stats;
    try {
      before = fstatSync(descriptor);
    } catch {
      return { ok: false, kind: "unreadable", reason: "artifact descriptor could not be stat'ed" };
    }
    if (!before.isFile()) return { ok: false, kind: "not-regular", reason: "artifact file is not a regular file" };
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_ARTIFACT_BYTES) {
      return { ok: false, kind: "too-large", reason: `artifact file exceeds the ${MAX_ARTIFACT_BYTES}-byte read limit` };
    }

    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(descriptor, bytes, offset, before.size - offset, offset);
      if (count === 0) break;
      offset += count;
    }

    artifactReadTestHooks?.afterRead?.({ path: location.path, stat: snapshotStat(before) });

    const after = fstatSync(descriptor);
    if (offset !== before.size || !sameSnapshotStat(before, after)) {
      return { ok: false, kind: "changed", reason: "artifact file changed while it was being read" };
    }

    let pathStat: Stats;
    try {
      pathStat = lstatSync(location.path);
    } catch {
      return { ok: false, kind: "changed", reason: "artifact pathname changed while it was being read" };
    }
    if (pathStat.isSymbolicLink()) return { ok: false, kind: "symlink", reason: "artifact pathname became a symbolic link while it was being read" };
    if (!pathStat.isFile()) return { ok: false, kind: "not-regular", reason: "artifact pathname is not a regular file" };
    if (pathStat.dev !== after.dev || pathStat.ino !== after.ino) {
      return { ok: false, kind: "changed", reason: "artifact pathname changed while it was being read" };
    }

    const rejection = artifactPathRejection(location);
    if (rejection !== null) return { ok: false, kind: "unsafe", reason: rejection };
    const sha256 = sha256Bytes(bytes);
    const parsed = parseArtifactJson(bytes);
    if (!parsed.ok) {
      return {
        ok: false,
        kind: parsed.kind,
        reason: parsed.reason,
      };
    }
    return { ok: true, path: location.path, bytes, stat: snapshotStat(after), sha256, value: parsed.value as T };
  } catch (error) {
    return { ok: false, kind: "unreadable", reason: `artifact file could not be read safely: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* preserve the read result */ }
    }
  }
}

function artifactReferenceReadIssue(id: string, result: Exclude<ArtifactSnapshotResult, { ok: true }>): string {
  switch (result.kind) {
    case "missing":
    case "not-regular":
      return `artifact '${id}' is missing or is not a regular file`;
    case "symlink":
      return `artifact '${id}' is a symlink or changed while being read`;
    case "too-large":
      return `artifact '${id}' exceeds the bounded read limit of ${MAX_ARTIFACT_BYTES} bytes`;
    case "changed":
      return `artifact '${id}' changed while being read (refusing to read)`;
    case "encoding":
      return `artifact '${id}' is not valid UTF-8`;
    case "structure-limit":
      return `artifact '${id}' exceeds the bounded JSON structure limit`;
    case "unsafe":
      return `artifact '${id}' resolves outside the authorized artifact store`;
    case "malformed":
      return `artifact '${id}' has no current readable JSON value`;
    case "unreadable":
      return `artifact '${id}' is unreadable: ${result.reason}`;
  }
}

/**
 * Resolve one submitted reference to one descriptor-bound byte snapshot in the
 * authorized artifact store. Nothing from the submitted path, digest, or
 * statuses is repaired: every field must already match the exact snapshot.
 */
export function normalizeStoredArtifactReference(
  authorization: ArtifactReferenceAuthorization,
  reference: CompletionArtifactRef,
  validateSchema: ArtifactSchemaValidator,
): ArtifactReferenceNormalizationResult {
  const issues: string[] = [];
  if (!reference || typeof reference !== "object") return { ok: false, issues: ["artifact reference must be an object"] };
  const location = authorizedArtifactLocation(authorization, reference.artifact_id);
  if (!location) return { ok: false, issues: [`artifact '${String(reference.artifact_id)}' is outside the authorized project artifact store`] };

  const allowed = new Set<string>();
  for (const candidate of authorization.allowed_paths) {
    if (!safeRelativePath(candidate)) issues.push(`allowed artifact path '${String(candidate)}' is unsafe`);
    else allowed.add(candidate);
  }
  if (!safeRelativePath(reference.path)) issues.push(`artifact '${reference.artifact_id}' path '${String(reference.path)}' is unsafe`);
  else if (reference.path !== location.relativePath) {
    issues.push(`artifact '${reference.artifact_id}' path '${reference.path}' does not match current stored path '${location.relativePath}'`);
  }
  if (!allowed.has(location.relativePath)) issues.push(`artifact '${reference.artifact_id}' path '${location.relativePath}' is not authorized for this execution`);

  const snapshot = readArtifactSnapshotAtLocation(location);
  if (!snapshot.ok) {
    issues.push(artifactReferenceReadIssue(reference.artifact_id, snapshot));
  } else {
    if (reference.sha256 !== snapshot.sha256) {
      issues.push(`artifact '${reference.artifact_id}' digest '${reference.sha256}' does not match current digest '${snapshot.sha256}'`);
    }
    const validation = validateSchema(reference.artifact_id, snapshot.value);
    if (!validation.ok) {
      issues.push(...validation.issues.map((issue) => `artifact '${reference.artifact_id}' schema failed at ${issue.field}: ${issue.message}`));
    }
  }
  if (reference.schema_status !== "met") issues.push(`artifact '${reference.artifact_id}' schema status is '${String(reference.schema_status)}', not 'met'`);
  if (reference.quality_gate_status !== "met") {
    issues.push(`artifact '${reference.artifact_id}' quality-gate status is '${String(reference.quality_gate_status)}', not 'met'`);
  }

  return issues.length > 0 || !snapshot.ok
    ? { ok: false, issues }
    : { ok: true, reference: { ...reference }, value: snapshot.value };
}

function sameConformanceAuthoritativeContent(existing: unknown, requested: unknown): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)
    || !requested || typeof requested !== "object" || Array.isArray(requested)) return false;
  const existingRecord = existing as Record<string, unknown>;
  const requestedRecord = requested as Record<string, unknown>;
  if (typeof existingRecord.evaluated_at !== "string" || typeof requestedRecord.evaluated_at !== "string") return false;
  const withoutTimestamp = (value: Record<string, unknown>): Record<string, unknown> => {
    const copy = { ...value };
    delete copy.evaluated_at;
    return copy;
  };
  return canonicalJson(withoutTimestamp(existingRecord)) === canonicalJson(withoutTimestamp(requestedRecord));
}

export interface ArtifactWriteOwnershipToken {
  /** Canonical absolute path observed after this call's successful exclusive write. */
  path: string;
  /** Root-relative path used by the pinned writer for exact cleanup. */
  relative_path: string;
  dev: number;
  ino: number;
  size: number;
  sha256: string;
}

export interface ArtifactAtomicWritePreimageAbsent {
  kind: "absent";
  path: string;
}

export interface ArtifactAtomicWritePreimageFile {
  kind: "file";
  path: string;
  /** Detached bounded preimage bytes captured before the atomic replacement. */
  bytes: Readonly<Uint8Array>;
  dev: number;
  ino: number;
  size: number;
  sha256: string;
}

export type ArtifactAtomicWritePreimage = ArtifactAtomicWritePreimageAbsent | ArtifactAtomicWritePreimageFile;

export interface ArtifactAtomicWritePostimage {
  dev: number;
  ino: number;
  size: number;
  sha256: string;
}

/** Exact attempt token for rolling back one mutable anchored atomic write. */
export interface ArtifactAtomicWriteRollbackToken {
  /** Central pinned publication receipt; preferred over descriptor reconstruction. */
  readonly receipt?: PinnedRootWriteReceipt;
  /** Canonical absolute path authorized by the pinned root. */
  path: string;
  /** Root-relative path used by the anchored writer. */
  relative_path: string;
  preimage: ArtifactAtomicWritePreimage;
  postimage: ArtifactAtomicWritePostimage;
}

export interface ArtifactWriteOptions {
  pinnedRoot?: PinnedProjectRoot;
  /** Called immediately before this invocation writes the artifact. */
  beforeWrite?: () => void;
  /** Called after secure staging and before the artifact path becomes visible. */
  beforePublish?: (receipt: PinnedRootWriteReceipt) => void;
  /** Called only after this invocation successfully creates a new artifact exclusively. */
  onCreated?: (ownership: ArtifactWriteOwnershipToken) => void;
  /** Internal receipt seam retaining the exact created rollback token. */
  onCreatedRollback?: (ownership: ArtifactWriteOwnershipToken, token: ArtifactAtomicWriteRollbackToken) => void;
  /** Called after a mutable atomic write with an exact attempt rollback token. */
  onWritten?: (token: ArtifactAtomicWriteRollbackToken) => void;
}

function createdArtifactAttempt(
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
  receipt: PinnedRootWriteReceipt,
): { ownership: ArtifactWriteOwnershipToken; rollback: ArtifactAtomicWriteRollbackToken } {
  const rollback = artifactAtomicWriteRollbackTokenFromReceipt(pinnedRoot, relativePath, receipt);
  const descriptor = rollback.receipt!.descriptor;
  return {
    ownership: {
      path: descriptor.path,
      relative_path: descriptor.relative_path,
      dev: descriptor.dev,
      ino: descriptor.ino,
      size: descriptor.size,
      sha256: descriptor.sha256,
    },
    rollback,
  };
}

function writeContentAddressedArtifactPinned<T>(
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
  id: string,
  data: T,
  options: Pick<ArtifactWriteOptions, "beforeWrite" | "beforePublish" | "onCreated" | "onCreatedRollback"> = {},
): void {
  const path = pinnedArtifactPath(artifactsDirRelative, id);
  const { body } = serializedArtifactBody(id, data);
  const bytes = Buffer.from(body, "utf8");
  // Byte/schema validation intentionally precedes directory creation and all
  // content-addressed existence checks.
  pinnedRoot.ensureDirectory(artifactsDirRelative);
  try {
    const existing = pinnedRoot.readFile(path, { maxBytes: MAX_ARTIFACT_BYTES });
    if (Buffer.from(existing.bytes).equals(bytes)) return;
    if (id.startsWith("implementation-conformance.")) {
      const parsed = parseArtifactJson(Buffer.from(existing.bytes));
      if (!parsed.ok) throw new PinnedRootError("write_failed", parsed.reason);
      if (sameConformanceAuthoritativeContent(parsed.value, data)) return;
    }
    throw new PinnedRootError("exists", `content-addressed artifact '${id}' already exists with different content`);
  } catch (error) {
    if (!(error instanceof PinnedRootError && error.code === "not_found")) throw error;
  }
  options.beforeWrite?.();
  let receipt: PinnedRootWriteReceipt;
  try {
    receipt = pinnedRoot.writeExclusiveWithReceipt(path, bytes, { beforePublish: options.beforePublish });
  } catch (error) {
    if (!(error instanceof PinnedRootError && error.code === "exists")) throw error;
    const existing = pinnedRoot.readFile(path, { maxBytes: MAX_ARTIFACT_BYTES });
    if (Buffer.from(existing.bytes).equals(bytes)) return;
    if (id.startsWith("implementation-conformance.")) {
      const parsed = parseArtifactJson(Buffer.from(existing.bytes));
      if (!parsed.ok) throw new PinnedRootError("write_failed", parsed.reason);
      if (sameConformanceAuthoritativeContent(parsed.value, data)) return;
    }
    throw new PinnedRootError("exists", `content-addressed artifact '${id}' already exists with different content`);
  }
  if (options.onCreated || options.onCreatedRollback) {
    try {
      const created = createdArtifactAttempt(pinnedRoot, path, receipt!);
      options.onCreatedRollback?.(created.ownership, created.rollback);
      options.onCreated?.(created.ownership);
    } catch (error) {
      receipt!.rollback();
      throw error;
    }
  }
}

/** Persist through the canonical store and return a reference to exact bytes. */
export function writeArtifactWithReference<T = unknown>(
  projectRoot: string,
  artifactsDir: string,
  id: string,
  data: T,
  statuses: Pick<CompletionArtifactRef, "schema_status" | "quality_gate_status">,
  options: ArtifactWriteOptions = {},
): CompletionArtifactRef {
  let pinnedRoot = options.pinnedRoot;
  let ownsRoot = false;
  if (!pinnedRoot) {
    pinnedRoot = PinnedProjectRoot.open(projectRoot) ?? undefined;
    ownsRoot = true;
  }
  if (!pinnedRoot) throw new Error(`authorized project root could not be pinned: ${projectRoot}`);
  let writtenToken: ArtifactAtomicWriteRollbackToken | null = null;
  let createdOwnership: ArtifactWriteOwnershipToken | null = null;
  let createdRollback: ArtifactAtomicWriteRollbackToken | null = null;
  const writerOptions: ArtifactWriteOptions = {
    ...options,
    onWritten: (token) => {
      writtenToken = token;
      options.onWritten?.(token);
    },
    onCreatedRollback: (ownership, token) => {
      createdOwnership = ownership;
      createdRollback = token;
    },
    onCreated: (ownership) => {
      createdOwnership = ownership;
      options.onCreated?.(ownership);
    },
  };
  const rollbackWrites = (): void => {
    if (createdRollback) rollbackArtifactAtomicWrite(pinnedRoot, createdRollback);
    if (writtenToken) rollbackArtifactAtomicWrite(pinnedRoot, writtenToken);
  };
  try {
    if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before artifact reference write");
    const requestedProjectRoot = resolve(projectRoot);
    if (requestedProjectRoot !== pinnedRoot.lexical_root && requestedProjectRoot !== pinnedRoot.canonical_root) {
      throw new PinnedRootError("path_unauthorized", "borrowed pinned root does not authorize the requested project root");
    }
    const artifactsDirRelative = pinnedRoot.relativePath(artifactsDir);
    if (artifactsDirRelative === null) {
      throw new PinnedRootError("path_unauthorized", `artifact directory is outside the authorized project root: ${artifactsDir}`);
    }
    if (id.startsWith("implementation-conformance.")) {
      writeContentAddressedArtifactPinned(pinnedRoot, artifactsDirRelative, id, data, writerOptions);
    } else {
      writeArtifactPinned(pinnedRoot, artifactsDirRelative, id, data, writerOptions);
    }
    let snapshot: PinnedArtifactSnapshot;
    try {
      snapshot = readPinnedArtifactSnapshot(pinnedRoot, artifactsDirRelative, id, { verifyPathAfterRead: true });
    } catch (error) {
      rollbackWrites();
      throw error;
    }
    const expected = serializedArtifactBody(id, data);
    const expectedBytes = Buffer.byteLength(expected.body, "utf8");
    const expectedSha256 = sha256Bytes(Buffer.from(expected.body, "utf8"));
    const operationToken = writtenToken as ArtifactAtomicWriteRollbackToken | null;
    const operationOwnership = createdOwnership as ArtifactWriteOwnershipToken | null;
    // Conformance IDs intentionally permit replaying an existing authoritative
    // matrix whose evaluated_at differs. In that one no-write path, the
    // persisted bytes (and returned reference digest) are the accepted
    // canonical source; every newly published artifact still requires the
    // exact requested bytes below.
    const requestedBytesMatch = snapshot.size === expectedBytes && snapshot.sha256 === expectedSha256;
    const acceptedConformanceReplay = operationToken === null
      && operationOwnership === null
      && id.startsWith("implementation-conformance.")
      && sameConformanceAuthoritativeContent(snapshot.value, data);
    if (
      (!requestedBytesMatch && !acceptedConformanceReplay)
      || (operationToken !== null && (snapshot.dev !== operationToken.postimage.dev || snapshot.ino !== operationToken.postimage.ino))
      || (operationOwnership !== null && (snapshot.dev !== operationOwnership.dev || snapshot.ino !== operationOwnership.ino))
      || !pinnedRoot.isStable()
    ) {
      rollbackWrites();
      throw new PinnedRootError("changed", "artifact bytes or identity changed while recording artifact reference");
    }
    const relativePath = snapshot.path;
    return {
      artifact_id: id,
      path: relativePath,
      sha256: snapshot.sha256,
      schema_status: statuses.schema_status,
      quality_gate_status: statuses.quality_gate_status,
    };
  } finally {
    if (ownsRoot) pinnedRoot.close();
  }
}
