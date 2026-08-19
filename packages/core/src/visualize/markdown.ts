/**
 * Visualize OPT-A — deterministic Markdown serializers (architecture-5).
 *
 * Pure projections of the immutable normalized snapshot (architecture-3) and
 * the neutral renderer node model (architecture-4) into Markdown:
 *
 * - `renderSessionMarkdown` — one session page, `sessions/<kind>/<pathKey>.md`;
 * - `renderHubMarkdown` — the bundle hub `index.md`; its scope statement
 *   visibly distinguishes `selected` (partial view) from `all` (complete);
 * - `buildLinkGraph` / `buildLinkRegistry` / `checkLinkGraph` /
 *   `preflightLinks` — the frozen link graph of every link the serializers
 *   emit, plus a preflight that proves zero dead internal targets (AC-5).
 *
 * Determinism: identical canonical inputs plus a fixed `generatedAt` yield
 * byte-identical output. Every line ends with `\n`; ordering is the frozen
 * model order (never filesystem enumeration order); `generatedAt` and the
 * staleness derived from it are the only volatile fields (VOLATILE_FIELDS).
 * mtime never appears — the model is mtime-free by construction (SLICE-0/
 * BG-1) and this module renders only model fields.
 *
 * Safety: payload text is DATA and is never interpreted as author Markdown.
 * Inline text (headings, paragraphs, list items, kv values, table cells) is
 * emitted through `mdInline`, which backslash-escapes every ASCII punctuation
 * that Markdown/GFM treats as markup (including `~` strikethrough, `=` setext
 * underlines, `&` entities, `|` tables, `<`/`>` raw HTML, `[`/`]`/`(`/`)`
 * links) and collapses CR/LF into the literal `\n` — so a payload fence,
 * HTML-like string or line break can never alter document structure.
 * Untrusted identity-derived values that reach link labels, inline status
 * text or suffixes — artifact ids, stage ids, owners and slot bases — go
 * through the same `mdInline` primitive, so a hostile identity (`<script>`,
 * `<img onerror=…>`, backticks, brackets) can never become raw markup or
 * restructure a link; hrefs and anchors stay percent-encoded and untouched.
 * Multi-line payload strings are emitted verbatim inside dynamic code fences:
 * the fence length is chosen strictly longer than any backtick run in the
 * text, so payload content can never open or close its own block; Unicode and
 * CRLF survive as data. The ONLY raw HTML in the output is the
 * serializer-generated `<a id="viz-…"></a>` anchor markers, whose ids derive
 * from validated safe identities (safe path keys, frozen section ids,
 * percent-encoded artifact ids) and cannot contain markup characters.
 *
 * Anchors: stable identity-based fragments — `viz-<pathKey>` (session),
 * `viz-<pathKey>-<encoded artifact id>` (artifact, via
 * {@link fragmentForArtifact}) and `viz-<pathKey>@<section>` (section). The
 * `@` separator is outside the encoded-artifact alphabet, so section and
 * artifact anchors are provably disjoint.
 *
 * Front matter: YAML between `---` lines; every textual value is a JSON
 * string literal with U+2028/U+2029 escaped, so hostile titles/tasks cannot
 * break the document. Source labels are the model's safe relative
 * descriptors — absolute paths and secrets (redacted at the model layer)
 * never appear in rendered output.
 *
 * Semantic sections: the overview links to `requirements`, `decisions`,
 * `architecture`, `tasks`, `artifacts` and `status-details` anchors. The
 * first four are navigation sections backed by the frozen artifact-id table
 * (SECTION_ARTIFACT_IDS): a section is emitted only when the session holds a
 * matching artifact, and each entry links to the artifact's own anchor in the
 * Artifacts section, which is the single content section in model order.
 *
 * Link graph: the serializers emit exactly the links described by
 * `buildLinkGraph` (session links on the hub; section, artifact, stage and
 * status-detail links on session pages). `checkLinkGraph` validates every
 * target — session page, section anchor, artifact anchor — against the
 * frozen registry derived from the same snapshot. Fresh output therefore has
 * zero dead internal links; missing/pending/skipped/unreadable artifact links
 * are explicit `unavailable` targets whose anchors still exist (status-only
 * blocks in the Artifacts section).
 */

