/**
 * Messenger-channel mode detection + `ask` redirect gate.
 *
 * When a validated RW escalation channel (telegram, or a channel whose
 * adapter kind has inbound+outbound capabilities) is configured
 * (`.omp/escalation.json`), ALL user communication in a CTO run must go
 * through the messenger (outbox -> answers/), never through the interactive
 * `ask` tool. This module:
 *   - `channelMode(cwd)` — "telegram" | "http" | null (cached).
 *   - `createAskRedirectGate()` — a `tool_call` hook that BLOCKS `ask` while
 *     a capability-validated RW primary AND an active CTO run exist,
 *     returning the outbox contract as the reason (the LLM sees it and
 *     routes the question).
 *
 * The gate is deliberately scoped to active CTO runs: outside a run, normal
 * interactive work keeps `ask` working even in projects with a channel.
 * Terminal/RO-only modes keep `ask` as the fallback (no validated RW
 * primary -> no redirect). The gate is CAPABILITY-validated (core
 * `hasRwPrimary`): a declared `bidirectional` flag is no longer sufficient
 * on its own for explicit `channels[]` entries — http has no inbound path,
 * so a declared-rw http entry downgrades to ro and never blocks ask.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findActiveCtoRun, hasRwPrimary } from "@andvl1/omp-workflows-core";

export type ChannelMode = "telegram" | "http" | null;

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; mode: ChannelMode }>();

/** Resolve the configured channel mode for a cwd (cached, never throws). */
export function channelMode(cwd: string): ChannelMode {
  const now = Date.now();
  const hit = cache.get(cwd);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.mode;
  let mode: ChannelMode = null;
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ".omp", "escalation.json"), "utf8")) as { adapter?: string };
    if (raw?.adapter === "telegram" || raw?.adapter === "http") mode = raw.adapter;
  } catch {
    // missing/malformed — no channel
  }
  cache.set(cwd, { at: now, mode });
  return mode;
}

/** Clear the cached channel mode (tests, config reloads). */
export function clearChannelCache(): void {
  cache.clear();
}

export { isBidirectionalChannel } from "./adapters/registry.js";

/**
 * `tool_call` hook: block the `ask` tool when a capability-validated RW
 * primary is configured AND a CTO run is active. The `reason` is returned
 * to the LLM, which then writes the question to the outbox instead.
 */
export function createAskRedirectGate(): (
  event: { toolName?: string },
  ctx: { cwd: string },
) => { block: boolean; reason: string } | undefined {
  return (event, ctx) => {
    try {
      if (event?.toolName !== "ask") return undefined;
      if (!hasRwPrimary(ctx.cwd)) return undefined;
      if (!findActiveCtoRun(ctx.cwd)) return undefined;
      return {
        block: true,
        reason:
          "messenger-mode: a bidirectional messenger channel is active in this CTO run. Do NOT use ask — " +
          "write the question as an escalation to `.work-state/cto/<runId>/outbox/<escId>.json` " +
          "(level question/decision, timeoutMs + default); the answer will land in `answers/<escId>.json` " +
          "and you pick it up at the next checkpoint.",
      };
    } catch {
      return undefined;
    }
  };
}
