import { readFile } from "node:fs/promises";
import type { AcquisitionLimits } from "@andvl1/omp-workflows-core";
import { DEFAULT_ACQUISITION_LIMITS, HARD_ACQUISITION_LIMITS, normalizeAcquisitionLimits } from "@andvl1/omp-workflows-core";
import { validateEndpoint, type EndpointTrust } from "./endpoint-policy.js";
import {
  OPENROUTER_NATIVE_ASR_DEFAULT_MAX_REQUEST_BYTES,
  OPENROUTER_NATIVE_ASR_HARD_MAX_REQUEST_BYTES,
  OPENROUTER_NATIVE_ASR_MODEL,
} from "./asr-openrouter.js";
export interface LectureResearchProviderConfig {
  provider: string;
  model?: string;
  endpoint?: string;
  apiKeyEnv: string;
}

export interface AuthorizedAudioConfig {
  provider: "authorized-command" | "existing-input";
  commandEnv?: string;
  inputEnv?: string;
  ffmpegEnv?: string;
  maxBytes: number;
  maxDurationSeconds?: number;
  timeoutMs: number;
}

export interface LectureAsrConfig {
  provider: "whisper-local" | "hosted-openai-compatible" | "openrouter-native";
  model?: string;
  binaryEnv?: string;
  modelPathEnv?: string;
  endpoint?: string;
  trust?: EndpointTrust;
  apiKeyEnv?: string;
  transport?: "json-base64";
  timestampMode?: "estimated";
  maxInputBytes?: number;
  maxRequestBytes?: number;
  chunkDurationSeconds?: number;
  chunkTimeoutMs?: number;

}

export interface LectureAnalysisConfig {
  provider: "openai-compatible" | "ollama" | "vllm";
  model: string;
  endpoint: string;
  trust: EndpointTrust;
  apiKeyEnv?: string;
  maxOutputTokens?: number;
  fallback?: LectureAnalysisConfig;
}

export interface LecturePipelineConfig {
  mode: "transcribe-analyze";
  audio: AuthorizedAudioConfig;
  asr: LectureAsrConfig;
  analysis: LectureAnalysisConfig;
  omp?: { enabled: boolean; role?: string };
}

export interface LectureResearchConfig {
  limits: AcquisitionLimits;
  youtube: LectureResearchProviderConfig;
  gemini: LectureResearchProviderConfig;
  pipeline?: LecturePipelineConfig;
}

const defaultsLimits: AcquisitionLimits = Object.freeze({ ...DEFAULT_ACQUISITION_LIMITS });
export const defaultLectureResearchConfig: LectureResearchConfig = Object.freeze({
  limits: defaultsLimits,
  youtube: Object.freeze({ provider: "youtube", endpoint: "https://www.googleapis.com/youtube/v3", apiKeyEnv: "YOUTUBE_DATA_API_KEY" }),
  gemini: Object.freeze({ provider: "gemini", model: "gemini-2.5-flash", endpoint: "https://generativelanguage.googleapis.com", apiKeyEnv: "GEMINI_API_KEY" }),
});

export class LectureResearchConfigError extends Error {
  constructor(message = "Invalid lecture research configuration") {
    super(message);
    this.name = "LectureResearchConfigError";
  }
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n\u0000-\u001f\u007f]/.test(value)) {
    throw new LectureResearchConfigError(`Invalid ${name}`);
  }
  return value;
}

function envName(value: unknown, name: string): string {
  const result = boundedString(value, name, 128);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(result)) throw new LectureResearchConfigError(`Invalid ${name}`);
  return result;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LectureResearchConfigError(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

function ensureKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new LectureResearchConfigError(`Invalid configuration field: ${name}.${key}`);
}
function openRouterEndpoint(value: unknown, name: string): string {
  const endpoint = endpointRoot(value, name, "trusted-remote", "openrouter");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new LectureResearchConfigError(`Invalid ${name}.endpoint`);
  }
  if (parsed.port || parsed.hostname.toLowerCase() !== "openrouter.ai" || parsed.pathname !== "/api/v1") {
    throw new LectureResearchConfigError(`Invalid ${name}.endpoint`);
  }
  return endpoint;
}

