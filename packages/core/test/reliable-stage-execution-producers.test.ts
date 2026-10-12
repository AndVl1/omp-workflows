import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { recordScenarioEvent, scenarioTest } from "./reliable-stage-trace.js";
import { z } from "zod";
import {
  advanceCtoStage,
  admitCtoLead,
  admitOrdinaryWorker,
  admitCtoWorker,
  implementationOutput,
  BRANCH,
  createCoreFixture,
  ctoHarness,
  ctoIngress,
  ctoStateSnapshot,
  details,
  emit,
  ordinaryHarness,
  ordinaryIngress,
  requireTool,
  submission,
  sessionManager,
  terminalWorker,
  RELIABLE_PROFILE,
  CTO_CLASSIFICATION,
  CLASSIFICATION,
  type Harness,
} from "./reliable-stage-execution-fixture.js";
import { runTarget, type Profile, type StageProducerToolDefinition } from "../src/index.js";
import { readRunControl, readRunState } from "../src/engine/run-store.js";
import { join } from "node:path";



type ProducerStage = {
  id: string;
  title: string;
  type: "orchestrator";
  produces: string;
  producer?: { kind: "tool"; tool_name: string };
};

function producerProfile(name: string, stage: ProducerStage): Profile {
  return {
    ...RELIABLE_PROFILE,
    name,
    title: `${name} producer acceptance profile`,
    stages: [stage],
  };
}

const ORCHESTRATOR_STAGE: ProducerStage = {
  id: "discovery",
  title: "Discovery",
  type: "orchestrator",
  produces: "discovery",
};

const TOOL_STAGE: ProducerStage = {
  id: "tool_stage",
  title: "Tool stage",
  type: "orchestrator",
  produces: "tool_output",
  producer: { kind: "tool", tool_name: "reliable_stage_tool" },
};

const ORCHESTRATOR_PROFILE = producerProfile("reliable-orchestrator-producer", ORCHESTRATOR_STAGE);
const TOOL_PROFILE = producerProfile("reliable-tool-producer", TOOL_STAGE);

// Native classification resolves FEATURE/QUICK to the built-in lightweight
// workflow. Each fixture explicitly overrides that registered name while
// retaining the producer-specific stage declaration.
const NATIVE_ORCHESTRATOR_PROFILE = producerProfile("lightweight", ORCHESTRATOR_STAGE);
const NATIVE_TOOL_PROFILE = producerProfile("lightweight", TOOL_STAGE);
const NATIVE_WORKER_PROFILE: Profile = {
  ...RELIABLE_PROFILE,
  name: "lightweight",
  title: "lightweight native worker acceptance override",
};
const producerClassification = (workflow: string): Record<string, unknown> => ({
  ...CLASSIFICATION,
  workflow,
});

function toolOutput(value: unknown): Record<string, unknown> {
  return { summary: value };
}

const discoveryOutput = (): Record<string, unknown> => ({
  task: "reliable producer acceptance",
  branch: BRANCH,
  constraints: [],
});

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) throw new Error("acceptance output must be JSON serializable");
  return encoded;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function nativeArtifactsRoot(harness: Harness, runId: string): string {
  return join(harness.root, ".work-state", "cto", runId, "artifacts");
}

async function submit(harness: Harness, context: unknown, id: string, outputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await requireTool(harness, "workflow_submit_result").execute(id, submission(outputs), undefined, undefined, context);
  return details(result.details);
}

function assertOwnReceipt(result: Record<string, unknown>, kind: "worker" | "orchestrator" | "tool"): Record<string, unknown> {
  assert.equal(result.ok, true, JSON.stringify(result));
  const receipt = details(result.receipt);
  const binding = details(receipt.binding);
  const producer = details(binding.producer);
  assert.equal(producer.kind, kind, JSON.stringify(receipt));
  return receipt;
}

function assertImmutableReceipt(harness: Harness, runId: string, receipt: Record<string, unknown>, artifactId: string, value: unknown): void {
  const outputs = receipt.outputs;
  assert.ok(Array.isArray(outputs), JSON.stringify(receipt));
  const output = details(outputs.find((entry) => details(entry).artifact_id === artifactId));
  assert.equal(output.artifact_id, artifactId, JSON.stringify(receipt));
  assert.equal(output.sha256, sha256(canonicalJson(value)), JSON.stringify(output));
  const immutableRef = output.immutable_ref;
  assert.equal(typeof immutableRef, "string");
  assert.notEqual(immutableRef, "");
  const binding = details(receipt.binding);
  const artifactsDir = binding.authority === "cto"
    ? nativeArtifactsRoot(harness, runId)
    : runTarget(harness.root, runId).artifactsDir;
  assert.ok(artifactsDir, "accepted receipt must retain its artifact root");
  const bytes = readFileSync(join(artifactsDir as string, immutableRef as string));
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), value);
  const identity = details(binding.identity);
  assert.equal(typeof identity.dispatch_id, "string");
  const state = binding.authority === "cto"
    ? ctoStateSnapshot(runId, harness.root)
    : readRunState(harness.root, runId);
  assert.ok(state, "accepted receipt must be persisted");
  const persisted = state?.stage_receipts?.[identity.dispatch_id as string];
  assert.ok(persisted, "accepted receipt must be persisted");
  assert.equal(persisted.receipt_id, receipt.receipt_id);
  assert.equal(persisted.submission_id, receipt.submission_id);
  assert.equal(persisted.digest, receipt.digest);
  assert.deepEqual(persisted.binding, receipt.binding);
  assert.deepEqual(persisted.outputs, receipt.outputs);
  assert.deepEqual(persisted.evidence, receipt.evidence);
  assert.equal(persisted.accepted_at, receipt.accepted_at);
}

function nativeSnapshot(harness: Harness, runId: string): string {
  const state = ctoStateSnapshot(runId, harness.root);
  assert.ok(state, "native canonical state must remain readable");
  return JSON.stringify(state);
}

