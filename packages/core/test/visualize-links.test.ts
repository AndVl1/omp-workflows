/**
 * Visualize OPT-A — link graph, relative links and manifest determinism
 * tests (architecture-6).
 *
 * Defends the architecture-6 acceptance evidence:
 * - file://-compatible relative links: every href resolves inside the
 *   generated bundle (hub → session pages, session pages → hub), never to an
 *   absolute/external target;
 * - JS-free static navigation via fragment anchors;
 * - no external URLs/assets and no absolute source paths;
 * - mandatory deterministic manifest: identical inputs produce byte-identical
 *   manifests (only the volatile generatedAt may differ), safe session
 *   metadata + pathKeys + RELATIVE page paths only, no bodies/absolute paths;
 * - pruning metadata: `allGeneratedPages` is exactly the sorted relative
 *   allow-list the writer keeps (hub pair + manifest + every session page);
 * - link graph preflight: a fresh bundle (--all) has zero dead internal
 *   links and a crawl from the hub reaches every generated
 *   session/artifact/stage; selected scope is partial but also dead-link
 *   free, and the preflight detects dangling fragments, missing pages and
 *   external hrefs deterministically.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allGeneratedPages, buildManifest, preflightLinks, resolvePageHref } from "../src/visualize/manifest.js";
import { artifactAnchor, collectIdsAndHrefs, fragmentForStage, renderHubHtml, renderSessionHtml } from "../src/visualize/html.js";
import {
  DEFAULT_RENDERER_IDENTITY,
  REGENERATE_HINT,
  VISUALIZE_OUTPUT_FILES,
  compareSessions,
  fragmentForSession,
  isSafePathKey,
  sessionPagePath,
  type VisualizationManifest,
  type VisualizationScope,
  type VisualizationSession,
  type VisualizationSnapshot,
} from "../src/visualize/types.js";
import { buildSessionSnapshots } from "../src/visualize/snapshot.js";
import { resolveDoWorkSource } from "../src/report/session-source.js";
import { readWorkflowProfile, workflowV2Fixture } from "./workflow-v2-fixtures.js";
import {
  FIXED_GENERATED_AT,
  buildExpectedBugFixSession,
  buildExpectedCtoMarkdownTerminalSession,
  buildExpectedSpecPreparationSession,
  buildExpectedZeroArtifactSession,
  buildFixtureInventory,
  buildGoldenAllSnapshot,
  buildSelectedManifest,
  type CanonicalSessionInput,
} from "./fixtures/visualize-fixtures.js";
import { reportStorageFor } from "./report-storage-fixtures.js";

// ── Harness ──────────────────────────────────────────────────────────────────

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

function pagesOf(snapshot: VisualizationSnapshot): Record<string, string> {
  const pages: Record<string, string> = { [VISUALIZE_OUTPUT_FILES.hubHtml]: renderHubHtml(snapshot) };
  for (const session of snapshot.sessions) {
    pages[sessionPagePath(session.identity.kind, session.identity.pathKey, "html")] = renderSessionHtml(session, { scope: snapshot.scope });
  }
  return pages;
}

/** BFS crawl from an entry page over relative hrefs (fragments stay in-page). */
function crawl(pages: Record<string, string>, start: string): Set<string> {
  const reachable = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const page = queue.shift() as string;
    for (const href of collectIdsAndHrefs(pages[page]).hrefs) {
      if (href.startsWith("#")) continue;
      const target = resolvePageHref(page, href);
      if (target !== undefined && Object.hasOwn(pages, target) && !reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  return reachable;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** Materialize a feature fixture onto a temp workspace (state + artifacts). */
function materialize(cwd: string, input: CanonicalSessionInput): void {
  write(join(cwd, `.work-state/features/${input.id}/state.json`), input.state.content);
  for (const f of input.artifacts) write(join(cwd, f.relPath), f.content);
}

// ── Relative links: file:// compatibility ────────────────────────────────────

test("links: all generated hrefs are relative and resolve inside the bundle (file:// compatible)", () => {
  const snapshot = snapshotOf(goldenSessions(), "all");
  const pages = pagesOf(snapshot);
  const pagePaths = new Set(Object.keys(pages));

  for (const [pagePath, html] of Object.entries(pages)) {
    for (const href of collectIdsAndHrefs(html).hrefs) {
      if (href.startsWith("#")) continue;
      // Relative, no scheme, no protocol-relative, no leading slash, no backslashes.
      assert.ok(!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href), `${pagePath}: href ${href} has no scheme`);
      assert.ok(!href.startsWith("//") && !href.startsWith("/") && !href.includes("\\"), `${pagePath}: href ${href} is relative`);
      const target = resolvePageHref(pagePath, href);
      assert.ok(target !== undefined && pagePaths.has(target), `${pagePath}: href ${href} resolves to a generated page (${target ?? "none"})`);
    }
  }

  // Hub links use the canonical session page paths with stable anchors.
  const hub = pages[VISUALIZE_OUTPUT_FILES.hubHtml];
  for (const session of snapshot.sessions) {
    assert.ok(
      hub.includes(`href="${sessionPagePath(session.identity.kind, session.identity.pathKey, "html")}#${fragmentForSession(session.identity.pathKey)}"`),
      `hub links ${session.identity.pathKey} via its page path and session anchor`,
    );
  }
  // Session pages link back to the hub with a two-level relative path.
  for (const session of snapshot.sessions) {
    const page = pages[sessionPagePath(session.identity.kind, session.identity.pathKey, "html")];
    assert.ok(page.includes('href="../../index.html"'));
    assert.equal(resolvePageHref(sessionPagePath(session.identity.kind, session.identity.pathKey, "html"), "../../index.html"), "index.html");
  }
});

test("links: resolvePageHref normalizes relative paths deterministically", () => {
  assert.equal(resolvePageHref("index.html", "sessions/feature/a.html"), "sessions/feature/a.html");
  assert.equal(resolvePageHref("index.html", "sessions/feature/a.html#viz-a"), "sessions/feature/a.html");
  assert.equal(resolvePageHref("sessions/feature/a.html", "../../index.html"), "index.html");
  assert.equal(resolvePageHref("sessions/feature/a.html", "./x.html"), "sessions/feature/x.html");
  assert.equal(resolvePageHref("index.html", "#viz-a"), undefined);
  assert.equal(resolvePageHref("index.html", "https://example.com/x.html"), undefined);
  assert.equal(resolvePageHref("index.html", "//cdn.example/x.js"), undefined);
  assert.equal(resolvePageHref("index.html", "/etc/passwd"), undefined);
  assert.equal(resolvePageHref("index.html", "sessions\\feature\\a.html"), undefined);
  assert.equal(resolvePageHref("index.html", "../outside.html"), "outside.html", "escaping hrefs normalize outside the bundle (dead, never external)");
});

// ── Manifest determinism and content contract ────────────────────────────────

test("links: manifest is deterministic and matches the golden contract (--all and selected)", () => {
  const golden = buildGoldenAllSnapshot();
  const built = buildManifest(golden.sessions, "all", { generatedAt: FIXED_GENERATED_AT });
  assert.deepEqual(built, golden.manifest, "buildManifest reproduces the frozen golden manifest");
  assert.deepEqual(buildManifest(golden.sessions, "all", { generatedAt: FIXED_GENERATED_AT }), built, "identical inputs are byte-identical");

  const selected = buildManifest([buildExpectedSpecPreparationSession()], "selected", { generatedAt: FIXED_GENERATED_AT });
  assert.deepEqual(selected, buildSelectedManifest(), "selected manifest matches the golden selected manifest");
});

test("links: only the volatile generatedAt may vary across identical-input runs", () => {
  const sessions = goldenSessions();
  const t1 = buildManifest(sessions, "all", { generatedAt: FIXED_GENERATED_AT });
  const t2 = buildManifest(sessions, "all", { generatedAt: "2026-08-19T13:00:00.000Z" });
  const stripClock = (m: VisualizationManifest) => JSON.stringify(m).replaceAll(FIXED_GENERATED_AT, "CLOCK").replaceAll("2026-08-19T13:00:00.000Z", "CLOCK");
  assert.notEqual(JSON.stringify(t1), JSON.stringify(t2));
  assert.equal(stripClock(t1), stripClock(t2), "generatedAt is the only allowed delta");
});

test("links: manifest carries safe metadata, pathKeys and relative paths only (no bodies/absolute paths)", () => {
  const manifest = buildManifest(goldenSessions(), "all", { generatedAt: FIXED_GENERATED_AT });
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.scope, "all");
  assert.deepEqual(manifest.renderer, DEFAULT_RENDERER_IDENTITY);

  const allowedEntryKeys = new Set([
    "kind",
    "id",
    "pathKey",
    "title",
    "task",
    "workflow",
    "updatedAt",
    "sourceDigestBounded",
    "status",
    "staleness",
    "artifacts",
    "pages",
    "regenerateHint",
  ]);
  const allowedArtifactCountKeys = new Set(["produced", "missing", "pending", "skipped", "unreadable"]);

  const pathKeys = new Set<string>();
  for (const entry of manifest.sessions) {
    for (const key of Object.keys(entry)) assert.ok(allowedEntryKeys.has(key), `unexpected manifest entry key ${key}`);
    assert.ok(isSafePathKey(entry.pathKey), `pathKey ${entry.pathKey} is safe`);
    assert.ok(!pathKeys.has(entry.pathKey), "pathKeys are unique");
    pathKeys.add(entry.pathKey);
    assert.ok(/^[0-9a-f]{16}$/.test(entry.sourceDigestBounded), "bounded digest is 16 lowercase hex chars");
    for (const key of Object.keys(entry.artifacts)) assert.ok(allowedArtifactCountKeys.has(key), `unexpected artifact count key ${key}`);
    assert.equal(
      Object.values(entry.artifacts).reduce((n, c) => n + c, 0),
      entry.artifacts.produced + entry.artifacts.missing + entry.artifacts.pending + entry.artifacts.skipped + entry.artifacts.unreadable,
    );
    assert.ok(entry.pages.length === 2, "session pages are the md + html pair");
    for (const page of entry.pages) {
      assert.match(page, /^sessions\/[a-z]+\/[A-Za-z0-9._-]+\.(md|html)$/, `page ${page} is relative and namespaced`);
    }
    if (entry.staleness !== "stale") assert.ok(entry.regenerateHint === undefined, "regenerate hint only for stale entries");
  }

  // No bodies, source descriptors, mtime or absolute paths anywhere in the manifest.
  assertNoForbiddenKeys(manifest, new Set(["body", "text", "source", "mtime", "bytes", "readBytes", "label"]));
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes("/Users/") && !serialized.includes("C:\\"), "no absolute paths");
});

