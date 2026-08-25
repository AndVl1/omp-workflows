import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkpointPolicyLegacyConflict,
  migrationCheckpointPolicy,
  migrationCompletionIntent,
  validateTypedControlPlane,
} from "../src/engine/workflow-contract.js";
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
      acceptance: "dod_and_artifacts",
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

test("typed control-plane fields validate as one contract", () => {
  const fixture = validControlPlane();
  assert.equal(fixture.roster_policy.prefer_distinct_agents, true);
  assert.equal(fixture.roster_policy.selection_mode, "pre_dispatch_minimum_valid");
  const result = validateTypedControlPlane(fixture);
  assert.equal(result.ok, true);
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

test("completion intent and migration checkpoint policy remain orthogonal", () => {
  const intent = migrationCompletionIntent();
  const policy = migrationCheckpointPolicy("product_approval");
  const pendingPolicy = migrationCheckpointPolicy("approve_implementation");
  const pendingValidation = validateTypedControlPlane({ checkpoint_policy: pendingPolicy });
  assert.equal(intent.mode, "complete_outcome");
  assert.equal(intent.acceptance, "dod_and_artifacts");
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
