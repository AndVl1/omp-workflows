import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { PinnedProjectRoot, PinnedRootError, type PinnedRootFileExpectation, type PinnedRootReadResult } from "./pinned-root.js";

/** Hard limits shared by every filesystem-backed control-plane queue. */
export const DEFAULT_QUEUE_MAX_ENTRIES = 64;
export const DEFAULT_QUEUE_MAX_WORK = 256 * 1024;
export const DEFAULT_QUEUE_MAX_ENTRY_BYTES = 1024 * 1024;
export const DEFAULT_QUEUE_MAX_SCAN_ENTRIES = 4096;
export const DEFAULT_QUEUE_MAX_SCAN_WORK = 4 * 1024 * 1024;

export type BoundedQueueErrorCode =
  | "unsupported"
  | "invalid"
  | "changed"
  | "recovery_required"
  | "path_unauthorized"
  | "not_found"
  | "not_directory"
  | "not_regular"
  | "write_failed"
  | "exists"
  | "limit";

/** Stable typed failure shared by queue producers and consumers. */
export class BoundedQueueError extends Error {
  readonly code: BoundedQueueErrorCode;

  constructor(code: BoundedQueueErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BoundedQueueError";
    this.code = code;
  }
}

export interface BoundedQueueOptions {
  /** Maximum entries returned by one list tick. */
  maxEntries?: number;
  /** Maximum total entry-name bytes returned by one list tick. */
  maxWork?: number;
  /** Maximum bytes accepted by readJson/readText before parsing/decoding. */
  maxEntryBytes?: number;
  /** Maximum entries scanned while producing one page. */
  maxScanEntries?: number;
  /** Maximum total entry-name bytes scanned while producing one page. */
  maxScanWork?: number;
  /** When false, opening a missing queue directory is a read-only no-op. */
  createDirectory?: boolean;
  /** Borrow an already pinned project root for one larger transaction. */
  pinnedRoot?: PinnedProjectRoot;
}

export type BoundedQueueEntryExpectation =
  | { readonly kind: "file"; readonly dev: number; readonly ino: number; readonly size: number; readonly sha256: string }
  | { readonly kind: "directory" | "symlink" | "other"; readonly dev: number; readonly ino: number; readonly size: number };

export interface BoundedQueueEntry {
  readonly name: string;
  readonly relativePath: string;
}

export interface BoundedQueueReadResult extends PinnedRootReadResult {
  readonly expectation: BoundedQueueEntryExpectation & { readonly kind: "file" };
}

export interface BoundedQueuePage {
  readonly entries: BoundedQueueEntry[];
  /** Last returned entry name, or null when the queue is exhausted. */
  readonly nextCursor: string | null;
}

function queueError(error: unknown, context: string): BoundedQueueError {
  if (error instanceof BoundedQueueError) return error;
  if (error instanceof PinnedRootError) {
    if (error.code === "limit" || error.message.includes("bounded directory enumeration exceeded")) return new BoundedQueueError("limit", `${context}: ${error.message}`, { cause: error });
    return new BoundedQueueError(error.code, `${context}: ${error.message}`, { cause: error });
  }
  return new BoundedQueueError("write_failed", `${context}: ${String(error)}`, { cause: error });
}

function entryName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new BoundedQueueError("path_unauthorized", "queue entry name must be one bounded relative path segment");
  }
  return name;
}

function checkedLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new BoundedQueueError("invalid", `${label} must be a positive safe integer`);
  return value;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameQueueExpectation(left: BoundedQueueEntryExpectation, right: BoundedQueueEntryExpectation): boolean {
  if (left.kind !== right.kind || left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size) return false;
  return left.kind !== "file" || right.kind !== "file" || left.sha256 === right.sha256;
}

/**
 * Descriptor-anchored bounded queue rooted at a PinnedProjectRoot.
 *
 * Queue callers never receive a pathname fallback: directories are created and
 * traversed no-follow through the pinned descriptor, reads use the root's
 * O_NOFOLLOW|O_NONBLOCK regular-file reader, and writes/moves/removals stay
 * anchored to that same root. A move is link+identity-checked removal rather
 * than pathname rename, so a producer cannot overwrite an existing archive or
 * remove a replacement file after a race.
 */