test("links: stale manifest entries carry the regenerate hint and staleness counts (REQ-8)", () => {
  const stale = clone(buildExpectedSpecPreparationSession());
  stale.provenance.sourceUpdatedAt = "2026-08-19T13:00:00.000Z";
  stale.provenance.staleness = "stale";
  const manifest = buildManifest([stale], "selected", { generatedAt: FIXED_GENERATED_AT });
  assert.equal(manifest.counts.staleSessions, 1);
  assert.equal(manifest.sessions[0].staleness, "stale");
  assert.equal(manifest.sessions[0].regenerateHint, REGENERATE_HINT);
});

test("links: manifest counts honor explicit discovered/generated/pages/dead-links metadata", () => {
  const sessions = goldenSessions();
  const manifest = buildManifest(sessions, "all", {
    generatedAt: FIXED_GENERATED_AT,
    discoveredSessions: 6,
    generatedPages: 13,
    deadLinks: 2,
  });
  assert.equal(manifest.counts.discoveredSessions, 6);
  assert.equal(manifest.counts.generatedSessions, sessions.length);
  assert.equal(manifest.counts.generatedPages, 13);
  assert.equal(manifest.counts.deadLinks, 2);
  assert.equal(manifest.counts.staleSessions, 0);
  assert.equal(manifest.counts.degradedSessions, 1);
  assert.equal(manifest.counts.artifactTotal, 16);
});

