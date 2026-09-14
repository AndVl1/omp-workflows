/**
 * Telegram escalation adapter (reference: full round trip).
 *
 * Send: `sendMessage` with the sanitized question + inline buttons for the
 * escalation options (or force-reply when there are none). The
 * message_id -> escId mapping is persisted to bounded, tenant-scoped shards
 * below `.work-state/cto/<runId>/tg-map*.jsonl` so answers survive restarts.
 *
 * Receive: long-polling `getUpdates` loop (no public URL needed). Two answer
 * shapes are accepted:
 *   - callback_query on an inline button  -> option id
 *   - reply message to the sent question  -> free text
 * Both are written to `.work-state/cto/<runId>/answers/<escId>.json` as an
 * EscalationAnswer ({ id, run_id, answer, at, by }).
 *
 * `fetchImpl` is injectable for tests; defaults to global fetch.
 */

import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { join } from "node:path";
import {
  PinnedProjectRoot,
  isSafeCtoInboundText,
  canonicalDurableIdFileName,
  isSafeCtoRunId,
  isSafeEscalationId,
  isSafeEscalationOptionId,
  validateEscalation,
  MAX_ESCALATION_OPTION_COUNT,
  MAX_ESCALATION_OPTION_ID_UTF8_BYTES,
  MAX_ESCALATION_OPTION_TEXT_UTF8_BYTES,
  MAX_TELEGRAM_CALLBACK_DATA_UTF8_BYTES,
  type Escalation,
  type EscalationAdapter,
  type EscalationAnswer,
  type EscalationReceipt,
  type PlainTextSendOutcome,
} from "@andvl1/omp-workflows-core";
import type { AdapterOperationContext } from "./registry.js";
import {
  assertCtoRuntimeProofAuthorityLive,
  isCtoRuntimeProofAuthority,
  type CtoRuntimeAccessFacade,
  type CtoRuntimeProofAuthority,
} from "@andvl1/omp-workflows-core/cto-runtime";

import {
  BoundedQueueError,
  DEFAULT_QUEUE_MAX_ENTRY_BYTES,
  openBoundedQueue,
  type BoundedQueue,
} from "@andvl1/omp-workflows-core/queue";
import {
  signTelegramMappingProof,
  verifyTelegramMappingProof,
} from "./mapping-secret.js";

function decodeTelegramUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

class TelegramActivationRevokedError extends Error {
  readonly code = "activation_revoked" as const;
  constructor(message = "telegram activation is no longer live", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TelegramActivationRevokedError";
  }
}

/** Reply target could not be authenticated; leave Telegram offset unconfirmed. */
export class TelegramMappingRecoveryRequiredError extends Error {
  readonly code = "telegram_mapping_recovery_required" as const;
  constructor(readonly messageId: number, message = `telegram reply target ${String(messageId)} requires mapping recovery`) {
    super(message);
    this.name = "TelegramMappingRecoveryRequiredError";
  }
}

function isTelegramActivationFailure(error: unknown): boolean {
  if (error instanceof TelegramActivationRevokedError) return true;
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "activation_revoked" || code === "runtime_access_invalid";
}

export interface TelegramPlainMessage {
  /** Canonical task identity scoped by both Telegram chat and message id. */
  id: string;
  /** Bounded message body from the normalized Telegram update. */
  text: string;
  at: string;
  by: "telegram";
  /** Raw bounded Telegram origin context retained for routing/audit. */
  chatId: string;
  userId?: string;
  messageId: number;
}

export type TelegramUpdateCommitHook = (updateId: number, pinnedRoot?: PinnedProjectRoot) => void | Promise<void>;

export type TelegramRuntimeAccess = Pick<CtoRuntimeAccessFacade,
  "assertLive" | "resolveEscalationChannelSnapshot" | "readActiveDeliveryCandidates"
  | "readCompletedDeliveryIndexPage" | "hasValidStateProof" | "readState"
  | "readOutboxDeliveryObligations" | "currentOutboxDeliveryStatus">;

export interface TelegramAdapterOptions {
  token: string;
  chatId: string;
  cwd: string;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Maximum bytes in one Telegram mapping shard. Mapping records rotate
   * before this bound, so lookups never need an unbounded read.
   */
  mappingMaxEntryBytes?: number;
  /**
   * Backwards-compatible alias for mappingMaxEntryBytes, useful for tests and
   * consumers that describe this as a shard byte cap.
   */
  mappingMaxBytes?: number;
  /**
   * Explicit operator authorization to migrate legacy unscoped map shards.
   * The tenant and chat must exactly match the target run and configured chat;
   * absent or mismatched authorization never adopts old records.
   */
  legacyMappingMigration?: { tenant: string; chatId: string };
  /**
   * Additional chats allowed for inbound beyond the configured chatId
   * (conservative allowlist). The configured chatId is ALWAYS allowed; this
   * list only extends it. Applies to callback answers, reply answers, and
   * plain CTO task messages.
   */
  allowedChatIds?: Array<string | number>;
  /**
   * When non-empty, inbound senders must be in this list (conservative
   * allowlist). When absent/empty, no sender restriction — the chat-level
   * rule still applies.
   */
  allowedSenderIds?: Array<string | number>;
  /** Authenticated readonly runtime used for Telegram mapping authority. */
  runtimeAccess?: TelegramRuntimeAccess;
  /** Opaque root/workflow_tools authority for Telegram mapping proofs. */
  proofAuthority: CtoRuntimeProofAuthority;
  /** Called after one bounded update is durably handled and before offset advancement. */
  onUpdateCommitted?: TelegramUpdateCommitHook;
  /** Initial Telegram update offset restored from a route-bound checkpoint. */
  initialOffset?: number;
  /**
   * Called for plain messages (not replies to a sent escalation, not
   * callback queries). Used by the CTO inbox: a plain message to the bot is
   * a NEW TASK for the standby CTO, routed to `.work-state/cto/<id>/inbox/`.
   */
  onPlainMessage?: (msg: TelegramPlainMessage, pinnedRoot?: PinnedProjectRoot) => void | Promise<void>;
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat?: { id: number };
    from?: { id: number };
    reply_to_message?: { message_id: number; text?: string };
  };
  callback_query?: {
    id: string;
    message?: { message_id: number; chat?: { id: number } };
    from?: { id: number };
    data?: string;
  };
}
interface TelegramAnswerTarget {
  readonly runId: string;
  readonly escId: string;
}

interface TelegramCorrelationMarker {
  readonly escId: string;
  readonly payloadDigest: string;
}

const TELEGRAM_CORRELATION_MARKER_PREFIX = "[omp-escalation-ref:v1:";
const TELEGRAM_CORRELATION_MARKER_RE = /\[omp-escalation-ref:v1:([A-Za-z0-9_-]{1,1024}):([0-9a-f]{64})\]$/u;
const TELEGRAM_CORRELATION_MARKER_MAX_BYTES = 2_048;

function telegramCorrelationMarker(esc: Escalation): string {
  const encodedId = Buffer.from(esc.id, "utf8").toString("base64url");
  const marker = `${TELEGRAM_CORRELATION_MARKER_PREFIX}${encodedId}:${deliveryPayloadDigest(esc)}]`;
  if (Buffer.byteLength(marker, "utf8") > TELEGRAM_CORRELATION_MARKER_MAX_BYTES) {
    throw new Error("telegram: escalation correlation marker exceeds its byte cap");
  }
  return marker;
}

function parseTelegramCorrelationMarker(text: unknown): TelegramCorrelationMarker | null {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > TELEGRAM_CORRELATION_MARKER_MAX_BYTES) return null;
  const match = TELEGRAM_CORRELATION_MARKER_RE.exec(text.trim());
  if (!match) return null;
  let escId: string;
  try {
    escId = Buffer.from(match[1]!, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!isSafeEscalationId(escId) || Buffer.from(escId, "utf8").toString("base64url") !== match[1]) return null;
  return { escId, payloadDigest: match[2]! };
}
function normalizeTelegramIdAllowlist(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw new Error(`telegram: ${label} allowlist is invalid`);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    let id: string;
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry)) throw new Error(`telegram: ${label} allowlist is invalid`);
      id = String(entry);
    } else if (typeof entry === "string") {
      if (entry.length === 0 || entry.length > 512 || /[\u0000-\u001f\u007f]/u.test(entry)) {
        throw new Error(`telegram: ${label} allowlist is invalid`);
      }
      id = entry;
    } else {
      throw new Error(`telegram: ${label} allowlist is invalid`);

    }
    if (seen.has(id)) throw new Error(`telegram: ${label} allowlist contains duplicates`);
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}
const TELEGRAM_CALLBACK_TOKEN_PREFIX = "cb_";
const TELEGRAM_CALLBACK_TOKEN_RE = /^cb_[0-9a-f]{32}$/u;
export const MAX_TELEGRAM_IDEMPOTENCY_KEY_UTF8_BYTES = 64 * 1024;
function telegramPlainMessageId(chatId: number, messageId: number): string {
  return `tg-${createHash("sha256")
    .update("telegram-plain-message\u0000", "utf8")
    .update(String(chatId), "utf8")
    .update("\u0000", "utf8")
    .update(String(messageId), "utf8")
    .digest("hex")}`;
}

