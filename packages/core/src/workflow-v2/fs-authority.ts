/** Internal descriptor-relative filesystem authority for workflow-v2. */
/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalRoot, WorkflowV2Digest } from "./types.js";

export type FsAuthorityFailureReason = "invalid_root" | "root_missing" | "omp_missing" | "unsupported" | "unsafe" | "limit" | "conflict" | "io";
export interface FsAuthorityFailure { readonly ok: false; readonly reason: FsAuthorityFailureReason; readonly message?: string; }
export type FsAuthorityResult<T> = { readonly ok: true; readonly value: T } | FsAuthorityFailure;

/** Opaque retained directory descriptor passed only inside the trusted seam. */
export interface FsDirectoryHandle { readonly fd: number; readonly descriptorPath: string; }
export interface FsEntryIdentity { readonly kind: "file" | "directory" | "other"; readonly device: string; readonly inode: string; readonly byte_length: number | null; }
export type FsTargetFingerprint = Readonly<{ state: "absent" }> | Readonly<{ state: "present"; device: string; inode: string; byte_sha256: WorkflowV2Digest; byte_length: number }>;
export interface FsReadSnapshot { readonly bytes: Buffer; readonly fingerprint: Extract<FsTargetFingerprint, { readonly state: "present" }>; }
export interface FsTemporaryFile { readonly name: string; readonly fingerprint: Extract<FsTargetFingerprint, { readonly state: "present" }>; }
export interface PinnedFsRoot {
  readonly canonicalRoot: CanonicalRoot;
  readonly rootDirectory: FsDirectoryHandle;
  readonly ompDirectory: FsDirectoryHandle;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly ompDevice: string;
  readonly ompInode: string;
  close(): void;
}

/** Root-only pin used by evidence checks that must not create .omp. */
export interface FsRootDirectory {
  readonly canonicalRoot: CanonicalRoot;
  readonly rootDirectory: FsDirectoryHandle;
  readonly rootDevice: string;
  readonly rootInode: string;
  close(): void;
}

/**
 * Trusted native implementation. It must use openat/openat2-style component
 * traversal with O_DIRECTORY|O_NOFOLLOW, retain root/.omp descriptors, and
 * implement inode/hash CAS in one native descriptor-relative operation.
 */
export interface DescriptorRelativeNativeBackend {
  readonly platform: "darwin" | "linux";
  readonly supportsAtomicCas: boolean;
  openRoot(root: CanonicalRoot, options?: Readonly<{ createOmp?: boolean }>): FsAuthorityResult<PinnedFsRoot>;
  /** Optional root-only pin for evidence reads when .omp is absent. */
  openRootDirectory?: (root: CanonicalRoot) => FsAuthorityResult<FsRootDirectory>;
  readBounded(directory: FsDirectoryHandle, leaf: string, maxBytes: number): FsAuthorityResult<FsReadSnapshot | null>;
  inspect(directory: FsDirectoryHandle, leaf: string): FsAuthorityResult<FsEntryIdentity | null>;
  openDirectory(directory: FsDirectoryHandle, leaf: string): FsAuthorityResult<FsDirectoryHandle>;
  createTemporary(directory: FsDirectoryHandle, prefix: string, bytes: Uint8Array): FsAuthorityResult<FsTemporaryFile>;
  removeTemporary(directory: FsDirectoryHandle, leaf: string): FsAuthorityResult<void>;
  fsyncDirectory(directory: FsDirectoryHandle): FsAuthorityResult<void>;
  atomicReplaceIfCurrent(directory: FsDirectoryHandle, leaf: string, expected: FsTargetFingerprint, bytes: Uint8Array): FsAuthorityResult<FsTargetFingerprint>;
  atomicRemoveIfCurrent(directory: FsDirectoryHandle, leaf: string, expected: FsTargetFingerprint): FsAuthorityResult<FsTargetFingerprint>;
}
export interface DescriptorRelativeFsAuthorityOptions { readonly native?: DescriptorRelativeNativeBackend; }
declare const trustedFsAuthorityBrand: unique symbol;
export interface TrustedFsAuthority extends DescriptorRelativeNativeBackend {
  readonly [trustedFsAuthorityBrand]: "TrustedFsAuthority";
}