// ── Pruning metadata ─────────────────────────────────────────────────────────

test("links: pruning metadata lists exactly the generated relative pages", () => {
  const manifest = buildManifest(goldenSessions(), "all", { generatedAt: FIXED_GENERATED_AT });
  const pages = allGeneratedPages(manifest);
  assert.equal(pages.length, 2 + 2 * manifest.sessions.length + 1, "hub pair + session md+html pair + manifest");
  const expected = [
    VISUALIZE_OUTPUT_FILES.hubMarkdown,
    VISUALIZE_OUTPUT_FILES.hubHtml,
    VISUALIZE_OUTPUT_FILES.manifest,
    ...manifest.sessions.flatMap((s) => s.pages),
  ].sort();
  assert.deepEqual(pages, expected, "sorted, deduplicated, complete");
  assert.equal(new Set(pages).size, pages.length, "no duplicates");
  for (const page of pages) {
    assert.ok(!page.startsWith("/") && !page.includes("..") && !page.includes(":") && !page.includes("\\"), `page ${page} is a safe relative path`);
  }
  // The HTML hub only references .html pages that the pruning allow-list keeps.
  const hub = renderHubHtml(snapshotOf(goldenSessions(), "all"));
  for (const href of collectIdsAndHrefs(hub).hrefs.filter((h) => !h.startsWith("#"))) {
    const target = resolvePageHref(VISUALIZE_OUTPUT_FILES.hubHtml, href);
    assert.ok(target !== undefined && pages.includes(target), `hub href ${href} resolves into the generated page set (${target ?? "none"})`);
  }
});

