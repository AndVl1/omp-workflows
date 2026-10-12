import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkIdentity } from "../src/engine/types.js";
import {
  recoverStageExecution,
  recoveryErrorDigest,
  type AuthenticatedRecoveryGrant,
  type RecoveryHostEvidence,
  type RecoveryOperationRecord,
  type RecoveryRevision,
  type RecoveryStateProof,
  type RecoveryTerminalProof,
  type StageProducerBinding,
  type StageRecoveryCapabilities,
  type StageRecoveryRequest,
  type StageRecoverySnapshot,
  type StageRecoveryStore,
  type StageRecoveryTransitionRequest,
  type StageRecoveryTransitionResult,
  type TrustedRecoverySelection,
  type TrustedRecoveryHandoff,
} from "../src/engine/stage-recovery.js";

const runId = "run-recovery";
const ownerId = "owner-recovery";
const bindingId = "binding-recovery";
const BRANCH = "recovery-test";

function identity(dispatchId: string, attempt = 1, workerId = "worker-a"): WorkIdentity {
  return {
    run_id: runId,
    wave_id: "wave-1",
    slice_id: "slice-1",
    session_id: "session-1",
    workflow: "standard",
    stage_id: "implementation",
    stage_cursor: "implementation",
    capability_id: "capability-1",
    capability_epoch: "epoch-1",
    loop_iteration: 1,
    slot_id: "developer",
    task_id: "task-1",
    dispatch_id: dispatchId,
    attempt,
    worker_id: workerId,
  };
}

function proof(revision: RecoveryRevision, dispatchId: string, eventId: string): RecoveryStateProof {
  return {
    authenticated: true,
    source: "ordinary-canonical",
    run_id: runId,
    authority: "ordinary",
    revision,
    dispatch_id: dispatchId,
    event_id: eventId,
    observed_at: "2026-09-30T00:00:00.000Z",
  };
}

function terminal(dispatchId: string, eventId: string, outcome: "failed" | "cancelled" = "failed"): RecoveryTerminalProof {
  const worker = identity(dispatchId);
  return {
    authoritative: true,
    run_id: runId,
    dispatch_id: dispatchId,
    identity: worker,
    outcome,
    terminal_event_id: eventId,
    observed_at: "2026-09-30T00:00:01.000Z",
    proof: {
      authenticated: true,
      source: "omp-terminal-event",
      event_id: eventId,
      binding_id: bindingId,
      observed_at: "2026-09-30T00:00:01.000Z",
    },
  };
}

function producer(worker: WorkIdentity): StageProducerBinding {
  return {
    authority: "ordinary",
    identity: worker,
    host: { session_id: worker.session_id, worktree: "/tmp/recovery", branch: BRANCH },
    producer: {
      kind: "worker",
      profile: worker.workflow,
      role: "developer",
      slot_id: worker.slot_id,
      agent: worker.worker_id,
      generation: worker.attempt,
      wave_id: worker.wave_id,
      slice_id: worker.slice_id,
      stage_id: worker.stage_id,
      iteration: worker.loop_iteration ?? 1,
      lineage: {
        session_id: worker.session_id,
        session_file: "/tmp/recovery/session.jsonl",
        parent_session_file: "/tmp/recovery/parent.jsonl",
        parent_tool_call_id: "tool-1",
        lifecycle_id: "lifecycle-1",
      },
    },
  };
}

function selection(): TrustedRecoverySelection {
  return {
    authenticated: true,
    run_id: runId,
    authority: "ordinary",
    owner_id: ownerId,
    ownership_epoch: "owner-epoch-1",
    binding_id: bindingId,
    proof: "host-selection-proof",
  };
}

function baseSnapshot(overrides: Partial<StageRecoverySnapshot> = {}): StageRecoverySnapshot {
  const worker = identity("dispatch-1");
  const snapshotIdentity = overrides.identity ?? worker;
  const currentProof = proof(0, snapshotIdentity.dispatch_id, "state-0");
  return {
    run_id: runId,
    authority: "ordinary",
    revision: 0,
    state_proof: currentProof,
    ownership: {
      authenticated: true,
      run_id: runId,
      authority: "ordinary",
      owner_id: ownerId,
      ownership_epoch: "owner-epoch-1",
      binding_id: bindingId,
      proof: "canonical-owner-proof",
    },
    identity: worker,
    producer_available: true,
    binding_id: bindingId,
    producer: producer(worker),
    lifecycle: "unknown",
    budgets: [],
    grants: [],
    operations: [],
    ...overrides,
  };
}

