/**
 * Provider-neutral contracts for URL-first lecture research.
 *
 * The core package owns only bounded, provider-neutral shapes. Consumer
 * bundles perform the actual URL/media acquisition and must attach the
 * engine-issued binding before persisting an acquisition artifact.
 */
import { canonicalJson, digestOf, isSha256Hex } from "../specification/validation.js";

export const ACQUISITION_STATUSES = ["succeeded", "partial", "failed"] as const;
export type AcquisitionStatus = (typeof ACQUISITION_STATUSES)[number];

export const ACQUISITION_FAILURE_CODES = [
  "INVALID_URL",
  "UNSUPPORTED_URL",
  "VIDEO_NOT_FOUND",
  "PLAYLIST_NOT_FOUND",
  "PRIVATE_OR_UNLISTED",
  "PLAYLIST_TOO_LARGE",
  "CAPTIONS_UNAVAILABLE",
  "MEDIA_NOT_ACCESSIBLE",
  "RIGHTS_REQUIRED",
  "PROVIDER_AUTH_MISSING",
  "QUOTA_EXCEEDED",
  "PROVIDER_TIMEOUT",
  "NETWORK_ERROR",
  "TRANSCRIPT_FAILED",
  "ANALYSIS_FAILED",
  "INVALID_PROVIDER_RESPONSE",
  "LIMIT_EXCEEDED",
  "PARTIAL_SOURCE_SET",
  "OMP_RUNTIME_UNAVAILABLE",
] as const;
export type AcquisitionFailureCode = (typeof ACQUISITION_FAILURE_CODES)[number];

export const EVIDENCE_KINDS = [
  "transcript_excerpt",
  "audio_observation",
  "visual_observation",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_CONFIDENCES = ["low", "medium", "high"] as const;
export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCES)[number];

/** Conservative defaults used by consumers unless setup tightens them. */
export const DEFAULT_ACQUISITION_LIMITS = Object.freeze({
  maxItems: 8,
  maxPages: 4,
  deadlineMs: 300_000,
  maxAttempts: 2,
  maxResponseBytes: 1_048_576,
  maxEvidenceSegmentsPerSource: 64,
  maxAudioBytes: 64 * 1024 * 1024,
  maxTranscriptCharacters: 250_000,
  maxTranscriptSegments: 4_096,
  maxChunkCharacters: 12_000,
  maxChunksPerSource: 128,
  maxAnalysisOutputBytes: 262_144,
  maxProviderCostCents: 5_000,
} satisfies Omit<AcquisitionLimits, "maxDurationSeconds">);

/** Hard bounds a consumer must not exceed when accepting tool-supplied limits. */
export const HARD_ACQUISITION_LIMITS = Object.freeze({
  maxItems: 10,
  maxPages: 100,
  maxDurationSeconds: 86_400,
  deadlineMs: 600_000,
  maxAttempts: 2,
  maxResponseBytes: 10_485_760,
  maxEvidenceSegmentsPerSource: 256,
  maxAudioBytes: 256 * 1024 * 1024,
  maxTranscriptCharacters: 1_000_000,
  maxTranscriptSegments: 16_384,
  maxChunkCharacters: 32_000,
  maxChunksPerSource: 512,
  maxAnalysisOutputBytes: 1_048_576,
  maxProviderCostCents: 100_000,
} satisfies Required<AcquisitionLimits>);

export interface AcquisitionLimits {
  /** Maximum number of videos to resolve from a request. */
  maxItems: number;
  /** Maximum provider pagination pages for playlist expansion. */
  maxPages: number;
  /** Optional trusted duration bound; consumers must not infer it from a URL. */
  maxDurationSeconds?: number;
  /** Overall request deadline in milliseconds. */
  deadlineMs: number;
  /** Maximum attempts for one provider call. */
  maxAttempts: number;
  /** Maximum accepted provider response size in bytes. */
  maxResponseBytes: number;
  /** Maximum normalized evidence segments retained per source. */
  maxEvidenceSegmentsPerSource: number;
  /** Maximum bytes held by any ephemeral audio lease. */
  maxAudioBytes?: number;
  /** Maximum transcript characters retained in memory per source. */
  maxTranscriptCharacters?: number;
  /** Maximum normalized transcript segments accepted from one ASR response. */
  maxTranscriptSegments?: number;
  /** Maximum characters sent in one analysis chunk. */
  maxChunkCharacters?: number;
  /** Maximum analysis chunks processed per source. */
  maxChunksPerSource?: number;
  /** Maximum bytes accepted from one analysis response. */
  maxAnalysisOutputBytes?: number;
  /** Optional estimated provider budget in cents. */
  maxProviderCostCents?: number;
}

/**
 * Validate and normalize a caller-provided limit set without widening the
 * consumer's configured hard bounds. The returned object is a fresh value.
 */
