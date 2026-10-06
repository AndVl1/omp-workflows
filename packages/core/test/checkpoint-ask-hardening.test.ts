/**
 * Host-ingress hardening for `workflow_checkpoint_ask` (br-zps review fixes):
 *
 *   - AbortSignal: canceled calls reject before the UI, after the dialog
 *     resolves, and immediately before the synchronous engine commit — a
 *     canceled call never mints an answer, and the host dialog options
 *     receive the signal.
 *   - Durable commit seam: the entire post-dialog flow is ONE
 *     `commitCheckpointAnswer` transaction — fresh-state revalidation,
 *     already-finalized replay, conflicting-decision rejection, live-proof
 *     reuse/supersession, and the CAS commit are engine-owned; a cursor,
 *     capability, or decision transition while the dialog is open rejects
 *     without persisting or rolling back the concurrent writer.
 *   - Strict state↔capability coherence: malformed capabilities, state↔cap
 *     drift, stale branches, profile drift, and state↔profile policy drift
 *     fail closed before any human prompt.
 *   - Duplicate-proof guard: exact replay of a live identical answer stays
 *     idempotent; conflicting or concurrent asks supersede stale live
 *     proofs across BOTH channels so at most one unconsumed answer exists
 *     per unresolved checkpoint, and a superseded proof can never authorize
 *     the follow-up `workflow_checkpoint` call.
 *   - Strict installed-host result parsing: only exactly one selected
 *     policy-allowed decision for the exact question — echoing its text and
 *     options, strict single-select (`multi === false`), one string
 *     selection, valid optional `timedOut`/`customInput` fields, and no
 *     metadata outside the installed host's `ExtensionAskDialogResultItem`
 *     contract — authorizes; anything else records nothing.
 *   - Loop-iteration binding: the handoff's `loop_iteration` is enforced
 *     when present, echoed verbatim in the answer payload, and propagates
 *     into the ledger decision scope.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z as zod } from "zod";
import { advanceCursor, authorizeDispatch, createCapability, recordCheckpointDecision, type CapabilityHandoff, type IssuedCapability } from "../src/engine/durable.js";
import { loadProfile, profileHash, registerWorkflowProfiles } from "../src/engine/profile.js";
import { checkpointAnswerBinding, checkpointDecisionKey, checkpointPolicyHash, findHistoricalCheckpointDecision, recordTrustedCheckpointAnswer, resolveCheckpointDeclaration } from "../src/engine/checkpoints.js";
import { resolveCanonicalRun } from "../src/engine/state.js";
import { persistCanonicalRun, readRunControl, runTarget } from "../src/engine/run-store.js";
import { createWorkflowSessionController, type WorkflowSessionController } from "../src/engine/host-controller.js";
import { buildDispatchMarker, registerTeamWorkflow, registerWorkflowTools } from "../src/index.js";
import type { Profile, TeamState, TrustedExecutionContext } from "../src/engine/types.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "ask-hardening-session";

const fixtureControllers = new Map<string, WorkflowSessionController>();
type FixtureEventHandler = (event: unknown, ctx: unknown) => unknown;
type FixtureRecoveryBarrier = {
  queued: Promise<void>;
  release: () => void;
  released: Promise<void>;
};
type FixtureBridge = {
  host: Record<string, unknown>;
  emit: (name: string, event: unknown, ctx: unknown) => unknown[];
  recovery: FixtureRecoveryBarrier;
};
const fixtureBridges = new Map<string, FixtureBridge>();
const RECEIPT_WORKFLOW = "checkpoint-ask-receipt";

function registerReceiptProfile(): void {
  const base = loadProfile("lightweight");
  if (!base?.checkpoint_policy) throw new Error("lightweight checkpoint policy is required by the receipt fixture");
  const profile: Profile = {
    name: RECEIPT_WORKFLOW,
    title: "Checkpoint receipt fixture",
    description: "A first-stage worker fixture for checkpoint receipt continuity.",
    match: { type: ["FEATURE"], complexity: ["QUICK"] },
    checkpoint_policy: base.checkpoint_policy,
    stages: [
      {
        id: "implementation",
        title: "Implementation",
        type: "single",
        role: "developer-kotlin",
        produces: "implementation",
        checkpoint: "approve_implementation",
      },
      {
        id: "code_review",
        title: "Code Review",
        type: "single",
        role: "developer-kotlin",
        consumes: ["implementation"],
        produces: "review",
      },
    ],
  };
  registerWorkflowProfiles([profile]);
}

type AskParams = Record<string, unknown>;
type AskResponse = { details: AskParams };
type DialogQuestion = { id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean };
type DialogOptions = { signal?: AbortSignal };
type AskContext = Record<string, unknown>;
type AskExecute = (id: string, params: AskParams, signal: AbortSignal | undefined, update: undefined, ctx: AskContext) => Promise<AskResponse>;
type DialogScript = (questions: DialogQuestion[], dialogOptions: DialogOptions | undefined) => unknown;
interface DialogCall {
  questions: DialogQuestion[];
  options: DialogOptions | undefined;
}

type AssignedDispatchFixture = {
  id: string;
  role: string;
  agent: string;
  task_id?: string;
  tool_call_id?: string;
};
type AssignedWorkerFixture = {
  agent: string;
  childFile: string;
  lifecycleId: string;
  toolCallId: string;
  input: { agent: string; task: string };
};

/** Register the workflow tools with a trusted host session and return them by name. */
function registerTools(root: string, workerSubmission = false): Map<string, { name: string; execute: never }> {
  const registered = new Map<string, { name: string; execute: never }>();
  const context: TrustedExecutionContext = {
    session_id: SESSION_ID,
    caller: "host",
    process_id: process.pid,
    worktree: root,
    branch: "main",
    authority: "coordinator",
  };
  const controller = createWorkflowSessionController({ cwd: root, context });
  fixtureControllers.set(root, controller);
  const handlers = new Map<string, FixtureEventHandler[]>();
  const on = (name: string, handler: FixtureEventHandler): void => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  };
  const hostFile = join(root, "ask-hardening-host.jsonl");
  const hostManager = {
    getCwd: () => root,
    getSessionId: () => SESSION_ID,
    getSessionFile: () => hostFile,
    getHeader: () => ({ id: SESSION_ID, cwd: root }),
  };
  const host = {
    ...context,
    cwd: root,
    mode: "tui",
    hasUI: true,
    sessionFile: hostFile,
    sessionManager: hostManager,
  };
  let queued = false;
  let resolveQueued!: () => void;
  const queuedPromise = new Promise<void>((resolve) => { resolveQueued = resolve; });
  let released = false;
  let releaseQueue!: () => void;
  let resolveReleased!: () => void;
  const releasedPromise = new Promise<void>((resolve) => { resolveReleased = resolve; });
  const sendMessage = (message: unknown): void | Promise<void> => {
    if (!message || typeof message !== "object" || Array.isArray(message) || !("customType" in message) || message.customType !== "omp-workflow-stage-recovery") return;
    if (!queued) {
      queued = true;
      resolveQueued();
    }
    return new Promise<void>((resolve) => {
      releaseQueue = () => {
        if (released) return;
        released = true;
        resolve();
        resolveReleased();
      };
    });
  };
  const pi = {
    ...(workerSubmission ? { on, events: { on }, setLabel() {}, sendMessage } : {}),
    zod: { z: zod },
    registerTool: (tool: { name: string; execute: never }) => {
      registered.set(tool.name, tool);
    },
  };
  if (workerSubmission) {
    registerReceiptProfile();
    registerTeamWorkflow(pi as never, {
      cwd: root,
      resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd,
      getSessionController: (ctx: unknown) => ctx === host ? controller : undefined,
      resolveTrustedToolCallActor: (ctx: unknown, cwd: string, runId: string | undefined) => {
        if (ctx !== host || !runId) return undefined;
        return { actor: "orchestrator" as const, artifactsDir: runTarget(cwd, runId).artifactsDir };
      },
      observability: false,
    });
    fixtureBridges.set(root, {
      host,
      emit: (name, event, ctx) => (handlers.get(name) ?? []).map((handler) => handler(event, ctx)),
      recovery: {
        queued: queuedPromise,
        release: () => releaseQueue(),
        released: releasedPromise,
      },
    });
  }
  registerWorkflowTools(pi as never, {
    isMainSession: () => true,
    resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd,
    getSessionController: () => controller,
  });
  return registered;
}
async function publishAssignedWorkerOutput(
  root: string,
  issued: IssuedCapability,
  tools: Map<string, { name: string; execute: never }>,
  dispatch: AssignedDispatchFixture,
  output: Record<string, unknown>,
): Promise<AssignedWorkerFixture> {
  const bridge = fixtureBridges.get(root);
  assert.ok(bridge, "receipt fixture must register the trusted worker event bridge");
  const profile = loadProfile(issued.state.issued_for!.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === issued.state.issued_for!.stage_cursor);
  assert.ok(stage, "receipt fixture stage must be declared");
  const toolCallId = dispatch.tool_call_id ?? `ask-hardening-worker-${dispatch.id}`;
  const marker = buildDispatchMarker(
    RUN_ID,
    stage,
    [dispatch.role],
    dispatch.role,
    issued.state.issued_for!.cursor_epoch,
    issued.capability_id,
    dispatch.role,
    dispatch.task_id,
  );
  const input = { agent: dispatch.agent, task: marker };
  const admitted = bridge.emit("tool_call", { toolName: "task", toolCallId, input }, bridge.host);
  assert.equal(admitted.filter(Boolean).length, 0, JSON.stringify(admitted));
  bridge.emit("tool_execution_start", { toolName: "task", toolCallId, args: input }, bridge.host);

  const childFile = join(root, `${toolCallId}-worker.jsonl`);
  const childSessionId = `${toolCallId}-worker`;
  const childManager = {
    getCwd: () => root,
    getSessionId: () => childSessionId,
    getSessionFile: () => childFile,
    getHeader: () => ({ id: childSessionId, cwd: root, parentSession: String(bridge.host.sessionFile) }),
  };
  const childContext: AskContext = {
    cwd: root,
    mode: "print",
    hasUI: false,
    session_id: childSessionId,
    sessionFile: childFile,
    sessionManager: childManager,
  };
  const lifecycleId = `${toolCallId}-lifecycle`;
  bridge.emit("task:subagent:lifecycle", {
    id: lifecycleId,
    agent: dispatch.agent,
    status: "started",
    sessionFile: childFile,
    parentToolCallId: toolCallId,
    index: 0,
  }, bridge.host);

  const submitTool = tools.get("workflow_submit_result");
  assert.ok(submitTool, "workflow_submit_result must be registered");
  const execute = submitTool.execute as unknown as (
    id: string,
    params: AskParams,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: AskContext,
  ) => Promise<AskResponse>;
  const submitted = await execute("ask-hardening-worker-submit", { outputs: { implementation: output } }, undefined, undefined, childContext);
  const details = submitted.details;
  assert.equal(details.ok, true, JSON.stringify(details));
  const persistedReceipt = readStateFile(root).stage_receipts?.[dispatch.id];
  assert.ok(persistedReceipt, "accepted worker output must persist its receipt before terminal lifecycle");
  assert.ok(persistedReceipt.outputs.some((entry) => entry.artifact_id === "implementation"), "the persisted receipt must cover the implementation output");
  return { agent: dispatch.agent, childFile, lifecycleId, toolCallId, input };
}

