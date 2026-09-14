import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { ctoStateDir, ensureSecureStateDirectory } from "./state.js";
import { PinnedProjectRoot, processStartIdentity } from "../specification/pinned-root.js";
import { withoutCurrentExecutionLiveness } from "../execution-liveness.js";

const CTO_RUN_LOCK_HANDLE_BRAND = Symbol("omp.cto.run-lock-handle");
const activeCtoRunLockHandles = new WeakMap<object, { lock: LockHandle }>();

export interface CtoRunLockHandle {
  readonly run_id: string;
  readonly canonical_root: string;
  readonly dev: number;
  readonly ino: number;
  readonly [CTO_RUN_LOCK_HANDLE_BRAND]: true;
}

function issueCtoRunLockHandle(projectRoot: string, runId: string, lock: LockHandle, pinnedRoot?: PinnedProjectRoot): CtoRunLockHandle {
  const canonicalRoot = pinnedRoot?.canonical_root ?? realpathSync(resolve(projectRoot));
  const identity = pinnedRoot ? { dev: pinnedRoot.dev, ino: pinnedRoot.ino, isDirectory: () => true } : lstatSync(canonicalRoot);
  if (!identity.isDirectory() || !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino)) {
    throw new Error("CTO transaction lock handle requires a canonical project directory");
  }
  const handle = Object.freeze({
    run_id: runId,
    canonical_root: canonicalRoot,
    dev: identity.dev,
    ino: identity.ino,
    [CTO_RUN_LOCK_HANDLE_BRAND]: true as const,
  });
  activeCtoRunLockHandles.set(handle, { lock });
  return handle;
}

/** Validate a lock handle issued to the currently-held run-lock callback. */
export function assertCtoRunLockHandle(handle: unknown, projectRoot: string, runId: string): asserts handle is CtoRunLockHandle {
  if (!handle || typeof handle !== "object" || (handle as Partial<CtoRunLockHandle>)[CTO_RUN_LOCK_HANDLE_BRAND] !== true) {
    throw new Error("CTO run lock handle is missing or was not issued by the active run lock");
  }
  const candidate = handle as CtoRunLockHandle;
  const activity = activeCtoRunLockHandles.get(candidate);
  if (!activity) throw new Error("CTO run lock handle is missing or was not issued by the active run lock");
  let requestedRoot: string;
  try { requestedRoot = realpathSync(resolve(projectRoot)); } catch { throw new Error("CTO run lock handle project root is unavailable"); }
  if (candidate.run_id !== runId || candidate.canonical_root !== requestedRoot) {
    throw new Error("CTO run lock handle identity does not match the requested project/run");
  }
  let current;
  try { current = lstatSync(candidate.canonical_root); } catch { throw new Error("CTO run lock handle project root is unavailable"); }
  if (!current.isDirectory() || current.dev !== candidate.dev || current.ino !== candidate.ino) {
    throw new Error("CTO run lock handle project root identity changed");
  }
  const lock = activity.lock;
  if (!lock.expected) throw new Error("CTO run lock handle has no exact lock publication");
  const currentLock = lock.pinnedRoot && lock.relativeLockPath
    ? (() => { try { return pinnedFileExpectation(lock.relativeLockPath, lock.pinnedRoot.readFile(lock.relativeLockPath, { maxBytes: MAX_LOCK_OWNER_BYTES })); } catch { return null; } })()
    : lockFileExpectation(lock.lockPath);
  if (!currentLock || currentLock.dev !== lock.expected.dev || currentLock.ino !== lock.expected.ino || currentLock.sha256 !== lock.expected.sha256) {
    throw new Error("CTO run lock handle is no longer bound to the active lock");
  }
}

const CTO_TRANSACTION_LOCK = "specification-transaction.lock";
const LOCK_RETRY_MS = 25;
export const CTO_RUN_LOCK_DEFAULT_TIMEOUT_MS = 10_000;
// New locks publish a complete owner record through one hard-link CAS. This
// grace period is only for ownerless directory locks left by legacy processes
// that crashed between mkdir(lock) and owner.json publication.
const OWNERLESS_GRACE_MS = 50;

type LockHandle = {
  token: string;
  lockPath: string;
  expected?: LockFileExpectation;
  pinnedRoot?: PinnedProjectRoot;
  relativeLockPath?: string;
  cleanupRoot?: string;
};
interface LockOwner {
  pid: number;
  token: string;
  acquired_at: string;
  start_identity?: string;
}

interface LockFileExpectation {
  dev: number;
  ino: number;
  sha256: string;
}

function sleep(ms: number): void {
  try {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* bounded fallback for worker contexts */ }
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    try {
      fsyncSync(fd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
    }
  } finally {
    closeSync(fd);
  }
}