function telegramCallbackToken(escId: string, optionId: string): string {
  return `${TELEGRAM_CALLBACK_TOKEN_PREFIX}${createHash("sha256")
    .update("telegram-callback\u0000", "utf8")
    .update(escId, "utf8")
    .update("\u0000", "utf8")
    .update(optionId, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function validateTelegramEscalation(esc: Escalation, mappingMaxEntryBytes?: number, chatId = ""): string | null {
  const validation = validateEscalation(esc);
  if (validation) return validation;
  const messageMappingLine = `${JSON.stringify({ escId: esc.id, messageId: Number.MAX_SAFE_INTEGER - 1, chatId })}\n`;
  if (mappingMaxEntryBytes !== undefined && Buffer.byteLength(messageMappingLine, "utf8") > mappingMaxEntryBytes) {
    return "escalation identity cannot be represented by the Telegram mapping shard";
  }
  const options = esc.options;
  if (!options) return null;
  if (options.length > MAX_ESCALATION_OPTION_COUNT) {
    return `escalation.options exceeds ${MAX_ESCALATION_OPTION_COUNT} entries`;
  }
  let callbackMappingBytes = 0;
  for (const option of options) {
    if (
      Buffer.byteLength(option.id, "utf8") > MAX_ESCALATION_OPTION_ID_UTF8_BYTES
      || Buffer.byteLength(option.label, "utf8") > MAX_ESCALATION_OPTION_TEXT_UTF8_BYTES
    ) {
      return "escalation option exceeds its UTF-8 transport bound";
    }
    const callback = telegramCallbackToken(esc.id, option.id);
    if (!TELEGRAM_CALLBACK_TOKEN_RE.test(callback) || Buffer.byteLength(callback, "utf8") > MAX_TELEGRAM_CALLBACK_DATA_UTF8_BYTES) {
      return "escalation option cannot be represented by Telegram callback_data";
    }
    callbackMappingBytes += Buffer.byteLength(`${JSON.stringify({ token: callback, escId: esc.id, optionId: option.id, chatId })}\n`, "utf8");
  }
  if (mappingMaxEntryBytes !== undefined && callbackMappingBytes > mappingMaxEntryBytes) {
    return "escalation callback mapping exceeds the shard byte cap";
  }
  return null;
}
function invalidTelegramEscalationReceipt(reason: string): EscalationReceipt {
  return { sent: false, channelRef: `tg:invalid-escalation:${reason}` };
}

export class TelegramEscalationAdapter implements EscalationAdapter {
  readonly kind = "telegram";
  private readonly token: string;
  private readonly chatId: string;
  private readonly cwd: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly mappingMaxEntryBytes: number;
  private readonly legacyMappingMigration?: { tenant: string; chatId: string };
  private readonly allowedChatIds: string[];
  private readonly allowedSenderIds: string[];
  private readonly runtimeAccess?: TelegramRuntimeAccess;
  private readonly proofAuthority: CtoRuntimeProofAuthority;
  private onUpdateCommitted?: TelegramUpdateCommitHook;
  private onPlainMessage: TelegramAdapterOptions["onPlainMessage"];
  private onAnswer?: (answer: EscalationAnswer, pinnedRoot?: PinnedProjectRoot) => void | Promise<void>;
  private offset = 0;
  private polling = false;
  /** In-flight getUpdates round — concurrent pollOnce calls share it (one getUpdates per adapter). */
  private pollInFlight: Promise<EscalationAnswer[]> | null = null;
  /** Bumped on every start(); lets a stale loop notice a stop+restart. */
  private loopGeneration = 0;

  constructor(options: TelegramAdapterOptions) {
    this.token = options.token;
    this.chatId = options.chatId;
    this.cwd = options.cwd;
    this.runtimeAccess = options.runtimeAccess;
    if (!isCtoRuntimeProofAuthority(options.proofAuthority)) {
      throw new Error("telegram: mapping proof authority is unavailable");
    }
    assertCtoRuntimeProofAuthorityLive(options.proofAuthority);
    this.proofAuthority = options.proofAuthority;
    this.onUpdateCommitted = options.onUpdateCommitted;
    if (options.initialOffset !== undefined) {
      if (!Number.isSafeInteger(options.initialOffset) || options.initialOffset < 0) throw new Error("telegram: initial offset is invalid");
      this.offset = options.initialOffset;
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const mappingMaxEntryBytes = options.mappingMaxEntryBytes ?? options.mappingMaxBytes ?? TG_MAP_DEFAULT_MAX_ENTRY_BYTES;
    if (
      !Number.isSafeInteger(mappingMaxEntryBytes)
      || mappingMaxEntryBytes < TG_MAP_MIN_ENTRY_BYTES
      || mappingMaxEntryBytes > TG_MAP_HARD_MAX_ENTRY_BYTES
    ) {
      throw new Error(
        `telegram: mappingMaxEntryBytes must be a safe integer between ${TG_MAP_MIN_ENTRY_BYTES} and ${TG_MAP_HARD_MAX_ENTRY_BYTES} bytes`,
      );
    }
    this.mappingMaxEntryBytes = mappingMaxEntryBytes;
    if (options.legacyMappingMigration) {
      const migration = options.legacyMappingMigration;
      if (Object.keys(migration).sort().join(",") !== "chatId,tenant") {
        throw new Error("telegram: legacyMappingMigration identity is invalid");
      }
      if (
        !isSafeRunId(migration.tenant)
        || typeof migration.chatId !== "string"
        || migration.chatId.length === 0
        || migration.chatId.length > 512
        || /[\u0000-\u001f\u007f]/u.test(migration.chatId)
      ) {
        throw new Error("telegram: legacyMappingMigration identity is invalid");
      }
      this.legacyMappingMigration = { tenant: migration.tenant, chatId: migration.chatId };
    }
    this.allowedChatIds = normalizeTelegramIdAllowlist(options.allowedChatIds, "allowedChatIds");
    this.allowedSenderIds = normalizeTelegramIdAllowlist(options.allowedSenderIds, "allowedSenderIds");
    this.onPlainMessage = options.onPlainMessage;
  }

  /** Set/replace the plain-message (inbox task) handler. */
  setPlainMessageHandler(handler: NonNullable<TelegramAdapterOptions["onPlainMessage"]>): void {
    this.onPlainMessage = handler;
  }

  /** Fence inbound callbacks during dispatcher takeover/shutdown. */
  clearPlainMessageHandler(): void {
    this.onPlainMessage = undefined;
  }

  setAnswerHandler(handler: (answer: EscalationAnswer, pinnedRoot?: PinnedProjectRoot) => void | Promise<void>): void {
    this.onAnswer = handler;
  }
  /**
   * Explicitly authorize adoption of legacy unscoped mapping shards for one
   * exact tenant/chat pair. This is intentionally separate from normal
   * lookups so an old shard can never be silently attributed to a new run.
   */
  migrateLegacyMappings(tenant: string, chatId: string, pinnedRoot?: PinnedProjectRoot): void {
    if (!pinnedRoot) throw new Error("telegram: mapping migration requires a pinned project root");
    this.assertProofAuthorityLive();
    this.assertLive(pinnedRoot);
    if (!pinnedRoot.isStable()) throw new Error("telegram: project root changed before mapping migration");
    if (!isSafeRunId(tenant) || typeof chatId !== "string" || chatId.length === 0 || chatId.length > 512 || /[\u0000-\u001f\u007f]/u.test(chatId)) {
      throw new Error("telegram: legacy mapping migration identity is invalid");
    }
    const source = this.openUnpartitionedMappingQueue(tenant, false, pinnedRoot);
    if (!source) return;
    let sourceLock: TelegramMapLock | null = null;
    let destination: BoundedQueue | null = null;
    let destinationLock: TelegramMapLock | null = null;
    try {
      sourceLock = acquireTelegramMapLock(source, tenant, chatId);
      const budget = newTelegramMapBudget();
      const sourceNames = listTelegramMapFiles(source, budget).filter((name) => isTelegramMapStateFile(name));
      if (sourceNames.length === 0) return;
      const metadata = readTelegramMapMetadata(source, budget);
      if (metadata && (metadata.tenant !== tenant || metadata.chatId !== chatId)) {
        throw new Error(`telegram: legacy mapping for "${tenant}" has no matching tenant/chat metadata`);
      }
      const sourceManifest = telegramMigrationManifest(source, sourceNames, budget);
      const markerProbe = JSON.stringify({
        schema: 1,
        tenant,
        chatId,
        sourceDigest: sourceManifest.digest,
        destinationDigest: "0".repeat(64),
        generation: null,
        sourceManifest: sourceManifest.entries,
      });
      if (Buffer.byteLength(markerProbe, "utf8") > Math.max(this.mappingMaxEntryBytes, TG_MAP_CONTROL_MAX_ENTRY_BYTES)) {
        throw new Error("telegram: legacy mapping migration manifest exceeds the marker byte cap");
      }
      destination = this.openMappingQueue(tenant, chatId, false, pinnedRoot);
      if (destination) {
        destinationLock = acquireTelegramMapLock(destination, tenant, chatId);
        recoverTelegramMap(destination, tenant, chatId, destinationLock, budget);
        const marker = readTelegramMigrationMarker(destination, tenant, chatId);
        if (marker) {
          const destinationNames = listTelegramMapFiles(destination, budget)
            .filter((name) => isTelegramMapStateFile(name) && name !== TG_MAP_MIGRATION_FILE);
          const destinationDigest = telegramMigrationManifest(destination, destinationNames, budget).digest;
          if (destinationDigest !== marker.destinationDigest) {
            throw new Error(`telegram: mapping migration for "${tenant}" has a conflicting destination`);
          }
          const expected = new Map(marker.sourceManifest.map((entry) => [entry.name, entry]));
          const remainingBytes = sourceManifest.entries.reduce((total, entry) => total + entry.bytes, 0);
          chargeTelegramMapBudget(budget, { bytes: remainingBytes, work: remainingBytes });
          for (const entry of sourceManifest.entries) {
            const expectedEntry = expected.get(entry.name);
            if (!expectedEntry || expectedEntry.sha256 !== entry.sha256 || expectedEntry.bytes !== entry.bytes) {
              throw new Error(`telegram: mapping migration for "${tenant}" has changed source state`);
            }
            const observed = source.read(entry.name);
            removeTelegramMapFile(source, entry.name, observed);
          }
          return;
        }
      }
      const snapshot = readTelegramMapSnapshot(source, tenant, chatId, budget, true);
      const migrationRoute = this.mappingRouteBinding(chatId);
      const migratedRecords = snapshot.records.map((entry) => {
        this.assertProofAuthorityLive();
        if (entry.root || entry.route || entry.delivery || entry.proof) {
          if (!telegramMappingProofMatches(entry, pinnedRoot, migrationRoute, this.proofAuthority)) {
            throw new Error("telegram: legacy mapping contains an invalid bound proof");
          }
          return entry;
        }
        const receipt: TelegramMappingReceipt = { sent: true, channelRef: `tg:${entry.messageId}` };
        const unsigned: TelegramMappingRecord = {
          escId: entry.escId,
          messageId: entry.messageId,
          chatId,
          root: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
          route: migrationRoute,
          delivery: {
            payload_digest: legacyTelegramMappingPayloadDigest(tenant, chatId, entry.escId, entry.messageId),
            delivery_digest: telegramDeliveryDigest(legacyTelegramMappingPayloadDigest(tenant, chatId, entry.escId, entry.messageId), receipt),
            receipt,
          },
        };
        const proof = telegramMappingProof(unsigned, this.proofAuthority);
        if (!proof) throw new TelegramActivationRevokedError("telegram mapping proof authority is unavailable");
        return { ...unsigned, proof };
      });
      const migratedSnapshot: TelegramMapSnapshot = { ...snapshot, records: migratedRecords };
      const callbacks = readTelegramCallbackBindings(source, tenant, chatId, this.mappingMaxEntryBytes, true);
      if (snapshot.records.some((entry) => entry.escId.split("/")[0] !== tenant)
        || (callbacks?.bindings.some((entry) => entry.escId.split("/")[0] !== tenant) ?? false)) {
        throw new Error(`telegram: legacy mapping for "${tenant}" contains a foreign escalation`);
      }
      if (!destination) {
        destination = this.openMappingQueue(tenant, chatId, true, pinnedRoot);
        if (!destination) throw new Error(`telegram: mapping partition for run "${tenant}" is unavailable or unsafe`);
        destinationLock = acquireTelegramMapLock(destination, tenant, chatId);
        recoverTelegramMap(destination, tenant, chatId, destinationLock, budget);
      }

      let destinationMetadata = readTelegramMapMetadata(destination);
      if (destinationMetadata && (destinationMetadata.tenant !== tenant || destinationMetadata.chatId !== chatId)) {
        throw new Error(`telegram: mapping partition for run "${tenant}" has conflicting tenant/chat metadata`);
      }
      if (!destinationMetadata) {
        const serialized = JSON.stringify({ schema: 2, tenant, chatId });
        if (Buffer.byteLength(serialized, "utf8") > this.mappingMaxEntryBytes) {
          throw new Error("telegram: mapping metadata exceeds the shard byte cap");
        }
        try {
          destination.writeExclusive(TG_MAP_META_FILE, serialized);
        } catch (error) {
          if (!isRetryableMappingRace(error)) throw error;
          destinationMetadata = readTelegramMapMetadata(destination);
          if (!destinationMetadata || destinationMetadata.tenant !== tenant || destinationMetadata.chatId !== chatId) {
            throw new Error(`telegram: mapping partition for run "${tenant}" has conflicting tenant/chat metadata`);
          }
        }
      }

      const destinationSnapshot = readTelegramMapSnapshot(destination, tenant, chatId, budget);
      const mergedRecords = [...destinationSnapshot.records];
      const byEscId = new Map<string, number>();
      const byMessageKey = new Map<string, string>();
      for (const entry of mergedRecords) addTelegramMapping(mergedRecords, byEscId, byMessageKey, entry);
      const destinationLength = mergedRecords.length;
      for (const entry of migratedSnapshot.records) addTelegramMapping(mergedRecords, byEscId, byMessageKey, entry);
      const nextShardIndex = writeCanonicalTelegramMappingRecords(
        destination,
        mergedRecords.slice(destinationLength),
        this.mappingMaxEntryBytes,
        destinationSnapshot.shardNames.length,
        destinationSnapshot.generation,
      );
      if (nextShardIndex > destinationSnapshot.shardNames.length) {
        const migrationLock = destinationLock;
        if (!migrationLock) throw new Error("telegram: mapping migration lock is unavailable");
        maybeCompactTelegramMap(destination, tenant, chatId, {
          records: mergedRecords,
          shardNames: listTelegramMapFiles(destination, budget)
            .filter((name) => destinationSnapshot.generation === null ? TG_MAP_LEGACY_RE.test(name) : TG_MAP_GENERATION_RE.test(name))
            .sort(),
          generation: destinationSnapshot.generation,
        }, this.mappingMaxEntryBytes, migrationLock, true, budget);
      }

      const destinationCallbacks = readTelegramCallbackBindings(destination, tenant, chatId, this.mappingMaxEntryBytes);
      const mergedCallbacks = [...(destinationCallbacks?.bindings ?? [])];
      const byToken = new Map<string, TelegramCallbackBinding>();
      const byPair = new Map<string, TelegramCallbackBinding>();
      for (const binding of mergedCallbacks) {
        byToken.set(binding.token, binding);
        byPair.set(`${binding.escId}\u0000${binding.optionId}`, binding);
      }
      for (const binding of callbacks?.bindings ?? []) {
        const tokenConflict = byToken.get(binding.token);
        const pairConflict = byPair.get(`${binding.escId}\u0000${binding.optionId}`);
        if ((tokenConflict && (tokenConflict.escId !== binding.escId || tokenConflict.optionId !== binding.optionId))
          || (pairConflict && pairConflict.token !== binding.token)) {
          throw new Error("telegram: callback mapping migration conflicts");
        }
        if (!tokenConflict && !pairConflict) {
          mergedCallbacks.push(binding);
          byToken.set(binding.token, binding);
          byPair.set(`${binding.escId}\u0000${binding.optionId}`, binding);
        }
      }
      if (callbacks && mergedCallbacks.length > (destinationCallbacks?.bindings.length ?? 0)) {
        const serialized = mergedCallbacks.map(callbackBindingLine).join("");
        if (Buffer.byteLength(serialized, "utf8") > this.mappingMaxEntryBytes) {
          throw new Error("telegram: callback mapping shard exceeds the byte cap");
        }
        if (destinationCallbacks) {
          destination.replaceIfMatches(
            TG_CALLBACK_FILE,
            {
              dev: destinationCallbacks.observed.dev,
              ino: destinationCallbacks.observed.ino,
              sha256: createHash("sha256").update(destinationCallbacks.observed.bytes).digest("hex"),
            },
            serialized,
          );
        } else {
          destination.writeExclusive(TG_CALLBACK_FILE, serialized);
        }
      }

      const destinationNames = listTelegramMapFiles(destination, budget)
        .filter((name) => isTelegramMapStateFile(name) && name !== TG_MAP_MIGRATION_FILE);
      const destinationManifest = telegramMigrationManifest(destination, destinationNames, budget);
      const markerSerialized = JSON.stringify({
        schema: 1,
        tenant,
        chatId,
        sourceDigest: sourceManifest.digest,
        destinationDigest: destinationManifest.digest,
        generation: snapshot.generation,
        sourceManifest: sourceManifest.entries,
      });
      if (Buffer.byteLength(markerSerialized, "utf8") > Math.max(this.mappingMaxEntryBytes, TG_MAP_CONTROL_MAX_ENTRY_BYTES)) {
        throw new Error("telegram: legacy mapping migration manifest exceeds the marker byte cap");
      }
      destination.writeAtomic(TG_MAP_MIGRATION_FILE, markerSerialized);
      chargeTelegramMapBudget(budget, { bytes: sourceManifest.totalBytes, work: sourceManifest.totalBytes });
      for (const entry of sourceManifest.entries) {
        const observed = source.read(entry.name);
        if (observed.bytes.byteLength !== entry.bytes || createHash("sha256").update(observed.bytes).digest("hex") !== entry.sha256) {
          throw new Error(`telegram: mapping migration source changed before cleanup`);
        }
        removeTelegramMapFile(source, entry.name, observed);
      }
    } finally {
      if (destinationLock && destination) releaseTelegramMapLock(destination, destinationLock);
      destination?.close();
      if (sourceLock) releaseTelegramMapLock(source, sourceLock);
      source.close();
    }
    if (pinnedRoot && !pinnedRoot.isStable()) throw new Error("telegram: project root changed after mapping migration");
  }


  private assertProofAuthorityLive(): void {
    try {
      assertCtoRuntimeProofAuthorityLive(this.proofAuthority);
    } catch (error) {
      throw new TelegramActivationRevokedError("telegram mapping proof authority is no longer live", { cause: error });
    }
  }

  private assertLive(pinnedRoot: PinnedProjectRoot, lifecycle?: AdapterOperationContext): void {
    this.assertProofAuthorityLive();
    try {
      lifecycle?.assertLive?.();
      this.runtimeAccess?.assertLive();
    } catch (error) {
      if (isTelegramActivationFailure(error)) throw error;
      throw new TelegramActivationRevokedError("telegram activation is no longer live", { cause: error });
    }
    if (!pinnedRoot.isStable()) throw new TelegramActivationRevokedError("telegram project root identity changed");
  }

  private async api(method: string, payload: Record<string, unknown>, lifecycle?: AdapterOperationContext): Promise<unknown> {
    lifecycle?.assertLive?.();
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        ...(lifecycle ? { signal: lifecycle.signal } : {}),
      });
    } catch (error) {
      if (isTelegramActivationFailure(error)) throw error;
      throw new TelegramApiError(`telegram ${method} -> transport failure`, false, error);
    }
    lifecycle?.assertLive?.();
    if (!response.ok) {
      // Telegram may have accepted a request before returning a 5xx or
      // rate-limit response. Only deterministic client rejections are safe to
      // consume; every other HTTP response remains retryable/ambiguous.
      const definitiveUnsent = response.status >= 400 && response.status < 500 && response.status !== 429;
      throw new TelegramApiError(`telegram ${method} -> ${response.status}`, definitiveUnsent, undefined, { httpStatus: response.status });
    }
    let body: TelegramApiEnvelope;
    try {
      const value = await readTelegramApiJson(response, lifecycle?.signal);
      lifecycle?.assertLive?.();
      body = normalizeTelegramApiEnvelope(value);
      validateTelegramApiResult(method, body);
    } catch (error) {
      if (isTelegramActivationFailure(error)) throw error;
      throw new TelegramApiError(`telegram ${method} -> malformed response`, false, error);
    }
    if (!body.ok) {
      const errorCode = body.error_code;
      const retryAfter = body.parameters && typeof body.parameters === "object" && !Array.isArray(body.parameters) && typeof body.parameters.retry_after === "number" ? body.parameters.retry_after : undefined;
      const definitiveUnsent = errorCode !== undefined && errorCode >= 400 && errorCode < 500 && errorCode !== 429;
      throw new TelegramApiError(`telegram ${method} -> api ${errorCode ?? "not-ok"}`, definitiveUnsent, undefined, { apiErrorCode: errorCode, retryAfter });
    }
    return body.result;
  }

  private sendMessagePayload(esc: Escalation): Record<string, unknown> {
    const text = [esc.title, "", esc.body, esc.default ? `(default: ${esc.default})` : "", telegramCorrelationMarker(esc)].join("\n");
    const payload: Record<string, unknown> = {
      chat_id: this.chatId,
      text,
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "Answer the CTO escalation",
      },
    };
    if (esc.options && esc.options.length > 0) {
      payload.reply_markup = {
        inline_keyboard: esc.options.map((option) => [{
          text: option.label,
          callback_data: telegramCallbackToken(esc.id, option.id),
        }]),
      };
    }
    return payload;
  }

  async send(esc: Escalation, suppliedPin?: PinnedProjectRoot, lifecycle?: AdapterOperationContext): Promise<EscalationReceipt> {
    const validation = validateTelegramEscalation(esc, this.mappingMaxEntryBytes, this.chatId);
    if (validation) return invalidTelegramEscalationReceipt(validation);
    this.assertProofAuthorityLive();
    const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(this.cwd);
    if (!pinnedRoot) return { sent: false, channelRef: "tg:send-root-unavailable" };
    const ownsPin = suppliedPin === undefined;
    try {
      this.assertLive(pinnedRoot, lifecycle);
      this.prepareCallbackMappings(esc, pinnedRoot, lifecycle);
      this.assertLive(pinnedRoot, lifecycle);
      const result = (await this.api("sendMessage", this.sendMessagePayload(esc), lifecycle)) as { message_id: number };
      this.assertLive(pinnedRoot, lifecycle);
      this.recordMapping(esc.id, result.message_id, esc, { sent: true, channelRef: `tg:${result.message_id}` }, pinnedRoot, lifecycle);
      this.assertLive(pinnedRoot, lifecycle);
      return { sent: true, channelRef: `tg:${result.message_id}` };
    } catch (error) {
      if (isTelegramActivationFailure(error)) throw error;
      return { sent: false, channelRef: this.failedChannelRef("sendMessage", error) };
    } finally {
      if (ownsPin) pinnedRoot.close();
    }
  }


  /**
   * Durable idempotent delivery. A prepared marker is written before the
   * Telegram call. A definitive rejection becomes retryable `failed`, while
   * an accepted message is journaled as `delivered_unmapped` before local
   * mapping. Mapping/promotion failures therefore repair without resending;
   * only an unknown outcome remains DELIVERY_EFFECT_AMBIGUOUS.
   */
  async sendWithIdempotency(esc: Escalation, idempotencyKey: string, suppliedPin?: PinnedProjectRoot, lifecycle?: AdapterOperationContext): Promise<EscalationReceipt> {
    const validation = validateTelegramEscalation(esc, this.mappingMaxEntryBytes, this.chatId);
    if (validation) return invalidTelegramEscalationReceipt(validation);
    this.assertProofAuthorityLive();
    const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(this.cwd);
    if (!pinnedRoot) return { sent: false, channelRef: "tg:send-root-unavailable" };
    const ownsPin = suppliedPin === undefined;
    try {
      this.assertLive(pinnedRoot, lifecycle);
      return await this.sendWithIdempotencyPinned(esc, idempotencyKey, pinnedRoot, lifecycle);
    } finally {
      if (ownsPin) pinnedRoot.close();
    }
  }

  private async sendWithIdempotencyPinned(esc: Escalation, idempotencyKey: string, pinnedRoot: PinnedProjectRoot, lifecycle?: AdapterOperationContext): Promise<EscalationReceipt> {
    const assertLive = (): void => this.assertLive(pinnedRoot, lifecycle);
    assertLive();
    const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
    if (!key) return { sent: false, channelRef: "tg:idempotency-key-required" };
    if (Buffer.byteLength(key, "utf8") > MAX_TELEGRAM_IDEMPOTENCY_KEY_UTF8_BYTES) {
      return { sent: false, channelRef: "tg:idempotency-key-too-large" };
    }
    const payloadDigest = deliveryPayloadDigest(esc);
    const initialPrepared = serializeDeliveryEffectRecord(
      { schema: 1, status: "prepared", key, escalation_id: esc.id, payload_digest: payloadDigest, at: new Date().toISOString() },
      DEFAULT_QUEUE_MAX_ENTRY_BYTES,
    );
    try {
      assertLive();
      this.prepareCallbackMappings(esc, pinnedRoot, lifecycle);
      assertLive();
    } catch (error) {
      if (isTelegramActivationFailure(error)) throw error;
      return { sent: false, channelRef: this.failedChannelRef("mapping", error) };
    }
    assertLive();
    const marker = this.openDeliveryEffect(esc, key, pinnedRoot);
    assertLive();
    let prepared = false;
    try {
      const existing = this.readDeliveryEffect(marker.queue, marker.name);
      if (existing) {
        if (
          existing.key !== key
          || existing.escalation_id !== esc.id
          || existing.payload_digest !== payloadDigest
        ) {
          throw new DeliveryEffectAmbiguousError(key);
        }
        if (existing.status === "delivered") return existing.receipt;
        if (existing.status === "delivered_unmapped") {
          try {
            assertLive();
            this.recordMapping(esc.id, existing.message_id, esc, existing.receipt, pinnedRoot, lifecycle);
            assertLive();
            promoteDeliveryEffectDelivered(this.cwd, esc, key, marker.name, payloadDigest, existing.receipt, pinnedRoot);
            assertLive();
            return existing.receipt;
          } catch (error) {
            if (isTelegramActivationFailure(error)) throw error;
            throw new DeliveryEffectAmbiguousError(key);
          }
        }
        if (existing.status === "failed") {
          try {
            const observed = marker.queue.read(marker.name);
            assertLive();
            marker.queue.replaceIfMatches(
              marker.name,
              { dev: observed.dev, ino: observed.ino, sha256: createHash("sha256").update(observed.bytes).digest("hex") },
              serializeDeliveryEffectRecord(
                { schema: 1, status: "prepared", key, escalation_id: esc.id, payload_digest: payloadDigest, at: new Date().toISOString() },
                marker.queue.maxEntryBytes,
              ),
            );
            prepared = true;
          } catch {
            throw new DeliveryEffectAmbiguousError(key);
          }
        } else {
          throw new DeliveryEffectAmbiguousError(key);
        }
      } else {
        try {
          assertLive();
          marker.queue.writeExclusive(marker.name, initialPrepared);
          assertLive();
          prepared = true;
        } catch (error) {
          if (!(error instanceof BoundedQueueError && error.code === "exists")) throw error;
          const raced = this.readDeliveryEffect(marker.queue, marker.name);
          if (
            raced?.key === key
            && raced.escalation_id === esc.id
            && raced.payload_digest === payloadDigest
            && raced.status === "delivered"
          ) return raced.receipt;
          throw new DeliveryEffectAmbiguousError(key);
        }
      }
    } finally {
      if (!prepared) marker.queue.close();
    }
    marker.queue.close();
    assertLive();

    let result: { message_id?: unknown };
    try {
      result = (await this.api("sendMessage", this.sendMessagePayload(esc), lifecycle)) as { message_id?: unknown };
    } catch (error) {
      if (isTelegramActivationFailure(error)) throw error;
      if (!(error instanceof TelegramApiError) || !error.definitiveUnsent) {
        throw new DeliveryEffectAmbiguousError(key);
      }
      const receipt = { sent: false, channelRef: this.failedChannelRef("sendMessage", error) };
      assertLive();
      markDeliveryEffectFailed(this.cwd, esc, key, marker.name, payloadDigest, receipt, pinnedRoot);
      assertLive();
      return receipt;
    }
    assertLive();
    if (!Number.isSafeInteger(result.message_id) || (result.message_id as number) <= 0) {
      throw new DeliveryEffectAmbiguousError(key);
    }
    const messageId = result.message_id as number;
    const remoteReceipt: EscalationReceipt = { sent: true, channelRef: `tg:${messageId}` };
    assertLive();
    markDeliveryEffectUnmapped(this.cwd, esc, key, marker.name, payloadDigest, messageId, remoteReceipt, pinnedRoot);
    assertLive();
    try {
      this.recordMapping(esc.id, messageId, esc, remoteReceipt, pinnedRoot, lifecycle);
      assertLive();
    } catch (error) {
      if (isTelegramActivationFailure(error)) throw error;
      return { sent: false, channelRef: `tg:${messageId}:mapping-pending` };
    }
    assertLive();
    promoteDeliveryEffectDelivered(this.cwd, esc, key, marker.name, payloadDigest, remoteReceipt, pinnedRoot);
    assertLive();
    return remoteReceipt;
  }

  private openDeliveryEffect(esc: Escalation, key: string, pinnedRoot: PinnedProjectRoot): { queue: NonNullable<ReturnType<typeof openBoundedQueue>>; name: string } {
    const runId = runIdOf(esc);
    if (!isSafeRunId(runId)) throw new Error("telegram: delivery marker rejected unsafe runId " + runId);
    if (!pinnedRoot.isStable()) throw new DeliveryEffectAmbiguousError(key);
    const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", runId, "delivery-effects"), { pinnedRoot });
    if (!queue) throw new Error("telegram: delivery marker queue for run " + runId + " is unavailable or unsafe");
    const name = createHash("sha256").update(key).digest("hex") + ".json";
    return { queue, name };
  }

  private readDeliveryEffect(queue: NonNullable<ReturnType<typeof openBoundedQueue>>, name: string): DeliveryEffectRecord | null {
    if (!queue.exists(name)) return null;
    let value: unknown;
    try {
      const observed = queue.read(name);
      value = JSON.parse(decodeTelegramUtf8(observed.bytes));
    } catch {
      throw new DeliveryEffectAmbiguousError(name);
    }
    if (!isDeliveryEffectRecord(value)) throw new DeliveryEffectAmbiguousError(name);
    return value;
  }

  async cancel(id: string, suppliedPin?: PinnedProjectRoot): Promise<void> {
    const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(this.cwd);
    if (!pinnedRoot || !pinnedRoot.isStable()) {
      if (!suppliedPin) pinnedRoot?.close();
      return;
    }
    try {
      this.assertLive(pinnedRoot);
      const msgId = this.messageIdOf(id, pinnedRoot);
      // Mapping resolution and the external delete must be fenced by the same
      // descriptor identity. Never reopen the lexical path after a swap.
      if (msgId === null || !pinnedRoot.isStable()) return;
      try {
        this.assertLive(pinnedRoot);
        await this.api("deleteMessage", { chat_id: this.chatId, message_id: msgId });
        this.assertLive(pinnedRoot);
      } catch (error) {
        if (isTelegramActivationFailure(error)) throw error;
        // best-effort cancellation
      }
    } finally {
      if (!suppliedPin) pinnedRoot.close();
    }
  }

  /** Plain text reply (no reply markup) — used by the standalone bridge. */
  async sendPlainText(target: string, text: string, suppliedPin?: PinnedProjectRoot): Promise<PlainTextSendOutcome> {
    const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(this.cwd);
    if (!pinnedRoot || !pinnedRoot.isStable()) {
      if (!suppliedPin) pinnedRoot?.close();
      return { sent: false, status: "retryable", channelRef: "tg:send-root-changed", reason: "project root changed" };
    }
    try {
      this.assertLive(pinnedRoot);
      await this.api("sendMessage", { chat_id: target, text });
      this.assertLive(pinnedRoot);
      return { sent: true, status: "sent" };
    } catch (error) {
      if (isTelegramActivationFailure(error)) throw error;
      const apiError = error instanceof TelegramApiError ? error : undefined;
      const statusCode = apiError?.httpStatus ?? apiError?.apiErrorCode;
      const permanent = statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
      return {
        sent: false,
        status: permanent ? "permanent" : "retryable",
        channelRef: this.failedChannelRef("sendMessage", error),
        ...(statusCode === undefined ? {} : { httpStatus: statusCode }),
        reason: permanent ? `Telegram rejected the reply (HTTP ${statusCode})` : "Telegram reply delivery is retryable",
      };
    } finally {
      if (!suppliedPin) pinnedRoot.close();
    }
  }

  /**
   * SEC-002: map a failed call to a token-free channelRef. The receipt
   * channelRef is logged by dispatchers/operators, and some fetch
   * implementations (node-fetch v2 style) embed the full request URL —
   * including `bot<TOKEN>` — in error.message, so raw error text must never
   * land there. The adapter builds the marker itself:
   * `tg:<method>:failed`, or `tg:<method>:http-<status>` when the failure is
   * the adapter's own HTTP-status error from `api()` (status digits only,
   * token-free by construction).
   */
  private failedChannelRef(method: string, error: unknown): string {
    if (error instanceof TelegramApiError) {
      if (error.httpStatus !== undefined) return `tg:${method}:http-${error.httpStatus}`;
      if (error.apiErrorCode !== undefined) return `tg:${method}:api-${error.apiErrorCode}`;
    }
    return `tg:${method}:failed`;
  }

  /** Start the long-polling loop (non-blocking); returns a stop function. */
  start(): () => void {
    if (this.polling) return () => undefined;
    this.polling = true;
    const generation = ++this.loopGeneration;
    void this.pollLoop(generation);
    return () => {
      this.polling = false;
    };
  }

  /**
   * Self-scheduling poll loop: the next round starts only after the previous
   * one completed (a long-poll round can block up to `timeout: 30`), so there
   * is never more than one in-flight getUpdates per adapter.
   */
  private async pollLoop(generation: number): Promise<void> {
    while (this.polling && generation === this.loopGeneration) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (isTelegramActivationFailure(error)) {
          this.polling = false;
          break;
        }
        // One bad round must not kill the loop; the next iteration retries
        // from the unconfirmed offset (updates are not lost).
      }
      if (!this.polling || generation !== this.loopGeneration) break;
      const { promise, resolve } = deferred<void>();
      setTimeout(resolve, this.pollIntervalMs);
      await promise;
    }
  }

  /**
   * One getUpdates round. Concurrent callers share the same in-flight round,
   * so at most one getUpdates request is issued per adapter at any time. The
   * offset is advanced only after an update was processed successfully: a
   * callback/answer persistence failure keeps the update unconfirmed so
   * Telegram re-delivers it on the next poll (no lost messages).
   */
  setUpdateCommitHook(hook: TelegramUpdateCommitHook | undefined): void {
    this.onUpdateCommitted = hook;
  }

  setInitialOffset(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || this.polling || this.offset !== 0) throw new Error("telegram: initial offset cannot be changed");
    this.offset = offset;
  }

  async pollOnce(pinnedRoot?: PinnedProjectRoot, lifecycle?: AdapterOperationContext): Promise<EscalationAnswer[]> {
    if (this.pollInFlight) return this.pollInFlight;
    const round = this.runPollOnce(pinnedRoot, lifecycle);
    this.pollInFlight = round;
    try {
      return await round;
    } finally {
      if (this.pollInFlight === round) this.pollInFlight = null;
    }
  }

  private async runPollOnce(suppliedPin?: PinnedProjectRoot, lifecycle?: AdapterOperationContext): Promise<EscalationAnswer[]> {
    const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(this.cwd);
    if (!pinnedRoot) throw new Error("telegram: project root cannot be pinned for polling");
    const ownsPin = suppliedPin === undefined;
    try {
      this.assertLive(pinnedRoot, lifecycle);
      if (!this.polling && this.offset === 0) this.polling = true;
      const rawUpdates = await this.api("getUpdates", {
        offset: this.offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      }, lifecycle);
      this.assertLive(pinnedRoot, lifecycle);
      const updates = normalizeTelegramUpdates(rawUpdates);
      const answers: EscalationAnswer[] = [];
      let previousUpdateId = this.offset - 1;
      for (const update of updates) {
        this.assertLive(pinnedRoot, lifecycle);
        // Telegram normally returns strictly ascending IDs. Do not let a
        // duplicate or out-of-order row move the confirmation cursor backwards
        // or cause an older update to be processed twice.
        if (update.update_id < this.offset || update.update_id <= previousUpdateId) continue;
        previousUpdateId = update.update_id;
        // Authorization gate runs BEFORE any side effect: unauthorized updates
        // are dropped at the boundary — no answer file, no onPlainMessage wake —
        // but the offset still advances (max(update_id+1)) so Telegram does not
        // redeliver them forever. Authorized updates keep the "process first,
        // confirm after" semantics below (a persistence failure throws before
        // the offset moves, leaving the update queued).
        if (!this.isAuthorizedUpdate(update)) {
          this.assertLive(pinnedRoot, lifecycle);
          await this.onUpdateCommitted?.(update.update_id, pinnedRoot);
          this.assertLive(pinnedRoot, lifecycle);
          this.offset = update.update_id + 1;
          this.assertLive(pinnedRoot, lifecycle);
          continue;
        }
        this.assertLive(pinnedRoot, lifecycle);
        const answer = await this.answerFromUpdate(update, pinnedRoot, lifecycle);
        this.assertLive(pinnedRoot, lifecycle);
        if (answer) {
          this.assertLive(pinnedRoot, lifecycle);
          const persisted = this.writeAnswer(answer, pinnedRoot, lifecycle);
          this.assertLive(pinnedRoot, lifecycle);
          await this.onAnswer?.(persisted, pinnedRoot);
          this.assertLive(pinnedRoot, lifecycle);
          answers.push(persisted);
        }
        this.assertLive(pinnedRoot, lifecycle);
        await this.onUpdateCommitted?.(update.update_id, pinnedRoot);
        this.assertLive(pinnedRoot, lifecycle);
        this.offset = update.update_id + 1;
        this.assertLive(pinnedRoot, lifecycle);
      }
      return answers;
    } finally {
      if (ownsPin) pinnedRoot.close();
    }
  }

  /**
   * Inbound provenance gate (SEC-1). Fail closed:
   * - the update must carry a chat id (message.chat.id or
   *   callback_query.message.chat.id) that equals the configured chatId or is
   *   listed in allowedChatIds (the configured chatId is ALWAYS allowed;
   *   allowedChatIds only extends it);
   * - when allowedSenderIds is set (non-empty), the update must carry a
   *   sender id (message.from.id or callback_query.from.id) listed in it.
   * A missing chat id, or a missing sender id under a sender allowlist,
   * rejects the update.
   */
  private isAuthorizedUpdate(update: TgUpdate): boolean {
    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (chatId === undefined) return false;
    const allowedChats = new Set([this.chatId, ...this.allowedChatIds]);
    if (!allowedChats.has(String(chatId))) return false;
    if (this.allowedSenderIds.length > 0) {
      const senderId = update.message?.from?.id ?? update.callback_query?.from?.id;
      if (senderId === undefined) return false;
      if (!this.allowedSenderIds.includes(String(senderId))) return false;
    }
    return true;
  }

  private async answerFromUpdate(update: TgUpdate, pinnedRoot: PinnedProjectRoot, lifecycle?: AdapterOperationContext): Promise<EscalationAnswer | null> {
    const at = new Date().toISOString();
    const callbackQuery = update.callback_query;
    const callbackData = callbackQuery?.data;
    if (callbackQuery && callbackData && callbackQuery.message) {
      const sourceChatId = callbackQuery.message.chat?.id;
      if (sourceChatId === undefined) return null;
      const sourceChat = String(sourceChatId);
      const target = this.answerTargetOfMessage(callbackQuery.message.message_id, sourceChat, pinnedRoot);
      if (target && TELEGRAM_CALLBACK_TOKEN_RE.test(callbackData)) {
        const optionId = this.optionIdOfCallback(target.escId, callbackData, sourceChat, pinnedRoot);
        if (optionId) return { id: target.escId, run_id: target.runId, answer: optionId, at, by: "telegram:callback" };
      }
      // Accept pre-token callback data for deployed messages during migration.
      if (target) {
        const separator = callbackData.indexOf("::");
        if (separator > 0) {
          const escId = callbackData.slice(0, separator);
          const optionId = callbackData.slice(separator + 2);
          if (
            target.escId === escId
            && Buffer.byteLength(callbackData, "utf8") <= MAX_TELEGRAM_CALLBACK_DATA_UTF8_BYTES
            && isSafeEscalationId(escId)
            && isSafeEscalationOptionId(optionId)
          ) {
            return { id: escId, run_id: target.runId, answer: optionId, at, by: "telegram:callback" };
          }
        }
      }
    }
    if (callbackQuery?.message) throw new TelegramMappingRecoveryRequiredError(callbackQuery.message.message_id);
    const message = update.message;
    if (message?.reply_to_message) {
      const sourceChatId = message.chat?.id;
      if (sourceChatId === undefined) return null;
      const replyTo = message.reply_to_message;
      const marker = parseTelegramCorrelationMarker(replyTo.text);
      const target = this.answerTargetOfMessage(replyTo.message_id, String(sourceChatId), pinnedRoot, marker ?? undefined);
      if (target && isSafeCtoInboundText(message.text)) {
        return { id: target.escId, run_id: target.runId, answer: message.text, at, by: "telegram:reply" };
      }
      // A reply-shaped message is never a new plain task when its target is
      // stale, foreign, or otherwise unavailable. Surface a retryable typed
      // recovery state and leave the update offset unconfirmed.
      throw new TelegramMappingRecoveryRequiredError(replyTo.message_id);
    }
    // Plain message (no reply target, not a callback) -> CTO inbox task.
    if (message && isSafeCtoInboundText(message.text)) {
      lifecycle?.assertLive?.();
      if (!pinnedRoot.isStable()) throw new TelegramActivationRevokedError("telegram project root identity changed");
      const chatId = message.chat?.id;
      if (chatId === undefined) return null;
      const userId = message.from?.id;
      await this.onPlainMessage?.({
        id: telegramPlainMessageId(chatId, message.message_id),
        text: message.text,
        at,
        by: "telegram",
        chatId: String(chatId),
        ...(userId === undefined ? {} : { userId: String(userId) }),
        messageId: message.message_id,
      }, pinnedRoot);
      lifecycle?.assertLive?.();
      if (!pinnedRoot.isStable()) throw new TelegramActivationRevokedError("telegram project root identity changed");
    }
    return null;
  }

  private writeAnswer(answer: EscalationAnswer, pinnedRoot: PinnedProjectRoot, lifecycle?: AdapterOperationContext): EscalationAnswer {
    const runId = answer.run_id;
    if (!isSafeRunId(runId) || !isSafeEscalationId(answer.id) || answer.id.split("/")[0] !== runId) {
      throw new Error(`telegram: writeAnswer rejected unsafe answer identity "${String(answer.id)}"`);
    }
    this.assertLive(pinnedRoot, lifecycle);
    let queue;
    try {
      queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", runId, "answers"), { pinnedRoot });
    } catch (error) {
      if (error instanceof BoundedQueueError && error.code === "not_directory") {
        throw new Error(`${error.message}; answer path is not a directory`);
      }
      throw error;
    }
    if (!queue) throw new Error(`telegram: answer queue for run "${runId}" is unavailable or unsafe`);
    try {
      const fileName = canonicalDurableIdFileName(answer.id);
      const serialized = JSON.stringify(answer, null, 2);
      try {
        this.assertLive(pinnedRoot, lifecycle);
        queue.writeExclusive(fileName, serialized);
      } catch (error) {
        if (!(error instanceof BoundedQueueError && error.code === "exists")) throw error;
        let existing: Partial<EscalationAnswer>;
        try {
          const observed = queue.read(fileName);
          existing = JSON.parse(decodeTelegramUtf8(observed.bytes)) as Partial<EscalationAnswer>;
        } catch {
          throw error;
        }
        if (
          existing.id !== answer.id
          || existing.run_id !== answer.run_id
          || typeof existing.answer !== "string"
          || typeof existing.at !== "string"
          || typeof existing.by !== "string"
          || existing.answer !== answer.answer
        ) {
          throw new TelegramAnswerConflictError(answer.id);
        }
        return existing as EscalationAnswer;
      }
      this.assertLive(pinnedRoot, lifecycle);
      return answer;
    } finally {
      queue.close();
    }
  }

  // ── message_id <-> escId mapping (persisted, survives restarts) ──────────

  private openMappingQueue(runId: string, chatId = this.chatId, createDirectory = true, pinnedRoot?: PinnedProjectRoot): BoundedQueue | null {
    const relativeDirectory = telegramMappingPartition(runId, chatId);
    const options = {
      maxEntries: 64,
      maxWork: 64 * 1024,
      maxEntryBytes: Math.max(this.mappingMaxEntryBytes, TG_MAP_CONTROL_MAX_ENTRY_BYTES),
      maxScanEntries: 16_384,
      maxScanWork: 4 * 1024 * 1024,
      createDirectory,
      pinnedRoot,
    };
    try {
      const queue = openBoundedQueue(pinnedRoot?.canonical_root ?? this.cwd, relativeDirectory, options);
      if (!createDirectory && queue && queue.listPage().entries.length === 0) {
        queue.close();
        return null;
      }
      return queue;
    } catch (error) {
      if (createDirectory && error instanceof BoundedQueueError && error.code === "exists") {
        const queue = openBoundedQueue(pinnedRoot?.canonical_root ?? this.cwd, relativeDirectory, { ...options, createDirectory: false });
        return queue;
      }
      throw error;
    }
  }
  private openUnpartitionedMappingQueue(runId: string, createDirectory = false, pinnedRoot?: PinnedProjectRoot): BoundedQueue | null {
    const relativeDirectory = join(".work-state", "cto", runId);
    const options = {
      maxEntries: 64,
      maxWork: 64 * 1024,
      maxEntryBytes: Math.max(this.mappingMaxEntryBytes, TG_MAP_CONTROL_MAX_ENTRY_BYTES),
      maxScanEntries: 16_384,
      maxScanWork: 4 * 1024 * 1024,
      createDirectory,
      pinnedRoot,
    };
    try {
      const queue = openBoundedQueue(pinnedRoot?.canonical_root ?? this.cwd, relativeDirectory, options);
      if (!createDirectory && queue && queue.listPage().entries.length === 0) {
        queue.close();
        return null;
      }
      return queue;
    } catch (error) {
      if (createDirectory && error instanceof BoundedQueueError && error.code === "exists") {
        const queue = openBoundedQueue(pinnedRoot?.canonical_root ?? this.cwd, relativeDirectory, { ...options, createDirectory: false });
        return queue;
      }
      throw error;
    }
  }
  private ensureChatMappingMigrated(runId: string, chatId: string, pinnedRoot?: PinnedProjectRoot): void {
    const migration = this.legacyMappingMigration;
    if (migration?.tenant === runId && migration.chatId === chatId) {
      this.migrateLegacyMappings(runId, chatId, pinnedRoot);
    }
  }
  private mappingRouteBinding(chatId = this.chatId): TelegramMappingRoute {
    this.assertProofAuthorityLive();
    const runtimeAccess = this.runtimeAccess;
    if (!runtimeAccess) throw new TelegramActivationRevokedError("telegram runtime authority is unavailable");
    let snapshot: ReturnType<CtoRuntimeAccessFacade["resolveEscalationChannelSnapshot"]>;
    try {
      runtimeAccess.assertLive();
      snapshot = runtimeAccess.resolveEscalationChannelSnapshot();
    } catch (error) {
      throw new TelegramActivationRevokedError("telegram channel projection is unavailable", { cause: error });
    }
    if (snapshot.status !== "valid") throw new TelegramActivationRevokedError("telegram channel projection is not valid");
    const projections = snapshot.projections.telegram;
    if (!Array.isArray(projections) || projections.length === 0) throw new TelegramActivationRevokedError("telegram channel projection is absent");
    const targetConfigured = projections.some((projection) => {
      const direct = projection.chatId;
      const ackTarget = projection.ackTarget;
      const nested = projection.telegram;
      const nestedRecord = nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : null;
      const nestedChat = nestedRecord?.chatId;
      const allowed = nestedRecord?.allowedChatIds;
      const allowlisted = Array.isArray(allowed) && allowed.some((value) => typeof value === "string" && value === chatId);
      return (typeof direct === "string" && direct === chatId) || (typeof nestedChat === "string" && nestedChat === chatId) || allowlisted;
    });
    if (!targetConfigured) throw new TelegramActivationRevokedError("telegram channel target is not bound to the authenticated projection");
    return { projection_sha256: snapshot.config_sha256, channel: "telegram", target: chatId };
  }
  private prepareCallbackMappings(esc: Escalation, pinnedRoot: PinnedProjectRoot, lifecycle?: AdapterOperationContext): void {
    if (!esc.options || esc.options.length === 0) return;
    const assertLive = (): void => this.assertLive(pinnedRoot, lifecycle);
    assertLive();
    const runId = runIdOf(esc);
    if (!isSafeRunId(runId)) throw new Error(`telegram: callback mapping rejected unsafe runId "${runId}"`);
    assertLive();
    this.ensureChatMappingMigrated(runId, this.chatId, pinnedRoot);
    assertLive();
    const queue = this.openMappingQueue(runId, this.chatId, true, pinnedRoot);
    assertLive();
    if (!queue) throw new Error(`telegram: mapping queue for run "${runId}" is unavailable or unsafe`);
    let lock: TelegramMapLock | null = null;
    try {
      assertLive();
      lock = acquireTelegramMapLock(queue, runId, this.chatId);
      assertLive();
      refreshTelegramMapLock(queue, lock);
      assertLive();
      ensureTelegramMapMetadata(queue, runId, this.chatId);
      assertLive();
      const current = readTelegramCallbackBindings(queue, runId, this.chatId, this.mappingMaxEntryBytes);
      const byToken = new Map<string, TelegramCallbackBinding>();
      const byPair = new Map<string, TelegramCallbackBinding>();
      for (const binding of current?.bindings ?? []) {
        const pair = `${binding.escId}\u0000${binding.optionId}`;
        const tokenConflict = byToken.get(binding.token);
        const pairConflict = byPair.get(pair);
        if ((tokenConflict && (tokenConflict.escId !== binding.escId || tokenConflict.optionId !== binding.optionId)) || (pairConflict && pairConflict.token !== binding.token)) {
          throw new Error("telegram: callback mapping token collision");
        }
        byToken.set(binding.token, binding);
        byPair.set(pair, binding);
      }
      const additions: TelegramCallbackBinding[] = [];
      for (const option of esc.options) {
        const binding: TelegramCallbackBinding = {
          token: telegramCallbackToken(esc.id, option.id),
          escId: esc.id,
          optionId: option.id,
          chatId: this.chatId,
        };
        const pair = `${binding.escId}\u0000${binding.optionId}`;
        const tokenConflict = byToken.get(binding.token);
        const pairConflict = byPair.get(pair);
        if (tokenConflict && (tokenConflict.escId !== binding.escId || tokenConflict.optionId !== binding.optionId)) {
          throw new Error("telegram: callback mapping token collision");
        }
        if (pairConflict && pairConflict.token !== binding.token) {
          throw new Error("telegram: callback mapping token binding conflict");
        }
        if (!tokenConflict && !pairConflict) {
          byToken.set(binding.token, binding);
          byPair.set(pair, binding);
          additions.push(binding);
        }
      }
      const serialized = [...(current?.bindings ?? []), ...additions].map(callbackBindingLine).join("");
      if (Buffer.byteLength(serialized, "utf8") > this.mappingMaxEntryBytes) {
        throw new Error("telegram: callback mapping exceeds the shard byte cap");
      }
      assertLive();
      refreshTelegramMapLock(queue, lock);
      assertLive();
      if (current) {
        assertLive();
        queue.replaceIfMatches(
          TG_CALLBACK_FILE,
          { dev: current.observed.dev, ino: current.observed.ino, sha256: createHash("sha256").update(current.observed.bytes).digest("hex") },
          serialized,
        );
        assertLive();
      } else {
        assertLive();
        queue.writeExclusive(TG_CALLBACK_FILE, serialized);
        assertLive();
      }
    } finally {
      if (lock) releaseTelegramMapLock(queue, lock);
      queue.close();
    }
  }


  private recordMapping(escId: string, messageId: number, esc: Escalation, receipt?: EscalationReceipt, suppliedPin?: PinnedProjectRoot, lifecycle?: AdapterOperationContext): void {
    const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(this.cwd);
    if (!pinnedRoot) throw new Error("telegram: mapping project root cannot be pinned");
    if (suppliedPin) {
      this.recordMappingPinned(escId, messageId, esc, receipt, pinnedRoot, lifecycle);
      return;
    }
    try { this.recordMappingPinned(escId, messageId, esc, receipt, pinnedRoot, lifecycle); }
    finally { pinnedRoot.close(); }
  }

  private recordMappingPinned(escId: string, messageId: number, esc: Escalation, receipt: EscalationReceipt | undefined, pinnedRoot: PinnedProjectRoot, lifecycle?: AdapterOperationContext): void {
    const assertLive = (): void => this.assertLive(pinnedRoot, lifecycle);
    assertLive();
    const validation = validateEscalation(esc);
    if (validation) throw new Error(`telegram: mapping rejected escalation: ${validation}`);
    const runId = runIdOf(esc);
    if (escId !== esc.id || !isSafeEscalationId(escId) || !isSafeRunId(runId) || escId.split("/")[0] !== runId) {
      throw new Error(`telegram: mapping rejected unsafe escalation "${escId}"`);
    }
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error(`telegram: mapping rejected unsafe message ${String(messageId)}`);
    }
    assertLive();
    this.ensureChatMappingMigrated(runId, this.chatId, pinnedRoot);
    assertLive();
    this.assertProofAuthorityLive();
    const queue = this.openMappingQueue(runId, this.chatId, true, pinnedRoot);
    assertLive();
    if (!queue) throw new Error(`telegram: mapping queue for run "${runId}" is unavailable or unsafe`);
    const mappingReceipt: TelegramMappingReceipt = receipt?.sent === true && receipt.channelRef === `tg:${messageId}`
      ? { sent: true, channelRef: receipt.channelRef }
      : { sent: true, channelRef: `tg:${messageId}` };
    const payloadDigest = deliveryPayloadDigest(esc);
    const unsigned: TelegramMappingRecord = {
      escId,
      messageId,
      chatId: this.chatId,
      root: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
      route: this.mappingRouteBinding(),
      delivery: {
        payload_digest: payloadDigest,
        delivery_digest: telegramDeliveryDigest(payloadDigest, mappingReceipt),
        receipt: mappingReceipt,
      },
    };
    const proof = telegramMappingProof(unsigned, this.proofAuthority);
    if (!proof) throw new TelegramActivationRevokedError("telegram mapping proof authority is unavailable");
    const mapping: TelegramMappingRecord = { ...unsigned, proof };
    const line = `${JSON.stringify(mapping)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.mappingMaxEntryBytes) {
      queue.close();
      throw new Error(`telegram: mapping record for "${escId}" exceeds the shard byte cap`);
    }
    let lock: TelegramMapLock | null = null;
    try {
      assertLive();
      lock = acquireTelegramMapLock(queue, runId, this.chatId);
      assertLive();
      for (let attempt = 0; attempt < TG_MAP_MAX_CAS_ATTEMPTS; attempt += 1) {
        assertLive();
        refreshTelegramMapLock(queue, lock);
        assertLive();
        recoverTelegramMap(queue, runId, this.chatId, lock);
        assertLive();
        ensureTelegramMapMetadata(queue, runId, this.chatId);
        assertLive();
        const snapshot = readTelegramMapSnapshot(queue, runId, this.chatId);
        const existingByEsc = snapshot.records.find((entry) => entry.escId === escId);
        if (existingByEsc) {
          if (existingByEsc.messageId !== messageId || existingByEsc.chatId !== this.chatId
            || !telegramMappingProofMatches(existingByEsc, pinnedRoot, unsigned.route!, this.proofAuthority)
            || existingByEsc.delivery?.payload_digest !== payloadDigest) {
            throw new Error(`telegram: mapping for "${escId}" conflicts with message ${String(messageId)} or its proof`);
          }
          return;
        }
        const mappingKey = telegramMessageKey(this.chatId, messageId);
        const existingByMessage = snapshot.records.find((entry) => telegramMessageKey(entry.chatId, entry.messageId) === mappingKey);
        if (existingByMessage) {
          throw new Error(`telegram: message ${messageId} is already mapped to "${existingByMessage.escId}"`);
        }

        const activeName = snapshot.shardNames.at(-1) ?? mappingShardName(snapshot.generation, 0);
        if (queue.exists(activeName)) {
          const observed = queue.read(activeName);
          const current = decodeTelegramUtf8(observed.bytes);
          const candidate = `${current}${line}`;
          if (Buffer.byteLength(candidate, "utf8") <= this.mappingMaxEntryBytes) {
            try {
              assertLive();
              refreshTelegramMapLock(queue, lock);
              assertLive();
              queue.replaceIfMatches(
                activeName,
                { dev: observed.dev, ino: observed.ino, sha256: createHash("sha256").update(observed.bytes).digest("hex") },
                candidate,
              );
              assertLive();
              maybeCompactTelegramMap(queue, runId, this.chatId, {
                ...snapshot,
                records: [...snapshot.records, mapping],
              }, this.mappingMaxEntryBytes, lock);
              return;
            } catch (error) {
              if (isRetryableMappingRace(error)) continue;
              throw error;
            }
          }
        } else {
          try {
            assertLive();
            refreshTelegramMapLock(queue, lock);
            assertLive();
            queue.writeExclusive(activeName, line);
            assertLive();
            maybeCompactTelegramMap(queue, runId, this.chatId, {
              records: [...snapshot.records, mapping],
              shardNames: [...snapshot.shardNames, activeName],
              generation: snapshot.generation,
            }, this.mappingMaxEntryBytes, lock);
            return;
          } catch (error) {
            if (isRetryableMappingRace(error)) continue;
            throw error;
          }
        }

        const nextName = mappingShardName(snapshot.generation, nextMappingShardNumber(snapshot.shardNames, snapshot.generation));
        try {
          assertLive();
          refreshTelegramMapLock(queue, lock);
          assertLive();
          queue.writeExclusive(nextName, line);
          assertLive();
          maybeCompactTelegramMap(queue, runId, this.chatId, {
            records: [...snapshot.records, mapping],
            shardNames: [...snapshot.shardNames, nextName],
            generation: snapshot.generation,
          }, this.mappingMaxEntryBytes, lock);
          return;
        } catch (error) {
          if (isRetryableMappingRace(error)) continue;
          throw error;
        }
      }
      throw new Error(`telegram: mapping for "${escId}" changed concurrently`);
    } finally {
      if (lock) releaseTelegramMapLock(queue, lock);
      queue.close();
    }

  }
  private messageIdOf(escId: string, suppliedPin?: PinnedProjectRoot): number | null {
    const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(this.cwd);
    if (!pinnedRoot) return null;
    if (suppliedPin) return this.messageIdOfPinned(escId, pinnedRoot);
    try { return this.messageIdOfPinned(escId, pinnedRoot); }
    finally { pinnedRoot.close(); }
  }

  private messageIdOfPinned(escId: string, pinnedRoot: PinnedProjectRoot): number | null {
    const runId = escId.split("/")[0] ?? escId;
    if (!isSafeEscalationId(escId) || !isSafeRunId(runId) || escId.split("/")[0] !== runId || !pinnedRoot.isStable()) return null;
    try {
      this.ensureChatMappingMigrated(runId, this.chatId, pinnedRoot);
    } catch {
      return null;
    }
    const queue = this.openMappingQueue(runId, this.chatId, false, pinnedRoot);
    if (!queue) return null;
    let lock: TelegramMapLock | null = null;
    try {
      lock = acquireTelegramMapLock(queue, runId, this.chatId);
      recoverTelegramMap(queue, runId, this.chatId, lock);
      if (!pinnedRoot.isStable()) return null;
      const snapshot = readTelegramMapSnapshot(queue, runId, this.chatId);
      const mapping = snapshot.records.find((entry) => entry.escId === escId);
      return mapping && telegramMappingProofMatches(mapping, pinnedRoot, this.mappingRouteBinding(), this.proofAuthority) ? mapping.messageId : null;
    } catch {
      return null;
    } finally {
      if (lock) releaseTelegramMapLock(queue, lock);
      queue.close();
    }
  }
  private optionIdOfCallback(escId: string, token: string, chatId = this.chatId, suppliedPin?: PinnedProjectRoot): string | null {
    const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(this.cwd);
    if (!pinnedRoot) return null;
    if (!suppliedPin) {
      try { return this.optionIdOfCallbackPinned(escId, token, chatId, pinnedRoot); }
      finally { pinnedRoot.close(); }
    }
    return this.optionIdOfCallbackPinned(escId, token, chatId, pinnedRoot);
  }

  private optionIdOfCallbackPinned(escId: string, token: string, chatId: string, suppliedPin: PinnedProjectRoot): string | null {
    const runId = escId.split("/")[0] ?? escId;
    if (!isSafeEscalationId(escId) || !isSafeRunId(runId) || !TELEGRAM_CALLBACK_TOKEN_RE.test(token)) return null;
    try {
      this.ensureChatMappingMigrated(runId, chatId, suppliedPin);
    } catch {
      return null;
    }
    const queue = this.openMappingQueue(runId, chatId, false, suppliedPin);
    if (!queue) return null;
    let lock: TelegramMapLock | null = null;
    try {
      lock = acquireTelegramMapLock(queue, runId, chatId);
      const current = readTelegramCallbackBindings(queue, runId, chatId, this.mappingMaxEntryBytes);
      const binding = current?.bindings.find((entry) => entry.token === token && entry.escId === escId && entry.chatId === chatId);
      return binding?.optionId ?? null;
    } catch {
      return null;
    } finally {
      if (lock) releaseTelegramMapLock(queue, lock);
      queue.close();
    }
  }
  private answerTargetOfMessage(messageId: number, chatId = this.chatId, suppliedPin?: PinnedProjectRoot, marker?: TelegramCorrelationMarker): TelegramAnswerTarget | null {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
    try {
      chatId = boundedTelegramIdentity(chatId, "chatId");
    } catch {
      return null;
    }
    // Reverse lookup is restricted to the core-owned canonical run-delivery
    // index. Never enumerate arbitrary .work-state/cto children: an attacker
    // can otherwise exhaust the bounded scan before a valid mapping is seen.
    const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(this.cwd);
    if (!pinnedRoot) return null;
    let found: TelegramAnswerTarget | null = null;
    let ambiguous = false;
    const untrustedMessageEscIds = new Set<string>();
    const budget = newTelegramMapBudget();
    const messageKey = telegramMessageKey(chatId, messageId);
    try {
      if (!this.runtimeAccess) return null;
      const seenRuns = new Set<string>();
      const inspectCandidate = (candidate: unknown): boolean => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
        const entry = candidate as {
          run_id?: unknown;
          state_revision?: unknown;
          status?: unknown;
          updated_at?: unknown;
          pending_summary?: unknown;
          pending_outbox?: unknown;
          pending_retry?: unknown;
          summary_digest?: unknown;
        };
        if (typeof entry.run_id !== "string" || !isSafeRunId(entry.run_id)
          || typeof entry.state_revision !== "number" || !Number.isSafeInteger(entry.state_revision) || entry.state_revision < 0
          || (entry.status !== "active" && entry.status !== "standby" && entry.status !== "done" && entry.status !== "failed")
          || typeof entry.updated_at !== "string"
          || typeof entry.pending_summary !== "boolean" || typeof entry.pending_outbox !== "boolean" || typeof entry.pending_retry !== "boolean"
          || typeof entry.summary_digest !== "string"
          || seenRuns.has(entry.run_id)) return false;
        if (!this.runtimeAccess!.hasValidStateProof(entry.run_id)) return false;
        const state = this.runtimeAccess!.readState(entry.run_id);
        this.runtimeAccess!.assertLive();
        if (!pinnedRoot.isStable()) return false;
        if (!state || state.id !== entry.run_id || state.state_revision !== entry.state_revision || state.updated_at !== entry.updated_at) return false;
        const pauseKind = state.pause && typeof state.pause === "object" && !Array.isArray(state.pause)
          ? (state.pause as { kind?: unknown }).kind
          : undefined;
        const expectedStatus = pauseKind === "done"
          ? "done"
          : pauseKind === "failed"
            ? "failed"
            : state.standby === true ? "standby" : "active";
        if (entry.status !== expectedStatus) return false;
        this.runtimeAccess!.assertLive();
        if (!pinnedRoot.isStable()) return false;
        seenRuns.add(entry.run_id);
        try {
          this.ensureChatMappingMigrated(entry.run_id, chatId, pinnedRoot);
        } catch (error) {
          this.runtimeAccess!.assertLive();
          return pinnedRoot.isStable();
        }
        this.runtimeAccess!.assertLive();
        if (!pinnedRoot.isStable()) return false;
        const queue = this.openMappingQueue(entry.run_id, chatId, false, pinnedRoot);
        if (!queue) return true;
        let lock: TelegramMapLock | null = null;
        try {
          lock = acquireTelegramMapLock(queue, entry.run_id, chatId);
          this.runtimeAccess!.assertLive();
          if (!pinnedRoot.isStable()) return false;
          recoverTelegramMap(queue, entry.run_id, chatId, lock, budget);
          this.runtimeAccess!.assertLive();
          if (!pinnedRoot.isStable()) return false;
          const metadata = readTelegramMapMetadata(queue, budget);
          this.runtimeAccess!.assertLive();
          if (!pinnedRoot.isStable()) return false;
          if (metadata && (metadata.tenant !== entry.run_id || metadata.chatId !== chatId)) return true;
          const snapshot = readTelegramMapSnapshot(queue, entry.run_id, chatId, budget);
          this.runtimeAccess!.assertLive();
          if (!pinnedRoot.isStable()) return false;
          const route = this.mappingRouteBinding(chatId);
          for (const mapping of snapshot.records) {
            if (!isSafeEscalationId(mapping.escId) || telegramMessageKey(mapping.chatId, mapping.messageId) !== messageKey) continue;
            if (!telegramMappingProofMatches(mapping, pinnedRoot, route, this.proofAuthority)) {
              untrustedMessageEscIds.add(mapping.escId);
              continue;
            }
            const target = { runId: entry.run_id, escId: mapping.escId };
            if (found !== null && (found.runId !== target.runId || found.escId !== target.escId)) ambiguous = true;
            else found = target;
          }
        } catch (error) {
          if (error instanceof TelegramMapBudgetError) throw error;
          this.runtimeAccess!.assertLive();
          if (!pinnedRoot.isStable()) return false;
          // A corrupt indexed run is unavailable from this lookup; another
          // canonical index candidate may still contain the requested map.
        } finally {
          if (lock) releaseTelegramMapLock(queue, lock);
          queue.close();
        }
        return true;
      };
      this.runtimeAccess.assertLive();
      if (!pinnedRoot.isStable()) return null;
      const active = this.runtimeAccess.readActiveDeliveryCandidates();
      if (!active.ok || !Array.isArray(active.entries)) return null;
      for (const candidate of active.entries) {
        if (!inspectCandidate(candidate)) return null;
      }
      let cursor: string | undefined;
      let completed = false;
      for (let pageNumber = 0; pageNumber < TG_RUN_DELIVERY_MAX_PAGES; pageNumber += 1) {
        if (!pinnedRoot.isStable()) return null;
        this.runtimeAccess.assertLive();
        const page = this.runtimeAccess.readCompletedDeliveryIndexPage({
          ...(cursor === undefined ? {} : { after_run_id: cursor }),
          limit: TG_RUN_DELIVERY_PAGE_LIMIT,
        });
        this.runtimeAccess.assertLive();
        if (!pinnedRoot.isStable() || !page || typeof page !== "object" || !Array.isArray(page.entries)
          || page.entries.length > TG_RUN_DELIVERY_PAGE_LIMIT
          || (page.active_run_id !== null && !isSafeRunId(page.active_run_id))
          || (page.next_after_run_id !== null && !isSafeRunId(page.next_after_run_id))) return null;
        const nextCursor = page.next_after_run_id;
        if (nextCursor !== null && page.entries.length !== TG_RUN_DELIVERY_PAGE_LIMIT) return null;
        let previousRunId = cursor ?? "";
        for (const candidate of page.entries) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
          const runId = (candidate as { run_id?: unknown }).run_id;
          if (typeof runId !== "string" || runId <= previousRunId || !inspectCandidate(candidate)) return null;
          previousRunId = runId;
        }
        if (!pinnedRoot.isStable()) return null;
        this.runtimeAccess.assertLive();
        if (nextCursor === null) {
          completed = true;
          break;
        }
        if (page.entries.length === 0 || nextCursor <= (cursor ?? "")) return null;
        cursor = nextCursor;
      }
      if (!completed || !pinnedRoot.isStable()) return null;
      this.runtimeAccess.assertLive();
      if (marker && (untrustedMessageEscIds.size === 0 || untrustedMessageEscIds.has(marker.escId))) {
        const recovered = this.recoverPendingTelegramMapping(marker, messageId, chatId, pinnedRoot);
        if (recovered) return recovered;
      }
      return ambiguous ? null : found;
    } catch {
      return null;
    } finally {
      if (!suppliedPin) pinnedRoot.close();
    }
  }

  private recoverPendingTelegramMapping(marker: TelegramCorrelationMarker, messageId: number, chatId: string, pinnedRoot: PinnedProjectRoot): TelegramAnswerTarget | null {
    if (!this.runtimeAccess || !isSafeEscalationId(marker.escId) || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
    try { this.assertProofAuthorityLive(); } catch { return null; }
    const runId = marker.escId.split("/")[0];
    if (!runId || !isSafeCtoRunId(runId)) return null;
    try {
      this.runtimeAccess.assertLive();
      if (!this.runtimeAccess.hasValidStateProof(runId)) return null;
      const state = this.runtimeAccess.readState(runId);
      this.runtimeAccess.assertLive();
      if (!state || !pinnedRoot.isStable()) return null;
      const teams = state.teams;
      if (!Array.isArray(teams)) return null;
      let pending = false;
      for (const team of teams) {
        if (!team || typeof team !== "object" || Array.isArray(team)) continue;
        const escalations = (team as { escalations?: unknown }).escalations;
        if (!escalations || typeof escalations !== "object" || Array.isArray(escalations)) continue;
        const record = (escalations as Record<string, unknown>)[marker.escId];
        if (record && typeof record === "object" && !Array.isArray(record)
          && ((record as { status?: unknown }).status === "pending" || (record as { status?: unknown }).status === "undelivered")) {
          pending = true;
          break;
        }
      }
      if (!pending) return null;
      const obligations = this.runtimeAccess.readOutboxDeliveryObligations(runId);
      if (!Array.isArray(obligations)) return null;
      let escalation: Escalation | null = null;
      let matched = false;
      for (const obligation of obligations) {
        if (!obligation || obligation.run_id !== runId || obligation.entry_name !== canonicalDurableIdFileName(marker.escId)) continue;
        let value: unknown;
        try { value = JSON.parse(decodeTelegramUtf8(obligation.json)); } catch { continue; }
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const candidate = value as Escalation;
        if (validateEscalation(candidate) !== null) continue;
        if (candidate.id !== marker.escId || deliveryPayloadDigest(candidate) !== marker.payloadDigest) continue;
        const status = this.runtimeAccess.currentOutboxDeliveryStatus({
          run_id: runId,
          state_revision: obligation.state_revision,
          entry_name: obligation.entry_name,
          json: obligation.json,
          lane: "outbox",
        });
        this.runtimeAccess.assertLive();
        if (status !== "current" || !pinnedRoot.isStable()) continue;
        if (matched) return null;
        escalation = candidate;
        matched = true;
      }
      if (!matched || !escalation) return null;
      const mappingReceipt: TelegramMappingReceipt = { sent: true, channelRef: `tg:${messageId}` };
      const payloadDigest = deliveryPayloadDigest(escalation);
      const unsigned: TelegramMappingRecord = {
        escId: marker.escId,
        messageId,
        chatId,
        root: { canonical_path: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
        route: this.mappingRouteBinding(chatId),
        delivery: {
          payload_digest: payloadDigest,
          delivery_digest: telegramDeliveryDigest(payloadDigest, mappingReceipt),
          receipt: mappingReceipt,
        },
      };
      const proof = telegramMappingProof(unsigned, this.proofAuthority);
      if (!proof) return null;
      const mapping: TelegramMappingRecord = { ...unsigned, proof };
      const queue = this.openMappingQueue(runId, chatId, false, pinnedRoot);
      if (!queue) {
        this.recordMappingPinned(marker.escId, messageId, escalation, mappingReceipt, pinnedRoot);
        return { runId, escId: marker.escId };
      }
      let lock: TelegramMapLock | null = null;
      try {
        lock = acquireTelegramMapLock(queue, runId, chatId);
        this.runtimeAccess.assertLive();
        const snapshot = readTelegramMapSnapshot(queue, runId, chatId);
        const existingByMessage = snapshot.records.find((entry) => telegramMessageKey(entry.chatId, entry.messageId) === telegramMessageKey(chatId, messageId));
        if (existingByMessage && existingByMessage.escId !== marker.escId) return null;
        const records = snapshot.records.some((entry) => entry.escId === marker.escId)
          ? snapshot.records.map((entry) => entry.escId === marker.escId ? mapping : entry)
          : [...snapshot.records, mapping];
        maybeCompactTelegramMap(queue, runId, chatId, { ...snapshot, records }, this.mappingMaxEntryBytes, lock, true);
        this.runtimeAccess.assertLive();
        if (!pinnedRoot.isStable()) return null;
        return { runId, escId: marker.escId };
      } finally {
        if (lock) releaseTelegramMapLock(queue, lock);
        queue.close();
      }
    } catch {
      return null;
    }
  }
  private escIdOfMessage(messageId: number, chatId = this.chatId): string | null {
    return this.answerTargetOfMessage(messageId, chatId)?.escId ?? null;
  }

}

// The core index is capped at 4096 entries and pages at 64. Keep reverse
// lookup bounded to the complete canonical index without directory scans.
const TG_RUN_DELIVERY_PAGE_LIMIT = 64;
const TG_RUN_DELIVERY_MAX_PAGES = 64;

const TG_MAX_POLL_UPDATES = 256;
const TG_MAX_POLL_TOTAL_BYTES = 2 * 1024 * 1024;
const TG_MAX_POLL_UPDATE_BYTES = 64 * 1024;
const TG_MAX_POLL_TEXT_BYTES = 4_000;
const TG_MAX_POLL_METADATA_BYTES = 512;
const TG_MAX_POLL_UPDATE_ID = Number.MAX_SAFE_INTEGER - 1;
const TG_MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;

type TelegramRecord = Record<string, unknown>;

function isTelegramRecord(value: unknown): value is TelegramRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
async function readTelegramApiJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const contentLength = response.headers.get("content-length")?.trim();
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > TG_MAX_API_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The bounded response is already being rejected.
    }
    throw new Error(`telegram response exceeds ${TG_MAX_API_RESPONSE_BYTES}-byte limit`);
  }
  if (!response.body) throw new Error("telegram response body is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const onAbort = (): void => { void reader.cancel(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  const parts: string[] = [];
  let totalBytes = 0;
  let finished = false;
  let cancelled = false;
  try {
    while (true) {
      if (signal?.aborted) throw new Error("telegram response read aborted");
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) throw new Error("telegram response body chunk is invalid");
      totalBytes += chunk.value.byteLength;
      if (totalBytes > TG_MAX_API_RESPONSE_BYTES) {
        cancelled = true;
        await reader.cancel();
        throw new Error(`telegram response exceeds ${TG_MAX_API_RESPONSE_BYTES}-byte limit`);
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(""));
  } finally {
    if (!finished && !cancelled) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original read/decode/parse failure.
      }
    }
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

