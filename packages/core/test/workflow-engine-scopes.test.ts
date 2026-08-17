/**
 * Durable checkpoint decisions and bounded loop re-entry (scopes 4-5):
 *   - interactive and autonomous checkpoint decisions persist and unresolved
 *     checkpoints block advance;
 *   - the interpreter auto-records autonomous checkpoint decisions and fails
 *     closed for interactive ones;
 *   - loops actually re-enter `back_to` with a fresh epoch/capability,
 *     append durable iteration history, respect `max_iterations`, and map
 *     exhaustion to needs_human/failed;
 *   - old loop epochs cannot authorize a re-entered iteration (stale token).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, registerWorkflowProfiles, profileHash } from "../src/engine/profile.js";
import { createCapability, authorizeDispatch, completeDispatch, advanceCursor, recordCheckpointDecision } from "../src/engine/durable.js";
import { writeState } from "../src/engine/state.js";
import { run } from "../src/engine/run.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TaskCaller } from "../src/engine/stage.js";

const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function classification(workflow: string, autonomous: boolean): TeamState["classification"] {
  return { type: "BUG_FIX", complexity: "MEDIUM", confidence: "HIGH", autonomous, workflow: workflow as TeamState["classification"]["workflow"] };
}

function setupStage(
  root: string,
  branch: string,
  profile: Profile,
  stageId: string,
  kind: "single" | "consilium",
  roster: Array<{ role: string; agent: string }>,
): { issued: ReturnType<typeof createCapability>; artifactsDir: string } {
  const persistedHash = profileHash(profile);
  const issued = createCapability({
    run_key: branch, branch, workflow: profile.name, profile_hash: persistedHash,
    stage_cursor: stageId, kind, expected_roster: roster,
  });
  // Preserve durable loop/checkpoint/fan-in state across stage transitions
  // (advanceCursor carries it forward; the test helper must not wipe it).
  const existingPath = join(root, ".work-state", "features", "loop", "state.json");
  let carried: Partial<Pick<TeamState, "loop_state" | "checkpoint_decisions" | "slot_artifacts" | "join_summary">> = {};
  try {
    const existing = JSON.parse(readFileSync(existingPath, "utf8")) as TeamState;
    carried = {
      ...(existing.loop_state ? { loop_state: existing.loop_state } : {}),
      ...(existing.checkpoint_decisions ? { checkpoint_decisions: existing.checkpoint_decisions } : {}),
      ...(existing.slot_artifacts ? { slot_artifacts: existing.slot_artifacts } : {}),
      ...(existing.join_summary ? { join_summary: existing.join_summary } : {}),
    };
  } catch {
    // first stage setup: nothing to carry
  }
  writeState(root, {
    schema: 1,
    branch,
    run_key: branch,
    classification: classification(profile.name, false),
    task: "loop test",
    workflow_override: false,
    issue: null,
    stage_cursor: stageId,
    stages: profile.stages.map((s) => ({ id: s.id, status: s.id === stageId ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: persistedHash,
    scope: NO_SCOPE,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    ...carried,
    updated_at: new Date().toISOString(),
  }, { featureSlug: "loop" });
  const artifactsDir = join(root, ".work-state", "features", "loop", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  return { issued, artifactsDir };
}

function authOf(issued: ReturnType<typeof createCapability>, role: string, agent: string) {
  return {
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    role,
    agent,
  };
}

function advanceAuth(issued: ReturnType<typeof createCapability>) {
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
  };
}

function readState(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "features", "loop", "state.json"), "utf8")) as TeamState;
}

const LOOP_PROFILE: Profile = {
  name: "loop-regression",
  title: "Loop regression",
  description: "debug-cycle shaped loop for durable re-entry tests",
  match: { type: ["OPS"] },
  stages: [
    { id: "diagnose", title: "Diagnose", type: "single", role: "diagnostics", produces: "diagnosis" },
    { id: "implementation", title: "Fix", type: "single", role: "dev", produces: "implementation" },
    {
      id: "verify",
      title: "Verify",
      type: "single",
      role: "manual-qa",
      consumes: ["diagnosis", "implementation"],
      produces: "debug",
      loop: { back_to: "diagnose", until: "verdict == PASS", max_iterations: 2, on_exhausted: "escalate_user" },
    },
    { id: "summary", title: "Summary", type: "orchestrator" },
  ],
};

function runSingleStage(
  root: string,
  profile: Profile,
  stageId: string,
  artifactIds: string[],
  writeArtifacts: (artifactsDir: string) => void,
): ReturnType<typeof createCapability> {
  const role = stageId === "diagnose" ? "diagnostics" : stageId === "implementation" ? "dev" : "manual-qa";
  const roster = [{ role, agent: role }];
  const { issued, artifactsDir } = setupStage(root, "feat/loop", profile, stageId, "single", roster);
  writeArtifacts(artifactsDir);
  const auth = authOf(issued, role, role);
  const authorized = authorizeDispatch(root, auth);
  assert.equal(authorized.ok, true, `authorize ${stageId}`);
  if (!authorized.ok || !authorized.record) throw new Error("authorize failed");
  const completed = completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: `${stageId} done`, artifact_ids: artifactIds });
  assert.equal(completed.ok, true, `complete ${stageId}`);
  if (!completed.ok) throw new Error(`complete failed: ${completed.error}`);
  return issued;
}

test("checkpoint: unresolved declared checkpoint blocks advance; recorded decision unblocks", () => {
  const root = mkdtempSync(join(tmpdir(), "ck-block-"));
  try {
    initGit(root, "feat/ck");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const roster = [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }];
    const { issued, artifactsDir } = setupStage(root, "feat/ck", profile, "implementation", "single", roster);
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ ready: true, validation_run: true, validation_evidence: "evidence", files_touched: ["x"] }));
    const auth = authOf(issued, "${scope.dev_agent}", "developer-kotlin");
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    assert.equal(completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: "done" }).ok, true);

    const blocked = advanceCursor(root, { ...advanceAuth(issued), evidence: "done" });
    assert.equal(blocked.ok, false, "unresolved checkpoint must block advance");
    if (!blocked.ok) assert.match(blocked.error, /checkpoint 'approve_implementation' for stage 'implementation' is unresolved/);

    const recorded = recordCheckpointDecision(root, {
      ...advanceAuth(issued),
      checkpoint: "approve_implementation", mode: "interactive", decision: "approved", actor: "user", rationale: "looks good",
    });
    assert.equal(recorded.ok, true);
    if (!recorded.ok) return;
    const decisions = readState(root).checkpoint_decisions ?? [];
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.mode, "interactive");
    assert.equal(decisions[0]!.actor, "user");
    assert.equal(decisions[0]!.decision, "approved");
    assert.ok(decisions[0]!.decided_at);

    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "done" });
    assert.equal(advanced.ok, true, "recorded decision unblocks advance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint: recording is idempotent and replaces the latest decision; wrong checkpoint name fails", () => {
  const root = mkdtempSync(join(tmpdir(), "ck-replace-"));
  try {
    initGit(root, "feat/ck");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const roster = [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }];
    const { issued } = setupStage(root, "feat/ck", profile, "implementation", "single", roster);
    const first = recordCheckpointDecision(root, { ...advanceAuth(issued), checkpoint: "approve_implementation", mode: "interactive", decision: "approved", actor: "user", rationale: "r1" });
    assert.equal(first.ok, true);
    const second = recordCheckpointDecision(root, { ...advanceAuth(issued), checkpoint: "approve_implementation", mode: "autonomous", decision: "proceed", actor: "orchestrator", rationale: "r2" });
    assert.equal(second.ok, true);
    const decisions = readState(root).checkpoint_decisions ?? [];
    assert.equal(decisions.length, 1, "latest decision replaces the prior record");
    assert.equal(decisions[0]!.mode, "autonomous");
    assert.equal(decisions[0]!.rationale, "r2");
    const wrongName = recordCheckpointDecision(root, { ...advanceAuth(issued), checkpoint: "bogus", mode: "interactive", decision: "x", actor: "user", rationale: "r" });
    assert.equal(wrongName.ok, false);
    if (!wrongName.ok) assert.match(wrongName.error, /does not match declared checkpoint/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop: FAIL until re-enters back_to with a fresh capability and durable history; stale epoch cannot authorize", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-reenter-"));
  try {
    initGit(root, "feat/loop");
    registerWorkflowProfiles([LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);

    const verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "cause", explanation: "why" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });

    const advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "verify FAIL" });
    assert.equal(advanced.ok, true, "FAIL until re-enters the loop");
    if (!advanced.ok) return;
    const state = advanced.state;
    assert.equal(state.stage_cursor, "diagnose", "cursor re-enters back_to");
    assert.equal(state.stages.find((s) => s.id === "verify")?.status, "done");
    assert.equal(state.stages.find((s) => s.id === "diagnose")?.status, "in_progress");
    assert.equal(state.dispatch_capability?.status, "ready", "re-entry arms a fresh ready capability");
    assert.equal(state.dispatch_capability?.kind, "single");
    assert.deepEqual(state.dispatch_capability?.expected_roster, [{ role: "diagnostics", agent: "diagnostics" }]);
    assert.equal(state.loop_state?.reentries, 1);
    assert.equal(state.loop_state?.status, "running");
    assert.equal(state.loop_state?.history.length, 1);
    assert.equal(state.loop_state?.history[0]!.iteration, 1);
    assert.equal(state.loop_state?.history[0]!.from_epoch, verify.state.issued_for!.cursor_epoch);
    assert.equal(state.loop_state?.history[0]!.to_epoch, state.cursor_epoch);
    assert.notEqual(state.cursor_epoch, verify.state.issued_for!.cursor_epoch, "fresh cursor epoch per iteration");

    // The old verify-epoch token must not authorize anything after re-entry.
    const stale = advanceCursor(root, { ...advanceAuth(verify), evidence: "stale" });
    assert.equal(stale.ok, false, "old loop epoch cannot authorize a re-entered iteration");
    if (!stale.ok) assert.match(stale.error, /capability identity mismatch|capability binding mismatch|invalid secret|stale cursor binding/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop: full debug cycle re-enters twice, then exhausts to needs_human", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-exhaust-"));
  try {
    initGit(root, "feat/loop");
    registerWorkflowProfiles([LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);

    // Iteration 1: verify FAIL -> re-enter diagnose (reentries 1).
    let verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c1", explanation: "e1" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });
    let advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL 1" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;

    // Iteration 2: diagnose -> implementation -> verify FAIL -> re-enter (reentries 2).
    const diagnose = runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c2", explanation: "e2" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose), evidence: "diagnose 2" }).ok, true);
    const implementation = runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation), evidence: "fix 2" }).ok, true);
    verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c2", explanation: "e2" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 2 }));
    });
    advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL 2" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.loop_state?.reentries, 2, "second re-entry recorded");

    // Iteration 3: diagnose -> implementation -> verify FAIL -> exhausted (max_iterations=2).
    const diagnose3 = runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c3", explanation: "e3" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose3), evidence: "diagnose 3" }).ok, true);
    const implementation3 = runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation3), evidence: "fix 3" }).ok, true);
    verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c3", explanation: "e3" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 3 }));
    });
    advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL 3" });
    assert.equal(advanced.ok, true, "exhaustion is a durable transition");
    if (!advanced.ok) return;
    assert.equal(advanced.state.loop_state?.status, "exhausted");
    assert.equal(advanced.state.loop_state?.outcome, "needs_human", "escalate_user maps to needs_human");
    assert.equal(advanced.state.pause.kind, "needs_human");
    assert.equal(advanced.state.dispatch_capability?.status, "complete", "no ready capability after exhaustion");
    assert.equal(advanced.state.stage_cursor, "verify");
    assert.equal(advanced.handoff, undefined, "no handoff after exhaustion");
    assert.equal(advanced.state.loop_state?.history.length, 2, "durable iteration history preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop: until PASS exits the loop and advances normally; on_exhausted failed maps to failed pause", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-pass-"));
  try {
    initGit(root, "feat/loop");
    registerWorkflowProfiles([LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);

    // First FAIL -> re-enter.
    let verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });
    let advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "diagnose");

    // Second verify with PASS -> loop complete, advance to summary.
    const diagnose = runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose), evidence: "diagnose 2" }).ok, true);
    const implementation = runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation), evidence: "fix 2" }).ok, true);
    verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "PASS", iterations: 2 }));
    });
    advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "PASS" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.loop_state?.status, "complete", "PASS marks the loop complete");
    assert.equal(advanced.state.stage_cursor, "summary", "loop exits to the next stage");
    assert.equal(advanced.state.dispatch_capability?.status, "ready");

    // on_exhausted: "failed" maps to a failed pause after max_iterations=1.
    const failProfile: Profile = {
      ...LOOP_PROFILE,
      name: "loop-fail-regression",
      stages: LOOP_PROFILE.stages.map((s) => s.id === "verify" ? { ...s, loop: { ...s.loop!, on_exhausted: "failed", max_iterations: 1 } } : s),
    };
    registerWorkflowProfiles([failProfile]);
    const failP = loadProfile("loop-fail-regression");
    assert.ok(failP);
    const verifyF = runSingleStage(root, failP, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });
    const firstFail = advanceCursor(root, { ...advanceAuth(verifyF), evidence: "FAIL" });
    assert.equal(firstFail.ok, true);
    if (!firstFail.ok) return;
    assert.equal(firstFail.state.loop_state?.reentries, 1, "max_iterations=1 allows one re-entry");
    const diagnoseF = runSingleStage(root, failP, "diagnose", ["diagnosis"], (dir) => writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnoseF), evidence: "d" }).ok, true);
    const implF = runSingleStage(root, failP, "implementation", ["implementation"], (dir) => writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" })));
    assert.equal(advanceCursor(root, { ...advanceAuth(implF), evidence: "i" }).ok, true);
    const verifyF2 = runSingleStage(root, failP, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ root_cause: "c", explanation: "e" }));
      writeFileSync(join(dir, "implementation.json"), JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" }));
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 2 }));
    });
    const exhausted = advanceCursor(root, { ...advanceAuth(verifyF2), evidence: "FAIL 2" });
    assert.equal(exhausted.ok, true);
    if (!exhausted.ok) return;
    assert.equal(exhausted.state.pause.kind, "failed", "on_exhausted=failed maps to a failed pause");
    assert.equal(exhausted.state.loop_state?.outcome, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint: interpreter auto-records autonomous decisions and blocks interactive ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-interp-"));
  const branch = "feat/interp";
  try {
    initGit(root, branch);
    registerWorkflowProfiles([LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);
    const checkpointProfile: Profile = {
      ...LOOP_PROFILE,
      name: "interp-checkpoint",
      stages: LOOP_PROFILE.stages.map((s) => s.id === "diagnose" ? { ...s, checkpoint: "approve_diagnosis" } : s),
    };
    registerWorkflowProfiles([checkpointProfile]);

    // Interactive run (autonomous=false): advance must fail closed with the
    // unresolved checkpoint diagnostic.
    const interactive: TaskCaller = {
      async call(args) {
        const stageId = args.task.match(/## Stage: ([^ ]+)/)?.[1] ?? "?";
        return { id: stageId, output: "ok", artifacts: stageId === "diagnose" ? { diagnosis: { root_cause: "c", explanation: "e" } } : {}, exitCode: 0 };
      },
      async batch() { return []; },
    };
    const interactiveResult = await run({
      task: "interactive checkpoint",
      cwd: root,
      branch,
      autonomous: false,
      classification: { type: "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "interp-checkpoint" },
      taskTool: interactive,
    });
    assert.ok(
      interactiveResult.outcomes.some((o) => o.status === "failed" && /checkpoint 'approve_diagnosis'/.test(o.note)),
      "interactive unresolved checkpoint blocks advance",
    );

    // Autonomous run (autonomous=true): the declared auto-decision is
    // recorded durably and the loop runs to completion.
    const root2 = mkdtempSync(join(tmpdir(), "ck-interp-auto-"));
    try {
      initGit(root2, branch);
      let verifyRuns = 0;
      const autonomous: TaskCaller = {
        async call(args) {
          const stageId = args.task.match(/## Stage: ([^ ]+)/)?.[1] ?? "?";
          if (stageId === "diagnose") return { id: "d", output: "ok", artifacts: { diagnosis: { root_cause: "c", explanation: "e" } }, exitCode: 0 };
          if (stageId === "implementation") return { id: "i", output: "ok", artifacts: { implementation: { files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" } }, exitCode: 0 };
          if (stageId === "verify") {
            verifyRuns += 1;
            return { id: "v", output: "ok", artifacts: { debug: { verdict: verifyRuns === 1 ? "FAIL" : "PASS", iterations: verifyRuns } }, exitCode: 0 };
          }
          return { id: stageId, output: "ok", artifacts: {}, exitCode: 0 };
        },
        async batch() { return []; },
      };
      const autoResult = await run({
        task: "autonomous checkpoint",
        cwd: root2,
        branch,
        autonomous: true,
        classification: { type: "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: true, workflow: "interp-checkpoint" },
        taskTool: autonomous,
      });
      assert.equal(autoResult.outcomes.some((o) => o.status === "failed"), false, "autonomous run completes");
      const statePath = autoResult.statePath!;
      const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
      const decision = state.checkpoint_decisions?.find((d) => d.checkpoint === "approve_diagnosis");
      assert.ok(decision, "autonomous checkpoint decision is recorded durably");
      assert.equal(decision!.mode, "autonomous");
      assert.ok(decision!.rationale.length > 0, "autonomous decision preserves the declared rationale");
      assert.equal(state.loop_state?.status, "complete");
      assert.equal(state.loop_state?.reentries, 1);
      assert.equal(verifyRuns, 2);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint: interpreter enforces declared checkpoints on orchestrator/bash/none stages", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-interp-alltypes-"));
  const branch = "feat/interp-all";
  try {
    initGit(root, branch);
    const allTypesProfile: Profile = {
      name: "interp-checkpoint-all-types",
      title: "All stage types with an orchestrator checkpoint",
      description: "orchestrator (checkpoint) -> bash -> none",
      match: { type: ["FEATURE"] },
      stages: [
        {
          id: "discovery",
          title: "Discovery",
          type: "orchestrator",
          checkpoint: "confirm_understanding",
          autonomous: "log confirmed understanding, continue",
        },
        { id: "hooks", title: "Hooks", type: "bash", command: "true" },
        { id: "noop", title: "Noop", type: "none" },
      ],
    };
    registerWorkflowProfiles([allTypesProfile]);
    const taskTool: TaskCaller = {
      async call() { return { id: "x", output: "ok", artifacts: {}, exitCode: 0 }; },
      async batch() { return []; },
    };
    const baseClassification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const };

    // Interactive: the orchestrator's declared checkpoint blocks advance and
    // no later stage can run while it is unresolved.
    const interactiveResult = await run({
      task: "interactive all-types",
      cwd: root,
      branch,
      autonomous: false,
      classification: { ...baseClassification, autonomous: false, workflow: "interp-checkpoint-all-types" },
      taskTool,
    });
    assert.ok(
      interactiveResult.outcomes.some((o) => o.status === "failed" && /checkpoint 'confirm_understanding' for stage 'discovery' is unresolved/.test(o.note)),
      "interactive orchestrator checkpoint blocks advance",
    );
    const interactiveState = JSON.parse(readFileSync(interactiveResult.statePath!, "utf8")) as TeamState;
    assert.equal(interactiveState.stages.find((s) => s.id === "discovery")?.status, "failed");
    assert.equal(interactiveState.stages.find((s) => s.id === "hooks")?.status, "pending", "later stages never run while the checkpoint is unresolved");
    assert.equal(interactiveState.stages.find((s) => s.id === "noop")?.status, "pending");

    // Autonomous: the declared auto-decision is recorded durably and every
    // stage type (orchestrator/bash/none) advances through the same durable
    // transition to completion.
    const root2 = mkdtempSync(join(tmpdir(), "ck-interp-alltypes-auto-"));
    try {
      initGit(root2, branch);
      const autoResult = await run({
        task: "autonomous all-types",
        cwd: root2,
        branch,
        autonomous: true,
        classification: { ...baseClassification, autonomous: true, workflow: "interp-checkpoint-all-types" },
        taskTool,
      });
      assert.equal(autoResult.outcomes.some((o) => o.status === "failed"), false, "autonomous run completes");
      assert.deepEqual(autoResult.outcomes.map((o) => o.status), ["done", "done", "done"], "orchestrator/bash/none all advance");
      const autoState = JSON.parse(readFileSync(autoResult.statePath!, "utf8")) as TeamState;
      const decision = autoState.checkpoint_decisions?.find((d) => d.checkpoint === "confirm_understanding");
      assert.ok(decision, "orchestrator checkpoint decision is recorded durably");
      assert.equal(decision!.mode, "autonomous");
      assert.equal(decision!.stage_id, "discovery");
      assert.ok(decision!.rationale.length > 0, "autonomous decision preserves the declared rationale");
      assert.ok(autoState.stages.every((s) => s.status === "done" || s.status === "skipped"), "no stage reaches done while its checkpoint is unresolved");
      assert.equal(autoState.pause.kind, "done");
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
