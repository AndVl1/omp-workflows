/**
 * Provider-neutral, deterministic lecture evaluation.
 *
 * This module intentionally scores normalized transcripts and evidence only. It
 * never fetches media, invokes a provider, or treats lexical overlap as
 * semantic truth. The grounded-claim matcher is a transparent baseline for
 * comparing providers on the same rights-confirmed corpus.
 */

import type { EvidenceSegment, TimestampedTranscriptSegment } from "@andvl1/omp-workflows-core";

export const LECTURE_EVAL_SCHEMA_VERSION = 1 as const;

export const LECTURE_EVAL_RIGHTS_STATUSES = ["synthetic-fixture", "owned-approved"] as const;
export type LectureEvalRightsStatus = (typeof LECTURE_EVAL_RIGHTS_STATUSES)[number];

export interface LectureEvalReferenceClaim {
  /** Stable claim id for report consumers; scoring does not depend on it. */
  id?: string;
  /** Preferred claim text field. */
  text?: string;
  /** Accepted input alias for consumers that call claims `claim`. */
  claim?: string;
  /** Optional interval used by the baseline timestamp grounding check. */
  startSeconds?: number;
  endSeconds?: number;
  /** Friendly aliases accepted when loading hand-authored fixtures. */
  start?: number;
  end?: number;
}

export type LectureEvalClaim = string | LectureEvalReferenceClaim;

export interface LectureEvalCase {
  schemaVersion: typeof LECTURE_EVAL_SCHEMA_VERSION;
  id: string;
  rightsStatus: LectureEvalRightsStatus;
  /** Human-readable provenance note; synthetic fixtures must say they are synthetic. */
  rightsNotes: string;
  language: string;
  durationSeconds: number;
  referenceTranscript: readonly TimestampedTranscriptSegment[];
  referenceClaims: readonly LectureEvalClaim[];
  referenceProposalTerms?: readonly string[];
}

export interface LectureEvalManifest {
  schemaVersion: typeof LECTURE_EVAL_SCHEMA_VERSION;
  cases: readonly LectureEvalCase[];
}

export type LectureEvalCorpusManifest = LectureEvalManifest;
export type LectureEvalCorpusCase = LectureEvalCase;

/**
 * A normalized provider result. `normalizedEvidence` is canonical; `evidence`
 * is retained as a compatibility alias for callers already using the pipeline's
 * `evidence` field. At least one should be supplied by a production caller.
 */
export interface LectureEvalRun {
  provider: string;
  model?: string;
  /** Route label such as `local`, `hosted`, or `omp-runtime`. */
  route: string;
  predictedTranscript: readonly TimestampedTranscriptSegment[];
  normalizedEvidence?: readonly EvidenceSegment[];
  evidence?: readonly EvidenceSegment[];
  /** Preferred proposal output field. */
  predictedProposalTerms?: readonly string[];
  /** Accepted alias for proposal output from a research adapter. */
  proposalTerms?: readonly string[];
  latencyMs: number;
  costCents: number;
  cleanupVerified: boolean;
}

export type LectureEvalPrediction = LectureEvalRun;

export interface LectureEvalTimestampConfig {
  /** Minimum interval IoU for a timestamp match. */
  overlapThreshold: number;
  /** Boundary error tolerated for a match, in seconds. */
  boundaryToleranceSeconds: number;
}

export interface LectureEvalClaimsConfig {
  /** Minimum token-level lexical F1 for a claim/evidence match. */
  lexicalOverlapThreshold: number;
  /** Minimum timestamp interval quality when a claim has an interval. */
  timestampOverlapThreshold: number;
}

export interface LectureEvalProposalConfig {
  /** Minimum token-level lexical F1 for matching proposal terms. */
  termOverlapThreshold: number;
}

export interface LectureEvalAggregateWeights {
  transcript: number;
  timestamps: number;
  groundedClaims: number;
  proposal: number;
  cleanup: number;
}

/**
 * Scoring options are explicit and can be supplied either in grouped form or
 * through the flat aliases. Flat aliases make config easy to load from JSON;
 * grouped options make the metric boundary self-documenting in code.
 */
export interface LectureEvalScoringConfig {
  timestamp?: Partial<LectureEvalTimestampConfig>;
  claims?: Partial<LectureEvalClaimsConfig>;
  proposal?: Partial<LectureEvalProposalConfig>;
  aggregateWeights?: Partial<LectureEvalAggregateWeights>;
  timestampOverlapThreshold?: number;
  timestampBoundaryToleranceSeconds?: number;
  claimLexicalOverlapThreshold?: number;
  claimTimestampOverlapThreshold?: number;
  proposalTermOverlapThreshold?: number;
}

