/**
 * Telegram escalation adapter (reference: full round trip).
 *
 * Send: `sendMessage` with the sanitized question + inline buttons for the
 * escalation options (or force-reply when there are none). The
 * message_id -> escId mapping is persisted to
 * `.work-state/cto/<runId>/tg-map.jsonl` so answers survive restarts.
 *
 * Receive: long-polling `getUpdates` loop (no public URL needed). Two answer
 * shapes are accepted:
 *   - callback_query on an inline button  -> option id
 *   - reply message to the sent question  -> free text
 * Both are written to `.work-state/cto/<runId>/answers/<escId>.json` as an
 * EscalationAnswer ({ id, answer, at, by }).
 *
 * `fetchImpl` is injectable for tests; defaults to global fetch.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ctoStateDir,
  ensureAnswersDir,
  type Escalation,
  type EscalationAdapter,
  type EscalationAnswer,
  type EscalationReceipt,
} from "@andvl1/omp-workflows-core";

export interface TelegramAdapterOptions {
  token: string;
  chatId: string;
  cwd: string;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Called for plain messages (not replies to a sent escalation, not
   * callback queries). Used by the CTO inbox: a plain message to the bot is
   * a NEW TASK for the standby CTO, routed to `.work-state/cto/<id>/inbox/`.
   */
  onPlainMessage?: (msg: { id: string; text: string; at: string }) => void;
}

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; text?: string; reply_to_message?: { message_id: number } };
  callback_query?: { id: string; message?: { message_id: number }; data?: string };
}

export class TelegramEscalationAdapter implements EscalationAdapter {
  readonly kind = "telegram";
  private readonly token: string;
  private readonly chatId: string;
  private readonly cwd: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private onPlainMessage: TelegramAdapterOptions["onPlainMessage"];
  private offset = 0;
  private polling = false;
  /** In-flight getUpdates round — concurrent pollOnce calls share it (one getUpdates per adapter). */
  private pollInFlight: Promise<EscalationAnswer[]> | null = null;
  /** Bumped on every start(); lets a stale loop notice a stop+restart. */
  private loopGeneration = 0;

  constructor(options: TelegramAdapterOptions) {
    this.token = options.token;
    this.chatId = options.chatId;
    this.cwd = options.cwd;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onPlainMessage = options.onPlainMessage;
  }

  /** Set/replace the plain-message (inbox task) handler. */
  setPlainMessageHandler(handler: NonNullable<TelegramAdapterOptions["onPlainMessage"]>): void {
    this.onPlainMessage = handler;
  }

