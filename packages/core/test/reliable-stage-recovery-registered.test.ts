import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  BRANCH,
  RELIABLE_PROFILE,
  admitCtoLead,
  admitCtoLeadAndWorker,
  admitCtoWorker,
  admitOrdinaryWorker,
  cleanupHarness,
  ctoHarness,
  ctoIngress,
  ctoSliceMarker,
  details,
  emit,
  implementationOutput,
  ordinaryHarness,
  ordinaryIngress,
  requireTool,
  submission,
  terminalWorker,
  type CapturedHostMessage,
  type CtoTeamFixture,
  type Harness,
  type Handoff,
  type ToolDetails,
  type WorkerFixture,
} from "./reliable-stage-execution-fixture.js";
import { scenarioTest, recordScenarioEvent } from "./reliable-stage-trace.js";
import {
  createNativeStageRecoveryStore,
  createOrdinaryStageRecoveryStore,
  recoveryErrorDigest,
  type NativeStageRecoveryStore,
  type OrdinaryStageRecoveryStore,
} from "../src/index.js";
import type {
  RecoveryEvidenceProof,
  RecoveryHostInput,
  RecoveryObservationEvidence,
  StageRecoveryHost,
} from "../src/engine/stage-recovery.js";
import { ctoStatePath, readCtoState } from "../src/cto/state.js";
import { readRunControl, readRunState, runTarget } from "../src/engine/run-store.js";
import type { WorkIdentity } from "../src/engine/types.js";

/**
 * This suite intentionally enters recovery through the registered
 * workflow_recover tool.  The only host fakes below are adapter callbacks at
 * the host boundary; they never write canonical state, receipts, or worker
 * lifecycle records.
 */
type Route = "ordinary" | "cto";
type RecoveryStore = OrdinaryStageRecoveryStore | NativeStageRecoveryStore;
type RecoverySetup = {
  route: Route;
  harness: Harness;
  runId: string;
  handoff?: Handoff;
};
type RecoveryRecord = Record<string, unknown>;
type RecoveryResponse = {
  ok: boolean;
  recovery?: RecoveryRecord;
  capabilities?: RecoveryRecord;
  [key: string]: unknown;
};

const RECOVERY_MESSAGE = "omp-workflow-stage-recovery";
const NATIVE_WORKER_PROFILE = {
  ...RELIABLE_PROFILE,
  name: "lightweight",
  title: "Registered native worker-first recovery profile",
};
const NATIVE_LEAD_PROFILE = {
  ...NATIVE_WORKER_PROFILE,
  stages: [
    {
      ...NATIVE_WORKER_PROFILE.stages[0]!,
      id: "lead-discovery",
      title: "Native lead discovery",
      type: "orchestrator" as const,
      role: "lead",
      produces: "lead_discovery",
    },
    ...NATIVE_WORKER_PROFILE.stages.slice(1),
  ],
};
const RECOVERY_KIND = "stage_recovery_continuation";
let recoveryCallSequence = 0;

function asRecord(value: unknown, label: string): RecoveryRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as RecoveryRecord;
}

function responseDetails(value: unknown): RecoveryResponse {
  return asRecord(value, "workflow_recover details") as RecoveryResponse;
}

function safeRecoveryDetails(value: RecoveryRecord | RecoveryResponse): string {
  const errorContext = value.error_context;
  const errorCode = errorContext && typeof errorContext === "object" && !Array.isArray(errorContext)
    ? (errorContext as Record<string, unknown>).code
    : undefined;
  return JSON.stringify({
    code: value.code,
    worker: value.worker,
    action: value.action,
    blocking_condition: value.blocking_condition,
    next_action: value.next_action,
    attempts_remaining: value.attempts_remaining,
    ...(typeof errorCode === "string" ? { error_context: { code: errorCode } } : {}),
  });
}

function recoveryOf(response: RecoveryResponse): RecoveryRecord {
  assert.equal(response.ok, true, safeRecoveryDetails(response));
  return asRecord(response.recovery, "workflow_recover recovery");
}

function dispatchIdOf(value: RecoveryRecord): string {
  const identityValue = value.identity ?? (value.evidence && asRecord(value.evidence, "recovery evidence").identity);
  const identity = asRecord(identityValue, "identity");
  assert.equal(typeof identity.dispatch_id, "string");
  return identity.dispatch_id as string;
}
function admissionBlocked(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).block === true);
}

function setHostAnswer(harness: Harness, answer: string): void {
  const ui = asRecord(harness.context.ui, "host ui") as { select?: (...args: unknown[]) => Promise<string> | string };
  ui.select = async () => answer;
}

function recoveryMessage(entry: CapturedHostMessage): RecoveryRecord {
  const message = asRecord(entry.message, "host message");
  assert.equal(message.customType, RECOVERY_MESSAGE);
  const detailsValue = asRecord(message.details, "recovery host message details");
  assert.equal(detailsValue.version, 1);
  assert.equal(detailsValue.kind, RECOVERY_KIND);
  assert.equal(entry.options?.deliverAs, "followUp");
  assert.equal(entry.options?.triggerTurn, true);
  return detailsValue;
}

function recoveryMessages(harness: Harness): RecoveryRecord[] {
  return harness.messages
    .filter((entry) => {
      const message = entry.message;
      return Boolean(message && typeof message === "object" && (message as { customType?: unknown }).customType === RECOVERY_MESSAGE);
    })
    .map(recoveryMessage);
}
type SetupOptions = {
  root?: string;
  stageRecoveryHost?: StageRecoveryHost;
  workflowProfiles?: Array<typeof RELIABLE_PROFILE>;
  ctoProfile?: string;
  classification?: Record<string, unknown>;
  sessionId?: string;
  ctoTeams?: CtoTeamFixture[];
};
 
async function setup(route: Route, options: SetupOptions = {}): Promise<RecoverySetup> {
  const ctoProfile = options.ctoProfile ?? NATIVE_WORKER_PROFILE.name;
  const harness = route === "ordinary"
    ? ordinaryHarness(options)
    : ctoHarness({ ...options, workflowProfiles: options.workflowProfiles ?? [NATIVE_WORKER_PROFILE] });
  if (route === "ordinary") {
    const ingress = await ordinaryIngress(harness);
    return { route, harness, runId: ingress.runId, handoff: ingress.handoff };
  }
  const ingress = await ctoIngress(harness, {
    profile: ctoProfile,
    classification: options.classification ?? {
      type: "FEATURE",
      complexity: "QUICK",
      confidence: "HIGH",
      autonomous: false,
      workflow: ctoProfile,
    },
  });
  return { route, harness, runId: ingress.runId };
}


function createR14Root(route: Route): string {
  const root = mkdtempSync(join(tmpdir(), `omp-reliable-r14-${route}-`));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", BRANCH], { stdio: "ignore" });
  return root;
}

async function restartR14Setup(route: Route, root: string, runId: string): Promise<RecoverySetup> {
  const sessionId = `r14-${route}-restart`;
  const harness = route === "ordinary"
    ? ordinaryHarness({ root, sessionId })
    : ctoHarness({ root, sessionId, workflowProfiles: [NATIVE_WORKER_PROFILE] });
  await emit(harness, "session_start", {
    type: "session_start",
    session_id: harness.context.session_id,
    session_file: harness.context.sessionFile,
  }, harness.context);
  if (route === "ordinary") {
    const prepared = details((await requireTool(harness, "workflow_prepare").execute(
      "r14-restart-prepare",
      { mode: "resume", run_id: runId },
      undefined,
      undefined,
      harness.context,
    )).details);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const begun = details((await requireTool(harness, "workflow_begin").execute(
      "r14-restart-begin",
      {},
      undefined,
      undefined,
      harness.context,
    )).details);
    assert.equal(begun.ok, true, JSON.stringify(begun));
    return { route, harness, runId, handoff: asRecord(begun.handoff, "restarted ordinary handoff") as unknown as Handoff };
  }
  const command = harness.commands.get("cto");
  assert.ok(command, "registered CTO restart command is required");
  await command.handler(`--run ${runId} restart reliable stage`, harness.context);
  assert.equal(readRunControl(root).execution_claim?.run_id, runId, "fresh native host must reacquire the exact prior run");
  return { route, harness, runId };
}

async function withSetup(
  route: Route,
  fn: (setup: RecoverySetup) => Promise<void>,
  options: SetupOptions = {},
): Promise<void> {
  const current = await setup(route, options);
  try {
    await fn(current);
  } finally {
    await cleanupHarness(current.harness);
  }
}

async function admit(setupValue: RecoverySetup, suffix: string): Promise<WorkerFixture> {
  if (setupValue.route === "ordinary") {
    assert.ok(setupValue.handoff, "ordinary setup must retain its registered handoff");
    return admitOrdinaryWorker(setupValue.harness, setupValue.handoff, suffix);
  }
  return admitCtoLeadAndWorker(setupValue.harness, setupValue.runId, suffix);
}

