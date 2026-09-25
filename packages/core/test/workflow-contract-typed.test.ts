import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointPolicyLegacyConflict,
  migrationCheckpointPolicy,
  migrationCompletionIntent,
  resolveWorkflowContract,
  validateTypedControlPlane,
} from "../src/engine/workflow-contract.js";
import { profileHash, registerWorkflowProfiles, validateProfileControlPlane } from "../src/engine/profile.js";
import { persistCanonicalRun } from "../src/engine/run-store.js";
import type { CheckpointPolicy, Profile, TeamState, TrustedExecutionContext } from "../src/engine/types.js";

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

function snapshotTree(root: string): Array<[string, string]> {
  const files: Array<[string, string]> = [];
  const visit = (directory: string, relative: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const child = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) visit(path, child);
      else files.push([child, readFileSync(path).toString("base64")]);
    }
  };
  visit(root, "");
  return files;
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

test("stage input metadata validates safe ids, duplicates, overlap, and registration fail closed", () => {
  const baseProfile: Profile = {
    name: "optional-input-metadata",
    title: "Optional input metadata",
    description: "Profile validation fixture",
    match: { type: ["FEATURE"] },
    stages: [{ id: "stage", title: "Stage", type: "single", optional_consumes: ["product_spec"] }],
  };
  assert.deepEqual(validateProfileControlPlane(baseProfile), { ok: true });
  assert.doesNotThrow(() => registerWorkflowProfiles([baseProfile]));

  const invalidStages = [
    { consumes: ["../unsafe"] },
    { consumes: ["."] },
    { optional_consumes: [".."] },
    { optional_consumes: ["product_spec", "product_spec"] },
    { consumes: ["review", "review"] },
    { consumes: ["review"], optional_consumes: ["review"] },
  ];
  for (const [index, metadata] of invalidStages.entries()) {
    const invalid = {
      ...baseProfile,
      name: `optional-input-invalid-${index}`,
      stages: [{ ...baseProfile.stages[0], ...metadata }],
    } as Profile;
    const result = validateProfileControlPlane(invalid);
    assert.equal(result.ok, false, `metadata case ${index} must be rejected`);
    assert.throws(() => registerWorkflowProfiles([invalid]), /invalid workflow profile/);
  }
});

test("read-only selected-run discovery exposes pathless profile stages without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-contract-pathless-profile-"));
  const workflow = `pathless-${randomUUID()}`;
  const runId = randomUUID();
  const profile: Profile = {
    name: workflow,
    title: "Pathless profile",
    description: "Registered profile used by the read-only contract regression.",
    match: { type: ["FEATURE"] },
    stages: [
      {
        id: "discovery",
        title: "Discovery",
        type: "single",
        description: "Earlier semantic stage",
        prompt: "Gather the context needed by the implementation stage.",
        consumes: ["task_context"],
        optional_consumes: ["prior_notes"],
        produces: ["discovery_notes"],
      },
      { id: "implementation", title: "Implementation", type: "orchestrator" },
    ],
  };
  registerWorkflowProfiles([profile]);
  const execution: TrustedExecutionContext = {
    session_id: `pathless-profile-${runId}`,
    caller: "host",
    worktree: root,
    branch: "main",
    authority: "coordinator",
  };
  const state = {
    schema: 2,
    run_id: runId,
    run_key: runId,
    lifecycle_status: "active",
    rework_generation: 0,
    branch: "main",
    title: "Pathless profile discovery",
    task: "Discover the selected run's earlier stage meaning.",
    classification: {
      type: "FEATURE",
      complexity: "MEDIUM",
      confidence: "HIGH",
      autonomous: false,
      workflow,
    },
    required_inputs: { discovery: [], implementation: [] },
    required_input_receipts: {},
    decisions: [],
    workflow_override: true,
    issue: null,
    stage_cursor: "implementation",
    stages: [
      { id: "discovery", status: "done" },
      { id: "implementation", status: "in_progress" },
    ],
    artifacts: { discovery_notes: "artifacts/discovery_notes.json" },
    pause: { kind: "none", reason: "" },
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null },
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(profile),
    updated_at: "2026-09-25T00:00:00.000Z",
  } as TeamState;
  try {
    persistCanonicalRun(root, state, { context: execution });
    const runDir = join(root, ".work-state", "runs", runId);
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "discovery_notes.json"), "{\"meaning\":\"earlier stage\"}\n");
    mkdirSync(join(runDir, "revisions", "before-contract-read"), { recursive: true });
    writeFileSync(join(runDir, "revisions", "before-contract-read", "state.json"), "immutable pre-begin revision\n");

    const before = snapshotTree(join(root, ".work-state"));
    const contract = resolveWorkflowContract(root, { runId, branch: "main" });
    const after = snapshotTree(join(root, ".work-state"));

    assert.equal(contract.profile.path, null);
    assert.deepEqual(
      contract.profile.stages.map(({ id, title, type }) => ({ id, title, type })),
      [
        { id: "discovery", title: "Discovery", type: "single" },
        { id: "implementation", title: "Implementation", type: "orchestrator" },
      ],
    );
    const earlier = contract.profile.stages[0];
    assert.ok(earlier);
    assert.deepEqual(earlier.consumes, ["task_context"]);
    assert.deepEqual(earlier.optional_consumes, ["prior_notes"]);
    assert.deepEqual(earlier.produces, ["discovery_notes"]);
    assert.equal(typeof earlier.description, "string");
    assert.equal(typeof earlier.prompt, "string");
    assert.deepEqual(Object.keys(earlier).sort(), [
      "consumes",
      "description",
      "id",
      "optional_consumes",
      "produces",
      "prompt",
      "title",
      "type",
    ]);
    assert.deepEqual(Object.keys(contract.profile.stages[1]!).sort(), ["id", "title", "type"]);
    assert.equal(contract.stage.id, "implementation");
    assert.equal(contract.stage.dispatch.permitted, false, "read-only pre-begin discovery never grants dispatch authority");
    assert.deepEqual(after, before, "contract discovery must not mutate selected canonical state or its control, revisions, or artifacts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
