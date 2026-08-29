/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendRetiredCapability,
  reopenFromFeedback,
  retireCurrentCapability,
} from "../src/engine/state.js";
import { createCapability, type IssuedCapability } from "../src/engine/durable.js";
import type {
  CheckpointDecision,
  ChildJoin,
  CompletionEnvelope,
  JoinSummary,
  RetiredCapability,
  RosterSelection,
  StageSlotRecords,
  TeamState,
  TrustedCheckpointAnswer,
  TypedCheckpointDecision,
} from "../src/engine/types.js";
import {
  readWorkflowProfile,
  workIdentityFixture,
  workIdentityScopeFixture,
  workflowV2Fixture,
  type WorkflowV2TestFixture,
} from "./workflow-v2-fixtures.js";

const WORKFLOW = "lightweight" as const;
const CURRENT_STAGE = "implementation";
const UPSTREAM_STAGE = "discovery";
const BRANCH = "feat/workflow-v2-retirement";
const NOW = "2026-08-28T00:00:00.000Z";

function capabilityFor(fixture: WorkflowV2TestFixture, label: string): IssuedCapability {
  const issued = createCapability({
    run_key: BRANCH,
    branch: BRANCH,
    workflow: WORKFLOW,
    profile_hash: fixture.profile_identity.fingerprint,
    stage_cursor: CURRENT_STAGE,
    kind: "none",
    work_identity_scope: workIdentityScopeFixture(fixture, {
      workflow: WORKFLOW,
      stage_id: CURRENT_STAGE,
      slot_id: `retirement-slot-${label}`,
      task_id: `retirement-task-${label}`,
      dispatch_id: `retirement-dispatch-${label}`,
    }),
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
  });

  // Capability ids and epochs are opaque strings. Replacing the generated
  // values keeps the ledger test deterministic while preserving every other
  // field produced by the real capability factory.
  const capability_id = `retirement-capability-${label}`;
  const capability_epoch = `retirement-epoch-${label}`;
  const work_identity = {
    ...issued.work_identity,
    capability_id,
    capability_epoch,
  };
  const state = {
    ...issued.state,
    capability_id,
    issued_for: { ...issued.state.issued_for, cursor_epoch: capability_epoch },
    work_identity,
  };
  return { ...issued, capability_id, work_identity, state };
}

function completionEnvelope(fixture: WorkflowV2TestFixture, issued: IssuedCapability): CompletionEnvelope {
  return {
    schema_version: 1,
    identity: issued.work_identity,
    run_identity: fixture.run_identity,
    outcome: "succeeded",
    terminal_signal: "workflow_complete",
    artifact_refs: [],
    evidence_ref: "retirement/evidence",
    conflict_ref: null,
    completed_by: "workflow_complete",
    emitted_at: NOW,
  };
}

function currentRosterSelection(fixture: WorkflowV2TestFixture, issued: IssuedCapability, stage_id = CURRENT_STAGE): RosterSelection {
  return {
    snapshot_id: `retirement-selection-${stage_id}`,
    run_key: BRANCH,
    wave_id: issued.work_identity.wave_id,
    slice_id: issued.work_identity.slice_id,
    session_id: fixture.project_identity.session.session_id,
    workflow: WORKFLOW,
    stage_id,
    profile_hash: fixture.profile_identity.fingerprint,
    policy_hash: "retirement-policy-hash",
    scope_hash: "retirement-scope-hash",
    mapping_hash: "retirement-mapping-hash",
    capability_epoch: issued.work_identity.capability_epoch,
    selected: [],
    omitted: [],
    triggers: [],
    stop_reason: "minimum_valid_set",
    selected_at: NOW,
    frozen_at: NOW,
  };
}

function currentChildJoin(fixture: WorkflowV2TestFixture, issued: IssuedCapability): ChildJoin {
  const child = workIdentityFixture(fixture, {
    workflow: WORKFLOW,
    stage_id: CURRENT_STAGE,
    slot_id: "retirement-child",
    task_id: "retirement-child-task",
    dispatch_id: "retirement-child-dispatch",
    capability_id: issued.capability_id,
    capability_epoch: issued.work_identity.capability_epoch,
  });
  return {
    run_identity: fixture.run_identity,
    parent: issued.work_identity,
    child,
    state: "succeeded",
    expected_artifact_ids: [],
    completion_envelope_ref: null,
    attempt: 1,
    created_at: NOW,
    joined_at: NOW,
  };
}

function currentJoinSummary(fixture: WorkflowV2TestFixture, issued: IssuedCapability): JoinSummary {
  return {
    stage_id: CURRENT_STAGE,
    run_identity: fixture.run_identity,
    cursor_epoch: issued.work_identity.capability_epoch,
    dispatch_ids: [issued.work_identity.dispatch_id],
    roles: [],
    evidence: "retirement join audit",
    joined_at: NOW,
    work_identity: issued.work_identity,
  };
}

