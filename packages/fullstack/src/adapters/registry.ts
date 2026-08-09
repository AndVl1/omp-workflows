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
 *     "telegram": { "token": "...", "chatId": "...", "pollIntervalMs": 5000 }
 *   }
 *
 * ── Resident control-plane: profile-aware channel sets (schema-2 additive) ──
 *
 * `createChannelSet(cwd)` resolves the config through the core channel
 * normalizer (capability-validated directions) and builds one adapter per
 * profile: the first RW profile becomes the PRIMARY (inbound + outbound),
 * every RO profile becomes an outbound REPORT SINK. The primary is the only
 * adapter that may be wired for inbound (`setPlainMessageHandler`) or polled
 * (`pollOnce`); RO sinks are never touched for inbound (architecture
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
 * `isBidirectionalChannel(cwd)` is now capability-validated via core
 * `hasRwPrimary`: a legacy `{adapter:"http", bidirectional:true}` flag alone
 * does NOT make http bidirectional — http has no inbound capability
 * (core's built-in capability table: http = push-only). NOTE: core's legacy
 * normalization branch honors the `bidirectional` flag for any adapter kind
 * (compatibility wrapper), so legacy `http + bidirectional:true` still
 * normalizes to rw; the capability rule (declared rw on an incapable kind
 * downgrades to ro) is enforced for explicit `channels[]` entries.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendWave,
  ctoStateDir,
  defaultBudgetState,
  findWaveBySourceId,
  hasRwPrimary,
  loadEscalationConfigRaw,
  normalizeChannelConfig,
  readCtoState,
  resolveChannelProfile,
  sanitizeEscalation,
  validateEscalation,
  writeCtoState,
  type ChannelCapabilities,
  type ChannelProfile,
  type Escalation,
  type EscalationAdapter,
  type EscalationReceipt,
  type QuarantineRecord,
} from "@andvl1/omp-workflows-core";
import { findActiveCtoRun } from "@andvl1/omp-workflows-core";
import { HttpEscalationAdapter } from "./http.js";
import { TelegramEscalationAdapter } from "./telegram.js";
import { MockEscalationAdapter, registerMockAdapter } from "./mock.js";

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
    allowedChatIds?: string[];
    /** When non-empty, inbound senders must be in this list. */
    allowedSenderIds?: string[];
  };
  /** Transport-specific config for consumer-registered adapters. */
  [transport: string]: unknown;
}

/** Run id is the first segment of the escalation correlation id. */
export function runIdOf(esc: Escalation): string {
  return esc.id.split("/")[0] ?? esc.id;
}

export function outboxDir(runId: string, root: string): string {
  return join(ctoStateDir(runId, root), "outbox");
}

// ── Delivery envelope (schema-2 additive) ──────────────────────────────────

/**
 * Delivery intent stamped on durable outbox entries. Additive fields on the
 * Escalation shape — core validateEscalation tolerates extras, and
 * sanitizeEscalation/redactEscalation preserve them, so the whole
 * retry/redaction/sent-file path passes them through untouched.
 */
export type DeliveryIntent = "ack" | "question" | "progress" | "summary";

/** A durable outbox delivery: escalation-shaped + additive envelope fields. */
export type CtoDelivery = Escalation & {
  intent: DeliveryIntent;
  /** ackTarget override — the channel/user the message is addressed to. */
  target?: string;
  /** Report topic — RO sink subscription routing (`summary` intents). */
  topic?: string;
};

/**
 * Queue a CTO delivery durably: writes `<outboxDir(runId, root)>/<id>.json`
 * (mkdir -p, `wx` — first write wins). Idempotent on the delivery id: a
 * duplicate returns null without overwriting. Returns the file path or null
 * on duplicate / write failure (best-effort — the caller must never treat
 * this as a blocking path). The regular `drainOutbox` tick picks the entry
 * up with the existing retry/redaction/sent-file semantics.
 */
