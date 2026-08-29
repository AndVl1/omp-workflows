/**
 * Visualize OPT-A — architecture-1 contract/inventory tests.
 *
 * These tests freeze the dependency-free contracts (types.ts) and prove the
 * fixture inventory (visualize-fixtures.ts) covers every required edge. They
 * intentionally import ONLY the contract module and the self-contained
 * fixtures: no generated output, no events.jsonl, no vibe-report, no
 * report/engine internals beyond the fixtures' own redaction probe.
 *
 * SLICE-0/BG-1 is verified here: the source digest hashes canonical state
 * content plus per-artifact {id, byte size, bounded read-window bytes}, and
 * mtime appears nowhere in the digest, the model, or rendered fields —
 * touch-only changes cannot invalidate a digest.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readWorkflowProfile, workflowV2Fixture } from "./workflow-v2-fixtures.js";

import {
  BOUNDED_DIGEST_LENGTH,
  COMPACT_WORKFLOWS,
  DEFAULT_BODY_CAP_BYTES,
  DEFAULT_READ_WINDOW_BYTES,
  DETAILED_WORKFLOWS,
  EMPTY_BODY_MARKER,
  EXCLUDED_INPUT_NAMES,
  FULL_BODY_CAP_BYTES,
  FULL_READ_WINDOW_BYTES,
  LEGACY_ROOT_PATH_KEY,
  LEGACY_SESSION_ID,
  MAX_COLLECTION_ITEMS,
  MAX_DEPTH,
  MAX_SCALAR_CHARS,
  SPEC_FAMILY_IDS,
  TYPED_ARTIFACT_IDS,
  VISUALIZE_OUTPUT_FILES,
  VISUALIZE_OUTPUT_ROOT,
  VOLATILE_FIELDS,
  compareArtifactIds,
  compareSessions,
  defaultRenderOptions,
  depthPolicyBehavior,
  depthPolicyFor,
  fragmentForArtifact,
  fragmentForSession,
  formatBoundsMarker,
  formatTruncationMarker,
  isRegressionId,
  isSafePathKey,
  isSpecFamilyId,
  isTypedArtifactId,
  resolveRendererLayer,
  serializeDigestInput,
  sessionPagePath,
  stalenessOf,
  type ArtifactStatus,
  type LinkKind,
  type LinkTargetState,
  type SessionStatus,
  type VisualizationSnapshot,
  type VisualizationStatus,
} from "../src/visualize/types.js";

import {
  CRLF_SAMPLE,
  DIGEST_INVARIANCE_CASES,
  FIXED_GENERATED_AT,
  HTML_LIKE_SAMPLE,
  LARGE_COLLECTION_SAMPLE,
  LARGE_SCALAR_TEXT,
  REQUIRED_EDGE_GROUPS,
  SAFE_PATH_KEY_CASES,
  UNICODE_SAMPLE,
  UNSAFE_ARTIFACT_IDS,
  UNSAFE_DECLARED_PATHS,
  buildExpectedBugFixSession,
  buildExpectedCtoMarkdownTerminalSession,
  buildExpectedSpecPreparationSession,
  buildExpectedZeroArtifactSession,
  buildFixtureInventory,
  buildGoldenAllSnapshot,
  buildMtimePairs,
  buildSelectedManifest,
  deepJson,
  digestFor,
  digestInputFor,
  digestInputFrom,
  expectedRedactedBody,
  withInjectedSecretKeys,
} from "./fixtures/visualize-fixtures.js";

const ARTIFACT_STATUSES: readonly ArtifactStatus[] = ["produced", "missing", "pending", "skipped", "unreadable"];
const SESSION_STATUSES: readonly SessionStatus[] = ["complete", "degraded"];
const FULL_STATUS_VOCABULARY: readonly VisualizationStatus[] = [
  "produced",
  "missing",
  "pending",
  "skipped",
  "unreadable",
  "degraded",
];

/** Recursively assert no key named `mtime` exists anywhere in a model. */
function assertNoMtimeField(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) assertNoMtimeField(v, `${path}[${i}]`);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      assert.notEqual(k.toLowerCase(), "mtime", `mtime must never be a rendered field (found at ${path}.${k})`);
      assertNoMtimeField(v, `${path}.${k}`);
    }
  }
}

