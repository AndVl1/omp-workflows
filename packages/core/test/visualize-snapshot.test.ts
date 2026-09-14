/**
 * Visualize OPT-A — one-read canonical snapshot (architecture-3) model tests.
 *
 * Defends the observable boundaries and invariants of buildSessionSnapshot:
 * statuses produced/missing/pending/skipped/unreadable, deterministic
 * ordering (declared produces order → native slots → extras), stage
 * progress with attached slots, provenance/staleness (AC-11), the SLICE-0/
 * BG-1 source digest (mtime-free, cross-workspace and touch-invariant),
 * native mid-tasks pending shared artifact, zero-artifact sessions, legacy/CTO
 * layouts, corrupt peers without abort, and strict read-only (no canonical
 * mutation). Fixed generated_at for determinism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSessionSnapshot } from "../src/visualize/snapshot.js";
import { resolveRenderConfig } from "../src/visualize/render-config.js";
import { LEGACY_ROOT_PATH_KEY, LEGACY_SESSION_ID } from "../src/visualize/types.js";
import {
  listDoWorkSources,
  resolveCtoSource,
  resolveDoWorkSource,
  type SessionSourceEntry,
} from "../src/report/session-source.js";
import {
  CORRUPT_JSON_SAMPLE,
  FIXED_GENERATED_AT,
  buildFixtureInventory,
  digestFor,
  featureSession,
  ctoStateJson,
  artifact,
  hostileSpecBody,
  DEEP_JSON_SAMPLE,
  LARGE_COLLECTION_SAMPLE,
  LARGE_SCALAR_TEXT,
  type CanonicalSessionInput,
} from "./fixtures/visualize-fixtures.js";

// ── Harness: materialize a canonical input onto a temp workspace ────────────

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "viz-snapshot-"));
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

/** Write the canonical input onto disk (state + declared/discovered files). */
function materialize(cwd: string, input: CanonicalSessionInput): void {
  write(join(cwd, stateRelPath(input)), input.state.content);
  for (const f of input.artifacts) write(join(cwd, f.relPath), f.content);
}

/** The discovered entry for an input via its canonical state file. */

function entryOf(cwd: string, input: CanonicalSessionInput): SessionSourceEntry {
  if (input.kind === "cto") {
    const resolved = resolveCtoSource(cwd, input.id);
    if (!resolved) throw new Error(`cto run not resolved: ${input.id}`);
    return resolved;
  }
  const resolved = resolveDoWorkSource(cwd, input.id);
  if (!resolved) throw new Error(`do-work session not resolved: ${input.id}`);
  return resolved;
}

const specInput = (): CanonicalSessionInput => {
  const found = buildFixtureInventory().cases.find((c) => c.id === "feature-spec-preparation");
  if (!found) throw new Error("missing fixture case");
  return found.input;
};

function typedJson(id: string): string {
  return JSON.stringify({ artifact_id: id, artifact_type: id, status: "complete", notes: "typed payload", summary: `Summary of ${id}` }, null, 2);
}

function slotJson(base: string, role: string): string {
  return JSON.stringify({ artifact_id: `${base}-${role}`, artifact_type: "slot", base, role, status: "complete", findings: ["x"] }, null, 2);
}

// ── 1. Feature · spec-preparation: statuses, order, digest, bodies ───────────

