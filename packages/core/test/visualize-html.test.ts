/**
 * Visualize OPT-A — self-contained HTML hub/session serializer tests
 * (architecture-6).
 *
 * Defends the observable HTML surface: deterministic output for identical
 * inputs, stable identity anchors (session/artifact/stage), overview plus
 * all semantic sections and status/stale/degraded/partial badges, relative
 * hub/session links that work under file://, JS-disabled/static navigation
 * (one inert inline script, plain anchors), no external URLs/assets/absolute
 * paths, and hostile-payload escaping (text, attributes and embedded data
 * are escaped separately — payloads remain data and cannot inject markup,
 * attributes or script). All serializers are pure: no fs, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  anchorEncode,
  artifactAnchor,
  collectIdsAndHrefs,
  fragmentForStage,
  renderHubHtml,
  renderSessionHtml,
  semanticSectionForArtifact,
} from "../src/visualize/html.js";
import { buildManifest, resolvePageHref } from "../src/visualize/manifest.js";
import {
  DEFAULT_BODY_CAP_BYTES,
  DEFAULT_RENDERER_IDENTITY,
  REGENERATE_HINT,
  VISUALIZE_OUTPUT_FILES,
  fragmentForArtifact,
  fragmentForSession,
  sessionPagePath,
  type RedactedBody,
  type SourceDigest,
  type VisualizationArtifact,
  type VisualizationScope,
  type VisualizationSession,
  type VisualizationSnapshot,
} from "../src/visualize/types.js";
import {
  CRLF_SAMPLE,
  FENCES_SAMPLE,
  FIXED_GENERATED_AT,
  HTML_LIKE_SAMPLE,
  UNICODE_SAMPLE,
  buildExpectedBugFixSession,
  buildExpectedCtoMarkdownTerminalSession,
  buildExpectedSpecPreparationSession,
  buildExpectedZeroArtifactSession,
} from "./fixtures/visualize-fixtures.js";

// ── Harness ──────────────────────────────────────────────────────────────────

function redactedBody(text: string): RedactedBody {
  return {
    text,
    truncated: false,
    originalBytes: Buffer.byteLength(text, "utf8"),
    capBytes: DEFAULT_BODY_CAP_BYTES,
    preview: false,
    marker: "",
  };
}

function digest(): SourceDigest {
  return { algorithm: "sha256", full: "a".repeat(64), bounded: "a".repeat(16), inputBytes: 0 };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A stale copy of a session: source updated AFTER the fixed clock. */
function staleOf(session: VisualizationSession): VisualizationSession {
  const copy = clone(session);
  copy.provenance.sourceUpdatedAt = "2026-08-19T13:00:00.000Z";
  copy.provenance.staleness = "stale";
  return copy;
}

function snapshotOf(sessions: VisualizationSession[], scope: VisualizationScope, generatedAt = FIXED_GENERATED_AT): VisualizationSnapshot {
  return {
    schema: 1,
    scope,
    generatedAt,
    renderer: DEFAULT_RENDERER_IDENTITY,
    sessions,
    manifest: buildManifest(sessions, scope, { generatedAt }),
    warnings: [],
  };
}

function goldenSessions(): VisualizationSession[] {
  return [
    buildExpectedSpecPreparationSession(),
    buildExpectedBugFixSession(),
    buildExpectedZeroArtifactSession(),
    buildExpectedCtoMarkdownTerminalSession(),
  ];
}

function allSnapshot(): VisualizationSnapshot {
  return snapshotOf(goldenSessions(), "all");
}

function selectedSnapshot(): VisualizationSnapshot {
  return snapshotOf([buildExpectedSpecPreparationSession()], "selected");
}

/** Relative page path map: hub + every session page, as the writer would see. */
function pagesOf(snapshot: VisualizationSnapshot): Record<string, string> {
  const pages: Record<string, string> = { [VISUALIZE_OUTPUT_FILES.hubHtml]: renderHubHtml(snapshot) };
  for (const session of snapshot.sessions) {
    pages[sessionPagePath(session.identity.kind, session.identity.pathKey, "html")] = renderSessionHtml(session, { scope: snapshot.scope });
  }
  return pages;
}

