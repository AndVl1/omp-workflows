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

import { execSync } from "node:child_process";
import { PinnedProjectRoot, PinnedRootError } from "../specification/pinned-root.js";
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
const ACTIVE_FEATURE_MAX_BYTES = 4096;

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
function activeFeatureSlug(pinnedRoot: PinnedProjectRoot): string {
  try {
    // Native runs publish the selector under .work-state. Legacy runs keep the
    // canonical selector at the project root; consult it only when the native
    // pointer is absent so a compatible migration never creates features/default.
    const candidates = [`${WORK_STATE_DIR}/${ACTIVE_FEATURE}`, ACTIVE_FEATURE];
    for (const relativePath of candidates) {
      const info = pinnedRoot.pathEntryInfo(relativePath);
      if (info === null) continue;
      if (info.kind !== "file") return "default";
      const bytes = pinnedRoot.readFile(relativePath, { maxBytes: ACTIVE_FEATURE_MAX_BYTES }).bytes;
      const slug = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      if (!pinnedRoot.isStable()) return "default";
      return /^[A-Za-z0-9._-]+$/.test(slug) ? slug : "default";
    }
    return "default";
  } catch {
    return "default";
  }
}

export interface ObservabilityRecorderOwnerIdentity {
  readonly canonicalRoot: string;
  readonly rootDev: number;
  readonly rootIno: number;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly generation?: string | number;
}

export type RecorderLease = {
  readonly identity: ObservabilityRecorderOwnerIdentity;
  readonly entries: Set<RecorderEntry>;
  disposed: boolean;
};
type RecorderEntry = {
  readonly cwd: string;
  readonly recorder: EventRecorder;
  readonly canonicalRoot: string;
  readonly rootDev: number;
  readonly rootIno: number;
  readonly owners: Set<RecorderLease>;
};

const recorderCache = new Map<string, RecorderEntry>();
const MAX_CACHED_RECORDERS = 64;

export function createObservabilityRecorderLease(identity: ObservabilityRecorderOwnerIdentity): RecorderLease {
  return { identity, entries: new Set(), disposed: false };
}

export function createObservabilityRecorderLeaseForCwd(cwd: string, session: Omit<ObservabilityRecorderOwnerIdentity, "canonicalRoot" | "rootDev" | "rootIno"> = {}): RecorderLease | undefined {
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return undefined;
  const identity = { canonicalRoot: pinnedRoot.canonical_root, rootDev: pinnedRoot.dev, rootIno: pinnedRoot.ino, ...session };
  pinnedRoot.close();
  return createObservabilityRecorderLease(identity);
}

export async function closeObservabilityRecorderLease(lease: RecorderLease): Promise<void> {
  await closeRecorderLease(lease);
}

export async function closeObservabilityRecorderLeaseForCwd(lease: RecorderLease, cwd: string): Promise<boolean> {
  return closeRecorderLeaseForCwd(lease, cwd);
}

function closeRecorderForFailure(recorder: EventRecorder): void {
  for (const entry of new Set(recorderCache.values())) {
    if (entry.recorder === recorder) void closeRecorderEntry(entry);
  }
}

async function closeRecorderEntry(entry: RecorderEntry): Promise<void> {
  for (const owner of entry.owners) owner.entries.delete(entry);
  entry.owners.clear();
  for (const [cwd, cached] of [...recorderCache.entries()]) {
    if (cached === entry) recorderCache.delete(cwd);
  }
  await entry.recorder.closeAsync();
}

function attachLease(entry: RecorderEntry, lease: RecorderLease | undefined): void {
  if (!lease || lease.disposed) return;
  if (entry.canonicalRoot !== lease.identity.canonicalRoot || entry.rootDev !== lease.identity.rootDev || entry.rootIno !== lease.identity.rootIno) return;
  entry.owners.add(lease);
  lease.entries.add(entry);
}

async function closeRecorderLease(lease: RecorderLease): Promise<void> {
  if (lease.disposed) return;
  lease.disposed = true;
  const closing: Promise<void>[] = [];
  for (const entry of [...lease.entries]) {
    entry.owners.delete(lease);
    lease.entries.delete(entry);
    if (entry.owners.size === 0) closing.push(closeRecorderEntry(entry));
  }
  await Promise.all(closing);
}

async function closeRecorderLeaseForCwd(lease: RecorderLease, cwd: string): Promise<boolean> {
  if (lease.disposed) return false;
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return false;
  const identity = { canonicalRoot: pinnedRoot.canonical_root, rootDev: pinnedRoot.dev, rootIno: pinnedRoot.ino };
  const matches = lease.identity.canonicalRoot === identity.canonicalRoot
    && lease.identity.rootDev === identity.rootDev
    && lease.identity.rootIno === identity.rootIno;
  pinnedRoot.close();
  if (!matches) return false;
  const closing: Promise<void>[] = [];
  for (const entry of [...lease.entries]) {
    if (entry.canonicalRoot !== identity.canonicalRoot || entry.rootDev !== identity.rootDev || entry.rootIno !== identity.rootIno) continue;
    entry.owners.delete(lease);
    lease.entries.delete(entry);
    if (entry.owners.size === 0) closing.push(closeRecorderEntry(entry));
  }
  await Promise.all(closing);
  return true;
}

