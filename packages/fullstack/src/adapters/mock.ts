/**
 * In-process mock EscalationAdapter (br-zps.6 / D4).
 *
 * No network, no credentials: `.omp/escalation.json` `{"adapter":"mock"}`
 * selects it for tests and the epic's E2E. Implements the full optional
 * inbound surface (pollOnce / setPlainMessageHandler / sendPlainText) so
 * the entire escalation round-trip is exercisable in-process:
 *
 *   adapter.send(esc) → adapter.injectAnswer(escId, ...) →
 *   adapter.pollOnce() → dispatcher writes answers/<escId>.json
 *
 * Answers injected for a CANCELLED esc id carry `stale: true` (R5).
 *
 * ── Persisted fake-RW mode (opt-in, architecture-10) ──────────────────────
 *
 * `new MockEscalationAdapter({ persisted: { dir } })` turns the adapter into
 * a FILE-OBSERVABLE fake read-write transport that works across adapter
 * instances and processes — the deterministic transport for the epic's E2E.
 * Layout (see .work-state/artifacts/fullstack-dispatch/fake-rw-contract.md):
 *
 *   <dir>/inbound/task-<n>.json    {id, text, at, by}    durable inbound tasks
 *   <dir>/inbound/rejected/        rejected malformed/empty/oversized inbound
 *                                  files + durable rejection records
 *                                  (rejected/<name>.json: {file, reason, at, id?})
 *   <dir>/answers/ans-<n>.json     {id, answer, at, by}  durable answers
 *   <dir>/outbound/messages.jsonl  one JSON line per send()
 *   <dir>/outbound/plain.jsonl     one JSON line per sendPlainText()
 *
 *   messages.jsonl line: {escId, intent?, title, body, at, receipt:{sent, channelRef}}
 *   plain.jsonl line:    {target, text, at, receipt:{sent, channelRef}}
 *
 * injectTask / injectPlainMessage write the inbound file ATOMICALLY (unique
 * tmp name + rename) and THEN fire the in-memory handler when set;
 * injectAnswer writes the answer file and queues it in memory as today.
 * pollOnce() drains answers/ (read -> rename to answers/processed/; the
 * rename is the at-most-once consume — failures leave the file in place)
 * merged with the in-memory queue, then drains inbound/ (read -> invoke the
 * stored plain handler -> rename to inbound/processed/; handler failures
 * leave the file for retry, and malformed/empty/oversized files are moved
 * to inbound/rejected/ with a durable record). This is how a SECOND
 * process's dispatcher receives tasks persisted by the first. reset()
 * clears the in-memory state AND empties the persisted dirs (test helper).
 *
 * This is a leaf module for the adapter itself (imports only core + node
 * builtins); the sole registry-touching surface is `registerMockAdapter`,
 * which intentionally imports ./registry.js to wire the factory back in.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type Escalation,
  type EscalationAnswer,
  type EscalationAdapter,
  type EscalationInboundMessage,
  type EscalationReceipt,
} from "@andvl1/omp-workflows-core";
import { registerEscalationAdapter, MAX_INBOX_TEXT_LENGTH, type EscalationAdapterFactory } from "./registry.js";

/** Persisted fake-RW mode options (see the module docblock for the layout). */
export interface MockPersistedOptions {
  dir: string;
}

export class MockEscalationAdapter implements EscalationAdapter {
  readonly kind = "mock";

  /** All escalations handed to send() — test helper, not part of the adapter interface. */
  sentEscalations: Escalation[] = [];

  private readonly autoAnswer?: (esc: Escalation) => string | null;
  private readonly persisted?: MockPersistedOptions;
  private queuedAnswers: EscalationAnswer[] = [];
  private cancelled = new Set<string>();
  private plainHandler: ((msg: EscalationInboundMessage) => void) | null = null;
  private readonly plainTextLog: Array<{ target: string; text: string; at: string }> = [];
  private counter = 0;

