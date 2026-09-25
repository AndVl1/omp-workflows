import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Environment override for the host-owned cross-process origin locator. */
export const DISPATCH_ORIGIN_LOCATOR_ENV = "OMP_WORKFLOWS_DISPATCH_ORIGIN_DIR";
const LOCATOR_SCHEMA = 1;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const MAX_CANDIDATES = 256;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

export interface DispatchOriginLocatorEntry {
  cwd: string;
  run_id: string;
  dispatch_id: string;
  origin_session_id?: string;
  capability_id?: string;
  stage_id?: string;
  cursor_epoch?: string;
  slot_id?: string;
  task_id?: string;
}

type LocatorDocument = {
  schema: typeof LOCATOR_SCHEMA;
  tool_call_hash: string;
  candidates: DispatchOriginLocatorEntry[];
};

type LocatorCandidateInput = Omit<DispatchOriginLocatorEntry, "cwd"> & { cwd: string };

function toolCallHash(toolCallId: string): string {
  return createHash("sha256").update(toolCallId).digest("hex");
}

/**
 * Resolve the host-owned locator root. It is intentionally independent of a
 * callback cwd: a relative override is rejected rather than interpreted via
 * process.cwd(), and the default lives under the user's home directory.
 */
export function dispatchOriginLocatorRoot(): string | undefined {
  const configured = process.env[DISPATCH_ORIGIN_LOCATOR_ENV]?.trim();
  if (configured) return isAbsolute(configured) ? resolve(configured) : undefined;
  const home = homedir();
  return home ? join(resolve(home), ".omp", "omp-workflows", "run-lifecycle", "dispatch-origins-v1") : undefined;
}

function canonicalCwd(cwd: string): string | undefined {
  if (!cwd) return undefined;
  try { return realpathSync(resolve(cwd)); } catch { return undefined; }
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeCandidate(value: unknown): DispatchOriginLocatorEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!isString(candidate.cwd) || !isString(candidate.run_id) || !isString(candidate.dispatch_id)) return undefined;
  const cwd = canonicalCwd(candidate.cwd);
  if (!cwd) return undefined;
  const optional = ["origin_session_id", "capability_id", "stage_id", "cursor_epoch", "slot_id", "task_id"] as const;
  if (optional.some((key) => candidate[key] !== undefined && !isString(candidate[key]))) return undefined;
  return {
    cwd,
    run_id: candidate.run_id,
    dispatch_id: candidate.dispatch_id,
    ...Object.fromEntries(optional.filter((key) => candidate[key] !== undefined).map((key) => [key, candidate[key]])),
  } as DispatchOriginLocatorEntry;
}

function acquireLock(root: string, hash: string): string | undefined {
  try { mkdirSync(root, { recursive: true, mode: 0o700 }); } catch { return undefined; }
  const lock = join(root, `${hash}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // A concurrent owner may have released the lock between stat/remove.
      }
      if (Date.now() >= deadline) return undefined;
      Atomics.wait(SLEEP_CELL, 0, 0, 10);
    }
  }
}

function withLock<T>(root: string, hash: string, action: () => T): T | undefined {
  const lock = acquireLock(root, hash);
  if (!lock) return undefined;
  try { return action(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

function readDocument(path: string, hash: string): LocatorDocument | undefined {
  if (!existsSync(path)) return { schema: LOCATOR_SCHEMA, tool_call_hash: hash, candidates: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (value.schema !== LOCATOR_SCHEMA || value.tool_call_hash !== hash || !Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES) return undefined;
    const candidates = value.candidates.map(normalizeCandidate);
    if (candidates.some((candidate) => candidate === undefined)) return undefined;
    return { schema: LOCATOR_SCHEMA, tool_call_hash: hash, candidates: candidates as DispatchOriginLocatorEntry[] };
  } catch {
    return undefined;
  }
}

function writeDocument(path: string, document: LocatorDocument): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* best effort cleanup */ }
  }
}

/**
 * Record a successfully authorized provider call. The locator is discovery
 * metadata only; canonical state remains the authority at reconciliation.
 */
export function rememberDispatchOriginLocator(toolCallId: string, input: LocatorCandidateInput): boolean {
  if (!toolCallId) return false;
  const cwd = canonicalCwd(input.cwd);
  if (!cwd || !isString(input.run_id) || !isString(input.dispatch_id)) return false;
  const candidate = normalizeCandidate({ ...input, cwd });
  if (!candidate) return false;
  const root = dispatchOriginLocatorRoot();
  if (!root) return false;
  const hash = toolCallHash(toolCallId);
  return withLock(root, hash, () => {
    const path = join(root, `${hash}.json`);
    const current = readDocument(path, hash);
    if (!current) return false;
    if (!current.candidates.some((entry) => `${entry.cwd}\u0000${entry.run_id}\u0000${entry.dispatch_id}` === `${candidate.cwd}\u0000${candidate.run_id}\u0000${candidate.dispatch_id}`)) {
      if (current.candidates.length >= MAX_CANDIDATES) return false;
      current.candidates.push(candidate);
      writeDocument(path, current);
    }
    return true;
  }) ?? false;
}

/** Read discovery candidates; malformed or contended storage fails closed. */
export function readDispatchOriginLocator(toolCallId: string): DispatchOriginLocatorEntry[] {
  if (!toolCallId) return [];
  const root = dispatchOriginLocatorRoot();
  if (!root) return [];
  const hash = toolCallHash(toolCallId);
  return withLock(root, hash, () => {
    const document = readDocument(join(root, `${hash}.json`), hash);
    return document ? document.candidates.map((entry) => ({ ...entry })) : [];
  }) ?? [];
}
