import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordScenarioEvent, scenarioTest } from "./reliable-stage-trace.js";
import { BRANCH, CLASSIFICATION, CTO_CLASSIFICATION, RELIABLE_PROFILE, admitCtoLead, admitCtoLeadAndWorker, admitCtoWorker, admitOrdinaryWorker, advanceCtoStage, askCtoCheckpoint, ctoHarness, ctoIngress, ctoSliceMarker, ctoStateSnapshot, details, emit, implementationOutput, ordinaryHarness, ordinaryIngress, requireTool, sessionManager, submission, terminalWorker, type Harness, type Handoff, type ToolDetails, type WorkerFixture } from "./reliable-stage-execution-fixture.js";
import { readRunState } from "../src/engine/run-store.js";
const NATIVE_LIGHTWEIGHT_PROFILE = {
  ...RELIABLE_PROFILE,
  name: "lightweight",
  title: "Registered native worker-first recovery profile",
} as typeof RELIABLE_PROFILE;
function ordinarySnapshot(harness: Harness, runId: string): string {
  const state = readRunState(harness.root, runId);
  assert.ok(state, "ordinary canonical state must be readable");
  return JSON.stringify(state);
}

function ctoSnapshot(harness: Harness, runId: string): string {
  const state = ctoStateSnapshot(runId, harness.root);
  assert.ok(state, "native canonical state must be readable");
  return JSON.stringify(state);
}
function ordinaryDispatches(harness: Harness, runId: string): Array<Record<string, unknown>> {
  const state = readRunState(harness.root, runId);
  assert.ok(state?.dispatch_capability, "ordinary dispatch capability must be persisted");
  return state.dispatch_capability.dispatches as unknown as Array<Record<string, unknown>>;
}

type Snapshot = Record<string, unknown>;

function snapshotRecord(value: string, label: string): Snapshot {
  const parsed: unknown = JSON.parse(value);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), label);
  return parsed as Snapshot;
}

function recordSnapshot(value: unknown, label: string): Snapshot {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as Snapshot;
}

function assertFormatContextPersisted(after: Snapshot): void {
  const recovery = recordSnapshot(after.stage_recovery, "format rejection must persist stage recovery");
  const lineages = recordSnapshot(recovery.lineages, "format rejection must persist recovery lineages");
  const lineage = Object.values(lineages).find((value) => {
    const candidate = recordSnapshot(value, "recovery lineage");
    const context = candidate.error_context;
    return context && typeof context === "object" && !Array.isArray(context)
      && (context as { class?: unknown }).class === "format_validation";
  });
  assert.ok(lineage, "format rejection must persist a format-validation recovery context");
  const context = recordSnapshot(recordSnapshot(lineage, "format recovery lineage").error_context, "format recovery context");
  assert.equal(context.source, "canonical", JSON.stringify(context));
  assert.ok(Array.isArray(context.field_errors), JSON.stringify(context));
  assert.ok(
    context.field_errors.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && typeof (entry as { field?: unknown }).field === "string"
      && (entry as { field: string }).field.endsWith(".evidence_path")),
    JSON.stringify(context),
  );
}

