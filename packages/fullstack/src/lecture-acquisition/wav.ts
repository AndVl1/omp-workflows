const RIFF_HEADER_BYTES = 12;
const RIFF_CHUNK_HEADER_BYTES = 8;
const RIFF_SIZE_SENTINEL = 0xffff_ffff;
const MAX_RIFF_FILE_BYTES = RIFF_SIZE_SENTINEL + 8;
const PCM_FORMAT = 1;
const PCM_CHANNELS = 1;
const PCM_SAMPLE_RATE = 16_000;
const PCM_BYTE_RATE = 32_000;
const PCM_BLOCK_ALIGN = 2;
const PCM_BITS_PER_SAMPLE = 16;

export class WavParseError extends Error {
  constructor(message = "Invalid RIFF/WAVE stream") {
    super(message);
    this.name = "WavParseError";
  }
}

export class WavAbortError extends Error {
  constructor() {
    super("RIFF/WAVE stream was cancelled");
    this.name = "WavAbortError";
  }
}

export interface WavPcmFormat {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

export interface WavMetadata extends WavPcmFormat {
  dataBytes: number;
  durationSeconds: number;
}

export interface ParsedWavPrelude extends WavMetadata {
  reader: AsyncByteReader;
  dataPadBytes: number;
  fileEnd: number;
}

/** A bounded random-access reader used only for structural WAV preflight. */
export interface WavPositionalReader {
  readAt(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
}

export interface ParsedWavStructure extends WavMetadata {
  dataOffset: number;
  dataPadBytes: number;
  fileEnd: number;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new WavAbortError();
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
}

/** Incremental reader that retains only the current source slice. */
export class AsyncByteReader {
  private pending: Uint8Array | undefined;
  private offset = 0;
  private consumed = 0;
  private ended = false;

  constructor(private readonly iterator: AsyncIterator<Uint8Array>) {}

  get position(): number {
    return this.consumed;
  }

  private async next(signal: AbortSignal): Promise<IteratorResult<Uint8Array>> {
    checkAbort(signal);
    let nextResult: IteratorResult<Uint8Array> | PromiseLike<IteratorResult<Uint8Array>>;
    try {
      nextResult = this.iterator.next();
    } catch {
      throw new WavParseError();
    }
    if (!nextResult || typeof (nextResult as PromiseLike<IteratorResult<Uint8Array>>).then !== "function") return nextResult;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new WavAbortError());
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([nextResult, aborted]);
    } catch (error) {
      if (error instanceof WavAbortError || signal.aborted) throw new WavAbortError();
      if (error instanceof WavParseError) throw error;
      throw new WavParseError();
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private async available(signal: AbortSignal): Promise<Uint8Array | undefined> {
    while (this.pending === undefined || this.offset >= this.pending.byteLength) {
      if (this.ended) return undefined;
      const result = await this.next(signal);
      if (result.done) {
        this.ended = true;
        this.pending = undefined;
        return undefined;
      }
      const value = result.value;
      if (!(value instanceof Uint8Array)) throw new WavParseError();
      if (!value.byteLength) continue;
      this.pending = value;
      this.offset = 0;
    }
    return this.pending.subarray(this.offset);
  }

  async readExact(length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) throw new WavParseError();
    const output = new Uint8Array(length);
    await this.readInto(output, signal);
    return output;
  }

  async readInto(output: Uint8Array, signal: AbortSignal): Promise<void> {
    let written = 0;
    while (written < output.byteLength) {
      const available = await this.available(signal);
      if (available === undefined) throw new WavParseError();
      const copy = Math.min(available.byteLength, output.byteLength - written);
      output.set(available.subarray(0, copy), written);
      written += copy;
      this.offset += copy;
      this.consumed += copy;
    }
  }

  async skip(length: number, signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(length) || length < 0) throw new WavParseError();
    let remaining = length;
    while (remaining > 0) {
      const available = await this.available(signal);
      if (available === undefined) throw new WavParseError();
      const skipped = Math.min(available.byteLength, remaining);
      remaining -= skipped;
      this.offset += skipped;
      this.consumed += skipped;
    }
  }

  async assertEof(signal: AbortSignal): Promise<void> {
    while (true) {
      const available = await this.available(signal);
      if (available !== undefined && available.byteLength > 0) throw new WavParseError();
      if (this.ended) return;
    }
  }
}

function normalizedPcmFormat(bytes: Uint8Array): WavPcmFormat {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format: WavPcmFormat = {
    audioFormat: view.getUint16(0, true),
    channels: view.getUint16(2, true),
    sampleRate: view.getUint32(4, true),
    byteRate: view.getUint32(8, true),
    blockAlign: view.getUint16(12, true),
    bitsPerSample: view.getUint16(14, true),
  };
  if (
    format.audioFormat !== PCM_FORMAT
    || format.channels !== PCM_CHANNELS
    || format.sampleRate !== PCM_SAMPLE_RATE
    || format.byteRate !== PCM_BYTE_RATE
    || format.blockAlign !== PCM_BLOCK_ALIGN
    || format.bitsPerSample !== PCM_BITS_PER_SAMPLE
  ) throw new WavParseError();
  return format;
}

