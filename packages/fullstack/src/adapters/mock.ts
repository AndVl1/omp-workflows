/**
 * In-process mock EscalationAdapter (br-zps.6 / D4).
 *
 * No network, no credentials: `.omp/escalation.json` `{"adapter":"mock"}`
 * selects it for tests and the epic's E2E. Implements the full optional
 * inbound surface (pollOnce / setPlainMessageHandler / sendPlainText) so
 * the entire escalation round-trip is exercisable in-process:
 *
 *   adapter.send(esc) → adapter.injectAnswer(runId, escId, ...) →
 *   adapter.pollOnce() → dispatcher writes answers/<escId>.json
 *
 * Answers injected for a CANCELLED esc id carry `stale: true` (R5).
 *
 * ── Persisted fake-RW mode (opt-in, architecture-10) ──────────────────────
 *
 * `new MockEscalationAdapter({ persisted: { dir } })` turns the adapter into
 * a FILE-OBSERVABLE fake read-write transport that works across adapter
 * instances and processes — the deterministic transport for the epic's E2E.
 * Layout (see .work-state/artifacts/fullstack-dispatch/fake-rw-contract.md):
 *
 *   <dir>/inbound/task-<n>.json    {id, text, at, by}    durable inbound tasks
 *   <dir>/inbound/rejected/        rejected malformed/empty/oversized inbound
 *                                  files + durable rejection records
 *                                  (rejected/<name>.json: {file, reason, at, id?})
 *   <dir>/answers/ans-<n>.json     {id, run_id, answer, at, by}  durable answers
 *   <dir>/outbound/messages.jsonl  one JSON line per send()
 *   <dir>/outbound/plain.jsonl     one JSON line per sendPlainText()
 *
 *   messages.jsonl line: {escId, intent?, title, body, at, receipt:{sent, channelRef}}
 *   plain.jsonl line:    {target, text, at, receipt:{sent, channelRef}}
 *
 * injectTask / injectPlainMessage write the inbound file ATOMICALLY (unique
 * tmp name + rename) and THEN fire the in-memory handler when set;
 * injectAnswer writes the answer file and queues it in memory as today.
 * pollOnce() drains answers/ (read -> rename to answers/processed/; the
 * rename is the at-most-once consume — failures leave the file in place)
 * merged with the in-memory queue, then drains inbound/ (read -> invoke the
 * stored plain handler -> rename to inbound/processed/; handler failures
 * leave the file for retry, and malformed/empty/oversized files are moved
 * to inbound/rejected/ with a durable record). This is how a SECOND
 * process's dispatcher receives tasks persisted by the first. reset()
 * clears the in-memory state AND empties the persisted dirs (test helper).
 *
 * This is a leaf module for the adapter itself (imports only core + node
 * builtins); the sole registry-touching surface is `registerMockAdapterForTesting`,
 * which intentionally imports ./registry.js to wire the factory back in.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type Escalation,
  type EscalationAnswer,
  type EscalationAdapter,
  type EscalationInboundMessage,
  type EscalationReceipt,
  PinnedProjectRoot,
  processStartIdentity,
  isSafeCtoRunId,
  isSafeEscalationId,
  validateEscalation,
} from "@andvl1/omp-workflows-core";
import { registerEscalationAdapter, MAX_INBOX_TEXT_LENGTH, type EscalationAdapterFactory } from "./registry.js";
import {
  type RegistryRegistrationToken,
} from "@andvl1/omp-workflows-core/registry";

const MOCK_LEGACY_CLAIM_GRACE_MS = 50;

const MOCK_PERSISTED_RECORD_MAX_BYTES = 8 * 1024;
export const MOCK_IDEMPOTENCY_KEY_MAX_BYTES = 1024;
const MOCK_PERSISTED_LOG_LINE_MAX_BYTES = 32 * 1024;
const MOCK_PERSISTED_LOG_MAX_BYTES = 2 * 1024 * 1024;
const MOCK_QUEUE_PAGE_ENTRIES = 64;
const MOCK_QUEUE_MAX_SCAN_ENTRIES = 4096;
const MOCK_QUEUE_MAX_SCAN_NAME_BYTES = 256 * 1024;
const MOCK_QUEUE_MAX_TOTAL_BYTES = 256 * 1024;
const MOCK_PERSISTED_LOG_MAX_LINES = 4096;

export type MockPersistedRecordErrorCode = "MOCK_PERSISTED_RECORD_TOO_LARGE" | "MOCK_PERSISTED_INPUT_INVALID";
export class MockPersistedRecordError extends Error {
  readonly code: MockPersistedRecordErrorCode;
  constructor(code: MockPersistedRecordErrorCode, message: string) {
    super(message);
    this.name = "MockPersistedRecordError";
    this.code = code;
  }
}
function isPersistedExistsError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "exists") return true;
  return error instanceof Error && /\b(?:already exists|file exists)\b/iu.test(error.message);
}
function serializeMockPersistedRecord(data: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(data, null, 2);
  } catch (error) {
    throw new MockPersistedRecordError("MOCK_PERSISTED_INPUT_INVALID", `mock persisted record is not serializable: ${String(error)}`);
  }
  if (typeof json !== "string") {
    throw new MockPersistedRecordError("MOCK_PERSISTED_INPUT_INVALID", "mock persisted record is not serializable");
  }
  if (Buffer.byteLength(json, "utf8") > MOCK_PERSISTED_RECORD_MAX_BYTES) {
    throw new MockPersistedRecordError("MOCK_PERSISTED_RECORD_TOO_LARGE", `mock persisted record exceeds ${MOCK_PERSISTED_RECORD_MAX_BYTES} UTF-8 bytes`);
  }
  return json;
}
const MOCK_INBOUND_ID_BYTES = 512;

function isSafeMockAnswerId(value: unknown): value is string {
  return isSafeEscalationId(value);
}

function isSafeMockAnswerText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_INBOX_TEXT_LENGTH
    && !/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function isSafeMockAnswerMetadata(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}
function parseMockAnswer(value: unknown): EscalationAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["id", "run_id", "answer", "at", "by", "stale"].includes(key))) return null;
  if (!isSafeMockAnswerId(raw.id) || !isSafeCtoRunId(raw.run_id) || !isSafeMockAnswerText(raw.answer)) return null;
  if (!isSafeMockAnswerMetadata(raw.at, 128) || !isSafeMockAnswerMetadata(raw.by, 128)) return null;
  if (raw.stale !== undefined && typeof raw.stale !== "boolean") return null;
  return {
    id: raw.id,
    run_id: raw.run_id,
    answer: raw.answer,
    at: raw.at,
    by: raw.by,
    ...(raw.stale === undefined ? {} : { stale: raw.stale }),
  };
}
interface ParsedMockInbound {
  readonly id: string;
  readonly text: string;
  readonly at?: string;
  readonly by?: string;
}

interface MockInboundParseResult {
  readonly record?: ParsedMockInbound;
  readonly reason?: string;
  readonly id?: string;
}

function parseMockInbound(value: unknown): MockInboundParseResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { reason: "malformed inbound identity" };
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id.trim().length > 0 && isSafeMockAnswerMetadata(raw.id, MOCK_INBOUND_ID_BYTES)
    ? raw.id
    : undefined;
  if (id === undefined || typeof raw.text !== "string") {
    return { reason: "malformed (missing id or text)", ...(id === undefined ? {} : { id }) };
  }
  if (raw.text.trim().length === 0) return { reason: "empty text", id };
  if (Buffer.byteLength(raw.text, "utf8") > MAX_INBOX_TEXT_LENGTH) return { reason: "text exceeds MAX_INBOX_TEXT_LENGTH", id };
  if (!isSafeMockAnswerText(raw.text)) return { reason: "malformed inbound text", id };
  if (Object.keys(raw).some((key) => !["id", "text", "at", "by"].includes(key))) return { reason: "malformed inbound identity", id };
  if (raw.at !== undefined && !isSafeMockAnswerMetadata(raw.at, 128)) return { reason: "malformed inbound identity", id };
  if (raw.by !== undefined && !isSafeMockAnswerMetadata(raw.by, 128)) return { reason: "malformed inbound identity", id };
  return {
    record: {
      id,
      text: raw.text,
      ...(typeof raw.at === "string" ? { at: raw.at } : {}),
      ...(typeof raw.by === "string" ? { by: raw.by } : {}),
    },
  };
}
function assertMockAnswerInput(runId: string, escId: string, answer: string, by: string): void {
  if (
    !isSafeCtoRunId(runId)
    || !isSafeMockAnswerId(escId)
    || !isSafeMockAnswerText(answer)
    || !isSafeMockAnswerMetadata(by, 128)
  ) {
    throw new MockPersistedRecordError("MOCK_PERSISTED_INPUT_INVALID", "mock answer fields exceed their bounded UTF-8 input contract");
  }
}

function assertMockInboundInput(text: string, by: string): void {
  if (!isSafeMockAnswerText(text) || !isSafeMockAnswerMetadata(by, 128)) {
    throw new MockPersistedRecordError("MOCK_PERSISTED_INPUT_INVALID", "mock inbound fields exceed their bounded UTF-8 input contract");
  }
}


interface BoundedPersistedRead {
  readonly text?: string;
  readonly reason?: string;
}
interface PersistedEscalationPayload {
  readonly esc: Escalation;
  readonly json: string;
  readonly digest: string;
}

function inspectPersistedEscalation(value: unknown): PersistedEscalationPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (validateEscalation(value as Escalation) !== null) return null;
    const json = JSON.stringify(value);
    if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MOCK_PERSISTED_RECORD_MAX_BYTES) return null;
    return {
      esc: value as Escalation,
      json,
      digest: createHash("sha256").update(json, "utf8").digest("hex"),
    };
  } catch {
    return null;
  }
}

function persistedReceiptPath(idempotencyDir: string, key: string): string {
  return join(idempotencyDir, "receipts", createHash("sha256").update(key, "utf8").digest("hex") + ".json");
}

function parsePersistedReceipt(value: unknown, key: string, expected: PersistedEscalationPayload): Escalation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== 1 || raw.key !== key || raw.digest !== expected.digest) return null;
  if (!raw.esc || Object.keys(raw).some((name) => !["schema", "key", "digest", "esc"].includes(name))) return null;
  const actual = inspectPersistedEscalation(raw.esc);
  return actual?.digest === expected.digest && actual.json === expected.json ? actual.esc : null;
}

function parsePersistedOutboundLine(value: unknown, key: string, expected: PersistedEscalationPayload): Escalation | "conflict" | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.idempotencyKey !== key || !raw.esc) return null;
  const actual = inspectPersistedEscalation(raw.esc);
  if (!actual || raw.escId !== actual.esc.id) return null;
  if (actual.digest !== expected.digest || actual.json !== expected.json) return "conflict";
  if (raw.title !== actual.esc.title || raw.body !== actual.esc.body) return null;
  const receipt = raw.receipt;
  if (
    receipt === null
    || typeof receipt !== "object"
    || Array.isArray(receipt)
    || (receipt as Record<string, unknown>).sent !== true
    || ((receipt as Record<string, unknown>).channelRef !== undefined && typeof (receipt as Record<string, unknown>).channelRef !== "string")
  ) return null;
  return actual.esc;
}


interface MockProcessOwner {
  pid: number;
  start_identity?: string;
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


function persistedLockTarget(): string {
  const startIdentity = processStartIdentity();
  if (!startIdentity) throw new Error("mock persisted idempotency lock process identity unavailable");
  return JSON.stringify({ schema: 2, pid: process.pid, start_identity: startIdentity });
}


/** Persisted fake-RW mode options (see the module docblock for the layout). */
export interface MockPersistedOptions {
  dir: string;
  /** Borrowed project-root path used to anchor every persisted operation. */
  root?: string;
}