import {
  REGENERATE_HINT,
  defaultRenderOptions,
  depthPolicyBehavior,
  depthPolicyFor,
  fragmentForArtifact,
  fragmentForSession,
  sessionPagePath,
  type LinkCheckResult,
  type LinkGraph,
  type LinkKind,
  type LinkTarget,
  type LinkTargetState,
  type PathKey,
  type RenderOptions,
  type SectionId,
  type SessionKind,
  type VisualizationArtifact,
  type VisualizationLink,
  type VisualizationScope,
  type VisualizationSession,
  type VisualizationSnapshot,
  type WorkflowName,
} from "./types.js";
import { renderArtifact, type RenderNode } from "./renderer-registry.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** PathKey used for hub-side link sources in the link graph (index page). */
export const HUB_PATH_KEY = "hub" as const;

/** Anchor of the hub page heading. */
export const HUB_ANCHOR = "viz-hub" as const;

/** Reader-visible labels of the semantic sections (frozen vocabulary). */
const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  overview: "Overview",
  requirements: "Requirements",
  decisions: "Decisions and options",
  architecture: "Architecture",
  tasks: "Tasks",
  artifacts: "Artifacts",
  "status-details": "Status details",
};

/** Content sections backed by artifact-id membership (never ordinal). */
type ContentSection = Exclude<SectionId, "overview" | "artifacts" | "status-details">;

const CONTENT_SECTIONS: readonly ContentSection[] = ["requirements", "decisions", "architecture", "tasks"];

/**
 * Frozen artifact-id membership per semantic section. A section is emitted
 * only when the session holds one of these ids (model order determines which
 * artifact the section links). spec_architecture_tasks legitimately backs
 * both Architecture and Tasks (its payload carries both).
 */
const SECTION_ARTIFACT_IDS: Readonly<Record<ContentSection, readonly string[]>> = {
  requirements: ["spec_requirements_edge_cases", "feature_spec", "clarifications", "spec_intake_repo_map"],
  decisions: ["spec_options_decisions", "spec-preparation", "decisions"],
  architecture: ["spec_architecture_tasks", "architecture"],
  tasks: ["spec_architecture_tasks", "implementation"],
};

/** Frozen iteration order of every section link emitted from the overview. */
const ALL_SECTIONS: readonly SectionId[] = [
  "requirements",
  "decisions",
  "architecture",
  "tasks",
  "artifacts",
  "status-details",
];

// ── Text primitives (format-specific escaping) ───────────────────────────────

/**
 * ASCII punctuation treated as markup by CommonMark/GFM. mdText (architecture-4)
 * escapes the core set; this serializer additionally escapes `~` (strikethrough),
 * `=` (setext underline), `&` (entity parsing) and `-` (lists/HRs) so payload
 * text can never restructure a document. Escaping — never stripping — keeps
 * the payload visible verbatim.
 */
const MD_ESCAPE_RE = /[\\`*_{}\[\]()#+.!|<>~=&-]/g;

/** Escaped single-line Markdown text: markup escaped, CR/LF collapsed. */
function mdInline(value: unknown): string {
  return String(value ?? "")
    .replace(MD_ESCAPE_RE, "\\$&")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Link text for validated frozen vocabulary (artifact/stage statuses, error
 * categories, section labels): only link-syntax punctuation is escaped.
 * These values are constrained unions or frozen constants that cannot carry
 * markup, so the raw form stays readable while remaining structurally inert.
 * Untrusted identity-derived values (artifact ids, stage ids, owners, slot
 * bases) MUST be emitted through {@link mdInline} instead — mdLinkText does
 * NOT escape `<`/`>` or backticks and would let hostile identities become
 * raw HTML or code spans inside link text.
 */
function mdLinkText(value: unknown): string {
  return String(value ?? "").replace(/[\[\]()]/g, "\\$&");
}

/** YAML-safe scalar: JSON string literal with U+2028/U+2029 escaped. */
function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value ?? ""))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Dynamic code fence: the minimal backtick run (≥ 3) that does not occur in
 * the text, so the payload can never contain a line equal to the fence and
 * can never close (or open) its own block. Bounded in practice by the model's
 * byte caps.
 */
function fenceFor(text: string): string {
  let run = 3;
  while (text.includes("`".repeat(run))) run += 1;
  return "`".repeat(run);
}

