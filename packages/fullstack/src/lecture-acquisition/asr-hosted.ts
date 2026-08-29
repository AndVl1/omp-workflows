import type { EphemeralAudio, LectureAsrPort, LectureAcquisitionRequest, ResolvedVideoSource } from "@andvl1/omp-workflows-core";
import { validateEndpoint, endpointWithPath, type EndpointTrust, type ValidatedEndpoint } from "./endpoint-policy.js";
import { normalizeAsrResponse } from "./asr.js";
import { AcquisitionProviderError, classifyProviderHttpStatus, readBoundedResponseText, safeProviderError } from "./provider-errors.js";

export interface HostedAsrOptions {
  endpoint: string;
  trust: EndpointTrust;
  apiKeyEnv: string;
  env?: Record<string, string | undefined>;
  model: string;
  maxResponseBytes: number;
  maxTranscriptCharacters: number;
  maxSegments?: number;
  fetch?: typeof globalThis.fetch;
}

function multipartStream(audio: EphemeralAudio, model: string, boundary: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let sentPrefix = false;
  let sentSuffix = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) { controller.error(new Error("aborted")); return; }
      if (!sentPrefix) { sentPrefix = true; controller.enqueue(prefix); return; }
      if (!iterator) iterator = (await audio.open(signal))[Symbol.asyncIterator]();
      if (!sentSuffix) {
        const next = await iterator.next();
        if (!next.done) { controller.enqueue(next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value)); return; }
        sentSuffix = true;
        controller.enqueue(suffix);
        controller.close();
      }
    },
    cancel() { iterator = undefined; },
  });
}

function endpointPath(endpoint: ValidatedEndpoint): URL {
  return endpointWithPath(endpoint, "/audio/transcriptions");
}

export class HostedAsr implements LectureAsrPort {
  readonly id = "openai-compatible-asr";
  readonly model: string;
  private readonly endpoint: ValidatedEndpoint;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: HostedAsrOptions) {
    this.model = options.model;
    try {
      this.endpoint = validateEndpoint(options.endpoint, { trust: options.trust, provider: "hosted-asr" });
    } catch {
      throw new AcquisitionProviderError("INVALID_URL", "Hosted ASR endpoint is not allowed", { provider: this.id, retryable: false });
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async transcribe(audio: EphemeralAudio, _source: ResolvedVideoSource, _request: LectureAcquisitionRequest, signal: AbortSignal) {
    const key = this.options.apiKeyEnv ? this.options.env?.[this.options.apiKeyEnv] ?? process.env[this.options.apiKeyEnv] : undefined;
    if (this.options.trust === "trusted-remote" && !key) throw new AcquisitionProviderError("PROVIDER_AUTH_MISSING", "Hosted ASR credentials are unavailable", { provider: this.id, retryable: false });
    const boundary = `ompLecture${Math.random().toString(16).slice(2)}`;
    const body = multipartStream(audio, this.model, boundary, signal);
    let response: Response;
    try {
      response = await this.fetchImpl(endpointPath(this.endpoint), {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body,
        redirect: "error",
        signal,
        // Node's fetch requires this for a streaming request body.
        duplex: "half",
      } as RequestInit & { duplex: "half" });
    } catch (error) {
      if (error instanceof AcquisitionProviderError) throw error;
      if (signal.aborted) throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Hosted ASR timed out", { provider: this.id, retryable: false });
      throw safeProviderError(this.id, error);
    }
    if (!response.ok) {
      const bodyHint = response.status === 401 || response.status === 403 ? "" : "provider response";
      throw classifyProviderHttpStatus(this.id, response.status, bodyHint);
    }
    const text = await readBoundedResponseText(response, this.options.maxResponseBytes, this.id);
    return normalizeAsrResponse(text, { provider: this.id, model: this.model, maxCharacters: this.options.maxTranscriptCharacters, maxSegments: this.options.maxSegments });
  }
}

export function createHostedAsr(options: HostedAsrOptions): HostedAsr {
  return new HostedAsr(options);
}