export type LectureEvalConfig = LectureEvalScoringConfig;

export const DEFAULT_LECTURE_EVAL_CONFIG: Readonly<{
  timestamp: LectureEvalTimestampConfig;
  claims: LectureEvalClaimsConfig;
  proposal: LectureEvalProposalConfig;
  aggregateWeights: LectureEvalAggregateWeights;
}> = Object.freeze({
  timestamp: Object.freeze({ overlapThreshold: 0.5, boundaryToleranceSeconds: 0.25 }),
  claims: Object.freeze({ lexicalOverlapThreshold: 0.5, timestampOverlapThreshold: 0.5 }),
  proposal: Object.freeze({ termOverlapThreshold: 0.5 }),
  aggregateWeights: Object.freeze({ transcript: 1, timestamps: 1, groundedClaims: 1, proposal: 1, cleanup: 1 }),
});

export const DEFAULT_EVAL_CONFIG = DEFAULT_LECTURE_EVAL_CONFIG;

type MetricValue = number | "n/a";

export interface GroundedClaimScore {
  precision: number;
  recall: number;
  hallucinationRate: number;
  matchedClaims: number;
  referenceClaims: number;
  predictedEvidence: number;
  /** This is a lexical/timestamp baseline, not a semantic truth judgment. */
  baseline: "lexical-timestamp";
}

export interface ProposalRelevanceScore {
  status: "scored" | "n/a";
  precision: MetricValue;
  recall: MetricValue;
  f1: MetricValue;
  matchedTerms: number;
  referenceTerms: number;
  predictedTerms: number;
  /** Explains why a metric is `n/a` when no reference proposal exists. */
  semantics: string;
}

export interface LectureEvalAggregateReport {
  score: number;
  bounded: true;
  dimensions: {
    transcript: number;
    timestamps: number;
    groundedClaims: number;
    proposal: number;
    cleanup: number;
  };
  includedDimensions: readonly string[];
}

export interface LectureEvalReport {
  schemaVersion: typeof LECTURE_EVAL_SCHEMA_VERSION;
  caseId: string;
  rightsStatus: LectureEvalRightsStatus;
  language: string;
  provider: string;
  model?: string;
  route: string;
  metrics: {
    wer: number;
    cer: number;
    timestampAlignment: number;
    groundedClaimPrecision: number;
    groundedClaimRecall: number;
    hallucinationRate: number;
    proposalRelevance: number;
    proposalRelevanceMetrics: ProposalRelevanceScore;
    latencyMs: number;
    costCents: number;
    costCentsPerMinute: number;
    cleanupPassed: boolean;
  };
  aggregate: LectureEvalAggregateReport;
  notes: readonly string[];
}

export interface LectureEvalScore {
  schemaVersion: typeof LECTURE_EVAL_SCHEMA_VERSION;
  caseId: string;
  rightsStatus: LectureEvalRightsStatus;
  provider: string;
  model?: string;
  route: string;
  wer: number;
  cer: number;
  timestampAlignment: number;
  groundedClaimPrecision: number;
  groundedClaimRecall: number;
  hallucinationRate: number;
  /** Numeric F1 shortcut; see `proposalRelevanceMetrics` for precision/recall and n/a semantics. */
  proposalRelevance: number;
  proposalRelevanceMetrics: ProposalRelevanceScore;
  latencyMs: number;
  costCents: number;
  costCentsPerMinute: number;
  cleanupPassed: boolean;
  /** Bounded quality aggregate in [0, 1]. */
  aggregate: number;
  aggregateScore: number;
  aggregateReport: LectureEvalAggregateReport;
  report: LectureEvalReport;
}

interface ResolvedLectureEvalConfig {
  timestamp: LectureEvalTimestampConfig;
  claims: LectureEvalClaimsConfig;
  proposal: LectureEvalProposalConfig;
  aggregateWeights: LectureEvalAggregateWeights;
}

interface Interval {
  start: number;
  end: number;
}

interface NormalizedClaim {
  text: string;
  interval?: Interval;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function finiteNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

function threshold(value: number | undefined, fallback: number): number {
  return clamp01(Number.isFinite(value) ? value! : fallback);
}

function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? Math.min(value!, Number.MAX_SAFE_INTEGER) : fallback;
}

