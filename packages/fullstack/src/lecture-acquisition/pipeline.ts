import { createHash } from "node:crypto";
import type {
  BoundedAudioPreprocessorPort,
  EphemeralAudio,
  EvidenceSegment,
  LectureAcquisitionRequest,
  LectureAudioAcquirer,
  LectureEvidenceProvider,
  LectureTextAnalysisPort,
  PreparedAudioLease,
  ResolvedVideoSource,
  TimestampedTranscriptSegment,
} from "@andvl1/omp-workflows-core";
import {
  DEFAULT_ACQUISITION_LIMITS,
  chunkTimestampedTranscript,
  normalizeAnalysisCandidates,
  normalizeTimestampedTranscriptSegments,
} from "@andvl1/omp-workflows-core";
import { AcquisitionProviderError, isAcquisitionProviderError } from "./provider-errors.js";

export interface TranscribeAnalyzePipelineOptions {
  media: LectureAudioAcquirer;
  preprocess: BoundedAudioPreprocessorPort;
  asr: {
    readonly id: string;
    readonly model?: string;
    transcribe(audio: PreparedAudioLease, source: ResolvedVideoSource, request: LectureAcquisitionRequest, signal: AbortSignal): Promise<{ provider: string; model?: string; segments: TimestampedTranscriptSegment[]; timestampMode?: "provider" | "estimated" }>;
  };
  analysis: LectureTextAnalysisPort;
  fallbackAnalysis?: LectureTextAnalysisPort;
  maxEvidenceSegmentsPerSource?: number;
  maxTranscriptCharacters?: number;
  maxTranscriptSegments?: number;
  maxChunkCharacters?: number;
  maxChunksPerSource?: number;
  pipelineMetadata?: {
    media: { id: string; mode: "owned-audio" };
    asr: { id: string; model?: string; timestampMode?: "provider" | "estimated" };
    analysis: { id: string; model?: string; route?: string };
    fallbackUsed?: boolean;
  };
  preflightError?: AcquisitionProviderError;
}

function evidenceId(input: Pick<EvidenceSegment, "sourceId" | "kind" | "quote" | "startSeconds" | "endSeconds">): string {
  return createHash("sha256")
    .update(`${input.sourceId}\u0000${input.startSeconds}\u0000${input.endSeconds}\u0000${input.kind}\u0000${input.quote}`)
    .digest("hex");
}

function pipelineLimits(request: LectureAcquisitionRequest, options: TranscribeAnalyzePipelineOptions) {
  return {
    maxAudioBytes: request.limits.maxAudioBytes ?? DEFAULT_ACQUISITION_LIMITS.maxAudioBytes!,
    maxDurationSeconds: request.limits.maxDurationSeconds,
    maxTranscriptCharacters: options.maxTranscriptCharacters ?? request.limits.maxTranscriptCharacters ?? DEFAULT_ACQUISITION_LIMITS.maxTranscriptCharacters!,
    maxTranscriptSegments: options.maxTranscriptSegments ?? request.limits.maxTranscriptSegments ?? DEFAULT_ACQUISITION_LIMITS.maxTranscriptSegments!,
    maxChunkCharacters: options.maxChunkCharacters ?? request.limits.maxChunkCharacters ?? DEFAULT_ACQUISITION_LIMITS.maxChunkCharacters!,
    maxChunksPerSource: options.maxChunksPerSource ?? request.limits.maxChunksPerSource ?? DEFAULT_ACQUISITION_LIMITS.maxChunksPerSource!,
    maxAnalysisOutputBytes: request.limits.maxAnalysisOutputBytes ?? DEFAULT_ACQUISITION_LIMITS.maxAnalysisOutputBytes!,
  };
}

function canUseFallback(error: unknown): boolean {
  return isAcquisitionProviderError(error) && error.retryable && error.code !== "RIGHTS_REQUIRED" && error.code !== "PROVIDER_AUTH_MISSING";
}

export class TranscribeAnalyzeEvidenceProvider implements LectureEvidenceProvider {
  readonly id = "lecture-pipeline";
  readonly pipelineMetadata?: TranscribeAnalyzePipelineOptions["pipelineMetadata"];
  private fallbackUsed = false;

  constructor(private readonly options: TranscribeAnalyzePipelineOptions) {
    this.pipelineMetadata = options.pipelineMetadata;
  }

