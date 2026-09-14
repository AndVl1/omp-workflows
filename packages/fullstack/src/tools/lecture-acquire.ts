import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { CtoRuntimeAccessFacade } from "@andvl1/omp-workflows-core/cto-runtime";
import {
  PinnedProjectRoot,
  PinnedRootError,
  readPinnedArtifactSnapshot,
  resolveStatePinnedActive,
  validateLectureAcquisitionArtifact,
  writeArtifactPinned,
  lectureAcquisitionRequestDigest,
  lectureRightsProjection,
  lectureRightsDigest,
  type LectureAcquisitionArtifact,
  type LectureAcquisitionRequest,
  type LectureAcquisitionValidationContext,
} from "@andvl1/omp-workflows-core";
import { createDefaultLectureAcquisitionService, isLectureAcquisitionError } from "../lecture-acquisition/service.js";
import { loadLectureResearchConfig, LectureResearchConfigError } from "../lecture-acquisition/config.js";

type ToolContext = unknown;
type Pi = Pick<ExtensionAPI, "registerTool">;
type Z = { object(shape: Record<string, unknown>): TSchema };
type LectureAcquisitionService = {
  acquire(request: LectureAcquisitionRequest, signal: AbortSignal): Promise<LectureAcquisitionArtifact>;
};
type Callbacks = {
  resolveSessionCwd(ctx: unknown): string | undefined;
  isMainSessionContext(ctx: unknown): boolean;
  /** Production mount guard: authenticates main-session root + live owner context. */
  ensureLiveActivation?: (ctx: unknown, cwd: string) => { cwd: string; runtimeAccess?: CtoRuntimeAccessFacade } | null;
  createLectureAcquisitionService?: (
    cwd: string,
    env: Record<string, string | undefined>,
    pinnedRoot: PinnedProjectRoot,
  ) => LectureAcquisitionService | Promise<LectureAcquisitionService>;
};
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

type OperationAuthority = {
  featureId: string;
  featureRunKey: string;
  workflow: string;
  stageId: string;
  cursorEpoch: string;
};

function operationAuthority(state: unknown): OperationAuthority | null {
  const featureId = field(field(state, "specification"), "feature_id");
  const featureRunKey = field(state, "run_key");
  const workflow = field(field(state, "classification"), "workflow");
  const stageId = field(state, "stage_cursor");
  const cursorEpoch = field(state, "cursor_epoch");
  if (typeof featureId !== "string" || featureId.length === 0
    || typeof featureRunKey !== "string" || featureRunKey.length === 0
    || typeof workflow !== "string" || workflow.length === 0
    || typeof stageId !== "string" || stageId.length === 0
    || typeof cursorEpoch !== "string" || cursorEpoch.length === 0) return null;
  return { featureId, featureRunKey, workflow, stageId, cursorEpoch };
}

function sameAuthority(left: OperationAuthority, right: OperationAuthority): boolean {
  return left.featureId === right.featureId
    && left.featureRunKey === right.featureRunKey
    && left.workflow === right.workflow
    && left.stageId === right.stageId
    && left.cursorEpoch === right.cursorEpoch;
}

function intakeRights(intake: unknown, source: unknown): LectureAcquisitionRequest["rights"] {
  const value = field(intake, "rights") ?? field(source, "rights");
  return {
    automatedPublicVideoAnalysisApproved: field(value, "automatedPublicVideoAnalysisApproved") === true,
    ownedCaptionAccessApproved: field(value, "ownedCaptionAccessApproved") === true,
    ownedMediaAudioAccessApproved: field(value, "ownedMediaAudioAccessApproved") === true,
    ownedMediaAccessApproved: field(value, "ownedMediaAccessApproved") === true,
    externalTranscriptAnalysisApproved: field(value, "externalTranscriptAnalysisApproved") === true,
  };
}