function endpointRoot(value: unknown, name: string, trust: EndpointTrust, provider: string, officialHost?: "youtube" | "gemini"): string {
  const endpoint = boundedString(value, `${name}.endpoint`, 2_048);
  try {
    return validateEndpoint(endpoint, { trust, provider, officialHost }).url.toString().replace(/\/$/, "");
  } catch {
    throw new LectureResearchConfigError(`Invalid ${name}.endpoint`);
  }
}

function parseLegacyProvider(value: unknown, fallback: LectureResearchProviderConfig, name: "youtube" | "gemini"): LectureResearchProviderConfig {
  if (value === undefined) return fallback;
  const object = objectValue(value, name);
  ensureKeys(object, ["provider", "model", "endpoint", "apiKeyEnv"], name);
  const provider = object.provider === undefined ? fallback.provider : boundedString(object.provider, `${name}.provider`, 64);
  const apiKeyEnv = object.apiKeyEnv === undefined ? fallback.apiKeyEnv : envName(object.apiKeyEnv, `${name}.apiKeyEnv`);
  const result: LectureResearchProviderConfig = { provider, apiKeyEnv };
  if (object.model !== undefined) result.model = boundedString(object.model, `${name}.model`, 256);
  const endpoint = object.endpoint === undefined ? fallback.endpoint : object.endpoint;
  if (endpoint !== undefined) result.endpoint = endpointRoot(endpoint, name, "official-google", provider, name);
  return result;
}

function parseNumber(value: unknown, name: string, maximum: number, minimum = 1): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new LectureResearchConfigError(`Invalid ${name}`);
  }
  return value;
}

function parseLimits(value: unknown): AcquisitionLimits {
  if (value === undefined) return { ...defaultsLimits };
  const object = objectValue(value, "limits");
  const allowed = Object.keys(defaultsLimits).concat("maxDurationSeconds");
  ensureKeys(object, allowed, "limits");
  const result: AcquisitionLimits = { ...defaultsLimits };
  for (const key of allowed) {
    if (object[key] === undefined) continue;
    const maximum = HARD_ACQUISITION_LIMITS[key as keyof typeof HARD_ACQUISITION_LIMITS];
    if (maximum === undefined) throw new LectureResearchConfigError(`Invalid limits.${key}`);
    result[key as keyof AcquisitionLimits] = parseNumber(object[key], `limits.${key}`, maximum) as never;
  }
  try {
    return normalizeAcquisitionLimits(result, result);
  } catch {
    throw new LectureResearchConfigError("Invalid acquisition limits");
  }
}

