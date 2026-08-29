/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

import { createHash } from "node:crypto";
import {
  createDiagnostic,
  isCanonicalRoot,
  isTrustedFsAuthority,
  validateWorkflowRunIdentity,
  type CanonicalRoot,
  type DiagnosticResult,
  type StorageTreeEntry,
  type StorageTreeLimits,
  type StorageTreePublishResult,
  type TrustedFsAuthority,
  type WorkflowRunIdentity,
  type WorkflowV2Digest,
} from "@andvl1/omp-workflows-core";

export type { StorageTreeEntry, StorageTreeLimits, StorageTreePublishResult };

/** A bounded, instance-bound storage failure. */
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

/** One file returned by a bounded directory listing. */
export interface StorageEntry {
  readonly name: string;
  readonly relative_path: string;
}

/** Bounded descriptor metadata used by report/runtime consumers. */
export interface StorageStat {
  readonly exists: boolean;
  readonly kind: "missing" | "file" | "directory";
  readonly size_bytes: number;
  readonly mtime_ms: number;
}

/** Opaque lease proof returned by a successful instance-bound lease acquire. */
export interface StorageLease {
  readonly relative_path: string;
  readonly run_identity: WorkflowRunIdentity;
  readonly lease_id: string;
}

/**
 * Phase-3 host implementation seam.  The implementation must already be
 * descriptor-relative and pinned to the supplied root/run; this package never
 * fabricates a pathname-backed production implementation.
 */
export interface FullstackStorageNativeBackend {
  readonly canonical_root: CanonicalRoot;
  readonly run_identity: WorkflowRunIdentity;
  readonly readBounded: (relativePath: string, maxBytes: number) => StorageResult<Uint8Array | null>;
  readonly readTextBounded: (relativePath: string, maxBytes: number) => StorageResult<string | null>;
  readonly statBounded: (relativePath: string) => StorageResult<StorageStat>;
  readonly writeExclusive: (relativePath: string, bytes: Uint8Array, mode?: number) => StorageResult<void>;
  readonly writeAtomic: (relativePath: string, bytes: Uint8Array, maxBytes: number) => StorageResult<void>;
  readonly appendJsonLineBounded: (relativePath: string, bytes: Uint8Array, maxBytes: number) => StorageResult<void>;
  readonly listBounded: (relativeDirectory: string, maxEntries: number) => StorageResult<readonly StorageEntry[]>;
  readonly moveExclusive: (sourceRelativePath: string, targetRelativePath: string) => StorageResult<void>;
  readonly removeIfOwned: (relativePath: string, identity: WorkflowRunIdentity) => StorageResult<boolean>;
  readonly acquireLease: (relativePath: string, identity: WorkflowRunIdentity) => StorageResult<StorageLease>;
  readonly releaseLease: (relativePath: string, identity: WorkflowRunIdentity) => StorageResult<void>;
  /** Optional phase-3 whole-tree atomic replacement primitive. */
  readonly replaceTreeAtomic?: (
    relativeRoot: string,
    entries: readonly StorageTreeEntry[],
    limits: StorageTreeLimits,
  ) => StorageResult<StorageTreePublishResult>;
}

const fullstackStorageAuthorityBrand: unique symbol = Symbol("fullstackStorageAuthorityBrand");

/**
 * Pinned/bounded capability consumed by runtime, adapters, bridge and
 * scheduler code.  It contains no path-discovery or cwd fallback operation.
 */