function cacheRecorder(cwd: string, recorder: EventRecorder, pinnedRoot: PinnedProjectRoot): RecorderEntry {
  const prior = recorderCache.get(cwd);
  if (prior) void closeRecorderEntry(prior);
  const entry: RecorderEntry = { cwd, recorder, canonicalRoot: pinnedRoot.canonical_root, rootDev: pinnedRoot.dev, rootIno: pinnedRoot.ino, owners: new Set() };
  recorderCache.set(cwd, entry);
  while (recorderCache.size > MAX_CACHED_RECORDERS) {
    const oldest = recorderCache.entries().next().value as [string, RecorderEntry] | undefined;
    if (!oldest) break;
    void closeRecorderEntry(oldest[1]);
  }
  return entry;
}

function getRecorder(cwd: string, lease?: RecorderLease): EventRecorder {
  const cached = recorderCache.get(cwd);
  if (cached) {
    attachLease(cached, lease);
    return cached.recorder;
  }
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) throw new PinnedRootError("unsupported", "project root could not be pinned for observability");
  let retained = false;
  try {
    const branch = currentBranch(cwd);
    const featureSlug = activeFeatureSlug(pinnedRoot);
    const rec = new EventRecorder({ cwd, branch, featureSlug, pinnedRoot });
    const entry = cacheRecorder(cwd, rec, pinnedRoot);
    attachLease(entry, lease);
    retained = true;
    return rec;
  } finally {
    if (!retained) pinnedRoot.close();
  }
}

/**
 * Test helper: drain the in-memory write queue for a given cwd. Production
 * code never needs this; only tests use it to assert post-write state
 * without relying on real timers.
 */
export async function flushRecorder(cwd: string): Promise<void> {
  const entry = recorderCache.get(cwd);
  if (entry) await entry.recorder.flush();
}

function safeAppend(
  cwd: string,
  ev: Omit<ObservabilityEvent, "id" | "branch"> & { kind: EventKind },
  lease?: RecorderLease,
): void {
  const reject = (error: unknown): void => {
    const reason = error instanceof Error && error.message ? error.message : "telemetry write rejected";
    console.warn(`[observability] ${reason}`);
  };
  let recorder: EventRecorder | undefined;
  try {
    recorder = getRecorder(cwd, lease);
    void recorder.append(ev).catch((error) => {
      closeRecorderForFailure(recorder!);
      reject(error);
    });
  } catch (error) {
    if (recorder) closeRecorderForFailure(recorder);
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
  onBeforeAgentStart(event: unknown, ctx: unknown, lease?: RecorderLease): void;
  onAgentStart(event: unknown, ctx: unknown, lease?: RecorderLease): void;
  onAgentEnd(event: unknown, ctx: unknown, lease?: RecorderLease): void;
  onToolCall(event: unknown, ctx: unknown, lease?: RecorderLease): void;
  onToolResult(event: unknown, ctx: unknown, lease?: RecorderLease): void;
  onSessionStart(event: unknown, ctx: unknown, lease?: RecorderLease): void;
  onSessionStop(event: unknown, ctx: unknown, lease?: RecorderLease): void;
}

export const observabilityHooks: HookHandlers = {
  onBeforeAgentStart(event, ctx, lease) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    const e = event as { systemPrompt?: string[] } | undefined;
    const skills = e?.systemPrompt ? extractSkills(e.systemPrompt) : [];
    safeAppend(cwd, {
      ...signalMetadata(event, ctx),
      kind: "before_agent_start",
      ts: new Date().toISOString(),
      skills,
    }, lease);
  },
  onAgentStart(event, ctx, lease) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    safeAppend(cwd, {
      ...signalMetadata(event, ctx),
      kind: "agent_start",
      ts: new Date().toISOString(),
    }, lease);
  },
  onAgentEnd(event, ctx, lease) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    const e = event as { messages?: unknown[] } | undefined;
    safeAppend(cwd, {
      ...signalMetadata(event, ctx),
      kind: "agent_end",
      ts: new Date().toISOString(),
      messageCount: Array.isArray(e?.messages) ? e.messages.length : 0,
    }, lease);
  },
  onToolCall(event, ctx, lease) {
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
    }, lease);
  },
  onToolResult(event, ctx, lease) {
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
    }, lease);
  },
  onSessionStart(event, ctx, lease) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    safeAppend(cwd, {
      ...signalMetadata(event, ctx),
      kind: "session_start",
      ts: new Date().toISOString(),
      sessionId: sessionIdFrom(event, ctx),
    }, lease);
  },
  onSessionStop(event, ctx, lease) {
    const cwd = ctxCwd(ctx);
    if (!cwd) return;
    safeAppend(cwd, {
      ...signalMetadata(event, ctx),
      kind: "session_stop",
      ts: new Date().toISOString(),
      sessionId: sessionIdFrom(event, ctx),
    }, lease);
  },
};
/** Re-export so consumers can read the pointer cheaply. */
export { readObservabilityPointer } from "./recorder.js";