const MAX_LOCK_OWNER_BYTES = 8 * 1024;

type SafeLockRead = {
  bytes: Buffer;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

function readLockFile(lockPath: string): SafeLockRead | null {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_LOCK_OWNER_BYTES) return null;
    const bytes = Buffer.allocUnsafe(MAX_LOCK_OWNER_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_LOCK_OWNER_BYTES) return null;
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || offset !== before.size
    ) return null;
    const pathname = lstatSync(lockPath);
    if (!pathname.isFile() || pathname.isSymbolicLink() || pathname.dev !== after.dev || pathname.ino !== after.ino) return null;
    return { bytes: bytes.subarray(0, offset), dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseLockOwnerBytes(content: Uint8Array): LockOwner | null {
  if (content.byteLength === 0 || content.byteLength > MAX_LOCK_OWNER_BYTES) return null;
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value);
  const allowed: Record<string, true> = { pid: true, token: true, acquired_at: true, start_identity: true };
  if (
    keys.length < 3
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(allowed, key))
    || !Object.prototype.hasOwnProperty.call(value, "pid")
    || !Object.prototype.hasOwnProperty.call(value, "token")
    || !Object.prototype.hasOwnProperty.call(value, "acquired_at")
  ) return null;
  if (
    !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.token !== "string"
    || value.token.length === 0
    || value.token.length > 1024
    || typeof value.acquired_at !== "string"
    || value.acquired_at.length === 0
    || value.acquired_at.length > 256
  ) return null;
  if (value.start_identity !== undefined && (typeof value.start_identity !== "string" || value.start_identity.length === 0 || value.start_identity.length > 1024)) return null;
  return {
    pid: value.pid as number,
    token: value.token,
    acquired_at: value.acquired_at,
    ...(value.start_identity !== undefined ? { start_identity: value.start_identity as string } : {}),
  };
}

interface LockObservation {
  kind: "file" | "directory" | "symlink" | "other";
  owner: LockOwner | null;
  expected?: LockFileExpectation;
  directory?: { dev: number; ino: number };
  mtimeMs: number;
}

