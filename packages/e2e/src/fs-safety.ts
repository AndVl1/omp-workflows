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
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
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


export type FileIdentity = { readonly dev: number; readonly ino: number };

export interface PinnedDirectoryCreationReceipt {
  readonly parent: PinnedDirectory;
  readonly name: string;
  readonly identity: FileIdentity;
  readonly path: string;
}

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
  readonly beforeSourcePin?: (path: string) => void;
  readonly beforeDirectoryComponent?: (path: string) => void;
  readonly beforeDirectoryOpen?: (path: string) => void;
  readonly afterDirectoryOpen?: (path: string) => void;
  readonly beforeTargetOpen?: (path: string) => void;
  readonly beforeTargetRename?: (path: string) => void;
  readonly beforeExactQuarantine?: (path: string) => void;
  /** Return undefined to run the real process identity probe. */
  readonly processStartIdentity?: (pid: number) => string | null | undefined;
}

let testHooks: FsSafetyTestHooks | null = null;

export function setFsSafetyTestHooks(hooks: FsSafetyTestHooks | null): void {
  testHooks = hooks;
}

export function notifyBeforeSourcePin(path: string): void {
  testHooks?.beforeSourcePin?.(path);
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

function duplicateDirectoryDescriptor(fd: number): number | null {
  const path = descriptorPathFor(fd);
  if (path === null) return null;
  try { return openSync(path, fsConstants.O_RDONLY | O_DIRECTORY); } catch { return null; }
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

export function closePinnedDirectoryCreationReceipts(receipts: readonly PinnedDirectoryCreationReceipt[]): void {
  for (const receipt of receipts) closePinnedDirectory(receipt.parent);
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
export function pinOrCreateDirectory(directory: string, created?: PinnedDirectoryCreationReceipt[]): PinnedDirectory | null {
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
  const localCreated: PinnedDirectoryCreationReceipt[] = [];
  let fd: number | null = null;
  let auxiliaryFd: number | null = null;
  let pinned = false;
  try {
    if (process.platform === 'darwin') {
      let currentFd: number | null = openSync(sep, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      let currentPhysicalPath: string = sep;
      let currentLexicalPath: string = sep;
      try {
        const components = canonicalPath.slice(1).split(sep).filter(component => component.length > 0);
        const lexicalComponents = lexicalPath.slice(1).split(sep).filter(component => component.length > 0);
        const canonicalPrivatePrefix = canonicalPath.startsWith('/private/') && !lexicalPath.startsWith('/private/') ? 1 : 0;
        for (let index = 0; index < components.length; index += 1) {
          const component = components[index]!;
          const lexicalIndex = index - canonicalPrivatePrefix;
          const childLexicalPath = lexicalIndex < 0 ? sep : join(sep, ...lexicalComponents.slice(0, lexicalIndex + 1));
          testHooks?.beforeDirectoryComponent?.(childLexicalPath);

          if (currentFd === null) return null;
          const parentInfo = fstatSync(currentFd);
          if (!parentInfo.isDirectory()) return null;
          const parentPathStat = lstatSync(currentPhysicalPath);
          if (parentPathStat.isSymbolicLink() || !parentPathStat.isDirectory() || !sameIdentity(parentPathStat, parentInfo)) return null;
          const parentRoot: PinnedDirectory = {
            lexicalPath: currentLexicalPath,
            physicalPath: currentPhysicalPath,
            fd: currentFd,
            identity: { dev: parentInfo.dev, ino: parentInfo.ino },
          };
          const ensured = runDarwinHelper(parentRoot, 'ensure_directory', { path: component });
          const ensuredDirectory = ensured?.directory;
          if (typeof ensuredDirectory !== 'object' || ensuredDirectory === null) return null;
          const ensuredDetails = ensuredDirectory as Record<string, unknown>;
          const childDev = ensuredDetails.child_dev;
          const childIno = ensuredDetails.child_ino;
          if (typeof childDev !== 'number' || typeof childIno !== 'number' || typeof ensuredDetails.created !== 'boolean') return null;
          if (index === components.length - 1) testHooks?.beforeDirectoryOpen?.(lexicalPath);
          const childPath = join(currentPhysicalPath, component);
          const childFd = openSync(childPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
          const childInfo = fstatSync(childFd);
          const childPathStat = lstatSync(childPath);
          if (!childInfo.isDirectory() || childPathStat.isSymbolicLink()
            || !sameIdentity(childInfo, childPathStat)
            || childInfo.dev !== childDev || childInfo.ino !== childIno) {
            closeSync(childFd);
            return null;
          }
          const childPhysicalPath = realpathSync(childPath);
          if (ensuredDetails.created === true) {
            const retainedParentFd = duplicateDirectoryDescriptor(currentFd);
            if (retainedParentFd === null) {
              closeSync(childFd);
              return null;
            }
            localCreated.push({
              parent: { lexicalPath: currentLexicalPath, physicalPath: currentPhysicalPath, fd: retainedParentFd, identity: { dev: parentInfo.dev, ino: parentInfo.ino } },
              name: component,
              identity: { dev: childInfo.dev, ino: childInfo.ino },
              path: childLexicalPath,
            });
          }
          helperIdentity = { dev: childDev, ino: childIno };
          closeSync(currentFd);
          currentFd = childFd;
          currentPhysicalPath = childPhysicalPath;
          currentLexicalPath = childLexicalPath;
        }
        if (currentFd === null) return null;
        fd = currentFd;
        currentFd = null;
      } finally {
        if (currentFd !== null) {
          try { closeSync(currentFd); } catch { /* best effort */ }
        }
      }
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
        let createdChild = false;
        try {
          childFd = openSync(childPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        } catch (error) {
          if (errnoCode(error) !== 'ENOENT') return null;
          mkdirSync(childPath, { mode: 0o700 });
          createdChild = true;
          childFd = openSync(childPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        }
        const childStat = fstatSync(childFd);
        if (!childStat.isDirectory()) { closeSync(childFd); return null; }
        if (createdChild) {
          const parentStat = fstatSync(parentFd);
          const retainedParentFd = duplicateDirectoryDescriptor(parentFd);
          if (retainedParentFd === null) return null;
          localCreated.push({
            parent: { lexicalPath: join(sep, ...components.slice(0, i)), physicalPath: realpathSync(descriptorPathFor(parentFd) ?? join(sep, ...components.slice(0, i))), fd: retainedParentFd, identity: { dev: parentStat.dev, ino: parentStat.ino } },
            name: component,
            identity: { dev: childStat.dev, ino: childStat.ino },
            path: childLexicalPath,
          });
        }
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
    if (created !== undefined) created.push(...localCreated);
    else closePinnedDirectoryCreationReceipts(localCreated);
    return { lexicalPath, physicalPath: canonicalPath, fd, identity: { dev: descriptorStat.dev, ino: descriptorStat.ino } };
  } catch {
    return null;
  } finally {
    if (!pinned) closePinnedDirectoryCreationReceipts(localCreated);
    if (fd !== null && !pinned) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (auxiliaryFd !== null && auxiliaryFd !== fd) {
      try { closeSync(auxiliaryFd); } catch { /* best effort */ }
    }
  }
}

/** Pin a descendant using a retained descriptor for every component. */
export function pinChildDirectory(root: PinnedDirectory, components: readonly string[], created?: PinnedDirectoryCreationReceipt[]): PinnedDirectory | null {
  if (components.length === 0 || components.some(component => !safeName(component))) return null;
  if (!pinnedDirectoryIsStable(root)) return null;
  const descriptorRoot = descriptorPathFor(root.fd);
  if (descriptorRoot === null) return null;
  const relativePath = components.join(sep);
  const lexicalPath = join(root.lexicalPath, ...components);
  const canonicalPath = canonicalTargetDirectory(lexicalPath);
  testHooks?.beforeDirectoryOpen?.(lexicalPath);
  const localCreated: PinnedDirectoryCreationReceipt[] = [];
  let fd: number | null = null;
  let descriptorPhysicalPath: string | null = null;
  let pinned = false;
  try {
    if (process.platform === 'darwin') {
      let currentFd: number | null = duplicateDirectoryDescriptor(root.fd);
      if (currentFd === null) return null;
      let currentPhysicalPath: string = root.physicalPath;
      let currentLexicalPath: string = root.lexicalPath;
      try {
        for (let index = 0; index < components.length; index += 1) {
          const component = components[index]!;
          const componentLexical = join(root.lexicalPath, ...components.slice(0, index + 1));
          testHooks?.beforeDirectoryComponent?.(componentLexical);
          if (currentFd === null) return null;
          const parentInfo = fstatSync(currentFd);
          if (!parentInfo.isDirectory()) return null;
          const parentPathStat = lstatSync(currentPhysicalPath);
          if (parentPathStat.isSymbolicLink() || !parentPathStat.isDirectory() || !sameIdentity(parentPathStat, parentInfo)) return null;
          const parentRoot: PinnedDirectory = {
            lexicalPath: currentLexicalPath,
            physicalPath: currentPhysicalPath,
            fd: currentFd,
            identity: { dev: parentInfo.dev, ino: parentInfo.ino },
          };
          const ensured = runDarwinHelper(parentRoot, 'ensure_directory', { path: component });
          const childDev = ensured?.child_dev;
          const childIno = ensured?.child_ino;
          if (typeof childDev !== 'number' || typeof childIno !== 'number' || typeof ensured?.created !== 'boolean') return null;
          testHooks?.beforeDirectoryOpen?.(componentLexical);
          const childPath = join(currentPhysicalPath, component);
          const childFd = openSync(childPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
          const childInfo = fstatSync(childFd);
          const childPathStat = lstatSync(childPath);
          if (!childInfo.isDirectory() || childPathStat.isSymbolicLink()
            || !sameIdentity(childInfo, childPathStat)
            || childInfo.dev !== childDev || childInfo.ino !== childIno) {
            closeSync(childFd);
            return null;
          }
          const childPhysicalPath = realpathSync(childPath);
          const withinRoot = relative(root.physicalPath, childPhysicalPath);
          if (withinRoot === '' || withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || withinRoot.startsWith(sep)) {
            closeSync(childFd);
            return null;
          }
          if (ensured.created === true) {
            const retainedParentFd = duplicateDirectoryDescriptor(currentFd);
            if (retainedParentFd === null) {
              closeSync(childFd);
              return null;
            }
            localCreated.push({
              parent: { lexicalPath: currentLexicalPath, physicalPath: currentPhysicalPath, fd: retainedParentFd, identity: { dev: parentInfo.dev, ino: parentInfo.ino } },
              name: component,
              identity: { dev: childInfo.dev, ino: childInfo.ino },
              path: componentLexical,
            });
          }
          closeSync(currentFd);
          currentFd = childFd;
          currentPhysicalPath = childPhysicalPath;
          currentLexicalPath = componentLexical;
        }
        if (currentFd === null) return null;
        fd = currentFd;
        currentFd = null;
        descriptorPhysicalPath = currentPhysicalPath;
      } finally {
        if (currentFd !== null) {
          try { closeSync(currentFd); } catch { /* best effort */ }
        }
      }
    } else {
      let parentFd = root.fd;
      let parentPath = descriptorRoot;
      for (let index = 0; index < components.length; index += 1) {
        const component = components[index];
        if (component === undefined) return null;
        const componentLexical = join(root.lexicalPath, ...components.slice(0, index + 1));
        testHooks?.beforeDirectoryComponent?.(componentLexical);
        const childPath = join(parentPath, component);
        let childFd: number;
        let createdChild = false;
        try {
          childFd = openSync(childPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        } catch (error) {
          if (errnoCode(error) !== 'ENOENT') return null;
          mkdirSync(childPath, { mode: 0o700 });
          createdChild = true;
          childFd = openSync(childPath, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        }
        const childStat = fstatSync(childFd);
        if (!childStat.isDirectory()) {
          closeSync(childFd);
          return null;
        }
        if (createdChild) {
          const parentStat = fstatSync(parentFd);
          const retainedParentFd = duplicateDirectoryDescriptor(parentFd);
          if (retainedParentFd === null) return null;
          localCreated.push({
            parent: { lexicalPath: join(root.lexicalPath, ...components.slice(0, index)), physicalPath: realpathSync(parentPath), fd: retainedParentFd, identity: { dev: parentStat.dev, ino: parentStat.ino } },
            name: component,
            identity: { dev: childStat.dev, ino: childStat.ino },
            path: componentLexical,
          });
        }
        if (fd !== null) closeSync(fd);
        fd = childFd;
        parentFd = childFd;
        parentPath = descriptorPathFor(parentFd) ?? '';
        if (parentPath.length === 0) return null;
      }
    }
    if (fd === null) return null;
    testHooks?.afterDirectoryOpen?.(lexicalPath);
    if (!pathHasNoSymlinkAncestors(canonicalPath)) return null;
    const descriptorStat = fstatSync(fd);
    const pathStat = lstatSync(canonicalPath);
    if (!descriptorStat.isDirectory() || pathStat.isSymbolicLink() || !pathStat.isDirectory()
      || !sameIdentity(pathStat, descriptorStat) || !pinnedDirectoryIsStable(root)) return null;
    const physicalPath = descriptorPhysicalPath ?? realpathSync(canonicalPath);
    const withinRoot = relative(root.physicalPath, physicalPath);
    if (withinRoot === '' || withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || withinRoot.startsWith(sep)) return null;
    pinned = true;
    if (created !== undefined) created.push(...localCreated);
    else closePinnedDirectoryCreationReceipts(localCreated);
    return { lexicalPath, physicalPath, fd, identity: { dev: descriptorStat.dev, ino: descriptorStat.ino } };
  } catch {
    return null;
  } finally {
    if (!pinned) closePinnedDirectoryCreationReceipts(localCreated);
    if (fd !== null && !pinned) {
      try { closeSync(fd); } catch { /* best effort */ }
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
/** Detect any existing direct child without accepting unsafe link metadata. */
export function pinnedChildEntryExists(root: PinnedDirectory, name: string): boolean {
  if (!safeName(name)) return false;
  if (process.platform === 'darwin') {
    return runDarwinHelper(root, 'entry_exists', { name })?.exists === true;
  }
  const descriptorRoot = descriptorPathFor(root.fd);
  if (descriptorRoot === null || !pinnedDescriptorIsStable(root)) return false;
  try {
    lstatSync(join(descriptorRoot, name));
    return true;
  } catch (error) {
    return errnoCode(error) !== 'ENOENT';
  }
}

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

export interface PinnedExactUnlinkOptions {
  /** Internal rollback mode: use only the retained descriptor after lexical replacement. */
  readonly requireStable?: boolean;
}

export function unlinkPinnedFileIfExact(
  root: PinnedDirectory,
  name: string,
  expected: Buffer,
  options: PinnedExactUnlinkOptions = {},
): boolean {
  const requireStable = options.requireStable !== false;
  const rootStable = (): boolean => requireStable ? pinnedDirectoryIsStable(root) : pinnedDescriptorIsStable(root);
  if (!safeName(name) || expected.length > MAX_PINNED_WRITE_BYTES || !rootStable()) return false;
  const quarantine = '.omp-unlink-' + randomUUID().replace(/-/gu, '') + '.tmp';
  const digest = createHash('sha256').update(expected).digest('hex');
  const descriptorRoot = descriptorPathFor(root.fd);
  if (descriptorRoot === null) return false;
  const descriptorIdentity = (entry: string): { readonly dev: number; readonly ino: number } | null => {
    let fd: number | null = null;
    try {
      fd = openSync(join(descriptorRoot, entry), fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const info = fstatSync(fd);
      return info.isFile() && info.nlink === 1 ? { dev: info.dev, ino: info.ino } : null;
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
    }
  };
  const restoreLinuxQuarantine = (expectedIdentity: { readonly dev: number; readonly ino: number } | null): boolean => {
    const currentIdentity = descriptorIdentity(quarantine);
    if (expectedIdentity === null || currentIdentity === null
      || currentIdentity.dev !== expectedIdentity.dev || currentIdentity.ino !== expectedIdentity.ino) return false;
    try {
      linkSync(join(descriptorRoot, quarantine), join(descriptorRoot, name));
      unlinkSync(join(descriptorRoot, quarantine));
      return true;
    } catch {
      return false;
    }
  };
  const verifyDescriptorFile = (entry: string): boolean => {
    let fd: number | null = null;
    try {
      fd = openSync(join(descriptorRoot, entry), fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const before = fstatSync(fd);
      if (!before.isFile() || before.size !== expected.length) return false;
      const bytes = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) return false;
        offset += count;
      }
      const after = fstatSync(fd);
      return sameIdentity(before, after) && after.size === before.size && bytes.equals(expected);
    } catch {
      return false;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
    }
  };
  if (process.platform === 'darwin') {
    testHooks?.beforeExactQuarantine?.(join(root.lexicalPath, name));
    const moved = runDarwinHelper(root, 'quarantine_if_exact', { name, quarantine, size: expected.length, sha256: digest });
    if (moved?.quarantined !== true) {
      if (moved?.moved === true && Number.isSafeInteger(moved.dev) && Number.isSafeInteger(moved.ino)) {
        runDarwinHelper(root, 'restore_quarantine', { quarantine, name, expected_dev: moved.dev, expected_ino: moved.ino });
      }
      return false;
    }
    const quarantineDev = moved.dev;
    const quarantineIno = moved.ino;
    if (!Number.isSafeInteger(quarantineDev) || !Number.isSafeInteger(quarantineIno)) return false;
    testHooks?.beforeTargetRename?.(join(root.lexicalPath, name));
    return runDarwinHelper(root, 'unlink_quarantine', { quarantine, size: expected.length, sha256: digest, expected_dev: quarantineDev, expected_ino: quarantineIno })?.removed === true;
  }
  if (!verifyDescriptorFile(name)) return false;
  testHooks?.beforeExactQuarantine?.(join(root.lexicalPath, name));
  try {
    renameSync(join(descriptorRoot, name), join(descriptorRoot, quarantine));
  } catch {
    return false;
  }
  const movedIdentity = descriptorIdentity(quarantine);
  if (movedIdentity === null) return false;
  if (!verifyDescriptorFile(quarantine)) {
    restoreLinuxQuarantine(movedIdentity);
    return false;
  }
  testHooks?.beforeTargetRename?.(join(root.lexicalPath, name));
  if (!verifyDescriptorFile(quarantine)) {
    restoreLinuxQuarantine(movedIdentity);
    return false;
  }
  try {
    unlinkSync(join(descriptorRoot, quarantine));
    return true;
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
    return unlinkPinnedFileIfExact(root, name, bytes);
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
      if (errnoCode(error) !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('pinned lock is busy');
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
    const boundMarker = readPinnedFileFull(root, name, marker.length);
    const pathStat = lstatSync(join(root.lexicalPath, name));
    if (!info.isFile() || info.nlink !== 1 || !sameIdentity(info, lockIdentity)
      || boundMarker === null || !boundMarker.equals(marker)
      || pathStat.isSymbolicLink() || !sameIdentity(pathStat, info)
      || !pinnedDirectoryIsStable(root)) {
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


function pinnedDescriptorIsStable(root: PinnedDirectory): boolean {
  try {
    const info = fstatSync(root.fd);
    return info.isDirectory() && sameIdentity(info, root.identity);
  } catch {
    return false;
  }
}

/** Atomic single-link replacement using the same destination primitive as reports. */
export interface PinnedWriteOptions {
  /** Publish only when the destination is absent; never replace a concurrent leaf. */
  readonly replaceExisting?: boolean;
  /** Internal rollback mode: retain descriptor authority even after lexical replacement. */
  readonly requireStable?: boolean;
  /** Internal transaction receipt; called after the leaf is linked into place. */
  readonly onPublished?: () => void;
}

export function writePinnedFile(root: PinnedDirectory, name: string, bytes: Buffer, options: PinnedWriteOptions = {}): boolean {
  const replaceExisting = options.replaceExisting !== false;
  const requireStable = options.requireStable !== false;
  const rootStable = (): boolean => requireStable ? pinnedDirectoryIsStable(root) : pinnedDescriptorIsStable(root);
  if (!safeName(name) || bytes.length > MAX_PINNED_WRITE_BYTES) return false;
  if (!rootStable()) return false;
  const destination = join(root.lexicalPath, name);
  testHooks?.beforeTargetOpen?.(destination);
  if (!rootStable()) return false;
  let temporary: string | null = null;
  let descriptor: number | null = null;
  let published = false;
  try {
    if (process.platform === 'darwin') {
      const staged = runDarwinHelper(root, 'write_temp', { final: name, bytes: bytes.toString('base64') });
      const stagedName = staged?.temporary;
      if (typeof stagedName !== 'string') return false;
      temporary = stagedName;
      if (!rootStable()) return false;
      testHooks?.beforeTargetRename?.(destination);
      if (!rootStable()) return false;
      const publishedResult = replaceExisting
        ? runDarwinHelper(root, 'publish', { final: name, temporary })
        : runDarwinHelper(root, 'publish_noreplace', { final: name, temporary });
      if (publishedResult === null) {
        if (!replaceExisting) return false;
        const finalBytes = bytes.length <= MAX_PINNED_READ_BYTES ? readPinnedFileFull(root, name, bytes.length) : null;
        if (finalBytes === null || !finalBytes.equals(bytes)) return false;
      } else if (publishedResult.published !== true) {
        return false;
      }
      const cleanupTemporary = publishedResult === null || publishedResult.temporary_remaining === true ? temporary : null;
      temporary = null;
      published = true;
      options.onPublished?.();
      if (cleanupTemporary !== null) runDarwinHelper(root, 'cleanup', { temporary: cleanupTemporary });
      return rootStable();
    }
    const descriptorRoot = descriptorPathFor(root.fd);
    if (descriptorRoot === null) return false;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      if (!rootStable()) return false;
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
    if (!rootStable()) return false;
    testHooks?.beforeTargetRename?.(destination);
    if (!rootStable()) return false;
    if (replaceExisting) {
      renameSync(temporary, join(descriptorRoot, name));
      temporary = null;
      published = true;
      options.onPublished?.();
    } else {
      const linkedTemporary = temporary;
      linkSync(linkedTemporary, join(descriptorRoot, name));
      temporary = null;
      published = true;
      options.onPublished?.();
      try { unlinkSync(linkedTemporary); } catch { /* final link is already published and receipt-owned */ }
    }
    fsyncSync(root.fd);
    return rootStable();
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

/** Remove one transaction-created empty child through its retained parent descriptor. */
export function removePinnedDirectoryIfEmpty(receipt: PinnedDirectoryCreationReceipt): boolean {
  const { parent, name, identity } = receipt;
  if (!safeName(name) || !pinnedDescriptorIsStable(parent)) return false;
  if (process.platform === 'darwin') {
    return runDarwinHelper(parent, 'remove_empty', { name, expected_dev: identity.dev, expected_ino: identity.ino })?.removed === true;
  }
  const descriptorRoot = descriptorPathFor(parent.fd);
  if (descriptorRoot === null) return false;
  const child = join(descriptorRoot, name);
  let childFd: number | null = null;
  try {
    const before = lstatSync(child);
    if (before.isSymbolicLink() || !before.isDirectory() || !sameIdentity(before, identity)) return false;
    childFd = openSync(child, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const opened = fstatSync(childFd);
    if (!opened.isDirectory() || !sameIdentity(opened, identity) || readdirSync(child).length !== 0) return false;
    const after = lstatSync(child);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(after, identity)) return false;
    rmdirSync(child);
    return true;
  } catch {
    return false;
  } finally {
    if (childFd !== null) {
      try { closeSync(childFd); } catch { /* best effort */ }
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
    if (!pinnedDirectoryIsStable(root)) return null;
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
import ctypes
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

def descriptor_path():
    info = os.fstat(3)
    if not stat.S_ISDIR(info.st_mode): fail("retained descriptor is not a directory")
    buffer = ctypes.create_string_buffer(1024)
    libc = ctypes.CDLL(None)
    if libc.fcntl(3, 50, buffer) != 0:
        fail("retained descriptor path is unavailable")
    path = buffer.value.decode("utf-8")
    if not path.startswith("/") or len(path.encode("utf-8")) > 4096:
        fail("retained descriptor path is invalid")
    return {"dev": info.st_dev, "ino": info.st_ino, "path": path}

def ensure_directory(path):
    if not isinstance(path, str) or len(path.encode("utf-8")) > 4096 or path.startswith("/") or "\\" in path or "\x00" in path: fail("directory path is invalid")
    pieces = [] if path == "" else path.split("/")
    if len(pieces) > 128 or any((not piece or piece in (".", "..")) for piece in pieces): fail("directory path is invalid")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    current = os.dup(3)
    try:
        created = False
        for piece in pieces:
            try: child = os.open(piece, flags, dir_fd=current)
            except FileNotFoundError:
                os.mkdir(piece, 0o700, dir_fd=current)
                created = True
                child = os.open(piece, flags, dir_fd=current)
            os.close(current)
            current = child
        info = os.fstat(current)
        if not stat.S_ISDIR(info.st_mode): fail("target is not a directory")
        return {"child_dev": info.st_dev, "child_ino": info.st_ino, "created": created}
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

def entry_exists(name):
    name = safe_name(name)
    try:
        os.stat(name, dir_fd=3, follow_symlinks=False)
        return {"exists": True}
    except FileNotFoundError:
        return {"exists": False}

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
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK
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
            quarantine = ".omp-lock-unlink-" + secrets.token_hex(16) + ".tmp"
            try:
                os.rename(name, quarantine, src_dir_fd=3, dst_dir_fd=3)
            except OSError:
                return None
            try:
                qfd, qinfo = open_regular(quarantine, os.O_RDONLY)
                try:
                    qmarker = os.read(qfd, 512).decode("utf-8").strip()
                finally:
                    os.close(qfd)
                if qinfo.st_dev != old.st_dev or qinfo.st_ino != old.st_ino:
                    return None
                if qmarker != marker:
                    try:
                        os.link(quarantine, name, src_dir_fd=3, dst_dir_fd=3, follow_symlinks=False)
                    except FileExistsError:
                        return None
                    os.unlink(quarantine, dir_fd=3)
                    return None
                os.unlink(quarantine, dir_fd=3)
            except OSError:
                return None
            return None
        except (ValueError, OSError):
            return None
    nonce = secrets.token_hex(16)
    digest = lock_digest(owner_pid, nonce, owner_start)
    marker = ("%d:%s:%s:%s\n" % (owner_pid, nonce, owner_start, digest)).encode("utf-8")
    try:
        os.write(fd, marker)
        os.fsync(fd)
        info = os.fstat(fd)
        os.lseek(fd, 0, os.SEEK_SET)
        bound = os.read(fd, 512)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or bound != marker: fail("lock is unsafe")
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
    try: os.fsync(3)
    except OSError: return {"published": True}
    return {"published": True}

def publish_noreplace(final, temporary):
    final, temporary = safe_name(final), safe_name(temporary)
    info = os.stat(temporary, dir_fd=3, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: fail("temporary is unsafe")
    try:
        os.link(temporary, final, src_dir_fd=3, dst_dir_fd=3, follow_symlinks=False)
    except FileExistsError:
        return {"published": False, "collision": True}
    try:
        os.unlink(temporary, dir_fd=3)
    except OSError:
        return {"published": True, "temporary_remaining": True}
    try: os.fsync(3)
    except OSError: return {"published": True}
    return {"published": True}

def _verify_exact(name, size, digest, expected_dev=None, expected_ino=None):
    fd, info = open_regular(name, os.O_RDONLY)
    try:
        if info.st_size != size: return False
        if expected_dev is not None and (info.st_dev != expected_dev or info.st_ino != expected_ino): return False
        data = b""
        while len(data) < size:
            chunk = os.read(fd, size - len(data))
            if not chunk: return False
            data += chunk
        after = os.fstat(fd)
        return after.st_dev == info.st_dev and after.st_ino == info.st_ino and after.st_size == info.st_size and (expected_dev is None or (after.st_dev == expected_dev and after.st_ino == expected_ino)) and hashlib.sha256(data).hexdigest() == digest
    finally:
        os.close(fd)

def quarantine_if_exact(name, quarantine, size, digest):
    name, quarantine = safe_name(name), safe_name(quarantine)
    if not isinstance(size, int) or size < 0 or size > MAX_WRITE or not isinstance(digest, str) or len(digest) != 64: fail("exact unlink bounds are invalid")
    if not _verify_exact(name, size, digest): return {"quarantined": False, "moved": False}
    try:
        os.rename(name, quarantine, src_dir_fd=3, dst_dir_fd=3)
    except FileNotFoundError:
        return {"quarantined": False, "moved": False}
    try:
        fd, info = open_regular(quarantine, os.O_RDONLY)
        os.close(fd)
        moved_dev, moved_ino = info.st_dev, info.st_ino
    except OSError:
        return {"quarantined": False, "moved": True}
    if not _verify_exact(quarantine, size, digest): return {"quarantined": False, "moved": True, "dev": moved_dev, "ino": moved_ino}
    return {"quarantined": True, "moved": True, "dev": moved_dev, "ino": moved_ino}

def restore_quarantine(quarantine, name, expected_dev, expected_ino):
    quarantine, name = safe_name(quarantine), safe_name(name)
    if not isinstance(expected_dev, int) or not isinstance(expected_ino, int): fail("exact restore identity is invalid")
    try:
        fd, info = open_regular(quarantine, os.O_RDONLY)
        current = os.fstat(fd)
        os.close(fd)
        if info.st_dev != expected_dev or info.st_ino != expected_ino or current.st_dev != expected_dev or current.st_ino != expected_ino: return {"restored": False}
    except OSError:
        return {"restored": False}
    try:
        os.link(quarantine, name, src_dir_fd=3, dst_dir_fd=3, follow_symlinks=False)
    except FileExistsError:
        return {"restored": False}
    os.unlink(quarantine, dir_fd=3)
    os.fsync(3)
    return {"restored": True}

def unlink_quarantine(quarantine, size, digest, expected_dev, expected_ino):
    quarantine = safe_name(quarantine)
    if not isinstance(size, int) or size < 0 or size > MAX_WRITE or not isinstance(digest, str) or len(digest) != 64 or not isinstance(expected_dev, int) or not isinstance(expected_ino, int): fail("exact unlink bounds are invalid")
    if not _verify_exact(quarantine, size, digest, expected_dev, expected_ino): return {"removed": False}
    os.unlink(quarantine, dir_fd=3)
    os.fsync(3)
    return {"removed": True}

def cleanup(temporary):
    try: os.unlink(safe_name(temporary), dir_fd=3)
    except FileNotFoundError: pass

try:
    payload = json.loads(sys.stdin.read())
    root_guard(payload)
    op = payload.get("op")
    if op == "descriptor_path": result = {"ok": True, **descriptor_path()}
    elif op == "ensure_directory": result = {"ok": True, "directory": ensure_directory(payload.get("path"))}
    elif op == "write_temp": result = {"ok": True, "temporary": write_temp(base64.b64decode(payload.get("bytes", ""), validate=True))}
    elif op == "append_file": result = {"ok": True, **append_file(payload.get("name"), payload.get("bytes"))}
    elif op == "entry_exists": result = {"ok": True, **entry_exists(payload.get("name"))}
    elif op == "read_file": result = {"ok": True, **read_file(payload.get("name"), payload.get("max_bytes"), payload.get("tail_bytes"))}
    elif op == "read_evidence": result = {"ok": True, **read_evidence(payload.get("path"), payload.get("max_bytes"))}
    elif op == "unlink_file": unlink_file(payload.get("name")); result = {"ok": True}
    elif op == "remove_empty":
        name = payload.get("name")
        if not isinstance(name, str) or not name or any((not piece or piece in (".", "..") or "/" in piece or "\\" in piece or "\x00" in piece) for piece in name.split("/")): fail("directory path is invalid")
        expected_dev = payload.get("expected_dev")
        expected_ino = payload.get("expected_ino")
        try:
            info = os.stat(name, dir_fd=3, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode) or info.st_dev != expected_dev or info.st_ino != expected_ino: fail("directory identity changed")
            os.rmdir(name, dir_fd=3); result = {"ok": True, "removed": True}
        except FileNotFoundError: result = {"ok": True, "removed": False}
    elif op == "lock_acquire":
        lease = lock_acquire(payload.get("name"), payload.get("owner_pid"), payload.get("owner_start"))
        result = {"ok": lease is not None, **(lease or {})}
    elif op == "lock_release":
        lock_release(payload.get("name"), payload.get("dev"), payload.get("ino"), payload.get("digest")); result = {"ok": True}
    elif op == "publish": result = {"ok": True, **publish(payload.get("final"), payload.get("temporary"))}
    elif op == "publish_noreplace": result = {"ok": True, **publish_noreplace(payload.get("final"), payload.get("temporary"))}
    elif op == "quarantine_if_exact": result = {"ok": True, **quarantine_if_exact(payload.get("name"), payload.get("quarantine"), payload.get("size"), payload.get("sha256"))}
    elif op == "restore_quarantine": result = {"ok": True, **restore_quarantine(payload.get("quarantine"), payload.get("name"), payload.get("expected_dev"), payload.get("expected_ino"))}
    elif op == "unlink_quarantine": result = {"ok": True, **unlink_quarantine(payload.get("quarantine"), payload.get("size"), payload.get("sha256"), payload.get("expected_dev"), payload.get("expected_ino"))}
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
