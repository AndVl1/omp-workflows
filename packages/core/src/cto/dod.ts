/**
 * Canonical CTO per-slice DoD projection and descriptor-bound persistence.
 *
 * CTO preparation owns these artifacts.  The digest deliberately excludes
 * `updated_at` (audit metadata) and any engine-added bookkeeping so replay and
 * dispatch compare the same semantic DoD document.  Writes are exclusive:
 * an existing file is accepted only when its canonical projection has the
 * exact expected digest; it is never replaced by a later preparation.
 */

import { join } from "node:path";
import type { DoD, DoDItem } from "../engine/types.js";
import { isValidDodSource, MAX_DOD_BYTES, readDoDFilePinned } from "../engine/dod.js";
import { PinnedProjectRoot, PinnedRootError } from "../specification/pinned-root.js";
import { digestOf, sha256Hex } from "../specification/validation.js";
export interface CanonicalCtoDoDProjection {
  items: DoDItem[];
  type_requirements_met: true;
}

/**
 * Return the one semantic DoD projection used by preparation, replay, and the
 * slice gate.  This is intentionally strict: a malformed artifact cannot be
 * turned into a digest that accidentally authorizes a slice.
 */
export function canonicalCtoDoDProjection(value: unknown): CanonicalCtoDoDProjection {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (value as Record<string, unknown>).type_requirements_met !== true
    || !Array.isArray((value as Record<string, unknown>).items)
    || ((value as Record<string, unknown>).items as unknown[]).length === 0) {
    throw new Error("CTO DoD must contain non-empty items and type_requirements_met=true");
  }
  const seen = new Set<string>();
  const items = ((value as Record<string, unknown>).items as unknown[]).map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`CTO DoD item ${index} is malformed or duplicated`);
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.trim().length === 0
      || !isValidDodSource(item.source)
      || typeof item.criterion !== "string" || item.criterion.trim().length === 0
      || typeof item.verify_method !== "string" || item.verify_method.trim().length === 0
      || (item.status !== "pending" && item.status !== "met")
      || typeof item.evidence !== "string"
      || (item.status === "met" && item.evidence.trim().length === 0)
      || seen.has(item.id)) {
      throw new Error(`CTO DoD item ${index} is malformed or duplicated`);
    }
    seen.add(item.id);
    return {
      id: item.id,
      source: item.source,
      criterion: item.criterion,
      verify_method: item.verify_method,
      status: item.status,
      evidence: item.evidence,
    } as DoDItem;
  });
  return { items, type_requirements_met: true };
}

/** SHA-256 digest of the canonical semantic CTO DoD projection. */
export function canonicalCtoDoDDigest(value: unknown): string {
  return digestOf(canonicalCtoDoDProjection(value));
}

/**
 * Persist one prepared DoD under a pinned root without replacing an existing
 * artifact.  Replaying the same semantic DoD is a no-op; a collision fails
 * closed before any state can reference the replacement.
 */
export interface CtoDoDWriteOwnershipToken {
  path: string;
  relative_path: string;
  dev: number;
  ino: number;
  size: number;
  sha256: string;
}

export interface CtoDoDWriteOptions {
  beforeWrite?: () => void;
  onCreated?: (ownership: CtoDoDWriteOwnershipToken) => void;
}

export function writeCtoDoDExclusive(
  pinnedRoot: PinnedProjectRoot,
  artifactsDirRelative: string,
  dod: DoD,
  options: CtoDoDWriteOptions = {},
): { path: string; digest: string; created: boolean } {
  const projection = canonicalCtoDoDProjection(dod);
  const digest = digestOf(projection);
  const relativePath = `${artifactsDirRelative}/dod.json`;
  const content = `${JSON.stringify({ ...projection, updated_at: dod.updated_at }, null, 2)}\n`;
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > MAX_DOD_BYTES) {
    throw new Error(`CTO_DOD_ARTIFACT_OVERSIZED: serialized DoD exceeds ${MAX_DOD_BYTES} bytes`);
  }
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before CTO DoD write");
  pinnedRoot.ensureDirectory(artifactsDirRelative);
  let created = false;
  try {
    options.beforeWrite?.();
    pinnedRoot.writeExclusive(relativePath, content);
    created = true;
  } catch (error) {
    if (!(error instanceof PinnedRootError && error.code === "exists")) throw error;
    const existingRead = readDoDFilePinned(pinnedRoot, relativePath);
    if (!existingRead.ok) {
      throw new Error(`CTO_DOD_ARTIFACT_COLLISION: existing DoD cannot be read safely: ${existingRead.reason}`);
    }
    let existingDigest: string;
    try {
      existingDigest = canonicalCtoDoDDigest(existingRead.dod);
    } catch (parseError) {
      throw new Error(`CTO_DOD_ARTIFACT_COLLISION: existing DoD is malformed: ${String(parseError)}`);
    }
    if (existingDigest !== digest) {
      throw new Error(`CTO_DOD_ARTIFACT_COLLISION: existing DoD digest ${existingDigest} differs from prepared digest ${digest}`);
    }
  }
  if (!pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed after CTO DoD write");
  if (created && options.onCreated) {
    const observed = pinnedRoot.readFile(relativePath, { maxBytes: MAX_DOD_BYTES });
    const info = pinnedRoot.pathEntryInfo(relativePath);
    if (!info || info.kind !== "file" || info.dev !== observed.dev || info.ino !== observed.ino || info.size !== observed.bytes.byteLength) {
      throw new PinnedRootError("changed", "new CTO DoD identity could not be captured after exclusive write");
    }
    options.onCreated({
      path: observed.path,
      relative_path: relativePath,
      dev: observed.dev,
      ino: observed.ino,
      size: observed.bytes.byteLength,
      sha256: sha256Hex(Buffer.from(observed.bytes).toString("utf8")),
    });
  }
  return { path: join(pinnedRoot.canonical_root, ...relativePath.split("/")), digest, created };
}
