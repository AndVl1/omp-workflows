/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import {
  createReportStorageAuthority,
  type ReportStorageAuthority,
  type ReportStorageOperations,
  type ReportTreeStorageAuthority,
  type ReportTreeStorageOperations,
  type StorageEntry,
  type StorageResult,
  type StorageStat,
  type StorageTreeEntry,
  type StorageTreeLimits,
  type StorageTreePublishResult,
} from "../src/report/storage.js";
import {
  isSafePathKey,
  VISUALIZE_OUTPUT_FILES,
} from "../src/visualize/types.js";

type Failure = {
  readonly ok: false;
  readonly reason: "UNSAFE_PATH" | "LIMIT" | "CONFLICT" | "IO";
  readonly code: "UNSAFE_PATH" | "LIMIT" | "CONFLICT" | "IO";
  readonly message: string;
};

const ok = <T>(value: T): StorageResult<T> => ({ ok: true, value });
const failure = (reason: Failure["reason"], message: string): Failure => ({
  ok: false,
  reason,
  code: reason,
  message,
});

/**
 * Test-only adapter that gives each report test an instance-bound authority.
 * It intentionally uses lstat on every existing path component so symlink
 * escapes are rejected before report code sees a byte or directory entry.
 */
function storageOperationsFor(
  cwd: string,
  includeTree: boolean,
): ReportStorageOperations | ReportTreeStorageOperations {
  let tempCounter = 0;

  function absolute(relativePath: string): string {
    return join(cwd, ...relativePath.split("/"));
  }

  function safeAbsolute(relativePath: string): string | Failure {
    const target = absolute(relativePath);
    let current = cwd;
    for (const part of relativePath.split("/")) {
      current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink()) return failure("UNSAFE_PATH", "symlink path component");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") break;
        return failure("IO", "unable to inspect storage path");
      }
    }
    return target;
  }

  function inspect(relativePath: string): { path: string; stat: Stats } | Failure | null {
    const target = safeAbsolute(relativePath);
    if (typeof target !== "string") return target;
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) return failure("UNSAFE_PATH", "symlink path component");
      return { path: target, stat };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return failure("IO", "unable to inspect storage path");
    }
  }

  function statBounded(relativePath: string): StorageResult<StorageStat> {
    const inspected = inspect(relativePath);
    if (inspected === null) return ok({ exists: false, kind: "missing", size_bytes: 0, mtime_ms: 0 });
    if ("ok" in inspected && inspected.ok === false) return inspected;
    const { stat } = inspected;
    return ok({
      exists: true,
      kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "missing",
      size_bytes: stat.isFile() ? stat.size : 0,
      mtime_ms: stat.mtimeMs,
    });
  }

  function readBounded(relativePath: string, maxBytes: number): StorageResult<Uint8Array | null> {
    const inspected = inspect(relativePath);
    if (inspected === null) return ok(null);
    if ("ok" in inspected && inspected.ok === false) return inspected;
    if (!inspected.stat.isFile()) return failure("IO", "storage path is not a file");
    try {
      const bytes = readFileSync(inspected.path);
      return ok(new Uint8Array(bytes.subarray(0, maxBytes)));
    } catch {
      return failure("IO", "unable to read storage file");
    }
  }

  const operations: ReportStorageOperations = {
    readBounded,
    readTextBounded(relativePath, maxBytes) {
      const bytes = readBounded(relativePath, maxBytes);
      return bytes.ok ? ok(bytes.value === null ? null : new TextDecoder().decode(bytes.value)) : bytes;
    },
    listBounded(relativeDirectory, maxEntries): StorageResult<readonly StorageEntry[]> {
      const inspected = inspect(relativeDirectory);
      if (inspected === null) return ok([]);
      if ("ok" in inspected && inspected.ok === false) return inspected;
      if (!inspected.stat.isDirectory()) return failure("IO", "storage path is not a directory");
      try {
        const names = readdirSync(inspected.path).sort();
        if (names.length > maxEntries) return failure("LIMIT", "directory entry bound exceeded");
        const entries: StorageEntry[] = [];
        for (const name of names) {
          const child = inspect(`${relativeDirectory}/${name}`);
          if (child && "ok" in child && child.ok === false) return child;
          entries.push({ name, relative_path: `${relativeDirectory}/${name}` });
        }
        return ok(entries);
      } catch {
        return failure("IO", "unable to list storage directory");
      }
    },
    statBounded,
    writeExclusive(relativePath, bytes, maxBytes): StorageResult<void> {
      if (bytes.byteLength > maxBytes) return failure("LIMIT", "write bound exceeded");
      const target = safeAbsolute(relativePath);
      if (typeof target !== "string") return target;
      try {
        mkdirSync(dirname(target), { recursive: true });
        const parent = safeAbsolute(dirname(relativePath).split("/").filter(Boolean).join("/"));
        if (typeof parent !== "string") return parent;
        writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
        return ok(undefined);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EEXIST"
          ? failure("CONFLICT", "storage target already exists")
          : failure("IO", "unable to write storage file");
      }
    },
    writeAtomic(relativePath, bytes, maxBytes): StorageResult<void> {
      if (bytes.byteLength > maxBytes) return failure("LIMIT", "write bound exceeded");
      const target = safeAbsolute(relativePath);
      if (typeof target !== "string") return target;
      const parent = dirname(target);
      const temp = join(parent, `.${basename(target)}.tmp-${process.pid}-${tempCounter++}`);
      try {
        mkdirSync(parent, { recursive: true });
        const checked = safeAbsolute(relativePath);
        if (typeof checked !== "string") return checked;
        if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
          return failure("UNSAFE_PATH", "symlink write target");
        }
        writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
        renameSync(temp, target);
        return ok(undefined);
      } catch {
        try {
          unlinkSync(temp);
        } catch {
          // best effort cleanup for a test-only adapter
        }
        return failure("IO", "unable to atomically write storage file");
      }
    },
  };
  function isDerivedPath(relativePath: string): boolean {
    const parts = relativePath.split("/");
    if (parts.length === 1 && (
      parts[0] === VISUALIZE_OUTPUT_FILES.hubMarkdown
      || parts[0] === VISUALIZE_OUTPUT_FILES.hubHtml
      || parts[0] === VISUALIZE_OUTPUT_FILES.manifest
    )) return true;
    if (parts.length !== 3 || parts[0] !== "sessions" || !["feature", "legacy", "cto"].includes(parts[1]!)) {
      return false;
    }
    const file = parts[2]!;
    const ext = file.endsWith(".html") ? ".html" : file.endsWith(".md") ? ".md" : null;
    return ext !== null && isSafePathKey(file.slice(0, -ext.length));
  }

  function removeBestEffort(path: string): void {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best effort cleanup for a test-only adapter
    }
  }

  function replaceTreeAtomic(
    relativeRoot: string,
    entries: readonly StorageTreeEntry[],
    limits: StorageTreeLimits,
  ): StorageResult<StorageTreePublishResult> {
    if (entries.length > limits.max_entries) return failure("LIMIT", "tree entry bound exceeded");
    let totalBytes = 0;
    const newFiles = new Set<string>();
    for (const entry of entries) {
      if (
        entry.relative_path.length === 0
        || entry.relative_path.length > limits.max_path_chars
        || entry.relative_path.startsWith("/")
        || entry.relative_path.includes("\\")
        || entry.relative_path.split("/").some((part) => part === "" || part === "." || part === "..")
        || newFiles.has(entry.relative_path)
      ) return failure("UNSAFE_PATH", "invalid tree entry");
      if (entry.bytes.byteLength > limits.max_file_bytes) return failure("LIMIT", "tree file bound exceeded");
      totalBytes += entry.bytes.byteLength;
      if (totalBytes > limits.max_total_bytes) return failure("LIMIT", "tree total bound exceeded");
      newFiles.add(entry.relative_path);
    }

    const target = safeAbsolute(relativeRoot);
    if (typeof target !== "string") return target;
    const parent = dirname(target);
    const nonce = `${process.pid}-${tempCounter++}`;
    const staging = join(parent, `.visualize-staging-${nonce}`);
    const backup = join(parent, `.visualize-backup-${nonce}`);
    let captured = false;
    const pruned: string[] = [];
    const warnings: string[] = [];

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
            mkdirSync(destination, { recursive: true, mode: 0o700 });
            chmodSync(destination, 0o700);
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
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (existsSync(target)) {
        const targetStat = lstatSync(target);
        if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
          return failure("CONFLICT", "tree target is not a directory");
        }
      }
      mkdirSync(staging, { recursive: false, mode: 0o700 });
      chmodSync(staging, 0o700);
      for (const entry of entries) {
        const output = join(staging, ...entry.relative_path.split("/"));
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        chmodSync(dirname(output), 0o700);
        writeFileSync(output, entry.bytes, { flag: "wx", mode: 0o600 });
        chmodSync(output, 0o600);
      }
      if (existsSync(target)) {
        renameSync(target, backup);
        captured = true;
      }
      renameSync(staging, target);
      if (captured) {
        mergePrevious(backup, target);
        removeBestEffort(backup);
      }
      return ok({
        pruned: pruned.sort(),
        warnings: warnings.sort(),
      });
    } catch {
      removeBestEffort(staging);
      if (captured) {
        if (!existsSync(target)) {
          try {
            renameSync(backup, target);
          } catch {
            // best effort rollback for a test-only adapter
          }
        }
        removeBestEffort(backup);
      }
      return failure("IO", "unable to atomically replace storage tree");
    }
  }


  if (!includeTree) return operations;
  return { ...operations, replaceTreeAtomic };
}

export function reportStorageFor(cwd: string): ReportStorageAuthority {
  return createReportStorageAuthority(storageOperationsFor(cwd, false) as ReportStorageOperations);
}

export function reportTreeStorageFor(cwd: string): ReportTreeStorageAuthority {
  return createReportStorageAuthority(storageOperationsFor(cwd, true) as ReportTreeStorageOperations);
}
