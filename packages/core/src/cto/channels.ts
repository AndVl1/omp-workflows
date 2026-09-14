/**
 * Pure channel normalizer for `.omp/escalation.json` (architecture-4).
 *
 * One and only one resolved channel profile: legacy single-adapter configs
 * ({adapter,bidirectional,http,telegram}) and explicit multi-channel configs
 * (`channels[]`) both normalize to `ChannelProfile[]`, and
 * `resolveChannelProfile(cwd)` picks THE profile the CTO run uses — RW
 * primary preferred, else first RO, else {direction:"none"}.
 *
 * Explicit entries carry an optional `id` — the per-entry handle that lets a
 * consumer (createChannelSet) bind each profile to its OWN config entry when
 * several entries share an adapter kind. Ambiguous same-kind groups (>=2
 * entries with no ids or duplicate ids) are excluded fail-closed — never
 * silently colliding; a single id-less entry per kind stays (legacy
 * fallback).
 *
 * Capability rule (config_contract.capability_rule): a declared
 * "read-write" channel is honored only when the adapter kind's capabilities
 * have inbound AND outbound (otherwise it downgrades to "ro"); a declared
 * "read-only" channel NEVER upgrades, even with full capabilities. When no
 * capabilities table is supplied, built-in defaults apply (telegram/mock =
 * rw, http and any other kind = ro).
 *
 * Configuration I/O is descriptor-anchored and bounded; malformed JSON remains
 * absent while unsafe files raise a typed EscalationConfigError.
 */

import { TextDecoder } from "node:util";
import { PinnedProjectRoot, PinnedRootError } from "../specification/pinned-root.js";
import type { ChannelDirection, ChannelProfile } from "./types.js";

/** Declared explicit channel entry (config_contract.explicit). */
export interface ExplicitChannelConfig {
  id: string;
  adapter: string;
  direction: ChannelDirection;
  primary?: boolean;
  subscriptions?: string[];
}

/** Bounded, normalized escalation document shared with adapter registries. */
export interface NormalizedChannelConfig extends Record<string, unknown> {
  adapter: string;
  id?: string;
  name?: string;
  mode?: string;
  direction?: ChannelDirection;
  primary?: boolean;
  subscriptions?: string[];
  fields?: Record<string, string>;
}
export interface NormalizedEscalationConfig extends Record<string, unknown> {
  adapter?: string;
  bidirectional?: boolean;
  channels?: NormalizedChannelConfig[];
}

export type EscalationConfigInvalidCode = "malformed" | "invalid_shape" | "duplicate_id" | "duplicate_primary" | "invalid_primary_direction";
export type EscalationConfigLoadResult =
  | { status: "absent" }
  | { status: "valid"; config: NormalizedEscalationConfig }
  | { status: "invalid"; code: EscalationConfigInvalidCode; reason: string };
export type ChannelNormalizationResult =
  | { status: "absent" }
  | { status: "valid"; profiles: ChannelProfile[] }
  | { status: "invalid"; code: Exclude<EscalationConfigInvalidCode, "malformed">; reason: string };
function isEscalationConfigLoadResult(value: unknown): value is EscalationConfigLoadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.status === "absent") return Object.keys(candidate).length === 1;
  if (candidate.status === "valid") return Object.hasOwn(candidate, "config");
  return candidate.status === "invalid" && Object.hasOwn(candidate, "code") && Object.hasOwn(candidate, "reason");
}

/** Adapter-kind capabilities (architecture-2: direction and delivery safety derive from registered methods). */
export interface ChannelCapabilities {
  /** Implements pollOnce/setPlainMessageHandler (inbound). */
  canReceiveInbound: boolean;
  /** Implements send (outbound). */
  canSend: boolean;
  /** Implements durable receiver-side idempotent delivery. */
  canSendWithIdempotency: boolean;
}

