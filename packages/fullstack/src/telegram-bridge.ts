/**
 * Telegram bridge — autonomous messenger bridge that works WITHOUT a live
 * omp session (the case the in-session dispatcher cannot cover: the CTO
 * finished, the session is closed, the user still writes to the bot).
 *
 * Classification of an incoming plain message:
 *   - active CTO run  -> file as a task in the local drop
 *     (`<root>/.omp/inbox/`, the in-session dispatcher picks it up in <=10s)
 *     and do NOT reply (the CTO session owns the conversation);
 *   - no active run, but a terminal run in the authenticated delivery index -> reply with the
 *     bounded status derived from canonical state (no LLM), AND file the message as a
 *     standby task (the user may have meant a new task, not just a status
 *     question — nothing is lost);
 *   - nothing at all -> create a standby run, file the task, reply that it
 *     was saved and will be picked up at the next /cto start.
 *
 * Escalation answers (reply to a mapped escalation / inline button) are
 * written by `TelegramEscalationAdapter.pollOnce` itself; the bridge only
 * needs the plain-message handler.
 *
 * Writes are idempotent (wx) and replies are deduped per message_id in
 * memory, so duplicate getUpdates deliveries never double-send.
 *
 * ONE consumer per bot token: the bridge owns getUpdates. Do not run it
 * together with a live interactive session on the same token unless you
 * accept 2x polling traffic (duplicates are harmless due to idempotency).
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { isSafeEscalationId, isSafeCtoRunId, isSafeCtoInboundText, PinnedProjectRoot } from "@andvl1/omp-workflows-core";
import type { CtoRuntimeAccessFacade } from "@andvl1/omp-workflows-core/cto-runtime";
import { openBoundedQueue, type BoundedQueue } from "@andvl1/omp-workflows-core/queue";
import { createAuthenticatedInboxEnvelope, ensureStandbyRun, inboxMessageFileName, isBridgeAlive, isBridgeAuthenticationLeaseCurrent, MAX_INBOX_TEXT_LENGTH, verifyAuthenticatedInboxEnvelope, writeBridgeLock } from "./adapters/registry.js";
import { readBoundedResponseText } from "./lecture-acquisition/provider-errors.js";

function decodeTelegramUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export interface BridgeIncoming {
  id: string;
  text: string;
  at: string;
  by?: string;
  /** Raw Telegram origin; used to send replies back to the source chat. */
  chatId?: string;
  userId?: string;
  messageId?: number;
}

export interface BridgeResult {
  action: "active-task" | "completed-status" | "standby-task";
  /** Reply to send to the user; undefined for active-task (session owns it). */
  reply?: string;
  /** Task file written (or null when the write lost the wx race). */
  filedPath?: string | null;
  runId?: string;
  /** Source chat for a standalone bridge reply. */
  chatId?: string;
}

function ensureBridgeSession(cwd: string, pinnedRoot?: PinnedProjectRoot): void {
  if (pinnedRoot && !pinnedRoot.isStable()) throw new Error("telegram bridge project root is unstable");
  if (!isBridgeAlive(cwd, pinnedRoot)) writeBridgeLock(cwd, pinnedRoot);
  if (!isBridgeAlive(cwd, pinnedRoot)) throw new Error("telegram bridge authentication lease is unavailable");
  if (pinnedRoot && !pinnedRoot.isStable()) throw new Error("telegram bridge project root changed during session acquisition");
}

function withBridgeRoot<T>(cwd: string, suppliedPin: PinnedProjectRoot | undefined, action: (pinnedRoot: PinnedProjectRoot) => T): T {
  const pinnedRoot = suppliedPin ?? PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) throw new Error("telegram bridge project root is unavailable");
  try {
    if (!pinnedRoot.isStable()) throw new BridgeRetryableError("telegram bridge project root is unstable");
    return action(pinnedRoot);
  } finally {
    if (!suppliedPin) pinnedRoot.close();
  }
}

