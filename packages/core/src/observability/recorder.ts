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
 *   - events.jsonl: bounded, descriptor-anchored JSONL with deterministic
 *     suffix compaction at record and aggregate-byte limits
 *   - rollup: in-memory only here; persisted via TeamState.observability
 *     by the engine's `writeState`. The recorder is the producer, the engine
 *     is the persister.
 *
 * Concurrency: every append takes a bounded, fenced lock under the pinned
 * feature directory, reads a bounded snapshot, then commits a complete
 * compacted JSONL image atomically. This avoids interleaving and leaves either
 * the old image or the new image after a crash.
 */

import { createHash, randomUUID } from "node:crypto";
import { PinnedProjectRoot, PinnedRootError, processStartIdentity } from "../specification/pinned-root.js";
import { withoutCurrentExecutionLiveness } from "../execution-liveness.js";
import { isAbsolute, join } from "node:path";
import {
  emptyRollup,
  type EventKind,
  type ObservabilityArtifactSummary,
  type ObservabilityEvent,
  type ObservabilityPointer,
  type ObservabilityRollup,
} from "./events.js";
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
const OBSERVABILITY_PATH = ".work-state/features";
export const OBSERVABILITY_MAX_EVENT_BYTES = 64 * 1024;
export const OBSERVABILITY_MAX_LOG_BYTES = 2 * 1024 * 1024;
export const OBSERVABILITY_MAX_RECORDS = 5000;
export const OBSERVABILITY_MAX_AGGREGATE_BYTES = 2 * 1024 * 1024;
export const OBSERVABILITY_MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 64 * 1024;
const LOCK_ATTEMPTS = 128;
const LOCK_RETRY_MS = 5;
const MAX_JSON_DEPTH = 32;
const SELF_START_IDENTITY = processStartIdentity();
const MAX_EVENT_BYTES = OBSERVABILITY_MAX_EVENT_BYTES;
const MAX_LOG_BYTES = OBSERVABILITY_MAX_LOG_BYTES;
const MAX_RECORDS = OBSERVABILITY_MAX_RECORDS;
const MAX_AGGREGATE_BYTES = OBSERVABILITY_MAX_AGGREGATE_BYTES;
const MAX_PINNED_READ_BYTES = OBSERVABILITY_MAX_READ_BYTES;


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

function relativeSafePath(root: PinnedProjectRoot, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.replace(/\\/g, "/").trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw) || /^[A-Za-z]:\//.test(raw)) return undefined;
  try {
    const candidate = isAbsolute(raw) ? raw : root.anchorPath(raw);
    const relativePath = root.relativePath(candidate);
    if (!relativePath || relativePath === "." || relativePath === "..") return undefined;
    return relativePath.split(/[\\/]/u).join("/");
  } catch {
    return undefined;
  }
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

function sanitizeArtifactSummary(root: PinnedProjectRoot, value: unknown): ObservabilityArtifactSummary | undefined {
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
  if (record.quality_gate_status === "met" || record.quality_gate_status === "pending" || record.quality_gate_status === "failed") summary.quality_gate_status = record.quality_gate_status;
  return summary;
}

function sanitizeCompletionEnvelope(root: PinnedProjectRoot, value: unknown): CompletionEnvelope | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const identity = identityFrom(record.identity);
  if (!identity || record.schema_version !== 1) return undefined;
  const outcome = record.outcome;
  if (outcome !== "pending" && TERMINAL_OUTCOMES[outcome as string] !== true) return undefined;
  const terminalSignal = record.terminal_signal;
  if (terminalSignal !== null && terminalSignal !== undefined && TERMINAL_SIGNALS[terminalSignal as CompletionTerminalSignal] !== true) return undefined;
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
      quality_gate_status: summary.quality_gate_status ?? "failed",
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
    outcome: outcome as CompletionEnvelope["outcome"],
    terminal_signal: terminalSignal === undefined ? null : terminalSignal as CompletionEnvelope["terminal_signal"],
    artifact_refs: artifactRefs,
    evidence_ref: evidenceRef ?? null,
    conflict_ref: conflictRef ?? null,
    completed_by: completedBy,
    emitted_at: emittedAt,
  };
}

function sanitizeEvent(root: PinnedProjectRoot, event: unknown): Omit<ObservabilityEvent, "id" | "branch"> {
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
  const rawEnvelope = sanitizeCompletionEnvelope(root, source.completion_envelope);
  const identity = identityFrom(source.work_identity) ?? rawEnvelope?.identity;
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
        quality_gate_status: ref.quality_gate_status,
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
function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PinnedRootError("invalid", `${what} is not valid UTF-8: ${String(error)}`);
  }
}

