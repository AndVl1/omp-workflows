/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

/**
 * Descriptor-relative storage capability consumed by report/session projection.
 *
 * The capability is deliberately free of roots, cwd and pathnames. A owning
 * boundary (the fullstack authority in production) pins its instance to one
 * admitted project/run and performs the actual containment, symlink and
 * atomic-publication checks.
 */

export type StorageFailureReason =
  | "CAPABILITY_MISSING"
  | "MIGRATION_REQUIRED"
  | "IDENTITY_MISMATCH"
  | "UNSAFE_PATH"
  | "LIMIT"
  | "CONFLICT"
  | "IO";

export interface StorageFailure {
  readonly ok: false;
  readonly reason: StorageFailureReason;
  readonly code: StorageFailureReason;
  readonly message?: string;
}

export type StorageResult<T> = { readonly ok: true; readonly value: T } | StorageFailure;

/** One descriptor-relative file-system entry returned by a bounded listing. */
export interface StorageEntry {
  readonly name: string;
  readonly relative_path: string;
}

/** Bounded metadata returned by a descriptor-relative stat operation. */
export interface StorageStat {
  readonly exists: boolean;
  readonly kind: "missing" | "file" | "directory";
  readonly size_bytes: number;
  readonly mtime_ms: number;
}

export interface StorageTreeEntry {
  readonly relative_path: string;
  readonly bytes: Uint8Array;
}

export interface StorageTreeLimits {
  readonly max_path_chars: number;
  readonly max_file_bytes: number;
  readonly max_entries: number;
  readonly max_total_bytes: number;
}

export interface StorageTreePublishResult {
  readonly pruned: readonly string[];
  readonly warnings: readonly string[];
}