// ── Anchors (stable identity-based) ──────────────────────────────────────────

/** Section anchor for a session page: `viz-<pathKey>@<section>`. */
export function sectionAnchorOf(pathKey: PathKey, section: SectionId): string {
  return `${fragmentForSession(pathKey)}@${section}`;
}

/** `<a id="…"></a>` marker — the only raw HTML this serializer emits. */
function anchorLine(id: string): string {
  return `<a id="${id}"></a>`;
}

// ── Node serialization (renderer node model → Markdown) ──────────────────────

function nodeLines(node: RenderNode): string[] {
  switch (node.kind) {
    case "heading":
      return [`${"#".repeat(node.level)} ${mdInline(node.text)}`];
    case "paragraph":
      return [mdInline(node.text)];
    case "list":
      return node.items.map((item) => `- ${mdInline(item)}`);
    case "kv":
      return [`- **${mdInline(node.key)}:** ${mdInline(node.value)}`];
    case "table":
      return tableLines(node.headers, node.rows);
    case "code":
      return codeLines(node.text);
  }
}

/** Every cell is escaped (payload is data); rows are padded to the header width. */
function tableLines(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const cols = headers.length;
  const rowLine = (cells: readonly string[]): string => {
    const padded = [...cells.slice(0, cols)];
    while (padded.length < cols) padded.push("");
    return `| ${padded.map(mdInline).join(" | ")} |`;
  };
  return [rowLine(headers), `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map(rowLine)];
}

/** Payload text verbatim inside a dynamic fence (structure cannot break). */
function codeLines(text: string): string[] {
  const fence = fenceFor(text);
  return [fence, text, fence];
}

/** Render a node sequence with blank-line separation, then a trailing blank. */
function renderNodes(nodes: readonly RenderNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) out.push(...nodeLines(node), "");
  return out;
}

// ── Workflow / classification helpers ────────────────────────────────────────

/** Deterministic workflow classification line (depth policy MD-4). */
function workflowLabel(workflow: WorkflowName): string {
  const policy = depthPolicyFor(workflow);
  const bodies = depthPolicyBehavior(policy).bodiesByDefault ? "enabled by default" : "disabled by default";
  switch (policy) {
    case "detailed":
      return `${workflow} (detailed; bodies ${bodies})`;
    case "compact":
      return `${workflow} (compact; bodies ${bodies})`;
    default:
      return `${workflow} (safe default; bodies ${bodies})`;
  }
}

// ── Session model helpers ────────────────────────────────────────────────────

/** True when the serializer emits the section heading for this session. */
function sectionPresent(session: VisualizationSession, section: SectionId): boolean {
  if (section === "overview" || section === "artifacts" || section === "status-details") return true;
  const ids = (SECTION_ARTIFACT_IDS as Readonly<Record<SectionId, readonly string[]>>)[section];
  return ids !== undefined && session.artifacts.some((a) => ids.includes(a.id));
}

/** Artifacts of a session matching a semantic content section (model order). */
function sectionArtifacts(session: VisualizationSession, section: ContentSection): VisualizationArtifact[] {
  const ids = SECTION_ARTIFACT_IDS[section];
  return session.artifacts.filter((a) => ids.includes(a.id));
}

/** Visible slot suffix, e.g. " (slot of spec_intake_repo_map)". */
function slotSuffix(artifact: VisualizationArtifact): string {
  return artifact.slotFor !== undefined ? ` (slot of ${mdInline(artifact.slotFor)})` : "";
}

/** Link target state per artifact status: content is unavailable unless produced. */
function artifactLinkState(artifact: VisualizationArtifact): LinkTargetState {
  return artifact.status === "produced" ? "resolved" : "unavailable";
}

// ── Front matter ─────────────────────────────────────────────────────────────

function sessionFrontMatter(session: VisualizationSession): string[] {
  const identity = session.identity;
  const provenance = session.provenance;
  const lines = [
    "---",
    `schema: ${session.schema}`,
    `kind: ${yamlScalar(identity.kind)}`,
    `id: ${yamlScalar(identity.id)}`,
    `path_key: ${yamlScalar(identity.pathKey)}`,
    `title: ${yamlScalar(identity.title)}`,
    `task: ${yamlScalar(identity.task)}`,
    `workflow: ${yamlScalar(identity.workflow)}`,
    `source_format: ${yamlScalar(identity.sourceFormat)}`,
    `is_legacy: ${identity.isLegacy}`,
    `status: ${yamlScalar(session.status)}`,
    `staleness: ${yamlScalar(provenance.staleness)}`,
    ...(provenance.sourceUpdatedAt !== undefined ? [`updated_at: ${yamlScalar(provenance.sourceUpdatedAt)}`] : []),
    ...(provenance.profileHash !== undefined ? [`profile_hash: ${yamlScalar(provenance.profileHash)}`] : []),
    `source_digest: ${yamlScalar(provenance.sourceDigest.bounded)}`,
    `generated_at: ${yamlScalar(provenance.generatedAt)}`,
    `renderer: ${yamlScalar(provenance.renderer.name)}`,
    `renderer_version: ${yamlScalar(provenance.renderer.version)}`,
    "---",
    "",
  ];
  return lines;
}

// ── Session page sections ────────────────────────────────────────────────────

function overviewLines(session: VisualizationSession): string[] {
  const pathKey = session.identity.pathKey;
  const provenance = session.provenance;
  const out: string[] = [anchorLine(sectionAnchorOf(pathKey, "overview")), "## Overview", ""];
  out.push(`- **Task:** ${mdInline(session.identity.task)}`);
  out.push(`- **Session:** ${mdInline(session.identity.kind)} / ${mdInline(session.identity.id)} — ${mdInline(session.identity.title)}`);
  out.push(`- **Workflow:** ${mdInline(workflowLabel(session.identity.workflow))}`);
  out.push("", "### Workflow and stage progress", "");
  if (session.stages.length === 0) {
    out.push("- No stage progress recorded for this session.", "");
  } else {
    const byId = new Set(session.artifacts.map((a) => a.id));
    for (const stage of session.stages) {
      const title = stage.title !== undefined && stage.title !== "" ? ` — ${mdInline(stage.title)}` : "";
      out.push(`- **${mdLinkText(stage.status)}** ${mdInline(stage.stageId)}${title}`);
      for (const id of stage.artifactIds) {
        if (!byId.has(id)) continue;
        out.push(`  - [${mdInline(id)}](#${fragmentForArtifact(pathKey, id)})`);
      }
    }
    out.push("");
  }
  out.push("### Provenance", "");
  out.push(`- **Status:** ${mdInline(session.status)}`);
  out.push(`- **Staleness:** ${mdInline(provenance.staleness)}`);
  if (provenance.staleness === "stale") out.push(`  - ${mdInline(REGENERATE_HINT)}`);
  out.push(`- **Source:** ${mdInline(session.source.label)} (${mdInline(session.source.format)}, ${session.source.bytes} bytes)`);
  out.push(`- **Source updated at:** ${provenance.sourceUpdatedAt !== undefined ? mdInline(provenance.sourceUpdatedAt) : "unknown"}`);
  out.push(`- **Source digest:** ${mdInline(provenance.sourceDigest.bounded)}`);
  out.push(`- **Generated at:** ${mdInline(provenance.generatedAt)}`);
  out.push(`- **Renderer:** ${mdInline(provenance.renderer.name)} ${mdInline(provenance.renderer.version)}`);
  out.push("", "### Sections", "");
  for (const section of ALL_SECTIONS) {
    if (sectionPresent(session, section)) out.push(`- [${mdLinkText(SECTION_LABELS[section])}](#${sectionAnchorOf(pathKey, section)})`);
  }
  out.push("", `### Artifacts (${session.artifacts.length})`, "");
  if (session.artifacts.length === 0) {
    out.push("- No artifacts yet.", "");
  } else {
    for (const artifact of session.artifacts) {
      out.push(`- [${mdInline(artifact.id)}](#${fragmentForArtifact(pathKey, artifact.id)}) — ${mdLinkText(artifact.status)}${slotSuffix(artifact)}`);
    }
    out.push("");
  }
  return out;
}

