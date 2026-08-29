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
 * configuration is resolved through the shared identity-bound resolver
 * (cto/channels.ts). Both gates may coexist; double-blocking is harmless.
 * Unlike the fullstack gate, this one is NOT scoped to an active CTO run: a
 * bidirectional channel is by construction a detached run setup, so `ask`
 * must be routed to the outbox after host identity validation.
 */

import { resolveBoundChannelProfile } from "../cto/channels.js";
import type { WorkflowRunIdentity } from "../workflow-v2/types.js";

interface ToolCallEvent {
  toolName?: string;
  input?: unknown;
}

interface ToolCallContext {
  readonly cwd: string;
  readonly run_identity?: WorkflowRunIdentity;
}

export const OUTBOX_GATE_BLOCK_REASON =
  "cto-safety outbox gate: a bidirectional messenger channel is active (.omp/escalation.json). " +
  "Do NOT use ask — write the question as an escalation to `.work-state/cto/<runId>/outbox/<escId>.json` " +
  "(level question/decision, timeoutMs + default); the answer lands in `answers/<escId>.json` and the " +
  "CTO picks it up at the next checkpoint.";

const OUTBOX_GATE_MIGRATION_REASON =
  "MIGRATION_REQUIRED: cto-safety outbox gate requires the exact persisted WorkflowRunIdentity; " +
  "re-admit the workflow through the protocol-v2 host before invoking ask.";

/**
 * True when `.omp/escalation.json` resolves to a validated RW primary
 * channel for the supplied workflow run identity. Legacy and malformed
 * configuration never become an authority; an invalid identity resolves to
 * false for this boolean convenience API.
 */
export function hasBidirectionalChannel(
  cwd: string,
  runIdentity: WorkflowRunIdentity,
): boolean {
  const resolved = resolveBoundChannelProfile(cwd, runIdentity);
  return resolved.ok && resolved.value.direction === "rw";
}

/**
 * `tool_call` gate: block the `ask` tool when a bidirectional channel is
 * configured. Missing or invalid run identity fails closed; other tools
 * remain untouched. Never throws.
 */
export function outboxEnforcementGate(
  event: ToolCallEvent,
  ctx: ToolCallContext,
): { block: true; reason: string } | undefined {
  try {
    if (event?.toolName !== "ask") return undefined;
    if (!ctx.run_identity) return { block: true, reason: OUTBOX_GATE_MIGRATION_REASON };

    const resolved = resolveBoundChannelProfile(ctx.cwd, ctx.run_identity);
    if (!resolved.ok) return { block: true, reason: OUTBOX_GATE_MIGRATION_REASON };
    if (resolved.value.direction !== "rw") return undefined;
    return { block: true, reason: OUTBOX_GATE_BLOCK_REASON };
  } catch {
    // An ask decision cannot proceed without an identity-bound channel
    // resolution. Fail closed if an unexpected boundary value throws.
    return { block: true, reason: OUTBOX_GATE_MIGRATION_REASON };
  }
}
