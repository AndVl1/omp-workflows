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
import { beginCapability, authorizeDispatch as rawAuthorizeDispatch, advanceCursor as rawAdvanceCursor, recordCheckpointDecision as rawRecordCheckpointDecision, type IssuedCapability } from "../src/engine/durable.js";
import { appendCheckpointDecision, checkpointAnswerBinding, checkpointPolicyHash, recordTrustedCheckpointAnswer, validateCheckpointDecision } from "../src/engine/checkpoints.js";

import { runTarget } from "../src/engine/run-store.js";
import { run } from "../src/engine/run.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TaskCaller } from "../src/engine/stage.js";
import { createCoreFixture, createInterpreterTaskCaller, details, requireTool, submission, type Harness, type Handoff } from "./reliable-stage-execution-fixture.js";

const NO_SCOPE: ScopeFlags = { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null };
function classification(workflow: string, autonomous: boolean): TeamState["classification"] {
  return { type: "FEATURE", complexity: workflow === "lightweight" ? "QUICK" : "MEDIUM", confidence: "HIGH", autonomous, workflow: workflow as TeamState["classification"]["workflow"] };
}
const RUN_ID = "77777777-7777-4777-8777-777777777777";

function authorizeDispatch(root: string, input: Parameters<typeof rawAuthorizeDispatch>[1]) {
  return rawAuthorizeDispatch(root, { ...input, run_id: RUN_ID });
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
): { issued: IssuedCapability; artifactsDir: string; handoff: Handoff } {
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
    const stageIndex = profile.stages.findIndex((stage) => stage.id === stageId);
    assert.ok(stageIndex >= 0, `profile must define ${stageId}`);
    writeFileSync(statePath, JSON.stringify({
      schema: 2, run_id: RUN_ID, run_key: RUN_ID, lifecycle_status: "active", rework_generation: 0,
      branch, title: "loop test", classification: classification(profile.name, false), task: "loop test",
      workflow_override: true, issue: null, required_inputs: {}, required_input_receipts: {},
      stage_cursor: stageId,
      stages: profile.stages.map((s, index) => ({
        id: s.id,
        status: index === stageIndex ? "in_progress" as const : index < stageIndex ? "skipped" as const : "pending" as const,
      })),
      artifacts: {}, pause: { kind: "none", reason: "" }, policy: { strict_orchestrator: true },
      scope: { ...NO_SCOPE, dev_agent: "developer-kotlin" },
      profile_hash: persistedHash,
      ...(profile.checkpoint_policy ? { checkpoint_policy: profile.checkpoint_policy } : {}),
      updated_at: new Date().toISOString(),
    }) + "\n");
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
  return { issued, artifactsDir: join(root, ".work-state", "runs", RUN_ID, "artifacts"), handoff: begun.handoff };
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

function writeCanonicalState(root: string, state: TeamState): void {
  const persisted = { ...state, state_revision: state.state_revision ?? 1 };
  writeFileSync(runTarget(root, RUN_ID).statePath!, `${JSON.stringify(persisted, null, 2)}\n`);
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
  writeCanonicalState(root, trusted.state);
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
  writeCanonicalState(root, appended.state);
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

function interpreterHarness(root: string, branch: string, sessionId: string, profile: Profile): Harness {
  return createCoreFixture({
    root,
    branch,
    sessionId,
    workflowProfiles: [profile],
    roles: {
      diagnostics: "diagnostics",
      dev: "dev",
      "manual-qa": "manual-qa",
      developer: "developer",
    },
  });
}

async function submitInterpreterOutput(
  harness: Harness,
  worker: { toolCallId: string; childContext: unknown },
  id: string,
  outputs: Record<string, unknown>,
): Promise<void> {
  const submitted = details((await requireTool(harness, "workflow_submit_result").execute(
    id,
    submission(outputs),
    undefined,
    undefined,
    worker.childContext,
  )).details);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
}

function interpreterTaskCaller(
  harness: Harness,
  produce: (stageId: string) => Record<string, unknown>,
): TaskCaller {
  return createInterpreterTaskCaller(harness, async (worker, request) => {
    const stageId = request.task.match(/## Stage: ([^ ]+)/)?.[1] ?? "?";
    const outputs = produce(stageId);
    if (Object.keys(outputs).length > 0) {
      await submitInterpreterOutput(
        harness,
        worker,
        `scope-submit-${worker.toolCallId}-${request.name ?? "task"}`,
        outputs,
      );
    }
    return {
      id: request.name ?? worker.toolCallId,
      output: "ok",
      exitCode: 0,
    };
  });
}

async function submitRegisteredStageResult(
  root: string,
  branch: string,
  profile: Profile,
  stageId: string,
  issued: IssuedCapability,
  handoff: Handoff,
  outputs: Record<string, unknown>,
): Promise<void> {
  const role = stageId === "diagnose" ? "diagnostics" : stageId === "implementation" ? "dev" : "manual-qa";
  const harness = createCoreFixture({
    root,
    branch,
    sessionId: `scope-registered-${stageId}`,
    workflowProfiles: [profile],
    roles: { diagnostics: "diagnostics", dev: "dev", "manual-qa": "manual-qa", developer: "developer" },
  });
  try {
    await harness.emit("session_start", { type: "session_start" }, harness.context);
    const rebound = harness.controller.prepare({ mode: "resume", run_id: RUN_ID });
    assert.equal(rebound.state.run_id, RUN_ID);
    const assignment = handoff.expected_roster.find((entry) => entry.role === role) ?? handoff.expected_roster[0];
    const marker = handoff.dispatch_markers.find((entry) => entry.role === role) ?? handoff.dispatch_markers[0];
    assert.ok(assignment && marker, `stage ${stageId} must expose a worker assignment`);
    const toolCallId = `scope-registered-${stageId}-${issued.state.issued_for!.cursor_epoch}`;
    const auth = authOf(issued, assignment.role, assignment.agent);
    const authorized = authorizeDispatch(root, {
      ...auth,
      tool_call_id: toolCallId,
      origin_session_id: harness.context.session_id,
    });
    assert.equal(authorized.ok, true, `authorize ${stageId}`);
    if (!authorized.ok) throw new Error(`authorize failed: ${authorized.error}`);
    const task = createInterpreterTaskCaller(harness, async (worker, request) => {
      const submitted = details((await requireTool(harness, "workflow_submit_result").execute(
        `scope-registered-submit-${toolCallId}`,
        submission(outputs),
        undefined,
        undefined,
        worker.childContext,
      )).details);
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      return { id: request.name ?? worker.toolCallId, output: `${stageId} done`, exitCode: 0 };
    });
    await task.call(
      { agent: assignment.agent, task: marker.marker, name: `${stageId}-${assignment.role}` },
      { toolCallId },
    );
    const persisted = readState(root);
    const dispatch = persisted.dispatch_capability?.dispatches.find((entry) => entry.tool_call_id === toolCallId);
    assert.ok(dispatch && persisted.stage_receipts?.[dispatch.id], `stage ${stageId} must persist a registered receipt`);
  } finally {
    await harness.close();
  }
}

async function runSingleStage(
  root: string,
  profile: Profile,
  stageId: string,
  artifactIds: string[],
  writeArtifacts: (artifactsDir: string) => void,
): Promise<IssuedCapability> {
  const setup = setupStage(root, "feat/loop", profile, stageId);
  writeArtifacts(setup.artifactsDir);
  const outputs = Object.fromEntries(artifactIds.map((artifactId) => [
    artifactId,
    JSON.parse(readFileSync(join(setup.artifactsDir, `${artifactId}.json`), "utf8")) as unknown,
  ]));
  await submitRegisteredStageResult(root, "feat/loop", profile, stageId, setup.issued, setup.handoff, outputs);
  return setup.issued;
}

test("checkpoint: unresolved declared checkpoint blocks advance; an explicit typed decision unblocks", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-block-"));
  try {
    initGit(root, "feat/ck");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const { issued, artifactsDir, handoff } = setupStage(root, "feat/ck", profile, "implementation");
    const implementation = { files_touched: ["checkpoint-fixture"], ready: true, validation_run: true, validation_evidence: "checkpoint fixture" };
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify(implementation));
    await submitRegisteredStageResult(root, "feat/ck", profile, "implementation", issued, handoff, { implementation });

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


test("checkpoint: routing autonomy stays orthogonal to profile consent; migration conflicts fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-policy-orthogonal-"));
  try {
    initGit(root, "feat/ck-policy");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const { issued, artifactsDir, handoff } = setupStage(root, "feat/ck-policy", profile, "implementation");
    const implementation = { ready: true, validation_run: true, validation_evidence: "evidence", files_touched: ["x"] };
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify(implementation));
    await submitRegisteredStageResult(root, "feat/ck-policy", profile, "implementation", issued, handoff, { implementation });
    const profileState = readState(root);
    assert.equal(profileState.checkpoint_policy?.source, "profile");
    writeCanonicalState(root, { ...profileState, classification: { ...profileState.classification, autonomous: true } });
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
    writeCanonicalState(root, firstAppend.state);
    const secondAppend = appendCheckpointDecision(readState(root), typed);
    assert.equal(secondAppend.ok, true);
    writeCanonicalState(root, secondAppend.state);
    const replay = appendCheckpointDecision(readState(root), typed);
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent, true, "identical typed decision is idempotent");
    writeCanonicalState(root, replay.state);
    const decisions = readState(root);
    assert.equal(decisions.typed_checkpoint_decisions?.length, 1, "identical typed decision is idempotent");
    assert.equal(decisions.checkpoint_decisions?.length, 1, "typed mirror remains singular");
    const conflictingTyped = typedCheckpoint(root, "implementation", "approve_implementation", "proceed", "/conflict");
    const conflicting = appendCheckpointDecision(readState(root), { ...conflictingTyped, rationale: "conflicting answer" });
    assert.equal(conflicting.ok, false, "a separately proven second answer cannot replace an existing checkpoint decision");
    if (!conflicting.ok) assert.equal(conflicting.code, "decision_conflict");
    const wrongName = recordCheckpointDecision(root, { ...advanceAuth(issued), checkpoint: "bogus", mode: "interactive", decision: "x", actor: "user", rationale: "r" });
    assert.equal(wrongName.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("loop: FAIL until re-enters back_to with a fresh capability and durable history; stale epoch cannot authorize", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-reenter-"));
  try {
    initGit(root, "feat/loop");
    registerWorkflowProfiles([LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);

    const verify = await runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });
    const staleVerifyAdvanceAuth = Object.freeze(advanceAuth(verify));
    const staleVerifyDispatchAuth = Object.freeze({
      ...authOf(verify, "manual-qa", "manual-qa"),
      tool_call_id: "stale-verify-dispatch",
    });

    const advanced = advanceCursor(root, { ...staleVerifyAdvanceAuth, evidence: "verify FAIL" });
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
    const diagnose2 = await runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeLoopDiagnosis(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose2), evidence: "diagnose 2" }).ok, true);
    const implementation2 = await runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeLoopImplementation(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation2), evidence: "implementation 2" }).ok, true);
    const canonicalPath = runTarget(root, RUN_ID).statePath!;
    const beforeStaleDispatch = readFileSync(canonicalPath, "utf8");
    const staleDispatch = authorizeDispatch(root, staleVerifyDispatchAuth);
    assert.equal(staleDispatch.ok, false, "the old verify handoff cannot authorize a new dispatch after re-entry");
    assert.equal(readFileSync(canonicalPath, "utf8"), beforeStaleDispatch, "rejected stale dispatch leaves canonical state unchanged");

    writeFileSync(join(root, ".work-state", "runs", RUN_ID, "artifacts", "external.json"), JSON.stringify({ source: "tampered external input", version: 2 }));
    const blockedExternal = beginCapability(root, undefined, { runId: RUN_ID });
    assert.equal(blockedExternal.ok, false, "tampered unaffected external input blocks next loop admission");

    // The exact old advance is an idempotent read-only replay; it must not
    // mutate the current iteration or make stale authority effective.
    const beforeReplay = readFileSync(canonicalPath, "utf8");
    const staleReplay = advanceCursor(root, { ...staleVerifyAdvanceAuth, evidence: "stale" });
    assert.equal(staleReplay.ok, true, "the old exact advance may replay idempotently");
    if (staleReplay.ok) assert.equal(staleReplay.replayed, true, "old exact advance is classified as replay");
    assert.equal(readFileSync(canonicalPath, "utf8"), beforeReplay, "old exact advance replay leaves canonical state unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop: full debug cycle re-enters once, then exhausts to needs_human", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-exhaust-"));
  try {
    initGit(root, "feat/loop");
    registerWorkflowProfiles([LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);

    // Iteration 1: verify FAIL -> re-enter diagnose (reentries 1).
    let verify = await runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });
    let advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL 1" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;

    // Iteration 2: diagnose -> implementation -> verify FAIL -> exhausts.
    const diagnose = await runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeLoopDiagnosis(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose), evidence: "diagnose 2" }).ok, true);
    const implementation = await runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeLoopImplementation(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation), evidence: "fix 2" }).ok, true);
    verify = await runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 2 }));
    });
    advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL 2" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.loop_state?.reentries, 1, "max_iterations counts total executions");

    assert.equal(advanced.state.loop_state?.status, "exhausted");
    assert.equal(advanced.state.loop_state?.outcome, "needs_human", "escalate_user maps to needs_human");
    assert.equal(advanced.state.pause.kind, "needs_human");
    assert.equal(advanced.state.dispatch_capability?.status, "complete", "no ready capability after exhaustion");
    assert.equal(advanced.state.stage_cursor, "verify");
    assert.equal(advanced.handoff, undefined, "no handoff after exhaustion");
    assert.equal(advanced.state.loop_state?.history.length, 1, "durable iteration history preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop: until PASS exits the loop and advances normally; on_exhausted failed maps to failed pause", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-pass-"));
  try {
    initGit(root, "feat/loop");
    registerWorkflowProfiles([LOOP_PROFILE]);
    const profile = loadProfile("loop-regression");
    assert.ok(profile);

    // First FAIL -> re-enter.
    let verify = await runSingleStage(root, profile, "verify", ["debug"], (dir) => {
      writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
    });
    let advanced = advanceCursor(root, { ...advanceAuth(verify), evidence: "FAIL" });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    assert.equal(advanced.state.stage_cursor, "diagnose");

    // Second verify with PASS -> loop complete, advance to summary.
    const diagnose = await runSingleStage(root, profile, "diagnose", ["diagnosis"], (dir) => writeLoopDiagnosis(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(diagnose), evidence: "diagnose 2" }).ok, true);
    const implementation = await runSingleStage(root, profile, "implementation", ["implementation"], (dir) => writeLoopImplementation(dir, "2"));
    assert.equal(advanceCursor(root, { ...advanceAuth(implementation), evidence: "fix 2" }).ok, true);
    verify = await runSingleStage(root, profile, "verify", ["debug"], (dir) => {
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
      const verifyF = await runSingleStage(failRoot, failP, "verify", ["debug"], (dir) => {
        writeFileSync(join(dir, "debug.json"), JSON.stringify({ verdict: "FAIL", iterations: 1 }));
      });
      const firstFail = advanceCursor(failRoot, { ...advanceAuth(verifyF), evidence: "FAIL" });
      assert.equal(firstFail.ok, true);
      if (!firstFail.ok) return;
      assert.equal(firstFail.state.loop_state?.reentries, 0, "max_iterations=1 allows no re-entry");
      assert.equal(firstFail.state.loop_state?.status, "exhausted");
      assert.equal(firstFail.state.pause.kind, "failed", "on_exhausted=failed maps to a failed pause");
      assert.equal(firstFail.state.loop_state?.outcome, "failed");
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
  let interactiveHarness: Harness | undefined;
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

    interactiveHarness = interpreterHarness(root, branch, "scope-interactive", checkpointProfile);
    await interactiveHarness.emit("session_start", { type: "session_start" }, interactiveHarness.context);
    const interactive = interpreterTaskCaller(interactiveHarness, (stageId) => {
      if (stageId === "diagnose") return { diagnosis: { root_cause: "c", explanation: "e" } };
      if (stageId === "implementation") return { implementation: { files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" } };
      if (stageId === "verify") return { debug: { verdict: "PASS", iterations: 1 } };
      return {};
    });
    const interactiveClassification = { type: "OPS" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: false, workflow: "interp-checkpoint" as const };
    const interactivePrepared = interactiveHarness.controller.prepare({
      mode: "new",
      task: "interactive checkpoint",
      classification: interactiveClassification,
    });
    const interactiveResult = await run({
      task: "interactive checkpoint",
      cwd: root,
      branch,
      autonomous: false,
      mode: "resume",
      run_id: interactivePrepared.state.run_id,
      request_id: "scope-interactive-run",
      classification: interactiveClassification,
      taskTool: interactive,
      execution: interactiveHarness.controller.context(),
      sessionController: interactiveHarness.controller,
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
    let autonomousHarness: Harness | undefined;
    try {
      initGit(root2, branch);
      let verifyRuns = 0;
      autonomousHarness = interpreterHarness(root2, branch, "scope-autonomous", checkpointProfile);
      await autonomousHarness.emit("session_start", { type: "session_start" }, autonomousHarness.context);
      const autonomous = interpreterTaskCaller(autonomousHarness, (stageId) => {
        if (stageId === "diagnose") return { diagnosis: { root_cause: "c", explanation: "e" } };
        if (stageId === "implementation") return { implementation: { files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "evidence" } };
        if (stageId === "verify") {
          verifyRuns += 1;
          return { debug: { verdict: verifyRuns === 1 ? "FAIL" : "PASS", iterations: verifyRuns } };
        }
        return {};
      });
      const autonomousClassification = { type: "OPS" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const, autonomous: true, workflow: "interp-checkpoint" as const };
      const autonomousPrepared = autonomousHarness.controller.prepare({
        mode: "new",
        task: "autonomous checkpoint",
        classification: autonomousClassification,
      });
      const autoResult = await run({
        task: "autonomous checkpoint",
        cwd: root2,
        branch,
        autonomous: true,
        mode: "resume",
        run_id: autonomousPrepared.state.run_id,
        request_id: "scope-autonomous-run",
        classification: autonomousClassification,
        taskTool: autonomous,
        execution: autonomousHarness.controller.context(),
        sessionController: autonomousHarness.controller,
      });
      assert.equal(autoResult.outcomes.some((o) => o.status === "failed"), true, "routing autonomy cannot auto-proceed");
      const state = JSON.parse(readFileSync(autoResult.statePath!, "utf8")) as TeamState;
      assert.equal(state.pause.kind, "user_checkpoint");
      assert.equal(state.typed_checkpoint_decisions?.length ?? 0, 0);
      assert.equal(state.checkpoint_decisions?.length ?? 0, 0);
      assert.equal(state.stages.find((s) => s.id === "implementation")?.status, "pending");
      assert.equal(verifyRuns, 0);
    } finally {
      await autonomousHarness?.close();
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    await interactiveHarness?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint: interpreter enforces declared checkpoints on orchestrator/bash/none stages", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-interp-alltypes-"));
  const branch = "feat/interp-all";
  let interactiveHarness: Harness | undefined;
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
    const baseClassification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const };
    interactiveHarness = interpreterHarness(root, branch, "scope-all-types-interactive", allTypesProfile);
    await interactiveHarness.emit("session_start", { type: "session_start" }, interactiveHarness.context);
    const taskTool = interpreterTaskCaller(interactiveHarness, () => ({}));
    const orchestrate = () => ({ outputs: {} });
    const interactiveClassification = { ...baseClassification, autonomous: false as const, workflow: "interp-checkpoint-all-types" as const };
    const interactivePrepared = interactiveHarness.controller.prepare({
      mode: "new",
      task: "interactive all-types",
      classification: interactiveClassification,
    });
    // Interactive: the orchestrator's declared checkpoint blocks advance and
    // no later stage can run while it is unresolved.
    const interactiveResult = await run({
      task: "interactive all-types",
      cwd: root,
      branch,
      autonomous: false,
      mode: "resume",
      run_id: interactivePrepared.state.run_id,
      request_id: "scope-all-types-interactive-run",
      classification: interactiveClassification,
      taskTool,
      orchestrate,
      execution: interactiveHarness.controller.context(),
      sessionController: interactiveHarness.controller,
    });
    assert.equal(
      interactiveResult.outcomes.some((o) => o.status === "failed"),
      true,
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
    let autoHarness: Harness | undefined;
    try {
      initGit(root2, branch);
      autoHarness = interpreterHarness(root2, branch, "scope-all-types-autonomous", allTypesProfile);
      await autoHarness.emit("session_start", { type: "session_start" }, autoHarness.context);
      const autoTaskTool = interpreterTaskCaller(autoHarness, () => ({}));
      const autoClassification = { ...baseClassification, autonomous: true as const, workflow: "interp-checkpoint-all-types" as const };
      const autoPrepared = autoHarness.controller.prepare({
        mode: "new",
        task: "autonomous all-types",
        classification: autoClassification,
      });
      const autoResult = await run({
        task: "autonomous all-types",
        cwd: root2,
        branch,
        autonomous: true,
        mode: "resume",
        run_id: autoPrepared.state.run_id,
        request_id: "scope-all-types-autonomous-run",
        classification: autoClassification,
        taskTool: autoTaskTool,
        orchestrate,
        execution: autoHarness.controller.context(),
        sessionController: autoHarness.controller,
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
      await autoHarness?.close();
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    await interactiveHarness?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