function semanticSectionLines(session: VisualizationSession, section: ContentSection): string[] {
  const matches = sectionArtifacts(session, section);
  if (matches.length === 0) return [];
  const pathKey = session.identity.pathKey;
  const out: string[] = [anchorLine(sectionAnchorOf(pathKey, section)), `## ${SECTION_LABELS[section]}`, ""];
  for (const artifact of matches) {
    out.push(`- [${mdInline(artifact.id)}](#${fragmentForArtifact(pathKey, artifact.id)}) — ${mdLinkText(artifact.status)}${slotSuffix(artifact)}`);
  }
  out.push("");
  return out;
}

function artifactSectionLines(session: VisualizationSession, options: RenderOptions, renderWarnings: string[]): string[] {
  const pathKey = session.identity.pathKey;
  const out: string[] = [anchorLine(sectionAnchorOf(pathKey, "artifacts")), "## Artifacts", ""];
  if (session.artifacts.length === 0) {
    out.push("- No artifacts yet — this session has no declared or discovered artifacts.", "");
    return out;
  }
  for (const artifact of session.artifacts) {
    const result = renderArtifact(artifact, options, renderWarnings);
    out.push(anchorLine(fragmentForArtifact(pathKey, artifact.id)), ...renderNodes(result.nodes));
  }
  return out;
}