export interface FullstackStorageAuthority {
  readonly [fullstackStorageAuthorityBrand]: "FullstackStorageAuthority";
  readonly project_root: CanonicalRoot;
  readonly run_identity: WorkflowRunIdentity;
  readBounded(relativePath: string, maxBytes: number): StorageResult<Uint8Array | null>;
  readTextBounded(relativePath: string, maxBytes: number): StorageResult<string | null>;
  readJsonBounded(relativePath: string, maxBytes: number, maxDepth: number): StorageResult<unknown | null>;
  statBounded(relativePath: string): StorageResult<StorageStat>;
  writeExclusive(relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void>;
  writeAtomic(relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void>;
  writeJsonExclusive(relativePath: string, bytes: Uint8Array, mode?: number): StorageResult<void>;
  appendJsonLineBounded(relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void>;
  listBounded(relativeDirectory: string, maxEntries: number): StorageResult<readonly StorageEntry[]>;
  listJsonBounded(relativeDirectory: string, maxEntries: number): StorageResult<readonly StorageEntry[]>;
  moveExclusive(sourceRelativePath: string, targetRelativePath: string): StorageResult<void>;
  removeIfOwned(relativePath: string, identity: WorkflowRunIdentity): StorageResult<boolean>;
  acquireLease(relativePath: string, identity: WorkflowRunIdentity): StorageResult<StorageLease>;
  releaseLease(relativePath: string, identity: WorkflowRunIdentity): StorageResult<void>;
}

/** Fullstack authority with the optional whole-tree publication capability. */
export interface FullstackTreeStorageAuthority extends FullstackStorageAuthority {
  readonly replaceTreeAtomic: (
    relativeRoot: string,
    entries: readonly StorageTreeEntry[],
    limits: StorageTreeLimits,
  ) => StorageResult<StorageTreePublishResult>;
}


export interface FullstackStorageAuthorityOptions {
  readonly project_root: CanonicalRoot;
  readonly run_identity: WorkflowRunIdentity;
  /** Launcher-issued proof.  A branded object without a usable backend is insufficient. */
  readonly filesystem_authority?: TrustedFsAuthority;
  /** Phase-3 descriptor-relative implementation; omitted in phase 2. */
  readonly native?: FullstackStorageNativeBackend;
}

export interface ChannelEndpointPolicy {
  readonly url?: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeout_ms?: number;
  readonly max_body_bytes?: number;
}

export interface ChannelAdmissionInput {
  readonly project_root: CanonicalRoot;
  readonly run_identity: WorkflowRunIdentity;
  readonly channels: readonly Readonly<Record<string, unknown>>[];
  /** Digest of canonical JSON `channels`; supplied by the manager. */
  readonly config_digest: WorkflowV2Digest;
  /** Immutable endpoint policy selected by the manager, keyed by channel id/adapter. */
  readonly endpoint_policy: Readonly<Record<string, ChannelEndpointPolicy>>;
  readonly allowed_chat_ids: readonly string[];
  readonly allowed_sender_ids: readonly string[];
  /** Authenticated private 1:1 proof may replace a non-empty sender list. */
  readonly private_one_to_one?: Readonly<{ chat_id: string; authenticated: true }>;
}

const channelAdmissionBrand: unique symbol = Symbol("channelAdmissionBrand");

/** Opaque manager-issued channel configuration and authorization proof. */
export interface ChannelAdmission extends ChannelAdmissionInput {
  readonly [channelAdmissionBrand]: "ChannelAdmission";
}

const issuedChannelAdmissions = new WeakSet<object>();

const issuedAuthorities = new WeakSet<object>();
const issuedTreeAuthorities = new WeakSet<object>();
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_APPEND_BYTES = 16 * 1024 * 1024;
const MAX_PATH_LENGTH = 1_024;
const MAX_COMPONENT_LENGTH = 255;
const MAX_JSON_DEPTH = 128;
const MAX_DIRECTORY_ENTRIES = 4_096;
const MAX_TREE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TREE_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_FILE_MODE = 0o600;
const MAX_CHANNELS = 16;
const MAX_ENDPOINT_POLICIES = 16;
const MAX_CHANNEL_ADMISSION_BYTES = 1024 * 1024;
const MAX_CHANNEL_CONFIG_DEPTH = 32;
const MAX_CHANNEL_ADMISSION_NODES = 256;
const MAX_CHANNEL_ENTRY_KEYS = 16;
const MAX_ENDPOINT_POLICY_KEYS = 5;
const MAX_ADMISSION_RECORD_KEYS = 64;
const MAX_ADMISSION_ARRAY_LENGTH = 64;
const MAX_ADMISSION_KEY_LENGTH = 128;
const MAX_CHANNEL_STRING_LENGTH = 512;
const MAX_CHANNEL_URL_LENGTH = 2_048;
const MAX_ALLOWLIST_ID_LENGTH = 128;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_BYTES = 4 * 1024;
const MIN_CHANNEL_TIMEOUT_MS = 100;
const MAX_CHANNEL_TIMEOUT_MS = 60_000;
const MAX_CHANNEL_BODY_BYTES = 1024 * 1024;

const CHANNEL_ENTRY_KEYS = [
  "id",
  "adapter",
  "direction",
  "primary",
  "persisted",
  "dir",
  "token",
  "chatId",
  "pollIntervalMs",
  "url",
  "method",
  "headers",
  "ackTarget",
  "subscriptions",
] as const;
const ENDPOINT_POLICY_KEYS = ["url", "method", "headers", "timeout_ms", "max_body_bytes"] as const;
const PRIVATE_PROOF_KEYS = ["chat_id", "authenticated"] as const;
const ADMISSION_INPUT_KEYS = [
  "project_root",
  "run_identity",
  "channels",
  "config_digest",
  "endpoint_policy",
  "allowed_chat_ids",
  "allowed_sender_ids",
  "private_one_to_one",
] as const;
const FORBIDDEN_ADMISSION_KEYS = Object.freeze({
  ["__proto__"]: true,
  prototype: true,
  constructor: true,
} satisfies Record<"__proto__" | "prototype" | "constructor", true>);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u;
const CONFIG_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const UTF8_ENCODER = new TextEncoder();

interface ChannelAdmissionPreflightState {
  readonly active: Set<object>;
  bytes: number;
  depth: number;
  nodes: number;
}

interface ChannelAdmissionPreflightIssue {
  readonly field: string;
  readonly remediation: string;
}

interface OwnAdmissionEntry {
  readonly key: string;
  readonly value: unknown;
}

interface ChannelPreflightSuccess {
  readonly ok: true;
  readonly hasReadWrite: boolean;
}

interface ChannelPreflightFailure {
  readonly ok: false;
  readonly issue: ChannelAdmissionPreflightIssue;
}

type ChannelPreflightResult = ChannelPreflightSuccess | ChannelPreflightFailure;

function preflightIssue(field: string, remediation: string): ChannelAdmissionPreflightIssue {
  return { field, remediation };
}

function isPlainAdmissionRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readAdmissionRecordEntries(
  value: unknown,
  field: string,
  maxKeys: number,
): OwnAdmissionEntry[] | ChannelAdmissionPreflightIssue {
  if (!isPlainAdmissionRecord(value)) {
    return preflightIssue(field, "Use a plain JSON object for the manager-issued channel admission.");
  }
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return preflightIssue(field, "Use a readable plain JSON object for the manager-issued channel admission.");
  }
  if (keys.length > Math.min(maxKeys, MAX_ADMISSION_RECORD_KEYS)) {
    return preflightIssue(field, "Keep manager-issued channel admission objects within their bounded key count.");
  }
  const entries: OwnAdmissionEntry[] = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      return preflightIssue(field, "Channel admission records must not contain symbol keys.");
    }
    if (key.length === 0 || key.length > MAX_ADMISSION_KEY_LENGTH) {
      return preflightIssue(field, "Keep channel admission object keys non-empty and at most 128 characters.");
    }
    if (Object.hasOwn(FORBIDDEN_ADMISSION_KEYS, key)) {
      return preflightIssue(`${field}.${key}`, "Remove prototype-bearing keys from channel admission records.");
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return preflightIssue(field, "Use readable data properties in channel admission records.");
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return preflightIssue(`${field}.${key}`, "Channel admission records must contain enumerable data properties only.");
    }
    entries.push({ key, value: descriptor.value });
  }
  return entries;
}

function arrayIndexForKey(key: string, length: number): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key ? index : undefined;
}

function inspectDenseAdmissionArray(
  value: unknown,
  field: string,
  maxLength: number,
  visit: (entry: unknown, index: number) => ChannelAdmissionPreflightIssue | undefined,
): ChannelAdmissionPreflightIssue | undefined {
  if (!Array.isArray(value)) return preflightIssue(field, "Provide a bounded dense JSON array for channel admission data.");
  let length: number;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return preflightIssue(field, "Channel admission arrays must use the native array prototype.");
    }
    length = value.length;
  } catch {
    return preflightIssue(field, "Provide a readable bounded channel admission array.");
  }
  if (!Number.isSafeInteger(length) || length > maxLength) {
    return preflightIssue(field, "Keep channel admission arrays within their bounded length.");
  }
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return preflightIssue(field, "Provide a readable dense channel admission array.");
  }
  if (keys.length > maxLength + 1) {
    return preflightIssue(field, "Channel admission arrays must not carry extra properties.");
  }
  for (const key of keys) {
    if (key === "length") {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        return preflightIssue(field, "Use a readable dense channel admission array.");
      }
      if (!descriptor || descriptor.enumerable || !("value" in descriptor) || descriptor.value !== length) {
        return preflightIssue(field, "Channel admission arrays must expose only their native length property.");
      }
      continue;
    }
    if (typeof key !== "string") return preflightIssue(field, "Channel admission arrays must not contain symbol properties.");
    if (key.length > MAX_ADMISSION_KEY_LENGTH) return preflightIssue(field, "Channel admission arrays must not carry oversized properties.");
    if (arrayIndexForKey(key, length) === undefined) {
      return preflightIssue(`${field}.${key}`, "Channel admission arrays must contain only dense numeric indexes.");
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return preflightIssue(field, "Use readable data properties in channel admission arrays.");
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return preflightIssue(`${field}.${key}`, "Channel admission arrays must contain enumerable data properties only.");
    }
  }
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      return preflightIssue(`${field}[${index}]`, "Use readable data properties in channel admission arrays.");
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return preflightIssue(`${field}[${index}]`, "Channel admission arrays must not be sparse or accessor-backed.");
    }
    const issue = visit(descriptor.value, index);
    if (issue) return issue;
  }
  return undefined;
}

function beginAdmissionNode(
  value: object,
  field: string,
  state: ChannelAdmissionPreflightState,
): ChannelAdmissionPreflightIssue | undefined {
  if (state.active.has(value)) return preflightIssue(field, "Channel admission data must be acyclic.");
  if (state.depth >= MAX_CHANNEL_CONFIG_DEPTH) {
    return preflightIssue(field, "Channel admission data exceeds the maximum nesting depth.");
  }
  state.nodes += 1;
  if (state.nodes > MAX_CHANNEL_ADMISSION_NODES) {
    return preflightIssue(field, "Channel admission data exceeds the bounded object count.");
  }
  state.active.add(value);
  state.depth += 1;
  return undefined;
}

function leaveAdmissionNode(value: object, state: ChannelAdmissionPreflightState): void {
  state.active.delete(value);
  state.depth -= 1;
}

