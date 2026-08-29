import { createReadStream } from "node:fs";
import { test } from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";

import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACQUISITION_LIMITS, type LectureAcquisitionRequest, type PipelineLimits, type ResolvedVideoSource } from "@andvl1/omp-workflows-core";
import { AuthorizedAudioAcquirer } from "../src/lecture-acquisition/media.js";
import { BoundedAudioPreprocessor } from "../src/lecture-acquisition/audio-preprocess.js";
import { AcquisitionProviderError } from "../src/lecture-acquisition/provider-errors.js";
import { WritableFileOwner } from "../src/lecture-acquisition/writable-file-owner.js";

const source: ResolvedVideoSource = { sourceId: "yt-video-fixture02", videoId: "fixture02", canonicalUrl: "https://www.youtube.com/watch?v=fixture02" };

function wavFixture(): Uint8Array {
  const bytes = new Uint8Array(44 + 32_000);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) bytes.set(new TextEncoder().encode(value), offset);
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, 32_000, true);
  return bytes;
}
const request: LectureAcquisitionRequest = { sourceUrl: source.canonicalUrl, prompt: "bounded", limits: { ...DEFAULT_ACQUISITION_LIMITS }, mediaMode: "owned-audio", rights: { automatedPublicVideoAnalysisApproved: true, ownedCaptionAccessApproved: false, ownedMediaAudioAccessApproved: true } };

test("authorized existing input returns an ephemeral disposable handle", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-media-test-"));
  const input = join(directory, "owned-audio.fixture");
  await writeFile(input, new Uint8Array([1, 2, 3, 4]));
  try {
    const acquirer = new AuthorizedAudioAcquirer({ provider: "existing-input", inputPath: input, maxBytes: 32, timeoutMs: 1_000, tempDirectory: directory });
    const audio = await acquirer.acquire(source, request, new AbortController().signal);
    const temporaryEntry = (await readdir(directory)).find((entry) => entry.startsWith("omp-lecture-"));
    assert.ok(temporaryEntry, "media acquisition creates a bounded temporary directory");
    if (!temporaryEntry) throw new Error("temporary directory was not created");
    const temporaryDirectory = join(directory, temporaryEntry);
    const stream = await audio.open(new AbortController().signal);
    let size = 0;
    for await (const chunk of stream) size += chunk.byteLength;
    assert.equal(size, 4);
    await audio.dispose();
    await audio.dispose();
    await assert.rejects(() => access(temporaryDirectory));
    await assert.rejects(() => audio.open(new AbortController().signal), AcquisitionProviderError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("existing-input inner deadline is a typed non-retryable timeout with one attempt and no temp leak", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-media-timeout-"));
  const input = join(directory, "owned-audio.fixture");
  try {
    await writeFile(input, new Uint8Array(16 * 1024 * 1024));
    const acquirer = new AuthorizedAudioAcquirer({ provider: "existing-input", inputPath: input, maxBytes: 32 * 1024 * 1024, timeoutMs: 1, tempDirectory: directory });
    let attempts = 0;
    const operation = (async () => {
      attempts += 1;
      return acquirer.acquire(source, request, new AbortController().signal);
    })();
    await assert.rejects(operation, (error: unknown) => error instanceof AcquisitionProviderError && error.code === "PROVIDER_TIMEOUT" && error.retryable === false);
    assert.equal(attempts, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-lecture-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing-input deadline owns a stream created before the pre-open abort", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-media-race-"));
  const input = join(directory, "owned-audio.fixture");
  let stream: ReturnType<typeof createReadStream> | undefined;
  let baselineErrorListeners = -1;
  const uncaught: unknown[] = [];
  const unhandled: unknown[] = [];
  const warnings: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  const onWarning = (warning: unknown): void => { warnings.push(warning); };
  const readStreamFactory = ((path: string, options?: { signal?: AbortSignal }) => {
    const created = createReadStream(path, options);
    stream = created;
    baselineErrorListeners = created.listenerCount("error");
    const stallUntil = Date.now() + 8;
    while (Date.now() < stallUntil) {}
    return created;
  }) as typeof createReadStream;
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  process.on("warning", onWarning);
  try {
    await writeFile(input, new Uint8Array(16 * 1024 * 1024));
    const acquirer = new AuthorizedAudioAcquirer({ provider: "existing-input", inputPath: input, maxBytes: 32 * 1024 * 1024, timeoutMs: 1, tempDirectory: directory, readStreamFactory });
    let attempts = 0;
    let rejections = 0;
    const operation = (async () => {
      attempts += 1;
      return acquirer.acquire(source, request, new AbortController().signal);
    })().catch((error: unknown) => {
      rejections += 1;
      throw error;
    });
    await assert.rejects(operation, (error: unknown) => error instanceof AcquisitionProviderError && error.code === "PROVIDER_TIMEOUT" && error.retryable === false);
    assert.equal(attempts, 1);
    assert.equal(rejections, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(stream, "the read stream was created before the deadline");
    if (!stream) throw new Error("read stream fixture did not run");
    assert.equal(stream.listenerCount("error"), baselineErrorListeners, "the synchronous owner is disposed after close");
    assert.equal(stream.destroyed, true);
    assert.equal(stream.closed, true);
    assert.deepEqual(uncaught, []);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-lecture-")), []);
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUnhandled);
    process.removeListener("warning", onWarning);
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing-input stream errors stay owned through close and cleanup", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-media-stream-error-"));
  const input = join(directory, "owned-audio.fixture");
  const streamError = new Error("fixture stream failure");
  let stream: ReturnType<typeof createReadStream> | undefined;
  let baselineErrorListeners = -1;
  const uncaught: unknown[] = [];
  const unhandled: unknown[] = [];
  const warnings: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  const onWarning = (warning: unknown): void => { warnings.push(warning); };
  const readStreamFactory = ((path: string, options?: { signal?: AbortSignal }) => {
    const created = createReadStream(path, options);
    stream = created;
    baselineErrorListeners = created.listenerCount("error");
    queueMicrotask(() => created.destroy(streamError));
    return created;
  }) as typeof createReadStream;
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  process.on("warning", onWarning);
  try {
    await writeFile(input, new Uint8Array([1, 2, 3, 4]));
    const acquirer = new AuthorizedAudioAcquirer({ provider: "existing-input", inputPath: input, maxBytes: 32, timeoutMs: 1_000, tempDirectory: directory, readStreamFactory });
    await assert.rejects(() => acquirer.acquire(source, request, new AbortController().signal), (error: unknown) => error === streamError);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(stream);
    if (!stream) throw new Error("read stream fixture did not run");
    assert.equal(stream.listenerCount("error"), baselineErrorListeners);
    assert.equal(stream.destroyed, true);
    assert.equal(stream.closed, true);
    assert.deepEqual(uncaught, []);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-lecture-")), []);
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUnhandled);
    process.removeListener("warning", onWarning);
    await rm(directory, { recursive: true, force: true });
  }
});

