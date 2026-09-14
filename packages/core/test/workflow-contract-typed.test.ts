import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  checkpointPolicyLegacyConflict,
  migrationCheckpointPolicy,
  migrationCompletionIntent,
  resolveWorkflowContract,
  validateTypedControlPlane,
  WorkflowContractError,
} from "../src/engine/workflow-contract.js";
import { normalizePersistedState } from "../src/engine/state.js";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { implementationConformanceMatrixDigest } from "../src/specification/validation.js";
import {
  validFeatureWorkspace,
  validImplementationConformance,
  validImplementationHandoff,
} from "./fixtures/specification-fixtures.js";
import type { TeamState } from "../src/engine/types.js";
import type { ImplementationConformanceResult } from "../src/specification/types.js";
test("workflow contract requires explicit migration for persisted state without classification", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-contract-legacy-classification-"));
  try {
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(join(root, ".work-state", "team-state.json"), JSON.stringify({
      schema: 1,
      branch: "main",
      task: "legacy state",
      workflow_override: false,
      issue: null,
      stage_cursor: profile.stages[0]!.id,
      stages: profile.stages.map((stage) => ({ id: stage.id, status: "pending" })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      updated_at: "2026-08-25T00:00:00Z",
    }));
    assert.throws(
      () => resolveWorkflowContract(root, { workflow: "lightweight", branch: "main" }),
      (error: unknown) => error instanceof WorkflowContractError
        && error.code === "SPEC_MIGRATION_REQUIRED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import type { CheckpointPolicy } from "../src/engine/types.js";

const identity = {
  run_id: "run-1",
  wave_id: "wave-1",
  slice_id: "slice-1",
  session_id: "session-1",
  workflow: "standard",
  stage_id: "implementation",
  stage_cursor: "implementation",
  capability_id: "cap-1",
  capability_epoch: "epoch-1",
  slot_id: "analyst#1",
  task_id: "task-1",
  dispatch_id: "dispatch-1",
  attempt: 1,
  worker_id: "worker-1",
};

const typedPolicy: CheckpointPolicy = {
  default: "required_human",
  scope: "decision",
  hard_human: ["product_approval"],
  rules: {
    approve_implementation: {
      kind: "implementation_approval",
      default: "required_human",
      allowed_decisions: ["proceed", "reject"],
      phase: "before_advance",
      rationale: "The user owns the implementation approval.",
    },
  },
  source: "profile",
  policy_version: 1,
  rationale: "Typed policy is authoritative for this run.",
};

const typedRosterPolicy = {
  allowed_roles: ["analyst", "architect"],
  required_roles: ["analyst"],
  required_facets: ["edge-cases"],
  min_workers: 1,
  max_workers: 2,
  multiplicity: {
    analyst: { min: 1, max: 2 },
    architect: { min: 0, max: 1 },
  },
  prefer_distinct_agents: true,
  selection_mode: "pre_dispatch_minimum_valid",
  triggers: {
    complexity: ["COMPLEX"],
    confidence: ["LOW"],
    scope_flags: ["has_security"],
    evidence: ["conflicting"],
  },
  budget: { token_limit: null, dollar_limit: null },
};

const selection = {
  snapshot_id: "selection-1",
  run_key: "run-1",
  wave_id: "wave-1",
  slice_id: "slice-1",
  session_id: "session-1",
  workflow: "standard",
  stage_id: "implementation",
  profile_hash: "profile-hash",
  policy_hash: "policy-hash",
  scope_hash: "scope-hash",
  mapping_hash: "mapping-hash",
  capability_epoch: "epoch-1",
  selected: [{ slot_id: "analyst#1", role: "analyst", occurrence: 1, facet: "edge-cases", agent: "analyst", reason: "Required facet" }],
  omitted: [{ role: "architect", reason: "Optional after minimum valid set" }],
  triggers: ["complexity:COMPLEX"],
  stop_reason: "minimum_valid_set",
  selected_at: "2026-08-25T00:00:00Z",
  frozen_at: "2026-08-25T00:00:00Z",
};

function validControlPlane() {
  return {
    completion_intent: {
      mode: "complete_outcome",
      acceptance: "quality_gates_and_artifacts",
      source: "user",
      rationale: "The caller requested a completed, verified outcome.",
    },
    checkpoint_policy: typedPolicy,
    roster_policy: typedRosterPolicy,
    roster_selection: selection,
    work_identity: identity,
    pending: { identity, status: "pending", pending_reason: "provider_running", updated_at: "2026-08-25T00:00:00Z" },
    child_join: {
      parent: identity,
      child: { ...identity, slot_id: "child#1", task_id: "child-task", dispatch_id: "child-dispatch" },
      state: "pending",
      expected_artifact_ids: ["implementation"],
      completion_envelope_ref: null,
      attempt: 1,
      created_at: "2026-08-25T00:00:00Z",
      joined_at: "2026-08-25T00:00:00Z",
    },
    completion_envelope: {
      schema_version: 1,
      identity,
      outcome: "pending",
      terminal_signal: null,
      artifact_refs: [],
      evidence_ref: null,
      conflict_ref: null,
      completed_by: "workflow_complete",
      emitted_at: "2026-08-25T00:00:00Z",
    },
  };
}

function terminalAuthorityFixture(): {
  root: string;
  featureId: string;
  runKey: string;
  authority: {
    claim_id: string;
    owner_kind: "do_work";
    owner_run_id: string;
    status: "active";
    handoff_digest: string;
    evidence_identity: string;
  };
} {
  const root = mkdtempSync(join(tmpdir(), "workflow-terminal-authority-"));
  const canonicalRoot = realpathSync(root);
  const featureId = "terminal-authority-feature";
  const runKey = "terminal-authority-run";
  const profile = loadProfile("constitution");
  if (!profile) throw new Error("constitution profile is unavailable");
  const handoff = validImplementationHandoff({ featureId });
  const conformance = validImplementationConformance({ featureId, handoffDigest: handoff.handoff_digest }) as unknown as ImplementationConformanceResult;
  conformance.execution_claim_id = "claim-terminal-authority";
  conformance.execution_owner = "do_work";
  conformance.execution_run_id = runKey;
  conformance.matrix_digest = implementationConformanceMatrixDigest(conformance)!;
  conformance.conformance_id = `implementation-conformance.${conformance.matrix_digest}`;
  const workspace = validFeatureWorkspace({
    featureId,
    projectRoot: canonicalRoot,
    withApprovedSpecify: true,
    status: "executing",
  });
  workspace.handoff_ref = handoff.handoff_id;
  workspace.execution_claim_ref = conformance.execution_claim_id;
  workspace.implementation_conformance_ref = conformance.conformance_id;
  workspace.profile_hash = conformance.profile_hash;
  const artifactsDir = join(root, ".work-state", "features", featureId, "artifacts");
  workspace.phases[1]!.current_version = 1;
  workspace.phases[2]!.current_version = 1;
  workspace.phases[1]!.status = "generating";
  workspace.phases[2]!.status = "generating";
  workspace.phases[1]!.upstream_versions = [{ phase: "specify", version: 1, hash: "a".repeat(64) }];
  workspace.phases[2]!.upstream_versions = [
    { phase: "specify", version: 1, hash: "a".repeat(64) },
    { phase: "plan", version: 1, hash: "b".repeat(64) },
  ];
  mkdirSync(join(artifactsDir, "implementation_conformance"), { recursive: true });
  writeFileSync(join(artifactsDir, "implementation_conformance", `${conformance.conformance_id}.json`), JSON.stringify(conformance));
  const state: TeamState = {
    schema: 1,
    run_key: runKey,
    branch: "test",
    classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false, workflow: "constitution" },
    task: "terminal authority contract",
    workflow_override: false,
    checkpoint_policy: profile.checkpoint_policy,
    issue: null,
    stage_cursor: profile.stages[0]!.id,
    stages: profile.stages.map((stage) => ({ id: stage.id, status: "done" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    profile_hash: profileHash(profile),
    dispatch_capability: {},
    specification: workspace as TeamState["specification"],
    updated_at: "2026-08-31T12:00:00.000Z",
  };
  mkdirSync(join(root, "specs", featureId), { recursive: true });
  const featureDir = join(root, ".work-state", "features", featureId);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, "state.json"), JSON.stringify(state));
  const rejectionIssues: string[] = [];
  if (!normalizePersistedState(state, rejectionIssues)) throw new Error(`terminal fixture state invalid: ${rejectionIssues.join("; ")}`);
  return {
    root,
    featureId,
    runKey,
    authority: {
      claim_id: conformance.execution_claim_id,
      owner_kind: "do_work",
      owner_run_id: conformance.execution_run_id,
      status: "active",
      handoff_digest: conformance.handoff_digest,
      evidence_identity: conformance.conformance_id,
    },
  };
}

test("typed control-plane fields validate as one contract", () => {
  const fixture = validControlPlane();
  assert.equal(fixture.roster_policy.prefer_distinct_agents, true);
  assert.equal(fixture.roster_policy.selection_mode, "pre_dispatch_minimum_valid");
  const result = validateTypedControlPlane(fixture);
  assert.equal(result.ok, true);
});
test("typed control-plane accepts exact pending native reconciliation", () => {
  const fixture = validControlPlane() as unknown as Record<string, any>;
  fixture.pending.reconciliation = {
    identity,
    result_digest: "a".repeat(64),
    outcome: "succeeded",
    evidence: "native artifact reconciliation",
    artifact_ids: ["implementation"],
    terminal_signal: "native_tool_result",
    provider_id: "native-provider",
    updated_at: "2026-08-25T00:00:00Z",
  };
  const result = validateTypedControlPlane(fixture);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
});

test("resolveWorkflowContract validates active dispatch capability pending arrays in wrapper shape", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-contract-dispatch-capability-"));
  try {
    const profile = loadProfile("lightweight");
    assert.ok(profile);
    const stageId = profile.stages[0]!.id;
    const now = "2026-08-25T00:00:00Z";
    const pendingIdentity = {
      ...identity,
      run_id: "dispatch-contract-run",
      workflow: "lightweight",
      stage_id: stageId,
      stage_cursor: stageId,
    };
    const pending = {
      identity: pendingIdentity,
      status: "pending",
      pending_reason: "provider_running",
      updated_at: now,
    };
    const capability = {
      kind: "single",
      capability_id: "cap-1",
      expected_count: 1,
      work_identity: pendingIdentity,
      pending: [pending],
      status: "dispatched",
      dispatches: [],
    };
    const completionEnvelope = {
      schema_version: 1,
      identity: pendingIdentity,
      outcome: "pending",
      terminal_signal: null,
      artifact_refs: [],
      evidence_ref: null,
      conflict_ref: null,
      completed_by: "workflow_complete",
      emitted_at: now,
    };
    const state = {
      schema: 1,
      run_key: "dispatch-contract-run",
      branch: "main",
      task: "dispatch capability contract",
      workflow_override: false,
      issue: null,
      classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: true, workflow: "lightweight" },
      stage_cursor: stageId,
      stages: profile.stages.map((stage, index) => ({ id: stage.id, status: index === 0 ? "in_progress" : "pending" })),
      artifacts: {},
      pause: { kind: "none", reason: "" },
      updated_at: now,
      dispatch_capability: capability,
    };
    const statePath = join(root, ".work-state", "team-state.json");
    mkdirSync(join(root, ".work-state"), { recursive: true });
    const writeState = (value: unknown, envelope?: unknown): void => writeFileSync(
      statePath,
      JSON.stringify({ ...state, dispatch_capability: value, ...(envelope === undefined ? {} : { completion_envelope: envelope }) }),
    );

    writeState(capability);
    const resolved = resolveWorkflowContract(root, { workflow: "lightweight", branch: "main" });
    assert.equal(resolved.stage.dispatch.capability_id, "cap-1");
    assert.equal(resolved.pending?.identity.dispatch_id, pendingIdentity.dispatch_id);
    assert.equal(resolved.status.lifecycle, "pending", "active capability pending array resolves to a pending lifecycle");

    for (const pendingStatus of ["authorized", "running", "pending"] as const) {
      writeState(
        { ...capability, pending: [{ ...pending, status: pendingStatus }] },
        { ...completionEnvelope, outcome: "pending" },
      );
      const mapped = resolveWorkflowContract(root, { workflow: "lightweight", branch: "main" });
      assert.equal(mapped.pending?.status, pendingStatus, "nonterminal pending status resolves with a pending envelope");
      assert.equal(mapped.status.lifecycle, "pending");
    }

    writeState(
      { ...capability, pending: [{ ...pending, status: "succeeded" }] },
      { ...completionEnvelope, outcome: "failed", terminal_signal: "workflow_complete" },
    );
    assert.throws(
      () => resolveWorkflowContract(root, { workflow: "lightweight", branch: "main" }),
      (error: unknown) => error instanceof WorkflowContractError
        && error.code === "MIGRATION_CONFLICT"
        && error.message.includes("pending lifecycle and completion_envelope outcomes conflict"),
      "terminal pending status cannot resolve against a different completion outcome",
    );

    writeState({ ...capability, pending: [{ ...pending, unexpected: true }] });
    assert.throws(
      () => resolveWorkflowContract(root, { workflow: "lightweight", branch: "main" }),
      (error: unknown) => error instanceof WorkflowContractError
        && error.code === "POLICY_INVALID"
        && error.message.includes("$.dispatch_capability.pending[0].unexpected"),
      "malformed pending entries are rejected at their wrapped dispatch capability path",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown and malformed typed fields fail closed", () => {
  const unknownIntent = validControlPlane();
  (unknownIntent.completion_intent as Record<string, unknown>).unexpected = true;
  const unknownResult = validateTypedControlPlane(unknownIntent);
  assert.equal(unknownResult.ok, false);
  if (!unknownResult.ok) assert.ok(unknownResult.issues.some((issue) => issue.path.endsWith("completion_intent.unexpected")));

  const conflictingPolicy = validControlPlane();
  conflictingPolicy.checkpoint_policy = {
    ...typedPolicy,
    default: "autonomous_allowed",
    hard_human: ["product_approval"],
    rules: {
      product_approval: {
        kind: "product_approval",
        default: "autonomous_allowed",
        allowed_decisions: ["proceed"],
        phase: "before_advance",
        rationale: "Invalid downgrade",
      },
    },
  } as unknown as typeof conflictingPolicy.checkpoint_policy;
  const policyResult = validateTypedControlPlane(conflictingPolicy);
  assert.equal(policyResult.ok, false);
  if (!policyResult.ok) assert.ok(policyResult.issues.some((issue) => issue.path.includes("product_approval")));

  const invalidRoster = validControlPlane();
  invalidRoster.roster_policy = { ...typedRosterPolicy, min_workers: 3, max_workers: 1 };
  const rosterResult = validateTypedControlPlane(invalidRoster);
  assert.equal(rosterResult.ok, false);
  if (!rosterResult.ok) assert.ok(rosterResult.issues.some((issue) => issue.path === "$.roster_policy"));
  assert.equal(checkpointPolicyLegacyConflict(typedPolicy, true), null);
  assert.match(checkpointPolicyLegacyConflict({ ...typedPolicy, source: "migration" }, true) ?? "", /conflicts/);
});
test("trusted checkpoint answers validate selected bindings without breaking legacy records", () => {
  const legacyAnswer = {
    answer_id: "answer-1",
    nonce: "nonce-1",
    channel: "terminal",
    reference: "terminal/answer-1",
    run_id: "run-1",
    stage_id: "implementation",
    checkpoint_id: "approve_implementation",
    work_identity_hash: "a".repeat(64),
    capability_id: "cap-1",
    capability_epoch: "epoch-1",
    policy_hash: "b".repeat(64),
    decision: "approve",
    binding: "c".repeat(64),
    issued_at: "2026-08-25T00:00:00Z",
  };
  const legacyResult = validateTypedControlPlane({
    ...validControlPlane(),
    trusted_checkpoint_answers: [legacyAnswer],
  });
  assert.equal(legacyResult.ok, true);

  const selectedAnswer = {
    ...legacyAnswer,
    feature_id: "feature.alpha-1",
    loop_iteration: 1,
    subject_binding: "d".repeat(64),
    subject_revision: 0,
  };
  const selectedResult = validateTypedControlPlane({
    ...validControlPlane(),
    trusted_checkpoint_answers: [selectedAnswer],
  });
  assert.equal(selectedResult.ok, true);

  const invalid = (answer: Record<string, unknown>, field: string): void => {
    const result = validateTypedControlPlane({
      ...validControlPlane(),
      trusted_checkpoint_answers: [answer],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.path.endsWith(`trusted_checkpoint_answers[0].${field}`)));
  };
  invalid({ ...selectedAnswer, unexpected: true }, "unexpected");
  invalid({ ...selectedAnswer, feature_id: "Feature" }, "feature_id");
  invalid({ ...selectedAnswer, feature_id: "a".repeat(129) }, "feature_id");
  invalid({ ...selectedAnswer, feature_id: "feature%2Fescape" }, "feature_id");
  invalid({ ...selectedAnswer, loop_iteration: 0 }, "loop_iteration");
  invalid({ ...selectedAnswer, loop_iteration: 1_000_001 }, "loop_iteration");
  invalid({ ...selectedAnswer, subject_binding: "D".repeat(64) }, "subject_binding");
  invalid({ ...selectedAnswer, subject_binding: "not-a-digest" }, "subject_binding");
  invalid({ ...selectedAnswer, subject_revision: -1 }, "subject_revision");
  invalid({ ...selectedAnswer, subject_revision: Number.MAX_SAFE_INTEGER + 1 }, "subject_revision");
});


test("completion intent and migration checkpoint policy remain orthogonal", () => {
  const intent = migrationCompletionIntent();
  const policy = migrationCheckpointPolicy("product_approval");
  const pendingPolicy = migrationCheckpointPolicy("approve_implementation");
  const pendingValidation = validateTypedControlPlane({ checkpoint_policy: pendingPolicy });
  assert.equal(intent.mode, "complete_outcome");
  assert.equal(intent.acceptance, "quality_gates_and_artifacts");
  assert.equal(policy.default, "required_human");
  assert.deepEqual(policy.rules.product_approval?.allowed_decisions, ["proceed", "needs_more_validation", "defer", "reject"]);
  assert.deepEqual(pendingPolicy.rules.approve_implementation?.allowed_decisions, []);
  assert.equal(pendingValidation.ok, true);
});

test("workflow schema declares the same typed control-plane definitions", () => {
  const schema = JSON.parse(readFileSync(new URL("../workflows/_schema.json", import.meta.url), "utf8")) as {
    properties: Record<string, { $ref?: string }>;
    definitions: Record<string, unknown>;
  };
  assert.equal(schema.properties.completion_intent?.$ref, "#/definitions/completionIntent");
  assert.equal(schema.properties.checkpoint_policy?.$ref, "#/definitions/checkpointPolicy");
  for (const definition of [
    "completionIntent", "checkpointPolicy", "checkpointRule", "checkpointDecision", "typedCheckpointDecision", "checkpointActor",
    "rosterPolicy", "rosterSelection", "workIdentity", "pendingState", "childJoin", "completionEnvelope", "migrationReceipt",
  ]) assert.ok(schema.definitions[definition], `missing schema definition ${definition}`);
});

test("terminal workflow contract requires the exact current authority projection", () => {
  const fixture = terminalAuthorityFixture();
  try {
    const options = {
      branch: "test",
      selector: { feature_id: fixture.featureId, run_key: fixture.runKey },
    } as const;
    const satisfied = resolveWorkflowContract(fixture.root, { ...options, terminal_authority: fixture.authority });
    assert.deepEqual(satisfied.terminal_conformance, { required: true, satisfied: true, reason: null });

    const missing = resolveWorkflowContract(fixture.root, options);
    assert.equal(missing.terminal_conformance.required, true);
    assert.equal(missing.terminal_conformance.satisfied, false);
    assert.match(missing.terminal_conformance.reason ?? "", /authority projection is unavailable/);

    const forged = resolveWorkflowContract(fixture.root, {
      ...options,
      terminal_authority: { ...fixture.authority, owner_run_id: "foreign-run" },
    });
    assert.equal(forged.terminal_conformance.satisfied, false);
    assert.match(forged.terminal_conformance.reason ?? "", /does not bind the active workspace/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
