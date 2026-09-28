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
  type CtoClaimScope,
  type CtoState,
  type Escalation,
  type EscalationAdapter,
  type EscalationReceipt,
  type QuarantineRecord,
  type WaveRecord,
} from "@andvl1/omp-workflows-core";
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
 *
 * At-most-once across restart: the drain moves delivered files to
 * `sent/`, so a later identical queue (e.g. a producer re-run after a
 * dispatcher restart) must NOT re-queue an id that was already delivered.
 * The `outbox/` `wx` guard alone only dedupes the not-yet-drained window;
 * the `sent/` existence check below closes the drained window too.
 */
export function queueCtoDelivery(root: string, runId: string, delivery: CtoDelivery): string | null {
  const dir = outboxDir(runId, root);
  const fileName = `${delivery.id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
  const path = join(dir, fileName);
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(dir, "sent", fileName))) return null;
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
 * in-session dispatcher can create it from `.omp/escalation.json` like any
 * built-in. The standalone `tg-bridge` executable is Telegram-only and
 * rejects consumer-registered kinds.
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
 * Synthesize a wave-completion summary body ONLY from authoritative run
 * state (the `readCtoState` document): wave status/started_at/finished_at,
 * run id, trimmed task excerpt, team status counts, and integration status
 * when present. Dispatcher-side — no prompt/agent content is ever consulted.
 */
function waveSummaryBody(state: CtoState, wave: WaveRecord): string {
  const excerpt = wave.task.trim().slice(0, 200);
  const counts: Record<string, number> = {};
  for (const team of state.teams ?? []) {
    counts[team.status] = (counts[team.status] ?? 0) + 1;
  }
  const teamSummary =
    Object.entries(counts)
      .map(([status, n]) => `${n} ${status}`)
      .sort()
      .join(", ") || "0 teams";
  const lines = [
    `Run ${state.id}: wave ${wave.id} ${wave.status}.`,
    `Started: ${wave.started_at}; finished: ${wave.finished_at}.`,
    `Task: "${excerpt}"`,
    `Teams: ${teamSummary}.`,
  ];
  if (state.integration?.status) lines.push(`Integration: ${state.integration.status}.`);
  return lines.join("\n");
}

/**
 * True when a persisted wave record has every field waveSummaryBody reads
 * (malformed records are skipped, never summarized). Persisted state is
 * UNTRUSTED at this boundary (agent-written/corrupt): a missing field must
 * never abort the scan of other valid records. Active waves have no
 * `finished_at` -> fail the guard -> skipped, same as today.
 */
function isSummarizableWave(wave: unknown): boolean {
  if (typeof wave !== "object" || wave === null) return false;
  const w = wave as Record<string, unknown>;
  return (
    typeof w.id === "string" && w.id.length > 0 &&
    typeof w.task === "string" &&
    typeof w.status === "string" &&
    typeof w.started_at === "string" &&
    typeof w.finished_at === "string" && w.finished_at.length > 0
  );
}

/**
 * Produce wave-completion summary deliveries (RW outbound producer).
 *
 * Scans every run's authoritative `.work-state/cto/<runId>/state.json` via
 * `readCtoState` and, for each wave record with a set `finished_at` (a wave
 * the engine closed — status "done" or "failed"), durably queues one
 * deterministic `<runId>/wave/<waveId>/summary` entry (intent "summary",
 * level "question" — the only non-blocking core level; "info" is not part
 * of the core `EscalationLevel` union, topic "summary"). Waves without
 * `finished_at` (still active) are NEVER summarized.
 *
 * Guarded: a config with NO profiles at all (no `.omp/escalation.json`, or
 * one that resolves to zero channels) queues nothing. RO-only configs DO
 * queue summaries — `drainOutbox` delivers them to the RO sinks (the
 * permitted report fan-out; RO never becomes an inbound/answer source).
 *
 * At-most-once per (runId, waveId): the outbox/ `wx` guard dedupes within
 * the not-yet-drained window, the `sent/` dedupe (queueCtoDelivery) closes
 * the drained window across ticks and dispatcher restarts. Called from the
 * dispatcher tick BEFORE `drainOutbox` so the first tick after a wave
 * finishes both queues AND drains it.
 *
 * Returns the number of NEW deliveries queued (0 on re-runs). Never throws.
 */
export function produceWaveDeliveries(root: string, claimedRunId?: string): number {
  try {
    const channelSet = createChannelSet(root);
    if (channelSet.profiles.length === 0) return 0;
    const runsDir = join(root, ".work-state", "cto");
    if (!existsSync(runsDir)) return 0;
    const runs = claimedRunId ? [claimedRunId] : readdirSync(runsDir);
    let queued = 0;
    for (const runId of runs) {
      const state = readCtoState(runId, root);
      if (!state) continue;
      const history = state.wave_history;
      if (!Array.isArray(history)) continue; // corrupt non-array container: treat as empty, never abort the scan
      for (const wave of history) {
        if (!isSummarizableWave(wave)) continue; // active waves and malformed records are never summarized
        const delivery = queueCtoDelivery(root, runId, {
          id: `${runId}/wave/${wave.id}/summary`,
          level: "question",
          title: "CTO wave complete",
          body: waveSummaryBody(state, wave),
          intent: "summary",
          topic: "summary",
        });
        if (delivery) queued += 1;
      }
    }
    return queued;
  } catch {
    return 0; // never throws — the dispatcher tick must stay alive
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
  opts: { roSinks?: EscalationAdapter[]; runId?: string } = {},
): Promise<DrainOutboxResult[]> {
  const roSinks = opts.roSinks ?? [];
  if (!adapter && roSinks.length === 0) return [];
  const results: DrainOutboxResult[] = [];
  const runsDir = join(root, ".work-state", "cto");
  if (!existsSync(runsDir)) return results;
  const runs = opts.runId ? [opts.runId] : readdirSync(runsDir);
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
  const { onTask, onAnswer, binding } = opts;
  const wakeTask = (task: InboxTask): InboxWakeResult => {
    if (!ownsDispatcherLease(lease)) {
      throw new InboxWakeRejectedError("messenger dispatcher lease lost before task wake");
    }
    const claim = currentDispatcherClaim(binding, root);
    if (!claim || task.runId !== claim.run_id) return "rejected";
    if (!onTask) throw new InboxWakeRejectedError("messenger task wake has no host callback");
    const result = onTask(task);
    return result ?? "accepted";
  };
  const wakeAnswer = (answer: InboxAnswer): InboxWakeResult => {
    if (!ownsDispatcherLease(lease)) {
      throw new InboxWakeRejectedError("messenger dispatcher lease lost before answer wake");
    }
    const claim = currentDispatcherClaim(binding, root);
    if (!claim || (answer.id.split("/")[0] ?? "") !== claim.run_id) return "rejected";
    if (!onAnswer) throw new InboxWakeRejectedError("messenger answer wake has no host callback");
    const result = onAnswer(answer);
    return result ?? "accepted";
  };
  const inboxHandler = (task: InboxTask): void => {
    const claim = currentDispatcherClaim(binding, root);
    if (!claim || (task.runId && task.runId !== claim.run_id)) {
      // The adapter may already have consumed this transport update; retain
      // it in the local durable drop rather than assigning it to another run.
      retainLocalInboxTask(root, task);
      return;
    }
    if (!onTask) {
      handleInboxTask(root, { ...task, runId: claim.run_id }, undefined);
      return;
    }
    handleInboxTask(root, { ...task, runId: claim.run_id }, wakeTask);
  };
  // Inbound surface lives on the primary ONLY (telegram/mock implement it;
  // http is send-only). Cast at the boundary once, guarded at runtime.
  const inboundCapable = primary as { setPlainMessageHandler: (h: (t: InboxTask) => void) => void } | null;
  if (inboundCapable && typeof inboundCapable.setPlainMessageHandler === "function") {
    inboundCapable.setPlainMessageHandler(inboxHandler);
  }
  let ticking = false;
  // Durable answer files are intentionally NOT replayed when a claim or
  // ownership epoch changes. The exact `/cto --run` ingress reads them as
  // durable data; this consumer wakes only new transport/local-drop input
  // while the current claim is present. Proven pre-send refusal remains the
  // only retryable wake path.
  const tick = async (): Promise<void> => {
    if (ticking || !ownsDispatcherLease(lease)) return;
    ticking = true;
    try {
      const claim = currentDispatcherClaim(binding, root);
      if (!claim) {
        return;
      }
      // Wave-completion summaries and outbox entries are scoped to the exact
      // claimed run; no latest-active run is ever drained.
      produceWaveDeliveries(root, claim.run_id);
      await drainOutbox(root, drainAdapter, 3, { roSinks, runId: claim.run_id });
      await pollInbox(root, primary, wakeTask, wakeAnswer, binding, lease.token);
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
export type InboxWakeResult = "accepted" | "rejected" | "unknown";

/** Exact host/session binding used by the resident dispatcher. */
export interface DispatcherBinding {
  readonly session_id: string;
  readonly getClaim: () => CtoClaimScope | undefined;
}

export interface InboxAnswer {
  id: string;
  answer: string;
}

/** A task arriving from the messenger or the local drop. */
export interface InboxTask {
  id: string;
  text: string;
  at: string;
  by?: string;
  /** Optional local-drop marker kind, retained for immutable identity checks. */
  kind?: string;
  /** Resolved run id the task was filed under. */
  runId?: string;
  /** Resident wave id admitted for this task (set when run state is readable). */
  waveId?: string;
}

export interface DispatcherOptions {
  /** Exact captured host/session claim; absent means inbound is fail-closed. */
  binding?: DispatcherBinding;
  /** Called once per new inbox task (after the inbox file is written). */
  onTask?: (task: InboxTask) => InboxWakeResult | void;
  /**
   * Called once per newly received escalation answer (user-initiated reply
   * or button in the messenger channel). The answer file is already written
   * by the adapter; the wake tells the agent to apply it at the next
   * checkpoint (or immediately if it is waiting).
   */
  onAnswer?: (answer: InboxAnswer) => InboxWakeResult | void;
}
/** Typed refusal proving the wake was rejected before host send. */
export class InboxWakeRejectedError extends Error {
  readonly code = "INBOX_WAKE_REJECTED";

  constructor(message = "messenger wake rejected before host send") {
    super(message);
    this.name = "InboxWakeRejectedError";
  }
}

/** `.work-state/cto/<runId>/inbox/` — tasks the CTO reads at checkpoints. */
export function inboxDir(runId: string, root: string): string {
  return join(ctoStateDir(runId, root), "inbox");
}

/** Local task drop: `<root>/.omp/inbox/*.json` ({ id, text, kind?, by? }). */
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

/** Read the optional local-drop marker kind for immutable identity checks. */
function inboxTaskKind(task: InboxTask): string | undefined {
  return task.kind;
}

/**
 * Persist a quarantine record for a task (br-zps.4). Best-effort, NEVER
 * throws: a rejection (or an unreadable run state) must not take down the
 * messenger path. Legacy states missing schema-2 fields are default-filled
 * by readCtoState before this record is written.
 */

function recordQuarantine(
  root: string,
  runId: string,
  task: InboxTask,
  hash: string,
  status: QuarantineRecord["status"],
  reason?: string,
  preserveExistingHash = false,
): void {
  try {
    const state = readCtoState(runId, root);
    if (!state) return;
    state.inbox_quarantine = state.inbox_quarantine ?? {};
    const kind = inboxTaskKind(task);
    const record: QuarantineRecord & { kind?: unknown } = {
      id: task.id,
      hash,
      received_at: task.at ?? new Date().toISOString(),
      by: task.by ?? "inbox",
      status,
      ...(kind !== undefined ? { kind } : {}),
      ...(reason ? { reason } : {}),
    };
    const existing = state.inbox_quarantine[hash];
    if (preserveExistingHash && existing) {
      // The normalized hash is already authoritative for another source (or
      // an in-flight retry). Leave it untouched; the typed rejection and the
      // retained transport source are independent conflict evidence.
      return;
    }
    state.inbox_quarantine[hash] = record;
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
 *   - an existing transport id with different content/kind is REJECTED
 *     without touching the original file or admitting a second wave;
 *   - otherwise the record is persisted as `quarantined` BEFORE the write
 *     and flipped to `admitted` AFTER it. A wake failure reverts the record
 *     to `quarantined` (before removing the file) so the transport's retry
 *     passes the admitted-dedup and re-wakes.
 * When the run state is unreadable the task is filed WITHOUT quarantine
 * bookkeeping — availability over strictness; corrupt state is a separate
 * incident.
 *
 * The file write is idempotent (`wx`: the first write wins). A callback that
 * reports a verified pre-send refusal rolls back only this in-flight
 * admission; an ambiguous host exception keeps the durable file and never
 * queues an admission ACK.
 *
 * Returns the path when this call wrote the file; null when the task was
 * rejected, deduped, already filed, or has no exact run binding. A typed
 * {@link InboxWakeRejectedError} is thrown only for a verified pre-send
 * refusal so the transport can retain its source update for retry.
 */
export function handleInboxTask(
  root: string,
  task: InboxTask,
  onTask?: (t: InboxTask) => InboxWakeResult | void,
): string | null {
  const runId = typeof task.runId === "string" && task.runId.length > 0 ? task.runId : undefined;
  if (!runId) return null;

  // ── Quarantine pass (br-zps.4) ───────────────────────────────────────────
  const rawText = typeof task.text === "string" ? task.text : "";
  const normalized = rawText.trim();
  const hash = sha256Hex(rawText);
  if (normalized.length === 0 || normalized.length > MAX_INBOX_TEXT_LENGTH) {
    const reason = normalized.length === 0 ? "empty text" : "text exceeds MAX_INBOX_TEXT_LENGTH";
    recordQuarantine(root, runId, task, hash, "rejected", reason);
    return null; // nothing filed, no wake — validation failures never throw
  }

  // Deduplicate by the immutable transport identity first. A prior wave is
  // authoritative even after its inbox file was consumed; a different
  // payload or marker kind under the same source id is a conflict, never a
  // new wave. The kind is retained in the quarantine record because WaveRecord
  // deliberately has no transport-marker field.
  const state = readCtoState(runId, root);
  const priorWave = state ? findWaveBySourceId(state, task.id) : null;
  const taskKind = inboxTaskKind(task);
  const conflictReason = `inbox task ${task.id} has conflicting content or kind for the same transport id`;
  if (priorWave) {
    const priorHash = sha256Hex(priorWave.task);
    const priorKind = (state?.inbox_quarantine?.[priorHash] as (QuarantineRecord & { kind?: unknown }) | undefined)?.kind;
    if (priorWave.task !== task.text || priorKind !== taskKind) {
      recordQuarantine(root, runId, task, hash, "rejected", conflictReason, true);
      throw new InboxWakeRejectedError(conflictReason);
    }
    if (state?.inbox_quarantine?.[priorHash]?.status !== "quarantined") return null;
  }

  const dir = inboxDir(runId, root);
  const fileName = task.id.replace(/[^a-zA-Z0-9._-]/g, "-");
  const suffix = createHash("sha256").update(task.id).digest("hex");
  const serialized = JSON.stringify({ ...task, runId }, null, 2);
  // Check every direct inbox candidate before text-hash deduplication so a
  // changed payload or marker kind under the same id cannot be hidden by
  // another task's normalized-text quarantine record. Do not create this
  // directory until after the no-callback refusal below.
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      let existing: { id?: unknown; text?: unknown; kind?: unknown };
      try {
        existing = JSON.parse(readFileSync(join(dir, name), "utf8")) as { id?: unknown; text?: unknown; kind?: unknown };
      } catch (readError) {
        if (readError instanceof SyntaxError) continue;
        throw new Error(`inbox task ${task.id} cannot verify existing file ${join(dir, name)}: ${readError instanceof Error ? readError.message : String(readError)}`);
      }
      if (existing.id !== task.id) continue;
      const existingIsSameTask = existing.text === task.text && existing.kind === taskKind;
      if (existingIsSameTask) {
        recordQuarantine(root, runId, task, hash, "admitted");
        return null;
      }
      recordQuarantine(root, runId, task, hash, "rejected", conflictReason, true);
      throw new InboxWakeRejectedError(conflictReason);
    }
  }
  // Dedup: an already-admitted hash is a duplicate task (same normalized
  // text) — no file, no wake. A "quarantined" record means a previous
  // attempt died mid-flight (wake failed, write rolled back) → proceed.
  if (state && state.inbox_quarantine?.[hash]?.status === "admitted") {
    return null;
  }
  if (!onTask) {
    const reason = "inbox task wake rejected before host send: no onTask callback";
    recordQuarantine(root, runId, task, hash, "rejected", reason);
    throw new InboxWakeRejectedError(reason);
  }
  mkdirSync(dir, { recursive: true });
  // Track the in-flight task BEFORE the write; flipped to "admitted" after
  // the file write succeeds. State unreadable → file as today, no tracking.
  let quarantineTracked = false;
  if (state) {
    try {
      state.inbox_quarantine = state.inbox_quarantine ?? {};
      const inFlightRecord: QuarantineRecord & { kind?: unknown } = {
        id: task.id,
        hash,
        received_at: task.at ?? new Date().toISOString(),
        by: task.by ?? "inbox",
        status: "quarantined",
        ...(taskKind !== undefined ? { kind: taskKind } : {}),
      };
      state.inbox_quarantine[hash] = inFlightRecord;
      writeCtoState(state, root);
      quarantineTracked = true;
    } catch {
      // Persisting the record failed — file the task anyway (availability).
      quarantineTracked = false;
    }
  }

  let collision = 0;
  let path: string;
  for (;;) {
    const suffixPart = collision === 0 ? "" : `-${suffix}${collision === 1 ? "" : `-${collision}`}`;
    path = join(dir, `${fileName}${suffixPart}.json`);
    try {
      writeFileSync(path, serialized, { flag: "wx" });
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      let existing: { id?: unknown; text?: unknown; kind?: unknown };
      try {
        existing = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown; text?: unknown; kind?: unknown };
      } catch (readError) {
        if (readError instanceof SyntaxError) {
          collision += 1;
          continue;
        }
        throw new Error(`inbox task ${task.id} cannot verify existing file ${path}: ${readError instanceof Error ? readError.message : String(readError)}`);
      }
      if (existing.id === task.id) {
        const existingIsSameTask = existing.text === task.text && existing.kind === taskKind;
        if (existingIsSameTask) {
          recordQuarantine(root, runId, task, hash, "admitted");
          return null;
        }
        recordQuarantine(root, runId, task, hash, "rejected", conflictReason, true);
        throw new InboxWakeRejectedError(conflictReason);
      }
      // Distinct ids that sanitize to the same path get a deterministic
      // hash-suffixed sibling rather than being silently dropped.
      collision += 1;
    }
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
  const rollbackAdmission = (): void => {
    if (quarantineTracked) {
      try {
        const current = readCtoState(runId, root) ?? state;
        const record = current?.inbox_quarantine?.[hash];
        if (current && record) {
          record.status = "quarantined";
          writeCtoState(current, root);
        }
      } catch {
        // best-effort — the wake refusal is the primary outcome
      }
    }
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort removal; the durable source retry remains authoritative
    }
  };

  let wakeResult: InboxWakeResult = "accepted";
  try {
    if (!onTask) throw new InboxWakeRejectedError("inbox task wake has no host callback");
    const result = onTask({ ...task, runId, waveId });
    wakeResult = result ?? "accepted";
  } catch (error) {
    if (error instanceof InboxWakeRejectedError) {
      rollbackAdmission();
      throw error;
    }
    // The host may have accepted the send before throwing. Preserve the
    // durable inbox file and make no admission ACK or retry claim.
    wakeResult = "unknown";
  }
  if (wakeResult === "rejected") {
    rollbackAdmission();
    throw new InboxWakeRejectedError();
  }
  // ── Admission ACK (RW outbound producer) ────────────────────────────────
  // A verified successful wake is what permits an admission ACK. Ambiguous
  // host sends keep only the durable inbox record; they never claim exactly
  // once delivery and never emit a false ACK.
  try {
    const channelSet = createChannelSet(root);
    if (wakeResult === "accepted" && channelSet.profile.direction === "rw" && channelSet.primary !== null) {
      const excerpt = task.text.trim().slice(0, 200);
      queueCtoDelivery(root, runId, {
        id: `${runId}/wave/${task.id}/ack`,
        level: "question",
        title: "CTO task admitted",
        body: `Run ${runId} admitted task "${excerpt}"${waveId ? ` as wave ${waveId}` : ""}.`,
        intent: "ack",
        ...(channelSet.profile.ackTarget ? { target: channelSet.profile.ackTarget } : {}),
      });
    }
  } catch {
    // best-effort — a failed ACK must never break the return path
  }
  return path;
}