test("authorized input enforces byte bounds and rights before opening media", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-media-limit-"));
  const input = join(directory, "owned-audio.fixture");
  await writeFile(input, new Uint8Array([1, 2, 3, 4]));
  try {
    const tooSmall = new AuthorizedAudioAcquirer({ provider: "existing-input", inputPath: input, maxBytes: 3, timeoutMs: 1_000, tempDirectory: directory });
    await assert.rejects(() => tooSmall.acquire(source, request, new AbortController().signal), (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED");
    const noRights = new AuthorizedAudioAcquirer({ provider: "existing-input", inputPath: input, maxBytes: 32, timeoutMs: 1_000, tempDirectory: directory });
    await assert.rejects(() => noRights.acquire(source, { ...request, rights: { ...request.rights, ownedMediaAudioAccessApproved: false } }, new AbortController().signal), (error: unknown) => error instanceof AcquisitionProviderError && error.code === "RIGHTS_REQUIRED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audio preprocessing removes temporary parent directories on dispose, duration violation, and invalid input", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-preprocess-test-"));
  const limits: PipelineLimits = { maxAudioBytes: 64 * 1024, maxTranscriptCharacters: 64 * 1024, maxTranscriptSegments: 256, maxChunkCharacters: 1024, maxChunksPerSource: 128, maxAnalysisOutputBytes: 4096 };
  const media = {
    format: "audio/wav",
    sizeBytes: wavFixture().byteLength,
    async open() {
      const bytes = wavFixture();
      return (async function* () { yield bytes; })();
    },
    async dispose() {},
  };
  try {
    const preprocessor = new BoundedAudioPreprocessor({ tempDirectory: directory });
    const prepared = await preprocessor.prepare(media, limits, new AbortController().signal);
    const successEntry = (await readdir(directory)).find((entry) => entry.startsWith("omp-prepared-"));
    assert.ok(successEntry);
    if (!successEntry) throw new Error("preprocessing temporary directory was not created");
    const successDirectory = join(directory, successEntry);
    await prepared.dispose();
    await prepared.dispose();
    await assert.rejects(() => access(successDirectory));

    await assert.rejects(
      () => preprocessor.prepare(media, { ...limits, maxDurationSeconds: 0.5 }, new AbortController().signal),
      (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED",
    );
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-prepared-")), []);

    const invalidMedia = { ...media, async open() { return (async function* () { yield new Uint8Array([1, 2, 3]); })(); } };
    await assert.rejects(() => preprocessor.prepare(invalidMedia, limits, new AbortController().signal), AcquisitionProviderError);
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-prepared-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("audio preprocessing awaits stream cleanup after a passthrough overflow", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-preprocess-overflow-"));
  const limits: PipelineLimits = { maxAudioBytes: 64, maxTranscriptCharacters: 64 * 1024, maxTranscriptSegments: 256, maxChunkCharacters: 1024, maxChunksPerSource: 128, maxAnalysisOutputBytes: 4096 };
  const media = {
    format: "audio/wav",
    sizeBytes: 65,
    async open() {
      return (async function* () {
        yield new Uint8Array(32);
        yield new Uint8Array(33);
      })();
    },
    async dispose() {},
  };
  try {
    let rejectionCount = 0;
    const rejection = new BoundedAudioPreprocessor({ tempDirectory: directory }).prepare(media, limits, new AbortController().signal).catch((error: unknown) => {
      rejectionCount += 1;
      throw error;
    });
    await assert.rejects(rejection, (error: unknown) => error instanceof AcquisitionProviderError && error.code === "LIMIT_EXCEEDED");
    assert.equal(rejectionCount, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-prepared-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audio preprocessing owns pre-setup Readable aborts and errors through cleanup", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-preprocess-pre-setup-"));
  const limits: PipelineLimits = { maxAudioBytes: 64, maxTranscriptCharacters: 64 * 1024, maxTranscriptSegments: 256, maxChunkCharacters: 1024, maxChunksPerSource: 128, maxAnalysisOutputBytes: 4096 };
  const uncaught: unknown[] = [];
  const unhandled: unknown[] = [];
  const warnings: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  const onWarning = (warning: unknown): void => { warnings.push(warning); };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  process.on("warning", onWarning);
  try {
    const run = async (mode: "abort" | "error"): Promise<void> => {
      const controller = new AbortController();
      const sourceError = new Error("pre-setup source failure");
      let stream: Readable | undefined;
      const media = {
        format: "audio/wav",
        sizeBytes: 1,
        async open() {
          const created = new Readable({ read() {} });
          stream = created;
          if (mode === "abort") {
            controller.signal.addEventListener("abort", () => {
              created.destroy(Object.assign(new Error("pre-setup abort"), { name: "AbortError", code: "ABORT_ERR" }));
            }, { once: true });
          }
          setTimeout(() => {
            if (mode === "abort") controller.abort();
            else created.destroy(sourceError);
          }, 0);
          return created;
        },
        async dispose() {},
      };
      const operation = new BoundedAudioPreprocessor({ tempDirectory: directory }).prepare(media, limits, controller.signal);
      if (mode === "abort") {
        await assert.rejects(operation, (error: unknown) => error instanceof AcquisitionProviderError && error.code === "PROVIDER_TIMEOUT" && error.retryable === false);
      } else {
        await assert.rejects(operation, (error: unknown) => error === sourceError);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(stream, mode + " fixture did not create a Readable");
      if (!stream) throw new Error("pre-setup fixture did not create a Readable");
      assert.equal(stream.listenerCount("error"), 0);
      assert.equal(stream.destroyed, true);
      assert.equal(stream.closed, true);
      assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-prepared-")), []);
    };
    await run("abort");
    await run("error");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(uncaught, []);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(warnings, []);
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUnhandled);
    process.removeListener("warning", onWarning);
    await rm(directory, { recursive: true, force: true });
  }
});
test("authorized media lease files are 0600 and exclusively owned by one writer", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-media-owner-"));
  const input = join(directory, "owned-audio.fixture");
  await writeFile(input, new Uint8Array([1, 2, 3, 4]));
  try {
    const acquirer = new AuthorizedAudioAcquirer({ provider: "existing-input", inputPath: input, maxBytes: 32, timeoutMs: 1_000, tempDirectory: directory });
    const audio = await acquirer.acquire(source, request, new AbortController().signal);
    const temporaryEntry = (await readdir(directory)).find((entry) => entry.startsWith("omp-lecture-"));
    assert.ok(temporaryEntry, "media acquisition creates a bounded temporary directory");
    if (!temporaryEntry) throw new Error("temporary directory was not created");
    assert.equal((await stat(join(directory, temporaryEntry, "audio.bin"))).mode & 0o777, 0o600);

    const owner = new WritableFileOwner(join(directory, "prepared.wav"));
    try {
      await owner.open();
      const rival = new WritableFileOwner(join(directory, "prepared.wav"));
      try {
        await assert.rejects(() => rival.open());
        await owner.write(new Uint8Array([9, 9]));
        await owner.finish();
        assert.equal((await stat(join(directory, "prepared.wav"))).mode & 0o777, 0o600);
      } finally {
        await rival.dispose();
      }
    } finally {
      await owner.dispose();
    }
    await audio.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

function wavChildScript(exitCode: number, holdReads: boolean): string {
  return `
const holdReads = ${holdReads};
process.stdin.on("data", (chunk) => {
  process.stdin.pause();
  if (!holdReads) setImmediate(() => process.stdin.resume());
});
process.stdin.on("end", () => {
  const dataBytes = 32000;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  process.stdout.end(Buffer.concat([header, Buffer.alloc(dataBytes)]), () => {
    setImmediate(() => process.exit(${exitCode}));
  });
});
`;
}

function commandChildScript(exitCode: number, holdOutput: boolean): string {
  return `
const holdOutput = ${holdOutput};
const emit = () => {
  process.stderr.write("fixture diagnostic\\n");
  process.stdout.end(Buffer.alloc(1024), () => setImmediate(() => process.exit(${exitCode})));
};
if (!holdOutput) setImmediate(emit);
process.once("SIGTERM", () => process.exit(143));
`;
}
function termImmuneChildScript(): string {
  return `
process.stdin.resume();
process.once("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`;
}

function backpressuredMedia() {
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

test("ffmpeg child drain/error ownership stays warning-free across repeated success and non-zero exit runs", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-preprocess-listeners-"));
  const limits: PipelineLimits = {
    maxAudioBytes: 64 * 1024,
    maxTranscriptCharacters: 64 * 1024,
    maxTranscriptSegments: 256,
    maxChunkCharacters: 1024,
    maxChunksPerSource: 128,
    maxAnalysisOutputBytes: 4096,
  };
  const warnings: Error[] = [];
  const listenerMismatches: Array<{ before: StreamListenerCounts; after: StreamListenerCounts }> = [];
  const onWarning = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
  };
  try {
    const run = async (exitCode: number): Promise<void> => {
      let child: ChildProcessWithoutNullStreams | undefined;
      let before: StreamListenerCounts | undefined;
      const spawnFixture = ((_: string, __: string[], options: Parameters<typeof spawn>[2]) => {
        child = spawn(process.execPath, ["-e", wavChildScript(exitCode, false)], options);
        before = streamListenerCounts(child);
        return child;
      }) as typeof spawn;
      const preprocessor = new BoundedAudioPreprocessor({
        ffmpegPath: "local-child-fixture",
        maxBytes: 64 * 1024,
        timeoutMs: 5_000,
        tempDirectory: directory,
        spawn: spawnFixture,
      });
      let rejectionCount = 0;
      const operation = preprocessor.prepare(backpressuredMedia(), limits, new AbortController().signal).catch((error: unknown) => {
        rejectionCount += 1;
        throw error;
      });
      if (exitCode === 0) {
        const prepared = await operation;
        assert.equal(prepared.format, "audio/wav;codec=pcm_s16le;rate=16000;channels=1");
        assert.equal(prepared.sizeBytes, 32_044);
        await prepared.dispose();
      } else {
        await assert.rejects(operation, (error: unknown) => error instanceof AcquisitionProviderError && error.code === "MEDIA_NOT_ACCESSIBLE");
        assert.equal(rejectionCount, 1);
      }
      assert.ok(child);
      assert.ok(before);
      if (!child || !before) throw new Error("fixture child was not spawned");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const after = streamListenerCounts(child);
      if (JSON.stringify(after) !== JSON.stringify(before)) listenerMismatches.push({ before, after });
      assert.equal(child.exitCode, exitCode);
      assert.equal(child.signalCode, null);
      assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-prepared-")), []);
    };
    for (let iteration = 0; iteration < 20; iteration += 1) await run(7);
    await run(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, []);
    assert.deepEqual(listenerMismatches, []);
  } finally {
    process.removeListener("warning", onWarning);
    await rm(directory, { recursive: true, force: true });
  }
});

test("ffmpeg child abort settles typed timeout and closes every owned listener", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-preprocess-abort-"));
  const limits: PipelineLimits = {
    maxAudioBytes: 64 * 1024,
    maxTranscriptCharacters: 64 * 1024,
    maxTranscriptSegments: 256,
    maxChunkCharacters: 1024,
    maxChunksPerSource: 128,
    maxAnalysisOutputBytes: 4096,
  };
  const controller = new AbortController();
  let child: ChildProcessWithoutNullStreams | undefined;
  let before: StreamListenerCounts | undefined;
  const spawnFixture = ((_: string, __: string[], options: Parameters<typeof spawn>[2]) => {
    child = spawn(process.execPath, ["-e", wavChildScript(0, true)], options);
    before = streamListenerCounts(child);
    return child;
  }) as typeof spawn;
  const preprocessor = new BoundedAudioPreprocessor({
    ffmpegPath: "local-child-fixture",
    maxBytes: 64 * 1024,
    timeoutMs: 5_000,
    tempDirectory: directory,
    spawn: spawnFixture,
  });
  try {
    const operation = preprocessor.prepare(backpressuredMedia(), limits, controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    const bounded = Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("ffmpeg abort did not settle")), 2_000);
        timer.unref?.();
      }),
    ]);
    await assert.rejects(bounded, (error: unknown) => error instanceof AcquisitionProviderError && error.code === "PROVIDER_TIMEOUT");
    assert.ok(child);
    assert.ok(before);
    if (!child || !before) throw new Error("fixture child was not spawned");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(streamListenerCounts(child), before);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-prepared-")), []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
test("authorized command child exit and abort settle once without listener or temp leaks", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-command-listeners-"));
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
  };
  try {
    const run = async (abort: boolean): Promise<void> => {
      const controller = new AbortController();
      let child: ChildProcessWithoutNullStreams | undefined;
      let before: StreamListenerCounts | undefined;
      const spawnFixture = ((_: string, __: string[], options: Parameters<typeof spawn>[2]) => {
        child = spawn(process.execPath, ["-e", commandChildScript(7, abort)], { ...options, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
        before = streamListenerCounts(child);
        return child;
      }) as typeof spawn;
      const acquirer = new AuthorizedAudioAcquirer({
        provider: "authorized-command",
        command: "local-command-fixture",
        maxBytes: 4 * 1024,
        timeoutMs: 5_000,
        tempDirectory: directory,
        spawn: spawnFixture,
      });
      let rejectionCount = 0;
      const operation = acquirer.acquire(source, request, controller.signal).catch((error: unknown) => {
        rejectionCount += 1;
        throw error;
      });
      if (abort) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort();
        await assert.rejects(operation, (error: unknown) => error instanceof AcquisitionProviderError && error.code === "PROVIDER_TIMEOUT");
      } else {
        await assert.rejects(operation, (error: unknown) => error instanceof AcquisitionProviderError && error.code === "MEDIA_NOT_ACCESSIBLE");
      }
      assert.equal(rejectionCount, 1);
      assert.ok(child);
      assert.ok(before);
      if (!child || !before) throw new Error("fixture child was not spawned");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(streamListenerCounts(child), before);
      assert.ok(child.exitCode !== null || child.signalCode !== null);
      assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-lecture-")), []);
    };
    await run(false);
    await run(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, []);
  } finally {
    process.removeListener("warning", onWarning);
    await rm(directory, { recursive: true, force: true });
  }
});
test("TERM-immune converter escalates once to SIGKILL and settles within the grace bound", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-preprocess-term-immune-"));
  const limits: PipelineLimits = {
    maxAudioBytes: 64 * 1024,
    maxTranscriptCharacters: 64 * 1024,
    maxTranscriptSegments: 256,
    maxChunkCharacters: 1024,
    maxChunksPerSource: 128,
    maxAnalysisOutputBytes: 4096,
  };
  let child: ChildProcessWithoutNullStreams | undefined;
  let before: StreamListenerCounts | undefined;
  const killCalls: Array<NodeJS.Signals | number | undefined> = [];
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
  };
  const spawnFixture = ((_: string, __: string[], options: Parameters<typeof spawn>[2]) => {
    child = spawn(process.execPath, ["-e", termImmuneChildScript()], options) as ChildProcessWithoutNullStreams;
    const originalKill = child.kill.bind(child);
    child.kill = ((signal?: NodeJS.Signals | number) => {
      killCalls.push(signal);
      return originalKill(signal);
    }) as typeof child.kill;
    before = streamListenerCounts(child);
    return child;
  }) as typeof spawn;
  try {
    const operation = new BoundedAudioPreprocessor({
      ffmpegPath: "local-term-immune",
      maxBytes: 64 * 1024,
      timeoutMs: 100,
      tempDirectory: directory,
      spawn: spawnFixture,
    }).prepare(backpressuredMedia(), limits, new AbortController().signal);
    const bounded = Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("TERM-immune converter did not settle")), 2_000);
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
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-prepared-")), []);
    assert.deepEqual(warnings, []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    process.removeListener("warning", onWarning);
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal converter close cancels the SIGKILL escalation timer", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-preprocess-normal-close-"));
  const limits: PipelineLimits = {
    maxAudioBytes: 64 * 1024,
    maxTranscriptCharacters: 64 * 1024,
    maxTranscriptSegments: 256,
    maxChunkCharacters: 1024,
    maxChunksPerSource: 128,
    maxAnalysisOutputBytes: 4096,
  };
  let child: ChildProcessWithoutNullStreams | undefined;
  let before: StreamListenerCounts | undefined;
  const killCalls: Array<NodeJS.Signals | number | undefined> = [];
  const spawnFixture = ((_: string, __: string[], options: Parameters<typeof spawn>[2]) => {
    child = spawn(process.execPath, ["-e", wavChildScript(0, false)], options) as ChildProcessWithoutNullStreams;
    const originalKill = child.kill.bind(child);
    child.kill = ((signal?: NodeJS.Signals | number) => {
      killCalls.push(signal);
      return originalKill(signal);
    }) as typeof child.kill;
    before = streamListenerCounts(child);
    return child;
  }) as typeof spawn;
  try {
    const prepared = await new BoundedAudioPreprocessor({
      ffmpegPath: "local-normal-close",
      maxBytes: 64 * 1024,
      timeoutMs: 1_000,
      tempDirectory: directory,
      spawn: spawnFixture,
    }).prepare(backpressuredMedia(), limits, new AbortController().signal);
    await prepared.dispose();
    assert.ok(child);
    assert.ok(before);
    if (!child || !before) throw new Error("fixture child was not spawned");
    assert.equal(child.exitCode, 0);
    assert.deepEqual(killCalls, []);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(streamListenerCounts(child), before);
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-prepared-")), []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("TERM-immune authorized command escalates once to SIGKILL and settles within the grace bound", { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-command-term-immune-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  let before: StreamListenerCounts | undefined;
  const killCalls: Array<NodeJS.Signals | number | undefined> = [];
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning);
  };
  const spawnFixture = ((_: string, __: string[], options: Parameters<typeof spawn>[2]) => {
    child = spawn(process.execPath, ["-e", termImmuneChildScript()], { ...options, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    const originalKill = child.kill.bind(child);
    child.kill = ((signal?: NodeJS.Signals | number) => {
      killCalls.push(signal);
      return originalKill(signal);
    }) as typeof child.kill;
    before = streamListenerCounts(child);
    return child;
  }) as typeof spawn;
  try {
    const controller = new AbortController();
    const operation = new AuthorizedAudioAcquirer({
      provider: "authorized-command",
      command: "local-term-immune",
      maxBytes: 4 * 1024,
      timeoutMs: 100,
      tempDirectory: directory,
      spawn: spawnFixture,
    }).acquire(source, request, controller.signal);
    const bounded = Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("TERM-immune command did not settle")), 2_000);
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
    assert.deepEqual((await readdir(directory)).filter((entry) => entry.startsWith("omp-lecture-")), []);
    assert.deepEqual(warnings, []);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    process.removeListener("warning", onWarning);
    await rm(directory, { recursive: true, force: true });
  }
});