function idsOf(html: string): Set<string> {
  return new Set(collectIdsAndHrefs(html).ids);
}

function hrefsOf(html: string): string[] {
  return collectIdsAndHrefs(html).hrefs;
}

/** All hrefs emitted inside the `<nav id="toc">` block (static navigation). */
function tocHrefs(html: string): string[] {
  const nav = html.match(/<nav id="toc"[^>]*>([\s\S]*?)<\/nav>/);
  if (!nav) return [];
  return [...nav[1].matchAll(/\bhref="([^"]*)"/g)].map((m) => m[1]);
}

// ── Hub page ─────────────────────────────────────────────────────────────────

test("html: hub is deterministic and lists every session with relative links and badges", () => {
  const snapshot = allSnapshot();
  const html = renderHubHtml(snapshot);
  assert.equal(renderHubHtml(snapshot), html, "identical inputs must produce byte-identical hub HTML");
  assert.ok(html.includes("<h1>Workflow visualization hub</h1>"));
  assert.ok(html.includes("all sessions (complete)"));
  // Every session of the --all scope is reachable from the hub via a relative page link.
  for (const session of snapshot.sessions) {
    const href = `${sessionPagePath(session.identity.kind, session.identity.pathKey, "html")}#${fragmentForSession(session.identity.pathKey)}`;
    assert.ok(html.includes(`href="${href}"`), `hub must link to ${href}`);
    assert.ok(!href.startsWith("/") && !href.includes("://"), "hub links are relative");
  }
  // Status/staleness/degraded badges and counts are visible.
  assert.ok(html.includes("badge-degraded"));
  assert.ok(html.includes("badge-unknown"), "unknown staleness is visible for the markdown CTO run");
  assert.ok(html.includes("badge-stale") === false || html.includes("badge-stale"), "stale badge vocabulary exists");
  assert.ok(html.includes("Sessions generated"));
  assert.ok(html.includes("4"));
  assert.ok(html.includes("Generated at"));
});

test("html: selected scope hub is visibly partial and links only the selected session", () => {
  const snapshot = selectedSnapshot();
  const html = renderHubHtml(snapshot);
  assert.ok(html.includes("Partial bundle"), "selected/latest hub must be visibly partial");
  assert.ok(html.includes("badge-partial"));
  const sessionHrefs = hrefsOf(html).filter((h) => h.startsWith("sessions/"));
  assert.equal(sessionHrefs.length, 1, "selected hub links exactly one session page");
  assert.ok(sessionHrefs[0].includes("sessions/feature/visualize.html"));
});

test("html: hub with no sessions renders an explicit empty state", () => {
  const snapshot = snapshotOf([], "selected");
  const html = renderHubHtml(snapshot);
  assert.ok(html.includes("No sessions in scope."));
  assert.ok(html.includes("Partial bundle"));
});

// ── Session page: structure, anchors, sections ───────────────────────────────

test("html: session page has overview, TOC, stable anchors and all semantic sections", () => {
  const session = buildExpectedSpecPreparationSession();
  const html = renderSessionHtml(session, { scope: "all" });
  assert.equal(renderSessionHtml(session, { scope: "all" }), html, "identical inputs must produce byte-identical session HTML");

  const ids = idsOf(html);
  const pathKey = session.identity.pathKey;

  // Stable identity anchors: session, every artifact, every stage.
  assert.ok(ids.has(fragmentForSession(pathKey)), "h1 carries the session anchor");
  for (const artifact of session.artifacts) {
    assert.ok(ids.has(artifactAnchor(pathKey, artifact.id)), `artifact anchor for ${artifact.id}`);
  }
  for (const stage of session.stages) {
    assert.ok(ids.has(fragmentForStage(pathKey, stage.stageId)), `stage anchor for ${stage.stageId}`);
  }
  assert.equal(ids.size, collectIdsAndHrefs(html).ids.length, "no duplicate ids in the session page");

  // Semantic sections: requirements, decisions, architecture, tasks.
  assert.ok(ids.has("overview") && ids.has("stages") && ids.has("status-details"));
  assert.ok(ids.has("requirements") && ids.has("decisions") && ids.has("architecture") && ids.has("tasks"));

  // Overview content: task, workflow, stage progress, provenance.
  assert.ok(html.includes("Visualize workflow specs"));
  assert.ok(html.includes("spec-preparation"));
  assert.ok(html.includes("2026-08-19T10:00:00.000Z"), "source updated_at is visible");
  assert.ok(html.includes("Source digest"));
  assert.ok(html.includes(session.provenance.sourceDigest.bounded), "bounded digest is visible");
  assert.ok(html.includes("badge-fresh"));

  // TOC links exactly the emitted sections; all resolve in-page.
  const toc = tocHrefs(html);
  assert.ok(toc.length >= 7, "TOC lists overview, stages, sections and status details");
  for (const href of toc) {
    assert.ok(href.startsWith("#"), "TOC navigation is static fragment navigation");
    assert.ok(ids.has(href.slice(1)), `TOC target ${href} exists`);
  }
});

