/**
 * Public observability surface.
 *
 * Bundles import `registerObservabilityHooks(pi)` to wire the recorder into
 * the OMP extension event bus. The recorder itself is private; consumers
 * read state through `readObservabilityPointer(cwd, slug)` or the
 * `TeamState.observability` field written by the engine.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { observabilityHooks } from "./hooks.js";

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
}

export function registerObservabilityHooks(
  pi: ExtensionAPI,
  opts: ObservabilityRegisterOptions = {},
): void {
  if (opts.enabled === false) return;
  pi.on("before_agent_start", (event: unknown, ctx: unknown) => {
    observabilityHooks.onBeforeAgentStart(event, ctx);
  });
  pi.on("agent_start", (event: unknown, ctx: unknown) => {
    observabilityHooks.onAgentStart(event, ctx);
  });
  pi.on("agent_end", (event: unknown, ctx: unknown) => {
    observabilityHooks.onAgentEnd(event, ctx);
  });
  if (opts.toolCall !== false) {
    pi.on("tool_call", (event: unknown, ctx: unknown) => {
      observabilityHooks.onToolCall(event, ctx);
    });
  }
  pi.on("tool_result", (event: unknown, ctx: unknown) => {
    observabilityHooks.onToolResult(event, ctx);
  });
  pi.on("session_start", (event: unknown, ctx: unknown) => {
    observabilityHooks.onSessionStart(event, ctx);
  });
  pi.on("session_stop", (event: unknown, ctx: unknown) => {
    observabilityHooks.onSessionStop(event, ctx);
  });
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
