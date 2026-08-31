/**
 * Focused regressions for the single-sourced control-plane contract and the
 * cross-process state transaction (br-zps checkpoint-ledger correction):
 *
 *   - every shared validator is total: null/primitive/array envelopes return
 *     stable issues, never a TypeError;
 *   - the nested capability contract is COMPLETE (kind↔roster cardinality,
 *     secret hashes, issued_for binding, dispatch-record identity and
 *     envelope cross-bindings, nested `PendingState[]`), while the root
 *     state keeps its single-object pending contract;
 *   - capability↔state cross-bindings (run/branch/workflow/profile hash/
 *     cursor epoch/stage cursor/work identity) are checked in one place;
 *   - `updateStateAtomically` provides lock + revision/raw-hash CAS: a
 *     concurrent lockless write during a transaction is a `state_conflict`
 *     with no lost update, revisions advance monotonically, a live lock
 *     owner in another process is never stolen (`state_lock_unavailable`),
 *     a dead owner is reclaimed, and a malformed lock fails closed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { createCapability } from "../src/engine/durable.js";
import {
  isRecord,
  validateActiveDispatchCapabilityValue,
  validateCapabilityStateBinding,
  validateDispatchCapabilityValue,
  validatePendingStateValue,
  validateTrustedCheckpointAnswerValue,
  validateTypedCheckpointDecisionValue,
  validateWorkIdentityValue,
} from "../src/engine/control-plane-contract.js";
import { resolveState, updateStateAtomically, writeStateBootstrap, type StateMutation } from "../src/engine/state.js";
import type { DispatchCapabilityState, PendingState, TeamState, WorkIdentity } from "../src/engine/types.js";

const TIMESTAMP = "2026-08-31T00:00:00Z";

function initGit(root: string): void {
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
}

function identityFor(capability: DispatchCapabilityState, overrides: Partial<WorkIdentity> = {}): WorkIdentity {
  const issued = capability.issued_for!;
  return {
    run_id: "main",
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
    ...overrides,
  };
}

function pendingEntry(capability: DispatchCapabilityState): PendingState {
  const identity = identityFor(capability);
  return {
    identity,
    status: "running",
    pending_reason: "provider_running",
    provider_ref: "provider-conn-1",
    lease: { token: "lease-1", observed_at: TIMESTAMP, revoked_at: null },
    updated_at: TIMESTAMP,
  };
}

/** A fully valid live capability: identity, lifecycle log and matching dispatch record agree. */
function capabilityFixture(): DispatchCapabilityState {
  const profile = loadProfile("feature-regression");
  assert.ok(profile);
  const capability = createCapability({
    run_key: "main",
    branch: "main",
    workflow: "feature-regression",
    profile_hash: profileHash(profile),
    stage_cursor: "surface_mapping",
    kind: "single",
    expected_roster: [{ role: "regression-planner", agent: "regression-planner" }],
  }).state;
  const identity = identityFor(capability);
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

test("contract: null and primitive envelopes return issues, never a TypeError", () => {
  for (const invalid of [null, undefined, 42, "capability", [], true]) {
    const capability = validateDispatchCapabilityValue(invalid);
    assert.equal(capability.ok, false, `capability ${String(invalid)} must fail`);
    if (!capability.ok) assert.ok(capability.issues.length > 0);

    const identity = validateWorkIdentityValue(invalid);
    assert.equal(identity.ok, false, `identity ${String(invalid)} must fail`);

    const pending = validatePendingStateValue(invalid);
    assert.equal(pending.ok, false, `pending ${String(invalid)} must fail`);

    const answer = validateTrustedCheckpointAnswerValue(invalid);
    assert.equal(answer.ok, false, `answer ${String(invalid)} must fail`);

    const decision = validateTypedCheckpointDecisionValue(invalid);
    assert.equal(decision.ok, false, `decision ${String(invalid)} must fail`);
  }
  assert.ok(isRecord({}), "isRecord is the canonical object guard");
});

test("contract: kind↔roster cardinality and required binding fields fail closed", () => {
  const base = capabilityFixture();
  const issuedFor = () => ({ ...base.issued_for! });

  // single capability must expect exactly one roster entry
  const emptyRoster: DispatchCapabilityState = { ...base, expected_roles: [], expected_count: 0, expected_roster: [] };
  assert.equal(validateDispatchCapabilityValue(emptyRoster).ok, false, "a single capability with an empty roster is invalid");

  const inflated: DispatchCapabilityState = { ...base, expected_count: 5 };
  const inflatedResult = validateDispatchCapabilityValue(inflated);
  assert.equal(inflatedResult.ok, false);
  if (!inflatedResult.ok) assert.ok(inflatedResult.issues.some((issue) => issue.path === "$.expected_count"));

  const unknownKind: DispatchCapabilityState = { ...base, kind: "herd" as DispatchCapabilityState["kind"] };
  assert.equal(validateDispatchCapabilityValue(unknownKind).ok, false, "unknown dispatch kind fails");

  // issued_for must be complete and loop-scoped when present
  const missingEpoch: DispatchCapabilityState = { ...base, issued_for: { ...issuedFor(), cursor_epoch: undefined } as DispatchCapabilityState["issued_for"] };
  const missingEpochResult = validateDispatchCapabilityValue(missingEpoch);
  assert.equal(missingEpochResult.ok, false);
  if (!missingEpochResult.ok) assert.ok(missingEpochResult.issues.some((issue) => issue.path === "$.issued_for.cursor_epoch"));

  const zeroIteration: DispatchCapabilityState = { ...base, issued_for: { ...issuedFor(), loop_iteration: 0 } };
  const zeroResult = validateDispatchCapabilityValue(zeroIteration);
  assert.equal(zeroResult.ok, false);
  if (!zeroResult.ok) assert.ok(zeroResult.issues.some((issue) => issue.path === "$.issued_for.loop_iteration"));

  // null entries inside the nested pending lifecycle fail at their path
  const nullPending: DispatchCapabilityState = { ...base, pending: [null] as unknown as PendingState[] };
  const nullResult = validateDispatchCapabilityValue(nullPending);
  assert.equal(nullResult.ok, false);
  if (!nullResult.ok) assert.ok(nullResult.issues.some((issue) => issue.path === "$.pending[0]" && issue.message === "must be an object"));
});

test("contract: dispatch-record identity and envelope cross-bindings fail closed", () => {
  const base = capabilityFixture();

  const wrongSlot: DispatchCapabilityState = {
    ...base,
    dispatches: [{
      ...base.dispatches[0]!,
      work_identity: identityFor(base, { slot_id: "someone-else" }),
    }],
  };
  const slotResult = validateDispatchCapabilityValue(wrongSlot);
  assert.equal(slotResult.ok, false);
  if (!slotResult.ok) assert.ok(slotResult.issues.some((issue) => issue.path.endsWith(".work_identity")));

  const forgedAgent: DispatchCapabilityState = {
    ...base,
    dispatches: [{ ...base.dispatches[0]!, agent: "ghost" }],
  };
  const agentResult = validateDispatchCapabilityValue(forgedAgent);
  assert.equal(agentResult.ok, false);
  if (!agentResult.ok) assert.ok(agentResult.issues.some((issue) => issue.path.endsWith(".agent")));

  const wrongEnvelopeIdentity: DispatchCapabilityState = {
    ...base,
    dispatches: [{
      ...base.dispatches[0]!,
      completion_envelope: {
        ...base.dispatches[0]!.completion_envelope!,
        identity: identityFor(base, { dispatch_id: "other-dispatch" }),
      },
    }],
  };
  const envelopeResult = validateDispatchCapabilityValue(wrongEnvelopeIdentity);
  assert.equal(envelopeResult.ok, false);
  if (!envelopeResult.ok) assert.ok(envelopeResult.issues.some((issue) => issue.path.endsWith(".completion_envelope.identity")));

  // the honest fixture stays valid
  assert.deepEqual(validateDispatchCapabilityValue(base), { ok: true });
});

test("contract: active capability binds every nested identity to its dispatch generation", () => {
  const base = capabilityFixture();
  assert.deepEqual(validateActiveDispatchCapabilityValue(base), { ok: true }, "the complete modern fixture authorizes");

  const fieldMutations: Array<{ field: keyof WorkIdentity; value: string | number }> = [
    { field: "capability_id", value: "forged-capability" },
    { field: "capability_epoch", value: "forged-epoch" },
    { field: "workflow", value: "forged-workflow" },
    { field: "stage_id", value: "forged-stage" },
    { field: "stage_cursor", value: "forged-stage" },
    { field: "loop_iteration", value: 2 },
    { field: "slot_id", value: "forged-slot" },
    { field: "dispatch_id", value: "forged-dispatch" },
    { field: "attempt", value: 2 },
    { field: "worker_id", value: "forged-worker" },
  ];
  for (const mutation of fieldMutations) {
    const forged = structuredClone(base);
    forged.dispatches[0]!.work_identity = {
      ...forged.dispatches[0]!.work_identity!,
      [mutation.field]: mutation.value,
    };
    const result = validateActiveDispatchCapabilityValue(forged);
    assert.equal(result.ok, false, `active record identity rejects forged ${mutation.field}`);
    if (!result.ok) {
      assert.ok(
        result.issues.some((issue) => issue.path === `$.dispatches[0].work_identity.${mutation.field}`),
        `${mutation.field} reports its exact identity path`,
      );
    }
  }

  const nestedIdentities: Array<{ label: string; path: string; mutate: (capability: DispatchCapabilityState) => void }> = [
    {
      label: "capability work identity",
      path: "$.work_identity.worker_id",
      mutate: (capability) => { capability.work_identity = { ...capability.work_identity!, worker_id: "forged-worker" }; },
    },
    {
      label: "capability pending identity",
      path: "$.pending[0].identity.worker_id",
      mutate: (capability) => { capability.pending![0]!.identity.worker_id = "forged-worker"; },
    },
    {
      label: "record pending identity",
      path: "$.dispatches[0].pending.identity.worker_id",
      mutate: (capability) => { capability.dispatches[0]!.pending!.identity.worker_id = "forged-worker"; },
    },
    {
      label: "record completion envelope identity",
      path: "$.dispatches[0].completion_envelope.identity.worker_id",
      mutate: (capability) => { capability.dispatches[0]!.completion_envelope!.identity.worker_id = "forged-worker"; },
    },
  ];
  for (const nested of nestedIdentities) {
    const forged = structuredClone(base);
    nested.mutate(forged);
    const result = validateActiveDispatchCapabilityValue(forged);
    assert.equal(result.ok, false, `${nested.label} cannot authorize with a forged worker binding`);
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === nested.path), `${nested.label} reports its exact path`);
  }

  const legacy = structuredClone(base);
  delete legacy.issued_for!.loop_iteration;
  for (const record of legacy.dispatches) {
    if (record.work_identity) delete record.work_identity.loop_iteration;
    if (record.pending?.identity) delete record.pending.identity.loop_iteration;
    if (record.completion_envelope?.identity) delete record.completion_envelope.identity.loop_iteration;
  }
  for (const pending of legacy.pending ?? []) delete pending.identity.loop_iteration;
  if (legacy.work_identity) delete legacy.work_identity.loop_iteration;
  assert.deepEqual(validateDispatchCapabilityValue(legacy), { ok: true }, "legacy capability remains readable for audit");
  assert.equal(validateActiveDispatchCapabilityValue(legacy).ok, false, "legacy capability cannot authorize");
});

