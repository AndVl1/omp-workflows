/**
 * Visualize OPT-A — deterministic Markdown serializers (architecture-5) tests.
 *
 * Golden tests over the architecture-1 fixture inventory plus the hand-built
 * golden models: spec-preparation detailed, bug-fix compact, unlisted safe
 * default, legacy/CTO (JSON + markdown-state degraded), slots/mid-consilium,
 * missing/pending/skipped/unreadable/empty, hostile content (Unicode, fences,
 * HTML-like, CRLF, deep/large) and hub scope statements (selected partial vs
 * --all complete).
 *
 * Proves: byte determinism for a fixed clock (volatile fields only),
 * structure safety (payload text can never open/close fences or inject raw
 * HTML — the only raw tags are serializer-generated anchors), stable
 * id-based anchors, visible statuses/warnings/staleness/regenerate hints,
 * no absolute paths or secrets in rendered output, and link preflight over
 * the frozen link graph with zero dead targets (AC-5) — a corrupted or
 * foreign target is caught.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HUB_ANCHOR,
  buildLinkGraph,
  buildLinkRegistry,
  checkLinkGraph,
  preflightLinks,
  renderHubMarkdown,
  renderSessionMarkdown,
  sectionAnchorOf,
} from "../src/visualize/markdown.js";
import { buildSessionSnapshot } from "../src/visualize/snapshot.js";
import {
  listCtoSources,
  resolveCtoSource,
  resolveDoWorkSource,
  type SessionSourceEntry,
} from "../src/report/session-source.js";
import {
  DEFAULT_RENDERER_IDENTITY,
  REGENERATE_HINT,
  fragmentForArtifact,
  sessionPagePath,
  type LinkGraph,
  type VisualizationArtifact,
  type VisualizationManifest,
  type VisualizationScope,
  type VisualizationSession,
  type VisualizationSnapshot,
} from "../src/visualize/types.js";
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

// ── Harness: materialize a canonical input onto a temp workspace ─────────────

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "viz-markdown-"));
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function stateRelPath(input: CanonicalSessionInput): string {
  if (input.kind === "feature") return `.work-state/features/${input.id}/state.json`;
  if (input.kind === "legacy") return ".work-state/team-state.json";
  return `.work-state/cto/${input.id}/state.json`;
}

function materialize(cwd: string, input: CanonicalSessionInput, extraFiles: Record<string, string> = {}): void {
  if (input.kind === "cto") {
    const runDir = join(cwd, ".work-state", "cto", input.id);
    if (input.state.format === "markdown") {
      for (const [name, content] of Object.entries(extraFiles)) write(join(runDir, name), content);
    } else {
      write(join(runDir, "state.json"), input.state.content);
    }
  } else {
    write(join(cwd, stateRelPath(input)), input.state.content);
  }
  for (const f of input.artifacts) write(join(cwd, f.relPath), f.content);
}

function entryOf(cwd: string, input: CanonicalSessionInput): SessionSourceEntry {
  if (input.kind === "cto") {
    if (input.state.format === "markdown" && input.state.content.includes("# Summary")) {
      const entry = listCtoSources(cwd).find((e) => e.id === input.id);
      if (!entry) throw new Error(`terminal markdown run not discovered: ${input.id}`);
      return entry;
    }
    const resolved = resolveCtoSource(cwd, input.id);
    if (!resolved) throw new Error(`cto run not resolved: ${input.id}`);
    return resolved;
  }
  const resolved = resolveDoWorkSource(cwd, input.id);
  if (!resolved) throw new Error(`do-work session not resolved: ${input.id}`);
  return resolved;
}

function sessionOf(cwd: string, input: CanonicalSessionInput, full = false): VisualizationSession {
  return buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT, full ? { full: true } : {});
}

function caseInput(id: string): CanonicalSessionInput {
  const found = buildFixtureInventory().cases.find((c) => c.id === id);
  if (!found) throw new Error(`missing fixture case: ${id}`);
  return found.input;
}

/** Build a deterministic manifest for a hand-assembled snapshot (hub tests). */
function manifestFor(sessions: VisualizationSession[], scope: VisualizationScope): VisualizationManifest {
  const entries = sessions.map((s) => {
    const counts = { produced: 0, missing: 0, pending: 0, skipped: 0, unreadable: 0 };
    for (const a of s.artifacts) counts[a.status] += 1;
    const stale = s.provenance.staleness === "stale";
    return {
      kind: s.identity.kind,
      id: s.identity.id,
      pathKey: s.identity.pathKey,
      title: s.identity.title,
      task: s.identity.task,
      workflow: s.identity.workflow,
      ...(s.provenance.sourceUpdatedAt ? { updatedAt: s.provenance.sourceUpdatedAt } : {}),
      sourceDigestBounded: s.provenance.sourceDigest.bounded,
      status: s.status,
      staleness: s.provenance.staleness,
      artifacts: counts,
      pages: [sessionPagePath(s.identity.kind, s.identity.pathKey, "md"), sessionPagePath(s.identity.kind, s.identity.pathKey, "html")],
      ...(stale ? { regenerateHint: REGENERATE_HINT } : {}),
    };
  });
  return {
    schema: 1,
    scope,
    generatedAt: FIXED_GENERATED_AT,
    renderer: DEFAULT_RENDERER_IDENTITY,
    sessions: entries,
    counts: {
      discoveredSessions: sessions.length,
      generatedSessions: sessions.length,
      generatedPages: sessions.length * 2 + 2,
      staleSessions: entries.filter((e) => e.staleness === "stale").length,
      degradedSessions: sessions.filter((s) => s.status === "degraded").length,
      artifactTotal: sessions.reduce((n, s) => n + s.artifacts.length, 0),
      deadLinks: 0,
    },
  };
}

