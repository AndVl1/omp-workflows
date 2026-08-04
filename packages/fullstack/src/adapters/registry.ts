/**
 * Escalation adapter registry + outbox dispatcher (fullstack).
 *
 * Two-layer reality: the CTO agent (an LLM) cannot call TS adapters. So the
 * agent WRITES an escalation request file to the outbox and the extension
 * dispatches it:
 *
 *   agent ── writes .work-state/cto/<runId>/outbox/<escId>.json ──► dispatcher
 *   dispatcher ── sanitize (R4) ──► adapter.send ──► channel (HTTP / Telegram)
 *   channel / user ──► .work-state/cto/<runId>/answers/<escId>.json ──► agent
 *
 * The dispatcher runs on `session_start` when `.omp/escalation.json` exists.
 * Consumer config shape:
 *
 *   {
 *     "adapter": "http" | "telegram",
 *     "http":     { "url": "https://ntfy.sh/my-topic", "headers": {} },
 *     "telegram": { "token": "...", "chatId": "...", "pollIntervalMs": 5000 }
 *   }
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  ctoStateDir,
  sanitizeEscalation,
  validateEscalation,
  type Escalation,
  type EscalationAdapter,
  type EscalationReceipt,
} from "@andvl1/omp-workflows-core";
import { HttpEscalationAdapter } from "./http.js";
import { TelegramEscalationAdapter } from "./telegram.js";

export interface EscalationConfig {
  adapter: "http" | "telegram";
  http?: { url: string; headers?: Record<string, string> };
  telegram?: { token: string; chatId: string; pollIntervalMs?: number };
}

/** Run id is the first segment of the escalation correlation id. */
export function runIdOf(esc: Escalation): string {
  return esc.id.split("/")[0] ?? esc.id;
}

export function outboxDir(runId: string, root: string): string {
  return join(ctoStateDir(runId, root), "outbox");
}

/** Read `.omp/escalation.json`; missing/malformed -> null. */
export function loadEscalationConfig(cwd: string): EscalationConfig | null {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ".omp", "escalation.json"), "utf8")) as EscalationConfig;
    if (raw.adapter !== "http" && raw.adapter !== "telegram") return null;
    return raw;
  } catch {
    return null;
  }
}

/** Build the configured adapter; null when the config is unusable. */
export function createEscalationAdapter(config: EscalationConfig, cwd: string): EscalationAdapter | null {
  if (config.adapter === "http") {
    if (!config.http?.url) return null;
    return new HttpEscalationAdapter({ url: config.http.url, headers: config.http.headers });
  }
  if (config.adapter === "telegram") {
    if (!config.telegram?.token || !config.telegram.chatId) return null;
    return new TelegramEscalationAdapter({
      token: config.telegram.token,
      chatId: config.telegram.chatId,
      cwd,
      pollIntervalMs: config.telegram.pollIntervalMs ?? 5_000,
    });
  }
  return null;
}

/**
 * Drain the outbox: for every `.work-state/cto/<runId>/outbox/*.json` that
 * is a valid escalation, sanitize (R4), send via the adapter, and move the
 * file to `sent/` on success. Returns the send results. Never throws.
 */
export async function drainOutbox(
  root: string,
  adapter: EscalationAdapter,
  maxRetries = 3,
): Promise<Array<{ escId: string; sent: boolean; error?: string }>> {
  const results: Array<{ escId: string; sent: boolean; error?: string }> = [];
  const runsDir = join(root, ".work-state", "cto");
  if (!existsSync(runsDir)) return results;
  const runs = readdirSync(runsDir);
  for (const runId of runs) {
    const outbox = outboxDir(runId, root);
    if (!existsSync(outbox)) continue;
    for (const name of readdirSync(outbox)) {
      if (!name.endsWith(".json")) continue;
      const escId = name.slice(0, -".json".length);
      const path = join(outbox, name);
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Escalation;
        const validation = validateEscalation(raw);
        if (validation) {
          results.push({ escId, sent: false, error: validation });
          continue;
        }
        const clean = sanitizeEscalation(raw);
        const receipt = await sendWithRetry(adapter, clean, maxRetries);
        if (receipt.sent) {
          const sentDir = join(outbox, "sent");
          mkdirSync(sentDir, { recursive: true });
          renameSync(path, join(sentDir, name));
          results.push({ escId, sent: true });
        } else {
          results.push({ escId, sent: false, error: `send failed after ${maxRetries} attempts` });
        }
      } catch (error) {
        results.push({ escId, sent: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return results;
}

async function sendWithRetry(adapter: EscalationAdapter, esc: Escalation, maxRetries: number): Promise<EscalationReceipt> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const receipt = await adapter.send(esc);
      if (receipt.sent) return receipt;
    } catch {
      // network / adapter error — retry
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1))); // 500ms, 1s, 2s
    }
  }
  return { sent: false };
}

/** Start the dispatcher loop; returns a stop function. */
export function startDispatcher(root: string, adapter: EscalationAdapter, intervalMs = 10_000): () => void {
  const timer = setInterval(() => {
    void drainOutbox(root, adapter).catch(() => undefined);
  }, intervalMs);
  // Drain once immediately on start (survives restarts — R7).
  void drainOutbox(root, adapter).catch(() => undefined);
  return () => clearInterval(timer);
}
