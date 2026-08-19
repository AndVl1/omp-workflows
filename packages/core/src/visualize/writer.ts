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

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  VISUALIZE_OUTPUT_FILES,
  VISUALIZE_OUTPUT_ROOT,
  isSafePathKey,
  type OutputFileExtension,
  type SessionKind,
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
  | "rollback-failed";

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
  /** Invoked after the old target capture, before the atomic swap. `backupDir` is null when there was no previous bundle. */
  onCaptured?(backupDir: string | null): void;
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

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

/** Best-effort recursive removal — never throws. */
function safeRm(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // best effort — callers surface a warning when the leftover matters
  }
}

/** Pin exact modes across the tree: dirs 0700, files 0600 (umask-proof). */
function enforceModes(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (lstatSync(p).isDirectory()) {
        chmodSync(p, 0o700);
        stack.push(p);
      } else {
        chmodSync(p, 0o600);
      }
    }
  }
}

/** The bundle's manifest `generatedAt`; undefined when absent/unreadable. */
function manifestGeneratedAt(dirPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dirPath, VISUALIZE_OUTPUT_FILES.manifest), "utf8")) as {
      generatedAt?: unknown;
    };
    return typeof parsed.generatedAt === "string" ? parsed.generatedAt : undefined;
  } catch {
    return undefined;
  }
}

/** Strictly newer: later ISO timestamp (Date.parse, then lexical fallback). */
function isStrictlyNewer(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const am = Date.parse(a);
  const bm = Date.parse(b);
  if (Number.isFinite(am) && Number.isFinite(bm)) return am > bm;
  return a > b;
}

// ── Pruning (old derived pages only; non-derived entries are preserved) ──────

interface PruneOutcome {
  pruned: string[];
  preserved: number;
  warnings: string[];
}

/**
 * Reconcile the captured old tree (`backupDir`) against the freshly swapped
 * target:
 * - derived pages not regenerated by the new bundle are pruned;
 * - derived pages regenerated by the new bundle are removed from the backup
 *   (the new tree already holds the fresh copy);
 * - non-derived entries (user-authored files/dirs, unrecognized shapes) are
 *   moved back into the target so they survive republishes; symlinks are
 *   renamed/removed without ever being followed.
 * Returns paths relative to the visualize root plus counters and warnings.
 */
function mergePrune(backupDir: string, targetDir: string, newFiles: ReadonlySet<string>): PruneOutcome {
  const pruned: string[] = [];
  const warnings: string[] = [];
  let preserved = 0;
  const walk = (b: string, t: string): void => {
    for (const name of readdirSync(b).sort()) {
      const bAbs = join(b, name);
      const rel = relative(backupDir, bAbs);
      const st = lstatSync(bAbs);
      if (parseDerivedPage(rel) !== null) {
        // Derived page: never preserved; pruned unless the new bundle regenerates it.
        if (!newFiles.has(rel)) pruned.push(rel);
        rmSync(bAbs, { recursive: true, force: true });
        continue;
      }
      const tAbs = join(t, name);
      if (st.isDirectory()) {
        // Non-derived directory: descend and classify children individually,
        // even when the destination is absent, so nested derived pages are
        // still pruned instead of being dragged back as "preserved" content.
        if (existsSync(tAbs)) {
          if (!lstatSync(tAbs).isDirectory()) {
            warnings.push(`preserved non-derived entry "${rel}" in the stale backup`);
            continue;
          }
        } else {
          mkdirSync(tAbs, { recursive: true, mode: 0o700 });
        }
        walk(bAbs, tAbs);
        continue;
      }
      if (existsSync(tAbs)) {
        // Should not occur with validated bundles; keep the entry safe from deletion.
        warnings.push(`preserved non-derived entry "${rel}" in the stale backup`);
        continue;
      }
      renameSync(bAbs, tAbs);
      preserved += 1;
    }
  };
  walk(backupDir, targetDir);
  return { pruned, warnings, preserved };
}

// ── Public entry ─────────────────────────────────────────────────────────────

const SWAP_ROLLBACK_WARNING =
  `publish: swap-rollback — a newer complete bundle is live at ${VISUALIZE_OUTPUT_ROOT}; discarding staging/backup`;
const PRESERVED_WARNING_PREFIX = "publish: preserved non-derived output entries in the new bundle (moved back): ";