function stripNativeS04AllowedFields(stateValue: Snapshot, dispatchId: string): Snapshot {
  const state = structuredClone(stateValue) as Snapshot;
  delete state.updated_at;
  delete state.stage_recovery;
  const teams = state.teams;
  if (Array.isArray(teams)) {
    for (const value of teams) {
      const team = value && typeof value === "object" && !Array.isArray(value) ? value as Snapshot : undefined;
      if (!team) continue;
      delete team.updated_at;
      const identity = team.work_identity && typeof team.work_identity === "object" && !Array.isArray(team.work_identity)
        ? team.work_identity as Snapshot
        : undefined;
      if (identity) delete identity.session_id;
      const pending = team.pending && typeof team.pending === "object" && !Array.isArray(team.pending)
        ? team.pending as Snapshot
        : undefined;
      const pendingIdentity = pending?.identity && typeof pending.identity === "object" && !Array.isArray(pending.identity)
        ? pending.identity as Snapshot
        : undefined;
      if (pendingIdentity) delete pendingIdentity.session_id;
    }
  }
  const progressRoot = state.native_stage_progress;
  const progress = progressRoot && typeof progressRoot === "object" && !Array.isArray(progressRoot)
    ? (progressRoot as Snapshot)["team-a"] as Snapshot | undefined
    : undefined;
  if (progress) {
    delete progress.revision;
    delete progress.updated_at;
    const assignments = progress.assignments && typeof progress.assignments === "object" && !Array.isArray(progress.assignments)
      ? progress.assignments as Snapshot
      : undefined;
    const assignment = assignments?.[dispatchId];
    if (assignment && typeof assignment === "object" && !Array.isArray(assignment)) {
      const typedAssignment = assignment as Snapshot;
      delete typedAssignment.status;
      delete typedAssignment.updated_at;
      const identity = typedAssignment.identity && typeof typedAssignment.identity === "object" && !Array.isArray(typedAssignment.identity)
        ? typedAssignment.identity as Snapshot
        : undefined;
      if (identity) delete identity.session_id;
    }
  }
  return state;
}

function assertNativeS04Binding(before: Snapshot, after: Snapshot): string {
  const beforeProgressRoot = recordSnapshot(before.native_stage_progress, "native S04 state must retain progress");
  const afterProgressRoot = recordSnapshot(after.native_stage_progress, "native S04 state must retain progress");
  const beforeProgress = recordSnapshot(beforeProgressRoot["team-a"], "native S04 state must retain team progress");
  const afterProgress = recordSnapshot(afterProgressRoot["team-a"], "native S04 state must retain team progress");
  const beforeAssignments = recordSnapshot(beforeProgress.assignments, "native S04 state must retain assignments");
  const afterAssignments = recordSnapshot(afterProgress.assignments, "native S04 state must retain assignments");
  const dispatches = Object.keys(afterAssignments);
  assert.deepEqual(dispatches, Object.keys(beforeAssignments));
  const changedDispatches = dispatches.filter((dispatchId) => !isDeepStrictEqual(beforeAssignments[dispatchId], afterAssignments[dispatchId]));
  assert.equal(changedDispatches.length, 1, JSON.stringify(changedDispatches));
  const dispatchId = changedDispatches[0];
  assert.ok(dispatchId, "native S04 must identify the SDK-bound assignment");
  const beforeAssignment = recordSnapshot(beforeAssignments[dispatchId], "native S04 prior assignment");
  const afterAssignment = recordSnapshot(afterAssignments[dispatchId], "native S04 updated assignment");
  assert.equal(beforeAssignment.status, "reserved", JSON.stringify(beforeAssignment));
  assert.equal(afterAssignment.status, "running", JSON.stringify(afterAssignment));
  assert.notEqual(beforeAssignment.updated_at, afterAssignment.updated_at, JSON.stringify(afterAssignment));
  const beforeIdentity = recordSnapshot(beforeAssignment.identity, "native S04 prior identity");
  const afterIdentity = recordSnapshot(afterAssignment.identity, "native S04 updated identity");
  assert.equal(typeof beforeIdentity.session_id, "string", JSON.stringify(beforeIdentity));
  assert.equal(typeof afterIdentity.session_id, "string", JSON.stringify(afterIdentity));
  assert.notEqual(beforeIdentity.session_id, afterIdentity.session_id, JSON.stringify({ beforeIdentity, afterIdentity }));
  assert.notEqual(beforeProgress.revision, afterProgress.revision, JSON.stringify({ beforeProgress, afterProgress }));
  assert.notEqual(beforeProgress.updated_at, afterProgress.updated_at, JSON.stringify(afterProgress));
  assert.deepEqual(stripNativeS04AllowedFields(before, dispatchId), stripNativeS04AllowedFields(after, dispatchId));
  return dispatchId;
}

