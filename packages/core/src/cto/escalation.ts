/**
 * Escalation contract for the CTO sub-orchestration.
 *
 * - {@link EscalationAdapter} is the consumer-implemented channel interface
 *   (declared in `types.ts`).
 * - Answers arrive as **files**: `.work-state/cto/<runId>/answers/<escId>.json`
 *   with shape `{ id, run_id, answer, at, by }`. The engine / parked agent picks them
 *   up at the next checkpoint — durable across restarts and compaction.
 * - `validateEscalation` guards the shape before an adapter send; engine-level
 *   sanitization (R4) is applied by `runCto` in the engine task.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { ctoStateDir, isSafeCtoRunId } from "./state.js";
import { canonicalDurableIdFileName, durableIdFileNameMatches, safeLegacyDurableIdFileName } from "./durable-id.js";
import { PinnedProjectRoot } from "../specification/pinned-root.js";
import { DEFAULT_REDACTION_CONFIG, redactEscalation } from "./redaction.js";
import type { Escalation, EscalationAnswer } from "./types.js";
import { TextDecoder } from "node:util";

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
const REQUIRED: Array<keyof Escalation> = ["id", "level", "title", "body"];

/** Telegram callback payloads are capped at 64 UTF-8 bytes; adapters use opaque tokens. */
export const ESCALATION_CALLBACK_DELIMITER = "::";
export const MAX_TELEGRAM_CALLBACK_DATA_UTF8_BYTES = 64;
/** Domain identity bounds; Telegram adapters encode long identities opaquely. */
export const MAX_ESCALATION_ID_UTF8_BYTES = 1024;
export const MAX_ESCALATION_ID_SEGMENTS = 8;
export const MAX_ESCALATION_ID_SEGMENT_UTF8_BYTES = 512;
export const MAX_ESCALATION_OPTION_COUNT = 16;
export const MAX_ESCALATION_OPTION_ID_UTF8_BYTES = 128;
export const MAX_ESCALATION_OPTION_TEXT_UTF8_BYTES = 256;

const SAFE_ESCALATION_SEGMENT = /^[\p{L}\p{N}._-]+$/u;
const DOT_ONLY_ESCALATION_SEGMENT = /^\.+$/u;
const LEVELS: Record<string, true> = {
  question: true,
  decision: true,
  needs_human: true,
  blocker: true,
};

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : INVALID_VALUE;
}

const INVALID_VALUE = Symbol("invalid escalation value");

function safeEscalationText(value: unknown, maxBytes: number, allowLineBreaks = true): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    && (allowLineBreaks || !/[\r\n]/u.test(value));
}

/** Canonical slash-delimited escalation identity accepted by every adapter. */
export function isSafeEscalationId(value: unknown): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_ESCALATION_ID_UTF8_BYTES) return false;
  const segments = value.split("/");
  return segments.length > 0
    && segments.length <= MAX_ESCALATION_ID_SEGMENTS
    && isSafeCtoRunId(segments[0])
    && segments.every((segment) =>
      segment.length > 0
      && !DOT_ONLY_ESCALATION_SEGMENT.test(segment)
      && Buffer.byteLength(segment, "utf8") <= MAX_ESCALATION_ID_SEGMENT_UTF8_BYTES
      && SAFE_ESCALATION_SEGMENT.test(segment));
}

/** Canonical option answer key; it must remain one callback-data segment. */
export function isSafeEscalationOptionId(value: unknown): value is string {
  return typeof value === "string"
    && !DOT_ONLY_ESCALATION_SEGMENT.test(value)
    && Buffer.byteLength(value, "utf8") <= MAX_ESCALATION_OPTION_ID_UTF8_BYTES
    && SAFE_ESCALATION_SEGMENT.test(value)
    && !value.includes(ESCALATION_CALLBACK_DELIMITER);
}

