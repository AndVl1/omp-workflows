import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACQUISITION_LIMITS, type LectureAcquisitionRequest, type ResolvedVideoSource } from "@andvl1/omp-workflows-core";
import { WhisperLocalAsr } from "../src/lecture-acquisition/asr-local-whisper.js";
import { AcquisitionProviderError } from "../src/lecture-acquisition/provider-errors.js";

const source: ResolvedVideoSource = { sourceId: "yt-video-whisper-fixture", videoId: "whisper-fixture", canonicalUrl: "https://www.youtube.com/watch?v=whisper-fixture" };
const request: LectureAcquisitionRequest = {
  sourceUrl: source.canonicalUrl,
  prompt: "transcribe",
  limits: { ...DEFAULT_ACQUISITION_LIMITS },
  mediaMode: "owned-audio",
  rights: { automatedPublicVideoAnalysisApproved: true, ownedCaptionAccessApproved: false, ownedMediaAudioAccessApproved: true },
};

type StreamListenerCounts = {
  stdinError: number;
  stdinDrain: number;
  stdinClose: number;
  stdoutError: number;
  stdoutClose: number;
  stderrError: number;
  childError: number;
  childClose: number;
};

function streamListenerCounts(child: ChildProcessWithoutNullStreams): StreamListenerCounts {
  return {
    stdinError: child.stdin.listenerCount("error"),
    stdinDrain: child.stdin.listenerCount("drain"),
    stdinClose: child.stdin.listenerCount("close"),
    stdoutError: child.stdout.listenerCount("error"),
    stdoutClose: child.stdout.listenerCount("close"),
    stderrError: child.stderr.listenerCount("error"),
    childError: child.listenerCount("error"),
    childClose: child.listenerCount("close"),
  };
}

function backpressuredWhisperScript(exitCode: number, malformed: boolean): string {
  return `
process.stdin.on("data", () => {
  process.stdin.pause();
  setImmediate(() => process.stdin.resume());
});
process.stdin.on("end", () => {
  const output = ${malformed ? JSON.stringify("malformed-whisper-output") : JSON.stringify(JSON.stringify({ segments: [{ text: "bounded transcript", start_seconds: 0, end_seconds: 1 }] }))};
  process.stdout.end(output, () => setImmediate(() => process.exit(${exitCode})));
});
`;
}

function termImmuneWhisperScript(): string {
  return `
process.stdin.resume();
process.once("SIGTERM", () => {});
// Integration fixture: the production timeout must reap a process that ignores TERM.
setInterval(() => {}, 1_000);
`;
}

function backpressuredAudio() {
  return {
    format: "audio/raw",
    sizeBytes: 32 * 64 * 1024,
    async open() {
      return (async function* () {
        for (let index = 0; index < 32; index += 1) yield new Uint8Array(64 * 1024);
      })();
    },
    async dispose() {},
  };
}

function whisperOptions(spawnFixture: typeof spawn, timeoutMs = 2_000) {
  return {
    binaryPath: "local-whisper-fixture",
    modelPath: "model.fixture",
    maxOutputBytes: 16 * 1024,
    maxTranscriptCharacters: 4_096,
    timeoutMs,
    spawn: spawnFixture,
  };
}

test("local Whisper owns one stdin error listener across 20 backpressured cycles", { concurrency: false }, async () => {
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
  };
  try {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      let child: ChildProcessWithoutNullStreams | undefined;
      let before: StreamListenerCounts | undefined;
      const spawnFixture = ((_: string, __: string[], options: Parameters<typeof spawn>[2]) => {
        child = spawn(process.execPath, ["-e", backpressuredWhisperScript(0, false)], options) as ChildProcessWithoutNullStreams;
        before = streamListenerCounts(child);
        return child;
      }) as typeof spawn;
      const result = await new WhisperLocalAsr(whisperOptions(spawnFixture)).transcribe(backpressuredAudio(), source, request, new AbortController().signal);
      assert.deepEqual(result.segments.map((segment) => ({ text: segment.text, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds })), [{ text: "bounded transcript", startSeconds: 0, endSeconds: 1 }]);
      assert.equal("raw" in result, false);
      assert.ok(child);
      assert.ok(before);
      if (!child || !before) throw new Error("fixture child was not spawned");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(child.exitCode, 0);
      assert.deepEqual(streamListenerCounts(child), before);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, []);
  } finally {
    process.removeListener("warning", onWarning);
  }
});

test("local Whisper preserves typed child failure after backpressure cleanup", { concurrency: false }, async () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let before: StreamListenerCounts | undefined;
  const spawnFixture = ((_: string, __: string[], options: Parameters<typeof spawn>[2]) => {
    child = spawn(process.execPath, ["-e", backpressuredWhisperScript(7, true)], options) as ChildProcessWithoutNullStreams;
    before = streamListenerCounts(child);
    return child;
  }) as typeof spawn;
  const operation = new WhisperLocalAsr(whisperOptions(spawnFixture)).transcribe(backpressuredAudio(), source, request, new AbortController().signal);
  await assert.rejects(operation, (error: unknown) => error instanceof AcquisitionProviderError && error.code === "TRANSCRIPT_FAILED" && error.retryable === false);
  assert.ok(child);
  assert.ok(before);
  if (!child || !before) throw new Error("fixture child was not spawned");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(child.exitCode, 7);
  assert.deepEqual(streamListenerCounts(child), before);
});

test("TERM-immune local Whisper escalates once to SIGKILL and cleans listeners", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-whisper-term-immune-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  let before: StreamListenerCounts | undefined;
  const killCalls: Array<NodeJS.Signals | number | undefined> = [];
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
  };
  const spawnFixture = ((_: string, __: string[], options: Parameters<typeof spawn>[2]) => {
    child = spawn(process.execPath, ["-e", termImmuneWhisperScript()], options) as ChildProcessWithoutNullStreams;
    const originalKill = child.kill.bind(child);
    child.kill = ((signal?: NodeJS.Signals | number) => {
      killCalls.push(signal);
      return originalKill(signal);
    }) as typeof child.kill;
    before = streamListenerCounts(child);
    return child;
  }) as typeof spawn;
  try {
    const operation = new WhisperLocalAsr(whisperOptions(spawnFixture, 100)).transcribe(backpressuredAudio(), source, request, new AbortController().signal);
    // Real wall-clock guard intentionally bounds the TERM-immune child integration fixture.
    const bounded = Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("TERM-immune Whisper did not settle")), 2_000);
        timer.unref?.();
      }),
    ]);
    await assert.rejects(bounded, (error: unknown) => error instanceof AcquisitionProviderError && error.code === "PROVIDER_TIMEOUT" && error.retryable === false);
    assert.ok(child);
    assert.ok(before);
    if (!child || !before) throw new Error("fixture child was not spawned");
    assert.equal(killCalls.filter((signal) => signal === "SIGTERM").length, 1);
    assert.equal(killCalls.filter((signal) => signal === "SIGKILL").length, 1);
    assert.equal(child.signalCode, "SIGKILL");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(streamListenerCounts(child), before);
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-")), []);
    assert.deepEqual(warnings, []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    process.removeListener("warning", onWarning);
    await rm(directory, { recursive: true, force: true });
  }
});