interface TelegramApiEnvelope {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: Record<string, unknown>;
}

function normalizeTelegramApiEnvelope(value: unknown): TelegramApiEnvelope {
  if (!isTelegramRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("telegram response envelope is invalid");
  }
  if (value.ok && !Object.prototype.hasOwnProperty.call(value, "result")) {
    throw new Error("telegram response result is missing");
  }
  const rawErrorCode = value.error_code;
  const errorCode = rawErrorCode === undefined ? undefined : telegramSafeInteger(rawErrorCode, 100, 599);
  if (!value.ok && rawErrorCode !== undefined && errorCode === null) {
    throw new Error("telegram response error_code is invalid");
  }
  const rawParameters = value.parameters;
  let parameters: Record<string, unknown> | undefined;
  if (rawParameters !== undefined) {
    if (!isTelegramRecord(rawParameters) || (rawParameters.retry_after !== undefined && telegramSafeInteger(rawParameters.retry_after, 0, Number.MAX_SAFE_INTEGER) === null)) {
      throw new Error("telegram response parameters are invalid");
    }
    parameters = rawParameters;
  }
  return {
    ok: value.ok,
    result: value.result,
    ...(errorCode === undefined || errorCode === null ? {} : { error_code: errorCode }),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(parameters === undefined ? {} : { parameters }),
  };
}