/** Return the exact callback payload only when it fits Telegram's byte bound. */
export function escalationCallbackData(escId: unknown, optionId: unknown): string | null {
  if (!isSafeEscalationId(escId) || !isSafeEscalationOptionId(optionId)) return null;
  const callback = `${escId}${ESCALATION_CALLBACK_DELIMITER}${optionId}`;
  return Buffer.byteLength(callback, "utf8") <= MAX_TELEGRAM_CALLBACK_DATA_UTF8_BYTES ? callback : null;
}

/**
 * R4 filter applied by the engine before any adapter send: no secrets, no
 * unbounded content. Title truncated to 120 chars, body truncated to 2000
 * chars with secret-bearing lines dropped (a fully-redacted body becomes
 * "[redacted]"). Never throws.
 *
 * Delegates to {@link redactEscalation} with {@link DEFAULT_REDACTION_CONFIG}
 * (br-zps.6) — the config-driven pipeline replaces the former inline logic.
 */
export function sanitizeEscalation(esc: Escalation): Escalation {
  return redactEscalation(esc, DEFAULT_REDACTION_CONFIG);
}
export function validateEscalation(esc: Escalation): string | null {
  try {
    if (!plainObject(esc)) return "escalation must be a plain object";
    const record = esc as unknown as Record<string, unknown>;
    for (const key of ["timeoutMs", "options", "default", "replyTo"]) {
      if (key in record && !Object.hasOwn(record, key)) {
        return `escalation.${key} must be an own property`;
      }
    }
    const required: Record<string, unknown> = {};
    for (const key of REQUIRED) {
      const value = ownDataValue(record, key);
      if (value === INVALID_VALUE || !safeEscalationText(value, Number.MAX_SAFE_INTEGER)) {
        return `escalation.${key} must be a non-empty string`;
      }
      required[key] = value;
    }
    const id = required.id as string;
    if (!isSafeEscalationId(id)) {
      return `escalation.id must be a safe slash-delimited identity (at most ${MAX_ESCALATION_ID_UTF8_BYTES} UTF-8 bytes)`;
    }
    const level = required.level as string;
    if (!Object.hasOwn(LEVELS, level)) {
      return `escalation.level must be one of: ${Object.keys(LEVELS).join(", ")}`;
    }

    const timeoutMs = ownDataValue(record, "timeoutMs");
    if (timeoutMs !== undefined && (timeoutMs === INVALID_VALUE || typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      return "escalation.timeoutMs must be a finite non-negative number (0 = wait forever)";
    }

    const defaultValue = ownDataValue(record, "default");
    if (defaultValue !== undefined && (defaultValue === INVALID_VALUE || !safeEscalationText(defaultValue, MAX_ESCALATION_OPTION_TEXT_UTF8_BYTES, false))) {
      return `escalation.default must be a non-empty single-line string of at most ${MAX_ESCALATION_OPTION_TEXT_UTF8_BYTES} UTF-8 bytes`;
    }
    const replyTo = ownDataValue(record, "replyTo");
    if (replyTo !== undefined && (replyTo === INVALID_VALUE || !isSafeEscalationId(replyTo))) {
      return "escalation.replyTo must be a safe escalation identity";
    }

    const options = ownDataValue(record, "options");
    if (options !== undefined) {
      if (options === INVALID_VALUE || !Array.isArray(options)) return "escalation.options must be an array";
      if (options.length > MAX_ESCALATION_OPTION_COUNT) {
        return `escalation.options must contain at most ${MAX_ESCALATION_OPTION_COUNT} entries`;
      }
      const optionIds = new Set<string>();
      for (const option of options) {
        if (!plainObject(option)) return "escalation.options entries must be plain objects";
        const optionRecord = option as Record<string, unknown>;
        const optionId = ownDataValue(optionRecord, "id");
        const optionLabel = ownDataValue(optionRecord, "label");
        const apply = ownDataValue(optionRecord, "apply");
        if (
          optionId === INVALID_VALUE
          || optionLabel === INVALID_VALUE
          || apply === INVALID_VALUE
          || !isSafeEscalationOptionId(optionId)
          || !safeEscalationText(optionLabel, MAX_ESCALATION_OPTION_TEXT_UTF8_BYTES, false)
        ) {
          return `escalation.options entries need a safe id and non-empty label of at most ${MAX_ESCALATION_OPTION_TEXT_UTF8_BYTES} UTF-8 bytes`;
        }
        if (optionIds.has(optionId)) return "escalation.options ids must be unique";
        optionIds.add(optionId);
        if (apply !== "now" && apply !== "on_next_checkpoint") {
          return 'escalation.options[].apply must be "now" | "on_next_checkpoint"';
        }
      }
    }
    return null;
  } catch {
    return "escalation has an invalid runtime shape";
  }
}

/** Directory holding answer files for a CTO run. */
export function answersDir(runId: string, root: string): string {
  if (!isSafeCtoRunId(runId)) throw new Error("unsafe CTO run id");
  return join(ctoStateDir(runId, root), "answers");
}

/** A bounded, restart-safe page returned by {@link readAnswers}. */
export interface ReadAnswersPage {
  answers: EscalationAnswer[];
  /** Opaque cursor for the next page, or `null` once the snapshot is exhausted. */
  next_cursor: string | null;
  /** True when no names remain in the bounded directory snapshot. */
  done: boolean;
}

/** Options for bounded answer enumeration and exact answer lookup. */
export interface ReadAnswersOptions {
  /** Caller-owned pin; when absent readAnswers opens and closes one. */
  pinnedRoot?: PinnedProjectRoot;
  /** Opaque cursor returned by a previous readAnswers call. */
  cursor?: string | null;
  /** Maximum directory entries inspected in this page (default 256). */
  limit?: number;
  /** Maximum bytes accepted for one answer file before parsing. */
  maxBytes?: number;
}

const DEFAULT_MAX_ANSWER_ENTRIES = 256;
const MAX_ANSWER_PAGE_ENTRIES = 256;
const DEFAULT_MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_ANSWER_SCAN_ENTRIES = 4096;
const MAX_ANSWER_SCAN_NAME_BYTES = 4 * 1024 * 1024;
const MAX_ANSWER_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_ANSWER_CURSOR_BYTES = 4096;
const MAX_ANSWER_DEFERRED_RETRIES = 1;
const MAX_ANSWER_FIELD_BYTES = 16 * 1024;

const ANSWER_KEYS: Record<string, true> = {
  id: true,
  run_id: true,
  answer: true,
  at: true,
  by: true,
  stale: true,
};
interface AnswerCursor {
  v: 1;
  run_id: string;
  root: string;
  root_dev: number;
  root_ino: number;
  answers_dev: number;
  answers_ino: number;
  answers_generation: string;
  snapshot: string;
  prefix: string;
  after: string | null;
  /** Number of retries made without advancing past a deferred entry. */
  deferred_retries: number;
}

function answerPageEmpty(): ReadAnswersPage {
  return { answers: [], next_cursor: null, done: true };
}

function digestAnswerSnapshot(names: readonly string[]): string {
  const hash = createHash("sha256");
  for (const name of names) hash.update(name, "utf8").update("\0", "utf8");
  return hash.digest("hex");
}

function digestAnswerPrefix(names: readonly string[], after: string | null): string {
  return digestAnswerSnapshot(after === null ? [] : names.filter((name) => name <= after));
}

function answerDirectoryGeneration(info: { dev: number; ino: number }): string {
  return `${info.dev}:${info.ino}`;
}

function answerRootToken(pinnedRoot: PinnedProjectRoot): string {
  return createHash("sha256").update(pinnedRoot.canonical_root, "utf8").digest("hex");
}

function encodeAnswerCursor(cursor: AnswerCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAnswerCursor(value: unknown, runId: string, pinnedRoot: PinnedProjectRoot): AnswerCursor | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_ANSWER_CURSOR_BYTES) return undefined;
  let parsed: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== value) return undefined;
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.v !== 1
    || candidate.run_id !== runId
    || candidate.root !== answerRootToken(pinnedRoot)
    || candidate.root_dev !== pinnedRoot.dev
    || candidate.root_ino !== pinnedRoot.ino
    || !Number.isSafeInteger(candidate.answers_dev)
    || !Number.isSafeInteger(candidate.answers_ino)
    || typeof candidate.answers_generation !== "string"
    || candidate.answers_generation !== `${candidate.answers_dev}:${candidate.answers_ino}`
    || typeof candidate.prefix !== "string"
    || !/^[a-f0-9]{64}$/u.test(candidate.prefix)
    || typeof candidate.snapshot !== "string"
    || !/^[a-f0-9]{64}$/u.test(candidate.snapshot)
    || (candidate.after !== null && typeof candidate.after !== "string")
    || (typeof candidate.after === "string" && Buffer.byteLength(candidate.after, "utf8") > 255)
    || (candidate.deferred_retries !== undefined
      && (typeof candidate.deferred_retries !== "number"
        || !Number.isInteger(candidate.deferred_retries)
        || candidate.deferred_retries < 0
        || candidate.deferred_retries > MAX_ANSWER_DEFERRED_RETRIES))
    || Object.keys(candidate).some((key) => !["v", "run_id", "root", "root_dev", "root_ino", "answers_dev", "answers_ino", "answers_generation", "snapshot", "prefix", "after", "deferred_retries"].includes(key))
  ) return undefined;
  return {
    v: 1,
    run_id: runId,
    root: answerRootToken(pinnedRoot),
    root_dev: pinnedRoot.dev,
    root_ino: pinnedRoot.ino,
    answers_dev: candidate.answers_dev as number,
    answers_ino: candidate.answers_ino as number,
    answers_generation: candidate.answers_generation as string,
    snapshot: candidate.snapshot,
    prefix: candidate.prefix as string,
    after: candidate.after as string | null,
    deferred_retries: typeof candidate.deferred_retries === "number" ? candidate.deferred_retries : 0,
  };
}