export function queueCtoDelivery(root: string, runId: string, delivery: CtoDelivery): string | null {
  const dir = outboxDir(runId, root);
  const fileName = `${delivery.id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
  const path = join(dir, fileName);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(delivery, null, 2), { flag: "wx" });
    return path;
  } catch {
    return null;
  }
}

/** Adapter factory for a transport kind (built-in or consumer-registered). */
export type EscalationAdapterFactory = (config: EscalationConfig, cwd: string) => EscalationAdapter | null;

const adapterFactories = new Map<string, EscalationAdapterFactory>([
  ["http", (config) => (config.http?.url ? new HttpEscalationAdapter({ url: config.http.url, headers: config.http.headers }) : null)],
  [
    "telegram",
    (config, cwd) =>
      config.telegram?.token && config.telegram.chatId
        ? new TelegramEscalationAdapter({
            token: config.telegram.token,
            chatId: config.telegram.chatId,
            cwd,
            pollIntervalMs: config.telegram.pollIntervalMs ?? 5_000,
            allowedChatIds: config.telegram.allowedChatIds,
            allowedSenderIds: config.telegram.allowedSenderIds,
          })
        : null,
  ],
]);

// Register the in-process mock transport (br-zps.6 / D4): no config, no
// network — `.omp/escalation.json` `{"adapter":"mock"}` selects it for tests
// and the epic's E2E. registerMockAdapter lives in mock.ts and calls back
// into registerEscalationAdapter — the registry→mock→registry import cycle is
// safe because both sides only invoke each other's functions after module
// evaluation completes (function declarations are hoisted). MockEscalationAdapter
// is imported alongside so the fallback — registering
// `["mock", () => new MockEscalationAdapter()]` inline in the map above — is
// one edit away if the cycle ever misbehaves.
registerMockAdapter();

/**
 * Register a consumer transport adapter (e.g. slack, whatsapp, signal) so the
 * in-session dispatcher and the standalone bridge can create it from
 * `.omp/escalation.json` like any built-in. Implement the optional inbound
 * surface (pollOnce / setPlainMessageHandler / sendPlainText) for the same
 * bidirectional behavior as telegram.
 */
export function registerEscalationAdapter(kind: string, factory: EscalationAdapterFactory): void {
  adapterFactories.set(kind, factory);
}

/** Read `.omp/escalation.json`; missing/malformed -> null. */
export function loadEscalationConfig(cwd: string): EscalationConfig | null {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ".omp", "escalation.json"), "utf8")) as EscalationConfig;
    if (typeof raw.adapter !== "string" || raw.adapter.length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Build the configured adapter; null when the config is unusable. */
export function createEscalationAdapter(config: EscalationConfig, cwd: string): EscalationAdapter | null {
  const factory = adapterFactories.get(config.adapter);
  if (!factory) return null;
  try {
    return factory(config, cwd);
  } catch {
    return null;
  }
}

// ── Profile-aware channel sets (resident control-plane) ────────────────────

/**
 * A resolved channel set for one cwd: the normalized profiles, THE resolved
 * profile (first RW preferred, else first RO, else {direction:"none"}),
 * the primary adapter (first RW profile — core guarantees direction "rw"
 * only when the adapter kind has inbound AND outbound capabilities), and
 * one adapter per RO profile as an outbound report sink. RO sinks are
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

/** Adapter side of the subscription marker (set by createChannelSet only). */
interface RoSinkMarker {
  [RO_SINK_SUBSCRIPTIONS]?: string[];
}

function sinkSubscriptionsOf(sink: EscalationAdapter): string[] | undefined {
  // Trusted marker: attached by createChannelSet; absent on foreign adapters.
  const marked = sink as RoSinkMarker;
  return marked[RO_SINK_SUBSCRIPTIONS];
}

/**
 * Resolve `.omp/escalation.json` into a channel set (see {@link ChannelSet}).
 * Factory routing: for explicit `channels[]` configs each profile's adapter
 * is built from the per-entry config object; for legacy single-adapter
 * configs the whole config is passed (EscalationConfig has an index
 * signature, so per-transport sub-objects ride along). Adapter construction
 * failures degrade to null (never throw). No profiles ->
 * `{ profiles: [], profile: {direction:"none"}, primary: null, roSinks: [] }`.
 */
export function createChannelSet(cwd: string, capabilities?: Record<string, ChannelCapabilities>): ChannelSet {
  const raw = loadEscalationConfigRaw(cwd);
  const profiles = normalizeChannelConfig(raw, capabilities);
  if (profiles.length === 0) {
    return { profiles: [], profile: { direction: "none" }, primary: null, roSinks: [], legacySingleAdapter: false };
  }
  // Explicit channels[] entries (validated as an array by Array.isArray);
  // absent -> a legacy single-adapter config (adapter profile guaranteed by
  // profiles.length > 0).
  const channels = Array.isArray(raw?.channels) ? (raw?.channels as Array<Record<string, unknown>>) : null;
  const legacySingleAdapter = channels === null;
  const entryFor = (profile: ChannelProfile): Record<string, unknown> | null => {
    const kind = profile.adapter ?? profile.transport;
    if (!channels || !kind) return raw;
    // Profile-aware binding (static-2): an explicit entry with an id binds
    // by THAT id — two same-kind channels with distinct ids get distinct
    // per-entry configs. An id-less profile (a single id-less entry per
    // kind survives the normalizer's ambiguity rejection) binds to the
    // id-less entry of its kind, never to a same-kind id-ful entry.
    if (typeof profile.id === "string" && profile.id.length > 0) {
      return channels.find((c) => c.id === profile.id) ?? null;
    }
    return channels.find((c) => c.adapter === kind && !(typeof c.id === "string" && c.id.trim().length > 0)) ?? null;
  };
  const build = (profile: ChannelProfile): EscalationAdapter | null => {
    const kind = profile.adapter ?? profile.transport;
    if (!kind) return null;
    const factory = adapterFactories.get(kind);
    if (!factory) return null;
    const entry = entryFor(profile);
    if (!entry) return null;
    try {
      return factory(entry as EscalationConfig, cwd);
    } catch {
      return null;
    }
  };
  const primaryProfile = profiles.find((p) => p.direction === "rw");
  const primary = primaryProfile ? build(primaryProfile) : null;
  const roSinks = profiles
    .filter((p) => p.direction === "ro")
    .map((p) => {
      const sink = build(p);
      if (sink) Object.defineProperty(sink, RO_SINK_SUBSCRIPTIONS, { value: p.subscriptions, enumerable: false, configurable: true });
      return sink;
    })
    .filter((a): a is EscalationAdapter => a !== null);
  return { profiles, profile: resolveChannelProfile(cwd, capabilities), primary, roSinks, legacySingleAdapter };
}

/**
 * True when the resolved channel is a validated RW primary. Reimplemented as
 * core `hasRwPrimary` (capability-validated): legacy telegram and any legacy
 * `bidirectional: true` flag normalize to rw through core's compatibility
 * branch; legacy http WITHOUT the flag is push-only (ro -> false); explicit
 * `channels[]` entries are capability-checked (declared rw on an incapable
 * kind like http downgrades to ro -> false). See the module docblock.
 */
export function isBidirectionalChannel(cwd: string, capabilities?: Record<string, ChannelCapabilities>): boolean {
  return hasRwPrimary(cwd, capabilities);
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
  escId: string;
  sent: boolean;
  error?: string;
  /** Best-effort RO sink send failures (summary routing); primary still sent. */
  sinkErrors?: string[];
}

export async function drainOutbox(
  root: string,
  adapter: EscalationAdapter | null,
  maxRetries = 3,
  opts: { roSinks?: EscalationAdapter[] } = {},
): Promise<DrainOutboxResult[]> {
  const roSinks = opts.roSinks ?? [];
  if (!adapter && roSinks.length === 0) return [];
  const results: DrainOutboxResult[] = [];
  const runsDir = join(root, ".work-state", "cto");
  if (!existsSync(runsDir)) return results;
  const runs = readdirSync(runsDir);
  for (const runId of runs) {
    const outbox = outboxDir(runId, root);
    if (!existsSync(outbox)) continue;
    for (const name of readdirSync(outbox)) {
      if (!name.endsWith(".json")) continue;
      const escId = name.slice(0, -".json".length);
      const path = join(outbox, name);
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Escalation & { intent?: DeliveryIntent; topic?: string };
        const validation = validateEscalation(raw);
        if (validation) {
          results.push({ escId, sent: false, error: validation });
          continue;
        }
        // sanitizeEscalation preserves additive fields (intent/target/topic).
        const clean = sanitizeEscalation(raw);
        if (!adapter) {
          // RO-only set: only subscribed report entries are deliverable.
          if (raw.intent === "summary") {
            const sinkErrors: string[] = [];
            const outcome = await routeReportsToSinks({ ...clean, intent: "summary", topic: raw.topic }, roSinks, sinkErrors);
            if (outcome.attempted === 0) {
              // Every sink subscription-skipped this topic — honest no-op:
              // nothing was attempted, archive as sent with no sinkErrors.
              const sentDir = join(outbox, "sent");
              mkdirSync(sentDir, { recursive: true });
              renameSync(path, join(sentDir, name));
              results.push({ escId, sent: true });
            } else if (outcome.failed > 0 && outcome.failed === outcome.attempted) {
              // Every sink that was ACTUALLY attempted failed — the summary
              // was not delivered anywhere. Leave the file in outbox/ (NOT
              // archived) so the next drain retries it — pending/retryable.
              const result: DrainOutboxResult = { escId, sent: false, error: "all ro sinks failed", sinkErrors };
              results.push(result);
            } else {
              // At least one sink succeeded — archive the summary; partial
              // sink failures are recorded (today's behavior).
              const sentDir = join(outbox, "sent");
              mkdirSync(sentDir, { recursive: true });
              renameSync(path, join(sentDir, name));
              const result: DrainOutboxResult = { escId, sent: true };
              if (sinkErrors.length > 0) result.sinkErrors = sinkErrors;
              results.push(result);
            }
          } else {
            // No validated RW primary -> questions/progress/legacy entries
            // stay durable for a later primary (restart-safe).
            results.push({ escId, sent: false, error: "no rw primary to deliver non-report entry" });
          }
          continue;
        }
        const receipt = await sendWithRetry(adapter, clean, maxRetries);
        if (receipt.sent) {
          const sinkErrors: string[] = [];
          if (raw.intent === "summary" && roSinks.length > 0) {
            // Rebuild the envelope on the sanitized entry (sinks receive the
            // same redacted content as the primary); topic stays optional.
            // The drain adapter itself is skipped as a routing target — a
            // legacy single-RO-adapter config drains via its only sink and
            // must not double-send its own summaries.
            const routingSinks = roSinks.filter((s) => s !== adapter);
            if (routingSinks.length > 0) {
              await routeReportsToSinks({ ...clean, intent: "summary", topic: raw.topic }, routingSinks, sinkErrors);
            }
          }
          const sentDir = join(outbox, "sent");
          mkdirSync(sentDir, { recursive: true });
          renameSync(path, join(sentDir, name));
          const result: DrainOutboxResult = { escId, sent: true };
          if (sinkErrors.length > 0) result.sinkErrors = sinkErrors;
          results.push(result);
        } else {
          results.push({ escId, sent: false, error: `send failed after ${maxRetries} attempts` });
        }
      } catch (error) {
        results.push({ escId, sent: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return results;
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
): Promise<{ attempted: number; failed: number }> {
  let attempted = 0;
  let failed = 0;
  for (const sink of roSinks) {
    const subscriptions = sinkSubscriptionsOf(sink);
    if (subscriptions && (!esc.topic || !subscriptions.includes(esc.topic))) continue;
    attempted += 1;
    try {
      const receipt = await sink.send(esc);
      if (receipt.sent !== true) {
        failed += 1;
        sinkErrors.push(`sink ${sink.kind} reported unsent`);
      }
    } catch (error) {
      failed += 1;
      sinkErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { attempted, failed };
}

async function sendWithRetry(adapter: EscalationAdapter, esc: Escalation, maxRetries: number): Promise<EscalationReceipt> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const receipt = await adapter.send(esc);
      if (receipt.sent) return receipt;
    } catch {
      // network / adapter error — retry
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1))); // 500ms, 1s, 2s
    }
  }
  return { sent: false };
}

const DISPATCHER_LEASE_TTL_MS = 30_000;
const DISPATCHER_HEARTBEAT_MS = 5_000;

interface DispatcherLeaseRecord {
  pid: number;
  token: string;
  startedAt: string;
  heartbeatAt: string;
}

interface DispatcherLease {
  path: string;
  token: string;
}

/** Cross-process ownership file: one messenger dispatcher per project cwd. */
export function dispatcherLockPath(root: string): string {
  return join(root, ".omp", "cto-dispatcher.lock");
}

function readDispatcherLease(path: string): DispatcherLeaseRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DispatcherLeaseRecord>;
    if (
      typeof raw.pid === "number" &&
      typeof raw.token === "string" &&
      typeof raw.startedAt === "string" &&
      typeof raw.heartbeatAt === "string"
    ) {
      return raw as DispatcherLeaseRecord;
    }
  } catch {
    // A partially written or missing lease is handled by the claimant.
  }
  return null;
}

function isDispatcherLeaseAlive(lease: DispatcherLeaseRecord): boolean {
  const heartbeatAt = Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > DISPATCHER_LEASE_TTL_MS) return false;
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function claimDispatcher(root: string): DispatcherLease | null {
  const path = dispatcherLockPath(root);
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const now = new Date().toISOString();
  const record = JSON.stringify({ pid: process.pid, token, startedAt: now, heartbeatAt: now }, null, 2);
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(path, record, { flag: "wx" });
    return { path, token };
  } catch (error) {
    if (!isAlreadyExists(error)) return null;
    const existing = readDispatcherLease(path);
    if (existing && isDispatcherLeaseAlive(existing)) return null;
    try {
      if (!existing) {
        const mtimeMs = statSync(path).mtimeMs;
        if (Date.now() - mtimeMs <= DISPATCHER_LEASE_TTL_MS) return null;
      }
      rmSync(path, { force: true });
      writeFileSync(path, record, { flag: "wx" });
      return { path, token };
    } catch {
      return null;
    }
  }
}

function ownsDispatcherLease(lease: DispatcherLease): boolean {
  return readDispatcherLease(lease.path)?.token === lease.token;
}

function refreshDispatcherLease(lease: DispatcherLease): void {
  const current = readDispatcherLease(lease.path);
  if (!current || current.token !== lease.token) return;
  try {
    writeFileSync(lease.path, JSON.stringify({ ...current, heartbeatAt: new Date().toISOString() }, null, 2));
  } catch {
    // The next tick will stop when ownership can no longer be confirmed.
  }
}

function releaseDispatcherLease(lease: DispatcherLease): void {
  if (!ownsDispatcherLease(lease)) return;
  try {
    rmSync(lease.path, { force: true });
  } catch {
    // Best-effort release; the heartbeat TTL handles crashed owners.
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
interface DispatcherTarget {
  primary: EscalationAdapter | null;
  roSinks: EscalationAdapter[];
  /** Legacy single-adapter configs drain via their single RO adapter. */
  legacySingleAdapter?: boolean;
  intervalMs: number;
  opts: DispatcherOptions;
}

function startDispatcherLoop(root: string, target: DispatcherTarget): () => void {
  const { primary, roSinks, intervalMs, opts } = target;
  const drainAdapter = primary ?? (target.legacySingleAdapter ? (roSinks[0] ?? null) : null);
  const lease = claimDispatcher(root);
  if (!lease) return () => undefined;
  const heartbeat = setInterval(() => refreshDispatcherLease(lease), DISPATCHER_HEARTBEAT_MS);
  const { onTask, onAnswer } = opts;
  const wakeTask = (task: InboxTask): void => {
    if (!ownsDispatcherLease(lease)) throw new Error("messenger dispatcher lease lost before task wake");
    onTask?.(task);
  };
  const wakeAnswer = (answer: { id: string; answer: string }): void => {
    if (ownsDispatcherLease(lease)) onAnswer?.(answer);
  };
  const inboxHandler = (task: InboxTask) => handleInboxTask(root, task, wakeTask);
  // Inbound surface lives on the primary ONLY (telegram/mock implement it;
  // http is send-only). Cast at the boundary once, guarded at runtime.
  const inboundCapable = primary as { setPlainMessageHandler: (h: (t: InboxTask) => void) => void } | null;
  if (inboundCapable && typeof inboundCapable.setPlainMessageHandler === "function") {
    inboundCapable.setPlainMessageHandler(inboxHandler);
  }
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking || !ownsDispatcherLease(lease)) return;
    ticking = true;
    try {
      await drainOutbox(root, drainAdapter, 3, { roSinks });
      await pollInbox(root, primary, wakeTask, wakeAnswer);
    } catch {
      // drain/poll never throw in practice; keep the loop alive regardless.
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  // Drain once immediately on start (survives restarts — R7).
  void tick();
  return () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    releaseDispatcherLease(lease);
  };
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
  opts: DispatcherOptions = {},
): () => void {
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
  opts: DispatcherOptions & { roSinks?: EscalationAdapter[] } = {},
): () => void {
  return startDispatcherLoop(root, {
    primary: channelSet.primary,
    roSinks: opts.roSinks ?? channelSet.roSinks,
    legacySingleAdapter: channelSet.legacySingleAdapter,
    intervalMs,
    opts,
  });
}

// ── CTO task inbox ─────────────────────────────────────────────────────────

/** A task arriving from the messenger or the local drop. */
export interface InboxTask {
  id: string;
  text: string;
  at: string;
  by?: string;
  /** Resolved run id the task was filed under. */
  runId?: string;
  /** Resident wave id admitted for this task (set when run state is readable). */
  waveId?: string;
}

export interface DispatcherOptions {
  /** Called once per new inbox task (after the inbox file is written). */
  onTask?: (task: InboxTask) => void;
  /**
   * Called once per newly received escalation answer (user-initiated reply
   * or button in the messenger channel). The answer file is already written
   * by the adapter; the wake tells the agent to apply it at the next
   * checkpoint (or immediately if it is waiting).
   */
  onAnswer?: (answer: { id: string; answer: string }) => void;
}

/** `.work-state/cto/<runId>/inbox/` — tasks the CTO reads at checkpoints. */
export function inboxDir(runId: string, root: string): string {
  return join(ctoStateDir(runId, root), "inbox");
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

/** True when a live tg-bridge owns the bot for this project. */
export function isBridgeAlive(root: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(bridgeLockPath(root), "utf8")) as { pid?: number };
    if (typeof raw?.pid !== "number") return false;
    process.kill(raw.pid, 0); // throws ESRCH when the process is gone
    return true;
  } catch {
    return false;
  }
}

/** Write the bridge lock (called by the tg-bridge daemon on start). */
export function writeBridgeLock(root: string): void {
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(bridgeLockPath(root), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  } catch {
    // best-effort
  }
}

/** Remove the bridge lock (called by the daemon on shutdown). */
export function clearBridgeLock(root: string): void {
  try {
    const path = bridgeLockPath(root);
    if (existsSync(path)) renameSync(path, `${path}.stopped`);
  } catch {
    // best-effort
  }
}

/**
 * Resolve the run an inbox task belongs to: the active CTO run when there is
 * one, otherwise create a standby run (id `standby-<ts>`) so the task has a
 * home and the run becomes active.
 */
export function resolveInboxRunId(root: string): string {
  const active = findActiveCtoRun(root);
  if (active) return active.runId;
  return ensureStandbyRun(root);
}

/**
 * Create a minimal standby run state.json; returns its run id. Reuses an
 * existing active run (e.g. a standby created by an earlier telegram task)
 * instead of always minting a new `standby-<ts>` — otherwise /cto could
 * start a second run with a fresh inbox and miss the tasks already filed
 * (findActiveCtoRun treats the standby state — pause: none — as active).
 */
export function ensureStandbyRun(root: string): string {
  const active = findActiveCtoRun(root);
  if (active) return active.runId;
  const runId = `standby-${Date.now()}`;
  const runDir = ctoStateDir(runId, root);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, "inbox"), { recursive: true });
  const now = new Date().toISOString();
  const state = {
    schema: 2,
    id: runId,
    task: "standby — awaiting inbox tasks",
    branch: "",
    autonomous: true,
    // Explicit standby marker (RC4): adoptable cross-session so queued
    // inbox tasks are never lost when a new session starts. Ownership is
    // enforced only for interactive task runs, never for standby runs.
    standby: true,
    plan: { id: runId, task: "standby — awaiting inbox tasks", teams: [], created_at: now },
    teams: [],
    integration: { status: "pending" },
    pause: { kind: "none", reason: "standby" },
    updated_at: now,
    // Canonical schema-2 fields (br-zps.1): this writer emits state.json
    // directly, so it must not create a partial canonical state — missing
    // fields would be default-filled only on read, leaving the file itself
    // non-canonical until a later canonicalizeState write.
    budget: defaultBudgetState(),
    leases: {},
    decisions: [],
    inbox_quarantine: {},
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  return runId;
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

/**
 * Persist a quarantine record for a task (br-zps.4). Best-effort, NEVER
 * throws: a rejection (or an unreadable run state) must not take down the
 * messenger path. `state.inbox_quarantine` is default-filled when absent
 * (standby states written without the canonical schema-2 fields migrate to
 * schema 2 on read).
 */
function recordQuarantine(
  root: string,
  runId: string,
  task: InboxTask,
  hash: string,
  status: QuarantineRecord["status"],
  reason?: string,
): void {
  try {
    const state = readCtoState(runId, root);
    if (!state) return;
    state.inbox_quarantine = state.inbox_quarantine ?? {};
    state.inbox_quarantine[hash] = {
      id: task.id,
      hash,
      received_at: task.at ?? new Date().toISOString(),
      by: task.by ?? "inbox",
      status,
      ...(reason ? { reason } : {}),
    };
    writeCtoState(state, root);
  } catch {
    // best-effort — the rejection itself must never throw
  }
}

/**
 * Write an inbox task file and wake the CTO session.
 *
 * Quarantine (br-zps.4): external inbox text is untrusted DATA, not a
 * policy override. Before the file write the task is shape-validated and
 * SHA-256 hashed (normalized by trim):
 *   - empty/oversized bodies are REJECTED — recorded in the run's
 *     `state.inbox_quarantine` and dropped (nothing filed, no wake);
 *   - an already-ADMITTED hash is a duplicate — dropped (no file, no wake);
 *   - otherwise the record is persisted as `quarantined` BEFORE the write
 *     and flipped to `admitted` AFTER it. A wake failure reverts the record
 *     to `quarantined` (before removing the file) so the transport's retry
 *     passes the admitted-dedup and re-wakes.
 * When the run state is unreadable the task is filed WITHOUT quarantine
 * bookkeeping — availability over strictness; corrupt state is a separate
 * incident.
 *
 * The file write is idempotent (`wx`: the first write wins; duplicates are
 * at-most-once — the winner wakes, later calls return null without waking)
 * and is separated from the wake callback. The callback runs only after the
 * file is durable, and its exceptions are NOT hidden: the just-created file
 * is removed and the error propagates to the transport, which keeps the
 * update (the local drop file stays in place) and retries on the next tick —
 * the retry writes the file fresh, so no wx collision blocks the re-wake.
 *
 * Returns the path when this call wrote the file and woke; null when the
 * task was rejected, deduped, or already filed (duplicate — no re-wake);
 * throws when the task could not be filed (IO error) or when the wake
 * callback threw (the file is removed so the transport can retry the update).
 */
export function handleInboxTask(root: string, task: InboxTask, onTask?: (t: InboxTask) => void): string | null {
  const runId = task.runId ?? resolveInboxRunId(root);

  // ── Quarantine pass (br-zps.4) ───────────────────────────────────────────
  const rawText = typeof task.text === "string" ? task.text : "";
  const normalized = rawText.trim();
  const hash = sha256Hex(rawText);
  if (normalized.length === 0 || normalized.length > MAX_INBOX_TEXT_LENGTH) {
    const reason = normalized.length === 0 ? "empty text" : "text exceeds MAX_INBOX_TEXT_LENGTH";
    recordQuarantine(root, runId, task, hash, "rejected", reason);
    return null; // nothing filed, no wake — validation failures never throw
  }
  // Dedup: an already-admitted hash is a duplicate task (same normalized
  // text) — no file, no wake. A "quarantined" record means a previous
  // attempt died mid-flight (wake failed, write rolled back) → proceed.
  const state = readCtoState(runId, root);
  if (state && state.inbox_quarantine?.[hash]?.status === "admitted") {
    return null;
  }
  // Track the in-flight task BEFORE the write; flipped to "admitted" after
  // the file write succeeds. State unreadable → file as today, no tracking.
  let quarantineTracked = false;
  if (state) {
    try {
      state.inbox_quarantine = state.inbox_quarantine ?? {};
      state.inbox_quarantine[hash] = {
        id: task.id,
        hash,
        received_at: task.at ?? new Date().toISOString(),
        by: task.by ?? "inbox",
        status: "quarantined",
      };
      writeCtoState(state, root);
      quarantineTracked = true;
    } catch {
      // Persisting the record failed — file the task anyway (availability).
      quarantineTracked = false;
    }
  }

  const dir = inboxDir(runId, root);
  const fileName = `${task.id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
  const path = join(dir, fileName);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ ...task, runId }, null, 2), { flag: "wx" });
  } catch (error) {
    // wx collision (another dispatcher already filed this task — at-most-once:
    // the winner woke, we must NOT re-wake) or IO error (nothing durable).
    if (!existsSync(path)) {
      throw new Error(`inbox task ${task.id} not filed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null; // duplicate — first write wins, no re-wake
  }
  if (quarantineTracked && state) {
    try {
      const record = state.inbox_quarantine?.[hash];
      if (record) {
        record.status = "admitted";
        writeCtoState(state, root);
      }
    } catch {
      // Best-effort: the task file is already durable; a record stuck on
      // "quarantined" just means a retry re-files instead of deduping —
      // safe either way.
    }
  }
  // ── Wave admission (resident control-plane) ─────────────────────────────
  // After the file is durable and the quarantine record is admitted, admit
  // the transport task as a wave in the run's canonical state. Best-effort,
  // NEVER throws: an unreadable run state (or a state write failure) must
  // not block the wake. appendWave is idempotent on source_id, so a wake
  // rollback + transport retry re-admits the SAME wave (findWaveBySourceId
  // returns the existing record) — a duplicate inbound message id never
  // starts a second wave.
  let waveId: string | undefined;
  try {
    const waveState = readCtoState(runId, root);
    if (waveState) {
      appendWave(
        waveState,
        {
          id: `wave-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          source: task.by ?? "inbox",
          source_id: task.id,
          task: task.text,
          slice_ids: [],
        },
        root,
      );
      waveId = findWaveBySourceId(waveState, task.id)?.id;
    }
  } catch {
    // best-effort — the wake below is the primary path
  }
  try {
    // Wake AFTER the file is durable and OUTSIDE the write guard: a throwing
    // callback must reach the transport so it can retry the update instead of
    // being hidden as a null result.
    onTask?.({ ...task, runId, waveId });
  } catch (error) {
    // Roll back the just-created file so the retry is a fresh write (no wx
    // collision) — otherwise the transport's retry would see a duplicate and
    // skip the wake, losing the update. ALSO revert the quarantine record to
    // "quarantined" (best-effort) so the retry is not swallowed by the
    // admitted-dedup. Order: revert record → rm file → rethrow.
    if (quarantineTracked) {
      try {
        const current = readCtoState(runId, root) ?? state;
        const record = current?.inbox_quarantine?.[hash];
        if (current && record) {
          record.status = "quarantined";
          writeCtoState(current, root);
        }
      } catch {
        // best-effort — the wake failure is the primary error to propagate
      }
    }
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort removal; worst case the next poll collides and skips
    }
    throw error;
  }
  return path;
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
  onTask?: (t: InboxTask) => void,
  onAnswer?: (a: { id: string; answer: string }) => void,
): Promise<void> {
  // 1. Local drop (bridge-written tasks + answer markers, or manual/test
  //    injection). The bridge files answers as { kind: "answer" } markers so
  //    the session wakes [CTO-ANSWER] even though it does not poll telegram.
  try {
    const drop = localInboxDrop(root);
    if (existsSync(drop)) {
      for (const name of readdirSync(drop)) {
        if (!name.endsWith(".json")) continue;
        const path = join(drop, name);
        try {
          const raw = JSON.parse(readFileSync(path, "utf8")) as InboxTask & { kind?: string };
          const text = typeof raw?.text === "string" ? raw.text : "";
          if (raw.kind === "answer") {
            // Answer markers must carry non-empty text (an empty answer is
            // meaningless); a malformed marker stays in the drop for
            // operator visibility (today's behavior).
            if (text.trim().length === 0) continue;
            onAnswer?.({ id: raw.id, answer: raw.text });
            moveToProcessed(drop, path, name);
            continue;
          }
          const task: InboxTask = {
            id: raw.id ?? `local:${name}`,
            text,
            at: raw.at ?? new Date().toISOString(),
            by: raw.by ?? "local-drop",
          };
          if (text.trim().length === 0 || text.trim().length > MAX_INBOX_TEXT_LENGTH) {
            // Rejected (SEC-2): empty or oversized bodies are never
            // deliverable. Record a durable `inbox_quarantine` rejection
            // (best-effort — handleInboxTask validates and returns null,
            // never throws for validation failures) and MOVE the drop file
            // to rejected/ instead of leaving it in drop/ forever.
            try {
              handleInboxTask(root, task, onTask);
            } catch {
              // quarantine bookkeeping is best-effort; the move below is
              // the durable part
            }
            moveToRejected(drop, path, name);
            continue;
          }
          // File the task (wx idempotent) and wake. A throwing wake (or an
          // IO failure to file) propagates to the catch below, keeping the
          // drop file in place so the next tick retries the wake. Any
          // non-throwing return means the task is durable AND woken →
          // move to processed.
          handleInboxTask(root, task, onTask);
          moveToProcessed(drop, path, name);
        } catch {
          // unreadable / malformed / wake failed — leave in place for the
          // next tick (nothing is lost)
        }
      }
    }
  } catch {
    // drop missing — nothing to do
  }
  // 2. Telegram long-poll (answers + plain-message inbox) — ONLY when no
  //    tg-bridge owns the bot. While the bridge is alive it is the sole
  //    getUpdates consumer (409 otherwise); the session just reads its files.
  if (adapter && !isBridgeAlive(root) && isTelegramPollable(adapter)) {
    try {
      const answers = (await adapter.pollOnce()) ?? [];
      const seen = seenAnswersFor(root);
      for (const answer of answers) {
        if (!answer?.id || seen.has(answer.id)) continue;
        seen.add(answer.id);
        onAnswer?.(answer);
      }
    } catch {
      // network hiccup / 409 with a bridge — next tick retries
    }
  }
}