async function terminalAssignedWorker(root: string, worker: AssignedWorkerFixture, failed: boolean): Promise<void> {
  const bridge = fixtureBridges.get(root);
  assert.ok(bridge, "receipt fixture bridge must remain active through terminal lifecycle");
  const terminal = bridge.emit("tool_result", {
    toolName: "task",
    toolCallId: worker.toolCallId,
    input: worker.input,
    details: {
      results: [{
        index: 0,
        id: `${worker.toolCallId}-result`,
        agent: worker.input.agent,
        agentSource: "project",
        task: worker.input.task,
        exitCode: failed ? 1 : 0,
        output: failed ? "worker failed" : "worker completed",
        stderr: "",
        truncated: false,
        durationMs: 1,
        tokens: 1,
        requests: 1,
      }],
    },
    content: [{ type: "text", text: failed ? "worker failed" : "worker completed" }],
    isError: failed,
  }, bridge.host);
  await Promise.all(terminal.map(async (result) => await result));
  const lifecycle = bridge.emit("task:subagent:lifecycle", {
    id: worker.lifecycleId,
    agent: worker.agent,
    status: failed ? "failed" : "completed",
    sessionFile: worker.childFile,
    parentToolCallId: worker.toolCallId,
    index: 0,
  }, bridge.host);
  await Promise.all(lifecycle.map(async (result) => await result));
  if (failed) {
    await bridge.recovery.queued;
    bridge.recovery.release();
    await bridge.recovery.released;
  }
}


function trustedContext(root: string): TrustedExecutionContext {
  return {
    session_id: SESSION_ID,
    caller: "host",
    process_id: process.pid,
    worktree: root,
    branch: "main",
    authority: "coordinator",
  };
}

function askExecute(tools: Map<string, { name: string; execute: never }>): AskExecute {
  const ask = tools.get("workflow_checkpoint_ask");
  assert.ok(ask, "workflow_checkpoint_ask must be registered");
  return ask.execute as unknown as AskExecute;
}
async function beginAskStage(root: string, tools: Map<string, { name: string; execute: never }>): Promise<IssuedCapability> {
  const bridge = fixtureBridges.get(root);
  assert.ok(bridge, "ask fixture bridge must be registered before beginning a stage");
  const beginTool = tools.get("workflow_begin");
  assert.ok(beginTool, "workflow_begin must be registered");
  const execute = beginTool.execute as unknown as (id: string, params: AskParams, signal: AbortSignal | undefined, update: undefined, ctx: AskContext) => Promise<AskResponse>;
  const begun = await execute("ask-hardening-begin", {}, undefined, undefined, bridge.host);
  const details = begun.details as { ok?: boolean; error?: string; handoff?: CapabilityHandoff };
  assert.equal(details.ok, true, JSON.stringify(details));
  assert.ok(details.handoff, "workflow_begin must return the fresh stage handoff");
  const state = readStateFile(root);
  assert.ok(state.dispatch_capability, "workflow_begin must persist the fresh dispatch capability");
  if (!details.handoff || !state.dispatch_capability) throw new Error(details.error ?? "workflow_begin returned no handoff");
  return {
    capability_id: details.handoff.capability_id,
    dispatch_token: details.handoff.dispatch_token,
    advance_token: details.handoff.advance_token,
    state: state.dispatch_capability,
  };
}


