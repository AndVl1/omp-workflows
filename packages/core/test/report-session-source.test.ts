/**
 * Canonical report-source and assembly regressions.
 *
 * Ordinary report selection is explicit: run id plus optional immutable
 * revision. Legacy feature/team-state pointers remain migration inputs only;
 * they are never consulted by report assembly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCanonicalRunReport, buildSessionReport } from "../src/report/assemble.js";
import { resolveCanonicalRunSource } from "../src/report/canonical-source.js";
import { listCtoSources, resolveCtoSource } from "../src/report/session-source.js";
import type { TeamState } from "../src/engine/types.js";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const REVISION = "rev-1";

function makeState(runId: string, task: string, updatedAt: string): TeamState {
  return {
    schema: 2,
    run_id: runId,
    run_key: runId,
    lifecycle_status: "active",
    rework_generation: 0,
    branch: "main",
    classification: {
      type: "FEATURE",
      complexity: "MEDIUM",
      confidence: "HIGH",
      workflow: "lightweight",
      autonomous: false,
    },
    task,
    workflow_override: false,
    issue: null,
    stage_cursor: "implementation",
    stages: [{ id: "implementation", status: "in_progress" }],
    artifacts: { implementation: "artifacts/implementation.json" },
    pause: { kind: "none", reason: "" },
    updated_at: updatedAt,
  };
}

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "canonical-report-"));
}

function isMigrationRequired(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error) || !("unchanged" in error)) return false;
  return error.code === "migration_required" && error.unchanged === true;
}

function isMissingRun(error: unknown, runId: string): boolean {
  if (!error || typeof error !== "object" || !("code" in error) || !("run_id" in error)) return false;
  return error.code === "run_not_found" && error.run_id === runId;
}

function writeCanonicalState(cwd: string, state: TeamState, revisionId?: string): string {
  const root = revisionId
    ? join(cwd, ".work-state", "runs", state.run_id!, "revisions", revisionId)
    : join(cwd, ".work-state", "runs", state.run_id!);
  mkdirSync(join(root, "artifacts"), { recursive: true });
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  writeFileSync(join(root, "artifacts", "implementation.json"), JSON.stringify({ title: state.task }));
  return statePath;
}

test("report source: explicit canonical run selection is stable despite legacy pointers and newer runs", () => {
  const cwd = tmpWorkspace();
  try {
    const stateA = makeState(RUN_A, "run A", "2026-08-08T10:00:00.000Z");
    const stateB = makeState(RUN_B, "run B", "2026-08-08T11:00:00.000Z");
    writeCanonicalState(cwd, stateA);
    writeCanonicalState(cwd, stateB);

    // Legacy state is deliberately newer and points at a different feature.
    const legacyFeature = join(cwd, ".work-state", "features", "newest-feature");
    mkdirSync(legacyFeature, { recursive: true });
    writeFileSync(join(legacyFeature, "state.json"), JSON.stringify({ ...stateB, task: "legacy guess" }));
    writeFileSync(join(cwd, ".work-state", ".active-feature"), "newest-feature\n");
    writeFileSync(join(cwd, ".work-state", "team-state.json"), JSON.stringify({ ...stateB, task: "legacy root guess" }));

    const report = buildCanonicalRunReport(cwd, { run_id: RUN_A });
    assert.equal(report.source.id, RUN_A);
    assert.equal(report.meta.task, "run A");
    assert.equal(report.artifacts.find((artifact) => artifact.id === "implementation")?.summary, "run A");
    assert.equal(report.source.statePath, join(cwd, ".work-state", "runs", RUN_A, "state.json"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("report source: explicit revision reads only the requested immutable state and artifacts", () => {
  const cwd = tmpWorkspace();
  try {
    writeCanonicalState(cwd, makeState(RUN_A, "current", "2026-08-08T11:00:00.000Z"));
    const revisionPath = writeCanonicalState(cwd, makeState(RUN_A, "revision", "2026-08-08T09:00:00.000Z"), REVISION);

    const source = resolveCanonicalRunSource(cwd, { run_id: RUN_A, revision_id: REVISION });
    assert.equal(source.revision_id, REVISION);
    assert.equal(source.statePath, revisionPath);
    const report = buildCanonicalRunReport(cwd, { run_id: RUN_A, revision_id: REVISION });
    assert.equal(report.source.id, RUN_A);
    assert.equal(report.source.statePath, revisionPath);
    assert.equal(report.meta.task, "revision");
    assert.equal(report.artifacts.find((artifact) => artifact.id === "implementation")?.summary, "revision");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("report source: CTO exact JSON namespace remains explicit and never falls back to markdown/latest", () => {
  const cwd = tmpWorkspace();
  try {
    const ctoRoot = join(cwd, ".work-state", "cto");
    const jsonDir = join(ctoRoot, "cto-a");
    const markdownDir = join(ctoRoot, "md-only");
    mkdirSync(jsonDir, { recursive: true });
    mkdirSync(markdownDir, { recursive: true });
    writeFileSync(join(jsonDir, "state.json"), JSON.stringify({
      schema: 2,
      id: "cto-a",
      task: "cto report",
      branch: "main",
      autonomous: false,
      plan: { id: "cto-a", task: "cto report", teams: [], created_at: "2026-08-08T10:00:00.000Z" },
      teams: [],
      integration: { status: "pending" },
      pause: { kind: "none", reason: "" },
      updated_at: "2026-08-08T10:00:00.000Z",
    }));
    writeFileSync(join(markdownDir, "team-plan.md"), "# markdown-only\n");

    const exact = resolveCtoSource(cwd, "cto-a");
    assert.equal(exact?.id, "cto-a");
    assert.equal(resolveCtoSource(cwd), null, "omitted CTO id never means latest");
    assert.equal(resolveCtoSource(cwd, "md-only"), null, "markdown-only CTO state is not a runtime report source");
    assert.deepEqual(listCtoSources(cwd).map((entry) => entry.id), ["cto-a"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("report assembly: implicit and legacy ordinary selectors fail with migration_required", () => {
  const cwd = tmpWorkspace();
  try {
    const featureDir = join(cwd, ".work-state", "features", "legacy-slug");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, "state.json"), JSON.stringify(makeState(RUN_A, "legacy", "2026-08-08T10:00:00.000Z")));
    writeFileSync(join(cwd, ".work-state", ".active-feature"), "legacy-slug\n");

    const selectors = [
      undefined,
      {},
      { kind: "do-work" as const },
      { kind: "do-work" as const, id: "legacy-slug" },
    ];
    for (const selector of selectors) {
      assert.throws(
        () => buildSessionReport(cwd, selector),
        isMigrationRequired,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("report source: missing canonical run is not remapped to a legacy or newer run", () => {
  const cwd = tmpWorkspace();
  try {
    writeCanonicalState(cwd, makeState(RUN_B, "other run", "2026-08-08T11:00:00.000Z"));
    assert.throws(() => buildCanonicalRunReport(cwd, { run_id: RUN_A }), (error: unknown) => isMissingRun(error, RUN_A));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
