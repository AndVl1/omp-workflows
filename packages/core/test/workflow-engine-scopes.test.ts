/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */
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
import { agentRef, qualifiedRoster, readWorkflowProfile, workIdentityScopeFixture, workflowV2Fixture, type WorkflowV2TestFixture } from "./workflow-v2-fixtures.js";
import { validateWorkflowRunIdentity } from "../src/workflow-v2/identity.js";
import { createCapability, authorizeDispatch, completeDispatch, advanceCursor as advanceCursorRaw, recordCheckpointDecision, type CapabilityContext, type DispatchAuth, type IssuedCapability, type TransitionResult } from "../src/engine/durable.js";
import { validateTypedControlPlane } from "../src/engine/workflow-contract.js";
import { resolveProfileControlPlane } from "../src/engine/profile.js";
import { appendCheckpointDecision, checkpointAnswerBinding, checkpointPolicyHash, recordTrustedCheckpointAnswer, validateCheckpointDecision } from "../src/engine/checkpoints.js";
import { writeState } from "../src/engine/state.js";
import { run } from "../src/engine/run.js";
import type { Profile, TeamState } from "../src/engine/types.js";
import type { ScopeFlags } from "../src/engine/scope.js";
import type { TaskCaller } from "../src/engine/stage.js";

const FIXTURES = new Map<string, WorkflowV2TestFixture>();

function fixtureFor(profile: Profile): WorkflowV2TestFixture {
  return workflowV2Fixture(profile);
}
function sameRunIdentity(left: WorkflowV2TestFixture["run_identity"], right: WorkflowV2TestFixture["run_identity"]): boolean {
  const leftKey = [
    left.root_instance_id,
    left.provider_id,
    left.descriptor_fingerprint,
    left.executable_provenance.build_fingerprint,
    left.executable_provenance.runtime_fingerprint,
    left.catalog_content_digest,
    left.config_byte_sha256,
    left.config_semantic_sha256,
    left.session.session_id,
    left.session.lifecycle_id,
    left.run_id,
    left.profile_identity.id,
    left.profile_identity.fingerprint,
  ];
  const rightKey = [
    right.root_instance_id,
    right.provider_id,
    right.descriptor_fingerprint,
    right.executable_provenance.build_fingerprint,
    right.executable_provenance.runtime_fingerprint,
    right.catalog_content_digest,
    right.config_byte_sha256,
    right.config_semantic_sha256,
    right.session.session_id,
    right.session.lifecycle_id,
    right.run_id,
    right.profile_identity.id,
    right.profile_identity.fingerprint,
  ];
  return JSON.stringify(leftKey) === JSON.stringify(rightKey);
}

function contextFor(issued: IssuedCapability): CapabilityContext {
  const fixture = FIXTURES.get(issued.capability_id);
  assert.ok(fixture, "capability fixture must be registered before dispatch");
  return {
    project_identity: fixture.project_identity,
    run_identity: issued.state.issued_for!.run_identity,
    catalog: fixture.catalog,
    effective_policy: fixture.effective_policy,
    agent_inventory: fixture.agent_inventory,
  };
}