/** Deep-strip the volatile fields (generatedAt + staleness) for determinism checks. */
function withoutVolatileFields(snapshot: VisualizationSnapshot): unknown {
  const copy: unknown = structuredClone(snapshot);
  const root = copy as {
    generatedAt?: string;
    manifest: { generatedAt?: string };
    sessions: Array<{ provenance: { generatedAt?: string; staleness?: string } }>;
  };
  delete root.generatedAt;
  delete root.manifest.generatedAt;
  for (const session of root.sessions) {
    delete session.provenance.generatedAt;
    delete session.provenance.staleness;
  }
  return copy;
}

// ── Inventory completeness ────────────────────────────────────────────────────

test("visualize contract: fixture inventory covers every required edge group", () => {
  const inventory = buildFixtureInventory();
  const ids = new Set<string>();
  assert.ok(inventory.cases.length >= 18, `expected >= 18 cases, got ${inventory.cases.length}`);

  for (const fixture of inventory.cases) {
    assert.ok(!ids.has(fixture.id), `duplicate fixture id ${fixture.id}`);
    ids.add(fixture.id);
    assert.ok(fixture.groups.length > 0, `${fixture.id}: no edge groups`);
    assert.ok(isSafePathKey(fixture.input.pathKey), `${fixture.id}: unsafe pathKey ${fixture.input.pathKey}`);
    assert.ok(SESSION_STATUSES.includes(fixture.input.expected.status), `${fixture.id}: bad session status`);

    const discoveredIds = new Set(fixture.input.artifacts.map((f) => f.id));
    const declaredIds = new Set(Object.keys(fixture.input.declaredArtifacts));
    const expectedIds = Object.keys(fixture.input.expected.artifactStatuses);

    // every expected status refers to a known (declared or discovered) id
    for (const id of expectedIds) {
      assert.ok(declaredIds.has(id) || discoveredIds.has(id), `${fixture.id}: expected status for unknown id ${id}`);
    }
    // every declared/discovered id carries an expected status (total coverage)
    for (const id of [...declaredIds, ...discoveredIds]) {
      const status = fixture.input.expected.artifactStatuses[id];
      assert.ok(status !== undefined, `${fixture.id}: missing expected status for ${id}`);
      assert.ok(ARTIFACT_STATUSES.includes(status), `${fixture.id}: bad artifact status ${status}`);
    }
    // on-disk files are produced or unreadable; fileless declared ids are
    // missing/pending/skipped — a file can never be "missing"
    for (const id of discoveredIds) {
      const status = fixture.input.expected.artifactStatuses[id];
      assert.ok(status === "produced" || status === "unreadable", `${fixture.id}: discovered ${id} has status ${status}`);
    }
    for (const id of declaredIds) {
      if (discoveredIds.has(id)) continue;
      const status = fixture.input.expected.artifactStatuses[id];
      assert.ok(
        status === "missing" || status === "pending" || status === "skipped",
        `${fixture.id}: fileless declared ${id} has status ${status}`,
      );
    }
  }

  for (const group of REQUIRED_EDGE_GROUPS) {
    const cases = inventory.groups[group];
    assert.ok(cases && cases.length > 0, `missing fixture coverage for edge group ${group}`);
  }

  // pinned schema counts: 22 typed ids, 7 known spec-family ids
  assert.equal(TYPED_ARTIFACT_IDS.length, 22);
  assert.equal(SPEC_FAMILY_IDS.length, 7);
});

test("visualize contract: AC-1 fixture mixes typed, freeform hostile, slot, missing and corrupt", () => {
  const inventory = buildFixtureInventory();
  const mixed = inventory.cases.find((c) => c.id === "mixed-state");
  assert.ok(mixed, "mixed-state fixture must exist");
  const statuses = mixed.input.expected.artifactStatuses;
  assert.equal(statuses.discovery, "produced"); // typed
  assert.equal(statuses["discovery-analyst"], "produced"); // slot
  assert.equal(statuses.spec_intake_repo_map, "produced"); // freeform spec with hostile strings
  assert.equal(statuses.dod, "missing"); // declared-but-missing
  assert.equal(statuses.corrupt, "unreadable"); // corrupt JSON → unreadable, generation continues
  assert.equal(mixed.input.expected.status, "complete"); // corrupt content does not abort the session
});

