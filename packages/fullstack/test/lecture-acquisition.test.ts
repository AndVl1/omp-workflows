import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ACQUISITION_LIMITS,
  type LectureAcquisitionRequest,
  type LectureEvidenceProvider,
  type LectureSourceParser,
  type ParsedLectureUrl,
  type PlaylistExpander,
  type ResolvedVideoSource,
} from "@andvl1/omp-workflows-core";
import { AcquisitionProviderError } from "../src/lecture-acquisition/provider-errors.js";
import { YouTubeLectureAcquisitionService } from "../src/lecture-acquisition/service.js";

const request = (sourceUrl: string): LectureAcquisitionRequest => ({
  sourceUrl,
  prompt: "compare ideas",
  limits: { ...DEFAULT_ACQUISITION_LIMITS },
  rights: { automatedPublicVideoAnalysisApproved: true, ownedCaptionAccessApproved: false },
});
const video = (id: string): ResolvedVideoSource => ({ sourceId: `yt-video-${id}`, videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` });
const parser = (parsed: ParsedLectureUrl): LectureSourceParser => ({ parse: () => parsed });
const expander: PlaylistExpander = { async expand(parsed) { return { requested: parsed, items: [], truncated: false, failures: [] }; } };
const provider = (acquire: LectureEvidenceProvider["acquire"]): LectureEvidenceProvider => ({ id: "fake-provider", supports: () => true, acquire });
const raw = { segments: [{ quote: "A bounded claim", start_seconds: 1, end_seconds: 3, kind: "transcript_excerpt", confidence: "high" }] };

test("injected parser and provider produce canonical timestamped evidence", async () => {
  const id = "dQw4w9WgXcQ";
  const service = new YouTubeLectureAcquisitionService({
    parser: parser({ kind: "video", videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` }),
    playlistExpander: expander,
    evidenceProvider: provider(async () => ({ provider: "fake-provider", raw })),
    clock: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  const artifact = await service.acquire(request(`https://youtu.be/${id}`), new AbortController().signal);
  assert.equal(artifact.status, "succeeded");
  const secondArtifact = await service.acquire(request(`https://youtu.be/${id}`), new AbortController().signal);
  assert.deepEqual(artifact.evidence[0], { evidenceId: artifact.evidence[0].evidenceId, sourceId: `yt-video-${id}`, location: `https://www.youtube.com/watch?v=${id}`, provider: "fake-provider", kind: "transcript_excerpt", quote: "A bounded claim", startSeconds: 1, endSeconds: 3, confidence: "high" });
  assert.equal(secondArtifact.evidence[0].evidenceId, artifact.evidence[0].evidenceId);
  assert.match(artifact.evidence[0].evidenceId, /^[a-f0-9]{64}$/);
  assert.equal(artifact.startedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(artifact.completedAt, artifact.startedAt);
});

test("playlist preserves truncation and typed provider failure as partial", async () => {
  const first = video("9bZkp7q19f0"); const second = video("3JZ_D3ELwOQ");
  const parsed = { kind: "playlist" as const, playlistId: "PLfake123", canonicalUrl: "https://www.youtube.com/playlist?list=PLfake123" };
  const service = new YouTubeLectureAcquisitionService({ parser: parser(parsed), playlistExpander: { async expand() { return { requested: parsed, items: [first, second], truncated: true, failures: [] }; } }, evidenceProvider: provider(async (source) => source === first ? { provider: "fake-provider", raw } : Promise.reject(new AcquisitionProviderError("NETWORK_ERROR", "temporary", { retryable: false }))) });
  const artifact = await service.acquire(request(parsed.canonicalUrl), new AbortController().signal);
  assert.equal(artifact.status, "partial");
  assert.equal(artifact.sourceSet.truncated, true);
  assert.equal(artifact.evidence.length, 1);
  assert.ok(artifact.failures.some((failure) => failure.code === "PARTIAL_SOURCE_SET"));
  assert.ok(artifact.failures.some((failure) => failure.code === "NETWORK_ERROR" && failure.sourceId === second.sourceId));
});

test("malformed provider output fails without retaining raw payload", async () => {
  const id = "M7lc1UVf-VE";
  const artifact = await new YouTubeLectureAcquisitionService({ parser: parser({ kind: "video", videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` }), playlistExpander: expander, evidenceProvider: provider(async () => ({ provider: "fake-provider", raw: "not-json" })) }).acquire(request(`https://www.youtube.com/watch?v=${id}`), new AbortController().signal);
  assert.equal(artifact.status, "failed");
  assert.ok(artifact.failures.some((failure) => failure.code === "INVALID_PROVIDER_RESPONSE"));
  assert.equal("raw" in artifact, false);
});

test("retryable provider error succeeds on second attempt", async () => {
  const id = "BaW_4n5cQxY";
  let attempts = 0;
  const artifact = await new YouTubeLectureAcquisitionService({ parser: parser({ kind: "video", videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` }), playlistExpander: expander, evidenceProvider: provider(async () => { attempts++; if (attempts === 1) throw new AcquisitionProviderError("NETWORK_ERROR", "retry", { retryable: true }); return { provider: "fake-provider", raw }; }) }).acquire(request(`https://www.youtube.com/watch?v=${id}`), new AbortController().signal);
  assert.equal(attempts, 2);
  assert.equal(artifact.status, "succeeded");
});

test("unapproved automated public video analysis fails closed without calling the provider", async () => {
  const id = "dQw4w9WgXcQ";
  let calls = 0;
  const artifact = await new YouTubeLectureAcquisitionService({
    parser: parser({ kind: "video", videoId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` }),
    playlistExpander: expander,
    evidenceProvider: provider(async () => {
      calls++;
      throw new Error("provider must not be called");
    }),
  }).acquire({ ...request(`https://www.youtube.com/watch?v=${id}`), rights: { automatedPublicVideoAnalysisApproved: false, ownedCaptionAccessApproved: false } }, new AbortController().signal);
  assert.equal(calls, 0);
  assert.equal(artifact.status, "failed");
  assert.deepEqual(artifact.evidence, []);
  assert.ok(artifact.failures.some((failure) => failure.code === "RIGHTS_REQUIRED"));
});