function writeAskFixture(root: string, workflow = "lightweight"): IssuedCapability {
  const profile = loadProfile(workflow);
  assert.ok(profile, `${workflow} profile must be available`);
  const persistedProfileHash = profileHash(profile);
  const issued = createCapability({
    run_key: RUN_ID,
    branch: "main",
    workflow: profile.name,
    profile_hash: persistedProfileHash,
    stage_cursor: "implementation",
    kind: "single",
    expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
  });
  const state: TeamState = {
    schema: 2,
    run_id: RUN_ID,
    run_key: RUN_ID,
    lifecycle_status: "active",
    rework_generation: 0,
    branch: "main",
    title: "checkpoint ask hardening",
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: profile.name },
    task: "checkpoint ask hardening",
    required_inputs: Object.fromEntries(profile.stages.map((stage) => [stage.id, []])),
    required_input_receipts: {},
    decisions: [],
    workflow_override: false,
    issue: null,
    stage_cursor: "implementation",
    stages: profile.stages.map((stage, index) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : index < profile.stages.findIndex((candidate) => candidate.id === "implementation") ? "skipped" as const : "pending" as const })),
    artifacts: {},
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: "developer-kotlin" },
    policy: { strict_orchestrator: true },
    pause: { kind: "none", reason: "" },
    profile_hash: persistedProfileHash,
    checkpoint_policy: profile.checkpoint_policy,
    checkpoint_policy_binding: {
      stage_id: "implementation",
      profile_hash: persistedProfileHash,
      policy_hash: checkpointPolicyHash(profile.checkpoint_policy!),
    },
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  };
  persistCanonicalRun(root, state, { context: trustedContext(root) });
  const controller = fixtureControllers.get(root);
  assert.ok(controller, "fixture controller must be registered before seeding the canonical run");
  const claim = readRunControl(root).execution_claim;
  assert.ok(claim, "canonical fixture persistence must create an execution claim");
  assert.equal(claim.run_id, RUN_ID, "the canonical claim must bind the fixture run");
  assert.equal(claim.coordinator_session_id, SESSION_ID, "the canonical claim must bind the fixture session");
  assert.equal(typeof claim.token, "string");
  controller.bind(RUN_ID, claim.token);
  assert.equal(controller.selectedRunId(), RUN_ID, "the fixture controller must select the canonical run");
  assert.equal(controller.activeClaimRunId(), RUN_ID, "the fixture controller must own the canonical claim");
  return issued;
}
async function writeAskFixtureWithDiscovery(
  root: string,
  tools: Map<string, { name: string; execute: never }>,
): Promise<IssuedCapability> {
  const profile = loadProfile("lightweight");
  assert.ok(profile, "lightweight profile must be available");
  const discovery = createCapability({
    run_key: RUN_ID,
    branch: "main",
    workflow: profile.name,
    profile_hash: profileHash(profile),
    stage_cursor: "discovery",
    kind: "none",
    expected_roster: [],
  });
  const state: TeamState = {
    schema: 2,
    run_id: RUN_ID,
    run_key: RUN_ID,
    lifecycle_status: "active",
    rework_generation: 0,
    branch: "main",
    title: "checkpoint ask hardening",
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: profile.name },
    task: "checkpoint ask hardening",
    required_inputs: Object.fromEntries(profile.stages.map((stage) => [stage.id, []])),
    required_input_receipts: {},
    decisions: [],
    workflow_override: false,
    issue: null,
    stage_cursor: "discovery",
    stages: profile.stages.map((stage, index) => ({ id: stage.id, status: index === 0 ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: "developer-kotlin" },
    policy: { strict_orchestrator: true },
    pause: { kind: "none", reason: "" },
    profile_hash: profileHash(profile),
    cursor_epoch: discovery.state.issued_for!.cursor_epoch,
    dispatch_capability: discovery.state,
    updated_at: new Date().toISOString(),
  };
  persistCanonicalRun(root, state, { context: trustedContext(root) });
  const controller = fixtureControllers.get(root);
  assert.ok(controller, "fixture controller must be registered before seeding discovery");
  const claim = readRunControl(root).execution_claim;
  assert.ok(claim, "discovery fixture persistence must create an execution claim");
  controller.bind(RUN_ID, claim.token);
  const armed = await beginAskStage(root, tools);
  const bridge = fixtureBridges.get(root);
  assert.ok(bridge, "discovery fixture bridge must be registered");
  const submitTool = tools.get("workflow_submit_result");
  assert.ok(submitTool, "workflow_submit_result must be registered for discovery");
  const execute = submitTool.execute as unknown as (id: string, params: AskParams, signal: AbortSignal | undefined, update: undefined, ctx: AskContext) => Promise<AskResponse>;
  const submitted = await execute("ask-hardening-discovery-submit", {
    outputs: {
      discovery: { task: "checkpoint ask hardening", branch: "main", constraints: [] },
      dod: {
        items: [{
          id: "discovery-ask-hardening",
          source: "discovery",
          criterion: "the registered upstream producer reaches implementation",
          verify_method: "registered discovery submission",
          status: "pending",
          evidence: "",
        }],
        type_requirements_met: false,
        updated_at: new Date().toISOString(),
      },
    },
  }, undefined, undefined, bridge.host);
  assert.equal(submitted.details.ok, true, JSON.stringify(submitted.details));
  const advanced = advanceCursor(root, {
    run_id: RUN_ID,
    token: armed.advance_token,
    capability_id: armed.capability_id,
    run_key: RUN_ID,
    branch: "main",
    workflow: profile.name,
    profile_hash: profileHash(profile),
    stage_cursor: "discovery",
    cursor_epoch: armed.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    evidence: "registered discovery producer completed",
  }, { runId: RUN_ID });
  assert.equal(advanced.ok, true, advanced.ok ? "discovery advanced" : advanced.error);
  if (!advanced.ok || !advanced.handoff || !advanced.state.dispatch_capability) throw new Error(advanced.ok ? "discovery produced no implementation handoff" : advanced.error);
  return await beginAskStage(root, tools);
}


function askAuth(issued: IssuedCapability): AskParams {
  const workflow = issued.state.issued_for!.workflow;
  const profile = loadProfile(workflow);
  assert.ok(profile, `${workflow} profile must be available for checkpoint ask auth`);
  return {
    run_id: RUN_ID,
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: RUN_ID,
    branch: "main",
    workflow,
    profile_hash: profileHash(profile),
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    checkpoint: "approve_implementation",
    checkpoint_id: "approve_implementation",
    checkpoint_kind: "implementation_approval",
  };
}

function askContext(root: string, script: DialogScript, calls: DialogCall[]): AskContext {
  return {
    cwd: root,
    session_id: SESSION_ID,
    hasUI: true,
    ui: {
      async askDialog(questions: DialogQuestion[], dialogOptions: DialogOptions): Promise<unknown> {
        calls.push({ questions, options: dialogOptions });
        return await script(questions, dialogOptions);
      },
    },
  };
}

function trustedToolContext(root: string): AskContext {
  return { cwd: root, session_id: SESSION_ID, hasUI: true };
}

type SubmitExtra = Partial<{ id: string; question: string; options: string[]; multi: boolean; timedOut: boolean; customInput: string; note: string }>;

/** OMP 18.4.9 raw dialog items keep image keys even without attachments. */
function canonicalItem(question: DialogQuestion): Record<string, unknown> {
  return {
    id: question.id,
    question: question.question,
    options: question.options.map((option) => option.label),
    multi: false,
    selectedOptions: [] as string[],
    customInputImages: undefined,
    noteImages: undefined,
  };
}

function submit(question: DialogQuestion, selection: string[], extra: SubmitExtra = {}): unknown {
  return {
    kind: "submit",
    results: [{
      ...canonicalItem(question),
      selectedOptions: selection,
      ...(extra.id !== undefined ? { id: extra.id } : {}),
      ...(extra.question !== undefined ? { question: extra.question } : {}),
      ...(extra.options !== undefined ? { options: extra.options } : {}),
      ...(extra.multi !== undefined ? { multi: extra.multi } : {}),
      ...(extra.timedOut !== undefined ? { timedOut: extra.timedOut } : {}),
      ...(extra.customInput !== undefined ? { customInput: extra.customInput } : {}),
      ...(extra.note !== undefined ? { note: extra.note } : {}),
    }],
  };
}

function withoutEcho(question: DialogQuestion, key: string): unknown {
  const item = canonicalItem(question);
  delete item[key];
  return { kind: "submit", results: [item] };
}
function canonicalTarget(root: string) {
  const resolved = resolveCanonicalRun(root, { kind: "team", runId: RUN_ID }, "main");
  assert.ok(resolved?.state, "fixture state must resolve");
  return resolved;
}

function readStateFile(root: string): TeamState {
  return canonicalTarget(root).state!;
}

function persistedAnswers(root: string): Array<Record<string, unknown>> {
  return (readStateFile(root).trusted_checkpoint_answers ?? []) as unknown as Array<Record<string, unknown>>;
}

/** Answer records read from the raw state file: a tampered state that normalization rejects can never resolve. */
function persistedRawAnswers(root: string): Array<Record<string, unknown>> {
  const target = runTarget(root, RUN_ID);
  const raw = JSON.parse(readFileSync(target.statePath!, "utf8")) as { trusted_checkpoint_answers?: Array<Record<string, unknown>> };
  return raw.trusted_checkpoint_answers ?? [];
}

function overwriteStateFile(root: string, mutate: (raw: Record<string, unknown>) => void): void {
  const target = runTarget(root, RUN_ID);
  const raw = JSON.parse(readFileSync(target.statePath!, "utf8")) as Record<string, unknown>;
  mutate(raw);
  writeFileSync(target.statePath!, JSON.stringify(raw, null, 2) + "\n");
}

function writeCanonicalState(root: string, state: TeamState): void {
  const persisted = { ...state, state_revision: state.state_revision ?? 1 };
  writeFileSync(runTarget(root, RUN_ID).statePath!, `${JSON.stringify(persisted, null, 2)}\n`);
}
/**
 * Seed MULTIPLE genuinely live answers for one question by deriving each
 * from the SAME pre-answer state. The raw fixture bypasses the normal
 * single-live-answer supersession path so duplicate proof cleanup is tested.
 */
function seedLiveAnswers(root: string, entries: Array<{ answerId: string; decision: string }>): void {
  const resolved = canonicalTarget(root);
  const minted = entries.map(({ answerId, decision }) =>
    recordTrustedCheckpointAnswer(resolved.state!, {
      answer_id: answerId,
      channel: "terminal",
      reference: `terminal-answer/seeded/${answerId}`,
      stage_id: "implementation",
      checkpoint_id: "approve_implementation",
      decision,
    }));
  const answers = minted.flatMap((result) => result.state.trusted_checkpoint_answers ?? []);
  writeCanonicalState(root, { ...resolved.state!, trusted_checkpoint_answers: answers });
}

function seedLiveAnswer(root: string, answerId: string, decision: string): void {
  const resolved = canonicalTarget(root);
  const trusted = recordTrustedCheckpointAnswer(resolved.state!, {
    answer_id: answerId,
    channel: "terminal",
    reference: `terminal-answer/seeded/${answerId}`,
    stage_id: "implementation",
    checkpoint_id: "approve_implementation",
    decision,
  });
  writeCanonicalState(root, trusted.state);
}

/** Rotate the active capability while retaining a previously minted live proof. */
function rotateAskCapability(root: string, previous: IssuedCapability): IssuedCapability {
  const workflow = previous.state.issued_for!.workflow;
  const profile = loadProfile(workflow);
  assert.ok(profile, `${workflow} profile must be available for capability rotation`);
  const rotated = createCapability({
    run_key: RUN_ID,
    branch: "main",
    workflow,
    profile_hash: profileHash(profile),
    stage_cursor: "implementation",
    kind: "single",
    expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
  });
  const state = readStateFile(root);
  writeCanonicalState(root, {
    ...state,
    cursor_epoch: rotated.state.issued_for!.cursor_epoch,
    dispatch_capability: rotated.state,
  });
  return rotated;
}

/** Record `decision` with a durable escalation proof, as another trusted surface would. */
function recordEscalationDecision(root: string, issued: IssuedCapability, decision: string): void {
  const resolved = canonicalTarget(root);
  const trusted = recordTrustedCheckpointAnswer(resolved.state!, {
    answer_id: `durable/implementation/approve_implementation/${decision}`,
    channel: "escalation",
    reference: `escalation-answer/durable/implementation/approve_implementation/${decision}`,
    stage_id: "implementation",
    checkpoint_id: "approve_implementation",
    decision,
  });
  writeCanonicalState(root, trusted.state);
  const recorded = recordCheckpointDecision(root, {
    run_id: RUN_ID,
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: RUN_ID,
    branch: "main",
    workflow: "lightweight",
    profile_hash: profileHash(loadProfile("lightweight")!),
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    checkpoint: "approve_implementation",
    checkpoint_id: "approve_implementation",
    checkpoint_kind: "implementation_approval",
    authorization: "human",
    actor_provenance: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
    decision,
    rationale: `recorded concurrently while the dialog was open (${decision})`,
  });
  assert.equal(recorded.ok, true, "the concurrent recording must succeed inside the scenario");
}
function checkpointEnvelope(issued: IssuedCapability): Record<string, unknown> {
  const workflow = issued.state.issued_for!.workflow;
  const profile = loadProfile(workflow);
  assert.ok(profile, `${workflow} profile must be available for checkpoint envelope`);
  return {
    run_id: RUN_ID,
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: RUN_ID,
    branch: "main",
    workflow,
    profile_hash: profileHash(profile),
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    checkpoint: "approve_implementation",
    checkpoint_id: "approve_implementation",
    checkpoint_kind: "implementation_approval",
    authorization: "human",
  };
}

function withFixture(
  name: string,
  run: (root: string, ask: AskExecute, tools: Map<string, { name: string; execute: never }>) => Promise<void>,
  options: { workerSubmission?: boolean } = {},
): void {
  return test(name, async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-ask-hardening-"));
    try {
      execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
      const tools = registerTools(root, options.workerSubmission === true);
      await run(root, askExecute(tools), tools);
    } finally {
      fixtureBridges.delete(root);
      fixtureControllers.delete(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

withFixture("ask: a canceled call rejects before any human prompt and mints nothing", async (root, ask) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];
  const controller = new AbortController();
  controller.abort();
  // The abort gate fires before any validation, so the dialog script here is
  // only a tripwire: it must never run.
  const response = await ask("t", { ...askAuth(issued) }, controller.signal, undefined, askContext(root, () => {
    throw new Error("dialog must not be presented for a canceled call");
  }, calls));
  const details = response.details as { ok?: boolean; code?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_ABORTED");
  assert.deepEqual(calls, [], "the dialog is never presented for a canceled call");
  assert.equal(persistedAnswers(root).length, 0, "a canceled call never mints an answer");
});

withFixture("ask: cancellation during the dialog propagates the signal, rejects after the await, and records nothing", async (root, ask) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];
  const controller = new AbortController();
  const response = await ask("t", askAuth(issued), controller.signal, undefined, askContext(root, (questions, dialogOptions) => {
    assert.ok(dialogOptions?.signal instanceof AbortSignal, "the host dialog options must receive the abort signal");
    assert.equal(dialogOptions.signal, controller.signal, "the tool's own signal is propagated to the dialog");
    assert.equal(questions.length, 1);
    assert.deepEqual(questions[0]!.options.map((option) => option.label), ["proceed", "reject"], "only policy-allowed decisions are displayed");
    return (async () => {
      await Promise.resolve();
      controller.abort();
      return submit(questions[0]!, ["proceed"]);
    })();
  }, calls));
  const details = response.details as { ok?: boolean; code?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_ABORTED");
  assert.equal(persistedAnswers(root).length, 0, "an answer produced after cancellation is never minted");
});

withFixture("ask: a cursor/capability transition while the dialog is open rejects without persisting or rolling back", async (root, ask) => {
  const issued = writeAskFixture(root);
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => {
    // Simulate a concurrent engine transition: rotate the cursor epoch and
    // re-bind the capability while the human dialog is open.
    const resolved = canonicalTarget(root);
    assert.ok(resolved.state);
    const cap = resolved.state.dispatch_capability!;
    const rotated: TeamState = {
      ...resolved.state,
      cursor_epoch: "rotated-epoch",
      dispatch_capability: { ...cap, issued_for: { ...cap.issued_for!, cursor_epoch: "rotated-epoch" } },
    };
    writeCanonicalState(root, rotated);
    return submit(questions[0]!, ["proceed"]);
  }, []));
  const details = response.details as { ok?: boolean; code?: string; error?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_REJECTED");
  assert.match(details.error ?? "", /workflow state changed while the dialog was open/);
  assert.match(details.error ?? "", /capability binding mismatch/);
  // The concurrent writer survives untouched; no stale snapshot was written over it.
  const after = readStateFile(root);
  assert.equal(after.cursor_epoch, "rotated-epoch");
  assert.equal(after.dispatch_capability!.issued_for!.cursor_epoch, "rotated-epoch");
  assert.equal(persistedAnswers(root).length, 0, "the stale human answer is never persisted");
});

withFixture("ask: a conflicting decision recorded while the dialog was open rejects without touching the ledger", async (root, ask) => {
  const issued = writeAskFixture(root);
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => {
    recordEscalationDecision(root, issued, "reject");
    return submit(questions[0]!, ["proceed"]);
  }, []));
  const details = response.details as { ok?: boolean; code?: string; error?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_REJECTED");
  assert.match(details.error ?? "", /conflicting decision 'reject' was already recorded/);
  const after = readStateFile(root);
  assert.equal((after.typed_checkpoint_decisions ?? []).length, 1, "the recorded decision is untouched");
  assert.equal(persistedAnswers(root).length, 1, "no additional answer was minted");
});

withFixture("ask: an identical selection after a decision was recorded mid-dialog replays idempotently", async (root, ask) => {
  const issued = writeAskFixture(root);
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => {
    recordEscalationDecision(root, issued, "proceed");
    return submit(questions[0]!, ["proceed"]);
  }, []));
  const details = response.details as { ok?: boolean; already_recorded?: boolean; decision?: string };
  assert.equal(details.ok, true);
  assert.equal(details.already_recorded, true);
  assert.equal(details.decision, "proceed");
  assert.equal(persistedAnswers(root).length, 1, "no duplicate answer is minted for an idempotent replay");
});

