import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface LifecycleFileReference { encoding: "file"; path: string; sha256: string; size: number }

export function assertLifecyclePath(path: string): void {
  let parent = resolve(path);
  for (;;) {
    try { if (parent !== "/tmp" && parent !== "/var" && lstatSync(parent).isSymbolicLink()) throw new Error(`symlink in lifecycle file path: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
}

function regular(path: string): number {
  assertLifecyclePath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!fstatSync(fd).isFile()) { closeSync(fd); throw new Error(`non-regular lifecycle file: ${path}`); }
  return fd;
}

/** One bounded buffer; neither snapshots nor CAS materialize artifact contents. */
export function lifecycleFileDigest(path: string, destination?: string): { sha256: string; size: number } {
  const input = regular(path);
  let output: number | undefined;
  try {
    if (destination) { assertLifecyclePath(destination); output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let size = 0;
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      if (output !== undefined) {
        let offset = 0;
        while (offset < count) offset += writeSync(output, buffer, offset, count - offset);
      }
      size += count;
    }
    if (output !== undefined) fsyncSync(output);
    return { sha256: hash.digest("hex"), size };
  } finally { closeSync(input); if (output !== undefined) closeSync(output); }
}