function sameLockPathStat(left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function inspectLock(lockPath: string): LockObservation | null {
  try {
    const stat = lstatSync(lockPath);
    if (stat.isSymbolicLink()) return { kind: "symlink", owner: null, mtimeMs: stat.mtimeMs };
    if (!stat.isDirectory()) {
      if (!stat.isFile()) return { kind: "other", owner: null, mtimeMs: stat.mtimeMs };
      const read = readLockFile(lockPath);
      if (!read) {
        try {
          const current = lstatSync(lockPath);
          return sameLockPathStat(stat, current) ? { kind: "other", owner: null, mtimeMs: stat.mtimeMs } : null;
        } catch { return null; }
      }
      const owner = parseLockOwnerBytes(read.bytes);
      if (!owner) return { kind: "other", owner: null, mtimeMs: stat.mtimeMs };
      return {
        kind: "file",
        owner,
        expected: { dev: read.dev, ino: read.ino, sha256: createHash("sha256").update(read.bytes).digest("hex") },
        mtimeMs: read.mtimeMs,
      };
    }
    const ownerPath = join(lockPath, "owner.json");
    try {
      const ownerStat = lstatSync(ownerPath);
      if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return { kind: "other", owner: null, mtimeMs: stat.mtimeMs };
      const read = readLockFile(ownerPath);
      const currentDirectory = lstatSync(lockPath);
      if (!currentDirectory.isDirectory() || currentDirectory.dev !== stat.dev || currentDirectory.ino !== stat.ino) return null;
      if (!read) {
        try {
          const currentOwner = lstatSync(ownerPath);
          return sameLockPathStat(ownerStat, currentOwner) ? { kind: "other", owner: null, mtimeMs: stat.mtimeMs } : null;
        } catch { return null; }
      }
      const owner = parseLockOwnerBytes(read.bytes);
      if (!owner) return { kind: "other", owner: null, mtimeMs: stat.mtimeMs };
      return {
        kind: "directory",
        owner,
        expected: { dev: read.dev, ino: read.ino, sha256: createHash("sha256").update(read.bytes).digest("hex") },
        directory: { dev: stat.dev, ino: stat.ino },
        mtimeMs: stat.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "directory", owner: null, directory: { dev: stat.dev, ino: stat.ino }, mtimeMs: stat.mtimeMs };
      return { kind: "other", owner: null, mtimeMs: stat.mtimeMs };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function lockFileExpectation(lockPath: string): LockFileExpectation | null {
  const read = readLockFile(lockPath);
  return read
    ? { dev: read.dev, ino: read.ino, sha256: createHash("sha256").update(read.bytes).digest("hex") }
    : null;
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}
function removeRegularLockIfOwned(
  lockPath: string,
  token: string | null,
  expected: LockFileExpectation | undefined,
  projectRoot?: string,
): boolean {
  if (!expected || !projectRoot) return false;
  const canonicalRoot = realpathSync(resolve(projectRoot));
  let canonicalLockPath: string;
  try { canonicalLockPath = realpathSync(lockPath); } catch { return false; }
  const relativeLockPath = relative(canonicalRoot, canonicalLockPath);
  if (!relativeLockPath || relativeLockPath === ".." || relativeLockPath.startsWith("../") || relativeLockPath.startsWith("..\\") || relativeLockPath.startsWith("/")) return false;
  const pinnedRoot = PinnedProjectRoot.open(canonicalRoot);
  if (!pinnedRoot) return false;
  try {
    return withoutCurrentExecutionLiveness(() => {
      pinnedRoot.removeFileIfMatches(relativeLockPath, expected);
      return true;
    });
  } catch {
    return false;
  } finally {
    pinnedRoot.close();
  }
}
/** Remove a just-published lock only when observed owner token and exact inode/content prove ownership. */
function cleanupUnverifiedLock(lockPath: string, token: string, projectRoot: string): boolean {
  try {
    const observation = inspectLock(lockPath);
    if (observation?.kind !== "file" || observation.owner?.token !== token || !observation.expected) return false;
    return removeRegularLockIfOwned(lockPath, token, observation.expected, projectRoot);
  } catch {
    return false;
  }
}

function removeLock(lockPath: string, token: string, expected?: LockFileExpectation, projectRoot?: string): void {
  const observed = expected ?? lockFileExpectation(lockPath);
  removeRegularLockIfOwned(lockPath, token, observed ?? undefined, projectRoot);
}
function removeLegacyDirectoryIfEmpty(lockPath: string, expected: { dev: number; ino: number } | undefined, projectRoot: string): boolean {
  if (!expected) return false;
  let canonicalRoot: string;
  let canonicalLockPath: string;
  try {
    canonicalRoot = realpathSync(resolve(projectRoot));
    canonicalLockPath = realpathSync(lockPath);
  } catch {
    return false;
  }
  const relativeLockPath = relative(canonicalRoot, canonicalLockPath);
  if (!relativeLockPath || relativeLockPath === ".." || relativeLockPath.startsWith("../") || relativeLockPath.startsWith("..\\") || relativeLockPath.startsWith("/")) return false;
  const pinnedRoot = PinnedProjectRoot.open(canonicalRoot);
  if (!pinnedRoot) return false;
  try {
    return withoutCurrentExecutionLiveness(() => pinnedRoot.removeEmptyDirectoryIfMatches(relativeLockPath, expected));
  } catch {
    return false;
  } finally {
    pinnedRoot.close();
  }
}

function pinnedErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

type PinnedFileExpectation = { path: string; dev: number; ino: number; sha256: string };
type PinnedDirectoryExpectation = { dev: number; ino: number };
function pinnedFileExpectation(relativePath: string, file: { dev: number; ino: number; bytes: Uint8Array }): PinnedFileExpectation {
  return {
    path: relativePath,
    dev: file.dev,
    ino: file.ino,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  };
}

type PinnedLockState = {
  exists: boolean;
  directory: boolean;
  owner: LockOwner | null;
  observed?: PinnedFileExpectation;
  directoryObserved?: PinnedDirectoryExpectation;
  mtimeMs?: number;
};

function pinnedLockState(pinnedRoot: PinnedProjectRoot, relativeLockPath: string): PinnedLockState {
  try {
    const file = pinnedRoot.readFile(relativeLockPath, { maxBytes: MAX_LOCK_OWNER_BYTES });
    const owner = parseLockOwnerBytes(file.bytes);
    if (!owner) throw new Error("lock owner record is malformed");
    let mtimeMs: number | undefined;
    if (!owner.start_identity) {
      try { mtimeMs = pinnedRoot.pathEntryInfo(relativeLockPath)?.mtimeMs; } catch { /* exact file expectation remains authoritative */ }
    }
    return { exists: true, directory: false, owner, observed: pinnedFileExpectation(relativeLockPath, file), mtimeMs };
  } catch (error) {
    if (pinnedErrorCode(error) === "not_found") return { exists: false, directory: false, owner: null };
    if (pinnedErrorCode(error) !== "not_regular") throw error;
    const info = pinnedRoot.pathEntryInfo(relativeLockPath);
    if (!info || info.kind !== "directory") return { exists: false, directory: false, owner: null };
    const ownerPath = `${relativeLockPath}/owner.json`;
    try {
      const file = pinnedRoot.readFile(ownerPath, { maxBytes: MAX_LOCK_OWNER_BYTES });
      const owner = parseLockOwnerBytes(file.bytes);
      if (!owner) throw new Error("lock owner record is malformed");
      return {
        exists: true,
        directory: true,
        owner,
        observed: pinnedFileExpectation(ownerPath, file),
        directoryObserved: { dev: info.dev, ino: info.ino },
        mtimeMs: info.mtimeMs,
      };
    } catch (ownerError) {
      if (pinnedErrorCode(ownerError) === "not_found") {
        return { exists: true, directory: true, owner: null, directoryObserved: { dev: info.dev, ino: info.ino }, mtimeMs: info.mtimeMs };
      }
      throw ownerError;
    }
  }
}

function removePinnedLock(pinnedRoot: PinnedProjectRoot, relativeLockPath: string, token: string, expected?: PinnedFileExpectation): void {
  try {
    withoutCurrentExecutionLiveness(() => {
      if (expected) {
        pinnedRoot.removeFileIfMatches(relativeLockPath, expected);
        return;
      }
      const current = pinnedLockState(pinnedRoot, relativeLockPath);
      if (!current.owner || current.owner.token !== token) return;
      if (!current.observed) return;
      if (current.directory) {
        pinnedRoot.removeFileIfMatches(current.observed.path, current.observed);
        try { pinnedRoot.removeDirectory(relativeLockPath); } catch { /* replacement child keeps the directory authoritative */ }
      } else {
        pinnedRoot.removeFileIfMatches(current.observed.path, current.observed);
      }
    });
  } catch {
    // A changed, vanished, or reclaimed lock is not ours to remove.
  }
}

function lockOwnerReclaimable(owner: LockOwner | null, mtimeMs: number | undefined): boolean {
  if (!owner) return false;
  const alive = pidAlive(owner.pid);
  if (!alive) {
    // Legacy PID-only records need both a definitely dead PID and the
    // publication grace; a live PID is never stale without a start identity.
    return owner.start_identity ? true : mtimeMs !== undefined && Date.now() - mtimeMs >= OWNERLESS_GRACE_MS;
  }
  if (!owner.start_identity) return false;
  const actual = processStartIdentity(owner.pid);
  return actual !== null && actual !== owner.start_identity;
}

function removeReclaimedPinnedLock(
  pinnedRoot: PinnedProjectRoot,
  state: PinnedLockState,
  lockPath: string,
  stalePath: string,
): void {
  try {
    if (state.observed && state.observed.path === lockPath) {
      pinnedRoot.removeFileIfMatches(stalePath, state.observed);
      return;
    }
    if (state.observed && state.observed.path === `${lockPath}/owner.json`) {
      pinnedRoot.removeFileIfMatches(`${stalePath}/owner.json`, state.observed);
    }
    // Ownerless legacy directories have no observed regular file; once the
    // authoritative directory was renamed, removing an empty directory is
    // safe and cannot delete a replacement child.
    pinnedRoot.removeDirectory(stalePath);
  } catch {
    // A changed or vanished stale path remains for deterministic replay.
  }
}

function acquireAtPinned(
  pinnedRoot: PinnedProjectRoot,
  lockDir: string,
  lockFile: string,
  timeoutMs: number,
  description: string,
): LockHandle | { error: string } {
  const lockPath = join(lockDir, lockFile);
  const ownerStartIdentity = processStartIdentity();
  if (!ownerStartIdentity) return { error: `${description} unavailable: process start identity is unavailable` };
  const startedAt = Date.now();
  for (;;) {
    if (!pinnedRoot.isStable()) return { error: `${description} unavailable: pinned project root changed` };
    const token = randomUUID();
    const candidate = join(lockDir, `.${lockFile}.${process.pid}.${token}.candidate`);
    try {
      const acquired = pinnedRoot.tryAcquireExclusiveLock(
        candidate,
        lockPath,
        JSON.stringify({ pid: process.pid, token, start_identity: ownerStartIdentity, acquired_at: new Date().toISOString() }),
      );
      if (acquired) {
        let expected: PinnedFileExpectation | undefined;
        try { expected = pinnedFileExpectation(lockPath, pinnedRoot.readFile(lockPath, { maxBytes: MAX_LOCK_OWNER_BYTES })); } catch { /* fail closed below; release checks for an exact publication match */ }
        if (!expected) {
          removePinnedLock(pinnedRoot, lockPath, token);
          return { error: `${description} unavailable: owner publication could not be verified` };
        }
        if (!pinnedRoot.isStable()) {
          removePinnedLock(pinnedRoot, lockPath, token, expected);
          return { error: `${description} unavailable: pinned project root changed` };
        }
        return { token, lockPath, expected, pinnedRoot, relativeLockPath: lockPath };
      }
    } catch (error) {
      const code = pinnedErrorCode(error);
      if (code !== "exists" && code !== "not_found") return { error: `${description} unavailable: ${String(error)}` };
    }

    let state: PinnedLockState;
    try { state = pinnedLockState(pinnedRoot, lockPath); }
    catch (error) { return { error: `${description} unavailable: ${String(error)}` }; }
    const staleByGrace = state.mtimeMs !== undefined && Date.now() - state.mtimeMs >= OWNERLESS_GRACE_MS;
    let reclaim = false;
    if (state.owner) {
      reclaim = lockOwnerReclaimable(state.owner, state.mtimeMs);
    } else {
      reclaim = staleByGrace;
    }
    if (reclaim) {
      try {
        if (state.directory && state.directoryObserved) {
          pinnedRoot.removeEmptyDirectoryIfMatches(lockPath, state.directoryObserved);
        } else if (!state.directory && state.observed) {
          pinnedRoot.removeFileIfMatches(lockPath, state.observed);
        }
      } catch (error) {
        const code = pinnedErrorCode(error);
        if (code !== "not_found" && code !== "changed" && code !== "not_directory" && code !== "not_regular") {
          return { error: `${description} unavailable: ${String(error)}` };
        }
      }
    }
    if (Date.now() >= startedAt + timeoutMs) return { error: `${description} wait timeout exceeded` };
    sleep(LOCK_RETRY_MS);
  }
}
async function acquireAtPinnedAsync(
  pinnedRoot: PinnedProjectRoot,
  lockDir: string,
  lockFile: string,
  timeoutMs: number,
  description: string,
): Promise<LockHandle | { error: string }> {
  const lockPath = join(lockDir, lockFile);
  const ownerStartIdentity = processStartIdentity();
  if (!ownerStartIdentity) return { error: `${description} unavailable: process start identity is unavailable` };
  const startedAt = Date.now();
  for (;;) {
    if (!pinnedRoot.isStable()) return { error: `${description} unavailable: pinned project root changed` };
    const token = randomUUID();
    const candidate = join(lockDir, `.${lockFile}.${process.pid}.${token}.candidate`);
    try {
      const acquired = pinnedRoot.tryAcquireExclusiveLock(
        candidate,
        lockPath,
        JSON.stringify({ pid: process.pid, token, start_identity: ownerStartIdentity, acquired_at: new Date().toISOString() }),
      );
      if (acquired) {
        let expected: PinnedFileExpectation | undefined;
        try { expected = pinnedFileExpectation(lockPath, pinnedRoot.readFile(lockPath, { maxBytes: MAX_LOCK_OWNER_BYTES })); } catch { /* fail closed below; release checks for an exact publication match */ }
        if (!expected) {
          removePinnedLock(pinnedRoot, lockPath, token);
          return { error: `${description} unavailable: owner publication could not be verified` };
        }
        if (!pinnedRoot.isStable()) {
          removePinnedLock(pinnedRoot, lockPath, token, expected);
          return { error: `${description} unavailable: pinned project root changed` };
        }
        return { token, lockPath, expected, pinnedRoot, relativeLockPath: lockPath };
      }
    } catch (error) {
      const code = pinnedErrorCode(error);
      if (code !== "exists" && code !== "not_found") return { error: `${description} unavailable: ${String(error)}` };
    }
    let state: PinnedLockState;
    try { state = pinnedLockState(pinnedRoot, lockPath); }
    catch (error) { return { error: `${description} unavailable: ${String(error)}` }; }
    const staleByGrace = state.mtimeMs !== undefined && Date.now() - state.mtimeMs >= OWNERLESS_GRACE_MS;
    const reclaim = state.owner ? lockOwnerReclaimable(state.owner, state.mtimeMs) : staleByGrace;
    if (reclaim) {
      try {
        if (state.directory && state.directoryObserved) {
          pinnedRoot.removeEmptyDirectoryIfMatches(lockPath, state.directoryObserved);
        } else if (!state.directory && state.observed) {
          pinnedRoot.removeFileIfMatches(lockPath, state.observed);
        }
      } catch (error) {
        const code = pinnedErrorCode(error);
        if (code !== "not_found" && code !== "changed" && code !== "not_directory" && code !== "not_regular") {
          return { error: `${description} unavailable: ${String(error)}` };
        }
      }
    }
    if (Date.now() >= startedAt + timeoutMs) return { error: `${description} wait timeout exceeded` };
    await asyncDelay(LOCK_RETRY_MS);
  }
}

function acquireAt(lockDir: string, lockFile: string, timeoutMs: number, description: string, projectRoot: string): LockHandle | { error: string } {
  const lockPath = join(lockDir, lockFile);
  const ownerStartIdentity = processStartIdentity();
  if (!ownerStartIdentity) return { error: `${description} unavailable: process start identity is unavailable` };
  const startedAt = Date.now();
  for (;;) {
    const token = randomUUID();
    const candidate = join(lockDir, `.${lockFile}.${process.pid}.${token}.candidate`);
    let acquired = false;
    try {
      writeFileSync(
        candidate,
        JSON.stringify({ pid: process.pid, token, start_identity: ownerStartIdentity, acquired_at: new Date().toISOString() }),
        { flag: "wx", mode: 0o600 },
      );
      const candidateFd = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { fsyncSync(candidateFd); } finally { closeSync(candidateFd); }
      try {
        linkSync(candidate, lockPath);
        try {
          fsyncDirectory(lockDir);
        } catch (error) {
          removeLock(lockPath, token, undefined, projectRoot);
          return { error: `${description} unavailable: ${String(error)}` };
        }
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return { error: `${description} unavailable: ${String(error)}` };
        }
      } finally {
        try { unlinkSync(candidate); } catch { /* candidate cleanup is best effort */ }
      }
      if (acquired) {
        const expected = lockFileExpectation(lockPath);
        if (!expected) {
          cleanupUnverifiedLock(lockPath, token, projectRoot);
          return { error: `${description} unavailable: owner publication could not be verified` };
        }
        return { token, lockPath, expected, cleanupRoot: projectRoot };
      }
    } catch (error) {
      try { unlinkSync(candidate); } catch { /* candidate cleanup is best effort */ }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return { error: `${description} unavailable: ${String(error)}` };
      }
    }

    const observation = inspectLock(lockPath);
    if (!observation) continue;
    if (observation.kind === "symlink" || observation.kind === "other") return { error: `${description} unavailable: lock path is unsafe` };
    const staleByGrace = Date.now() - observation.mtimeMs >= OWNERLESS_GRACE_MS;
    let reclaim = observation.owner ? lockOwnerReclaimable(observation.owner, observation.mtimeMs) : staleByGrace;
    if (observation.kind === "directory" && observation.owner === null) reclaim = staleByGrace;
    if (reclaim) {
      if (observation.kind === "file" && observation.expected) {
        removeRegularLockIfOwned(lockPath, observation.owner?.token ?? null, observation.expected, projectRoot);
      } else if (observation.kind === "directory") {
        // Legacy directory locks are reclaimed only through the bounded,
        // descriptor-relative emptiness check and exact inode CAS.
        removeLegacyDirectoryIfEmpty(lockPath, observation.directory, projectRoot);
      }
    }
    if (Date.now() >= startedAt + timeoutMs) return { error: `${description} wait timeout exceeded` };
    sleep(LOCK_RETRY_MS);
  }
}

function releaseLock(lock: LockHandle): void {
  if (lock.pinnedRoot && lock.relativeLockPath) {
    removePinnedLock(lock.pinnedRoot, lock.relativeLockPath, lock.token, lock.expected as PinnedFileExpectation | undefined);
  } else {
    removeLock(lock.lockPath, lock.token, lock.expected, lock.cleanupRoot);
  }
}

function acquire(root: string, runId: string, timeoutMs: number, pinnedRoot?: PinnedProjectRoot): LockHandle | { error: string } {
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) return { error: "CTO transaction lock unavailable: pinned project root changed" };
    return acquireAtPinned(pinnedRoot, join(".work-state", "cto", runId), CTO_TRANSACTION_LOCK, timeoutMs, "CTO transaction lock");
  }
  let runDir: string;
  try {
    runDir = ctoStateDir(runId, root);
    // Create only the already-authorized CTO run directory. Every component
    // is checked by ctoStateDir/secure atomic writers.
    ensureSecureStateDirectory(runDir);
  } catch (error) {
    return { error: `CTO transaction lock unavailable: ${String(error)}` };
  }
  return acquireAt(runDir, CTO_TRANSACTION_LOCK, timeoutMs, "CTO transaction lock", root);
}
/** One asynchronous retry delay; unlike sleep(), this never blocks the event loop. */
function asyncDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Async lock acquisition mirrors acquire() but yields between failed CAS
 * attempts. The synchronous acquire cannot be used around an awaited callback:
 * a same-process contender would block the event loop and prevent the owner
 * from ever reaching its finally/release path.
 */
