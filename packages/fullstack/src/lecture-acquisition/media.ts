import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import type {
  EphemeralAudio,
  LectureAcquisitionRequest,
  LectureAudioAcquirer,
  ResolvedVideoSource,
} from "@andvl1/omp-workflows-core";
import { createChildTerminationOwner, type ChildTerminationOwner } from "./child-lifecycle.js";
import { ownReadable } from "./readable-lifecycle.js";
import { WritableFileOwner } from "./writable-file-owner.js";
import { AcquisitionProviderError } from "./provider-errors.js";

export interface AuthorizedAudioAcquirerOptions {
  provider: "authorized-command" | "existing-input";
  command?: string;
  inputPath?: string;
  maxBytes: number;
  maxDurationSeconds?: number;
  timeoutMs: number;
  spawn?: typeof spawn;
  tempDirectory?: string;
  readStreamFactory?: typeof createReadStream;
}

function authorized(request: LectureAcquisitionRequest): boolean {
  const rights = request.rights;
  return request.mediaMode === "owned-audio"
    && rights.automatedPublicVideoAnalysisApproved
    && (rights.ownedMediaAudioAccessApproved === true || rights.ownedMediaAccessApproved === true);
}

function parseArgv(command: string): string[] {
  if (command.length === 0 || command.length > 2_048 || /[\r\n\u0000]/.test(command)) return [];
  try {
    if (command.trimStart().startsWith("[")) {
      const parsed: unknown = JSON.parse(command);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && item.length > 0 && item.length <= 512)) return parsed;
      return [];
    }
  } catch {
    return [];
  }
  const result: string[] = [];
  const token = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  const matches = command.match(token) ?? [];
  for (const raw of matches) {
    const value = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
    if (!value || /[;&|`$<>\\]/.test(value)) return [];
    result.push(value);
  }
  return result;
}

function parseWavDuration(header: Uint8Array): number | undefined {
  if (header.byteLength < 44 || String.fromCharCode(...header.slice(0, 4)) !== "RIFF" || String.fromCharCode(...header.slice(8, 12)) !== "WAVE") return undefined;
  const byteRate = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(28, true);
  const dataSize = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(40, true);
  if (!byteRate || !Number.isFinite(byteRate) || !Number.isFinite(dataSize)) return undefined;
  return dataSize / byteRate;
}

class TempAudio implements EphemeralAudio {
  private disposed = false;

  constructor(
    private readonly path: string,
    private readonly directory: string,
    readonly format: string,
    readonly sizeBytes: number,
    readonly durationSeconds?: number,
  ) {}

  async open(signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    if (this.disposed) throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Audio handle has already been disposed", { provider: "authorized-audio" });
    if (signal.aborted) throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Audio stream was cancelled", { provider: "authorized-audio", retryable: false });
    const stream = createReadStream(this.path, { signal });
    return stream as AsyncIterable<Uint8Array>;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await rm(this.directory, { recursive: true, force: true });
    } catch {
      // Cleanup is best effort; the primary provider failure remains authoritative.
    }
  }
}

async function readBoundedTempHeader(
  outputPath: string,
  expectedSize: number,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio output cannot be opened safely", { provider: "authorized-audio", retryable: false });
  }
  let headerFile: FileHandle | undefined;
  try {
    headerFile = await open(outputPath, constants.O_RDONLY | noFollow);
    const opened = await headerFile.stat();
    if (!opened.isFile() || opened.size !== expectedSize || !Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > maxBytes) {
      throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio output changed before header inspection", { provider: "authorized-audio", retryable: false });
    }
    const openedPath = await lstat(outputPath);
    if (!openedPath.isFile() || openedPath.dev !== opened.dev || openedPath.ino !== opened.ino) {
      throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio output changed before header inspection", { provider: "authorized-audio", retryable: false });
    }
    if (expectedSize < 44) return undefined;
    const header = new Uint8Array(Math.min(expectedSize, 128));
    let offset = 0;
    while (offset < header.byteLength) {
      const { bytesRead } = await headerFile.read(header, offset, header.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const final = await headerFile.stat();
    const finalPath = await lstat(outputPath);
    if (!final.isFile() || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== expectedSize
      || !finalPath.isFile() || finalPath.dev !== final.dev || finalPath.ino !== final.ino) {
      throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio output changed during header inspection", { provider: "authorized-audio", retryable: false });
    }
    return offset >= 44 ? header.subarray(0, offset) : undefined;
  } finally {
    await headerFile?.close().catch(() => undefined);
  }
}

async function writeStreamToTemp(
  source: AsyncIterable<Uint8Array>,
  options: { directory: string; maxBytes: number; signal: AbortSignal },
): Promise<{ path: string; directory: string; sizeBytes: number; durationSeconds?: number }> {
  // This call must precede every await in this function. It synchronously owns
  // a ReadStream created with the internal signal before mkdtemp/open can yield.
  const ownedSource = source instanceof Readable ? ownReadable(source, "Authorized audio output closed before EOF") : undefined;
  const boundedSource = ownedSource?.iterable ?? source;
  let directory: string | undefined;
  let writable: WritableFileOwner | undefined;
  let total = 0;
  try {
    directory = await mkdtemp(join(options.directory, "omp-lecture-"));
    const outputPath = join(directory, "audio.bin");
    writable = new WritableFileOwner(outputPath);
    await writable.open();
    for await (const chunk of boundedSource) {
      if (options.signal.aborted) throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Audio acquisition deadline exceeded", { provider: "authorized-audio", retryable: false });
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      total += bytes.byteLength;
      if (total > options.maxBytes) throw new AcquisitionProviderError("LIMIT_EXCEEDED", "Authorized audio exceeds the configured size limit", { provider: "authorized-audio", retryable: false });
      await writable.write(bytes);
    }
    await writable.finish();
    const header = total >= 44 ? await readBoundedTempHeader(outputPath, total, options.maxBytes) : undefined;
    return { path: outputPath, directory, sizeBytes: total, durationSeconds: header ? parseWavDuration(header) : undefined };
  } catch (error) {
    if (ownedSource) await ownedSource.dispose().catch(() => undefined);
    if (writable) await writable.dispose().catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (options.signal.aborted && !(error instanceof AcquisitionProviderError)) {
      throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Audio acquisition deadline exceeded", { provider: "authorized-audio", retryable: false });
    }
    throw error;
  }
}

async function copyFileToTemp(path: string, options: { directory: string; maxBytes: number; signal: AbortSignal; readStreamFactory?: typeof createReadStream }): Promise<{ path: string; directory: string; sizeBytes: number; durationSeconds?: number }> {
  const noFollow = constants.O_NOFOLLOW;
  const nonBlock = constants.O_NONBLOCK;
  if (!Number.isInteger(noFollow) || !Number.isInteger(nonBlock)) {
    throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio input cannot be opened safely", { provider: "authorized-audio", retryable: false });
  }
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | noFollow | nonBlock);
  } catch {
    throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio input is unavailable", { provider: "authorized-audio", retryable: false });
  }
  let streamFile: FileHandle | undefined;
  let result: { path: string; directory: string; sizeBytes: number; durationSeconds?: number } | undefined;
  let reading = false;
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio input is not a regular file", { provider: "authorized-audio", retryable: false });
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > options.maxBytes) {
      throw new AcquisitionProviderError("LIMIT_EXCEEDED", "Authorized audio exceeds the configured size limit", { provider: "authorized-audio", retryable: false });
    }
    const initialPath = await lstat(path);
    if (!initialPath.isFile() || initialPath.dev !== before.dev || initialPath.ino !== before.ino) {
      throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio input changed while opening", { provider: "authorized-audio", retryable: false });
    }
    streamFile = await open(path, constants.O_RDONLY | noFollow | nonBlock);
    const streamIdentity = await streamFile.stat();
    if (!streamIdentity.isFile() || streamIdentity.dev !== before.dev || streamIdentity.ino !== before.ino) {
      throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio input changed while opening", { provider: "authorized-audio", retryable: false });
    }
    const streamFactory = options.readStreamFactory ?? createReadStream;
    const stream = streamFactory(path, { fd: streamFile.fd, autoClose: true, signal: options.signal }) as AsyncIterable<Uint8Array>;
    reading = true;
    result = await writeStreamToTemp(stream, options);
    reading = false;
    const after = await file.stat();
    const finalPath = await lstat(path);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !finalPath.isFile() || finalPath.dev !== after.dev || finalPath.ino !== after.ino) {
      throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio input changed during the bounded read", { provider: "authorized-audio", retryable: false });
    }
    return result;
  } catch (error) {
    if (result) await rm(result.directory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof AcquisitionProviderError) throw error;
    if (options.signal.aborted) throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Audio acquisition deadline exceeded", { provider: "authorized-audio", retryable: false });
    if (reading) throw error;
    throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio input could not be read safely", { provider: "authorized-audio", retryable: false });
  } finally {
    await streamFile?.close().catch(() => undefined);
    await file.close().catch(() => undefined);
  }
}

async function waitForChild(child: ChildProcess, signal: AbortSignal, termination: ChildTerminationOwner): Promise<void> {
  await new Promise<void>((resolve, reject) => {
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
      startupError = new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio command failed to start", { provider: "authorized-audio", retryable: false });
      termination.requestTermination();
    };
    const onClose = (code: number | null, signalName: NodeJS.Signals | null): void => {
      if (signal.aborted) {
        finish(new AcquisitionProviderError("PROVIDER_TIMEOUT", "Authorized audio command timed out", { provider: "authorized-audio", retryable: false }));
      } else if (startupError) {
        finish(startupError);
      } else if (code !== 0) {
        finish(new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", signalName ? "Authorized audio command was terminated" : "Authorized audio command failed", { provider: "authorized-audio", retryable: false }));
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

async function acquireCommandAudio(
  command: string,
  source: ResolvedVideoSource,
  options: AuthorizedAudioAcquirerOptions,
  signal: AbortSignal,
): Promise<{ path: string; directory: string; sizeBytes: number; durationSeconds?: number }> {
  const argv = parseArgv(command);
  if (!argv.length) throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio command is not configured safely", { provider: "authorized-audio", retryable: false });
  const executable = argv[0]!;
  const args = [...argv.slice(1), "--source-id", source.videoId];
  const spawnImpl = options.spawn ?? spawn;
  const child = spawnImpl(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const termination = createChildTerminationOwner(child);
  if (!child.stdout || !child.stderr) {
    termination.requestTermination();
    await waitForChild(child, signal, termination).catch(() => undefined);
    termination.dispose();
    throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio command failed to start", { provider: "authorized-audio", retryable: false });
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    termination.requestTermination();
  }, options.timeoutMs);
  const resultPromise = writeStreamToTemp(child.stdout as AsyncIterable<Uint8Array>, { directory: options.tempDirectory ?? tmpdir(), maxBytes: options.maxBytes, signal });
  let completed: { path: string; directory: string; sizeBytes: number; durationSeconds?: number } | undefined;
  resultPromise.then((value) => { completed = value; }, () => undefined);
  // Drain stderr so a chatty child cannot block on a full pipe; contents are never retained.
  child.stderr.resume();
  const waitPromise = waitForChild(child, signal, termination);
  void waitPromise.catch(() => undefined);
  try {
    const [audio] = await Promise.all([resultPromise, waitPromise]);
    return audio;
  } catch (error) {
    termination.requestTermination();
    child.stdout.destroy();
    child.stderr.destroy();
    await Promise.allSettled([resultPromise, waitPromise]);
    if (completed) await rm(completed.directory, { recursive: true, force: true }).catch(() => undefined);
    if (signal.aborted || timedOut) {
      throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Authorized audio command timed out", { provider: "authorized-audio", retryable: false });
    }
    if (error instanceof AcquisitionProviderError) throw error;
    throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio command failed", { provider: "authorized-audio", retryable: false });
  } finally {
    clearTimeout(timeout);
    termination.dispose();
  }
}

export class AuthorizedAudioAcquirer implements LectureAudioAcquirer {
  constructor(private readonly options: AuthorizedAudioAcquirerOptions) {}
  async acquire(source: ResolvedVideoSource, request: LectureAcquisitionRequest, signal: AbortSignal): Promise<EphemeralAudio> {
    if (!authorized(request)) throw new AcquisitionProviderError("RIGHTS_REQUIRED", "Owned-audio rights approval is required", { provider: "authorized-audio", retryable: false });
    if (signal.aborted) throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Audio acquisition deadline exceeded", { provider: "authorized-audio", retryable: false });
    if (!Number.isInteger(this.options.maxBytes) || this.options.maxBytes < 1 || this.options.maxBytes > 256 * 1024 * 1024) throw new AcquisitionProviderError("LIMIT_EXCEEDED", "Audio size limit is invalid", { provider: "authorized-audio", retryable: false });
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let result: { path: string; directory: string; sizeBytes: number; durationSeconds?: number } | undefined;
    try {
      result = this.options.provider === "existing-input"
        ? await copyFileToTemp(this.options.inputPath ?? "", { directory: this.options.tempDirectory ?? tmpdir(), maxBytes: this.options.maxBytes, signal: controller.signal, readStreamFactory: this.options.readStreamFactory })
        : await acquireCommandAudio(this.options.command ?? "", source, this.options, controller.signal);
      if (result.durationSeconds !== undefined && this.options.maxDurationSeconds !== undefined && result.durationSeconds > this.options.maxDurationSeconds) {
        throw new AcquisitionProviderError("LIMIT_EXCEEDED", "Authorized audio exceeds the configured duration limit", { provider: "authorized-audio", retryable: false });
      }
      return new TempAudio(result.path, result.directory, "audio/wav", result.sizeBytes, result.durationSeconds);
    } catch (error) {
      if (result) await rm(result.directory, { recursive: true, force: true }).catch(() => undefined);
      if (controller.signal.aborted && !signal.aborted && !(error instanceof AcquisitionProviderError)) {
        throw new AcquisitionProviderError("PROVIDER_TIMEOUT", "Authorized audio timed out", { provider: "authorized-audio", retryable: false });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}

export function createAuthorizedAudioAcquirer(options: AuthorizedAudioAcquirerOptions): AuthorizedAudioAcquirer {
  return new AuthorizedAudioAcquirer(options);
}

export async function verifyAuthorizedInput(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new AcquisitionProviderError("MEDIA_NOT_ACCESSIBLE", "Authorized audio input is unavailable", { provider: "authorized-audio", retryable: false });
  }
}