function baseState(fixture: WorkflowV2TestFixture, issued: IssuedCapability): TeamState {
  const completion = completionEnvelope(fixture, issued);
  const upstreamDecision: CheckpointDecision = {
    stage_id: UPSTREAM_STAGE,
    checkpoint: "confirm_understanding",
    mode: "interactive",
    decision: "proceed",
    actor: "user",
    rationale: "upstream decision must survive reopening",
    decided_at: NOW,
    run_identity: fixture.run_identity,
  };
  const typedUpstreamDecision: TypedCheckpointDecision = {
    run_id: fixture.run_identity.run_id,
    stage_id: UPSTREAM_STAGE,
    checkpoint_id: "confirm_understanding",
    checkpoint_kind: "clarification",
    decision: "proceed",
    authorization: "human",
    actor: { kind: "user", ref: "test-user" },
    capability_id: issued.capability_id,
    capability_epoch: issued.work_identity.capability_epoch,
    policy_hash: "retirement-policy-hash",
    rationale: "typed upstream decision must survive reopening",
    decided_at: NOW,
    run_identity: fixture.run_identity,
  };
  const trustedUpstreamAnswer: TrustedCheckpointAnswer = {
    answer_id: "retirement/upstream-answer",
    nonce: "retirement-nonce",
    channel: "terminal",
    reference: "terminal/retirement/upstream-answer",
    run_id: fixture.run_identity.run_id,
    stage_id: UPSTREAM_STAGE,
    checkpoint_id: "confirm_understanding",
    work_identity_hash: "retirement-work-identity-hash",
    capability_id: issued.capability_id,
    capability_epoch: issued.work_identity.capability_epoch,
    policy_hash: "retirement-policy-hash",
    decision: "proceed",
    binding: "retirement-binding",
    issued_at: NOW,
  };
  const upstreamSlotArtifacts: StageSlotRecords = {
    slots: {
      upstream: {
        discovery: { path: "artifacts/discovery.json", hash: "upstream-discovery-hash" },
      },
    },
  };
  const reopenedSlotArtifacts: StageSlotRecords = {
    slots: {
      current: {
        implementation: { path: "artifacts/implementation.json", hash: "downstream-implementation-hash" },
      },
    },
  };

  return {
    schema: 1,
    branch: BRANCH,
    run_key: BRANCH,
    workflow: WORKFLOW,
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    classification: {
      type: "FEATURE",
      complexity: "QUICK",
      confidence: "HIGH",
      workflow: WORKFLOW,
      autonomous: false,
    },
    task: "preserve upstream lifecycle state",
    history: [{ task: "initial upstream task", feedback: "upstream feedback", at: NOW }],
    workflow_override: false,
    issue: null,
    stage_cursor: CURRENT_STAGE,
    cursor_epoch: issued.work_identity.capability_epoch,
    stages: readWorkflowProfile(WORKFLOW).stages.map((stage) => ({ id: stage.id, status: "done" as const })),
    artifacts: {
      discovery: "artifacts/discovery.json",
      implementation: "artifacts/implementation.json",
    },
    pause: { kind: "done", reason: "workflow complete" },
    policy: { strict_orchestrator: true },
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: null },
    dispatch_capability: { ...issued.state, status: "complete" },
    work_identity: issued.work_identity,
    pending: {
      identity: issued.work_identity,
      run_identity: fixture.run_identity,
      status: "succeeded",
      updated_at: NOW,
    },
    completion_envelope: completion,
    child_join: currentChildJoin(fixture, issued),
    join_summary: currentJoinSummary(fixture, issued),
    roster_selection: currentRosterSelection(fixture, issued),
    roster_selections: {
      [UPSTREAM_STAGE]: currentRosterSelection(fixture, issued, UPSTREAM_STAGE),
      [CURRENT_STAGE]: currentRosterSelection(fixture, issued),
    },
    slot_artifacts: {
      [UPSTREAM_STAGE]: upstreamSlotArtifacts,
      [CURRENT_STAGE]: reopenedSlotArtifacts,
    },
    checkpoint_decisions: [upstreamDecision],
    typed_checkpoint_decisions: [typedUpstreamDecision],
    trusted_checkpoint_answers: [trustedUpstreamAnswer],
    retired_capabilities: [],
    updated_at: NOW,
  };
}

function archiveFor(fixture: WorkflowV2TestFixture, label: string): { state: TeamState; entry: RetiredCapability } {
  const issued = capabilityFor(fixture, label);
  const retired = retireCurrentCapability(baseState(fixture, issued), `retirement-${label}`);
  const entry = retired.retired_capabilities?.[0];
  assert.ok(entry, `retirement-${label} must produce an archive entry`);
  return { state: retired, entry };
}

function assertLifecycleDiagnostic(error: unknown, remediation: RegExp): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.name, "WorkflowLifecycleError");
  const diagnostic = (error as Error & { diagnostic?: { code?: string; operation?: string; remediation?: string } }).diagnostic;
  assert.equal(diagnostic?.code, "MIGRATION_REQUIRED");
  assert.equal(diagnostic?.operation, "binding.write");
  assert.match(diagnostic?.remediation ?? "", remediation);
  assert.match(error.message, /MIGRATION_REQUIRED:/);
  return true;
}