function snapshotFor(sessions: VisualizationSession[], scope: VisualizationScope): VisualizationSnapshot {
  return {
    schema: 1,
    scope,
    generatedAt: FIXED_GENERATED_AT,
    renderer: DEFAULT_RENDERER_IDENTITY,
    sessions,
    manifest: manifestFor(sessions, scope),
    warnings: [],
  };
}

// ── Structure-safety helpers ─────────────────────────────────────────────────

/**
 * Escapes the same ASCII punctuation set as the serializer's `mdInline`
 * (test double): identity-derived values are rendered through it, so golden
 * labels must expect the backslash-escaped form.
 */
function mdEscape(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|<>~=&-]/g, "\\$&");
}

/**
 * Prove payload text cannot break fenced blocks: every fence opens, and the
 * first subsequent line equal to it closes the block. The serializer picks
 * fence lengths strictly longer than any backtick run in the text, so a
 * payload can never contain a line equal to its own fence.
 */
function assertFencesClosed(md: string): void {
  const lines = md.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!/^`{3,}$/.test(line)) continue;
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j += 1) {
      if ((lines[j] ?? "") === line) {
        closed = true;
        break;
      }
    }
    assert.ok(closed, `unclosed code fence at line ${i}`);
    i = j;
  }
}

/** The only raw HTML allowed in output are serializer-generated anchors. */
function assertOnlyAnchorTags(md: string): void {
  const tags = md.match(/(?<!\\)<\/?[a-zA-Z][^>]*>/g) ?? [];
  const open = tags.filter((t) => t.startsWith("<a "));
  const close = tags.filter((t) => t === "</a>");
  for (const tag of tags) {
    assert.ok(tag === "</a>" || /^<a id="viz-[A-Za-z0-9._@%-]+">$/.test(tag), `unexpected raw HTML tag: ${tag}`);
  }
  assert.equal(open.length, close.length, "every anchor opens and closes");
}

/** Every `](#…)` href in a session page must resolve in the frozen registry. */
function assertPageHrefsResolve(session: VisualizationSession, md: string, snapshot: VisualizationSnapshot): void {
  const registry = buildLinkRegistry(snapshot);
  const reg = registry.sessions.get(session.identity.pathKey);
  assert.ok(reg, "session present in registry");
  const hrefs = [...md.matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => m[1] ?? "");
  assert.ok(hrefs.length > 0, "page emits links");
  for (const href of hrefs) assert.ok(reg.anchors.has(href), `dead href #${href}`);
  const graph = buildLinkGraph(snapshot);
  const pageLinks = graph.links.filter((l) => l.from.sessionPathKey === session.identity.pathKey);
  assert.equal(hrefs.length, pageLinks.length, "every emitted link is in the frozen graph and vice versa");
}

// ── Golden: spec-preparation detailed ────────────────────────────────────────

test("markdown: spec-preparation detailed session page — structure, anchors, statuses, determinism", () => {
  const session = buildExpectedSpecPreparationSession();
  const md = renderSessionMarkdown(session);
  assertFencesClosed(md);
  assertOnlyAnchorTags(md);

  // Determinism: identical model → byte-identical output.
  assert.equal(md, renderSessionMarkdown(session));

  // Front matter (YAML, JSON-escaped values, volatile fields only).
  assert.ok(md.startsWith("---\n"), "front matter opens the document");
  assert.match(md, /^path_key: "visualize"$/m);
  assert.match(md, /^workflow: "spec-preparation"$/m);
  assert.match(md, /^status: "complete"$/m);
  assert.match(md, /^generated_at: "2026-08-19T12:00:00\.000Z"$/m);
  assert.match(md, /^source_digest: "([0-9a-f]{16})"$/m);
  assert.doesNotMatch(md, /mtime/i, "mtime never appears in rendered output");

  // Title + overview identity/task.
  assert.ok(md.includes("# visualize feature worktree"));
  assert.ok(md.includes("## Overview"));
  assert.ok(md.includes("- **Task:** Visualize workflow specs: readable overview"), "task visible (markup-escaped)");
  assert.ok(md.includes("- **Session:** feature / visualize — visualize feature worktree"));
  assert.ok(md.includes("detailed; bodies enabled by default"), "depth policy classification visible");

  // Session anchor + every artifact anchor (stable id-based, not ordinal).
  assert.ok(md.includes('<a id="viz-visualize"></a>'));
  for (const artifact of session.artifacts) {
    assert.ok(md.includes(`<a id="${fragmentForArtifact("visualize", artifact.id)}"></a>`), `anchor for ${artifact.id}`);
  }

  // Stage progress with statuses and owned-artifact links.
  assert.ok(md.includes("### Workflow and stage progress"));
  for (const stage of session.stages) {
    assert.ok(md.includes(`- **${stage.status}** ${mdEscape(stage.stageId)} — ${stage.title ?? stage.stageId}`), `stage ${stage.stageId}`);
  }
  assert.ok(md.includes("  - [spec\\_intake\\_repo\\_map\\-analyst](#viz-visualize-spec_intake_repo_map-analyst)"), "slot linked from its stage (id escaped in the label)");

  // Semantic sections reachable from the overview with stable anchors.
  assert.ok(md.includes("### Sections"));
  assert.ok(md.includes("[Requirements](#viz-visualize@requirements)"));
  assert.ok(md.includes("[Decisions and options](#viz-visualize@decisions)"));
  assert.ok(md.includes("[Architecture](#viz-visualize@architecture)"));
  assert.ok(md.includes("[Tasks](#viz-visualize@tasks)"));
  assert.ok(md.includes("[Artifacts](#viz-visualize@artifacts)"));
  assert.ok(md.includes("[Status details](#viz-visualize@status-details)"));
  assert.ok(md.includes('<a id="viz-visualize@requirements"></a>'));
  assert.ok(md.includes('<a id="viz-visualize@status-details"></a>'));
  assert.ok(md.includes("## Requirements"));
  assert.ok(md.includes("## Decisions and options"));
  assert.ok(md.includes("## Architecture"));
  assert.ok(md.includes("## Tasks"));

  // Semantic section content links into the artifact anchors.
  assert.ok(md.includes("- [spec\\_requirements\\_edge\\_cases](#viz-visualize-spec_requirements_edge_cases) — produced"));
  assert.ok(md.includes("- [spec\\_options\\_decisions](#viz-visualize-spec_options_decisions) — produced"));

  // Slot artifacts render with their own anchors (slot suffixes are covered
  // by the fs-built mid-consilium test, where the model carries slotFor).
  assert.ok(md.includes("- [spec\\_intake\\_repo\\_map\\-analyst](#viz-visualize-spec_intake_repo_map-analyst) — produced"));
  assert.ok(md.includes("### spec\\_intake\\_repo\\_map\\-analyst"), "slot artifact heading (escaped, data intact)");

  // Missing artifact: status-only block, explicit status, no source.
  assert.ok(md.includes("### spec\\_completeness"), "missing artifact status-only heading");
  assert.ok(md.includes("- [spec\\_completeness](#viz-visualize-spec_completeness) — missing"));
  assert.match(md, /spec\\_completeness.*— missing — owner completeness\\_gate/s);

  // Provenance + stale/regenerate absence (fresh).
  assert.ok(md.includes("### Provenance"));
  assert.ok(md.includes("- **Staleness:** fresh"));
  assert.ok(md.includes(`- **Source:** \\.work\\-state/features/visualize/state\\.json (json, ${session.source.bytes} bytes)`));
  assert.ok(md.includes(`- **Source digest:** ${session.provenance.sourceDigest.bounded}`));
  assert.ok(md.includes(`- **Renderer:** omp\\-workflows\\-visualize 1\\.0\\.0`));
  assert.ok(!md.includes("regenerate stale output"), "fresh session carries no regenerate hint");

  // Oversized preview marker stays visible; statuses table; warnings.
  assert.match(md, /truncated \d+\/16384 bytes/);
  assert.ok(md.includes("## Status details"));
  assert.ok(md.includes("- **Session status:** complete"));
  assert.ok(md.includes("## Warnings"));
  assert.ok(md.includes("- declared artifact spec\\_completeness is missing"));
  assert.ok(md.includes("- artifact spec\\_handoff is larger than the read window"), "oversized preview warning");
  assert.ok(md.includes("original bytes"), "warning body present (escaped)");

  // Link preflight: zero dead targets and the emitted set equals the graph.
  const snapshot = snapshotFor([session], "all");
  assertPageHrefsResolve(session, md, snapshot);
  const result = preflightLinks(snapshot);
  assert.equal(result.checked, buildLinkGraph(snapshot).links.length);
  assert.deepEqual(result.deadLinks, []);
});

// ── Golden: bug-fix compact ──────────────────────────────────────────────────

test("markdown: bug-fix compact session page — status-only artifacts, no bodies, safe default depth", () => {
  const session = buildExpectedBugFixSession();
  const md = renderSessionMarkdown(session);
  assertFencesClosed(md);
  assertOnlyAnchorTags(md);

  assert.ok(md.includes("# bug\\-fix feature worktree"), "title is the stable identity title (hyphen escaped)");
  assert.ok(md.includes("compact; bodies disabled by default"), "compact policy classification visible");
  assert.doesNotMatch(md, /```/, "compact policy embeds no bodies → no code fences");

  // Status-only views: heading, status, parse-derived summary + keys.
  assert.ok(md.includes("### discovery"));
  assert.ok(md.includes("- **status:** produced"));
  assert.ok(md.includes("Summary of discovery"), "parse-derived summary paragraph");

  // Only the Tasks semantic section is present (implementation artifact).
  assert.ok(md.includes("## Tasks"));
  assert.ok(md.includes("- [implementation](#viz-fix-regression-42-implementation) — missing"));
  assert.ok(!md.includes("## Requirements"));
  assert.ok(!md.includes("## Decisions and options"));
  assert.ok(!md.includes("## Architecture"));

  // missing / skipped / pending are explicit statuses, not silent gaps.
  for (const [id, status] of [
    ["discovery", "produced"],
    ["diagnosis", "produced"],
    ["dod", "produced"],
    ["implementation", "missing"],
    ["review", "skipped"],
    ["manual_qa", "pending"],
    ["summary", "pending"],
  ] as const) {
    assert.ok(md.includes(`- [${mdEscape(id)}](#viz-fix-regression-42-${id}) — ${status}`), `${id} shows ${status}`);
  }
  assert.ok(md.includes("- declared artifact implementation is missing"));

  const snapshot = snapshotFor([session], "all");
  assertPageHrefsResolve(session, md, snapshot);
  assert.deepEqual(preflightLinks(snapshot).deadLinks, []);
});

// ── Golden: unlisted workflow (safe default) ─────────────────────────────────

test("markdown: unlisted workflow gets the explicit safe default and generic fallbacks render", () => {
  const cwd = tmpWorkspace();
  try {
    const input = caseInput("feature-unlisted");
    materialize(cwd, input);
    const session = sessionOf(cwd, input);
    const md = renderSessionMarkdown(session);
    assertFencesClosed(md);
    assertOnlyAnchorTags(md);

    assert.ok(md.includes("safe default; bodies disabled"), "unlisted workflow → explicit safe default");
    // Freeform, regression and unknown spec_* ids all render (generic layer).
    assert.ok(md.includes("### freeform\\_note"));
    assert.ok(md.includes("### regression\\_perf"));
    assert.ok(md.includes("### spec\\_prototype\\_2026"));
    assert.ok(md.includes("#### Fields"), "status-only produced artifacts list top-level keys");
    assert.ok(md.includes("- note"), "freeform key listed");
    assert.ok(md.includes("- run"), "regression key listed");

    const snapshot = snapshotFor([session], "all");
    assertPageHrefsResolve(session, md, snapshot);
    assert.deepEqual(preflightLinks(snapshot).deadLinks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Golden: legacy root (stale + regenerate hint) ────────────────────────────

test("markdown: legacy root session is stale with a visible regenerate hint", () => {
  const cwd = tmpWorkspace();
  try {
    const input = caseInput("legacy-root");
    materialize(cwd, input);
    const session = sessionOf(cwd, input);
    const md = renderSessionMarkdown(session);
    assertFencesClosed(md);
    assertOnlyAnchorTags(md);

    assert.ok(md.includes('<a id="viz-legacy-root"></a>'), "legacy root keeps its stable pathKey anchor");
    assert.ok(md.includes("# legacy feature worktree"));
    assert.ok(md.includes("- **Staleness:** stale"));
    assert.ok(md.includes("regenerate stale output"), "REGENERATE_HINT is visible");
    assert.ok(md.includes("safe default; bodies disabled"), "legacy standard workflow → safe default");

    const snapshot = snapshotFor([session], "all");
    assert.deepEqual(preflightLinks(snapshot).deadLinks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Golden: CTO JSON + markdown-state degraded ───────────────────────────────

test("markdown: CTO JSON run renders run-local artifacts; terminal markdown CTO is degraded with reasons", () => {
  const cwd = tmpWorkspace();
  try {
    const input = caseInput("cto-json");
    materialize(cwd, input);
    const session = sessionOf(cwd, input);
    const md = renderSessionMarkdown(session);
    assertFencesClosed(md);
    assertOnlyAnchorTags(md);

    assert.ok(md.includes("# CTO run cto\\-run\\-7f3a"), "CTO title (hyphen escaped)");
    assert.ok(md.includes("- No stage progress recorded for this session."), "CTO sessions carry no stage model");
    assert.ok(md.includes("- [cto\\_discovery](#viz-cto-run-7f3a-cto_discovery) — produced"));
    assert.ok(md.includes("- [dod](#viz-cto-run-7f3a-dod) — produced — owner alpha"));
    assert.ok(md.includes("- **Session status:** complete"));

    const snapshot = snapshotFor([session], "all");
    assert.deepEqual(preflightLinks(snapshot).deadLinks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("markdown: degraded markdown-state CTO page shows degraded status and reasons", () => {
  const session = buildExpectedCtoMarkdownTerminalSession();
  const md = renderSessionMarkdown(session);
  assertFencesClosed(md);
  assertOnlyAnchorTags(md);

  assert.ok(md.includes("# CTO run cto\\-markdown\\-done"), "degraded CTO title (hyphen escaped)");
  assert.ok(md.includes("- **Status:** degraded"));
  assert.ok(md.includes("- **Staleness:** unknown"));
  assert.ok(md.includes("- **Degraded reasons:**"));
  assert.ok(md.includes("  - terminal markdown CTO state: visualization\\-only projection"));
  assert.ok(md.includes("- No artifacts yet — this session has no declared or discovered artifacts."));
  assert.ok(md.includes("- No artifacts in this session."));

  const snapshot = snapshotFor([session], "all");
  assertPageHrefsResolve(session, md, snapshot);
  assert.deepEqual(preflightLinks(snapshot).deadLinks, []);
});

// ── Golden: slots / mid-consilium / missing / unreadable / empty ─────────────

test("markdown: mid-consilium slots render with pending shared base", () => {
  const cwd = tmpWorkspace();
  try {
    const input = caseInput("slots-mid-consilium");
    materialize(cwd, input);
    const session = sessionOf(cwd, input);
    const md = renderSessionMarkdown(session);
    assertFencesClosed(md);
    assertOnlyAnchorTags(md);

    assert.ok(md.includes("- [spec\\_architecture\\_tasks](#viz-consilium-spec_architecture_tasks) — pending"));
    assert.ok(md.includes("- [spec\\_architecture\\_tasks\\-architect](#viz-consilium-spec_architecture_tasks-architect) — produced (slot of spec\\_architecture\\_tasks)"));
    assert.ok(md.includes("- [spec\\_architecture\\_tasks\\-tech\\-researcher](#viz-consilium-spec_architecture_tasks-tech-researcher) — produced (slot of spec\\_architecture\\_tasks)"));
    assert.ok(md.includes("\\(slot of spec\\_architecture\\_tasks\\)"), "slot artifact heading shows the base");
    assert.ok(md.includes("shared artifact spec\\_architecture\\_tasks is pending: producer in\\_progress, slots present"));

    const snapshot = snapshotFor([session], "all");
    assertPageHrefsResolve(session, md, snapshot);
    assert.deepEqual(preflightLinks(snapshot).deadLinks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("markdown: corrupt JSON is unreadable with raw preview; empty files show the empty marker", () => {
  const cwd = tmpWorkspace();
  try {
    const input = caseInput("corrupt-unreadable-empty");
    materialize(cwd, input);
    // --full embeds bodies so the [empty]/{} markers surface (redaction intact).
    const session = sessionOf(cwd, input, true);
    const md = renderSessionMarkdown(session);
    assertFencesClosed(md);
    assertOnlyAnchorTags(md);

    assert.ok(md.includes("- [corrupt](#viz-broken-corrupt) — unreadable"));
    assert.ok(md.includes("- [unreadable](#viz-broken-unreadable) — unreadable"));
    assert.ok(md.includes("— reason invalid-json"), "error category visible in status details");
    assert.ok(md.includes("- **status:** unreadable"), "unreadable renders a status-only view");
    assert.ok(md.includes("\\[empty\\]"), "empty file shows the [empty] marker");
    assert.ok(md.includes("- **fields:** \\{\\}"), "empty object shows the {} marker");
    assert.ok(md.includes("- artifact corrupt is unreadable: invalid JSON within the read window"));
    assert.ok(md.includes("- artifact unreadable is unreadable: invalid JSON within the read window"));

    const snapshot = snapshotFor([session], "all");
    assertPageHrefsResolve(session, md, snapshot);
    assert.deepEqual(preflightLinks(snapshot).deadLinks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Golden: hostile content cannot break structure ───────────────────────────

test("markdown: hostile content (unicode/fences/HTML-like/CRLF/deep/large) never breaks structure", () => {
  const cwd = tmpWorkspace();
  try {
    const input = caseInput("deep-hostile");
    materialize(cwd, input);
    // --full embeds bodies even for the safe-default workflow, so the CRLF
    // payload reaches the fenced raw-text view (redaction still applies).
    const session = sessionOf(cwd, input, true);
    const md = renderSessionMarkdown(session);
    assertFencesClosed(md);
    assertOnlyAnchorTags(md);

    // Unicode survives as data (see also the spec-preparation golden page).
    // CRLF payload preserved verbatim inside a code fence (generic fallback).
    assert.ok(md.includes("line one\r\nline two"), "CRLF preserved verbatim in the fenced block");
    // HTML-like payload is escaped — no raw tags beyond serializer anchors.
    assert.doesNotMatch(md, /<script|<img|<style|<b>/);
    // Fences payload cannot hijack the block: the CRLF payload sits inside a
    // longer dynamic fence, so its own ```json line stays data.
    assert.ok(md.includes("````\nline one\r\nline two"), "CRLF payload inside a 4-backtick dynamic fence");
    // Bounds markers are visible.
    assert.ok(md.includes("bounded: depth 8 truncated"), "depth marker");
    assert.ok(md.includes("collections"), "collection marker");
    assert.ok(md.includes("scalars"), "scalar marker");

    const snapshot = snapshotFor([session], "all");
    assertPageHrefsResolve(session, md, snapshot);
    assert.deepEqual(preflightLinks(snapshot).deadLinks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("markdown: spec-preparation hostile body stays data inside the structured renderer", () => {
  const session = buildExpectedSpecPreparationSession();
  const md = renderSessionMarkdown(session);
  assertFencesClosed(md);
  assertOnlyAnchorTags(md);
  assert.ok(md.includes("Inline \\`\\`\\`fence\\`\\`\\`"), "fence backticks are escaped, not structural");
  assert.ok(md.includes("Título — Привет, мир 👋"), "unicode inside a structured section survives");
  assert.ok(md.includes("\\<script\\>"), "script tag is escaped, never raw");
  assert.doesNotMatch(md, /(?<!\\)<script/, "no unescaped script tag");
});

test("markdown: hostile identities (artifact ids, stage ids, owners, slot bases) never become raw markup and links stay valid", () => {
  // Untrusted identity values — hostile as link labels / inline text. Hrefs
  // and anchors derive from encodeURIComponent, so every Markdown/HTML
  // breaker (`<`, `>`, backtick, `[`, `]`, `|`, …) only appears
  // percent-encoded there. Artifact ids deliberately avoid `*!~'()` — those
  // are left unencoded by encodeURIComponent and would be URL-breaking in a
  // markdown destination — so emphasis/strikethrough coverage lives in owner
  // text, which never reaches hrefs or anchors.
  const scriptId = "<script>alert`1`</script>";
  const imgId = "<img src=x onerror=alert`1`>";
  const bracketId = "[b]`c`";
  const punctId = "a|b=c#d+e.f-g&j";
  const slotId = "spec_intake_repo_map-analyst";
  const ownerHostile = "own<er>`b`[x]";
  const ownerEmphasis = "own*er~x!y";
  const slotBase = "base<b>`s";
  const artifact = (id: string, owner: string): VisualizationArtifact => ({ id, owner, status: "missing" });
  const session: VisualizationSession = {
    schema: 1,
    identity: {
      kind: "feature",
      id: "hostile",
      pathKey: "hostile",
      title: "hostile identity worktree",
      task: "Hostile identity values must stay inert data.",
      workflow: "spec-preparation",
      sourceFormat: "json",
      isLegacy: false,
      degraded: false,
    },
    status: "complete",
    stages: [
      { stageId: "<stage>id", title: "Hostile stage", status: "done", artifactIds: [scriptId, bracketId] },
      { stageId: "stage_2", status: "pending", artifactIds: [] },
    ],
    artifacts: [
      artifact(scriptId, ownerHostile),
      artifact(imgId, "al*pha"),
      artifact(bracketId, ownerEmphasis),
      artifact(punctId, "own|er"),
      { ...artifact(slotId, "slot_owner"), slotFor: slotBase },
    ],
    source: {
      kind: "state",
      label: ".work-state/features/hostile/state.json",
      bytes: 12,
      readBytes: 12,
      readWindowBytes: 16384,
      format: "json",
    },
    provenance: {
      sourceUpdatedAt: "2026-08-19T11:00:00.000Z",
      sourceDigest: { bounded: "0123456789abcdef" },
      generatedAt: FIXED_GENERATED_AT,
      renderer: DEFAULT_RENDERER_IDENTITY,
      staleness: "fresh",
    },
    warnings: [],
  };
  const md = renderSessionMarkdown(session);
  assertFencesClosed(md);
  assertOnlyAnchorTags(md);

  // No raw/executable tag survives: `<script>`/`<img onerror>` and friends
  // appear only as backslash-escaped data, never as raw HTML.
  assert.doesNotMatch(md, /(?<!\\)<\/?(script|img|style|svg|iframe|b)\b/i, "no raw HTML tag from identity values");
  assert.ok(md.includes("\\<script\\>alert\\`1\\`\\</script\\>"), "script id stays visible but inert");
  assert.ok(md.includes("\\<img src\\=x onerror\\=alert\\`1\\`\\>"), "img onerror id stays visible but inert");
  assert.ok(md.includes("\\[b\\]\\`c\\`"), "brackets/backticks escaped in the label");
  assert.ok(md.includes("a\\|b\\=c\\#d\\+e\\.f\\-g\\&j"), "punctuation blast escaped");

  // Backticks cannot open a code span: no unescaped backtick outside fences.
  assert.doesNotMatch(md, /(?<!\\)`/, "no unescaped backtick opens a code span");

  // Stage ids and owner/slot suffixes are inline text — escaped, not markup.
  assert.ok(md.includes("- **done** \\<stage\\>id — Hostile stage"), "hostile stageId renders as inert inline text");
  assert.ok(md.includes("- **pending** stage\\_2"), "underscore stageId escaped");
  assert.ok(md.includes("— owner own\\<er\\>\\`b\\`\\[x\\]"), "hostile owner escaped in status details");
  assert.ok(md.includes("— owner own\\*er\\~x\\!y"), "emphasis/strikethrough escaped in owner text");
  assert.ok(md.includes("(slot of base\\<b\\>\\`s)"), "hostile slot base escaped in the slot suffix");

  // Escaping keeps every link intact: label → identical href; hrefs resolve
  // against the frozen registry; emitted links equal the frozen link graph.
  assert.ok(
    md.includes(`- [${mdEscape(scriptId)}](#${fragmentForArtifact("hostile", scriptId)}) — missing`),
    "hostile id linked from the overview index with a valid href",
  );
  assert.ok(
    md.includes(`  - [${mdEscape(bracketId)}](#${fragmentForArtifact("hostile", bracketId)})`),
    "hostile id linked from its stage with a valid href",
  );
  const snapshot = snapshotFor([session], "all");
  assertPageHrefsResolve(session, md, snapshot);
  assert.deepEqual(preflightLinks(snapshot).deadLinks, []);
});

// ── Golden: zero-artifact session ────────────────────────────────────────────

test("markdown: zero-artifact session is overview-only with a clear no-artifacts note", () => {
  const session = buildExpectedZeroArtifactSession();
  const md = renderSessionMarkdown(session);
  assertFencesClosed(md);
  assertOnlyAnchorTags(md);

  assert.ok(md.includes("# fresh feature worktree"));
  assert.ok(md.includes("### Artifacts (0)"));
  assert.ok(md.includes("- No artifacts yet."));
  assert.ok(md.includes("## Artifacts"));
  assert.ok(md.includes("- No artifacts yet — this session has no declared or discovered artifacts."));
  assert.ok(md.includes("## Status details"));
  assert.ok(md.includes("- No artifacts in this session."));
  assert.ok(md.includes("- no artifacts yet"), "model warning visible");

  const snapshot = snapshotFor([session], "all");
  assertPageHrefsResolve(session, md, snapshot);
  assert.deepEqual(preflightLinks(snapshot).deadLinks, []);
});

// ── Hub: selected partial vs --all complete ──────────────────────────────────

test("markdown: hub — selected scope is visibly partial, --all is complete", () => {
  // Selected: exactly the selected/latest session, explicit partial statement.
  const selectedSession = buildExpectedSpecPreparationSession();
  const selected: VisualizationSnapshot = {
    schema: 1,
    scope: "selected",
    generatedAt: FIXED_GENERATED_AT,
    renderer: DEFAULT_RENDERER_IDENTITY,
    sessions: [selectedSession],
    manifest: buildSelectedManifest(),
    warnings: [],
  };
  const selectedMd = renderHubMarkdown(selected);
  assertFencesClosed(selectedMd);
  assertOnlyAnchorTags(selectedMd);
  assert.match(selectedMd, /^scope: "selected"$/m);
  assert.ok(selectedMd.includes("> Scope: selected — PARTIAL view."));
  assert.ok(selectedMd.includes("Run with --all to generate every discovered session."));
  assert.ok(selectedMd.includes(`[visualize feature worktree](sessions/feature/visualize.md#viz-visualize)`));
  assert.equal((selectedMd.match(/\]\(sessions\/[^)]+\.md#viz-[^)]+\)/g) ?? []).length, 1);

  // --all: complete statement + every golden session in deterministic order.
  const all = buildGoldenAllSnapshot();
  const allMd = renderHubMarkdown(all);
  assertFencesClosed(allMd);
  assert.match(allMd, /^scope: "all"$/m);
  assert.ok(allMd.includes("> Scope: all — complete view. Every discovered session (4) is included in this bundle."));
  assert.match(allMd, /^discovered_sessions: 4$/m);
  assert.match(allMd, /^session_count: 4$/m);
  assert.ok(allMd.includes("<a id=\"viz-hub\"></a>"));
  const order = all.sessions.map((s) => s.identity.pathKey);
  const hubOrder = [...allMd.matchAll(/sessions\/[a-z]+\/([^)]+)\.md#viz-/g)].map((m) => m[1] ?? "");
  assert.deepEqual(hubOrder, order, "hub session order is the frozen model order");
  for (const s of all.sessions) {
    const escapedWorkflow = s.identity.workflow.replace(/-/g, "\\-");
    assert.ok(
      allMd.includes(`· ${escapedWorkflow} · ${s.status} · ${s.provenance.staleness} ·`),
      `hub line for ${s.identity.pathKey}`,
    );
  }
  assert.ok(allMd.includes("  - degraded: rendered from available content only (see the session page)"), "degraded session stays reachable");

  // Hub hrefs all resolve against the frozen registry.
  const registry = buildLinkRegistry(all);
  const hubHrefs = [...allMd.matchAll(/\]\(([^)\s]+\.md)#([^)\s]+)\)/g)].map((m) => ({ page: m[1] ?? "", anchor: m[2] ?? "" }));
  for (const href of hubHrefs) {
    const pathKey = href.page.match(/\/([^/]+)\.md$/)?.[1] ?? "";
    assert.ok(registry.sessions.get(pathKey)?.anchors.has(href.anchor), `dead hub target ${href.page}#${href.anchor}`);
  }

  // Link preflight over the complete bundle: zero dead links.
  const result = preflightLinks(all);
  assert.equal(result.checked, buildLinkGraph(all).links.length);
  assert.deepEqual(result.deadLinks, []);
});

test("markdown: hub shows the stale regenerate hint per stale session", () => {
  const cwd = tmpWorkspace();
  try {
    const legacyInput = caseInput("legacy-root");
    materialize(cwd, legacyInput);
    const legacy = sessionOf(cwd, legacyInput);
    const snapshot = snapshotFor([legacy], "all");
    const md = renderHubMarkdown(snapshot);
    assert.ok(md.includes("· stale ·"));
    assert.ok(md.includes("  - stale: run the on"), "stale hint line present");
    assert.ok(md.includes("demand visualize command to regenerate stale output"), "stale regenerate hint on the hub");
    assert.deepEqual(preflightLinks(snapshot).deadLinks, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Link preflight ───────────────────────────────────────────────────────────

test("markdown: link preflight catches corrupted and foreign targets", () => {
  const snapshot = buildGoldenAllSnapshot();
  const graph = buildLinkGraph(snapshot);
  const registry = buildLinkRegistry(snapshot);
  assert.ok(graph.links.length > 0);
  assert.equal(new Set(graph.links.map((l) => l.id)).size, graph.links.length, "link ids are unique");

  const fresh = checkLinkGraph(graph, registry);
  assert.equal(fresh.checked, graph.links.length);
  assert.deepEqual(fresh.deadLinks, []);

  // Mutating a target anchor is caught.
  const corrupted: LinkGraph = {
    links: graph.links.map((link, i) =>
      i === 0 ? { ...link, to: { ...link.to, anchor: "viz-does-not-exist" } } : link,
    ),
  };
  assert.equal(checkLinkGraph(corrupted, registry).deadLinks.length, 1);

  // A foreign session target is caught.
  const foreign: LinkGraph = {
    links: [
      {
        id: "session:hub:ghost",
        kind: "session",
        from: { sessionPathKey: "hub", anchor: HUB_ANCHOR },
        to: { sessionPathKey: "ghost", anchor: "viz-ghost" },
        label: "ghost",
        state: "resolved",
      },
    ],
  };
  const dead = checkLinkGraph(foreign, registry).deadLinks;
  assert.equal(dead.length, 1);
  assert.equal(dead[0]?.id, "session:hub:ghost");

  // A section that the page does not emit is not a valid target.
  const bogusSection: LinkGraph = {
    links: [
      {
        id: "section:visualize:requirements",
        kind: "section",
        from: { sessionPathKey: "visualize", section: "overview", anchor: "viz-visualize@overview" },
        to: { sessionPathKey: "visualize", section: "requirements", anchor: sectionAnchorOf("visualize", "requirements") },
        label: "Requirements",
        state: "resolved",
      },
    ],
  };
  // bug-fix golden has no requirements artifact → the section anchor is absent.
  const bugFixSnapshot = snapshotFor([buildExpectedBugFixSession()], "all");
  assert.equal(checkLinkGraph(bogusSection, buildLinkRegistry(bugFixSnapshot)).deadLinks.length, 1);
});

// ── Determinism / volatile fields / secrets / absolute paths ─────────────────

test("markdown: byte determinism for fixed generated_at — only volatile fields differ", () => {
  const a = renderSessionMarkdown(buildExpectedSpecPreparationSession());
  const b = renderSessionMarkdown(buildExpectedSpecPreparationSession());
  assert.equal(a, b, "identical models render byte-identical");

  const moved = buildExpectedSpecPreparationSession("2026-08-19T13:00:00.000Z");
  const c = renderSessionMarkdown(moved);
  assert.notEqual(a, c);
  const linesA = new Set(a.split("\n"));
  const linesC = new Set(c.split("\n"));
  const differing = [...linesA].filter((line) => !linesC.has(line));
  assert.ok(differing.length > 0, "generated_at moves");
  for (const line of differing) assert.match(line, /generated_at|staleness|Generated at/, `non-volatile line changed: ${line}`);
});

test("markdown: fresh fs-built models from identical inputs render byte-identical", () => {
  const cwdA = tmpWorkspace();
  const cwdB = tmpWorkspace();
  try {
    const input = caseInput("feature-spec-preparation");
    materialize(cwdA, input);
    materialize(cwdB, input);
    const mdA = renderSessionMarkdown(sessionOf(cwdA, input));
    const mdB = renderSessionMarkdown(sessionOf(cwdB, input));
    assert.equal(mdA, mdB);
  } finally {
    rmSync(cwdA, { recursive: true, force: true });
    rmSync(cwdB, { recursive: true, force: true });
  }
});

test("markdown: rendered output contains no absolute paths and no secrets", () => {
  const cwd = tmpWorkspace();
  try {
    const unsafeInput = caseInput("unsafe-ids-paths");
    materialize(cwd, unsafeInput);
    const unsafe = sessionOf(cwd, unsafeInput);
    const unsafeMd = renderSessionMarkdown(unsafe);
    assert.doesNotMatch(unsafeMd, /\/Users\/|\/tmp\/|C:\\|\.\.\/outside|\\Users/, "no absolute or escaping paths");
    assert.ok(unsafeMd.includes("not a safe path key: skipped"), "unsafe ids surface as escaped warnings");
    assert.ok(unsafeMd.includes("declared path for ok\\_id is not a safe relative path: excluded from rendering"));

    const mixedInput = caseInput("mixed-state");
    materialize(cwd, mixedInput);
    const mixed = sessionOf(cwd, mixedInput);
    const mixedMd = renderSessionMarkdown(mixed);
    assertFencesClosed(mixedMd);
    assert.ok(mixedMd.includes("#### Fields"), "status-only produced artifacts list their top-level keys");
    assert.doesNotMatch(mixedMd, /sk-abc123|hunter2|t0k3n-secret/, "secret values never reach rendered output");
    assert.doesNotMatch(mixedMd, /\/Users\/|\/tmp\/|C:\\/, "no absolute paths in the AC-1 fixture page");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Anchor vocabulary ────────────────────────────────────────────────────────

test("markdown: anchors are stable identity-based and disjoint across kinds", () => {
  assert.equal(sectionAnchorOf("visualize", "overview"), "viz-visualize@overview");
  assert.equal(sectionAnchorOf("legacy-root", "status-details"), "viz-legacy-root@status-details");
  assert.equal(fragmentForArtifact("visualize", "spec-preparation"), "viz-visualize-spec-preparation");
  const session = buildExpectedSpecPreparationSession();
  const md = renderSessionMarkdown(session);
  // Artifact anchors never collide with section anchors (@ is outside the
  // encoded-artifact alphabet).
  assert.ok(md.includes('<a id="viz-visualize@requirements"></a>'));
  assert.ok(!md.includes('id="viz-visualize@requirements-"'));
  assert.doesNotMatch(md, /id="viz-visualize-@/, "no artifact anchor can carry the section separator");
});