withFixture("ask: malformed capabilities fail closed before any human prompt", async (root, ask) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];

  // Cardinality corruption invalidates the whole capability shape.
  overwriteStateFile(root, (raw) => {
    (raw.dispatch_capability as Record<string, unknown>).expected_count = 5;
  });
  let response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  let details = response.details as { ok?: boolean };
  assert.equal(details.ok, false);

  // A tampered dispatch record breaks the capability's dispatch invariants.
  overwriteStateFile(root, (raw) => {
    const cap = raw.dispatch_capability as Record<string, unknown>;
    cap.expected_count = 1;
    (cap.dispatches as Array<Record<string, unknown>>).push({ id: "forged", role: "developer-kotlin#bogus", agent: "ghost", status: "authorized", attempt: 1, created_at: "now" });
  });
  response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  details = response.details as { ok?: boolean };
  assert.equal(details.ok, false);
  assert.deepEqual(calls, [], "a malformed capability never raises the human dialog");
  assert.equal(persistedRawAnswers(root).length, 0);
});

withFixture("ask: state↔capability drift fails closed before any human prompt", async (root, ask) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];

  // Top-level stage cursor no longer matches the capability binding.
  overwriteStateFile(root, (raw) => {
    raw.stage_cursor = "code_review";
  });
  let response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  let details = response.details as { ok?: boolean; error?: string };
  assert.equal(details.ok, false);
  assert.match(details.error ?? "", /capability stage cursor does not match the workflow state/);

  // A capability binding that names another run is rejected without
  // changing the canonical run identity on disk.
  overwriteStateFile(root, (raw) => {
    raw.stage_cursor = "implementation";
    const cap = raw.dispatch_capability as Record<string, unknown>;
    (cap.issued_for as Record<string, unknown>).run_key = "some-other-run";
  });
  response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  details = response.details as { ok?: boolean; error?: string };
  assert.equal(details.ok, false);
  assert.match(details.error ?? "", /capability binding mismatch/);

  // A branch switch underneath the run makes the state stale.
  overwriteStateFile(root, (raw) => {
    const cap = raw.dispatch_capability as Record<string, unknown>;
    (cap.issued_for as Record<string, unknown>).run_key = RUN_ID;
    raw.branch = "feat/elsewhere";
  });
  response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  details = response.details as { ok?: boolean; error?: string };
  assert.equal(details.ok, false);
  assert.match(details.error ?? "", /stale for the active branch/);
  assert.deepEqual(calls, [], "drifted state never raises the human dialog");
  assert.equal(persistedAnswers(root).length, 0);
});