interface DispatcherClaimFailure {
  code: "run_busy" | "recovery_required";
  message: string;
  next_action?: string;
}

const reportedDispatcherClaimFailures = new Map<string, string>();

function dispatcherClaimFailure(error: unknown): DispatcherClaimFailure | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; message?: unknown; next_action?: unknown };
  if (
    (candidate.code !== "run_busy" && candidate.code !== "recovery_required")
    || typeof candidate.message !== "string"
  ) {
    return undefined;
  }
  return {
    code: candidate.code,
    message: candidate.message,
    ...(typeof candidate.next_action === "string" ? { next_action: candidate.next_action } : {}),
  };
}

function currentDispatcherClaim(
  binding: DispatcherBinding | undefined,
  root = "",
): CtoClaimScope | undefined {
  if (!binding || binding.session_id.length === 0) return undefined;
  try {
    const claim = binding.getClaim();
    const validClaim = claim
      && typeof claim.run_id === "string"
      && claim.run_id.length > 0
      && typeof claim.ownership_epoch === "string"
      && claim.ownership_epoch.length > 0
      ? claim
      : undefined;
    if (validClaim) {
      reportedDispatcherClaimFailures.delete(root);
      return validClaim;
    }
    return undefined;
  } catch (error) {
    const failure = dispatcherClaimFailure(error);
    if (failure) {
      const reportKey = `${failure.code}\u0000${failure.message}\u0000${failure.next_action ?? ""}`;
      if (reportedDispatcherClaimFailures.get(root) !== reportKey) {
        reportedDispatcherClaimFailures.set(root, reportKey);
        console.error(
          `CTO dispatcher claim unavailable (${failure.code}): ${failure.message}` +
          (failure.next_action ? `; next action: ${failure.next_action}` : ""),
        );
      }
    }
    // A typed stale/recovery refusal is not ordinary absence: it is reported
    // above, while this dispatcher remains fail-closed and never releases or
    // replaces the host's private ownership claim.
    return undefined;
  }
}
type AnswerWakeStatus = "pending" | "in-flight" | "accepted" | "pre-send-rejected" | "unknown";

