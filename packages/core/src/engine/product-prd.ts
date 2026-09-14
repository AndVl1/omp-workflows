/**
 * Deterministic Markdown product PRD document stage.
 *
 * The engine — not an agent — renders the product PRD from the FIVE
 * product-discovery source artifacts (product_intake, product_framing,
 * product_evidence, product_critique, product_spec):
 *
 *   - `renderProductPrdDocument` is pure and deterministic: identical
 *     sources render byte-identical Markdown regardless of object key
 *     order, repeated invocation or wall-clock time (the markdown NEVER
 *     embeds a timestamp). A missing source artifact fails closed with a
 *     throw naming the artifact. Explicit unknowns (`'unknown'`/`'TBD'`
 *     values) are rendered verbatim; a field absent inside a present
 *     artifact renders an explicit unknown marker — never a silent
 *     omission.
 *   - `writeProductPrdDocument` persists the markdown document at a SAFE
 *     RELATIVE path inside the state dir, a derived sibling HTML viewer, and
 *     the typed `product_prd` artifact carrying EXACTLY { type, format,
 *     renderer, path, source_artifacts, source_hash, content_hash, content }.
 *     All three outputs are staged and committed atomically (temp file +
 *     rename) with complete rollback; a rejected write mutates nothing.
 *     `source_hash` is a key-order-independent hash of the five sources;
 *     `content_hash` is sha256 of the markdown bytes.
 *   - `validateProductPrdDocument` re-verifies the whole shape: exact
 *     manifest field set, content/content_hash agreement, on-disk document
 *     bytes (existence, non-symlink, hash) and staleness of the sources
 *     (re-hashing the current artifacts against `source_hash`).
 *
 * Path discipline: the document path must be relative, free of `..`/`.`
 * segments, backslashes and NUL bytes; neither the state root nor any
 * existing ancestor of the target may be a symlink, and the resolved
 * target must stay inside the real state root.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { renderMarkdownDocumentHtml } from "../report/markdown.js";
import {
  MAX_ARTIFACT_BYTES,
  createArtifactStructureBudget,
  readPinnedArtifactSnapshot,
  validateArtifactStructure,
} from "./artifacts.js";
import { PinnedProjectRoot, PinnedRootError, type PinnedRootWriteReceipt } from "../specification/pinned-root.js";

/** Typed artifact id produced by the PRD document stage. */
export const PRODUCT_PRD_ARTIFACT_ID = "product_prd";

/** The five source artifacts the PRD is rendered from, in fixed order. */
export const PRD_SOURCE_ARTIFACT_IDS = [
  "product_intake",
  "product_framing",
  "product_evidence",
  "product_critique",
  "product_spec",
] as const;

/** Renderer identity recorded in the manifest; bump on any template change. */
export const PRODUCT_PRD_RENDERER = "product-prd-renderer@2";

/** Maximum UTF-8 bytes accepted by the pinned PRD document/HTML reader. */
export const MAX_PRD_VALIDATION_FILE_BYTES = 4 * 1024 * 1024;

/** Maximum UTF-8 bytes accepted by the pinned artifact reader. */
export const MAX_PRD_ARTIFACT_BYTES = MAX_ARTIFACT_BYTES;

/** Default document location inside the state dir. */
const DEFAULT_DOCUMENT_PATH = "documents/product-prd.md";

/** Exact manifest field set — no extras, none missing. */
const PRD_MANIFEST_FIELDS = [
  "content",
  "content_hash",
  "format",
  "path",
  "renderer",
  "source_artifacts",
  "source_hash",
  "type",
];

const UNKNOWN_MARKER = "_Unknown — not provided by the source artifacts_";

export interface ProductPrdManifest {
  type: typeof PRODUCT_PRD_ARTIFACT_ID;
  format: "markdown";
  renderer: string;
  path: string;
  source_artifacts: string[];
  source_hash: string;
  content_hash: string;
  content: string;
}

export interface ProductPrdPinnedWriteOptions {
  /** Borrowed descriptor-anchored project root for the enclosing transaction. */
  pinnedRoot: PinnedProjectRoot;
  /** Descriptor-safe project-relative directory owning the document. */
  stateDirRelative: string;
  /** Descriptor-safe project-relative directory receiving the typed artifact. */
  artifactsDirRelative: string;
  /** Safe relative path of the markdown document inside stateDirRelative. */
  path?: string;
  /** The five source artifacts keyed by artifact id. */
  sourceArtifacts: Record<string, unknown>;
  /** Register exact rollback for each output as soon as the batch publishes. */
  registerRollback?: (cleanup: () => void) => void;
}
export interface ProductPrdWriteOptions {
  /** Project root to pin for this standalone operation. */
  projectRoot: string;
  /** Descriptor-safe project-relative directory owning the document. */
  stateDirRelative: string;
  /** Descriptor-safe project-relative directory receiving the typed artifact. */
  artifactsDirRelative: string;
  /** Safe relative path of the markdown document; defaults to `documents/product-prd.md`. */
  path?: string;
  /** The five source artifacts keyed by artifact id. */
  sourceArtifacts: Record<string, unknown>;
}
export type ProductPrdWriteResult =
  | { ok: true; documentPath: string; htmlDocumentPath: string; artifactPath: string; source_hash: string; content_hash: string }
  | { ok: false; error: string };

