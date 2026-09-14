import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ACQUISITION_LIMITS, type EphemeralAudio, type LectureAcquisitionRequest, type ResolvedVideoSource } from "@andvl1/omp-workflows-core";
import { HostedAsr, type HostedAsrOptions } from "../src/lecture-acquisition/asr-hosted.js";

const source: ResolvedVideoSource = {
  sourceId: "yt-video-hosted01",
  videoId: "hosted01",
  canonicalUrl: "https://www.youtube.com/watch?v=hosted01",
};
const request: LectureAcquisitionRequest = {
  sourceUrl: source.canonicalUrl,
  prompt: "Extract the bounded claim",
  limits: { ...DEFAULT_ACQUISITION_LIMITS },
  mediaMode: "owned-audio",
  rights: {
    automatedPublicVideoAnalysisApproved: true,
    ownedCaptionAccessApproved: false,
    ownedMediaAudioAccessApproved: true,
  },
};

const resultBody = JSON.stringify({ segments: [{ text: "bounded claim", start: 0, end: 1 }] });

type IteratorState = {
  nextCalls: number;
  returnCalls: number;
};

function trackedAudio(makeIterator: (state: IteratorState) => AsyncIterator<Uint8Array>): { audio: EphemeralAudio; state: IteratorState; openCalls: number } {
  const state: IteratorState = { nextCalls: 0, returnCalls: 0 };
  let openCalls = 0;
  return {
    audio: {
      format: "audio/wav",
      sizeBytes: 1,
      async open() {
        openCalls += 1;
        const iterator = makeIterator(state);
        return { [Symbol.asyncIterator]: () => iterator };
      },
      async dispose() {},
    },
    state,
    get openCalls() {
      return openCalls;
    },
  };
}

function asr(fetch: HostedAsrOptions["fetch"]): HostedAsr {
  return new HostedAsr({
    endpoint: "https://api.example.test/v1",
    trust: "trusted-remote",
    apiKeyEnv: "FIXTURE_KEY",
    env: { FIXTURE_KEY: "fixture-key" },
    model: "fixture-model",
    maxResponseBytes: 4096,
    maxTranscriptCharacters: 1024,
    fetch,
  });
}

function requestBody(init: RequestInit | undefined): ReadableStream<Uint8Array> {
  assert.ok(init?.body instanceof ReadableStream, "hosted ASR must send a streaming multipart body");
  return init.body as ReadableStream<Uint8Array>;
}

test("hosted ASR cleans an unopened multipart stream when fetch rejects", async () => {
  const tracked = trackedAudio(() => ({
    async next() {
      tracked.state.nextCalls += 1;
      return { done: true, value: undefined };
    },
    async return() {
      tracked.state.returnCalls += 1;
      return { done: true, value: undefined };
    },
  }));
  const provider = asr(async () => {
    throw new Error("fetch rejected before consuming request body");
  });

  await assert.rejects(() => provider.transcribe(tracked.audio, source, request, new AbortController().signal), /provider request could not be completed/);
  assert.equal(tracked.openCalls, 0, "fetch rejection before consumption must not open the audio lease");
  assert.equal(tracked.state.nextCalls, 0);
  assert.equal(tracked.state.returnCalls, 0, "there is no iterator to close before the body is opened");
});

