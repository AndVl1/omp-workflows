import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { MessageChannel } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import type { EphemeralAudio, LectureAcquisitionRequest, ResolvedVideoSource } from "@andvl1/omp-workflows-core";
import {
  OPENROUTER_NATIVE_ASR_MAX_SEGMENT_CHARACTERS,
  OPENROUTER_NATIVE_ASR_MODEL,
  OPENROUTER_NATIVE_ASR_PROVIDER,
  OpenRouterNativeAsr,
} from "../src/lecture-acquisition/asr-openrouter.js";
import { createDefaultLectureAcquisitionService } from "../src/lecture-acquisition/service.js";
import { loadLectureResearchConfig } from "../src/lecture-acquisition/config.js";
import { AcquisitionProviderError } from "../src/lecture-acquisition/provider-errors.js";

const source: ResolvedVideoSource = {
  sourceId: "yt-video-dQw4w9WgXcQ",
  videoId: "dQw4w9WgXcQ",
  canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
};

const request: LectureAcquisitionRequest = {
  sourceUrl: source.canonicalUrl,
  prompt: "Extract claims",
  limits: {
    maxItems: 1,
    maxPages: 1,
    deadlineMs: 30_000,
    maxAttempts: 1,
    maxResponseBytes: 1_048_576,
    maxEvidenceSegmentsPerSource: 16,
    maxAudioBytes: 1_048_576,
    maxTranscriptCharacters: 10_000,
    maxTranscriptSegments: 32,
    maxChunkCharacters: 128,
    maxChunksPerSource: 16,
    maxAnalysisOutputBytes: 8_192,
  },
  rights: { automatedPublicVideoAnalysisApproved: true, ownedCaptionAccessApproved: false, ownedMediaAudioAccessApproved: true },
  mediaMode: "owned-audio",
};

function fakeAudio(bytes: Uint8Array, durationSeconds?: number): EphemeralAudio & { openCount: number; disposeCount: number } {
  const value = {
    format: "audio/wav",
    sizeBytes: bytes.byteLength,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    openCount: 0,
    disposeCount: 0,
    async open(_signal: AbortSignal) {
      value.openCount += 1;
      return (async function* () { yield bytes; })();
    },
    async dispose() {
      value.disposeCount += 1;
    },
  };
  return value;
}

function options(fetch: typeof globalThis.fetch, env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "test-key" }) {
  return {
    endpoint: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    env,
    maxInputBytes: 1_048_576,
    maxRequestBytes: 4_096,
    maxResponseBytes: 8_192,
    maxTranscriptCharacters: 10_000,
    maxSegments: 32,
    maxChunkCharacters: 128,
    fetch,
  };
}

function directSttRequest(init: RequestInit): { model: string; input_audio: { data: string; format: "wav" } } {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["input_audio", "model"]);
  assert.equal(typeof body.model, "string");
  const inputAudio = body.input_audio;
  assert.ok(inputAudio && typeof inputAudio === "object" && !Array.isArray(inputAudio));
  const envelope = inputAudio as Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope).sort(), ["data", "format"]);
  assert.equal(envelope.format, "wav");
  assert.equal(typeof envelope.data, "string");
  return { model: body.model as string, input_audio: { data: envelope.data as string, format: "wav" } };
}
function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function riffChunk(id: string, payload: Uint8Array): Uint8Array {
  assert.equal(id.length, 4);
  const padded = payload.byteLength + (payload.byteLength % 2);
  const output = new Uint8Array(8 + padded);
  output.set(asciiBytes(id), 0);
  new DataView(output.buffer).setUint32(4, payload.byteLength, true);
  output.set(payload, 8);
  return output;
}

function pcmWav(frameCount: number, before: Array<{ id: string; payload: Uint8Array }> = [], after: Array<{ id: string; payload: Uint8Array }> = []) {
  const pcm = Uint8Array.from({ length: frameCount * 2 }, (_, index) => index & 0xff);
  const fmt = new Uint8Array(16);
  const fmtView = new DataView(fmt.buffer);
  fmtView.setUint16(0, 1, true);
  fmtView.setUint16(2, 1, true);
  fmtView.setUint32(4, 16_000, true);
  fmtView.setUint32(8, 32_000, true);
  fmtView.setUint16(12, 2, true);
  fmtView.setUint16(14, 16, true);
  const chunks = [
    ...before.map(({ id, payload }) => riffChunk(id, payload)),
    riffChunk("fmt ", fmt),
    riffChunk("data", pcm),
    ...after.map(({ id, payload }) => riffChunk(id, payload)),
  ];
  const totalBytes = 12 + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalBytes);
  output.set(asciiBytes("RIFF"), 0);
  new DataView(output.buffer).setUint32(4, totalBytes - 8, true);
  output.set(asciiBytes("WAVE"), 8);
  let offset = 12;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: output, pcm, durationSeconds: frameCount / 16_000 };
}

function streamedAudio(bytes: Uint8Array, sliceBytes = 17): EphemeralAudio & { openCount: number; returnCount: number } {
  const value = {
    format: "audio/wav",
    sizeBytes: bytes.byteLength,
    openCount: 0,
    returnCount: 0,
    async open(_signal: AbortSignal) {
      value.openCount += 1;
      const owner = value;
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (let offset = 0; offset < bytes.byteLength; offset += sliceBytes) yield bytes.subarray(offset, Math.min(offset + sliceBytes, bytes.byteLength));
          } finally {
            owner.returnCount += 1;
          }
        },
      };
    },
    async readAt(offset: number, length: number, _signal: AbortSignal) {
      return bytes.subarray(offset, offset + length);
    },
    async dispose() {},
  };
  return value;
}

