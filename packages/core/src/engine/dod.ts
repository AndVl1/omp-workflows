/**
 * Definition-of-Done lifecycle.
 *
 * - APPEND: add a new criterion owned by the current stage. Sets `source: <stageId>`,
 *   `id: <stageId>-<n>`, `status: "pending"`.
 * - CLOSE: flips an existing item to `met` ONLY with non-empty `evidence`.
 *
 * The `session_stop` gate (`dod-backstop.ts`) blocks a done-claim when items
 * are unmet or evidence-less.
 *
 * Path discipline (single source of truth): `teams[].dod_path` is resolved by
 * {@link resolveDodPath} — the ONLY resolver every `dod_path` consumer (CTO
 * slice/integration gates, report, visualization) may use. Both forms are
 * accepted and normalized to the same absolute dod.json file path:
 *   - a directory containing `dod.json` (also the default when unset);
 *   - the `dod.json` file itself.
 * Unsafe configured paths (traversal, absolute, NUL, symlinks) fail closed
 * with a cause and never echo the untrusted value; read failures name the
 * resolved file path and the cause ({@link readDoDFile}). Reads are
 * TOCTOU-safe: the resolved file is opened with O_NOFOLLOW|O_NONBLOCK (the
 * non-blocking flag keeps a FIFO posing as dod.json from hanging the open),
 * fstat-checked as a regular file, fd-bound to the pathname via a dev/ino
 * match, and containment is revalidated against the run root before the text
 * is read from that same fd ({@link readDoDFileSafe}).
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DoD, DoDItem } from "./types.js";

/** Canonical DoD file name inside an artifacts directory. */
export const DOD_FILENAME = "dod.json";

const MAX_DOD_PATH_LENGTH = 512;

export type DodPathResolution = { ok: true; file: string } | { ok: false; reason: string };

/**
 * Resolve `teams[].dod_path` to the absolute dod.json file path. THE canonical
 * resolver for every dod_path consumer — never re-derive dod_path handling
 * locally.
 *
 * Accepted forms (relative to `root`):
 *   - unset / "" → default team artifacts dir `.work-state/artifacts/<teamId>`;
 *   - a directory containing `dod.json` (any basename other than `dod.json`);
 *   - the `dod.json` file itself (basename exactly `dod.json`).
 *
 * Fail-closed safety: relative '/'-separated paths only; no empty/'.', '..'
 * segments, no NUL, bounded length; existing symlinked ancestors and symlinked
 * targets are rejected; the resolved file must stay inside `root` through
 * realpaths. Rejection reasons name the CAUSE and never echo the untrusted
 * configured value. A configured path pointing at the WRONG kind of existing
 * node (directory where the file form is required, regular file where the
 * directory form is required) is rejected with the corrective cause instead of
 * a confusing downstream missing-file.
 */
export function resolveDodPath(root: string, configured: unknown, teamId: string): DodPathResolution {
  if (typeof teamId !== "string" || teamId.length === 0 || /[/\\\0]/.test(teamId)) {
    return { ok: false, reason: "unsafe team id: refusing to resolve a DoD path" };
  }
  const candidate =
    configured === undefined || configured === "" ? join(".work-state", "artifacts", teamId) : configured;
  if (typeof candidate !== "string") return { ok: false, reason: "configured dod_path must be a string" };
  const trimmed = candidate.replace(/\/+$/, "");
  if (trimmed.length === 0) return { ok: false, reason: "configured dod_path must not be empty" };
  if (trimmed.length > MAX_DOD_PATH_LENGTH) {
    return { ok: false, reason: `configured dod_path exceeds ${MAX_DOD_PATH_LENGTH} characters` };
  }
  if (trimmed.includes("\0")) return { ok: false, reason: "configured dod_path contains a NUL byte" };
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes("\\")) {
    return { ok: false, reason: "configured dod_path must be a relative path using '/' separators" };
  }
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return { ok: false, reason: "configured dod_path must not contain empty, '.', or '..' path segments" };
  }

  const rootPath = resolve(root);
  const fileForm = basename(trimmed) === DOD_FILENAME;
  const declared = resolve(rootPath, ...segments);
  const file = fileForm ? declared : join(declared, DOD_FILENAME);

  try {
    if (existsSync(declared)) {
      const st = lstatSync(declared);
      if (st.isSymbolicLink()) return { ok: false, reason: "configured dod_path traverses a symlink" };
      if (fileForm ? st.isDirectory() : st.isFile()) {
        return {
          ok: false,
          reason: fileForm
            ? "configured dod_path is a directory — point at the dod.json file itself or at the directory containing it"
            : "configured dod_path is a regular file — point at the directory containing dod.json or at the dod.json file itself",
        };
      }
    }
  } catch {
    return { ok: false, reason: "configured dod_path is not accessible" };
  }

  const rejection = pathSafetyRejection(rootPath, file);
  if (rejection !== null) return { ok: false, reason: `configured dod_path ${rejection}` };
  return { ok: true, file };
}