function nativeAssignmentStatus(harness: Harness, runId: string): string {
  const state = ctoStateSnapshot(runId, harness.root);
  assert.ok(state, "native canonical state must remain readable");
  const progress = state.native_stage_progress?.["team-a"];
  assert.ok(progress, "native stage progress must be persisted after admission");
  const assignments = Object.values(progress.assignments);
  assert.equal(assignments.length, 1, JSON.stringify(progress));
  return assignments[0]!.status;
}

function noWorkerTerminal(harness: Harness, runId: string): void {
  const state = readRunState(harness.root, runId);
  assert.ok(state, "ordinary state must remain readable");
  const dispatches = state.dispatch_capability?.dispatches ?? [];
  assert.equal(dispatches.some((entry) => entry.status === "succeeded" || entry.status === "failed"), false, JSON.stringify(dispatches));
}

async function setupOrdinary(harness: Harness, profile: Profile): Promise<{ runId: string; handoff: Record<string, unknown> }> {
  const ingress = await ordinaryIngress(harness, { classification: producerClassification(profile.name) });
  return { runId: ingress.runId, handoff: ingress.handoff };
}


type ProducerCapture = {
  publish?: (outputs: Record<string, unknown>) => unknown;
  executeCount: number;
  publishCount: number;
  started?: () => void;
  release?: () => void;
  defer?: boolean;
  produce?: () => void;
  output?: Record<string, unknown>;
};

function reliableToolDefinition(captured: ProducerCapture, outputId = "tool_output", route: "O" | "C" = "O"): StageProducerToolDefinition {
  return {
    name: "reliable_stage_tool",
    label: "Reliable stage tool",
    description: "Deterministic registered producer used by acceptance.",
    parameters: z.object({}).strict(),
    async execute(_id, _params, _signal, _update, _ctx, publish) {
      captured.executeCount += 1;
      captured.publish = publish;
      captured.started?.();
      recordScenarioEvent({ kind: "tool_called", route, tool: "reliable_stage_tool", outcome: "STARTED" });
      if (captured.defer) await new Promise<void>((resolve) => { captured.release = resolve; });
      captured.produce?.();
      const published = publish({ [outputId]: captured.output ?? toolOutput("registered callback output") });
      captured.publishCount += 1;
      const publishedRecord = published && typeof published === "object" && !Array.isArray(published) ? published as Record<string, unknown> : undefined;
      recordScenarioEvent({ kind: "tool_completed", route, tool: "reliable_stage_tool", outcome: publishedRecord?.ok === true ? "ACCEPTED" : "REJECTED" });
      return { content: [{ type: "text", text: JSON.stringify(published) }], details: published };
    },
  };
}




scenarioTest("[O:S13] registered orchestrator output is accepted with canonical immutable receipt", async () => {
  const harness = createCoreFixture({ route: "ordinary", workflowProfiles: [ORCHESTRATOR_PROFILE] });
  // Real OMP ExtensionContext exposes identity through sessionManager only.
  Reflect.deleteProperty(harness.context, "session_id");
  try {
    const { runId } = await setupOrdinary(harness, ORCHESTRATOR_PROFILE);
    const value = discoveryOutput();
    const receipt = assertOwnReceipt(
      await submit(harness, harness.context, "reliable-o-s13-submit", { discovery: value }),
      "orchestrator",
    );
    assert.equal(details(receipt.binding).authority, "ordinary", JSON.stringify(receipt));
    assertImmutableReceipt(harness, runId, receipt, "discovery", value);
    noWorkerTerminal(harness, runId);
  } finally {
    await harness.close();
  }
});

scenarioTest("[O:S14] registered tool callback publishes through its assignment-bound receipt", async () => {
  const captured: ProducerCapture = { executeCount: 0, publishCount: 0 };
  const harness = createCoreFixture({
    route: "ordinary",
    workflowProfiles: [TOOL_PROFILE],
    stageProducerTools: [reliableToolDefinition(captured)],
  });
  Reflect.deleteProperty(harness.context, "session_id");
  try {
    const { runId } = await setupOrdinary(harness, TOOL_PROFILE);
    const result = details((await requireTool(harness, "reliable_stage_tool").execute(
      "reliable-o-s14",
      {},
      undefined,
      undefined,
      harness.context,
    )).details);
    const receipt = assertOwnReceipt(result, "tool");
    assert.equal(details(receipt.binding).authority, "ordinary", JSON.stringify(receipt));
    assertImmutableReceipt(harness, runId, receipt, "tool_output", toolOutput("registered callback output"));
    assert.equal(captured.executeCount, 1);
    assert.equal(captured.publishCount, 1);
    noWorkerTerminal(harness, runId);
  } finally {
    await harness.close();
  }
});

