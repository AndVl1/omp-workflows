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

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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
   * Additional chats allowed for inbound beyond the configured chatId
   * (conservative allowlist). The configured chatId is ALWAYS allowed; this
   * list only extends it. Applies to callback answers, reply answers, and
   * plain CTO task messages.
   */
  allowedChatIds?: string[];
  /**
   * When non-empty, inbound senders must be in this list (conservative
   * allowlist). When absent/empty, no sender restriction — the chat-level
   * rule still applies.
   */
  allowedSenderIds?: string[];
  /**
   * Called for plain messages (not replies to a sent escalation, not
   * callback queries). Used by the CTO inbox: a plain message is a NEW TASK
   * for the exact claimed resident run, routed through the dispatcher.
   */
  onPlainMessage?: (msg: { id: string; text: string; at: string }) => void;
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat?: { id: number };
    from?: { id: number };
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    message?: { message_id: number; chat?: { id: number } };
    from?: { id: number };
    data?: string;
  };
}

type AnswerMarkerHandler = (answer: EscalationAnswer) => void | Promise<void>;

export class TelegramEscalationAdapter implements EscalationAdapter {
  readonly kind = "telegram";
  private readonly token: string;
  private readonly chatId: string;
  private readonly cwd: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly allowedChatIds: string[];
  private readonly allowedSenderIds: string[];
  private onPlainMessage: TelegramAdapterOptions["onPlainMessage"];
  private answerMarkerHandler: AnswerMarkerHandler | undefined;
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
    this.allowedChatIds = options.allowedChatIds ?? [];
    this.allowedSenderIds = options.allowedSenderIds ?? [];
    this.onPlainMessage = options.onPlainMessage;
  }

  /** Set/replace the plain-message (inbox task) handler. */
  setPlainMessageHandler(handler: NonNullable<TelegramAdapterOptions["onPlainMessage"]>): void {
    this.onPlainMessage = handler;
  }

  /**
   * Configure the standalone bridge's marker writer. The handler is invoked
   * before a getUpdates update is acknowledged, so a marker IO failure leaves
   * the Telegram offset unchanged and the update retryable.
   */
  setAnswerMarkerHandler(handler: AnswerMarkerHandler): void {
    this.answerMarkerHandler = handler;
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
      return { sent: true, channelRef: `tg:${this.chatId}:${result.message_id}` };
    } catch (error) {
      return { sent: false, channelRef: this.failedChannelRef("sendMessage", error) };
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
      return { sent: false, channelRef: this.failedChannelRef("sendMessage", error) };
    }
  }

  /**
   * SEC-002: map a failed call to a token-free channelRef. The receipt
   * channelRef is logged by dispatchers/operators, and some fetch
   * implementations (node-fetch v2 style) embed the full request URL —
   * including `bot<TOKEN>` — in error.message, so raw error text must never
   * land there. The adapter builds the marker itself:
   * `tg:<method>:failed`, or `tg:<method>:http-<status>` when the failure is
   * the adapter's own HTTP-status error from `api()` (status digits only,
   * token-free by construction).
   */
  private failedChannelRef(method: string, error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    const match = /^telegram \S+ -> (\d+)$/.exec(message);
    if (match) return `tg:${method}:http-${match[1]}`;
    return `tg:${method}:failed`;
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
      // Authorization gate runs BEFORE any side effect: unauthorized updates
      // are dropped at the boundary — no answer file, no onPlainMessage wake —
      // but the offset still advances (max(update_id+1)) so Telegram does not
      // redeliver them forever. Authorized updates keep the "process first,
      // confirm after" semantics below; a persistence/callback failure leaves
      // that update queued, returning earlier successful answers if present.
      if (!this.isAuthorizedUpdate(update)) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        continue;
      }
      try {
        const answer = this.answerFromUpdate(update);
        if (answer) {
          const persisted = this.writeAnswer(answer);
          if (this.answerMarkerHandler) await this.answerMarkerHandler(persisted);
          answers.push(persisted);
        }
        this.offset = Math.max(this.offset, update.update_id + 1);
      } catch (error) {
        // Preserve earlier successful answers while leaving this update
        // unconfirmed so the transport can redeliver it.
        if (answers.length > 0) return answers;
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(`telegram update ${update.update_id} failed before confirmation: ${cause}`);
      }
    }
    return answers;
  }

  /**
   * Inbound provenance gate (SEC-1). Fail closed:
   * - the update must carry a chat id (message.chat.id or
   *   callback_query.message.chat.id) that equals the configured chatId or is
   *   listed in allowedChatIds (the configured chatId is ALWAYS allowed;
   *   allowedChatIds only extends it);
   * - when allowedSenderIds is set (non-empty), the update must carry a
   *   sender id (message.from.id or callback_query.from.id) listed in it.
   * A missing chat id, or a missing sender id under a sender allowlist,
   * rejects the update.
   */
  private isAuthorizedUpdate(update: TgUpdate): boolean {
    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (chatId === undefined) return false;
    const allowedChats = new Set([this.chatId, ...this.allowedChatIds]);
    if (!allowedChats.has(String(chatId))) return false;
    if (this.allowedSenderIds.length > 0) {
      const senderId = update.message?.from?.id ?? update.callback_query?.from?.id;
      if (senderId === undefined) return false;
      if (!this.allowedSenderIds.includes(String(senderId))) return false;
    }
    return true;
  }

  private answerFromUpdate(update: TgUpdate): EscalationAnswer | null {
    const at = new Date().toISOString();
    if (update.callback_query?.data && update.callback_query.message) {
      const [escId, optionId] = update.callback_query.data.split("::");
      if (escId && optionId && isSafeEscId(escId)) return { id: escId, answer: optionId, at, by: "telegram:callback" };
    }
    const message = update.message;
    if (message?.reply_to_message && typeof message.text === "string") {
      const chatId = message.chat?.id;
      if (chatId !== undefined) {
        const escId = this.escIdOfMessage(message.reply_to_message.message_id, chatId);
        if (escId) return { id: escId, answer: message.text, at, by: "telegram:reply" };
      }
    }
    // Plain message (no reply target, not a callback) -> CTO inbox task.
    if (message && typeof message.text === "string" && message.text.trim().length > 0 && message.chat?.id !== undefined) {
      this.onPlainMessage?.({ id: `tg:${message.chat.id}:${message.message_id}`, text: message.text, at });
    }
    return null;
  }

  private recordAnswerConflict(answersDir: string, answer: EscalationAnswer, reason: string): void {
    const rejectedDir = join(answersDir, "rejected");
    const answerKey = answer.id.replace(/[^a-zA-Z0-9._-]/g, "-");
    const suffix = createHash("sha256").update(`${answer.id}\u0000${answer.answer}`).digest("hex");
    const path = join(rejectedDir, `${answerKey}.conflict-${suffix}.json`);
    mkdirSync(rejectedDir, { recursive: true });
    try {
      writeFileSync(
        path,
        JSON.stringify({ id: answer.id, answer: answer.answer, reason, at: new Date().toISOString() }, null, 2),
        { flag: "wx" },
      );
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
  }

  private writeAnswer(answer: EscalationAnswer): EscalationAnswer {
    const runId = answer.id.split("/")[0] ?? answer.id;
    if (!isSafeRunId(runId)) {
      throw new Error(`telegram: writeAnswer rejected unsafe runId "${runId}" (answer id "${answer.id}")`);
    }
    const dir = join(this.cwd, ".work-state", "cto", runId, "answers");
    const expected = resolve(join(this.cwd, ".work-state", "cto", runId, "answers"));
    const resolvedDir = resolve(dir);
    if (resolvedDir !== expected && !resolvedDir.startsWith(expected + sep)) {
      throw new Error(`telegram: writeAnswer containment violation for answer "${answer.id}"`);
    }
    const ensuredDir = ensureAnswersDir(runId, this.cwd);
    const fileName = answer.id.replace(/[^a-zA-Z0-9._-]/g, "-");
    const suffix = createHash("sha256").update(answer.id).digest("hex");
    const payload = JSON.stringify(answer, null, 2);
    for (let collision = 0; ; collision += 1) {
      const suffixPart = collision === 0 ? "" : `-${suffix}${collision === 1 ? "" : `-${collision}`}`;
      const path = join(ensuredDir, `${fileName}${suffixPart}.json`);
      try {
        // Durable answer provenance is dispatcher-owned; never overwrite an
        // existing answer/receipt when Telegram redelivers the same update.
        writeFileSync(path, payload, { flag: "wx" });
        return answer;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        let existing: { id?: unknown; answer?: unknown };
        try {
          existing = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown; answer?: unknown };
        } catch (readError) {
          throw new Error(`telegram: cannot verify existing answer file ${path}: ${readError instanceof Error ? readError.message : String(readError)}`);
        }
        if (existing.id === answer.id) {
          if (existing.answer === answer.answer) return answer;
          const reason = `telegram: answer ${answer.id} has conflicting content in ${path}`;
          this.recordAnswerConflict(ensuredDir, answer, reason);
          throw new Error(reason);
        }
        // A valid different id occupying the sanitized path is a collision,
        // not a duplicate. The deterministic hash suffix keeps both answers.
      }
    }
  }

  // ── message_id <-> escId mapping (persisted, survives restarts) ──────────

  private mapPath(runId: string): string {
    return join(ctoStateDir(runId, this.cwd), "tg-map.jsonl");
  }

  private recordMapping(escId: string, messageId: number, esc: Escalation): void {
    const runId = runIdOf(esc);
    const path = this.mapPath(runId);
    mkdirSync(join(this.cwd, ".work-state", "cto", runId), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ escId, messageId, chatId: this.chatId })}\n`);
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

  private escIdOfMessage(messageId: number, chatId: number): string | null {
    // Scan all run maps (bounded: runs under .work-state/cto/*/tg-map.jsonl).
    // Message ids are only unique inside a Telegram chat, so the chat id is
    // part of the persisted correlation key.
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
        const entry = JSON.parse(line) as { escId: string; messageId: number; chatId?: string };
        if (entry.messageId === messageId && (entry.chatId === String(chatId) || (entry.chatId === undefined && this.chatId === String(chatId)))) {
          return entry.escId;
        }
      }
    }
    return null;
  }
}

function runIdOf(esc: Escalation): string {
  return esc.id.split("/")[0] ?? esc.id;
}

/**
 * SEC-001: safe slug-path shape for callback escIds (non-empty slug segments;
 * rejects dots, backslashes, empty segments, absolute paths, whitespace,
 * colons). Valid engine ids (`<runId>/<team>/<checkpoint>/<attempt>`, all slug
 * segments) and test ids like `run-sec1/esc-1` satisfy it.
 */
const SAFE_ESC_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
/** SEC-001: a single safe runId segment (no separators, dots, or traversal). */
const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;

function isSafeEscId(escId: string): boolean {
  return SAFE_ESC_ID.test(escId);
}

function isSafeRunId(runId: string): boolean {
  return SAFE_RUN_ID.test(runId);
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
