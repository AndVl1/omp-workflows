/**
 * Focused regressions for the durable checkpoint-ledger correction (br-zps):
 *
 *   - a superseded proof NEVER authorizes; a finalized proof authorizes only
 *     the exact immutable decision it was consumed for;
 *   - an exact `workflow_checkpoint` retry is idempotent: the regenerated
 *     `decided_at` is not a conflict, the first record's timestamp is kept
 *     and the state revision does not move on an unchanged replay;
 *   - a debug-cycle shaped loop scopes decisions to the active capability
 *     epoch AND loop iteration: a prior iteration's approve_fix can neither
 *     satisfy nor deadlock the re-entered implementation stage, a second
 *     approve_fix records cleanly, and both records remain as audit history;
 *   - the CURRENT stage's declaration is authoritative: a prior stage's
 *     decision for the same checkpoint id neither authorizes nor blocks the
 *     next stage, and policy_auto cannot exploit a stale policy;
 *   - one live trusted answer per (run, stage, checkpoint) across terminal
 *     and escalation channels, with safe supersession via
 *     `commitCheckpointAnswer`;
 *   - a top-level `work_identity` from a prior stage is cleared on stage
 *     transition and can never silently bind a new proof.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapability, authorizeDispatch, completeDispatch, advanceCursor, recordCheckpointDecision, commitCheckpointAnswer, type CapabilityHandoff, type IssuedCapability } from "../src/engine/durable.js";
import {
  appendCheckpointDecision,
  checkpointDecisionKey,
  checkpointPolicyHash,
  findHistoricalCheckpointDecision,
  recordTrustedCheckpointAnswer,
  resolveCheckpointDeclaration,
  validateCheckpointDecision,
} from "../src/engine/checkpoints.js";
import { validateActiveCapabilityStateBinding } from "../src/engine/control-plane-contract.js";
import { registerWorkflowProfiles, loadProfile, profileHash } from "../src/engine/profile.js";
import { normalizePersistedState, writeStateBootstrap } from "../src/engine/state.js";
import type { CheckpointPolicy, Profile, TeamState } from "../src/engine/types.js";

function initGit(root: string, branch: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", branch], { stdio: "ignore" });
}

function approvalPolicy(decisions: string[], defaultRule: CheckpointPolicy["default"]): CheckpointPolicy {
  return {
    default: "required_human",
    scope: "decision",
    hard_human: [],
    rules: {
      approve_fix: {
        kind: "implementation_approval",
        default: defaultRule,
        allowed_decisions: decisions,
        phase: "before_advance",
        rationale: "test policy",
      },
    },
    source: "profile",
    policy_version: 1,
    rationale: "test policy",
  };
}

function debugCycleProfile(policy: CheckpointPolicy): Profile {
  return {
    name: "ledger-debug-cycle",
    title: "Ledger debug cycle",
    description: "diagnose -> implementation (checkpoint) -> verify loops back to diagnose",
    match: { type: ["OPS"] },
    stages: [
      { id: "diagnose", title: "Diagnose", type: "single", role: "diagnostics", produces: "diagnosis" },
      { id: "implementation", title: "Fix", type: "single", role: "dev", produces: "implementation", checkpoint: "approve_fix", checkpoint_policy: policy },
      {
        id: "verify",
        title: "Verify",
        type: "single",
        role: "qa",
        consumes: ["diagnosis", "implementation"],
        produces: "debug",
        loop: { back_to: "diagnose", until: "verdict == PASS", max_iterations: 2, on_exhausted: "escalate_user" },
      },
    ],
  };
}

function scopeFlags() {
  return { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "dev" };
}

function readState(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "features", "ledger", "state.json"), "utf8")) as TeamState;
}

function writeArtifacts(root: string, artifacts: Record<string, unknown>): void {
  const artifactsDir = join(root, ".work-state", "features", "ledger", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (const [id, value] of Object.entries(artifacts)) writeFileSync(join(artifactsDir, `${id}.json`), JSON.stringify(value));
}

/** Arm a stage with a fresh capability and run its single dispatch to completion. */
function runStage(root: string, profile: Profile, stageId: string, role: string, artifactIds: string[], artifacts: Record<string, unknown>, stageStatuses?: TeamState["stages"]): IssuedCapability {
  const issued = createCapability({
    run_key: "main",
    branch: "main",
    workflow: profile.name,
    profile_hash: profileHash(profile),
    stage_cursor: stageId,
    kind: "single",
    expected_roster: [{ role, agent: role }],
  });
  let previous: TeamState = { stages: [] } as unknown as TeamState;
  try {
    previous = readState(root);
  } catch {
    // first stage setup: no state yet
  }
  writeStateBootstrap(root, {
    schema: 1,
    branch: "main",
    run_key: "main",
    classification: { type: "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: profile.name },
    task: "checkpoint ledger scopes",
    workflow_override: false,
    issue: null,
    stage_cursor: stageId,
    stages: stageStatuses ?? profile.stages.map((stage) => ({ id: stage.id, status: stage.id === stageId ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(profile),
    scope: scopeFlags(),
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    ...(previous.loop_state ? { loop_state: previous.loop_state } : {}),
    ...(previous.typed_checkpoint_decisions ? { typed_checkpoint_decisions: previous.typed_checkpoint_decisions } : {}),
    ...(previous.checkpoint_decisions ? { checkpoint_decisions: previous.checkpoint_decisions } : {}),
    ...(previous.trusted_checkpoint_answers ? { trusted_checkpoint_answers: previous.trusted_checkpoint_answers } : {}),
    ...(previous.checkpoint_policy ? { checkpoint_policy: previous.checkpoint_policy } : {}),
    updated_at: new Date().toISOString(),
  }, { featureSlug: "ledger" });
  writeArtifacts(root, artifacts);
  const authorized = authorizeDispatch(root, dispatchAuthOf(issued, role));
  assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
  if (!authorized.ok) throw new Error("authorize failed");
  const completed = completeDispatch(root, { ...dispatchAuthOf(issued, role), dispatch_id: authorized.record!.id, outcome: "succeeded", evidence: "done", artifact_ids: artifactIds });
  assert.equal(completed.ok, true, completed.ok ? "completed" : completed.error);
  if (!completed.ok) throw new Error("complete failed");
  return issued;
}

function dispatchAuthOf(issued: IssuedCapability, role: string) {
  return {
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: "main",
    branch: "main",
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: issued.state.issued_for!.loop_iteration,
    role,
    agent: role,
  };
}

function advanceAuthOf(issued: IssuedCapability) {
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: "main",
    branch: "main",
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: issued.state.issued_for!.loop_iteration,
  };
}

/** Advance auth + dispatch auth derived from the handoff of an ARMED stage. */
function handoffAuths(handoff: CapabilityHandoff) {
  const base = {
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: handoff.branch,
    workflow: handoff.workflow,
    profile_hash: handoff.profile_hash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    loop_iteration: handoff.loop_iteration,
  };
  return {
    advance: { ...base, token: handoff.advance_token },
    dispatch: (role: string) => ({ ...base, token: handoff.dispatch_token, role, agent: role }),
  };
}

/** Complete the currently armed stage's single dispatch using the handoff secrets. */
function completeArmed(root: string, handoff: CapabilityHandoff, role: string, artifactIds: string[], artifacts: Record<string, unknown>): void {
  writeArtifacts(root, artifacts);
  const authorized = authorizeDispatch(root, handoffAuths(handoff).dispatch(role));
  assert.equal(authorized.ok, true, authorized.ok ? "armed dispatch authorized" : authorized.error);
  if (!authorized.ok) throw new Error("armed authorize failed");
  const completed = completeDispatch(root, { ...handoffAuths(handoff).dispatch(role), dispatch_id: authorized.record!.id, outcome: "succeeded", evidence: "done", artifact_ids: artifactIds });
  assert.equal(completed.ok, true, completed.ok ? "armed dispatch completed" : completed.error);
  if (!completed.ok) throw new Error("armed complete failed");
}

/** Record a human checkpoint decision bound to the CURRENT state scope. */
function recordHumanDecision(root: string, handoff: CapabilityHandoff, stageId: string, checkpointId: string, decision: string, rationale = "explicit answer"): void {
  recordDecisionFor(root, handoffAuths(handoff).advance, stageId, checkpointId, decision, rationale);
}

function recordDecisionFor(
  root: string,
  auth: Record<string, unknown>,
  stageId: string,
  checkpointId: string,
  decision: string,
  rationale = "explicit answer",
): void {
  const state = readState(root);
  const policy = state.checkpoint_policy;
  assert.ok(policy, "state must carry a policy projection");
  assert.ok(policy.rules[checkpointId], `policy must define ${checkpointId}`);
  const trusted = recordTrustedCheckpointAnswer(state, {
    answer_id: `ledger/${stageId}/${checkpointId}/${decision}/${rationale}`,
    channel: "terminal",
    reference: `terminal-answer/ledger/${stageId}/${checkpointId}/${decision}/${rationale}`,
    stage_id: stageId,
    checkpoint_id: checkpointId,
    decision,
  });
  // The trusted ask path persists the minted answer BEFORE the decision is
  // recorded (two durable calls): mirror that here, or the record
  // transaction's fresh re-read sees a proof with no ledger answer.
  writeStateBootstrap(root, trusted.state, { featureSlug: "ledger" });
  const recorded = recordCheckpointDecision(root, {
    ...auth,
    checkpoint: checkpointId,
    checkpoint_id: checkpointId,
    checkpoint_kind: policy.rules[checkpointId]!.kind,
    decision,
    authorization: "human",
    actor_provenance: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
    rationale,
  });
  assert.equal(recorded.ok, true, recorded.ok ? "recorded" : `record failed: ${recorded.error}`);
}

test("ledger: a superseded proof never authorizes; the exact finalized decision replays idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-supersede-"));
  try {
    initGit(root, "main");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: "lightweight", profile_hash: profileHash(profile),
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
    });
    writeStateBootstrap(root, {
      schema: 1,
      branch: "main",
      run_key: "main",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "superseded proof",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      scope: scopeFlags(),
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "ledger" });
    const state = readState(root);

    const first = recordTrustedCheckpointAnswer(state, {
      answer_id: "ledger/proof-1",
      channel: "terminal",
      reference: "terminal-answer/ledger/proof-1",
      stage_id: "implementation",
      checkpoint_id: "approve_implementation",
      decision: "proceed",
    });
    const second = recordTrustedCheckpointAnswer(first.state, {
      answer_id: "ledger/proof-2",
      channel: "terminal",
      reference: "terminal-answer/ledger/proof-2",
      stage_id: "implementation",
      checkpoint_id: "approve_implementation",
      decision: "reject",
    });
    // Supersession marks the earlier proof consumed with reason "superseded".
    // Persist SECOND.state so proof-2 exists on the ledger; the explicit map
    // keeps proof-1 marked superseded.
    const supersededState: TeamState = {
      ...second.state,
      trusted_checkpoint_answers: (second.state.trusted_checkpoint_answers ?? []).map((answer) =>
        answer.answer_id === "ledger/proof-1"
          ? { ...answer, consumed_at: new Date().toISOString(), consumed_reason: "superseded" as const }
          : answer,
      ),
    };
    writeStateBootstrap(root, supersededState, { featureSlug: "ledger" });
    const policy = readState(root).checkpoint_policy!;
    const stage = { id: "implementation", checkpoint: "approve_implementation" };
    const scopeFields = {
      capability_id: issued.capability_id,
      capability_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      policy_hash: checkpointPolicyHash(policy),
    };

    const withSupersededProof = validateCheckpointDecision(readState(root), {
      run_id: "main",
      stage_id: "implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: policy.rules.approve_implementation!.kind,
      decision: "proceed",
      authorization: "human",
      actor: { kind: "user", ref: "terminal-answer/ledger/proof-1", proof: first.proof },
      ...scopeFields,
      rationale: "stale proof replay",
      decided_at: new Date().toISOString(),
    }, { stage });
    assert.equal(withSupersededProof.ok, false, "superseded proof never authorizes");
    if (!withSupersededProof.ok) assert.equal(withSupersededProof.code, "proof_superseded");

    // The superseding answer authorizes; the append finalizes it.
    const valid = {
      run_id: "main",
      stage_id: "implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: policy.rules.approve_implementation!.kind,
      decision: "reject",
      authorization: "human" as const,
      actor: { kind: "user" as const, ref: second.answer.reference, proof: second.proof },
      ...scopeFields,
      rationale: "final answer",
      decided_at: new Date().toISOString(),
    };
    const appended = appendCheckpointDecision(readState(root), valid);
    assert.equal(appended.ok, true, appended.ok ? "recorded" : `${appended.code}: ${appended.error}`);
    writeStateBootstrap(root, appended.state, { featureSlug: "ledger" });
    const afterRecord = readState(root);
    const finalized = afterRecord.trusted_checkpoint_answers!.find((answer) => answer.answer_id === "ledger/proof-2");
    assert.equal(finalized?.consumed_reason, "finalized");
    assert.ok(finalized?.finalized_decision_key, "finalized answer records its immutable decision key");

    // Exact replay with a regenerated decided_at: idempotent, original
    // timestamp retained, revision untouched.
    const revisionBefore = afterRecord.state_revision;
    const replay = appendCheckpointDecision(afterRecord, { ...valid, decided_at: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent, true, "exact finalized replay is idempotent");
    assert.equal(replay.state, afterRecord, "an unchanged replay does not even mutate the state object");
    const afterReplay = readState(root);
    assert.equal(afterReplay.typed_checkpoint_decisions?.length, 1, "no duplicate typed decision");
    assert.equal(afterReplay.typed_checkpoint_decisions?.[0]?.decided_at, valid.decided_at, "the first record's decided_at is retained");
    assert.equal(afterReplay.state_revision, revisionBefore, "idempotent replay leaves the state revision untouched");

    // A changed rationale changes the immutable key: rejected, no new record.
    const conflicting = appendCheckpointDecision(afterReplay, { ...valid, rationale: "changed my mind" });
    assert.equal(conflicting.ok, false, "a conflicting replay of a consumed proof is rejected");
    if (!conflicting.ok) assert.equal(conflicting.code, "proof_consumed_mismatch");
    assert.equal(readState(root).typed_checkpoint_decisions?.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger: a consumed proof without a provable final decision is treated as superseded", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-orphan-"));
  try {
    initGit(root, "main");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: "lightweight", profile_hash: profileHash(profile),
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
    });
    writeStateBootstrap(root, {
      schema: 1,
      branch: "main",
      run_key: "main",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "orphan proof",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      scope: scopeFlags(),
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "ledger" });
    const state = readState(root);
    const trusted = recordTrustedCheckpointAnswer(state, {
      answer_id: "ledger/orphan",
      channel: "escalation",
      reference: "escalation-answer/ledger/orphan",
      stage_id: "implementation",
      checkpoint_id: "approve_implementation",
      decision: "proceed",
    });
    // Legacy-style consumption: consumed_at with NO reason and NO final record.
    const legacyConsumed: TeamState = {
      ...trusted.state,
      trusted_checkpoint_answers: (trusted.state.trusted_checkpoint_answers ?? []).map((answer) =>
        answer.answer_id === "ledger/orphan" ? { ...answer, consumed_at: new Date().toISOString() } : answer,
      ),
    };
    writeStateBootstrap(root, legacyConsumed, { featureSlug: "ledger" });
    const policy = readState(root).checkpoint_policy!;
    const result = validateCheckpointDecision(readState(root), {
      run_id: "main",
      stage_id: "implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: policy.rules.approve_implementation!.kind,
      decision: "proceed",
      authorization: "human",
      actor: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
      capability_id: issued.capability_id,
      capability_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      policy_hash: checkpointPolicyHash(policy),
      rationale: "orphan proof",
      decided_at: new Date().toISOString(),
    }, { stage: { id: "implementation", checkpoint: "approve_implementation" } });
    assert.equal(result.ok, false, "a consumed proof with no matching final decision cannot authorize");
    if (!result.ok) assert.equal(result.code, "proof_superseded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger: a prior loop iteration's approve_fix neither satisfies nor deadlocks the re-entered implementation", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-loop-"));
  try {
    initGit(root, "main");
    const policy = approvalPolicy(["approve_fix", "reject_fix"], "required_human");
    const profile = debugCycleProfile(policy);
    registerWorkflowProfiles([profile]);

    // Iteration 1: diagnose -> implementation (records approve_fix) -> verify FAIL re-entry.
    const diagnose1 = runStage(root, profile, "diagnose", "diagnostics", ["diagnosis"], { diagnosis: { root_cause: "c1", explanation: "e1" } });
    const toImpl1 = advanceCursor(root, { ...advanceAuthOf(diagnose1), evidence: "diagnosis done" });
    assert.equal(toImpl1.ok, true, toImpl1.ok ? "armed implementation iteration 1" : toImpl1.error);
    if (!toImpl1.ok || !toImpl1.handoff) return;
    assert.equal(toImpl1.handoff.loop_iteration, 1);
    completeArmed(root, toImpl1.handoff, "dev", ["implementation"], { implementation: { files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "e1" } });
    recordHumanDecision(root, toImpl1.handoff, "implementation", "approve_fix", "approve_fix", "iteration 1 answer");
    const toVerify1 = advanceCursor(root, { ...handoffAuths(toImpl1.handoff).advance, evidence: "fix 1 done" });
    assert.equal(toVerify1.ok, true, toVerify1.ok ? "armed verify" : toVerify1.error);
    if (!toVerify1.ok || !toVerify1.handoff) return;
    completeArmed(root, toVerify1.handoff, "qa", ["debug"], { diagnosis: { root_cause: "c1", explanation: "e1" }, implementation: { files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "e1" }, debug: { verdict: "FAIL", iterations: 1 } });
    const reentered = advanceCursor(root, { ...handoffAuths(toVerify1.handoff).advance, evidence: "FAIL" });
    assert.equal(reentered.ok, true, reentered.ok ? "re-entered diagnose" : reentered.error);
    if (!reentered.ok || !reentered.handoff) return;
    assert.equal(reentered.state.loop_state?.reentries, 1, "one loop-back recorded");
    assert.equal(reentered.state.stage_cursor, "diagnose");
    assert.equal(reentered.state.work_identity, undefined, "the prior stage's top-level work identity is cleared on re-entry");
    assert.equal(reentered.handoff.loop_iteration, 2, "the re-entry handoff carries iteration 2");

    // Iteration 2: diagnose -> implementation. The re-armed implementation
    // capability must carry loop_iteration 2 and a fresh epoch.
    completeArmed(root, reentered.handoff, "diagnostics", ["diagnosis"], { diagnosis: { root_cause: "c2", explanation: "e2" } });
    const toImpl2 = advanceCursor(root, { ...handoffAuths(reentered.handoff).advance, evidence: "diagnosis 2" });
    assert.equal(toImpl2.ok, true, toImpl2.ok ? "re-armed implementation" : toImpl2.error);
    if (!toImpl2.ok || !toImpl2.handoff) return;
    const afterRearm = readState(root);
    assert.equal(afterRearm.dispatch_capability!.issued_for!.loop_iteration, 2, "re-armed implementation carries iteration 2");
    assert.equal(afterRearm.dispatch_capability!.capability_id, toImpl2.handoff.capability_id);
    completeArmed(root, toImpl2.handoff, "dev", ["implementation"], { implementation: { files_touched: ["y"], ready: true, validation_run: true, validation_evidence: "e2" } });

    // The iteration-1 approve_fix must NOT unblock iteration 2...
    const blocked = advanceCursor(root, { ...handoffAuths(toImpl2.handoff).advance, evidence: "fix 2" });
    assert.equal(blocked.ok, false, "the prior iteration's decision cannot satisfy the re-entered stage");
    if (!blocked.ok) assert.match(blocked.error, /checkpoint 'approve_fix' for stage 'implementation' is unresolved/);
    assert.equal(readState(root).pause.kind, "user_checkpoint", "the stale candidate does not deadlock as an error: it is simply not a candidate");

    // ...and a SECOND approve_fix records cleanly (no conflict with iteration 1).
    recordHumanDecision(root, toImpl2.handoff, "implementation", "approve_fix", "approve_fix", "iteration 2 answer");
    const afterSecond = readState(root);
    const decisions = afterSecond.typed_checkpoint_decisions ?? [];
    assert.equal(decisions.filter((decision) => decision.checkpoint_id === "approve_fix").length, 2, "both iteration records remain as audit history");
    assert.equal(new Set(decisions.map((decision) => decision.loop_iteration)).size, 2, "the two records carry distinct loop iterations");
    assert.equal(new Set(decisions.map((decision) => decision.capability_epoch)).size, 2, "the two records carry distinct capability epochs");

    const advanced = advanceCursor(root, { ...handoffAuths(toImpl2.handoff).advance, evidence: "fix 2" });
    assert.equal(advanced.ok, true, advanced.ok ? "the iteration-2 decision unblocks advance" : advanced.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger: the current stage's declaration wins; a prior stage's decision and a stale policy_auto cannot cross over", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-policy-"));
  try {
    initGit(root, "main");
    // Two stages share the checkpoint id `approve_fix`; the policies differ.
    const autonomous: CheckpointPolicy = {
      ...approvalPolicy(["approve_fix", "reject_fix"], "autonomous_allowed"),
      rules: {
        approve_fix: {
          kind: "implementation_approval",
          default: "autonomous_allowed",
          allowed_decisions: ["approve_fix", "reject_fix"],
          phase: "before_advance",
          rationale: "stage two allows autonomous authorization",
        },
      },
      default: "autonomous_allowed",
      hard_human: [],
    };
    const profile: Profile = {
      name: "ledger-policy-change",
      title: "Policy change",
      description: "two stages with the same checkpoint id and different policies",
      match: { type: ["OPS"] },
      stages: [
        { id: "build", title: "Build", type: "single", role: "dev", produces: "implementation", checkpoint: "approve_fix", checkpoint_policy: approvalPolicy(["approve_fix", "reject_fix"], "required_human") },
        { id: "ship", title: "Ship", type: "single", role: "dev", produces: "debug", checkpoint: "approve_fix", checkpoint_policy: autonomous },
      ],
    };
    registerWorkflowProfiles([profile]);

    const buildIssued = runStage(root, profile, "build", "dev", ["implementation"], { implementation: { files_touched: ["x"], ready: true, validation_run: true, validation_evidence: "e" } });
    recordDecisionFor(root, advanceAuthOf(buildIssued), "build", "approve_fix", "approve_fix", "build stage answer");
    const toShip = advanceCursor(root, { ...advanceAuthOf(buildIssued), evidence: "build done" });
    assert.equal(toShip.ok, true, toShip.ok ? "advanced to ship" : toShip.error);
    if (!toShip.ok || !toShip.handoff) return;
    const afterTransition = readState(root);

    // The stage-1 decision neither authorizes nor blocks stage 2: the ship
    // stage's checkpoint is UNRESOLVED in its own scope (its own policy hash
    // and capability epoch), not wrongly satisfied and not an error.
    completeArmed(root, toShip.handoff, "dev", ["debug"], { debug: { verdict: "PASS", iterations: 1 } });
    const blocked = advanceCursor(root, { ...handoffAuths(toShip.handoff).advance, evidence: "ship done" });
    assert.equal(blocked.ok, false, "stage 2 still requires its own decision");
    if (!blocked.ok) assert.match(blocked.error, /checkpoint 'approve_fix' for stage 'ship' is unresolved/);
    assert.equal(readState(root).pause.kind, "user_checkpoint");

    // The stage-1 policy binding was rebound to stage 2 with stage 2's hash.
    assert.equal(afterTransition.checkpoint_policy_binding?.stage_id, "ship");
    assert.equal(afterTransition.checkpoint_policy_binding?.policy_hash, checkpointPolicyHash(autonomous));
    assert.equal(afterTransition.checkpoint_policy?.default, "autonomous_allowed", "the state mirror is the active-stage projection");

    // policy_auto recorded under the STALE stage-1 policy hash can never
    // authorize the ship checkpoint.
    const staleAuto = validateCheckpointDecision(readState(root), {
      run_id: "main",
      stage_id: "ship",
      checkpoint_id: "approve_fix",
      checkpoint_kind: "implementation_approval",
      decision: "approve_fix",
      authorization: "policy_auto",
      actor: { kind: "system", ref: "policy" },
      capability_id: toShip.handoff.capability_id,
      capability_epoch: toShip.handoff.cursor_epoch,
      loop_iteration: toShip.handoff.loop_iteration,
      policy_hash: checkpointPolicyHash(approvalPolicy(["approve_fix", "reject_fix"], "required_human")),
      rationale: "stale policy auto",
      decided_at: new Date().toISOString(),
    }, { stage: { id: "ship", checkpoint: "approve_fix", checkpoint_policy: autonomous } });
    assert.equal(staleAuto.ok, false, "policy_auto cannot exploit a stale policy hash");
    if (!staleAuto.ok) assert.equal(staleAuto.code, "checkpoint_unverified");

    // policy_auto under the CURRENT ship declaration is explicit-allowed.
    const recorded = recordCheckpointDecision(root, {
      ...handoffAuths(toShip.handoff).advance,
      checkpoint: "approve_fix",
      checkpoint_id: "approve_fix",
      checkpoint_kind: "implementation_approval",
      decision: "approve_fix",
      authorization: "policy_auto",
      actor_provenance: { kind: "system", ref: "policy:autonomous_allowed" },
      rationale: "ship policy allows autonomous authorization",
    });
    assert.equal(recorded.ok, true, recorded.ok ? "ship policy_auto recorded" : recorded.error);
    const advanced = advanceCursor(root, { ...handoffAuths(toShip.handoff).advance, evidence: "ship done" });
    assert.equal(advanced.ok, true, advanced.ok ? "the current-scope policy_auto unblocks advance" : advanced.error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger: commitCheckpointAnswer keeps ONE live answer per question across channels and supersedes safely", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-commit-"));
  try {
    initGit(root, "main");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: "lightweight", profile_hash: profileHash(profile),
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
    });
    writeStateBootstrap(root, {
      schema: 1,
      branch: "main",
      run_key: "main",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
      task: "cross-channel uniqueness",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      scope: scopeFlags(),
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "ledger" });

    const request = {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: "lightweight",
      stage_cursor: "implementation",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
    };

    // A live ESCALATION proof exists (another trusted surface asked first).
    const seededState = readState(root);
    const escalation = recordTrustedCheckpointAnswer(seededState, {
      answer_id: "ledger/escalation-1",
      channel: "escalation",
      reference: "escalation-answer/ledger/escalation-1",
      stage_id: "implementation",
      checkpoint_id: "approve_implementation",
      decision: "proceed",
    });
    writeStateBootstrap(root, escalation.state, { featureSlug: "ledger" });

    // The terminal UI commits a DIFFERENT decision: the escalation proof is
    // superseded and exactly one fresh live answer exists afterwards.
    const committed = commitCheckpointAnswer(root, { ...request, decision: "reject" });
    assert.equal(committed.ok, true, committed.ok ? "committed" : committed.error);
    if (!committed.ok) return;
    assert.equal(committed.outcome, "minted");
    const afterMint = readState(root);
    const live = (afterMint.trusted_checkpoint_answers ?? []).filter((answer) => answer.consumed_at === undefined && answer.consumed_reason === undefined);
    assert.equal(live.length, 1, "at most one live answer across both channels");
    assert.equal(live[0]?.channel, "terminal");
    const superseded = (afterMint.trusted_checkpoint_answers ?? []).find((answer) => answer.answer_id === "ledger/escalation-1");
    assert.equal(superseded?.consumed_reason, "superseded", "the escalation proof was superseded, never left authorizable");
    assert.equal((afterMint.trusted_checkpoint_answers ?? []).find((answer) => answer.answer_id === committed.answer!.answer_id)?.consumed_at, undefined);

    // The superseded escalation proof can never authorize its own decision.
    const policy = afterMint.checkpoint_policy!;
    const rejected = validateCheckpointDecision(afterMint, {
      run_id: "main",
      stage_id: "implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: policy.rules.approve_implementation!.kind,
      decision: "proceed",
      authorization: "human",
      actor: { kind: "user", ref: escalation.answer.reference, proof: escalation.proof },
      capability_id: issued.capability_id,
      capability_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      policy_hash: checkpointPolicyHash(policy),
      rationale: "superseded escalation replay",
      decided_at: new Date().toISOString(),
    }, { stage: { id: "implementation", checkpoint: "approve_implementation" } });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "proof_superseded");

    // Exact replay of the same selection reuses the live proof (no second mint).
    const replay = commitCheckpointAnswer(root, { ...request, decision: "reject" });
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.outcome, "reused_live");
    assert.equal(replay.answer!.answer_id, committed.answer!.answer_id, "the live proof identity is reused");
    assert.equal((readState(root).trusted_checkpoint_answers ?? []).length, 2, "no additional answer was minted");

    // A label outside the policy's allowed decisions is rejected verbatim.
    const notAllowed = commitCheckpointAnswer(root, { ...request, decision: " proceed" });
    assert.equal(notAllowed.ok, false, "whitespace variants are never normalized into a decision");
    if (!notAllowed.ok) assert.equal(notAllowed.kind, "rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger: stale top-level work identity is forbidden when the active capability projects none", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-identity-"));
  try {
    initGit(root, "main");
    const policy = approvalPolicy(["approve_fix", "reject_fix"], "required_human");
    const profile = debugCycleProfile(policy);
    registerWorkflowProfiles([profile]);
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "dev", agent: "dev" }],
    });
    writeStateBootstrap(root, {
      schema: 1,
      branch: "main",
      run_key: "main",
      classification: { type: "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: profile.name },
      task: "stale identity",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      scope: scopeFlags(),
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "ledger" });
    const before = readState(root);
    const staleIdentity = {
      run_id: "main",
      wave_id: "stale-wave",
      slice_id: "diagnose",
      session_id: "stale-session",
      workflow: profile.name,
      stage_id: "diagnose",
      stage_cursor: "diagnose",
      capability_id: "stale-capability",
      capability_epoch: "stale-epoch",
      loop_iteration: 1,
      slot_id: "diagnostics",
      task_id: "stale-task",
      dispatch_id: "stale-dispatch",
      attempt: 1,
      worker_id: "engine",
    };
    assert.throws(() => recordTrustedCheckpointAnswer({ ...before, work_identity: staleIdentity }, {
      answer_id: "ledger/identity-proof",
      channel: "terminal",
      reference: "terminal-answer/ledger/identity-proof",
      stage_id: "implementation",
      checkpoint_id: "approve_fix",
      decision: "approve_fix",
    }), /work_identity.*forbidden/);

    const trusted = recordTrustedCheckpointAnswer(before, {
      answer_id: "ledger/identity-proof-2",
      channel: "terminal",
      reference: "terminal-answer/ledger/identity-proof-2",
      stage_id: "implementation",
      checkpoint_id: "approve_fix",
      decision: "approve_fix",
    });
    assert.notEqual(trusted.answer.work_identity_hash, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger: a mirrored foreign run_id is rejected by the strict active identity binding", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-foreign-run-"));
  try {
    initGit(root, "main");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
    });
    writeStateBootstrap(root, {
      schema: 1,
      branch: "main",
      run_key: "main",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: profile.name },
      task: "foreign run binding",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      scope: scopeFlags(),
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "ledger" });
    const authorized = authorizeDispatch(root, dispatchAuthOf(issued, "developer-kotlin"));
    assert.equal(authorized.ok, true, authorized.ok ? "authorized" : authorized.error);
    const state = readState(root);
    assert.ok(state.work_identity);
    assert.ok(state.dispatch_capability?.work_identity);
    const foreignize = (identity: NonNullable<TeamState["work_identity"]>) => ({ ...identity, run_id: "foreign-run" });
    const foreignIdentity = foreignize(state.work_identity!);
    const capability = state.dispatch_capability!;
    const forged = {
      ...state,
      work_identity: foreignIdentity,
      completion_envelope: state.completion_envelope
        ? { ...state.completion_envelope, identity: foreignize(state.completion_envelope.identity) }
        : undefined,
      dispatch_capability: {
        ...capability,
        work_identity: foreignIdentity,
        pending: capability.pending?.map((pending) => ({ ...pending, identity: foreignize(pending.identity) })),
        dispatches: capability.dispatches?.map((record) => ({
          ...record,
          work_identity: foreignize(record.work_identity!),
          pending: record.pending ? { ...record.pending, identity: foreignize(record.pending.identity) } : undefined,
          completion_envelope: record.completion_envelope
            ? { ...record.completion_envelope, identity: foreignize(record.completion_envelope.identity) }
            : undefined,
        })),
      },
    };
    writeFileSync(join(root, ".work-state", "features", "ledger", "state.json"), JSON.stringify(forged, null, 2) + "\n");
    const committed = commitCheckpointAnswer(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: profile.name,
      stage_cursor: "implementation",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
      decision: "proceed",
    });
    const binding = validateActiveCapabilityStateBinding(forged);
    assert.equal(binding.ok, false);
    if (!binding.ok) {
      assert.ok(binding.issues.some((issue) => issue.path.endsWith(".work_identity.run_id") && issue.message.includes("does not match")));
    }
    assert.equal(committed.ok, false);
    if (!committed.ok) assert.equal(committed.kind, "rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger: invalid exact live answer is atomically superseded, never reused", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-invalid-live-"));
  try {
    initGit(root, "main");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
    });
    writeStateBootstrap(root, {
      schema: 1,
      branch: "main",
      run_key: "main",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: profile.name },
      task: "invalid live proof",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      scope: scopeFlags(),
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "ledger" });
    const request = {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: profile.name,
      stage_cursor: "implementation",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
      decision: "proceed",
    };
    const first = commitCheckpointAnswer(root, request);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const firstId = first.answer!.answer_id;
    const tampered = readState(root);
    tampered.trusted_checkpoint_answers = tampered.trusted_checkpoint_answers!.map((answer) =>
      answer.answer_id === firstId ? { ...answer, binding: "forged-binding" } : answer);
    writeFileSync(join(root, ".work-state", "features", "ledger", "state.json"), JSON.stringify(tampered, null, 2) + "\n");

    const retried = commitCheckpointAnswer(root, request);
    assert.equal(retried.ok, true, retried.ok ? "superseded and minted" : retried.error);
    if (!retried.ok) return;
    assert.equal(retried.outcome, "minted");
    assert.notEqual(retried.answer!.answer_id, firstId);
    const after = readState(root);
    assert.equal(after.trusted_checkpoint_answers!.find((answer) => answer.answer_id === firstId)?.consumed_reason, "superseded");
    assert.equal(after.trusted_checkpoint_answers!.filter((answer) => answer.consumed_at === undefined).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger: malformed current-scope sibling blocks already_finalized replay", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-malformed-final-"));
  try {
    initGit(root, "main");
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "implementation", kind: "single", expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
    });
    writeStateBootstrap(root, {
      schema: 1,
      branch: "main",
      run_key: "main",
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: profile.name },
      task: "malformed final",
      workflow_override: false,
      issue: null,
      stage_cursor: "implementation",
      stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      scope: scopeFlags(),
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      updated_at: new Date().toISOString(),
    }, { featureSlug: "ledger" });
    const request = {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: profile.name,
      stage_cursor: "implementation",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
      decision: "proceed",
    };
    const answer = commitCheckpointAnswer(root, request);
    assert.equal(answer.ok, true);
    if (!answer.ok) return;
    const recorded = recordCheckpointDecision(root, {
      ...request,
      profile_hash: profileHash(profile),
      rationale: "owner approved",
      authorization: "human",
      actor_provenance: { kind: "user", ref: answer.answer!.reference, proof: answer.proof! },
    });
    assert.equal(recorded.ok, true, recorded.ok ? "recorded" : recorded.error);
    const corrupted = readState(root);
    const exact = corrupted.typed_checkpoint_decisions![0]!;
    corrupted.typed_checkpoint_decisions = [
      ...corrupted.typed_checkpoint_decisions!,
      { ...exact, checkpoint_kind: "custom" },
    ];
    writeFileSync(join(root, ".work-state", "features", "ledger", "state.json"), JSON.stringify(corrupted, null, 2) + "\n");
    const replay = commitCheckpointAnswer(root, request);
    assert.equal(replay.ok, false);
    if (!replay.ok) {
      assert.equal(replay.kind, "rejected");
      assert.match(replay.error, /current-scope checkpoint ledger is invalid/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger: conflicting current-scope finals are checked before any exact replay", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-conflicting-finals-"));
  try {
    initGit(root, "main");
    const policy = approvalPolicy(["proceed", "reject"], "autonomous_allowed");
    const profile: Profile = {
      name: "ledger-conflicting-finals",
      title: "Conflicting finals",
      description: "one autonomous checkpoint",
      match: { type: ["OPS"] },
      stages: [{ id: "approval", title: "Approval", type: "orchestrator", checkpoint: "approve_fix", checkpoint_policy: policy }],
    };
    registerWorkflowProfiles([profile]);
    const issued = createCapability({
      run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
      stage_cursor: "approval", kind: "none", expected_roster: [],
    });
    const base: TeamState = {
      schema: 1,
      branch: "main",
      run_key: "main",
      classification: { type: "OPS", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: profile.name },
      task: "conflicting finals",
      workflow_override: false,
      issue: null,
      stage_cursor: "approval",
      stages: [{ id: "approval", status: "in_progress" }],
      artifacts: {},
      pause: { kind: "none", reason: "" },
      policy: { strict_orchestrator: true },
      profile_hash: profileHash(profile),
      scope: scopeFlags(),
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      dispatch_capability: issued.state,
      checkpoint_policy: policy,
      updated_at: new Date().toISOString(),
    };
    const decisionBase = {
      run_id: "main",
      stage_id: "approval",
      checkpoint_id: "approve_fix",
      checkpoint_kind: "implementation_approval" as const,
      authorization: "policy_auto" as const,
      actor: { kind: "system" as const, ref: "policy:test" },
      capability_id: issued.capability_id,
      capability_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration!,
      policy_hash: checkpointPolicyHash(policy),
      decided_at: new Date().toISOString(),
    };
    base.typed_checkpoint_decisions = [
      { ...decisionBase, decision: "proceed", rationale: "first" },
      { ...decisionBase, decision: "reject", rationale: "second" },
    ];
    writeStateBootstrap(root, base, { featureSlug: "ledger" });
    const replay = commitCheckpointAnswer(root, {
      token: issued.advance_token,
      capability_id: issued.capability_id,
      run_key: "main",
      branch: "main",
      workflow: profile.name,
      stage_cursor: "approval",
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      loop_iteration: issued.state.issued_for!.loop_iteration,
      checkpoint: "approve_fix",
      checkpoint_id: "approve_fix",
      checkpoint_kind: "implementation_approval",
      decision: "proceed",
    });
    assert.equal(replay.ok, false);
    if (!replay.ok) {
      assert.equal(replay.kind, "conflict");
      assert.equal(replay.code, "decision_conflict");
      assert.match(replay.error, /multiple conflicting decisions/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger: reopened two-epoch history is ambiguous unless an exact generation is selected", () => {
  const policy = approvalPolicy(["proceed", "reject"], "autonomous_allowed");
  const profile: Profile = {
    name: "ledger-history-generations",
    title: "History generations",
    description: "reopened approval",
    match: { type: ["OPS"] },
    stages: [{ id: "approval", title: "Approval", type: "orchestrator", checkpoint: "approve_fix", checkpoint_policy: policy }],
  };
  registerWorkflowProfiles([profile]);
  const first = createCapability({
    run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
    stage_cursor: "approval", kind: "none", expected_roster: [], cursor_epoch: "epoch-one",
  });
  const second = createCapability({
    run_key: "main", branch: "main", workflow: profile.name, profile_hash: profileHash(profile),
    stage_cursor: "approval", kind: "none", expected_roster: [], cursor_epoch: "epoch-two",
  });
  const baseDecision = {
    run_id: "main",
    stage_id: "approval",
    checkpoint_id: "approve_fix",
    checkpoint_kind: "implementation_approval" as const,
    authorization: "policy_auto" as const,
    actor: { kind: "system" as const, ref: "policy:test" },
    loop_iteration: 1,
    policy_hash: checkpointPolicyHash(policy),
    decided_at: new Date().toISOString(),
  };
  const firstDecision = {
    ...baseDecision,
    decision: "proceed",
    rationale: "first generation",
    capability_id: first.capability_id,
    capability_epoch: first.state.issued_for!.cursor_epoch,
  };
  const secondDecision = {
    ...baseDecision,
    decision: "reject",
    rationale: "reopened generation",
    capability_id: second.capability_id,
    capability_epoch: second.state.issued_for!.cursor_epoch,
  };
  const state: TeamState = {
    schema: 1,
    branch: "main",
    run_key: "main",
    classification: { type: "OPS", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: profile.name },
    task: "reopened history",
    workflow_override: false,
    issue: null,
    stage_cursor: "approval",
    stages: [{ id: "approval", status: "in_progress" }],
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(profile),
    scope: scopeFlags(),
    cursor_epoch: second.state.issued_for!.cursor_epoch,
    dispatch_capability: second.state,
    checkpoint_policy: policy,
    typed_checkpoint_decisions: [firstDecision, secondDecision],
    history: [{ task: "first approval", feedback: "reopen", at: new Date().toISOString() }],
    updated_at: new Date().toISOString(),
  };
  const declaration = resolveCheckpointDeclaration(profile.stages[0]!, null, state, "authorize");
  assert.equal(declaration.ok, true);
  if (!declaration.ok || !declaration.declaration) return;
  const ambiguous = findHistoricalCheckpointDecision(state, declaration.declaration);
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.code, "decision_ambiguous");

  const selected = findHistoricalCheckpointDecision(state, declaration.declaration, {
    decision_key: checkpointDecisionKey(firstDecision),
  });
  assert.equal(selected.ok, true);
  if (selected.ok) {
    assert.equal(selected.decision?.decision, "proceed");
    assert.equal(selected.decision_key, checkpointDecisionKey(firstDecision));
  }
});

