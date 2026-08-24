import { readFile } from "node:fs/promises";
import type { AcquisitionLimits } from "@andvl1/omp-workflows-core";
import { DEFAULT_ACQUISITION_LIMITS, HARD_ACQUISITION_LIMITS } from "@andvl1/omp-workflows-core";

export interface LectureResearchProviderConfig {
  provider: string;
  model?: string;
  endpoint?: string;
  apiKeyEnv: string;
}

export interface LectureResearchConfig {
  limits: AcquisitionLimits;
  youtube: LectureResearchProviderConfig;
  gemini: LectureResearchProviderConfig;
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

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const boundedString = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n]/.test(value)) throw new LectureResearchConfigError(`Invalid ${name}`);
  return value;
};
const envName = (value: unknown, name: string): string => {
  const result = boundedString(value, name, 128);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(result)) throw new LectureResearchConfigError(`Invalid ${name}`);
  return result;
};

function provider(value: unknown, fallback: LectureResearchProviderConfig, name: string): LectureResearchProviderConfig {
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LectureResearchConfigError(`Invalid ${name}`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!["provider", "model", "endpoint", "apiKeyEnv"].includes(key)) throw new LectureResearchConfigError(`Invalid ${name}`);
  const result: LectureResearchProviderConfig = { provider: object.provider === undefined ? fallback.provider : boundedString(object.provider, `${name}.provider`, 64), apiKeyEnv: object.apiKeyEnv === undefined ? fallback.apiKeyEnv : envName(object.apiKeyEnv, `${name}.apiKeyEnv`) };
  if (object.model !== undefined) result.model = boundedString(object.model, `${name}.model`, 128);
  if (object.endpoint !== undefined) {
    const endpoint = boundedString(object.endpoint, `${name}.endpoint`, 512);
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { throw new LectureResearchConfigError(`Invalid ${name}.endpoint`); }
    const expectedHostname = name === "youtube" ? "www.googleapis.com" : "generativelanguage.googleapis.com";
    const authority = /^https:\/\/([^/?#]*)/i.exec(endpoint)?.[1] ?? "";
    const authorityHost = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== expectedHostname ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      authorityHost.includes(":") ||
      parsed.hash
    ) throw new LectureResearchConfigError(`Invalid ${name}.endpoint`);
    result.endpoint = parsed.toString().replace(/\/$/, "");
  }
  return result;
}

export async function loadLectureResearchConfig(cwd: string, _env: Record<string, string | undefined> = process.env): Promise<LectureResearchConfig> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(`${cwd}/.omp/lecture-research.json`, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultLectureResearchConfig;
    throw new LectureResearchConfigError("Invalid lecture research configuration file");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new LectureResearchConfigError();
  const root = parsed as Record<string, unknown>;
  for (const key of Object.keys(root)) if (!["limits", "youtube", "gemini"].includes(key)) throw new LectureResearchConfigError(`Invalid configuration field: ${key}`);
  let limits: AcquisitionLimits;
  try {
    const raw = root.limits;
    if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new Error();
    if (raw && typeof raw === "object") {
      const object = raw as Record<string, unknown>;
      for (const key of Object.keys(object)) if (!(key in defaultsLimits) && key !== "maxDurationSeconds") throw new Error();
      for (const key of Object.keys(object)) {
        const value = object[key];
        const hard = HARD_ACQUISITION_LIMITS[key as keyof typeof HARD_ACQUISITION_LIMITS];
        if (hard === undefined || typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > hard) throw new Error();
      }
      limits = {
        ...defaultsLimits,
        ...(object.maxItems === undefined ? {} : { maxItems: object.maxItems as number }),
        ...(object.maxPages === undefined ? {} : { maxPages: object.maxPages as number }),
        ...(object.maxDurationSeconds === undefined ? {} : { maxDurationSeconds: object.maxDurationSeconds as number }),
        ...(object.deadlineMs === undefined ? {} : { deadlineMs: object.deadlineMs as number }),
        ...(object.maxAttempts === undefined ? {} : { maxAttempts: object.maxAttempts as number }),
        ...(object.maxResponseBytes === undefined ? {} : { maxResponseBytes: object.maxResponseBytes as number }),
        ...(object.maxEvidenceSegmentsPerSource === undefined ? {} : { maxEvidenceSegmentsPerSource: object.maxEvidenceSegmentsPerSource as number }),
      };
    } else limits = { ...defaultsLimits };
  } catch { throw new LectureResearchConfigError("Invalid acquisition limits"); }
  return Object.freeze({ limits, youtube: provider(root.youtube, defaultLectureResearchConfig.youtube, "youtube"), gemini: provider(root.gemini, defaultLectureResearchConfig.gemini, "gemini") });
}

export { HARD_ACQUISITION_LIMITS };