/**
 * Fail-closed symlink/containment check for a resolved candidate path: every
 * EXISTING ancestor between the root and the candidate, and the candidate
 * itself when it exists, must be a real (non-symlink) node whose realpath
 * stays inside the root's realpath. Returns null when safe, else a cause
 * clause safe to surface (never contains the configured value).
 */
function pathSafetyRejection(rootPath: string, target: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(rootPath);
  } catch {
    return "run root is unavailable";
  }
  const parts = relative(rootPath, target).split(sep).filter((p) => p !== "" && p !== ".");
  let cursor = rootPath;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    let st: Stats | null = null;
    try {
      st = lstatSync(cursor);
    } catch {
      break; // does not exist — no deeper chain to validate
    }
    if (st.isSymbolicLink()) return "traverses a symlink";
  }
  try {
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink()) return "target is a symlink";
      const rel = relative(realRoot, realpathSync(target));
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return "resolves outside the run root";
      }
    } else {
      const parent = dirname(target);
      if (existsSync(parent)) {
        const parentRel = relative(realRoot, realpathSync(parent));
        if (parentRel === "" || parentRel === ".." || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) {
          return "resolves outside the run root";
        }
      }
    }
  } catch {
    return "resolves outside the run root";
  }
  return null;
}

export type DodReadResult = { ok: true; dod: DoD } | { ok: false; reason: string };

/** Machine-readable failure kinds for the safe DoD file read. */
export type DodSafeReadFailure =
  | "missing"
  | "symlink"
  | "not-regular"
  | "changed"
  | "unsafe"
  | "unreadable";

/**
 * Result of the single safe DoD read primitive: on success the raw file text
 * (read from the opened fd) plus size/mtime — everything a consumer needs so
 * it never has to reopen the pathname.
 */
export type DodSafeFileRead =
  | { ok: true; raw: string; bytes: number; mtimeMs: number }
  | { ok: false; kind: DodSafeReadFailure; reason: string };

/** O_NOFOLLOW where the platform provides it (0 where it does not). */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * O_NONBLOCK where the platform provides it (0 where it does not). Opening a
 * POSIX FIFO (or similar special node) posing as dod.json with a plain
 * O_RDONLY blocks until a writer appears; the non-blocking flag makes that
 * open return immediately so the regular-file fstat below can fail the read
 * closed instead of hanging. Regular files ignore the flag, so byte-correct
 * reads are unaffected.
 */
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

/**
 * Post-open containment revalidation: every EXISTING ancestor between the
 * root and the file must be a real (non-symlink) directory, and the file's
 * realpath must stay inside the root's realpath. An ancestor swapped in after
 * resolution therefore cannot redirect the read outside (or across) the root.
 * Returns null when safe, else a cause clause safe to surface (never contains
 * untrusted values).
 */
