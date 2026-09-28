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
 *     a capability-validated RW primary and the originating host session's
 *     owned active CTO run exist, returning the run-scoped outbox contract.
 *
 * The gate is deliberately scoped to an explicit host session and owned CTO
 * run: outside that binding, normal interactive work keeps `ask` working even
 * in projects with a channel. Terminal/RO-only modes keep `ask` as the
 * fallback (no validated RW primary -> no redirect). The gate is
 * CAPABILITY-validated (core `hasRwPrimary`): a declared `bidirectional` flag
 * is no longer sufficient on its own for explicit `channels[]` entries —
 * http has no inbound path, so a declared-rw http entry downgrades to ro and
 * never blocks ask.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasRwPrimary, type CtoClaimScope } from "@andvl1/omp-workflows-core";

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

export type AskRedirectClaimResolver = (ctx: unknown, cwd: string) => CtoClaimScope | undefined;

/**
 * `tool_call` hook: block the `ask` tool only when the bundle supplies the
 * exact current CTO claim for the originating host session. A resolver is
 * required so this module cannot infer authority from a latest active run,
 * raw model fields, or persisted `owner_session` data.
 */
export function createAskRedirectGate(
  resolveClaim?: AskRedirectClaimResolver,
): (
  event: { toolName?: string },
  ctx: { cwd: string; session_id?: string; sessionId?: string },
) => { block: boolean; reason: string } | undefined {
  return (event, ctx) => {
    try {
      if (event?.toolName !== "ask") return undefined;
      if (!hasRwPrimary(ctx.cwd)) return undefined;
      const claim = resolveClaim?.(ctx, ctx.cwd);
      if (!claim) return undefined;
      return {
        block: true,
        reason:
          "messenger-mode: a bidirectional messenger channel is active in this owned CTO run. Do NOT use ask — " +
          `write the question as an escalation to \`.work-state/cto/${claim.run_id}/outbox/<escId>.json\` ` +
          "(level question/decision, timeoutMs + default); the answer will land in " +
          `\`.work-state/cto/${claim.run_id}/answers/<escId>.json\`. Use the real \`read\` tool on that exact file at reconciliation; ` +
          "only a dispatcher-recorded pre-send rejection is automatically retryable, while ambiguous delivery keeps the original files for explicit reconciliation.",
      };
    } catch {
      return undefined;
    }
  };
}