test("visualize contract: zero-artifact session and excluded inputs are covered", () => {
  const inventory = buildFixtureInventory();
  const zero = inventory.cases.find((c) => c.id === "zero-artifacts");
  assert.equal(Object.keys(zero?.input.declaredArtifacts ?? {}).length, 0);
  assert.equal(zero?.input.artifacts.length, 0);
  assert.ok(zero?.input.expected.warnings?.includes("no artifacts yet"));

  const excluded = inventory.cases.find((c) => c.id === "excluded-inputs");
  assert.ok(excluded, "excluded-inputs fixture must exist");
  assert.ok(excluded.input.excludedPaths.some((p) => p.endsWith("events.jsonl")));
  assert.ok(excluded.input.excludedPaths.some((p) => p.includes("vibe-report")));
  assert.ok(excluded.input.excludedPaths.some((p) => p.startsWith(".work-state/visualize")));
  assert.equal(excluded.input.artifacts.length, 0);
});

// ── SLICE-0/BG-1: mtime-free digest and model ─────────────────────────────────

test("visualize contract: SLICE-0/BG-1 mtime never enters the digest or the model", () => {
  // touch-invariance: identical content with different mtimes → identical
  // canonical serialization and identical sha256 digests
  for (const pair of buildMtimePairs()) {
    const serializedA = serializeDigestInput(digestInputFor(pair.a));
    const serializedB = serializeDigestInput(digestInputFor(pair.b));
    assert.equal(serializedA, serializedB, pair.id);
    const hashA = createHash("sha256").update(serializedA, "utf8").digest("hex");
    const hashB = createHash("sha256").update(serializedB, "utf8").digest("hex");
    assert.equal(hashA, hashB, pair.id);
  }

  // digest input mutations: content, byte size, read window, presence
  for (const fixture of DIGEST_INVARIANCE_CASES) {
    const serializedA = serializeDigestInput(fixture.a);
    const serializedB = serializeDigestInput(fixture.b);
    if (fixture.identical) {
      assert.equal(serializedA, serializedB, fixture.id);
    } else {
      assert.notEqual(serializedA, serializedB, fixture.id);
    }
  }

  // the canonical serialization cannot carry mtime by construction
  const probe = digestInputFrom("state", [{ id: "x", content: "hello" }]);
  assert.ok(!serializeDigestInput(probe).includes("mtime"));

  // golden models never render an mtime field anywhere
  const goldens = [
    buildExpectedSpecPreparationSession(),
    buildExpectedBugFixSession(),
    buildExpectedZeroArtifactSession(),
    buildExpectedCtoMarkdownTerminalSession(),
  ];
  for (const golden of goldens) assertNoMtimeField(golden);
  assertNoMtimeField(buildGoldenAllSnapshot());

  // bounded digest is the only rendered digest form
  const inventory = buildFixtureInventory();
  const specCase = inventory.cases.find((c) => c.id === "feature-spec-preparation");
  assert.ok(specCase);
  const digest = digestFor(specCase.input);
  assert.equal(digest.algorithm, "sha256");
  assert.equal(digest.full.length, 64);
  assert.equal(digest.bounded.length, BOUNDED_DIGEST_LENGTH);
  assert.equal(digest.bounded, digest.full.slice(0, BOUNDED_DIGEST_LENGTH));
  assert.ok(digest.inputBytes > 0);

  // the golden provenance digest equals a fresh computation from the input
  const golden = buildExpectedSpecPreparationSession();
  assert.equal(golden.provenance.sourceDigest.full, digest.full);
});

// ── Statuses ──────────────────────────────────────────────────────────────────