export function normalizeAcquisitionLimits(
  limits: Partial<AcquisitionLimits> | undefined,
  configured: AcquisitionLimits = DEFAULT_ACQUISITION_LIMITS,
): AcquisitionLimits {
  const requested = limits ?? {};
  const value: AcquisitionLimits = {
    maxItems: requested.maxItems ?? configured.maxItems,
    maxPages: requested.maxPages ?? configured.maxPages,
    ...(requested.maxDurationSeconds !== undefined || configured.maxDurationSeconds !== undefined
      ? { maxDurationSeconds: requested.maxDurationSeconds ?? configured.maxDurationSeconds }
      : {}),
    deadlineMs: requested.deadlineMs ?? configured.deadlineMs,
    maxAttempts: requested.maxAttempts ?? configured.maxAttempts,
    maxResponseBytes: requested.maxResponseBytes ?? configured.maxResponseBytes,
    maxEvidenceSegmentsPerSource: requested.maxEvidenceSegmentsPerSource ?? configured.maxEvidenceSegmentsPerSource,
    ...(requested.maxAudioBytes !== undefined || configured.maxAudioBytes !== undefined
      ? { maxAudioBytes: requested.maxAudioBytes ?? configured.maxAudioBytes }
      : {}),
    ...(requested.maxTranscriptCharacters !== undefined || configured.maxTranscriptCharacters !== undefined
      ? { maxTranscriptCharacters: requested.maxTranscriptCharacters ?? configured.maxTranscriptCharacters }
      : {}),
    ...(requested.maxTranscriptSegments !== undefined || configured.maxTranscriptSegments !== undefined
      ? { maxTranscriptSegments: requested.maxTranscriptSegments ?? configured.maxTranscriptSegments }
      : {}),
    ...(requested.maxChunkCharacters !== undefined || configured.maxChunkCharacters !== undefined
      ? { maxChunkCharacters: requested.maxChunkCharacters ?? configured.maxChunkCharacters }
      : {}),
    ...(requested.maxChunksPerSource !== undefined || configured.maxChunksPerSource !== undefined
      ? { maxChunksPerSource: requested.maxChunksPerSource ?? configured.maxChunksPerSource }
      : {}),
    ...(requested.maxAnalysisOutputBytes !== undefined || configured.maxAnalysisOutputBytes !== undefined
      ? { maxAnalysisOutputBytes: requested.maxAnalysisOutputBytes ?? configured.maxAnalysisOutputBytes }
      : {}),
    ...(requested.maxProviderCostCents !== undefined || configured.maxProviderCostCents !== undefined
      ? { maxProviderCostCents: requested.maxProviderCostCents ?? configured.maxProviderCostCents }
      : {}),
  };
  const requiredBounds: Array<readonly [keyof AcquisitionLimits, number, number]> = [
    ["maxItems", 1, HARD_ACQUISITION_LIMITS.maxItems],
    ["maxPages", 1, HARD_ACQUISITION_LIMITS.maxPages],
    ["deadlineMs", 1, HARD_ACQUISITION_LIMITS.deadlineMs],
    ["maxAttempts", 1, HARD_ACQUISITION_LIMITS.maxAttempts],
    ["maxResponseBytes", 1, HARD_ACQUISITION_LIMITS.maxResponseBytes],
    ["maxEvidenceSegmentsPerSource", 1, HARD_ACQUISITION_LIMITS.maxEvidenceSegmentsPerSource],
  ];
  for (const [key, minimum, hardMaximum] of requiredBounds) {
    const configuredValue = configured[key];
    const actual = value[key];
    if (!Number.isSafeInteger(configuredValue) || (configuredValue as number) < minimum || (configuredValue as number) > hardMaximum) {
      throw new RangeError(`${String(key)} configured acquisition bound is invalid`);
    }
    if (!Number.isSafeInteger(actual) || (actual as number) < minimum || (actual as number) > (configuredValue as number)) {
      throw new RangeError(`${String(key)} exceeds acquisition bounds`);
    }
  }

  const configuredDuration = configured.maxDurationSeconds;
  if (configuredDuration !== undefined && (!Number.isFinite(configuredDuration) || configuredDuration < 0 || configuredDuration > HARD_ACQUISITION_LIMITS.maxDurationSeconds)) {
    throw new RangeError("maxDurationSeconds configured acquisition bound is invalid");
  }
  const actualDuration = value.maxDurationSeconds;
  if (actualDuration !== undefined && (!Number.isFinite(actualDuration) || actualDuration < 0 || actualDuration > HARD_ACQUISITION_LIMITS.maxDurationSeconds || (configuredDuration !== undefined && actualDuration > configuredDuration))) {
    throw new RangeError("maxDurationSeconds exceeds acquisition bounds");
  }

  const optionalIntegerBounds: Array<readonly [keyof AcquisitionLimits, number, number]> = [
    ["maxAudioBytes", 1, HARD_ACQUISITION_LIMITS.maxAudioBytes],
    ["maxTranscriptCharacters", 1, HARD_ACQUISITION_LIMITS.maxTranscriptCharacters],
    ["maxTranscriptSegments", 1, HARD_ACQUISITION_LIMITS.maxTranscriptSegments],
    ["maxChunkCharacters", 1, HARD_ACQUISITION_LIMITS.maxChunkCharacters],
    ["maxChunksPerSource", 1, HARD_ACQUISITION_LIMITS.maxChunksPerSource],
    ["maxAnalysisOutputBytes", 1, HARD_ACQUISITION_LIMITS.maxAnalysisOutputBytes],
    ["maxProviderCostCents", 0, HARD_ACQUISITION_LIMITS.maxProviderCostCents],
  ];
  for (const [key, minimum, hardMaximum] of optionalIntegerBounds) {
    const configuredValue = configured[key];
    if (configuredValue !== undefined && (!Number.isSafeInteger(configuredValue) || (configuredValue as number) < minimum || (configuredValue as number) > hardMaximum)) {
      throw new RangeError(`${String(key)} configured acquisition bound is invalid`);
    }
    const actual = value[key];
    if (actual !== undefined && (!Number.isSafeInteger(actual) || (actual as number) < minimum || (actual as number) > hardMaximum || (configuredValue !== undefined && (actual as number) > configuredValue))) {
      throw new RangeError(`${String(key)} exceeds acquisition bounds`);
    }
  }
  return value;
}

export type ParsedLectureUrl =
  | { kind: "video"; videoId: string; canonicalUrl: string }
  | { kind: "playlist"; playlistId: string; canonicalUrl: string };

export interface ResolvedVideoSource {
  /** Stable id used by every evidence citation (for example `yt-video-<id>`). */
  sourceId: string;
  videoId: string;
  canonicalUrl: string;
  playlistId?: string;
  /** Stable playlist position, when the provider supplied one. */
  position?: number;
  title?: string;
  durationSeconds?: number;
}

export interface AcquisitionFailure {
  code: AcquisitionFailureCode;
  sourceId?: string;
  provider?: string;
  /** Sanitized diagnostic; never include keys, headers, or raw provider payloads. */
  message: string;
  retryable: boolean;
  attempts: number;
  severity: "warning" | "error";
}

export interface BoundedSourceSet {
  requested: ParsedLectureUrl;
  /** Stable source order; duplicate video ids are removed first-wins. */
  items: ResolvedVideoSource[];
  /** True when limits prevented claiming complete playlist coverage. */
  truncated: boolean;
  totalKnown?: number;
  failures: AcquisitionFailure[];
}

export interface EvidenceSegment {
  /** Deterministic id derived from source, timestamps, kind, and bounded quote. */
  evidenceId: string;
  sourceId: string;
  /** Canonical source URL, never an arbitrary fetched location. */
  location: string;
  provider: string;
  kind: EvidenceKind;
  /** Bounded provider excerpt or observation; raw provider output is not accepted. */
  quote: string;
  /** Inclusive start boundary in seconds; must be finite and >= 0. */
  startSeconds: number;
  /** Exclusive end boundary in seconds; must be finite and strictly > start. */
  endSeconds: number;
  language?: string;
  confidence?: EvidenceConfidence;
}

/** A timestamped, bounded transcript segment returned by a provider-neutral ASR port. */
export interface TimestampedTranscriptSegment {
  segmentId?: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  language?: string;
  confidence?: number;
  /** Whether the segment boundaries came from the provider or a bounded estimate. */
  timestampSource?: "provider" | "estimated";
}

