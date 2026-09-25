/**
 * Typed artifact I/O. Stages declare `consumes` and `produces` artifact ids;
 * the engine reads/writes them under `.work-state/artifacts/<id>.json` (or per-feature
 * subdir, set by `state.ts`).
 *
 * The schema is the same as claude-plugin's `workflows/artifacts-schema.json`.
 * We don't validate every field here — the engine only checks that the JSON
 * parses and matches the type name — but the schema is preserved for ref.
 */

import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { lifecycleTransactionStatus } from "./lifecycle-journal.js";
import { recordArtifactWritten } from "../observability/hooks.js";

const ARTIFACT_ID_RE = /^[A-Za-z0-9._-]+$/;
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalRunIdFromArtifactsDir(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/");
  const match = normalized.match(new RegExp(`/\\.work-state/runs/(${RUN_ID_RE.source})/artifacts(?:/|$)`, "i"));
  return match?.[1];
}

function assertArtifactId(id: string): void {
  if (!isSafeArtifactId(id)) {
    throw new Error(`unsafe artifact id: ${id}`);
  }
}

/** The canonical artifact-id/safe-path-segment rule used by artifact I/O. */
export function isSafeArtifactId(id: string): boolean {
  return ARTIFACT_ID_RE.test(id) && id !== "." && id !== "..";
}

export type ArtifactInputRead =
  | { status: "absent"; path: string }
  | { status: "invalid"; path: string; error: string }
  | { status: "present"; path: string; content: string; value: unknown };
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pinnedDirectoryRejection(root: string, directoryFd: number, opened: Stats): string | null {
  let currentFd: Stats;
  try {
    currentFd = fstatSync(directoryFd);
  } catch (error) {
    return `artifacts directory is unreadable: ${(error as Error).message}`;
  }
  if (!currentFd.isDirectory()) return "artifacts directory is not a directory";
  if (!sameFileIdentity(currentFd, opened)) return "artifacts directory changed while it was being read";

  let currentPath: Stats;
  try {
    currentPath = lstatSync(root);
  } catch (error) {
    return `artifacts directory changed while it was being read: ${(error as Error).message}`;
  }
  if (currentPath.isSymbolicLink()) return "artifacts directory is a symlink";
  if (!currentPath.isDirectory()) return "artifacts directory is not a directory";
  if (!sameFileIdentity(currentPath, opened)) return "artifacts directory changed while it was being read";
  return null;
}

type OpenArtifactsDirectory =
  | { status: "absent" }
  | { status: "invalid"; error: string }
  | { status: "ready"; canonicalRoot: string; fd: number; opened: Stats };