test("visualize contract: status vocabulary produced/missing/pending/skipped/unreadable/degraded", () => {
  // artifact vocabulary is pinned to five values
  assert.deepEqual(ARTIFACT_STATUSES, ["produced", "missing", "pending", "skipped", "unreadable"]);
  // the full reader-visible vocabulary adds the session-level degraded status
  assert.deepEqual(FULL_STATUS_VOCABULARY, [
    "produced",
    "missing",
    "pending",
    "skipped",
    "unreadable",
    "degraded",
  ]);

  const inventory = buildFixtureInventory();
  const degraded = inventory.cases.filter((c) => c.input.expected.status === "degraded");
  assert.ok(degraded.length >= 2, "markdown CTO fallbacks must be visible degraded sessions");

  // skipped means an artifact produced by a persisted skipped stage (pinned)
  const bugFix = inventory.cases.find((c) => c.id === "feature-bug-fix");
  assert.equal(bugFix?.input.expected.artifactStatuses.review, "skipped");

  // corrupt JSON within the read window is unreadable, not produced
  const broken = inventory.cases.find((c) => c.id === "corrupt-unreadable-empty");
  assert.equal(broken?.input.expected.artifactStatuses.corrupt, "unreadable");
  // empty files stay produced with an empty marker
  assert.equal(broken?.input.expected.artifactStatuses.empty, "produced");
  // oversized files are produced with a preview, not falsely corrupt
  const oversized = inventory.cases.find((c) => c.id === "oversized");
  assert.equal(oversized?.input.expected.artifactStatuses.big, "produced");
});

// ── Safe path keys and legacy collision ───────────────────────────────────────

test("visualize contract: safe path keys reject escapes, separators and hostile ids", () => {
  for (const fixture of SAFE_PATH_KEY_CASES) {
    assert.equal(isSafePathKey(fixture.value), fixture.safe, `isSafePathKey(${JSON.stringify(fixture.value)})`);
  }
  for (const id of UNSAFE_ARTIFACT_IDS) {
    assert.ok(!isSafePathKey(id), `unsafe id must be rejected: ${JSON.stringify(id)}`);
  }
  for (const path of UNSAFE_DECLARED_PATHS) {
    assert.ok(!isSafePathKey(path), `unsafe declared path must be rejected: ${path}`);
  }
});

test("visualize contract: legacy collision keeps distinct path keys and kind identity", () => {
  const inventory = buildFixtureInventory();
  const legacyRoot = inventory.cases.find((c) => c.id === "legacy-root");
  const featureLegacy = inventory.cases.find((c) => c.id === "feature-named-legacy");

  assert.equal(legacyRoot?.input.kind, "legacy");
  assert.equal(legacyRoot?.input.id, LEGACY_SESSION_ID);
  assert.equal(legacyRoot?.input.pathKey, LEGACY_ROOT_PATH_KEY);

  assert.equal(featureLegacy?.input.kind, "feature");
  assert.equal(featureLegacy?.input.id, "legacy");
  assert.equal(featureLegacy?.input.pathKey, "legacy");

  assert.notEqual(legacyRoot?.input.pathKey, featureLegacy?.input.pathKey);

  // stable identity anchors, collision-free and deterministic
  assert.equal(fragmentForSession("visualize"), "viz-visualize");
  assert.equal(fragmentForArtifact("visualize", "spec-preparation"), "viz-visualize-spec-preparation");
  assert.equal(fragmentForArtifact("visualize", "a/b"), "viz-visualize-a%2Fb");
  assert.notEqual(fragmentForArtifact("visualize", "a/b"), fragmentForArtifact("visualize", "a%2Fb"));
});

// ── Deterministic ordering ────────────────────────────────────────────────────