interface PersistedInboxAnswer extends InboxAnswer {
  delivery_status?: AnswerWakeStatus;
  delivery_run_id?: string;
  delivery_ownership_epoch?: string;
  delivery_session_id?: string;
  delivery_reason?: string;
}
function canonicalAnswerPreferredPath(root: string, answerId: string): string | undefined {
  const runId = answerId.split("/")[0] ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(runId) || answerId.length === 0) return undefined;
  return join(
    ctoStateDir(runId, root),
    "answers",
    `${answerId.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`,
  );
}

function canonicalAnswerPath(root: string, answerId: string): string | undefined {
  const preferred = canonicalAnswerPreferredPath(root, answerId);
  if (!preferred) return undefined;
  const dir = join(preferred, "..");
  const fileName = answerId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const suffix = createHash("sha256").update(answerId).digest("hex");

  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  // Preserve an answer already written under an older hash-suffixed name.
  for (const name of names) {
    const candidate = join(dir, name);
    try {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as { id?: unknown };
      if (raw.id === answerId) return candidate;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }

  for (let collision = 0; ; collision += 1) {
    const suffixPart = collision === 0 ? "" : `-${suffix}${collision === 1 ? "" : `-${collision}`}`;
    const candidate = join(dir, `${fileName}${suffixPart}.json`);
    try {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as { id?: unknown };
      if (raw.id === answerId) return candidate;
      // A distinct valid id occupies this deterministic name; try the next
      // hash-suffixed candidate without overwriting it.
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return candidate;
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
}

function readCanonicalAnswer(root: string, answer: InboxAnswer): PersistedInboxAnswer | undefined {
  const path = canonicalAnswerPath(root, answer.id);
  if (!path) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as PersistedInboxAnswer;
    return raw.id === answer.id && raw.answer === answer.answer ? raw : undefined;
  } catch {
    return undefined;
  }
}

interface PreviousAnswerAttempt {
  run_id: string;
  ownership_epoch: string;
  session_id: string;
}

/**
 * Replace a JSON record without truncating the authoritative source on a
 * serialization or write failure. The temporary file lives beside the
 * source, so rename is a same-filesystem atomic replacement on supported
 * hosts; failed attempts clean up only the temporary path.
 */
function atomicReplaceJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) throw new Error(`cannot serialize JSON record ${path}`);
    writeFileSync(temporary, serialized, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    } catch {
      // Best-effort temporary cleanup; the authoritative path was not
      // touched unless rename completed.
    }
  }
}

