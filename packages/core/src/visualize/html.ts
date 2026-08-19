/**
 * Visualize OPT-A — self-contained HTML hub and session pages (architecture-6).
 *
 * Pure serializers. The hub (`renderHubHtml`) and the per-session pages
 * (`renderSessionHtml`) are built exclusively from the immutable normalized
 * `VisualizationSnapshot` / `VisualizationSession` plus the neutral render
 * nodes produced by the architecture-4 renderer registry
 * (`renderArtifact`). No fs, no network, no mutation: identical inputs and
 * a fixed `generatedAt` produce byte-identical HTML except for the declared
 * volatile fields (generatedAt/staleness).
 *
 * Self-containment and safety (AC-4, integrity constraints):
 * - ALL CSS is inline in one <style> block using the system font stack —
 *   no external fonts, images, scripts, styles, CDN, fetch or network call.
 * - The ONLY script is a one-line inline class-toggle that is never required
 *   for navigation: JS-disabled/static navigation works through plain
 *   fragment and relative <a href> anchors (AC-4).
 * - Payload text, attribute values and embedded bodies are escaped
 *   SEPARATELY via `htmlText` (never stripped): hostile payloads remain
 *   data and cannot inject markup, attributes or script. `<` in bodies is
 *   escaped so `</pre>`/`<script>` cannot break out of a code block.
 * - Source descriptors are safe relative labels; absolute paths never enter
 *   the model and are never rendered.
 *
 * Navigation (link_contract):
 * - Stable identity anchors: session anchors via `fragmentForSession`,
 *   artifact anchors via `fragmentForArtifact` (both pinned in types.ts),
 *   and stage anchors via `fragmentForStage`. Within one document, artifact
 *   anchors use a `-` separator after the path key while stage anchors use
 *   `~stage-`; artifact ids are validated safe path keys, so no artifact
 *   anchor and no stage anchor can ever alias each other.
 * - Relative hub/session links: the hub links to every session page as
 *   `sessions/<kind>/<pathKey>.html#viz-<pathKey>`; every session page links
 *   back to the hub as `../../index.html`. Both resolve under file://.
 * - Every artifact and stage anchor is referenced by at least one in-page
 *   link (overview stage summary, per-section artifact index, stage artifact
 *   lists, status details), so a fresh-output crawl reaches every generated
 *   session/artifact/stage target.
 *
 * Scope visibility: `scope: "selected"` renders an explicit "partial
 * bundle" banner on the hub and (when passed through) on session pages;
 * `scope: "all"` is completeness mode (AC-2, REQ-9/10).
 */

import {
  REGENERATE_HINT,
  VISUALIZE_OUTPUT_FILES,
  fragmentForArtifact,
  fragmentForSession,
  sessionPagePath,
  type ArtifactStatus,
  type PathKey,
  type RendererIdentity,
  type SectionId,
  type Staleness,
  type VisualizationSession,
  type VisualizationSnapshot,
} from "./types.js";
import { ARTIFACT_HEADING_LEVEL, artifactHeading, htmlText, renderArtifact, type RenderNode } from "./renderer-registry.js";

// ── Output constants (frozen in types.ts) ────────────────────────────────────

const HUB_HTML_FILE = VISUALIZE_OUTPUT_FILES.hubHtml;
/** Relative link every session page uses to reach the hub (two levels up). */
const HUB_BACK_REL = `../../${HUB_HTML_FILE}`;

/** Defensive display bound for rendered body text in <pre> blocks. */
const CODE_DETAILS_THRESHOLD = 4096;

// ── Semantic section mapping (reader_journey) ────────────────────────────────

/**
 * Deterministic id-based mapping of artifacts onto the semantic sections.
 * Consilium slot files follow their base (`slotFor`). Unknown `spec_*` ids
 * are spec-family planning documents and land in Tasks. Every other
 * freeform/typed id lands in the "artifacts" (other) bucket, so the mapping
 * is total and never depends on filesystem order or payload content.
 * Membership uses `Object.hasOwn` so hostile ids like "constructor" cannot
 * alias prototype properties.
 */
