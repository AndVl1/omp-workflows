import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import type { EphemeralAudio, LectureAsrPort, LectureAcquisitionRequest, ResolvedVideoSource } from "@andvl1/omp-workflows-core";
import { createChildTerminationOwner, waitForChildDrain } from "./child-lifecycle.js";
import { AcquisitionProviderError } from "./provider-errors.js";
import { normalizeAsrResponse } from "./asr.js";

export interface WhisperLocalAsrOptions {
  binaryPath: string;
  modelPath: string;
  model?: string;
  maxOutputBytes: number;
  maxTranscriptCharacters: number;
  maxSegments?: number;
  timeoutMs: number;
  spawn?: typeof spawn;
}

async function* readableChunks(source: Readable): AsyncGenerator<Uint8Array> {
  let completed = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const onError = (error: Error): void => {
    failure = error;
    wake?.();
  };
  const waitForEvent = (): Promise<"readable" | "end"> => new Promise<"readable" | "end">((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      source.removeListener("readable", onReadable);
      source.removeListener("end", onEnd);
      source.removeListener("close", onClose);
    };
    const finish = (value: "readable" | "end", error?: Error): void => {
      if (settled) return;
      settled = true;
      wake = undefined;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const onReadable = (): void => finish("readable");
    const onEnd = (): void => finish("end");
    const onClose = (): void => {
      if (source.readableEnded) finish("end");
      else finish("end", new Error("Local ASR output closed before EOF"));
    };
    wake = () => finish("end", failure);
    source.once("readable", onReadable);
    source.once("end", onEnd);
    source.once("close", onClose);
    if (source.readableEnded) onEnd();
  });
  source.on("error", onError);
  try {
    while (true) {
      if (failure) throw failure;
      const chunk = source.read();
      if (chunk !== null) {
        yield chunk instanceof Uint8Array ? chunk : new Uint8Array(Buffer.from(chunk));
        continue;
      }
      if (source.readableEnded) {
        completed = true;
        return;
      }
      if (source.destroyed) throw failure ?? new Error("Local ASR output closed before EOF");
      if ((await waitForEvent()) === "end") {
        if (failure) throw failure;
        completed = true;
        return;
      }
    }
  } finally {
    if (!completed && !source.destroyed) source.destroy();
    source.removeListener("error", onError);
    wake = undefined;
  }
}
async function collectBounded(stream: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const source = stream instanceof Readable ? readableChunks(stream) : stream;
  for await (const chunk of source) {
    if (signal.aborted) throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Local ASR timed out", { provider: "whisper.cpp", retryable: false });
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) throw new AcquisitionProviderError("LIMIT_EXCEEDED", "Local ASR output exceeds the configured bound", { provider: "whisper.cpp", retryable: false });
    chunks.push(bytes);
  }
  const decoder = new TextDecoder();
  let result = "";
  for (const chunk of chunks) result += decoder.decode(chunk, { stream: true });
  return result + decoder.decode();
}

