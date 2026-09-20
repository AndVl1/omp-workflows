/**
 * Public observability surface.
 *
 * Bundles import `registerObservabilityHooks(pi)` to wire the recorder into
 * the OMP extension event bus. The recorder itself is private; consumers
 * read state through `readObservabilityPointer(cwd, slug)` or the
 * `TeamState.observability` field written by the engine.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { observabilityHooks, setObservabilityRun } from "./hooks.js";

export interface ObservabilityRegisterOptions {
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
  /** Resolve the shared selected canonical run for each host event. */
  getRunId?: (ctx: unknown, cwd: string) => string | undefined;
  /** Resolve immutable callback identity, e.g. a late native task result. */
  getEventRunId?: (event: unknown, ctx: unknown, cwd: string) => string | undefined;
  /** Resolve the immutable callback workspace and run together. */
  getEventScope?: (event: unknown, ctx: unknown, cwd: string) => { cwd: string; runId: string; originSessionId?: string } | undefined;
}

export function registerObservabilityHooks(
  pi: ExtensionAPI,
  opts: ObservabilityRegisterOptions = {},
): void {
  if (opts.enabled === false) return;
  const withRun = (event: unknown, ctx: unknown): unknown => {
    const cwd = ctx && typeof ctx === "object" && typeof (ctx as { cwd?: unknown }).cwd === "string" ? (ctx as { cwd: string }).cwd : undefined;
    if (!cwd) return ctx;
    const eventRecord = event && typeof event === "object" ? event as { toolName?: unknown; toolCallId?: unknown } : {};
    const eventBound = eventRecord.toolName === "task" && typeof eventRecord.toolCallId === "string" && eventRecord.toolCallId.length > 0;
    const scope = opts.getEventScope?.(event, ctx, cwd);
    if (eventBound) {
      // Native callbacks are event-bound: an unknown origin is dropped rather
      // than inheriting the current host selection or callback workspace.
      if (!scope) return undefined;
      setObservabilityRun(scope.cwd, scope.runId);
      return ctx && typeof ctx === "object"
        ? { ...(ctx as Record<string, unknown>), cwd: scope.cwd, runId: scope.runId, ...(scope.originSessionId ? { originSessionId: scope.originSessionId } : {}) }
        : ctx;
    }
    const runId = opts.getRunId?.(ctx, cwd);
    setObservabilityRun(cwd, runId);
    return ctx && typeof ctx === "object" ? { ...(ctx as Record<string, unknown>), ...(runId ? { runId } : {}) } : ctx;
  };
  pi.on("before_agent_start", (event: unknown, ctx: unknown) => { observabilityHooks.onBeforeAgentStart(event, withRun(event, ctx)); });
  pi.on("agent_start", (event: unknown, ctx: unknown) => { observabilityHooks.onAgentStart(event, withRun(event, ctx)); });
  pi.on("agent_end", (event: unknown, ctx: unknown) => { observabilityHooks.onAgentEnd(event, withRun(event, ctx)); });
  if (opts.toolCall !== false) {
    pi.on("tool_call", (event: unknown, ctx: unknown) => { observabilityHooks.onToolCall(event, withRun(event, ctx)); });
  }
  pi.on("tool_result", (event: unknown, ctx: unknown) => { observabilityHooks.onToolResult(event, withRun(event, ctx)); });
  pi.on("session_start", (event: unknown, ctx: unknown) => { observabilityHooks.onSessionStart(event, withRun(event, ctx)); });
  pi.on("session_stop", (event: unknown, ctx: unknown) => { observabilityHooks.onSessionStop(event, withRun(event, ctx)); });
}

export { EventRecorder, rollupFromEvents, readObservabilityPointer, readCanonicalObservabilityPointer } from "./recorder.js";
export { setObservabilityRun } from "./hooks.js";
export { extractSkills } from "./skills.js";
export { recordStageTransition, recordArtifactWritten } from "./hooks.js";
export { recordToolCallAttempt } from "./hooks.js";
export type {
  ObservabilityEvent,
  ObservabilityPointer,
  ObservabilityRollup,
  EventKind,
} from "./events.js";