export class BoundedQueue {
  readonly relativeDirectory: string;
  readonly maxEntries: number;
  readonly maxWork: number;
  readonly maxEntryBytes: number;
  readonly maxScanEntries: number;
  readonly maxScanWork: number;
  readonly createDirectory: boolean;
  private readonly root: PinnedProjectRoot;
  private readonly ownsRoot: boolean;

  constructor(root: PinnedProjectRoot, relativeDirectory: string, options: BoundedQueueOptions = {}) {
    if (typeof relativeDirectory !== "string") throw new BoundedQueueError("path_unauthorized", "queue directory must be relative");
    this.root = root;
    this.ownsRoot = options.pinnedRoot === undefined;
    this.relativeDirectory = relativeDirectory;
    this.maxEntries = checkedLimit(options.maxEntries, DEFAULT_QUEUE_MAX_ENTRIES, "queue maxEntries");
    this.maxWork = checkedLimit(options.maxWork, DEFAULT_QUEUE_MAX_WORK, "queue maxWork");
    this.maxEntryBytes = checkedLimit(options.maxEntryBytes, DEFAULT_QUEUE_MAX_ENTRY_BYTES, "queue maxEntryBytes");
    this.maxScanEntries = checkedLimit(options.maxScanEntries, DEFAULT_QUEUE_MAX_SCAN_ENTRIES, "queue maxScanEntries");
    this.maxScanWork = checkedLimit(options.maxScanWork, DEFAULT_QUEUE_MAX_SCAN_WORK, "queue maxScanWork");
    this.createDirectory = options.createDirectory ?? true;
  }

  /** Ensure the queue directory through no-follow descriptor traversal. */
  ensureDirectory(relativeDirectory = this.relativeDirectory): void {
    try {
      this.root.ensureDirectory(relativeDirectory);
    } catch (error) {
      throw queueError(error, `queue directory '${relativeDirectory}' could not be ensured`);
    }
  }

  /** Return one deterministic bounded page; excess entries remain for a later tick. */
  listPage(cursor: string | null = null): BoundedQueuePage {
    let page: { names: string[]; nextCursor: string | null };
    try {
      page = this.root.listDirectoryPage(this.relativeDirectory, {
        cursor,
        maxEntries: this.maxEntries,
        maxNameBytes: this.maxWork,
        maxScanEntries: this.maxScanEntries,
        maxScanNameBytes: this.maxScanWork,
      });
    } catch (error) {
      const failure = queueError(error, "queue directory '" + this.relativeDirectory + "' could not be listed");
      if (!this.createDirectory && failure.code === "not_found") return { entries: [], nextCursor: null };
      throw failure;
    }
    const entries: BoundedQueueEntry[] = [];
    for (const name of page.names) {
      entryName(name);
      entries.push({ name, relativePath: this.path(name) });
    }
    return { entries, nextCursor: page.nextCursor };
  }

  /** Return one bounded destructive batch; callers remove it before the next tick. */
  list(): BoundedQueueEntry[] {
    let names: string[];
    try {
      names = this.root.listDirectoryBatch(this.relativeDirectory, {
        maxEntries: this.maxEntries,
        maxNameBytes: this.maxWork,
      });
    } catch (error) {
      const failure = queueError(error, "queue directory '" + this.relativeDirectory + "' could not be listed");
      if (!this.createDirectory && failure.code === "not_found") return [];
      throw failure;
    }
    const entries: BoundedQueueEntry[] = [];
    for (const name of names) {
      entryName(name);
      entries.push({ name, relativePath: this.path(name) });
    }
    return entries;
  }

  /** Return the anchored path used only for display/legacy return values. */
  path(name: string): string {
    // This is a display/return value only. All reads and writes use
    // pathRelative() below and stay descriptor-anchored; retaining the lexical
    // spelling keeps existing callers' path contracts stable on Darwin where
    // /var may canonicalize to /private/var.
    return join(this.root.lexical_root, this.relativeDirectory, entryName(name));
  }

  read(name: string): BoundedQueueReadResult {
    const relativePath = this.pathRelative(name);
    let result: PinnedRootReadResult;
    try {
      result = this.root.readFile(relativePath, { maxBytes: this.maxEntryBytes });
    } catch (error) {
      throw queueError(error, `queue entry '${name}' could not be read safely`);
    }
    if (result.bytes.byteLength > this.maxEntryBytes) {
      throw new BoundedQueueError("limit", `queue entry '${name}' exceeds the ${this.maxEntryBytes}-byte read limit`);
    }
    return {
      ...result,
      expectation: { kind: "file", dev: result.dev, ino: result.ino, size: result.bytes.byteLength, sha256: digest(result.bytes) },
    };
  }

