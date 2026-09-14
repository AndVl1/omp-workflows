/**
 * HTTP-webhook escalation adapter (reference, send-only).
 *
 * POSTs the sanitized Escalation JSON to a consumer URL (ntfy / Slack-style
 * webhook / custom bot). Answer ingestion is out of scope — consumers write
 * answers to `.work-state/cto/<runId>/answers/<escId>.json` themselves
 * (e.g. via their own bot); the Telegram adapter shows the full round trip.
 *
 * `fetchImpl` is injectable for tests; defaults to global fetch. The registry
 * supplies `assertLive` for its authenticated construction path. The raw
 * class remains useful for transport-only tests, but only registry-created
 * instances are eligible for resident delivery.
 */

import type { Escalation, EscalationAdapter, EscalationReceipt, PinnedProjectRoot } from "@andvl1/omp-workflows-core";
import type { AdapterOperationContext } from "./registry.js";

export interface HttpAdapterOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Registry-owned activation fence, checked around every remote effect. */
  assertLive?: () => void;
}

export class HttpEscalationAdapter implements EscalationAdapter {
  readonly kind = "http";
  private readonly url: string;
  private readonly method: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly assertActivationLive?: () => void;

  constructor(options: HttpAdapterOptions) {
    this.url = options.url;
    this.method = options.method ?? "POST";
    this.headers = { "content-type": "application/json", ...(options.headers ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.assertActivationLive = options.assertLive;
  }

  async send(_esc: Escalation, _pinnedRoot?: PinnedProjectRoot, lifecycle?: AdapterOperationContext): Promise<EscalationReceipt> {
    this.assertActivationLive?.();
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: this.method,
        headers: this.headers,
        body: JSON.stringify(_esc),
        ...(lifecycle ? { signal: lifecycle.signal } : {}),
      });
    } catch {
      return { sent: false, channelRef: "http:send-failed" };
    }
    // Do not admit a response from a transport that outlived its activation.
    this.assertActivationLive?.();
    if (!response.ok) return { sent: false, channelRef: `http:${response.status}` };
    return { sent: true, channelRef: `http:${response.status}` };
  }

  /** Send with a stable idempotency key and require matching receiver acknowledgement. */
  async sendWithIdempotency(_esc: Escalation, idempotencyKey: string, _pinnedRoot?: PinnedProjectRoot, lifecycle?: AdapterOperationContext): Promise<EscalationReceipt> {
    const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
    if (!key) return { sent: false, channelRef: "http:idempotency-key-required" };
    this.assertActivationLive?.();
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: this.method,
        headers: { ...this.headers, "idempotency-key": key },
        body: JSON.stringify(_esc),
        ...(lifecycle ? { signal: lifecycle.signal } : {}),
      });
    } catch {
      return { sent: false, channelRef: "http:idempotency-unknown" };
    }
    // A revoked activation must not turn a completed request into an admitted
    // durable receipt, even though the remote endpoint may have received it.
    this.assertActivationLive?.();
    if (!response.ok) return { sent: false, channelRef: `http:${response.status}` };
    const acknowledged = typeof response.headers?.get === "function" && (response.headers.get("idempotency-key") === key || response.headers.get("x-idempotency-key") === key);
    if (!acknowledged) return { sent: false, channelRef: "http:idempotency-unacknowledged" };
    return { sent: true, channelRef: `http:${response.status}` };
  }

  async cancel(_id: string): Promise<void> {
    // There is no HTTP cancellation request, but cancellation still mutates
    // dispatcher state and therefore remains activation-gated.
    this.assertActivationLive?.();
  }
}
