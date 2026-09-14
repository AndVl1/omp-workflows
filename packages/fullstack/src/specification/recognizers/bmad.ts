/**
 * T067 — Local BMAD specification artifact recognition.
 *
 * Recognition consumes only immutable normalized documents captured by core;
 * it never opens, stats, resolves, or follows source paths.
 */

import { basename, extname } from "node:path";
import type {
  FormatRecognitionResult,
  FormatRecognizer,
  FormatRecognizerInput,
} from "@andvl1/omp-workflows-core";
import { inspectUnsafeRecognizerContent, prepareRecognizerInput } from "./captured.js";

export const BMAD_RECOGNIZER_ID = "bmad";
export const BMAD_MAPPING_ID = "bmad.external-import";
export const BMAD_MAPPING_VERSION = "1.0.0";

const MAX_RECOGNITION_CANDIDATES = 8192;
const MAX_RECOGNIZED_FILE_BYTES = 4 * 1024 * 1024;
const TEXT_EXTENSIONS: Record<string, true> = { ".md": true, ".markdown": true, ".txt": true };
const CANONICAL_DOCS_DIR = "bmad/docs";
const CANONICAL_PRD_PATH = `${CANONICAL_DOCS_DIR}/prd.md`;
const CANONICAL_ARCHITECTURE_PATH = `${CANONICAL_DOCS_DIR}/architecture.md`;
const CANONICAL_STORIES_DIR = `${CANONICAL_DOCS_DIR}/stories`;
const STORY_BASENAME_PATTERN = /^story-.+\.(?:md|markdown|txt)$/iu;
const CANONICAL_ARTIFACT_BASENAMES: Record<string, true> = {
  [basename(CANONICAL_PRD_PATH)]: true,
  [basename(CANONICAL_ARCHITECTURE_PATH)]: true,
};

type CanonicalRole = "prd" | "architecture" | "story";
interface CandidateAssessment {
  path: string;
  relativePath: string;
  kind: "selected" | "ignored" | "competing";
  reason: string | null;
}

function canonicalDocumentPath(relativePath: string): string | null {
  const segments = relativePath.split("/");
  const docsIndex = segments.findIndex((segment, index) => segment === "bmad" && segments[index + 1] === "docs");
  const rawCanonicalPath = docsIndex >= 0 ? segments.slice(docsIndex).join("/") : relativePath;
  const extension = extname(rawCanonicalPath).toLowerCase();
  const canonicalPath = TEXT_EXTENSIONS[extension] === true
    ? `${rawCanonicalPath.slice(0, -extension.length)}.md`
    : rawCanonicalPath;
  if (canonicalPath === CANONICAL_PRD_PATH || canonicalPath === CANONICAL_ARCHITECTURE_PATH) return canonicalPath;
  if (canonicalPath.startsWith(`${CANONICAL_STORIES_DIR}/`) && STORY_BASENAME_PATTERN.test(basename(canonicalPath))) return canonicalPath;
  return null;
}

function canonicalRole(relativePath: string): CanonicalRole | null {
  const canonicalPath = canonicalDocumentPath(relativePath);
  if (canonicalPath === CANONICAL_PRD_PATH) return "prd";
  if (canonicalPath === CANONICAL_ARCHITECTURE_PATH) return "architecture";
  if (canonicalPath?.startsWith(`${CANONICAL_STORIES_DIR}/`)) return "story";
  return null;
}

function canonicalRoot(relativePath: string): string | null {
  const segments = relativePath.split("/");
  const docsIndex = segments.findIndex((segment, index) => segment === "bmad" && segments[index + 1] === "docs");
  return docsIndex >= 0 ? segments.slice(0, docsIndex).join("/") : null;
}

function ignored(path: string, relativePath: string, reason: string): CandidateAssessment {
  return { path, relativePath, kind: "ignored", reason };
}


function assessCanonicalContent(document: FormatRecognizerInput["documents"][number]): CandidateAssessment {
  const path = document.source_ref;
  if (document.size_bytes > MAX_RECOGNIZED_FILE_BYTES || Buffer.byteLength(document.text, "utf8") > MAX_RECOGNIZED_FILE_BYTES) {
    return ignored(path, path, "file exceeds the 4 MiB bounded recognition limit");
  }
  if (document.text.length === 0) return ignored(path, path, "canonical BMAD document is empty");
  const unsafeReason = inspectUnsafeRecognizerContent(document.text);
  if (unsafeReason !== null) return ignored(path, path, unsafeReason);
  return { path, relativePath: path, kind: "selected", reason: null };
}

function assessCandidate(document: FormatRecognizerInput["documents"][number]): CandidateAssessment {
  const relativePath = document.source_ref;
  const extension = extname(relativePath).toLowerCase();
  const role = canonicalRole(relativePath);
  if (extension && TEXT_EXTENSIONS[extension] !== true) return ignored(relativePath, relativePath, "unsupported media: only bounded markdown/text documents are recognized");
  if (relativePath.split("/").includes("attachments")) return ignored(relativePath, relativePath, "attachment material is excluded from specification selection");
  if (role === null) {
    const name = basename(relativePath);
    if (CANONICAL_ARTIFACT_BASENAMES[name] === true) {
      return { path: relativePath, relativePath, kind: "competing", reason: `competing canonical artifact: '${relativePath}' shadows the canonical '${CANONICAL_DOCS_DIR}/${name}'` };
    }
    if (STORY_BASENAME_PATTERN.test(name)) {
      return { path: relativePath, relativePath, kind: "competing", reason: `competing canonical artifact: '${relativePath}' is outside the canonical '${CANONICAL_STORIES_DIR}/' set` };
    }
    return ignored(relativePath, relativePath, "not part of the canonical BMAD document set (bmad/docs/prd.md, bmad/docs/architecture.md, bmad/docs/stories/story-*.md)");
  }
  return assessCanonicalContent(document);
}