scenarioTest("[O:S15] unregistered, wrong-host, wrong-stage, and replayed callbacks fail closed", async () => {
  const captured: ProducerCapture = { executeCount: 0, publishCount: 0 };
  const harness = createCoreFixture({
    route: "ordinary",
    workflowProfiles: [TOOL_PROFILE],
    stageProducerTools: [reliableToolDefinition(captured)],
  });
  try {
    await setupOrdinary(harness, TOOL_PROFILE);
    const forged = await submit(harness, harness.context, "reliable-o-s15-forged", {
      tool_output: toolOutput("forged model output"),
    });
    assert.equal(forged.ok, false, JSON.stringify(forged));
    const foreignContext = {
      ...harness.context,
      session_id: "ordinary-foreign",
      sessionFile: join(harness.root, "ordinary-foreign.jsonl"),
    };
    const wrongHost = details((await requireTool(harness, "reliable_stage_tool").execute(
      "reliable-o-s15-foreign",
      {},
      undefined,
      undefined,
      foreignContext,
    )).details);
    assert.equal(wrongHost.ok, false, JSON.stringify(wrongHost));
    assert.equal(captured.executeCount, 0, "wrong host must not execute the registered producer");
    assert.equal(captured.publishCount, 0, "wrong host must not invoke a callback");
    assert.equal(captured.publish, undefined, "wrong host must not expose a callback");
    const valid = details((await requireTool(harness, "reliable_stage_tool").execute(
      "reliable-o-s15-valid",
      {},
      undefined,
      undefined,
      harness.context,
    )).details);
    const receipt = assertOwnReceipt(valid, "tool");
    assert.equal(captured.executeCount, 1);
    assert.equal(captured.publishCount, 1);
    const callback = captured.publish;
    assert.equal(typeof callback, "function");
    const replay = details(callback!({ tool_output: toolOutput("replayed callback output") }));
    assert.equal(replay.ok, false, JSON.stringify(replay));
    assert.equal(captured.publishCount, 1, "replay must not publish a second receipt");
    assert.equal(details(receipt.binding).producer.kind, "tool");
  } finally {
    await harness.close();
  }
});

scenarioTest("[O:A11] ordinary worker, orchestrator, and tool producers each receive one bound receipt", async () => {
  const workerHarness = ordinaryHarness();
  try {
    const { handoff } = await ordinaryIngress(workerHarness);
    const worker = await admitOrdinaryWorker(workerHarness, handoff, "a11-worker");
    const receipt = assertOwnReceipt(
      await submit(workerHarness, worker.childContext, "reliable-o-a11-worker", {
        implementation: { files_touched: ["packages/core/src/engine/reliable-stage.ts"] },
      }),
      "worker",
    );
    assert.equal(details(receipt.binding).authority, "ordinary", JSON.stringify(receipt));
    await terminalWorker(workerHarness, worker);
  } finally {
    await workerHarness.close();
  }

  const orchestratorHarness = createCoreFixture({ route: "ordinary", workflowProfiles: [ORCHESTRATOR_PROFILE] });
  try {
    const { runId } = await setupOrdinary(orchestratorHarness, ORCHESTRATOR_PROFILE);
    const value = discoveryOutput();
    const receipt = assertOwnReceipt(
      await submit(orchestratorHarness, orchestratorHarness.context, "reliable-o-a11-orchestrator", { discovery: value }),
      "orchestrator",
    );
    assertImmutableReceipt(orchestratorHarness, runId, receipt, "discovery", value);
  } finally {
    await orchestratorHarness.close();
  }

  const captured: ProducerCapture = { executeCount: 0, publishCount: 0 };
  const toolHarness = createCoreFixture({
    route: "ordinary",
    workflowProfiles: [TOOL_PROFILE],
    stageProducerTools: [reliableToolDefinition(captured)],
  });
  try {
    const { runId } = await setupOrdinary(toolHarness, TOOL_PROFILE);
    const receipt = assertOwnReceipt(details((await requireTool(toolHarness, "reliable_stage_tool").execute(
      "reliable-o-a11-tool",
      {},
      undefined,
      undefined,
      toolHarness.context,
    )).details), "tool");
    assertImmutableReceipt(toolHarness, runId, receipt, "tool_output", toolOutput("registered callback output"));
  } finally {
    await toolHarness.close();
  }
});

scenarioTest("[O:A12] a real assigned worker outranks forged worker-looking model fields", async () => {
  const harness = ordinaryHarness();
  try {
    const { handoff } = await ordinaryIngress(harness);
    const worker = await admitOrdinaryWorker(harness, handoff, "a12-worker");
    const forged = await submit(harness, harness.context, "reliable-o-a12-forged", {
      implementation: {
        files_touched: ["packages/core/src/engine/reliable-stage.ts"],
        producer: { kind: "worker", role: "developer", slot: "forged" },
      },
    });
    assert.equal(forged.ok, false, JSON.stringify(forged));
    const accepted = assertOwnReceipt(
      await submit(harness, worker.childContext, "reliable-o-a12-worker", {
        implementation: { files_touched: ["packages/core/src/engine/reliable-stage.ts"] },
      }),
      "worker",
    );
    assert.equal(details(accepted.binding).authority, "ordinary", JSON.stringify(accepted));
    await terminalWorker(harness, worker);
  } finally {
    await harness.close();
  }
});