withFixture("ask: policy drift between the persisted state and the declaring profile fails closed", async (root, ask) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];
  // Sanity: the fixture persists the profile-derived checkpoint policy.
  assert.ok(readStateFile(root).checkpoint_policy, "the normalized fixture persists the profile checkpoint policy");
  overwriteStateFile(root, (raw) => {
    const policy = raw.checkpoint_policy as Record<string, unknown>;
    const rules = policy.rules as Record<string, Record<string, unknown>>;
    rules.approve_implementation.allowed_decisions = ["proceed", "reject", "ship_it"];
  });
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["ship_it"]), calls));
  const details = response.details as { ok?: boolean };
  assert.equal(details.ok, false);
  assert.deepEqual(calls, []);
  assert.equal(persistedRawAnswers(root).length, 0, "policy rejection leaves the raw canonical answer ledger untouched");
});

withFixture("ask: exact replay of a live identical answer re-issues the same proof without minting", async (root, ask) => {
  const issued = writeAskFixture(root);
  seedLiveAnswer(root, "terminal/main/implementation/approve_implementation/1", "proceed");
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => ({
    kind: "submit",
    results: [{
      ...canonicalItem(questions[0]!),
      selectedOptions: ["proceed"],
      customInputImages: [],
      noteImages: [],
    }],
  }), []));
  const details = response.details as { ok?: boolean; decision?: string; error?: string; actor_provenance?: { proof?: { answer_id?: string } } };
  assert.equal(details.ok, true, details.error);
  assert.equal(details.decision, "proceed");
  assert.equal(details.actor_provenance?.proof?.answer_id, "terminal/main/implementation/approve_implementation/1", "the existing live proof identity is reused");
  const answers = persistedAnswers(root);
  assert.equal(answers.length, 1, "no second live answer is minted");
  assert.equal(answers[0]?.consumed_at, undefined, "the reused proof stays live for the follow-up workflow_checkpoint call");
});

withFixture("ask: a conflicting selection supersedes the stale live proof and mints exactly one fresh answer", async (root, ask) => {
  const issued = writeAskFixture(root);
  seedLiveAnswer(root, "terminal/main/implementation/approve_implementation/1", "proceed");
  // The existing proof belongs to the prior capability epoch. A current ask
  // must therefore open the host dialog and let the conflicting selection
  // supersede that stale proof.
  const current = rotateAskCapability(root, issued);
  const response = await ask("t", askAuth(current), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["reject"]), []));
  const details = response.details as { ok?: boolean; decision?: string; error?: string; actor_provenance?: { proof?: { answer_id?: string } } };
  assert.equal(details.ok, true, details.error);
  assert.equal(details.decision, "reject");
  assert.notEqual(details.actor_provenance?.proof?.answer_id, "terminal/main/implementation/approve_implementation/1");
  const answers = persistedAnswers(root);
  assert.equal(answers.length, 2);
  const unconsumed = answers.filter((answer) => !answer.consumed_at);
  assert.equal(unconsumed.length, 1, "at most one unconsumed answer exists per unresolved checkpoint");
  assert.equal(unconsumed[0]?.decision, "reject");
  assert.ok(answers.find((answer) => answer.answer_id === "terminal/main/implementation/approve_implementation/1")?.consumed_at, "the superseded proof is consumed");
});

withFixture("ask: pre-existing duplicate live proofs collapse to one when the identical answer is replayed", async (root, ask) => {
  const issued = writeAskFixture(root);
  seedLiveAnswers(root, [
    { answerId: "terminal/main/implementation/approve_implementation/1", decision: "proceed" },
    { answerId: "terminal/main/implementation/approve_implementation/2", decision: "reject" },
  ]);
  assert.equal(persistedAnswers(root).length, 2, "scenario setup wrote two live proofs");
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), []));
  const details = response.details as { ok?: boolean; error?: string; actor_provenance?: { proof?: { answer_id?: string } } };
  assert.equal(details.ok, true, details.error);
  assert.equal(details.actor_provenance?.proof?.answer_id, "terminal/main/implementation/approve_implementation/1", "the identical live proof is reused");
  const answers = persistedAnswers(root);
  const unconsumed = answers.filter((answer) => !answer.consumed_at);
  assert.equal(unconsumed.length, 1, "the duplicate sibling proof is superseded");
  assert.equal(unconsumed[0]?.answer_id, "terminal/main/implementation/approve_implementation/1");
  assert.ok(answers.find((answer) => answer.answer_id === "terminal/main/implementation/approve_implementation/2")?.consumed_at);
});