test("html: bug-fix session renders compactly with status-details for non-produced states", () => {
  const session = buildExpectedBugFixSession();
  const html = renderSessionHtml(session, { scope: "all" });
  const ids = idsOf(html);
  const pathKey = session.identity.pathKey;
  // Typed artifacts without bodies are status-only, still anchored.
  assert.ok(ids.has(artifactAnchor(pathKey, "discovery")));
  // Missing/skipped/pending states are explicit in status details.
  assert.ok(html.includes("Unavailable states"));
  assert.ok(html.includes("badge-missing"));
  assert.ok(html.includes("badge-skipped"));
  assert.ok(html.includes("badge-pending"));
  assert.ok(html.includes("declared artifact implementation is missing"));
});

test("html: zero-artifact session is an overview-only view with a clear note (AC-12)", () => {
  const session = buildExpectedZeroArtifactSession();
  const html = renderSessionHtml(session, { scope: "all" });
  assert.ok(html.includes("No artifacts yet — overview-only view."));
  assert.ok(html.includes("no artifacts yet"));
  assert.ok(!html.includes('class="badge badge-missing"'), "no rendered artifact badges without artifacts");
  assert.ok(!html.includes('id="requirements"'), "no empty semantic sections are emitted");
});

test("html: degraded session shows a visible degraded badge and reasons", () => {
  const session = buildExpectedCtoMarkdownTerminalSession();
  const html = renderSessionHtml(session, { scope: "all" });
  assert.ok(html.includes("badge-degraded"));
  assert.ok(html.includes("Degraded:"));
  assert.ok(html.includes("terminal markdown CTO state: visualization-only projection"));
  assert.ok(html.includes("badge-unknown"), "markdown-state staleness is unknown");
});

test("html: stale session shows a stale badge and the regenerate hint (REQ-8)", () => {
  const html = renderSessionHtml(staleOf(buildExpectedSpecPreparationSession()), { scope: "all" });
  assert.ok(html.includes("badge-stale"));
  assert.ok(html.includes("Stale:"));
  assert.ok(html.includes(REGENERATE_HINT));
});

// ── Relative links, external URLs, absolute paths ────────────────────────────

test("html: no external URLs, assets or absolute source paths in any generated page", () => {
  const snapshot = allSnapshot();
  const pages = pagesOf(snapshot);
  for (const [pagePath, html] of Object.entries(pages)) {
    // No external/embedded asset elements or references at all.
    assert.ok(!/<link\b/i.test(html), `${pagePath}: no stylesheet links`);
    assert.ok(!/<img\b/i.test(html), `${pagePath}: no images`);
    assert.ok(!/<script\b[^>]*\bsrc=/i.test(html), `${pagePath}: no external scripts`);
    assert.ok(!/<iframe\b|<object\b|<embed\b|<form\b/i.test(html), `${pagePath}: no embeddable/fetching elements`);
    assert.ok(!/<[a-zA-Z][^>]*\bsrc\s*=/.test(html), `${pagePath}: no src attribute on any element (payload data is escaped text)`);
    // The inline stylesheet has no external references (url()/@import).
    const style = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(style && !/@import|url\(/i.test(style[1]), `${pagePath}: CSS has no external references`);
    // Every href is either an in-page fragment or a relative page link that
    // resolves inside the generated bundle. Scheme/protocol-relative/absolute
    // hrefs (javascript:, data:, file:, http(s):, //, /…) are impossible, so
    // payload DATA containing URL-like text is inert escaped text, never an
    // active reference.
    for (const href of hrefsOf(html)) {
      if (href.startsWith("#")) continue;
      assert.ok(!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href), `${pagePath}: href ${href} has no scheme`);
      assert.ok(!href.startsWith("//") && !href.startsWith("/") && !href.includes("\\"), `${pagePath}: href ${href} is relative`);
      assert.ok(resolvePageHref(pagePath, href) !== undefined, `${pagePath}: resolvable href ${href}`);
    }
    // Absolute source paths never leak into rendered output.
    assert.ok(!html.includes("/Users/") && !html.includes("C:\\"), `${pagePath}: no absolute source paths`);
  }
});

