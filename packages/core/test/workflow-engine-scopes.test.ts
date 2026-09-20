/**
 * Durable checkpoint decisions and bounded loop re-entry (scopes 4-5):
 *   - interactive and routing-autonomy checkpoint attempts persist no
 *     authorization while unresolved checkpoints block advance;
 *   - only explicit typed, policy-bound decisions can unblock a checkpoint;
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
import { beginCapability, authorizeDispatch as rawAuthorizeDispatch, completeDispatch as rawCompleteDispatch, advanceCursor as rawAdvanceCursor, recordCheckpointDecision as rawRecordCheckpointDecision, type IssuedCapability } from "../src/engine/durable.js";
import { appendCheckpointDecision, checkpointAnswerBinding, checkpointPolicyHash, recordTrustedCheckpointAnswer, validateCheckpointDecision } from "../src/engine/checkpoints.js";
import { writeStateBootstrap } from "../src/engine/state.js";
import { runTarget } from "../src/engine/run-store.js";
import { run } from "../src/engine/run.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TaskCaller } from "../src/engine/stage.js";

const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };
function classification(workflow: string, autonomous: boolean): TeamState["classification"] {
  return { type: "FEATURE", complexity: workflow === "lightweight" ? "QUICK" : "MEDIUM", confidence: "HIGH", autonomous, workflow: workflow as TeamState["classification"]["workflow"] };
}
const RUN_ID = "77777777-7777-4777-8777-777777777777";

function authorizeDispatch(root: string, input: Parameters<typeof rawAuthorizeDispatch>[1]) {
  return rawAuthorizeDispatch(root, { ...input, run_id: RUN_ID });
}
function completeDispatch(root: string, input: Parameters<typeof rawCompleteDispatch>[1]) {
  if (input.artifact_ids?.length) {
    const statePath = join(root, ".work-state", "runs", RUN_ID, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    const artifacts = { ...(state.artifacts ?? {}) };
    for (const id of input.artifact_ids) artifacts[id] = `artifacts/${id}.json`;
    writeStateBootstrap(root, { ...state, artifacts }, { target: runTarget(root, RUN_ID) });
  }
  return rawCompleteDispatch(root, { ...input, run_id: RUN_ID }, { runId: RUN_ID });
}
function advanceCursor(root: string, input: Parameters<typeof rawAdvanceCursor>[1]) {
  return rawAdvanceCursor(root, { ...input, run_id: RUN_ID }, { runId: RUN_ID });
}
function recordCheckpointDecision(root: string, input: Parameters<typeof rawRecordCheckpointDecision>[1]) {
  return rawRecordCheckpointDecision(root, { ...input, run_id: RUN_ID });
}

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function setupStage(
  root: string,
  branch: string,
  profile: Profile,
  stageId: string,
): { issued: IssuedCapability; artifactsDir: string } {
  const persistedHash = profileHash(profile);
  const statePath = runTarget(root, RUN_ID).statePath!;
  let existing: TeamState | null = null;
  try {
    existing = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
  } catch { /* first stage */ }

  if (!existing) {
    const runDir = join(root, ".work-state", "runs", RUN_ID);
    const artifactsDir = join(runDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeStateBootstrap(root, {
      schema: 2, run_id: RUN_ID, run_key: RUN_ID, lifecycle_status: "active", rework_generation: 0,
      branch, title: "loop test", classification: classification(profile.name, false), task: "loop test",
      workflow_override: false, issue: null, required_inputs: {}, required_input_receipts: {},
      stage_cursor: stageId,
      stages: profile.stages.map((s) => ({ id: s.id, status: s.id === stageId ? "in_progress" as const : "pending" as const })),
      artifacts: {}, pause: { kind: "none", reason: "" }, policy: { strict_orchestrator: true },
      scope: { ...NO_SCOPE, dev_agent: "developer-kotlin" },
      profile_hash: persistedHash,
      ...(profile.checkpoint_policy ? { checkpoint_policy: profile.checkpoint_policy } : {}),
      updated_at: new Date().toISOString(),
    }, { target: runTarget(root, RUN_ID) });
    if (profile.name === "lightweight" && stageId === "implementation") {
      writeFileSync(join(artifactsDir, "discovery.json"), JSON.stringify({ task: "loop test", branch }));
    }
    if (stageId === "verify" && profile.stages.some((stage) => stage.id === "verify")) {
      writeLoopDiagnosis(artifactsDir);
      writeLoopImplementation(artifactsDir);
      writeFileSync(join(artifactsDir, "external.json"), JSON.stringify({ source: "stable external input", version: 1 }));
    }
  } else {
    assert.equal(existing.run_id, RUN_ID, "canonical run id remains stable");
    assert.equal(existing.run_key, RUN_ID, "canonical run key remains stable");
    assert.equal(existing.classification.workflow, profile.name, "stage setup cannot replace the committed workflow profile");
    assert.equal(existing.stage_cursor, stageId, `canonical cursor is already ${stageId}`);
  }

  // Arm through the production workflow_begin seam, then read the committed
  // canonical run. Never synthesize capability fields from a pre-begin state.
  const begun = beginCapability(root, undefined, { runId: RUN_ID });
  assert.equal(begun.ok, true, begun.ok ? "workflow_begin" : begun.error);
  if (!begun.ok || !begun.handoff) throw new Error(`workflow_begin failed: ${begun.ok ? "missing handoff" : begun.error}`);
  const committed = readState(root);
  assert.equal(committed.run_id, RUN_ID);
  assert.equal(committed.branch, branch);
  assert.equal(committed.run_key, RUN_ID);
  assert.equal(committed.profile_hash, persistedHash);
  assert.equal(committed.stage_cursor, stageId);
  assert.equal(begun.handoff.run_key, committed.run_key);
  assert.equal(begun.handoff.stage_cursor, committed.stage_cursor);
  assert.equal(begun.handoff.cursor_epoch, committed.cursor_epoch);
  assert.equal(begun.handoff.loop_iteration, committed.dispatch_capability?.issued_for?.loop_iteration);
  assert.ok(committed.cursor_epoch, "canonical run carries the committed cursor epoch");
  assert.ok(committed.dispatch_capability, "canonical run carries the committed capability");
  const issued: IssuedCapability = {
    capability_id: begun.handoff.capability_id,
    dispatch_token: begun.handoff.dispatch_token,
    advance_token: begun.handoff.advance_token,
    state: committed.dispatch_capability!,
  };
  return { issued, artifactsDir: join(root, ".work-state", "runs", RUN_ID, "artifacts") };
}