/** Ephemeral process-local audio. Implementations must make dispose idempotent. */
export interface EphemeralAudio {
  readonly format: string;
  readonly sizeBytes: number;
  readonly durationSeconds?: number;
  open(signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  dispose(): Promise<void>;
}

export type MediaLease = EphemeralAudio;
export type PreparedAudioLease = EphemeralAudio;

export interface LectureAuthorization {
  mediaMode: "metadata-only" | "owned-audio";
  automatedPublicVideoAnalysisApproved: boolean;
  ownedMediaAudioAccessApproved: boolean;
  externalTranscriptAnalysisApproved?: boolean;
}

export interface PipelineLimits {
  maxAudioBytes: number;
  maxDurationSeconds?: number;
  maxTranscriptCharacters: number;
  maxTranscriptSegments?: number;
  maxChunkCharacters: number;
  maxChunksPerSource: number;
  maxAnalysisOutputBytes: number;
}

/** Fullstack implementations may obtain only caller-owned/rights-attested media. */
export interface LectureAudioAcquirer {
  acquire(source: ResolvedVideoSource, request: LectureAcquisitionRequest, signal: AbortSignal): Promise<EphemeralAudio>;
}

export interface AuthorizedMediaAcquisitionPort {
  acquire(
    source: ResolvedVideoSource,
    authorization: LectureAuthorization,
    limits: PipelineLimits,
    signal: AbortSignal,
  ): Promise<MediaLease>;
}

export interface BoundedAudioPreprocessorPort {
  prepare(media: MediaLease, limits: PipelineLimits, signal: AbortSignal): Promise<PreparedAudioLease>;
}

export interface TimestampedTranscript {
  sourceId: string;
  durationSeconds?: number;
  language?: string;
  provider: string;
  model?: string;
  timestampMode?: "provider" | "estimated";
  segments: TimestampedTranscriptSegment[];
}

export interface TranscriptChunk {
  chunkId: string;
  sourceId: string;
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
  segmentIds: string[];
}

export interface AnalysisCandidate {
  quote: string;
  startSeconds: number;
  endSeconds: number;
  kind: EvidenceKind;
  language?: string;
  confidence?: EvidenceConfidence;
}

export interface EvidenceDraft extends AnalysisCandidate {}

export interface AnalysisResult {
  provider: string;
  model?: string;
  candidates: AnalysisCandidate[];
}

export interface PipelineProviderMetadata {
  media?: { id: string; mode: "metadata-only" | "owned-audio" };
  asr?: { id: string; model?: string; timestampMode?: "provider" | "estimated" };
  analysis?: { id: string; model?: string; route?: string };
  fallbackUsed?: boolean;
}

export interface LectureAsrPort {
  readonly id: string;
  readonly model?: string;
  transcribe(
    audio: EphemeralAudio,
    source: ResolvedVideoSource,
    request: LectureAcquisitionRequest,
    signal: AbortSignal,
  ): Promise<{ provider: string; model?: string; segments: TimestampedTranscriptSegment[]; timestampMode?: "provider" | "estimated" }>;
}

export interface TimestampedAsrPort {
  readonly id: string;
  readonly model?: string;
  transcribe(
    audio: PreparedAudioLease,
    options: { language?: string; model?: string },
    limits: PipelineLimits,
    signal: AbortSignal,
  ): Promise<TimestampedTranscript>;
}

export interface LectureTextAnalysisPort {
  analyze(
    input: {
      source: ResolvedVideoSource;
      prompt: string;
      transcript: readonly TimestampedTranscriptSegment[];
    },
    request: LectureAcquisitionRequest,
    signal: AbortSignal,
  ): Promise<{ provider: string; model?: string; evidence: EvidenceDraft[] }>;
}

export interface TextAnalysisPort {
  analyze(input: { prompt: string; source: ResolvedVideoSource; chunk: TranscriptChunk }, signal: AbortSignal): Promise<AnalysisResult>;
}

export interface OmpTextInvoker {
  invoke(
    input: { model?: string; messages: readonly { role: "system" | "user" | "assistant"; content: string }[] },
    options: { maxResponseBytes: number; signal: AbortSignal },
  ): Promise<string>;
}

export interface OmpRuntimeCapabilityProbe {
  probe(runtime: unknown): Promise<
    { status: "available"; invoke: OmpTextInvoker }
    | { status: "unsupported" | "unknown"; reason?: string }
  >;
}

export interface LectureAcquisitionRequest {
  sourceUrl: string;
  prompt: string;
  limits: AcquisitionLimits;
  /** Explicit authorization; absent/false never implies ownership. */
  rights: {
    automatedPublicVideoAnalysisApproved: boolean;
    ownedCaptionAccessApproved: boolean;
    ownedMediaAudioAccessApproved?: boolean;
    /** Compatibility spelling used by early v2 intake documents. */
    ownedMediaAccessApproved?: boolean;
    externalTranscriptAnalysisApproved?: boolean;
  };
  /** Omitted means metadata-only and must never trigger media access. */
  mediaMode?: "metadata-only" | "owned-audio";
}

export interface LectureAcquisitionRightsProjection {
  mode: "metadata-only" | "owned-audio";
  approval: {
    automatedPublicVideoAnalysisApproved: boolean;
    ownedCaptionAccessApproved: boolean;
    ownedMediaAudioAccessApproved: boolean;
    ownedMediaAccessApproved: boolean;
    externalTranscriptAnalysisApproved: boolean;
  };
}

export interface LectureAcquisitionBinding {
  featureId: string;
  featureRunKey: string;
  stageId: string;
  cursorEpoch: string;
  intakeArtifactId: "lecture_intake";
  intakeSchemaVersion: 1;
  intakeContentSha256: string;
  requestSha256: string;
  rightsMode: "metadata-only" | "owned-audio";
  rightsSha256: string;
}

/** The exact request projection used for acquisition binding digests. */
export function lectureAcquisitionRequestProjection(
  request: Pick<LectureAcquisitionRequest, "sourceUrl" | "prompt" | "limits" | "mediaMode">,
): { sourceUrl: string; prompt: string; limits: AcquisitionLimits; mediaMode: "metadata-only" | "owned-audio" } {
  return {
    sourceUrl: request.sourceUrl.trim(),
    prompt: request.prompt.trim(),
    limits: normalizeAcquisitionLimits(request.limits),
    mediaMode: request.mediaMode === "owned-audio" ? "owned-audio" : "metadata-only",
  };
}

export function lectureAcquisitionRequestDigest(
  request: Pick<LectureAcquisitionRequest, "sourceUrl" | "prompt" | "limits" | "mediaMode">,
): string {
  return digestOf(lectureAcquisitionRequestProjection(request));
}

/** Normalize every authorization bit, including false defaults in metadata-only mode. */
export function lectureRightsProjection(
  rights: Partial<LectureAcquisitionRequest["rights"]> | undefined,
  mediaMode?: LectureAcquisitionRequest["mediaMode"],
): LectureAcquisitionRightsProjection {
  return {
    mode: mediaMode === "owned-audio" ? "owned-audio" : "metadata-only",
    approval: {
      automatedPublicVideoAnalysisApproved: rights?.automatedPublicVideoAnalysisApproved === true,
      ownedCaptionAccessApproved: rights?.ownedCaptionAccessApproved === true,
      ownedMediaAudioAccessApproved: rights?.ownedMediaAudioAccessApproved === true,
      ownedMediaAccessApproved: rights?.ownedMediaAccessApproved === true,
      externalTranscriptAnalysisApproved: rights?.externalTranscriptAnalysisApproved === true,
    },
  };
}

export function lectureRightsDigest(
  rights: Partial<LectureAcquisitionRequest["rights"]> | undefined,
  mediaMode?: LectureAcquisitionRequest["mediaMode"],
): string {
  return digestOf(lectureRightsProjection(rights, mediaMode));
}
export interface LectureAcquisitionValidationContext {
  featureId: string;
  featureRunKey: string;
  stageId: string;
  cursorEpoch: string;
  intakeSchemaVersion: 1;
  intakeContentSha256: string;
  request: Pick<LectureAcquisitionRequest, "sourceUrl" | "prompt" | "limits" | "mediaMode">;
  rights: Partial<LectureAcquisitionRequest["rights"]> | undefined;
}

export interface LectureAcquisitionArtifact {
  /**
   * Service drafts may remain unbound until the consumer tool attaches the
   * engine-issued binding. Persisted artifacts are always schema version 2.
   */
  schemaVersion: 1 | 2;
  status: AcquisitionStatus;
  binding?: LectureAcquisitionBinding;
  request: {
    sourceUrl: string;
    canonicalUrl?: string;
    sourceKind: "video" | "playlist";
    prompt: string;
    limits: AcquisitionLimits;
  };
  sourceSet: BoundedSourceSet;
  evidence: EvidenceSegment[];
  /** Includes warnings and unresolved sources for partial results. */
  failures: AcquisitionFailure[];
  provider: { id: string; model?: string };
  /** Optional stage descriptors are metadata-only and remain schema-compatible. */
  pipeline?: PipelineProviderMetadata;
  startedAt: string;
  completedAt: string;
}


export interface LectureSourceParser {
  parse(sourceUrl: string): ParsedLectureUrl | AcquisitionFailure;
}

export interface PlaylistExpander {
  expand(
    parsed: Extract<ParsedLectureUrl, { kind: "playlist" }>,
    limits: AcquisitionLimits,
    signal: AbortSignal,
  ): Promise<BoundedSourceSet>;
}

export interface LectureEvidenceProvider {
  readonly id: string;
  supports(source: ResolvedVideoSource): boolean;
  acquire(
    source: ResolvedVideoSource,
    request: LectureAcquisitionRequest,
    signal: AbortSignal,
  ): Promise<{ provider: string; raw: unknown }>;
}

/** Consumer-owned acquisition boundary used by the orchestrator stage/tool. */
export interface LectureAcquisitionPort {
  acquire(
    request: LectureAcquisitionRequest,
    signal: AbortSignal,
  ): Promise<LectureAcquisitionArtifact>;
}

export interface AcquisitionValidationIssue {
  field: string;
  message: string;
}

export function validateTimestampedTranscriptSegment(value: unknown, path = "$"): AcquisitionValidationIssue[] {
  if (!record(value)) return [{ field: path, message: "transcript segment must be an object" }];
  const issues: AcquisitionValidationIssue[] = [];
  if (typeof value.text !== "string" || value.text.trim().length === 0) {
    issues.push({ field: `${path}.text`, message: "transcript text must be non-empty" });
  } else if (value.text.length > 8_192) {
    issues.push({ field: `${path}.text`, message: "transcript text exceeds the bounded segment limit" });
  }
  if (!isValidEvidenceTimestamp(value.startSeconds, value.endSeconds)) {
    issues.push({ field: `${path}.startSeconds`, message: "transcript timestamps require finite start >= 0 and end > start" });
  }
  if (value.segmentId !== undefined && (typeof value.segmentId !== "string" || value.segmentId.length > 128)) {
    issues.push({ field: `${path}.segmentId`, message: "transcript segment id is invalid" });
  }
  if (value.language !== undefined && (typeof value.language !== "string" || value.language.length > 64)) {
    issues.push({ field: `${path}.language`, message: "transcript language is invalid" });
  }
  if (value.confidence !== undefined && (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)) {
    issues.push({ field: `${path}.confidence`, message: "transcript confidence must be between 0 and 1" });
  }
  if (value.timestampSource !== undefined && value.timestampSource !== "provider" && value.timestampSource !== "estimated") {
    issues.push({ field: `${path}.timestampSource`, message: "transcript timestampSource is invalid" });
  }
  return issues;
}

export function isTimestampedTranscriptSegment(value: unknown): value is TimestampedTranscriptSegment {
  return validateTimestampedTranscriptSegment(value).length === 0;
}

/**
 * Sort and bound ASR output without retaining a provider response. A malformed
 * segment is rejected instead of being silently turned into a fake transcript.
 */
export function normalizeTimestampedTranscriptSegments(
  segments: readonly TimestampedTranscriptSegment[],
  maxCharacters = DEFAULT_ACQUISITION_LIMITS.maxTranscriptCharacters,
): TimestampedTranscriptSegment[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > HARD_ACQUISITION_LIMITS.maxTranscriptCharacters) throw new RangeError("invalid transcript character bound");
  const out: TimestampedTranscriptSegment[] = [];
  let characters = 0;
  for (const [index, segment] of segments.entries()) {
    if (!isTimestampedTranscriptSegment(segment)) throw new TypeError(`invalid transcript segment at index ${index}`);
    characters += segment.text.length;
    if (characters > maxCharacters) throw new RangeError("transcript exceeds the configured character bound");
    out.push({ ...segment, segmentId: segment.segmentId ?? `segment-${index}` });
  }
  out.sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
  for (let index = 1; index < out.length; index += 1) {
    if (out[index]!.startSeconds < out[index - 1]!.startSeconds) throw new TypeError("transcript segments are not monotonic");
  }
  return out;
}

