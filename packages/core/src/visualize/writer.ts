/**
 * Visualize OPT-A — whole-bundle atomic publisher (architecture-7).
 *
 * Publishes a complete derived bundle under `.work-state/visualize` with a
 * dedicated whole-tree protocol (never `writeReport`'s per-file writes):
 *
 *   1. validate the destination/boundary and every bundle path segment
 *      (fixed hub files + `sessions/<kind>/<pathKey>.<ext>` with safe
 *      kind/pathKey segments; symlink escapes rejected);
 *   2. stage the new tree in a fresh sibling directory inside `.work-state`
 *      (never inside the target), writing every file mode 0600 (dirs 0700);
 *   3. atomically swap the complete tree: capture the old target by rename,
 *      swap the staging tree in by rename;
 *   4. prune old derived pages from the captured tree (non-derived,
 *      user-authored entries are preserved, never deleted).
 *
 * Guarantees (architecture-7 acceptance):
 * - The target is only ever a complete bundle. Staging happens outside the
 *   target and the swap is an atomic rename, so a staged-write or swap
 *   failure leaves the previous complete bundle intact and never exposes a
 *   partial target; staging/backup are discarded.
 * - Preflight failures (empty bundle, missing manifest, unsafe path
 *   segments, boundary/symlink escapes) throw before any filesystem write —
 *   no target tree is ever created.
 * - Concurrent writers expose one complete winner. The rollback guard never
 *   restores an older backup over a newer complete target: when the swap or
 *   capture fails while a newer complete bundle is live, the staging and
 *   backup are discarded with a swap-rollback warning. ENOENT while
 *   capturing the old target means no previous bundle — the writer proceeds.
 * - Canonical state and user-authored files are never touched: writes are
 *   confined to the output tree, pruning removes only derived pages, and
 *   non-derived entries from the old tree are moved back into the new tree.
 * - The result returns only relative paths, counters and warnings — never
 *   raw OS errors, secrets or absolute paths.
 *
 * The writer knows nothing about sessions or renderers: it receives the
 * complete generated bundle (hub Markdown/HTML, manifest, session pages) as
 * validated relative paths + content and publishes it atomically.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { PinnedProjectRoot, PinnedRootError, type PinnedRootPathEntryInfo } from "../specification/pinned-root.js";

import {
  VISUALIZE_OUTPUT_FILES,
  VISUALIZE_OUTPUT_ROOT,
  isSafePathKey,
  type OutputFileExtension,
  type SessionKind,
  type VisualizationManifest,
} from "./types.js";

// ── Public contract ──────────────────────────────────────────────────────────

/** One generated file of the complete bundle, relative to the visualize root. */
export interface VisualizeBundleFile {
  /** Safe relative path inside the visualize output root (derived-page shape). */
  relPath: string;
  content: string;
}

export type VisualizePublishErrorCode =
  | "empty-bundle"
  | "missing-manifest"
  | "unsafe-relpath"
  | "duplicate-file"
  | "boundary-escape"
  | "destination-conflict"
  | "staging-failed"
  | "write-failed"
  | "capture-failed"
  | "swap-failed"
  | "rollback-failed"
  | "recovery_required";

/**
 * Typed publish error. `message` is sanitized: relative descriptions only —
 * never raw OS errors, never absolute paths, never file content.
 */
export class VisualizePublishError extends Error {
  readonly code: VisualizePublishErrorCode;

  constructor(code: VisualizePublishErrorCode, message: string) {
    super(message);
    this.name = "VisualizePublishError";
    this.code = code;
  }
}

/**
 * Deterministic concurrency/rollback test seam. Production callers must not
 * pass hooks; without them the publish pipeline runs uninterrupted.
 */
export interface VisualizePublishHooks {
  /** Invoked after the staging directory exists, before any file is written into it. */
  onStagingCreated?(stagingDir: string): void;
  /** Invoked immediately before the old target is captured. */
  onBeforeCapture?(targetDir: string): void;
  /** Invoked after the old target capture, before the atomic swap. `backupDir` is null when there was no previous bundle. */
  onCaptured?(backupDir: string | null): void;
  /** Invoked immediately before the staged tree is swapped into the target. */
  onBeforeSwap?(stagingDir: string, targetDir: string): void;
  /** Invoked immediately before the old tree is reconciled and removed. */
  onBeforePrune?(backupDir: string, targetDir: string): void;
  /** Test-only seam immediately before validating a concurrent target. */
  onBeforeRecoveryValidation?(targetDir: string): void;
  /** Test-only seam after a recovery file is first read, before its exact recheck. */
  onAfterRecoveryFileRead?(targetDir: string, relativePath: string): void;
}