export function publishVisualize(
  cwd: string,
  files: ReadonlyArray<VisualizeBundleFile>,
  options: PublishVisualizeOptions = {},
): VisualizePublishResult {
  // 1. Bundle validation (preflight) — before any filesystem mutation, so a
  //    no-session/preflight error can never create a target tree.
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

  // 2. Root/destination validation (boundary + symlink escapes).
  const wsRoot = resolve(cwd, WORK_STATE_DIR);
  const rootReal = realish(wsRoot);
  const target = resolve(cwd, VISUALIZE_OUTPUT_ROOT);
  try {
    if (existsSync(target)) {
      const st = lstatSync(target);
      if (st.isSymbolicLink()) {
        throw new VisualizePublishError(
          "destination-conflict",
          `publish: target must not be a symlink (${VISUALIZE_OUTPUT_ROOT})`,
        );
      }
      if (!st.isDirectory()) {
        throw new VisualizePublishError(
          "destination-conflict",
          `publish: target is not a directory (${VISUALIZE_OUTPUT_ROOT})`,
        );
      }
      if (!isWithin(rootReal, realish(target))) {
        throw new VisualizePublishError(
          "boundary-escape",
          `publish: target escapes the .work-state boundary (${VISUALIZE_OUTPUT_ROOT})`,
        );
      }
    }
  } catch (err) {
    if (isEnoent(err)) {
      // raced away between existsSync and lstat — treat as absent
    } else {
      throw err;
    }
  }
  try {
    // stat (follows symlinks): a symlinked .work-state root is a legitimate
    // boundary, only a non-directory target is a conflict.
    if (existsSync(wsRoot) && !statSync(wsRoot).isDirectory()) {
      throw new VisualizePublishError("destination-conflict", "publish: .work-state is not a directory");
    }
  } catch (err) {
    if (isEnoent(err)) {
      // .work-state absent is fine — it is created with the staging parent
    } else {
      throw err;
    }
  }

  // 3. Staging: fresh sibling directory inside .work-state, never inside the
  //    target (the swap renames the whole target, so staging must not move
  //    with it). Files are pinned to 0600, directories to 0700.
  const nonce = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const staging = join(dirname(target), `.visualize-staging-${nonce}`);
  const backup = join(dirname(target), `.visualize-backup-${nonce}`);
  try {
    mkdirSync(dirname(staging), { recursive: true, mode: 0o700 });
    mkdirSync(staging, { mode: 0o700 });
    if (!isWithin(rootReal, realish(staging))) {
      safeRm(staging);
      throw new VisualizePublishError("boundary-escape", "publish: staging escapes the .work-state boundary");
    }
  } catch (err) {
    if (err instanceof VisualizePublishError) throw err;
    throw new VisualizePublishError("staging-failed", "publish: could not create staging directory");
  }

  let bytesWritten = 0;
  let lastRelPath: string | null = null;
  try {
    options.hooks?.onStagingCreated?.(staging);
    for (const f of files) {
      lastRelPath = f.relPath;
      const abs = join(staging, ...f.relPath.split("/"));
      mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
      writeFileSync(abs, f.content, { encoding: "utf8", mode: 0o600 });
      chmodSync(abs, 0o600);
      bytesWritten += Buffer.byteLength(f.content, "utf8");
    }
    enforceModes(staging);
  } catch (err) {
    safeRm(staging);
    if (err instanceof VisualizePublishError) throw err;
    const where = lastRelPath === null ? "" : ` for "${lastRelPath}"`;
    throw new VisualizePublishError("write-failed", `publish: staging write failed${where}`);
  }

  // 4. Capture the old target by atomic rename. ENOENT means another writer
  //    swapped the tree away between the checks — no previous bundle to
  //    capture; proceed without a backup (contract).
  let backupDir: string | null = null;
  try {
    if (existsSync(target)) {
      renameSync(target, backup);
      backupDir = backup;
    }
  } catch (err) {
    if (isEnoent(err)) {
      // no previous bundle — proceed
    } else {
      safeRm(staging);
      throw new VisualizePublishError("capture-failed", "publish: old bundle capture failed");
    }
  }

  try {
    options.hooks?.onCaptured?.(backupDir);
  } catch {
    safeRm(staging);
    if (backupDir !== null) {
      try {
        renameSync(backupDir, target);
      } catch {
        // previous bundle preserved in the backup directory; surfaced below
      }
    }
    throw new VisualizePublishError("swap-failed", "publish: publish aborted before the atomic swap");
  }

  // 5. Atomic swap of the complete tree. On failure the rollback guard
  //    decides between restoring the captured bundle and discarding it
  //    (never restoring an older tree over a newer complete target).
  try {
    renameSync(staging, target);
  } catch {
    return recoverFailedSwap();
  }

  // 6. Prune old derived pages; preserve non-derived entries; drop the backup.
  const result: VisualizePublishResult = {
    status: "published",
    files: [...seen].sort().map((relPath) => `${VISUALIZE_OUTPUT_ROOT}/${relPath}`),
    pruned: [],
    counters: { filesWritten: files.length, bytesWritten, filesPruned: 0 },
    warnings: [],
  };
  if (backupDir !== null) {
    try {
      const outcome = mergePrune(backupDir, target, seen);
      result.pruned = outcome.pruned.map((relPath) => `${VISUALIZE_OUTPUT_ROOT}/${relPath}`).sort();
      result.counters.filesPruned = outcome.pruned.length;
      if (outcome.preserved > 0) {
        result.warnings.push(`${PRESERVED_WARNING_PREFIX}${outcome.preserved} entrie(s)`);
      }
      result.warnings.push(...outcome.warnings);
      rmSync(backupDir, { recursive: true, force: true });
    } catch {
      // The new bundle is already live and complete; pruning is best-effort.
      result.warnings.push(
        `publish: could not fully prune the previous bundle (stale backup left in ${WORK_STATE_DIR})`,
      );
    }
  }
  return result;

  function recoverFailedSwap(): VisualizePublishResult {
    const warnings: string[] = [];
    const targetComplete = manifestGeneratedAt(target) !== undefined;
    if (backupDir === null) {
      // No previous bundle captured: never clobber a complete live tree.
      if (targetComplete) {
        safeRm(staging);
        warnings.push(SWAP_ROLLBACK_WARNING);
        return { status: "superseded", files: [], pruned: [], counters: { filesWritten: 0, bytesWritten: 0, filesPruned: 0 }, warnings };
      }
      safeRm(staging);
      throw new VisualizePublishError("swap-failed", "publish: atomic swap failed");
    }
    if (targetComplete) {
      const backupTs = manifestGeneratedAt(backupDir);
      const targetTs = manifestGeneratedAt(target);
      if (isStrictlyNewer(backupTs, targetTs)) {
        // Sanctioned restore: our backup is strictly newer than the live tree.
        try {
          rmSync(target, { recursive: true, force: true });
          renameSync(backupDir, target);
        } catch {
          safeRm(staging);
          throw new VisualizePublishError(
            "rollback-failed",
            "publish: rollback failed; previous bundle preserved in a backup directory",
          );
        }
        safeRm(staging);
        throw new VisualizePublishError("swap-failed", "publish: atomic swap failed; previous bundle restored");
      }
      // A newer (or equally fresh) complete bundle is live: never restore an
      // older tree over it — discard staging/backup with a rollback warning.
      safeRm(backupDir);
      safeRm(staging);
      warnings.push(SWAP_ROLLBACK_WARNING);
      return { status: "superseded", files: [], pruned: [], counters: { filesWritten: 0, bytesWritten: 0, filesPruned: 0 }, warnings };
    }
    if (!existsSync(target)) {
      // Nothing live: restore the captured previous bundle.
      try {
        renameSync(backupDir, target);
      } catch {
        safeRm(staging);
        throw new VisualizePublishError(
          "rollback-failed",
          "publish: rollback failed; previous bundle preserved in a backup directory",
        );
      }
      safeRm(staging);
      throw new VisualizePublishError("swap-failed", "publish: atomic swap failed; previous bundle restored");
    }
    // The target holds non-derived content: preserve it, discard our tree.
    safeRm(backupDir);
    safeRm(staging);
    warnings.push(
      "publish: swap failed and the target is not a complete bundle; the previous bundle was discarded to preserve non-derived content",
    );
    return { status: "superseded", files: [], pruned: [], counters: { filesWritten: 0, bytesWritten: 0, filesPruned: 0 }, warnings };
  }
}