/** Built-in capability defaults — used ONLY when no capabilities param is supplied. */
const BUILTIN_CAPABILITIES: Record<string, ChannelCapabilities> = {
  telegram: { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true },
  mock: { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true },
  http: { canReceiveInbound: false, canSend: true, canSendWithIdempotency: true },
};
const MAX_ESCALATION_CHANNELS = 64;
const MAX_ESCALATION_SUBSCRIPTIONS = 64;
const MAX_ESCALATION_FIELDS = 64;
const MAX_ESCALATION_STRING_BYTES = 8 * 1024;
const MAX_ESCALATION_TOTAL_UTF8_BYTES = 256 * 1024;
const MAX_ESCALATION_DEPTH = 8;
const MAX_ESCALATION_NODES = 2048;

type JsonObject = Record<string, unknown>;

function boundedText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_ESCALATION_STRING_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function boundedJson(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }, seen = new Set<object>()): boolean {
  if (++budget.nodes > MAX_ESCALATION_NODES) return false;
  if (value === null || typeof value === "boolean" || typeof value === "number") return typeof value !== "number" || Number.isFinite(value);
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value, "utf8");
    return budget.bytes <= MAX_ESCALATION_TOTAL_UTF8_BYTES
      && Buffer.byteLength(value, "utf8") <= MAX_ESCALATION_STRING_BYTES
      && !/[\u0000-\u001f\u007f]/u.test(value);
  }
  if (typeof value !== "object" || depth > MAX_ESCALATION_DEPTH || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.length <= MAX_ESCALATION_NODES
      && value.every((item) => boundedJson(item, depth + 1, budget, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(value);
    return keys.length <= MAX_ESCALATION_FIELDS
      && keys.every((key) => {
        budget.bytes += Buffer.byteLength(key, "utf8");
        return budget.bytes <= MAX_ESCALATION_TOTAL_UTF8_BYTES
          && boundedText(key)
          && boundedJson((value as JsonObject)[key], depth + 1, budget, seen);
      });
  } finally {
    seen.delete(value);
  }
}

function boundedStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as JsonObject;
  const prototype = Object.getPrototypeOf(object);
  return (prototype === Object.prototype || prototype === null)
    && Object.keys(object).length <= MAX_ESCALATION_FIELDS
    && Object.entries(object).every(([key, item]) => boundedText(key) && boundedText(item));
}

function invalidConfig(code: EscalationConfigInvalidCode, reason: string): EscalationConfigLoadResult {
  return { status: "invalid", code, reason };
}

/** Parse and normalize one exact, already-anchored escalation config byte sequence. */
export function parseEscalationConfigRaw(bytes: Uint8Array): EscalationConfigLoadResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalidConfig("malformed", "escalation.json is not valid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return invalidConfig("malformed", "escalation.json is not valid JSON");
  }
  return normalizeEscalationDocument(raw);
}