function advanceCursor(root: string, input: DispatchAuth): TransitionResult {
  const fixture = FIXTURES.get(input.capability_id);
  assert.ok(fixture, "capability fixture must be registered before cursor advancement");
  return advanceCursorRaw(root, input, {
    project_identity: input.project_identity,
    run_identity: input.run_identity,
    catalog: fixture.catalog,
    effective_policy: fixture.effective_policy,
    agent_inventory: fixture.agent_inventory,
  });
}

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
): { issued: IssuedCapability; artifactsDir: string } {
  const fixture = fixtureFor(profile);
  const work_identity_scope = workIdentityScopeFixture(fixture, {
    workflow: profile.name,
    stage_id: stageId,
    slot_id: roster[0]!.role,
  });
  const checkpointPolicy = resolveProfileControlPlane(profile, stageId).checkpoint_policy;
  const persistedHash = fixture.profile_identity.fingerprint;
  const issued = createCapability({
    run_key: branch,
    branch,
    workflow: profile.name,
    profile_hash: persistedHash,
    stage_cursor: stageId,
    kind,
    expected_roster: qualifiedRoster(fixture, roster),
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    work_identity_scope,
  });
  FIXTURES.set(issued.capability_id, fixture);
  // Preserve durable loop/checkpoint/fan-in state across stage transitions
  // (advanceCursor carries it forward; the test helper must not wipe it).
  const existingPath = join(root, ".work-state", "features", "loop", "state.json");
  let carried: Partial<Pick<TeamState, "loop_state" | "checkpoint_decisions" | "slot_artifacts" | "join_summary" | "retired_capabilities">> = {};
  try {
    const existing = JSON.parse(readFileSync(existingPath, "utf8")) as TeamState;
    const hasJoinSummary = Object.prototype.hasOwnProperty.call(existing, "join_summary");
    const existingJoinSummary = existing.join_summary as unknown;
    const summaryRecord = existingJoinSummary !== null
      && typeof existingJoinSummary === "object"
      && !Array.isArray(existingJoinSummary)
      ? existingJoinSummary as { run_identity?: unknown }
      : null;
    const summaryRun = summaryRecord ? validateWorkflowRunIdentity(summaryRecord.run_identity) : null;
    const summaryValidation = hasJoinSummary
      ? validateTypedControlPlane({ join_summary: existingJoinSummary })
      : null;
    carried = {
      ...(existing.loop_state ? { loop_state: existing.loop_state } : {}),
      ...(existing.checkpoint_decisions ? { checkpoint_decisions: existing.checkpoint_decisions } : {}),
      ...(existing.slot_artifacts ? { slot_artifacts: existing.slot_artifacts } : {}),
      ...(hasJoinSummary ? { join_summary: existing.join_summary } : {}),
      ...(existing.retired_capabilities !== undefined ? { retired_capabilities: existing.retired_capabilities } : {}),
    };
    if (summaryValidation?.ok && summaryRun?.ok && !sameRunIdentity(summaryRun.value, fixture.run_identity)) {
      delete carried.join_summary;
    }
  } catch {
    // first stage setup: nothing to carry
  }
  writeState(root, {
    schema: 1,
    branch,
    run_key: branch,
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    classification: classification(profile.name, false),
    workflow: profile.name,
    task: "loop test",
    workflow_override: false,
    issue: null,
    stage_cursor: stageId,
    stages: profile.stages.map((s) => ({ id: s.id, status: s.id === stageId ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    ...(checkpointPolicy ? { checkpoint_policy: checkpointPolicy } : {}),
    work_identity: issued.work_identity,
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
    project_identity: issued.state.project_identity,
    run_identity: issued.state.run_identity,
    role,
    agent,
    agent_ref: agentRef(agent),
  };
}
function advanceAuth(issued: IssuedCapability): DispatchAuth {
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: issued.state.issued_for!.run_key,
    branch: issued.state.issued_for!.branch,
    workflow: issued.state.issued_for!.workflow,
    profile_hash: issued.state.issued_for!.profile_hash,
    stage_cursor: issued.state.issued_for!.stage_cursor,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    project_identity: issued.state.project_identity,
    run_identity: issued.state.run_identity,
  };
}



function readState(root: string): TeamState {
  return JSON.parse(readFileSync(join(root, ".work-state", "features", "loop", "state.json"), "utf8")) as TeamState;
}

function typedCheckpoint(root: string, stageId: string, checkpointId: string, decision = "proceed") {
  const state = readState(root);
  const policy = state.checkpoint_policy;
  const capability = state.dispatch_capability;
  assert.ok(policy, "checkpoint test state must carry a typed policy");
  assert.ok(capability?.capability_id && capability.issued_for?.cursor_epoch, "checkpoint test state must carry capability binding");
  const work_identity = state.work_identity;
  assert.ok(work_identity?.run_id, "checkpoint test state must carry canonical work identity");
  const rule = policy.rules[checkpointId];
  assert.ok(rule, `checkpoint test policy must define ${checkpointId}`);
  const trusted = recordTrustedCheckpointAnswer(state, {
    answer_id: `scope-test/${stageId}/${checkpointId}`,
    channel: "terminal",
    reference: `terminal-answer/scope-test/${stageId}/${checkpointId}`,
    stage_id: stageId,
    checkpoint_id: checkpointId,
    decision,
  });
  writeState(root, trusted.state, { featureSlug: "loop" });
  return {
    run_identity: state.run_identity,
    run_id: work_identity.run_id,
    stage_id: stageId,
    checkpoint_id: checkpointId,
    checkpoint_kind: rule.kind,
    decision,
    authorization: "human" as const,
    actor: { kind: "user" as const, ref: trusted.answer.reference, proof: trusted.proof },
    capability_id: capability.capability_id,
    capability_epoch: capability.issued_for!.cursor_epoch,
    policy_hash: checkpointPolicyHash(policy),
    rationale: "explicit typed test answer",
    decided_at: new Date().toISOString(),
  };
}

function persistTypedCheckpoint(root: string, stageId: string, checkpointId: string, decision = "proceed"): void {
  const typed = typedCheckpoint(root, stageId, checkpointId, decision);
  writeState(root, appendCheckpointDecision(readState(root), typed), { featureSlug: "loop" });
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

test("checkpoint: unresolved declared checkpoint blocks advance; an explicit typed decision unblocks", () => {
  const root = mkdtempSync(join(tmpdir(), "ck-block-"));
  try {
    initGit(root, "feat/ck");
    const profile = readWorkflowProfile("lightweight");
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
    if (!blocked.ok) {
      assert.match(blocked.error, /checkpoint 'approve_implementation' for stage 'implementation' is unresolved/);
      assert.equal(blocked.state.pause.kind, "user_checkpoint", "missing consent is resumable");
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
    const profile = readWorkflowProfile("lightweight");
    const roster = [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }];
    setupStage(root, "feat/ck-provenance", profile, "implementation", "single", roster);

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
      if (!rejected.ok) assert.equal(rejected.code, candidate.run_id === "stale-run" ? "IDENTITY_MISMATCH" : "checkpoint_unverified");
    }

    const persisted = appendCheckpointDecision(state, valid);
    assert.equal(persisted.typed_checkpoint_decisions?.length, 1);
    assert.equal(persisted.trusted_checkpoint_answers?.[0]?.consumed_at !== undefined, true, "answer consumption is durable");
    assert.deepEqual(persisted.artifacts, state.artifacts, "checkpoint authorization does not overwrite artifacts");
    assert.equal(validateCheckpointDecision(persisted, valid, { stage }).ok, true, "exact replay is idempotent");
    assert.throws(
      () => appendCheckpointDecision(persisted, { ...valid, decision: "reject" }),
      /checkpoint_unverified|migration_conflict/,
      "a replayed answer cannot authorize a different decision",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("checkpoint: routing autonomy stays orthogonal to profile consent; migration conflicts fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "ck-policy-orthogonal-"));
  try {
    initGit(root, "feat/ck-policy");
    const profile = readWorkflowProfile("lightweight");
    const roster = [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }];
    const { issued, artifactsDir } = setupStage(root, "feat/ck-policy", profile, "implementation", "single", roster);
    writeFileSync(join(artifactsDir, "implementation.json"), JSON.stringify({ ready: true, validation_run: true, validation_evidence: "evidence", files_touched: ["x"] }));
    const auth = authOf(issued, "${scope.dev_agent}", "developer-kotlin");
    const authorized = authorizeDispatch(root, auth);
    assert.equal(authorized.ok, true);
    if (!authorized.ok || !authorized.record) return;
    assert.equal(completeDispatch(root, { ...auth, dispatch_id: authorized.record.id, outcome: "succeeded", evidence: "done" }).ok, true);

    const profileState = readState(root);
    assert.equal(profileState.checkpoint_policy?.source, "profile");
    writeState(root, { ...profileState, classification: { ...profileState.classification, autonomous: true } }, { featureSlug: "loop" });
    persistTypedCheckpoint(root, "implementation", "approve_implementation");
    const advanced = advanceCursor(root, { ...advanceAuth(issued), evidence: "typed human consent" });
    assert.equal(advanced.ok, true, "routing autonomous=true must not conflict with a profile-source human policy");

    const migrationRoot = mkdtempSync(join(tmpdir(), "ck-policy-migration-conflict-"));
    try {
      initGit(migrationRoot, "feat/ck-policy-migration");
      const migrationSetup = setupStage(migrationRoot, "feat/ck-policy-migration", profile, "implementation", "single", roster);
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
      const conflictingState = {
        ...migrationState,
        classification: { ...migrationState.classification, autonomous: false },
        checkpoint_policy: migrationPolicy,
      };
      writeState(migrationRoot, conflictingState, { featureSlug: "loop" });
      const typed = typedCheckpoint(migrationRoot, "implementation", "approve_implementation");
      const conflict = validateCheckpointDecision(readState(migrationRoot), typed, {
        stage: { id: "implementation", checkpoint: "approve_implementation", checkpoint_policy: migrationPolicy },
        policy: migrationPolicy,
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
    const profile = readWorkflowProfile("lightweight");
    const roster = [{ role: "${scope.dev_agent}", agent: "developer-kotlin" }];
    const { issued } = setupStage(root, "feat/ck", profile, "implementation", "single", roster);
    const typed = typedCheckpoint(root, "implementation", "approve_implementation");
    writeState(root, appendCheckpointDecision(readState(root), typed), { featureSlug: "loop" });
    writeState(root, appendCheckpointDecision(readState(root), typed), { featureSlug: "loop" });
    const decisions = readState(root);
    assert.equal(decisions.typed_checkpoint_decisions?.length, 1, "identical typed decision is idempotent");
    assert.equal(decisions.checkpoint_decisions?.length, 1, "typed mirror remains singular");
    assert.throws(
      () => appendCheckpointDecision(readState(root), { ...typed, rationale: "conflicting answer" }),
      /migration_conflict/,
      "a second answer cannot replace an existing checkpoint decision",
    );
    const wrongName = recordCheckpointDecision(root, { ...advanceAuth(issued), checkpoint: "bogus", mode: "interactive", decision: "x", actor: "user", rationale: "r" }, contextFor(issued));
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
    const profile = LOOP_PROFILE;

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
    assert.deepEqual(state.dispatch_capability?.expected_roster, [{
      role: "diagnostics",
      agent: "diagnostics",
      agent_ref: agentRef("diagnostics"),
    }], "re-entry keeps the provider-qualified roster");
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
    const profile = LOOP_PROFILE;

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
    const profile = LOOP_PROFILE;

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
    const failP = failProfile;
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

test("checkpoint: interpreter never auto-records from routing autonomy; unresolved consent pauses", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-interp-"));
  const branch = "feat/interp";
  try {
    initGit(root, branch);
    const checkpointProfile: Profile = {
      ...LOOP_PROFILE,
      name: "interp-checkpoint",
      stages: LOOP_PROFILE.stages.map((s) => s.id === "diagnose" ? { ...s, checkpoint: "approve_diagnosis" } : s),
    };
    const checkpointFixture = fixtureFor(checkpointProfile);
    const checkpointWorkIdentityScope = workIdentityScopeFixture(checkpointFixture, {
      workflow: "interp-checkpoint",
      stage_id: "diagnose",
      slot_id: "diagnostics",
    });

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
      run_identity: checkpointFixture.run_identity,
      work_identity_scope: checkpointWorkIdentityScope,
      branch,
      autonomous: false,
      classification: { type: "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "interp-checkpoint" },
      taskTool: interactive,
      project_identity: checkpointFixture.project_identity,
      catalog: checkpointFixture.catalog,
      effective_policy: checkpointFixture.effective_policy,
      agent_inventory: checkpointFixture.agent_inventory,
    });
    assert.ok(
      interactiveResult.outcomes.some((o) => o.status === "failed" && /checkpoint 'approve_diagnosis'/.test(o.note)),
      "interactive unresolved checkpoint blocks advance",
    );
    const interactiveState = JSON.parse(readFileSync(interactiveResult.statePath!, "utf8")) as TeamState;
    assert.equal(interactiveState.pause.kind, "user_checkpoint");
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
        run_identity: checkpointFixture.run_identity,
        work_identity_scope: checkpointWorkIdentityScope,
        branch,
        autonomous: true,
        classification: { type: "OPS", complexity: "MEDIUM", confidence: "HIGH", autonomous: true, workflow: "interp-checkpoint" },
        taskTool: autonomous,
        project_identity: checkpointFixture.project_identity,
        catalog: checkpointFixture.catalog,
        effective_policy: checkpointFixture.effective_policy,
        agent_inventory: checkpointFixture.agent_inventory,
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
    const allTypesFixture = fixtureFor(allTypesProfile);
    const taskTool: TaskCaller = {
      async call() { return { id: "x", output: "ok", artifacts: {}, exitCode: 0 }; },
      async batch() { return []; },
    };
    const allTypesWorkIdentityScope = workIdentityScopeFixture(allTypesFixture, {
      workflow: "interp-checkpoint-all-types",
      stage_id: "discovery",
      slot_id: "discovery",
    });
    const baseClassification = { type: "FEATURE" as const, complexity: "MEDIUM" as const, confidence: "HIGH" as const };

    // Interactive: the orchestrator's declared checkpoint blocks advance and
    // no later stage can run while it is unresolved.
    const interactiveResult = await run({
      task: "interactive all-types",
      cwd: root,
      run_identity: allTypesFixture.run_identity,
      work_identity_scope: allTypesWorkIdentityScope,
      branch,
      autonomous: false,
      classification: { ...baseClassification, autonomous: false, workflow: "interp-checkpoint-all-types" },
      taskTool,
      project_identity: allTypesFixture.project_identity,
      catalog: allTypesFixture.catalog,
      effective_policy: allTypesFixture.effective_policy,
      agent_inventory: allTypesFixture.agent_inventory,
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
        run_identity: allTypesFixture.run_identity,
        work_identity_scope: allTypesWorkIdentityScope,
        task: "autonomous all-types",
        cwd: root2,
        branch,
        autonomous: true,
        classification: { ...baseClassification, autonomous: true, workflow: "interp-checkpoint-all-types" },
        taskTool,
        project_identity: allTypesFixture.project_identity,
        catalog: allTypesFixture.catalog,
        effective_policy: allTypesFixture.effective_policy,
        agent_inventory: allTypesFixture.agent_inventory,
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