scenarioTest("[O:A13] callback publication cannot borrow ambient model context while invocation is live", async () => {
  const captured: ProducerCapture = { executeCount: 0, publishCount: 0, defer: true };
  const harness = createCoreFixture({
    route: "ordinary",
    workflowProfiles: [TOOL_PROFILE],
    stageProducerTools: [reliableToolDefinition(captured)],
  });
  try {
    await setupOrdinary(harness, TOOL_PROFILE);
    const started = new Promise<void>((resolve) => { captured.started = resolve; });
    const invocation = requireTool(harness, "reliable_stage_tool").execute(
      "reliable-o-a13",
      {},
      undefined,
      undefined,
      harness.context,
    );
    await started;
    const borrowed = await submit(harness, harness.context, "reliable-o-a13-borrowed", {
      tool_output: toolOutput("ambient model output"),
    });
    assert.equal(borrowed.ok, false, JSON.stringify(borrowed));
    assert.equal(captured.publishCount, 0);
    assert.equal(typeof captured.release, "function");
    captured.release!();
    const result = details((await invocation).details);
    const receipt = assertOwnReceipt(result, "tool");
    assert.equal(captured.publishCount, 1);
    const closed = details(captured.publish!({ tool_output: toolOutput("late callback") }));
    assert.equal(closed.ok, false, JSON.stringify(closed));
    assert.equal(details(receipt.binding).producer.kind, "tool");
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:S13] configured native lead publishes an immutable orchestrator receipt before root advance", async () => {
  const harness = ctoHarness({ workflowProfiles: [NATIVE_ORCHESTRATOR_PROFILE] });
  try {
    const { runId } = await ctoIngress(harness, {
      profile: NATIVE_ORCHESTRATOR_PROFILE.name,
      classification: CTO_CLASSIFICATION,
    });
    const lead = await admitCtoLead(harness, runId, "c-s13");
    Reflect.deleteProperty(lead.childContext, "session_id");
    const value = discoveryOutput();
    const rootBefore = nativeSnapshot(harness, runId);
    const forgedRoot = await submit(harness, harness.context, "reliable-c-s13-root", {
      discovery: { ...value, producer: { kind: "orchestrator", owner: "native-lead" } },
    });
    assert.equal(forgedRoot.ok, false, JSON.stringify(forgedRoot));
    assert.equal(nativeSnapshot(harness, runId), rootBefore, "generic native root must not impersonate its configured lead");

    const foreignSessionId = "reliable-c-s13-foreign";
    const foreignSessionFile = join(harness.root, `${foreignSessionId}.jsonl`);
    const foreignContext = {
      ...lead.childContext,
      session_id: foreignSessionId,
      sessionFile: foreignSessionFile,
      sessionManager: sessionManager(harness.root, foreignSessionId, foreignSessionFile, harness.context.sessionFile),
    };
    const foreignBefore = nativeSnapshot(harness, runId);
    const foreign = await submit(harness, foreignContext, "reliable-c-s13-foreign", { discovery: value });
    assert.equal(foreign.ok, false, JSON.stringify(foreign));
    assert.equal(nativeSnapshot(harness, runId), foreignBefore, "foreign native lead must not publish");

    assert.equal(ctoStateSnapshot(runId, harness.root)?.native_stage_progress?.["team-a"]?.approval, undefined);
    const receipt = assertOwnReceipt(
      await submit(harness, lead.childContext, "reliable-c-s13-submit", { discovery: value }),
      "orchestrator",
    );
    const binding = details(receipt.binding);
    assert.equal(binding.authority, "cto", JSON.stringify(receipt));
    assert.equal(details(binding.producer).owner, "native-lead", JSON.stringify(receipt));
    assertImmutableReceipt(harness, runId, receipt, "discovery", value);
    assert.equal(nativeAssignmentStatus(harness, runId), "accepted", "receipt acceptance must not fabricate a lead terminal");
    assert.equal(ctoStateSnapshot(runId, harness.root)?.native_stage_progress?.["team-a"]?.approval, undefined);

    const advanced = await advanceCtoStage(harness, "slice-a", "reliable-c-s13-advance");
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    assert.equal(ctoStateSnapshot(runId, harness.root)?.native_stage_progress?.["team-a"]?.status, "complete");
    assert.equal(ctoStateSnapshot(runId, harness.root)?.native_stage_progress?.["team-a"]?.approval, undefined);

    await terminalWorker(harness, lead);
    const staleBefore = nativeSnapshot(harness, runId);
    const stale = await submit(harness, lead.childContext, "reliable-c-s13-stale", { discovery: value });
    assert.equal(stale.ok, false, JSON.stringify(stale));
    assert.equal(nativeSnapshot(harness, runId), staleBefore, "stale native lead must not publish after lifecycle completion");
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:S14] configured native lead callback publishes an immutable tool receipt before root advance", async () => {
  const captured: ProducerCapture = { executeCount: 0, publishCount: 0 };
  const harness = ctoHarness({
    workflowProfiles: [NATIVE_TOOL_PROFILE],
    stageProducerTools: [reliableToolDefinition(captured, "tool_output", "C")],
  });
  try {
    const { runId } = await ctoIngress(harness, {
      profile: NATIVE_TOOL_PROFILE.name,
      classification: CTO_CLASSIFICATION,
    });
    const evidencePath = "evidence/c-s14-tool.bin";
    const evidenceBytes = Buffer.from([0, 1, 2, 255, 42, 17]);
    const sourceEvidencePath = join(nativeArtifactsRoot(harness, runId), evidencePath);
    let evidencePrepared = false;
    captured.produce = () => {
      if (evidencePrepared) return;
      evidencePrepared = true;
      mkdirSync(join(nativeArtifactsRoot(harness, runId), "evidence"), { recursive: true });
      writeFileSync(sourceEvidencePath, evidenceBytes);
    };
    const toolValue = { ...toolOutput("registered callback output"), evidence_path: evidencePath };
    captured.output = toolValue;
    const lead = await admitCtoLead(harness, runId, "c-s14");
    const result = details((await requireTool(harness, "reliable_stage_tool").execute(
      "reliable-c-s14-tool",
      {},
      undefined,
      undefined,
      lead.childContext,
    )).details);
    const receipt = assertOwnReceipt(result, "tool");
    const binding = details(receipt.binding);
    assert.equal(binding.authority, "cto", JSON.stringify(receipt));
    assert.equal(details(binding.producer).tool_name, "reliable_stage_tool", JSON.stringify(receipt));
    assertImmutableReceipt(harness, runId, receipt, "tool_output", toolValue);
    assert.equal(captured.executeCount, 1);
    assert.equal(captured.publishCount, 1);
    assert.equal(nativeAssignmentStatus(harness, runId), "accepted", "callback acceptance must not fabricate a lead terminal");
    assert.equal(ctoStateSnapshot(runId, harness.root)?.native_stage_progress?.["team-a"]?.approval, undefined);

    const receiptOutputs = receipt.outputs;
    assert.ok(Array.isArray(receiptOutputs), JSON.stringify(receipt));
    const outputRow = details(receiptOutputs.find((entry) => details(entry).artifact_id === "tool_output"));
    const evidenceRows = receipt.evidence;
    assert.ok(Array.isArray(evidenceRows), JSON.stringify(receipt));
    const evidenceRow = details(evidenceRows.find((entry) => details(entry).artifact_id === "tool_output"));
    assert.equal(evidenceRow.relative_path, evidencePath, JSON.stringify(evidenceRow));
    assert.equal(evidenceRow.sha256, sha256Bytes(evidenceBytes), JSON.stringify(evidenceRow));
    assert.equal(typeof evidenceRow.immutable_ref, "string");
    assert.notEqual(evidenceRow.immutable_ref, outputRow.immutable_ref, "evidence needs its own immutable journal entry");
    const immutableEvidencePath = join(nativeArtifactsRoot(harness, runId), evidenceRow.immutable_ref as string);
    assert.deepEqual(readFileSync(immutableEvidencePath), evidenceBytes);

    const replay = details((await requireTool(harness, "reliable_stage_tool").execute(
      "reliable-c-s14-replay",
      {},
      undefined,
      undefined,
      lead.childContext,
    )).details);
    const replayReceipt = assertOwnReceipt(replay, "tool");
    assert.equal(replayReceipt.receipt_id, receipt.receipt_id);
    assert.equal(replayReceipt.submission_id, receipt.submission_id);
    assert.equal(replayReceipt.digest, receipt.digest);
    assertImmutableReceipt(harness, runId, replayReceipt, "tool_output", toolValue);
    assert.equal(captured.executeCount, 2);
    assert.equal(captured.publishCount, 2);

    const beforeSourceFault = nativeSnapshot(harness, runId);
    writeFileSync(sourceEvidencePath, Buffer.from("mutated-source-evidence", "utf8"));
    assert.deepEqual(readFileSync(immutableEvidencePath), evidenceBytes, "source mutation must not alter immutable evidence");
    unlinkSync(sourceEvidencePath);
    assert.deepEqual(readFileSync(immutableEvidencePath), evidenceBytes, "source deletion must not alter immutable evidence");
    const deletedSourceReplay = details((await requireTool(harness, "reliable_stage_tool").execute(
      "reliable-c-s14-source-deleted-replay",
      {},
      undefined,
      undefined,
      lead.childContext,
    )).details);
    const deletedSourceReceipt = assertOwnReceipt(deletedSourceReplay, "tool");
    assert.equal(deletedSourceReceipt.receipt_id, receipt.receipt_id);
    assert.equal(deletedSourceReceipt.submission_id, receipt.submission_id);
    assert.equal(deletedSourceReceipt.digest, receipt.digest);
    assertImmutableReceipt(harness, runId, deletedSourceReceipt, "tool_output", toolValue);
    assert.equal(captured.executeCount, 3);
    assert.equal(captured.publishCount, 3);
    assert.equal(nativeSnapshot(harness, runId), beforeSourceFault);

    writeFileSync(immutableEvidencePath, Buffer.from("tampered-immutable-evidence", "utf8"));
    const tamperedBefore = nativeSnapshot(harness, runId);
    const tampered = details((await requireTool(harness, "reliable_stage_tool").execute(
      "reliable-c-s14-tampered",
      {},
      undefined,
      undefined,
      lead.childContext,
    )).details);
    assert.equal(tampered.ok, false, JSON.stringify(tampered));
    assert.equal(nativeSnapshot(harness, runId), tamperedBefore, "tampered immutable evidence must not mutate native state");
    writeFileSync(immutableEvidencePath, evidenceBytes);

    const advanced = await advanceCtoStage(harness, "slice-a", "reliable-c-s14-advance");
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    assert.equal(ctoStateSnapshot(runId, harness.root)?.native_stage_progress?.["team-a"]?.status, "complete");
    assert.equal(ctoStateSnapshot(runId, harness.root)?.native_stage_progress?.["team-a"]?.approval, undefined);

    await terminalWorker(harness, lead);
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:S15] native root, foreign, stale, and replayed tool callbacks fail closed", async () => {
  const captured: ProducerCapture = { executeCount: 0, publishCount: 0 };
  const harness = ctoHarness({
    workflowProfiles: [NATIVE_TOOL_PROFILE],
    stageProducerTools: [reliableToolDefinition(captured, "tool_output", "C")],
  });
  try {
    const { runId } = await ctoIngress(harness, {
      profile: NATIVE_TOOL_PROFILE.name,
      classification: CTO_CLASSIFICATION,
    });
    const lead = await admitCtoLead(harness, runId, "c-s15");

    const rootBefore = nativeSnapshot(harness, runId);
    const forgedRoot = await submit(harness, harness.context, "reliable-c-s15-root", {
      tool_output: {
        ...toolOutput("forged root output"),
        producer: { kind: "tool", tool_name: "reliable_stage_tool", authority: "cto" },
      },
    });
    assert.equal(forgedRoot.ok, false, JSON.stringify(forgedRoot));
    assert.equal(nativeSnapshot(harness, runId), rootBefore, "generic native root must not mutate canonical state");

    const foreignSessionId = "reliable-c-s15-foreign";
    const foreignSessionFile = join(harness.root, `${foreignSessionId}.jsonl`);
    const foreignContext = {
      ...lead.childContext,
      session_id: foreignSessionId,
      sessionFile: foreignSessionFile,
      sessionManager: sessionManager(harness.root, foreignSessionId, foreignSessionFile, lead.childContext.session_id),
    };
    const foreignBefore = nativeSnapshot(harness, runId);
    const foreign = details((await requireTool(harness, "reliable_stage_tool").execute(
      "reliable-c-s15-foreign",
      {},
      undefined,
      undefined,
      foreignContext,
    )).details);
    assert.equal(foreign.ok, false, JSON.stringify(foreign));
    assert.equal(nativeSnapshot(harness, runId), foreignBefore, "foreign callback host must not mutate canonical state");
    assert.equal(captured.executeCount, 0, "foreign callback must not execute the registered producer");
    assert.equal(captured.publish, undefined, "foreign callback must not expose a publisher");

    const valid = details((await requireTool(harness, "reliable_stage_tool").execute(
      "reliable-c-s15-valid",
      {},
      undefined,
      undefined,
      lead.childContext,
    )).details);
    const receipt = assertOwnReceipt(valid, "tool");
    assertImmutableReceipt(harness, runId, receipt, "tool_output", toolOutput("registered callback output"));
    assert.equal(captured.executeCount, 1);
    assert.equal(captured.publishCount, 1);
    const callback = captured.publish;
    assert.equal(typeof callback, "function");

    const advanced = await advanceCtoStage(harness, "slice-a", "reliable-c-s15-advance");
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    await terminalWorker(harness, lead);

    const staleBefore = nativeSnapshot(harness, runId);
    const stale = details((await requireTool(harness, "reliable_stage_tool").execute(
      "reliable-c-s15-stale",
      {},
      undefined,
      undefined,
      lead.childContext,
    )).details);
    assert.equal(stale.ok, false, JSON.stringify(stale));
    assert.equal(nativeSnapshot(harness, runId), staleBefore, "stale native callback must not mutate canonical state");

    const replayBefore = nativeSnapshot(harness, runId);
    const replay = details(callback!({ tool_output: toolOutput("replayed callback output") }));
    assert.equal(replay.ok, false, JSON.stringify(replay));
    assert.equal(nativeSnapshot(harness, runId), replayBefore, "closed native publisher must not mutate canonical state");
    assert.equal(captured.publishCount, 1, "replay must not publish a second native receipt");
    assert.equal(details(receipt.binding).producer.kind, "tool");
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:A11] native worker, orchestrator, and tool producers each receive one bound receipt", async () => {
  const workerHarness = ctoHarness({ workflowProfiles: [NATIVE_WORKER_PROFILE] });
  try {
    const { runId } = await ctoIngress(workerHarness);
    const lead = await admitCtoLead(workerHarness, runId, "c-a11-worker-lead");
    const worker = await admitCtoWorker(workerHarness, runId, lead, "c-a11-worker");
    const receipt = assertOwnReceipt(
      await submit(workerHarness, worker.childContext, "reliable-c-a11-worker", { implementation: implementationOutput() }),
      "worker",
    );
    assert.equal(details(receipt.binding).authority, "cto", JSON.stringify(receipt));
    assertImmutableReceipt(workerHarness, runId, receipt, "implementation", implementationOutput());
    await terminalWorker(workerHarness, worker);
    await terminalWorker(workerHarness, lead);
  } finally {
    await workerHarness.close();
  }

  const orchestratorHarness = ctoHarness({ workflowProfiles: [NATIVE_ORCHESTRATOR_PROFILE] });
  try {
    const { runId } = await ctoIngress(orchestratorHarness, {
      profile: NATIVE_ORCHESTRATOR_PROFILE.name,
      classification: CTO_CLASSIFICATION,
    });
    const lead = await admitCtoLead(orchestratorHarness, runId, "c-a11-orchestrator");
    const value = discoveryOutput();
    const receipt = assertOwnReceipt(
      await submit(orchestratorHarness, lead.childContext, "reliable-c-a11-orchestrator", { discovery: value }),
      "orchestrator",
    );
    assert.equal(details(receipt.binding).authority, "cto", JSON.stringify(receipt));
    assertImmutableReceipt(orchestratorHarness, runId, receipt, "discovery", value);
  } finally {
    await orchestratorHarness.close();
  }

  const captured: ProducerCapture = { executeCount: 0, publishCount: 0 };
  const toolHarness = ctoHarness({
    workflowProfiles: [NATIVE_TOOL_PROFILE],
    stageProducerTools: [reliableToolDefinition(captured, "tool_output", "C")],
  });
  try {
    const { runId } = await ctoIngress(toolHarness, {
      profile: NATIVE_TOOL_PROFILE.name,
      classification: CTO_CLASSIFICATION,
    });
    const lead = await admitCtoLead(toolHarness, runId, "c-a11-tool");
    const receipt = assertOwnReceipt(details((await requireTool(toolHarness, "reliable_stage_tool").execute(
      "reliable-c-a11-tool",
      {},
      undefined,
      undefined,
      lead.childContext,
    )).details), "tool");
    assert.equal(details(receipt.binding).authority, "cto", JSON.stringify(receipt));
    assertImmutableReceipt(toolHarness, runId, receipt, "tool_output", toolOutput("registered callback output"));
  } finally {
    await toolHarness.close();
  }
});