function accountAdmissionBytes(
  state: ChannelAdmissionPreflightState,
  bytes: number,
  field: string,
): ChannelAdmissionPreflightIssue | undefined {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || state.bytes > MAX_CHANNEL_ADMISSION_BYTES - bytes) {
    return preflightIssue(field, "Keep the complete channel admission below the 1 MiB UTF-8 budget.");
  }
  state.bytes += bytes;
  return undefined;
}

function accountAsciiBytes(
  state: ChannelAdmissionPreflightState,
  value: string,
  field: string,
): ChannelAdmissionPreflightIssue | undefined {
  return accountAdmissionBytes(state, value.length, field);
}

function validAdmissionUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code >= 0xdc00 || index + 1 >= value.length) return false;
    const next = value.charCodeAt(index + 1);
    if (next < 0xdc00 || next > 0xdfff) return false;
    index += 1;
  }
  return true;
}

function admissionJsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20) {
      bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function accountAdmissionString(
  value: unknown,
  field: string,
  state: ChannelAdmissionPreflightState,
  maxLength: number,
  nonEmpty = true,
  maxBytes?: number,
): ChannelAdmissionPreflightIssue | undefined {
  if (typeof value !== "string") return preflightIssue(field, "Use a JSON string in channel admission data.");
  if ((nonEmpty && value.length === 0) || value.length > maxLength) {
    return preflightIssue(field, "Keep channel admission strings non-empty and within their declared bound.");
  }
  if (!validAdmissionUnicode(value)) return preflightIssue(field, "Use well-formed Unicode in channel admission strings.");
  const rawBytes = UTF8_ENCODER.encode(value).byteLength;
  if (maxBytes !== undefined && rawBytes > maxBytes) {
    return preflightIssue(field, "Keep channel admission string values within their byte bound.");
  }
  return accountAdmissionBytes(state, admissionJsonStringBytes(value), field);
}

function accountAdmissionBoolean(
  value: unknown,
  field: string,
  state: ChannelAdmissionPreflightState,
  expected?: true,
): ChannelAdmissionPreflightIssue | undefined {
  if (typeof value !== "boolean" || (expected === true && value !== true)) {
    return preflightIssue(field, "Use the required boolean value in channel admission data.");
  }
  return accountAsciiBytes(state, value ? "true" : "false", field);
}

function accountAdmissionNumber(
  value: unknown,
  field: string,
  state: ChannelAdmissionPreflightState,
  min: number,
  max: number,
): ChannelAdmissionPreflightIssue | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return preflightIssue(field, "Use a finite safe integer within the channel admission bound.");
  }
  return accountAsciiBytes(state, String(value), field);
}


function isAllowedAdmissionKey(key: string, allowed: readonly string[]): boolean {
  return allowed.includes(key);
}

function preflightHeaders(
  value: unknown,
  field: string,
  state: ChannelAdmissionPreflightState,
): ChannelAdmissionPreflightIssue | undefined {
  const entries = readAdmissionRecordEntries(value, field, MAX_HEADER_COUNT);
  if (!Array.isArray(entries)) return entries;
  const beginIssue = beginAdmissionNode(value as object, field, state);
  if (beginIssue) return beginIssue;
  try {
    let issue = accountAsciiBytes(state, "{", field);
    if (issue) return issue;
    const seen = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (!HEADER_NAME_PATTERN.test(entry.key) || !CONFIG_KEY_PATTERN.test(entry.key)) {
        return preflightIssue(`${field}.${entry.key}`, "Use safe bounded HTTP header names.");
      }
      const lower = entry.key.toLowerCase();
      if (seen.has(lower)) return preflightIssue(`${field}.${entry.key}`, "Do not duplicate HTTP header names with different casing.");
      seen.add(lower);
      issue = accountAsciiBytes(state, index === 0 ? "" : ",", field);
      if (issue) return issue;
      issue = accountAdmissionString(entry.key, `${field}.${entry.key}`, state, MAX_HEADER_NAME_LENGTH);
      if (issue) return issue;
      issue = accountAsciiBytes(state, ":", field);
      if (issue) return issue;
      if (typeof entry.value === "string" && /[\r\n]/u.test(entry.value)) {
        return preflightIssue(`${field}.${entry.key}`, "HTTP header values must not contain CR/LF.");
      }
      issue = accountAdmissionString(entry.value, `${field}.${entry.key}`, state, MAX_HEADER_VALUE_BYTES, false, MAX_HEADER_VALUE_BYTES);
      if (issue) return issue;
    }
    return accountAsciiBytes(state, "}", field);
  } finally {
    leaveAdmissionNode(value as object, state);
  }
}

function preflightStringArray(
  value: unknown,
  field: string,
  state: ChannelAdmissionPreflightState,
  maxLength: number,
  itemMaxLength: number,
  nonEmptyItems: boolean,
): ChannelAdmissionPreflightIssue | undefined {
  if (!Array.isArray(value)) return preflightIssue(field, "Provide a bounded dense JSON string array.");
  let length: number;
  try {
    length = value.length;
  } catch {
    return preflightIssue(field, "Provide a readable bounded channel admission array.");
  }
  const beginIssue = beginAdmissionNode(value, field, state);
  if (beginIssue) return beginIssue;
  try {
    let issue = accountAsciiBytes(state, "[", field);
    if (issue) return issue;
    issue = inspectDenseAdmissionArray(value, field, maxLength, (entry, index) => {
      const itemIssue = accountAdmissionString(entry, `${field}[${index}]`, state, itemMaxLength, nonEmptyItems);
      if (itemIssue) return itemIssue;
      return accountAsciiBytes(state, index === length - 1 ? "" : ",", field);
    });
    if (issue) return issue;
    return accountAsciiBytes(state, "]", field);
  } finally {
    leaveAdmissionNode(value, state);
  }
}

function preflightChannelEntry(
  value: unknown,
  index: number,
  state: ChannelAdmissionPreflightState,
): ChannelPreflightResult {
  const field = `channels[${index}]`;
  const entries = readAdmissionRecordEntries(value, field, MAX_CHANNEL_ENTRY_KEYS);
  if (!Array.isArray(entries)) return { ok: false, issue: entries };
  const beginIssue = beginAdmissionNode(value as object, field, state);
  if (beginIssue) return { ok: false, issue: beginIssue };
  try {
    let issue = accountAsciiBytes(state, "{", field);
    if (issue) return { ok: false, issue };
    let adapterPresent = false;
    let directionPresent = false;
    let hasReadWrite = false;
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex]!;
      if (!isAllowedAdmissionKey(entry.key, CHANNEL_ENTRY_KEYS)) {
        return { ok: false, issue: preflightIssue(`${field}.${entry.key}`, "Remove unknown channel entry fields.") };
      }
      issue = accountAsciiBytes(state, entryIndex === 0 ? "" : ",", field);
      if (issue) return { ok: false, issue };
      issue = accountAdmissionString(entry.key, `${field}.${entry.key}`, state, MAX_ADMISSION_KEY_LENGTH);
      if (issue) return { ok: false, issue };
      issue = accountAsciiBytes(state, ":", field);
      if (issue) return { ok: false, issue };
      switch (entry.key) {
        case "adapter":
          adapterPresent = true;
          issue = accountAdmissionString(entry.value, `${field}.adapter`, state, MAX_CHANNEL_STRING_LENGTH);
          break;
        case "direction":
          directionPresent = true;
          if (entry.value !== "read-write" && entry.value !== "read-only") {
            return { ok: false, issue: preflightIssue(`${field}.direction`, "Use an explicit read-write or read-only channel direction.") };
          }
          hasReadWrite = entry.value === "read-write";
          issue = accountAdmissionString(entry.value, `${field}.direction`, state, MAX_CHANNEL_STRING_LENGTH);
          break;
        case "id":
        case "dir":
        case "token":
        case "chatId":
        case "ackTarget":
          issue = accountAdmissionString(entry.value, `${field}.${entry.key}`, state, MAX_CHANNEL_STRING_LENGTH);
          break;
        case "url":
          issue = accountAdmissionString(entry.value, `${field}.url`, state, MAX_CHANNEL_URL_LENGTH);
          break;
        case "method":
          issue = accountAdmissionString(entry.value, `${field}.method`, state, MAX_CHANNEL_STRING_LENGTH);
          break;
        case "primary":
        case "persisted":
          issue = accountAdmissionBoolean(entry.value, `${field}.${entry.key}`, state);
          break;
        case "pollIntervalMs":
          issue = accountAdmissionNumber(entry.value, `${field}.pollIntervalMs`, state, 0, MAX_CHANNEL_TIMEOUT_MS);
          break;
        case "headers":
          issue = preflightHeaders(entry.value, `${field}.headers`, state);
          break;
        case "subscriptions":
          issue = preflightStringArray(entry.value, `${field}.subscriptions`, state, MAX_ADMISSION_ARRAY_LENGTH, MAX_CHANNEL_STRING_LENGTH, false);
          break;
        default:
          return { ok: false, issue: preflightIssue(`${field}.${entry.key}`, "Remove unknown channel entry fields.") };
      }
      if (issue) return { ok: false, issue };
    }
    if (!adapterPresent) return { ok: false, issue: preflightIssue(`${field}.adapter`, "Each admitted channel needs an adapter.") };
    if (!directionPresent) return { ok: false, issue: preflightIssue(`${field}.direction`, "Each admitted channel needs an explicit direction.") };
    issue = accountAsciiBytes(state, "}", field);
    return issue ? { ok: false, issue } : { ok: true, hasReadWrite };
  } finally {
    leaveAdmissionNode(value as object, state);
  }
}