/** File an authenticated message in the local drop (wx-idempotent). */
export function writeTaskDrop(cwd: string, msg: BridgeIncoming, runId?: string, suppliedPin?: PinnedProjectRoot, runtimeAccess?: CtoRuntimeAccessFacade): string | null {
  if (!isSafeCtoInboundText(msg.text, MAX_INBOX_TEXT_LENGTH) || (runId !== undefined && !isSafeCtoRunId(runId))) return null;
  return withBridgeRoot(cwd, suppliedPin, (pinnedRoot) => {
    ensureBridgeSession(cwd, pinnedRoot);
    const resolved = runId ?? runtimeAccess?.findActiveRun()?.runId ?? (runtimeAccess ? ensureStandbyRun(cwd, pinnedRoot, runtimeAccess) : null);
    if (!resolved) return null;
    const envelope = createAuthenticatedInboxEnvelope(cwd, "task", { id: msg.id, text: msg.text, at: msg.at, by: msg.by ?? "telegram-bridge", run_id: resolved }, pinnedRoot);
    if (!pinnedRoot.isStable()) throw new Error("telegram bridge project root changed before task drop");
    const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".omp", "inbox"), { pinnedRoot });
    if (!queue) throw new Error("telegram bridge local inbox is unavailable or unsafe");
    try {
      const filed = writeInboxTaskFile(queue, inboxMessageFileName(msg.id), envelope, pinnedRoot, cwd);
      if (!pinnedRoot.isStable() || !isBridgeAuthenticationLeaseCurrent(cwd, pinnedRoot, envelope.auth.session_id)) throw new BridgeRetryableError("telegram bridge auth lease changed after task drop");
      return filed;
    } finally {
      queue.close();
    }
  });
}

/** File an authenticated message under a standby run inbox (wx-idempotent). */
export function writeStandbyTask(cwd: string, msg: BridgeIncoming, runId?: string, suppliedPin?: PinnedProjectRoot, runtimeAccess?: CtoRuntimeAccessFacade): string | null {
  if (!isSafeCtoInboundText(msg.text, MAX_INBOX_TEXT_LENGTH) || (runId !== undefined && !isSafeCtoRunId(runId))) return null;
  return withBridgeRoot(cwd, suppliedPin, (pinnedRoot) => {
    ensureBridgeSession(cwd, pinnedRoot);
    const resolved = runId ?? (runtimeAccess ? ensureStandbyRun(cwd, pinnedRoot, runtimeAccess) : null);
    if (!resolved) return null;
    const envelope = createAuthenticatedInboxEnvelope(cwd, "task", { id: msg.id, text: msg.text, at: msg.at, by: msg.by ?? "telegram-bridge", run_id: resolved }, pinnedRoot);
    if (!pinnedRoot.isStable()) throw new Error("telegram bridge project root changed before standby task drop");
    const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".work-state", "cto", resolved, "inbox"), { pinnedRoot });
    if (!queue) throw new Error("telegram bridge standby inbox is unavailable or unsafe");
    try {
      const filed = writeInboxTaskFile(queue, inboxMessageFileName(msg.id), envelope, pinnedRoot, cwd);
      if (!pinnedRoot.isStable() || !isBridgeAuthenticationLeaseCurrent(cwd, pinnedRoot, envelope.auth.session_id)) throw new BridgeRetryableError("telegram bridge auth lease changed after standby task drop");
      return filed;
    } finally {
      queue.close();
    }
  });
}