  /**
   * @param opts.fetchImpl  deliberately unusable — the mock is in-process only
   *                        (D4: no network, no HTTP, no Telegram token).
   * @param opts.autoAnswer when it returns a non-null string, send() auto-queues
   *                        that answer for the escalation (round-trip shortcut).
   * @param opts.persisted  opt-in fake-RW file mode (see module docblock);
   *                        absent -> EXACT in-memory behavior.
   */
  constructor(opts?: { fetchImpl?: never; autoAnswer?: (esc: Escalation) => string | null; persisted?: MockPersistedOptions }) {
    if (opts?.fetchImpl) {
      throw new Error("MockEscalationAdapter is in-process only: no network fetch is available (fetchImpl is deliberately unusable)");
    }
    this.autoAnswer = opts?.autoAnswer;
    this.persisted = opts?.persisted;
  }

  /** Record the escalation, append the outbound log (persisted mode) and (optionally) auto-answer it. Never throws. */
  async send(esc: Escalation): Promise<EscalationReceipt> {
    this.sentEscalations.push(esc);
    if (this.persisted) this.appendOutboundMessage(esc);
    if (this.autoAnswer) {
      const answer = this.autoAnswer(esc);
      if (typeof answer === "string") {
        this.queuedAnswers.push({ id: esc.id, answer, at: new Date().toISOString(), by: "mock" });
      }
    }
    return { sent: true, channelRef: `mock:${esc.id}` };
  }

  /** Mark the escalation id cancelled; its answers become stale (R5). */
  async cancel(id: string): Promise<void> {
    this.cancelled.add(id);
  }

  /**
   * Drain queued answers (persisted mode: answers/ files renamed to
   * answers/processed/ merged with the in-memory queue; a record is
   * returned once even when present in both) then drain inbound/ tasks into
   * the stored plain handler. Never throws.
   */
  async pollOnce(): Promise<EscalationAnswer[]> {
    const fromDisk = this.persisted ? this.drainPersistedAnswers() : [];
    const merged = new Map<string, EscalationAnswer>();
    for (const answer of fromDisk) merged.set(answer.id, answer);
    for (const answer of this.queuedAnswers) merged.set(answer.id, answer);
    this.queuedAnswers = [];
    if (this.persisted) this.drainPersistedInbound();
    return [...merged.values()].map((answer) => (this.cancelled.has(answer.id) ? { ...answer, stale: true } : answer));
  }

  /** Store the plain (non-answer) inbound message handler for injectPlainMessage/injectTask. */
  setPlainMessageHandler(handler: (msg: EscalationInboundMessage) => void): void {
    this.plainHandler = handler;
  }

