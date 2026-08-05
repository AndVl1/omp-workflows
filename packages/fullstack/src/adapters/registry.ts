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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ctoStateDir,
  sanitizeEscalation,
  validateEscalation,
  type Escalation,
  type EscalationAdapter,
  type EscalationReceipt,
} from "@andvl1/omp-workflows-core";
import { findActiveCtoRun } from "@andvl1/omp-workflows-core";
import { HttpEscalationAdapter } from "./http.js";
import { TelegramEscalationAdapter } from "./telegram.js";

export interface EscalationConfig {
  adapter: string;
  /** True when the channel can receive user replies (bidirectional). */
  bidirectional?: boolean;
  http?: { url: string; headers?: Record<string, string> };
  telegram?: { token: string; chatId: string; pollIntervalMs?: number };
  /** Transport-specific config for consumer-registered adapters. */
  [transport: string]: unknown;
}

/** Run id is the first segment of the escalation correlation id. */
export function runIdOf(esc: Escalation): string {
  return esc.id.split("/")[0] ?? esc.id;
}

export function outboxDir(runId: string, root: string): string {
  return join(ctoStateDir(runId, root), "outbox");
}

/** Adapter factory for a transport kind (built-in or consumer-registered). */
export type EscalationAdapterFactory = (config: EscalationConfig, cwd: string) => EscalationAdapter | null;

const adapterFactories = new Map<string, EscalationAdapterFactory>([
  ["http", (config) => (config.http?.url ? new HttpEscalationAdapter({ url: config.http.url, headers: config.http.headers }) : null)],
  [
    "telegram",
    (config, cwd) =>
      config.telegram?.token && config.telegram.chatId
        ? new TelegramEscalationAdapter({
            token: config.telegram.token,
            chatId: config.telegram.chatId,
            cwd,
            pollIntervalMs: config.telegram.pollIntervalMs ?? 5_000,
          })
        : null,
  ],
]);

/**
 * Register a consumer transport adapter (e.g. slack, whatsapp, signal) so the
 * in-session dispatcher and the standalone bridge can create it from
 * `.omp/escalation.json` like any built-in. Implement the optional inbound
 * surface (pollOnce / setPlainMessageHandler / sendPlainText) for the same
 * bidirectional behavior as telegram.
 */
export function registerEscalationAdapter(kind: string, factory: EscalationAdapterFactory): void {
  adapterFactories.set(kind, factory);
}