test("visualize contract: deterministic total ordering (never filesystem order)", () => {
  // sessions: updated_at descending, then kind, then id; unknown timestamps last
  const sessions = [
    { updatedAt: "2026-08-19T10:00:00.000Z", kind: "feature" as const, id: "b" },
    { updatedAt: "2026-08-19T10:00:00.000Z", kind: "feature" as const, id: "a" },
    { updatedAt: "2026-08-19T09:00:00.000Z", kind: "cto" as const, id: "z" },
    { updatedAt: undefined, kind: "legacy" as const, id: "legacy" },
  ];
  const sessionOrder = [...sessions].sort(compareSessions).map((s) => s.id);
  assert.deepEqual(sessionOrder, ["a", "b", "z", "legacy"]);

  // artifacts: declared produces order, slots right after their base, extras lexicographic
  const declaredOrder = ["spec_intake_repo_map", "spec_requirements_edge_cases", "spec_architecture_tasks"];
  const unordered = [
    "spec_requirements_edge_cases",
    "zzz_extra",
    "aaa_extra",
    "spec_intake_repo_map",
    "spec_architecture_tasks-architect",
    "spec_architecture_tasks",
  ];
  const artifactOrder = [...unordered].sort((a, b) => compareArtifactIds(a, b, declaredOrder));
  assert.deepEqual(artifactOrder, [
    "spec_intake_repo_map",
    "spec_requirements_edge_cases",
    "spec_architecture_tasks",
    "spec_architecture_tasks-architect",
    "aaa_extra",
    "zzz_extra",
  ]);

  // the golden spec-preparation session respects the pinned artifact order
  const golden = buildExpectedSpecPreparationSession();
  const goldenOrder = golden.artifacts.map((a) => a.id);
  const goldenDeclared = [
    "spec_intake_repo_map",
    "spec_requirements_edge_cases",
    "spec_options_decisions",
    "spec_architecture_tasks",
    "spec_completeness",
    "spec-preparation",
    "spec_handoff",
  ];
  assert.deepEqual([...goldenOrder].sort((a, b) => compareArtifactIds(a, b, goldenDeclared)), goldenOrder);
  assert.deepEqual(goldenOrder, [
    "spec_intake_repo_map",
    "spec_intake_repo_map-analyst",
    "spec_intake_repo_map-tech-researcher",
    "spec_requirements_edge_cases",
    "spec_options_decisions",
    "spec_architecture_tasks",
    "spec_completeness",
    "spec-preparation",
    "spec_handoff",
  ]);

  // golden snapshot sessions are compareSessions-sorted
  const snapshot = buildGoldenAllSnapshot();
  const snapshotIds = snapshot.sessions.map((s) => s.identity.id);
  const sortedIds = [...snapshot.sessions]
    .sort((a, b) =>
      compareSessions(
        { updatedAt: a.provenance.sourceUpdatedAt, kind: a.identity.kind, id: a.identity.id },
        { updatedAt: b.provenance.sourceUpdatedAt, kind: b.identity.kind, id: b.identity.id },
      ),
    )
    .map((s) => s.identity.id);
  assert.deepEqual(snapshotIds, sortedIds);
});

// ── Render config and depth policy ────────────────────────────────────────────

test("visualize contract: render config defaults, bounds and depth policy", () => {
  assert.equal(DEFAULT_BODY_CAP_BYTES, 16384);
  assert.equal(FULL_BODY_CAP_BYTES, 262144);
  assert.equal(DEFAULT_READ_WINDOW_BYTES, 16384);
  assert.equal(FULL_READ_WINDOW_BYTES, 262144);
  assert.equal(MAX_DEPTH, 8);
  assert.equal(MAX_COLLECTION_ITEMS, 200);
  assert.equal(MAX_SCALAR_CHARS, 8192);

  assert.deepEqual(defaultRenderOptions(false), {
    full: false,
    bodyCapBytes: 16384,
    readWindowBytes: 16384,
    bounds: { maxDepth: 8, maxCollectionItems: 200, maxScalarChars: 8192 },
  });
  const full = defaultRenderOptions(true);
  assert.equal(full.bodyCapBytes, FULL_BODY_CAP_BYTES);
  assert.equal(full.readWindowBytes, FULL_READ_WINDOW_BYTES);

  assert.deepEqual(DETAILED_WORKFLOWS, ["spec-preparation"]);
  assert.deepEqual(COMPACT_WORKFLOWS, ["bug-fix"]);
  assert.equal(depthPolicyFor("spec-preparation"), "detailed");
  assert.equal(depthPolicyFor("bug-fix"), "compact");
  assert.equal(depthPolicyFor("research"), "default");
  assert.equal(depthPolicyFor("anything-unknown"), "default");
  assert.deepEqual(depthPolicyBehavior("detailed"), { bodiesByDefault: true });
  assert.deepEqual(depthPolicyBehavior("compact"), { bodiesByDefault: false });
  assert.deepEqual(depthPolicyBehavior("default"), { bodiesByDefault: false });
});

