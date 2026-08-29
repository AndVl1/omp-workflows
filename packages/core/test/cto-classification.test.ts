/**
 * Model-first CTO classification persistence (review follow-up): new CTO task
 * runs persist the structured model classification, `classification.autonomous`
 * is the AUTHORITY (the legacy top-level field never overrides it), standby
 * stays the documented engine-created exception with no user task, and markdown
 * state remains observational/degraded evidence rather than authoritative
 * durable state.
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCto,
  newCtoState as createCtoState,
  writeCtoState,
  resolveCtoAutonomous,
  type TeamDef,
} from "@andvl1/omp-workflows-core";
import { readCtoState } from "../src/cto/state.js";
import { findActiveCtoRun, listCtoSources } from "../src/report/session-source.js";
import { readWorkflowProfile, workflowV2Fixture } from "./workflow-v2-fixtures.js";
import { reportStorageFor } from "./report-storage-fixtures.js";

function sampleDefs(): Record<string, TeamDef> {
  return {
    backend: {
      id: "backend",
      name: "Backend",
      scope: ["backend-kotlin"],
      profile: "lightweight",
      profile_identity: fixture.profile_identity,
      lead: "team-lead",
      roster: ["backend-kotlin"],
    },
  };
}

const fixture = workflowV2Fixture(readWorkflowProfile("lightweight"), {
  roleAgents: { "team-lead": "team-lead", "backend-kotlin": "backend-kotlin" },
  agentNames: ["team-lead", "backend-kotlin"],
});

function runIdentity(runId: string) {
  return { ...fixture.run_identity, run_id: runId };
}

function backendTeam(slice: string, runId = "test-run") {
  return {
    team: "backend",
    scope: ["backend-kotlin"],
    slice,
    profile: "lightweight",
    run_identity: runIdentity(runId),
    profile_identity: fixture.profile_identity,
    lead_ref: fixture.effective_policy.roles["team-lead"]!,
    roster_refs: [fixture.effective_policy.roles["backend-kotlin"]!],
  };
}
function testCtoState(opts: Record<string, unknown>) {
  const run_identity = runIdentity(String(opts.id ?? "test-run"));
  const plan = { ...(opts.plan as Record<string, unknown>), run_identity };
  return createCtoState({ ...opts, run_identity, plan } as Parameters<typeof createCtoState>[0]);
}
test("cto-class: runCto persists the model classification; classification.autonomous is the authority", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-class-"));
  const run_id = "class-run";
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
      teams: [backendTeam("fix 500", run_id)],
      defs: sampleDefs(),
      project_identity: fixture.project_identity,
      run_identity: runIdentity(run_id),
      catalog: fixture.catalog,
      effective_policy: fixture.effective_policy,
      agent_inventory: fixture.agent_inventory,
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

    const reloaded = readCtoState(res.plan.id, root, res.state.run_identity);
    assert.equal(reloaded?.classification?.autonomous, true, "classification persisted and readable");
    assert.equal(resolveCtoAutonomous(reloaded!), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto-class: runCto without classification keeps the legacy top-level flag (no silent classification)", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-class-legacy-"));
  const run_id = "legacy-class-run";
  try {
    const res = runCto({
      task: "Legacy task",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [backendTeam("s", run_id)],
      defs: sampleDefs(),
      project_identity: fixture.project_identity,
      run_identity: runIdentity(run_id),
      catalog: fixture.catalog,
      effective_policy: fixture.effective_policy,
      agent_inventory: fixture.agent_inventory,
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
  const state = testCtoState({
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
  const state = testCtoState({
    id: "r2",
    task: "t",
    branch: "b",
    autonomous: false, // explicit caller flag must survive the malformed classification
    classification: {
      type: "BUG_FIX",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: "true", // non-boolean runtime value from a loosely typed parse
    } as unknown as Parameters<typeof createCtoState>[0]["classification"],
    plan: { id: "r2", task: "t", teams: [], created_at: now },
  });
  assert.equal(state.classification, undefined, "malformed classification is not persisted");
  assert.equal(state.autonomous, false, "explicit caller flag is the fallback — never silently discarded");
  assert.equal(resolveCtoAutonomous(state), false);
});

test("cto-class: newCtoState with a partial runtime classification (boolean autonomous only) is not authoritative — caller flag wins, nothing persists", () => {
  const now = new Date().toISOString();
  const state = testCtoState({
    id: "r3",
    task: "t",
    branch: "b",
    autonomous: false,
    classification: {
      autonomous: true, // partial: type/complexity/confidence missing — not a valid PHASE-0 classification
    } as unknown as Parameters<typeof createCtoState>[0]["classification"],
    plan: { id: "r3", task: "t", teams: [], created_at: now },
  });
  assert.equal(state.classification, undefined, "partial classification is not persisted");
  assert.equal(state.autonomous, false, "explicit caller flag is the fallback for partial runtime values — boolean autonomous alone is not authority");
  assert.equal(resolveCtoAutonomous(state), false);
});

test("cto-class: markdown evidence is degraded; durable v2 classification wins over markdown", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-class-md-"));
  try {
    const markdownRunId = "md-class-run";
    const markdownDir = join(root, ".work-state", "cto", markdownRunId);
    mkdirSync(markdownDir, { recursive: true });
    writeFileSync(
      join(markdownDir, "cto_discovery.md"),
      [
        "# Fix login bug",
        "",
        "autonomous: true",
        'classification: { "type": "BUG_FIX", "complexity": "QUICK", "confidence": "HIGH", "autonomous": false, "autonomous_reason": "user wants review" }',
        "",
        "Discovered scope.",
      ].join("\n"),
    );
    writeFileSync(join(markdownDir, "team-plan.md"), "# Team Plan\n- team: backend\n");

    const storage = reportStorageFor(root);
    const markdown = listCtoSources(storage).find((entry) => entry.id === markdownRunId);
    assert.ok(markdown, "markdown evidence is discoverable as a projection");
    assert.equal(markdown?.format, "markdown");
    assert.equal(markdown?.status, "degraded");
    assert.equal(markdown?.state, null, "markdown evidence has no durable state");
    assert.equal(markdown?.statePath, null, "markdown evidence has no canonical state path");
    assert.equal(findActiveCtoRun(storage), null, "markdown evidence is never an active amendable run");

    // A complete v2 state remains authoritative even when markdown evidence
    // in the same run directory contains conflicting classification values.
    const durableRunId = "durable-class-run";
    const durable = runCto({
      task: "Fix login bug",
      cwd: root,
      branch: "fix/login",
      autonomous: false,
      classification: {
        type: "BUG_FIX",
        complexity: "QUICK",
        confidence: "HIGH",
        autonomous: true,
        autonomous_reason: "model classification",
      },
      teams: [backendTeam("fix 500", durableRunId)],
      defs: sampleDefs(),
      project_identity: fixture.project_identity,
      run_identity: runIdentity(durableRunId),
      catalog: fixture.catalog,
      effective_policy: fixture.effective_policy,
      agent_inventory: fixture.agent_inventory,
    });
    assert.equal(durable.ok, true);
    if (!durable.ok) return;
    writeFileSync(
      join(root, ".work-state", "cto", durableRunId, "cto_discovery.md"),
      [
        "# Fix login bug",
        "",
        "autonomous: false",
        'classification: { "type": "BUG_FIX", "complexity": "QUICK", "confidence": "HIGH", "autonomous": false, "autonomous_reason": "markdown evidence" }',
      ].join("\n"),
    );

    const active = findActiveCtoRun(storage);
    assert.ok(active, "durable v2 run remains active");
    assert.equal(active?.runId, durableRunId);
    assert.equal(active?.state.classification?.type, "BUG_FIX");
    assert.equal(active?.state.classification?.autonomous, true, "durable model classification wins over markdown evidence");
    assert.equal(active?.state.autonomous, true, "top-level mirror remains bound to durable classification");
    assert.equal(resolveCtoAutonomous(active!.state), true, "classification.autonomous remains the authority");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-class: markdown state without durable v2 state is observational/degraded and cannot supply legacy autonomy", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-class-mdlegacy-"));
  try {
    const runId = "md-legacy-run";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "cto_discovery.md"), "# Legacy run\nautonomous: true\n");
    writeFileSync(join(runDir, "team-plan.md"), "# Team Plan\n- team: backend\n");

    const storage = reportStorageFor(root);
    const source = listCtoSources(storage).find((entry) => entry.id === runId);
    assert.ok(source, "markdown evidence is discoverable as a degraded projection");
    assert.equal(source?.format, "markdown");
    assert.equal(source?.status, "degraded");
    assert.equal(source?.state, null, "markdown evidence cannot restore CtoState");
    assert.equal(findActiveCtoRun(storage), null, "legacy markdown autonomy is not authoritative");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-class: malformed classification markdown remains observational/degraded and never becomes authority", () => {
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

    const storage = reportStorageFor(root);
    const source = listCtoSources(storage).find((entry) => entry.id === runId);
    assert.ok(source, "malformed markdown evidence is still a degraded projection");
    assert.equal(source?.format, "markdown");
    assert.equal(source?.status, "degraded");
    assert.equal(source?.state, null, "malformed markdown cannot restore CtoState");
    assert.equal(findActiveCtoRun(storage), null, "malformed markdown never supplies a legacy fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-class: standby is engine-created — no classification, top-level autonomous:true, documented", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-class-standby-"));
  try {
    const now = new Date().toISOString();
    const standby = testCtoState({
      id: "standby-1",
      task: "standby — awaiting inbox tasks",
      branch: "",
      autonomous: true,
      standby: true,
      plan: { id: "standby-1", task: "standby — awaiting inbox tasks", teams: [], created_at: now },
    });
    writeCtoState(standby, root);

    const storage = reportStorageFor(root);
    const active = findActiveCtoRun(storage);
    assert.equal(active?.runId, "standby-1", "standby run is active");
    assert.equal(active?.state.classification, undefined, "standby has no user task — nothing to classify");
    assert.equal(active?.state.autonomous, true, "engine-created standby marker preserved");
    assert.equal(resolveCtoAutonomous(active!.state), true, "top-level fallback applies without a classification");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
