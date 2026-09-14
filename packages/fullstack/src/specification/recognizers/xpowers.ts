/**
 * T069 — Local XPowers canonical requirement/task-source recognizer.
 *
 * Recognition reads only immutable normalized document text and metadata from
 * the core secure importer. It never accesses an external path.
 */

import { basename, extname } from "node:path";
import type { FormatRecognizer, FormatRecognitionResult, FormatRecognizerInput } from "@andvl1/omp-workflows-core";
import { inspectUnsafeRecognizerContent, prepareRecognizerInput } from "./captured.js";

export const XPOWERS_RECOGNIZER_ID = "xpowers";
export const XPOWERS_MAPPING_ID = "xpowers-canonical-source";
export const XPOWERS_MAPPING_VERSION = "1";
const XPOWERS_DIRECTORY = "xpowers";
const ATTACHMENT_DIRECTORY = "attachments";
const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS: Readonly<Record<string, true>> = Object.freeze({
  ".md": true, ".markdown": true, ".mdx": true, ".txt": true, ".rst": true, ".adoc": true, ".asciidoc": true,
  ".feature": true, ".json": true, ".jsonc": true, ".yaml": true, ".yml": true, ".toml": true,
});

type XpowersRole = "requirements" | "tasks" | "decisions";
interface CanonicalRole {
  readonly role: XpowersRole;
  readonly fileBaseName: string;
  readonly required: boolean;
  readonly variantPattern: RegExp;
}
const CANONICAL_ROLES: readonly CanonicalRole[] = Object.freeze([
  { role: "requirements", fileBaseName: "requirements.md", required: true, variantPattern: /^requirements[._-][^/]*\.md$/ },
  { role: "tasks", fileBaseName: "tasks.md", required: true, variantPattern: /^tasks[._-][^/]*\.md$/ },
  { role: "decisions", fileBaseName: "decisions.md", required: false, variantPattern: /^decisions[._-][^/]*\.md$/ },
]);

function roleForBaseName(baseName: string): CanonicalRole | null {
  const extension = extname(baseName).toLowerCase();
  if (TEXT_EXTENSIONS[extension] !== true) return null;
  const canonicalBaseName = `${baseName.slice(0, -extension.length)}.md`;
  for (const canonical of CANONICAL_ROLES) {
    if (canonicalBaseName === canonical.fileBaseName || canonical.variantPattern.test(canonicalBaseName)) return canonical;
  }
  return null;
}

function projectRootFor(candidate: string): string | null {
  const segments = candidate.split("/");
  const markerIndex = segments.indexOf(XPOWERS_DIRECTORY);
  return markerIndex >= 0 ? segments.slice(0, markerIndex).join("/") : null;
}

type CandidateVerdict =
  | { readonly kind: "role"; readonly canonical: CanonicalRole }
  | { readonly kind: "ignore"; readonly reason: string };