export interface PublishVisualizeOptions {
  /** Test-only seams for deterministic race/rollback tests (see {@link VisualizePublishHooks}). */
  hooks?: VisualizePublishHooks;
}

export type VisualizePublishStatus = "published" | "superseded";

export interface VisualizePublishCounters {
  filesWritten: number;
  bytesWritten: number;
  filesPruned: number;
}

export interface VisualizePublishResult {
  status: VisualizePublishStatus;
  /** cwd-relative paths of the live bundle files (sorted). */
  files: string[];
  /** cwd-relative paths of pruned old derived pages (sorted). */
  pruned: string[];
  counters: VisualizePublishCounters;
  warnings: string[];
}

// ── Derived-page shape validation (implementation_contract.output) ───────────

const WORK_STATE_DIR = ".work-state";
const SESSION_KINDS: Record<string, true> = {
  feature: true,
  legacy: true,
  cto: true,
};
const HUB_FILE_NAMES: Record<string, true> = {
  [VISUALIZE_OUTPUT_FILES.hubMarkdown]: true,
  [VISUALIZE_OUTPUT_FILES.hubHtml]: true,
  [VISUALIZE_OUTPUT_FILES.manifest]: true,
};

type DerivedPage =
  | { kind: "hub"; relPath: string }
  | { kind: "session"; sessionKind: SessionKind; pathKey: string; ext: OutputFileExtension; relPath: string };

/**
 * Parse + validate a bundle-relative path against the frozen output shapes:
 * `index.md` / `index.html` / `manifest.json` or `sessions/<kind>/<pathKey>.<ext>`
 * where kind ∈ {feature, legacy, cto} and pathKey passes {@link isSafePathKey}.
 * Rejects absolute paths, `..`/`.`/empty segments, unknown extensions and any
 * other shape — a path that parses can never escape the visualize root or
 * break the tree structure.
 */
function parseDerivedPage(relPath: string): DerivedPage | null {
  if (typeof relPath !== "string" || relPath.length === 0 || isAbsolute(relPath)) return null;
  const segments = relPath.split("/");
  if (segments.some((s) => s.length === 0 || s === "." || s === "..")) return null;
  if (segments.length === 1 && HUB_FILE_NAMES[segments[0]!] === true) {
    return { kind: "hub", relPath };
  }
  if (segments.length !== 3 || segments[0] !== "sessions") return null;
  const kind = segments[1]!;
  if (SESSION_KINDS[kind] !== true) return null;
  const file = segments[2]!;
  const ext: OutputFileExtension | null = file.endsWith(".html")
    ? "html"
    : file.endsWith(".md")
      ? "md"
      : null;
  if (ext === null) return null;
  const pathKey = file.slice(0, -ext.length - 1);
  if (!isSafePathKey(pathKey)) return null;
  return { kind: "session", sessionKind: kind as SessionKind, pathKey, ext, relPath };
}

// ── Boundary helpers (containment + symlink-escape rejection) ────────────────

/** Realpath the deepest existing ancestor, appending the missing suffix. */
function realish(p: string): string {
  let ancestor = p;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  let ancestorReal = ancestor;
  try {
    ancestorReal = realpathSync(ancestor);
  } catch {
    // keep lexical
  }
  return join(ancestorReal, ...missing);
}

/** True when `candidate` is `rootReal` itself or a descendant of it. */
function isWithin(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}


function validateBundle(files: ReadonlyArray<VisualizeBundleFile>): Set<string> {
  if (files.length === 0) {
    throw new VisualizePublishError("empty-bundle", "publish: nothing to publish (empty bundle)");
  }
  const seen = new Set<string>();
  let hasManifest = false;
  for (const f of files) {
    if (parseDerivedPage(f.relPath) === null) {
      throw new VisualizePublishError("unsafe-relpath", `publish: invalid bundle path "${f.relPath}"`);
    }
    if (seen.has(f.relPath)) {
      throw new VisualizePublishError("duplicate-file", `publish: duplicate bundle path "${f.relPath}"`);
    }
    seen.add(f.relPath);
    if (f.relPath === VISUALIZE_OUTPUT_FILES.manifest) hasManifest = true;
  }
  if (!hasManifest) {
    throw new VisualizePublishError(
      "missing-manifest",
      `publish: bundle must include ${VISUALIZE_OUTPUT_FILES.manifest}`,
    );
  }
  return seen;
}