export class MockEscalationAdapter implements EscalationAdapter {
  readonly kind = "mock";

  /** All escalations handed to send() — test helper, not part of the adapter interface. */
  sentEscalations: Escalation[] = [];
  private readonly autoAnswer?: (esc: Escalation) => string | null;
  private readonly defaultRunId?: string;
  private readonly persisted?: MockPersistedOptions;
  private readonly persistedRootPath?: string;
  private readonly pinStorage = new AsyncLocalStorage<PinnedProjectRoot>();
  private queuedAnswers: EscalationAnswer[] = [];
  private cancelled = new Set<string>();
  private plainHandler: ((msg: EscalationInboundMessage, pinnedRoot?: PinnedProjectRoot) => void | Promise<void>) | null = null;
  private readonly plainTextLog: Array<{ target: string; text: string; at: string }> = [];
  private counter = 0;
  private answersCursor: string | null = null;
  private inboundCursor: string | null = null;

  /**
   * @param opts.fetchImpl  deliberately unusable — the mock is in-process only
   *                        (D4: no network, no HTTP, no Telegram token).
   * @param opts.autoAnswer when it returns a non-null string, send() auto-queues
   *                        that answer for the escalation (round-trip shortcut).
   * @param opts.runId canonical run owning injected/automatic answers.
   * @param opts.persisted  opt-in fake-RW file mode (see module docblock);
   *                        absent -> EXACT in-memory behavior.
   */
  constructor(opts?: { fetchImpl?: never; runId?: string; autoAnswer?: (esc: Escalation) => string | null; persisted?: MockPersistedOptions }) {
    if (opts?.fetchImpl) {
      throw new Error("MockEscalationAdapter is in-process only: no network fetch is available (fetchImpl is deliberately unusable)");
    }
    if (opts?.runId !== undefined && !isSafeCtoRunId(opts.runId)) {
      throw new Error("MockEscalationAdapter runId is invalid");
    }
    this.defaultRunId = opts?.runId;
    this.autoAnswer = opts?.autoAnswer;
    const persisted = opts?.persisted;
    if (persisted) {
      const dir = resolve(persisted.dir);
      const rootPath = persisted.root === undefined
        ? (isAbsolute(persisted.dir) ? dirname(dir) : process.cwd())
        : resolve(persisted.root);
      this.persisted = { ...persisted, dir };
      this.persistedRootPath = rootPath;
    }
  }
  private currentPinnedRoot(): PinnedProjectRoot {
    const pin = this.pinStorage.getStore();
    if (!pin) throw new Error("mock persisted storage is not pinned");
    return pin;
  }
  private openPinnedRoot(): { pin: PinnedProjectRoot; relativeDir: string } {
    if (!this.persisted || !this.persistedRootPath) throw new Error("mock persisted storage is not configured");
    const pin = PinnedProjectRoot.open(this.persistedRootPath);
    if (!pin) throw new Error("mock persisted storage project root cannot be pinned safely");
    const relativeDir = this.persisted.dir === pin.canonical_root ? "" : pin.relativePath(this.persisted.dir);
    if (relativeDir === null) {
      pin.close();
      throw new Error("mock persisted storage escapes its pinned project root");
    }
    try {
      pin.ensureDirectory(relativeDir);
    } catch (error) {
      // Multiple workers may open the same persisted root concurrently. The
      // anchored mkdir operation reports EEXIST for the loser; accept that
      // race only when the existing entry is still a real directory.
      const existingIsDirectory = relativeDir !== "" && pin.pathEntryInfo(relativeDir)?.kind === "directory";
      if (!isPersistedExistsError(error) || !existingIsDirectory) {
        pin.close();
        throw error;
      }
    }
    return { pin, relativeDir };
  }