  /** Classify one queue entry without following links; retain its exact inode. */
  classify(name: string): BoundedQueueEntryExpectation {
    const relativePath = this.pathRelative(name);
    try {
      const info = this.root.pathEntryInfo(relativePath);
      if (info === null) throw new BoundedQueueError("not_found", `queue entry '${name}' does not exist`);
      if (info.kind === "file") {
        const read = this.read(name);
        if (read.dev !== info.dev || read.ino !== info.ino || read.bytes.byteLength !== info.size) {
          throw new BoundedQueueError("changed", `queue entry '${name}' changed during classification`);
        }
        return read.expectation;
      }
      return { kind: info.kind, dev: info.dev, ino: info.ino, size: info.size };
    } catch (error) {
      throw queueError(error, `queue entry '${name}' could not be classified safely`);
    }
  }

  readText(name: string): string {
    return Buffer.from(this.read(name).bytes).toString("utf8");
  }

  readJson<T>(name: string): T {
    try {
      return JSON.parse(this.readText(name)) as T;
    } catch (error) {
      if (error instanceof BoundedQueueError) throw error;
      throw new BoundedQueueError("invalid", `queue entry '${name}' is not valid JSON`, { cause: error });
    }
  }
  /** Read and parse one bounded batch under one anchored root operation. */
  readJsonBatch<T = unknown>(names: readonly string[]): {
    records: Array<{ name: string; value: T | null }>;
    failed: string[];
    remaining: string[];
  } {
    try {
      const batch = this.root.readBatch(this.relativeDirectory, names, {
        maxEntries: this.maxEntries,
        maxNameBytes: this.maxWork,
        maxBytes: this.maxEntryBytes,
      });
      const failed = [...batch.failed];
      const records: Array<{ name: string; value: T | null }> = [];
      for (const record of batch.records) {
        try {
          records.push({ name: record.name, value: JSON.parse(Buffer.from(record.bytes).toString("utf8")) as T });
        } catch {
          failed.push(record.name);
        }
      }
      return { records, failed, remaining: batch.remaining };
    } catch (error) {
      throw queueError(error, "queue entry batch could not be read safely");
    }
  }


  writeExclusive(name: string, content: string | Uint8Array): void {
    try {
      this.root.writeExclusive(this.pathRelative(name), content);
    } catch (error) {
      throw queueError(error, `queue entry '${name}' could not be created exclusively`);
    }
  }

  writeAtomic(name: string, content: string | Uint8Array): void {
    try {
      this.root.writeAtomic(this.pathRelative(name), content);
    } catch (error) {
      throw queueError(error, `queue entry '${name}' could not be written atomically`);
    }
  }

  exists(name: string): boolean {
    try {
      return this.root.pathEntryExists(this.pathRelative(name));
    } catch (error) {
      throw queueError(error, `queue entry '${name}' could not be inspected safely`);
    }
  }

  existsAt(relativePath: string): boolean {
    try {
      return this.root.pathEntryExists(relativePath);
    } catch (error) {
      throw queueError(error, `queue entry '${relativePath}' could not be inspected safely`);
    }
  }

  /** Remove one regular entry only when the caller's exact preimage still matches. */
  remove(name: string, expected: PinnedRootFileExpectation): void {
    this.removeIfMatches(name, expected);
  }

  removeIfMatches(name: string, expected: PinnedRootFileExpectation): void {
    if (!expected) throw new BoundedQueueError("invalid", "queue removal requires an exact inode and digest expectation");
    try {
      this.root.removeFileIfMatches(this.pathRelative(name), expected);
    } catch (error) {
      throw queueError(error, `queue entry '${name}' could not be removed safely`);
    }
  }

  replaceIfMatches(name: string, expected: PinnedRootFileExpectation, content: string | Uint8Array): void {
    if (!expected) throw new BoundedQueueError("invalid", "queue replacement requires an exact inode and digest expectation");
    try {
      this.root.replaceFileIfMatches(this.pathRelative(name), expected, content);
    } catch (error) {
      throw queueError(error, `queue entry '${name}' could not be replaced safely`);
    }
  }

