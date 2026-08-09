/**
 * CTO resident control-plane tests (cto-core): wave lifecycle (schema-2
 * additive wave_history / active_wave_id), idempotent transport source_id
 * admission, and the isCtoRunTerminal resident carve-out (standby runs stay
 * active after wave completion; explicit stop/failure stays terminal).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  migrateCtoState,
  newCtoState,
  writeCtoState,
  readCtoState,
  appendWave,
  finishWave,
  activeWave,
  findWaveBySourceId,
  isCtoResident,
  isCtoRunTerminal,
  setTeamStatus,
  setIntegration,
  setCtoPause,
  type TeamPlan,
} from "@andvl1/omp-workflows-core";

function samplePlan(id = "run-1"): TeamPlan {
  return {
    id,
    task: "resident wave test",
    teams: [
      { team: "backend", scope: ["backend-kotlin"], slice: "s1", profile: "lightweight", worktree: "same_branch", depends_on: [] },
      { team: "frontend", scope: ["frontend"], slice: "s2", profile: "lightweight", worktree: "same_branch", depends_on: [] },
    ],
    created_at: new Date().toISOString(),
  };
}

function makeStandby(id = "run-sb"): ReturnType<typeof newCtoState> {
  return newCtoState({
    id,
    task: "standby — awaiting inbox tasks",
    branch: "",
    autonomous: true,
    standby: true,
    plan: { id, task: "standby — awaiting inbox tasks", teams: [], created_at: new Date().toISOString() },
  });
}

test("cto-resident: isCtoResident mirrors the standby marker", () => {
  assert.equal(isCtoResident({ standby: true }), true);
  assert.equal(isCtoResident({ standby: false }), false);
  assert.equal(isCtoResident({}), false);
});

test("cto-resident: newCtoState carries wave_history: [] and no active_wave_id/channel_profile", () => {
  const state = makeStandby();
  assert.equal(state.schema, 2);
  assert.deepEqual(state.wave_history, []);
  assert.equal(state.active_wave_id, undefined, "constructor never sets active_wave_id");
  assert.equal(state.channel_profile, undefined, "constructor never sets channel_profile");
});

test("cto-resident: migrateCtoState default-fills wave_history additively (schema stays 2, fields preserved)", () => {
  const schema1 = {
    schema: 1,
    id: "legacy",
    task: "t",
    branch: "b",
    autonomous: false,
    plan: { id: "legacy", task: "t", teams: [], created_at: "2026-01-01T00:00:00Z" },
    teams: [{ id: "a", status: "pending", escalations: {} }],
    integration: { status: "pending" },
    pause: { kind: "none", reason: "" },
    updated_at: "2026-01-01T00:00:00Z",
  };
  const migrated = migrateCtoState(schema1);
  assert.equal(migrated.schema, 2, "schema-1 input becomes schema 2");
  assert.deepEqual(migrated.wave_history, [], "wave_history default-filled");
  assert.equal(migrated.id, "legacy", "existing fields preserved");
  assert.equal(migrated.teams[0]?.id, "a", "teams preserved");
  assert.equal(migrated.pause.kind, "none", "pause preserved");

  // partial schema-2: wave_history absent but other schema-2 fields present
  const partial = {
    ...schema1,
    schema: 2,
    budget: {
      policy: { token_limit: 1, dollar_limit: null, time_limit_ms: null },
      accounting: { tokens_estimated: 0, dollars_estimated: 0, elapsed_ms: 0, per_team: {} },
    },
  };
  const migrated2 = migrateCtoState(partial);
  assert.equal(migrated2.schema, 2, "schema stays 2");
  assert.deepEqual(migrated2.wave_history, [], "partial schema-2 gets wave_history");
  assert.equal(migrated2.budget?.policy.token_limit, 1, "present fields preserved");

  // existing wave_history is never clobbered
  const withHistory = {
    ...schema1,
    schema: 2,
    wave_history: [{ id: "w1", source: "inbox", source_id: "m1", task: "t", slice_ids: [], status: "active", started_at: "2026-01-01T00:00:00Z" }],
  };
  const migrated3 = migrateCtoState(withHistory);
  assert.equal(migrated3.wave_history?.length, 1, "existing wave_history untouched");
  assert.equal(migrated3.wave_history?.[0]?.source_id, "m1");
});

test("cto-resident: appendWave appends, sets active_wave_id and persists when root given", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-resident-"));
  try {
    const state = makeStandby("run-w1");
    writeCtoState(state, root);
    const now = "2026-08-09T00:00:00.000Z";
    const next = appendWave(state, { id: "wave-1", source: "telegram", source_id: "msg-42", task: "Do the thing", slice_ids: ["s1", "s2"], now }, root);
    assert.equal(next.active_wave_id, "wave-1");
    assert.equal(next.wave_history?.length, 1);
    const record = next.wave_history?.[0];
    assert.equal(record?.id, "wave-1");
    assert.equal(record?.source, "telegram");
    assert.equal(record?.source_id, "msg-42");
    assert.equal(record?.status, "active");
    assert.equal(record?.started_at, now);
    assert.equal(record?.finished_at, undefined);
    assert.equal(record?.slice_ids.length, 2);

    const persisted = readCtoState("run-w1", root);
    assert.equal(persisted?.active_wave_id, "wave-1", "active_wave_id persisted");
    assert.equal(persisted?.wave_history?.length, 1, "wave_history persisted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-resident: appendWave with duplicate source_id is a no-op (idempotent admission)", () => {
  const state = makeStandby();
  appendWave(state, { id: "wave-1", source: "telegram", source_id: "msg-42", task: "first" });
  const next = appendWave(state, { id: "wave-2", source: "telegram", source_id: "msg-42", task: "duplicate" });
  assert.equal(next, state, "returns the same state object unchanged");
  assert.equal(next.active_wave_id, "wave-1", "active_wave_id untouched by duplicate");
  assert.equal(next.wave_history?.length, 1, "no second record");
  assert.equal(next.wave_history?.[0]?.task, "first");
});

test("cto-resident: finishWave stamps finished_at and clears active_wave_id", () => {
  const state = makeStandby();
  appendWave(state, { id: "wave-1", source: "inbox", source_id: "m1", task: "t", now: "2026-08-09T00:00:00.000Z" });
  const done = finishWave(state, { id: "wave-1", status: "done", now: "2026-08-09T01:00:00.000Z" });
  assert.equal(done.active_wave_id, undefined, "active_wave_id cleared");
  assert.equal(done.wave_history?.[0]?.status, "done");
  assert.equal(done.wave_history?.[0]?.finished_at, "2026-08-09T01:00:00.000Z");
  assert.equal(activeWave(done), null, "no active wave after finish");
});

test("cto-resident: finishWave with unknown id is a no-op", () => {
  const state = makeStandby();
  appendWave(state, { id: "wave-1", source: "inbox", source_id: "m1", task: "t" });
  const next = finishWave(state, { id: "ghost", status: "failed" });
  assert.equal(next, state);
  assert.equal(next.active_wave_id, "wave-1");
  assert.equal(next.wave_history?.[0]?.status, "active");
  assert.equal(next.wave_history?.[0]?.finished_at, undefined);
});

test("cto-resident: activeWave and findWaveBySourceId resolve correctly", () => {
  const state = makeStandby();
  assert.equal(activeWave(state), null, "no active_wave_id → null");
  appendWave(state, { id: "wave-1", source: "inbox", source_id: "m1", task: "t" });
  const active = activeWave(state);
  assert.equal(active?.id, "wave-1");
  assert.equal(active?.status, "active");
  finishWave(state, { id: "wave-1", status: "done" });
  assert.equal(activeWave(state), null, "finished wave is not active");
  const found = findWaveBySourceId(state, "m1");
  assert.equal(found?.id, "wave-1");
  assert.equal(findWaveBySourceId(state, "nope"), null);
});

test("cto-resident: standby run stays ACTIVE after wave completion; pause done/failed IS terminal even for standby", () => {
  const plan = samplePlan("run-sb");
  const taskRun = newCtoState({ id: "run-sb", task: "task", branch: "main", autonomous: true, standby: true, plan });
  setTeamStatus(taskRun, "backend", "done");
  setTeamStatus(taskRun, "frontend", "done");
  setIntegration(taskRun, "done", "wave complete");
  assert.equal(isCtoResident(taskRun), true);
  assert.equal(isCtoRunTerminal(taskRun), false, "standby run survives wave completion (resident carve-out)");

  const stopped = newCtoState({ id: "run-sb2", task: "task", branch: "main", autonomous: true, standby: true, plan });
  setCtoPause(stopped, "done", "explicit stop");
  assert.equal(isCtoRunTerminal(stopped), true, "pause done is terminal even for standby");

  const failed = newCtoState({ id: "run-sb3", task: "task", branch: "main", autonomous: true, standby: true, plan });
  setCtoPause(failed, "failed", "explicit failure");
  assert.equal(isCtoRunTerminal(failed), true, "pause failed is terminal even for standby");
});

test("cto-resident: non-standby runs keep legacy terminality (regression)", () => {
  const plan = samplePlan("run-legacy");
  const run = newCtoState({ id: "run-legacy", task: "task", branch: "main", autonomous: false, plan });
  assert.equal(isCtoResident(run), false);
  assert.equal(isCtoRunTerminal(run), false, "fresh run is not terminal");
  setTeamStatus(run, "backend", "done");
  setTeamStatus(run, "frontend", "done");
  assert.equal(isCtoRunTerminal(run), false, "teams done alone is not terminal");
  setIntegration(run, "done", "wave");
  assert.equal(isCtoRunTerminal(run), true, "all teams done + integration done IS terminal for non-standby");
});