function request(operationId: string, intent?: StageRecoveryRequest["intent"]): StageRecoveryRequest {
  return {
    run_id: runId,
    authority: "ordinary",
    operation: "reconcile",
    operation_id: operationId,
    ...(intent ? { intent } : {}),
    selection: selection(),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class CanonicalRecoveryStore implements StageRecoveryStore {
  private state: StageRecoverySnapshot;
  private revision: number;
  private readonly refreshedHandoff?: TrustedRecoveryHandoff;
  readonly transitions: StageRecoveryTransitionRequest[] = [];
  readonly readBarrier?: ReadBarrier;

  constructor(snapshot: StageRecoverySnapshot, readBarrier?: ReadBarrier, refreshedHandoff?: TrustedRecoveryHandoff) {
    this.state = clone(snapshot);
    this.revision = typeof snapshot.revision === "number" ? snapshot.revision : 0;
    this.readBarrier = readBarrier;
    this.refreshedHandoff = refreshedHandoff;
  }

  async read(): Promise<StageRecoverySnapshot> {
    if (this.readBarrier) await this.readBarrier.wait();
    return clone(this.state);
  }

  async transition(input: StageRecoveryTransitionRequest): Promise<StageRecoveryTransitionResult> {
    this.transitions.push(clone(input));
    if (input.phase === "replay") {
      const operation = this.state.operations?.find((entry) => entry.operation_id === input.operation_id);
      return operation ? { ok: true, revision: this.revision, operation } : { ok: false, code: "operation_not_found", revision: this.revision };
    }
    if (input.expected_revision !== this.revision) return { ok: false, code: "stale_revision", revision: this.revision };
    const operations = [...(this.state.operations ?? [])];
    const existing = operations.find((entry) => entry.operation_id === input.operation_id);
    if (input.phase === "prepare") {
      const errorClass = input.mutation.kind === "replacement" || input.mutation.kind === "format_repair" ? input.mutation.error_class : undefined;
      const grant = input.mutation.kind === "replacement" || input.mutation.kind === "format_repair" ? input.mutation.grant : undefined;
      if (existing) return { ok: true, revision: this.revision, operation: existing, remaining_attempts: this.remaining(existing.error_class) };
      if (errorClass && this.remaining(errorClass) < 1 && (!grant || grant.authenticated !== true)) return { ok: false, code: "recovery_budget_exhausted", revision: this.revision, remaining_attempts: 0 };
      if (input.mutation.kind === "replacement" && operations.some((entry) => entry.retry_of === input.mutation.retry_of)) return { ok: false, code: "operation_conflict", revision: this.revision };
      const replacementIdentity = input.mutation.kind === "replacement"
        ? { ...(this.state.identity ?? identity(input.mutation.dispatch_id, 1)), dispatch_id: `planned-${input.operation_id}`, attempt: (this.state.identity?.attempt ?? 1) + 1 }
        : undefined;
      const operation: RecoveryOperationRecord = {
        operation_id: input.operation_id,
        ...(input.parent_operation_id ? { parent_operation_id: input.parent_operation_id } : {}),
        run_id: input.run_id,
        authority: input.authority,
        action: input.mutation.action,
        status: "prepared",
        ...(input.mutation.kind === "replacement" ? { dispatch_id: input.mutation.dispatch_id, retry_of: input.mutation.retry_of, error_class: input.mutation.error_class, producer_correction: input.mutation.producer_correction, replacement_identity: replacementIdentity, admission: { state: "ready" as const } } : {}),
        ...(input.mutation.kind === "format_repair" ? { error_class: input.mutation.error_class } : {}),
        ...(input.mutation.kind !== "replacement" && input.mutation.kind !== "handoff_refresh" && input.mutation.dispatch_id ? { dispatch_id: input.mutation.dispatch_id } : {}),
        expected_revision: input.expected_revision,
        revision: this.revision + 1,
      };
      const nextBudgets = errorClass && !grant
        ? (this.state.budgets ?? []).map((entry) => entry.error_class === errorClass ? { ...entry, used: entry.used + 1 } : entry)
        : this.state.budgets;
      const nextGrants = errorClass && grant
        ? (this.state.grants ?? []).map((entry) => entry.grant_id === grant.grant_id ? { ...entry, used: entry.used + 1 } : entry)
        : this.state.grants;
      this.revision += 1;
      this.state = { ...this.state, revision: this.revision, state_proof: { ...this.state.state_proof, revision: this.revision }, budgets: nextBudgets, grants: nextGrants, operations: [...operations, operation] };
      return { ok: true, revision: this.revision, operation, remaining_attempts: errorClass ? this.remaining(errorClass) : undefined };
    }
    const operation = existing;
    if (!operation || operation.status !== "prepared") return { ok: false, code: "operation_not_prepared", revision: this.revision };
    const acked: RecoveryOperationRecord = { ...operation, status: "acked", revision: this.revision + 1, response: input.response, evidence: input.evidence };
    this.revision += 1;
    this.state = { ...this.state, revision: this.revision, state_proof: { ...this.state.state_proof, revision: this.revision }, operations: operations.map((entry) => entry.operation_id === operation.operation_id ? acked : entry) };
    return { ok: true, revision: this.revision, state_proof: { ...this.state.state_proof }, operation: acked, remaining_attempts: operation.error_class ? this.remaining(operation.error_class) : input.response.attempts_remaining, ...(this.refreshedHandoff ? { handoff: this.refreshedHandoff } : {}) };
  }

  remaining(errorClass: string | undefined): number {
    if (!errorClass) return 0;
    const budget = this.state.budgets?.find((entry) => entry.error_class === errorClass);
    const base = budget ? Math.max(0, budget.limit - budget.used) : 0;
    const grants = (this.state.grants ?? []).filter((entry) => entry.error_class === errorClass).reduce((total, entry) => total + Math.max(0, entry.limit - entry.used), 0);
    return base + grants;
  }
}

class ReadBarrier {
  private readonly waiters: Array<() => void> = [];
  private released = false;
  wait(): Promise<void> {
    if (this.released) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release(count: number): void {
    assert.equal(this.waiters.length, count, "both competitors reached the initial snapshot barrier");
    this.released = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

const resumeCapabilities: StageRecoveryCapabilities = {
  trusted_lineage: "supported",
  terminal_lifecycle: "supported",
  resume: "supported",
};

const replacementCapabilities: StageRecoveryCapabilities = {
  trusted_lineage: "supported",
  terminal_lifecycle: "supported",
  replacement_dispatch: "supported",
};

function hostProof(worker: WorkIdentity, operation: RecoveryHostEvidence["operation"], eventId: string): RecoveryStateProof["source"] extends string ? RecoveryHostEvidence["proof"] : never {
  return {
    authenticated: true,
    source: "truthful-test-host",
    event_id: eventId,
    binding_id: bindingId,
    observed_at: "2026-09-30T00:00:02.000Z",
  };
}

test("recovery resumes one terminal worker, persists prepare/ack, and replays without a second host call", async () => {
  const failed = identity("dispatch-terminal");
  const snapshot = baseSnapshot({
    identity: failed,
    producer: producer(failed),
    lifecycle: "terminal",
    terminal: terminal(failed.dispatch_id, "terminal-1"),
    budgets: [{ error_class: "terminal_failure", limit: 1, used: 0 }],
  });
  const store = new CanonicalRecoveryStore(snapshot);
  let resumeCalls = 0;
  const host = {
    capabilities: resumeCapabilities,
    resume: async (input: { operation_id: string; identity: WorkIdentity }) => {
      resumeCalls += 1;
      assert.equal(input.operation_id, "resume-op");
      assert.equal(input.identity.dispatch_id, failed.dispatch_id);
      return {
        authoritative: true as const,
        kind: "resume" as const,
        operation: "resume" as const,
        result: "running" as const,
        run_id: runId,
        dispatch_id: failed.dispatch_id,
        identity: failed,
        observed_at: "2026-09-30T00:00:02.000Z",
        proof: hostProof(failed, "resume", "resume-1"),
      };
    },
  };
  const first = await recoverStageExecution({ request: request("resume-op"), store, host });
  assert.equal(first.code, "worker_resumed");
  assert.equal(first.worker, "running");
  assert.equal(first.action, "resume");
  assert.equal(resumeCalls, 1);
  assert.deepEqual(store.transitions.map((entry) => entry.phase), ["prepare", "ack"]);
  const second = await recoverStageExecution({ request: request("resume-op"), store, host });
  assert.equal(second.replayed, true);
  assert.equal(second.code, "worker_resumed");
  assert.equal(resumeCalls, 1);
  assert.deepEqual(store.transitions.map((entry) => entry.phase), ["prepare", "ack"]);
});

test("unsupported preflight never turns provider metadata or callback failure into not_started", async () => {
  const pending = baseSnapshot({
    lifecycle: "pending",
    // Deliberately retained as an untrusted compatibility field. The algorithm
    // must not inspect or interpret it.
    ...( { provider_ref: "preflight:legacy-marker" } as unknown as Partial<StageRecoverySnapshot>),
  });
  const store = new CanonicalRecoveryStore(pending);
  let called = false;
  const host = {
    capabilities: { trusted_lineage: "supported" as const, preflight_not_started: "unsupported" as const },
    preflightNotStarted: async () => {
      called = true;
      throw new Error("untrusted exception");
    },
  };
  const recovered = await recoverStageExecution({ request: request("unsupported-preflight"), store, host });
  assert.equal(recovered.worker, "unknown");
  assert.equal(recovered.action, "wait");
  assert.equal(recovered.code, "worker_outcome_unknown");
  assert.equal(called, false);
  assert.equal(store.transitions.length, 0);
});

test("two concurrent replacements share one CAS winner and one linked writer", async () => {
  const failed = identity("dispatch-race");
  const barrier = new ReadBarrier();
  const store = new CanonicalRecoveryStore(baseSnapshot({
    identity: failed,
    producer: producer(failed),
    lifecycle: "terminal",
    terminal: terminal(failed.dispatch_id, "terminal-race"),
    budgets: [{ error_class: "terminal_failure", limit: 1, used: 0 }],
  }), barrier);
  const calls: string[] = [];
  const host = {
    capabilities: replacementCapabilities,
    dispatchReplacement: async (input: { operation_id: string; retry_of: string; replacement_identity?: WorkIdentity }) => {
      calls.push(input.operation_id);
      const replacement = input.replacement_identity;
      assert.ok(replacement);
      return {
        authoritative: true as const,
        kind: "replacement_dispatched" as const,
        operation: "replacement_dispatch" as const,
        run_id: runId,
        dispatch_id: failed.dispatch_id,
        identity: failed,
        original_dispatch_id: input.retry_of,
        new_identity: replacement,
        new_state: "authorized" as const,
        observed_at: "2026-09-30T00:00:03.000Z",
        proof: hostProof(failed, "replacement_dispatch", "replacement-1"),
      };
    },
  };
  const first = recoverStageExecution({ request: request("race-a"), store, host });
  const second = recoverStageExecution({ request: request("race-b"), store, host });
  barrier.release(2);
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.ok([left.code, right.code].includes("replacement_dispatched"));
  assert.ok([left.code, right.code].some((code) => code === "recovery_prepare_rejected" || code === "recovery_budget_exhausted" || code === "recovery_operation_conflict"));
  const prepareCount = store.transitions.filter((entry) => entry.phase === "prepare").length;
  assert.equal(prepareCount, 2);
  assert.equal(store.transitions.filter((entry) => entry.phase === "ack").length, 1);
});

for (const queued of [false, true]) {
  test(`replacement replay preserves ${queued ? "legacy queue next task" : "custom host running proof"}`, async () => {
    const failed = identity("dispatch-replay");
    const store = new CanonicalRecoveryStore(baseSnapshot({ identity: failed, producer: producer(failed), lifecycle: "terminal", terminal: terminal(failed.dispatch_id, "terminal-replay"), budgets: [{ error_class: "terminal_failure", limit: 1, used: 0 }] }));
    let calls = 0;
    const host = { capabilities: replacementCapabilities, dispatchReplacement: async (input: { operation_id: string; retry_of: string; replacement_identity?: WorkIdentity }) => {
      calls++;
      assert.ok(input.replacement_identity);
      return { authoritative: true as const, kind: "replacement_dispatched" as const, operation: "replacement_dispatch" as const, run_id: runId, dispatch_id: failed.dispatch_id, identity: failed, original_dispatch_id: input.retry_of, new_identity: input.replacement_identity, new_state: queued ? "pending" as const : "running" as const, observed_at: "2026-09-30T00:00:03.000Z", proof: { ...hostProof(failed, "replacement_dispatch", queued ? "recovery:legacy:queued" : "custom-running"), ...(queued ? { source: "omp-send-message" } : {}) } };
    } };
    const first = await recoverStageExecution({ request: request("replay-proof"), store, host });
    const replay = await recoverStageExecution({ request: { ...request("replay-proof"), operation: "diagnose", intent: "observe" }, store, host });
    assert.equal(first.code, queued ? "replacement_queued" : "replacement_dispatched");
    assert.equal(replay.code, first.code);
    assert.equal(replay.worker, queued ? "unknown" : "running");
    assert.equal(replay.continuation?.next_tool, queued ? "task" : undefined);
    assert.equal(calls, 1);
    if (queued) {
      const op = store.state.operations?.find((entry) => entry.replacement_identity);
      assert.ok(op?.replacement_identity);
      store.state = { ...store.state, identity: op.replacement_identity, state_proof: { ...store.state.state_proof, dispatch_id: op.replacement_identity.dispatch_id }, producer: producer(op.replacement_identity), lifecycle: "running", terminal: undefined };
      const running = await recoverStageExecution({ request: { ...request("replay-proof"), operation: "diagnose", intent: "observe" }, store, host });
      assert.equal(running.code, "worker_running");
      store.state = { ...store.state, lifecycle: "terminal", submission: { required: true, accepted: true, task: "developer" } };
      const complete = await recoverStageExecution({ request: { ...request("replay-proof"), operation: "diagnose", intent: "observe" }, store, host });
      assert.equal(complete.code, "worker_succeeded");
      assert.equal(complete.action, "none");
    }
  });
}

test("format repair sends exact canonical errors to the same producer and never dispatches implementation replacement", async () => {
  const worker = identity("dispatch-format");
  const fields = [
    { field: "outputs.implementation.ready", message: "must be boolean" },
    { field: "outputs.implementation.evidence_path", message: "must remain inside the artifact root" },
  ] as const;
  const store = new CanonicalRecoveryStore(baseSnapshot({
    identity: worker,
    producer: producer(worker),
    lifecycle: "running",
    producer_available: true,
    error_context: { class: "format_validation", code: "invalid_outputs", message: "submission failed validation", field_errors: fields, source: "canonical" },
    budgets: [{ error_class: "format_validation", limit: 1, used: 0 }],
  }));
  let received: readonly { field: string; message: string }[] | undefined;
  const host = {
    capabilities: { trusted_lineage: "supported" as const, format_repair: "supported" as const },
    formatRepair: async (input: { exact_format_errors?: readonly { field: string; message: string }[] }) => {
      received = input.exact_format_errors;
      return {
        authoritative: true as const,
        kind: "format_repair" as const,
        operation: "format_repair" as const,
        run_id: runId,
        dispatch_id: worker.dispatch_id,
        identity: worker,
        same_producer: true as const,
        accepted: true,
        errors_digest: "bypass-test-digest",
        observed_at: "2026-09-30T00:00:04.000Z",
        proof: hostProof(worker, "format_repair", "format-1"),
      };
    },
  };
  // A truthful adapter normally supplies the digest over the exact field-error
  // list. This fixture uses a wrapper below to assert the unmodified payload;
  // the invalid digest must be rejected, proving the guard is not a mock echo.
  const rejected = await recoverStageExecution({ request: request("format-op", "repair_format"), store, host });
  assert.equal(rejected.code, "invalid_format_repair_evidence");
  assert.deepEqual(received, fields);
  assert.equal(store.transitions.filter((entry) => entry.phase === "ack").length, 0);
});
test("valid format repair commits once and replay does not call the producer or consume another budget", async () => {
  const worker = identity("dispatch-format-valid");
  const fields = [
    { field: "outputs.summary", message: "must be present" },
  ] as const;
  const store = new CanonicalRecoveryStore(baseSnapshot({
    identity: worker,
    producer: producer(worker),
    lifecycle: "running",
    producer_available: true,
    error_context: { class: "format_validation", code: "missing_summary", message: "submission failed validation", field_errors: fields, source: "canonical" },
    budgets: [{ error_class: "format_validation", limit: 1, used: 0 }],
  }));
  let calls = 0;
  let received: readonly { field: string; message: string }[] | undefined;
  const host = {
    capabilities: { trusted_lineage: "supported" as const, format_repair: "supported" as const },
    formatRepair: async (input: { exact_format_errors?: readonly { field: string; message: string }[] }) => {
      calls += 1;
      received = input.exact_format_errors;
      return {
        authoritative: true as const,
        kind: "format_repair" as const,
        operation: "format_repair" as const,
        run_id: runId,
        dispatch_id: worker.dispatch_id,
        identity: worker,
        same_producer: true as const,
        accepted: true,
        errors_digest: recoveryErrorDigest(fields),
        observed_at: "2026-09-30T00:00:05.000Z",
        proof: hostProof(worker, "format_repair", "format-valid-1"),
      };
    },
  };
  const first = await recoverStageExecution({ request: request("format-valid-op", "repair_format"), store, host });
  assert.equal(first.code, "format_repair_accepted");
  assert.equal(first.action, "repair_format");
  assert.equal(first.attempts_remaining, 0);
  assert.deepEqual(received, fields);
  const second = await recoverStageExecution({ request: request("format-valid-op", "repair_format"), store, host });
  assert.equal(second.replayed, true);
  assert.equal(second.code, "format_repair_accepted");
  assert.equal(second.attempts_remaining, 0);
  assert.equal(calls, 1);
  assert.equal(store.transitions.filter((entry) => entry.phase === "prepare").length, 1);
  assert.equal(store.transitions.filter((entry) => entry.phase === "ack").length, 1);
});


test("stale handoff refresh uses owner CAS and returns a trusted handoff without dispatching a worker", async () => {
  const worker = identity("dispatch-handoff");
  const stale = {
    status: "stale" as const,
    revision: 0,
    binding_id: bindingId,
    identity: worker,
    run_id: runId,
    authority: "ordinary" as const,
  };
  const handoff: TrustedRecoveryHandoff = {
    run_id: runId,
    authority: "ordinary",
    revision: 1,
    binding_id: bindingId,
    identity: worker,
    owner_id: ownerId,
    ownership_epoch: "owner-epoch-1",
    proof: proof(1, worker.dispatch_id, "handoff-1"),
  };
  const store = new CanonicalRecoveryStore(baseSnapshot({ identity: worker, producer: producer(worker), handoff: stale, lifecycle: "running" }), undefined, handoff);
  const recovered = await recoverStageExecution({ request: request("handoff-op", "refresh_handoff"), store, host: { capabilities: {} } });
  assert.equal(recovered.code, "handoff_refreshed");
  assert.equal(recovered.action, "refresh_handoff");
  assert.ok(recovered.handoff);
  assert.equal(store.transitions.filter((entry) => entry.phase === "prepare").length, 1);
  assert.equal(store.transitions.filter((entry) => entry.phase === "ack").length, 1);
  // The owner supplied handoff is the only trusted value; no host dispatch hook
  // was present or called.
  assert.equal(recovered.handoff?.binding_id, bindingId);
  void handoff;
});
