import { createHash } from "node:crypto";
import type {
  AcquisitionFailure,
  EvidenceSegment,
  LectureAcquisitionArtifact,
  LectureAcquisitionPort,
  LectureAcquisitionRequest,
  LectureEvidenceProvider,
  LectureSourceParser,
  LectureTextAnalysisPort,
  PlaylistExpander,
  ResolvedVideoSource,
} from "@andvl1/omp-workflows-core";
import { EVIDENCE_CONFIDENCES, EVIDENCE_KINDS, validateLectureAcquisitionArtifact } from "@andvl1/omp-workflows-core";
import { parseYouTubeUrl } from "./youtube-url.js";
import { YouTubePlaylistExpander } from "./youtube-playlist.js";
import { GeminiYouTubeProvider } from "./gemini.js";
import { AcquisitionProviderError, isAcquisitionProviderError, safeProviderError } from "./provider-errors.js";
import { loadLectureResearchConfig, type LectureResearchConfig } from "./config.js";
import { AuthorizedAudioAcquirer } from "./media.js";
import { BoundedAudioPreprocessor } from "./audio-preprocess.js";
import { WhisperLocalAsr } from "./asr-local-whisper.js";
import { HostedAsr } from "./asr-hosted.js";
import { OpenRouterNativeAsr } from "./asr-openrouter.js";
import { LocalTextAnalysis } from "./local-text.js";
import { OpenAICompatibleTextAnalysis } from "./text-analysis.js";
import { DefaultOmpRuntimeCapabilityProbe, OmpTextAnalysis, type OmpRuntimeCapabilityProbe, type OmpRuntimeProbeResult } from "./omp-runtime.js";
import { TranscribeAnalyzeEvidenceProvider } from "./pipeline.js";

type Failure = AcquisitionFailure;

function makeFailure(code: Failure["code"], message: string, extra: Partial<Failure> = {}): Failure {
  return { code, message, retryable: false, attempts: 1, severity: "error", ...extra };
}

function safeFailure(error: unknown, provider?: string): Failure {
  const safe = safeProviderError(provider ?? "lecture-acquisition", error);
  return { code: safe.code, message: safe.message, retryable: safe.retryable, attempts: 1, severity: "error", ...(provider ? { provider } : {}) };
}

export class LectureAcquisitionError extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.message);
    this.name = "LectureAcquisitionError";
    this.failure = { ...failure };
  }
}

export const isLectureAcquisitionError = (error: unknown): error is LectureAcquisitionError => error instanceof LectureAcquisitionError;

export interface LectureAcquisitionServiceOptions {
  parser: LectureSourceParser;
  playlistExpander: PlaylistExpander;
  evidenceProvider: LectureEvidenceProvider;
  providerId?: string;
  model?: string;
  clock?: () => Date;
  pipeline?: LectureAcquisitionArtifact["pipeline"];
}

function sourceFor(parsed: { kind: "video"; videoId: string; canonicalUrl: string }): ResolvedVideoSource {
  return { sourceId: `yt-video-${parsed.videoId}`, videoId: parsed.videoId, canonicalUrl: parsed.canonicalUrl };
}