  /** Record a plain text send (no real channel); persisted mode appends outbound/plain.jsonl. */
  async sendPlainText(target: string, text: string): Promise<{ sent: boolean; channelRef?: string }> {
    const at = new Date().toISOString();
    const channelRef = `mock:plain:${this.nextId()}`;
    this.plainTextLog.push({ target, text, at });
    if (this.persisted) {
      const dir = join(this.persisted.dir, "outbound");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "plain.jsonl"), `${JSON.stringify({ target, text, at, receipt: { sent: true, channelRef } })}\n`);
    }
    return { sent: true, channelRef };
  }

  // ── Test helpers (public, NOT part of the EscalationAdapter interface) ──

  /** Queue an answer for escId; drained by the next pollOnce(). Persisted mode writes answers/ans-<n>.json first. */
  injectAnswer(escId: string, answer: string, by = "mock"): void {
    const record: EscalationAnswer = { id: escId, answer, at: new Date().toISOString(), by };
    if (this.persisted) this.persistJson(join(this.persisted.dir, "answers"), "ans", record);
    this.queuedAnswers.push(record);
  }

  /** Route a plain (non-answer) inbound message to the stored handler, if any. */
  injectPlainMessage(text: string, by = "mock"): void {
    const msg: { id: string; text: string; at: string; by?: string } = {
      id: `mock:plain:${this.nextId()}`,
      text,
      at: new Date().toISOString(),
      by,
    };
    if (this.persisted) this.persistJson(join(this.persisted.dir, "inbound"), "task", msg);
    this.plainHandler?.(msg);
  }

  /**
   * Persist a plain (non-answer) inbound task and route it to the stored
   * handler, if any. Alias of injectPlainMessage with a task-flavored id;
   * in persisted mode the message is durably written to
   * <dir>/inbound/task-<n>.json (atomic tmp+rename) BEFORE the in-memory
   * handler fires, so a second adapter/process polling the same dir
   * receives it even when this process never had a handler.
   */
  injectTask(text: string, by = "mock"): void {
    const msg: { id: string; text: string; at: string; by?: string } = {
      id: `mock:task:${this.nextId()}`,
      text,
      at: new Date().toISOString(),
      by,
    };
    if (this.persisted) this.persistJson(join(this.persisted.dir, "inbound"), "task", msg);
    this.plainHandler?.(msg);
  }

  /** Clear queues, logs, cancelled ids and the plain handler; persisted mode empties the persisted dirs. */
  reset(): void {
    this.sentEscalations = [];
    this.queuedAnswers = [];
    this.cancelled.clear();
    this.plainHandler = null;
    this.plainTextLog.length = 0;
    this.counter = 0;
    if (this.persisted) {
      for (const sub of ["inbound", "answers", "outbound"] as const) {
        try {
          rmSync(join(this.persisted.dir, sub), { recursive: true, force: true });
        } catch {
          // best-effort — the in-memory reset is the primary contract
        }
      }
    }
  }

  // ── Persisted fake-RW internals ──────────────────────────────────────────

  /**
   * Atomically persist `data` as `<dir>/<prefix>-<n>.json` (unique tmp name
   * + rename; the number bumps past name collisions). Throws on IO failure —
   * a corrupt dir is a real error the test/consumer should see.
   */
  private persistJson(dir: string, prefix: string, data: unknown): string {
    mkdirSync(dir, { recursive: true });
    let n = this.nextId();
    let path = join(dir, `${prefix}-${n}.json`);
    while (existsSync(path)) {
      n = this.nextId();
      path = join(dir, `${prefix}-${n}.json`);
    }
    const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`);
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
    return path;
  }

  /** Append one JSON line to outbound/messages.jsonl per send(). */
  private appendOutboundMessage(esc: Escalation): void {
    const dir = join(this.persisted!.dir, "outbound");
    mkdirSync(dir, { recursive: true });
    // intent is an additive envelope field (CtoDelivery) — not part of core's Escalation shape.
    const envelope = esc as Escalation & { intent?: string };
    const record = {
      escId: esc.id,
      intent: envelope.intent,
      title: esc.title,
      body: esc.body,
      at: new Date().toISOString(),
      receipt: { sent: true, channelRef: `mock:${esc.id}` },
    };
    appendFileSync(join(dir, "messages.jsonl"), `${JSON.stringify(record)}\n`);
  }

  /**
   * Drain answers/ files: read -> rename to answers/processed/. The rename
   * is the at-most-once consume under concurrent consumers (a file is gone
   * from answers/ once renamed; a rename race between two readers is
   * deduped downstream by the dispatcher/state layer); unreadable or
   * malformed files are left in place for the next poll.
   */
  private drainPersistedAnswers(): EscalationAnswer[] {
    const dir = join(this.persisted!.dir, "answers");
    const out: EscalationAnswer[] = [];
    try {
      if (!existsSync(dir)) return out;
      const processed = join(dir, "processed");
      mkdirSync(processed, { recursive: true });
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const path = join(dir, name);
        try {
          const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<EscalationAnswer>;
          if (typeof raw?.id !== "string" || typeof raw.answer !== "string") continue; // malformed — left in place
          renameSync(path, join(processed, name));
          out.push(raw as EscalationAnswer);
        } catch {
          // unreadable / rename failure — left in place for the next poll
        }
      }
    } catch {
      // dir missing / unreadable — nothing to drain
    }
    return out;
  }

  /**
   * Drain inbound/ task files into the stored plain handler: read -> invoke
   * the handler -> rename to inbound/processed/. The handler runs BEFORE the
   * rename so a throwing handler (e.g. the dispatcher's wake failure) leaves
   * the file in place for the next poll's retry; the transport re-files with
   * a fresh inbox file because handleInboxTask rolls back on wake failure.
   *
   * SEC-2: files that can NEVER be delivered are not skipped forever —
   * malformed (id missing/non-string or text missing/non-string), empty
   * after trim, or oversized (text > MAX_INBOX_TEXT_LENGTH) are moved to
   * inbound/rejected/ with a durable actionable record next to them.
   */
  private drainPersistedInbound(): void {
    const dir = join(this.persisted!.dir, "inbound");
    try {
      if (!existsSync(dir)) return;
      const processed = join(dir, "processed");
      mkdirSync(processed, { recursive: true });
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const path = join(dir, name);
        try {
          const raw = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown; text?: unknown; at?: unknown; by?: unknown };
          const id = typeof raw?.id === "string" ? raw.id : undefined;
          const text = typeof raw?.text === "string" ? raw.text : "";
          if (id === undefined || typeof raw.text !== "string") {
            this.moveInboundToRejected(path, name, "malformed (missing id or text)", id);
            continue;
          }
          if (text.trim().length === 0) {
            this.moveInboundToRejected(path, name, "empty text", id);
            continue;
          }
          if (text.trim().length > MAX_INBOX_TEXT_LENGTH) {
            this.moveInboundToRejected(path, name, "text exceeds MAX_INBOX_TEXT_LENGTH", id);
            continue;
          }
          const msg: { id: string; text: string; at: string; by?: string } = {
            id,
            text,
            at: typeof raw.at === "string" ? raw.at : new Date().toISOString(),
            by: typeof raw.by === "string" ? raw.by : undefined,
          };
          this.plainHandler?.(msg);
          renameSync(path, join(processed, name));
        } catch {
          // handler failure or unreadable — left in place for retry
        }
      }
    } catch {
      // dir missing / unreadable — nothing to drain
    }
  }

  /**
   * Move a rejected inbound file to `<dir>/inbound/rejected/` and write a
   * durable actionable record NEXT to it (rejected/<name>.json):
   * `{ file, reason, at, id? }`. Best-effort, NEVER throws — on failure the
   * file stays in inbound/ and is re-seen (and re-rejected) next poll.
   */
  private moveInboundToRejected(path: string, name: string, reason: string, id?: string): void {
    try {
      const rejectedDir = join(this.persisted!.dir, "inbound", "rejected");
      mkdirSync(rejectedDir, { recursive: true });
      const record: { file: string; reason: string; at: string; id?: string } = {
        file: name,
        reason,
        at: new Date().toISOString(),
        ...(id !== undefined ? { id } : {}),
      };
      writeFileSync(join(rejectedDir, `${name}.json`), JSON.stringify(record, null, 2));
      renameSync(path, join(rejectedDir, name));
    } catch {
      // best-effort — the file stays and will be re-seen (and re-rejected)
    }
  }

  private nextId(): number {
    this.counter += 1;
    return this.counter;
  }
}

/**
 * Register the mock transport so `.omp/escalation.json` `{"adapter":"mock"}`
 * (and the `loadEscalationConfig` + `createEscalationAdapter` path) builds it
 * like any built-in. Additive `config.mock = { persisted?: boolean, dir? }`:
 * `persisted: true` constructs the fake-RW adapter rooted at
 * `resolve(cwd, dir ?? ".omp/fake-rw")`; legacy `{adapter:"mock"}` (no
 * `mock` key) stays fully in-memory. Called once from registry.ts module
 * scope; the registry→mock→registry import cycle is safe because both sides
 * only call each other's functions after module evaluation completes
 * (function declarations are hoisted, and the factory closure defers class
 * access to construction time).
 *
 * SEC-5: the persisted `dir` is resolved under the project cwd, so it is
 * validated at this CONFIG boundary before resolving — an absolute dir or
 * one containing a `..` segment throws (the adapter would otherwise escape
 * the project cwd and write outside it). The constructor itself stays
 * permissive: direct construction with absolute tmp dirs is a test seam and
 * must keep working. A factory throw is handled by the registry callers
 * (createChannelSet degrades the adapter to null; createEscalationAdapter
 * returns null).
 */
export function registerMockAdapter(): void {
  const factory: EscalationAdapterFactory = (config, cwd) => {
    // config.mock is an additive consumer field: { persisted?: boolean; dir?: string }.
    const mock = config.mock as { persisted?: boolean; dir?: string } | undefined;
    if (mock?.persisted === true) {
      if (mock.dir !== undefined) {
        const escapesCwd =
          isAbsolute(mock.dir) || mock.dir.split("/").concat(mock.dir.split("\\")).some((segment) => segment === "..");
        if (escapesCwd) {
          throw new Error(`mock persisted dir must be a relative path inside the project cwd (got "${mock.dir}")`);
        }
      }
      return new MockEscalationAdapter({ persisted: { dir: resolve(cwd, mock.dir ?? ".omp/fake-rw") } });
    }
    return new MockEscalationAdapter();
  };
  registerEscalationAdapter("mock", factory);
}