withFixture("ask: malformed host results record nothing", async (root, ask) => {
  const issued = writeAskFixture(root);
  const cases: Array<[string, (question: DialogQuestion) => unknown]> = [
    ["canceled dialog", () => undefined],
    ["chat redirect", () => ({ kind: "chat" })],
    ["zero answer items", () => ({ kind: "submit", results: [] })],
    ["extra answer items", (question) => ({
      kind: "submit",
      results: [
        { ...canonicalItem(question), selectedOptions: ["proceed"] },
        { ...canonicalItem(question), selectedOptions: ["reject"] },
      ],
    })],
    ["wrong question id", (question) => submit(question, ["proceed"], { id: "checkpoint:other" })],
    ["missing question echo", (question) => withoutEcho(question, "question")],
    ["mismatched question echo", (question) => submit(question, ["proceed"], { question: "a different question" })],
    ["missing options echo", (question) => withoutEcho(question, "options")],
    ["mismatched options echo", (question) => submit(question, ["proceed"], { options: ["proceed", "reject", "ship_it"] })],
    ["reordered options echo", (question) => submit(question, ["proceed"], { options: ["reject", "proceed"] })],
    ["missing multi flag", (question) => withoutEcho(question, "multi")],
    ["multi answer", (question) => submit(question, ["proceed"], { multi: true })],
    ["two selections", (question) => submit(question, ["proceed", "reject"])],
    ["non-string selection", (question) => ({ kind: "submit", results: [{ ...canonicalItem(question), selectedOptions: [7] }] })],
    ["timeout", (question) => submit(question, ["proceed"], { timedOut: true })],
    ["non-boolean timeout", (question) => submit(question, ["proceed"], { timedOut: "yes" })],
    ["custom input", (question) => submit(question, [], { customInput: "make it so" })],
    ["non-string custom input", (question) => submit(question, [], { customInput: 42 })],
    ["non-string note", (question) => submit(question, ["proceed"], { note: 9 })],
    ["custom input images", (question) => ({ kind: "submit", results: [{ ...canonicalItem(question), selectedOptions: ["proceed"], customInputImages: [{ type: "image" }] }] })],
    ["note images", (question) => ({ kind: "submit", results: [{ ...canonicalItem(question), selectedOptions: ["proceed"], noteImages: [{ type: "image" }] }] })],
    ["malformed image metadata", (question) => ({ kind: "submit", results: [{ ...canonicalItem(question), selectedOptions: ["proceed"], noteImages: "image" }] })],
    ["unknown metadata", (question) => ({ kind: "submit", results: [{ ...canonicalItem(question), selectedOptions: ["proceed"], injected: true }] })],
    ["unknown option", (question) => submit(question, ["ship it"])],
  ];
  for (const [label, script] of cases) {
    const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => script(questions[0]!), []));
    const details = response.details as { ok?: boolean; code?: string; error?: string };
    assert.equal(details.ok, false, `${label} must not authorize`);
    assert.equal(details.code, "WORKFLOW_CHECKPOINT_DECLINED", `${label}: ${details.error}`);
    assert.equal(persistedAnswers(root).length, 0, `${label} must not ingest an answer`);
  }
});

withFixture("ask: headless sessions keep failing closed without an interactive surface", async (root, ask) => {
  const issued = writeAskFixture(root);
  const response = await ask("t", askAuth(issued), undefined, undefined, { cwd: root, hasUI: true });
  const details = response.details as { ok?: boolean; code?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_UNAVAILABLE");
  assert.equal(persistedAnswers(root).length, 0);
});

withFixture("ask: loop_iteration is enforced before any dialog and propagates into the payload and ledger", async (root, ask, tools) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];

  // A mismatched iteration is a binding mismatch and never raises the dialog.
  const mismatched = await ask("t", { ...askAuth(issued), loop_iteration: 2 }, undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const mismatchedDetails = mismatched.details as { ok?: boolean; code?: string; error?: string };
  assert.equal(mismatchedDetails.ok, false);
  assert.equal(mismatchedDetails.code, "WORKFLOW_CHECKPOINT_ASK_REJECTED");
  assert.match(mismatchedDetails.error ?? "", /capability binding mismatch/);
  assert.deepEqual(calls, [], "a mismatched loop iteration never raises the human dialog");
  assert.equal(persistedAnswers(root).length, 0);

  // The matching handoff iteration commits and is echoed verbatim.
  const first = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const firstDetails = first.details as { ok?: boolean; error?: string; loop_iteration?: number; actor_provenance?: { ref: string; proof: { answer_id: string; nonce: string; channel: string; reference: string; binding: string } } };
  assert.equal(firstDetails.ok, true, firstDetails.error);
  assert.equal(firstDetails.loop_iteration, 1, "the validated handoff iteration is echoed for the verbatim follow-up call");

  // The follow-up workflow_checkpoint records under the same loop scope.
  const checkpointTool = tools.get("workflow_checkpoint");
  assert.ok(checkpointTool, "workflow_checkpoint must be registered");
  const checkpoint = checkpointTool.execute as unknown as AskExecute;
  const recorded = await checkpoint("t", {
    ...checkpointEnvelope(issued),
    actor_provenance: firstDetails.actor_provenance,
    decision: "proceed",
    rationale: "approved with the loop-scoped binding",
  }, undefined, undefined, trustedToolContext(root));
  assert.equal((recorded.details as { ok?: boolean; error?: string }).ok, true, (recorded.details as { error?: string }).error);
  const decisions = readStateFile(root).typed_checkpoint_decisions ?? [];
  assert.equal(decisions.length, 1);
  assert.equal((decisions[0] as unknown as { loop_iteration?: number }).loop_iteration, 1, "the ledger decision carries the handoff loop iteration");

  // A re-ask with the same iteration short-circuits without a dialog.
  const callsBefore = calls.length;
  const replay = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const replayDetails = replay.details as { ok?: boolean; already_recorded?: boolean };
  assert.equal(replayDetails.ok, true);
  assert.equal(replayDetails.already_recorded, true);
  assert.equal(calls.length, callsBefore, "the resolved checkpoint never re-raises the dialog");
});

withFixture("ask: a live escalation proof is superseded across channels and can never authorize the follow-up workflow_checkpoint", async (root, ask, tools) => {
  const issued = writeAskFixture(root);
  // Another trusted surface (escalation) minted a live proof for a different decision.
  const resolved = canonicalTarget(root);
  assert.ok(resolved.state);
  const escalation = recordTrustedCheckpointAnswer(resolved.state, {
    answer_id: "escalation/main/implementation/approve_implementation/1",
    channel: "escalation",
    reference: "escalation-answer/main/implementation/approve_implementation/1",
    stage_id: "implementation",
    checkpoint_id: "approve_implementation",
    decision: "proceed",
  });
  writeCanonicalState(root, escalation.state);
  const staleProof = escalation.proof;

  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["reject"]), []));
  const details = response.details as { ok?: boolean; decision?: string; error?: string; actor_provenance?: { ref: string; proof: { answer_id: string; nonce: string; channel: string; reference: string; binding: string } } };
  assert.equal(details.ok, true, details.error);
  assert.equal(details.decision, "reject");
  const answers = persistedAnswers(root);
  assert.equal(answers.length, 2);
  const unconsumed = answers.filter((answer) => !answer.consumed_at);
  assert.equal(unconsumed.length, 1, "exactly one live answer survives across both channels");
  assert.equal(unconsumed[0]?.channel, "terminal");
  assert.equal(unconsumed[0]?.answer_id, details.actor_provenance?.proof?.answer_id);
  assert.ok(answers.find((answer) => answer.answer_id === staleProof.answer_id)?.consumed_at, "the escalation proof is superseded");

  // The superseded escalation proof can never authorize the follow-up decision.
  const checkpointTool = tools.get("workflow_checkpoint");
  assert.ok(checkpointTool, "workflow_checkpoint must be registered");
  const checkpoint = checkpointTool.execute as unknown as AskExecute;
  const superseded = await checkpoint("t", {
    ...checkpointEnvelope(issued),
    actor_provenance: { kind: "user", ref: staleProof.reference, proof: staleProof },
    decision: "proceed",
    rationale: "stale escalation replay",
  }, undefined, undefined, trustedToolContext(root));
  const supersededDetails = superseded.details as { ok?: boolean; error?: string };
  assert.equal(supersededDetails.ok, false, "a superseded proof must not authorize");
  assert.match(supersededDetails.error ?? "", /superseded by a newer answer/);

  const fresh = await checkpoint("t", {
    ...checkpointEnvelope(issued),
    actor_provenance: { kind: "user", ref: details.actor_provenance!.ref, proof: details.actor_provenance!.proof },
    decision: "reject",
    rationale: "terminal answer",
  }, undefined, undefined, trustedToolContext(root));
  assert.equal((fresh.details as { ok?: boolean; error?: string }).ok, true, (fresh.details as { error?: string }).error);
});

