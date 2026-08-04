/**
 * HTTP-webhook escalation adapter (reference, send-only).
 *
 * POSTs the sanitized Escalation JSON to a consumer URL (ntfy / Slack-style
 * webhook / custom bot). Answer ingestion is out of scope — consumers write
 * answers to `.work-state/cto/<runId>/answers/<escId>.json` themselves
 * (e.g. via their own bot); the Telegram adapter shows the full round trip.
 *
 * `fetchImpl` is injectable for tests; defaults to global fetch.
 */

import type { Escalation, EscalationAdapter, EscalationReceipt } from "@andvl1/omp-workflows-core";

export interface HttpAdapterOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class HttpEscalationAdapter implements EscalationAdapter {
  readonly kind = "http";
  private readonly url: string;
  private readonly method: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpAdapterOptions) {
    this.url = options.url;
    this.method = options.method ?? "POST";
    this.headers = { "content-type": "application/json", ...(options.headers ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(esc: Escalation): Promise<EscalationReceipt> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: this.method,
        headers: this.headers,
        body: JSON.stringify(esc),
      });
      if (!response.ok) return { sent: false, channelRef: `http:${response.status}` };
      return { sent: true, channelRef: `http:${response.status}` };
    } catch (error) {
      return { sent: false, channelRef: error instanceof Error ? error.message : String(error) };
    }
  }

  async cancel(_id: string): Promise<void> {
    // Send-only adapter: no cancellation surface. The dispatcher moves the
    // outbox file to sent/ on delivery; a cancel just stops retries there.
  }
}
