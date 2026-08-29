import { createReadStream } from "node:fs";
import { mkdtemp, open as openFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import type { EphemeralAudio, PreparedAudioLease, PipelineLimits } from "@andvl1/omp-workflows-core";
import { createChildTerminationOwner, waitForChildDrain, type ChildTerminationOwner } from "./child-lifecycle.js";
import { ownReadable } from "./readable-lifecycle.js";
import { WritableFileOwner } from "./writable-file-owner.js";
import { AcquisitionProviderError } from "./provider-errors.js";
import { readWavMetadata, WavAbortError, type WavMetadata } from "./wav.js";

export interface AudioPreprocessorOptions {
  ffmpegPath?: string;
  maxBytes?: number;
  timeoutMs?: number;
  tempDirectory?: string;
  spawn?: typeof spawn;
}

interface PreparedTempResult {
  path: string;
  directory: string;
  sizeBytes: number;
}

class PreparedAudio implements PreparedAudioLease {
  private disposed = false;

  constructor(private readonly path: string, private readonly directory: string, readonly format: string, readonly sizeBytes: number, readonly durationSeconds?: number) {}

  async open(signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    if (this.disposed) throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Prepared audio handle has already been disposed", { provider: "audio-preprocess", retryable: false });
    if (signal.aborted) throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Prepared audio stream was cancelled", { provider: "audio-preprocess", retryable: false });
    return createReadStream(this.path, { signal }) as AsyncIterable<Uint8Array>;
  }

  /** Read a small bounded header or chunk header without loading PCM payload. */
  async readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (this.disposed) throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Prepared audio handle has already been disposed", { provider: "audio-preprocess", retryable: false });
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset + length > this.sizeBytes) {
      throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Prepared audio range is invalid", { provider: "audio-preprocess", retryable: false });
    }
    if (signal.aborted) throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Prepared audio range read was cancelled", { provider: "audio-preprocess", retryable: false });
    const handle = await openFile(this.path, "r");
    try {
      const output = new Uint8Array(length);
      let offsetInOutput = 0;
      while (offsetInOutput < length) {
        if (signal.aborted) throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Prepared audio range read was cancelled", { provider: "audio-preprocess", retryable: false });
        const result = await handle.read(output, offsetInOutput, length - offsetInOutput, offset + offsetInOutput);
        if (result.bytesRead < 1) throw new Error("Prepared audio ended before the requested range");
        offsetInOutput += result.bytesRead;
      }
      if (signal.aborted) throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Prepared audio range read was cancelled", { provider: "audio-preprocess", retryable: false });
      return output;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readPreparedWavMetadata(
  path: string,
  sizeBytes: number,
  signal: AbortSignal,
  invalidCode: "MEDIA_NOT_ACCESSIBLE" | "INVALID_PROVIDER_RESPONSE",
  invalidMessage: string,
): Promise<WavMetadata> {
  const stream = createReadStream(path, { signal });
  const owned = ownReadable(stream, "Prepared WAV stream closed before EOF");
  const iterator = owned.iterable[Symbol.asyncIterator]();
  try {
    return await readWavMetadata(iterator, sizeBytes, signal);
  } catch (error) {
    if (signal.aborted || error instanceof WavAbortError) {
      throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Audio preprocessing deadline exceeded", { provider: "audio-preprocess", retryable: false });
    }
    throw new AcquisitionProviderError(invalidCode, invalidMessage, { provider: "audio-preprocess", retryable: false });
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // Stream cleanup is best effort; the prepared directory owner remains authoritative.
    }
    await owned.dispose();
  }
}

async function writeBounded(
  source: AsyncIterable<Uint8Array>,
  options: { directory: string; maxBytes: number; signal: AbortSignal; prefix: string },
): Promise<PreparedTempResult> {
  // Own a Readable synchronously before any await. Its AbortSignal may destroy
  // the source while mkdtemp or WritableFileOwner.open is still pending.
  const ownedSource = source instanceof Readable ? ownReadable(source, "Audio converter output closed before EOF") : undefined;
  const boundedSource = ownedSource?.iterable ?? source;
  let directory: string | undefined;
  let writable: WritableFileOwner | undefined;
  let total = 0;
  try {
    directory = await mkdtemp(join(options.directory, `${options.prefix}-`));
    const path = join(directory, "prepared.wav");
    writable = new WritableFileOwner(path);
    await writable.open();
    for await (const chunk of boundedSource) {
      if (options.signal.aborted) throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Audio preprocessing deadline exceeded", { provider: "audio-preprocess", retryable: false });
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      total += bytes.byteLength;
      if (total > options.maxBytes) throw new AcquisitionProviderError("LIMIT_EXCEEDED", "Prepared audio exceeds the configured size limit", { provider: "audio-preprocess", retryable: false });
      await writable.write(bytes);
    }
    await writable.finish();
    return { path, directory, sizeBytes: total };
  } catch (error) {
    if (ownedSource) await ownedSource.dispose().catch(() => undefined);
    if (writable) await writable.dispose();
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (options.signal.aborted && !(error instanceof AcquisitionProviderError)) {
      throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Audio preprocessing deadline exceeded", { provider: "audio-preprocess", retryable: false });
    }
    throw error;
  }
}

function waitForConvertedChild(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
  termination: ChildTerminationOwner,
  timedOut: () => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let startupError: AcquisitionProviderError | undefined;
    const cleanup = (): void => {
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const onError = (): void => {
      startupError = new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Audio converter failed to start", { provider: "audio-preprocess", retryable: false });
      termination.requestTermination();
    };
    const onClose = (code: number | null): void => {
      if (signal.aborted || timedOut()) {
        finish(new AcquisitionProviderError("PROVIDER_TIMEOUT", "Audio preprocessing deadline exceeded", { provider: "audio-preprocess", retryable: false }));
      } else if (startupError) {
        finish(startupError);
      } else if (code !== 0) {
        finish(new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Audio converter failed", { provider: "audio-preprocess", retryable: false }));
      } else {
        finish();
      }
    };
    const onAbort = (): void => {
      termination.requestTermination();
    };
    child.once("error", onError);
    child.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function passthrough(media: EphemeralAudio, limits: PipelineLimits, options: AudioPreprocessorOptions, signal: AbortSignal): Promise<PreparedAudioLease> {
  const source = await media.open(signal);
  const result = await writeBounded(source, { directory: options.tempDirectory ?? tmpdir(), maxBytes: Math.min(options.maxBytes ?? limits.maxAudioBytes, limits.maxAudioBytes), signal, prefix: "omp-prepared" });
  try {
    const metadata = await readPreparedWavMetadata(result.path, result.sizeBytes, signal, "MEDIA_NOT_ACCESSIBLE", "Audio input is not mono 16-kHz WAV and no converter is configured");
    if (metadata.channels !== 1 || metadata.sampleRate !== 16_000) {
      throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Audio input is not mono 16-kHz WAV and no converter is configured", { provider: "audio-preprocess", retryable: false });
    }
    if (metadata.durationSeconds > (limits.maxDurationSeconds ?? Number.POSITIVE_INFINITY)) {
      throw new AcquisitionProviderError("LIMIT_EXCEEDED", "Audio duration exceeds the configured limit", { provider: "audio-preprocess", retryable: false });
    }
    return new PreparedAudio(result.path, result.directory, "audio/wav;codec=pcm_s16le;rate=16000;channels=1", result.sizeBytes, metadata.durationSeconds);
  } catch (error) {
    await rm(result.directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function converted(media: EphemeralAudio, limits: PipelineLimits, options: AudioPreprocessorOptions, signal: AbortSignal): Promise<PreparedAudioLease> {
  const ffmpeg = options.ffmpegPath;
  if (!ffmpeg || /[\r\n\u0000]/.test(ffmpeg)) throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Audio converter is not configured", { provider: "audio-preprocess", retryable: false });
  const spawnImpl = options.spawn ?? spawn;
  const child = spawnImpl(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"], { shell: false, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  const termination = createChildTerminationOwner(child);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    termination.requestTermination();
  }, options.timeoutMs ?? 300_000);
  const outputPromise = writeBounded(child.stdout as AsyncIterable<Uint8Array>, { directory: options.tempDirectory ?? tmpdir(), maxBytes: Math.min(options.maxBytes ?? limits.maxAudioBytes, limits.maxAudioBytes), signal, prefix: "omp-prepared" });
  let outputResult: PreparedTempResult | undefined;
  outputPromise.then((value) => { outputResult = value; }, () => undefined);
  const closePromise = waitForConvertedChild(child, signal, termination, () => timedOut);
  void closePromise.catch(() => undefined);
  child.stderr.resume();
  let feed: Promise<void> | undefined;
  let feedError: AcquisitionProviderError | undefined;
  let stopFeeding = false;
  const onStdinError = (): void => {
    if (stopFeeding) return;
    feedError = new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Audio converter input failed", { provider: "audio-preprocess", retryable: false });
    stopFeeding = true;
    termination.requestTermination();
  };
  child.stdin.on("error", onStdinError);
  try {
    const input = await media.open(signal);
    feed = (async () => {
      try {
        for await (const chunk of input) {
          if (stopFeeding || signal.aborted || feedError) break;
          if (!child.stdin.write(chunk)) {
            await waitForChildDrain(child.stdin, signal, {
              onError: () => new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Audio converter input failed", { provider: "audio-preprocess", retryable: false }),
              onClose: () => new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Audio converter input closed before draining", { provider: "audio-preprocess", retryable: false }),
              onAbort: () => new AcquisitionProviderError("PROVIDER_TIMEOUT", "Audio preprocessing deadline exceeded", { provider: "audio-preprocess", retryable: false }),
            });
          }
        }
        if (!stopFeeding && !signal.aborted && !feedError) child.stdin.end();
      } catch (error) {
        feedError = error instanceof AcquisitionProviderError
          ? error
          : new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Audio converter input failed", { provider: "audio-preprocess", retryable: false });
        stopFeeding = true;
        termination.requestTermination();
        child.stdin.destroy();
        throw feedError;
      }
    })();
    const [result] = await Promise.all([outputPromise, closePromise, feed]);
    if (feedError) throw feedError;
    const metadata = await readPreparedWavMetadata(result.path, result.sizeBytes, signal, "INVALID_PROVIDER_RESPONSE", "Audio converter returned an invalid format");
    if (metadata.channels !== 1 || metadata.sampleRate !== 16_000) {
      throw new AcquisitionProviderError("INVALID_PROVIDER_RESPONSE", "Audio converter returned an invalid format", { provider: "audio-preprocess", retryable: false });
    }
    if (metadata.durationSeconds > (limits.maxDurationSeconds ?? Number.POSITIVE_INFINITY)) {
      throw new AcquisitionProviderError("LIMIT_EXCEEDED", "Audio duration exceeds the configured limit", { provider: "audio-preprocess", retryable: false });
    }
    return new PreparedAudio(result.path, result.directory, "audio/wav;codec=pcm_s16le;rate=16000;channels=1", result.sizeBytes, metadata.durationSeconds);
  } catch (error) {
    stopFeeding = true;
    termination.requestTermination();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await Promise.allSettled([outputPromise, closePromise, feed ?? Promise.resolve()]);
    if (outputResult) await rm(outputResult.directory, { recursive: true, force: true }).catch(() => undefined);
    if (signal.aborted || timedOut) {
      throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Audio preprocessing deadline exceeded", { provider: "audio-preprocess", retryable: false });
    }
    throw error;
  } finally {
    child.stdin.removeListener("error", onStdinError);
    clearTimeout(timeout);
    termination.dispose();
  }
}

export class BoundedAudioPreprocessor {
  constructor(private readonly options: AudioPreprocessorOptions = {}) {}

  async prepare(media: EphemeralAudio, limits: PipelineLimits, signal: AbortSignal): Promise<PreparedAudioLease> {
    if (!Number.isInteger(limits.maxAudioBytes) || limits.maxAudioBytes < 1 || limits.maxAudioBytes > 256 * 1024 * 1024) throw new AcquisitionProviderError("LIMIT_EXCEEDED", "Audio size limit is invalid", { provider: "audio-preprocess", retryable: false });
    return this.options.ffmpegPath ? converted(media, limits, this.options, signal) : passthrough(media, limits, this.options, signal);
  }
}

export function createBoundedAudioPreprocessor(options: AudioPreprocessorOptions = {}): BoundedAudioPreprocessor {
  return new BoundedAudioPreprocessor(options);
}