const MAX_REFERENCE_READ_BYTES = 16 * 1024 * 1024;
const issuedAuthorities = new WeakSet<object>();

function failure(reason: FsAuthorityFailureReason, message?: string): FsAuthorityFailure {
  return message ? { ok: false, reason, message } : { ok: false, reason };
}
function unsupported<T>(): FsAuthorityResult<T> { return failure("unsupported"); }
function unsupportedBackend(): DescriptorRelativeNativeBackend {
  const platform = process.platform === "darwin" || process.platform === "linux" ? process.platform : "linux";
  return Object.freeze({ platform, supportsAtomicCas: false, openRoot: unsupported, readBounded: unsupported, inspect: unsupported, openDirectory: unsupported, createTemporary: unsupported, removeTemporary: unsupported, fsyncDirectory: unsupported, atomicReplaceIfCurrent: unsupported, atomicRemoveIfCurrent: unsupported });
}

function validFingerprint(value: unknown): value is FsTargetFingerprint {
  if (value === null || typeof value !== "object") return false;
  if ((value as { state?: unknown }).state === "absent") return Object.keys(value).length === 1;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 5 && candidate.state === "present" && typeof candidate.device === "string" && candidate.device.length > 0 && typeof candidate.inode === "string" && candidate.inode.length > 0 && typeof candidate.byte_sha256 === "string" && /^sha256:[0-9a-f]{64}$/u.test(candidate.byte_sha256) && Number.isSafeInteger(candidate.byte_length) && (candidate.byte_length as number) >= 0;
}

export function sameTargetFingerprint(left: FsTargetFingerprint, right: FsTargetFingerprint): boolean {
  if (!validFingerprint(left) || !validFingerprint(right) || left.state !== right.state) return false;
  if (left.state === "absent" || right.state === "absent") return true;
  return left.device === right.device && left.inode === right.inode && left.byte_sha256 === right.byte_sha256 && left.byte_length === right.byte_length;
}

/** SHA-256 helper for native adapters and transaction fingerprint validation. */
export function fingerprintBytes(device: string, inode: string, bytes: Uint8Array): Extract<FsTargetFingerprint, { readonly state: "present" }> {
  if (device.length === 0 || inode.length === 0) throw new TypeError("filesystem identity is required");
  return Object.freeze({ state: "present" as const, device, inode, byte_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as WorkflowV2Digest, byte_length: bytes.byteLength });
}

/** The factory never supplies pathname or pseudo-fd fallbacks. */
export function createDescriptorRelativeFsAuthority(options: DescriptorRelativeFsAuthorityOptions = {}): TrustedFsAuthority {
  const backend = options.native ?? unsupportedBackend();
  const rootDirectory = backend.openRootDirectory;
  const authority = Object.freeze({
    platform: backend.platform,
    supportsAtomicCas: backend.supportsAtomicCas,
    openRoot: (root: CanonicalRoot, options?: Readonly<{ createOmp?: boolean }>) => backend.openRoot(root, options),
    ...(rootDirectory ? { openRootDirectory: (root: CanonicalRoot) => rootDirectory.call(backend, root) } : {}),
    readBounded: (directory: FsDirectoryHandle, leaf: string, maxBytes: number) => backend.readBounded(directory, leaf, maxBytes),
    inspect: (directory: FsDirectoryHandle, leaf: string) => backend.inspect(directory, leaf),
    openDirectory: (directory: FsDirectoryHandle, leaf: string) => backend.openDirectory(directory, leaf),
    createTemporary: (directory: FsDirectoryHandle, prefix: string, bytes: Uint8Array) => backend.createTemporary(directory, prefix, bytes),
    removeTemporary: (directory: FsDirectoryHandle, leaf: string) => backend.removeTemporary(directory, leaf),
    fsyncDirectory: (directory: FsDirectoryHandle) => backend.fsyncDirectory(directory),
    atomicReplaceIfCurrent: (directory: FsDirectoryHandle, leaf: string, expected: FsTargetFingerprint, bytes: Uint8Array) => backend.supportsAtomicCas ? backend.atomicReplaceIfCurrent(directory, leaf, expected, bytes) : unsupported(),
    atomicRemoveIfCurrent: (directory: FsDirectoryHandle, leaf: string, expected: FsTargetFingerprint) => backend.supportsAtomicCas ? backend.atomicRemoveIfCurrent(directory, leaf, expected) : unsupported(),
  }) as TrustedFsAuthority;
  issuedAuthorities.add(authority as object);
  return authority;
}