async function acquireAtAsync(lockDir: string, lockFile: string, timeoutMs: number, description: string, projectRoot: string): Promise<LockHandle | { error: string }> {
  const lockPath = join(lockDir, lockFile);
  const ownerStartIdentity = processStartIdentity();
  if (!ownerStartIdentity) return { error: `${description} unavailable: process start identity is unavailable` };
  const startedAt = Date.now();
  for (;;) {
    const token = randomUUID();
    const candidate = join(lockDir, `.${lockFile}.${process.pid}.${token}.candidate`);
    let acquired = false;
    try {
      writeFileSync(
        candidate,
        JSON.stringify({ pid: process.pid, token, start_identity: ownerStartIdentity, acquired_at: new Date().toISOString() }),
        { flag: "wx", mode: 0o600 },
      );
      const candidateFd = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { fsyncSync(candidateFd); } finally { closeSync(candidateFd); }
      try {
        linkSync(candidate, lockPath);
        fsyncDirectory(lockDir);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return { error: `${description} unavailable: ${String(error)}` };
        }
      } finally {
        try { unlinkSync(candidate); } catch { /* candidate cleanup is best effort */ }
      }
      if (acquired) {
        const expected = lockFileExpectation(lockPath);
        if (!expected) {
          cleanupUnverifiedLock(lockPath, token, projectRoot);
          return { error: `${description} unavailable: owner publication could not be verified` };
        }
        return { token, lockPath, expected, cleanupRoot: projectRoot };
      }
    } catch (error) {
      try { unlinkSync(candidate); } catch { /* candidate cleanup is best effort */ }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return { error: `${description} unavailable: ${String(error)}` };
      }
    }

    const observation = inspectLock(lockPath);
    if (!observation) continue;
    if (observation.kind === "symlink" || observation.kind === "other") return { error: `${description} unavailable: lock path is unsafe` };
    const staleByGrace = Date.now() - observation.mtimeMs >= OWNERLESS_GRACE_MS;
    const reclaim = observation.owner ? lockOwnerReclaimable(observation.owner, observation.mtimeMs) : staleByGrace;
    if (reclaim) {
      if (observation.kind === "file" && observation.expected) {
        removeRegularLockIfOwned(lockPath, observation.owner?.token ?? null, observation.expected, projectRoot);
      } else if (observation.kind === "directory") {
        // Keep the legacy path fail-closed with the same bounded descriptor CAS.
        removeLegacyDirectoryIfEmpty(lockPath, observation.directory, projectRoot);
      }
    }
    await asyncDelay(LOCK_RETRY_MS);
  }
}