function assertUnsafeEvidenceRejection(route: "ordinary" | "cto", rejected: ToolDetails, before: string, after: string): void {
  assert.equal(rejected.ok, false, JSON.stringify(rejected));
  const fieldErrors = rejected.field_errors;
  assert.ok(Array.isArray(fieldErrors), JSON.stringify(rejected));
  assert.ok(
    fieldErrors.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && typeof (entry as { field?: unknown }).field === "string"
      && (entry as { field: string }).field.endsWith(".evidence_path")),
    JSON.stringify(rejected),
  );
  const beforeState = snapshotRecord(before, `${route} S04 prior canonical state`);
  const afterState = snapshotRecord(after, `${route} S04 updated canonical state`);
  assert.deepEqual(afterState.stage_receipts, beforeState.stage_receipts, `${route} unsafe evidence must not publish a receipt`);
  assert.deepEqual(afterState.advance_receipts, beforeState.advance_receipts, `${route} unsafe evidence must not advance`);
  assert.deepEqual(afterState.completion_envelope, beforeState.completion_envelope, `${route} unsafe evidence must not publish completion`);
  if (route === "ordinary") {
    assert.deepEqual(afterState.artifacts, beforeState.artifacts, "ordinary unsafe evidence must not publish artifacts");
    assert.deepEqual(afterState.stages, beforeState.stages, "ordinary unsafe evidence must not change stage status");
    assert.deepEqual(afterState.typed_checkpoint_decisions, beforeState.typed_checkpoint_decisions, "ordinary unsafe evidence must not approve");
    assert.deepEqual(afterState.checkpoint_decisions, beforeState.checkpoint_decisions, "ordinary unsafe evidence must not approve");
    const updated = structuredClone(afterState) as Snapshot;
    const prior = structuredClone(beforeState) as Snapshot;
    delete updated.updated_at;
    delete updated.state_revision;
    delete updated.stage_recovery;
    delete prior.updated_at;
    delete prior.state_revision;
    delete prior.stage_recovery;
    assert.deepEqual(updated, prior, "ordinary unsafe evidence may only record recovery diagnostics");
  } else {
    assertNativeS04Binding(beforeState, afterState);
    const afterProgress = recordSnapshot(afterState.native_stage_progress, "native S04 progress");
    const beforeProgress = recordSnapshot(beforeState.native_stage_progress, "native S04 progress");
    assert.deepEqual(
      recordSnapshot(afterProgress["team-a"], "native S04 team progress").approval,
      recordSnapshot(beforeProgress["team-a"], "native S04 team progress").approval,
      "native unsafe evidence must not approve the stage",
    );
  }
  assertFormatContextPersisted(afterState);
}

async function submitOutputs(
  harness: Harness,
  worker: WorkerFixture,
  callId: string,
  outputs: Record<string, unknown>,
): Promise<ToolDetails> {
  const tool = requireTool(harness, "workflow_submit_result");
  const result = await tool.execute(callId, submission(outputs), undefined, undefined, worker.childContext);
  return details(result.details);
}

async function submit(harness: Harness, worker: WorkerFixture, callId: string): Promise<ToolDetails> {
  return submitOutputs(harness, worker, callId, { implementation: implementationOutput() });
}