scenarioTest("[C:A12] an actual native worker outranks forged root and lead worker-looking fields", async () => {
  const harness = ctoHarness({ workflowProfiles: [NATIVE_WORKER_PROFILE] });
  try {
    const { runId } = await ctoIngress(harness);
    const lead = await admitCtoLead(harness, runId, "c-a12-lead");
    const worker = await admitCtoWorker(harness, runId, lead, "c-a12-worker");
    const forgedOutputs = {
      implementation: implementationOutput({
        producer: { kind: "worker", role: "developer", slot: "forged", authority: "cto", run_id: runId },
      }),
    };

    const rootBefore = nativeSnapshot(harness, runId);
    const forgedRoot = await submit(harness, harness.context, "reliable-c-a12-root", forgedOutputs);
    assert.equal(forgedRoot.ok, false, JSON.stringify(forgedRoot));
    assert.equal(nativeSnapshot(harness, runId), rootBefore, "native root impersonation must not mutate canonical state");

    const leadBefore = nativeSnapshot(harness, runId);
    const forgedLead = await submit(harness, lead.childContext, "reliable-c-a12-lead", forgedOutputs);
    assert.equal(forgedLead.ok, false, JSON.stringify(forgedLead));
    assert.equal(nativeSnapshot(harness, runId), leadBefore, "native lead impersonation must not mutate canonical state");

    const accepted = assertOwnReceipt(
      await submit(harness, worker.childContext, "reliable-c-a12-worker", { implementation: implementationOutput() }),
      "worker",
    );
    assert.equal(details(accepted.binding).authority, "cto", JSON.stringify(accepted));
    assertImmutableReceipt(harness, runId, accepted, "implementation", implementationOutput());
    await terminalWorker(harness, worker);
    await terminalWorker(harness, lead);
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:A13] native callback publication is barriered from ambient context and closes after invocation", async () => {
  const captured: ProducerCapture = { executeCount: 0, publishCount: 0, defer: true };
  const harness = ctoHarness({
    workflowProfiles: [NATIVE_TOOL_PROFILE],
    stageProducerTools: [reliableToolDefinition(captured, "tool_output", "C")],
  });
  try {
    const { runId } = await ctoIngress(harness, {
      profile: NATIVE_TOOL_PROFILE.name,
      classification: CTO_CLASSIFICATION,
    });
    const lead = await admitCtoLead(harness, runId, "c-a13");
    const started = new Promise<void>((resolve) => { captured.started = resolve; });
    const invocation = requireTool(harness, "reliable_stage_tool").execute(
      "reliable-c-a13",
      {},
      undefined,
      undefined,
      lead.childContext,
    );
    const entered = await Promise.race([
      started.then(() => ({ kind: "started" as const })),
      invocation.then(
        (value) => ({ kind: "completed" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
    ]);
    let release: (() => void) | undefined;
    try {
      if (entered.kind === "completed") {
        assert.fail(`registered native tool completed before callback entry: ${JSON.stringify(details(entered.value.details))}`);
      }
      if (entered.kind === "rejected") throw entered.error;

      release = captured.release;
      assert.equal(typeof release, "function");
      const borrowedBefore = nativeSnapshot(harness, runId);
      const borrowed = await submit(harness, harness.context, "reliable-c-a13-borrowed", {
        tool_output: toolOutput("ambient model output"),
      });
      assert.equal(borrowed.ok, false, JSON.stringify(borrowed));
      assert.equal(nativeSnapshot(harness, runId), borrowedBefore, "ambient root context must not borrow the live callback assignment");
      assert.equal(captured.publishCount, 0);

      release!();
      const result = details((await invocation).details);
      const receipt = assertOwnReceipt(result, "tool");
      assert.equal(details(receipt.binding).authority, "cto", JSON.stringify(receipt));
      assertImmutableReceipt(harness, runId, receipt, "tool_output", toolOutput("registered callback output"));
      assert.equal(captured.publishCount, 1);

      const closedBefore = nativeSnapshot(harness, runId);
      const closed = details(captured.publish!({ tool_output: toolOutput("late callback") }));
      assert.equal(closed.ok, false, JSON.stringify(closed));
      assert.equal(nativeSnapshot(harness, runId), closedBefore, "closed native publisher must not mutate canonical state");
    } finally {
      release?.();
    }
  } finally {
    await harness.close();
  }
});

scenarioTest("[O:S04] a declared evidence reference cannot disappear during descriptor capture", async () => {
  const captured: ProducerCapture = {
    executeCount: 0,
    publishCount: 0,
    output: { summary: "descriptor capture boundary", evidence_path: "./proof.bin" },
  };
  const harness = createCoreFixture({
    route: "ordinary",
    workflowProfiles: [TOOL_PROFILE],
    stageProducerTools: [reliableToolDefinition(captured)],
  });
  try {
    const { runId } = await setupOrdinary(harness, TOOL_PROFILE);
    const artifactsDir = runTarget(harness.root, runId).artifactsDir!;
    captured.produce = () => writeFileSync(join(artifactsDir, "proof.bin"), Buffer.from([0, 255, 17]));
    const result = details((await requireTool(harness, "reliable_stage_tool").execute(
      "uncapturable-evidence",
      {},
      undefined,
      undefined,
      harness.context,
    )).details);
    assert.equal(result.ok, false, "uncapturable evidence must not yield an accepted receipt");
    assert.ok(Array.isArray(result.field_errors));
    assert.ok(result.field_errors.some((entry) => String(details(entry).field).endsWith("evidence_path")));
    assert.deepEqual(readRunState(harness.root, runId)?.stage_receipts ?? {}, {});
  } finally {
    await harness.close();
  }
});

for (const route of ["O", "C"] as const) {
  scenarioTest(`[${route}:A12] a released coordinator claim cannot authorize a worker publication`, async () => {
    const harness = route === "O"
      ? ordinaryHarness()
      : ctoHarness({ workflowProfiles: [NATIVE_WORKER_PROFILE] });
    try {
      let runId: string;
      let childContext: unknown;
      if (route === "O") {
        const ingress = await ordinaryIngress(harness);
        runId = ingress.runId;
        childContext = (await admitOrdinaryWorker(harness, ingress.handoff, "released-owner")).childContext;
      } else {
        const ingress = await ctoIngress(harness);
        runId = ingress.runId;
        const lead = await admitCtoLead(harness, runId, "released-owner");
        childContext = (await admitCtoWorker(harness, runId, lead, "released-owner")).childContext;
      }
      const receipts = () => route === "O"
        ? readRunState(harness.root, runId)?.stage_receipts ?? {}
        : ctoStateSnapshot(runId, harness.root)?.stage_receipts ?? {};
      const before = JSON.stringify(receipts());
      assert.equal(readRunControl(harness.root).execution_claim?.released_at, null);
      await emit(harness, "session_shutdown", { type: "session_shutdown" }, harness.context);
      const claim = readRunControl(harness.root).execution_claim;
      assert.ok(claim === null || claim.released_at !== null, "real session shutdown must release publication ownership");
      const rejected = await submit(harness, childContext, "released-owner-result", {
        implementation: implementationOutput(),
      });
      assert.equal(rejected.ok, false, "historical worker settlement is not current publication authority");
      assert.equal(JSON.stringify(receipts()), before);
    } finally {
      await harness.close();
    }
  });
}

scenarioTest("[O:S06] immutable output byte changes invalidate replay and advancement", async () => {
  const captured: ProducerCapture = { executeCount: 0, publishCount: 0 };
  const harness = createCoreFixture({
    route: "ordinary",
    workflowProfiles: [TOOL_PROFILE],
    stageProducerTools: [reliableToolDefinition(captured)],
  });
  try {
    const { runId, handoff } = await setupOrdinary(harness, TOOL_PROFILE);
    const tool = requireTool(harness, "reliable_stage_tool");
    const accepted = details((await tool.execute("byte-identity-first", {}, undefined, undefined, harness.context)).details);
    const receipt = assertOwnReceipt(accepted, "tool");
    assert.ok(Array.isArray(receipt.outputs));
    const output = details(receipt.outputs.find((entry) => details(entry).artifact_id === "tool_output"));
    assert.equal(typeof output.immutable_ref, "string");
    const immutablePath = join(runTarget(harness.root, runId).artifactsDir!, output.immutable_ref as string);
    const original = readFileSync(immutablePath, "utf8");
    writeFileSync(immutablePath, `${original} `);
    assert.deepEqual(JSON.parse(readFileSync(immutablePath, "utf8")), JSON.parse(original));
    const before = readRunState(harness.root, runId);
    assert.ok(before);
    const replay = details((await tool.execute("byte-identity-replay", {}, undefined, undefined, harness.context)).details);
    assert.equal(replay.ok, false, "semantic JSON equality cannot authorize modified immutable bytes");
    const advance = details((await requireTool(harness, "workflow_advance").execute(
      "byte-identity-advance",
      {
        token: handoff.advance_token,
        capability_id: handoff.capability_id,
        run_key: handoff.run_key,
        branch: handoff.branch,
        workflow: handoff.workflow,
        profile_hash: handoff.profile_hash,
        stage_cursor: handoff.stage_cursor,
        cursor_epoch: handoff.cursor_epoch,
        loop_iteration: handoff.loop_iteration,
        evidence: "accepted registered tool result",
      },
      undefined,
      undefined,
      harness.context,
    )).details);
    assert.equal(advance.ok, false, "a stage cannot advance from modified immutable output bytes");
    const after = readRunState(harness.root, runId);
    assert.ok(after);
    assert.deepEqual(after.stage_receipts, before.stage_receipts);
    assert.equal(after.stage_cursor, before.stage_cursor);
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:S06] immutable output byte changes invalidate native replay and advancement", async () => {
  const captured: ProducerCapture = { executeCount: 0, publishCount: 0 };
  const harness = ctoHarness({
    workflowProfiles: [NATIVE_TOOL_PROFILE],
    stageProducerTools: [reliableToolDefinition(captured, "tool_output", "C")],
  });
  try {
    const { runId } = await ctoIngress(harness, {
      profile: NATIVE_TOOL_PROFILE.name,
      classification: CTO_CLASSIFICATION,
    });
    const lead = await admitCtoLead(harness, runId, "byte-integrity");
    const tool = requireTool(harness, "reliable_stage_tool");
    const accepted = details((await tool.execute("native-byte-first", {}, undefined, undefined, lead.childContext)).details);
    const receipt = assertOwnReceipt(accepted, "tool");
    assert.ok(Array.isArray(receipt.outputs));
    const output = details(receipt.outputs.find((entry) => details(entry).artifact_id === "tool_output"));
    assert.equal(typeof output.immutable_ref, "string");
    const immutablePath = join(nativeArtifactsRoot(harness, runId), output.immutable_ref as string);
    const original = readFileSync(immutablePath, "utf8");
    writeFileSync(immutablePath, `${original} `);
    assert.deepEqual(JSON.parse(readFileSync(immutablePath, "utf8")), JSON.parse(original));
    const before = nativeSnapshot(harness, runId);
    const replay = details((await tool.execute("native-byte-replay", {}, undefined, undefined, lead.childContext)).details);
    assert.equal(replay.ok, false, "semantic JSON equality cannot authorize modified immutable bytes");
    const advanced = await advanceCtoStage(harness, "slice-a", "native-byte-advance");
    assert.equal(advanced.ok, false, "a native stage cannot advance from modified immutable output bytes");
    assert.equal(nativeSnapshot(harness, runId), before);
  } finally {
    await harness.close();
  }
});

scenarioTest("[C:S10] accepted worker output cannot advance before authoritative worker terminal", async () => {
  const profile: Profile = {
    ...NATIVE_WORKER_PROFILE,
    stages: [{
      id: "implementation",
      title: "Worker terminal boundary",
      type: "single",
      role: "dev",
      produces: "implementation",
    }],
  };
  const harness = ctoHarness({ workflowProfiles: [profile] });
  try {
    const { runId } = await ctoIngress(harness);
    const lead = await admitCtoLead(harness, runId, "terminal-boundary");
    const worker = await admitCtoWorker(harness, runId, lead, "terminal-boundary-worker");
    assertOwnReceipt(await submit(harness, worker.childContext, "terminal-boundary-result", {
      implementation: implementationOutput(),
    }), "worker");
    const before = nativeSnapshot(harness, runId);
    const premature = await advanceCtoStage(harness, "slice-a", "terminal-boundary-premature");
    assert.equal(premature.ok, false, "acceptance is not proof that the producer has stopped writing");
    assert.equal(nativeSnapshot(harness, runId), before);
    await terminalWorker(harness, worker);
    const completed = await advanceCtoStage(harness, "slice-a", "terminal-boundary-complete");
    assert.equal(completed.ok, true, JSON.stringify(completed));
  } finally {
    await harness.close();
  }
});
