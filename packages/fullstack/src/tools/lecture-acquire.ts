import { readArtifact, resolveState, writeArtifact } from "@andvl1/omp-workflows-core";
import { createDefaultLectureAcquisitionService, isLectureAcquisitionError } from "../lecture-acquisition/service.js";
import { loadLectureResearchConfig } from "../lecture-acquisition/config.js";

type ToolContext = unknown;
type Pi = { registerTool: (definition: any) => void };
type Z = { object(shape: Record<string, unknown>): unknown };
type Callbacks = { resolveSessionCwd(ctx: unknown): string | undefined; isMainSessionContext(ctx: unknown): boolean };
const contextSignal = (ctx: unknown): AbortSignal | undefined => {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return undefined;
  const signal = (ctx as Record<string, unknown>).signal;
  return signal && typeof signal === "object" ? signal as AbortSignal : undefined;
};
const field = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !(key in value)) return undefined;
  const record = value as Record<string, unknown>;
  return record[key];
};
type Result = Record<string, unknown>;
const fail = (code: string, error?: string): Result => ({ ok: false, code, ...(error ? { error } : {}) });
const MAX_LECTURE_TASK_LENGTH = 16_384;

export function registerLectureAcquireTool(pi: Pi, z: Z, callbacks: Callbacks): void {
  pi.registerTool({ name: "lecture_acquire", label: "Acquire lecture evidence", description: "Acquire public YouTube evidence from a URL and natural-language prompt. Uses automatic public video analysis and never asks for transcripts, media, or captions. The empty parameter object is intentional: this tool reads the URL and prompt from lecture_intake.", parameters: z.object({}), async execute(_id: string, _params: unknown, signal?: AbortSignal, _update?: unknown, ctx?: ToolContext) {
    let value: Result;
    try {
      if (!callbacks.isMainSessionContext(ctx)) value = fail("WORKFLOW_CONTEXT_REJECTED");
      else {
        const cwd = callbacks.resolveSessionCwd(ctx);
        if (!cwd) value = fail("WORKFLOW_STATE_UNAVAILABLE");
        else {
          const resolved = resolveState(cwd);
          const state = resolved.state;
          if (resolved.invalid) value = fail("WORKFLOW_STATE_INVALID");
          else if (!state || !resolved.artifactsDir) value = fail("WORKFLOW_STATE_UNAVAILABLE");
          else if (field(field(state, "classification"), "workflow") !== "lecture-research") value = fail("WORKFLOW_NOT_LECTURE_RESEARCH");
          else if (field(state, "stage_cursor") !== "acquisition") value = fail("WORKFLOW_STAGE_REJECTED");
          else {
            const intake = readArtifact(resolved.artifactsDir, "lecture_intake");
            const taskValue = field(intake, "task");
            const sources = field(intake, "sources");
            const task = typeof taskValue === "string" ? taskValue.trim() : "";
            if (!intake || !task || task.length > MAX_LECTURE_TASK_LENGTH || !Array.isArray(sources) || sources.length !== 1) value = fail("LECTURE_INTAKE_INVALID");
            else {
              const source = sources[0];
              const locationValue = field(source, "location");
              const kind = field(source, "kind");
              const location = typeof locationValue === "string" ? locationValue.trim() : "";
              if (!location || typeof kind !== "string" || !["url", "video", "playlist"].includes(kind)) value = fail("LECTURE_SOURCE_UNSUPPORTED");
              else {
                const config = await loadLectureResearchConfig(cwd);
                const request = { sourceUrl: location, prompt: task, limits: config.limits, rights: { automatedPublicVideoAnalysisApproved: true, ownedCaptionAccessApproved: false } };
                const service = await createDefaultLectureAcquisitionService(cwd, process.env);
                const artifact = await service.acquire(request, signal ?? contextSignal(ctx) ?? new AbortController().signal);
                const artifactPath = writeArtifact(resolved.artifactsDir, "lecture_acquisition", artifact);
                value = { ok: artifact.status === "succeeded" || artifact.status === "partial", code: artifact.status === "succeeded" ? "ACQUISITION_COMPLETED" : artifact.status === "partial" ? "ACQUISITION_PARTIAL" : "ACQUISITION_FAILED", status: artifact.status, artifact_id: "lecture_acquisition", source_count: artifact.sourceSet.items.length, evidence_count: artifact.evidence.length, failure_count: artifact.failures.length, artifact_path: artifactPath };
              }
            }
          }
        }
      }
    } catch (error) {
      if (isLectureAcquisitionError(error)) {
        const failure = error.failure;
        value = ["INVALID_URL", "UNSUPPORTED_URL"].includes(failure.code) ? fail(failure.code, failure.message) : fail("WORKFLOW_ACQUISITION_FAILED", "Lecture acquisition failed");
      } else value = fail("WORKFLOW_ACQUISITION_FAILED", "Lecture acquisition failed");
    }
    return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
  }});
}