function samePinnedEntry(
  left: PinnedRootPathEntryInfo | null,
  right: PinnedRootPathEntryInfo | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind && left.dev === right.dev && left.ino === right.ino;
}

const MANIFEST_KEYS = ["schema", "scope", "generatedAt", "renderer", "sessions", "counts"] as const;
const RENDERER_KEYS = ["name", "version"] as const;
const ARTIFACT_COUNT_KEYS = ["produced", "missing", "pending", "skipped", "unreadable"] as const;
const MANIFEST_COUNT_KEYS = [
  "discoveredSessions", "generatedSessions", "generatedPages", "staleSessions", "degradedSessions",
  "artifactTotal", "deadLinks",
] as const;
const MANIFEST_MAX_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return keys.length >= required.length
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function dateString(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function validateManifest(value: unknown): VisualizationManifest | null {
  if (!isJsonObject(value) || !hasExactKeys(value, MANIFEST_KEYS)) return null;
  if (value.schema !== 1 || !oneOf(value.scope, ["selected", "all"] as const) || !dateString(value.generatedAt)) return null;
  if (!isJsonObject(value.renderer) || !hasExactKeys(value.renderer, RENDERER_KEYS)
    || !nonEmptyString(value.renderer.name) || !nonEmptyString(value.renderer.version)) return null;
  if (!Array.isArray(value.sessions)) return null;

  const seenSessions = new Set<string>();
  for (const rawSession of value.sessions) {
    if (!isJsonObject(rawSession) || !hasExactKeys(rawSession, [
      "kind", "id", "pathKey", "title", "task", "workflow", "sourceDigestBounded", "status",
      "staleness", "artifacts", "pages",
    ], ["updatedAt", "regenerateHint"])) return null;
    if (!oneOf(rawSession.kind, ["feature", "legacy", "cto"] as const)
      || !nonEmptyString(rawSession.id)
      || !nonEmptyString(rawSession.pathKey)
      || !isSafePathKey(rawSession.pathKey)
      || !nonEmptyString(rawSession.title)
      || !nonEmptyString(rawSession.task)
      || !nonEmptyString(rawSession.workflow)
      || typeof rawSession.sourceDigestBounded !== "string"
      || !/^[0-9a-f]{16}$/u.test(rawSession.sourceDigestBounded)
      || !oneOf(rawSession.status, ["complete", "degraded"] as const)
      || !oneOf(rawSession.staleness, ["fresh", "stale", "unknown"] as const)) return null;
    if (rawSession.updatedAt !== undefined && !dateString(rawSession.updatedAt)) return null;
    if (rawSession.regenerateHint !== undefined && !nonEmptyString(rawSession.regenerateHint)) return null;
    const sessionKey = `${rawSession.kind}/${rawSession.pathKey}`;
    if (seenSessions.has(sessionKey)) return null;
    seenSessions.add(sessionKey);

    const artifacts = rawSession.artifacts;
    if (!isJsonObject(artifacts) || !hasExactKeys(artifacts, ARTIFACT_COUNT_KEYS)
      || ARTIFACT_COUNT_KEYS.some((key) => !nonNegativeInteger(artifacts[key]))) return null;
    if (!Array.isArray(rawSession.pages) || rawSession.pages.length !== 2
      || rawSession.pages[0] !== `sessions/${rawSession.kind}/${rawSession.pathKey}.md`
      || rawSession.pages[1] !== `sessions/${rawSession.kind}/${rawSession.pathKey}.html`
      || rawSession.pages.some((page) => typeof page !== "string" || parseDerivedPage(page) === null)) return null;
    if (rawSession.staleness === "stale" && rawSession.regenerateHint === undefined) return null;
    if (rawSession.staleness !== "stale" && rawSession.regenerateHint !== undefined) return null;
  }

  const counts = value.counts;
  if (!isJsonObject(counts) || !hasExactKeys(counts, MANIFEST_COUNT_KEYS)
    || MANIFEST_COUNT_KEYS.some((key) => !nonNegativeInteger(counts[key]))) return null;
  return value as unknown as VisualizationManifest;
}

interface ExactFileSnapshot {
  info: PinnedRootPathEntryInfo;
  bytes: Buffer;
  expectation: { dev: number; ino: number; sha256: string; size: number };
}

interface CompleteBundleSnapshot {
  root: PinnedRootPathEntryInfo;
  entries: string[];
  manifest: VisualizationManifest;
  files: Map<string, ExactFileSnapshot>;
}

function readExactRegularFile(
  pin: PinnedProjectRoot,
  relativePath: string,
  maxBytes: number | undefined,
  afterFirstRead?: () => void,
): ExactFileSnapshot | null {
  const info = pin.pathEntryInfo(relativePath);
  if (info === null || info.kind !== "file") return null;
  const first = pin.readFile(relativePath, maxBytes === undefined ? {} : { maxBytes });
  const firstBytes = Buffer.from(first.bytes);
  if (first.dev !== info.dev || first.ino !== info.ino || first.size !== info.size || firstBytes.byteLength !== info.size) return null;
  const sha256 = createHash("sha256").update(firstBytes).digest("hex");
  afterFirstRead?.();
  const second = pin.readFile(relativePath, maxBytes === undefined ? {} : { maxBytes });
  const secondBytes = Buffer.from(second.bytes);
  if (second.dev !== info.dev || second.ino !== info.ino || second.size !== info.size
    || secondBytes.byteLength !== info.size
    || !secondBytes.equals(firstBytes)
    || createHash("sha256").update(secondBytes).digest("hex") !== sha256) return null;
  const finalInfo = pin.pathEntryInfo(relativePath);
  if (!samePinnedEntry(finalInfo, info) || finalInfo?.size !== info.size) return null;
  const finalRead = pin.readFile(relativePath, maxBytes === undefined ? {} : { maxBytes });
  const finalBytes = Buffer.from(finalRead.bytes);
  if (finalRead.dev !== info.dev || finalRead.ino !== info.ino || finalRead.size !== info.size
    || finalBytes.byteLength !== info.size || !finalBytes.equals(firstBytes)) return null;
  return { info, bytes: firstBytes, expectation: { dev: info.dev, ino: info.ino, sha256, size: info.size } };
}

function inspectCompleteBundle(
  pin: PinnedProjectRoot,
  relativeDirectory: string,
  expectedRoot: PinnedRootPathEntryInfo,
  afterFirstRead?: (relativePath: string) => void,
): CompleteBundleSnapshot | null {
  if (expectedRoot.kind !== "directory") return null;
  const root = pin.pathEntryInfo(relativeDirectory);
  if (!samePinnedEntry(root, expectedRoot) || root?.kind !== "directory") return null;
  let entries: string[];
  try { entries = pin.listDirectory(relativeDirectory).sort(); } catch { return null; }
  const manifestPath = join(relativeDirectory, VISUALIZE_OUTPUT_FILES.manifest);
  const manifestFile = readExactRegularFile(pin, manifestPath, MANIFEST_MAX_BYTES, () => afterFirstRead?.(VISUALIZE_OUTPUT_FILES.manifest));
  if (manifestFile === null) return null;
  let manifest: VisualizationManifest | null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.bytes);
    manifest = validateManifest(JSON.parse(text));
  } catch {
    return null;
  }
  if (manifest === null) return null;
  const paths = [
    VISUALIZE_OUTPUT_FILES.hubMarkdown,
    VISUALIZE_OUTPUT_FILES.hubHtml,
    VISUALIZE_OUTPUT_FILES.manifest,
    ...manifest.sessions.flatMap((session) => session.pages),
  ];
  const files = new Map<string, ExactFileSnapshot>();
  for (const path of paths) {
    if (files.has(path)) return null;
    const file = path === VISUALIZE_OUTPUT_FILES.manifest
      ? manifestFile
      : readExactRegularFile(pin, join(relativeDirectory, path), undefined, () => afterFirstRead?.(path));
    if (file === null) return null;
    files.set(path, file);
  }
  const finalRoot = pin.pathEntryInfo(relativeDirectory);
  if (!samePinnedEntry(finalRoot, expectedRoot) || finalRoot?.kind !== "directory") return null;
  let finalEntries: string[];
  try { finalEntries = pin.listDirectory(relativeDirectory).sort(); } catch { return null; }
  if (entries.length !== finalEntries.length || entries.some((entry, index) => entry !== finalEntries[index])) return null;
  for (const [path, snapshot] of files) {
    const finalInfo = pin.pathEntryInfo(join(relativeDirectory, path));
    if (!samePinnedEntry(finalInfo, snapshot.info) || finalInfo?.size !== snapshot.info.size) return null;
  }
  return { root: expectedRoot, entries, manifest, files };
}