function normalizeEscalationDocument(value: unknown): EscalationConfigLoadResult {
  if (!value || typeof value !== "object" || Array.isArray(value) || !boundedJson(value)) {
    return invalidConfig("invalid_shape", "escalation config must be a bounded plain JSON object");
  }
  const source = value as JsonObject;
  if (Object.hasOwn(source, "adapter") && !boundedText(source.adapter)) return invalidConfig("invalid_shape", "adapter must be a bounded non-empty string");
  if (Object.hasOwn(source, "bidirectional") && typeof source.bidirectional !== "boolean") return invalidConfig("invalid_shape", "bidirectional must be boolean");
  for (const field of ["chatId", "name", "mode"] as const) {
    if (Object.hasOwn(source, field) && !boundedText(source[field])) return invalidConfig("invalid_shape", `${field} must be a bounded non-empty string`);
  }
  if (Object.hasOwn(source, "subscriptions")
    && (!Array.isArray(source.subscriptions) || source.subscriptions.length > MAX_ESCALATION_SUBSCRIPTIONS
      || !source.subscriptions.every((item) => boundedText(item))
      || new Set(source.subscriptions).size !== source.subscriptions.length)) {
    return invalidConfig("invalid_shape", "subscriptions must be a bounded unique string array");
  }
  if (Object.hasOwn(source, "fields") && !boundedStringMap(source.fields)) return invalidConfig("invalid_shape", "fields must be a bounded string map");
  const channelsValue = source.channels;
  if (channelsValue !== undefined) {
    if (!Array.isArray(channelsValue) || channelsValue.length > MAX_ESCALATION_CHANNELS) {
      return invalidConfig("invalid_shape", "channels must be a bounded array");
    }
    const channels: NormalizedChannelConfig[] = [];
    const seenKeys = new Set<string>();
    let primaryCount = 0;
    for (const entry of channelsValue) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalidConfig("invalid_shape", "channel entry must be an object");
      const raw = entry as JsonObject;
      const adapter = raw.adapter;
      if (!boundedText(adapter)) return invalidConfig("invalid_shape", "channel adapter must be a bounded non-empty string");
      for (const field of ["id", "name", "mode", "ackTarget", "chatId"] as const) {
        if (Object.hasOwn(raw, field) && !boundedText(raw[field])) return invalidConfig("invalid_shape", `channel ${field} must be a bounded non-empty string`);
      }
      if (Object.hasOwn(raw, "direction") && raw.direction !== "read-write" && raw.direction !== "read-only") return invalidConfig("invalid_shape", "channel direction is invalid");
      if (raw.primary === true && raw.direction !== "read-write") return invalidConfig("invalid_primary_direction", "primary channel must declare read-write direction");
      if (Object.hasOwn(raw, "primary") && typeof raw.primary !== "boolean") return invalidConfig("invalid_shape", "channel primary must be boolean");
      if (Object.hasOwn(raw, "subscriptions")
        && (!Array.isArray(raw.subscriptions) || raw.subscriptions.length > MAX_ESCALATION_SUBSCRIPTIONS
          || !raw.subscriptions.every((item) => boundedText(item))
          || new Set(raw.subscriptions).size !== raw.subscriptions.length)) return invalidConfig("invalid_shape", "channel subscriptions are invalid");
      if (Object.hasOwn(raw, "fields") && !boundedStringMap(raw.fields)) return invalidConfig("invalid_shape", "channel fields are invalid");
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      const key = `${adapter}\u0000${id}`;
      if (seenKeys.has(key)) return invalidConfig("duplicate_id", `duplicate effective channel id for adapter ${adapter}`);
      seenKeys.add(key);
      if (raw.primary === true && ++primaryCount > 1) return invalidConfig("duplicate_primary", "multiple explicit primary channels are not allowed");
      channels.push({
        ...raw,
        adapter,
        ...(Array.isArray(raw.subscriptions) ? { subscriptions: [...raw.subscriptions] as string[] } : {}),
        ...(raw.fields ? { fields: { ...(raw.fields as Record<string, string>) } } : {}),
      } as NormalizedChannelConfig);
    }
    return { status: "valid", config: { ...source, channels } as NormalizedEscalationConfig };
  }
  return { status: "valid", config: { ...source } as NormalizedEscalationConfig };
}

/** Typed fail-closed error for unsafe or invalid escalation configuration. */
export class EscalationConfigError extends Error {
  readonly code: "root_unavailable" | "unsafe" | "not_regular" | "limit" | "changed" | "invalid_primary";

  constructor(code: EscalationConfigError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EscalationConfigError";
    this.code = code;
  }
}

export interface LoadEscalationConfigOptions {
  /** Borrow a descriptor already pinned by the caller; otherwise own one. */
  pinnedRoot?: PinnedProjectRoot;
}
const MAX_ESCALATION_CONFIG_BYTES = 256 * 1024;
/**
 * Read `.omp/escalation.json` through a pinned descriptor. Missing config is
 * represented by `{status:"absent"}`; malformed or semantically invalid config
 * is represented by a typed `{status:"invalid", ...}` result.
 */
