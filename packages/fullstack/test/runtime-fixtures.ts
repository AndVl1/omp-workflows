/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  buildProjectIdentity,
  buildWorkflowRunIdentity,
  createCanonicalRoot,
  createProviderId,
  createWorkflowV2Digest,
  isSafePathKey,
  VISUALIZE_OUTPUT_FILES,
  type CanonicalRoot,
  type DiagnosticResult,
  type ProjectIdentity,
  type StorageTreeEntry,
  type StorageTreeLimits,
  type StorageTreePublishResult,
  type TrustedFsAuthority,
  type WorkflowRunIdentity,
  type WorkflowV2Digest,
} from "@andvl1/omp-workflows-core";
import { createTestDescriptorRelativeFsAuthority } from "../../core/dist/workflow-v2/fs-authority.js";
import {
  channelConfigDigest,
  createChannelAdmission,
  createFullstackStorageAuthority,
  type ChannelAdmission,
  type ChannelEndpointPolicy,
  type FullstackStorageNativeBackend,
  type FullstackTreeStorageAuthority,
  type StorageEntry,
  type StorageFailure,
  type StorageLease,
  type StorageResult,
  type StorageStat,
} from "../src/storage-authority.js";
import type { AdapterRuntimeContext } from "../src/adapters/registry.js";

export interface RuntimeFixture {
  readonly project_root: CanonicalRoot;
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  readonly storage: FullstackTreeStorageAuthority;
  readonly context: AdapterRuntimeContext;
}

function digest(seed: string): WorkflowV2Digest {
  const value = createWorkflowV2Digest(`sha256:${createHash("sha256").update(seed, "utf8").digest("hex")}`);
  if (!value) throw new Error("test digest must be valid");
  return value;
}

function checkedRoot(root: string): CanonicalRoot {
  const value = createCanonicalRoot(root);
  if (!value) throw new Error(`test root is not canonical: ${root}`);
  return value;
}

function unwrap<T>(result: DiagnosticResult<T>): T {
  if (!result.ok) throw new Error("test identity should be valid");
  return result.value;
}

function storageFailure(reason: StorageFailure["reason"]): StorageFailure {
  return { ok: false, reason, code: reason };
}

function validRelative(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part.length > 0 && part.length <= 255 && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/u.test(part));
}

function rootPath(root: CanonicalRoot, relative: string): string {
  if (!validRelative(relative)) throw new Error("unsafe test storage path");
  return join(root, ...relative.split("/"));
}

function ensureParents(root: CanonicalRoot, relative: string): void {
  const parts = relative.split("/");
  parts.pop();
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe test storage parent");
    } catch (error) {
      if (error instanceof Error && error.message === "unsafe test storage parent") throw error;
      mkdirSync(current);
    }
  }
}