  private withPinnedRoot<T>(operation: () => T): T {
    const existing = this.pinStorage.getStore();
    if (existing) return operation();
    const opened = this.openPinnedRoot();
    try {
      return this.pinStorage.run(opened.pin, operation);
    } finally {
      opened.pin.close();
    }
  }

  private async withPinnedRootAsync<T>(operation: () => Promise<T>): Promise<T> {
    const existing = this.pinStorage.getStore();
    if (existing) return operation();
    const opened = this.openPinnedRoot();
    try {
      return await this.pinStorage.run(opened.pin, operation);
    } finally {
      opened.pin.close();
    }
  }

  private persistedRelative(path: string): string {
    const pin = this.currentPinnedRoot();
    const absolute = resolve(path);
    const rootRelative = absolute === pin.canonical_root ? "" : pin.relativePath(absolute);
    if (rootRelative === null) throw new Error("mock persisted path escapes its pinned project root");
    return rootRelative;
  }

  private persistedPath(relativePath: string): string {
    return join(this.persisted!.dir, relativePath);
  }
  private persistedExists(path: string): boolean {
    const relativePath = this.persistedRelative(path);
    return relativePath.length === 0 || this.currentPinnedRoot().pathEntryExists(relativePath);
  }

  private ensurePersistedDirectory(path: string): void {
    const relativePath = this.persistedRelative(path);
    try {
      this.currentPinnedRoot().ensureDirectory(relativePath);
    } catch (error) {
      // Directory creation is shared by barriered processes. EEXIST is safe
      // only when the anchored no-follow lookup confirms a real directory.
      if (!isPersistedExistsError(error) || this.currentPinnedRoot().pathEntryInfo(relativePath)?.kind !== "directory") {
        throw error;
      }
    }
  }

  private ensurePersistedEntry(path: string): void {
    const info = this.currentPinnedRoot().pathEntryInfo(this.persistedRelative(path));
    if (!info || info.kind === "symlink") throw new Error(`mock persisted entry is not a safe path: ${path}`);
  }

  private ensurePersistedFile(path: string): void {
    const info = this.currentPinnedRoot().pathEntryInfo(this.persistedRelative(path));
    if (!info || info.kind !== "file") throw new Error(`mock persisted record is not a regular file: ${path}`);
  }