async function preflightAndRecover(harness: Harness, runId: string, currentHandoff: Handoff): Promise<Handoff> {
  const before = ordinaryDispatches(harness, runId);
  const marker = `${runId}-invalid-preflight`;
  assert.equal(before.filter((entry) => entry.tool_call_id === marker).length, 0);
  const assignment = currentHandoff.dispatch_markers[0];
  const roster = currentHandoff.expected_roster[0];
  assert.ok(assignment && roster, "preflight fixture must retain current assignment identity");
  const automaticMessagePromise = harness.waitForRecoveryMessage();
  const blocked = await harness.emit("tool_call", { toolName: "task", toolCallId: marker, input: { tasks: [{ agent: roster.agent, task: assignment.marker }] } }, harness.context);
  const hasAdmissionBlock = blocked.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("block" in entry)) return false;
    return entry.block === true;
  });
  recordScenarioEvent({ kind: "fault_observed", route: "O", phase: "preflight", faultPoint: "preflight", identities: { task: marker }, outcome: "REJECTED" });
  assert.ok(hasAdmissionBlock, "malformed task admission must be rejected before a worker starts");
  const after = ordinaryDispatches(harness, runId);
  const refused = after.find((entry) => !before.some((prior) => prior.id === entry.id));
  assert.ok(refused && typeof refused.id === "string", JSON.stringify({ before, after }));
  const refusedDispatch = refused.id as string;
  assert.equal(after.filter((entry) => entry.tool_call_id === marker).length, 1, "authoritative preflight refusal must retain one terminal not-started dispatch");
  assert.equal(after.filter((entry) => entry.status === "pending" && entry.tool_call_id === marker).length, 0, "preflight refusal must not leave a pending dispatch");
  const automaticMessage = await automaticMessagePromise;
  const message = details(automaticMessage.message);
  assert.equal(message.customType, "omp-workflow-stage-recovery", JSON.stringify(message));
  assert.equal(automaticMessage.options?.deliverAs, "followUp");
  assert.equal(automaticMessage.options?.triggerTurn, true);
  const messageDetails = details(message.details);
  assert.equal(messageDetails.version, 1, JSON.stringify(message));
  assert.equal(messageDetails.kind, "stage_recovery_continuation", JSON.stringify(message));
  assert.equal(messageDetails.authority, "ordinary", JSON.stringify(message));
  assert.equal(messageDetails.run_id, runId, JSON.stringify(message));
  assert.equal(typeof messageDetails.operation_id, "string", JSON.stringify(message));
  assert.equal(messageDetails.retry_of, refusedDispatch, JSON.stringify(message));
  const messageIdentity = details(messageDetails.identity);
  assert.equal(typeof messageIdentity.dispatch_id, "string", JSON.stringify(message));
  const recover = requireTool(harness, "workflow_recover");
  const diagnosed = details((await recover.execute("reliable-recovery-diagnose", { operation: "diagnose" }, undefined, undefined, harness.context)).details);
  recordScenarioEvent({ kind: "recovery_diagnosed", route: "O", tool: "workflow_recover", identities: { task: refusedDispatch }, outcome: "NOT_STARTED" });
  assert.equal(diagnosed.ok, true, JSON.stringify(diagnosed));
  const diagnosis = details(diagnosed.recovery);
  assert.equal(diagnosis.retry_of, refusedDispatch, JSON.stringify(diagnosed));
  const reconciled = details((await recover.execute("reliable-recovery-reconcile", { operation: "reconcile", intent: "retry" }, undefined, undefined, harness.context)).details);
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  const recovery = details(reconciled.recovery);
  assert.equal(recovery.code, "replacement_dispatched", JSON.stringify(reconciled));
  assert.equal(recovery.retry_of, refusedDispatch, JSON.stringify(reconciled));
  const recoveryEvidence = details(recovery.evidence);
  const replacementIdentity = details(recoveryEvidence.new_identity);
  assert.equal(typeof recovery.attempts_remaining, "number", JSON.stringify(reconciled));
  assert.equal(typeof replacementIdentity.dispatch_id, "string", JSON.stringify(reconciled));
  assert.equal(messageIdentity.dispatch_id, replacementIdentity.dispatch_id, JSON.stringify({ message, reconciled }));
  recordScenarioEvent({ kind: "recovery_reconciled", route: "O", tool: "workflow_recover", identities: { task: refusedDispatch }, outcome: "RETRY" });
  const begin = requireTool(harness, "workflow_begin");
  const begun = details((await begin.execute("reliable-stage-retry-begin", {}, undefined, undefined, harness.context)).details);
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const handoff = begun.handoff;
  assert.ok(handoff && typeof handoff === "object" && !Array.isArray(handoff), "corrected retry must return a fresh registered handoff");
  return handoff as Handoff;
}