function validateTelegramApiResult(method: string, body: TelegramApiEnvelope): void {
  if (!body.ok) return;
  if (method === "sendMessage") {
    if (!isTelegramRecord(body.result) || telegramSafeInteger(body.result.message_id, 1, Number.MAX_SAFE_INTEGER - 1) === null) {
      throw new Error("telegram sendMessage result is invalid");
    }
  } else if (method === "getUpdates") {
    if (!Array.isArray(body.result)) {
      throw new Error("telegram getUpdates result is invalid");
    }
  } else if (method === "deleteMessage" && typeof body.result !== "boolean") {
    throw new Error("telegram deleteMessage result is invalid");
  }
}


function telegramSafeInteger(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum
    ? value
    : null;
}

function telegramSafeText(value: unknown, maxBytes: number, allowLineBreaks: boolean): string | undefined {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) return undefined;
  const controls = allowLineBreaks
    ? /[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u
    : /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;
  return controls.test(value) ? undefined : value;
}

function normalizeTelegramChat(value: unknown): { id: number } | undefined {
  if (!isTelegramRecord(value)) return undefined;
  const id = telegramSafeInteger(value.id, Number.MIN_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER - 1);
  return id === null ? undefined : { id };
}

function normalizeTelegramUser(value: unknown): { id: number } | undefined {
  if (!isTelegramRecord(value)) return undefined;
  const id = telegramSafeInteger(value.id, 0, Number.MAX_SAFE_INTEGER - 1);
  return id === null ? undefined : { id };
}