export function loadEscalationConfigRaw(cwd: string, options: LoadEscalationConfigOptions = {}): EscalationConfigLoadResult {
  const borrowed = options.pinnedRoot;
  const root = borrowed ?? PinnedProjectRoot.open(cwd);
  if (!root) return { status: "absent" };
  try {
    try {
      const read = root.readFile(".omp/escalation.json", { maxBytes: MAX_ESCALATION_CONFIG_BYTES });
      return parseEscalationConfigRaw(read.bytes);
    } catch (error) {
      if (error instanceof PinnedRootError && error.code === "not_found") return { status: "absent" };
      if (error instanceof PinnedRootError && error.code === "not_regular") throw new EscalationConfigError("not_regular", "escalation.json must be a regular file", { cause: error });
      if (error instanceof PinnedRootError && (error.code === "limit" || error.message.includes("bounded read limit"))) throw new EscalationConfigError("limit", "escalation.json exceeds the 256 KiB limit", { cause: error });
      if (error instanceof PinnedRootError && error.code === "changed") throw new EscalationConfigError("changed", "escalation.json changed during the bounded read", { cause: error });
      throw new EscalationConfigError("unsafe", "escalation.json could not be read through the pinned root", { cause: error });
    }
  } finally {
    if (!borrowed) root.close();
  }
}

/** Capability table for an adapter kind: explicit param wins, else built-in defaults. */
function capabilityOf(kind: string, capabilities?: Record<string, ChannelCapabilities>): ChannelCapabilities | undefined {
  if (capabilities) return capabilities[kind];
  return BUILTIN_CAPABILITIES[kind] ?? { canReceiveInbound: false, canSend: true, canSendWithIdempotency: false }; // unknown kind: push-only and not durable
}

/** Capability rule: declared ro never upgrades; declared rw requires inbound+outbound. */
function effectiveDirection(
  declared: ChannelDirection,
  kind: string,
  capabilities?: Record<string, ChannelCapabilities>,
): "rw" | "ro" {
  if (declared === "read-only") return "ro";
  const caps = capabilityOf(kind, capabilities);
  if (caps && !(caps.canReceiveInbound && caps.canSend)) return "ro";
  return "rw";
}

/** Legacy chatId lookup: nested `telegram.chatId` or top-level `chatId`. */
function legacyChatId(config: Record<string, unknown>): string | undefined {
  const nested = config.telegram as { chatId?: unknown } | undefined;
  if (nested && typeof nested.chatId === "string") return nested.chatId;
  if (typeof config.chatId === "string") return config.chatId;
  return undefined;
}

/** ackTarget passthrough for explicit entries: `ackTarget` or telegram `chatId`. */
function entryAckTarget(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.ackTarget === "string") return entry.ackTarget;
  if (entry.adapter === "telegram" && typeof entry.chatId === "string") return entry.chatId;
  return undefined;
}

/**
 * Normalize a raw escalation config into channel profiles.
 *
 * - `channels[]` present → one profile per entry (direction from the config,
 *   capability rule applied; primary = declared flag; ackTarget passthrough;
 *   subscriptions carried; effective `id` copied when the entry carries one).
 *   Any malformed entry, duplicate effective `(adapter,id)` key, or duplicate
 *   primary fails closed for the entire config — no valid subset is retained.
 * - else legacy single-adapter (`adapter` present) → exactly one profile:
 *   declared read-write for telegram or `bidirectional === true`, then
 *   capability-normalized (only adapters with send + inbound remain rw);
 *   otherwise read-only. primary: true; ackTarget from telegram chatId.
 * - else → [] (no channel).
 */
