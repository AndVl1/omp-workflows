import type { TimestampedTranscriptSegment } from "@andvl1/omp-workflows-core";
import { normalizeTimestampedTranscriptSegments } from "@andvl1/omp-workflows-core";
import { AcquisitionProviderError } from "./provider-errors.js";

export interface NormalizedAsrResult {
  provider: string;
  model?: string;
  segments: TimestampedTranscriptSegment[];
}

export function normalizeAsrResponse(raw: unknown, options: { provider: string; model?: string; maxCharacters: number; maxSegments?: number }): NormalizedAsrResult {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "ASR returned malformed JSON", { provider: options.provider, retryable: false });
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "ASR returned an invalid response", { provider: options.provider, retryable: false });
  const rawSegments = (value as { segments?: unknown }).segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "ASR did not return timestamped segments", { provider: options.provider, retryable: false });
  const segments: TimestampedTranscriptSegment[] = [];
  for (const [index, item] of rawSegments.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "ASR returned an invalid segment", { provider: options.provider, retryable: false });
    const segment = item as Record<string, unknown>;
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    const startSeconds = typeof segment.start_seconds === "number" ? segment.start_seconds : segment.start;
    const endSeconds = typeof segment.end_seconds === "number" ? segment.end_seconds : segment.end;
    const confidence = typeof segment.confidence === "number" ? segment.confidence : undefined;
    if (!text || typeof startSeconds !== "number" || typeof endSeconds !== "number" || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds || startSeconds < 0) {
      throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "ASR returned invalid timestamps", { provider: options.provider, retryable: false });
    }
    segments.push({
      segmentId: typeof segment.id === "string" ? segment.id.slice(0, 128) : `segment-${index}`,
      text,
      startSeconds,
      endSeconds,
      ...(typeof segment.language === "string" && segment.language.length <= 64 ? { language: segment.language } : {}),
      ...(confidence !== undefined && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? { confidence } : {}),
    });
  }
  try {
    const normalized = normalizeTimestampedTranscriptSegments(segments, options.maxCharacters);
    if (options.maxSegments !== undefined && normalized.length > options.maxSegments) throw new RangeError("too many ASR segments");
    return { provider: options.provider, ...(options.model ? { model: options.model } : {}), segments: normalized };
  } catch (error) {
    if (error instanceof AcquisitionProviderError) throw error;
    throw new AcquisitionProviderError("LIMIT_EXCEEDED", "ASR transcript exceeds the configured bounds", { provider: options.provider, retryable: false });
  }
}