export interface BoundedObservabilityParseOptions {
  maxBytes?: number;
  maxRecords?: number;
  maxEventBytes?: number;
  maxAggregateBytes?: number;
  maxWork?: number;
}
function jsonDepthWithin(value: unknown, maxDepth: number): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== "object") continue;
    const depth = current.depth + 1;
    if (depth > maxDepth) return false;
    for (const nested of Object.values(current.value as Record<string, unknown>)) {
      pending.push({ value: nested, depth });
    }
  }
  return true;
}

export function parseBoundedObservabilityEvents(
  bytes: Uint8Array,
  options: BoundedObservabilityParseOptions = {},
): ObservabilityEvent[] {
  const maxBytes = options.maxBytes ?? MAX_PINNED_READ_BYTES;
  const maxRecords = options.maxRecords ?? MAX_RECORDS;
  const maxEventBytes = options.maxEventBytes ?? MAX_EVENT_BYTES;
  const maxAggregateBytes = options.maxAggregateBytes ?? MAX_AGGREGATE_BYTES;
  const maxWork = options.maxWork ?? maxBytes * 4;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_PINNED_READ_BYTES
    || !Number.isSafeInteger(maxRecords) || maxRecords <= 0 || maxRecords > MAX_RECORDS
    || !Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0 || maxEventBytes > MAX_PINNED_READ_BYTES
    || !Number.isSafeInteger(maxAggregateBytes) || maxAggregateBytes <= 0 || maxAggregateBytes > MAX_PINNED_READ_BYTES
    || !Number.isSafeInteger(maxWork) || maxWork <= 0 || maxWork > MAX_PINNED_READ_BYTES * 4) {
    throw new PinnedRootError("invalid", "bounded observability parser limits are invalid");
  }
  if (bytes.byteLength > maxBytes) throw new PinnedRootError("limit", "observability event log exceeds its bounded read limit");
  const text = decodeUtf8(bytes, "observability event log");
  const ring: Array<{ event: ObservabilityEvent; bytes: number } | undefined> = new Array(maxRecords);
  let count = 0;
  let start = 0;
  let retainedBytes = 0;
  let work = 0;
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf("\n", offset);
    const lineEnd = end < 0 ? text.length : end;
    const line = text.slice(offset, lineEnd);
    offset = end < 0 ? text.length : end + 1;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    work += lineBytes;
    if (work > maxWork) throw new PinnedRootError("limit", "observability event log exceeded its bounded parse-work limit");
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (lineBytes > maxEventBytes) throw new PinnedRootError("limit", "observability event exceeds the bounded event-byte limit");
    if (lineBytes > maxAggregateBytes) throw new PinnedRootError("limit", "observability event cannot fit the bounded aggregate-byte limit");
    try {
      const value: unknown = JSON.parse(trimmed);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (!jsonDepthWithin(value, MAX_JSON_DEPTH)) throw new PinnedRootError("limit", "observability event JSON depth exceeds its bounded limit");
      const record = { event: value as ObservabilityEvent, bytes: lineBytes };
      if (count < maxRecords) {
        ring[(start + count) % maxRecords] = record;
        count += 1;
      } else {
        const replaced = ring[start];
        if (replaced) retainedBytes -= replaced.bytes;
        ring[start] = record;
        start = (start + 1) % maxRecords;
      }
      retainedBytes += lineBytes;
      while (retainedBytes > maxAggregateBytes && count > 0) {
        const removed = ring[start];
        if (!removed) break;
        ring[start] = undefined;
        start = (start + 1) % maxRecords;
        count -= 1;
        retainedBytes -= removed.bytes;
      }
    } catch (error) {
      if (error instanceof PinnedRootError) throw error;
      // Preserve compatibility with older logs: malformed JSON records are
      // ignored, while invalid UTF-8 and unsafe storage remain fatal.
    }
  }
  const events: ObservabilityEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = ring[(start + index) % maxRecords];
    if (record) events.push(record.event);
  }
  return events;
}

function serializedEvent(event: ObservabilityEvent, maxEventBytes: number): Buffer {
  let text: string;
  try {
    text = JSON.stringify(event);
  } catch (error) {
    throw new PinnedRootError("invalid", `observability event is not serializable: ${String(error)}`);
  }
  if (typeof text !== "string") throw new PinnedRootError("invalid", "observability event is not serializable");
  const bytes = Buffer.from(`${text}\n`, "utf8");
  if (bytes.byteLength > maxEventBytes) throw new PinnedRootError("limit", "observability event exceeds the bounded event-byte limit");
  return bytes;
}