/**
 * Reserve the canonical answer before invoking the host. A crash after this
 * write leaves an in-flight receipt, which is intentionally never replayed.
 * The only cross-epoch transition is from a matching trusted local
 * pre-send-refusal marker.
 */
function reserveAnswerWake(
  root: string,
  answer: InboxAnswer,
  claim: CtoClaimScope,
  sessionId: string,
  previous?: PreviousAnswerAttempt,
): boolean {
  const path = canonicalAnswerPath(root, answer.id);
  if (!path) return false;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw.id !== answer.id || raw.answer !== answer.answer) return false;
    if (raw.delivery_status !== undefined) {
      if (
        raw.delivery_status !== "pre-send-rejected"
        || !previous
        || raw.delivery_run_id !== previous.run_id
        || raw.delivery_ownership_epoch !== previous.ownership_epoch
        || raw.delivery_session_id !== previous.session_id
      ) return false;
    }
    raw.delivery_status = "in-flight";
    raw.delivery_run_id = claim.run_id;
    raw.delivery_ownership_epoch = claim.ownership_epoch;
    raw.delivery_session_id = sessionId;
    delete raw.delivery_reason;
    atomicReplaceJson(path, raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Complete only the same in-flight attempt that reserved this answer. A late
 * callback from an older claim/epoch cannot clobber a newer receipt.
 */
function finishAnswerWake(
  root: string,
  answer: InboxAnswer,
  status: Exclude<AnswerWakeStatus, "pending" | "in-flight">,
  claim: CtoClaimScope,
  sessionId: string,
  reason?: string,
): boolean {
  const path = canonicalAnswerPath(root, answer.id);
  if (!path) return false;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      raw.id !== answer.id
      || raw.answer !== answer.answer
      || raw.delivery_status !== "in-flight"
      || raw.delivery_run_id !== claim.run_id
      || raw.delivery_ownership_epoch !== claim.ownership_epoch
      || raw.delivery_session_id !== sessionId
    ) return false;
    raw.delivery_status = status;
    if (reason) raw.delivery_reason = reason;
    else delete raw.delivery_reason;
    atomicReplaceJson(path, raw);
    return true;
  } catch {
    return false;
  }
}

