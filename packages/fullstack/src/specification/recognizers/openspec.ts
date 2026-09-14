/**
 * T066 — Local OpenSpec artifact recognition and delta-baseline diagnostics.
 *
 * Recognition consumes only immutable normalized documents captured by core;
 * it never stats, resolves, opens, or follows a source path. All emitted paths
 * are safe source-root-relative references.
 */

import { extname } from "node:path";
import type {
  FormatRecognizer,
  FormatRecognitionResult,
  FormatRecognizerInput,
  RecognitionConfidence,
} from "@andvl1/omp-workflows-core";
import { inspectUnsafeRecognizerContent, prepareRecognizerInput } from "./captured.js";

export const OPENSPEC_RECOGNIZER_ID = "openspec";
export const OPENSPEC_MAPPING_ID = "openspec-delta-baseline";
export const OPENSPEC_MAPPING_VERSION = "1";
const MAX_READABLE_DOC_BYTES = 64 * 1024;
const READABLE_EXTENSIONS: Record<string, true> = { ".md": true, ".markdown": true };
const IGNORED_DIRECTORY_NAMES: Record<string, true> = {
  ".git": true,
  ".hg": true,
  ".svn": true,
  ".work-state": true,
  node_modules: true,
  target: true,
  dist: true,
  build: true,
};
const CANONICAL_CHANGE_ROLES = ["proposal", "design", "tasks"] as const;
const REQUIRED_CHANGE_ROLES: readonly OpenSpecDeltaRole[] = ["proposal", "tasks"];
export type OpenSpecDeltaRole = (typeof CANONICAL_CHANGE_ROLES)[number];

export type OpenSpecDiagnosticCode =
  | "OPENSPEC_COMPETING_ACTIVE_CHANGES"
  | "OPENSPEC_CHANGE_MISSING_PROPOSAL"
  | "OPENSPEC_CHANGE_MISSING_TASKS"
  | "OPENSPEC_PROJECT_CONTEXT_MISSING"
  | "OPENSPEC_ARCHIVED_CHANGE_PRESENT"
  | "OPENSPEC_DUPLICATE_CANONICAL_ROLE";
export interface OpenSpecDiagnostic {
  code: OpenSpecDiagnosticCode;
  detail: string;
}

export interface OpenSpecChangeDocument {
  role: OpenSpecDeltaRole;
  path: string;
}

export interface OpenSpecActiveChange {
  slug: string;
  documents: OpenSpecChangeDocument[];
  missing_roles: OpenSpecDeltaRole[];
}

export interface OpenSpecBaselineCapability {
  capability: string;
  spec_path: string;
}

export interface OpenSpecLayoutDescriptor {
  framework: typeof OPENSPEC_RECOGNIZER_ID;
  project_context: string | null;
  active_changes: OpenSpecActiveChange[];
  baseline_capabilities: OpenSpecBaselineCapability[];
  archived_change_slugs: string[];
  diagnostics: OpenSpecDiagnostic[];
  /** Source-root-relative paths; empty while ambiguous. */
  selected_paths: string[];
  ignored_candidates: Array<{ path: string; reason: string }>;
  confidence: RecognitionConfidence;
}

type CandidateVerdict =
  | { kind: "project_context" }
  | { kind: "change_doc"; slug: string; role: OpenSpecDeltaRole }
  | { kind: "baseline"; capability: string }
  | { kind: "archived"; slug: string }
  | { kind: "ignored"; reason: string };

const ARCHIVED_REASON = "archived change deltas are not active specifications";
const NON_CHANGE_DOC_REASON = "not a canonical openspec change document (proposal.md, design.md, tasks.md)";
const OUT_OF_TREE_REASON = "not part of the canonical openspec readable set";

function canonicalReadableBasename(value: string): string {
  const extension = extname(value).toLowerCase();
  return READABLE_EXTENSIONS[extension] === true
    ? `${value.slice(0, -extension.length)}.md`
    : value;
}