function preflightChannels(
  value: unknown,
  state: ChannelAdmissionPreflightState,
  requireNonEmpty = true,
): ChannelPreflightResult {
  if (!Array.isArray(value)) return { ok: false, issue: preflightIssue("channels", "Provide a bounded non-empty channels[] admission.") };
  let length: number;
  try {
    length = value.length;
  } catch {
    return { ok: false, issue: preflightIssue("channels", "Provide a readable bounded channels[] admission.") };
  }
  if (requireNonEmpty && length === 0) return { ok: false, issue: preflightIssue("channels", "Provide a bounded non-empty channels[] admission.") };
  const beginIssue = beginAdmissionNode(value, "channels", state);
  if (beginIssue) return { ok: false, issue: beginIssue };
  try {
    let issue = accountAsciiBytes(state, "[", "channels");
    if (issue) return { ok: false, issue };
    let hasReadWrite = false;
    issue = inspectDenseAdmissionArray(value, "channels", MAX_CHANNELS, (entry, index) => {
      const result = preflightChannelEntry(entry, index, state);
      if (!result.ok) return result.issue;
      hasReadWrite = hasReadWrite || result.hasReadWrite;
      return accountAsciiBytes(state, index === length - 1 ? "" : ",", "channels");
    });
    if (issue) return { ok: false, issue };
    issue = accountAsciiBytes(state, "]", "channels");
    return issue ? { ok: false, issue } : { ok: true, hasReadWrite };
  } finally {
    leaveAdmissionNode(value, state);
  }
}

function preflightEndpointPolicy(
  value: unknown,
  field: string,
  state: ChannelAdmissionPreflightState,
): ChannelAdmissionPreflightIssue | undefined {
  const entries = readAdmissionRecordEntries(value, field, MAX_ENDPOINT_POLICY_KEYS);
  if (!Array.isArray(entries)) return entries;
  const beginIssue = beginAdmissionNode(value as object, field, state);
  if (beginIssue) return beginIssue;
  try {
    let issue = accountAsciiBytes(state, "{", field);
    if (issue) return issue;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (!isAllowedAdmissionKey(entry.key, ENDPOINT_POLICY_KEYS)) {
        return preflightIssue(`${field}.${entry.key}`, "Remove unknown endpoint policy fields.");
      }
      issue = accountAsciiBytes(state, index === 0 ? "" : ",", field);
      if (issue) return issue;
      issue = accountAdmissionString(entry.key, `${field}.${entry.key}`, state, MAX_ADMISSION_KEY_LENGTH);
      if (issue) return issue;
      issue = accountAsciiBytes(state, ":", field);
      if (issue) return issue;
      switch (entry.key) {
        case "url":
          issue = accountAdmissionString(entry.value, `${field}.url`, state, MAX_CHANNEL_URL_LENGTH);
          break;
        case "method":
          issue = accountAdmissionString(entry.value, `${field}.method`, state, MAX_CHANNEL_STRING_LENGTH);
          break;
        case "headers":
          issue = preflightHeaders(entry.value, `${field}.headers`, state);
          break;
        case "timeout_ms":
          issue = accountAdmissionNumber(entry.value, `${field}.timeout_ms`, state, MIN_CHANNEL_TIMEOUT_MS, MAX_CHANNEL_TIMEOUT_MS);
          break;
        case "max_body_bytes":
          issue = accountAdmissionNumber(entry.value, `${field}.max_body_bytes`, state, 1, MAX_CHANNEL_BODY_BYTES);
          break;
        default:
          return preflightIssue(`${field}.${entry.key}`, "Remove unknown endpoint policy fields.");
      }
      if (issue) return issue;
    }
    return accountAsciiBytes(state, "}", field);
  } finally {
    leaveAdmissionNode(value as object, state);
  }
}

function preflightEndpointPolicies(
  value: unknown,
  state: ChannelAdmissionPreflightState,
): ChannelAdmissionPreflightIssue | undefined {
  const entries = readAdmissionRecordEntries(value, "endpoint_policy", MAX_ENDPOINT_POLICIES);
  if (!Array.isArray(entries)) return entries;
  const beginIssue = beginAdmissionNode(value as object, "endpoint_policy", state);
  if (beginIssue) return beginIssue;
  try {
    let issue = accountAsciiBytes(state, "{", "endpoint_policy");
    if (issue) return issue;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (!CONFIG_KEY_PATTERN.test(entry.key) || Object.hasOwn(FORBIDDEN_ADMISSION_KEYS, entry.key)) {
        return preflightIssue(`endpoint_policy.${entry.key}`, "Use safe bounded endpoint policy keys.");
      }
      issue = accountAsciiBytes(state, index === 0 ? "" : ",", "endpoint_policy");
      if (issue) return issue;
      issue = accountAdmissionString(entry.key, `endpoint_policy.${entry.key}`, state, MAX_ADMISSION_KEY_LENGTH);
      if (issue) return issue;
      issue = accountAsciiBytes(state, ":", "endpoint_policy");
      if (issue) return issue;
      issue = preflightEndpointPolicy(entry.value, `endpoint_policy.${entry.key}`, state);
      if (issue) return issue;
    }
    return accountAsciiBytes(state, "}", "endpoint_policy");
  } finally {
    leaveAdmissionNode(value as object, state);
  }
}

