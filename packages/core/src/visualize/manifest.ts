/**
 * Visualize OPT-A — deterministic bundle manifest and link-graph preflight
 * (architecture-6).
 *
 * Pure module. `buildManifest` derives the mandatory
 * `VisualizationManifest` (frozen in types.ts) from the immutable normalized
 * sessions plus an explicit volatile clock (`generatedAt`): identical inputs
 * and a fixed clock produce byte-identical manifests. Session order is the
 * pinned total order (`compareSessions`), never filesystem order. The
 * manifest carries safe session metadata, pathKeys and RELATIVE output
 * paths only — no bodies, no absolute paths, no source descriptors.
 *
 * `allGeneratedPages` is the pruning metadata contract for the writer
 * (architecture-7): the complete sorted set of relative bundle pages
 * (hub pair + manifest.json + every session page), i.e. exactly the
 * allow-list an atomic swap must keep. Anything else under the output root
 * is stale and prunable.
 *
 * `preflightLinks` is the fresh-output link-graph check (link_contract:
 * "Fresh output is checked as a link graph; zero dead internal links are
 * allowed"). It resolves every href emitted by the serializers against the
 * rendered page set: in-page fragments must exist as ids in the same page,
 * relative hrefs must resolve (with `..` normalization) to a generated page
 * and their fragments to ids in that page, and any scheme/absolute/backslash
 * href is dead. Deterministic ordering: pages sorted, hrefs in document
 * order. External URLs are never generated, so any scheme href is a defect.
 */

import {
  DEFAULT_RENDERER_IDENTITY,
  REGENERATE_HINT,
  VISUALIZE_OUTPUT_FILES,
  compareSessions,
  sessionPagePath,
  type LinkCheckResult,
  type LinkKind,
  type RendererIdentity,
  type VisualizationLink,
  type VisualizationManifest,
  type VisualizationScope,
  type VisualizationSession,
} from "./types.js";
import { collectIdsAndHrefs } from "./html.js";

// ── Manifest construction ────────────────────────────────────────────────────

export interface BuildManifestOptions {
  /** ISO timestamp — volatile (the only field that may differ across runs). */
  generatedAt: string;
  /** Renderer identity; default: DEFAULT_RENDERER_IDENTITY. */
  renderer?: RendererIdentity;
  /**
   * Sessions discovered in scope before generation. Defaults to the number
   * of generated sessions; pass a higher value when some discovered sessions
   * failed to render so the manifest stays honest about completeness.
   */
  discoveredSessions?: number;
  /**
   * Pages actually written (md+html per session plus the hub md+html pair).
   * Defaults to the full-bundle count `sessions.length * 2 + 2`.
   */
  generatedPages?: number;
  /** Dead internal links from a fresh preflight (default 0). */
  deadLinks?: number;
}

function artifactCountsOf(session: VisualizationSession): VisualizationManifest["sessions"][number]["artifacts"] {
  const counts: VisualizationManifest["sessions"][number]["artifacts"] = {
    produced: 0,
    missing: 0,
    pending: 0,
    skipped: 0,
    unreadable: 0,
  };
  for (const artifact of session.artifacts) counts[artifact.status] += 1;
  return counts;
}

function manifestEntryFor(session: VisualizationSession): VisualizationManifest["sessions"][number] {
  const provenance = session.provenance;
  const stale = provenance.staleness === "stale";
  return {
    kind: session.identity.kind,
    id: session.identity.id,
    pathKey: session.identity.pathKey,
    title: session.identity.title,
    task: session.identity.task,
    workflow: session.identity.workflow,
    ...(provenance.sourceUpdatedAt !== undefined ? { updatedAt: provenance.sourceUpdatedAt } : {}),
    sourceDigestBounded: provenance.sourceDigest.bounded,
    status: session.status,
    staleness: provenance.staleness,
    artifacts: artifactCountsOf(session),
    pages: [
      sessionPagePath(session.identity.kind, session.identity.pathKey, "md"),
      sessionPagePath(session.identity.kind, session.identity.pathKey, "html"),
    ],
    ...(stale ? { regenerateHint: REGENERATE_HINT } : {}),
  };
}

/**
 * Build the mandatory deterministic manifest from the immutable sessions.
 * Sessions are re-sorted in the pinned total order (defensive: the snapshot
 * is already ordered, but the manifest must be deterministic regardless of
 * caller input order) and every count is derived from the sessions or the
 * explicit options — no filesystem state ever enters.
 */