export interface ProductPrdValidation {
  ok: boolean;
  issues: string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Key-order-independent canonical JSON so hashes never depend on insertion order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sourceHash(sourceArtifacts: Record<string, unknown>): string {
  return sha256(canonicalJson(PRD_SOURCE_ARTIFACT_IDS.map((id) => [id, sourceArtifacts[id] ?? null])));
}

function requireSource(sourceArtifacts: Record<string, unknown>, id: string): Record<string, unknown> {
  const value = sourceArtifacts[id];
  if (value === undefined || value === null) {
    throw new Error(`cannot render product PRD: source artifact '${id}' is missing`);
  }
  return value as Record<string, unknown>;
}

// ── deterministic rendering ────────────────────────────────────────────────

const SCALAR_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const SCALAR_STRUCTURAL_MARKERS =
  /(^|\s)((?:#{1,}(?=\s|$)|[-+*>](?=\s|$)|\d{1,9}[.)](?=\s)|[`~]{3,}|(?:[-*_]\s*){3,}))/g;

function sanitizeScalar(text: string): string {
  // Scalar values are rendered as text on an existing Markdown line. Replace
  // every line/control separator with a space so a value cannot create a new
  // block, then escape block markers that could still be interpreted after
  // whitespace normalization. The rendered text remains visible verbatim.
  const normalized = text.replace(SCALAR_CONTROL_CHARACTERS, " ").replace(/^ {4,}/, " ");
  return normalized.replace(SCALAR_STRUCTURAL_MARKERS, (_match, boundary: string, marker: string) => {
    // Escape the punctuation in ordered-list markers, rather than the
    // leading number, so the visible scalar text stays unchanged.
    const escaped = /^\d/.test(marker) ? marker.replace(/[.)]/, "\\$&") : `\\${marker}`;
    return `${boundary}${escaped}`;
  });
}

function scalar(value: unknown): string {
  if (value === undefined || value === null) return UNKNOWN_MARKER;
  if (typeof value === "string") return sanitizeScalar(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Nested objects/arrays render through the canonical (key-sorted)
  // serialization so a reordered source object can never change the bytes.
  return sanitizeScalar(canonicalJson(value));
}

function bulletList(value: unknown): string[] {
  if (value === undefined || value === null) return [`- ${UNKNOWN_MARKER}`];
  if (!Array.isArray(value)) return [`- ${scalar(value)}`];
  if (value.length === 0) return ["- _None._"];
  return value.map((item) => `- ${scalar(item)}`);
}

function claimLines(evidence: unknown): string[] {
  if (!Array.isArray(evidence) || evidence.length === 0) return ["- _None._"];
  return evidence.map((entry) => {
    if (entry === null || typeof entry !== "object") return `- ${scalar(entry)}`;
    const record = entry as Record<string, unknown>;
    return [
      `- **Claim:** ${scalar(record.claim)}`,
      `  - **Status:** ${scalar(record.status)}`,
      `  - **Source:** ${scalar(record.source)}`,
    ].join("\n");
  });
}

function alternativeLines(alternatives: unknown): string[] {
  if (!Array.isArray(alternatives) || alternatives.length === 0) return ["- _None._"];
  const lines: string[] = [];
  for (const entry of alternatives) {
    if (entry === null || typeof entry !== "object") {
      lines.push(`- ${scalar(entry)}`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    lines.push(`- **${scalar(record.id)}:** ${scalar(record.summary)}`);
    const pros = Array.isArray(record.pros) ? record.pros : [];
    const cons = Array.isArray(record.cons) ? record.cons : [];
    lines.push(`  - **Pros:** ${pros.length > 0 ? pros.map((pro) => scalar(pro)).join("; ") : "_None._"}`);
    lines.push(`  - **Cons:** ${cons.length > 0 ? cons.map((con) => scalar(con)).join("; ") : "_None._"}`);
  }
  return lines;
}

/** One labeled scalar line plus a trailing blank separator. */
function labeledValue(label: string, value: unknown): string[] {
  return [`**${label}.** ${scalar(value)}`, ""];
}

/** One label line, its bullet list and a trailing blank separator. */
function labeledList(label: string, value: unknown): string[] {
  return [`**${label}.**`, ...bulletList(value), ""];
}

/** Human-first opening summary: the decision-relevant fields without subheadings. */
function executiveSummaryLines(
  framing: Record<string, unknown>,
  critique: Record<string, unknown>,
  spec: Record<string, unknown>,
): string[] {
  return [
    "## Executive summary",
    "",
    ...labeledValue("Recommendation", spec.recommendation),
    ...labeledValue("Critique verdict", critique.verdict),
    ...labeledValue("Problem", framing.problem_restatement),
    ...labeledValue("Value proposition", spec.value_proposition),
    ...labeledList("Target users", spec.target_users),
    ...labeledValue("Solution direction", spec.solution_direction),
    ...labeledList("Success metrics", spec.success_metrics),
    ...labeledList("Scope", spec.scope),
    ...labeledList("Open product decisions", spec.open_decisions),
  ];
}

/** Every product_spec concept as its own section (Recommendation stays a label). */
function productDirectionLines(spec: Record<string, unknown>): string[] {
  return [
    "## Product direction",
    "",
    ...labeledValue("Recommendation", spec.recommendation),
    "### Value proposition",
    "",
    scalar(spec.value_proposition),
    "",
    "### Opportunity",
    "",
    scalar(spec.opportunity),
    "",
    "### Target users",
    ...bulletList(spec.target_users),
    "",
    "### Solution direction",
    "",
    scalar(spec.solution_direction),
    "",
    "### Success metrics",
    ...bulletList(spec.success_metrics),
    "",
    "### Guardrail metrics",
    ...bulletList(spec.guardrail_metrics),
    "",
    "### Scope",
    ...bulletList(spec.scope),
    "",
    "### Anti-scope",
    ...bulletList(spec.anti_scope),
    "",
    "### Risks",
    ...bulletList(spec.risks),
    "",
    "### Validation plan",
    ...bulletList(spec.validation_plan),
    "",
    "### Evidence trace",
    ...bulletList(spec.evidence_trace),
    "",
    "### Open product decisions",
    ...bulletList(spec.open_decisions),
    "",
  ];
}

function productCritiqueLines(critique: Record<string, unknown>): string[] {
  return [
    "## Product critique",
    "",
    "### Verdict",
    "",
    scalar(critique.verdict),
    "",
    "### Findings",
    ...bulletList(critique.findings),
    "",
    "### Blocking gaps",
    ...bulletList(critique.blocking_gaps),
    "",
  ];
}

function evidenceLines(evidence: Record<string, unknown>): string[] {
  return [
    "## Evidence",
    "",
    "### Claims",
    ...claimLines(evidence.evidence),
    "",
    "### Evidence gaps",
    ...bulletList(evidence.gaps),
    "",
    "### Alternatives considered",
    ...alternativeLines(evidence.alternatives),
    "",
  ];
}

function problemFramingLines(framing: Record<string, unknown>): string[] {
  return [
    "## Problem framing",
    "",
    ...labeledValue("Problem restatement", framing.problem_restatement),
    "### Target users",
    ...bulletList(framing.target_users),
    "",
    "### Success criteria",
    ...bulletList(framing.success_criteria),
    "",
    "### Non-goals",
    ...bulletList(framing.non_goals),
    "",
    "### Framing assumptions",
    ...bulletList(framing.assumptions),
    "",
  ];
}

function productIntakeLines(intake: Record<string, unknown>): string[] {
  return [
    "## Product intake",
    "",
    "### Problem statements",
    ...bulletList(intake.problem_statements),
    "",
    "### Context",
    ...bulletList(intake.contexts),
    "",
    "### Stakeholders",
    ...bulletList(intake.stakeholders),
    "",
    "### Constraints",
    ...bulletList(intake.constraints),
    "",
    "### Open questions",
    ...bulletList(intake.open_questions),
    "",
    "### Intake evidence",
    ...claimLines(intake.evidence),
    "",
  ];
}

function documentMetadataLines(): string[] {
  return [
    "## Document metadata",
    "",
    ...labeledValue("Renderer", PRODUCT_PRD_RENDERER),
    ...labeledValue("Source artifacts", PRD_SOURCE_ARTIFACT_IDS.join(", ")),
    "Rendering is deterministic: identical source artifacts render byte-identical Markdown with no embedded timestamps.",
    "Explicit unknowns stay visible: absent concepts render the '_Unknown — not provided by the source artifacts_' marker; 'unknown'/'TBD' values render verbatim.",
    "",
  ];
}

/**
 * Deterministic Markdown product PRD from the five source artifacts.
 * Human-first layout in a fixed section order — never key-iteration-driven,
 * never clock-driven. Throws when one of the five sources is missing.
 */
export function renderProductPrdDocument(sourceArtifacts: Record<string, unknown>): string {
  const intake = requireSource(sourceArtifacts, "product_intake");
  const framing = requireSource(sourceArtifacts, "product_framing");
  const evidence = requireSource(sourceArtifacts, "product_evidence");
  const critique = requireSource(sourceArtifacts, "product_critique");
  const spec = requireSource(sourceArtifacts, "product_spec");
  const lines: string[] = [
    "# Product PRD",
    "",
    ...executiveSummaryLines(framing, critique, spec),
    ...productDirectionLines(spec),
    ...productCritiqueLines(critique),
    ...evidenceLines(evidence),
    ...problemFramingLines(framing),
    ...productIntakeLines(intake),
    ...documentMetadataLines(),
  ];
  return `${lines.join("\n")}\n`;
}

// ── safe paths ─────────────────────────────────────────────────────────────

function safeDocumentPath(stateDir: string, documentPath: string): { ok: true; absolute: string } | { ok: false; error: string } {
  if (typeof documentPath !== "string" || documentPath.length === 0) {
    return { ok: false, error: "unsafe document path: the path is empty" };
  }
  if (isAbsolute(documentPath)) {
    return { ok: false, error: `unsafe document path: '${documentPath}' is absolute` };
  }
  if (documentPath.includes("\\")) {
    return { ok: false, error: `unsafe document path: '${documentPath}' contains a backslash separator` };
  }
  const segments = documentPath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { ok: false, error: `unsafe document path: '${documentPath}' contains a '${segment}' segment` };
    }
    if (segment.includes("\0")) {
      return { ok: false, error: `unsafe document path: '${documentPath}' contains a NUL byte` };
    }
  }
  // Symlink discipline: neither the state root nor any existing ancestor of
  // the document may be a symlink, and a pre-existing target must be a
  // regular file inside the real state root.
  let rootInfo;
  try {
    rootInfo = lstatSync(stateDir);
  } catch {
    return { ok: false, error: `unsafe document path: state dir '${stateDir}' does not exist` };
  }
  if (rootInfo.isSymbolicLink()) {
    return { ok: false, error: `unsafe document path: state dir '${stateDir}' is a symlink` };
  }
  const realRoot = realpathSync(stateDir);
  let current = stateDir;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      return { ok: false, error: `unsafe document path: '${segment}' on the path '${documentPath}' is a symlink` };
    }
  }
  const absolute = join(stateDir, ...segments);
  if (existsSync(absolute)) {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) {
      return { ok: false, error: `unsafe document path: '${documentPath}' target is a symlink` };
    }
    if (!info.isFile()) {
      return { ok: false, error: `unsafe document path: '${documentPath}' target is not a regular file` };
    }
  }
  const parent = dirname(absolute);
  if (existsSync(parent)) {
    const realParent = realpathSync(parent);
    const rel = relative(realRoot, realParent);
    if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
      return { ok: false, error: `unsafe document path: '${documentPath}' escapes the state dir` };
    }
  }
  return { ok: true, absolute };
}