async function submitValid(harness: Harness, worker: WorkerFixture, callId: string): Promise<ToolDetails> {
  const submitted = await requireTool(harness, "workflow_submit_result").execute(
    callId,
    submission({
      implementation: implementationOutput({
        ready: true,
        validation_run: true,
        validation_evidence: "registered acceptance validation output",
      }),
    }),
    undefined,
    undefined,
    worker.childContext,
  );
  return details(submitted.details);
}
function ordinaryHandoffArgs(handoff: Handoff): Record<string, unknown> {
  assert.equal(typeof handoff.branch, "string");
  assert.equal(typeof handoff.workflow, "string");
  assert.equal(typeof handoff.profile_hash, "string");
  return {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: handoff.branch,
    workflow: handoff.workflow,
    profile_hash: handoff.profile_hash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    loop_iteration: handoff.loop_iteration,
  };
}

async function advanceOrdinaryStage(harness: Harness, handoff: Handoff, suffix: string): Promise<Handoff> {
  const ask = await requireTool(harness, "workflow_checkpoint_ask").execute(
    `${suffix}-ask`,
    {
      ...ordinaryHandoffArgs(handoff),
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
    },
    undefined,
    undefined,
    harness.context,
  );
  const askDetails = details(ask.details);
  assert.equal(askDetails.ok, true, JSON.stringify(askDetails));
  const actorProvenance = askDetails.actor_provenance;
  assert.ok(actorProvenance && typeof actorProvenance === "object", JSON.stringify(askDetails));
  const recorded = await requireTool(harness, "workflow_checkpoint").execute(
    `${suffix}-record`,
    {
      ...ordinaryHandoffArgs(handoff),
      checkpoint: "approve_implementation",
      checkpoint_id: "approve_implementation",
      checkpoint_kind: "implementation_approval",
      authorization: "human",
      actor_provenance: actorProvenance,
      decision: askDetails.decision,
      rationale: "registered stale-handoff continuation",
    },
    undefined,
    undefined,
    harness.context,
  );
  const recordedDetails = details(recorded.details);
  assert.equal(recordedDetails.ok, true, JSON.stringify(recordedDetails));
  const advanced = await requireTool(harness, "workflow_advance").execute(
    `${suffix}-advance`,
    {
      ...ordinaryHandoffArgs(handoff),
      evidence: "accepted worker terminal",
    },
    undefined,
    undefined,
    harness.context,
  );
  const advancedDetails = details(advanced.details);
  assert.equal(advancedDetails.ok, true, JSON.stringify(advancedDetails));
  return asRecord(advancedDetails.handoff, "ordinary next-stage handoff") as unknown as Handoff;
}


async function recover(
  setupValue: RecoverySetup,
  operation: string,
  intent?: string,
): Promise<RecoveryRecord> {
  const params = intent === undefined ? { operation } : { operation, intent };
  const callId = `registered-recovery-${setupValue.route}-${++recoveryCallSequence}-${setupValue.runId}`;
  const result = responseDetails((await requireTool(setupValue.harness, "workflow_recover").execute(
    callId,
    params,
    undefined,
    undefined,
    setupValue.harness.context,
  )).details);
  const recovery = recoveryOf(result);
  recordScenarioEvent({
    kind: operation === "diagnose" ? "recovery_diagnosed" : "recovery_reconciled",
    route: setupValue.route === "ordinary" ? "O" : "C",
    tool: "workflow_recover",
    identities: { run: setupValue.runId },
    verdict: "PASS",
  });
  return recovery;
}

async function storeFor(setupValue: RecoverySetup): Promise<RecoveryStore> {
  if (setupValue.route === "ordinary") {
    return createOrdinaryStageRecoveryStore(setupValue.harness.root, {
      context: setupValue.harness.context,
      runId: setupValue.runId,
    });
  }
  const claim = setupValue.harness.controller.activeCtoClaim();
  assert.ok(claim, "native recovery requires the active CTO claim");
  return createNativeStageRecoveryStore(setupValue.harness.root, {
    context: setupValue.harness.context,
    runId: setupValue.runId,
    claim_scope: claim,
  });
}

async function snapshotFor(setupValue: RecoverySetup): Promise<RecoveryRecord> {
  const store = await storeFor(setupValue);
  const selection = store.selection();
  return asRecord(await store.read({
    run_id: setupValue.runId,
    authority: setupValue.route,
    selection,
  }), "recovery snapshot");
}

function identityFromSnapshot(snapshot: RecoveryRecord): WorkIdentity {
  return asRecord(snapshot.identity, "snapshot identity") as unknown as WorkIdentity;
}

function dispatchCount(setupValue: RecoverySetup): number {
  if (setupValue.route === "ordinary") {
    return readRunState(setupValue.harness.root, setupValue.runId)?.dispatch_capability?.dispatches.length ?? 0;
  }
  const state = readCtoState(setupValue.runId, setupValue.harness.root);
  if (!state) return 0;
  return Object.values(state.native_stage_progress ?? {}).reduce((count, progress) => count + Object.keys(progress.assignments).length, 0);
}


function hostProof(input: RecoveryHostInput, eventId: string): RecoveryEvidenceProof {
  return {
    authenticated: true,
    source: "registered-test-host",
    event_id: eventId,
    binding_id: input.snapshot.binding_id ?? input.snapshot.ownership?.binding_id ?? "",
    observed_at: "2026-09-30T00:00:03.000Z",
    state_revision: input.snapshot.revision,
  };
}

function hostCommon(input: RecoveryHostInput, operation: "observe" | "reconnect" | "resume" | "clarify" | "cancel_ack" | "format_repair") {
  return {
    authoritative: true as const,
    run_id: input.request.run_id,
    dispatch_id: input.identity.dispatch_id,
    identity: input.identity,
    operation,
    proof: hostProof(input, `test-${operation}:${input.operation_id}`),
  };
}

function resumeHost(): StageRecoveryHost {
  return {
    capabilities: {
      trusted_lineage: "supported",
      terminal_lifecycle: "supported",
      resume: "supported",
      replacement_dispatch: "unsupported",
      operation_replay: "unsupported",
    },
    resume: async (input) => ({
      ...hostCommon(input, "resume"),
      kind: "resume" as const,
      result: "running" as const,
      observed_at: "2026-09-30T00:00:03.000Z",
    }),
  };
}
function formatRepairHost(
  submitCorrected: () => Promise<ToolDetails>,
  observeReceipt: (receipt: RecoveryRecord, errors: readonly unknown[]) => void,
): StageRecoveryHost {
  return {
    capabilities: {
      trusted_lineage: "supported",
      terminal_lifecycle: "supported",
      format_repair: "supported",
      replacement_dispatch: "unsupported",
      operation_replay: "unsupported",
    },
    formatRepair: async (input) => {
      const corrected = await submitCorrected();
      assert.equal(corrected.ok, true, JSON.stringify(corrected));
      const receipt = asRecord(corrected.receipt, "registered corrected receipt");
      assert.equal(typeof receipt.receipt_id, "string");
      const binding = asRecord(receipt.binding, "registered corrected receipt binding");
      const receiptIdentity = asRecord(binding.identity, "registered corrected receipt identity");
      assert.equal(receiptIdentity.dispatch_id, input.identity.dispatch_id);
      const errors = input.exact_format_errors ?? [];
      observeReceipt(receipt, errors);
      return {
        ...hostCommon(input, "format_repair"),
        kind: "format_repair" as const,
        same_producer: true as const,
        accepted: true as const,
        errors_digest: recoveryErrorDigest(errors),
        observed_at: "2026-09-30T00:00:05.000Z",
      };
    },
  };
}

function registeredLifecycleHost(state: "running" | "disconnected" | "unknown"): StageRecoveryHost {
  return {
    capabilities: {
      trusted_lineage: "supported",
      terminal_lifecycle: "supported",
      clarify: "supported",
      reconnect: state === "disconnected" ? "supported" : "unsupported",
      replacement_dispatch: "unsupported",
      operation_replay: "unsupported",
    },
    clarify: async (input) => ({
      ...hostCommon(input, "clarify"),
      kind: "clarified" as const,
      result: state,
      observed_at: "2026-09-30T00:00:03.000Z",
    }),
    ...(state === "disconnected"
      ? {
          reconnect: async (input: RecoveryHostInput): Promise<RecoveryObservationEvidence> => ({
            ...hostCommon(input, "reconnect"),
            kind: "running" as const,
            same_worker: true as const,
          }),
        }
      : {}),
  };
}

function clarifyCancelHost(): StageRecoveryHost {
  return {
    capabilities: {
      trusted_lineage: "supported",
      terminal_lifecycle: "supported",
      clarify: "supported",
      cancel_ack: "supported",
      replacement_dispatch: "unsupported",
      operation_replay: "unsupported",
    },
    clarify: async (input) => ({
      ...hostCommon(input, "clarify"),
      kind: "clarified" as const,
      result: "running" as const,
      observed_at: "2026-09-30T00:00:03.000Z",
    }),
    cancelAck: async (input) => ({
      ...hostCommon(input, "cancel_ack"),
      kind: "cancel_ack" as const,
      acknowledged: true as const,
      executor_stopped: true as const,
      observed_at: "2026-09-30T00:00:04.000Z",
    }),
  };
}