function statusDetailsLines(session: VisualizationSession): string[] {
  const pathKey = session.identity.pathKey;
  const out: string[] = [anchorLine(sectionAnchorOf(pathKey, "status-details")), "## Status details", ""];
  if (session.artifacts.length === 0) {
    out.push("- No artifacts in this session.", "");
  } else {
    for (const artifact of session.artifacts) {
      const source = artifact.source?.label ?? "";
      const bytes = artifact.bytes !== undefined ? String(artifact.bytes) : "";
      const reason = artifact.errorCategory ?? "";
      out.push(
        `- [${mdInline(artifact.id)}](#${fragmentForArtifact(pathKey, artifact.id)}) — ${mdLinkText(artifact.status)}` +
          ` — owner ${mdInline(artifact.owner)}${slotSuffix(artifact)}` +
          `${source !== "" ? ` — source ${mdInline(source)}` : ""}` +
          `${bytes !== "" ? ` — ${bytes} bytes` : ""}` +
          `${reason !== "" ? ` — reason ${mdLinkText(reason)}` : ""}`,
      );
    }
    out.push("");
  }
  out.push(`- **Session status:** ${mdInline(session.status)}`);
  if (session.status === "degraded" && (session.degradedReasons ?? []).length > 0) {
    out.push("- **Degraded reasons:**");
    for (const reason of session.degradedReasons ?? []) out.push(`  - ${mdInline(reason)}`);
  }
  out.push(`- **Staleness:** ${mdInline(session.provenance.staleness)}`);
  out.push("");
  return out;
}

function warningsLines(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  return ["## Warnings", "", ...warnings.map((w) => `- ${mdInline(w)}`), ""];
}

// ── Hub page ─────────────────────────────────────────────────────────────────

function artifactCountLine(session: VisualizationSession): string {
  const counts = { produced: 0, missing: 0, pending: 0, skipped: 0, unreadable: 0 };
  for (const artifact of session.artifacts) counts[artifact.status] += 1;
  return `${counts.produced} produced, ${counts.missing} missing, ${counts.pending} pending, ${counts.skipped} skipped, ${counts.unreadable} unreadable`;
}

/** Visible scope statement: selected is explicitly partial, --all complete. */
function scopeStatement(scope: VisualizationScope, snapshot: VisualizationSnapshot): string {
  if (scope === "all") {
    return `> Scope: all — complete view. Every discovered session (${snapshot.manifest.counts.discoveredSessions}) is included in this bundle.`;
  }
  return "> Scope: selected — PARTIAL view. Only the selected/latest session is included in this bundle; sessions outside the selection are not generated. Run with --all to generate every discovered session.";
}