function chunkOptions(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return {
    ...options(fetch),
    maxInputBytes: 1,
    maxRequestBytes: 100_000,
    chunkDurationSeconds: 1,
    chunkTimeoutMs: 100,
    ...overrides,
  };
}

function chunkRequest(overrides: Partial<LectureAcquisitionRequest["limits"]> = {}): LectureAcquisitionRequest {
  return {
    ...request,
    limits: {
      ...request.limits,
      maxAudioBytes: 2_000_000,
      maxChunksPerSource: 16,
      maxProviderCostCents: 5_000,
      ...overrides,
    },
  };
}

test("OpenRouter native ASR sends the bounded direct STT JSON/base64 request shape", async () => {
  const audioBytes = new Uint8Array([0, 1, 2, 255]);
  const audio = fakeAudio(audioBytes, 2);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init! });
    return new Response(JSON.stringify({ text: "hello", usage: { seconds: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await new OpenRouterNativeAsr(options(fetch)).transcribe(audio, source, request, new AbortController().signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/audio/transcriptions");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.redirect, "error");
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer test-key");
  const body = directSttRequest(calls[0]!.init);
  assert.equal(body.model, OPENROUTER_NATIVE_ASR_MODEL);
  assert.equal(body.input_audio.format, "wav");
  assert.deepEqual(new Uint8Array(Buffer.from(body.input_audio.data, "base64")), audioBytes);
  assert.ok(!body.input_audio.data.startsWith("data:"));
  assert.ok(Buffer.byteLength(String(calls[0]!.init.body), "utf8") <= 4_096);
  assert.equal(result.provider, OPENROUTER_NATIVE_ASR_PROVIDER);
  assert.equal(result.model, OPENROUTER_NATIVE_ASR_MODEL);
});

test("OpenRouter short ASR rejects known audio cost above a zero budget before fetch", async () => {
  const audio = fakeAudio(new Uint8Array([1, 2, 3]), 1);
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ text: "never" }), { status: 200 });
  };
  await assert.rejects(
    new OpenRouterNativeAsr(options(fetch)).transcribe(
      audio,
      source,
      { ...request, limits: { ...request.limits, maxProviderCostCents: 0 } },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED" && !error.retryable,
  );
  assert.equal(fetchCount, 0);
  assert.equal(audio.openCount, 0);
});

test("OpenRouter short ASR rejects known audio above the tighter request duration before fetch", async () => {
  const audio = fakeAudio(new Uint8Array([1, 2, 3]), 10);
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ text: "never" }), { status: 200 });
  };
  await assert.rejects(
    new OpenRouterNativeAsr({ ...options(fetch), maxDurationSeconds: 8 }).transcribe(
      audio,
      source,
      { ...request, limits: { ...request.limits, maxDurationSeconds: 5 } },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED" && !error.retryable,
  );
  assert.equal(fetchCount, 0);
  assert.equal(audio.openCount, 0);
});

test("OpenRouter short ASR keeps known prepared duration when provider usage underreports it", async () => {
  const audio = fakeAudio(new Uint8Array([1, 2, 3]), 4_000);
  const fetch = async () => new Response(JSON.stringify({ text: "known duration", usage: { seconds: 1 } }), { status: 200 });
  const result = await new OpenRouterNativeAsr(options(fetch)).transcribe(audio, source, request, new AbortController().signal);
  assert.equal(result.segments.at(-1)?.endSeconds, 4_000);
  assert.equal(result.usage?.requestedAudioSeconds, 4_000);
  assert.equal(result.usage?.reportedAudioSeconds, 1);
  assert.equal(result.usage?.estimatedCostCents, 2);
});

test("OpenRouter short ASR rejects provider cost overflow after its single response", async () => {
  const audio = fakeAudio(new Uint8Array([1, 2, 3]), 1);
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ text: "provider cost", usage: { seconds: 1, cost: 100 } }), { status: 200 });
  };
  await assert.rejects(
    new OpenRouterNativeAsr(options(fetch)).transcribe(audio, source, request, new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED" && !error.retryable,
  );
  assert.equal(fetchCount, 1);
});

test("missing OpenRouter key fails before opening audio or fetching", async () => {
  const audio = fakeAudio(new Uint8Array([1, 2, 3]), 1);
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return new Response("{}", { status: 200 });
  };
  await assert.rejects(
    new OpenRouterNativeAsr(options(fetch, { OPENROUTER_API_KEY: "" })).transcribe(audio, source, request, new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "PROVIDER_AUTH_MISSING",
  );
  assert.equal(audio.openCount, 0);
  assert.equal(fetchCount, 0);
});