test("contract: root pending stays single-object; nested capability pending stays an array", () => {
  const capability = capabilityFixture();
  const entry = pendingEntry(capability);

  const rootArray = validatePendingStateValue([entry], "$.pending", "single");
  assert.equal(rootArray.ok, false);
  if (!rootArray.ok) assert.deepEqual(rootArray.issues, [{ path: "$.pending", message: "must be an object" }]);

  const rootObject = validatePendingStateValue(entry, "$.pending", "single");
  assert.deepEqual(rootObject, { ok: true });

  const nestedObject = validatePendingStateValue(entry, "$.pending", "array");
  assert.equal(nestedObject.ok, false);
  if (!nestedObject.ok) assert.deepEqual(nestedObject.issues, [{ path: "$.pending", message: "must be an array" }]);

  const nestedArray = validatePendingStateValue([entry], "$.pending", "array");
  assert.deepEqual(nestedArray, { ok: true });
});

test("contract: capability↔state cross-bindings are single-sourced and non-throwing", () => {
  const capability = capabilityFixture();
  const state = {
    run_key: "main",
    branch: "main",
    classification: { workflow: "feature-regression" },
    profile_hash: capability.issued_for!.profile_hash,
    cursor_epoch: capability.issued_for!.cursor_epoch,
    stage_cursor: capability.issued_for!.stage_cursor,
    dispatch_capability: capability,
    work_identity: capability.work_identity,
  };
  assert.deepEqual(validateCapabilityStateBinding(state), { ok: true });

  const drifted = {
    ...state,
    stage_cursor: "elsewhere",
    cursor_epoch: "rotated",
    work_identity: identityFor(capability, { stage_id: "elsewhere" }),
    dispatch_capability: capability,
  };
  const driftResult = validateCapabilityStateBinding(drifted);
  assert.equal(driftResult.ok, false);
  if (!driftResult.ok) {
    assert.ok(driftResult.issues.some((issue) => issue.path.endsWith(".issued_for.stage_cursor")));
    assert.ok(driftResult.issues.some((issue) => issue.path.endsWith(".issued_for.cursor_epoch")));
    assert.ok(driftResult.issues.some((issue) => issue.path.endsWith(".work_identity")));
  }

  // a state without any capability trivially binds; garbage fails cleanly
  assert.deepEqual(validateCapabilityStateBinding({}), { ok: true });
  assert.equal(validateCapabilityStateBinding(null).ok, false);
  assert.equal(validateCapabilityStateBinding({ dispatch_capability: 42 }).ok, false);
});