function acquireAsync(root: string, runId: string, timeoutMs: number, pinnedRoot?: PinnedProjectRoot): Promise<LockHandle | { error: string }> {
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) return Promise.resolve({ error: "CTO transaction lock unavailable: pinned project root changed" });
    // Async finalization does not block on the synchronous pinned backend; the
    // caller still receives the same lock-order and root-stability guarantees.
    return acquireAtPinnedAsync(pinnedRoot, join(".work-state", "cto", runId), CTO_TRANSACTION_LOCK, timeoutMs, "CTO transaction lock");
  }
  let runDir: string;
  try {
    runDir = ctoStateDir(runId, root);
    ensureSecureStateDirectory(runDir);
  } catch (error) {
    return Promise.resolve({ error: `CTO transaction lock unavailable: ${String(error)}` });
  }
  return acquireAtAsync(runDir, CTO_TRANSACTION_LOCK, timeoutMs, "CTO transaction lock", root);
}
export const CTO_REGISTRY_LOCK_FILE = ".standby-registry.lock";

function acquireRegistry(root: string, timeoutMs: number, pinnedRoot?: PinnedProjectRoot): LockHandle | { error: string } {
  if (pinnedRoot) {
    try {
      if (!pinnedRoot.isStable()) return { error: "CTO registry lock unavailable: pinned project root changed" };
      pinnedRoot.ensureDirectory(join(".work-state", "cto"));
      if (!pinnedRoot.isStable()) return { error: "CTO registry lock unavailable: pinned project root changed" };
      return acquireAtPinned(pinnedRoot, join(".work-state", "cto"), CTO_REGISTRY_LOCK_FILE, timeoutMs, "CTO registry lock");
    } catch (error) {
      return { error: `CTO registry lock unavailable: ${String(error)}` };
    }
  }
  try {
    const ctoRoot = ensureSecureStateDirectory(join(resolve(root), ".work-state", "cto"));
    return acquireAt(ctoRoot, CTO_REGISTRY_LOCK_FILE, timeoutMs, "CTO registry lock", root);
  } catch (error) {
    return { error: `CTO registry lock unavailable: ${String(error)}` };
  }
}