function openArtifactsDirectory(lexicalRoot: string): OpenArtifactsDirectory {
  let lexical: Stats;
  try {
    lexical = lstatSync(lexicalRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return { status: "invalid", error: `artifacts directory is unreadable: ${(error as Error).message}` };
    }

    let canonicalParent: string;
    try {
      canonicalParent = realpathSync(dirname(lexicalRoot));
    } catch (parentError) {
      return { status: "invalid", error: `artifacts directory parent is unreadable: ${(parentError as Error).message}` };
    }
    const canonicalRoot = join(canonicalParent, basename(lexicalRoot));
    try {
      lstatSync(canonicalRoot);
      return { status: "invalid", error: "artifacts directory changed while it was being read" };
    } catch (canonicalError) {
      if ((canonicalError as NodeJS.ErrnoException).code !== "ENOENT") {
        return { status: "invalid", error: `artifacts directory is unreadable: ${(canonicalError as Error).message}` };
      }
    }
    try {
      lstatSync(lexicalRoot);
      return { status: "invalid", error: "artifacts directory changed while it was being read" };
    } catch (recheckError) {
      if ((recheckError as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      return { status: "invalid", error: `artifacts directory is unreadable: ${(recheckError as Error).message}` };
    }
  }

  if (lexical.isSymbolicLink()) return { status: "invalid", error: "artifacts directory is a symlink" };
  if (!lexical.isDirectory()) return { status: "invalid", error: "artifacts directory is not a directory" };

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(lexicalRoot);
  } catch (error) {
    return { status: "invalid", error: `artifacts directory is unreadable: ${(error as Error).message}` };
  }
  let canonical: Stats;
  try {
    canonical = lstatSync(canonicalRoot);
  } catch (error) {
    return { status: "invalid", error: `artifacts directory changed while it was being read: ${(error as Error).message}` };
  }
  if (canonical.isSymbolicLink()) return { status: "invalid", error: "artifacts directory is a symlink" };
  if (!canonical.isDirectory()) return { status: "invalid", error: "artifacts directory is not a directory" };
  if (!sameFileIdentity(lexical, canonical)) return { status: "invalid", error: "artifacts directory changed while it was being read" };

  let directoryFd: number;
  try {
    directoryFd = openSync(canonicalRoot, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    return { status: "invalid", error: `artifacts directory is unreadable: ${(error as Error).message}` };
  }
  let opened: Stats;
  try {
    opened = fstatSync(directoryFd);
  } catch (error) {
    try {
      closeSync(directoryFd);
    } catch {
      // Preserve the directory error; descriptor cleanup is best effort.
    }
    return { status: "invalid", error: `artifacts directory is unreadable: ${(error as Error).message}` };
  }
  if (!opened.isDirectory() || !sameFileIdentity(canonical, opened)) {
    try {
      closeSync(directoryFd);
    } catch {
      // Preserve the directory identity error; descriptor cleanup is best effort.
    }
    return {
      status: "invalid",
      error: opened.isDirectory() ? "artifacts directory changed while it was being read" : "artifacts directory is not a directory",
    };
  }
  const pinned = pinnedDirectoryRejection(canonicalRoot, directoryFd, opened);
  if (pinned) {
    try {
      closeSync(directoryFd);
    } catch {
      // Preserve the directory identity error; descriptor cleanup is best effort.
    }
    return { status: "invalid", error: pinned };
  }
  return { status: "ready", canonicalRoot, fd: directoryFd, opened };
}

function artifactContainmentRejection(root: string, path: string, realRoot: string, allowMissingTarget = false): string | null {
  const parts = relative(root, path).split(sep).filter((part) => part !== "" && part !== ".");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    try {
      const parent = lstatSync(cursor);
      if (parent.isSymbolicLink()) return "artifact path traverses a symlink";
      if (!parent.isDirectory()) return "artifact path contains a non-directory component";
    } catch {
      return "artifact path changed while it was being read";
    }
  }
  try {
    const realPath = realpathSync(path);
    if (!isWithinTree(realRoot, realPath)) return "artifact target escapes artifacts directory";
  } catch (error) {
    if (allowMissingTarget && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "artifact target changed while it was being read";
  }
  return null;
}


/**
 * Read one declared input while preserving the distinction between a truly
 * absent target and a present-but-invalid target.  Optional inputs use this
 * boundary so a symlink, non-file, containment failure, permission error, or
 * malformed JSON cannot be mistaken for absence.
 */
export function readArtifactInput(artifactsDir: string, id: string): ArtifactInputRead {
  const relativePath = `${id}.json`;
  if (!isSafeArtifactId(id)) return { status: "invalid", path: relativePath, error: `unsafe artifact id: ${id}` };
  const lexicalRoot = resolve(artifactsDir);
  const directory = openArtifactsDirectory(lexicalRoot);
  if (directory.status === "absent") return { status: "absent", path: relativePath };
  if (directory.status === "invalid") return { status: "invalid", path: relativePath, error: directory.error };

  const root = directory.canonicalRoot;
  const path = join(root, relativePath);
  const directoryFd = directory.fd;
  const openedDirectory = directory.opened;
  const realRoot = root;
  let fd: number | null = null;
  try {
    const preOpenDirectory = pinnedDirectoryRejection(root, directoryFd, openedDirectory);
    if (preOpenDirectory) return { status: "invalid", path: relativePath, error: preOpenDirectory };
    const preOpenContainment = artifactContainmentRejection(root, path, realRoot, true);
    if (preOpenContainment) return { status: "invalid", path: relativePath, error: preOpenContainment };

    try {
      fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const beforeAbsence = pinnedDirectoryRejection(root, directoryFd, openedDirectory);
        if (beforeAbsence) return { status: "invalid", path: relativePath, error: beforeAbsence };
        const changed = artifactContainmentRejection(root, path, realRoot, true);
        if (changed) return { status: "invalid", path: relativePath, error: changed };
        try {
          const current = lstatSync(path);
          return {
            status: "invalid",
            path: relativePath,
            error: current.isSymbolicLink() ? "artifact target is a symlink" : "artifact target changed while it was being read",
          };
        } catch (recheckError) {
          if ((recheckError as NodeJS.ErrnoException).code !== "ENOENT") {
            return { status: "invalid", path: relativePath, error: `artifact target is unreadable: ${(recheckError as Error).message}` };
          }
          const afterAbsence = pinnedDirectoryRejection(root, directoryFd, openedDirectory);
          if (afterAbsence) return { status: "invalid", path: relativePath, error: afterAbsence };
          return { status: "absent", path: relativePath };
        }
      }
      return { status: "invalid", path: relativePath, error: `artifact target is unreadable: ${(error as Error).message}` };
    }

    let opened: Stats;
    try {
      opened = fstatSync(fd);
    } catch (error) {
      return { status: "invalid", path: relativePath, error: `artifact target is unreadable: ${(error as Error).message}` };
    }
    if (!opened.isFile()) return { status: "invalid", path: relativePath, error: "artifact target is not a regular file" };

    let named: Stats;
    try {
      named = lstatSync(path);
    } catch (error) {
      return { status: "invalid", path: relativePath, error: `artifact target changed while it was being read: ${(error as Error).message}` };
    }
    if (named.isSymbolicLink()) return { status: "invalid", path: relativePath, error: "artifact target is a symlink" };
    if (!sameFileIdentity(named, opened)) {
      return { status: "invalid", path: relativePath, error: "artifact target changed while it was being read" };
    }
    const containment = artifactContainmentRejection(root, path, realRoot);
    if (containment) return { status: "invalid", path: relativePath, error: containment };
    const beforeReadDirectory = pinnedDirectoryRejection(root, directoryFd, openedDirectory);
    if (beforeReadDirectory) return { status: "invalid", path: relativePath, error: beforeReadDirectory };

    let content: string;
    try {
      content = readFileSync(fd, "utf8");
    } catch (error) {
      return { status: "invalid", path: relativePath, error: `artifact target is unreadable: ${(error as Error).message}` };
    }
    let after: Stats;
    try {
      after = fstatSync(fd);
    } catch (error) {
      return { status: "invalid", path: relativePath, error: `artifact target is unreadable: ${(error as Error).message}` };
    }
    if (!sameFileIdentity(after, opened) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      return { status: "invalid", path: relativePath, error: "artifact target changed while it was being read" };
    }
    try {
      named = lstatSync(path);
    } catch (error) {
      return { status: "invalid", path: relativePath, error: `artifact target changed while it was being read: ${(error as Error).message}` };
    }
    if (named.isSymbolicLink() || !sameFileIdentity(named, opened)) {
      return { status: "invalid", path: relativePath, error: "artifact target changed while it was being read" };
    }
    const postReadContainment = artifactContainmentRejection(root, path, realRoot);
    if (postReadContainment) return { status: "invalid", path: relativePath, error: postReadContainment };

    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch (error) {
      return { status: "invalid", path: relativePath, error: `artifact is not valid JSON: ${(error as Error).message}` };
    }
    const postParseDirectory = pinnedDirectoryRejection(root, directoryFd, openedDirectory);
    if (postParseDirectory) return { status: "invalid", path: relativePath, error: postParseDirectory };
    return { status: "present", path: relativePath, content, value };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the read result; descriptor cleanup is best effort.
      }
    }
    try {
      closeSync(directoryFd);
    } catch {
      // Preserve the read result; descriptor cleanup is best effort.
    }
  }
}