test("hosted ASR cancellation returns the pending iterator once and does not pull again", async () => {
  const pending: { resolve?: (result: IteratorResult<Uint8Array>) => void } = {};
  const tracked = trackedAudio(() => ({
    async next() {
      tracked.state.nextCalls += 1;
      return new Promise<IteratorResult<Uint8Array>>((resolve) => { pending.resolve = resolve; });
    },
    async return() {
      tracked.state.returnCalls += 1;
      pending.resolve?.({ done: true, value: undefined });
      return { done: true, value: undefined };
    },
  }));
  const provider = asr(async (_url, init) => {
    const reader = requestBody(init).getReader();
    await reader.read(); // multipart prefix
    const pendingRead = reader.read(); // opens the audio and waits in iterator.next()
    while (tracked.state.nextCalls === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    await reader.cancel("request cancelled");
    await pendingRead;
    return new Response(resultBody, { status: 200, headers: { "content-type": "application/json" } });
  });

  const result = await provider.transcribe(tracked.audio, source, request, new AbortController().signal);
  assert.equal(result.segments.length, 1);
  assert.equal(tracked.state.nextCalls, 1, "cancel must not trigger another iterator.next call");
  assert.equal(tracked.state.returnCalls, 1, "cancel must close the iterator exactly once");
});

test("hosted ASR returns an iterator exactly once when pulling it throws", async () => {
  const tracked = trackedAudio(() => ({
    async next() {
      tracked.state.nextCalls += 1;
      throw new Error("iterator failed");
    },
    async return() {
      tracked.state.returnCalls += 1;
      return { done: true, value: undefined };
    },
  }));
  const provider = asr(async (_url, init) => {
    const reader = requestBody(init).getReader();
    await reader.read();
    await assert.rejects(() => reader.read(), /iterator failed/);
    throw new Error("request failed after iterator error");
  });

  await assert.rejects(() => provider.transcribe(tracked.audio, source, request, new AbortController().signal), /provider request could not be completed/);
  assert.equal(tracked.state.nextCalls, 1);
  assert.equal(tracked.state.returnCalls, 1, "pull failure must close the iterator exactly once");
});

test("hosted ASR closes the iterator exactly once after normal multipart completion", async () => {
  const tracked = trackedAudio(() => ({
    async next() {
      tracked.state.nextCalls += 1;
      return tracked.state.nextCalls === 1
        ? { done: false, value: new Uint8Array([1, 2, 3]) }
        : { done: true, value: undefined };
    },
    async return() {
      tracked.state.returnCalls += 1;
      return { done: true, value: undefined };
    },
  }));
  const provider = asr(async (_url, init) => {
    const body = await new Response(requestBody(init)).arrayBuffer();
    assert.ok(body.byteLength > 0);
    return new Response(resultBody, { status: 200, headers: { "content-type": "application/json" } });
  });

  const result = await provider.transcribe(tracked.audio, source, request, new AbortController().signal);
  assert.equal(result.segments.length, 1);
  assert.equal(tracked.state.nextCalls, 2);
  assert.equal(tracked.state.returnCalls, 1, "normal completion must close the iterator exactly once");
});

test("hosted ASR retry starts a fresh body and closes each attempt once", async () => {
  let fetchCalls = 0;
  const tracked = trackedAudio(() => ({
    async next() {
      tracked.state.nextCalls += 1;
      if (fetchCalls === 1) throw new Error("first iterator failed");
      return tracked.state.nextCalls === 2
        ? { done: false, value: new Uint8Array([1]) }
        : { done: true, value: undefined };
    },
    async return() {
      tracked.state.returnCalls += 1;
      return { done: true, value: undefined };
    },
  }));
  const provider = asr(async (_url, init) => {
    fetchCalls += 1;
    const reader = requestBody(init).getReader();
    await reader.read();
    if (fetchCalls === 1) {
      await assert.rejects(() => reader.read(), /first iterator failed/);
      throw new Error("retryable request failure");
    }
    await reader.read();
    await reader.read();
    return new Response(resultBody, { status: 200, headers: { "content-type": "application/json" } });
  });

  await assert.rejects(() => provider.transcribe(tracked.audio, source, request, new AbortController().signal), /provider request could not be completed/);
  const result = await provider.transcribe(tracked.audio, source, request, new AbortController().signal);
  assert.equal(result.segments.length, 1);
  assert.equal(fetchCalls, 2);
  assert.equal(tracked.state.returnCalls, 2, "each retry body must close its iterator once");
});
