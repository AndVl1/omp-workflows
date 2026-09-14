import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_ACQUISITION_LIMITS,
  lectureAcquisitionRequestDigest,
  lectureRightsDigest,
  loadProfile,
  PinnedProjectRoot,
  type LectureAcquisitionArtifact,
  type LectureAcquisitionRequest,
} from "@andvl1/omp-workflows-core";
import { bindFeatureWorkspaceToRoot, validFeatureWorkspace } from "../../core/test/fixtures/specification-fixtures.js";
import { registerLectureAcquireTool } from "../src/tools/lecture-acquire.js";
import { loadLectureResearchConfig, MAX_LECTURE_RESEARCH_CONFIG_BYTES, LectureResearchConfigError } from "../src/lecture-acquisition/config.js";

const FEATURE_ID = "lecture-pinning";
const RUN_KEY = "lecture-pinning-run";
const VIDEO_ID = "dQw4w9WgXcQ";
const SOURCE_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const RIGHTS = {
  automatedPublicVideoAnalysisApproved: true,
  ownedCaptionAccessApproved: false,
  ownedMediaAudioAccessApproved: false,
  ownedMediaAccessApproved: false,
  externalTranscriptAnalysisApproved: false,
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeRoot(label: string): string {
  const parent = mkdtempSync(join(tmpdir(), `omp-${label}-`));
  const root = join(parent, "project");
  mkdirSync(root);
  return root;
}

function cleanupRoot(root: string): void {
  rmSync(dirname(root), { recursive: true, force: true });
}

function artifact(request: LectureAcquisitionRequest): LectureAcquisitionArtifact {
  return {
    schemaVersion: 1,
    status: "succeeded",
    request: {
      sourceUrl: request.sourceUrl,
      canonicalUrl: SOURCE_URL,
      sourceKind: "video",
      prompt: request.prompt,
      limits: request.limits,
    },
    sourceSet: {
      requested: { kind: "video", videoId: VIDEO_ID, canonicalUrl: SOURCE_URL },
      items: [{ sourceId: `yt-video-${VIDEO_ID}`, videoId: VIDEO_ID, canonicalUrl: SOURCE_URL }],
      truncated: false,
      failures: [],
    },
    evidence: [{
      evidenceId: sha256("evidence-1"),
      sourceId: `yt-video-${VIDEO_ID}`,
      location: SOURCE_URL,
      provider: "fixture-provider",
      kind: "transcript_excerpt",
      quote: "A bounded fixture claim",
      startSeconds: 1,
      endSeconds: 3,
    }],
    failures: [],
    provider: { id: "fixture-provider" },
    startedAt: "2026-09-06T00:00:00.000Z",
    completedAt: "2026-09-06T00:00:01.000Z",
  };
}

function writeFixture(root: string, overrides: Record<string, unknown> = {}): { intakePath: string; artifactPath: string; statePath: string } {
  const featureDir = join(root, ".work-state", "features", FEATURE_ID);
  const artifactsDir = join(featureDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(root, ".work-state", ".active-feature"), `${FEATURE_ID}\n`);
  const workspace = bindFeatureWorkspaceToRoot(validFeatureWorkspace({ featureId: FEATURE_ID, projectRoot: root, withApprovedSpecify: true }), root);
  const profile = loadProfile("lecture-research");
  if (!profile) throw new Error("lecture-research profile is unavailable");
  const state = {
    schema: 1,
    branch: "main",
    run_key: RUN_KEY,
    classification: { type: "LECTURE_RESEARCH", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lecture-research" },
    task: "acquire one bounded lecture",
    stage_cursor: "acquisition",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "acquisition" ? "in_progress" : stage.id === "intake" ? "done" : "pending" })),
    artifacts: {},
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null },
    policy: { strict_orchestrator: true },
    pause: { kind: "none", reason: "" },
    cursor_epoch: "epoch-1",
    profile_hash: "lecture-research-test-profile",
    specification: workspace,
    state_revision: 0,
    ...overrides,
  };
  const statePath = join(featureDir, "state.json");
  const intakePath = join(artifactsDir, "lecture_intake.json");
  const artifactPath = join(artifactsDir, "lecture_acquisition.json");
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  writeFileSync(intakePath, `${JSON.stringify({
    schemaVersion: 1,
    task: "compare architecture ideas",
    sources: [{ kind: "video", location: SOURCE_URL, videoId: VIDEO_ID }],
    rights: RIGHTS,
    mediaMode: "metadata-only",
  })}\n`);
  return { intakePath, artifactPath, statePath };
}

