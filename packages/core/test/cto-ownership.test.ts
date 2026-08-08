/**
 * RC4/RC5 regression tests: active-run selection is ownership-safe and
 * terminality covers all-teams-done plus integration-done. Also covers the
 * markdown-state metadata contract (RC3) that restores autonomy and session
 * ownership for agent-written runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCto,
  findActiveCtoRun,
  setIntegration,
  setTeamStatus,
  newCtoState,
  writeCtoState,
  isCtoRunTerminal,
  type TeamDef,
} from "@andvl1/omp-workflows-core";

function sampleDefs(): Record<string, TeamDef> {
  return {
    backend: { id: "backend", name: "Backend", scope: ["backend-kotlin"], profile: "lightweight", lead: "team-lead", roster: ["backend-kotlin"] },
    frontend: { id: "frontend", name: "Frontend", scope: ["frontend"], profile: "lightweight", lead: "team-lead", roster: ["frontend"] },
  };
}

test("cto-owner: same-session task runs amend, foreign sessions get a fresh contract", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-"));
  try {
    const res = runCto({
      task: "Feature owned",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [{ team: "backend", slice: "s1" }],
      defs: sampleDefs(),
      owner_session: "sess-A",
    });
    assert.ok(res);

    const owner = findActiveCtoRun(root, { sessionId: "sess-A" });
    assert.equal(owner?.runId, res.plan.id, "owner session sees the run as active");

    const foreign = findActiveCtoRun(root, { sessionId: "sess-B" });
    assert.equal(foreign, null, "foreign session must NOT amend another session's task run");

    const sessionless = findActiveCtoRun(root);
    assert.equal(sessionless?.runId, res.plan.id, "session-less presence lookup still sees the run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-owner: standby runs remain adoptable across sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-standby-"));
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

    for (const sessionId of ["sess-A", "sess-B", undefined]) {
      const active = findActiveCtoRun(root, sessionId ? { sessionId } : {});
      assert.equal(active?.runId, "standby-1", `standby adoptable for session ${String(sessionId)}`);
      assert.equal(active?.state.standby, true, "standby marker preserved");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-owner: all teams done plus integration done is terminal without pause done", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-terminal-"));
  try {
    const res = runCto({
      task: "Wave complete",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [{ team: "backend", slice: "s1" }, { team: "frontend", slice: "s2" }],
      defs: sampleDefs(),
    });
    assert.ok(res);
    assert.equal(isCtoRunTerminal(res.state), false, "fresh run is not terminal");

    // One team still in_progress + integration done -> NOT terminal yet.
    setTeamStatus(res.state, "backend", "done", root);
    setIntegration(res.state, "done", "wave 1", root);
    assert.equal(isCtoRunTerminal(res.state), false, "a team still running keeps the run active");
    assert.equal(findActiveCtoRun(root)?.runId, res.plan.id, "integration done alone must not finish a run with active teams");

    // All teams done + integration done -> terminal even with pause.kind none.
    setTeamStatus(res.state, "frontend", "done", root);
    assert.equal(isCtoRunTerminal(res.state), true, "all teams done + integration done is terminal");
    assert.equal(findActiveCtoRun(root), null, "terminal run is not selectable as active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-owner: markdown state preserves autonomy and session metadata (RC3/RC4)", () => {
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

    // Same session: run active with the parsed autonomy + ownership restored.
    const owner = findActiveCtoRun(root, { sessionId: "sess-A" });
    assert.ok(owner, "same-session sees the markdown run as active");
    assert.equal(owner?.state.autonomous, true, "markdown autonomy flag must not be hardcoded false");
    assert.equal(owner?.state.owner_session, "sess-A", "markdown session owner restored");

    // Foreign session: fresh contract (no amend).
    assert.equal(findActiveCtoRun(root, { sessionId: "sess-B" }), null, "foreign session must not amend an owned markdown run");

    // No session (presence detection): still visible.
    assert.equal(findActiveCtoRun(root)?.runId, runId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-owner: markdown state without metadata stays non-autonomous and amendable", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-mdlegacy-"));
  try {
    const runId = "legacy-md-run";
    const runDir = join(root, ".work-state", "cto", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "cto_discovery.md"), "# Legacy run\n");
    writeFileSync(join(runDir, "team-plan.md"), "# Team Plan\n- team: backend\n");

    const active = findActiveCtoRun(root, { sessionId: "sess-X" });
    assert.ok(active, "legacy unowned markdown run stays amendable");
    assert.equal(active?.state.autonomous, false, "absent metadata defaults to non-autonomous");
    assert.equal(active?.state.owner_session, undefined, "absent metadata leaves the run unowned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