function readContainmentRejection(rootPath: string, file: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(rootPath);
  } catch {
    return "run root is unavailable";
  }
  const parts = relative(rootPath, file).split(sep).filter((p) => p !== "" && p !== ".");
  let cursor = rootPath;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    try {
      const st = lstatSync(cursor);
      if (st.isSymbolicLink()) return "traverses a symlink";
      if (!st.isDirectory()) return "resolves outside the run root";
    } catch {
      return "resolves outside the run root"; // vanished mid-validation — fail closed
    }
  }
  try {
    const rel = relative(realRoot, realpathSync(file));
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return "resolves outside the run root";
    }
  } catch {
    return "resolves outside the run root";
  }
  return null;
}

/**
 * THE safe DoD read: opens the resolved file with O_NOFOLLOW|O_NONBLOCK (the
 * non-blocking flag keeps a FIFO posing as dod.json from hanging the open),
 * fstats the fd and requires a regular file, binds the fd to the pathname via a dev/ino
 * match, revalidates root containment through realpaths, then reads the text
 * from that SAME fd — a pathname swapped in after validation cannot change
 * what is parsed. Never throws; failure reasons never echo untrusted values.
 */
export function readDoDFileSafe(root: string, file: string): DodSafeFileRead {
  const rootPath = resolve(root);
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "ELOOP") return { ok: false, kind: "symlink", reason: `dod.json at ${file} is a symlink (refusing to read)` };
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, kind: "missing", reason: `no dod.json at ${file}` };
    return { ok: false, kind: "unreadable", reason: `${file} is unreadable: ${code || "unknown error"}` };
  }
  try {
    let st: Stats;
    try {
      st = fstatSync(fd);
    } catch {
      return { ok: false, kind: "unreadable", reason: `${file} is unreadable: fstat failed` };
    }
    if (!st.isFile()) return { ok: false, kind: "not-regular", reason: `${file} is not a regular file` };
    // fd-vs-path inode bind: the opened inode must still be the node the path
    // names at validation time; the read below uses the bound fd, so later
    // pathname swaps cannot change what is parsed.
    try {
      const pst = lstatSync(file);
      if (pst.isSymbolicLink()) return { ok: false, kind: "symlink", reason: `dod.json at ${file} is a symlink (refusing to read)` };
      if (pst.dev !== st.dev || pst.ino !== st.ino) {
        return { ok: false, kind: "changed", reason: `${file} changed while being read (refusing to read)` };
      }
    } catch {
      return { ok: false, kind: "changed", reason: `${file} changed while being read (refusing to read)` };
    }
    const rejection = readContainmentRejection(rootPath, file);
    if (rejection !== null) return { ok: false, kind: "unsafe", reason: `${file} ${rejection}` };
    let raw: string;
    try {
      raw = readFileSync(fd, "utf8"); // read the SAME opened fd — never the pathname
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      return { ok: false, kind: "unreadable", reason: `${file} is unreadable: ${code}` };
    }
    return { ok: true, raw, bytes: st.size, mtimeMs: st.mtimeMs };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // close is best-effort; the result is already determined
    }
  }
}

export type DodReadOptions = { root?: string };

/**
 * Canonical low-level DoD read for a RESOLVED dod.json file path (as returned
 * by {@link resolveDodPath}). Performed through {@link readDoDFileSafe} —
 * O_NOFOLLOW|O_NONBLOCK open, regular-file check, fd/path inode bind, and (when `root`
 * is given) run-root containment revalidation. Never throws; on failure the
 * reason names the file path and the cause (missing / symlink / not a regular
 * file / unreadable / not valid JSON).
 */
export function readDoDFile(file: string, opts?: DodReadOptions): DodReadResult {
  const safe = readDoDFileSafe(opts?.root ?? dirname(file), file);
  if (!safe.ok) return { ok: false, reason: safe.reason };
  try {
    return { ok: true, dod: JSON.parse(safe.raw) as DoD };
  } catch (error) {
    return { ok: false, reason: `${file} is not valid JSON: ${(error as Error).message}` };
  }
}

/** Directory-form convenience read (stage-local flows keyed by artifactsDir). */
export function readDoD(artifactsDir: string): DoD | null {
  const read = readDoDFile(join(artifactsDir, DOD_FILENAME));
  return read.ok ? read.dod : null;
}