function preflightPrivateProof(
  value: unknown,
  state: ChannelAdmissionPreflightState,
): ChannelAdmissionPreflightIssue | undefined {
  if (value === undefined) return undefined;
  const field = "private_one_to_one";
  const entries = readAdmissionRecordEntries(value, field, PRIVATE_PROOF_KEYS.length);
  if (!Array.isArray(entries)) return entries;
  const beginIssue = beginAdmissionNode(value as object, field, state);
  if (beginIssue) return beginIssue;
  try {
    let issue = accountAsciiBytes(state, "{", field);
    if (issue) return issue;
    let chatIdPresent = false;
    let authenticatedPresent = false;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (!isAllowedAdmissionKey(entry.key, PRIVATE_PROOF_KEYS)) {
        return preflightIssue(`${field}.${entry.key}`, "Remove unknown private 1:1 proof fields.");
      }
      issue = accountAsciiBytes(state, index === 0 ? "" : ",", field);
      if (issue) return issue;
      issue = accountAdmissionString(entry.key, `${field}.${entry.key}`, state, MAX_ADMISSION_KEY_LENGTH);
      if (issue) return issue;
      issue = accountAsciiBytes(state, ":", field);
      if (issue) return issue;
      if (entry.key === "chat_id") {
        chatIdPresent = true;
        issue = accountAdmissionString(entry.value, `${field}.chat_id`, state, MAX_CHANNEL_STRING_LENGTH);
      } else {
        authenticatedPresent = true;
        issue = accountAdmissionBoolean(entry.value, `${field}.authenticated`, state, true);
      }
      if (issue) return issue;
    }
    if (!chatIdPresent) return preflightIssue(`${field}.chat_id`, "Provide the private proof chat_id.");
    if (!authenticatedPresent) return preflightIssue(`${field}.authenticated`, "Provide authenticated: true in the private proof.");
    return accountAsciiBytes(state, "}", field);
  } finally {
    leaveAdmissionNode(value as object, state);
  }
}

function preflightAdmissionPayload(input: Record<string, unknown>): ChannelPreflightResult {
  const state: ChannelAdmissionPreflightState = { active: new Set<object>(), bytes: 0, depth: 0, nodes: 0 };
  const channels = preflightChannels(input.channels, state);
  if (!channels.ok) return channels;
  let issue = preflightEndpointPolicies(input.endpoint_policy, state);
  if (issue) return { ok: false, issue };
  issue = preflightStringArray(input.allowed_chat_ids, "allowed_chat_ids", state, MAX_ADMISSION_ARRAY_LENGTH, MAX_ALLOWLIST_ID_LENGTH, true);
  if (issue) return { ok: false, issue };
  issue = preflightStringArray(input.allowed_sender_ids, "allowed_sender_ids", state, MAX_ADMISSION_ARRAY_LENGTH, MAX_ALLOWLIST_ID_LENGTH, true);
  if (issue) return { ok: false, issue };
  issue = preflightPrivateProof(input.private_one_to_one, state);
  if (issue) return { ok: false, issue };
  issue = accountAdmissionString(input.config_digest, "config_digest", state, 128);
  if (issue) return { ok: false, issue };
  return { ok: true, hasReadWrite: channels.hasReadWrite };
}
function failure(reason: StorageFailureReason, message?: string): StorageFailure {
  return message ? { ok: false, reason, code: reason, message } : { ok: false, reason, code: reason };
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

function canonicalValue(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (depth > 32) throw new TypeError("channel configuration is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("channel configuration contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("channel configuration contains a non-JSON value");
  if (seen.has(value)) throw new TypeError("channel configuration contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, depth + 1, seen));
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(key)) throw new TypeError("channel configuration contains an unsafe key");
      result[key] = canonicalValue(record[key], depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function canonicalChannelConfig(channels: readonly Readonly<Record<string, unknown>>[]): string {
  const state: ChannelAdmissionPreflightState = { active: new Set<object>(), bytes: 0, depth: 0, nodes: 0 };
  const preflight = preflightChannels(channels, state, false);
  if (!preflight.ok) throw new TypeError(preflight.issue.remediation);
  return JSON.stringify(canonicalValue(channels));
}

export function channelConfigDigest(channels: readonly Readonly<Record<string, unknown>>[]): WorkflowV2Digest {
  return `sha256:${createHash("sha256").update(canonicalChannelConfig(channels), "utf8").digest("hex")}`;
}

function admissionFailure(field: string, remediation: string): DiagnosticResult<ChannelAdmission> {
  return {
    ok: false,
    diagnostics: [createDiagnostic({ code: "CONFIG_MALFORMED", operation: "runtime.activate", evidence: { field }, remediation })],
  };
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
  }
  return value;
}

/** Create the immutable manager admission consumed by adapter factories. */
export function createChannelAdmission(input: ChannelAdmissionInput): DiagnosticResult<ChannelAdmission> {
  if (!isPlainAdmissionRecord(input)) {
    return admissionFailure("input", "Provide a plain closed manager channel admission record.");
  }
  const inputRecord = input as unknown as Record<string, unknown>;
  const topEntries = readAdmissionRecordEntries(inputRecord, "input", ADMISSION_INPUT_KEYS.length);
  if (!Array.isArray(topEntries)) return admissionFailure(topEntries.field, topEntries.remediation);
  for (const entry of topEntries) {
    if (!isAllowedAdmissionKey(entry.key, ADMISSION_INPUT_KEYS)) {
      return admissionFailure(`input.${entry.key}`, "Remove unknown channel admission fields.");
    }
  }
  for (const key of ADMISSION_INPUT_KEYS) {
    if (key === "private_one_to_one") continue;
    if (!topEntries.some((entry) => entry.key === key)) {
      return admissionFailure(`input.${key}`, "Provide every required channel admission field.");
    }
  }
  const preflight = preflightAdmissionPayload(inputRecord);
  if (!preflight.ok) return admissionFailure(preflight.issue.field, preflight.issue.remediation);
  if (!isCanonicalRoot(input.project_root)) return admissionFailure("project_root", "Provide the canonical root selected by the manager.");
  const run = validateWorkflowRunIdentity(input.run_identity);
  if (!run.ok) return admissionFailure("run_identity", "Provide the complete WorkflowRunIdentity selected by workflow_prepare.");
  if (typeof input.config_digest !== "string" || !/^(?:sha256:)[0-9a-f]{64}$/u.test(input.config_digest)) {
    return admissionFailure("config_digest", "Provide the manager-computed SHA-256 channel configuration digest.");
  }
  const privateProof = input.private_one_to_one;
  if (preflight.hasReadWrite && input.allowed_sender_ids.length === 0 && privateProof === undefined) {
    return admissionFailure("allowed_sender_ids", "Read-write channels require an explicit non-empty sender allowlist or authenticated private 1:1 proof.");
  }
  let channels: readonly Readonly<Record<string, unknown>>[];
  let endpointPolicy: Readonly<Record<string, ChannelEndpointPolicy>>;
  try {
    channels = freezeJson(canonicalValue(input.channels) as readonly Readonly<Record<string, unknown>>[]);
  } catch {
    return admissionFailure("channels", "Provide JSON-compatible bounded channel configuration.");
  }
  try {
    endpointPolicy = freezeJson(canonicalValue(input.endpoint_policy) as Readonly<Record<string, ChannelEndpointPolicy>>);
  } catch {
    return admissionFailure("endpoint_policy", "Provide JSON-compatible bounded endpoint policy data.");
  }
  if (channelConfigDigest(channels) !== input.config_digest) {
    return admissionFailure("config_digest", "The channel configuration digest does not match the exact admitted channels.");
  }
  const admission = Object.freeze({
    [channelAdmissionBrand]: "ChannelAdmission" as const,
    project_root: input.project_root,
    run_identity: run.value,
    channels,
    config_digest: input.config_digest,
    endpoint_policy: endpointPolicy,
    allowed_chat_ids: Object.freeze([...input.allowed_chat_ids]),
    allowed_sender_ids: Object.freeze([...input.allowed_sender_ids]),
    ...(privateProof ? { private_one_to_one: Object.freeze({ chat_id: privateProof.chat_id, authenticated: true as const }) } : {}),
  }) as ChannelAdmission;
  issuedChannelAdmissions.add(admission as object);
  return { ok: true, value: admission, diagnostics: [] };
}

export function isChannelAdmission(value: unknown): value is ChannelAdmission {
  return value !== null && typeof value === "object" && issuedChannelAdmissions.has(value);
}

function validBound(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

function validRelativePath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part.length <= MAX_COMPONENT_LENGTH && part !== "." && part !== ".." && !/^[A-Za-z]:$/u.test(part) && /^[A-Za-z0-9._-]+$/u.test(part));
}

function checkedPath(value: string): StorageResult<string> {
  return validRelativePath(value) ? { ok: true, value } : failure("UNSAFE_PATH", "Storage paths must be non-empty, relative, bounded and component-safe.");
}

function checkedIdentity(value: WorkflowRunIdentity, expected: WorkflowRunIdentity): StorageResult<WorkflowRunIdentity> {
  const checked = validateWorkflowRunIdentity(value);
  if (!checked.ok) return failure("IDENTITY_MISMATCH", "Storage identity must be a complete WorkflowRunIdentity.");
  return sameRun(checked.value, expected) ? { ok: true, value: checked.value } : failure("IDENTITY_MISMATCH", "Storage operation identity does not match the pinned workflow run.");
}

function checkedBytes(bytes: Uint8Array, maxBytes: number): StorageResult<Uint8Array> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) return failure("LIMIT", "Storage bytes exceed the bounded operation limit.");
  return { ok: true, value: bytes };
}