test("contract: typed decisions and trusted answers validate loop scope and consumption invariants", () => {
  const decision = {
    run_id: "main",
    stage_id: "implementation",
    checkpoint_id: "approve_implementation",
    checkpoint_kind: "implementation_approval",
    decision: "proceed",
    authorization: "human",
    actor: { kind: "user", ref: "terminal-answer/x", proof: { answer_id: "x", nonce: "n", channel: "terminal", reference: "terminal-answer/x", binding: "b" } },
    capability_id: "cap",
    capability_epoch: "epoch",
    loop_iteration: 2,
    policy_hash: "hash",
    rationale: "why",
    decided_at: TIMESTAMP,
  };
  assert.deepEqual(validateTypedCheckpointDecisionValue(decision), { ok: true });

  const zero = validateTypedCheckpointDecisionValue({ ...decision, loop_iteration: 0 });
  assert.equal(zero.ok, false);
  if (!zero.ok) assert.ok(zero.issues.some((issue) => issue.path === "$.loop_iteration"));

  // legacy persisted decisions may omit loop_iteration at the state boundary
  const legacy = validateTypedCheckpointDecisionValue({ ...decision, loop_iteration: undefined }, "$.typed[0]", { allowLegacyLoopScope: true });
  assert.deepEqual(legacy, { ok: true });

  const actorless = validateTypedCheckpointDecisionValue({ ...decision, actor: null });
  assert.equal(actorless.ok, false);
  if (!actorless.ok) assert.ok(actorless.issues.some((issue) => issue.path === "$.actor"));

  const answer = {
    answer_id: "x",
    nonce: "n",
    channel: "terminal",
    reference: "terminal-answer/x",
    run_id: "main",
    stage_id: "implementation",
    checkpoint_id: "approve_implementation",
    work_identity_hash: "h",
    capability_id: "cap",
    capability_epoch: "epoch",
    loop_iteration: 2,
    policy_hash: "hash",
    decision: "proceed",
    binding: "b",
    issued_at: TIMESTAMP,
  };
  assert.deepEqual(validateTrustedCheckpointAnswerValue(answer), { ok: true });

  const finalizedWithoutKey = validateTrustedCheckpointAnswerValue({ ...answer, consumed_at: TIMESTAMP, consumed_reason: "finalized" });
  assert.equal(finalizedWithoutKey.ok, false);
  if (!finalizedWithoutKey.ok) assert.ok(finalizedWithoutKey.issues.some((issue) => issue.path === "$.finalized_decision_key"));

  const superseded = validateTrustedCheckpointAnswerValue({ ...answer, consumed_at: TIMESTAMP, consumed_reason: "superseded" });
  assert.deepEqual(superseded, { ok: true });

  const reasonWithoutConsumption = validateTrustedCheckpointAnswerValue({ ...answer, consumed_reason: "superseded" });
  assert.equal(reasonWithoutConsumption.ok, false);
  if (!reasonWithoutConsumption.ok) assert.ok(reasonWithoutConsumption.issues.some((issue) => issue.path === "$.consumed_reason"));
});