function writeInboxTaskFile(queue: BoundedQueue, fileName: string, envelope: unknown, pinnedRoot: PinnedProjectRoot, cwd: string): string | null {
  const serialized = JSON.stringify(envelope, null, 2);
  try {
    queue.writeExclusive(fileName, serialized);
    return queue.path(fileName);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "exists")) throw error;
    let existing: { dev: number; ino: number; bytes: Uint8Array };
    try {
      existing = queue.read(fileName);
    } catch {
      throw new BridgeRetryableError("telegram bridge task collision cannot be read (existing path may be a directory)");
    }
    const current = envelope as unknown as Record<string, unknown>;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(decodeTelegramUtf8(existing.bytes)) as Record<string, unknown>; } catch { throw new BridgeRetryableError("telegram bridge task collision is malformed"); }
    // A predictable filename is not an idempotency proof. Verify the bounded
    // envelope MAC first, then bind every durable field to this exact route.
    const verified = verifyAuthenticatedInboxEnvelope(cwd, parsed, "task", pinnedRoot, MAX_INBOX_TEXT_LENGTH, false);
    if (!verified || !equivalentBridgeEnvelope(verified, current, "task") || verified.run_id !== current.run_id) {
      throw new BridgeRetryableError("telegram bridge task filename collision");
    }
    if (Buffer.from(existing.bytes).equals(Buffer.from(serialized, "utf8"))) return null;
    if (!pinnedRoot.isStable()) throw new BridgeRetryableError("telegram bridge root changed before task re-sign");
    const resigned = createAuthenticatedInboxEnvelope(cwd, "task", {
      id: verified.id,
      text: verified.text,
      at: verified.at,
      by: verified.by,
      run_id: verified.run_id,
    }, pinnedRoot);
    const resignedBytes = Buffer.from(JSON.stringify(resigned, null, 2), "utf8");
    try {
      queue.replaceIfMatches(fileName, { dev: existing.dev, ino: existing.ino, sha256: createHash("sha256").update(existing.bytes).digest("hex") }, resignedBytes.toString("utf8"));
    } catch {
      throw new BridgeRetryableError("telegram bridge task re-sign failed");
    }
    if (!pinnedRoot.isStable() || !isBridgeAuthenticationLeaseCurrent(cwd, pinnedRoot, resigned.auth.session_id)) throw new BridgeRetryableError("telegram bridge auth lease changed after task re-sign");
    return null;
  }
}

/**
/**
 * Read the latest terminal status from the engine-authenticated delivery
 * index and state projection. The workspace summary.json is intentionally not
 * read: it has no engine-owned byte commitment and therefore cannot influence
 * a Telegram reply.
 */
export function findCompletedSummary(cwd: string, suppliedPin?: PinnedProjectRoot, runtimeAccess?: CtoRuntimeAccessFacade): { runId: string; summary: Record<string, unknown> } | null {
  return withBridgeRoot(cwd, suppliedPin, (pinnedRoot) => {
    if (!runtimeAccess) return null;
    try {
      runtimeAccess.assertLive();
      if (!pinnedRoot.isStable()) return null;
      const indexed = runtimeAccess.readCompletedDeliveryCandidates();
      if (!indexed.ok) return null;
      const verified: Array<{ runId: string; summary: Record<string, unknown>; at: number; revision: number }> = [];
      for (const candidate of indexed.entries) {
        const at = Date.parse(candidate.updated_at);
        // A future-dated index/state cannot establish recency and is ignored.
        if (!Number.isFinite(at) || at > Date.now()) continue;
        const state = runtimeAccess.readState(candidate.run_id);
        const summary = canonicalStatusSummary(candidate.run_id, candidate, state);
        if (!summary) continue;
        verified.push({ runId: candidate.run_id, summary, at, revision: candidate.state_revision });
      }
      runtimeAccess.assertLive();
      if (!pinnedRoot.isStable()) return null;
      verified.sort((left, right) => right.at - left.at || right.revision - left.revision || left.runId.localeCompare(right.runId));
      const best = verified[0];
      return best ? { runId: best.runId, summary: best.summary } : null;
    } catch {
      // RuntimeAccess failures are unavailable, never a directory-scan fallback.
      return null;
    }
  });
}

