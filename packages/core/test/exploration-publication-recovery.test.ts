import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { registerTeamWorkflow, registerWorkflowTools } from "../src/index.js";
import { readRunState, runTarget } from "../src/engine/run-store.js";
import { completeDispatch, reconcileTrustedTaskResult, type DispatchAuth } from "../src/engine/durable.js";
import { resolveWorkflowContract } from "../src/engine/workflow-contract.js";
import type { StageRecoveryLedger } from "../src/engine/stage-recovery-store.js";
import { CLASSIFICATION, RELIABLE_PROFILE, admitOrdinaryBatchWorkers, admitCtoLeadBatch, ctoHarness, ctoIngress, ctoStateSnapshot, details, emit, ordinaryHarness, ordinaryIngress, requireTool, terminalOrdinaryBatchWorkers, type RegisteredTool } from "./reliable-stage-execution-fixture.js";

const profile = {
  ...RELIABLE_PROFILE,
  name: "reliable-parallel-exploration",
  stages: [
    { id: "exploration", title: "Exploration", type: "consilium" as const, roles: ["analyst", "tech-researcher"], parallel: true, produces: ["exploration", "dod"] },
    { id: "next", title: "Next", type: "single" as const, role: "dev", produces: "next" },
  ],
};
const options = { workflowProfiles: [profile], roles: { analyst: "omp-analyst", "tech-researcher": "omp-tech-researcher", dev: "developer" } };
const outputs = (role: string) => ({
  exploration: { files_to_read: [{ path: `src/${role}.ts` }], summary: `${role} findings` },
  dod: { items: [{ id: `exploration-${role}`, source: "exploration", criterion: `${role} acceptance`, verify_method: "runtime smoke", status: "pending", evidence: "" }] },
});

test("both asynchronous exploration producers submit logical IDs and invalid output retains its exact recovery context", async () => {
  const harness = ordinaryHarness(options);
  try {
    const { runId, handoff } = await ordinaryIngress(harness, { classification: { ...CLASSIFICATION, workflow: profile.name } });
    const workers = await admitOrdinaryBatchWorkers(harness, handoff, "parallel-exploration");
    await emit(harness, "tool_result", { toolName: "task", toolCallId: workers[0]!.toolCallId, input: { context: "shared context", tasks: workers.map(worker => worker.input) }, details: { async: true, results: [] }, content: [], isError: false }, harness.context);
    const contract = resolveWorkflowContract(harness.root, { runId });
    const submit = requireTool(harness, "workflow_submit_result");
    const invalid = details((await submit.execute("bad-exploration", { outputs: { "exploration-analyst": outputs("analyst").exploration } }, undefined, undefined, workers[0]!.childContext)).details);
    assert.equal(invalid.code, "invalid_outputs", JSON.stringify(invalid));
    const recorded = JSON.parse(readFileSync(runTarget(harness.root, runId).statePath, "utf8")) as { stage_recovery: StageRecoveryLedger };
    const errorLine = Object.values(recorded.stage_recovery.lineages).find(line => line.identity.slot_id === "analyst");
    assert.equal(errorLine?.error_context?.class, "format_validation");
    assert.equal(errorLine?.error_context?.code, "invalid_outputs");
    for (const [index, worker] of workers.entries()) {
      const role = handoff.expected_roster[index]!.role;
      const assigned = contract.stage.slot_artifacts[role]!;
      const submitted = Object.fromEntries(assigned.map(id => [id, outputs(role)[id as "exploration" | "dod"]]));
      const result = details((await submit.execute(`valid-${role}`, { outputs: submitted }, undefined, undefined, worker.childContext)).details);
      assert.equal(result.ok, true, JSON.stringify(result));
      const receipt = details(result.receipt);
      const binding = details(receipt.binding);
      assert.equal(details(binding.identity).slot_id, role);
      const persisted = readRunState(harness.root, runId)!.stage_receipts![details(binding.identity).dispatch_id as string]!;
      assert.equal(persisted.receipt_id, receipt.receipt_id);
      assert.deepEqual(persisted.outputs.map(output => output.artifact_id).sort(), ["dod", "exploration"]);
    }
  } finally {
    await harness.close();
  }
});

