import {
  persistReturnedArtifactsPinned,
  readArtifactPinned,
  readPinnedArtifactSnapshot,
  writeArtifactPinned,
} from "../../src/engine/artifacts.js";
import { PinnedProjectRoot } from "../../src/specification/pinned-root.js";

function withPinnedRoot<T>(root: string, artifactsDir: string, callback: (pinnedRoot: PinnedProjectRoot, relativeDir: string) => T): T {
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error("test artifact root cannot be pinned");
  try {
    const relativeDir = pinnedRoot.relativePath(artifactsDir);
    if (relativeDir === null) throw new Error("test artifact directory is outside pinned root");
    return callback(pinnedRoot, relativeDir);
  } finally {
    pinnedRoot.close();
  }
}

/** Write a test artifact through a short-lived descriptor-anchored root. */
export function writeTestArtifact(root: string, artifactsDir: string, id: string, data: unknown): string {
  return withPinnedRoot(root, artifactsDir, (pinnedRoot, relativeDir) => {
    const relativePath = writeArtifactPinned(pinnedRoot, relativeDir, id, data);
    return pinnedRoot.anchorPath(relativePath);
  });
}

/** Read a test artifact through a short-lived descriptor-anchored root. */
export function readTestArtifact<T = unknown>(root: string, artifactsDir: string, id: string): T | null {
  return withPinnedRoot(root, artifactsDir, (pinnedRoot, relativeDir) => readArtifactPinned<T>(pinnedRoot, relativeDir, id));
}

/** Read a test snapshot through a short-lived descriptor-anchored root. */
export function readTestArtifactSnapshot(root: string, artifactsDir: string, id: string):
  | { ok: true; bytes: Readonly<Uint8Array>; value: unknown; sha256: string; size: number; stat: { size: number } }
  | { ok: false; kind: "encoding" | "malformed" | "missing"; reason: string } {
  return withPinnedRoot(root, artifactsDir, (pinnedRoot, relativeDir) => {
    try {
      const snapshot = readPinnedArtifactSnapshot(pinnedRoot, relativeDir, id);
      return { ok: true, bytes: Buffer.from(snapshot.bytes), value: snapshot.value, sha256: snapshot.sha256, size: snapshot.size, stat: { size: snapshot.size } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes("not found") || reason.includes("no such file")) return { ok: false, kind: "missing", reason };
      return { ok: false, kind: reason.includes("UTF-8") ? "encoding" : "malformed", reason };
    }
  });
}

/** Persist returned test artifacts through a descriptor-anchored root. */
export function persistTestArtifacts(root: string, artifactsDir: string, artifacts: Record<string, unknown>): string[] {
  return withPinnedRoot(root, artifactsDir, (pinnedRoot, relativeDir) => persistReturnedArtifactsPinned(pinnedRoot, relativeDir, artifacts));
}
