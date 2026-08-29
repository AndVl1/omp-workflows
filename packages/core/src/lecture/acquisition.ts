/**
 * Provider-neutral contracts for URL-first lecture research.
 *
 * Core declares the acquisition boundary and validates the normalized handoff;
 * consumers provide URL parsing, playlist expansion, provider access, and the
 * `lecture_acquire` tool. This module intentionally has no provider, HTTP, or
 * credential dependency.
 */

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
  if (value.maxItems < 1 || value.maxItems > configured.maxItems || value.maxItems > HARD_ACQUISITION_LIMITS.maxItems) {
    throw new RangeError("maxItems exceeds acquisition bounds");
  }
  if (value.maxPages < 1 || value.maxPages > configured.maxPages || value.maxPages > HARD_ACQUISITION_LIMITS.maxPages) {
    throw new RangeError("maxPages exceeds acquisition bounds");
  }
  if (value.maxDurationSeconds !== undefined && (value.maxDurationSeconds < 1 || value.maxDurationSeconds > HARD_ACQUISITION_LIMITS.maxDurationSeconds || (configured.maxDurationSeconds !== undefined && value.maxDurationSeconds > configured.maxDurationSeconds))) {
    throw new RangeError("maxDurationSeconds exceeds acquisition bounds");
  }
  if (value.deadlineMs < 1 || value.deadlineMs > configured.deadlineMs || value.deadlineMs > HARD_ACQUISITION_LIMITS.deadlineMs) {
    throw new RangeError("deadlineMs exceeds acquisition bounds");
  }
  if (value.maxAttempts < 1 || value.maxAttempts > configured.maxAttempts || value.maxAttempts > HARD_ACQUISITION_LIMITS.maxAttempts) {
    throw new RangeError("maxAttempts exceeds acquisition bounds");
  }
  if (value.maxResponseBytes < 1 || value.maxResponseBytes > configured.maxResponseBytes || value.maxResponseBytes > HARD_ACQUISITION_LIMITS.maxResponseBytes) {
    throw new RangeError("maxResponseBytes exceeds acquisition bounds");
  }
  if (value.maxEvidenceSegmentsPerSource < 1 || value.maxEvidenceSegmentsPerSource > configured.maxEvidenceSegmentsPerSource || value.maxEvidenceSegmentsPerSource > HARD_ACQUISITION_LIMITS.maxEvidenceSegmentsPerSource) {
    throw new RangeError("maxEvidenceSegmentsPerSource exceeds acquisition bounds");
  }
  const optionalBounds: Array<readonly [keyof AcquisitionLimits, number, number]> = [
    ["maxAudioBytes", 1, HARD_ACQUISITION_LIMITS.maxAudioBytes],
    ["maxTranscriptCharacters", 1, HARD_ACQUISITION_LIMITS.maxTranscriptCharacters],
    ["maxTranscriptSegments", 1, HARD_ACQUISITION_LIMITS.maxTranscriptSegments],
    ["maxChunkCharacters", 1, HARD_ACQUISITION_LIMITS.maxChunkCharacters],
    ["maxChunksPerSource", 1, HARD_ACQUISITION_LIMITS.maxChunksPerSource],
    ["maxAnalysisOutputBytes", 1, HARD_ACQUISITION_LIMITS.maxAnalysisOutputBytes],
    ["maxProviderCostCents", 0, HARD_ACQUISITION_LIMITS.maxProviderCostCents],
  ];
  for (const [key, minimum, hardMaximum] of optionalBounds) {
    const actual = value[key];
    const configuredMaximum = configured[key];
    if (actual !== undefined && (!Number.isInteger(actual) || actual < minimum || actual > hardMaximum || (typeof configuredMaximum === "number" && actual > configuredMaximum))) {
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

export interface LectureAcquisitionArtifact {
  schemaVersion: 1;
  status: AcquisitionStatus;
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

export function validateEvidenceSegment(value: unknown, path = "$",): AcquisitionValidationIssue[] {
  if (!record(value)) return [{ field: path, message: "evidence segment must be an object" }];
  const issues: AcquisitionValidationIssue[] = [];
  for (const field of ["evidenceId", "sourceId", "location", "provider", "kind", "quote"] as const) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      issues.push({ field: `${path}.${field}`, message: `evidence ${field} must be a non-empty string` });
    }
  }
  if (!EVIDENCE_KINDS.includes(value.kind as EvidenceKind)) {
    issues.push({ field: `${path}.kind`, message: `evidence kind '${String(value.kind)}' is unsupported` });
  }
  if (!isValidEvidenceTimestamp(value.startSeconds, value.endSeconds)) {
    issues.push({ field: `${path}.startSeconds`, message: "evidence timestamps require finite start >= 0 and end > start" });
  }
  if (typeof value.quote === "string" && value.quote.length > 4_096) {
    issues.push({ field: `${path}.quote`, message: "evidence quote exceeds the bounded limit" });
  }
  if (typeof value.provider === "string" && value.provider.length > 128) {
    issues.push({ field: `${path}.provider`, message: "evidence provider exceeds the bounded limit" });
  }
  if (value.language !== undefined && (typeof value.language !== "string" || value.language.length > 64)) {
    issues.push({ field: `${path}.language`, message: "evidence language must be a bounded string when present" });
  }
  if (value.confidence !== undefined && !EVIDENCE_CONFIDENCES.includes(value.confidence as EvidenceConfidence)) {
    issues.push({ field: `${path}.confidence`, message: `evidence confidence '${String(value.confidence)}' is unsupported` });
  }
  return issues;
}
/**
 * Cross-field invariants that draft-07 cannot express. The declarative schema
 * still documents and bounds each field; this helper is invoked by core
 * artifact validation before an acquisition stage can advance.
 */
export function validateLectureAcquisitionArtifact(value: unknown): AcquisitionValidationIssue[] {
  if (!record(value)) return [{ field: "$", message: "lecture_acquisition must be an object" }];
  const issues: AcquisitionValidationIssue[] = [];
  const evidence = value.evidence;
  if (Array.isArray(evidence)) {
    evidence.forEach((segment, index) => issues.push(...validateEvidenceSegment(segment, `$.evidence[${index}]`)));
    const status = value.status;
    if ((status === "partial" || status === "succeeded") && evidence.length === 0) {
      issues.push({ field: "$.evidence", message: `${status} acquisition requires at least one valid evidence segment` });
    }
  }
  if (value.pipeline !== undefined) {
    if (!record(value.pipeline)) {
      issues.push({ field: "$.pipeline", message: "pipeline metadata must be an object" });
    } else {
      const pipeline = value.pipeline;
      for (const key of ["media", "asr", "analysis"] as const) {
        const descriptor = pipeline[key];
        if (descriptor !== undefined) {
          if (!record(descriptor) || typeof descriptor.id !== "string" || descriptor.id.trim() === "" || descriptor.id.length > 128) {
            issues.push({ field: `$.pipeline.${key}`, message: "pipeline provider metadata is invalid" });
          }
          if (record(descriptor) && descriptor.model !== undefined && (typeof descriptor.model !== "string" || descriptor.model.length > 256)) {
            issues.push({ field: `$.pipeline.${key}.model`, message: "pipeline model metadata is invalid" });
          }
          if (key === "asr" && record(descriptor) && descriptor.timestampMode !== undefined && descriptor.timestampMode !== "provider" && descriptor.timestampMode !== "estimated") {
            issues.push({ field: "$.pipeline.asr.timestampMode", message: "pipeline ASR timestamp mode is invalid" });
          }
          if (record(descriptor) && descriptor.route !== undefined && (typeof descriptor.route !== "string" || descriptor.route.length > 64)) {
            issues.push({ field: `$.pipeline.${key}.route`, message: "pipeline route metadata is invalid" });
          }
        }
      }
      if (pipeline.fallbackUsed !== undefined && typeof pipeline.fallbackUsed !== "boolean") {
        issues.push({ field: "$.pipeline.fallbackUsed", message: "pipeline fallbackUsed must be boolean" });
      }
    }
  }
  if (typeof value.startedAt === "string" && !Number.isFinite(Date.parse(value.startedAt))) {
    issues.push({ field: "$.startedAt", message: "startedAt must be a parseable ISO-8601 timestamp" });
  }
  if (typeof value.completedAt === "string" && !Number.isFinite(Date.parse(value.completedAt))) {
    issues.push({ field: "$.completedAt", message: "completedAt must be a parseable ISO-8601 timestamp" });
  }
  if (typeof value.startedAt === "string" && typeof value.completedAt === "string") {
    const started = Date.parse(value.startedAt);
    const completed = Date.parse(value.completedAt);
    if (Number.isFinite(started) && Number.isFinite(completed) && completed < started) {
      issues.push({ field: "$.completedAt", message: "completedAt must not precede startedAt" });
    }
  }
  return issues;
}