test("a separately loaded native child persists format validation through its authenticated live root", async () => {
  const harness = ordinaryHarness(options);
  try {
    const { runId, handoff } = await ordinaryIngress(harness, { classification: { ...CLASSIFICATION, workflow: profile.name } });
    const [worker] = await admitOrdinaryBatchWorkers(harness, handoff, "separate-child-extension");
    const tools = new Map<string, RegisteredTool>();
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const on = (name: string, handler: (...args: unknown[]) => unknown) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
      return () => {};
    };
    const childPi = { zod: { z }, setLabel() {}, on, events: { on }, registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); }, sendMessage() {} };
    const childRegistration = {
      ...options,
      cwd: harness.root,
      resolveCwd: () => harness.root,
      getSessionController: () => undefined,
      resolveTrustedToolCallActor: () => undefined,
      observability: false,
    };
    registerTeamWorkflow(childPi as never, childRegistration);
    registerWorkflowTools(childPi as never, childRegistration);
    for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, worker!.childContext);
    const submit = tools.get("workflow_submit_result")!;
    const invalid = details((await submit.execute("child-invalid-format", { outputs: { "exploration-analyst": outputs("analyst").exploration } }, undefined, undefined, worker!.childContext)).details);
    assert.equal(invalid.code, "invalid_outputs", JSON.stringify(invalid));
    const recorded = JSON.parse(readFileSync(runTarget(harness.root, runId).statePath, "utf8")) as { stage_recovery: StageRecoveryLedger };
    const lineage = Object.values(recorded.stage_recovery?.lineages ?? {}).find(line => line.identity.slot_id === "analyst");
    assert.equal(lineage?.error_context?.code, "invalid_outputs", JSON.stringify(invalid));
    const accepted = details((await submit.execute("child-correct-format", { outputs: outputs("analyst") }, undefined, undefined, worker!.childContext)).details);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
  } finally {
    await harness.close();
  }
});

test("native multi-team format validation binds each exact assignment rather than an aggregate selection", async () => {
  const nativeProfile = {
    ...RELIABLE_PROFILE,
    name: "lightweight",
    stages: [
      { id: "exploration", title: "Exploration", type: "orchestrator" as const, role: "lead", produces: ["exploration", "dod"] },
      ...RELIABLE_PROFILE.stages.slice(1),
    ],
  };
  const teams = [
    { id: "team-a", sliceId: "slice-a", lead: "team-lead-a", roster: ["developer-a"] },
    { id: "team-b", sliceId: "slice-b", lead: "team-lead-b", roster: ["developer-b"] },
  ];
  const harness = ctoHarness({ workflowProfiles: [nativeProfile], ctoTeams: teams });
  try {
    const { runId } = await ctoIngress(harness);
    const leads = await admitCtoLeadBatch(harness, runId, teams.map(team => ({ teamId: team.id, sliceId: team.sliceId })));
    const submit = requireTool(harness, "workflow_submit_result");
    for (const [index, lead] of leads.entries()) {
      const invalid = details((await submit.execute(`native-invalid-${index}`, { outputs: {} }, undefined, undefined, lead.childContext)).details);
      assert.equal(invalid.code, "invalid_outputs", JSON.stringify(invalid));
    }
    const ledger = (ctoStateSnapshot(runId, harness.root) as unknown as { stage_recovery: StageRecoveryLedger }).stage_recovery;
    const lines = Object.values(ledger.lineages);
    assert.equal(lines.filter(line => line.error_context?.code === "invalid_outputs").length, 2);
    assert.deepEqual(lines.map(line => line.identity.slice_id).sort(), ["slice-a", "slice-b"]);
  } finally {
    await harness.close();
  }
});

test("public recovery diagnoses every canonical cancelled dispatch without an ambiguous aggregate identity", async () => {
  const harness = ordinaryHarness(options);
  try {
    const { runId, handoff } = await ordinaryIngress(harness, { classification: { ...CLASSIFICATION, workflow: profile.name } });
    await admitOrdinaryBatchWorkers(harness, handoff, "cancelled-exploration");
    const dispatches = readRunState(harness.root, runId)!.dispatch_capability!.dispatches;
    for (const dispatch of dispatches) {
      const completed = reconcileTrustedTaskResult(harness.root, { run_id: runId, dispatch_id: dispatch.id, work_identity: dispatch.work_identity, outcome: "cancelled", terminal_signal: "provider_terminal", evidence: "authoritative SDK cancellation fixture" });
      assert.equal(completed.ok, true);
    }
    const recover = requireTool(harness, "workflow_recover");
    const response = details((await recover.execute("diagnose-parallel-cancellations", { operation: "diagnose" }, undefined, undefined, harness.context)).details);
    const recoveries = response.recoveries as Array<{ slot_id: string; dispatch_id: string; result: Record<string, unknown> }>;
    assert.deepEqual(recoveries.map(row => row.slot_id).sort(), ["analyst", "tech-researcher"]);
    for (const row of recoveries) {
      assert.equal(row.result.ok, true, JSON.stringify(row));
      const recovery = details(row.result.recovery);
      assert.equal(recovery.worker, "terminal", JSON.stringify(recovery));
      assert.notEqual(recovery.code, "worker_outcome_unknown");
      assert.equal(details(recovery.state_proof).dispatch_id, row.dispatch_id);
    }
    assert.equal(readRunState(harness.root, runId)!.dispatch_capability!.dispatches.every(dispatch => dispatch.status === "cancelled"), true);
    const replaced = details((await recover.execute("replace-parallel-cancellations", { operation: "reconcile", intent: "replace" }, undefined, undefined, harness.context)).details);
    const replacements = replaced.recoveries as typeof recoveries;
    for (const row of replacements) {
      assert.equal(details(row.result.recovery).code, "replacement_queued", JSON.stringify(row));
      assert.equal(details(row.result.recovery).retry_of, row.dispatch_id);
    }
    const continuations = harness.messages.filter(entry => (entry.message as { customType?: string }).customType === "omp-workflow-stage-recovery");
    assert.equal(continuations.length, 2);
    await recover.execute("replace-parallel-cancellations", { operation: "reconcile", intent: "replace" }, undefined, undefined, harness.context);
    assert.equal(harness.messages.filter(entry => (entry.message as { customType?: string }).customType === "omp-workflow-stage-recovery").length, 2);
  } finally {
    await harness.close();
  }
});

