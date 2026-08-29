import { createHash } from "node:crypto";
import {
  isCanonicalRoot,
  validateWorkflowRunIdentity,
  type CanonicalRoot,
  type Escalation,
  type EscalationAdapter,
  type EscalationAnswer,
  type EscalationInboundMessage,
  type EscalationReceipt,
  type WorkflowRunIdentity,
} from "@andvl1/omp-workflows-core";
import {
  isChannelAdmission,
  isFullstackStorageAuthority,
  type ChannelAdmission,
  type ChannelEndpointPolicy,
  type FullstackStorageAuthority,
  type StorageLease,
  type StorageResult,
} from "../storage-authority.js";
type PlainMessageHandler = (message: EscalationInboundMessage) => Promise<void>;

export interface TelegramAdapterOptions {
  readonly token: string;
  readonly chatId: string;
  readonly project_root: CanonicalRoot;
  readonly run_identity: WorkflowRunIdentity;
  readonly storage: FullstackStorageAuthority;
  readonly channel_admission: ChannelAdmission;
  readonly allowedChatIds: readonly string[];
  readonly allowedSenderIds: readonly string[];
  readonly channel_id?: string;
  readonly pollIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly onPlainMessage?: PlainMessageHandler;
}

class RetryableInboundTaskError extends Error {
  constructor() {
    super("telegram inbound task callback failed");
    this.name = "RetryableInboundTaskError";
  }
}
class MalformedTelegramDateError extends Error {
  constructor() {
    super("telegram plain message date is missing or invalid");
    this.name = "MalformedTelegramDateError";
  }
}

class TelegramHttpRejectedError extends Error {
  readonly method: "sendMessage" | "deleteMessage" | "getUpdates";
  readonly status: number;
  readonly definitive: boolean;

  constructor(method: "sendMessage" | "deleteMessage" | "getUpdates", status: number, definitive: boolean) {
    super(`telegram ${method} -> ${status}`);
    this.name = "TelegramHttpRejectedError";
    this.method = method;
    this.status = status;
    this.definitive = definitive;
  }
}

class TelegramPreSendError extends Error {
  readonly method: "sendMessage" | "deleteMessage" | "getUpdates";

  constructor(method: "sendMessage" | "deleteMessage" | "getUpdates", message: string) {
    super(message);
    this.name = "TelegramPreSendError";
    this.method = method;
  }
}


interface TgUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly date?: unknown;
    readonly text?: string;
    readonly chat?: { readonly id: number };
    readonly from?: { readonly id: number };
    readonly reply_to_message?: { readonly message_id: number };
  };
  readonly callback_query?: {
    readonly message?: { readonly message_id: number; readonly chat?: { readonly id: number } };
    readonly from?: { readonly id: number };
    readonly data?: string;
  };
}

interface TelegramMappingRecord {
  readonly schema_version: 1;
  readonly state: "pending" | "sent";
  readonly esc_id: string;
  readonly message_id?: number;
  readonly channel_id: string;
  readonly config_digest: string;
  readonly chat_id: string;
  readonly run_identity: WorkflowRunIdentity;
  readonly escalation_digest: string;
}
type MappingReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "pending" | "sent"; readonly record: TelegramMappingRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "unavailable" };

type EscIdLookupResult =
  | { readonly kind: "found"; readonly id: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" };


type AnswerWriteOutcome = "new" | "duplicate" | "quarantined" | "retry" | "poison";


interface TelegramAnswerRecord {
  readonly schema_version: 1;
  readonly id: string;
  readonly answer: string;
  readonly at: string;
  readonly by: string;
  readonly sender_id: string;
  readonly chat_id: string;
  readonly channel_id: string;
  readonly config_digest: string;
  readonly source_update_id: number;
  readonly source_message_id: number;
  readonly run_identity: WorkflowRunIdentity;
  readonly answer_digest: string;
}

type TelegramAnswer = EscalationAnswer & Readonly<{
  sender_id: string;
  chat_id: string;
  source_update_id: number;
  source_message_id: number;
}>;

const SAFE_ESC_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u;
const SAFE_CHANNEL_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SAFE_TELEGRAM_ID = /^-?[0-9]{1,20}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9:_-]{1,512}$/u;
const MAX_TELEGRAM_OPTION_ID_LENGTH = 128;
const SAFE_OPTION_ID = /^[\p{L}\p{M}\p{N}_-]+$/u;
const MAX_TELEGRAM_UPDATES = 100;
const MAX_TELEGRAM_REQUEST_BYTES = 64 * 1024;
const MAX_TELEGRAM_RESPONSE_BYTES = 1024 * 1024;
const MAX_TELEGRAM_TEXT_BYTES = 16 * 1024;
const MAX_TELEGRAM_MAP_RECORD_BYTES = 64 * 1024;
const MAX_TELEGRAM_MAP_ENTRIES = 1024;
const MAX_TELEGRAM_ANSWER_RECORD_BYTES = 64 * 1024;
const MAX_TELEGRAM_QUARANTINE_BYTES = 8 * 1024;
const MIN_TELEGRAM_TIMEOUT_MS = 100;
const MAX_TELEGRAM_TIMEOUT_MS = 60_000;
const MIN_TELEGRAM_DATE_SECONDS = 0;
const MAX_TELEGRAM_DATE_SECONDS = 8_640_000_000_000;
const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
const TELEGRAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({ "content-type": "application/json" });
const MAX_TELEGRAM_ESCALATION_ID_LENGTH = 512;
const MAX_TELEGRAM_QUARANTINE_ENTRIES = 1024;
const MIN_TELEGRAM_CALLBACK_DATA_BYTES = 1;
const MAX_TELEGRAM_CALLBACK_DATA_BYTES = 64;
const TELEGRAM_CALLBACK_DATA_LIMIT_REF = "tg:callback-data-limit" as const;
const TELEGRAM_DELIVERY_UNCERTAIN_REF = "tg:delivery-uncertain/manual-reconciliation" as const;

type TelegramCallbackDataPreflight =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly channelRef: typeof TELEGRAM_CALLBACK_DATA_LIMIT_REF };

function preflightTelegramCallbackData(id: string, optionId: string): TelegramCallbackDataPreflight {
  const callbackData = `${id}::${optionId}`;
  const byteLength = new TextEncoder().encode(callbackData).byteLength;
  if (byteLength < MIN_TELEGRAM_CALLBACK_DATA_BYTES || byteLength > MAX_TELEGRAM_CALLBACK_DATA_BYTES) {
    return { ok: false, channelRef: TELEGRAM_CALLBACK_DATA_LIMIT_REF };
  }
  return { ok: true, value: callbackData };
}

function isSafeEscId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TELEGRAM_ESCALATION_ID_LENGTH && SAFE_ESC_ID.test(value);
}

function isSafeTelegramId(value: unknown): value is string {
  return typeof value === "string" && SAFE_TELEGRAM_ID.test(value);
}
function isSafeTelegramOptionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TELEGRAM_OPTION_ID_LENGTH && SAFE_OPTION_ID.test(value);
}
function isValidTelegramDate(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && Number.isSafeInteger(value)
    && value >= MIN_TELEGRAM_DATE_SECONDS
    && value <= MAX_TELEGRAM_DATE_SECONDS;
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

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    const primitive = JSON.stringify(value);
    if (primitive === undefined) return "null";
    return primitive;
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function jsonBytes(value: unknown, maxBytes: number): Uint8Array {
  const text = canonicalJson(value);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) throw new Error("telegram durable record exceeds limit");
  return bytes;
}

function rejectOnAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined, cancel?: () => void): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    try { cancel?.(); } catch { /* request is already aborted */ }
    return Promise.reject(new Error("telegram request aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let onAbort: () => void = () => undefined;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { cancel?.(); } catch { /* request is already aborted */ }
      reject(new Error("telegram request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function responseTextBounded(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const stream = response.body;
  if (stream) {
    const reader = stream.getReader();
    const reading = (async () => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw new Error("telegram response body is not bytes");
        total += next.value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* limit is already determined */ }
          throw new Error("telegram response body exceeds limit");
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    })();
    return rejectOnAbort(reading, signal, () => {
      try {
        const cancelled = reader.cancel();
        void cancelled.catch(() => undefined);
      } catch { /* request is already aborted */ }
    });
  }
  if (typeof response.arrayBuffer === "function") {
    const reading = response.arrayBuffer().then((bytes) => {
      if (bytes.byteLength > maxBytes) throw new Error("telegram response body exceeds limit");
      return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    });
    return rejectOnAbort(reading, signal);
  }
  if (typeof response.text === "function") {
    const reading = response.text().then((text) => {
      if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("telegram response body exceeds limit");
      return text;
    });
    return rejectOnAbort(reading, signal);
  }
  if (typeof response.json === "function") {
    const reading = response.json().then((value) => {
      const text = canonicalJson(value);
      if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("telegram response body exceeds limit");
      return text;
    });
    return rejectOnAbort(reading, signal);
  }
  return Promise.reject(new Error("telegram response body is unavailable"));
}

function endpointPolicyFor(admission: ChannelAdmission, entry: Record<string, unknown>, channelId: string | undefined): ChannelEndpointPolicy | null {
  const key = channelId ?? (typeof entry.id === "string" && entry.id.length > 0 ? entry.id : "telegram");
  const policy = admission.endpoint_policy[key];
  if (policy) return policy;
  return key === "telegram" ? admission.endpoint_policy.telegram ?? null : null;
}

function policyTimeout(policy: ChannelEndpointPolicy): number {
  const value = policy.timeout_ms;
  if (value === undefined) return 35_000;
  if (!Number.isSafeInteger(value) || value < MIN_TELEGRAM_TIMEOUT_MS || value > MAX_TELEGRAM_TIMEOUT_MS) throw new TypeError("telegram endpoint timeout is unbounded");
  return value;
}

function policyBodyLimit(policy: ChannelEndpointPolicy): number {
  const value = policy.max_body_bytes;
  if (value === undefined) return MAX_TELEGRAM_REQUEST_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TELEGRAM_REQUEST_BYTES) throw new TypeError("telegram endpoint body limit is invalid");
  return value;
}

function validTelegramPolicy(policy: ChannelEndpointPolicy): boolean {
  if (policy.url !== undefined && policy.url !== TELEGRAM_API_ORIGIN) return false;
  if (policy.method !== undefined && policy.method !== "POST") return false;
  if (policy.headers !== undefined) {
    const headers = policy.headers;
    const names = Object.keys(headers);
    if (names.length !== 1 || names[0]?.toLowerCase() !== "content-type" || headers[names[0]!] !== "application/json") return false;
  }
  return true;
}

function checkedStorageResult<T>(action: () => StorageResult<T>): StorageResult<T> {
  try {
    return action();
  } catch {
    return { ok: false, reason: "IO", code: "IO", message: "storage operation failed" };
  }
}

function isTelegramRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isDefinitiveTelegramRejection(value: unknown, status: number): boolean {
  if (status < 400 || status >= 500 || !isTelegramRecord(value) || value.ok !== false) return false;
  const errorCode = value.error_code;
  return typeof errorCode === "number"
    && Number.isSafeInteger(errorCode)
    && errorCode === status
    && typeof value.description === "string"
    && new TextEncoder().encode(value.description).byteLength <= MAX_TELEGRAM_TEXT_BYTES;
}

function updateIdOf(value: unknown): number | null {
  if (!isTelegramRecord(value) || !("update_id" in value)) return null;
  const updateId = value.update_id;
  return typeof updateId === "number" && Number.isSafeInteger(updateId) && updateId >= 0 ? updateId : null;
}

function parseUpdate(value: unknown): TgUpdate | null {
  if (!isTelegramRecord(value) || !("update_id" in value)) return null;
  const updateId = value.update_id;
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) return null;
  let message: TgUpdate["message"];
  if ("message" in value && value.message !== undefined) {
    const candidate = value.message;
    if (!isTelegramRecord(candidate) || !("message_id" in candidate)) return null;
    const messageId = candidate.message_id;
    if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
    const date = candidate.date;
    const text = candidate.text;
    if ("text" in candidate && text !== undefined && typeof text !== "string") return null;
    if (typeof text === "string" && new TextEncoder().encode(text).byteLength > MAX_TELEGRAM_TEXT_BYTES) return null;
    let chat: { readonly id: number } | undefined;
    if ("chat" in candidate && candidate.chat !== undefined) {
      const chatCandidate = candidate.chat;
      if (!isTelegramRecord(chatCandidate) || !("id" in chatCandidate)
        || typeof chatCandidate.id !== "number" || !Number.isSafeInteger(chatCandidate.id)) return null;
      chat = { id: chatCandidate.id };
    }
    let from: { readonly id: number } | undefined;
    if ("from" in candidate && candidate.from !== undefined) {
      const fromCandidate = candidate.from;
      if (!isTelegramRecord(fromCandidate) || !("id" in fromCandidate)
        || typeof fromCandidate.id !== "number" || !Number.isSafeInteger(fromCandidate.id)) return null;
      from = { id: fromCandidate.id };
    }
    let reply: { readonly message_id: number } | undefined;
    if ("reply_to_message" in candidate && candidate.reply_to_message !== undefined) {
      const replyCandidate = candidate.reply_to_message;
      if (!isTelegramRecord(replyCandidate) || !("message_id" in replyCandidate)
        || typeof replyCandidate.message_id !== "number" || !Number.isSafeInteger(replyCandidate.message_id) || replyCandidate.message_id <= 0) return null;
      reply = { message_id: replyCandidate.message_id };
    }
    message = {
      message_id: messageId,
      ...("date" in candidate ? { date } : {}),
      ...(typeof text === "string" ? { text } : {}),
      ...(chat ? { chat } : {}),
      ...(from ? { from } : {}),
      ...(reply ? { reply_to_message: reply } : {}),
    };
  }
  let callbackQuery: TgUpdate["callback_query"];
  if ("callback_query" in value && value.callback_query !== undefined) {
    const candidate = value.callback_query;
    if (!isTelegramRecord(candidate)) return null;
    const data = candidate.data;
    if ("data" in candidate && data !== undefined && typeof data !== "string") return null;
    if (typeof data === "string" && new TextEncoder().encode(data).byteLength > MAX_TELEGRAM_TEXT_BYTES) return null;
    let callbackMessage: { readonly message_id: number; readonly chat?: { readonly id: number } } | undefined;
    if ("message" in candidate && candidate.message !== undefined) {
      const messageCandidate = candidate.message;
      if (!isTelegramRecord(messageCandidate) || !("message_id" in messageCandidate)
        || typeof messageCandidate.message_id !== "number" || !Number.isSafeInteger(messageCandidate.message_id) || messageCandidate.message_id <= 0) return null;
      let chat: { readonly id: number } | undefined;
      if ("chat" in messageCandidate && messageCandidate.chat !== undefined) {
        const chatCandidate = messageCandidate.chat;
        if (!isTelegramRecord(chatCandidate) || !("id" in chatCandidate)
          || typeof chatCandidate.id !== "number" || !Number.isSafeInteger(chatCandidate.id)) return null;
        chat = { id: chatCandidate.id };
      }
      callbackMessage = { message_id: messageCandidate.message_id, ...(chat ? { chat } : {}) };
    }
    let from: { readonly id: number } | undefined;
    if ("from" in candidate && candidate.from !== undefined) {
      const fromCandidate = candidate.from;
      if (!isTelegramRecord(fromCandidate) || !("id" in fromCandidate)
        || typeof fromCandidate.id !== "number" || !Number.isSafeInteger(fromCandidate.id)) return null;
      from = { id: fromCandidate.id };
    }
    callbackQuery = {
      ...(callbackMessage ? { message: callbackMessage } : {}),
      ...(from ? { from } : {}),
      ...(typeof data === "string" ? { data } : {}),
    };
  }
  if (message === undefined && callbackQuery === undefined) return null;
  return { update_id: updateId, ...(message ? { message } : {}), ...(callbackQuery ? { callback_query: callbackQuery } : {}) };
}
function stablePlainMessageAt(update: TgUpdate): string {
  const date = update.message?.date;
  if (!isValidTelegramDate(date)) throw new MalformedTelegramDateError();
  return new Date(date * 1_000).toISOString();
}