interface CanonicalStatusWave {
  id: string;
  status: "active" | "done" | "failed";
  started_at: string;
  finished_at?: string;
  outcome?: "pass" | "blocked";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalStatusSummary(
  runId: string,
  candidate: { run_id: string; status: string; updated_at: string; state_revision: number },
  state: Readonly<Record<string, unknown>> | null,
): Record<string, unknown> | null {
  if (!state || state.id !== runId || candidate.run_id !== runId) return null;
  if (candidate.status !== "done" && candidate.status !== "failed") return null;
  if (state.updated_at !== candidate.updated_at) return null;
  const pause = state.pause;
  if (!isRecord(pause) || (pause.kind !== "done" && pause.kind !== "failed")) return null;
  const canonicalStatus = pause.kind === "failed" ? "failed" : "done";
  if (canonicalStatus !== candidate.status) return null;

  const summary: Record<string, unknown> = {
    status: canonicalStatus,
    updated_at: candidate.updated_at,
    waves: [],
  };
  const waves: CanonicalStatusWave[] = [];
  const rawWaves = state.wave_history;
  if (rawWaves !== undefined) {
    if (!Array.isArray(rawWaves) || rawWaves.length > MAX_STATUS_ROWS) return null;
    for (const rawWave of rawWaves) {
      if (!isRecord(rawWave)
        || typeof rawWave.id !== "string"
        || (rawWave.status !== "active" && rawWave.status !== "done" && rawWave.status !== "failed")
        || typeof rawWave.started_at !== "string"
        || !Number.isFinite(Date.parse(rawWave.started_at))) return null;
      if (rawWave.status !== "active"
        && (typeof rawWave.finished_at !== "string" || !Number.isFinite(Date.parse(rawWave.finished_at)))) return null;
      if (rawWave.finished_at !== undefined && (typeof rawWave.finished_at !== "string" || !Number.isFinite(Date.parse(rawWave.finished_at)))) return null;
      const outcome = rawWave.outcome === "pass" || rawWave.outcome === "blocked" ? rawWave.outcome : undefined;
      waves.push({
        id: rawWave.id,
        status: rawWave.status,
        started_at: rawWave.started_at,
        ...(rawWave.finished_at === undefined ? {} : { finished_at: rawWave.finished_at }),
        ...(outcome === undefined ? {} : { outcome }),
      });
    }
  }
  summary.waves = waves;

  // These are engine-owned terminal fields. Do not infer a verdict from
  // summary.json, pause.reason, integration.note, or any other free-form text.
  const integration = state.integration;
  const completion = state.completion_envelope;
  const completionOutcome = isRecord(completion) && (completion.outcome === "succeeded" || completion.outcome === "failed" || completion.outcome === "cancelled")
    ? completion.outcome
    : undefined;
  let verdict: string | undefined;
  if (canonicalStatus === "failed" || (isRecord(integration) && integration.status === "failed")) verdict = "failed";
  else if (completionOutcome) verdict = completionOutcome;
  else if (waves.some((wave) => wave.outcome === "blocked")) verdict = "blocked";
  else if (waves.length > 0 && waves.every((wave) => wave.status !== "active" && wave.outcome === "pass")) verdict = "pass";
  if (verdict) summary.verdict = verdict;
  return summary;
}

const MAX_STATUS_REPLY_CODEPOINTS = 4096;
const MAX_STATUS_ROWS = 4096;
const MAX_STATUS_KEY_CODEPOINTS = 256;
const MAX_STATUS_FIELD_CODEPOINTS = 1024;

function statusText(value: unknown, fallback = ""): string {
  return String(value ?? fallback).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "�");
}

function truncateStatus(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}

function isPlainStatusObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function malformedStatusReply(runId: string): string {
  return truncateStatus(`CTO run \`${statusText(runId, "?")}\` status unavailable: malformed summary.`, MAX_STATUS_REPLY_CODEPOINTS);
}