scenarioTest("[O:S01] assigned ordinary worker submission uses the registered ingress", async () => {
  const harness = ordinaryHarness();
  try {
    const { runId, handoff } = await ordinaryIngress(harness);
    const worker = await admitOrdinaryWorker(harness, handoff, "s01");
    const receipt = await submit(harness, worker, "reliable-o-s01-submit");
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(details(receipt.receipt).binding.authority, "ordinary", JSON.stringify(receipt));
    await terminalWorker(harness, worker);
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:S01] assigned native CTO worker submission uses the registered ingress", async () => {
  const harness = ctoHarness();
  try {
    const { runId } = await ctoIngress(harness);
    const worker = await admitCtoLeadAndWorker(harness, runId);
    const receipt = await submit(harness, worker, "reliable-c-s01-submit");
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(details(receipt.receipt).binding.authority, "cto", JSON.stringify(receipt));
    await terminalWorker(harness, worker);
  } finally {
    await harness.close();
  }
});

scenarioTest("[O:S02] foreign or stale ordinary worker cannot borrow payload authority", async () => {
  const harness = ordinaryHarness();
  try {
    const { handoff } = await ordinaryIngress(harness);
    const worker = await admitOrdinaryWorker(harness, handoff, "s02");
    const foreignId = "foreign-worker";
    const foreignFile = join(harness.root, `${foreignId}.jsonl`);
    const foreignContext = {
      ...worker.childContext,
      session_id: foreignId,
      sessionFile: foreignFile,
      sessionManager: sessionManager(harness.root, foreignId, foreignFile, harness.context.sessionFile),
    };
    const tool = requireTool(harness, "workflow_submit_result");
    const result = await tool.execute("reliable-o-s02-submit", submission({ implementation: implementationOutput() }), undefined, undefined, foreignContext);
    const rejected = details(result.details);
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    await terminalWorker(harness, worker);
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:S02] foreign or stale CTO worker cannot borrow native payload authority", async () => {
  const harness = ctoHarness();
  try {
    const { runId } = await ctoIngress(harness);
    const worker = await admitCtoLeadAndWorker(harness, runId);
    const foreignId = "foreign-cto-worker";
    const foreignFile = join(harness.root, `${foreignId}.jsonl`);
    const foreignContext = {
      ...worker.childContext,
      session_id: foreignId,
      sessionFile: foreignFile,
      sessionManager: sessionManager(harness.root, foreignId, foreignFile, harness.context.sessionFile),
    };
    const tool = requireTool(harness, "workflow_submit_result");
    const result = await tool.execute("reliable-c-s02-submit", submission({ implementation: implementationOutput() }), undefined, undefined, foreignContext);
    const rejected = details(result.details);
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    await terminalWorker(harness, worker);
  } finally {
    await harness.close();
  }
});

scenarioTest("[O:S03] ordinary field validation rejects invalid output before publication", async () => {
  const harness = ordinaryHarness();
  try {
    const { handoff } = await ordinaryIngress(harness);
    const worker = await admitOrdinaryWorker(harness, handoff, "s03");
    const tool = requireTool(harness, "workflow_submit_result");
    const result = await tool.execute("reliable-o-s03-submit", { outputs: { implementation: { ready: "not-a-boolean" } } }, undefined, undefined, worker.childContext);
    const rejected = details(result.details);
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.ok(rejected.field_errors, JSON.stringify(rejected));
    await terminalWorker(harness, worker);
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:S03] native CTO field validation rejects invalid output before publication", async () => {
  const harness = ctoHarness();
  try {
    const { runId } = await ctoIngress(harness);
    const worker = await admitCtoLeadAndWorker(harness, runId);
    const tool = requireTool(harness, "workflow_submit_result");
    const result = await tool.execute("reliable-c-s03-submit", { outputs: { implementation: { ready: "not-a-boolean" } } }, undefined, undefined, worker.childContext);
    const rejected = details(result.details);
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.ok(rejected.field_errors, JSON.stringify(rejected));
    await terminalWorker(harness, worker);
  } finally {
    await harness.close();
  }
});

