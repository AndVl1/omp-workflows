/**
 * Append-only event recorder.
 *
 * One file per feature: `<feature>/observability/events.jsonl`. The recorder
 * loads the existing rollup on each call, applies the new event, and
 * persists both. This is intentionally not a long-lived in-process cache —
 * OMP can spawn extensions per session, and the hook bus is per-extension,
 * so the recorder is re-entrant and stateless between calls.
 *
 * Storage strategy:
 *   - events.jsonl: line-delimited JSON, one event per line, append-only
 *   - rollup: in-memory only here; persisted via TeamState.observability
 *     by the engine's `writeState`. The recorder is the producer, the engine
 *     is the persister.
 *
 * Concurrency: appendFileSync is atomic for small writes (< PIPE_BUF on
 * POSIX). For multi-event hook bursts, we serialize via a single async
 * queue (no parallel writes). The recorder API is async to make the queue
 * contract explicit at the call site. Tests use `await recorder.flush()` to
 * drain the queue without real timers.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  emptyRollup,
  type EventKind,
  type ObservabilityArtifactSummary,
  type ObservabilityEvent,
  type ObservabilityPointer,
  type ObservabilityRollup,
} from "./events.js";
import { validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import type {
  CompletionArtifactRef,
  CompletionEnvelope,
  CompletionOutcome,
  CompletionTerminalSignal,
  PendingReason,
  WorkIdentity,
} from "../engine/types.js";

const OBSERVABILITY_DIR = "observability";
const EVENTS_FILENAME = "events.jsonl";

function isWithinTree(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isSafeFeatureSlug(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9._-]+$/.test(value);
}

const MAX_ID_LENGTH = 128;
const MAX_REASON_LENGTH = 160;
const MAX_ARTIFACTS = 32;
const MAX_SKILLS = 32;
const TERMINAL_SIGNALS: Record<CompletionTerminalSignal, true> = {
  workflow_complete: true,
  native_tool_result: true,
  provider_terminal: true,
  contract_failure: true,
};
const PENDING_REASONS: Record<PendingReason, true> = {
  provider_running: true,
  awaiting_result: true,
  transport_reconnect: true,
};
const TERMINAL_OUTCOMES: Record<string, true> = {
  succeeded: true,
  failed: true,
  cancelled: true,
};
const TERMINAL_STATUSES: Record<string, true> = {
  succeeded: true,
  failed: true,
  cancelled: true,
};
const SAFE_TOKEN = /^[A-Za-z0-9._:@/#-]+$/;
const SENSITIVE_TEXT = /(prompt|transcript|secret|password|passwd|bearer|authorization|api[\s_-]*key|private[\s_-]*key|access[\s_-]*token|system\s+message|user\s+message)/i;

function isCompletionOutcome(value: unknown): value is CompletionOutcome {
  return value === "pending"
    || value === "succeeded"
    || value === "failed"
    || value === "cancelled";
}

function isCompletionTerminalSignal(value: unknown): value is CompletionTerminalSignal {
  return value === "workflow_complete"
    || value === "native_tool_result"
    || value === "provider_terminal"
    || value === "contract_failure";
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!normalized) return undefined;
  if (SENSITIVE_TEXT.test(normalized)) return `sha256:${hashText(normalized)}`;
  if (normalized.length <= MAX_ID_LENGTH && SAFE_TOKEN.test(normalized)) return normalized;
  return `sha256:${hashText(normalized)}`;
}

function safeReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (SENSITIVE_TEXT.test(normalized)) return `redacted:${hashText(normalized)}`;
  return `reason:${hashText(normalized.slice(0, MAX_REASON_LENGTH))}`;
}

function safeHashReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_ID_LENGTH && SAFE_TOKEN.test(normalized)) return normalized;
  return `sha256:${hashText(normalized)}`;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 64 || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function relativeSafePath(root: string, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.replace(/\\/g, "/").trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw) || /^[A-Za-z]:\//.test(raw)) return undefined;
  const candidate = resolve(root, raw);
  if (!isWithinTree(resolve(root), candidate)) return undefined;
  const rel = relative(resolve(root), candidate);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return normalize(rel).split(sep).join("/");
}

function identityFrom(value: unknown): WorkIdentity | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const stringFields = [
    "run_id",
    "wave_id",
    "slice_id",
    "session_id",
    "workflow",
    "stage_id",
    "stage_cursor",
    "capability_id",
    "capability_epoch",
    "slot_id",
    "task_id",
    "dispatch_id",
    "worker_id",
  ] as const;
  const fields = {} as Record<(typeof stringFields)[number], string>;
  for (const key of stringFields) {
    const safe = safeIdentifier(record[key]);
    if (!safe) return undefined;
    fields[key] = safe;
  }
  if (!Number.isInteger(record.attempt) || Number(record.attempt) < 1) return undefined;
  return { ...fields, attempt: Number(record.attempt) } as WorkIdentity;
}

function sameIdentity(left: WorkIdentity | undefined, right: WorkIdentity | undefined): boolean {
  if (!left || !right) return false;
  return left.run_id === right.run_id
    && left.wave_id === right.wave_id
    && left.slice_id === right.slice_id
    && left.session_id === right.session_id
    && left.workflow === right.workflow
    && left.stage_id === right.stage_id
    && left.stage_cursor === right.stage_cursor
    && left.capability_id === right.capability_id
    && left.capability_epoch === right.capability_epoch
    && left.slot_id === right.slot_id
    && left.task_id === right.task_id
    && left.dispatch_id === right.dispatch_id
    && left.attempt === right.attempt
    && left.worker_id === right.worker_id;
}

function workTupleKey(identity: WorkIdentity | undefined): string | undefined {
  if (!identity) return undefined;
  return [
    identity.run_id,
    identity.wave_id,
    identity.slice_id,
    identity.session_id,
    identity.workflow,
    identity.stage_id,
    identity.slot_id,
    identity.task_id,
  ].join("\u001f");
}

function dispatchIdentityKey(event: Pick<ObservabilityEvent, "work_identity">): string | undefined {
  const identity = event.work_identity;
  return identity ? `${workTupleKey(identity) ?? ""}\u001f${identity.dispatch_id}` : undefined;
}

function sanitizeArtifactSummary(root: string, value: unknown): ObservabilityArtifactSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const artifactId = safeIdentifier(record.artifact_id ?? record.artifactId);
  const path = relativeSafePath(root, record.path ?? record.artifactPath);
  const sha256 = safeHashReference(record.sha256 ?? record.hash ?? record.artifactSha256);
  if (!artifactId || !path || !sha256) return undefined;
  const bytes = record.bytes ?? record.artifactBytes;
  const summary: ObservabilityArtifactSummary = {
    artifact_id: artifactId,
    path,
    sha256,
  };
  if (Number.isSafeInteger(bytes) && Number(bytes) >= 0) summary.bytes = Number(bytes);
  if (record.schema_status === "met" || record.schema_status === "failed") summary.schema_status = record.schema_status;
  if (record.dod_status === "met" || record.dod_status === "pending" || record.dod_status === "failed") summary.dod_status = record.dod_status;
  return summary;
}

function sanitizeCompletionEnvelope(root: string, value: unknown): CompletionEnvelope | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const identity = identityFrom(record.identity);
  if (!identity || record.schema_version !== 1) return undefined;
  const runIdentityResult = validateWorkflowRunIdentity(record.run_identity);
  if (
    !runIdentityResult.ok
    || runIdentityResult.value.run_id !== identity.run_id
    || runIdentityResult.value.session.session_id !== identity.session_id
  ) return undefined;
  const outcome = record.outcome;
  if (!isCompletionOutcome(outcome)) return undefined;
  let terminalSignal: CompletionEnvelope["terminal_signal"] = null;
  if (record.terminal_signal !== null && record.terminal_signal !== undefined) {
    if (!isCompletionTerminalSignal(record.terminal_signal)) return undefined;
    terminalSignal = record.terminal_signal;
  }
  const artifactRefs: CompletionArtifactRef[] = [];
  if (!Array.isArray(record.artifact_refs)) return undefined;
  for (const candidate of record.artifact_refs.slice(0, MAX_ARTIFACTS)) {
    const summary = sanitizeArtifactSummary(root, candidate);
    if (!summary) continue;
    artifactRefs.push({
      artifact_id: summary.artifact_id,
      path: summary.path,
      sha256: summary.sha256,
      schema_status: summary.schema_status ?? "failed",
      dod_status: summary.dod_status ?? "failed",
    });
  }
  const completedBy = record.completed_by;
  if (completedBy !== "workflow_complete" && completedBy !== "synchronous_tool_result" && completedBy !== "engine_task_caller") return undefined;
  const emittedAt = safeTimestamp(record.emitted_at);
  if (!emittedAt) return undefined;
  const evidenceRef = record.evidence_ref === null || record.evidence_ref === undefined
    ? null
    : relativeSafePath(root, record.evidence_ref);
  const conflictRef = record.conflict_ref === null || record.conflict_ref === undefined
    ? null
    : relativeSafePath(root, record.conflict_ref);
  return {
    schema_version: 1,
    identity,
    run_identity: runIdentityResult.value,
    outcome,
    terminal_signal: terminalSignal,
    artifact_refs: artifactRefs,
    evidence_ref: evidenceRef ?? null,
    conflict_ref: conflictRef ?? null,
    completed_by: completedBy,
    emitted_at: emittedAt,
  };
}

function sanitizeEvent(root: string, event: unknown): Omit<ObservabilityEvent, "id" | "branch"> {
  const source = asRecord(event);
  if (!source) throw new Error("observability event must be an object");
  const kind = source.kind;
  const validKinds: EventKind[] = [
    "session_start",
    "session_stop",
    "before_agent_start",
    "agent_start",
    "agent_end",
    "tool_call",
    "tool_result",
    "stage_transition",
    "artifact_written",
    "work_pending",
    "work_terminal",
  ];
  if (typeof kind !== "string" || !validKinds.includes(kind as EventKind)) throw new Error("observability event kind is invalid");
  const ts = safeTimestamp(source.ts);
  if (!ts) throw new Error("observability event timestamp is invalid");
  const sourceIdentity = source.work_identity === undefined ? undefined : identityFrom(source.work_identity);
  if (source.work_identity !== undefined && !sourceIdentity) throw new Error("observability work identity is invalid");
  const rawEnvelope = source.completion_envelope === undefined
    ? undefined
    : sanitizeCompletionEnvelope(root, source.completion_envelope);
  if (source.completion_envelope !== undefined && !rawEnvelope) throw new Error("observability completion envelope is invalid");
  if (sourceIdentity && rawEnvelope && !sameIdentity(sourceIdentity, rawEnvelope.identity)) throw new Error("completion envelope identity mismatch");
  const identity = sourceIdentity ?? rawEnvelope?.identity;
  const output: Record<string, unknown> = { kind, ts };
  if (identity) {
    output.work_identity = identity;
    output.capability_epoch = safeIdentifier(source.capability_epoch) ?? identity.capability_epoch;
  }
  const tokenFields = [
    ["sessionId", source.sessionId],
    ["toolCallId", source.toolCallId],
    ["toolName", source.toolName],
    ["subagent", source.subagent],
    ["stageId", source.stageId],
    ["artifactId", source.artifactId],
    ["runId", source.runId],
    ["profile_hash", source.profile_hash],
    ["policy_hash", source.policy_hash],
    ["provider_ref", source.provider_ref],
    ["retry_of", source.retry_of],
    ["idempotency_key", source.idempotency_key],
  ] as const;
  for (const [key, value] of tokenFields) {
    const safe = safeIdentifier(value);
    if (safe) output[key] = safe;
  }
  if (source.gateDecision === "allowed" || source.gateDecision === "blocked") output.gateDecision = source.gateDecision;
  const reason = safeReason(source.gateReason);
  if (reason) output.gateReason = reason;
  if (typeof source.isError === "boolean") output.isError = source.isError;
  if (Number.isSafeInteger(source.subagentTaskChars) && Number(source.subagentTaskChars) >= 0) output.subagentTaskChars = Number(source.subagentTaskChars);
  if (Number.isSafeInteger(source.agentStartMs) && Number(source.agentStartMs) >= 0) output.agentStartMs = Number(source.agentStartMs);
  if (Number.isSafeInteger(source.messageCount) && Number(source.messageCount) >= 0) output.messageCount = Number(source.messageCount);
  if (Number.isSafeInteger(source.artifactBytes) && Number(source.artifactBytes) >= 0) output.artifactBytes = Number(source.artifactBytes);
  const artifactSha256 = safeHashReference(source.artifactSha256);
  if (artifactSha256) output.artifactSha256 = artifactSha256;
  const artifactPath = relativeSafePath(root, source.artifactPath);
  if (artifactPath) output.artifactPath = artifactPath;
  const stageStatus = safeIdentifier(source.stageStatus);
  if (stageStatus) output.stageStatus = stageStatus;
  if (Array.isArray(source.skills)) {
    const skills = source.skills.slice(0, MAX_SKILLS).map(safeIdentifier).filter((s): s is string => Boolean(s));
    if (skills.length > 0) output.skills = [...new Set(skills)];
  }
  if (rawEnvelope) {
    output.completion_envelope = rawEnvelope;
    if (source.terminal_signal === undefined) output.terminal_signal = rawEnvelope.terminal_signal;
    if (source.outcome === undefined) output.outcome = rawEnvelope.outcome;
    if (!source.artifact_summaries) {
      output.artifact_summaries = rawEnvelope.artifact_refs.map((ref) => ({
        artifact_id: ref.artifact_id,
        path: ref.path,
        sha256: ref.sha256,
        schema_status: ref.schema_status,
        dod_status: ref.dod_status,
      })).slice(0, MAX_ARTIFACTS);
    }
  }
  if (Array.isArray(source.artifact_summaries)) {
    const summaries = source.artifact_summaries
      .slice(0, MAX_ARTIFACTS)
      .map((candidate) => sanitizeArtifactSummary(root, candidate))
      .filter((candidate): candidate is ObservabilityArtifactSummary => Boolean(candidate));
    if (summaries.length > 0) output.artifact_summaries = summaries;
  }
  if (!output.artifact_summaries && output.artifactId && output.artifactPath && output.artifactSha256) {
    const summary = sanitizeArtifactSummary(root, {
      artifact_id: output.artifactId,
      path: output.artifactPath,
      sha256: output.artifactSha256,
      bytes: output.artifactBytes,
    });
    if (summary) output.artifact_summaries = [summary];
  }
  const pendingReason = source.pending_reason;
  if (pendingReason !== undefined && PENDING_REASONS[pendingReason as PendingReason] === true) output.pending_reason = pendingReason;
  const terminalSignal = source.terminal_signal;
  if (terminalSignal === null || (terminalSignal !== undefined && TERMINAL_SIGNALS[terminalSignal as CompletionTerminalSignal] === true)) output.terminal_signal = terminalSignal;
  if (source.outcome === "pending" || TERMINAL_OUTCOMES[source.outcome as string] === true) output.outcome = source.outcome;
  if (source.status === "authorized" || source.status === "running" || source.status === "pending" || TERMINAL_STATUSES[source.status as string] === true) output.status = source.status;
  return output as Omit<ObservabilityEvent, "id" | "branch">;
}

function isTerminalClaim(event: Pick<ObservabilityEvent, "kind" | "terminal_signal" | "outcome" | "status" | "completion_envelope">): boolean {
  return event.kind === "work_terminal"
    || event.terminal_signal !== undefined && event.terminal_signal !== null
    || event.outcome !== undefined && TERMINAL_OUTCOMES[event.outcome] === true
    || event.status !== undefined && TERMINAL_STATUSES[event.status] === true
    || event.completion_envelope !== undefined && event.completion_envelope.outcome !== "pending";
}

function isPendingClaim(event: Pick<ObservabilityEvent, "kind" | "pending_reason" | "outcome" | "status" | "completion_envelope">): boolean {
  return event.kind === "work_pending"
    || event.pending_reason !== undefined
    || event.outcome === "pending"
    || event.status === "pending"
    || event.completion_envelope?.outcome === "pending";
}

function envelopeError(event: ObservabilityEvent): string | null {
  const pending = isPendingClaim(event);
  const terminal = isTerminalClaim(event);
  if (pending && terminal) return "pending observability signal cannot claim a terminal signal";
  if ((pending || terminal) && !event.work_identity) return "lifecycle observability signal requires work identity";
  if (event.kind === "work_pending" && !event.pending_reason) return "pending observability signal requires pending_reason";
  if (pending && event.pending_reason === undefined) return "pending observability signal requires pending_reason";
  if (event.terminal_signal !== undefined && event.terminal_signal !== null && TERMINAL_SIGNALS[event.terminal_signal] !== true) return "unknown terminal_signal";
  const envelope = event.completion_envelope;
  if (envelope) {
    if (!event.work_identity || !sameIdentity(event.work_identity, envelope.identity)) return "completion envelope identity mismatch";
    if (envelope.outcome === "pending") {
      if (envelope.terminal_signal !== null) return "pending completion envelope cannot claim a terminal signal";
      if (event.terminal_signal !== undefined && event.terminal_signal !== null) return "pending completion envelope conflicts with terminal_signal";
    } else {
      if (envelope.terminal_signal === null) return "terminal completion envelope requires terminal_signal";
      if (event.terminal_signal !== undefined && event.terminal_signal !== envelope.terminal_signal) return "completion envelope terminal_signal mismatch";
      if (event.outcome !== undefined && event.outcome !== envelope.outcome) return "completion envelope outcome mismatch";
    }
  }
  if (terminal) {
    if (!event.work_identity) return "terminal observability signal requires work identity";
    if (!envelope && !event.retry_of) return "terminal observability signal requires identity-bound completion envelope or retry_of";
  }
  if (event.retry_of && !event.work_identity) return "replacement observability signal requires work identity";
  return null;
}

function retryLinkError(events: ReadonlyArray<ObservabilityEvent>, event: ObservabilityEvent): string | null {
  if (!event.retry_of) return null;
  const target = events.find((candidate) => candidate.id === event.retry_of || candidate.work_identity?.dispatch_id === event.retry_of);
  if (!target || !isTerminalClaim(target)) return "retry_of must reference a prior terminal dispatch";
  const targetIdentity = target.work_identity;
  const identity = event.work_identity;
  if (!targetIdentity || !identity || workTupleKey(targetIdentity) !== workTupleKey(identity)) return "retry_of identity tuple mismatch";
  if (targetIdentity.dispatch_id === identity.dispatch_id || identity.attempt <= targetIdentity.attempt) return "replacement attempt must advance the prior dispatch";
  return null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

function replayKey(event: ObservabilityEvent): string | undefined {
  if (!event.idempotency_key && !isPendingClaim(event) && !isTerminalClaim(event) && !event.retry_of) return undefined;
  const payload: Record<string, unknown> = { ...event };
  delete payload.id;
  delete payload.branch;
  delete payload.ts;
  return JSON.stringify(canonicalize(payload));
}
export interface RecorderOptions {
  /** Cwd of the project. */
  cwd: string;
  /** Branch slug to scope the file under. */
  branch: string;
  /** Feature slug (under `.work-state/features/<slug>/`). */
  featureSlug?: string;
  /**
   * Optional id generator. Default: monotonic counter + Date.now base.
   * Tests inject a deterministic generator to keep ids stable.
   */
  nextId?: () => string;
}