  supports(source: ResolvedVideoSource): boolean {
    return source.canonicalUrl.startsWith("https://www.youtube.com/") || source.canonicalUrl.startsWith("https://youtu.be/");
  }

  async acquire(source: ResolvedVideoSource, request: LectureAcquisitionRequest, signal: AbortSignal): Promise<{ provider: string; raw: unknown }> {
    if (request.mediaMode !== "owned-audio" || request.rights.automatedPublicVideoAnalysisApproved !== true || (request.rights.ownedMediaAudioAccessApproved !== true && request.rights.ownedMediaAccessApproved !== true)) {
      throw new AcquisitionProviderError("RIGHTS_REQUIRED", "Owned-audio rights approval is required", { provider: this.id, retryable: false });
    }
    if (this.options.preflightError) throw this.options.preflightError;
    const limits = pipelineLimits(request, this.options);
    let media: EphemeralAudio | undefined;
    let prepared: PreparedAudioLease | undefined;
    try {
      media = await this.options.media.acquire(source, request, signal);
      try {
        prepared = await this.options.preprocess.prepare(media, limits, signal);
        const transcriptResult = await this.options.asr.transcribe(prepared, source, request, signal);
        const transcript = normalizeTimestampedTranscriptSegments(transcriptResult.segments, limits.maxTranscriptCharacters).map((segment) =>
          transcriptResult.timestampMode ? { ...segment, timestampSource: transcriptResult.timestampMode } : segment,
        );
        const estimatedTimestamps = transcriptResult.timestampMode === "estimated";
        const chunks = chunkTimestampedTranscript(source.sourceId, transcript, limits);
        const evidence: EvidenceSegment[] = [];
        const seen = new Set<string>();
        for (const chunk of chunks) {
          const chunkSegments = transcript.filter((segment) => {
            const id = segment.segmentId;
            return id !== undefined && chunk.segmentIds.includes(id);
          });
          if (!chunkSegments.length) continue;
          const analysisResult = await this.analyzeWithFallback({ source, prompt: request.prompt, transcript: chunkSegments }, request, signal);
          if (!analysisResult.evidence.length) continue;
          const candidates = estimatedTimestamps
            ? analysisResult.evidence.map((candidate) => ({ ...candidate, confidence: "low" as const }))
            : analysisResult.evidence;
          const normalized = normalizeAnalysisCandidates(source, chunkSegments, { provider: analysisResult.provider, model: analysisResult.model, candidates }, this.options.maxEvidenceSegmentsPerSource ?? request.limits.maxEvidenceSegmentsPerSource, evidenceId);
          for (const item of normalized) {
            if (seen.has(item.evidenceId)) continue;
            seen.add(item.evidenceId);
            evidence.push(item);
            if (evidence.length >= (this.options.maxEvidenceSegmentsPerSource ?? request.limits.maxEvidenceSegmentsPerSource)) break;
          }
          if (evidence.length >= (this.options.maxEvidenceSegmentsPerSource ?? request.limits.maxEvidenceSegmentsPerSource)) break;
        }
        if (!evidence.length) throw new AcquisitionProviderError("ANALYSIS_FAILED", "Text analysis returned no grounded evidence", { provider: this.id, retryable: false });
        return { provider: evidence[0]!.provider, raw: { segments: evidence.map((item) => ({ quote: item.quote, start_seconds: item.startSeconds, end_seconds: item.endSeconds, kind: item.kind, language: item.language, confidence: item.confidence })) } };
      } finally {
        await prepared?.dispose().catch(() => undefined);
      }
    } finally {
      await media?.dispose().catch(() => undefined);
    }
  }

  private async analyzeWithFallback(
    input: { source: ResolvedVideoSource; prompt: string; transcript: readonly TimestampedTranscriptSegment[] },
    request: LectureAcquisitionRequest,
    signal: AbortSignal,
  ) {
    try {
      return await this.options.analysis.analyze(input, request, signal);
    } catch (error) {
      if (!this.options.fallbackAnalysis || !canUseFallback(error)) throw error;
      const result = await this.options.fallbackAnalysis.analyze(input, request, signal);
      this.fallbackUsed = true;
      return result;
    }
  }
}

export function createTranscribeAnalyzeProvider(options: TranscribeAnalyzePipelineOptions): TranscribeAnalyzeEvidenceProvider {
  return new TranscribeAnalyzeEvidenceProvider(options);
}