test("workflow v2 retirement archives the current identity, clears authority, and preserves upstream state", () => {
  const fixture = workflowV2Fixture(readWorkflowProfile(WORKFLOW), { runId: "retirement-reopen-run" });
  const issued = capabilityFor(fixture, "reopen");
  const state = baseState(fixture, issued);
  const upstreamHistory = state.history?.[0];
  const upstreamDecision = state.checkpoint_decisions?.[0];
  const upstreamTypedDecision = state.typed_checkpoint_decisions?.[0];
  const upstreamAnswer = state.trusted_checkpoint_answers?.[0];

  const reopened = reopenFromFeedback(state, "implementation needs another pass", CURRENT_STAGE);

  assert.equal(reopened.stages.find((stage) => stage.id === UPSTREAM_STAGE)?.status, "done");
  assert.ok(reopened.stages.slice(1).every((stage) => stage.status === "pending"));
  assert.equal(reopened.stage_cursor, CURRENT_STAGE);
  assert.match(reopened.task, /implementation needs another pass/);
  assert.deepEqual(reopened.artifacts?.discovery, state.artifacts.discovery, "upstream artifact survives reopening");
  assert.deepEqual(reopened.history?.[0], upstreamHistory, "prior history survives reopening");
  assert.equal(reopened.history?.length, 2, "reopening appends one feedback history record");
  assert.deepEqual(reopened.checkpoint_decisions?.[0], upstreamDecision, "legacy upstream decision survives reopening");
  assert.deepEqual(reopened.typed_checkpoint_decisions?.[0], upstreamTypedDecision, "typed upstream decision survives reopening");
  assert.deepEqual(reopened.trusted_checkpoint_answers?.[0], upstreamAnswer, "trusted audit answer survives reopening");
  assert.ok(reopened.roster_selections?.[UPSTREAM_STAGE], "upstream roster selection survives reopening");
  assert.equal(reopened.roster_selections?.[CURRENT_STAGE], undefined, "reopened roster selection is cleared");
  assert.ok(reopened.slot_artifacts?.[UPSTREAM_STAGE], "upstream slot audit survives reopening");
  assert.equal(reopened.slot_artifacts?.[CURRENT_STAGE], undefined, "reopened slot bindings are cleared");

  const retired = reopened.retired_capabilities;
  assert.equal(retired?.length, 1);
  const archive = retired?.[0];
  assert.ok(archive);
  if (!archive) return;
  assert.equal(archive.capability_id, issued.capability_id);
  assert.equal(archive.capability_epoch, issued.work_identity.capability_epoch);
  assert.deepEqual(archive.work_identity, issued.work_identity);
  assert.deepEqual(archive.dispatch_capability, state.dispatch_capability);
  assert.equal(archive.completion_outcome, "succeeded");
  assert.deepEqual(archive.completion_envelope, state.completion_envelope);
  assert.equal(archive.reason, "reopen_from_feedback");
  assert.ok(archive.retired_at);

  for (const field of [
    "dispatch_capability",
    "work_identity",
    "pending",
    "completion_envelope",
    "child_join",
    "join_summary",
    "roster_selection",
  ] as const) {
    assert.equal(Object.prototype.hasOwnProperty.call(reopened, field), false, `${field} must be retired from current authority`);
  }
});

test("workflow v2 retirement archive replay is idempotent and rejects conflicting same-key history", () => {
  const fixture = workflowV2Fixture(readWorkflowProfile(WORKFLOW), { runId: "retirement-replay-run" });
  const { state, entry } = archiveFor(fixture, "replay");
  const before = structuredClone(state);
  const equivalent = structuredClone(entry);

  const replayed = appendRetiredCapability(state, equivalent);
  assert.strictEqual(replayed, state, "equivalent replay returns the unchanged state");
  assert.deepEqual(replayed, before, "equivalent replay does not mutate the ledger");
  assert.equal(replayed.retired_capabilities?.length, 1);

  const conflicting = { ...equivalent, reason: "conflicting-retirement" };
  assert.throws(
    () => appendRetiredCapability(state, conflicting),
    (error: unknown) => assertLifecycleDiagnostic(error, /conflicting capability history/),
  );
  assert.deepEqual(state, before, "conflicting replay does not mutate the ledger");
});

test("workflow v2 retirement ledger accepts 128 distinct keys and fails closed on the 129th", () => {
  const fixture = workflowV2Fixture(readWorkflowProfile(WORKFLOW), { runId: "retirement-ledger-run" });
  const first = archiveFor(fixture, "0");
  let state = first.state;
  for (let index = 1; index < 128; index += 1) {
    state = appendRetiredCapability(state, archiveFor(fixture, String(index)).entry);
  }

  assert.equal(state.retired_capabilities?.length, 128);
  assert.equal(new Set(state.retired_capabilities?.map((entry) => `${entry.capability_id}:${entry.capability_epoch}`)).size, 128);
  const beforeOverflow = structuredClone(state);
  const overflow = archiveFor(fixture, "128").entry;

  assert.throws(
    () => appendRetiredCapability(state, overflow),
    (error: unknown) => assertLifecycleDiagnostic(error, /per-run limit is 128/),
  );
  assert.deepEqual(state, beforeOverflow, "overflow rejection does not truncate or replace retirement history");
});
