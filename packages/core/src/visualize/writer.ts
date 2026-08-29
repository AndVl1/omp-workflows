/**
 * Visualize OPT-A — whole-bundle publisher through an instance-bound tree
 * storage authority.
 *
 * The writer validates the complete generated bundle and delegates the actual
 * atomic replacement, pruning, containment and permission policy to the
 * owning storage authority. It never receives a cwd/root and never performs
 * pathname-backed filesystem operations itself.
 */

import {
  isReportTreeStorageAuthority,
  MAX_STORAGE_ENTRIES,
  MAX_STORAGE_PATH_CHARS,
  MAX_STORAGE_TREE_TOTAL_BYTES,
  MAX_STORAGE_WRITE_BYTES,
  replaceStorageTreeAtomic,
  type ReportTreeStorageAuthority,
  type StorageTreeEntry,
  type StorageTreeLimits,
} from "../report/storage.js";
import {
  VISUALIZE_OUTPUT_FILES,
  VISUALIZE_OUTPUT_ROOT,
  isSafePathKey,
  type OutputFileExtension,
  type SessionKind,
} from "./types.js";

// ── Public contract ──────────────────────────────────────────────────────────

/** One generated file of the complete bundle, relative to the visualize root. */
export interface VisualizeBundleFile {
  /** Safe relative path inside the visualize output root (derived-page shape). */
  relPath: string;
  content: string;
}

export type VisualizePublishErrorCode =
  | "empty-bundle"
  | "missing-manifest"
  | "unsafe-relpath"
  | "duplicate-file"
  | "storage-unavailable";

/**
 * Typed publish error. `message` is sanitized: relative descriptions only —
 * never raw OS errors, never absolute paths, never file content.
 */
export class VisualizePublishError extends Error {
  readonly code: VisualizePublishErrorCode;

  constructor(code: VisualizePublishErrorCode, message: string) {
    super(message);
    this.name = "VisualizePublishError";
    this.code = code;
  }
}

export type VisualizePublishStatus = "published";

export interface VisualizePublishCounters {
  filesWritten: number;
  bytesWritten: number;
  filesPruned: number;
}

export interface VisualizePublishResult {
  status: VisualizePublishStatus;
  /** Descriptor-relative paths of the live bundle files (sorted). */
  files: string[];
  /** Descriptor-relative paths of pruned old derived pages (sorted). */
  pruned: string[];
  counters: VisualizePublishCounters;
  warnings: string[];
}

// ── Derived-page shape validation (implementation_contract.output) ───────────

const SESSION_KINDS: Record<string, true> = {
  feature: true,
  legacy: true,
  cto: true,
};
const HUB_FILE_NAMES: Record<string, true> = {
  [VISUALIZE_OUTPUT_FILES.hubMarkdown]: true,
  [VISUALIZE_OUTPUT_FILES.hubHtml]: true,
  [VISUALIZE_OUTPUT_FILES.manifest]: true,
};

const TREE_LIMITS: StorageTreeLimits = Object.freeze({
  max_path_chars: MAX_STORAGE_PATH_CHARS,
  max_file_bytes: MAX_STORAGE_WRITE_BYTES,
  max_entries: MAX_STORAGE_ENTRIES,
  max_total_bytes: MAX_STORAGE_TREE_TOTAL_BYTES,
});

type DerivedPage =
  | { kind: "hub"; relPath: string }
  | { kind: "session"; sessionKind: SessionKind; pathKey: string; ext: OutputFileExtension; relPath: string };

/**
 * Parse + validate a bundle-relative path against the frozen output shapes:
 * `index.md` / `index.html` / `manifest.json` or
 * `sessions/<kind>/<pathKey>.<ext>` where kind ∈ {feature, legacy, cto} and
 * pathKey passes {@link isSafePathKey}.
 */