function boundLectureArtifact(
  artifact: LectureAcquisitionArtifact,
  authority: OperationAuthority,
  intakeSchemaVersion: 1,
  intakeContentSha256: string,
  request: LectureAcquisitionRequest,
): LectureAcquisitionArtifact {
  const rights = lectureRightsProjection(request.rights, request.mediaMode);
  const binding = {
    featureId: authority.featureId,
    featureRunKey: authority.featureRunKey,
    stageId: authority.stageId,
    cursorEpoch: authority.cursorEpoch,
    intakeArtifactId: "lecture_intake" as const,
    intakeSchemaVersion,
    intakeContentSha256,
    requestSha256: lectureAcquisitionRequestDigest(request),
    rightsMode: rights.mode,
    rightsSha256: lectureRightsDigest(request.rights, request.mediaMode),
  };
  const bound: LectureAcquisitionArtifact = { ...artifact, schemaVersion: 2, binding };
  const context: LectureAcquisitionValidationContext = {
    featureId: authority.featureId,
    featureRunKey: authority.featureRunKey,
    stageId: authority.stageId,
    cursorEpoch: authority.cursorEpoch,
    intakeSchemaVersion,
    intakeContentSha256,
    request,
    rights: request.rights,
  };
  const issues = validateLectureAcquisitionArtifact(bound, { requireBinding: true, context });
  if (issues.length > 0) throw new LectureResearchConfigError("Lecture acquisition artifact failed bound validation");
  return bound;
}