export function buildManifest(
  sessions: readonly VisualizationSession[],
  scope: VisualizationScope,
  options: BuildManifestOptions,
): VisualizationManifest {
  const sorted = [...sessions].sort((a, b) =>
    compareSessions(
      { updatedAt: a.provenance.sourceUpdatedAt, kind: a.identity.kind, id: a.identity.id },
      { updatedAt: b.provenance.sourceUpdatedAt, kind: b.identity.kind, id: b.identity.id },
    ),
  );
  const entries = sorted.map(manifestEntryFor);
  const renderer = options.renderer ?? DEFAULT_RENDERER_IDENTITY;
  return {
    schema: 1,
    scope,
    generatedAt: options.generatedAt,
    renderer,
    sessions: entries,
    counts: {
      discoveredSessions: options.discoveredSessions ?? sessions.length,
      generatedSessions: sessions.length,
      generatedPages: options.generatedPages ?? sessions.length * 2 + 2,
      staleSessions: entries.filter((e) => e.staleness === "stale").length,
      degradedSessions: entries.filter((e) => e.status === "degraded").length,
      artifactTotal: entries.reduce((n, e) => n + Object.values(e.artifacts).reduce((m, c) => m + c, 0), 0),
      deadLinks: options.deadLinks ?? 0,
    },
  };
}

// ── Pruning metadata (architecture-7 allow-list) ─────────────────────────────

/**
 * The complete sorted set of relative bundle pages: the hub md/html pair,
 * the manifest itself, and every session page (md + html) listed in the
 * manifest. Deterministic for a given manifest; used by the writer to keep
 * exactly these files and prune everything else under the output root.
 */
export function allGeneratedPages(manifest: VisualizationManifest): string[] {
  const pages = new Set<string>([
    VISUALIZE_OUTPUT_FILES.hubMarkdown,
    VISUALIZE_OUTPUT_FILES.hubHtml,
    VISUALIZE_OUTPUT_FILES.manifest,
  ]);
  for (const entry of manifest.sessions) {
    for (const page of entry.pages) pages.add(page);
  }
  return [...pages].sort();
}

// ── Link-graph preflight (fresh-output check, zero dead links) ───────────────

const EXTERNAL_HREF_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Resolve a generated href against the page it appears on to a relative page
 * path. In-page fragments and unresolvable/external hrefs return undefined.
 * `..` segments normalize within the bundle; an href that escapes the bundle
 * root normalizes to a path outside the generated set and is therefore
 * reported dead by the preflight (never silently resolved elsewhere).
 */
export function resolvePageHref(pagePath: string, href: string): string | undefined {
  if (href === "" || href.startsWith("#")) return undefined;
  if (href.startsWith("//") || href.startsWith("/") || href.includes("\\") || EXTERNAL_HREF_RE.test(href)) {
    return undefined;
  }
  const hashIndex = href.indexOf("#");
  const pathPart = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const baseDir = pagePath.includes("/") ? pagePath.slice(0, pagePath.lastIndexOf("/") + 1) : "";
  const segments = [...baseDir.split("/").filter(Boolean), ...pathPart.split("/")];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function linkKindOf(href: string): LinkKind {
  if (href.startsWith("#")) {
    if (href.includes("~stage-")) return "stage";
    if (/^#viz-[^-]+-/.test(href)) return "artifact";
    if (href === "#status-details") return "status-detail";
    return "section";
  }
  return href.endsWith(".html") ? "session" : "section";
}

/**
 * Fresh-output link-graph check: for every rendered page, resolve every
 * emitted href (in-page fragments against the same page's ids, relative
 * hrefs against the generated page set) and collect every dead link in
 * deterministic order (pages sorted, hrefs in document order). A zero-dead
 * result is the acceptance gate for a fresh bundle (AC-5).
 */
export function preflightLinks(pages: Readonly<Record<string, string>>): LinkCheckResult {
  const pageList = Object.entries(pages).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const idsByPage = new Map<string, Set<string>>();
  for (const [pagePath, html] of pageList) {
    idsByPage.set(pagePath, new Set(collectIdsAndHrefs(html).ids));
  }
  const deadLinks: VisualizationLink[] = [];
  let checked = 0;
  for (const [pagePath, html] of pageList) {
    for (const href of collectIdsAndHrefs(html).hrefs) {
      checked += 1;
      let fragment: string | undefined;
      let target: string | undefined;
      if (href.startsWith("#")) {
        fragment = href.slice(1);
      } else {
        const targetPath = resolvePageHref(pagePath, href);
        if (targetPath !== undefined && Object.hasOwn(pages, targetPath)) {
          target = targetPath;
          const hashIndex = href.indexOf("#");
          fragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : undefined;
        }
      }
      const targetIds = target !== undefined ? idsByPage.get(target) : undefined;
      const ok =
        (target === undefined && fragment !== undefined && idsByPage.get(pagePath)?.has(fragment) === true) ||
        (target !== undefined && (fragment === undefined || targetIds?.has(fragment) === true));
      if (ok) continue;
      deadLinks.push({
        id: `${pagePath}#${href}`,
        kind: linkKindOf(href),
        from: { sessionPathKey: pagePath },
        to: { sessionPathKey: target ?? href, ...(fragment !== undefined ? { anchor: fragment } : {}) },
        label: href,
        state: "unavailable",
      });
    }
  }
  return { checked, deadLinks };
}