export function chunkTimestampedTranscript(
  sourceId: string,
  segments: readonly TimestampedTranscriptSegment[],
  limits: Pick<AcquisitionLimits, "maxTranscriptCharacters" | "maxChunkCharacters" | "maxChunksPerSource">,
): TranscriptChunk[] {
  const maxTranscriptCharacters = limits.maxTranscriptCharacters ?? DEFAULT_ACQUISITION_LIMITS.maxTranscriptCharacters;
  const maxCharacters = limits.maxChunkCharacters ?? DEFAULT_ACQUISITION_LIMITS.maxChunkCharacters;
  const maxChunks = limits.maxChunksPerSource ?? DEFAULT_ACQUISITION_LIMITS.maxChunksPerSource;
  if (!Number.isInteger(maxTranscriptCharacters) || maxTranscriptCharacters < 1 || maxTranscriptCharacters > HARD_ACQUISITION_LIMITS.maxTranscriptCharacters || !Number.isInteger(maxCharacters) || maxCharacters < 1 || !Number.isInteger(maxChunks) || maxChunks < 1) throw new RangeError("invalid transcript chunk bounds");
  const chunks: TranscriptChunk[] = [];
  let current: TimestampedTranscriptSegment[] = [];
  let characters = 0;
  const flush = () => {
    if (!current.length) return;
    const chunk = {
      chunkId: `${sourceId}:chunk-${chunks.length}`,
      sourceId,
      ordinal: chunks.length,
      startSeconds: current[0]!.startSeconds,
      endSeconds: current[current.length - 1]!.endSeconds,
      text: current.map((segment) => segment.text).join(" ").trim(),
      segmentIds: current.map((segment, index) => segment.segmentId ?? `segment-${index}`),
    };
    chunks.push(chunk);
    current = [];
    characters = 0;
  };
  for (const segment of normalizeTimestampedTranscriptSegments(segments, maxTranscriptCharacters)) {
    if (segment.text.length > maxCharacters) throw new RangeError("transcript segment exceeds chunk bound");
    if (current.length && characters + segment.text.length + 1 > maxCharacters) flush();
    current.push(segment);
    characters += segment.text.length + (current.length > 1 ? 1 : 0);
  }
  flush();
  if (chunks.length > maxChunks) throw new RangeError("transcript exceeds chunk count bound");
  return chunks;
}

export type EvidenceIdFactory = (input: Pick<EvidenceSegment, "sourceId" | "kind" | "quote" | "startSeconds" | "endSeconds">) => string;