function markLocalAnswerWakeStatus(
  path: string,
  status: AnswerWakeStatus,
  claim: CtoClaimScope,
  sessionId: string,
  reason?: string,
): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw.kind !== "answer" || typeof raw.id !== "string" || typeof raw.text !== "string") return false;
    raw.delivery_status = status;
    raw.delivery_run_id = claim.run_id;
    raw.delivery_ownership_epoch = claim.ownership_epoch;
    raw.delivery_session_id = sessionId;
    if (reason) raw.delivery_reason = reason;
    else delete raw.delivery_reason;
    atomicReplaceJson(path, raw);
    return true;
  } catch {
    return false;
  }
}

const preSendAnswerAttemptsByRoot = new Map<string, Set<string>>();

function preSendAnswerAttemptsFor(root: string): Set<string> {
  let attempts = preSendAnswerAttemptsByRoot.get(root);
  if (!attempts) {
    attempts = new Set<string>();
    preSendAnswerAttemptsByRoot.set(root, attempts);
  }
  return attempts;
}

function preSendAnswerAttemptKey(path: string, claim: CtoClaimScope, sessionId: string, leaseToken: string): string {
  return `${path}\u0000${claim.run_id}\u0000${claim.ownership_epoch}\u0000${sessionId}\u0000${leaseToken}`;
}

