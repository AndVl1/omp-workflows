/**
 * RC4/RC5 regression tests: active-run selection is ownership-safe and
 * terminality covers all-teams-done plus integration-done.
 * Canonical state.json ownership remains session-safe, while standby runs
 * remain adoptable across sessions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCto } from "../src/cto/run.js";
import type { TeamDef } from "../src/cto/types.js";
import { findActiveCtoRun } from "../src/commands/cto.js";
import { isCtoRunTerminal, newCtoState, readCtoState, setIntegration, setTeamStatus, writeCtoRuntimeStateProof, writeCtoState } from "../src/cto/state.js";
import { PinnedProjectRoot } from "../src/specification/pinned-root.js";
import { openTestCtoRuntime } from "./fixtures/registry-activation.js";
function seedOwnedState(root: string, state: ReturnType<typeof newCtoState>, runtimeAccess: Parameters<typeof runCto>[0]["runtimeAccess"]): void {
  state.owner_session = "main-session";
  state.work_identity ??= {
    run_id: state.id,
    wave_id: "cto-run",
    slice_id: "cto-run",
    session_id: "main-session",
    workflow: "standard",
    stage_id: "cto",
    stage_cursor: "cto",
    capability_id: "cto-test",
    capability_epoch: "test",
    slot_id: state.id,
    task_id: state.id,
    dispatch_id: state.id,
    attempt: 1,
    worker_id: "cto-test",
  };
  const pinnedRoot = PinnedProjectRoot.open(root);
  assert.ok(pinnedRoot, "ownership fixture root must be pinnable");
  if (!pinnedRoot) throw new Error("ownership fixture root cannot be pinned");
  try {
    writeCtoState(state, root, { pinnedRoot, preCommit: ({ pinnedRoot: stableRoot }) => stableRoot.assertStable() });
    assert.equal(writeCtoRuntimeStateProof(pinnedRoot, state), true, "ownership fixture state proof must be refreshed");
  } finally {
    pinnedRoot.close();
  }
  runtimeAccess.findActiveRun();
}

function persistState(state: ReturnType<typeof newCtoState>, runtimeAccess: Parameters<typeof runCto>[0]["runtimeAccess"]): void {
  runtimeAccess.withRunTransaction(state.id, (transaction) => {
    const next = transaction.readState();
    next.teams = structuredClone(state.teams);
    next.integration = structuredClone(state.integration);
    next.pause = structuredClone(state.pause);
    transaction.writeState(next);
  });
}

function sampleDefs(): Record<string, TeamDef> {
  return {
    backend: { id: "backend", name: "Backend", scope: ["backend-kotlin"], profile: "lightweight", lead: "team-lead", roster: ["backend-kotlin"] },
    frontend: { id: "frontend", name: "Frontend", scope: ["frontend"], profile: "lightweight", lead: "team-lead", roster: ["frontend"] },
  };
}

test("cto-owner: same-session task runs amend, foreign sessions get a fresh contract", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-"));
  const runtime = openTestCtoRuntime(root, "sess-A", "cto-owner-test");
  try {
    const res = runCto({
      task: "Feature owned",
      cwd: root,
      branch: "main",
      autonomous: false,
      teams: [{ team: "backend", slice: "s1" }],
      defs: sampleDefs(),
      sessionId: "sess-A",
      runtimeAccess: runtime.access,
    });
    assert.ok(res);

    const owner = findActiveCtoRun(root, { sessionId: "sess-A" });
    assert.equal(owner?.runId, res.plan.id, "owner session sees the run as active");

    const foreign = findActiveCtoRun(root, { sessionId: "sess-B" });
    assert.equal(foreign, null, "foreign session must NOT amend another session's task run");

    const sessionless = findActiveCtoRun(root);
    assert.equal(sessionless?.runId, res.plan.id, "session-less presence lookup still sees the run");
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto-owner: standby runs remain adoptable across sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-standby-"));
  const runtime = openTestCtoRuntime(root, "sess-A", "cto-owner-standby-test");
  try {
    const runId = runtime.access.ensureStandbyRun();
    for (const sessionId of ["sess-A", "sess-B", undefined]) {
      const active = findActiveCtoRun(root, sessionId ? { sessionId } : {});
      assert.equal(active?.runId, runId, `standby adoptable for session ${String(sessionId)}`);
      assert.equal(active?.state.standby, true, "standby marker preserved");
    }
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-owner: all teams done plus integration done is terminal without pause done", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-terminal-"));
  const runtime = openTestCtoRuntime(root);
  try {
    const res = runCto({
      task: "Wave complete",
      cwd: root,
      branch: "main",
      autonomous: false,
      sessionId: "main-session",
      teams: [{ team: "backend", slice: "s1" }, { team: "frontend", slice: "s2" }],
      defs: sampleDefs(),
      runtimeAccess: runtime.access,
    });
    assert.ok(res);
    seedOwnedState(root, res.state, runtime.access);
    assert.equal(isCtoRunTerminal(res.state), false, "fresh run is not terminal");

    // One team still in_progress + integration done -> NOT terminal yet.
    setTeamStatus(res.state, "backend", "done");
    setIntegration(res.state, "done", "wave 1");
    persistState(res.state, runtime.access);
    assert.equal(isCtoRunTerminal(res.state), false, "a team still running keeps the run active");
    assert.equal(findActiveCtoRun(root)?.runId, res.plan.id, "integration done alone must not finish a run with active teams");

    // All teams done + integration done -> terminal even with pause.kind none.
    setTeamStatus(res.state, "frontend", "done");
    persistState(res.state, runtime.access);
    assert.equal(isCtoRunTerminal(res.state), true, "all teams done + integration done is terminal");
    assert.equal(findActiveCtoRun(root), null, "terminal run is not selectable as active");
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-owner: state without pause is non-terminal and never crashes detection (legacy state)", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-owner-nopause-"));
  const runtime = openTestCtoRuntime(root);
  try {
    const res = runCto({
      task: "Legacy run",
      cwd: root,
      branch: "main",
      autonomous: false,
      sessionId: "main-session",
      teams: [{ team: "backend", slice: "s1" }],
      defs: sampleDefs(),
      runtimeAccess: runtime.access,
    });
    assert.ok(res);

    // Simulate a legacy state.json written before the pause field existed.
    const statePath = join(root, ".work-state", "cto", res.plan.id, "state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    delete raw.pause;
    writeFileSync(statePath, JSON.stringify(raw, null, 2));

    const beforeRead = readFileSync(statePath);
    const state = readCtoState(res.plan.id, root);
    assert.ok(state);
    assert.deepEqual(state?.pause, { kind: "none", reason: "" }, "legacy revision-1 state is normalized in memory");
    assert.deepEqual(readFileSync(statePath), beforeRead, "legacy read must not rewrite authoritative bytes");

    assert.equal(isCtoRunTerminal(state!), false, "missing pause alone is NOT terminal");
    assert.throws(
      () => findActiveCtoRun(root),
      /CTO_RUNTIME_ORIGIN_RECOVERY_REQUIRED/u,
      "proofless legacy state remains unavailable until explicit authenticated recovery",
    );

  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

