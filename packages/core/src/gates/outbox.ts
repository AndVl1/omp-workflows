/**
 * CTO-safety outbox gate (core side).
 *
 * When a BIDIRECTIONAL escalation channel (telegram, or `bidirectional: true`)
 * is configured in `.omp/escalation.json`, ALL user communication in a CTO
 * run must go through the outbox (`outbox/<escId>.json` -> answers/), never
 * through the interactive `ask` tool — the channel is the only way the user
 * can answer while the run is detached.
 *
 * This is the core-level enforcement mirror of fullstack's
 * `createAskRedirectGate` (packages/fullstack/src/messenger-channel.ts) and
 * `isBidirectionalChannel` (packages/fullstack/src/adapters/registry.ts).
 * Core cannot import fullstack (package direction), so the channel
 * configuration is read through the shared pure normalizer (cto/channels.ts).
 * Both gates may coexist; double-blocking is harmless. Unlike the fullstack
 * gate, this one is NOT scoped to an active CTO run: a bidirectional channel
 * is by construction a detached run setup, so `ask` must be routed to the
 * outbox whenever the channel is configured.
 */

import { resolveChannelProfile } from "../cto/channels.js";

interface ToolCallEvent {
  toolName?: string;
  input?: unknown;
}

interface ToolCallContext {
  cwd: string;
}

export const OUTBOX_GATE_BLOCK_REASON =
  "cto-safety outbox gate: a bidirectional messenger channel is active (.omp/escalation.json). " +
  "Do NOT use ask — write the question as an escalation to `.work-state/cto/<runId>/outbox/<escId>.json` " +
  "(level question/decision, timeoutMs + default); the answer lands in `answers/<escId>.json` and the " +
  "CTO picks it up at the next checkpoint.";

/**
 * True when `.omp/escalation.json` resolves to a validated RW primary
 * channel (cto/channels.js normalizer). Legacy `adapter === "telegram"` and
 * `bidirectional === true` configs normalize to rw, so they still block ask;
 * explicit `channels[]` with a capability-validated "read-write" entry
 * behave identically. Never throws — a missing or malformed config resolves
 * to {direction:"none"} and returns false. Mirrors fullstack's
 * `isBidirectionalChannel` for the core-side gate (core cannot import
 * fullstack).
 */
export function hasBidirectionalChannel(cwd: string): boolean {
  return resolveChannelProfile(cwd).direction === "rw";
}

/**
 * `tool_call` gate: block the `ask` tool when a bidirectional channel is
 * configured. The `reason` is returned to the LLM, which then writes the
 * question to the outbox instead. Never throws.
 */
export function outboxEnforcementGate(
  event: ToolCallEvent,
  ctx: ToolCallContext,
): { block: true; reason: string } | undefined {
  try {
    if (event?.toolName !== "ask") return undefined;
    if (!hasBidirectionalChannel(ctx.cwd)) return undefined;
    return { block: true, reason: OUTBOX_GATE_BLOCK_REASON };
  } catch {
    return undefined;
  }
}
