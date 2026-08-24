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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { renderMarkdownDocumentHtml } from "../report/markdown.js";

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

export interface ProductPrdWriteOptions {
  /** State root the document path is resolved within (e.g. `.work-state`). */
  stateDir: string;
  /** Directory receiving the typed `product_prd` artifact. */
  artifactsDir: string;
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

let tempCounter = 0;

/** Temp path (same dir, dot-prefixed) staged next to the final target. */
function tempPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${(tempCounter += 1)}`);
}

/**
 * The artifacts dir must be a real directory inside the real state root —
 * never a symlink (which could point outside the state dir entirely) and
 * never a regular file.
 */
function safeArtifactsDir(stateDir: string, artifactsDir: string): { ok: true } | { ok: false; error: string } {
  if (existsSync(artifactsDir)) {
    const info = lstatSync(artifactsDir);
    if (info.isSymbolicLink()) return { ok: false, error: `unsafe artifacts dir: '${artifactsDir}' is a symlink` };
    if (!info.isDirectory()) return { ok: false, error: `unsafe artifacts dir: '${artifactsDir}' is not a directory` };
    const realRoot = realpathSync(stateDir);
    const realArtifacts = realpathSync(artifactsDir);
    const rel = relative(realRoot, realArtifacts);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { ok: false, error: `unsafe artifacts dir: '${artifactsDir}' resolves outside the state dir` };
    }
    return { ok: true };
  }
  const lexical = relative(stateDir, artifactsDir);
  if (lexical === "" || lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    return { ok: false, error: `unsafe artifacts dir: '${artifactsDir}' lies outside the state dir` };
  }
  // Absent target: no existing ancestor between the state root and the
  // artifacts dir may be a symlink — otherwise the (recursive) create would
  // silently materialize the dir outside the state root through the link.
  let current = stateDir;
  for (const segment of lexical.split(sep).filter((part) => part !== "" && part !== ".")) {
    current = join(current, segment);
    if (current === artifactsDir) break;
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      return { ok: false, error: `unsafe artifacts dir: '${segment}' on the path to '${artifactsDir}' is a symlink` };
    }
  }

  return { ok: true };
}

interface FileSnapshot {
  exists: boolean;
  bytes: Buffer | null;
}

function validateArtifactTarget(path: string): { ok: true } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true };
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return { ok: false, error: `product PRD persistence failed: unsafe artifact target: '${path}' is a symlink` };
  if (!info.isFile()) return { ok: false, error: `product PRD persistence failed: unsafe artifact target: '${path}' is not a regular file` };
  return { ok: true };
}

function captureSnapshot(path: string): FileSnapshot {
  return existsSync(path) ? { exists: true, bytes: readFileSync(path) } : { exists: false, bytes: null };
}

function restoreSnapshot(path: string, snapshot: FileSnapshot): void {
  if (!snapshot.exists || snapshot.bytes === null) {
    rmSync(path, { force: true });
    return;
  }
  const restoreTemp = tempPathFor(path);
  try {
    writeFileSync(restoreTemp, snapshot.bytes);
    renameSync(restoreTemp, path);
  } finally {
    rmSync(restoreTemp, { force: true });
  }
}

/**
 * Render and atomically persist the product PRD: the markdown document at
 * `join(stateDir, path)`, its derived sibling HTML viewer, and the typed
 * `product_prd` artifact with the exact manifest fields. All validation and
 * rendering happens before the first commit rename; failures restore every
 * previous target and clean temporary files.
 */
export function writeProductPrdDocument(options: ProductPrdWriteOptions): ProductPrdWriteResult {
  const sourceArtifacts: Record<string, unknown> = {};
  const provided = options.sourceArtifacts ?? {};
  for (const id of PRD_SOURCE_ARTIFACT_IDS) {
    const value = provided[id];
    if (value === undefined || value === null) {
      return { ok: false, error: `cannot render product PRD: source artifact '${id}' is missing` };
    }
    sourceArtifacts[id] = value;
  }

  const relativePath = options.path ?? DEFAULT_DOCUMENT_PATH;
  const safe = safeDocumentPath(options.stateDir, relativePath);
  if (!safe.ok) return { ok: false, error: safe.error };
  const htmlRelativePath = derivedHtmlPath(relativePath);
  const safeHtml = safeDocumentPath(options.stateDir, htmlRelativePath);
  if (!safeHtml.ok) return { ok: false, error: safeHtml.error };
  if (safe.absolute === safeHtml.absolute) {
    return { ok: false, error: `unsafe document path: Markdown and HTML targets collide at '${safe.absolute}'` };
  }
  const artifactsDirSafe = safeArtifactsDir(options.stateDir, options.artifactsDir);
  if (!artifactsDirSafe.ok) return { ok: false, error: artifactsDirSafe.error };
  const artifactPath = join(options.artifactsDir, `${PRODUCT_PRD_ARTIFACT_ID}.json`);
  const artifactTargetSafe = validateArtifactTarget(artifactPath);
  if (!artifactTargetSafe.ok) return { ok: false, error: artifactTargetSafe.error };

  let documentTemp: string | null = null;
  let htmlTemp: string | null = null;
  let artifactTemp: string | null = null;
  let snapshots: Array<[string, FileSnapshot]> | null = null;
  try {
    const markdown = renderProductPrdDocument(sourceArtifacts);
    const html = renderMarkdownDocumentHtml(markdown, {
      title: "Product PRD",
      lang: "en",
      toc: true,
      navigation: true,
    });
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
    snapshots = [
      [safe.absolute, captureSnapshot(safe.absolute)],
      [safeHtml.absolute, captureSnapshot(safeHtml.absolute)],
      [artifactPath, captureSnapshot(artifactPath)],
    ];

    mkdirSync(dirname(safe.absolute), { recursive: true });
    mkdirSync(dirname(safeHtml.absolute), { recursive: true });
    mkdirSync(options.artifactsDir, { recursive: true });

    // Stage all three outputs before committing any rename.
    documentTemp = tempPathFor(safe.absolute);
    writeFileSync(documentTemp, markdown, "utf8");
    htmlTemp = tempPathFor(safeHtml.absolute);
    writeFileSync(htmlTemp, html, "utf8");
    artifactTemp = tempPathFor(artifactPath);
    writeFileSync(artifactTemp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    renameSync(documentTemp, safe.absolute);
    documentTemp = null;
    renameSync(htmlTemp, safeHtml.absolute);
    htmlTemp = null;
    renameSync(artifactTemp, artifactPath);
    artifactTemp = null;
    return {
      ok: true,
      documentPath: safe.absolute,
      htmlDocumentPath: safeHtml.absolute,
      artifactPath,
      source_hash,
      content_hash,
    };
  } catch (error) {
    if (documentTemp !== null) rmSync(documentTemp, { force: true });
    if (htmlTemp !== null) rmSync(htmlTemp, { force: true });
    if (artifactTemp !== null) rmSync(artifactTemp, { force: true });
    const rollbackErrors: string[] = [];
    if (snapshots !== null) {
      for (const [target, snapshot] of snapshots) {
        try {
          restoreSnapshot(target, snapshot);
        } catch (rollbackError) {
          rollbackErrors.push(`${target}: ${String(rollbackError)}`);
        }
      }
    }
    return {
      ok: false,
      error: `product PRD persistence failed: ${String(error)}${rollbackErrors.length ? `; rollback: ${rollbackErrors.join("; ")}` : ""}`,
    };
  }
}

// ── validation ─────────────────────────────────────────────────────────────

/**
 * Re-verify the persisted product PRD end to end: exact manifest field set,
 * content/content_hash agreement, on-disk document bytes (existence,
 * non-symlink, hash match) and stale-source detection by re-hashing the
 * current five source artifacts against the recorded `source_hash`.
 */
export function validateProductPrdDocument(options: { stateDir: string; artifactsDir: string }): ProductPrdValidation {
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
