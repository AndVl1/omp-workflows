/**
 * Session-source discovery (visualize architecture-2): deterministic, safe
 * discovery for feature / legacy / CTO JSON / CTO markdown-state and
 * run-local artifact locations — with report-preserving exact selectors, a
 * visualization-only terminal-markdown projection, excluded inputs, and
 * feature/legacy/path-key collision handling without aliasing.
 *
 * Report parity is asserted against buildSessionReport: the public report
 * behavior must remain unchanged after the assemble.ts delegation.
 *
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */

import { test } from "node:test";
import assert from "node:assert/strict";
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
  markdownCtoState,
} from "../src/report/session-source.js";
import { buildSessionReport, type ReportAssemblyOptions } from "../src/report/assemble.js";
import type { TeamState } from "../src/engine/types.js";
import type { CtoState } from "../src/cto/types.js";
import { readWorkflowProfile, workflowV2Fixture, type WorkflowV2TestFixture } from "./workflow-v2-fixtures.js";
import { reportStorageFor } from "./report-storage-fixtures.js";
import type {
  CanonicalRoot,
  PolicyDocument,
  PolicySnapshot,
  WorkflowPolicy,
} from "../src/workflow-v2/types.js";


const STANDARD_FIXTURE = workflowV2Fixture(readWorkflowProfile("standard"));
const CTO_FIXTURE = workflowV2Fixture(readWorkflowProfile("cto"), { runId: "run-1" });

function reportOptions(cwd: string, fixture: WorkflowV2TestFixture): ReportAssemblyOptions {
  const provider = fixture.effective_policy.provider;
  const policy: WorkflowPolicy = {
    roles: fixture.effective_policy.roles,
    scope_map: [],
    roster_overrides: [],
    flags: {},
    runtime_classes: {},
    ui_classes: {},
    design_system: null,
    commands: fixture.effective_policy.commands,
    workflow: fixture.effective_policy.workflow,
    prompt_context: {},
    required_capabilities: [],
  };
  const document: PolicyDocument = { schema_version: 2, provider, policy };
  const policySnapshot: PolicySnapshot = {
    root: cwd as CanonicalRoot,
    document,
    byte_sha256: fixture.project_identity.config_byte_sha256,
    semantic_sha256: fixture.project_identity.config_semantic_sha256,
    byte_length: 0,
  };
  return {
    policySnapshot,
    effectivePolicy: fixture.effective_policy,
    catalog: fixture.catalog,
    project_identity: fixture.project_identity,
    agentInventory: fixture.agent_inventory,
  };
}
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
    workflow: STANDARD_FIXTURE.profile.name,
    task: "Discovery fixture",
    workflow_override: false,
    issue: null,
    stage_cursor: "implementation",
    cursor_epoch: "session-source-epoch",
    stages: [{ id: "implementation", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: "2026-08-08T10:00:00.000Z",
    project_identity: STANDARD_FIXTURE.project_identity,
    run_identity: STANDARD_FIXTURE.run_identity,
    ...overrides,
  };
}