async function emptyTaskBatchRemainsUnknown(setupValue: RecoverySetup): Promise<void> {
  const blocked = await emit(setupValue.harness, "tool_call", {
    toolName: "task",
    toolCallId: `reliable-${setupValue.route}-r06-empty-batch`,
    input: { tasks: [] },
  }, setupValue.harness.context);
  assert.ok(blocked.some(admissionBlocked), JSON.stringify(blocked));
  const diagnosis = await recover(setupValue, "diagnose", "observe");
  assert.equal(diagnosis.worker, "unknown");
  assert.equal(diagnosis.action, "wait");
  assert.equal(recoveryMessages(setupValue.harness).length, 0);
  recordScenarioEvent({
    kind: "fault_injected",
    route: setupValue.route === "ordinary" ? "O" : "C",
    faultPoint: "preflight",
    tool: "task",
    identities: { run: setupValue.runId },
    outcome: "UNKNOWN",
    verdict: "PENDING",
  });
}

async function malformedOrdinaryPreflight(setupValue: RecoverySetup, suffix: string): Promise<string> {
  assert.ok(setupValue.handoff, "ordinary preflight requires the current handoff");
  const roster = setupValue.handoff.expected_roster[0];
  const marker = setupValue.handoff.dispatch_markers[0];
  assert.ok(roster && marker);
  const toolCallId = `reliable-${suffix}-malformed`;
  const blocked = await emit(setupValue.harness, "tool_call", {
    toolName: "task",
    toolCallId,
    input: { tasks: [{ agent: roster.agent, task: `${marker.marker}\nmissing required top context` }] },
  }, setupValue.harness.context);
  assert.ok(blocked.some(admissionBlocked), JSON.stringify(blocked));
  recordScenarioEvent({ kind: "fault_injected", route: "O", faultPoint: "preflight", tool: "task", identities: { run: setupValue.runId, task: toolCallId }, outcome: "NOT_STARTED", verdict: "RETRY" });
  return toolCallId;
}

async function malformedCtoPreflight(setupValue: RecoverySetup, suffix: string): Promise<{ lead: WorkerFixture; toolCallId: string }> {
  const lead = await admitCtoLead(setupValue.harness, setupValue.runId, `${suffix}-lead`);
  const marker = ctoSliceMarker(setupValue.runId);
  const toolCallId = `reliable-cto-${suffix}-malformed`;
  const blocked = await emit(setupValue.harness, "tool_call", {
    toolName: "task",
    toolCallId,
    input: { tasks: [{ agent: "developer", task: `${marker}\nmissing required top context` }] },
  }, lead.childContext);
  assert.ok(blocked.some(admissionBlocked), JSON.stringify(blocked));
  recordScenarioEvent({ kind: "fault_injected", route: "C", faultPoint: "preflight", tool: "task", identities: { run: setupValue.runId, task: toolCallId }, outcome: "NOT_STARTED", verdict: "RETRY" });
  return { lead, toolCallId };
}

async function emitTransportObservation(setupValue: RecoverySetup, worker: WorkerFixture, state: "disconnected" | "unknown"): Promise<void> {
  await emit(setupValue.harness, "tool_result", {
    toolName: "task",
    toolCallId: worker.toolCallId,
    input: worker.input,
    details: state === "unknown" ? { async: { state: "unknown" } } : { results: [] },
    content: [],
    isError: false,
  }, setupValue.harness.context);
  recordScenarioEvent({ kind: "fault_observed", route: setupValue.route === "ordinary" ? "O" : "C", faultPoint: "execution", tool: "task", identities: { run: setupValue.runId, task: worker.toolCallId }, outcome: state === "unknown" ? "UNKNOWN" : "PENDING", verdict: "PENDING" });
}

async function foreignRecovery(setupValue: RecoverySetup, context: Record<string, unknown>): Promise<RecoveryResponse> {
  return responseDetails((await requireTool(setupValue.harness, "workflow_recover").execute(
    "foreign-recovery",
    { operation: "diagnose" },
    undefined,
    undefined,
    context,
  )).details);
}
type CorruptedCanonicalFile = { path: string; before: string; bytes: string };

function corruptCanonicalFile(setupValue: RecoverySetup): CorruptedCanonicalFile {
  const path = setupValue.route === "ordinary"
    ? runTarget(setupValue.harness.root, setupValue.runId).statePath
    : ctoStatePath(setupValue.runId, setupValue.harness.root);
  const before = readFileSync(path, "utf8");
  const raw = JSON.parse(before) as Record<string, unknown>;
  raw.stage_recovery = { schema_version: 999, lineages: "corrupt" };
  writeFileSync(path, JSON.stringify(raw) + "\n");
  return { path, before, bytes: readFileSync(path, "utf8") };
}
async function foreignRegisteredHost(setupValue: RecoverySetup): Promise<RecoveryResponse> {
  const harness = setupValue.route === "ordinary"
    ? ordinaryHarness({ root: setupValue.harness.root, sessionId: "r12-foreign-owner", workflowProfiles: [RELIABLE_PROFILE] })
    : ctoHarness({ root: setupValue.harness.root, sessionId: "r12-foreign-owner" });
  try {
    await emit(harness, "session_start", { type: "session_start" }, harness.context);
    return responseDetails((await requireTool(harness, "workflow_recover").execute(
      "r12-foreign-owner",
      { operation: "diagnose" },
      undefined,
      undefined,
      harness.context,
    )).details);
  } finally {
    await cleanupHarness(harness);
  }
}
async function foreignBranchRegisteredHost(setupValue: RecoverySetup): Promise<RecoveryResponse> {
  const branch = "foreign-r12-branch";
  const original = String(setupValue.harness.context.branch);
  execFileSync("git", ["-C", setupValue.harness.root, "checkout", "--quiet", "-b", branch], { stdio: "ignore" });
  const harness = setupValue.route === "ordinary"
    ? ordinaryHarness({ root: setupValue.harness.root, branch, sessionId: "r12-foreign-branch", workflowProfiles: [RELIABLE_PROFILE] })
    : ctoHarness({ root: setupValue.harness.root, branch, sessionId: "r12-foreign-branch" });
  try {
    await emit(harness, "session_start", { type: "session_start" }, harness.context);
    return responseDetails((await requireTool(harness, "workflow_recover").execute(
      "r12-foreign-branch-recover",
      { operation: "diagnose" },
      undefined,
      undefined,
      harness.context,
    )).details);
  } finally {
    await cleanupHarness(harness);
    execFileSync("git", ["-C", setupValue.harness.root, "checkout", "--quiet", "-B", original], { stdio: "ignore" });
  }
}


type R07HostMode = "default" | "supported";

async function runR07Variant(
  route: Route,
  state: "live" | "disconnected" | "unknown",
  hostMode: R07HostMode = "default",
): Promise<void> {
  const options = hostMode === "supported"
    ? { stageRecoveryHost: registeredLifecycleHost(state === "live" ? "running" : state) }
    : {};
  await withSetup(route, async (setupValue) => {
    const worker = await admit(setupValue, `r07-${state}-${hostMode}`);
    const before = await snapshotFor(setupValue);
    const beforeIdentity = identityFromSnapshot(before);
    const beforeDispatchCount = dispatchCount(setupValue);
    if (state !== "live") await emitTransportObservation(setupValue, worker, state);
    let result: RecoveryRecord;
    if (hostMode === "supported") {
      const clarified = await recover(setupValue, "reconcile", "clarify");
      assert.equal(clarified.worker, state === "live" ? "running" : state);
      result = state === "disconnected"
        ? await recover(setupValue, "reconcile", "reconnect")
        : await recover(setupValue, "diagnose", "observe");
    } else {
      result = state === "disconnected"
        ? await recover(setupValue, "reconcile", "reconnect")
        : await recover(setupValue, "diagnose", "observe");
    }
    assert.equal(recoveryMessages(setupValue.harness).length, 0, "neutral transport states must not queue a replacement");
    assert.equal(dispatchCount(setupValue), beforeDispatchCount);
    if (state === "live") {
      if (route === "ordinary") {
        assert.equal(result.code, "worker_running", safeRecoveryDetails(result));
        assert.equal(result.worker, "running");
      } else {
        assert.equal(result.worker, "unknown");
        assert.equal(result.action, "wait");
      }
    }
    if (state === "disconnected") {
      if (hostMode === "supported") {
        assert.equal(result.code, "worker_reconnected", safeRecoveryDetails(result));
        assert.equal(result.worker, "running");
        const evidence = asRecord(result.evidence, "reconnect host evidence");
        assert.equal(evidence.kind, "running");
        assert.equal(evidence.operation, "reconnect");
        assert.equal(asRecord(evidence.proof, "reconnect proof").source, "registered-test-host");
      } else if (route === "ordinary") {
        assert.equal(result.code, "worker_disconnected", safeRecoveryDetails(result));
        assert.equal(result.worker, "disconnected");
      } else {
        assert.equal(result.worker, "unknown");
        assert.equal(result.action, "wait");
      }
    }
    if (state === "unknown") {
      assert.equal(result.worker, "unknown");
      assert.equal(result.action, "wait");
    }
    const after = await snapshotFor(setupValue);
    assert.equal(identityFromSnapshot(after).dispatch_id, beforeIdentity.dispatch_id);
  }, options);
}
 
