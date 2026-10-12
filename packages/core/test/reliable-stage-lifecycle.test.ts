import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordScenarioEvent, scenarioTest } from "./reliable-stage-trace.js";
import { z } from "zod";
import {
  admitCtoLeadAndWorker as sharedAdmitCtoLeadAndWorker,
  admitOrdinaryWorker as sharedAdmitOrdinaryWorker,
  BRANCH as SHARED_BRANCH,
  CLASSIFICATION as SHARED_CLASSIFICATION,
  ctoHarness as sharedCtoHarness,
  ctoIngress as sharedCtoIngress,
  advanceCtoStage as sharedAdvanceCtoStage,
  details as sharedDetails,
  askCtoCheckpoint as sharedAskCtoCheckpoint,
  emit as sharedEmit,
  ordinaryHarness as sharedOrdinaryHarness,
  ordinaryIngress as sharedOrdinaryIngress,
  requireTool as sharedRequireTool,
  RELIABLE_PROFILE,
  submission as sharedSubmission,
  terminalWorker as sharedTerminalWorker,
  type Harness as SharedHarness,
  type Handoff as SharedHandoff,
  type WorkerFixture as SharedWorkerFixture,
} from "./reliable-stage-execution-fixture.js";

import {
  appendWave,
  buildCtoSliceMarker,
  createWorkflowSessionController,
  isCtoRunTerminal,
  readCtoState,
  readRunControl,
  readRunState,
  registerTeamWorkflow,
  registerWorkflowCommands,
  registerWorkflowTools,
  type CtoState,
  type Profile,
  type TrustedExecutionContext,
  type WorkflowSessionController,
} from "../src/index.js";
import { evaluateNativeStageReadiness } from "../src/cto/native-stage.js";
import { finishWave, isCtoResidentWaiting } from "../src/cto/state.js";
import { loadProfile, registerWorkflowProfiles } from "../src/engine/profile.js";

const BRANCH = "reliable-stage-lifecycle";
const CLASSIFICATION = {
  type: "FEATURE" as const,
  complexity: "QUICK" as const,
  confidence: "HIGH" as const,
  autonomous: false,
  workflow: "reliable-lifecycle-checkpoint",
};
const CTO_CLASSIFICATION = {
  type: "FEATURE" as const,
  complexity: "QUICK" as const,
  confidence: "HIGH" as const,
  autonomous: false,
};

const SHIPPED_LIGHTWEIGHT_PROFILE = loadProfile("lightweight");
if (!SHIPPED_LIGHTWEIGHT_PROFILE?.checkpoint_policy) throw new Error("lightweight checkpoint policy is required by reliable lifecycle acceptance");
const checkpointPolicy = SHIPPED_LIGHTWEIGHT_PROFILE.checkpoint_policy;

const CHECKPOINT_PROFILE: Profile = {
  name: "reliable-lifecycle-checkpoint",
  title: "Reliable lifecycle checkpoint",
  description: "One producer stage with a real before-advance checkpoint.",
  match: { type: ["FEATURE"], complexity: ["QUICK"] },
  checkpoint_policy: checkpointPolicy,
  stages: [
    {
      id: "implementation",
      title: "Implementation",
      type: "single",
      role: "dev",
      produces: "implementation",
      checkpoint: "approve_implementation",
    },
  ],
};

const NATIVE_CHECKPOINT_PROFILE: Profile = {
  name: "lightweight",
  title: "Reliable native checkpoint",
  description: "Two inline native stages used to prove persisted checkpoint reuse.",
  match: { type: ["FEATURE"], complexity: ["QUICK"] },
  checkpoint_policy: checkpointPolicy,
  stages: [
    {
      id: "native_checkpoint",
      title: "Native checkpoint",
      type: "single",
      role: "dev",
      produces: "implementation",
      checkpoint: "approve_implementation",
    },
    {
      id: "native_after_checkpoint",
      title: "Native after checkpoint",
      type: "orchestrator",
      produces: [],
    },
  ],
};

const R20_RESIDENT_PROFILE: Profile = {
  name: "lightweight",
  title: "Reliable resident one-worker stage",
  description: "One native producer stage for resident wave lifecycle acceptance.",
  match: { type: ["FEATURE"], complexity: ["QUICK"] },
  stages: [{
    id: "implementation",
    title: "Implementation",
    type: "single",
    role: "dev",
    produces: "implementation",
  }],
};

interface RegisteredTool {
  name: string;
  execute: (...args: unknown[]) => Promise<{ details: unknown }>;
}

