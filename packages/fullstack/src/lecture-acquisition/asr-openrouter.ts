import type { EphemeralAudio, LectureAsrPort, LectureAcquisitionRequest, ResolvedVideoSource, TimestampedTranscriptSegment } from "@andvl1/omp-workflows-core";
import { Readable } from "node:stream";
import { DEFAULT_ACQUISITION_LIMITS, HARD_ACQUISITION_LIMITS, normalizeTimestampedTranscriptSegments } from "@andvl1/omp-workflows-core";
import { endpointWithPath, validateEndpoint, type ValidatedEndpoint } from "./endpoint-policy.js";
import { AcquisitionProviderError, classifyProviderHttpStatus, readBoundedResponseText, safeProviderError } from "./provider-errors.js";
import { normalizeAsrResponse } from "./asr.js";
import { parseWavPrelude as parseSharedWavPrelude, readWavMetadata, readWavStructureAt, WavAbortError, WavParseError, type ParsedWavPrelude, type WavPositionalReader } from "./wav.js";
import { ownReadable } from "./readable-lifecycle.js";

function mediaFormatError(): AcquisitionProviderError {
  return providerError("MEDIA_NOT_ACCESSIBLE", "Prepared audio is not a normalized PCM WAV");
}

export const OPENROUTER_NATIVE_ASR_PROVIDER = "openrouter-native-asr" as const;
export const OPENROUTER_NATIVE_ASR_MODEL = "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b" as const;
export const OPENROUTER_NATIVE_ASR_DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1" as const;
export const OPENROUTER_NATIVE_ASR_DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const OPENROUTER_NATIVE_ASR_HARD_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
export const OPENROUTER_NATIVE_ASR_MAX_SEGMENT_CHARACTERS = 8_192;
export const OPENROUTER_NATIVE_ASR_MAX_DURATION_SECONDS = 86_400;
export const OPENROUTER_NATIVE_ASR_DEFAULT_CHUNK_DURATION_SECONDS = 45;
export const OPENROUTER_NATIVE_ASR_HARD_MAX_CHUNK_DURATION_SECONDS = 60;
export const OPENROUTER_NATIVE_ASR_DEFAULT_CHUNK_TIMEOUT_MS = 60_000;
export const OPENROUTER_NATIVE_ASR_HARD_MAX_CHUNK_TIMEOUT_MS = 120_000;

/** The researched model price used only for conservative budget reservation. */
const OPENROUTER_NATIVE_ASR_ESTIMATED_COST_CENTS_PER_SECOND = 0.0003;
const OPENROUTER_NATIVE_ASR_FRAME_BYTES = 2;
const OPENROUTER_NATIVE_ASR_SAMPLE_RATE = 16_000;
const OPENROUTER_NATIVE_ASR_HEADER_BYTES = 44;
const OPENROUTER_NATIVE_ASR_FIXED_JSON_RESERVE = 512;

/**
 * Native OpenRouter STT uses one bounded JSON envelope. The adapter owns the
 * wire format and never returns or stores the request body/provider payload.
 */