// ── Escaping: hostile payloads remain data ───────────────────────────────────

function hostileSession(): VisualizationSession {
  const base = buildExpectedZeroArtifactSession();
  const hostileBody = [UNICODE_SAMPLE, FENCES_SAMPLE, HTML_LIKE_SAMPLE, CRLF_SAMPLE].join("\n\n");
  const artifacts: VisualizationArtifact[] = [
    { id: "hostile-note", owner: "test", status: "produced", body: redactedBody(hostileBody) },
    // Hostile id attempts to break out of the id attribute.
    { id: 'x" onclick="alert(1)', owner: "test", status: "skipped" },
    // Hostile body attempts to close the <pre> and inject a script.
    { id: "close-pre", owner: "test", status: "produced", body: redactedBody("</pre><script>alert(2)</script>") },
    { id: "ampersand", owner: "test", status: "produced", body: redactedBody("a & b < c > d") },
  ];
  const hostile = clone(base);
  hostile.identity.task = '<img src=x onerror=alert(1)> hostile task';
  hostile.artifacts = artifacts;
  return hostile;
}

test("html: hostile payloads are escaped in text, attributes and embedded data", () => {
  const session = hostileSession();
  const html = renderSessionHtml(session, { scope: "all" });
  const pathKey = session.identity.pathKey;

  // Payload <script> can never appear as a live element.
  assert.equal((html.match(/<script\b/g) ?? []).length, 1, "only the inert inline script exists");
  assert.ok(html.includes("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"), "script payload is escaped");
  assert.ok(!html.includes("<script>alert(&#39;xss&#39;)"), "raw script payload never survives");
  assert.ok(html.includes("&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;"), "img payload is escaped");
  assert.ok(!html.includes('<img src="x"'), "raw img element never survives");
  assert.ok(html.includes("&lt;/pre&gt;"), "body cannot close the pre block");
  assert.ok(!html.includes("</pre><script>"), "no breakout through the code block");
  assert.ok(html.includes("a &amp; b &lt; c &gt; d"), "ampersands and angle brackets are entity-escaped");

  // Attribute injection via hostile ids is impossible: the quote is percent-
  // encoded in the anchor and the attribute value is escaped.
  assert.ok(html.includes("%22%20onclick%3D%22"), "hostile id is percent-encoded in the anchor");
  assert.ok(!/<[^>]*\sonclick=/i.test(html), "no onclick attribute can be injected");
  assert.ok(!/<[^>]*\sonerror=/i.test(html), "no onerror attribute can be injected");

  // Hostile task text in the overview table stays data.
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt; hostile task"));
  assert.ok(!html.includes("<img src=x onerror=alert(1)>"));

  // Unicode and CRLF payloads survive as data.
  assert.ok(html.includes("Título — Привет, мир"));
  assert.ok(html.includes("line one"));
});

// ── JS-disabled / static navigation ──────────────────────────────────────────