function answerField(value: unknown, maxBytes = MAX_ANSWER_FIELD_BYTES): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\u0000-\u001f\u007f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function parseAnswer(raw: unknown, name: string, maxBytes: number, runId: string): EscalationAnswer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => ANSWER_KEYS[key] !== true)) return null;
  const stale = value.stale;
  if (
    !Object.hasOwn(value, "run_id")
    || !isSafeCtoRunId(value.run_id)
    || value.run_id !== runId
    || !answerField(value.id)
    || !answerField(value.answer, maxBytes)
    || !answerField(value.at)
    || !answerField(value.by)
  ) return null;
  if (stale !== undefined && typeof stale !== "boolean") return null;
  if (!durableIdFileNameMatches(name, value.id) && safeLegacyDurableIdFileName(value.id) !== name) return null;
  return {
    id: value.id,
    run_id: value.run_id,
    answer: value.answer,
    at: value.at,
    by: value.by,
    ...(stale === undefined ? {} : { stale: stale as boolean }),
  };
}

function answerReadLimit(value: unknown): number | null {
  if (value === undefined) return DEFAULT_MAX_ANSWER_ENTRIES;
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_ANSWER_PAGE_ENTRIES
    ? value as number
    : null;
}

function answerReadBytes(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_ANSWER_PAGE_BYTES
    ? value as number
    : DEFAULT_MAX_ANSWER_BYTES;
}