let staticCounter = 0;

export class EventRecorder {
  private readonly cwd: string;
  private readonly branch: string;
  private readonly featureSlug: string;
  private readonly nextId: () => string;
  private readonly eventsPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: RecorderOptions) {
    this.cwd = opts.cwd;
    this.branch = opts.branch;
    this.featureSlug = opts.featureSlug ?? "default";
    this.nextId =
      opts.nextId ??
      ((): string => {
        const n = staticCounter++;
        return `evt-${Date.now().toString(36)}-${n.toString(36)}`;
      });
    this.eventsPath = this.resolveEventsPath();
  }

  /** Absolute path of the events.jsonl file. */
  get path(): string {
    return this.eventsPath;
  }

  /**
   * Wait for the in-memory write queue to drain. Tests use this instead of
   * real timers to assert post-write state without race conditions.
   */
  async flush(): Promise<void> {
    await this.queue;
  }

  /** Append a single event. Invalid lifecycle evidence rejects this promise. */
  append(event: Omit<ObservabilityEvent, "id" | "branch">): Promise<ObservabilityEvent> {
    const normalized = sanitizeEvent(this.cwd, event);
    const fullEvent: ObservabilityEvent = {
      ...normalized,
      id: this.nextId(),
      branch: safeIdentifier(this.branch) ?? "(unknown)",
    };
    const operation = this.queue.then(() => this.writeOne(fullEvent));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Read the full event log (small files expected; bounded by session length). */
  readAll(): ObservabilityEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const text = readFileSync(this.eventsPath, "utf8");
    const out: ObservabilityEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as ObservabilityEvent);
      } catch {
        // best-effort: skip corrupt lines rather than throw
      }
    }
    return out;
  }

  /**
   * Build the rollup by reading the full event log. Used on first append
   * if no prior rollup is supplied.
   */
  buildRollup(): ObservabilityRollup {
    return rollupFromEvents(this.readAll());
  }

  /**
   * Build an ObservabilityPointer (the shape `TeamState.observability` expects).
   * The rollup is computed from the event log + lastEventId = last id in log.
   */
  buildPointer(): ObservabilityPointer {
    const events = this.readAll();
    const last = events[events.length - 1];
    const rollup = rollupFromEvents(events);
    return {
      eventsPath: this.relativePath(),
      lastEventId: last?.id ?? "",
      rollupThroughId: last?.id ?? "",
      rollup,
    };
  }

  private resolveEventsPath(): string {
    if (!isSafeFeatureSlug(this.featureSlug)) throw new Error("unsafe observability feature slug");
    const projectRoot = realpathSync(resolve(this.cwd));
    const wsDir = resolve(this.cwd, ".work-state");
    mkdirSync(wsDir, { recursive: true });
    const realWorkState = realpathSync(wsDir);
    if (!isWithinTree(projectRoot, realWorkState)) throw new Error("observability path escapes project root");
    const featuresDir = join(wsDir, "features");
    mkdirSync(featuresDir, { recursive: true });
    const realFeatures = realpathSync(featuresDir);
    if (!isWithinTree(realWorkState, realFeatures)) throw new Error("observability features path escapes .work-state");
    const featureDir = join(featuresDir, this.featureSlug);
    if (existsSync(featureDir) && !isWithinTree(realFeatures, realpathSync(featureDir))) {
      throw new Error("observability feature path escapes .work-state/features");
    }
    mkdirSync(featureDir, { recursive: true });
    const realFeature = realpathSync(featureDir);
    if (!isWithinTree(realFeatures, realFeature)) throw new Error("observability feature path escapes .work-state/features");
    const obsDir = join(featureDir, OBSERVABILITY_DIR);
    if (existsSync(obsDir) && !isWithinTree(realFeature, realpathSync(obsDir))) {
      throw new Error("observability directory escapes feature path");
    }
    mkdirSync(obsDir, { recursive: true });
    const realObs = realpathSync(obsDir);
    if (!isWithinTree(realFeature, realObs)) throw new Error("observability directory escapes feature path");
    const eventsPath = join(realObs, EVENTS_FILENAME);
    if (existsSync(eventsPath) && !isWithinTree(realObs, realpathSync(eventsPath))) {
      throw new Error("observability event log escapes feature path");
    }
    return eventsPath;
  }

  private assertEventsPathSafe(): void {
    const projectRoot = realpathSync(resolve(this.cwd));
    const realWorkState = realpathSync(resolve(this.cwd, ".work-state"));
    const realFeatures = realpathSync(join(realWorkState, "features"));
    const realFeature = realpathSync(join(realFeatures, this.featureSlug));
    const realObs = realpathSync(dirname(this.eventsPath));
    if (!isWithinTree(projectRoot, realWorkState) || !isWithinTree(realWorkState, realFeatures) || !isWithinTree(realFeatures, realFeature) || !isWithinTree(realFeature, realObs)) {
      throw new Error("observability event path escapes project state");
    }
    if (existsSync(this.eventsPath) && !isWithinTree(realObs, realpathSync(this.eventsPath))) {
      throw new Error("observability event log escapes feature path");
    }
  }

  private relativePath(): string {
    return join(OBSERVABILITY_DIR, EVENTS_FILENAME);
  }

  private async writeOne(event: ObservabilityEvent): Promise<ObservabilityEvent> {
    this.assertEventsPathSafe();
    mkdirSync(dirname(this.eventsPath), { recursive: true });
    const existing = this.readAll();
    const candidateReplayKey = replayKey(event);
    if (candidateReplayKey) {
      const replay = existing.find((candidate) => replayKey(candidate) === candidateReplayKey);
      if (replay) return replay;
    }
    const evidenceError = envelopeError(event);
    if (evidenceError) throw new Error(evidenceError);
    const retryError = retryLinkError(existing, event);
    if (retryError) throw new Error(retryError);
    const dispatchKey = dispatchIdentityKey(event);
    if (dispatchKey && (isPendingClaim(event) || isTerminalClaim(event))) {
      const conflicting = existing.find((candidate) =>
        dispatchIdentityKey(candidate) === dispatchKey
        && (isPendingClaim(candidate) || isTerminalClaim(candidate))
        && replayKey(candidate) !== candidateReplayKey,
      );
      if (conflicting) throw new Error("conflicting observability replay for dispatch identity");
    }
    appendFileSync(this.eventsPath, JSON.stringify(event) + "\n", "utf8");
    return event;
  }
}

