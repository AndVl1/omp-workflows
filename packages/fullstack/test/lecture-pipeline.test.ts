import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ACQUISITION_LIMITS, type LectureAcquisitionRequest, type PipelineLimits, type PreparedAudioLease, type ResolvedVideoSource } from "@andvl1/omp-workflows-core";
import { normalizeAsrResponse } from "../src/lecture-acquisition/asr.js";
import { HostedAsr } from "../src/lecture-acquisition/asr-hosted.js";
import { LocalTextAnalysis } from "../src/lecture-acquisition/local-text.js";
import { OpenAICompatibleTextAnalysis } from "../src/lecture-acquisition/text-analysis.js";
import { OmpTextAnalysis } from "../src/lecture-acquisition/omp-runtime.js";
import { TranscribeAnalyzeEvidenceProvider } from "../src/lecture-acquisition/pipeline.js";
import { AcquisitionProviderError } from "../src/lecture-acquisition/provider-errors.js";

const source: ResolvedVideoSource = { sourceId: "yt-video-fixture01", videoId: "fixture01", canonicalUrl: "https://www.youtube.com/watch?v=fixture01" };
const request: LectureAcquisitionRequest = {
  sourceUrl: source.canonicalUrl,
  prompt: "Extract the bounded claim",
  limits: { ...DEFAULT_ACQUISITION_LIMITS },
  mediaMode: "owned-audio",
  rights: { automatedPublicVideoAnalysisApproved: true, ownedCaptionAccessApproved: false, ownedMediaAudioAccessApproved: true },
};
const limits: PipelineLimits = { maxAudioBytes: 1024, maxTranscriptCharacters: 1024, maxChunkCharacters: 256, maxChunksPerSource: 4, maxAnalysisOutputBytes: 1024 };

function lease(): PreparedAudioLease {
  let disposed = false;
  return {
    format: "audio/wav;codec=pcm_s16le;rate=16000;channels=1",
    sizeBytes: 0,
    async open() { return (async function* () { yield new Uint8Array(); })(); },
    async dispose() { disposed = true; assert.equal(disposed, true); },
  };
}

test("ASR normalization rejects malformed timestamps and retains bounded ordering", () => {
  const normalized = normalizeAsrResponse({ segments: [{ text: "one", start: 1, end: 2 }, { text: "two", start: 2, end: 3 }] }, { provider: "fixture-asr", maxCharacters: 32 });
  assert.deepEqual(normalized.segments.map((item) => item.startSeconds), [1, 2]);
  assert.throws(() => normalizeAsrResponse({ segments: [{ text: "bad", start: 4, end: 4 }] }, { provider: "fixture-asr", maxCharacters: 32 }), AcquisitionProviderError);
});

test("local Whisper segment bound is independent from the analysis chunk bound", () => {
  const segments = Array.from({ length: 129 }, (_, index) => ({ text: "x", start: index, end: index + 1 }));
  const normalized = normalizeAsrResponse({ segments }, { provider: "fixture-asr", maxCharacters: 512, maxSegments: 256 });
  assert.equal(normalized.segments.length, 129);
  assert.throws(() => normalizeAsrResponse({ segments }, { provider: "fixture-asr", maxCharacters: 512, maxSegments: 128 }), /ASR transcript exceeds the configured bounds/);
});

test("transcribe-analyze pipeline disposes media and prepared leases after success", async () => {
  let mediaDisposed = 0;
  let preparedDisposed = 0;
  const media = { format: "fixture", sizeBytes: 1, async open() { return (async function* () { yield new Uint8Array(); })(); }, async dispose() { mediaDisposed += 1; } };
  const prepared = lease();
  prepared.dispose = async () => { preparedDisposed += 1; };
  const pipeline = new TranscribeAnalyzeEvidenceProvider({
    media: { async acquire() { return media; } },
    preprocess: { async prepare() { return prepared; } },
    asr: { id: "fixture-asr", async transcribe() { return { provider: "fixture-asr", segments: [{ segmentId: "s0", text: "bounded claim", startSeconds: 1, endSeconds: 2 }] }; } },
    analysis: { async analyze() { return { provider: "fixture-analysis", evidence: [{ quote: "bounded claim", startSeconds: 1, endSeconds: 2, kind: "transcript_excerpt" as const }] }; } },
  });
  const result = await pipeline.acquire(source, request, new AbortController().signal);
  assert.equal(result.provider, "fixture-analysis");
  assert.equal(mediaDisposed, 1);
  assert.equal(preparedDisposed, 1);
  assert.deepEqual((result.raw as { segments: unknown[] }).segments.length, 1);
});

test("empty text-analysis chunks are skipped while later chunks still produce grounded evidence", async () => {
  let analysisCalls = 0;
  const media = { format: "fixture", sizeBytes: 1, async open() { return (async function* () { yield new Uint8Array(); })(); }, async dispose() {} };
  const pipeline = new TranscribeAnalyzeEvidenceProvider({
    media: { async acquire() { return media; } },
    preprocess: { async prepare() { return lease(); } },
    asr: {
      id: "fixture-asr",
      async transcribe() {
        return {
          provider: "fixture-asr",
          segments: [
            { segmentId: "s0", text: "first", startSeconds: 0, endSeconds: 1 },
            { segmentId: "s1", text: "second", startSeconds: 1, endSeconds: 2 },
          ],
        };
      },
    },
    maxChunkCharacters: 6,
    analysis: {
      async analyze(input) {
        analysisCalls += 1;
        return analysisCalls === 1
          ? { provider: "fixture-analysis", evidence: [] }
          : { provider: "fixture-analysis", evidence: [{ quote: input.transcript[0]!.text, startSeconds: 1, endSeconds: 2, kind: "transcript_excerpt" as const }] };
      },
    },
  });
  const result = await pipeline.acquire(source, request, new AbortController().signal);
  assert.equal(analysisCalls, 2);
  assert.deepEqual((result.raw as { segments: Array<{ quote: string }> }).segments.map((item) => item.quote), ["second"]);
});

