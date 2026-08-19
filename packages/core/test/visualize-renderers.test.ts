/**
 * Visualize OPT-A — pure renderer registry (architecture-4) tests.
 *
 * Defends the renderer precedence chain (depth policy → exact → spec-family →
 * 22 typed schema ids → payload type match → bounded generic fallback),
 * spec-family readability (headings/lists/tables, not a key-value tree), all
 * 22 typed ids, unknown/freeform/regression fallback, hostile/deep/large
 * values preserved as data with visible bounds markers, renderer-failure
 * fallback with warning increments, and bounded output. Pure — the tested
 * renderers never touch fs/network and never mutate their inputs (the
 * frozen-artifact test proves it).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  exactRenderers,
  htmlText,
  mdText,
  parseBoundedJson,
  renderArtifact,
  renderArtifactWithTables,
  renderStatusOnly,
  specRenderers,
  typedRenderers,
  type ArtifactRenderer,
  type RenderNode,
  type RendererTables,
} from "../src/visualize/renderer-registry.js";
import { MAX_TABLE_COLUMNS, objectTable, renderJsonValue } from "../src/visualize/render-json.js";
import { humanize } from "../src/visualize/render-spec.js";
import {
  DEFAULT_BODY_CAP_BYTES,
  DEFAULT_RENDER_BOUNDS,
  EMPTY_BODY_MARKER,
  MAX_COLLECTION_ITEMS,
  MAX_DEPTH,
  MAX_SCALAR_CHARS,
  REDACTED_MARKER,
  SPEC_FAMILY_IDS,
  TYPED_ARTIFACT_IDS,
  defaultRenderOptions,
  formatTruncationMarker,
  type RedactedBody,
  type RenderOptions,
  type VisualizationArtifact,
} from "../src/visualize/types.js";
import {
  CRLF_SAMPLE,
  DEEP_JSON_SAMPLE,
  FENCES_SAMPLE,
  HTML_LIKE_SAMPLE,
  LARGE_COLLECTION_SAMPLE,
  LARGE_SCALAR_TEXT,
  UNICODE_SAMPLE,
} from "./fixtures/visualize-fixtures.js";

// ── Harness ──────────────────────────────────────────────────────────────────

function redactedBody(text: string, opts: { preview?: boolean; truncated?: boolean; capBytes?: number } = {}): RedactedBody {
  const capBytes = opts.capBytes ?? DEFAULT_BODY_CAP_BYTES;
  const originalBytes = Buffer.byteLength(text, "utf8");
  const preview = opts.preview ?? false;
  const truncated = opts.truncated ?? false;
  return {
    text,
    truncated,
    originalBytes,
    capBytes,
    preview,
    marker: truncated ? formatTruncationMarker(originalBytes, capBytes) : "",
  };
}

/** Build a produced artifact with a JSON body; omit `payload` for body-less cases. */
function artifact(id: string, payload?: unknown, extra: Partial<VisualizationArtifact> = {}): VisualizationArtifact {
  const base: VisualizationArtifact = { id, owner: "test", status: extra.status ?? "produced" };
  if (extra.body !== undefined) return { ...base, ...extra };
  if (payload !== undefined) return { ...base, ...extra, body: redactedBody(JSON.stringify(payload, null, 2)) };
  return { ...base, ...extra };
}

function options(full = false): RenderOptions {
  return defaultRenderOptions(full);
}

function allText(nodes: readonly RenderNode[]): string {
  return nodes
    .flatMap((n) => {
      switch (n.kind) {
        case "heading":
        case "paragraph":
        case "code":
          return [n.text];
        case "list":
          return [...n.items];
        case "kv":
          return [n.key, n.value];
        case "table":
          return [...n.headers, ...n.rows.flat()];
      }
    })
    .join("\n");
}

function headings(nodes: readonly RenderNode[]): string[] {
  return nodes.filter((n): n is Extract<RenderNode, { kind: "heading" }> => n.kind === "heading").map((n) => n.text);
}

function listsOf(nodes: readonly RenderNode[]): Extract<RenderNode, { kind: "list" }>[] {
  return nodes.filter((n): n is Extract<RenderNode, { kind: "list" }> => n.kind === "list");
}

