import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
export const O_DIRECTORY = fsConstants.O_DIRECTORY;
export const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
export const MAX_PINNED_WRITE_BYTES = 64 * 1024 * 1024;
export const MAX_PINNED_READ_BYTES = 8 * 1024 * 1024;
export const MAX_PINNED_APPEND_BYTES = 64 * 1024;
export const MAX_PINNED_FILE_BYTES = MAX_PINNED_READ_BYTES * 8;
export const RESERVED_TERMINAL_MARKER_BYTES = 4096;


type FileIdentity = { readonly dev: number; readonly ino: number };

export interface PinnedDirectory {
  readonly lexicalPath: string;
  readonly physicalPath: string;
  readonly fd: number;
  readonly identity: FileIdentity;
}

export interface PinnedFile {
  readonly fd: number;
  readonly identity: FileIdentity;
  readonly size: number;
}

export interface FsSafetyTestHooks {
  readonly beforeSourceOpen?: (path: string) => void;
  readonly beforeDirectoryComponent?: (path: string) => void;
  readonly beforeDirectoryOpen?: (path: string) => void;
  readonly beforeTargetOpen?: (path: string) => void;
  readonly beforeTargetRename?: (path: string) => void;
  /** Return undefined to run the real process identity probe. */
  readonly processStartIdentity?: (pid: number) => string | null | undefined;
}

let testHooks: FsSafetyTestHooks | null = null;

export function setFsSafetyTestHooks(hooks: FsSafetyTestHooks | null): void {
  testHooks = hooks;
}

