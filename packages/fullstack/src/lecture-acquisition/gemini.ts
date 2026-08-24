import type { LectureAcquisitionRequest, ResolvedVideoSource } from "@andvl1/omp-workflows-core";
import { classifyProviderHttpStatus, readBoundedResponseText, safeProviderError, AcquisitionProviderError } from "./provider-errors.js";

const PROVIDER = "gemini";
const DEFAULT_INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
export interface GeminiYouTubeOptions { fetch: typeof globalThis.fetch; apiKey: string; model: string; endpoint?: string; maxResponseBytes?: number }

function canonicalVideoUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new AcquisitionProviderError("INVALID_URL", "video URL is invalid", { provider: PROVIDER }); }
  const host = parsed.hostname.toLowerCase();
  const hasForbiddenUrlParts = parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.hash !== "";
  const isWatch = (host === "www.youtube.com" || host === "youtube.com" || host === "m.youtube.com") && parsed.pathname === "/watch";
  const isShort = host === "youtu.be" && /^\/[A-Za-z0-9_-]{11}$/.test(parsed.pathname);
  const queryEntries = [...parsed.searchParams.entries()];
  const validWatchQuery = isWatch && queryEntries.length === 1 && queryEntries[0]?.[0] === "v";
  const validShortQuery = isShort && queryEntries.length === 0;
  if (hasForbiddenUrlParts || (!validWatchQuery && !validShortQuery)) {
    throw new AcquisitionProviderError("UNSUPPORTED_URL", "canonical public YouTube video URL is required", { provider: PROVIDER });
  }
  const id = isShort ? parsed.pathname.slice(1) : parsed.searchParams.get("v");
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new AcquisitionProviderError("INVALID_URL", "canonical public YouTube video URL is required", { provider: PROVIDER });
  }
  return `https://www.youtube.com/watch?v=${id}`;
}
export class GeminiYouTubeProvider {
  readonly id = PROVIDER;
  constructor(private readonly options: GeminiYouTubeOptions) {}
  supports(source: ResolvedVideoSource): boolean { return source.canonicalUrl.includes("youtube.com/watch?v=") || source.canonicalUrl.includes("youtu.be/"); }
  async analyzeYouTubeVideo(source: ResolvedVideoSource, request: LectureAcquisitionRequest, signal: AbortSignal): Promise<unknown> {
    const url = canonicalVideoUrl(source.canonicalUrl);
    const payload = { model: this.options.model, input: [{ type: "text", text: request.prompt }, { type: "video", uri: url }], response_format: { type: "text", mime_type: "application/json", schema: { type: "object", required: ["segments"], properties: { segments: { type: "array", items: { type: "object", required: ["quote", "start_seconds", "end_seconds", "kind", "confidence", "language"], properties: { quote: { type: "string" }, start_seconds: { type: "number" }, end_seconds: { type: "number" }, kind: { type: "string" }, confidence: { type: "string" }, language: { type: "string" } }, additionalProperties: false } } }, additionalProperties: false } } };
    try {
      const endpoint = this.options.endpoint ? `${this.options.endpoint.replace(/\/+$/, "")}/v1beta/interactions` : DEFAULT_INTERACTIONS_ENDPOINT;
      const response = await this.options.fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": this.options.apiKey }, body: JSON.stringify(payload), signal });
      const body = await readBoundedResponseText(response, this.options.maxResponseBytes ?? request.limits.maxResponseBytes, PROVIDER);
      if (!response.ok) throw classifyProviderHttpStatus(PROVIDER, response.status, body);
      let data: unknown; try { data = JSON.parse(body); } catch { throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "provider returned invalid analysis data", { provider: PROVIDER }); }
      const text = extractText(data); if (!text) throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "provider returned no analysis text", { provider: PROVIDER });
      try { return JSON.parse(text); } catch { return text; }
    } catch (error) { throw safeProviderError(PROVIDER, error); }
  }
  async acquire(source: ResolvedVideoSource, request: LectureAcquisitionRequest, signal: AbortSignal) { return { provider: PROVIDER, raw: await this.analyzeYouTubeVideo(source, request, signal) }; }
}
function extractText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const root = value as { steps?: unknown; outputs?: unknown };
  for (const group of [root.steps, root.outputs]) if (Array.isArray(group)) for (const item of group) {
    if (!item || typeof item !== "object") continue; const content = (item as { content?: unknown }).content;
    if (Array.isArray(content)) for (const part of content) if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
    if (typeof (item as { text?: unknown }).text === "string") return (item as { text: string }).text;
  }
  return undefined;
}
export async function analyzeYouTubeVideo(options: GeminiYouTubeOptions, source: ResolvedVideoSource, request: LectureAcquisitionRequest, signal: AbortSignal) { return new GeminiYouTubeProvider(options).analyzeYouTubeVideo(source, request, signal); }
