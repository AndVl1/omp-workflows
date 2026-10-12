import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  consumePreparedRecoveryAdmission,
  createOrdinaryStageRecoveryStore,
  formatValidationProducerValid,
  recoveryBudgetsForPrepare,
  recoveryBudgetsWithDefaults,
  stageRecoveryLineageKey,
  validateStageRecoveryLedger,
  type StageRecoveryLedger,
  type StageRecoveryLineage,
  type StageRecoveryOperationRecord,
} from "../src/engine/stage-recovery-store.js";
import { runTarget } from "../src/engine/run-store.js";
import type { StageProducerBinding } from "../src/engine/stage-recovery.js";
import { admitOrdinaryWorker, ordinaryHarness, ordinaryIngress } from "./reliable-stage-execution-fixture.js";
function identity(overrides: Partial<WorkIdentity> = {}): WorkIdentity {
  return {
    run_id: "00000000-0000-4000-8000-000000000001",
    wave_id: "wave-1",
    slice_id: "slice-1",
    session_id: "session-1",
    workflow: "standard",
    stage_id: "build",
    stage_cursor: "build",
    capability_id: "cap-1",
    capability_epoch: "epoch-1",
    loop_iteration: 1,
    slot_id: "slot-1",
    task_id: "task-1",
    dispatch_id: "dispatch-1",
    attempt: 1,
    worker_id: "worker-1",
    ...overrides,
  };
}
test("known recovery budgets default only when absent and preserve explicit zero", () => {
  const projected = recoveryBudgetsWithDefaults([{ error_class: "transport", limit: 0, used: 0 }]);
  assert.deepEqual(projected.find((entry) => entry.error_class === "transport"), { error_class: "transport", limit: 0, used: 0 });
  assert.deepEqual(projected.find((entry) => entry.error_class === "preflight_not_started"), { error_class: "preflight_not_started", limit: 2, used: 0 });
  assert.equal(projected.some((entry) => entry.error_class === "unknown"), false);
  assert.deepEqual(recoveryBudgetsForPrepare([], "terminal_failure"), [{ error_class: "terminal_failure", limit: 2, used: 0 }]);
  assert.deepEqual(recoveryBudgetsForPrepare([{ error_class: "terminal_failure", limit: 0, used: 0 }], "terminal_failure"), [{ error_class: "terminal_failure", limit: 0, used: 0 }]);
});
test("format-validation producer binding is exact and excludes foreign ownership", () => {
  const worker = {
    authority: "ordinary",
    identity: identity(),
    host: { session_id: "coordinator", worktree: "/tmp/worktree", branch: "main" },
    producer: {
      kind: "worker",
      profile: "standard",
      role: "developer",
      slot_id: "slot-1",
      agent: "developer",
      generation: 0,
      wave_id: "wave-1",
      slice_id: "slice-1",
      stage_id: "build",
      iteration: 1,
      lineage: {
        session_id: "worker-session",
        session_file: "/tmp/worker.jsonl",
        parent_session_file: "/tmp/parent.jsonl",
        parent_tool_call_id: "tool-1",
        lifecycle_id: "life-1",
      },
    },
  } satisfies StageProducerBinding;
  assert.equal(formatValidationProducerValid(worker, "ordinary", worker.identity), true);
  assert.equal(formatValidationProducerValid({ ...worker, authority: "cto" }, "ordinary", worker.identity), false);
  assert.equal(formatValidationProducerValid({ ...worker, identity: identity({ dispatch_id: "other-dispatch" }) }, "ordinary", worker.identity), false);
});

function ledgerFor(original: WorkIdentity, replacement: WorkIdentity, generation = 1, operationId = "recovery-op-1", retryOf = original.dispatch_id): StageRecoveryLedger {
  const operation: StageRecoveryOperationRecord = {
    operation_id: operationId,
    run_id: original.run_id,
    authority: "ordinary",
    action: "replace",
    status: "prepared",
    dispatch_id: original.dispatch_id,
    expected_revision: 4,
    revision: 5,
    retry_of: retryOf,
    error_class: "terminal_failure",
    mutation_digest: "a".repeat(64),
    replacement_identity: replacement,
    admission: { state: "ready" },
  };
  const line: StageRecoveryLineage = {
    generation,
    identity: original,
    lifecycle: "terminal",
    budgets: [{ error_class: "terminal_failure", limit: 1, used: 1 }],
    grants: [],
    operations: [operation],
  };
  return { schema_version: 1, lineages: { [stageRecoveryLineageKey(original, generation)]: line } };
}