function removePinnedTreeIfMatches(
  pin: PinnedProjectRoot,
  relativePath: string,
  expectedRoot?: PinnedRootPathEntryInfo,
): boolean {
  const info = pin.pathEntryInfo(relativePath);
  if (info === null) return expectedRoot === undefined;
  if (expectedRoot !== undefined && !samePinnedEntry(info, expectedRoot)) return false;
  if (info.kind === "file") {
    const file = readExactRegularFile(pin, relativePath, undefined);
    if (file === null) return false;
    try {
      pin.removeFileIfMatches(relativePath, file.expectation);
      return pin.pathEntryInfo(relativePath) === null;
    } catch {
      return false;
    }
  }
  if (info.kind !== "directory") return false;
  let names: string[];
  try { names = pin.listDirectory(relativePath); } catch { return false; }
  for (const name of names) {
    if (!removePinnedTreeIfMatches(pin, join(relativePath, name))) return false;
  }
  const after = pin.pathEntryInfo(relativePath);
  if (!samePinnedEntry(after, info) || after?.kind !== "directory") return false;
  try { return pin.removeEmptyDirectoryIfMatches(relativePath, { dev: info.dev, ino: info.ino }); } catch { return false; }
}

function removePinnedTree(pin: PinnedProjectRoot, relativePath: string): void {
  const info = pin.pathEntryInfo(relativePath);
  if (info === null) return;
  if (info.kind !== "directory") {
    pin.removeEntry(relativePath);
    return;
  }
  for (const name of pin.listDirectory(relativePath)) {
    removePinnedTree(pin, join(relativePath, name));
  }
  pin.removeDirectory(relativePath);
}