scenarioTest("[O:R06] registered ordinary preflight refusal records one linked retry and one corrected worker", async () => {
  await withSetup("ordinary", emptyTaskBatchRemainsUnknown);
  await withSetup("ordinary", async (setupValue) => {
    const ui = asRecord(setupValue.harness.context.ui, "R06 host ui") as { select?: (...args: unknown[]) => Promise<string> | string };
    let recoveryPrompts = 0;
    ui.select = async () => {
      recoveryPrompts += 1;
      return "proceed";
    };
    assert.ok(setupValue.handoff);
    const refusedToolCall = await malformedOrdinaryPreflight(setupValue, "o-r06");
    const beforeCorrectionDispatches = dispatchCount(setupValue);
    const refused = await snapshotFor(setupValue);
    const refusedDispatch = identityFromSnapshot(refused).dispatch_id;
    const automaticMessage = recoveryMessage(await setupValue.harness.waitForRecoveryMessage());
    assert.equal(automaticMessage.authority, "ordinary");
    assert.equal(automaticMessage.retry_of, refusedDispatch);
    const diagnosis = await recover(setupValue, "diagnose");
    assert.equal(diagnosis.worker, "unknown", safeRecoveryDetails(diagnosis));
    assert.equal(diagnosis.retry_of, refusedDispatch);
    const reconciled = await recover(setupValue, "reconcile", "retry");
    assert.equal(reconciled.code, "replacement_dispatched", safeRecoveryDetails(reconciled));
    const message = automaticMessage;
    assert.equal(message.run_id, setupValue.runId);
    assert.equal(message.authority, "ordinary");
    assert.equal(message.retry_of, refusedDispatch);
    const followUpIdentity = asRecord(message.identity, "ordinary recovery follow-up identity");
    assert.equal(typeof followUpIdentity.dispatch_id, "string");
    recordScenarioEvent({ kind: "barrier_wait", route: "O", barrier: "ordinary-recovery-continuation", identities: { run: setupValue.runId, dispatch: refusedDispatch, task: refusedToolCall } });
    const worker = await admitOrdinaryWorker(setupValue.harness, setupValue.handoff, "o-r06-corrected");
    const replacement = identityFromSnapshot(await snapshotFor(setupValue));
    assert.equal(replacement.dispatch_id, followUpIdentity.dispatch_id);
    assert.equal(await submitValid(setupValue.harness, worker, "o-r06-submit").then((value) => value.ok), true);
    await terminalWorker(setupValue.harness, worker);
    assert.equal(recoveryMessages(setupValue.harness).length, 1);
    assert.equal(dispatchCount(setupValue), beforeCorrectionDispatches + 1);
    assert.equal(recoveryPrompts, 0, "known not_started retry must not ask for a recovery grant");
  });
});

scenarioTest("[C:R06] registered native preflight refusal records one linked retry and one corrected lead-owned worker", async () => {
  await withSetup("cto", emptyTaskBatchRemainsUnknown);
  await withSetup("cto", async (setupValue) => {
    const ui = asRecord(setupValue.harness.context.ui, "R06 host ui") as { select?: (...args: unknown[]) => Promise<string> | string };
    let recoveryPrompts = 0;
    ui.select = async () => {
      recoveryPrompts += 1;
      return "proceed";
    };
    const malformed = await malformedCtoPreflight(setupValue, "c-r06");
    const beforeCorrectionDispatches = dispatchCount(setupValue);
    const refused = await snapshotFor(setupValue);
    const refusedDispatch = identityFromSnapshot(refused).dispatch_id;
    const automaticMessage = recoveryMessage(await setupValue.harness.waitForRecoveryMessage());
    assert.equal(automaticMessage.authority, "cto");
    assert.equal(automaticMessage.retry_of, refusedDispatch);
    const diagnosis = await recover(setupValue, "diagnose");
    assert.equal(diagnosis.worker, "unknown", safeRecoveryDetails(diagnosis));
    assert.equal(diagnosis.retry_of, refusedDispatch);
    const reconciled = await recover(setupValue, "reconcile", "retry");
    assert.equal(reconciled.code, "replacement_dispatched", safeRecoveryDetails(reconciled));
    const message = automaticMessage;
    assert.equal(message.authority, "cto");
    assert.equal(message.retry_of, refusedDispatch);
    const followUpIdentity = asRecord(message.identity, "native recovery follow-up identity");
    assert.equal(typeof followUpIdentity.dispatch_id, "string");
    recordScenarioEvent({ kind: "barrier_wait", route: "C", barrier: "native-recovery-continuation", identities: { run: setupValue.runId, dispatch: refusedDispatch, task: malformed.toolCallId } });
    const assignmentSummary = (): RecoveryRecord[] => {
      const native = readCtoState(setupValue.runId, setupValue.harness.root);
      const assignments = native?.native_stage_progress?.["team-a"]?.assignments ?? {};
      return Object.values(assignments).map((assignment) => ({
        dispatch_id: assignment.identity.dispatch_id,
        attempt: assignment.identity.attempt,
        slot_id: assignment.slot_id,
        status: assignment.status,
        task_id: assignment.identity.task_id,
        worker_id: assignment.identity.worker_id,
      }));
    };
    const permitSummary = async (): Promise<RecoveryRecord[]> => {
      const snapshot = await snapshotFor(setupValue);
      return (Array.isArray(snapshot.operations) ? snapshot.operations : [])
        .filter((operation) => asRecord(operation, "native recovery operation").action === "replace")
        .map((operation) => {
          const value = asRecord(operation, "native recovery operation");
          const admission = value.admission && typeof value.admission === "object" && !Array.isArray(value.admission)
            ? (value.admission as RecoveryRecord).state
            : undefined;
          return {
            retry_of: value.retry_of,
            status: value.status,
            admission,
            replacement_dispatch: asRecord(value.replacement_identity, "native recovery replacement").dispatch_id,
          };
        });
    };
    const beforeAssignments = assignmentSummary();
    const beforeClaimWorkers = [...(readRunControl(setupValue.harness.root).execution_claim?.worker_ids ?? [])];
    const beforePermits = await permitSummary();
    const beforeDuplicateDispatches = dispatchCount(setupValue);
    const duplicateMarker = ctoSliceMarker(setupValue.runId);
    const duplicateBatch = await emit(setupValue.harness, "tool_call", {
      toolName: "task",
      toolCallId: "reliable-cto-c-r06-duplicate-recovery-batch",
      input: {
        context: "shared context",
        tasks: [
          { agent: "developer", task: `${duplicateMarker}\nduplicate recovery slot one` },
          { agent: "developer", task: `${duplicateMarker}\nduplicate recovery slot two` },
        ],
      },
    }, malformed.lead.childContext);
    assert.ok(duplicateBatch.some(admissionBlocked), JSON.stringify(duplicateBatch));
    assert.deepEqual(assignmentSummary(), beforeAssignments, "duplicate recovery batch must not create a native assignment");
    assert.deepEqual(readRunControl(setupValue.harness.root).execution_claim?.worker_ids ?? [], beforeClaimWorkers, "duplicate recovery batch must not reserve another claim worker");
    assert.deepEqual(await permitSummary(), beforePermits, "duplicate recovery batch must not consume or duplicate a recovery permit");
    assert.equal(dispatchCount(setupValue), beforeDuplicateDispatches, "duplicate recovery batch must not start another native dispatch");
    assert.equal(recoveryMessages(setupValue.harness).length, 1);

    const worker = await admitCtoWorker(setupValue.harness, setupValue.runId, malformed.lead, "c-r06-corrected");
    const replacement = identityFromSnapshot(await snapshotFor(setupValue));
    assert.equal(replacement.dispatch_id, followUpIdentity.dispatch_id);
    const submitted = await submitValid(setupValue.harness, worker, "c-r06-submit");
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    await terminalWorker(setupValue.harness, worker);
    assert.equal(recoveryMessages(setupValue.harness).length, 1);
    assert.equal(dispatchCount(setupValue), beforeCorrectionDispatches + 1);
    assert.equal(recoveryPrompts, 0, "known not_started retry must not ask for a recovery grant");
  });
});

scenarioTest("[O:R07] ordinary live disconnected and unknown workers remain one writer", async () => {
  await runR07Variant("ordinary", "live");
  await runR07Variant("ordinary", "disconnected");
  await runR07Variant("ordinary", "unknown");
  await runR07Variant("ordinary", "disconnected", "supported");
});

scenarioTest("[C:R07] native live disconnected and unknown workers remain one writer", async () => {
  await runR07Variant("cto", "live");
  await runR07Variant("cto", "disconnected");
  await runR07Variant("cto", "unknown");
  await runR07Variant("cto", "disconnected", "supported");
});