function hubLines(snapshot: VisualizationSnapshot): string[] {
  const out: string[] = [anchorLine(HUB_ANCHOR), "# Workflow visualization", "", scopeStatement(snapshot.scope, snapshot), ""];
  out.push("## Sessions", "");
  if (snapshot.sessions.length === 0) {
    out.push("- No sessions generated.", "");
  } else {
    for (const session of snapshot.sessions) {
      const pathKey = session.identity.pathKey;
      const page = sessionPagePath(session.identity.kind, pathKey, "md");
      const href = `${page}#${fragmentForSession(pathKey)}`;
      out.push(
        `- [${mdInline(session.identity.title)}](${href}) — ${mdInline(session.identity.kind)}/${mdInline(session.identity.id)}` +
          ` · ${mdInline(session.identity.workflow)} · ${mdInline(session.status)} · ${mdInline(session.provenance.staleness)}` +
          ` · ${artifactCountLine(session)} · digest ${mdInline(session.provenance.sourceDigest.bounded)}`,
      );
      if (session.provenance.staleness === "stale") {
        out.push(`  - stale: ${mdInline(REGENERATE_HINT)}`);
      }
      if (session.status === "degraded") {
        out.push("  - degraded: rendered from available content only (see the session page)");
      }
    }
    out.push("");
  }
  if (snapshot.warnings.length > 0) {
    out.push("## Warnings", "");
    for (const warning of snapshot.warnings) out.push(`- ${mdInline(warning)}`);
    out.push("");
  }
  return out;
}

function hubFrontMatter(snapshot: VisualizationSnapshot): string[] {
  const counts = snapshot.manifest.counts;
  return [
    "---",
    `schema: ${snapshot.schema}`,
    `scope: ${yamlScalar(snapshot.scope)}`,
    `generated_at: ${yamlScalar(snapshot.generatedAt)}`,
    `renderer: ${yamlScalar(snapshot.renderer.name)}`,
    `renderer_version: ${yamlScalar(snapshot.renderer.version)}`,
    `discovered_sessions: ${counts.discoveredSessions}`,
    `generated_sessions: ${counts.generatedSessions}`,
    `session_count: ${snapshot.sessions.length}`,
    `stale_sessions: ${counts.staleSessions}`,
    `degraded_sessions: ${counts.degradedSessions}`,
    `artifact_total: ${counts.artifactTotal}`,
    `dead_links: ${counts.deadLinks}`,
    "---",
    "",
  ];
}

// ── Line joining (byte-deterministic) ────────────────────────────────────────

/** Join lines with `\n`; strip trailing blank lines; end with exactly one `\n`. */
function joinLines(lines: readonly string[]): string {
  const text = lines.join("\n").replace(/\n+$/, "");
  return `${text}\n`;
}

// ── Public serializers ───────────────────────────────────────────────────────

export interface RenderSessionOptions {
  /** Match the render options used when the snapshot bodies were built. */
  full?: boolean;
}

/**
 * Render one session page. Pure: consumes only the immutable session; never
 * touches the filesystem and never mutates the model. Renderer-failure
 * warnings raised while serializing artifact nodes are appended to the
 * session's own warnings in the Warnings section (deterministic).
 */
export function renderSessionMarkdown(session: VisualizationSession, options: RenderSessionOptions = {}): string {
  const renderOptions = defaultRenderOptions(options.full ?? false);
  const renderWarnings: string[] = [];
  const lines: string[] = [...sessionFrontMatter(session)];
  lines.push(anchorLine(fragmentForSession(session.identity.pathKey)), `# ${mdInline(session.identity.title)}`, "");
  lines.push(...overviewLines(session));
  for (const section of CONTENT_SECTIONS) lines.push(...semanticSectionLines(session, section));
  lines.push(...artifactSectionLines(session, renderOptions, renderWarnings));
  lines.push(...statusDetailsLines(session));
  lines.push(...warningsLines([...session.warnings, ...renderWarnings]));
  return joinLines(lines);
}

/** Render the bundle hub (`index.md`). Pure; scope statement is visible. */
export function renderHubMarkdown(snapshot: VisualizationSnapshot): string {
  return joinLines([...hubFrontMatter(snapshot), ...hubLines(snapshot)]);
}

