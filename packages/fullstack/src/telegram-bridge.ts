/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

import { createHash } from "node:crypto";
import {
  createDiagnostic,
  failureResult,
  isCanonicalRoot,
  isTrustedFsAuthority,
  successResult,
  validateWorkflowRunIdentity,
  type DiagnosticResult,
  type EscalationAnswer,
  type EscalationInboundMessage,
  type TrustedFsAuthority,
  type WorkflowRunIdentity,
} from "@andvl1/omp-workflows-core";
import {
  isFullstackStorageAuthority,
  type FullstackStorageAuthority,
} from "./storage-authority.js";
import { validateInboundAnswerRecord, validateInboundTaskRecord } from "./adapters/registry.js";
import type { AdapterRuntimeContext } from "./adapters/registry.js";

export interface BridgeRuntimeContext extends AdapterRuntimeContext {
  readonly run_status: "active" | "completed" | "unavailable";
  readonly storage: FullstackStorageAuthority;
  readonly summary?: Record<string, unknown>;
}

export interface BridgeIncoming extends EscalationInboundMessage { readonly by?: string; }

export interface BridgeResult {
  readonly action: "active-task" | "completed-status" | "unavailable";
  readonly reply?: string;
  readonly filedPath?: string | null;
  readonly runId: string;
}

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;