withFixture("ask: exact decision replay stays idempotent and a mismatched replay of the consumed proof is rejected", async (root, ask, tools) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];
  const first = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const firstDetails = first.details as { ok?: boolean; actor_provenance?: unknown; error?: string };
  assert.equal(firstDetails.ok, true, firstDetails.error);

  const checkpointTool = tools.get("workflow_checkpoint");
  assert.ok(checkpointTool, "workflow_checkpoint must be registered");
  const checkpoint = checkpointTool.execute as unknown as AskExecute;
  const envelope = checkpointEnvelope(issued);
  const mismatched = await checkpoint("t", { ...envelope, actor_provenance: firstDetails.actor_provenance, decision: "reject", rationale: "mismatched replay" }, undefined, undefined, trustedToolContext(root));
  const mismatchedDetails = mismatched.details as { ok?: boolean; error?: string };
  assert.equal(mismatchedDetails.ok, false, "a consumed/used proof must not authorize a different decision");
  assert.match(mismatchedDetails.error ?? "", /stale or mismatched/);

  const exact = await checkpoint("t", { ...envelope, actor_provenance: firstDetails.actor_provenance, decision: "proceed", rationale: "exact idempotent replay" }, undefined, undefined, trustedToolContext(root));
  assert.equal((exact.details as { ok?: boolean; error?: string }).ok, true, (exact.details as { error?: string }).error);

  // Re-ask after the decision is recorded: no new dialog, idempotent short-circuit.
  const callsBefore = calls.length;
  const replay = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const replayDetails = replay.details as { ok?: boolean; already_recorded?: boolean; decision?: string; error?: string };
  assert.equal(replayDetails.ok, true, replayDetails.error);
  assert.equal(replayDetails.already_recorded, true);
  assert.equal(replayDetails.decision, "proceed");
  assert.equal(calls.length, callsBefore, "the resolved checkpoint never re-raises the dialog");
  assert.equal((readStateFile(root).typed_checkpoint_decisions ?? []).length, 1, "the ledger keeps exactly one decision");
});

withFixture("ask: pre-dispatch approval cannot authorize post-production retry", async (root, ask, tools) => {
  const issued = writeAskFixture(root, RECEIPT_WORKFLOW);
  const workflow = issued.state.issued_for!.workflow;
  const receiptProfile = loadProfile(workflow);
  assert.ok(receiptProfile, `${workflow} profile must be available for dispatch continuity`);
  const calls: DialogCall[] = [];
  const first = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const firstDetails = first.details as { ok?: boolean; actor_provenance?: Record<string, unknown>; error?: string };
  assert.equal(firstDetails.ok, true, firstDetails.error);
  const firstActor = firstDetails.actor_provenance;
  assert.ok(firstActor, "the pre-dispatch answer must return durable provenance");
  if (
    !firstActor
    || !("proof" in firstActor)
    || typeof firstActor.proof !== "object"
    || firstActor.proof === null
    || !("answer_id" in firstActor.proof)
    || typeof firstActor.proof.answer_id !== "string"
  ) throw new Error("the pre-dispatch answer proof is malformed");
  const oldAnswerId = firstActor.proof.answer_id;

  const checkpointTool = tools.get("workflow_checkpoint");
  assert.ok(checkpointTool, "workflow_checkpoint must be registered");
  const checkpoint = checkpointTool.execute as unknown as AskExecute;
  const envelope = checkpointEnvelope(issued);

  const dispatchAuth = {
    run_id: RUN_ID,
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: RUN_ID,
    branch: "main",
    workflow,
    profile_hash: profileHash(receiptProfile),
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    role: "developer-kotlin",
    agent: "developer-kotlin",
    origin_session_id: SESSION_ID,
  };
  const authorized = authorizeDispatch(root, dispatchAuth);
  assert.equal(authorized.ok, true, authorized.ok ? "dispatch authorized" : authorized.error);
  if (!authorized.ok || !authorized.record) throw new Error(authorized.ok ? "dispatch authorization produced no record" : authorized.error);


  const firstWorker = await publishAssignedWorkerOutput(root, issued, tools, {
    id: authorized.record.id,
    role: authorized.record.role,
    agent: authorized.record.agent,
    task_id: authorized.record.work_identity?.task_id,
    tool_call_id: authorized.record.tool_call_id,
  }, {
    files_touched: ["checkpoint-ask-hardening.test.ts"],
    ready: true,
    validation_run: true,
    validation_evidence: "pre-dispatch approval first worker attempt",
  });
  await terminalAssignedWorker(root, firstWorker, true);
  const stalePreProduction = await checkpoint("t", {
    ...envelope,
    actor_provenance: firstActor,
    decision: "proceed",
    rationale: "pre-dispatch approval must not authorize post-production work",
  }, undefined, undefined, trustedToolContext(root));
  const staleDetails = stalePreProduction.details as { ok?: boolean; error?: string };
  assert.equal(staleDetails.ok, false, "pre-dispatch approval must not authorize a real worker result");
  assert.match(staleDetails.error ?? "", /stale|mismatch|production|checkpoint/i);
  const retryDispatchAuth = {
    ...dispatchAuth,
    tool_call_id: "checkpoint-ask-retry",
    origin_session_id: SESSION_ID,
  };
  const retried = authorizeDispatch(root, { ...retryDispatchAuth, retry_of: authorized.record.id });
  assert.equal(retried.ok, true, retried.ok ? "retry authorized" : retried.error);
  if (!retried.ok || !retried.record) throw new Error(retried.ok ? "retry authorization produced no record" : retried.error);
  const retryWorker = await publishAssignedWorkerOutput(root, issued, tools, {
    id: retried.record.id,
    role: retried.record.role,
    agent: retried.record.agent,
    task_id: retried.record.work_identity?.task_id,
    tool_call_id: retried.record.tool_call_id,
  }, {
    files_touched: ["checkpoint-ask-hardening.test.ts"],
    ready: true,
    validation_run: true,
    validation_evidence: "pre-dispatch approval continuity test",
  });


  // Publication and terminal worker lifecycle remain separate facts: the
  // retry receipt is accepted, but planning consent is not post-production
  // checkpoint approval.
  await terminalAssignedWorker(root, retryWorker, false);
  const advanced = advanceCursor(root, {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: RUN_ID,
    branch: "main",
    workflow,
    profile_hash: profileHash(receiptProfile),
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    evidence: "pre-dispatch approval must not advance the completed worker",
  }, { runId: RUN_ID });
  assert.equal(advanced.ok, false, "pre-dispatch approval must not authorize the real stage advance");
  assert.match(advanced.error ?? "", /checkpoint|approval|decision|receipt/i);
  assert.equal(readStateFile(root).stage_cursor, "implementation", "the failed advance keeps the stage in its current checkpoint window");

  const state = readStateFile(root);
  assert.equal((state.typed_checkpoint_decisions ?? []).length, 0, "stale planning consent never appends a post-production decision");
  assert.ok((state.trusted_checkpoint_answers ?? []).some((answer) => answer.answer_id === oldAnswerId), "the original answer remains in the audit ledger");
}, { workerSubmission: true });