function tablesOf(nodes: readonly RenderNode[]): Extract<RenderNode, { kind: "table" }>[] {
  return nodes.filter((n): n is Extract<RenderNode, { kind: "table" }> => n.kind === "table");
}

function paragraphs(nodes: readonly RenderNode[]): Extract<RenderNode, { kind: "paragraph" }>[] {
  return nodes.filter((n): n is Extract<RenderNode, { kind: "paragraph" }> => n.kind === "paragraph");
}

function codeNodes(nodes: readonly RenderNode[]): Extract<RenderNode, { kind: "code" }>[] {
  return nodes.filter((n): n is Extract<RenderNode, { kind: "code" }> => n.kind === "code");
}

function kvOf(nodes: readonly RenderNode[], key: string): string | undefined {
  for (const n of nodes) {
    if (n.kind === "kv" && n.key === key) return n.value;
  }
  return undefined;
}

// ── Bounded parse (unit) ─────────────────────────────────────────────────────

test("parseBoundedJson enforces depth 8, collections 200, scalar 8192 and reports markers", () => {
  const deep = parseBoundedJson(JSON.stringify(JSON.parse(DEEP_JSON_SAMPLE)));
  assert.equal(deep.ok, true);
  assert.equal(deep.bounds?.depthTruncated, true);
  assert.ok(deep.bounds?.marker.includes(`depth ${MAX_DEPTH}`));
  assert.ok(deep.bounds?.marker.includes("truncated"));

  const many = parseBoundedJson(LARGE_COLLECTION_SAMPLE);
  assert.equal(many.ok, true);
  assert.equal(many.bounds?.omittedCollections, 1);
  const manyValue = many.value as { items: unknown[] };
  assert.equal(manyValue.items.length, MAX_COLLECTION_ITEMS);

  const long = parseBoundedJson(JSON.stringify({ text: LARGE_SCALAR_TEXT }));
  assert.equal(long.ok, true);
  assert.equal(long.bounds?.omittedScalars, 1);
  assert.equal((long.value as { text: string }).text.length, MAX_SCALAR_CHARS);

  const corrupt = parseBoundedJson("{ not json");
  assert.equal(corrupt.ok, false);
  assert.equal(typeof corrupt.parseError, "string");

  const scalarRoot = parseBoundedJson("42");
  assert.equal(scalarRoot.ok, true);
  assert.equal(scalarRoot.value, 42);
  const arrayRoot = parseBoundedJson("[1,2,3]");
  assert.equal(arrayRoot.ok, true);
  assert.deepEqual(arrayRoot.value, [1, 2, 3]);
});

// ── Safe text primitives ─────────────────────────────────────────────────────

test("mdText escapes Markdown markup and preserves Unicode/CRLF as data", () => {
  assert.equal(mdText('<script>alert(1)</script>'), "\\<script\\>alert\\(1\\)\\</script\\>");
  assert.equal(mdText("a *b* [c](d) `e` # f"), "a \\*b\\* \\[c\\]\\(d\\) \\`e\\` \\# f");
  assert.equal(mdText("C# and F# and 1.0"), "C\\# and F\\# and 1\\.0");
  assert.equal(mdText(UNICODE_SAMPLE), UNICODE_SAMPLE);
  const escaped = mdText(CRLF_SAMPLE);
  assert.ok(escaped.includes("\r\n"), "CRLF characters survive escaping");
  assert.ok(escaped.includes("\\`\\`\\`"), "fence backticks are escaped, not stripped");
});