function classifyCandidate(document: FormatRecognizerInput["documents"][number]): CandidateVerdict {
  const candidate = document.source_ref;
  if (!candidate.split("/").includes(XPOWERS_DIRECTORY)) return { kind: "ignore", reason: "outside the xpowers/ canonical specification directory" };
  if (candidate.split("/").includes(ATTACHMENT_DIRECTORY)) return { kind: "ignore", reason: "attachment material is excluded from canonical specification selection" };
  const extension = extname(candidate).toLowerCase();
  if (TEXT_EXTENSIONS[extension] !== true) return { kind: "ignore", reason: `unsupported text extension '${extension || "none"}' is outside the specification allowlist` };
  if (document.size_bytes > MAX_CANDIDATE_BYTES || Buffer.byteLength(document.text, "utf8") > MAX_CANDIDATE_BYTES) return { kind: "ignore", reason: `candidate exceeds the ${MAX_CANDIDATE_BYTES}-byte per-file recognition bound` };
  const canonical = roleForBaseName(basename(candidate));
  if (!canonical) return { kind: "ignore", reason: "not part of the canonical XPowers document set (requirements.md, tasks.md, decisions.md)" };
  if (document.text.length === 0) return { kind: "ignore", reason: "canonical candidate is empty" };
  const unsafeReason = inspectUnsafeRecognizerContent(document.text);
  if (unsafeReason !== null) return { kind: "ignore", reason: unsafeReason };
  return { kind: "role", canonical };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function frozenResult(input: { confidence: FormatRecognitionResult["confidence"]; selectedPaths: readonly string[]; ignored: readonly { path: string; reason: string }[] }): FormatRecognitionResult {
  return deepFreeze({
    framework: XPOWERS_RECOGNIZER_ID,
    confidence: input.confidence,
    selected_paths: [...input.selectedPaths],
    ignored_candidates: input.ignored.map((entry) => ({ ...entry })),
    mapping_id: XPOWERS_MAPPING_ID,
    mapping_version: XPOWERS_MAPPING_VERSION,
  });
}

function roleCount(rolePaths: ReadonlyMap<XpowersRole, string[]>, role: XpowersRole): number {
  return rolePaths.get(role)?.length ?? 0;
}

export function analyzeXpowersLayout(input: FormatRecognizerInput): FormatRecognitionResult | null {
  const prepared = prepareRecognizerInput(input);
  if (prepared === null) return null;
  const candidates = [...prepared.documents].sort((left, right) => left.source_ref < right.source_ref ? -1 : left.source_ref > right.source_ref ? 1 : 0);
  const ignored: Array<{ path: string; reason: string }> = prepared.ignored_candidates.map((entry) => ({ path: entry.path, reason: entry.reason }));
  const rolePathsByRoot = new Map<string, Map<XpowersRole, string[]>>();
  for (const document of candidates) {
    const verdict = classifyCandidate(document);
    if (verdict.kind === "ignore") {
      ignored.push({ path: document.source_ref, reason: verdict.reason });
      continue;
    }
    const root = projectRootFor(document.source_ref);
    if (root === null) continue;
    const rolePaths = rolePathsByRoot.get(root) ?? new Map<XpowersRole, string[]>();
    const existing = rolePaths.get(verdict.canonical.role);
    if (existing) existing.push(document.source_ref);
    else rolePaths.set(verdict.canonical.role, [document.source_ref]);
    rolePathsByRoot.set(root, rolePaths);
  }
  const roots = [...rolePathsByRoot.keys()].sort();
  if (roots.length === 0) return null;
  if (roots.length > 1) {
    const competing = candidates
      .filter((document) => projectRootFor(document.source_ref) !== null && classifyCandidate(document).kind === "role")
      .map((document) => ({ path: document.source_ref, reason: "competing XPowers project roots require explicit selection" }));
    return frozenResult({ confidence: "ambiguous", selectedPaths: [], ignored: [...ignored, ...competing] });
  }
  const rolePaths = rolePathsByRoot.get(roots[0]!) ?? new Map<XpowersRole, string[]>();
  if (CANONICAL_ROLES.some((canonical) => roleCount(rolePaths, canonical.role) > 1)) {
    const ambiguousIgnored = candidates
      .filter((document) => {
        const verdict = classifyCandidate(document);
        return verdict.kind === "role" && rolePaths.get(verdict.canonical.role)?.includes(document.source_ref);
      })
      .map((document) => ({ path: document.source_ref, reason: "ambiguous xpowers role source requires explicit selection" }));
    return frozenResult({ confidence: "ambiguous", selectedPaths: [], ignored: [...ignored, ...ambiguousIgnored] });
  }
  const selectedPaths: string[] = [];
  for (const canonical of CANONICAL_ROLES) {
    const pathsForRole = rolePaths.get(canonical.role);
    if (pathsForRole?.length === 1 && pathsForRole[0]) selectedPaths.push(pathsForRole[0]);
  }
  selectedPaths.sort();
  const missingRequired = CANONICAL_ROLES.some((canonical) => canonical.required && roleCount(rolePaths, canonical.role) === 0);
  return frozenResult({ confidence: missingRequired ? "medium" : "high", selectedPaths, ignored });
}

export const xpowersRecognizer: FormatRecognizer = Object.freeze({
  recognizer_id: XPOWERS_RECOGNIZER_ID,
  recognize: analyzeXpowersLayout,
});