function retainPreSendRejectedAnswer(
  root: string,
  answer: InboxAnswer,
  claim: CtoClaimScope,
  sessionId: string,
  leaseToken: string,
  reason: string,
): void {
  const drop = localInboxDrop(root);
  mkdirSync(drop, { recursive: true });
  const answerKey = answer.id.replace(/[^a-zA-Z0-9._-]/g, "-");
  const epochKey = claim.ownership_epoch.replace(/[^a-zA-Z0-9._-]/g, "-");
  const suffix = createHash("sha256").update(`${answer.id}\u0000${claim.ownership_epoch}`).digest("hex");
  const marker = {
    kind: "answer",
    id: answer.id,
    text: answer.answer,
    at: new Date().toISOString(),
    by: "dispatcher",
    delivery_status: "pre-send-rejected" as const,
    delivery_run_id: claim.run_id,
    delivery_ownership_epoch: claim.ownership_epoch,
    delivery_session_id: sessionId,
    delivery_reason: reason,
  };
  let path = "";
  for (let collision = 0; ; collision += 1) {
    const suffixPart = collision === 0 ? "" : `-${suffix}${collision === 1 ? "" : `-${collision}`}`;
    path = join(drop, `answer-retry-${answerKey}-${epochKey}${suffixPart}.json`);
    try {
      writeFileSync(path, JSON.stringify(marker, null, 2), { flag: "wx" });
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      let existing: { id?: unknown; kind?: unknown; text?: unknown };
      try {
        existing = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown; kind?: unknown; text?: unknown };
      } catch (readError) {
        if (readError instanceof SyntaxError) continue;
        throw new Error(`answer retry marker ${answer.id} cannot verify existing file ${path}: ${readError instanceof Error ? readError.message : String(readError)}`);
      }
      if (existing.id === answer.id && existing.kind === "answer" && existing.text === answer.answer) break;
    }
  }
  preSendAnswerAttemptsFor(root).add(preSendAnswerAttemptKey(path, claim, sessionId, leaseToken));
}


function persistCanonicalAnswer(root: string, answer: InboxAnswer): void {
  if (!answer || typeof answer !== "object" || typeof answer.id !== "string" || answer.id.length === 0) {
    throw new Error("canonical answer has an invalid id; expected a non-empty string");
  }
  if (typeof answer.answer !== "string") {
    throw new Error(`canonical answer ${answer.id} has invalid content; expected a string`);
  }
  const path = canonicalAnswerPath(root, answer.id);
  if (!path) {
    throw new Error(`canonical answer ${answer.id} has an unsafe id/path and cannot be persisted`);
  }
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(answer, null, 2), { flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    let existing: { id?: unknown; answer?: unknown };
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown; answer?: unknown };
    } catch (readError) {
      throw new Error(`canonical answer ${answer.id} cannot verify existing file ${path}: ${readError instanceof Error ? readError.message : String(readError)}`);
    }
    if (existing.id !== answer.id || existing.answer !== answer.answer) {
      const detail = existing.id === answer.id ? "distinct answer content" : "distinct stored id";
      const message = `canonical answer ${answer.id} collided with ${detail} in ${path}`;
      recordAnswerConflictDiagnostic(root, answer, message);
      throw new Error(message);
    }
  }
}
function recordAnswerConflictDiagnostic(root: string, answer: InboxAnswer, reason: string): void {
  const runId = answer.id.split("/")[0] ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return;
  const dir = join(ctoStateDir(runId, root), "answers", "rejected");
  const answerKey = answer.id.replace(/[^a-zA-Z0-9._-]/g, "-");
  const suffix = createHash("sha256").update(`${answer.id}\u0000${answer.answer}`).digest("hex");
  const path = join(dir, `${answerKey}.conflict-${suffix}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ id: answer.id, answer: answer.answer, reason, at: new Date().toISOString() }, null, 2),
      { flag: "wx" },
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return;
    // The canonical conflict remains fail-closed even if its diagnostic
    // directory is temporarily unavailable.
  }
}


function recordLocalInboxConflictDiagnostic(root: string, task: InboxTask, taskKind: unknown, reason: string): void {
  const dir = join(localInboxDrop(root), "rejected");
  const fileName = task.id.replace(/[^a-zA-Z0-9._-]/g, "-");
  const suffix = createHash("sha256").update(`${task.id}\u0000${String(taskKind ?? "")}\u0000${task.text}`).digest("hex");
  const path = join(dir, `${fileName}.conflict-${suffix}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ id: task.id, kind: taskKind, text: task.text, reason, at: new Date().toISOString() }, null, 2),
      { flag: "wx" },
    );
  } catch (error) {
    if (isAlreadyExists(error)) return;
    // The original local-drop task remains authoritative if diagnostics fail.
  }
}

