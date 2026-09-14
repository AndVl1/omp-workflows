/**
 * CTO resident control-plane tests (cto-core): wave lifecycle (schema-2
 * additive wave_history / active_wave_id), idempotent transport source_id
 * admission, and the isCtoRunTerminal resident carve-out (standby runs stay
 * active after wave completion; explicit stop/failure stays terminal).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type TeamPlan } from "@andvl1/omp-workflows-core";
import { PinnedRootError } from "../src/specification/pinned-root.js";
import { activeWave, findWaveBySourceId, isCtoResident, isCtoRunTerminal, migrateCtoState, newCtoState, parsePersistedCtoState, readCtoState, setCtoPause, setIntegration, setTeamStatus, writeCtoState } from "../src/cto/state.js";
import { applyAppendWaveTransition, applyFinishWaveTransition } from "../src/cto/state.js";
import { appendWave as pureAppendWave, appendWaveUnderLock, finishWaveUnderLock } from "../src/cto/waves.js";
import { withCtoRunLock } from "../src/cto/transaction-lock.js";
import type { CtoState, AppendWaveOptions, FinishWaveOptions } from "../src/cto/types.js";
import type { CompletionEnvelope, WorkIdentity } from "../src/engine/types.js";

function replaceState(target: CtoState, next: CtoState): CtoState {
  if (target === next) return target;
  for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key];
  Object.assign(target, next);
  return target;
}
function appendWave(state: CtoState, opts: AppendWaveOptions): CtoState {
  return replaceState(state, applyAppendWaveTransition(state, opts));
}
function finishWave(state: CtoState, opts: FinishWaveOptions): CtoState {
  return replaceState(state, applyFinishWaveTransition(state, opts));
}

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

test("cto-resident: appendWave applies a pure transition", () => {
  const state = makeStandby("run-w1");
  const now = "2026-08-09T00:00:00.000Z";
  const next = pureAppendWave(state, { id: "wave-1", source: "telegram", source_id: "msg-42", task: "Do the thing", slice_ids: ["s1", "s2"], now });
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
  assert.equal(state.active_wave_id, undefined, "pure transition does not mutate the input");
});

test("cto-resident: appendWave with duplicate source_id is exact-replay idempotent", () => {
  const state = makeStandby();
  const original = { id: "wave-1", source: "telegram", source_id: "msg-42", task: "first", now: "2026-08-09T00:00:00.000Z" };
  appendWave(state, original);
  const replay = appendWave(state, original);
  assert.equal(replay, state, "exact source replay returns the same state object unchanged");
  const beforeChangedReplay = JSON.stringify(state);
  assert.throws(
    () => appendWave(state, { id: "wave-2", source: "telegram", source_id: "msg-42", task: "duplicate" }),
    /replay does not match/,
  );
  assert.equal(JSON.stringify(state), beforeChangedReplay, "changed duplicate replay must not mutate state");
  assert.equal(state.active_wave_id, "wave-1", "active_wave_id untouched by duplicate");
  assert.equal(state.wave_history?.length, 1, "no second record");
  assert.equal(state.wave_history?.[0]?.task, "first");
  assert.equal(state.wave_history?.[0]?.started_at, original.now);
});

test("cto-resident: appendWave rejects malformed duplicate ids before source replay", () => {
  const state = makeStandby();
  appendWave(state, { id: "wave-1", source: "telegram", source_id: "msg-42", task: "first" });
  const original = state.wave_history?.[0];
  assert.ok(original);
  state.wave_history?.push({ ...original, source_id: "msg-corrupt" });

  assert.throws(
    () => appendWave(state, { id: "wave-1", source: "telegram", source_id: "msg-42", task: "replay" }),
    /invalid wave authority/,
  );
  assert.equal(state.wave_history?.length, 2, "fail-closed replay does not further mutate malformed history");
});

test("cto-resident: appendWave rejects a different source_id reusing a wave id before mutation", () => {
  const state = makeStandby();
  appendWave(state, { id: "wave-1", source: "telegram", source_id: "msg-42", task: "first" });
  assert.throws(
    () => appendWave(state, { id: "wave-1", source: "inbox", source_id: "msg-43", task: "collision" }),
    /already used by a different source_id/,
  );
  assert.equal(state.wave_history?.length, 1, "collision does not append history");
  assert.equal(state.active_wave_id, "wave-1", "collision does not alter active identity");
  assert.equal(state.wave_history?.[0]?.source_id, "msg-42");
});

test("cto-resident: appendWave rejects traversal, control, blank, and unsafe slice identities", () => {
  const invalidCalls: Array<Parameters<typeof appendWave>[1]> = [
    { id: "", source: "inbox", source_id: "m1", task: "task" },
    { id: "../wave", source: "inbox", source_id: "m2", task: "task" },
    { id: "wave\u0000", source: "inbox", source_id: "m3", task: "task" },
    { id: "wave", source: "", source_id: "m4", task: "task" },
    { id: "wave", source: "inbox", source_id: "../m5", task: "task" },
    { id: "wave", source: "inbox", source_id: "m6", task: "   " },
    { id: "wave", source: "inbox", source_id: "m7", task: "task", slice_ids: ["slice/escape"] },
    { id: "wave", source: "inbox", source_id: "m8", task: "task", slice_ids: ["slice\u0000"] },
  ];
  for (const opts of invalidCalls) {
    const state = makeStandby();
    assert.throws(() => appendWave(state, opts), /invalid wave/);
    assert.equal(state.wave_history?.length, 0, `invalid ${JSON.stringify(opts)} does not mutate history`);
    assert.equal(state.active_wave_id, undefined, `invalid ${JSON.stringify(opts)} does not set active identity`);
  }
});

function specificationWaveFixture(id = "run-spec-wave"): { state: CtoState; identity: WorkIdentity } {
  const state = makeStandby(id);
  const identity: WorkIdentity = {
    run_id: id, wave_id: "wave-spec", slice_id: "slice-spec", session_id: "session-spec",
    workflow: "standard", stage_id: "execution", stage_cursor: "execution",
    capability_id: "cap-spec", capability_epoch: "epoch-spec", slot_id: "slice-spec",
    task_id: "task-spec", dispatch_id: "dispatch-spec", attempt: 1, worker_id: "worker-spec",
  };
  state.specification_preparation_transaction = { status: "committed", request_digest: "a".repeat(64), expected_state_revision: 0 } as CtoState["specification_preparation_transaction"];
  state.specification_execution_anchor = { feature_id: "feature-spec", run_key: "feature-run" };
  state.specification_execution_requested_selections = [{ feature_id: "feature-spec", run_key: "feature-run" }];
  state.teams = [{
    id: "team-spec", status: "pending", escalations: {}, feature_id: "feature-spec", run_key: "feature-run",
    slice_id: "slice-spec", work_identity: identity,
  }];
  return { state, identity };
}

function terminalEnvelope(identity: WorkIdentity): CompletionEnvelope {
  return {
    schema_version: 1, identity, outcome: "succeeded", terminal_signal: "workflow_complete",
    artifact_refs: [], evidence_ref: null, conflict_ref: null, completed_by: "workflow_complete",
    emitted_at: "2026-08-09T01:00:00.000Z",
  };
}

test("cto-resident: specification wave requires exact unique admitted slice set", () => {
  const { state, identity } = specificationWaveFixture("run-spec-slice-set");
  const duplicateTeam = {
    ...state.teams[0]!,
    id: "team-spec-two",
    work_identity: { ...identity, slot_id: "slice-spec-two", task_id: "task-spec-two", dispatch_id: "dispatch-spec-two" },
  };
  state.teams = [state.teams[0]!, duplicateTeam];
  assert.throws(() => pureAppendWave(state, {
    id: "wave-spec", source: "specification-execution", source_id: "source-spec", task: "spec task",
    slice_ids: ["slice-spec", "slice-extra"], work_identity: identity,
  }), /exactly cover the admitted teams/);

  const valid = specificationWaveFixture("run-spec-extra-slice");
  const before = JSON.stringify(valid.state);
  assert.throws(() => pureAppendWave(valid.state, {
    id: "wave-spec", source: "specification-execution", source_id: "source-spec", task: "spec task",
    slice_ids: ["slice-spec", "slice-extra"], work_identity: valid.identity,
  }), /exactly cover the admitted teams/);
  assert.equal(JSON.stringify(valid.state), before);

  const admitted = specificationWaveFixture("run-spec-parser-set");
  appendWave(admitted.state, {
    id: "wave-spec", source: "specification-execution", source_id: "source-spec", task: "spec task",
    slice_ids: ["slice-spec"], work_identity: admitted.identity,
  });
  const malformed = structuredClone(admitted.state) as CtoState;
  malformed.wave_history[0] = { ...malformed.wave_history[0]!, slice_ids: ["slice-spec", "slice-extra"] };
  assert.equal(parsePersistedCtoState(malformed as unknown as Record<string, unknown>), null, "persisted specification wave rejects a slice outside the admitted team set");
});

test("cto-resident: specification wave rejects forged identity and preserves state", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-spec-wave-forged-"));
  try {
    const { state, identity } = specificationWaveFixture();
    const forged = { ...identity, capability_id: "caller-shaped-capability" };
    const before = JSON.stringify(state);
    assert.throws(() => withCtoRunLock(root, state.id, (handle) => appendWaveUnderLock(state, {
    id: "wave-spec", source: "specification-execution", source_id: "source-spec", task: "spec task",
    slice_ids: ["slice-spec"], work_identity: forged,
  }, handle), { timeoutMs: 1_000 }), /exact admitted slice identity|stale or foreign|canonical|committed preparation/);
    assert.equal(JSON.stringify(state), before, "forged specification identity does not mutate state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-resident: specification wave requires exact committed admission and terminal evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-spec-wave-transition-"));
  try {
    const { state, identity } = specificationWaveFixture("run-spec-transition");
    withCtoRunLock(root, state.id, (handle) => appendWaveUnderLock(state, {
    id: "wave-spec", source: "specification-execution", source_id: "source-spec", task: "spec task",
    slice_ids: ["slice-spec"], work_identity: identity,
  }, handle), { timeoutMs: 1_000 });
  const beforeEarlyFinish = JSON.stringify(state);
    assert.throws(() => withCtoRunLock(root, state.id, (handle) => finishWaveUnderLock(state, { id: "wave-spec", status: "done" }, handle), { timeoutMs: 1_000 }), /generic wave finish rejects specification-execution/);
    assert.equal(JSON.stringify(state), beforeEarlyFinish, "generic early finish leaves state unchanged");
    state.teams[0]!.status = "done";
    state.teams[0]!.completion_envelope = terminalEnvelope(identity);
    const beforeAuthorizedGenericFinish = JSON.stringify(state);
    assert.throws(() => withCtoRunLock(root, state.id, (handle) => finishWaveUnderLock(state, { id: "wave-spec", status: "done", now: "2026-08-09T02:00:00.000Z" }, handle), { timeoutMs: 1_000 }), /generic wave finish rejects specification-execution/);
    assert.equal(JSON.stringify(state), beforeAuthorizedGenericFinish, "generic finish cannot terminalize a specification wave even with terminal evidence");
    assert.throws(() => applyFinishWaveTransition(state, { id: "wave-spec", status: "done" }), /raw wave transition rejects specification-execution/);
    assert.equal(JSON.stringify(state), beforeAuthorizedGenericFinish, "raw state transition cannot terminalize a specification wave");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("cto-resident: finishWave is idempotent for the same finalized status and rejects a conflicting status", () => {
  const state = makeStandby();
  appendWave(state, { id: "wave-1", source: "inbox", source_id: "m1", task: "t" });
  finishWave(state, { id: "wave-1", status: "failed", now: "2026-08-09T01:00:00.000Z" });
  const repeated = finishWave(state, { id: "wave-1", status: "failed", now: "2026-08-09T02:00:00.000Z" });
  assert.equal(repeated, state, "same terminal status is an idempotent no-op");
  assert.equal(state.wave_history?.[0]?.finished_at, "2026-08-09T01:00:00.000Z", "replay cannot rewrite completion time");
  assert.throws(() => finishWave(state, { id: "wave-1", status: "done" }), /invalid wave status transition/);
  assert.throws(() => finishWave(state, { id: "../wave", status: "done" }), /invalid wave id/);
  assert.equal(state.wave_history?.[0]?.status, "failed", "invalid transitions do not mutate finalized state");
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

test("cto-resident: CTO state persists exact bytes with mode 0600", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-security-"));
  try {
    const state = makeStandby("secure-mode");
    const path = writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() });
    const expected = JSON.stringify(state, null, 2) + "\n";
    assert.deepEqual(readFileSync(path), Buffer.from(expected, "utf8"));
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(root, ".work-state", "cto", "secure-mode")).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-resident: CTO state rejects symlink redirection and preserves prior authority", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-symlink-"));
  try {
    const state = makeStandby("secure-link");
    const dir = join(root, ".work-state", "cto", state.id);
    mkdirSync(dir, { recursive: true });
    const outside = join(root, "outside.json");
    writeFileSync(outside, "prior-cto-authority", { mode: 0o600 });
    symlinkSync(outside, join(dir, "state.json"));

    assert.throws(
      () => writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() }),
      (error: unknown) => error instanceof PinnedRootError && error.code === "path_unauthorized",
    );
    assert.equal(readFileSync(outside, "utf8"), "prior-cto-authority");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-resident: CTO state rejects a symlinked run directory without writing outside", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-state-ancestor-"));
  try {
    const state = makeStandby("secure-ancestor");
    const ctoRoot = join(root, ".work-state", "cto");
    const outside = join(root, "outside");
    mkdirSync(ctoRoot, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(ctoRoot, state.id));

    // The transaction wrapper preserves the stable pinned-root error category;
    // its platform-specific errno text is deliberately not part of this contract.
    assert.throws(
      () => writeCtoState(state, root, { preCommit: ({ pinnedRoot }) => pinnedRoot.assertStable() }),
      (error: unknown) => error instanceof Error && error.message.startsWith("CTO transaction lock unavailable: PinnedRootError:"),
    );
    assert.equal(readdirSync(outside).includes("state.json"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