/**
 * Read one deterministic, bounded page of answer files.
 *
 * Directory names are snapshotted under explicit limits. If the directory
 * changes between calls, the cursor restarts from the beginning of the new
 * snapshot instead of skipping an entry inserted before the old cursor.
 * Consumers should de-duplicate by answer id when replaying after a restart.
 */
export function readAnswers(runId: string, root: string, options: ReadAnswersOptions = {}): ReadAnswersPage {
  if (!isSafeCtoRunId(runId)) return answerPageEmpty();
  const suppliedPin = options.pinnedRoot;
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return answerPageEmpty();
  const limit = answerReadLimit(options.limit);
  if (limit === null) {
    if (!suppliedPin) pinnedRoot.close();
    return answerPageEmpty();
  }
  const maxBytes = answerReadBytes(options.maxBytes);
  const relativeDirectory = join(".work-state", "cto", runId, "answers");
  try {
    if (!pinnedRoot.isStable() || !pinnedRoot.pathEntryExists(relativeDirectory)) return answerPageEmpty();
    const directoryInfo = pinnedRoot.pathEntryInfo(relativeDirectory);
    if (!directoryInfo || directoryInfo.kind !== "directory") return answerPageEmpty();
    const listing = pinnedRoot.listDirectoryPage(relativeDirectory, {
      cursor: null,
      maxEntries: MAX_ANSWER_SCAN_ENTRIES,
      maxNameBytes: MAX_ANSWER_SCAN_NAME_BYTES,
      maxScanEntries: MAX_ANSWER_SCAN_ENTRIES,
      maxScanNameBytes: MAX_ANSWER_SCAN_NAME_BYTES,
    });
    // A directory larger than the explicit hostile-directory budget is never
    // read in an unbounded loop. A caller can retry after the producer drains
    // invalid entries, while exact consumers use readAnswerById instead.
    if (listing.nextCursor !== null) return answerPageEmpty();
    const names = listing.names;
    const snapshot = digestAnswerSnapshot(names);
    const decoded = decodeAnswerCursor(options.cursor, runId, pinnedRoot);
    if (decoded === undefined) return answerPageEmpty();
    const sameIdentity = decoded !== null
      && decoded.root_dev === pinnedRoot.dev
      && decoded.root_ino === pinnedRoot.ino
      && decoded.answers_dev === directoryInfo.dev
      && decoded.answers_ino === directoryInfo.ino
      && decoded.answers_generation === answerDirectoryGeneration(directoryInfo)
      && decoded.prefix === digestAnswerPrefix(names, decoded.after);
    const sameSnapshot = sameIdentity && decoded !== null && decoded.snapshot === snapshot;
    const after = sameIdentity ? decoded!.after : null;
    const deferredRetries = sameIdentity ? decoded!.deferred_retries : 0;
    const start = after === null ? 0 : names.findIndex((name) => name > after);
    if (start < 0) return { answers: [], next_cursor: null, done: true };
    const selected: string[] = [];
    for (let index = start; index < names.length && selected.length < limit; index += 1) selected.push(names[index]!);
    const entryNames = new Set(names);
    const jsonNames = selected.filter((name) => name.endsWith(".json"));
    let batch: { records: Array<{ name: string; bytes: Uint8Array }>; failed: string[]; remaining: string[] };
    try {
      const readBatch = jsonNames.length === 0
        ? { records: [], failed: [], remaining: [] }
        : pinnedRoot.readBatch(relativeDirectory, jsonNames, {
          maxEntries: jsonNames.length,
          maxNameBytes: MAX_ANSWER_SCAN_NAME_BYTES,
          maxBytes,
          maxTotalBytes: MAX_ANSWER_PAGE_BYTES,
        });
      batch = { records: readBatch.records, failed: readBatch.failed, remaining: readBatch.remaining };
    } catch {
      // A raced or unsafe leaf is treated as a permanent failed item, not a
      // reason to hold the page cursor forever.
      batch = { records: [], failed: jsonNames, remaining: [] };
    }
    const failed = new Set(batch.failed);
    const remaining = new Set(batch.remaining);
    // Entries after the first aggregate-cap remainder were not read. Leave
    // the cursor immediately before that deferred suffix so the next page
    // retries it with a fresh byte budget. Bounded per-entry failures
    // (oversized, malformed, disappeared, or raced) are terminal and may be
    // crossed.
    const firstRemaining = selected.findIndex((name) => remaining.has(name));
    const attempted = firstRemaining < 0 ? selected : selected.slice(0, firstRemaining);
    const last = attempted.at(-1) ?? null;
    const noProgressRetryExhausted = firstRemaining >= 0
      && attempted.length === 0
      && deferredRetries >= MAX_ANSWER_DEFERRED_RETRIES;
    const next_cursor = firstRemaining >= 0 && !noProgressRetryExhausted
      ? encodeAnswerCursor({
        v: 1,
        run_id: runId,
        root: answerRootToken(pinnedRoot),
        root_dev: pinnedRoot.dev,
        root_ino: pinnedRoot.ino,
        answers_dev: directoryInfo.dev,
        answers_ino: directoryInfo.ino,
        answers_generation: answerDirectoryGeneration(directoryInfo),
        snapshot,
        // An all-deferred page retries from its incoming position.
        after: last ?? after,
        prefix: digestAnswerPrefix(names, last ?? after),
        deferred_retries: attempted.length === 0 ? deferredRetries + 1 : 0,
      })
      : noProgressRetryExhausted
        ? names.some((name) => name > selected[firstRemaining]!)
          ? encodeAnswerCursor({
            v: 1,
            run_id: runId,
            root: answerRootToken(pinnedRoot),
            root_dev: pinnedRoot.dev,
            root_ino: pinnedRoot.ino,
            answers_dev: directoryInfo.dev,
            answers_ino: directoryInfo.ino,
            answers_generation: answerDirectoryGeneration(directoryInfo),
            snapshot,
            after: selected[firstRemaining]!,
            prefix: digestAnswerPrefix(names, selected[firstRemaining]!),
            deferred_retries: 0,
          })
          : null
        : last !== null && names.some((name) => name > last)
          ? encodeAnswerCursor({
            v: 1,
            run_id: runId,
            root: answerRootToken(pinnedRoot),
            root_dev: pinnedRoot.dev,
            root_ino: pinnedRoot.ino,
            answers_dev: directoryInfo.dev,
            answers_ino: directoryInfo.ino,
            answers_generation: answerDirectoryGeneration(directoryInfo),
            snapshot,
            after: last,
            prefix: digestAnswerPrefix(names, last),
            deferred_retries: 0,
          })
          : null;
    const records = new Map(batch.records.map((record) => [record.name, record.bytes]));
    const legacyIds = new Map<string, Set<string>>();
    const canonicalAnswers = new Map<string, EscalationAnswer>();
    const legacyCandidates = new Map<string, EscalationAnswer[]>();
    for (const name of jsonNames) {
      if (remaining.has(name) || failed.has(name) || !pinnedRoot.isStable()) continue;
      const bytes = records.get(name);
      if (!bytes) continue;
      try {
        const answer = parseAnswer(JSON.parse(decodeUtf8(bytes)), name, maxBytes, runId);
        if (!answer) continue;
        const canonical = durableIdFileNameMatches(name, answer.id);
        const legacyName = safeLegacyDurableIdFileName(answer.id);
        if (legacyName !== undefined) {
          const ids = legacyIds.get(legacyName) ?? new Set<string>();
          ids.add(answer.id);
          legacyIds.set(legacyName, ids);
        }
        if (canonical) {
          if (legacyName !== undefined && legacyName !== name && entryNames.has(legacyName)) {
            const exact = readAnswerById(runId, root, answer.id, { pinnedRoot, maxBytes });
            if (exact) canonicalAnswers.set(answer.id, exact);
          } else {
            canonicalAnswers.set(answer.id, answer);
          }
          continue;
        }
        if (legacyName === undefined || legacyName !== name) continue;
        const candidates = legacyCandidates.get(legacyName) ?? [];
        candidates.push(answer);
        legacyCandidates.set(legacyName, candidates);
      } catch {
        // Invalid, unsafe, non-regular, FIFO, symlink, and oversized entries
        // are isolated; one hostile file cannot block the bounded page.
      }
    }
    const answers: EscalationAnswer[] = [...canonicalAnswers.values()];
    for (const [legacyName, candidates] of legacyCandidates) {
      if (candidates.length !== 1) continue;
      const candidate = candidates[0]!;
      const canonicalName = canonicalDurableIdFileName(candidate.id);
      // A canonical file anywhere in this bounded snapshot wins only when it
      // is the same file; two valid generations are a duplicate/conflict.
      if (entryNames.has(canonicalName)) {
        const exact = readAnswerById(runId, root, candidate.id, { pinnedRoot, maxBytes });
        if (exact) canonicalAnswers.set(candidate.id, exact);
        continue;
      }
      if ((legacyIds.get(legacyName)?.size ?? 0) !== 1) continue;
      answers.push(candidate);
    }
    return pinnedRoot.isStable() ? { answers, next_cursor, done: next_cursor === null } : answerPageEmpty();
  } catch {
    return answerPageEmpty();
  } finally {
    if (!suppliedPin) pinnedRoot.close();
  }
}