test("native ASR rejects raw audio and encoded-envelope overflow before fetch", async () => {
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return new Response("{}", { status: 200 });
  };
  const oversizedAudio = fakeAudio(new Uint8Array(8), 1);
  await assert.rejects(
    new OpenRouterNativeAsr({ ...options(fetch), maxInputBytes: 4 }).transcribe(oversizedAudio, source, request, new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "MEDIA_NOT_ACCESSIBLE",
  );
  assert.equal(oversizedAudio.openCount, 1);
  const encodedOverflow = fakeAudio(new Uint8Array(7), 1);
  await assert.rejects(
    new OpenRouterNativeAsr({ ...options(fetch), maxRequestBytes: 520, maxInputBytes: 100 }).transcribe(encodedOverflow, source, request, new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED",
  );
  assert.equal(encodedOverflow.openCount, 0);
  assert.equal(fetchCount, 0);
});

test("text-only OpenRouter response maps to bounded estimated monotonic windows", async () => {
  const audio = fakeAudio(new Uint8Array([4, 5, 6]), 6);
  const fetch = async () => new Response(JSON.stringify({ text: "abcdefghij", usage: { seconds: 9 } }), { status: 200 });
  const result = await new OpenRouterNativeAsr({ ...options(fetch), maxChunkCharacters: 3 }).transcribe(audio, source, request, new AbortController().signal);
  assert.equal(result.timestampMode, "estimated");
  assert.deepEqual(result.segments.map((segment) => segment.segmentId), ["estimated-0", "estimated-1", "estimated-2", "estimated-3"]);
  assert.ok(result.segments.every((segment) => segment.timestampSource === "estimated" && segment.confidence === 0 && segment.endSeconds <= 6));
  assert.ok(result.segments.every((segment) => segment.text.length <= OPENROUTER_NATIVE_ASR_MAX_SEGMENT_CHARACTERS));
  for (let index = 1; index < result.segments.length; index += 1) {
    assert.ok(result.segments[index - 1]!.endSeconds <= result.segments[index]!.startSeconds);
  }
  assert.equal(result.segments.at(-1)?.endSeconds, 6);
});

test("direct STT text responses map long transcripts to bounded estimated windows", async () => {
  const audioBytes = new Uint8Array([4, 5, 6]);
  const transcript = "x".repeat(OPENROUTER_NATIVE_ASR_MAX_SEGMENT_CHARACTERS + 1);
  const fetch = async () => new Response(JSON.stringify({ text: transcript, usage: { seconds: 8 } }), { status: 200 });
  const result = await new OpenRouterNativeAsr({
    ...options(fetch),
    maxResponseBytes: 20_000,
    maxTranscriptCharacters: transcript.length + 1,
    maxChunkCharacters: 12_000,
    maxSegments: 4,
  }).transcribe(fakeAudio(audioBytes, 8), source, request, new AbortController().signal);
  assert.equal(result.timestampMode, "estimated");
  assert.ok(result.segments.length >= 2);
  assert.ok(result.segments.every((segment) =>
    segment.text.length <= OPENROUTER_NATIVE_ASR_MAX_SEGMENT_CHARACTERS
    && segment.timestampSource === "estimated"
    && segment.confidence === 0
    && segment.endSeconds <= 8,
  ));
  assert.equal(result.segments.at(-1)?.endSeconds, 8);
});

test("OpenRouter native ASR clamps oversized configured chunks and splits direct STT text within the core bound", async () => {
  const audio = fakeAudio(new Uint8Array([7, 8, 9]), 4);
  const text = "x".repeat(OPENROUTER_NATIVE_ASR_MAX_SEGMENT_CHARACTERS + 1);
  const fetch = async () => new Response(JSON.stringify({ text }), { status: 200 });
  const result = await new OpenRouterNativeAsr({
    ...options(fetch),
    maxChunkCharacters: 12_000,
    maxTranscriptCharacters: 20_000,
    maxResponseBytes: 20_000,
    maxSegments: 4,
  }).transcribe(audio, source, request, new AbortController().signal);
  assert.equal(result.timestampMode, "estimated");
  assert.equal(result.segments.length, 2);
  assert.ok(result.segments.every((segment) => segment.text.length <= OPENROUTER_NATIVE_ASR_MAX_SEGMENT_CHARACTERS));
  assert.ok(result.segments.every((segment) => segment.timestampSource === "estimated"));
  assert.equal(result.segments[0]?.startSeconds, 0);
  assert.equal(result.segments.at(-1)?.endSeconds, 4);
  assert.ok(result.segments[0]!.endSeconds <= result.segments[1]!.startSeconds);
  assert.doesNotThrow(() => new OpenRouterNativeAsr({ ...options(fetch), maxChunkCharacters: 32_000 }));
  assert.throws(
    () => new OpenRouterNativeAsr({ ...options(fetch), maxChunkCharacters: 32_001 }),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED",
  );
});

test("OpenRouter direct STT text honors a configured chunk bound below the hard ceiling", async () => {
  const audio = fakeAudio(new Uint8Array([7, 8, 9]), 4);
  const text = "x".repeat(6_000);
  const fetch = async () => new Response(JSON.stringify({ text }), { status: 200 });
  const result = await new OpenRouterNativeAsr({
    ...options(fetch),
    maxChunkCharacters: 4_000,
    maxTranscriptCharacters: 10_000,
    maxSegments: 2,
  }).transcribe(audio, source, request, new AbortController().signal);
  assert.equal(result.timestampMode, "estimated");
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments.reduce((total, segment) => total + segment.text.length, 0), text.length);
  assert.ok(result.segments.every((segment) => segment.text.length <= 4_000));
  assert.ok(result.segments.every((segment) => segment.timestampSource === "estimated"));
  assert.equal(result.segments[0]?.startSeconds, 0);
  assert.equal(result.segments.at(-1)?.endSeconds, 4);
  for (let index = 1; index < result.segments.length; index += 1) {
    assert.ok(result.segments[index - 1]!.endSeconds <= result.segments[index]!.startSeconds);
  }
  assert.throws(
    () => new OpenRouterNativeAsr({ ...options(fetch), maxChunkCharacters: 32_001 }),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED",
  );
});