test("htmlText escapes the five HTML-special characters in order", () => {
  assert.equal(htmlText('<script>alert("x")</script> &'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp;");
  assert.equal(htmlText("it's"), "it&#39;s");
  assert.equal(htmlText(UNICODE_SAMPLE), UNICODE_SAMPLE);
});

// ── Registry tables ──────────────────────────────────────────────────────────

test("renderer tables cover exactly the 7 spec-family ids and 22 typed ids", () => {
  assert.deepEqual(Object.keys(specRenderers).sort(), [...SPEC_FAMILY_IDS].sort());
  assert.deepEqual(Object.keys(typedRenderers).sort(), [...TYPED_ARTIFACT_IDS].sort());
  assert.equal(Object.keys(typedRenderers).length, 22);
});

// ── All 22 typed schema ids ──────────────────────────────────────────────────

const TYPED_PAYLOADS: Record<string, unknown> = {
  discovery: { task: "Confirm feature scope", branch: "feat/visualize", constraints: ["no network"] },
  exploration: { files_to_read: [{ path: "src/types.ts", why: "frozen contracts" }], patterns: ["ESM", "strict tsconfig"], summary: "Found existing report renderer" },
  clarifications: { questions: ["Scope?"], answers: ["local-only"] },
  architecture: { options: [{ id: "opt-a", summary: "Projection", pros: ["pure"], cons: ["more code"] }], chosen: "opt-a", rationale: "smallest reversible shape" },
  diagnosis: { root_cause: "mtime leaked into digest", evidence: ["fixture diff"], proposed_fix: "hash content only", verification_checklist: ["mtime probe"] },
  implementation: { files_touched: ["src/visualize/types.ts"], commits: ["abc123"], build_status: "pass", scope: ["core"] },
  debug: { verdict: "PASS", iterations: 2, manual_qa_log: "opened index.html", screenshots: ["shots/1.png"] },
  review: { verdict: "approve", findings: [{ title: "Minor", severity: "MEDIUM", confidence: 85, zone: "core" }], tests: { passed: 12, failed: 0 } },
  summary: { built: ["renderer"], decisions: ["OPT-A"], files_modified: ["types.ts"], pr_url: null },
  manual_qa: { verdict: "PASS", mode: "ui", evidence: ["screenshot shows overview"], regressions: [] },
  qa_tests: { tests_added: ["visualize-renderers.test.ts"], build_status: "pass", based_on_manual_qa: true },
  feature_spec: { goal: "Readable specs", scope: ["markdown"], anti_scope: ["export"], acceptance_criteria: ["opens offline"], testing_strategy: "fixture tests", risks: [] },
  dod: { items: [{ id: "architecture-1", criterion: "mtime-free digest", verify_method: "fixture", status: "pending" }] },
  cto_discovery: { task: "Orchestrate teams", branch: "feat/cto", teams_hint: ["core"] },
  team_plan: { teams: [{ team: "core", slice: "renderers", profile: "standard", worktree: "same_branch" }], max_teams: 2 },
  team_artifacts: { teams: [{ team: "core", status: "done", summary: "all green" }] },
  integration_review: { verdict: "approve", findings: [], merged_branches: ["feat/x"], note: "ok" },
  lecture_intake: { task: "Research playlist", sources: [{ id: "l1", kind: "transcript", location: "file.md", provenance: "provided" }] },
  lecture_mapping: { coverage: "3/4 mapped", lectures: [{ id: "l1-u1", title: "Intro", source_id: "l1", evidence: "quote" }], gaps: [] },
  lecture_candidates: { candidates: [{ id: "c1", topic: "X", evidence_sources: [{ source_id: "l1", evidence: "quote" }], conflicts: [] }], deduped_count: 1 },
  lecture_repo_fit: { findings: [{ title: "matches", category: "repo_fit", evidence: "symbol" }], verdict: "fit" },
  lecture_decision: { verdict: "approved", rationale: "user chose", approved_candidates: ["c1"], next_steps: [] },
};

test("all 22 typed schema ids render through the typed-schema layer without exception", () => {
  for (const id of TYPED_ARTIFACT_IDS) {
    const result = renderArtifact(artifact(id, TYPED_PAYLOADS[id]));
    assert.equal(result.layer, "typed-schema", `layer for ${id}`);
    assert.ok(result.nodes.length > 0, `nodes for ${id}`);
    assert.equal(headings(result.nodes)[0], id, `first heading is the artifact id for ${id}`);
  }
});

test("typed schema sections read as headings/lists/tables", () => {
  const review = renderArtifact(artifact("review", TYPED_PAYLOADS.review));
  assert.ok(headings(review.nodes).includes("Findings"));
  assert.equal(tablesOf(review.nodes).length, 1);
  assert.ok(allText(review.nodes).includes("approve"), "verdict content present");

  const dod = renderArtifact(artifact("dod", TYPED_PAYLOADS.dod));
  assert.ok(headings(dod.nodes).includes("Items"));
  const dodTable = tablesOf(dod.nodes)[0];
  assert.ok(dodTable?.headers.includes("criterion"));
  assert.ok(allText(dod.nodes).includes("mtime-free digest"));

  const architecture = renderArtifact(artifact("architecture", TYPED_PAYLOADS.architecture));
  assert.ok(headings(architecture.nodes).includes("Options"));
  assert.ok(allText(architecture.nodes).includes("opt-a"), "chosen option content present");

  const featureSpec = renderArtifact(artifact("feature_spec", TYPED_PAYLOADS.feature_spec));
  const criteria = listsOf(featureSpec.nodes).find((l) => l.items.includes("opens offline"));
  assert.ok(criteria !== undefined, "acceptance criteria rendered as a list item");
});

// ── Spec-family readability (7 known ids) ────────────────────────────────────

const SPEC_PAYLOADS: Record<string, unknown> = {
  spec_intake_repo_map: {
    artifact_id: "spec_intake_repo_map",
    summary: "Mapped the repo",
    verified_facts: [{ area: "monorepo", facts: ["ESM", "Node 20"] }],
    affected_paths: ["packages/core"],
    conventions: ["strict tsconfig"],
    assumptions: ["local output"],
    open_questions: ["viewer?"],
    evidence: ["package.json"],
  },
  spec_requirements_edge_cases: {
    requirements: [{ id: "REQ-1", title: "Readable", requirement: "Specs read as headings" }],
    edge_cases: ["CRLF", "deep JSON"],
    non_goals: ["hosting"],
    acceptance_criteria: ["fixtures cover edges"],
  },
  spec_options_decisions: {
    implementation_options: [{ id: "OPT-A", name: "projection", mechanism: "normalized model" }],
    material_decisions: [{ id: "MD-1", name: "scope", question: "local?", choices: ["local"], default_if_unresolved: "local" }],
    recommendation: "OPT-A",
  },
  spec_architecture_tasks: {
    architecture: { model: "immutable snapshot" },
    task_slices: [{ id: "architecture-1", title: "Freeze contracts", owner: "core" }],
    risks: ["scope"],
  },
  spec_completeness: {
    verdict: "complete",
    blocking_gaps: [],
    decision_gates: [{ gate: "G-1", status: "resolved" }],
    recommendation: "proceed",
  },
  "spec-preparation": {
    artifact_id: "spec-preparation",
    artifact_type: "implementation_ready_specification",
    summary: "Full specification",
    classification: { type: "SPEC", complexity: "COMPLEX", confidence: "HIGH", autonomous: false },
    requirements_traceability: [{ id: "REQ-1", summary: "readable", design: "a2", tests: "AC-1" }],
    alternative_options: [{ id: "OPT-B", name: "viewer", mechanism: "runtime" }],
    decision_log: [{ decision: "OPT-A", rationale: "reversible" }],
    authoritative_task_slices: [{ id: "architecture-4", title: "Renderers", owner: "core" }],
    material_decisions: [{ id: "MD-4", name: "depth", default_if_unresolved: "detailed" }],
    decision_gates: [{ gate: "G-3", default_if_unresolved: "on-demand" }],
    warnings_and_required_pins: ["SLICE-0 pin"],
    assumptions: ["local checkout"],
  },
  spec_handoff: {
    artifact_id: "spec_handoff",
    headline: "OPT-A first slice",
    outcome_contract: { statement: "open by identity" },
    recommended_default: { default_implementation: "OPT-A" },
    options: [{ id: "OPT-A", name: "projection", pros: ["pure"] }],
    material_decisions: [{ id: "MD-1", name: "scope", question: "x", default_if_unresolved: "local" }],
    decision_gates: [{ id: "G-1", question: "y", default_if_unresolved: "z" }],
    implementation_contract: { rendering: "depth -> exact -> spec -> typed -> generic" },
    implementation_order: [{ id: "architecture-4", title: "Renderers", owner: "core" }],
    acceptance_contract: { criteria: [{ id: "AC-1", criterion: "readable" }] },
    next_step: "implement",
  },
};

test("the 7 known spec ids render through the spec-family layer", () => {
  for (const id of SPEC_FAMILY_IDS) {
    const result = renderArtifact(artifact(id, SPEC_PAYLOADS[id]));
    assert.equal(result.layer, "spec-family", `layer for ${id}`);
    assert.ok(result.nodes.length > 0, `nodes for ${id}`);
  }
});

test("spec-family payloads read as headings/lists/tables, not a key-value tree", () => {
  const intake = renderArtifact(artifact("spec_intake_repo_map", SPEC_PAYLOADS.spec_intake_repo_map));
  assert.ok(headings(intake.nodes).includes("Verified facts"));
  assert.equal(tablesOf(intake.nodes).length, 1, "verified_facts object[] → table");
  const paths = listsOf(intake.nodes).find((l) => l.items.includes("packages/core"));
  assert.ok(paths !== undefined, "affected_paths → list");

  const reqs = renderArtifact(artifact("spec_requirements_edge_cases", SPEC_PAYLOADS.spec_requirements_edge_cases));
  assert.ok(headings(reqs.nodes).includes("Requirements"));
  assert.ok(tablesOf(reqs.nodes)[0]?.headers.includes("id"));
  const edgeList = listsOf(reqs.nodes).find((l) => l.items.includes("CRLF"));
  assert.ok(edgeList !== undefined, "edge_cases → list");

  const options = renderArtifact(artifact("spec_options_decisions", SPEC_PAYLOADS.spec_options_decisions));
  assert.ok(headings(options.nodes).includes("Implementation options"));
  assert.ok(headings(options.nodes).includes("Material decisions"));
  assert.ok(tablesOf(options.nodes).length >= 1);

  const arch = renderArtifact(artifact("spec_architecture_tasks", SPEC_PAYLOADS.spec_architecture_tasks));
  assert.ok(headings(arch.nodes).includes("Architecture"));
  assert.ok(headings(arch.nodes).includes("Task slices"));
  assert.ok(allText(arch.nodes).includes("architecture-1"));

  const completeness = renderArtifact(artifact("spec_completeness", SPEC_PAYLOADS.spec_completeness));
  assert.ok(headings(completeness.nodes).includes("Verdict"));
  assert.ok(headings(completeness.nodes).includes("Blocking gaps"));
  assert.ok(allText(completeness.nodes).includes("complete"));
});

test("spec-preparation payload reads as multiple sections with lists AND tables", () => {
  const result = renderArtifact(artifact("spec-preparation", SPEC_PAYLOADS["spec-preparation"]));
  assert.equal(result.layer, "spec-family");
  const h = headings(result.nodes);
  for (const expected of ["Requirements traceability", "Alternative options", "Decision log", "Task slices", "Material decisions", "Decision gates", "Warnings and required pins", "Assumptions"]) {
    assert.ok(h.includes(expected), `missing section heading ${expected}`);
  }
  assert.ok(tablesOf(result.nodes).length >= 4, "tables for traceability/options/decisions/slices");
  assert.ok(listsOf(result.nodes).length >= 1, "lists for warnings/assumptions");
});

test("spec_handoff reads as a handoff with implementation contract and order", () => {
  const result = renderArtifact(artifact("spec_handoff", SPEC_PAYLOADS.spec_handoff));
  assert.equal(result.layer, "spec-family");
  const h = headings(result.nodes);
  for (const expected of ["Headline", "Outcome contract", "Options", "Material decisions", "Decision gates", "Implementation contract", "Implementation order", "Next step"]) {
    assert.ok(h.includes(expected), `missing handoff heading ${expected}`);
  }
  assert.ok(tablesOf(result.nodes).length >= 1, "implementation_order → table");
  assert.ok(allText(result.nodes).includes("depth -> exact -> spec -> typed -> generic"), "implementation_contract kv content present");
});

// ── Unknown spec_*, regression_*, payload type match, freeform ───────────────

test("unknown spec_* ids degrade to the bounded generic fallback", () => {
  const result = renderArtifact(artifact("spec_something_else", { artifact_type: "spec", note: "freeform spec" }));
  assert.equal(result.layer, "generic-fallback");
  assert.equal(kvOf(result.nodes, "note"), "freeform spec");
});

test("payload type match routes a freeform id declaring a typed artifact_type to the typed renderer", () => {
  const result = renderArtifact(artifact("extra_findings", { artifact_type: "review", verdict: "needs_changes", findings: [{ title: "X", severity: "HIGH", confidence: 90, zone: "core" }] }));
  assert.equal(result.layer, "typed-schema");
  assert.ok(headings(result.nodes).includes("Findings"));
  assert.ok(allText(result.nodes).includes("needs_changes"), "verdict content present");
});

test("regression_* ids are always generic even when the payload declares a typed type", () => {
  const result = renderArtifact(artifact("regression_001", { artifact_type: "review", verdict: "approve", findings: [] }));
  assert.equal(result.layer, "generic-fallback");
});

test("unknown freeform ids render a bounded generic JSON tree", () => {
  const result = renderArtifact(artifact("notes", { artifact_id: "notes", note: "plain", count: 3, tags: ["a", "b"] }));
  assert.equal(result.layer, "generic-fallback");
  assert.equal(kvOf(result.nodes, "note"), "plain");
  assert.equal(kvOf(result.nodes, "count"), "3");
  const tagList = listsOf(result.nodes).find((l) => l.items.includes("a"));
  assert.ok(tagList !== undefined, "string[] → list");
});

test("freeform arrays of objects render as bounded tables in the generic tree", () => {
  const result = renderArtifact(artifact("log", { entries: [{ id: 1, label: "first" }, { id: 2, label: "second" }] }));
  assert.equal(result.layer, "generic-fallback");
  const t = tablesOf(result.nodes)[0];
  assert.deepEqual(t?.headers, ["id", "label"]);
  assert.equal(t?.rows.length, 2);
});

test("non-JSON freeform bodies render as a bounded raw-text block", () => {
  const body = redactedBody("raw freeform text\nnot json at all");
  const result = renderArtifact(artifact("misc", undefined, { body }));
  assert.equal(result.layer, "generic-fallback");
  const note = paragraphs(result.nodes).find((p) => p.text.includes("not valid JSON"));
  assert.ok(note !== undefined, "raw-preview note present");
  assert.ok(codeNodes(result.nodes).some((c) => c.text === "raw freeform text\nnot json at all"), "raw text preserved verbatim");
});

// ── Empty / redacted / preview bodies ────────────────────────────────────────

test("empty and fully-redacted bodies render the visible markers", () => {
  const empty = renderArtifact(artifact("zero", undefined, { body: redactedBody(EMPTY_BODY_MARKER) }));
  assert.ok(allText(empty.nodes).includes(EMPTY_BODY_MARKER));
  const redacted = renderArtifact(artifact("secret", undefined, { body: redactedBody(REDACTED_MARKER) }));
  assert.ok(allText(redacted.nodes).includes(REDACTED_MARKER));
});

test("preview/truncation markers from the body are rendered visibly", () => {
  const body = redactedBody('{"note": "head"}', { preview: true, truncated: true });
  const result = renderArtifact(artifact("big", undefined, { body }));
  assert.ok(allText(result.nodes).includes(body.marker));
  assert.ok(body.marker.includes("…[truncated "));
});

// ── Hostile values preserved as data ─────────────────────────────────────────

test("Unicode, fences, HTML-like and CRLF payload strings survive as data", () => {
  const result = renderArtifact(artifact("hostile", {
    unicode: UNICODE_SAMPLE,
    fences: FENCES_SAMPLE,
    html: HTML_LIKE_SAMPLE,
    crlf: CRLF_SAMPLE,
    inline: "<b>bold</b> &amp;",
  }));
  assert.equal(result.layer, "generic-fallback");
  const text = allText(result.nodes);
  assert.ok(text.includes(UNICODE_SAMPLE), "Unicode preserved verbatim");
  assert.ok(text.includes(FENCES_SAMPLE), "fences preserved verbatim");
  assert.ok(text.includes(HTML_LIKE_SAMPLE), "HTML-like preserved verbatim");
  assert.ok(text.includes(CRLF_SAMPLE), "CRLF preserved verbatim (code node)");
  assert.equal(kvOf(result.nodes, "inline"), "<b>bold</b> &amp;", "single-line HTML-like stays raw data");
});

test("mdText/htmlText neutralize the hostile samples when a serializer emits them", () => {
  const html = htmlText(HTML_LIKE_SAMPLE);
  assert.ok(!html.includes("<script>"), "script tag neutralized");
  assert.ok(html.includes("&lt;script&gt;"));
  const md = mdText(FENCES_SAMPLE);
  assert.ok(md.includes("\\`\\`\\`json"), "fence delimiters escaped");
  assert.ok(!md.includes("\n```json"), "no raw fence structure");
});

// ── Deep / large / bounded output ────────────────────────────────────────────

test("deep JSON is bounded at depth 8 with a visible marker", () => {
  const result = renderArtifact(artifact("deep", undefined, { body: redactedBody(DEEP_JSON_SAMPLE) }));
  assert.equal(result.layer, "generic-fallback");
  const marker = paragraphs(result.nodes).find((p) => p.text.includes("depth 8 truncated"));
  assert.ok(marker !== undefined, "depth marker present");
  assert.ok(!allText(result.nodes).includes("leaf"), "beyond-depth content is not emitted");
  assert.ok(allText(result.nodes).includes('"level": 7') || allText(result.nodes).includes("level"), "bounded head of the tree remains");
});

test("large collections are bounded at 200 rows/items with a marker", () => {
  const result = renderArtifact(artifact("many", undefined, { body: redactedBody(LARGE_COLLECTION_SAMPLE) }));
  const list = listsOf(result.nodes)[0];
  assert.equal(list?.items.length, MAX_COLLECTION_ITEMS, "list bounded at 200 items");
  const marker = paragraphs(result.nodes).find((p) => p.text.includes("collections"));
  assert.ok(marker !== undefined, "collection marker present");
});

test("long scalars are sliced at 8192 with a marker", () => {
  const result = renderArtifact(artifact("long", { text: LARGE_SCALAR_TEXT }));
  const value = kvOf(result.nodes, "text");
  assert.equal(value?.length, MAX_SCALAR_CHARS, "scalar display bounded at 8192");
  const marker = paragraphs(result.nodes).find((p) => p.text.includes("scalars"));
  assert.ok(marker !== undefined, "scalar marker present");
});

test("objectTable caps columns at 8 and reports omitted ones", () => {
  const items = [0, 1, 2].map((i) => {
    const row: Record<string, unknown> = {};
    for (let c = 0; c < 12; c += 1) row[`col${c}`] = i + c;
    return row;
  });
  const built = objectTable(items);
  assert.equal(built.node.headers.length, MAX_TABLE_COLUMNS);
  assert.equal(built.omittedColumns, 4);
  assert.equal(built.node.rows.length, 3);
});

// ── Renderer failure fallback + warning increments ───────────────────────────

test("an exact-layer renderer failure degrades to generic and increments a warning", () => {
  const id = "boom-exact";
  exactRenderers[id] = () => {
    throw new Error("kaboom");
  };
  try {
    const warnings: string[] = [];
    const result = renderArtifact(artifact(id, { note: "x" }), options(), warnings);
    assert.equal(result.layer, "generic-fallback");
    assert.equal(kvOf(result.nodes, "note"), "x", "generic fallback rendered the payload");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]?.includes(`renderer exact failed for artifact "${id}"`), warnings[0]);
    assert.ok(warnings[0]?.includes("kaboom"));
  } finally {
    delete exactRenderers[id];
  }
});