function parseDerivedPage(relPath: string): DerivedPage | null {
  if (
    typeof relPath !== "string"
    || relPath.length === 0
    || relPath.startsWith("/")
    || /^[A-Za-z]:[\\/]/u.test(relPath)
    || relPath.includes("\\")
    || /[\u0000-\u001f\u007f-\u009f]/u.test(relPath)
  ) {
    return null;
  }
  const segments = relPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  if (segments.length === 1 && HUB_FILE_NAMES[segments[0]!] === true) {
    return { kind: "hub", relPath };
  }
  if (segments.length !== 3 || segments[0] !== "sessions") return null;
  const kind = segments[1]!;
  if (SESSION_KINDS[kind] !== true) return null;
  const file = segments[2]!;
  const ext: OutputFileExtension | null = file.endsWith(".html")
    ? "html"
    : file.endsWith(".md")
      ? "md"
      : null;
  if (ext === null) return null;
  const pathKey = file.slice(0, -ext.length - 1);
  if (!isSafePathKey(pathKey)) return null;
  return { kind: "session", sessionKind: kind as SessionKind, pathKey, ext, relPath };
}

function outputPath(relativePath: string): string {
  return `${VISUALIZE_OUTPUT_ROOT}/${relativePath}`;
}

function storageUnavailable(): VisualizePublishError {
  return new VisualizePublishError(
    "storage-unavailable",
    "publish: whole-tree storage authority is unavailable",
  );
}

// ── Public entry ─────────────────────────────────────────────────────────────

/**
 * Validate and atomically publish a complete visualize bundle through the
 * authority issued by the owning boundary.
 */
export function publishVisualize(
  storage: ReportTreeStorageAuthority,
  files: ReadonlyArray<VisualizeBundleFile>,
): VisualizePublishResult {
  // Bundle validation is deliberately side-effect free and precedes the
  // capability check and delegated publication.
  if (!Array.isArray(files) || files.length === 0) {
    throw new VisualizePublishError("empty-bundle", "publish: nothing to publish (empty bundle)");
  }

  const seen = new Set<string>();
  let hasManifest = false;
  let bytesWritten = 0;
  const encoder = new TextEncoder();
  const entries: StorageTreeEntry[] = [];

  for (const file of files) {
    if (typeof file?.relPath !== "string" || parseDerivedPage(file.relPath) === null) {
      throw new VisualizePublishError("unsafe-relpath", "publish: invalid bundle path");
    }
    if (seen.has(file.relPath)) {
      throw new VisualizePublishError("duplicate-file", `publish: duplicate bundle path "${file.relPath}"`);
    }
    if (typeof file.content !== "string") {
      throw new VisualizePublishError("unsafe-relpath", `publish: invalid bundle path "${file.relPath}"`);
    }
    if (file.relPath.length > TREE_LIMITS.max_path_chars) {
      throw new VisualizePublishError("unsafe-relpath", "publish: bundle path exceeds the storage bound");
    }
    const bytes = encoder.encode(file.content);
    if (bytes.byteLength > TREE_LIMITS.max_file_bytes) {
      throw new VisualizePublishError("storage-unavailable", "publish: bundle exceeds the storage bound");
    }
    bytesWritten += bytes.byteLength;
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten > TREE_LIMITS.max_total_bytes) {
      throw new VisualizePublishError("storage-unavailable", "publish: bundle exceeds the storage bound");
    }
    seen.add(file.relPath);
    if (file.relPath === VISUALIZE_OUTPUT_FILES.manifest) hasManifest = true;
    entries.push({ relative_path: file.relPath, bytes });
  }

  if (!hasManifest) {
    throw new VisualizePublishError(
      "missing-manifest",
      `publish: bundle must include ${VISUALIZE_OUTPUT_FILES.manifest}`,
    );
  }

  if (!isReportTreeStorageAuthority(storage)) throw storageUnavailable();

  let published: ReturnType<typeof replaceStorageTreeAtomic>;
  try {
    published = replaceStorageTreeAtomic(storage, VISUALIZE_OUTPUT_ROOT, entries, TREE_LIMITS);
  } catch {
    // Storage failures are intentionally opaque to this projection layer: do
    // not leak native errors, roots, or backend details into the result.
    throw storageUnavailable();
  }

  return {
    status: "published",
    files: [...seen].sort().map(outputPath),
    pruned: [...published.pruned].sort().map(outputPath),
    counters: {
      filesWritten: entries.length,
      bytesWritten,
      filesPruned: published.pruned.length,
    },
    warnings: [...published.warnings].sort(),
  };
}
