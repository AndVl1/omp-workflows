import assert from "node:assert/strict";
import test from "node:test";
import { loopReentryDecision, loopReentryStageIds } from "../src/engine/loops.js";
import type { LoopState, Profile, TeamState } from "../src/engine/types.js";

function runningLoop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    stage_id: "verify",
    back_to: "diagnose",
    until: "verdict == PASS",
    max_iterations: 3,
    on_exhausted: "escalate_user",
    reentries: 1,
    epoch: "epoch-2",
    status: "running",
    history: [{
      iteration: 2,
      from_epoch: "epoch-1",
      to_epoch: "epoch-2",
      until_satisfied: false,
      at: "2026-01-01T00:00:00.000Z",
    }],
    ...overrides,
  };
}

test("loop decisions count the initial execution toward max_iterations", () => {
  assert.deepEqual(loopReentryDecision(null, 3), { reentries: 0, exhausted: false });
  assert.deepEqual(loopReentryDecision(runningLoop({ reentries: 1 }), 3), { reentries: 1, exhausted: false });
  assert.deepEqual(loopReentryDecision(runningLoop({ reentries: 2 }), 3), { reentries: 2, exhausted: true });
  assert.deepEqual(loopReentryDecision(null, 1), { reentries: 0, exhausted: true });
});

test("loop re-entry preserves only the active back_to-through-owner window", () => {
  const profile: Profile = {
    name: "loop-window-test",
    title: "Loop window test",
    description: "Unit fixture for resumed loop filtering.",
    match: { type: ["BUG_FIX"] },
    stages: [
      { id: "discovery", title: "Discovery", type: "orchestrator" },
      { id: "diagnose", title: "Diagnose", type: "single", role: "diagnostics" },
      { id: "implementation", title: "Implementation", type: "single", role: "developer" },
      { id: "verify", title: "Verify", type: "single", role: "manual-qa", loop: { back_to: "diagnose", until: "verdict == PASS", max_iterations: 3, on_exhausted: "escalate_user" } },
      { id: "downstream", title: "Downstream", type: "single", role: "worker" },
    ],
  };
  const state = {
    stage_cursor: "diagnose",
    loop_state: runningLoop({ stage_id: "verify", back_to: "diagnose" }),
  } as TeamState;
  assert.deepEqual([...loopReentryStageIds(profile, state)], ["diagnose", "implementation", "verify"]);
  assert.equal(loopReentryStageIds(profile, { ...state, stage_cursor: "discovery" }).size, 0);
});