function resolveConfig(input: LectureEvalScoringConfig | undefined): ResolvedLectureEvalConfig {
  const timestamp = input?.timestamp ?? {};
  const claims = input?.claims ?? {};
  const proposal = input?.proposal ?? {};
  const weights = input?.aggregateWeights ?? {};
  return {
    timestamp: {
      overlapThreshold: threshold(input?.timestampOverlapThreshold ?? timestamp.overlapThreshold, DEFAULT_LECTURE_EVAL_CONFIG.timestamp.overlapThreshold),
      boundaryToleranceSeconds: nonNegative(input?.timestampBoundaryToleranceSeconds ?? timestamp.boundaryToleranceSeconds, DEFAULT_LECTURE_EVAL_CONFIG.timestamp.boundaryToleranceSeconds),
    },
    claims: {
      lexicalOverlapThreshold: threshold(input?.claimLexicalOverlapThreshold ?? claims.lexicalOverlapThreshold, DEFAULT_LECTURE_EVAL_CONFIG.claims.lexicalOverlapThreshold),
      timestampOverlapThreshold: threshold(input?.claimTimestampOverlapThreshold ?? claims.timestampOverlapThreshold, DEFAULT_LECTURE_EVAL_CONFIG.claims.timestampOverlapThreshold),
    },
    proposal: {
      termOverlapThreshold: threshold(input?.proposalTermOverlapThreshold ?? proposal.termOverlapThreshold, DEFAULT_LECTURE_EVAL_CONFIG.proposal.termOverlapThreshold),
    },
    aggregateWeights: {
      transcript: nonNegative(weights.transcript, DEFAULT_LECTURE_EVAL_CONFIG.aggregateWeights.transcript),
      timestamps: nonNegative(weights.timestamps, DEFAULT_LECTURE_EVAL_CONFIG.aggregateWeights.timestamps),
      groundedClaims: nonNegative(weights.groundedClaims, DEFAULT_LECTURE_EVAL_CONFIG.aggregateWeights.groundedClaims),
      proposal: nonNegative(weights.proposal, DEFAULT_LECTURE_EVAL_CONFIG.aggregateWeights.proposal),
      cleanup: nonNegative(weights.cleanup, DEFAULT_LECTURE_EVAL_CONFIG.aggregateWeights.cleanup),
    },
  };
}

/** Unicode-normalized, case-insensitive lexical form used by all baseline matchers. */
export function normalizeEvalText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

export function normalizedEvalTokens(value: string): string[] {
  const normalized = normalizeEvalText(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

export function normalizedEvalCharacters(value: string): string[] {
  return Array.from(normalizeEvalText(value).replace(/\s+/g, ""));
}

/** Deterministic Levenshtein distance with no provider/model dependencies. */
export function levenshteinDistance<T>(reference: readonly T[], predicted: readonly T[]): number {
  if (reference.length === 0) return predicted.length;
  if (predicted.length === 0) return reference.length;
  let previous = Array.from({ length: predicted.length + 1 }, (_, index) => index);
  for (let i = 1; i <= reference.length; i += 1) {
    const current = [i];
    const referenceItem = reference[i - 1];
    for (let j = 1; j <= predicted.length; j += 1) {
      const substitution = previous[j - 1]! + (referenceItem === predicted[j - 1] ? 0 : 1);
      const insertion = current[j - 1]! + 1;
      const deletion = previous[j]! + 1;
      current.push(Math.min(substitution, insertion, deletion));
    }
    previous = current;
  }
  return previous[predicted.length]!;
}

function transcriptText(input: string | readonly TimestampedTranscriptSegment[]): string {
  if (typeof input === "string") return input;
  return input.map((segment) => typeof segment.text === "string" ? segment.text : "").join(" ");
}

function normalizedTextTokens(input: string | readonly TimestampedTranscriptSegment[]): string[] {
  return normalizedEvalTokens(transcriptText(input));
}

function normalizedTextCharacters(input: string | readonly TimestampedTranscriptSegment[]): string[] {
  return normalizedEvalCharacters(transcriptText(input));
}

function errorRate(reference: readonly string[], predicted: readonly string[]): number {
  if (reference.length === 0) return predicted.length === 0 ? 0 : 1;
  return finiteNonNegative(levenshteinDistance(reference, predicted) / reference.length);
}

/** Word error rate over normalized transcript tokens. Empty/empty is 0; empty reference is 0 or 1. */
export function wordErrorRate(
  reference: string | readonly TimestampedTranscriptSegment[],
  predicted: string | readonly TimestampedTranscriptSegment[],
): number {
  return errorRate(normalizedTextTokens(reference), normalizedTextTokens(predicted));
}

/** Character error rate over normalized, punctuation/whitespace-insensitive characters. */
export function characterErrorRate(
  reference: string | readonly TimestampedTranscriptSegment[],
  predicted: string | readonly TimestampedTranscriptSegment[],
): number {
  return errorRate(normalizedTextCharacters(reference), normalizedTextCharacters(predicted));
}

function intervalOf(value: { startSeconds?: unknown; endSeconds?: unknown; start?: unknown; end?: unknown }): Interval | undefined {
  const startValue = value.startSeconds ?? value.start;
  const endValue = value.endSeconds ?? value.end;
  if (typeof startValue !== "number" || typeof endValue !== "number") return undefined;
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue) || startValue < 0 || endValue <= startValue) return undefined;
  return { start: startValue, end: endValue };
}