/**
 * Ground untrusted candidates against the trusted transcript and source.
 * Candidate source/location claims are not accepted because they are absent
 * from the input type; location and source id are injected by this function.
 */
export function normalizeAnalysisCandidates(
  source: ResolvedVideoSource,
  transcript: readonly TimestampedTranscriptSegment[],
  result: AnalysisResult,
  cap: number,
  ids: EvidenceIdFactory,
): EvidenceSegment[] {
  if (!Number.isInteger(cap) || cap < 1) throw new RangeError("invalid evidence cap");
  const boundedTranscript = normalizeTimestampedTranscriptSegments(transcript);
  const out: EvidenceSegment[] = [];
  const seen = new Set<string>();
  for (const candidate of result.candidates) {
    if (!candidate || typeof candidate.quote !== "string" || candidate.quote.trim().length === 0 || candidate.quote.length > 4_096) continue;
    if (!isValidEvidenceTimestamp(candidate.startSeconds, candidate.endSeconds) || !EVIDENCE_KINDS.includes(candidate.kind)) continue;
    const grounded = boundedTranscript.some((segment) =>
      segment.startSeconds < candidate.endSeconds
      && segment.endSeconds > candidate.startSeconds
      && segment.text.includes(candidate.quote.trim()),
    );
    if (!grounded) continue;
    const evidence: EvidenceSegment = {
      evidenceId: ids({ sourceId: source.sourceId, kind: candidate.kind, quote: candidate.quote.trim(), startSeconds: candidate.startSeconds, endSeconds: candidate.endSeconds }),
      sourceId: source.sourceId,
      location: source.canonicalUrl,
      provider: result.provider,
      kind: candidate.kind,
      quote: candidate.quote.trim(),
      startSeconds: candidate.startSeconds,
      endSeconds: candidate.endSeconds,
      ...(candidate.language ? { language: candidate.language } : {}),
      ...(candidate.confidence ? { confidence: candidate.confidence } : {}),
    };
    if (seen.has(evidence.evidenceId)) continue;
    seen.add(evidence.evidenceId);
    out.push(evidence);
    if (out.length >= cap) break;
  }
  return out;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Timestamp invariant shared by providers, adapters, and artifact validation. */
export function isValidEvidenceTimestamp(startSeconds: unknown, endSeconds: unknown): boolean {
  return typeof startSeconds === "number"
    && Number.isFinite(startSeconds)
    && startSeconds >= 0
    && typeof endSeconds === "number"
    && Number.isFinite(endSeconds)
    && endSeconds > startSeconds;
}

/** Runtime type guard for normalized evidence handed to mapping. */
export function isEvidenceSegment(value: unknown): value is EvidenceSegment {
  return validateEvidenceSegment(value).length === 0;
}

const MAX_LECTURE_TEXT_BYTES = 16 * 1024;
const MAX_LECTURE_URL_BYTES = 2 * 1024;
const MAX_LECTURE_ID_BYTES = 256;
const MAX_LECTURE_PROVIDER_BYTES = 128;
const MAX_LECTURE_FAILURE_MESSAGE_BYTES = 4 * 1024;
export const MAX_LECTURE_ARTIFACT_AGGREGATE_BYTES = 8 * 1024 * 1024;

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: AcquisitionValidationIssue[]): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) issues.push({ field: `${path}.${key}`, message: "unknown field is not allowed" });
  }
}

function boundedText(value: unknown, path: string, maxBytes: number, issues: AcquisitionValidationIssue[], required = false): value is string {
  if (typeof value !== "string" || (required && value.trim().length === 0)) {
    issues.push({ field: path, message: required ? "must be a non-empty string" : "must be a string" });
    return false;
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) issues.push({ field: path, message: `exceeds the bounded ${maxBytes}-byte limit` });
  if (value.includes("\u0000")) issues.push({ field: path, message: "must not contain NUL" });
  return true;
}

function boundedCount(value: unknown, path: string, maximum: number, issues: AcquisitionValidationIssue[]): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    issues.push({ field: path, message: `must be an integer between 0 and ${maximum}` });
    return false;
  }
  return true;
}

export function validateEvidenceSegment(value: unknown, path = "$"): AcquisitionValidationIssue[] {
  if (!record(value)) return [{ field: path, message: "evidence segment must be an object" }];
  const issues: AcquisitionValidationIssue[] = [];
  unknownKeys(value, ["evidenceId", "sourceId", "location", "provider", "kind", "quote", "startSeconds", "endSeconds", "language", "confidence"], path, issues);
  for (const field of ["evidenceId", "sourceId", "location", "provider", "kind", "quote"] as const) {
    boundedText(value[field], `${path}.${field}`, field === "provider" ? MAX_LECTURE_PROVIDER_BYTES : field === "quote" ? 4_096 : field === "location" ? MAX_LECTURE_URL_BYTES : MAX_LECTURE_ID_BYTES, issues, true);
  }
  if (!isSha256Hex(value.evidenceId)) issues.push({ field: `${path}.evidenceId`, message: "evidenceId must be a lowercase SHA-256 digest" });
  if (!EVIDENCE_KINDS.includes(value.kind as EvidenceKind)) {
    issues.push({ field: `${path}.kind`, message: `evidence kind '${String(value.kind)}' is unsupported` });
  }
  if (!isValidEvidenceTimestamp(value.startSeconds, value.endSeconds)) {
    issues.push({ field: `${path}.startSeconds`, message: "evidence timestamps require finite start >= 0 and end > start" });
  }
  if (value.language !== undefined) boundedText(value.language, `${path}.language`, 64, issues, true);
  if (value.confidence !== undefined && !EVIDENCE_CONFIDENCES.includes(value.confidence as EvidenceConfidence)) {
    issues.push({ field: `${path}.confidence`, message: `evidence confidence '${String(value.confidence)}' is unsupported` });
  }
  return issues;
}
export interface LectureAcquisitionValidationOptions {
  /**
   * The mounted acquisition boundary sets this for persisted artifacts. The
   * service itself may validate an unbound draft before the boundary adds the
   * engine-issued identity.
   */
  requireBinding?: boolean;
  context?: LectureAcquisitionValidationContext;
}