function validateBound(value: number | undefined, fallback: number, max: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > max) {
    throw new PinnedRootError("invalid", `${label} bound is invalid`);
  }
  return result;
}

function ownerIsStale(owner: unknown): boolean {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return false;
  const value = owner as { pid?: unknown; start_identity?: unknown };
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.start_identity !== "string" || value.start_identity.length === 0) return false;
  try {
    process.kill(value.pid as number, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH";
  }
  const currentIdentity = processStartIdentity(value.pid as number);
  return currentIdentity !== null && currentIdentity !== value.start_identity;
}


function compactRecent(
  events: ReadonlyArray<ObservabilityEvent>,
  maxRecords: number,
  maxBytes: number,
  maxAggregateBytes: number,
  maxEventBytes: number,
): ObservabilityEvent[] {
  const byteBudget = Math.min(maxBytes, maxAggregateBytes);
  const retained: ObservabilityEvent[] = [];
  let totalBytes = 0;
  for (let index = events.length - 1; index >= 0 && retained.length < maxRecords; index -= 1) {
    const event = events[index]!;
    const bytes = serializedEvent(event, maxEventBytes);
    if (totalBytes + bytes.byteLength > byteBudget) {
      if (retained.length === 0) throw new PinnedRootError("limit", "observability event cannot fit the bounded log-byte limit");
      break;
    }
    retained.push(event);
    totalBytes += bytes.byteLength;
  }
  retained.reverse();
  return retained;
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
  /** Borrow an already pinned root; ownership remains with the caller. */
  pinnedRoot?: PinnedProjectRoot;
  /** Maximum encoded bytes for one event including its JSONL newline. */
  maxEventBytes?: number;
  /** Maximum encoded bytes retained in events.jsonl. */
  maxLogBytes?: number;
  /** Maximum number of retained records. */
  maxRecords?: number;
  /** Maximum aggregate encoded bytes retained by compaction. */
  maxAggregateBytes?: number;
  /**
   * Optional id generator. Default: monotonic counter + Date.now base.
   * Tests inject a deterministic generator to keep ids stable.
   */
  nextId?: () => string;
}

let staticCounter = 0;

export class EventRecorder {
  private readonly branch: string;
  private readonly featureSlug: string;
  private readonly nextId: () => string;
  private readonly pinnedRoot: PinnedProjectRoot;
  private readonly ownsPinnedRoot: boolean;
  private readonly eventsRelativePath: string;
  private readonly lockRelativePath: string;
  private readonly eventsPath: string;
  private readonly maxEventBytes: number;
  private readonly maxLogBytes: number;
  private readonly maxRecords: number;
  private readonly maxAggregateBytes: number;
  private queue: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(opts: RecorderOptions) {
    this.branch = opts.branch;
    this.featureSlug = opts.featureSlug ?? "default";
    if (!isSafeFeatureSlug(this.featureSlug)) throw new PinnedRootError("invalid", "unsafe observability feature slug");
    this.maxEventBytes = validateBound(opts.maxEventBytes, MAX_EVENT_BYTES, MAX_PINNED_READ_BYTES, "event-byte");
    this.maxLogBytes = validateBound(opts.maxLogBytes, MAX_LOG_BYTES, MAX_PINNED_READ_BYTES, "log-byte");
    this.maxRecords = validateBound(opts.maxRecords, MAX_RECORDS, MAX_RECORDS, "record-count");
    this.maxAggregateBytes = validateBound(opts.maxAggregateBytes, MAX_AGGREGATE_BYTES, MAX_PINNED_READ_BYTES, "aggregate-byte");
    this.nextId =
      opts.nextId ??
      ((): string => {
        const n = staticCounter++;
        return `evt-${Date.now().toString(36)}-${n.toString(36)}`;
      });
    const suppliedRoot = opts.pinnedRoot;
    const openedRoot = suppliedRoot ?? PinnedProjectRoot.open(opts.cwd);
    if (!openedRoot) throw new PinnedRootError("unsupported", "project root could not be pinned for observability");
    this.pinnedRoot = openedRoot;
    this.ownsPinnedRoot = suppliedRoot === undefined;
    this.eventsRelativePath = join(OBSERVABILITY_PATH, this.featureSlug, OBSERVABILITY_DIR, EVENTS_FILENAME);
    this.lockRelativePath = join(OBSERVABILITY_PATH, this.featureSlug, OBSERVABILITY_DIR, `.${EVENTS_FILENAME}.lock`);
    try {
      this.pinnedRoot.ensureDirectory(join(OBSERVABILITY_PATH, this.featureSlug, OBSERVABILITY_DIR));
      this.eventsPath = this.pinnedRoot.anchorPath(this.eventsRelativePath);
    } catch (error) {
      if (this.ownsPinnedRoot) this.pinnedRoot.close();
      throw error;
    }
  }

