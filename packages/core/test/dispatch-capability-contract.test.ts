/**
 * Nested dispatch-capability contract regressions:
 *   - a capability's `pending` is a legal `PendingState[]` lifecycle log and
 *     resolves through resolveWorkflowContract; it must never be revalidated
 *     against the root-state single-object contract (which fails with
 *     "$.pending must be an object");
 *   - the root-state `pending` stays a single-object contract, so an
 *     array-shaped pending at the state root remains rejected;
 *   - malformed nested capability entries fail at their exact paths.
 *
 * Fixtures construct genuinely valid durable single capabilities: roster,
 * dispatch record and work identity all agree (slot_id equals the roster
 * role, dispatch_id equals the record id), so the resolver proves a valid
 * persisted capability instead of one that silently bypasses the
 * active-capability invariants.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { createCapability } from "../src/engine/durable.js";
import { resolveWorkflowContract, validateDispatchCapability, validateTypedControlPlane, WorkflowContractError } from "../src/engine/workflow-contract.js";
import type { DispatchCapabilityState, PendingState, WorkIdentity } from "../src/engine/types.js";

const TIMESTAMP = "2026-08-30T00:00:00Z";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

function workIdentity(capability: DispatchCapabilityState): WorkIdentity {
  const issued = capability.issued_for!;
  return {
    run_id: RUN_ID,
    wave_id: "wave-1",
    slice_id: "slice-1",
    session_id: "session-1",
    workflow: "feature-regression",
    stage_id: issued.stage_cursor,
    stage_cursor: issued.stage_cursor,
    capability_id: capability.capability_id!,
    capability_epoch: issued.cursor_epoch,
    loop_iteration: issued.loop_iteration!,
    slot_id: "regression-planner",
    task_id: "task-1",
    dispatch_id: "dispatch-1",
    attempt: 1,
    worker_id: "regression-planner",
  };
}

function pendingEntry(capability: DispatchCapabilityState): PendingState {
  return {
    identity: workIdentity(capability),
    status: "running",
    pending_reason: "provider_running",
    provider_ref: "provider-conn-1",
    lease: { token: "lease-1", observed_at: TIMESTAMP, revoked_at: null },
    updated_at: TIMESTAMP,
  };
}

/** A fully-populated live capability: identity, running lifecycle log, matching dispatch record. */
function capabilityFixture(): DispatchCapabilityState {
  const profile = loadProfile("feature-regression");
  assert.ok(profile);
  const capability = createCapability({
    run_key: RUN_ID,
    branch: "main",
    workflow: "feature-regression",
    profile_hash: profileHash(profile),
    stage_cursor: "surface_mapping",
    kind: "single",
    expected_roster: [{ role: "regression-planner", agent: "regression-planner" }],
  }).state;
  const identity = workIdentity(capability);
  return {
    ...capability,
    status: "dispatched",
    work_identity: identity,
    pending: [pendingEntry(capability)],
    dispatches: [{
      id: "dispatch-1",
      role: "regression-planner",
      agent: "regression-planner",
      status: "running",
      attempt: 1,
      created_at: TIMESTAMP,
      work_identity: identity,
      pending: pendingEntry(capability),
      completion_envelope: {
        schema_version: 1,
        identity,
        outcome: "pending",
        terminal_signal: null,
        artifact_refs: [],
        evidence_ref: null,
        conflict_ref: null,
        completed_by: "engine_task_caller",
        emitted_at: TIMESTAMP,
      },
    }],
  };
}

test("a wild-shaped dispatch capability validates under the array-aware nested contract", () => {
  assert.deepEqual(validateDispatchCapability(capabilityFixture()), { ok: true });
});

test("malformed nested capability pending fails at the exact array path", () => {
  const invalidStatus = capabilityFixture();
  (invalidStatus.pending![0] as Record<string, unknown>).status = "time-traveling";
  const statusResult = validateDispatchCapability(invalidStatus);
  assert.equal(statusResult.ok, false);
  if (!statusResult.ok) assert.ok(statusResult.issues.some((issue) => issue.path === "$.pending[0].status"));

  const notArray = { ...capabilityFixture(), pending: pendingEntry(capabilityFixture()) } as unknown as DispatchCapabilityState;
  const arrayResult = validateDispatchCapability(notArray);
  assert.equal(arrayResult.ok, false);
  if (!arrayResult.ok) {
    assert.ok(arrayResult.issues.some((issue) => issue.path === "$.pending" && issue.message === "must be an array"));
  }
});