/** Read `.omp/escalation.json`; missing/malformed -> null. */
export function loadEscalationConfig(cwd: string): EscalationConfig | null {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ".omp", "escalation.json"), "utf8")) as EscalationConfig;
    if (typeof raw.adapter !== "string" || raw.adapter.length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Build the configured adapter; null when the config is unusable. */
export function createEscalationAdapter(config: EscalationConfig, cwd: string): EscalationAdapter | null {
  const factory = adapterFactories.get(config.adapter);
  if (!factory) return null;
  try {
    return factory(config, cwd);
  } catch {
    return null;
  }
}

/**
 * True when the configured channel can receive user-initiated replies
 * (telegram today, or any transport explicitly marked bidirectional).
 */
export function isBidirectionalChannel(cwd: string): boolean {
  const config = loadEscalationConfig(cwd);
  if (!config) return false;
  return config.adapter === "telegram" || config.bidirectional === true;
}

/**
 * Drain the outbox: for every `.work-state/cto/<runId>/outbox/*.json` that
 * is a valid escalation, sanitize (R4), send via the adapter, and move the
 * file to `sent/` on success. Returns the send results. Never throws.
 */
export async function drainOutbox(
  root: string,
  adapter: EscalationAdapter | null,
  maxRetries = 3,
): Promise<Array<{ escId: string; sent: boolean; error?: string }>> {
  if (!adapter) return [];
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
export function startDispatcher(
  root: string,
  adapter: EscalationAdapter | null,
  intervalMs = 10_000,
  opts: DispatcherOptions = {},
): () => void {
  const { onTask, onAnswer } = opts;
  const inboxHandler = (task: InboxTask) => handleInboxTask(root, task, onTask);
  // Only the Telegram adapter exposes setPlainMessageHandler; http is
  // send-only. Cast at the boundary once, guarded at runtime.
  const telegramLike = adapter as { setPlainMessageHandler: (h: (t: InboxTask) => void) => void } | null;
  if (telegramLike && typeof telegramLike.setPlainMessageHandler === "function") {
    telegramLike.setPlainMessageHandler(inboxHandler);
  }
  const tick = (): void => {
    void drainOutbox(root, adapter).catch(() => undefined);
    void pollInbox(root, adapter, onTask, onAnswer).catch(() => undefined);
  };
  const timer = setInterval(tick, intervalMs);
  // Drain once immediately on start (survives restarts — R7).
  tick();
  return () => clearInterval(timer);
}

// ── CTO task inbox ─────────────────────────────────────────────────────────

/** A task arriving from the messenger or the local drop. */
export interface InboxTask {
  id: string;
  text: string;
  at: string;
  by?: string;
  /** Resolved run id the task was filed under. */
  runId?: string;
}

export interface DispatcherOptions {
  /** Called once per new inbox task (after the inbox file is written). */
  onTask?: (task: InboxTask) => void;
  /**
   * Called once per newly received escalation answer (user-initiated reply
   * or button in the messenger channel). The answer file is already written
   * by the adapter; the wake tells the agent to apply it at the next
   * checkpoint (or immediately if it is waiting).
   */
  onAnswer?: (answer: { id: string; answer: string }) => void;
}

/** `.work-state/cto/<runId>/inbox/` — tasks the CTO reads at checkpoints. */
export function inboxDir(runId: string, root: string): string {
  return join(ctoStateDir(runId, root), "inbox");
}

/** Local task drop: `<root>/.omp/inbox/*.json` ({ id, text, by? }). */
export function localInboxDrop(root: string): string {
  return join(root, ".omp", "inbox");
}

// ── Bridge ownership (one getUpdates consumer per bot token) ───────────────

/**
 * Lock file the standalone bridge daemon writes on start and removes on exit.
 * The in-session dispatcher checks it: while the bridge is alive it owns the
 * bot's getUpdates, so the session must NOT long-poll telegram itself — it
 * only picks up the bridge's files from the drop. Without the bridge the
 * session polls telegram directly. Stale lock (dead pid) is ignored.
 */
export function bridgeLockPath(root: string): string {
  return join(root, ".omp", "bridge.lock");
}

/** True when a live tg-bridge owns the bot for this project. */
export function isBridgeAlive(root: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(bridgeLockPath(root), "utf8")) as { pid?: number };
    if (typeof raw?.pid !== "number") return false;
    process.kill(raw.pid, 0); // throws ESRCH when the process is gone
    return true;
  } catch {
    return false;
  }
}

/** Write the bridge lock (called by the tg-bridge daemon on start). */
export function writeBridgeLock(root: string): void {
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(bridgeLockPath(root), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  } catch {
    // best-effort
  }
}

/** Remove the bridge lock (called by the daemon on shutdown). */
export function clearBridgeLock(root: string): void {
  try {
    const path = bridgeLockPath(root);
    if (existsSync(path)) renameSync(path, `${path}.stopped`);
  } catch {
    // best-effort
  }
}

/**
 * Resolve the run an inbox task belongs to: the active CTO run when there is
 * one, otherwise create a standby run (id `standby-<ts>`) so the task has a
 * home and the run becomes active.
 */
export function resolveInboxRunId(root: string): string {
  const active = findActiveCtoRun(root);
  if (active) return active.runId;
  return ensureStandbyRun(root);
}

