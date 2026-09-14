/**
 * T068 — Local Superpowers plan/task artifact recognition.
 *
 * Recognition consumes only immutable normalized documents captured by core;
 * it never stats, resolves, opens, or follows a source path.
 */

import { extname } from "node:path";
import type {
  FormatRecognizer,
  FormatRecognitionResult,
  FormatRecognizerInput,
} from "@andvl1/omp-workflows-core";
import { inspectUnsafeRecognizerContent, prepareRecognizerInput, type PreparedRecognizerInput } from "./captured.js";

export const SUPERPOWERS_RECOGNIZER_ID = "superpowers";
export const SUPERPOWERS_MAPPING_ID = "superpowers-plan";
export const SUPERPOWERS_MAPPING_VERSION = "1";

const CANONICAL_PLAN_DOCUMENTS: ReadonlySet<string> = new Set(["brief.md", "design.md", "tasks.md"]);
const SAFE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUPPORTED_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc", ".asciidoc", ".feature", ".json", ".jsonc", ".yaml", ".yml", ".toml",
]);
const MAX_CANDIDATES = 128;
const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 16 * 1024 * 1024;
const REASON = Object.freeze({
  media: "candidate media type is not supported specification text",
  oversize: "candidate exceeds the bounded per-file recognition size",
  binary: "candidate is not valid bounded UTF-8 text",
  budget: "candidate exceeds the bounded recognition candidate budget",
  nonCanonical: "candidate is outside the canonical superpowers plan document set (superpowers/plans/<slug>/{brief.md,design.md,tasks.md})",
} as const);

function ambiguousReason(slug: string): string {
  return `ambiguous: superpowers plan '${slug}' competes with another plan directory; explicit selection is required`;
}

interface CanonicalDocument {
  path: string;
  root: string;
  slug: string;
  document: string;
  text: string;
  sizeBytes: number;
}
interface IgnoredCandidate {
  path: string;
  reason: string;
}
interface LayoutClassification {
  canonical: CanonicalDocument[];
  ignored: IgnoredCandidate[];
}

function textExtension(candidate: string): string | null {
  const extension = extname(candidate).toLowerCase();
  return SUPPORTED_TEXT_EXTENSIONS.has(extension) ? extension : null;
}


function planIdentityFor(candidate: string): { root: string; slug: string; document: string } | null {
  const segments = candidate.split("/");
  const namespaceIndex = segments.indexOf("superpowers");
  const canonical = namespaceIndex >= 0 ? segments.slice(namespaceIndex) : [];
  if (canonical.length !== 4) return null;
  const [namespace, plans, slug, document] = canonical;
  if (namespace !== "superpowers" || plans !== "plans" || slug === undefined || document === undefined) return null;
  const extension = textExtension(document);
  if (extension === null) return null;
  const canonicalDocument = `${document.slice(0, -extension.length)}.md`;
  const root = segments.slice(0, namespaceIndex).join("/");
  return SAFE_SLUG_RE.test(slug) && CANONICAL_PLAN_DOCUMENTS.has(canonicalDocument) ? { root, slug, document: canonicalDocument } : null;
}

function planSlugFor(candidate: string): string | null {
  return planIdentityFor(candidate)?.slug ?? null;
}

function classifyLayout(prepared: PreparedRecognizerInput): LayoutClassification {
  const canonical: CanonicalDocument[] = [];
  const ignored: IgnoredCandidate[] = [...prepared.ignored_candidates].map((entry) => ({ path: entry.path, reason: entry.reason }));
  const candidates = [...prepared.documents].sort((left, right) => left.source_ref < right.source_ref ? -1 : left.source_ref > right.source_ref ? 1 : 0);
  for (const document of candidates) {
    const candidate = document.source_ref;
    if (textExtension(candidate) === null) {
      ignored.push({ path: candidate, reason: REASON.media });
      continue;
    }
    if (document.size_bytes > MAX_CANDIDATE_BYTES || Buffer.byteLength(document.text, "utf8") > MAX_CANDIDATE_BYTES) {
      ignored.push({ path: candidate, reason: REASON.oversize });
      continue;
    }
    const identity = planIdentityFor(candidate);
    if (identity === null) {
      ignored.push({ path: candidate, reason: REASON.nonCanonical });
      continue;
    }
    canonical.push({ path: candidate, root: identity.root, slug: identity.slug, document: identity.document, text: document.text, sizeBytes: document.size_bytes });
  }
  return { canonical, ignored };
}