function parsedMetadata(format: WavPcmFormat, dataBytes: number): WavMetadata {
  if (!Number.isSafeInteger(dataBytes) || dataBytes <= 0 || dataBytes % PCM_BLOCK_ALIGN !== 0) throw new WavParseError();
  const durationSeconds = dataBytes / format.byteRate;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new WavParseError();
  return { ...format, dataBytes, durationSeconds };
}

async function positionalRead(source: WavPositionalReader, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
  checkAbort(signal);
  let bytes: Uint8Array;
  try {
    bytes = await source.readAt(offset, length, signal);
  } catch (error) {
    if (error instanceof WavAbortError || signal.aborted) throw new WavAbortError();
    throw new WavParseError();
  }
  checkAbort(signal);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new WavParseError();
  return bytes;
}

function chunkSize(header: Uint8Array): number {
  return new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4, true);
}

async function validatePositionalTail(source: WavPositionalReader, start: number, fileEnd: number, signal: AbortSignal): Promise<void> {
  let position = start;
  while (position < fileEnd) {
    checkAbort(signal);
    if (fileEnd - position < RIFF_CHUNK_HEADER_BYTES) throw new WavParseError();
    const header = await positionalRead(source, position, RIFF_CHUNK_HEADER_BYTES, signal);
    const chunkId = ascii(header.subarray(0, 4));
    const size = chunkSize(header);
    position += RIFF_CHUNK_HEADER_BYTES;
    const remaining = fileEnd - position;
    const paddedSize = size + (size & 1);
    if (size > remaining || paddedSize > remaining || chunkId === "data" || chunkId === "fmt ") throw new WavParseError();
    position += paddedSize;
  }
  if (position !== fileEnd) throw new WavParseError();
}

/**
 * Validate a complete bounded WAV by reading only its header fields and
 * positional chunk headers. PCM payload bytes are never loaded or retained.
 * A prepared local lease can then be opened once for exact data streaming.
 */
export async function readWavStructureAt(
  source: WavPositionalReader,
  actualFileSizeBytes: number,
  signal: AbortSignal,
): Promise<ParsedWavStructure> {
  if (!Number.isSafeInteger(actualFileSizeBytes) || actualFileSizeBytes < RIFF_HEADER_BYTES || actualFileSizeBytes > MAX_RIFF_FILE_BYTES) throw new WavParseError();
  const header = await positionalRead(source, 0, RIFF_HEADER_BYTES, signal);
  if (ascii(header.subarray(0, 4)) !== "RIFF" || ascii(header.subarray(8, 12)) !== "WAVE") throw new WavParseError();
  const riffSize = chunkSize(header);
  const fileEnd = riffSize === RIFF_SIZE_SENTINEL ? actualFileSizeBytes : riffSize + 8;
  if (fileEnd < RIFF_HEADER_BYTES || fileEnd !== actualFileSizeBytes) throw new WavParseError();

  let format: WavPcmFormat | undefined;
  let position = RIFF_HEADER_BYTES;
  while (position < fileEnd) {
    checkAbort(signal);
    if (fileEnd - position < RIFF_CHUNK_HEADER_BYTES) throw new WavParseError();
    const headerBytes = await positionalRead(source, position, RIFF_CHUNK_HEADER_BYTES, signal);
    const id = ascii(headerBytes.subarray(0, 4));
    const size = chunkSize(headerBytes);
    position += RIFF_CHUNK_HEADER_BYTES;
    const remaining = fileEnd - position;

    if (id === "data" && size === RIFF_SIZE_SENTINEL) {
      if (!format) throw new WavParseError();
      return { ...parsedMetadata(format, remaining), dataOffset: position, dataPadBytes: 0, fileEnd };
    }

    const paddedSize = size + (size & 1);
    if (size > remaining || paddedSize > remaining) throw new WavParseError();
    if (id === "fmt ") {
      if (format || size < 16) throw new WavParseError();
      const fmtBytes = await positionalRead(source, position, 16, signal);
      format = normalizedPcmFormat(fmtBytes);
    } else if (id === "data") {
      if (!format) throw new WavParseError();
      const metadata = parsedMetadata(format, size);
      const dataOffset = position;
      position += paddedSize;
      await validatePositionalTail(source, position, fileEnd, signal);
      return { ...metadata, dataOffset, dataPadBytes: size & 1, fileEnd };
    }
    position += paddedSize;
  }
  throw new WavParseError();
}