function derivedHtmlPath(documentPath: string): string {
  return documentPath.endsWith(".md") ? `${documentPath.slice(0, -3)}.html` : `${documentPath}.html`;
}

// ── atomic persistence ─────────────────────────────────────────────────────

/** Validate a project-relative path without consulting the lexical filesystem. */
function safePinnedRelativePath(value: string, label: string, allowEmpty = false): { ok: true } | { ok: false; error: string } {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return { ok: false, error: `unsafe ${label}: path is empty` };
  }
  if (allowEmpty && value.length === 0) return { ok: true };
  if (value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
    return { ok: false, error: `unsafe ${label}: path must be relative and contain no backslash or NUL` };
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return { ok: false, error: `unsafe ${label}: path contains an empty, '.' or '..' segment` };
  }
  return { ok: true };
}

function pinnedOutputPath(base: string, child: string, label: string): string {
  const value = base.length === 0 ? child : `${base}/${child}`;
  const safe = safePinnedRelativePath(value, label);
  if (!safe.ok) throw new PinnedRootError("path_unauthorized", safe.error);
  return value;
}
/** Return the exact three relative outputs produced by the PRD writer. */
export function productPrdOutputRelativePaths(
  stateDirRelative: string,
  artifactsDirRelative: string,
  relativePath = DEFAULT_DOCUMENT_PATH,
): readonly string[] {
  return [
    pinnedOutputPath(stateDirRelative, relativePath, "document path"),
    pinnedOutputPath(stateDirRelative, derivedHtmlPath(relativePath), "HTML document path"),
    pinnedOutputPath(artifactsDirRelative, `${PRODUCT_PRD_ARTIFACT_ID}.json`, "artifact path"),
  ];
}