test("caller-authored cancellation is not promoted to an authoritative SDK terminal proof", async () => {
  const harness = ordinaryHarness(options);
  try {
    const { runId, handoff } = await ordinaryIngress(harness, { classification: { ...CLASSIFICATION, workflow: profile.name } });
    await admitOrdinaryBatchWorkers(harness, handoff, "unattested-cancellation");
    const dispatches = readRunState(harness.root, runId)!.dispatch_capability!.dispatches;
    for (const dispatch of dispatches) {
      const completed = completeDispatch(harness.root, { ...(handoff as unknown as DispatchAuth), run_id: runId, token: handoff.dispatch_token, dispatch_id: dispatch.id, outcome: "cancelled", evidence: "caller-authored cancellation" }, { runId });
      assert.equal(completed.ok, true, completed.error);
    }
    const response = details((await requireTool(harness, "workflow_recover").execute("unattested-recovery", { operation: "reconcile", intent: "replace" }, undefined, undefined, harness.context)).details);
    const recoveries = response.recoveries as Array<{ result: Record<string, unknown> }>;
    for (const row of recoveries) {
      assert.equal(details(row.result.recovery).worker, "unknown");
      assert.equal(details(row.result.recovery).action, "wait");
    }
    assert.equal(harness.messages.some(entry => (entry.message as { customType?: string }).customType === "omp-workflow-stage-recovery"), false);
  } finally {
    await harness.close();
  }
});

test("a post-terminal research follow-up cannot publish under the revoked original producer grant", async () => {
  const harness = ordinaryHarness(options);
  try {
    const { runId, handoff } = await ordinaryIngress(harness, { classification: { ...CLASSIFICATION, workflow: profile.name } });
    const workers = await admitOrdinaryBatchWorkers(harness, handoff, "terminal-followup");
    await terminalOrdinaryBatchWorkers(harness, workers);
    for (const [index, worker] of workers.entries()) {
      const result = details((await requireTool(harness, "workflow_submit_result").execute(`stale-${index}`, { outputs: outputs(handoff.expected_roster[index]!.role) }, undefined, undefined, worker.childContext)).details);
      assert.equal(result.code, "producer_authority_denied");
    }
    assert.deepEqual(readRunState(harness.root, runId)!.stage_receipts ?? {}, {});
  } finally {
    await harness.close();
  }
});

test("automatic recovery serializes parallel slots across one shared canonical revision", async () => {
  const harness = ordinaryHarness(options);
  try {
    const { runId, handoff } = await ordinaryIngress(harness, { classification: { ...CLASSIFICATION, workflow: profile.name } });
    await admitOrdinaryBatchWorkers(harness, handoff, "automatic-parallel");
    for (const dispatch of readRunState(harness.root, runId)!.dispatch_capability!.dispatches) {
      assert.equal(reconcileTrustedTaskResult(harness.root, { run_id: runId, dispatch_id: dispatch.id, work_identity: dispatch.work_identity, outcome: "cancelled", terminal_signal: "provider_terminal", evidence: "authoritative SDK cancellation fixture" }).ok, true);
    }
    await harness.withRecoveryDispatchBarrier(async barrier => {
      const resumed = details((await requireTool(harness, "workflow_prepare").execute("automatic-parallel-resume", { mode: "resume", selector: { run_id: runId } }, undefined, undefined, harness.context)).details);
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      await barrier.queued;
      // Keep the first delivery in flight while the other slot can prepare.
      await new Promise<void>(resolve => setImmediate(resolve));
      barrier.release();
      await harness.waitForRecoveryMessage(entry => {
        const message = entry.message as { customType?: string; details?: { identity?: { slot_id?: string } } };
        return message.customType === "omp-workflow-stage-recovery" && message.details?.identity?.slot_id === "tech-researcher";
      });
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const recorded = JSON.parse(readFileSync(runTarget(harness.root, runId).statePath, "utf8")) as { stage_recovery: StageRecoveryLedger };
    const lineages = Object.values(recorded.stage_recovery.lineages);
    assert.deepEqual(lineages.map(line => line.identity.slot_id).sort(), ["analyst", "tech-researcher"]);
    for (const line of lineages) {
      assert.deepEqual(line.operations.filter(operation => operation.action === "replace").map(operation => operation.status), ["acked"]);
      assert.equal(line.budgets.find(budget => budget.error_class === "cancelled")?.used, 1);
    }
  } finally {
    await harness.close();
  }
});