function toolFor(root: string, service: { acquire(request: LectureAcquisitionRequest, signal: AbortSignal): Promise<LectureAcquisitionArtifact> }, ensureLiveActivation?: () => { cwd: string } | null): RegisteredTool {
  let tool: RegisteredTool | undefined;
  registerLectureAcquireTool({ registerTool(definition: unknown) {
    if (!definition || typeof definition !== "object" || !("name" in definition) || !("execute" in definition)) throw new Error("invalid registered tool");
    tool = definition as RegisteredTool;
  } }, z, {
    resolveSessionCwd: () => root,
    isMainSessionContext: () => true,
    ...(ensureLiveActivation ? { ensureLiveActivation: () => ensureLiveActivation() } : {}),
    createLectureAcquisitionService: () => service,
  });
  if (!tool) throw new Error("lecture_acquire was not registered");
  return tool;
}

async function invoke(root: string, service: { acquire(request: LectureAcquisitionRequest, signal: AbortSignal): Promise<LectureAcquisitionArtifact> }, ensureLiveActivation?: () => { cwd: string } | null): Promise<Record<string, unknown>> {
  const result = await toolFor(root, service, ensureLiveActivation).execute("lecture-test", {}, undefined, undefined, { cwd: root, hasUI: true } as never);
  return result.details;
}

function gatedService(): { service: { acquire(request: LectureAcquisitionRequest, signal: AbortSignal): Promise<LectureAcquisitionArtifact> }; entered: Promise<void>; release: () => void; requests: LectureAcquisitionRequest[] } {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const requests: LectureAcquisitionRequest[] = [];
  return {
    entered,
    release: () => releaseResolve(),
    requests,
    service: { acquire: async (request) => { requests.push(request); enteredResolve(); await released; return artifact(request); } },
  };
}

function noArtifact(path: string): void {
  assert.equal(existsSync(path), false, "a rejected acquisition must not publish an artifact");
}

test("lecture_acquire never reports completion when activation revokes after publication", async () => {
  const root = makeRoot("lecture-tool-revoke-after-write");
  try {
    const paths = writeFixture(root);
    let checks = 0;
    const result = await invoke(root, {
      acquire: async (request) => artifact(request),
    }, () => {
      checks += 1;
      return checks >= 7 ? null : { cwd: root };
    });
    assert.equal(result.code, "WORKFLOW_STATE_CHANGED");
    assert.notEqual(result.code, "ACQUISITION_COMPLETED");
    assert.notEqual(result.code, "ACQUISITION_PARTIAL");
    assert.ok(existsSync(paths.artifactPath), "the write may have committed before the post-write fence");
  } finally {
    cleanupRoot(root);
  }
});