test("ledger: normalization drops stale policy mirrors and reprojects only the current declaration", () => {
  const currentPolicy = approvalPolicy(["proceed", "reject"], "required_human");
  const stalePolicy = approvalPolicy(["stale-only"], "autonomous_allowed");
  const profile: Profile = {
    name: "ledger-normalizer-policy",
    title: "Ledger normalizer policy",
    description: "profile-level checkpoint followed by a no-checkpoint stage",
    match: { type: ["OPS"] },
    checkpoint_policy: currentPolicy,
    stages: [
      { id: "prior", title: "Prior", type: "orchestrator", checkpoint: "approve_fix" },
      { id: "current", title: "Current", type: "orchestrator", checkpoint: "approve_fix" },
      { id: "finish", title: "Finish", type: "orchestrator" },
    ],
  };
  registerWorkflowProfiles([profile]);
  const raw: TeamState = {
    schema: 1,
    branch: "main",
    run_key: "main",
    classification: { type: "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: profile.name },
    task: "normalizer policy scope",
    workflow_override: false,
    issue: null,
    stage_cursor: "current",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "current" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(profile),
    scope: scopeFlags(),
    checkpoint_policy: stalePolicy,
    checkpoint_policy_binding: {
      stage_id: "prior",
      profile_hash: profileHash(profile),
      policy_hash: checkpointPolicyHash(stalePolicy),
    },
    updated_at: new Date().toISOString(),
  };

  const checkpointed = normalizePersistedState(structuredClone(raw));
  assert.ok(checkpointed);
  assert.deepEqual(checkpointed.checkpoint_policy, currentPolicy, "current stage receives its profile-level declaration");
  assert.equal(checkpointed.checkpoint_policy_binding, undefined, "normalization never carries the stale binding forward");

  const noCheckpoint = normalizePersistedState({ ...structuredClone(raw), stage_cursor: "finish" });
  assert.ok(noCheckpoint);
  assert.equal(noCheckpoint.checkpoint_policy, undefined, "a no-checkpoint stage cannot inherit the stale or profile-level policy");
  assert.equal(noCheckpoint.checkpoint_policy_binding, undefined);
});
