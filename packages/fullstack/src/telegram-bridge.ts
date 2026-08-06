/**
 * Telegram bridge — autonomous messenger bridge that works WITHOUT a live
 * omp session (the case the in-session dispatcher cannot cover: the CTO
 * finished, the session is closed, the user still writes to the bot).
 *
 * Classification of an incoming plain message:
 *   - active CTO run  -> file as a task in the local drop
 *     (`<root>/.omp/inbox/`, the in-session dispatcher picks it up in <=10s)
 *     and do NOT reply (the CTO session owns the conversation);
 *   - no active run, but a FINISHED run with a summary.json -> reply with the
 *     run status built from the summary (no LLM), AND file the message as a
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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findActiveCtoRun } from "@andvl1/omp-workflows-core";
import { ensureStandbyRun, localInboxDrop } from "./adapters/registry.js";

export interface BridgeIncoming {
  id: string;
  text: string;
  at: string;
  by?: string;
}

export interface BridgeResult {
  action: "active-task" | "completed-status" | "standby-task";
  /** Reply to send to the user; undefined for active-task (session owns it). */
  reply?: string;
  /** Task file written (or null when the write lost the wx race). */
  filedPath?: string | null;
  runId?: string;
}

/** File the message as a task in the local drop (wx-idempotent). */
export function writeTaskDrop(cwd: string, msg: BridgeIncoming): string | null {
  return writeInboxTaskFile(localInboxDrop(cwd), `${msg.id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`, cwd, msg);
}

/** File the message under a standby run's inbox (wx-idempotent). */
export function writeStandbyTask(cwd: string, msg: BridgeIncoming, runId?: string): string | null {
  const resolved = runId ?? ensureStandbyRun(cwd);
  const dir = join(cwd, ".work-state", "cto", resolved, "inbox");
  return writeInboxTaskFile(dir, `${msg.id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`, cwd, msg, resolved);
}

function writeInboxTaskFile(dir: string, fileName: string, cwd: string, msg: BridgeIncoming, runId?: string): string | null {
  const path = join(dir, fileName);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ id: msg.id, text: msg.text, at: msg.at, by: msg.by ?? "telegram-bridge", runId }, null, 2), { flag: "wx" });
    return path;
  } catch (error) {
    if (existsSync(path) && statSync(path).isFile()) return null; // duplicate delivery — already durable
    throw error; // persistence failure must keep the Telegram update unconfirmed
  }
}

/** Latest finished run summary (summary.json with a verdict), by mtime. */
export function findCompletedSummary(cwd: string): { runId: string; summary: Record<string, unknown> } | null {
  const ctoRoot = join(cwd, ".work-state", "cto");
  if (!existsSync(ctoRoot)) return null;
  let best: { runId: string; summary: Record<string, unknown> } | null = null;
  let bestAt = 0;
  for (const runId of readdirSync(ctoRoot)) {
    const path = join(ctoRoot, runId, "summary.json");
    if (!existsSync(path)) continue;
    try {
      const summary = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const verdict = String(summary.verdict ?? "");
      if (verdict.length === 0) continue;
      const at = statSync(path).mtimeMs;
      if (at > bestAt) {
        best = { runId, summary };
        bestAt = at;
      }
    } catch {
      // unreadable/corrupt — skip
    }
  }
  return best;
}

/** Build a human status reply from a run summary (no LLM). */
export function buildStatusReply(runId: string, summary: Record<string, unknown>): string {
  const verdict = String(summary.verdict ?? "?");
  const lines: string[] = [`CTO run \`${runId}\` is FINISHED (verdict: ${verdict}).`, ""];
  const firstSweep = summary.first_sweep;
  if (firstSweep && typeof firstSweep === "object" && !Array.isArray(firstSweep)) {
    lines.push("Status per item:");
    for (const [key, value] of Object.entries(firstSweep as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const action = String(item.action ?? "");
      const state = String(item.state ?? "");
      lines.push(`- ${key}: ${action}${state ? ` — ${state}` : ""}`);
    }
  } else {
    lines.push(`Details: .work-state/cto/${runId}/summary.json`);
  }
  return lines.join("\n");
}

/** Classify an incoming plain message and file it; returns the reply (if any). */
export function classifyIncoming(cwd: string, msg: BridgeIncoming): BridgeResult {
  const active = findActiveCtoRun(cwd);
  if (active) {
    return { action: "active-task", filedPath: writeTaskDrop(cwd, msg), runId: active.runId };
  }
  const completed = findCompletedSummary(cwd);
  if (completed) {
    return {
      action: "completed-status",
      reply: buildStatusReply(completed.runId, completed.summary),
      filedPath: writeStandbyTask(cwd, msg),
      runId: completed.runId,
    };
  }
  const runId = ensureStandbyRun(cwd);
  return {
    action: "standby-task",
    reply:
      "CTO is not active right now and no finished run has a summary to report. " +
      `Your message was saved as a task in standby run \`${runId}\` and will be picked up ` +
      "when a CTO session starts (/cto).",
    filedPath: writeStandbyTask(cwd, msg, runId),
    runId,
  };
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
    const body = (await response.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/**
 * File an answer marker in the local drop ({ kind: "answer" }) so a live
 * session wakes [CTO-ANSWER] even though it does not poll telegram while the
 * bridge owns the bot. Deterministic name by esc id (wx) — no duplicates.
 */
export function writeAnswerMarker(cwd: string, answer: { id: string; answer: string }): string | null {
  const file = `${answer.id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
  try {
    const dir = localInboxDrop(cwd);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    writeFileSync(
      path,
      JSON.stringify({ kind: "answer", id: answer.id, text: answer.answer, at: new Date().toISOString(), by: "telegram-bridge" }, null, 2),
      { flag: "wx" },
    );
    return path;
  } catch {
    return null; // already filed (duplicate) or IO error
  }
}