test("an exact-layer renderer outranks the spec-family layer when registered", () => {
  const id = "spec_handoff";
  exactRenderers[id] = () => [{ kind: "paragraph", text: "exact view" }];
  try {
    const result = renderArtifact(artifact(id, SPEC_PAYLOADS.spec_handoff));
    assert.equal(result.layer, "exact");
    assert.equal(paragraphs(result.nodes)[0]?.text, "exact view");
  } finally {
    delete exactRenderers[id];
  }
});

test("a spec-layer renderer failure degrades to generic and increments a warning", () => {
  const throwing: Record<string, ArtifactRenderer> = {
    spec_intake_repo_map: () => {
      throw new Error("spec boom");
    },
  };
  const tables: RendererTables = { exact: {}, spec: throwing, typed: {} };
  const warnings: string[] = [];
  const result = renderArtifactWithTables(artifact("spec_intake_repo_map", SPEC_PAYLOADS.spec_intake_repo_map), tables, options(), warnings);
  assert.equal(result.layer, "generic-fallback");
  assert.ok(allText(result.nodes).includes("packages/core"), "generic fallback rendered the payload");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes('renderer spec-family failed for artifact "spec_intake_repo_map"'));
});

test("renderArtifact never mutates its input (frozen artifact)", () => {
  const input = artifact("review", TYPED_PAYLOADS.review);
  Object.freeze(input);
  if (input.body) Object.freeze(input.body);
  const warnings: string[] = [];
  const result = renderArtifact(input, options(), warnings);
  assert.equal(result.layer, "typed-schema");
  assert.ok(result.nodes.length > 0);
  assert.deepEqual(warnings, []);
});