withFixture("ask: finalized real-attempt proof survives failed dispatch retry", async (root, ask, tools) => {
  const issued = await writeAskFixtureWithDiscovery(root, tools);
  const checkpointTool = tools.get("workflow_checkpoint");
  assert.ok(checkpointTool, "workflow_checkpoint must be registered");
  const checkpoint = checkpointTool.execute as unknown as AskExecute;
  const dispatchAuth = {
    run_id: RUN_ID,
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: RUN_ID,
    branch: "main",
    workflow: "lightweight",
    profile_hash: profileHash(loadProfile("lightweight")!),
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    role: "developer-kotlin",
    agent: "developer-kotlin",
    origin_session_id: SESSION_ID,
  };
  const authorized = authorizeDispatch(root, dispatchAuth);
  assert.equal(authorized.ok, true, authorized.ok ? "dispatch authorized" : authorized.error);
  if (!authorized.ok || !authorized.record) throw new Error(authorized.ok ? "dispatch authorization produced no record" : authorized.error);

  const firstWorker = await publishAssignedWorkerOutput(root, issued, tools, {
    id: authorized.record.id,
    role: authorized.record.role,
    agent: authorized.record.agent,
    task_id: authorized.record.work_identity?.task_id,
    tool_call_id: authorized.record.tool_call_id,
  }, {
    files_touched: ["checkpoint-ask-hardening.test.ts"],
    ready: true,
    validation_run: true,
    validation_evidence: "real-attempt proof first worker output",
  });
  const calls: DialogCall[] = [];
  const answered = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const answeredDetails = answered.details as { ok?: boolean; actor_provenance?: Record<string, unknown>; error?: string };
  assert.equal(answeredDetails.ok, true, answeredDetails.error);
  assert.ok(answeredDetails.actor_provenance, "the real-attempt answer must return durable provenance");
  const realAnswer = readStateFile(root).trusted_checkpoint_answers?.find((answer) =>
    answer.answer_id === (answeredDetails.actor_provenance?.proof as { answer_id?: string } | undefined)?.answer_id);
  assert.ok(realAnswer?.work_identity_witness, "a real singular-root answer must retain the engine-minted identity witness");
  const recorded = await checkpoint("t", {
    ...checkpointEnvelope(issued),
    actor_provenance: answeredDetails.actor_provenance,
    decision: "proceed",
    rationale: "approval while the first worker identity was active",
  }, undefined, undefined, trustedToolContext(root));
  assert.equal((recorded.details as { ok?: boolean; error?: string }).ok, true, (recorded.details as { error?: string }).error);

  await terminalAssignedWorker(root, firstWorker, true);
  const retryIssued = await beginAskStage(root, tools);
  const retryDispatchAuth = {
    ...dispatchAuth,
    token: retryIssued.dispatch_token,
    capability_id: retryIssued.capability_id,
    profile_hash: retryIssued.state.issued_for!.profile_hash,
    stage_cursor: retryIssued.state.issued_for!.stage_cursor,
    cursor_epoch: retryIssued.state.issued_for!.cursor_epoch,
    loop_iteration: retryIssued.state.issued_for!.loop_iteration,
  };
  const retry = authorizeDispatch(root, { ...retryDispatchAuth, retry_of: authorized.record.id, tool_call_id: "checkpoint-ask-real-retry" });
  assert.equal(retry.ok, true, retry.ok ? "retry authorized" : retry.error);
  if (!retry.ok || !retry.record) throw new Error(retry.ok ? "retry authorization produced no record" : retry.error);
  const retryWorker = await publishAssignedWorkerOutput(root, retryIssued, tools, {
    id: retry.record.id,
    role: retry.record.role,
    agent: retry.record.agent,
    task_id: retry.record.work_identity?.task_id,
    tool_call_id: retry.record.tool_call_id,
  }, {
    files_touched: ["checkpoint-ask-hardening.test.ts"],
    ready: true,
    validation_run: true,
    validation_evidence: "real-attempt proof retry output",
  });
  await terminalAssignedWorker(root, retryWorker, false);

  const replay = await checkpoint("t", {
    ...checkpointEnvelope(retryIssued),
    actor_provenance: answeredDetails.actor_provenance,
    decision: "proceed",
    rationale: "approval while the first worker identity was active",
  }, undefined, undefined, trustedToolContext(root));
  assert.equal((replay.details as { ok?: boolean; error?: string }).ok, true, (replay.details as { error?: string }).error);
  const historicalState = readStateFile(root);
  const historicalDecision = historicalState.typed_checkpoint_decisions?.[0];
  assert.ok(historicalDecision, "the retry must retain the finalized decision");
  const profile = loadProfile("lightweight");
  const stage = profile?.stages.find((candidate) => candidate.id === "implementation");
  assert.ok(profile && stage && profile.checkpoint_policy, "lightweight checkpoint declaration must exist");
  if (!historicalDecision || !profile || !stage || !profile.checkpoint_policy) throw new Error("historical fixture declaration is incomplete");
  const declaration = resolveCheckpointDeclaration(stage, profile.checkpoint_policy, historicalState, "authorize");
  assert.ok(declaration.ok && declaration.declaration, "historical lookup declaration must resolve");
  if (!declaration.ok || !declaration.declaration) throw new Error(declaration.error);
  const historical = findHistoricalCheckpointDecision(historicalState, declaration.declaration, {
    decision_key: checkpointDecisionKey(historicalDecision),
  });
  assert.equal(historical.ok, true, historical.ok ? "historical exact lookup" : historical.error);
  if (!historical.ok) throw new Error(historical.error);
  assert.equal(historical.decision_key, checkpointDecisionKey(historicalDecision));

  const callsBefore = calls.length;
  const fresh = await ask("t", askAuth(retryIssued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const freshDetails = fresh.details as { ok?: boolean; already_recorded?: boolean; error?: string };
  assert.equal(freshDetails.ok, true, freshDetails.error);
  assert.equal(freshDetails.already_recorded, true);
  assert.equal(calls.length, callsBefore);
}, { workerSubmission: true });
withFixture("ask: a forged real identity witness cannot authorize the finalized decision", async (root, ask, tools) => {
  const issued = writeAskFixture(root);
  const dispatchAuth = {
    run_id: RUN_ID,
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: RUN_ID,
    branch: "main",
    workflow: "lightweight",
    profile_hash: profileHash(loadProfile("lightweight")!),
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    role: "developer-kotlin",
    agent: "developer-kotlin",
  };
  const authorized = authorizeDispatch(root, dispatchAuth);
  assert.equal(authorized.ok, true, authorized.ok ? "dispatch authorized" : authorized.error);
  if (!authorized.ok || !authorized.record) throw new Error(authorized.ok ? "dispatch authorization produced no record" : authorized.error);

  const answered = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), []));
  const details = answered.details as { ok?: boolean; actor_provenance?: Record<string, unknown>; error?: string };
  assert.equal(details.ok, true, details.error);
  assert.ok(details.actor_provenance, "the real answer must return durable provenance");
  const proof = details.actor_provenance?.proof as { answer_id?: string } | undefined;
  assert.ok(proof?.answer_id, "the real answer proof must identify its durable answer");

  overwriteStateFile(root, (raw) => {
    const answers = raw.trusted_checkpoint_answers as Array<Record<string, unknown>>;
    const answer = answers.find((candidate) => candidate.answer_id === proof?.answer_id);
    assert.ok(answer?.work_identity_witness, "the answer must carry its engine witness before the forgery");
    const witness = answer!.work_identity_witness as Record<string, unknown>;
    witness.worker_id = "forged-worker";
  });

  const checkpointTool = tools.get("workflow_checkpoint");
  assert.ok(checkpointTool, "workflow_checkpoint must be registered");
  const checkpoint = checkpointTool.execute as unknown as AskExecute;
  const response = await checkpoint("t", {
    ...checkpointEnvelope(issued),
    actor_provenance: details.actor_provenance,
    decision: "proceed",
    rationale: "forged witness must fail closed",
  }, undefined, undefined, trustedToolContext(root));
  const result = response.details as { ok?: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /stale or mismatched|binding/);
});

withFixture("ask: an impossible consilium witness is never accepted as a current root", async (root, ask, tools) => {
  const issued = writeAskFixture(root);
  const dispatchAuth = {
    run_id: RUN_ID,
    token: issued.dispatch_token,
    capability_id: issued.capability_id,
    run_key: RUN_ID,
    branch: "main",
    workflow: "lightweight",
    profile_hash: profileHash(loadProfile("lightweight")!),
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    role: "developer-kotlin",
    agent: "developer-kotlin",
  };
  const authorized = authorizeDispatch(root, dispatchAuth);
  assert.equal(authorized.ok, true, authorized.ok ? "dispatch authorized" : authorized.error);
  if (!authorized.ok) return;
  const answered = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), []));
  const details = answered.details as { ok?: boolean; actor_provenance?: Record<string, unknown>; error?: string };
  assert.equal(details.ok, true, details.error);
  assert.ok(details.actor_provenance, "the real answer must return durable provenance");

  overwriteStateFile(root, (raw) => {
    const capability = raw.dispatch_capability as Record<string, unknown>;
    capability.kind = "consilium";
    capability.expected_count = 1;
    delete capability.work_identity;
    delete raw.work_identity;
    delete raw.pending;
    delete raw.completion_envelope;
  });

  const checkpointTool = tools.get("workflow_checkpoint");
  assert.ok(checkpointTool, "workflow_checkpoint must be registered");
  const checkpoint = checkpointTool.execute as unknown as AskExecute;
  const response = await checkpoint("t", {
    ...checkpointEnvelope(issued),
    actor_provenance: details.actor_provenance,
    decision: "proceed",
    rationale: "consilium cannot mint a root witness",
  }, undefined, undefined, trustedToolContext(root));
  const result = response.details as { ok?: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /stale or mismatched|binding|witness/);
});