/** Narrow the Telegram-specific pollOnce surface (http is send-only). */
function isTelegramPollable(
  adapter: unknown,
): adapter is { pollOnce: () => Promise<Array<{ id: string; answer: string }>> } {
  if (typeof adapter !== "object" || adapter === null) return false;
  if (!("pollOnce" in adapter)) return false;
  return typeof adapter.pollOnce === "function";
}

function moveToProcessed(drop: string, path: string, name: string): void {
  try {
    const processedDir = join(drop, "processed");
    mkdirSync(processedDir, { recursive: true });
    renameSync(path, join(processedDir, name));
  } catch {
    // processed move is best-effort; the file stays and will be re-seen
  }
}

function moveToRejected(drop: string, path: string, name: string): void {
  try {
    const rejectedDir = join(drop, "rejected");
    mkdirSync(rejectedDir, { recursive: true });
    renameSync(path, join(rejectedDir, name));
  } catch {
    // rejected move is best-effort; the file stays and will be re-seen
    // (and re-rejected) on the next tick
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
const seenAnswersByRoot = new Map<string, Set<string>>();

function seenAnswersFor(root: string): Set<string> {
  let seen = seenAnswersByRoot.get(root);
  if (!seen) {
    seen = new Set<string>();
    seenAnswersByRoot.set(root, seen);
  }
  return seen;
}
