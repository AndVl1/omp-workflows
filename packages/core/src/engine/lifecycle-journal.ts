import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const WORK_STATE = ".work-state";
const TRANSACTIONS_DIR = "lifecycle-transactions";
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export type LifecycleTransactionStatus = "prepared" | "committing" | "committed" | "rolled_back";
export type LifecycleFileContent = string | { encoding: "base64"; data: string } | null;

/**
 * A transaction record stores complete prepared bytes, not merely a status.
 * `before` and `after` are keyed by paths relative to the project root and
 * contain null for an absent file. The manifests are hashes over those exact
 * bytes and let recovery distinguish a complete publication from a torn one.
 */
export interface LifecycleTransactionRecord {
  transaction_id: string;
  operation: "new" | "resume" | "rework" | "migration" | "claim";
  status: LifecycleTransactionStatus;
  created_at: string;
  updated_at: string;
  before: Record<string, LifecycleFileContent>;
  after: Record<string, LifecycleFileContent>;
  before_manifest: Record<string, string | null>;
  after_manifest: Record<string, string | null>;
  /** Set atomically before publication starts. Its presence commits forward. */
  commit_marker: string | null;
}

export class LifecycleRecoveryError extends Error {
  readonly code = "recovery_required" as const;
  readonly transaction_id?: string;

  constructor(message: string, transactionId?: string) {
    super(message);
    this.name = "LifecycleRecoveryError";
    this.transaction_id = transactionId;
  }
}

function transactionRoot(cwd: string): string {
  return resolve(cwd, WORK_STATE, TRANSACTIONS_DIR);
}

function recordPath(cwd: string, transactionId: string): string {
  if (!SAFE_SEGMENT.test(transactionId)) throw new LifecycleRecoveryError(`invalid lifecycle transaction id '${transactionId}'`, transactionId);
  return join(transactionRoot(cwd), transactionId, "transaction.json");
}

function atomicWriteRaw(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, "utf8");
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* preserve original failure */ }
    throw error;
  }
}

function atomicWriteBytes(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, bytes); renameSync(temp, path); }
  catch (error) { try { unlinkSync(temp); } catch { /* preserve original failure */ } throw error; }
}

function atomicWrite(path: string, value: unknown): void {
  atomicWriteRaw(path, `${JSON.stringify(value, null, 2)}\n`);
}

function digest(value: LifecycleFileContent): string | null {
  if (value === null) return null;
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value.data, "base64");
  return createHash("sha256").update(bytes).digest("hex");
}

function keyFor(cwd: string, path: string): string {
  const root = resolve(cwd);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new LifecycleRecoveryError(`lifecycle transaction path escapes project root: '${path}'`);
  }
  return rel.split("\\").join("/");
}

function absolutePath(cwd: string, key: string): string {
  if (!key || isAbsolute(key) || key.split("/").some((segment) => segment === "..") || !key.split("/").every((segment) => segment.length > 0 && segment !== ".")) {
    throw new LifecycleRecoveryError(`invalid lifecycle transaction path '${key}'`);
  }
  return resolve(cwd, key);
}

function normalizeFiles(cwd: string, files: Record<string, LifecycleFileContent>): Record<string, LifecycleFileContent> {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new LifecycleRecoveryError("lifecycle transaction file map is malformed");
  return Object.fromEntries(Object.entries(files).map(([path, content]) => {
    if (content !== null && typeof content !== "string" && !(typeof content === "object" && content.encoding === "base64" && typeof content.data === "string")) throw new LifecycleRecoveryError(`lifecycle transaction content for '${path}' is malformed`);
    return [keyFor(cwd, path), content];
  }));
}

function manifest(files: Record<string, LifecycleFileContent>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, digest(content)]));
}
function manifestsEqual(left: Record<string, string | null>, right: unknown): boolean {
  if (!right || typeof right !== "object" || Array.isArray(right)) return false;
  const expected = Object.entries(left);
  const actual = Object.entries(right as Record<string, unknown>);
  if (expected.length !== actual.length) return false;
  return expected.every(([path, hash]) => (right as Record<string, unknown>)[path] === hash);
}

