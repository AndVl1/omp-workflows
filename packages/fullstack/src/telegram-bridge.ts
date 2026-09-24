/**
 * Telegram bridge — durable messenger drop for sessions without a live
 * interactive dispatcher.
 *
 * Plain messages are always written to `<root>/.omp/inbox/` without
 * selecting a latest CTO run or creating standby authority. A live fullstack
 * dispatcher accepts that file only after it has an exact controller claim
 * (run/session/ownership epoch). Escalation answers remain durable answer
 * files plus optional local markers; the dispatcher performs the exact
 * claim check before waking the host.
 *
 * Writes are idempotent (wx) and replies are deduped per message_id in
 * memory, so duplicate getUpdates deliveries never double-send.
 *
 * ONE consumer per bot token: the bridge owns getUpdates. Do not run it
 * together with a live interactive session on the same token unless the
 * bridge lock is configured for that deployment.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localInboxDrop } from "./adapters/registry.js";

export interface BridgeIncoming {
  id: string;
  text: string;
  at: string;
  by?: string;
}

export interface BridgeResult {
  action: "local-task";
  /** Reply to send after the local-drop write succeeds. */
  reply?: string;
  /** Task file written (or null when the write lost the wx race). */
  filedPath?: string | null;
}

/** File the message as a task in the local drop (wx-idempotent). */
export function writeTaskDrop(cwd: string, msg: BridgeIncoming): string | null {
  return writeInboxTaskFile(localInboxDrop(cwd), msg.id, {
    id: msg.id,
    text: msg.text,
    at: msg.at,
    by: msg.by ?? "telegram-bridge",
  });
}

/** Parsed local-drop records used for immutable identity inspection. */
interface InboxDropRecord {
  id?: unknown;
  text?: unknown;
  kind?: unknown;
}

function inspectInboxDropPath(path: string): { exists: boolean; record?: InboxDropRecord } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return {
      exists: true,
      ...(parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { record: parsed as InboxDropRecord }
        : {}),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { exists: false };
    }
    if (error instanceof SyntaxError) return { exists: true };
    throw new Error(`cannot verify existing inbox file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Persist a local-drop record without confusing a sanitized filename
 * collision with an exact duplicate. The legacy unsuffixed name remains
 * preferred; distinct ids get a deterministic SHA-256 suffix, while a
 * conflicting payload under one id fails closed.
 */
function writeInboxTaskFile(dir: string, id: string, record: Record<string, unknown>): string | null {
  const fileName = id.replace(/[^a-zA-Z0-9._-]/g, "-");
  const suffix = createHash("sha256").update(id).digest("hex");
  const recordKind = typeof record.kind === "string" ? record.kind : undefined;
  const payload = JSON.stringify(record, null, 2);
  const processedDir = join(dir, "processed");

  // The processed archive is part of the immutable transport identity. Once a
  // source file has been consumed, its id must still refuse changed text/kind
  // before classifyIncoming can return a reply or Telegram can ACK the update.
  let exactDuplicate = false;
  for (const sourceDir of [dir, processedDir]) {
    let names: string[];
    try {
      names = readdirSync(sourceDir);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const existing = inspectInboxDropPath(join(sourceDir, name));
      if (existing.record?.id !== id) continue;
      const existingKind = typeof existing.record.kind === "string" ? existing.record.kind : undefined;
      if (existingKind === recordKind && existing.record.text === record.text) {
        exactDuplicate = true;
        continue;
      }
      const reason = `local inbox transport id ${id} has conflicting content or kind`;
      writeInboxConflictDiagnostic(dir, fileName, record, reason);
      throw new Error(reason);
    }
  }
  if (exactDuplicate) return null;
  for (let collision = 0; ; collision += 1) {
    const suffixPart = collision === 0 ? "" : `-${suffix}${collision === 1 ? "" : `-${collision}`}`;
    const name = `${fileName}${suffixPart}.json`;
    const path = join(dir, name);
    const active = inspectInboxDropPath(path);
    const processed = inspectInboxDropPath(join(processedDir, name));
    if (active.exists || processed.exists) {
      let candidateDuplicate = false;
      for (const existing of [active, processed]) {
        if (existing.record?.id !== id) continue;
        const existingKind = typeof existing.record.kind === "string" ? existing.record.kind : undefined;
        if (existingKind === recordKind && existing.record.text === record.text) {
          candidateDuplicate = true;
          continue;
        }
        const reason = `local inbox transport id ${id} has conflicting content or kind`;
        writeInboxConflictDiagnostic(dir, fileName, record, reason);
        throw new Error(reason);
      }
      if (candidateDuplicate) return null;
      // A different id occupies this candidate in either active or processed;
      // retain deterministic suffixing for sanitized-id collisions.
      continue;
    }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, payload, { flag: "wx" });
      return path;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      const existing = inspectInboxDropPath(path);
      if (existing.record?.id === id) {
        const existingKind = typeof existing.record.kind === "string" ? existing.record.kind : undefined;
        if (existingKind === recordKind && existing.record.text === record.text) return null;
        const reason = `local inbox transport id ${id} has conflicting content or kind`;
        writeInboxConflictDiagnostic(dir, fileName, record, reason);
        throw new Error(reason);
      }
      // A valid different id occupies this name. Continue to the
      // deterministic hash-suffixed candidate.
    }
  }
}

function writeInboxConflictDiagnostic(
  dir: string,
  fileName: string,
  record: Record<string, unknown>,
  reason: string,
): void {
  const rejectedDir = join(dir, "rejected");
  const id = String(record.id ?? "");
  const text = String(record.text ?? "");
  const kind = typeof record.kind === "string" ? record.kind : "";
  const suffix = createHash("sha256").update(`${id}\u0000${kind}\u0000${text}`).digest("hex");
  const path = join(rejectedDir, `${fileName}.conflict-${suffix}.json`);
  mkdirSync(rejectedDir, { recursive: true });
  try {
    writeFileSync(
      path,
      JSON.stringify({ id, kind: kind || undefined, text, reason, at: new Date().toISOString() }, null, 2),
      { flag: "wx" },
    );
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
}

/** File a plain message without selecting or creating a CTO authority. */
export function classifyIncoming(cwd: string, msg: BridgeIncoming): BridgeResult {
  return {
    action: "local-task",
    reply:
      "No exact resident CTO claim is available. " +
      "Your message was saved in the local inbox and will be delivered only after explicit `/cto --run <run-id>` reacquisition.",
    filedPath: writeTaskDrop(cwd, msg),
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
 * bridge owns the bot. Deterministic names preserve the legacy unsuffixed
 * path and add a hash suffix for distinct ids; same-id content/kind conflicts
 * fail closed without overwriting the original marker.
 */
export function writeAnswerMarker(cwd: string, answer: { id: string; answer: string }): string | null {
  return writeInboxTaskFile(localInboxDrop(cwd), answer.id, {
    kind: "answer",
    id: answer.id,
    text: answer.answer,
    at: new Date().toISOString(),
    by: "telegram-bridge",
  });
}