function normalizeTelegramMessage(value: unknown): TgUpdate["message"] | undefined {
  if (!isTelegramRecord(value)) return undefined;
  const messageId = telegramSafeInteger(value.message_id, 1, Number.MAX_SAFE_INTEGER - 1);
  if (messageId === null) return undefined;
  const message: NonNullable<TgUpdate["message"]> = { message_id: messageId };
  const text = telegramSafeText(value.text, TG_MAX_POLL_TEXT_BYTES, true);
  if (text !== undefined) message.text = text;
  const chat = normalizeTelegramChat(value.chat);
  if (chat) message.chat = chat;
  const from = normalizeTelegramUser(value.from);
  if (from) message.from = from;
  const replyRecord = isTelegramRecord(value.reply_to_message) ? value.reply_to_message : undefined;
  const reply = replyRecord ? telegramSafeInteger(replyRecord.message_id, 1, Number.MAX_SAFE_INTEGER - 1) : null;
  if (reply !== null) {
    const replyText = telegramSafeText(replyRecord?.text, TG_MAX_POLL_TEXT_BYTES, true);
    message.reply_to_message = { message_id: reply, ...(replyText === undefined ? {} : { text: replyText }) };
  }
  return message;
}

function normalizeTelegramCallback(value: unknown): TgUpdate["callback_query"] | undefined {
  if (!isTelegramRecord(value)) return undefined;
  const id = telegramSafeText(value.id, TG_MAX_POLL_METADATA_BYTES, false);
  if (id === undefined) return undefined;
  const callback: NonNullable<TgUpdate["callback_query"]> = { id };
  const message = normalizeTelegramMessage(value.message);
  if (message) callback.message = { message_id: message.message_id, chat: message.chat };
  const from = normalizeTelegramUser(value.from);
  if (from) callback.from = from;
  const data = telegramSafeText(value.data, TG_MAX_POLL_METADATA_BYTES, false);
  if (data !== undefined) callback.data = data;
  return callback;
}

function normalizeTelegramUpdate(value: unknown): TgUpdate | undefined {
  if (!isTelegramRecord(value)) return undefined;
  const updateId = telegramSafeInteger(value.update_id, 0, TG_MAX_POLL_UPDATE_ID);
  if (updateId === null) return undefined;
  const update: TgUpdate = { update_id: updateId };
  const message = normalizeTelegramMessage(value.message);
  if (message) update.message = message;
  const callback = normalizeTelegramCallback(value.callback_query);
  if (callback) update.callback_query = callback;
  return update;
}

