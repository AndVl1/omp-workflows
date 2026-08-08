/**
 * Model-first CTO classification persistence (review follow-up): new CTO task
 * runs persist the structured model classification, `classification.autonomous`
 * is the AUTHORITY (the legacy top-level field never overrides it), standby
 * stays the documented engine-created exception with no user task, and
 * markdown state restores the classification from the persisted line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCto,
  findActiveCtoRun,
  newCtoState,
  readCtoState,
  writeCtoState,
  resolveCtoAutonomous,
  type TeamDef,
} from "@andvl1/omp-workflows-core";

function sampleDefs(): Record<string, TeamDef> {
  return {
    backend: { id: "backend", name: "Backend", scope: ["backend-kotlin"], profile: "lightweight", lead: "team-lead", roster: ["backend-kotlin"] },
  };
}

test("cto-class: runCto persists the model classification; classification.autonomous is the authority", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-class-"));
  try {
    const res = runCto({
      task: "Fix login bug",
      cwd: root,
      branch: "fix/login",
      autonomous: false, // legacy flag must NOT win over the classification
      classification: {
        type: "BUG_FIX",
        complexity: "QUICK",
        confidence: "HIGH",
        autonomous: true,
        autonomous_reason: "task explicitly waives approval",
      },
      teams: [{ team: "backend", slice: "fix 500" }],
      defs: sampleDefs(),
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.state.classification, {
      type: "BUG_FIX",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: true,
      autonomous_reason: "task explicitly waives approval",
    });
    assert.equal(res.state.autonomous, true, "top-level mirrors the classification decision for legacy readers");
    assert.equal(resolveCtoAutonomous(res.state), true, "classification.autonomous is the authority");

    const reloaded = readCtoState(res.plan.id, root);
    assert.equal(reloaded?.classification?.autonomous, true, "classification persisted and readable");
    assert.equal(resolveCtoAutonomous(reloaded!), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-class: runCto without classification keeps the legacy top-level flag (no silent classification)", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-class-legacy-"));
  try {
    const res = runCto({
      task: "Legacy task",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [{ team: "backend", slice: "s" }],
      defs: sampleDefs(),
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.state.classification, undefined, "no classification persisted on the legacy path");
    assert.equal(res.state.autonomous, false, "caller flag stored verbatim — never defaulted");
    assert.equal(resolveCtoAutonomous(res.state), false, "top-level flag is the fallback authority");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-class: newCtoState mirrors classification into the top-level field — the two never disagree", () => {
  const now = new Date().toISOString();
  const state = newCtoState({
    id: "r1",
    task: "t",
    branch: "b",
    autonomous: true, // contradicting legacy flag — must be ignored
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "MEDIUM", autonomous: false },
    plan: { id: "r1", task: "t", teams: [], created_at: now },
  });
  assert.equal(state.classification?.autonomous, false);
  assert.equal(state.autonomous, false, "top-level mirrors classification.autonomous, not the caller flag");
  assert.equal(resolveCtoAutonomous(state), false);
});

test("cto-class: newCtoState with a malformed runtime classification keeps the explicit caller flag (never a half-stored classification)", () => {
  const now = new Date().toISOString();
  const state = newCtoState({
    id: "r2",
    task: "t",
    branch: "b",
    autonomous: false, // explicit caller flag must survive the malformed classification
    classification: {
      type: "BUG_FIX",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: "true", // non-boolean runtime value from a loosely typed parse
    } as unknown as Parameters<typeof newCtoState>[0]["classification"],
    plan: { id: "r2", task: "t", teams: [], created_at: now },
  });
  assert.equal(state.classification, undefined, "malformed classification is not persisted");
  assert.equal(state.autonomous, false, "explicit caller flag is the fallback — never silently discarded");
  assert.equal(resolveCtoAutonomous(state), false);
});

test("cto-class: newCtoState with a partial runtime classification (boolean autonomous only) is not authoritative — caller flag wins, nothing persists", () => {
  const now = new Date().toISOString();
  const state = newCtoState({
    id: "r3",
    task: "t",
    branch: "b",
    autonomous: false,
    classification: {
      autonomous: true, // partial: type/complexity/confidence missing — not a valid PHASE-0 classification
    } as unknown as Parameters<typeof newCtoState>[0]["classification"],
    plan: { id: "r3", task: "t", teams: [], created_at: now },
  });
  assert.equal(state.classification, undefined, "partial classification is not persisted");
  assert.equal(state.autonomous, false, "explicit caller flag is the fallback for partial runtime values — boolean autonomous alone is not authority");
  assert.equal(resolveCtoAutonomous(state), false);
});

test("cto-class: markdown state restores the structured classification; classification.autonomous wins over the legacy line", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-class-md-"));
  try {
    const runId = "md-class-run";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "cto_discovery.md"),
      [
        "# Fix login bug",
        "",
        "autonomous: true",
        'classification: { "type": "BUG_FIX", "complexity": "QUICK", "confidence": "HIGH", "autonomous": false, "autonomous_reason": "user wants review" }',
        "",
        "Discovered scope.",
      ].join("\n"),
    );
    writeFileSync(join(runDir, "team-plan.md"), "# Team Plan\n- team: backend\n");

    const active = findActiveCtoRun(root);
    assert.ok(active, "markdown run with a classification is active");
    assert.equal(active?.state.classification?.type, "BUG_FIX");
    assert.equal(active?.state.classification?.autonomous, false);
    assert.equal(active?.state.autonomous, false, "top-level mirrors the classification — the legacy true line must NOT win");
    assert.equal(resolveCtoAutonomous(active!.state), false, "classification.autonomous is the authority");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-class: markdown state without a classification line falls back to the legacy top-level line", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-class-mdlegacy-"));
  try {
    const runId = "md-legacy-run";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "cto_discovery.md"), "# Legacy run\nautonomous: true\n");
    writeFileSync(join(runDir, "team-plan.md"), "# Team Plan\n- team: backend\n");

    const active = findActiveCtoRun(root);
    assert.ok(active, "legacy markdown run detected");
    assert.equal(active?.state.classification, undefined, "no classification without a classification line");
    assert.equal(active?.state.autonomous, true, "legacy top-level line is the fallback");
    assert.equal(resolveCtoAutonomous(active!.state), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-class: malformed classification line is ignored — legacy fallback, never a half-stored classification", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-class-malformed-"));
  try {
    const runId = "md-malformed-run";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "cto_discovery.md"),
      [
        "# Task",
        "autonomous: false",
        'classification: { "type": "BUG_FIX", "autonomous": "true" }', // incomplete + non-boolean
        "",
      ].join("\n"),
    );
    writeFileSync(join(runDir, "team-plan.md"), "# Team Plan\n- team: backend\n");

    const active = findActiveCtoRun(root);
    assert.ok(active, "run stays active on the legacy fallback");
    assert.equal(active?.state.classification, undefined, "malformed classification is not stored");
    assert.equal(active?.state.autonomous, false, "legacy line is the fallback authority");
    assert.equal(resolveCtoAutonomous(active!.state), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-class: standby is engine-created — no classification, top-level autonomous:true, documented", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-class-standby-"));
  try {
    const now = new Date().toISOString();
    const standby = newCtoState({
      id: "standby-1",
      task: "standby — awaiting inbox tasks",
      branch: "",
      autonomous: true,
      standby: true,
      plan: { id: "standby-1", task: "standby — awaiting inbox tasks", teams: [], created_at: now },
    });
    writeCtoState(standby, root);

    const active = findActiveCtoRun(root);
    assert.equal(active?.runId, "standby-1", "standby run is active");
    assert.equal(active?.state.classification, undefined, "standby has no user task — nothing to classify");
    assert.equal(active?.state.autonomous, true, "engine-created standby marker preserved");
    assert.equal(resolveCtoAutonomous(active!.state), true, "top-level fallback applies without a classification");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