export function registerLectureAcquireTool(pi: Pi, z: Z, callbacks: Callbacks): void {
  pi.registerTool({ name: "lecture_acquire", label: "Acquire lecture evidence", description: "Acquire bounded lecture evidence from the single URL and prompt in lecture_intake. Rights and media mode are read explicitly from intake; absent approval is metadata-only/fail-closed.", parameters: z.object({}), async execute(_id: string, _params: unknown, signal?: AbortSignal, _update?: unknown, ctx?: ToolContext) {
    let value: Result;
    try {
      if (!callbacks.isMainSessionContext(ctx)) value = fail("WORKFLOW_CONTEXT_REJECTED");
      else {
        const requestedCwd = callbacks.resolveSessionCwd(ctx);
        const live = requestedCwd && callbacks.ensureLiveActivation
          ? callbacks.ensureLiveActivation(ctx, requestedCwd)
          : requestedCwd ? { cwd: requestedCwd } : null;
        const cwd = live?.cwd;
        if (!cwd) value = fail("WORKFLOW_STATE_UNAVAILABLE");
        else {
          const pinnedRoot = PinnedProjectRoot.open(cwd);
          if (!pinnedRoot) value = fail("WORKFLOW_STATE_UNAVAILABLE");
          else {
            try {
              const resolved = resolveStatePinnedActive(cwd, pinnedRoot);
              const state = resolved.state;
              const authority = operationAuthority(state);
              if (resolved.invalid || !state || !resolved.artifactsDir || !authority) value = fail("WORKFLOW_STATE_INVALID");
              else if (authority.workflow !== "lecture-research") value = fail("WORKFLOW_NOT_LECTURE_RESEARCH");
              else if (authority.stageId !== "acquisition") value = fail("WORKFLOW_STAGE_REJECTED");
              else {
                const artifactsRelative = pinnedRoot.relativePath(resolved.artifactsDir);
                if (!artifactsRelative) value = fail("WORKFLOW_STATE_INVALID");
                else {
                  const intakeSnapshot = readPinnedArtifactSnapshot(pinnedRoot, artifactsRelative, "lecture_intake");
                  const intake = intakeSnapshot.value;
                  const intakeSchemaVersion = field(intake, "schemaVersion");
                  const taskValue = field(intake, "task");
                  const sources = field(intake, "sources");
                  const task = typeof taskValue === "string" ? taskValue.trim() : "";
                  if (intakeSchemaVersion !== 1 || !task || task.length > MAX_LECTURE_TASK_LENGTH || !Array.isArray(sources) || sources.length !== 1) value = fail("LECTURE_INTAKE_INVALID");
                  else {
                    const source = sources[0];
                    const locationValue = field(source, "location");
                    const kind = field(source, "kind");
                    const location = typeof locationValue === "string" ? locationValue.trim() : "";
                    if (!location || typeof kind !== "string" || !["url", "video", "playlist"].includes(kind)) value = fail("LECTURE_SOURCE_UNSUPPORTED");
                    else {
                      const ensureLive = (): boolean => {
                        if (!pinnedRoot.isStable()) return false;
                        if (!callbacks.ensureLiveActivation) return true;
                        const current = callbacks.ensureLiveActivation(ctx, cwd);
                        if (!current || current.cwd !== cwd) return false;
                        try { current.runtimeAccess?.assertLive(); } catch { return false; }
                        return pinnedRoot.isStable();
                      };
                      const config = await loadLectureResearchConfig(cwd, process.env, { pinnedRoot });
                      if (!ensureLive()) value = fail("WORKFLOW_STATE_CHANGED");
                      else {
                        const rights = intakeRights(intake, source);
                        const modeValue = field(intake, "mediaMode");
                        const mediaMode: LectureAcquisitionRequest["mediaMode"] = modeValue === "owned-audio" ? "owned-audio" : "metadata-only";
                        const request: LectureAcquisitionRequest = { sourceUrl: location, prompt: task, limits: config.limits, mediaMode, rights };
                        const service = callbacks.createLectureAcquisitionService
                          ? await callbacks.createLectureAcquisitionService(cwd, process.env, pinnedRoot)
                          : await createDefaultLectureAcquisitionService(cwd, process.env, { ompRuntime: field(ctx, "ompRuntime"), pinnedRoot });
                        if (!ensureLive()) value = fail("WORKFLOW_STATE_CHANGED");
                        else {
                          const acquisitionController = new AbortController();
                          const sourceSignals = [signal, contextSignal(ctx)].filter((candidate): candidate is AbortSignal => Boolean(candidate));
                          const abortFromSource = (): void => { if (!acquisitionController.signal.aborted) acquisitionController.abort(); };
                          for (const sourceSignal of sourceSignals) {
                            if (sourceSignal.aborted) abortFromSource();
                            else sourceSignal.addEventListener("abort", abortFromSource, { once: true });
                          }
                          const lifecycleMonitor = setInterval(() => {
                            if (!ensureLive()) abortFromSource();
                          }, 25);
                          try {
                            if (!ensureLive()) value = fail("WORKFLOW_STATE_CHANGED");
                            else {
                              const artifact = await service.acquire(request, acquisitionController.signal);
                              if (!ensureLive()) value = fail("WORKFLOW_STATE_CHANGED");
                              else {
                                const current = resolveStatePinnedActive(cwd, pinnedRoot);
                                const currentAuthority = operationAuthority(current.state);
                                const currentArtifactsRelative = current.artifactsDir ? pinnedRoot.relativePath(current.artifactsDir) : null;
                                const currentIntake = currentArtifactsRelative ? readPinnedArtifactSnapshot(pinnedRoot, currentArtifactsRelative, "lecture_intake") : null;
                                const liveBeforeWrite = callbacks.ensureLiveActivation
                                  ? callbacks.ensureLiveActivation(ctx, cwd)
                                  : { cwd };
                                if (!liveBeforeWrite || liveBeforeWrite.cwd !== cwd) {
                                  value = fail("WORKFLOW_STATE_CHANGED");
                                } else if (current.invalid || !current.state || !currentAuthority || !sameAuthority(authority, currentAuthority) || currentArtifactsRelative !== artifactsRelative || !currentIntake || currentIntake.sha256 !== intakeSnapshot.sha256) {
                                  value = fail("WORKFLOW_STATE_CHANGED");
                                } else {
                                  const bound = boundLectureArtifact(artifact, authority, intakeSchemaVersion, intakeSnapshot.sha256, request);
                                  const artifactRelativePath = writeArtifactPinned(pinnedRoot, artifactsRelative, "lecture_acquisition", bound);
                                  if (!ensureLive()) {
                                    value = fail("WORKFLOW_STATE_CHANGED");
                                  } else {
                                    const artifactPath = pinnedRoot.anchorPath(artifactRelativePath);
                                    value = { ok: bound.status === "succeeded" || bound.status === "partial", code: bound.status === "succeeded" ? "ACQUISITION_COMPLETED" : bound.status === "partial" ? "ACQUISITION_PARTIAL" : "ACQUISITION_FAILED", status: bound.status, artifact_id: "lecture_acquisition", source_count: bound.sourceSet.items.length, evidence_count: bound.evidence.length, failure_count: bound.failures.length, artifact_path: artifactPath };
                                  }
                                }
                              }
                            }
                          } finally {
                            clearInterval(lifecycleMonitor);
                            for (const sourceSignal of sourceSignals) sourceSignal.removeEventListener("abort", abortFromSource);
                          }
                        }
                      }
                  }
                }
              }
            }
            } finally {
              pinnedRoot.close();
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof PinnedRootError || (error instanceof LectureResearchConfigError && error.code === "changed")) {
        value = fail("WORKFLOW_STATE_CHANGED");
      } else if (isLectureAcquisitionError(error)) {
        const failure = error.failure;
        value = ["INVALID_URL", "UNSUPPORTED_URL"].includes(failure.code) ? fail(failure.code, failure.message) : fail("WORKFLOW_ACQUISITION_FAILED", "Lecture acquisition failed");
      } else value = fail("WORKFLOW_ACQUISITION_FAILED", "Lecture acquisition failed");
    }
    return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
  }});
}