function parseRecord(cwd: string, transactionId: string): LifecycleTransactionRecord {
  const path = recordPath(cwd, transactionId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LifecycleRecoveryError(`lifecycle transaction '${transactionId}' is unreadable: ${(error as Error).message}`, transactionId);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new LifecycleRecoveryError(`lifecycle transaction '${transactionId}' is malformed`, transactionId);
  const value = parsed as Partial<LifecycleTransactionRecord>;
  const statuses: LifecycleTransactionStatus[] = ["prepared", "committing", "committed", "rolled_back"];
  const operations: LifecycleTransactionRecord["operation"][] = ["new", "resume", "rework", "migration", "claim"];
  if (value.transaction_id !== transactionId || typeof value.operation !== "string" || !operations.includes(value.operation as LifecycleTransactionRecord["operation"]) || !statuses.includes(value.status as LifecycleTransactionStatus)
    || typeof value.created_at !== "string" || typeof value.updated_at !== "string" || !value.before || !value.after
    || !value.before_manifest || !value.after_manifest || (value.commit_marker !== null && typeof value.commit_marker !== "string")) {
    throw new LifecycleRecoveryError(`lifecycle transaction '${transactionId}' has an invalid record`, transactionId);
  }
  const before = normalizeFiles(cwd, value.before as Record<string, string | null>);
  const after = normalizeFiles(cwd, value.after as Record<string, string | null>);
  const beforeManifest = manifest(before);
  const afterManifest = manifest(after);
  if (!manifestsEqual(beforeManifest, value.before_manifest) || !manifestsEqual(afterManifest, value.after_manifest)) {
    throw new LifecycleRecoveryError(`lifecycle transaction '${transactionId}' has a manifest mismatch`, transactionId);
  }
  return {
    transaction_id: transactionId,
    operation: value.operation as LifecycleTransactionRecord["operation"],
    status: value.status as LifecycleTransactionStatus,
    created_at: value.created_at,
    updated_at: value.updated_at,
    before,
    after,
    before_manifest: beforeManifest,
    after_manifest: afterManifest,
    commit_marker: value.commit_marker ?? null,
  };
}

function readFileValue(path: string): LifecycleFileContent {
  try {
    const bytes = readFileSync(path);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      try { return "\ufeff" + new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3)); }
      catch { return { encoding: "base64", data: bytes.toString("base64") }; }
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return { encoding: "base64", data: bytes.toString("base64") }; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function fileContentEqual(left: LifecycleFileContent, right: LifecycleFileContent): boolean {
  if (left === null || right === null) return left === right;
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left.encoding === right.encoding && left.data === right.data;
}

function currentMatches(cwd: string, files: Record<string, LifecycleFileContent>): boolean {
  return Object.entries(files).every(([key, expected]) => fileContentEqual(readFileValue(absolutePath(cwd, key)), expected));
}

function applyFiles(cwd: string, files: Record<string, LifecycleFileContent>): void {
  for (const [key, content] of Object.entries(files)) {
    const path = absolutePath(cwd, key);
    if (content === null) {
      try { unlinkSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    if (typeof content === "string") atomicWriteRaw(path, content);
    else atomicWriteBytes(path, Buffer.from(content.data, "base64"));
  }
}

function writeStatus(cwd: string, record: LifecycleTransactionRecord, status: LifecycleTransactionStatus, commitMarker = record.commit_marker): LifecycleTransactionRecord {
  const next: LifecycleTransactionRecord = { ...record, status, commit_marker: commitMarker, updated_at: new Date().toISOString() };
  atomicWrite(recordPath(cwd, record.transaction_id), next);
  return next;
}

export function beginLifecycleTransaction(input: {
  cwd: string;
  operation: LifecycleTransactionRecord["operation"];
  before?: Record<string, LifecycleFileContent>;
  after?: Record<string, LifecycleFileContent>;
}): LifecycleTransactionRecord {
  const transaction_id = randomUUID();
  const before = normalizeFiles(input.cwd, input.before ?? {});
  const after = normalizeFiles(input.cwd, input.after ?? {});
  const now = new Date().toISOString();
  const record: LifecycleTransactionRecord = {
    transaction_id,
    operation: input.operation,
    status: "prepared",
    created_at: now,
    updated_at: now,
    before,
    after,
    before_manifest: manifest(before),
    after_manifest: manifest(after),
    commit_marker: null,
  };
  atomicWrite(recordPath(input.cwd, transaction_id), record);
  return record;
}

/**
 * Publish a prepared transaction. The committing marker is the durable point
 * of no return: recovery rolls back `prepared`, but repairs `committing`
 * forward. A committed transaction is terminal and is never replayed.
 */
export function commitLifecycleTransaction(cwd: string, transactionId: string): LifecycleTransactionRecord {
  let record = parseRecord(cwd, transactionId);
  if (record.status === "committed") return record;
  if (record.status === "rolled_back") return record;
  if (record.status === "prepared") {
    if (!currentMatches(cwd, record.before)) {
      writeStatus(cwd, record, "rolled_back", null);
      throw new LifecycleRecoveryError(`lifecycle transaction '${transactionId}' CAS precondition failed`, transactionId);
    }
    record = writeStatus(cwd, record, "committing", randomUUID());
  } else if (!record.commit_marker) {
    throw new LifecycleRecoveryError(`lifecycle transaction '${transactionId}' is committing without a commit marker`, transactionId);
  }
  applyFiles(cwd, record.after);
  return writeStatus(cwd, record, "committed", record.commit_marker);
}

function recoverOne(cwd: string, record: LifecycleTransactionRecord): LifecycleTransactionRecord {
  if (record.status === "prepared") {
    // A prepared record has not published any authority: commitLifecycleTransaction
    // writes the committing marker before applying the after image. Never restore
    // the before image here; the source may have changed independently while this
    // process was stopped, and recovery must not overwrite an unowned update.
    return writeStatus(cwd, record, "rolled_back", null);
  }
  if (record.status === "committing") {
    if (!record.commit_marker) throw new LifecycleRecoveryError(`lifecycle transaction '${record.transaction_id}' is missing its commit marker`, record.transaction_id);
    // Commit marker exists, so rollback would resurrect old authority. Repair
    // forward and make the final committed marker durable.
    if (!currentMatches(cwd, record.after)) applyFiles(cwd, record.after);
    return writeStatus(cwd, record, "committed", record.commit_marker);
  }
  // A committed transaction is already terminal. Never replay its after image
  // over a newer transaction that legitimately reused one of its paths.
  if (record.status === "committed") return record;
  // A rolled-back transaction is terminal and must never overwrite newer
  // authority that happens to reuse one of its paths.
  return record;
}

/** Recover every transaction under the workspace root; malformed records fail closed. */
export function recoverLifecycleTransactions(cwd: string): LifecycleTransactionRecord[] {
  const root = transactionRoot(cwd);
  if (!existsSync(root)) return [];
  const records: LifecycleTransactionRecord[] = [];
  for (const transactionId of readdirSync(root)) {
    const path = join(root, transactionId);
    try {
      if (!SAFE_SEGMENT.test(transactionId) || !existsSync(path)) throw new LifecycleRecoveryError(`invalid lifecycle transaction directory '${transactionId}'`, transactionId);
      records.push(recoverOne(cwd, parseRecord(cwd, transactionId)));
    } catch (error) {
      if (error instanceof LifecycleRecoveryError) throw error;
      throw new LifecycleRecoveryError(`lifecycle transaction '${transactionId}' recovery failed: ${(error as Error).message}`, transactionId);
    }
  }
  return records;
}

/** Verify that no lifecycle transaction still requires recovery, without mutating it. */
export function assertNoUnresolvedLifecycleTransactions(cwd: string): void {
  const root = transactionRoot(cwd);
  if (!existsSync(root)) return;
  for (const transactionId of readdirSync(root)) {
    if (!SAFE_SEGMENT.test(transactionId)) {
      throw new LifecycleRecoveryError(`invalid lifecycle transaction directory '${transactionId}'`, transactionId);
    }
    const record = parseRecord(cwd, transactionId);
    if (record.status === "prepared" || record.status === "committing") {
      throw new LifecycleRecoveryError(`lifecycle transaction '${transactionId}' requires recovery`, transactionId);
    }
  }
}

export function lifecycleTransactionStatus(cwd: string, transactionId: string): LifecycleTransactionRecord | null {
  const path = recordPath(cwd, transactionId);
  if (!existsSync(path)) return null;
  return parseRecord(cwd, transactionId);
}