/** Pure rollup computation. Exported for callers that need re-aggregation. */
export function rollupFromEvents(events: ReadonlyArray<ObservabilityEvent>): ObservabilityRollup {
  if (events.length === 0) {
    return emptyRollup(new Date(0).toISOString());
  }
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const rollup: ObservabilityRollup = {
    ...emptyRollup(first.ts),
    firstEventAt: first.ts,
    lastEventAt: last.ts,
    agents: {},
    tools: {},
    toolErrors: {},
    subagents: {},
    skills: {},
    pendingEvents: 0,
    pendingReasons: {},
    terminalSignals: {},
    artifactSummaries: 0,
  };
  for (const e of events) {
    if (e.kind === "agent_start") {
      rollup.agentInvocations += 1;
      const k = e.subagent ?? "__main__";
      rollup.agents[k] = (rollup.agents[k] ?? 0) + 1;
    }
    if (e.kind === "tool_call" && e.toolName) {
      rollup.totalToolCalls += 1;
      rollup.tools[e.toolName] = (rollup.tools[e.toolName] ?? 0) + 1;
      if (e.toolName === "task" && e.subagent) {
        rollup.subagents[e.subagent] = (rollup.subagents[e.subagent] ?? 0) + 1;
      }
    }
    if (e.kind === "tool_result" && e.toolName) {
      if (e.isError) {
        rollup.totalToolErrors += 1;
        rollup.toolErrors[e.toolName] = (rollup.toolErrors[e.toolName] ?? 0) + 1;
      }
    }
    if (e.skills && e.skills.length > 0) {
      for (const s of e.skills) {
        rollup.skills[s] = (rollup.skills[s] ?? 0) + 1;
      }
    }
    if (isPendingClaim(e) && e.pending_reason) {
      rollup.pendingEvents = (rollup.pendingEvents ?? 0) + 1;
      rollup.pendingReasons![e.pending_reason] = (rollup.pendingReasons![e.pending_reason] ?? 0) + 1;
    }
    if (isTerminalClaim(e) && e.terminal_signal) {
      rollup.terminalSignals![e.terminal_signal] = (rollup.terminalSignals![e.terminal_signal] ?? 0) + 1;
    }
    if (e.artifact_summaries && e.artifact_summaries.length > 0) {
      rollup.artifactSummaries = (rollup.artifactSummaries ?? 0) + e.artifact_summaries.length;
    }
    // Additive stage/artifact counters — old rollups simply lack these fields.
    if (e.kind === "stage_transition") {
      rollup.stageTransitions = (rollup.stageTransitions ?? 0) + 1;
    }
    if (e.kind === "artifact_written") {
      rollup.artifactWrites = (rollup.artifactWrites ?? 0) + 1;
    }
  }
  const start = Date.parse(first.ts);
  const end = Date.parse(last.ts);
  rollup.durationMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
  return rollup;
}