async function runWhisper(options: WhisperLocalAsrOptions, audio: EphemeralAudio, signal: AbortSignal): Promise<string> {
  if (!options.binaryPath || !options.modelPath || /[\r\n\u0000]/.test(options.binaryPath) || /[\r\n\u0000]/.test(options.modelPath)) {
    throw new AcquisitionProviderError("TRANSCRIPT_FAILED", "Local ASR is not configured", { provider: "whisper.cpp", retryable: false });
  }
  const spawnImpl = options.spawn ?? spawn;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnImpl(options.binaryPath, ["-m", options.modelPath, "-f", "-", "--output-json", "--no-prints"], { shell: false, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  } catch {
    throw new AcquisitionProviderError("TRANSCRIPT_FAILED", "Local ASR executable is unavailable", { provider: "whisper.cpp", retryable: false });
  }
  const termination = createChildTerminationOwner(child);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    termination.requestTermination();
  }, options.timeoutMs);
  const terminate = (): void => {
    termination.requestTermination();
  };
  signal.addEventListener("abort", terminate, { once: true });
  let stderrBytes = 0;
  const onStderrData = (chunk: Uint8Array): void => { stderrBytes = Math.min(32_768, stderrBytes + chunk.byteLength); };
  child.stderr.on("data", onStderrData);

  let closeError: AcquisitionProviderError | undefined;
  const close = new Promise<void>((resolve, reject) => {
    let settled = false;
    let startupError: AcquisitionProviderError | undefined;
    const cleanup = (): void => {
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    const finish = (error?: AcquisitionProviderError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        closeError = error;
        reject(error);
      } else {
        resolve();
      }
    };
    const onError = (): void => {
      startupError = new AcquisitionProviderError("TRANSCRIPT_FAILED", "Local ASR executable is unavailable", { provider: "whisper.cpp", retryable: false });
    };
    const onClose = (code: number | null): void => {
      if (signal.aborted || timedOut) {
        finish(new AcquisitionProviderError("PROVIDER_TIMEOUT", "Local ASR timed out", { provider: "whisper.cpp", retryable: false }));
      } else if (startupError) {
        finish(startupError);
      } else if (code !== 0) {
        finish(new AcquisitionProviderError("TRANSCRIPT_FAILED", "Local ASR failed", { provider: "whisper.cpp", retryable: false }));
      } else {
        finish();
      }
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
  void close.catch(() => undefined);

  let feed: Promise<void> | undefined;
  let output: Promise<string> | undefined;
  let feedError: AcquisitionProviderError | undefined;
  let stopFeeding = false;
  const onStdinError = (): void => {
    if (stopFeeding) return;
    feedError = new AcquisitionProviderError("TRANSCRIPT_FAILED", "Local ASR input failed", { provider: "whisper.cpp", retryable: false });
    stopFeeding = true;
    termination.requestTermination();
  };
  child.stdin.on("error", onStdinError);
  try {
    const input = await audio.open(signal);
    feed = (async () => {
      try {
        for await (const chunk of input) {
          if (stopFeeding || signal.aborted || feedError) break;
          if (!child.stdin.write(chunk)) {
            await waitForChildDrain(child.stdin, signal, {
              onError: () => timedOut || signal.aborted
                ? new AcquisitionProviderError("PROVIDER_TIMEOUT", "Local ASR timed out", { provider: "whisper.cpp", retryable: false })
                : new AcquisitionProviderError("TRANSCRIPT_FAILED", "Local ASR input failed", { provider: "whisper.cpp", retryable: false }),
              onClose: () => timedOut || signal.aborted
                ? new AcquisitionProviderError("PROVIDER_TIMEOUT", "Local ASR timed out", { provider: "whisper.cpp", retryable: false })
                : new AcquisitionProviderError("TRANSCRIPT_FAILED", "Local ASR input closed before draining", { provider: "whisper.cpp", retryable: false }),
              onAbort: () => new AcquisitionProviderError("PROVIDER_TIMEOUT", "Local ASR timed out", { provider: "whisper.cpp", retryable: false }),
            });
          }
        }
        if (!stopFeeding && !signal.aborted && !feedError) child.stdin.end();
        if (feedError) throw feedError;
      } catch (error) {
        const typed = error instanceof AcquisitionProviderError
          ? error
          : feedError ?? new AcquisitionProviderError("TRANSCRIPT_FAILED", "Local ASR input failed", { provider: "whisper.cpp", retryable: false });
        feedError = feedError ?? typed;
        stopFeeding = true;
        termination.requestTermination();
        child.stdin.destroy();
        throw typed;
      }
    })();
    output = collectBounded(child.stdout as AsyncIterable<Uint8Array>, options.maxOutputBytes, signal);
    const [text] = await Promise.all([output, close, feed]);
    return text;
  } catch (error) {
    stopFeeding = true;
    termination.requestTermination();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await Promise.allSettled([output ?? Promise.resolve(), close, feed ?? Promise.resolve()]);
    if (error instanceof AcquisitionProviderError) throw error;
    if (feedError) throw feedError;
    if (closeError) throw closeError;
    throw new AcquisitionProviderError("TRANSCRIPT_FAILED", "Local ASR failed", { provider: "whisper.cpp", retryable: false });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", terminate);
    child.stdin.removeListener("error", onStdinError);
    child.stderr.removeListener("data", onStderrData);
    termination.dispose();
    stderrBytes = 0;
  }
}

export class WhisperLocalAsr implements LectureAsrPort {
  readonly id = "whisper.cpp";
  readonly model?: string;

  constructor(private readonly options: WhisperLocalAsrOptions) {
    this.model = options.model;
  }

  async transcribe(audio: EphemeralAudio, _source: ResolvedVideoSource, _request: LectureAcquisitionRequest, signal: AbortSignal) {
    const raw = await runWhisper(this.options, audio, signal);
    return normalizeAsrResponse(raw, { provider: this.id, model: this.model, maxCharacters: this.options.maxTranscriptCharacters, maxSegments: this.options.maxSegments });
  }
}

export function createWhisperLocalAsr(options: WhisperLocalAsrOptions): WhisperLocalAsr {
  return new WhisperLocalAsr(options);
}