test("missing duration, malformed response, and oversized response are sanitized typed failures", async () => {
  const audio = fakeAudio(new Uint8Array([1]), undefined);
  const noDuration = async () => new Response(JSON.stringify({ text: "hello" }), { status: 200 });
  await assert.rejects(
    new OpenRouterNativeAsr(options(noDuration)).transcribe(audio, source, request, new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "INVALID_PROVIDER_RESPONSE" && !error.message.includes("hello"),
  );
  const malformed = async () => new Response("not-json", { status: 200 });
  await assert.rejects(
    new OpenRouterNativeAsr(options(malformed)).transcribe(fakeAudio(new Uint8Array([1]), 1), source, request, new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "INVALID_PROVIDER_RESPONSE",
  );
  const huge = async () => new Response("123456789", { status: 200 });
  await assert.rejects(
    new OpenRouterNativeAsr({ ...options(huge), maxResponseBytes: 4 }).transcribe(fakeAudio(new Uint8Array([1]), 1), source, request, new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED",
  );
});

test("config selects the exact OpenRouter model and rejects non-OpenRouter endpoints", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lecture-openrouter-config-"));
  try {
    await writeFile(join(cwd, ".omp-placeholder"), "");
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "lecture-research.json"), JSON.stringify({
      limits: { maxAudioBytes: 1_048_576 },
      pipeline: {
        mode: "transcribe-analyze",
        audio: { provider: "existing-input", inputEnv: "LECTURE_AUDIO_INPUT", maxBytes: 1_048_576, timeoutMs: 10_000 },
        asr: { provider: "openrouter-native", transport: "json-base64", endpoint: "https://openrouter.ai/api/v1", trust: "trusted-remote", apiKeyEnv: "OPENROUTER_API_KEY", timestampMode: "estimated" },
        analysis: { provider: "ollama", model: "fixture", endpoint: "http://127.0.0.1:11434/v1", trust: "local-loopback" },
      },
    }));
    const config = await loadLectureResearchConfig(cwd);
    assert.equal(config.pipeline?.asr.provider, "openrouter-native");
    assert.equal(config.pipeline?.asr.model, OPENROUTER_NATIVE_ASR_MODEL);
    assert.equal(config.pipeline?.asr.timestampMode, "estimated");
    await writeFile(join(cwd, ".omp", "lecture-research.json"), JSON.stringify({
      pipeline: {
        mode: "transcribe-analyze",
        audio: { provider: "existing-input", inputEnv: "LECTURE_AUDIO_INPUT", maxBytes: 1_048_576, timeoutMs: 10_000 },
        asr: { provider: "openrouter-native", transport: "json-base64", endpoint: "https://example.test/api/v1", trust: "trusted-remote", apiKeyEnv: "OPENROUTER_API_KEY", timestampMode: "estimated" },
        analysis: { provider: "ollama", model: "fixture", endpoint: "http://127.0.0.1:11434/v1", trust: "local-loopback" },
      },
    }));
    await assert.rejects(loadLectureResearchConfig(cwd), /Invalid pipeline\.asr\.endpoint/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("documented default OpenRouter pipeline construction accepts the core 12000-character chunk limit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lecture-openrouter-default-pipeline-"));
  try {
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "lecture-research.json"), JSON.stringify({
      pipeline: {
        mode: "transcribe-analyze",
        audio: { provider: "existing-input", inputEnv: "LECTURE_AUDIO_INPUT", maxBytes: 1_048_576, timeoutMs: 10_000 },
        asr: {
          provider: "openrouter-native",
          transport: "json-base64",
          endpoint: "https://openrouter.ai/api/v1",
          trust: "trusted-remote",
          apiKeyEnv: "OPENROUTER_API_KEY",
          timestampMode: "estimated",
        },
        analysis: { provider: "ollama", model: "fixture", endpoint: "http://127.0.0.1:11434/v1", trust: "local-loopback" },
      },
    }));
    const env = { OPENROUTER_API_KEY: "test-key" };
    const config = await loadLectureResearchConfig(cwd, env);
    assert.equal(config.limits.maxChunkCharacters, 12_000);
    await assert.doesNotReject(() => createDefaultLectureAcquisitionService(cwd, env, {
      fetch: async () => new Response("{}"),
    }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("authorized yt-dlp shim accepts only source-id and emits stdout media", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lecture-ytdlp-shim-"));
  try {
    const capture = join(cwd, "args.jsonl");
    const fakeBinary = join(cwd, "fake-ytdlp.mjs");
    await writeFile(fakeBinary, "#!/usr/bin/env node\nimport { appendFileSync } from \"node:fs\"; appendFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10)); process.stdout.write(\"media-fixture\");\n");
    await chmod(fakeBinary, 0o700);
    const shim = fileURLToPath(new URL("../scripts/yt-dlp-owned-audio.mjs", import.meta.url));
    const run = (id: string, binary?: string, playerClient?: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const env = { ...process.env, CAPTURE: capture };
      delete env.YT_DLP_PLAYER_CLIENT;
      if (binary === undefined) delete env.YT_DLP_BIN;
      else env.YT_DLP_BIN = binary;
      if (playerClient !== undefined) env.YT_DLP_PLAYER_CLIENT = playerClient;
      const child = spawn(process.execPath, [shim, "--source-id", id], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.once("close", (code) => resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8") }));
    });
    const readCaptures = async () => (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const sourceUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const baselineArgs = ["--ignore-config", "--no-playlist", "-f", "bestaudio[protocol*=m3u8]/bestaudio/best", "-o", "-", sourceUrl];

    const valid = await run("dQw4w9WgXcQ", fakeBinary);
    assert.equal(valid.code, 0);
    assert.equal(valid.stdout, "media-fixture");
    assert.deepEqual((await readCaptures()).at(-1), baselineArgs);

    const empty = await run("dQw4w9WgXcQ", fakeBinary, "");
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout, "media-fixture");
    assert.deepEqual((await readCaptures()).at(-1), baselineArgs);

    const androidVr = await run("dQw4w9WgXcQ", fakeBinary, "android_vr");
    assert.equal(androidVr.code, 0);
    assert.equal(androidVr.stdout, "media-fixture");
    assert.deepEqual((await readCaptures()).at(-1), [
      "--ignore-config",
      "--no-playlist",
      "-f",
      "bestaudio[protocol*=m3u8]/bestaudio/best",
      "-o",
      "-",
      "--extractor-args",
      "youtube:player_client=android_vr",
      sourceUrl,
    ]);

    const clientList = await run("dQw4w9WgXcQ", fakeBinary, "android_vr,web_embedded,tv_simply");
    assert.equal(clientList.code, 0);
    assert.equal(clientList.stdout, "media-fixture");
    assert.deepEqual((await readCaptures()).at(-1), [
      "--ignore-config",
      "--no-playlist",
      "-f",
      "bestaudio[protocol*=m3u8]/bestaudio/best",
      "-o",
      "-",
      "--extractor-args",
      "youtube:player_client=android_vr,web_embedded,tv_simply",
      sourceUrl,
    ]);

    const captureBeforeInvalid = await readFile(capture, "utf8");
    for (const playerClient of [
      "android vr",
      "android_vr,",
      ",android_vr",
      "ANDROID_VR",
      "android-vr",
      "android_vr=web",
      "android_vr;web",
      "android_vr\tweb_embedded",
      "android_vr\nweb_embedded",
      "android_vr\u0001web_embedded",
      "a".repeat(129),
    ]) {
      const invalidPlayerClient = await run("dQw4w9WgXcQ", fakeBinary, playerClient);
      assert.equal(invalidPlayerClient.code, 2);
      assert.equal(invalidPlayerClient.stdout, "");
      assert.equal(invalidPlayerClient.stderr, "invalid YT_DLP_PLAYER_CLIENT\n");
      assert.equal(await readFile(capture, "utf8"), captureBeforeInvalid);
    }

    const invalid = await run("not-valid", fakeBinary);
    assert.notEqual(invalid.code, 0);
    const missingBinary = await run("dQw4w9WgXcQ");
    assert.equal(missingBinary.code, 2);
    assert.equal(missingBinary.stdout, "");
    assert.equal(missingBinary.stderr, "yt-dlp binary is not configured\n");
    const unsafeBinary = await run("dQw4w9WgXcQ", fakeBinary + "\n");
    assert.equal(unsafeBinary.code, 2);
    assert.equal(unsafeBinary.stdout, "");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("OpenRouter chunk mode canonicalizes sequential WAV envelopes and preserves exact PCM coverage", async () => {
  const fixture = pcmWav(48_000);
  const audio = streamedAudio(fixture.bytes, 11);
  const sent: Uint8Array[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://openrouter.ai/api/v1/audio/transcriptions");
    const body = directSttRequest(init!);
    assert.equal(body.model, OPENROUTER_NATIVE_ASR_MODEL);
    const encodedAudio = body.input_audio.data;
    assert.equal(typeof encodedAudio, "string");
    const wav = new Uint8Array(Buffer.from(encodedAudio!, "base64"));
    sent.push(wav);
    assert.ok(Buffer.byteLength(String(init?.body), "utf8") <= 100_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
    assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
    assert.equal(view.getUint32(4, true), wav.byteLength - 8);
    assert.equal(view.getUint32(40, true), wav.byteLength - 44);
    assert.equal(view.getUint16(20, true), 1);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 16_000);
    assert.equal(view.getUint16(32, true), 2);
    assert.equal(view.getUint16(34, true), 16);
    return new Response(JSON.stringify({ text: "chunk" }), { status: 200 });
  };
  const result = await new OpenRouterNativeAsr(chunkOptions(fetch)).transcribe(audio, source, chunkRequest(), new AbortController().signal);
  assert.equal(audio.openCount, 1);
  assert.equal(audio.returnCount, 1);
  assert.equal(sent.length, 3);
  const recovered = new Uint8Array(sent.reduce((sum, chunk) => sum + chunk.byteLength - 44, 0));
  let offset = 0;
  for (const wav of sent) {
    recovered.set(wav.subarray(44), offset);
    offset += wav.byteLength - 44;
    assert.ok(wav.byteLength <= 100_000);
  }
  assert.deepEqual(recovered, fixture.pcm);
  assert.equal(result.usage?.requests, 3);
  assert.equal(result.timestampMode, "estimated");
  assert.deepEqual(result.segments.map((segment) => segment.segmentId), ["chunk-0-segment-0", "chunk-1-segment-0", "chunk-2-segment-0"]);
  assert.deepEqual(result.segments.map((segment) => [segment.startSeconds, segment.endSeconds]), [[0, 1], [1, 2], [2, 3]]);
});

test("OpenRouter chunk parser accepts padded ancillary RIFF chunks and rejects malformed normalized WAV before POST", async () => {
  const fixture = pcmWav(24_000, [{ id: "JUNK", payload: Uint8Array.from([1, 2, 3]) }, { id: "LIST", payload: Uint8Array.from([4, 5, 6, 7]) }], [{ id: "fact", payload: Uint8Array.from([8]) }]);
  const audio = streamedAudio(fixture.bytes, 5);
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };
  const result = await new OpenRouterNativeAsr(chunkOptions(fetch)).transcribe(audio, source, chunkRequest(), new AbortController().signal);
  assert.equal(result.usage?.requests, 2);
  assert.equal(fetchCount, 2);

  const malformed = new Uint8Array(pcmWav(24_000).bytes);
  malformed[22] = 2;
  let malformedFetches = 0;
  const malformedAudio = streamedAudio(malformed, 3);
  await assert.rejects(
    new OpenRouterNativeAsr(chunkOptions(async () => {
      malformedFetches += 1;
      return new Response("{}", { status: 200 });
    })).transcribe(malformedAudio, source, chunkRequest(), new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "MEDIA_NOT_ACCESSIBLE" && !error.retryable,
  );
  assert.equal(malformedFetches, 0);
});

test("OpenRouter chunk mode maps text-only responses to frame-derived global estimates", async () => {
  const fixture = pcmWav(40_000);
  const responses = ["a", "bb", "ccc"];
  let call = 0;
  const fetch = async () => new Response(JSON.stringify({ text: responses[call++] }), { status: 200 });
  const result = await new OpenRouterNativeAsr(chunkOptions(fetch)).transcribe(streamedAudio(fixture.bytes, 7), source, chunkRequest(), new AbortController().signal);
  assert.equal(result.timestampMode, "estimated");
  assert.ok(result.segments.every((segment) => segment.timestampSource === "estimated" && segment.confidence === 0));
  assert.deepEqual(result.segments.map((segment) => segment.segmentId), ["chunk-0-segment-0", "chunk-1-segment-0", "chunk-2-segment-0"]);
  assert.deepEqual(result.segments.map((segment) => [segment.startSeconds, segment.endSeconds]), [[0, 1], [1, 2], [2, 2.5]]);
  assert.equal(result.segments.at(-1)?.endSeconds, 2.5);
});

test("OpenRouter chunk preflight enforces ASR request count and estimated cost with zero fetches", async () => {
  const fixture = pcmWav(48_000);
  const audio = streamedAudio(fixture.bytes, 13);
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ text: "never" }), { status: 200 });
  };
  await assert.rejects(
    new OpenRouterNativeAsr(chunkOptions(fetch)).transcribe(audio, source, chunkRequest({ maxChunksPerSource: 2 }), new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED" && !error.retryable,
  );
  assert.equal(fetchCount, 0);
  assert.equal(audio.openCount, 0);
  let costFetches = 0;
  await assert.rejects(
    new OpenRouterNativeAsr(chunkOptions(async () => {
      costFetches += 1;
      return new Response(JSON.stringify({ text: "never" }), { status: 200 });
    })).transcribe(streamedAudio(fixture.bytes, 13), source, chunkRequest({ maxProviderCostCents: 0 }), new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED" && !error.retryable,
  );
  assert.equal(costFetches, 0);
});
test("OpenRouter mid-sequence provider usage overrun is atomic and never retried", async () => {
  const fixture = pcmWav(48_000);
  const audio = streamedAudio(fixture.bytes, 11);
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return fetchCount === 1
      ? new Response(JSON.stringify({ text: "first chunk" }), { status: 200 })
      : new Response(JSON.stringify({ text: "second chunk", usage: { seconds: 1, cost: 100 } }), { status: 200 });
  };
  let result: unknown;
  await assert.rejects(
    async () => {
      result = await new OpenRouterNativeAsr(chunkOptions(fetch)).transcribe(audio, source, chunkRequest({ maxProviderCostCents: 5_000 }), new AbortController().signal);
    },
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED" && error.retryable === false,
  );
  assert.equal(fetchCount, 2);
  assert.equal(audio.returnCount, 1);
  assert.equal(result, undefined);
});


test("OpenRouter middle chunk failures are atomic and never retried", async () => {
  const fixture = pcmWav(48_000);
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 2) return new Response("provider failure", { status: 503 });
    return new Response(JSON.stringify({ text: "partial" }), { status: 200 });
  };
  await assert.rejects(
    new OpenRouterNativeAsr(chunkOptions(fetch)).transcribe(streamedAudio(fixture.bytes, 9), source, chunkRequest(), new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "NETWORK_ERROR" && error.retryable === false,
  );
  assert.equal(fetchCount, 2);
});

// The child-timeout assertion intentionally exercises the adapter's real timer;
// no injectable clock is part of the production fetch contract.
test("OpenRouter child timeout and outer cancellation stop chunk requests", async () => {
  const fixture = pcmWav(16_000);
  let timeoutFetches = 0;
  const timeoutFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    timeoutFetches += 1;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
  };
  await assert.rejects(
    new OpenRouterNativeAsr(chunkOptions(timeoutFetch, { chunkTimeoutMs: 5 })).transcribe(streamedAudio(fixture.bytes, 7), source, chunkRequest(), new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "PROVIDER_TIMEOUT" && !error.retryable,
  );
  assert.equal(timeoutFetches, 1);

  const outer = new AbortController();
  let outerFetches = 0;
  const outerFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    outerFetches += 1;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      queueMicrotask(() => outer.abort());
    });
  };
  await assert.rejects(
    new OpenRouterNativeAsr(chunkOptions(outerFetch, { chunkTimeoutMs: 100 })).transcribe(streamedAudio(fixture.bytes, 7), source, chunkRequest(), outer.signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "PROVIDER_TIMEOUT" && !error.retryable,
  );
  assert.equal(outerFetches, 1);
});

test("OpenRouter malformed middle response is atomic with no third request", async () => {
  const fixture = pcmWav(48_000);
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return fetchCount === 2
      ? new Response("not-json", { status: 200 })
      : new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };
  await assert.rejects(
    new OpenRouterNativeAsr(chunkOptions(fetch)).transcribe(streamedAudio(fixture.bytes, 11), source, chunkRequest(), new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "INVALID_PROVIDER_RESPONSE" && !error.retryable,
  );
  assert.equal(fetchCount, 2);
});

test("OpenRouter truncated chunk input fails without a partial transcript or fetch", async () => {
  const fixture = pcmWav(24_000);
  const truncated = fixture.bytes.subarray(0, fixture.bytes.byteLength - 3);
  let fetchCount = 0;
  await assert.rejects(
    new OpenRouterNativeAsr(chunkOptions(async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ text: "never" }), { status: 200 });
    })).transcribe(streamedAudio(truncated, 3), source, { ...chunkRequest(), limits: { ...chunkRequest().limits, maxAudioBytes: truncated.byteLength } }, new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "MEDIA_NOT_ACCESSIBLE" && !error.retryable,
  );
  assert.equal(fetchCount, 0);
});
test("OpenRouter aggregate transcript bounds fail closed before a subsequent request", async () => {
  const fixture = pcmWav(48_000);
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ text: "x" }), { status: 200 });
  };
  await assert.rejects(
    new OpenRouterNativeAsr(chunkOptions(fetch)).transcribe(streamedAudio(fixture.bytes, 11), source, chunkRequest({ maxTranscriptCharacters: 2 }), new AbortController().signal),
    (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED" && !error.retryable,
  );
  assert.equal(fetchCount, 2);
});

