/**
 * OMP hook handlers that feed the EventRecorder.
 *
 * The engine wires these from `registerTeamWorkflow` so every loaded bundle
 * (fullstack, custom) gets observability for free. Hooks are best-effort:
 * any failure is swallowed after a single console.warn so a buggy recorder
 * can never block a tool call.
 *
 * The recorder is cached per cwd; the cache survives across hook invocations
 * so the in-memory write queue can be drained deterministically by tests
 * via `flushRecorder(cwd)`. The recorder reads its own branch + active
 * feature slug from git + `.work-state/.active-feature` so it agrees with
 * the engine's notion of the "active feature".
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { EventRecorder } from "./recorder.js";
import { extractSkills } from "./skills.js";
import type { ObservabilityEvent, EventKind } from "./events.js";

const ACTIVE_FEATURE = ".active-feature";
const WORK_STATE_DIR = ".work-state";

/** Narrow the OMP extension context to the few fields we read. */
function ctxCwd(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const candidate = "cwd" in ctx ? (ctx as { cwd?: unknown }).cwd : undefined;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** Resolve branch via git (sync). stderr suppressed so non-git cwds don't spam. */
function currentBranch(cwd: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "(no git)";
  }
}

/**
 * Resolve the active feature slug. Falls back to "default" so the recorder
 * always has a place to write.
 */
function activeFeatureSlug(cwd: string): string {
  const workState = resolve(cwd, WORK_STATE_DIR);
  const active = resolve(workState, ACTIVE_FEATURE);
  if (!existsSync(active)) return "default";
  try {
    const realRoot = realpathSync(workState);
    const realPointer = realpathSync(active);
    const rel = relative(realRoot, realPointer);
    if (rel !== ACTIVE_FEATURE && (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))) return "default";
    const slug = readFileSync(active, "utf8").trim();
    return /^[A-Za-z0-9._-]+$/.test(slug) ? slug : "default";
  } catch {
    return "default";
  }
}

const recorderCache = new Map<string, EventRecorder>();

function getRecorder(cwd: string): EventRecorder {
  const cached = recorderCache.get(cwd);
  if (cached) return cached;
  const branch = currentBranch(cwd);
  const featureSlug = activeFeatureSlug(cwd);
  const rec = new EventRecorder({ cwd, branch, featureSlug });
  recorderCache.set(cwd, rec);
  return rec;
}

/**
 * Test helper: drain the in-memory write queue for a given cwd. Production
 * code never needs this; only tests use it to assert post-write state
 * without relying on real timers.
 */
export async function flushRecorder(cwd: string): Promise<void> {
  const rec = recorderCache.get(cwd);
  if (rec) await rec.flush();
}

function safeAppend(
  cwd: string,
  ev: Omit<ObservabilityEvent, "id" | "branch"> & { kind: EventKind },
): void {
  try {
    void getRecorder(cwd).append(ev).catch(() => { /* telemetry is best effort */ });
  } catch { /* telemetry is best effort */ }
}

export function recordToolCallAttempt(
  cwd: string,
  event: { toolName?: string; toolCallId?: string; input?: unknown },
  decision: "allowed" | "blocked",
  reason?: string,
): void {
  const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
  if (!toolName) return;
  const { subagent, taskChars } = toolName === "task" ? subagentFromTaskInput(event.input) : {};
  safeAppend(cwd, { kind: "tool_call", ts: new Date().toISOString(), toolName, toolCallId: event.toolCallId, subagent, subagentTaskChars: taskChars, gateDecision: decision, gateReason: reason });
}

/**
 * Best-effort stage transition event (additive, session-state-visualization).
 * Called by the engine's state/team writers; NEVER throws and never blocks
 * the underlying write. Agent-driven writes bypass these hooks entirely —
 * report assembly falls back to artifact mtime / state.updated_at.
 */
export function recordStageTransition(
  cwd: string,
  opts: { stageId: string; stageStatus?: string; runId?: string; ts?: string },
): void {
  safeAppend(cwd, {
    kind: "stage_transition",
    ts: opts.ts ?? new Date().toISOString(),
    stageId: opts.stageId,
    stageStatus: opts.stageStatus,
    runId: opts.runId,
  });
}

/**
 * Best-effort artifact write event (additive, session-state-visualization).
 * Same guarantees as {@link recordStageTransition}.
 */