function projectRootFor(segments: readonly string[]): string | null {
  const markerIndex = segments.indexOf(OPENSPEC_RECOGNIZER_ID);
  return markerIndex >= 0 ? segments.slice(0, markerIndex).join("/") : null;
}

function classifyOpenSpecSegments(segments: readonly string[]): CandidateVerdict {
  const markerIndex = segments.indexOf(OPENSPEC_RECOGNIZER_ID);
  const canonical = markerIndex >= 0 ? segments.slice(markerIndex) : [];
  const head = canonical[0];
  const second = canonical[1];
  const third = canonical[2];
  const fourth = canonical[3];
  if (head !== OPENSPEC_RECOGNIZER_ID) return { kind: "ignored", reason: "candidate is outside the openspec project scope" };
  if (second !== undefined && canonicalReadableBasename(second) === "project.md" && canonical.length === 2) return { kind: "project_context" };
  if (second === "changes") {
    if (third === undefined) return { kind: "ignored", reason: OUT_OF_TREE_REASON };
    if (third === "archive") return { kind: "archived", slug: fourth ?? "<unnamed>" };
    if (fourth !== undefined && canonical.length === 4) {
      const stem = canonicalReadableBasename(fourth).slice(0, -3);
      if ((CANONICAL_CHANGE_ROLES as readonly string[]).includes(stem)) return { kind: "change_doc", slug: third, role: stem as OpenSpecDeltaRole };
    }
    return { kind: "ignored", reason: NON_CHANGE_DOC_REASON };
  }
  if (second === "specs") {
    if (third !== undefined && fourth !== undefined && canonical.length === 4 && canonicalReadableBasename(fourth) === "spec.md") return { kind: "baseline", capability: third };
    return { kind: "ignored", reason: "baseline capability documents must be named spec.md" };
  }
  return { kind: "ignored", reason: OUT_OF_TREE_REASON };
}