export interface OpenRouterNativeAsrOptions {
  endpoint: string;
  apiKeyEnv: string;
  env?: Record<string, string | undefined>;
  model?: string;
  /** Single-request compatibility threshold; total lease bounds come from the request limits. */
  maxInputBytes?: number;
  maxRequestBytes?: number;
  maxResponseBytes: number;
  maxTranscriptCharacters: number;
  maxSegments?: number;
  maxChunkCharacters?: number;
  maxDurationSeconds?: number;
  chunkDurationSeconds?: number;
  chunkTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export type OpenRouterTimestampMode = "provider" | "estimated";

export interface OpenRouterNativeAsrUsage {
  requests: number;
  requestedAudioSeconds: number;
  reportedAudioSeconds?: number;
  estimatedCostCents: number;
  providerCostCents?: number;
}

export interface OpenRouterNativeAsrResult {
  provider: string;
  model: string;
  segments: TimestampedTranscriptSegment[];
  /** Explicitly distinguishes bounded duration estimates from provider timecodes. */
  timestampMode: OpenRouterTimestampMode;
  /** Additive in-process usage; never persisted in the lecture artifact. */
  usage?: OpenRouterNativeAsrUsage;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface ParsedUsage {
  seconds?: number;
  costUsd?: number;
}

interface ParsedResponse extends OpenRouterNativeAsrResult {
  parsedUsage?: ParsedUsage;
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedInteger(value: number | undefined, fallback: number, name: string, maximum: number, minimum = 1): number {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < minimum || actual > maximum) throw new RangeError(`invalid ${name}`);
  return actual;
}

function effectiveChunkCharacters(value: number | undefined): number {
  const configured = boundedInteger(value, OPENROUTER_NATIVE_ASR_MAX_SEGMENT_CHARACTERS, "maxChunkCharacters", HARD_ACQUISITION_LIMITS.maxChunkCharacters);
  return Math.min(configured, OPENROUTER_NATIVE_ASR_MAX_SEGMENT_CHARACTERS);
}

/** Keep enough room for JSON keys, model, and the input_audio envelope. */
function maxRawBytesForRequest(maxRequestBytes: number): number {
  return Math.floor((maxRequestBytes - OPENROUTER_NATIVE_ASR_FIXED_JSON_RESERVE) * 3 / 4);
}

function providerError(code: ConstructorParameters<typeof AcquisitionProviderError>[0], message: string, status?: number): AcquisitionProviderError {
  return new AcquisitionProviderError(code, message, {
    provider: OPENROUTER_NATIVE_ASR_PROVIDER,
    retryable: false,
    ...(status === undefined ? {} : { status }),
  });
}

function nonRetryableProviderError(error: unknown): AcquisitionProviderError {
  const sanitized = safeProviderError(OPENROUTER_NATIVE_ASR_PROVIDER, error);
  return new AcquisitionProviderError(sanitized.code, sanitized.message, {
    provider: OPENROUTER_NATIVE_ASR_PROVIDER,
    retryable: false,
    ...(sanitized.status === undefined ? {} : { status: sanitized.status }),
  });
}

function timeoutError(): AcquisitionProviderError {
  return providerError("PROVIDER_TIMEOUT", "OpenRouter ASR timed out");
}

function endpointFor(options: OpenRouterNativeAsrOptions): ValidatedEndpoint {
  let endpoint: ValidatedEndpoint;
  try {
    endpoint = validateEndpoint(options.endpoint, { trust: "trusted-remote", provider: "openrouter" });
  } catch {
    throw providerError("INVALID_URL", "OpenRouter ASR endpoint is not allowed");
  }
  // The native adapter is intentionally not a generic trusted-remote client.
  // Restrict it to the OpenRouter origin before appending a fixed route.
  const authority = options.endpoint.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1] ?? "";
  if (authority.includes("@") || authority.includes(":") || endpoint.url.hostname.toLowerCase() !== "openrouter.ai" || endpoint.pathname !== "/api/v1") {
    throw providerError("INVALID_URL", "OpenRouter ASR endpoint is not allowed");
  }
  return endpoint;
}

function keyAtCallTime(options: OpenRouterNativeAsrOptions): string | undefined {
  const value = options.env?.[options.apiKeyEnv] ?? process.env[options.apiKeyEnv];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw timeoutError();
}

type OpenedWavInput = {
  iterator: AsyncIterator<Uint8Array>;
  dispose: () => Promise<void>;
};

function positionalReaderFor(audio: EphemeralAudio): WavPositionalReader | undefined {
  const candidate = audio as Partial<WavPositionalReader>;
  if (typeof candidate.readAt !== "function") return undefined;
  return { readAt: candidate.readAt.bind(audio) };
}

async function openWavInput(audio: EphemeralAudio, signal: AbortSignal): Promise<OpenedWavInput> {
  const input = await audio.open(signal);
  if (input instanceof Readable) {
    const owned = ownReadable(input, "Prepared audio stream closed before EOF");
    const iterator = owned.iterable[Symbol.asyncIterator]();
    return {
      iterator,
      dispose: async () => {
        try {
          await iterator.return?.();
        } catch {
          // The enclosing ASR error remains authoritative.
        }
        await owned.dispose();
      },
    };
  }
  const iterator = input[Symbol.asyncIterator]();
  return {
    iterator,
    dispose: async () => {
      try {
        await iterator.return?.();
      } catch {
        // The enclosing ASR error remains authoritative.
      }
    },
  };
}

async function preflightCompleteWav(audio: EphemeralAudio, signal: AbortSignal): Promise<{ dataBytes: number; durationSeconds: number }> {
  try {
    const positional = positionalReaderFor(audio);
    if (positional) return await readWavStructureAt(positional, audio.sizeBytes, signal);
    let opened: OpenedWavInput;
    try {
      opened = await openWavInput(audio, signal);
    } catch (error) {
      if (error instanceof AcquisitionProviderError) throw error;
      if (signal.aborted) throw timeoutError();
      throw mediaFormatError();
    }
    try {
      return await readWavMetadata(opened.iterator, audio.sizeBytes, signal);
    } finally {
      await opened.dispose();
    }
  } catch (error) {
    if (error instanceof AcquisitionProviderError) throw error;
    if (signal.aborted || error instanceof WavAbortError) throw timeoutError();
    if (error instanceof WavParseError) throw mediaFormatError();
    throw mediaFormatError();
  }
}

async function readBoundedAudio(audio: EphemeralAudio, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!Number.isInteger(audio.sizeBytes) || audio.sizeBytes < 0 || audio.sizeBytes > maxBytes) {
    throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR audio exceeds the configured request bound");
  }
  checkAbort(signal);
  let input: AsyncIterable<Uint8Array>;
  try {
    input = await audio.open(signal);
  } catch (error) {
    if (error instanceof AcquisitionProviderError) throw error;
    if (signal.aborted) throw timeoutError();
    throw providerError("MEDIA_NOT_ACCESSIBLE", "Prepared audio could not be read");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of input) {
      checkAbort(signal);
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR audio exceeds the configured request bound");
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof AcquisitionProviderError) throw error;
    if (signal.aborted) throw timeoutError();
    throw providerError("MEDIA_NOT_ACCESSIBLE", "Prepared audio could not be read");
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function responseDuration(payload: JsonRecord, audio: EphemeralAudio, maxDurationSeconds: number): number {
  const preparedDuration = positiveFinite(audio.durationSeconds);
  const usage = record(payload.usage) ? positiveFinite(payload.usage.seconds) : undefined;
  const duration = preparedDuration !== undefined && usage !== undefined
    ? Math.min(preparedDuration, usage)
    : preparedDuration ?? usage;
  if (duration === undefined || duration > maxDurationSeconds) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned no usable duration");
  return duration;
}

function parseUsage(payload: JsonRecord): ParsedUsage | undefined {
  if (!record(payload.usage)) return undefined;
  const seconds = positiveFinite(payload.usage.seconds);
  const costUsd = nonNegativeFinite(payload.usage.cost);
  return seconds === undefined && costUsd === undefined ? undefined : {
    ...(seconds === undefined ? {} : { seconds }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function splitBoundedText(text: string, maxCharacters: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + maxCharacters);
    // Do not split a UTF-16 surrogate pair while preserving the core's
    // bounded `string.length` invariant.
    if (end < text.length && end > offset && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
    if (end <= offset) end = Math.min(text.length, offset + maxCharacters);
    const chunk = text.slice(offset, end);
    if (!chunk) break;
    chunks.push(chunk);
    offset = end;
  }
  return chunks;
}

function splitProviderSegments(payload: JsonRecord, maxChunkCharacters: number): JsonRecord {
  if (!Array.isArray(payload.segments)) return payload;
  const output: unknown[] = [];
  for (const item of payload.segments) {
    if (!record(item) || typeof item.text !== "string") {
      output.push(item);
      continue;
    }
    const text = item.text.trim();
    if (text.length <= maxChunkCharacters) {
      output.push(item);
      continue;
    }
    const startSeconds = typeof item.start_seconds === "number" ? item.start_seconds : item.start;
    const endSeconds = typeof item.end_seconds === "number" ? item.end_seconds : item.end;
    if (
      typeof startSeconds !== "number" ||
      typeof endSeconds !== "number" ||
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      startSeconds < 0 ||
      endSeconds <= startSeconds
    ) {
      // Leave malformed timestamps for normalizeAsrResponse to reject; never
      // invent boundaries just to fit the core segment limit.
      output.push(item);
      continue;
    }
    const chunks = splitBoundedText(text, maxChunkCharacters);
    const splitItems: JsonRecord[] = [];
    let consumedCharacters = 0;
    let valid = true;
    for (const [index, chunk] of chunks.entries()) {
      const chunkStart = startSeconds + (endSeconds - startSeconds) * consumedCharacters / text.length;
      consumedCharacters += chunk.length;
      const chunkEnd = index === chunks.length - 1
        ? endSeconds
        : startSeconds + (endSeconds - startSeconds) * consumedCharacters / text.length;
      if (!Number.isFinite(chunkStart) || !Number.isFinite(chunkEnd) || chunkEnd <= chunkStart) {
        valid = false;
        break;
      }
      const split: JsonRecord = { ...item, text: chunk };
      if ("start_seconds" in item) split.start_seconds = chunkStart;
      if ("end_seconds" in item) split.end_seconds = chunkEnd;
      if (!("start_seconds" in item) && "start" in item) split.start = chunkStart;
      if (!("end_seconds" in item) && "end" in item) split.end = chunkEnd;
      const providerId = typeof item.id === "string" ? item.id : undefined;
      if (providerId !== undefined && index > 0) {
        const suffix = `-${index}`;
        split.id = providerId.length + suffix.length <= 128 ? `${providerId}${suffix}` : `segment-${index}`;
      }
      splitItems.push(split);
    }
    if (valid && splitItems.length === chunks.length) output.push(...splitItems);
    else output.push(item);
  }
  return { ...payload, segments: output };
}

/**
 * Convert text-only provider output into coarse, deterministic windows. These
 * are explicitly estimated and must never be presented as provider timing.
 */
export function estimateOpenRouterTimestampedSegments(
  text: string,
  durationSeconds: number,
  options: { maxCharacters: number; maxSegments?: number; maxChunkCharacters?: number; frameAligned?: boolean },
): TimestampedTranscriptSegment[] {
  const trimmed = text.trim();
  if (!trimmed) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned empty text");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > OPENROUTER_NATIVE_ASR_MAX_DURATION_SECONDS) {
    throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned no usable duration");
  }
  if (!Number.isInteger(options.maxCharacters) || options.maxCharacters < 1 || trimmed.length > options.maxCharacters) {
    throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR transcript exceeds the configured bound");
  }
  const maxChunkCharacters = effectiveChunkCharacters(options.maxChunkCharacters);
  const chunks = splitBoundedText(trimmed, maxChunkCharacters);
  if (!chunks.length || (options.maxSegments !== undefined && chunks.length > options.maxSegments)) {
    throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR transcript exceeds the configured segment bound");
  }
  const totalCharacters = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const totalFrames = options.frameAligned ? Math.round(durationSeconds * OPENROUTER_NATIVE_ASR_SAMPLE_RATE) : undefined;
  const segments: TimestampedTranscriptSegment[] = [];
  let consumedCharacters = 0;
  for (const [index, chunk] of chunks.entries()) {
    const startFrame = totalFrames === undefined ? undefined : Math.floor(totalFrames * consumedCharacters / totalCharacters);
    const startSeconds = startFrame === undefined ? durationSeconds * consumedCharacters / totalCharacters : startFrame / OPENROUTER_NATIVE_ASR_SAMPLE_RATE;
    consumedCharacters += chunk.length;
    const endFrame = totalFrames === undefined
      ? undefined
      : index === chunks.length - 1
        ? totalFrames
        : Math.floor(totalFrames * consumedCharacters / totalCharacters);
    const endSeconds = endFrame === undefined ? durationSeconds * consumedCharacters / totalCharacters : endFrame / OPENROUTER_NATIVE_ASR_SAMPLE_RATE;
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR estimate could not be bounded");
    segments.push({
      segmentId: `estimated-${index}`,
      text: chunk,
      startSeconds,
      endSeconds,
      // Zero is deliberate: this is not provider confidence.
      confidence: 0,
      timestampSource: "estimated",
    });
  }
  try {
    return normalizeTimestampedTranscriptSegments(segments, options.maxCharacters);
  } catch (error) {
    if (error instanceof AcquisitionProviderError) throw error;
    throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR transcript exceeds the configured bounds");
  }
}

function validateProviderSegments(
  result: { segments: TimestampedTranscriptSegment[] },
  durationSeconds: number,
  maxChunkCharacters: number,
): void {
  for (const segment of result.segments) {
    if (
      segment.text.length > maxChunkCharacters ||
      segment.startSeconds < 0 ||
      segment.endSeconds <= segment.startSeconds ||
      segment.endSeconds > durationSeconds
    ) {
      throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned unbounded timestamps");
    }
  }
}

function chatCompletionText(payload: JsonRecord): string {
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned no chat completion choices");
  const first = payload.choices[0];
  if (!record(first) || !record(first.message)) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned no chat completion message");
  const content = first.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned no chat completion text");
  let extracted = "";
  for (const part of content) {
    if (!record(part) || typeof part.text !== "string" || (part.type !== undefined && part.type !== "text")) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned an invalid chat completion text part");
    extracted += part.text;
  }
  return extracted;
}

function parseResponse(
  text: string,
  audio: EphemeralAudio,
  options: OpenRouterNativeAsrOptions,
  model: string,
  durationOverride?: number,
  maxSegmentsOverride?: number,
  maxCharactersOverride?: number,
): ParsedResponse {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned malformed JSON");
  }
  if (!record(payload)) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned an invalid response");
  const maxSegments = maxSegmentsOverride ?? options.maxSegments;
  const maxCharacters = maxCharactersOverride ?? options.maxTranscriptCharacters;
  const parsedUsage = parseUsage(payload);
  if (Array.isArray(payload.segments) && payload.segments.length > 0) {
    let normalized;
    try {
      normalized = normalizeAsrResponse(splitProviderSegments(payload, effectiveChunkCharacters(options.maxChunkCharacters)), {
        provider: OPENROUTER_NATIVE_ASR_PROVIDER,
        model,
        maxCharacters,
        maxSegments,
      });
    } catch (error) {
      if (error instanceof AcquisitionProviderError) throw error;
      throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned invalid segments");
    }
    const duration = durationOverride ?? responseDuration(payload, audio, options.maxDurationSeconds ?? OPENROUTER_NATIVE_ASR_MAX_DURATION_SECONDS);
    validateProviderSegments(normalized, duration, effectiveChunkCharacters(options.maxChunkCharacters));
    const segments = normalized.segments.map((segment) => ({ ...segment, timestampSource: "provider" as const }));
    return { provider: OPENROUTER_NATIVE_ASR_PROVIDER, model, segments, timestampMode: "provider", ...(parsedUsage === undefined ? {} : { parsedUsage }) };
  }
  const transcriptText = "choices" in payload
    ? chatCompletionText(payload)
    : typeof payload.text === "string"
      ? payload.text
      : undefined;
  if (transcriptText === undefined) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned no transcript text");
  const duration = durationOverride ?? responseDuration(payload, audio, options.maxDurationSeconds ?? OPENROUTER_NATIVE_ASR_MAX_DURATION_SECONDS);
  const segments = estimateOpenRouterTimestampedSegments(transcriptText, duration, {
    maxCharacters,
    maxSegments,
    maxChunkCharacters: options.maxChunkCharacters,
    frameAligned: durationOverride !== undefined,
  });
  return { provider: OPENROUTER_NATIVE_ASR_PROVIDER, model, segments, timestampMode: "estimated", ...(parsedUsage === undefined ? {} : { parsedUsage }) };
}

function requestBody(bytes: Uint8Array, model: string, maxRequestBytes: number): string {
  if (bytes.byteLength > maxRawBytesForRequest(maxRequestBytes)) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR request exceeds the configured bound");
  const inputAudio = Buffer.from(bytes).toString("base64");
  const body = JSON.stringify({
    model,
    messages: [{
      role: "user",
      content: [{
        type: "input_audio",
        input_audio: { data: inputAudio, format: "wav" },
      }],
    }],
  });
  if (Buffer.byteLength(body, "utf8") > maxRequestBytes) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR request exceeds the configured bound");
  return body;
}

function canonicalWav(pcm: Uint8Array): Uint8Array {
  if (pcm.byteLength % OPENROUTER_NATIVE_ASR_FRAME_BYTES !== 0 || pcm.byteLength > 0xffff_ffff - 36) throw providerError("MEDIA_NOT_ACCESSIBLE", "OpenRouter ASR chunk audio is invalid");
  const wav = new Uint8Array(OPENROUTER_NATIVE_ASR_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(wav.buffer);
  wav.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, 36 + pcm.byteLength, true);
  wav.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  wav.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt 
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, OPENROUTER_NATIVE_ASR_SAMPLE_RATE, true);
  view.setUint32(28, OPENROUTER_NATIVE_ASR_SAMPLE_RATE * OPENROUTER_NATIVE_ASR_FRAME_BYTES, true);
  view.setUint16(32, OPENROUTER_NATIVE_ASR_FRAME_BYTES, true);
  view.setUint16(34, 16, true);
  wav.set([0x64, 0x61, 0x74, 0x61], 36); // data
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, OPENROUTER_NATIVE_ASR_HEADER_BYTES);
  return wav;
}

