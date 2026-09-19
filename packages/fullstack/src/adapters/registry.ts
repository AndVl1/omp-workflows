/**
 * Escalation adapter registry + outbox dispatcher (fullstack).
 *
 * Two-layer reality: the CTO agent (an LLM) cannot call TS adapters. So the
 * agent WRITES an escalation request file to the outbox and the extension
 * dispatches it:
 *
 *   agent ── writes .work-state/cto/<runId>/outbox/<escId>.json ──► dispatcher
 *   dispatcher ── sanitize (R4) ──► adapter.send ──► channel (HTTP / Telegram)
 *   channel / user ──► .work-state/cto/<runId>/answers/<escId>.json ──► agent
 *
 * The dispatcher runs on `session_start` when `.omp/escalation.json` exists.
 * Consumer config shape:
 *
 *   {
 *     "adapter": "http" | "telegram",
 *     "http":     { "url": "https://ntfy.sh/my-topic", "headers": {} },
 *     "telegram": { "token": "...", "chatId": "...", "pollIntervalMs": 5000,
 *                   "legacyMappingMigration": { "tenant": "...", "chatId": "..." } }
 *
 * ── Resident control-plane: profile-aware channel sets (schema-2 additive) ──
 *
 * `createChannelSet(cwd)` resolves the config through the core channel
 * normalizer (capability-validated directions) and builds one adapter per
 * profile. Exactly one explicitly marked primary is authoritative; an
 * unusable, capability-incompatible, or non-RW marked primary fails closed.
 * With no marked primary, the first valid RW profile is selected, and every
 * RO profile becomes an outbound REPORT SINK. The selected primary is the
 * only adapter that may be wired for inbound (`setPlainMessageHandler`) or
 * polled (`pollOnce`); RO sinks are never touched for inbound (architecture
 * invariant: RO adapters are never polled or wired for inbound handlers).
 *
 * Outbox delivery is envelope-aware: entries may carry additive
 * `intent` (`ack` | `question` | `progress` | `summary`), `target`
 * (ackTarget override) and `topic` (report topic). After the primary send,
 * successfully-sent `summary` entries are best-effort fanned out to each RO
 * sink: a sink with `subscriptions[]` receives only matching `topic`s, a
 * sink without subscriptions receives all reports. Sink failures never fail
 * the primary result.
 *
 * `isBidirectionalChannel(cwd)` validates the resolved primary through this
 * registry, including the concrete factory's inbound/outbound surface. A
 * legacy `{adapter:"http", bidirectional:true}` flag alone does NOT make
 * HTTP bidirectional — its built-in registration is push-only. Consumer
 * transports may use a legacy bidirectional flag only when their registered
 * factory carries explicit bounded send/inbound capability metadata; missing
 * metadata is a typed configuration block, never a silent RO downgrade.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { TextDecoder } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  EscalationConfigError,
  normalizeChannelConfigResult,
  sanitizeEscalation,
  validateEscalation,
  canonicalDurableIdFileName,
  legacyDurableIdFileName,
  safeLegacyDurableIdFileName,
  PinnedProjectRoot,
  PinnedRootError,
  isSafeCtoInboundText,
  isSafeCtoRunId,
  isSafeEscalationId,
  type ChannelCapabilities,
  type ChannelProfile,
  type NormalizedEscalationConfig,
  type CtoState,
  type Escalation,
  type EscalationAdapter,
  type EscalationAnswer,
  type EscalationReceipt,
  type QuarantineRecord,
  type WaveRecord,
} from "@andvl1/omp-workflows-core";
import { BoundedQueueError, openBoundedQueue, type BoundedQueue, type BoundedQueueEntryExpectation } from "@andvl1/omp-workflows-core/queue";
import {
  assertCtoRuntimeAccessFacadeLive,
  assertCtoRuntimeProofAuthorityLive,
  assertCtoRuntimeProofAuthorityBound,
  assertCtoRuntimeServiceMutationAuthorityBound,
  isCtoRuntimeAccessFacade,
  withCtoRuntimeServiceTransaction,
  isCtoRuntimeProofAuthority,
  signCtoRuntimeProof,
  verifyCtoRuntimeProof,
  type CtoRuntimeBridgeRouteAccess,
  type CtoRuntimeProofAuthority,
} from "@andvl1/omp-workflows-core/cto-runtime";
import type { CtoRunDeliveryIndexEntry, CtoRuntimeAccessFacade, CtoRuntimeOutboxDeliveryInput, CtoRunTransactionFacade, CtoRuntimeServiceMutationAuthority } from "@andvl1/omp-workflows-core/cto-runtime";
import type { RegistryContextSnapshot } from "@andvl1/omp-workflows-core/registry";
import {
  createRegistryRegistrationLiveGuard,
  recordRegistryUndo,
  registryRegistrationPrincipal,
  requireRegistryRegistration,
  type RegistryRegistrationPrincipal,
  type RegistryRegistrationToken,
} from "@andvl1/omp-workflows-core/registry";
import { HttpEscalationAdapter } from "./http.js";
import { TelegramEscalationAdapter, type TelegramRuntimeAccess } from "./telegram.js";

type RuntimeAccess = CtoRuntimeAccessFacade;
type RuntimeServiceAuthority = CtoRuntimeServiceMutationAuthority;

type RuntimeWaveView = {
  readonly id: string;
  readonly source: string;
  readonly source_id: string;
  readonly task: string;
  readonly slice_ids: readonly string[];
  readonly status: WaveRecord["status"];
  readonly started_at: string;
  readonly finished_at?: string;
};

type RuntimeTeamView = { readonly status: string };

type RuntimeTerminalSummaryEvidence = {
  readonly wave_id: string;
  readonly source_revision: number;
  readonly envelope_sha256: string;
  readonly envelope: string;
};

type RuntimeStateView = {
  readonly id: string;
  readonly state_revision?: number;
  readonly updated_at: string;
  readonly standby?: boolean;
  readonly pause?: { readonly kind: string };
  readonly integration?: { readonly status: string };
  readonly teams: readonly RuntimeTeamView[];
  readonly wave_history: readonly RuntimeWaveView[];
  readonly terminal_summary_evidence?: readonly RuntimeTerminalSummaryEvidence[];
};

type StateView = CtoState | RuntimeStateView;

const ABSENT_ROUTING_CONFIG_SHA256 = createHash("sha256").update("omp-escalation-config:absent", "utf8").digest("hex");
const ABSENT_ROUTING_SNAPSHOT_SHA256 = createHash("sha256").update("omp-escalation-routing:absent", "utf8").digest("hex");
type AdapterRoutingBinding = {
  config_sha256: string;
  snapshot_sha256: string;
  channel: string | null;
  target: string | null;
  canonical_root: string | null;
  root_dev: number | null;
  root_ino: number | null;
};

function fixedAckTargetForProjection(projection: Record<string, unknown>, adapter: string): string | null {
  if (typeof projection.ackTarget === "string") return projection.ackTarget;
  const config = projection[adapter];
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  for (const key of ["url", "chatId", "target"] as const) {
    const value = (config as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function routingBindingForDelivery(
  snapshot: ReturnType<CtoRuntimeAccessFacade["resolveEscalationChannelSnapshot"]>,
  delivery: CtoDelivery | Record<string, unknown>,
  root: AdapterRootIdentity | null = null,
): AdapterRoutingBinding {
  const target = ownDeliveryValue(delivery as CtoDelivery, "target");
  if (snapshot.status !== "valid") {
    return {
      config_sha256: ABSENT_ROUTING_CONFIG_SHA256,
      snapshot_sha256: ABSENT_ROUTING_SNAPSHOT_SHA256,
      channel: null,
      target: null,
      canonical_root: root?.canonical_root ?? null,
      root_dev: root?.root_dev ?? null,
      root_ino: root?.root_ino ?? null,
    };
  }
  const resolvedTargets: Array<string | null> = [];
  const resolvedChannels: string[] = [];
  for (const kind of snapshot.kinds) {
    const projections = snapshot.projections[kind] ?? [];
    for (const projection of projections) {
      const adapter = typeof projection.adapter === "string" ? projection.adapter : kind;
      const id = typeof projection.id === "string" ? projection.id.trim() : "";
      const channel = id.length > 0 ? `${adapter}:${id}` : adapter;
      resolvedChannels.push(channel);
      // The snapshot digest is about authenticated configuration, never the
      // envelope's requested target. Target authorization is checked at send.
      resolvedTargets.push(fixedAckTargetForProjection(projection, adapter));
    }
  }
  const routeDescriptor = {
    status: snapshot.status,
    config_sha256: snapshot.config_sha256,
    kinds: [...snapshot.kinds],
    projections: snapshot.projections,
    resolved_channels: resolvedChannels,
    resolved_targets: resolvedTargets,
  };
  const snapshot_sha256 = createHash("sha256").update(JSON.stringify(routeDescriptor), "utf8").digest("hex");
  return {
    config_sha256: snapshot.config_sha256,
    snapshot_sha256,
    channel: resolvedChannels.join("\u0000") || null,
    target: typeof target === "string" ? target : null,
    canonical_root: root?.canonical_root ?? null,
    root_dev: root?.root_dev ?? null,
    root_ino: root?.root_ino ?? null,
  };
}

function profileFixedAckTarget(snapshot: ReturnType<CtoRuntimeAccessFacade["resolveEscalationChannelSnapshot"]>, profile: ChannelProfile): string | null {
  if (snapshot.status !== "valid") return null;
  const kind = profile.adapter ?? profile.transport;
  if (typeof kind !== "string") return null;
  const profileId = typeof profile.id === "string" ? profile.id : "";
  const projection = (snapshot.projections[kind] ?? []).find((candidate) =>
    (typeof candidate.id === "string" ? candidate.id.trim() : "") === profileId);
  return projection ? fixedAckTargetForProjection(projection, kind) : null;
}

function profileChannel(profile: ChannelProfile): string | null {
  const kind = profile.adapter ?? profile.transport;
  if (typeof kind !== "string") return null;
  const id = typeof profile.id === "string" ? profile.id.trim() : "";
  return id.length > 0 ? `${kind}:${id}` : kind;
}

function routingBindingForProfile(
  snapshot: ReturnType<CtoRuntimeAccessFacade["resolveEscalationChannelSnapshot"]>,
  profile: ChannelProfile,
  root: AdapterRootIdentity | null = null,
) {
  const binding = routingBindingForDelivery(snapshot, {}, root);
  return { ...binding, channel: profileChannel(profile), target: profileFixedAckTarget(snapshot, profile) };
}

function currentRoutingBinding(runtimeAccess: RuntimeAccess, delivery: CtoDelivery | Record<string, unknown>, pinnedRoot: PinnedProjectRoot | undefined) {
  try {
    if (!pinnedRoot) return null;
    return routingBindingForDelivery(runtimeAccess.resolveEscalationChannelSnapshot(), delivery, adapterRootFromPinned(pinnedRoot));
  } catch {
    return null;
  }
}

function routingBindingForBytes(runtimeAccess: RuntimeAccess, bytes: Uint8Array, pinnedRoot: PinnedProjectRoot | undefined) {
  try {
    if (!pinnedRoot) return null;
    const value = JSON.parse(decodeUtf8(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return currentRoutingBinding(runtimeAccess, value as Record<string, unknown>, pinnedRoot);
  } catch {
    return null;
  }
}

function isReadonlyRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function runtimeWaveView(value: unknown): RuntimeWaveView | null {
  if (!isReadonlyRecord(value)) return null;
  const id = value.id;
  const source = value.source;
  const sourceId = value.source_id;
  const task = value.task;
  const startedAt = value.started_at;
  const finishedAt = value.finished_at;
  const status = value.status;
  const sliceIdsValue = value.slice_ids;
  if (typeof id !== "string" || id.length === 0
    || typeof source !== "string"
    || typeof sourceId !== "string"
    || typeof task !== "string"
    || typeof startedAt !== "string"
    || (finishedAt !== undefined && typeof finishedAt !== "string")
    || (status !== "active" && status !== "done" && status !== "failed")
    || !Array.isArray(sliceIdsValue)) return null;
  const sliceIds: string[] = [];
  for (const sliceId of sliceIdsValue) {
    if (typeof sliceId !== "string") return null;
    sliceIds.push(sliceId);
  }
  return {
    id,
    source,
    source_id: sourceId,
    task,
    slice_ids: sliceIds,
    status,
    started_at: startedAt,
    ...(finishedAt === undefined ? {} : { finished_at: finishedAt }),
  };
}

function runtimeStateView(value: Readonly<Record<string, unknown>>): RuntimeStateView | null {
  if (!isReadonlyRecord(value)) return null;
  const id = value.id;
  const updatedAt = value.updated_at;
  const revision = value.state_revision;
  const standby = value.standby;
  if (typeof id !== "string" || id.length === 0
    || typeof updatedAt !== "string"
    || (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0))
    || (standby !== undefined && typeof standby !== "boolean")) return null;

  let pause: { readonly kind: string } | undefined;
  const pauseValue = value.pause;
  if (pauseValue !== undefined) {
    if (!isReadonlyRecord(pauseValue) || typeof pauseValue.kind !== "string") return null;
    pause = { kind: pauseValue.kind };
  }

  let integration: { readonly status: string } | undefined;
  const integrationValue = value.integration;
  if (integrationValue !== undefined) {
    if (!isReadonlyRecord(integrationValue) || typeof integrationValue.status !== "string") return null;
    integration = { status: integrationValue.status };
  }

  const teams: RuntimeTeamView[] = [];
  const teamsValue = value.teams;
  if (teamsValue !== undefined) {
    if (!Array.isArray(teamsValue)) return null;
    for (const teamValue of teamsValue) {
      if (!isReadonlyRecord(teamValue) || typeof teamValue.status !== "string") return null;
      teams.push({ status: teamValue.status });
    }
  }

  const terminalSummaryEvidence: RuntimeTerminalSummaryEvidence[] = [];
  const terminalSummaryEvidenceValue = value.terminal_summary_evidence;
  if (terminalSummaryEvidenceValue !== undefined) {
    if (!Array.isArray(terminalSummaryEvidenceValue)) return null;
    const evidenceWaveIds = new Set<string>();
    for (const evidenceValue of terminalSummaryEvidenceValue) {
      if (!isReadonlyRecord(evidenceValue)) return null;
      const waveId = evidenceValue.wave_id;
      const sourceRevision = evidenceValue.source_revision;
      const envelopeSha256 = evidenceValue.envelope_sha256;
      const envelope = evidenceValue.envelope;
      if (typeof waveId !== "string" || waveId.length === 0 || evidenceWaveIds.has(waveId)
        || typeof sourceRevision !== "number" || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0
        || typeof envelopeSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(envelopeSha256)
        || typeof envelope !== "string") return null;
      evidenceWaveIds.add(waveId);
      terminalSummaryEvidence.push({ wave_id: waveId, source_revision: sourceRevision, envelope_sha256: envelopeSha256, envelope });
    }
  }

  const waveHistory: RuntimeWaveView[] = [];
  const waveHistoryValue = value.wave_history;
  if (waveHistoryValue !== undefined) {
    if (!Array.isArray(waveHistoryValue)) return null;
    for (const waveValue of waveHistoryValue) {
      const wave = runtimeWaveView(waveValue);
      if (!wave) return null;
      waveHistory.push(wave);
    }
  }

  return {
    id,
    updated_at: updatedAt,
    teams,
    wave_history: waveHistory,
    ...(revision === undefined ? {} : { state_revision: revision }),
    ...(standby === undefined ? {} : { standby }),
    ...(pause === undefined ? {} : { pause }),
    ...(integration === undefined ? {} : { integration }),
    ...(terminalSummaryEvidenceValue === undefined ? {} : { terminal_summary_evidence: terminalSummaryEvidence }),
  };
}

function runtimeState(access: RuntimeAccess | undefined, runId: string): RuntimeStateView | null {
  if (!access) return null;
  try {
    const projected = access.readState(runId);
    return projected === null ? null : runtimeStateView(projected);
  } catch {
    return null;
  }
}

function runtimeActive(access: RuntimeAccess | undefined): { runId: string; state: RuntimeStateView } | null {
  if (!access) return null;
  try {
    const active = access.findActiveRun();
    if (!active) return null;
    const state = runtimeStateView(active.state);
    return state ? { runId: active.runId, state } : null;
  } catch (error) {
    if (isDispatcherActivationFailure(error)) throw error;
    try { access.assertLive(); } catch (livenessError) {
      throw new DispatcherActivationRevokedError(livenessError instanceof Error ? livenessError.message : "dispatcher runtime access is no longer live");
    }
    return null;
  }
}

function terminalState(state: StateView): boolean {
  return state.pause?.kind === "done" || state.pause?.kind === "failed";
}

function waveBySourceId(state: StateView, sourceId: string): RuntimeWaveView | null {
  const matches = (state.wave_history ?? []).filter((wave) => wave && wave.source_id === sourceId);
  return matches.length === 1 ? matches[0]! : null;
}

export interface EscalationConfig {
  adapter: string;
  /** True when the channel can receive user replies (bidirectional). */
  bidirectional?: boolean;
  http?: { url: string; headers?: Record<string, string> };
  telegram?: {
    token: string;
    chatId: string;
    pollIntervalMs?: number;
    /** Additional chats allowed for inbound beyond chatId (chatId always allowed). */
    allowedChatIds?: Array<string | number>;
    /** When non-empty, inbound senders must be in this list. */
    allowedSenderIds?: Array<string | number>;
    /** Explicit exact tenant/chat authorization for legacy mapping migration. */
    legacyMappingMigration?: { tenant: string; chatId: string };
  };
  /** Transport-specific config for consumer-registered adapters. */
  [transport: string]: unknown;
}

/** Run id is the first segment of the escalation correlation id. */
export function runIdOf(esc: Escalation): string {
  return esc.id.split("/")[0] ?? esc.id;
}

export function outboxDir(runId: string, root: string): string {
  return join(root, ".work-state", "cto", runId, "outbox");
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
// ── Delivery envelope (schema-2 additive) ──────────────────────────────────

/**
 * Delivery intent stamped on durable outbox entries. Additive fields on the
 * Escalation shape — core validateEscalation tolerates extras, and
 * sanitizeEscalation/redactEscalation preserve them, so the whole
 * retry/redaction/archive-cleanup path passes them through untouched.
 */
export type DeliveryIntent = "ack" | "question" | "progress" | "summary";

/** A durable outbox delivery: escalation-shaped + additive envelope fields. */
export type CtoDelivery = Escalation & {
  intent: DeliveryIntent;
  /** Canonical terminal-summary envelope metadata (summary intent only). */
  at?: string;
  by?: string;
  run_id?: string;
  state_revision?: number;
  wave_id?: string;
  /** ackTarget override — the channel/user the message is addressed to. */
  target?: string;
  /** Report topic — RO sink subscription routing (`summary` intents). */
  topic?: string;
  /** Durable transport idempotency key (defaults to the delivery id). */
  idempotency_key?: string;
};

/** Durable idempotency keys are transport metadata, not arbitrary text. */
export const MAX_IDEMPOTENCY_KEY_BYTES = 255;

function normalizeIdempotencyKey(value: unknown, fallback: string): string | null {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim();
  if (normalized.length === 0) return null;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized)) return null;
  if (Buffer.byteLength(normalized, "utf8") <= MAX_IDEMPOTENCY_KEY_BYTES) return normalized;
  // queueCtoDelivery preserves the caller's exact delivery ID as the
  // idempotency key for backwards-compatible envelopes. Once that trusted
  // fallback exceeds a filesystem component's byte ceiling, bind the
  // transport key to its digest instead of rejecting the delivery. Explicit
  // oversized keys remain invalid metadata.
  if (value !== undefined && normalized !== fallback.trim()) return null;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
const DELIVERY_INTENTS = new Set<DeliveryIntent>(["ack", "question", "progress", "summary"]);
const DELIVERY_ALLOWED_KEYS = new Set([
  "id", "level", "title", "body", "options", "default", "timeoutMs", "replyTo",
  "intent", "at", "by", "run_id", "state_revision", "wave_id", "target", "topic", "idempotency_key",
]);

function ownDeliveryValue(delivery: CtoDelivery, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(delivery, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function validCtoDelivery(delivery: CtoDelivery, runId: string): boolean {
  try {
    if (!isSafeCtoRunId(runId)
      || validateEscalation(delivery) !== null
      || Object.keys(delivery).some((key) => !DELIVERY_ALLOWED_KEYS.has(key))
      || !Object.hasOwn(delivery, "intent")
      || !DELIVERY_INTENTS.has(ownDeliveryValue(delivery, "intent") as DeliveryIntent)
      || runIdOf(delivery) !== runId) return false;
    const at = ownDeliveryValue(delivery, "at");
    const by = ownDeliveryValue(delivery, "by");
    const target = ownDeliveryValue(delivery, "target");
    const topic = ownDeliveryValue(delivery, "topic");
    const run = ownDeliveryValue(delivery, "run_id");
    const wave = ownDeliveryValue(delivery, "wave_id");
    const revision = ownDeliveryValue(delivery, "state_revision");
    const deliveryId = ownDeliveryValue(delivery, "id");
    const idempotencyKey = ownDeliveryValue(delivery, "idempotency_key");
    if (at !== undefined && typeof at !== "string") return false;
    if (by !== undefined && typeof by !== "string") return false;
    if (target !== undefined && typeof target !== "string") return false;
    if (topic !== undefined && typeof topic !== "string") return false;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey !== deliveryId)) return false;
    if (run !== undefined && (run !== runId || !isSafeCtoRunId(run))) return false;
    if (wave !== undefined && !isSafeCtoRunId(wave)) return false;
    if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) return false;
    return true;
  } catch {
    return false;
  }
}

function canonicalCtoDelivery(delivery: CtoDelivery, runId?: string, stateRevision?: number): Record<string, unknown> {
  const canonical: Record<string, unknown> = {
    id: ownDeliveryValue(delivery, "id"),
    level: ownDeliveryValue(delivery, "level"),
    title: ownDeliveryValue(delivery, "title"),
    body: ownDeliveryValue(delivery, "body"),
  };
  const options = ownDeliveryValue(delivery, "options") as CtoDelivery["options"];
  if (options !== undefined) {
    canonical.options = options.map((option) => ({ id: option.id, label: option.label, apply: option.apply }));
  }
  for (const key of ["default", "timeoutMs", "replyTo"] as const) {
    const value = ownDeliveryValue(delivery, key);
    if (value !== undefined) canonical[key] = value;
  }
  canonical.intent = ownDeliveryValue(delivery, "intent");
  for (const key of ["topic", "at", "by", "run_id", "state_revision", "wave_id", "target"] as const) {
    const value = ownDeliveryValue(delivery, key);
    if (value !== undefined) canonical[key] = value;
  }
  // Runtime publication authenticates these values against the state/index;
  // persist the same binding in the envelope so drain can reject stale or
  // cross-revision records before invoking a transport.
  if (runId !== undefined) canonical.run_id = runId;
  if (stateRevision !== undefined) canonical.state_revision = stateRevision;
  canonical.idempotency_key = canonical.id;
  return canonical;
}

/**
 * Queue a CTO delivery durably under its bounded canonical filename. Legacy
 * filenames are only migration probes; a safe alias is passed when one fits
 * as a single path component, and oversized/unsafe aliases are omitted.
 * (mkdir -p, `wx` — first write wins). Idempotent on the delivery id: a
 * duplicate returns null without overwriting. Returns the file path or null
 * on duplicate / write failure (best-effort — the caller must never treat
 * this as a blocking path). The regular `drainOutbox` tick picks the entry
 * up with the existing retry/redaction/archive-cleanup semantics.
 *
 * The durable receiver idempotency key, not workspace archives, is the
 * crash-recovery authority. The outbox publication and state obligation remain
 * durable until a receiver-confirmed send is followed by archive cleanup.
 */
export function queueCtoDelivery(root: string, runId: string, delivery: CtoDelivery, providedRoot?: PinnedProjectRoot, isOwned?: () => boolean, runtimeAccess?: RuntimeAccess): string | null {
  if (!validCtoDelivery(delivery, runId)) return null;
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return null;
  try {
    if (!pinnedRoot.isStable() || (isOwned && !isOwned())) return null;
    const state = runtimeState(runtimeAccess, runId);
    if (!state) return null;
    let stateRevision = state.state_revision;
    if (typeof stateRevision !== "number" || !Number.isSafeInteger(stateRevision)) return null;
    const deliveryId = ownDeliveryValue(delivery, "id");
    if (typeof deliveryId !== "string") return null;
    const fileName = canonicalDurableIdFileName(deliveryId);
    // Terminal-summary publication is byte-canonical: core validates the exact
    // envelope on terminal runs, so preserve only the validated own fields.
    let serialized: string;
    try {
      serialized = JSON.stringify(canonicalCtoDelivery(delivery, runId, stateRevision));
      if (serialized === undefined) return null;
    } catch {
      return null;
    }
    try {
      const legacyEntryName = safeLegacyDurableIdFileName(deliveryId);
      if (!runtimeAccess) return null;
      const routingBinding = currentRoutingBinding(runtimeAccess, delivery, pinnedRoot);
      if (!routingBinding) return null;
      const obligation = runtimeAccess.recordOutboxDeliveryObligation({
        run_id: runId,
        entry_name: fileName,
        json: serialized,
        routing_binding: routingBinding,
      });
      if (!obligation) return null;
      stateRevision = obligation.state_revision;
      serialized = decodeUtf8(obligation.json);
      const published = runtimeAccess.publishOutboxDelivery({
        run_id: runId,
        state_revision: stateRevision,
        entry_name: fileName,
        ...(legacyEntryName === undefined ? {} : { legacy_entry_name: legacyEntryName }),
        json: serialized,
        routing_binding: routingBinding,
      });
      // A publish may revoke the activation synchronously (or return after a
      // concurrent revocation). Never report a durable ACK as successful once
      // its runtime authority or immutable root is no longer live.
      runtimeAccess.assertLive();
      if (!pinnedRoot.isStable() || (isOwned && !isOwned())) return null;
      return published;
    } catch {
      return null;
    }
  } finally {
    if (!providedRoot) pinnedRoot.close();
  }
}

/** Adapter factory for a transport kind (built-in or consumer-registered). */
export type EscalationAdapterFactory = (config: EscalationConfig, cwd: string, pinnedRoot: PinnedProjectRoot | undefined, runtimeAccess: RuntimeAccess) => EscalationAdapter | null;
type BuiltinEscalationAdapterFactory = (config: EscalationConfig, cwd: string, pinnedRoot: PinnedProjectRoot | undefined, runtimeAccess: RuntimeAccess | undefined, proofAuthority: CtoRuntimeProofAuthority, bridgeRoute?: CtoRuntimeBridgeRouteAccess, assertRoutingLive?: () => void, assertActivationLive?: () => void) => EscalationAdapter | null;

/**
 * Capabilities are registered alongside a consumer transport because channel
 * direction and durable delivery safety are resolved before its factory is
 * invoked. Every configured custom registration must declare inbound, outbound,
 * and receiver-side idempotency metadata; missing metadata is a typed block.
 */
export interface EscalationAdapterCapabilities extends ChannelCapabilities {
  /** Must be true for every resident/durable channel registration. */
  canSendWithIdempotency: boolean;
}

type AdapterRootIdentity = { readonly canonical_root: string; readonly root_dev: number; readonly root_ino: number };
type RegistryRegistrationLiveGuard = ReturnType<typeof createRegistryRegistrationLiveGuard>;

interface AdapterRegistrationLease {
  /** Authenticated owner principal minted by the core registry transaction. */
  readonly principal: RegistryRegistrationPrincipal;
  /** Re-checks owner context + activation marker before every custom use. */
  readonly liveGuard: RegistryRegistrationLiveGuard;
}

interface AdapterRegistration {
  factory: EscalationAdapterFactory;
  /** Only engine-owned built-ins may receive the opaque proof authority. */
  proofFactory?: BuiltinEscalationAdapterFactory;
  capabilities?: Readonly<EscalationAdapterCapabilities>;
  /** Built-in cells are permanently reserved and have no consumer principal. */
  builtin: boolean;
  /** Consumer registrations are visible only for this immutable root identity. */
  root?: AdapterRootIdentity;
  /** One lease per successful registration transaction; each is independently live-guarded. */
  leases?: AdapterRegistrationLease[];
}

/**
 * Registering a consumer adapter requires an opaque core-minted token. The
 * token binds the registration to the canonical owner claim/root and is
 * intentionally not reconstructible from public identity fields.
 */
const ADAPTER_REGISTRATION_LIVE_GUARD = Symbol("omp-cto-adapter-registration-live-guard");

type AdapterRegistrationLiveBinding = {
  readonly registration: AdapterRegistration;
  readonly assertLive: () => void;
};
type AdapterRegistrationLiveMarker = {
  readonly [ADAPTER_REGISTRATION_LIVE_GUARD]: AdapterRegistrationLiveBinding;
};

function guardedAdapterOperation<T>(assertLive: () => void, operation: () => T): T {
  assertLive();
  let result: T;
  try {
    result = operation();
  } catch (error) {
    assertLive();
    throw error;
  }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return Promise.resolve(result as unknown as PromiseLike<unknown>).then(
      (value) => { assertLive(); return value; },
      (error) => { assertLive(); throw error; },
    ) as T;
  }
  assertLive();
  return result;
}

function guardedAsyncAdapterOperation<T>(assertLive: () => void, operation: () => T): Promise<T> {
  let result: T;
  try {
    assertLive();
    result = operation();
  } catch (error) {
    return Promise.reject(error);
  }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return Promise.resolve(result as unknown as PromiseLike<unknown>).then(
      (value) => { assertLive(); return value; },
      (error) => { assertLive(); throw error; },
    ) as Promise<T>;
  }
  try {
    assertLive();
    return Promise.resolve(result);
  } catch (error) {
    return Promise.reject(error);
  }
}

function wrapAdapterMethods(adapter: EscalationAdapter, assertLive: () => void): void {
  const target = adapter as unknown as Record<string, unknown>;
  for (const name of ["send", "sendWithIdempotency", "cancel", "pollOnce", "sendPlainText", "setPlainMessageHandler", "setAnswerHandler"] as const) {
    const original = target[name];
    if (typeof original !== "function") continue;
    target[name] = (...args: unknown[]): unknown => {
      const forwarded = [...args];
      if ((name === "setPlainMessageHandler" || name === "setAnswerHandler") && typeof forwarded[0] === "function") {
        const handler = forwarded[0] as (...callbackArgs: unknown[]) => unknown;
        forwarded[0] = (...callbackArgs: unknown[]): unknown => guardedAdapterOperation(
          assertLive,
          () => Reflect.apply(handler, undefined, callbackArgs),
        );
      }
      const operation = () => Reflect.apply(original, adapter, forwarded);
      if (name === "send" || name === "sendWithIdempotency" || name === "cancel" || name === "pollOnce" || name === "sendPlainText") {
        return guardedAsyncAdapterOperation(assertLive, operation);
      }
      return guardedAdapterOperation(assertLive, operation);
    };
  }
}

function markAdapterRegistrationLive(adapter: EscalationAdapter, registration: AdapterRegistration, expectedRoot: AdapterRootIdentity): void {
  if (registration.builtin) return;
  const assertLive = (): void => {
    if (!liveCustomRegistration(registration, expectedRoot)) {
      throw new DispatcherActivationRevokedError("custom adapter registration is no longer live");
    }
  };
  const existing = (adapter as unknown as Partial<AdapterRegistrationLiveMarker>)[ADAPTER_REGISTRATION_LIVE_GUARD];
  if (existing) {
    if (existing.registration !== registration) throw new DispatcherActivationRevokedError("adapter object was reused by a different registration");
    existing.assertLive();
    return;
  }
  wrapAdapterMethods(adapter, assertLive);
  Object.defineProperty(adapter, ADAPTER_REGISTRATION_LIVE_GUARD, {
    configurable: true,
    enumerable: false,
    value: Object.freeze({ registration, assertLive }),
  });
}

function assertAdapterRegistrationLive(adapter: EscalationAdapter | null | undefined): void {
  if (!adapter) return;
  (adapter as unknown as Partial<AdapterRegistrationLiveMarker>)[ADAPTER_REGISTRATION_LIVE_GUARD]?.assertLive();
}

const BUILTIN_ADAPTER_KINDS = new Set(["http", "telegram"]);
export const MAX_CUSTOM_ADAPTER_KIND_BYTES = 128;
export const MAX_CUSTOM_ADAPTER_KINDS_PER_ROOT = 64;
export const MAX_CUSTOM_ADAPTER_ROOTS = 64;
export const MAX_CUSTOM_ADAPTER_REGISTRATIONS = 256;
const customAdapterFactories = new Map<string, Map<string, AdapterRegistration>>();

function adapterRootKey(root: AdapterRootIdentity): string {
  return `${root.canonical_root}\u0000${root.root_dev}:${root.root_ino}`;
}

function adapterRootFromPinned(pinnedRoot: PinnedProjectRoot): AdapterRootIdentity {
  return { canonical_root: pinnedRoot.canonical_root, root_dev: pinnedRoot.dev, root_ino: pinnedRoot.ino };
}

function sameAdapterRoot(left: AdapterRootIdentity, right: AdapterRootIdentity): boolean {
  return left.canonical_root === right.canonical_root
    && left.root_dev === right.root_dev
    && left.root_ino === right.root_ino;
}

const MAX_CUSTOM_ADAPTER_LEASES_PER_KIND = 64;

function liveCustomRegistration(registration: AdapterRegistration, expectedRoot: AdapterRootIdentity): AdapterRegistration | undefined {
  if (registration.builtin || !registration.root || !sameAdapterRoot(registration.root, expectedRoot) || !registration.leases?.length) return undefined;
  for (const lease of registration.leases) {
    try {
      const current = lease.liveGuard();
      if (sameAdapterRoot(current, registration.root) && sameAdapterRoot(current, expectedRoot)) return registration;
    } catch {
      // A revoked lease is removed by the bounded sweep before the next lookup.
    }
  }
  return undefined;
}

/** Remove dead owner registrations and roots before every registry lookup/insert. */
function sweepCustomAdapterFactories(): void {
  for (const [rootKey, registrations] of customAdapterFactories) {
    const separator = rootKey.lastIndexOf("\u0000");
    if (separator < 0) {
      customAdapterFactories.delete(rootKey);
      continue;
    }
    const canonicalRoot = rootKey.slice(0, separator);
    const pin = PinnedProjectRoot.open(canonicalRoot);
    if (!pin) {
      customAdapterFactories.delete(rootKey);
      continue;
    }
    try {
      const identity = adapterRootFromPinned(pin);
      if (adapterRootKey(identity) !== rootKey) {
        customAdapterFactories.delete(rootKey);
        continue;
      }
      for (const [kind, registration] of registrations) {
        if (registration.builtin || !registration.root || !registration.leases?.length || !sameAdapterRoot(registration.root, identity)) {
          registrations.delete(kind);
          continue;
        }
        registration.leases = registration.leases.filter((lease) => {
          try {
            const current = lease.liveGuard();
            return sameAdapterRoot(current, registration.root!) && sameAdapterRoot(current, identity);
          } catch {
            return false;
          }
        });
        if (registration.leases.length === 0) registrations.delete(kind);
      }
      if (registrations.size === 0) customAdapterFactories.delete(rootKey);
    } finally {
      pin.close();
    }
  }
}


function frozenCapabilities(capabilities: EscalationAdapterCapabilities): Readonly<EscalationAdapterCapabilities> {
  return Object.freeze({
    canReceiveInbound: capabilities.canReceiveInbound,
    canSend: capabilities.canSend,
    canSendWithIdempotency: capabilities.canSendWithIdempotency,
  });
}

function capabilitiesEqual(
  left?: Readonly<EscalationAdapterCapabilities>,
  right?: Readonly<EscalationAdapterCapabilities>,
): boolean {
  return left?.canReceiveInbound === right?.canReceiveInbound
    && left?.canSend === right?.canSend
    && left?.canSendWithIdempotency === right?.canSendWithIdempotency;
}

const builtinAdapterFactories = new Map<string, AdapterRegistration>([
  ["http", {
    // HTTP is send-capable, so it may only be constructed on the resident
    // runtime path. The bridge-only authority is intentionally Telegram-only.
    factory: () => null,
    proofFactory: (config, _cwd, pinnedRoot, runtimeAccess, _proofAuthority, _bridgeRoute, _assertRoutingLive, assertActivationLive) =>
      runtimeAccess && pinnedRoot && config.http?.url
        ? new HttpEscalationAdapter({ url: config.http.url, headers: config.http.headers, assertLive: assertActivationLive })
        : null,
    capabilities: frozenCapabilities({ canReceiveInbound: false, canSend: true, canSendWithIdempotency: true }),
    builtin: true,
  }],
  [
    "telegram",
    {
      factory: () => null,
      proofFactory: (config, cwd, _pinnedRoot, runtimeAccess, proofAuthority, bridgeRoute, assertRoutingLive) =>
        config.telegram?.token && config.telegram.chatId
          ? new TelegramEscalationAdapter({
              token: config.telegram.token,
              chatId: config.telegram.chatId,
              cwd,
              pollIntervalMs: config.telegram.pollIntervalMs ?? 5_000,
              allowedChatIds: config.telegram.allowedChatIds,
              allowedSenderIds: config.telegram.allowedSenderIds,
              legacyMappingMigration: config.telegram.legacyMappingMigration,
              routingProfile: {
                id: typeof (config as Record<string, unknown>).id === "string" ? String((config as Record<string, unknown>).id).trim() || null : null,
                direction: (config as Record<string, unknown>).direction === "read-only" ? "read-only" : "read-write",
                primary: (config as Record<string, unknown>).primary === true || !(config as Record<string, unknown>).direction,
              },
              proofAuthority,
              runtimeAccess: (bridgeRoute ?? runtimeAccess) as TelegramRuntimeAccess | undefined,
              assertRoutingLive,
            })
          : null,
      capabilities: frozenCapabilities({ canReceiveInbound: true, canSend: true, canSendWithIdempotency: true }),
      builtin: true,
    },
  ],
]);

interface AdapterResolutionScope {
  readonly root: AdapterRootIdentity;
  readonly pinnedRoot: PinnedProjectRoot;
  readonly ownsPinnedRoot: boolean;
}

function openAdapterResolutionScope(cwd: string, pinnedRoot?: PinnedProjectRoot): AdapterResolutionScope | null {
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) return null;
    let suppliedCwdRoot: PinnedProjectRoot | null;
    try {
      suppliedCwdRoot = PinnedProjectRoot.open(cwd);
    } catch {
      return null;
    }
    if (!suppliedCwdRoot) return null;
    try {
      if (!suppliedCwdRoot.isStable() || !sameAdapterRoot(adapterRootFromPinned(suppliedCwdRoot), adapterRootFromPinned(pinnedRoot))) return null;
    } finally {
      suppliedCwdRoot.close();
    }
    return { root: adapterRootFromPinned(pinnedRoot), pinnedRoot, ownsPinnedRoot: false };
  }
  let ownedRoot: PinnedProjectRoot | null;
  try {
    ownedRoot = PinnedProjectRoot.open(cwd);
  } catch {
    return null;
  }
  if (!ownedRoot || !ownedRoot.isStable()) {
    ownedRoot?.close();
    return null;
  }
  return { root: adapterRootFromPinned(ownedRoot), pinnedRoot: ownedRoot, ownsPinnedRoot: true };
}

function closeAdapterResolutionScope(scope: AdapterResolutionScope): void {
  if (scope.ownsPinnedRoot) scope.pinnedRoot.close();
}

function assertRuntimeScope(runtimeAccess: RuntimeAccess, scope: AdapterResolutionScope): void {
  try {
    assertCtoRuntimeAccessFacadeLive(runtimeAccess, scope.root.canonical_root);
    runtimeAccess.assertLive();
    const assertProjectRoot = (runtimeAccess as unknown as { assertProjectRoot?: (projectRoot: string) => void }).assertProjectRoot;
    if (typeof assertProjectRoot !== "function") throw new Error("runtime access cannot authenticate the adapter project root");
    assertProjectRoot(scope.root.canonical_root);
  } catch (error) {
    if (error instanceof EscalationConfigError) throw error;
    throw new EscalationConfigError("changed", String(error instanceof Error ? error.message : error));
  }
  if (!scope.pinnedRoot.isStable()) throw new EscalationConfigError("changed", "escalation channel root changed during resolution");
}

/**
 * A resident adapter must be built under the exact project activation that
 * owns its transport. The standalone Telegram bridge is the one exception:
 * it has a narrow authenticated bridge route rather than the full runtime
 * facade, and that authority is accepted only for the Telegram built-in.
 */
function assertAdapterConstructionAuthorities(
  kind: string,
  runtimeAccess: RuntimeAccess | undefined,
  proofAuthority: CtoRuntimeProofAuthority,
  bridgeRoute: CtoRuntimeBridgeRouteAccess | undefined,
  scope: AdapterResolutionScope,
): void {
  const bridgeOnly = runtimeAccess === undefined;
  if (bridgeOnly && (kind !== "telegram" || !bridgeRoute)) {
    throw new Error("adapter construction requires an authenticated runtime access facade");
  }
  assertCtoRuntimeProofAuthorityBound(proofAuthority, scope.pinnedRoot);
  if (runtimeAccess) assertRuntimeScope(runtimeAccess, scope);
  if (bridgeRoute) {
    bridgeRoute.assertLive();
    bridgeRoute.assertProjectRoot(scope.root.canonical_root);
  }
  if (!scope.pinnedRoot.isStable()) throw new EscalationConfigError("changed", "escalation channel root changed during construction");
}

function assertAdapterEffectAuthoritiesLive(
  expectedRoot: AdapterRootIdentity,
  runtimeAccess: RuntimeAccess | undefined,
  proofAuthority: CtoRuntimeProofAuthority,
  bridgeRoute: CtoRuntimeBridgeRouteAccess | undefined,
): void {
  let pin: PinnedProjectRoot | null = null;
  try {
    pin = PinnedProjectRoot.open(expectedRoot.canonical_root);
    if (!pin || !pin.isStable() || pin.dev !== expectedRoot.root_dev || pin.ino !== expectedRoot.root_ino) {
      throw new Error("adapter activation project root changed");
    }
    assertCtoRuntimeProofAuthorityBound(proofAuthority, pin);
    if (runtimeAccess) {
      assertCtoRuntimeAccessFacadeLive(runtimeAccess, expectedRoot.canonical_root);
      runtimeAccess.assertLive();
      runtimeAccess.assertProjectRoot(expectedRoot.canonical_root);
    }
    if (bridgeRoute) {
      bridgeRoute.assertLive();
      bridgeRoute.assertProjectRoot(expectedRoot.canonical_root);
    }
  } finally {
    pin?.close();
  }
}

function registrationForKind(kind: string, scope?: AdapterResolutionScope): AdapterRegistration | undefined {
  sweepCustomAdapterFactories();
  const builtin = builtinAdapterFactories.get(kind);
  if (builtin) return builtin;
  if (!scope) return undefined;
  const candidate = customAdapterFactories.get(adapterRootKey(scope.root))?.get(kind);
  return candidate ? liveCustomRegistration(candidate, scope.root) : undefined;
}

function telegramRoutingRevoked(message: string): Error & { code: "activation_revoked" } {
  const error = new Error(message) as Error & { code: "activation_revoked" };
  error.code = "activation_revoked";
  return error;
}

const TELEGRAM_PROJECTION_SHARED_KEYS = new Set(["adapter", "id", "name", "mode", "direction", "primary", "subscriptions", "fields", "ackTarget", "chatId", "bidirectional"]);
function telegramConfigProjection(config: EscalationConfig): Readonly<Record<string, unknown>> {
  const projection: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (TELEGRAM_PROJECTION_SHARED_KEYS.has(key) || key === "telegram") projection[key] = value;
  }
  return projection;
}

function telegramProjectionForSnapshot(
  config: EscalationConfig,
  snapshot: ReturnType<RuntimeAccess["resolveEscalationChannelSnapshot"]>,
): Readonly<Record<string, unknown>> | null {
  if (snapshot.status !== "valid") return null;
  const candidates = snapshot.projections.telegram;
  const configuredId = typeof config.id === "string" ? config.id.trim() : "";
  const matching = Array.isArray(candidates)
    ? candidates.filter((candidate) => candidate.adapter === "telegram"
      && (configuredId.length === 0
        ? candidate.id === undefined
        : (typeof candidate.id === "string" && candidate.id.trim() === configuredId))
      && (config.primary !== true || candidate.primary === true))
    : [];
  return matching.length === 1 ? matching[0]! : null;
}

function createTelegramRoutingGuard(
  config: EscalationConfig,
  root: AdapterRootIdentity,
  runtimeAccess: RuntimeAccess | undefined,
  bridgeRoute: CtoRuntimeBridgeRouteAccess | undefined,
  initialSnapshot: ReturnType<RuntimeAccess["resolveEscalationChannelSnapshot"]> | undefined,
): (() => void) | undefined {
  const source = bridgeRoute ?? runtimeAccess;
  if (!source || !initialSnapshot || initialSnapshot.status !== "valid") return undefined;
  const snapshot = initialSnapshot;
  const projection = bridgeRoute
    ? bridgeRoute.resolveTelegramChannelProfile()
    : telegramProjectionForSnapshot(config, snapshot);
  if (!projection || typeof snapshot.config_sha256 !== "string") return undefined;
  if (!bridgeRoute && canonicalAuthJson(telegramConfigProjection(config)) !== canonicalAuthJson(projection)) return undefined;
  // Capture the exact initial projection digest. The factory may synchronously
  // rotate escalation.json; no later source read is allowed to redefine the
  // adapter's construction-time route.
  const expectedProjectionSha = createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex");
  return (): void => {
    let currentRoot: PinnedProjectRoot | null = null;
    try {
      currentRoot = PinnedProjectRoot.open(root.canonical_root);
      if (!currentRoot || !currentRoot.isStable() || currentRoot.dev !== root.root_dev || currentRoot.ino !== root.root_ino) {
        throw telegramRoutingRevoked("telegram routing project root changed");
      }
      if (bridgeRoute) {
        bridgeRoute.assertLive();
        bridgeRoute.assertProjectRoot(root.canonical_root);
      } else if (runtimeAccess) {
        runtimeAccess.assertLive();
        runtimeAccess.assertProjectRoot(root.canonical_root);
      }
      const currentSnapshot = source.resolveEscalationChannelSnapshot();
      if (currentSnapshot.status !== "valid" || currentSnapshot.config_sha256 !== snapshot.config_sha256) {
        throw telegramRoutingRevoked("telegram routing configuration changed");
      }
      const currentProjection = bridgeRoute
        ? bridgeRoute.resolveTelegramChannelProfile()
        : telegramProjectionForSnapshot(config, currentSnapshot);
      if (!currentProjection
        || createHash("sha256").update(JSON.stringify(currentProjection), "utf8").digest("hex") !== expectedProjectionSha) {
        throw telegramRoutingRevoked("telegram routing projection changed");
      }
    } finally {
      currentRoot?.close();
    }
  };
}

function invokeAdapterFactory(
  registration: AdapterRegistration,
  config: EscalationConfig,
  cwd: string,
  pinnedRoot: PinnedProjectRoot | undefined,
  runtimeAccess: RuntimeAccess | undefined,
  scope: AdapterResolutionScope,
  proofAuthority: CtoRuntimeProofAuthority,
  bridgeRoute?: CtoRuntimeBridgeRouteAccess,
  initialRoutingSnapshot?: ReturnType<RuntimeAccess["resolveEscalationChannelSnapshot"]>,
  routingGuards?: Array<() => void>,
): EscalationAdapter | null {
  if (!registration.builtin && !liveCustomRegistration(registration, scope.root)) return null;
  let adapter: EscalationAdapter | null;
  try {
    assertAdapterConstructionAuthorities(config.adapter, runtimeAccess, proofAuthority, bridgeRoute, scope);
    const routingSnapshot = initialRoutingSnapshot ?? (config.adapter === "telegram" ? (bridgeRoute ?? runtimeAccess)?.resolveEscalationChannelSnapshot() : undefined);
    const assertRoutingLive = config.adapter === "telegram"
      ? createTelegramRoutingGuard(config, scope.root, runtimeAccess, bridgeRoute, routingSnapshot)
      : undefined;
    const assertActivationLive = () => assertAdapterEffectAuthoritiesLive(scope.root, runtimeAccess, proofAuthority, bridgeRoute);
    if (config.adapter === "telegram" && !assertRoutingLive) throw new EscalationConfigError("changed", "telegram routing guard could not be authenticated");
    if (registration.proofFactory) {
      adapter = registration.proofFactory(config, cwd, scope.pinnedRoot, runtimeAccess, proofAuthority, bridgeRoute, assertRoutingLive, assertActivationLive);
    } else {
      if (!runtimeAccess) return null;
      adapter = registration.factory(config, cwd, scope.pinnedRoot, runtimeAccess);
    }
    // This is the final construction fence for the adapter itself. A factory
    // that rotates escalation.json synchronously cannot return an old-token
    // Telegram adapter paired with a new guard (or with no guard).
    assertRoutingLive?.();
    if (assertRoutingLive) routingGuards?.push(assertRoutingLive);
    assertAdapterConstructionAuthorities(config.adapter, runtimeAccess, proofAuthority, bridgeRoute, scope);
  } catch (error) {
    if (error instanceof EscalationConfigError && error.code === "changed") throw error;
    return null;
  }
  // A synchronous factory cannot interleave a hook, but re-checking protects
  // against factories that mutate marker/root state themselves and ensures a
  // revoked custom registration never escapes as a usable adapter.
  if (!registration.builtin && !liveCustomRegistration(registration, scope.root)) return null;
  if (adapter) {
    // HTTP performs its own pre/post transport fence so an in-flight response
    // cannot be admitted after revocation. Other adapters use the registry
    // wrapper, which applies the same fence to every effectful method.
    if (adapter.kind !== "http") {
      wrapAdapterMethods(adapter, () => assertAdapterEffectAuthoritiesLive(scope.root, runtimeAccess, proofAuthority, bridgeRoute));
    }
    if (!registration.builtin) markAdapterRegistrationLive(adapter, registration, scope.root);
  }
  return adapter;
}

function registrationError(code: "owner_conflict" | "registry_transaction_invalid", error: string): Error & { code: string } {
  const failure = new Error(error) as Error & { code: string };
  failure.code = code;
  return failure;
}

/**
 * Register one consumer transport under an authenticated core transaction.
 * Built-ins are immutable process-wide; consumer transports are isolated by
 * the marker-authenticated canonical root identity that owns their transaction.
 */
export function registerEscalationAdapter(
  token: RegistryRegistrationToken,
  kind: string,
  factory: EscalationAdapterFactory,
  capabilities: EscalationAdapterCapabilities,
): void {
  // Authenticate the opaque token before inspecting caller-provided fields.
  requireRegistryRegistration(token, "escalation_adapters");
  sweepCustomAdapterFactories();
  if (!/^[A-Za-z0-9._-]+$/u.test(kind) || Buffer.byteLength(kind, "utf8") > MAX_CUSTOM_ADAPTER_KIND_BYTES || typeof factory !== "function") {
    throw registrationError("registry_transaction_invalid", "adapter kind or factory is invalid");
  }
  if (
    !capabilities
    || typeof capabilities !== "object"
    || typeof capabilities.canReceiveInbound !== "boolean"
    || typeof capabilities.canSend !== "boolean"
    || typeof capabilities.canSendWithIdempotency !== "boolean"
  ) {
    throw registrationError("registry_transaction_invalid", "adapter capability metadata is required and invalid");
  }
  if (BUILTIN_ADAPTER_KINDS.has(kind.toLowerCase())) {
    throw registrationError("owner_conflict", "adapter kind " + kind + " is permanently reserved by the built-in registry");
  }

  const liveGuard = createRegistryRegistrationLiveGuard(token, "escalation_adapters");
  const registrationRoot = liveGuard();
  const principal = registryRegistrationPrincipal(token, "escalation_adapters");
  const frozen = frozenCapabilities(capabilities);
  const rootKey = adapterRootKey(registrationRoot);
  const registrations = customAdapterFactories.get(rootKey) ?? new Map<string, AdapterRegistration>();
  const existing = registrations.get(kind);
  if (existing) {
    const live = liveCustomRegistration(existing, registrationRoot);
    if (live) {
      if (existing.factory !== factory || !capabilitiesEqual(existing.capabilities, frozen)) {
        throw registrationError("owner_conflict", "adapter kind " + kind + " is already owned and cannot be replaced");
      }
      if (existing.leases?.some((lease) => lease.liveGuard === liveGuard)) return;
      const lease: AdapterRegistrationLease = { principal, liveGuard };
      if (!existing.leases || existing.leases.length >= MAX_CUSTOM_ADAPTER_LEASES_PER_KIND) {
        throw registrationError("registry_transaction_invalid", "custom adapter registration lease capacity exceeded");
      }
      let installed = false;
      recordRegistryUndo(token, () => {
        if (!installed) return;
        const current = registrations.get(kind);
        if (current !== existing || !current.leases) return;
        const index = current.leases.indexOf(lease);
        if (index >= 0) current.leases.splice(index, 1);
        if (current.leases.length === 0 && customAdapterFactories.get(rootKey) === registrations) registrations.delete(kind);
        if (registrations.size === 0 && customAdapterFactories.get(rootKey) === registrations) customAdapterFactories.delete(rootKey);
      });
      existing.leases.push(lease);
      installed = true;
      return;
    }
    registrations.delete(kind);
  }
  const totalRegistrations = [...customAdapterFactories.values()].reduce((total, entries) => total + entries.size, 0);
  if (!customAdapterFactories.has(rootKey) && customAdapterFactories.size >= MAX_CUSTOM_ADAPTER_ROOTS) {
    throw registrationError("registry_transaction_invalid", "custom adapter registry root capacity exceeded");
  }
  if (registrations.size >= MAX_CUSTOM_ADAPTER_KINDS_PER_ROOT || totalRegistrations >= MAX_CUSTOM_ADAPTER_REGISTRATIONS) {
    throw registrationError("registry_transaction_invalid", "custom adapter registry capacity exceeded");
  }
  const inserted: AdapterRegistration = {
    factory,
    capabilities: frozen,
    builtin: false,
    root: { canonical_root: registrationRoot.canonical_root, root_dev: registrationRoot.root_dev, root_ino: registrationRoot.root_ino },
    leases: [{ principal, liveGuard }],
  };
  let installed = false;
  recordRegistryUndo(token, () => {
    if (!installed) return;
    if (registrations.get(kind) !== inserted) return;
    registrations.delete(kind);
    if (registrations.size === 0 && customAdapterFactories.get(rootKey) === registrations) customAdapterFactories.delete(rootKey);
  });
  customAdapterFactories.set(rootKey, registrations);
  registrations.set(kind, inserted);
  installed = true;
}

function adapterHasInboundSurface(adapter: EscalationAdapter): boolean {
  return typeof adapter.pollOnce === "function" || typeof adapter.setPlainMessageHandler === "function";
}

function adapterMatchesCapabilities(adapter: EscalationAdapter, capabilities: EscalationAdapterCapabilities): boolean {
  if (typeof adapter.send !== "function" || typeof adapter.cancel !== "function") return false;
  if (typeof adapter.sendWithIdempotency !== "function" || !capabilities.canSendWithIdempotency) return false;
  if (capabilities.canSend && typeof adapter.send !== "function") return false;
  if (capabilities.canReceiveInbound && !adapterHasInboundSurface(adapter)) return false;
  return true;
}

function configuredAdapterKinds(config: NormalizedEscalationConfig | null): string[] {
  if (!config) return [];
  const kinds = config.channels?.map((entry) => entry.adapter) ?? (config.adapter ? [config.adapter] : []);
  return [...new Set(kinds)];
}

/**
 * Combine caller-provided capabilities with the registry's claims. Registered
 * claims win over a caller override, so a consumer cannot accidentally
 * upgrade a transport beyond the methods it registered. Once a table exists,
 * every configured but unclaimed kind gets the conservative push-only default;
 * this preserves the core fail-closed rule for custom transports.
 */
function channelCapabilitiesFor(
  config: NormalizedEscalationConfig | null,
  supplied: Record<string, ChannelCapabilities> | undefined,
  scope: AdapterResolutionScope,
  adapterKinds: readonly string[],
): Record<string, ChannelCapabilities> | undefined {
  const registered: Record<string, ChannelCapabilities> = {};
  for (const kind of adapterKinds) {
    const registration = registrationForKind(kind, scope);
    if (registration?.capabilities) registered[kind] = registration.capabilities;
  }
  if (supplied === undefined && Object.keys(registered).length === 0) return undefined;
  const merged: Record<string, ChannelCapabilities> = { ...(supplied ?? {}), ...registered };
  for (const kind of configuredAdapterKinds(config)) {
    if (!(kind in merged)) merged[kind] = { canReceiveInbound: false, canSend: true, canSendWithIdempotency: false };
  }
  return merged;
}

/** Read one exact-kind escalation projection through the authenticated facade. */
export function loadEscalationConfig(cwd: string, options: { pinnedRoot?: PinnedProjectRoot; runtimeAccess?: RuntimeAccess; kind?: string } = {}): EscalationConfig | null {
  if (!options.runtimeAccess || typeof options.kind !== "string" || options.kind.length === 0) return null;
  const scope = openAdapterResolutionScope(cwd, options.pinnedRoot);
  if (!scope) return null;
  try {
    assertRuntimeScope(options.runtimeAccess, scope);
    const projections = options.runtimeAccess.resolveEscalationChannelConfigs(options.kind);
    if (!Array.isArray(projections) || projections.length !== 1) return null;
    const projected = projections[0];
    if (!projected || projected.adapter !== options.kind) return null;
    assertRuntimeScope(options.runtimeAccess, scope);
    return projected as EscalationConfig;
  } catch {
    return null;
  } finally {
    closeAdapterResolutionScope(scope);
  }
}

/** Build the configured adapter; null when the config is unusable. */
export function createEscalationAdapter(config: EscalationConfig, cwd: string, pinnedRoot: PinnedProjectRoot | undefined, runtimeAccess: RuntimeAccess, proofAuthority: CtoRuntimeProofAuthority, bridgeRoute?: CtoRuntimeBridgeRouteAccess): EscalationAdapter | null;
export function createEscalationAdapter(config: EscalationConfig, cwd: string, pinnedRoot: PinnedProjectRoot | undefined, runtimeAccess: undefined, proofAuthority: CtoRuntimeProofAuthority, bridgeRoute: CtoRuntimeBridgeRouteAccess): EscalationAdapter | null;
export function createEscalationAdapter(config: EscalationConfig, cwd: string, pinnedRoot: PinnedProjectRoot | undefined, runtimeAccess: RuntimeAccess | undefined, proofAuthority: CtoRuntimeProofAuthority, bridgeRoute?: CtoRuntimeBridgeRouteAccess): EscalationAdapter | null {
  if (!config || typeof config.adapter !== "string") return null;
  const scope = openAdapterResolutionScope(cwd, pinnedRoot);
  if (!scope) return null;
  try {
    if (bridgeRoute) {
      bridgeRoute.assertLive();
      bridgeRoute.assertProjectRoot(scope.root.canonical_root);
      if (!scope.pinnedRoot.isStable()) return null;
    }
    const registration = registrationForKind(config.adapter, scope);
    const adapter = registration
      ? invokeAdapterFactory(registration, config, scope.root.canonical_root, scope.pinnedRoot, runtimeAccess, scope, proofAuthority, bridgeRoute)
      : null;
    if (adapter && runtimeAccess && !bridgeRoute && !bindEscalationAdapterRouting(adapter, runtimeAccess, scope.pinnedRoot)) return null;
    return adapter;
  } finally {
    closeAdapterResolutionScope(scope);
  }
}

// ── Profile-aware channel sets (resident control-plane) ────────────────────

/**
 * A resolved channel set for one cwd: the normalized profiles, the exact
 * resolved profile (an explicit primary is authoritative; otherwise the
 * first deterministic valid RW profile is selected), the primary adapter,
 * and one adapter per RO profile as an outbound report sink. RO sinks are
 * NEVER wired or polled for inbound (architecture invariant).
 *
 * `legacySingleAdapter` is true when the raw config had NO `channels[]`
 * array (a legacy single-adapter config). The dispatcher loop treats that
 * single RO adapter as the outbound drain target — legacy configs (e.g.
 * `{adapter:"http", http:{url}}`) must keep delivering ALL outbox entries
 * exactly as the pre-channel-set dispatcher did; the capability model only
 * changes WHICH adapter drains, not whether legacy delivery happens.
 */
export interface ChannelSet {
  profiles: ChannelProfile[];
  profile: ChannelProfile;
  primary: EscalationAdapter | null;
  roSinks: EscalationAdapter[];
  legacySingleAdapter: boolean;
}

/**
 * Sink subscriptions attached to RO sink adapters by `createChannelSet`.
 * `drainOutbox` reads them for report routing; adapters not produced here
 * (legacy callers, tests) have no subscriptions -> receive all reports.
 */
const RO_SINK_SUBSCRIPTIONS = Symbol("omp-cto-ro-sink-subscriptions");
const RO_SINK_PROFILE_ID = Symbol("omp-cto-ro-sink-profile-id");
const ADAPTER_ROUTING_BINDING = Symbol("omp-cto-adapter-routing-binding");

type AdapterRoutingMarker = { [ADAPTER_ROUTING_BINDING]?: AdapterRoutingBinding };
function adapterRoutingBinding(adapter: EscalationAdapter): AdapterRoutingBinding | undefined {
  return (adapter as AdapterRoutingMarker)[ADAPTER_ROUTING_BINDING];
}
function markAdapterRoutingBinding(adapter: EscalationAdapter, binding: AdapterRoutingBinding): void {
  Object.defineProperty(adapter, ADAPTER_ROUTING_BINDING, {
    value: Object.freeze({ ...binding }), enumerable: false, configurable: true,
  });
}
/** Stamp a transport with the current authenticated channel routing binding. */
export function bindEscalationAdapterRouting(adapter: EscalationAdapter, runtimeAccess: RuntimeAccess, pinnedRoot: PinnedProjectRoot): boolean {
  try {
    if (!adapter || !runtimeAccess) return false;
    if (adapterRoutingBinding(adapter)) return true;
    const binding = routingBindingForDelivery(runtimeAccess.resolveEscalationChannelSnapshot(), {}, adapterRootFromPinned(pinnedRoot));
    markAdapterRoutingBinding(adapter, binding);
    return true;
  } catch {
    return false;
  }
}
function adapterMatchesRoutingBinding(adapter: EscalationAdapter, binding: AdapterRoutingBinding): boolean {
  const marker = adapterRoutingBinding(adapter);
  if (!marker
    || marker.config_sha256 !== binding.config_sha256
    || marker.snapshot_sha256 !== binding.snapshot_sha256
    || marker.canonical_root !== binding.canonical_root
    || marker.root_dev !== binding.root_dev
    || marker.root_ino !== binding.root_ino
    || (binding.channel === null
      ? marker.channel !== null
      : (typeof marker.channel !== "string" || !binding.channel.split("\u0000").includes(marker.channel)))) return false;
  return binding.target === null ? true : marker.target === binding.target;
}
function sameRoutingBinding(left: AdapterRoutingBinding, right: AdapterRoutingBinding): boolean {
  return left.config_sha256 === right.config_sha256
    && left.snapshot_sha256 === right.snapshot_sha256
    && left.canonical_root === right.canonical_root
    && left.root_dev === right.root_dev
    && left.root_ino === right.root_ino
    && left.channel === right.channel
    && left.target === right.target;
}

/** Adapter-side routing markers set by `createChannelSet` only. */
interface RoSinkMarker {
  [RO_SINK_SUBSCRIPTIONS]?: string[];
  [RO_SINK_PROFILE_ID]?: string;
}

function sinkSubscriptionsOf(sink: EscalationAdapter): string[] | undefined {
  // Trusted marker: attached by createChannelSet; absent on foreign adapters.
  const marked = sink as RoSinkMarker;
  return marked[RO_SINK_SUBSCRIPTIONS];
}

function sinkProfileIdOf(sink: EscalationAdapter): string {
  // A profile id is stable across config reorder/insertion. Foreign adapters
  // have no profile marker, so retain a deterministic kind-based fallback
  // rather than reviving the old positional index.
  const marked = sink as RoSinkMarker;
  return marked[RO_SINK_PROFILE_ID] ?? sink.kind;
}
/**
 * Resolve `.omp/escalation.json` into a channel set (see {@link ChannelSet}).
 * It builds and validates exactly one explicit primary and capability metadata
 * for every configured custom transport. A custom declaration without metadata
 * is blocked for both read-write and read-only directions; it is never silently
 * downgraded or accepted as a sink.
 * No profiles -> `{ profiles: [], profile: {direction:"none"}, primary: null, roSinks: [] }`.
 */
export function createChannelSet(cwd: string, capabilities: Record<string, ChannelCapabilities> | undefined, pinnedRoot: PinnedProjectRoot | undefined, runtimeAccess: RuntimeAccess | undefined, proofAuthority: CtoRuntimeProofAuthority): ChannelSet {
  if (pinnedRoot && !pinnedRoot.isStable()) throw new EscalationConfigError("changed", "escalation channel root changed before construction");
  if (!runtimeAccess) return { profiles: [], profile: { direction: "none" }, primary: null, roSinks: [], legacySingleAdapter: false };
  const scope = openAdapterResolutionScope(cwd, pinnedRoot);
  if (!scope) throw new EscalationConfigError("changed", "escalation channel root could not be pinned safely");
  try {
  const projections: Array<Record<string, unknown>> = [];
  let adapterKinds: readonly string[];
  let resolvedRoutingSnapshot: ReturnType<CtoRuntimeAccessFacade["resolveEscalationChannelSnapshot"]> | undefined;
  try {
    assertRuntimeScope(runtimeAccess, scope);
    const snapshot = runtimeAccess.resolveEscalationChannelSnapshot();
    resolvedRoutingSnapshot = snapshot;
    assertRuntimeScope(runtimeAccess, scope);
    if (!snapshot || snapshot.status === "absent") {
      return { profiles: [], profile: { direction: "none" }, primary: null, roSinks: [], legacySingleAdapter: false };
    }
    if (snapshot.status === "invalid") {
      const detail = `${snapshot.code}: ${snapshot.reason}`;
      throw new EscalationConfigError("invalid_primary", "escalation channel configuration is invalid (" + detail + ")");
    }
    if (snapshot.status !== "valid" || !Array.isArray(snapshot.kinds) || !snapshot.projections || typeof snapshot.projections !== "object") {
      throw new EscalationConfigError("invalid_primary", "escalation channel configuration is unavailable");
    }
    adapterKinds = Object.freeze([...snapshot.kinds]);
    for (const kind of adapterKinds) {
      const kindProjections = snapshot.projections[kind];
      if (!Array.isArray(kindProjections)) {
        throw new EscalationConfigError("invalid_primary", "escalation channel projections are invalid");
      }
      for (const projected of kindProjections) {
        if (!projected || typeof projected !== "object" || Array.isArray(projected)
          || projected.adapter !== kind || Object.hasOwn(projected, "channels")) {
          throw new EscalationConfigError("invalid_primary", "escalation channel projection is invalid");
        }
        projections.push(projected as Record<string, unknown>);
      }
    }
  } catch (error) {
    if (error instanceof EscalationConfigError) throw error;
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "runtime_access_invalid") throw new EscalationConfigError("invalid_primary", "escalation channel configuration is invalid");
    throw new EscalationConfigError("changed", "escalation channel activation is no longer live");
  }
  if (projections.length === 0) return { profiles: [], profile: { direction: "none" }, primary: null, roSinks: [], legacySingleAdapter: false };
  const explicitFlags = projections.map((projection) => projection.direction === "read-write" || projection.direction === "read-only");
  if (explicitFlags.some((flag) => flag !== explicitFlags[0])) {
    throw new EscalationConfigError("invalid_primary", "escalation channel projections have inconsistent declaration shapes");
  }
  const explicitChannels = explicitFlags[0] === true;
  if (!explicitChannels && projections.length !== 1) {
    throw new EscalationConfigError("invalid_primary", "legacy escalation configuration resolved to multiple adapters");
  }
  const channels = explicitChannels ? projections : null;
  const config: EscalationConfig | null = (explicitChannels ? { channels: projections } : projections[0] ?? null) as EscalationConfig | null;
  const effectiveCapabilities = channelCapabilitiesFor(config as NormalizedEscalationConfig | null, capabilities, scope, adapterKinds);
  const normalized = normalizeChannelConfigResult(config, effectiveCapabilities);
  if (normalized.status === "invalid") {
    throw new EscalationConfigError(
      "invalid_primary",
      "escalation channel configuration is invalid (" + normalized.code + "): " + normalized.reason,
    );
  }
  const profiles = normalized.status === "valid" ? normalized.profiles : [];
  const legacyKind = channels === null && typeof config?.adapter === "string" ? config.adapter : undefined;
  const legacyDeclaredRw = channels === null
    && typeof config?.adapter === "string"
    && (config.adapter === "telegram" || config.bidirectional === true);
  const registeredWithoutMetadata = profiles.find((profile) => {
    const kind = profile.adapter ?? profile.transport;
    return Boolean(kind && registrationForKind(kind, scope)?.capabilities === undefined && registrationForKind(kind, scope) !== undefined);
  });
  if (registeredWithoutMetadata) {
    const kind = registeredWithoutMetadata.adapter ?? registeredWithoutMetadata.transport ?? "unknown";
    throw new EscalationConfigError(
      "invalid_primary",
      `configured channel "${kind}" requires explicit capability metadata including durable idempotent delivery`,
    );
  }
  if (legacyDeclaredRw) {
    const registration = legacyKind === undefined ? undefined : registrationForKind(legacyKind, scope);
    const metadata = registration?.capabilities;
    if (!metadata || !metadata.canReceiveInbound || !metadata.canSend || !metadata.canSendWithIdempotency) {
      throw new EscalationConfigError(
        "invalid_primary",
        `configured read-write primary "${legacyKind ?? "unknown"}" requires explicit inbound, outbound, and idempotency capability metadata`,
      );
    }
  }
  const rawPrimaryEntries = channels?.filter((entry) => entry.primary === true) ?? [];
  const rawChannelCounts = new Map<string, number>();
  for (const entry of channels ?? []) {
    const adapter = typeof entry.adapter === "string" ? entry.adapter : "";
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const key = `${adapter}\u0000${id}`;
    rawChannelCounts.set(key, (rawChannelCounts.get(key) ?? 0) + 1);
  }
  const hasDuplicateRawChannel = [...rawChannelCounts.values()].some((count) => count > 1);
  if (
    hasDuplicateRawChannel
    || rawPrimaryEntries.length > 1
    || rawPrimaryEntries.some((entry) => entry.direction !== "read-write")
  ) {
    throw new EscalationConfigError(
      "invalid_primary",
      "escalation channel declarations contain duplicate entries or invalid primary markers",
    );
  }
  const markedPrimaries = channels === null ? [] : profiles.filter((profile) => profile.primary === true);
  const legacySingleAdapter = channels === null;
  const entryFor = (profile: ChannelProfile): Record<string, unknown> | null => {
    const kind = profile.adapter ?? profile.transport;
    if (!channels || !kind) return config;
    // Profile-aware binding (static-2): an explicit entry with an id binds
    // by THAT id — two same-kind channels with distinct ids get distinct
    // per-entry configs. An id-less profile (a single id-less entry per
    // kind survives the normalizer's ambiguity rejection) binds to the
    // id-less entry of its kind, never to a same-kind id-ful entry.
    if (typeof profile.id === "string" && profile.id.length > 0) {
      return channels.find((candidate) =>
        candidate
        && candidate.adapter === kind
        && typeof candidate.id === "string"
        && candidate.id.trim() === profile.id
      ) ?? null;
    }
    return channels.find((candidate) =>
      candidate
      && candidate.adapter === kind
      && !(typeof candidate.id === "string" && candidate.id.trim().length > 0)
    ) ?? null;
  };
  const missingRegistration = profiles.find((profile) => {
    const kind = profile.adapter ?? profile.transport;
    return typeof kind !== "string" || registrationForKind(kind, scope) === undefined;
  });
  if (missingRegistration) {
    const kind = missingRegistration.adapter ?? missingRegistration.transport ?? "unknown";
    throw new EscalationConfigError(
      "invalid_primary",
      `configured channel "${kind}" has no registered adapter factory`,
    );
  }
  const telegramRoutingGuards: Array<() => void> = [];
  const build = (profile: ChannelProfile): { adapter: EscalationAdapter | null; capabilityMismatch: boolean } => {
    const kind = profile.adapter ?? profile.transport;
    if (!kind) return { adapter: null, capabilityMismatch: false };
    const registration = registrationForKind(kind, scope);
    if (!registration) return { adapter: null, capabilityMismatch: false };
    const entry = entryFor(profile);
    if (!entry) return { adapter: null, capabilityMismatch: false };
    try {
      const adapter = invokeAdapterFactory(
        registration,
        entry as EscalationConfig,
        scope.root.canonical_root,
        scope.pinnedRoot,
        runtimeAccess,
        scope,
        proofAuthority,
        undefined,
        resolvedRoutingSnapshot,
        telegramRoutingGuards,
      );
      if (!adapter) return { adapter: null, capabilityMismatch: false };
      if (!registration.capabilities) return { adapter, capabilityMismatch: false };
      const usable = typeof adapter.send === "function" && typeof adapter.cancel === "function";
      return {
        adapter: usable ? adapter : null,
        capabilityMismatch: usable && !adapterMatchesCapabilities(adapter, registration.capabilities),
      };
    } catch (error) {
      if (error instanceof EscalationConfigError && error.code === "changed") throw error;
      return { adapter: null, capabilityMismatch: false };
    }
  };
  const builds = profiles.map(build);
  // Revalidate every Telegram adapter after all factories have completed: a
  // later factory is allowed to rotate config, but the set must not return a
  // Telegram primary built from a stale token/chat projection.
  for (const guard of telegramRoutingGuards) {
    try {
      guard();
    } catch (error) {
      throw new EscalationConfigError("changed", String(error instanceof Error ? error.message : error));
    }
  }
  const unusableAnnotated = profiles.find((profile, index) => {
    const kind = profile.adapter ?? profile.transport;
    const registration = kind ? registrationForKind(kind, scope) : undefined;
    return Boolean(
      registration?.capabilities
      && (builds[index]?.adapter === null || builds[index]?.capabilityMismatch),
    );
  });
  if (unusableAnnotated) {
    const kind = unusableAnnotated.adapter ?? unusableAnnotated.transport ?? "unknown";
    throw new EscalationConfigError(
      "invalid_primary",
      `configured channel "${kind}" does not expose the registered durable idempotent delivery capabilities`,
    );
  }
  const unusableConfigured = profiles.find((profile, index) => builds[index]?.adapter === null);
  if (unusableConfigured) {
    const kind = unusableConfigured.adapter ?? unusableConfigured.transport ?? "unknown";
    throw new EscalationConfigError(
      "invalid_primary",
      `configured channel "${kind}" could not be constructed`,
    );
  }
  const invalidExplicitRw = channels === null
    ? []
    : channels.filter((entry) => {
      if (!entry || entry.direction !== "read-write" || typeof entry.adapter !== "string") return false;
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const index = profiles.findIndex((profile) =>
        (profile.adapter ?? profile.transport) === entry.adapter
        && (profile.id ?? "") === id
      );
      if (index < 0) return true;
      const profile = profiles[index]!;
      const buildResult = builds[index]!;
      return profile.direction !== "rw"
        || buildResult.adapter === null
        || buildResult.capabilityMismatch;
    });
  if (invalidExplicitRw.length > 0) {
    const kind = typeof invalidExplicitRw[0]?.adapter === "string" ? invalidExplicitRw[0].adapter : "unknown";
    throw new EscalationConfigError(
      "invalid_primary",
      `configured read-write channel "${kind}" has no usable inbound and outbound adapter`,
    );
  }
  if (markedPrimaries.length > 1) {
    assertRuntimeScope(runtimeAccess, scope);
    return { profiles: [], profile: { direction: "none" }, primary: null, roSinks: [], legacySingleAdapter: false };
  }
  if (profiles.length === 0) {
    assertRuntimeScope(runtimeAccess, scope);
    return { profiles: [], profile: { direction: "none" }, primary: null, roSinks: [], legacySingleAdapter: false };
  }
  const sameProfile = (left: ChannelProfile, right: ChannelProfile): boolean =>
    (left.adapter ?? left.transport) === (right.adapter ?? right.transport)
    && left.id === right.id;
  const resolvedProfile = (() => {
    const marked = profiles.filter((profile) => profile.primary === true);
    if (marked.length > 1) return { direction: "none" as const };
    return marked[0] ?? profiles.find((profile) => profile.direction === "rw") ?? profiles.find((profile) => profile.direction === "ro") ?? { direction: "none" as const };
  })();
  const resolvedIndex = profiles.findIndex((profile) => sameProfile(profile, resolvedProfile));
  const resolvedBuild = resolvedIndex >= 0 ? builds[resolvedIndex]! : null;
  const hasMarkedPrimary = markedPrimaries.length === 1;
  const markedPrimaryConfig = channels?.find((candidate) => candidate?.primary === true);
  const markedPrimaryDeclaredRw = markedPrimaryConfig?.direction === "read-write";
  if (
    hasMarkedPrimary
    && (
      resolvedIndex < 0
      || resolvedProfile.direction !== "rw"
      || resolvedBuild?.adapter === null
      || resolvedBuild?.adapter === undefined
      || resolvedBuild.capabilityMismatch
    )
  ) {
    // A marked primary is never replaced by another transport. An explicitly
    // declared RW primary that cannot be capability-validated or constructed
    // is a configuration block, not an RO fallback (which would leave ask
    // interactive or queue undeliverable ACKs).
    if (!legacySingleAdapter && markedPrimaryDeclaredRw) {
      const kind = typeof markedPrimaryConfig?.adapter === "string" ? markedPrimaryConfig.adapter : "unknown";
      throw new EscalationConfigError(
        "invalid_primary",
        `configured read-write primary "${kind}" cannot be constructed with inbound and outbound capabilities`,
      );
    }
    assertRuntimeScope(runtimeAccess, scope);
    return { profiles: [], profile: { direction: "none" }, primary: null, roSinks: [], legacySingleAdapter: false };
  }
  const validRw = profiles
    .map((profile, index) => ({ profile, index, build: builds[index]! }))
    .filter(({ profile, build }) => profile.direction === "rw" && build.adapter !== null && !build.capabilityMismatch);
  const primaryIndex = hasMarkedPrimary
    ? resolvedIndex
    : (
      resolvedProfile.direction === "rw"
      && resolvedIndex >= 0
      && resolvedBuild?.adapter !== null
      && !resolvedBuild?.capabilityMismatch
        ? resolvedIndex
        : (validRw[0]?.index ?? -1)
    );
  const resolvedProfiles = profiles.map((profile, index) =>
    profile.direction === "rw" && builds[index]?.capabilityMismatch
      ? { ...profile, direction: "ro" as const }
      : profile,
  );
  const validRo = resolvedProfiles
    .map((profile, index) => ({ profile, index, adapter: builds[index]?.adapter ?? null }))
    .filter(({ profile, adapter, index }) => profile.direction === "ro" && adapter !== null && index !== primaryIndex);
  const selectedRoIndex = primaryIndex >= 0 ? -1 : (
    resolvedProfile.direction === "ro"
      && resolvedIndex >= 0
      && resolvedProfiles[resolvedIndex]?.direction === "ro"
      && builds[resolvedIndex]?.adapter !== null
      ? resolvedIndex
      : (validRo[0]?.index ?? -1)
  );
  const roSinks = resolvedProfiles
    .map((profile, index) => {
      if (index === primaryIndex || profile.direction !== "ro") return null;
      const sink = builds[index]?.adapter ?? null;
      if (sink) {
        const profileId = profile.id ?? profile.adapter ?? profile.transport ?? sink.kind;
        Object.defineProperties(sink, {
          [RO_SINK_SUBSCRIPTIONS]: { value: profile.subscriptions, enumerable: false, configurable: true },
          [RO_SINK_PROFILE_ID]: { value: profileId, enumerable: false, configurable: true },
        });
      }
      return sink;
    })
    .filter((adapter): adapter is EscalationAdapter => adapter !== null);
  const primary = primaryIndex >= 0 ? builds[primaryIndex]?.adapter ?? null : null;
  const selectedIndex = primaryIndex >= 0 ? primaryIndex : selectedRoIndex;
  const profile = selectedIndex >= 0
    ? resolvedProfiles[selectedIndex]!
    : resolvedIndex >= 0
      ? resolvedProfiles[resolvedIndex]!
      : resolvedProfile;
  if (!resolvedRoutingSnapshot) throw new EscalationConfigError("changed", "escalation routing snapshot was not captured");
  const primaryProfile = primaryIndex >= 0 ? resolvedProfiles[primaryIndex] : undefined;
  if (primary && primaryProfile) markAdapterRoutingBinding(primary, routingBindingForProfile(resolvedRoutingSnapshot, primaryProfile, adapterRootFromPinned(scope.pinnedRoot)));
  for (const sink of roSinks) {
    const sinkIndex = resolvedProfiles.findIndex((candidate, index) => index !== primaryIndex && builds[index]?.adapter === sink);
    const sinkProfile = sinkIndex >= 0 ? resolvedProfiles[sinkIndex] : undefined;
    if (sinkProfile) markAdapterRoutingBinding(sink, routingBindingForProfile(resolvedRoutingSnapshot, sinkProfile, adapterRootFromPinned(scope.pinnedRoot)));
  }
  assertRuntimeScope(runtimeAccess, scope);
  if (pinnedRoot && !pinnedRoot.isStable()) throw new EscalationConfigError("changed", "escalation channel root changed during construction");
  return {
    profiles: resolvedProfiles,
    profile,
    primary,
    roSinks,
    legacySingleAdapter,
  };
  } finally {
    closeAdapterResolutionScope(scope);
  }
}

/**
 * True when the resolved channel is a validated RW primary. Building the
 * channel set here also rejects a registered RW claim whose factory does not
 * expose the claimed inbound surface.
 */
export function isBidirectionalChannel(cwd: string, capabilities: Record<string, ChannelCapabilities> | undefined, pinnedRoot: PinnedProjectRoot | undefined, runtimeAccess: RuntimeAccess | undefined, proofAuthority: CtoRuntimeProofAuthority): boolean {
  const set = createChannelSet(cwd, capabilities, pinnedRoot, runtimeAccess, proofAuthority);
  return set.profile.direction === "rw" && set.primary !== null;
}

/**
 * True when a persisted wave record has every field the canonical
 * `buildCtoTerminalSummaryEnvelope` builder reads (malformed records are
 * skipped, never summarized). Persisted state is UNTRUSTED at this boundary
 * (agent-written/corrupt): only closed waves with a valid completion
 * timestamp may be summarized.
 */
function terminalSummaryEnvelope(state: StateView, wave: RuntimeWaveView): CtoDelivery {
  const excerpt = wave.task.trim().slice(0, 200);
  const counts: Record<string, number> = {};
  for (const team of state.teams ?? []) counts[team.status] = (counts[team.status] ?? 0) + 1;
  const teamSummary = Object.entries(counts).map(([status, count]) => String(count) + " " + status).sort().join(", ") || "0 teams";
  const lines = [
    "Run " + state.id + ": wave " + wave.id + " " + wave.status + ".",
    "Started: " + wave.started_at + "; finished: " + wave.finished_at + ".",
    "Task: \"" + excerpt + "\"",
    "Teams: " + teamSummary + ".",
  ];
  if (state.integration?.status) lines.push("Integration: " + state.integration.status + ".");
  const id = state.id + "/wave/" + wave.id + "/summary";
  const revision = state.state_revision;
  const stateRevision = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  return {
    id, level: "question", title: "CTO wave complete", body: lines.join("\n"), intent: "summary", topic: "summary",
    at: wave.finished_at, by: "cto", run_id: state.id,
    state_revision: stateRevision,
    wave_id: wave.id, idempotency_key: id,
  };
}

function deterministicTerminalSummary(state: StateView, envelopeId: string, bytes: Buffer): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(decodeUtf8(bytes)); } catch { return false; }
  if (!isReadonlyRecord(parsed)) return false;
  const parts = envelopeId.split("/");
  if (parts.length !== 4 || parts[0] !== state.id || parts[1] !== "wave" || parts[3] !== "summary" || !isSafeCtoRunId(parts[2] ?? "")) return false;
  const wave = (state.wave_history ?? []).find((candidate) => candidate && candidate.id === parts[2]);
  if (!wave || !isSummarizableWave(wave)) return false;
  const expected = terminalSummaryEnvelope(state, wave);
  const value = parsed;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(value).sort();
  return expectedKeys.length === actualKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index] && value[key] === ownDeliveryValue(expected, key))
    && bytes.equals(Buffer.from(JSON.stringify(expected)));
}

function isSummarizableWave(wave: unknown): wave is RuntimeWaveView {
  if (!isReadonlyRecord(wave)) return false;
  const sliceIds = wave.slice_ids;
  return (
    typeof wave.id === "string" && wave.id.length > 0 &&
    typeof wave.source === "string" &&
    typeof wave.source_id === "string" &&
    typeof wave.task === "string" &&
    (wave.status === "done" || wave.status === "failed") &&
    typeof wave.started_at === "string" &&
    typeof wave.finished_at === "string" && Number.isFinite(Date.parse(wave.finished_at)) &&
    Array.isArray(sliceIds) && sliceIds.every((sliceId) => typeof sliceId === "string")
  );
}

/**
 * Produce wave-completion summary deliveries (RW outbound producer).
 *
 * Scans every run from the authenticated runtime delivery index and, for each wave record
 * with a completion timestamp, durably queues one deterministic wave-summary entry (intent summary,
 * level question; the only non-blocking core level; topic summary). Waves without a completion
 * timestamp (still active) are NEVER summarized.
 *
 * Guarded: a config with NO profiles at all (no `.omp/escalation.json`, or
 * one that resolves to zero channels) queues nothing. RO-only configs DO
 * queue summaries — `drainOutbox` delivers them to the RO sinks (the
 * permitted report fan-out; RO never becomes an inbound/answer source).
 *
 * Receiver-side idempotency is keyed by the canonical delivery id; the
 * workspace `sent/` archive is cleanup evidence only. Called from the
 * dispatcher tick BEFORE `drainOutbox` so the first tick after a wave
 * finishes both queues AND drains it.
 *
 * Returns the number of NEW deliveries queued (0 on re-runs). Never throws.
 */
export function produceWaveDeliveries(root: string, opts: { isOwned?: () => boolean; runEntries?: readonly CtoRunDeliveryIndexEntry[]; pinnedRoot?: PinnedProjectRoot; runtimeAccess?: RuntimeAccess; serviceAuthority?: RuntimeServiceAuthority; maxNewDeliveries?: number; proofAuthority: CtoRuntimeProofAuthority }): number {
  try {
    const maxNewDeliveries = opts.maxNewDeliveries === undefined
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(opts.maxNewDeliveries) && opts.maxNewDeliveries >= 0
        ? Math.floor(opts.maxNewDeliveries)
        : 0;
    if (maxNewDeliveries === 0) return 0;
    const channelSet = createChannelSet(root, undefined, opts.pinnedRoot, opts.runtimeAccess, opts.proofAuthority);
    if (channelSet.profiles.length === 0) return 0;
    let queued = 0;
    for (const entry of indexedRunEntriesOrRead(root, opts.runEntries, opts.pinnedRoot, opts.runtimeAccess)) {
      try {
        if (opts.isOwned && !opts.isOwned()) break;
      const runId = entry.run_id;
      const state = runtimeState(opts.runtimeAccess, runId);
      if (!state || !stateMatchesRunDeliveryIndex(state, entry)) continue;
      const history = state.wave_history;
      if (!Array.isArray(history)) continue;
      for (const wave of history) {
        if (opts.isOwned && !opts.isOwned()) break;
        if (!isSummarizableWave(wave)) continue;
        if (state.terminal_summary_evidence?.some((evidence) => evidence.wave_id === wave.id)) continue;
        const delivery = queueCtoDelivery(root, runId, terminalSummaryEnvelope(state, wave), opts.pinnedRoot, opts.isOwned, opts.runtimeAccess);
        if (delivery) {
          queued += 1;
          if (queued >= maxNewDeliveries) break;
        }
      }
      if (queued >= maxNewDeliveries) break;
      } catch {
        // One corrupt run cannot starve later entries in the bounded page.
        continue;
      }
    }
    return queued;
  } catch {
    return 0;
  }
}

/**
 * Drain the outbox: for every `.work-state/cto/<runId>/outbox/*.json` that
 * is a valid escalation, sanitize (R4), send via the adapter, and move the
 * file to `sent/` on success. Returns the send results. Never throws.
 *
 * The additive 4th param enables RO report routing: after the primary send
 * path, each SUCCESSFULLY-sent entry with `intent === "summary"` is
 * best-effort fanned out to every RO sink — a sink with `subscriptions[]`
 * receives the entry only when its `topic` is subscribed, a sink without
 * subscriptions receives all reports. Sink sends use `adapter.send(esc)`
 * (http has no sendPlainText); sink failures never fail the primary result
 * and are recorded on the result entry as `sinkErrors`. Existing callers
 * pass no opts -> no routing, behavior unchanged.
 *
 * RO-only delivery (no primary): when `adapter` is null but RO sinks are
 * given, `summary` entries are delivered directly to the sinks. Delivery is
 * HONEST about what actually happened:
 *   - every attempted sink failed (`failed === attempted > 0`) → reported
 *     `sent:false` with `error: "all ro sinks failed"` + `sinkErrors` and
 *     LEFT in the outbox (pending/retryable — the next drain retries it);
 *   - at least one attempted sink succeeded → archived to `sent/` as
 *     `sent:true`, partial sink failures recorded as `sinkErrors`;
 *   - every sink subscription-skipped the topic (`attempted === 0`) →
 *     honest no-op: archived as `sent:true` with NO `sinkErrors`.
 * Non-report entries cannot be delivered without a validated RW primary —
 * they are reported `sent:false` with
 * `"no rw primary to deliver non-report entry"` and LEFT in place so a
 * later drain with a primary (restart/recovery) still delivers them.
 * When both adapter and sinks are absent the outbox is untouched (the
 * historical null-adapter early return).
 */
export interface DrainOutboxResult {
  /** Exact indexed run that produced this result; never inferred from escId. */
  runId: string;
  escId: string;
  sent: boolean;
  error?: string;
  /** Best-effort RO sink send failures (summary routing); primary still sent. */
  sinkErrors?: string[];
  /** This run was not attempted because the bounded tick deadline expired. */
  notAttemptedDeadline?: boolean;
}

export async function drainOutbox(
  root: string,
  adapter: EscalationAdapter | null,
  maxRetries = 3,
  opts: {
    roSinks?: EscalationAdapter[];
    requireIdempotency?: boolean;
    isOwned?: () => boolean;
    pinnedRoot?: PinnedProjectRoot;
    runEntries?: readonly CtoRunDeliveryIndexEntry[];
    runtimeAccess?: RuntimeAccess;
    now?: RetryClock;
    outboxEntry?: { runId: string; name: string };
    lifecycle?: AdapterOperationContext;
    retryCursorStore?: Map<string, string | null>;
    retryMatchStateStore?: Map<string, unknown>;
    retryMatchCursorStore?: Map<string, string | null>;
    proofAuthority: CtoRuntimeProofAuthority;
  },
): Promise<DrainOutboxResult[]> {
  const roSinks = opts.roSinks ?? [];
  if (!validDrainInputList(opts.roSinks, MAX_DRAIN_RO_SINKS)
    || !validDrainRunEntries(opts.runEntries)) return [];
  if (!opts.runtimeAccess) return [];
  if (!adapter && roSinks.length === 0) return [];
  maxRetries = boundedRetryCount(maxRetries);
  if (maxRetries === 0) return [];
  const suppliedPin = opts.pinnedRoot;
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot || !pinnedRoot.isStable()) {
    if (!suppliedPin) pinnedRoot?.close();
    return [];
  }
  // Keep the same descriptor anchor through every adapter send. In particular,
  // a Telegram request may await the network while the lexical root is swapped.
  opts = { ...opts, pinnedRoot };
  const directOutboxEntry = opts.outboxEntry;
  const drainFence: MutationFence = { pinnedRoot, runtimeAccess: opts.runtimeAccess, lifecycle: opts.lifecycle };
  try {
    assertMutationLive(drainFence);
  const results: DrainOutboxResult[] = [];
  for (const runEntry of indexedRunEntriesOrRead(root, opts.runEntries, pinnedRoot, opts.runtimeAccess)) {
    try {
      if (opts.isOwned && !opts.isOwned()) break;
      const runId = runEntry.run_id;
      const directEntryForRun = directOutboxEntry?.runId === runId ? directOutboxEntry : undefined;
      const state = runtimeState(opts.runtimeAccess, runId);
      assertMutationLive(drainFence);
      if (!state) {
        if (directEntryForRun) quarantineDirectOutboxEntryIfInvalid(root, runId, directEntryForRun.name, runEntry.state_revision, "missing", pinnedRoot, opts.lifecycle, opts.runtimeAccess);
        continue;
      }
      const terminalRun = terminalState(state);
      if (!stateRevisionMatches(state, runEntry)) continue;
      if (terminalRun && directEntryForRun) {
        quarantineDirectOutboxEntry(root, runId, directEntryForRun.name, "terminal", pinnedRoot, opts.lifecycle, opts.runtimeAccess);
        continue;
      }

      // Removing one archived obligation commits a state revision. Keep the
      // page bound to the latest revision produced by this drain so later
      // entries remain current without accepting an arbitrary stale revision.
      let currentStateRevision = runEntry.state_revision;
      if (!runEntry.pending_outbox && !runEntry.pending_retry) {
        if (directEntryForRun) quarantineDirectOutboxEntryIfInvalid(root, runId, directEntryForRun.name, runEntry.state_revision, "unpublished", pinnedRoot, opts.lifecycle, opts.runtimeAccess);
        continue;
      }
      const activeDirectory = join(".work-state", "cto", runId, "outbox");
      const retryDirectory = join(".work-state", "cto", runId, "outbox-retry");
      const rejectedDirectory = join(".work-state", "cto", runId, "outbox-rejected");
      const outboxQueue = openBoundedQueue(pinnedRoot.canonical_root, activeDirectory, { ...ACTIVE_QUEUE_OPTIONS, pinnedRoot });
      if (!outboxQueue) continue;
      const moveToRetry = (entryName: string, immediateFirstRetry = false): boolean => moveRetryableEntry(
        root,
        outboxQueue,
        entryName,
        retryDirectory,
        retryClockNow(opts.now),
        runId,
        currentStateRevision,
        pinnedRoot,
        immediateFirstRetry,
        opts.runtimeAccess,
        drainFence,
        opts.retryMatchStateStore,
      );
      let rejectedDuringPromotion = false;
      const removeArchivedObligation = (entryName: string, storedBytes: Uint8Array): void => {
        const nextRevision = removeArchivedOutboxObligation(opts.runtimeAccess!, runId, entryName, storedBytes, currentStateRevision, drainFence);
        if (nextRevision !== null) currentStateRevision = nextRevision;
      };
      const clearRejectedEvidenceAfterSuccess = (): void => {
        if (rejectedDuringPromotion || results.some((result) => result.runId === runId && !result.sent)) return;
        clearOutboxRejectedEvidence(root, runId, pinnedRoot, drainFence);
      };
      try {
        if (runEntry.pending_retry || !queueHasActiveWork(outboxQueue, "sent")) {
          // A retry marker is an additive recovery obligation; attempt
          // promotion even when another active entry is present.
          promoteRetryEntries(root, activeDirectory, retryDirectory, rejectedDirectory, "outbox", retryClockNow(opts.now), pinnedRoot, undefined, opts.runtimeAccess, opts.lifecycle, runId, currentStateRevision, (entryName, reason) => { rejectedDuringPromotion = true; results.push({ runId, escId: entryName, sent: false, error: reason }); }, opts.retryCursorStore, opts.retryMatchStateStore);
        }
        let activeWork = 0;
        // The active queue is itself bounded to one page. Rotate that page
        // across ticks so promoted retries cannot occupy the same lexical
        // prefix forever and starve canonical work later in the directory.
        const activeMatchCursorKey = runId + "\u0000" + activeDirectory;
        const activeMatchCursor = opts.retryMatchCursorStore?.get(activeMatchCursorKey) ?? null;
        const directEntryName = directEntryForRun?.name;
        // A direct recovery candidate is already authenticated by its state-owned obligation.
        // Do not enumerate an attacker-controlled overfull directory before using it:
        // the direct path is intentionally one-entry bounded work, and subsequent
        // ticks resume the indexed page once the fast candidate is archived.
        opts.retryMatchCursorStore?.set(activeMatchCursorKey, activeMatchCursor);
        const activePage = directEntryForRun
          ? (() => {
            try {
              return {
                entries: opts.runtimeAccess!.readOutboxDeliveryObligations(runId).map((obligation) => ({
                  name: obligation.entry_name,
                  relativePath: outboxQueue.path(obligation.entry_name),
                })),
                nextCursor: null,
              };
            } catch (error) {
              rethrowActivationFailure(error);
              return { entries: [], nextCursor: null };
            }
          })()
          : outboxQueue.listPage(activeMatchCursor);
        const discoveredQueueEntries = directEntryForRun
          ? activePage.entries
          : activePage.entries.sort((left, right) => {
            const leftRetry = (opts.retryMatchStateStore?.has(runId + "\u0000" + left.name) ?? false) || retryActiveMetadata(left.name) !== null;
            const rightRetry = (opts.retryMatchStateStore?.has(runId + "\u0000" + right.name) ?? false) || retryActiveMetadata(right.name) !== null;
            return leftRetry === rightRetry ? 0 : leftRetry ? 1 : -1;
          });
        const directQueueEntry = directEntryName === undefined
          ? null
          : { name: directEntryName, relativePath: outboxQueue.path(directEntryName) };
        const queueEntries = directQueueEntry
          ? [directQueueEntry, ...discoveredQueueEntries.filter((entry) => entry.name !== directQueueEntry.name)]
          : discoveredQueueEntries;
        for (const entry of queueEntries) {
          const name = entry.name;
          if (opts.lifecycle && Date.now() >= opts.lifecycle.deadline) {
            results.push({ runId, escId: name, sent: false, notAttemptedDeadline: true, error: "dispatcher tick deadline reached" });
            break;
          }
          if (opts.isOwned && !opts.isOwned()) break;
          if (name === "sent" && isArchiveDirectory(outboxQueue, name)) continue;
          if (activeWork >= ACTIVE_WORK_LIMIT) break;
          activeWork += 1;
          if (!name.endsWith(".json")) {
            let status: DeliveryAuthorityStatus = "unavailable";
            let stored: { bytes: Uint8Array; expectation: BoundedQueueEntryExpectation & { kind: "file" } } | undefined;
            try {
              stored = outboxQueue.read(name);
              status = currentDeliveryStatus(opts.runtimeAccess!, {
                run_id: runId,
                state_revision: currentStateRevision,
                entry_name: name,
                json: stored.bytes,
                lane: "outbox",
                routing_binding: routingBindingForBytes(opts.runtimeAccess!, stored.bytes, pinnedRoot) ?? undefined,
              }, pinnedRoot);
            } catch (error) {
              if (isDispatcherActivationFailure(error)) throw error;
            }
            if (status === "invalid") {
              quarantineQueueEntry(outboxQueue, name, stored?.expectation, join(".work-state", "cto", runId, "outbox-rejected"), drainFence);
              results.push({ runId, escId: name, sent: false, error: "outbox entry is not the current authenticated publication" });
            } else {
              // Unavailable (and the defensive current case) preserves the
              // exact non-JSON bytes and blocks the run's ACK for this tick.
              results.push({ runId, escId: name, sent: false, error: DELIVERY_AUTHORITY_UNAVAILABLE });
            }
            continue;
          }
          let escId = name.slice(0, -".json".length);
          const activeRetry = retryActiveMetadata(name);
          let archiveName = name;
          let decoded = false;
          let storedBytes: Uint8Array | undefined;
          let storedExpectation: BoundedQueueEntryExpectation | undefined;
          let ensureCurrentPublicationBeforeMutation: (() => boolean) | undefined;
          try {
            const stored = outboxQueue.read(name);
            storedBytes = stored.bytes;
            storedExpectation = stored.expectation;
            let storedRaw: unknown;
            try {
              storedRaw = JSON.parse(decodeUtf8(stored.bytes));
            } catch (error) {
              throw error;
            }
            decoded = true;
            if (!storedBytes) {
              // This is defensive only; queue.read above always supplies bytes.
              continue;
            }
            const publication: CtoRuntimeOutboxDeliveryInput = {
              run_id: runId,
              state_revision: currentStateRevision,
              entry_name: name,
              json: storedBytes,
              lane: "outbox",
              routing_binding: routingBindingForBytes(opts.runtimeAccess!, storedBytes, pinnedRoot) ?? undefined,
            };
            const publicationStatus = currentDeliveryStatus(opts.runtimeAccess!, publication, pinnedRoot);
            if (publicationStatus === "invalid") {
              quarantineQueueEntry(outboxQueue, name, storedExpectation, rejectedDirectory, drainFence);
              results.push({ runId, escId, sent: false, error: "outbox delivery is not the current authenticated publication" });
              continue;
            }
            if (publicationStatus === "unavailable") {
              results.push({ runId, escId, sent: false, error: DELIVERY_AUTHORITY_UNAVAILABLE });
              continue;
            }
            if (activeRetry) {
              // Active retry wrappers cannot be current publications; retain
              // this defensive branch if a future core validator changes its
              // filename contract.
              quarantineQueueEntry(outboxQueue, name, storedExpectation, rejectedDirectory, drainFence);
              results.push({ runId, escId, sent: false, error: "legacy active outbox retry record is not authenticated" });
              continue;
            }
            const raw = storedRaw as unknown as Escalation & { intent?: DeliveryIntent; topic?: string; idempotency_key?: unknown };
        ensureCurrentPublicationBeforeMutation = (): boolean => {
          const status = currentDeliveryStatus(opts.runtimeAccess!, publication, pinnedRoot);
          if (status === "current") return true;
          if (status === "invalid") {
            quarantineQueueEntry(outboxQueue, name, storedExpectation, rejectedDirectory, drainFence);
            results.push({ runId, escId, sent: false, error: "outbox delivery is not the current authenticated publication" });
          } else {
            results.push({ runId, escId, sent: false, error: DELIVERY_AUTHORITY_UNAVAILABLE });
          }
          return false;
        };
        if (runIdOf(raw) !== runId) {
          // A current core status and a local run mismatch are contradictory;
          // report and preserve rather than authorizing cleanup locally.
          results.push({ runId, escId, sent: false, error: "outbox escalation run id does not match its tenant run" });
          continue;
        }
        // sanitizeEscalation preserves additive fields (intent/target/topic).
        const clean = sanitizeEscalation(raw);
        const archiveText = JSON.stringify(raw);
        const idempotencyKey = normalizeIdempotencyKey(raw.idempotency_key, clean.id);
        if (!idempotencyKey) {
          // Core already authenticated the exact publication; invalid local
          // metadata is reported without a second, unauthorized cleanup.
          results.push({ runId, escId, sent: false, error: "invalid idempotency key" });
          continue;
        }
        if (!ensureCurrentPublicationBeforeMutation()) continue;
        if (!adapter) {
          // RO-only set: only subscribed report entries are deliverable.
          if (raw.intent === "summary") {
            const sinkErrors: string[] = [];
            const outcome = await routeReportsToSinks({ ...clean, intent: "summary", topic: raw.topic }, roSinks, sinkErrors, { ...opts, runtimeAccess: opts.runtimeAccess, delivery: publication });
            if (outcome.unavailable) {
              results.push({ runId, escId, sent: false, error: sinkErrors.join("; ") || DELIVERY_AUTHORITY_UNAVAILABLE });
            } else if (outcome.unauthorized) {
              quarantineQueueEntry(outboxQueue, name, storedExpectation, rejectedDirectory, drainFence);
              results.push({ runId, escId, sent: false, error: sinkErrors.join("; ") || "outbox delivery is not the current authenticated publication" });
            } else if (outcome.attempted === 0) {
              // Every sink subscription-skipped this topic — honest no-op:
              // nothing was attempted, archive as sent with no sinkErrors.
              if (!ensureCurrentPublicationBeforeMutation()) continue;
              clearPromotedRetryEntries(root, retryDirectory, name, storedBytes!, pinnedRoot, drainFence, opts.retryMatchStateStore?.get(runId + "\u0000" + name));
              archiveOutboxEntry(root, outboxQueue, activeDirectory, name, archiveName, archiveText, pinnedRoot, drainFence);
              opts.retryMatchStateStore?.delete(runId + "\u0000" + name);
              removeArchivedObligation(name, storedBytes!);
              clearRejectedEvidenceAfterSuccess();
              results.push({ runId, escId, sent: true });
            } else if (outcome.failed > 0 && outcome.failed === outcome.attempted) {
              // Every sink that was ACTUALLY attempted failed — the summary
              // was not delivered anywhere. Leave the file in outbox/ (NOT
              // archived) so the next drain retries it — pending/retryable.
              if (!ensureCurrentPublicationBeforeMutation()) continue;
              const result: DrainOutboxResult = { runId, escId, sent: false, error: "all ro sinks failed", sinkErrors };
              results.push(result);
              moveToRetry(name, terminalRun && raw.intent === "summary");
            } else {
              // At least one sink succeeded — archive the summary; partial
              // sink failures are recorded (today's behavior).
              if (!ensureCurrentPublicationBeforeMutation()) continue;
              clearPromotedRetryEntries(root, retryDirectory, name, storedBytes!, pinnedRoot, drainFence, opts.retryMatchStateStore?.get(runId + "\u0000" + name));
              archiveOutboxEntry(root, outboxQueue, activeDirectory, name, archiveName, archiveText, pinnedRoot, drainFence);
              opts.retryMatchStateStore?.delete(runId + "\u0000" + name);
              removeArchivedObligation(name, storedBytes!);
              clearRejectedEvidenceAfterSuccess();
              const result: DrainOutboxResult = { runId, escId, sent: true };
              if (sinkErrors.length > 0) result.sinkErrors = sinkErrors;
              results.push(result);
            }
          } else {
            // No validated RW primary -> questions/progress/legacy entries
            // stay durable for a later primary (restart-safe).
            if (!ensureCurrentPublicationBeforeMutation()) continue;
            results.push({ runId, escId, sent: false, error: "no rw primary to deliver non-report entry" });
            moveToRetry(name);
          }
          continue;
        }
        const sendOutcome = await sendWithRetry(adapter, clean, maxRetries, { idempotencyKey, requireIdempotency: opts.requireIdempotency, isOwned: opts.isOwned, pinnedRoot: opts.pinnedRoot, lifecycle: opts.lifecycle, runtimeAccess: opts.runtimeAccess, delivery: publication });
        const receipt = sendOutcome.receipt;
        if (sendOutcome.unavailable) {
          results.push({ runId, escId, sent: false, error: sendOutcome.error ?? DELIVERY_AUTHORITY_UNAVAILABLE });
        } else if (sendOutcome.unauthorized) {
          quarantineQueueEntry(outboxQueue, name, storedExpectation, rejectedDirectory, drainFence);
          results.push({ runId, escId, sent: false, error: sendOutcome.error ?? "outbox delivery is not the current authenticated publication" });
        } else if (sendOutcome.error) {
          if (!ensureCurrentPublicationBeforeMutation()) continue;
          results.push({ runId, escId, sent: false, error: sendOutcome.error });
          moveToRetry(name);
        } else if (sendOutcome.unsupported) {
          if (!ensureCurrentPublicationBeforeMutation()) continue;
          results.push({ runId, escId, sent: false, error: "transport does not support durable idempotency" });
          moveToRetry(name);
        } else if (sendOutcome.ownershipLost || (opts.isOwned && !opts.isOwned())) {
          if (!ensureCurrentPublicationBeforeMutation()) continue;
          results.push({ runId, escId, sent: false, error: "dispatcher lease lost before archival" });
          moveToRetry(name);
        } else if (receipt.sent) {
          const sinkErrors: string[] = [];
          if (raw.intent === "summary" && roSinks.length > 0) {
            // Rebuild the envelope on the sanitized entry (sinks receive the
            // same redacted content as the primary); topic stays optional.
            // The drain adapter itself is skipped as a routing target — a
            // legacy single-RO-adapter config drains via its only sink and
            // must not double-send its own summaries.
            const routingSinks = roSinks.filter((s) => s !== adapter);
            if (routingSinks.length > 0) {
              const sinkOutcome = await routeReportsToSinks({ ...clean, intent: "summary", topic: raw.topic }, routingSinks, sinkErrors, { ...opts, runtimeAccess: opts.runtimeAccess, delivery: publication });
              if (sinkOutcome.unavailable) {
                results.push({ runId, escId, sent: false, error: sinkErrors.join("; ") || DELIVERY_AUTHORITY_UNAVAILABLE });
                continue;
              }
              if (sinkOutcome.unauthorized) {
                quarantineQueueEntry(outboxQueue, name, storedExpectation, rejectedDirectory, drainFence);
                results.push({ runId, escId, sent: false, error: sinkErrors.join("; ") || "outbox delivery is not the current authenticated publication" });
                continue;
              }
            }
          }
          if (!ensureCurrentPublicationBeforeMutation()) continue;
          clearPromotedRetryEntries(root, retryDirectory, name, storedBytes!, pinnedRoot, drainFence, opts.retryMatchStateStore?.get(runId + "\u0000" + name));
          archiveOutboxEntry(root, outboxQueue, activeDirectory, name, archiveName, archiveText, pinnedRoot, drainFence);
          removeArchivedObligation(name, storedBytes!);
          clearRejectedEvidenceAfterSuccess();
          const result: DrainOutboxResult = { runId, escId, sent: true };
          if (sinkErrors.length > 0) result.sinkErrors = sinkErrors;
          results.push(result);
        } else {
          // moveRetryableEntry performs the authoritative precheck itself;
          // avoid a duplicate status read that can turn a post-mark outage
          // into a pre-mark outage in the retry state machine.
          results.push({ runId, escId, sent: false, error: "send failed after " + String(maxRetries) + " attempts" });
          moveToRetry(name, terminalRun && raw.intent === "summary");
        }
          } catch (error) {
            if (isDispatcherActivationFailure(error)) throw error;
            if (!decoded) {
              if (storedBytes) {
                const malformedStatus = currentDeliveryStatus(opts.runtimeAccess!, {
                  run_id: runId,
                  state_revision: currentStateRevision,
                  entry_name: name,
                  json: storedBytes,
                  lane: "outbox",
                });
                if (malformedStatus === "invalid") {
                  quarantineQueueEntry(outboxQueue, name, storedExpectation, rejectedDirectory, drainFence);
                  results.push({ runId, escId, sent: false, error: "outbox delivery is not the current authenticated publication" });
                } else {
                  // Current is defensive-impossible for malformed bytes; it
                  // still blocks ACK rather than silently clearing pending.
                  results.push({ runId, escId, sent: false, error: DELIVERY_AUTHORITY_UNAVAILABLE });
                }
              } else {
                // A failed source read is unavailable and remains untouched.
                results.push({ runId, escId, sent: false, error: DELIVERY_AUTHORITY_UNAVAILABLE });
              }
            } else if (!ensureCurrentPublicationBeforeMutation || !ensureCurrentPublicationBeforeMutation()) {
              continue;
            } else {
              moveToRetry(name);
              results.push({ runId, escId, sent: false, error: error instanceof Error ? error.message : String(error) });
            }
          }
        }
        if (opts.retryMatchCursorStore && activePage.entries.length > 0) {
          let pageAdvanced = false;
          for (const entry of activePage.entries) {
            try {
              outboxQueue.classify(entry.name);
            } catch (error) {
              rethrowActivationFailure(error);
              if (error instanceof BoundedQueueError && error.code === "not_found") pageAdvanced = true;
            }
          }
          const retryStatePrefix = runId + "\u0000";
          const hasRetryStateForRun = opts.retryMatchStateStore !== undefined
            && [...opts.retryMatchStateStore.keys()].some((key) => key.startsWith(retryStatePrefix));
          if (!pageAdvanced || !hasRetryStateForRun) opts.retryMatchCursorStore.set(activeMatchCursorKey, null);
        }
      } finally {
        outboxQueue.close();
      }
    } catch (error) {
      if (isDispatcherActivationFailure(error)) throw error;
      // A corrupt or unavailable run must not starve later indexed entries.
      continue;
    }
  }
  assertMutationLive(drainFence);
  return results;
  } finally {
    if (!suppliedPin) pinnedRoot.close();
  }
}

/**
 * Fan a successfully-sent summary report out to the RO sinks. Per-sink
 * subscription filter: subscriptions present -> send only when the entry
 * `topic` is subscribed; no subscriptions -> send all reports. Best-effort:
 * a throwing/failing sink never propagates — its error is recorded in
 * `sinkErrors` and the remaining sinks are still tried.
 *
 * Returns the delivery outcome: `attempted` = sinks ACTUALLY sent to
 * (subscription-skipped sinks do not count), `failed` = sinks that threw
 * OR returned a receipt with `sent !== true`. The RO-only drain branch uses
 * the outcome to decide whether a summary is deliverable at all (all sinks
 * failed -> leave the entry for the next drain).
 */
async function routeReportsToSinks(
  esc: Escalation & { intent: DeliveryIntent; topic?: string },
  roSinks: EscalationAdapter[],
  sinkErrors: string[],
  opts: { requireIdempotency?: boolean; isOwned?: () => boolean; pinnedRoot?: PinnedProjectRoot; lifecycle?: AdapterOperationContext; runtimeAccess?: RuntimeAccess; delivery?: CtoRuntimeOutboxDeliveryInput } = {},
): Promise<{ attempted: number; failed: number; unauthorized?: boolean; unavailable?: boolean }> {
  let attempted = 0;
  let failed = 0;
  let unauthorized = false;
  let unavailable = false;
  for (const sink of roSinks) {
    const subscriptions = sinkSubscriptionsOf(sink);
    if (subscriptions && (!esc.topic || !subscriptions.includes(esc.topic))) continue;
    attempted += 1;
    try {
      const outcome = await sendWithRetry(sink, esc, 1, {
        idempotencyKey: `${esc.id}/ro-sink/${sinkProfileIdOf(sink)}`,
        requireIdempotency: opts.requireIdempotency,
        isOwned: opts.isOwned,
        pinnedRoot: opts.pinnedRoot,
        lifecycle: opts.lifecycle,
        runtimeAccess: opts.runtimeAccess,
        delivery: opts.delivery,
      });
      if (outcome.unavailable) {
        unavailable = true;
        failed += 1;
        sinkErrors.push(outcome.error ?? DELIVERY_AUTHORITY_UNAVAILABLE);
        break;
      }
      if (outcome.unauthorized) {
        unauthorized = true;
        failed += 1;
        sinkErrors.push(outcome.error ?? "outbox delivery is not the current authenticated publication");
        continue;
      }
      if (outcome.error) {
        failed += 1;
        sinkErrors.push(outcome.error);
      } else if (outcome.unsupported) {
        failed += 1;
        sinkErrors.push("sink " + sink.kind + " does not support durable idempotency");
      } else if (outcome.receipt.sent !== true) {
        failed += 1;
        sinkErrors.push("sink " + sink.kind + " reported unsent");
      }
    } catch (error) {
      if (isDispatcherActivationFailure(error)) throw error;
      failed += 1;
      sinkErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { attempted, failed, unauthorized, unavailable };
}

type IdempotentEscalationAdapter = EscalationAdapter & {
  sendWithIdempotency?: (esc: Escalation, idempotencyKey: string, pinnedRoot?: PinnedProjectRoot, lifecycle?: AdapterOperationContext) => Promise<EscalationReceipt>;
};

export interface AdapterOperationContext {
  /** Abort is raised by dispatcher stop before waiting for current transport I/O. */
  readonly signal: AbortSignal;
  /** Absolute monotonic wall-clock deadline for this dispatcher tick. */
  readonly deadline: number;
  /** Track a user callback beyond the bounded race until its promise settles. */
  readonly trackUnderlyingCallback?: (operation: PromiseLike<unknown>) => void;
  /** Track adapter I/O independently; dispatcher stop never awaits this operation. */
  readonly trackUnderlyingOperation?: (operation: PromiseLike<unknown>) => void;
  /** Fail closed before/after every network operation when activation revokes. */
  readonly assertLive?: () => void;
}

export const ADAPTER_OPERATION_TIMEOUT_MS = 5_000;

class AdapterOperationTimeoutError extends Error {
  readonly code = "ADAPTER_OPERATION_TIMEOUT" as const;
  constructor() {
    super("adapter operation exceeded its bounded lifecycle deadline");
    this.name = "AdapterOperationTimeoutError";
  }
}

class AdapterOperationAbortedError extends Error {
  readonly code = "ADAPTER_OPERATION_ABORTED" as const;
  constructor() {
    super("adapter operation aborted during dispatcher teardown");
    this.name = "AdapterOperationAbortedError";
  }
}

function boundedAdapterCall<T>(
  call: () => PromiseLike<T> | T,
  lifecycle?: AdapterOperationContext,
  trackUnderlying?: (operation: PromiseLike<unknown>) => void,
): Promise<T> {
  if (!lifecycle) {
    const controller = new AbortController();
    return boundedAdapterCall(call, { signal: controller.signal, deadline: Date.now() + ADAPTER_OPERATION_TIMEOUT_MS }, trackUnderlying);
  }
  const remaining = Math.max(0, lifecycle.deadline - Date.now());
  if (remaining <= 0) return Promise.reject(new AdapterOperationTimeoutError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      lifecycle.signal.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = (): void => finish(() => reject(new AdapterOperationAbortedError()));
    if (lifecycle.signal.aborted) {
      onAbort();
      return;
    }
    lifecycle.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(() => reject(new AdapterOperationTimeoutError())), remaining);
    // Start the adapter operation synchronously so inbound admission and
    // normal polling preserve the dispatcher tick's prompt callback timing.
    // Promise handlers remain attached after timeout/abort so a custom adapter
    // that ignores the signal cannot create a late unhandled rejection.
    let operation: PromiseLike<T> | T;
    try {
      operation = call();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    const underlying = Promise.resolve(operation);
    // The bounded race reports timeout/abort promptly, but this separate
    // promise remains tracked until an uncooperative callback actually settles.
    trackUnderlying?.(underlying as PromiseLike<unknown>);
    underlying.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

interface SendOutcome {
  receipt: EscalationReceipt;
  unsupported?: boolean;
  ownershipLost?: boolean;
  unauthorized?: boolean;
  unavailable?: boolean;
  error?: string;
}

class UnauthorizedDeliveryError extends Error {
  readonly code = "delivery_unbound" as const;
  constructor() {
    super("outbox delivery is not the current authenticated publication");
    this.name = "UnauthorizedDeliveryError";
  }
}

class DeliveryAuthorityUnavailableError extends Error {
  readonly code = "delivery_authority_unavailable" as const;
  constructor() {
    super(DELIVERY_AUTHORITY_UNAVAILABLE);
    this.name = "DeliveryAuthorityUnavailableError";
  }
}

async function sendWithRetry(
  adapter: EscalationAdapter,
  esc: Escalation,
  maxRetries: number,
  opts: { idempotencyKey?: string; requireIdempotency?: boolean; isOwned?: () => boolean; pinnedRoot?: PinnedProjectRoot; lifecycle?: AdapterOperationContext; runtimeAccess?: RuntimeAccess; delivery?: CtoRuntimeOutboxDeliveryInput } = {},
): Promise<SendOutcome> {
  const idempotent = adapter as IdempotentEscalationAdapter;
  const retryCount = boundedRetryCount(maxRetries);
  if (retryCount === 0) return { receipt: { sent: false }, error: "outbox retry count is invalid or zero" };
  if (opts.requireIdempotency && typeof idempotent.sendWithIdempotency !== "function") {
    return { receipt: { sent: false }, unsupported: true };
  }
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    if ((opts.pinnedRoot && !opts.pinnedRoot.isStable()) || (opts.isOwned && !opts.isOwned())) return { receipt: { sent: false }, ownershipLost: true };
    opts.lifecycle?.assertLive?.();
    const assertCurrentPublication = (): void => {
      if (!opts.runtimeAccess || !opts.delivery) return;
      const deliveryBytes = typeof opts.delivery.json === "string" ? Buffer.from(opts.delivery.json, "utf8") : opts.delivery.json;
      const routingBinding = routingBindingForBytes(opts.runtimeAccess, deliveryBytes, opts.pinnedRoot);
      if (!routingBinding) throw new UnauthorizedDeliveryError();
      const status = currentDeliveryStatus(opts.runtimeAccess, { ...opts.delivery, routing_binding: routingBinding }, opts.pinnedRoot);
      if (status === "unavailable") throw new DeliveryAuthorityUnavailableError();
      if (status !== "current" || !adapterMatchesRoutingBinding(adapter, routingBinding)) throw new UnauthorizedDeliveryError();
    };
    try {
      assertCurrentPublication();
      const receipt = await boundedAdapterCall(
        () => {
          opts.lifecycle?.assertLive?.();
          assertAdapterRegistrationLive(adapter);
          assertCurrentPublication();
          return typeof opts.idempotencyKey === "string" && typeof idempotent.sendWithIdempotency === "function"
            ? idempotent.sendWithIdempotency(esc, opts.idempotencyKey, opts.pinnedRoot, opts.lifecycle)
            : (adapter.send as (esc: Escalation, pinnedRoot?: PinnedProjectRoot, lifecycle?: AdapterOperationContext) => Promise<EscalationReceipt>)(esc, opts.pinnedRoot, opts.lifecycle);
        },
        opts.lifecycle,
        opts.lifecycle?.trackUnderlyingOperation,
      );
      assertAdapterRegistrationLive(adapter);
      opts.lifecycle?.assertLive?.();
      if ((opts.pinnedRoot && !opts.pinnedRoot.isStable()) || (opts.isOwned && !opts.isOwned())) return { receipt: { sent: false }, ownershipLost: true };
      if (receipt.sent) {
        assertCurrentPublication();
        return { receipt };
      }
    } catch (error) {
      if (isDispatcherActivationFailure(error)) throw error;
      if (error instanceof DeliveryAuthorityUnavailableError) return { receipt: { sent: false }, unavailable: true, error: error.message };
      if (error instanceof UnauthorizedDeliveryError) return { receipt: { sent: false }, unauthorized: true, error: error.message };
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "DELIVERY_EFFECT_AMBIGUOUS") return { receipt: { sent: false }, error: error instanceof Error ? error.message : "delivery effect is ambiguous" };
      if (code === "ADAPTER_OPERATION_TIMEOUT" && opts.idempotencyKey) {
        // A bounded idempotent call may have reached the receiver; never retry
        // an unknown remote outcome merely because the local deadline expired.
        return { receipt: { sent: false }, error: "delivery effect is ambiguous" };
      }
      if (opts.lifecycle?.signal.aborted || (opts.lifecycle && Date.now() >= opts.lifecycle.deadline)) {
        return { receipt: { sent: false }, ownershipLost: true };
      }
      // network / adapter error — retry
    }
    if (attempt < retryCount) {
      const delay = 500 * 2 ** (attempt - 1);
      const remaining = opts.lifecycle ? opts.lifecycle.deadline - Date.now() : delay;
      if (remaining <= 0) break;
      await boundedAdapterCall(() => new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, remaining))), opts.lifecycle);
    }
  }
  return { receipt: { sent: false } };
}

const DISPATCHER_LEASE_TTL_MS = 30_000;
const DISPATCHER_HEARTBEAT_MS = 5_000;
const CONTROL_QUEUE_OPTIONS = { maxEntries: 64, maxWork: 64 * 1024, maxEntryBytes: 64 * 1024, maxScanEntries: 8192 } as const;
// Direct writes are discovered in larger bounded batches; entries that are
// not currently authenticated remain exact-byte preserved for later ticks.
const DIRECT_OUTBOX_QUEUE_OPTIONS = { ...CONTROL_QUEUE_OPTIONS, maxEntries: 2_048, maxWork: 256 * 1024 } as const;
const ACTIVE_WORK_LIMIT = 8;
// Active queue pages admit eight work entries plus one reserved archive slot.
const ACTIVE_LIST_LIMIT = ACTIVE_WORK_LIMIT + 1;
const ACTIVE_QUEUE_OPTIONS = { ...CONTROL_QUEUE_OPTIONS, maxEntries: ACTIVE_LIST_LIMIT } as const;
export const MAX_DRAIN_RUN_ENTRIES = 64;
export const MAX_DRAIN_RO_SINKS = 64;
export const MAX_DRAIN_INPUT_STRING_BYTES = 4_096;
export const MAX_DRAIN_INPUT_BYTES = 64 * 1024;

function validDrainInputList(value: unknown, maxItems: number): boolean {
  try {
    if (value === undefined) return true;
    return Array.isArray(value) && value.length <= maxItems;
  } catch {
    return false;
  }
}

function validDrainRunEntries(value: unknown): boolean {
  try {
    if (!validDrainInputList(value, MAX_DRAIN_RUN_ENTRIES)) return false;
    if (value === undefined) return true;
    let total = 0;
    const visit = (candidate: unknown, depth: number): boolean => {
      if (depth > 8) return false;
      if (typeof candidate === "string") {
        const bytes = Buffer.byteLength(candidate, "utf8");
        total += bytes;
        return bytes <= MAX_DRAIN_INPUT_STRING_BYTES && total <= MAX_DRAIN_INPUT_BYTES;
      }
      if (candidate === null || typeof candidate === "number" || typeof candidate === "boolean" || typeof candidate === "undefined") return true;
      if (Array.isArray(candidate)) return candidate.length <= MAX_DRAIN_RUN_ENTRIES && candidate.every((item) => visit(item, depth + 1));
      if (typeof candidate !== "object") return false;
      const entries = Object.entries(candidate as Record<string, unknown>);
      return entries.length <= 32 && entries.every(([key, item]) => {
        const keyBytes = Buffer.byteLength(key, "utf8");
        total += keyBytes;
        return keyBytes <= MAX_DRAIN_INPUT_STRING_BYTES
          && total <= MAX_DRAIN_INPUT_BYTES
          && visit(item, depth + 1);
      });
    };
    return visit(value, 0);
  } catch {
    return false;
  }
}

const RETRY_LANE_VERSION = "r2";
const RETRY_ACTIVE_VERSION = "r2a";
const RETRY_MAX_ATTEMPT = 255;
export const MAX_DRAIN_RETRIES = RETRY_MAX_ATTEMPT;

function boundedRetryCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= RETRY_MAX_ATTEMPT
    ? value
    : 0;
}
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRY_LANE_NAME = /^r2\.(\d{1,3})\.(\d{1,13})\.([0-9a-f]{64})\.([0-9a-f-]{36})\.json$/u;
const RETRY_ACTIVE_NAME = /^r2a\.(\d{1,3})\.([0-9a-f]{64})\.([0-9a-f-]{36})\.json$/u;
const DISPATCHER_TICK_DEADLINE_MS = 4_500;
const DISPATCHER_STOP_GRACE_MS = 1_000;

class DispatcherActivationRevokedError extends Error {
  readonly code = "activation_revoked" as const;
  constructor(message = "dispatcher activation is no longer live") {
    super(message);
    this.name = "DispatcherActivationRevokedError";
  }
}

function registrySnapshotEqual(left: RegistryContextSnapshot, right: RegistryContextSnapshot): boolean {
  return left.canonical_root === right.canonical_root
    && left.root_dev === right.root_dev
    && left.root_ino === right.root_ino
    && left.owner_fingerprint === right.owner_fingerprint
    && left.principal_fingerprint === right.principal_fingerprint
    && left.claim_generation === right.claim_generation
    && left.marker_generation === right.marker_generation
    && left.marker_digest === right.marker_digest;
}

type DispatcherActivationLiveGuard = RegistryRegistrationLiveGuard;

function assertDispatcherActivationLive(
  runtimeAccess: RuntimeAccess | undefined,
  pinnedRoot: PinnedProjectRoot,
  liveGuard?: DispatcherActivationLiveGuard,
  expectedActivation?: RegistryContextSnapshot,
): RegistryContextSnapshot | undefined {
  if (!pinnedRoot.isStable()) throw new DispatcherActivationRevokedError("dispatcher project root identity changed");
  try {
    runtimeAccess?.assertLive();
    if (liveGuard) {
      const current = liveGuard();
      if (current.canonical_root !== pinnedRoot.canonical_root || current.root_dev !== pinnedRoot.dev || current.root_ino !== pinnedRoot.ino) {
        throw new DispatcherActivationRevokedError("dispatcher activation root identity changed");
      }
      if (expectedActivation && !registrySnapshotEqual(current, expectedActivation)) {
        throw new DispatcherActivationRevokedError("dispatcher activation snapshot changed");
      }
      if (!pinnedRoot.isStable()) throw new DispatcherActivationRevokedError("dispatcher project root identity changed");
      return current;
    }
  } catch (error) {
    if (error instanceof DispatcherActivationRevokedError) throw error;
    throw new DispatcherActivationRevokedError(error instanceof Error ? error.message : "dispatcher runtime access is no longer live");
  }
  if (!pinnedRoot.isStable()) throw new DispatcherActivationRevokedError("dispatcher project root identity changed");
  return undefined;
}

function isDispatcherActivationFailure(error: unknown): boolean {
  return error instanceof DispatcherActivationRevokedError
    || Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "activation_revoked");
}

type MutationFence = {
  readonly pinnedRoot?: PinnedProjectRoot;
  readonly runtimeAccess?: RuntimeAccess;
  readonly lifecycle?: AdapterOperationContext;
};

function assertMutationLive(fence?: MutationFence): void {
  if (!fence) return;
  fence.lifecycle?.assertLive?.();
  if (fence.pinnedRoot) {
    assertDispatcherActivationLive(fence.runtimeAccess, fence.pinnedRoot);
  } else if (fence.runtimeAccess) {
    try { fence.runtimeAccess.assertLive(); } catch (error) {
      throw new DispatcherActivationRevokedError(error instanceof Error ? error.message : "dispatcher runtime access is no longer live");
    }
  }
}

function rethrowActivationFailure(error: unknown): void {
  if (isDispatcherActivationFailure(error)) throw error;
}

type DeliveryAuthorityStatus = "current" | "invalid" | "unavailable";
const DELIVERY_AUTHORITY_UNAVAILABLE = "outbox delivery authority is unavailable; retryable";

function currentDeliveryStatus(
  runtimeAccess: RuntimeAccess,
  input: CtoRuntimeOutboxDeliveryInput,
  pinnedRoot?: PinnedProjectRoot,
): DeliveryAuthorityStatus {
  try {
    const binding = input.routing_binding ?? (pinnedRoot
      ? routingBindingForBytes(runtimeAccess, typeof input.json === "string" ? Buffer.from(input.json, "utf8") : input.json, pinnedRoot)
      : null);
    // A malformed envelope cannot derive a route binding and is rejected; a
    // configured delivery never falls back to an unbound/default route.
    if (!binding) return "invalid";
    const status = runtimeAccess.currentOutboxDeliveryStatus({ ...input, routing_binding: binding });
    return status === "current" || status === "invalid" || status === "unavailable" ? status : "unavailable";
  } catch (error) {
    if (isDispatcherActivationFailure(error)) throw error;
    return "unavailable";
  }
}

function quarantineDirectOutboxEntryIfInvalid(
  root: string,
  runId: string,
  entryName: string,
  expectedRevision: number,
  reason: "missing" | "unpublished",
  pinnedRoot: PinnedProjectRoot,
  lifecycle?: AdapterOperationContext,
  runtimeAccess?: RuntimeAccess,
): void {
  const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", runId, "outbox"), {
    ...DIRECT_OUTBOX_QUEUE_OPTIONS,
    createDirectory: false,
    pinnedRoot,
  });
  if (!queue) return;
  try {
    let observed: { bytes: Uint8Array };
    try { observed = queue.read(entryName); } catch { return; }
    if (!runtimeAccess || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return;

    // Parse and establish the envelope's own revision before consulting the
    // authority. Missing/unusable revisions are legacy bytes and must remain
    // untouched even when an indexed fallback revision would be rejected.
    let raw: unknown;
    try { raw = JSON.parse(decodeUtf8(observed.bytes)); } catch { return; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const record = raw as Record<string, unknown>;
    const recordRevision = record.state_revision;
    if (typeof recordRevision !== "number" || !Number.isSafeInteger(recordRevision) || recordRevision < 0) return;

    // Local structural checks only determine whether a status request can be
    // formed safely; they never authorize cleanup. The exact bytes and the
    // envelope's own revision are always passed to core before quarantine.
    try {
      // These reads must succeed before status is requested; a non-canonical
      // result is still left for core to classify, never cleaned locally.
      validateEscalation(raw as Escalation);
      runIdOf(raw as Escalation);
      canonicalDurableIdFileName((raw as Escalation).id);
    } catch {
      return;
    }
    const status = currentDeliveryStatus(runtimeAccess, {
      run_id: runId,
      state_revision: recordRevision,
      entry_name: entryName,
      json: observed.bytes,
      lane: "outbox",
      routing_binding: routingBindingForBytes(runtimeAccess, observed.bytes, pinnedRoot) ?? undefined,
    }, pinnedRoot);
    if (status === "invalid") quarantineDirectOutboxEntry(root, runId, entryName, reason, pinnedRoot, lifecycle, runtimeAccess);
  } finally {
    queue.close();
  }
}


// Legacy r1/r1a names are read only for migration. New retry writes never
// embed the original filename, whose base64url spelling can exceed NAME_MAX.
const LEGACY_RETRY_LANE_NAME = /^r1\.(\d{1,3})\.(\d{1,13})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]+)\.json$/u;
const LEGACY_RETRY_ACTIVE_NAME = /^r1a\.(\d{1,3})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]+)\.json$/u;

interface RetryLaneEntry {
  readonly version: "r1" | "r2";
  readonly attempt: number;
  readonly dueAt: number;
  readonly originalName: string | null;
  readonly originalNameHash: string;
}

type RetryClock = (() => number) | number;

function retryClockNow(clock?: RetryClock): number {
  const now = typeof clock === "function" ? clock() : clock;
  return typeof now === "number" && Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
}

function retryDueAt(attempt: number, now = Date.now()): number {
  const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.min(Number.MAX_SAFE_INTEGER, now + delay);
}

function retryOriginalNameHash(originalName: string): string {
  return createHash("sha256").update(originalName, "utf8").digest("hex");
}

function validRetryOriginalName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && value.endsWith(".json")
    && Buffer.byteLength(value, "utf8") <= 255;
}

function retryLaneEntryName(originalName: string, attempt: number, dueAt: number): string {
  const boundedAttempt = Math.max(1, Math.min(RETRY_MAX_ATTEMPT, attempt));
  return `${RETRY_LANE_VERSION}.${boundedAttempt}.${dueAt}.${retryOriginalNameHash(originalName)}.${randomUUID()}.json`;
}

function parseRetryLaneEntry(name: string): RetryLaneEntry | null {
  const modern = RETRY_LANE_NAME.exec(name);
  if (modern) {
    const attempt = Number(modern[1]);
    const dueAt = Number(modern[2]);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > RETRY_MAX_ATTEMPT || !Number.isSafeInteger(dueAt) || dueAt < 0) return null;
    return { version: "r2", attempt, dueAt, originalName: null, originalNameHash: modern[3]! };
  }
  const legacy = LEGACY_RETRY_LANE_NAME.exec(name);
  if (!legacy) return null;
  const attempt = Number(legacy[1]);
  const dueAt = Number(legacy[2]);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > RETRY_MAX_ATTEMPT || !Number.isSafeInteger(dueAt) || dueAt < 0) return null;
  let originalName: string;
  try { originalName = Buffer.from(legacy[4]!, "base64url").toString("utf8"); } catch { return null; }
  if (Buffer.from(originalName, "utf8").toString("base64url") !== legacy[4] || !validRetryOriginalName(originalName)) return null;
  return { version: "r1", attempt, dueAt, originalName, originalNameHash: retryOriginalNameHash(originalName) };
}

function retryActiveEntryName(metadata: RetryLaneEntry): string {
  return `${RETRY_ACTIVE_VERSION}.${metadata.attempt}.${metadata.originalNameHash}.${randomUUID()}.json`;
}

function retryActiveMetadata(name: string): RetryLaneEntry | null {
  const modern = RETRY_ACTIVE_NAME.exec(name);
  if (modern) {
    const attempt = Number(modern[1]);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > RETRY_MAX_ATTEMPT) return null;
    return { version: "r2", attempt, dueAt: 0, originalName: null, originalNameHash: modern[2]! };
  }
  const legacy = LEGACY_RETRY_ACTIVE_NAME.exec(name);
  if (!legacy) return null;
  const attempt = Number(legacy[1]);
  let originalName: string;
  try { originalName = Buffer.from(legacy[3]!, "base64url").toString("utf8"); } catch { return null; }
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > RETRY_MAX_ATTEMPT || Buffer.from(originalName, "utf8").toString("base64url") !== legacy[3] || !validRetryOriginalName(originalName)) return null;
  return { version: "r1", attempt, dueAt: 0, originalName, originalNameHash: retryOriginalNameHash(originalName) };
}

interface InboxRetryWrapper {
  schema: 1;
  kind: "inbox-retry";
  attempt: number;
  due_at: number;
  original_name: string;
  source: AuthenticatedInboxEnvelope;
  source_digest: string;
  auth_evidence: AuthenticatedInboxEnvelope["auth"];
  mac: string;
}

interface VerifiedInboxRetry {
  readonly wrapper: InboxRetryWrapper;
  readonly source: AuthenticatedInboxEnvelope;
}

function inboxRetryMac(secret: string, rootIdentity: string, sourceDigest: string, body: Omit<InboxRetryWrapper, "mac">): string {
  return createHmac("sha256", secret)
    .update("omp-inbox-retry-v1\0", "utf8")
    .update(rootIdentity, "utf8")
    .update("\0", "utf8")
    .update(sourceDigest, "utf8")
    .update("\0", "utf8")
    .update(canonicalAuthJson(body), "utf8")
    .digest("hex");
}

function inboxSourceDigest(source: AuthenticatedInboxEnvelope): string {
  return createHash("sha256").update(canonicalAuthJson(source), "utf8").digest("hex");
}

function createInboxRetryWrapper(root: string, source: AuthenticatedInboxEnvelope, originalName: string, attempt: number, dueAt: number, pinnedRoot?: PinnedProjectRoot, retrySecret?: string | null): InboxRetryWrapper | null {
  if (!pinnedRoot || !pinnedRoot.isStable()) return null;
  const identity = retryRootIdentity(root, pinnedRoot);
  const secret = retrySecret === undefined ? readOrCreateRetrySecret(root, pinnedRoot) : retrySecret;
  const boundedAttempt = Math.max(1, Math.min(RETRY_MAX_ATTEMPT, attempt));
  const sourceDigest = inboxSourceDigest(source);
  if (!identity || !secret || !pinnedRoot.isStable() || !validRetryOriginalName(originalName) || !Number.isSafeInteger(dueAt) || dueAt < 0) return null;
  const body: Omit<InboxRetryWrapper, "mac"> = {
    schema: 1,
    kind: "inbox-retry",
    attempt: boundedAttempt,
    due_at: dueAt,
    original_name: originalName,
    source,
    source_digest: sourceDigest,
    auth_evidence: source.auth,
  };
  return { ...body, mac: inboxRetryMac(secret, identity.token, sourceDigest, body) };
}
function verifyInboxRetryWrapper(root: string, raw: unknown, pinnedRoot?: PinnedProjectRoot, retrySecret?: string | null): VerifiedInboxRetry | null {
  if (!pinnedRoot || !pinnedRoot.isStable()) return null;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<InboxRetryWrapper>;
  const attempt = value.attempt;
  const dueAt = value.due_at;
  if (value.schema !== 1 || value.kind !== "inbox-retry" || typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > RETRY_MAX_ATTEMPT || typeof dueAt !== "number" || !Number.isSafeInteger(dueAt) || dueAt < 0 || !validRetryOriginalName(value.original_name) || typeof value.source_digest !== "string" || !/^[0-9a-f]{64}$/u.test(value.source_digest) || typeof value.mac !== "string" || !/^[0-9a-f]{64}$/u.test(value.mac)) return null;
  const source = value.source;
  const evidence = value.auth_evidence;
  if (!source || typeof source !== "object" || source.schema !== 2 || (source.kind !== "answer" && source.kind !== "task") || typeof source.id !== "string" || source.id.length === 0 || !isSafeCtoInboundText(source.text, MAX_INBOX_TEXT_LENGTH) || typeof source.at !== "string" || typeof source.by !== "string" || typeof source.run_id !== "string" || !safeRunId(source.run_id) || !evidence || typeof evidence !== "object" || typeof evidence.session_id !== "string" || evidence.session_id.length === 0 || typeof evidence.nonce !== "string" || evidence.nonce.length < 16 || typeof evidence.mac !== "string" || !/^[0-9a-f]{64}$/iu.test(evidence.mac) || (evidence.mode !== undefined && evidence.mode !== "durable")) return null;
  const normalizedSource: AuthenticatedInboxEnvelope = { schema: 2, kind: source.kind, id: source.id, text: source.text, at: source.at, by: source.by, run_id: source.run_id, auth: { session_id: evidence.session_id, nonce: evidence.nonce, mac: evidence.mac, ...(evidence.mode === "durable" ? { mode: "durable" as const } : {}) } };
  if (canonicalAuthJson(normalizedSource) !== canonicalAuthJson(source) || inboxSourceDigest(normalizedSource) !== value.source_digest || canonicalAuthJson(normalizedSource.auth) !== canonicalAuthJson(value.auth_evidence)) return null;
  const identity = retryRootIdentity(root, pinnedRoot);
  const secret = retrySecret === undefined ? readOrCreateRetrySecret(root, pinnedRoot) : retrySecret;
  if (!identity || !secret) return null;
  const body: Omit<InboxRetryWrapper, "mac"> = { schema: 1, kind: "inbox-retry", attempt, due_at: dueAt, original_name: value.original_name, source: normalizedSource, source_digest: value.source_digest, auth_evidence: normalizedSource.auth };
  const expected = inboxRetryMac(secret, identity.token, value.source_digest, body);
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(value.mac, "hex");
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) return null;
  if (!pinnedRoot.isStable() || retryRootIdentity(root, pinnedRoot)?.token !== identity.token) return null;
  return { wrapper: { ...body, mac: value.mac }, source: normalizedSource };
}

function retryOriginalNameFromRecord(queue: BoundedQueue, name: string): string | null {
  try {
    const raw = queue.readJson<Record<string, unknown>>(name);
    return validRetryOriginalName(raw.original_name) ? raw.original_name : null;
  } catch {
    return null;
  }
}

function persistInboxRetryEntry(queue: BoundedQueue, name: string, expected: { dev: number; ino: number; bytes: Uint8Array }, root: string, source: AuthenticatedInboxEnvelope, retryDirectory: string, attempt: number, now: number, pinnedRoot?: PinnedProjectRoot, retrySecret?: string | null): boolean {
  const active = retryActiveMetadata(name);
  const originalName = active?.originalName ?? retryOriginalNameFromRecord(queue, name) ?? name;
  const wrapper = createInboxRetryWrapper(root, source, originalName, attempt, retryDueAt(attempt, now), pinnedRoot, retrySecret);
  if (!wrapper) return false;
  const retryName = retryLaneEntryName(wrapper.original_name, wrapper.attempt, wrapper.due_at);
  const serialized = JSON.stringify(wrapper);
  try {
    // Replace the verified source first; if interrupted, the signed wrapper
    // remains recoverable in the active lane rather than leaving raw ingress.
    queue.replaceIfMatches(name, queueExpected(expected), serialized);
    queue.ensureDirectory(retryDirectory);
    queue.moveAtomically(name, join(retryDirectory, retryName));
    return true;
  } catch (error) {
    return error instanceof BoundedQueueError && error.code === "not_found";
  }
}

function removeArchivedOutboxObligation(runtimeAccess: RuntimeAccess, runId: string, entryName: string, storedBytes: Uint8Array, expectedStateRevision: number, fence?: MutationFence): number | null {
  assertMutationLive(fence);
  const candidates = runtimeAccess.readOutboxDeliveryObligations(runId).filter((obligation) => obligation.entry_name === entryName);
  if (candidates.length === 0) return null;
  const exact = candidates.find((obligation) => Buffer.from(obligation.json).equals(Buffer.from(storedBytes)));
  if (!exact) throw new Error("outbox delivery obligation does not match archived bytes");
  assertMutationLive(fence);
  const removed = runtimeAccess.removeOutboxDeliveryObligation(runId, entryName, exact.envelope_id);
  if (!removed) {
    throw new Error("outbox delivery obligation could not be removed after archival");
  }
  assertMutationLive(fence);
  const latestState = runtimeAccess.readState(runId);
  const latestRevision = typeof latestState?.state_revision === "number" && Number.isSafeInteger(latestState.state_revision)
    ? latestState.state_revision
    : null;
  if (latestRevision === null || latestRevision <= expectedStateRevision) {
    throw new Error("outbox delivery state changed during archival");
  }
  return latestRevision;
}

function archiveOutboxEntry(
  root: string,
  outboxQueue: BoundedQueue,
  activeDirectory: string,
  sourceName: string,
  archiveName: string,
  envelopeText: string,
  pinnedRoot?: PinnedProjectRoot,
  fence?: MutationFence,
): void {
  assertMutationLive(fence);
  try {
    outboxQueue.ensureDirectory(join(outboxQueue.relativeDirectory, "sent"));
    assertMutationLive(fence);
  } catch (error) {
    rethrowActivationFailure(error);
    throw error;
  }
  if (sourceName === archiveName) {
    assertMutationLive(fence);
    try {
      const source = outboxQueue.read(sourceName);
      try {
        outboxQueue.moveToIfMatches(sourceName, source.expectation, join(outboxQueue.relativeDirectory, "sent", archiveName));
        assertMutationLive(fence);
      } catch (error) {
        rethrowActivationFailure(error);
        if (!(error instanceof BoundedQueueError) || error.code !== "exists") throw error;
        // A pre-existing sent copy is not transport proof. It is accepted only
        // after the current adapter returned a successful authenticated receipt;
        // then remove the exact active source idempotently.
        const sentQueue = openBoundedQueue(pinnedRoot?.canonical_root ?? root, join(activeDirectory, "sent"), {
          ...ACTIVE_QUEUE_OPTIONS,
          createDirectory: false,
          ...(pinnedRoot ? { pinnedRoot } : {}),
        });
        if (!sentQueue) throw error;
        try {
          const archived = sentQueue.read(archiveName);
          if (!Buffer.from(archived.bytes).equals(Buffer.from(source.bytes))) throw error;
          assertMutationLive(fence);
          outboxQueue.removeIfMatches(sourceName, queueExpected(source));
          assertMutationLive(fence);
        } finally {
          sentQueue.close();
        }
      }
    } catch (error) {
      rethrowActivationFailure(error);
      throw error;
    }
    return;
  }
  const sentQueue = openBoundedQueue(pinnedRoot?.canonical_root ?? root, join(activeDirectory, "sent"), {
    ...ACTIVE_QUEUE_OPTIONS,
    ...(pinnedRoot ? { pinnedRoot } : {}),
  });
  if (!sentQueue) throw new BoundedQueueError("not_found", "sent archive queue is unavailable");
  try {
    try {
      assertMutationLive(fence);
      sentQueue.writeExclusive(archiveName, envelopeText);
      assertMutationLive(fence);
    } catch (error) {
      rethrowActivationFailure(error);
      if (!(error instanceof BoundedQueueError) || error.code !== "exists") throw error;
      const existing = sentQueue.read(archiveName);
      if (!Buffer.from(existing.bytes).equals(Buffer.from(envelopeText, "utf8"))) throw error;
      assertMutationLive(fence);
    }
    const source = outboxQueue.read(sourceName);
    try {
      assertMutationLive(fence);
      outboxQueue.removeIfMatches(sourceName, queueExpected(source));
      assertMutationLive(fence);
    } catch (error) {
      rethrowActivationFailure(error);
      throw error;
    }
  } finally {
    sentQueue.close();
  }
}

function moveRetryableEntry(
  root: string,
  queue: BoundedQueue,
  name: string,
  retryDirectory: string,
  now: number,
  runId: string,
  stateRevision: number,
  pinnedRoot?: PinnedProjectRoot,
  immediateFirstRetry = false,
  runtimeAccess?: RuntimeAccess,
  fence?: MutationFence,
  retryMatchStateStore?: Map<string, unknown>,
): boolean {
  let source: { dev: number; ino: number; bytes: Uint8Array };
  let originalName: string;
  try {
    if (retryActiveMetadata(name)) return false;
    source = queue.read(name);
    const raw = JSON.parse(decodeUtf8(source.bytes)) as Record<string, unknown>;
    if (!raw || Array.isArray(raw) || typeof raw.id !== "string") return false;
    originalName = canonicalDurableIdFileName(raw.id);
    if (originalName !== name || !runtimeAccess) return false;
    const precheckStatus = currentDeliveryStatus(runtimeAccess, { run_id: runId, state_revision: stateRevision, entry_name: name, json: source.bytes, lane: "outbox", routing_binding: routingBindingForBytes(runtimeAccess, source.bytes, pinnedRoot) ?? undefined }, pinnedRoot);
    if (precheckStatus !== "current") return false;
  } catch (error) {
    rethrowActivationFailure(error);
    return false;
  }
  let retryQueue: BoundedQueue | null;
  try {
    retryQueue = openBoundedQueue(pinnedRoot?.canonical_root ?? root, retryDirectory, { ...ACTIVE_QUEUE_OPTIONS, ...(pinnedRoot ? { pinnedRoot } : {}) });
  } catch {
    return false;
  }
  if (!retryQueue) return false;
  try {
    const sourceBytes = source.bytes;
    const matchingRetries: Array<{ name: string; metadata: RetryLaneEntry }> = [];
    for (const entry of boundedQueueEntries(retryQueue)) {
      const metadata = parseRetryLaneEntry(entry.name);
      if (!metadata || metadata.version !== "r2" || metadata.originalNameHash !== retryOriginalNameHash(originalName)) continue;
      try {
        const observed = retryQueue.read(entry.name);
        if (Buffer.from(observed.bytes).equals(Buffer.from(sourceBytes))) matchingRetries.push({ name: entry.name, metadata });
      } catch (error) {
        rethrowActivationFailure(error);
      }
    }
    const retryStateKey = runId + "\u0000" + originalName;
    const storedState = retryMatchStateStore?.get(retryStateKey);
    const storedAttempt = typeof storedState === "number"
      ? storedState
      : storedState && typeof storedState === "object" && typeof (storedState as { attempt?: unknown }).attempt === "number"
        ? (storedState as { attempt: number }).attempt
        : 0;
    const previousAttempt = Math.max(matchingRetries.reduce((max, item) => Math.max(max, item.metadata.attempt), 0), Number.isSafeInteger(storedAttempt) ? storedAttempt : 0);
    const attempt = Math.min(RETRY_MAX_ATTEMPT, previousAttempt + 1);
    const dueAt = immediateFirstRetry && previousAttempt === 0 ? now : retryDueAt(attempt, now);
    const retryName = retryLaneEntryName(originalName, attempt, dueAt);
    retryMatchStateStore?.set(retryStateKey, { attempt, retryName });
    const writeSameOrExclusive = (entryName: string): boolean => {
      try {
        retryQueue!.writeExclusive(entryName, sourceBytes);
        return true;
      } catch (error) {
        rethrowActivationFailure(error);
        if (!(error instanceof BoundedQueueError) || error.code !== "exists") throw error;
        const existing = retryQueue!.read(entryName);
        if (!Buffer.from(existing.bytes).equals(Buffer.from(sourceBytes))) throw error;
        return false;
      }
    };
    assertMutationLive(fence);
    const retryCreated = writeSameOrExclusive(retryName);
    assertMutationLive(fence);
    // The source remains in the authenticated outbox lane until this exact
    // stored payload has been checked again at the retry boundary.
    const postWriteStatus = currentDeliveryStatus(runtimeAccess, { run_id: runId, state_revision: stateRevision, entry_name: name, json: sourceBytes, lane: "outbox", routing_binding: routingBindingForBytes(runtimeAccess, sourceBytes, pinnedRoot) ?? undefined }, pinnedRoot);
    if (postWriteStatus !== "current") {
      if (retryCreated && postWriteStatus === "invalid") {
        try { retryQueue!.removeIfMatches(retryName, queueExpected(retryQueue!.read(retryName))); } catch (error) { rethrowActivationFailure(error); }
      }
      return false;
    }
    if (!runtimeAccess.markDeliveryPending(runId, stateRevision, "retry")) {
      // Never remove a pre-existing identical retry record; only this call's
      // newly-created copy is eligible for rollback on a failed mark.
      if (retryCreated) {
        try { retryQueue!.removeIfMatches(retryName, queueExpected(retryQueue!.read(retryName))); } catch (error) { rethrowActivationFailure(error); }
      }
      return false;
    }
    assertMutationLive(fence);
    const retryStatus = currentDeliveryStatus(runtimeAccess, { run_id: runId, state_revision: stateRevision, entry_name: originalName, storage_entry_name: retryName, json: sourceBytes, lane: "retry", routing_binding: routingBindingForBytes(runtimeAccess, sourceBytes, pinnedRoot) ?? undefined }, pinnedRoot);
    if (retryStatus !== "current") {
      if (retryStatus === "invalid") {
        try { runtimeAccess.markDeliveryPending(runId, stateRevision, "outbox"); } catch (error) { rethrowActivationFailure(error); }
        if (retryCreated) {
          try { retryQueue!.removeIfMatches(retryName, queueExpected(retryQueue!.read(retryName))); } catch (error) { rethrowActivationFailure(error); }
        }
      }
      // unavailable after markDeliveryPending deliberately preserves both
      // lane copies and their additive pending flags for the next tick.
      return false;
    }
    // Supersede an older same-payload schedule after the new exact record is
    // authenticated; preserving one r2 schedule bounds replay work.
    for (const old of matchingRetries) {
      if (old.name === retryName) continue;
      try { retryQueue.removeIfMatches(old.name, queueExpected(retryQueue.read(old.name))); } catch (error) { rethrowActivationFailure(error); }
    }
    assertMutationLive(fence);
    queue.removeIfMatches(name, queueExpected(source));
    assertMutationLive(fence);
    return true;
  } catch (error) {
    rethrowActivationFailure(error);
    return error instanceof BoundedQueueError && error.code === "not_found";
  } finally {
    retryQueue.close();
  }
}

function clearPromotedRetryEntries(
  root: string,
  retryDirectory: string,
  originalName: string,
  sourceBytes: Uint8Array,
  pinnedRoot?: PinnedProjectRoot,
  fence?: MutationFence,
  retryState?: unknown,
): void {
  const retryQueue = openBoundedQueue(pinnedRoot?.canonical_root ?? root, retryDirectory, { ...ACTIVE_QUEUE_OPTIONS, createDirectory: false, ...(pinnedRoot ? { pinnedRoot } : {}) });
  if (!retryQueue) return;
  const retainedRetryName = retryState && typeof retryState === "object" && typeof (retryState as { retryName?: unknown }).retryName === "string"
    ? (retryState as { retryName: string }).retryName
    : undefined;
  try {
    const expectedHash = retryOriginalNameHash(originalName);
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 1_024; pageIndex += 1) {
      let page: { entries: Array<{ name: string; relativePath: string }>; nextCursor: string | null };
      try {
        page = retainedRetryName
          ? { entries: [{ name: retainedRetryName, relativePath: retryQueue.path(retainedRetryName) }], nextCursor: null }
          : retryQueue.listPage(cursor);
      } catch (error) {
        rethrowActivationFailure(error);
        if ((error instanceof BoundedQueueError && error.code === "not_found") || String(error).includes("anchored path does not exist")) return;
        throw error;
      }
      for (const entry of page.entries) {
        const metadata = parseRetryLaneEntry(entry.name);
        if (!metadata || metadata.version !== "r2" || metadata.originalNameHash !== expectedHash) continue;
        let observed: { dev: number; ino: number; bytes: Uint8Array };
        try {
          observed = retryQueue.read(entry.name);
        } catch (error) {
          rethrowActivationFailure(error);
          continue;
        }
        if (!Buffer.from(observed.bytes).equals(Buffer.from(sourceBytes))) continue;
        try {
          assertMutationLive(fence);
          retryQueue.removeIfMatches(entry.name, queueExpected(observed));
          assertMutationLive(fence);
        } catch (error) {
          rethrowActivationFailure(error);
          if (!(error instanceof BoundedQueueError) || error.code !== "not_found") throw error;
        }
      }
      if (retainedRetryName || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  } finally {
    retryQueue.close();
  }
}

function promoteOutboxRetryEntry(
  root: string,
  activeDirectory: string,
  rejectedDirectory: string,
  retryQueue: BoundedQueue,
  entryName: string,
  metadata: RetryLaneEntry,
  pinnedRoot?: PinnedProjectRoot,
  fence?: MutationFence,
  runtimeAccess?: RuntimeAccess,
  runId?: string,
  stateRevision?: number,
  onRejected?: (entryName: string, reason: string) => void,
  retryMatchStateStore?: Map<string, unknown>,
): boolean {
  let entryExpected: BoundedQueueEntryExpectation | undefined;
  try { entryExpected = retryQueue.classify(entryName); } catch (error) { rethrowActivationFailure(error); }
  if (metadata.version !== "r2" || !runtimeAccess || !runId || !Number.isSafeInteger(stateRevision)) {
    if (metadata.version === "r1") { quarantineQueueEntry(retryQueue, entryName, entryExpected, rejectedDirectory, fence); onRejected?.(entryName, "legacy retry wrapper is not authenticated"); }
    return metadata.version === "r1";
  }
  const authenticatedStateRevision = stateRevision as number;
  let observed: { dev: number; ino: number; bytes: Uint8Array; expectation: BoundedQueueEntryExpectation } | undefined;
  let originalName: string;
  try {
    observed = retryQueue.read(entryName);
    const raw = JSON.parse(decodeUtf8(observed.bytes)) as Record<string, unknown>;
    if (!raw || Array.isArray(raw) || typeof raw.id !== "string") throw new Error("retry payload is not a canonical envelope");
    originalName = canonicalDurableIdFileName(raw.id);
    if (retryOriginalNameHash(originalName) !== metadata.originalNameHash) throw new Error("retry filename identity does not match envelope");
    const retryStatus = currentDeliveryStatus(runtimeAccess, {
      run_id: runId,
      state_revision: authenticatedStateRevision,
      entry_name: originalName,
      storage_entry_name: entryName,
      json: observed.bytes,
      lane: "retry",
      routing_binding: routingBindingForBytes(runtimeAccess, observed.bytes, pinnedRoot) ?? undefined,
    }, pinnedRoot);
    if (retryStatus === "unavailable") return false;
    if (retryStatus === "invalid") throw new UnauthorizedDeliveryError();
  } catch (error) {
    rethrowActivationFailure(error);
    if (error instanceof UnauthorizedDeliveryError) {
      quarantineQueueEntry(retryQueue, entryName, observed?.expectation, rejectedDirectory, fence); onRejected?.(entryName, "outbox delivery is not the current authenticated publication");
      return true;
    }
    // Parse, structural, and authority failures without a definitive core
    // invalid result preserve the retry bytes for a later authoritative tick.
    return false;
  }
  if (!observed) return false;
  const observedEntry = observed;
  const activeQueue = openBoundedQueue(pinnedRoot?.canonical_root ?? root, activeDirectory, { ...ACTIVE_QUEUE_OPTIONS, ...(pinnedRoot ? { pinnedRoot } : {}) });
  if (!activeQueue) return false;
  try {
    // A workspace sent copy is never transport proof. Always promote the
    // authenticated retry and invoke the adapter.
    let existing: { dev: number; ino: number; bytes: Uint8Array; expectation?: BoundedQueueEntryExpectation } | null = null;
    try {
      const activeInfo = pinnedRoot?.pathEntryInfo(join(activeDirectory, originalName));
      if (activeInfo !== null) existing = activeQueue.read(originalName);
    } catch (error) {
      rethrowActivationFailure(error);
      if (!(error instanceof BoundedQueueError) || (error.code !== "not_found" && error.code !== "write_failed")) return false;
    }
    if (existing && !Buffer.from(existing.bytes).equals(Buffer.from(observedEntry.bytes))) {
      quarantineQueueEntry(retryQueue, entryName, observedEntry.expectation, rejectedDirectory, fence); onRejected?.(entryName, "outbox retry conflicts with an active delivery");
      return true;
    }
    if (!existing) {
      assertMutationLive(fence);
      activeQueue.writeExclusive(originalName, observedEntry.bytes);
      assertMutationLive(fence);
    }
    assertMutationLive(fence);
    if (!runtimeAccess.markDeliveryPending(runId, authenticatedStateRevision, "outbox")) {
      if (!existing) {
        try { activeQueue.removeIfMatches(originalName, queueExpected(activeQueue.read(originalName))); } catch (cleanupError) { rethrowActivationFailure(cleanupError); }
      }
      return false;
    }
    assertMutationLive(fence);
    const promotedStatus = currentDeliveryStatus(runtimeAccess, {
      run_id: runId,
      state_revision: authenticatedStateRevision,
      entry_name: originalName,
      json: observedEntry.bytes,
      lane: "outbox",
      routing_binding: routingBindingForBytes(runtimeAccess, observedEntry.bytes, pinnedRoot) ?? undefined,
    }, pinnedRoot);
    if (promotedStatus !== "current") {
      if (promotedStatus === "invalid") {
        if (!existing) {
          try { activeQueue.removeIfMatches(originalName, queueExpected(activeQueue.read(originalName))); } catch (cleanupError) { rethrowActivationFailure(cleanupError); }
        }
        try { runtimeAccess.markDeliveryPending(runId, authenticatedStateRevision, "retry"); } catch (rollbackError) { rethrowActivationFailure(rollbackError); }
      }
      // unavailable after markDeliveryPending preserves retry + active copies
      // and additive pending flags for the next tick.
      return false;
    }
    // Keep the authenticated retry source beside the promoted active copy
    // until transport success. If the send fails, the next retry wrapper can
    // derive the monotonic attempt without an in-memory context; success
    // removes the exact retained wrapper before archival.
    retryMatchStateStore?.set(runId + "\u0000" + originalName, { attempt: metadata.attempt, retryName: entryName });
    assertMutationLive(fence);
    return true;
  } catch (error) {
    rethrowActivationFailure(error);
    return error instanceof BoundedQueueError && error.code === "not_found";
  } finally {
    activeQueue.close();
  }
}

function queueHasActiveWork(queue: BoundedQueue, archiveDirectory: "sent" | "processed"): boolean {
  try {
    for (const entry of boundedQueueEntries(queue)) {
      if (entry.name === archiveDirectory && isArchiveDirectory(queue, entry.name)) continue;
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function promoteRetryEntries(root: string, activeDirectory: string, retryDirectory: string, rejectedDirectory: string, kind: "outbox" | "inbox", now = Date.now(), pinnedRoot?: PinnedProjectRoot, retrySecret?: string | null | (() => string | null), runtimeAccess?: RuntimeAccess, lifecycle?: AdapterOperationContext, deliveryRunId?: string, deliveryStateRevision?: number, onRejected?: (entryName: string, reason: string) => void, retryCursorStore?: Map<string, string | null>, retryMatchStateStore?: Map<string, unknown>): number {
  const fence: MutationFence = { pinnedRoot, runtimeAccess, lifecycle };
  const retryCursorKey = retryDirectory;
  const retryCursor = retryCursorStore?.get(retryCursorKey) ?? null;
  assertMutationLive(fence);
  const retryQueue = openBoundedQueue(pinnedRoot?.canonical_root ?? root, retryDirectory, { ...ACTIVE_QUEUE_OPTIONS, createDirectory: false, ...(pinnedRoot ? { pinnedRoot } : {}) });
  if (!retryQueue) return 0;
  let promoted = 0;
  let resolvedRetrySecret: string | null | undefined;
  const currentRetrySecret = (): string | null => {
    if (resolvedRetrySecret === undefined) {
      resolvedRetrySecret = typeof retrySecret === "function" ? retrySecret() : (retrySecret ?? null);
    }
    return resolvedRetrySecret;
  };
  try {
    const retryPage = retryQueue.listPage(retryCursor);
    const retryEntries = retryPage.entries;
    retryCursorStore?.set(retryCursorKey, retryPage.nextCursor);
    for (const entry of retryEntries) {
      let entryExpected: BoundedQueueEntryExpectation | undefined;
      try { entryExpected = retryQueue.classify(entry.name); } catch (error) { rethrowActivationFailure(error); }
      const metadata = parseRetryLaneEntry(entry.name);
      if (!metadata) {
        // Retry lanes are self-describing by their bounded r2 filename. Raw
        // canonical files outside that grammar are legacy/forged records and
        // must never become an authenticated publication.
        quarantineQueueEntry(retryQueue, entry.name, entryExpected, rejectedDirectory, fence); onRejected?.(entry.name, "retry entry is not authenticated");
        continue;
      }
      let verified: VerifiedInboxRetry | null = null;
      if (kind === "inbox") {
        let rawRetry: unknown;
        try { rawRetry = retryQueue.readJson<unknown>(entry.name); } catch { rawRetry = null; }
        // Do not open/create the retry secret for an idle inbox or arbitrary
        // malformed lane entry. A secret is needed only for an actual signed
        // inbox-retry candidate.
        const isInboxRetryCandidate = Boolean(rawRetry && typeof rawRetry === "object" && (rawRetry as { kind?: unknown }).kind === "inbox-retry");
        if (isInboxRetryCandidate) {
          try { verified = verifyInboxRetryWrapper(root, rawRetry, pinnedRoot, currentRetrySecret()); } catch { /* invalid wrapper is rejected below */ }
        }
        const nameMatches = verified
          && (metadata.version === "r2"
            ? retryOriginalNameHash(verified.wrapper.original_name) === metadata.originalNameHash
            : verified.wrapper.original_name === metadata.originalName);
        if (!verified || !nameMatches || verified.wrapper.attempt !== metadata.attempt || verified.wrapper.due_at !== metadata.dueAt) {
          quarantineQueueEntry(retryQueue, entry.name, entryExpected, rejectedDirectory, fence); onRejected?.(entry.name, "retry entry is not authenticated");
          continue;
        }
      } else if (metadata.version === "r2") {
        try {
          const raw = retryQueue.readJson<unknown>(entry.name);
          const id = raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as { id?: unknown }).id === "string"
            ? (raw as { id: string }).id
            : null;
          const originalName = id === null ? null : canonicalDurableIdFileName(id);
          if (!originalName || retryOriginalNameHash(originalName) !== metadata.originalNameHash) {
            quarantineQueueEntry(retryQueue, entry.name, entryExpected, rejectedDirectory, fence); onRejected?.(entry.name, "retry entry is not authenticated");
            continue;
          }
        } catch (error) {
          rethrowActivationFailure(error);
          quarantineQueueEntry(retryQueue, entry.name, entryExpected, rejectedDirectory, fence); onRejected?.(entry.name, "retry entry is not authenticated");
          continue;
        }
      }
      assertMutationLive(fence);
      if (metadata.dueAt > now) continue;
      if (kind === "outbox") {
        const moved = promoteOutboxRetryEntry(root, activeDirectory, rejectedDirectory, retryQueue, entry.name, metadata, pinnedRoot, fence, runtimeAccess, deliveryRunId, deliveryStateRevision, onRejected, retryMatchStateStore);
        if (moved) promoted += 1;
        continue;
      }
      const resolvedMetadata: RetryLaneEntry = verified
        ? { ...metadata, originalName: verified.wrapper.original_name, originalNameHash: retryOriginalNameHash(verified.wrapper.original_name) }
        : metadata;
      let moved = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const destination = join(activeDirectory, retryActiveEntryName(resolvedMetadata));
        try {
          assertMutationLive(fence);
          retryQueue.moveAtomically(entry.name, destination);
          assertMutationLive(fence);
          moved = true;
          break;
        } catch (error) {
          rethrowActivationFailure(error);
          if (error instanceof BoundedQueueError && (error.code === "exists" || error.code === "not_found")) continue;
          break;
        }
      }
      if (moved) promoted += 1;
    }
  } finally {
    retryQueue.close();
  }
  return promoted;
}

const RUN_DELIVERY_PAGE_LIMIT = 8;
const MAX_LEASE_CLOCK_SKEW_MS = 5_000;

interface DispatcherLeaseRecord {
  schema: 2;
  activation: RegistryContextSnapshot;
  pid: number;
  start_identity: string;
  root_identity: string;
  root_dev: number;
  root_ino: number;
  token: string;
  epoch: number;
  startedAt: string;
  heartbeatAt: string;
  run_cursor?: string | null;
  outbox_run_id?: string | null;
  outbox_cursor?: string | null;
  session_id: string;
  proof: string;
}

interface DispatcherLease {
  root: string;
  lexicalRoot: string;
  canonicalRoot: string;
  rootDev: number;
  rootIno: number;
  path: string;
  token: string;
  epoch: number;
  runCursor: string | null;
  directOutboxRunId: string | null;
  directOutboxCursor: string | null;
  session_id: string;
  activation: RegistryContextSnapshot;
}

/** Cross-process ownership file: one messenger dispatcher per project cwd. */
export function dispatcherLockPath(root: string): string {
  return join(root, ".omp", "cto-dispatcher.lock");
}

function queueExpected(read: { dev: number; ino: number; bytes: Uint8Array }): { dev: number; ino: number; sha256: string } {
  return { dev: read.dev, ino: read.ino, sha256: createHash("sha256").update(read.bytes).digest("hex") };
}

function openControlQueue(root: string, createDirectory = true, pinnedRoot?: PinnedProjectRoot): BoundedQueue | null {
  return openBoundedQueue(pinnedRoot?.canonical_root ?? root, ".omp", { ...CONTROL_QUEUE_OPTIONS, createDirectory, pinnedRoot });
}
/** Return one bounded control-plane page; later ticks revisit remaining entries. */
function* boundedQueueEntries(queue: BoundedQueue): Generator<{ name: string; relativePath: string }> {
  for (const entry of queue.list()) yield entry;
}

function compareCanonicalRunIds(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

type IndexedRunPage = { entries: CtoRunDeliveryIndexEntry[]; nextCursor: string | null };

/** Return one bounded control-plane page; later ticks revisit remaining entries. */
function readIndexedRunPage(root: string, cursor: string | null = null, providedRoot?: PinnedProjectRoot, runtimeAccess?: RuntimeAccess): IndexedRunPage {
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return { entries: [], nextCursor: null };
  if (!runtimeAccess) {
    if (!providedRoot) pinnedRoot.close();
    return { entries: [], nextCursor: null };
  }
  try {
    const active = runtimeAccess.readActiveDeliveryCandidates();
    const terminal = runtimeAccess.readCompletedDeliveryCandidates();
    // Candidate projections are observational: core validates the exact
    // current index/state pair without deriving pending authority from queue
    // files. If one projection is unavailable, the explicit cursor keeps the
    // bounded index fallback non-reconciling as well.
    const sourceEntries: readonly CtoRunDeliveryIndexEntry[] = active.ok && terminal.ok
      ? [...active.entries, ...terminal.entries]
      : runtimeAccess.readDeliveryIndexPage({
        ...(cursor === null ? {} : { after_run_id: cursor }),
        limit: RUN_DELIVERY_PAGE_LIMIT,
      }).entries;
    const merged = new Map<string, CtoRunDeliveryIndexEntry>();
    for (const entry of sourceEntries) {
      const previous = merged.get(entry.run_id);
      if (
        !previous
        || entry.updated_at > previous.updated_at
        || (entry.updated_at === previous.updated_at && entry.state_revision > previous.state_revision)
        || (
          entry.updated_at === previous.updated_at
          && entry.state_revision === previous.state_revision
          && JSON.stringify(entry) < JSON.stringify(previous)
        )
      ) {
        merged.set(entry.run_id, entry);
      }
    }
    const entries = [...merged.values()]
      .filter((entry) => cursor === null || compareCanonicalRunIds(entry.run_id, cursor) > 0)
      .sort((left, right) =>
        compareCanonicalRunIds(left.run_id, right.run_id)
        || right.updated_at.localeCompare(left.updated_at)
        || right.state_revision - left.state_revision,
      )
      .slice(0, RUN_DELIVERY_PAGE_LIMIT);
    const nextCursor = entries.length === RUN_DELIVERY_PAGE_LIMIT ? (entries.at(-1)?.run_id ?? null) : null;
    return { entries, nextCursor };
  } catch {
    return { entries: [], nextCursor: null };
  } finally {
    if (!providedRoot) pinnedRoot.close();
  }
}
interface DirectOutboxDiscovery {
  runId: string | null;
  stateRevision: number | null;
  nextCursor: string | null;
  entryName: string | null;
  entry: CtoRunDeliveryIndexEntry | null;
}

/**
 * Discover direct agent writes for the single active run. Every observed
 * invalid/foreign entry is moved to a durable rejected namespace as one
 * bounded batch; valid entries remain in place for the targeted drain.
 */
function discoverDirectOutbox(
  root: string,
  previousRunId: string | null,
  previousCursor: string | null,
  providedRoot?: PinnedProjectRoot,
  runtimeAccess?: RuntimeAccess,
  lifecycle?: AdapterOperationContext,
): DirectOutboxDiscovery {
  const empty = (runId: string | null, stateRevision: number | null, nextCursor: string | null = null): DirectOutboxDiscovery => ({
    runId,
    stateRevision,
    nextCursor,
    entryName: null,
    entry: null,
  });
  if (!runtimeAccess) return empty(previousRunId, null, previousCursor);
  const withinDeadline = (): boolean => {
    lifecycle?.assertLive?.();
    return lifecycle === undefined || Date.now() < lifecycle.deadline;
  };
  if (!withinDeadline()) return empty(previousRunId, null, previousCursor);
  if (providedRoot && !providedRoot.isStable()) throw new DispatcherActivationRevokedError("dispatcher project root identity changed");
  let active: { runId: string; state: RuntimeStateView } | null;
  try {
    active = runtimeActive(runtimeAccess);
    assertMutationLive({ pinnedRoot: providedRoot, runtimeAccess, lifecycle });
  } catch (error) {
    lifecycle?.assertLive?.();
    runtimeAccess.assertLive();
    return empty(previousRunId, null, previousCursor);
  }
  if (!active) return empty(previousRunId, null, previousCursor);
  const revision = active.state.state_revision;
  if (!safeRunId(active.runId) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    return empty(null, null);
  }
  const runId = active.runId;
  const stateRevision = revision;
  const scanCursor = previousRunId === runId ? previousCursor : null;
  const queue = openBoundedQueue(providedRoot?.canonical_root ?? root, join(".work-state", "cto", runId, "outbox"), {
    ...DIRECT_OUTBOX_QUEUE_OPTIONS,
    createDirectory: false,
    ...(providedRoot ? { pinnedRoot: providedRoot } : {}),
  });
  if (!queue) return empty(runId, stateRevision, scanCursor);
  const noEntry = (nextCursor: string | null = scanCursor): DirectOutboxDiscovery => empty(runId, stateRevision, nextCursor);
  try {
    // Direct discovery is recovery-only: authenticate the exact active/standby
    // projection before reading attacker-controlled queue bytes. A single
    // projection read replaces the old unbounded page walk; any non-ok or
    // ambiguous match remains fail-closed.
    if (!withinDeadline()) return noEntry();
    const candidates = runtimeAccess.readActiveDeliveryCandidates();
    if (!candidates.ok || !Array.isArray(candidates.entries) || candidates.active_run_id !== runId) return noEntry();
    const expectedStatus = active.state.standby === true ? "standby" : "active";
    const matches = candidates.entries.filter((entry) =>
      entry.run_id === runId
      && entry.state_revision === stateRevision
      && entry.updated_at === active.state.updated_at
      && entry.status === expectedStatus
      && (entry.pending_outbox === true || entry.pending_retry === true));
    if (matches.length !== 1) return noEntry();
    const indexEntry = matches[0]!;

    // State-owned obligations identify the exact canonical publication without
    // scanning an attacker-controlled overfull outbox first. Probe those names
    // before the bounded recovery scanner and preserve the current scan cursor
    // when an obligation is found.
    if (!withinDeadline()) return noEntry();
    const obligations = runtimeAccess.readOutboxDeliveryObligations(runId);
    for (const obligation of obligations) {
      if (!withinDeadline()) return noEntry();
      if (obligation.run_id !== runId || obligation.state_revision !== stateRevision) continue;
      if (!withinDeadline()) return noEntry();
      let stored: { bytes: Uint8Array; expectation: BoundedQueueEntryExpectation & { kind: "file" } };
      try {
        stored = queue.read(obligation.entry_name);
      } catch (error) {
        if (isDispatcherActivationFailure(error)) throw error;
        continue;
      }
      if (!withinDeadline()) return noEntry();
      const status = currentDeliveryStatus(runtimeAccess, {
        run_id: runId,
        state_revision: stateRevision,
        entry_name: obligation.entry_name,
        json: stored.bytes,
        lane: "outbox",
        routing_binding: routingBindingForBytes(runtimeAccess, stored.bytes, providedRoot) ?? undefined,
      }, providedRoot);
      if (status === "current") {
        if (!withinDeadline()) return noEntry();
        return { runId, stateRevision, nextCursor: scanCursor, entryName: obligation.entry_name, entry: indexEntry };
      }
    }

    if (!withinDeadline()) return noEntry();
    let page: ReturnType<BoundedQueue["listPage"]>;
    try {
      page = queue.listPage(scanCursor);
    } catch (error) {
      if (isDispatcherActivationFailure(error)) throw error;
      // Unsafe names and listing failures remain in place and block recovery.
      return noEntry();
    }
    let completePage = true;
    const validNames: string[] = [];
    const rejectedEntries: { name: string; expected: BoundedQueueEntryExpectation }[] = [];
    for (const item of page.entries) {
      if (!withinDeadline()) {
        completePage = false;
        break;
      }
      if (item.name === "sent" && isArchiveDirectory(queue, item.name)) continue;
      let status: DeliveryAuthorityStatus = "unavailable";
      let expected: BoundedQueueEntryExpectation | undefined;
      try {
        if (!withinDeadline()) {
          completePage = false;
          break;
        }
        const stored = queue.read(item.name);
        expected = stored.expectation;
        if (!withinDeadline()) {
          completePage = false;
          break;
        }
        status = currentDeliveryStatus(runtimeAccess, {
          run_id: runId,
          state_revision: stateRevision,
          entry_name: item.name,
          json: stored.bytes,
          lane: "outbox",
          routing_binding: routingBindingForBytes(runtimeAccess, stored.bytes, providedRoot) ?? undefined,
        }, providedRoot);
      } catch (error) {
        if (isDispatcherActivationFailure(error)) throw error;
      }
      if (status === "current") validNames.push(item.name);
      else if (status === "invalid" && expected) rejectedEntries.push({ name: item.name, expected });
      // Unavailable remains in the scanner for a later authoritative tick.
    }
    if (rejectedEntries.length > 0) {
      if (!withinDeadline()) completePage = false;
      else {
        runtimeAccess.assertLive();
        if (providedRoot && !providedRoot.isStable()) throw new DispatcherActivationRevokedError("dispatcher project root identity changed");
        queue.discardBatch(rejectedEntries, join(".work-state", "cto", runId, "outbox-rejected"));
        lifecycle?.assertLive?.();
      }
    }
    if (!withinDeadline()) return noEntry(completePage && validNames.length === 0 ? page.nextCursor : scanCursor);
    const entryName = validNames[0] ?? null;
    const nextCursor = completePage ? page.nextCursor : scanCursor;
    return entryName === null
      ? noEntry(nextCursor)
      : { runId, stateRevision, nextCursor, entryName, entry: indexEntry };
  } catch (error) {
    if (isDispatcherActivationFailure(error)) throw error;
    return noEntry();
  } finally {
    queue.close();
  }
}

function indexedRunEntriesOrRead(root: string, entries?: readonly CtoRunDeliveryIndexEntry[], pinnedRoot?: PinnedProjectRoot, runtimeAccess?: RuntimeAccess): CtoRunDeliveryIndexEntry[] {
  return entries ? [...entries] : readIndexedRunPage(root, null, pinnedRoot, runtimeAccess).entries;
}

function stateRevisionMatches(state: StateView, entry: CtoRunDeliveryIndexEntry): boolean {
  return Number.isSafeInteger(state.state_revision) && state.state_revision === entry.state_revision;
}

function stateDeliveryStatus(state: StateView): CtoRunDeliveryIndexEntry["status"] {
  if (state.pause?.kind === "done") return "done";
  if (state.pause?.kind === "failed") return "failed";
  return state.standby === true ? "standby" : "active";
}

function stateSummaryDigest(state: StateView): string {
  if (!Array.isArray(state.wave_history)) return "";
  const completed = state.wave_history
    .filter((wave) => wave && typeof wave.id === "string" && typeof wave.finished_at === "string")
    .map((wave) => wave.id + "\u0000" + wave.finished_at + "\u0000" + wave.status)
    .sort();
  return completed.length === 0 ? "" : createHash("sha256").update(completed.join("\n")).digest("hex");
}

function stateMatchesRunDeliveryIndex(state: StateView, entry: CtoRunDeliveryIndexEntry): boolean {
  return state.id === entry.run_id
    && stateRevisionMatches(state, entry)
    && stateDeliveryStatus(state) === entry.status
    && state.updated_at === entry.updated_at
    && stateSummaryDigest(state) === entry.summary_digest;
}

/**
 * A run-level pending bit is the only publication binding exposed by the
 * authenticated runtime facade. Require it before draining, and bind every
 * envelope field that is present to that exact run/revision/idempotency lane.
 * Older envelopes may omit the additive run/revision fields; they remain
 * accepted only inside an already-pending indexed lane (the cooperative
 * residual is documented by the core worker's workspace write gate).
 */
function outboxIsEmpty(root: string, runId: string, pinnedRoot?: PinnedProjectRoot): boolean {
  const activeQueue = openBoundedQueue(pinnedRoot?.canonical_root ?? root, join(".work-state", "cto", runId, "outbox"), { ...CONTROL_QUEUE_OPTIONS, createDirectory: false, ...(pinnedRoot ? { pinnedRoot } : {}) });
  if (activeQueue) {
    try {
      for (const entry of activeQueue.list()) {
        if (entry.name === "sent" && isArchiveDirectory(activeQueue, entry.name)) continue;
        return false;
      }
    } catch {
      return false;
    } finally {
      activeQueue.close();
    }
  }
  const retryQueue = openBoundedQueue(pinnedRoot?.canonical_root ?? root, join(".work-state", "cto", runId, "outbox-retry"), { ...CONTROL_QUEUE_OPTIONS, createDirectory: false, ...(pinnedRoot ? { pinnedRoot } : {}) });
  if (!retryQueue) return true;
  try {
    return retryQueue.list().length === 0;
  } catch {
    return false;
  } finally {
    retryQueue.close();
  }
}

const MAX_REJECTED_EVIDENCE_CLEANUP = 1024;

function outboxHasRejectedEvidence(root: string, runId: string, pinnedRoot?: PinnedProjectRoot): boolean {
  const rejectedPath = join(".work-state", "cto", runId, "outbox-rejected");
  const queue = openBoundedQueue(pinnedRoot?.canonical_root ?? root, rejectedPath, {
    ...CONTROL_QUEUE_OPTIONS,
    createDirectory: false,
    ...(pinnedRoot ? { pinnedRoot } : {}),
  });
  if (!queue) return false;
  const scan = (current: BoundedQueue, depth: number, budget: { pages: number; entries: number }): boolean => {
    if (depth > 2) return true;
    let cursor: string | null = null;
    for (;;) {
      if (budget.pages >= MAX_REJECTED_EVIDENCE_CLEANUP) return true;
      budget.pages += 1;
      let page: ReturnType<BoundedQueue["listPage"]>;
      try { page = current.listPage(cursor); } catch { return true; }
      for (const entry of page.entries) {
        budget.entries += 1;
        if (budget.entries > MAX_REJECTED_EVIDENCE_CLEANUP) return true;
        if (!isArchiveDirectory(current, entry.name)) return true;
        const nested = openBoundedQueue(pinnedRoot?.canonical_root ?? root, join(current.relativeDirectory, entry.name), {
          ...CONTROL_QUEUE_OPTIONS,
          createDirectory: false,
          ...(pinnedRoot ? { pinnedRoot } : {}),
        });
        // A listed directory that cannot be safely opened is evidence: fail
        // closed rather than treating a symlink/foreign entry as empty.
        if (!nested) return true;
        try {
          if (scan(nested, depth + 1, budget)) return true;
        } finally {
          nested.close();
        }
      }
      if (page.nextCursor === null) return false;
      cursor = page.nextCursor;
    }
  };
  try { return scan(queue, 0, { pages: 0, entries: 0 }); } finally { queue.close(); }
}


function clearOutboxRejectedEvidence(root: string, runId: string, pinnedRoot?: PinnedProjectRoot, fence?: MutationFence): void {
  const rejectedPath = join(".work-state", "cto", runId, "outbox-rejected");
  const queue = openBoundedQueue(pinnedRoot?.canonical_root ?? root, rejectedPath, {
    ...CONTROL_QUEUE_OPTIONS,
    createDirectory: false,
    ...(pinnedRoot ? { pinnedRoot } : {}),
  });
  if (!queue) return;
  let attempts = 0;
  const clearQueue = (current: BoundedQueue, depth: number): boolean => {
    if (depth > 2 || attempts >= MAX_REJECTED_EVIDENCE_CLEANUP) return false;
    for (;;) {
      assertMutationLive(fence);
      let entries: Array<{ name: string; relativePath: string }>;
      try {
        entries = [...boundedQueueEntries(current)];
      } catch (error) {
        rethrowActivationFailure(error);
        if ((error instanceof BoundedQueueError || error instanceof PinnedRootError) && error.code === "not_found") return true;
        // A changed, unreadable, non-regular, or otherwise unsafe queue is
        // retained as evidence so the next acknowledgement fails closed.
        return false;
      }
      if (entries.length === 0) return true;
      for (const entry of entries) {
        if (attempts >= MAX_REJECTED_EVIDENCE_CLEANUP) return false;
        attempts += 1;
        try {
          assertMutationLive(fence);
          if (isArchiveDirectory(current, entry.name)) {
            const nested = openBoundedQueue(pinnedRoot?.canonical_root ?? root, join(current.relativeDirectory, entry.name), {
              ...CONTROL_QUEUE_OPTIONS,
              createDirectory: false,
              ...(pinnedRoot ? { pinnedRoot } : {}),
            });
            if (!nested) return false;
            let nestedEmpty = false;
            try { nestedEmpty = clearQueue(nested, depth + 1); } finally { nested.close(); }
            if (!nestedEmpty) return false;
            // Remove only the directory just proven empty through its pinned
            // descriptor; races/errors leave it as fail-closed evidence.
            const expected = current.classify(entry.name);
            if (expected.kind !== "directory" || !pinnedRoot) return false;
            assertMutationLive(fence);
            if (!pinnedRoot.removeEmptyDirectoryIfMatches(join(current.relativeDirectory, entry.name), expected)) return false;
          } else {
            const observed = current.read(entry.name);
            current.removeIfMatches(entry.name, queueExpected(observed));
          }
          assertMutationLive(fence);
        } catch (error) {
          rethrowActivationFailure(error);
          if (error instanceof BoundedQueueError && error.code === "not_found") return true;
          // Fail closed on non-activation read/remove errors; retain the
          // evidence and let outboxHasRejectedEvidence block ACK.
          return false;
        }
      }
    }
  };
  try { clearQueue(queue, 0); } finally { queue.close(); }
}


function acknowledgeDrainedRuns(root: string, entries: readonly CtoRunDeliveryIndexEntry[], drained: readonly DrainOutboxResult[], pinnedRoot?: PinnedProjectRoot, runtimeAccess?: RuntimeAccess, lifecycle?: AdapterOperationContext): void {
  if (!runtimeAccess) return;
  const outcomes = new Map<string, { sent: boolean; failed: boolean }>();
  for (const result of drained) {
    const outcome = outcomes.get(result.runId) ?? { sent: false, failed: false };
    if (result.sent) outcome.sent = true; else outcome.failed = true;
    outcomes.set(result.runId, outcome);
  }
  for (const entry of entries) {
    lifecycle?.assertLive?.();
    if (!entry.pending_outbox && !entry.pending_retry && !entry.pending_summary) continue;
    const outcome = outcomes.get(entry.run_id);
    if (!outcome?.sent || outcome.failed) continue;
    if (outboxHasRejectedEvidence(root, entry.run_id, pinnedRoot)) continue;
    const state = runtimeState(runtimeAccess, entry.run_id);
    const stateRevision = state?.state_revision;
    if (!state || typeof stateRevision !== "number" || !Number.isSafeInteger(stateRevision) || stateRevision < 0) continue;
    // Filesystem emptiness alone cannot prove delivery completion: an
    // archive-first crash may leave the exact state-owned obligation behind
    // after the active file has disappeared. Keep ACK fenced until every
    // durable obligation has been removed through exact identity/CAS recovery.
    if (runtimeAccess.readOutboxDeliveryObligations(entry.run_id).length > 0 || !outboxIsEmpty(root, entry.run_id, pinnedRoot)) continue;
    try {
      lifecycle?.assertLive?.();
      runtimeAccess.acknowledgeDelivery(entry.run_id, stateRevision, { drained: true });
      lifecycle?.assertLive?.();
    } catch (error) {
      if (isDispatcherActivationFailure(error)) throw error;
      /* a concurrent state/index transition wins */
    }
  }
}

const BRIDGE_LEASE_PROOF_DOMAIN = "bridge-lease-v1" as const;

function bridgeLeaseProofPayload(record: Omit<DispatcherLeaseRecord, "proof">): string {
  return JSON.stringify({
    schema: record.schema,
    activation: record.activation,
    config: { lease_ttl_ms: DISPATCHER_LEASE_TTL_MS, clock_skew_ms: MAX_LEASE_CLOCK_SKEW_MS },
    owner: { pid: record.pid, start_identity: record.start_identity },
    acquired_at: record.startedAt,
    expires_at: (() => {
      const heartbeat = Date.parse(record.heartbeatAt);
      return Number.isFinite(heartbeat) ? new Date(heartbeat + DISPATCHER_LEASE_TTL_MS).toISOString() : null;
    })(),
    pid: record.pid,
    start_identity: record.start_identity,
    root_identity: record.root_identity,
    root_dev: record.root_dev,
    root_ino: record.root_ino,
    token: record.token,
    session_id: record.session_id ?? null,
    generation: record.epoch,
    startedAt: record.startedAt,
    heartbeatAt: record.heartbeatAt,
    run_cursor: record.run_cursor ?? null,
    outbox_run_id: record.outbox_run_id ?? null,
    outbox_cursor: record.outbox_cursor ?? null,
  });
}

function bridgeLeaseProof(authority: CtoRuntimeProofAuthority, record: Omit<DispatcherLeaseRecord, "proof">): string | null {
  return signCtoRuntimeProof(authority, BRIDGE_LEASE_PROOF_DOMAIN, bridgeLeaseProofPayload(record));
}

function bridgeLeaseProofMatches(authority: CtoRuntimeProofAuthority, record: DispatcherLeaseRecord): boolean {
  if (typeof record.proof !== "string" || !/^[0-9a-f]{64}$/u.test(record.proof)) return false;
  return verifyCtoRuntimeProof(authority, BRIDGE_LEASE_PROOF_DOMAIN, bridgeLeaseProofPayload(record), record.proof);
}

function signBridgeLease<T extends Omit<DispatcherLeaseRecord, "proof">>(authority: CtoRuntimeProofAuthority, record: T): T & Pick<DispatcherLeaseRecord, "proof"> | null {
  const proof = bridgeLeaseProof(authority, record);
  return proof ? { ...record, proof } : null;
}

const CTO_DISPATCHER_LEASE_PROOF_DOMAIN = "cto-dispatcher-lease-v1" as const;

function dispatcherLeaseProof(authority: CtoRuntimeProofAuthority, record: Omit<DispatcherLeaseRecord, "proof">): string | null {
  return signCtoRuntimeProof(authority, CTO_DISPATCHER_LEASE_PROOF_DOMAIN, bridgeLeaseProofPayload(record));
}

function dispatcherLeaseProofMatches(authority: CtoRuntimeProofAuthority, record: DispatcherLeaseRecord): boolean {
  if (typeof record.proof !== "string" || !/^[0-9a-f]{64}$/u.test(record.proof)) return false;
  return verifyCtoRuntimeProof(authority, CTO_DISPATCHER_LEASE_PROOF_DOMAIN, bridgeLeaseProofPayload(record), record.proof);
}

function signDispatcherLease<T extends Omit<DispatcherLeaseRecord, "proof">>(authority: CtoRuntimeProofAuthority, record: T): T & Pick<DispatcherLeaseRecord, "proof"> | null {
  const proof = dispatcherLeaseProof(authority, record);
  return proof ? { ...record, proof } : null;
}

function parseLease(raw: unknown): DispatcherLeaseRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<DispatcherLeaseRecord>;
  if (value.schema !== 2) return null;
  const leaseKeys = ["activation", "epoch", "heartbeatAt", "outbox_cursor", "outbox_run_id", "pid", "proof", "root_dev", "root_identity", "root_ino", "run_cursor", "schema", "session_id", "start_identity", "startedAt", "token"];
  if (Object.keys(value).sort().join("\0") !== leaseKeys.join("\0")) return null;
  const activation = value.activation;
  if (!activation || typeof activation !== "object" || Array.isArray(activation)
    || Object.keys(activation).sort().join("\0") !== ["canonical_root", "claim_generation", "marker_digest", "marker_generation", "owner_fingerprint", "principal_fingerprint", "root_dev", "root_ino"].join("\0")
    || typeof activation.canonical_root !== "string" || activation.canonical_root.length === 0
    || typeof activation.owner_fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(activation.owner_fingerprint)
    || typeof activation.principal_fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(activation.principal_fingerprint)
    || !Number.isSafeInteger(activation.root_dev) || activation.root_dev < 0
    || !Number.isSafeInteger(activation.root_ino) || activation.root_ino < 0
    || !Number.isSafeInteger(activation.claim_generation) || activation.claim_generation < 0
    || !Number.isSafeInteger(activation.marker_generation) || activation.marker_generation < 0
    || typeof activation.marker_digest !== "string" || !/^[0-9a-f]{64}$/u.test(activation.marker_digest)) return null;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.root_identity !== "string" || value.root_identity.length === 0 || value.root_identity.length > 4096) return null;
  if (!Number.isSafeInteger(value.root_dev) || (value.root_dev as number) < 0 || !Number.isSafeInteger(value.root_ino) || (value.root_ino as number) < 0) return null;
  if (typeof value.token !== "string" || value.token.length === 0 || value.token.length > 512) return null;
  if (activation.canonical_root !== value.root_identity || activation.root_dev !== value.root_dev || activation.root_ino !== value.root_ino) return null;
  if (typeof value.startedAt !== "string" || typeof value.heartbeatAt !== "string") return null;
  const startedAt = Date.parse(value.startedAt);
  const heartbeatAt = Date.parse(value.heartbeatAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(heartbeatAt) || startedAt > Date.now() + MAX_LEASE_CLOCK_SKEW_MS || heartbeatAt > Date.now() + MAX_LEASE_CLOCK_SKEW_MS) return null;
  const epoch = value.epoch === undefined ? 0 : value.epoch;
  if (!Number.isSafeInteger(epoch) || epoch < 0) return null;
  const runCursor = value.run_cursor === undefined || value.run_cursor === null ? null : value.run_cursor;
  if (runCursor !== null && (typeof runCursor !== "string" || !safeRunId(runCursor))) return null;
  const outboxRunId = value.outbox_run_id === undefined || value.outbox_run_id === null ? null : value.outbox_run_id;
  if (outboxRunId !== null && (typeof outboxRunId !== "string" || !safeRunId(outboxRunId))) return null;
  const outboxCursor = value.outbox_cursor === undefined || value.outbox_cursor === null ? null : value.outbox_cursor;
  if (outboxCursor !== null && (typeof outboxCursor !== "string" || outboxRunId === null)) return null;
  const startIdentity = value.start_identity;
  if (typeof startIdentity !== "string") return null;
  const proof = typeof value.proof === "string" ? value.proof : "";
  if (typeof value.session_id !== "string" || value.session_id.length === 0 || value.session_id.length > 512) return null;
  const linuxIdentity = startIdentity.startsWith("linux:") && startIdentity.length > 6 && [...startIdentity.slice(6)].every((character) => character >= "0" && character <= "9");
  const psIdentity = startIdentity.startsWith("ps:") && startIdentity.length > 3 && !/[\r\n]/u.test(startIdentity);
  if (!linuxIdentity && !psIdentity) return null;
  return {
    schema: 2,
    activation: {
      canonical_root: activation.canonical_root,
      root_dev: activation.root_dev as number,
      root_ino: activation.root_ino as number,
      owner_fingerprint: activation.owner_fingerprint,
      principal_fingerprint: activation.principal_fingerprint,
      claim_generation: activation.claim_generation as number,
      marker_generation: activation.marker_generation as number,
      marker_digest: activation.marker_digest,
    },
    pid: value.pid,
    start_identity: startIdentity,
    root_identity: value.root_identity,
    root_dev: value.root_dev as number,
    root_ino: value.root_ino as number,
    token: value.token,
    epoch,
    startedAt: value.startedAt,
    heartbeatAt: value.heartbeatAt,
    run_cursor: runCursor,
    outbox_run_id: outboxRunId,
    outbox_cursor: outboxCursor,
    session_id: value.session_id,
    proof,
  };
}
function dispatcherRootMatchesPinnedRoot(root: string, pinnedRoot: PinnedProjectRoot, identity: { lexicalRoot: string; canonicalRoot: string; rootDev: number; rootIno: number }): boolean {
  return bridgeRootMatchesPinnedRoot(root, pinnedRoot, identity);
}

function dispatcherRecordMatchesPinnedRoot(root: string, pinnedRoot: PinnedProjectRoot, record: DispatcherLeaseRecord): boolean {
  return dispatcherRootMatchesPinnedRoot(root, pinnedRoot, {
    lexicalRoot: pinnedRoot.lexical_root,
    canonicalRoot: record.root_identity,
    rootDev: record.root_dev,
    rootIno: record.root_ino,
  });
}

function dispatcherLeaseMatchesPinnedRoot(lease: DispatcherLease, pinnedRoot: PinnedProjectRoot): boolean {
  return dispatcherRootMatchesPinnedRoot(lease.root, pinnedRoot, {
    lexicalRoot: lease.lexicalRoot,
    canonicalRoot: lease.canonicalRoot,
    rootDev: lease.rootDev,
    rootIno: lease.rootIno,
  });
}


type LeaseReadStatus = "missing" | "valid" | "invalid";
type LeaseReadBytes = { dev: number; ino: number; bytes: Uint8Array };
interface DispatcherLeaseReadResult {
  status: LeaseReadStatus;
  record: DispatcherLeaseRecord | null;
  read?: LeaseReadBytes;
}

function isDispatcherLeaseAlive(lease: DispatcherLeaseRecord): boolean {
  const heartbeatAt = Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > DISPATCHER_LEASE_TTL_MS) return false;
  try {
    process.kill(lease.pid, 0);
    const current = processStartIdentity(lease.pid);
    if (!current || current !== lease.start_identity) return false;
    return true;
  } catch {
    return false;
  }
}

function leaseWrite(queue: BoundedQueue, name: string, record: DispatcherLeaseRecord): void {
  queue.writeExclusive(name, JSON.stringify(record, null, 2));
}

function readDispatcherLeaseAny(root: string, pinnedRoot?: PinnedProjectRoot, proofAuthority?: CtoRuntimeProofAuthority): DispatcherLeaseReadResult | null {
  if (pinnedRoot && !pinnedRoot.isStable()) return null;
  const queue = openControlQueue(root, false, pinnedRoot);
  if (!queue) return { status: "missing", record: null };
  try {
    let read: LeaseReadBytes;
    try { read = queue.read("cto-dispatcher.lock"); }
    catch { return { status: "missing", record: null }; }
    try {
      const raw = JSON.parse(decodeUtf8(read.bytes)) as unknown;
      const record = parseLease(raw);
      if (!record || !proofAuthority || !dispatcherLeaseProofMatches(proofAuthority, record)) return { status: "invalid", record: null, read };
      return { status: "valid", record, read };
    } catch {
      // Malformed/unauthenticated bytes are a split-brain fence, never a dead owner.
      return { status: "invalid", record: null, read };
    }
  } finally {
    queue.close();
  }
}

/** Remove a dispatcher lease only when the exact token/generation still owns the bytes we read. */
function removeDispatcherLeaseIfOwned(queue: BoundedQueue, pinnedRoot: PinnedProjectRoot, token: string, epoch: number, proofAuthority?: CtoRuntimeProofAuthority): void {
  try {
    const observed = queue.read("cto-dispatcher.lock");
    const record = parseLease(JSON.parse(decodeUtf8(observed.bytes)));
    if (!record
      || record.token !== token
      || record.epoch !== epoch
      || !Boolean(proofAuthority && dispatcherLeaseProofMatches(proofAuthority, record))
      || !dispatcherRecordMatchesPinnedRoot(pinnedRoot.lexical_root, pinnedRoot, record)
      || !pinnedRoot.isStable()) return;
    queue.removeIfMatches("cto-dispatcher.lock", queueExpected(observed));
  } catch {
    // A displaced/replaced lock is never removed by a stale claimant.
  }
}

function claimDispatcher(root: string, providedRoot?: PinnedProjectRoot, runtimeAccess?: RuntimeAccess, sessionId?: string, liveGuard?: DispatcherActivationLiveGuard, expectedActivation?: RegistryContextSnapshot, proofAuthority?: CtoRuntimeProofAuthority): { lease: DispatcherLease; pinnedRoot: PinnedProjectRoot } | null {
  const pinnedRoot = providedRoot ?? PinnedProjectRoot.open(root);
  const ownsPin = providedRoot === undefined;
  if (!runtimeAccess || typeof sessionId !== "string" || sessionId.length === 0 || !liveGuard || !pinnedRoot || !pinnedRoot.isStable()) {
    if (pinnedRoot && ownsPin) void pinnedRoot.closeAsync().catch(() => undefined);
    return null;
  }
  let activation: RegistryContextSnapshot;
  try {
    const current = assertDispatcherActivationLive(runtimeAccess, pinnedRoot, liveGuard);
    if (!current) throw new DispatcherActivationRevokedError("dispatcher activation guard did not return a snapshot");
    if (expectedActivation && !registrySnapshotEqual(current, expectedActivation)) throw new DispatcherActivationRevokedError("dispatcher activation snapshot changed");
    activation = current;
  } catch {
    if (pinnedRoot && ownsPin) void pinnedRoot.closeAsync().catch(() => undefined);
    return null;
  }
  const identity = { lexicalRoot: pinnedRoot.lexical_root, canonicalRoot: pinnedRoot.canonical_root, rootDev: pinnedRoot.dev, rootIno: pinnedRoot.ino };
  let queue: BoundedQueue | null = null;
  let retained = false;
  try {
    if (runtimeAccess) {
      assertCtoRuntimeAccessFacadeLive(runtimeAccess, pinnedRoot.canonical_root, sessionId);
      runtimeAccess.assertLive();
      runtimeAccess.assertProjectRoot(root);
    }
    queue = openControlQueue(root, true, pinnedRoot);
    if (!queue) return null;
    const startIdentity = processStartIdentity(process.pid);
    if (!startIdentity) return null;
    const token = randomUUID();
    const now = new Date().toISOString();
    const firstUnsigned: Omit<DispatcherLeaseRecord, "proof"> = {
      schema: 2,
      activation,
      session_id: sessionId,
      pid: process.pid,
      start_identity: startIdentity,
      root_identity: identity.canonicalRoot,
      root_dev: identity.rootDev,
      root_ino: identity.rootIno,
      token,
      epoch: 1,
      startedAt: now,
      heartbeatAt: now,
      run_cursor: null,
      outbox_run_id: null,
      outbox_cursor: null,
    };
    const first = proofAuthority ? signDispatcherLease(proofAuthority, firstUnsigned) : null;
    if (!first) return null;
    const lease = (record: DispatcherLeaseRecord): DispatcherLease => ({
      root,
      ...identity,
      path: dispatcherLockPath(root),
      token,
      epoch: record.epoch,
      runCursor: record.run_cursor ?? null,
      directOutboxRunId: record.outbox_run_id ?? null,
      directOutboxCursor: record.outbox_cursor ?? null,
      session_id: record.session_id,
      activation: record.activation,
    });
    let wroteFirst = false;
    try {
      assertDispatcherActivationLive(runtimeAccess, pinnedRoot, liveGuard, activation);
      leaseWrite(queue, "cto-dispatcher.lock", first);
      wroteFirst = true;
      assertDispatcherActivationLive(runtimeAccess, pinnedRoot, liveGuard, activation);
      if (!dispatcherRootMatchesPinnedRoot(root, pinnedRoot, identity) || !dispatcherRecordMatchesPinnedRoot(root, pinnedRoot, first)) {
        removeDispatcherLeaseIfOwned(queue, pinnedRoot, token, first.epoch, proofAuthority);
        return null;
      }
      retained = true;
      return { lease: lease(first), pinnedRoot };
    } catch (error) {
      if (wroteFirst) removeDispatcherLeaseIfOwned(queue, pinnedRoot, token, first.epoch, proofAuthority);
      if (!(error instanceof BoundedQueueError && error.code === "exists")) return null;
    }
    const current = readDispatcherLeaseAny(root, pinnedRoot, proofAuthority);
    if (!current || current.status === "invalid") return null;
    if (current.record && !dispatcherRecordMatchesPinnedRoot(root, pinnedRoot, current.record)) return null;
    if (current.record && isDispatcherLeaseAlive(current.record)) return null;
    if (current.status === "valid" && !current.read) return null;
    const epoch = current.record ? current.record.epoch + 1 : 1;
    const { proof: _proof, ...firstWithoutProof } = first;
    const next = proofAuthority ? signDispatcherLease(proofAuthority, {
      ...firstWithoutProof,
      epoch,
      run_cursor: current.record?.run_cursor ?? null,
      outbox_run_id: current.record?.outbox_run_id ?? null,
      outbox_cursor: current.record?.outbox_cursor ?? null,
    }) : null;
    if (!next) return null;
    assertDispatcherActivationLive(runtimeAccess, pinnedRoot, liveGuard, activation);
    queue.removeIfMatches("cto-dispatcher.lock", queueExpected(current.read!));
    assertDispatcherActivationLive(runtimeAccess, pinnedRoot, liveGuard, activation);
    leaseWrite(queue, "cto-dispatcher.lock", next);
    try {
      assertDispatcherActivationLive(runtimeAccess, pinnedRoot, liveGuard, activation);
    } catch (error) {
      removeDispatcherLeaseIfOwned(queue, pinnedRoot, token, next.epoch, proofAuthority);
      throw error;
    }
    if (!dispatcherRootMatchesPinnedRoot(root, pinnedRoot, identity) || !dispatcherRecordMatchesPinnedRoot(root, pinnedRoot, next)) {
      removeDispatcherLeaseIfOwned(queue, pinnedRoot, token, next.epoch, proofAuthority);
      return null;
    }
    retained = true;
    return { lease: lease(next), pinnedRoot };
  } catch {
    return null;
  } finally {
    queue?.close();
    // A supplied pin remains caller-owned when the claim fails. Once a claim
    // succeeds, the dispatcher retains that same pin until stop().
    if (!retained && ownsPin) void pinnedRoot.closeAsync().catch(() => undefined);
  }
}

function ownsDispatcherLeasePinned(lease: DispatcherLease, pinnedRoot: PinnedProjectRoot, proofAuthority: CtoRuntimeProofAuthority): boolean {
  if (!pinnedRoot.isStable() || !dispatcherLeaseMatchesPinnedRoot(lease, pinnedRoot)) return false;
  const current = readDispatcherLeaseAny(lease.root, pinnedRoot, proofAuthority);
  return Boolean(current?.record
    && dispatcherRecordMatchesPinnedRoot(lease.root, pinnedRoot, current.record)
    && current.record.token === lease.token
    && current.record.epoch === lease.epoch
    && Boolean(proofAuthority && dispatcherLeaseProofMatches(proofAuthority, current.record))
    && pinnedRoot.isStable());
}

function refreshDispatcherLease(
  lease: DispatcherLease,
  runtimeAccess?: RuntimeAccess,
  runCursor?: string | null,
  outboxRunId?: string | null,
  outboxCursor?: string | null,
  providedRoot?: PinnedProjectRoot,
  liveGuard?: DispatcherActivationLiveGuard,
  proofAuthority?: CtoRuntimeProofAuthority,
): void {
  const suppliedRoot = providedRoot;
  const pinnedRoot = suppliedRoot ?? PinnedProjectRoot.open(lease.root);
  if (!pinnedRoot || !dispatcherLeaseMatchesPinnedRoot(lease, pinnedRoot)) { if (!suppliedRoot) pinnedRoot?.close(); return; }
  const queue = openControlQueue(lease.root, false, pinnedRoot);
  if (!queue) { if (!suppliedRoot) pinnedRoot.close(); return; }
  try {
    assertDispatcherActivationLive(runtimeAccess, pinnedRoot, liveGuard, lease.activation);
    const current = queue.read("cto-dispatcher.lock");
    const record = parseLease(JSON.parse(decodeUtf8(current.bytes)));
    if (!record || !Boolean(proofAuthority && dispatcherLeaseProofMatches(proofAuthority, record)) || !dispatcherRecordMatchesPinnedRoot(lease.root, pinnedRoot, record) || record.token !== lease.token || record.epoch !== lease.epoch) return;
    assertDispatcherActivationLive(runtimeAccess, pinnedRoot, liveGuard, lease.activation);
    const nextRunCursor = runCursor !== undefined ? runCursor : lease.runCursor;
    const nextOutboxRunId = outboxRunId !== undefined ? outboxRunId : lease.directOutboxRunId;
    const nextOutboxCursor = outboxCursor !== undefined ? outboxCursor : lease.directOutboxCursor;
    const { proof: _proof, ...withoutProof } = record;
    const refreshed = proofAuthority ? signDispatcherLease(proofAuthority, {
      ...withoutProof,
      heartbeatAt: new Date().toISOString(),
      run_cursor: nextRunCursor,
      outbox_run_id: nextOutboxRunId,
      outbox_cursor: nextOutboxCursor,
    }) : null;
    if (!refreshed) return;
    queue.replaceIfMatches("cto-dispatcher.lock", queueExpected(current), JSON.stringify(refreshed, null, 2));
    lease.runCursor = nextRunCursor;
    lease.directOutboxRunId = nextOutboxRunId;
    lease.directOutboxCursor = nextOutboxCursor;
    assertDispatcherActivationLive(runtimeAccess, pinnedRoot, liveGuard, lease.activation);
  } catch (error) {
    if (isDispatcherActivationFailure(error)) throw error;
    // The next tick stops when ownership can no longer be confirmed.
  } finally {
    queue.close();
    if (!suppliedRoot) pinnedRoot.close();
  }
}

function releaseDispatcherLease(lease: DispatcherLease, providedRoot?: PinnedProjectRoot, proofAuthority?: CtoRuntimeProofAuthority): void {
  const suppliedRoot = providedRoot;
  const pinnedRoot = suppliedRoot ?? PinnedProjectRoot.open(lease.root);
  if (!pinnedRoot || !dispatcherLeaseMatchesPinnedRoot(lease, pinnedRoot)) { if (!suppliedRoot) pinnedRoot?.close(); return; }
  const queue = openControlQueue(lease.root, false, pinnedRoot);
  if (!queue) { if (!suppliedRoot) pinnedRoot.close(); return; }
  try {
    const current = queue.read("cto-dispatcher.lock");
    const record = parseLease(JSON.parse(decodeUtf8(current.bytes)));
    if (!record || !Boolean(proofAuthority && dispatcherLeaseProofMatches(proofAuthority, record)) || !dispatcherRecordMatchesPinnedRoot(lease.root, pinnedRoot, record) || record.token !== lease.token || record.epoch !== lease.epoch || !pinnedRoot.isStable()) return;
    queue.removeIfMatches("cto-dispatcher.lock", queueExpected(current));
  } catch {
    // Best-effort release; stale fencing handles crashed owners.
  } finally {
    queue.close();
    if (!suppliedRoot) pinnedRoot.close();
  }
}

/**
 * Shared dispatcher loop behind `startDispatcher` (legacy single-adapter)
 * and `startChannelDispatcher` (profile-aware channel set). Inbound wiring
 * (`setPlainMessageHandler`) and polling (`pollOnce`) happen ONLY on the
 * primary adapter — RO sinks are never wired or polled (architecture
 * invariant: RO adapters are never polled or wired for inbound handlers).
 * The legacy wrapper's primary IS its single adapter, so its duck-typed
 * behavior is unchanged (telegram/mock are rw by builtin capabilities).
 *
 * Outbox draining uses the primary when one exists; for a legacy
 * single-adapter config the single RO adapter becomes the drain target so
 * legacy outbound delivery keeps working (the capability model changes
 * WHICH adapter drains, never whether legacy delivery happens). Report
 * routing to RO sinks still applies on top (the drain adapter is skipped
 * as a routing target — no double send).
 *
 * Each tick drains the outbox and polls the inbox exactly once; ticks never
 * overlap — a tick that outlives the interval is skipped until the previous
 * one completes (no double-drain, no double-poll of the same updates).
 *
 * A project may have more than one interactive omp session. Only the process
 * holding the lease polls and wakes that project's CTO; this keeps Telegram
 * updates and local-drop wakes on one deterministic session.
 */
interface DispatcherTickContext {
  readonly root: string;
  readonly pinnedRoot: PinnedProjectRoot;
  readonly lease: DispatcherLease;
}

interface DispatcherTarget {
  primary: EscalationAdapter | null;
  roSinks: EscalationAdapter[];
  /** Legacy single-adapter configs drain via their single RO adapter. */
  legacySingleAdapter?: boolean;
  intervalMs: number;
  opts: DispatcherOptions;
}

function quarantineDirectOutboxEntry(root: string, runId: string, entryName: string, reason: "terminal" | "missing" | "unpublished", pinnedRoot?: PinnedProjectRoot, lifecycle?: AdapterOperationContext, runtimeAccess?: RuntimeAccess): void {
  const fence: MutationFence = { pinnedRoot, runtimeAccess, lifecycle };
  const assertLive = (): void => assertMutationLive(fence);
  assertLive();
  const queue = openBoundedQueue(pinnedRoot?.canonical_root ?? root, join(".work-state", "cto", runId, "outbox"), {
    ...DIRECT_OUTBOX_QUEUE_OPTIONS,
    createDirectory: false,
    ...(pinnedRoot ? { pinnedRoot } : {}),
  });
  if (!queue) return;
  const rejectedDirectory = join(".work-state", "cto", runId, "outbox-rejected");
  try {
    try {
      assertLive();
      const expected = queue.classify(entryName);
      queue.discard(entryName, expected, rejectedDirectory);
      assertLive();
    } catch (error) {
      if (isDispatcherActivationFailure(error)) throw error;
      // Preserve the source when quarantine cannot establish a rejected
      // destination; the next authoritative tick can retry safely.
      return;
    }
  } finally {
    queue.close();
  }
}
function republishPendingDeliveryObligations(
  entries: readonly CtoRunDeliveryIndexEntry[],
  runtimeAccess: RuntimeAccess | undefined,
  lifecycle: AdapterOperationContext | undefined,
  pinnedRoot: PinnedProjectRoot,
): void {
  if (!runtimeAccess) return;
  const withinDeadline = (): boolean => {
    lifecycle?.assertLive?.();
    return lifecycle === undefined || Date.now() < lifecycle.deadline;
  };
  for (const entry of entries) {
    if (!withinDeadline()) return;
    let obligations: ReturnType<RuntimeAccess["readOutboxDeliveryObligations"]>;
    try {
      if (!withinDeadline()) return;
      obligations = runtimeAccess.readOutboxDeliveryObligations(entry.run_id);
    } catch (error) {
      if (isDispatcherActivationFailure(error)) throw error;
      continue;
    }
    for (const obligation of obligations) {
      if (!withinDeadline()) return;
      try {
        if (!withinDeadline()) return;
        const raw = JSON.parse(decodeUtf8(obligation.json));
        if (!withinDeadline()) return;
        const routingBinding = currentRoutingBinding(runtimeAccess, raw, pinnedRoot);
        if (!routingBinding) continue;
        if (!withinDeadline()) return;
        runtimeAccess.publishOutboxDelivery({
          run_id: obligation.run_id,
          state_revision: obligation.state_revision,
          entry_name: obligation.entry_name,
          json: obligation.json,
          routing_binding: routingBinding,
        });
        if (!withinDeadline()) return;
      } catch (error) {
        if (isDispatcherActivationFailure(error)) throw error;
      }
    }
  }
}

export interface DispatcherHandle {
  /** True only when this invocation acquired the durable dispatcher lease. */
  readonly claimed: boolean;
  /** Stop the claimed dispatcher; an unclaimed handle is an idempotent no-op. */
  (): Promise<void>;
}

function dispatcherHandle(claimed: boolean, stop: () => Promise<void>): DispatcherHandle {
  Object.defineProperty(stop, "claimed", { configurable: false, enumerable: true, value: claimed, writable: false });
  return stop as DispatcherHandle;
}

function startDispatcherLoop(root: string, target: DispatcherTarget): DispatcherHandle {
  const { primary, roSinks, intervalMs, opts } = target;
  const drainAdapter = primary ?? (target.legacySingleAdapter ? (roSinks[0] ?? null) : null);
  if (!opts.runtimeAccess) return dispatcherHandle(false, async () => undefined);
  const claimed = claimDispatcher(root, opts.pinnedRoot, opts.runtimeAccess, opts.session_id, opts.liveGuard, opts.activation, opts.proofAuthority);
  if (!claimed) return dispatcherHandle(false, async () => undefined);
  const { lease, pinnedRoot: dispatcherRoot } = claimed;
  const ownsDispatcherRoot = opts.pinnedRoot === undefined;
  try {
    assertDispatcherActivationLive(opts.runtimeAccess, dispatcherRoot, opts.liveGuard, lease.activation);
  } catch {
    releaseDispatcherLease(lease, dispatcherRoot, opts.proofAuthority);
    if (ownsDispatcherRoot) void dispatcherRoot.closeAsync().catch(() => undefined);
    return dispatcherHandle(false, async () => undefined);
  }
  let requestStop: (() => Promise<void>) | undefined;
  const heartbeat = setInterval(() => {
    try {
      refreshDispatcherLease(lease, opts.runtimeAccess, undefined, undefined, undefined, dispatcherRoot, opts.liveGuard, opts.proofAuthority);
    } catch (error) {
      if (isDispatcherActivationFailure(error)) void requestStop?.();
    }
  }, DISPATCHER_HEARTBEAT_MS);
  const { onTask, onAnswer } = opts;
  let stopped = false;
  let inFlightTick: Promise<void> | null = null;
  let activeAbortController: AbortController | null = null;
  let stopPromise: Promise<void> | null = null;
  const trackedCallbacks = new Set<Promise<unknown>>();
  const retryCursorStore = new Map<string, string | null>();
  const retryMatchStateStore = new Map<string, unknown>();
  const retryMatchCursorStore = new Map<string, string | null>();
  const trackCallback = <T>(operation: PromiseLike<T>): Promise<T> => {
    const tracked = Promise.resolve(operation);
    trackedCallbacks.add(tracked);
    // Consume rejection here as well as in shutdown tracking. This keeps the
    // lifetime tracker independent without creating an unhandled rejection.
    void tracked.then(
      () => { trackedCallbacks.delete(tracked); },
      () => { trackedCallbacks.delete(tracked); },
    );
    return tracked;
  };
  const trackedAdapterOperations = new Set<Promise<unknown>>();
  const trackAdapterOperation = (operation: PromiseLike<unknown>): void => {
    const tracked = Promise.resolve(operation);
    trackedAdapterOperations.add(tracked);
    // Consume rejection here as well; adapter promises may settle after stop
    // has detached the bounded lifecycle wrapper.
    void tracked.then(
      () => { trackedAdapterOperations.delete(tracked); },
      () => { trackedAdapterOperations.delete(tracked); },
    );
  };
  const awaitTrackedCallbacks = async (): Promise<void> => {
    // The stopped fence prevents new admissions, while this dynamic snapshot
    // loop keeps the lease held until every admitted callback settles. A
    // callback may admit another callback before it resolves, so re-check the
    // set after each all-settled batch.
    while (trackedCallbacks.size > 0) {
      await Promise.allSettled([...trackedCallbacks]);
    }
  };
  const wakeTask = async (task: InboxTask, pinnedRoot: PinnedProjectRoot = dispatcherRoot): Promise<void> => {
    if (stopped) throw new Error("messenger dispatcher is stopped");
    assertDispatcherActivationLive(opts.runtimeAccess, pinnedRoot, opts.liveGuard, lease.activation);
    assertAdapterRegistrationLive(primary);
    if (!ownsDispatcherLeasePinned(lease, pinnedRoot, opts.proofAuthority)) throw new Error("messenger dispatcher lease lost before task wake");
    await onTask?.(task);
    assertAdapterRegistrationLive(primary);
    assertDispatcherActivationLive(opts.runtimeAccess, pinnedRoot, opts.liveGuard, lease.activation);
    if (stopped || !ownsDispatcherLeasePinned(lease, pinnedRoot, opts.proofAuthority)) throw new Error("messenger dispatcher lease lost during task wake");
  };
  const wakeAnswer = async (answer: Pick<EscalationAnswer, "id" | "run_id" | "answer">, pinnedRoot: PinnedProjectRoot = dispatcherRoot): Promise<void> => {
    if (stopped) throw new Error("messenger dispatcher is stopped");
    assertDispatcherActivationLive(opts.runtimeAccess, pinnedRoot, opts.liveGuard, lease.activation);
    assertAdapterRegistrationLive(primary);
    if (!ownsDispatcherLeasePinned(lease, pinnedRoot, opts.proofAuthority)) throw new Error("messenger dispatcher lease lost before answer wake");
    await onAnswer?.(answer);
    assertAdapterRegistrationLive(primary);
    assertDispatcherActivationLive(opts.runtimeAccess, pinnedRoot, opts.liveGuard, lease.activation);
    if (stopped || !ownsDispatcherLeasePinned(lease, pinnedRoot, opts.proofAuthority)) throw new Error("messenger dispatcher lease lost during answer wake");
  };
  const inboxHandler = (_message: unknown, _callbackRoot?: PinnedProjectRoot): Promise<void> => {
    if (stopped) return Promise.resolve();
    try {
      assertDispatcherActivationLive(opts.runtimeAccess, dispatcherRoot, opts.liveGuard, lease.activation);
      assertAdapterRegistrationLive(primary);
    } catch (error) {
      if (isDispatcherActivationFailure(error)) void requestStop?.();
      return Promise.resolve();
    }
    if (!ownsDispatcherLeasePinned(lease, dispatcherRoot, opts.proofAuthority)) return Promise.resolve();
    const operation = (async (): Promise<void> => {
      assertDispatcherActivationLive(opts.runtimeAccess, dispatcherRoot, opts.liveGuard, lease.activation);
      assertAdapterRegistrationLive(primary);
      const task = normalizeInboundTask(_message);
      if (!task || stopped || !ownsDispatcherLeasePinned(lease, dispatcherRoot, opts.proofAuthority)) return;
      // Adapters may supply a transport-local pin, but admission is always
      // anchored to the exact session-start descriptor transferred here.
      const callbackPin = dispatcherRoot;
      if (stopped || !ownsDispatcherLeasePinned(lease, dispatcherRoot, opts.proofAuthority)) return;
      const outcome = await dispatchInboxTask(root, task, (value) => wakeTask(value, callbackPin), {
        idempotentWake: true,
        wakeEvidence: opts.wakeEvidence,
        pinnedRoot: callbackPin,
        runtimeAccess: opts.runtimeAccess,
        serviceAuthority: opts.serviceAuthority,
        proofAuthority: opts.proofAuthority,
        isOwned: () => {
          if (stopped) return false;
          assertDispatcherActivationLive(opts.runtimeAccess, callbackPin, opts.liveGuard, lease.activation);
          return ownsDispatcherLeasePinned(lease, callbackPin, opts.proofAuthority);
        },
      });
      assertAdapterRegistrationLive(primary);
      if (outcome === "retryable") throw new InboxTaskRetryableError();
    })();
    const tracked = trackCallback(operation);
    void tracked.catch((error) => { if (isDispatcherActivationFailure(error)) void requestStop?.(); });
    return tracked;
  };
  // Inbound surface lives on the primary ONLY (telegram/mock implement it;
  // http is send-only). Normalize the structured callback at the boundary
  // once, preserving transport origin fields without accepting legacy string
  // callbacks as task text.
  const inboundCapable = primary as {
    setPlainMessageHandler?: (h: (message: unknown, pinnedRoot?: PinnedProjectRoot) => void | Promise<void>) => void;
    clearPlainMessageHandler?: () => void;
  } | null;
  let inboundInstalled = false;
  try {
    if (inboundCapable && typeof inboundCapable.setPlainMessageHandler === "function") {
      assertAdapterRegistrationLive(primary);
      inboundCapable.setPlainMessageHandler(inboxHandler);
      assertAdapterRegistrationLive(primary);
      inboundInstalled = true;
    }
  } catch (error) {
    stopped = true;
    clearInterval(heartbeat);
    try {
      if (typeof inboundCapable?.clearPlainMessageHandler === "function") inboundCapable.clearPlainMessageHandler();
      else inboundCapable?.setPlainMessageHandler?.(() => undefined);
    } catch { /* cleanup continues */ }
    releaseDispatcherLease(lease, dispatcherRoot, opts.proofAuthority);
    // A caller-supplied pin remains caller-owned when startup fails. A locally
    // opened pin is released here because no stop handle is returned.
    if (opts.pinnedRoot === undefined) void dispatcherRoot.closeAsync().catch(() => undefined);
    throw error;
  }
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (stopped || ticking || !ownsDispatcherLeasePinned(lease, dispatcherRoot, opts.proofAuthority)) return;
    assertDispatcherActivationLive(opts.runtimeAccess, dispatcherRoot, opts.liveGuard, lease.activation);
    ticking = true;
    const abortController = new AbortController();
    activeAbortController = abortController;
    const tickPin = dispatcherRoot;
    const lifecycle: AdapterOperationContext = {
      signal: abortController.signal,
      deadline: Date.now() + DISPATCHER_TICK_DEADLINE_MS,
      trackUnderlyingCallback: (operation) => { trackCallback(operation); },
      trackUnderlyingOperation: (operation) => { trackAdapterOperation(operation); },
      assertLive: () => assertDispatcherActivationLive(opts.runtimeAccess, tickPin, opts.liveGuard, lease.activation),
    };
    let nextCursor = lease.runCursor;
    let nextOutboxRunId = lease.directOutboxRunId;
    let nextOutboxCursor = lease.directOutboxCursor;
    try {
      if (!tickPin.isStable() || !ownsDispatcherLeasePinned(lease, tickPin, opts.proofAuthority)) return;
      const context: DispatcherTickContext = { root, pinnedRoot: tickPin, lease };
      const isOwned = (): boolean => {
        if (stopped) return false;
        assertDispatcherActivationLive(opts.runtimeAccess, context.pinnedRoot, opts.liveGuard, lease.activation);
        return ownsDispatcherLeasePinned(context.lease, context.pinnedRoot, opts.proofAuthority);
      };
      assertDispatcherActivationLive(opts.runtimeAccess, tickPin, opts.liveGuard, lease.activation);
      const direct = discoverDirectOutbox(context.root, lease.directOutboxRunId, lease.directOutboxCursor, context.pinnedRoot, opts.runtimeAccess, lifecycle);
      nextOutboxRunId = direct.runId;
      nextOutboxCursor = direct.nextCursor;
      const directEntry = direct.entry;
      assertDispatcherActivationLive(opts.runtimeAccess, tickPin, opts.liveGuard, lease.activation);
      const page = readIndexedRunPage(context.root, lease.runCursor, context.pinnedRoot, opts.runtimeAccess);
      nextCursor = page.nextCursor;
      let entries = directEntry && !page.entries.some((entry) => entry.run_id === directEntry.run_id)
        ? [...page.entries, directEntry]
        : page.entries;
      republishPendingDeliveryObligations(entries, opts.runtimeAccess, lifecycle, context.pinnedRoot);
      // Wave-completion summaries first: a wave that finished since the
      // last tick is queued AND drained in this same tick. Both consumers
      // receive the exact same canonical run page; no directory discovery.
      assertDispatcherActivationLive(opts.runtimeAccess, tickPin, opts.liveGuard, lease.activation);
      const queuedSummaries = produceWaveDeliveries(context.root, { isOwned, runEntries: entries, pinnedRoot: context.pinnedRoot, runtimeAccess: opts.runtimeAccess, serviceAuthority: opts.serviceAuthority, maxNewDeliveries: 1, proofAuthority: opts.proofAuthority });
      if (queuedSummaries > 0) {
        // Recording each new obligation advances that run's state revision.
        // Re-read the same cursor page before draining so the delivery gate
        // sees the writer-owned revision instead of the stale pre-publication
        // projection; otherwise advancing the cursor can strand the page.
        const refreshed = readIndexedRunPage(context.root, lease.runCursor, context.pinnedRoot, opts.runtimeAccess);
        nextCursor = refreshed.nextCursor;
        entries = directEntry && !refreshed.entries.some((entry) => entry.run_id === directEntry.run_id)
          ? [...refreshed.entries, directEntry]
          : refreshed.entries;
      }
      assertDispatcherActivationLive(opts.runtimeAccess, tickPin, opts.liveGuard, lease.activation);
      const drained = await drainOutbox(context.root, drainAdapter, 3, {
        roSinks,
        requireIdempotency: true,
        isOwned,
        pinnedRoot: context.pinnedRoot,
        runtimeAccess: opts.runtimeAccess,
        lifecycle,
        runEntries: entries,
        proofAuthority: opts.proofAuthority,
        outboxEntry: directEntry && direct.entryName !== null ? { runId: directEntry.run_id, name: direct.entryName } : undefined,
        retryCursorStore,
        retryMatchStateStore,
        retryMatchCursorStore,
      });
      assertDispatcherActivationLive(opts.runtimeAccess, tickPin, opts.liveGuard, lease.activation);
      // A rejected/unauthorized file may be quarantined, leaving the queue
      // empty while its indexed pending authority must remain untouched. Never
      // acknowledge a run that produced a false drain result this tick.
      const rejectedRuns = new Set(
        drained.filter((result) => result.sent === false).map((result) => result.runId),
      );
      acknowledgeDrainedRuns(context.root, entries.filter((entry) => !rejectedRuns.has(entry.run_id)), drained, context.pinnedRoot, opts.runtimeAccess, lifecycle);
      const deadlineBlocked = drained.find((result) => result.notAttemptedDeadline === true);
      if (deadlineBlocked) {
        const blockedIndex = entries.findIndex((entry) => entry.run_id === deadlineBlocked.runId);
        const blockedEntry = blockedIndex > 0 ? entries[blockedIndex - 1] : undefined;
        nextCursor = blockedEntry?.run_id ?? lease.runCursor;
      }
      if (stopped || !isOwned()) return;
      assertDispatcherActivationLive(opts.runtimeAccess, tickPin, opts.liveGuard, lease.activation);
      // Filesystem-backed delivery may consume the original tick budget before
      // the inbound adapter is reached. Keep the same cancellation/liveness
      // fence, but give polling its own bounded operation window.
      const pollLifecycle: AdapterOperationContext = {
        signal: lifecycle.signal,
        deadline: Date.now() + DISPATCHER_TICK_DEADLINE_MS,
        trackUnderlyingCallback: lifecycle.trackUnderlyingCallback,
        trackUnderlyingOperation: lifecycle.trackUnderlyingOperation,
        assertLive: lifecycle.assertLive,
      };
      await pollInbox(context.root, primary, (task) => wakeTask(task, context.pinnedRoot), (answer) => wakeAnswer(answer, context.pinnedRoot), {
        isOwned,
        idempotentWake: true,
        wakeEvidence: opts.wakeEvidence,
        pinnedRoot: context.pinnedRoot,
        runtimeAccess: opts.runtimeAccess,
        serviceAuthority: opts.serviceAuthority,
        proofAuthority: opts.proofAuthority,
        lifecycle: pollLifecycle,
        retryCursorStore,
      });
    } finally {
      if (!stopped && ownsDispatcherLeasePinned(lease, tickPin, opts.proofAuthority)) refreshDispatcherLease(lease, opts.runtimeAccess, nextCursor, nextOutboxRunId, nextOutboxCursor, tickPin, opts.liveGuard, opts.proofAuthority);
      if (activeAbortController === abortController) activeAbortController = null;
      ticking = false;
    }
  };
  const runTick = (): void => {
    if (stopped || inFlightTick) return;
    const operation = tick().catch((error) => {
      if (isDispatcherActivationFailure(error)) void requestStop?.();
    }).finally(() => {
      if (inFlightTick === operation) inFlightTick = null;
    });
    inFlightTick = operation;
  };
  const timer = setInterval(runTick, intervalMs);
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    // Synchronous shutdown fence: no callback can enter a new admission after
    // this point. Keep the durable lease until every admitted callback settles
    // so a replacement cannot overlap callback-owned mutations.
    stopped = true;
    activeAbortController?.abort();
    // Adapter operations can ignore AbortSignal forever; they are fenced by
    // boundedAdapterCall and deliberately excluded from callback grace.
    trackedAdapterOperations.clear();
    clearInterval(timer);
    clearInterval(heartbeat);
    try {
      if (inboundInstalled) {
        if (typeof inboundCapable?.clearPlainMessageHandler === "function") inboundCapable.clearPlainMessageHandler();
        else inboundCapable?.setPlainMessageHandler?.(() => undefined);
      }
    } catch { /* release/close must still run */ }
    stopPromise = (async (): Promise<void> => {
      const operation = inFlightTick;
      const deadline = Date.now() + DISPATCHER_STOP_GRACE_MS;
      try {
        // Drain callbacks already admitted before waiting for the in-flight
        // tick. The final drain below closes the synchronous callback
        // registration race: a callback can call stop() before its bounded
        // wrapper returns and registers the underlying promise.
        await awaitTrackedCallbacks();
        if (operation) {
          await Promise.race([
            operation.catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, deadline - Date.now()))),
          ]);
        }
        await awaitTrackedCallbacks();
      } finally {
        releaseDispatcherLease(lease, dispatcherRoot, opts.proofAuthority);
        await dispatcherRoot.closeAsync();
      }
    })();
    return stopPromise;
  };
  requestStop = stop;
  // Drain once immediately on start (survives restarts — R7).
  runTick();
  return dispatcherHandle(true, stop);
}

/**
 * Start the dispatcher loop (legacy single-adapter mode); returns a stop
 * function. Duck-typed like the pre-channel-set dispatcher: the adapter is
 * wired/polled when it exposes the optional inbound surface — legacy
 * telegram/mock are rw by builtin capabilities, http stays push-only.
 */
export function startDispatcher(
  root: string,
  adapter: EscalationAdapter | null,
  intervalMs = 10_000,
  opts: DispatcherOptions,
): DispatcherHandle {
  return startDispatcherLoop(root, { primary: adapter, roSinks: [], intervalMs, opts });
}

/**
 * Start the dispatcher loop for a profile-aware {@link ChannelSet}; returns
 * a stop function. The set's primary is the only adapter wired/polled for
 * inbound; outbox delivery goes through the primary and `summary` intents
 * fan out to the set's RO sinks (see {@link drainOutbox}). `opts.roSinks`
 * overrides the set's sinks when provided.
 */
export function startChannelDispatcher(
  root: string,
  channelSet: ChannelSet,
  intervalMs = 10_000,
  opts: DispatcherOptions & { roSinks?: EscalationAdapter[] },
): DispatcherHandle {
  return startDispatcherLoop(root, {
    primary: channelSet.primary,
    roSinks: opts.roSinks ?? channelSet.roSinks,
    legacySingleAdapter: channelSet.legacySingleAdapter,
    intervalMs,
    opts,
  });
}
/** A task arriving from the messenger or the local drop. */
export interface InboxTask {
  id: string;
  text: string;
  at: string;
  by?: string;
  /** Telegram origin chat, retained through durable admission and wake. */
  chatId?: string;
  /** Telegram sender id, when the transport provides one. */
  userId?: string;
  /** Telegram message id, scoped by `chatId` by the transport. */
  messageId?: number;
  /** Resolved run id the task was filed under. */
  runId?: string;
  /** Resident wave id admitted for this task (set when run state is readable). */
  waveId?: string;
}

/**
 * Normalize the structured inbound adapter callback before it reaches the
 * durable inbox. Inbound callbacks are data envelopes, never legacy strings;
 * origin fields are copied explicitly so transports cannot smuggle arbitrary
 * values into persisted task records.
 */
type InboxTaskAdmissionOutcome = "accepted" | "rejected" | "retryable";

class InboxTaskRetryableError extends Error {
  readonly code = "INBOX_TASK_RETRYABLE";
  constructor(message = "inbox task admission is retryable") { super(message); this.name = "InboxTaskRetryableError"; }
}

async function dispatchInboxTask(
  root: string,
  task: InboxTask,
  onTask: ((task: InboxTask) => void | Promise<void>) | undefined,
  opts: { idempotentWake?: boolean; wakeEvidence?: (identity: string) => boolean | undefined; pinnedRoot: PinnedProjectRoot; isOwned?: () => boolean; runtimeAccess?: RuntimeAccess; serviceAuthority?: RuntimeServiceAuthority; proofAuthority: CtoRuntimeProofAuthority },
): Promise<InboxTaskAdmissionOutcome> {
  const admitted = await handleInboxTask(root, task, onTask, opts);
  if (admitted !== null) return "accepted";
  if (!opts.pinnedRoot.isStable() || (opts.isOwned && !opts.isOwned())) return "retryable";
  const runId = task.runId;
  if (!runId) return "rejected";
  const authority = resolveInboxWakeAuthority(root, runId, opts.pinnedRoot, opts.runtimeAccess);
  if (authority.status === "stale") return "rejected";
  const queue = openBoundedQueue(opts.pinnedRoot.canonical_root, join(".work-state", "cto", runId, "inbox"), { createDirectory: false, pinnedRoot: opts.pinnedRoot });
  if (!queue) return "retryable";
  try { return queue.exists(inboxMessageFileName(task.id)) ? "rejected" : "retryable"; } finally { queue.close(); }
}

function normalizeInboundTask(value: unknown, maxTextLength = MAX_INBOX_TEXT_LENGTH, allowEmpty = false): InboxTask | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["id", "text", "at", "by", "chatId", "userId", "messageId", "runId"].includes(key))) return null;
  if (!isSafeInboundMessageId(record.id) || typeof record.text !== "string"
    || Buffer.byteLength(record.text, "utf8") > maxTextLength
    || (!allowEmpty && record.text.trim().length === 0)
    || /[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(record.text)) return null;
  const at = record.at === undefined ? new Date().toISOString() : record.at;
  if (!isSafeInboundTimestamp(at)) return null;
  const task: InboxTask = { id: record.id, text: record.text, at };
  if (record.by !== undefined) {
    if (!isSafePolledAnswerMetadata(record.by)) return null;
    task.by = record.by;
  }
  if (record.chatId !== undefined) {
    if (!isSafePolledAnswerMetadata(record.chatId)) return null;
    task.chatId = record.chatId;
  }
  if (record.userId !== undefined) {
    if (!isSafePolledAnswerMetadata(record.userId)) return null;
    task.userId = record.userId;
  }
  if (record.messageId !== undefined) {
    if (!Number.isSafeInteger(record.messageId) || (record.messageId as number) < 0) return null;
    task.messageId = record.messageId as number;
  }
  if (record.runId !== undefined) {
    if (!safeRunId(record.runId)) return null;
    task.runId = record.runId;
  }
  return task;
}

export interface DispatcherOptions {
  /** The session-start pin is transferred to the dispatcher and closed by stop. */
  pinnedRoot?: PinnedProjectRoot;
  /** Called once per new inbox task (after the inbox file is written). */
  onTask?: (task: InboxTask) => void | Promise<void>;
  /**
   * Called once per newly received escalation answer (user-initiated reply
   * or button in the messenger channel). The answer file is already written
   * by the adapter; the wake tells the agent to apply it at the next
   * checkpoint (or immediately if it is waiting).
   */
  onAnswer?: (answer: Pick<EscalationAnswer, "id" | "run_id" | "answer">) => void | Promise<void>;
  /** Authoritative bounded session-history lookup for a stable wake identity. */
  wakeEvidence?: (identity: string) => boolean | undefined;
  /** Authenticated main-session runtime authority for CTO reads and explicit delivery methods. */
  runtimeAccess?: RuntimeAccess;
  /** Private activation-bound capability for intentional cross-run state mutations. */
  serviceAuthority?: RuntimeServiceAuthority;
  /** Exact authoritative session owner bound into the dispatcher lease. */
  session_id?: string;
  /** Registry-issued live activation capability; required to claim a dispatcher lease. */
  liveGuard?: DispatcherActivationLiveGuard;
  /** Opaque root/workflow_tools proof authority; required for all durable proofs. */
  proofAuthority: CtoRuntimeProofAuthority;
  /** Optional stale-snapshot consistency check; never authorizes a claim without liveGuard. */
  activation?: RegistryContextSnapshot;
}

/** `.work-state/cto/<runId>/inbox/` — tasks the CTO reads at checkpoints. */
export function inboxDir(runId: string, root: string): string {
  return join(root, ".work-state", "cto", runId, "inbox");
}

/** Local task drop: `<root>/.omp/inbox/*.json` ({ id, text, by? }). */
export function localInboxDrop(root: string): string {
  return join(root, ".omp", "inbox");
}

// ── Bridge ownership (one getUpdates consumer per bot token) ───────────────

/**
 * Lock file the standalone bridge daemon writes on start and removes on exit.
 * The in-session dispatcher checks it: while the bridge is alive it owns the
 * bot's getUpdates, so the session must NOT long-poll telegram itself — it
 * only picks up the bridge's files from the drop. Without the bridge the
 * session polls telegram directly. Stale lock (dead pid) is ignored.
 */
export function bridgeLockPath(root: string): string {
  return join(root, ".omp", "bridge.lock");
}

interface BridgeLeaseRecord extends DispatcherLeaseRecord {
  session_id: string;
  root_identity: string;
  root_dev: number;
  root_ino: number;
}

interface BridgeLease {
  root: string;
  lexicalRoot: string;
  canonicalRoot: string;
  rootDev: number;
  rootIno: number;
  token: string;
  epoch: number;
  session_id: string;
  secret: string;
}

/** Result of a bridge lease CAS attempt. The CLI must not construct an
 * adapter or call getUpdates unless owned is true and the token is present. */
export interface BridgeLeaseHandle {
  readonly owned: boolean;
  readonly token?: string;
  readonly epoch?: number;
  readonly session_id?: string;
  readonly root_identity?: string;
  readonly root_dev?: number;
  readonly root_ino?: number;
}

export const MAX_BRIDGE_LEASES = 64;
const bridgeLeases = new Map<string, BridgeLease>();

interface BridgeSecretRecord {
  schema: 1;
  root_identity: string;
  root_dev: number;
  root_ino: number;
  token: string;
  epoch: number;
  session_id: string;
  secret: string;
}

function canonicalBridgeRoot(root: string, pinnedRoot?: PinnedProjectRoot): string | null {
  if (pinnedRoot) return pinnedRoot.isStable() ? pinnedRoot.canonical_root : null;
  try { return realpathSync(root); } catch { return null; }
}

function bridgeRootMatchesPinnedRoot(root: string, pinnedRoot: PinnedProjectRoot, identity: { lexicalRoot: string; canonicalRoot: string; rootDev: number; rootIno: number }): boolean {
  return pinnedRoot.isStable()
    && resolve(root) === identity.lexicalRoot
    && pinnedRoot.lexical_root === identity.lexicalRoot
    && pinnedRoot.canonical_root === identity.canonicalRoot
    && pinnedRoot.dev === identity.rootDev
    && pinnedRoot.ino === identity.rootIno;
}

function bridgeRecordMatchesPinnedRoot(root: string, pinnedRoot: PinnedProjectRoot, record: BridgeLeaseRecord): boolean {
  return bridgeRootMatchesPinnedRoot(root, pinnedRoot, {
    lexicalRoot: pinnedRoot.lexical_root,
    canonicalRoot: record.root_identity,
    rootDev: record.root_dev,
    rootIno: record.root_ino,
  });
}

function bridgeSecretFile(root: string, pinnedRoot?: PinnedProjectRoot): string | null {
  const canonical = canonicalBridgeRoot(root, pinnedRoot);
  if (!canonical) return null;
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return join(homedir(), ".omp", "runtime-secrets", digest + ".json");
}

const RUNTIME_SECRET_MAX_BYTES = 8 * 1024;
const RUNTIME_SECRET_ROOT_RELATIVE = ".omp/runtime-secrets";
const RUNTIME_SECRET_VALUE_MAX_CHARS = 512;
const RUNTIME_SECRET_ROOT_IDENTITY_MAX_CHARS = 4096;

interface RuntimeSecretRead {
  present: boolean;
  parsed?: unknown;
}

function withRuntimeSecretRoot<T>(operation: (root: PinnedProjectRoot) => T): T | null {
  const root = PinnedProjectRoot.open(homedir());
  if (!root) return null;
  try {
    return operation(root);
  } catch {
    return null;
  } finally {
    root.close();
  }
}

function runtimeSecretRelative(root: PinnedProjectRoot, target: string): string | null {
  const relative = root.relativePath(target);
  if (!relative || !relative.startsWith(`${RUNTIME_SECRET_ROOT_RELATIVE}/`)) return null;
  return relative;
}

function ensurePrivateRuntimeSecretDirectory(root: PinnedProjectRoot): boolean {
  try {
    root.ensureDirectory(RUNTIME_SECRET_ROOT_RELATIVE);
    const info = root.pathEntryInfo(RUNTIME_SECRET_ROOT_RELATIVE);
    // Directory creation is anchored/no-follow and defaults to 0700. Existing
    // group/world-readable directories fail closed; never repair permissions
    // through a pathname that could race to an attacker-owned target.
    return info?.kind === "directory" && info.mode === 0o700;
  } catch {
    return false;
  }
}

/**
 * Read a runtime secret through a pinned home descriptor. The path metadata
 * check is deliberately performed after the descriptor read and matched to
 * its device/inode, so a leaf replacement cannot turn an untrusted pathname
 * into the bytes we parse.
 */
function readRuntimeSecretFile(root: PinnedProjectRoot, target: string): RuntimeSecretRead {
  const relative = runtimeSecretRelative(root, target);
  if (!relative) return { present: true };
  let info;
  try {
    info = root.pathEntryInfo(relative);
  } catch {
    return { present: true };
  }
  if (!info) return { present: false };
  if (info.kind !== "file" || info.size > RUNTIME_SECRET_MAX_BYTES) return { present: true };
  try {
    const read = root.readFile(relative, { maxBytes: RUNTIME_SECRET_MAX_BYTES });
    const committed = root.pathEntryInfo(relative);
    if (read.bytes.byteLength > RUNTIME_SECRET_MAX_BYTES || !committed || committed.kind !== "file" || committed.mode !== 0o600 || committed.dev !== read.dev || committed.ino !== read.ino) return { present: true };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    return { present: true, parsed: JSON.parse(text) as unknown };
  } catch {
    return { present: true };
  }
}

function serializeRuntimeSecret(record: object): string | null {
  try {
    const serialized = JSON.stringify(record);
    return Buffer.byteLength(serialized, "utf8") <= RUNTIME_SECRET_MAX_BYTES ? serialized : null;
  } catch {
    return null;
  }
}

function exactObjectKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function writeBridgeSecret(root: string, record: BridgeSecretRecord, pinnedRoot?: PinnedProjectRoot): boolean {
  const target = bridgeSecretFile(root, pinnedRoot);
  const serialized = serializeRuntimeSecret(record);
  if (!target || !serialized) return false;
  return withRuntimeSecretRoot((homeRoot) => {
    const relative = runtimeSecretRelative(homeRoot, target);
    if (!relative) return false;
    if (!ensurePrivateRuntimeSecretDirectory(homeRoot)) return false;
    homeRoot.writeAtomic(relative, serialized);
    return true;
  }) ?? false;
}

function readBridgeSecret(root: string, record: BridgeLeaseRecord, pinnedRoot?: PinnedProjectRoot): string | null {
  if (!pinnedRoot || !pinnedRoot.isStable() || !bridgeRecordMatchesPinnedRoot(root, pinnedRoot, record)) return null;
  const owned = bridgeLeases.get(root);
  if (owned && owned.token === record.token && owned.epoch === record.epoch && owned.session_id === record.session_id) {
    if (!pinnedRoot || !bridgeRootMatchesPinnedRoot(root, pinnedRoot, owned) || !bridgeRecordMatchesPinnedRoot(root, pinnedRoot, record)) return null;
    return owned.secret;
  }
  const target = bridgeSecretFile(root, pinnedRoot);
  const canonical = canonicalBridgeRoot(root, pinnedRoot);
  if (!target || !canonical) return null;
  return withRuntimeSecretRoot((homeRoot) => {
    const read = readRuntimeSecretFile(homeRoot, target);
    if (!read.present || !exactObjectKeys(read.parsed, ["epoch", "root_dev", "root_identity", "root_ino", "schema", "secret", "session_id", "token"])) return null;
    const value = read.parsed;
    if (value.schema !== 1
      || value.root_identity !== canonical
      || value.root_dev !== record.root_dev
      || value.root_ino !== record.root_ino
      || value.token !== record.token
      || value.epoch !== record.epoch
      || value.session_id !== record.session_id
      || typeof value.root_identity !== "string"
      || value.root_identity.length > RUNTIME_SECRET_ROOT_IDENTITY_MAX_CHARS
      || typeof value.token !== "string"
      || value.token.length === 0
      || value.token.length > RUNTIME_SECRET_VALUE_MAX_CHARS
      || typeof value.session_id !== "string"
      || value.session_id.length < 16
      || value.session_id.length > RUNTIME_SECRET_VALUE_MAX_CHARS
      || typeof value.secret !== "string"
      || value.secret.length < 32
      || value.secret.length > RUNTIME_SECRET_VALUE_MAX_CHARS) return null;
    return value.secret;
  }) ?? null;
}

function removeBridgeSecretIfMatches(root: string, record: Pick<BridgeLeaseRecord, "root_identity" | "root_dev" | "root_ino" | "token" | "epoch" | "session_id">, pinnedRoot: PinnedProjectRoot): void {
  const target = bridgeSecretFile(root, pinnedRoot);
  if (!target) return;
  withRuntimeSecretRoot((homeRoot) => {
    const relative = runtimeSecretRelative(homeRoot, target);
    if (!relative) return;
    try {
      const read = homeRoot.readFile(relative, { maxBytes: RUNTIME_SECRET_MAX_BYTES });
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) as unknown;
      if (!exactObjectKeys(parsed, ["epoch", "root_dev", "root_identity", "root_ino", "schema", "secret", "session_id", "token"])) return;
      const value = parsed;
      if (value.schema !== 1 || value.root_identity !== record.root_identity || value.root_dev !== record.root_dev
        || value.root_ino !== record.root_ino || value.token !== record.token || value.epoch !== record.epoch
        || value.session_id !== record.session_id || typeof value.secret !== "string") return;
      const expected = {
        dev: read.dev,
        ino: read.ino,
        size: read.bytes.byteLength,
        sha256: createHash("sha256").update(read.bytes).digest("hex"),
      };
      homeRoot.removeFileIfMatches(relative, expected);
    } catch { /* preserve an absent/replaced secret and continue lease cleanup */ }
  });
}

function removeBridgeSecretFromOwnedRoot(record: Pick<BridgeLeaseRecord, "root_identity" | "root_dev" | "root_ino" | "token" | "epoch" | "session_id">): void {
  // Never resolve the lexical project root here: it may now be a symlink to a
  // foreign project. Open the previously authenticated canonical root and
  // require the original device/inode before touching its digest-scoped secret.
  const canonicalRoot = PinnedProjectRoot.open(record.root_identity);
  if (!canonicalRoot || !canonicalRoot.isStable()
    || canonicalRoot.canonical_root !== record.root_identity
    || canonicalRoot.dev !== record.root_dev
    || canonicalRoot.ino !== record.root_ino) {
    canonicalRoot?.close();
    return;
  }
  try {
    removeBridgeSecretIfMatches(record.root_identity, record, canonicalRoot);
  } finally {
    canonicalRoot.close();
  }
}

function parseBridgeLease(raw: unknown): BridgeLeaseRecord | null {
  const record = parseLease(raw);
  if (!record || typeof raw !== "object" || raw === null) return null;
  const value = raw as { session_id?: unknown; root_identity?: unknown; root_dev?: unknown; root_ino?: unknown };
  if (typeof value.session_id !== "string" || value.session_id.length < 16
    || typeof value.root_identity !== "string" || value.root_identity.length === 0 || value.root_identity.length > RUNTIME_SECRET_ROOT_IDENTITY_MAX_CHARS
    || !Number.isSafeInteger(value.root_dev) || (value.root_dev as number) < 0
    || !Number.isSafeInteger(value.root_ino) || (value.root_ino as number) < 0) return null;
  return { ...record, session_id: value.session_id, root_identity: value.root_identity, root_dev: value.root_dev as number, root_ino: value.root_ino as number };
}

type BridgeLeaseReadStatus = "live" | "absent" | "invalid_or_unknown";
interface BridgeLeaseReadResult {
  status: BridgeLeaseReadStatus;
  record: BridgeLeaseRecord | null;
  read?: LeaseReadBytes;
}

function bridgeLockPathState(pinnedRoot: PinnedProjectRoot): "present" | "absent" | "unknown" {
  try {
    return pinnedRoot.pathEntryExists(join(".omp", "bridge.lock")) ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

function readBridgeLease(root: string, pinnedRoot?: PinnedProjectRoot, proofAuthority?: CtoRuntimeProofAuthority): BridgeLeaseReadResult {
  // A missing/unstable pin cannot prove canonical absence. Treat it as an
  // unknown bridge owner so resident Telegram polling fails closed.
  if (!pinnedRoot || !pinnedRoot.isStable()) return { status: "invalid_or_unknown", record: null };
  const queue = openControlQueue(root, false, pinnedRoot);
  if (!queue) {
    const state = bridgeLockPathState(pinnedRoot);
    return { status: state === "absent" ? "absent" : "invalid_or_unknown", record: null };
  }
  try {
    let read: LeaseReadBytes;
    try { read = queue.read("bridge.lock"); }
    catch {
      const state = bridgeLockPathState(pinnedRoot);
      return { status: state === "absent" ? "absent" : "invalid_or_unknown", record: null };
    }
    try {
      const raw = JSON.parse(decodeUtf8(read.bytes)) as unknown;
      const record = parseBridgeLease(raw);
      // Verify the exact bytes did not change during this read. A changing
      // lock is an ownership handoff, not permission to start another poller.
      const reread = queue.read("bridge.lock");
      if (reread.dev !== read.dev || reread.ino !== read.ino || queueExpected(reread).sha256 !== queueExpected(read).sha256) {
        return { status: "invalid_or_unknown", record: null, read };
      }
      if (!record || !proofAuthority || !bridgeLeaseProofMatches(proofAuthority, record)
        || !bridgeRecordMatchesPinnedRoot(root, pinnedRoot, record) || !pinnedRoot.isStable()) {
        return { status: "invalid_or_unknown", record: null, read };
      }
      return { status: bridgeLeaseAlive(record) ? "live" : "absent", record, read };
    } catch {
      // Malformed/unauthenticated/changing bytes are a split-brain fence,
      // never a dead owner and never canonical absence.
      return { status: "invalid_or_unknown", record: null, read };
    }
  } finally {
    queue.close();
  }
}

function bridgeLeaseAlive(record: BridgeLeaseRecord): boolean {
  return isDispatcherLeaseAlive(record);
}

/** Remove process-local bridge leases that no longer own a live exact root/lock. */
function sweepBridgeLeases(proofAuthority?: CtoRuntimeProofAuthority): void {
  for (const [root, owned] of bridgeLeases) {
    const pin = PinnedProjectRoot.open(root);
    if (!pin || !pin.isStable()) {
      bridgeLeases.delete(root);
      pin?.close();
      continue;
    }
    try {
      if (!bridgeRootMatchesPinnedRoot(root, pin, owned)) {
        bridgeLeases.delete(root);
        continue;
      }
      const currentRead = readBridgeLease(root, pin, proofAuthority);
      if (currentRead?.status === "invalid_or_unknown") continue;
      const current = currentRead?.record;
      const currentMatchesRoot = Boolean(current && bridgeRecordMatchesPinnedRoot(root, pin, current));
      const expiredOrDead = !current || !bridgeLeaseAlive(current);
      const displaced = Boolean(current && (current.token !== owned.token || current.epoch !== owned.epoch || current.session_id !== owned.session_id));
      if (!current || !currentMatchesRoot || displaced || expiredOrDead) {
        bridgeLeases.delete(root);
        // Delete only the exact secret belonging to the expired/dead lease;
        // removeBridgeSecretIfMatches uses descriptor-relative CAS, so a new
        // bridge secret installed concurrently is never touched.
        removeBridgeSecretFromOwnedRoot({
          root_identity: owned.canonicalRoot,
          root_dev: owned.rootDev,
          root_ino: owned.rootIno,
          token: owned.token,
          epoch: owned.epoch,
          session_id: owned.session_id,
        });
      }
    } finally {
      pin.close();
    }
  }
}

/** True when a live tg-bridge owns the bot for this project. */
export function isBridgeAlive(root: string, pinnedRoot?: PinnedProjectRoot, proofAuthority?: CtoRuntimeProofAuthority): boolean {
  sweepBridgeLeases(proofAuthority);
  const pin = pinnedRoot ?? PinnedProjectRoot.open(root);
  if (!pin || !pin.isStable()) { if (!pinnedRoot) pin?.close(); return false; }
  try {
    const current = readBridgeLease(root, pin, proofAuthority);
    return Boolean(current?.record && bridgeRecordMatchesPinnedRoot(root, pin, current.record) && bridgeLeaseAlive(current.record));
  } finally {
    if (!pinnedRoot) pin.close();
  }
}

function bridgeLeaseHandle(record: BridgeLeaseRecord): BridgeLeaseHandle {
  return {
    owned: true,
    token: record.token,
    epoch: record.epoch,
    session_id: record.session_id,
    root_identity: record.root_identity,
    root_dev: record.root_dev,
    root_ino: record.root_ino,
  };
}

const bridgeLeaseNotOwned = (): BridgeLeaseHandle => ({ owned: false });

/** Revalidate one lease token against the pinned root and lock bytes. */
export function isBridgeLeaseOwned(root: string, handle: BridgeLeaseHandle, pinnedRoot?: PinnedProjectRoot, proofAuthority?: CtoRuntimeProofAuthority): boolean {
  sweepBridgeLeases(proofAuthority);
  if (!handle.owned || typeof handle.token !== "string" || !Number.isSafeInteger(handle.epoch)) return false;
  const pin = pinnedRoot ?? PinnedProjectRoot.open(root);
  if (!pin || !pin.isStable()) { if (!pinnedRoot) pin?.close(); return false; }
  try {
    const current = readBridgeLease(root, pin, proofAuthority);
    return Boolean(current?.record
      && bridgeRecordMatchesPinnedRoot(root, pin, current.record)
      && current.record.token === handle.token
      && current.record.epoch === handle.epoch
      && Boolean(proofAuthority && bridgeLeaseProofMatches(proofAuthority, current.record))
      && (!handle.session_id || current.record.session_id === handle.session_id)
      && bridgeLeaseAlive(current.record)
      && pin.isStable());
  } finally {
    if (!pinnedRoot) pin.close();
  }
}

/** Refresh only the lock token installed by this bridge and keep its root
 * identity pinned. A lost/replaced lock returns false so callers stop polling
 * before another consumer can be created. */
export function refreshBridgeLock(root: string, handle: BridgeLeaseHandle, pinnedRoot?: PinnedProjectRoot, proofAuthority?: CtoRuntimeProofAuthority): boolean {
  sweepBridgeLeases(proofAuthority);
  if (!handle.owned || typeof handle.token !== "string" || !Number.isSafeInteger(handle.epoch)) return false;
  const pin = pinnedRoot ?? PinnedProjectRoot.open(root);
  if (!pin || !pin.isStable()) { if (!pinnedRoot) pin?.close(); return false; }
  const queue = openControlQueue(root, false, pin);
  if (!queue) { if (!pinnedRoot) pin.close(); return false; }
  try {
    const current = queue.read("bridge.lock");
    const record = parseBridgeLease(JSON.parse(decodeUtf8(current.bytes)));
    if (!record || !Boolean(proofAuthority && bridgeLeaseProofMatches(proofAuthority, record)) || !bridgeRecordMatchesPinnedRoot(root, pin, record)
      || record.token !== handle.token || record.epoch !== handle.epoch
      || (handle.session_id !== undefined && record.session_id !== handle.session_id)
      || !pin.isStable()) return false;
    const { proof: _proof, ...withoutProof } = record;
    const refreshed = proofAuthority ? signBridgeLease(proofAuthority, { ...withoutProof, heartbeatAt: new Date().toISOString() }) : null;
    if (!refreshed) return false;
    queue.replaceIfMatches("bridge.lock", queueExpected(current), JSON.stringify(refreshed, null, 2));
    return pin.isStable() && isBridgeLeaseOwned(root, handle, pin, proofAuthority);
  } catch {
    return false;
  } finally {
    queue.close();
    if (!pinnedRoot) pin.close();
  }
}

/** Write a fresh bridge lease and secret using exact-token CAS reclaim. */
export function writeBridgeLock(root: string, pinnedRoot?: PinnedProjectRoot, proofAuthority?: CtoRuntimeProofAuthority): BridgeLeaseHandle {
  sweepBridgeLeases(proofAuthority);
  const pin = pinnedRoot ?? PinnedProjectRoot.open(root);
  if (!pin || !pin.isStable()) { if (!pinnedRoot) pin?.close(); return bridgeLeaseNotOwned(); }
  const identity = { lexicalRoot: pin.lexical_root, canonicalRoot: pin.canonical_root, rootDev: pin.dev, rootIno: pin.ino };
  if (!bridgeLeases.has(root) && bridgeLeases.size >= MAX_BRIDGE_LEASES) {
    if (!pinnedRoot) pin.close();
    return bridgeLeaseNotOwned();
  }
  const queue = openControlQueue(root, true, pin);
  if (!queue) { if (!pinnedRoot) pin.close(); return bridgeLeaseNotOwned(); }
  const startIdentity = processStartIdentity(process.pid);
  if (!startIdentity) { queue.close(); if (!pinnedRoot) pin.close(); return bridgeLeaseNotOwned(); }
  const token = randomUUID();
  const sessionId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const firstUnsigned: Omit<BridgeLeaseRecord, "proof"> = {
    schema: 2,
    activation: {
      canonical_root: pin.canonical_root,
      root_dev: pin.dev,
      root_ino: pin.ino,
      owner_fingerprint: createHash("sha256").update("bridge", "utf8").digest("hex"),
      principal_fingerprint: createHash("sha256").update("bridge", "utf8").digest("hex"),
      claim_generation: 0,
      marker_generation: 0,
      marker_digest: createHash("sha256").update("bridge", "utf8").digest("hex"),
    },
    pid: process.pid,
    start_identity: startIdentity,
    token,
    epoch: 1,
    startedAt: now,
    heartbeatAt: now,
    session_id: sessionId,
    root_identity: identity.canonicalRoot,
    root_dev: identity.rootDev,
    root_ino: identity.rootIno,
    run_cursor: null,
    outbox_run_id: null,
    outbox_cursor: null,
  };
  const first = proofAuthority ? signBridgeLease(proofAuthority, firstUnsigned) : null;
  if (!first) { queue.close(); if (!pinnedRoot) pin.close(); return bridgeLeaseNotOwned(); }
  const secretRecord = (epoch: number): BridgeSecretRecord => ({ schema: 1, root_identity: identity.canonicalRoot, root_dev: identity.rootDev, root_ino: identity.rootIno, token, epoch, session_id: sessionId, secret });
  const install = (record: BridgeLeaseRecord): BridgeLeaseHandle => {
    if (!bridgeRootMatchesPinnedRoot(root, pin, identity) || !writeBridgeSecret(root, secretRecord(record.epoch), pin) || !bridgeRootMatchesPinnedRoot(root, pin, identity)) return bridgeLeaseNotOwned();
    bridgeLeases.set(root, { root, ...identity, token, epoch: record.epoch, session_id: sessionId, secret });
    const current = readBridgeLease(root, pin, proofAuthority);
    if (!current?.record || !bridgeRecordMatchesPinnedRoot(root, pin, current.record) || current.record.token !== token || current.record.epoch !== record.epoch || !pin.isStable()) {
      bridgeLeases.delete(root);
      return bridgeLeaseNotOwned();
    }
    return bridgeLeaseHandle(current.record);
  };
  const rollback = (): void => {
    try {
      const current = queue.read("bridge.lock");
      const parsed = parseBridgeLease(JSON.parse(decodeUtf8(current.bytes)));
      if (parsed?.token === token && parsed.epoch === first.epoch) queue.removeIfMatches("bridge.lock", queueExpected(current));
    } catch { /* best effort */ }
  };
  try {
    try {
      queue.writeExclusive("bridge.lock", JSON.stringify(first, null, 2));
      const result = install(first);
      if (result.owned) return result;
      rollback();
      return bridgeLeaseNotOwned();
    } catch (error) {
      if (!(error instanceof BoundedQueueError && error.code === "exists")) return bridgeLeaseNotOwned();
    }
    const current = readBridgeLease(root, pin, proofAuthority);
    if (!current || current.status === "invalid_or_unknown") return bridgeLeaseNotOwned();
    if (current.status === "live" && !current.read) return bridgeLeaseNotOwned();
    if (current.record && bridgeLeaseAlive(current.record)) {
      const known = bridgeLeases.get(root);
      if (known && known.token === current.record.token && known.epoch === current.record.epoch) return bridgeLeaseHandle(current.record);
      return bridgeLeaseNotOwned();
    }
    const epoch = current.record ? current.record.epoch + 1 : 1;
    const { proof: _proof, ...firstWithoutProof } = first;
    const next = proofAuthority ? signBridgeLease(proofAuthority, { ...firstWithoutProof, epoch }) : null;
    if (!next) return bridgeLeaseNotOwned();
    queue.removeIfMatches("bridge.lock", queueExpected(current.read!));
    queue.writeExclusive("bridge.lock", JSON.stringify(next, null, 2));
    const result = install(next);
    if (result.owned) return result;
    try {
      const replacement = queue.read("bridge.lock");
      const parsed = parseBridgeLease(JSON.parse(decodeUtf8(replacement.bytes)));
      if (parsed?.token === token && parsed.epoch === epoch) queue.removeIfMatches("bridge.lock", queueExpected(replacement));
    } catch { /* best effort */ }
    return bridgeLeaseNotOwned();
  } catch {
    // A live owner, unsafe lock, or concurrent CAS winner fails closed.
    return bridgeLeaseNotOwned();
  } finally {
    queue.close();
    if (!pinnedRoot) pin.close();
  }
}

/** Remove only the exact bridge lease written by this process. */
export function clearBridgeLock(root: string, suppliedHandle?: BridgeLeaseHandle, pinnedRoot?: PinnedProjectRoot, proofAuthority?: CtoRuntimeProofAuthority): void {
  sweepBridgeLeases(proofAuthority);
  const owned = bridgeLeases.get(root);
  if (suppliedHandle && !suppliedHandle.owned) return;
  const suppliedMatchesOwned = owned !== undefined
    && (suppliedHandle === undefined || (suppliedHandle.token === owned.token && suppliedHandle.epoch === owned.epoch));
  const pin = pinnedRoot ?? PinnedProjectRoot.open(root);
  if (!pin || !pin.isStable()) {
    if (suppliedMatchesOwned) bridgeLeases.delete(root);
    if (!pinnedRoot) pin?.close();
    return;
  }
  try {
    const expectedToken = suppliedHandle?.token ?? owned?.token;
    const expectedEpoch = suppliedHandle?.epoch ?? owned?.epoch;
    const current = readBridgeLease(root, pin, proofAuthority);
    if (!current?.record || !current.read || !Boolean(proofAuthority && bridgeLeaseProofMatches(proofAuthority, current.record)) || (owned && !bridgeRootMatchesPinnedRoot(root, pin, owned)) || !bridgeRecordMatchesPinnedRoot(root, pin, current.record)) return;
    if (typeof expectedToken !== "string" || !Number.isSafeInteger(expectedEpoch) || current.record.token !== expectedToken || current.record.epoch !== expectedEpoch) return;
    const queue = openControlQueue(root, false, pin);
    if (!queue) return;
    try { queue.removeIfMatches("bridge.lock", queueExpected(current.read)); } catch { /* stale/replaced lock remains untouched */ }
    finally { queue.close(); }
    bridgeLeases.delete(root);
  } finally {
    if (!pinnedRoot) pin.close();
  }
}

interface RetrySecretRecord {
  schema: 1;
  root_identity: string;
  root_dev: number;
  root_ino: number;
  domain: "omp-inbox-retry-v1";
  secret: string;
}

function retryRootIdentity(root: string, pinnedRoot: PinnedProjectRoot): { canonical: string; dev: number; ino: number; token: string } | null {
  if (!pinnedRoot.isStable()) return null;
  const canonical = canonicalBridgeRoot(root, pinnedRoot);
  if (!canonical) return null;
  return { canonical, dev: pinnedRoot.dev, ino: pinnedRoot.ino, token: `${canonical}\0${String(pinnedRoot.dev)}\0${String(pinnedRoot.ino)}` };
}

function retrySecretFile(root: string, pinnedRoot?: PinnedProjectRoot): string | null {
  if (!pinnedRoot) return null;
  const identity = retryRootIdentity(root, pinnedRoot);
  if (!identity) return null;
  const digest = createHash("sha256").update(identity.token, "utf8").digest("hex");
  return join(homedir(), ".omp", "runtime-secrets", digest + ".inbox-retry.json");
}

function readOrCreateRetrySecret(root: string, pinnedRoot?: PinnedProjectRoot): string | null {
  if (!pinnedRoot || !pinnedRoot.isStable()) return null;
  const identity = retryRootIdentity(root, pinnedRoot);
  const canonical = identity?.canonical ?? null;
  const target = retrySecretFile(root, pinnedRoot);
  const rootDev = identity?.dev;
  const rootIno = identity?.ino;
  const valid = (raw: unknown): string | null => {
    if (!exactObjectKeys(raw, ["domain", "root_dev", "root_identity", "root_ino", "schema", "secret"])) return null;
    const value = raw;
    if (value.schema !== 1
      || value.domain !== "omp-inbox-retry-v1"
      || value.root_identity !== canonical
      || value.root_dev !== rootDev
      || value.root_ino !== rootIno
      || typeof value.root_identity !== "string"
      || value.root_identity.length > RUNTIME_SECRET_ROOT_IDENTITY_MAX_CHARS
      || !Number.isSafeInteger(value.root_dev) || (value.root_dev as number) < 0
      || !Number.isSafeInteger(value.root_ino) || (value.root_ino as number) < 0
      || typeof value.secret !== "string"
      || value.secret.length !== 43
      || value.secret.length > RUNTIME_SECRET_VALUE_MAX_CHARS
      || !/^[A-Za-z0-9_-]+$/u.test(value.secret)) return null;
    return value.secret;
  };
  if (!identity || !canonical || !target || !pinnedRoot.isStable()) return null;
  return withRuntimeSecretRoot((homeRoot) => {
    if (!pinnedRoot.isStable()) return null;
    const relative = runtimeSecretRelative(homeRoot, target);
    if (!relative) return null;
    if (!ensurePrivateRuntimeSecretDirectory(homeRoot)) return null;
    const existing = readRuntimeSecretFile(homeRoot, target);
    if (existing.present) {
      const secret = valid(existing.parsed);
      return secret && pinnedRoot.isStable() ? secret : null;
    }
    const record: RetrySecretRecord = {
      schema: 1,
      root_identity: canonical!,
      root_dev: rootDev!,
      root_ino: rootIno!,
      domain: "omp-inbox-retry-v1",
      secret: randomBytes(32).toString("base64url"),
    };
    const serialized = serializeRuntimeSecret(record);
    if (!serialized) return null;
    try {
      homeRoot.writeExclusive(relative, serialized);
    } catch {
      // Another process may have won exclusive creation; validate its record.
    }
    const committed = readRuntimeSecretFile(homeRoot, target);
    const secret = committed.present ? valid(committed.parsed) : null;
    return secret && pinnedRoot.isStable() ? secret : null;
  }) ?? null;
}

interface AuthenticatedInboxEnvelope {
  schema: 2;
  kind: "task" | "answer";
  id: string;
  text: string;
  at: string;
  by: string;
  run_id: string;
  auth: { session_id: string; nonce: string; mac: string; mode?: "durable" };
}

function canonicalAuthJson(value: unknown): string {
  const canonicalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(canonicalize);
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
    }
    return current;
  };
  return JSON.stringify(canonicalize(value));
}

const INBOX_AUTH_PROOF_DOMAIN = "cto-inbox-auth-v1" as const;

function authMac(
  authority: CtoRuntimeProofAuthority,
  payload: Omit<AuthenticatedInboxEnvelope, "auth"> & { auth: { session_id: string; nonce: string; mode: "durable" } | { session_id: string; nonce: string } },
): string | null {
  return signCtoRuntimeProof(authority, INBOX_AUTH_PROOF_DOMAIN, canonicalAuthJson(payload));
}

/** Create an authenticated bridge drop; the secret never leaves the lock file. */
export function createAuthenticatedInboxEnvelope(
  root: string,
  kind: "task" | "answer",
  input: { id: string; text: string; at: string; by?: string; run_id: string },
  suppliedPin: PinnedProjectRoot | undefined,
  proofAuthority: CtoRuntimeProofAuthority,
): AuthenticatedInboxEnvelope {
  if (!isCtoRuntimeProofAuthority(proofAuthority)) throw new Error("bridge proof authority is unavailable");
  assertCtoRuntimeProofAuthorityLive(proofAuthority);
  const pin = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pin || !pin.isStable()) { if (!suppliedPin) pin?.close(); throw new Error("bridge authentication lease unavailable"); }
  try {
    const current = readBridgeLease(root, pin, proofAuthority);
    const owned = bridgeLeases.get(root);
    if (!current?.record || !owned
      || owned.token !== current.record.token
      || owned.epoch !== current.record.epoch
      || owned.session_id !== current.record.session_id
      || !bridgeRootMatchesPinnedRoot(root, pin, owned)
      || !bridgeRecordMatchesPinnedRoot(root, pin, current.record)
      || !bridgeLeaseAlive(current.record)) throw new Error("bridge authentication lease unavailable");
    if (!bridgeRootMatchesPinnedRoot(root, pin, owned) || !bridgeRecordMatchesPinnedRoot(root, pin, current.record)) throw new Error("bridge authentication lease unavailable");
    const body = { schema: 2 as const, kind, id: input.id, text: input.text, at: input.at, by: input.by ?? "telegram-bridge", run_id: input.run_id };
    const auth = { session_id: current.record.session_id, nonce: randomBytes(24).toString("base64url"), mode: "durable" as const };
    const mac = authMac(proofAuthority, { ...body, auth: { session_id: auth.session_id, nonce: auth.nonce, mode: auth.mode } });
    if (!mac) throw new Error("bridge proof authority is unavailable");
    return { ...body, auth: { ...auth, mac } };
  } finally {
    if (!suppliedPin) pin.close();
  }
}

function safeRunId(value: unknown): value is string { return isSafeCtoRunId(value); }

function isSafePolledAnswerId(value: unknown): value is string {
  return isSafeEscalationId(value);
}

function isSafePolledAnswerText(value: unknown): value is string {
  return isSafeCtoInboundText(value, MAX_INBOX_TEXT_LENGTH);
}

function isSafePolledAnswerMetadata(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 256
    && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function isSafeInboundMessageId(value: unknown): value is string {
  return isSafePolledAnswerMetadata(value);
}

function isSafeInboundTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24 || Buffer.byteLength(value, "utf8") !== 24) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
const INVALID_POLLED_BATCH_VALUE = Symbol("invalid-polled-batch-value");

type PollDetachState = { readonly active: Set<object> };

function detachPolledBatchValue(value: unknown, state: PollDetachState, depth: number): unknown | typeof INVALID_POLLED_BATCH_VALUE {
  if (depth > 8) return INVALID_POLLED_BATCH_VALUE;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") return value;
  if (typeof value !== "object") return INVALID_POLLED_BATCH_VALUE;
  if (state.active.has(value)) return INVALID_POLLED_BATCH_VALUE;
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_POLLED_ANSWER_BATCH_ENTRIES) return INVALID_POLLED_BATCH_VALUE;
      const detached: unknown[] = [];
      detached.length = length as number;
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) return INVALID_POLLED_BATCH_VALUE;
        const child = detachPolledBatchValue(descriptor.value, state, depth + 1);
        if (child === INVALID_POLLED_BATCH_VALUE) return INVALID_POLLED_BATCH_VALUE;
        detached[index] = child;
      }
      return detached;
    }
    const detached: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = Object.keys(value);
    if (keys.length > 64) return INVALID_POLLED_BATCH_VALUE;
    for (const key of keys) {
      if (Buffer.byteLength(key, "utf8") > MAX_DRAIN_INPUT_STRING_BYTES) return INVALID_POLLED_BATCH_VALUE;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return INVALID_POLLED_BATCH_VALUE;
      const child = detachPolledBatchValue(descriptor.value, state, depth + 1);
      if (child === INVALID_POLLED_BATCH_VALUE) return INVALID_POLLED_BATCH_VALUE;
      Object.defineProperty(detached, key, { configurable: true, enumerable: true, value: child, writable: true });
    }
    return detached;
  } catch {
    // Proxy traps, accessors, cycles, and descriptor races reject the whole
    // batch before any callback or durable mutation is attempted.
    return INVALID_POLLED_BATCH_VALUE;
  } finally {
    state.active.delete(value);
  }
}

function detachPolledAnswerBatch(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return [];
  const detached = detachPolledBatchValue(value, { active: new Set<object>() }, 0);
  return Array.isArray(detached) ? detached : null;
}

function normalizePolledAnswer(value: unknown): Pick<EscalationAnswer, "id" | "run_id" | "answer"> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => !["id", "run_id", "answer", "at", "by", "stale"].includes(key))
      || !Object.hasOwn(candidate, "id")
      || !Object.hasOwn(candidate, "run_id")
      || !Object.hasOwn(candidate, "answer")) return null;
    if (candidate.stale !== undefined && typeof candidate.stale !== "boolean") return null;
    if (candidate.at !== undefined && !isSafeInboundTimestamp(candidate.at)) return null;
    if (candidate.by !== undefined && !isSafePolledAnswerMetadata(candidate.by)) return null;
    const id = candidate.id;
    const runId = candidate.run_id;
    const answer = candidate.answer;
    if (typeof id !== "string" || typeof runId !== "string" || typeof answer !== "string"
      || !isSafePolledAnswerId(id) || !safeRunId(runId) || !isSafePolledAnswerText(answer)) return null;
    return { id, run_id: runId, answer };
  } catch {
    return null;
  }
}

/** Verify the exact bridge auth lease that signed a just-created envelope
 * is still current. Session id alone is not enough: token and epoch fence a
 * same-session replacement on the same inode. */
export function isBridgeAuthenticationLeaseCurrent(root: string, pinnedRoot: PinnedProjectRoot, sessionId: string, proofAuthority: CtoRuntimeProofAuthority): boolean {
  if (!pinnedRoot.isStable() || typeof sessionId !== "string" || sessionId.length === 0) return false;
  const owned = bridgeLeases.get(root);
  const current = readBridgeLease(root, pinnedRoot, proofAuthority);
  return Boolean(owned && current?.record
    && owned.token === current.record.token
    && owned.epoch === current.record.epoch
    && owned.session_id === sessionId
    && current.record.session_id === sessionId
    && bridgeRootMatchesPinnedRoot(root, pinnedRoot, owned)
    && bridgeRecordMatchesPinnedRoot(root, pinnedRoot, current.record)
    && bridgeLeaseAlive(current.record)
    && pinnedRoot.isStable());
}

function isAuthenticatedInboxText(value: unknown, maxTextLength: number, allowEmpty: boolean): value is string {
  return typeof value === "string"
    && (allowEmpty || value.trim().length > 0)
    && Buffer.byteLength(value, "utf8") <= maxTextLength
    && !/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

export function verifyAuthenticatedInboxEnvelope(
  root: string,
  raw: unknown,
  kind: "task" | "answer",
  pinnedRoot: PinnedProjectRoot | undefined,
  maxTextLength: number,
  allowEmpty: boolean,
  proofAuthority: CtoRuntimeProofAuthority,
): AuthenticatedInboxEnvelope | null {
  if (!isCtoRuntimeProofAuthority(proofAuthority)) return null;
  try { assertCtoRuntimeProofAuthorityLive(proofAuthority); } catch { return null; }
  if (!raw || typeof raw !== "object" || !pinnedRoot?.isStable()) return null;
  const value = raw as Partial<AuthenticatedInboxEnvelope>;
  if (value.schema !== 2 || value.kind !== kind || typeof value.id !== "string" || value.id.length === 0 || !isAuthenticatedInboxText(value.text, maxTextLength, allowEmpty) || typeof value.at !== "string" || typeof value.by !== "string" || typeof value.run_id !== "string" || !safeRunId(value.run_id)) return null;
  const auth = value.auth;
  if (!auth || typeof auth !== "object" || typeof auth.session_id !== "string" || typeof auth.nonce !== "string" || auth.nonce.length < 16 || typeof auth.mac !== "string" || !/^[0-9a-f]{64}$/i.test(auth.mac) || auth.mode !== "durable") return null;
  const body = { schema: 2 as const, kind, id: value.id, text: value.text, at: value.at, by: value.by, run_id: value.run_id };
  if (!verifyCtoRuntimeProof(proofAuthority, INBOX_AUTH_PROOF_DOMAIN, canonicalAuthJson({ ...body, auth: { session_id: auth.session_id, nonce: auth.nonce, mode: "durable" } }), auth.mac)) return null;
  if (!pinnedRoot.isStable()) return null;
  return { schema: 2, kind, id: value.id, text: value.text, at: value.at, by: value.by, run_id: value.run_id, auth: { session_id: auth.session_id, nonce: auth.nonce, mac: auth.mac, ...(auth.mode === "durable" ? { mode: "durable" as const } : {}) } };
}

/**
 * Resolve the run an inbox task belongs to through the authenticated runtime.
 */
export function resolveInboxRunId(root: string, suppliedPin?: PinnedProjectRoot, runtimeAccess?: RuntimeAccess): string {
  void suppliedPin;
  if (!runtimeAccess) throw new Error("inbox runtime access is unavailable");
  const active = runtimeActive(runtimeAccess);
  if (active) return active.runId;
  return ensureStandbyRun(root, suppliedPin, runtimeAccess);
}

/** Create or reuse a standby run through the root-captured runtime facade. */
export function ensureStandbyRun(root: string, suppliedPin?: PinnedProjectRoot, runtimeAccess?: RuntimeAccess): string {
  void root;
  void suppliedPin;
  if (!runtimeAccess) throw new Error("standby runtime access is unavailable");
  return runtimeAccess.ensureStandbyRun();
}

/**
 * Maximum accepted inbox task body length (br-zps.4). Oversized bodies are
 * REJECTED, never truncated — the messenger must shorten the text before
 * filing, otherwise the quarantine record carries
 * `reason: "text exceeds MAX_INBOX_TEXT_LENGTH"` and the task is dropped.
 */
export const MAX_INBOX_TEXT_LENGTH = 4000;

/**
 * SHA-256 hex digest of `text.trim()` — normalization is a trim, so callers
 * comparing hashes must normalize the same way (trailing/leading whitespace
 * is ignored).
 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text.trim(), "utf8").digest("hex");
}

interface InboxWakeClaim {
  pid: number;
  start_identity: string;
  token: string;
  started_at: string;
}

type InboxWakeRecord = QuarantineRecord & { wake_claim?: InboxWakeClaim };

let cachedSelfProcessStartIdentity: string | undefined;

function processStartIdentity(pid: number): string | null {
  if (pid === process.pid && cachedSelfProcessStartIdentity !== undefined) return cachedSelfProcessStartIdentity;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).trim().split(/\s+/u);
      const start = fields[19];
      const identity = start ? `linux:${start}` : null;
      if (pid === process.pid && identity !== null) cachedSelfProcessStartIdentity = identity;
      return identity;
    }
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 500,
      killSignal: "SIGKILL",
      maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
    });
    const start = typeof result.stdout === "string" ? result.stdout.trim() : "";
    const identity = result.status === 0 && start.length > 0 ? `ps:${start}` : null;
    if (pid === process.pid && identity !== null) cachedSelfProcessStartIdentity = identity;
    return identity;
  } catch {
    return null;
  }
}

function currentWakeClaim(): InboxWakeClaim {
  const startIdentity = processStartIdentity(process.pid);
  if (!startIdentity) throw new Error("inbox wake claim process identity unavailable");
  return { pid: process.pid, start_identity: startIdentity, token: randomUUID(), started_at: new Date().toISOString() };
}

function wakeClaimIsLive(claim: InboxWakeClaim): boolean {
  if (!Number.isInteger(claim.pid) || claim.pid <= 0 || typeof claim.start_identity !== "string" || claim.start_identity.length === 0) return false;
  try {
    process.kill(claim.pid, 0);
    return processStartIdentity(claim.pid) === claim.start_identity;
  } catch {
    return false;
  }
}

const MAX_INBOX_QUARANTINE_RECORDS = 1024;

export class InboxQuarantineCapacityError extends Error {
  readonly code = "INBOX_QUARANTINE_CAPACITY" as const;
  constructor(runId: string) {
    super(`inbox quarantine capacity exhausted for run '${runId}'`);
    this.name = "InboxQuarantineCapacityError";
  }
}

function quarantineRecordHasTerminalWave(state: CtoState, record: QuarantineRecord): boolean {
  const transports = record.by === "inbox" ? ["inbox", "local"] : [record.by];
  return (state.wave_history ?? []).some((wave) =>
    transports.some((transport) => wave.source_id === inboxWaveSourceId({ id: record.id, text: "", at: "", by: transport }))
      && (wave.status === "done" || wave.status === "failed"));
}

function evictOldestQuarantineRecord(state: CtoState, incomingHash: string): void {
  const quarantine = state.inbox_quarantine ?? {};
  if (Object.hasOwn(quarantine, incomingHash)) return;
  if (Object.keys(quarantine).length < MAX_INBOX_QUARANTINE_RECORDS) return;
  const candidates = Object.entries(quarantine)
    .filter(([hash, record]) =>
      hash !== incomingHash
      && record.status === "admitted"
      && record.wake_status === "delivered"
      && quarantineRecordHasTerminalWave(state, record))
    .sort(([leftHash, left], [rightHash, right]) => {
      const leftAt = Date.parse(left.received_at);
      const rightAt = Date.parse(right.received_at);
      const leftOrder = Number.isFinite(leftAt) ? leftAt : Number.MAX_SAFE_INTEGER;
      const rightOrder = Number.isFinite(rightAt) ? rightAt : Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || leftHash.localeCompare(rightHash);
    });
  const oldest = candidates[0];
  if (!oldest) throw new InboxQuarantineCapacityError(state.id);
  delete quarantine[oldest[0]];
}

function setQuarantineRecord(
  state: CtoState,
  task: InboxTask,
  hash: string,
  status: QuarantineRecord["status"],
  reason?: string,
): void {
  const quarantine = state.inbox_quarantine ?? {};
  evictOldestQuarantineRecord(state, hash);
  state.inbox_quarantine = quarantine;
  quarantine[hash] = {
    id: task.id,
    hash,
    received_at: task.at ?? new Date().toISOString(),
    by: task.by ?? "inbox",
    status,
    ...(status === "rejected" ? {} : { wake_status: "pending" as const }),
    ...(reason ? { reason } : {}),
  };
}
/**
 * Record a rejected/quarantined task best-effort. A rejection or unreadable
 * run state must not take down the messenger path. The read/modify/write is
 * serialized with every other admission for this run so a concurrent task
 * cannot erase this record.
 */
function recordQuarantine(
  root: string,
  runId: string,
  task: InboxTask,
  hash: string,
  status: QuarantineRecord["status"],
  reason?: string,
  suppliedPin?: PinnedProjectRoot,
  runtimeAccess?: RuntimeAccess,
  serviceAuthority?: RuntimeServiceAuthority,
): void {
  void runtimeAccess;
  if (!serviceAuthority) return;
  const pin = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pin) return;
  try {
    assertCtoRuntimeServiceMutationAuthorityBound(serviceAuthority, pin);
    withCtoRuntimeServiceTransaction(serviceAuthority, runId, (transaction) => {
      const state = transaction.readState();
      if (state.id !== runId || terminalState(state)) return;
      setQuarantineRecord(state, task, hash, status, reason);
      transaction.writeState(state);
    });
  } catch {
    // best-effort — the rejection itself must never throw
  } finally {
    if (!suppliedPin) pin.close();
  }
}

/** Backward-compatible fullstack name for the shared canonical helper. */
export function inboxMessageFileName(id: string): string {
  return canonicalDurableIdFileName(id);
}

function legacyInboxMessageFileName(id: string): string {
  return legacyDurableIdFileName(id);
}

/**
 * Write an inbox task file and wake the CTO session.
 *
 * Quarantine (br-zps.4): external inbox text is untrusted DATA, not a
 * policy override. Validation and SHA-256 normalization happen before the
 * per-run transaction. The canonical CTO lock serializes current-state
 * hash dedupe, quarantine, the durable wx file claim, and the final
 * admitted+wave commit. A retry can recover a file left behind after a
 * crash before that final state commit.
 *
 * The wake callback runs after releasing the lock; if it throws, the file
 * and quarantine marker are rolled back under a fresh lock so transport
 * retry can wake the task again. State bookkeeping remains best-effort when
 * the state is unreadable, preserving the historical availability path.
 */
function inboxFileMatchesTask(queue: BoundedQueue, fileName: string, task: InboxTask, runId: string): boolean {
  try {
    const existing = queue.readJson<Partial<InboxTask>>(fileName);
    // `at` and `by` can be restamped by a transport retry. Identity is the
    // durable task id + body + resolved run; the file is the source of truth
    // for a crash recovery, not a second transport envelope.
    return existing.id === task.id && existing.text === task.text && existing.runId === runId;
  } catch {
    return false;
  }
}

interface InboxAdmission {
  path: string;
  waveId?: string;
  /** Task was durably filed but must wait for the current active wave. */
  deferred?: boolean;
}

/**
 * Perform the complete inbox decision while the canonical per-run lock is
 * held. Every read is therefore current, and the quarantine + wave envelope
 * is committed from one state image instead of stale independent writes.
 */
function admitInboxTaskUnderLock(root: string, runId: string, task: InboxTask, hash: string, claim: InboxWakeClaim, transaction: CtoRunTransactionFacade, pinnedRoot: PinnedProjectRoot): InboxAdmission | null {
  let state = transaction.readState();
  // The run is re-read while holding the canonical lock. A poller may have
  // discovered it as active, then another owner may have terminalized it
  if (!state || state.id !== runId || terminalState(state)) return null;
  const waveSourceId = inboxWaveSourceId(task);
  const transport = typeof task.by === "string" ? task.by.trim() : "";
  const waveSource = isSafeCtoRunId(transport) ? transport : "inbox";
  const existingWave = waveBySourceId(state, waveSourceId);
  if (existingWave && (existingWave.source !== waveSource || existingWave.task !== task.text)) return null;
  if (existingWave?.status === "done" || existingWave?.status === "failed") return null;
  const existingRecord = state.inbox_quarantine?.[hash];
  if (existingRecord?.status === "rejected") return null;
  const hasActiveWave = Boolean(state.active_wave_id)
    || (state.wave_history ?? []).some((wave) => wave.status === "active");
  const deferAdmission = hasActiveWave && existingWave === null;
  if (deferAdmission && existingRecord?.status === "admitted" && existingRecord.wake_status === "delivered") return null;
  if (!deferAdmission && existingRecord?.status === "admitted") {
    // A process can crash after committing the full admission but before
    // invoking onTask. Legacy records without wake_status are treated as
    // pending too, so replay remains at-least-once and never loses a wake.
    if (existingRecord.wake_status === "delivered" || existingRecord.id !== task.id) return null;
    const durableRecord = existingRecord as InboxWakeRecord;
    // Concurrent pollers must not all replay the same pending wake. A claim
    // owned by a live process is authoritative; a dead/PID-reused owner is
    // reclaimable and therefore preserves crash recovery.
    if (durableRecord.wake_claim && wakeClaimIsLive(durableRecord.wake_claim)) return null;
    durableRecord.wake_claim = claim;
    try {
      transaction.writeState(state);
    } catch (error) {
      delete durableRecord.wake_claim;
      throw error;
    }
  }

  const relativeDir = join(".work-state", "cto", runId, "inbox");
  const queue = openBoundedQueue(pinnedRoot.canonical_root, relativeDir, { pinnedRoot });
  if (!queue) throw new Error(`inbox queue '${runId}' is unavailable or unsafe`);
  let fileName = inboxMessageFileName(task.id);
  const legacyFileName = legacyInboxMessageFileName(task.id);
  let filePresent = queue.exists(fileName);
  if (legacyFileName !== fileName && queue.exists(legacyFileName)) {
    const legacyMatches = inboxFileMatchesTask(queue, legacyFileName, task, runId);
    if (filePresent) {
      // A matching canonical entry is authoritative; an unrelated legacy
      // spelling belongs to another task and must not block its replay.
      if (inboxFileMatchesTask(queue, fileName, task, runId) && legacyMatches) {
        try {
          const legacy = queue.read(legacyFileName);
          queue.removeIfMatches(legacyFileName, queueExpected(legacy));
        } catch {
          // Keep the canonical entry if legacy cleanup races another consumer.
        }
      }
    } else if (legacyMatches) {
      // Read pre-encoding entries during a clean rolling upgrade.
      fileName = legacyFileName;
      filePresent = true;
    }
  }
  let precommitQuarantinePersisted = false;
  try {
    if (state && existingRecord?.status === "admitted") {
      const waveId = waveBySourceId(state, waveSourceId)?.id;
      return { path: queue.path(fileName), ...(waveId ? { waveId } : {}) };
    }

    if (filePresent && !inboxFileMatchesTask(queue, fileName, task, runId)) {
      // Preserve the current hash as quarantined for visibility, but never
      // admit a different body under an already occupied transport id.
      if (state) {
        setQuarantineRecord(state, task, hash, "quarantined");
        try { transaction.writeState(state); } catch { /* availability over bookkeeping */ }
      }
      return null;
    }

    if (!filePresent) {
      // Establish the pre-commit quarantine marker before exposing the task
      // file. If the process dies after the file write, a retry sees this
      // marker and completes the same transaction rather than dropping it on
      // the wx collision.
      if (state) {
        setQuarantineRecord(state, task, hash, "quarantined");
        try { transaction.writeState(state); precommitQuarantinePersisted = true; } catch { /* retry can recover from the file */ }
      }
      try {
        const serializedTask = JSON.stringify({ ...task, runId }, null, 2);
        if (Buffer.byteLength(serializedTask, "utf8") > ACTIVE_QUEUE_OPTIONS.maxEntryBytes) {
          throw new Error("inbox task envelope exceeds its bounded queue entry size");
        }
        queue.writeExclusive(fileName, serializedTask);
        filePresent = true;
      } catch (error) {
        // An external writer may have won the wx race despite this process
        // holding the run lock. Recover only when it filed the same task;
        // another body under this id is an at-most-once collision.
        if (!queue.exists(fileName)) {
          throw new Error(`inbox task ${task.id} not filed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!inboxFileMatchesTask(queue, fileName, task, runId)) return null;
        filePresent = true;
      }
    }
    if (deferAdmission) {
      // A CTO run executes one active wave at a time. Keep this task durable
      // and quarantined, but do not expose a wake until the current wave is
      // finished; the next poll retries the exact task identity.
      if (state && !precommitQuarantinePersisted) {
        setQuarantineRecord(state, task, hash, "quarantined");
        delete (state.inbox_quarantine![hash] as InboxWakeRecord).wake_claim;
        try { transaction.writeState(state); } catch { /* next poll retries */ }
      }
      return filePresent ? { path: queue.path(fileName), deferred: true } : null;
    }


    // The state remains the authoritative admission envelope. Keep the
    // quarantine marker retryable until the wave append succeeds; otherwise
    // an append validation failure must never leave an admitted task with no
    // corresponding wave.
    let waveId: string | undefined = existingWave?.id;
    if (state) {
      setQuarantineRecord(state, task, hash, "quarantined");
      try {
        if (!existingWave) {
          state = transaction.appendWave({
              id: `wave-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              source: waveSource,
              source_id: waveSourceId,
              task: task.text,
              slice_ids: [],
          });
          waveId = waveBySourceId(state, waveSourceId)?.id;
        }
        const record = state.inbox_quarantine![hash] as InboxWakeRecord;
        record.status = "admitted";
        record.wake_claim = claim;
      } catch (error) {
        const record = state.inbox_quarantine?.[hash] as InboxWakeRecord | undefined;
        if (record) {
          record.status = "quarantined";
          delete record.wake_claim;
        }
        throw error;
      }
      try {
        transaction.writeState(state);
      } catch (error) {
        // The file remains durable while the state publication is retried;
        // leave its in-memory marker retryable rather than claiming delivery.
        const record = state.inbox_quarantine?.[hash] as InboxWakeRecord | undefined;
        if (record) {
          record.status = "quarantined";
          delete record.wake_claim;
        }
        throw error;
      }
    }

    return filePresent ? { path: queue.path(fileName), ...(waveId ? { waveId } : {}) } : null;
  } finally {
    queue.close();
  }
}

const SAFE_EXECUTION_SOURCE_ID = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * Core wave source ids are state-segment identifiers, while transports are
 * allowed to expose arbitrary ids (Telegram uses `tg:<message-id>`). Keep the
 * raw transport id in the inbox/quarantine record and derive a bounded,
 * collision-resistant execution id for wave history.
 */
function inboxWaveSourceId(task: InboxTask): string {
  const transport = typeof task.by === "string" ? task.by : "local";
  return `inbox-${createHash("sha256").update(canonicalAuthJson({ transport, id: task.id }), "utf8").digest("hex")}`;
}

/**
 * Hash the complete transport identity, not just the body. This keeps
 * same-text messages from different adapters or message ids independent while
 * making exact retries resolve to one quarantine marker and wave.
 */
function inboxTaskIdentityHash(task: InboxTask): string {
  const transport = typeof task.by === "string" ? task.by : "local";
  return createHash("sha256").update(canonicalAuthJson({ transport, id: task.id, text: task.text }), "utf8").digest("hex");
}

export class WakeEffectAmbiguousError extends Error {
  readonly code = "WAKE_EFFECT_AMBIGUOUS" as const;
  constructor(identity: string) {
    super("wake effect " + identity + " has no authenticated proof");
    this.name = "WakeEffectAmbiguousError";
  }
}

interface WakeEffectRecord {
  schema: 1;
  status: "prepared" | "delivered";
  identity: string;
  run_id: string;
  attempts: number;
  retryable?: boolean;
  answer?: Pick<EscalationAnswer, "id" | "run_id" | "answer">;
  proof: string;
}

interface WakeEffectClaim {
  fileName: string;
}

interface WakeEffectReservation {
  claim?: WakeEffectClaim;
  alreadyDelivered: boolean;
}

const WAKE_EFFECT_PROOF_DOMAIN = "cto-wake-effect-v1" as const;

function wakeEffectProof(authority: CtoRuntimeProofAuthority, record: Omit<WakeEffectRecord, "proof">): string | null {
  return signCtoRuntimeProof(authority, WAKE_EFFECT_PROOF_DOMAIN, canonicalAuthJson({
    schema: record.schema,
    status: record.status,
    identity: record.identity,
    run_id: record.run_id,
    attempts: record.attempts,
    retryable: record.retryable === true,
    answer: record.answer ?? null,
  }));
}

function authenticatedWakeEffect(
  authority: CtoRuntimeProofAuthority,
  runtimeAccess: RuntimeAccess | undefined,
  record: Partial<WakeEffectRecord>,
): record is WakeEffectRecord {
  if (typeof record.run_id !== "string" || typeof record.proof !== "string" || !runtimeAccess) return false;
  const state = runtimeAccess.readState(record.run_id);
  if (!state || state.id !== record.run_id || !runtimeAccess.hasValidStateProof(record.run_id)) return false;
  return verifyCtoRuntimeProof(authority, WAKE_EFFECT_PROOF_DOMAIN, canonicalAuthJson({
    schema: record.schema,
    status: record.status,
    identity: record.identity,
    run_id: record.run_id,
    attempts: record.attempts,
    retryable: record.retryable === true,
    answer: record.answer ?? null,
  }), record.proof);
}

function withWakeEffectProof(authority: CtoRuntimeProofAuthority, record: Omit<WakeEffectRecord, "proof">): WakeEffectRecord {
  const proof = wakeEffectProof(authority, record);
  if (!proof) throw new WakeEffectAmbiguousError(record.identity);
  return { ...record, proof };
}

function reserveWakeEffect(
  root: string,
  runId: string,
  taskId: string,
  suppliedPin: PinnedProjectRoot | undefined,
  answer: Pick<EscalationAnswer, "id" | "run_id" | "answer"> | undefined,
  wakeEvidence: ((identity: string) => boolean | undefined) | undefined,
  proofAuthority: CtoRuntimeProofAuthority,
  runtimeAccess: RuntimeAccess,
): WakeEffectReservation {
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new WakeEffectAmbiguousError(taskId);
  const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", runId, "wake-effects"), { pinnedRoot });
  if (!queue) {
    if (!suppliedPin) pinnedRoot.close();
    throw new WakeEffectAmbiguousError(taskId);
  }
  const fileName = sha256Hex(runId + "/" + taskId) + ".json";
  try {
    const state = runtimeAccess.readState(runId);
    if (!state || state.id !== runId || !runtimeAccess.hasValidStateProof(runId)) throw new WakeEffectAmbiguousError(taskId);
    if (!queue.exists(fileName)) {
      const record = withWakeEffectProof(proofAuthority, { schema: 1, status: "prepared", identity: taskId, run_id: runId, attempts: 1, ...(answer ? { answer } : {}) });
      queue.writeExclusive(fileName, JSON.stringify(record, null, 2));
      return { claim: { fileName }, alreadyDelivered: false };
    }
    const current = queue.readJson<WakeEffectRecord>(fileName);
    if (!authenticatedWakeEffect(proofAuthority, runtimeAccess, current)) throw new WakeEffectAmbiguousError(taskId);
    if (current.status === "delivered" && current.identity === taskId && current.run_id === runId) return { alreadyDelivered: true };
    if (current.status !== "prepared" || current.identity !== taskId || current.run_id !== runId || !Number.isInteger(current.attempts) || current.attempts < 1) throw new WakeEffectAmbiguousError(taskId);
    if (current.retryable === true && answer && current.answer?.id === answer.id && current.answer.answer === answer.answer) return { claim: { fileName }, alreadyDelivered: false };
    const evidence = wakeEvidence?.(taskId);
    if (evidence === true) return { claim: { fileName }, alreadyDelivered: true };
    if (evidence === false) return { claim: { fileName }, alreadyDelivered: false };
    throw new WakeEffectAmbiguousError(taskId);
  } catch (error) {
    if (error instanceof WakeEffectAmbiguousError) throw error;
    throw new WakeEffectAmbiguousError(taskId);
  } finally {
    queue.close();
    if (!suppliedPin) pinnedRoot.close();
  }
}

function removeInboxTaskFile(root: string, runId: string, task: InboxTask, suppliedPin?: PinnedProjectRoot): void {
  const taskId = task.id;
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return;
  const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", runId, "inbox"), { pinnedRoot });
  if (!queue) {
    if (!suppliedPin) pinnedRoot.close();
    return;
  }
  try {
    const candidates = new Set([inboxMessageFileName(taskId), legacyInboxMessageFileName(taskId)]);
    for (const fileName of candidates) {
      if (!queue.exists(fileName)) continue;
      try {
        // Capture one bounded read and its exact expectation. Never reread by
        // pathname before removal: a same-id replacement must survive rollback.
        const observed = queue.read(fileName);
        const parsed = JSON.parse(decodeUtf8(observed.bytes)) as unknown;
        const current = normalizeInboundTask(parsed, ACTIVE_QUEUE_OPTIONS.maxEntryBytes, true);
        if (!current
          || current.id !== taskId
          || current.runId !== runId
          || inboxTaskIdentityHash(current) !== inboxTaskIdentityHash({ ...task, runId })) continue;
        queue.removeIfMatches(fileName, observed.expectation);
      } catch {
        // Rollback is best-effort; a later admission can safely inspect it.
      }
    }
  } finally {
    queue.close();
    if (!suppliedPin) pinnedRoot.close();
  }
}

function markWakeEffectDelivered(root: string, runId: string, claim: WakeEffectClaim, taskId: string, suppliedPin: PinnedProjectRoot | undefined, proofAuthority: CtoRuntimeProofAuthority, runtimeAccess: RuntimeAccess): void {
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new WakeEffectAmbiguousError(taskId);
  const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", runId, "wake-effects"), { createDirectory: false, pinnedRoot });
  if (!queue) {
    if (!suppliedPin) pinnedRoot.close();
    throw new WakeEffectAmbiguousError(taskId);
  }
  try {
    const current = queue.readJson<WakeEffectRecord>(claim.fileName);
    if (!authenticatedWakeEffect(proofAuthority, runtimeAccess, current)) throw new WakeEffectAmbiguousError(taskId);
    if (current.status === "delivered") return;
    if (current.status !== "prepared" || current.identity !== taskId || current.run_id !== runId) {
      throw new WakeEffectAmbiguousError(taskId);
    }
    const { proof: _proof, ...withoutProof } = current;
    const next = withWakeEffectProof(proofAuthority, { ...withoutProof, status: "delivered" });
    queue.replaceIfMatches(claim.fileName, queueExpected(queue.read(claim.fileName)), JSON.stringify(next, null, 2));
  } catch (error) {
    if (error instanceof WakeEffectAmbiguousError) throw error;
    throw new WakeEffectAmbiguousError(taskId);
  } finally {
    queue.close();
    if (!suppliedPin) pinnedRoot.close();
  }
}

function markWakeEffectRetryable(
  root: string,
  runId: string,
  claim: WakeEffectClaim,
  answer: Pick<EscalationAnswer, "id" | "run_id" | "answer">,
  suppliedPin: PinnedProjectRoot | undefined,
  proofAuthority: CtoRuntimeProofAuthority,
  runtimeAccess: RuntimeAccess,
): void {
  if (answer.run_id !== runId) throw new WakeEffectAmbiguousError(answer.id);
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new WakeEffectAmbiguousError(answer.id);
  const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", runId, "wake-effects"), { createDirectory: false, pinnedRoot });
  if (!queue) {
    if (!suppliedPin) pinnedRoot.close();
    throw new WakeEffectAmbiguousError(answer.id);
  }
  try {
    const current = queue.readJson<WakeEffectRecord>(claim.fileName);
    if (!authenticatedWakeEffect(proofAuthority, runtimeAccess, current)) throw new WakeEffectAmbiguousError(answer.id);
    if (current.status === "delivered") return;
    if (current.status !== "prepared" || current.identity !== answer.id || current.run_id !== runId) {
      throw new WakeEffectAmbiguousError(answer.id);
    }
    const { proof: _proof, ...withoutProof } = current;
    const next = withWakeEffectProof(proofAuthority, { ...withoutProof, retryable: true, answer });
    queue.replaceIfMatches(claim.fileName, queueExpected(queue.read(claim.fileName)), JSON.stringify(next, null, 2));
  } catch (error) {
    if (error instanceof WakeEffectAmbiguousError) throw error;
    throw new WakeEffectAmbiguousError(answer.id);
  } finally {
    queue.close();
    if (!suppliedPin) pinnedRoot.close();
  }
}

function releaseWakeEffect(root: string, runId: string, claim: WakeEffectClaim, suppliedPin?: PinnedProjectRoot): void {
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return;
  const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", runId, "wake-effects"), { createDirectory: false, pinnedRoot });
  if (!queue) {
    if (!suppliedPin) pinnedRoot.close();
    return;
  }
  try {
    const current = queue.read(claim.fileName);
    queue.removeIfMatches(claim.fileName, queueExpected(current));
  } catch {
    // Leave a durable claim if cleanup races; at-most-once is safer than replay.
  } finally {
    queue.close();
    if (!suppliedPin) pinnedRoot.close();
  }
}



function acknowledgeInboxWake(root: string, runId: string, task: InboxTask, hash: string, suppliedPin?: PinnedProjectRoot, runtimeAccess?: RuntimeAccess, serviceAuthority?: RuntimeServiceAuthority): void {
  void runtimeAccess;
  if (!serviceAuthority) throw new Error("inbox service mutation authority is unavailable");
  const pin = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pin) throw new Error("inbox service mutation root is unavailable");
  try {
    assertCtoRuntimeServiceMutationAuthorityBound(serviceAuthority, pin);
    withCtoRuntimeServiceTransaction(serviceAuthority, runId, (transaction) => {
      const state = transaction.readState();
      const record = state.inbox_quarantine?.[hash];
      if (!record || record.id !== task.id || record.status === "rejected") return;
      if (record.wake_status === "delivered") return;
      record.status = "admitted";
      record.wake_status = "delivered";
      delete (record as InboxWakeRecord).wake_claim;
      transaction.writeState(state);
    });
  } finally {
    if (!suppliedPin) pin.close();
  }
}

/**
 * Write an inbox task and wake the CTO session.
 *
 * The per-run transaction lock covers current-state dedupe, quarantine, the
 * durable wx file claim, and the final admitted+wave state commit. The wake
 * callback runs after releasing that lock; a failed wake rolls back only this
 * task's file and quarantine marker under a fresh lock. This keeps unrelated
 * run ids concurrent while preventing stale full-envelope writes within one
 * run.
 */
export function handleInboxTask(
  root: string,
  task: InboxTask,
  onTask: ((t: InboxTask) => void | Promise<void>) | undefined,
  opts: { idempotentWake?: boolean; wakeEvidence?: (identity: string) => boolean | undefined; pinnedRoot?: PinnedProjectRoot; isOwned?: () => boolean; runtimeAccess?: RuntimeAccess; serviceAuthority?: RuntimeServiceAuthority; proofAuthority: CtoRuntimeProofAuthority },
): string | null | Promise<string | null> {
  const suppliedPin = opts.pinnedRoot;
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return null;
  const ownsPin = !suppliedPin;
  let deferredClose = false;
  const closeOwnedPin = (): void => { if (ownsPin) pinnedRoot.close(); };
  const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => Boolean(value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function");
  try {
    if (!pinnedRoot.isStable() || (opts.isOwned && !opts.isOwned())) return null;
    if (opts.idempotentWake) {
      try { assertCtoRuntimeProofAuthorityLive(opts.proofAuthority); } catch { return null; }
    }
    const normalizedTask = normalizeInboundTask(task, ACTIVE_QUEUE_OPTIONS.maxEntryBytes, true);
    if (!normalizedTask) return null;
    task = normalizedTask;
    const runId = task.runId ?? resolveInboxRunId(root, pinnedRoot, opts.runtimeAccess);
    const rawText = task.text;
    const normalized = rawText.trim();
    const hash = inboxTaskIdentityHash({ ...task, text: rawText });
    if (!isSafeCtoInboundText(rawText, MAX_INBOX_TEXT_LENGTH)) {
      const reason = normalized.length === 0 ? "empty text" : normalized.length > MAX_INBOX_TEXT_LENGTH ? "text exceeds MAX_INBOX_TEXT_LENGTH" : "text contains unsafe control characters";
      const quarantineFence: MutationFence = { pinnedRoot, runtimeAccess: opts.runtimeAccess };
      assertMutationLive(quarantineFence);
      recordQuarantine(root, runId, task, hash, "rejected", reason, pinnedRoot, opts.runtimeAccess, opts.serviceAuthority);
      assertMutationLive(quarantineFence);
      return null;
    }
    const claim = currentWakeClaim();
    if (!opts.runtimeAccess || !opts.serviceAuthority) return null;
    try { assertCtoRuntimeServiceMutationAuthorityBound(opts.serviceAuthority, pinnedRoot); } catch { return null; }
    const admission = withCtoRuntimeServiceTransaction(opts.serviceAuthority, runId, (transaction) => admitInboxTaskUnderLock(root, runId, task, hash, claim, transaction, pinnedRoot));
    if (!admission) return null;
    if (admission.deferred) return admission.path;
    let wakeEffect: WakeEffectClaim | undefined;
    const rollbackWake = (error: unknown): never => {
      if (wakeEffect) releaseWakeEffect(root, runId, wakeEffect, pinnedRoot);
      try {
        opts.serviceAuthority && (assertCtoRuntimeServiceMutationAuthorityBound(opts.serviceAuthority, pinnedRoot), withCtoRuntimeServiceTransaction(opts.serviceAuthority, runId, (transaction) => {
          const current = transaction.readState();
          const record = current.inbox_quarantine?.[hash];
          const wakeWasDelivered = record?.status === "admitted" && record.id === task.id && record.wake_status === "delivered";
          if (record?.status === "admitted" && record.id === task.id && !wakeWasDelivered) {
            record.status = "quarantined";
            record.wake_status = "pending";
            delete (record as InboxWakeRecord).wake_claim;
            transaction.writeState(current);
          }
          if (!wakeWasDelivered) removeInboxTaskFile(root, runId, task, pinnedRoot);
        }));
      } catch {
        // The wake failure is primary; preserve durable evidence for recovery.
      }
      throw error;
    };
    let reservation: WakeEffectReservation | undefined;
    try {
      reservation = opts.idempotentWake ? reserveWakeEffect(root, runId, task.id, pinnedRoot, undefined, opts.wakeEvidence, opts.proofAuthority, opts.runtimeAccess!) : undefined;
    } catch (error) {
      rollbackWake(error);
    }
    if (reservation?.alreadyDelivered) {
      if (reservation.claim) markWakeEffectDelivered(root, runId, reservation.claim, task.id, pinnedRoot, opts.proofAuthority, opts.runtimeAccess!);
      acknowledgeInboxWake(root, runId, task, hash, pinnedRoot, opts.runtimeAccess, opts.serviceAuthority);
      return admission.path;
    }
    wakeEffect = reservation?.claim;
    const acknowledgeWake = (): string => {
      try {
        if (!pinnedRoot.isStable() || (opts.isOwned && !opts.isOwned())) throw new Error("messenger dispatcher lease lost before task acknowledgement");
        if (wakeEffect) markWakeEffectDelivered(root, runId, wakeEffect, task.id, pinnedRoot, opts.proofAuthority, opts.runtimeAccess!);
        acknowledgeInboxWake(root, runId, task, hash, pinnedRoot, opts.runtimeAccess, opts.serviceAuthority);
      } catch (error) {
        if (isDispatcherActivationFailure(error)) throw error;
        throw new Error(`inbox task ${task.id} wake acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const channelSet = createChannelSet(root, undefined, pinnedRoot, opts.runtimeAccess, opts.proofAuthority);
        if (channelSet.profile.direction === "rw" && channelSet.primary !== null) {
          const excerpt = task.text.trim().slice(0, 200);
          queueCtoDelivery(root, runId, {
            id: `${runId}/wave/${task.id}/ack`, level: "question", title: "CTO task admitted",
            body: `Run ${runId} admitted task "${excerpt}"${admission.waveId ? ` as wave ${admission.waveId}` : ""}.`, intent: "ack",
            ...(channelSet.profile.ackTarget ? { target: channelSet.profile.ackTarget } : {}),
          }, pinnedRoot, opts.isOwned, opts.runtimeAccess);
          opts.runtimeAccess?.assertLive();
          if (!pinnedRoot.isStable()) throw new DispatcherActivationRevokedError("dispatcher project root identity changed");
        }
      } catch (error) {
        if (isDispatcherActivationFailure(error)) throw error;
      }
      return admission.path;
    };
    let callbackResult: void | Promise<void>;
    try {
      if (!pinnedRoot.isStable() || (opts.isOwned && !opts.isOwned())) throw new Error("messenger dispatcher lease lost or root changed before task wake");
      callbackResult = onTask?.({ ...task, runId, ...(admission.waveId ? { waveId: admission.waveId } : {}) });
      if (isPromiseLike(callbackResult)) {
        deferredClose = true;
        const completion = Promise.resolve(callbackResult).then(() => {
          try {
            if (!pinnedRoot.isStable() || (opts.isOwned && !opts.isOwned())) throw new Error("pinned project root changed during task wake");
          } catch (error) { return rollbackWake(error); }
          return acknowledgeWake();
        }, (error) => rollbackWake(error));
        return completion.finally(closeOwnedPin);
      }
      if (!pinnedRoot.isStable()) throw new Error("pinned project root changed during task wake");
    } catch (error) { rollbackWake(error); }
    return acknowledgeWake();
  } finally {
    if (!deferredClose) closeOwnedPin();
  }
}

type WakeAuthorityStatus = "active" | "stale" | "retryable";

function classifyWakeAuthority(runId: string, pinnedRoot: PinnedProjectRoot, expectedRevision?: number, runtimeAccess?: RuntimeAccess): WakeAuthorityStatus {
  void pinnedRoot;
  const state = runtimeState(runtimeAccess, runId);
  if (!state) {
    try {
      return pinnedRoot.pathEntryExists(join(".work-state", "cto", runId, "state.json")) ? "retryable" : "stale";
    } catch {
      return "retryable";
    }
  }
  if (state.id !== runId || terminalState(state)) return "stale";
  if (expectedRevision !== undefined) {
    const stateRevision = typeof state.state_revision === "number" && Number.isSafeInteger(state.state_revision) && state.state_revision >= 0 ? state.state_revision : 0;
    if (stateRevision !== expectedRevision) return "retryable";
  }
  return "active";
}
type InboxWakeAuthority =
  | { readonly status: "active"; readonly runId: string; readonly stateRevision: number }
  | { readonly status: "stale" | "retryable" };

function resolveInboxWakeAuthority(root: string, runId: string, pinnedRoot: PinnedProjectRoot, runtimeAccess?: RuntimeAccess): InboxWakeAuthority {
  let active: { runId: string; state: RuntimeStateView } | null;
  try {
    active = runtimeActive(runtimeAccess);
  } catch {
    return { status: "retryable" };
  }
  if (!active) {
    const status = classifyWakeAuthority(runId, pinnedRoot, undefined, runtimeAccess);
    return status === "active" ? { status: "retryable" } : { status };
  }
  if (active.runId !== runId) return { status: "stale" };
  const stateRevision = typeof active.state.state_revision === "number" && Number.isSafeInteger(active.state.state_revision) && active.state.state_revision >= 0 ? active.state.state_revision : 0;
  return { status: "active", runId: active.runId, stateRevision };
}

/**
 * Revalidate a cached wake authority without the full canonical recovery scan.
 * The active-index candidate is still read through the core's descriptor-anchored
 * reader, and the candidate must match the pinned state image exactly. A state
 * or index transition is retryable; a terminal/missing run is stale.
 */
function revalidateInboxWakeAuthority(
  runId: string,
  pinnedRoot: PinnedProjectRoot,
  expectedRevision: number,
  runtimeAccess?: RuntimeAccess,
): WakeAuthorityStatus {
  void pinnedRoot;
  const state = runtimeState(runtimeAccess, runId);
  if (!state) {
    try {
      return pinnedRoot.pathEntryExists(join(".work-state", "cto", runId, "state.json")) ? "retryable" : "stale";
    } catch {
      return "retryable";
    }
  }
  if (state.id !== runId || terminalState(state)) return "stale";
  if (state.state_revision !== expectedRevision) return "retryable";
  if (!runtimeAccess) return "retryable";
  let candidates: ReturnType<RuntimeAccess["readActiveDeliveryCandidates"]>;
  try {
    candidates = runtimeAccess.readActiveDeliveryCandidates();
  } catch {
    return "retryable";
  }
  if (!candidates.ok) return "retryable";
  // The index's active pointer is the canonical cross-run authority. A run
  // that was active when the poll started becomes stale as soon as another
  // run owns that pointer; never let a cached same-run entry cross that fence.
  if (candidates.active_run_id !== runId) return "stale";
  const entry = candidates.entries.find((candidate) => candidate.run_id === runId);
  if (!entry || !stateMatchesRunDeliveryIndex(state, entry)) return "retryable";
  return "active";
}


type AnswerWakeOutcome = "delivered" | "stale" | "retryable";

async function deliverAnswerWake(
  root: string,
  answer: Pick<EscalationAnswer, "id" | "run_id" | "answer">,
  onAnswer: ((answer: Pick<EscalationAnswer, "id" | "run_id" | "answer">) => void | Promise<void>) | undefined,
  opts: { idempotentWake?: boolean; wakeEvidence?: (identity: string) => boolean | undefined; pinnedRoot?: PinnedProjectRoot; activeRunId?: string; activeStateRevision?: number; isOwned?: () => boolean; lifecycle?: AdapterOperationContext; runtimeAccess?: RuntimeAccess; serviceAuthority?: RuntimeServiceAuthority; proofAuthority: CtoRuntimeProofAuthority },
): Promise<AnswerWakeOutcome> {
  const runId = answer.run_id;
  if (!safeRunId(runId)) return "stale";
  const expectedRevision = opts.activeRunId === undefined ? undefined : opts.activeStateRevision;
  if (opts.activeRunId !== undefined
    && (opts.activeRunId !== runId || typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) return "stale";
  const suppliedPin = opts.pinnedRoot;
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return "retryable";
  let authority: WakeAuthorityStatus;
  try {
    if (opts.activeRunId === undefined) {
      const resolved = resolveInboxWakeAuthority(root, runId, pinnedRoot, opts.runtimeAccess);
      authority = resolved.status === "active"
        ? revalidateInboxWakeAuthority(runId, pinnedRoot, resolved.stateRevision, opts.runtimeAccess)
        : resolved.status;
    } else {
      authority = revalidateInboxWakeAuthority(runId, pinnedRoot, expectedRevision!, opts.runtimeAccess);
    }
  } finally {
    if (!suppliedPin) pinnedRoot.close();
  }
  if (authority !== "active") return authority;
  // The dispatcher lease is an independent ownership fence from the run
  // authority above. Re-check it before reserving/calling the wake callback so
  // a same-path root replacement cannot make a copied lock look live.
  if (opts.isOwned && !opts.isOwned()) return "retryable";
  const reservation = opts.idempotentWake
    ? reserveWakeEffect(root, runId, answer.id, opts.pinnedRoot, answer, opts.wakeEvidence, opts.proofAuthority, opts.runtimeAccess!)
    : undefined;
  if (reservation?.alreadyDelivered) {
    if (reservation.claim) markWakeEffectDelivered(root, runId, reservation.claim, answer.id, opts.pinnedRoot, opts.proofAuthority, opts.runtimeAccess!);
    return "delivered";
  }
  const claim = reservation?.claim;
  try {
    // Reservation itself can race with lease loss. Never invoke user code after
    // ownership changed; leave a claimed idempotent effect retryable for the
    // next owner instead of acknowledging a wake on a replaced root.
    if (opts.isOwned && !opts.isOwned()) {
      if (claim) markWakeEffectRetryable(root, runId, claim, answer, opts.pinnedRoot, opts.proofAuthority, opts.runtimeAccess!);
      return "retryable";
    }
    await boundedAdapterCall(
      () => onAnswer?.(answer),
      opts.lifecycle,
      opts.lifecycle?.trackUnderlyingCallback,
    );
    if (opts.isOwned && !opts.isOwned()) {
      if (claim) markWakeEffectRetryable(root, runId, claim, answer, opts.pinnedRoot, opts.proofAuthority, opts.runtimeAccess!);
      return "retryable";
    }
  } catch (error) {
    if (isDispatcherActivationFailure(error)) throw error;
    if (claim) {
      try {
        markWakeEffectRetryable(root, runId, claim, answer, opts.pinnedRoot, opts.proofAuthority, opts.runtimeAccess!);
      } catch {
        // Keep the prepared effect when the retry marker cannot be published.
      }
    }
    throw error;
  }
  if (claim) markWakeEffectDelivered(root, runId, claim, answer.id, opts.pinnedRoot, opts.proofAuthority, opts.runtimeAccess!);
  return "delivered";
}

async function replayPendingAnswerWakes(
  root: string,
  onAnswer: ((answer: Pick<EscalationAnswer, "id" | "run_id" | "answer">) => void | Promise<void>) | undefined,
  opts: { idempotentWake?: boolean; wakeEvidence?: (identity: string) => boolean | undefined; pinnedRoot?: PinnedProjectRoot; isOwned?: () => boolean; lifecycle?: AdapterOperationContext; runtimeAccess?: RuntimeAccess; serviceAuthority?: RuntimeServiceAuthority; proofAuthority: CtoRuntimeProofAuthority },
): Promise<void> {
  if (!opts.idempotentWake) return;
  const pinnedRoot = opts.pinnedRoot ?? PinnedProjectRoot.open(root);
  if (!pinnedRoot) return;
  const ownsPin = opts.pinnedRoot === undefined;
  const active = runtimeActive(opts.runtimeAccess);
  const queue = active
    ? openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", active.runId, "wake-effects"), { createDirectory: false, pinnedRoot })
    : null;
  if (!queue) {
    if (ownsPin) pinnedRoot.close();
    return;
  }
  try {
    for (const entry of boundedQueueEntries(queue)) {
      if (!entry.name.endsWith(".json")) continue;
      let record: WakeEffectRecord;
      try {
        record = queue.readJson<WakeEffectRecord>(entry.name);
      } catch {
        continue;
      }
      if (!record.retryable || record.status !== "prepared" || record.run_id !== active!.runId || !record.answer) continue;
      const answer = normalizePolledAnswer(record.answer);
      if (!answer) continue;
      try {
        await deliverAnswerWake(root, answer, onAnswer, opts);
      } catch (error) {
        if (isDispatcherActivationFailure(error)) throw error;
        // Keep the retryable effect for the next poll/restart.
      }
    }
  } finally {
    queue.close();
    if (ownsPin) pinnedRoot.close();
  }
}

/**
 * Poll all inbox sources:
 *  1. local drop `<root>/.omp/inbox/*.json` (moved into the run inbox),
 *  2. telegram `pollOnce()` — answer files are written by the adapter; plain
 *     messages are routed to the inbox handler via `setPlainMessageHandler`.
 * Never throws.
 */
export async function pollInbox(
  root: string,
  adapter: EscalationAdapter | null,
  onTask: ((t: InboxTask) => void) | undefined,
  onAnswer: ((a: Pick<EscalationAnswer, "id" | "run_id" | "answer">) => void | Promise<void>) | undefined,
  opts: { isOwned?: () => boolean; idempotentWake?: boolean; wakeEvidence?: (identity: string) => boolean | undefined; now?: RetryClock; pinnedRoot?: PinnedProjectRoot; lifecycle?: AdapterOperationContext; runtimeAccess?: RuntimeAccess; serviceAuthority?: RuntimeServiceAuthority; retryCursorStore?: Map<string, string | null>; proofAuthority: CtoRuntimeProofAuthority },
): Promise<void> {
  const suppliedPollPin = opts.pinnedRoot;
  const pollPin = suppliedPollPin ?? PinnedProjectRoot.open(root);
  const ownsPollPin = suppliedPollPin === undefined;
  if (!pollPin) return;
  try {
    if (!pollPin.isStable()) return;
  const assertPollLive = (): void => {
    try {
      opts.lifecycle?.assertLive?.();
      opts.runtimeAccess?.assertLive();
    } catch (error) {
      if (isDispatcherActivationFailure(error)) {
        if (error instanceof DispatcherActivationRevokedError) throw error;
        throw new DispatcherActivationRevokedError("activation_revoked: " + (error instanceof Error ? error.message : String(error)));
      }
      throw new DispatcherActivationRevokedError(error instanceof Error ? error.message : "dispatcher activation is no longer live");
    }
    if (!pollPin!.isStable()) throw new DispatcherActivationRevokedError("dispatcher project root identity changed");
  };
  const discardPollEntry = (queue: BoundedQueue, name: string, expected: BoundedQueueEntryExpectation | undefined, rejectedDirectory: string): void => {
    assertPollLive();
    discardQueueEntry(queue, name, expected, rejectedDirectory);
    assertPollLive();
  };
  const quarantinePollEntry = (queue: BoundedQueue, name: string, expected: BoundedQueueEntryExpectation | undefined, rejectedDirectory: string): void => {
    assertPollLive();
    quarantineQueueEntry(queue, name, expected, rejectedDirectory);
    assertPollLive();
  };
  const movePollEntry = (queue: BoundedQueue, name: string, expected: BoundedQueueEntryExpectation | undefined): void => {
    assertPollLive();
    moveQueueEntry(queue, name, "processed", expected);
    assertPollLive();
  };
  const persistPollRetryEntry = (...args: Parameters<typeof persistInboxRetryEntry>): void => {
    assertPollLive();
    persistInboxRetryEntry(...args);
    assertPollLive();
  };
  const promotePollRetryEntries = (...args: Parameters<typeof promoteRetryEntries>): void => {
    assertPollLive();
    promoteRetryEntries(...args);
    assertPollLive();
  };
  const taskCallback = onTask;
  const wakeTask = taskCallback === undefined
    ? undefined
    : (task: InboxTask): Promise<void> => boundedAdapterCall(
      () => taskCallback(task),
      opts.lifecycle,
      opts.lifecycle?.trackUnderlyingCallback,
    );
  assertPollLive();
  // 1. Local drop (bridge-written tasks + answer markers, or manual/test
  //    injection). The bridge files answers as { kind: "answer" } markers so
  //    the session wakes [CTO-ANSWER] even though it does not poll telegram.
  const wakeAuthorityCache = new Map<string, InboxWakeAuthority>();
  const authorityFor = (runId: string): InboxWakeAuthority => {
    const cached = wakeAuthorityCache.get(runId);
    if (cached) return cached;
    const resolved = resolveInboxWakeAuthority(root, runId, pollPin!, opts.runtimeAccess);
    if (resolved.status === "active") wakeAuthorityCache.set(runId, resolved);
    return resolved;
  };
  try {
    await replayPendingAnswerWakes(root, onAnswer, { ...opts, pinnedRoot: pollPin });
    const activeDirectory = join(".omp", "inbox");
    const retryDirectory = join(".omp", "inbox-retry");
    const rejectedDirectory = join(".omp", "inbox-rejected");
    const dropQueue = openBoundedQueue(pollPin.canonical_root, activeDirectory, { ...ACTIVE_QUEUE_OPTIONS, createDirectory: false, pinnedRoot: pollPin });
    if (dropQueue) {
      let retrySecret: string | null | undefined;
      const currentRetrySecret = (): string | null => {
        if (retrySecret === undefined) {
          assertPollLive();
          retrySecret = readOrCreateRetrySecret(root, pollPin);
          assertPollLive();
        }
        return retrySecret;
      };
      try {
        if (!queueHasActiveWork(dropQueue, "processed")) {
          assertPollLive();
          const secret = currentRetrySecret();
          promotePollRetryEntries(root, activeDirectory, retryDirectory, rejectedDirectory, "inbox", retryClockNow(opts.now), pollPin, secret, undefined, undefined, undefined, undefined, undefined, opts.retryCursorStore);
        }
        let activeWork = 0;
        for (const entry of boundedQueueEntries(dropQueue)) {
          const name = entry.name;
          assertPollLive();
          if (opts.isOwned && !opts.isOwned()) break;
          if (name === "processed" && isArchiveDirectory(dropQueue, name)) continue;
          if (activeWork >= ACTIVE_WORK_LIMIT) break;
          activeWork += 1;
          if (!name.endsWith(".json")) {
            let expected: BoundedQueueEntryExpectation;
            try { expected = dropQueue.classify(name); } catch (error) { rethrowActivationFailure(error); continue; }
            discardPollEntry(dropQueue, name, expected, rejectedDirectory);
            continue;
          }
          let utf8Decoded = false;
          let observed: { dev: number; ino: number; bytes: Uint8Array; expectation: BoundedQueueEntryExpectation } | undefined;
          let envelope: AuthenticatedInboxEnvelope | null = null;
          let verifiedRetry: VerifiedInboxRetry | null = null;
          try {
            observed = dropQueue.read(name);
            const text = decodeUtf8(observed.bytes);
            utf8Decoded = true;
            const raw = JSON.parse(text) as unknown;
            const retryCandidate = Boolean(raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "inbox-retry");
            verifiedRetry = retryCandidate ? verifyInboxRetryWrapper(root, raw, pollPin, currentRetrySecret()) : null;
            if (verifiedRetry) {
              const activeMetadata = retryActiveMetadata(name);
              const expectedName = activeMetadata?.originalName ?? verifiedRetry.wrapper.original_name;
              const authority = authorityFor(verifiedRetry.source.run_id);
              assertPollLive();
              if (authority.status !== "active") {
                if (authority.status === "retryable") throw new Error("inbox wake authority unavailable");
                discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory);
                continue;
              }
              if (verifiedRetry.wrapper.original_name !== expectedName) {
                discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory);
                continue;
              }
              if (verifiedRetry.wrapper.due_at > retryClockNow(opts.now)) continue;
              if (verifiedRetry.source.kind === "answer") {
                const answer = normalizePolledAnswer({
                  id: verifiedRetry.source.id,
                  run_id: verifiedRetry.source.run_id,
                  answer: verifiedRetry.source.text,
                  at: verifiedRetry.source.at,
                  by: verifiedRetry.source.by,
                });
                if (!answer || answer.run_id !== authority.runId) {
                  discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory);
                  continue;
                }
                const wakeOutcome = await deliverAnswerWake(root, answer, onAnswer, {
                  ...opts,
                  pinnedRoot: pollPin,
                  activeRunId: authority.runId,
                  activeStateRevision: authority.stateRevision,
                });
                if (wakeOutcome === "retryable") throw new Error("active inbox wake authority changed during delivery");
                if (wakeOutcome === "stale") {
                  discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory);
                  continue;
                }
              } else {
                const task: InboxTask = { id: verifiedRetry.source.id, text: verifiedRetry.source.text, at: verifiedRetry.source.at, by: verifiedRetry.source.by, runId: verifiedRetry.source.run_id };
                assertPollLive();
                const outcome = await dispatchInboxTask(root, task, wakeTask, { idempotentWake: opts.idempotentWake, wakeEvidence: opts.wakeEvidence, pinnedRoot: pollPin, isOwned: opts.isOwned, runtimeAccess: opts.runtimeAccess, serviceAuthority: opts.serviceAuthority, proofAuthority: opts.proofAuthority });
                assertPollLive();
                if (outcome === "retryable") throw new InboxTaskRetryableError();
                if (outcome === "rejected") { discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory); continue; }
              }
            } else {
              const isAnswer = Boolean(raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "answer");
              envelope = verifyAuthenticatedInboxEnvelope(root, raw, isAnswer ? "answer" : "task", pollPin, ACTIVE_QUEUE_OPTIONS.maxEntryBytes, false, opts.proofAuthority);
              // Keep the public verifier strict while allowing a bounded,
              // authenticated oversized task to reach handleInboxTask. That
              // path records the durable rejection reason instead of silently
              // discarding a validly signed producer envelope.
              if (!envelope && !isAnswer) {
                envelope = verifyAuthenticatedInboxEnvelope(root, raw, "task", pollPin, ACTIVE_QUEUE_OPTIONS.maxEntryBytes, true, opts.proofAuthority);
              }
              if (!envelope) {
                discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory);
                continue;
              }
              const authority = authorityFor(envelope.run_id);
              assertPollLive();
              if (authority.status !== "active") {
                if (authority.status === "retryable") throw new Error("inbox wake authority unavailable");
                discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory);
                continue;
              }
              if (isAnswer) {
                const answer = normalizePolledAnswer({
                  id: envelope.id,
                  run_id: envelope.run_id,
                  answer: envelope.text,
                  at: envelope.at,
                  by: envelope.by,
                });
                if (!answer || answer.run_id !== authority.runId) {
                  discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory);
                  continue;
                }
                const wakeOutcome = await deliverAnswerWake(root, answer, onAnswer, {
                  ...opts,
                  pinnedRoot: pollPin,
                  activeRunId: authority.runId,
                  activeStateRevision: authority.stateRevision,
                });
                if (wakeOutcome === "retryable") throw new Error("active inbox wake authority changed during delivery");
                if (wakeOutcome === "stale") {
                  discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory);
                  continue;
                }
              } else {
                const task: InboxTask = { id: envelope.id, text: envelope.text, at: envelope.at, by: envelope.by, runId: envelope.run_id };
                if (envelope.text.trim().length === 0 || envelope.text.length > MAX_INBOX_TEXT_LENGTH) {
                  try {
                    assertPollLive();
                    await handleInboxTask(root, task, wakeTask, { idempotentWake: opts.idempotentWake, wakeEvidence: opts.wakeEvidence, pinnedRoot: pollPin, isOwned: opts.isOwned, runtimeAccess: opts.runtimeAccess, serviceAuthority: opts.serviceAuthority, proofAuthority: opts.proofAuthority });
                    assertPollLive();
                  } catch (error) {
                    if (error instanceof InboxTaskRetryableError || !pollPin.isStable() || (opts.isOwned && !opts.isOwned())) throw error instanceof InboxTaskRetryableError ? error : new InboxTaskRetryableError();
                  }
                  if (!pollPin.isStable() || (opts.isOwned && !opts.isOwned())) throw new InboxTaskRetryableError();
                  discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory);
                  continue;
                }
                assertPollLive();
                const outcome = await dispatchInboxTask(root, task, wakeTask, { idempotentWake: opts.idempotentWake, wakeEvidence: opts.wakeEvidence, pinnedRoot: pollPin, isOwned: opts.isOwned, runtimeAccess: opts.runtimeAccess, serviceAuthority: opts.serviceAuthority, proofAuthority: opts.proofAuthority });
                assertPollLive();
                if (outcome === "retryable") throw new InboxTaskRetryableError();
                if (outcome === "rejected") { discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory); continue; }
              }
            }
            movePollEntry(dropQueue, name, observed?.expectation);
          } catch (error) {
            if (isDispatcherActivationFailure(error)) throw error;
            if (!observed) discardPollEntry(dropQueue, name, undefined, rejectedDirectory);
            else if (!utf8Decoded) quarantinePollEntry(dropQueue, name, observed?.expectation, rejectedDirectory);
            else if (verifiedRetry) {
              assertPollLive();
              const secret = currentRetrySecret();
              persistPollRetryEntry(dropQueue, name, observed, root, verifiedRetry.source, retryDirectory, verifiedRetry.wrapper.attempt + 1, retryClockNow(opts.now), pollPin, secret);
            } else if (envelope) {
              assertPollLive();
              const secret = currentRetrySecret();
              persistPollRetryEntry(dropQueue, name, observed, root, envelope, retryDirectory, 1, retryClockNow(opts.now), pollPin, secret);
            } else discardPollEntry(dropQueue, name, observed?.expectation, rejectedDirectory);
          }
        }
        if (!queueHasActiveWork(dropQueue, "processed")) {
          assertPollLive();
          const secret = currentRetrySecret();
          promotePollRetryEntries(root, activeDirectory, retryDirectory, rejectedDirectory, "inbox", retryClockNow(opts.now), pollPin, secret, undefined, undefined, undefined, undefined, undefined, opts.retryCursorStore);
        }
      } finally {
        dropQueue.close();
      }
    }
  } catch (error) {
    if (isDispatcherActivationFailure(error)) throw error;
    // drop missing or unsafe — nothing to do
  }
  // 2. Adapter long-poll (answers + plain-message inbox) — Telegram is
  //    polled ONLY when no tg-bridge owns the bot: while the bridge is alive
  //    it is the sole getUpdates consumer (409 otherwise); the session just
  //    reads its files. The bridge lock is TELEGRAM-specific (one getUpdates
  //    consumer per bot token) — a non-telegram adapter (the persisted
  //    fake-RW mock, consumer transports) has no getUpdates consumer and is
  //    polled REGARDLESS of the lock, so a live tg bridge never suppresses a
  //    configured RW channel's inbound delivery.
  const bridgeLeaseStatus: BridgeLeaseReadStatus = adapter?.kind === "telegram"
    ? readBridgeLease(root, pollPin ?? undefined, opts.proofAuthority).status
    : "absent";
  const bridgeOwnsPoll = adapter?.kind === "telegram" && bridgeLeaseStatus === "live";
  // Telegram resident polling is permitted only after a canonical absence or
  // a validated dead/expired lease. Invalid, foreign, unreadable, unstable,
  // or changing bridge.lock bytes remain a split-brain fence.
  const bridgePollPermitted = adapter?.kind !== "telegram" || bridgeLeaseStatus === "absent";
  if (adapter && bridgePollPermitted && !bridgeOwnsPoll && isPollOnceCapable(adapter)) {
    const adapterPin = pollPin;
    if (!adapterPin) return;
    try {
      if (opts.isOwned && !opts.isOwned()) return;
      const polled = await boundedAdapterCall(
        () => {
          opts.lifecycle?.assertLive?.();
          assertAdapterRegistrationLive(adapter);
          return adapter.pollOnce(adapterPin, opts.lifecycle);
        },
        opts.lifecycle,
        opts.lifecycle?.trackUnderlyingOperation,
      );
      assertAdapterRegistrationLive(adapter);
      const answers = detachPolledAnswerBatch(polled);
      if (!answers) throw new Error("polled answer batch contains an accessor, sparse entry, proxy trap, or unsupported value");
      let batchBytes = 0;
      try { batchBytes = Buffer.byteLength(JSON.stringify(answers), "utf8"); }
      catch { throw new Error("polled answer batch is not serializable"); }
      if (answers.length > MAX_POLLED_ANSWER_BATCH_ENTRIES || batchBytes > MAX_POLLED_ANSWER_BATCH_BYTES) {
        throw new Error("polled answer batch exceeds its bounded entry or byte limit");
      }
      const seen = seenAnswersFor(root, pollPin);
      for (const rawAnswer of answers) {
        assertPollLive();
        if (opts.isOwned && !opts.isOwned()) break;
        const answer = normalizePolledAnswer(rawAnswer);
        const answerKey = answer ? `${answer.run_id}\u0000${answer.id}` : null;
        if (!answer || (answerKey !== null && seen.has(answerKey))) continue;
        assertAdapterRegistrationLive(adapter);
        const wakeOutcome = await deliverAnswerWake(root, answer, onAnswer, { ...opts, pinnedRoot: adapterPin });
        assertAdapterRegistrationLive(adapter);
        if (wakeOutcome !== "retryable" && answerKey !== null) {
          seen.add(answerKey);
          while (seen.size > MAX_SEEN_ANSWERS_PER_ROOT) {
            const oldest = seen.values().next().value as string | undefined;
            if (oldest === undefined) break;
            seen.delete(oldest);
          }
        }
      }
    } catch (error) {
      if (isDispatcherActivationFailure(error)) throw error;
      // network hiccup / 409 with a bridge — next tick retries
    }
  }
  } finally {
    if (ownsPollPin) pollPin.close();
  }
}

/**
 * Narrow the OPTIONAL pollOnce surface (http is send-only). Shared by the
 * telegram adapter AND RW/consumer adapters (the persisted fake-RW mock,
 * consumer transports) — NOT telegram-specific: any adapter exposing
 * pollOnce() can deliver inbound while the session itself stays passive.
 */
function isPollOnceCapable(
  adapter: unknown,
): adapter is { pollOnce: (pinnedRoot?: PinnedProjectRoot, lifecycle?: AdapterOperationContext) => Promise<unknown[]> } {
  if (typeof adapter !== "object" || adapter === null) return false;
  if (!("pollOnce" in adapter)) return false;
  return typeof adapter.pollOnce === "function";
}

function isArchiveDirectory(queue: import("@andvl1/omp-workflows-core/queue").BoundedQueue, name: string): boolean {
  try { queue.read(name); return false; } catch (error) {
    return error instanceof BoundedQueueError && error.code === "not_regular";
  }
}

function quarantineQueueEntry(queue: BoundedQueue, name: string, expected: BoundedQueueEntryExpectation | undefined, rejectedDirectory: string, fence?: MutationFence): void {
  // A quarantine is destructive. Without the exact classified source image,
  // leave it durable for a later bounded pass.
  if (!expected) return;
  try {
    assertMutationLive(fence);
    queue.discard(name, expected, rejectedDirectory);
    assertMutationLive(fence);
  } catch (error) {
    rethrowActivationFailure(error);
    // A failed quarantine keeps the source in place and fails closed. The
    // caller's rejection result blocks ACK and a later tick may retry.
  }
}

function discardQueueEntry(queue: import("@andvl1/omp-workflows-core/queue").BoundedQueue, name: string, expected: BoundedQueueEntryExpectation | undefined, rejectedDirectory: string, fence?: MutationFence): void {
  if (!expected) return;
  try {
    assertMutationLive(fence);
    queue.discard(name, expected, rejectedDirectory);
    assertMutationLive(fence);
  } catch (error) {
    rethrowActivationFailure(error);
    /* retry on the next bounded tick */
  }
}

function moveQueueEntry(queue: import("@andvl1/omp-workflows-core/queue").BoundedQueue, name: string, destinationDirectory: "processed", expected: BoundedQueueEntryExpectation | undefined): void {
  const destination = join(queue.relativeDirectory, destinationDirectory, name);
  try {
    queue.ensureDirectory(join(queue.relativeDirectory, destinationDirectory));
    if (!expected || expected.kind !== "file") return;
    queue.moveToIfMatches(name, expected, destination);
  } catch {
    // The source stays durable when a destination race or path error occurs.
  }
}

/**
 * Esc-ids already woken for, scoped per root/cwd. pollOnce advances the TG
 * offset so a single dispatcher never sees the same update twice; this set
 * guards against double-wake if a dispatcher's tick overlaps itself.
 * Multiple dispatchers in multiple live sessions (same or different roots)
 * may both wake on the same answer — acceptable: the session that owns the
 * waiting team applies it, others treat it as advisory (the CTO contract
 * says late answers are advisory). Keyed by root so one project's wakes
 * never suppress another project's wakes for the same esc id.
 */
export const MAX_POLLED_ANSWER_BATCH_ENTRIES = 256;
export const MAX_POLLED_ANSWER_BATCH_BYTES = 2 * 1024 * 1024;
export const MAX_SEEN_ANSWERS_PER_ROOT = 1_024;
export const MAX_SEEN_ANSWER_ROOTS = 64;
const seenAnswersByRoot = new Map<string, Set<string>>();

function seenAnswersFor(root: string, pinnedRoot: PinnedProjectRoot): Set<string> {
  if (!pinnedRoot.isStable()) return new Set<string>();
  // Answer suppression is scoped to descriptor identity, not lexical path.
  const identity = pinnedRoot.canonical_root + "\\u0000" + pinnedRoot.dev + "\\u0000" + pinnedRoot.ino;
  let seen = seenAnswersByRoot.get(identity);
  if (!seen) {
    const prefix = pinnedRoot.canonical_root + "\\u0000";
    for (const key of seenAnswersByRoot.keys()) {
      if (key !== identity && key.startsWith(prefix)) seenAnswersByRoot.delete(key);
    }
    seen = new Set<string>();
    seenAnswersByRoot.set(identity, seen);
    while (seenAnswersByRoot.size > MAX_SEEN_ANSWER_ROOTS) {
      const oldest = seenAnswersByRoot.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      seenAnswersByRoot.delete(oldest);
    }
  } else {
    // Map insertion order is the bounded root LRU order.
    seenAnswersByRoot.delete(identity);
    seenAnswersByRoot.set(identity, seen);
  }
  return seen;
}