async function runR08(route: Route): Promise<void> {
  await withSetup(route, async (setupValue) => {
    const ui = asRecord(setupValue.harness.context.ui, "R08 host ui") as { select?: (...args: unknown[]) => Promise<string> | string };
    let recoveryPrompts = 0;
    ui.select = async () => {
      recoveryPrompts += 1;
      return "proceed";
    };
    const worker = await admit(setupValue, "r08-unsupported");
    const failedIdentity = identityFromSnapshot(await snapshotFor(setupValue));
    await terminalWorker(setupValue.harness, worker, true);
    const replacement = await recover(setupValue, "reconcile", "replace");
    assert.equal(replacement.code, "replacement_dispatched", safeRecoveryDetails(replacement));
    assert.equal(replacement.retry_of, failedIdentity.dispatch_id);
    const message = recoveryMessage(await setupValue.harness.waitForRecoveryMessage());
    assert.equal(message.retry_of, failedIdentity.dispatch_id);
    const followUpIdentity = asRecord(message.identity, "replacement follow-up identity");
    const correctedWorker = await admit(setupValue, "r08-replacement");
    const canonicalReplacement = identityFromSnapshot(await snapshotFor(setupValue));
    assert.equal(canonicalReplacement.dispatch_id, followUpIdentity.dispatch_id);
    await terminalWorker(setupValue.harness, correctedWorker);
    assert.equal(recoveryPrompts, 0, "initial terminal retry must not ask for a recovery grant");
  });
  await withSetup(route, async (setupValue) => {
    const worker = await admit(setupValue, "r08-supported");
    const beforeIdentity = identityFromSnapshot(await snapshotFor(setupValue));
    await terminalWorker(setupValue.harness, worker, true);
    const available = await recover(setupValue, "diagnose", "resume");
    assert.equal(available.code, "resume_available", safeRecoveryDetails(available));
    assert.equal(available.retry_of, beforeIdentity.dispatch_id);
    const resumed = await recover(setupValue, "reconcile", "resume");
    assert.equal(resumed.code, "worker_resumed", safeRecoveryDetails(resumed));
    assert.equal(resumed.action, "resume");
    assert.equal(resumed.worker, "running");
    assert.equal(recoveryMessages(setupValue.harness).length, 0);
    assert.equal(dispatchIdOf(resumed), beforeIdentity.dispatch_id);
  }, { stageRecoveryHost: resumeHost() });
}

scenarioTest("[O:R08] ordinary confirmed failure uses supported resume and bounded unsupported replacement", async () => {
  await runR08("ordinary");
});

scenarioTest("[C:R08] native confirmed failure uses supported resume and bounded unsupported replacement", async () => {
  await runR08("cto");
});

async function runR09(route: Route): Promise<void> {
  await withSetup(route, async (setupValue) => {
    const worker = await admit(setupValue, "r09");
    const before = await snapshotFor(setupValue);
    await emitTransportObservation(setupValue, worker, "unknown");
    await emit(setupValue.harness, "session_start", { type: "session_start" }, setupValue.harness.context);
    const unknown = await recover(setupValue, "diagnose", "observe");
    assert.equal(unknown.worker, "unknown");
    assert.equal(unknown.action, "wait");
    assert.equal(recoveryMessages(setupValue.harness).length, 0);
    const after = await snapshotFor(setupValue);
    assert.equal(identityFromSnapshot(after).dispatch_id, identityFromSnapshot(before).dispatch_id);
    assert.equal(after.lifecycle, setupValue.route === "ordinary" ? "unknown" : "pending");
  });
}

scenarioTest("[O:R09] ordinary unknown transport after host restart remains unknown without replacement", async () => {
  await runR09("ordinary");
});

scenarioTest("[C:R09] native unknown transport after host restart remains pending without replacement", async () => {
  await runR09("cto");
});

async function runR10(route: Route): Promise<void> {
  await withSetup(route, async (setupValue) => {
    await admit(setupValue, "r10-unsupported");
    const unsupportedSnapshot = await snapshotFor(setupValue);
    const expectedWorker = unsupportedSnapshot.lifecycle === "running" ? "running" : "unknown";
    const clarify = await recover(setupValue, "reconcile", "clarify");
    assert.equal(clarify.code, "clarify_unsupported", safeRecoveryDetails(clarify));
    assert.equal(clarify.worker, expectedWorker, safeRecoveryDetails(clarify));
    assert.equal(recoveryMessages(setupValue.harness).length, 0);
    const cancel = await recover(setupValue, "reconcile", "cancel_ack");
    assert.equal(cancel.code, "cancel_ack_unsupported", safeRecoveryDetails(cancel));
    assert.equal(cancel.worker, expectedWorker, safeRecoveryDetails(cancel));
  });
  await withSetup(route, async (setupValue) => {
    await admit(setupValue, "r10-supported");
    const clarified = await recover(setupValue, "reconcile", "clarify");
    assert.equal(clarified.code, "clarified_running");
    assert.equal(clarified.worker, "running");
    const cancelled = await recover(setupValue, "reconcile", "cancel_ack");
    assert.equal(cancelled.code, "cancel_acknowledged");
    assert.equal(cancelled.action, "cancel_ack");
    assert.equal(cancelled.worker, "terminal");
    assert.equal(recoveryMessages(setupValue.harness).length, 0);
  }, { stageRecoveryHost: clarifyCancelHost() });
}

scenarioTest("[O:R10] ordinary clarification and cancellation truthfully report unsupported or acknowledged capabilities", async () => {
  await runR10("ordinary");
});

scenarioTest("[C:R10] native clarification and cancellation truthfully report unsupported or acknowledged capabilities", async () => {
  await runR10("cto");
});

async function runR11(route: Route): Promise<void> {
  if (route === "ordinary") {
    await withSetup("ordinary", async (setupValue) => {
      assert.ok(setupValue.handoff);
      const firstHandoff = setupValue.handoff;
      const beforeSnapshot = await snapshotFor(setupValue);
      const beforeCanonical = readRunState(setupValue.harness.root, setupValue.runId);
      assert.ok(beforeCanonical);
      assert.equal(beforeCanonical.stage_cursor, firstHandoff.stage_cursor);
      const beforeRevision = String(beforeSnapshot.revision);
      const worker = await admitOrdinaryWorker(setupValue.harness, firstHandoff, "r11-first");
      assert.equal((await submitValid(setupValue.harness, worker, "r11-first-submit")).ok, true);
      await terminalWorker(setupValue.harness, worker);
      const advancedHandoff = await advanceOrdinaryStage(setupValue.harness, firstHandoff, "r11-ordinary");
      const afterAdvance = readRunState(setupValue.harness.root, setupValue.runId);
      assert.ok(afterAdvance);
      const afterAdvanceSnapshot = await snapshotFor(setupValue);
      assert.notEqual(String(afterAdvanceSnapshot.revision), beforeRevision);
      assert.equal(advancedHandoff.stage_cursor, "next");
      assert.equal(afterAdvance.stage_cursor, "next");
      assert.ok(Number(afterAdvance.state_revision ?? 0) > Number(beforeCanonical.state_revision ?? 0));
      const beforeRefreshDispatches = dispatchCount(setupValue);
      const refreshed = await recover(setupValue, "diagnose", "refresh_handoff");
      if (refreshed.code === "handoff_refreshed") {
        assert.equal(refreshed.action, "refresh_handoff");
        const refreshedSnapshot = await snapshotFor(setupValue);
        assert.equal(String(refreshed.state_revision), String(refreshedSnapshot.revision));
        const refreshedCanonical = readRunState(setupValue.harness.root, setupValue.runId);
        assert.ok(refreshedCanonical);
        assert.equal(refreshedCanonical.stage_cursor, afterAdvance.stage_cursor);
      } else {
        assert.ok(refreshed.code === "handoff_unavailable" || refreshed.code === "begin_required", safeRecoveryDetails(refreshed));
        const current = readRunState(setupValue.harness.root, setupValue.runId);
        assert.ok(current);
        assert.equal(current.stage_cursor, afterAdvance.stage_cursor);
      }
      recordScenarioEvent({ kind: "barrier_wait", route: "O", barrier: "ordinary-current-handoff-refresh", identities: { run: setupValue.runId, dispatch: firstHandoff.stage_cursor } });
      assert.equal(dispatchCount(setupValue), beforeRefreshDispatches);
      assert.equal(recoveryMessages(setupValue.harness).length, 0);
    });
    return;
  }
  await withSetup("cto", async (setupValue) => {
    const lead = await admitCtoLead(setupValue.harness, setupValue.runId, "r11-lead");
    const worker = await admitCtoWorker(setupValue.harness, setupValue.runId, lead, "r11-worker");
    const stateBefore = readCtoState(setupValue.runId, setupValue.harness.root);
    assert.ok(stateBefore);
    const progressBefore = stateBefore.native_stage_progress?.["team-a"];
    assert.ok(progressBefore);
    assert.equal(progressBefore.stage_id, "implementation");
    assert.equal((await submitValid(setupValue.harness, worker, "r11-worker-submit")).ok, true);
    await terminalWorker(setupValue.harness, worker);
    const rootCheckpoint = await requireTool(setupValue.harness, "cto_checkpoint_ask").execute(
      "r11-native-root-checkpoint",
      { slice_id: "slice-a" },
      undefined,
      undefined,
      setupValue.harness.context,
    );
    assert.equal(details(rootCheckpoint.details).ok, true, JSON.stringify(rootCheckpoint.details));
    const rootAdvance = await requireTool(setupValue.harness, "cto_stage_advance").execute(
      "r11-native-root-advance",
      { slice_id: "slice-a" },
      undefined,
      undefined,
      setupValue.harness.context,
    );
    assert.equal(details(rootAdvance.details).ok, true, JSON.stringify(rootAdvance.details));
    const stateAfterAdvance = readCtoState(setupValue.runId, setupValue.harness.root);
    assert.ok(stateAfterAdvance);
    const progressAfterAdvance = stateAfterAdvance.native_stage_progress?.["team-a"];
    assert.ok(progressAfterAdvance);
    assert.equal(progressAfterAdvance.stage_id, "next");
    assert.ok(progressAfterAdvance.revision > progressBefore.revision);
    const beforeRefreshDispatches = dispatchCount(setupValue);
    const refreshed = await recover(setupValue, "diagnose", "refresh_handoff");
    if (refreshed.code === "handoff_refreshed") {
      assert.equal(refreshed.action, "refresh_handoff");
      const refreshedSnapshot = await snapshotFor(setupValue);
      assert.equal(String(refreshed.state_revision), String(refreshedSnapshot.revision));
      const current = readCtoState(setupValue.runId, setupValue.harness.root);
      assert.ok(current);
      assert.equal(current.native_stage_progress?.["team-a"]?.stage_id, progressAfterAdvance.stage_id);
      assert.equal(current.native_stage_progress?.["team-a"]?.revision, progressAfterAdvance.revision);
    } else {
      assert.ok(refreshed.code === "handoff_unavailable" || refreshed.code === "begin_required", safeRecoveryDetails(refreshed));
      const current = readCtoState(setupValue.runId, setupValue.harness.root);
      assert.ok(current);
      assert.equal(current.native_stage_progress?.["team-a"]?.stage_id, progressAfterAdvance.stage_id);
    }
    recordScenarioEvent({ kind: "barrier_wait", route: "C", barrier: "native-current-handoff-refresh", identities: { run: setupValue.runId, dispatch: lead.toolCallId } });
    assert.equal(dispatchCount(setupValue), beforeRefreshDispatches);
    assert.equal(recoveryMessages(setupValue.harness).length, 0);
  }, { workflowProfiles: [NATIVE_WORKER_PROFILE], ctoProfile: NATIVE_WORKER_PROFILE.name });
}
scenarioTest("[O:R11] ordinary current handoff refresh after registered advance does not redispatch implementation", async () => {
  await runR11("ordinary");
});

