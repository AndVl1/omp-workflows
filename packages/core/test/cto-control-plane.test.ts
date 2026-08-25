import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendWave,
  migrateCtoState,
  newCtoState,
  setCtoControlPlane,
  setTeamControlPlane,
} from "../src/cto/state.js";
import { writeState } from "../src/engine/state.js";
import type { CtoState, TeamPlan } from "../src/cto/types.js";
import type { CompletionIntent, WorkIdentity, TeamState } from "../src/engine/types.js";

const identity: WorkIdentity = {
  run_id: "run-control-plane",
  wave_id: "wave-1",
  slice_id: "slice-1",
  session_id: "session-1",
  workflow: "standard",
  stage_id: "implementation",
  stage_cursor: "implementation",
  capability_id: "capability-1",
  capability_epoch: "epoch-1",
  slot_id: "analyst#1",
  task_id: "task-1",
  dispatch_id: "dispatch-1",
  attempt: 1,
  worker_id: "worker-1",
};

const completionIntent: CompletionIntent = {
  mode: "complete_outcome",
  acceptance: "dod_and_artifacts",
  source: "workflow_policy",
  rationale: "The workflow records a completed outcome independently from consent.",
};

const plan: TeamPlan = {
  id: "run-control-plane",
  task: "control-plane fixture",
  teams: [
    {
      team: "backend",
      scope: ["backend"],
      slice: "backend slice",
      profile: "standard",
      worktree: "same_branch",
      depends_on: [],
    },
    {
      team: "frontend",
      scope: ["frontend"],
      slice: "frontend slice",
      profile: "standard",
      worktree: "same_branch",
      depends_on: [],
    },
  ],
  created_at: "2026-08-25T00:00:00.000Z",
};

function freshState(): CtoState {
  return newCtoState({
    id: "run-control-plane",
    task: "control-plane fixture",
    branch: "main",
    autonomous: false,
    plan,
  });
}

test("cto control-plane: malformed typed fields quarantine with provenance and preserve the value", () => {
  const malformedCompletionIntent = { mode: "not-a-completion-mode", acceptance: "dod_and_artifacts" };
  const migrated = migrateCtoState({
    ...freshState(),
    completion_intent: malformedCompletionIntent,
  });

  assert.equal(migrated.control_plane_provenance?.status, "invalid");
  assert.ok((migrated.control_plane_provenance?.warnings.length ?? 0) > 0);
  assert.deepEqual(migrated.completion_intent, malformedCompletionIntent);
  assert.equal(migrated.autonomous, false, "legacy autonomy remains unrelated to typed validation");
});

test("cto control-plane: setters validate before merge and preserve state on invalid updates", () => {
  const state = freshState();
  const before = JSON.stringify(state);
  assert.throws(
    () => setCtoControlPlane(state, { completion_intent: { mode: "invalid" } as unknown as CompletionIntent }),
    /invalid typed control-plane update/,
  );
  assert.equal(JSON.stringify(state), before, "invalid top-level patch must not partially mutate state");

  const teamBefore = JSON.stringify(state.teams);
  assert.throws(
    () => setTeamControlPlane(state, "backend", { work_identity: { ...identity, attempt: 0 } }),
    /invalid typed control-plane update/,
  );
  assert.equal(JSON.stringify(state.teams), teamBefore, "invalid team patch must not partially mutate any team");
});

test("cto control-plane: valid setters merge and undefined metadata patches do not erase existing values", () => {
  const state = freshState();
  state.control_plane_status = { stage: "pending", lifecycle: "pending", pause: "none", reason: "awaiting dispatch" };
  setCtoControlPlane(state, { completion_intent: completionIntent });
  assert.deepEqual(state.completion_intent, completionIntent);

  const existingStatus = state.control_plane_status;
  setCtoControlPlane(state, { control_plane_status: undefined });
  assert.deepEqual(state.control_plane_status, existingStatus, "undefined patch entries are ignored, not destructive");

  setTeamControlPlane(state, "backend", { work_identity: identity });
  assert.deepEqual(state.teams.find((team) => team.id === "backend")?.work_identity, identity);
  assert.equal(state.teams.find((team) => team.id === "frontend")?.work_identity, undefined);
});

test("cto control-plane: appendWave validates and stamps work identity, then deduplicates source_id", () => {
  const state = freshState();
  appendWave(state, {
    id: "wave-1",
    source: "test",
    source_id: "message-1",
    task: "wave task",
    work_identity: identity,
    now: "2026-08-25T00:00:01.000Z",
  });
  assert.deepEqual(state.wave_history?.[0]?.work_identity, identity);
  const historyAfterFirst = JSON.stringify(state.wave_history);

  appendWave(state, {
    id: "wave-duplicate",
    source: "test",
    source_id: "message-1",
    task: "duplicate task",
    work_identity: { ...identity, wave_id: "wave-duplicate" },
    now: "2026-08-25T00:00:02.000Z",
  });
  assert.equal(JSON.stringify(state.wave_history), historyAfterFirst, "duplicate transport source must be idempotent");

  assert.throws(
    () => appendWave(state, {
      id: "wave-invalid",
      source: "test",
      source_id: "message-2",
      task: "invalid identity",
      work_identity: { ...identity, attempt: 0 },
    }),
    /invalid typed control-plane update/,
  );
});

function engineStateFixture(): TeamState {
  return {
    schema: 1,
    branch: "main",
    classification: {
      type: "FEATURE",
      complexity: "MEDIUM",
      confidence: "HIGH",
      workflow: "standard",
      autonomous: false,
    },
    task: "write-state typed rejection fixture",
    workflow_override: false,
    issue: null,
    stage_cursor: "",
    stages: [],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: "2026-08-25T00:00:00.000Z",
    run_key: "main",
  };
}

test("engine writeState: malformed and conflicting typed control-plane state throws concrete rejection reasons", () => {
  const malformedRoot = mkdtempSync(join(tmpdir(), "write-state-malformed-"));
  try {
    const malformed = engineStateFixture();
    malformed.completion_intent = { mode: "invalid" } as unknown as CompletionIntent;
    assert.throws(
      () => writeState(malformedRoot, malformed, { featureSlug: "malformed" }),
      /state\.completion_intent\.mode/,
    );
  } finally {
    rmSync(malformedRoot, { recursive: true, force: true });
  }

  const conflictRoot = mkdtempSync(join(tmpdir(), "write-state-conflict-"));
  try {
    const conflicting = engineStateFixture();
    conflicting.completion_intent = completionIntent;
    conflicting.classification.completion_intent = {
      ...completionIntent,
      acceptance: "explicit_human_acceptance",
      rationale: "A conflicting classification projection must fail closed.",
    };
    assert.throws(
      () => writeState(conflictRoot, conflicting, { featureSlug: "conflicting" }),
      /classification\.completion_intent conflicts/,
    );
  } finally {
    rmSync(conflictRoot, { recursive: true, force: true });
  }
});