// ── Provenance and staleness ──────────────────────────────────────────────────

test("visualize contract: provenance staleness total rule (AC-11)", () => {
  // state.updated_at later than generated_at → stale; equal → fresh; absent → unknown
  assert.equal(stalenessOf("2026-08-19T13:00:00.000Z", FIXED_GENERATED_AT), "stale");
  assert.equal(stalenessOf(FIXED_GENERATED_AT, FIXED_GENERATED_AT), "fresh");
  assert.equal(stalenessOf("2026-08-19T11:00:00.000Z", FIXED_GENERATED_AT), "fresh");
  assert.equal(stalenessOf(undefined, FIXED_GENERATED_AT), "unknown");

  const inventory = buildFixtureInventory();
  const legacyRoot = inventory.cases.find((c) => c.id === "legacy-root");
  assert.equal(legacyRoot?.input.expected.staleness, "stale"); // updated 13:00 > generated 12:00
  const markdown = inventory.cases.find((c) => c.id === "cto-markdown-active");
  assert.equal(markdown?.input.expected.staleness, "unknown"); // no timestamp in markdown state

  const golden = buildExpectedSpecPreparationSession();
  assert.equal(golden.provenance.staleness, "fresh");
  assert.equal(golden.provenance.sourceUpdatedAt, "2026-08-19T10:00:00.000Z");
  assert.equal(
    golden.provenance.profileHash,
    workflowV2Fixture(readWorkflowProfile("spec-preparation"), { runId: "visualize" }).run_identity.profile_identity.fingerprint,
  );
  assert.equal(golden.provenance.renderer.name, "omp-workflows-visualize");
  assert.ok(golden.provenance.generatedAt === FIXED_GENERATED_AT);

  // only explicitly volatile fields may differ across identical-input runs
  assert.deepEqual(VOLATILE_FIELDS, ["generatedAt", "provenance.generatedAt", "manifest.generatedAt", "staleness"]);
});

// ── Renderer precedence ───────────────────────────────────────────────────────

test("visualize contract: renderer precedence spec-family → typed-schema → generic fallback", () => {
  for (const id of SPEC_FAMILY_IDS) assert.equal(resolveRendererLayer(id), "spec-family", id);
  assert.equal(resolveRendererLayer("spec_future_draft"), "spec-family");
  assert.equal(resolveRendererLayer("spec-unknown"), "spec-family");
  for (const id of TYPED_ARTIFACT_IDS) assert.equal(resolveRendererLayer(id), "typed-schema", id);
  assert.equal(resolveRendererLayer("regression_perf"), "generic-fallback");
  assert.equal(resolveRendererLayer("freeform_note"), "generic-fallback");
  assert.equal(resolveRendererLayer("notes"), "generic-fallback");

  assert.equal(isTypedArtifactId("dod"), true);
  assert.equal(isTypedArtifactId("spec_handoff"), false);
  assert.equal(isSpecFamilyId("spec_handoff"), true);
  assert.equal(isRegressionId("regression_001"), true);
  assert.equal(isRegressionId("spec_handoff"), false);
});

// ── Link targets ──────────────────────────────────────────────────────────────

test("visualize contract: link targets use stable identity and explicit states", () => {
  const targetStates: readonly LinkTargetState[] = ["resolved", "unavailable", "degraded"];
  const linkKinds: readonly LinkKind[] = ["session", "artifact", "stage", "section", "status-detail"];

  // stable anchors from validated identity
  const sessionAnchor = fragmentForSession("visualize");
  const artifactAnchor = fragmentForArtifact("visualize", "spec-preparation");
  assert.equal(sessionAnchor, "viz-visualize");
  assert.equal(artifactAnchor, "viz-visualize-spec-preparation");

  // missing/unreadable/degraded targets remain explicit reachable states
  const golden = buildExpectedSpecPreparationSession();
  const missing = golden.artifacts.find((a) => a.status === "missing");
  assert.equal(missing?.id, "spec_completeness");
  const unreadableCase = buildFixtureInventory().cases.find((c) => c.id === "corrupt-unreadable-empty");
  assert.equal(unreadableCase?.input.expected.artifactStatuses.corrupt, "unreadable");

  // link graph vocabulary is exactly what the reader journey needs
  assert.deepEqual(targetStates, ["resolved", "unavailable", "degraded"]);
  assert.deepEqual(linkKinds, ["session", "artifact", "stage", "section", "status-detail"]);
});