  private readPersisted(path: string, maxBytes: number): BoundedPersistedRead {
    try {
      const result = this.currentPinnedRoot().readFile(this.persistedRelative(path), { maxBytes });
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
      } catch {
        return { reason: "record is not valid UTF-8" };
      }
      return { text };
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      return { reason: code === "not_regular" ? "record is not a regular file" : "record is unreadable" };
    }
  }

  private writePersistedExclusive(path: string, content: string): void {
    this.currentPinnedRoot().writeExclusive(this.persistedRelative(path), content);
  }

  private writePersistedAtomic(path: string, content: string): void {
    this.currentPinnedRoot().writeAtomic(this.persistedRelative(path), content);
  }

  private removePersisted(path: string, missingOk = false): void {
    this.currentPinnedRoot().removeFile(this.persistedRelative(path), { missingOk });
  }

  private removePersistedEntry(path: string): void {
    this.currentPinnedRoot().removeEntry(this.persistedRelative(path));
  }

  private renamePersisted(source: string, destination: string): void {
    this.currentPinnedRoot().renameFile(this.persistedRelative(source), this.persistedRelative(destination));
  }

  private linkPersistedExclusive(source: string, destination: string): void {
    this.currentPinnedRoot().linkExclusive(this.persistedRelative(source), this.persistedRelative(destination));
  }

  private listPersisted(dir: string, cursor: string | null): { names: string[]; nextCursor: string | null } {
    const page = this.currentPinnedRoot().listDirectoryPage(this.persistedRelative(dir), {
      cursor,
      maxEntries: MOCK_QUEUE_PAGE_ENTRIES,
      maxScanEntries: MOCK_QUEUE_MAX_SCAN_ENTRIES,
      maxScanNameBytes: MOCK_QUEUE_MAX_SCAN_NAME_BYTES,
    });
    return { names: page.names, nextCursor: page.nextCursor };
  }

  private acquirePersistedLock(candidate: string, target: string, owner: string): boolean {
    return this.currentPinnedRoot().tryAcquireExclusiveLock(this.persistedRelative(candidate), this.persistedRelative(target), owner, { ownerlessGraceMs: MOCK_LEGACY_CLAIM_GRACE_MS });
  }

  private removePersistedIfUnchanged(path: string): boolean {
    try {
      const relativePath = this.persistedRelative(path);
      const info = this.currentPinnedRoot().pathEntryInfo(relativePath);
      if (!info) return false;
      if (info.kind === "symlink") {
        // Legacy lock fixtures may be symlinks. They are never followed; the
        // no-follow metadata check ensures only the observed link is removed.
        const current = this.currentPinnedRoot().pathEntryInfo(relativePath);
        if (!current || current.kind !== "symlink" || current.dev !== info.dev || current.ino !== info.ino) return false;
        this.currentPinnedRoot().removeEntry(relativePath);
        return true;
      }
      const observed = this.currentPinnedRoot().readFile(relativePath, { maxBytes: MOCK_PERSISTED_RECORD_MAX_BYTES });
      this.currentPinnedRoot().removeFileIfMatches(relativePath, {
        dev: observed.dev,
        ino: observed.ino,
        sha256: createHash("sha256").update(observed.bytes).digest("hex"),
      });
      return true;
    } catch {
      return false;
    }
  }
  private releasePersistedLock(target: string, token: string): boolean {
    return this.currentPinnedRoot().releaseExclusiveLock(this.persistedRelative(target), token);
  }

  /** Record an escalation without a durable idempotency contract. */
  async send(esc: Escalation, suppliedPin?: PinnedProjectRoot): Promise<EscalationReceipt> {
    if (this.persisted) {
      if (suppliedPin) {
        if (!suppliedPin.isStable()) return { sent: false, channelRef: "mock:root-changed" };
        return this.pinStorage.run(suppliedPin, async () => {
          this.recordSend(esc);
          return { sent: true, channelRef: "mock:" + esc.id };
        });
      }
      return this.withPinnedRootAsync(async () => {
        this.recordSend(esc);
        return { sent: true, channelRef: "mock:" + esc.id };
      });
    }
    this.recordSend(esc);
    return { sent: true, channelRef: "mock:" + esc.id };
  }

  /** Durable receiver-side idempotency keyed by the dispatcher delivery id. */
  async sendWithIdempotency(esc: Escalation, idempotencyKey: string, suppliedPin?: PinnedProjectRoot): Promise<EscalationReceipt> {
    if (this.persisted) {
      if (suppliedPin) {
        if (!suppliedPin.isStable()) return { sent: false, channelRef: "mock:root-changed" };
        return this.pinStorage.run(suppliedPin, () => this.sendWithIdempotencyPinned(esc, idempotencyKey));
      }
      return this.withPinnedRootAsync(() => this.sendWithIdempotencyPinned(esc, idempotencyKey));
    }
    return this.sendWithIdempotencyPinned(esc, idempotencyKey);
  }
  private async sendWithIdempotencyPinned(esc: Escalation, idempotencyKey: string): Promise<EscalationReceipt> {
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw new Error("mock idempotency key is required");
    }
    const key = idempotencyKey.trim();
    if (Buffer.byteLength(key, "utf8") > MOCK_IDEMPOTENCY_KEY_MAX_BYTES) {
      throw new MockPersistedRecordError("MOCK_PERSISTED_RECORD_TOO_LARGE", `mock idempotency key exceeds ${MOCK_IDEMPOTENCY_KEY_MAX_BYTES} UTF-8 bytes`);
    }
    const expected = inspectPersistedEscalation(esc);
    if (this.persisted && !expected) throw new Error("mock escalation envelope is invalid");
    const payload = expected?.json ?? JSON.stringify(esc);
    const preparedMarkerJson = this.persisted
      ? serializeMockPersistedRecord({ key, status: "prepared", esc: expected!.esc })
      : undefined;
    const cachedPayload = this.idempotentPayloads.get(key);
    if (cachedPayload && cachedPayload !== payload) {
      throw new Error("mock idempotency key is already bound to another escalation");
    }
    const cached = this.idempotentReceipts.get(key);
    if (cached) return cached;
    if (!this.persisted) {
      const receipt = { sent: true, channelRef: "mock:" + esc.id };
      this.idempotentPayloads.set(key, payload);
      this.idempotentReceipts.set(key, receipt);
      this.recordSend(esc);
      return receipt;
    }
    const result = this.withPersistedIdempotencyLock(key, () => {
      const dir = join(this.persisted!.dir, "outbound", "idempotency");
      this.ensurePersistedDirectory(dir);
      const marker = join(dir, createHash("sha256").update(key, "utf8").digest("hex") + ".json");
      let markerRecord: { key: string; status: "prepared" | "delivered"; esc: Escalation } | null = null;
      if (this.persistedExists(marker)) {
        const loaded = this.readPersisted(marker, MOCK_PERSISTED_RECORD_MAX_BYTES);
        let parsed: unknown;
        try {
          if (loaded.text === undefined) throw new Error("invalid marker");
          parsed = JSON.parse(loaded.text);
        } catch {
          this.quarantinePersistedIdempotencyFile(marker);
          throw new Error("mock idempotency receipt is malformed");
        }
        if (
          parsed === null
          || typeof parsed !== "object"
          || Array.isArray(parsed)
          || !("key" in parsed)
          || !("status" in parsed)
          || !("esc" in parsed)
        ) {
          this.quarantinePersistedIdempotencyFile(marker);
          throw new Error("mock idempotency receipt is malformed");
        }
        const raw = parsed as Record<string, unknown>;
        const markerEsc = inspectPersistedEscalation(raw.esc);
        if (
          raw.key !== key
          || (raw.status !== "prepared" && raw.status !== "delivered")
          || !markerEsc
          || !expected
          || markerEsc.digest !== expected.digest
          || markerEsc.json !== expected.json
        ) {
          throw new Error("mock idempotency key is already bound to another escalation");
        }
        markerRecord = { key, status: raw.status, esc: markerEsc.esc };
      } else {
        if (!expected) throw new Error("mock escalation envelope is invalid");
        markerRecord = { key, status: "prepared", esc: expected.esc };
        this.writePersistedExclusive(marker, preparedMarkerJson!);
      }

      if (!expected) throw new Error("mock escalation envelope is invalid");
      if (markerRecord.status === "delivered") {
        this.writePersistedReceipt(dir, key, expected);
        return { esc: markerRecord.esc, first: false };
      }
      const prior = this.persistedOutboundRecord(key, expected);
      if (prior) {
        this.writePersistedReceipt(dir, key, expected);
        this.writePersistedIdempotencyMarker(marker, { ...markerRecord, status: "delivered" });
        return { esc: prior, first: false };
      }

      this.appendOutboundMessage(esc, key);
      this.writePersistedReceipt(dir, key, expected);
      this.writePersistedIdempotencyMarker(marker, { ...markerRecord, status: "delivered" });
      return { esc, first: true };
    });
    const receipt = { sent: true, channelRef: "mock:" + result.esc.id };
    this.idempotentPayloads.set(key, payload);
    this.idempotentReceipts.set(key, receipt);
    if (result.first) this.recordAutoAnswer(result.esc);
    return receipt;
  }

  private readonly idempotentPayloads = new Map<string, string>();
  private readonly idempotentReceipts = new Map<string, EscalationReceipt>();

  private recordSend(esc: Escalation): void {
    this.sentEscalations.push(esc);
    if (this.persisted) this.appendOutboundMessage(esc);
    this.recordAutoAnswer(esc);
  }

  private recordAutoAnswer(esc: Escalation): void {
    if (!this.autoAnswer || !this.defaultRunId) return;
    const answer = this.autoAnswer(esc);
    if (typeof answer === "string") {
      this.queuedAnswers.push({ id: esc.id, run_id: this.defaultRunId, answer, at: new Date().toISOString(), by: "mock" });
    }
  }

  /** Mark the escalation id cancelled; its answers become stale (R5). */
  async cancel(id: string): Promise<void> {
    this.cancelled.add(id);
  }

  /**
   * Drain queued answers (persisted mode: answers/ files renamed to
   * answers/processed/ merged with the in-memory queue; a record is
   * returned once even when present in both) then drain inbound/ tasks into
   * the stored plain handler. Never throws.
   */
  async pollOnce(suppliedPin?: PinnedProjectRoot): Promise<EscalationAnswer[]> {
    if (this.persisted) {
      if (suppliedPin) {
        if (!suppliedPin.isStable()) return [];
        return this.pinStorage.run(suppliedPin, () => this.pollOncePinned());
      }
      return this.withPinnedRootAsync(() => this.pollOncePinned());
    }
    return this.pollOncePinned();
  }

  private async pollOncePinned(): Promise<EscalationAnswer[]> {
    const fromDisk = this.persisted ? this.drainPersistedAnswers() : [];
    const merged = new Map<string, EscalationAnswer>();
    for (const candidate of [...fromDisk, ...this.queuedAnswers]) {
      const answer = parseMockAnswer(candidate);
      if (answer) merged.set(answer.id, answer);
    }
    this.queuedAnswers = [];
    if (this.persisted) await this.drainPersistedInbound();
    return [...merged.values()].map((answer) => (this.cancelled.has(answer.id) ? { ...answer, stale: true } : answer));
  }

  /** Store the plain (non-answer) inbound message handler for injectPlainMessage/injectTask. */
  setPlainMessageHandler(handler: (msg: EscalationInboundMessage, pinnedRoot?: PinnedProjectRoot) => void | Promise<void>): void {
    this.plainHandler = handler;
  }

  /** Fence inbound callbacks during dispatcher takeover/shutdown. */
  clearPlainMessageHandler(): void {
    this.plainHandler = null;
  }

  async sendPlainText(target: string, text: string, suppliedPin?: PinnedProjectRoot): Promise<{ sent: true; status: "sent"; channelRef: string } | { sent: false; status: "retryable"; channelRef: string; reason: string }> {
    if (this.persisted) {
      if (suppliedPin) {
        if (!suppliedPin.isStable()) return { sent: false, status: "retryable", channelRef: "mock:root-changed", reason: "project root changed" };
        return this.pinStorage.run(suppliedPin, () => this.sendPlainTextPinned(target, text));
      }
      return this.withPinnedRootAsync(() => this.sendPlainTextPinned(target, text));
    }
    return this.sendPlainTextPinned(target, text);
  }

  private async sendPlainTextPinned(target: string, text: string): Promise<{ sent: true; status: "sent"; channelRef: string }> {
    const at = new Date().toISOString();
    const channelRef = `mock:plain:${this.nextId()}`;
    this.plainTextLog.push({ target, text, at });
    if (this.persisted) {
      const dir = join(this.persisted!.dir, "outbound");
      this.ensurePersistedDirectory(dir);
      this.appendPersistedLog(join(dir, "plain.jsonl"), JSON.stringify({ target, text, at, receipt: { sent: true, channelRef } }));
    }
    return { sent: true, status: "sent", channelRef };
  }

  // ── Test helpers (public, NOT part of the EscalationAdapter interface) ──

  /** Queue an answer for an escalation; the owning run is explicit. */
  injectAnswer(runId: string, escId: string, answer: string, by = "mock"): void {
    assertMockAnswerInput(runId, escId, answer, by);
    if (this.persisted) {
      this.withPinnedRoot(() => this.injectAnswerPinned(runId, escId, answer, by));
      return;
    }
    this.injectAnswerPinned(runId, escId, answer, by);
  }

  private injectAnswerPinned(runId: string, escId: string, answer: string, by: string): void {
    const record: EscalationAnswer = { id: escId, run_id: runId, answer, at: new Date().toISOString(), by };
    if (this.persisted) this.persistJson(join(this.persisted.dir, "answers"), "ans", record);
    this.queuedAnswers.push(record);
  }

  /** Persist and deliver a plain message through the same claim path as pollOnce. */
  async injectPlainMessage(text: string, by = "mock"): Promise<void> {
    assertMockInboundInput(text, by);
    const msg: { id: string; text: string; at: string; by?: string } = {
      id: `mock:plain:${this.nextId()}`,
      text,
      at: new Date().toISOString(),
      by,
    };
    if (!this.persisted) {
      await this.plainHandler?.(msg);
      return;
    }
    const path = this.withPinnedRoot(() => this.persistJson(join(this.persisted!.dir, "inbound"), "task", msg));
    if (this.plainHandler) await this.withPinnedRootAsync(async () => { await this.deliverPersistedInbound(path, basename(path)); });
  }

  /** Persist and deliver a plain task through the same claim path as pollOnce. */
  async injectTask(text: string, by = "mock"): Promise<void> {
    assertMockInboundInput(text, by);
    const msg: { id: string; text: string; at: string; by?: string } = {
      id: `mock:task:${this.nextId()}`,
      text,
      at: new Date().toISOString(),
      by,
    };
    if (!this.persisted) {
      await this.plainHandler?.(msg);
      return;
    }
    const path = this.withPinnedRoot(() => this.persistJson(join(this.persisted!.dir, "inbound"), "task", msg));
    if (this.plainHandler) await this.withPinnedRootAsync(async () => { await this.deliverPersistedInbound(path, basename(path)); });
  }

  /** Clear queues, logs, cancelled ids and the persisted fake-RW tree. */
  reset(): void {
    this.sentEscalations = [];
    this.queuedAnswers = [];
    this.idempotentPayloads.clear();
    this.idempotentReceipts.clear();
    this.cancelled.clear();
    this.plainHandler = null;
    this.plainTextLog.length = 0;
    this.counter = 0;
    this.answersCursor = null;
    this.inboundCursor = null;
    if (this.persisted) {
      this.withPinnedRoot(() => {
        for (const directory of ["answers", "inbound", "outbound"]) {
          const path = join(this.persisted!.dir, directory);
          if (!this.persistedExists(path)) continue;
          this.clearPersistedTree(path);
          this.currentPinnedRoot().removeDirectory(this.persistedRelative(path));
        }
      });
    }
  }
  private clearPersistedTree(dir: string): void {
    let cursor: string | null = null;
    const maxPages = Math.ceil(MOCK_QUEUE_MAX_SCAN_ENTRIES / MOCK_QUEUE_PAGE_ENTRIES);
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = this.listPersisted(dir, cursor);
      for (const name of page.names) {
        const path = join(dir, name);
        const info = this.currentPinnedRoot().pathEntryInfo(this.persistedRelative(path));
        if (!info) continue;
        if (info.kind === "directory") {
          this.clearPersistedTree(path);
          this.currentPinnedRoot().removeDirectory(this.persistedRelative(path));
        } else {
          this.removePersistedEntry(path);
        }
      }
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }
    throw new Error("mock reset bounded directory budget exceeded");
  }

  // ── Persisted fake-RW internals ──────────────────────────────────────────

  /**
   * Atomically persist `data` as `<dir>/<prefix>-<n>.json`. A private
   * cross-process sequence lock prevents counter collisions; hard-link
   * publication never replaces a foreign file.
   */
  private persistJson(dir: string, prefix: string, data: unknown): string {
    const serialized = serializeMockPersistedRecord(data);
    this.ensurePersistedDirectory(dir);
    return this.withPersistedPathLock(join(dir, ".sequence.lock"), () => {
      let n = this.nextId();
      for (;;) {
        const path = join(dir, `${prefix}-${n}.json`);
        const tmp = join(dir, `.tmp-${process.pid}-${randomUUID()}.json`);
        try {
          this.writePersistedExclusive(tmp, serialized);
          try {
            this.linkPersistedExclusive(tmp, path);
            this.removePersisted(tmp, true);
            this.ensurePersistedFile(path);
            return path;
          } catch (error) {
            if (!isPersistedExistsError(error)) throw error;
          }
        } finally {
          this.removePersisted(tmp, true);
        }
        n += 1;
      }
    });
  }

  private withPersistedPathLock<T>(lock: string, operation: () => T): T {
    this.ensurePersistedDirectory(dirname(lock));
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const lockName = basename(lock);
    const lockDir = dirname(lock);
    const target = join(lockDir, lockName);
    const candidate = join(lockDir, `.${lockName}.${process.pid}.${randomUUID()}.candidate`);
    const token = randomUUID();
    const ownerBase = JSON.parse(persistedLockTarget()) as { pid: number; start_identity: string };
    const owner = JSON.stringify({ ...ownerBase, token });
    const deadline = Date.now() + 30_000;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      if (attempts > 30_000 || Date.now() >= deadline) throw new Error("mock persisted lock acquisition timed out");
      if (this.acquirePersistedLock(candidate, target, owner)) break;
      if (!this.persistedOwnerIsLive(target)) {
        if (!this.removePersistedIfUnchanged(target) && this.persistedExists(target)) {
          throw new Error("mock persisted lock is unsafe or changed while reclaiming");
        }
        continue;
      }
      Atomics.wait(waitCell, 0, 0, 1);
    }
    try {
      return operation();
    } finally {
      try { this.releasePersistedLock(target, token); } catch { /* stale owner or replaced lock */ }
      this.removePersisted(candidate, true);
    }
  }
  private persistedOwnerIsLive(path: string): boolean {
    const info = this.currentPinnedRoot().pathEntryInfo(this.persistedRelative(path));
    if (!info || info.kind !== "file") return false;
    const age = Math.max(0, Date.now() - info.mtimeMs);
    const loaded = this.readPersisted(path, MOCK_PERSISTED_RECORD_MAX_BYTES);
    if (loaded.text === undefined) return age < MOCK_LEGACY_CLAIM_GRACE_MS;
    let raw: unknown;
    try { raw = JSON.parse(loaded.text); } catch { return age < MOCK_LEGACY_CLAIM_GRACE_MS; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return age < MOCK_LEGACY_CLAIM_GRACE_MS;
    const value = raw as Partial<MockProcessOwner>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return age < MOCK_LEGACY_CLAIM_GRACE_MS;
    if (!processIsLive(value.pid as number)) return false;
    if (typeof value.start_identity !== "string" || value.start_identity.length === 0) return age < MOCK_LEGACY_CLAIM_GRACE_MS;
    const actual = processStartIdentity(value.pid as number);
    return actual === null || actual === value.start_identity;
  }
  private withPersistedIdempotencyLock<T>(key: string, operation: () => T): T {
    const dir = join(this.persisted!.dir, "outbound", "idempotency");
    this.ensurePersistedDirectory(dir);
    return this.withPersistedPathLock(
      join(dir, createHash("sha256").update(`${key}\u0000lock`, "utf8").digest("hex") + ".lock"),
      operation,
    );
  }
  private writePersistedIdempotencyMarker(path: string, record: unknown): void {
    const serialized = serializeMockPersistedRecord(record);
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      this.ensurePersistedDirectory(dirname(path));
      this.writePersistedExclusive(tmp, serialized);
      this.renamePersisted(tmp, path);
      this.ensurePersistedFile(path);
    } finally {
      this.removePersisted(tmp, true);
    }
  }

  private quarantinePersistedIdempotencyFile(path: string): void {
    try {
      const rejected = join(dirname(path), "rejected");
      this.ensurePersistedDirectory(rejected);
      if (!this.persistedExists(path)) return;
      this.renamePersisted(path, join(rejected, `${basename(path)}.${randomUUID()}.rejected`));
    } catch {
      // Keep an unreadable/forged receipt durable for a later diagnostic pass.
    }
  }

  private writePersistedReceipt(dir: string, key: string, expected: PersistedEscalationPayload): void {
    const serialized = serializeMockPersistedRecord({ schema: 1, key, digest: expected.digest, esc: expected.esc });
    const receipts = join(dir, "receipts");
    this.ensurePersistedDirectory(receipts);
    const path = persistedReceiptPath(dir, key);
    try {
      this.writePersistedExclusive(path, serialized);
    } catch (error) {
      if (!(error instanceof Error) || !String(error.message).includes("already exists")) throw error;
      const loaded = this.readPersisted(path, MOCK_PERSISTED_RECORD_MAX_BYTES);
      let valid = false;
      try {
        valid = loaded.text !== undefined && parsePersistedReceipt(JSON.parse(loaded.text), key, expected) !== null;
      } catch {
        valid = false;
      }
      if (!valid) {
        this.quarantinePersistedIdempotencyFile(path);
        throw new Error("mock idempotency receipt is malformed");
      }
    }
  }

  private persistedOutboundRecord(key: string, expected: PersistedEscalationPayload): Escalation | null {
    const dir = join(this.persisted!.dir, "outbound", "idempotency");
    const receipt = persistedReceiptPath(dir, key);
    if (this.persistedExists(receipt)) {
      const loaded = this.readPersisted(receipt, MOCK_PERSISTED_RECORD_MAX_BYTES);
      let parsed: unknown;
      try {
        if (loaded.text === undefined) throw new Error("invalid receipt");
        parsed = JSON.parse(loaded.text);
      } catch {
        this.quarantinePersistedIdempotencyFile(receipt);
        throw new Error("mock idempotency receipt is malformed");
      }
      const valid = parsePersistedReceipt(parsed, key, expected);
      if (!valid) {
        this.quarantinePersistedIdempotencyFile(receipt);
        throw new Error("mock idempotency receipt conflicts with the requested escalation");
      }
      return valid;
    }
    const loaded = this.readPersisted(join(this.persisted!.dir, "outbound", "messages.jsonl"), MOCK_PERSISTED_LOG_MAX_BYTES);
    if (loaded.text === undefined) return null;
    const lines = loaded.text.split("\n");
    if (lines.length > MOCK_PERSISTED_LOG_MAX_LINES + 1) return null;
    for (const line of lines) {
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MOCK_PERSISTED_LOG_LINE_MAX_BYTES) continue;
      try {
        const found = parsePersistedOutboundLine(JSON.parse(line), key, expected);
        if (found === "conflict") throw new Error("mock idempotency key is already bound to another escalation");
        if (found) return found;
      } catch (error) {
        if (error instanceof Error && error.message === "mock idempotency key is already bound to another escalation") throw error;
      }
    }
    return null;
  }

  private appendPersistedLog(path: string, line: string): void {
    const lock = `${path}.lock`;
    this.withPersistedPathLock(lock, () => {
      let existing = "";
      if (this.persistedExists(path)) {
        const loaded = this.readPersisted(path, MOCK_PERSISTED_LOG_MAX_BYTES);
        if (loaded.text === undefined) throw new Error("mock persisted log is unreadable or exceeds its bound");
        existing = loaded.text;
      }
      const next = `${existing}${line}\n`;
      if (Buffer.byteLength(next, "utf8") > MOCK_PERSISTED_LOG_MAX_BYTES) {
        throw new Error("mock persisted log exceeds its bounded byte limit");
      }
      if (Buffer.byteLength(line, "utf8") > MOCK_PERSISTED_LOG_LINE_MAX_BYTES) {
        throw new Error("mock persisted log line exceeds its bounded byte limit");
      }
      this.writePersistedAtomic(path, next);
    });
  }

  /** Append one JSON line to outbound/messages.jsonl, once per key. */
  private appendOutboundMessage(esc: Escalation, idempotencyKey?: string): void {
    const dir = join(this.persisted!.dir, "outbound");
    this.ensurePersistedDirectory(dir);
    const envelope = esc as Escalation & { intent?: string };
    const record = {
      escId: esc.id,
      idempotencyKey,
      intent: envelope.intent,
      title: esc.title,
      body: esc.body,
      esc,
      at: new Date().toISOString(),
      receipt: { sent: true, channelRef: "mock:" + esc.id },
    };
    this.appendPersistedLog(join(dir, "messages.jsonl"), JSON.stringify(record));
  }

  /**
   * Drain answers/ files: read -> rename to answers/processed/. The rename
   * quarantined under `answers/rejected/` so they cannot starve later rows.
   */
  private drainPersistedAnswers(): EscalationAnswer[] {
    const dir = join(this.persisted!.dir, "answers");
    const out: EscalationAnswer[] = [];
    try {
      if (!this.persistedExists(dir)) return out;
      this.ensurePersistedDirectory(dir);
      const processed = join(dir, "processed");
      const rejected = join(dir, "rejected");
      this.ensurePersistedDirectory(processed);
      this.ensurePersistedDirectory(rejected);
      const page = this.listPersisted(dir, this.answersCursor);
      let workBytes = 0;
      let lastProcessed: string | null = null;
      let blocked = false;
      for (const name of page.names) {
        if (!name.endsWith(".json")) continue;
        const path = join(dir, name);
        const loaded = this.readPersisted(path, MOCK_PERSISTED_RECORD_MAX_BYTES);
        if (loaded.text === undefined) {
          this.quarantinePersistedAnswer(path, name, rejected);
          lastProcessed = name;
          continue;
        }
        const recordBytes = Buffer.byteLength(loaded.text, "utf8");
        if (workBytes + recordBytes > MOCK_QUEUE_MAX_TOTAL_BYTES) {
          blocked = true;
          break;
        }
        workBytes += recordBytes;
        let raw: unknown;
        try {
          raw = JSON.parse(loaded.text) as unknown;
        } catch {
          this.quarantinePersistedAnswer(path, name, rejected);
          lastProcessed = name;
          continue;
        }
        const answer = parseMockAnswer(raw);
        if (!answer) {
          this.quarantinePersistedAnswer(path, name, rejected);
          lastProcessed = name;
          continue;
        }
        const destination = join(processed, name);
        if (this.persistedExists(destination)) {
          const archived = this.readPersisted(destination, MOCK_PERSISTED_RECORD_MAX_BYTES);
          if (archived.text !== loaded.text) {
            blocked = true;
            break;
          }
          this.removePersisted(path, true);
        } else {
          this.renamePersisted(path, destination);
        }
        out.push(answer);
        lastProcessed = name;
      }
      if (!blocked && page.nextCursor === null) {
        this.answersCursor = null;
      } else if (lastProcessed !== null) {
        this.answersCursor = lastProcessed;
      }
    } catch {
      // bounded listing/read/rename failure — leave the queue durable for retry
    }
    return out;
  }

  private quarantinePersistedAnswer(path: string, name: string, rejected: string): void {
    try {
      const destination = join(rejected, `${name}.${randomUUID()}.rejected.json`);
      if (!this.persistedExists(path)) return;
      this.renamePersisted(path, destination);
    } catch {
      // Keep an unreadable/contended answer durable for a later diagnostic pass.
    }
  }

  /**
   * Drain inbound files through an atomic processing claim. A claimed file is
   * invisible to concurrent pollers; a handler failure restores it to
   * `inbound/`, while successful delivery moves it to `processed/`.
   */
  private async drainPersistedInbound(): Promise<void> {
    const dir = join(this.persisted!.dir, "inbound");
    try {
      if (!this.persistedExists(dir)) return;
      this.ensurePersistedDirectory(dir);
      this.recoverInboundClaims(dir);
      const page = this.listPersisted(dir, this.inboundCursor);
      let workBytes = 0;
      let blocked = false;
      let lastProcessed: string | null = null;
      for (const name of page.names) {
        if (!name.endsWith(".json")) continue;
        const used = await this.deliverPersistedInbound(join(dir, name), name, MOCK_QUEUE_MAX_TOTAL_BYTES - workBytes);
        if (used < 0) {
          blocked = true;
          break;
        }
        workBytes += used;
        lastProcessed = name;
      }
      if (!blocked && page.nextCursor === null) this.inboundCursor = null;
      else if (lastProcessed !== null) this.inboundCursor = lastProcessed;
    } catch {
      // bounded listing/read/claim failure — leave the queue durable for retry
    }
  }

  private claimInboundFile(path: string, name: string): string | null {
    const startIdentity = processStartIdentity();
    if (!startIdentity) return null;
    const dir = join(this.persisted!.dir, "inbound");
    const processing = join(dir, "processing");
    const claimed = join(processing, name);
    const marker = `${claimed}.claim`;
    let markerWritten = false;
    try {
      this.ensurePersistedDirectory(dir);
      this.ensurePersistedDirectory(processing);
      this.ensurePersistedEntry(path);
      this.writePersistedExclusive(marker, JSON.stringify({ schema: 2, pid: process.pid, start_identity: startIdentity, owner: randomUUID() }));
      markerWritten = true;
      this.renamePersisted(path, claimed);
      return claimed;
    } catch {
      if (markerWritten) this.removePersisted(marker, true);
      return null;
    }
  }

  private recoverInboundClaims(dir: string): void {
    const processing = join(dir, "processing");
    if (!this.persistedExists(processing)) return;
    this.ensurePersistedDirectory(processing);
    const rejected = join(dir, "rejected");
    this.ensurePersistedDirectory(rejected);
    let cursor: string | null = null;
    const maxPages = Math.ceil(MOCK_QUEUE_MAX_SCAN_ENTRIES / MOCK_QUEUE_PAGE_ENTRIES);
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      let page: { names: string[]; nextCursor: string | null };
      try {
        page = this.listPersisted(processing, cursor);
      } catch {
        return;
      }
      for (const name of page.names) {
        if (!name.endsWith(".json")) continue;
        const claimed = join(processing, name);
        const marker = `${claimed}.claim`;
        if (this.persistedOwnerIsLive(marker)) continue;
        try {
          this.ensurePersistedEntry(claimed);
          const rejectedPath = join(rejected, name);
          const rejectionRecord = `${rejectedPath}.json`;
          if (this.persistedExists(rejectionRecord)) {
            this.ensurePersistedFile(rejectionRecord);
            if (this.persistedExists(rejectedPath)) {
              this.ensurePersistedEntry(rejectedPath);
              this.removePersistedEntry(claimed);
            } else {
              this.renamePersisted(claimed, rejectedPath);
            }
          } else if (!this.persistedExists(join(dir, name))) {
            this.renamePersisted(claimed, join(dir, name));
          }
          this.removePersisted(marker, true);
        } catch {
          // Leave the processing file for the next poll to recover.
        }
      }
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }

  }
  private async deliverPersistedInbound(path: string, name: string, remainingBytes = MOCK_QUEUE_MAX_TOTAL_BYTES): Promise<number> {
    if (!this.persisted) return 0;
    const dir = join(this.persisted.dir, "inbound");
    const claimed = this.claimInboundFile(path, name);
    if (!claimed) return 0;
    this.ensurePersistedEntry(claimed);
    const marker = `${claimed}.claim`;
    const processed = join(dir, "processed");
    let terminal = false;
    try {
      const loaded = this.readPersisted(claimed, MOCK_PERSISTED_RECORD_MAX_BYTES);
      if (loaded.text === undefined) {
        terminal = this.moveInboundToRejected(claimed, name, loaded.reason ?? "record is unreadable");
        return MOCK_PERSISTED_RECORD_MAX_BYTES;
      }
      const recordBytes = Buffer.byteLength(loaded.text, "utf8");
      if (recordBytes > remainingBytes) return -1;
      let raw: unknown;
      try {
        raw = JSON.parse(loaded.text) as unknown;
      } catch {
        terminal = this.moveInboundToRejected(claimed, name, "malformed JSON");
        return recordBytes;
      }
      const parsed = parseMockInbound(raw);
      if (!parsed.record) {
        terminal = this.moveInboundToRejected(claimed, name, parsed.reason ?? "malformed inbound identity", parsed.id);
        return recordBytes;
      }
      const { id, text, at, by } = parsed.record;
      const handler = this.plainHandler;
      if (!handler) return recordBytes;
      const msg: EscalationInboundMessage & { by?: string } = { id, text, at: at ?? new Date().toISOString(), ...(by === undefined ? {} : { by }) };
      try {
        const result = handler(msg, this.currentPinnedRoot());
        if (result) await result;
      } catch {
        return recordBytes;
      }
      this.ensurePersistedDirectory(processed);
      const destination = join(processed, name);
      if (this.persistedExists(destination)) {
        const archived = this.readPersisted(destination, MOCK_PERSISTED_RECORD_MAX_BYTES);
        if (archived.text === loaded.text) this.removePersistedEntry(claimed);
        else throw new Error("mock processed archive collision");
      } else {
        this.renamePersisted(claimed, destination);
      }
      terminal = true;
      return recordBytes;
    } finally {
      if (!terminal) {
        try {
          if (this.persistedExists(claimed) && !this.persistedExists(path)) this.renamePersisted(claimed, path);
        } catch {
          // Leave processing file for crash recovery.
        }
      }
      this.removePersisted(marker, true);
    }
  }

  private moveInboundToRejected(path: string, name: string, reason: string, id?: string): boolean {
    const rejectedDir = join(this.persisted!.dir, "inbound", "rejected");
    const rejectedPath = join(rejectedDir, name);
    const recordPath = `${rejectedPath}.json`;
    const tmpRecordPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      this.ensurePersistedDirectory(rejectedDir);
      this.ensurePersistedEntry(path);
      const record: { file: string; reason: string; at: string; id?: string } = { file: name, reason, at: new Date().toISOString(), ...(id !== undefined ? { id } : {}) };
      this.writePersistedExclusive(tmpRecordPath, JSON.stringify(record, null, 2));
      this.renamePersisted(tmpRecordPath, recordPath);
      if (this.persistedExists(rejectedPath)) {
        this.ensurePersistedEntry(rejectedPath);
        this.removePersistedEntry(path);
      } else {
        this.renamePersisted(path, rejectedPath);
      }
      return true;
    } catch {
      return false;
    } finally {
      this.removePersisted(tmpRecordPath, true);
    }
  }

  private nextId(): number {
    this.counter += 1;
    return this.counter;
  }
}