/**
 * Read one answer by its exact correlation id without enumerating the
 * directory. Canonical and safe legacy aliases are both checked; two valid
 * aliases for the same id fail closed as a duplicate.
 */
export function readAnswerById(
  runId: string,
  root: string,
  answerId: string,
  options: Omit<ReadAnswersOptions, "cursor" | "limit"> = {},
): EscalationAnswer | null {
  if (!isSafeCtoRunId(runId) || !answerField(answerId)) return null;
  const suppliedPin = options.pinnedRoot;
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return null;
  const maxBytes = answerReadBytes(options.maxBytes);
  const relativeDirectory = join(".work-state", "cto", runId, "answers");
  try {
    if (!pinnedRoot.isStable() || !pinnedRoot.pathEntryExists(relativeDirectory)) return null;
    const names = [canonicalDurableIdFileName(answerId)];
    const legacyName = safeLegacyDurableIdFileName(answerId);
    if (legacyName !== undefined && !names.includes(legacyName)) names.push(legacyName);
    const found: Array<{ answer: EscalationAnswer; canonical: boolean; identity: string }> = [];
    for (const name of names) {
      if (!pinnedRoot.pathEntryExists(join(relativeDirectory, name))) continue;
      try {
        const read = pinnedRoot.readFile(join(relativeDirectory, name), { maxBytes });
        const answer = parseAnswer(JSON.parse(decodeUtf8(read.bytes)), name, maxBytes, runId);
        if (answer?.id === answerId) {
          found.push({ answer, canonical: durableIdFileNameMatches(name, answerId), identity: JSON.stringify(answer) });
        }
      } catch {
        // A malformed or hostile alias cannot block the exact lookup.
      }
    }
    if (!pinnedRoot.isStable() || found.length === 0 || found.length > 2) return null;
    if (found.length === 2 && found[0]!.identity !== found[1]!.identity) return null;
    return (found.find((entry) => entry.canonical) ?? found[0]!).answer;
  } catch {
    return null;
  } finally {
    if (!suppliedPin) pinnedRoot.close();
  }
}
/** Ensure the answers directory exists through a pinned root. */
export function ensureAnswersDir(runId: string, root: string, suppliedPin?: PinnedProjectRoot): string {
  if (!isSafeCtoRunId(runId)) throw new Error("unsafe CTO run id");
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("CTO answers root cannot be pinned");
  const relativeDirectory = join(".work-state", "cto", runId, "answers");
  try {
    if (!pinnedRoot.isStable()) throw new Error("CTO answers root changed before directory creation");
    pinnedRoot.ensureDirectory(relativeDirectory);
    if (!pinnedRoot.isStable()) throw new Error("CTO answers root changed after directory creation");
    return join(pinnedRoot.lexical_root, relativeDirectory);
  } finally {
    if (!suppliedPin) pinnedRoot.close();
  }
}