export function recordArtifactWritten(
  cwd: string,
  opts: { artifactId: string; artifactPath?: string; artifactBytes?: number; runId?: string; ts?: string },
): void {
  safeAppend(cwd, {
    kind: "artifact_written",
    ts: opts.ts ?? new Date().toISOString(),
    artifactId: opts.artifactId,
    artifactPath: opts.artifactPath,
    artifactBytes: opts.artifactBytes,
    runId: opts.runId,
  });
}

/** Approximate char count of a value (matches what OMP's task tool sends). */
function approxChars(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * Pull `agent` from a `task` tool call input. The OMP task tool accepts
 * either `agent: "name"` (single spawn) or `tasks: [{agent: "name", task: "..."}]`
 * (parallel batch). For batch spawns, we count only the first agent in the
 * rollup per event — the full batch roster is in the OMP session jsonl.
 */
function subagentFromTaskInput(input: unknown): { subagent?: string; taskChars?: number } {
  if (!input || typeof input !== "object") return {};
  const obj = input as Record<string, unknown>;
  if (typeof obj.agent === "string") {
    return {
      subagent: obj.agent,
      taskChars: approxChars(obj.task),
    };
  }
  if (Array.isArray(obj.tasks) && obj.tasks[0] && typeof obj.tasks[0] === "object") {
    const first = obj.tasks[0] as Record<string, unknown>;
    if (typeof first.agent === "string") {
      return {
        subagent: first.agent,
        taskChars: approxChars(first.task),
      };
    }
  }
  return {};
}

export interface HookHandlers {
  onBeforeAgentStart(event: unknown, ctx: unknown): void;
  onAgentStart(event: unknown, ctx: unknown): void;
  onAgentEnd(event: unknown, ctx: unknown): void;
  onToolCall(event: unknown, ctx: unknown): void;
  onToolResult(event: unknown, ctx: unknown): void;
  onSessionStart(event: unknown, ctx: unknown): void;
  onSessionStop(event: unknown, ctx: unknown): void;
}

export const observabilityHooks: HookHandlers = {
  onBeforeAgentStart(event, ctx) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    const e = event as { systemPrompt?: string[] } | undefined;
    const skills = e?.systemPrompt ? extractSkills(e.systemPrompt) : [];
    safeAppend(cwd, {
      kind: "before_agent_start",
      ts: new Date().toISOString(),
      skills,
    });
  },
  onAgentStart(_event, ctx) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    safeAppend(cwd, {
      kind: "agent_start",
      ts: new Date().toISOString(),
    });
  },
  onAgentEnd(event, ctx) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    const e = event as { messages?: unknown[] } | undefined;
    safeAppend(cwd, {
      kind: "agent_end",
      ts: new Date().toISOString(),
      messageCount: Array.isArray(e?.messages) ? e.messages.length : 0,
    });
  },
  onToolCall(event, ctx) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    const e = event as { toolName?: string; toolCallId?: string; input?: unknown } | undefined;
    const toolName = typeof e?.toolName === "string" ? e.toolName : undefined;
    if (!toolName) return;
    const { subagent, taskChars } = toolName === "task" ? subagentFromTaskInput(e?.input) : {};
    safeAppend(cwd, {
      kind: "tool_call",
      ts: new Date().toISOString(),
      toolName,
      toolCallId: e?.toolCallId,
      subagent,
      subagentTaskChars: taskChars,
    });
  },
  onToolResult(event, ctx) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    const e = event as { toolName?: string; toolCallId?: string; isError?: boolean } | undefined;
    if (typeof e?.toolName !== "string") return;
    safeAppend(cwd, {
      kind: "tool_result",
      ts: new Date().toISOString(),
      toolName: e.toolName,
      toolCallId: e.toolCallId,
      isError: e?.isError === true,
    });
  },
  onSessionStart(event, ctx) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    // SessionStartEvent has no payload beyond `type`; ts from runtime.
    safeAppend(cwd, {
      kind: "session_start",
      ts: new Date().toISOString(),
    });
    void event;
  },
  onSessionStop(event, ctx) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    const e = event as { session_id?: string; turn_id?: number } | undefined;
    safeAppend(cwd, {
      kind: "session_stop",
      ts: new Date().toISOString(),
      sessionId: typeof e?.session_id === "string" ? e?.session_id : undefined,
    });
  },
};
/** Re-export so consumers can read the pointer cheaply. */
export { readObservabilityPointer } from "./recorder.js";