// ── Manifest and output metadata ──────────────────────────────────────────────

test("visualize contract: manifest and output metadata are deterministic", () => {
  const snapshot = buildGoldenAllSnapshot();
  const manifest = snapshot.manifest;
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.scope, "all");
  assert.equal(manifest.renderer.version, "1.0.0");
  assert.equal(manifest.sessions.length, 4);

  const artifactTotal = snapshot.sessions.reduce((n, s) => n + s.artifacts.length, 0);
  assert.deepEqual(manifest.counts, {
    discoveredSessions: 4,
    generatedSessions: 4,
    generatedPages: 4 * 2 + 2, // session md+html per session, hub md+html
    staleSessions: 0,
    degradedSessions: 1,
    artifactTotal,
    deadLinks: 0,
  });

  for (const entry of manifest.sessions) {
    assert.deepEqual(entry.pages, [
      sessionPagePath(entry.kind, entry.pathKey, "md"),
      sessionPagePath(entry.kind, entry.pathKey, "html"),
    ]);
  }

  // REQ-8: stale sessions carry artifact counts plus a regenerate hint
  const staleEntry = manifest.sessions.find((e) => e.staleness === "stale");
  assert.equal(staleEntry, undefined); // golden sessions are fresh at the fixed clock
  const inventory = buildFixtureInventory();
  const legacyRoot = inventory.cases.find((c) => c.id === "legacy-root");
  assert.equal(legacyRoot?.input.expected.staleness, "stale");
  assert.ok((legacyRoot?.input.expected.warnings?.length ?? 0) >= 0);
  const countsOf = (s: { artifacts: Array<{ status: ArtifactStatus }> }) => {
    const counts = { produced: 0, missing: 0, pending: 0, skipped: 0, unreadable: 0 };
    for (const a of s.artifacts) counts[a.status] += 1;
    return counts;
  };
  assert.deepEqual(countsOf(buildExpectedBugFixSession()), { produced: 3, missing: 1, pending: 2, skipped: 1, unreadable: 0 });

  // selected scope is visibly partial; --all is completeness mode
  const selected = buildSelectedManifest();
  assert.equal(selected.scope, "selected");
  assert.equal(selected.sessions.length, 1);
  assert.ok(selected.counts.generatedSessions < buildGoldenAllSnapshot().manifest.counts.generatedSessions);

  // frozen output layout
  assert.equal(VISUALIZE_OUTPUT_ROOT, ".work-state/visualize");
  assert.deepEqual(VISUALIZE_OUTPUT_FILES, { hubMarkdown: "index.md", hubHtml: "index.html", manifest: "manifest.json" });
  assert.equal(sessionPagePath("feature", "visualize", "md"), "sessions/feature/visualize.md");
  assert.equal(sessionPagePath("cto", "run-1", "html"), "sessions/cto/run-1.html");
});

test("visualize contract: fixed-clock determinism and volatile-only deltas", () => {
  const a = buildGoldenAllSnapshot();
  const b = buildGoldenAllSnapshot();
  assert.deepEqual(b, a, "rebuild with the same generatedAt must be byte-identical");

  const later = buildGoldenAllSnapshot("2026-08-20T00:00:00.000Z");
  assert.notEqual(later.manifest.generatedAt, a.manifest.generatedAt);
  // after stripping generatedAt + staleness, the non-volatile model is identical
  assert.deepEqual(withoutVolatileFields(later), withoutVolatileFields(a));
});

// ── Bounded redacted snapshot fields ──────────────────────────────────────────