function sameRun(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("non-JSON record");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function exactRecord(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function durableFilenameKey(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function contextDiagnostic(context: BridgeRuntimeContext): DiagnosticResult<BridgeRuntimeContext> {
  if (!context || !isCanonicalRoot(context.project_root)) return failureResult(createDiagnostic({ code: "ROOT_UNAVAILABLE", operation: "root.resolve", evidence: { field: "project_root" }, remediation: "Provide the canonical root from the root manager." }));
  if (!isTrustedFsAuthority(context.filesystem_authority)) return failureResult(createDiagnostic({ code: "CAPABILITY_MISSING", operation: "runtime.activate", evidence: { field: "filesystem_authority" }, remediation: "Provide the launcher-issued trusted filesystem authority." }));
  if (!isFullstackStorageAuthority(context.storage)) return failureResult(createDiagnostic({ code: "CAPABILITY_MISSING", operation: "runtime.activate", evidence: { field: "storage" }, remediation: "Provide the launcher-issued FullstackStorageAuthority before bridge persistence." }));
  const run = validateWorkflowRunIdentity(context.run_identity);
  if (!run.ok) return failureResult(createDiagnostic({ code: "IDENTITY_MISMATCH", operation: "runtime.activate", evidence: { field: "run_identity" }, remediation: "Provide the complete WorkflowRunIdentity selected by workflow_prepare." }));
  if (context.storage.project_root !== context.project_root || !sameRun(context.storage.run_identity, run.value)) return failureResult(createDiagnostic({ code: "IDENTITY_MISMATCH", operation: "runtime.activate", evidence: { field: "storage" }, remediation: "Pin bridge storage to the exact canonical root and WorkflowRunIdentity." }));
  return successResult(Object.freeze({ ...context, run_identity: run.value, storage: context.storage }));
}

function writeExclusiveRecord(storage: FullstackStorageAuthority, relativePath: string, record: unknown): DiagnosticResult<string | null> {
  const written = storage.writeJsonExclusive(relativePath, bytesOf(record));
  if (written.ok) return successResult(relativePath);
  const existing = storage.readJsonBounded(relativePath, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
  if (existing.ok && existing.value !== null && exactRecord(existing.value, record)) return successResult(null);
  return failureResult(createDiagnostic({ code: written.reason === "IDENTITY_MISMATCH" ? "IDENTITY_MISMATCH" : written.reason === "CAPABILITY_MISSING" ? "CAPABILITY_MISSING" : written.reason === "MIGRATION_REQUIRED" ? "MIGRATION_REQUIRED" : "ACTIVATION_FAILED", operation: "runtime.activate", evidence: { field: "message.persistence" }, remediation: "Retry after the pinned project inbox becomes writable; conflicting records are rejected." }));
}

/** Write a plain message into the manager-owned local drop. */
export function writeTaskDrop(context: BridgeRuntimeContext, msg: BridgeIncoming): DiagnosticResult<string | null> {
  const checked = contextDiagnostic(context);
  if (!checked.ok) return checked as DiagnosticResult<string | null>;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return failureResult(createDiagnostic({ code: "CONFIG_MALFORMED", operation: "runtime.activate", evidence: { field: "message" }, remediation: "Provide a structured inbound message envelope." }));
  const messageRun = validateWorkflowRunIdentity(msg.run_identity);
  if (!messageRun.ok || !sameRun(messageRun.value, checked.value.run_identity)) return failureResult(createDiagnostic({ code: "IDENTITY_MISMATCH", operation: "runtime.activate", evidence: { field: "message.run_identity" }, remediation: "Route the message using the exact prepared workflow run." }));
  const record = validateInboundTaskRecord(msg, checked.value.run_identity);
  if (!record) return failureResult(createDiagnostic({ code: "CONFIG_MALFORMED", operation: "runtime.activate", evidence: { field: "message" }, remediation: "Provide a complete bounded inbound task record before persistence." }));
  return writeExclusiveRecord(checked.value.storage, `.omp/inbox/task-${durableFilenameKey(record.id)}.json`, record);
}

/** Build a human-readable status reply from a caller-supplied summary. */
export function buildStatusReply(runId: string, summary: Record<string, unknown>): string {
  const verdict = String(summary.verdict ?? "?");
  const lines = [`CTO run \`${runId}\` is FINISHED (verdict: ${verdict}).`, ""];
  const firstSweep = summary.first_sweep;
  if (firstSweep && typeof firstSweep === "object" && !Array.isArray(firstSweep)) {
    lines.push("Status per item:");
    for (const [key, value] of Object.entries(firstSweep as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const action = String(item.action ?? "");
      const state = String(item.state ?? "");
      lines.push(`- ${key}: ${action}${state ? ` — ${state}` : ""}`);
    }
  } else lines.push(`Details: .work-state/cto/${runId}/summary.json`);
  return lines.join("\n");
}
export function classifyIncoming(context: BridgeRuntimeContext, msg: BridgeIncoming): BridgeResult {
  const checked = contextDiagnostic(context);
  const contextRunId = context && typeof context === "object" && context.run_identity && typeof context.run_identity.run_id === "string" ? context.run_identity.run_id : "";
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { action: "unavailable", reply: "The message could not be associated with the exact prepared CTO run.", runId: contextRunId };
  const messageRun = validateWorkflowRunIdentity(msg.run_identity);
  if (!checked.ok || !messageRun.ok || !context.run_identity || !sameRun(messageRun.value, context.run_identity)) return { action: "unavailable", reply: "The message could not be associated with the exact prepared CTO run.", runId: contextRunId };
  if (context.run_status === "active") {
    const filed = writeTaskDrop(context, msg);
    return { action: "active-task", filedPath: filed.ok ? filed.value : null, runId: contextRunId };
  }
  if (context.run_status === "completed" && context.summary) {
    const filed = writeTaskDrop(context, msg);
    return { action: "completed-status", reply: buildStatusReply(context.run_identity.run_id, context.summary), filedPath: filed.ok ? filed.value : null, runId: contextRunId };
  }
  return { action: "unavailable", reply: "No prepared CTO run is available for this message. Start /cto before sending tasks.", runId: contextRunId };
}

/** Write a run-bound answer marker; polling routes it to onAnswer, never onTask. */
export function writeAnswerMarker(context: BridgeRuntimeContext, answer: EscalationAnswer): DiagnosticResult<string | null> {
  const checked = contextDiagnostic(context);
  if (!checked.ok) return checked as DiagnosticResult<string | null>;
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return failureResult(createDiagnostic({ code: "CONFIG_MALFORMED", operation: "runtime.activate", evidence: { field: "answer" }, remediation: "Provide a structured answer envelope." }));
  const answerRun = validateWorkflowRunIdentity(answer.run_identity);
  if (!answerRun.ok || !sameRun(answerRun.value, checked.value.run_identity)) return failureResult(createDiagnostic({ code: "IDENTITY_MISMATCH", operation: "runtime.activate", evidence: { field: "answer.run_identity" }, remediation: "Write answer markers only for the exact prepared workflow run." }));
  const validated = validateInboundAnswerRecord(answer, checked.value.run_identity);
  if (!validated) return failureResult(createDiagnostic({ code: "CONFIG_MALFORMED", operation: "runtime.activate", evidence: { field: "answer" }, remediation: "Provide a complete bounded answer record before persistence." }));
  const record = { kind: "answer" as const, id: validated.id, text: validated.answer, answer: validated.answer, at: validated.at, by: validated.by, run_identity: checked.value.run_identity };
  return writeExclusiveRecord(checked.value.storage, `.omp/inbox/answer-${durableFilenameKey(validated.id)}.json`, record);
}

export type BridgeFilesystemAuthority = FullstackStorageAuthority;
