import { basename, extname } from "node:path";
import {
  registerFormatRecognizer,
  type FormatRecognizer,
  type FormatRecognitionResult,
  type FormatRecognizerInput,
} from "@andvl1/omp-workflows-core";
import type { RegistryRegistrationToken } from "@andvl1/omp-workflows-core/registry";
import { inspectUnsafeRecognizerContent, prepareRecognizerInput, type PreparedRecognizerInput } from "./captured.js";
import { speckitRecognizer } from "./speckit.js";
import { openspecRecognizer } from "./openspec.js";
import { bmadRecognizer } from "./bmad.js";
import { superpowersRecognizer } from "./superpowers.js";
import { xpowersRecognizer } from "./xpowers.js";

/** Stable id of the framework-neutral readable specification recognizer. */
export const GENERIC_RECOGNIZER_ID = "generic";
/** Stable mapping identity for framework-neutral requirements, plans, and tasks. */
export const GENERIC_MAPPING_ID = "generic-requirements-plan-tasks";
/** Mapping contract version; increments only when selection semantics change. */
export const GENERIC_MAPPING_VERSION = "1";

const MAX_GENERIC_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

type GenericRole = "requirements" | "plan" | "tasks" | "decisions";

const ROLE_ALIASES: Readonly<Record<GenericRole, readonly string[]>> = {
  requirements: ["requirements", "requirement", "req", "specification", "spec", "prd", "brief", "proposal", "story"],
  plan: ["plan", "design", "architecture"],
  tasks: ["tasks", "task"],
  decisions: ["decisions", "decision"],
};

interface GenericCandidate {
  path: string;
  setKey: string;
  role: GenericRole;
}

interface GenericAssessment {
  path: string;
  candidate: GenericCandidate | null;
  reason: string | null;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isAttachment(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.toLowerCase() === "attachments");
}

function roleForFilename(filename: string): GenericRole | null {
  const extension = extname(filename).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) return null;
  const stem = basename(filename, extension).toLowerCase();
  for (const role of ["requirements", "plan", "tasks", "decisions"] as const) {
    if (ROLE_ALIASES[role].some((alias) => stem === alias || stem.startsWith(`${alias}.`))) return role;
  }
  return null;
}


function inspectReadableFile(text: string, sizeBytes: number): string | null {
  if (sizeBytes > MAX_GENERIC_FILE_BYTES || Buffer.byteLength(text, "utf8") > MAX_GENERIC_FILE_BYTES) {
    return "file exceeds the readable specification size bound";
  }
  if (text.length === 0) return "empty documents are not readable specifications";
  return inspectUnsafeRecognizerContent(text);
}