test("visualize contract: bounded redacted snapshot fields carry visible markers", () => {
  assert.equal(formatTruncationMarker(45213, 16384), "…[truncated 45213/16384 bytes]");
  assert.equal(formatBoundsMarker(true, 12, 3), "…[bounded: depth 8 truncated +12 collections +3 scalars]");

  // oversized source → preview with originalBytes/capBytes and a marker
  const oversized = expectedRedactedBody(JSON.stringify({ data: "y".repeat(19000) }));
  assert.equal(oversized.preview, true);
  assert.equal(oversized.truncated, true);
  assert.ok(oversized.originalBytes > DEFAULT_READ_WINDOW_BYTES);
  assert.equal(oversized.capBytes, DEFAULT_BODY_CAP_BYTES);
  assert.ok(oversized.marker.startsWith("…[truncated "));
  assert.ok(oversized.marker.includes(String(oversized.originalBytes)));
  assert.ok(oversized.marker.includes(String(oversized.capBytes)));

  // redaction applies before the cap at every verbosity — secrets never embed.
  // Real quoted JSON keys are dropped as whole lines; prose key lines inside
  // string values are dropped by the prose patterns. (Secret VALUES nested
  // inside unrelated string values are not line-redactable and are out of
  // scope for the reused line-drop pipeline.)
  const proseSecrets = ['api_key = "sk-abc123"', "password: hunter2", "Authorization: Bearer abc.def.ghi"];
  const hostile = withInjectedSecretKeys(
    JSON.stringify({ artifact_id: "probe", notes: [UNICODE_SAMPLE, HTML_LIKE_SAMPLE, CRLF_SAMPLE, ...proseSecrets] }, null, 2),
  );
  const redacted = expectedRedactedBody(hostile);
  assert.ok(!redacted.text.includes("sk-abc123"), "api_key secret value must be redacted");
  assert.ok(!redacted.text.includes("t0k3n-secret"), "token secret value must be redacted");
  assert.ok(!redacted.text.includes("hunter2"), "password must be redacted");
  assert.ok(!redacted.text.includes("abc.def.ghi"), "bearer token must be redacted");

  // empty content becomes the explicit empty marker, never an empty string
  const empty = expectedRedactedBody("");
  assert.equal(empty.text, EMPTY_BODY_MARKER);
  assert.equal(empty.preview, false);

  // hostile samples respect the pinned bounds (depth/collections/scalars)
  assert.ok(JSON.parse(LARGE_COLLECTION_SAMPLE).items.length > MAX_COLLECTION_ITEMS);
  assert.ok(LARGE_SCALAR_TEXT.length > MAX_SCALAR_CHARS);
  const depth = JSON.stringify(deepJson(12));
  assert.ok(depth.length > 0);
});

// ── Fixture self-containment ──────────────────────────────────────────────────

test("visualize contract: fixtures never import generated output, events or vibe-report", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixtureSource = readFileSync(join(here, "fixtures", "visualize-fixtures.ts"), "utf8");
  // scan whole import statements (specifier can be on a continuation line)
  const importBlocks = fixtureSource.matchAll(/^import\b[\s\S]*?from\s+('[^']+'|"[^"]+")/gm);
  let importCount = 0;
  for (const match of importBlocks) {
    importCount += 1;
    const specifier = (match[1] ?? "").replace(/^['"]|['"]$/g, "");
    assert.ok(
      specifier.includes("visualize/types.js") ||
        specifier.includes("workflow-v2/types.js") ||
        specifier.includes("report/redact.js") ||
        specifier === "../workflow-v2-fixtures.js" ||
        specifier.startsWith("node:"),
      `fixture has an unexpected import specifier: ${specifier}`,
    );
    assert.ok(!specifier.includes("vibe-report"), `fixture imports vibe-report: ${specifier}`);
    assert.ok(!specifier.includes("events"), `fixture imports events output: ${specifier}`);
    assert.ok(!specifier.includes(".work-state"), `fixture imports generated .work-state output: ${specifier}`);
  }
  assert.ok(importCount >= 2, `expected at least the contract + redactor imports, got ${importCount}`);

  // the contract names the excluded inputs explicitly
  assert.deepEqual(EXCLUDED_INPUT_NAMES, ["events.jsonl", "vibe-report"]);

  // and the inventory exercises them
  const inventory = buildFixtureInventory();
  const excluded = inventory.cases.find((c) => c.id === "excluded-inputs");
  assert.ok(excluded, "excluded-inputs fixture must exist");
  assert.ok(excluded.input.excludedPaths.includes(".work-state/visualize/index.html"));
});