function maxAudioBytesForRequest(request: LectureAcquisitionRequest): number {
  const value = request.limits.maxAudioBytes ?? DEFAULT_ACQUISITION_LIMITS.maxAudioBytes;
  if (!Number.isInteger(value) || value < 1 || value > HARD_ACQUISITION_LIMITS.maxAudioBytes) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR audio limits are invalid");
  return value;
}

function maxChunksForRequest(request: LectureAcquisitionRequest): number {
  const value = request.limits.maxChunksPerSource ?? DEFAULT_ACQUISITION_LIMITS.maxChunksPerSource;
  if (!Number.isInteger(value) || value < 1 || value > HARD_ACQUISITION_LIMITS.maxChunksPerSource) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR request count exceeds the configured bound");
  return value;
}

function maxProviderCostForRequest(request: LectureAcquisitionRequest): number {
  const value = request.limits.maxProviderCostCents ?? DEFAULT_ACQUISITION_LIMITS.maxProviderCostCents;
  if (!Number.isInteger(value) || value < 0 || value > HARD_ACQUISITION_LIMITS.maxProviderCostCents) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR provider budget is invalid");
  return value;
}

function maxDurationForRequest(request: LectureAcquisitionRequest, options: OpenRouterNativeAsrOptions): number {
  const value = options.maxDurationSeconds ?? request.limits.maxDurationSeconds ?? OPENROUTER_NATIVE_ASR_MAX_DURATION_SECONDS;
  if (!Number.isFinite(value) || value <= 0 || value > OPENROUTER_NATIVE_ASR_MAX_DURATION_SECONDS) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR duration exceeds the configured bound");
  return value;
}

