import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { isTrustedFsAuthority, type FsRootDirectory, type PinnedFsRoot, type TrustedFsAuthority } from "./fs-authority.js";
import { parseStrictJsonValue, type StrictJsonLimits } from "./strict-json.js";
import type { CanonicalRoot, WorkflowV2Digest } from "./types.js";

/**
 * The transaction marker is intentionally kept in one internal module.  Its
 * bytes are evidence of an interrupted operation, never authorization to
 * restore a target.
 */
export const TRANSACTION_JOURNAL_NAME = ".workflow-v2.transaction.json" as const;
export const TRANSACTION_MAX_BYTES = 262_144 as const;
export const TRANSACTION_MAX_DEPTH = 8 as const;
export const TRANSACTION_MAX_KEYS = 32 as const;
export const TRANSACTION_MAX_ITEMS = 16 as const;
export const TRANSACTION_MAX_STRING_BYTES = 4_096 as const;
export const TRANSACTION_MAX_PATH_BYTES = 512 as const;
export const TRANSACTION_MAX_IDENTIFIER_BYTES = 256 as const;

const POLICY_PARTS = [".omp", "team.config.json"] as const;
const BINDING_PARTS = [".omp", "team.config.binding.json"] as const;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_RELATIVE_PATH = /^\.workflow-v2\.transaction\.[0-9a-f-]+\.(?:policy|binding)\.bak$/u;
const DECIMAL_PATTERN = /^[0-9]+$/u;

const TRANSACTION_JSON_LIMITS: StrictJsonLimits = Object.freeze({
  maxDepth: TRANSACTION_MAX_DEPTH,
  maxKeys: TRANSACTION_MAX_KEYS,
  maxItems: TRANSACTION_MAX_ITEMS,
  // The parser's input is already capped at TRANSACTION_MAX_BYTES.  Images
  // can be larger than ordinary metadata strings, and are checked again by
  // validJournal before they are decoded.
  maxStringBytes: TRANSACTION_MAX_BYTES,
});

export type TransactionPhase = "prepared" | "policy_written" | "binding_written" | "committed";

export type TargetFingerprint = Readonly<
  | { readonly state: "absent" }
  | {
      readonly state: "present";
      readonly device: string;
      readonly inode: string;
      readonly byte_sha256: WorkflowV2Digest;
      readonly byte_length: number;
    }
>;

type JournalImage = Readonly<
  | { readonly kind: "none" }
  | { readonly kind: "inline"; readonly base64: string }
  | {
      readonly kind: "backup";
      readonly path: string;
      readonly fingerprint: TargetFingerprint;
    }
>;

/** The old target fingerprint plus the bounded image used for rollback. */
export type TransactionOldTarget = Readonly<TargetFingerprint & { readonly image: JournalImage }>;

export type TransactionJournal = Readonly<{
  version: 2;
  transaction_id: string;
  canonical_root: CanonicalRoot;
  policy_path: string;
  binding_path: string;
  phase: TransactionPhase;
  old_policy: TransactionOldTarget;
  old_binding: TransactionOldTarget;
  new_policy: TargetFingerprint;
  new_binding: TargetFingerprint;
}>;

export type TransactionInvalidReason = "unsafe" | "malformed" | "mismatch";

export type TransactionStatus =
  | Readonly<{
      status: "clear";
      path: string;
    }>
  | Readonly<{
      status: "incomplete";
      path: string;
      journal: TransactionJournal;
    }>
  | Readonly<{
      status: "invalid";
      path: string;
      reason: TransactionInvalidReason;
    }>;

/**
 * Opaque capability for management's own journaled transaction reads and
 * writes. It is intentionally not re-exported from the workflow-v2 barrel.
 */
export const TRANSACTION_READ_AUTHORITY: unique symbol = Symbol("workflow-v2.transaction-read-authority");

/** Internal seam used by policy/binding race tests. */
export type TransactionReadHook = (root: CanonicalRoot) => void;

let transactionReadHook: TransactionReadHook | undefined;

export function setTransactionReadHookForTests(hook: TransactionReadHook | undefined): void {
  transactionReadHook = hook;
}

export function runTransactionReadHook(root: CanonicalRoot): void {
  transactionReadHook?.(root);
}