function parseReturnedArtifact(id: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`artifact "${id}" is not valid JSON`);
  }
}

export function persistReturnedArtifacts(
  artifactsDir: string,
  artifacts: Record<string, unknown>,
): string[] {
  const ids: string[] = [];
  for (const [id, value] of Object.entries(artifacts)) {
    assertArtifactId(id);
    writeArtifact(artifactsDir, id, parseReturnedArtifact(id, value));
    ids.push(id);
  }
  return ids;
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
export function readArtifact<T = unknown>(artifactsDir: string, id: string): T | null {
  if (!ARTIFACT_ID_RE.test(id) || id === "." || id === "..") return null;
  const path = safeArtifactPath(artifactsDir, id, false);
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transactional artifact-write journal (engine-internal).
//
// Durable state transactions open this journal while holding the workspace
// state lock. Artifact writes happen eagerly so the mutation can validate
// them, but their previous bytes and the exact generation written by this
// transaction are retained. A failed transaction restores/removes only that
// generation, using no-follow reads and atomic replacement; a lockless writer
// that replaced the file is never clobbered. Observability publications are
// buffered alongside the writes and released only after state.json commits.
// ---------------------------------------------------------------------------

interface FileGeneration {
  raw: string;
  sha256: string;
  dev: number;
  ino: number;
}

interface ArtifactJournalEntry {
  previous: FileGeneration | null;
  /** Exact bytes intended for the next publication, persisted before rename. */
  planned?: Pick<FileGeneration, "raw" | "sha256">;
  written: FileGeneration | null;
}

export interface ArtifactJournal {
  writes: Map<string, ArtifactJournalEntry>;
  observability: Array<() => void>;
  cwd?: string;
  durablePath?: string;
  commitStatePath?: string;
  commitStateHash?: string;
  lifecycleTransactionId?: string;
}

function persistArtifactJournal(journal: ArtifactJournal): void {
  if (!journal.durablePath) return;
  const payload = { status: "prepared", commitStatePath: journal.commitStatePath, commitStateHash: journal.commitStateHash, lifecycleTransactionId: journal.lifecycleTransactionId, writes: Object.fromEntries(Array.from(journal.writes.entries()).map(([path, entry]) => [path, entry])) };
  const tmp = `${journal.durablePath}.${randomUUID()}.tmp`;
  mkdirSync(dirname(journal.durablePath), { recursive: true });
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  renameSync(tmp, journal.durablePath);
}

export function recoverArtifactJournals(cwd: string): void {
  const root = join(resolve(cwd, ".work-state"), "artifact-transactions");
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { writes?: Record<string, ArtifactJournalEntry>; commitStatePath?: string; commitStateHash?: string; lifecycleTransactionId?: string };
      const writes = new Map(Object.entries(parsed.writes ?? {}));
      // A crash may occur after rename but before the written inode is saved.
      for (const [target, entry] of writes) {
        if (entry.written || !entry.planned) continue;
        const current = readGenerationNoFollow(target);
        if (current && current.sha256 === entry.planned.sha256 && current.raw === entry.planned.raw) entry.written = current;
      }
      const journal: ArtifactJournal = { writes, observability: [], cwd, durablePath: path, commitStatePath: parsed.commitStatePath, commitStateHash: parsed.commitStateHash, lifecycleTransactionId: parsed.lifecycleTransactionId };
      if (artifactJournalHasCommitBoundary(journal)) commitArtifactJournal(journal);
      else rollbackArtifactJournal(journal);
    } catch (error) {
      throw new Error("artifact journal recovery failed for '" + name + "': " + (error as Error).message);
    }
  }
}