async function acquireRegistryAsync(root: string, timeoutMs: number, pinnedRoot?: PinnedProjectRoot): Promise<LockHandle | { error: string }> {
  if (pinnedRoot) {
    try {
      if (!pinnedRoot.isStable()) return { error: "CTO registry lock unavailable: pinned project root changed" };
      pinnedRoot.ensureDirectory(join(".work-state", "cto"));
      if (!pinnedRoot.isStable()) return { error: "CTO registry lock unavailable: pinned project root changed" };
      return acquireAtPinnedAsync(pinnedRoot, join(".work-state", "cto"), CTO_REGISTRY_LOCK_FILE, timeoutMs, "CTO registry lock");
    } catch (error) {
      return { error: `CTO registry lock unavailable: ${String(error)}` };
    }
  }
  try {
    const ctoRoot = ensureSecureStateDirectory(join(resolve(root), ".work-state", "cto"));
    return acquireAtAsync(ctoRoot, CTO_REGISTRY_LOCK_FILE, timeoutMs, "CTO registry lock", root);
  } catch (error) {
    return { error: `CTO registry lock unavailable: ${String(error)}` };
  }
}

/**
 * Serialize all durable standby discovery/creation for one project. A
 * caller-owned pin keeps lock acquisition, discovery, and creation on one
 * stable project-root identity.
 */