function parseRawSegments(raw: unknown, source: ResolvedVideoSource, provider: string, cap: number): EvidenceSegment[] {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "provider returned malformed analysis", { provider, retryable: false }); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !("segments" in value) || !Array.isArray(value.segments)) {
    throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "provider returned invalid analysis", { provider, retryable: false });
  }
  const output: EvidenceSegment[] = [];
  for (const item of value.segments) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const quote = typeof record.quote === "string" ? record.quote.trim() : "";
    const start = typeof record.start_seconds === "number" ? record.start_seconds : record.startSeconds;
    const end = typeof record.end_seconds === "number" ? record.end_seconds : record.endSeconds;
    const kind = record.kind;
    if (!quote || quote.length > 4_096 || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !EVIDENCE_KINDS.includes(kind as typeof EVIDENCE_KINDS[number])) continue;
    const language = typeof record.language === "string" && record.language.length <= 64 ? record.language : undefined;
    const confidence = typeof record.confidence === "string" && EVIDENCE_CONFIDENCES.includes(record.confidence as typeof EVIDENCE_CONFIDENCES[number]) ? record.confidence as typeof EVIDENCE_CONFIDENCES[number] : undefined;
    output.push({
      evidenceId: createHash("sha256").update(`${source.sourceId}\u0000${start}\u0000${end}\u0000${String(kind)}\u0000${quote}`).digest("hex"),
      sourceId: source.sourceId,
      location: source.canonicalUrl,
      provider,
      kind: kind as EvidenceSegment["kind"],
      quote,
      startSeconds: start,
      endSeconds: end,
      ...(language ? { language } : {}),
      ...(confidence ? { confidence } : {}),
    });
    if (output.length >= cap) break;
  }
  if (!output.length) throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "provider returned no valid evidence", { provider, retryable: false });
  return output;
}

export class YouTubeLectureAcquisitionService implements LectureAcquisitionPort {
  constructor(private readonly options: LectureAcquisitionServiceOptions) {}

  async acquire(request: LectureAcquisitionRequest, externalSignal?: AbortSignal): Promise<LectureAcquisitionArtifact> {
    const prompt = request?.prompt;
    if (typeof prompt !== "string" || prompt.trim().length === 0) throw new LectureAcquisitionError(makeFailure("INVALID_URL", "Lecture prompt must be a non-empty string", { attempts: 0 }));
    if (prompt.length > 16_384) throw new LectureAcquisitionError(makeFailure("LIMIT_EXCEEDED", "Lecture prompt exceeds the maximum allowed length", { attempts: 0 }));
    const clock = this.options.clock ?? (() => new Date());
    const startedAt = clock();
    const parsed = this.options.parser.parse(request.sourceUrl);
    if (!("kind" in parsed)) throw new LectureAcquisitionError(parsed);
    const controller = new AbortController();
    const external = externalSignal ?? new AbortController().signal;
    const abort = () => controller.abort();
    external.addEventListener("abort", abort, { once: true });
    if (external.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), request.limits.deadlineMs);
    const providerId = this.options.providerId ?? this.options.evidenceProvider.id;
    const provider = { id: providerId, ...(this.options.model ? { model: this.options.model } : {}) };
    const requestShape = { sourceUrl: request.sourceUrl, canonicalUrl: parsed.canonicalUrl, sourceKind: parsed.kind, prompt: request.prompt, limits: request.limits };
    try {
      if (!request.rights.automatedPublicVideoAnalysisApproved) {
        const sourceSet = parsed.kind === "playlist"
          ? { requested: parsed, items: [], truncated: false, failures: [] }
          : { requested: parsed, items: [sourceFor(parsed)], truncated: false, failures: [] };
        return this.validatedArtifact({ schemaVersion: 1, status: "failed", request: requestShape, sourceSet, evidence: [], failures: [makeFailure("RIGHTS_REQUIRED", "Automated public video analysis approval is required")], provider, ...(this.options.pipeline ? { pipeline: this.options.pipeline } : {}), startedAt: startedAt.toISOString(), completedAt: clock().toISOString() });
      }
      let sourceSet;
      try {
        sourceSet = parsed.kind === "playlist"
          ? await this.options.playlistExpander.expand(parsed, request.limits, controller.signal)
          : { requested: parsed, items: [sourceFor(parsed)], truncated: false, failures: [] };
      } catch (error) {
        sourceSet = { requested: parsed, items: [], truncated: false, failures: [safeFailure(error, providerId)] };
      }
      const failures: Failure[] = [...sourceSet.failures];
      if (sourceSet.truncated) failures.push(makeFailure("PARTIAL_SOURCE_SET", "Playlist source set was truncated", { severity: "warning", provider: providerId }));
      const evidence: EvidenceSegment[] = [];
      for (const source of sourceSet.items) {
        try {
          evidence.push(...await this.acquireSource(source, request, controller.signal));
        } catch (error) {
          const failure = isLectureAcquisitionError(error) ? error.failure : safeFailure(error, providerId);
          failures.push({ ...failure, sourceId: source.sourceId });
        }
      }
      if (!evidence.length && !failures.some((failure) => failure.code === "ANALYSIS_FAILED")) failures.push(makeFailure("ANALYSIS_FAILED", "No evidence was acquired", { provider: providerId }));
      const status = evidence.length > 0 && failures.length === 0 ? "succeeded" : evidence.length > 0 ? "partial" : "failed";
      return this.validatedArtifact({ schemaVersion: 1, status, request: requestShape, sourceSet, evidence, failures, provider, ...(this.options.pipeline ? { pipeline: this.options.pipeline } : {}), startedAt: startedAt.toISOString(), completedAt: clock().toISOString() });
    } finally {
      clearTimeout(timer);
      external.removeEventListener("abort", abort);
    }
  }

  private validatedArtifact(artifact: LectureAcquisitionArtifact): LectureAcquisitionArtifact {
    const issues = validateLectureAcquisitionArtifact(artifact);
    if (issues.length) throw new LectureAcquisitionError(makeFailure("INVALID_PROVIDER_RESPONSE", `Acquisition artifact failed validation: ${issues[0]!.field}`, { provider: artifact.provider.id }));
    return artifact;
  }

  private async acquireSource(source: ResolvedVideoSource, request: LectureAcquisitionRequest, signal: AbortSignal): Promise<EvidenceSegment[]> {
    let attempts = 0;
    const providerId = this.options.providerId ?? this.options.evidenceProvider.id;
    while (true) {
      try {
        if (!this.options.evidenceProvider.supports(source)) throw new AcquisitionProviderError("UNSUPPORTED_URL", "Evidence provider does not support source", { provider: providerId, retryable: false });
        const result = await this.options.evidenceProvider.acquire(source, request, signal);
        return parseRawSegments(result.raw, source, result.provider, request.limits.maxEvidenceSegmentsPerSource);
      } catch (error) {
        attempts += 1;
        if (signal.aborted) throw new LectureAcquisitionError(makeFailure("PROVIDER_TIMEOUT", "Lecture acquisition deadline exceeded", { provider: providerId, retryable: false, attempts }));
        if (isAcquisitionProviderError(error) && error.retryable && attempts < request.limits.maxAttempts) continue;
        const failure = safeFailure(error, providerId);
        throw new LectureAcquisitionError({ ...failure, attempts });
      }
    }
  }
}