function normalizeTelegramUpdates(value: unknown): TgUpdate[] {
  if (!Array.isArray(value) || value.length > TG_MAX_POLL_UPDATES) return [];
  let totalBytes = 0;
  const updates: TgUpdate[] = [];
  for (const candidate of value) {
    let serialized: string;
    try {
      const serializedValue = JSON.stringify(candidate);
      if (typeof serializedValue !== "string") continue;
      serialized = serializedValue;
    } catch {
      continue;
    }
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > TG_MAX_POLL_UPDATE_BYTES || totalBytes + bytes > TG_MAX_POLL_TOTAL_BYTES) continue;
    totalBytes += bytes;
    let update: TgUpdate | undefined;
    try {
      update = normalizeTelegramUpdate(candidate);
    } catch {
      continue;
    }
    if (update) updates.push(update);
  }
  return updates;
}

const TG_MAP_MIN_ENTRY_BYTES = 128;
const TG_MAP_DEFAULT_MAX_ENTRY_BYTES = DEFAULT_QUEUE_MAX_ENTRY_BYTES;
const TG_MAP_CONTROL_MAX_ENTRY_BYTES = 16 * 1024;
const TG_MAP_HARD_MAX_ENTRY_BYTES = DEFAULT_QUEUE_MAX_ENTRY_BYTES;
const TG_MAP_MAX_CAS_ATTEMPTS = 8;
const TG_MAP_COMPACT_LEGACY_SHARD_THRESHOLD = 3;
const TG_MAP_COMPACT_GENERATION_SHARD_THRESHOLD = 32;
const TG_MAP_FILE = "tg-map.jsonl";
const TG_MAP_META_FILE = "tg-map.meta.json";
const TG_MAP_MANIFEST_FILE = "tg-map.manifest.json";
const TG_MAP_COMPACTION_FILE = "tg-map.compaction.json";
const TG_CALLBACK_FILE = "tg-callback.jsonl";
const TG_MAP_MIGRATION_FILE = "tg-map.migration.json";
const TG_MAP_LOCK_FILE = "tg-map.lock.json";
const TG_MAP_LOCK_LEASE_MS = 10_000;
const TG_MAP_LEGACY_RE = /^tg-map(?:\.(\d{6}))?\.jsonl$/;
const TG_MAP_GENERATION_RE = /^tg-map\.g(\d{8})\.(\d{6})\.jsonl$/;

interface TelegramMappingReceipt {
  readonly sent: true;
  readonly channelRef: string;
}
interface TelegramMappingRoot {
  readonly canonical_path: string;
  readonly dev: number;
  readonly ino: number;
}
interface TelegramMappingRoute {
  readonly projection_sha256: string;
  readonly channel: string;
  readonly target: string;
}
interface TelegramMappingDelivery {
  readonly payload_digest: string;
  readonly delivery_digest: string;
  readonly receipt: TelegramMappingReceipt;
}
interface TelegramMappingRecord {
  readonly escId: string;
  readonly messageId: number;
  readonly chatId: string;
  readonly root?: TelegramMappingRoot;
  readonly route?: TelegramMappingRoute;
  readonly delivery?: TelegramMappingDelivery;
  readonly proof?: string;
}

function telegramMappingProofPayload(record: TelegramMappingRecord): string {
  return JSON.stringify({
    escId: record.escId,
    messageId: record.messageId,
    chatId: record.chatId,
    root: record.root,
    route: record.route,
    delivery: record.delivery,
  });
}
function telegramMappingProof(record: TelegramMappingRecord, authority: CtoRuntimeProofAuthority): string | null {
  return signTelegramMappingProof(authority, telegramMappingProofPayload(record));
}
function telegramMappingProofMatches(record: TelegramMappingRecord, pinnedRoot: PinnedProjectRoot, route: TelegramMappingRoute, authority: CtoRuntimeProofAuthority): boolean {
  if (!record.root || record.root.canonical_path !== pinnedRoot.canonical_root || record.root.dev !== pinnedRoot.dev || record.root.ino !== pinnedRoot.ino
    || !record.route || record.route.projection_sha256 !== route.projection_sha256 || record.route.channel !== route.channel || record.route.target !== route.target
    || !record.delivery || record.delivery.receipt.sent !== true || record.delivery.receipt.channelRef !== `tg:${record.messageId}`
    || record.delivery.delivery_digest !== telegramDeliveryDigest(record.delivery.payload_digest, record.delivery.receipt)
    || typeof record.proof !== "string" || !/^[0-9a-f]{64}$/u.test(record.proof)) return false;
  return verifyTelegramMappingProof(authority, telegramMappingProofPayload(record), record.proof);
}
function telegramDeliveryDigest(payloadDigest: string, receipt: TelegramMappingReceipt): string {
  return createHash("sha256").update(JSON.stringify({ payload_digest: payloadDigest, receipt }), "utf8").digest("hex");
}
function legacyTelegramMappingPayloadDigest(tenant: string, chatId: string, escId: string, messageId: number): string {
  return createHash("sha256")
    .update("telegram-legacy-mapping-v1\u0000", "utf8")
    .update(JSON.stringify({ tenant, chatId, escId, messageId }), "utf8")
    .digest("hex");
}
function legacyTelegramMappingLine(record: TelegramMappingRecord): string {
  return JSON.stringify({ escId: record.escId, messageId: record.messageId, chatId: record.chatId });
}
function telegramMappingLine(record: TelegramMappingRecord): string {
  const value = record.root && record.route && record.delivery && record.proof
    ? record
    : { escId: record.escId, messageId: record.messageId, chatId: record.chatId };
  return `${JSON.stringify(value)}\n`;
}
function telegramMessageKey(chatId: string, messageId: number): string {
  return `telegram-message\u0000${chatId}\u0000${String(messageId)}`;
}
function telegramMappingPartition(runId: string, chatId: string): string {
  const key = createHash("sha256")
    .update("telegram-chat-mapping\u0000", "utf8")
    .update(chatId, "utf8")
    .digest("hex");
  return join(".work-state", "cto", runId, "telegram-callbacks", key);
}

interface TelegramMapMetadata {
  readonly schema: 2;
  readonly tenant: string;
  readonly chatId: string;
}

interface TelegramMapManifest {
  readonly schema: 1;
  readonly tenant: string;
  readonly chatId: string;
  readonly generation: number;
}
interface TelegramMapCompaction {
  readonly schema: 1;
  readonly tenant: string;
  readonly chatId: string;
  readonly owner: string;
  leaseExpiresAt: number;
  readonly previousGeneration: number | null;
  readonly targetGeneration: number;
  readonly expectedShards: number;
}

interface TelegramCallbackBinding {
  readonly token: string;
  readonly escId: string;
  readonly optionId: string;
  readonly chatId: string;
}
type TelegramCallbackRead = TelegramMapReadResult;
interface TelegramMigrationManifestEntry {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface TelegramMapLock {
  readonly owner: string;
  readonly tenant: string;
  readonly chatId: string;
  expiresAt: number;
}

interface TelegramMapSnapshot {
  readonly records: TelegramMappingRecord[];
  readonly shardNames: string[];
  readonly generation: number | null;
}
const TG_MAP_MAX_PAGES = 1_024;
const TG_MAP_MAX_ENTRIES = 65_536;
const TG_MAP_MAX_RECORDS = 262_144;
const TG_MAP_MAX_BYTES = 64 * 1024 * 1024;
const TG_MAP_MAX_WORK = 128 * 1024 * 1024;
const TG_MAP_MIGRATION_MAX_FILES = 1_024;
const TG_MAP_MIGRATION_MAX_FILENAME_BYTES = 128 * 1024;
const TG_MAP_MAX_SCAN_MS = 120_000;

interface TelegramMapBudget {
  readonly startedAt: number;
  pages: number;
  entries: number;
  records: number;
  bytes: number;
  work: number;
}

class TelegramMapBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramMapBudgetError";
  }
}

function newTelegramMapBudget(): TelegramMapBudget {
  return { startedAt: Date.now(), pages: 0, entries: 0, records: 0, bytes: 0, work: 0 };
}

function chargeTelegramMapBudget(
  budget: TelegramMapBudget,
  delta: Partial<Pick<TelegramMapBudget, "pages" | "entries" | "records" | "bytes" | "work">>,
): void {
  budget.pages += delta.pages ?? 0;
  budget.entries += delta.entries ?? 0;
  budget.records += delta.records ?? 0;
  budget.bytes += delta.bytes ?? 0;
  budget.work += delta.work ?? 0;
  if (
    budget.pages > TG_MAP_MAX_PAGES
    || budget.entries > TG_MAP_MAX_ENTRIES
    || budget.records > TG_MAP_MAX_RECORDS
    || budget.bytes > TG_MAP_MAX_BYTES
    || budget.work > TG_MAP_MAX_WORK
    || Date.now() - budget.startedAt > TG_MAP_MAX_SCAN_MS
  ) {
    throw new TelegramMapBudgetError("telegram: mapping scan budget exceeded");
  }
}
function writeCanonicalTelegramMappingRecords(
  queue: BoundedQueue,
  records: readonly TelegramMappingRecord[],
  maxEntryBytes: number,
  startIndex = 0,
  generation: number | null = null,
): number {
  let current = "";
  let index = startIndex;
  for (const record of records) {
    const line = telegramMappingLine(record);
    if (Buffer.byteLength(line, "utf8") > maxEntryBytes) throw new Error("telegram: mapping record exceeds the shard byte cap");
    if (current && Buffer.byteLength(`${current}${line}`, "utf8") > maxEntryBytes) {
      queue.writeExclusive(mappingShardName(generation, index), current);
      index += 1;
      current = "";
    }
    current += line;
  }
  if (current) {
    queue.writeExclusive(mappingShardName(generation, index), current);
    index += 1;
  }
  return index;
}

function callbackBindingLine(binding: TelegramCallbackBinding): string {
  return `${JSON.stringify(binding)}\n`;
}
function readTelegramCallbackBindings(
  queue: BoundedQueue,
  runId: string,
  chatId: string,
  maxEntryBytes: number,
  allowLegacy = false,
): { observed: TelegramCallbackRead; bindings: TelegramCallbackBinding[] } | null {
  if (!queue.exists(TG_CALLBACK_FILE)) return null;
  const observed = queue.read(TG_CALLBACK_FILE);
  const text = decodeTelegramUtf8(observed.bytes);
  if (Buffer.byteLength(text, "utf8") > maxEntryBytes || text.length === 0 || !text.endsWith("\n")) {
    throw new Error("telegram: callback mapping shard is oversized or incomplete");
  }
  const bindings: TelegramCallbackBinding[] = [];
  for (const line of text.slice(0, -1).split("\n")) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error("telegram: callback mapping contains invalid JSON", { cause: error });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("telegram: callback mapping entry is corrupt");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(",");
    const legacy = keys === "escId,optionId,token";
    const scoped = keys === "chatId,escId,optionId,token";
    if ((!legacy && !scoped) || (legacy && !allowLegacy)) {
      throw new Error("telegram: callback mapping entry is corrupt");
    }
    if (
      !isSafeEscalationId(record.escId)
      || !isSafeEscalationOptionId(record.optionId)
      || typeof record.token !== "string"
      || !TELEGRAM_CALLBACK_TOKEN_RE.test(record.token)
      || telegramCallbackToken(record.escId, record.optionId) !== record.token
      || record.escId.split("/")[0] !== runId
      || (scoped && (typeof record.chatId !== "string" || record.chatId !== chatId))
    ) {
      throw new Error("telegram: callback mapping identity is corrupt");
    }
    const entryChatId = scoped ? boundedTelegramIdentity(record.chatId, "chatId") : chatId;
    if (entryChatId !== chatId) throw new Error("telegram: callback mapping tenant/chat identity conflicts");
    bindings.push({
      escId: record.escId as string,
      optionId: record.optionId as string,
      token: record.token,
      chatId: entryChatId,
    });
  }
  return { observed, bindings };
}

function mappingShardName(generation: number | null, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 999_999) {
    throw new Error("telegram: mapping shard sequence exhausted");
  }
  const sequence = String(index).padStart(6, "0");
  return generation === null
    ? index === 0 ? TG_MAP_FILE : `tg-map.${sequence}.jsonl`
    : `tg-map.g${String(generation).padStart(8, "0")}.${sequence}.jsonl`;
}

function isRetryableMappingRace(error: unknown): boolean {
  return error instanceof BoundedQueueError
    && (error.code === "changed" || error.code === "not_found" || error.code === "exists");
}

function boundedTelegramIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`telegram: mapping ${label} is corrupt`);
  }
  return value;
}
interface TelegramMapReadResult {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly dev: number;
  readonly ino: number;
}

interface TelegramMapLockSnapshot {
  readonly lock: TelegramMapLock;
  readonly observed: TelegramMapReadResult;
}

function parseTelegramMapLock(value: unknown): TelegramMapLock {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("telegram: mapping lock is corrupt");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "chatId,expiresAt,owner,schema,tenant" || record.schema !== 1) {
    throw new Error("telegram: mapping lock is corrupt");
  }
  const tenant = boundedTelegramIdentity(record.tenant, "tenant");
  if (!isSafeRunId(tenant)) throw new Error("telegram: mapping lock tenant is unsafe");
  const chatId = boundedTelegramIdentity(record.chatId, "chatId");
  const owner = boundedTelegramIdentity(record.owner, "owner");
  if (!Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) <= 0) {
    throw new Error("telegram: mapping lock lease is corrupt");
  }
  return { owner, tenant, chatId, expiresAt: record.expiresAt as number };
}

function readTelegramMapLock(queue: BoundedQueue): TelegramMapLockSnapshot | null {
  if (!queue.exists(TG_MAP_LOCK_FILE)) return null;
  let observed: TelegramMapReadResult;
  try {
    observed = queue.read(TG_MAP_LOCK_FILE);
  } catch (error) {
    if (error instanceof BoundedQueueError && error.code === "not_found") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeTelegramUtf8(observed.bytes));
  } catch (error) {
    throw new Error("telegram: mapping lock is corrupt", { cause: error });
  }
  return { lock: parseTelegramMapLock(value), observed };
}

function waitForTelegramMapLock(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

function acquireTelegramMapLock(queue: BoundedQueue, runId: string, chatId: string): TelegramMapLock {
  const owner = randomUUID();
  for (let attempt = 0; attempt < TG_MAP_MAX_CAS_ATTEMPTS * 256; attempt += 1) {
    const current = readTelegramMapLock(queue);
    if (current) {
      // A live lock is authoritative for its exact tenant/chat. Expiry is
      // checked first so a crashed writer on the shared legacy root cannot
      // strand every other chat behind its stale identity.
      if (current.lock.expiresAt > Date.now()) {
        if (current.lock.tenant !== runId || current.lock.chatId !== chatId) {
          throw new Error(`telegram: mapping lock tenant/chat identity conflicts for "${runId}"`);
        }
        waitForTelegramMapLock();
        continue;
      }
      // Replace expired locks directly with a fresh owner token. The
      // observed dev/inode/digest fence ensures a concurrent writer wins
      // only one lease, even when the stale lock belongs to another chat.
      try {
        queue.replaceIfMatches(
          TG_MAP_LOCK_FILE,
          {
            dev: current.observed.dev,
            ino: current.observed.ino,
            sha256: createHash("sha256").update(current.observed.bytes).digest("hex"),
          },
          JSON.stringify({
            schema: 1,
            tenant: runId,
            chatId,
            owner,
            expiresAt: Date.now() + TG_MAP_LOCK_LEASE_MS,
          }),
        );
      } catch (error) {
        if (isRetryableMappingRace(error)) continue;
        throw error;
      }
      const won = readTelegramMapLock(queue);
      if (won?.lock.owner === owner && won.lock.tenant === runId && won.lock.chatId === chatId) {
        return won.lock;
      }
      // Another writer replaced the stale lease. Re-read it so live
      // tenant/chat conflicts are rejected while another expired lease can
      // be fenced in the next iteration.
      continue;
    }
    try {
      queue.writeExclusive(TG_MAP_LOCK_FILE, JSON.stringify({
        schema: 1,
        tenant: runId,
        chatId,
        owner,
        expiresAt: Date.now() + TG_MAP_LOCK_LEASE_MS,
      }));
    } catch (error) {
      if (isRetryableMappingRace(error)) continue;
      throw error;
    }
    const won = readTelegramMapLock(queue);
    if (won?.lock.owner === owner && won.lock.tenant === runId && won.lock.chatId === chatId) return won.lock;
    // A concurrent writer may have installed a live lock for another
    // tenant/chat; process it through the expiry/identity checks above.
  }
  throw new Error(`telegram: mapping lock for "${runId}" is busy`);
}

function refreshTelegramMapLock(queue: BoundedQueue, lock: TelegramMapLock): void {
  const current = readTelegramMapLock(queue);
  if (!current || current.lock.owner !== lock.owner || current.lock.tenant !== lock.tenant || current.lock.chatId !== lock.chatId || current.lock.expiresAt <= Date.now()) {
    throw new Error("telegram: mapping lock fencing check failed");
  }
  const expiresAt = Date.now() + TG_MAP_LOCK_LEASE_MS;
  queue.replaceIfMatches(
    TG_MAP_LOCK_FILE,
    {
      dev: current.observed.dev,
      ino: current.observed.ino,
      sha256: createHash("sha256").update(current.observed.bytes).digest("hex"),
    },
    JSON.stringify({ schema: 1, tenant: lock.tenant, chatId: lock.chatId, owner: lock.owner, expiresAt }),
  );
  lock.expiresAt = expiresAt;
}

function releaseTelegramMapLock(queue: BoundedQueue, lock: TelegramMapLock): void {
  try {
    const current = readTelegramMapLock(queue);
    if (!current || current.lock.owner !== lock.owner || current.lock.tenant !== lock.tenant || current.lock.chatId !== lock.chatId) return;
    queue.removeIfMatches(TG_MAP_LOCK_FILE, {
      dev: current.observed.dev,
      ino: current.observed.ino,
      sha256: createHash("sha256").update(current.observed.bytes).digest("hex"),
    });
  } catch (error) {
    if (!isRetryableMappingRace(error)) throw error;
  }
}

function readTelegramMapMetadata(queue: BoundedQueue, budget?: TelegramMapBudget): TelegramMapMetadata | null {
  if (!queue.exists(TG_MAP_META_FILE)) return null;
  const observed = queue.read(TG_MAP_META_FILE);
  const text = decodeTelegramUtf8(observed.bytes);
  if (budget) chargeTelegramMapBudget(budget, {
    bytes: Buffer.byteLength(text, "utf8"),
    work: Buffer.byteLength(text, "utf8"),
  });
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object") throw new Error("telegram: mapping metadata is corrupt");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "chatId,schema,tenant" || record.schema !== 2) {
    throw new Error("telegram: mapping metadata is corrupt");
  }
  const tenant = boundedTelegramIdentity(record.tenant, "tenant");
  if (!isSafeRunId(tenant)) throw new Error("telegram: mapping metadata tenant is unsafe");
  const chatId = boundedTelegramIdentity(record.chatId, "chatId");
  return { schema: 2, tenant, chatId };
}
function ensureTelegramMapMetadata(queue: BoundedQueue, runId: string, chatId: string): void {
  const existing = readTelegramMapMetadata(queue);
  if (existing) {
    if (existing.tenant !== runId || existing.chatId !== chatId) {
      throw new Error(`telegram: mapping tenant/chat identity conflicts for "${runId}"`);
    }
    return;
  }
  const names = listTelegramMapFiles(queue);
  if (names.some((name) => isTelegramMapStateFile(name))) {
    throw new Error(`telegram: mapping for "${runId}" requires explicit migration`);
  }
  const serialized = JSON.stringify({ schema: 2, tenant: runId, chatId });
  try {
    queue.writeExclusive(TG_MAP_META_FILE, serialized);
  } catch (error) {
    if (!isRetryableMappingRace(error)) throw error;
    const raced = readTelegramMapMetadata(queue);
    if (!raced || raced.tenant !== runId || raced.chatId !== chatId) {
      throw new Error(`telegram: mapping tenant/chat identity conflicts for "${runId}"`);
    }
  }
}