export function withCtoRegistryLock<T>(
  projectRoot: string,
  callback: () => T,
  options: { timeoutMs?: number; pinnedRoot?: PinnedProjectRoot } = {},
): T {
  const lock = acquireRegistry(projectRoot, options.timeoutMs ?? CTO_RUN_LOCK_DEFAULT_TIMEOUT_MS, options.pinnedRoot);
  if ("error" in lock) throw new Error(lock.error);
  try {
    return callback();
  } finally {
    releaseLock(lock);
  }
}

/** Async variant for callers that must keep the registry lock across awaits. */
export async function withCtoRegistryLockAsync<T>(
  projectRoot: string,
  callback: () => Promise<T>,
  options: { timeoutMs?: number; pinnedRoot?: PinnedProjectRoot } = {},
): Promise<T> {
  const lock = await acquireRegistryAsync(projectRoot, options.timeoutMs ?? CTO_RUN_LOCK_DEFAULT_TIMEOUT_MS, options.pinnedRoot);
  if ("error" in lock) throw new Error(lock.error);
  try {
    return await callback();
  } finally {
    releaseLock(lock);
  }
}

/**
 * Serialize every durable CTO preparation/execution operation for one project
 * and run. The callback runs while the lock is held; callers must not yield or
 * invoke another withCtoRunLock for the same run from inside it.
 */