function unavailableExpander(provider: string): PlaylistExpander {
  return { async expand(parsed) { return { requested: parsed, items: [], truncated: false, failures: [{ code: "PROVIDER_AUTH_MISSING", provider, message: "YouTube provider credentials are unavailable", retryable: false, attempts: 1, severity: "error" }] }; } };
}

function unavailableEvidenceProvider(provider: string): LectureEvidenceProvider {
  return { id: provider, supports: () => true, async acquire() { throw new AcquisitionProviderError("PROVIDER_AUTH_MISSING", "Configured provider credentials are unavailable", { provider, retryable: false }); } };
}

type LectureAnalysisAdapter = LectureTextAnalysisPort & { readonly id: string; readonly model?: string };

async function createPipelineProvider(
  config: LectureResearchConfig,
  env: Record<string, string | undefined>,
  fetchImpl: typeof globalThis.fetch,
  ompRuntime: unknown,
  ompRuntimeProbe: OmpRuntimeCapabilityProbe,
): Promise<TranscribeAnalyzeEvidenceProvider> {
  if (!config.pipeline) throw new Error("pipeline configuration is required");
  const audio = new AuthorizedAudioAcquirer({
    provider: config.pipeline.audio.provider,
    command: config.pipeline.audio.commandEnv ? env[config.pipeline.audio.commandEnv] : undefined,
    inputPath: config.pipeline.audio.inputEnv ? env[config.pipeline.audio.inputEnv] : undefined,
    maxBytes: config.pipeline.audio.maxBytes,
    maxDurationSeconds: config.pipeline.audio.maxDurationSeconds,
    timeoutMs: config.pipeline.audio.timeoutMs,
  });
  const preprocess = new BoundedAudioPreprocessor({ ffmpegPath: env[config.pipeline.audio.ffmpegEnv ?? "FFMPEG_BIN"] });
  const asr = config.pipeline.asr.provider === "whisper-local"
    ? new WhisperLocalAsr({ binaryPath: env[config.pipeline.asr.binaryEnv ?? ""] ?? "", modelPath: env[config.pipeline.asr.modelPathEnv ?? ""] ?? "", model: config.pipeline.asr.model, maxOutputBytes: config.limits.maxResponseBytes, maxTranscriptCharacters: config.limits.maxTranscriptCharacters ?? 250_000, maxSegments: config.limits.maxTranscriptSegments, timeoutMs: config.limits.deadlineMs })
    : config.pipeline.asr.provider === "openrouter-native"
      ? new OpenRouterNativeAsr({ endpoint: config.pipeline.asr.endpoint ?? "", apiKeyEnv: config.pipeline.asr.apiKeyEnv ?? "", env, model: config.pipeline.asr.model, maxInputBytes: config.pipeline.asr.maxInputBytes ?? config.limits.maxAudioBytes, maxRequestBytes: config.pipeline.asr.maxRequestBytes, maxResponseBytes: config.limits.maxResponseBytes, maxTranscriptCharacters: config.limits.maxTranscriptCharacters ?? 250_000, maxSegments: config.limits.maxTranscriptSegments, maxChunkCharacters: config.limits.maxChunkCharacters, maxDurationSeconds: config.limits.maxDurationSeconds, chunkDurationSeconds: config.pipeline.asr.chunkDurationSeconds, chunkTimeoutMs: config.pipeline.asr.chunkTimeoutMs, fetch: fetchImpl })
      : new HostedAsr({ endpoint: config.pipeline.asr.endpoint ?? "", trust: config.pipeline.asr.trust ?? "trusted-remote", apiKeyEnv: config.pipeline.asr.apiKeyEnv ?? "", env, model: config.pipeline.asr.model ?? "whisper-1", maxResponseBytes: config.limits.maxResponseBytes, maxTranscriptCharacters: config.limits.maxTranscriptCharacters ?? 250_000, maxSegments: config.limits.maxTranscriptSegments, fetch: fetchImpl });
  let preflightError: AcquisitionProviderError | undefined;
  if (config.pipeline.asr.provider === "openrouter-native" && !env[config.pipeline.asr.apiKeyEnv ?? ""]) {
    preflightError = new AcquisitionProviderError("PROVIDER_AUTH_MISSING", "OpenRouter ASR credentials are unavailable", { provider: asr.id, retryable: false });
  }
  const makeAnalysis = (analysisConfig: NonNullable<LectureResearchConfig["pipeline"]>["analysis"]): LectureAnalysisAdapter => analysisConfig.provider === "ollama" || analysisConfig.provider === "vllm"
    ? new LocalTextAnalysis({ endpoint: analysisConfig.endpoint, provider: analysisConfig.provider, model: analysisConfig.model, env, maxResponseBytes: config.limits.maxAnalysisOutputBytes ?? config.limits.maxResponseBytes, maxTranscriptCharacters: config.limits.maxTranscriptCharacters ?? 250_000, maxEvidenceSegments: config.limits.maxEvidenceSegmentsPerSource, maxOutputTokens: analysisConfig.maxOutputTokens, fetch: fetchImpl })
    : new OpenAICompatibleTextAnalysis({ endpoint: analysisConfig.endpoint, trust: analysisConfig.trust, provider: analysisConfig.provider, model: analysisConfig.model, apiKeyEnv: analysisConfig.apiKeyEnv, env, maxResponseBytes: config.limits.maxAnalysisOutputBytes ?? config.limits.maxResponseBytes, maxTranscriptCharacters: config.limits.maxTranscriptCharacters ?? 250_000, maxEvidenceSegments: config.limits.maxEvidenceSegmentsPerSource, maxOutputTokens: analysisConfig.maxOutputTokens, fetch: fetchImpl });
  let analysis: LectureAnalysisAdapter = makeAnalysis(config.pipeline.analysis);
  let fallback = config.pipeline.analysis.fallback ? makeAnalysis(config.pipeline.analysis.fallback) : undefined;
  if (config.pipeline.omp?.enabled) {
    let capability: OmpRuntimeProbeResult;
    try {
      capability = await ompRuntimeProbe.probe(ompRuntime);
    } catch {
      capability = { status: "unknown" };
    }
    const ompAnalysis = new OmpTextAnalysis({
      model: config.pipeline.omp.role,
      maxResponseBytes: config.limits.maxAnalysisOutputBytes ?? config.limits.maxResponseBytes,
      maxEvidenceSegments: config.limits.maxEvidenceSegmentsPerSource,
      ...(capability.status === "available" ? { invoker: capability.invoke } : {}),
    });
    analysis = ompAnalysis;
    fallback = config.pipeline.analysis.fallback ? makeAnalysis(config.pipeline.analysis.fallback) : undefined;
    if (capability.status !== "available" && !preflightError) {
      preflightError = new AcquisitionProviderError("OMP_RUNTIME_UNAVAILABLE", "Configured OMP runtime is not callable", { provider: "omp-runtime", retryable: false });
    }
  }
  const asrMetadata = { id: asr.id, ...(asr.model ? { model: asr.model } : {}), ...(config.pipeline.asr.timestampMode ? { timestampMode: config.pipeline.asr.timestampMode } : {}) };
  return new TranscribeAnalyzeEvidenceProvider({ media: audio, preprocess, asr, analysis, fallbackAnalysis: fallback, preflightError, pipelineMetadata: { media: { id: "authorized-audio", mode: "owned-audio" }, asr: asrMetadata, analysis: { id: analysis.id, ...(analysis.model ? { model: analysis.model } : {}) } } });
}

