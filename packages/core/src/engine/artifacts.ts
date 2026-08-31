/**
 * Typed artifact I/O. Stages declare `consumes` and `produces` artifact ids;
 * the engine reads/writes them under `.work-state/artifacts/<id>.json` (or per-feature
 * subdir, set by `state.ts`).
 *
 * The schema is the same as claude-plugin's `workflows/artifacts-schema.json`.
 * We don't validate every field here — the engine only checks that the JSON
 * parses and matches the type name — but the schema is preserved for ref.
 */

import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { recordArtifactWritten } from "../observability/hooks.js";

const ARTIFACT_ID_RE = /^[A-Za-z0-9._-]+$/;

function assertArtifactId(id: string): void {
  if (!ARTIFACT_ID_RE.test(id) || id === "." || id === "..") {
    throw new Error(`unsafe artifact id: ${id}`);
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
  written: FileGeneration | null;
}

export interface ArtifactJournal {
  writes: Map<string, ArtifactJournalEntry>;
  observability: Array<() => void>;
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
export function beginArtifactJournal(): void {
  if (artifactJournal) throw new Error("artifact journal is already active");
  artifactJournal = { writes: new Map(), observability: [] };
}

/** Stop journaling and return the captured transaction log. */
export function endArtifactJournal(): ArtifactJournal {
  const journal = artifactJournal;
  artifactJournal = null;
  return journal ?? { writes: new Map(), observability: [] };
}

/** Publish one event now, or buffer it until the authoritative state commit. */
export function publishAfterStateCommit(publish: () => void): void {
  if (artifactJournal) {
    artifactJournal.observability.push(publish);
  } else {
    publish();
  }
}

/** Finalize a committed journal. Event hooks are best-effort by contract. */
export function commitArtifactJournal(journal: ArtifactJournal): void {
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
      if (!sameGeneration(current, entry.written)) continue;
      if (entry.previous === null) {
        unlinkSync(path);
      } else {
        atomicRestore(path, entry.previous.raw);
      }
    } catch {
      // A changed/unsafe generation is deliberately not overwritten.
    }
  }
}

export function writeArtifact<T = unknown>(artifactsDir: string, id: string, data: T): string {
  assertArtifactId(id);
  mkdirSync(artifactsDir, { recursive: true });
  const path = safeArtifactPath(artifactsDir, id, true);
  if (!path) throw new Error(`unsafe artifact path: ${id}`);
  if (artifactJournal) {
    const existing = artifactJournal.writes.get(path);
    if (!existing) {
      const previous = readGenerationNoFollow(path);
      artifactJournal.writes.set(path, { previous, written: null });
    }
  }
  const body = JSON.stringify(data, null, 2) + "\n";
  const tempPath = join(artifactsDir, `.artifact.${randomUUID()}.tmp`);
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