export function withCtoRunLock<T>(
  projectRoot: string,
  ctoRunId: string,
  callback: (handle: CtoRunLockHandle) => T,
  options: { timeoutMs?: number; pinnedRoot?: PinnedProjectRoot } = {},
): T {
  const lock = acquire(projectRoot, ctoRunId, options.timeoutMs ?? CTO_RUN_LOCK_DEFAULT_TIMEOUT_MS, options.pinnedRoot);
  if ("error" in lock) throw new Error(lock.error);
  let handle: CtoRunLockHandle | undefined;
  try {
    handle = issueCtoRunLockHandle(projectRoot, ctoRunId, lock, options.pinnedRoot);
    return callback(handle);
  } finally {
    if (handle) activeCtoRunLockHandles.delete(handle);
    releaseLock(lock);
  }
}

/**
 * Async counterpart that keeps the per-run lock held across secure source
 * revalidation and the following admission/claim transaction. Returning from
 * the synchronous lock before an awaited callback would reopen a TOCTOU race.
 */
export async function withCtoRunLockAsync<T>(
  projectRoot: string,
  ctoRunId: string,
  callback: (handle: CtoRunLockHandle) => Promise<T>,
  options: { timeoutMs?: number; pinnedRoot?: PinnedProjectRoot } = {},
): Promise<T> {
  const lock = await acquireAsync(projectRoot, ctoRunId, options.timeoutMs ?? CTO_RUN_LOCK_DEFAULT_TIMEOUT_MS, options.pinnedRoot);
  if ("error" in lock) throw new Error(lock.error);
  let handle: CtoRunLockHandle | undefined;
  try {
    handle = issueCtoRunLockHandle(projectRoot, ctoRunId, lock, options.pinnedRoot);
    return await callback(handle);
  } finally {
    if (handle) activeCtoRunLockHandles.delete(handle);
    releaseLock(lock);
  }
}


export const CTO_TRANSACTION_LOCK_FILE = CTO_TRANSACTION_LOCK;