function canonicalOutputPath(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.normalize("NFC").toLowerCase())
    .join("/");
}

function outputPathsConflict(left: string, right: string): boolean {
  const canonicalLeft = canonicalOutputPath(left);
  const canonicalRight = canonicalOutputPath(right);
  return canonicalLeft === canonicalRight
    || canonicalLeft.startsWith(canonicalRight + "/")
    || canonicalRight.startsWith(canonicalLeft + "/");
}

function pinnedParentPath(path: string): string {
  const parent = dirname(path).split(sep).join("/");
  return parent === "." ? "" : parent;
}

/**
 * Render and atomically persist the product PRD through a borrowed pinned
 * root. Every source is supplied by the enclosing transaction and every
 * output is addressed by a descriptor-relative path; no lexical path is
 * re-authorized or reopened here.
 */
export function writeProductPrdDocumentPinned(options: ProductPrdPinnedWriteOptions): ProductPrdWriteResult {
  const provided = options.sourceArtifacts ?? {};
  const sourceArtifacts: Record<string, unknown> = {};
  const sourceBudget = createArtifactStructureBudget();
  for (const id of PRD_SOURCE_ARTIFACT_IDS) {
    const value = provided[id];
    if (value === undefined || value === null) {
      return { ok: false, error: `cannot render product PRD: source artifact '${id}' is missing` };
    }
    const structure = validateArtifactStructure(value, sourceBudget);
    if (!structure.ok) {
      return { ok: false, error: `cannot render product PRD: source artifact '${id}' is not safely renderable: ${structure.error}` };
    }
    sourceArtifacts[id] = value;
  }
  const relativePath = options.path ?? DEFAULT_DOCUMENT_PATH;
  const documentSafe = safePinnedRelativePath(relativePath, "document path");
  if (!documentSafe.ok) return { ok: false, error: documentSafe.error };
  const htmlRelativePath = derivedHtmlPath(relativePath);
  const htmlSafe = safePinnedRelativePath(htmlRelativePath, "HTML document path");
  if (!htmlSafe.ok) return { ok: false, error: htmlSafe.error };
  let documentPath: string;
  let htmlPath: string;
  let artifactPath: string;
  try {
    documentPath = pinnedOutputPath(options.stateDirRelative, relativePath, "document path");
    htmlPath = pinnedOutputPath(options.stateDirRelative, htmlRelativePath, "HTML document path");
    artifactPath = pinnedOutputPath(options.artifactsDirRelative, `${PRODUCT_PRD_ARTIFACT_ID}.json`, "artifact path");
    if (documentPath === htmlPath) return { ok: false, error: `unsafe document path: Markdown and HTML targets collide at '${relativePath}'` };
    const outputPaths = [
      ["document", documentPath],
      ["HTML", htmlPath],
      ["artifact", artifactPath],
    ] as const;
    for (let index = 0; index < outputPaths.length; index += 1) {
      const [leftLabel, leftPath] = outputPaths[index]!;
      for (let other = index + 1; other < outputPaths.length; other += 1) {
        const [rightLabel, rightPath] = outputPaths[other]!;
        if (outputPathsConflict(leftPath, rightPath)) {
          return { ok: false, error: `unsafe product PRD output paths: ${leftLabel} '${leftPath}' conflicts with ${rightLabel} '${rightPath}'` };
        }
      }
    }
    const stateSafe = safePinnedRelativePath(options.stateDirRelative, "state directory", true);
    if (!stateSafe.ok) return { ok: false, error: stateSafe.error };
    const artifactsSafe = safePinnedRelativePath(options.artifactsDirRelative, "artifacts directory", true);
    if (!artifactsSafe.ok) return { ok: false, error: artifactsSafe.error };
    if (!options.pinnedRoot.isStable()) return { ok: false, error: "pinned project root changed before product PRD render" };
    for (const target of [documentPath, htmlPath, artifactPath]) {
      const entry = options.pinnedRoot.pathEntryInfo(target);
      if (entry && entry.kind !== "file") return { ok: false, error: `product PRD target '${target}' is not a regular file` };
    }
  } catch (error) {
    return { ok: false, error: `product PRD persistence path is unsafe: ${String(error)}` };
  }

  try {
    const markdown = renderProductPrdDocument(sourceArtifacts);
    const markdownBytes = Buffer.from(markdown, "utf8");
    if (markdownBytes.byteLength > MAX_PRD_VALIDATION_FILE_BYTES) {
      return {
        ok: false,
        error: `product PRD persistence failed: Markdown output is ${markdownBytes.byteLength} UTF-8 bytes, exceeding the readable limit of ${MAX_PRD_VALIDATION_FILE_BYTES} bytes`,
      };
    }
    const html = renderMarkdownDocumentHtml(markdown, {
      title: "Product PRD",
      lang: "en",
      toc: true,
      navigation: true,
    });
    const htmlBytes = Buffer.from(html, "utf8");
    if (htmlBytes.byteLength > MAX_PRD_VALIDATION_FILE_BYTES) {
      return {
        ok: false,
        error: `product PRD persistence failed: HTML output is ${htmlBytes.byteLength} UTF-8 bytes, exceeding the readable limit of ${MAX_PRD_VALIDATION_FILE_BYTES} bytes`,
      };
    }
    const source_hash = sourceHash(sourceArtifacts);
    const content_hash = sha256(markdown);
    const manifest: ProductPrdManifest = {
      type: PRODUCT_PRD_ARTIFACT_ID,
      format: "markdown",
      renderer: PRODUCT_PRD_RENDERER,
      path: relativePath,
      source_artifacts: [...PRD_SOURCE_ARTIFACT_IDS],
      source_hash,
      content_hash,
      content: markdown,
    };
    const manifestStructure = validateArtifactStructure(manifest);
    if (!manifestStructure.ok) {
      return {
        ok: false,
        error: `product PRD persistence failed: manifest is not readable by the pinned artifact validator: ${manifestStructure.error}`,
      };
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (manifestBytes.byteLength > MAX_PRD_ARTIFACT_BYTES) {
      return {
        ok: false,
        error: `product PRD persistence failed: manifest is ${manifestBytes.byteLength} UTF-8 bytes, exceeding the readable limit of ${MAX_PRD_ARTIFACT_BYTES} bytes`,
      };
    }
    const outputEntries = [
      { path: documentPath, content: markdownBytes },
      { path: htmlPath, content: htmlBytes },
      { path: artifactPath, content: manifestBytes },
    ];
    // The batch writer returns exact receipts for every publication. Keep them
    // before callbacks or result capture so a later failure can roll back only
    // this attempt.
    const receipts: PinnedRootWriteReceipt[] = [];
    const rollback = (): void => {
      for (const receipt of receipts.slice().reverse()) receipt.rollback();
    };
    try {
      const directories = [...new Set([
        options.stateDirRelative,
        options.artifactsDirRelative,
        pinnedParentPath(documentPath),
        pinnedParentPath(htmlPath),
        pinnedParentPath(artifactPath),
      ].filter((path) => path.length > 0))];
      options.pinnedRoot.ensureDirectories(directories);
      if (!options.pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed before product PRD commit");
      const published = options.pinnedRoot.writeAtomicFilesWithReceipts(outputEntries, {
        beforePublish: (prepared) => {
          for (const receipt of prepared) options.registerRollback?.(() => { receipt.rollback(); });
        },
      });
      receipts.push(...published);
      if (!options.pinnedRoot.isStable()) throw new PinnedRootError("changed", "pinned project root changed after product PRD commit");
      return {
        ok: true,
        documentPath: join(options.pinnedRoot.lexical_root, documentPath),
        htmlDocumentPath: join(options.pinnedRoot.lexical_root, htmlPath),
        artifactPath: join(options.pinnedRoot.lexical_root, artifactPath),
        source_hash,
        content_hash,
      };
    } catch (error) {
      rollback();
      throw error;
    }
  } catch (error) {
    return { ok: false, error: `product PRD persistence failed: ${String(error)}` };
  }
}

/** Standalone writer: pin the project root once, then use only relative paths. */
export function writeProductPrdDocument(options: ProductPrdWriteOptions): ProductPrdWriteResult {
  const pinnedRoot = PinnedProjectRoot.open(options.projectRoot);
  if (!pinnedRoot) return { ok: false, error: `product PRD persistence failed: project root ${options.projectRoot} could not be pinned` };
  try {
    return writeProductPrdDocumentPinned({
      pinnedRoot,
      stateDirRelative: options.stateDirRelative,
      artifactsDirRelative: options.artifactsDirRelative,
      path: options.path,
      sourceArtifacts: options.sourceArtifacts,
    });
  } finally {
    pinnedRoot.close();
  }
}

// ── validation ─────────────────────────────────────────────────────────────

/**
 * Re-verify the persisted product PRD end to end: exact manifest field set,
 * content/content_hash agreement, on-disk document bytes (existence,
 * non-symlink, hash match) and stale-source detection by re-hashing the
 * current five source artifacts against the recorded `source_hash`.
 */
export interface ProductPrdPinnedValidationOptions {
  pinnedRoot: PinnedProjectRoot;
  stateDirRelative: string;
  artifactsDirRelative: string;
}

export function validateProductPrdDocument(
  options: { stateDir: string; artifactsDir: string; pinnedRoot?: PinnedProjectRoot; stateDirRelative?: string; artifactsDirRelative?: string },
): ProductPrdValidation {
  if (options.pinnedRoot) {
    if (options.stateDirRelative === undefined || options.artifactsDirRelative === undefined) {
      return { ok: false, issues: ["product_prd validation failed: pinned relative directories are missing"] };
    }
    return validateProductPrdDocumentPinned({
      pinnedRoot: options.pinnedRoot,
      stateDirRelative: options.stateDirRelative,
      artifactsDirRelative: options.artifactsDirRelative,
    });
  }
  const projectRoot = resolve(options.stateDir);
  const pinnedRoot = PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return { ok: false, issues: [`product_prd validation failed: project root ${projectRoot} could not be pinned`] };
  try {
    const stateDirRelative = pinnedRoot.relativePath(options.stateDir)
      ?? (resolve(options.stateDir) === pinnedRoot.lexical_root ? "" : null);
    const artifactsDirRelative = pinnedRoot.relativePath(options.artifactsDir);
    if (stateDirRelative === null || artifactsDirRelative === null) {
      return { ok: false, issues: ["product_prd validation failed: directories are outside the pinned project root"] };
    }
    return validateProductPrdDocumentPinned({ pinnedRoot, stateDirRelative, artifactsDirRelative });
  } finally {
    pinnedRoot.close();
  }
}
function validateProductPrdDocumentPath(options: { stateDir: string; artifactsDir: string }): ProductPrdValidation {
  const issues: string[] = [];
  const artifactPath = join(options.artifactsDir, `${PRODUCT_PRD_ARTIFACT_ID}.json`);
  if (!existsSync(artifactPath)) {
    return { ok: false, issues: [`product_prd artifact is missing at ${artifactPath}`] };
  }
  if (lstatSync(artifactPath).isSymbolicLink()) {
    return { ok: false, issues: [`product_prd artifact at ${artifactPath} is a symlink — the manifest must be a regular file`] };
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, issues: [`product_prd artifact at ${artifactPath} is not valid JSON: ${String(error)}`] };
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, issues: ["product_prd manifest must be a JSON object"] };
  }

  const present = Object.keys(manifest).sort();
  const expected = [...PRD_MANIFEST_FIELDS].sort();
  if (present.length !== expected.length || present.some((key, index) => key !== expected[index])) {
    issues.push(`manifest field set mismatch: expected exactly [${expected.join(", ")}] but found [${present.join(", ")}]`);
  }
  if (manifest.type !== PRODUCT_PRD_ARTIFACT_ID) issues.push(`manifest type must be '${PRODUCT_PRD_ARTIFACT_ID}'`);
  if (manifest.format !== "markdown") issues.push("manifest format must be 'markdown'");
  if (typeof manifest.renderer !== "string" || manifest.renderer.length === 0) {
    issues.push("manifest renderer must be a non-empty string");
  }
  const sourceList = Array.isArray(manifest.source_artifacts) ? manifest.source_artifacts : null;
  if (
    sourceList === null ||
    sourceList.length !== PRD_SOURCE_ARTIFACT_IDS.length ||
    sourceList.some((id, index) => id !== PRD_SOURCE_ARTIFACT_IDS[index])
  ) {
    issues.push(`manifest source_artifacts must be exactly [${PRD_SOURCE_ARTIFACT_IDS.join(", ")}] in order`);
  }

  const content = typeof manifest.content === "string" ? manifest.content : null;
  const contentHash = typeof manifest.content_hash === "string" ? manifest.content_hash : null;
  const sourceHashValue = typeof manifest.source_hash === "string" ? manifest.source_hash : null;
  if (content === null) issues.push("manifest content must be a string");
  if (contentHash === null) issues.push("manifest content_hash must be a string");
  if (sourceHashValue === null) issues.push("manifest source_hash must be a string");
  if (content !== null && contentHash !== null && sha256(content) !== contentHash) {
    issues.push("manifest content does not match its own content_hash (hash mismatch)");
  }

  const manifestPath = typeof manifest.path === "string" ? manifest.path : null;
  if (manifestPath === null) {
    issues.push("manifest path must be a string");
  } else {
    const safe = safeDocumentPath(options.stateDir, manifestPath);
    if (!safe.ok) {
      issues.push(safe.error);
    } else if (!existsSync(safe.absolute)) {
      issues.push(`document file is missing at ${safe.absolute}`);
    } else if (lstatSync(safe.absolute).isSymbolicLink()) {
      issues.push(`document file at ${safe.absolute} is a symlink`);
    } else {
      const onDisk = readFileSync(safe.absolute, "utf8");
      if (contentHash !== null && sha256(onDisk) !== contentHash) {
        issues.push("document content on disk no longer matches content_hash (stale or modified content)");
      }
      if (content !== null && onDisk !== content) {
        issues.push("document content on disk differs from the manifest content");
      }
    }
  }
  const current: Record<string, unknown> = {};

  const unreadable: string[] = [];
  const symlinked: string[] = [];
  for (const id of PRD_SOURCE_ARTIFACT_IDS) {
    const sourcePath = join(options.artifactsDir, `${id}.json`);
    if (!existsSync(sourcePath)) {
      unreadable.push(id);
      continue;
    }
    if (lstatSync(sourcePath).isSymbolicLink()) {
      symlinked.push(id);
      continue;
    }
    try {
      current[id] = JSON.parse(readFileSync(sourcePath, "utf8"));
    } catch {
      unreadable.push(id);
    }
  }
  if (symlinked.length > 0) {
    issues.push(`stale source: source artifact(s) ${symlinked.join(", ")} are symlinks — sources must be regular files`);
  }
  if (unreadable.length > 0) {
    issues.push(`stale source: cannot re-read source artifact(s) ${unreadable.join(", ")}`);
  } else if (symlinked.length === 0 && sourceHashValue !== null && sourceHash(current) !== sourceHashValue) {
    issues.push(
      `stale source: the rendered PRD no longer matches the current source artifacts (${PRD_SOURCE_ARTIFACT_IDS.join(", ")}) — source_hash mismatch`,
    );
  }

  return { ok: issues.length === 0, issues };
}