function intersectionOverUnion(left: Interval, right: Interval): number {
  const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
  const union = Math.max(left.end, right.end) - Math.min(left.start, right.start);
  return union > 0 ? clamp01(overlap / union) : 0;
}

function boundaryQuality(left: Interval, right: Interval, tolerance: number): number {
  const error = Math.max(Math.abs(left.start - right.start), Math.abs(left.end - right.end));
  if (tolerance === 0) return error === 0 ? 1 : 0;
  return clamp01(1 - error / tolerance);
}

function timestampPairQuality(reference: Interval, predicted: Interval, config: LectureEvalTimestampConfig): { quality: number; eligible: boolean } {
  const overlap = intersectionOverUnion(reference, predicted);
  const boundary = boundaryQuality(reference, predicted, config.boundaryToleranceSeconds);
  const boundariesWithinTolerance = config.boundaryToleranceSeconds === 0
    ? boundary === 1
    : Math.abs(reference.start - predicted.start) <= config.boundaryToleranceSeconds && Math.abs(reference.end - predicted.end) <= config.boundaryToleranceSeconds;
  return { quality: Math.max(overlap, boundary), eligible: overlap >= config.overlapThreshold || boundariesWithinTolerance };
}

/**
 * Greedy one-to-one timestamp matching. Candidates are ranked by quality,
 * overlap, then original prediction order; extra segments lower the score.
 */
export function scoreTimestampAlignment(
  reference: readonly TimestampedTranscriptSegment[],
  predicted: readonly TimestampedTranscriptSegment[],
  config: Partial<LectureEvalTimestampConfig> = {},
): number {
  const resolved: LectureEvalTimestampConfig = {
    overlapThreshold: threshold(config.overlapThreshold, DEFAULT_LECTURE_EVAL_CONFIG.timestamp.overlapThreshold),
    boundaryToleranceSeconds: nonNegative(config.boundaryToleranceSeconds, DEFAULT_LECTURE_EVAL_CONFIG.timestamp.boundaryToleranceSeconds),
  };
  const referenceIntervals = reference.map(intervalOf).filter((value): value is Interval => value !== undefined);
  const predictedIntervals = predicted.map(intervalOf).filter((value): value is Interval => value !== undefined);
  if (referenceIntervals.length === 0 && predictedIntervals.length === 0) return 1;
  if (referenceIntervals.length === 0 || predictedIntervals.length === 0) return 0;
  const used = new Set<number>();
  let totalQuality = 0;
  for (const referenceInterval of referenceIntervals) {
    const candidates: Array<{ index: number; quality: number; overlap: number }> = [];
    for (const [index, predictedInterval] of predictedIntervals.entries()) {
      if (used.has(index)) continue;
      const pair = timestampPairQuality(referenceInterval, predictedInterval, resolved);
      if (!pair.eligible) continue;
      candidates.push({ index, quality: pair.quality, overlap: intersectionOverUnion(referenceInterval, predictedInterval) });
    }
    candidates.sort((left, right) => right.quality - left.quality || right.overlap - left.overlap || left.index - right.index);
    const best = candidates[0];
    if (!best) continue;
    used.add(best.index);
    totalQuality += clamp01(best.quality);
  }
  return clamp01(totalQuality / Math.max(referenceIntervals.length, predictedIntervals.length));
}