function validateAcquisitionLimits(value: unknown, path: string, issues: AcquisitionValidationIssue[]): AcquisitionLimits | null {
  if (!record(value)) {
    issues.push({ field: path, message: "limits must be an object" });
    return null;
  }
  const allowed = [
    "maxItems", "maxPages", "maxDurationSeconds", "deadlineMs", "maxAttempts",
    "maxResponseBytes", "maxEvidenceSegmentsPerSource", "maxAudioBytes",
    "maxTranscriptCharacters", "maxTranscriptSegments", "maxChunkCharacters",
    "maxChunksPerSource", "maxAnalysisOutputBytes", "maxProviderCostCents",
  ] as const;
  unknownKeys(value, allowed, path, issues);
  const required: Record<string, readonly [number, number]> = {
    maxItems: [1, HARD_ACQUISITION_LIMITS.maxItems],
    maxPages: [1, HARD_ACQUISITION_LIMITS.maxPages],
    deadlineMs: [1, HARD_ACQUISITION_LIMITS.deadlineMs],
    maxAttempts: [1, HARD_ACQUISITION_LIMITS.maxAttempts],
    maxResponseBytes: [1, HARD_ACQUISITION_LIMITS.maxResponseBytes],
    maxEvidenceSegmentsPerSource: [1, HARD_ACQUISITION_LIMITS.maxEvidenceSegmentsPerSource],
  };
  let valid = true;
  for (const [key, [minimum, maximum]] of Object.entries(required)) {
    const actual = value[key];
    if (!Number.isSafeInteger(actual) || (actual as number) < minimum || (actual as number) > maximum) {
      issues.push({ field: `${path}.${key}`, message: `must be an integer between ${minimum} and ${maximum}` });
      valid = false;
    }
  }
  const optional: Record<string, readonly [number, number]> = {
    maxDurationSeconds: [1, HARD_ACQUISITION_LIMITS.maxDurationSeconds],
    maxAudioBytes: [1, HARD_ACQUISITION_LIMITS.maxAudioBytes],
    maxTranscriptCharacters: [1, HARD_ACQUISITION_LIMITS.maxTranscriptCharacters],
    maxTranscriptSegments: [1, HARD_ACQUISITION_LIMITS.maxTranscriptSegments],
    maxChunkCharacters: [1, HARD_ACQUISITION_LIMITS.maxChunkCharacters],
    maxChunksPerSource: [1, HARD_ACQUISITION_LIMITS.maxChunksPerSource],
    maxAnalysisOutputBytes: [1, HARD_ACQUISITION_LIMITS.maxAnalysisOutputBytes],
    maxProviderCostCents: [0, HARD_ACQUISITION_LIMITS.maxProviderCostCents],
  };
  for (const [key, [minimum, maximum]] of Object.entries(optional)) {
    const actual = value[key];
    if (actual === undefined) continue;
    const number = key === "maxDurationSeconds" ? typeof actual === "number" && Number.isFinite(actual) : Number.isSafeInteger(actual);
    if (!number || (actual as number) < minimum || (actual as number) > maximum) {
      issues.push({ field: `${path}.${key}`, message: `must be a bounded number between ${minimum} and ${maximum}` });
      valid = false;
    }
  }
  return valid ? value as unknown as AcquisitionLimits : null;
}

function validateAcquisitionFailure(value: unknown, path: string, maxAttempts: number, issues: AcquisitionValidationIssue[]): void {
  if (!record(value)) {
    issues.push({ field: path, message: "failure must be an object" });
    return;
  }
  unknownKeys(value, ["code", "sourceId", "provider", "message", "retryable", "attempts", "severity"], path, issues);
  if (!ACQUISITION_FAILURE_CODES.includes(value.code as AcquisitionFailureCode)) issues.push({ field: `${path}.code`, message: "failure code is unsupported" });
  if (value.sourceId !== undefined) boundedText(value.sourceId, `${path}.sourceId`, MAX_LECTURE_ID_BYTES, issues, true);
  if (value.provider !== undefined) boundedText(value.provider, `${path}.provider`, MAX_LECTURE_PROVIDER_BYTES, issues, true);
  boundedText(value.message, `${path}.message`, MAX_LECTURE_FAILURE_MESSAGE_BYTES, issues, true);
  if (typeof value.retryable !== "boolean") issues.push({ field: `${path}.retryable`, message: "failure retryable must be boolean" });
  if (!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0 || (value.attempts as number) > maxAttempts) {
    issues.push({ field: `${path}.attempts`, message: `failure attempts must be an integer between 0 and ${maxAttempts}` });
  }
  if (value.severity !== "warning" && value.severity !== "error") issues.push({ field: `${path}.severity`, message: "failure severity is unsupported" });
}

function validatePipelineMetadata(value: unknown, issues: AcquisitionValidationIssue[]): void {
  if (!record(value)) {
    issues.push({ field: "$.pipeline", message: "pipeline metadata must be an object" });
    return;
  }
  unknownKeys(value, ["media", "asr", "analysis", "fallbackUsed"], "$.pipeline", issues);
  for (const key of ["media", "asr", "analysis"] as const) {
    const descriptor = value[key];
    if (descriptor === undefined) continue;
    if (!record(descriptor)) {
      issues.push({ field: `$.pipeline.${key}`, message: "pipeline provider metadata must be an object" });
      continue;
    }
    const allowed = key === "media" ? ["id", "mode"] : key === "asr" ? ["id", "model", "timestampMode"] : ["id", "model", "route"];
    unknownKeys(descriptor, allowed, `$.pipeline.${key}`, issues);
    boundedText(descriptor.id, `$.pipeline.${key}.id`, MAX_LECTURE_PROVIDER_BYTES, issues, true);
    if (descriptor.model !== undefined) boundedText(descriptor.model, `$.pipeline.${key}.model`, 256, issues, true);
    if (key === "media" && descriptor.mode !== "metadata-only" && descriptor.mode !== "owned-audio") {
      issues.push({ field: "$.pipeline.media.mode", message: "pipeline media mode is unsupported" });
    }
    if (key === "asr" && descriptor.timestampMode !== undefined && descriptor.timestampMode !== "provider" && descriptor.timestampMode !== "estimated") {
      issues.push({ field: "$.pipeline.asr.timestampMode", message: "pipeline ASR timestamp mode is unsupported" });
    }
    if (key === "analysis" && descriptor.route !== undefined) boundedText(descriptor.route, "$.pipeline.analysis.route", 64, issues, true);
  }
  if (value.fallbackUsed !== undefined && typeof value.fallbackUsed !== "boolean") {
    issues.push({ field: "$.pipeline.fallbackUsed", message: "pipeline fallbackUsed must be boolean" });
  }
}

function compareBinding(
  binding: Record<string, unknown>,
  context: LectureAcquisitionValidationContext,
  issues: AcquisitionValidationIssue[],
): void {
  let expectedRequest: string;
  let expectedRights: LectureAcquisitionRightsProjection;
  try {
    expectedRequest = lectureAcquisitionRequestDigest(context.request);
    expectedRights = lectureRightsProjection(context.rights, context.request.mediaMode);
  } catch {
    issues.push({ field: "$.binding", message: "binding context request or rights is invalid" });
    return;
  }
  const expected: Record<string, unknown> = {
    featureId: context.featureId,
    featureRunKey: context.featureRunKey,
    stageId: context.stageId,
    cursorEpoch: context.cursorEpoch,
    intakeArtifactId: "lecture_intake",
    intakeSchemaVersion: context.intakeSchemaVersion,
    intakeContentSha256: context.intakeContentSha256,
    requestSha256: expectedRequest,
    rightsMode: expectedRights.mode,
    rightsSha256: digestOf(expectedRights),
  };
  for (const key of Object.keys(expected)) {
    if (binding[key] !== expected[key]) issues.push({ field: `$.binding.${key}`, message: "binding does not match the current intake/request authority" });
  }
}

/**
 * Validate one acquisition artifact. Persisted artifacts must set
 * `requireBinding`; the optional context recomputes every binding digest from
 * the current intake/request rather than trusting producer-supplied hashes.
 */