test("OpenRouter native ASR maps provider HTTP statuses onto the sanitized failure taxonomy", async () => {
  const expectations = [
    { status: 400, code: "INVALID_PROVIDER_RESPONSE", retryable: false },
    { status: 401, code: "PROVIDER_AUTH_MISSING", retryable: false },
    { status: 403, code: "MEDIA_NOT_ACCESSIBLE", retryable: false },
    { status: 404, code: "MEDIA_NOT_ACCESSIBLE", retryable: false },
    { status: 408, code: "PROVIDER_TIMEOUT", retryable: true },
    { status: 429, code: "QUOTA_EXCEEDED", retryable: false },
    { status: 504, code: "PROVIDER_TIMEOUT", retryable: true },
    { status: 500, code: "NETWORK_ERROR", retryable: true },
  ] as const;
  for (const expected of expectations) {
    let fetchCount = 0;
    const fetch = async () => {
      fetchCount += 1;
      return new Response(`upstream body for ${expected.status} secret-payload`, { status: expected.status });
    };
    await assert.rejects(
      new OpenRouterNativeAsr(options(fetch)).transcribe(fakeAudio(new Uint8Array([1]), 1), source, request, new AbortController().signal),
      (error: unknown) => error instanceof AcquisitionProviderError
        && error.code === expected.code
        && error.retryable === expected.retryable
        && !error.message.includes("secret-payload"),
    );
    assert.equal(fetchCount, 1);
  }
});