export const timestampAlignmentScore = scoreTimestampAlignment;

function claimText(value: LectureEvalClaim): string {
  if (typeof value === "string") return value;
  if (typeof value.text === "string") return value.text;
  if (typeof value.claim === "string") return value.claim;
  return "";
}

function normalizedClaims(claims: readonly LectureEvalClaim[]): NormalizedClaim[] {
  return claims.map((claim) => {
    const interval = typeof claim === "string" ? undefined : intervalOf(claim);
    return { text: claimText(claim), ...(interval ? { interval } : {}) };
  }).filter((claim) => normalizedEvalTokens(claim.text).length > 0);
}

function lexicalOverlap(reference: string, predicted: string): { precision: number; recall: number; f1: number } {
  const referenceTokens = normalizedEvalTokens(reference);
  const predictedTokens = normalizedEvalTokens(predicted);
  if (referenceTokens.length === 0 || predictedTokens.length === 0) return { precision: 0, recall: 0, f1: 0 };
  const counts = new Map<string, number>();
  for (const token of referenceTokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  let overlap = 0;
  for (const token of predictedTokens) {
    const remaining = counts.get(token) ?? 0;
    if (remaining <= 0) continue;
    overlap += 1;
    counts.set(token, remaining - 1);
  }
  const precision = clamp01(overlap / predictedTokens.length);
  const recall = clamp01(overlap / referenceTokens.length);
  const denominator = precision + recall;
  return { precision, recall, f1: denominator === 0 ? 0 : clamp01((2 * precision * recall) / denominator) };
}

/**
 * Baseline grounded-claim score: one-to-one lexical F1 plus timestamp overlap
 * where reference claims provide intervals. This is not semantic truth and is
 * intentionally reported as a baseline for provider comparison.
 */
export function scoreGroundedClaims(
  referenceClaims: readonly LectureEvalClaim[],
  evidence: readonly EvidenceSegment[],
  config: Partial<LectureEvalClaimsConfig> & Partial<LectureEvalTimestampConfig> = {},
): GroundedClaimScore {
  const claimsConfig: LectureEvalClaimsConfig = {
    lexicalOverlapThreshold: threshold(config.lexicalOverlapThreshold, DEFAULT_LECTURE_EVAL_CONFIG.claims.lexicalOverlapThreshold),
    timestampOverlapThreshold: threshold(config.timestampOverlapThreshold, DEFAULT_LECTURE_EVAL_CONFIG.claims.timestampOverlapThreshold),
  };
  const timestampConfig: LectureEvalTimestampConfig = {
    overlapThreshold: claimsConfig.timestampOverlapThreshold,
    boundaryToleranceSeconds: nonNegative(config.boundaryToleranceSeconds, DEFAULT_LECTURE_EVAL_CONFIG.timestamp.boundaryToleranceSeconds),
  };
  const claims = normalizedClaims(referenceClaims);
  const usedClaims = new Set<number>();
  let matched = 0;
  for (const item of evidence) {
    const quote = typeof item.quote === "string" ? item.quote : "";
    const predictedInterval = intervalOf(item);
    const candidates: Array<{ index: number; lexical: number; timestamp: number; quality: number }> = [];
    for (const [index, claim] of claims.entries()) {
      if (usedClaims.has(index)) continue;
      const lexical = lexicalOverlap(claim.text, quote).f1;
      if (lexical < claimsConfig.lexicalOverlapThreshold) continue;
      let timestamp = 1;
      if (claim.interval) {
        timestamp = predictedInterval ? timestampPairQuality(claim.interval, predictedInterval, timestampConfig).quality : 0;
        if (timestamp < claimsConfig.timestampOverlapThreshold) continue;
      }
      candidates.push({ index, lexical, timestamp, quality: lexical * timestamp });
    }
    candidates.sort((left, right) => right.quality - left.quality || right.lexical - left.lexical || left.index - right.index);
    const best = candidates[0];
    if (!best) continue;
    usedClaims.add(best.index);
    matched += 1;
  }
  const predictedCount = evidence.length;
  const referenceCount = claims.length;
  const precision = predictedCount === 0 ? (referenceCount === 0 ? 1 : 0) : clamp01(matched / predictedCount);
  const recall = referenceCount === 0 ? (predictedCount === 0 ? 1 : 0) : clamp01(matched / referenceCount);
  const hallucinationRate = predictedCount === 0 ? 0 : clamp01((predictedCount - matched) / predictedCount);
  return {
    precision,
    recall,
    hallucinationRate,
    matchedClaims: matched,
    referenceClaims: referenceCount,
    predictedEvidence: predictedCount,
    baseline: "lexical-timestamp",
  };
}

export const groundedClaimScore = scoreGroundedClaims;

function normalizedTerms(terms: readonly string[] | undefined): string[] {
  return (terms ?? []).map((term) => normalizeEvalText(typeof term === "string" ? term : "")).filter((term) => term.length > 0);
}

/** Proposal-term lexical precision/recall/F1 with explicit no-reference n/a semantics. */
export function scoreProposalRelevance(
  referenceTerms: readonly string[] | undefined,
  predictedTerms: readonly string[] | undefined,
  config: Partial<LectureEvalProposalConfig> = {},
): ProposalRelevanceScore {
  const thresholdValue = threshold(config.termOverlapThreshold, DEFAULT_LECTURE_EVAL_CONFIG.proposal.termOverlapThreshold);
  const reference = normalizedTerms(referenceTerms);
  const predicted = normalizedTerms(predictedTerms);
  if (reference.length === 0) {
    return {
      status: "n/a",
      precision: predicted.length === 0 ? "n/a" : 0,
      recall: "n/a",
      f1: "n/a",
      matchedTerms: 0,
      referenceTerms: 0,
      predictedTerms: predicted.length,
      semantics: "No reference proposal terms were supplied; numeric proposal relevance is reported as 0 and should be treated as not applicable.",
    };
  }
  const used = new Set<number>();
  let matched = 0;
  for (const term of predicted) {
    const candidates: Array<{ index: number; f1: number }> = [];
    for (const [index, referenceTerm] of reference.entries()) {
      if (used.has(index)) continue;
      const f1 = lexicalOverlap(referenceTerm, term).f1;
      if (f1 >= thresholdValue) candidates.push({ index, f1 });
    }
    candidates.sort((left, right) => right.f1 - left.f1 || left.index - right.index);
    const best = candidates[0];
    if (!best) continue;
    used.add(best.index);
    matched += 1;
  }
  const precision = predicted.length === 0 ? 0 : clamp01(matched / predicted.length);
  const recall = clamp01(matched / reference.length);
  const denominator = precision + recall;
  const f1 = denominator === 0 ? 0 : clamp01((2 * precision * recall) / denominator);
  return {
    status: "scored",
    precision,
    recall,
    f1,
    matchedTerms: matched,
    referenceTerms: reference.length,
    predictedTerms: predicted.length,
    semantics: "One-to-one lexical term matching; punctuation and case are normalized and no semantic entailment is inferred.",
  };
}

export const proposalRelevanceScore = scoreProposalRelevance;

function numericMetric(value: MetricValue): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : 0;
}