function authOf(issued: IssuedCapability, role: string, agent: string) {
  return {
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: issued.state.issued_for!.loop_iteration,
    role,
    agent,
  };
}

function advanceAuth(issued: IssuedCapability) {
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: issued.state.issued_for!.loop_iteration,
  };
}

function readState(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "runs", RUN_ID, "state.json"), "utf8")) as TeamState;
}

function typedCheckpoint(root: string, stageId: string, checkpointId: string, decision = "proceed", answerSuffix = "") {
  const state = readState(root);
  const policy = state.checkpoint_policy;
  const capability = state.dispatch_capability;
  assert.ok(policy, "checkpoint test state must carry a typed policy");
  assert.ok(capability?.capability_id && capability.issued_for?.cursor_epoch, "checkpoint test state must carry capability binding");
  const rule = policy.rules[checkpointId];
  assert.ok(rule, `checkpoint test policy must define ${checkpointId}`);
  const trusted = recordTrustedCheckpointAnswer(state, {
    answer_id: `scope-test/${stageId}/${checkpointId}${answerSuffix}`,
    channel: "terminal",
    reference: `terminal-answer/scope-test/${stageId}/${checkpointId}${answerSuffix}`,
    stage_id: stageId,
    checkpoint_id: checkpointId,
    decision,
  });
  writeStateBootstrap(root, trusted.state, { target: runTarget(root, RUN_ID) });
  return {
    run_id: state.work_identity?.run_id ?? state.run_key ?? state.branch,
    stage_id: stageId,
    checkpoint_id: checkpointId,
    checkpoint_kind: rule.kind,
    decision,
    authorization: "human" as const,
    actor: { kind: "user" as const, ref: trusted.answer.reference, proof: trusted.proof },
    capability_id: capability.capability_id,
    capability_epoch: capability.issued_for!.cursor_epoch,
    loop_iteration: capability.issued_for!.loop_iteration,
    policy_hash: checkpointPolicyHash(policy),
    rationale: "explicit typed test answer",
    decided_at: new Date().toISOString(),
  };
}