function maxSegmentsForRequest(request: LectureAcquisitionRequest, options: OpenRouterNativeAsrOptions): number | undefined {
  const configured = options.maxSegments ?? request.limits.maxTranscriptSegments;
  if (configured === undefined) return undefined;
  if (!Number.isInteger(configured) || configured < 1 || configured > HARD_ACQUISITION_LIMITS.maxTranscriptSegments) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR segment count exceeds the configured bound");
  return configured;
}

function maxCharactersForRequest(request: LectureAcquisitionRequest, options: OpenRouterNativeAsrOptions): number {
  const configured = request.limits.maxTranscriptCharacters === undefined
    ? options.maxTranscriptCharacters
    : Math.min(options.maxTranscriptCharacters, request.limits.maxTranscriptCharacters);
  if (!Number.isInteger(configured) || configured < 1 || configured > HARD_ACQUISITION_LIMITS.maxTranscriptCharacters) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR transcript exceeds the configured bound");
  return configured;
}

function requestDeadlineAt(request: LectureAcquisitionRequest): number {
  const deadlineMs = request.limits.deadlineMs;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > HARD_ACQUISITION_LIMITS.deadlineMs) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR deadline is invalid");
  return Date.now() + deadlineMs;
}

async function fetchChunk(
  fetchImpl: typeof globalThis.fetch,
  endpoint: ValidatedEndpoint,
  key: string,
  body: string,
  signal: AbortSignal,
  deadlineAt: number,
  chunkTimeoutMs: number,
  maxResponseBytes: number,
): Promise<string> {
  checkAbort(signal);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw timeoutError();
  const controller = new AbortController();
  let timedOut = false;
  const abortChild = () => controller.abort();
  signal.addEventListener("abort", abortChild, { once: true });
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(timeoutError());
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Math.min(chunkTimeoutMs, remaining)));
  try {
    let response: Response;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => fetchImpl(endpointWithPath(endpoint, "/chat/completions"), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body,
          redirect: "error",
          signal: controller.signal,
        })),
        aborted,
      ]);
    } catch (error) {
      if (signal.aborted || timedOut || controller.signal.aborted) throw timeoutError();
      throw nonRetryableProviderError(error);
    }
    if (!response.ok) throw nonRetryableProviderError(classifyProviderHttpStatus(OPENROUTER_NATIVE_ASR_PROVIDER, response.status));
    try {
      return await Promise.race([
        readBoundedResponseText(response, maxResponseBytes, OPENROUTER_NATIVE_ASR_PROVIDER),
        aborted,
      ]);
    } catch (error) {
      if (signal.aborted || timedOut || controller.signal.aborted) throw timeoutError();
      throw nonRetryableProviderError(error);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abortChild);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}

