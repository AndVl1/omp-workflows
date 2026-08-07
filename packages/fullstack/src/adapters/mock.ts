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
 * This is a leaf module for the adapter itself (imports only core + node
 * builtins); the sole registry-touching surface is `registerMockAdapter`,
 * which intentionally imports ./registry.js to wire the factory back in.
 */

import {
  type Escalation,
  type EscalationAnswer,
  type EscalationAdapter,
  type EscalationInboundMessage,
  type EscalationReceipt,
} from "@andvl1/omp-workflows-core";
import { registerEscalationAdapter, type EscalationAdapterFactory } from "./registry.js";

export class MockEscalationAdapter implements EscalationAdapter {
  readonly kind = "mock";

  /** All escalations handed to send() — test helper, not part of the adapter interface. */
  sentEscalations: Escalation[] = [];

  private readonly autoAnswer?: (esc: Escalation) => string | null;
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
   */
  constructor(opts?: { fetchImpl?: never; autoAnswer?: (esc: Escalation) => string | null }) {
    if (opts?.fetchImpl) {
      throw new Error("MockEscalationAdapter is in-process only: no network fetch is available (fetchImpl is deliberately unusable)");
    }
    this.autoAnswer = opts?.autoAnswer;
  }

  /** Record the escalation and (optionally) auto-answer it. Never throws. */
  async send(esc: Escalation): Promise<EscalationReceipt> {
    this.sentEscalations.push(esc);
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

  /** Drain the queued answers (clears the queue). Never throws. */
  async pollOnce(): Promise<EscalationAnswer[]> {
    const drained = this.queuedAnswers;
    this.queuedAnswers = [];
    return drained.map((answer) => (this.cancelled.has(answer.id) ? { ...answer, stale: true } : answer));
  }

  /** Store the plain (non-answer) inbound message handler for injectPlainMessage. */
  setPlainMessageHandler(handler: (msg: EscalationInboundMessage) => void): void {
    this.plainHandler = handler;
  }

  /** Record a plain text send (no real channel). */
  async sendPlainText(target: string, text: string): Promise<{ sent: boolean; channelRef?: string }> {
    this.plainTextLog.push({ target, text, at: new Date().toISOString() });
    return { sent: true, channelRef: `mock:plain:${this.nextId()}` };
  }

  // ── Test helpers (public, NOT part of the EscalationAdapter interface) ──

  /** Queue an answer for escId; drained by the next pollOnce(). */
  injectAnswer(escId: string, answer: string, by = "mock"): void {
    this.queuedAnswers.push({ id: escId, answer, at: new Date().toISOString(), by });
  }

  /** Route a plain (non-answer) inbound message to the stored handler, if any. */
  injectPlainMessage(text: string, by = "mock"): void {
    // The `by` source channel rides along on the message; core's
    // EscalationInboundMessage absorbs it structurally (extra field).
    const msg: { id: string; text: string; at: string; by?: string } = {
      id: `mock:plain:${this.nextId()}`,
      text,
      at: new Date().toISOString(),
      by,
    };
    this.plainHandler?.(msg);
  }

  /** Clear queues, logs, cancelled ids and the plain handler. */
  reset(): void {
    this.sentEscalations = [];
    this.queuedAnswers = [];
    this.cancelled.clear();
    this.plainHandler = null;
    this.plainTextLog.length = 0;
    this.counter = 0;
  }

  private nextId(): number {
    this.counter += 1;
    return this.counter;
  }
}

/**
 * Register the mock transport so `.omp/escalation.json` `{"adapter":"mock"}`
 * (and the `loadEscalationConfig` + `createEscalationAdapter` path) builds it
 * like any built-in. Called once from registry.ts module scope; the
 * registry→mock→registry import cycle is safe because both sides only call
 * each other's functions after module evaluation completes (function
 * declarations are hoisted, and the factory closure defers class access to
 * construction time).
 */
export function registerMockAdapter(): void {
  const factory: EscalationAdapterFactory = () => new MockEscalationAdapter();
  registerEscalationAdapter("mock", factory);
}