function aggregateReport(
  wer: number,
  cer: number,
  timestampAlignment: number,
  groundedClaimPrecision: number,
  proposal: ProposalRelevanceScore,
  cleanupPassed: boolean,
  weights: LectureEvalAggregateWeights,
): LectureEvalAggregateReport {
  const dimensions = {
    transcript: clamp01(1 - (clamp01(wer) + clamp01(cer)) / 2),
    timestamps: clamp01(timestampAlignment),
    groundedClaims: clamp01(groundedClaimPrecision),
    proposal: numericMetric(proposal.f1),
    cleanup: cleanupPassed ? 1 : 0,
  };
  const configured = [
    ["transcript", dimensions.transcript, weights.transcript],
    ["timestamps", dimensions.timestamps, weights.timestamps],
    ["groundedClaims", dimensions.groundedClaims, weights.groundedClaims],
    ...(proposal.status === "scored" ? [["proposal", dimensions.proposal, weights.proposal] as const] : []),
    ["cleanup", dimensions.cleanup, weights.cleanup],
  ] as const;
  const includedDimensions = configured.filter(([, , weight]) => weight > 0).map(([name]) => name);
  const totalWeight = configured.reduce((sum, [, , weight]) => sum + (weight > 0 ? weight : 0), 0);
  const score = totalWeight === 0 ? 0 : clamp01(configured.reduce((sum, [, value, weight]) => sum + (weight > 0 ? value * weight : 0), 0) / totalWeight);
  return { score, bounded: true, dimensions, includedDimensions };
}