function cleanupPinnedTree(pin: PinnedProjectRoot, relativePath: string): void {
  try {
    removePinnedTree(pin, relativePath);
  } catch {
    // Cleanup is best effort; the primary publish error is more useful.
  }
}

interface PruneOutcome {
  pruned: string[];
  preserved: number;
  warnings: string[];
}

function mergePrunePinned(
  pin: PinnedProjectRoot,
  backupDirectory: string,
  targetDirectory: string,
  newFiles: ReadonlySet<string>,
): PruneOutcome {
  const pruned: string[] = [];
  const warnings: string[] = [];
  let preserved = 0;
  const mutate = (operation: () => void): void => {
    if (!pin.isStable()) throw new PinnedRootError("changed", "project root changed during visualize publish");
    operation();
    if (!pin.isStable()) throw new PinnedRootError("changed", "project root changed during visualize publish");
  };
  const walk = (backup: string, target: string, relativeToVisualize: string): void => {
    for (const name of pin.listDirectory(backup)) {
      const backupEntry = join(backup, name);
      const targetEntry = join(target, name);
      const relativeEntry = join(relativeToVisualize, name);
      const info = pin.pathEntryInfo(backupEntry);
      if (info === null) continue;
      if (parseDerivedPage(relativeEntry) !== null) {
        if (!newFiles.has(relativeEntry)) pruned.push(relativeEntry);
        mutate(() => removePinnedTree(pin, backupEntry));
        continue;
      }
      const targetInfo = pin.pathEntryInfo(targetEntry);
      if (info.kind === "directory") {
        if (targetInfo !== null && targetInfo.kind !== "directory") {
          warnings.push(`preserved non-derived entry "${relativeEntry}" in the stale backup`);
          continue;
        }
        if (targetInfo === null) mutate(() => pin.ensureDirectory(targetEntry));
        walk(backupEntry, targetEntry, relativeEntry);
        try {
          mutate(() => pin.removeDirectory(backupEntry));
        } catch (error) {
          if (!(error instanceof PinnedRootError && (error.code === "not_found" || error.code === "write_failed"))) {
            throw error;
          }
        }
        continue;
      }
      if (targetInfo !== null) {
        warnings.push(`preserved non-derived entry "${relativeEntry}" in the stale backup`);
        continue;
      }
      mutate(() => pin.renameFileExclusive(backupEntry, targetEntry));
      preserved += 1;
    }
  };
  walk(backupDirectory, targetDirectory, "");
  return { pruned, warnings, preserved };
}

// ── Public entry ─────────────────────────────────────────────────────────────

const SWAP_ROLLBACK_WARNING =
  `publish: swap-rollback — a newer complete bundle is live at ${VISUALIZE_OUTPUT_ROOT}; discarding staging/backup`;
const PRESERVED_WARNING_PREFIX = "publish: preserved non-derived output entries in the new bundle (moved back): ";