const REQUIREMENTS_ARTIFACT_IDS: Readonly<Record<string, true>> = {
  spec_requirements_edge_cases: true,
  spec_intake_repo_map: true,
  discovery: true,
  exploration: true,
  clarifications: true,
  diagnosis: true,
  feature_spec: true,
  cto_discovery: true,
};
const DECISIONS_ARTIFACT_IDS: Readonly<Record<string, true>> = {
  spec_options_decisions: true,
};
const ARCHITECTURE_ARTIFACT_IDS: Readonly<Record<string, true>> = {
  spec_architecture_tasks: true,
  architecture: true,
  integration_review: true,
};
const TASKS_ARTIFACT_IDS: Readonly<Record<string, true>> = {
  spec_handoff: true,
  "spec-preparation": true,
  spec_completeness: true,
  implementation: true,
  review: true,
  debug: true,
  manual_qa: true,
  qa_tests: true,
  team_plan: true,
  team_artifacts: true,
  summary: true,
  dod: true,
};

/** Semantic section of an artifact — total, deterministic, never payload-derived. */
export function semanticSectionForArtifact(artifact: { id: string; slotFor?: string }): SectionId {
  const base = artifact.slotFor ?? artifact.id;
  if (Object.hasOwn(REQUIREMENTS_ARTIFACT_IDS, base)) return "requirements";
  if (Object.hasOwn(DECISIONS_ARTIFACT_IDS, base)) return "decisions";
  if (Object.hasOwn(ARCHITECTURE_ARTIFACT_IDS, base)) return "architecture";
  if (Object.hasOwn(TASKS_ARTIFACT_IDS, base)) return "tasks";
  if (base.startsWith("spec_") || base.startsWith("spec-")) return "tasks";
  return "artifacts";
}

/** Fixed section order for the TOC and page layout. */
const SECTION_ORDER: readonly SectionId[] = [
  "overview",
  "requirements",
  "decisions",
  "architecture",
  "tasks",
  "artifacts",
  "status-details",
];

const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  overview: "Overview",
  requirements: "Requirements",
  decisions: "Decisions and options",
  architecture: "Architecture",
  tasks: "Tasks and implementation",
  artifacts: "Other artifacts",
  "status-details": "Status details",
};

// ── Stable identity anchors ──────────────────────────────────────────────────

/**
 * Deterministic surrogate-safe URL-component encoding for stage anchors.
 * Validated safe ids encode to themselves (identical to the pinned
 * `encodeURIComponent` behavior); pathological ids carrying lone surrogates
 * (which `encodeURIComponent` cannot encode) are replaced deterministically
 * so the renderer never throws on hostile model input.
 */
export function anchorEncode(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return encodeURIComponent(value.replace(/[\uD800-\uDFFF]/g, "\uFFFD"));
  }
}

/**
 * Surrogate-safe copy of an id: lone surrogates (unencodable by
 * `encodeURIComponent`) are replaced deterministically; valid ids pass
 * through untouched so the pinned `fragmentForArtifact` never throws.
 */
function surrogateSafe(value: string): string {
  return /[\uD800-\uDFFF]/.test(value) ? value.replace(/[\uD800-\uDFFF]/g, "\uFFFD") : value;
}

/**
 * Artifact anchor: the pinned `fragmentForArtifact` (which itself applies
 * `encodeURIComponent` — the surrogate-safe id is passed RAW, never
 * pre-encoded, to avoid double encoding) applied to the artifact id. For
 * validated safe ids this is byte-identical to the architecture-1 pin.
 */
export function artifactAnchor(pathKey: PathKey, artifactId: string): string {
  return fragmentForArtifact(pathKey, surrogateSafe(artifactId));
}

/**
 * Stage anchor. `~stage-` after the session anchor is a separator no
 * artifact anchor can contain (artifact anchors use `-`; artifact ids are
 * safe path keys, so their encoding never contains `~`), making stage and
 * artifact anchors collision-free within a document.
 */
export function fragmentForStage(pathKey: PathKey, stageId: string): string {
  return `${fragmentForSession(pathKey)}~stage-${anchorEncode(stageId)}`;
}

// ── Badges ───────────────────────────────────────────────────────────────────

/** One status/staleness chip: escaped vocabulary label, sanitized class. */
function statusBadge(status: string): string {
  const cls = status.replace(/[^A-Za-z0-9_-]/g, "");
  return `<span class="badge badge-${cls}">${htmlText(status)}</span>`;
}