interface RegisteredCommand {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface SessionManager {
  getCwd: () => string;
  getSessionId: () => string;
  getSessionFile: () => string;
  getHeader: () => { id: string; cwd: string; parentSession?: string };
}

type HostContext = Record<string, unknown> & {
  cwd: string;
  mode: "tui" | "print";
  hasUI: boolean;
  session_id: string;
  sessionFile: string;
  sessionManager: SessionManager;
};

type Handler = (...args: unknown[]) => unknown;
type UiTrace = { selectCalls: number };

type Harness = {
  root: string;
  context: HostContext;
  controller: WorkflowSessionController;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, RegisteredCommand>;
  handlers: Map<string, Handler[]>;
  messages: string[];
  route: "O" | "C";
  profileName: Profile["name"];
  emit(name: string, ...args: unknown[]): Promise<unknown[]>;
  dispose(): void;
  close(): Promise<void>;
};

type Handoff = Record<string, unknown> & {
  capability_id: string;
  dispatch_token: string;
  advance_token: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  loop_iteration: number;
  expected_roster: Array<{ role: string; agent: string }>;
  dispatch_markers: Array<{ role: string; agent: string; marker: string }>;
};

type Worker = {
  callId: string;
  input: { agent: string; task: string };
  context: HostContext;
  file: string;
  lifecycleId: string;
};

function details(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function manager(root: string, id: string, file: string, parentSession?: string): SessionManager {
  const header = { id, cwd: root, ...(parentSession ? { parentSession } : {}) };
  return {
    getCwd: () => root,
    getSessionId: () => id,
    getSessionFile: () => file,
    getHeader: () => header,
  };
}

function hostContext(root: string, id: string, fileName = `${id}.jsonl`, route: "O" | "C" = "O", uiTrace?: UiTrace): HostContext {
  const file = join(root, fileName);
  const sessionManager = manager(root, id, file);
  return {
    cwd: root,
    mode: "tui",
    hasUI: true,
    session_id: id,
    sessionFile: file,
    sessionManager,
    ui: {
      select: async () => {
        if (uiTrace) uiTrace.selectCalls += 1;
        recordScenarioEvent({ kind: "checkpoint_accepted", route, phase: "ui_select", outcome: "ACCEPTED" });
        return "proceed";
      },
      confirm: async () => true,
      notify() {},
    },
  };
}

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", BRANCH], { stdio: "ignore" });
  return root;
}

function writeCtoRegistry(root: string, profile: string, roster: string[] = ["dev"], lead = "team-lead"): void {
  mkdirSync(join(root, ".omp"), { recursive: true });
  writeFileSync(join(root, ".omp", "team.config.json"), `${JSON.stringify({ roles: { dev: "developer", "team-lead": "team-lead" } })}\n`);
  writeFileSync(join(root, ".omp", "teams.json"), `${JSON.stringify([{
    id: "team-a",
    name: "Team A",
    scope: ["backend"],
    profile,
    lead,
    roster,
  }])}\n`);
}


function registerHarness(
  root: string,
  context: HostContext,
  controller: WorkflowSessionController,
  options: { cto: boolean; profile?: Profile; profileName: Profile["name"] },
): Harness {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const messages: string[] = [];
  const route = options.cto ? "C" : "O";
  const on = (name: string, handler: Handler): void => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  };
  const pi = {
    zod: { z },
    setLabel() {},
    on,
    events: { on },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
      recordScenarioEvent({ kind: "tool_registered", route, tool: tool.name, phase: "registration", outcome: "COMPLETED" });
    },
    registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    sendUserMessage(message: string) { messages.push(message); },
  };
  const actorResolver = (ctx: unknown, cwd: string, runId: string | undefined) => {
    if (ctx !== context) return undefined;
    if (options.cto) {
      const scope = controller.activeCtoClaim();
      if (scope && (!runId || runId === scope.run_id)) {
        return { kind: "authenticated-interactive-host-cto" as const, run_id: scope.run_id, ownership_epoch: scope.ownership_epoch };
      }
      return { kind: "authenticated-interactive-host-no-run" as const };
    }
    if (runId && controller.activeClaimRunId() === runId) {
      return { actor: "orchestrator" as const, artifactsDir: join(cwd, ".work-state", "runs", runId, "artifacts") };
    }
    return { kind: "authenticated-interactive-host-no-run" as const };
  };
  const profile = options.profile;
  const roles = options.cto
    ? { dev: "developer", "team-lead": "team-lead" }
    : { dev: "developer" };
  const registration = {
    cwd: root,
    resolveCwd: () => root,
    roles,
    scopeMap: [{ glob: ["**/*"], scope: options.cto ? "backend" : "default", dev_agent: "developer" }],
    ...(profile ? { workflowProfiles: [profile] } : {}),
    getSessionController: (ctx: unknown) => ctx === context ? controller : undefined,
    resolveTrustedToolCallActor: actorResolver,
    observability: false,
  };
  registerTeamWorkflow(pi as never, registration);
  registerWorkflowTools(pi as never, registration);
  registerWorkflowCommands(pi as never, {
    cwd: root,
    resolveCwd: () => root,
    getSessionController: (ctx: unknown) => ctx === context ? controller : undefined,
  });
  recordScenarioEvent({ kind: "workflow_registered", route, workflow: options.profileName, phase: "registration", outcome: "COMPLETED" });
  let disposed = false;
  const shutdown = async (): Promise<unknown[]> => {
    if (disposed) return [];
    disposed = true;
    recordScenarioEvent({ kind: "barrier_wait", route, barrier: "session_shutdown", phase: "shutdown", outcome: "PENDING" });
    return Promise.all((handlers.get("session_shutdown") ?? []).map((handler) => handler(
      { type: "session_shutdown", session_id: context.session_id, session_file: context.sessionFile },
      context,
    )));
  };
  const dispose = (): void => {
    void shutdown();
  };
  return {
    root,
    context,
    controller,
    tools,
    commands,
    handlers,
    messages,
    route,
    profileName: options.profileName,
    emit: async (name, ...args) => {
      if (name === "session_shutdown") return shutdown();
      return Promise.all((handlers.get(name) ?? []).map((handler) => handler(...args)));
    },
    dispose,
    close: async () => {
      try {
        await shutdown();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function ordinaryHarness(
  root = makeRoot("omp-reliable-lifecycle-ordinary"),
  id = "lifecycle-ordinary",
  profile = CHECKPOINT_PROFILE,
  uiTrace?: UiTrace,
): Harness {
  const context = hostContext(root, id, `${id}.jsonl`, "O", uiTrace);
  const trusted: TrustedExecutionContext = {
    session_id: id,
    caller: "host",
    process_id: process.pid,
    worktree: root,
    branch: BRANCH,
    authority: "coordinator",
  };
  const controller = createWorkflowSessionController({ cwd: root, context: trusted });
  return registerHarness(root, context, controller, { cto: false, profile, profileName: profile.name });
}


async function start(harness: Harness): Promise<void> {
  await harness.emit("session_start", { type: "session_start" }, harness.context);
  recordScenarioEvent({ kind: "workflow_started", route: harness.route, workflow: harness.profileName, phase: "session_start", outcome: "STARTED" });
}

function tool(harness: Harness, name: string): RegisteredTool {
  const value = harness.tools.get(name);
  assert.ok(value, `registered ${name} tool is required`);
  return value;
}

async function invoke(harness: Harness, name: string, id: string, input: unknown, ctx = harness.context): Promise<Record<string, unknown>> {
  recordScenarioEvent({ kind: "tool_called", route: harness.route, workflow: harness.profileName, phase: "registered", tool: name });
  try {
    const result = await tool(harness, name).execute(id, input, undefined, undefined, ctx);
    const resolved = details(result.details);
    recordScenarioEvent({
      kind: "tool_completed",
      route: harness.route,
      workflow: harness.profileName,
      phase: "registered",
      tool: name,
      outcome: resolved.ok === true ? "COMPLETED" : "REJECTED",
    });
    return resolved;
  } catch (error) {
    recordScenarioEvent({ kind: "tool_completed", route: harness.route, workflow: harness.profileName, phase: "registered", tool: name, outcome: "FAIL" });
    throw error;
  }
}

async function ordinaryIngress(harness: Harness, task = "complete the reliable lifecycle", classification = CLASSIFICATION): Promise<{ runId: string; handoff: Handoff }> {
  await start(harness);
  const prepared = await invoke(harness, "workflow_prepare", "lifecycle-prepare", {
    mode: "new",
    task,
    classification,
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const runId = details(prepared.state).run_id;
  assert.equal(typeof runId, "string");
  const begun = await invoke(harness, "workflow_begin", "lifecycle-begin", {});
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const handoff = begun.handoff;
  assert.ok(handoff && typeof handoff === "object" && !Array.isArray(handoff));
  const typedHandoff = handoff as Handoff;
  recordScenarioEvent({
    kind: "stage_entered",
    route: harness.route,
    workflow: harness.profileName,
    stage: typedHandoff.stage_cursor,
    phase: "workflow_begin",
    identities: { run: runId as string, stage: typedHandoff.stage_cursor },
    outcome: "STARTED",
  });
  return { runId: runId as string, handoff: typedHandoff };
}



async function terminalWorker(harness: Harness, worker: Worker, _ctx: HostContext): Promise<void> {
  await harness.emit("tool_result", {
    toolName: "task",
    toolCallId: worker.callId,
    input: worker.input,
    details: {
      results: [{
        index: 0,
        id: `${worker.callId}-result`,
        agent: worker.input.agent,
        agentSource: "project",
        task: worker.input.task,
        exitCode: 0,
        output: "terminal",
        stderr: "",
        truncated: false,
        durationMs: 1,
        tokens: 1,
        requests: 1,
      }],
    },
    content: [{ type: "text", text: "terminal" }],
    isError: false,
  }, harness.context);
  await harness.emit("task:subagent:lifecycle", {
    id: worker.lifecycleId,
    agent: worker.input.agent,
    status: "completed",
    sessionFile: worker.file,
    parentToolCallId: worker.callId,
    index: 0,
  });
  recordScenarioEvent({
    kind: "worker_completed",
    route: harness.route,
    workflow: harness.profileName,
    phase: "terminal",
    identities: { worker: worker.input.agent, dispatch: worker.callId },
    outcome: "COMPLETED",
  });
}

async function admitOrdinaryWorker(harness: Harness, handoff: Handoff): Promise<Worker> {
  const roster = handoff.expected_roster[0];
  const marker = handoff.dispatch_markers[0];
  assert.ok(roster && marker);
  const callId = "lifecycle-ordinary-worker";
  const input = { agent: roster.agent, task: marker.marker };
  const blocked = await harness.emit("tool_call", { toolName: "task", toolCallId: callId, input }, harness.context);
  assert.equal(blocked.filter((value) => value && typeof value === "object" && (value as Record<string, unknown>).block === true).length, 0, JSON.stringify(blocked));
  await harness.emit("tool_execution_start", { toolName: "task", toolCallId: callId, args: input }, harness.context);
  const file = join(harness.root, "ordinary-worker.jsonl");
  const id = "ordinary-worker";
  const context: HostContext = {
    cwd: harness.root,
    mode: "print",
    hasUI: false,
    session_id: id,
    sessionFile: file,
    sessionManager: manager(harness.root, id, file, harness.context.sessionFile),
  };
  const lifecycleId = `${callId}-lifecycle`;
  await harness.emit("task:subagent:lifecycle", { id: lifecycleId, agent: input.agent, status: "started", sessionFile: file, parentToolCallId: callId, index: 0 });
  recordScenarioEvent({
    kind: "worker_admitted",
    route: harness.route,
    workflow: harness.profileName,
    phase: "admission",
    identities: { worker: input.agent, dispatch: callId },
    outcome: "ACCEPTED",
  });
  recordScenarioEvent({
    kind: "worker_started",
    route: harness.route,
    workflow: harness.profileName,
    phase: "execution",
    identities: { worker: input.agent, dispatch: callId },
    outcome: "STARTED",
  });
  return { callId, input, context, file, lifecycleId };
}

async function submitAndFinishOrdinary(harness: Harness, worker: Worker): Promise<void> {
  const submitted = await invoke(harness, "workflow_submit_result", "lifecycle-submit", {
    outputs: {
      implementation: {
        files_touched: ["packages/core/src/engine/reliable-stage.ts"],
        ready: true,
        validation_run: true,
        validation_evidence: "lifecycle assigned-worker validation completed",
      },
    },
  }, worker.context);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  await terminalWorker(harness, worker, harness.context);
}

async function advance(harness: Harness, handoff: Handoff, id: string): Promise<Record<string, unknown>> {
  return invoke(harness, "workflow_advance", id, {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: handoff.branch,
    workflow: handoff.workflow,
    profile_hash: handoff.profile_hash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    loop_iteration: handoff.loop_iteration,
    evidence: "registered lifecycle evidence",
  });
}

function commandIntent(prompt: string): string {
  const match = prompt.match(/Command intent token: `([^`]+)`/);
  assert.ok(match, `registered prompt must carry a command intent token: ${prompt}`);
  return match[1]!;
}

async function classifyAndStop(harness: Harness, prompt: string): Promise<void> {
  const augmented = await harness.emit("before_agent_start", { prompt, systemPrompt: [] }, harness.context);
  assert.ok(augmented.some((value) => value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).systemPrompt)), "classification must use the registered prompt ingress");
  await harness.emit("session_stop", { type: "session_stop", session_id: harness.context.session_id, session_file: harness.context.sessionFile }, harness.context);
}


// R19: native route admission is a real registered gate. The resident root
// cannot start a roster worker directly; configured lead -> configured roster
// worker is the only admitted chain.
async function sharedInvoke(harness: SharedHarness, name: string, id: string, input: unknown, ctx = harness.context): Promise<Record<string, unknown>> {
  const result = await sharedRequireTool(harness, name).execute(id, input, undefined, undefined, ctx);
  return sharedDetails(result.details);
}
function traceSharedUi(harness: SharedHarness, uiTrace: UiTrace): void {
  const context = harness.context as unknown as { ui?: { select?: (...args: unknown[]) => Promise<unknown> } };
  const select = context.ui?.select;
  if (typeof select !== "function") throw new Error("shared CTO fixture must expose a registered UI select surface");
  context.ui!.select = async (...args: unknown[]) => {
    uiTrace.selectCalls += 1;
    return select(...args);
  };
}

async function sharedSubmitAndFinish(harness: SharedHarness, worker: SharedWorkerFixture, id: string, outputs: Record<string, unknown>): Promise<void> {
  const submitted = await sharedInvoke(harness, "workflow_submit_result", id, sharedSubmission(outputs), worker.childContext);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  await sharedTerminalWorker(harness, worker);
}

async function sharedAdvance(harness: SharedHarness, handoff: SharedHandoff, id: string): Promise<Record<string, unknown>> {
  return sharedInvoke(harness, "workflow_advance", id, {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: handoff.branch,
    workflow: handoff.workflow,
    profile_hash: handoff.profile_hash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    loop_iteration: handoff.loop_iteration,
    evidence: "registered lifecycle evidence",
  });
}

async function sharedApprove(harness: SharedHarness, handoff: SharedHandoff): Promise<void> {
  const ask = await sharedInvoke(harness, "workflow_checkpoint_ask", "lifecycle-shared-ask", {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: handoff.branch,
    workflow: handoff.workflow,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    checkpoint: "approve_implementation",
    checkpoint_id: "approve_implementation",
    checkpoint_kind: "implementation_approval",
    loop_iteration: handoff.loop_iteration,
  });
  assert.equal(ask.ok, true, JSON.stringify(ask));
  assert.equal(typeof ask.checkpoint_kind, "string", JSON.stringify(ask));
  assert.equal(typeof ask.decision, "string", JSON.stringify(ask));
  const provenance = ask.actor_provenance;
  assert.ok(provenance && typeof provenance === "object");
  const recorded = await sharedInvoke(harness, "workflow_checkpoint", "lifecycle-shared-record", {
    token: handoff.advance_token,
    capability_id: handoff.capability_id,
    run_key: handoff.run_key,
    branch: handoff.branch,
    workflow: handoff.workflow,
    profile_hash: handoff.profile_hash,
    stage_cursor: handoff.stage_cursor,
    cursor_epoch: handoff.cursor_epoch,
    checkpoint: "approve_implementation",
    checkpoint_id: "approve_implementation",
    checkpoint_kind: ask.checkpoint_kind,
    loop_iteration: handoff.loop_iteration,
    authorization: "human",
    actor_provenance: provenance,
    decision: ask.decision,
    rationale: "registered lifecycle acceptance",
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
}

async function sharedTerminalCtoState(harness: SharedHarness, runId: string, reason: string): Promise<Record<string, unknown>> {
  const read = await sharedInvoke(harness, "cto_state", "lifecycle-shared-terminal-read", { operation: "read", run_id: runId });
  assert.equal(read.ok, true, JSON.stringify(read));
  const candidate = structuredClone(read.state) as CtoState;
  candidate.teams = candidate.teams.map((team) => ({ ...team, status: "done" }));
  candidate.integration = { status: "done", note: "registered terminal acceptance" };
  candidate.pause = { kind: "done", reason };
  return sharedInvoke(harness, "cto_state", "lifecycle-shared-terminal-commit", {
    operation: "commit",
    run_id: runId,
    expected_state_revision: String(read.state_revision),
    state: candidate,
  });
}


// R19: the registered native route admits only configured lead -> roster
// dispatch. A root direct roster worker is rejected before any reservation.
scenarioTest("[C:R19] registered CTO root bypass is denied before start and configured lead/roster route passes", async () => {
  const harness = sharedCtoHarness();
  try {
    const { runId } = await sharedCtoIngress(harness);
    const marker = buildCtoSliceMarker(runId, "slice-a");
    const before = readRunControl(harness.root);
    const denied = await sharedEmit(harness, "tool_call", {
      toolName: "task",
      toolCallId: "root-direct-roster",
      input: { agent: "developer", task: `${marker}\nroot bypass` },
    }, harness.context);
    const denial = denied.find((value) => value && typeof value === "object" && (value as Record<string, unknown>).block === true) as Record<string, unknown> | undefined;
    assert.equal(denial?.block, true, JSON.stringify(denied));
    assert.match(String(denial?.reason), /native_authority_route_denied/);
    assert.deepEqual(readRunControl(harness.root).execution_claim?.worker_ids, before.execution_claim?.worker_ids);
    await sharedAdmitCtoLeadAndWorker(harness, runId);
    assert.equal(readRunControl(harness.root).execution_claim?.worker_ids.length, 2);
    assert.equal(readCtoState(runId, harness.root)?.active_wave_id, "wave-1");
  } finally {
    await harness.close();
  }
});

// R20: a completed wave returns a resident run to waiting, while a new wave
// appends immutable history and remains nonterminal.
scenarioTest("[C:R20] registered CTO closes a resident wave and appends a new wave without rewriting history", async () => {
  const harness = sharedCtoHarness({ workflowProfiles: [R20_RESIDENT_PROFILE] });
  writeCtoRegistry(harness.root, R20_RESIDENT_PROFILE.name, ["dev"], "team-lead");
  try {
    const { runId } = await sharedCtoIngress(harness, { profile: R20_RESIDENT_PROFILE.name });
    const worker = await sharedAdmitCtoLeadAndWorker(harness, runId, "r20");
    await sharedSubmitAndFinish(harness, worker, "r20-submit", {
      implementation: {
        files_touched: ["packages/core/src/engine/reliable-stage.ts"],
        ready: true,
        validation_run: true,
        validation_evidence: "r20 assigned-worker validation completed",
      },
    });
    const ready = evaluateNativeStageReadiness(harness.root, runId, "team-a");
    assert.equal(ready.ok, true, JSON.stringify(ready));
    if (!ready.ok) return;
    assert.equal(ready.ready, true, JSON.stringify(ready));
    const advanced = await sharedAdvanceCtoStage(harness, "slice-a", "r20-stage-advance");
    assert.equal(advanced.ok, true, JSON.stringify(advanced));
    if (!advanced.ok) return;
    assert.equal(advanced.progress.status, "complete", JSON.stringify(advanced));

    const read = await sharedInvoke(harness, "cto_state", "lifecycle-wave-read", { operation: "read", run_id: runId });
    assert.equal(read.ok, true, JSON.stringify(read));
    const canonical = readCtoState(runId, harness.root);
    assert.ok(canonical);
    assert.equal(canonical!.native_stage_progress?.["team-a"]?.status, "complete", JSON.stringify(canonical));
    assert.ok(Object.keys(canonical!.stage_receipts ?? {}).length > 0, "wave close requires an engine receipt");
    const receiptsBeforeClose = JSON.stringify(canonical!.stage_receipts);
    assert.equal(canonical!.active_wave_id, "wave-1");
    const candidate = structuredClone(read.state) as CtoState;
    candidate.teams = candidate.teams.map((team) => team.id === "team-a" ? { ...team, status: "done" } : team);
    candidate.integration = { status: "done", note: "one-stage resident profile declares no additional integration checks" };
    finishWave(candidate, { id: "wave-1", status: "done", now: "2026-09-30T01:00:00.000Z" });
    const closeResult = await sharedInvoke(harness, "cto_state", "lifecycle-wave-close", {
      operation: "commit",
      run_id: runId,
      expected_state_revision: String(read.state_revision),
      state: candidate,
    });
    assert.equal(closeResult.ok, true, JSON.stringify(closeResult));
    const closedState = readCtoState(runId, harness.root);
    assert.ok(closedState);
    assert.equal(isCtoResidentWaiting(closedState!), true);
    assert.equal(isCtoRunTerminal(closedState!), false);
    assert.equal(JSON.stringify(closedState!.stage_receipts), receiptsBeforeClose, "wave close must preserve engine receipt bytes");
    const historicalWave = structuredClone(closedState!.wave_history![0]);
    const receiptsBefore = JSON.stringify(closedState!.stage_receipts);

    const command = harness.commands.get("cto");
    assert.ok(command);
    await command.handler(`--run ${runId} second resident task`, harness.context);
    const nextRead = await sharedInvoke(harness, "cto_state", "lifecycle-new-wave-read", { operation: "read", run_id: runId });
    assert.equal(nextRead.ok, true, JSON.stringify(nextRead));
    const next = structuredClone(nextRead.state) as CtoState;
    appendWave(next, {
      id: "wave-2",
      source: "registered-test",
      source_id: "wave-2-source",
      task: "second resident task",
      slice_ids: ["slice-a"],
      now: "2026-09-30T02:00:00.000Z",
    });
    const appended = await sharedInvoke(harness, "cto_state", "lifecycle-new-wave-commit", {
      operation: "commit",
      run_id: runId,
      expected_state_revision: String(nextRead.state_revision),
      state: next,
    });
    assert.equal(appended.ok, true, JSON.stringify(appended));
    const current = readCtoState(runId, harness.root);
    assert.ok(current);
    assert.equal(current!.active_wave_id, "wave-2");
    assert.deepEqual(current!.wave_history![0], historicalWave);
    assert.equal(current!.wave_history!.length, 2);
    assert.equal(JSON.stringify(current!.stage_receipts), receiptsBefore, "new resident wave must preserve prior receipt bytes");
    assert.equal(isCtoRunTerminal(current!), false);
  } finally {
    await harness.close();
    registerWorkflowProfiles([SHIPPED_LIGHTWEIGHT_PROFILE]);
  }
});

// R21: ordinary completion and explicit native END release real claims, then
// permit an independent registered host action and new ingress.
scenarioTest("[O:R21] [C:R21] ordinary completion and native END release claims for real registered host gates", async () => {
  const ordinary = sharedOrdinaryHarness();
  try {
    const { runId, handoff } = await sharedOrdinaryIngress(ordinary, { task: "ordinary terminal lifecycle" });
    const worker = await sharedAdmitOrdinaryWorker(ordinary, handoff, "r21-first");
    await sharedSubmitAndFinish(ordinary, worker, "r21-first-submit", {
      implementation: {
        files_touched: ["packages/core/src/engine/reliable-stage.ts"],
        ready: true,
        validation_run: true,
        validation_evidence: "r21-first-submit assigned-worker validation completed",
      },
    });
    const firstAdvance = await sharedAdvance(ordinary, handoff, "r21-first-advance-denied");
    assert.equal(firstAdvance.ok, false, JSON.stringify(firstAdvance));
    await sharedApprove(ordinary, handoff);
    const first = await sharedAdvance(ordinary, handoff, "r21-first-advance");
    assert.equal(first.ok, true, JSON.stringify(first));
    const nextHandoff = first.handoff as SharedHandoff;
    const nextWorker = await sharedAdmitOrdinaryWorker(ordinary, nextHandoff, "r21-next");
    await sharedSubmitAndFinish(ordinary, nextWorker, "r21-next-submit", {
      next: {
        files_touched: ["packages/core/src/engine/reliable-stage.ts"],
        ready: true,
        validation_run: true,
        validation_evidence: "r21-next-submit assigned-worker validation completed",
      },
    });
    const terminal = await sharedAdvance(ordinary, nextHandoff, "r21-next-advance");
    assert.equal(terminal.ok, true, JSON.stringify(terminal));
    assert.equal(readRunControl(ordinary.root).execution_claim, null);
    const hostGate = await sharedEmit(ordinary, "tool_call", { toolName: "write", toolCallId: "ordinary-post-terminal-write", input: { path: "src/after-terminal.ts", content: "host action" } }, ordinary.context);
    assert.equal(hostGate.filter((value) => value && typeof value === "object" && (value as Record<string, unknown>).block === true).length, 0, JSON.stringify(hostGate));
    const next = await sharedInvoke(ordinary, "workflow_prepare", "ordinary-independent-new", { mode: "new", task: "independent ordinary task", classification: SHARED_CLASSIFICATION });
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.notEqual((next.state as Record<string, unknown>).run_id, runId);
  } finally {
    await ordinary.close();
  }

  const native = sharedCtoHarness();
  try {
    const { runId } = await sharedCtoIngress(native);
    const worker = await sharedAdmitCtoLeadAndWorker(native, runId);
    await sharedSubmitAndFinish(native, worker, "r21-native-submit", {
      implementation: {
        files_touched: ["packages/core/src/engine/reliable-stage.ts"],
        ready: true,
        validation_run: true,
        validation_evidence: "r21-native-submit assigned-worker validation completed",
      },
    });
    await sharedTerminalWorker(native, worker.lead);
    const terminal = await sharedTerminalCtoState(native, runId, "explicit registered END");
    assert.equal(terminal.ok, true, JSON.stringify(terminal));
    assert.equal(readRunControl(native.root).execution_claim, null);
    const hostGate = await sharedEmit(native, "tool_call", { toolName: "write", toolCallId: "native-post-terminal-write", input: { path: "src/after-terminal.ts", content: "host action" } }, native.context);
    assert.equal(hostGate.filter((value) => value && typeof value === "object" && (value as Record<string, unknown>).block === true).length, 0, JSON.stringify(hostGate));
    const command = native.commands.get("cto");
    assert.ok(command);
    await command.handler("independent native task", native.context);
    const nextRun = readRunControl(native.root).execution_claim?.run_id;
    assert.ok(nextRun);
    assert.notEqual(nextRun, runId);
  } finally {
    await native.close();
  }
});

// R22: an unknown provider acknowledgement leaves the claim pending; only
// terminal registered worker events permit END and release.
scenarioTest("[C:R22] native END remains pending through unknown worker status and releases only after stop acknowledgement", async () => {
  const harness = sharedCtoHarness();
  try {
    const { runId } = await sharedCtoIngress(harness);
    const worker = await sharedAdmitCtoLeadAndWorker(harness, runId);
    const pending = await sharedTerminalCtoState(harness, runId, "requested END with active worker");
    assert.equal(pending.ok, false, JSON.stringify(pending));
    assert.equal(readRunControl(harness.root).execution_claim?.worker_ids.length, 2);
    await sharedEmit(harness, "tool_result", {
      toolName: "task",
      toolCallId: worker.toolCallId,
      input: worker.input,
      details: {
        results: [{ index: 0, id: `${worker.toolCallId}-unknown-result`, agent: worker.input.agent, agentSource: "project", task: worker.input.task, exitCode: 0, output: "unknown", stderr: "", truncated: false, durationMs: 1, tokens: 1, requests: 1 }],
        async: { state: "unknown", jobId: "unknown-job", type: "task" },
      },
      content: [{ type: "text", text: "provider returned an unrecognized async state" }],
      isError: false,
    }, harness.context);
    assert.equal(readRunControl(harness.root).execution_claim?.worker_ids.length, 2);
    await sharedTerminalWorker(harness, worker);
    await sharedTerminalWorker(harness, worker.lead);
    const acknowledged = await sharedTerminalCtoState(harness, runId, "END after terminal acknowledgement");
    assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged));
    assert.equal(readRunControl(harness.root).execution_claim, null);
  } finally {
    await harness.close();
  }
});

// R23: the registered command's private intent survives a turn stop, but is
// single-use, session-bound, and superseded by a newer explicit command.
scenarioTest("[O:R23] registered session_stop preserves Proceed intent while replay, foreign, and superseded requests are rejected", async () => {
  const harness = ordinaryHarness();
  try {
    await start(harness);
    const command = harness.commands.get("do-work");
    assert.ok(command);
    await command.handler("--new classify this ordinary request", harness.context);
    const firstPrompt = harness.messages.at(-1);
    assert.ok(firstPrompt);
    const firstToken = commandIntent(firstPrompt);
    await classifyAndStop(harness, firstPrompt);

    const foreign = hostContext(harness.root, "foreign-intent-session", "foreign-intent.jsonl");
    const foreignPrepare = await invoke(harness, "workflow_prepare", "foreign-intent-prepare", {
      mode: "new",
      task: "foreign attempt",
      command_intent_id: firstToken,
      classification: CLASSIFICATION,
    }, foreign);
    assert.equal(foreignPrepare.ok, false, JSON.stringify(foreignPrepare));
    assert.equal(readRunControl(harness.root).execution_claim, null);

    await command.handler("--new superseding ordinary request", harness.context);
    const secondPrompt = harness.messages.at(-1);
    assert.ok(secondPrompt);
    const secondToken = commandIntent(secondPrompt);
    const superseded = await invoke(harness, "workflow_prepare", "superseded-intent-prepare", {
      mode: "new",
      task: "classify this ordinary request",
      command_intent_id: firstToken,
      classification: CLASSIFICATION,
    });
    assert.equal(superseded.ok, false, JSON.stringify(superseded));
    assert.equal(readRunControl(harness.root).execution_claim, null, "supersession must not create a second run");

    await classifyAndStop(harness, secondPrompt);
    const proceeded = await invoke(harness, "workflow_prepare", "proceed-intent-prepare", {
      mode: "new",
      task: "superseding ordinary request",
      command_intent_id: secondToken,
      classification: CLASSIFICATION,
    });
    assert.equal(proceeded.ok, true, JSON.stringify(proceeded));
    const runId = details(proceeded.state).run_id;
    assert.equal(typeof runId, "string");
    const replay = await invoke(harness, "workflow_prepare", "replayed-intent-prepare", {
      mode: "new",
      task: "superseding ordinary request",
      command_intent_id: secondToken,
      classification: CLASSIFICATION,
    });
    assert.equal(replay.ok, false, JSON.stringify(replay));
    assert.equal(readRunState(harness.root, runId as string)?.run_id, runId);
    assert.equal(readRunControl(harness.root).execution_claim?.run_id, runId);
  } finally {
    await harness.close();
  }
});

async function nativeCheckpointRestart(uiTrace: UiTrace): Promise<void> {
  const first = sharedCtoHarness({
    sessionId: "native-checkpoint-first",
    workflowProfiles: [NATIVE_CHECKPOINT_PROFILE],
  });
  let runId: string;
  try {
    writeCtoRegistry(first.root, NATIVE_CHECKPOINT_PROFILE.name, ["dev"], "team-lead");
    const ingress = await sharedCtoIngress(first, { profile: NATIVE_CHECKPOINT_PROFILE.name });
    runId = ingress.runId;
    const worker = await sharedAdmitCtoLeadAndWorker(first, runId);
    await sharedSubmitAndFinish(first, worker, "native-checkpoint-submit", {
      implementation: {
        files_touched: ["packages/core/src/engine/reliable-stage.ts"],
        ready: true,
        validation_run: true,
        validation_evidence: "native checkpoint assigned-worker validation completed",
      },
    });
    await sharedTerminalWorker(first, worker.lead);

    const readyBeforeRestart = evaluateNativeStageReadiness(first.root, runId, "team-a");
    assert.equal(readyBeforeRestart.ok, true, JSON.stringify(readyBeforeRestart));
    if (!readyBeforeRestart.ok) return;
    assert.equal(readyBeforeRestart.ready, false, JSON.stringify(readyBeforeRestart));
    const beforeRestart = readCtoState(runId, first.root);
    assert.ok(beforeRestart);
    const beforeProgress = beforeRestart!.native_stage_progress?.["team-a"];
    assert.ok(beforeProgress);
    assert.equal(beforeProgress!.stage_id, "native_checkpoint");
    const receiptSnapshot = JSON.stringify(beforeRestart!.stage_receipts ?? {});
    const receiptIds = Object.keys(beforeRestart!.stage_receipts ?? {}).sort();
    const assignmentIds = Object.keys(beforeProgress!.assignments ?? {}).sort();
    assert.ok(receiptIds.length > 0, "accepted native output must persist an engine receipt");
    assert.ok(assignmentIds.length > 0, "native checkpoint must persist an assigned worker");
    await first.emit("session_shutdown", {
      type: "session_shutdown",
      session_id: first.context.session_id,
      session_file: first.context.sessionFile,
    }, first.context);

    const second = sharedCtoHarness({
      root: first.root,
      sessionId: "native-checkpoint-second",
      workflowProfiles: [NATIVE_CHECKPOINT_PROFILE],
    });
    try {
      writeCtoRegistry(second.root, NATIVE_CHECKPOINT_PROFILE.name, ["dev"], "team-lead");
      traceSharedUi(second, uiTrace);
      await second.emit("session_start", { type: "session_start" }, second.context);
      const command = second.commands.get("cto");
      assert.ok(command);
      await command.handler(`--run ${runId}`, second.context);
      assert.equal(readRunControl(second.root).execution_claim?.run_id, runId, "registered exact resume must reacquire the current CTO claim");
      const persisted = readCtoState(runId, second.root);
      assert.ok(persisted);
      assert.equal(persisted!.native_stage_progress?.["team-a"]?.approval, undefined);
      assert.equal(JSON.stringify(persisted!.stage_receipts ?? {}), receiptSnapshot, "restart must not rewrite accepted native receipts");
      assert.deepEqual(Object.keys(persisted!.native_stage_progress?.["team-a"]?.assignments ?? {}).sort(), assignmentIds, "restart must not admit a second native worker");
      const pendingAfterRestart = evaluateNativeStageReadiness(second.root, runId, "team-a");
      assert.equal(pendingAfterRestart.ok, true, JSON.stringify(pendingAfterRestart));
      if (!pendingAfterRestart.ok) return;
      assert.equal(pendingAfterRestart.ready, false, JSON.stringify(pendingAfterRestart));

      const ask = await sharedAskCtoCheckpoint(second, "slice-a", "native-checkpoint-ask");
      assert.equal(ask.ok, true, JSON.stringify(ask));
      assert.equal(ask.transition, "cto_checkpoint_answer", JSON.stringify(ask));
      assert.notEqual(ask.already_recorded, true, "restart must require a new native UI decision");
      assert.equal(uiTrace.selectCalls, 1, "restart checkpoint must open exactly one UI decision");
      const approval = ask.approval;
      assert.ok(approval);
      const uiCallsBeforeReplay = uiTrace.selectCalls;
      const replayAsk = await sharedAskCtoCheckpoint(second, "slice-a", "native-checkpoint-ask-replay");
      assert.equal(replayAsk.ok, true, JSON.stringify(replayAsk));
      assert.equal(replayAsk.transition, "cto_checkpoint_answer", JSON.stringify(replayAsk));
      assert.equal(replayAsk.already_recorded, true, JSON.stringify(replayAsk));
      assert.deepEqual(replayAsk.approval, approval, "replay must preserve the current native approval proof");
      assert.equal(uiTrace.selectCalls, uiCallsBeforeReplay, "replay must not reopen the UI");

      const resumed = evaluateNativeStageReadiness(second.root, runId, "team-a");
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      if (!resumed.ok) return;
      assert.equal(resumed.ready, true, JSON.stringify(resumed));
      const advanced = await sharedAdvanceCtoStage(second, "slice-a", "native-stage-advance");
      assert.equal(advanced.ok, true, JSON.stringify(advanced));
      assert.equal((advanced.progress as Record<string, unknown>).stage_id, "native_after_checkpoint");
      const afterAdvance = JSON.stringify(readCtoState(runId, second.root)?.native_stage_progress?.["team-a"]);
      await sharedInvoke(second, "cto_stage_advance", "native-stage-advance", { slice_id: "slice-a" });
      assert.equal(JSON.stringify(readCtoState(runId, second.root)?.native_stage_progress?.["team-a"]), afterAdvance, "replayed native decision must not create a second transition");
      assert.equal(readCtoState(runId, second.root)?.native_stage_progress?.["team-a"]?.stage_id, "native_after_checkpoint");
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
}

// R24: ordinary checkpoint proof and native stage approval both survive a
// host restart; the current decision is consumed once and does not produce a
// second transition on replay.
scenarioTest("[O:R24] [C:R24] restart reuses the current checkpoint decision exactly once", async () => {
  const ordinaryRoot = makeRoot("omp-reliable-lifecycle-r24-ordinary");
  const ordinaryUiTrace: UiTrace = { selectCalls: 0 };
  const first = ordinaryHarness(ordinaryRoot, "r24-ordinary-first", CHECKPOINT_PROFILE, ordinaryUiTrace);
  try {
    const { runId, handoff } = await ordinaryIngress(first, "restart at ordinary checkpoint");
    const worker = await admitOrdinaryWorker(first, handoff);
    await submitAndFinishOrdinary(first, worker);
    const pending = await advance(first, handoff, "r24-ordinary-pending-before-answer");
    assert.equal(pending.ok, false, JSON.stringify(pending));
    await first.emit("session_shutdown", { type: "session_shutdown", session_id: first.context.session_id, session_file: first.context.sessionFile }, first.context);
    first.dispose();

    const second = ordinaryHarness(ordinaryRoot, "r24-ordinary-second", CHECKPOINT_PROFILE, ordinaryUiTrace);
    try {
      await start(second);
      const resumed = await invoke(second, "workflow_prepare", "r24-ordinary-resume", { mode: "resume", run_id: runId });
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      const resumedBegin = await invoke(second, "workflow_begin", "r24-ordinary-begin", {});
      assert.equal(resumedBegin.ok, true, JSON.stringify(resumedBegin));
      const resumedHandoff = resumedBegin.handoff as Handoff;
      const askInput = {
        token: resumedHandoff.advance_token,
        capability_id: resumedHandoff.capability_id,
        run_key: resumedHandoff.run_key,
        branch: BRANCH,
        workflow: CHECKPOINT_PROFILE.name,
        stage_cursor: resumedHandoff.stage_cursor,
        cursor_epoch: resumedHandoff.cursor_epoch,
        checkpoint: "approve_implementation",
        checkpoint_id: "approve_implementation",
        checkpoint_kind: "implementation_approval",
        loop_iteration: resumedHandoff.loop_iteration,
      };
      const ask = await invoke(second, "workflow_checkpoint_ask", "r24-ordinary-ask-after-restart", askInput);
      assert.equal(ask.ok, true, JSON.stringify(ask));
      assert.equal(ask.transition, "checkpoint_answer", JSON.stringify(ask));
      assert.notEqual(ask.already_recorded, true, "restart must require a new UI decision when approval was pending");
      assert.equal(ordinaryUiTrace.selectCalls, 1, "restart checkpoint must open exactly one UI decision");
      const provenance = ask.actor_provenance;
      assert.ok(provenance);
      const uiCallsBeforeReplay = ordinaryUiTrace.selectCalls;
      const replayAsk = await invoke(second, "workflow_checkpoint_ask", "r24-ordinary-ask-replay", askInput);
      assert.equal(replayAsk.ok, true, JSON.stringify(replayAsk));
      assert.equal(replayAsk.transition, "checkpoint_answer", JSON.stringify(replayAsk));
      assert.equal(replayAsk.decision, ask.decision, "replay must preserve the current decision");
      assert.deepEqual(replayAsk.actor_provenance, provenance, "replay must preserve the current proof");
      assert.equal(ordinaryUiTrace.selectCalls, uiCallsBeforeReplay, "replay must not reopen the UI");
      const recorded = await invoke(second, "workflow_checkpoint", "r24-ordinary-record", {
        ...askInput,
        profile_hash: resumedHandoff.profile_hash ?? "",
        authorization: "human",
        actor_provenance: provenance,
        decision: "proceed",
        rationale: "restart checkpoint acceptance",
      });
      assert.equal(recorded.ok, true, JSON.stringify(recorded));
      const advanced = await advance(second, resumedHandoff, "r24-ordinary-advance");
      assert.equal(advanced.ok, true, JSON.stringify(advanced));
      recordScenarioEvent({
        kind: "stage_exited",
        route: "O",
        workflow: second.profileName,
        stage: resumedHandoff.stage_cursor,
        phase: "workflow_advance",
        identities: { run: runId, stage: resumedHandoff.stage_cursor },
        outcome: "COMPLETED",
      });
      const afterAdvance = readRunState(ordinaryRoot, runId);
      assert.ok(afterAdvance);
      const dispatchCountAfterAdvance = afterAdvance!.dispatch_capability?.dispatches.length ?? 0;
      const after = JSON.stringify(afterAdvance);
      await advance(second, resumedHandoff, "r24-ordinary-advance-replay");
      const replayed = readRunState(ordinaryRoot, runId);
      assert.equal(JSON.stringify(replayed), after, "replayed current decision must not create a second transition");
      assert.equal(replayed?.dispatch_capability?.dispatches.length ?? 0, dispatchCountAfterAdvance, "replay must not dispatch the new stage twice");
    } finally {
      await second.close();
    }
  } finally {
    rmSync(ordinaryRoot, { recursive: true, force: true });
  }

  await nativeCheckpointRestart({ selectCalls: 0 });
});