function guardOpenSpecCandidate(
  document: FormatRecognizerInput["documents"][number],
  segments: readonly string[],
): string | null {
  if (document.size_bytes > MAX_READABLE_DOC_BYTES || Buffer.byteLength(document.text, "utf8") > MAX_READABLE_DOC_BYTES) return "oversize candidate exceeds the readable document bound";
  for (const segment of segments) {
    if (IGNORED_DIRECTORY_NAMES[segment] === true) return "candidate lives in an ignored directory";
    if (segment === "attachments") return "attachments directory is never selected";
  }
  if (READABLE_EXTENSIONS[extname(document.source_ref).toLowerCase()] !== true) return "unsupported text media type";
  if (document.text.length === 0) return "empty candidate is not a readable specification";
  return inspectUnsafeRecognizerContent(document.text);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export function analyzeOpenSpecLayout(input: FormatRecognizerInput): OpenSpecLayoutDescriptor | null {
  const prepared = prepareRecognizerInput(input);
  if (prepared === null) return null;
  const candidates = [...prepared.documents].sort((left, right) => compareStrings(left.source_ref, right.source_ref));
  let marker = false;
  for (const candidate of candidates) {
    if (candidate.source_ref.split("/").includes(OPENSPEC_RECOGNIZER_ID)) {
      marker = true;
      break;
    }
  }
  const ignored: Array<{ path: string; reason: string }> = prepared.ignored_candidates.map((entry) => ({ path: entry.path, reason: entry.reason }));
  const recognizedPaths = new Map<string, string[]>();
  const projectContexts = new Map<string, string[]>();
  const changeDocs = new Map<string, Array<OpenSpecChangeDocument>>();
  const baselines = new Map<string, string[]>();
  const duplicateCanonicalRoles = new Map<string, string[]>();
  const archivedSlugs = new Set<string>();
  for (const candidate of candidates) {
    const path = candidate.source_ref;
    const segments = path.split("/");
    const guard = guardOpenSpecCandidate(candidate, segments);
    if (guard !== null) {
      ignored.push({ path, reason: guard });
      continue;
    }
    const root = projectRootFor(segments);
    if (root === null) continue;
    const verdict = classifyOpenSpecSegments(segments);
    switch (verdict.kind) {
      case "project_context": {
        const contexts = projectContexts.get(root) ?? [];
        contexts.push(path);
        projectContexts.set(root, contexts);
        break;
      }
      case "change_doc": {
        const key = `${root}\u0000${verdict.slug}`;
        const docs = changeDocs.get(key) ?? [];
        docs.push({ role: verdict.role, path });
        changeDocs.set(key, docs);
        const roleKey = `${key}\u0000${verdict.role}`;
        const rolePaths = duplicateCanonicalRoles.get(roleKey) ?? [];
        rolePaths.push(path);
        duplicateCanonicalRoles.set(roleKey, rolePaths);
        break;
      }
      case "baseline": {
        const key = `${root}\u0000${verdict.capability}`;
        const paths = baselines.get(key) ?? [];
        paths.push(path);
        baselines.set(key, paths);
        const roleKey = `${key}\u0000baseline`;
        const rolePaths = duplicateCanonicalRoles.get(roleKey) ?? [];
        rolePaths.push(path);
        duplicateCanonicalRoles.set(roleKey, rolePaths);
        break;
      }
      case "archived": archivedSlugs.add(`${root}\u0000${verdict.slug}`); break;
      case "ignored": ignored.push({ path, reason: verdict.reason }); break;
    }
    const recognized = recognizedPaths.get(root) ?? [];
    if (verdict.kind !== "ignored" && verdict.kind !== "archived") recognized.push(path);
    recognizedPaths.set(root, recognized);
  }

  const activeChanges: OpenSpecActiveChange[] = [...changeDocs.entries()]
    .map(([key, docs]) => {
      const separator = key.indexOf("\u0000");
      const slug = separator >= 0 ? key.slice(separator + 1) : key;
      const sorted = [...docs].sort((a, b) => CANONICAL_CHANGE_ROLES.indexOf(a.role) - CANONICAL_CHANGE_ROLES.indexOf(b.role) || compareStrings(a.path, b.path));
      const present = new Set(sorted.map((doc) => doc.role));
      return { slug, documents: sorted, missing_roles: REQUIRED_CHANGE_ROLES.filter((role) => !present.has(role)) };
    })
    .sort((a, b) => compareStrings(a.slug, b.slug));
  const baselineCapabilities: OpenSpecBaselineCapability[] = [...baselines.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([key, paths]) => {
      const separator = key.indexOf("\u0000");
      const capability = separator >= 0 ? key.slice(separator + 1) : key;
      return { capability, spec_path: paths[0] ?? "" };
    });
  const roots = [...recognizedPaths.keys()].sort(compareStrings);
  const projectRootAmbiguous = roots.length > 1;
  const duplicateProjectContext = roots.some((root) => (projectContexts.get(root)?.length ?? 0) > 1);
  const activeChangeAmbiguous = activeChanges.length > 1;
  const duplicateCanonicalEntries = [...duplicateCanonicalRoles.entries()].filter(([, paths]) => paths.length > 1);
  const duplicateCanonicalPaths = new Set<string>();
  for (const [key, paths] of duplicateCanonicalEntries) {
    const parts = key.split("\u0000");
    const role = parts.pop() ?? "role";
    const identity = parts.slice(1).join("/");
    const reason = role === "baseline"
      ? `duplicate openspec baseline capability '${identity}' requires explicit selection`
      : `duplicate openspec change '${identity}' ${role} document requires explicit selection`;
    for (const path of paths) {
      duplicateCanonicalPaths.add(path);
      ignored.push({ path, reason });
    }
  }
  const duplicateCanonicalAmbiguous = duplicateCanonicalEntries.length > 0;
  const ambiguous = projectRootAmbiguous || duplicateProjectContext || activeChangeAmbiguous || duplicateCanonicalAmbiguous;
  const projectContext = roots.length === 1 && !duplicateProjectContext ? projectContexts.get(roots[0]!)?.[0] ?? null : null;
  const diagnostics: OpenSpecDiagnostic[] = [];
  if (projectRootAmbiguous) diagnostics.push({ code: "OPENSPEC_COMPETING_ACTIVE_CHANGES", detail: `multiple openspec project roots compete for selection: ${roots.join(", ")}` });
  if (activeChangeAmbiguous && !projectRootAmbiguous) diagnostics.push({ code: "OPENSPEC_COMPETING_ACTIVE_CHANGES", detail: `${activeChanges.length} active changes compete for currency: ${activeChanges.map((change) => change.slug).join(", ")}` });
  if (duplicateCanonicalAmbiguous) diagnostics.push({ code: "OPENSPEC_DUPLICATE_CANONICAL_ROLE", detail: `${duplicateCanonicalEntries.length} canonical OpenSpec role(s) have duplicate readable source paths` });
  for (const change of activeChanges) {
    for (const role of change.missing_roles) diagnostics.push({ code: role === "proposal" ? "OPENSPEC_CHANGE_MISSING_PROPOSAL" : "OPENSPEC_CHANGE_MISSING_TASKS", detail: `change '${change.slug}' has no ${role}.md delta document` });
  }
  if (projectContext === null) diagnostics.push({ code: "OPENSPEC_PROJECT_CONTEXT_MISSING", detail: "no openspec/project.md context document is present" });
  if (archivedSlugs.size > 0) diagnostics.push({ code: "OPENSPEC_ARCHIVED_CHANGE_PRESENT", detail: `${archivedSlugs.size} archived change(s) present under openspec/changes/archive` });

  const selectedPaths = ambiguous ? [] : [
    ...(projectContext !== null ? [projectContext] : []),
    ...activeChanges.flatMap((change) => change.documents.map((doc) => doc.path)),
    ...baselineCapabilities.map((capability) => capability.spec_path),
  ].sort(compareStrings);
  if (ambiguous) {
    for (const paths of recognizedPaths.values()) {
      for (const path of paths) {
        if (duplicateCanonicalPaths.has(path)) continue;
        ignored.push({ path, reason: "competing openspec project roots or canonical documents require explicit selection" });
      }
    }
  }
  const confidence: RecognitionConfidence = ambiguous ? "ambiguous" : activeChanges.length === 1 && activeChanges[0]!.missing_roles.length > 0 ? "medium" : "high";
  ignored.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.reason, b.reason));
  return deepFreeze({
    framework: OPENSPEC_RECOGNIZER_ID,
    project_context: projectContext,
    active_changes: activeChanges,
    baseline_capabilities: baselineCapabilities,
    archived_change_slugs: [...archivedSlugs].map((key) => key.slice(key.indexOf("\u0000") + 1)).sort(compareStrings),
    diagnostics,
    selected_paths: selectedPaths,
    ignored_candidates: ignored,
    confidence,
  });
}

function recognizeOpenSpec(input: FormatRecognizerInput): FormatRecognitionResult | null {
  const descriptor = analyzeOpenSpecLayout(input);
  if (descriptor === null) return null;
  if (descriptor.project_context === null && descriptor.active_changes.length === 0 && descriptor.baseline_capabilities.length === 0) return null;
  return deepFreeze({
    framework: OPENSPEC_RECOGNIZER_ID,
    confidence: descriptor.confidence,
    selected_paths: descriptor.selected_paths,
    ignored_candidates: descriptor.ignored_candidates,
    mapping_id: OPENSPEC_MAPPING_ID,
    mapping_version: OPENSPEC_MAPPING_VERSION,
  });
}

export const openspecRecognizer: FormatRecognizer = deepFreeze({
  recognizer_id: OPENSPEC_RECOGNIZER_ID,
  recognize: recognizeOpenSpec,
});