function freezeResult(result: FormatRecognitionResult): FormatRecognitionResult {
  return Object.freeze({
    ...result,
    selected_paths: Object.freeze([...result.selected_paths]) as string[],
    ignored_candidates: Object.freeze(result.ignored_candidates.map((entry) => Object.freeze({ path: entry.path, reason: entry.reason }))) as Array<{ path: string; reason: string }>,
  });
}
export function analyzeBmadLayout(input: FormatRecognizerInput): FormatRecognitionResult | null {
  const prepared = prepareRecognizerInput(input);
  if (prepared === null) return null;
  const candidates = [...prepared.documents].sort((left, right) => left.source_ref < right.source_ref ? -1 : left.source_ref > right.source_ref ? 1 : 0).slice(0, MAX_RECOGNITION_CANDIDATES);
  const assessments = candidates.map(assessCandidate);
  const ignored = [
    ...prepared.ignored_candidates,
    ...assessments.filter((assessment) => assessment.kind !== "selected").map((assessment) => ({ path: assessment.path, reason: assessment.reason ?? "candidate is not selected" })),
  ];
  if (!assessments.some((assessment) => assessment.relativePath.split("/").includes("bmad"))) return null;

  const recognizedRoots = [...new Set(
    candidates
      .filter((candidate) => canonicalRole(candidate.source_ref) !== null)
      .map((candidate) => canonicalRoot(candidate.source_ref))
      .filter((root): root is string => root !== null),
  )].sort();
  if (recognizedRoots.length > 1) {
    return freezeResult({
      framework: BMAD_RECOGNIZER_ID,
      confidence: "ambiguous",
      selected_paths: [],
      ignored_candidates: [
        ...prepared.ignored_candidates,
        ...assessments.map((assessment) => ({
          path: assessment.path,
          reason: canonicalRole(assessment.relativePath) !== null
            ? "competing BMAD project roots require explicit selection"
            : (assessment.reason ?? "candidate is not selected"),
        })),
      ],
      mapping_id: BMAD_MAPPING_ID,
      mapping_version: BMAD_MAPPING_VERSION,
    });
  }
  const root = recognizedRoots[0];
  const selected = assessments.filter((assessment) => assessment.kind === "selected" && (root === undefined || canonicalRoot(assessment.relativePath) === root));
  const byCanonicalPath = new Map<string, CandidateAssessment[]>();
  for (const assessment of selected) {
    const canonicalPath = canonicalDocumentPath(assessment.relativePath);
    if (canonicalPath === null) continue;
    const entries = byCanonicalPath.get(canonicalPath) ?? [];
    entries.push(assessment);
    byCanonicalPath.set(canonicalPath, entries);
  }
  const duplicateCanonicalPaths = [...byCanonicalPath.entries()].filter(([, entries]) => entries.length > 1);
  if (duplicateCanonicalPaths.length > 0) {
    const duplicatePaths = new Set(duplicateCanonicalPaths.flatMap(([, entries]) => entries.map((entry) => entry.path)));
    return freezeResult({
      framework: BMAD_RECOGNIZER_ID,
      confidence: "ambiguous",
      selected_paths: [],
      ignored_candidates: [
        ...prepared.ignored_candidates,
        ...assessments.map((assessment) => ({
          path: assessment.path,
          reason: duplicatePaths.has(assessment.path)
            ? `duplicate BMAD canonical document '${canonicalDocumentPath(assessment.relativePath)}' requires explicit selection`
            : (assessment.reason ?? "not selected while duplicate canonical documents exist"),
        })),
      ],
      mapping_id: BMAD_MAPPING_ID,
      mapping_version: BMAD_MAPPING_VERSION,
    });
  }
  if (assessments.some((assessment) => assessment.kind === "competing")) {
    return freezeResult({
      framework: BMAD_RECOGNIZER_ID,
      confidence: "ambiguous",
      selected_paths: [],
      ignored_candidates: [
        ...prepared.ignored_candidates,
        ...assessments.map((assessment) => ({
          path: assessment.path,
          reason: assessment.kind === "competing" ? (assessment.reason ?? "candidate is not selected") : "not selected while competing canonical artifact locations exist",
        })),
      ],
      mapping_id: BMAD_MAPPING_ID,
      mapping_version: BMAD_MAPPING_VERSION,
    });
  }
  if (selected.length === 0) return null;
  const roles = new Set(selected.map((assessment) => canonicalRole(assessment.relativePath)));
  const complete = roles.has("prd") && roles.has("architecture") && roles.has("story");
  return freezeResult({
    framework: BMAD_RECOGNIZER_ID,
    confidence: complete ? "high" : "medium",
    selected_paths: selected.map((assessment) => assessment.path),
    ignored_candidates: ignored,
    mapping_id: BMAD_MAPPING_ID,
    mapping_version: BMAD_MAPPING_VERSION,
  });
}

export const bmadRecognizer: FormatRecognizer = Object.freeze({
  recognizer_id: BMAD_RECOGNIZER_ID,
  recognize: analyzeBmadLayout,
});