function readTelegramMapManifest(
  queue: BoundedQueue,
  runId: string,
  chatId: string,
  budget?: TelegramMapBudget,
): TelegramMapManifest | null {
  if (!queue.exists(TG_MAP_MANIFEST_FILE)) return null;
  const observed = queue.read(TG_MAP_MANIFEST_FILE);
  const text = decodeTelegramUtf8(observed.bytes);
  if (budget) chargeTelegramMapBudget(budget, {
    bytes: Buffer.byteLength(text, "utf8"),
    work: Buffer.byteLength(text, "utf8"),
  });
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object") throw new Error("telegram: mapping manifest is corrupt");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "chatId,generation,schema,tenant" || record.schema !== 1) {
    throw new Error("telegram: mapping manifest is corrupt");
  }
  const tenant = boundedTelegramIdentity(record.tenant, "tenant");
  const manifestChatId = boundedTelegramIdentity(record.chatId, "chatId");
  if (!isSafeRunId(tenant) || tenant !== runId || manifestChatId !== chatId) {
    throw new Error("telegram: mapping manifest tenant/chat identity conflicts");
  }
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1 || (record.generation as number) > 99_999_999) {
    throw new Error("telegram: mapping manifest generation is corrupt");
  }
  return { schema: 1, tenant, chatId: manifestChatId, generation: record.generation as number };
}

function readTelegramMapCompaction(
  queue: BoundedQueue,
  runId: string,
  chatId: string,
  budget?: TelegramMapBudget,
): TelegramMapCompaction | null {
  if (!queue.exists(TG_MAP_COMPACTION_FILE)) return null;
  const observed = queue.read(TG_MAP_COMPACTION_FILE);
  const text = decodeTelegramUtf8(observed.bytes);
  if (budget) chargeTelegramMapBudget(budget, {
    bytes: Buffer.byteLength(text, "utf8"),
    work: Buffer.byteLength(text, "utf8"),
  });
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object") throw new Error("telegram: mapping compaction marker is corrupt");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "chatId,expectedShards,leaseExpiresAt,owner,previousGeneration,schema,targetGeneration,tenant" || record.schema !== 1) {
    throw new Error("telegram: mapping compaction marker is corrupt");
  }
  const tenant = boundedTelegramIdentity(record.tenant, "tenant");
  const markerChatId = boundedTelegramIdentity(record.chatId, "chatId");
  const owner = boundedTelegramIdentity(record.owner, "owner");
  if (!isSafeRunId(tenant) || tenant !== runId || markerChatId !== chatId) {
    throw new Error("telegram: mapping compaction tenant/chat identity conflicts");
  }
  if (
    !Number.isSafeInteger(record.targetGeneration)
    || (record.targetGeneration as number) < 1
    || (record.targetGeneration as number) > 99_999_999
    || (record.previousGeneration !== null && (!Number.isSafeInteger(record.previousGeneration) || (record.previousGeneration as number) < 1))
    || !Number.isSafeInteger(record.expectedShards)
    || (record.expectedShards as number) < 1
    || !Number.isSafeInteger(record.leaseExpiresAt)
    || (record.leaseExpiresAt as number) <= 0
  ) {
    throw new Error("telegram: mapping compaction marker is corrupt");
  }
  return {
    schema: 1,
    tenant,
    chatId: markerChatId,
    owner,
    leaseExpiresAt: record.leaseExpiresAt as number,
    previousGeneration: record.previousGeneration as number | null,
    targetGeneration: record.targetGeneration as number,
    expectedShards: record.expectedShards as number,
  };
}

function readTelegramQueuePage(queue: BoundedQueue, cursor: string | null, budget: TelegramMapBudget): {
  entries: Array<{ name: string; relativePath: string }>;
  nextCursor: string | null;
} {
  chargeTelegramMapBudget(budget, { pages: 1 });
  const page = queue.listPage(cursor);
  let work = 0;
  for (const entry of page.entries) work += Buffer.byteLength(entry.name, "utf8") + Buffer.byteLength(entry.relativePath, "utf8");
  chargeTelegramMapBudget(budget, { entries: page.entries.length, bytes: work, work });
  if (page.nextCursor !== null && (page.entries.length === 0 || (cursor !== null && page.nextCursor <= cursor))) {
    throw new TelegramMapBudgetError("telegram: mapping pagination cursor made no progress");
  }
  return page;
}

function listTelegramMapFiles(queue: BoundedQueue, budget = newTelegramMapBudget()): string[] {
  const names: string[] = [];
  let cursor: string | null = null;
  while (true) {
    const page = readTelegramQueuePage(queue, cursor, budget);
    names.push(...page.entries.map((entry) => entry.name));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return names;
}
function isTelegramMapStateFile(name: string): boolean {
  return TG_MAP_LEGACY_RE.test(name)
    || TG_MAP_GENERATION_RE.test(name)
    || name === TG_MAP_MANIFEST_FILE
    || name === TG_MAP_COMPACTION_FILE
    || name === TG_CALLBACK_FILE
    || name === TG_MAP_META_FILE
    || name === TG_MAP_MIGRATION_FILE;
}

function parseTelegramMappingLine(
  rawLine: string,
  runId: string,
  chatId: string,
  requireTenant: boolean,
  allowLegacy = false,
): TelegramMappingRecord {
  let value: unknown;
  try {
    value = JSON.parse(rawLine);
  } catch (error) {
    throw new Error("telegram: mapping shard contains invalid JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("telegram: mapping shard entry is corrupt");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const legacy = keys.join(",") === "escId,messageId";
  const scoped = keys.join(",") === "chatId,escId,messageId";
  const proven = keys.join(",") === "chatId,delivery,escId,messageId,proof,root,route";
  if ((!legacy && !scoped && !proven) || (legacy && !allowLegacy)) throw new Error("telegram: mapping shard entry is corrupt");
  const entryChatId = scoped || proven ? boundedTelegramIdentity(record.chatId, "chatId") : chatId;
  if (entryChatId !== chatId) throw new Error("telegram: mapping shard tenant/chat identity conflicts");
  const escId = record.escId;
  if (!isSafeEscalationId(escId) || (requireTenant && escId.split("/")[0] !== runId)) {
    throw new Error("telegram: mapping shard escalation identity is corrupt");
  }
  if (!Number.isSafeInteger(record.messageId) || (record.messageId as number) <= 0) {
    throw new Error("telegram: mapping shard message identity is corrupt");
  }
  if (!proven) return { escId, messageId: record.messageId as number, chatId: entryChatId };
  const root = record.root;
  if (!root || typeof root !== "object" || Array.isArray(root) || Object.keys(root as object).sort().join(",") !== "canonical_path,dev,ino") {
    throw new Error("telegram: mapping shard root proof is corrupt");
  }
  const rootRecord = root as Record<string, unknown>;
  if (typeof rootRecord.canonical_path !== "string" || rootRecord.canonical_path.length === 0 || Buffer.byteLength(rootRecord.canonical_path, "utf8") > 4096
    || !Number.isSafeInteger(rootRecord.dev) || (rootRecord.dev as number) < 0
    || !Number.isSafeInteger(rootRecord.ino) || (rootRecord.ino as number) < 0) throw new Error("telegram: mapping shard root proof is corrupt");
  const route = record.route;
  if (!route || typeof route !== "object" || Array.isArray(route) || Object.keys(route as object).sort().join(",") !== "channel,projection_sha256,target") {
    throw new Error("telegram: mapping shard route proof is corrupt");
  }
  const routeRecord = route as Record<string, unknown>;
  if (typeof routeRecord.projection_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(routeRecord.projection_sha256)
    || typeof routeRecord.channel !== "string" || typeof routeRecord.target !== "string") throw new Error("telegram: mapping shard route proof is corrupt");
  boundedTelegramIdentity(routeRecord.channel, "channel");
  boundedTelegramIdentity(routeRecord.target, "target");
  const delivery = record.delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery) || Object.keys(delivery as object).sort().join(",") !== "delivery_digest,payload_digest,receipt") {
    throw new Error("telegram: mapping shard delivery proof is corrupt");
  }
  const deliveryRecord = delivery as Record<string, unknown>;
  if (typeof deliveryRecord.payload_digest !== "string" || !/^[0-9a-f]{64}$/u.test(deliveryRecord.payload_digest)
    || typeof deliveryRecord.delivery_digest !== "string" || !/^[0-9a-f]{64}$/u.test(deliveryRecord.delivery_digest)) throw new Error("telegram: mapping shard delivery proof is corrupt");
  const receipt = deliveryRecord.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || Object.keys(receipt as object).sort().join(",") !== "channelRef,sent") {
    throw new Error("telegram: mapping shard receipt proof is corrupt");
  }
  const receiptRecord = receipt as Record<string, unknown>;
  if (receiptRecord.sent !== true || receiptRecord.channelRef !== `tg:${record.messageId}`) throw new Error("telegram: mapping shard receipt proof is corrupt");
  if (deliveryRecord.delivery_digest !== telegramDeliveryDigest(deliveryRecord.payload_digest as string, { sent: true, channelRef: receiptRecord.channelRef as string })) {
    throw new Error("telegram: mapping shard delivery proof is corrupt");
  }
  if (typeof record.proof !== "string" || !/^[0-9a-f]{64}$/u.test(record.proof)) throw new Error("telegram: mapping shard proof is corrupt");
  return {
    escId,
    messageId: record.messageId as number,
    chatId: entryChatId,
    root: { canonical_path: rootRecord.canonical_path, dev: rootRecord.dev as number, ino: rootRecord.ino as number },
    route: { projection_sha256: routeRecord.projection_sha256, channel: routeRecord.channel, target: routeRecord.target },
    delivery: {
      payload_digest: deliveryRecord.payload_digest,
      delivery_digest: deliveryRecord.delivery_digest,
      receipt: { sent: true, channelRef: receiptRecord.channelRef },
    },
    proof: record.proof,
  };
}

function telegramMigrationManifest(
  queue: BoundedQueue,
  names: readonly string[],
  budget: TelegramMapBudget,
): { entries: TelegramMigrationManifestEntry[]; digest: string; totalBytes: number } {
  const ordered = [...names].sort();
  if (ordered.length > TG_MAP_MIGRATION_MAX_FILES) throw new Error("telegram: legacy mapping contains too many state files");
  const filenameBytes = ordered.reduce((total, name) => total + Buffer.byteLength(name, "utf8"), 0);
  if (filenameBytes > TG_MAP_MIGRATION_MAX_FILENAME_BYTES) throw new Error("telegram: legacy mapping filenames exceed the migration cap");
  const digest = createHash("sha256");
  const entries: TelegramMigrationManifestEntry[] = [];
  let totalBytes = 0;
  for (const name of ordered) {
    const observed = queue.read(name);
    const bytes = observed.bytes.byteLength;
    totalBytes += bytes;
    chargeTelegramMapBudget(budget, { entries: 1, bytes, work: bytes + Buffer.byteLength(name, "utf8") });
    const sha256 = createHash("sha256").update(observed.bytes).digest("hex");
    digest.update(name, "utf8");
    digest.update("\u0000", "utf8");
    digest.update(observed.bytes);
    entries.push({ name, sha256, bytes });
  }
  return { entries, digest: digest.digest("hex"), totalBytes };
}

function readTelegramMigrationMarker(
  queue: BoundedQueue,
  runId: string,
  chatId: string,
): { sourceDigest: string; destinationDigest: string; generation: number | null; sourceManifest: TelegramMigrationManifestEntry[] } | null {
  if (!queue.exists(TG_MAP_MIGRATION_FILE)) return null;
  const text = decodeTelegramUtf8(queue.read(TG_MAP_MIGRATION_FILE).bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("telegram: mapping migration marker is corrupt", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("telegram: mapping migration marker is corrupt");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "chatId,destinationDigest,generation,schema,sourceDigest,sourceManifest,tenant" || record.schema !== 1) {
    throw new Error("telegram: mapping migration marker is corrupt");
  }
  const markerTenant = boundedTelegramIdentity(record.tenant, "tenant");
  const markerChatId = boundedTelegramIdentity(record.chatId, "chatId");
  const sourceDigest = boundedTelegramIdentity(record.sourceDigest, "sourceDigest");
  const destinationDigest = boundedTelegramIdentity(record.destinationDigest, "destinationDigest");
  if (!isSafeRunId(markerTenant) || markerTenant !== runId || markerChatId !== chatId
    || !/^[0-9a-f]{64}$/u.test(sourceDigest) || !/^[0-9a-f]{64}$/u.test(destinationDigest)) {
    throw new Error("telegram: mapping migration marker identity is corrupt");
  }
  if (record.generation !== null && (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1)) {
    throw new Error("telegram: mapping migration marker generation is corrupt");
  }
  if (!Array.isArray(record.sourceManifest) || record.sourceManifest.length > TG_MAP_MIGRATION_MAX_FILES) {
    throw new Error("telegram: mapping migration manifest is corrupt");
  }
  const sourceManifest: TelegramMigrationManifestEntry[] = [];
  let manifestBytes = 0;
  let manifestContentBytes = 0;
  let previousName = "";
  for (const item of record.sourceManifest) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("telegram: mapping migration manifest is corrupt");
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== "bytes,name,sha256"
      || typeof entry.name !== "string"
      || !/^[0-9a-f]{64}$/u.test(String(entry.sha256))
      || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0) {
      throw new Error("telegram: mapping migration manifest is corrupt");
    }
    const name = boundedTelegramIdentity(entry.name, "manifest name");
    if (name <= previousName) throw new Error("telegram: mapping migration manifest is not ordered");
    previousName = name;
    manifestBytes += Buffer.byteLength(name, "utf8");
    if (manifestBytes > TG_MAP_MIGRATION_MAX_FILENAME_BYTES) throw new Error("telegram: mapping migration manifest is oversized");
    manifestContentBytes += entry.bytes as number;
    if (manifestContentBytes > TG_MAP_MAX_BYTES) throw new Error("telegram: mapping migration manifest content is oversized");
    sourceManifest.push({ name, sha256: entry.sha256 as string, bytes: entry.bytes as number });
  }
  return { sourceDigest, destinationDigest, generation: record.generation as number | null, sourceManifest };
}
function readTelegramMappingShard(
  queue: BoundedQueue,
  name: string,
  runId: string,
  chatId: string,
  requireTenant: boolean,
  budget?: TelegramMapBudget,
  allowLegacy = false,
): TelegramMappingRecord[] {
  const observed = queue.read(name);
  const text = decodeTelegramUtf8(observed.bytes);
  const bytes = Buffer.byteLength(text, "utf8");
  if (budget) chargeTelegramMapBudget(budget, { bytes, work: bytes });
  if (text.length === 0 || !text.endsWith("\n")) throw new Error(`telegram: mapping shard "${name}" has an incomplete write boundary`);
  const lines = text.slice(0, -1).split("\n");
  const records: TelegramMappingRecord[] = [];
  for (const line of lines) {
    if (budget) chargeTelegramMapBudget(budget, { records: 1, work: Buffer.byteLength(line, "utf8") });
    if (line.length === 0) throw new Error(`telegram: mapping shard "${name}" contains an empty record`);
    records.push(parseTelegramMappingLine(line, runId, chatId, requireTenant, allowLegacy));
  }
  return records;
}

function addTelegramMapping(
  records: TelegramMappingRecord[],
  byEscId: Map<string, number>,
  byMessageKey: Map<string, string>,
  entry: TelegramMappingRecord,
): void {
  const previousMessageId = byEscId.get(entry.escId);
  if (previousMessageId !== undefined && previousMessageId !== entry.messageId) {
    throw new Error(`telegram: mapping for "${entry.escId}" conflicts with message ${String(previousMessageId)}`);
  }
  const messageKey = telegramMessageKey(entry.chatId, entry.messageId);
  const previousEscId = byMessageKey.get(messageKey);
  if (previousEscId !== undefined && previousEscId !== entry.escId) {
    throw new Error(`telegram: message ${entry.messageId} is already mapped to "${previousEscId}"`);
  }
  if (previousMessageId === undefined && previousEscId === undefined) {
    byEscId.set(entry.escId, entry.messageId);
    byMessageKey.set(messageKey, entry.escId);
    records.push(entry);
  }
}