test("root-state pending stays a single-object contract", () => {
  const capability = createCapability({
    run_key: RUN_ID,
    branch: "main",
    workflow: "feature-regression",
    profile_hash: "profile-hash",
    stage_cursor: "surface_mapping",
    kind: "single",
    expected_roster: [{ role: "regression-planner", agent: "regression-planner" }],
  }).state;

  const arrayAtRoot = validateTypedControlPlane({ pending: [pendingEntry(capability)] });
  assert.equal(arrayAtRoot.ok, false, "an array-shaped root pending must stay rejected");
  if (!arrayAtRoot.ok) {
    assert.deepEqual(arrayAtRoot.issues, [{ path: "$.pending", message: "must be an object" }]);
  }

  const objectAtRoot = validateTypedControlPlane({ pending: pendingEntry(capability) });
  assert.deepEqual(objectAtRoot, { ok: true }, "a single-object root pending remains the legal root shape");
});

function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
}
function persist(root: string, capability: DispatchCapabilityState, rootPending?: PendingState[]): void {
  const profile = loadProfile("feature-regression");
  assert.ok(profile);
  const runDir = join(root, ".work-state", "runs", RUN_ID);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "regression_intake.json"), JSON.stringify({ summary: "intake" }) + "\n");
  writeFileSync(join(runDir, "state.json"), JSON.stringify({
    schema: 2,
    run_id: RUN_ID,
    run_key: RUN_ID,
    lifecycle_status: "active",
    rework_generation: 0,
    branch: "main",
    title: "capability pending regression",
    classification: { type: "REGRESS", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "feature-regression" },
    task: "capability pending regression",
    required_inputs: {},
    required_input_receipts: {},
    workflow_override: false,
    issue: null,
    stage_cursor: "surface_mapping",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "surface_mapping" ? "in_progress" as const : stage.id === "discovery_intake" ? "done" as const : "pending" as const })),
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: null },
    artifacts: { regression_intake: "artifacts/regression_intake.json" },
    pause: { kind: "none", reason: "" },
    profile_hash: profileHash(profile),
    cursor_epoch: capability.issued_for?.cursor_epoch,
    dispatch_capability: capability,
    ...(rootPending ? { pending: rootPending } : {}),
  }) + "\n");
}

test("resolveWorkflowContract accepts a capability whose pending is a PendingState[] lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "cap-pending-array-"));
  try {
    initGit(root);
    const capability = capabilityFixture();
    persist(root, capability);
    const contract = resolveWorkflowContract(root, { runId: RUN_ID });
    assert.equal(contract.pending?.identity.dispatch_id, "dispatch-1", "the capability lifecycle log resolves as the live pending");
    assert.equal(contract.pending?.status, "running");
    assert.equal(contract.status.lifecycle, "pending");
    assert.equal(contract.stage.dispatch.capability_id, capability.capability_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an array-shaped pending at the state root is still rejected by the resolver", () => {
  const root = mkdtempSync(join(tmpdir(), "cap-pending-root-"));
  try {
    initGit(root);
    const capability = createCapability({
      run_key: "main",
      branch: "main",
      workflow: "feature-regression",
      profile_hash: profileHash(loadProfile("feature-regression")!),
      stage_cursor: "surface_mapping",
      kind: "single",
      expected_roster: [{ role: "regression-planner", agent: "regression-planner" }],
    }).state;
    persist(root, capability, [pendingEntry(capability)]);
    // The illegal root shape is rejected fail-closed at load time (the state
    // is refused as malformed), so no stage contract is ever resolved from
    // it. The single-object root contract itself — "$.pending must be an
    // object" — is pinned by the validateTypedControlPlane test above.
    assert.throws(
      () => resolveWorkflowContract(root, { runId: RUN_ID }),
      (error: unknown) => error instanceof WorkflowContractError && error.code === "RECOVERY_REQUIRED",
      "the root-state single-object pending contract is not weakened",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