function evidenceFromRun(run: LectureEvalRun): readonly EvidenceSegment[] {
  return run.normalizedEvidence ?? run.evidence ?? [];
}

function validateCase(evalCase: LectureEvalCase): void {
  if (!LECTURE_EVAL_RIGHTS_STATUSES.includes(evalCase.rightsStatus)) throw new RangeError("lecture eval case has an unsupported rightsStatus");
  if (typeof evalCase.id !== "string" || evalCase.id.trim().length === 0) throw new RangeError("lecture eval case id is required");
  if (typeof evalCase.rightsNotes !== "string" || evalCase.rightsNotes.trim().length === 0) throw new RangeError("lecture eval case rightsNotes are required");
}

/** Score one normalized provider run against one rights-safe reference case. */
export function scoreLectureEvalCase(
  evalCase: LectureEvalCase,
  run: LectureEvalRun,
  inputConfig?: LectureEvalScoringConfig,
): LectureEvalScore {
  validateCase(evalCase);
  const config = resolveConfig(inputConfig);
  const referenceTranscript = evalCase.referenceTranscript ?? [];
  const predictedTranscript = run.predictedTranscript ?? [];
  const evidence = evidenceFromRun(run);
  const wer = wordErrorRate(referenceTranscript, predictedTranscript);
  const cer = characterErrorRate(referenceTranscript, predictedTranscript);
  const timestampAlignment = scoreTimestampAlignment(referenceTranscript, predictedTranscript, config.timestamp);
  const grounded = scoreGroundedClaims(evalCase.referenceClaims ?? [], evidence, {
    ...config.claims,
    boundaryToleranceSeconds: config.timestamp.boundaryToleranceSeconds,
  });
  const predictedProposalTerms = run.predictedProposalTerms ?? run.proposalTerms;
  const proposal = scoreProposalRelevance(evalCase.referenceProposalTerms, predictedProposalTerms, config.proposal);
  const latencyMs = finiteNonNegative(run.latencyMs);
  const costCents = finiteNonNegative(run.costCents);
  const durationSeconds = finiteNonNegative(evalCase.durationSeconds);
  const costCentsPerMinute = durationSeconds > 0 ? finiteNonNegative(costCents / (durationSeconds / 60)) : 0;
  const cleanupPassed = run.cleanupVerified === true;
  const aggregate = aggregateReport(wer, cer, timestampAlignment, grounded.precision, proposal, cleanupPassed, config.aggregateWeights);
  const proposalRelevance = numericMetric(proposal.f1);
  const notes = [
    "Grounded-claim precision and hallucination rate are a lexical/timestamp baseline, not semantic truth.",
    proposal.status === "n/a" ? "Proposal relevance is n/a because the case has no reference proposal terms; its numeric shortcut is 0." : "Proposal relevance uses one-to-one lexical precision/recall/F1.",
    "Latency and cost are run-reported metadata; no provider pricing is inferred.",
  ] as const;
  const report: LectureEvalReport = {
    schemaVersion: LECTURE_EVAL_SCHEMA_VERSION,
    caseId: evalCase.id,
    rightsStatus: evalCase.rightsStatus,
    language: evalCase.language,
    provider: run.provider,
    ...(run.model ? { model: run.model } : {}),
    route: run.route,
    metrics: {
      wer,
      cer,
      timestampAlignment,
      groundedClaimPrecision: grounded.precision,
      groundedClaimRecall: grounded.recall,
      hallucinationRate: grounded.hallucinationRate,
      proposalRelevance,
      proposalRelevanceMetrics: proposal,
      latencyMs,
      costCents,
      costCentsPerMinute,
      cleanupPassed,
    },
    aggregate,
    notes,
  };
  return {
    schemaVersion: LECTURE_EVAL_SCHEMA_VERSION,
    caseId: evalCase.id,
    rightsStatus: evalCase.rightsStatus,
    provider: run.provider,
    ...(run.model ? { model: run.model } : {}),
    route: run.route,
    wer,
    cer,
    timestampAlignment,
    groundedClaimPrecision: grounded.precision,
    groundedClaimRecall: grounded.recall,
    hallucinationRate: grounded.hallucinationRate,
    proposalRelevance,
    proposalRelevanceMetrics: proposal,
    latencyMs,
    costCents,
    costCentsPerMinute,
    cleanupPassed,
    aggregate: aggregate.score,
    aggregateScore: aggregate.score,
    aggregateReport: aggregate,
    report,
  };
}
