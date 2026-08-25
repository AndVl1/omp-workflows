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
import type {
  ObservabilityArtifactSummary,
  ObservabilityEvent,
  ObservabilitySignalFields,
  EventKind,
} from "./events.js";
import type {
  CompletionEnvelope,
  CompletionOutcome,
  CompletionTerminalSignal,
  PendingReason,
  WorkIdentity,
} from "../engine/types.js";

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
  const reject = (error: unknown): void => {
    const reason = error instanceof Error && error.message ? error.message : "telemetry write rejected";
    console.warn(`[observability] ${reason}`);
  };
  try {
    void getRecorder(cwd).append(ev).catch(reject);
  } catch (error) {
    reject(error);
  }
}

export function recordToolCallAttempt(
  cwd: string,
  event: { toolName?: string; toolCallId?: string; input?: unknown } & Partial<ObservabilitySignalFields>,
  decision: "allowed" | "blocked",
  reason?: string,
): void {
  const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
  if (!toolName) return;
  const { subagent, taskChars } = toolName === "task" ? subagentFromTaskInput(event.input) : {};
  safeAppend(cwd, {
    ...signalMetadata(event, undefined),
    kind: "tool_call",
    ts: new Date().toISOString(),
    toolName,
    toolCallId: event.toolCallId,
    subagent,
    subagentTaskChars: taskChars,
    gateDecision: decision,
    gateReason: reason,
  });
}

/**
 * Best-effort stage transition event (additive, session-state-visualization).
 * Called by the engine's state/team writers; NEVER throws and never blocks
 * the underlying write. Agent-driven writes bypass these hooks entirely —
 * report assembly falls back to artifact mtime / state.updated_at.
 */