scenarioTest("[C:R11] native current handoff refresh after registered advance does not redispatch implementation", async () => {
  await runR11("cto");
});

async function runR12(route: Route): Promise<void> {
  await withSetup(route, async (setupValue) => {
    const assertSafeRefusal = (response: RecoveryResponse, code: RegExp, label: string): void => {
      assert.equal(response.ok, false, label);
      assert.match(String(response.code), code, label);
      const serialized = JSON.stringify(response);
      assert.doesNotMatch(serialized, /dispatch_token|advance_token|ownership_epoch|foreign-r12-branch|foreign-owner|r12-identity/i, label);
    };
    const owner = await foreignRegisteredHost(setupValue);
    assertSafeRefusal(owner, /^WORKFLOW_CONTEXT_REJECTED$/, "foreign owner must fail closed");
    const branch = await foreignBranchRegisteredHost(setupValue);
    assertSafeRefusal(branch, /^WORKFLOW_(?:CONTEXT_REJECTED|RECOVERY_STATE_UNAVAILABLE)$/, "foreign branch must fail closed");
    const identityWorker = await admit(setupValue, "r12-identity");
    const identity = await foreignRecovery(setupValue, identityWorker.childContext);
    assertSafeRefusal(identity, /^WORKFLOW_CONTEXT_REJECTED$/, "foreign assigned worker identity must fail closed");
    assert.equal(recoveryMessages(setupValue.harness).length, 0);
    const corrupted = corruptCanonicalFile(setupValue);
    const corruption = responseDetails((await requireTool(setupValue.harness, "workflow_recover").execute(
      "r12-corruption",
      { operation: "diagnose" },
      undefined,
      undefined,
      setupValue.harness.context,
    )).details);
    assert.equal(corruption.ok, false);
    assert.equal(corruption.code, "WORKFLOW_RECOVERY_STATE_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(corruption), /dispatch_token|advance_token|ownership_epoch/i);
    assert.notEqual(corrupted.bytes, corrupted.before, "fixture must alter one canonical file before recovery");
    assert.equal(readFileSync(corrupted.path, "utf8"), corrupted.bytes, "corruption refusal must not rewrite the canonical file");
    assert.equal(recoveryMessages(setupValue.harness).length, 0);
    recordScenarioEvent({ kind: "fault_observed", route: route === "ordinary" ? "O" : "C", faultPoint: "corruption", identities: { run: setupValue.runId }, verdict: "PASS" });
  });
}

scenarioTest("[O:R12] ordinary foreign owner, branch, identity, and corrupted state fail closed without mutation or disclosure", async () => {
  await runR12("ordinary");
});

scenarioTest("[C:R12] native foreign owner, branch, identity, and corrupted state fail closed without mutation or disclosure", async () => {
  await runR12("cto");
});

async function runR13(route: Route): Promise<void> {
  await withSetup(route, async (setupValue) => {
    const ui = asRecord(setupValue.harness.context.ui, "R13 host ui") as { select?: (...args: unknown[]) => Promise<string> | string };
    let recoveryPrompts = 0;
    ui.select = async () => {
      recoveryPrompts += 1;
      return "proceed";
    };
    const worker = await admit(setupValue, "r13");
    const recoveryTool = requireTool(setupValue.harness, "workflow_recover");
    let responses!: RecoveryResponse[];
    await setupValue.harness.withRecoveryDispatchBarrier(async (barrier) => {
      const terminalPromise = terminalWorker(setupValue.harness, worker, true);
      await barrier.queued;
      const started: string[] = [];
      const leftPromise = (async () => {
        started.push("left");
        return recoveryTool.execute("r13-left", { operation: "reconcile", intent: "replace" }, undefined, undefined, setupValue.harness.context);
      })();
      const rightPromise = (async () => {
        started.push("right");
        return recoveryTool.execute("r13-right", { operation: "reconcile", intent: "replace" }, undefined, undefined, setupValue.harness.context);
      })();
      assert.deepEqual(started, ["left", "right"], "both registered recovery callers start while the real host queue is held");
      barrier.release();
      await terminalPromise;
      const [left, right] = await Promise.all([leftPromise, rightPromise]);
      responses = [responseDetails(left.details), responseDetails(right.details)];
    });
    const message = recoveryMessage(await setupValue.harness.waitForRecoveryMessage());
    const recoveries = responses.flatMap((entry) => {
      if (!entry.ok) return [];
      const recovery = asRecord(entry.recovery, "concurrent recovery");
      assert.ok(recovery.action === "replace" || recovery.action === "wait", safeRecoveryDetails(recovery));
      return [recovery];
    });
    recordScenarioEvent({ kind: "recovery_reconciled", route: setupValue.route === "ordinary" ? "O" : "C", tool: "workflow_recover", identities: { run: setupValue.runId }, verdict: "PASS" });
    const responseReplacementDispatches = recoveries.flatMap((entry) => {
      const evidence = entry.evidence;
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
      const replacementIdentity = (evidence as RecoveryRecord).new_identity;
      if (!replacementIdentity || typeof replacementIdentity !== "object" || Array.isArray(replacementIdentity)) return [];
      const dispatchId = (replacementIdentity as RecoveryRecord).dispatch_id;
      return typeof dispatchId === "string" ? [dispatchId] : [];
    });
    assert.equal(recoveryMessages(setupValue.harness).length, 1, "one concurrent recovery may queue one replacement continuation");
    const messageIdentity = asRecord(message.identity, "concurrent recovery message identity");
    const snapshot = await snapshotFor(setupValue);
    const operations = Array.isArray(snapshot.operations) ? snapshot.operations as unknown[] : [];
    const replacements = operations.filter((entry) => asRecord(entry, "recovery operation").action === "replace");
    assert.equal(replacements.length, 1, "the owner CAS permits one replacement operation");
    const replacementOperation = asRecord(replacements[0], "canonical replacement operation");
    assert.equal(replacementOperation.status, "acked");
    const operationIdentity = asRecord(replacementOperation.replacement_identity, "canonical replacement identity");
    assert.equal(operationIdentity.dispatch_id, messageIdentity.dispatch_id);
    assert.ok(responseReplacementDispatches.every((dispatchId) => dispatchId === operationIdentity.dispatch_id), "any competing response evidence binds to the one canonical replacement");
    const budgets = Array.isArray(snapshot.budgets) ? snapshot.budgets : [];
    const terminalBudget = budgets.find((entry) => asRecord(entry, "recovery budget").error_class === "terminal_failure");
    assert.ok(terminalBudget);
    assert.equal(asRecord(terminalBudget, "terminal recovery budget").used, 1, "one replacement consumes one canonical terminal-failure budget charge");
    assert.equal(recoveryPrompts, 0, "concurrent initial replacement must not ask for a recovery grant");
  });
}

scenarioTest("[O:R13] ordinary concurrent recovery consumes one replacement permit", async () => {
  await runR13("ordinary");
});

scenarioTest("[C:R13] native concurrent recovery consumes one replacement permit", async () => {
  await runR13("cto");
});

async function runR14(route: Route): Promise<void> {
  const root = createR14Root(route);
  let firstHarness: Harness | undefined;
  try {
    const setupValue = await setup(route, { root, sessionId: `r14-${route}-first` });
    firstHarness = setupValue.harness;
    const firstWorker = await admit(setupValue, "r14-first");
    const firstFailed = identityFromSnapshot(await snapshotFor(setupValue));
    await terminalWorker(setupValue.harness, firstWorker, true);
    const first = await recover(setupValue, "reconcile", "replace");
    assert.equal(first.code, "replacement_dispatched", safeRecoveryDetails(first));
    const firstMessage = recoveryMessage(await setupValue.harness.waitForRecoveryMessage());
    assert.equal(firstMessage.retry_of, firstFailed.dispatch_id);
    const firstReplacement = asRecord(firstMessage.identity, "first replacement identity");
    assert.notEqual(firstReplacement.dispatch_id, firstFailed.dispatch_id);

    const secondWorker = await admit(setupValue, "r14-second");
    const secondFailed = identityFromSnapshot(await snapshotFor(setupValue));
    assert.notEqual(secondFailed.dispatch_id, firstFailed.dispatch_id);
    if (route === "cto") assert.notEqual(secondFailed.worker_id, firstFailed.worker_id);
    if (route === "cto") {
      const beforeLateMessages = recoveryMessages(setupValue.harness).length;
      const beforeLateDispatches = dispatchCount(setupValue);
      await terminalWorker(setupValue.harness, firstWorker, true);
      const afterLate = await snapshotFor(setupValue);
      assert.equal(identityFromSnapshot(afterLate).dispatch_id, secondFailed.dispatch_id);

      const native = readCtoState(setupValue.runId, setupValue.harness.root);
      assert.ok(native);
      const progress = native.native_stage_progress?.["team-a"];
      assert.ok(progress);
      const assignment = progress.assignments[secondFailed.dispatch_id];
      assert.ok(assignment);
      assert.ok(assignment.status === "reserved" || assignment.status === "running");
      const claim = readRunControl(setupValue.harness.root).execution_claim;
      assert.ok(claim);
      assert.ok(claim.worker_ids.includes(secondFailed.worker_id));
      assert.equal(recoveryMessages(setupValue.harness).length, beforeLateMessages);
      assert.equal(dispatchCount(setupValue), beforeLateDispatches);
    }
    await terminalWorker(setupValue.harness, secondWorker, true);
    const second = await recover(setupValue, "reconcile", "replace");
    assert.equal(second.code, "replacement_dispatched", safeRecoveryDetails(second));
    const messagesAfterSecond = recoveryMessages(setupValue.harness);
    assert.equal(messagesAfterSecond.length, 2);
    const secondMessage = messagesAfterSecond[1]!;
    assert.equal(secondMessage.retry_of, secondFailed.dispatch_id);
    const secondReplacement = asRecord(secondMessage.identity, "second replacement identity");
    assert.notEqual(secondReplacement.dispatch_id, secondFailed.dispatch_id);

    const thirdWorker = await admit(setupValue, "r14-third");
    const thirdFailed = identityFromSnapshot(await snapshotFor(setupValue));
    assert.notEqual(thirdFailed.dispatch_id, secondFailed.dispatch_id);
    await terminalWorker(setupValue.harness, thirdWorker, true);
    if (route === "cto") {
      for (const worker of [firstWorker, secondWorker, thirdWorker]) {
        const lead = (worker as WorkerFixture & { lead?: WorkerFixture }).lead;
        if (lead) await terminalWorker(setupValue.harness, lead);
      }
    }
    const exhausted = responseDetails((await requireTool(setupValue.harness, "workflow_recover").execute(
      "r14-exhausted",
      { operation: "reconcile", intent: "replace" },
      undefined,
      undefined,
      setupValue.harness.context,
    )).details);
    const exhaustedRecovery = exhausted.recovery && typeof exhausted.recovery === "object" && !Array.isArray(exhausted.recovery)
      ? exhausted.recovery as RecoveryRecord
      : undefined;
    const exhaustedDiagnostic = JSON.stringify({
      code: exhausted.code,
      recovery_code: exhaustedRecovery?.code,
      worker: exhaustedRecovery?.worker,
      action: exhaustedRecovery?.action,
      attempts_remaining: exhaustedRecovery?.attempts_remaining,
      current_dispatch: exhaustedRecovery?.retry_of,
    });
    assert.equal(exhausted.ok, false, exhaustedDiagnostic);
    assert.equal(exhausted.code, "WORKFLOW_RECOVERY_GRANT_REJECTED");
    assert.equal(recoveryMessages(setupValue.harness).length, 2);

    await cleanupHarness(setupValue.harness);
    firstHarness = undefined;
    const restarted = await restartR14Setup(route, root, setupValue.runId);
    try {
      setHostAnswer(restarted.harness, "authorize_one_retry");
      const continued = await recover(restarted, "reconcile", "replace");
      assert.equal(continued.code, "replacement_dispatched", safeRecoveryDetails(continued));
      assert.equal(recoveryMessages(restarted.harness).length, 1);
      const snapshot = await snapshotFor(restarted);
      const grants = Array.isArray(snapshot.grants) ? snapshot.grants : [];
      assert.equal(grants.length, 1, "one explicit post-exhaustion grant is persisted as bounded authority");
      assert.ok(grants.every((grant) => asRecord(grant, "grant").limit === 1));
    } finally {
      await cleanupHarness(restarted.harness);
    }
  } finally {
    if (firstHarness) await cleanupHarness(firstHarness);
    rmSync(root, { recursive: true, force: true });
  }

}
scenarioTest("[O:R14] ordinary exhausted recovery budget survives restart and needs one bounded UI grant", async () => {
  await runR14("ordinary");
});

scenarioTest("[C:R14] native exhausted recovery budget survives restart and needs one bounded UI grant", async () => {
  await runR14("cto");
});

async function runNativeRootBatchAtomicity(): Promise<void> {
  const teams: CtoTeamFixture[] = [
    {
      id: "team-a",
      sliceId: "slice-a",
      name: "Team A",
      lead: "team-lead-a",
      roster: ["developer-a"],
      scope: ["backend"],
      profile: NATIVE_WORKER_PROFILE.name,
    },
    {
      id: "team-b",
      sliceId: "slice-b",
      name: "Team B",
      lead: "team-lead-b",
      roster: ["developer-b"],
      scope: ["backend"],
      profile: NATIVE_WORKER_PROFILE.name,
    },
  ];
  await withSetup("cto", async (setupValue) => {
    const markerA = ctoSliceMarker(setupValue.runId, "slice-a");
    const markerB = ctoSliceMarker(setupValue.runId, "slice-b");
    const assignmentSummary = (): RecoveryRecord[] => {
      const native = readCtoState(setupValue.runId, setupValue.harness.root);
      assert.ok(native, "native state must remain readable during root admission");
      return Object.entries(native.native_stage_progress ?? {}).flatMap(([teamId, progress]) =>
        Object.values(progress.assignments).map((assignment) => ({
          team_id: teamId,
          dispatch_id: assignment.identity.dispatch_id,
          task_id: assignment.identity.task_id,
          worker_id: assignment.identity.worker_id,
          stage_id: assignment.identity.stage_id,
          slot_id: assignment.slot_id,
          status: assignment.status,
        })),
      );
    };
    const claimWorkers = (): string[] => [...(readRunControl(setupValue.harness.root).execution_claim?.worker_ids ?? [])].sort();
    const recoveryLedger = (): string => {
      const native = readCtoState(setupValue.runId, setupValue.harness.root);
      assert.ok(native, "native state must remain readable for recovery-ledger comparison");
      return JSON.stringify((native as unknown as RecoveryRecord).stage_recovery ?? null);
    };
    const beforeAssignments = assignmentSummary();
    const beforeClaimWorkers = claimWorkers();
    const beforeRecoveryLedger = recoveryLedger();
    const beforeDispatches = dispatchCount(setupValue);
    assert.deepEqual(beforeAssignments, [], "two-team root batch starts without assignments");

    const blockedInput = {
      context: "shared context",
      tasks: [
        { agent: "team-lead-a", task: `${markerA}\nvalid A` },
        { agent: "team-lead-b", task: `${markerB}\nfirst B` },
        { agent: "team-lead-b", task: `${markerB}\nduplicate B` },
      ],
    };
    const blocked = await emit(setupValue.harness, "tool_call", {
      toolName: "task",
      toolCallId: "reliable-cto-two-team-duplicate",
      input: blockedInput,
    }, setupValue.harness.context);
    const denial = blocked.find(admissionBlocked);
    assert.ok(denial, JSON.stringify(blocked));
    assert.match(String((denial as RecoveryRecord).reason), /\[workflow_admission:native_authority_route_denied\]/, JSON.stringify(blocked));
    recordScenarioEvent({
      kind: "fault_observed",
      route: "C",
      tool: "task",
      faultPoint: "preflight",
      identities: { run: setupValue.runId, task: "reliable-cto-two-team-duplicate" },
      outcome: "REJECTED",
      verdict: "REJECT",
    });
    assert.deepEqual(assignmentSummary(), beforeAssignments, "duplicate lead item reserves no stage assignment, including valid A");
    assert.deepEqual(claimWorkers(), beforeClaimWorkers, "duplicate lead item reserves no worker claim");
    assert.equal(recoveryLedger(), beforeRecoveryLedger, "duplicate lead item consumes no recovery permit");
    assert.equal(dispatchCount(setupValue), beforeDispatches, "duplicate lead item creates no dispatch");

    const validInput = {
      context: "shared context",
      tasks: [
        { agent: "team-lead-a", task: `${markerA}\nvalid A` },
        { agent: "team-lead-b", task: `${markerB}\nvalid B` },
      ],
    };
    const admitted = await emit(setupValue.harness, "tool_call", {
      toolName: "task",
      toolCallId: "reliable-cto-two-team-valid",
      input: validInput,
    }, setupValue.harness.context);
    assert.equal(admitted.some(admissionBlocked), false, JSON.stringify(admitted));
    await emit(setupValue.harness, "tool_execution_start", {
      toolName: "task",
      toolCallId: "reliable-cto-two-team-valid",
      args: validInput,
    }, setupValue.harness.context);
    const assignments = assignmentSummary();
    assert.equal(assignments.length, 2, "valid root batch admits both configured teams");
    assert.deepEqual(assignments.map((assignment) => assignment.team_id).sort(), ["team-a", "team-b"]);
    assert.equal(new Set(assignments.map((assignment) => assignment.dispatch_id)).size, 2);
    assert.ok(assignments.every((assignment) => typeof assignment.worker_id === "string" && assignment.worker_id.length > 0));
    assert.ok(assignments.every((assignment) => assignment.status === "reserved" || assignment.status === "running"));
    assert.equal(dispatchCount(setupValue), beforeDispatches + 2, "valid root batch creates one dispatch per team");
    for (const assignment of assignments) {
      recordScenarioEvent({
        kind: "worker_admitted",
        route: "C",
        tool: "task",
        stage: String(assignment.stage_id),
        identities: {
          run: setupValue.runId,
          task: String(assignment.task_id),
          worker: String(assignment.worker_id),
          dispatch: String(assignment.dispatch_id),
        },
        outcome: "STARTED",
        verdict: "PASS",
      });
    }
    recordScenarioEvent({
      kind: "count_recorded",
      route: "C",
      tool: "task",
      stage: String(assignments[0]?.stage_id),
      identities: { run: setupValue.runId, task: "reliable-cto-two-team-valid" },
      count: assignments.length,
      outcome: "ACCEPTED",
      verdict: "PASS",
    });
  }, { ctoTeams: teams, workflowProfiles: [NATIVE_LEAD_PROFILE] });
}

scenarioTest("[C:R06] native configured two-team root batch rejects duplicate lead atomically", async () => {
  await runNativeRootBatchAtomicity();
});

async function runR15(route: Route): Promise<void> {
  await withSetup(route, async (setupValue) => {
    const worker = await admit(setupValue, "r15-format-unsupported");
    const rejected = details((await requireTool(setupValue.harness, "workflow_submit_result").execute(
      "r15-invalid-submit",
      submission({ implementation: { files_touched: "packages/core/src/engine/reliable-stage.ts" } }),
      undefined,
      undefined,
      worker.childContext,
    )).details);
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.ok(Array.isArray(rejected.field_errors), JSON.stringify(rejected));
    const beforeRepair = await snapshotFor(setupValue);
    const errorContext = asRecord(beforeRepair.error_context, "format validation context");
    assert.deepEqual(errorContext.field_errors, rejected.field_errors);
    const beforeDispatches = dispatchCount(setupValue);
    const repaired = await recover(setupValue, "reconcile", "repair_format");
    assert.equal(repaired.code, "format_repair_waiting_terminal");
    assert.equal(repaired.action, "wait");
    assert.equal(repaired.evidence, undefined);
    assert.equal(recoveryMessages(setupValue.harness).length, 0);
    assert.equal(dispatchCount(setupValue), beforeDispatches, "unsupported repair does not repeat implementation dispatch");
  });
  let activeHarness: Harness | undefined;
  let activeWorker: WorkerFixture | undefined;
  let correctedReceipt: RecoveryRecord | undefined;
  let observedFormatErrors: readonly unknown[] | undefined;
  const supportedHost = formatRepairHost(
    async () => {
      const harness = activeHarness;
      const worker = activeWorker;
      if (!harness || !worker) throw new Error("format repair must retain the assigned producer");
      return submitValid(harness, worker, "r15-adapter-corrected-submit");
    },
    (receipt, errors) => {
      correctedReceipt = receipt;
      observedFormatErrors = errors;
    },
  );
  await withSetup(route, async (setupValue) => {
    activeHarness = setupValue.harness;
    const supportedWorker = await admit(setupValue, "r15-format-supported");
    activeWorker = supportedWorker;
    const rejected = details((await requireTool(setupValue.harness, "workflow_submit_result").execute(
      "r15-supported-invalid-submit",
      submission({ implementation: { files_touched: "packages/core/src/engine/reliable-stage.ts" } }),
      undefined,
      undefined,
      supportedWorker.childContext,
    )).details);
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.ok(Array.isArray(rejected.field_errors), JSON.stringify(rejected));
    const beforeRepair = await snapshotFor(setupValue);
    const errorContext = asRecord(beforeRepair.error_context, "supported format validation context");
    assert.deepEqual(errorContext.field_errors, rejected.field_errors);
    const beforeDispatches = dispatchCount(setupValue);
    const repaired = await recover(setupValue, "reconcile", "repair_format");
    assert.equal(repaired.code, "format_repair_accepted");
    assert.equal(repaired.action, "repair_format");
    assert.equal(repaired.worker, "running");
    assert.deepEqual(observedFormatErrors, rejected.field_errors);
    const receipt = correctedReceipt;
    assert.ok(receipt);
    assert.equal(typeof receipt.receipt_id, "string");
    assert.equal(recoveryMessages(setupValue.harness).length, 0);
    assert.equal(dispatchCount(setupValue), beforeDispatches, "supported format repair does not repeat implementation dispatch");
    await terminalWorker(setupValue.harness, supportedWorker);
  }, { stageRecoveryHost: supportedHost });
  await withSetup(route, async (setupValue) => {
    const worker = await admit(setupValue, "r15-terminal");
    await terminalWorker(setupValue.harness, worker, true);
    const afterTerminal = await snapshotFor(setupValue);
    const terminalErrorContext = afterTerminal.error_context;
    const beforeRepairDispatches = dispatchCount(setupValue);
    const beforeRepairMessages = recoveryMessages(setupValue.harness).length;
    const rejected = details((await requireTool(setupValue.harness, "workflow_submit_result").execute(
      "r15-missing-submit",
      submission({ implementation: { ready: true } }),
      undefined,
      undefined,
      worker.childContext,
    )).details);
    assert.equal(rejected.ok, false);
    const afterRejected = await snapshotFor(setupValue);
    assert.deepEqual(afterRejected.error_context, terminalErrorContext);
    const repair = await recover(setupValue, "reconcile", "repair_format");
    assert.equal(repair.code, "format_repair_unavailable");
    assert.equal(recoveryMessages(setupValue.harness).length, beforeRepairMessages, "missing submission cannot fabricate correction content or a second recovery message");
    assert.equal(dispatchCount(setupValue), beforeRepairDispatches, "format repair does not repeat implementation dispatch after terminal auto recovery");
  });
}

scenarioTest("[O:R15] ordinary invalid submission returns exact producer errors and never repeats implementation", async () => {
  await runR15("ordinary");
});

scenarioTest("[C:R15] native invalid submission returns exact producer errors and never repeats implementation", async () => {
  await runR15("cto");
});


for (const route of ["ordinary", "cto"] as const) {
  scenarioTest(`${route}: terminal success without receipt continues saved assignment`, async () => {
    await withSetup(route, async (current) => {
      const first = await admit(current, "incomplete-first");
      await terminalWorker(current.harness, first);
      const diagnosed = await recover(current, "diagnose", "observe");
      assert.equal(diagnosed.code, "incomplete_assignment", safeRecoveryDetails(diagnosed));
      assert.equal(diagnosed.worker, "terminal");
      const continued = await recover(current, "reconcile", "replace");
      assert.equal(continued.code, "replacement_dispatched", safeRecoveryDetails(continued));
      const message = recoveryMessage(await current.harness.waitForRecoveryMessage());
      const previous = identityFromSnapshot(await snapshotFor(current));
      assert.equal(message.retry_of, previous.dispatch_id);
      const replacement = await admit(current, "incomplete-next");
      const stale = await submitValid(current.harness, first, "incomplete-stale");
      assert.equal(stale.ok, false, JSON.stringify(stale));
      const receipt = await submitValid(current.harness, replacement, "incomplete-submit");
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      assert.equal(typeof asRecord(receipt.receipt, "accepted receipt").receipt_id, "string");
      await terminalWorker(current.harness, replacement);
      const complete = await recover(current, "diagnose", "observe");
      assert.equal(complete.code, "worker_succeeded", safeRecoveryDetails(complete));
      assert.equal(complete.action, "none");
      const messagesBefore = recoveryMessages(current.harness).length;
      const forbidden = await recover(current, "reconcile", "replace");
      assert.equal(forbidden.code, "worker_succeeded", safeRecoveryDetails(forbidden));
      assert.equal(recoveryMessages(current.harness).length, messagesBefore);
      if (route === "ordinary") {
        assert.ok(current.handoff);
        assert.equal((await advanceOrdinaryStage(current.harness, current.handoff, "incomplete-advance")).stage_cursor, "next");
      } else {
        const checkpoint = await requireTool(current.harness, "cto_checkpoint_ask").execute("incomplete-checkpoint", { slice_id: "slice-a" }, undefined, undefined, current.harness.context);
        assert.equal(details(checkpoint.details).ok, true, JSON.stringify(checkpoint.details));
        const advanced = await requireTool(current.harness, "cto_stage_advance").execute("incomplete-advance", { slice_id: "slice-a" }, undefined, undefined, current.harness.context);
        assert.equal(details(advanced.details).ok, true, JSON.stringify(advanced.details));
      }
    });
  });
}