// ── Link graph preflight and crawler ─────────────────────────────────────────

test("links: --all fresh bundle has zero dead internal links and the crawl reaches everything", () => {
  const snapshot = snapshotOf(goldenSessions(), "all");
  const pages = pagesOf(snapshot);
  const result = preflightLinks(pages);
  assert.equal(result.deadLinks.length, 0, `dead links: ${JSON.stringify(result.deadLinks)}`);
  const totalHrefs = Object.values(pages).reduce((n, html) => n + collectIdsAndHrefs(html).hrefs.length, 0);
  assert.equal(result.checked, totalHrefs, "every emitted href was checked");

  // Crawler: hub reaches every generated page.
  const reachable = crawl(pages, VISUALIZE_OUTPUT_FILES.hubHtml);
  assert.deepEqual([...reachable].sort(), Object.keys(pages).sort(), "every generated page is reachable from the hub");

  // Crawler: every artifact and stage anchor exists and is linked in-page.
  for (const session of snapshot.sessions) {
    const pagePath = sessionPagePath(session.identity.kind, session.identity.pathKey, "html");
    const html = pages[pagePath];
    const ids = new Set(collectIdsAndHrefs(html).ids);
    const hrefs = new Set(collectIdsAndHrefs(html).hrefs);
    for (const artifact of session.artifacts) {
      const anchor = artifactAnchor(session.identity.pathKey, artifact.id);
      assert.ok(ids.has(anchor), `${pagePath}: artifact anchor ${anchor}`);
      assert.ok(hrefs.has(`#${anchor}`), `${pagePath}: artifact anchor ${anchor} is linked`);
    }
    for (const stage of session.stages) {
      const anchor = fragmentForStage(session.identity.pathKey, stage.stageId);
      assert.ok(ids.has(anchor), `${pagePath}: stage anchor ${anchor}`);
      assert.ok(hrefs.has(`#${anchor}`), `${pagePath}: stage anchor ${anchor} is linked`);
    }
  }
});

test("links: selected scope is partial (fewer pages) yet dead-link free", () => {
  const snapshot = snapshotOf([buildExpectedSpecPreparationSession()], "selected");
  const pages = pagesOf(snapshot);
  assert.equal(Object.keys(pages).length, 2, "hub + one selected session page");
  const result = preflightLinks(pages);
  assert.equal(result.deadLinks.length, 0, "selected bundle has no dead links");
  const hub = pages[VISUALIZE_OUTPUT_FILES.hubHtml];
  assert.ok(hub.includes("Partial bundle"));
  const sessionHrefs = collectIdsAndHrefs(hub).hrefs.filter((h) => h.startsWith("sessions/"));
  assert.equal(sessionHrefs.length, 1, "selected hub links only the selected session");
  assert.ok(!hub.includes("fix-regression-42"), "non-selected sessions are absent (partial)");
});

test("links: preflight detects dangling fragments, missing pages and external hrefs deterministically", () => {
  const snapshot = snapshotOf(goldenSessions(), "all");
  const pages = pagesOf(snapshot);
  const session = snapshot.sessions[0];
  const pagePath = sessionPagePath(session.identity.kind, session.identity.pathKey, "html");
  const tampered = pages[pagePath].replace("</main>", `<a href="#no-such-anchor">dangling</a>\n<a href="sessions/feature/ghost.html">missing</a>\n<a href="https://example.com/x">external</a>\n</main>`);
  pages[pagePath] = tampered;

  const result = preflightLinks(pages);
  assert.equal(result.deadLinks.length, 3);
  assert.deepEqual(
    result.deadLinks.map((l) => l.label),
    ["#no-such-anchor", "sessions/feature/ghost.html", "https://example.com/x"],
    "dead links are deterministic in document order",
  );
  for (const link of result.deadLinks) {
    assert.equal(link.state, "unavailable");
    assert.equal(link.from.sessionPathKey, pagePath);
    assert.equal(link.id, `${pagePath}#${link.label}`);
  }
  assert.ok(result.deadLinks.some((l) => l.kind === "section"), "fragment dead link is classified as a section");
  assert.ok(result.deadLinks.some((l) => l.kind === "session"), "missing page dead link is classified as a session link");
});