/**
 * Register the mock transport so `.omp/escalation.json` `{"adapter":"mock"}`
 * (and the `loadEscalationConfig` + `createEscalationAdapter` path) builds it
 * like any built-in. Additive `config.mock = { persisted?: boolean, dir? }`:
 * `persisted: true` constructs the fake-RW adapter rooted at
 * `resolve(cwd, dir ?? ".omp/fake-rw")`; legacy `{adapter:"mock"}` (no
 * `mock` key) stays fully in-memory. This function is intentionally NOT called by any production module. Tests and
 * the E2E harness must invoke it explicitly, outside repository-controlled
 * configuration, before selecting the mock adapter. The registry→mock import
 * cycle is safe because the factory is registered only after evaluation
 * (function declarations are hoisted, and the factory closure defers class
 * access to construction time).
 *
 * SEC-5: the persisted `dir` is resolved under the project cwd, so it is
 * validated at this CONFIG boundary before resolving — an absolute dir or
 * one containing a `..` segment throws (the adapter would otherwise escape
 * the project cwd and write outside it). The constructor itself stays
 * permissive: direct construction with absolute tmp dirs is a test seam and
 * must keep working. A factory throw is handled by the registry callers
 * (createChannelSet degrades the adapter to null; createEscalationAdapter
 * returns null).
 */
export function registerMockAdapterForTesting(token: RegistryRegistrationToken): void {
  const factory: EscalationAdapterFactory = (config, cwd) => {
    // config.mock is an additive consumer field: { persisted?: boolean; dir?: string }.
    const mock = config.mock as { persisted?: boolean; dir?: string } | undefined;
    if (mock?.persisted === true) {
      if (mock.dir !== undefined) {
        const escapesCwd =
          isAbsolute(mock.dir) || mock.dir.split("/").concat(mock.dir.split("\\")).some((segment) => segment === "..");
        if (escapesCwd) {
          throw new Error(`mock persisted dir must be a relative path inside the project cwd (got "${mock.dir}")`);
        }
      }
      return new MockEscalationAdapter({ persisted: { dir: resolve(cwd, mock.dir ?? ".omp/fake-rw"), root: cwd } });
    }
    return new MockEscalationAdapter();
  };
  registerEscalationAdapter(token, "mock", factory, { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true });
}