function parseAudio(value: unknown): AuthorizedAudioConfig {
  const object = objectValue(value, "pipeline.audio");
  ensureKeys(object, ["provider", "commandEnv", "inputEnv", "ffmpegEnv", "maxBytes", "maxDurationSeconds", "timeoutMs"], "pipeline.audio");
  const provider = object.provider === "authorized-command" || object.provider === "existing-input" ? object.provider : undefined;
  if (!provider) throw new LectureResearchConfigError("Invalid pipeline.audio.provider");
  const maxBytes = parseNumber(object.maxBytes ?? defaultsLimits.maxAudioBytes, "pipeline.audio.maxBytes", HARD_ACQUISITION_LIMITS.maxAudioBytes);
  const timeoutMs = parseNumber(object.timeoutMs ?? defaultsLimits.deadlineMs, "pipeline.audio.timeoutMs", HARD_ACQUISITION_LIMITS.deadlineMs);
  const result: AuthorizedAudioConfig = { provider, maxBytes, timeoutMs };
  if (object.maxDurationSeconds !== undefined) result.maxDurationSeconds = parseNumber(object.maxDurationSeconds, "pipeline.audio.maxDurationSeconds", HARD_ACQUISITION_LIMITS.maxDurationSeconds);
  if (object.ffmpegEnv !== undefined) result.ffmpegEnv = envName(object.ffmpegEnv, "pipeline.audio.ffmpegEnv");
  if (provider === "authorized-command") result.commandEnv = envName(object.commandEnv, "pipeline.audio.commandEnv");
  if (provider === "existing-input") result.inputEnv = envName(object.inputEnv, "pipeline.audio.inputEnv");
  return result;
}
function parseAsr(value: unknown, limits: AcquisitionLimits): LectureAsrConfig {
  const object = objectValue(value, "pipeline.asr");
  ensureKeys(object, ["provider", "model", "binaryEnv", "modelPathEnv", "endpoint", "trust", "apiKeyEnv", "transport", "timestampMode", "maxInputBytes", "maxRequestBytes", "chunkDurationSeconds", "chunkTimeoutMs"], "pipeline.asr");
  const provider = object.provider === "whisper-local" || object.provider === "hosted-openai-compatible" || object.provider === "openrouter-native" ? object.provider : undefined;
  if (!provider) throw new LectureResearchConfigError("Invalid pipeline.asr.provider");
  const result: LectureAsrConfig = { provider };
  if (provider === "openrouter-native") {
    if (object.model !== undefined && object.model !== OPENROUTER_NATIVE_ASR_MODEL) throw new LectureResearchConfigError("Invalid pipeline.asr.model");
    if (object.binaryEnv !== undefined || object.modelPathEnv !== undefined) throw new LectureResearchConfigError("OpenRouter ASR does not accept local Whisper fields");
    if (object.trust !== "trusted-remote") throw new LectureResearchConfigError("OpenRouter ASR requires trusted-remote endpoint trust");
    if (object.transport !== "json-base64") throw new LectureResearchConfigError("OpenRouter ASR requires json-base64 transport");
    if (object.timestampMode !== "estimated") throw new LectureResearchConfigError("OpenRouter ASR requires timestampMode=estimated");
    result.model = OPENROUTER_NATIVE_ASR_MODEL;
    result.transport = "json-base64";
    result.timestampMode = "estimated";
    result.trust = "trusted-remote";
    result.endpoint = openRouterEndpoint(object.endpoint, "pipeline.asr");
    result.apiKeyEnv = envName(object.apiKeyEnv, "pipeline.asr.apiKeyEnv");
    if (object.maxInputBytes !== undefined) {
      const configuredMax = limits.maxAudioBytes ?? HARD_ACQUISITION_LIMITS.maxAudioBytes;
      result.maxInputBytes = parseNumber(object.maxInputBytes, "pipeline.asr.maxInputBytes", Math.min(configuredMax, HARD_ACQUISITION_LIMITS.maxAudioBytes));
    }
    result.maxRequestBytes = parseNumber(object.maxRequestBytes ?? OPENROUTER_NATIVE_ASR_DEFAULT_MAX_REQUEST_BYTES, "pipeline.asr.maxRequestBytes", OPENROUTER_NATIVE_ASR_HARD_MAX_REQUEST_BYTES, 512);
    result.chunkDurationSeconds = parseNumber(object.chunkDurationSeconds ?? 45, "pipeline.asr.chunkDurationSeconds", 60);
    result.chunkTimeoutMs = parseNumber(object.chunkTimeoutMs ?? 60_000, "pipeline.asr.chunkTimeoutMs", 120_000);
    return result;
  }
  if (object.transport !== undefined || object.timestampMode !== undefined || object.maxInputBytes !== undefined || object.maxRequestBytes !== undefined || object.chunkDurationSeconds !== undefined || object.chunkTimeoutMs !== undefined) {
    throw new LectureResearchConfigError("Legacy ASR providers do not accept native transport fields");
  }
  if (object.model !== undefined) result.model = boundedString(object.model, "pipeline.asr.model", 256);
  if (provider === "whisper-local") {
    result.binaryEnv = envName(object.binaryEnv ?? "WHISPER_CPP_BIN", "pipeline.asr.binaryEnv");
    result.modelPathEnv = envName(object.modelPathEnv ?? "WHISPER_CPP_MODEL_PATH", "pipeline.asr.modelPathEnv");
    if (object.endpoint !== undefined || object.trust !== undefined || object.apiKeyEnv !== undefined) throw new LectureResearchConfigError("Local Whisper does not accept an endpoint or API key");
  } else {
    const trust = object.trust === "trusted-remote" || object.trust === "local-loopback" ? object.trust : undefined;
    if (!trust) throw new LectureResearchConfigError("Hosted ASR requires explicit endpoint trust");
    result.trust = trust;
    result.endpoint = endpointRoot(object.endpoint, "pipeline.asr", trust, "hosted-asr");
    if (trust === "trusted-remote") result.apiKeyEnv = envName(object.apiKeyEnv, "pipeline.asr.apiKeyEnv");
    else if (object.apiKeyEnv !== undefined) result.apiKeyEnv = envName(object.apiKeyEnv, "pipeline.asr.apiKeyEnv");
  }
  return result;
}