test("links: preflight rejects hrefs that escape the bundle", () => {
  const pages: Record<string, string> = {
    "index.html": '<div id="ok">target</div><a href="../outside.html">escape</a><a href="../../etc/passwd">deeper</a><a href="#ok">fine</a>',
  };
  const result = preflightLinks(pages);
  assert.equal(result.deadLinks.length, 2, "escaping hrefs normalize outside the page set and are dead");
  assert.equal(result.checked, 3);
});

// ── End-to-end: real snapshot pipeline (fs) ──────────────────────────────────

test("links: real canonical inputs → snapshots → manifest → pages → zero-dead preflight", () => {
  const cwd = mkdtempSync(join(tmpdir(), "viz-links-"));
  try {
    const inventory = buildFixtureInventory();
    const spec = inventory.cases.find((c) => c.id === "feature-spec-preparation");
    const bugfix = inventory.cases.find((c) => c.id === "feature-bug-fix");
    if (!spec || !bugfix) throw new Error("missing fixture cases");

    materialize(cwd, spec.input);
    materialize(cwd, bugfix.input);
    const specProfile = readWorkflowProfile("spec-preparation");
    const bugfixProfile = readWorkflowProfile("bug-fix");
    // Each canonical state was built with its workflow's single-profile catalog.
    // Keep the admitted context on that exact catalog so identity validation
    // does not degrade the snapshot before ordering is asserted.
    const specFixture = workflowV2Fixture(specProfile);
    const bugfixFixture = workflowV2Fixture(bugfixProfile);
    const storage = reportStorageFor(cwd);
    const specEntry = resolveDoWorkSource(storage, spec.input.id);
    const bugfixEntry = resolveDoWorkSource(storage, bugfix.input.id);
    if (!specEntry || !bugfixEntry) throw new Error("missing fixture sources");

    const specSessions = buildSessionSnapshots(storage, [specEntry], FIXED_GENERATED_AT, {
      context: {
        project_identity: specFixture.project_identity,
        catalog: specFixture.catalog,
        effective_policy: specFixture.effective_policy,
      },
    });
    const bugfixSessions = buildSessionSnapshots(storage, [bugfixEntry], FIXED_GENERATED_AT, {
      context: {
        project_identity: bugfixFixture.project_identity,
        catalog: bugfixFixture.catalog,
        effective_policy: bugfixFixture.effective_policy,
      },
    });
    const sessions = [...specSessions, ...bugfixSessions].sort((a, b) =>
      compareSessions(
        { updatedAt: a.provenance.sourceUpdatedAt, kind: a.identity.kind, id: a.identity.id },
        { updatedAt: b.provenance.sourceUpdatedAt, kind: b.identity.kind, id: b.identity.id },
      ),
    );
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].identity.id, "visualize", "deterministic session order (updated_at desc)");

    const snapshot = snapshotOf(sessions, "all");
    assert.equal(snapshot.manifest.counts.generatedSessions, 2);
    assert.equal(snapshot.manifest.counts.degradedSessions, 0);

    const pages = pagesOf(snapshot);
    const result = preflightLinks(pages);
    assert.equal(result.deadLinks.length, 0, `real-snapshot bundle has no dead links: ${JSON.stringify(result.deadLinks)}`);
    assert.equal(Object.keys(pages).length, 3, "hub + two session pages");
    assert.equal(crawl(pages, VISUALIZE_OUTPUT_FILES.hubHtml).size, 3, "crawl reaches hub + both sessions");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Helper ───────────────────────────────────────────────────────────────────

/** Recursively assert that no forbidden key exists anywhere in a value. */
function assertNoForbiddenKeys(value: unknown, forbidden: Set<string>, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoForbiddenKeys(item, forbidden, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assert.ok(!forbidden.has(key), `forbidden key ${key} at ${path}.${key}`);
      assertNoForbiddenKeys(child, forbidden, `${path}.${key}`);
    }
  }
}
