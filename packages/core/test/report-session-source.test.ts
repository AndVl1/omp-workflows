/**
 * Session-source discovery (visualize architecture-2): deterministic, safe
 * discovery for feature / legacy / canonical CTO JSON state
 * and run-local artifact locations — with report-preserving exact selectors,
 * excluded inputs, and feature/legacy/path-key collision handling without
 * aliasing.
 *
 * Report parity is asserted against buildSessionReport: the public report
 * behavior must remain unchanged after the assemble.ts delegation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CTO_SPECIFICATION_TEXT_BYTES } from "../src/cto/types.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ctoRunLocalFiles,
  ctoTeamArtifactsDir,
  isExcludedSourcePath,
  listCtoSources,
  listDoWorkSources,
  listSessions,
  resolveCtoSource,
  resolveDoWorkSource,
} from "../src/report/session-source.js";
import { buildSessionReport } from "../src/report/assemble.js";
import type { TeamState } from "../src/engine/types.js";
import type { CtoState } from "../src/cto/types.js";

function makeTeamState(overrides: Partial<TeamState> = {}): TeamState {
  return {
    schema: 1,
    branch: "feat/session-source",
    classification: {
      type: "FEATURE",
      complexity: "MEDIUM",
      confidence: "HIGH",
      workflow: "standard",
      autonomous: false,
    },
    task: "Discovery fixture",
    workflow_override: false,
    issue: null,
    stage_cursor: "implementation",
    stages: [{ id: "implementation", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: "2026-08-08T10:00:00.000Z",
    ...overrides,
  };
}

function makeCtoState(overrides: Partial<CtoState> = {}): CtoState {
  return {
    schema: 2,
    id: "run-1",
    task: "Decompose the migration",
    branch: "feat/payments",
    autonomous: true,
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: true },
    plan: { id: "run-1", task: "Decompose the migration", teams: [], created_at: "2026-08-08T09:00:00.000Z" },
    teams: [],
    integration: { status: "pending" },
    pause: { kind: "none", reason: "" },
    updated_at: "2026-08-08T10:00:00.000Z",
    ...overrides,
  };
}

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "session-source-"));
}

function writeFeature(cwd: string, slug: string, state: TeamState): void {
  const dir = join(cwd, ".work-state", "features", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

function writeLegacy(cwd: string, state: TeamState): void {
  const wsDir = join(cwd, ".work-state");
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, "team-state.json"), JSON.stringify(state, null, 2));
}

function writeRun(cwd: string, state: CtoState): void {
  const dir = join(cwd, ".work-state", "cto", state.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

// ── Exact selectors: feature / legacy / cto ─────────────────────────────────

test("session-source: exact feature id resolves; unknown and unsafe ids are null", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "alpha", makeTeamState({ updated_at: "2026-08-08T09:00:00.000Z" }));

    const src = resolveDoWorkSource(cwd, "alpha");
    assert.ok(src);
    assert.equal(src.kind, "do-work");
    assert.equal(src.id, "alpha");
    assert.equal(src.isLegacy, false);
    assert.equal(src.status, "ok");
    assert.equal(src.state?.updated_at, "2026-08-08T09:00:00.000Z");
    assert.equal(src.stateDir, join(cwd, ".work-state", "features", "alpha"));
    assert.equal(src.artifactsDir, join(cwd, ".work-state", "features", "alpha", "artifacts"));

    assert.equal(resolveDoWorkSource(cwd, "ghost"), null, "unknown id → null");
    assert.equal(resolveDoWorkSource(cwd, "../escape"), null, "traversal id → null");
    assert.equal(resolveDoWorkSource(cwd, "a/b"), null, "path-like id → null");
    assert.equal(resolveDoWorkSource(cwd, ".."), null, "parent-segment id → null");
    assert.equal(resolveDoWorkSource(cwd, "."), null, "self-segment id → null");
    assert.equal(resolveDoWorkSource(cwd, "a\\b"), null, "backslash-shaped id never resolves (rejected or absent)");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: TeamState stage/status fields are strict and bounded", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "oversized", makeTeamState({ task: "x".repeat(MAX_CTO_SPECIFICATION_TEXT_BYTES + 1) }));
    assert.throws(
      () => resolveDoWorkSource(cwd, "oversized"),
      /state\.json has an invalid TeamState shape/,
    );

    writeFeature(
      cwd,
      "bad-status",
      makeTeamState({ stages: [{ id: "implementation", status: "parked" as never }] }),
    );
    assert.throws(
      () => resolveDoWorkSource(cwd, "bad-status"),
      /state\.json has an invalid TeamState shape/,
    );

    writeFeature(
      cwd,
      "bad-details",
      makeTeamState({
        stages: [{ id: "implementation", status: "in_progress", details: "x".repeat(16 * 1024 + 1) } as never],
      }),
    );
    assert.throws(
      () => resolveDoWorkSource(cwd, "bad-details"),
      /state\.json has an invalid TeamState shape/,
    );

    const artifacts = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`artifact-${index}`, "x".repeat(4096)]),
    );
    writeFeature(cwd, "aggregate", makeTeamState({ artifacts }));
    assert.throws(
      () => resolveDoWorkSource(cwd, "aggregate"),
      /state\.json has an invalid TeamState shape/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: TeamState graph bounds reject wide, empty-value, and deep states before report/discovery retention", () => {
  const cwd = tmpWorkspace();
  try {
    const base = makeTeamState();
    const baseKeyCount = Object.keys(base).length;
    const maxExtras = 256 - baseKeyCount;
    const maxState = makeTeamState(
      Object.fromEntries(Array.from({ length: maxExtras }, (_, index) => [`extra-${index}`, ""])) as never,
    );
    writeFeature(cwd, "max-keys", maxState);
    assert.doesNotThrow(() => resolveDoWorkSource(cwd, "max-keys"), "the exact top-level key cap is inclusive");

    const tooManyKeys = makeTeamState(
      Object.fromEntries(Array.from({ length: maxExtras + 1 }, (_, index) => [`extra-${index}`, ""])) as never,
    );
    writeFeature(cwd, "too-many-keys", tooManyKeys);
    assert.throws(
      () => resolveDoWorkSource(cwd, "too-many-keys"),
      /state\.json has an invalid TeamState shape/,
      "one key over the exact top-level cap is rejected",
    );
    assert.throws(
      () => buildSessionReport(cwd, { kind: "do-work", id: "too-many-keys" }),
      /do-work session "too-many-keys" not found|invalid TeamState shape/,
      "an over-wide state never builds a report",
    );
    const tooManyEntry = listDoWorkSources(cwd).find((entry) => entry.id === "too-many-keys");
    assert.equal(tooManyEntry?.status, "error", "an over-wide state is category-only during discovery");
    assert.equal(tooManyEntry?.state, null);

    const emptyValueFields = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [`empty-${index}`, ""]),
    );
    writeFeature(cwd, "many-empty-values", makeTeamState({ extras: emptyValueFields } as never));
    assert.throws(
      () => resolveDoWorkSource(cwd, "many-empty-values"),
      /state\.json has an invalid TeamState shape/,
      "many empty values still consume the bounded object-key budget",
    );
    const emptyValueEntry = listDoWorkSources(cwd).find((entry) => entry.id === "many-empty-values");
    assert.equal(emptyValueEntry?.status, "error");
    assert.equal(emptyValueEntry?.state, null);

    let deep: unknown = "leaf";
    for (let index = 0; index < 32; index += 1) deep = { next: deep };
    writeFeature(cwd, "deep", makeTeamState({ nested: deep } as never));
    assert.throws(
      () => resolveDoWorkSource(cwd, "deep"),
      /state\.json has an invalid TeamState shape/,
      "deep JSON is rejected without recursive stack growth",
    );
    assert.throws(
      () => buildSessionReport(cwd, { kind: "do-work", id: "deep" }),
      /do-work session "deep" not found|invalid TeamState shape/,
      "deep JSON never builds a report",
    );
    const deepEntry = listDoWorkSources(cwd).find((entry) => entry.id === "deep");
    assert.equal(deepEntry?.status, "error", "deep JSON is category-only during discovery");
    assert.equal(deepEntry?.state, null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: legacy id resolves only the legacy root; a feature named legacy is degraded, never aliased", () => {
  const cwd = tmpWorkspace();
  try {
    writeLegacy(cwd, makeTeamState({ updated_at: "2026-08-08T08:00:00.000Z" }));
    writeFeature(cwd, "legacy", makeTeamState({ updated_at: "2026-08-08T09:00:00.000Z" }));

    const src = resolveDoWorkSource(cwd, "legacy");
    assert.ok(src);
    assert.equal(src.isLegacy, true, "exact id 'legacy' is the legacy root, never a feature");
    assert.equal(src.id, "legacy");
    assert.equal(src.stateDir, join(cwd, ".work-state"));
    assert.equal(src.state?.updated_at, "2026-08-08T08:00:00.000Z");

    // Report parity: /session-report id=legacy renders the legacy root.
    const report = buildSessionReport(cwd, { kind: "do-work", id: "legacy" });
    assert.equal(report.source.id, "legacy");
    assert.equal(report.source.isLegacy, true);

    // Enumeration exposes BOTH entries with their exact ids — no aliasing.
    const listed = listDoWorkSources(cwd);
    assert.equal(listed.length, 2);
    const root = listed.find((e) => e.isLegacy);
    assert.equal(root?.id, "legacy");
    assert.equal(root?.status, "ok");
    const feature = listed.find((e) => !e.isLegacy);
    assert.equal(feature?.id, "legacy", "the feature keeps its real id — no rename/alias");
    assert.equal(feature?.status, "degraded", "id collision is a degraded category-only state");
    assert.match(feature?.error ?? "", /reserved for the legacy root/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: a lone feature named legacy is still unreachable by exact id (category-only), never aliased", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "legacy", makeTeamState());

    // No team-state.json → the exact id "legacy" resolves to nothing.
    assert.equal(resolveDoWorkSource(cwd, "legacy"), null);
    assert.throws(() => buildSessionReport(cwd, { kind: "do-work", id: "legacy" }), /do-work session "legacy" not found/);

    // Enumeration still surfaces the real session as degraded.
    const listed = listDoWorkSources(cwd);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "legacy");
    assert.equal(listed[0]?.isLegacy, false);
    assert.equal(listed[0]?.status, "degraded");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: latest follows report precedence — active-feature pointer, then legacy, then newest feature", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "beta", makeTeamState({ updated_at: "2026-08-08T09:00:00.000Z" }));
    writeFeature(cwd, "alpha", makeTeamState({ updated_at: "2026-08-08T12:00:00.000Z" }));
    // 1. .active-feature pointer wins even when another feature is newer.
    mkdirSync(join(cwd, ".work-state"), { recursive: true });
    writeFileSync(join(cwd, ".work-state", ".active-feature"), "beta\n");
    assert.equal(resolveDoWorkSource(cwd)?.id, "beta", "active-feature pointer wins");
    assert.equal(buildSessionReport(cwd, { kind: "do-work" }).source.id, "beta", "report parity");

    // 2. Without a pointer, the legacy root wins.
    rmSync(join(cwd, ".work-state", ".active-feature"));
    writeLegacy(cwd, makeTeamState({ updated_at: "2026-08-08T08:00:00.000Z" }));
    const legacy = resolveDoWorkSource(cwd);
    assert.equal(legacy?.id, "legacy", "legacy root wins over per-feature states");
    assert.equal(legacy?.isLegacy, true);
    assert.equal(buildSessionReport(cwd, { kind: "do-work" }).source.isLegacy, true, "report parity");

    // 3. No pointer, no legacy → newest per-feature state.
    rmSync(join(cwd, ".work-state", "team-state.json"));
    const newest = resolveDoWorkSource(cwd);
    assert.equal(newest?.id, "alpha", "newest feature by updated_at wins");
    assert.equal(buildSessionReport(cwd, { kind: "do-work" }).source.id, "alpha", "report parity");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: exotic unicode/space-named features stay discoverable — exact, latest and enumeration keep verbatim ids (no aliasing)", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "моя фича", makeTeamState({ updated_at: "2026-08-08T12:00:00.000Z" }));
    writeFeature(cwd, "my feature", makeTeamState({ updated_at: "2026-08-08T09:00:00.000Z" }));

    // Exact selectors: previously valid exotic single-segment names resolve
    // verbatim — the safe-segment guard must not silently hide them.
    const exotic = resolveDoWorkSource(cwd, "моя фича");
    assert.ok(exotic);
    assert.equal(exotic.id, "моя фича");
    assert.equal(exotic.status, "ok");
    assert.equal(exotic.isLegacy, false);
    assert.equal(exotic.stateDir, join(cwd, ".work-state", "features", "моя фича"));
    const spaced = resolveDoWorkSource(cwd, "my feature");
    assert.ok(spaced);
    assert.equal(spaced.id, "my feature");

    // Report parity: /session-report id=<exotic slug> builds the report.
    const report = buildSessionReport(cwd, { kind: "do-work", id: "моя фича" });
    assert.equal(report.source.id, "моя фича");

    // Latest: the newest exotic feature wins the latest scan (report precedence).
    assert.equal(resolveDoWorkSource(cwd)?.id, "моя фича");
    assert.equal(buildSessionReport(cwd, { kind: "do-work" }).source.id, "моя фича", "report parity");

    // Enumeration: verbatim ids, deterministic order, no aliasing, no silent drops.
    assert.deepEqual(
      listDoWorkSources(cwd).map((e) => e.id),
      ["моя фича", "my feature"],
    );
    assert.ok(listSessions(cwd).some((s) => s.kind === "do-work" && s.id === "моя фича"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: cto JSON resolution; corrupt state.json is an error entry in enumeration and invisible to the report", () => {
  const cwd = tmpWorkspace();
  try {
    writeRun(cwd, makeCtoState({ id: "run-1", updated_at: "2026-08-08T11:00:00.000Z" }));
    const corruptDir = join(cwd, ".work-state", "cto", "run-2");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "state.json"), "{ nope");

    const src = resolveCtoSource(cwd, "run-1");
    assert.ok(src);
    assert.equal(src.kind, "cto");
    assert.equal(src.id, "run-1");
    assert.equal(src.format, "json");
    assert.equal(src.status, "ok");
    assert.equal(src.statePath, join(cwd, ".work-state", "cto", "run-1", "state.json"));
    assert.equal(src.runDir, join(cwd, ".work-state", "cto", "run-1"));

    assert.equal(resolveCtoSource(cwd, "run-2"), null, "corrupt state.json is invisible to the exact probe");
    assert.equal(resolveCtoSource(cwd, "../escape"), null, "unsafe run id rejected");
    assert.equal(resolveCtoSource(cwd)?.id, "run-1", "latest = newest JSON run");

    // Report parity: the corrupt run stays a "not found" error, unchanged.
    assert.throws(() => buildSessionReport(cwd, { kind: "cto", id: "run-2" }), /cto session "run-2" not found/);

    // Enumeration: the corrupt run is a category-only error entry.
    const listed = listCtoSources(cwd);
    const corrupt = listed.find((e) => e.id === "run-2");
    assert.equal(corrupt?.status, "error");
    assert.equal(corrupt?.state, null);
    assert.equal(corrupt?.format, "json");
    assert.equal(corrupt?.updatedAt, null);
    assert.equal(corrupt?.statePath, join(cwd, ".work-state", "cto", "run-2", "state.json"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Canonical CTO state: markdown-only directories are inactive ─────────────

test("session-source: markdown-only CTO runs are inactive, non-discoverable, and require migration", () => {
  const cwd = tmpWorkspace();
  try {
    for (const [id, files] of [
      ["active-markdown", { "cto_discovery.md": "# CTO Discovery\n", "team-plan.md": "# Team Plan\n" }],
      ["terminal-markdown", { "cto_discovery.md": "# CTO Discovery\n", "summary.md": "# Summary\ndone\n" }],
    ] as const) {
      const runDir = join(cwd, ".work-state", "cto", id);
      mkdirSync(runDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) writeFileSync(join(runDir, name), content);
      assert.equal(resolveCtoSource(cwd, id), null, `${id} has no canonical state.json`);
      assert.throws(
        () => buildSessionReport(cwd, { kind: "cto", id }),
        new RegExp(`cto session "${id}" not found \\(no state\\.json and no markdown fallback\\)`),
      );
    }

    assert.deepEqual(listCtoSources(cwd), [], "Markdown-only runs are not enumerated as CTO sessions");
    assert.deepEqual(listSessions(cwd), [], "Markdown-only runs are not discoverable in the all-sessions view");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: canonical CTO ids stay exact; traversal-shaped selectors are rejected", () => {
  const cwd = tmpWorkspace();
  try {
    // Canonical reader rejects ids outside the engine's safe-id contract
    // rather than aliasing them to another run.
    writeRun(cwd, makeCtoState({ id: "run with space", updated_at: "2026-08-08T11:00:00.000Z" }));
    assert.equal(resolveCtoSource(cwd, "run with space"), null, "unsafe canonical id is not resolved");
    assert.throws(
      () => buildSessionReport(cwd, { kind: "cto", id: "run with space" }),
      /cto session "run with space" not found/,
    );
    const unsafe = listCtoSources(cwd);
    assert.equal(unsafe.length, 1);
    assert.equal(unsafe[0]?.id, "run with space");
    assert.equal(unsafe[0]?.status, "error", "unreadable unsafe canonical state is category-only");

    // Traversal-shaped selectors are rejected outright — never aliased.
    assert.equal(resolveCtoSource(cwd, "../escape"), null);
    assert.equal(resolveCtoSource(cwd, "a/b"), null);
    assert.equal(resolveCtoSource(cwd, ".."), null);
    assert.equal(resolveCtoSource(cwd, "."), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Degraded/error states and collisions ────────────────────────────────────

test("session-source: corrupt feature state — error entry in enumeration, exact-id throws (report parity)", () => {
  const cwd = tmpWorkspace();
  try {
    const brokenDir = join(cwd, ".work-state", "features", "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "state.json"), "{ nope");

    // The report's exact-id probe throws the JSON.parse error unchanged.
    assert.throws(() => resolveDoWorkSource(cwd, "broken"), /JSON/);
    assert.throws(() => buildSessionReport(cwd, { kind: "do-work", id: "broken" }), /JSON/, "report parity");

    const broken = listDoWorkSources(cwd).find((e) => e.id === "broken");
    assert.equal(broken?.status, "error");
    assert.equal(broken?.state, null);
    assert.equal(broken?.updatedAt, null);

    // Corrupt legacy root: same split — exact id throws, enumeration degrades.
    writeLegacy(cwd, makeTeamState());
    writeFileSync(join(cwd, ".work-state", "team-state.json"), "{ nope");
    assert.throws(() => resolveDoWorkSource(cwd, "legacy"), /JSON/);
    const legacyEntry = listDoWorkSources(cwd).find((e) => e.isLegacy);
    assert.equal(legacyEntry?.status, "error");
    assert.equal(legacyEntry?.state, null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: latest scan skips corrupt feature states deterministically", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "good", makeTeamState({ updated_at: "2026-08-08T12:00:00.000Z" }));
    const badDir = join(cwd, ".work-state", "features", "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "state.json"), "{ nope");

    assert.equal(resolveDoWorkSource(cwd)?.id, "good", "corrupt states skipped in the latest scan");
    assert.equal(buildSessionReport(cwd, { kind: "do-work" }).source.id, "good", "report parity");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Deterministic ordering ──────────────────────────────────────────────────

test("session-source: listSessions is totally ordered (updated_at desc, kind, id) and deterministic", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "a", makeTeamState({ updated_at: "2026-08-08T09:00:00.000Z" }));
    writeFeature(cwd, "b", makeTeamState({ updated_at: "2026-08-08T10:00:00.000Z" }));
    writeLegacy(cwd, makeTeamState({ updated_at: "2026-08-08T08:00:00.000Z" }));
    writeRun(cwd, makeCtoState({ id: "run-1", updated_at: "2026-08-08T11:00:00.000Z" }));
    writeRun(cwd, makeCtoState({ id: "run-2", updated_at: "2026-08-08T10:30:00.000Z" }));
    const corruptDir = join(cwd, ".work-state", "cto", "corrupt");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "state.json"), "{ nope");

    const sessions = listSessions(cwd);
    const ids = sessions.map((s) => `${s.kind}:${s.id}`);
    assert.deepEqual(ids, ["cto:run-1", "cto:run-2", "do-work:b", "do-work:a", "do-work:legacy", "cto:corrupt"]);

    // Deterministic: identical result across calls.
    assert.deepEqual(
      listSessions(cwd).map((s) => `${s.kind}:${s.id}`),
      ids,
    );
    // Within-kind order is also deterministic.
    assert.deepEqual(
      listDoWorkSources(cwd).map((s) => s.id),
      ["b", "a", "legacy"],
    );
    assert.deepEqual(
      listCtoSources(cwd).map((s) => s.id),
      ["run-1", "run-2", "corrupt"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Excluded inputs ─────────────────────────────────────────────────────────

test("session-source: events.jsonl, vibe-report and generated visualize output are never sources or artifact inputs", () => {
  const cwd = tmpWorkspace();
  try {
    // Generated projection output + human docs that must never be discovered.
    mkdirSync(join(cwd, ".work-state", "visualize"), { recursive: true });
    writeFileSync(join(cwd, ".work-state", "visualize", "index.md"), "generated\n");
    mkdirSync(join(cwd, "vibe-report"), { recursive: true });
    writeFileSync(join(cwd, "vibe-report", "visualize-e2e.md"), "scenario\n");

    // A real session named visualize is a real feature — never over-excluded.
    writeFeature(cwd, "visualize", makeTeamState());

    const sessions = listSessions(cwd);
    assert.ok(sessions.some((s) => s.kind === "do-work" && s.id === "visualize"), "feature 'visualize' is a real session");
    assert.ok(!sessions.some((s) => s.id === "vibe-report"), "vibe-report is never a session");
    assert.ok(!sessions.some((s) => s.id === "events.jsonl"), "events.jsonl is never a session");

    // Path-level exclusion for generated output / docs / event stream.
    assert.equal(isExcludedSourcePath(cwd, join(cwd, ".work-state", "visualize", "index.html")), true);
    assert.equal(isExcludedSourcePath(cwd, join(cwd, "vibe-report", "visualize-e2e.md")), true);
    assert.equal(isExcludedSourcePath(cwd, join(cwd, ".work-state", "cto", "run-1", "events.jsonl")), true);
    assert.equal(isExcludedSourcePath(cwd, join(cwd, ".work-state", "features", "alpha", "state.json")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: ctoRunLocalFiles excludes state.json, answers, events.jsonl and non-md/json files", () => {
  const cwd = tmpWorkspace();
  try {
    const runDir = join(cwd, ".work-state", "cto", "run-1");
    mkdirSync(join(runDir, "answers"), { recursive: true });
    mkdirSync(join(runDir, "observability"), { recursive: true });
    writeFileSync(join(runDir, "team-plan.md"), "# Team Plan\n");
    writeFileSync(join(runDir, "decisions.md"), "# Decisions\n");
    writeFileSync(join(runDir, "summary.json"), "{}");
    writeFileSync(join(runDir, "state.json"), "{}"); // canonical state — never an artifact
    writeFileSync(join(runDir, "answers", "esc-1.json"), "{}");
    writeFileSync(join(runDir, "observability", "events.jsonl"), "{}");
    writeFileSync(join(runDir, "notes.txt"), "not md/json\n");

    const files = ctoRunLocalFiles(runDir);
    assert.deepEqual(files, ["decisions.md", "summary.json", "team-plan.md"], "sorted, filtered run-local candidates");
    assert.ok(!files.includes("state.json"), "canonical state excluded");
    assert.ok(!files.includes("answers"), "answers dir excluded");
    assert.ok(!files.includes("events.jsonl"), "event stream excluded");
    assert.ok(!files.includes("notes.txt"), "non-md/json excluded");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Run-local / compatibility artifact locations ────────────────────────────

test("session-source: exposes run-local and compatibility artifact locations", () => {
  const cwd = tmpWorkspace();
  try {
    writeFeature(cwd, "alpha", makeTeamState());
    writeLegacy(cwd, makeTeamState());
    writeRun(cwd, makeCtoState());

    const feature = resolveDoWorkSource(cwd, "alpha");
    assert.equal(feature?.artifactsDir, join(cwd, ".work-state", "features", "alpha", "artifacts"));

    const legacy = resolveDoWorkSource(cwd, "legacy");
    assert.equal(legacy?.artifactsDir, join(cwd, ".work-state", "artifacts"), "legacy root uses the compatibility artifacts dir");

    assert.equal(ctoTeamArtifactsDir(cwd, "alpha"), join(cwd, ".work-state", "artifacts", "alpha"), "CTO team artifacts location");

    const run = resolveCtoSource(cwd, "run-1");
    assert.equal(run?.runDir, join(cwd, ".work-state", "cto", "run-1"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