  private preserveStage(stagePath: string, sourceName: string, cause: unknown): BoundedQueueError {
    const recoveryPath = join(this.relativeDirectory, `.queue-recovery-${randomUUID()}.stage`);
    try {
      this.root.renameFileExclusive(stagePath, recoveryPath);
      return new BoundedQueueError("recovery_required", `queue entry ${sourceName} requires recovery at ${recoveryPath}`, { cause });
    } catch {
      return new BoundedQueueError("recovery_required", `queue entry ${sourceName} requires recovery from stage ${stagePath}`, { cause });
    }
  }

  private restoreStageOrRecover(stagePath: string, sourcePath: string, sourceName: string, cause: unknown): Error {
    try {
      if (!this.root.pathEntryExists(sourcePath)) {
        this.root.renameFileExclusive(stagePath, sourcePath);
        return cause instanceof Error ? cause : new BoundedQueueError("write_failed", String(cause));
      }
    } catch {
      // A concurrent source winner or a failed restore leaves the stage for
      // the explicit recovery path below; never remove either name.
    }
    return this.preserveStage(stagePath, sourceName, cause);
  }

  private moveExactNoReplace(sourceName: string, expected: PinnedRootFileExpectation, destinationRelativePath: string): void {
    const sourcePath = this.pathRelative(sourceName);
    const stagePath = join(this.relativeDirectory, `.queue-move-${randomUUID()}.stage`);
    const matchesExpected = (observed: PinnedRootReadResult): boolean =>
      observed.dev === expected.dev
      && observed.ino === expected.ino
      && (expected.size === undefined || observed.bytes.byteLength === expected.size)
      && digest(observed.bytes) === expected.sha256;
    let stagePresent = false;
    try {
      this.root.renameFileExclusive(sourcePath, stagePath);
      stagePresent = true;
      const staged = this.root.readFile(stagePath);
      if (!matchesExpected(staged)) {
        stagePresent = false;
        throw this.restoreStageOrRecover(stagePath, sourcePath, sourceName, new BoundedQueueError("changed", `queue entry ${sourceName} changed during staging`));
      }
      try {
        this.root.renameFileExclusive(stagePath, destinationRelativePath);
        stagePresent = false;
      } catch (error) {
        stagePresent = false;
        throw this.restoreStageOrRecover(stagePath, sourcePath, sourceName, error);
      }
      let moved: PinnedRootReadResult;
      try {
        moved = this.root.readFile(destinationRelativePath);
      } catch (error) {
        throw new BoundedQueueError("recovery_required", `queue entry ${sourceName} destination receipt is unavailable; current winner is preserved`, { cause: error });
      }
      if (!matchesExpected(moved)) {
        throw new BoundedQueueError("recovery_required", `queue entry ${sourceName} destination receipt changed; current winner is preserved`);
      }
    } catch (error) {
      if (stagePresent) {
        stagePresent = false;
        throw this.restoreStageOrRecover(stagePath, sourcePath, sourceName, error);
      }
      throw queueError(error, `queue entry '${sourceName}' could not be moved safely`);
    }
  }

  /**
   * Move one regular entry without overwriting an existing destination. The
   * source is moved to an operation-unique stage and only published at the
   * destination after an exact receipt check.
   */
  moveTo(name: string, destinationRelativePath: string): void {
    const sourceName = entryName(name);
    if (typeof destinationRelativePath !== "string" || destinationRelativePath.length === 0) {
      throw new BoundedQueueError("path_unauthorized", "queue move destination must be a bounded relative path");
    }
    const sourcePath = this.pathRelative(sourceName);
    try {
      const observed = this.root.readFile(sourcePath);
      if (this.root.pathEntryExists(destinationRelativePath)) throw new BoundedQueueError("exists", "queue move destination already exists");
      this.moveExactNoReplace(sourceName, {
        dev: observed.dev,
        ino: observed.ino,
        size: observed.bytes.byteLength,
        sha256: digest(observed.bytes),
      }, destinationRelativePath);
    } catch (error) {
      throw queueError(error, `queue entry '${sourceName}' could not be moved safely`);
    }
  }