function persistTypedCheckpoint(root: string, stageId: string, checkpointId: string, decision = "proceed"): void {
  const typed = typedCheckpoint(root, stageId, checkpointId, decision);
  const appended = appendCheckpointDecision(readState(root), typed);
  assert.equal(appended.ok, true, appended.ok ? "checkpoint recorded" : `checkpoint append failed: ${appended.code}: ${appended.error}`);
  writeStateBootstrap(root, appended.state, { target: runTarget(root, RUN_ID) });
}
const LOOP_DIAGNOSIS = { root_cause: "loop fixture 1", explanation: "initial upstream diagnosis for the first committed loop iteration" };
const LOOP_IMPLEMENTATION = { files_touched: ["loop-fixture-1"], ready: true, validation_run: true, validation_evidence: "initial upstream implementation fixture" };
function writeLoopDiagnosis(dir: string, iteration = "1"): void {
  writeFileSync(join(dir, "diagnosis.json"), JSON.stringify(
    iteration === "1" ? LOOP_DIAGNOSIS : { root_cause: `loop fixture ${iteration}`, explanation: `diagnosis produced by committed iteration ${iteration}` },
  ));
}
function writeLoopImplementation(dir: string, iteration = "1"): void {
  writeFileSync(join(dir, "implementation.json"), JSON.stringify(
    iteration === "1" ? LOOP_IMPLEMENTATION : { files_touched: [`loop-fixture-${iteration}`], ready: true, validation_run: true, validation_evidence: `implementation produced by committed iteration ${iteration}` },
  ));
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
      consumes: ["diagnosis", "implementation", "external"],
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
): IssuedCapability {
  const role = stageId === "diagnose" ? "diagnostics" : stageId === "implementation" ? "dev" : "manual-qa";
  const { issued, artifactsDir } = setupStage(root, "feat/loop", profile, stageId);
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

test("checkpoint: unresolved declared checkpoint blocks advance; an explicit typed decision unblocks", () => {
  const root = mkdtempSync(join(tmpdir(), "ck-block-"));
  try {
    initGit(root, "feat/ck");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const { issued, artifactsDir } = setupStage(root, "feat/ck", profile, "implementation");
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ files_touched: ["checkpoint-fixture"], ready: true, validation_run: true, validation_evidence: "checkpoint fixture" }));
    const auth = authOf(issued, issued.state.expected_roster[0]!.role, issued.state.expected_roster[0]!.agent);
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    assert.equal(completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: "done", artifact_ids: ["implementation"] }).ok, true);

    const blocked = advanceCursor(root, { ...advanceAuth(issued), evidence: "done" });
    assert.equal(blocked.ok, false, "unresolved checkpoint must block advance");
    if (!blocked.ok) {
      assert.equal(blocked.state.pause.kind, "user_checkpoint", `missing consent is resumable: ${blocked.error}`);
    }
    assert.equal((readState(root).typed_checkpoint_decisions ?? []).length, 0, "classification never creates consent");

    persistTypedCheckpoint(root, "implementation", "approve_implementation");
    const recorded = readState(root);
    assert.equal(recorded.typed_checkpoint_decisions?.length, 1);
    assert.equal(recorded.checkpoint_decisions?.length, 1, "legacy record is only a typed mirror");
    assert.equal(recorded.checkpoint_decisions?.[0]?.mode, "interactive");
    assert.equal(recorded.checkpoint_decisions?.[0]?.actor, "user:terminal-answer/scope-test/implementation/approve_implementation");
    assert.equal(recorded.checkpoint_decisions?.[0]?.decision, "proceed");
    assert.ok(recorded.checkpoint_decisions?.[0]?.decided_at);

    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "done" });
    assert.equal(advanced.ok, true, "typed decision unblocks advance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("checkpoint: hard-human authorization requires a durable answer proof, not a forgeable prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "ck-provenance-"));
  try {
    initGit(root, "feat/ck-provenance");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    setupStage(root, "feat/ck-provenance", profile, "implementation");

    const valid = typedCheckpoint(root, "implementation", "approve_implementation");
    const state = readState(root);
    const stage = { id: "implementation", checkpoint: "approve_implementation" };
    const accepted = validateCheckpointDecision(state, valid, { stage });
    assert.equal(accepted.ok, true, "the trusted ingest path creates a valid proof");

    for (const ref of ["user:fabricated", "terminal:also-forgeable", "escalation:also-forgeable"]) {
      const spoofed = { ...valid, actor: { kind: "user" as const, ref } };
      const rejected = validateCheckpointDecision(state, spoofed, { stage });
      assert.equal(rejected.ok, false, `bare ${ref} must not authorize`);
      if (!rejected.ok) assert.equal(rejected.code, "checkpoint_unverified");
    }
    const trustedRecord = state.trusted_checkpoint_answers?.[0];
    assert.ok(trustedRecord, "trusted ingest must persist an answer record before proof submission");
    const forgedRecord = {
      ...trustedRecord,
      answer_id: "caller-minted-answer",
      nonce: "caller-chosen-nonce",
      reference: "terminal-answer/caller-minted-answer",
      binding: "",
    };
    const forgedBinding = checkpointAnswerBinding(forgedRecord);
    const selfConsistentForgery = {
      ...valid,
      actor: {
        kind: "user" as const,
        ref: forgedRecord.reference,
        proof: {
          answer_id: forgedRecord.answer_id,
          nonce: forgedRecord.nonce,
          channel: forgedRecord.channel,
          reference: forgedRecord.reference,
          binding: forgedBinding,
        },
      },
    };
    const forged = validateCheckpointDecision(state, selfConsistentForgery, { stage });
    assert.equal(forged.ok, false, "a caller-computed binding without a durable answer record must not authorize");
    if (!forged.ok) assert.equal(forged.code, "checkpoint_unverified");


    const proof = valid.actor.proof!;
    const mismatches = [
      { ...valid, run_id: "stale-run" },
      { ...valid, capability_epoch: "stale-epoch" },
      { ...valid, policy_hash: "stale-policy" },
      { ...valid, decision: "reject" },
      { ...valid, actor: { ...valid.actor, proof: { ...proof, nonce: "replayed-nonce" } } },
      { ...valid, actor: { ...valid.actor, proof: { ...proof, binding: "forged-binding" } } },
      { ...valid, actor: { ...valid.actor, proof: { ...proof, channel: "escalation" as const } } },
      { ...valid, actor: { ...valid.actor, proof: { ...proof, reference: "terminal:wrong-reference" } } },
    ];
    for (const candidate of mismatches) {
      const rejected = validateCheckpointDecision(state, candidate, { stage });
      assert.equal(rejected.ok, false, "mismatched durable answer context must fail closed");
      if (!rejected.ok) assert.equal(rejected.code, "checkpoint_unverified");
    }

    const persisted = appendCheckpointDecision(state, valid);
    assert.equal(persisted.ok, true);
    assert.equal(persisted.state.typed_checkpoint_decisions?.length, 1);
    assert.equal(persisted.state.trusted_checkpoint_answers?.[0]?.consumed_at !== undefined, true, "answer consumption is durable");
    assert.equal(persisted.state.trusted_checkpoint_answers?.[0]?.consumed_reason, "finalized", "finalization reason is durable");
    assert.deepEqual(persisted.state.artifacts, state.artifacts, "checkpoint authorization does not overwrite artifacts");
    assert.equal(validateCheckpointDecision(persisted.state, valid, { stage }).ok, true, "exact replay is idempotent");
    const conflicting = appendCheckpointDecision(persisted.state, { ...valid, decision: "reject" });
    assert.equal(conflicting.ok, false, "a replayed answer cannot authorize a different decision");
    if (!conflicting.ok) assert.equal(conflicting.code, "checkpoint_unverified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("checkpoint: routing autonomy stays orthogonal to profile consent; migration conflicts fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "ck-policy-orthogonal-"));
  try {
    initGit(root, "feat/ck-policy");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const { issued, artifactsDir } = setupStage(root, "feat/ck-policy", profile, "implementation");
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ ready: true, validation_run: true, validation_evidence: "evidence", files_touched: ["x"] }));
    const auth = authOf(issued, issued.state.expected_roster[0]!.role, issued.state.expected_roster[0]!.agent);
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    assert.equal(completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: "done" }).ok, true);

    const profileState = readState(root);
    assert.equal(profileState.checkpoint_policy?.source, "profile");
    writeStateBootstrap(root, { ...profileState, classification: { ...profileState.classification, autonomous: true } }, { target: runTarget(root, RUN_ID) });
    persistTypedCheckpoint(root, "implementation", "approve_implementation");
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "typed human consent" });
    assert.equal(advanced.ok, true, "routing autonomous=true must not conflict with a profile-source human policy");

    const migrationRoot = mkdtempSync(join(tmpdir(), "ck-policy-migration-conflict-"));
    try {
      initGit(migrationRoot, "feat/ck-policy-migration");
      const migrationSetup = setupStage(migrationRoot, "feat/ck-policy-migration", profile, "implementation");
      const migrationState = readState(migrationRoot);
      const basePolicy = migrationState.checkpoint_policy!;
      const migrationPolicy = {
        ...basePolicy,
        default: "autonomous_allowed" as const,
        source: "migration" as const,
        rules: {
          ...basePolicy.rules,
          approve_implementation: { ...basePolicy.rules.approve_implementation!, default: "autonomous_allowed" as const },
        },
      };
      const typed = typedCheckpoint(migrationRoot, "implementation", "approve_implementation");
      const conflictingState = {
        ...readState(migrationRoot),
        classification: { ...migrationState.classification, autonomous: false },
        checkpoint_policy: migrationPolicy,
      };
      writeFileSync(runTarget(migrationRoot, RUN_ID).statePath!, JSON.stringify(conflictingState) + "\n");
      const conflict = validateCheckpointDecision(readState(migrationRoot), typed, {
        stage: { id: "implementation", checkpoint: "approve_implementation", checkpoint_policy: migrationPolicy },
      });
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.code, "migration_conflict");
      void migrationSetup;
    } finally {
      rmSync(migrationRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint: typed recording is idempotent; conflicting decisions fail and wrong names fail", () => {
  const root = mkdtempSync(join(tmpdir(), "ck-replace-"));
  try {
    initGit(root, "feat/ck");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const { issued } = setupStage(root, "feat/ck", profile, "implementation");
    const typed = typedCheckpoint(root, "implementation", "approve_implementation");
    const firstAppend = appendCheckpointDecision(readState(root), typed);
    assert.equal(firstAppend.ok, true, firstAppend.ok ? "first append" : `${firstAppend.code}: ${firstAppend.error}`);
    writeStateBootstrap(root, firstAppend.state, { target: runTarget(root, RUN_ID) });
    const secondAppend = appendCheckpointDecision(readState(root), typed);
    assert.equal(secondAppend.ok, true);
    writeStateBootstrap(root, secondAppend.state, { target: runTarget(root, RUN_ID) });
    const replay = appendCheckpointDecision(readState(root), typed);
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent, true, "identical typed decision is idempotent");
    writeStateBootstrap(root, replay.state, { target: runTarget(root, RUN_ID) });
    const decisions = readState(root);
    assert.equal(decisions.typed_checkpoint_decisions?.length, 1, "identical typed decision is idempotent");
    assert.equal(decisions.checkpoint_decisions?.length, 1, "typed mirror remains singular");
    const conflictingTyped = typedCheckpoint(root, "implementation", "approve_implementation", "proceed", "/conflict");
    const conflicting = appendCheckpointDecision(readState(root), { ...conflictingTyped, rationale: "conflicting answer" });
    assert.equal(conflicting.ok, false, "a separately proven second answer cannot replace an existing checkpoint decision");
    if (!conflicting.ok) assert.equal(conflicting.code, "decision_conflict");
    const wrongName = recordCheckpointDecision(root, { ...advanceAuth(issued), checkpoint: "bogus", mode: "interactive", decision: "x", actor: "user", rationale: "r" });
    assert.equal(wrongName.ok, false);
    if (!wrongName.ok) assert.match(wrongName.error, /typed checkpoint authorization and actor provenance/);
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
    // The history entry labels the execution iteration the loop-back
    // ENTERS (loop_state.reentries + 1) — the same number the re-armed
    // capability and its handoff carry, so re-entry count and execution
    // iteration can never be conflated.
    assert.equal(state.loop_state?.history[0]!.iteration, 2);
    assert.equal(state.dispatch_capability?.issued_for?.loop_iteration, 2);
    assert.equal(state.loop_state?.history[0]!.from_epoch, verify.state.issued_for!.cursor_epoch);
    assert.equal(state.loop_state?.history[0]!.to_epoch, state.cursor_epoch);
    assert.notEqual(state.cursor_epoch, verify.state.issued_for!.cursor_epoch, "fresh cursor epoch per iteration");

    // A regenerated diagnosis/implementation pair may differ, while an
    // unrelated external input remains hash-pinned across loop admission.
    const diagnose2 = runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeLoopDiagnosis(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose2), evidence: "diagnose 2" }).ok, true);
    const implementation2 = runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeLoopImplementation(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation2), evidence: "implementation 2" }).ok, true);
    writeFileSync(join(root, ".work-state", "runs", RUN_ID, "artifacts", "external.json"), JSON.stringify({ source: "tampered external input", version: 2 }));
    const blockedExternal = beginCapability(root, undefined, { runId: RUN_ID });
    assert.equal(blockedExternal.ok, false, "tampered unaffected external input blocks next loop admission");
    if (!blockedExternal.ok) assert.match(blockedExternal.error, /required input external hash does not match/);

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
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });
    let advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL 1" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;

    // Iteration 2: diagnose -> implementation -> verify FAIL -> re-enter (reentries 2).
    const diagnose = runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeLoopDiagnosis(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose), evidence: "diagnose 2" }).ok, true);
    const implementation = runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeLoopImplementation(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation), evidence: "fix 2" }).ok, true);
    verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 2 }));
    });
    advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL 2" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.loop_state?.reentries, 2, "second re-entry recorded");

    // Iteration 3: diagnose -> implementation -> verify FAIL -> exhausted (max_iterations=2).
    const diagnose3 = runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeLoopDiagnosis(dir, "3"));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose3), evidence: "diagnose 3" }).ok, true);
    const implementation3 = runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeLoopImplementation(dir, "3"));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation3), evidence: "fix 3" }).ok, true);
    verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
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
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });
    let advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "diagnose");

    // Second verify with PASS -> loop complete, advance to summary.
    const diagnose = runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeLoopDiagnosis(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose), evidence: "diagnose 2" }).ok, true);
    const implementation = runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeLoopImplementation(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation), evidence: "fix 2" }).ok, true);
    verify = runSingleStage(root, profile, "verify", ["debug"], (dir) => {
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
    // A completed run is immutable to profile replacement. Exercise the
    // alternate exhaustion policy in its own canonical run instead of
    // overwriting the committed workflow identity.
    const failRoot = mkdtempSync(join(tmpdir(), "loop-failed-exhaustion-"));
    try {
      initGit(failRoot, "feat/loop");
      const verifyF = runSingleStage(failRoot, failP, "verify", ["debug"], (dir) => {
        writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
      });
      const firstFail = advanceCursor(failRoot, { ...advanceAuth(verifyF), evidence: "FAIL" });
      assert.equal(firstFail.ok, true);
      if (!firstFail.ok) return;
      assert.equal(firstFail.state.loop_state?.reentries, 1, "max_iterations=1 allows one re-entry");
      const diagnoseF = runSingleStage(failRoot, failP, "diagnose", ["diagnosis"], (dir) => writeLoopDiagnosis(dir, "2"));
      assert.equal(advanceCursor(failRoot, { ...advanceAuth(diagnoseF), evidence: "d" }).ok, true);
      const implF = runSingleStage(failRoot, failP, "implementation", ["implementation"], (dir) => writeLoopImplementation(dir, "2"));
      assert.equal(advanceCursor(failRoot, { ...advanceAuth(implF), evidence: "i" }).ok, true);
      const verifyF2 = runSingleStage(failRoot, failP, "verify", ["debug"], (dir) => {
        writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 2 }));
      });
      const exhausted = advanceCursor(failRoot, { ...advanceAuth(verifyF2), evidence: "FAIL 2" });
      assert.equal(exhausted.ok, true);
      if (!exhausted.ok) return;
      assert.equal(exhausted.state.pause.kind, "failed", "on_exhausted=failed maps to a failed pause");
      assert.equal(exhausted.state.loop_state?.outcome, "failed");
    } finally {
      rmSync(failRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint: interpreter never auto-records from routing autonomy; unresolved consent pauses", async () => {
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
      checkpoint_policy: {
        default: "required_human",
        scope: "decision",
        hard_human: [],
        rules: {
          approve_diagnosis: {
            kind: "clarification",
            default: "required_human",
            allowed_decisions: ["proceed", "reject"],
            phase: "before_advance",
            rationale: "diagnosis consent must remain explicit in interpreter mode",
          },
        },
        source: "profile",
        policy_version: 1,
        rationale: "interpreter checkpoint regression policy",
      },
      stages: LOOP_PROFILE.stages.map((s) => s.id === "diagnose" ? { ...s, checkpoint: "approve_diagnosis" } : s),
    };
    registerWorkflowProfiles([checkpointProfile]);

    const interactive: TaskCaller = {
      async call(args) {
        const stageId = args.task.match(/## Stage: ([^ ]+)/)?.[1] ?? "?";
        return { id: stageId, output: "ok", artifacts: stageId === "diagnose" ? { diagnosis: JSON.stringify({ root_cause: "c", explanation: "e" }) } : {}, exitCode: 0 };
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
      execution: { session_id: "scope-interactive", caller: "host", process_id: process.pid, worktree: root, branch, authority: "coordinator" },
    });
    assert.ok(
      interactiveResult.outcomes.some((o) => o.status === "failed"),
      "interactive unresolved checkpoint blocks advance",
    );
    const interactiveState = JSON.parse(readFileSync(interactiveResult.statePath!, "utf8")) as TeamState;
    assert.equal(interactiveState.pause.kind, "user_checkpoint", `interpreter outcomes: ${JSON.stringify(interactiveResult.outcomes)}`);
    assert.equal(interactiveState.typed_checkpoint_decisions?.length ?? 0, 0);
    assert.equal(interactiveState.checkpoint_decisions?.length ?? 0, 0);

    // Routing autonomy is not authorization: no auto decision is recorded and
    // no later stage runs until a trusted typed decision is supplied.
    const root2 = mkdtempSync(join(tmpdir(), "ck-interp-auto-"));
    try {
      initGit(root2, branch);
      let verifyRuns = 0;
      const autonomous: TaskCaller = {
        async call(args) {
          const stageId = args.task.match(/## Stage: ([^ ]+)/)?.[1] ?? "?";
          if (stageId === "diagnose") return { id: "d", output: "ok", artifacts: { diagnosis: JSON.stringify({ root_cause: "c", explanation: "e" }) }, exitCode: 0 };
          if (stageId === "implementation") return { id: "i", output: "ok", artifacts: { implementation: JSON.stringify({ files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" }) }, exitCode: 0 };
          if (stageId === "verify") {
            verifyRuns += 1;
            return { id: "v", output: "ok", artifacts: { debug: JSON.stringify({ verdict: verifyRuns === 1 ? "FAIL" : "PASS", iterations: verifyRuns }) }, exitCode: 0 };
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
        execution: { session_id: "scope-autonomous", caller: "host", process_id: process.pid, worktree: root2, branch, authority: "coordinator" },
      });
      assert.equal(autoResult.outcomes.some((o) => o.status === "failed"), true, "routing autonomy cannot auto-proceed");
      const state = JSON.parse(readFileSync(autoResult.statePath!, "utf8")) as TeamState;
      assert.equal(state.pause.kind, "user_checkpoint");
      assert.equal(state.typed_checkpoint_decisions?.length ?? 0, 0);
      assert.equal(state.checkpoint_decisions?.length ?? 0, 0);
      assert.equal(state.stages.find((s) => s.id === "implementation")?.status, "pending");
      assert.equal(verifyRuns, 0);
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
      execution: { session_id: "scope-all-types-interactive", caller: "host", process_id: process.pid, worktree: root, branch, authority: "coordinator" },
    });
    assert.ok(
      interactiveResult.outcomes.some((o) => o.status === "failed" && /checkpoint 'confirm_understanding' for stage 'discovery' is unresolved/.test(o.note)),
      "interactive orchestrator checkpoint blocks advance",
    );
    const interactiveState = JSON.parse(readFileSync(interactiveResult.statePath!, "utf8")) as TeamState;
    assert.equal(interactiveState.pause.kind, "user_checkpoint");
    assert.equal(interactiveState.stages.find((s) => s.id === "discovery")?.status, "in_progress");
    assert.equal(interactiveState.stages.find((s) => s.id === "hooks")?.status, "pending", "later stages never run while the checkpoint is unresolved");
    assert.equal(interactiveState.stages.find((s) => s.id === "noop")?.status, "pending");

    // Routing autonomy still cannot authorize the orchestrator checkpoint:
    // every later stage remains pending until a trusted typed decision arrives.
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
        execution: { session_id: "scope-all-types-autonomous", caller: "host", process_id: process.pid, worktree: root2, branch, authority: "coordinator" },
      });
      assert.equal(autoResult.outcomes.some((o) => o.status === "failed"), true, "autonomous routing cannot auto-proceed");
      const autoState = JSON.parse(readFileSync(autoResult.statePath!, "utf8")) as TeamState;
      assert.equal(autoState.pause.kind, "user_checkpoint");
      assert.equal(autoState.typed_checkpoint_decisions?.length ?? 0, 0);
      assert.equal(autoState.checkpoint_decisions?.length ?? 0, 0);
      assert.equal(autoState.stages.find((s) => s.id === "discovery")?.status, "in_progress");
      assert.equal(autoState.stages.find((s) => s.id === "hooks")?.status, "pending");
      assert.equal(autoState.stages.find((s) => s.id === "noop")?.status, "pending");
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