// ── Link graph and preflight (frozen link graph, zero dead targets) ──────────

/** Frozen anchor/artifact/section registry of one generated session page. */
export interface LinkRegistrySession {
  kind: SessionKind;
  pathKey: PathKey;
  artifactIds: ReadonlySet<string>;
  sections: ReadonlySet<SectionId>;
  anchors: ReadonlySet<string>;
}

/** Frozen registry of every link target that exists in the generated output. */
export interface LinkRegistry {
  hubAnchor: string;
  sessions: ReadonlyMap<string, LinkRegistrySession>;
}

/**
 * Derive the frozen target registry from the snapshot — exactly the anchors,
 * artifact ids and sections the serializers emit. Used by
 * {@link checkLinkGraph} to prove zero dead internal links (AC-5).
 */
export function buildLinkRegistry(snapshot: VisualizationSnapshot): LinkRegistry {
  const sessions = new Map<string, LinkRegistrySession>();
  for (const session of snapshot.sessions) {
    const pathKey = session.identity.pathKey;
    const anchors = new Set<string>([
      fragmentForSession(pathKey),
      sectionAnchorOf(pathKey, "overview"),
      sectionAnchorOf(pathKey, "artifacts"),
      sectionAnchorOf(pathKey, "status-details"),
    ]);
    const sections = new Set<SectionId>(["overview", "artifacts", "status-details"]);
    for (const section of CONTENT_SECTIONS) {
      if (sectionPresent(session, section)) {
        anchors.add(sectionAnchorOf(pathKey, section));
        sections.add(section);
      }
    }
    const artifactIds = new Set<string>();
    for (const artifact of session.artifacts) {
      artifactIds.add(artifact.id);
      anchors.add(fragmentForArtifact(pathKey, artifact.id));
    }
    sessions.set(pathKey, { kind: session.identity.kind, pathKey, artifactIds, sections, anchors });
  }
  return { hubAnchor: HUB_ANCHOR, sessions };
}

/** Deterministic link id for one emitted link (stable and unique across runs). */
function linkId(kind: LinkKind, from: LinkTarget, to: LinkTarget): string {
  const key = (t: LinkTarget): string =>
    `${t.sessionPathKey}${t.targetId !== undefined ? `:${t.targetId}` : ""}${t.section !== undefined ? `:${t.section}` : ""}`;
  return `${kind}:${key(from)}:${key(to)}`;
}

/**
 * Build the frozen link graph of every link the serializers emit, from the
 * same snapshot that was (or will be) rendered. All targets exist by
 * construction; `state` marks explicit unavailable/degraded targets.
 */
