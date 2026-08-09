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
 * The only I/O is a node:fs read of the config file — everything else is
 * pure. Never throws.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelDirection, ChannelProfile } from "./types.js";

/** Declared explicit channel entry (config_contract.explicit). */
export interface ExplicitChannelConfig {
  id: string;
  adapter: string;
  direction: ChannelDirection;
  primary?: boolean;
  subscriptions?: string[];
}

/** Adapter-kind capabilities (architecture-2: direction derives from which optional methods are implemented). */
export interface ChannelCapabilities {
  /** Implements pollOnce/setPlainMessageHandler (inbound). */
  canReceiveInbound: boolean;
  /** Implements send (outbound). */
  canSend: boolean;
}

/** Built-in capability defaults — used ONLY when no capabilities param is supplied. */
const BUILTIN_CAPABILITIES: Record<string, ChannelCapabilities> = {
  telegram: { canReceiveInbound: true, canSend: true },
  mock: { canReceiveInbound: true, canSend: true },
  http: { canReceiveInbound: false, canSend: true },
};

/**
 * Read `.omp/escalation.json` as a raw object. Missing file, unreadable path
 * or malformed JSON → null. Never throws.
 */
export function loadEscalationConfigRaw(cwd: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ".omp", "escalation.json"), "utf8")) as unknown;
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Capability table for an adapter kind: explicit param wins, else built-in defaults. */
function capabilityOf(kind: string, capabilities?: Record<string, ChannelCapabilities>): ChannelCapabilities | undefined {
  if (capabilities) return capabilities[kind];
  return BUILTIN_CAPABILITIES[kind] ?? { canReceiveInbound: false, canSend: true }; // unknown kind: push-only
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
 *   Malformed entries are skipped. AMBIGUITY REJECTION (fail-closed): a group
 *   of >=2 same-kind entries sharing the same effective id (id-less
 *   duplicates or duplicate ids) is excluded ENTIRELY — ambiguous same-kind
 *   channels are never silently colliding; a single id-less entry per kind
 *   stays.
 * - else legacy single-adapter (`adapter` present) → exactly one profile:
 *   telegram or `bidirectional === true` → "rw"; otherwise (http push-only or
 *   unknown adapter) → "ro". primary: true; ackTarget from telegram chatId.
 * - else → [] (no channel).
 */
export function normalizeChannelConfig(
  config: Record<string, unknown> | null,
  capabilities?: Record<string, ChannelCapabilities>,
): ChannelProfile[] {
  if (!config) return [];
  const channels = config.channels;
  if (Array.isArray(channels)) {
    // Parse every well-shaped entry into a candidate profile, carrying the
    // EFFECTIVE id (trimmed non-empty string; empty/missing -> ""). The id
    // is the per-entry handle createChannelSet uses to bind each profile to
    // its OWN config entry — without it, two same-kind entries collide on
    // `entryFor(kind)` (first match wins) and the second profile silently
    // gets the wrong entry's config.
    const candidates: Array<{ profile: ChannelProfile; key: string }> = [];
    for (const entry of channels) {
      if (!entry || typeof entry !== "object") continue;
      const raw = entry as Record<string, unknown>;
      const adapter = typeof raw.adapter === "string" ? raw.adapter : undefined;
      const direction = raw.direction;
      if (!adapter || (direction !== "read-write" && direction !== "read-only")) continue;
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      candidates.push({
        profile: {
          direction: effectiveDirection(direction, adapter, capabilities),
          transport: adapter,
          adapter,
          ackTarget: entryAckTarget(raw),
          primary: raw.primary === true,
          subscriptions: Array.isArray(raw.subscriptions) ? (raw.subscriptions as string[]).filter((s) => typeof s === "string") : undefined,
          ...(id.length > 0 ? { id } : {}),
        },
        key: `${adapter}\u0000${id}`,
      });
    }
    // Ambiguity rejection (fail-closed): group by (adapter kind, effective
    // id). A group of >=2 same-kind entries sharing the SAME effective id is
    // ambiguous — id-less duplicates (no handle to tell them apart) or
    // duplicate ids (colliding handles) — and every entry of such a group is
    // EXCLUDED, never silently bound to the wrong config. A single id-less
    // entry per kind stays (id-less legacy fallback preserved).
    const groupSizes = new Map<string, number>();
    for (const { key } of candidates) groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
    return candidates.filter(({ key }) => (groupSizes.get(key) ?? 0) < 2).map(({ profile }) => profile);
  }
  if (typeof config.adapter === "string" || config.bidirectional === true) {
    const adapter = typeof config.adapter === "string" ? config.adapter : undefined;
    const bidirectional = config.bidirectional === true;
    const rw = adapter === "telegram" || bidirectional;
    return [
      {
        direction: rw ? "rw" : "ro",
        transport: adapter,
        adapter,
        ackTarget: adapter === "telegram" ? legacyChatId(config) : undefined,
        primary: true,
      },
    ];
  }
  return [];
}

/**
 * Resolve THE channel profile for a cwd: first RW profile (primary preferred)
 * → {direction:"rw", ...}; else first RO profile → {direction:"ro", ...};
 * else {direction:"none"}. Never throws.
 */
export function resolveChannelProfile(
  cwd: string,
  capabilities?: Record<string, ChannelCapabilities>,
): ChannelProfile {
  const profiles = normalizeChannelConfig(loadEscalationConfigRaw(cwd), capabilities);
  const rw = profiles.filter((p) => p.direction === "rw");
  const ro = profiles.filter((p) => p.direction === "ro");
  const primary = (list: ChannelProfile[]) => list.find((p) => p.primary === true) ?? list[0];
  const chosen = primary(rw) ?? primary(ro);
  if (!chosen) return { direction: "none" };
  return {
    direction: chosen.direction,
    transport: chosen.transport,
    adapter: chosen.adapter,
    ackTarget: chosen.ackTarget,
    primary: chosen.primary,
    subscriptions: chosen.subscriptions,
  };
}

/** True when the resolved channel is RW (validated inbound + outbound). */
export function hasRwPrimary(cwd: string, capabilities?: Record<string, ChannelCapabilities>): boolean {
  return resolveChannelProfile(cwd, capabilities).direction === "rw";
}
