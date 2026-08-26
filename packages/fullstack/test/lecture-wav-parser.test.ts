import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EphemeralAudio, LectureAcquisitionRequest, PipelineLimits, ResolvedVideoSource } from "@andvl1/omp-workflows-core";
import { OpenRouterNativeAsr } from "../src/lecture-acquisition/asr-openrouter.js";
import { BoundedAudioPreprocessor } from "../src/lecture-acquisition/audio-preprocess.js";
import { AcquisitionProviderError } from "../src/lecture-acquisition/provider-errors.js";

const source: ResolvedVideoSource = {
  sourceId: "yt-video-wav-fixture",
  videoId: "wav-fixture",
  canonicalUrl: "https://www.youtube.com/watch?v=wav-fixture",
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
    maxAudioBytes: 2_000_000,
    maxTranscriptCharacters: 10_000,
    maxTranscriptSegments: 32,
    maxChunkCharacters: 128,
    maxChunksPerSource: 16,
    maxProviderCostCents: 5_000,
    maxAnalysisOutputBytes: 8_192,
  },
  rights: { automatedPublicVideoAnalysisApproved: true, ownedCaptionAccessApproved: false, ownedMediaAudioAccessApproved: true },
  mediaMode: "owned-audio",
};

const preprocessLimits: PipelineLimits = {
  maxAudioBytes: 2_000_000,
  maxTranscriptCharacters: 10_000,
  maxTranscriptSegments: 32,
  maxChunkCharacters: 128,
  maxChunksPerSource: 16,
  maxAnalysisOutputBytes: 8_192,
};

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function riffChunk(id: string, payload: Uint8Array, declaredSize = payload.byteLength): Uint8Array {
  assert.equal(id.length, 4);
  const actualPayload = payload.subarray(0, Math.min(payload.byteLength, declaredSize));
  const output = new Uint8Array(8 + actualPayload.byteLength + (actualPayload.byteLength & 1));
  output.set(asciiBytes(id), 0);
  new DataView(output.buffer).setUint32(4, declaredSize, true);
  output.set(actualPayload, 8);
  return output;
}

function pcmWav(options: {
  frameCount: number;
  riffSentinel?: boolean;
  dataSentinel?: boolean;
  beforeData?: Array<{ id: string; payload: Uint8Array; declaredSize?: number }>;
  afterData?: Array<{ id: string; payload: Uint8Array; declaredSize?: number }>;
}): { bytes: Uint8Array; pcm: Uint8Array; durationSeconds: number } {
  const pcm = Uint8Array.from({ length: options.frameCount * 2 }, (_, index) => index & 0xff);
  const fmt = new Uint8Array(16);
  const fmtView = new DataView(fmt.buffer);
  fmtView.setUint16(0, 1, true);
  fmtView.setUint16(2, 1, true);
  fmtView.setUint32(4, 16_000, true);
  fmtView.setUint32(8, 32_000, true);
  fmtView.setUint16(12, 2, true);
  fmtView.setUint16(14, 16, true);
  const chunks = [
    riffChunk("fmt ", fmt),
    ...(options.beforeData ?? []).map(({ id, payload, declaredSize }) => riffChunk(id, payload, declaredSize)),
    riffChunk("data", pcm, options.dataSentinel ? 0xffff_ffff : pcm.byteLength),
    ...(options.afterData ?? []).map(({ id, payload, declaredSize }) => riffChunk(id, payload, declaredSize)),
  ];
  const totalBytes = 12 + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalBytes);
  output.set(asciiBytes("RIFF"), 0);
  new DataView(output.buffer).setUint32(4, options.riffSentinel ? 0xffff_ffff : totalBytes - 8, true);
  output.set(asciiBytes("WAVE"), 8);
  let offset = 12;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: output, pcm, durationSeconds: options.frameCount / 16_000 };
}

function missingDataWav(): Uint8Array {
  const fmt = new Uint8Array(16);
  const view = new DataView(fmt.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, 1, true);
  view.setUint32(4, 16_000, true);
  view.setUint32(8, 32_000, true);
  view.setUint16(12, 2, true);
  view.setUint16(14, 16, true);
  const fmtChunk = riffChunk("fmt ", fmt);
  const output = new Uint8Array(12 + fmtChunk.byteLength);
  output.set(asciiBytes("RIFF"), 0);
  new DataView(output.buffer).setUint32(4, output.byteLength - 8, true);
  output.set(asciiBytes("WAVE"), 8);
  output.set(fmtChunk, 12);
  return output;
}