export function recordStageTransition(
  cwd: string,
  opts: { stageId: string; stageStatus?: string; runId?: string; ts?: string } & Partial<ObservabilitySignalFields>,
): void {
  safeAppend(cwd, {
    ...signalMetadata(opts, undefined),
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
  opts: {
    artifactId: string;
    artifactPath?: string;
    artifactBytes?: number;
    artifactSha256?: string;
    runId?: string;
    ts?: string;
  } & Partial<ObservabilitySignalFields>,
): void {
  safeAppend(cwd, {
    ...signalMetadata(opts, undefined),
    kind: "artifact_written",
    ts: opts.ts ?? new Date().toISOString(),
    artifactId: opts.artifactId,
    artifactPath: opts.artifactPath,
    artifactBytes: opts.artifactBytes,
    artifactSha256: opts.artifactSha256,
    runId: opts.runId,
  });
}

/** Emit a neutral provider lifecycle state without blocking the caller. */
export function recordWorkPending(
  cwd: string,
  opts: { pending_reason: PendingReason; ts?: string } & Partial<ObservabilitySignalFields>,
): void {
  safeAppend(cwd, {
    ...signalMetadata(opts, undefined),
    kind: "work_pending",
    ts: opts.ts ?? new Date().toISOString(),
    pending_reason: opts.pending_reason,
    status: opts.status ?? "pending",
    outcome: opts.outcome ?? "pending",
  });
}

/** Emit a terminal provider/contract state with identity-bound evidence. */
export function recordWorkTerminal(
  cwd: string,
  opts: {
    terminal_signal: CompletionTerminalSignal;
    outcome: CompletionOutcome;
    ts?: string;
  } & Partial<ObservabilitySignalFields>,
): void {
  safeAppend(cwd, {
    ...signalMetadata(opts, undefined),
    kind: "work_terminal",
    ts: opts.ts ?? new Date().toISOString(),
    terminal_signal: opts.terminal_signal,
    outcome: opts.outcome,
    status: opts.status ?? opts.outcome,
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
function recordLike(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sourceRecords(event: unknown, ctx: unknown): Record<string, unknown>[] {
  const context = recordLike(ctx);
  const state = recordLike(context?.state);
  return [recordLike(event), context, state].filter((value): value is Record<string, unknown> => Boolean(value));
}

function firstField(sources: ReadonlyArray<Record<string, unknown>>, ...keys: string[]): unknown {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined) return source[key];
    }
  }
  return undefined;
}

function signalMetadata(event: unknown, ctx: unknown): ObservabilitySignalFields {
  const sources = sourceRecords(event, ctx);
  const rawEnvelope = firstField(sources, "completion_envelope", "completionEnvelope");
  const envelope = recordLike(rawEnvelope);
  const pending = recordLike(firstField(sources, "pending"));
  const identityValue = firstField(sources, "work_identity", "workIdentity", "identity") ?? envelope?.identity;
  const metadata: ObservabilitySignalFields = {};
  if (identityValue && typeof identityValue === "object") metadata.work_identity = identityValue as WorkIdentity;
  const capabilityEpoch = firstField(sources, "capability_epoch", "capabilityEpoch") ?? (recordLike(identityValue)?.capability_epoch);
  if (typeof capabilityEpoch === "string") metadata.capability_epoch = capabilityEpoch;
  const profileHash = firstField(sources, "profile_hash", "profileHash");
  if (typeof profileHash === "string") metadata.profile_hash = profileHash;
  const policyHash = firstField(sources, "policy_hash", "policyHash");
  if (typeof policyHash === "string") metadata.policy_hash = policyHash;
  const pendingReason = firstField(sources, "pending_reason", "pendingReason") ?? pending?.pending_reason;
  if (typeof pendingReason === "string") metadata.pending_reason = pendingReason as PendingReason;
  const terminalSignal = firstField(sources, "terminal_signal", "terminalSignal") ?? envelope?.terminal_signal;
  if (terminalSignal === null || typeof terminalSignal === "string") metadata.terminal_signal = terminalSignal as CompletionTerminalSignal | null;
  const outcome = firstField(sources, "outcome") ?? envelope?.outcome;
  if (outcome === "pending" || outcome === "succeeded" || outcome === "failed" || outcome === "cancelled") metadata.outcome = outcome as CompletionOutcome;
  const status = firstField(sources, "status") ?? pending?.status;
  if (status === "authorized" || status === "running" || status === "pending" || status === "succeeded" || status === "failed" || status === "cancelled") metadata.status = status;
  const providerRef = firstField(sources, "provider_ref", "providerRef");
  if (typeof providerRef === "string") metadata.provider_ref = providerRef;
  const retryOf = firstField(sources, "retry_of", "retryOf") ?? pending?.retry_of;
  if (retryOf === null || typeof retryOf === "string") metadata.retry_of = retryOf;
  if (rawEnvelope && typeof rawEnvelope === "object") metadata.completion_envelope = rawEnvelope as CompletionEnvelope;
  const artifactSummaries = firstField(sources, "artifact_summaries", "artifactSummaries");
  if (Array.isArray(artifactSummaries)) metadata.artifact_summaries = artifactSummaries as ObservabilityArtifactSummary[];
  const idempotencyKey = firstField(sources, "idempotency_key", "idempotencyKey");
  if (typeof idempotencyKey === "string") metadata.idempotency_key = idempotencyKey;
  return metadata;
}

function sessionIdFrom(event: unknown, ctx: unknown): string | undefined {
  const value = firstField(sourceRecords(event, ctx), "session_id", "sessionId");
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
      ...signalMetadata(event, ctx),
      kind: "before_agent_start",
      ts: new Date().toISOString(),
      skills,
    });
  },
  onAgentStart(event, ctx) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    safeAppend(cwd, {
      ...signalMetadata(event, ctx),
      kind: "agent_start",
      ts: new Date().toISOString(),
    });
  },
  onAgentEnd(event, ctx) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    const e = event as { messages?: unknown[] } | undefined;
    safeAppend(cwd, {
      ...signalMetadata(event, ctx),
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
      ...signalMetadata(event, ctx),
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
      ...signalMetadata(event, ctx),
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
    safeAppend(cwd, {
      ...signalMetadata(event, ctx),
      kind: "session_start",
      ts: new Date().toISOString(),
      sessionId: sessionIdFrom(event, ctx),
    });
  },
  onSessionStop(event, ctx) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    safeAppend(cwd, {
      ...signalMetadata(event, ctx),
      kind: "session_stop",
      ts: new Date().toISOString(),
      sessionId: sessionIdFrom(event, ctx),
    });
  },
};
/** Re-export so consumers can read the pointer cheaply. */
export { readObservabilityPointer } from "./recorder.js";