export function validateLectureAcquisitionArtifact(
  value: unknown,
  options: LectureAcquisitionValidationOptions = {},
): AcquisitionValidationIssue[] {
  if (!record(value)) return [{ field: "$", message: "lecture_acquisition must be an object" }];
  const issues: AcquisitionValidationIssue[] = [];
  const allowedTopLevel = ["schemaVersion", "binding", "status", "request", "sourceSet", "evidence", "failures", "provider", "pipeline", "startedAt", "completedAt"] as const;
  unknownKeys(value, allowedTopLevel, "$", issues);
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) issues.push({ field: "$.schemaVersion", message: "schemaVersion must be 1 or 2" });
  if (options.requireBinding && value.schemaVersion !== 2) issues.push({ field: "$.schemaVersion", message: "persisted lecture acquisition artifacts require schemaVersion 2" });
  const binding = value.binding;
  if (value.schemaVersion === 2 || options.requireBinding) {
    if (!record(binding)) {
      issues.push({ field: "$.binding", message: "schemaVersion 2 requires a binding object" });
    } else {
      unknownKeys(binding, ["featureId", "featureRunKey", "stageId", "cursorEpoch", "intakeArtifactId", "intakeSchemaVersion", "intakeContentSha256", "requestSha256", "rightsMode", "rightsSha256"], "$.binding", issues);
      for (const key of ["featureId", "featureRunKey", "stageId", "cursorEpoch"] as const) boundedText(binding[key], `$.binding.${key}`, MAX_LECTURE_ID_BYTES, issues, true);
      if (binding.intakeArtifactId !== "lecture_intake") issues.push({ field: "$.binding.intakeArtifactId", message: "binding intakeArtifactId must be lecture_intake" });
      if (binding.intakeSchemaVersion !== 1) issues.push({ field: "$.binding.intakeSchemaVersion", message: "binding intakeSchemaVersion must be 1" });
      for (const key of ["intakeContentSha256", "requestSha256", "rightsSha256"] as const) {
        if (!isSha256Hex(binding[key])) issues.push({ field: `$.binding.${key}`, message: "binding hash must be a lowercase SHA-256 digest" });
      }
      if (binding.rightsMode !== "metadata-only" && binding.rightsMode !== "owned-audio") issues.push({ field: "$.binding.rightsMode", message: "binding rightsMode is unsupported" });
      if (options.context) compareBinding(binding, options.context, issues);
    }
  }
  if (!ACQUISITION_STATUSES.includes(value.status as AcquisitionStatus)) issues.push({ field: "$.status", message: "acquisition status is unsupported" });

  const request = value.request;
  let limits: AcquisitionLimits | null = null;
  if (!record(request)) {
    issues.push({ field: "$.request", message: "request must be an object" });
  } else {
    unknownKeys(request, ["sourceUrl", "canonicalUrl", "sourceKind", "prompt", "limits"], "$.request", issues);
    boundedText(request.sourceUrl, "$.request.sourceUrl", MAX_LECTURE_URL_BYTES, issues, true);
    if (request.canonicalUrl !== undefined) boundedText(request.canonicalUrl, "$.request.canonicalUrl", MAX_LECTURE_URL_BYTES, issues, true);
    if (request.sourceKind !== "video" && request.sourceKind !== "playlist") issues.push({ field: "$.request.sourceKind", message: "request sourceKind is unsupported" });
    boundedText(request.prompt, "$.request.prompt", MAX_LECTURE_TEXT_BYTES, issues, true);
    limits = validateAcquisitionLimits(request.limits, "$.request.limits", issues);
    if (options.context && limits) {
      try {
        const expected = lectureAcquisitionRequestProjection(options.context.request);
        if (request.sourceUrl !== expected.sourceUrl || request.prompt !== expected.prompt || digestOf(limits) !== digestOf(expected.limits)) {
          issues.push({ field: "$.request", message: "request does not match the current intake/request authority" });
        }
      } catch {
        issues.push({ field: "$.request", message: "request cannot be compared with the current intake/request authority" });
      }
    }
  }

  const sourceSet = value.sourceSet;
  const sources: Record<string, unknown>[] = [];
  const sourceIds = new Set<string>();
  const sourceUrls = new Map<string, string>();
  if (!record(sourceSet)) {
    issues.push({ field: "$.sourceSet", message: "sourceSet must be an object" });
  } else {
    unknownKeys(sourceSet, ["requested", "items", "truncated", "totalKnown", "failures"], "$.sourceSet", issues);
    const requested = sourceSet.requested;
    if (!record(requested)) {
      issues.push({ field: "$.sourceSet.requested", message: "sourceSet.requested must be an object" });
    } else {
      unknownKeys(requested, ["kind", "videoId", "playlistId", "canonicalUrl"], "$.sourceSet.requested", issues);
      if (requested.kind !== "video" && requested.kind !== "playlist") issues.push({ field: "$.sourceSet.requested.kind", message: "requested source kind is unsupported" });
      boundedText(requested.canonicalUrl, "$.sourceSet.requested.canonicalUrl", MAX_LECTURE_URL_BYTES, issues, true);
      if (requested.videoId !== undefined) boundedText(requested.videoId, "$.sourceSet.requested.videoId", MAX_LECTURE_ID_BYTES, issues, true);
      if (requested.playlistId !== undefined) boundedText(requested.playlistId, "$.sourceSet.requested.playlistId", MAX_LECTURE_ID_BYTES, issues, true);
      if (record(request) && typeof request.canonicalUrl === "string" && requested.canonicalUrl !== request.canonicalUrl) {
        issues.push({ field: "$.sourceSet.requested.canonicalUrl", message: "requested canonical URL does not match request.canonicalUrl" });
      }
      if (record(request) && (requested.kind !== request.sourceKind)) issues.push({ field: "$.sourceSet.requested.kind", message: "requested source kind does not match request.sourceKind" });
    }
    const items = sourceSet.items;
    if (!Array.isArray(items)) {
      issues.push({ field: "$.sourceSet.items", message: "sourceSet.items must be an array" });
    } else {
      const maxItems = limits?.maxItems ?? HARD_ACQUISITION_LIMITS.maxItems;
      if (items.length > maxItems) issues.push({ field: "$.sourceSet.items", message: `sourceSet.items exceeds maxItems (${maxItems})` });
      items.forEach((item, index) => {
        const path = `$.sourceSet.items[${index}]`;
        if (!record(item)) {
          issues.push({ field: path, message: "source item must be an object" });
          return;
        }
        unknownKeys(item, ["sourceId", "videoId", "canonicalUrl", "playlistId", "position", "title", "durationSeconds"], path, issues);
        boundedText(item.sourceId, `${path}.sourceId`, MAX_LECTURE_ID_BYTES, issues, true);
        boundedText(item.videoId, `${path}.videoId`, MAX_LECTURE_ID_BYTES, issues, true);
        boundedText(item.canonicalUrl, `${path}.canonicalUrl`, MAX_LECTURE_URL_BYTES, issues, true);
        if (typeof item.sourceId === "string") {
          if (sourceIds.has(item.sourceId)) issues.push({ field: `${path}.sourceId`, message: "source ids must be unique" });
          sourceIds.add(item.sourceId);
          sourceUrls.set(item.sourceId, typeof item.canonicalUrl === "string" ? item.canonicalUrl : "");
        }
        if (item.playlistId !== undefined) boundedText(item.playlistId, `${path}.playlistId`, MAX_LECTURE_ID_BYTES, issues, true);
        if (item.position !== undefined && (!Number.isSafeInteger(item.position) || (item.position as number) < 0)) issues.push({ field: `${path}.position`, message: "source position must be a non-negative integer" });
        if (item.title !== undefined) boundedText(item.title, `${path}.title`, MAX_LECTURE_TEXT_BYTES, issues);
        if (item.durationSeconds !== undefined && (typeof item.durationSeconds !== "number" || !Number.isFinite(item.durationSeconds) || item.durationSeconds < 0 || item.durationSeconds > HARD_ACQUISITION_LIMITS.maxDurationSeconds)) {
          issues.push({ field: `${path}.durationSeconds`, message: "source duration is outside the bounded range" });
        }
        sources.push(item);
      });
    }
    if (typeof sourceSet.truncated !== "boolean") issues.push({ field: "$.sourceSet.truncated", message: "sourceSet.truncated must be boolean" });
    if (sourceSet.totalKnown !== undefined && (!Number.isSafeInteger(sourceSet.totalKnown) || (sourceSet.totalKnown as number) < 0 || (sourceSet.totalKnown as number) > HARD_ACQUISITION_LIMITS.maxPages * HARD_ACQUISITION_LIMITS.maxItems)) {
      issues.push({ field: "$.sourceSet.totalKnown", message: "sourceSet.totalKnown exceeds the bounded range" });
    }
    const sourceFailures = sourceSet.failures;
    if (!Array.isArray(sourceFailures)) {
      issues.push({ field: "$.sourceSet.failures", message: "sourceSet.failures must be an array" });
    } else {
      const maxFailures = limits?.maxPages ?? HARD_ACQUISITION_LIMITS.maxPages;
      if (sourceFailures.length > maxFailures) issues.push({ field: "$.sourceSet.failures", message: `sourceSet.failures exceeds maxPages (${maxFailures})` });
      sourceFailures.forEach((failure, index) => validateAcquisitionFailure(failure, `$.sourceSet.failures[${index}]`, limits?.maxAttempts ?? HARD_ACQUISITION_LIMITS.maxAttempts, issues));
    }
  }

  const evidence = value.evidence;
  if (!Array.isArray(evidence)) {
    issues.push({ field: "$.evidence", message: "evidence must be an array" });
  } else {
    const maxEvidence = (limits?.maxItems ?? HARD_ACQUISITION_LIMITS.maxItems) * (limits?.maxEvidenceSegmentsPerSource ?? HARD_ACQUISITION_LIMITS.maxEvidenceSegmentsPerSource);
    if (evidence.length > maxEvidence) issues.push({ field: "$.evidence", message: `evidence exceeds the aggregate source bound (${maxEvidence})` });
    const perSource = new Map<string, number>();
    evidence.forEach((segment, index) => {
      issues.push(...validateEvidenceSegment(segment, `$.evidence[${index}]`));
      if (!record(segment)) return;
      const sourceId = segment.sourceId;
      if (typeof sourceId === "string") {
        const count = (perSource.get(sourceId) ?? 0) + 1;
        perSource.set(sourceId, count);
        if (count > (limits?.maxEvidenceSegmentsPerSource ?? HARD_ACQUISITION_LIMITS.maxEvidenceSegmentsPerSource)) issues.push({ field: `$.evidence[${index}].sourceId`, message: "evidence exceeds maxEvidenceSegmentsPerSource for its source" });
        if (!sourceIds.has(sourceId)) issues.push({ field: `$.evidence[${index}].sourceId`, message: "evidence sourceId is not present in sourceSet.items" });
        else if (segment.location !== sourceUrls.get(sourceId)) issues.push({ field: `$.evidence[${index}].location`, message: "evidence location does not match its source canonical URL" });
      }
    });
    if ((value.status === "partial" || value.status === "succeeded") && evidence.length === 0) {
      issues.push({ field: "$.evidence", message: `${value.status} acquisition requires at least one valid evidence segment` });
    }
    if (value.status === "failed" && evidence.length > 0) issues.push({ field: "$.evidence", message: "failed acquisition cannot retain evidence" });
  }

  const failures = value.failures;
  if (!Array.isArray(failures)) {
    issues.push({ field: "$.failures", message: "failures must be an array" });
  } else {
    const maxFailures = (limits?.maxItems ?? HARD_ACQUISITION_LIMITS.maxItems) * (limits?.maxAttempts ?? HARD_ACQUISITION_LIMITS.maxAttempts) + (limits?.maxPages ?? HARD_ACQUISITION_LIMITS.maxPages) + 2;
    if (failures.length > maxFailures) issues.push({ field: "$.failures", message: `failures exceeds the aggregate source bound (${maxFailures})` });
    failures.forEach((failure, index) => {
      validateAcquisitionFailure(failure, `$.failures[${index}]`, limits?.maxAttempts ?? HARD_ACQUISITION_LIMITS.maxAttempts, issues);
      if (record(failure) && typeof failure.sourceId === "string" && !sourceIds.has(failure.sourceId)) issues.push({ field: `$.failures[${index}].sourceId`, message: "failure sourceId is not present in sourceSet.items" });
    });
    if (value.status === "succeeded" && failures.length > 0) issues.push({ field: "$.failures", message: "succeeded acquisition cannot contain failures" });
    if (value.status === "partial" && failures.length === 0) issues.push({ field: "$.failures", message: "partial acquisition must preserve at least one failure" });
  }

  const provider = value.provider;
  if (!record(provider)) {
    issues.push({ field: "$.provider", message: "provider must be an object" });
  } else {
    unknownKeys(provider, ["id", "model"], "$.provider", issues);
    boundedText(provider.id, "$.provider.id", MAX_LECTURE_PROVIDER_BYTES, issues, true);
    if (provider.model !== undefined) boundedText(provider.model, "$.provider.model", 256, issues, true);
  }
  if (value.pipeline !== undefined) validatePipelineMetadata(value.pipeline, issues);
  boundedText(value.startedAt, "$.startedAt", 128, issues, true);
  boundedText(value.completedAt, "$.completedAt", 128, issues, true);
  if (typeof value.startedAt === "string" && !Number.isFinite(Date.parse(value.startedAt))) issues.push({ field: "$.startedAt", message: "startedAt must be a parseable ISO-8601 timestamp" });
  if (typeof value.completedAt === "string" && !Number.isFinite(Date.parse(value.completedAt))) issues.push({ field: "$.completedAt", message: "completedAt must be a parseable ISO-8601 timestamp" });
  if (typeof value.startedAt === "string" && typeof value.completedAt === "string" && Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.completedAt)) && Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
    issues.push({ field: "$.completedAt", message: "completedAt must not precede startedAt" });
  }
  try {
    if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_LECTURE_ARTIFACT_AGGREGATE_BYTES) issues.push({ field: "$", message: `lecture acquisition aggregate exceeds ${MAX_LECTURE_ARTIFACT_AGGREGATE_BYTES} bytes` });
  } catch {
    issues.push({ field: "$", message: "lecture acquisition aggregate cannot be canonically serialized" });
  }
  return issues;
}
