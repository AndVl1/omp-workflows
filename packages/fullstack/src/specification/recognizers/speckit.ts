/**
 * Local Spec Kit artifact recognizer (T065).
 *
 * Recognition consumes only the immutable normalized documents captured by the
 * core secure importer. It never opens, stats, resolves, or follows a source
 * path; all output paths are source-root-relative references.
 */

import type {
  FormatRecognitionResult,
  FormatRecognizer,
  FormatRecognizerInput,
} from "@andvl1/omp-workflows-core";
import { inspectUnsafeRecognizerContent, prepareRecognizerInput } from "./captured.js";

export const SPECKIT_RECOGNIZER_ID = "speckit";
export const SPECKIT_MAPPING_ID = "speckit-feature";
export const SPECKIT_MAPPING_VERSION = "1";

const MAX_INSPECTED_FILE_BYTES = 2 * 1024 * 1024;
const FEATURE_DOCUMENT_KINDS = ["plan", "spec", "tasks"] as const;
type FeatureDocumentKind = (typeof FEATURE_DOCUMENT_KINDS)[number];
const FEATURE_MEMBER_RE = /^(?:(.*)\/)?specs\/([^/]+)\/(spec|plan|tasks)\.(?:md|markdown)$/;

interface IgnoredCandidate {
  readonly path: string;
  readonly reason: string;
}

function isFeatureDocumentKind(value: string): value is FeatureDocumentKind {
  return (FEATURE_DOCUMENT_KINDS as readonly string[]).includes(value);
}

function inspectDocument(document: FormatRecognizerInput["documents"][number]): string | null {
  if (document.size_bytes > MAX_INSPECTED_FILE_BYTES || Buffer.byteLength(document.text, "utf8") > MAX_INSPECTED_FILE_BYTES) {
    return `document exceeds the ${MAX_INSPECTED_FILE_BYTES}-byte inspection bound`;
  }
  if (document.text.length === 0) return "empty documents carry no specification content";
  return inspectUnsafeRecognizerContent(document.text);
}

function freezeResult(result: FormatRecognitionResult): FormatRecognitionResult {
  return Object.freeze({
    ...result,
    selected_paths: Object.freeze([...result.selected_paths]) as string[],
    ignored_candidates: Object.freeze(
      result.ignored_candidates.map((entry) => Object.freeze({ path: entry.path, reason: entry.reason })),
    ) as Array<{ path: string; reason: string }>,
  });
}

/** Recognize one complete, readable Spec Kit feature directory. */
export function analyzeSpeckitLayout(input: FormatRecognizerInput): FormatRecognitionResult | null {
  const prepared = prepareRecognizerInput(input);
  if (prepared === null) return null;
  const ignored: IgnoredCandidate[] = prepared.ignored_candidates.map((entry) => ({ path: entry.path, reason: entry.reason }));
  const members = new Map<string, Map<FeatureDocumentKind, string[]>>();
  const duplicateFeatures = new Set<string>();
  const candidates = [...prepared.documents].sort((left, right) => left.source_ref < right.source_ref ? -1 : left.source_ref > right.source_ref ? 1 : 0);
  // Discovery is rooted at the authorized project, so an imported bundle may
  // be mounted below a path such as `imported/<bundle>`. Keep the original
  // source-root-relative references while matching the framework layout at any
  // immutable `.specify`-marked mount.
  const specKitPrefixes = new Set<string>();
  for (const candidate of candidates) {
    const segments = candidate.source_ref.split("/");
    const marker = segments.indexOf(".specify");
    if (marker >= 0) specKitPrefixes.add(segments.slice(0, marker).join("/"));
  }

  for (const document of candidates) {
    const relativePath = document.source_ref;
    if (relativePath.split("/").includes("attachments")) {
      ignored.push({ path: relativePath, reason: "attachment material is excluded from specification selection" });
      continue;
    }
    const match = FEATURE_MEMBER_RE.exec(relativePath);
    if (match === null) continue;
    const prefix = match[1] ?? "";
    if (!specKitPrefixes.has(prefix)) continue;
    const feature = match[2];
    const kind = match[3];
    if (feature === undefined || kind === undefined || !isFeatureDocumentKind(kind)) continue;
    const inspection = inspectDocument(document);
    if (inspection !== null) {
      ignored.push({ path: relativePath, reason: inspection });
      continue;
    }
    const featureDir = prefix === "" ? `specs/${feature}` : `${prefix}/specs/${feature}`;
    const byKind = members.get(featureDir) ?? new Map<FeatureDocumentKind, string[]>();
    const paths = byKind.get(kind) ?? [];
    paths.push(relativePath);
    byKind.set(kind, paths);
    if (paths.length > 1) duplicateFeatures.add(`${featureDir}\u0000${kind}`);
    members.set(featureDir, byKind);
  }

  const complete: string[] = [];
  for (const dir of [...members.keys()].sort()) {
    const byKind = members.get(dir);
    if (byKind !== undefined && FEATURE_DOCUMENT_KINDS.every((kind) => byKind.has(kind))) complete.push(dir);
  }
  const duplicateDirs = new Set([...duplicateFeatures].map((key) => key.split("\u0000", 1)[0]!));
  if (complete.length === 0 && duplicateDirs.size === 0) return null;

  if (complete.length > 1 || duplicateDirs.size > 0) {
    const competing: IgnoredCandidate[] = [...ignored];
    const competingDirs = complete.length > 1 ? complete : [...duplicateDirs].sort();
    for (const dir of competingDirs) {
      const byKind = members.get(dir);
      if (byKind === undefined) continue;
      for (const kind of FEATURE_DOCUMENT_KINDS) {
        const paths = byKind.get(kind) ?? [];
        for (const member of paths) {
          const duplicate = duplicateFeatures.has(`${dir}\u0000${kind}`);
          competing.push({
            path: member,
            reason: duplicate
              ? `duplicate Spec Kit ${kind} document for feature directory '${dir}' requires explicit selection`
              : `competing feature directory '${dir}' requires explicit selection`,
          });
        }
      }
    }
    competing.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0);
    return freezeResult({
      framework: SPECKIT_RECOGNIZER_ID,
      confidence: "ambiguous",
      selected_paths: [],
      ignored_candidates: competing,
      mapping_id: SPECKIT_MAPPING_ID,
      mapping_version: SPECKIT_MAPPING_VERSION,
    });
  }
  const dir = complete[0];
  const byKind = dir === undefined ? undefined : members.get(dir);
  if (dir === undefined || byKind === undefined) return null;
  const selected = FEATURE_DOCUMENT_KINDS.flatMap((kind) => byKind.get(kind) ?? []).sort();
  return freezeResult({
    framework: SPECKIT_RECOGNIZER_ID,
    confidence: "high",
    selected_paths: selected,
    ignored_candidates: ignored,
    mapping_id: SPECKIT_MAPPING_ID,
    mapping_version: SPECKIT_MAPPING_VERSION,
  });
}

export const speckitRecognizer: FormatRecognizer = Object.freeze({
  recognizer_id: SPECKIT_RECOGNIZER_ID,
  recognize: analyzeSpeckitLayout,
});