scenarioTest("[O:S04] ordinary evidence containment rejects unsafe publication", async () => {
  const harness = ordinaryHarness();
  try {
    const { runId, handoff } = await ordinaryIngress(harness);
    const worker = await admitOrdinaryWorker(harness, handoff, "s04");
    const before = ordinarySnapshot(harness, runId);
    const tool = requireTool(harness, "workflow_submit_result");
    const result = await tool.execute(
      "reliable-o-s04-submit",
      submission({ implementation: implementationOutput({ evidence_path: "../outside.json" }) }),
      undefined,
      undefined,
      worker.childContext,
    );
    const rejected = details(result.details);
    const after = ordinarySnapshot(harness, runId);
    assertUnsafeEvidenceRejection("ordinary", rejected, before, after);
    await terminalWorker(harness, worker);
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:S04] native CTO evidence containment rejects unsafe publication", async () => {
  const harness = ctoHarness();
  try {
    const { runId } = await ctoIngress(harness);
    const worker = await admitCtoLeadAndWorker(harness, runId);
    const before = ctoSnapshot(harness, runId);
    const tool = requireTool(harness, "workflow_submit_result");
    const result = await tool.execute(
      "reliable-c-s04-submit",
      submission({ implementation: implementationOutput({ evidence_path: "../outside.json" }) }),
      undefined,
      undefined,
      worker.childContext,
    );
    const rejected = details(result.details);
    const after = ctoSnapshot(harness, runId);
    assertUnsafeEvidenceRejection("cto", rejected, before, after);
    await terminalWorker(harness, worker);
  } finally {
    await harness.close();
  }
});