export class TelegramEscalationAdapter implements EscalationAdapter {
  readonly kind = "telegram";
  private readonly channelId: string;
  private readonly configDigest: string;
  private readonly token: string;
  private readonly chatId: string;
  private plainHandler: PlainMessageHandler | undefined;
  private readonly storage: FullstackStorageAuthority;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly allowedChatIds: readonly string[];
  private readonly allowedSenderIds: readonly string[];
  private readonly runIdentity: WorkflowRunIdentity;
  private readonly privateOneToOneChatId?: string;
  private readonly networkTimeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly volatileSentMappings = new Map<string, TelegramMappingRecord>();
  private offset = 0;
  private polling = false;
  private pollInFlight: Promise<EscalationAnswer[]> | null = null;
  private generation = 0;
  private closed = false;

  constructor(options: TelegramAdapterOptions) {
    if (!options || typeof options.token !== "string" || !SAFE_TOKEN.test(options.token)
      || !isSafeTelegramId(options.chatId) || !isCanonicalRoot(options.project_root)
      || !isFullstackStorageAuthority(options.storage) || !isChannelAdmission(options.channel_admission)
      || !Array.isArray(options.allowedChatIds) || !Array.isArray(options.allowedSenderIds)
      || typeof options.channel_id !== "string" || !SAFE_CHANNEL_ID.test(options.channel_id)
      || typeof options.channel_admission.config_digest !== "string"
      || !/^sha256:[0-9a-f]{64}$/u.test(options.channel_admission.config_digest)) {
      throw new TypeError("TelegramEscalationAdapter requires explicit storage, channel and admission identity");
    }
    const run = validateWorkflowRunIdentity(options.run_identity);
    if (!run.ok || !sameRun(run.value, options.channel_admission.run_identity)
      || !sameRun(run.value, options.storage.run_identity)
      || options.project_root !== options.channel_admission.project_root
      || options.project_root !== options.storage.project_root
      || !equalStrings(options.allowedChatIds, options.channel_admission.allowed_chat_ids)
      || !equalStrings(options.allowedSenderIds, options.channel_admission.allowed_sender_ids)) {
      throw new TypeError("TelegramEscalationAdapter requires exact storage, admission and run identity pins");
    }
    const candidates = options.channel_admission.channels.filter((candidate) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const entry = candidate as Record<string, unknown>;
      return entry.adapter === "telegram" && entry.token === options.token && entry.chatId === options.chatId
        && entry.id === options.channel_id;
    });
    if (candidates.length !== 1) throw new TypeError("Telegram endpoint is not uniquely admitted");
    const admittedEntry = candidates[0] as Record<string, unknown>;
    const policy = endpointPolicyFor(options.channel_admission, admittedEntry, options.channel_id);
    if (!policy || !validTelegramPolicy(policy)) throw new TypeError("Telegram endpoint policy is not admitted");
    for (const value of options.allowedChatIds) if (!isSafeTelegramId(value)) throw new TypeError("Telegram chat allowlist contains malformed entry");
    for (const value of options.allowedSenderIds) if (!isSafeTelegramId(value)) throw new TypeError("Telegram sender allowlist contains malformed entry");
    if (!options.allowedChatIds.includes(options.chatId)) throw new TypeError("Telegram target chat is not admitted");
    const privateProof = options.channel_admission.private_one_to_one;
    if (privateProof !== undefined && (privateProof.authenticated !== true || privateProof.chat_id !== options.chatId)) {
      throw new TypeError("Telegram private 1:1 proof does not match the target chat");
    }
    if (admittedEntry.direction === "read-write" && options.allowedSenderIds.length === 0 && privateProof === undefined) {
      throw new TypeError("Telegram read-write channels require a non-empty sender allowlist");
    }
    this.channelId = options.channel_id;
    this.configDigest = options.channel_admission.config_digest;
    this.token = options.token;
    this.chatId = options.chatId;
    this.allowedChatIds = options.allowedChatIds;
    this.allowedSenderIds = options.allowedSenderIds;
    this.runIdentity = run.value;
    this.storage = options.storage;
    this.pollIntervalMs = Number.isFinite(options.pollIntervalMs) && (options.pollIntervalMs ?? 0) > 0 ? Math.min(options.pollIntervalMs!, 60_000) : 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.privateOneToOneChatId = privateProof?.chat_id;
    this.networkTimeoutMs = policyTimeout(policy);
    this.maxRequestBytes = policyBodyLimit(policy);
    this.plainHandler = options.onPlainMessage;
  }

  setPlainMessageHandler(handler: PlainMessageHandler): void {
    this.plainHandler = handler;
  }

  private async api(method: "sendMessage" | "deleteMessage" | "getUpdates", payload: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify(payload);
    if (body === undefined || new TextEncoder().encode(body).byteLength > this.maxRequestBytes) {
      throw new TelegramPreSendError(method, "telegram request body exceeds limit");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.networkTimeoutMs);
    try {
      const response = await rejectOnAbort(this.fetchImpl(`${TELEGRAM_API_ORIGIN}/bot${this.token}/${method}`, {
        method: "POST",
        headers: TELEGRAM_HEADERS,
        body,
        signal: controller.signal,
        redirect: "error",
      }), controller.signal);
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          const responseText = await responseTextBounded(response, MAX_TELEGRAM_RESPONSE_BYTES, controller.signal);
          let parsed: unknown;
          try {
            parsed = JSON.parse(responseText) as unknown;
          } catch {
            throw new TelegramHttpRejectedError(method, response.status, false);
          }
          throw new TelegramHttpRejectedError(method, response.status, isDefinitiveTelegramRejection(parsed, response.status));
        }
        throw new TelegramHttpRejectedError(method, response.status, false);
      }
      const responseText = await responseTextBounded(response, MAX_TELEGRAM_RESPONSE_BYTES, controller.signal);
      let parsed: unknown;
      try { parsed = JSON.parse(responseText) as unknown; } catch { throw new Error(`telegram ${method} -> malformed response`); }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !("ok" in parsed) || parsed.ok !== true) {
        throw new Error(`telegram ${method} -> not ok`);
      }
      return "result" in parsed ? parsed.result : undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async send(escalation: Escalation): Promise<EscalationReceipt> {
    if (this.closed || escalation === null || typeof escalation !== "object") {
      return { sent: false, run_identity: this.runIdentity, channelRef: "tg:identity-mismatch" };
    }
    const run = validateWorkflowRunIdentity(escalation.run_identity);
    if (!run.ok || !sameRun(run.value, this.runIdentity)) {
      return { sent: false, run_identity: this.runIdentity, channelRef: "tg:identity-mismatch" };
    }
    const id = escalation.id;
    const options = escalation.options;
    if (!isSafeEscId(id) || !id.startsWith(`${this.runIdentity.run_id}/`)
      || (escalation.level !== "question" && escalation.level !== "decision" && escalation.level !== "needs_human" && escalation.level !== "blocker")
      || typeof escalation.title !== "string" || typeof escalation.body !== "string"
      || new TextEncoder().encode(escalation.title).byteLength > MAX_TELEGRAM_TEXT_BYTES
      || new TextEncoder().encode(escalation.body).byteLength > MAX_TELEGRAM_TEXT_BYTES
      || (escalation.default !== undefined && (typeof escalation.default !== "string" || new TextEncoder().encode(escalation.default).byteLength > MAX_TELEGRAM_TEXT_BYTES))
      || (escalation.timeoutMs !== undefined && (!Number.isSafeInteger(escalation.timeoutMs) || escalation.timeoutMs < 0))
      || (escalation.replyTo !== undefined && (!isSafeEscId(escalation.replyTo) || !escalation.replyTo.startsWith(`${this.runIdentity.run_id}/`)))
      || (options !== undefined && (!Array.isArray(options) || options.length > 32 || options.some((option) => option === null || typeof option !== "object" || Array.isArray(option)
        || typeof option.id !== "string" || !isSafeTelegramOptionId(option.id) || typeof option.label !== "string"
        || new TextEncoder().encode(option.label).byteLength > MAX_TELEGRAM_TEXT_BYTES
        || (option.apply !== "now" && option.apply !== "on_next_checkpoint"))))) {
      return { sent: false, run_identity: this.runIdentity, channelRef: "tg:body-limit" };
    }
    const callbackOptions: Array<{ readonly label: string; readonly callback_data: string }> = [];
    if (options !== undefined) {
      for (const option of options) {
        const callbackData = preflightTelegramCallbackData(id, option.id);
        if (!callbackData.ok) {
          return { sent: false, run_identity: this.runIdentity, channelRef: callbackData.channelRef };
        }
        callbackOptions.push({ label: option.label, callback_data: callbackData.value });
      }
    }
    const text = [escalation.title, "", escalation.body, escalation.default ? `(default: ${escalation.default})` : ""].join("\n");
    const payload: Record<string, unknown> = {
      chat_id: this.chatId,
      text,
      reply_markup: { force_reply: true, input_field_placeholder: "Answer the CTO escalation" },
    };
    if (callbackOptions.length > 0) {
      payload.reply_markup = { inline_keyboard: callbackOptions.map((option) => [{ text: option.label, callback_data: option.callback_data }]) };
    }
    try {
      jsonBytes(payload, this.maxRequestBytes);
    } catch {
      return { sent: false, run_identity: this.runIdentity, channelRef: "tg:body-limit" };
    }
    const escalationDigest = digest({
      id,
      level: escalation.level,
      title: escalation.title,
      body: escalation.body,
      options: options?.map((option) => ({ id: option.id, label: option.label, apply: option.apply })) ?? null,
      default: escalation.default ?? null,
      timeoutMs: escalation.timeoutMs ?? null,
      replyTo: escalation.replyTo ?? null,
      run_identity: this.runIdentity,
    });
    const mappingPath = this.mappingPath(id);
    const pendingPath = this.pendingMappingPath(id);
    let capacityLease: StorageLease | undefined;
    let lease: StorageLease | undefined;
    let pendingWritten = false;
    const releaseCapacityLease = (): void => {
      const held = capacityLease;
      capacityLease = undefined;
      if (held) checkedStorageResult(() => this.storage.releaseLease(held.relative_path, this.runIdentity));
    };
    try {
      // The channel capacity lease is always acquired before the per-ID
      // transition lease.  Promotion/lookup acquires only the per-ID lease,
      // so no code acquires these locks in the reverse order.
      const capacityAcquired = checkedStorageResult(() => this.storage.acquireLease(this.mappingCapacityLeasePath(), this.runIdentity));
      if (!capacityAcquired.ok) return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-unavailable" };
      capacityLease = capacityAcquired.value;
      // The final directory also contains the pending-mappings directory.
      const listed = checkedStorageResult(() => this.storage.listJsonBounded(this.mappingDirectory(), MAX_TELEGRAM_MAP_ENTRIES + 1));
      const pendingListed = checkedStorageResult(() => this.storage.listJsonBounded(this.pendingMappingDirectory(), MAX_TELEGRAM_MAP_ENTRIES));
      if (!listed.ok || !pendingListed.ok) return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-unavailable" };
      const mappingKeys = new Set<string>();
      for (const entry of listed.value) mappingKeys.add(entry.name);
      for (const entry of pendingListed.value) mappingKeys.add(entry.name);
      if (!mappingKeys.has(`${digest(id)}.json`) && mappingKeys.size >= MAX_TELEGRAM_MAP_ENTRIES) {
        return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-limit" };
      }
      const acquired = checkedStorageResult(() => this.storage.acquireLease(this.mappingLeasePath(id), this.runIdentity));
      if (!acquired.ok) return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-unavailable" };
      lease = acquired.value;
      const existing = this.readMapping(mappingPath);
      if (existing.kind === "unavailable") return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-unavailable" };
      if (existing.kind === "sent") {
        if (!this.isExactMapping(existing.record, id, escalationDigest)) {
          return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-conflict" };
        }
        this.removeOwnedPending(pendingPath, id, escalationDigest, lease);
        this.volatileSentMappings.delete(id);
        return { sent: true, run_identity: this.runIdentity, channelRef: `tg:${existing.record.message_id}` };
      }
      if (existing.kind !== "missing") return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-conflict" };

      const pending = this.readMapping(pendingPath);
      if (pending.kind === "unavailable") return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-unavailable" };
      if (pending.kind === "sent") {
        if (!this.isExactMapping(pending.record, id, escalationDigest)) {
          return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-conflict" };
        }
        const promoted = checkedStorageResult(() => this.storage.moveExclusive(pendingPath, mappingPath));
        if (promoted.ok) {
          this.volatileSentMappings.delete(id);
          return { sent: true, run_identity: this.runIdentity, channelRef: `tg:${pending.record.message_id}` };
        }
        const afterPromotion = this.readMapping(mappingPath);
        if (afterPromotion.kind === "sent" && this.isExactMapping(afterPromotion.record, id, escalationDigest)) {
          this.removeOwnedPending(pendingPath, id, escalationDigest, lease);
          this.volatileSentMappings.delete(id);
          return { sent: true, run_identity: this.runIdentity, channelRef: `tg:${afterPromotion.record.message_id}` };
        }
        return {
          sent: false,
          run_identity: this.runIdentity,
          channelRef: afterPromotion.kind === "missing" || afterPromotion.kind === "unavailable"
            ? "tg:mapping-unavailable"
            : "tg:mapping-conflict",
        };
      }
      if (pending.kind === "pending") {
        if (!this.isExactMapping(pending.record, id, escalationDigest)) {
          return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-conflict" };
        }
        const volatile = this.volatileSuccessFor(id, escalationDigest);
        if (volatile) return this.recoverVolatileSuccess(id, escalationDigest, pendingPath, mappingPath, lease, volatile);
        // A pending record left on disk is an unresolved send boundary.  Do
        // not delete the only evidence and issue another remote send.
        return this.uncertainDeliveryReceipt();
      }
      if (pending.kind === "conflict") {
        return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-conflict" };
      }
      const volatile = this.volatileSentMappings.get(id);
      if (volatile) {
        if (!this.isExactMapping(volatile, id, escalationDigest)) {
          return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-conflict" };
        }
        return this.recoverVolatileSuccess(id, escalationDigest, pendingPath, mappingPath, lease, volatile);
      }

      const pendingRecord: TelegramMappingRecord = {
        schema_version: 1,
        state: "pending",
        esc_id: id,
        channel_id: this.channelId,
        config_digest: this.configDigest,
        chat_id: this.chatId,
        run_identity: this.runIdentity,
        escalation_digest: escalationDigest,
      };
      const pendingWrite = checkedStorageResult(() => this.storage.writeJsonExclusive(pendingPath, jsonBytes(pendingRecord, MAX_TELEGRAM_MAP_RECORD_BYTES), 0o600));
      if (!pendingWrite.ok) {
        const afterPendingWrite = this.readMapping(mappingPath);
        if (afterPendingWrite.kind === "sent" && this.isExactMapping(afterPendingWrite.record, id, escalationDigest)) {
          this.removeOwnedPending(pendingPath, id, escalationDigest, lease);
          return { sent: true, run_identity: this.runIdentity, channelRef: `tg:${afterPendingWrite.record.message_id}` };
        }
        return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-unavailable" };
      }
      pendingWritten = true;
      releaseCapacityLease();

      let result: unknown;
      try {
        result = await this.api("sendMessage", payload);
      } catch (error) {
        const afterTransport = this.readMapping(mappingPath);
        if (afterTransport.kind === "sent" && this.isExactMapping(afterTransport.record, id, escalationDigest)) {
          this.removeOwnedPending(pendingPath, id, escalationDigest, lease);
          this.volatileSentMappings.delete(id);
          return { sent: true, run_identity: this.runIdentity, channelRef: `tg:${afterTransport.record.message_id}` };
        }
        if ((error instanceof TelegramPreSendError && error.method === "sendMessage")
          || (error instanceof TelegramHttpRejectedError && error.method === "sendMessage" && error.definitive)) {
          if (!this.removeOwnedPending(pendingPath, id, escalationDigest, lease)) {
            return { sent: false, run_identity: this.runIdentity, channelRef: "tg:mapping-unavailable" };
          }
          this.volatileSentMappings.delete(id);
          return { sent: false, run_identity: this.runIdentity, channelRef: this.failedChannelRef("sendMessage", error) };
        }
        // A transport failure or an HTTP-2xx response that cannot be
        // reconciled may have been accepted by Telegram.  Keep the pending
        // marker and fail closed; deleting it would permit a duplicate send.
        return this.uncertainDeliveryReceipt();
      }
      if (result === null || typeof result !== "object" || Array.isArray(result) || !("message_id" in result)
        || typeof result.message_id !== "number" || !Number.isSafeInteger(result.message_id) || result.message_id <= 0) {
        const afterInvalidResult = this.readMapping(mappingPath);
        if (afterInvalidResult.kind === "sent" && this.isExactMapping(afterInvalidResult.record, id, escalationDigest)) {
          this.removeOwnedPending(pendingPath, id, escalationDigest, lease);
          this.volatileSentMappings.delete(id);
          return { sent: true, run_identity: this.runIdentity, channelRef: `tg:${afterInvalidResult.record.message_id}` };
        }
        // A successful HTTP exchange without a valid Telegram message id is
        // still ambiguous: the remote message may exist.
        return this.uncertainDeliveryReceipt();
      }
      const record: TelegramMappingRecord = {
        schema_version: 1,
        state: "sent",
        esc_id: id,
        message_id: result.message_id,
        channel_id: this.channelId,
        config_digest: this.configDigest,
        chat_id: this.chatId,
        run_identity: this.runIdentity,
        escalation_digest: escalationDigest,
      };
      this.volatileSentMappings.set(id, record);
      const written = checkedStorageResult(() => this.storage.writeJsonExclusive(mappingPath, jsonBytes(record, MAX_TELEGRAM_MAP_RECORD_BYTES), 0o600));
      if (!written.ok) {
        const afterMappingWrite = this.readMapping(mappingPath);
        if (afterMappingWrite.kind === "sent" && this.isExactMapping(afterMappingWrite.record, id, escalationDigest)) {
          this.removeOwnedPending(pendingPath, id, escalationDigest, lease);
          this.volatileSentMappings.delete(id);
          return { sent: true, run_identity: this.runIdentity, channelRef: `tg:${afterMappingWrite.record.message_id}` };
        }
        // Telegram already accepted the message.  Keep a durable sent record in
        // the pending slot so a later call can promote it before sending again.
        // Atomic transition failure leaves the prior pending record untouched.
        const retained = this.retainSentPending(pendingPath, record);
        if (!retained) return this.uncertainDeliveryReceipt();
        return {
          sent: false,
          run_identity: this.runIdentity,
          channelRef: afterMappingWrite.kind === "missing" || afterMappingWrite.kind === "unavailable"
            ? "tg:mapping-unavailable"
            : "tg:mapping-conflict",
        };
      }
      this.removeOwnedPending(pendingPath, id, escalationDigest, lease);
      this.volatileSentMappings.delete(id);
      return { sent: true, run_identity: this.runIdentity, channelRef: `tg:${result.message_id}` };
    } catch (error) {
      if (pendingWritten) {
        const afterUnexpected = this.readMapping(mappingPath);
        if (afterUnexpected.kind === "sent" && this.isExactMapping(afterUnexpected.record, id, escalationDigest)) {
          this.removeOwnedPending(pendingPath, id, escalationDigest, lease!);
          this.volatileSentMappings.delete(id);
          return { sent: true, run_identity: this.runIdentity, channelRef: `tg:${afterUnexpected.record.message_id}` };
        }
        return this.uncertainDeliveryReceipt();
      }
      return { sent: false, run_identity: this.runIdentity, channelRef: this.failedChannelRef("sendMessage", error) };
    } finally {
      if (lease) checkedStorageResult(() => this.storage.releaseLease(lease!.relative_path, this.runIdentity));
      if (capacityLease) releaseCapacityLease();
    }
  }

  async cancel(id: string): Promise<void> {
    if (this.closed || !isSafeEscId(id) || !id.startsWith(`${this.runIdentity.run_id}/`)) return;
    const messageId = this.messageIdOf(id);
    if (messageId === null) return;
    try { await this.api("deleteMessage", { chat_id: this.chatId, message_id: messageId }); } catch { /* cancellation is best effort */ }
  }

  async sendPlainText(target: string, text: string): Promise<{ sent: boolean; channelRef?: string }> {
    if (this.closed || !isSafeTelegramId(target) || !this.allowedChatIds.includes(target)
      || typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_TELEGRAM_TEXT_BYTES || text.trim().length === 0) {
      return { sent: false, channelRef: "tg:plain:rejected" };
    }
    try {
      await this.api("sendMessage", { chat_id: target, text });
      return { sent: true, channelRef: `tg:plain:${target}` };
    } catch (error) {
      return { sent: false, channelRef: this.failedChannelRef("sendMessage", error) };
    }
  }

  private failedChannelRef(method: string, error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    const match = /^telegram \S+ -> (\d+)$/u.exec(message);
    return match ? `tg:${method}:http-${match[1]}` : `tg:${method}:failed`;
  }

  private uncertainDeliveryReceipt(): EscalationReceipt {
    return { sent: false, run_identity: this.runIdentity, channelRef: TELEGRAM_DELIVERY_UNCERTAIN_REF };
  }
  private volatileSuccessFor(id: string, escalationDigest: string): TelegramMappingRecord | null {
    const record = this.volatileSentMappings.get(id);
    return record && record.state === "sent" && typeof record.message_id === "number"
      && Number.isSafeInteger(record.message_id) && record.message_id > 0
      && this.isExactMapping(record, id, escalationDigest) ? record : null;
  }

  private recoverVolatileSuccess(
    id: string,
    escalationDigest: string,
    pendingPath: string,
    mappingPath: string,
    lease: StorageLease,
    record: TelegramMappingRecord,
  ): EscalationReceipt {
    if (record.state !== "sent" || typeof record.message_id !== "number" || !Number.isSafeInteger(record.message_id)
      || record.message_id <= 0 || !this.isExactMapping(record, id, escalationDigest)) return this.uncertainDeliveryReceipt();
    if (!this.retainSentPending(pendingPath, record)) return this.uncertainDeliveryReceipt();
    const promoted = checkedStorageResult(() => this.storage.moveExclusive(pendingPath, mappingPath));
    if (promoted.ok) {
      this.volatileSentMappings.delete(id);
      return { sent: true, run_identity: this.runIdentity, channelRef: `tg:${record.message_id}` };
    }
    const afterPromotion = this.readMapping(mappingPath);
    if (afterPromotion.kind === "sent" && this.isExactMapping(afterPromotion.record, id, escalationDigest)) {
      this.removeOwnedPending(pendingPath, id, escalationDigest, lease);
      this.volatileSentMappings.delete(id);
      return { sent: true, run_identity: this.runIdentity, channelRef: `tg:${afterPromotion.record.message_id}` };
    }
    return this.uncertainDeliveryReceipt();
  }

  start(): () => void {
    if (this.closed || this.polling) return () => undefined;
    this.polling = true;
    const generation = ++this.generation;
    void this.pollLoop(generation);
    return () => {
      this.polling = false;
      this.generation += 1;
    };
  }

  private async pollLoop(generation: number): Promise<void> {
    while (this.polling && generation === this.generation && !this.closed) {
      try { await this.pollOnce(); } catch { /* retain the offset and retry after the bounded interval */ }
      if (!this.polling || generation !== this.generation || this.closed) break;
      const wait = deferred<void>();
      setTimeout(wait.resolve, this.pollIntervalMs, undefined);
      await wait.promise;
    }
  }

  async pollOnce(): Promise<EscalationAnswer[]> {
    if (this.closed) return [];
    if (this.pollInFlight) return this.pollInFlight;
    const round = this.runPollOnce();
    this.pollInFlight = round;
    try { return await round; } finally { if (this.pollInFlight === round) this.pollInFlight = null; }
  }

  private async runPollOnce(): Promise<EscalationAnswer[]> {
    if (!this.polling && this.offset === 0) this.polling = true;
    const longPollSeconds = Math.min(30, Math.max(0, Math.floor((this.networkTimeoutMs - 1_000) / 1_000)));
    const raw = await this.api("getUpdates", { offset: this.offset, timeout: longPollSeconds, allowed_updates: ["message", "callback_query"] });
    if (!Array.isArray(raw)) throw new Error("telegram getUpdates returned a malformed result");
    if (raw.length > MAX_TELEGRAM_UPDATES) {
      const quarantined = this.quarantinePayload({ kind: "updates-over-limit", count: raw.length }, "update-count");
      if (!quarantined) throw new Error("telegram update-count quarantine failed");
    }
    const answers: EscalationAnswer[] = [];
    for (const rawUpdate of raw.slice(0, MAX_TELEGRAM_UPDATES)) {
      const fallbackOffset = this.offset < Number.MAX_SAFE_INTEGER ? this.offset + 1 : Number.MAX_SAFE_INTEGER;
      const parsed = parseUpdate(rawUpdate);
      const updateId = parsed?.update_id ?? updateIdOf(rawUpdate) ?? Math.max(0, fallbackOffset - 1);
      try {
        if (!parsed) {
          const quarantined = this.quarantinePayload({ kind: "malformed-update", digest: this.safeDigest(rawUpdate) }, "update-shape");
          if (!quarantined) throw new Error("telegram update-shape quarantine failed");
        } else if (this.authorized(parsed)) {
          const answer = await this.answerFromUpdate(parsed);
          if (answer) {
            const outcome = this.writeAnswer(answer);
            if (outcome === "new") answers.push(answer);
            else if (outcome === "retry") throw new RetryableInboundTaskError();
            else if (outcome === "poison") {
              const quarantined = this.quarantinePayload({ kind: "malformed-answer", digest: this.safeDigest(rawUpdate) }, "answer-shape");
              if (!quarantined) throw new RetryableInboundTaskError();
            }
          }
        }
      } catch (error) {
        if (error instanceof RetryableInboundTaskError) throw error;
        if (error instanceof MalformedTelegramDateError) {
          const quarantined = this.quarantinePayload({ kind: "malformed-update", digest: this.safeDigest(rawUpdate), reason: error.message }, "update-date");
          if (!quarantined) throw error;
        } else {
          const quarantined = this.quarantinePayload({ kind: "update-processing-failure", digest: this.safeDigest(rawUpdate), reason: error instanceof Error ? error.message.slice(0, 256) : "unknown" }, "update-processing");
          if (!quarantined) throw error;
        }
      }
      this.offset = Math.max(this.offset, updateId < Number.MAX_SAFE_INTEGER ? updateId + 1 : Number.MAX_SAFE_INTEGER);
    }
    return answers;
  }

  private authorized(update: TgUpdate): boolean {
    const chat = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    const sender = update.message?.from?.id ?? update.callback_query?.from?.id;
    if (chat === undefined || sender === undefined) return false;
    const chatId = String(chat);
    const senderId = String(sender);
    if (!isSafeTelegramId(chatId) || !isSafeTelegramId(senderId)) return false;
    if (chatId !== this.chatId || !this.allowedChatIds.includes(chatId)) return false;
    if (this.allowedSenderIds.length > 0) return this.allowedSenderIds.includes(senderId);
    return this.privateOneToOneChatId === chatId;
  }

  private async answerFromUpdate(update: TgUpdate): Promise<TelegramAnswer | null> {
    const message = update.message;
    const callback = update.callback_query;
    const chat = message?.chat?.id ?? callback?.message?.chat?.id;
    const sender = message?.from?.id ?? callback?.from?.id;
    const chatId = String(chat);
    const senderId = String(sender);
    const byBase = `telegram:sender=${senderId};chat=${chatId}`;
    const at = new Date().toISOString();
    if (callback?.data && callback.message?.message_id !== undefined) {
      const separator = callback.data.indexOf("::");
      const id = separator > 0 ? callback.data.slice(0, separator) : "";
      const option = separator > 0 ? callback.data.slice(separator + 2) : "";
      if (isSafeEscId(id) && id.startsWith(`${this.runIdentity.run_id}/`) && isSafeTelegramOptionId(option)) {
        const mapped = this.escIdOfMessage(callback.message.message_id);
        if (mapped.kind === "unavailable") throw new RetryableInboundTaskError();
        if (mapped.kind === "found" && mapped.id === id) {
          return {
            id,
            answer: option,
            at,
            by: `${byBase};kind=callback`,
            run_identity: this.runIdentity,
            sender_id: senderId,
            chat_id: chatId,
            source_update_id: update.update_id,
            source_message_id: callback.message.message_id,
          };
        }
      }
    }
    if (message?.reply_to_message && typeof message.text === "string" && message.text.trim().length > 0) {
      const mapped = this.escIdOfMessage(message.reply_to_message.message_id);
      if (mapped.kind === "unavailable") throw new RetryableInboundTaskError();
      if (mapped.kind === "found") {
        const id = mapped.id;
        return {
          id,
          answer: message.text,
          at,
          by: `${byBase};kind=reply`,
          run_identity: this.runIdentity,
          sender_id: senderId,
          chat_id: chatId,
          source_update_id: update.update_id,
          source_message_id: message.message_id,
        };
      }
    }
    if (message && typeof message.text === "string" && message.text.trim().length > 0) {
      const at = stablePlainMessageAt(update);
      if (this.plainHandler) {
        try {
          await this.plainHandler({
            id: `tg:${chatId}:${message.message_id}`,
            text: message.text,
            at,
            by: `${byBase};kind=plain`,
            run_identity: this.runIdentity,
            sender_id: senderId,
            chat_id: chatId,
          } as EscalationInboundMessage);
        } catch {
          throw new RetryableInboundTaskError();
        }
      }
    }
    return null;
  }

  private writeAnswer(answer: TelegramAnswer): AnswerWriteOutcome {
    if (answer === null || typeof answer !== "object") return "poison";
    const answerRun = validateWorkflowRunIdentity(answer.run_identity);
    if (!answerRun.ok || !sameRun(answerRun.value, this.runIdentity)
      || !isSafeEscId(answer.id) || !answer.id.startsWith(`${this.runIdentity.run_id}/`)
      || !isSafeTelegramId(answer.sender_id) || !isSafeTelegramId(answer.chat_id) || answer.chat_id !== this.chatId
      || typeof answer.answer !== "string" || typeof answer.at !== "string" || typeof answer.by !== "string"
      || new TextEncoder().encode(answer.answer).byteLength > MAX_TELEGRAM_TEXT_BYTES
      || new TextEncoder().encode(answer.at).byteLength > 128
      || new TextEncoder().encode(answer.by).byteLength > MAX_TELEGRAM_TEXT_BYTES
      || typeof answer.source_update_id !== "number" || !Number.isSafeInteger(answer.source_update_id) || answer.source_update_id < 0
      || typeof answer.source_message_id !== "number" || !Number.isSafeInteger(answer.source_message_id) || answer.source_message_id <= 0) {
      return "poison";
    }
    const path = this.answerPath(answer.id);
    const answerDigest = digest({
      id: answer.id,
      answer: answer.answer,
      channel_id: this.channelId,
      config_digest: this.configDigest,
      by: answer.by,
      sender_id: answer.sender_id,
      chat_id: answer.chat_id,
      source_update_id: answer.source_update_id,
      source_message_id: answer.source_message_id,
      run_identity: this.runIdentity,
    });
    const existing = checkedStorageResult(() => this.storage.readJsonBounded(path, MAX_TELEGRAM_ANSWER_RECORD_BYTES, 16));
    if (!existing.ok) return this.answerReadFailure(path, "answer-read");
    if (existing.value !== null) {
      const record = this.parseAnswerRecord(existing.value);
      if (record && record.id === answer.id && path === this.answerPath(record.id)
        && sameRun(record.run_identity, this.runIdentity) && record.answer_digest === answerDigest) return "duplicate";
      return this.quarantineSource(path, "answer-conflict") ? "quarantined" : "retry";
    }
    const record: TelegramAnswerRecord = {
      schema_version: 1,
      id: answer.id,
      answer: answer.answer,
      at: answer.at,
      by: answer.by,
      sender_id: answer.sender_id,
      channel_id: this.channelId,
      config_digest: this.configDigest,
      chat_id: answer.chat_id,
      source_update_id: answer.source_update_id,
      source_message_id: answer.source_message_id,
      run_identity: this.runIdentity,
      answer_digest: answerDigest,
    };
    const written = checkedStorageResult(() => this.storage.writeJsonExclusive(path, jsonBytes(record, MAX_TELEGRAM_ANSWER_RECORD_BYTES), 0o600));
    if (written.ok) return "new";
    const replay = checkedStorageResult(() => this.storage.readJsonBounded(path, MAX_TELEGRAM_ANSWER_RECORD_BYTES, 16));
    if (!replay.ok) return this.answerReadFailure(path, "answer-write");
    if (replay.value === null) return "retry";
    const recordAfterRace = this.parseAnswerRecord(replay.value);
    if (recordAfterRace && recordAfterRace.id === answer.id && path === this.answerPath(recordAfterRace.id)
      && sameRun(recordAfterRace.run_identity, this.runIdentity) && recordAfterRace.answer_digest === answerDigest) return "duplicate";
    return this.quarantineSource(path, "answer-write") ? "quarantined" : "retry";
  }
  private parseAnswerRecord(value: unknown): TelegramAnswerRecord | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Partial<TelegramAnswerRecord>;
    const run = validateWorkflowRunIdentity(record.run_identity);
    if (record.schema_version !== 1 || typeof record.id !== "string" || typeof record.answer !== "string" || typeof record.at !== "string"
      || typeof record.by !== "string" || typeof record.sender_id !== "string" || typeof record.chat_id !== "string"
      || typeof record.channel_id !== "string" || !SAFE_CHANNEL_ID.test(record.channel_id)
      || typeof record.config_digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.config_digest)
      || record.channel_id !== this.channelId || record.config_digest !== this.configDigest || record.chat_id !== this.chatId
      || !isSafeEscId(record.id) || !record.id.startsWith(`${this.runIdentity.run_id}/`)
      || !isSafeTelegramId(record.sender_id) || !isSafeTelegramId(record.chat_id)
      || new TextEncoder().encode(record.answer).byteLength > MAX_TELEGRAM_TEXT_BYTES || new TextEncoder().encode(record.by).byteLength > MAX_TELEGRAM_TEXT_BYTES
      || new TextEncoder().encode(record.at).byteLength > 128
      || typeof record.source_update_id !== "number" || !Number.isSafeInteger(record.source_update_id) || record.source_update_id < 0
      || typeof record.source_message_id !== "number" || !Number.isSafeInteger(record.source_message_id) || record.source_message_id <= 0
      || typeof record.answer_digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.answer_digest) || !run.ok) return null;
    return {
      schema_version: 1,
      id: record.id,
      answer: record.answer,
      at: record.at,
      by: record.by,
      sender_id: record.sender_id,
      chat_id: record.chat_id,
      channel_id: record.channel_id,
      config_digest: record.config_digest,
      source_update_id: record.source_update_id,
      source_message_id: record.source_message_id,
      run_identity: run.value,
      answer_digest: record.answer_digest,
    };
  }

  private parseMapping(value: unknown): TelegramMappingRecord | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Partial<TelegramMappingRecord>;
    const run = validateWorkflowRunIdentity(record.run_identity);
    if (record.schema_version !== 1 || (record.state !== "pending" && record.state !== "sent") || typeof record.esc_id !== "string"
      || !isSafeEscId(record.esc_id) || typeof record.channel_id !== "string" || !SAFE_CHANNEL_ID.test(record.channel_id)
      || typeof record.config_digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.config_digest)
      || typeof record.chat_id !== "string" || !isSafeTelegramId(record.chat_id)
      || record.channel_id !== this.channelId || record.config_digest !== this.configDigest || record.chat_id !== this.chatId
      || typeof record.escalation_digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.escalation_digest) || !run.ok
      || (record.state === "sent" && (typeof record.message_id !== "number" || !Number.isSafeInteger(record.message_id) || record.message_id <= 0))) return null;
    return {
      schema_version: 1,
      state: record.state,
      esc_id: record.esc_id,
      ...(record.message_id !== undefined ? { message_id: record.message_id } : {}),
      channel_id: record.channel_id,
      config_digest: record.config_digest,
      chat_id: record.chat_id,
      run_identity: run.value,
      escalation_digest: record.escalation_digest,
    };
  }
  private readMapping(path: string): MappingReadResult {
    const result = checkedStorageResult(() => this.storage.readJsonBounded(path, MAX_TELEGRAM_MAP_RECORD_BYTES, 16));
    if (!result.ok) return this.mappingReadFailure(path);
    if (result.value === null) return { kind: "missing" };
    const record = this.parseMapping(result.value);
    const expectedPath = record ? this.mappingPath(record.esc_id) : "";
    const expectedPendingPath = record ? this.pendingMappingPath(record.esc_id) : "";
    if (!record || !sameRun(record.run_identity, this.runIdentity) || !isSafeEscId(record.esc_id)
      || !record.esc_id.startsWith(`${this.runIdentity.run_id}/`) || (path !== expectedPath && path !== expectedPendingPath)) {
      return this.quarantineSource(path, "mapping-conflict") ? { kind: "conflict" } : { kind: "unavailable" };
    }
    return { kind: record.state, record };
  }

  private mappingReadFailure(path: string): MappingReadResult {
    const raw = checkedStorageResult(() => this.storage.readBounded(path, MAX_TELEGRAM_MAP_RECORD_BYTES));
    if (!raw.ok) return raw.reason === "LIMIT" && this.quarantineSource(path, "mapping-read") ? { kind: "conflict" } : { kind: "unavailable" };
    if (raw.value === null) return { kind: "unavailable" };
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.value));
      return { kind: "unavailable" };
    } catch {
      return this.quarantineSource(path, "mapping-read") ? { kind: "conflict" } : { kind: "unavailable" };
    }
  }

  private isExactMapping(record: TelegramMappingRecord, id: string, escalationDigest: string): boolean {
    return record.esc_id === id
      && record.channel_id === this.channelId
      && record.config_digest === this.configDigest
      && record.chat_id === this.chatId
      && sameRun(record.run_identity, this.runIdentity)
      && record.escalation_digest === escalationDigest;
  }

  private retainSentPending(pendingPath: string, record: TelegramMappingRecord): boolean {
    const current = this.readMapping(pendingPath);
    if (current.kind === "sent") return this.isExactMapping(current.record, record.esc_id, record.escalation_digest);
    if (current.kind === "conflict" || current.kind === "unavailable") return false;
    if (current.kind === "pending" && !this.isExactMapping(current.record, record.esc_id, record.escalation_digest)) return false;
    const transitioned = checkedStorageResult(() => this.storage.writeAtomic(
      pendingPath,
      jsonBytes(record, MAX_TELEGRAM_MAP_RECORD_BYTES),
      MAX_TELEGRAM_MAP_RECORD_BYTES,
    ));
    if (transitioned.ok) return true;
    const afterTransition = this.readMapping(pendingPath);
    return afterTransition.kind === "sent"
      && this.isExactMapping(afterTransition.record, record.esc_id, record.escalation_digest);
  }

  private removeOwnedPending(
    pendingPath: string,
    id: string,
    escalationDigest: string,
    lease: StorageLease,
  ): boolean {
    if (lease.relative_path !== this.mappingLeasePath(id) || !sameRun(lease.run_identity, this.runIdentity) || lease.lease_id.length === 0) return false;
    const pending = this.readMapping(pendingPath);
    if (pending.kind === "missing") return true;
    if ((pending.kind !== "pending" && pending.kind !== "sent") || !this.isExactMapping(pending.record, id, escalationDigest)) return false;
    const removed = checkedStorageResult(() => this.storage.removeIfOwned(pendingPath, lease.run_identity));
    if (!removed.ok || removed.value) return removed.ok;
    return this.readMapping(pendingPath).kind === "missing";
  }
  private promotePendingSent(record: TelegramMappingRecord): MappingReadResult {
    const id = record.esc_id;
    const mappingPath = this.mappingPath(id);
    const pendingPath = this.pendingMappingPath(id);
    const acquired = checkedStorageResult(() => this.storage.acquireLease(this.mappingLeasePath(id), this.runIdentity));
    if (!acquired.ok) return { kind: "unavailable" };
    const lease = acquired.value;
    try {
      const pending = this.readMapping(pendingPath);
      if (pending.kind === "unavailable") return { kind: "unavailable" };
      if (pending.kind !== "sent" || !this.isExactMapping(pending.record, id, record.escalation_digest)) {
        return pending.kind === "missing" ? { kind: "missing" } : { kind: "conflict" };
      }
      const existing = this.readMapping(mappingPath);
      if (existing.kind === "unavailable") return { kind: "unavailable" };
      if (existing.kind === "sent") {
        if (!this.isExactMapping(existing.record, id, record.escalation_digest)) return { kind: "conflict" };
        this.removeOwnedPending(pendingPath, id, record.escalation_digest, lease);
        return existing;
      }
      if (existing.kind !== "missing") return { kind: "conflict" };
      const promoted = checkedStorageResult(() => this.storage.moveExclusive(pendingPath, mappingPath));
      if (promoted.ok) return { kind: "sent", record: pending.record };
      const afterPromotion = this.readMapping(mappingPath);
      if (afterPromotion.kind === "sent" && this.isExactMapping(afterPromotion.record, id, record.escalation_digest)) {
        this.removeOwnedPending(pendingPath, id, record.escalation_digest, lease);
        return afterPromotion;
      }
      const afterPending = this.readMapping(pendingPath);
      if (afterPending.kind === "sent" && this.isExactMapping(afterPending.record, id, record.escalation_digest)) {
        return afterPending;
      }
      if (afterPromotion.kind === "unavailable" || afterPending.kind === "unavailable") return { kind: "unavailable" };
      return { kind: "conflict" };
    } finally {
      checkedStorageResult(() => this.storage.releaseLease(lease.relative_path, this.runIdentity));
    }
  }

  private messageIdOf(id: string): number | null {
    if (!isSafeEscId(id) || !id.startsWith(`${this.runIdentity.run_id}/`)) return null;
    const listed = checkedStorageResult(() => this.storage.listJsonBounded(this.mappingDirectory(), MAX_TELEGRAM_MAP_ENTRIES));
    if (!listed.ok) return null;
    for (const entry of listed.value) {
      const mapping = this.readMapping(entry.relative_path);
      if (mapping.kind === "sent" && mapping.record.esc_id === id
        && mapping.record.channel_id === this.channelId && mapping.record.config_digest === this.configDigest
        && mapping.record.chat_id === this.chatId && mapping.record.message_id !== undefined) return mapping.record.message_id;
    }
    const pending = checkedStorageResult(() => this.storage.listJsonBounded(this.pendingMappingDirectory(), MAX_TELEGRAM_MAP_ENTRIES));
    if (!pending.ok) return null;
    for (const entry of pending.value) {
      const mapping = this.readMapping(entry.relative_path);
      if (mapping.kind !== "sent" || mapping.record.esc_id !== id
        || mapping.record.channel_id !== this.channelId || mapping.record.config_digest !== this.configDigest
        || mapping.record.chat_id !== this.chatId || mapping.record.message_id === undefined) continue;
      const promoted = this.promotePendingSent(mapping.record);
      if (promoted.kind === "sent" && promoted.record.esc_id === id && promoted.record.message_id !== undefined) {
        return promoted.record.message_id;
      }
      if (promoted.kind === "unavailable") return null;
    }
    return null;
  }

  private escIdOfMessage(messageId: number): EscIdLookupResult {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return { kind: "missing" };
    const listed = checkedStorageResult(() => this.storage.listJsonBounded(this.mappingDirectory(), MAX_TELEGRAM_MAP_ENTRIES));
    if (!listed.ok) return { kind: "unavailable" };
    for (const entry of listed.value) {
      const mapping = this.readMapping(entry.relative_path);
      if (mapping.kind === "unavailable") return { kind: "unavailable" };
      if (mapping.kind === "sent" && mapping.record.message_id === messageId
        && mapping.record.channel_id === this.channelId && mapping.record.config_digest === this.configDigest
        && mapping.record.chat_id === this.chatId) return { kind: "found", id: mapping.record.esc_id };
    }
    const pending = checkedStorageResult(() => this.storage.listJsonBounded(this.pendingMappingDirectory(), MAX_TELEGRAM_MAP_ENTRIES));
    if (!pending.ok) return { kind: "unavailable" };
    for (const entry of pending.value) {
      const mapping = this.readMapping(entry.relative_path);
      if (mapping.kind === "unavailable") return { kind: "unavailable" };
      if (mapping.kind !== "sent" || mapping.record.message_id !== messageId) continue;
      const promoted = this.promotePendingSent(mapping.record);
      if (promoted.kind === "sent" && promoted.record.message_id === messageId) {
        return { kind: "found", id: promoted.record.esc_id };
      }
      if (promoted.kind === "unavailable") return { kind: "unavailable" };
    }
    return { kind: "missing" };
  }

  private channelBindingDigest(): string {
    return digest({ channel_id: this.channelId, config_digest: this.configDigest, chat_id: this.chatId });
  }

  private mappingDirectory(): string {
    return `.work-state/cto/${this.runIdentity.run_id}/telegram-map/${this.channelBindingDigest()}`;
  }

  private mappingPath(id: string): string {
    return `${this.mappingDirectory()}/${digest(id)}.json`;
  }

  private pendingMappingDirectory(): string {
    return `${this.mappingDirectory()}/pending`;
  }

  private pendingMappingPath(id: string): string {
    return `${this.pendingMappingDirectory()}/${digest(id)}.json`;
  }

  private mappingLeaseDirectory(): string {
    // Keep lease sidecars outside both bounded mapping listings.  The
    // channel-binding digest still pins this directory to the admitted channel.
    return `${this.mappingDirectory()}.leases`;
  }

  private mappingCapacityLeasePath(): string {
    return `${this.mappingLeaseDirectory()}/.capacity.lock`;
  }

  private mappingLeasePath(id: string): string {
    return `${this.mappingLeaseDirectory()}/${digest(id)}.lock`;
  }



  private answerDirectory(): string {
    return `.work-state/cto/${this.runIdentity.run_id}/answers`;
  }

  private answerPath(id: string): string {
    return `${this.answerDirectory()}/${digest(id)}.json`;
  }

  private safeDigest(value: unknown): string {
    try { return digest(value); } catch { return "unavailable"; }
  }
  private quarantineHasCapacity(target: string): boolean {
    const listed = checkedStorageResult(() => this.storage.listJsonBounded(this.quarantineDirectory(), MAX_TELEGRAM_QUARANTINE_ENTRIES));
    if (!listed.ok) return false;
    return listed.value.some((entry) => entry.relative_path === target) || listed.value.length < MAX_TELEGRAM_QUARANTINE_ENTRIES;
  }

  private quarantineSource(sourcePath: string, reason: string): boolean {
    const target = `${this.quarantineDirectory()}/${digest(`${sourcePath}:${reason}`)}.json`;
    if (!this.quarantineHasCapacity(target)) return false;
    const moved = checkedStorageResult(() => this.storage.moveExclusive(sourcePath, target));
    return moved.ok;
  }

  private answerReadFailure(sourcePath: string, reason: string): AnswerWriteOutcome {
    const raw = checkedStorageResult(() => this.storage.readBounded(sourcePath, MAX_TELEGRAM_ANSWER_RECORD_BYTES));
    if (!raw.ok) return raw.reason === "LIMIT" && this.quarantineSource(sourcePath, reason) ? "quarantined" : "retry";
    if (raw.value === null) return "retry";
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.value));
      return "retry";
    } catch {
      return this.quarantineSource(sourcePath, reason) ? "quarantined" : "retry";
    }
  }


  private quarantinePayload(payload: unknown, reason: string): boolean {
    const marker = {
      schema_version: 1,
      kind: "telegram-quarantine",
      reason,
      digest: this.safeDigest(payload),
      run_identity: this.runIdentity,
    };
    const target = `${this.quarantineDirectory()}/${digest(`${reason}:${marker.digest}`)}.json`;
    if (!this.quarantineHasCapacity(target)) return false;
    const written = checkedStorageResult(() => this.storage.writeJsonExclusive(target, jsonBytes(marker, MAX_TELEGRAM_QUARANTINE_BYTES), 0o600));
    if (written.ok) return true;
    if (written.reason !== "CONFLICT") return false;
    const existing = checkedStorageResult(() => this.storage.readJsonBounded(target, MAX_TELEGRAM_QUARANTINE_BYTES, 16));
    if (!existing.ok || existing.value === null) return false;
    try { return canonicalJson(existing.value) === canonicalJson(marker); } catch { return false; }
  }

  private quarantineDirectory(): string {
    return `.work-state/cto/${this.runIdentity.run_id}/telegram-quarantine`;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.polling = false;
    this.generation += 1;
    const inFlight = this.pollInFlight;
    if (inFlight) {
      try { await inFlight; } catch { /* shutdown waits for completion */ }
    }
    this.plainHandler = undefined;
  }
}
