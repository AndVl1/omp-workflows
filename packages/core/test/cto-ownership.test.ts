/**
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 * RC4/RC5 regression tests: active-run selection is ownership-safe and
 * terminality covers all-teams-done plus integration-done. Markdown CTO
 * evidence remains observational and cannot authorize an active run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCto,
  setIntegration,
  setTeamStatus,
  newCtoState as createCtoState,
  writeCtoState,
  isCtoRunTerminal,
  ctoBackstop,
  type TeamDef,
} from "@andvl1/omp-workflows-core";
import { findActiveCtoRun } from "../src/report/session-source.js";
import { readCtoState } from "../src/cto/state.js";
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
    frontend: {
      id: "frontend",
      name: "Frontend",
      scope: ["frontend"],
      profile: "lightweight",
      profile_identity: fixture.profile_identity,
      lead: "team-lead",
      roster: ["frontend"],
    },
  };
}
const fixture = workflowV2Fixture(readWorkflowProfile("lightweight"), {
  roleAgents: {
    "team-lead": "team-lead",
    "backend-kotlin": "backend-kotlin",
    frontend: "frontend",
  },
  agentNames: ["team-lead", "backend-kotlin", "frontend"],
  session: { session_id: "sess-A", lifecycle_id: "lifecycle-A" },
});
function runIdentity(runId: string) {
  return { ...fixture.run_identity, run_id: runId };
}
const ctoContext = {
  project_identity: fixture.project_identity,
  catalog: fixture.catalog,
  effective_policy: fixture.effective_policy,
  agent_inventory: fixture.agent_inventory,
};

function teamInput(team: string, slice: string, runId: string) {
  const def = sampleDefs()[team]!;
  return {
    team,
    scope: [...def.scope],
    slice,
    profile: "lightweight",
    run_identity: runIdentity(runId),
    profile_identity: fixture.profile_identity,
    lead_ref: fixture.effective_policy.roles["team-lead"]!,
    roster_refs: def.roster.map((role) => fixture.effective_policy.roles[role]!),
  };
}

test("cto-owner: same-session task runs amend, foreign sessions get a fresh contract", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-"));
  const run_id = "owner-run";
  try {
    const res = runCto({
      task: "Feature owned",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [teamInput("backend", "s1", run_id)],
      defs: sampleDefs(),
      owner_session: fixture.run_identity.session.session_id,
      ...ctoContext,
      run_identity: runIdentity(run_id),
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    const storage = reportStorageFor(root);
    const owner = findActiveCtoRun(storage, { sessionId: fixture.run_identity.session.session_id });
    assert.equal(owner?.runId, res.plan.id, "owner session sees the durable run as active");

    const foreign = findActiveCtoRun(storage, { sessionId: "sess-B" });
    assert.equal(foreign, null, "foreign session must NOT amend another session's task run");

    const sessionless = findActiveCtoRun(storage);
    assert.equal(sessionless?.runId, res.plan.id, "session-less presence lookup still sees the run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-owner: standby runs remain adoptable across sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-standby-"));
  try {
    const now = new Date().toISOString();
    const run_identity = runIdentity("standby-1");
    const standby = createCtoState({
      id: "standby-1",
      task: "standby — awaiting inbox tasks",
      branch: "",
      autonomous: true,
      standby: true,
      run_identity,
      plan: { id: "standby-1", task: "standby — awaiting inbox tasks", teams: [], created_at: now, run_identity },
    });
    writeCtoState(standby, root);

    const storage = reportStorageFor(root);
    for (const sessionId of ["sess-A", "sess-B", undefined]) {
      const active = findActiveCtoRun(storage, sessionId ? { sessionId } : {});
      assert.equal(active?.runId, "standby-1", `standby adoptable for session ${String(sessionId)}`);
      assert.equal(active?.state.standby, true, "standby marker preserved");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto-owner: all teams done plus integration done is terminal without pause done", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-terminal-"));
  const run_id = "terminal-run";
  try {
    const res = runCto({
      task: "Wave complete",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [teamInput("backend", "s1", run_id), teamInput("frontend", "s2", run_id)],
      defs: sampleDefs(),
      ...ctoContext,
      run_identity: runIdentity(run_id),
    });
    assert.ok(res);
    assert.equal(isCtoRunTerminal(res.state), false, "fresh run is not terminal");

    // One team still in_progress + integration done -> NOT terminal yet.
    setTeamStatus(res.state, "backend", "done", root);
    setIntegration(res.state, "done", "wave 1", root);
    assert.equal(isCtoRunTerminal(res.state), false, "a team still running keeps the run active");
    const storage = reportStorageFor(root);
    assert.equal(findActiveCtoRun(storage)?.runId, res.plan.id, "integration done alone must not finish a run with active teams");

    // All teams done + integration done -> terminal even with pause.kind none.
    setTeamStatus(res.state, "frontend", "done", root);
    assert.equal(isCtoRunTerminal(res.state), true, "all teams done + integration done is terminal");
    assert.equal(findActiveCtoRun(storage), null, "terminal run is not selectable as active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-owner: state without pause is non-terminal and never crashes detection (legacy state)", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-nopause-"));
  const run_id = "nopause-run";
  try {
    const res = runCto({
      task: "Legacy run",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [teamInput("backend", "s1", run_id)],
      defs: sampleDefs(),
      ...ctoContext,
      run_identity: runIdentity(run_id),
    });

    // Simulate a legacy state.json written before the pause field existed.
    const statePath = join(root, ".work-state", "cto", res.plan.id, "state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    delete raw.pause;
    writeFileSync(statePath, JSON.stringify(raw, null, 2));

    const state = readCtoState(res.plan.id, root, res.state.run_identity);
    assert.ok(state);
    assert.equal(state?.pause, undefined, "legacy state genuinely lacks pause");

    assert.equal(isCtoRunTerminal(state!), false, "missing pause alone is NOT terminal");
    const storage = reportStorageFor(root);
    assert.equal(findActiveCtoRun(storage)?.runId, res.plan.id, "legacy state is still detected as active without crashing");

    // Missing pause must not crash ctoBackstop either: not a done claim ->
    // continue; background-worthy pauses keep going; no DoD gate invoked.
    assert.deepEqual(ctoBackstop(state!, root), { continue: true }, "missing pause is not a done claim — backstop continues");
    assert.deepEqual(ctoBackstop({ ...state!, pause: { kind: "background_wait", reason: "parked" } }, root), { continue: true });
    assert.deepEqual(ctoBackstop({ ...state!, pause: { kind: "needs_human", reason: "blocker" } }, root), { continue: true });
    assert.deepEqual(ctoBackstop({ ...state!, pause: { kind: "failed", reason: "boom" } }, root), { continue: true });

    // Missing pause + all teams done + integration done -> still terminal.
    setTeamStatus(state!, "backend", "done", root);
    setIntegration(state!, "done", "wave 1", root);
    assert.equal(isCtoRunTerminal(state!), true, "integration/team conditions prove terminality even without pause");
    assert.equal(findActiveCtoRun(storage), null, "completed legacy run is not selectable");

    // Integration done without a pause still invokes the DoD gate: the run
    // has no dod.json, so the backstop blocks on the missing DoD claim.
    const gate = ctoBackstop(state!, root);
    if (!("decision" in gate)) assert.fail(`expected a block on the incomplete DoD, got ${JSON.stringify(gate)}`);
    assert.equal(gate.decision, "block", "integration done invokes the DoD gate even with missing pause");
    assert.match(gate.reason, /DoD/, "block reason names the DoD gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-owner: markdown state is observational only and never an authoritative active run", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-mdmeta-"));
  try {
    const runId = "md-owned-run";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "cto_discovery.md"),
      [
        "# Implement Feature A",
        "",
        "autonomous: true",
        "session: sess-A",
        "",
        "Discovered scope.",
      ].join("\n"),
    );
    writeFileSync(join(runDir, "team-plan.md"), "# Team Plan\n- team: backend\n");

    const storage = reportStorageFor(root);
    assert.equal(
      findActiveCtoRun(storage, { sessionId: fixture.run_identity.session.session_id }),
      null,
      "markdown metadata cannot create an authoritative active run",
    );
    assert.equal(
      findActiveCtoRun(storage, { sessionId: "sess-B" }),
      null,
      "foreign lookup also ignores markdown-only evidence",
    );
    assert.equal(findActiveCtoRun(storage), null, "session-less lookup ignores markdown-only evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-owner: markdown state without metadata remains observational only", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-mdlegacy-"));
  try {
    const runId = "legacy-md-run";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "cto_discovery.md"), "# Legacy run\n");
    writeFileSync(join(runDir, "team-plan.md"), "# Team Plan\n- team: backend\n");

    const storage = reportStorageFor(root);
    assert.equal(
      findActiveCtoRun(storage, { sessionId: "sess-X" }),
      null,
      "legacy markdown evidence cannot create an amendable run",
    );
    assert.equal(findActiveCtoRun(storage), null, "legacy markdown evidence has no active-run authority");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