function parseAnalysis(value: unknown, name = "pipeline.analysis", allowFallback = true): LectureAnalysisConfig {
  const object = objectValue(value, name);
  ensureKeys(object, ["provider", "model", "endpoint", "trust", "apiKeyEnv", "maxOutputTokens", "fallback"], name);
  const provider = object.provider === "openai-compatible" || object.provider === "ollama" || object.provider === "vllm" ? object.provider : undefined;
  if (!provider) throw new LectureResearchConfigError(`Invalid ${name}.provider`);
  const trust = object.trust === "trusted-remote" || object.trust === "local-loopback" ? object.trust : undefined;
  if (!trust) throw new LectureResearchConfigError(`Invalid ${name}.trust`);
  if (trust === "local-loopback" && provider !== "ollama" && provider !== "vllm") throw new LectureResearchConfigError(`${name} local endpoints must use ollama or vllm`);
  if (trust === "trusted-remote" && provider !== "openai-compatible") throw new LectureResearchConfigError(`${name} remote endpoints must use openai-compatible`);
  const result: LectureAnalysisConfig = {
    provider,
    model: boundedString(object.model, `${name}.model`, 256),
    endpoint: endpointRoot(object.endpoint, name, trust, provider),
    trust,
  };
  if (trust === "trusted-remote") result.apiKeyEnv = envName(object.apiKeyEnv, `${name}.apiKeyEnv`);
  else if (object.apiKeyEnv !== undefined) result.apiKeyEnv = envName(object.apiKeyEnv, `${name}.apiKeyEnv`);
  if (object.maxOutputTokens !== undefined) result.maxOutputTokens = parseNumber(object.maxOutputTokens, `${name}.maxOutputTokens`, 32_000);
  if (allowFallback && object.fallback !== undefined) result.fallback = parseAnalysis(object.fallback, `${name}.fallback`, false);
  return result;
}

function parsePipeline(value: unknown, limits: AcquisitionLimits): LecturePipelineConfig {
  const object = objectValue(value, "pipeline");
  ensureKeys(object, ["mode", "audio", "asr", "analysis", "omp"], "pipeline");
  if (object.mode !== "transcribe-analyze") throw new LectureResearchConfigError("pipeline.mode must be transcribe-analyze");
  const result: LecturePipelineConfig = { mode: "transcribe-analyze", audio: parseAudio(object.audio), asr: parseAsr(object.asr, limits), analysis: parseAnalysis(object.analysis) };
  if (object.omp !== undefined) {
    const omp = objectValue(object.omp, "pipeline.omp");
    ensureKeys(omp, ["enabled", "role"], "pipeline.omp");
    if (typeof omp.enabled !== "boolean") throw new LectureResearchConfigError("Invalid pipeline.omp.enabled");
    result.omp = { enabled: omp.enabled, ...(omp.role === undefined ? {} : { role: boundedString(omp.role, "pipeline.omp.role", 128) }) };
  }
  return result;
}

export async function loadLectureResearchConfig(cwd: string, _env: Record<string, string | undefined> = process.env): Promise<LectureResearchConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(`${cwd}/.omp/lecture-research.json`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultLectureResearchConfig;
    throw new LectureResearchConfigError("Invalid lecture research configuration file");
  }
  const root = objectValue(parsed, "configuration");
  ensureKeys(root, ["limits", "youtube", "gemini", "pipeline"], "configuration");
  const result: LectureResearchConfig = {
    limits: parseLimits(root.limits),
    youtube: parseLegacyProvider(root.youtube, defaultLectureResearchConfig.youtube, "youtube"),
    gemini: parseLegacyProvider(root.gemini, defaultLectureResearchConfig.gemini, "gemini"),
  };
  if (root.pipeline !== undefined) result.pipeline = parsePipeline(root.pipeline, result.limits);
  return Object.freeze(result);
}

export { HARD_ACQUISITION_LIMITS };