export interface LectureAcquisitionServiceOverrides {
  fetch?: typeof globalThis.fetch;
  ompRuntime?: unknown;
  ompRuntimeProbe?: OmpRuntimeCapabilityProbe;
}

export async function createDefaultLectureAcquisitionService(cwd: string, env: Record<string, string | undefined> = process.env, overrides: LectureAcquisitionServiceOverrides = {}): Promise<YouTubeLectureAcquisitionService> {
  const config = await loadLectureResearchConfig(cwd, env);
  const fetchImpl = overrides.fetch ?? globalThis.fetch;
  const youtubeKey = env[config.youtube.apiKeyEnv];
  const playlistExpander: PlaylistExpander = youtubeKey
    ? new YouTubePlaylistExpander({ fetch: fetchImpl, apiKey: youtubeKey, endpoint: config.youtube.endpoint, maxResponseBytes: config.limits.maxResponseBytes })
    : unavailableExpander("youtube");
  if (config.pipeline) {
    const pipeline = await createPipelineProvider(config, env, fetchImpl, overrides.ompRuntime, overrides.ompRuntimeProbe ?? new DefaultOmpRuntimeCapabilityProbe());
    return new YouTubeLectureAcquisitionService({ parser: { parse: parseYouTubeUrl }, playlistExpander, evidenceProvider: pipeline, providerId: "lecture-pipeline", pipeline: pipeline.pipelineMetadata });
  }
  const geminiKey = env[config.gemini.apiKeyEnv];
  const evidenceProvider = geminiKey
    ? new GeminiYouTubeProvider({ fetch: fetchImpl, apiKey: geminiKey, model: config.gemini.model ?? "gemini-2.5-flash", endpoint: config.gemini.endpoint, maxResponseBytes: config.limits.maxResponseBytes })
    : unavailableEvidenceProvider("gemini-youtube");
  return new YouTubeLectureAcquisitionService({ parser: { parse: parseYouTubeUrl }, playlistExpander, evidenceProvider, providerId: evidenceProvider.id, model: config.gemini.model });
}