export function writeDoD(artifactsDir: string, dod: DoD): string {
  const path = join(artifactsDir, DOD_FILENAME);
  const stamped: DoD = { ...dod, updated_at: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(stamped, null, 2) + "\n", "utf8");
  return path;
}

export function appendDoDItem(
  artifactsDir: string,
  stageId: string,
  criterion: string,
  verifyMethod: string,
  agent: string,
): DoD {
  const existing = readDoD(artifactsDir) ?? emptyDoD();
  const n = existing.items.filter((it) => it.source === stageId).length + 1;
  const item: DoDItem = {
    id: `${stageId}-${n}`,
    source: stageId,
    criterion,
    verify_method: verifyMethod,
    status: "pending",
    evidence: "",
  };
  const items = [...existing.items, item];
  const contributions = mergeContribution(existing.contributions, stageId, { added: [item.id], closed: [], by: agent });
  const next: DoD = { ...existing, items, contributions };
  writeDoD(artifactsDir, next);
  return next;
}

export function closeDoDItem(
  artifactsDir: string,
  itemId: string,
  evidence: string,
  agent: string,
): { ok: true; dod: DoD } | { ok: false; reason: string } {
  if (!evidence || !evidence.trim()) {
    return { ok: false, reason: "evidence is required to close a DoD item" };
  }
  const existing = readDoD(artifactsDir);
  if (!existing) return { ok: false, reason: "dod.json missing" };
  const items = existing.items.map((it) =>
    it.id === itemId ? { ...it, status: "met" as const, evidence: evidence.trim() } : it,
  );
  const item = existing.items.find((it) => it.id === itemId);
  if (!item) return { ok: false, reason: `DoD item ${itemId} not found` };
  const stageId = item.source;
  const contributions = mergeContribution(existing.contributions, stageId, { added: [], closed: [itemId], by: agent });
  const next: DoD = { ...existing, items, contributions };
  writeDoD(artifactsDir, next);
  return { ok: true, dod: next };
}

export function isDoDComplete(dod: DoD | null): { ok: true } | { ok: false; pending: DoDItem[] } {
  if (!dod) return { ok: false, pending: [] };
  const pending = dod.items.filter((it) => it.status !== "met" || !it.evidence);
  if (pending.length === 0) return { ok: true };
  return { ok: false, pending };
}

export function emptyDoD(): DoD {
  return { items: [], type_requirements_met: false, contributions: {}, updated_at: new Date().toISOString() };
}

function mergeContribution(
  existing: DoD["contributions"] | undefined,
  stageId: string,
  delta: { added: string[]; closed: string[]; by: string },
): DoD["contributions"] {
  const base = existing ?? {};
  const prev = base[stageId] ?? { added: [], closed: [], by: delta.by };
  return {
    ...base,
    [stageId]: {
      added: [...prev.added, ...delta.added],
      closed: [...prev.closed, ...delta.closed],
      by: delta.by,
    },
  };
}

/**
 * For BUG_FIX: gate BEFORE first code edit. The root_cause must be a non-empty
 * string in the diagnosis artifact and explain WHY the fix closes the cause.
 */
export function isRootCauseDocumented(
  artifactsDir: string,
): { ok: true; diagnosis: { root_cause: string; explanation: string } } | { ok: false; reason: string } {
  const path = join(artifactsDir, "diagnosis.json");
  if (!existsSync(path)) return { ok: false, reason: "diagnosis.json missing" };
  const diagnosis = JSON.parse(readFileSync(path, "utf8")) as { root_cause?: string; explanation?: string };
  if (!diagnosis.root_cause || !diagnosis.root_cause.trim()) {
    return { ok: false, reason: "diagnosis.root_cause is empty" };
  }
  if (!diagnosis.explanation || !diagnosis.explanation.trim()) {
    return { ok: false, reason: "diagnosis.explanation is empty (why does this fix close the root cause?)" };
  }
  return { ok: true, diagnosis: { root_cause: diagnosis.root_cause, explanation: diagnosis.explanation } };
}