test("prepared replacement admission is single-use and exact-call idempotent", () => {
  const original = identity();
  const replacement = identity({ dispatch_id: "dispatch-2", attempt: 2 });
  const ledger = ledgerFor(original, replacement);
  const scope = { run_id: original.run_id, authority: "ordinary" as const, generation: 1, identity: original, retry_of: original.dispatch_id, replacement_identity: replacement };

  const first = consumePreparedRecoveryAdmission(ledger, scope, "tool-call-1");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.replacement_identity, replacement);
  assert.equal(first.ledger.lineages[stageRecoveryLineageKey(original, 1)]?.operations[0]?.admission?.state, "consumed");

  const replay = consumePreparedRecoveryAdmission(first.ledger, scope, "tool-call-1");
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.deepEqual(replay.replacement_identity, replacement);

  const conflicting = consumePreparedRecoveryAdmission(first.ledger, scope, "tool-call-2");
  assert.deepEqual(conflicting, { ok: false, code: "admission_already_consumed", operation_id: "recovery-op-1" });
});
test("queued ack keeps a ready admission consumable", () => {
  const original = identity();
  const replacement = identity({ dispatch_id: "dispatch-queued", attempt: 2 });
  const prepared = ledgerFor(original, replacement);
  const key = stageRecoveryLineageKey(original, 1);
  const line = prepared.lineages[key]!;
  const operation = line.operations[0]!;
  const queued: StageRecoveryLedger = {
    ...prepared,
    lineages: {
      ...prepared.lineages,
      [key]: { ...line, operations: [{ ...operation, status: "acked" }] },
    },
  };
  const result = consumePreparedRecoveryAdmission(queued, { run_id: original.run_id, authority: "ordinary", generation: 1, identity: original, retry_of: original.dispatch_id, replacement_identity: replacement }, "queued-tool-call");
  assert.equal(result.ok, true);
});


test("ledger validator preserves strict replacement permit shape", () => {
  const original = identity();
  const replacement = identity({ dispatch_id: "dispatch-2", attempt: 2 });
  const checked = validateStageRecoveryLedger(ledgerFor(original, replacement));
  assert.equal(checked.ok, true);
});

test("admission refuses ambiguous matching old lineages", () => {
  const original = identity();
  const replacement = identity({ dispatch_id: "dispatch-2", attempt: 2 });
  const base = ledgerFor(original, replacement);
  const second = ledgerFor(identity({ dispatch_id: "dispatch-other", attempt: 1 }), identity({ dispatch_id: "dispatch-3", attempt: 2 }), 1, "recovery-op-2", original.dispatch_id);
  const secondLine = Object.values(second.lineages)[0]!;
  const ambiguous: StageRecoveryLedger = { schema_version: 1, lineages: { ...base.lineages, ["a".repeat(64)]: secondLine } };
  const result = consumePreparedRecoveryAdmission(ambiguous, { run_id: original.run_id, authority: "ordinary" as const, generation: 1, identity: original, retry_of: original.dispatch_id }, "tool-call-1");
  assert.deepEqual(result, { ok: false, code: "admission_ambiguous" });
});

test("newer generation permit supersedes preserved old history", () => {
  const original = identity();
  const old = ledgerFor(original, identity({ dispatch_id: "dispatch-old", attempt: 2 }), 1, "recovery-old");
  const current = ledgerFor(original, identity({ dispatch_id: "dispatch-current", attempt: 3 }), 2, "recovery-current");
  const ledger: StageRecoveryLedger = { schema_version: 1, lineages: { ...old.lineages, ...current.lineages } };
  const result = consumePreparedRecoveryAdmission(ledger, { run_id: original.run_id, authority: "ordinary" as const, generation: 2, identity: original, retry_of: original.dispatch_id, replacement_identity: identity({ dispatch_id: "dispatch-current", attempt: 3 }) }, "tool-call-current");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.operation_id, "recovery-current");
  assert.equal(result.replacement_identity.dispatch_id, "dispatch-current");
});

test("ordinary adapter persists a grant only through current opaque authorization", async () => {
  const harness = ordinaryHarness();
  try {
    const { runId, handoff } = await ordinaryIngress(harness);
    await admitOrdinaryWorker(harness, handoff, "recovery-store");
    const context = harness.controller.context();
    const store = createOrdinaryStageRecoveryStore(harness.root, { context, runId });
    const before = await store.read({ run_id: runId, authority: "ordinary" });
    assert.ok(before.identity);
    const selection = store.selection();
    const proof = store.captureGrantAuthorization({ expected_revision: before.revision, selection, identity: before.identity });
    const committed = store.commitGrant({
      proof,
      expected_revision: before.revision,
      selection,
      grant_id: "grant-recovery-store",
      error_class: "terminal_failure",
      identity: before.identity,
      limit: 1,
      reason: "test bounded recovery",
      authorizer: "test-ui",
    });
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    const after = await store.read({ run_id: runId, authority: "ordinary", identity: before.identity, selection });
    assert.equal(after.grants?.[0]?.authenticated, true);
    const persisted = JSON.parse(readFileSync(runTarget(harness.root, runId).statePath, "utf8")) as { stage_recovery?: { lineages?: Record<string, { grants?: unknown[] }> } };
    const grantValues = Object.values(persisted.stage_recovery?.lineages ?? {}).flatMap((line) => line.grants ?? []);
    assert.equal(grantValues.length, 1);
    assert.equal(typeof (grantValues[0] as Record<string, unknown>).proof_digest, "string");
    assert.equal(Object.prototype.hasOwnProperty.call(grantValues[0], "authenticated"), false);
  } finally {
    await harness.close();
  }
});