function streamedAudio(bytes: Uint8Array, sliceBytes = 7): EphemeralAudio & { openCount: number; returnCount: number } {
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
            for (let offset = 0; offset < bytes.byteLength; offset += sliceBytes) {
              yield bytes.subarray(offset, Math.min(offset + sliceBytes, bytes.byteLength));
            }
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

function options(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return {
    endpoint: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    env: { OPENROUTER_API_KEY: "test-key" },
    maxInputBytes: 1,
    maxRequestBytes: 100_000,
    maxResponseBytes: 8_192,
    maxTranscriptCharacters: 10_000,
    maxSegments: 32,
    maxChunkCharacters: 128,
    chunkDurationSeconds: 1,
    chunkTimeoutMs: 100,
    fetch,
    ...overrides,
  };
}

function asrRequest(overrides: Partial<LectureAcquisitionRequest["limits"]> = {}): LectureAcquisitionRequest {
  return {
    ...request,
    limits: { ...request.limits, ...overrides },
  };
}

test("WAV chunk walking accepts ffmpeg-pipe sentinel RIFF/data with LIST at offset 36", async () => {
  const fixture = pcmWav({
    frameCount: 40_000,
    riffSentinel: true,
    dataSentinel: true,
    beforeData: [{ id: "LIST", payload: new Uint8Array(26).fill(7) }],
  });
  const view = new DataView(fixture.bytes.buffer, fixture.bytes.byteOffset, fixture.bytes.byteLength);
  assert.equal(view.getUint32(4, true), 0xffff_ffff);
  assert.equal(String.fromCharCode(...fixture.bytes.subarray(36, 40)), "LIST");
  assert.equal(String.fromCharCode(...fixture.bytes.subarray(70, 74)), "data");
  assert.equal(view.getUint32(74, true), 0xffff_ffff);

  const audio = streamedAudio(fixture.bytes, 5);
  const dataBytes: number[] = [];
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: Array<{ input_audio: { data: string } }> }> };
    const wav = new Uint8Array(Buffer.from(body.messages[0]!.content[0]!.input_audio.data, "base64"));
    const chunkView = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    dataBytes.push(chunkView.getUint32(40, true));
    const duration = chunkView.getUint32(40, true) / 32_000;
    return new Response(JSON.stringify({ segments: [{ id: "chunk", text: "ok", start_seconds: 0, end_seconds: duration }] }), { status: 200 });
  };
  const result = await new OpenRouterNativeAsr(options(fetch)).transcribe(audio, source, asrRequest(), new AbortController().signal);
  assert.equal(audio.openCount, 1);
  assert.equal(audio.returnCount, 1);
  assert.deepEqual(dataBytes, [32_000, 32_000, 16_000]);
  assert.equal(result.usage?.requests, 3);
  assert.equal(result.usage?.requestedAudioSeconds, 2.5);
  assert.deepEqual(result.segments.map((segment) => segment.segmentId), ["chunk-0-segment-0", "chunk-1-segment-0", "chunk-2-segment-0"]);
  assert.deepEqual(result.segments.map((segment) => [segment.startSeconds, segment.endSeconds]), [[0, 1], [1, 2], [2, 2.5]]);
});