export interface ReportStorageOperations {
  readBounded(relativePath: string, maxBytes: number): StorageResult<Uint8Array | null>;
  readTextBounded(relativePath: string, maxBytes: number): StorageResult<string | null>;
  listBounded(relativeDirectory: string, maxEntries: number): StorageResult<readonly StorageEntry[]>;
  statBounded(relativePath: string): StorageResult<StorageStat>;
  writeExclusive(relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void>;
  writeAtomic(relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void>;
}

export interface ReportTreeStorageOperations extends ReportStorageOperations {
  replaceTreeAtomic(
    relativeRoot: string,
    entries: readonly StorageTreeEntry[],
    limits: StorageTreeLimits,
  ): StorageResult<StorageTreePublishResult>;
}

declare const reportStorageAuthorityBrand: unique symbol;

/**
 * Opaque, instance-issued report storage authority. Production callers obtain
 * this through an owning boundary; report code never discovers or derives it.
 */
export interface ReportStorageAuthority extends ReportStorageOperations {
  readonly [reportStorageAuthorityBrand]: "ReportStorageAuthority";
}

export interface ReportTreeStorageAuthority extends ReportStorageAuthority {
  readonly replaceTreeAtomic: (
    relativeRoot: string,
    entries: readonly StorageTreeEntry[],
    limits: StorageTreeLimits,
  ) => StorageResult<StorageTreePublishResult>;
}

const issuedAuthorities = new WeakSet<object>();
const issuedTreeAuthorities = new WeakSet<object>();

/**
 * Adapt an owning authority to the core report contract. This delegates every
 * operation and never adds a pathname-backed fallback. Tree publication is
 * exposed only when the owning authority supplies the dedicated primitive.
 */
export function createReportStorageAuthority(operations: ReportTreeStorageOperations): ReportTreeStorageAuthority;
export function createReportStorageAuthority(operations: ReportStorageOperations): ReportStorageAuthority;
export function createReportStorageAuthority(
  operations: ReportStorageOperations | ReportTreeStorageOperations,
): ReportStorageAuthority | ReportTreeStorageAuthority {
  if (!isStorageOperations(operations)) {
    throw new TypeError("report storage authority requires read/list/stat/write operations");
  }
  const delegates = {
    readBounded: operations.readBounded.bind(operations),
    readTextBounded: operations.readTextBounded.bind(operations),
    listBounded: operations.listBounded.bind(operations),
    statBounded: operations.statBounded.bind(operations),
    writeExclusive: operations.writeExclusive.bind(operations),
    writeAtomic: operations.writeAtomic.bind(operations),
  };
  if (isTreeStorageOperations(operations)) {
    const authority = Object.freeze({
      ...delegates,
      replaceTreeAtomic: operations.replaceTreeAtomic.bind(operations),
    }) as ReportTreeStorageAuthority;
    issuedAuthorities.add(authority);
    issuedTreeAuthorities.add(authority);
    return authority;
  }
  const authority = Object.freeze(delegates) as ReportStorageAuthority;
  issuedAuthorities.add(authority);
  return authority;
}

/** True only for capabilities issued through this report boundary. */
export function isReportStorageAuthority(value: unknown): value is ReportStorageAuthority {
  return isObject(value) && issuedAuthorities.has(value);
}

/** True only for factory-issued authorities with the whole-tree primitive. */
export function isReportTreeStorageAuthority(value: unknown): value is ReportTreeStorageAuthority {
  return isReportStorageAuthority(value) && issuedTreeAuthorities.has(value);
}

export const MAX_STORAGE_PATH_CHARS = 1024;
export const MAX_STORAGE_READ_BYTES = 2 * 1024 * 1024;
export const MAX_STORAGE_WRITE_BYTES = 8 * 1024 * 1024;
export const MAX_STORAGE_ENTRIES = 4096;
export const MAX_STORAGE_TREE_TOTAL_BYTES = 32 * 1024 * 1024;

export class ReportStorageError extends Error {
  readonly reason: StorageFailureReason;
  readonly code: StorageFailureReason;

  constructor(reason: StorageFailureReason, message: string) {
    super(message);
    this.name = "ReportStorageError";
    this.reason = reason;
    this.code = reason;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isStorageOperations(value: unknown): value is ReportStorageOperations {
  return isObject(value)
    && typeof value.readBounded === "function"
    && typeof value.readTextBounded === "function"
    && typeof value.listBounded === "function"
    && typeof value.statBounded === "function"
    && typeof value.writeExclusive === "function"
    && typeof value.writeAtomic === "function";
}

function isTreeStorageOperations(value: unknown): value is ReportTreeStorageOperations {
  return isStorageOperations(value)
    && "replaceTreeAtomic" in value
    && typeof value.replaceTreeAtomic === "function";
}
function failureMessage(operation: string, failure: StorageFailure): string {
  return `report storage ${operation} failed (${failure.reason})${failure.message ? `: ${failure.message}` : ""}`;
}

function assertRelativePath(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STORAGE_PATH_CHARS) {
    throw new ReportStorageError("UNSAFE_PATH", `${field} must be a bounded relative path`);
  }
  if (value.includes("\\") || value.includes("\0") || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || value.startsWith("/")) {
    throw new ReportStorageError("UNSAFE_PATH", `${field} contains an unsafe path character`);
  }
  const pieces = value.split("/");
  if (pieces.some((piece) => piece.length === 0 || piece === "." || piece === "..")) {
    throw new ReportStorageError("UNSAFE_PATH", `${field} contains an unsafe path component`);
  }
  if (pieces.some((piece) => /^[A-Za-z]:$/u.test(piece))) {
    throw new ReportStorageError("UNSAFE_PATH", `${field} must not contain a drive component`);
  }
  return value;
}

function assertBound(value: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ReportStorageError("LIMIT", `${field} exceeds the report storage bound`);
  }
  return value;
}

function unwrap<T>(operation: string, result: unknown): T {
  if (!isObject(result) || typeof result.ok !== "boolean") {
    throw new ReportStorageError("IO", `report storage ${operation} returned an invalid result`);
  }
  if (result.ok !== true) {
    const failure = result as unknown as StorageFailure;
    const reason = failure.reason;
    if (
      reason !== "CAPABILITY_MISSING"
      && reason !== "MIGRATION_REQUIRED"
      && reason !== "IDENTITY_MISMATCH"
      && reason !== "UNSAFE_PATH"
      && reason !== "LIMIT"
      && reason !== "CONFLICT"
      && reason !== "IO"
    ) {
      throw new ReportStorageError("IO", `report storage ${operation} returned an unknown failure`);
    }
    throw new ReportStorageError(reason, failureMessage(operation, failure));
  }
  return result.value as T;
}

export function requireReportStorage(value: unknown): ReportStorageAuthority {
  if (!isReportStorageAuthority(value)) {
    throw new ReportStorageError(
      "CAPABILITY_MISSING",
      "report/session APIs require an instance-bound storage authority",
    );
  }
  return value;
}

export function requireReportTreeStorage(value: unknown): ReportTreeStorageAuthority {
  if (!isReportTreeStorageAuthority(value)) {
    throw new ReportStorageError(
      "CAPABILITY_MISSING",
      "tree storage APIs require an instance-bound tree storage authority",
    );
  }
  return value;
}

export function readStorageBytes(
  storage: ReportStorageAuthority,
  relativePath: string,
  maxBytes: number,
): Uint8Array | null {
  const path = assertRelativePath(relativePath, "relativePath");
  const bound = assertBound(maxBytes, MAX_STORAGE_READ_BYTES, "maxBytes");
  const bytes = unwrap<Uint8Array | null>("readBounded", storage.readBounded(path, bound));
  if (bytes !== null && (!(bytes instanceof Uint8Array) || bytes.byteLength > bound)) {
    throw new ReportStorageError("LIMIT", "report storage returned bytes beyond the requested bound");
  }
  return bytes;
}

export function listStorageEntries(
  storage: ReportStorageAuthority,
  relativeDirectory: string,
  maxEntries: number,
): readonly StorageEntry[] {
  const directory = assertRelativePath(relativeDirectory, "relativeDirectory");
  const bound = assertBound(maxEntries, MAX_STORAGE_ENTRIES, "maxEntries");
  const entries = unwrap<readonly StorageEntry[]>("listBounded", storage.listBounded(directory, bound));
  if (!Array.isArray(entries) || entries.length > bound) {
    throw new ReportStorageError("LIMIT", "report storage returned entries beyond the requested bound");
  }
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.name !== "string" || typeof entry.relative_path !== "string") {
      throw new ReportStorageError("IO", "report storage returned a malformed directory entry");
    }
    assertRelativePath(entry.name, "entry.name");
    const fullPath = assertRelativePath(entry.relative_path, "entry.relative_path");
    if (fullPath !== `${directory}/${entry.name}`) {
      throw new ReportStorageError("UNSAFE_PATH", "report storage returned an entry outside its listed directory");
    }
  }
  return entries;
}