/** Create a minimal standby run state.json; returns its run id. */
export function ensureStandbyRun(root: string): string {
  const runId = `standby-${Date.now()}`;
  const runDir = ctoStateDir(runId, root);
  mkdirSync(runDir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    schema: 1,
    id: runId,
    task: "standby — awaiting inbox tasks",
    branch: "",
    autonomous: true,
    plan: { id: runId, task: "standby — awaiting inbox tasks", teams: [], created_at: now },
    teams: [],
    integration: { status: "pending" },
    pause: { kind: "none", reason: "standby" },
    updated_at: now,
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  return runId;
}

/**
 * Write an inbox task file (idempotent — `wx`: the first dispatcher wins,
 * duplicates across sessions are dropped) and wake the CTO session.
 */
export function handleInboxTask(root: string, task: InboxTask, onTask?: (t: InboxTask) => void): string | null {
  try {
    const runId = task.runId ?? resolveInboxRunId(root);
    const dir = inboxDir(runId, root);
    mkdirSync(dir, { recursive: true });
    const fileName = `${task.id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
    const path = join(dir, fileName);
    writeFileSync(path, JSON.stringify({ ...task, runId }, null, 2), { flag: "wx" });
    onTask?.({ ...task, runId });
    return path;
  } catch {
    return null; // already exists (another dispatcher won) or IO error — skip
  }
}

/**
 * Poll all inbox sources:
 *  1. local drop `<root>/.omp/inbox/*.json` (moved into the run inbox),
 *  2. telegram `pollOnce()` — answer files are written by the adapter; plain
 *     messages are routed to the inbox handler via `setPlainMessageHandler`.
 * Never throws.
 */
export async function pollInbox(
  root: string,
  adapter: EscalationAdapter | null,
  onTask?: (t: InboxTask) => void,
  onAnswer?: (a: { id: string; answer: string }) => void,
): Promise<void> {
  // 1. Local drop (bridge-written tasks + answer markers, or manual/test
  //    injection). The bridge files answers as { kind: "answer" } markers so
  //    the session wakes [CTO-ANSWER] even though it does not poll telegram.
  try {
    const drop = localInboxDrop(root);
    if (existsSync(drop)) {
      for (const name of readdirSync(drop)) {
        if (!name.endsWith(".json")) continue;
        const path = join(drop, name);
        try {
          const raw = JSON.parse(readFileSync(path, "utf8")) as InboxTask & { kind?: string };
          if (typeof raw?.text !== "string" || raw.text.trim().length === 0) continue;
          if (raw.kind === "answer") {
            onAnswer?.({ id: raw.id, answer: raw.text });
            moveToProcessed(drop, path, name);
            continue;
          }
          const task: InboxTask = {
            id: raw.id ?? `local:${name}`,
            text: raw.text,
            at: raw.at ?? new Date().toISOString(),
            by: raw.by ?? "local-drop",
          };
          const moved = handleInboxTask(root, task, onTask);
          if (moved) moveToProcessed(drop, path, name);
        } catch {
          // unreadable / malformed — leave in place
        }
      }
    }
  } catch {
    // drop missing — nothing to do
  }
  // 2. Telegram long-poll (answers + plain-message inbox) — ONLY when no
  //    tg-bridge owns the bot. While the bridge is alive it is the sole
  //    getUpdates consumer (409 otherwise); the session just reads its files.
  if (adapter && !isBridgeAlive(root) && isTelegramPollable(adapter)) {
    try {
      const answers = (await adapter.pollOnce()) ?? [];
      for (const answer of answers) {
        if (!answer?.id || seenAnswers.has(answer.id)) continue;
        seenAnswers.add(answer.id);
        onAnswer?.(answer);
      }
    } catch {
      // network hiccup / 409 with a bridge — next tick retries
    }
  }
}

/** Narrow the Telegram-specific pollOnce surface (http is send-only). */
function isTelegramPollable(
  adapter: unknown,
): adapter is { pollOnce: () => Promise<Array<{ id: string; answer: string }>> } {
  if (typeof adapter !== "object" || adapter === null) return false;
  if (!("pollOnce" in adapter)) return false;
  return typeof adapter.pollOnce === "function";
}

function moveToProcessed(drop: string, path: string, name: string): void {
  try {
    const processedDir = join(drop, "processed");
    mkdirSync(processedDir, { recursive: true });
    renameSync(path, join(processedDir, name));
  } catch {
    // processed move is best-effort; the file stays and will be re-seen
  }
}

/**
 * Esc-ids already woken for (per dispatcher). pollOnce advances the TG offset
 * so a single dispatcher never sees the same update twice; this set guards
 * against double-wake if a dispatcher's tick overlaps itself. Multiple
 * dispatchers in multiple live sessions may both wake on the same answer —
 * acceptable: the session that owns the waiting team applies it, others treat
 * it as advisory (the CTO contract says late answers are advisory).
 */
const seenAnswers = new Set<string>();