test("spec renderers degrade to a bounded raw-text view when the redacted body no longer parses", () => {
  // Redaction drops whole secret lines by design — the embedded body is often
  // no longer valid JSON. The structured renderer must degrade, not throw.
  const redacted = redactedBody('{\n  "artifact_id": "spec-preparation",\n  "api_key": "sk-abc123",\n  "summary": "kept",\n');
  const result = renderArtifact(artifact("spec-preparation", undefined, { body: redacted }));
  assert.equal(result.layer, "spec-family");
  assert.ok(paragraphs(result.nodes).some((p) => p.text.includes("not valid JSON")));
  assert.ok(codeNodes(result.nodes).some((c) => c.text.includes("api_key")), "redacted raw text preserved verbatim");
});

// ── Status-only (body-less artifacts, compact policy) ────────────────────────

test("missing/pending/skipped/unreadable artifacts render status-only without a body", () => {
  const missing = renderArtifact(artifact("a_missing", undefined, { status: "missing" }));
  assert.equal(kvOf(missing.nodes, "status"), "missing");

  const pending = renderArtifact(artifact("b_pending", undefined, { status: "pending" }));
  assert.equal(kvOf(pending.nodes, "status"), "pending");

  const skipped = renderArtifact(artifact("c_skipped", undefined, { status: "skipped" }));
  assert.equal(kvOf(skipped.nodes, "status"), "skipped");

  const unreadable = renderArtifact(artifact("d_unreadable", undefined, { status: "unreadable", errorCategory: "invalid-json" }));
  assert.equal(kvOf(unreadable.nodes, "status"), "unreadable");
  assert.equal(kvOf(unreadable.nodes, "reason"), "invalid-json");
});