export function normalizeChannelConfigResult(
  input: Record<string, unknown> | EscalationConfigLoadResult | null,
  capabilities?: Record<string, ChannelCapabilities>,
): ChannelNormalizationResult {
  if (input === null) return { status: "absent" };
  let document: Record<string, unknown>;
  if (isEscalationConfigLoadResult(input)) {
    if (input.status === "absent") return { status: "absent" };
    if (input.status === "invalid") {
      return {
        status: "invalid",
        code: input.code === "malformed" ? "invalid_shape" : input.code,
        reason: input.reason,
      };
    }
    document = input.config;
  } else {
    document = input as Record<string, unknown>;
  }
  const channels = document.channels;
  if (Array.isArray(channels)) {
    const candidates: ChannelProfile[] = [];
    const seenKeys = new Set<string>();
    let primaryCount = 0;
    for (const entry of channels) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { status: "invalid", code: "invalid_shape", reason: "channel entry must be an object" };
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) return { status: "invalid", code: "invalid_shape", reason: "channel entry must be a plain object" };
      const raw = entry as Record<string, unknown>;
      const adapter = raw.adapter;
      const direction = raw.direction;
      if (typeof adapter !== "string" || !adapter.trim()
        || (direction !== "read-write" && direction !== "read-only")) return { status: "invalid", code: "invalid_shape", reason: "channel adapter and direction are required" };
      if (Object.hasOwn(raw, "id") && typeof raw.id !== "string") return { status: "invalid", code: "invalid_shape", reason: "channel id must be a string" };
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (Object.hasOwn(raw, "primary") && typeof raw.primary !== "boolean") return { status: "invalid", code: "invalid_shape", reason: "channel primary must be boolean" };
      if (Object.hasOwn(raw, "subscriptions")
        && (!Array.isArray(raw.subscriptions)
          || raw.subscriptions.length > MAX_ESCALATION_SUBSCRIPTIONS
          || !raw.subscriptions.every((s) => typeof s === "string" && boundedText(s))
          || new Set(raw.subscriptions).size !== raw.subscriptions.length)) return { status: "invalid", code: "invalid_shape", reason: "channel subscriptions are invalid" };
      if (raw.primary === true && direction !== "read-write") return { status: "invalid", code: "invalid_primary_direction", reason: "primary channel must declare read-write direction" };
      const key = `${adapter}\u0000${id}`;
      if (seenKeys.has(key)) return { status: "invalid", code: "duplicate_id", reason: `duplicate effective channel id for adapter ${adapter}` };
      seenKeys.add(key);
      if (raw.primary === true && ++primaryCount > 1) return { status: "invalid", code: "duplicate_primary", reason: "multiple explicit primary channels are not allowed" };
      const effective = effectiveDirection(direction, adapter, capabilities);
      if (raw.primary === true && effective !== "rw") return { status: "invalid", code: "invalid_primary_direction", reason: "primary channel must have effective read-write capabilities" };
      candidates.push({
        direction: effective,
        transport: adapter,
        adapter,
        ackTarget: entryAckTarget(raw),
        primary: raw.primary === true,
        subscriptions: Array.isArray(raw.subscriptions) ? [...raw.subscriptions] as string[] : undefined,
        ...(id.length > 0 ? { id } : {}),
      });
    }
    return { status: "valid", profiles: candidates };
  }
  if (channels !== undefined) return { status: "invalid", code: "invalid_shape", reason: "channels must be an array" };
  if (typeof document.adapter === "string" || document.bidirectional === true) {
    const adapter = typeof document.adapter === "string" ? document.adapter : undefined;
    const declared: ChannelDirection = adapter === "telegram" || document.bidirectional === true ? "read-write" : "read-only";
    return {
      status: "valid",
      profiles: [{
        direction: effectiveDirection(declared, adapter ?? "", capabilities),
        transport: adapter,
        adapter,
        ackTarget: adapter === "telegram" ? legacyChatId(document) : undefined,
        primary: true,
      }],
    };
  }
  return { status: "valid", profiles: [] };
}

/** Compatibility projection; routing callers must use normalizeChannelConfigResult. */
export function normalizeChannelConfig(
  input: Record<string, unknown> | EscalationConfigLoadResult | null,
  capabilities?: Record<string, ChannelCapabilities>,
): ChannelProfile[] {
  const result = normalizeChannelConfigResult(input, capabilities);
  return result.status === "valid" ? result.profiles : [];
}


