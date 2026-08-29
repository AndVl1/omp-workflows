import type { LectureAcquisitionRequest, ResolvedVideoSource, TimestampedTranscriptSegment } from "@andvl1/omp-workflows-core";
import { OpenAICompatibleTextAnalysis, type OpenAICompatibleTextOptions } from "./text-analysis.js";

export interface LocalTextAnalysisOptions extends Omit<OpenAICompatibleTextOptions, "trust" | "provider" | "apiKeyEnv"> {
  provider: "ollama" | "vllm";
}

export class LocalTextAnalysis extends OpenAICompatibleTextAnalysis {
  constructor(options: LocalTextAnalysisOptions) {
    super({ ...options, trust: "local-loopback", provider: options.provider });
  }

  override async analyze(input: { source: ResolvedVideoSource; prompt: string; transcript: readonly TimestampedTranscriptSegment[] }, request: LectureAcquisitionRequest, signal: AbortSignal) {
    return super.analyze(input, request, signal);
  }
}

export function createLocalTextAnalysis(options: LocalTextAnalysisOptions): LocalTextAnalysis {
  return new LocalTextAnalysis(options);
}