test("produced artifacts without a body (compact depth policy) render status + summary + keys", () => {
  const compact = artifact("review", undefined, {
    status: "produced",
    type: "review",
    summary: "Verdict: approve",
    keys: ["verdict", "findings"],
  });
  const result = renderArtifact(compact);
  assert.equal(kvOf(result.nodes, "status"), "produced");
  assert.ok(allText(result.nodes).includes("Verdict: approve"));
  assert.ok(headings(result.nodes).includes("Fields"));
  assert.ok(allText(result.nodes).includes("verdict"));
});

test("renderStatusOnly works directly and never throws for body-less artifacts", () => {
  const nodes = renderStatusOnly(artifact("bare", undefined, { status: "pending" }));
  assert.equal(kvOf(nodes, "status"), "pending");
});

// ── Shared value rendering ───────────────────────────────────────────────────

test("renderJsonValue handles non-object roots and drops depth-bounded subtrees", () => {
  const scalar = renderJsonValue("", 42, 3);
  assert.equal(kvOf(scalar, "value") ?? kvOf(scalar, ""), "42");
  const array = renderJsonValue("", [1, "two", true], 3);
  assert.equal(listsOf(array)[0]?.items.length, 3);
  const root = renderJsonValue("", { a: { b: { c: 1 } } }, 3);
  assert.ok(headings(root).includes("a"));
});

test("humanize turns snake_case field names into readable titles", () => {
  assert.equal(humanize("task_slices"), "Task Slices");
  assert.equal(humanize("spec_handoff"), "Spec Handoff");
  assert.equal(humanize("acceptance_criteria"), "Acceptance Criteria");
});