export function publishVisualizePinned(
  cwd: string,
  files: ReadonlyArray<VisualizeBundleFile>,
  pin: PinnedProjectRoot,
  options: PublishVisualizeOptions = {},
): VisualizePublishResult {
  const seen = validateBundle(files);
  if (resolve(cwd) !== pin.lexical_root) {
    throw new VisualizePublishError("boundary-escape", "publish: pinned project root does not match the project");
  }

  const workspaceLexical = resolve(cwd, WORK_STATE_DIR);
  const workspaceReal = realish(workspaceLexical);
  const workspaceRelative = pin.relativePath(workspaceReal);
  if (workspaceRelative === null || !isWithin(pin.canonical_root, workspaceReal)) {
    throw new VisualizePublishError("boundary-escape", "publish: .work-state escapes the project boundary");
  }
  const targetRelative = join(workspaceRelative, "visualize");
  const ensureWorkspaceStable = (): void => {
    if (!pin.isStable() || realish(workspaceLexical) !== workspaceReal) {
      throw new VisualizePublishError("boundary-escape", "publish: project boundary changed during publish");
    }
  };

  let targetInfo: PinnedRootPathEntryInfo | null;
  try {
    ensureWorkspaceStable();
    const workspaceInfo = pin.pathEntryInfo(workspaceRelative);
    if (workspaceInfo !== null && workspaceInfo.kind !== "directory") {
      throw new VisualizePublishError("destination-conflict", "publish: .work-state is not a directory");
    }
    targetInfo = pin.pathEntryInfo(targetRelative);
    if (targetInfo !== null && targetInfo.kind !== "directory") {
      throw new VisualizePublishError(
        "destination-conflict",
        `publish: target is not a directory (${VISUALIZE_OUTPUT_ROOT})`,
      );
    }
  } catch (error) {
    if (error instanceof VisualizePublishError) throw error;
    throw new VisualizePublishError("boundary-escape", "publish: destination could not be inspected safely");
  }

  const nonce = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const stagingRelative = join(workspaceRelative, `.visualize-staging-${nonce}`);
  const backupRelative = join(workspaceRelative, `.visualize-backup-${nonce}`);
  const stagingPath = pin.anchorPath(stagingRelative);
  const backupPath = pin.anchorPath(backupRelative);
  const targetPath = pin.anchorPath(targetRelative);
  const emptyResult = (warnings: string[]): VisualizePublishResult => ({
    status: "superseded",
    files: [],
    pruned: [],
    counters: { filesWritten: 0, bytesWritten: 0, filesPruned: 0 },
    warnings,
  });

  try {
    ensureWorkspaceStable();
    if (pin.pathEntryExists(stagingRelative) || pin.pathEntryExists(backupRelative)) {
      throw new PinnedRootError("exists", "staging name already exists");
    }
    pin.ensureDirectory(workspaceRelative);
    pin.ensureDirectory(stagingRelative);
    ensureWorkspaceStable();
  } catch (error) {
    cleanupPinnedTree(pin, stagingRelative);
    if (error instanceof VisualizePublishError) throw error;
    throw new VisualizePublishError("staging-failed", "publish: could not create staging directory");
  }

  let bytesWritten = 0;
  let lastRelPath: string | null = null;
  try {
    options.hooks?.onStagingCreated?.(stagingPath);
    for (const file of files) {
      lastRelPath = file.relPath;
      ensureWorkspaceStable();
      pin.ensureDirectory(dirname(join(stagingRelative, ...file.relPath.split("/"))));
      ensureWorkspaceStable();
      pin.writeAtomic(join(stagingRelative, ...file.relPath.split("/")), file.content);
      ensureWorkspaceStable();
      bytesWritten += Buffer.byteLength(file.content, "utf8");
    }
  } catch (error) {
    cleanupPinnedTree(pin, stagingRelative);
    if (error instanceof VisualizePublishError) throw error;
    const where = lastRelPath === null ? "" : ` for "${lastRelPath}"`;
    throw new VisualizePublishError("write-failed", `publish: staging write failed${where}`);
  }

  let stagingInfo: PinnedRootPathEntryInfo | null = pin.pathEntryInfo(stagingRelative);
  let backupCaptured = false;
  let backupInfo: PinnedRootPathEntryInfo | null = null;
  const restoreCaptured = (): void => {
    if (!backupCaptured) return;
    try {
      if (pin.pathEntryInfo(targetRelative) === null) pin.renameFileExclusive(backupRelative, targetRelative);
    } catch {
      // Preserve the backup if restoration cannot be completed safely.
    }
  };

  try {
    ensureWorkspaceStable();
    options.hooks?.onBeforeCapture?.(targetPath);
    ensureWorkspaceStable();
    const observedTarget = pin.pathEntryInfo(targetRelative);
    if (!samePinnedEntry(observedTarget, targetInfo)) {
      throw new VisualizePublishError("capture-failed", "publish: destination changed before capture");
    }
    if (observedTarget !== null) {
      if (pin.pathEntryExists(backupRelative)) {
        throw new VisualizePublishError("capture-failed", "publish: backup destination already exists");
      }
      pin.renameFileExclusive(targetRelative, backupRelative);
      backupCaptured = true;
      backupInfo = pin.pathEntryInfo(backupRelative);
      if (backupInfo === null || backupInfo.kind !== "directory") {
        throw new PinnedRootError("changed", "captured bundle disappeared before swap");
      }
    }
    ensureWorkspaceStable();
  } catch (error) {
    cleanupPinnedTree(pin, stagingRelative);
    restoreCaptured();
    if (error instanceof VisualizePublishError) throw error;
    if (error instanceof PinnedRootError && error.code === "not_found") {
      // Another writer won the capture race; there is no previous bundle to restore.
    } else {
      throw new VisualizePublishError("capture-failed", "publish: old bundle capture failed");
    }
  }

  try {
    options.hooks?.onCaptured?.(backupCaptured ? backupPath : null);
  } catch {
    cleanupPinnedTree(pin, stagingRelative);
    restoreCaptured();
    throw new VisualizePublishError("swap-failed", "publish: publish aborted before the atomic swap");
  }

  const verifyStaging = (): void => {
    ensureWorkspaceStable();
    for (const file of files) {
      const info = pin.pathEntryInfo(join(stagingRelative, ...file.relPath.split("/")));
      if (info === null || info.kind !== "file") {
        throw new VisualizePublishError("swap-failed", "publish: staged bundle changed before the atomic swap");
      }
    }
    ensureWorkspaceStable();
  };

  const recoveryRequired = (message: string): never => {
    throw new VisualizePublishError("recovery_required", message);
  };

  const recoverFailedSwap = (): VisualizePublishResult => {
    const warnings: string[] = [];
    const initialTargetInfo = pin.pathEntryInfo(targetRelative);
    const targetPresent = initialTargetInfo !== null;
    let targetComplete = false;

    if (initialTargetInfo?.kind === "directory") {
      try {
        options.hooks?.onBeforeRecoveryValidation?.(targetPath);
        const snapshot = inspectCompleteBundle(
          pin,
          targetRelative,
          initialTargetInfo,
          (relativePath) => options.hooks?.onAfterRecoveryFileRead?.(targetPath, relativePath),
        );
        if (snapshot !== null) {
          // Revalidate immediately before any private scratch tree is discarded.
          targetComplete = inspectCompleteBundle(pin, targetRelative, initialTargetInfo) !== null;
        }
      } catch {
        targetComplete = false;
      }
    }

    if (!backupCaptured) {
      if (targetComplete) {
        if (stagingInfo === null || !removePinnedTreeIfMatches(pin, stagingRelative, stagingInfo)) {
          recoveryRequired("publish: recovery required; validated winner present but staging ownership was not proven");
        }
        warnings.push(SWAP_ROLLBACK_WARNING);
        return emptyResult(warnings);
      }
      // No previous bundle exists. A malformed or foreign target is preserved;
      // staging cleanup is only attempted when the target is still absent.
      if (targetPresent) {
        throw new VisualizePublishError("swap-failed", "publish: atomic swap failed; an invalid concurrent target was preserved");
      }
      cleanupPinnedTree(pin, stagingRelative);
      throw new VisualizePublishError("swap-failed", "publish: atomic swap failed");
    }

    if (targetComplete) {
      // The current complete target wins. Discard only private trees after an
      // exact descriptor/hash ownership proof; never remove the winner.
      if (backupInfo === null || !removePinnedTreeIfMatches(pin, backupRelative, backupInfo)) {
        recoveryRequired("publish: recovery required; validated winner present but backup ownership was not proven");
      }
      if (stagingInfo === null || !removePinnedTreeIfMatches(pin, stagingRelative, stagingInfo)) {
        recoveryRequired("publish: recovery required; validated winner present but staging ownership was not proven");
      }
      warnings.push(SWAP_ROLLBACK_WARNING);
      return emptyResult(warnings);
    }

    if (targetPresent) {
      // A present but incomplete/changed target is foreign. Keep it and both
      // private trees intact so an operator can recover without guessing.
      recoveryRequired("publish: recovery required; invalid concurrent target preserved and backup remains intact");
    }

    if (backupInfo === null || !inspectCompleteBundle(pin, backupRelative, backupInfo)) {
      recoveryRequired("publish: recovery required; captured backup is incomplete or changed");
    }
    // Only an absent target may receive the captured bundle, and the exclusive
    // rename keeps a target created after this check from being overwritten.
    if (pin.pathEntryInfo(targetRelative) !== null) {
      recoveryRequired("publish: recovery required; concurrent target appeared before rollback");
    }
    try {
      pin.renameFileExclusive(backupRelative, targetRelative);
    } catch {
      recoveryRequired("publish: recovery required; previous bundle preserved in a backup directory");
    }
    if (stagingInfo !== null && !removePinnedTreeIfMatches(pin, stagingRelative, stagingInfo)) {
      recoveryRequired("publish: recovery required; restored bundle is live but staging remains for recovery");
    }
    throw new VisualizePublishError("swap-failed", "publish: atomic swap failed; previous bundle restored");
  };

  try {
    ensureWorkspaceStable();
    if (pin.pathEntryInfo(targetRelative) !== null) return recoverFailedSwap();
    options.hooks?.onBeforeSwap?.(stagingPath, targetPath);
    ensureWorkspaceStable();
    verifyStaging();
    if (pin.pathEntryInfo(targetRelative) !== null) return recoverFailedSwap();
    pin.renameFileExclusive(stagingRelative, targetRelative);
    ensureWorkspaceStable();
  } catch (error) {
    if (error instanceof VisualizePublishError) throw error;
    return recoverFailedSwap();
  }
  const publishedTargetInfo = pin.pathEntryInfo(targetRelative);
  if (publishedTargetInfo === null || publishedTargetInfo.kind !== "directory") {
    throw new VisualizePublishError("swap-failed", "publish: atomic swap produced an invalid target");
  }
  const publishedFileInfos = files.map((file) => ({
    path: join(targetRelative, ...file.relPath.split("/")),
    info: pin.pathEntryInfo(join(targetRelative, ...file.relPath.split("/"))),
  }));
  const verifyPublishedTree = (): void => {
    ensureWorkspaceStable();
    if (!samePinnedEntry(pin.pathEntryInfo(targetRelative), publishedTargetInfo)) {
      throw new VisualizePublishError("swap-failed", "publish: target changed during prune");
    }
    for (const entry of publishedFileInfos) {
      if (entry.info === null || entry.info.kind !== "file" || !samePinnedEntry(pin.pathEntryInfo(entry.path), entry.info)) {
        throw new VisualizePublishError("swap-failed", "publish: target leaf changed during prune");
      }
    }
    ensureWorkspaceStable();
  };
  const result: VisualizePublishResult = {
    status: "published",
    files: [...seen].sort().map((relPath) => `${VISUALIZE_OUTPUT_ROOT}/${relPath}`),
    pruned: [],
    counters: { filesWritten: files.length, bytesWritten, filesPruned: 0 },
    warnings: [],
  };
  if (backupCaptured) {
    try {
      verifyPublishedTree();
      options.hooks?.onBeforePrune?.(backupPath, targetPath);
      verifyPublishedTree();
      const outcome = mergePrunePinned(pin, backupRelative, targetRelative, seen);
      verifyPublishedTree();
      result.pruned = outcome.pruned.map((relPath) => `${VISUALIZE_OUTPUT_ROOT}/${relPath}`).sort();
      result.counters.filesPruned = outcome.pruned.length;
      if (outcome.preserved > 0) {
        result.warnings.push(`${PRESERVED_WARNING_PREFIX}${outcome.preserved} entrie(s)`);
      }
      result.warnings.push(...outcome.warnings);
      cleanupPinnedTree(pin, backupRelative);
    } catch (error) {
      try {
        verifyPublishedTree();
      } catch (integrityError) {
        // The target no longer matches the exact root/leaf descriptors that
        // this publisher installed.  It may be a complete newer bundle, or a
        // hostile replacement.  Never recursively delete it or restore the
        // stale backup over an unowned target; leave the backup quarantined for
        // recovery and surface the integrity failure.
        throw integrityError;
      }
      result.warnings.push(
        `publish: could not fully prune the previous bundle (stale backup left in ${WORK_STATE_DIR})`,
      );
      cleanupPinnedTree(pin, backupRelative);
    }
  }
  ensureWorkspaceStable();
  return result;
}

export function publishVisualize(
  cwd: string,
  files: ReadonlyArray<VisualizeBundleFile>,
  options: PublishVisualizeOptions = {},
): VisualizePublishResult {
  // Preserve bundle validation errors even when the project root is absent.
  validateBundle(files);
  const pin = PinnedProjectRoot.open(cwd);
  if (pin === null) {
    throw new VisualizePublishError("boundary-escape", "publish: project root cannot be pinned");
  }
  try {
    return publishVisualizePinned(cwd, files, pin, options);
  } finally {
    pin.close();
  }
}