function validTreeBound(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function checkedTreeLimits(limits: StorageTreeLimits): StorageResult<StorageTreeLimits> {
  if (!limits || typeof limits !== "object") return failure("LIMIT", "Tree storage limits are required.");
  const candidate = limits as {
    readonly max_path_chars?: unknown;
    readonly max_file_bytes?: unknown;
    readonly max_entries?: unknown;
    readonly max_total_bytes?: unknown;
  };
  if (!validBound(candidate.max_path_chars as number, MAX_PATH_LENGTH)) {
    return failure("LIMIT", "Tree max_path_chars must be a positive bounded integer.");
  }
  if (!validTreeBound(candidate.max_file_bytes as number, MAX_TREE_FILE_BYTES)) {
    return failure("LIMIT", "Tree max_file_bytes exceeds the bounded file limit.");
  }
  if (!validTreeBound(candidate.max_entries as number, MAX_DIRECTORY_ENTRIES)) {
    return failure("LIMIT", "Tree max_entries exceeds the bounded entry limit.");
  }
  if (!validTreeBound(candidate.max_total_bytes as number, MAX_TREE_TOTAL_BYTES)) {
    return failure("LIMIT", "Tree max_total_bytes exceeds the bounded total limit.");
  }
  return {
    ok: true,
    value: Object.freeze({
      max_path_chars: candidate.max_path_chars as number,
      max_file_bytes: candidate.max_file_bytes as number,
      max_entries: candidate.max_entries as number,
      max_total_bytes: candidate.max_total_bytes as number,
    }),
  };
}

function checkedTreeEntries(
  entries: readonly StorageTreeEntry[],
  limits: StorageTreeLimits,
): StorageResult<readonly StorageTreeEntry[]> {
  if (!Array.isArray(entries) || entries.length > limits.max_entries) {
    return failure("LIMIT", "Tree entries exceed the bounded entry limit.");
  }
  const seen = new Set<string>();
  const checked: StorageTreeEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.relative_path !== "string") {
      return failure("IO", "Tree entry is malformed.");
    }
    if (!(entry.bytes instanceof Uint8Array)) return failure("IO", "Tree entry bytes are malformed.");
    const path = checkedPath(entry.relative_path);
    if (!path.ok) return path;
    if (path.value.length > limits.max_path_chars) {
      return failure("LIMIT", "Tree entry path exceeds max_path_chars.");
    }
    if (seen.has(path.value)) return failure("CONFLICT", "Tree entries contain duplicate paths.");
    seen.add(path.value);
    if (entry.bytes.byteLength > limits.max_file_bytes) {
      return failure("LIMIT", "Tree entry exceeds max_file_bytes.");
    }
    totalBytes += entry.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.max_total_bytes) {
      return failure("LIMIT", "Tree entries exceed max_total_bytes.");
    }
    checked.push(Object.freeze({ relative_path: path.value, bytes: entry.bytes }));
  }
  return { ok: true, value: Object.freeze(checked) };
}

function checkedTreePublishResult(
  value: unknown,
  limits: StorageTreeLimits,
): StorageResult<StorageTreePublishResult> {
  if (!value || typeof value !== "object") return failure("IO", "Tree publish result is malformed.");
  const candidate = value as { readonly pruned?: unknown; readonly warnings?: unknown };
  if (!Array.isArray(candidate.pruned) || !Array.isArray(candidate.warnings)) {
    return failure("IO", "Tree publish result is malformed.");
  }
  if (candidate.pruned.length > limits.max_entries || candidate.warnings.length > limits.max_entries) {
    return failure("LIMIT", "Tree publish result exceeds max_entries.");
  }
  const pruned: string[] = [];
  for (const value of candidate.pruned) {
    if (typeof value !== "string") return failure("IO", "Tree publish result has a malformed pruned path.");
    const path = checkedPath(value);
    if (!path.ok) return path;
    if (path.value.length > limits.max_path_chars) {
      return failure("LIMIT", "Tree publish result path exceeds max_path_chars.");
    }
    pruned.push(path.value);
  }
  const warnings: string[] = [];
  for (const value of candidate.warnings) {
    if (
      typeof value !== "string"
      || value.length > MAX_PATH_LENGTH
      || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ) {
      return failure("IO", "Tree publish result has a malformed warning.");
    }
    warnings.push(value);
  }
  return {
    ok: true,
    value: Object.freeze({
      pruned: Object.freeze(pruned),
      warnings: Object.freeze(warnings),
    }),
  };
}

function depthBeforeParse(text: string, maxDepth: number): boolean {
  let depth = 0;
  let maximum = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 92) escaped = true;
      else if (code === 34) inString = false;
      continue;
    }
    if (code === 34) {
      inString = true;
      continue;
    }
    if (code === 123 || code === 91) {
      depth += 1;
      maximum = Math.max(maximum, depth);
      if (maximum > maxDepth) return false;
    } else if (code === 125 || code === 93) {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return !inString && depth === 0;
}

function invoke<T>(action: () => StorageResult<T>): StorageResult<T> {
  try {
    const result = action();
    return result && typeof result === "object" && typeof result.ok === "boolean" ? result : failure("IO", "Storage backend returned an invalid result.");
  } catch {
    return failure("IO", "The pinned storage backend rejected the operation.");
  }
}

function validNative(native: FullstackStorageNativeBackend | undefined): native is FullstackStorageNativeBackend {
  if (!native || typeof native !== "object") return false;
  const candidate = native as unknown as Record<string, unknown>;
  return typeof candidate.canonical_root === "string"
    && typeof candidate.run_identity === "object"
    && typeof candidate.readBounded === "function"
    && typeof candidate.readTextBounded === "function"
    && typeof candidate.statBounded === "function"
    && typeof candidate.writeExclusive === "function"
    && typeof candidate.writeAtomic === "function"
    && typeof candidate.appendJsonLineBounded === "function"
    && typeof candidate.listBounded === "function"
    && typeof candidate.moveExclusive === "function"
    && typeof candidate.removeIfOwned === "function"
    && typeof candidate.acquireLease === "function"
    && typeof candidate.releaseLease === "function";
}