function scopeBadge(scope: VisualizationSnapshot["scope"]): string {
  return scope === "selected"
    ? `<span class="badge badge-partial">${htmlText("selected / latest (partial)")}</span>`
    : `<span class="badge badge-all">${htmlText("all sessions (complete)")}</span>`;
}

// ── Page scaffold ────────────────────────────────────────────────────────────

const PAGE_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0 auto; padding: 0 1rem 2rem; max-width: 60rem; line-height: 1.5; color: #18181b; }
h1 { font-size: 1.45rem; margin: 0.4rem 0; }
h2 { font-size: 1.15rem; margin: 2rem 0 0.4rem; padding-bottom: 0.25rem; border-bottom: 1px solid #e4e4e7; }
h3 { font-size: 1.02rem; margin: 1.1rem 0 0.35rem; }
h4, h5 { font-size: 0.95rem; margin: 0.9rem 0 0.3rem; }
header.site { border-bottom: 1px solid #d4d4d8; padding: 0.9rem 0 0.6rem; }
header.site .hub-link { font-size: 0.85rem; }
nav#toc { margin: 1rem 0; padding: 0.6rem 0.9rem; border: 1px solid #e4e4e7; border-radius: 8px; background: #fafafa; }
nav#toc ul { margin: 0.25rem 0; padding-left: 1.1rem; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre.code { background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 6px; padding: 0.7rem; overflow-x: auto; font-size: 0.84rem; white-space: pre-wrap; word-break: break-word; margin: 0.4rem 0; }
details.code-block { margin: 0.4rem 0; }
details.code-block summary { cursor: pointer; font-size: 0.85rem; color: #52525b; }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; font-size: 0.88rem; }
th, td { border: 1px solid #d4d4d8; padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; }
th { background: #f4f4f5; }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 0.75rem; margin: 0.4rem 0; }
dl.kv dt { font-weight: 600; }
dl.kv dd { margin: 0; word-break: break-word; }
.badge { display: inline-block; padding: 0.08rem 0.5rem; border-radius: 999px; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; vertical-align: middle; white-space: nowrap; }
.badge-produced, .badge-done, .badge-complete, .badge-fresh, .badge-all { background: #d1fae5; color: #065f46; }
.badge-missing, .badge-failed, .badge-stale { background: #fee2e2; color: #991b1b; }
.badge-pending, .badge-in_progress, .badge-unknown { background: #fef3c7; color: #92400e; }
.badge-skipped { background: #e2e8f0; color: #334155; }
.badge-unreadable, .badge-degraded { background: #f3e8ff; color: #6b21a8; }
.badge-partial { background: #e0e7ff; color: #3730a3; }
.banner { border: 1px solid; border-radius: 6px; padding: 0.5rem 0.75rem; margin: 0.75rem 0; font-size: 0.9rem; }
.banner.stale { border-color: #fecaca; background: #fef2f2; }
.banner.degraded { border-color: #e9d5ff; background: #faf5ff; }
.banner.partial { border-color: #c7d2fe; background: #eef2ff; }
ul.index { list-style: none; padding-left: 0; margin: 0.4rem 0; }
ul.index li { display: inline-block; margin: 0 1rem 0.25rem 0; }
section.artifact { border: 1px solid #e4e4e7; border-radius: 8px; padding: 0.7rem 1rem; margin: 0.7rem 0; }
section.stage { border-left: 3px solid #a1a1aa; padding-left: 0.8rem; margin: 0.7rem 0; }
footer.site { margin-top: 2.5rem; border-top: 1px solid #e4e4e7; padding-top: 0.5rem; font-size: 0.8rem; color: #71717a; }
@media (prefers-color-scheme: dark) {
  body { color: #e4e4e7; }
  nav#toc, section.artifact, section.stage { background: #18181b; border-color: #3f3f46; }
  header.site, footer.site { border-color: #3f3f46; }
  pre.code, th { background: #27272a; }
  th, td { border-color: #3f3f46; }
  h2 { border-color: #3f3f46; }
}
`;

const PAGE_SCRIPT = `document.documentElement.classList.add("js");`;

function pageScaffold(opts: { title: string; generator: RendererIdentity; body: string }): string {
  const { title, generator, body } = opts;
  return [
    "<!doctype html>",
    `<html lang="en">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${htmlText(title)}</title>`,
    `<meta name="generator" content="${htmlText(`${generator.name} ${generator.version}`)}">`,
    `<style>${PAGE_CSS}</style>`,
    "</head>",
    "<body>",
    body,
    `<script>${PAGE_SCRIPT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ── RenderNode → HTML (payload text is escaped, never stripped) ──────────────

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = headers.map((h) => `<th>${htmlText(h)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${htmlText(cell)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderCodeBlock(text: string): string {
  const escaped = htmlText(text);
  if (text.length > CODE_DETAILS_THRESHOLD) {
    return `<details class="code-block"><summary>Show body (${text.length} chars)</summary><pre class="code"><code>${escaped}</code></pre></details>`;
  }
  return `<pre class="code"><code>${escaped}</code></pre>`;
}

/** Render one neutral render node. `text`/`items`/`cells` are plain data. */
export function renderNode(node: RenderNode): string {
  switch (node.kind) {
    case "heading":
      return `<h${node.level}>${htmlText(node.text)}</h${node.level}>`;
    case "paragraph":
      return `<p>${htmlText(node.text)}</p>`;
    case "list":
      return `<ul>${node.items.map((item) => `<li>${htmlText(item)}</li>`).join("")}</ul>`;
    case "table":
      return renderTable(node.headers, node.rows);
    case "kv":
      return `<dl class="kv"><dt>${htmlText(node.key)}</dt><dd>${htmlText(node.value)}</dd></dl>`;
    case "code":
      return renderCodeBlock(node.text);
  }
}

/**
 * Render one artifact's nodes with its stable identity anchor attached to the
 * leading heading (the renderer contract puts the artifact heading first).
 * Defensive: if the first node is not a heading, a synthesized anchored
 * heading is emitted and every renderer node is preserved. The attribute
 * context uses the same htmlText primitive as text/embedded data — the five
 * escapes cover double-quoted attributes — so hostile ids/anchors can never
 * inject attributes.
 */
function renderArtifactSection(artifact: Parameters<typeof renderArtifact>[0], anchor: string, warnings: string[]): string {
  const result = renderArtifact(artifact, undefined, warnings);
  const nodes = result.nodes;
  const first = nodes[0];
  let headingHtml: string;
  let rest: readonly RenderNode[];
  if (first !== undefined && first.kind === "heading") {
    headingHtml = `<h${first.level} id="${htmlText(anchor)}" class="artifact-title">${htmlText(first.text)}</h${first.level}>`;
    rest = nodes.slice(1);
  } else {
    headingHtml = `<h${ARTIFACT_HEADING_LEVEL} id="${htmlText(anchor)}" class="artifact-title">${htmlText(artifactHeading(artifact))}</h${ARTIFACT_HEADING_LEVEL}>`;
    rest = nodes;
  }
  return `<section class="artifact">${headingHtml}${rest.map(renderNode).join("")}</section>`;
}

// ── Link/anchor collection (pure, for tests and the link-graph preflight) ────

export interface CollectedPageLinks {
  ids: string[];
  hrefs: string[];
}

/**
 * Extract every `id` and `href` attribute value in document order. The
 * serializer always emits double-quoted attributes whose values are escaped
 * (no literal `"` inside), so a plain regex is exact for generated output.
 */
export function collectIdsAndHrefs(html: string): CollectedPageLinks {
  const ids: string[] = [];
  const hrefs: string[] = [];
  const idRe = /\bid="([^"]*)"/g;
  const hrefRe = /\bhref="([^"]*)"/g;
  for (const m of html.matchAll(idRe)) ids.push(m[1] ?? "");
  for (const m of html.matchAll(hrefRe)) hrefs.push(m[1] ?? "");
  return { ids, hrefs };
}

// ── Hub page ─────────────────────────────────────────────────────────────────

/**
 * Render the bundle entry point. Lists every session in manifest order with
 * relative page links, status/staleness/degraded badges, artifact counts,
 * scope visibility (selected/latest is visibly partial) and deterministic
 * bundle counts. Pure and deterministic for a fixed generatedAt.
 */
export function renderHubHtml(snapshot: VisualizationSnapshot): string {
  const manifest = snapshot.manifest;
  const counts = manifest.counts;

  const banners: string[] = [];
  if (snapshot.scope === "selected") {
    banners.push(
      `<p class="banner partial">Partial bundle: this hub lists the selected/latest sessions (${manifest.sessions.length} of ${counts.discoveredSessions} discovered), not the complete workspace. Run with --all for completeness mode.</p>`,
    );
  }
  if (counts.staleSessions > 0) {
    banners.push(`<p class="banner stale">${counts.staleSessions} stale session${counts.staleSessions === 1 ? "" : "s"}: ${htmlText(REGENERATE_HINT)}</p>`);
  }
  if (counts.degradedSessions > 0) {
    banners.push(
      `<p class="banner degraded">${counts.degradedSessions} degraded session${counts.degradedSessions === 1 ? "" : "s"}: rendered from available content only; see the session page for reasons.</p>`,
    );
  }

  const summaryRows: string[][] = [
    ["Scope", snapshot.scope],
    ["Sessions generated", String(counts.generatedSessions)],
    ["Sessions discovered", String(counts.discoveredSessions)],
    ["Generated pages", String(counts.generatedPages)],
    ["Stale sessions", String(counts.staleSessions)],
    ["Degraded sessions", String(counts.degradedSessions)],
    ["Artifacts (total)", String(counts.artifactTotal)],
    ["Dead internal links", String(counts.deadLinks)],
    ["Generated at", snapshot.generatedAt],
  ];

  const sessionItems = manifest.sessions
    .map((entry) => {
      const href = `${sessionPagePath(entry.kind, entry.pathKey, "html")}#${fragmentForSession(entry.pathKey)}`;
      const countsText = [
        `produced ${entry.artifacts.produced}`,
        `missing ${entry.artifacts.missing}`,
        `pending ${entry.artifacts.pending}`,
        `skipped ${entry.artifacts.skipped}`,
        `unreadable ${entry.artifacts.unreadable}`,
      ]
        .filter((part) => !part.endsWith(" 0"))
        .join(" · ");
      return [
        `<li>`,
        `<a href="${htmlText(href)}">${htmlText(entry.title)}</a> `,
        statusBadge(entry.status),
        statusBadge(entry.staleness),
        `<span class="task">${htmlText(entry.task)}</span>`,
        countsText !== "" ? `<span class="counts">${htmlText(countsText)}</span>` : "",
        `</li>`,
      ].join("");
    })
    .join("");

  const sessionList = manifest.sessions.length === 0 ? `<p>No sessions in scope.</p>` : `<ul>${sessionItems}</ul>`;

  const body = [
    `<header class="site">`,
    `<h1>Workflow visualization hub</h1>`,
    `<p>${scopeBadge(snapshot.scope)} <span class="meta">${htmlText(`${snapshot.renderer.name} ${snapshot.renderer.version}`)}</span></p>`,
    ...banners,
    `</header>`,
    `<main>`,
    `<section id="overview">`,
    `<h2>Bundle summary</h2>`,
    renderTable(["Metric", "Value"], summaryRows),
    `</section>`,
    `<section id="sessions">`,
    `<h2>Sessions</h2>`,
    `<nav id="toc" aria-label="Sessions">${sessionList}</nav>`,
    `</section>`,
    ...(snapshot.warnings.length > 0
      ? [`<section id="status-details"><h2>Status details</h2><ul class="warnings">${snapshot.warnings.map((w) => `<li>${htmlText(w)}</li>`).join("")}</ul></section>`]
      : []),
    `</main>`,
    `<footer class="site">Generated by ${htmlText(`${snapshot.renderer.name} ${snapshot.renderer.version}`)} at ${htmlText(snapshot.generatedAt)}. Local read-only projection; reopen or regenerate to refresh.</footer>`,
  ].join("\n");

  return pageScaffold({ title: "Workflow visualization hub", generator: snapshot.renderer, body });
}

// ── Session page ─────────────────────────────────────────────────────────────

/**
 * Render one session page. Sections are emitted only when they carry
 * content (overview and status details always exist in some form), and the
 * TOC mirrors exactly the emitted sections so no generated link can dangle.
 * `scope` optionally marks the page as part of a visibly partial bundle.
 */
export function renderSessionHtml(session: VisualizationSession, opts: { scope?: VisualizationSnapshot["scope"] } = {}): string {
  const identity = session.identity;
  const pathKey = identity.pathKey;
  const provenance = session.provenance;
  const renderWarnings: string[] = [];

  const banners: string[] = [];
  if (opts.scope === "selected") {
    banners.push(`<p class="banner partial">Partial bundle: this page belongs to the selected/latest session list.</p>`);
  }
  if (provenance.staleness === "stale") {
    banners.push(`<p class="banner stale">Stale: ${htmlText(REGENERATE_HINT)}</p>`);
  }

  const overviewRows: string[][] = [
    ["Task", identity.task],
    ["Kind", identity.kind],
    ["Id", identity.id],
    ["Path key", pathKey],
    ["Workflow", identity.workflow],
    ["Source format", identity.sourceFormat],
    ["Status", session.status],
    ["Source updated at", provenance.sourceUpdatedAt ?? "(none)"],
    ["Source digest", provenance.sourceDigest.bounded],
    ["Generated at", provenance.generatedAt],
    ["Renderer", `${provenance.renderer.name} ${provenance.renderer.version}`],
    ["Staleness", provenance.staleness],
  ];

  // Overview includes a compact stage summary that links every stage anchor.
  const stageSummary =
    session.stages.length === 0
      ? ""
      : [
          `<p>Stage progress: ${session.stages.filter((s) => s.status === "done").length}/${session.stages.length} done.</p>`,
          `<ul class="stages">`,
          ...session.stages.map((stage) => {
            const title = stage.title ?? stage.stageId;
            return `<li><a href="#${htmlText(fragmentForStage(pathKey, stage.stageId))}">${htmlText(title)}</a> ${statusBadge(stage.status)}</li>`;
          }),
          `</ul>`,
        ].join("");

  // Artifact buckets in deterministic session order (static section keys).
  const sectionArtifacts: Record<SectionId, VisualizationSession["artifacts"]> = {
    overview: [],
    requirements: [],
    decisions: [],
    architecture: [],
    tasks: [],
    artifacts: [],
    "status-details": [],
  };
  for (const artifact of session.artifacts) {
    sectionArtifacts[semanticSectionForArtifact(artifact)].push(artifact);
  }

  const stageSection =
    session.stages.length === 0
      ? []
      : [
          `<section id="stages">`,
          `<h2>Stage progress</h2>`,
          ...session.stages.map((stage) => {
            const title = stage.title ?? stage.stageId;
            const phase = stage.phase !== undefined ? ` <span class="phase">${htmlText(stage.phase)}</span>` : "";
            const artifactList = stage.artifactIds
              .map((id) => {
                const found = session.artifacts.find((a) => a.id === id);
                if (found === undefined) return `<li>${htmlText(id)}</li>`;
                return `<li><a href="#${htmlText(artifactAnchor(pathKey, id))}">${htmlText(id)}</a> ${statusBadge(found.status)}</li>`;
              })
              .join("");
            return [
              `<section class="stage">`,
              `<h3 id="${htmlText(fragmentForStage(pathKey, stage.stageId))}">${htmlText(title)}</h3>`,
              `<p>${statusBadge(stage.status)}${phase}</p>`,
              artifactList !== "" ? `<ul class="artifact-links">${artifactList}</ul>` : `<p>No artifacts for this stage.</p>`,
              `</section>`,
            ].join("");
          }),
          `</section>`,
        ];

  const semanticSections = SECTION_ORDER.filter(
    (section) => section !== "overview" && section !== "status-details",
  )
    .filter((section) => sectionArtifacts[section].length > 0)
    .map((section) => {
      const artifacts = sectionArtifacts[section];
      const index = `<ul class="index">${artifacts
        .map(
          (a) =>
            `<li><a href="#${htmlText(artifactAnchor(pathKey, a.id))}">${htmlText(a.id)}</a> ${statusBadge(a.status)}</li>`,
        )
        .join("")}</ul>`;
      const artifactHtml = artifacts.map((a) => renderArtifactSection(a, artifactAnchor(pathKey, a.id), renderWarnings)).join("");
      return [`<section id="${section}">`, `<h2>${htmlText(SECTION_LABELS[section])}</h2>`, index, artifactHtml, `</section>`].join("");
    });

  // Status details: non-produced artifacts, warnings, degraded reasons,
  // renderer warnings, and the no-artifacts-yet note (AC-12).
  const statusEntries = session.artifacts
    .filter((a) => a.status !== "produced")
    .map((a) => {
      const reason = a.errorCategory !== undefined ? ` <span class="reason">${htmlText(a.errorCategory)}</span>` : "";
      return `<li><a href="#${htmlText(artifactAnchor(pathKey, a.id))}">${htmlText(a.id)}</a> ${statusBadge(a.status)}${reason}</li>`;
    })
    .join("");
  const degradedList =
    session.degradedReasons !== undefined && session.degradedReasons.length > 0
      ? `<p class="banner degraded">Degraded: ${session.degradedReasons.map((r) => htmlText(r)).join("; ")}</p>`
      : "";
  const noArtifactsNote = session.artifacts.length === 0 ? `<p>No artifacts yet — overview-only view.</p>` : "";
  const warningsList =
    session.warnings.length === 0
      ? ""
      : `<h3>Warnings</h3><ul class="warnings">${session.warnings.map((w) => `<li>${htmlText(w)}</li>`).join("")}</ul>`;
  const renderWarningsList =
    renderWarnings.length === 0
      ? ""
      : `<h3>Renderer warnings</h3><ul class="warnings">${renderWarnings.map((w) => `<li>${htmlText(w)}</li>`).join("")}</ul>`;

  const hasStatusDetails =
    statusEntries !== "" || degradedList !== "" || warningsList !== "" || renderWarningsList !== "" || noArtifactsNote !== "";
  const statusDetailsSection = hasStatusDetails
    ? [
        `<section id="status-details">`,
        `<h2>Status details</h2>`,
        degradedList,
        noArtifactsNote,
        statusEntries !== "" ? `<h3>Unavailable states</h3><ul>${statusEntries}</ul>` : "",
        warningsList,
        renderWarningsList,
        `</section>`,
      ].join("")
    : "";

  // TOC mirrors the emitted sections exactly — no generated link can dangle.
  const tocEntries: string[] = [`<li><a href="#overview">Overview</a></li>`];
  if (session.stages.length > 0) tocEntries.push(`<li><a href="#stages">Stage progress</a></li>`);
  for (const section of SECTION_ORDER) {
    if (section === "overview" || section === "status-details") continue;
    if (sectionArtifacts[section].length > 0) {
      tocEntries.push(`<li><a href="#${section}">${htmlText(SECTION_LABELS[section])}</a></li>`);
    }
  }
  if (hasStatusDetails) tocEntries.push(`<li><a href="#status-details">Status details</a></li>`);

  const body = [
    `<header class="site">`,
    `<a class="hub-link" href="${htmlText(HUB_BACK_REL)}">Back to hub</a>`,
    `<h1 id="${htmlText(fragmentForSession(pathKey))}">${htmlText(identity.title)}</h1>`,
    `<p>${statusBadge(session.status)} ${statusBadge(provenance.staleness)}${opts.scope === "selected" ? ` ${scopeBadge(opts.scope)}` : ""} <span class="meta">${htmlText(identity.workflow)}</span></p>`,
    ...banners,
    `</header>`,
    `<nav id="toc" aria-label="Table of contents"><ul>${tocEntries.join("")}</ul></nav>`,
    `<main>`,
    `<section id="overview">`,
    `<h2>Overview</h2>`,
    renderTable(["Field", "Value"], overviewRows),
    stageSummary,
    `</section>`,
    ...stageSection,
    ...semanticSections,
    statusDetailsSection,
    `</main>`,
    `<footer class="site">Generated by ${htmlText(`${provenance.renderer.name} ${provenance.renderer.version}`)} at ${htmlText(provenance.generatedAt)}. <a href="${htmlText(HUB_BACK_REL)}">Back to hub</a></footer>`,
  ].join("\n");

  return pageScaffold({ title: `${identity.title} — workflow session`, generator: provenance.renderer, body });
}
