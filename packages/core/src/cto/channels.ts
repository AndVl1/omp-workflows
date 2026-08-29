/**
 * Provider-neutral channel normalization for `.omp/escalation.json`.
 *
 * Raw config parsing and capability normalization are deliberately unbound:
 * they are observational helpers and can never authorize a notification.
 * `resolveBoundChannelProfile` is the only path that creates a ChannelProfile
 * usable by the run-bound control plane; it requires a complete
 * WorkflowRunIdentity and stamps that identity onto the profile.
 *
 * Legacy single-adapter configs (`{adapter,bidirectional,http,telegram}`) and
 * explicit multi-channel configs (`channels[]`) normalize to unbound profiles.
 * Resolution prefers the first RW primary, then the first RW profile, then
 * the first RO primary, then the first RO profile, and otherwise returns
 * `{direction:"none"}`.
 *
 * The only I/O is a node:fs read of the config file — everything else is
 * pure. Never throws.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelDirection, ChannelProfile } from "./types.js";
import { createDiagnostic, failureResult, successResult } from "../workflow-v2/diagnostics.js";
import { validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import type { DiagnosticResult, WorkflowRunIdentity } from "../workflow-v2/types.js";

/** Declared explicit channel entry (config_contract.explicit). */
export interface ExplicitChannelConfig {
  id: string;
  adapter: string;
  direction: ChannelDirection;
  primary?: boolean;
  subscriptions?: string[];
}
/** Internal normalized shape; a run identity is added only after binding. */
type UnboundChannelProfile = Omit<ChannelProfile, "run_identity">;
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
 * Normalize an unbound raw escalation config for observation only.
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
 *
 * The returned profiles intentionally carry no run identity. Callers that
 * authorize notifications must use `resolveBoundChannelProfile` instead.
 */
export function normalizeChannelConfig(
  config: Record<string, unknown> | null,
  capabilities?: Record<string, ChannelCapabilities>,
): UnboundChannelProfile[] {
  if (!config) return [];
  const channels = config.channels;
  if (Array.isArray(channels)) {
    // Parse every well-shaped entry into a candidate profile, carrying the
    // EFFECTIVE id (trimmed non-empty string; empty/missing -> ""). The id
    // is the per-entry handle createChannelSet uses to bind each profile to
    // its OWN config entry — without it, two same-kind entries collide on
    // `entryFor(kind)` (first match wins) and the second profile silently
    // gets the wrong entry's config.
    const candidates: Array<{ profile: UnboundChannelProfile; key: string }> = [];
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
 * Resolve one unbound channel profile for observation only.
 *
 * This function deliberately cannot authorize a notification: its return
 * value has no run identity. Use `resolveBoundChannelProfile` at every
 * notification/dispatch boundary.
 */
export function resolveChannelProfile(
  cwd: string,
  capabilities?: Record<string, ChannelCapabilities>,
): UnboundChannelProfile {
  const profiles = normalizeChannelConfig(loadEscalationConfigRaw(cwd), capabilities);
  const rw = profiles.filter((p) => p.direction === "rw");
  const ro = profiles.filter((p) => p.direction === "ro");
  const primary = (list: UnboundChannelProfile[]) => list.find((p) => p.primary === true) ?? list[0];
  const chosen = primary(rw) ?? primary(ro);
  if (!chosen) return { direction: "none" };
  return {
    direction: chosen.direction,
    transport: chosen.transport,
    adapter: chosen.adapter,
    ...(chosen.id !== undefined ? { id: chosen.id } : {}),
    ackTarget: chosen.ackTarget,
    primary: chosen.primary,
    subscriptions: chosen.subscriptions,
  };
}

/** Resolve one channel only after validating the owning workflow run identity. */
export function resolveBoundChannelProfile(
  cwd: string,
  runIdentity: WorkflowRunIdentity,
  capabilities?: Record<string, ChannelCapabilities>,
): DiagnosticResult<ChannelProfile> {
  const validated = validateWorkflowRunIdentity(runIdentity);
  if (!validated.ok) return validated;
  const unbound = resolveChannelProfile(cwd, capabilities);
  return successResult({
    ...unbound,
    run_identity: validated.value,
  });
}

function sameProjectIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id;
}

function sameRunIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return sameProjectIdentity(left, right)
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}


/** Check that a persisted channel profile still belongs to the current run. */
export function validateChannelProfileIdentity(
  profile: ChannelProfile,
  runIdentity: WorkflowRunIdentity,
): DiagnosticResult<ChannelProfile> {
  const expected = validateWorkflowRunIdentity(runIdentity);
  if (!expected.ok) return expected;

  const missing = failureResult<ChannelProfile>(createDiagnostic({
    code: "MIGRATION_REQUIRED",
    operation: "runtime.activate",
    evidence: { field: "channel_profile.run_identity" },
    remediation: "Recreate the channel profile through the selected workflow run.",
  }));
  const actualValue = typeof profile === "object" && profile !== null && "run_identity" in profile
    ? profile.run_identity
    : undefined;
  if (actualValue === undefined) return missing;
  const actual = validateWorkflowRunIdentity(actualValue);
  if (!actual.ok) return missing;

  if (!sameRunIdentity(actual.value, expected.value)) {
    return failureResult(createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "runtime.activate",
      evidence: { provider_id: expected.value.provider_id, field: "channel_profile.run_identity" },
      remediation: "Discard the stale channel profile and resolve a new one for the current workflow run.",
    }));
  }
  return successResult(profile);
}

/** True when the unbound observation resolves to an RW channel. */
export function hasRwPrimary(cwd: string, capabilities?: Record<string, ChannelCapabilities>): boolean {
  return resolveChannelProfile(cwd, capabilities).direction === "rw";
}