function selectChannelProfile(profiles: ChannelProfile[]): ChannelProfile {
  const marked = profiles.filter((p) => p.primary === true);
  if (marked.length > 1) return { direction: "none" };
  const rw = profiles.filter((p) => p.direction === "rw");
  const ro = profiles.filter((p) => p.direction === "ro");
  const primary = (list: ChannelProfile[]) => list.find((p) => p.primary === true) ?? list[0];
  const chosen = marked[0] ?? primary(rw) ?? primary(ro);
  if (!chosen) return { direction: "none" };
  return {
    direction: chosen.direction,
    transport: chosen.transport,
    adapter: chosen.adapter,
    ...(chosen.id ? { id: chosen.id } : {}),
    ackTarget: chosen.ackTarget,
    primary: chosen.primary,
    subscriptions: chosen.subscriptions,
  };
}

/**
 * Resolve THE channel profile for a cwd. Exactly one explicit `primary` is
 * authoritative, including when it is RO; callers must fail closed rather
 * than silently selecting another transport when that primary is unusable.
 * With no explicit primary, the first deterministic capability-valid RW
 * profile is selected, followed by the first RO profile. Duplicate primaries
 * resolve to `{direction:"none"}`. Never throws.
 */
export function resolveChannelProfile(
  cwd: string,
  capabilities?: Record<string, ChannelCapabilities>,
): ChannelProfile {
  const loaded = loadEscalationConfigRaw(cwd);
  if (loaded.status !== "valid") return { direction: "none" };
  const normalized = normalizeChannelConfigResult(loaded, capabilities);
  if (normalized.status !== "valid") return { direction: "none" };
  return selectChannelProfile(normalized.profiles);
}


type PinnedRootPathEntryInfoLike = { kind: string; size: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number };

function sameConfigEntry(left: PinnedRootPathEntryInfoLike | null, right: PinnedRootPathEntryInfoLike | null): boolean {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind && left.size === right.size && left.dev === right.dev && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}



function assertLoadedChannelConfiguration(
  loaded: EscalationConfigLoadResult,
  capabilities?: Record<string, ChannelCapabilities>,
): { status: "valid"; profiles: ChannelProfile[] } {
  if (loaded.status === "invalid") {
    throw new EscalationConfigError("invalid_primary", `invalid escalation channel configuration: ${loaded.code}: ${loaded.reason}`);
  }
  if (loaded.status === "absent") return { status: "valid", profiles: [] };
  const normalized = normalizeChannelConfigResult(loaded, capabilities);
  if (normalized.status === "invalid") {
    throw new EscalationConfigError("invalid_primary", `invalid escalation channel configuration: ${normalized.code}: ${normalized.reason}`);
  }
  if (normalized.status === "absent") return { status: "valid", profiles: [] };
  const raw = loaded.config;
  if (!Array.isArray(raw.channels)) {
    const adapter = typeof raw.adapter === "string" ? raw.adapter : undefined;
    const declaredRw = adapter === "telegram" || raw.bidirectional === true;
    if (!declaredRw) return normalized;
    const profile = normalized.profiles[0];
    const durable = adapter ? capabilityOf(adapter, capabilities)?.canSendWithIdempotency === true : false;
    if (profile?.direction === "rw" && durable) return normalized;
    throw new EscalationConfigError("invalid_primary", `configured read-write primary "${adapter ?? "unknown"}" does not satisfy inbound, outbound, and idempotency capabilities`);
  }
  const primary = raw.channels.find((entry) => entry.primary === true);
  if (!primary) return normalized;
  const profile = normalized.profiles.find((candidate) => candidate.adapter === primary.adapter && (candidate.id ?? "") === (typeof primary.id === "string" ? primary.id.trim() : ""));
  const durable = capabilityOf(primary.adapter, capabilities)?.canSendWithIdempotency === true;
  if (profile?.direction === "rw" && durable) return normalized;
  throw new EscalationConfigError("invalid_primary", `configured read-write primary "${primary.adapter}" does not satisfy inbound, outbound, and idempotency capabilities`);
}