test("OpenRouter chunk mode streams consumed PCM without retaining chunk buffers", async () => {
  const chunkFrames = 16_000;
  const chunkCount = 5;
  const pcmBytes = chunkFrames * chunkCount * 2;
  const totalBytes = 44 + pcmBytes;
  const header = new Uint8Array(44);
  header.set(asciiBytes("RIFF"), 0);
  new DataView(header.buffer).setUint32(4, totalBytes - 8, true);
  header.set(asciiBytes("WAVE"), 8);
  header.set(asciiBytes("fmt "), 12);
  new DataView(header.buffer).setUint32(16, 16, true);
  new DataView(header.buffer).setUint16(20, 1, true);
  new DataView(header.buffer).setUint16(22, 1, true);
  new DataView(header.buffer).setUint32(24, 16_000, true);
  new DataView(header.buffer).setUint32(28, 32_000, true);
  new DataView(header.buffer).setUint16(32, 2, true);
  new DataView(header.buffer).setUint16(34, 16, true);
  header.set(asciiBytes("data"), 36);
  new DataView(header.buffer).setUint32(40, pcmBytes, true);
  let openCount = 0;
  let maxPendingBytes = 0;
  const audio: EphemeralAudio = {
    format: "audio/wav",
    sizeBytes: totalBytes,
    async open() {
      openCount += 1;
      return (async function* () {
        yield header;
        for (let ordinal = 0; ordinal < chunkCount; ordinal += 1) {
          const backing = new ArrayBuffer(chunkFrames * 2);
          new Uint8Array(backing).fill(ordinal + 1);
          maxPendingBytes = Math.max(maxPendingBytes, backing.byteLength);
          yield new Uint8Array(backing);
          // Detach the delivered buffer once the consumer resumes the generator:
          // a whole-lease accumulator would later read detached memory and corrupt
          // its requests, so this keeps the no-retention contract observable.
          const port = new MessageChannel();
          port.port1.postMessage(undefined, [backing]);
          port.port1.close();
          port.port2.close();
        }
      })();
    },
    async readAt(offset: number, length: number, _signal: AbortSignal) {
      return header.subarray(offset, offset + length);
    },
    async dispose() {},
  };
  const payloads: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://openrouter.ai/api/v1/audio/transcriptions");
    const body = directSttRequest(init!);
    assert.equal(body.model, OPENROUTER_NATIVE_ASR_MODEL);
    payloads.push(body.input_audio.data);
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };
  const result = await new OpenRouterNativeAsr(chunkOptions(fetch)).transcribe(audio, source, chunkRequest(), new AbortController().signal);
  assert.equal(openCount, 1);
  assert.equal(maxPendingBytes, 32_000);
  assert.equal(payloads.length, chunkCount);
  for (const [ordinal, encoded] of payloads.entries()) {
    const wav = new Uint8Array(Buffer.from(encoded, "base64"));
    assert.equal(wav.byteLength, 44 + chunkFrames * 2);
    assert.ok(wav.subarray(44).every((byte) => byte === ordinal + 1), `chunk ${ordinal} PCM bytes must match the delivered buffer`);
  }
  assert.deepEqual(result.segments.map((segment) => [segment.startSeconds, segment.endSeconds]), [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]);
});