export function statStorage(
  storage: ReportStorageAuthority,
  relativePath: string,
): StorageStat {
  const path = assertRelativePath(relativePath, "relativePath");
  const stat = unwrap<StorageStat>("statBounded", storage.statBounded(path));
  if (!isObject(stat) || typeof stat.exists !== "boolean") {
    throw new ReportStorageError("IO", "report storage returned malformed metadata");
  }
  if (stat.kind !== "missing" && stat.kind !== "file" && stat.kind !== "directory") {
    throw new ReportStorageError("IO", "report storage returned an unknown entry kind");
  }
  if (!Number.isSafeInteger(stat.size_bytes) || stat.size_bytes < 0 || typeof stat.mtime_ms !== "number" || !Number.isFinite(stat.mtime_ms)) {
    throw new ReportStorageError("IO", "report storage returned invalid metadata bounds");
  }
  if (!stat.exists && stat.kind !== "missing") {
    throw new ReportStorageError("IO", "report storage returned inconsistent missing metadata");
  }
  if (stat.exists && stat.kind === "missing") {
    throw new ReportStorageError("IO", "report storage returned inconsistent existing metadata");
  }
  return stat;
}

function writeStorage(
  storage: ReportStorageAuthority,
  relativePath: string,
  bytes: Uint8Array,
  operation: "writeExclusive" | "writeAtomic",
): void {
  const path = assertRelativePath(relativePath, "relativePath");
  if (!(bytes instanceof Uint8Array)) throw new ReportStorageError("IO", "report output must be bytes");
  assertBound(bytes.byteLength, MAX_STORAGE_WRITE_BYTES, "write bytes");
  const result = operation === "writeAtomic"
    ? storage.writeAtomic(path, bytes, MAX_STORAGE_WRITE_BYTES)
    : storage.writeExclusive(path, bytes, MAX_STORAGE_WRITE_BYTES);
  unwrap<void>(operation, result);
}

export function writeStorageExclusive(
  storage: ReportStorageAuthority,
  relativePath: string,
  bytes: Uint8Array,
): void {
  writeStorage(storage, relativePath, bytes, "writeExclusive");
}

export function writeStorageAtomic(
  storage: ReportStorageAuthority,
  relativePath: string,
  bytes: Uint8Array,
): void {
  writeStorage(storage, relativePath, bytes, "writeAtomic");
}

export function storagePath(...segments: readonly string[]): string {
  if (segments.length === 0) throw new ReportStorageError("UNSAFE_PATH", "storage path must not be empty");
  const path = segments.join("/");
  return assertRelativePath(path, "storage path");
}

