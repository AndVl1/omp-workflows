/**
 * Public observability surface.
 *
 * Bundles import `registerObservabilityHooks(pi)` to wire the recorder into
 * the OMP extension event bus. The recorder itself is private; consumers read
 * canonical run telemetry through `readCanonicalObservabilityPointer` or the
 * `TeamState.observability` field written by the engine.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { observabilityHooks, setObservabilityRun } from "./hooks.js";

interface CapturedEventScope {
  cwd: string;
  runId: string;
  originSessionId?: string;
}

export interface ObservabilityRegisterOptions {
  /** When false, the recorder skips wiring. Default: true. */
  enabled?: boolean;
  /** Set false when the caller owns the `tool_call` hook. */
  toolCall?: boolean;
  /** Resolve the currently selected canonical run for ordinary host events. */
  getRunId?: (ctx: unknown, cwd: string) => string | undefined;
  /** Resolve an immutable run captured when a late callback was admitted. */
  getEventRunId?: (event: unknown, ctx: unknown, cwd: string) => string | undefined;
  /** Resolve an immutable callback workspace and run, normally for task results. */
  getEventScope?: (event: unknown, ctx: unknown, cwd: string) => CapturedEventScope | undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runIdFromContext(ctx: unknown): string | undefined {
  const context = recordValue(ctx);
  const state = recordValue(context?.state);
  return nonEmptyString(context?.runId)
    ?? nonEmptyString(context?.run_id)
    ?? nonEmptyString(state?.runId)
    ?? nonEmptyString(state?.run_id);
}

function runIdFromEvent(event: unknown): string | undefined {
  const value = recordValue(event);
  return nonEmptyString(value?.runId) ?? nonEmptyString(value?.run_id);
}

function actorFrom(value: unknown): string | undefined {
  const record = recordValue(value);
  return nonEmptyString(record?.actor) ?? nonEmptyString(record?.origin_actor) ?? nonEmptyString(record?.originActor);
}

function isWorkerEvent(event: unknown, ctx: unknown): boolean {
  return actorFrom(event) === "worker" || actorFrom(ctx) === "worker";
}

function sessionIdFrom(value: unknown): string | undefined {
  const record = recordValue(value);
  return nonEmptyString(record?.session_id) ?? nonEmptyString(record?.sessionId);
}

function sessionKey(event: unknown, ctx: unknown, cwd: string): string | undefined {
  const sessionId = sessionIdFrom(event) ?? sessionIdFrom(ctx);
  return sessionId ? `${cwd}|${sessionId}` : undefined;
}

export function registerObservabilityHooks(
  pi: ExtensionAPI,
  opts: ObservabilityRegisterOptions = {},
): void {
  if (opts.enabled === false) return;
  const admittedRunBySession = new Map<string, string>();

  /**
   * Capture once at event admission and pass a private context snapshot to the
   * recorder. No hook handler is allowed to resolve the controller again.
   */
  const captureContext = (event: unknown, ctx: unknown, eventType: string): unknown => {
    const context = recordValue(ctx);
    const cwd = nonEmptyString(context?.cwd);
    if (!cwd) return undefined;
    const eventRecord = recordValue(event);
    const eventBound = eventRecord?.toolName === "task"
      && nonEmptyString(eventRecord.toolCallId) !== undefined;
    const workerEvent = isWorkerEvent(event, ctx);
    const key = sessionKey(event, ctx, cwd);
    const sessionLifecycle = eventType === "session_start" || eventType === "session_stop";

    let scope: CapturedEventScope | undefined;
    try {
      scope = opts.getEventScope?.(event, ctx, cwd);
    } catch {
      // A resolver is trusted admission data. A resolver failure is an
      // unknown origin, never permission to fall back to the current run.
      return undefined;
    }
    if (scope) {
      if (!nonEmptyString(scope.cwd) || !nonEmptyString(scope.runId)) return undefined;
      if (sessionLifecycle && key) admittedRunBySession.set(key, scope.runId);
      return {
        ...context,
        cwd: scope.cwd,
        observabilityOriginBound: true,
        runId: scope.runId,
        ...(scope.originSessionId ? { originSessionId: scope.originSessionId } : {}),
      };
    }

    let immutableRunId: string | undefined;
    try {
      immutableRunId = opts.getEventRunId?.(event, ctx, cwd);
    } catch {
      immutableRunId = undefined;
    }
    immutableRunId = nonEmptyString(immutableRunId);
    if (eventBound || workerEvent) {
      // Native/worker callbacks are admitted only with a durable origin. A
      // current controller selection must never stand in for an unknown one.
      if (!immutableRunId) return undefined;
    }

    let runId = immutableRunId;
    if (!runId && eventType === "session_stop" && key) runId = admittedRunBySession.get(key);
    runId ??= runIdFromContext(ctx) ?? runIdFromEvent(event);
    let selectedAtAdmission = false;
    if (!runId && !workerEvent && !eventBound) {
      try {
        runId = nonEmptyString(opts.getRunId?.(ctx, cwd));
        selectedAtAdmission = runId !== undefined;
      } catch {
        runId = undefined;
      }
    }
    if (!runId) return undefined;

    if (selectedAtAdmission) setObservabilityRun(cwd, runId);
    if (sessionLifecycle && key) admittedRunBySession.set(key, runId);
    return {
      ...context,
      cwd,
      runId,
      ...(eventBound || workerEvent ? { observabilityOriginBound: true } : {}),
    };
  };

  pi.on("before_agent_start", (event: unknown, ctx: unknown) => {
    observabilityHooks.onBeforeAgentStart(event, captureContext(event, ctx, "before_agent_start"));
  });
  pi.on("agent_start", (event: unknown, ctx: unknown) => {
    observabilityHooks.onAgentStart(event, captureContext(event, ctx, "agent_start"));
  });
  pi.on("agent_end", (event: unknown, ctx: unknown) => {
    observabilityHooks.onAgentEnd(event, captureContext(event, ctx, "agent_end"));
  });
  if (opts.toolCall !== false) {
    pi.on("tool_call", (event: unknown, ctx: unknown) => {
      observabilityHooks.onToolCall(event, captureContext(event, ctx, "tool_call"));
    });
  }
  pi.on("tool_result", (event: unknown, ctx: unknown) => {
    observabilityHooks.onToolResult(event, captureContext(event, ctx, "tool_result"));
  });
  pi.on("session_start", (event: unknown, ctx: unknown) => {
    observabilityHooks.onSessionStart(event, captureContext(event, ctx, "session_start"));
  });
  pi.on("session_stop", (event: unknown, ctx: unknown) => {
    observabilityHooks.onSessionStop(event, captureContext(event, ctx, "session_stop"));
  });
}

export {
  EventRecorder,
  rollupFromEvents,
  readObservabilityPointer,
  readCanonicalObservabilityPointer,
} from "./recorder.js";
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