test("OpenRouter target plan uses 93 bounded requests for 4182 seconds without a whole-lease allocation", async () => {
  const totalFrames = 4_182 * 16_000;
  const pcmBytes = totalFrames * 2;
  const totalBytes = 44 + pcmBytes;
  const header = new Uint8Array(44);
  header.set(asciiBytes("RIFF"), 0);
  new DataView(header.buffer).setUint32(4, totalBytes - 8, true);
  header.set(asciiBytes("WAVE"), 8);
  header.set(asciiBytes("fmt "), 12);
  new DataView(header.buffer).setUint32(16, 16, true);
  new DataView(header.buffer).setUint16(20, 1, true);
  new DataView(header.buffer).setUint16(22, 1, true);
  new DataView(header.buffer).setUint32(24, 16_000, true);
  new DataView(header.buffer).setUint32(28, 32_000, true);
  new DataView(header.buffer).setUint16(32, 2, true);
  new DataView(header.buffer).setUint16(34, 16, true);
  header.set(asciiBytes("data"), 36);
  new DataView(header.buffer).setUint32(40, pcmBytes, true);
  const value = {
    format: "audio/wav",
    sizeBytes: totalBytes,
    openCount: 0,
    maxYieldBytes: 0,
    async open(_signal: AbortSignal) {
      value.openCount += 1;
      return (async function* () {
        value.maxYieldBytes = Math.max(value.maxYieldBytes, header.byteLength);
        yield header;
        let remaining = pcmBytes;
        while (remaining > 0) {
          const amount = Math.min(1_440_000, remaining);
          const chunk = new Uint8Array(amount);
          value.maxYieldBytes = Math.max(value.maxYieldBytes, chunk.byteLength);
          yield chunk;
          remaining -= amount;
        }
      })();
    },
    async readAt(offset: number, length: number, _signal: AbortSignal) {
      return header.subarray(offset, offset + length);
    },
    async dispose() {},
  } satisfies EphemeralAudio & { openCount: number; maxYieldBytes: number };
  let fetchCount = 0;
  const dataBytes: number[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCount += 1;
    assert.equal(String(input), "https://openrouter.ai/api/v1/audio/transcriptions");
    assert.ok(Buffer.byteLength(String(init?.body), "utf8") <= 2_000_000);
    const envelope = directSttRequest(init!);
    assert.equal(envelope.model, OPENROUTER_NATIVE_ASR_MODEL);
    const wav = Buffer.from(envelope.input_audio.data, "base64");
    dataBytes.push(new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(40, true));
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };
  const result = await new OpenRouterNativeAsr(chunkOptions(fetch, { maxRequestBytes: 2_000_000, chunkDurationSeconds: 45, maxTranscriptCharacters: 10_000, maxSegments: 4_096 })).transcribe(value, source, chunkRequest({ maxAudioBytes: 256 * 1024 * 1024, maxChunksPerSource: 128, maxProviderCostCents: 2, maxTranscriptSegments: 4096 }), new AbortController().signal);
  assert.equal(value.openCount, 1);
  assert.equal(fetchCount, 93);
  assert.equal(result.usage?.requests, 93);
  assert.equal(result.usage?.requestedAudioSeconds, 4_182);
  assert.ok(value.maxYieldBytes < 2_000_000);
  assert.deepEqual(dataBytes.map((pcmByteCount) => pcmByteCount / 2), [...Array.from({ length: 92 }, () => 720_000), 672_000]);
  assert.equal(result.segments.length, 93);
  for (const [index, segment] of result.segments.entries()) {
    assert.equal(segment.segmentId, `chunk-${index}-segment-0`);
    assert.deepEqual([segment.startSeconds, segment.endSeconds], [index * 45, Math.min((index + 1) * 45, 4_182)]);
    if (index > 0) assert.ok(result.segments[index - 1]!.endSeconds <= segment.startSeconds, `segments ${index - 1}/${index} overlap`);
  }
});
test("OpenRouter chunk configuration defaults, bounds, and provider allowlist are enforced", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lecture-openrouter-chunk-config-"));
  try {
    await mkdir(join(cwd, ".omp"));
    const base = {
      pipeline: {
        mode: "transcribe-analyze",
        audio: { provider: "existing-input", inputEnv: "LECTURE_AUDIO_INPUT", maxBytes: 1_048_576, timeoutMs: 10_000 },
        asr: { provider: "openrouter-native", transport: "json-base64", endpoint: "https://openrouter.ai/api/v1", trust: "trusted-remote", apiKeyEnv: "OPENROUTER_API_KEY", timestampMode: "estimated" },
        analysis: { provider: "ollama", model: "fixture", endpoint: "http://127.0.0.1:11434/v1", trust: "local-loopback" },
      },
    };
    await writeFile(join(cwd, ".omp", "lecture-research.json"), JSON.stringify(base));
    const defaults = await loadLectureResearchConfig(cwd);
    assert.equal(defaults.pipeline?.asr.chunkDurationSeconds, 45);
    assert.equal(defaults.pipeline?.asr.chunkTimeoutMs, 60_000);
    await writeFile(join(cwd, ".omp", "lecture-research.json"), JSON.stringify({
      ...base,
      pipeline: { ...base.pipeline, asr: { ...base.pipeline.asr, chunkDurationSeconds: 60, chunkTimeoutMs: 120_000 } },
    }));
    const bounded = await loadLectureResearchConfig(cwd);
    assert.equal(bounded.pipeline?.asr.chunkDurationSeconds, 60);
    assert.equal(bounded.pipeline?.asr.chunkTimeoutMs, 120_000);
    await writeFile(join(cwd, ".omp", "lecture-research.json"), JSON.stringify({
      ...base,
      pipeline: { ...base.pipeline, asr: { ...base.pipeline.asr, chunkDurationSeconds: 61 } },
    }));
    await assert.rejects(loadLectureResearchConfig(cwd), /Invalid pipeline\.asr\.chunkDurationSeconds/);
    await writeFile(join(cwd, ".omp", "lecture-research.json"), JSON.stringify({
      ...base,
      pipeline: { ...base.pipeline, asr: { provider: "hosted-openai-compatible", trust: "local-loopback", endpoint: "http://127.0.0.1:9000/v1", chunkDurationSeconds: 1 } },
    }));
    await assert.rejects(loadLectureResearchConfig(cwd), /Legacy ASR providers/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