scenarioTest("[O:A01][O:A02] ordinary registered chain recovers preflight, gates approval, and dispatches next stage", async () => {
  const harness = ordinaryHarness();
  try {
    const { runId, handoff } = await ordinaryIngress(harness);
    const correctedHandoff = await preflightAndRecover(harness, runId, handoff);
    const worker = await admitOrdinaryWorker(harness, correctedHandoff, "a01");
    const receipt = await submitOutputs(harness, worker, "reliable-o-a01-submit", {
      implementation: implementationOutput({
        ready: true,
        validation_run: true,
        validation_evidence: "registered scenario positive completion",
      }),
    });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    await terminalWorker(harness, worker);
    const advance = requireTool(harness, "workflow_advance");
    const denied = await advance.execute("reliable-o-a01-denied", {
      token: correctedHandoff.advance_token,
      capability_id: correctedHandoff.capability_id,
      run_key: correctedHandoff.run_key,
      branch: BRANCH,
      workflow: RELIABLE_PROFILE.name,
      profile_hash: correctedHandoff.profile_hash,
      stage_cursor: correctedHandoff.stage_cursor,
      cursor_epoch: correctedHandoff.cursor_epoch,
      loop_iteration: correctedHandoff.loop_iteration,
      evidence: "worker terminal",
    }, undefined, undefined, harness.context);
    const deniedDetails = details(denied.details);
    assert.equal(deniedDetails.ok, false, JSON.stringify(deniedDetails));
    const checkpointAsk = requireTool(harness, "workflow_checkpoint_ask");
    const ask = await checkpointAsk.execute("reliable-o-a01-ask", {
      token: correctedHandoff.advance_token,
      capability_id: correctedHandoff.capability_id,
      run_key: correctedHandoff.run_key,
      branch: BRANCH,
      workflow: RELIABLE_PROFILE.name,
      stage_cursor: correctedHandoff.stage_cursor,
      cursor_epoch: correctedHandoff.cursor_epoch,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
      loop_iteration: correctedHandoff.loop_iteration,
    }, undefined, undefined, harness.context);
    const askDetails = details(ask.details);
    assert.equal(askDetails.ok, true, JSON.stringify(askDetails));
    const provenance = askDetails.actor_provenance;
    assert.ok(provenance && typeof provenance === "object", JSON.stringify(askDetails));
    const checkpoint = requireTool(harness, "workflow_checkpoint");
    const recorded = await checkpoint.execute("reliable-o-a01-checkpoint", {
      token: correctedHandoff.advance_token,
      capability_id: correctedHandoff.capability_id,
      run_key: correctedHandoff.run_key,
      branch: BRANCH,
      workflow: RELIABLE_PROFILE.name,
      profile_hash: correctedHandoff.profile_hash,
      stage_cursor: correctedHandoff.stage_cursor,
      cursor_epoch: correctedHandoff.cursor_epoch,
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
      loop_iteration: correctedHandoff.loop_iteration,
      authorization: "human",
      actor_provenance: provenance,
      decision: "proceed",
      rationale: "registered scenario approval",
    }, undefined, undefined, harness.context);
    assert.equal(details(recorded.details).ok, true, JSON.stringify(recorded.details));
    const advanced = await advance.execute("reliable-o-a01-advance", {
      token: correctedHandoff.advance_token,
      capability_id: correctedHandoff.capability_id,
      run_key: correctedHandoff.run_key,
      branch: BRANCH,
      workflow: RELIABLE_PROFILE.name,
      profile_hash: correctedHandoff.profile_hash,
      stage_cursor: correctedHandoff.stage_cursor,
      cursor_epoch: correctedHandoff.cursor_epoch,
      loop_iteration: correctedHandoff.loop_iteration,
      evidence: "approved worker terminal",
    }, undefined, undefined, harness.context);
    const advancedDetails = details(advanced.details);
    assert.equal(advancedDetails.ok, true, JSON.stringify(advancedDetails));
    const advancedHandoff = advancedDetails.handoff;
    assert.ok(advancedHandoff && typeof advancedHandoff === "object", JSON.stringify(advancedDetails));
    assert.equal(details(advancedHandoff).stage_cursor, "next", JSON.stringify(advancedHandoff));
    const nextBegin = requireTool(harness, "workflow_begin");
    const begunNext = details((await nextBegin.execute("reliable-o-a01-next-begin", {}, undefined, undefined, harness.context)).details);
    assert.equal(begunNext.ok, true, JSON.stringify(begunNext));
    const nextHandoff = begunNext.handoff;
    assert.ok(nextHandoff && typeof nextHandoff === "object", JSON.stringify(begunNext));
    assert.equal(details(nextHandoff).stage_cursor, "next", JSON.stringify(nextHandoff));
    const nextWorker = await admitOrdinaryWorker(harness, nextHandoff as Handoff, "a01-next");
    const downstreamDispatches = ordinaryDispatches(harness, runId);
    assert.ok(downstreamDispatches.some((entry) => entry.tool_call_id === nextWorker.toolCallId), JSON.stringify(downstreamDispatches));
    await terminalWorker(harness, nextWorker);
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:A01][C:A02] native CTO registered chain recovers a malformed lead, gates approval, and dispatches the next stage", async () => {
  const harness = ctoHarness({ workflowProfiles: [NATIVE_LIGHTWEIGHT_PROFILE] });
  try {
    const { runId } = await ctoIngress(harness, { profile: NATIVE_LIGHTWEIGHT_PROFILE.name });

    const malformedLead = await admitCtoLead(harness, runId, "a01-implementation");
    const marker = ctoSliceMarker(runId);
    const malformedToolCallId = "reliable-c-a01-malformed";
    const automaticMessagePromise = harness.waitForRecoveryMessage();
    const blocked = await emit(harness, "tool_call", {
      toolName: "task",
      toolCallId: malformedToolCallId,
      input: { tasks: [{ agent: "developer", task: `${marker}\nmissing required top context` }] },
    }, malformedLead.childContext);
    assert.ok(blocked.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { block?: unknown }).block === true), JSON.stringify(blocked));

    const refusedState = ctoStateSnapshot(runId, harness.root);
    const refusedProgress = refusedState?.native_stage_progress?.["team-a"];
    assert.ok(refusedProgress, "native preflight refusal must retain current stage progress");
    const refusedAssignment = Object.values(refusedProgress.assignments).find((entry) =>
      entry.identity.session_id === malformedLead.childContext.session_id && entry.terminal_signal?.startsWith("preflight:"));
    assert.ok(refusedAssignment, JSON.stringify(refusedProgress));
    assert.equal(refusedAssignment.status, "terminal", JSON.stringify(refusedAssignment));
    const refusedDispatch = refusedAssignment.identity.dispatch_id;

    const automaticMessage = await automaticMessagePromise;
    const message = details(automaticMessage.message);
    assert.equal(message.customType, "omp-workflow-stage-recovery", JSON.stringify(message));
    assert.equal(automaticMessage.options?.deliverAs, "followUp");
    assert.equal(automaticMessage.options?.triggerTurn, true);
    const messageDetails = details(message.details);
    assert.equal(messageDetails.version, 1, JSON.stringify(message));
    assert.equal(messageDetails.kind, "stage_recovery_continuation", JSON.stringify(message));
    assert.equal(messageDetails.authority, "cto", JSON.stringify(message));
    assert.equal(messageDetails.run_id, runId, JSON.stringify(message));
    assert.equal(messageDetails.retry_of, refusedDispatch, JSON.stringify(message));
    const messageIdentity = details(messageDetails.identity);
    assert.equal(typeof messageIdentity.dispatch_id, "string", JSON.stringify(message));

    const recover = requireTool(harness, "workflow_recover");
    const diagnosed = details((await recover.execute("reliable-c-a01-diagnose", { operation: "diagnose" }, undefined, undefined, harness.context)).details);
    assert.equal(diagnosed.ok, true, JSON.stringify(diagnosed));
    const diagnosis = details(diagnosed.recovery);
    assert.equal(diagnosis.retry_of, refusedDispatch, JSON.stringify(diagnosed));
    const reconciled = details((await recover.execute("reliable-c-a01-reconcile", { operation: "reconcile", intent: "retry" }, undefined, undefined, harness.context)).details);
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    const recovery = details(reconciled.recovery);
    assert.equal(recovery.code, "replacement_dispatched", JSON.stringify(reconciled));
    assert.equal(recovery.retry_of, refusedDispatch, JSON.stringify(reconciled));
    const replacementIdentity = details(details(recovery.evidence).new_identity);
    assert.equal(typeof replacementIdentity.dispatch_id, "string", JSON.stringify(reconciled));
    assert.equal(messageIdentity.dispatch_id, replacementIdentity.dispatch_id, JSON.stringify({ message, reconciled }));

    const correctedWorker = await admitCtoWorker(harness, runId, malformedLead, "a01-corrected");
    const correctedState = ctoStateSnapshot(runId, harness.root);
    const correctedProgress = correctedState?.native_stage_progress?.["team-a"];
    assert.ok(correctedProgress, "corrected native admission must retain stage progress");
    assert.ok(
      Object.values(correctedProgress.assignments).some((entry) => entry.identity.dispatch_id === messageIdentity.dispatch_id),
      JSON.stringify(correctedProgress),
    );
    const receipt = await submitOutputs(harness, correctedWorker, "reliable-c-a01-submit", {
      implementation: implementationOutput({
        ready: true,
        validation_run: true,
        validation_evidence: "registered scenario positive completion",
      }),
    });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    await terminalWorker(harness, correctedWorker);

    const blockedAdvance = await advanceCtoStage(harness, "slice-a", "reliable-c-a01-advance-blocked");
    assert.equal(blockedAdvance.ok, false, JSON.stringify(blockedAdvance));
    const checkpoint = await askCtoCheckpoint(harness, "slice-a", "reliable-c-a01-checkpoint");
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));
    const advanced = await advanceCtoStage(harness, "slice-a", "reliable-c-a01-advance");
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    const nextLead = await admitCtoLead(harness, runId, "a01-next-lead");
    const nextWorker = await admitCtoWorker(harness, runId, nextLead, "a01-next-worker");
    assert.notEqual(nextWorker.toolCallId, correctedWorker.toolCallId);
    await terminalWorker(harness, nextWorker);
  } finally {
    await harness.close();
  }
});