test("rights gate prevents media acquisition", async () => {
  let calls = 0;
  const pipeline = new TranscribeAnalyzeEvidenceProvider({
    media: { async acquire() { calls += 1; throw new Error("must not acquire"); } },
    preprocess: { async prepare() { return lease(); } },
    asr: { id: "fixture-asr", async transcribe() { return { provider: "fixture-asr", segments: [] }; } },
    analysis: { async analyze() { return { provider: "fixture-analysis", evidence: [] }; } },
  });
  await assert.rejects(() => pipeline.acquire(source, { ...request, rights: { ...request.rights, ownedMediaAudioAccessApproved: false } }, new AbortController().signal), (error: unknown) => error instanceof AcquisitionProviderError && error.code === "RIGHTS_REQUIRED");
  assert.equal(calls, 0);
});

test("local text adapter uses loopback without an API key and grounds quotes", async () => {
  const text = new LocalTextAnalysis({ provider: "ollama", endpoint: "http://127.0.0.1:11434/v1", model: "fixture-model", maxResponseBytes: 4096, maxTranscriptCharacters: 1024, maxEvidenceSegments: 2, fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ evidence: [{ quote: "bounded claim", start_seconds: 1, end_seconds: 2, kind: "transcript_excerpt" }] }) } }] }), { status: 200, headers: { "content-type": "application/json" } }) });
  const result = await text.analyze({ source, prompt: request.prompt, transcript: [{ text: "bounded claim", startSeconds: 1, endSeconds: 2 }] }, request, new AbortController().signal);
  assert.equal(result.provider, "ollama");
  assert.equal(result.evidence[0]?.quote, "bounded claim");
});

test("structured empty evidence is a valid no-evidence response", async () => {
  const text = new OpenAICompatibleTextAnalysis({
    endpoint: "https://openrouter.ai/api/v1",
    trust: "trusted-remote",
    provider: "openai-compatible",
    model: "fixture-model",
    apiKeyEnv: "FIXTURE_KEY",
    env: { FIXTURE_KEY: "x" },
    maxResponseBytes: 4096,
    maxTranscriptCharacters: 1024,
    maxEvidenceSegments: 2,
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ evidence: [] }) } }] }), { status: 200 }),
  });
  const result = await text.analyze({ source, prompt: request.prompt, transcript: [{ text: "bounded claim", startSeconds: 1, endSeconds: 2 }] }, { ...request, rights: { ...request.rights, externalTranscriptAnalysisApproved: true } }, new AbortController().signal);
  assert.deepEqual(result.evidence, []);
});

test("hosted ASR fails closed before fetch when key is unavailable", async () => {
  let calls = 0;
  const asr = new HostedAsr({ endpoint: "https://api.example.test/v1", trust: "trusted-remote", apiKeyEnv: "MISSING_FIXTURE_KEY", env: { MISSING_FIXTURE_KEY: "" }, model: "fixture", maxResponseBytes: 1024, maxTranscriptCharacters: 1024, fetch: async () => { calls += 1; throw new Error("must not fetch"); } });
  await assert.rejects(() => asr.transcribe(lease(), source, request, new AbortController().signal), (error: unknown) => error instanceof AcquisitionProviderError && error.code === "PROVIDER_AUTH_MISSING");
  assert.equal(calls, 0);
});

test("OMP text adapter uses an injected callable runtime when available", async () => {
  const adapter = new OmpTextAnalysis({
    model: "lecture-analysis",
    maxResponseBytes: 1024,
    maxEvidenceSegments: 2,
    invoker: {
      async invoke() {
        return JSON.stringify({ evidence: [{ quote: "bounded claim", start_seconds: 1, end_seconds: 2, kind: "transcript_excerpt" }] });
      },
    },
  });
  const approvedRequest = { ...request, rights: { ...request.rights, externalTranscriptAnalysisApproved: true } };
  const result = await adapter.analyze({ source, prompt: request.prompt, transcript: [{ text: "bounded claim", startSeconds: 1, endSeconds: 2 }] }, approvedRequest, new AbortController().signal);
  assert.equal(result.provider, "omp-runtime");
  assert.equal(result.evidence[0]?.quote, "bounded claim");
});

test("OMP text adapter rejects unapproved transcript analysis before invoking the runtime", async () => {
  let invocations = 0;
  const adapter = new OmpTextAnalysis({
    model: "lecture-analysis",
    maxResponseBytes: 1024,
    maxEvidenceSegments: 2,
    invoker: {
      async invoke() {
        invocations += 1;
        return JSON.stringify({ evidence: [] });
      },
    },
  });
  await assert.rejects(
    () => adapter.analyze({ source, prompt: request.prompt, transcript: [{ text: "bounded claim", startSeconds: 1, endSeconds: 2 }] }, request, new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "RIGHTS_REQUIRED" && error.provider === "omp-runtime",
  );
  assert.equal(invocations, 0);
});

test("OMP model-role adapter reports unavailable runtime instead of fabricating output", async () => {
  const adapter = new OmpTextAnalysis({ model: "lecture-analysis", maxResponseBytes: 1024, maxEvidenceSegments: 2 });
  await assert.rejects(() => adapter.analyze({ source, prompt: request.prompt, transcript: [{ text: "bounded claim", startSeconds: 1, endSeconds: 2 }] }, request, new AbortController().signal), (error: unknown) => error instanceof AcquisitionProviderError && error.code === "OMP_RUNTIME_UNAVAILABLE");
});