/** Load, validate, and route one bounded escalation configuration snapshot. */
export function resolveValidatedChannelProfile(
  cwd: string,
  capabilities?: Record<string, ChannelCapabilities>,
): ChannelProfile {
  const root = PinnedProjectRoot.open(cwd);
  if (!root) throw new EscalationConfigError("root_unavailable", "project root is unavailable for escalation configuration");
  try {
    const before = root.pathEntryInfo(".omp/escalation.json");
    const loaded = loadEscalationConfigRaw(cwd, { pinnedRoot: root });
    const validated = assertLoadedChannelConfiguration(loaded, capabilities);
    const after = root.pathEntryInfo(".omp/escalation.json");
    if (!sameConfigEntry(before, after) || !root.isStable()) throw new EscalationConfigError("changed", "escalation configuration changed during validation");
    return loaded.status === "absent" ? { direction: "none" } : selectChannelProfile(validated.profiles);
  } catch (error) {
    if (error instanceof EscalationConfigError) throw error;
    if (error instanceof PinnedRootError) {
      const code = error.code === "changed" ? "changed" : error.code === "not_regular" ? "not_regular" : error.code === "limit" ? "limit" : "unsafe";
      throw new EscalationConfigError(code, "escalation configuration could not be validated safely", { cause: error });
    }
    throw new EscalationConfigError("unsafe", "escalation configuration could not be validated safely", { cause: error });
  } finally {
    root.close();
  }
}

/**
 * Assert that an explicitly declared read-write primary still satisfies the
 * capability rule. Normalization intentionally retains its downgrade-to-RO
 * result for callers that only need a routing profile, but safety gates must
 * distinguish an invalid configured primary from a project with no RW channel.
 *
 * Legacy single-adapter configurations use the same declared-direction and
 * capability normalization as `channels[]`; a bidirectional HTTP/custom
 * config is therefore blocked unless the adapter is capability-registered.
 */
export function assertChannelConfiguration(
  cwd: string,
  capabilities?: Record<string, ChannelCapabilities>,
): void {
  const loaded = loadEscalationConfigRaw(cwd);
  if (loaded.status === "absent") return;
  if (loaded.status === "invalid") {
    throw new EscalationConfigError(
      "invalid_primary",
      `invalid escalation channel configuration: ${loaded.code}: ${loaded.reason}`,
    );
  }
  const raw = loaded.config;
  if (!Array.isArray(raw.channels)) {
    const adapter = typeof raw.adapter === "string" ? raw.adapter : undefined;
    const declaredRw = adapter === "telegram" || raw.bidirectional === true;
    if (!declaredRw) return;
    const normalized = normalizeChannelConfigResult(raw, capabilities);
    const profile = normalized.status === "valid" ? normalized.profiles[0] : undefined;
    const durable = adapter ? capabilityOf(adapter, capabilities)?.canSendWithIdempotency === true : false;
    if (profile?.direction === "rw" && durable) return;
    throw new EscalationConfigError(
      "invalid_primary",
      `configured read-write primary "${adapter ?? "unknown"}" does not satisfy inbound, outbound, and idempotency capabilities`,
    );
  }

  const entries = raw.channels;
  const marked = entries.filter((entry) => entry.primary === true);
  if (marked.length !== 1) return;
  const primary = marked[0]!;
  if (primary.direction !== "read-write" || typeof primary.adapter !== "string") return;
  const id = typeof primary.id === "string" ? primary.id.trim() : "";
  const normalized = normalizeChannelConfigResult(raw, capabilities);
  const profiles = normalized.status === "valid" ? normalized.profiles : [];
  const profile = profiles.find(
    (candidate) => candidate.adapter === primary.adapter && (candidate.id ?? "") === id,
  );
  const durable = capabilityOf(primary.adapter, capabilities)?.canSendWithIdempotency === true;
  if (profile?.direction === "rw" && durable) return;
  throw new EscalationConfigError(
    "invalid_primary",
    `configured read-write primary "${primary.adapter}" does not satisfy inbound, outbound, and idempotency capabilities`,
  );
}

/** True when the resolved channel is RW (validated inbound + outbound). */
export function hasRwPrimary(cwd: string, capabilities?: Record<string, ChannelCapabilities>): boolean {
  return resolveChannelProfile(cwd, capabilities).direction === "rw";
}