/**
 * A transaction read is allowed with no marker, or with the exact valid v2
 * journal only when management presents the internal read authority.
 */
export function transactionReadAllowed(
  root: CanonicalRoot,
  status: TransactionStatus,
  authority: typeof TRANSACTION_READ_AUTHORITY | undefined,
): boolean {
  if (status.status === "clear") return true;
  if (authority !== TRANSACTION_READ_AUTHORITY || status.status !== "incomplete") return false;
  return status.journal.canonical_root === root
    && status.journal.policy_path === policyPath(root)
    && status.journal.binding_path === bindingPath(root);
}

export function transactionJournalPath(root: CanonicalRoot): string {
  return join(root, TRANSACTION_JOURNAL_NAME);
}

export function policyPath(root: CanonicalRoot): string {
  return join(root, ...POLICY_PARTS);
}

export function bindingPath(root: CanonicalRoot): string {
  return join(root, ...BINDING_PARTS);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(value: unknown, maxBytes: number = TRANSACTION_MAX_STRING_BYTES): value is string {
  return typeof value === "string" && byteLength(value) <= maxBytes;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isDigest(value: unknown): value is WorkflowV2Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isCanonicalBase64(value: unknown, maxEncodedBytes: number): value is string {
  if (!boundedString(value, maxEncodedBytes) || !BASE64_PATTERN.test(value)) return false;
  // Avoid Buffer.from until both the encoded and the expected decoded sizes
  // are known to be bounded.
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedLength = Math.floor(value.length / 4) * 3 - padding;
  if (decodedLength < 0 || decodedLength > TRANSACTION_MAX_BYTES) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function validPresentFingerprint(value: Record<string, unknown>): boolean {
  const length = value.byte_length;
  return value.state === "present"
    && hasExactKeys(value, ["state", "device", "inode", "byte_sha256", "byte_length"])
    && boundedString(value.device, TRANSACTION_MAX_IDENTIFIER_BYTES)
    && boundedString(value.inode, TRANSACTION_MAX_IDENTIFIER_BYTES)
    && DECIMAL_PATTERN.test(value.device)
    && DECIMAL_PATTERN.test(value.inode)
    && isDigest(value.byte_sha256)
    && typeof length === "number"
    && Number.isSafeInteger(length)
    && length >= 0
    && length <= TRANSACTION_MAX_BYTES;
}

function validFingerprint(value: unknown): value is TargetFingerprint {
  if (!record(value)) return false;
  if (value.state === "absent") return hasExactKeys(value, ["state"]);
  return validPresentFingerprint(value);
}

function validImage(value: unknown, target: TargetFingerprint): value is JournalImage {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "none") return hasExactKeys(value, ["kind"]) && target.state === "absent";
  if (value.kind === "inline") {
    if (!hasExactKeys(value, ["kind", "base64"]) || target.state !== "present") return false;
    const maxEncoded = Math.floor((TRANSACTION_MAX_BYTES * 3) / 4);
    if (!isCanonicalBase64(value.base64, maxEncoded)) return false;
    const padding = value.base64.endsWith("==") ? 2 : value.base64.endsWith("=") ? 1 : 0;
    const decodedLength = Math.floor(value.base64.length / 4) * 3 - padding;
    return decodedLength === target.byte_length;
  }
  if (value.kind !== "backup" || target.state !== "present") return false;
  return hasExactKeys(value, ["kind", "path", "fingerprint"])
    && typeof value.path === "string"
    && byteLength(value.path) <= TRANSACTION_MAX_PATH_BYTES
    && SAFE_RELATIVE_PATH.test(value.path)
    && validFingerprint(value.fingerprint)
    && value.fingerprint.state === "present"
    && value.fingerprint.byte_sha256 === target.byte_sha256
    && value.fingerprint.byte_length === target.byte_length;
}

function validOldTarget(value: unknown): value is TransactionOldTarget {
  if (!record(value)) return false;
  if (value.state === "absent") {
    return hasExactKeys(value, ["state", "image"])
      && validImage(value.image, { state: "absent" });
  }
  return validPresentFingerprint(value)
    && hasExactKeys(value, ["state", "device", "inode", "byte_sha256", "byte_length", "image"])
    && validImage(value.image, value as TargetFingerprint);
}

function validPhase(value: unknown): value is TransactionPhase {
  return value === "prepared" || value === "policy_written" || value === "binding_written" || value === "committed";
}


function validJournal(value: unknown, root: CanonicalRoot):
  | { readonly ok: true; readonly journal: TransactionJournal }
  | { readonly ok: false; readonly reason: Exclude<TransactionInvalidReason, "unsafe"> } {
  if (!record(value) || !hasExactKeys(value, [
    "version",
    "transaction_id",
    "canonical_root",
    "policy_path",
    "binding_path",
    "phase",
    "old_policy",
    "old_binding",
    "new_policy",
    "new_binding",
  ])) return { ok: false, reason: "malformed" };
  if (value.version !== 2 || value.canonical_root !== root) return { ok: false, reason: "mismatch" };
  if (
    !boundedString(value.transaction_id, TRANSACTION_MAX_IDENTIFIER_BYTES)
    || !/^[0-9a-f-]{36}$/u.test(value.transaction_id)
    || !boundedString(value.policy_path, TRANSACTION_MAX_PATH_BYTES)
    || !boundedString(value.binding_path, TRANSACTION_MAX_PATH_BYTES)
  ) return { ok: false, reason: "malformed" };
  if (value.policy_path !== policyPath(root) || value.binding_path !== bindingPath(root)) return { ok: false, reason: "mismatch" };
  if (!validPhase(value.phase) || !validOldTarget(value.old_policy) || !validOldTarget(value.old_binding)) {
    return { ok: false, reason: "malformed" };
  }
  if (!validImage(value.old_policy.image, value.old_policy) || !validImage(value.old_binding.image, value.old_binding)) {
    return { ok: false, reason: "malformed" };
  }
  if (!validFingerprint(value.new_policy) || !validFingerprint(value.new_binding)) {
    return { ok: false, reason: "malformed" };
  }
  return {
    ok: true,
    journal: Object.freeze({
      version: 2 as const,
      transaction_id: value.transaction_id,
      canonical_root: root,
      policy_path: value.policy_path,
      binding_path: value.binding_path,
      phase: value.phase,
      old_policy: Object.freeze({ ...value.old_policy, image: Object.freeze({ ...value.old_policy.image }) }) as TransactionOldTarget,
      old_binding: Object.freeze({ ...value.old_binding, image: Object.freeze({ ...value.old_binding.image }) }) as TransactionOldTarget,
      new_policy: Object.freeze({ ...value.new_policy }) as TargetFingerprint,
      new_binding: Object.freeze({ ...value.new_binding }) as TargetFingerprint,
    }),
  };
}


export function parseTransactionStatusBytes(
  root: CanonicalRoot,
  path: string,
  bytes: Uint8Array,
): TransactionStatus {
  if (bytes.byteLength > TRANSACTION_MAX_BYTES) {
    return Object.freeze({ status: "invalid" as const, path, reason: "malformed" as const });
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJsonValue(bytes, TRANSACTION_JSON_LIMITS);
  } catch {
    return Object.freeze({ status: "invalid" as const, path, reason: "malformed" as const });
  }
  const checked = validJournal(parsed, root);
  if (!checked.ok) return Object.freeze({ status: "invalid" as const, path, reason: checked.reason });
  return Object.freeze({ status: "incomplete" as const, path, journal: checked.journal });
}

function readTransactionStatusFromDirectory(
  root: CanonicalRoot,
  path: string,
  directory: { readonly rootDirectory: { readonly fd: number; readonly descriptorPath: string } },
  authority: TrustedFsAuthority | undefined,
): TransactionStatus {
  if (!isTrustedFsAuthority(authority)) return Object.freeze({ status: "invalid" as const, path, reason: "unsafe" as const });
  try {
    const raw = authority.readBounded(directory.rootDirectory, TRANSACTION_JOURNAL_NAME, TRANSACTION_MAX_BYTES);
    if (!raw.ok) return Object.freeze({ status: "invalid" as const, path, reason: raw.reason === "limit" ? "malformed" as const : "unsafe" as const });
    if (raw.value === null) return Object.freeze({ status: "clear" as const, path });
    return parseTransactionStatusBytes(root, path, raw.value.bytes);
  } catch {
    return Object.freeze({ status: "invalid" as const, path, reason: "unsafe" as const });
  }
}

export function readTransactionStatus(root: CanonicalRoot, authority?: TrustedFsAuthority): TransactionStatus {
  const path = transactionJournalPath(root);
  if (!isTrustedFsAuthority(authority)) return Object.freeze({ status: "invalid" as const, path, reason: "unsafe" as const });
  const opened = authority.openRoot(root, { createOmp: false });
  if (opened.ok) {
    try {
      return readTransactionStatusFromDirectory(root, path, opened.value, authority);
    } finally {
      try { opened.value.close(); } catch { /* preserve the typed status */ }
    }
  }
  if (opened.reason === "omp_missing" && authority.openRootDirectory) {
    const rootOnly = authority.openRootDirectory(root);
    if (rootOnly.ok) {
      try {
        return readTransactionStatusFromDirectory(root, path, rootOnly.value, authority);
      } finally {
        try { rootOnly.value.close(); } catch { /* preserve the typed status */ }
      }
    }
  }
  return Object.freeze({ status: "invalid" as const, path, reason: "unsafe" as const });
}

/** Read a transaction marker through the caller's already-pinned root descriptor. */
export function readTransactionStatusFromPinned(
  root: CanonicalRoot,
  pinned: PinnedFsRoot,
  authority?: TrustedFsAuthority,
): TransactionStatus {
  const path = transactionJournalPath(root);
  if (!isTrustedFsAuthority(authority)) return Object.freeze({ status: "invalid" as const, path, reason: "unsafe" as const });
  return readTransactionStatusFromDirectory(root, path, pinned, authority);
}

/** Read a transaction marker through a root-only descriptor when .omp is absent. */
export function readTransactionStatusFromRoot(
  root: CanonicalRoot,
  pinned: FsRootDirectory,
  authority?: TrustedFsAuthority,
): TransactionStatus {
  const path = transactionJournalPath(root);
  if (!isTrustedFsAuthority(authority)) return Object.freeze({ status: "invalid" as const, path, reason: "unsafe" as const });
  return readTransactionStatusFromDirectory(root, path, pinned, authority);
}


/** Stable canonical JSON for the witness digest, without importing policy.ts. */
function canonicalWitnessJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalWitnessJson).join(",")}]`;
  if (!record(value)) throw new TypeError("invalid witness JSON");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalWitnessJson(value[key])}`).join(",")}}`;
}

export function transactionJournalDigest(journal: TransactionJournal): WorkflowV2Digest {
  return `sha256:${createHash("sha256").update(canonicalWitnessJson(journal), "utf8").digest("hex")}`;
}

export type TransactionWitnessBinding = Readonly<{
  canonical_root: CanonicalRoot;
  proposal_digest: WorkflowV2Digest;
  worktree_id: WorkflowV2Digest;
  session_id: string;
  lifecycle_id: string;
  old_policy: TargetFingerprint;
  old_binding: TargetFingerprint;
  new_policy: TargetFingerprint;
  new_binding: TargetFingerprint;
  lock_token: object;
}>;

export type TransactionWitness = object;

type WitnessState = TransactionWitnessBinding & Readonly<{
  transaction_id: string;
  phase: TransactionPhase;
  journal_digest: WorkflowV2Digest | null;
}>;

const witnessesByRootAndId = new Map<string, WitnessState>();
const witnessTokens = new WeakMap<object, WitnessState>();

function witnessKey(root: CanonicalRoot, transactionId: string): string {
  return `${root}\u0000${transactionId}`;
}

function sameFingerprint(left: TargetFingerprint, right: TargetFingerprint): boolean {
  if (left.state !== right.state) return false;
  return left.state === "absent"
    ? true
    : right.state === "present"
      && left.device === right.device
      && left.inode === right.inode
      && left.byte_sha256 === right.byte_sha256
      && left.byte_length === right.byte_length;
}

/** Issue an opaque same-process witness. The token carries no authority by itself. */
export function beginTransactionWitness(binding: TransactionWitnessBinding): Readonly<{
  transaction_id: string;
  witness: TransactionWitness;
}> {
  const transactionId = randomUUID();
  const token = Object.freeze({});
  const state: WitnessState = Object.freeze({
    ...binding,
    transaction_id: transactionId,
    phase: "prepared" as const,
    journal_digest: null,
  });
  witnessesByRootAndId.set(witnessKey(binding.canonical_root, transactionId), state);
  witnessTokens.set(token, state);
  return Object.freeze({ transaction_id: transactionId, witness: token });
}

function stateFor(witness: TransactionWitness): WitnessState | undefined {
  if (typeof witness !== "object" || witness === null) return undefined;
  const state = witnessTokens.get(witness);
  if (!state) return undefined;
  return witnessesByRootAndId.get(witnessKey(state.canonical_root, state.transaction_id)) === state
    ? state
    : undefined;
}

export function bindTransactionWitnessJournal(witness: TransactionWitness, journal: TransactionJournal): boolean {
  const previous = stateFor(witness);
  if (!previous || journal.transaction_id !== previous.transaction_id || journal.canonical_root !== previous.canonical_root) return false;
  if (
    !sameFingerprint(journal.old_policy, previous.old_policy)
    || !sameFingerprint(journal.old_binding, previous.old_binding)
    || journal.phase !== "prepared"
  ) return false;
  const next = Object.freeze({ ...previous, phase: journal.phase, journal_digest: transactionJournalDigest(journal) });
  witnessesByRootAndId.set(witnessKey(previous.canonical_root, previous.transaction_id), next);
  witnessTokens.set(witness, next);
  return true;
}

function transitionTargetsValid(previous: WitnessState, journal: TransactionJournal): boolean {
  if (!sameFingerprint(journal.old_policy, previous.old_policy) || !sameFingerprint(journal.old_binding, previous.old_binding)) return false;
  if (journal.phase === "policy_written") {
    return journal.new_policy.state === "present" && sameFingerprint(journal.new_binding, previous.old_binding);
  }
  if (journal.phase === "binding_written" || journal.phase === "committed") {
    return journal.new_policy.state === "present" && journal.new_binding.state === "present";
  }
  return false;
}

export function advanceTransactionWitness(witness: TransactionWitness, journal: TransactionJournal): boolean {
  const previous = stateFor(witness);
  if (!previous || journal.transaction_id !== previous.transaction_id || journal.canonical_root !== previous.canonical_root) return false;
  const expectedNext: Readonly<Record<TransactionPhase, TransactionPhase | null>> = {
    prepared: "policy_written",
    policy_written: "binding_written",
    binding_written: "committed",
    committed: null,
  };
  if (expectedNext[previous.phase] !== journal.phase || !transitionTargetsValid(previous, journal)) return false;
  const next = Object.freeze({
    ...previous,
    phase: journal.phase,
    new_policy: journal.new_policy,
    new_binding: journal.new_binding,
    journal_digest: transactionJournalDigest(journal),
  });
  witnessesByRootAndId.set(witnessKey(previous.canonical_root, previous.transaction_id), next);
  witnessTokens.set(witness, next);
  return true;
}

export function transactionWitnessValid(
  witness: TransactionWitness,
  journal: TransactionJournal,
  binding: Omit<TransactionWitnessBinding, "lock_token"> & { readonly lock_token: object },
): boolean {
  const state = stateFor(witness);
  return !!state
    && state.transaction_id === journal.transaction_id
    && state.canonical_root === journal.canonical_root
    && state.canonical_root === binding.canonical_root
    && state.proposal_digest === binding.proposal_digest
    && state.worktree_id === binding.worktree_id
    && state.session_id === binding.session_id
    && state.lifecycle_id === binding.lifecycle_id
    && state.lock_token === binding.lock_token
    && state.phase === journal.phase
    && state.journal_digest === transactionJournalDigest(journal)
    && sameFingerprint(state.old_policy, journal.old_policy)
    && sameFingerprint(state.old_binding, journal.old_binding)
    && sameFingerprint(state.new_policy, journal.new_policy)
    && sameFingerprint(state.new_binding, journal.new_binding);
}

export function forgetTransactionWitness(witness: TransactionWitness): void {
  const state = stateFor(witness);
  if (!state) return;
  witnessesByRootAndId.delete(witnessKey(state.canonical_root, state.transaction_id));
  witnessTokens.delete(witness);
}

/** Test-only crash simulation; not exported from the workflow-v2 barrel. */
export function clearTransactionWitnessesForTests(): void {
  witnessesByRootAndId.clear();
}