test("lecture_acquire writes a v2 identity and digest-bound artifact and exact replay is stable", async () => {
  const root = makeRoot("lecture-tool-valid");
  try {
    const paths = writeFixture(root);
    const firstService = gatedService();
    const firstPromise = invoke(root, firstService.service);
    await firstService.entered;
    firstService.release();
    const first = await firstPromise;
    assert.equal(first.code, "ACQUISITION_COMPLETED");
    const persisted = JSON.parse(readFileSync(paths.artifactPath, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.schemaVersion, 2);
    assert.deepEqual(persisted.binding, {
      featureId: FEATURE_ID,
      featureRunKey: RUN_KEY,
      stageId: "acquisition",
      cursorEpoch: "epoch-1",
      intakeArtifactId: "lecture_intake",
      intakeSchemaVersion: 1,
      intakeContentSha256: sha256(readFileSync(paths.intakePath)),
      requestSha256: lectureAcquisitionRequestDigest(firstService.requests[0]!),
      rightsMode: "metadata-only",
      rightsSha256: lectureRightsDigest(RIGHTS, "metadata-only"),
    });
    const firstBytes = readFileSync(paths.artifactPath);
    const secondService = gatedService();
    const secondPromise = invoke(root, secondService.service);
    await secondService.entered;
    secondService.release();
    const second = await secondPromise;
    assert.equal(second.code, "ACQUISITION_COMPLETED");
    assert.deepEqual(readFileSync(paths.artifactPath), firstBytes, "exact replay must publish identical bytes");
  } finally {
    cleanupRoot(root);
  }
});
test("lecture_acquire rejects unsupported persisted intake schema before provider work", async () => {
  const root = makeRoot("lecture-tool-intake-schema");
  try {
    const paths = writeFixture(root);
    const intake = JSON.parse(readFileSync(paths.intakePath, "utf8")) as Record<string, unknown>;
    intake.schemaVersion = 2;
    writeFileSync(paths.intakePath, JSON.stringify(intake));
    let called = false;
    const result = await invoke(root, {
      acquire: async () => {
        called = true;
        return artifact({ sourceUrl: SOURCE_URL, prompt: "compare architecture ideas", limits: DEFAULT_ACQUISITION_LIMITS, mediaMode: "metadata-only", rights: RIGHTS });
      },
    });
    assert.equal(result.code, "LECTURE_INTAKE_INVALID");
    assert.equal(called, false);
    noArtifact(paths.artifactPath);
  } finally {
    cleanupRoot(root);
  }
});

for (const [label, mutate] of [
  ["feature identity", (root: string) => {
    const path = join(root, ".work-state", "features", FEATURE_ID, "state.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as { specification: { feature_id: string } };
    state.specification.feature_id = "foreign-feature";
    writeFileSync(path, JSON.stringify(state));
  }],
  ["run key", (root: string) => {
    const path = join(root, ".work-state", "features", FEATURE_ID, "state.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    state.run_key = "foreign-run";
    writeFileSync(path, JSON.stringify(state));
  }],
  ["cursor epoch", (root: string) => {
    const path = join(root, ".work-state", "features", FEATURE_ID, "state.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    state.cursor_epoch = "foreign-epoch";
    writeFileSync(path, JSON.stringify(state));
  }],
  ["intake rights and request", (root: string) => {
    const path = join(root, ".work-state", "features", FEATURE_ID, "artifacts", "lecture_intake.json");
    const intake = JSON.parse(readFileSync(path, "utf8")) as { task: string; rights: Record<string, boolean> };
    intake.task = "tampered prompt";
    intake.rights.automatedPublicVideoAnalysisApproved = false;
    writeFileSync(path, JSON.stringify(intake));
  }],
  ["artifact directory", (root: string) => {
    const source = join(root, ".work-state", "features", FEATURE_ID, "artifacts");
    renameSync(source, `${source}.moved`);
    mkdirSync(source);
  }],
  ["work-state directory", (root: string) => {
    const source = join(root, ".work-state");
    renameSync(source, `${source}.moved`);
    mkdirSync(source);
  }],
  ["project root", (root: string) => {
    renameSync(root, `${root}.moved`);
    mkdirSync(root);
  }],
  ["project-root ancestor", (root: string) => {
    const parent = dirname(root);
    const moved = `${parent}-moved-${FEATURE_ID}`;
    renameSync(parent, moved);
    mkdirSync(parent);
    mkdirSync(root);
  }],
] as const) {
  test(`lecture_acquire rejects ${label} changes during provider work without writing`, async () => {
    const root = makeRoot(`lecture-tool-${label.replaceAll(" ", "-")}`);
    try {
      const paths = writeFixture(root);
      const pending = gatedService();
      const call = invoke(root, pending.service);
      await pending.entered;
      mutate(root);
      pending.release();
      const result = await call;
      assert.equal(result.code, "WORKFLOW_STATE_CHANGED", `${label} must fail with a stable state-change code`);
      noArtifact(paths.artifactPath);
    } finally {
      cleanupRoot(root);
      rmSync(`${dirname(root)}-moved-${FEATURE_ID}`, { recursive: true, force: true });
    }
  });
}

test("lecture_acquire rejects malformed and oversized provider artifacts before persistence", async () => {
  const root = makeRoot("lecture-tool-provider-bounds");
  try {
    const paths = writeFixture(root);
    for (const bad of [{}, { ...artifact({ sourceUrl: SOURCE_URL, prompt: "x", limits: { ...DEFAULT_ACQUISITION_LIMITS }, mediaMode: "metadata-only", rights: RIGHTS }), evidence: [{ quote: "x".repeat(2_000_000) }] }]) {
      const result = await invoke(root, { acquire: async () => bad as LectureAcquisitionArtifact });
      assert.equal(result.code, "WORKFLOW_ACQUISITION_FAILED");
      noArtifact(paths.artifactPath);
    }
  } finally {
    cleanupRoot(root);
  }
});
async function expectConfigError(action: () => Promise<unknown>, code: LectureResearchConfigError["code"]): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof LectureResearchConfigError);
  if (caught instanceof LectureResearchConfigError) assert.equal(caught.code, code);
}
test("lecture research config rejects FIFO, invalid UTF-8, and oversize files without blocking", async () => {
  const root = makeRoot("lecture-config-bounds");
  const pin = PinnedProjectRoot.open(root);
  assert.ok(pin);
  if (!pin) return;
  try {
    const configPath = join(root, ".omp", "lecture-research.json");
    mkdirSync(join(root, ".omp"), { recursive: true });
    execFileSync("mkfifo", [configPath]);
    await expectConfigError(() => loadLectureResearchConfig(root, {}, { pinnedRoot: pin }), "not_regular");
    rmSync(configPath);
    writeFileSync(configPath, Buffer.from([0xc3, 0x28]));
    await expectConfigError(() => loadLectureResearchConfig(root, {}, { pinnedRoot: pin }), "invalid_utf8");
    writeFileSync(configPath, Buffer.alloc(MAX_LECTURE_RESEARCH_CONFIG_BYTES + 1, 0x20));
    await expectConfigError(() => loadLectureResearchConfig(root, {}, { pinnedRoot: pin }), "limit");
  } finally {
    pin.close();
    cleanupRoot(root);
  }
});