export function buildLinkGraph(snapshot: VisualizationSnapshot): LinkGraph {
  const links: VisualizationLink[] = [];
  for (const session of snapshot.sessions) {
    const pathKey = session.identity.pathKey;
    const sessionTarget: LinkTarget = { sessionPathKey: pathKey, anchor: fragmentForSession(pathKey) };
    const hubFrom: LinkTarget = { sessionPathKey: HUB_PATH_KEY, anchor: HUB_ANCHOR };
    const overviewFrom: LinkTarget = {
      sessionPathKey: pathKey,
      section: "overview",
      anchor: sectionAnchorOf(pathKey, "overview"),
    };

    // Hub → session page (degraded sessions stay reachable, explicitly degraded).
    links.push({
      id: linkId("session", hubFrom, sessionTarget),
      kind: "session",
      from: hubFrom,
      to: sessionTarget,
      label: session.identity.title,
      state: session.status === "degraded" ? "degraded" : "resolved",
    });

    // Overview → semantic sections (only sections the page actually emits).
    for (const section of ALL_SECTIONS) {
      if (!sectionPresent(session, section)) continue;
      const target: LinkTarget = { sessionPathKey: pathKey, section, anchor: sectionAnchorOf(pathKey, section) };
      links.push({
        id: linkId("section", overviewFrom, target),
        kind: "section",
        from: overviewFrom,
        to: target,
        label: SECTION_LABELS[section],
        state: "resolved",
      });
    }

    // Overview artifact index → every artifact anchor (unavailable when body-less).
    for (const artifact of session.artifacts) {
      const target: LinkTarget = { sessionPathKey: pathKey, targetId: artifact.id, anchor: fragmentForArtifact(pathKey, artifact.id) };
      links.push({
        id: linkId("artifact", overviewFrom, target),
        kind: "artifact",
        from: overviewFrom,
        to: target,
        label: artifact.id,
        state: artifactLinkState(artifact),
      });
    }

    // Semantic sections → matching artifact anchors.
    for (const section of CONTENT_SECTIONS) {
      for (const artifact of sectionArtifacts(session, section)) {
        const from: LinkTarget = { sessionPathKey: pathKey, section, anchor: sectionAnchorOf(pathKey, section) };
        const target: LinkTarget = { sessionPathKey: pathKey, targetId: artifact.id, anchor: fragmentForArtifact(pathKey, artifact.id) };
        links.push({
          id: linkId("artifact", from, target),
          kind: "artifact",
          from,
          to: target,
          label: artifact.id,
          state: artifactLinkState(artifact),
        });
      }
    }

    // Stage progress → owned artifact anchors (ids absent from the model are skipped).
    const artifactById = new Map(session.artifacts.map((a) => [a.id, a]));
    for (const stage of session.stages) {
      const from: LinkTarget = { sessionPathKey: pathKey, targetId: stage.stageId };
      for (const id of stage.artifactIds) {
        const artifact = artifactById.get(id);
        if (artifact === undefined) continue;
        const target: LinkTarget = { sessionPathKey: pathKey, targetId: id, anchor: fragmentForArtifact(pathKey, id) };
        links.push({
          id: linkId("stage", from, target),
          kind: "stage",
          from,
          to: target,
          label: `${stage.stageId} → ${id}`,
          state: artifactLinkState(artifact),
        });
      }
    }

    // Status details → artifact anchors (one per artifact, model order).
    for (const artifact of session.artifacts) {
      const from: LinkTarget = { sessionPathKey: pathKey, section: "status-details", anchor: sectionAnchorOf(pathKey, "status-details") };
      const target: LinkTarget = { sessionPathKey: pathKey, targetId: artifact.id, anchor: fragmentForArtifact(pathKey, artifact.id) };
      links.push({
        id: linkId("status-detail", from, target),
        kind: "status-detail",
        from,
        to: target,
        label: artifact.id,
        state: artifactLinkState(artifact),
      });
    }
  }
  return { links };
}

/** True when the link target exists in the frozen registry (dead-link check). */
function linkTargetResolves(to: LinkTarget, registry: LinkRegistry): boolean {
  const session = registry.sessions.get(to.sessionPathKey);
  if (session === undefined) return false;
  if (to.anchor !== undefined && !session.anchors.has(to.anchor)) return false;
  if (to.targetId !== undefined && !session.artifactIds.has(to.targetId)) return false;
  if (to.targetId !== undefined && to.anchor !== undefined && to.anchor !== fragmentForArtifact(to.sessionPathKey, to.targetId)) return false;
  if (to.section !== undefined && !session.sections.has(to.section)) return false;
  if (to.section !== undefined && to.anchor !== undefined && to.anchor !== sectionAnchorOf(to.sessionPathKey, to.section)) return false;
  return true;
}

/**
 * Preflight a frozen link graph against the frozen registry. Fresh output
 * built from the same snapshot returns zero dead links; a mutated or foreign
 * graph reports every unresolvable target.
 */
export function checkLinkGraph(graph: LinkGraph, registry: LinkRegistry): LinkCheckResult {
  const deadLinks: VisualizationLink[] = [];
  for (const link of graph.links) {
    if (!linkTargetResolves(link.to, registry)) deadLinks.push(link);
  }
  return { checked: graph.links.length, deadLinks };
}

/**
 * One-shot preflight for a snapshot: build the frozen graph + registry and
 * check every link. Zero dead targets for fresh output (AC-5).
 */
export function preflightLinks(snapshot: VisualizationSnapshot): LinkCheckResult {
  return checkLinkGraph(buildLinkGraph(snapshot), buildLinkRegistry(snapshot));
}