type PinnedTextRead = { ok: true; text: string } | { ok: false; reason: string };

function readPinnedText(pinnedRoot: PinnedProjectRoot, path: string): PinnedTextRead {
  try {
    const entry = pinnedRoot.readFile(path, { maxBytes: MAX_PRD_VALIDATION_FILE_BYTES });
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function validateProductPrdDocumentPinned(options: ProductPrdPinnedValidationOptions): ProductPrdValidation {
  const { pinnedRoot, stateDirRelative, artifactsDirRelative } = options;
  const issues: string[] = [];
  if (!pinnedRoot.isStable()) return { ok: false, issues: ["product_prd validation failed: pinned project root changed before validation"] };
  let manifest: Record<string, unknown> | null = null;
  try {
    const snapshot = readPinnedArtifactSnapshot(pinnedRoot, artifactsDirRelative, PRODUCT_PRD_ARTIFACT_ID);
    if (snapshot.value && typeof snapshot.value === "object" && !Array.isArray(snapshot.value)) manifest = snapshot.value as Record<string, unknown>;
    else issues.push("product_prd manifest must be a JSON object");
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") return { ok: false, issues: ["product_prd artifact is missing"] };
    return { ok: false, issues: [`product_prd manifest could not be read safely: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!manifest) return { ok: false, issues };
  const present = Object.keys(manifest).sort();
  const expected = [...PRD_MANIFEST_FIELDS].sort();
  if (present.length !== expected.length || present.some((key, index) => key !== expected[index])) issues.push(`manifest field set mismatch: expected exactly [${expected.join(", ")}] but found [${present.join(", ")}]`);
  if (manifest.type !== PRODUCT_PRD_ARTIFACT_ID) issues.push(`manifest type must be '${PRODUCT_PRD_ARTIFACT_ID}'`);
  if (manifest.format !== "markdown") issues.push("manifest format must be 'markdown'");
  if (typeof manifest.renderer !== "string" || manifest.renderer.length === 0) issues.push("manifest renderer must be a non-empty string");
  const sourceList = Array.isArray(manifest.source_artifacts) ? manifest.source_artifacts : null;
  if (sourceList === null || sourceList.length !== PRD_SOURCE_ARTIFACT_IDS.length || sourceList.some((id, index) => id !== PRD_SOURCE_ARTIFACT_IDS[index])) issues.push(`manifest source_artifacts must be exactly [${PRD_SOURCE_ARTIFACT_IDS.join(", ")}] in order`);
  const content = typeof manifest.content === "string" ? manifest.content : null;
  const contentHash = typeof manifest.content_hash === "string" ? manifest.content_hash : null;
  const sourceHashValue = typeof manifest.source_hash === "string" ? manifest.source_hash : null;
  if (content === null) issues.push("manifest content must be a string");
  if (contentHash === null) issues.push("manifest content_hash must be a string");
  if (sourceHashValue === null) issues.push("manifest source_hash must be a string");
  if (content !== null && contentHash !== null && sha256(content) !== contentHash) issues.push("manifest content does not match its own content_hash (hash mismatch)");
  const manifestPath = typeof manifest.path === "string" ? manifest.path : null;
  if (manifestPath === null) {
    issues.push("manifest path must be a string");
  } else {
    try {
      const document = readPinnedText(pinnedRoot, pinnedOutputPath(stateDirRelative, manifestPath, "document path"));
      const html = readPinnedText(pinnedRoot, pinnedOutputPath(stateDirRelative, derivedHtmlPath(manifestPath), "HTML document path"));
      if (!document.ok) issues.push(`document file could not be read safely: ${document.reason}`);
      if (!html.ok) issues.push(`HTML document could not be read safely: ${html.reason}`);
      if (document.ok && contentHash !== null && sha256(document.text) !== contentHash) issues.push("document content on disk no longer matches content_hash (stale or modified content)");
      if (document.ok && content !== null && document.text !== content) issues.push("document content on disk differs from the manifest content");
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  const current: Record<string, unknown> = {};
  const unreadable: string[] = [];
  const symlinked: string[] = [];
  for (const id of PRD_SOURCE_ARTIFACT_IDS) {
    try {
      current[id] = readPinnedArtifactSnapshot(pinnedRoot, artifactsDirRelative, id).value;
    } catch (error) {
      if (error instanceof PinnedRootError && /symlink/i.test(error.message)) symlinked.push(id);
      else unreadable.push(id);
    }
  }
  if (symlinked.length > 0) issues.push(`stale source: source artifact(s) ${symlinked.join(", ")} are symlinks — sources must be regular files`);
  if (unreadable.length > 0) issues.push(`stale source: cannot safely re-read source artifact(s) ${unreadable.join(", ")}`);
  else if (symlinked.length === 0 && sourceHashValue !== null && sourceHash(current) !== sourceHashValue) issues.push(`stale source: the rendered PRD no longer matches the current source artifacts (${PRD_SOURCE_ARTIFACT_IDS.join(", ")}) — source_hash mismatch`);
  if (!pinnedRoot.isStable()) issues.push("product_prd validation failed: pinned project root changed during validation");
  return { ok: issues.length === 0, issues };
}