// ---------------------------------------------------------------------------
// State transaction: lock + revision/raw-hash CAS
// ---------------------------------------------------------------------------

function writeLedgerFixture(root: string): void {
  initGit(root);
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
    task: "transaction",
    workflow_override: false,
    issue: null,
    stage_cursor: "implementation",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    pause: { kind: "none", reason: "" },
    policy: { strict_orchestrator: true },
    profile_hash: profileHash(profile),
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: true, dev_agent: "developer-kotlin" },
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  }, { featureSlug: "tx" });
}

test("transaction: sequential commits advance the revision monotonically and never lose concurrent fields", () => {
  const root = mkdtempSync(join(tmpdir(), "tx-monotonic-"));
  try {
    writeLedgerFixture(root);
    const statePath = resolveState(root).statePath!;

    const first = updateStateAtomically<string>(root, (snapshot) => {
      assert.ok(snapshot.state, "fixture state must resolve");
      assert.equal(snapshot.revision, 1, "the bootstrap fixture stamped revision 1");
      return { op: "commit", state: { ...snapshot.state, task: "first" }, value: "first" };
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.committed, true);
    assert.equal(first.revision, 2);
    assert.equal(first.value, "first");
    assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as TeamState).state_revision, 2);
    assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as TeamState).task, "first");

    // A second transaction observes the fresh revision and preserves the
    // concurrent writer's field (no lost update, no stale-snapshot clobber).
    const second = updateStateAtomically(root, (snapshot) => {
      assert.ok(snapshot.state);
      assert.equal(snapshot.state.task, "first", "the mutation sees the latest committed state");
      assert.equal(snapshot.revision, 2);
      return { op: "commit", state: { ...snapshot.state, pause: { kind: "user_checkpoint", reason: "waiting" } } };
    });
    assert.equal(second.ok, true);
    const after = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    assert.equal(after.state_revision, 3);
    assert.equal(after.task, "first", "the earlier field survives the later transaction");
    assert.equal(after.pause.kind, "user_checkpoint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transaction: a lockless write racing inside a transaction is a CAS conflict with no partial commit", () => {
  const root = mkdtempSync(join(tmpdir(), "tx-cas-"));
  try {
    writeLedgerFixture(root);
    const statePath = resolveState(root).statePath!;
    const before = readFileSync(statePath, "utf8");

    const result = updateStateAtomically(root, (snapshot) => {
      assert.ok(snapshot.state);
      // Deliberately bypass the transactional API to model a rogue
      // external process. A supported writer cannot manufacture this
      // lockless CAS race.
      writeFileSync(statePath, JSON.stringify({ ...snapshot.state, task: "rogue" }, null, 2) + "\n");
      return { op: "commit", state: { ...snapshot.state, task: "transaction" } } satisfies StateMutation<void>;
    });
    assert.equal(result.ok, false, "the CAS guard rejects the moved file");
    if (!result.ok) assert.equal(result.code, "state_conflict");
    const after = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    assert.equal(after.task, "rogue", "the rogue writer's state is untouched by the failed transaction");
    assert.notEqual(readFileSync(statePath, "utf8"), before, "the rogue write itself happened");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transaction: discard mutates nothing; fail returns its domain code without writing", () => {
  const root = mkdtempSync(join(tmpdir(), "tx-discard-"));
  try {
    writeLedgerFixture(root);
    const statePath = resolveState(root).statePath!;
    const before = readFileSync(statePath, "utf8");

    const discarded = updateStateAtomically(root, (snapshot) => ({ op: "discard", value: 7 }));
    assert.equal(discarded.ok, true);
    if (!discarded.ok) return;
    assert.equal(discarded.committed, false);
    assert.equal(discarded.value, 7);
    assert.equal(readFileSync(statePath, "utf8"), before, "a discarded transaction writes nothing");

    const failed = updateStateAtomically(root, () => ({ op: "fail", code: "checkpoint_scope_stale", error: "scope moved" }));
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.equal(failed.code, "checkpoint_scope_stale", "the domain code passes through");
      assert.equal(failed.error, "scope moved");
    }
    assert.equal(readFileSync(statePath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transaction: a live lock owner is never stolen; a dead owner is reclaimed; a malformed lock fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "tx-lock-"));
  try {
    writeLedgerFixture(root);
    const lockPath = join(root, ".work-state", ".state.lock");

    // Live owner (this process): never stolen, bounded wait, then unavailable.
    mkdirSync(join(root, ".work-state"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "external", acquired_at: new Date().toISOString() }));
    const live = updateStateAtomically(root, () => ({ op: "discard" }), { lockTimeoutMs: 150 });
    assert.equal(live.ok, false, "a live owner is waited for, never bypassed");
    if (!live.ok) assert.equal(live.code, "state_lock_unavailable");
    rmSync(lockPath);

    // Dead owner: reclaimed and the transaction proceeds.
    const deadPid = 999_999_999;
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: "dead", acquired_at: new Date().toISOString() }));
    const reclaimed = updateStateAtomically(root, (snapshot) => ({ op: "commit", state: { ...snapshot.state!, task: "after-reclaim" } }), { lockTimeoutMs: 2_000 });
    assert.equal(reclaimed.ok, true, reclaimed.ok ? "dead owner reclaimed" : reclaimed.error);
    assert.equal((JSON.parse(readFileSync(resolveState(root).statePath!, "utf8")) as TeamState).task, "after-reclaim");

    // Malformed owner: not verifiably dead, so never stolen.
    writeFileSync(lockPath, "not json");
    const malformed = updateStateAtomically(root, () => ({ op: "discard" }), { lockTimeoutMs: 150 });
    assert.equal(malformed.ok, false, "a malformed lock fails closed");
    if (!malformed.ok) assert.equal(malformed.code, "state_lock_unavailable");
    rmSync(lockPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