/** Verify that no artifact journal is waiting for recovery, without mutating it. */
export function assertNoPendingArtifactJournals(cwd: string): void {
  const root = join(resolve(cwd, ".work-state"), "artifact-transactions");
  if (!existsSync(root)) return;
  const entries = readdirSync(root);
  if (entries.length > 0) {
    throw new Error(`artifact journal recovery required: ${entries[0]}`);
  }
}

let artifactJournal: ArtifactJournal | null = null;

function readGenerationNoFollow(path: string): FileGeneration | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`journal target is not a regular file: ${path}`);
    const raw = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`journal target changed while it was being read: ${path}`);
    }
    return {
      raw,
      sha256: createHash("sha256").update(raw).digest("hex"),
      dev: after.dev,
      ino: after.ino,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function sameGeneration(left: FileGeneration | null, right: FileGeneration | null): boolean {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.sha256 === right.sha256;
}

function matchesPlannedGeneration(current: FileGeneration | null, planned: ArtifactJournalEntry["planned"]): boolean {
  return current !== null && planned !== undefined && current.sha256 === planned.sha256 && current.raw === planned.raw;
}

function atomicRestore(path: string, raw: string): void {
  const tempPath = join(dirname(path), `.artifact-rollback.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, raw, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Cleanup must not hide the restore failure.
    }
    throw error;
  }
}

/** Begin journaling artifact writes and transaction-bound observability. */
export function beginArtifactJournal(cwd?: string): void {
  if (artifactJournal) throw new Error("artifact journal is already active");
  const durablePath = cwd ? join(resolve(cwd, ".work-state", "artifact-transactions"), `${randomUUID()}.json`) : undefined;
  artifactJournal = { writes: new Map(), observability: [], ...(cwd ? { cwd, durablePath } : {}) };
  persistArtifactJournal(artifactJournal);
}

/** Stop journaling and return the captured transaction log. */
export function endArtifactJournal(): ArtifactJournal {
  const journal = artifactJournal;
  artifactJournal = null;
  return journal ?? { writes: new Map(), observability: [] };
}

/** Publish one event now, or buffer it until the authoritative state commit. */
export function markArtifactJournalCommit(statePath: string, stateContent: string): void {
  if (!artifactJournal) return;
  artifactJournal.commitStatePath = statePath;
  artifactJournal.commitStateHash = createHash("sha256").update(stateContent, "utf8").digest("hex");
  persistArtifactJournal(artifactJournal);
}

/** Link this artifact journal to the lifecycle transaction whose marker
 * makes its after-image authoritative. */
export function markArtifactJournalLifecycle(transactionId: string): void {
  if (!artifactJournal) return;
  artifactJournal.lifecycleTransactionId = transactionId;
  persistArtifactJournal(artifactJournal);
}

export function artifactJournalHasCommitBoundary(journal: ArtifactJournal): boolean {
  if (journal.lifecycleTransactionId && journal.cwd) {
    const status = lifecycleTransactionStatus(journal.cwd, journal.lifecycleTransactionId);
    if (status?.status === "committing" || status?.status === "committed") return true;
  }
  return Boolean(
    journal.commitStatePath
    && journal.commitStateHash
    && existsSync(journal.commitStatePath)
    && createHash("sha256").update(readFileSync(journal.commitStatePath)).digest("hex") === journal.commitStateHash,
  );
}

export function publishAfterStateCommit(publish: () => void): void {
  if (artifactJournal) {
    artifactJournal.observability.push(publish);
  } else {
    publish();
  }
}

/** Finalize a committed journal. Event hooks are best-effort by contract. */
export function commitArtifactJournal(journal: ArtifactJournal): void {
  if (journal.durablePath) { try { unlinkSync(journal.durablePath); } catch { /* best effort cleanup */ } }
  for (const publish of journal.observability) {
    try {
      publish();
    } catch {
      // Observability never turns a completed state commit into a rollback.
    }
  }
}

/**
 * Roll back only the exact artifact generation written by this transaction.
 * Restores use temp-file + rename; symlinks and generations replaced by a
 * concurrent lockless writer are left untouched.
 */
export function rollbackArtifactJournal(journal: ArtifactJournal): void {
  for (const [path, entry] of Array.from(journal.writes.entries()).reverse()) {
    try {
      const current = readGenerationNoFollow(path);
      const ours = sameGeneration(current, entry.written) || (entry.written === null && matchesPlannedGeneration(current, entry.planned));
      if (!ours) continue;
      if (entry.previous === null) unlinkSync(path);
      else atomicRestore(path, entry.previous.raw);
    } catch {
      // A changed/unsafe generation is deliberately not overwritten.
    }
  }
  if (journal.durablePath) { try { unlinkSync(journal.durablePath); } catch { /* best effort cleanup */ } }
}

export function writeArtifact<T = unknown>(artifactsDir: string, id: string, data: T): string {
  assertArtifactId(id);
  mkdirSync(artifactsDir, { recursive: true });
  const path = safeArtifactPath(artifactsDir, id, true);
  if (!path) throw new Error("unsafe artifact path: " + id);
  const body = JSON.stringify(data, null, 2) + "\n";
  if (artifactJournal) {
    const existing = artifactJournal.writes.get(path);
    const entry = existing ?? { previous: readGenerationNoFollow(path), written: null };
    entry.planned = { raw: body, sha256: createHash("sha256").update(body, "utf8").digest("hex") };
    entry.written = null;
    artifactJournal.writes.set(path, entry);
    // Durable publication intent exists before rename, closing the crash gap.
    persistArtifactJournal(artifactJournal);
  }
  const tempPath = join(dirname(path), `.artifact.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, body, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup must not hide the original write error.
    }
    throw error;
  }
  if (artifactJournal) {
    const entry = artifactJournal.writes.get(path);
    if (!entry) throw new Error(`artifact journal lost write target: ${path}`);
    const written = readGenerationNoFollow(path);
    if (!written) throw new Error(`artifact write vanished before journaling: ${path}`);
    entry.written = written;
    persistArtifactJournal(artifactJournal);
  }
  // Best-effort artifact_written telemetry (additive; never blocks the write).
  // The project root is derived from the `.work-state` segment of the
  // artifacts dir; dirs outside `.work-state` (e.g. scratch tests) skip it.
  const root = projectRootFromWorkStatePath(artifactsDir);
  if (root) {
    publishAfterStateCommit(() => {
      try {
        recordArtifactWritten(root, {
          artifactId: id,
          artifactPath: relative(root, path),
          artifactBytes: Buffer.byteLength(body, "utf8"),
          runId: canonicalRunIdFromArtifactsDir(artifactsDir),
        });
      } catch {
        // best-effort telemetry
      }
    });
  }
  return path;
}

function safeArtifactPath(artifactsDir: string, id: string, forWrite: boolean): string | null {
  try {
    if (!existsSync(artifactsDir)) return null;
    const realRoot = realpathSync(artifactsDir);
    const path = join(artifactsDir, `${id}.json`);
    if (!existsSync(path)) {
      if (!forWrite || !isWithinTree(realRoot, realpathSync(artifactsDir))) return null;
      return path;
    }
    if (lstatSync(path).isSymbolicLink()) return null;
    const realPath = realpathSync(path);
    return isWithinTree(realRoot, realPath) ? path : null;
  } catch {
    return null;
  }
}

function isWithinTree(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

/** Project root = path prefix ending at the `.work-state` segment, if any. */
function projectRootFromWorkStatePath(dir: string): string | null {
  const parts = dir.split(sep);
  const idx = parts.indexOf(".work-state");
  if (idx <= 0) return null;
  return parts.slice(0, idx).join(sep) || sep;
}

export function readAllArtifacts(artifactsDir: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!existsSync(artifactsDir)) return result;
  const files = require("node:fs").readdirSync(artifactsDir) as string[];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    const data = readArtifact(artifactsDir, id);
    if (data !== null) result[id] = data;
  }
  return result;
}