/** Return true only for authorities issued by a trusted factory in this module. */
export function isTrustedFsAuthority(value: unknown): value is TrustedFsAuthority {
  return value !== null && typeof value === "object" && issuedAuthorities.has(value);
}

let testFd = 1;
function testHandle(descriptorPath: string): FsDirectoryHandle {
  return Object.freeze({ fd: testFd++, descriptorPath });
}
function testStat(path: string) {
  try { return lstatSync(path); } catch { return undefined; }
}
function testLeafPath(directory: FsDirectoryHandle, leaf: string): string | undefined {
  return leaf.length > 0 && !leaf.includes("/") && !leaf.includes("\\") && leaf !== "." && leaf !== ".."
    ? join(directory.descriptorPath, leaf)
    : undefined;
}
function testOpenRoot(root: CanonicalRoot, createOmp: boolean): FsAuthorityResult<PinnedFsRoot> {
  const rootStat = testStat(root);
  if (!rootStat) return failure("root_missing");
  if (rootStat.isSymbolicLink()) return failure("unsafe");
  if (!rootStat.isDirectory()) return failure("root_missing");
  const ompPath = join(root, ".omp");
  let ompStat = testStat(ompPath);
  if (!ompStat && !createOmp) return failure("omp_missing");
  if (!ompStat) {
    try { mkdirSync(ompPath); } catch { return failure("io"); }
    ompStat = testStat(ompPath);
  }
  if (!ompStat || !ompStat.isDirectory() || ompStat.isSymbolicLink()) return failure("unsafe");
  return {
    ok: true,
    value: {
      canonicalRoot: root,
      rootDirectory: testHandle(root),
      ompDirectory: testHandle(ompPath),
      rootDevice: String(rootStat.dev),
      rootInode: String(rootStat.ino),
      ompDevice: String(ompStat.dev),
      ompInode: String(ompStat.ino),
      close() {},
    },
  };
}
function testOpenRootDirectory(root: CanonicalRoot): FsAuthorityResult<FsRootDirectory> {
  const stat = testStat(root);
  if (!stat) return failure("root_missing");
  if (stat.isSymbolicLink()) return failure("unsafe");
  if (!stat.isDirectory()) return failure("root_missing");
  return { ok: true, value: { canonicalRoot: root, rootDirectory: testHandle(root), rootDevice: String(stat.dev), rootInode: String(stat.ino), close() {} } };
}
function testRead(directory: FsDirectoryHandle, leaf: string, maxBytes: number): FsAuthorityResult<FsReadSnapshot | null> {
  const path = testLeafPath(directory, leaf);
  if (!path) return failure("unsafe");
  const stat = testStat(path);
  if (!stat) return { ok: true, value: null };
  if (stat.isSymbolicLink() || !stat.isFile()) return failure("unsafe");
  if (stat.size > maxBytes) return failure("limit");
  try {
    const bytes = readFileSync(path);
    return { ok: true, value: { bytes, fingerprint: fingerprintBytes(String(stat.dev), String(stat.ino), bytes) } };
  } catch {
    return failure("io");
  }
}
function testInspect(directory: FsDirectoryHandle, leaf: string): FsAuthorityResult<FsEntryIdentity | null> {
  const path = testLeafPath(directory, leaf);
  if (!path) return failure("unsafe");
  const stat = testStat(path);
  if (!stat) return { ok: true, value: null };
  if (stat.isSymbolicLink()) return failure("unsafe");
  return { ok: true, value: { kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other", device: String(stat.dev), inode: String(stat.ino), byte_length: stat.isFile() ? stat.size : null } };
}
function testAtomicReplace(directory: FsDirectoryHandle, leaf: string, expected: FsTargetFingerprint, bytes: Uint8Array): FsAuthorityResult<FsTargetFingerprint> {
  const current = testRead(directory, leaf, MAX_REFERENCE_READ_BYTES);
  if (!current.ok) return current;
  const currentFingerprint: FsTargetFingerprint = current.value?.fingerprint ?? { state: "absent" };
  if (!sameTargetFingerprint(currentFingerprint, expected)) return failure("conflict");
  const path = testLeafPath(directory, leaf);
  if (!path) return failure("unsafe");
  try { writeFileSync(path, bytes); } catch { return failure("io"); }
  const written = testRead(directory, leaf, MAX_REFERENCE_READ_BYTES);
  return written.ok && written.value ? { ok: true, value: written.value.fingerprint } : failure("io");
}
function testAtomicRemove(directory: FsDirectoryHandle, leaf: string, expected: FsTargetFingerprint): FsAuthorityResult<FsTargetFingerprint> {
  const current = testRead(directory, leaf, MAX_REFERENCE_READ_BYTES);
  if (!current.ok) return current;
  const currentFingerprint: FsTargetFingerprint = current.value?.fingerprint ?? { state: "absent" };
  if (!sameTargetFingerprint(currentFingerprint, expected)) return failure("conflict");
  const path = testLeafPath(directory, leaf);
  if (!path) return failure("unsafe");
  try { rmSync(path, { force: true }); return { ok: true, value: { state: "absent" } }; } catch { return failure("io"); }
}

/** Explicit test-only Node adapter; production callers must inject a native backend instead. */
export function createTestDescriptorRelativeFsAuthority(): TrustedFsAuthority {
  const native: DescriptorRelativeNativeBackend = {
    platform: process.platform === "darwin" ? "darwin" : "linux",
    supportsAtomicCas: true,
    openRoot: (root, options = {}) => testOpenRoot(root, options.createOmp === true),
    openRootDirectory: testOpenRootDirectory,
    readBounded: testRead,
    inspect: testInspect,
    openDirectory: (directory, leaf) => {
      const inspected = testInspect(directory, leaf);
      if (!inspected.ok || inspected.value === null) return inspected.ok ? failure("root_missing") : inspected;
      if (inspected.value.kind !== "directory") return failure("unsafe");
      return { ok: true, value: testHandle(join(directory.descriptorPath, leaf)) };
    },
    createTemporary: (directory, prefix, bytes) => {
      const name = `${prefix}${randomUUID()}`;
      const path = testLeafPath(directory, name);
      if (!path) return failure("unsafe");
      try { writeFileSync(path, bytes, { flag: "wx" }); } catch { return failure("io"); }
      const stat = testStat(path);
      return stat ? { ok: true, value: { name, fingerprint: fingerprintBytes(String(stat.dev), String(stat.ino), bytes) } } : failure("io");
    },
    removeTemporary: (directory, leaf) => {
      const path = testLeafPath(directory, leaf);
      if (!path) return failure("unsafe");
      try { rmSync(path, { force: true }); return { ok: true, value: undefined }; } catch { return failure("io"); }
    },
    fsyncDirectory: () => ({ ok: true, value: undefined }),
    atomicReplaceIfCurrent: testAtomicReplace,
    atomicRemoveIfCurrent: testAtomicRemove,
  };
  return createDescriptorRelativeFsAuthority({ native });
}

export { MAX_REFERENCE_READ_BYTES };