test("snapshot: spec-preparation session matches the frozen golden model (BG-1 digest, stages, statuses)", () => {
  const cwd = tmpWorkspace();
  try {
    const input = specInput();
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);

    assert.equal(session.schema, 1);
    assert.equal(session.status, "complete");
    assert.deepEqual(session.identity, {
      kind: "feature",
      id: "visualize",
      pathKey: "visualize",
      title: "visualize feature worktree",
      task: "Visualize workflow specs: readable overview + internal navigation.",
      workflow: "spec-preparation",
      sourceFormat: "json",
      isLegacy: false,
      degraded: false,
    });

    // Declared produces order → slots after their base → extras lexicographic.
    assert.deepEqual(
      session.artifacts.map((a) => a.id),
      [
        "specify_draft",
        "specify_draft-analyst",
        "specify_draft-tech-researcher",
        "plan_draft",
        "task_graph",
        "spec-preparation",
        "spec_handoff",
      ],
    );
    const statuses = Object.fromEntries(session.artifacts.map((a) => [a.id, a.status]));
    assert.deepEqual(statuses, {
      specify_draft: "produced",
      "specify_draft-analyst": "produced",
      "specify_draft-tech-researcher": "produced",
      plan_draft: "produced",
      task_graph: "missing",
      "spec-preparation": "produced",
      spec_handoff: "produced",
    });
    assert.deepEqual(session.warnings, [
      "declared artifact task_graph is missing",
      "artifact spec_handoff is larger than the read window: head preview (original bytes > window)",
    ]);

    // Native stage progress with attached slot artifactIds. The specify, plan,
    // and tasks stages omit titles; generic handoff retains the "Handoff" title.
    assert.deepEqual(session.stages, [
      { stageId: "specify", status: "done", artifactIds: ["specify_draft", "specify_draft-analyst", "specify_draft-tech-researcher"] },
      { stageId: "plan", status: "done", artifactIds: ["plan_draft"] },
      { stageId: "tasks", status: "in_progress", artifactIds: ["task_graph"] },
      { stageId: "handoff", title: "Handoff", status: "in_progress", artifactIds: ["spec-preparation", "spec_handoff"] },
    ]);

    // SLICE-0/BG-1: the digest equals the frozen helper over identical inputs.
    assert.equal(session.provenance.sourceDigest.full, digestFor(input).full);
    assert.equal(session.provenance.sourceDigest.bounded, digestFor(input).bounded);
    assert.equal(session.provenance.sourceUpdatedAt, input.state.updatedAt);
    assert.equal(session.provenance.profileHash, "p-visualize-1");
    assert.equal(session.provenance.staleness, "fresh");
    assert.equal(session.provenance.generatedAt, FIXED_GENERATED_AT);

    // Slot ownership and slotFor identity.
    const slot = session.artifacts.find((a) => a.id === "specify_draft-tech-researcher");
    assert.ok(slot);
    assert.equal(slot.owner, "specify");
    assert.equal(slot.slotFor, "specify_draft");
    assert.equal(slot.status, "produced");

    // Detailed policy → embedded redacted body; in-window parse gives keys/summary.
    const prep = session.artifacts.find((a) => a.id === "spec-preparation");
    assert.ok(prep?.body, "detailed workflow embeds bodies by default");
    assert.ok(prep.keys && prep.keys.includes("artifact_id"));
    assert.ok(prep.summary);
    assert.equal(prep.bytes, Buffer.byteLength(hostileSpecBody(), "utf8"));
    assert.equal(prep.source?.format, "json");
    assert.equal(prep.source?.readBytes, prep.bytes, "in-window file fully read");

    // Missing artifact carries no source.
    const missing = session.artifacts.find((a) => a.id === "task_graph");
    assert.equal(missing?.source, undefined);
    assert.equal(missing?.bytes, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 2. Oversized head previews: produced, explicit, never falsely corrupt ───

test("snapshot: oversized artifacts stay produced with preview markers; only in-window parse failures are unreadable", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "oversized",
      pathKey: "oversized",
      task: "Probe byte caps and head previews.",
      workflow: "spec-preparation",
      updatedAt: "2026-08-19T01:00:00.000Z",
      stages: [{ id: "summary", status: "done" }],
      declared: {
        big: ".work-state/features/oversized/artifacts/big.json",
        huge: ".work-state/features/oversized/artifacts/huge.json",
        broken_big: ".work-state/features/oversized/artifacts/broken_big.json",
        corrupt_small: ".work-state/features/oversized/artifacts/corrupt_small.json",
      },
      files: [
        artifact("big", ".work-state/features/oversized/artifacts/big.json", JSON.stringify({ data: "y".repeat(19000) })),
        artifact("huge", ".work-state/features/oversized/artifacts/huge.json", JSON.stringify({ data: "z".repeat(290000) })),
        // Invalid JSON BEYOND the default window — still produced at default.
        artifact("broken_big", ".work-state/features/oversized/artifacts/broken_big.json", `${"{ invalid".padEnd(20000, "x")}`),
        // Invalid JSON fully inside the window — unreadable.
        artifact("corrupt_small", ".work-state/features/oversized/artifacts/corrupt_small.json", CORRUPT_JSON_SAMPLE),
      ],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);

    const big = session.artifacts.find((a) => a.id === "big");
    assert.ok(big);
    assert.equal(big.status, "produced");
    assert.ok(big.body?.preview, "default window → head preview");
    assert.ok(big.body?.truncated);
    assert.ok(big.body?.marker.startsWith("…[truncated "), `visible marker, got ${big.body?.marker}`);
    assert.ok(big.body?.marker.includes("/16384"), "marker carries original size and applied cap");
    assert.equal(big.body?.text.length, 16384, "bounded head only");
    assert.equal(big.errorCategory, "oversized-unparsed", "head is not complete JSON");
    assert.equal(big.keys, undefined, "unparseable head yields no keys");
    assert.ok(session.warnings.includes("artifact big is larger than the read window: head preview (original bytes > window)"));

    const huge = session.artifacts.find((a) => a.id === "huge");
    assert.equal(huge?.status, "produced");
    assert.ok(huge?.body?.preview);

    // Invalid JSON beyond the window is never unreadable — produced preview.
    const brokenBig = session.artifacts.find((a) => a.id === "broken_big");
    assert.equal(brokenBig?.status, "produced");
    assert.equal(brokenBig?.errorCategory, "oversized-unparsed");

    // In-window parse failure IS unreadable.
    const corrupt = session.artifacts.find((a) => a.id === "corrupt_small");
    assert.equal(corrupt?.status, "unreadable");
    assert.equal(corrupt?.errorCategory, "invalid-json");
    assert.ok(session.warnings.includes("artifact corrupt_small is unreadable: invalid JSON within the read window"));

    // --full raises the window: big parses fully and loses the preview flag.
    const fullSession = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT, { full: true });
    const bigFull = fullSession.artifacts.find((a) => a.id === "big");
    assert.ok(bigFull);
    assert.equal(bigFull.status, "produced");
    assert.equal(bigFull.body?.preview, false, "--full window contains the whole file");
    assert.deepEqual(bigFull.keys, ["data"], "--full parse yields keys");
    assert.equal(bigFull.body?.truncated, false);
    const hugeFull = fullSession.artifacts.find((a) => a.id === "huge");
    assert.ok(hugeFull?.body?.preview, "still oversized under --full");
    assert.equal(hugeFull.errorCategory, "oversized-unparsed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 3. Depth/collection/scalar bounds with visible omission markers ─────────

test("snapshot: depth 8, 200 collection items and 8192 scalar chars enforce visible omission markers", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "hostile",
      pathKey: "hostile",
      task: "Probe bounds.",
      workflow: "standard",
      updatedAt: "2026-08-19T00:30:00.000Z",
      stages: [{ id: "summary", status: "done" }],
      declared: {
        deep: ".work-state/features/hostile/artifacts/deep.json",
        many: ".work-state/features/hostile/artifacts/many.json",
        long: ".work-state/features/hostile/artifacts/long.json",
        fine: ".work-state/features/hostile/artifacts/fine.json",
      },
      files: [
        artifact("deep", ".work-state/features/hostile/artifacts/deep.json", DEEP_JSON_SAMPLE),
        artifact("many", ".work-state/features/hostile/artifacts/many.json", LARGE_COLLECTION_SAMPLE),
        artifact("long", ".work-state/features/hostile/artifacts/long.json", JSON.stringify({ text: LARGE_SCALAR_TEXT })),
        artifact("fine", ".work-state/features/hostile/artifacts/fine.json", JSON.stringify({ a: 1 })),
      ],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);

    const deep = session.artifacts.find((a) => a.id === "deep");
    assert.ok(deep?.bounds?.depthTruncated, "depth 12 exceeds MAX_DEPTH 8");
    assert.equal(deep.bounds?.maxDepth, 8);
    assert.ok(deep.bounds?.marker.startsWith("…[bounded: depth 8"));

    const many = session.artifacts.find((a) => a.id === "many");
    assert.ok(many?.bounds && many.bounds.omittedCollections >= 1, "250 items exceed MAX_COLLECTION_ITEMS 200");
    assert.equal(many.bounds.maxCollectionItems, 200);

    const long = session.artifacts.find((a) => a.id === "long");
    assert.ok(long?.bounds && long.bounds.omittedScalars >= 1, "9000-char scalar exceeds MAX_SCALAR_CHARS 8192");
    assert.equal(long.bounds.maxScalarChars, 8192);

    const fine = session.artifacts.find((a) => a.id === "fine");
    assert.equal(fine?.bounds, undefined, "in-bounds content has no omission markers");
    assert.deepEqual(fine?.keys, ["a"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 4. Compact policy and --full body enablement ─────────────────────────────

test("snapshot: bug-fix compact hides bodies by default; --full embeds them with bigger caps and never disables redaction", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "fix-regression-42",
      pathKey: "fix-regression-42",
      task: "Fix the flaky artifact contract test.",
      workflow: "bug-fix",
      updatedAt: "2026-08-19T09:00:00.000Z",
      stages: [
        { id: "discovery", status: "done" },
        { id: "diagnose", status: "done" },
        { id: "implementation", status: "done" },
        { id: "review", status: "skipped" },
        { id: "manual_qa", status: "pending" },
        { id: "summary", status: "pending" },
      ],
      declared: {
        discovery: ".work-state/features/fix-regression-42/artifacts/discovery.json",
        diagnosis: ".work-state/features/fix-regression-42/artifacts/diagnosis.json",
        dod: ".work-state/features/fix-regression-42/artifacts/dod.json",
        implementation: ".work-state/features/fix-regression-42/artifacts/implementation.json",
        review: ".work-state/features/fix-regression-42/artifacts/review.json",
        manual_qa: ".work-state/features/fix-regression-42/artifacts/manual_qa.json",
        summary: ".work-state/features/fix-regression-42/artifacts/summary.json",
      },
      files: [
        artifact("discovery", ".work-state/features/fix-regression-42/artifacts/discovery.json", typedJson("discovery")),
        artifact("diagnosis", ".work-state/features/fix-regression-42/artifacts/diagnosis.json", typedJson("diagnosis")),
        artifact("dod", ".work-state/features/fix-regression-42/artifacts/dod.json", typedJson("dod")),
      ],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);
    const config = resolveRenderConfig("bug-fix", false);
    assert.equal(config.depthPolicy, "compact");
    assert.equal(config.bodiesEnabled, false);

    const statuses = Object.fromEntries(session.artifacts.map((a) => [a.id, a.status]));
    assert.deepEqual(statuses, {
      discovery: "produced",
      diagnosis: "produced",
      dod: "produced",
      implementation: "missing",
      review: "skipped",
      manual_qa: "pending",
      summary: "pending",
    });
    assert.deepEqual(session.warnings, ["declared artifact implementation is missing"]);
    for (const a of session.artifacts) {
      if (a.status === "produced") {
        assert.equal(a.body, undefined, "compact policy embeds no bodies by default");
        assert.ok(a.summary, "parse-derived summary still present");
        assert.ok(a.keys, "parse-derived keys still present");
      }
    }
    // Stage ownership per profile produces order (diagnose produces diagnosis+dod).
    const diagnose = session.stages.find((s) => s.stageId === "diagnose");
    assert.deepEqual(diagnose?.artifactIds, ["diagnosis", "dod"]);
    assert.equal(session.provenance.sourceDigest.full, digestFor(input).full);

    // --full: bodies appear, caps grow, redaction still applies.
    const fullSession = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT, { full: true });
    const fullConfig = resolveRenderConfig("bug-fix", true);
    assert.equal(fullConfig.bodiesEnabled, true);
    assert.equal(fullConfig.options.readWindowBytes, 256 * 1024);
    assert.equal(fullConfig.options.bodyCapBytes, 256 * 1024);
    const discoveryFull = fullSession.artifacts.find((a) => a.id === "discovery");
    assert.ok(discoveryFull?.body, "--full embeds bodies for compact workflows");
    assert.equal(discoveryFull.body.preview, false);
    assert.equal(discoveryFull.body.text.includes("sk-"), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 5. Native mid-tasks: pending shared base + produced slots ────────────────

test("snapshot: native mid-tasks yields produced slots plus pending shared artifact", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "tasks",
      pathKey: "tasks",
      task: "Run the native tasks stage mid-flight.",
      workflow: "spec-preparation",
      updatedAt: "2026-08-19T04:00:00.000Z",
      stages: [{ id: "tasks", status: "in_progress" }],
      declared: { task_graph: ".work-state/features/tasks/artifacts/task_graph.json" },
      files: [
        artifact("task_graph-architect", ".work-state/features/tasks/artifacts/task_graph-architect.json", slotJson("task_graph", "architect")),
        artifact("task_graph-tech-researcher", ".work-state/features/tasks/artifacts/task_graph-tech-researcher.json", slotJson("task_graph", "tech-researcher")),
      ],
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: {
          task_graph: "pending",
          "task_graph-architect": "produced",
          "task_graph-tech-researcher": "produced",
        },
        warnings: ["shared artifact task_graph is pending: producer in_progress, slots present"],
      },
    });
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);

    assert.deepEqual(session.artifacts.map((a) => a.id), [
      "task_graph",
      "task_graph-architect",
      "task_graph-tech-researcher",
    ]);
    const byId = Object.fromEntries(session.artifacts.map((a) => [a.id, a]));
    assert.equal(byId["task_graph"]?.status, "pending");
    assert.equal(byId["task_graph-architect"]?.status, "produced");
    assert.equal(byId["task_graph-tech-researcher"]?.status, "produced");
    assert.equal(byId["task_graph-architect"]?.slotFor, "task_graph");
    assert.equal(byId["task_graph-tech-researcher"]?.slotFor, "task_graph");
    assert.deepEqual(session.warnings, ["shared artifact task_graph is pending: producer in_progress, slots present"]);

    // The shared base contributes absent (present:false) to the digest.
    const digest = digestFor(input);
    assert.equal(session.provenance.sourceDigest.full, digest.full);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 6. Zero artifacts ────────────────────────────────────────────────────────

test("snapshot: zero-artifact session is overview-only with a no-artifacts note", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "fresh",
      pathKey: "fresh",
      task: "A freshly started session with no artifacts yet.",
      workflow: "standard",
      updatedAt: "2026-08-18T22:00:00.000Z",
      stages: [{ id: "discovery", status: "in_progress" }],
      declared: {},
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);
    assert.equal(session.status, "complete");
    assert.deepEqual(session.artifacts, []);
    assert.deepEqual(session.warnings, ["no artifacts yet"]);
    assert.deepEqual(session.stages, [{ stageId: "discovery", title: "Discovery", status: "in_progress", artifactIds: [] }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 7. Legacy root: identity, staleness, excluded inputs ────────────────────

test("snapshot: legacy root keeps kind/pathKey, stale provenance, and never discovers excluded inputs", () => {
  const cwd = tmpWorkspace();
  try {
    const input: CanonicalSessionInput = {
      kind: "legacy",
      id: LEGACY_SESSION_ID,
      pathKey: LEGACY_ROOT_PATH_KEY,
      state: {
        format: "json",
        content: JSON.stringify({
          schema: 1,
          branch: "main",
          classification: { type: "FEATURE", complexity: "MEDIUM", confidence: "HIGH", workflow: "standard", autonomous: false },
          task: "Legacy do-work run.",
          workflow_override: false,
          issue: null,
          stage_cursor: "summary",
          stages: [
            { id: "discovery", status: "done" },
            { id: "summary", status: "done" },
          ],
          artifacts: {
            discovery: ".work-state/artifacts/discovery.json",
            summary: ".work-state/artifacts/summary.json",
          },
          pause: { kind: "none", reason: "" },
          updated_at: "2026-08-19T13:00:00.000Z",
        }),
        updatedAt: "2026-08-19T13:00:00.000Z",
      },
      workflow: "standard",
      declaredArtifacts: {
        discovery: ".work-state/artifacts/discovery.json",
        summary: ".work-state/artifacts/summary.json",
      },
      artifacts: [
        artifact("discovery", ".work-state/artifacts/discovery.json", typedJson("discovery")),
        artifact("summary", ".work-state/artifacts/summary.json", typedJson("summary")),
      ],
      excludedPaths: [".work-state/events.jsonl", ".work-state/observability/events.jsonl", "vibe-report/legacy.md"],
      expected: { status: "complete", staleness: "stale", artifactStatuses: {} },
    };
    // Excluded inputs on disk must never be discovered/read — including a
    // events.jsonl placed INSIDE the legacy artifacts dir.
    write(join(cwd, ".work-state", "artifacts", "events.jsonl"), '{"ts":"2026-08-19T13:00:01.000Z"}');
    write(join(cwd, ".work-state", "events.jsonl"), '{"ts":"2026-08-19T13:00:01.000Z"}');
    write(join(cwd, "vibe-report", "legacy.md"), "# Legacy report\n");
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);

    assert.equal(session.identity.kind, "legacy");
    assert.equal(session.identity.id, LEGACY_SESSION_ID);
    assert.equal(session.identity.pathKey, LEGACY_ROOT_PATH_KEY);
    assert.equal(session.identity.isLegacy, true);
    assert.equal(session.identity.title, "legacy feature worktree");
    assert.equal(session.provenance.staleness, "stale", "updated_at later than generated_at");
    assert.deepEqual(
      session.artifacts.map((a) => [a.id, a.status]),
      [
        ["discovery", "produced"],
        ["summary", "produced"],
      ],
    );
    assert.equal(session.artifacts.some((a) => a.id.includes("events")), false);
    assert.equal(session.source.label, ".work-state/team-state.json");
    assert.equal(session.source.format, "json");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 8. CTO JSON: run-local + team compatibility + validated dod_path ────────

test("snapshot: CTO JSON run resolves run-local, team compatibility and dod_path artifacts", () => {
  const cwd = tmpWorkspace();
  try {
    const input: CanonicalSessionInput = {
      kind: "cto",
      id: "cto-run-7f3a",
      pathKey: "cto-run-7f3a",
      state: {
        format: "json",
        content: ctoStateJson({
          id: "cto-run-7f3a",
          task: "Coordinate the migrate-to-KMP effort.",
          updatedAt: "2026-08-19T11:00:00.000Z",
          teams: [
            { id: "alpha", status: "done", dodPath: ".work-state/cto/cto-run-7f3a/artifacts/alpha/dod.json" },
            { id: "beta", status: "in_progress" },
          ],
          integrationStatus: "in_progress",
        }),
        updatedAt: "2026-08-19T11:00:00.000Z",
      },
      workflow: "cto",
      declaredArtifacts: {
        cto_discovery: ".work-state/cto/cto-run-7f3a/artifacts/cto_discovery.json",
        team_plan: ".work-state/cto/cto-run-7f3a/artifacts/team_plan.json",
        summary: ".work-state/artifacts/alpha/summary.json",
        dod: ".work-state/cto/cto-run-7f3a/artifacts/alpha/dod.json",
      },
      artifacts: [
        artifact("cto_discovery", ".work-state/cto/cto-run-7f3a/artifacts/cto_discovery.json", typedJson("cto_discovery")),
        artifact("team_plan", ".work-state/cto/cto-run-7f3a/artifacts/team_plan.json", typedJson("team_plan")),
        artifact("summary", ".work-state/artifacts/alpha/summary.json", typedJson("summary")),
        artifact("dod", ".work-state/cto/cto-run-7f3a/artifacts/alpha/dod.json", typedJson("dod")),
      ],
      excludedPaths: [],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    };
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);

    assert.equal(session.identity.kind, "cto");
    assert.equal(session.identity.title, "CTO run cto-run-7f3a");
    assert.equal(session.identity.task, "Coordinate the migrate-to-KMP effort.");
    assert.equal(session.identity.workflow, "cto");
    assert.equal(session.status, "complete");
    assert.deepEqual(session.stages, [], "CTO sessions carry no stage progress model");

    assert.deepEqual(
      session.artifacts.map((a) => [a.id, a.status, a.owner]),
      [
        ["cto_discovery", "produced", ""],
        ["team_plan", "produced", ""],
        ["summary", "produced", "alpha"],
        ["dod", "produced", "alpha"],
      ],
      "declared produces order first, then extras (dod) lexicographic",
    );
    assert.equal(session.artifacts.find((a) => a.id === "dod")?.source?.label, ".work-state/cto/cto-run-7f3a/artifacts/alpha/dod.json");
    assert.equal(session.provenance.sourceDigest.full, digestFor(input).full);
    assert.equal(session.provenance.staleness, "fresh");
    assert.equal(session.source.label, ".work-state/cto/cto-run-7f3a/state.json");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 9. Unsafe ids/paths: skipped/missing with exact warnings ───────────────

test("snapshot: unsafe ids are skipped, unsafe declared paths are excluded, safe ones resolve", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "unsafe",
      pathKey: "unsafe",
      task: "Probe unsafe identifiers and absolute paths.",
      workflow: "standard",
      updatedAt: "2026-08-18T23:00:00.000Z",
      stages: [{ id: "implementation", status: "done" }],
      declared: {
        "../escape": "/tmp/escape.json",
        "a b": ".work-state/features/unsafe/artifacts/a b.json",
        ok_id: "/Users/alice/.work-state/features/unsafe/artifacts/ok.json",
        rel_ok: ".work-state/features/unsafe/artifacts/rel_ok.json",
      },
      files: [artifact("rel_ok", ".work-state/features/unsafe/artifacts/rel_ok.json", JSON.stringify({ note: "safe" }))],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);

    const statuses = Object.fromEntries(session.artifacts.map((a) => [a.id, a.status]));
    assert.deepEqual(statuses, {
      "../escape": "skipped",
      "a b": "skipped",
      ok_id: "missing",
      rel_ok: "produced",
    });
    assert.deepEqual(session.warnings, [
      'artifact id "../escape" is not a safe path key: skipped',
      'artifact id "a b" is not a safe path key: skipped',
      "declared path for ok_id is not a safe relative path: excluded from rendering",
    ]);
    // Skipped/missing artifacts never carry a source descriptor.
    for (const a of session.artifacts) {
      if (a.status !== "produced") assert.equal(a.source, undefined);
    }
    // Digest matches the frozen helper (declared-but-absent contribute false).
    assert.equal(session.provenance.sourceDigest.full, digestFor(input).full);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 11. BG-1: cross-workspace + touch invariance, content mutation ──────────

test("snapshot: BG-1 — identical content with different mtimes yields identical digests and identical non-volatile models", () => {
  const cwdA = tmpWorkspace();
  const cwdB = tmpWorkspace();
  try {
    const input = featureSession({
      id: "mtime",
      pathKey: "mtime",
      task: "Mtime invariance probe.",
      workflow: "spec-preparation",
      updatedAt: "2026-08-19T10:00:00.000Z",
      stages: [{ id: "handoff", status: "done" }],
      declared: { spec_handoff: ".work-state/features/mtime/artifacts/spec_handoff.json" },
      files: [artifact("spec_handoff", ".work-state/features/mtime/artifacts/spec_handoff.json", "y".repeat(2000))],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materialize(cwdA, input);
    materialize(cwdB, input);

    // Different mtimes (touch invariance) — set far-future timestamps in B.
    const stateB = join(cwdB, ".work-state", "features", "mtime", "state.json");
    const artB = join(cwdB, ".work-state", "features", "mtime", "artifacts", "spec_handoff.json");
    const future = new Date("2030-01-01T00:00:00.000Z");
    utimesSync(stateB, future, future);
    utimesSync(artB, future, future);

    const a = buildSessionSnapshot(cwdA, entryOf(cwdA, input), FIXED_GENERATED_AT);
    const b = buildSessionSnapshot(cwdB, entryOf(cwdB, input), FIXED_GENERATED_AT);

    assert.equal(a.provenance.sourceDigest.full, b.provenance.sourceDigest.full, "mtime never enters the digest");
    assert.deepEqual(a, b, "identical inputs with different mtimes produce identical models");

    // Touch-only change (same workspace) is also invariant.
    const stateA = join(cwdA, ".work-state", "features", "mtime", "state.json");
    const artA = join(cwdA, ".work-state", "features", "mtime", "artifacts", "spec_handoff.json");
    utimesSync(stateA, future, future);
    utimesSync(artA, future, future);
    assert.deepEqual(buildSessionSnapshot(cwdA, entryOf(cwdA, input), FIXED_GENERATED_AT), a);

    // A real content change invalidates the digest.
    writeFileSync(artB, "y".repeat(2100));
    const mutated = buildSessionSnapshot(cwdB, entryOf(cwdB, input), FIXED_GENERATED_AT);
    assert.notEqual(mutated.provenance.sourceDigest.full, b.provenance.sourceDigest.full, "content mutation changes the digest");
    assert.notEqual(mutated.provenance.sourceDigest.full, a.provenance.sourceDigest.full);
  } finally {
    rmSync(cwdA, { recursive: true, force: true });
    rmSync(cwdB, { recursive: true, force: true });
  }
});

// ── 12. Staleness total rule (AC-11): equal timestamps are fresh ────────────

test("snapshot: staleness — updated_at later than generated_at is stale, equal timestamps are fresh", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "fresh",
      pathKey: "fresh",
      task: "Equal timestamps.",
      workflow: "standard",
      updatedAt: FIXED_GENERATED_AT,
      stages: [{ id: "discovery", status: "done" }],
      declared: {},
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);
    assert.equal(session.provenance.staleness, "fresh", "equal timestamps are fresh (AC-11)");

    // Later updated_at → stale.
    writeFileSync(join(cwd, ".work-state", "features", "fresh", "state.json"), JSON.stringify({ ...JSON.parse(input.state.content), updated_at: "2026-08-19T13:00:00.000Z" }, null, 2));
    const stale = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);
    assert.equal(stale.provenance.staleness, "stale");
    assert.equal(stale.provenance.sourceUpdatedAt, "2026-08-19T13:00:00.000Z");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 13. Corrupt peers never abort; corrupt state degrades ───────────────────

test("snapshot: corrupt artifact peers and corrupt state degrade without aborting", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "broken",
      pathKey: "broken",
      task: "Probe corrupt peers.",
      workflow: "standard",
      updatedAt: "2026-08-19T02:00:00.000Z",
      stages: [{ id: "discovery", status: "done" }],
      declared: {
        corrupt: ".work-state/features/broken/artifacts/corrupt.json",
        fine: ".work-state/features/broken/artifacts/fine.json",
      },
      files: [
        artifact("corrupt", ".work-state/features/broken/artifacts/corrupt.json", CORRUPT_JSON_SAMPLE),
        artifact("fine", ".work-state/features/broken/artifacts/fine.json", typedJson("fine")),
      ],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);
    assert.equal(session.status, "complete", "one corrupt artifact does not degrade the session");
    assert.equal(session.artifacts.find((a) => a.id === "corrupt")?.status, "unreadable");
    assert.equal(session.artifacts.find((a) => a.id === "fine")?.status, "produced");

    // Corrupt STATE → degraded session via safe enumeration (never throws).
    writeFileSync(join(cwd, ".work-state", "features", "broken", "state.json"), '{ "schema": 1, broken');
    const entry = listDoWorkSources(cwd).find((e) => e.id === "broken");
    assert.ok(entry, "corrupt state is still discoverable as an error entry");
    const degraded = buildSessionSnapshot(cwd, entry, FIXED_GENERATED_AT);
    assert.equal(degraded.status, "degraded");
    assert.equal(degraded.identity.degraded, true);
    assert.equal(degraded.identity.task, "");
    assert.ok(degraded.degradedReasons && degraded.degradedReasons.length > 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 14. Determinism and no canonical mutation ────────────────────────────────

test("snapshot: fixed-clock regeneration is byte-identical and never mutates canonical state", () => {
  const cwd = tmpWorkspace();
  try {
    const input = specInput();
    materialize(cwd, input);
    const statePath = join(cwd, ".work-state", "features", "visualize", "state.json");
    const artifactPath = join(cwd, ".work-state", "features", "visualize", "artifacts", "spec-preparation.json");
    const stateBefore = readFileSync(statePath);
    const artifactBefore = readFileSync(artifactPath);

    const entry = entryOf(cwd, input);
    const a = buildSessionSnapshot(cwd, entry, FIXED_GENERATED_AT);
    const b = buildSessionSnapshot(cwd, entry, FIXED_GENERATED_AT);
    assert.deepEqual(a, b, "identical inputs + fixed clock → identical model");

    assert.deepEqual(readFileSync(statePath), stateBefore, "canonical state bytes unchanged");
    assert.deepEqual(readFileSync(artifactPath), artifactBefore, "artifact bytes unchanged");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 15. Deterministic extras ordering and unlisted workflow default ─────────

test("snapshot: undeclared extras sort lexicographically; unlisted workflows get the safe default depth", () => {
  const cwd = tmpWorkspace();
  try {
    const input = featureSession({
      id: "research-indexing",
      pathKey: "research-indexing",
      task: "Index the lecture corpus.",
      workflow: "research",
      updatedAt: "2026-08-19T07:30:00.000Z",
      stages: [{ id: "survey", status: "done" }],
      declared: { freeform_note: ".work-state/features/research-indexing/artifacts/freeform_note.json" },
      files: [
        artifact("freeform_note", ".work-state/features/research-indexing/artifacts/freeform_note.json", JSON.stringify({ note: "any shape is fine" })),
        artifact("zzz_extra", ".work-state/features/research-indexing/artifacts/zzz_extra.json", JSON.stringify({ z: 1 })),
        artifact("aaa_extra", ".work-state/features/research-indexing/artifacts/aaa_extra.json", JSON.stringify({ a: 1 })),
        artifact("mmm_extra", ".work-state/features/research-indexing/artifacts/mmm_extra.json", JSON.stringify({ m: 1 })),
      ],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    });
    materialize(cwd, input);
    const session = buildSessionSnapshot(cwd, entryOf(cwd, input), FIXED_GENERATED_AT);

    // freeform_note is declared but NOT in the research profile produces, so
    // it joins the extras bucket: all four ids sort lexicographically.
    assert.deepEqual(session.artifacts.map((a) => a.id), ["aaa_extra", "freeform_note", "mmm_extra", "zzz_extra"]);
    for (const a of session.artifacts) {
      if (a.id !== "freeform_note") assert.equal(a.owner, "", "non-slot extras stay unclaimed");
      assert.equal(a.status, "produced");
    }
    const config = resolveRenderConfig("research", false);
    assert.equal(config.depthPolicy, "default");
    assert.equal(config.bodiesEnabled, false, "unlisted workflow: explicit safe default, no bodies");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});