function telegramMapSequence(name: string, generation: number | null): number | null {
  if (generation === null) {
    if (name === TG_MAP_FILE) return 0;
    const match = /^tg-map\.(\d{6})\.jsonl$/.exec(name);
    return match ? Number(match[1]) : null;
  }
  const match = TG_MAP_GENERATION_RE.exec(name);
  if (!match || Number(match[1]) !== generation) return null;
  return Number(match[2]);
}
function readTelegramMapSnapshot(
  queue: BoundedQueue,
  runId: string,
  chatId: string,
  suppliedBudget?: TelegramMapBudget,
  allowLegacy = false,
): TelegramMapSnapshot {
  const budget = suppliedBudget ?? newTelegramMapBudget();
  const manifest = readTelegramMapManifest(queue, runId, chatId, budget);
  const metadata = readTelegramMapMetadata(queue, budget);
  if (metadata && (metadata.tenant !== runId || metadata.chatId !== chatId)) {
    throw new Error("telegram: mapping tenant/chat identity conflicts");
  }
  const generation = manifest?.generation ?? null;
  const names = listTelegramMapFiles(queue, budget)
    .filter((name) => generation === null
      ? TG_MAP_LEGACY_RE.test(name)
      : TG_MAP_GENERATION_RE.test(name) && telegramMapSequence(name, generation) !== null)
    .sort((left, right) => (telegramMapSequence(left, generation) ?? 0) - (telegramMapSequence(right, generation) ?? 0));
  if (!metadata && names.length > 0 && !allowLegacy) throw new Error("telegram: mapping requires explicit migration");
  const requireTenant = metadata !== null || manifest !== null;
  const records: TelegramMappingRecord[] = [];
  const byEscId = new Map<string, number>();
  const byMessageKey = new Map<string, string>();
  for (let index = 0; index < names.length; index += 1) {
    const sequence = telegramMapSequence(names[index]!, generation);
    if (sequence !== index) throw new Error("telegram: mapping shard sequence is corrupt");
    for (const entry of readTelegramMappingShard(queue, names[index]!, runId, chatId, requireTenant, budget, allowLegacy)) {
      addTelegramMapping(records, byEscId, byMessageKey, entry);
    }
  }
  return { records, shardNames: names, generation };
}

function removeTelegramMapFile(queue: BoundedQueue, name: string, suppliedObserved?: TelegramMapReadResult): void {
  try {
    const observed = suppliedObserved ?? queue.read(name);
    queue.removeIfMatches(name, {
      dev: observed.dev,
      ino: observed.ino,
      sha256: createHash("sha256").update(observed.bytes).digest("hex"),
    });
  } catch (error) {
    if (error instanceof BoundedQueueError && error.code === "not_found") return;
    throw error;
  }
}
function cleanupTelegramMapFiles(
  queue: BoundedQueue,
  keepGeneration: number,
  lock: TelegramMapLock,
  budget?: TelegramMapBudget,
): void {
  for (const name of listTelegramMapFiles(queue, budget)) {
    if (telegramMapSequence(name, keepGeneration) !== null) continue;
    if (TG_MAP_LEGACY_RE.test(name) || TG_MAP_GENERATION_RE.test(name)) {
      refreshTelegramMapLock(queue, lock);
      removeTelegramMapFile(queue, name);
    }
  }
}

function recoverTelegramMap(
  queue: BoundedQueue,
  runId: string,
  chatId: string,
  lock: TelegramMapLock,
  suppliedBudget?: TelegramMapBudget,
): void {
  const budget = suppliedBudget ?? newTelegramMapBudget();
  refreshTelegramMapLock(queue, lock);
  const metadata = readTelegramMapMetadata(queue, budget);
  const marker = readTelegramMapCompaction(queue, runId, chatId, budget);
  if (!metadata) {
    if (marker || listTelegramMapFiles(queue, budget).some((name) => isTelegramMapStateFile(name))) {
      throw new Error(`telegram: mapping for "${runId}" requires explicit migration`);
    }
    return;
  }
  if (metadata.tenant !== runId || metadata.chatId !== chatId) {
    throw new Error("telegram: mapping tenant/chat identity conflicts");
  }
  if (!marker) return;
  if (marker.owner !== lock.owner && marker.leaseExpiresAt > Date.now()) {
    throw new Error("telegram: mapping compaction is owned by a live fenced writer");
  }
  const manifest = readTelegramMapManifest(queue, runId, chatId, budget);
  if (manifest?.generation === marker.targetGeneration) {
    cleanupTelegramMapFiles(queue, marker.targetGeneration, lock, budget);
    refreshTelegramMapLock(queue, lock);
    removeTelegramMapFile(queue, TG_MAP_COMPACTION_FILE);
    return;
  }
  const targetNames = listTelegramMapFiles(queue, budget)
    .filter((name) => telegramMapSequence(name, marker.targetGeneration) !== null)
    .sort();
  if (targetNames.length !== marker.expectedShards) {
    for (const name of targetNames) {
      refreshTelegramMapLock(queue, lock);
      removeTelegramMapFile(queue, name);
    }
    refreshTelegramMapLock(queue, lock);
    removeTelegramMapFile(queue, TG_MAP_COMPACTION_FILE);
    return;
  }
  try {
    const records: TelegramMappingRecord[] = [];
    const byEscId = new Map<string, number>();
    const byMessageKey = new Map<string, string>();
    for (let index = 0; index < targetNames.length; index += 1) {
      if (telegramMapSequence(targetNames[index]!, marker.targetGeneration) !== index) throw new Error("telegram: mapping compaction shard sequence is corrupt");
      for (const entry of readTelegramMappingShard(queue, targetNames[index]!, runId, chatId, true, budget)) {
        addTelegramMapping(records, byEscId, byMessageKey, entry);
      }
    }
  } catch (error) {
    if (error instanceof TelegramMapBudgetError) throw error;
    // Target generation is not visible until the manifest commit. Discard
    // malformed/incomplete temporary shards and retain the previous source.
    for (const name of targetNames) {
      refreshTelegramMapLock(queue, lock);
      removeTelegramMapFile(queue, name);
    }
    refreshTelegramMapLock(queue, lock);
    removeTelegramMapFile(queue, TG_MAP_COMPACTION_FILE);
    return;
  }
  refreshTelegramMapLock(queue, lock);
  queue.writeAtomic(TG_MAP_MANIFEST_FILE, JSON.stringify({
    schema: 1,
    tenant: runId,
    chatId,
    generation: marker.targetGeneration,
  }));
  cleanupTelegramMapFiles(queue, marker.targetGeneration, lock);
  refreshTelegramMapLock(queue, lock);
}

function nextMappingShardNumber(names: string[], generation: number | null): number {
  let highest = -1;
  for (const name of names) {
    const sequence = telegramMapSequence(name, generation);
    if (sequence !== null && sequence > highest) highest = sequence;
  }
  return highest + 1;
}

function maybeCompactTelegramMap(
  queue: BoundedQueue,
  runId: string,
  chatId: string,
  snapshot: TelegramMapSnapshot,
  maxEntryBytes: number,
  lock: TelegramMapLock,
  force = false,
  suppliedBudget?: TelegramMapBudget,
): void {
  const budget = suppliedBudget ?? newTelegramMapBudget();
  const shouldCompact = force || (snapshot.generation === null
    ? snapshot.shardNames.length >= TG_MAP_COMPACT_LEGACY_SHARD_THRESHOLD
    : snapshot.shardNames.length >= TG_MAP_COMPACT_GENERATION_SHARD_THRESHOLD);
  if (!shouldCompact) return;
  const marker = readTelegramMapCompaction(queue, runId, chatId, budget);
  if (marker) {
    recoverTelegramMap(queue, runId, chatId, lock, budget);
    return;
  }
  const targetGeneration = snapshot.generation === null ? 1 : snapshot.generation + 1;
  if (targetGeneration > 99_999_999) throw new Error("telegram: mapping compaction generation exhausted");
  const lines: string[] = [];
  let current = "";
  for (const entry of snapshot.records) {
    const line = telegramMappingLine(entry);
    if (Buffer.byteLength(line, "utf8") > maxEntryBytes) throw new Error("telegram: mapping record exceeds the shard byte cap");
    if (current && Buffer.byteLength(`${current}${line}`, "utf8") > maxEntryBytes) {
      lines.push(current);
      current = "";
    }
    current += line;
  }
  if (current) lines.push(current);
  if (lines.length === 0) return;
  const markerValue: TelegramMapCompaction = {
    schema: 1,
    tenant: runId,
    chatId,
    owner: lock.owner,
    leaseExpiresAt: lock.expiresAt,
    previousGeneration: snapshot.generation,
    targetGeneration,
    expectedShards: lines.length,
  };
  try {
    refreshTelegramMapLock(queue, lock);
    markerValue.leaseExpiresAt = lock.expiresAt;
    queue.writeExclusive(TG_MAP_COMPACTION_FILE, JSON.stringify(markerValue));
  } catch (error) {
    if (!isRetryableMappingRace(error)) throw error;
    recoverTelegramMap(queue, runId, chatId, lock, budget);
    return;
  }
  try {
    for (let index = 0; index < lines.length; index += 1) {
      refreshTelegramMapLock(queue, lock);
      queue.writeExclusive(mappingShardName(targetGeneration, index), lines[index]!);
    }
    refreshTelegramMapLock(queue, lock);
    queue.writeAtomic(TG_MAP_MANIFEST_FILE, JSON.stringify({
      schema: 1,
      tenant: runId,
      chatId,
      generation: targetGeneration,
    }));
    cleanupTelegramMapFiles(queue, targetGeneration, lock, budget);
    refreshTelegramMapLock(queue, lock);
    removeTelegramMapFile(queue, TG_MAP_COMPACTION_FILE);
  } catch (error) {
    // Leave the marker for the next operation to recover. A remote send that
    // reaches this path is already protected by delivered_unmapped journaling.
    throw new Error("telegram: mapping compaction did not commit", { cause: error });
  }
}

/** Non-429 Telegram 4xx responses are definitive bridge configuration/auth failures. */
export function isTelegramPermanentError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false;
  const code = error.httpStatus ?? error.apiErrorCode;
  return code !== undefined && code >= 400 && code < 500 && code !== 429;
}

class TelegramApiError extends Error {
  readonly httpStatus?: number;
  readonly apiErrorCode?: number;
  readonly retryAfter?: number;

  constructor(
    message: string,
    readonly definitiveUnsent: boolean,
    cause?: unknown,
    details: { httpStatus?: number; apiErrorCode?: number; retryAfter?: number } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TelegramApiError";
    this.httpStatus = details.httpStatus;
    this.apiErrorCode = details.apiErrorCode;
    this.retryAfter = details.retryAfter;
  }
}

export class TelegramAnswerConflictError extends Error {
  readonly code = "TELEGRAM_ANSWER_CONFLICT" as const;
  constructor(identity: string) {
    super(`telegram answer for ${identity} conflicts with the durable first value`);
    this.name = "TelegramAnswerConflictError";
  }
}

export class DeliveryEffectAmbiguousError extends Error {
  readonly code = "DELIVERY_EFFECT_AMBIGUOUS" as const;
  constructor(identity: string) {
    super("telegram delivery effect for " + identity + " is not durably complete; manual recovery is required");
    this.name = "DeliveryEffectAmbiguousError";
  }
}

type DeliveryEffectRecord =
  | { schema: 1; status: "prepared"; key: string; escalation_id: string; payload_digest: string; at: string }
  | { schema: 1; status: "failed"; key: string; escalation_id: string; payload_digest: string; receipt: EscalationReceipt; at: string }
  | { schema: 1; status: "delivered_unmapped"; key: string; escalation_id: string; payload_digest: string; message_id: number; receipt: EscalationReceipt; at: string }
  | { schema: 1; status: "delivered"; key: string; escalation_id: string; payload_digest: string; receipt: EscalationReceipt; at: string };
function serializeDeliveryEffectRecord(record: DeliveryEffectRecord, maxEntryBytes: number): string {
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, "utf8") > maxEntryBytes) {
    throw new DeliveryEffectAmbiguousError(record.key);
  }
  return serialized;
}

function deliveryPayloadDigest(esc: Escalation): string {
  return createHash("sha256").update(JSON.stringify(esc), "utf8").digest("hex");
}
function markDeliveryEffectUnmapped(
  cwd: string,
  esc: Escalation,
  key: string,
  name: string,
  payloadDigest: string,
  messageId: number,
  receipt: EscalationReceipt,
  pinnedRoot: PinnedProjectRoot,
): void {
  if (!pinnedRoot.isStable()) throw new DeliveryEffectAmbiguousError(key);
  const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", runIdOf(esc), "delivery-effects"), { pinnedRoot });
  if (!queue) throw new DeliveryEffectAmbiguousError(key);
  try {
    const observed = queue.read(name);
    const current = JSON.parse(decodeTelegramUtf8(observed.bytes)) as unknown;
    if (
      !isDeliveryEffectRecord(current)
      || current.status !== "prepared"
      || current.key !== key
      || current.escalation_id !== esc.id
      || current.payload_digest !== payloadDigest
    ) {
      throw new DeliveryEffectAmbiguousError(key);
    }
    if (!pinnedRoot.isStable()) throw new DeliveryEffectAmbiguousError(key);
    queue.replaceIfMatches(
      name,
      { dev: observed.dev, ino: observed.ino, sha256: createHash("sha256").update(observed.bytes).digest("hex") },
      serializeDeliveryEffectRecord(
        { schema: 1, status: "delivered_unmapped", key, escalation_id: esc.id, payload_digest: payloadDigest, message_id: messageId, receipt, at: new Date().toISOString() },
        queue.maxEntryBytes,
      ),
    );
  } catch (error) {
    if (error instanceof DeliveryEffectAmbiguousError) throw error;
    throw new DeliveryEffectAmbiguousError(key);
  } finally {
    queue.close();
  }
}

function promoteDeliveryEffectDelivered(
  cwd: string,
  esc: Escalation,
  key: string,
  name: string,
  payloadDigest: string,
  receipt: EscalationReceipt,
  pinnedRoot: PinnedProjectRoot,
): void {
  if (!pinnedRoot.isStable()) throw new DeliveryEffectAmbiguousError(key);
  const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", runIdOf(esc), "delivery-effects"), { pinnedRoot });
  if (!queue) throw new DeliveryEffectAmbiguousError(key);
  try {
    const observed = queue.read(name);
    const current = JSON.parse(decodeTelegramUtf8(observed.bytes)) as unknown;
    if (
      !isDeliveryEffectRecord(current)
      || current.status !== "delivered_unmapped"
      || current.key !== key
      || current.escalation_id !== esc.id
      || current.payload_digest !== payloadDigest
      || current.receipt.sent !== true
      || current.receipt.channelRef !== receipt.channelRef
    ) {
      throw new DeliveryEffectAmbiguousError(key);
    }
    if (!pinnedRoot.isStable()) throw new DeliveryEffectAmbiguousError(key);
    queue.replaceIfMatches(
      name,
      { dev: observed.dev, ino: observed.ino, sha256: createHash("sha256").update(observed.bytes).digest("hex") },
      serializeDeliveryEffectRecord(
        { schema: 1, status: "delivered", key, escalation_id: esc.id, payload_digest: payloadDigest, receipt, at: new Date().toISOString() },
        queue.maxEntryBytes,
      ),
    );
  } catch (error) {
    if (error instanceof DeliveryEffectAmbiguousError) throw error;
    throw new DeliveryEffectAmbiguousError(key);
  } finally {
    queue.close();
  }
}


/**
 * A false send result is a definitive pre-delivery failure. Retain that
 * result in a payload-bound marker so a later retry can claim it atomically,
 * while a concurrent caller still sees a prepared marker and fails closed.
 */
function markDeliveryEffectFailed(
  cwd: string,
  esc: Escalation,
  key: string,
  name: string,
  payloadDigest: string,
  receipt: EscalationReceipt,
  pinnedRoot: PinnedProjectRoot,
): void {
  if (!pinnedRoot.isStable()) throw new DeliveryEffectAmbiguousError(key);
  const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", runIdOf(esc), "delivery-effects"), { pinnedRoot });
  if (!queue) throw new DeliveryEffectAmbiguousError(key);
  try {
    const observed = queue.read(name);
    const current = JSON.parse(decodeTelegramUtf8(observed.bytes)) as unknown;
    if (
      !isDeliveryEffectRecord(current)
      || current.status !== "prepared"
      || current.key !== key
      || current.escalation_id !== esc.id
      || current.payload_digest !== payloadDigest
    ) {
      throw new DeliveryEffectAmbiguousError(key);
    }
    if (!pinnedRoot.isStable()) throw new DeliveryEffectAmbiguousError(key);
    queue.replaceIfMatches(
      name,
      { dev: observed.dev, ino: observed.ino, sha256: createHash("sha256").update(observed.bytes).digest("hex") },
      serializeDeliveryEffectRecord(
        { schema: 1, status: "failed", key, escalation_id: esc.id, payload_digest: payloadDigest, receipt, at: new Date().toISOString() },
        queue.maxEntryBytes,
      ),
    );
  } catch (error) {
    if (error instanceof DeliveryEffectAmbiguousError) throw error;
    throw new DeliveryEffectAmbiguousError(key);
  } finally {
    queue.close();
  }
}

function isDeliveryEffectRecord(value: unknown): value is DeliveryEffectRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== 1
    || (
      record.status !== "prepared"
      && record.status !== "failed"
      && record.status !== "delivered_unmapped"
      && record.status !== "delivered"
    )
    || typeof record.key !== "string"
    || record.key.length === 0
    || Buffer.byteLength(record.key, "utf8") > MAX_TELEGRAM_IDEMPOTENCY_KEY_UTF8_BYTES
    || typeof record.payload_digest !== "string"
    || !/^[0-9a-f]{64}$/.test(record.payload_digest)
    || typeof record.at !== "string"
  ) return false;
  if (record.status === "prepared") return true;
  if (record.status === "delivered_unmapped" && (!Number.isSafeInteger(record.message_id) || (record.message_id as number) <= 0)) return false;
  const receipt = record.receipt;
  if (
    !receipt
    || typeof receipt !== "object"
    || typeof (receipt as Record<string, unknown>).sent !== "boolean"
    || ((receipt as Record<string, unknown>).channelRef !== undefined && typeof (receipt as Record<string, unknown>).channelRef !== "string")
  ) return false;
  return record.status === "failed"
    ? (receipt as Record<string, unknown>).sent === false
    : (receipt as Record<string, unknown>).sent === true;
}

function runIdOf(esc: Escalation): string {
  return esc.id.split("/")[0] ?? esc.id;
}


function isSafeRunId(runId: string): boolean {
  return isSafeCtoRunId(runId);
}

/**
 * Node 20-compatible `Promise.withResolvers` (which is Node 22+ / ES2024);
 * mirrors the repo convention in packages/e2e/src/util.ts.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