/**
 * Parse a bounded normalized PCM WAV stream and stop at the data payload.
 *
 * Finite RIFF sizes must equal the caller's actual bounded file size. The
 * all-ones RIFF/data sizes are accepted only as stream placeholders: RIFF is
 * reconciled to the bounded EOF and a sentinel data chunk extends to that EOF.
 */
export async function parseWavPrelude(
  iterator: AsyncIterator<Uint8Array>,
  actualFileSizeBytes: number,
  signal: AbortSignal,
): Promise<ParsedWavPrelude> {
  if (!Number.isSafeInteger(actualFileSizeBytes) || actualFileSizeBytes < RIFF_HEADER_BYTES || actualFileSizeBytes > MAX_RIFF_FILE_BYTES) throw new WavParseError();
  const reader = new AsyncByteReader(iterator);
  const header = await reader.readExact(RIFF_HEADER_BYTES, signal);
  if (ascii(header.subarray(0, 4)) !== "RIFF" || ascii(header.subarray(8, 12)) !== "WAVE") throw new WavParseError();
  const riffSize = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4, true);
  const fileEnd = riffSize === RIFF_SIZE_SENTINEL ? actualFileSizeBytes : riffSize + 8;
  if (fileEnd < RIFF_HEADER_BYTES || fileEnd !== actualFileSizeBytes) throw new WavParseError();

  let format: WavPcmFormat | undefined;
  while (reader.position < fileEnd) {
    checkAbort(signal);
    if (fileEnd - reader.position < RIFF_CHUNK_HEADER_BYTES) throw new WavParseError();
    const chunkHeader = await reader.readExact(RIFF_CHUNK_HEADER_BYTES, signal);
    const chunkId = ascii(chunkHeader.subarray(0, 4));
    const size = chunkSize(chunkHeader);
    const remaining = fileEnd - reader.position;

    if (chunkId === "data" && size === RIFF_SIZE_SENTINEL) {
      if (!format) throw new WavParseError();
      const metadata = parsedMetadata(format, remaining);
      return { reader, ...metadata, dataPadBytes: 0, fileEnd };
    }

    const paddedSize = size + (size & 1);
    if (size > remaining || paddedSize > remaining) throw new WavParseError();
    if (chunkId === "fmt ") {
      if (format || size < 16) throw new WavParseError();
      const fmtBytes = await reader.readExact(16, signal);
      format = normalizedPcmFormat(fmtBytes);
      await reader.skip(size - 16, signal);
    } else if (chunkId === "data") {
      if (!format) throw new WavParseError();
      const metadata = parsedMetadata(format, size);
      return { reader, ...metadata, dataPadBytes: size & 1, fileEnd };
    } else {
      await reader.skip(size, signal);
    }
    if ((size & 1) !== 0) await reader.skip(1, signal);
  }
  throw new WavParseError();
}

/** Validate the pad and every RIFF chunk after a consumed data payload. */
export async function validateWavTail(parsed: ParsedWavPrelude, signal: AbortSignal): Promise<void> {
  const { reader, fileEnd } = parsed;
  if (parsed.dataPadBytes) await reader.skip(parsed.dataPadBytes, signal);
  while (reader.position < fileEnd) {
    checkAbort(signal);
    if (fileEnd - reader.position < RIFF_CHUNK_HEADER_BYTES) throw new WavParseError();
    const chunkHeader = await reader.readExact(RIFF_CHUNK_HEADER_BYTES, signal);
    const chunkId = ascii(chunkHeader.subarray(0, 4));
    const size = chunkSize(chunkHeader);
    const remaining = fileEnd - reader.position;
    const paddedSize = size + (size & 1);
    if (size > remaining || paddedSize > remaining) throw new WavParseError();
    if (chunkId === "data" || chunkId === "fmt ") throw new WavParseError();
    await reader.skip(size, signal);
    if ((size & 1) !== 0) await reader.skip(1, signal);
  }
  if (reader.position !== fileEnd) throw new WavParseError();
  await reader.assertEof(signal);
}

/** Consume a complete bounded WAV and return metadata without retaining payload bytes. */
export async function readWavMetadata(
  iterator: AsyncIterator<Uint8Array>,
  actualFileSizeBytes: number,
  signal: AbortSignal,
): Promise<WavMetadata> {
  const parsed = await parseWavPrelude(iterator, actualFileSizeBytes, signal);
  await parsed.reader.skip(parsed.dataBytes, signal);
  await validateWavTail(parsed, signal);
  return {
    audioFormat: parsed.audioFormat,
    channels: parsed.channels,
    sampleRate: parsed.sampleRate,
    byteRate: parsed.byteRate,
    blockAlign: parsed.blockAlign,
    bitsPerSample: parsed.bitsPerSample,
    dataBytes: parsed.dataBytes,
    durationSeconds: parsed.durationSeconds,
  };
}