function retainLocalInboxTask(root: string, task: InboxTask): void {
  const dir = localInboxDrop(root);
  const fileName = task.id.replace(/[^a-zA-Z0-9._-]/g, "-");
  const suffix = createHash("sha256").update(task.id).digest("hex");
  const taskKind = task.kind;
  const conflictReason = `local inbox task ${task.id} has conflicting content or kind for the same transport id`;
  const serialized = JSON.stringify(task, null, 2);
  mkdirSync(dir, { recursive: true });
  for (let collision = 0; ; collision += 1) {
    const suffixPart = collision === 0 ? "" : `-${suffix}${collision === 1 ? "" : `-${collision}`}`;
    const path = join(dir, `${fileName}${suffixPart}.json`);
    try {
      writeFileSync(path, serialized, { flag: "wx" });
      return;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      let existing: { id?: unknown; kind?: unknown; text?: unknown };
      try {
        existing = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown; kind?: unknown; text?: unknown };
      } catch (readError) {
        if (readError instanceof SyntaxError) continue;
        throw new Error(`local inbox task ${task.id} cannot verify existing file ${path}: ${readError instanceof Error ? readError.message : String(readError)}`);
      }
      if (existing.id === task.id) {
        if (existing.kind === taskKind && existing.text === task.text) return;
        recordLocalInboxConflictDiagnostic(root, task, taskKind, conflictReason);
        throw new InboxWakeRejectedError(conflictReason);
      }
    }
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
  onTask?: (t: InboxTask) => InboxWakeResult | void,
  onAnswer?: (a: InboxAnswer) => InboxWakeResult | void,
  binding?: DispatcherBinding,
  leaseToken = "",
): Promise<void> {
  // No exact captured claim means neither local markers nor adapter answers
  // may be consumed. The source remains durable for explicit reacquisition.
  const initialClaim = currentDispatcherClaim(binding, root);
  if (!initialClaim || !binding) return;

  // 1. Local drop (bridge-written tasks + answer markers). Answer markers
  // reserve the canonical answer before invoking the host. A crash after
  // reservation is ambiguous and therefore never replayed automatically.
  try {
    const drop = localInboxDrop(root);
    if (existsSync(drop)) {
      for (const name of readdirSync(drop)) {
        if (!name.endsWith(".json")) continue;
        const path = join(drop, name);
        try {
          const raw = JSON.parse(readFileSync(path, "utf8")) as InboxTask & {
            kind?: string;
            delivery_status?: AnswerWakeStatus;
            delivery_run_id?: string;
            delivery_ownership_epoch?: string;
            delivery_session_id?: string;
          };
          const claim = currentDispatcherClaim(binding, root);
          if (!claim) break;
          const text = typeof raw?.text === "string" ? raw.text : "";
          if (raw.kind === "answer") {
            if (text.trim().length === 0 || typeof raw.id !== "string") continue;
            if ((raw.id.split("/")[0] ?? "") !== claim.run_id) continue;
            const answer: InboxAnswer = { id: raw.id, answer: raw.text };
            persistCanonicalAnswer(root, answer);
            const canonical = readCanonicalAnswer(root, answer);

            // Terminal/in-flight local markers are retained only as durable
            // evidence; they must never invoke the host a second time.
            if (raw.delivery_status === "in-flight"
              || raw.delivery_status === "accepted"
              || raw.delivery_status === "unknown") {
              moveToProcessed(drop, path, name);
              continue;
            }

            const attemptKey = preSendAnswerAttemptKey(path, claim, binding.session_id, leaseToken);
            if (preSendAnswerAttemptsFor(root).has(attemptKey) && raw.delivery_status === "pre-send-rejected") {
              // One wake attempt per exact claim/epoch in this dispatcher.
              // A fresh dispatcher lease may retry the proven refusal.
              continue;
            }
            let previous: PreviousAnswerAttempt | undefined;
            if (raw.delivery_status === "pre-send-rejected") {
              if (
                canonical?.delivery_status !== "pre-send-rejected"
                || raw.delivery_run_id !== canonical.delivery_run_id
                || raw.delivery_ownership_epoch !== canonical.delivery_ownership_epoch
                || raw.delivery_session_id !== canonical.delivery_session_id
                || typeof raw.delivery_run_id !== "string"
                || typeof raw.delivery_ownership_epoch !== "string"
                || typeof raw.delivery_session_id !== "string"
              ) {
                moveToRejected(drop, path, name);
                continue;
              }
              previous = {
                run_id: raw.delivery_run_id,
                ownership_epoch: raw.delivery_ownership_epoch,
                session_id: raw.delivery_session_id,
              };
            } else if (
              canonical?.delivery_status !== undefined
              || raw.delivery_status !== undefined
            ) {
              // A canonical reservation without its matching local recovery
              // marker is ambiguous. Fail closed rather than replaying.
              moveToRejected(drop, path, name);
              continue;
            }

            if (!reserveAnswerWake(root, answer, claim, binding.session_id, previous)) {
              moveToRejected(drop, path, name);
              continue;
            }
            preSendAnswerAttemptsFor(root).add(attemptKey);
            markLocalAnswerWakeStatus(path, "in-flight", claim, binding.session_id);

            let result: InboxWakeResult = "accepted";
            let refusalReason: string | undefined;
            try {
              if (!onAnswer) {
                const refusal = new InboxWakeRejectedError("messenger answer wake has no host callback");
                result = "rejected";
                refusalReason = refusal.message;
              } else {
                const callbackResult = onAnswer(answer);
                result = callbackResult ?? "accepted";
              }
            } catch (error) {
              if (error instanceof InboxWakeRejectedError) {
                result = "rejected";
                refusalReason = error.message;
              } else {
                result = "unknown";
                refusalReason = "host send outcome unknown; explicit /cto --run reconciliation required";
              }
            }
            if (result === "rejected") {
              const reason = refusalReason ?? "host rejected before send";
              if (
                finishAnswerWake(root, answer, "pre-send-rejected", claim, binding.session_id, reason)
              ) {
                markLocalAnswerWakeStatus(path, "pre-send-rejected", claim, binding.session_id, reason);
              } else {
                markLocalAnswerWakeStatus(
                  path,
                  "unknown",
                  claim,
                  binding.session_id,
                  "answer wake reservation changed; explicit /cto --run reconciliation required",
                );
                moveToProcessed(drop, path, name);
              }
              continue;
            }
            const terminal: Exclude<AnswerWakeStatus, "pending" | "in-flight"> =
              result === "accepted" ? "accepted" : "unknown";
            const reason = result === "accepted"
              ? undefined
              : refusalReason ?? "host send outcome unknown; explicit /cto --run reconciliation required";
            const finished = finishAnswerWake(root, answer, terminal, claim, binding.session_id, reason);
            markLocalAnswerWakeStatus(
              path,
              finished ? terminal : "unknown",
              claim,
              binding.session_id,
              finished ? reason : "answer wake reservation changed; explicit /cto --run reconciliation required",
            );
            moveToProcessed(drop, path, name);
            continue;
          }
          const task: InboxTask = {
            id: raw.id ?? `local:${name}`,
            text,
            at: raw.at ?? new Date().toISOString(),
            by: raw.by ?? "local-drop",
            ...(typeof raw.kind === "string" ? { kind: raw.kind } : {}),
            ...(raw.runId ? { runId: raw.runId } : {}),
          };
          if (task.runId && task.runId !== claim.run_id) continue;
          const routedTask = { ...task, runId: claim.run_id };
          if (text.trim().length === 0 || text.trim().length > MAX_INBOX_TEXT_LENGTH) {
            handleInboxTask(root, routedTask, onTask);
            moveToRejected(drop, path, name);
            continue;
          }
          handleInboxTask(root, routedTask, onTask);
          moveToProcessed(drop, path, name);
        } catch {
          // unreadable / malformed / wake refusal — leave in place for the
          // next exact claim tick (nothing is lost)
        }
      }
    }
  } catch {
    // drop missing — nothing to do
  }

  // 2. Adapter long-poll. The exact claim gate above runs before pollOnce,
  // preventing Telegram/mock transports from consuming answers while the
  // resident session is unbound.
  const bridgeOwnsPoll = adapter !== null && adapter.kind === "telegram" && isBridgeAlive(root);
  if (adapter && !bridgeOwnsPoll && isPollOnceCapable(adapter)) {
    if (isAnswerPersistenceCapable(adapter)) {
      adapter.setAnswerPersistenceHandler((answer) => persistCanonicalAnswer(root, answer));
    }
    try {
      const answers = (await adapter.pollOnce()) ?? [];
      const seen = seenAnswersFor(root);
      for (const answer of answers) {
        if (!answer?.id || typeof answer.answer !== "string") continue;
        const answerKey = seenAnswerKey(answer);
        if (seen.has(answerKey)) continue;
        const claim = currentDispatcherClaim(binding, root);
        persistCanonicalAnswer(root, answer);
        if (!claim || (answer.id.split("/")[0] ?? "") !== claim.run_id) continue;
        const canonical = readCanonicalAnswer(root, answer);
        if (canonical?.delivery_status !== undefined) {
          // Existing in-flight/terminal/legacy provenance is durable but is
          // never treated as a fresh wake.
          seen.add(answerKey);
          continue;
        }
        if (!reserveAnswerWake(root, answer, claim, binding.session_id)) {
          seen.add(answerKey);
          continue;
        }
        let result: InboxWakeResult = "accepted";
        let refusalReason: string | undefined;
        try {
          if (!onAnswer) {
            const refusal = new InboxWakeRejectedError("messenger answer wake has no host callback");
            result = "rejected";
            refusalReason = refusal.message;
          } else {
            const callbackResult = onAnswer(answer);
            result = callbackResult ?? "accepted";
          }
        } catch (error) {
          if (error instanceof InboxWakeRejectedError) {
            result = "rejected";
            refusalReason = error.message;
          } else {
            result = "unknown";
            refusalReason = "host send outcome unknown; explicit /cto --run reconciliation required";
          }
        }
        if (result === "rejected") {
          const reason = refusalReason ?? "host rejected before send";
          if (finishAnswerWake(root, answer, "pre-send-rejected", claim, binding.session_id, reason)) {
            retainPreSendRejectedAnswer(root, answer, claim, binding.session_id, leaseToken, reason);
          }
          seen.add(answerKey);
          continue;
        }
        const terminal: Exclude<AnswerWakeStatus, "pending" | "in-flight"> =
          result === "accepted" ? "accepted" : "unknown";
        const reason = result === "accepted"
          ? undefined
          : refusalReason ?? "host send outcome unknown; explicit /cto --run reconciliation required";
        finishAnswerWake(root, answer, terminal, claim, binding.session_id, reason);
        seen.add(answerKey);
      }
    } catch (error) {
      console.error(
        `dispatcher inbox poll failed; pending transport input was retained where possible: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
): adapter is { pollOnce: () => Promise<Array<{ id: string; answer: string }>> } {
  if (typeof adapter !== "object" || adapter === null) return false;
  if (!("pollOnce" in adapter)) return false;
  return typeof adapter.pollOnce === "function";
}

function isAnswerPersistenceCapable(
  adapter: unknown,
): adapter is { setAnswerPersistenceHandler: (handler: (answer: InboxAnswer) => void) => void } {
  if (typeof adapter !== "object" || adapter === null) return false;
  if (!("setAnswerPersistenceHandler" in adapter)) return false;
  return typeof adapter.setAnswerPersistenceHandler === "function";
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
 * waiting team applies it, others treat it as advisory (the CTO contract
 * says late answers are advisory). Keyed by root so one project's wakes
 * never suppress another project's wakes for the same id/content pair.
 */
const seenAnswersByRoot = new Map<string, Set<string>>();

function seenAnswerKey(answer: InboxAnswer): string {
  return `${answer.id}\u0000${answer.answer}`;
}

function seenAnswersFor(root: string): Set<string> {
  let seen = seenAnswersByRoot.get(root);
  if (!seen) {
    seen = new Set<string>();
    seenAnswersByRoot.set(root, seen);
  }
  return seen;
}