  /** Close after queued writes drain; borrowed roots remain owned by the caller. */
  close(): void {
    if (this.closePromise) return;
    this.closing = true;
    this.closePromise = this.flush().then(() => {
      if (this.ownsPinnedRoot) this.pinnedRoot.close();
    });
  }

  async closeAsync(): Promise<void> {
    this.close();
    await this.closePromise;
  }

  /** Canonical root identity used for lifecycle-owned cache eviction. */
  get canonicalRoot(): string {
    return this.pinnedRoot.canonical_root;
  }

  /** Absolute descriptor anchor for compatibility with existing readers/tests. */
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
    if (this.closing) return Promise.reject(new PinnedRootError("changed", "observability recorder is closed"));
    const normalized = sanitizeEvent(this.pinnedRoot, event);
    const fullEvent: ObservabilityEvent = {
      ...normalized,
      id: this.nextId(),
      branch: safeIdentifier(this.branch) ?? "(unknown)",
    };
    serializedEvent(fullEvent, this.maxEventBytes);
    const operation = this.queue.then(() => this.writeOne(fullEvent));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Read the bounded event log through the pinned root. */
  readAll(): ObservabilityEvent[] {
    if (!this.pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before observability read");
    const info = this.pinnedRoot.pathEntryInfo(this.eventsRelativePath);
    if (info === null) return [];
    if (info.kind === "symlink") throw new PinnedRootError("path_unauthorized", "observability event log must not be a symbolic link");
    if (info.kind !== "file") throw new PinnedRootError("not_regular", "observability event log must be a regular file");
    const read = this.pinnedRoot.readFile(this.eventsRelativePath, { maxBytes: MAX_PINNED_READ_BYTES });
    if (!this.pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed after observability read");
    const events = parseBoundedObservabilityEvents(read.bytes, {
      maxBytes: MAX_PINNED_READ_BYTES,
      maxRecords: this.maxRecords,
      maxEventBytes: this.maxEventBytes,
      maxAggregateBytes: Math.min(this.maxLogBytes, this.maxAggregateBytes),
    });
    return compactRecent(events, this.maxRecords, this.maxLogBytes, this.maxAggregateBytes, this.maxEventBytes);
  }

  /**
   * Build the rollup by reading the bounded event log. Used on first append
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

  private relativePath(): string {
    return join(OBSERVABILITY_DIR, EVENTS_FILENAME);
  }

  private async reclaimStaleLock(): Promise<void> {
    let observed;
    try {
      observed = this.pinnedRoot.readFile(this.lockRelativePath, { maxBytes: MAX_LOCK_BYTES });
    } catch (error) {
      if (error instanceof PinnedRootError && error.code === "not_found") return;
      return;
    }
    let owner: unknown;
    try {
      owner = JSON.parse(decodeUtf8(observed.bytes, "observability lock"));
    } catch {
      return;
    }
    if (!ownerIsStale(owner)) return;
    try {
      withoutCurrentExecutionLiveness(() => this.pinnedRoot.removeFileIfMatches(this.lockRelativePath, {
        dev: observed.dev,
        ino: observed.ino,
        sha256: createHash("sha256").update(observed.bytes).digest("hex"),
      }));
    } catch {
      // A replacement lock or root change wins; the next bounded attempt will
      // observe the current state again.
    }
  }
  private async acquireLock(): Promise<{ token: string }> {
    const token = randomUUID();
    const owner = JSON.stringify({
      schema_version: 1,
      token,
      pid: process.pid,
      start_identity: SELF_START_IDENTITY,
      operation: "observability_append",
    });
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      if (this.pinnedRoot.tryAcquireExclusiveLock(
        `${this.lockRelativePath}.${randomUUID()}.candidate`,
        this.lockRelativePath,
        `${owner}\n`,
      )) return { token };
      await this.reclaimStaleLock();
      if (attempt + 1 < LOCK_ATTEMPTS) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
    throw new PinnedRootError("write_failed", "observability event log lock could not be acquired within the bounded retry budget");
  }

  private serializeLog(events: ReadonlyArray<ObservabilityEvent>): Buffer {
    const encoded = events.map((event) => serializedEvent(event, this.maxEventBytes));
    const total = encoded.reduce((sum, bytes) => sum + bytes.byteLength, 0);
    const budget = Math.min(this.maxLogBytes, this.maxAggregateBytes);
    if (total > budget) throw new PinnedRootError("limit", "observability event log exceeds its bounded byte budget");
    return Buffer.concat(encoded, total);
  }

  private async writeOne(event: ObservabilityEvent): Promise<ObservabilityEvent> {
    const evidenceError = envelopeError(event);
    if (evidenceError) throw new Error(evidenceError);
    const lock = await this.acquireLock();
    let primaryError: unknown = null;
    try {
      if (!this.pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before observability append");
      const existing = this.readAll();
      const candidateReplayKey = replayKey(event);
      if (candidateReplayKey) {
        const replay = existing.find((candidate) => replayKey(candidate) === candidateReplayKey);
        if (replay) return replay;
      }
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
      const retained = compactRecent([...existing, event], this.maxRecords, this.maxLogBytes, this.maxAggregateBytes, this.maxEventBytes);
      const encoded = this.serializeLog(retained);
      this.pinnedRoot.writeAtomic(this.eventsRelativePath, encoded);
      const committed = this.pinnedRoot.readFile(this.eventsRelativePath, { maxBytes: MAX_PINNED_READ_BYTES });
      if (Buffer.compare(Buffer.from(committed.bytes), encoded) !== 0) {
        throw new PinnedRootError("changed", "observability event log changed during append");
      }
      if (!this.pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed after observability append");
      return event;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        withoutCurrentExecutionLiveness(() => this.pinnedRoot.releaseExclusiveLock(this.lockRelativePath, lock.token));
      } catch (error) {
        if (primaryError === null) throw error;
      }
    }
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
  if (!isSafeFeatureSlug(featureSlug)) throw new PinnedRootError("invalid", "unsafe observability feature slug");
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) throw new PinnedRootError("unsupported", "project root could not be pinned for observability pointer read");
  const eventsPath = join(OBSERVABILITY_PATH, featureSlug, OBSERVABILITY_DIR, EVENTS_FILENAME);
  try {
    if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before observability pointer read");
    const info = pinnedRoot.pathEntryInfo(eventsPath);
    if (info === null) return null;
    if (info.kind === "symlink") throw new PinnedRootError("path_unauthorized", "observability event log must not be a symbolic link");
    if (info.kind !== "file") throw new PinnedRootError("not_regular", "observability event log must be a regular file");
    const read = pinnedRoot.readFile(eventsPath, { maxBytes: MAX_PINNED_READ_BYTES });
    if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed after observability pointer read");
    const events = compactRecent(
      parseBoundedObservabilityEvents(read.bytes, {
        maxBytes: MAX_PINNED_READ_BYTES,
        maxRecords: MAX_RECORDS,
        maxEventBytes: MAX_EVENT_BYTES,
        maxAggregateBytes: Math.min(MAX_LOG_BYTES, MAX_AGGREGATE_BYTES),
      }),
      MAX_RECORDS,
      MAX_LOG_BYTES,
      MAX_AGGREGATE_BYTES,
      MAX_EVENT_BYTES,
    );
    const last = events[events.length - 1];
    return {
      eventsPath: join(OBSERVABILITY_DIR, EVENTS_FILENAME),
      lastEventId: last?.id ?? "",
      rollupThroughId: last?.id ?? "",
      rollup: rollupFromEvents(events),
    };
  } finally {
    pinnedRoot.close();
  }
}

/** Write the pointer inside the feature's observability directory. */
export function writePointerSync(
  cwd: string,
  featureSlug: string,
  pointer: ObservabilityPointer,
): void {
  if (!isSafeFeatureSlug(featureSlug)) throw new PinnedRootError("invalid", "unsafe observability feature slug");
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) throw new PinnedRootError("unsupported", "project root could not be pinned for observability pointer write");
  const obsDir = join(OBSERVABILITY_PATH, featureSlug, OBSERVABILITY_DIR);
  const pointerPath = join(obsDir, "pointer.json");
  try {
    pinnedRoot.ensureDirectory(obsDir);
    const text = JSON.stringify(pointer, null, 2);
    const bytes = Buffer.from(`${text}\n`, "utf8");
    if (bytes.byteLength > MAX_POINTER_BYTES) throw new PinnedRootError("limit", "observability pointer exceeds its bounded byte limit");
    if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before observability pointer write");
    pinnedRoot.writeAtomic(pointerPath, bytes);
    if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed after observability pointer write");
  } finally {
    pinnedRoot.close();
  }
}