/**
 * Best-effort: read a `TeamState.observability` pointer off disk and return
 * the events path + rollup. Returns null if the feature has no observability
 * dir yet (e.g. brand-new feature, or pre-observability state).
 */
export function readObservabilityPointer(
  cwd: string,
  featureSlug: string,
): ObservabilityPointer | null {
  const eventsPath = resolve(
    cwd,
    ".work-state",
    "features",
    featureSlug,
    OBSERVABILITY_DIR,
    EVENTS_FILENAME,
  );
  if (!existsSync(eventsPath)) return null;
  const text = readFileSync(eventsPath, "utf8");
  const events: ObservabilityEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as ObservabilityEvent);
    } catch {
      // skip
    }
  }
  const last = events[events.length - 1];
  return {
    eventsPath: join(OBSERVABILITY_DIR, EVENTS_FILENAME),
    lastEventId: last?.id ?? "",
    rollupThroughId: last?.id ?? "",
    rollup: rollupFromEvents(events),
  };
}

/** Write the pointer inside the feature's `state.json` (called by `writeState`). */
export function writePointerSync(
  cwd: string,
  featureSlug: string,
  pointer: ObservabilityPointer,
): void {
  // Mirror the events path into a small JSON file alongside the event log so
  // the engine can rebuild the pointer without re-reading state.json. The
  // canonical store is `TeamState.observability`; this file is the cache.
  const obsDir = resolve(
    cwd,
    ".work-state",
    "features",
    featureSlug,
    OBSERVABILITY_DIR,
  );
  mkdirSync(obsDir, { recursive: true });
  writeFileSync(join(obsDir, "pointer.json"), JSON.stringify(pointer, null, 2) + "\n", "utf8");
}
