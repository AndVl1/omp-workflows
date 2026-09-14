import { PinnedProjectRoot, type PinnedRootReadResult } from "./pinned-root.js";
import { canonicalHandoffDigest } from "./handoff.js";
import { isSafeRelativePath, validateImplementationHandoff } from "./validation.js";
import type { ImplementationHandoff } from "./types.js";
import { TextDecoder } from "node:util";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Maximum bytes accepted for one canonical implementation handoff. */
export const MAX_CANONICAL_HANDOFF_BYTES = 8 * 1024 * 1024;
export type CanonicalHandoffSerializationResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: string };

/** Serialize one canonical handoff exactly as persisted, enforcing its reader cap. */
export function serializeCanonicalHandoff(handoff: ImplementationHandoff): CanonicalHandoffSerializationResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(handoff, null, 2);
  } catch (error) {
    return { ok: false, error: `canonical handoff is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof serialized !== "string") return { ok: false, error: "canonical handoff is not JSON-serializable" };
  const bytes = Buffer.from(`${serialized}\n`, "utf8");
  if (bytes.byteLength > MAX_CANONICAL_HANDOFF_BYTES) {
    return { ok: false, error: `canonical handoff exceeds the ${MAX_CANONICAL_HANDOFF_BYTES}-byte limit` };
  }
  return { ok: true, bytes };
}


export interface CanonicalHandoffReadTestHooks {
  afterRead?: (context: { path: string; relative_path: string; dev: number; ino: number }) => void;
}

type CanonicalHookRecord = { hook: CanonicalHandoffReadTestHooks; aliases: string[] };
const canonicalHandoffReadTestHooksByRoot = new Map<string, CanonicalHookRecord>();
function canonicalHookScopeKeys(projectRoot: string): string[] {
  const lexical = resolve(projectRoot);
  try {
    const canonical = resolve(realpathSync(projectRoot));
    return canonical === lexical ? [lexical] : [lexical, canonical];
  } catch {
    return [lexical];
  }
}
function canonicalHookIdentity(projectRoot: string): string | undefined {
  try {
    const stat = lstatSync(realpathSync(projectRoot));
    return "identity:" + String(stat.dev) + ":" + String(stat.ino);
  } catch {
    return undefined;
  }
}
function findCanonicalHook(projectRoot: string, pinnedRoot?: PinnedProjectRoot): CanonicalHandoffReadTestHooks | undefined {
  const aliases = pinnedRoot
    ? ["identity:" + String(pinnedRoot.dev) + ":" + String(pinnedRoot.ino), ...canonicalHookScopeKeys(projectRoot)]
    : canonicalHookScopeKeys(projectRoot);
  for (const alias of aliases) {
    const record = canonicalHandoffReadTestHooksByRoot.get(alias);
    if (record) return record.hook;
  }
  return undefined;
}
function setCanonicalHook(hook: CanonicalHandoffReadTestHooks | null, projectRoot: string): void {
  const aliases = [...canonicalHookScopeKeys(projectRoot)];
  const identity = canonicalHookIdentity(projectRoot);
  if (identity && !aliases.includes(identity)) aliases.push(identity);
  const previous = new Set<CanonicalHookRecord>();
  for (const alias of aliases) {
    const record = canonicalHandoffReadTestHooksByRoot.get(alias);
    if (record) previous.add(record);
  }
  for (const record of previous) for (const alias of record.aliases) {
    if (canonicalHandoffReadTestHooksByRoot.get(alias) === record) canonicalHandoffReadTestHooksByRoot.delete(alias);
  }
  if (!hook) return;
  const record: CanonicalHookRecord = { hook, aliases };
  for (const alias of aliases) canonicalHandoffReadTestHooksByRoot.set(alias, record);
}

export interface CanonicalJsonReadOptions {
  afterRead?: CanonicalHandoffReadTestHooks["afterRead"];
}
export type CanonicalHandoffReadOptions = CanonicalJsonReadOptions;

/** Install or clear the deterministic canonical handoff read race seam. */
export function setCanonicalHandoffReadTestHooks(hooks: CanonicalHandoffReadTestHooks | null, projectRoot: string): void {
  setCanonicalHook(hooks, projectRoot);
}

export type CanonicalJsonReadResult =
  | { ok: true; value: unknown; snapshot: PinnedRootReadResult }
  | { ok: false; error: string };

/**
 * Read one bounded JSON document through a pinned root. The descriptor bytes
 * are checked against the no-follow path metadata before fatal UTF-8 decoding
 * and JSON parsing, so callers never parse a swapped pathname or replacement
 * text.
 */
export function readCanonicalBoundedJson(
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
  maxBytes: number,
  label = "JSON artifact",
  options: CanonicalJsonReadOptions = {},
): CanonicalJsonReadResult {
  if (!isSafeRelativePath(relativePath)) return { ok: false, error: `${label} is missing or outside the authorized project boundary` };
  try {
    if (!pinnedRoot.isStable()) return { ok: false, error: `${label} changed before it could be read` };
    const snapshot = pinnedRoot.readFile(relativePath, { maxBytes });
    const afterRead = options.afterRead ?? findCanonicalHook(pinnedRoot.lexical_root, pinnedRoot)?.afterRead;
    afterRead?.({
      path: snapshot.path,
      relative_path: relativePath,
      dev: snapshot.dev,
      ino: snapshot.ino,
    });
    const after = pinnedRoot.pathEntryInfo(relativePath);
    if (after?.kind === "symlink") return { ok: false, error: `${label} became a symlink while it was being read` };
    if (!after || after.kind !== "file"
      || snapshot.size === undefined || snapshot.mtimeMs === undefined || snapshot.ctimeMs === undefined
      || after.dev !== snapshot.dev || after.ino !== snapshot.ino
      || after.size !== snapshot.size || after.mtimeMs !== snapshot.mtimeMs || after.ctimeMs !== snapshot.ctimeMs) {
      return { ok: false, error: `${label} changed while it was being read` };
    }
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
    } catch {
      return { ok: false, error: `${label} is not valid UTF-8` };
    }
    try {
      return { ok: true, value: JSON.parse(raw) as unknown, snapshot };
    } catch (error) {
      return { ok: false, error: `${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  } catch (error) {
    return { ok: false, error: `${label} is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Pin a project root and read one bounded JSON document through the shared reader. */
export function readCanonicalBoundedJsonAtRoot(
  root: string,
  relativePath: string,
  maxBytes: number,
  label = "JSON artifact",
): CanonicalJsonReadResult {
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) return { ok: false, error: `${label} project root cannot be pinned` };
  try {
    return readCanonicalBoundedJson(pinnedRoot, relativePath, maxBytes, label);
  } finally {
    pinnedRoot.close();
  }
}

export type CanonicalHandoffReadResult =
  | { ok: true; handoff: ImplementationHandoff; snapshot: PinnedRootReadResult }
  | { ok: false; error: string };

/**
 * Read and validate one implementation handoff from a pinned project root.
 *
 * The target is inspected without following links, read through the pinned
 * descriptor with a hard byte limit, decoded with fatal UTF-8, and checked
 * again after the descriptor read. Callers therefore never parse bytes from a
 * pathname that was swapped during the operation.
 */
export function readCanonicalHandoff(
  pinnedRoot: PinnedProjectRoot,
  relativePath: string,
  label = "handoff artifact",
  options: CanonicalHandoffReadOptions = {},
): CanonicalHandoffReadResult {
  const loaded = readCanonicalBoundedJson(pinnedRoot, relativePath, MAX_CANONICAL_HANDOFF_BYTES, label, options);
  if (!loaded.ok) return loaded;
  const validation = validateImplementationHandoff(loaded.value);
  if (!validation.ok) return { ok: false, error: `${label} is invalid: ${validation.issues.join("; ")}` };
  const handoff = loaded.value as ImplementationHandoff;
  if (canonicalHandoffDigest(handoff) !== handoff.handoff_digest) {
    return { ok: false, error: `${label} does not match its canonical content digest` };
  }
  return { ok: true, handoff, snapshot: loaded.snapshot };
}