function sameIdentity(left: Pick<Stats, 'dev' | 'ino'>, right: Pick<Stats, 'dev' | 'ino'>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function canonicalTargetDirectory(lexicalPath: string): string {
  if (process.platform !== 'darwin') return lexicalPath;
  if (lexicalPath === '/tmp' || lexicalPath.startsWith('/tmp/')) return `/private${lexicalPath}`;
  if (lexicalPath === '/var' || lexicalPath.startsWith('/var/')) return `/private${lexicalPath}`;
  return lexicalPath;
}

function pathHasNoSymlinkAncestors(path: string): boolean {
  const absolute = resolve(path);
  let current: string = sep;
  const components = absolute.split(sep).filter(component => component.length > 0);
  try {
    for (const component of components) {
      current = join(current, component);
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function safeName(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 255
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\u0000');
}

function descriptorPathFor(fd: number): string | null {
  if (process.platform === 'linux') return `/proc/self/fd/${fd}`;
  if (process.platform === 'darwin') return `/dev/fd/${fd}`;
  return null;
}

/** Open and retain a directory whose inode is the authority for all children. */
export function pinDirectory(directory: string): PinnedDirectory | null {
  if (O_NOFOLLOW === 0 || typeof O_DIRECTORY !== 'number') return null;
  const lexicalPath = resolve(directory);
  const canonicalPath = canonicalTargetDirectory(lexicalPath);
  let fd: number | null = null;
  let pinned = false;
  try {
    if (!pathHasNoSymlinkAncestors(canonicalPath)) return null;
    const pathStat = lstatSync(canonicalPath);
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) return null;
    fd = openSync(canonicalPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const descriptorStat = fstatSync(fd);
    if (!descriptorStat.isDirectory() || !sameIdentity(pathStat, descriptorStat)) return null;
    pinned = true;
    return {
      lexicalPath,
      physicalPath: canonicalPath,
      fd,
      identity: { dev: descriptorStat.dev, ino: descriptorStat.ino },
    };
  } catch {
    return null;
  } finally {
    if (fd !== null && !pinned) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export function closePinnedDirectory(root: PinnedDirectory): void {
  try { closeSync(root.fd); } catch { /* best effort */ }
}
export function pinnedDirectoryIsStable(root: PinnedDirectory): boolean {
  try {
    const descriptorStat = fstatSync(root.fd);
    if (!descriptorStat.isDirectory() || !sameIdentity(descriptorStat, root.identity)) return false;
    const pathStat = lstatSync(root.lexicalPath);
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory() || !sameIdentity(pathStat, root.identity)) return false;
    return realpathSync(root.lexicalPath) === root.physicalPath;
  } catch {
    return false;
  }
}

/** Create and retain a directory using no-follow component operations. */
export function pinOrCreateDirectory(directory: string): PinnedDirectory | null {
  if (O_NOFOLLOW === 0 || typeof O_DIRECTORY !== 'number') return null;
  const lexicalPath = resolve(directory);
  const canonicalPath = canonicalTargetDirectory(lexicalPath);
  let initialIdentity: FileIdentity | null = null;
  try {
    if (pathHasNoSymlinkAncestors(canonicalPath)) {
      const existing = lstatSync(canonicalPath);
      if (!existing.isDirectory() || existing.isSymbolicLink()) return null;
      initialIdentity = { dev: existing.dev, ino: existing.ino };
    }
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') return null;
  }

  let helperIdentity: FileIdentity | null = null;
  let fd: number | null = null;
  let auxiliaryFd: number | null = null;
  let pinned = false;
  try {
    if (process.platform === 'darwin') {
      const trustedFd = openSync(sep, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      try {
        const trustedStat = fstatSync(trustedFd);
        const relativePath = canonicalPath.slice(1);
        const components = relativePath.length === 0 ? [] : relativePath.split(sep);
        for (let i = 0; i < components.length; i += 1) {
          testHooks?.beforeDirectoryComponent?.(join(sep, ...components.slice(0, i + 1)));
        }
        const ensured = runDarwinHelper(
          { lexicalPath: sep, physicalPath: sep, fd: trustedFd, identity: { dev: trustedStat.dev, ino: trustedStat.ino } },
          'ensure_directory',
          { path: relativePath },
        );
        const identity = ensured?.directory;
        if (!identity || typeof identity !== 'object' || !('dev' in identity) || !('ino' in identity)
          || typeof identity.dev !== 'number' || typeof identity.ino !== 'number') return null;
        helperIdentity = { dev: identity.dev, ino: identity.ino };
      } finally {
        closeSync(trustedFd);
      }
      testHooks?.beforeDirectoryOpen?.(lexicalPath);
      if (!pathHasNoSymlinkAncestors(canonicalPath)) return null;
      fd = openSync(canonicalPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    } else {
      const rootFd = openSync(sep, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      auxiliaryFd = rootFd;
      let parentFd = rootFd;
      let parentPath = descriptorPathFor(parentFd);
      if (parentPath === null) return null;
      const components = canonicalPath.split(sep).filter(component => component.length > 0);
      for (let i = 0; i < components.length; i += 1) {
        const component = components[i];
        if (component === undefined || component.length === 0) return null;
        const childPath = join(parentPath, component);
        const childLexicalPath = join(sep, ...components.slice(0, i + 1));
        testHooks?.beforeDirectoryComponent?.(childLexicalPath);
        if (i === components.length - 1) testHooks?.beforeDirectoryOpen?.(lexicalPath);
        let childFd: number;
        try {
          childFd = openSync(childPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        } catch (error) {
          if (errnoCode(error) !== 'ENOENT') return null;
          mkdirSync(childPath, { mode: 0o700 });
          childFd = openSync(childPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        }
        const childStat = fstatSync(childFd);
        if (!childStat.isDirectory()) { closeSync(childFd); return null; }
        closeSync(parentFd);
        parentFd = childFd;
        auxiliaryFd = parentFd;
        parentPath = descriptorPathFor(parentFd);
        if (parentPath === null) return null;
      }
      fd = parentFd;
      auxiliaryFd = null;
    }
    const descriptorStat = fstatSync(fd);
    const pathStat = lstatSync(canonicalPath);
    if (!descriptorStat.isDirectory() || pathStat.isSymbolicLink() || !pathStat.isDirectory()
      || !sameIdentity(pathStat, descriptorStat)
      || (initialIdentity !== null && !sameIdentity(initialIdentity, descriptorStat))
      || (helperIdentity !== null && !sameIdentity(helperIdentity, descriptorStat))
      || !pathHasNoSymlinkAncestors(canonicalPath)) return null;
    pinned = true;
    return { lexicalPath, physicalPath: canonicalPath, fd, identity: { dev: descriptorStat.dev, ino: descriptorStat.ino } };
  } catch {
    return null;
  } finally {
    if (fd !== null && !pinned) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (auxiliaryFd !== null && auxiliaryFd !== fd) {
      try { closeSync(auxiliaryFd); } catch { /* best effort */ }
    }
  }
}

function childPath(root: PinnedDirectory, name: string): string | null {
  if (!safeName(name)) return null;
  const descriptorRoot = process.platform === 'darwin' ? null : descriptorPathFor(root.fd);
  return descriptorRoot === null ? join(root.physicalPath, name) : join(descriptorRoot, name);
}

/** Open one regular, single-link child of a retained directory. */
export function openPinnedFile(
  root: PinnedDirectory,
  name: string,
  flags: number,
  mode = 0o600,
): PinnedFile | null {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return null;
  const path = childPath(root, name);
  if (path === null) return null;
  const destination = join(root.lexicalPath, name);
  testHooks?.beforeSourceOpen?.(destination);
  let beforePath: Stats | null = null;
  try {
    beforePath = lstatSync(destination);
    if (beforePath.isSymbolicLink()) return null;
    if (!beforePath.isFile() && (flags & fsConstants.O_CREAT) === 0) return null;
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT' || (flags & fsConstants.O_CREAT) === 0) return null;
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, flags | O_NOFOLLOW | O_NONBLOCK, mode);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !pinnedDirectoryIsStable(root)) return null;
    if (beforePath !== null && !sameIdentity(beforePath, stat)) return null;
    const afterPath = lstatSync(destination);
    if (afterPath.isSymbolicLink() || !afterPath.isFile() || !sameIdentity(afterPath, stat)) return null;
    const result = { fd, identity: { dev: stat.dev, ino: stat.ino }, size: stat.size };
    fd = null;
    return result;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export function closePinnedFile(file: PinnedFile): void {
  try { closeSync(file.fd); } catch { /* best effort */ }
}

/** Read a bounded regular file, optionally taking only its final tail. */
export function readPinnedFile(
  root: PinnedDirectory,
  name: string,
  maxBytes = MAX_PINNED_READ_BYTES,
  tailBytes = maxBytes,
): Buffer | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_PINNED_READ_BYTES
    || !Number.isSafeInteger(tailBytes) || tailBytes < 0) return null;
  if (process.platform === 'darwin') {
    const result = runDarwinHelper(root, 'read_file', { name, max_bytes: maxBytes, tail_bytes: tailBytes });
    const encoded = result?.bytes;
    if (typeof encoded !== 'string') return null;
    try {
      const bytes = Buffer.from(encoded, 'base64');
      const limit = tailBytes === 0 ? maxBytes : Math.min(maxBytes, tailBytes);
      return bytes.length <= limit ? bytes : null;
    } catch {
      return null;
    }
  }
  const file = openPinnedFile(root, name, fsConstants.O_RDONLY);
  if (file === null) return null;
  try {
    if (!Number.isSafeInteger(file.size) || file.size < 0) return null;
    const amount = tailBytes === 0 ? Math.min(file.size, maxBytes) : Math.min(file.size, tailBytes, maxBytes);
    const start = file.size - amount;
    const bytes = Buffer.allocUnsafe(amount);
    let offset = 0;
    while (offset < amount) {
      const count = readSync(file.fd, bytes, offset, amount - offset, start + offset);
      if (count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(file.fd);
    if (!sameIdentity(after, file.identity) || after.size !== file.size || !pinnedDirectoryIsStable(root)) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    closePinnedFile(file);
  }
}
/** Read the complete file only when its total size is within the bound. */
export function readPinnedFileFull(
  root: PinnedDirectory,
  name: string,
  maxBytes = MAX_PINNED_READ_BYTES,
): Buffer | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_PINNED_READ_BYTES) return null;
  if (process.platform === 'darwin') {
    const result = runDarwinHelper(root, 'read_file', { name, max_bytes: maxBytes, tail_bytes: 0 });
    const encoded = result?.bytes;
    const size = result?.size;
    if (typeof encoded !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size)
      || size < 0 || size > maxBytes) return null;
    try {
      const bytes = Buffer.from(encoded, 'base64');
      return bytes.length === size ? bytes : null;
    } catch {
      return null;
    }
  }
  const file = openPinnedFile(root, name, fsConstants.O_RDONLY);
  if (file === null || file.size > maxBytes) {
    if (file !== null) closePinnedFile(file);
    return null;
  }
  try {
    const bytes = Buffer.allocUnsafe(file.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(file.fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(file.fd);
    if (!sameIdentity(after, file.identity) || after.size !== file.size || !pinnedDirectoryIsStable(root)) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    closePinnedFile(file);
  }
}

/** Append one bounded record to a pinned regular file. */
export function appendPinnedFile(root: PinnedDirectory, name: string, bytes: Buffer): boolean {
  if (bytes.length === 0 || bytes.length > MAX_PINNED_APPEND_BYTES) return false;
  const maxFileBytes = MAX_PINNED_FILE_BYTES - RESERVED_TERMINAL_MARKER_BYTES;
  if (process.platform === 'darwin') {
    return runDarwinHelper(root, 'append_file', { name, bytes: bytes.toString('base64') }) !== null;
  }
  const file = openPinnedFile(root, name, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT);
  if (file === null) return false;
  try {
    if (file.size > maxFileBytes || file.size + bytes.length > maxFileBytes) return false;
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(file.fd, bytes, offset, bytes.length - offset, null);
      if (count <= 0) return false;
      offset += count;
    }
    const after = fstatSync(file.fd);
    return sameIdentity(after, file.identity) && after.size === file.size + bytes.length && pinnedDirectoryIsStable(root);
  } catch {
    return false;
  } finally {
    closePinnedFile(file);
  }
}

/** Remove one pinned child, refusing symlink replacement. */
export function unlinkPinnedFile(root: PinnedDirectory, name: string): boolean {
  if (process.platform === 'darwin') {
    return runDarwinHelper(root, 'unlink_file', { name }) !== null;
  }
  const path = childPath(root, name);
  if (path === null || !pinnedDirectoryIsStable(root)) return false;
  try {
    const info = lstatSync(join(root.lexicalPath, name));
    if (info.isSymbolicLink()) return false;
    unlinkSync(path);
    return pinnedDirectoryIsStable(root);
  } catch {
    return false;
  }
}

export function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const override = testHooks?.processStartIdentity?.(pid);
  if (override !== undefined) return override;
  try {
    const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return null;
    const identity = result.stdout.trim();
    if (identity.length === 0 || identity.length > 128) return null;
    return Buffer.from(identity, 'utf8').toString('base64url');
  } catch {
    return null;
  }
}

const OWNER_PID = process.pid;
const OWNER_START_IDENTITY = processStartIdentity(OWNER_PID);

function markerDigest(pid: number, nonce: string, startIdentity: string): string {
  return createHash('sha256').update(`${pid}:${nonce}:${startIdentity}`, 'utf8').digest('hex');
}
function parseLockMarker(marker: string): { readonly pid: number; readonly nonce: string; readonly startIdentity: string; readonly digest: string } | null {
  const match = /^(\d+):([0-9a-f-]{36}):([^:]{1,128}):([0-9a-f]{64})$/u.exec(marker);
  if (match === null) return null;
  const pid = Number(match[1]);
  const nonce = match[2];
  const startIdentity = match[3];
  const digest = match[4];
  if (!Number.isSafeInteger(pid) || nonce === undefined || startIdentity === undefined || digest === undefined) return null;
  if (markerDigest(pid, nonce, startIdentity) !== digest) return null;
  return { pid, nonce, startIdentity, digest };
}

function recoverStaleLock(root: PinnedDirectory, name: string): boolean {
  const path = childPath(root, name);
  if (path === null || !pinnedDirectoryIsStable(root)) return false;
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > 512) return false;
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return false;
      offset += count;
    }
    const marker = bytes.toString('utf8').trim();
    const parsed = parseLockMarker(marker);
    if (parsed !== null) {
      try {
        process.kill(parsed.pid, 0);
        const currentStart = processStartIdentity(parsed.pid);
        if (currentStart === null || currentStart === parsed.startIdentity) return false;
      } catch (error) {
        if (errnoCode(error) !== 'ESRCH') return false;
      }
    } else {
      // A damaged marker is reclaimable only when its explicit owner PID is
      // provably gone; without that proof a malformed lock remains occupied.
      const owner = /^(\d+):/u.exec(marker);
      const ownerPid = owner === null ? null : Number(owner[1]);
      if (ownerPid === null || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
      try {
        process.kill(ownerPid, 0);
        return false;
      } catch (error) {
        if (errnoCode(error) !== 'ESRCH') return false;
      }
    }
    const after = fstatSync(fd);
    if (!sameIdentity(before, after) || after.size !== before.size || !pinnedDirectoryIsStable(root)) return false;
    const pathStat = lstatSync(join(root.lexicalPath, name));
    if (pathStat.isSymbolicLink() || !sameIdentity(pathStat, before)) return false;
    return unlinkPinnedFile(root, name);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/** Exclusive lock built from a descriptor-pinned O_EXCL lock file. */
function acquirePinnedExclusiveLock(
  root: PinnedDirectory,
  name: string,
  timeoutMs: number,
): () => void {
  if (!safeName(name)) throw new Error('invalid lock name');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('invalid lock timeout');
  if (process.platform === 'darwin') {
    const deadline = Date.now() + timeoutMs;
    if (OWNER_START_IDENTITY === null) throw new Error('unable to capture process start identity');
    let lease: Record<string, unknown> | null = null;
    for (;;) {
      lease = runDarwinHelper(root, 'lock_acquire', {
        name,
        owner_pid: OWNER_PID,
        owner_start: OWNER_START_IDENTITY,
      });
      if (lease !== null) break;
      if (Date.now() >= deadline) throw new Error('pinned lock is busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
    const acquired = lease;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      runDarwinHelper(root, 'lock_release', {
        name,
        dev: acquired.dev,
        ino: acquired.ino,
        digest: acquired.digest,
      });
    };
  }
  const path = childPath(root, name);
  if (path === null || !pinnedDirectoryIsStable(root)) throw new Error('pinned lock directory is unavailable');
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  let lockIdentity: FileIdentity | null = null;
  for (;;) {
    try {
      fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW | O_NONBLOCK, 0o600);
      break;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST' || Date.now() >= deadline) throw error;
      if (recoverStaleLock(root, name)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !pinnedDirectoryIsStable(root)) {
      throw new Error('lock file is unsafe');
    }
    lockIdentity = { dev: opened.dev, ino: opened.ino };
    if (OWNER_START_IDENTITY === null) throw new Error('unable to capture process start identity');
    const nonce = randomUUID();
    const marker = Buffer.from(`${OWNER_PID}:${nonce}:${OWNER_START_IDENTITY}:${markerDigest(OWNER_PID, nonce, OWNER_START_IDENTITY)}\n`, 'utf8');
    const written = writeSync(fd, marker, 0, marker.length, null);
    if (written !== marker.length) throw new Error('short lock marker write');
    fsyncSync(fd);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || !sameIdentity(info, lockIdentity) || !pinnedDirectoryIsStable(root)) {
      throw new Error('lock file changed during acquisition');
    }
  } catch (error) {
    try { closeSync(fd); } catch { /* best effort */ }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { closeSync(fd!); } catch { /* best effort */ }
    try {
      const current = lstatSync(join(root.lexicalPath, name));
      if (current.isFile() && current.nlink === 1 && lockIdentity !== null && sameIdentity(current, lockIdentity)
        && pinnedDirectoryIsStable(root)) {
        unlinkPinnedFile(root, name);
      }
    } catch {
      /* A replacement or vanished lock must not be removed. */
    }
  };
}

/** Exclusive lock built from a descriptor-pinned O_EXCL lock file. */
export function withPinnedExclusiveLock<T>(
  root: PinnedDirectory,
  name: string,
  action: () => T,
  timeoutMs = 1000,
): T {
  const release = acquirePinnedExclusiveLock(root, name, timeoutMs);
  try {
    return action();
  } finally {
    release();
  }
}

/** Async variant that keeps the descriptor-pinned lease until the action settles. */
export async function withPinnedExclusiveLockAsync<T>(
  root: PinnedDirectory,
  name: string,
  action: () => Promise<T>,
  timeoutMs = 1000,
): Promise<T> {
  const release = acquirePinnedExclusiveLock(root, name, timeoutMs);
  try {
    return await action();
  } finally {
    release();
  }
}


/** Atomic single-link replacement using the same destination primitive as reports. */
export interface PinnedWriteOptions {
  /** Publish only when the destination is absent; never replace a concurrent leaf. */
  readonly replaceExisting?: boolean;
}

export function writePinnedFile(root: PinnedDirectory, name: string, bytes: Buffer, options: PinnedWriteOptions = {}): boolean {
  const replaceExisting = options.replaceExisting !== false;
  if (!safeName(name) || bytes.length > MAX_PINNED_WRITE_BYTES) return false;
  if (!pinnedDirectoryIsStable(root)) return false;
  const destination = join(root.lexicalPath, name);
  testHooks?.beforeTargetOpen?.(destination);
  if (!pinnedDirectoryIsStable(root)) return false;
  let temporary: string | null = null;
  let descriptor: number | null = null;
  let published = false;
  try {
    if (process.platform === 'darwin') {
      const staged = runDarwinHelper(root, 'write_temp', { final: name, bytes: bytes.toString('base64') });
      const stagedName = staged?.temporary;
      if (typeof stagedName !== 'string') return false;
      temporary = stagedName;
      if (!pinnedDirectoryIsStable(root)) return false;
      testHooks?.beforeTargetRename?.(destination);
      if (!pinnedDirectoryIsStable(root)) return false;
      if (replaceExisting) {
        if (runDarwinHelper(root, 'publish', { final: name, temporary }) === null) return false;
      } else {
        linkSync(join(root.lexicalPath, temporary), destination);
        unlinkSync(join(root.lexicalPath, temporary));
      }
      temporary = null;
      published = true;
      return pinnedDirectoryIsStable(root);
    }
    const descriptorRoot = descriptorPathFor(root.fd);
    if (descriptorRoot === null) return false;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      if (!pinnedDirectoryIsStable(root)) return false;
      const candidate = join(descriptorRoot, `.${randomUUID()}.tmp`);
      try {
        descriptor = openSync(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
        temporary = candidate;
        break;
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST') return false;
      }
    }
    if (descriptor === null || temporary === null) return false;
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return false;
      offset += count;
    }
    fsyncSync(descriptor);
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.nlink !== 1 || after.size !== bytes.length) return false;
    if (!pinnedDirectoryIsStable(root)) return false;
    testHooks?.beforeTargetRename?.(destination);
    if (!pinnedDirectoryIsStable(root)) return false;
    if (replaceExisting) {
      renameSync(temporary, join(descriptorRoot, name));
    } else {
      linkSync(temporary, join(descriptorRoot, name));
      unlinkSync(temporary);
    }
    temporary = null;
    published = true;
    fsyncSync(root.fd);
    return pinnedDirectoryIsStable(root);
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    if (temporary !== null && !published) {
      if (process.platform === 'darwin') runDarwinHelper(root, 'cleanup', { temporary });
      else { try { unlinkSync(temporary); } catch { /* best effort */ } }
    }
  }
}

function sourceHasNoSymlinkAncestors(root: string, source: string): boolean {
  const rel = relative(root, source);
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`)) return false;
  let current = root;
  const pieces = rel.split(sep);
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    if (piece === undefined || piece.length === 0) return false;
    current = join(current, piece);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) return false;
    if (i < pieces.length - 1 && !info.isDirectory()) return false;
  }
  return true;
}

/** Read evidence through a pinned root, preserving report's source-swap semantics. */
export function readPinnedEvidence(root: PinnedDirectory, sourcePath: string): Buffer | null {
  if (!pinnedDirectoryIsStable(root)) return null;
  const source = resolve(sourcePath);
  if (process.platform === 'darwin') {
    const relativeSource = relative(root.lexicalPath, source);
    if (relativeSource === '' || relativeSource === '..' || relativeSource.startsWith(`..${sep}`)) return null;
    testHooks?.beforeSourceOpen?.(source);
    const result = runDarwinHelper(root, 'read_evidence', { path: relativeSource, max_bytes: MAX_PINNED_READ_BYTES });
    const encoded = result?.bytes;
    if (typeof encoded !== 'string') return null;
    const bytes = Buffer.from(encoded, 'base64');
    return bytes.length <= MAX_PINNED_READ_BYTES ? bytes : null;
  }
  let descriptor: number | null = null;
  try {
    if (!sourceHasNoSymlinkAncestors(root.lexicalPath, source)) return null;
    const pathBefore = lstatSync(source);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) return null;
    if (!isWithin(root.physicalPath, realpathSync(source))) return null;
    testHooks?.beforeSourceOpen?.(source);
    descriptor = openSync(source, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || before.size < 0
      || before.size > MAX_PINNED_READ_BYTES || !sameSnapshot(pathBefore, before) || !pinnedDirectoryIsStable(root)) return null;
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(descriptor, bytes, offset, before.size - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== before.size || !sameSnapshot(before, after)) return null;
    const pathAfter = lstatSync(source);
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || !sameSnapshot(pathAfter, after)
      || !sourceHasNoSymlinkAncestors(root.lexicalPath, source) || !isWithin(root.physicalPath, realpathSync(source))
      || !pinnedDirectoryIsStable(root)) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

/* Darwin lacks openat/renameat in Node's fs API. The helper receives the
 * retained directory as fd 3 and performs all destination operations using
 * dir_fd, while checking the retained inode before every operation. */
const DARWIN_HELPER = String.raw`import base64
import hashlib
import json
import os
import secrets
import stat
import re
import subprocess
import sys

MAX_NAME = 255
MAX_WRITE = 64 * 1024 * 1024

def fail(message):
    raise OSError(message)

def root_guard(payload):
    expected_dev = payload.get("root_dev")
    expected_ino = payload.get("root_ino")
    if not isinstance(expected_dev, int) or not isinstance(expected_ino, int): fail("invalid retained directory identity")
    info = os.fstat(3)
    if not stat.S_ISDIR(info.st_mode) or info.st_dev != expected_dev or info.st_ino != expected_ino: fail("retained directory identity changed")

def safe_name(value):
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > MAX_NAME: fail("entry name is invalid")
    if value in (".", "..") or "/" in value or "\\" in value or "\x00" in value: fail("entry name is invalid")
    return value

def ensure_directory(path):
    if not isinstance(path, str) or len(path.encode("utf-8")) > 4096 or path.startswith("/") or "\\" in path or "\x00" in path: fail("directory path is invalid")
    pieces = [] if path == "" else path.split("/")
    if len(pieces) > 128 or any((not piece or piece in (".", "..")) for piece in pieces): fail("directory path is invalid")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    current = os.dup(3)
    try:
        for piece in pieces:
            try: child = os.open(piece, flags, dir_fd=current)
            except FileNotFoundError:
                os.mkdir(piece, 0o700, dir_fd=current)
                child = os.open(piece, flags, dir_fd=current)
            os.close(current)
            current = child
        info = os.fstat(current)
        if not stat.S_ISDIR(info.st_mode): fail("target is not a directory")
        return {"dev": info.st_dev, "ino": info.st_ino, "mode": info.st_mode}
    finally:
        os.close(current)

def reserve():
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK
    for _ in range(32):
        candidate = "." + secrets.token_hex(16) + ".tmp"
        try: return candidate, os.open(candidate, flags, 0o600, dir_fd=3)
        except FileExistsError: continue
    fail("unable to reserve temporary")

def write_temp(data):
    if len(data) > MAX_WRITE: fail("write exceeds bound")
    name, fd = reserve()
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: fail("temporary is unsafe")
        offset = 0
        while offset < len(data):
            count = os.write(fd, data[offset:])
            if count <= 0: fail("short write")
            offset += count
        os.fsync(fd)
        after = os.fstat(fd)
        if not stat.S_ISREG(after.st_mode) or after.st_nlink != 1 or after.st_size != len(data): fail("temporary changed")
    except Exception:
        try: os.close(fd)
        finally:
            try: os.unlink(name, dir_fd=3)
            except Exception: pass
        raise
    os.close(fd)
    return name
MAX_FILE = 64 * 1024 * 1024
MAX_APPEND = 64 * 1024
RESERVED_MARKER = 4096

def open_regular(name, flags, mode=0o600, directory_fd=3):
    name = safe_name(name)
    fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, mode, dir_fd=directory_fd)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(fd)
        fail("entry is not a regular single-link file")
    return fd, info

def read_file(name, max_bytes, tail_bytes):
    if not isinstance(max_bytes, int) or not isinstance(tail_bytes, int):
        fail("read bounds are invalid")
    if max_bytes < 0 or max_bytes > MAX_WRITE or tail_bytes < 0:
        fail("read bounds are invalid")
    fd, info = open_regular(name, os.O_RDONLY)
    try:
        amount = min(info.st_size, max_bytes) if tail_bytes == 0 else min(info.st_size, max_bytes, tail_bytes)
        os.lseek(fd, max(0, info.st_size - amount), os.SEEK_SET)
        data = b""
        while len(data) < amount:
            chunk = os.read(fd, amount - len(data))
            if not chunk: fail("short read")
            data += chunk
        after = os.fstat(fd)
        if after.st_dev != info.st_dev or after.st_ino != info.st_ino or after.st_size != info.st_size:
            fail("entry changed during read")
        return {"bytes": base64.b64encode(data).decode("ascii"), "size": info.st_size}
    finally:
        os.close(fd)
def append_file(name, encoded):
    try: data = base64.b64decode(encoded, validate=True)
    except Exception: fail("append encoding is invalid")
    if not data or len(data) > MAX_APPEND: fail("append exceeds bound")
    fd, info = open_regular(name, os.O_WRONLY | os.O_APPEND | os.O_CREAT)
    try:
        if info.st_size > MAX_FILE - RESERVED_MARKER or info.st_size + len(data) > MAX_FILE - RESERVED_MARKER:
            fail("append file is full")
        offset = 0
        while offset < len(data):
            count = os.write(fd, data[offset:])
            if count <= 0: fail("short append")
            offset += count
        os.fsync(fd)
        after = os.fstat(fd)
        if after.st_dev != info.st_dev or after.st_ino != info.st_ino or after.st_size != info.st_size + len(data):
            fail("entry changed during append")
    finally:
        os.close(fd)
    return {"appended": len(data)}

def read_evidence(path, max_bytes=MAX_WRITE):
    if not isinstance(max_bytes, int) or max_bytes < 0 or max_bytes > MAX_WRITE: fail("evidence read bound is invalid")
    if not isinstance(path, str) or path.startswith("/") or "\x00" in path or len(path.encode("utf-8")) > 4096:
        fail("evidence path is invalid")
    pieces = path.split("/")
    if len(pieces) > 64 or any((not piece or piece in (".", "..")) for piece in pieces):
        fail("evidence path is invalid")
    current = os.dup(3)
    fd = None
    try:
        for piece in pieces[:-1]:
            child = os.open(piece, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        fd, info = open_regular(pieces[-1], os.O_RDONLY, directory_fd=current)
        if info.st_size > max_bytes: fail("evidence exceeds bound")
        data = b""
        while len(data) < info.st_size:
            chunk = os.read(fd, info.st_size - len(data))
            if not chunk: fail("short read")
            data += chunk
        after = os.fstat(fd)
        if after.st_dev != info.st_dev or after.st_ino != info.st_ino or after.st_size != info.st_size:
            fail("evidence changed during read")
        return {"bytes": base64.b64encode(data).decode("ascii")}
    finally:
        if fd is not None: os.close(fd)
        os.close(current)

def unlink_file(name):
    name = safe_name(name)
    try:
        info = os.stat(name, dir_fd=3, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: fail("entry is unsafe")
        current = os.stat(name, dir_fd=3, follow_symlinks=False)
        if current.st_dev != info.st_dev or current.st_ino != info.st_ino: fail("entry changed")
        os.unlink(name, dir_fd=3)
    except FileNotFoundError:
        return

def process_start_identity(pid):
    try:
        result = subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "lstart="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=1,
            text=True,
        )
        identity = result.stdout.strip()
        if result.returncode != 0 or not (0 < len(identity) <= 128): return None
        return base64.urlsafe_b64encode(identity.encode("utf-8")).decode("ascii").rstrip("=")
    except Exception:
        return None

def lock_digest(pid, nonce, start_identity):
    return hashlib.sha256(("%d:%s:%s" % (pid, nonce, start_identity)).encode("utf-8")).hexdigest()

def lock_acquire(name, owner_pid, owner_start):
    name = safe_name(name)
    if not isinstance(owner_pid, int) or owner_pid <= 0 or not isinstance(owner_start, str) or not (0 < len(owner_start) <= 128) or ":" in owner_start:
        fail("invalid owner identity")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        fd = os.open(name, flags, 0o600, dir_fd=3)
    except FileExistsError:
        try:
            oldfd, old = open_regular(name, os.O_RDONLY)
            try:
                marker = os.read(oldfd, 512).decode("utf-8").strip()
            finally:
                os.close(oldfd)
            parts = marker.split(":")
            if len(parts) == 4:
                try:
                    pid, nonce, start_identity, digest = int(parts[0]), parts[1], parts[2], parts[3]
                    if lock_digest(pid, nonce, start_identity) != digest: raise ValueError()
                except (ValueError, IndexError):
                    pid = None
            else:
                pid = None
            if pid is None:
                match = re.match(r"^(\d+):", marker)
                if match is None: return None
                try: pid = int(match.group(1))
                except ValueError: return None
                try:
                    os.kill(pid, 0)
                    return None
                except ProcessLookupError:
                    pass
                except PermissionError:
                    return None
            else:
                try:
                    os.kill(pid, 0)
                    current_start = process_start_identity(pid)
                    if current_start is None or current_start == start_identity: return None
                except ProcessLookupError:
                    pass
                except PermissionError:
                    return None
            current = os.stat(name, dir_fd=3, follow_symlinks=False)
            if current.st_dev != old.st_dev or current.st_ino != old.st_ino: return None
            os.unlink(name, dir_fd=3)
            return None
        except (ValueError, OSError):
            return None
    nonce = secrets.token_hex(16)
    digest = lock_digest(owner_pid, nonce, owner_start)
    marker = ("%d:%s:%s:%s\\n" % (owner_pid, nonce, owner_start, digest)).encode("utf-8")
    try:
        os.write(fd, marker)
        os.fsync(fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: fail("lock is unsafe")
        return {"dev": info.st_dev, "ino": info.st_ino, "digest": digest}
    finally:
        os.close(fd)

def lock_release(name, dev, ino, digest):
    name = safe_name(name)
    if not isinstance(dev, int) or not isinstance(ino, int) or not isinstance(digest, str): return
    try:
        fd, info = open_regular(name, os.O_RDONLY)
        try:
            marker = os.read(fd, 512).decode("utf-8").strip()
        finally:
            os.close(fd)
        parts = marker.split(":")
        if len(parts) != 4 or lock_digest(int(parts[0]), parts[1], parts[2]) != digest:
            return
        current = os.stat(name, dir_fd=3, follow_symlinks=False)
        if current.st_dev == dev and current.st_ino == ino and info.st_dev == dev and info.st_ino == ino:
            os.unlink(name, dir_fd=3)
    except (ValueError, OSError):
        return


def publish(final, temporary):
    final, temporary = safe_name(final), safe_name(temporary)
    info = os.stat(temporary, dir_fd=3, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: fail("temporary is unsafe")
    os.replace(temporary, final, src_dir_fd=3, dst_dir_fd=3)
    os.fsync(3)

def cleanup(temporary):
    try: os.unlink(safe_name(temporary), dir_fd=3)
    except FileNotFoundError: pass

try:
    payload = json.loads(sys.stdin.read())
    root_guard(payload)
    op = payload.get("op")
    if op == "ensure_directory": result = {"ok": True, "directory": ensure_directory(payload.get("path"))}
    elif op == "write_temp": result = {"ok": True, "temporary": write_temp(base64.b64decode(payload.get("bytes", ""), validate=True))}
    elif op == "append_file": result = {"ok": True, **append_file(payload.get("name"), payload.get("bytes"))}
    elif op == "read_file": result = {"ok": True, **read_file(payload.get("name"), payload.get("max_bytes"), payload.get("tail_bytes"))}
    elif op == "read_evidence": result = {"ok": True, **read_evidence(payload.get("path"), payload.get("max_bytes"))}
    elif op == "unlink_file": unlink_file(payload.get("name")); result = {"ok": True}
    elif op == "lock_acquire":
        lease = lock_acquire(payload.get("name"), payload.get("owner_pid"), payload.get("owner_start"))
        result = {"ok": lease is not None, **(lease or {})}
    elif op == "lock_release":
        lock_release(payload.get("name"), payload.get("dev"), payload.get("ino"), payload.get("digest")); result = {"ok": True}
    elif op == "publish": publish(payload.get("final"), payload.get("temporary")); result = {"ok": True}
    elif op == "cleanup": cleanup(payload.get("temporary")); result = {"ok": True}
    else: fail("unsupported operation")
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
except Exception as exc:
    sys.stdout.write(json.dumps({"ok": False, "message": str(exc)}, separators=(",", ":")))
`;

const DARWIN_HELPER_CANDIDATES = ['/usr/bin/python3'] as const;
function runDarwinHelper(root: PinnedDirectory, operation: string, payload: Record<string, unknown> = {}): Record<string, unknown> | null {
  if (process.platform !== 'darwin') return null;
  let executable: string | null = null;
  for (const candidate of DARWIN_HELPER_CANDIDATES) {
    try { accessSync(candidate, fsConstants.X_OK); executable = candidate; break; } catch { /* next */ }
  }
  if (executable === null) return null;
  const child = spawnSync(executable, ['-I', '-c', DARWIN_HELPER], {
    input: JSON.stringify({ ...payload, op: operation, root_dev: root.identity.dev, root_ino: root.identity.ino }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe', root.fd],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) return null;
  try {
    const result = JSON.parse(typeof child.stdout === 'string' ? child.stdout : Buffer.from(child.stdout ?? []).toString('utf8')) as Record<string, unknown>;
    if (result.ok !== true) return null;
    return result;
  } catch { return null; }
}