function assessCandidate(document: PreparedRecognizerInput["documents"][number]): GenericAssessment {
  const relativePath = document.source_ref;
  if (isAttachment(relativePath)) {
    return { path: relativePath, candidate: null, reason: "attachment material is excluded from specification selection" };
  }
  const reason = inspectReadableFile(document.text, document.size_bytes);
  const role = roleForFilename(relativePath);
  if (reason !== null) return { path: relativePath, candidate: null, reason };
  if (role === null) return { path: relativePath, candidate: null, reason: null };
  const parent = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
  return { path: relativePath, candidate: { path: relativePath, setKey: parent, role }, reason: null };
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

/**
 * Recognize a framework-neutral requirements/plan/tasks set over immutable
 * normalized documents. Two candidates mapped to the same role inside one
 * candidate set are competing content and fail closed as ambiguous.
 */
export function analyzeGenericLayout(input: FormatRecognizerInput): FormatRecognitionResult | null {
  const prepared = prepareRecognizerInput(input);
  if (prepared === null) return null;
  const assessments = prepared.documents.map(assessCandidate);
  const valid = assessments.flatMap((assessment) => (assessment.candidate === null ? [] : [assessment.candidate]));
  const bySet = new Map<string, GenericCandidate[]>();
  for (const candidate of valid) {
    const set = bySet.get(candidate.setKey) ?? [];
    set.push(candidate);
    bySet.set(candidate.setKey, set);
  }

  const roleCountsBySet = new Map<string, Map<GenericRole, number>>();
  for (const candidate of valid) {
    const counts = roleCountsBySet.get(candidate.setKey) ?? new Map<GenericRole, number>();
    counts.set(candidate.role, (counts.get(candidate.role) ?? 0) + 1);
    roleCountsBySet.set(candidate.setKey, counts);
  }
  const competingRoles = new Map<string, GenericRole>();
  for (const [setKey, counts] of roleCountsBySet) {
    for (const role of ["requirements", "plan", "tasks", "decisions"] as const) {
      if ((counts.get(role) ?? 0) > 1) {
        competingRoles.set(setKey, role);
        break;
      }
    }
  }

  const completeSets = [...bySet.entries()]
    .filter(([setKey, candidates]) => {
      if (competingRoles.has(setKey)) return false;
      const roles = new Set(candidates.map((candidate) => candidate.role));
      return roles.has("requirements") && roles.has("plan") && roles.has("tasks");
    })
    .map(([setKey]) => setKey)
    .sort(compareStrings);

  const ambiguous = competingRoles.size > 0 || completeSets.length > 1;
  const selectedSet = ambiguous ? undefined : completeSets[0];
  const selected = selectedSet === undefined
    ? (ambiguous ? [] : valid.map((candidate) => candidate.path))
    : (bySet.get(selectedSet) ?? []).map((candidate) => candidate.path);
  if (!ambiguous && selected.length === 0) return null;

  const relevant = new Set(selected);
  const ignoredReason = (assessment: (typeof assessments)[number]): string | null => {
    if (assessment.reason !== null) return assessment.reason;
    const candidate = assessment.candidate;
    if (candidate === null || relevant.has(candidate.path)) return null;
    if (competingRoles.has(candidate.setKey)) {
      return `competing ${competingRoles.get(candidate.setKey)} documents in '${candidate.setKey}' require explicit selection`;
    }
    if (completeSets.length > 1) return `competing generic document set '${candidate.setKey}' requires explicit selection`;
    return "candidate is not part of the selected generic document set";
  };
  const ignored = [
    ...prepared.ignored_candidates,
    ...assessments
      .map((assessment) => ({ path: assessment.path, reason: ignoredReason(assessment) }))
      .filter((entry): entry is { path: string; reason: string } => entry.reason !== null),
  ];
  ignored.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.reason, b.reason));

  if (ambiguous) {
    return freezeResult({
      framework: GENERIC_RECOGNIZER_ID,
      confidence: "ambiguous",
      selected_paths: [],
      ignored_candidates: ignored,
      mapping_id: GENERIC_MAPPING_ID,
      mapping_version: GENERIC_MAPPING_VERSION,
    });
  }

  selected.sort(compareStrings);
  return freezeResult({
    framework: GENERIC_RECOGNIZER_ID,
    confidence: selectedSet === undefined ? "medium" : "high",
    selected_paths: selected,
    ignored_candidates: ignored,
    mapping_id: GENERIC_MAPPING_ID,
    mapping_version: GENERIC_MAPPING_VERSION,
  });
}

export const genericRecognizer: FormatRecognizer = Object.freeze({
  recognizer_id: GENERIC_RECOGNIZER_ID,
  recognize: analyzeGenericLayout,
});

const SHIPPED_RECOGNIZERS: readonly FormatRecognizer[] = Object.freeze([
  speckitRecognizer,
  openspecRecognizer,
  bmadRecognizer,
  superpowersRecognizer,
  xpowersRecognizer,
  genericRecognizer,
]);

export function specificationRecognizers(): readonly FormatRecognizer[] {
  return SHIPPED_RECOGNIZERS;
}

export function specificationRecognizerById(id: string): FormatRecognizer | null {
  return SHIPPED_RECOGNIZERS.find((recognizer) => recognizer.recognizer_id === id) ?? null;
}

export function registerSpecificationRecognizers(token: RegistryRegistrationToken): void {
  for (const recognizer of SHIPPED_RECOGNIZERS) {
    registerFormatRecognizer(token, recognizer);
  }
}

export {
  speckitRecognizer,
  openspecRecognizer,
  bmadRecognizer,
  superpowersRecognizer,
  xpowersRecognizer,
};