function authorityDiagnostic(code: "ROOT_UNAVAILABLE" | "IDENTITY_MISMATCH" | "CAPABILITY_MISSING" | "MIGRATION_REQUIRED", field: string, remediation: string): DiagnosticResult<FullstackStorageAuthority> {
  return {
    ok: false,
    diagnostics: [createDiagnostic({ code, operation: "runtime.activate", evidence: { field }, remediation })],
  };
}
type FullstackTreeNativeBackend = FullstackStorageNativeBackend & {
  readonly replaceTreeAtomic: NonNullable<FullstackStorageNativeBackend["replaceTreeAtomic"]>;
};

export function createFullstackStorageAuthority(
  options: Omit<FullstackStorageAuthorityOptions, "native"> & { readonly native: FullstackTreeNativeBackend },
): DiagnosticResult<FullstackTreeStorageAuthority>;
export function createFullstackStorageAuthority(
  options: FullstackStorageAuthorityOptions,
): DiagnosticResult<FullstackStorageAuthority>;

/**
 * Bind one host-issued native implementation to one exact root/run.  In phase
 * 2, omit `native`: construction fails before any backend method or side
 * effect.  The trusted core authority is checked as an additional launcher
 * prerequisite; its brand alone never supplies durable storage semantics.
 */
export function createFullstackStorageAuthority(
  options: FullstackStorageAuthorityOptions,
): DiagnosticResult<FullstackStorageAuthority | FullstackTreeStorageAuthority> {
  if (!options || !isCanonicalRoot(options.project_root)) return authorityDiagnostic("ROOT_UNAVAILABLE", "project_root", "Provide the canonical root selected by the root manager.");
  const run = validateWorkflowRunIdentity(options.run_identity);
  if (!run.ok) return authorityDiagnostic("IDENTITY_MISMATCH", "run_identity", "Provide the complete WorkflowRunIdentity selected by workflow_prepare.");
  if (!isTrustedFsAuthority(options.filesystem_authority)) return authorityDiagnostic("CAPABILITY_MISSING", "filesystem_authority", "Provide the launcher-issued trusted filesystem authority.");
  if (!options.filesystem_authority.supportsAtomicCas) return authorityDiagnostic("MIGRATION_REQUIRED", "filesystem_authority", "Provide a phase-3 descriptor-relative native backend with atomic bounded operations.");
  if (!validNative(options.native)) return authorityDiagnostic("CAPABILITY_MISSING", "native", "Inject the phase-3 DescriptorRelativeNativeBackend-backed fullstack storage implementation.");
  if (options.native.canonical_root !== options.project_root) return authorityDiagnostic("IDENTITY_MISMATCH", "native.canonical_root", "Pin storage to the exact canonical root supplied by the launcher.");
  const nativeRun = validateWorkflowRunIdentity(options.native.run_identity);
  if (!nativeRun.ok || !sameRun(nativeRun.value, run.value)) return authorityDiagnostic("IDENTITY_MISMATCH", "native.run_identity", "Pin storage to the exact WorkflowRunIdentity supplied by workflow_prepare.");

  const native = options.native;
  const readRawBounded = (relativePath: string, maxBytes: number): StorageResult<Uint8Array | null> => {
    const path = checkedPath(relativePath);
    if (!path.ok) return path;
    if (!validBound(maxBytes, MAX_APPEND_BYTES)) return failure("LIMIT", "Bounded reads require a positive byte limit.");
    const raw = invoke(() => native.readBounded(path.value, maxBytes));
    if (!raw.ok || raw.value === null) return raw;
    return checkedBytes(raw.value, maxBytes);
  };
  const readTextRawBounded = (relativePath: string, maxBytes: number): StorageResult<string | null> => {
    const path = checkedPath(relativePath);
    if (!path.ok) return path;
    if (!validBound(maxBytes, MAX_APPEND_BYTES)) return failure("LIMIT", "Bounded text reads require a positive byte limit.");
    const text = invoke(() => native.readTextBounded(path.value, maxBytes));
    if (!text.ok || text.value === null) return text;
    if (typeof text.value !== "string") return failure("IO", "Storage returned non-text bounded data.");
    if (new TextEncoder().encode(text.value).byteLength > maxBytes) return failure("LIMIT", "Storage returned text beyond the requested byte bound.");
    return text;
  };
  const statRawBounded = (relativePath: string): StorageResult<StorageStat> => {
    const path = checkedPath(relativePath);
    if (!path.ok) return path;
    const stat = invoke(() => native.statBounded(path.value));
    if (!stat.ok) return stat;
    const value = stat.value;
    if (!value || typeof value !== "object" || typeof value.exists !== "boolean"
      || (value.kind !== "missing" && value.kind !== "file" && value.kind !== "directory")
      || !Number.isSafeInteger(value.size_bytes) || value.size_bytes < 0
      || typeof value.mtime_ms !== "number" || !Number.isFinite(value.mtime_ms) || value.mtime_ms < 0
      || (value.exists && value.kind === "missing") || (!value.exists && value.kind !== "missing")) return failure("IO", "Storage returned invalid bounded stat metadata.");
    if (value.size_bytes > MAX_APPEND_BYTES) return failure("LIMIT", "Storage returned stat metadata beyond the bounded size.");
    return { ok: true, value: Object.freeze({ exists: value.exists, kind: value.kind, size_bytes: value.size_bytes, mtime_ms: value.mtime_ms }) };
  };
  const listRawBounded = (relativeDirectory: string, maxEntries: number): StorageResult<readonly StorageEntry[]> => {
    const path = checkedPath(relativeDirectory);
    if (!path.ok) return path;
    if (!validBound(maxEntries, MAX_DIRECTORY_ENTRIES)) return failure("LIMIT", "Directory listings require a bounded entry count.");
    const listed = invoke(() => native.listBounded(path.value, maxEntries));
    if (!listed.ok) return listed;
    if (!Array.isArray(listed.value)) return failure("IO", "Storage returned an invalid directory listing.");
    if (listed.value.length > maxEntries) return failure("LIMIT", "Storage returned more entries than requested.");
    const entries: StorageEntry[] = [];
    for (const entry of listed.value) {
      if (!entry || typeof entry.name !== "string" || typeof entry.relative_path !== "string") return failure("IO", "Storage returned a malformed directory entry.");
      const name = checkedPath(entry.name);
      if (!name.ok) return name;
      if (name.value.includes("/") || entry.relative_path !== `${path.value}/${name.value}`) return failure("UNSAFE_PATH", "Storage returned an entry outside its listed directory.");
      entries.push(Object.freeze({ name: name.value, relative_path: entry.relative_path }));
    }
    return { ok: true, value: Object.freeze(entries) };
  };
  const writeExclusiveBounded = (relativePath: string, bytes: Uint8Array, maxBytes: number, mode = DEFAULT_FILE_MODE): StorageResult<void> => {
    const path = checkedPath(relativePath);
    if (!path.ok) return path;
    if (!validBound(maxBytes, MAX_APPEND_BYTES)) return failure("LIMIT", "Exclusive writes require a positive byte limit.");
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) return failure("LIMIT", "Storage write mode is invalid.");
    const checked = checkedBytes(bytes, maxBytes);
    if (!checked.ok) return checked;
    return invoke(() => native.writeExclusive(path.value, checked.value, mode));
  };
  const writeAtomicBounded = (relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void> => {
    const path = checkedPath(relativePath);
    if (!path.ok) return path;
    if (!validBound(maxBytes, MAX_APPEND_BYTES)) return failure("LIMIT", "Atomic writes require a positive byte limit.");
    const checked = checkedBytes(bytes, maxBytes);
    if (!checked.ok) return checked;
    return invoke(() => native.writeAtomic(path.value, checked.value, maxBytes));
  };
  const replaceTreeNative = typeof native.replaceTreeAtomic === "function" ? native.replaceTreeAtomic : undefined;
  const replaceTreeAtomicBounded = replaceTreeNative === undefined
    ? undefined
    : (
      relativeRoot: string,
      entries: readonly StorageTreeEntry[],
      limits: StorageTreeLimits,
    ): StorageResult<StorageTreePublishResult> => {
      const checkedLimits = checkedTreeLimits(limits);
      if (!checkedLimits.ok) return checkedLimits;
      const root = checkedPath(relativeRoot);
      if (!root.ok) return root;
      if (root.value.length > checkedLimits.value.max_path_chars) {
        return failure("LIMIT", "Tree relativeRoot exceeds max_path_chars.");
      }
      const checkedEntries = checkedTreeEntries(entries, checkedLimits.value);
      if (!checkedEntries.ok) return checkedEntries;
      const result = invoke(() => replaceTreeNative.call(native, root.value, checkedEntries.value, checkedLimits.value));
      if (!result.ok) return result;
      return checkedTreePublishResult(result.value, checkedLimits.value);
    };

  const authority = {
    [fullstackStorageAuthorityBrand]: "FullstackStorageAuthority" as const,
    project_root: options.project_root,
    run_identity: run.value,
    readBounded(relativePath: string, maxBytes: number): StorageResult<Uint8Array | null> {
      return readRawBounded(relativePath, maxBytes);
    },
    readTextBounded(relativePath: string, maxBytes: number): StorageResult<string | null> {
      return readTextRawBounded(relativePath, maxBytes);
    },
    readJsonBounded(relativePath: string, maxBytes: number, maxDepth: number): StorageResult<unknown | null> {
      const path = checkedPath(relativePath);
      if (!path.ok) return path;
      if (!validBound(maxDepth, MAX_JSON_DEPTH)) return failure("LIMIT", "JSON reads require a bounded depth.");
      const raw = readRawBounded(path.value, maxBytes);
      if (!raw.ok || raw.value === null) return raw;
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw.value); } catch { return failure("IO", "Storage returned invalid UTF-8 JSON bytes."); }
      if (!depthBeforeParse(text, maxDepth)) return failure("LIMIT", "JSON nesting exceeds the bounded depth.");
      try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return failure("IO", "Storage returned malformed JSON."); }
    },
    statBounded(relativePath: string): StorageResult<StorageStat> {
      return statRawBounded(relativePath);
    },
    writeExclusive(relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void> {
      return writeExclusiveBounded(relativePath, bytes, maxBytes);
    },
    writeAtomic(relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void> {
      return writeAtomicBounded(relativePath, bytes, maxBytes);
    },
    writeJsonExclusive(relativePath: string, bytes: Uint8Array, mode = DEFAULT_FILE_MODE): StorageResult<void> {
      return writeExclusiveBounded(relativePath, bytes, MAX_JSON_BYTES, mode);
    },
    appendJsonLineBounded(relativePath: string, bytes: Uint8Array, maxBytes: number): StorageResult<void> {
      const path = checkedPath(relativePath);
      if (!path.ok) return path;
      if (!validBound(maxBytes, MAX_APPEND_BYTES)) return failure("LIMIT", "JSONL appends require a bounded byte limit.");
      const checked = checkedBytes(bytes, maxBytes);
      if (!checked.ok) return checked;
      return invoke(() => native.appendJsonLineBounded(path.value, checked.value, maxBytes));
    },
    listBounded(relativeDirectory: string, maxEntries: number): StorageResult<readonly StorageEntry[]> {
      return listRawBounded(relativeDirectory, maxEntries);
    },
    listJsonBounded(relativeDirectory: string, maxEntries: number): StorageResult<readonly StorageEntry[]> {
      const listed = listRawBounded(relativeDirectory, maxEntries);
      if (!listed.ok) return listed;
      return { ok: true, value: Object.freeze(listed.value.filter((entry) => entry.name.endsWith(".json"))) };
    },
    moveExclusive(sourceRelativePath: string, targetRelativePath: string): StorageResult<void> {
      const source = checkedPath(sourceRelativePath);
      if (!source.ok) return source;
      const target = checkedPath(targetRelativePath);
      if (!target.ok) return target;
      return invoke(() => native.moveExclusive(source.value, target.value));
    },
    removeIfOwned(relativePath: string, identity: WorkflowRunIdentity): StorageResult<boolean> {
      const path = checkedPath(relativePath);
      if (!path.ok) return path;
      const owner = checkedIdentity(identity, run.value);
      if (!owner.ok) return owner;
      return invoke(() => native.removeIfOwned(path.value, owner.value));
    },
    acquireLease(relativePath: string, identity: WorkflowRunIdentity): StorageResult<StorageLease> {
      const path = checkedPath(relativePath);
      if (!path.ok) return path;
      const owner = checkedIdentity(identity, run.value);
      if (!owner.ok) return owner;
      const acquired = invoke(() => native.acquireLease(path.value, owner.value));
      if (!acquired.ok) return acquired;
      if (!acquired.value || acquired.value.relative_path !== path.value || !sameRun(acquired.value.run_identity, run.value) || typeof acquired.value.lease_id !== "string" || acquired.value.lease_id.length === 0) return failure("IO", "Storage returned an invalid lease proof.");
      return { ok: true, value: Object.freeze({ relative_path: path.value, run_identity: run.value, lease_id: acquired.value.lease_id }) };
    },
    releaseLease(relativePath: string, identity: WorkflowRunIdentity): StorageResult<void> {
      const path = checkedPath(relativePath);
      if (!path.ok) return path;
      const owner = checkedIdentity(identity, run.value);
      if (!owner.ok) return owner;
      return invoke(() => native.releaseLease(path.value, owner.value));
    },
    ...(replaceTreeAtomicBounded === undefined ? {} : { replaceTreeAtomic: replaceTreeAtomicBounded }),
  } as FullstackStorageAuthority | FullstackTreeStorageAuthority;
  issuedAuthorities.add(authority as object);
  if (replaceTreeAtomicBounded !== undefined) issuedTreeAuthorities.add(authority as object);
  return { ok: true, value: Object.freeze(authority), diagnostics: [] };
}

/** Runtime brand check; plain objects and unsupported authorities are rejected. */
export function isFullstackStorageAuthority(value: unknown): value is FullstackStorageAuthority {
  return value !== null && typeof value === "object" && issuedAuthorities.has(value);
}

/** Runtime brand check for the optional whole-tree authority capability. */
export function isFullstackTreeStorageAuthority(value: unknown): value is FullstackTreeStorageAuthority {
  return isFullstackStorageAuthority(value) && issuedTreeAuthorities.has(value);
}


export const FULLSTACK_STORAGE_LIMITS = Object.freeze({
  maxJsonBytes: MAX_JSON_BYTES,
  maxAppendBytes: MAX_APPEND_BYTES,
  maxPathLength: MAX_PATH_LENGTH,
  maxJsonDepth: MAX_JSON_DEPTH,
  maxDirectoryEntries: MAX_DIRECTORY_ENTRIES,
});