function mergeUsage(
  current: { requests: number; requestedAudioSeconds: number; reportedAudioSeconds: number; estimatedAudioSeconds: number; providerCostUsd: number; hasReportedSeconds: boolean; hasProviderCost: boolean },
  durationSeconds: number,
  usage: ParsedUsage | undefined,
): void {
  current.requests += 1;
  current.requestedAudioSeconds += durationSeconds;
  const reportedSeconds = usage?.seconds;
  current.estimatedAudioSeconds += Math.max(durationSeconds, reportedSeconds ?? durationSeconds);
  if (reportedSeconds !== undefined) {
    current.reportedAudioSeconds += reportedSeconds;
    current.hasReportedSeconds = true;
  }
  if (usage?.costUsd !== undefined) {
    current.providerCostUsd += usage.costUsd;
    current.hasProviderCost = true;
  }
}

function estimatedCostCents(seconds: number): number {
  return Math.ceil(seconds * OPENROUTER_NATIVE_ASR_ESTIMATED_COST_CENTS_PER_SECOND);
}

export class OpenRouterNativeAsr implements LectureAsrPort {
  readonly id = OPENROUTER_NATIVE_ASR_PROVIDER;
  readonly model: string;
  private readonly endpoint: ValidatedEndpoint;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxInputBytes: number;
  private readonly maxRequestBytes: number;
  private readonly chunkDurationSeconds: number;
  private readonly chunkTimeoutMs: number;

