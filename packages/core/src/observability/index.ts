/**
 * Public observability surface.
 *
 * Bundles import `registerObservabilityHooks(pi)` to wire the recorder into
 * the OMP extension event bus. The recorder itself is private; consumers
 * read state through `readObservabilityPointer(cwd, slug)` or the
 * `TeamState.observability` field written by the engine.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createObservabilityRecorderSession, createObservabilityRecorderSessionForCwd, closeObservabilityRecorderSession, closeObservabilityRecorderSessionForCwd, observabilityHooks, type ObservabilityRecorderOwnerIdentity, type ObservabilityRecorderSession } from "./hooks.js";

function sessionIdentityFromContext(ctx: unknown): { sessionId?: string; sessionFile?: string; generation?: string | number } {
  if (!ctx || typeof ctx !== "object") return {};
  const record = ctx as { sessionId?: unknown; sessionFile?: unknown; generation?: unknown; sessionManager?: { getSessionId?: () => unknown; getSessionFile?: () => unknown } };
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : typeof record.sessionManager?.getSessionId === "function" ? record.sessionManager.getSessionId() : undefined;
  const sessionFile = typeof record.sessionFile === "string" ? record.sessionFile : typeof record.sessionManager?.getSessionFile === "function" ? record.sessionManager.getSessionFile() : undefined;
  const generation = typeof record.generation === "string" || typeof record.generation === "number" ? record.generation : undefined;
  return { ...(typeof sessionId === "string" ? { sessionId } : {}), ...(typeof sessionFile === "string" ? { sessionFile } : {}), ...(generation !== undefined ? { generation } : {}) };
}

function shutdownMatchesSession(ctx: unknown, session: ObservabilityRecorderSession): boolean {
  if (!ctx || typeof ctx !== "object") return false;
  const { sessionId, sessionFile, generation } = sessionIdentityFromContext(ctx);
  const identity = session.identity;
  if (identity.sessionId !== undefined && sessionId !== identity.sessionId) return false;
  if (identity.sessionFile !== undefined && sessionFile !== identity.sessionFile) return false;
  if (identity.generation !== undefined && generation !== identity.generation) return false;
  return true;
}

export interface ObservabilityRegisterOptions {
  owner?: ObservabilityRecorderOwnerIdentity;
  /**
   * When false, the recorder skips wiring. Useful for tests or for bundles
   * that opt out of telemetry. Default: true.
   */
  enabled?: boolean;
  /**
   * Set false when the caller owns the `tool_call` hook and needs to attach
   * gate decisions to the single recorded event.
   */
  toolCall?: boolean;
}

export function registerObservabilityHooks(
  pi: ExtensionAPI,
  opts: ObservabilityRegisterOptions = {},
): (() => Promise<void>) | undefined {
  if (opts.enabled === false) return undefined;
  let session: ObservabilityRecorderSession | undefined = opts.owner ? createObservabilityRecorderSession(opts.owner) : undefined;
  pi.on("before_agent_start", (event: unknown, ctx: unknown) => {
    observabilityHooks.onBeforeAgentStart(event, ctx, session);
  });
  pi.on("agent_start", (event: unknown, ctx: unknown) => {
    observabilityHooks.onAgentStart(event, ctx, session);
  });
  pi.on("agent_end", (event: unknown, ctx: unknown) => {
    observabilityHooks.onAgentEnd(event, ctx, session);
  });
  if (opts.toolCall !== false) {
    pi.on("tool_call", (event: unknown, ctx: unknown) => {
      observabilityHooks.onToolCall(event, ctx, session);
    });
  }
  pi.on("tool_result", (event: unknown, ctx: unknown) => {
    observabilityHooks.onToolResult(event, ctx, session);
  });
  pi.on("session_start", (event: unknown, ctx: unknown) => {
    observabilityHooks.onSessionStart(event, ctx, session);
  });
  pi.on("session_stop", (event: unknown, ctx: unknown) => {
    observabilityHooks.onSessionStop(event, ctx, session);
  });
  pi.on("session_switch", async (_event: unknown, ctx: unknown) => {
    const cwd = typeof ctx === "object" && ctx !== null && "cwd" in ctx ? (ctx as { cwd?: unknown }).cwd : undefined;
    if (session && typeof cwd === "string" && cwd.length > 0) {
      await closeObservabilityRecorderSession(session);
      const next = createObservabilityRecorderSessionForCwd(cwd, sessionIdentityFromContext(ctx));
      if (next) session = next;
    }
  });
  pi.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
    if (!session || !shutdownMatchesSession(ctx, session)) return;
    const cwd = typeof ctx === "object" && ctx !== null && "cwd" in ctx ? (ctx as { cwd?: unknown }).cwd : undefined;
    if (typeof cwd !== "string" || cwd.length === 0) return;
    const matched = await closeObservabilityRecorderSessionForCwd(session, cwd);
    if (matched) await closeObservabilityRecorderSession(session);
  });
  return session ? (() => closeObservabilityRecorderSession(session!)) : undefined;
}

export { EventRecorder, rollupFromEvents, readObservabilityPointer } from "./recorder.js";
export { extractSkills } from "./skills.js";
export { recordStageTransition, recordArtifactWritten } from "./hooks.js";
export { recordToolCallAttempt } from "./hooks.js";
export type {
  ObservabilityEvent,
  ObservabilityPointer,
  ObservabilityRollup,
  EventKind,
} from "./events.js";