function sameRun(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

type TreeNativeBackend = FullstackStorageNativeBackend & {
  readonly replaceTreeAtomic: NonNullable<FullstackStorageNativeBackend["replaceTreeAtomic"]>;
};

function testStorageBackend(root: CanonicalRoot, run: WorkflowRunIdentity): TreeNativeBackend {
  let leaseCounter = 0;
  let atomicCounter = 0;
  const readBounded = (relativePath: string, maxBytes: number): StorageResult<Uint8Array | null> => {
    if (!validRelative(relativePath)) return storageFailure("UNSAFE_PATH");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return storageFailure("LIMIT");
    const path = rootPath(root, relativePath);
    let stat;
    try { stat = lstatSync(path); } catch { return { ok: true, value: null }; }
    if (stat.isSymbolicLink() || !stat.isFile()) return storageFailure("UNSAFE_PATH");
    if (stat.size > maxBytes) return storageFailure("LIMIT");
    try { return { ok: true, value: readFileSync(path) }; } catch { return storageFailure("IO"); }
  };
  const readTextBounded = (relativePath: string, maxBytes: number): StorageResult<string | null> => {
    const raw = readBounded(relativePath, maxBytes);
    if (!raw.ok || raw.value === null) return raw;
    try { return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(raw.value) }; } catch { return storageFailure("IO"); }
  };
  const statBounded = (relativePath: string): StorageResult<StorageStat> => {
    if (!validRelative(relativePath)) return storageFailure("UNSAFE_PATH");
    try {
      const stat = lstatSync(rootPath(root, relativePath));
      if (stat.isSymbolicLink()) return storageFailure("UNSAFE_PATH");
      return { ok: true, value: { exists: true, kind: stat.isDirectory() ? "directory" : "file", size_bytes: stat.isFile() ? stat.size : 0, mtime_ms: stat.mtimeMs } };
    } catch { return { ok: true, value: { exists: false, kind: "missing", size_bytes: 0, mtime_ms: 0 } }; }
  };
  const writeExclusive = (relativePath: string, bytes: Uint8Array, mode = 0o600): StorageResult<void> => {
    if (!validRelative(relativePath)) return storageFailure("UNSAFE_PATH");
    if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) return storageFailure("LIMIT");
    const path = rootPath(root, relativePath);
    try {
      ensureParents(root, relativePath);
      writeFileSync(path, bytes, { flag: "wx", mode });
      return { ok: true, value: undefined };
    } catch (error) {
      if (error && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST") return storageFailure("CONFLICT");
      return storageFailure("IO");
    }
  };
  const writeAtomic = (relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void> => {
    if (!validRelative(relativePath)) return storageFailure("UNSAFE_PATH");
    if (!(bytes instanceof Uint8Array)) return storageFailure("IO");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || bytes.byteLength > maxBytes) return storageFailure("LIMIT");
    const leaf = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    const prefix = relativePath.slice(0, Math.max(0, relativePath.lastIndexOf("/") + 1));
    const temporary = `${prefix}.${leaf}.tmp-${++atomicCounter}`;
    try {
      ensureParents(root, temporary);
      writeFileSync(rootPath(root, temporary), bytes, { flag: "wx", mode: 0o600 });
      renameSync(rootPath(root, temporary), rootPath(root, relativePath));
      return { ok: true, value: undefined };
    } catch {
      rmSync(rootPath(root, temporary), { force: true });
      return storageFailure("IO");
    }
  };
  const appendJsonLineBounded = (relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void> => {
    if (!validRelative(relativePath)) return storageFailure("UNSAFE_PATH");
    const path = rootPath(root, relativePath);
    try {
      const current = existsSync(path) ? lstatSync(path).size : 0;
      if (current + bytes.byteLength > maxBytes) return storageFailure("LIMIT");
      ensureParents(root, relativePath);
      appendFileSync(path, bytes);
      return { ok: true, value: undefined };
    } catch { return storageFailure("IO"); }
  };
  const listBounded = (relativeDirectory: string, maxEntries: number): StorageResult<readonly StorageEntry[]> => {
    if (!validRelative(relativeDirectory)) return storageFailure("UNSAFE_PATH");
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return storageFailure("LIMIT");
    const path = rootPath(root, relativeDirectory);
    let names: string[];
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return storageFailure("UNSAFE_PATH");
      names = readdirSync(path);
    } catch { return { ok: true, value: [] }; }
    if (names.length > maxEntries) return storageFailure("LIMIT");
    const entries: StorageEntry[] = [];
    for (const name of names) {
      if (!validRelative(name)) return storageFailure("UNSAFE_PATH");
      const stat = lstatSync(join(path, name));
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return storageFailure("UNSAFE_PATH");
      entries.push({ name, relative_path: `${relativeDirectory}/${name}` });
    }
    return { ok: true, value: entries };
  };
  const moveExclusive = (sourceRelativePath: string, targetRelativePath: string): StorageResult<void> => {
    if (!validRelative(sourceRelativePath) || !validRelative(targetRelativePath)) return storageFailure("UNSAFE_PATH");
    const source = rootPath(root, sourceRelativePath);
    const target = rootPath(root, targetRelativePath);
    try {
      const sourceStat = lstatSync(source);
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) return storageFailure("UNSAFE_PATH");
      if (existsSync(target)) return storageFailure("CONFLICT");
      ensureParents(root, targetRelativePath);
      renameSync(source, target);
      return { ok: true, value: undefined };
    } catch { return storageFailure("IO"); }
  };
  const removeIfOwned = (relativePath: string, identity: WorkflowRunIdentity): StorageResult<boolean> => {
    if (!validRelative(relativePath) || !sameRun(identity, run)) return storageFailure("IDENTITY_MISMATCH");
    const path = rootPath(root, relativePath);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) return storageFailure("UNSAFE_PATH");
      const raw = JSON.parse(readFileSync(path, "utf8")) as { run_identity?: WorkflowRunIdentity };
      if (!raw.run_identity || !sameRun(raw.run_identity, run)) return storageFailure("IDENTITY_MISMATCH");
      rmSync(path, { force: true });
      return { ok: true, value: true };
    } catch { return { ok: true, value: false }; }
  };
  const acquireLease = (relativePath: string, identity: WorkflowRunIdentity): StorageResult<StorageLease> => {
    if (!validRelative(relativePath) || !sameRun(identity, run)) return storageFailure("IDENTITY_MISMATCH");
    const lease_id = `test-lease-${++leaseCounter}`;
    const written = writeExclusive(relativePath, new TextEncoder().encode(JSON.stringify({ lease_id, run_identity: run })), 0o600);
    return written.ok ? { ok: true, value: { relative_path: relativePath, run_identity: run, lease_id } } : written as StorageResult<StorageLease>;
  };
  const releaseLease = (relativePath: string, identity: WorkflowRunIdentity): StorageResult<void> => {
    const released = removeIfOwned(relativePath, identity);
    return released.ok ? { ok: true, value: undefined } : released as StorageResult<void>;
  };
  const replaceTreeAtomic = (
    relativeRoot: string,
    entries: readonly StorageTreeEntry[],
    limits: StorageTreeLimits,
  ): StorageResult<StorageTreePublishResult> => {
    if (!validRelative(relativeRoot)) return storageFailure("UNSAFE_PATH");
    if (!limits || typeof limits !== "object") return storageFailure("LIMIT");
    if (
      !Number.isSafeInteger(limits.max_path_chars)
      || limits.max_path_chars <= 0
      || limits.max_path_chars > 1_024
      || !Number.isSafeInteger(limits.max_file_bytes)
      || limits.max_file_bytes < 0
      || limits.max_file_bytes > 8 * 1024 * 1024
      || !Number.isSafeInteger(limits.max_entries)
      || limits.max_entries < 0
      || limits.max_entries > 4_096
      || !Number.isSafeInteger(limits.max_total_bytes)
      || limits.max_total_bytes < 0
      || limits.max_total_bytes > 32 * 1024 * 1024
    ) return storageFailure("LIMIT");
    if (relativeRoot.length > limits.max_path_chars) return storageFailure("LIMIT");
    if (!Array.isArray(entries) || entries.length > limits.max_entries) return storageFailure("LIMIT");

    const newFiles = new Set<string>();
    let totalBytes = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof entry.relative_path !== "string" || !(entry.bytes instanceof Uint8Array)) {
        return storageFailure("IO");
      }
      if (!validRelative(entry.relative_path)) return storageFailure("UNSAFE_PATH");
      if (entry.relative_path.length > limits.max_path_chars) return storageFailure("LIMIT");
      if (newFiles.has(entry.relative_path)) return storageFailure("CONFLICT");
      if (entry.bytes.byteLength > limits.max_file_bytes) return storageFailure("LIMIT");
      totalBytes += entry.bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.max_total_bytes) return storageFailure("LIMIT");
      newFiles.add(entry.relative_path);
    }

    const target = rootPath(root, relativeRoot);
    const parent = dirname(target);
    const nonce = `${process.pid}-${atomicCounter++}`;
    const staging = join(parent, `.visualize-staging-${nonce}`);
    const backup = join(parent, `.visualize-backup-${nonce}`);
    let captured = false;
    const pruned: string[] = [];
    const warnings: string[] = [];

    const isDerivedPath = (relativePath: string): boolean => {
      const parts = relativePath.split("/");
      if (
        parts.length === 1
        && (parts[0] === VISUALIZE_OUTPUT_FILES.hubMarkdown
          || parts[0] === VISUALIZE_OUTPUT_FILES.hubHtml
          || parts[0] === VISUALIZE_OUTPUT_FILES.manifest)
      ) return true;
      if (parts.length !== 3 || parts[0] !== "sessions" || !["feature", "legacy", "cto"].includes(parts[1]!)) return false;
      const file = parts[2]!;
      const extension = file.endsWith(".html") ? ".html" : file.endsWith(".md") ? ".md" : null;
      return extension !== null && isSafePathKey(file.slice(0, -extension.length));
    };

    const removeBestEffort = (path: string): void => {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* test cleanup */ }
    };

    const mergePrevious = (backupDir: string, targetDir: string): void => {
      const walk = (sourceDir: string, destinationDir: string): void => {
        for (const name of readdirSync(sourceDir).sort()) {
          const source = join(sourceDir, name);
          const relativePath = relative(backupDir, source);
          const stat = lstatSync(source);
          if (stat.isSymbolicLink()) {
            warnings.push(`discarded symlink entry "${relativePath}"`);
            removeBestEffort(source);
            continue;
          }
          if (isDerivedPath(relativePath)) {
            if (!newFiles.has(relativePath)) pruned.push(relativePath);
            removeBestEffort(source);
            continue;
          }
          const destination = join(destinationDir, name);
          if (stat.isDirectory()) {
            if (existsSync(destination) && !lstatSync(destination).isDirectory()) {
              warnings.push(`preserved non-derived entry "${relativePath}" in the stale backup`);
              continue;
            }
            mkdirSync(destination, { recursive: true });
            walk(source, destination);
            continue;
          }
          if (existsSync(destination)) {
            warnings.push(`preserved non-derived entry "${relativePath}" in the stale backup`);
            continue;
          }
          warnings.push(`preserved non-derived output entry "${relativePath}"`);
          renameSync(source, destination);
        }
      };
      walk(backupDir, targetDir);
    };

    try {
      ensureParents(root, relativeRoot);
      let targetStat;
      try { targetStat = lstatSync(target); } catch { targetStat = undefined; }
      if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isDirectory())) {
        return storageFailure("CONFLICT");
      }
      mkdirSync(staging, { recursive: false });
      for (const entry of entries) {
        const output = join(staging, ...entry.relative_path.split("/"));
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, entry.bytes, { flag: "wx", mode: 0o600 });
      }
      if (targetStat) {
        renameSync(target, backup);
        captured = true;
      }
      renameSync(staging, target);
      if (captured) {
        mergePrevious(backup, target);
        removeBestEffort(backup);
      }
      return { ok: true, value: { pruned: pruned.sort(), warnings: warnings.sort() } };
    } catch {
      removeBestEffort(staging);
      if (captured) {
        let targetExists = false;
        try { targetExists = lstatSync(target).isDirectory(); } catch { /* restore below */ }
        if (!targetExists) {
          try { renameSync(backup, target); } catch { /* best effort rollback */ }
        }
        removeBestEffort(backup);
      }
      return storageFailure("IO");
    }
  };

  return { canonical_root: root, run_identity: run, readBounded, readTextBounded, statBounded, writeExclusive, writeAtomic, appendJsonLineBounded, listBounded, moveExclusive, removeIfOwned, acquireLease, releaseLease, replaceTreeAtomic };
}

