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

export interface LectureAcquisitionRequest {
  sourceUrl: string;
  prompt: string;
  limits: AcquisitionLimits;
  rights: {
    automatedPublicVideoAnalysisApproved: boolean;
    ownedCaptionAccessApproved: boolean;
  };
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
  if (value.language !== undefined && typeof value.language !== "string") {
    issues.push({ field: `${path}.language`, message: "evidence language must be a string when present" });
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