test("finite RIFF/data sizes remain compatible and preprocessor derives true data duration", async () => {
  const fixture = pcmWav({ frameCount: 16_000, beforeData: [{ id: "JUNK", payload: Uint8Array.from([1, 2, 3]) }] });
  const audio = streamedAudio(fixture.bytes, 3);
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };
  const result = await new OpenRouterNativeAsr(options(fetch)).transcribe(audio, source, asrRequest(), new AbortController().signal);
  assert.equal(fetchCount, 1);
  assert.equal(result.usage?.requestedAudioSeconds, 1);

  const directory = await mkdtemp(join(tmpdir(), "omp-wav-metadata-"));
  try {
    const prepared = await new BoundedAudioPreprocessor({ tempDirectory: directory }).prepare({
      format: "audio/wav",
      sizeBytes: fixture.bytes.byteLength,
      async open() {
        return streamedAudio(fixture.bytes, 11).open(new AbortController().signal);
      },
      async dispose() {},
    }, preprocessLimits, new AbortController().signal);
    assert.equal(prepared.durationSeconds, fixture.durationSeconds);
    await prepared.dispose();
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-prepared-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed, truncated, overflow, missing-data, and unsupported PCM WAVs fail before POST", async () => {
  const valid = pcmWav({ frameCount: 16_000 }).bytes;
  const overflow = pcmWav({ frameCount: 16_000, beforeData: [{ id: "LIST", payload: Uint8Array.from([1, 2, 3]) }] }).bytes;
  new DataView(overflow.buffer).setUint32(40, 0xffff_fffe, true);
  const unsupported = new Uint8Array(valid);
  new DataView(unsupported.buffer).setUint16(22, 2, true);
  const malformed = new Uint8Array(valid);
  malformed.set(asciiBytes("NOPE"), 0);
  const validPrefixBadTail = new Uint8Array(valid.byteLength + 8);
  validPrefixBadTail.set(valid);
  validPrefixBadTail.set(asciiBytes("JUNK"), valid.byteLength);
  new DataView(validPrefixBadTail.buffer).setUint32(valid.byteLength + 4, 0xffff_fffe, true);
  new DataView(validPrefixBadTail.buffer).setUint32(4, validPrefixBadTail.byteLength - 8, true);
  const cases = [
    { name: "truncated", bytes: valid.subarray(0, valid.byteLength - 1) },
    { name: "overflow", bytes: overflow },
    { name: "missing data", bytes: missingDataWav() },
    { name: "unsupported PCM", bytes: unsupported },
    { name: "malformed header", bytes: malformed },
    { name: "valid prefix with malformed tail", bytes: validPrefixBadTail },
  ];
  let fetchCount = 0;
  const fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ text: "must not be sent" }), { status: 200 });
  };
  for (const item of cases) {
    await assert.rejects(
      new OpenRouterNativeAsr(options(fetch)).transcribe(streamedAudio(item.bytes), source, asrRequest(), new AbortController().signal),
      (error: unknown) => error instanceof AcquisitionProviderError && error.code === "MEDIA_NOT_ACCESSIBLE" && error.retryable === false,
      item.name,
    );
  }
  assert.equal(fetchCount, 0);
});

test("preprocessor rejects malformed sentinel output and cleans its prepared directory", async () => {
  const fixture = pcmWav({ frameCount: 16_000, riffSentinel: true, dataSentinel: true });
  const malformed = fixture.bytes.subarray(0, fixture.bytes.byteLength - 1);
  const directory = await mkdtemp(join(tmpdir(), "omp-wav-invalid-"));
  try {
    await assert.rejects(
      () => new BoundedAudioPreprocessor({ tempDirectory: directory }).prepare({
        format: "audio/wav",
        sizeBytes: malformed.byteLength,
        async open() {
          return (async function* () { yield malformed; })();
        },
        async dispose() {},
      }, preprocessLimits, new AbortController().signal),
      (error: unknown) => error instanceof AcquisitionProviderError && error.code === "MEDIA_NOT_ACCESSIBLE" && error.retryable === false,
    );
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-prepared-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("preprocessor reconciles sentinel sizes against actual prepared EOF", async () => {
  const fixture = pcmWav({
    frameCount: 16_000,
    riffSentinel: true,
    dataSentinel: true,
    beforeData: [{ id: "LIST", payload: new Uint8Array(26).fill(3) }],
  });
  const directory = await mkdtemp(join(tmpdir(), "omp-wav-sentinel-preprocess-"));
  try {
    const prepared = await new BoundedAudioPreprocessor({ tempDirectory: directory }).prepare({
      format: "audio/wav",
      sizeBytes: fixture.bytes.byteLength,
      async open() {
        return (async function* () {
          for (let offset = 0; offset < fixture.bytes.byteLength; offset += 11) yield fixture.bytes.subarray(offset, Math.min(offset + 11, fixture.bytes.byteLength));
        })();
      },
      async dispose() {},
    }, preprocessLimits, new AbortController().signal);
    assert.equal(prepared.sizeBytes, fixture.bytes.byteLength);
    assert.equal(prepared.durationSeconds, fixture.durationSeconds);
    await prepared.dispose();
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-prepared-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