  constructor(private readonly options: OpenRouterNativeAsrOptions) {
    this.model = options.model ?? OPENROUTER_NATIVE_ASR_MODEL;
    if (this.model !== OPENROUTER_NATIVE_ASR_MODEL) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR model is not supported");
    this.endpoint = endpointFor(options);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    try {
      this.maxRequestBytes = boundedInteger(options.maxRequestBytes, OPENROUTER_NATIVE_ASR_DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes", OPENROUTER_NATIVE_ASR_HARD_MAX_REQUEST_BYTES, 512);
      const requestRawLimit = maxRawBytesForRequest(this.maxRequestBytes);
      const configuredInputLimit = boundedInteger(options.maxInputBytes, Math.max(1, requestRawLimit), "maxInputBytes", 256 * 1024 * 1024);
      this.maxInputBytes = Math.min(configuredInputLimit, requestRawLimit);
      boundedInteger(options.maxResponseBytes, 1, "maxResponseBytes", 10 * 1024 * 1024);
      boundedInteger(options.maxTranscriptCharacters, 1, "maxTranscriptCharacters", 1_000_000);
      if (options.maxSegments !== undefined) boundedInteger(options.maxSegments, 1, "maxSegments", 16_384);
      if (options.maxChunkCharacters !== undefined) effectiveChunkCharacters(options.maxChunkCharacters);
      if (options.maxDurationSeconds !== undefined && (!Number.isFinite(options.maxDurationSeconds) || options.maxDurationSeconds <= 0 || options.maxDurationSeconds > OPENROUTER_NATIVE_ASR_MAX_DURATION_SECONDS)) throw new RangeError("invalid maxDurationSeconds");
      this.chunkDurationSeconds = boundedInteger(options.chunkDurationSeconds, OPENROUTER_NATIVE_ASR_DEFAULT_CHUNK_DURATION_SECONDS, "chunkDurationSeconds", OPENROUTER_NATIVE_ASR_HARD_MAX_CHUNK_DURATION_SECONDS);
      this.chunkTimeoutMs = boundedInteger(options.chunkTimeoutMs, OPENROUTER_NATIVE_ASR_DEFAULT_CHUNK_TIMEOUT_MS, "chunkTimeoutMs", OPENROUTER_NATIVE_ASR_HARD_MAX_CHUNK_TIMEOUT_MS);
    } catch {
      throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR limits are invalid");
    }
  }

  async transcribe(audio: EphemeralAudio, _source: ResolvedVideoSource, request: LectureAcquisitionRequest, signal: AbortSignal): Promise<OpenRouterNativeAsrResult> {
    // Resolve the key for every call, immediately before any audio read/fetch.
    const key = keyAtCallTime(this.options);
    if (!key) throw new AcquisitionProviderError("PROVIDER_AUTH_MISSING", "OpenRouter ASR credentials are unavailable", { provider: this.id, retryable: false });
    const totalAudioLimit = maxAudioBytesForRequest(request);
    if (!Number.isInteger(audio.sizeBytes) || audio.sizeBytes < 0 || audio.sizeBytes > totalAudioLimit) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR audio exceeds the configured lease bound");
    checkAbort(signal);

    // Preserve the existing one-shot path exactly for small prepared fixtures and
    // real short leases. It deliberately does not require a WAV parser.
    if (audio.sizeBytes <= this.maxInputBytes) {
      const bytes = await readBoundedAudio(audio, this.maxInputBytes, signal);
      const body = requestBody(bytes, this.model, this.maxRequestBytes);
      let response: Response;
      try {
        response = await this.fetchImpl(endpointWithPath(this.endpoint, "/chat/completions"), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body,
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw timeoutError();
        throw safeProviderError(this.id, error);
      }
      if (!response.ok) throw classifyProviderHttpStatus(this.id, response.status);
      const responseText = await readBoundedResponseText(response, this.options.maxResponseBytes, this.id);
      const parsed = parseResponse(responseText, audio, this.options, this.model);
      const duration = positiveFinite(audio.durationSeconds) ?? parsed.parsedUsage?.seconds;
      return {
        provider: parsed.provider,
        model: parsed.model,
        segments: parsed.segments,
        timestampMode: parsed.timestampMode,
        ...(duration === undefined && parsed.parsedUsage === undefined ? {} : {
          usage: {
            requests: 1,
            requestedAudioSeconds: duration ?? 0,
            estimatedCostCents: estimatedCostCents(Math.max(duration ?? 0, parsed.parsedUsage?.seconds ?? 0)),
            ...(parsed.parsedUsage?.seconds === undefined ? {} : { reportedAudioSeconds: parsed.parsedUsage.seconds }),
            ...(parsed.parsedUsage?.costUsd === undefined ? {} : { providerCostCents: Math.ceil(parsed.parsedUsage.costUsd * 100) }),
          },
        }),
      };
    }

    const requestRawCapacity = maxRawBytesForRequest(this.maxRequestBytes);
    const maxFramesByRequest = Math.floor((requestRawCapacity - OPENROUTER_NATIVE_ASR_HEADER_BYTES) / OPENROUTER_NATIVE_ASR_FRAME_BYTES);
    if (maxFramesByRequest < 1) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR request envelope cannot hold one PCM frame");
    const framesPerChunk = Math.min(this.chunkDurationSeconds * OPENROUTER_NATIVE_ASR_SAMPLE_RATE, maxFramesByRequest);
    const maxChunks = maxChunksForRequest(request);
    const maxDurationSeconds = maxDurationForRequest(request, this.options);
    const maxProviderCostCents = maxProviderCostForRequest(request);
    const maxSegments = maxSegmentsForRequest(request, this.options);
    const maxCharacters = maxCharactersForRequest(request, this.options);
    const deadlineAt = requestDeadlineAt(request);
    checkAbort(signal);
    if (deadlineAt <= Date.now()) throw timeoutError();

    const preflight = await preflightCompleteWav(audio, signal);
    const totalFrames = preflight.dataBytes / OPENROUTER_NATIVE_ASR_FRAME_BYTES;
    if (preflight.durationSeconds > maxDurationSeconds) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR audio exceeds the configured duration bound");
    const chunkCount = Math.ceil(totalFrames / framesPerChunk);
    const predictedCost = estimatedCostCents(preflight.durationSeconds);
    if (chunkCount > maxChunks || predictedCost > maxProviderCostCents) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR request plan exceeds the configured bound");

    let sourceInput: OpenedWavInput;
    try {
      sourceInput = await openWavInput(audio, signal);
    } catch (error) {
      if (error instanceof AcquisitionProviderError) throw error;
      if (signal.aborted) throw timeoutError();
      throw mediaFormatError();
    }
    const iterator = sourceInput.iterator;
    const aggregate = {
      requests: 0,
      requestedAudioSeconds: 0,
      reportedAudioSeconds: 0,
      estimatedAudioSeconds: 0,
      providerCostUsd: 0,
      hasReportedSeconds: false,
      hasProviderCost: false,
    };
    const segments: TimestampedTranscriptSegment[] = [];
    let allProviderTimestamps = true;
    let parsedWav: ParsedWavPrelude | undefined;
    let totalCharacters = 0;

    let sentRequests = 0;
    try {
      parsedWav = await parseSharedWavPrelude(iterator, audio.sizeBytes, signal);
      if (parsedWav.dataBytes !== preflight.dataBytes || parsedWav.durationSeconds !== preflight.durationSeconds) throw new WavParseError();
      for (let ordinal = 0, startFrame = 0; ordinal < chunkCount; ordinal += 1) {
        checkAbort(signal);
        if (deadlineAt <= Date.now()) throw timeoutError();
        if (totalCharacters >= maxCharacters || (maxSegments !== undefined && segments.length >= maxSegments)) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR transcript exceeds the configured bound");
        const chunkFrames = Math.min(framesPerChunk, totalFrames - startFrame);
        if (chunkFrames < 1) throw mediaFormatError();
        const pcm = new Uint8Array(chunkFrames * OPENROUTER_NATIVE_ASR_FRAME_BYTES);
        await parsedWav.reader.readInto(pcm, signal);
        const wav = canonicalWav(pcm);
        const body = requestBody(wav, this.model, this.maxRequestBytes);
        sentRequests += 1;
        if (sentRequests > maxChunks) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR request count exceeds the configured bound");
        const responseText = await fetchChunk(this.fetchImpl, this.endpoint, key, body, signal, deadlineAt, this.chunkTimeoutMs, this.options.maxResponseBytes);
        const chunkDurationSeconds = chunkFrames / OPENROUTER_NATIVE_ASR_SAMPLE_RATE;
        const remainingCharacters = maxCharacters - totalCharacters;
        if (remainingCharacters < 1) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR transcript exceeds the configured bound");
        const parsed = parseResponse(responseText, audio, this.options, this.model, chunkDurationSeconds, maxSegments === undefined ? undefined : maxSegments - segments.length, remainingCharacters);
        if (maxSegments !== undefined && segments.length + parsed.segments.length > maxSegments) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR transcript exceeds the configured segment bound");
        const chunkStartSeconds = startFrame / OPENROUTER_NATIVE_ASR_SAMPLE_RATE;
        const chunkEndSeconds = (startFrame + chunkFrames) / OPENROUTER_NATIVE_ASR_SAMPLE_RATE;
        for (const [localIndex, segment] of parsed.segments.entries()) {
          const globalStart = segment.startSeconds === 0 ? chunkStartSeconds : chunkStartSeconds + segment.startSeconds;
          const globalEnd = segment.endSeconds === chunkDurationSeconds ? chunkEndSeconds : chunkStartSeconds + segment.endSeconds;
          if (!Number.isFinite(globalStart) || !Number.isFinite(globalEnd) || globalStart < 0 || globalEnd <= globalStart || globalEnd > parsedWav.durationSeconds) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned unbounded timestamps");
          segments.push({
            ...segment,
            segmentId: `chunk-${ordinal}-segment-${localIndex}`,
            startSeconds: globalStart,
            endSeconds: globalEnd,
          });
        }
        totalCharacters += parsed.segments.reduce((sum, segment) => sum + segment.text.length, 0);
        allProviderTimestamps = allProviderTimestamps && parsed.timestampMode === "provider";
        mergeUsage(aggregate, chunkDurationSeconds, parsed.parsedUsage);
        const observedCost = Math.max(estimatedCostCents(aggregate.estimatedAudioSeconds), aggregate.hasProviderCost ? Math.ceil(aggregate.providerCostUsd * 100) : 0);
        if (observedCost > maxProviderCostCents) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR provider budget was exceeded");
        startFrame += chunkFrames;
      }
      if (segments.length === 0) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned no transcript segments");
      let normalized: TimestampedTranscriptSegment[];
      try {
        normalized = normalizeTimestampedTranscriptSegments(segments, maxCharacters);
      } catch (error) {
        if (error instanceof AcquisitionProviderError) throw error;
        throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR transcript exceeds the configured bounds");
      }
      if (maxSegments !== undefined && normalized.length > maxSegments) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR transcript exceeds the configured segment bound");
      const indexed = normalized.map((segment, index) => ({ segment, index }));
      indexed.sort((left, right) => left.segment.startSeconds - right.segment.startSeconds || left.segment.endSeconds - right.segment.endSeconds || left.index - right.index);
      for (let index = 1; index < indexed.length; index += 1) {
        if (indexed[index]!.segment.startSeconds < indexed[index - 1]!.segment.startSeconds) throw providerError("INVALID_PROVIDER_RESPONSE", "OpenRouter ASR returned non-monotonic timestamps");
      }
      const observedCost = Math.max(estimatedCostCents(aggregate.estimatedAudioSeconds), aggregate.hasProviderCost ? Math.ceil(aggregate.providerCostUsd * 100) : 0);
      if (observedCost > maxProviderCostCents) throw providerError("LIMIT_EXCEEDED", "OpenRouter ASR provider budget was exceeded");
      return {
        provider: OPENROUTER_NATIVE_ASR_PROVIDER,
        model: this.model,
        segments: indexed.map(({ segment }) => segment),
        timestampMode: allProviderTimestamps ? "provider" : "estimated",
        usage: {
          requests: aggregate.requests,
          requestedAudioSeconds: aggregate.requestedAudioSeconds,
          estimatedCostCents: estimatedCostCents(aggregate.estimatedAudioSeconds),
          ...(aggregate.hasReportedSeconds ? { reportedAudioSeconds: aggregate.reportedAudioSeconds } : {}),
          ...(aggregate.hasProviderCost ? { providerCostCents: Math.ceil(aggregate.providerCostUsd * 100) } : {}),
        },
      };
    } catch (error) {
      if (signal.aborted || error instanceof WavAbortError) throw timeoutError();
      if (error instanceof WavParseError) throw mediaFormatError();
      if (error instanceof AcquisitionProviderError) throw nonRetryableProviderError(error);
      throw nonRetryableProviderError(error);
    } finally {
      await sourceInput.dispose();
    }
  }
}

export const OpenRouterAsr = OpenRouterNativeAsr;

export function createOpenRouterNativeAsr(options: OpenRouterNativeAsrOptions): OpenRouterNativeAsr {
  return new OpenRouterNativeAsr(options);
}

export function createOpenRouterAsr(options: OpenRouterNativeAsrOptions): OpenRouterNativeAsr {
  return new OpenRouterNativeAsr(options);
}