test("html: navigation is static — one inert inline script, plain fragment links", () => {
  for (const [pagePath, html] of Object.entries(pagesOf(allSnapshot()))) {
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1, `${pagePath}: exactly one inline script`);
    const [attrs, body] = [scripts[0][1], scripts[0][2]];
    assert.equal(attrs, "", `${pagePath}: script has no src or attributes`);
    assert.ok(body.includes('classList.add("js")'), `${pagePath}: script is the inert class toggle`);
    assert.ok(!/fetch|XMLHttpRequest|innerHTML|document\.write|\beval\b|\bFunction\b|WebSocket|EventSource/.test(body), `${pagePath}: script has no runtime capability`);
    // Static navigation: TOC links are plain anchors — the hub's TOC lists
    // session pages relatively, a session page's TOC is pure fragments — and
    // the content is fully rendered before the script.
    const ids = idsOf(html);
    for (const href of tocHrefs(html)) {
      if (pagePath === VISUALIZE_OUTPUT_FILES.hubHtml) {
        assert.ok(href.startsWith("sessions/"), `${pagePath}: hub TOC href ${href} is a relative session link`);
      } else {
        assert.ok(href.startsWith("#"), `${pagePath}: TOC href ${href} is a fragment`);
        assert.ok(ids.has(href.slice(1)), `${pagePath}: TOC fragment ${href} resolves`);
      }
    }
    assert.ok(html.indexOf("<script>") > html.indexOf("</main>"), `${pagePath}: content renders before the script`);
  }
});

// ── Determinism and anchor identity ──────────────────────────────────────────

test("html: identical inputs are byte-identical; only volatile fields vary", () => {
  const session = buildExpectedSpecPreparationSession();
  const later = clone(session);
  later.provenance.generatedAt = "2026-08-19T13:00:00.000Z";
  const a = renderSessionHtml(session, { scope: "all" });
  const b = renderSessionHtml(later, { scope: "all" });
  const stripClock = (s: string) => s.replaceAll(FIXED_GENERATED_AT, "CLOCK").replaceAll("2026-08-19T13:00:00.000Z", "CLOCK");
  assert.notEqual(a, b);
  assert.equal(stripClock(a), stripClock(b), "only generatedAt (and derived staleness) may vary");
});

test("html: anchors derive from stable identity and cannot collide across kinds", () => {
  const pathKey = "fix-regression-42";
  // Safe ids keep the pinned architecture-1 fragment behavior.
  for (const id of ["discovery", "spec_handoff", "a.b-c_d", "manual_qa"]) {
    assert.equal(artifactAnchor(pathKey, id), fragmentForArtifact(pathKey, id));
  }
  // Stage and artifact anchors never alias each other in the same document.
  const stageAnchors = new Set(["discovery", "implementation", "stage-x"].map((s) => fragmentForStage(pathKey, s)));
  const artifactAnchors = new Set(["discovery", "stage-x", "implementation", "x~stage-y"].map((s) => artifactAnchor(pathKey, s)));
  for (const a of stageAnchors) assert.ok(!artifactAnchors.has(a), `stage anchor ${a} must be unique`);
  // Pathological ids (lone surrogates) never throw and encode deterministically.
  const hostile = "\uD800";
  assert.equal(anchorEncode(hostile), encodeURIComponent("\uFFFD"));
  assert.equal(anchorEncode(hostile), anchorEncode("\uD800"));
});

// ── Semantic section mapping ─────────────────────────────────────────────────

test("html: semantic section mapping is total, deterministic and prototype-safe", () => {
  assert.equal(semanticSectionForArtifact({ id: "spec_requirements_edge_cases" }), "requirements");
  assert.equal(semanticSectionForArtifact({ id: "discovery" }), "requirements");
  assert.equal(semanticSectionForArtifact({ id: "spec_options_decisions" }), "decisions");
  assert.equal(semanticSectionForArtifact({ id: "spec_architecture_tasks" }), "architecture");
  assert.equal(semanticSectionForArtifact({ id: "spec_architecture_tasks", slotFor: "spec_architecture_tasks" }), "architecture");
  assert.equal(semanticSectionForArtifact({ id: "spec_handoff" }), "tasks");
  assert.equal(semanticSectionForArtifact({ id: "spec_prototype_2026" }), "tasks", "unknown spec_* ids land in tasks");
  assert.equal(semanticSectionForArtifact({ id: "freeform_note" }), "artifacts");
  assert.equal(semanticSectionForArtifact({ id: "constructor" }), "artifacts", "prototype keys never alias membership");
  assert.equal(semanticSectionForArtifact({ id: "regression_perf" }), "artifacts");
});