export function decodeStorageText(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

function validateTreeLimits(limits: StorageTreeLimits): StorageTreeLimits {
  if (!isObject(limits)) throw new ReportStorageError("LIMIT", "tree storage limits are required");
  const maxPathChars = assertBound(limits.max_path_chars, MAX_STORAGE_PATH_CHARS, "tree max_path_chars");
  if (maxPathChars === 0) throw new ReportStorageError("LIMIT", "tree max_path_chars must be positive");
  const maxFileBytes = assertBound(limits.max_file_bytes, MAX_STORAGE_WRITE_BYTES, "tree max_file_bytes");
  const maxEntries = assertBound(limits.max_entries, MAX_STORAGE_ENTRIES, "tree max_entries");
  const maxTotalBytes = assertBound(limits.max_total_bytes, MAX_STORAGE_TREE_TOTAL_BYTES, "tree max_total_bytes");
  return {
    max_path_chars: maxPathChars,
    max_file_bytes: maxFileBytes,
    max_entries: maxEntries,
    max_total_bytes: maxTotalBytes,
  };
}

function validateTreeEntries(
  relativeRoot: string,
  entries: readonly StorageTreeEntry[],
  limits: StorageTreeLimits,
): readonly StorageTreeEntry[] {
  const root = assertRelativePath(relativeRoot, "relativeRoot");
  if (root.length > limits.max_path_chars) {
    throw new ReportStorageError("LIMIT", "tree relativeRoot exceeds max_path_chars");
  }
  if (!Array.isArray(entries) || entries.length > limits.max_entries) {
    throw new ReportStorageError("LIMIT", "tree entries exceed max_entries");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.relative_path !== "string" || !(entry.bytes instanceof Uint8Array)) {
      throw new ReportStorageError("IO", "tree storage returned malformed entry");
    }
    const path = assertRelativePath(entry.relative_path, "tree entry relative_path");
    if (path.length > limits.max_path_chars) {
      throw new ReportStorageError("LIMIT", "tree entry path exceeds max_path_chars");
    }
    if (seen.has(path)) throw new ReportStorageError("CONFLICT", "tree entries contain duplicate paths");
    seen.add(path);
    if (entry.bytes.byteLength > limits.max_file_bytes) {
      throw new ReportStorageError("LIMIT", "tree entry exceeds max_file_bytes");
    }
    totalBytes += entry.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.max_total_bytes) {
      throw new ReportStorageError("LIMIT", "tree entries exceed max_total_bytes");
    }
  }
  return entries;
}

function validateTreePublishResult(
  value: unknown,
  limits: StorageTreeLimits,
): StorageTreePublishResult {
  if (!isObject(value) || !Array.isArray(value.pruned) || !Array.isArray(value.warnings)) {
    throw new ReportStorageError("IO", "tree storage returned malformed publish result");
  }
  if (value.pruned.length > limits.max_entries || value.warnings.length > limits.max_entries) {
    throw new ReportStorageError("LIMIT", "tree publish result exceeds max_entries");
  }
  for (const path of value.pruned) {
    if (typeof path !== "string") throw new ReportStorageError("IO", "tree publish result has malformed pruned path");
    if (path.length > limits.max_path_chars) {
      throw new ReportStorageError("LIMIT", "tree publish result path exceeds max_path_chars");
    }
    assertRelativePath(path, "tree publish result path");
  }
  for (const warning of value.warnings) {
    if (
      typeof warning !== "string"
      || warning.length > MAX_STORAGE_PATH_CHARS
      || /[\u0000-\u001f\u007f-\u009f]/u.test(warning)
    ) {
      throw new ReportStorageError("IO", "tree publish result has malformed warning");
    }
  }
  return { pruned: value.pruned, warnings: value.warnings };
}

export function replaceStorageTreeAtomic(
  storage: ReportTreeStorageAuthority,
  relativeRoot: string,
  entries: readonly StorageTreeEntry[],
  limits: StorageTreeLimits,
): StorageTreePublishResult {
  const authority = requireReportTreeStorage(storage);
  const checkedLimits = validateTreeLimits(limits);
  const root = assertRelativePath(relativeRoot, "relativeRoot");
  const checkedEntries = validateTreeEntries(root, entries, checkedLimits);
  const result = unwrap<StorageTreePublishResult>(
    "replaceTreeAtomic",
    authority.replaceTreeAtomic(root, checkedEntries, checkedLimits),
  );
  return validateTreePublishResult(result, checkedLimits);
}