function makeCtoState(overrides: Partial<CtoState> = {}): CtoState {
  const id = overrides.id ?? "run-1";
  const runIdentity = { ...CTO_FIXTURE.run_identity, run_id: id };
  return {
    schema: 2,
    id,
    task: "Decompose the migration",
    branch: "feat/payments",
    autonomous: true,
    classification: { type: "FEATURE", complexity: "COMPLEX", confidence: "HIGH", autonomous: true },
    run_identity: runIdentity,
    plan: { id, task: "Decompose the migration", teams: [], created_at: "2026-08-08T09:00:00.000Z", run_identity: runIdentity },
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

    const src = resolveDoWorkSource(reportStorageFor(cwd), "alpha");
    assert.ok(src);
    assert.equal(src.kind, "do-work");
    assert.equal(src.id, "alpha");
    assert.equal(src.isLegacy, false);
    assert.equal(src.status, "ok");
    assert.equal(src.state?.updated_at, "2026-08-08T09:00:00.000Z");
    assert.equal(src.stateDir, join(".work-state", "features", "alpha"));
    assert.equal(src.artifactsDir, join(".work-state", "features", "alpha", "artifacts"));

    assert.equal(resolveDoWorkSource(reportStorageFor(cwd), "ghost"), null, "unknown id → null");
    assert.equal(resolveDoWorkSource(reportStorageFor(cwd), "../escape"), null, "traversal id → null");
    assert.equal(resolveDoWorkSource(reportStorageFor(cwd), "a/b"), null, "path-like id → null");
    assert.equal(resolveDoWorkSource(reportStorageFor(cwd), ".."), null, "parent-segment id → null");
    assert.equal(resolveDoWorkSource(reportStorageFor(cwd), "."), null, "self-segment id → null");
    assert.equal(resolveDoWorkSource(reportStorageFor(cwd), "a\\b"), null, "backslash-shaped id never resolves (rejected or absent)");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: legacy id resolves only the legacy root; a feature named legacy is degraded, never aliased", () => {
  const cwd = tmpWorkspace();
  try {
    writeLegacy(cwd, makeTeamState({ updated_at: "2026-08-08T08:00:00.000Z" }));
    writeFeature(cwd, "legacy", makeTeamState({ updated_at: "2026-08-08T09:00:00.000Z" }));

    const src = resolveDoWorkSource(reportStorageFor(cwd), "legacy");
    assert.ok(src);
    assert.equal(src.isLegacy, true, "exact id 'legacy' is the legacy root, never a feature");
    assert.equal(src.id, "legacy");
    assert.equal(src.stateDir, join(".work-state"));
    assert.equal(src.state?.updated_at, "2026-08-08T08:00:00.000Z");

    // Legacy state remains discoverable for visualization, but is not a
    // report authority after the run-identity cutover.
    assert.throws(
      () => buildSessionReport(reportStorageFor(cwd), { kind: "do-work", id: "legacy" }, reportOptions(cwd, STANDARD_FIXTURE)),
      /MIGRATION_REQUIRED: legacy do-work state is not a report authority/,
    );

    // Enumeration exposes BOTH entries with their exact ids — no aliasing.
    const listed = listDoWorkSources(reportStorageFor(cwd));
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
    assert.equal(resolveDoWorkSource(reportStorageFor(cwd), "legacy"), null);
    assert.throws(() => buildSessionReport(reportStorageFor(cwd), { kind: "do-work", id: "legacy" }, reportOptions(cwd, STANDARD_FIXTURE)), /do-work session "legacy" not found/);

    // Enumeration still surfaces the real session as degraded.
    const listed = listDoWorkSources(reportStorageFor(cwd));
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
    assert.equal(resolveDoWorkSource(reportStorageFor(cwd))?.id, "beta", "active-feature pointer wins");
    assert.equal(buildSessionReport(reportStorageFor(cwd), { kind: "do-work" }, reportOptions(cwd, STANDARD_FIXTURE)).source.id, "beta", "report parity");

    // 2. Without a pointer, the legacy root still wins discovery, but report
    // assembly fails closed instead of treating the legacy state as current.
    rmSync(join(cwd, ".work-state", ".active-feature"));
    writeLegacy(cwd, makeTeamState({ updated_at: "2026-08-08T08:00:00.000Z" }));
    const legacy = resolveDoWorkSource(reportStorageFor(cwd));
    assert.equal(legacy?.id, "legacy", "legacy root wins over per-feature states");
    assert.equal(legacy?.isLegacy, true);
    assert.throws(
      () => buildSessionReport(reportStorageFor(cwd), {}, reportOptions(cwd, STANDARD_FIXTURE)),
      /MIGRATION_REQUIRED: legacy do-work state is not a report authority/,
      "legacy discovery remains observational and cannot authorize a report",
    );

    // 3. No pointer, no legacy → newest per-feature state.
    rmSync(join(cwd, ".work-state", "team-state.json"));
    const newest = resolveDoWorkSource(reportStorageFor(cwd));
    assert.equal(newest?.id, "alpha", "newest feature by updated_at wins");
    assert.equal(buildSessionReport(reportStorageFor(cwd), { kind: "do-work" }, reportOptions(cwd, STANDARD_FIXTURE)).source.id, "alpha", "report parity");
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
    const exotic = resolveDoWorkSource(reportStorageFor(cwd), "моя фича");
    assert.ok(exotic);
    assert.equal(exotic.id, "моя фича");
    assert.equal(exotic.status, "ok");
    assert.equal(exotic.isLegacy, false);
    assert.equal(exotic.stateDir, join(".work-state", "features", "моя фича"));
    const spaced = resolveDoWorkSource(reportStorageFor(cwd), "my feature");
    assert.ok(spaced);
    assert.equal(spaced.id, "my feature");

    // Report parity: /session-report id=<exotic slug> builds the report.
    const report = buildSessionReport(reportStorageFor(cwd), { kind: "do-work", id: "моя фича" }, reportOptions(cwd, STANDARD_FIXTURE));
    assert.equal(report.source.id, "моя фича");

    // Latest: the newest exotic feature wins the latest scan (report precedence).
    assert.equal(resolveDoWorkSource(reportStorageFor(cwd))?.id, "моя фича");
    assert.equal(buildSessionReport(reportStorageFor(cwd), { kind: "do-work" }, reportOptions(cwd, STANDARD_FIXTURE)).source.id, "моя фича", "report parity");

    // Enumeration: verbatim ids, deterministic order, no aliasing, no silent drops.
    assert.deepEqual(
      listDoWorkSources(reportStorageFor(cwd)).map((e) => e.id),
      ["моя фича", "my feature"],
    );
    assert.ok(listSessions(reportStorageFor(cwd)).some((s) => s.kind === "do-work" && s.id === "моя фича"));
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

    const src = resolveCtoSource(reportStorageFor(cwd), "run-1");
    assert.ok(src);
    assert.equal(src.kind, "cto");
    assert.equal(src.id, "run-1");
    assert.equal(src.format, "json");
    assert.equal(src.status, "ok");
    assert.equal(src.statePath, join(".work-state", "cto", "run-1", "state.json"));
    assert.equal(src.runDir, join(".work-state", "cto", "run-1"));

    assert.equal(resolveCtoSource(reportStorageFor(cwd), "run-2"), null, "corrupt state.json is invisible to the exact probe");
    assert.equal(resolveCtoSource(reportStorageFor(cwd), "../escape"), null, "unsafe run id rejected");
    assert.equal(resolveCtoSource(reportStorageFor(cwd))?.id, "run-1", "latest = newest JSON run");

    // Report parity: the corrupt run stays a "not found" error, unchanged.
    assert.throws(() => buildSessionReport(reportStorageFor(cwd), { kind: "cto", id: "run-2" }, reportOptions(cwd, CTO_FIXTURE)), /cto session "run-2" not found/);

    // Enumeration: the corrupt run is a category-only error entry.
    const listed = listCtoSources(reportStorageFor(cwd));
    const corrupt = listed.find((e) => e.id === "run-2");
    assert.equal(corrupt?.status, "error");
    assert.equal(corrupt?.state, null);
    assert.equal(corrupt?.format, "json");
    assert.equal(corrupt?.updatedAt, null);
    assert.equal(corrupt?.statePath, join(".work-state", "cto", "run-2", "state.json"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Markdown-state CTO: active vs terminal ──────────────────────────────────

test("session-source: active markdown run is an observational projection; terminal markdown run stays degraded and invisible to the report", () => {
  const cwd = tmpWorkspace();
  try {
    // Active agent-written run: no state.json, no finish marker.
    const activeDir = join(cwd, ".work-state", "cto", "md-run");
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(join(activeDir, "cto_discovery.md"), "# CTO Discovery\nsummary of scope\n");
    writeFileSync(join(activeDir, "team-plan.md"), "# Team Plan\n- team: alpha — API slice\n");

    const active = listCtoSources(reportStorageFor(cwd)).find((entry) => entry.id === "md-run");
    assert.ok(active);
    assert.equal(resolveCtoSource(reportStorageFor(cwd), "md-run"), null, "markdown evidence never resolves as report state");
    assert.equal(active.format, "markdown");
    assert.equal(active.status, "degraded");
    assert.equal(active.statePath, null, "markdown runs have no canonical state path");
    assert.equal(active.state, null, "markdown runs have no durable run identity");
    assert.equal(markdownCtoState(reportStorageFor(cwd), "md-run", join(".work-state", "cto", "md-run")), null, "markdownCtoState remains observational only");
    assert.match(active.error ?? "", /no durable run identity/);

    // Markdown resolution is observational only; it has no v2 authority for report assembly.
    assert.throws(
      () => buildSessionReport(reportStorageFor(cwd), { kind: "cto", id: "md-run" }, reportOptions(cwd, CTO_FIXTURE)),
      /cto session "md-run" not found/,
    );

    // Terminal agent-written run: a summary marker finishes it.
    const termDir = join(cwd, ".work-state", "cto", "term-run");
    mkdirSync(termDir, { recursive: true });
    writeFileSync(join(termDir, "cto_discovery.md"), "# CTO Discovery\n");
    writeFileSync(join(termDir, "summary.md"), "# Summary\ndone\n");

    assert.equal(markdownCtoState(reportStorageFor(cwd), "term-run", join(".work-state", "cto", "term-run")), null, "markdownCtoState returns null for terminal runs (unchanged)");
    assert.equal(resolveCtoSource(reportStorageFor(cwd), "term-run"), null, "terminal run invisible to report resolution");
    assert.throws(() => buildSessionReport(reportStorageFor(cwd), { kind: "cto", id: "term-run" }, reportOptions(cwd, CTO_FIXTURE)), /cto session "term-run" not found/);

    // Visualization-only projection: discoverable as degraded, never remapped.
    const term = listCtoSources(reportStorageFor(cwd)).find((e) => e.id === "term-run");
    assert.ok(term, "terminal run is enumerated for the projection");
    assert.equal(term.status, "degraded");
    assert.equal(term.terminalMarkdown, true);
    assert.equal(term.format, "markdown");
    assert.equal(term.state, null);
    assert.ok(term.updatedAt, "terminal projection keeps a deterministic updated_at");
    assert.match(term.error ?? "", /terminal markdown run/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: latest cto ignores terminal markdown runs entirely (report unchanged)", () => {
  const cwd = tmpWorkspace();
  try {
    const termDir = join(cwd, ".work-state", "cto", "term-only");
    mkdirSync(termDir, { recursive: true });
    writeFileSync(join(termDir, "cto_discovery.md"), "# CTO Discovery\n");
    writeFileSync(join(termDir, "integration_review.md"), "# Review\n");

    assert.equal(resolveCtoSource(reportStorageFor(cwd)), null, "no active run → null latest");
    assert.throws(() => buildSessionReport(reportStorageFor(cwd), { kind: "cto" }, reportOptions(cwd, CTO_FIXTURE)), /cto session "latest" not found/);
    assert.equal(listCtoSources(reportStorageFor(cwd)).length, 1, "projection still lists the terminal run");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: exotic CTO markdown names stay observational; unsafe JSON run IDs are rejected; traversal-shaped selectors rejected", () => {
  const cwd = tmpWorkspace();
  try {
    // Agent-written markdown run with a space in its name remains visible in
    // the observational listing, while no durable run identity exists.
    const mdRunDir = join(cwd, ".work-state", "cto", "md run with space");
    mkdirSync(mdRunDir, { recursive: true });
    writeFileSync(join(mdRunDir, "cto_discovery.md"), "# CTO Discovery\n");
    writeFileSync(join(mdRunDir, "team-plan.md"), "# Team Plan\n");

    const mdRun = listCtoSources(reportStorageFor(cwd)).find((entry) => entry.id === "md run with space");
    assert.ok(mdRun);
    assert.equal(resolveCtoSource(reportStorageFor(cwd), "md run with space"), null, "markdown evidence never resolves as report state");
    assert.equal(mdRun.id, "md run with space");
    assert.equal(mdRun.format, "markdown");
    assert.equal(mdRun.status, "degraded");
    assert.equal(mdRun.state, null);
    assert.match(mdRun.error ?? "", /no durable run identity/);

    // Markdown projection has no v2 report authority.
    assert.throws(
      () => buildSessionReport(reportStorageFor(cwd), { kind: "cto", id: "md run with space" }, reportOptions(cwd, CTO_FIXTURE)),
      /cto session "md run with space" not found/,
    );

    assert.equal(resolveCtoSource(reportStorageFor(cwd)), null, "markdown evidence cannot win the report latest selector");
    assert.ok(listCtoSources(reportStorageFor(cwd)).some((e) => e.id === "md run with space"));
    assert.ok(listSessions(reportStorageFor(cwd)).some((s) => s.kind === "cto" && s.id === "md run with space"));

    // JSON runs with an unsafe token are never authoritative, even when a
    // hand-written state file otherwise resembles a durable CtoState.
    writeRun(cwd, makeCtoState({ id: "run with space", updated_at: "2026-08-08T11:00:00.000Z" }));
    assert.equal(resolveCtoSource(reportStorageFor(cwd), "run with space"), null);
    const exoticJson = listCtoSources(reportStorageFor(cwd)).find((entry) => entry.id === "run with space");
    assert.ok(exoticJson);
    assert.equal(exoticJson?.format, "json");
    assert.equal(exoticJson?.status, "error");
    assert.equal(exoticJson?.state, null);
    assert.match(exoticJson?.error ?? "", /unreadable state\.json/);
    assert.throws(
      () => buildSessionReport(reportStorageFor(cwd), { kind: "cto", id: "run with space" }, reportOptions(cwd, CTO_FIXTURE)),
      /cto session "run with space" not found/,
    );

    // Traversal-shaped selectors are rejected outright — never aliased.
    assert.equal(resolveCtoSource(reportStorageFor(cwd), "../escape"), null);
    assert.equal(resolveCtoSource(reportStorageFor(cwd), "a/b"), null);
    assert.equal(resolveCtoSource(reportStorageFor(cwd), ".."), null);
    assert.equal(resolveCtoSource(reportStorageFor(cwd), "."), null);
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
    assert.throws(() => resolveDoWorkSource(reportStorageFor(cwd), "broken"), /JSON/);
    assert.throws(() => buildSessionReport(reportStorageFor(cwd), { kind: "do-work", id: "broken" }, reportOptions(cwd, STANDARD_FIXTURE)), /JSON/, "report parity");

    const broken = listDoWorkSources(reportStorageFor(cwd)).find((e) => e.id === "broken");
    assert.equal(broken?.status, "error");
    assert.equal(broken?.state, null);
    assert.equal(broken?.updatedAt, null);

    // Corrupt legacy root: same split — exact id throws, enumeration degrades.
    writeLegacy(cwd, makeTeamState());
    writeFileSync(join(cwd, ".work-state", "team-state.json"), "{ nope");
    assert.throws(() => resolveDoWorkSource(reportStorageFor(cwd), "legacy"), /JSON/);
    const legacyEntry = listDoWorkSources(reportStorageFor(cwd)).find((e) => e.isLegacy);
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

    assert.equal(resolveDoWorkSource(reportStorageFor(cwd))?.id, "good", "corrupt states skipped in the latest scan");
    assert.equal(buildSessionReport(reportStorageFor(cwd), { kind: "do-work" }, reportOptions(cwd, STANDARD_FIXTURE)).source.id, "good", "report parity");
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

    const sessions = listSessions(reportStorageFor(cwd));
    const ids = sessions.map((s) => `${s.kind}:${s.id}`);
    assert.deepEqual(ids, ["cto:run-1", "cto:run-2", "do-work:b", "do-work:a", "do-work:legacy", "cto:corrupt"]);

    // Deterministic: identical result across calls.
    assert.deepEqual(
      listSessions(reportStorageFor(cwd)).map((s) => `${s.kind}:${s.id}`),
      ids,
    );
    // Within-kind order is also deterministic.
    assert.deepEqual(
      listDoWorkSources(reportStorageFor(cwd)).map((s) => s.id),
      ["b", "a", "legacy"],
    );
    assert.deepEqual(
      listCtoSources(reportStorageFor(cwd)).map((s) => s.id),
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

    const sessions = listSessions(reportStorageFor(cwd));
    assert.ok(sessions.some((s) => s.kind === "do-work" && s.id === "visualize"), "feature 'visualize' is a real session");
    assert.ok(!sessions.some((s) => s.id === "vibe-report"), "vibe-report is never a session");
    assert.ok(!sessions.some((s) => s.id === "events.jsonl"), "events.jsonl is never a session");

    // Path-level exclusion for generated output / docs / event stream.
    assert.equal(isExcludedSourcePath(join(".work-state", "visualize", "index.html")), true);
    assert.equal(isExcludedSourcePath(join("vibe-report", "visualize-e2e.md")), true);
    assert.equal(isExcludedSourcePath(join(".work-state", "cto", "run-1", "events.jsonl")), true);
    assert.equal(isExcludedSourcePath(join(".work-state", "features", "alpha", "state.json")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session-source: ctoRunLocalFiles excludes state.json, answers, events.jsonl and non-md/json files", () => {
  const cwd = tmpWorkspace();
  try {
    const runDir = join(".work-state", "cto", "run-1");
    const runFsDir = join(cwd, runDir);
    mkdirSync(join(runFsDir, "answers"), { recursive: true });
    mkdirSync(join(runFsDir, "observability"), { recursive: true });
    writeFileSync(join(runFsDir, "team-plan.md"), "# Team Plan\n");
    writeFileSync(join(runFsDir, "decisions.md"), "# Decisions\n");
    writeFileSync(join(runFsDir, "summary.json"), "{}");
    writeFileSync(join(runFsDir, "state.json"), "{}"); // canonical state — never an artifact
    writeFileSync(join(runFsDir, "answers", "esc-1.json"), "{}");
    writeFileSync(join(runFsDir, "observability", "events.jsonl"), "{}");
    writeFileSync(join(runFsDir, "notes.txt"), "not md/json\n");

    const files = ctoRunLocalFiles(reportStorageFor(cwd), runDir);
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

    const feature = resolveDoWorkSource(reportStorageFor(cwd), "alpha");
    assert.equal(feature?.artifactsDir, join(".work-state", "features", "alpha", "artifacts"));

    const legacy = resolveDoWorkSource(reportStorageFor(cwd), "legacy");
    assert.equal(legacy?.artifactsDir, join(".work-state", "artifacts"), "legacy root uses the compatibility artifacts dir");

    assert.equal(ctoTeamArtifactsDir("alpha"), join(".work-state", "artifacts", "alpha"), "CTO team artifacts location");

    const run = resolveCtoSource(reportStorageFor(cwd), "run-1");
    assert.equal(run?.runDir, join(".work-state", "cto", "run-1"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