function screenCanonicalContent(document: CanonicalDocument, remainingBudget: number): { bytes: number } | { reason: string } {
  const bytes = Buffer.byteLength(document.text, "utf8");
  if (bytes > MAX_CANDIDATE_BYTES || bytes > remainingBudget) return { reason: REASON.budget };
  if (document.text.length === 0) return { reason: REASON.binary };
  const unsafeReason = inspectUnsafeRecognizerContent(document.text);
  if (unsafeReason !== null) return { reason: unsafeReason };
  return { bytes };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const property of Object.values(value as Record<string, unknown>)) deepFreeze(property);
    Object.freeze(value);
  }
  return value;
}

export function analyzeSuperpowersLayout(input: FormatRecognizerInput): FormatRecognitionResult | null {
  const prepared = prepareRecognizerInput(input);
  if (prepared === null) return null;
  const { canonical, ignored } = classifyLayout(prepared);
  const ignoredByPath = new Map(ignored.map((entry) => [entry.path, entry]));
  const readable: CanonicalDocument[] = [];
  let aggregateBytes = 0;
  for (const document of canonical) {
    const screen = screenCanonicalContent(document, MAX_AGGREGATE_BYTES - aggregateBytes);
    if ("reason" in screen) {
      ignoredByPath.set(document.path, { path: document.path, reason: screen.reason });
      continue;
    }
    aggregateBytes += screen.bytes;
    readable.push(document);
  }
  const candidateRoots = [...new Set(canonical.map((document) => document.root))].sort();
  const plansBySlug = new Map<string, CanonicalDocument[]>();
  for (const document of readable) plansBySlug.set(document.slug, [...(plansBySlug.get(document.slug) ?? []), document]);
  const canonicalByKey = new Map<string, CanonicalDocument[]>();
  for (const document of readable) {
    const key = `${document.root}\u0000${document.slug}\u0000${document.document}`;
    canonicalByKey.set(key, [...(canonicalByKey.get(key) ?? []), document]);
  }
  const duplicateCanonicalKeys = [...canonicalByKey.entries()].filter(([, documents]) => documents.length > 1);
  const duplicateCanonicalPaths = new Set(duplicateCanonicalKeys.flatMap(([, documents]) => documents.map((document) => document.path)));
  const competingSlugs = [...plansBySlug.keys()].sort();
  const competingRoots = candidateRoots.length > 1;
  if (candidateRoots.length === 0) return null;
  const selectedPaths: string[] = [];
  if (!competingRoots) {
    for (const slug of competingSlugs) {
      const documents = plansBySlug.get(slug) ?? [];
      if (duplicateCanonicalKeys.length > 0) {
        for (const document of documents) {
          const reason = duplicateCanonicalPaths.has(document.path)
            ? `duplicate Superpowers canonical document '${document.document}' for plan '${slug}' requires explicit selection`
            : "not selected while duplicate canonical plan documents exist";
          ignoredByPath.set(document.path, { path: document.path, reason });
        }
      } else if (competingSlugs.length === 1) selectedPaths.push(...documents.map((document) => document.path));
      else for (const document of documents) ignoredByPath.set(document.path, { path: document.path, reason: ambiguousReason(slug) });
    }
  } else {
    for (const document of canonical) {
      ignoredByPath.set(document.path, { path: document.path, reason: "competing superpowers project roots require explicit selection" });
    }
  }
  return deepFreeze({
    framework: SUPERPOWERS_RECOGNIZER_ID,
    confidence: competingRoots || competingSlugs.length > 1 || duplicateCanonicalKeys.length > 0 ? "ambiguous" : "high",
    selected_paths: selectedPaths.sort(),
    ignored_candidates: [...ignoredByPath.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    mapping_id: SUPERPOWERS_MAPPING_ID,
    mapping_version: SUPERPOWERS_MAPPING_VERSION,
  });
}

export const superpowersRecognizer: FormatRecognizer = Object.freeze({
  recognizer_id: SUPERPOWERS_RECOGNIZER_ID,
  recognize: analyzeSuperpowersLayout,
});