/** Build a human status reply from an engine-authenticated state projection (no LLM). */
export function buildStatusReply(runId: string, summary: Record<string, unknown>): string {
  if (summary.status !== "done" && summary.status !== "failed"
    || typeof summary.updated_at !== "string"
    || !Number.isFinite(Date.parse(summary.updated_at))
    || !Array.isArray(summary.waves)
    || summary.waves.length > MAX_STATUS_ROWS) return malformedStatusReply(runId);
  const safeRunId = statusText(runId, "?");
  const safeStatus = statusText(summary.status);
  const safeUpdatedAt = statusText(summary.updated_at);
  const base = [`CTO run \`${safeRunId}\` is FINISHED (status: ${safeStatus}).`, `Updated: ${safeUpdatedAt}`];
  if (summary.verdict !== undefined) {
    if (typeof summary.verdict !== "string" || Array.from(summary.verdict).length > MAX_STATUS_FIELD_CODEPOINTS) return malformedStatusReply(runId);
    base.push(`Verdict: ${statusText(summary.verdict)}.`);
  }
  const rows: string[] = [];
  for (const rawWave of summary.waves) {
    if (!isPlainStatusObject(rawWave)
      || typeof rawWave.id !== "string"
      || (rawWave.status !== "active" && rawWave.status !== "done" && rawWave.status !== "failed")
      || typeof rawWave.started_at !== "string"
      || !Number.isFinite(Date.parse(rawWave.started_at))
      || (rawWave.finished_at !== undefined && (typeof rawWave.finished_at !== "string" || !Number.isFinite(Date.parse(rawWave.finished_at))))
      || (rawWave.outcome !== undefined && rawWave.outcome !== "pass" && rawWave.outcome !== "blocked")) return malformedStatusReply(runId);
    const when = rawWave.finished_at ?? rawWave.started_at;
    const outcome = rawWave.outcome === undefined ? "" : ` — outcome: ${rawWave.outcome}`;
    rows.push(`- ${statusText(rawWave.id)}: ${rawWave.status}${outcome} (${statusText(when)})`);
  }
  if (rows.length === 0) return truncateStatus(base.join("\n"), MAX_STATUS_REPLY_CODEPOINTS);
  base.push("Status per wave:");
  const full = [...base, ...rows].join("\n");
  if (Array.from(full).length <= MAX_STATUS_REPLY_CODEPOINTS) return full;
  const suffix = `… and ${Math.max(0, rows.length - 1)} more`;
  const kept: string[] = [];
  for (const row of rows) {
    const candidate = [...base, ...kept, row, suffix].join("\n");
    if (Array.from(candidate).length > MAX_STATUS_REPLY_CODEPOINTS) break;
    kept.push(row);
  }
  return truncateStatus([...base, ...kept, suffix].join("\n"), MAX_STATUS_REPLY_CODEPOINTS);
}

/** Classify an incoming plain message and file it; returns the reply (if any). */
export function classifyIncoming(cwd: string, msg: BridgeIncoming, suppliedPin?: PinnedProjectRoot, runtimeAccess?: CtoRuntimeAccessFacade): BridgeResult {
  return withBridgeRoot(cwd, suppliedPin, (pinnedRoot) => {
    if (!runtimeAccess) throw new BridgeRetryableError("telegram bridge runtime access is unavailable");
    const active = runtimeAccess.findActiveRun();
    if (active) {
      return {
        action: "active-task",
        filedPath: writeTaskDrop(cwd, msg, active.runId, pinnedRoot, runtimeAccess),
        runId: active.runId,
        chatId: msg.chatId,
      };
    }
    const completed = findCompletedSummary(cwd, pinnedRoot, runtimeAccess);
    if (completed) {
      return {
        action: "completed-status",
        reply: buildStatusReply(completed.runId, completed.summary),
        filedPath: writeStandbyTask(cwd, msg, undefined, pinnedRoot, runtimeAccess),
        runId: completed.runId,
        chatId: msg.chatId,
      };
    }
    const runId = ensureStandbyRun(cwd, pinnedRoot, runtimeAccess);
    return {
      action: "standby-task",
      reply:
        "CTO is not active right now and no completed run is available to report. " +
        `Your message was saved as a task in standby run \`${runId}\` and will be picked up ` +
        "when a CTO session starts (/cto).",
      filedPath: writeStandbyTask(cwd, msg, runId, pinnedRoot, runtimeAccess),
      runId,
      chatId: msg.chatId,
    };
  });
}