  private async api(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`telegram ${method} -> ${response.status}`);
    const body = (await response.json()) as { ok: boolean; result?: unknown };
    if (!body.ok) throw new Error(`telegram ${method} -> not ok`);
    return body.result;
  }

  async send(esc: Escalation): Promise<EscalationReceipt> {
    try {
      const text = [esc.title, "", esc.body, esc.default ? `(default: ${esc.default})` : ""].join("\n");
      const payload: Record<string, unknown> = {
        chat_id: this.chatId,
        text,
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "Answer the CTO escalation",
        },
      };
      if (esc.options && esc.options.length > 0) {
        payload.reply_markup = {
          inline_keyboard: esc.options.map((option) => [{ text: option.label, callback_data: `${esc.id}::${option.id}` }]),
        };
      }
      const result = (await this.api("sendMessage", payload)) as { message_id: number };
      this.recordMapping(esc.id, result.message_id, esc);
      return { sent: true, channelRef: `tg:${result.message_id}` };
    } catch (error) {
      return { sent: false, channelRef: error instanceof Error ? error.message : String(error) };
    }
  }

  async cancel(id: string): Promise<void> {
    const msgId = this.messageIdOf(id);
    if (msgId === null) return;
    try {
      await this.api("deleteMessage", { chat_id: this.chatId, message_id: msgId });
    } catch {
      // best-effort cancellation
    }
  }

  /** Plain text reply (no reply markup) — used by the standalone bridge. */
  async sendPlainText(target: string, text: string): Promise<{ sent: boolean; channelRef?: string }> {
    try {
      await this.api("sendMessage", { chat_id: target, text });
      return { sent: true };
    } catch (error) {
      return { sent: false, channelRef: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Start the long-polling loop (non-blocking); returns a stop function. */
  start(): () => void {
    if (this.polling) return () => undefined;
    this.polling = true;
    const generation = ++this.loopGeneration;
    void this.pollLoop(generation);
    return () => {
      this.polling = false;
    };
  }

  /**
   * Self-scheduling poll loop: the next round starts only after the previous
   * one completed (a long-poll round can block up to `timeout: 30`), so there
   * is never more than one in-flight getUpdates per adapter.
   */
  private async pollLoop(generation: number): Promise<void> {
    while (this.polling && generation === this.loopGeneration) {
      try {
        await this.pollOnce();
      } catch {
        // One bad round must not kill the loop; the next iteration retries
        // from the unconfirmed offset (updates are not lost).
      }
      if (!this.polling || generation !== this.loopGeneration) break;
      const { promise, resolve } = deferred<void>();
      setTimeout(resolve, this.pollIntervalMs);
      await promise;
    }
  }

  /**
   * One getUpdates round. Concurrent callers share the same in-flight round,
   * so at most one getUpdates request is issued per adapter at any time. The
   * offset is advanced only after an update was processed successfully: a
   * callback/answer persistence failure keeps the update unconfirmed so
   * Telegram re-delivers it on the next poll (no lost messages).
   */
  async pollOnce(): Promise<EscalationAnswer[]> {
    if (this.pollInFlight) return this.pollInFlight;
    const round = this.runPollOnce();
    this.pollInFlight = round;
    try {
      return await round;
    } finally {
      if (this.pollInFlight === round) this.pollInFlight = null;
    }
  }

  private async runPollOnce(): Promise<EscalationAnswer[]> {
    if (!this.polling && this.offset === 0) this.polling = true;
    const updates = (await this.api("getUpdates", {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ["message", "callback_query"],
    })) as TgUpdate[];
    const answers: EscalationAnswer[] = [];
    for (const update of updates) {
      // Process first, confirm after: a persistence failure throws before the
      // offset moves, leaving this update (and everything after it) queued.
      const answer = this.answerFromUpdate(update);
      if (answer) answers.push(this.writeAnswer(answer));
      this.offset = Math.max(this.offset, update.update_id + 1);
    }
    return answers;
  }

  private answerFromUpdate(update: TgUpdate): EscalationAnswer | null {
    const at = new Date().toISOString();
    if (update.callback_query?.data && update.callback_query.message) {
      const [escId, optionId] = update.callback_query.data.split("::");
      if (escId && optionId) return { id: escId, answer: optionId, at, by: "telegram:callback" };
    }
    const message = update.message;
    if (message?.reply_to_message && typeof message.text === "string") {
      const escId = this.escIdOfMessage(message.reply_to_message.message_id);
      if (escId) return { id: escId, answer: message.text, at, by: "telegram:reply" };
    }
    // Plain message (no reply target, not a callback) -> CTO inbox task.
    if (message && typeof message.text === "string" && message.text.trim().length > 0) {
      this.onPlainMessage?.({ id: `tg:${message.message_id}`, text: message.text, at });
    }
    return null;
  }

  private writeAnswer(answer: EscalationAnswer): EscalationAnswer {
    const runId = answer.id.split("/")[0] ?? answer.id;
    const dir = ensureAnswersDir(runId, this.cwd);
    const fileName = answer.id.replace(/[^a-zA-Z0-9-_]/g, "-");
    writeFileSync(join(dir, `${fileName}.json`), JSON.stringify(answer, null, 2));
    return answer;
  }

  // ── message_id <-> escId mapping (persisted, survives restarts) ──────────

  private mapPath(runId: string): string {
    return join(ctoStateDir(runId, this.cwd), "tg-map.jsonl");
  }

  private recordMapping(escId: string, messageId: number, esc: Escalation): void {
    const runId = runIdOf(esc);
    const path = this.mapPath(runId);
    mkdirSync(join(this.cwd, ".work-state", "cto", runId), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ escId, messageId })}\n`);
  }

  private messageIdOf(escId: string): number | null {
    const runId = escId.split("/")[0] ?? escId;
    const path = this.mapPath(runId);
    if (!existsSync(path)) return null;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { escId: string; messageId: number };
      if (entry.escId === escId) return entry.messageId;
    }
    return null;
  }

  private escIdOfMessage(messageId: number): string | null {
    // Scan all run maps (bounded: runs under .work-state/cto/*/tg-map.jsonl).
    const ctoRoot = join(this.cwd, ".work-state", "cto");
    if (!existsSync(ctoRoot)) return null;
    let runIds: string[];
    try {
      runIds = readdirSync(ctoRoot);
    } catch {
      return null;
    }
    for (const runId of runIds) {
      const path = this.mapPath(runId);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as { escId: string; messageId: number };
        if (entry.messageId === messageId) return entry.escId;
      }
    }
    return null;
  }
}

function runIdOf(esc: Escalation): string {
  return esc.id.split("/")[0] ?? esc.id;
}

/**
 * Node 20-compatible `Promise.withResolvers` (which is Node 22+ / ES2024);
 * mirrors the repo convention in packages/e2e/src/util.ts.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