  /** Move only the exact classified source, preserving a concurrent replacement. */
  moveToIfMatches(name: string, expected: PinnedRootFileExpectation, destinationRelativePath: string): void {
    const sourceName = entryName(name);
    if (!expected || typeof expected !== "object") throw new BoundedQueueError("invalid", "queue move requires an exact file expectation");
    if (typeof destinationRelativePath !== "string" || destinationRelativePath.length === 0) {
      throw new BoundedQueueError("path_unauthorized", "queue move destination must be a bounded relative path");
    }
    try {
      const current = this.classify(sourceName);
      if (current.kind !== "file" || current.dev !== expected.dev || current.ino !== expected.ino || current.sha256 !== expected.sha256) {
        throw new BoundedQueueError("changed", `queue entry ${sourceName} changed before move`);
      }
      if (this.root.pathEntryExists(destinationRelativePath)) throw new BoundedQueueError("exists", "queue move destination already exists");
      this.moveExactNoReplace(sourceName, expected, destinationRelativePath);
    } catch (error) {
      throw queueError(error, `queue entry ${sourceName} could not be moved safely`);
    }
  }

  /** Atomically move any anchored queue entry to a pre-created sibling lane. */
  moveAtomically(name: string, destinationRelativePath: string): void {
    const sourceName = entryName(name);
    if (typeof destinationRelativePath !== "string" || destinationRelativePath.length === 0) {
      throw new BoundedQueueError("path_unauthorized", "queue atomic move destination must be a bounded relative path");
    }
    try {
      this.root.renameFileExclusive(this.pathRelative(sourceName), destinationRelativePath);
    } catch (error) {
      throw queueError(error, `queue entry  could not be moved atomically`);
    }
  }

  /** Discard one regular unusable entry only when its classified postimage still matches. */
  discard(name: string, expected: BoundedQueueEntryExpectation, rejectedRelativeDirectory: string): void {
    this.discardBatch([{ name: entryName(name), expected }], rejectedRelativeDirectory);
  }

  /** Discard a bounded classified batch without path-only fallback. */
  discardBatch(entries: readonly { name: string; expected: BoundedQueueEntryExpectation }[], rejectedRelativeDirectory: string): number {
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    if (typeof rejectedRelativeDirectory !== "string" || rejectedRelativeDirectory.length === 0) {
      throw new BoundedQueueError("path_unauthorized", "queue rejected directory must be a bounded relative path");
    }
    let moved = 0;
    try {
      this.root.ensureDirectory(rejectedRelativeDirectory);
      for (const entry of entries) {
        const sourceName = entryName(entry.name);
        const expected = entry.expected;
        if (!expected || typeof expected !== "object" || !Number.isSafeInteger(expected.dev) || !Number.isSafeInteger(expected.ino) || !Number.isSafeInteger(expected.size) || expected.dev < 0 || expected.ino < 0 || expected.size < 0) {
          throw new BoundedQueueError("invalid", `queue entry '${sourceName}' requires an exact classification`);
        }
        let current: BoundedQueueEntryExpectation;
        try { current = this.classify(sourceName); } catch (error) {
          if (error instanceof BoundedQueueError && error.code === "not_found") continue;
          throw error;
        }
        if (!sameQueueExpectation(current, expected)) throw new BoundedQueueError("changed", `queue entry '${sourceName}' changed before quarantine`);
        if (expected.kind === "file") {
          const destination = join(rejectedRelativeDirectory, `${sourceName}.${randomUUID()}.discarded`);
          this.moveExactNoReplace(sourceName, expected, destination);
          moved += 1;
          continue;
        }
        // There is no descriptor-anchored non-regular move primitive. Never
        // path-move a directory, symlink, or special file after classification:
        // preserving it is safer than risking a same-name replacement.
        throw new BoundedQueueError("not_regular", `queue entry '${sourceName}' is not a regular file and cannot be discarded safely`);
      }
      return moved;
    } catch (error) {
      throw queueError(error, "queue entry batch could not be discarded safely");
    }
  }
  /** Release an owned root descriptor; borrowed roots stay with the caller. */
  close(): void {
    if (this.ownsRoot) this.root.close();
  }

  private pathRelative(name: string): string {
    return join(this.relativeDirectory, entryName(name));
  }
}

/** Pin a project root and open one no-follow queue directory. */
export function openBoundedQueue(projectRoot: string, relativeDirectory: string, options: BoundedQueueOptions = {}): BoundedQueue | null {
  const borrowedRoot = options.pinnedRoot;
  const root = borrowedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!root) return null;
  try {
    const queue = new BoundedQueue(root, relativeDirectory, options);
    if (queue.createDirectory) queue.ensureDirectory();
    return queue;
  } catch (error) {
    if (!borrowedRoot) root.close();
    throw error;
  }
}