/** Send a plain text message (no reply markup) — used for bridge replies. */
export async function sendTelegramText(
  token: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) return false;
    const raw = await readBoundedResponseText(response, 64 * 1024, "telegram-bridge");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return false; }
    return typeof body === "object" && body !== null && "ok" in body && body.ok === true;
  } catch {
    return false;
  }
}

const MAX_ANSWER_MARKER_METADATA_BYTES = 256;

function isSafeAnswerMarkerText(value: unknown): value is string {
  return isSafeCtoInboundText(value, MAX_INBOX_TEXT_LENGTH);
}

function isSafeAnswerMarkerMetadata(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_ANSWER_MARKER_METADATA_BYTES
    && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function isSafeBridgeTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 64 || /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function isSafeBridgeMessageId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 512
    && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function exactBridgeKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

interface BridgeEnvelopeRecord {
  schema: 2;
  kind: "task" | "answer";
  id: string;
  text: string;
  at: string;
  by: string;
  run_id: string;
  auth: Record<string, unknown>;
}

/** Validate all collision metadata before preserving an existing target. */
function equivalentBridgeEnvelope(existing: unknown, current: Record<string, unknown>, kind: "task" | "answer"): existing is BridgeEnvelopeRecord {
  if (!exactBridgeKeys(existing, ["at", "auth", "by", "id", "kind", "run_id", "schema", "text"])) return false;
  const auth = existing.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return false;
  const authRecord = auth as Record<string, unknown>;
  const mode = authRecord.mode;
  const expectedAuthKeys = mode === undefined ? ["mac", "nonce", "session_id"] : ["mac", "mode", "nonce", "session_id"];
  if ((mode !== undefined && mode !== "durable") || !exactBridgeKeys(auth, expectedAuthKeys)
    || typeof authRecord.session_id !== "string" || !isSafeAnswerMarkerMetadata(authRecord.session_id)
    || typeof authRecord.nonce !== "string" || authRecord.nonce.length < 16 || authRecord.nonce.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(authRecord.nonce)
    || typeof authRecord.mac !== "string" || !/^[0-9a-f]{64}$/iu.test(authRecord.mac)) return false;
  return existing.schema === 2
    && existing.kind === kind
    && existing.id === current.id && (kind === "answer" ? isSafeEscalationId(existing.id) : isSafeBridgeMessageId(existing.id))
    && existing.text === current.text && isSafeAnswerMarkerText(existing.text)
    && existing.by === current.by && isSafeAnswerMarkerMetadata(existing.by)
    && existing.at === current.at && isSafeBridgeTimestamp(existing.at)
    && typeof existing.run_id === "string" && isSafeCtoRunId(existing.run_id)
    && existing.run_id === current.run_id;
}

/**
 * File an answer marker in the local drop ({ kind: "answer" }) so a live
 * session wakes [CTO-ANSWER] even though it does not poll telegram while the
 * bridge owns the bot. Deterministic name by esc id (wx) — no duplicates.
 */
export class BridgeRetryableError extends Error {
  readonly code = "TELEGRAM_BRIDGE_RETRYABLE";
  constructor(message = "telegram bridge durable write is retryable") {
    super(message);
    this.name = "BridgeRetryableError";
  }
}

export function writeAnswerMarker(
  cwd: string,
  answer: { id: string; run_id: string; answer: string; at?: string; by?: string },
  suppliedPin?: PinnedProjectRoot,
  runtimeAccess?: CtoRuntimeAccessFacade,
): string | null {
  const id = answer?.id;
  const runId = answer?.run_id;
  const text = answer?.answer;
  const by = answer?.by ?? "telegram-bridge";
  const at = answer?.at ?? new Date().toISOString();
  // Invalid/foreign answers are an ordinary rejection. Durable I/O and root
  // identity failures throw so the poll loop leaves the update offset alone.
  if (!isSafeEscalationId(id) || !isSafeCtoRunId(runId) || !isSafeAnswerMarkerText(text) || !isSafeAnswerMarkerMetadata(by) || !isSafeBridgeTimestamp(at)) return null;
  return withBridgeRoot(cwd, suppliedPin, (pinnedRoot) => {
    if (!pinnedRoot.isStable()) throw new BridgeRetryableError("telegram bridge root changed before marker lookup");
    const active = runtimeAccess?.findActiveRun();
    if (!pinnedRoot.isStable()) throw new BridgeRetryableError("telegram bridge root changed during marker authority lookup");
    if (!runtimeAccess || !active || active.runId !== runId) return null;
    ensureBridgeSession(cwd, pinnedRoot);
    if (!pinnedRoot.isStable()) throw new BridgeRetryableError("telegram bridge root changed before marker write");
    const envelope = createAuthenticatedInboxEnvelope(cwd, "answer", { id, text, at, by, run_id: runId }, pinnedRoot);
    if (!pinnedRoot.isStable()) throw new BridgeRetryableError("telegram bridge root changed before marker queue");
    const queue = openBoundedQueue(pinnedRoot.canonical_root, join(".omp", "inbox"), { pinnedRoot });
    if (!queue) throw new BridgeRetryableError("telegram bridge marker queue is unavailable");
    try {
      const file = inboxMessageFileName(id);
      try {
        queue.writeExclusive(file, JSON.stringify(envelope, null, 2));
        if (!pinnedRoot.isStable() || !isBridgeAuthenticationLeaseCurrent(cwd, pinnedRoot, envelope.auth.session_id)) throw new BridgeRetryableError("telegram bridge auth lease changed after marker write");
        return queue.path(file);
      } catch (error) {
        if (error instanceof BridgeRetryableError) throw error;
        // Only a readable, equivalent existing marker is a duplicate. A
        // missing/unreadable entry or queue I/O error is retryable.
        let existing: { dev: number; ino: number; bytes: Uint8Array };
        try { existing = queue.read(file); } catch { throw new BridgeRetryableError("telegram bridge marker write failed"); }
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(decodeTelegramUtf8(existing.bytes)) as Record<string, unknown>; }
        catch { throw new BridgeRetryableError("telegram bridge duplicate marker is unreadable"); }
        const current = envelope as unknown as Record<string, unknown>;
        if (Buffer.from(existing.bytes).equals(Buffer.from(JSON.stringify(envelope, null, 2), "utf8"))) return null;
        if (!equivalentBridgeEnvelope(parsed, current, "answer") || parsed.run_id !== runId) {
          throw new BridgeRetryableError("telegram bridge marker collision");
        }
        if (!pinnedRoot.isStable()) throw new BridgeRetryableError("telegram bridge root changed before marker re-sign");
        try {
          queue.replaceIfMatches(file, { dev: existing.dev, ino: existing.ino, sha256: createHash("sha256").update(existing.bytes).digest("hex") }, JSON.stringify(current, null, 2));
        } catch {
          throw new BridgeRetryableError("telegram bridge marker re-sign failed");
        }
        if (!pinnedRoot.isStable() || !isBridgeAuthenticationLeaseCurrent(cwd, pinnedRoot, envelope.auth.session_id)) throw new BridgeRetryableError("telegram bridge auth lease changed after marker re-sign");
        return null;
      }
    } finally {
      queue.close();
    }
  });
}