export function runtimeFixture(
  root: string,
  options: { readonly runId?: string; readonly profileId?: string } = {},
): RuntimeFixture {
  const project_root = checkedRoot(root);
  const provider_id = createProviderId("@example/fullstack-test");
  if (!provider_id) throw new Error("test provider id should be valid");
  const project_identity = unwrap(buildProjectIdentity({
    root_instance_id: digest(project_root),
    provider_id,
    descriptor_fingerprint: digest("descriptor"),
    executable_provenance: { build_fingerprint: digest("build"), runtime_fingerprint: digest("runtime") },
    catalog_content_digest: digest("catalog"),
    config_byte_sha256: digest("config-bytes"),
    config_semantic_sha256: digest("config-semantic"),
    session: { session_id: "fullstack-test-session", lifecycle_id: "fullstack-test-lifecycle" },
  }));
  const profileId = options.profileId ?? "fullstack-test-profile";
  const run_identity = unwrap(buildWorkflowRunIdentity({ project_identity, run_id: options.runId ?? "run-1", profile_identity: { id: profileId, fingerprint: digest(`profile:${profileId}`) } }));
  const filesystem_authority = createTestDescriptorRelativeFsAuthority();
  const native = testStorageBackend(project_root, run_identity);
  const storage = unwrap(createFullstackStorageAuthority({ project_root, run_identity, filesystem_authority, native }));
  const context = { project_root, run_identity, filesystem_authority, storage };
  return { project_root, project_identity, run_identity, filesystem_authority, storage, context };
}

export function channelAdmission(
  fixture: RuntimeFixture,
  channels: readonly Readonly<Record<string, unknown>>[],
  options: {
    readonly allowedChatIds?: readonly string[];
    readonly allowedSenderIds?: readonly string[];
    readonly endpointPolicy?: Readonly<Record<string, ChannelEndpointPolicy>>;
  } = {},
): ChannelAdmission {
  const built = createChannelAdmission({
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    channels,
    config_digest: channelConfigDigest(channels),
    endpoint_policy: options.endpointPolicy ?? {},
    allowed_chat_ids: options.allowedChatIds ?? ["test-chat"],
    allowed_sender_ids: options.allowedSenderIds ?? ["test-sender"],
  });
  return unwrap(built);
}

export function identityFor(root: string, runId = "run-1", profileId = "fullstack-test-profile"): WorkflowRunIdentity {
  return runtimeFixture(root, { runId, profileId }).run_identity;
}

export function adapterContext(root: string, runId = "run-1", profileId = "fullstack-test-profile"): AdapterRuntimeContext {
  return runtimeFixture(root, { runId, profileId }).context;
}
